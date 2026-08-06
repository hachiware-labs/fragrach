#!/usr/bin/env python
"""Build and evaluate FastGraphRAG on the shared P1 update corpus."""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import importlib.util
import json
import re
import sys
import time
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Type

import numpy as np
from pydantic import BaseModel

from fast_graphrag import GraphRAG, QueryParam
from fast_graphrag._llm._base import BaseEmbeddingService, BaseLLMService, T_model
from fast_graphrag._models import BaseModelAlias
from fast_graphrag._policies._ranking import RankingPolicy_TopK


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
FAST_GRAPHRAG_COMMIT = "23b3a1bef64338faf9f35c521a20465dbd09419f"


@dataclass
class SourceDocument:
    path: Path
    relative_path: str
    body: str
    metadata: dict[str, Any]
    sections: list[dict[str, str]]


@dataclass
class CodexLLMService(BaseLLMService):
    bridge: Any = field(default=None)

    async def send_message(
        self,
        prompt: str,
        system_prompt: str | None = None,
        history_messages: list[dict[str, str]] | None = None,
        response_model: Type[T_model] | None = None,
        **_: Any,
    ) -> tuple[T_model, list[dict[str, str]]]:
        if response_model is None:
            raise ValueError("FastGraphRAG requires a response model")
        schema_model = (
            response_model.Model
            if issubclass(response_model, BaseModelAlias)
            else response_model
        )
        prompt_parts = []
        if system_prompt:
            prompt_parts.append(f"<system>\n{system_prompt}\n</system>")
        for message in history_messages or []:
            role = message.get("role", "user")
            prompt_parts.append(f"<{role}>\n{message.get('content', '')}\n</{role}>")
        prompt_parts.append(f"<user>\n{prompt}\n</user>")
        response = await self.bridge.request_async(
            "\n\n".join(prompt_parts), schema_model.model_json_schema()
        )
        content = response.get("content")
        if not isinstance(content, dict):
            raise ValueError("Codex bridge returned non-object content")
        parsed = schema_model.model_validate(content)
        result: Any = parsed
        if issubclass(response_model, BaseModelAlias):
            result = schema_model.to_dataclass(parsed)
        messages = list(history_messages or [])
        if system_prompt:
            messages.insert(0, {"role": "system", "content": system_prompt})
        messages.extend(
            [
                {"role": "user", "content": prompt},
                {"role": "assistant", "content": parsed.model_dump_json()},
            ]
        )
        return result, messages


@dataclass
class OllamaEmbeddingService(BaseEmbeddingService):
    endpoint: str = field(default="http://127.0.0.1:11434/v1")
    calls: int = field(init=False, default=0)
    texts: int = field(init=False, default=0)

    async def encode(
        self, texts: list[str], model: str | None = None
    ) -> np.ndarray[Any, np.dtype[np.float32]]:
        self.calls += 1
        self.texts += len(texts)
        return await asyncio.to_thread(self._encode_sync, texts, model or self.model)

    def _encode_sync(self, texts: list[str], model: str | None) -> np.ndarray:
        request = urllib.request.Request(
            f"{self.endpoint.rstrip('/')}/embeddings",
            data=json.dumps({"model": model, "input": texts}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=300) as response:
            payload = json.loads(response.read().decode("utf-8"))
        ordered = sorted(payload["data"], key=lambda item: item["index"])
        return np.asarray([item["embedding"] for item in ordered], dtype=np.float32)


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
    parser.add_argument("--ollama-url", default="http://127.0.0.1:11434/v1")
    parser.add_argument("--top-k", type=int, default=20)
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


def evidence_for_chunk(chunk: Any, documents_by_path: dict[str, SourceDocument]) -> list[dict[str, str]]:
    path = str(chunk.metadata.get("source") or "").replace("\\", "/")
    document = documents_by_path.get(path)
    if document is None:
        return [{"source": path, "section": "本文", "text": chunk.content}]
    matching = [
        section
        for section in document.sections
        if section["text"] in chunk.content or chunk.content in section["text"]
    ]
    if not matching:
        matching = document.sections
    return [
        {"source": path, "section": section["section"], "text": section["text"]}
        for section in matching
    ]


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


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
    llm = CodexLLMService(model=options.llm_model, max_requests_concurrent=1, bridge=bridge)
    embedding = OllamaEmbeddingService(
        embedding_dim=768,
        model=options.embedding_model,
        endpoint=options.ollama_url,
        rate_limit_concurrency=False,
        rate_limit_per_minute=False,
        rate_limit_per_second=False,
    )
    config = GraphRAG.Config(
        llm_service=llm,
        embedding_service=embedding,
        chunk_ranking_policy=RankingPolicy_TopK(
            RankingPolicy_TopK.Config(top_k=options.top_k)
        ),
    )
    graph = GraphRAG(
        working_dir=str(working_dir),
        domain="企業内規程・FAQ・承認記録の版、効力、時点、権威、矛盾を扱う文書検索",
        example_queries="\n".join(question["question"] for question in questions),
        entity_types=[
            "EnterpriseDocument",
            "OrganizationUnit",
            "BusinessRole",
            "GovernedSubject",
            "PolicyValue",
        ],
        config=config,
    )
    started_at = datetime.now(timezone.utc)
    started = time.perf_counter()
    ingestion_ms = 0
    try:
        counts = None
        if not options.search_only:
            ingest_started = time.perf_counter()
            counts = await graph.async_insert(
                [source_payload(document) for document in documents],
                metadata=[{"source": document.relative_path} for document in documents],
                show_progress=False,
            )
            ingestion_ms = round((time.perf_counter() - ingest_started) * 1000)
        rows = []
        for question in questions:
            query_started = time.perf_counter()
            response = await graph.async_query(
                question["question"],
                QueryParam(
                    only_context=True,
                    chunks_max_tokens=32000,
                    entities_max_tokens=8000,
                    relations_max_tokens=8000,
                ),
            )
            elapsed_ms = round((time.perf_counter() - query_started) * 1000, 1)
            units = []
            for rank, (chunk, score) in enumerate(response.context.chunks[: options.top_k], start=1):
                units.append(
                    {
                        "id": f"fast-graphrag:{chunk.id}",
                        "unit_type": "fast_graphrag_chunk",
                        "score": float(score),
                        "rank": rank,
                        "text": chunk.content,
                        "retrieval_text": chunk.content,
                        "evidence": evidence_for_chunk(chunk, documents_by_path),
                    }
                )
            rows.append(
                {
                    "condition": "fast-graphrag-ppr",
                    "question_id": question["id"],
                    "question": question["question"],
                    "elapsed_ms": elapsed_ms,
                    "retrieved_units": units,
                    "context_counts": {
                        "entities": len(response.context.entities),
                        "relations": len(response.context.relations),
                        "chunks": len(response.context.chunks),
                    },
                }
            )
        (output / "retrieval.jsonl").write_text(
            "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows),
            encoding="utf-8",
        )
        manifest = {
            "schema_version": "1.0",
            "experiment": "fast-graphrag-p1-retrieval",
            "status": "completed",
            "started_at": started_at.isoformat(),
            "completed_at": datetime.now(timezone.utc).isoformat(),
            "duration_ms": round((time.perf_counter() - started) * 1000),
            "ingestion_ms": ingestion_ms,
            "fast_graphrag_version": "0.0.5",
            "fast_graphrag_commit": FAST_GRAPHRAG_COMMIT,
            "llm_provider": "codex-app-server",
            "llm_model": options.llm_model,
            "reasoning_effort": options.reasoning_effort,
            "llm_usage": bridge.usage(),
            "embedding_model": options.embedding_model,
            "embedding_dim": 768,
            "embedding_calls": embedding.calls,
            "embedding_texts": embedding.texts,
            "source_prefix": options.source_prefix,
            "documents": len(documents),
            "questions": len(questions),
            "top_k": options.top_k,
            "graph_counts": (
                {"entities": counts[0], "relations": counts[1], "chunks": counts[2]}
                if counts is not None
                else None
            ),
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

