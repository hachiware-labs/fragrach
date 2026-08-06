#!/usr/bin/env python
"""Project EnterpriseRAG-Bench documents into restartable Ruri input shards."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import pyarrow.parquet as pq


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--documents", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--shard-size", type=int, default=10_000)
    parser.add_argument("--text-characters", type=int, default=700)
    return parser.parse_args()


def main() -> None:
    options = parse_args()
    if options.output.exists():
        raise FileExistsError(f"output already exists: {options.output}")
    options.output.mkdir(parents=True)
    parquet = pq.ParquetFile(options.documents)
    rows = []
    shard_index = 0
    total = 0
    digest = hashlib.sha256()
    shards = []

    def flush() -> None:
        nonlocal rows, shard_index
        if not rows:
            return
        name = f"shard-{shard_index:05d}.jsonl"
        file = options.output / name
        file.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")
        shards.append({"file": name, "start_row": rows[0]["row_id"], "rows": len(rows)})
        print(json.dumps({"prepared_shard": shard_index, "documents": total}), flush=True)
        rows = []
        shard_index += 1

    for batch in parquet.iter_batches(batch_size=2048, columns=["doc_id", "title", "content"]):
        for source in batch.to_pylist():
            doc_id = source["doc_id"]
            title = source.get("title") or ""
            content = source.get("content") or ""
            text = f"{title}\n\n{content}"[:options.text_characters]
            digest.update(doc_id.encode("utf-8"))
            digest.update(b"\0")
            digest.update(text.encode("utf-8"))
            rows.append({"row_id": total, "doc_id": doc_id, "text": text})
            total += 1
            if len(rows) == options.shard_size:
                flush()
    flush()
    manifest = {
        "schema_version": "1.0",
        "source": str(options.documents),
        "documents": total,
        "shard_size": options.shard_size,
        "text_characters": options.text_characters,
        "text_contract": "title + two newlines + leading content, capped by characters before the Ruri passage prefix",
        "corpus_fingerprint": digest.hexdigest(),
        "shards": shards,
    }
    (options.output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
