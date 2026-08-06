#!/usr/bin/env python
"""Build and evaluate Cognee on the shared P1 update corpus."""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import importlib.util
import json
import os
import re
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from pydantic import BaseModel


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
COGNEE_VERSION = "1.4.1"
COGNEE_COMMIT = "82bc3de9062af26ebcac3d61343d7e1a4f577586"
DEFAULT_NEO4J_CREDENTIALS = Path(r"D:\data\fragrach-evaluation\neo4j\credentials.env")


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
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--working-dir", type=Path, required=True)
    parser.add_argument("--llm-model", default="gpt-5.6-luna")
    parser.add_argument("--reasoning-effort", default="low")
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
    parser.add_argument("--ollama-url", default="http://127.0.0.1:11434/api/embed")
    parser.add_argument("--top-k", type=int, default=20)
    parser.add_argument("--neo4j-credentials", type=Path, default=DEFAULT_NEO4J_CREDENTIALS)
    parser.add_argument("--search-only", action="store_true")
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


def result_payload(result: Any) -> dict[str, Any]:
    if isinstance(result, dict):
        return result
    payload = getattr(result, "payload", None)
    return payload if isinstance(payload, dict) else {}


def result_score(result: Any, rank: int, top_k: int) -> float:
    for value in (getattr(result, "score", None), result_payload(result).get("score")):
        if value is not None:
            try:
                return float(value)
            except (TypeError, ValueError):
                pass
    return float(top_k - rank + 1)


def evidence_for_text(
    text: str, documents_by_path: dict[str, SourceDocument]
) -> list[dict[str, str]]:
    match = re.search(r"(?m)^source_id:\s*(\S+)\s*$", text)
    if not match:
        return []
    source = match.group(1).replace("\\", "/")
    document = documents_by_path.get(source)
    if document is None:
        return [{"source": source, "section": "本文", "text": text}]
    matching = [
        section
        for section in document.sections
        if section["text"] in text or text in section["text"]
    ]
    if not matching:
        matching = document.sections
    return [
        {"source": source, "section": section["section"], "text": section["text"]}
        for section in matching
    ]


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def configure_environment(options: argparse.Namespace) -> None:
    neo4j = {}
    for line in options.neo4j_credentials.read_text(encoding="utf-8").splitlines():
        if line and not line.lstrip().startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            neo4j[key.strip()] = value.strip()
    missing = {"NEO4J_URI", "NEO4J_USER", "NEO4J_PASSWORD"} - neo4j.keys()
    if missing:
        raise ValueError(f"missing Neo4j credentials: {sorted(missing)}")
    os.environ.update(
        {
            "ENABLE_BACKEND_ACCESS_CONTROL": "false",
            "CACHING": "false",
            "LLM_PROVIDER": "openai",
            "LLM_MODEL": options.llm_model,
            "LLM_API_KEY": "codex-app-server",
            "EMBEDDING_PROVIDER": "ollama",
            "EMBEDDING_MODEL": options.embedding_model,
            "EMBEDDING_ENDPOINT": options.ollama_url,
            "EMBEDDING_DIMENSIONS": "768",
            "EMBEDDING_BATCH_SIZE": "32",
            "GRAPH_DATABASE_PROVIDER": "neo4j",
            "GRAPH_DATABASE_URL": neo4j["NEO4J_URI"],
            "GRAPH_DATABASE_USERNAME": neo4j["NEO4J_USER"],
            "GRAPH_DATABASE_PASSWORD": neo4j["NEO4J_PASSWORD"],
        }
    )


async def run(options: argparse.Namespace) -> None:
    corpus = options.corpus.resolve()
    output = options.output.resolve()
    working_dir = options.working_dir.resolve()
    if output.exists():
        raise FileExistsError(f"output directory already exists: {output}")
    if not options.search_only and working_dir.exists() and any(working_dir.iterdir()):
        raise FileExistsError(f"working directory is not empty: {working_dir}")
    output.mkdir(parents=True)
    working_dir.mkdir(parents=True, exist_ok=True)
    configure_environment(options)

    import cognee
    from cognee.infrastructure.llm.LLMGateway import LLMGateway
    from cognee.modules.retrieval.chunks_retriever import ChunksRetriever
    from cognee.modules.retrieval.hybrid_retriever import HybridRetriever

    cognee.config.system_root_directory(str(working_dir / "system"))
    cognee.config.data_root_directory(str(working_dir / "data"))
    cognee.config.set_graph_database_provider("neo4j")
    cognee.config.set_vector_db_provider("lancedb")

    documents = load_documents(corpus, options.source_prefix)
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

    async def codex_structured_output(
        text_input: str,
        system_prompt: str,
        response_model: type[Any],
        **_: Any,
    ) -> Any:
        if response_model is str:
            return await bridge.complete_text(text_input, system_prompt=system_prompt)
        if not isinstance(response_model, type) or not issubclass(response_model, BaseModel):
            raise TypeError(f"unsupported Cognee response model: {response_model!r}")
        prompt = "\n\n".join(
            [
                f"<system>\n{system_prompt or ''}\n</system>",
                f"<user>\n{text_input}\n</user>",
            ]
        )
        response = await bridge.request_async(prompt, response_model.model_json_schema())
        content = response.get("content")
        if not isinstance(content, dict):
            raise ValueError("Codex bridge returned non-object content")
        return response_model.model_validate(content)

    LLMGateway.acreate_structured_output = staticmethod(codex_structured_output)

    dataset_name = "fragrach_p1_governance"
    started_at = datetime.now(timezone.utc)
    started = time.perf_counter()
    ingestion_ms = 0
    cognify_result: Any = None
    try:
        if not options.search_only:
            ingest_started = time.perf_counter()
            await cognee.add(
                [source_payload(document) for document in documents],
                dataset_name=dataset_name,
                data_per_batch=len(documents),
                data_cache=False,
            )
            cognify_result = await cognee.cognify(
                datasets=[dataset_name],
                chunk_size=1024,
                chunks_per_batch=1,
                data_per_batch=len(documents),
                data_cache=False,
            )
            ingestion_ms = round((time.perf_counter() - ingest_started) * 1000)

        retrievers = {
            "cognee-chunks": ChunksRetriever(top_k=options.top_k),
            "cognee-hybrid": HybridRetriever(
                chunks_top_k=options.top_k,
                entities_top_k=options.top_k,
                max_edges_per_entity=10,
                facts_top_k=options.top_k,
                use_truth_weight=False,
            ),
        }
        rows = []
        for condition, retriever in retrievers.items():
            for question in questions:
                query_started = time.perf_counter()
                retrieved = await retriever.get_retrieved_objects(query=question["question"])
                elapsed_ms = round((time.perf_counter() - query_started) * 1000, 1)
                chunks = retrieved.get("chunks", []) if isinstance(retrieved, dict) else retrieved
                units = []
                for rank, chunk in enumerate(chunks[: options.top_k], start=1):
                    payload = result_payload(chunk)
                    text_value = str(payload.get("text") or "")
                    units.append(
                        {
                            "id": str(payload.get("id") or getattr(chunk, "id", "") or f"{condition}:{rank}"),
                            "unit_type": "cognee_document_chunk",
                            "score": result_score(chunk, rank, options.top_k),
                            "rank": rank,
                            "text": text_value,
                            "retrieval_text": text_value,
                            "evidence": evidence_for_text(text_value, documents_by_path),
                        }
                    )
                row = {
                    "condition": condition,
                    "question_id": question["id"],
                    "question": question["question"],
                    "elapsed_ms": elapsed_ms,
                    "retrieved_units": units,
                }
                if isinstance(retrieved, dict):
                    row["context_counts"] = {
                        "chunks": len(chunks),
                        "entities": len(retrieved.get("entities", [])),
                        "facts": len(retrieved.get("facts", [])),
                    }
                rows.append(row)

        (output / "retrieval.jsonl").write_text(
            "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows),
            encoding="utf-8",
        )
        manifest = {
            "schema_version": "1.0",
            "experiment": "cognee-p1-retrieval",
            "status": "completed",
            "started_at": started_at.isoformat(),
            "completed_at": datetime.now(timezone.utc).isoformat(),
            "duration_ms": round((time.perf_counter() - started) * 1000),
            "ingestion_ms": ingestion_ms,
            "cognee_version": COGNEE_VERSION,
            "cognee_commit": COGNEE_COMMIT,
            "graph_database": "neo4j-community-local",
            "vector_database": "lancedb",
            "llm_provider": "codex-app-server",
            "llm_model": options.llm_model,
            "reasoning_effort": options.reasoning_effort,
            "llm_usage": bridge.usage(),
            "embedding_model": options.embedding_model,
            "embedding_dim": 768,
            "source_prefix": options.source_prefix,
            "documents": len(documents),
            "questions": len(questions),
            "top_k": options.top_k,
            "cognify_result": str(cognify_result) if cognify_result is not None else None,
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
        bridge.close()


def main() -> None:
    asyncio.run(run(parse_args()))


if __name__ == "__main__":
    main()
