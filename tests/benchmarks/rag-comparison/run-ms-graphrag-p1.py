#!/usr/bin/env python
"""Build and evaluate Microsoft GraphRAG Local Search on the shared P1 corpus."""

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
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pandas as pd
from pydantic import BaseModel

from graphrag.api import build_index
from graphrag.config.embeddings import entity_description_embedding
from graphrag.config.models.graph_rag_config import GraphRagConfig
from graphrag.query.factory import get_local_search_engine
from graphrag.query.indexer_adapters import (
    read_indexer_communities,
    read_indexer_covariates,
    read_indexer_entities,
    read_indexer_relationships,
    read_indexer_reports,
    read_indexer_text_units,
)
from graphrag.utils.api import get_embedding_store
from graphrag_llm.completion import LLMCompletion, register_completion
from graphrag_llm.embedding import LLMEmbedding, register_embedding
from graphrag_llm.types import (
    LLMEmbedding as EmbeddingItem,
    LLMEmbeddingResponse,
    LLMEmbeddingUsage,
)
from graphrag_llm.utils import create_completion_response


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
MS_GRAPHRAG_VERSION = "3.1.0"
MS_GRAPHRAG_COMMIT = "7fc6607edda3d387d23e52ededbf8a75b6730f97"


@dataclass
class SourceDocument:
    path: Path
    relative_path: str
    body: str
    metadata: dict[str, Any]
    sections: list[dict[str, str]]


@dataclass
class EmbeddingStats:
    calls: int = 0
    texts: int = 0


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


def format_messages(messages: Any) -> tuple[str, str | None]:
    if isinstance(messages, str):
        return messages, None
    parts: list[str] = []
    system_parts: list[str] = []
    for message in messages or []:
        if isinstance(message, dict):
            role = str(message.get("role") or "user")
            content = message.get("content")
        else:
            role = str(getattr(message, "role", "user"))
            content = getattr(message, "content", "")
        if not isinstance(content, str):
            content = json.dumps(content, ensure_ascii=False, default=str)
        if role == "system":
            system_parts.append(content)
        else:
            parts.append(f"<{role}>\n{content}\n</{role}>")
    return "\n\n".join(parts), "\n\n".join(system_parts) or None


class CodexCompletion(LLMCompletion):
    def __init__(self, *, bridge: Any, tokenizer: Any, metrics_store: Any, **_: Any):
        self.bridge = bridge
        self._tokenizer = tokenizer
        self._metrics_store = metrics_store

    def _complete(self, **kwargs: Any) -> Any:
        if kwargs.get("stream"):
            raise ValueError("P1 indexing adapter does not support streaming")
        prompt, system_prompt = format_messages(kwargs.get("messages"))
        response_format = kwargs.get("response_format")
        if isinstance(response_format, type) and issubclass(response_format, BaseModel):
            full_prompt = "\n\n".join(
                [f"<system>\n{system_prompt or ''}\n</system>", prompt]
            )
            raw = self.bridge.request(full_prompt, response_format.model_json_schema())
            content = raw.get("content")
            if not isinstance(content, dict):
                raise ValueError("Codex bridge returned non-object content")
            parsed = response_format.model_validate(content)
            response = create_completion_response(parsed.model_dump_json())
            response.formatted_response = parsed
            return response
        text = asyncio.run(
            self.bridge.complete_text(prompt, system_prompt=system_prompt)
        )
        return create_completion_response(text)

    def completion(self, /, **kwargs: Any) -> Any:
        return self._complete(**kwargs)

    async def completion_async(self, /, **kwargs: Any) -> Any:
        return await asyncio.to_thread(self._complete, **kwargs)

    @property
    def metrics_store(self) -> Any:
        return self._metrics_store

    @property
    def tokenizer(self) -> Any:
        return self._tokenizer


class OllamaRuriEmbedding(LLMEmbedding):
    def __init__(
        self,
        *,
        endpoint: str,
        embedding_model: str,
        stats: EmbeddingStats,
        tokenizer: Any,
        metrics_store: Any,
        **_: Any,
    ):
        self.endpoint = endpoint
        self.embedding_model = embedding_model
        self.stats = stats
        self._tokenizer = tokenizer
        self._metrics_store = metrics_store

    def embedding(self, /, **kwargs: Any) -> LLMEmbeddingResponse:
        raw_input = kwargs.get("input") or []
        texts = [raw_input] if isinstance(raw_input, str) else list(raw_input)
        request = urllib.request.Request(
            self.endpoint,
            data=json.dumps({"model": self.embedding_model, "input": texts}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=300) as response:
            payload = json.loads(response.read().decode("utf-8"))
        vectors = payload.get("embeddings") or []
        if len(vectors) != len(texts):
            raise ValueError(f"Ollama returned {len(vectors)} vectors for {len(texts)} texts")
        self.stats.calls += 1
        self.stats.texts += len(texts)
        return LLMEmbeddingResponse(
            object="list",
            data=[
                EmbeddingItem(object="embedding", embedding=vector, index=index)
                for index, vector in enumerate(vectors)
            ],
            model=self.embedding_model,
            usage=LLMEmbeddingUsage(prompt_tokens=0, total_tokens=0),
        )

    async def embedding_async(self, /, **kwargs: Any) -> LLMEmbeddingResponse:
        return await asyncio.to_thread(self.embedding, **kwargs)

    @property
    def metrics_store(self) -> Any:
        return self._metrics_store

    @property
    def tokenizer(self) -> Any:
        return self._tokenizer


def make_config(options: argparse.Namespace, working_dir: Path) -> GraphRagConfig:
    output_dir = working_dir / "output"
    vector_dir = output_dir / "lancedb"
    return GraphRagConfig(
        completion_models={
            "default_completion_model": {
                "type": "codex_app_server",
                "model_provider": "codex-app-server",
                "model": options.llm_model,
                "metrics": None,
            }
        },
        embedding_models={
            "default_embedding_model": {
                "type": "ollama_ruri",
                "model_provider": "ollama",
                "model": options.embedding_model,
                "metrics": None,
            }
        },
        concurrent_requests=1,
        input_storage={"type": "file", "base_dir": str(working_dir / "input")},
        output_storage={"type": "file", "base_dir": str(output_dir)},
        update_output_storage={"type": "file", "base_dir": str(working_dir / "update_output")},
        cache={"type": "json", "storage": {"type": "file", "base_dir": str(working_dir / "cache")}},
        reporting={"type": "file", "base_dir": str(working_dir / "logs")},
        vector_store={"type": "lancedb", "db_uri": str(vector_dir), "vector_size": 768},
        chunking={"type": "tokens", "encoding_model": "o200k_base", "size": 1024, "overlap": 0},
        local_search={
            "text_unit_prop": 0.65,
            "community_prop": 0.15,
            "top_k_entities": 20,
            "top_k_relationships": 20,
            "max_context_tokens": 32000,
        },
        extract_claims={"enabled": False},
    )


def read_table(output_dir: Path, name: str, optional: bool = False) -> pd.DataFrame | None:
    path = output_dir / f"{name}.parquet"
    if optional and not path.exists():
        return None
    return pd.read_parquet(path)


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
    embedding_stats = EmbeddingStats()
    register_completion(
        "codex_app_server",
        lambda **kwargs: CodexCompletion(bridge=bridge, **kwargs),
        scope="singleton",
    )
    register_embedding(
        "ollama_ruri",
        lambda **kwargs: OllamaRuriEmbedding(
            endpoint=options.ollama_url,
            embedding_model=options.embedding_model,
            stats=embedding_stats,
            **kwargs,
        ),
        scope="singleton",
    )
    config = make_config(options, working_dir)
    input_documents = pd.DataFrame(
        [
            {
                "id": str(uuid.uuid5(uuid.NAMESPACE_URL, document.relative_path)),
                "human_readable_id": index,
                "title": document.relative_path,
                "text": source_payload(document),
                "creation_date": None,
                "raw_data": None,
            }
            for index, document in enumerate(documents)
        ]
    )
    started_at = datetime.now(timezone.utc)
    started = time.perf_counter()
    ingestion_ms = 0
    try:
        if not options.search_only:
            ingest_started = time.perf_counter()
            results = await build_index(
                config=config,
                method="standard",
                input_documents=input_documents,
                verbose=False,
            )
            errors = [str(result.error) for result in results if result.error is not None]
            if errors:
                raise RuntimeError("Microsoft GraphRAG indexing failed: " + " | ".join(errors))
            ingestion_ms = round((time.perf_counter() - ingest_started) * 1000)

        table_dir = working_dir / "output"
        entities = read_table(table_dir, "entities")
        communities = read_table(table_dir, "communities")
        community_reports = read_table(table_dir, "community_reports")
        text_units = read_table(table_dir, "text_units")
        relationships = read_table(table_dir, "relationships")
        covariates = read_table(table_dir, "covariates", optional=True)
        if any(value is None for value in [entities, communities, community_reports, text_units, relationships]):
            raise RuntimeError("required Microsoft GraphRAG output table is missing")

        description_embedding_store = get_embedding_store(
            config=config.vector_store,
            embedding_name=entity_description_embedding,
        )
        entities_model = read_indexer_entities(entities, communities, community_level=2)
        engine = get_local_search_engine(
            config=config,
            reports=read_indexer_reports(community_reports, communities, community_level=2),
            text_units=read_indexer_text_units(text_units),
            entities=entities_model,
            relationships=read_indexer_relationships(relationships),
            covariates={
                "claims": read_indexer_covariates(covariates) if covariates is not None else []
            },
            response_type="multiple paragraphs",
            description_embedding_store=description_embedding_store,
        )

        rows = []
        for question in questions:
            query_started = time.perf_counter()
            context = engine.context_builder.build_context(
                query=question["question"],
                **engine.context_builder_params,
            )
            elapsed_ms = round((time.perf_counter() - query_started) * 1000, 1)
            sources = context.context_records.get("sources", pd.DataFrame())
            if "in_context" in sources.columns:
                sources = sources[sources["in_context"]]
            units = []
            for rank, (_, source) in enumerate(sources.head(options.top_k).iterrows(), start=1):
                text_value = str(source.get("text") or "")
                units.append(
                    {
                        "id": str(source.get("id") or f"ms-graphrag-local:{rank}"),
                        "unit_type": "ms_graphrag_text_unit",
                        "score": float(options.top_k - rank + 1),
                        "rank": rank,
                        "text": text_value,
                        "retrieval_text": text_value,
                        "evidence": evidence_for_text(text_value, documents_by_path),
                    }
                )
            rows.append(
                {
                    "condition": "ms-graphrag-local",
                    "question_id": question["id"],
                    "question": question["question"],
                    "elapsed_ms": elapsed_ms,
                    "retrieved_units": units,
                    "context_counts": {
                        key: len(value) if isinstance(value, pd.DataFrame) else 0
                        for key, value in context.context_records.items()
                    },
                    "context_chars": len(context.context_chunks),
                }
            )

        (output / "retrieval.jsonl").write_text(
            "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows),
            encoding="utf-8",
        )
        manifest = {
            "schema_version": "1.0",
            "experiment": "microsoft-graphrag-p1-local-search",
            "status": "completed",
            "started_at": started_at.isoformat(),
            "completed_at": datetime.now(timezone.utc).isoformat(),
            "duration_ms": round((time.perf_counter() - started) * 1000),
            "ingestion_ms": ingestion_ms,
            "ms_graphrag_version": MS_GRAPHRAG_VERSION,
            "ms_graphrag_commit": MS_GRAPHRAG_COMMIT,
            "llm_provider": "codex-app-server",
            "llm_model": options.llm_model,
            "reasoning_effort": options.reasoning_effort,
            "llm_usage": bridge.usage(),
            "embedding_model": options.embedding_model,
            "embedding_dim": 768,
            "embedding_calls": embedding_stats.calls,
            "embedding_texts": embedding_stats.texts,
            "source_prefix": options.source_prefix,
            "documents": len(documents),
            "questions": len(questions),
            "top_k": options.top_k,
            "index_counts": {
                "entities": len(entities),
                "relationships": len(relationships),
                "communities": len(communities),
                "community_reports": len(community_reports),
                "text_units": len(text_units),
            },
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
