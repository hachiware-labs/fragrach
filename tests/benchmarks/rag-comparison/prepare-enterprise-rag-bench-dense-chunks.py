#!/usr/bin/env python
"""Split every EnterpriseRAG-Bench document into restartable Dense chunk shards."""

from __future__ import annotations

import argparse
import hashlib
import heapq
import json
from pathlib import Path

import pyarrow.parquet as pq
def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--documents", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--chunk-tokens", type=int, default=1024)
    parser.add_argument("--overlap-tokens", type=int, default=128)
    parser.add_argument("--tokenizer", choices=("ruri", "o200k"), default="ruri")
    parser.add_argument("--shard-size", type=int, default=5_000)
    parser.add_argument("--limit-documents", type=int)
    parser.add_argument("--questions", type=Path)
    parser.add_argument("--category", action="append", dest="categories")
    parser.add_argument("--sample-documents", type=int)
    parser.add_argument("--sample-seed", default="enterprise-rag-bench-chunk-pilot-v1")
    return parser.parse_args()


def read_jsonl(file: Path) -> list[dict]:
    return [json.loads(line) for line in file.read_text(encoding="utf-8").splitlines() if line]


def main() -> None:
    options = parse_args()
    if options.overlap_tokens >= options.chunk_tokens:
        raise ValueError("--overlap-tokens must be smaller than --chunk-tokens")
    if options.limit_documents is not None and options.sample_documents is not None:
        raise ValueError("--limit-documents and --sample-documents are mutually exclusive")
    if options.sample_documents is not None and options.questions is None:
        raise ValueError("--sample-documents requires --questions")
    if options.categories and options.questions is None:
        raise ValueError("--category requires --questions")
    if options.output.exists():
        raise FileExistsError(f"output already exists: {options.output}")
    options.output.mkdir(parents=True)
    if options.tokenizer == "ruri":
        from transformers import AutoTokenizer

        tokenizer = AutoTokenizer.from_pretrained("cl-nagoya/ruri-v3-310m")
        encode = lambda text: tokenizer.encode(text, add_special_tokens=False)
        decode = lambda values: tokenizer.decode(values, skip_special_tokens=True)
        tokenizer_contract = "huggingface:cl-nagoya/ruri-v3-310m"
    else:
        import tiktoken

        tokenizer = tiktoken.get_encoding("o200k_base")
        encode = tokenizer.encode_ordinary
        decode = tokenizer.decode
        tokenizer_contract = "tiktoken:o200k_base"
    parquet = pq.ParquetFile(options.documents)
    selected_document_ids: set[str] | None = None
    required_document_ids: set[str] = set()
    selection_contract: dict = {"mode": "all_documents"}
    if options.sample_documents is not None:
        questions = [
            row for row in read_jsonl(options.questions)
            if row["split"] in {"development", "diagnostic"}
            and (not options.categories or row["category"] in options.categories)
        ]
        required_document_ids = {
            doc_id
            for question in questions
            for doc_id in question["gold_evidence"]["sources"]
        }
        found_required: set[str] = set()

        def distractor_candidates():
            for batch in parquet.iter_batches(batch_size=8192, columns=["doc_id"]):
                for doc_id in batch.column(0).to_pylist():
                    if doc_id in required_document_ids:
                        found_required.add(doc_id)
                        continue
                    score = hashlib.sha256(f"{options.sample_seed}\0{doc_id}".encode("utf-8")).digest()
                    yield score, doc_id

        distractors = {
            doc_id
            for _, doc_id in heapq.nsmallest(options.sample_documents, distractor_candidates())
        }
        missing = required_document_ids - found_required
        if missing:
            raise KeyError(f"required Gold documents are missing from the corpus: {sorted(missing)[:10]}")
        selected_document_ids = required_document_ids | distractors
        selection_contract = {
            "mode": "gold_inclusive_deterministic_pilot",
            "splits": ["development", "diagnostic"],
            "categories": options.categories or "all",
            "questions": len(questions),
            "required_gold_documents": len(required_document_ids),
            "deterministic_distractors": len(distractors),
            "sample_seed": options.sample_seed,
            "interpretation": (
                "Chunk/input adequacy pilot only. Gold inclusion makes absolute retrieval scores unsuitable "
                "as an estimate of full-corpus retrieval quality."
            ),
        }
    rows: list[dict] = []
    shards = []
    digest = hashlib.sha256()
    shard_index = 0
    document_count = 0
    unit_count = 0
    step = options.chunk_tokens - options.overlap_tokens

    def flush() -> None:
        nonlocal rows, shard_index
        if not rows:
            return
        name = f"shard-{shard_index:05d}.jsonl"
        file = options.output / name
        file.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")
        shards.append({"file": name, "start_row": rows[0]["row_id"], "rows": len(rows)})
        print(json.dumps({
            "prepared_shard": shard_index,
            "documents": document_count,
            "units": unit_count,
        }), flush=True)
        rows = []
        shard_index += 1

    stop = False
    for batch in parquet.iter_batches(batch_size=1024, columns=["doc_id", "title", "content"]):
        for source in batch.to_pylist():
            if options.limit_documents is not None and document_count >= options.limit_documents:
                stop = True
                break
            doc_id = source["doc_id"]
            if selected_document_ids is not None and doc_id not in selected_document_ids:
                continue
            title = source.get("title") or ""
            content = source.get("content") or ""
            body_tokens = encode(content)
            starts = list(range(0, max(len(body_tokens), 1), step))
            for chunk_index, start in enumerate(starts):
                end = min(start + options.chunk_tokens, len(body_tokens))
                body = decode(body_tokens[start:end]) if body_tokens else ""
                text = f"{title}\n\n{body}".strip()
                unit_id = f"{doc_id}:chunk:{chunk_index:04d}"
                digest.update(unit_id.encode("utf-8"))
                digest.update(b"\0")
                digest.update(text.encode("utf-8"))
                rows.append({
                    "row_id": unit_count,
                    "unit_id": unit_id,
                    "doc_id": doc_id,
                    "chunk_index": chunk_index,
                    "start_token": start,
                    "end_token": end,
                    "text": text,
                })
                unit_count += 1
                if len(rows) == options.shard_size:
                    flush()
                if end >= len(body_tokens):
                    break
            document_count += 1
        if stop:
            break
    flush()
    manifest = {
        "schema_version": "1.0",
        "source": str(options.documents),
        "documents": document_count,
        "units": unit_count,
        "shard_size": options.shard_size,
        "chunk_tokens": options.chunk_tokens,
        "overlap_tokens": options.overlap_tokens,
        "tokenizer": tokenizer_contract,
        "text_contract": "document title + two newlines + one content token window; title is repeated for every chunk",
        "selection": selection_contract,
        "selected_document_fingerprint": hashlib.sha256(
            "\n".join(sorted(selected_document_ids or [])).encode("utf-8")
        ).hexdigest() if selected_document_ids is not None else None,
        "corpus_fingerprint": digest.hexdigest(),
        "shards": shards,
    }
    (options.output / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
