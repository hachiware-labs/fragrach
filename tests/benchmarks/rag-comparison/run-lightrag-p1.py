#!/usr/bin/env python
"""Build and evaluate LightRAG on the shared P1 update-document corpus."""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import importlib.util
import json
import logging
import re
import sys
import time
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
from lightrag import LightRAG, QueryParam
from lightrag.utils import EmbeddingFunc


SCRIPT_ROOT = Path(__file__).resolve().parent
BRIDGE_SPEC = importlib.util.spec_from_file_location(
    "fragrach_codex_bridge", SCRIPT_ROOT / "codex-bridge.py"
)
if BRIDGE_SPEC is None or BRIDGE_SPEC.loader is None:
    raise RuntimeError("failed to load codex-bridge.py")
BRIDGE_MODULE = importlib.util.module_from_spec(BRIDGE_SPEC)
sys.modules[BRIDGE_SPEC.name] = BRIDGE_MODULE
BRIDGE_SPEC.loader.exec_module(BRIDGE_MODULE)
CodexBridge = BRIDGE_MODULE.CodexBridge

DEFAULT_CORPUS = Path("tests/corpora/fragrach-enterprise-ja-diverse")
DEFAULT_SOURCE_PREFIX = "sources/manufacturing/product-design/governance"
LIGHTRAG_VERSION = "1.5.5"
LIGHTRAG_COMMIT = "22ea2d0cbfa2b7002aa118bd0bf1780a69d489bc"


@dataclass
class SourceDocument:
    path: Path
    relative_path: str
    body: str
    metadata: dict[str, Any]
    sections: list[dict[str, str]]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--corpus", type=Path, default=DEFAULT_CORPUS)
    parser.add_argument("--source-prefix", default=DEFAULT_SOURCE_PREFIX)
    parser.add_argument(
        "--canonical-chunks",
        type=Path,
        help="optional canonical chunk JSONL; each row is inserted as an independent LightRAG document",
    )
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--working-dir", type=Path, required=True)
    parser.add_argument("--llm-model", default="gpt-5.6-luna")
    parser.add_argument("--reasoning-effort", default="low")
    parser.add_argument(
        "--summary-language",
        default="Japanese",
        help="LightRAG entity, relation, and summary language",
    )
    parser.add_argument("--codex-command", default="codex")
    parser.add_argument(
        "--codex-bridge",
        type=Path,
        default=Path("target/debug/examples/codex_structured_chat_bridge.exe"),
    )
    parser.add_argument("--llm-timeout-seconds", type=int, default=900)
    parser.add_argument(
        "--embedding-model", default="hf.co/Targoyle/ruri-v3-310m-GGUF:Q8_0"
    )
    parser.add_argument("--ollama-url", default="http://127.0.0.1:11434/v1")
    parser.add_argument("--top-k", type=int, default=20)
    parser.add_argument(
        "--modes",
        default="naive,local,global,hybrid,mix",
        help="comma-separated LightRAG retrieval modes",
    )
    parser.add_argument("--search-only", action="store_true")
    parser.add_argument("--log-level", default="INFO")
    return parser.parse_args()


def parse_scalar(raw: str) -> Any:
    value = raw.strip()
    if value.startswith('"') and value.endswith('"'):
        return value[1:-1]
    if value in {"true", "false"}:
        return value == "true"
    if value.startswith("{") or value.startswith("["):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return value
    if re.fullmatch(r"-?\d+(?:\.\d+)?", value):
        return float(value) if "." in value else int(value)
    return value


def parse_document(path: Path, corpus: Path) -> SourceDocument:
    text = path.read_text(encoding="utf-8")
    metadata: dict[str, Any] = {}
    body = text
    if text.startswith("---"):
        parts = text.split("---", 2)
        if len(parts) == 3:
            for line in parts[1].splitlines():
                if ":" in line:
                    key, value = line.split(":", 1)
                    metadata[key.strip()] = parse_scalar(value)
            body = parts[2].lstrip()
    sections: list[dict[str, str]] = []
    heading = "本文"
    buffer: list[str] = []
    for line in body.splitlines():
        if line.startswith("## "):
            if buffer and "\n".join(buffer).strip():
                sections.append({"section": heading, "text": "\n".join(buffer).strip()})
            heading = line[3:].strip()
            buffer = []
        else:
            buffer.append(line)
    if buffer and "\n".join(buffer).strip():
        sections.append({"section": heading, "text": "\n".join(buffer).strip()})
    return SourceDocument(
        path=path,
        relative_path=path.relative_to(corpus).as_posix(),
        body=body,
        metadata=metadata,
        sections=sections,
    )


def load_documents(corpus: Path, source_prefix: str) -> list[SourceDocument]:
    return [
        parse_document(path, corpus)
        for path in sorted((corpus / Path(source_prefix)).rglob("*.md"))
    ]


def load_questions(corpus: Path, source_prefix: str) -> list[dict[str, Any]]:
    parts = Path(source_prefix).parts
    industry, department, intent = parts[1], parts[2], parts[3]
    questions = []
    for line in (corpus / "evaluation/questions.jsonl").read_text(encoding="utf-8").splitlines():
        if not line:
            continue
        question = json.loads(line)
        if (
            question.get("industry") == industry
            and question.get("department") == department
            and question.get("intent_id") == intent
        ):
            questions.append(question)
    return questions


def source_payload(document: SourceDocument) -> str:
    return "\n".join(
        [
            f"source_id: {document.relative_path}",
            "metadata:",
            json.dumps(document.metadata, ensure_ascii=False, sort_keys=True),
            "document:",
            document.body,
        ]
    )


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def ollama_embeddings(url: str, model: str, texts: list[str]) -> np.ndarray:
    request = urllib.request.Request(
        f"{url.rstrip('/')}/embeddings",
        data=json.dumps({"model": model, "input": texts}).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=300) as response:
        payload = json.loads(response.read().decode("utf-8"))
    ordered = sorted(payload["data"], key=lambda item: item["index"])
    return np.asarray([item["embedding"] for item in ordered], dtype=np.float32)


def evidence_for_chunk(
    chunk: dict[str, Any],
    documents_by_path: dict[str, SourceDocument],
    canonical_by_id: dict[str, dict[str, Any]] | None = None,
) -> list[dict[str, str]]:
    content = str(chunk.get("content") or "")
    canonical_match = re.search(r"(?m)^canonical_chunk_id:\s*(\S+)\s*$", content)
    if canonical_match and canonical_by_id:
        canonical = canonical_by_id.get(canonical_match.group(1))
        if canonical:
            return canonical.get("evidence") or []
    source_match = re.search(r"(?m)^source_id:\s*(\S+)\s*$", content)
    path = (
        source_match.group(1)
        if source_match
        else str(chunk.get("file_path") or "").replace("\\", "/")
    )
    document = documents_by_path.get(path)
    if document is None:
        return [{"source": path, "section": "本文", "text": content}]
    matching = [
        section
        for section in document.sections
        if section["text"] in content or content in section["text"]
    ]
    if not matching:
        matching = document.sections
    return [
        {
            "source": document.relative_path,
            "section": section["section"],
            "text": section["text"],
        }
        for section in matching
    ]


async def run(options: argparse.Namespace) -> None:
    logging.basicConfig(
        level=getattr(logging, options.log_level.upper()),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    corpus = options.corpus.resolve()
    output = options.output.resolve()
    working_dir = options.working_dir.resolve()
    if output.exists():
        raise FileExistsError(f"output directory already exists: {output}")
    if not options.search_only and working_dir.exists() and any(working_dir.iterdir()):
        raise FileExistsError(
            f"working directory is not empty; use a new path for a cold build: {working_dir}"
        )
    output.mkdir(parents=True)
    working_dir.mkdir(parents=True, exist_ok=True)
    documents = load_documents(corpus, options.source_prefix)
    canonical_chunks: list[dict[str, Any]] = []
    canonical_by_id: dict[str, dict[str, Any]] = {}
    if options.canonical_chunks:
        canonical_chunks = [
            json.loads(line)
            for line in options.canonical_chunks.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        prefix = options.source_prefix.replace("\\", "/").rstrip("/") + "/"
        canonical_chunks = [
            item for item in canonical_chunks if str(item.get("source") or "").startswith(prefix)
        ]
        canonical_by_id = {str(item["id"]): item for item in canonical_chunks}
        if not canonical_chunks:
            raise RuntimeError(f"no canonical chunks for {options.source_prefix}")
    documents_by_path = {document.relative_path: document for document in documents}
    questions = load_questions(corpus, options.source_prefix)
    bridge = CodexBridge(
        options.codex_bridge.resolve(),
        Path.cwd(),
        model=options.llm_model,
        reasoning_effort=options.reasoning_effort,
        codex_command=options.codex_command,
        timeout_seconds=options.llm_timeout_seconds,
    )
    embedding_calls = 0
    embedding_texts = 0

    async def llm_model_func(
        prompt: str,
        system_prompt: str | None = None,
        history_messages: list[dict[str, str]] | None = None,
        **_: Any,
    ) -> str:
        return await bridge.complete_text(prompt, system_prompt, history_messages)

    async def embedding_function(texts: list[str], **_: Any) -> np.ndarray:
        nonlocal embedding_calls, embedding_texts
        embedding_calls += 1
        embedding_texts += len(texts)
        return await asyncio.to_thread(
            ollama_embeddings, options.ollama_url, options.embedding_model, texts
        )

    started_at = datetime.now(timezone.utc)
    started = time.perf_counter()
    rag = LightRAG(
        working_dir=str(working_dir),
        llm_model_func=llm_model_func,
        embedding_func=EmbeddingFunc(
            embedding_dim=768,
            max_token_size=8192,
            func=embedding_function,
            model_name=options.embedding_model,
        ),
        llm_model_name=options.llm_model,
        llm_model_max_async=1,
        embedding_func_max_async=1,
        chunk_token_size=2048 if canonical_chunks else 1024,
        chunk_overlap_token_size=0 if canonical_chunks else 128,
        addon_params={"language": options.summary_language},
    )
    await rag.initialize_storages()
    ingestion_ms = 0
    document_status_counts: dict[str, int] = {}
    try:
        if not options.search_only:
            ingest_started = time.perf_counter()
            ingestion_payloads = (
                [
                    "\n".join([
                        f"canonical_chunk_id: {item['id']}",
                        f"source_id: {item['source']}",
                        f"section: {item['section']}",
                        str(item["text"]),
                    ])
                    for item in canonical_chunks
                ]
                if canonical_chunks
                else [source_payload(document) for document in documents]
            )
            ingestion_ids = (
                [hashlib.md5(str(item["id"]).encode()).hexdigest() for item in canonical_chunks]
                if canonical_chunks
                else [hashlib.md5(document.relative_path.encode()).hexdigest() for document in documents]
            )
            ingestion_paths = (
                [f"{str(item['source']).replace('/', '__')}__{item['id']}.md" for item in canonical_chunks]
                if canonical_chunks
                else [document.relative_path.replace("/", "__") for document in documents]
            )
            await rag.ainsert(
                ingestion_payloads,
                ids=ingestion_ids,
                # LightRAG normalizes citation paths to basename and treats a
                # repeated basename as a duplicate upload.  Encode the source
                # hierarchy into a unique basename; provenance is still read
                # from the source_id line embedded in each raw chunk.
                file_paths=ingestion_paths,
            )
            ingestion_ms = round((time.perf_counter() - ingest_started) * 1000)
            status_path = working_dir / "kv_store_doc_status.json"
            statuses = json.loads(status_path.read_text(encoding="utf-8"))
            for status in statuses.values():
                name = str(status.get("status") or "unknown")
                document_status_counts[name] = document_status_counts.get(name, 0) + 1
            expected_processed = len(canonical_chunks) if canonical_chunks else len(documents)
            if document_status_counts.get("processed") != expected_processed:
                raise RuntimeError(
                    "LightRAG did not process every input document: "
                    f"{document_status_counts}, expected {expected_processed} processed"
                )

        rows: list[dict[str, Any]] = []
        for mode in [item.strip() for item in options.modes.split(",") if item.strip()]:
            for question in questions:
                query_started = time.perf_counter()
                result = await rag.aquery_data(
                    question["question"],
                    QueryParam(
                        mode=mode,
                        top_k=options.top_k,
                        chunk_top_k=options.top_k,
                        max_total_tokens=32000,
                        enable_rerank=False,
                    ),
                )
                elapsed_ms = round((time.perf_counter() - query_started) * 1000, 1)
                data = result.get("data") or {}
                chunks = data.get("chunks") or []
                units = []
                for rank, chunk in enumerate(chunks[: options.top_k], start=1):
                    content = str(chunk.get("content") or "")
                    canonical_match = re.search(
                        r"(?m)^canonical_chunk_id:\s*(\S+)\s*$", content
                    )
                    canonical = (
                        canonical_by_id.get(canonical_match.group(1))
                        if canonical_match and canonical_by_id
                        else None
                    )
                    units.append(
                        {
                            "id": str(chunk.get("chunk_id") or f"{mode}:{rank}"),
                            "unit_type": "lightrag_chunk",
                            "score": float(options.top_k - rank + 1),
                            "rank": rank,
                            "text": content,
                            "retrieval_text": content,
                            "evidence": evidence_for_chunk(chunk, documents_by_path, canonical_by_id),
                            "token_count": canonical.get("token_count") if canonical else None,
                            "relative_position": canonical.get("relative_position") if canonical else None,
                            "source": canonical.get("source") if canonical else None,
                            "section": canonical.get("section") if canonical else None,
                            "lightrag_reference_id": chunk.get("reference_id"),
                        }
                    )
                rows.append(
                    {
                        "condition": f"lightrag-{mode}",
                        "question_id": question["id"],
                        "question": question["question"],
                        "elapsed_ms": elapsed_ms,
                        "retrieved_units": units,
                        "metadata": result.get("metadata") or {},
                    }
                )
        (output / "retrieval.jsonl").write_text(
            "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows),
            encoding="utf-8",
        )
        completed_at = datetime.now(timezone.utc)
        manifest = {
            "schema_version": "1.0",
            "experiment": "lightrag-p1-retrieval",
            "status": "completed",
            "started_at": started_at.isoformat(),
            "completed_at": completed_at.isoformat(),
            "duration_ms": round((time.perf_counter() - started) * 1000),
            "ingestion_ms": ingestion_ms,
            "lightrag_version": LIGHTRAG_VERSION,
            "lightrag_commit": LIGHTRAG_COMMIT,
            "llm_provider": "codex-app-server",
            "llm_model": options.llm_model,
            "reasoning_effort": options.reasoning_effort,
            "summary_language": options.summary_language,
            "llm_usage": bridge.usage(),
            "embedding_model": options.embedding_model,
            "canonical_chunks": str(options.canonical_chunks.resolve()) if options.canonical_chunks else None,
            "canonical_chunk_count": len(canonical_chunks),
            "embedding_dim": 768,
            "embedding_calls": embedding_calls,
            "embedding_texts": embedding_texts,
            "source_prefix": options.source_prefix,
            "documents": len(documents),
            "document_status_counts": document_status_counts,
            "questions": len(questions),
            "top_k": options.top_k,
            "modes": [item.strip() for item in options.modes.split(",") if item.strip()],
            "inputs": {
                "questions_sha256": sha256_file(corpus / "evaluation/questions.jsonl"),
                "documents": {
                    document.relative_path: sha256_file(document.path)
                    for document in documents
                },
            },
        }
        (output / "manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    finally:
        await rag.finalize_storages()
        bridge.close()


def main() -> None:
    asyncio.run(run(parse_args()))


if __name__ == "__main__":
    main()
