#!/usr/bin/env python
"""Run the Fragrach P1 retrieval benchmark against Graphiti.

The script intentionally keeps Graphiti in its own Python environment.  It
ingests source documents as chronological episodes, searches Graphiti's public
edge-hybrid API, resolves every returned fact back to its raw episodes, and
writes a neutral retrieval JSONL for the shared JavaScript scorer.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import logging
import os
import re
import subprocess
import sys
import threading
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from pydantic import BaseModel

# Graphiti reads these values while importing its modules.
os.environ.setdefault("EMBEDDING_DIM", "768")
os.environ.setdefault("GRAPHITI_TELEMETRY_ENABLED", "false")
os.environ.setdefault("SEMAPHORE_LIMIT", "1")

from graphiti_core import Graphiti  # noqa: E402
from graphiti_core.cross_encoder.openai_reranker_client import (  # noqa: E402
    OpenAIRerankerClient,
)
from graphiti_core.embedder.openai import OpenAIEmbedder, OpenAIEmbedderConfig  # noqa: E402
from graphiti_core.llm_client.config import LLMConfig, ModelSize  # noqa: E402
from graphiti_core.llm_client.openai_generic_client import OpenAIGenericClient  # noqa: E402
from graphiti_core.nodes import EpisodeType, EpisodicNode  # noqa: E402
from graphiti_core.prompts.models import Message  # noqa: E402
from graphiti_core.utils.maintenance import clear_data  # noqa: E402


DEFAULT_CORPUS = Path("tests/corpora/fragrach-enterprise-ja-diverse")
DEFAULT_SOURCE_PREFIX = "sources/manufacturing/product-design/governance"
DEFAULT_CREDENTIALS = Path(r"D:\data\fragrach-evaluation\neo4j\credentials.env")
GRAPHITI_GROUP_ID = "neo4j"
CUSTOM_EXTRACTION_INSTRUCTIONS = """
これは企業文書検索の評価データである。文書先頭の metadata は本文と同じく重要な事実として扱う。
status、authority、approved、force、valid_from、valid_to、version、document_type を保持し、
旧版、失効済み文書、stale FAQ、承認記録、現行規程を同じ効力として混同しないこと。
「置き換える」「改訂を反映していない」「旧案内」の関係と、値・担当者・期日を日本語のまま抽出すること。
各Episodeでは、文書titleをEnterpriseDocumentとして必ず抽出すること。明記された会社、部門、役職、
規程が扱う固有の業務対象も、対応する型で抽出すること。
推測した関係を原文に明記された関係と混同しないこと。
""".strip()


class EnterpriseDocument(BaseModel):
    """A specifically titled enterprise policy, procedure, FAQ, approval record, or document version."""


class OrganizationUnit(BaseModel):
    """A specifically named company, department, plant, team, or other organizational unit."""


class BusinessRole(BaseModel):
    """A specifically named business role or approval role, such as 品質保証部長 or 主任技師."""


class GovernedSubject(BaseModel):
    """A specifically named business process, controlled record, product, asset, or policy subject governed by a document."""


ENTITY_TYPES = {
    "EnterpriseDocument": EnterpriseDocument,
    "OrganizationUnit": OrganizationUnit,
    "BusinessRole": BusinessRole,
    "GovernedSubject": GovernedSubject,
}


@dataclass
class SourceDocument:
    path: Path
    relative_path: str
    metadata: dict[str, Any]
    body: str
    sections: list[dict[str, str]]
    reference_time: datetime


class TrackedOllamaClient(OpenAIGenericClient):
    """OpenAIGenericClient variant that records OpenAI-compatible usage."""

    async def _generate_response(
        self,
        messages: list[Message],
        response_model: type | None = None,
        max_tokens: int = 16384,
        model_size: ModelSize = ModelSize.medium,
    ) -> dict[str, Any]:
        openai_messages = []
        for message in messages:
            content = self._clean_input(message.content)
            if message.role in {"user", "system"}:
                openai_messages.append({"role": message.role, "content": content})
        response = await self.client.chat.completions.create(
            model=self.model,
            messages=openai_messages,
            temperature=self.temperature,
            max_tokens=max_tokens,
            response_format=self._build_response_format(response_model),
        )
        content = response.choices[0].message.content or ""
        if not content:
            raise ValueError("Ollama returned an empty structured response")
        usage = response.usage
        if usage is not None:
            self.token_tracker.record(
                None,
                int(usage.prompt_tokens or 0),
                int(usage.completion_tokens or 0),
            )
        return json.loads(self._strip_code_fences(content))


class CodexAppServerClient(OpenAIGenericClient):
    """Graphiti LLM adapter backed by Fragrach's persistent Codex bridge."""

    def __init__(
        self,
        config: LLMConfig,
        bridge: Path,
        codex_command: str,
        reasoning_effort: str,
        cwd: Path,
        timeout_seconds: int,
    ) -> None:
        # OpenAIGenericClient provides Graphiti's schema-aware generate_response
        # implementation. The placeholder client is never used because this
        # class overrides _generate_response.
        super().__init__(
            config=config,
            client=object(),
            max_tokens=16384,
            structured_output_mode="json_schema",
        )
        if not bridge.is_file():
            raise FileNotFoundError(f"Codex structured chat bridge not found: {bridge}")
        creation_flags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
        self.process = subprocess.Popen(
            [
                str(bridge),
                "--codex-command",
                codex_command,
                "--model",
                config.model,
                "--reasoning-effort",
                reasoning_effort,
                "--cwd",
                str(cwd),
                "--timeout-seconds",
                str(timeout_seconds),
            ],
            cwd=cwd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            bufsize=1,
            creationflags=creation_flags,
        )
        self._request_lock = threading.Lock()
        self._next_id = 1
        self.call_count = 0
        self.duration_ms = 0
        ready_line = self.process.stdout.readline() if self.process.stdout else ""
        ready = json.loads(ready_line) if ready_line else {}
        if ready.get("type") != "ready":
            self.close_bridge()
            raise RuntimeError(f"Codex bridge did not become ready: {ready_line!r}")

    def _request_sync(self, prompt: str, schema: dict[str, Any]) -> dict[str, Any]:
        with self._request_lock:
            if self.process.poll() is not None:
                raise RuntimeError(f"Codex bridge exited with code {self.process.returncode}")
            request_id = self._next_id
            self._next_id += 1
            request = {"id": request_id, "prompt": prompt, "schema": schema}
            if self.process.stdin is None or self.process.stdout is None:
                raise RuntimeError("Codex bridge pipes are unavailable")
            self.process.stdin.write(json.dumps(request, ensure_ascii=False) + "\n")
            self.process.stdin.flush()
            line = self.process.stdout.readline()
            if not line:
                raise RuntimeError("Codex bridge closed stdout before returning a response")
            response = json.loads(line)
            if response.get("id") != request_id:
                raise RuntimeError(
                    f"Codex bridge response id mismatch: expected {request_id}, got {response.get('id')}"
                )
            if response.get("error"):
                raise RuntimeError(str(response["error"]))
            return response

    async def _generate_response(
        self,
        messages: list[Message],
        response_model: type[BaseModel] | None = None,
        max_tokens: int = 16384,
        model_size: ModelSize = ModelSize.medium,
    ) -> dict[str, Any]:
        del max_tokens, model_size
        if response_model is None:
            raise ValueError("Codex App Server Graphiti calls require a response model")
        prompt = "\n\n".join(
            f"<{message.role}>\n{self._clean_input(message.content)}\n</{message.role}>"
            for message in messages
            if message.role in {"system", "user"}
        )
        response = await asyncio.to_thread(
            self._request_sync, prompt, response_model.model_json_schema()
        )
        usage = response.get("usage") or {}
        input_tokens = int(usage.get("promptTokens") or 0)
        output_tokens = int(usage.get("outputTokens") or 0)
        self.token_tracker.record(None, input_tokens, output_tokens)
        self.call_count += 1
        self.duration_ms += int(usage.get("durationMs") or 0)
        content = response.get("content")
        if not isinstance(content, dict):
            raise ValueError("Codex bridge returned a non-object structured response")
        return content

    def close_bridge(self) -> None:
        process = getattr(self, "process", None)
        if process is None or process.poll() is not None:
            return
        if process.stdin is not None:
            process.stdin.close()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.terminate()
            process.wait(timeout=10)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--corpus", type=Path, default=DEFAULT_CORPUS)
    parser.add_argument("--source-prefix", default=DEFAULT_SOURCE_PREFIX)
    parser.add_argument("--credentials", type=Path, default=DEFAULT_CREDENTIALS)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--llm-provider",
        choices=["ollama", "codex-app-server"],
        default="codex-app-server",
    )
    parser.add_argument("--llm-model", default="gpt-5.6-luna")
    parser.add_argument(
        "--embedding-model", default="hf.co/Targoyle/ruri-v3-310m-GGUF:Q8_0"
    )
    parser.add_argument("--ollama-url", default="http://127.0.0.1:11434/v1")
    parser.add_argument("--codex-command", default="codex")
    parser.add_argument("--reasoning-effort", default="low")
    parser.add_argument(
        "--codex-bridge",
        type=Path,
        default=Path("target/debug/examples/codex_structured_chat_bridge.exe"),
    )
    parser.add_argument("--llm-timeout-seconds", type=int, default=900)
    parser.add_argument("--top-k", type=int, default=20)
    parser.add_argument(
        "--max-documents",
        type=int,
        help="ingest only the first N chronologically ordered documents (smoke tests only)",
    )
    parser.add_argument("--reset", action="store_true")
    parser.add_argument("--ingest-only", action="store_true")
    parser.add_argument("--search-only", action="store_true")
    parser.add_argument("--log-level", default="INFO")
    return parser.parse_args()


def load_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line or line.lstrip().startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip()
    required = ["NEO4J_URI", "NEO4J_USER", "NEO4J_PASSWORD"]
    missing = [key for key in required if not values.get(key)]
    if missing:
        raise ValueError(f"missing Neo4j credentials: {', '.join(missing)}")
    return values


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


def parse_document(path: Path, corpus: Path, tie_breaker_seconds: int) -> SourceDocument:
    text = path.read_text(encoding="utf-8")
    metadata: dict[str, Any] = {}
    body = text
    if text.startswith("---"):
        parts = text.split("---", 2)
        if len(parts) == 3:
            for line in parts[1].splitlines():
                if ":" not in line:
                    continue
                key, value = line.split(":", 1)
                metadata[key.strip()] = parse_scalar(value)
            body = parts[2].lstrip()

    sections: list[dict[str, str]] = []
    heading = "本文"
    buffer: list[str] = []
    for line in body.splitlines():
        if line.startswith("## "):
            if buffer:
                sections.append({"section": heading, "text": "\n".join(buffer).strip()})
            heading = line[3:].strip()
            buffer = []
        else:
            buffer.append(line)
    if buffer:
        sections.append({"section": heading, "text": "\n".join(buffer).strip()})
    sections = [section for section in sections if section["text"]]

    valid_from = str(metadata.get("valid_from", "1970-01-01"))
    base_time = datetime.fromisoformat(valid_from).replace(tzinfo=timezone.utc)
    reference_time = base_time.replace(
        hour=0,
        minute=0,
        second=min(tie_breaker_seconds, 59),
    )
    relative_path = path.relative_to(corpus).as_posix()
    return SourceDocument(
        path=path,
        relative_path=relative_path,
        metadata=metadata,
        body=body,
        sections=sections,
        reference_time=reference_time,
    )


def load_documents(corpus: Path, source_prefix: str) -> list[SourceDocument]:
    source_root = corpus / Path(source_prefix)
    paths = sorted(source_root.rglob("*.md"))
    status_order = {"superseded": 0, "stale": 1, "approved": 2, "current": 3}
    parsed = [parse_document(path, corpus, 0) for path in paths]
    parsed.sort(
        key=lambda item: (
            item.reference_time,
            status_order.get(str(item.metadata.get("status")), 2),
            item.relative_path,
        )
    )
    # Preserve deterministic ordering among documents sharing a validity date.
    for index, item in enumerate(parsed):
        item.reference_time = item.reference_time.replace(second=index % 60)
    return parsed


def load_questions(corpus: Path, source_prefix: str) -> list[dict[str, Any]]:
    parts = Path(source_prefix).parts
    if len(parts) < 4:
        raise ValueError("source prefix must include sources/<industry>/<department>/<intent>")
    industry, department, intent = parts[1], parts[2], parts[3]
    question_path = corpus / "evaluation/questions.jsonl"
    questions = []
    for line in question_path.read_text(encoding="utf-8").splitlines():
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


def source_evidence(document: SourceDocument) -> list[dict[str, str]]:
    return [
        {
            "source": document.relative_path,
            "section": section["section"],
            "text": section["text"],
            "retrieval_text": section["text"],
        }
        for section in document.sections
    ]


def temporal_edge_is_current(edge: Any, as_of: datetime) -> bool:
    if edge.valid_at is not None and edge.valid_at > as_of:
        return False
    if edge.invalid_at is not None and edge.invalid_at <= as_of:
        return False
    if edge.expired_at is not None:
        return False
    return True


async def database_counts(graphiti: Graphiti) -> dict[str, int]:
    records, _, _ = await graphiti.driver.execute_query(
        """
        MATCH (n)
        WITH count(n) AS nodes
        MATCH ()-[r]->()
        RETURN nodes, count(r) AS relationships
        """,
        routing_="r",
    )
    if not records:
        return {"nodes": 0, "relationships": 0}
    return {
        "nodes": int(records[0]["nodes"]),
        "relationships": int(records[0]["relationships"]),
    }


async def episode_exists(graphiti: Graphiti, episode_name: str) -> bool:
    records, _, _ = await graphiti.driver.execute_query(
        "MATCH (e:Episodic {name: $name}) RETURN count(e) AS count",
        name=episode_name,
        routing_="r",
    )
    return bool(records and int(records[0]["count"]) > 0)


async def ingest(
    graphiti: Graphiti,
    documents: list[SourceDocument],
    output: Path,
    reset: bool,
) -> dict[str, Any]:
    before = await database_counts(graphiti)
    if reset:
        # The configured Neo4j instance is dedicated to this benchmark.  Refuse
        # to erase a non-empty graph unless reset was explicitly requested.
        await clear_data(graphiti.driver, [GRAPHITI_GROUP_ID])
    elif before["nodes"] and not all(
        [await episode_exists(graphiti, document.relative_path) for document in documents]
    ):
        raise RuntimeError(
            "Neo4j contains a partial or unrelated graph; rerun with --reset only on the dedicated evaluation database"
        )

    progress_path = output / "ingestion-progress.jsonl"
    completed = 0
    skipped = 0
    started = time.perf_counter()
    for index, document in enumerate(documents, start=1):
        if await episode_exists(graphiti, document.relative_path):
            skipped += 1
            continue
        episode_started = time.perf_counter()
        result = await graphiti.add_episode(
            name=document.relative_path,
            episode_body=source_payload(document),
            source=EpisodeType.text,
            source_description=(
                "Fragrach P1 benchmark enterprise document; "
                f"document_id={document.metadata.get('document_id', '')}; "
                f"title={document.metadata.get('title', '')}"
            ),
            reference_time=document.reference_time,
            group_id=GRAPHITI_GROUP_ID,
            custom_extraction_instructions=CUSTOM_EXTRACTION_INSTRUCTIONS,
            entity_types=ENTITY_TYPES,
        )
        completed += 1
        row = {
            "index": index,
            "source": document.relative_path,
            "episode_uuid": result.episode.uuid,
            "nodes": len(result.nodes),
            "edges": len(result.edges),
            "elapsed_ms": round((time.perf_counter() - episode_started) * 1000),
        }
        with progress_path.open("a", encoding="utf-8", newline="\n") as handle:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
        print(
            f"[{index}/{len(documents)}] {document.relative_path}: "
            f"{row['nodes']} nodes, {row['edges']} edges, {row['elapsed_ms']} ms",
            flush=True,
        )

    usage = graphiti.token_tracker.get_total_usage()
    return {
        "documents": len(documents),
        "completed": completed,
        "skipped": skipped,
        "duration_ms": round((time.perf_counter() - started) * 1000),
        "usage": asdict(usage),
        "database_before": before,
        "database_after": await database_counts(graphiti),
    }


async def search(
    graphiti: Graphiti,
    documents: list[SourceDocument],
    questions: list[dict[str, Any]],
    top_k: int,
) -> list[dict[str, Any]]:
    by_source = {document.relative_path: document for document in documents}
    rows: list[dict[str, Any]] = []
    for index, question in enumerate(questions, start=1):
        started = time.perf_counter()
        # Fetch a wider pool so the temporal adapter can remove invalidated facts
        # without changing Graphiti's underlying edge-hybrid ranking.
        edges = await graphiti.search(
            question["question"],
            group_ids=[GRAPHITI_GROUP_ID],
            num_results=max(50, top_k),
        )
        episode_ids = list(dict.fromkeys(uuid for edge in edges for uuid in edge.episodes))
        episodes = await EpisodicNode.get_by_uuids(graphiti.driver, episode_ids)
        episode_names = {episode.uuid: episode.name for episode in episodes}

        def unit(edge: Any, rank: int) -> dict[str, Any]:
            source_documents = [
                by_source[episode_names[episode_uuid]]
                for episode_uuid in edge.episodes
                if episode_names.get(episode_uuid) in by_source
            ]
            evidence = [
                item
                for document in source_documents
                for item in source_evidence(document)
            ]
            return {
                "rank": rank,
                "score": 1 / rank,
                "id": edge.uuid,
                "unit_type": "graph_fact",
                "fact": edge.fact,
                "relation": edge.name,
                "valid_at": edge.valid_at.isoformat() if edge.valid_at else None,
                "invalid_at": edge.invalid_at.isoformat() if edge.invalid_at else None,
                "expired_at": edge.expired_at.isoformat() if edge.expired_at else None,
                "episode_ids": edge.episodes,
                "episode_names": [episode_names.get(value, value) for value in edge.episodes],
                "evidence": evidence,
                # A usable RAG adapter returns the extracted fact together with
                # the raw episode excerpts to which Graphiti provides provenance.
                "retrieval_text": "\n\n".join(
                    [edge.fact, *[item["text"] for item in evidence]]
                ),
                "text": edge.fact,
            }

        history_units = [unit(edge, rank) for rank, edge in enumerate(edges[:top_k], start=1)]
        as_of = datetime.fromisoformat(question["as_of"]).replace(tzinfo=timezone.utc)
        current_edges = [edge for edge in edges if temporal_edge_is_current(edge, as_of)][:top_k]
        current_units = [unit(edge, rank) for rank, edge in enumerate(current_edges, start=1)]
        elapsed_ms = round((time.perf_counter() - started) * 1000)
        for condition, retrieved_units in (
            ("graphiti_edge_hybrid_history", history_units),
            ("graphiti_edge_hybrid_current", current_units),
        ):
            rows.append(
                {
                    "condition": condition,
                    "question_id": question["id"],
                    "question": question["question"],
                    "as_of": question["as_of"],
                    "elapsed_ms": elapsed_ms,
                    "retrieved_units": retrieved_units,
                }
            )
        print(
            f"[search {index}/{len(questions)}] {question['id']}: "
            f"history={len(history_units)}, current={len(current_units)}, {elapsed_ms} ms",
            flush=True,
        )
    return rows


def git_commit(path: Path) -> str | None:
    try:
        return subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=path, text=True
        ).strip()
    except (OSError, subprocess.CalledProcessError):
        return None


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


async def run(options: argparse.Namespace) -> None:
    logging.basicConfig(
        level=getattr(logging, options.log_level.upper()),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    if options.ingest_only and options.search_only:
        raise ValueError("--ingest-only and --search-only cannot be combined")
    corpus = options.corpus.resolve()
    output = options.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    credentials = load_env(options.credentials.resolve())
    documents = load_documents(corpus, options.source_prefix)
    if options.max_documents is not None:
        if options.max_documents < 1:
            raise ValueError("--max-documents must be at least 1")
        documents = documents[: options.max_documents]
    questions = load_questions(corpus, options.source_prefix)
    if not documents or not questions:
        raise ValueError("benchmark source documents or questions are empty")

    llm_config = LLMConfig(
        api_key="ollama",
        model=options.llm_model,
        small_model=options.llm_model,
        base_url=options.ollama_url,
        temperature=0,
        max_tokens=16384,
    )
    if options.llm_provider == "codex-app-server":
        llm_client = CodexAppServerClient(
            config=llm_config,
            bridge=options.codex_bridge.resolve(),
            codex_command=options.codex_command,
            reasoning_effort=options.reasoning_effort,
            cwd=Path.cwd().resolve(),
            timeout_seconds=options.llm_timeout_seconds,
        )
    else:
        llm_client = TrackedOllamaClient(
            config=llm_config,
            max_tokens=16384,
            structured_output_mode="json_schema",
        )
    embedder = OpenAIEmbedder(
        config=OpenAIEmbedderConfig(
            api_key="ollama",
            embedding_model=options.embedding_model,
            embedding_dim=768,
            base_url=options.ollama_url,
        )
    )
    graphiti = Graphiti(
        credentials["NEO4J_URI"],
        credentials["NEO4J_USER"],
        credentials["NEO4J_PASSWORD"],
        llm_client=llm_client,
        embedder=embedder,
        cross_encoder=OpenAIRerankerClient(client=llm_client, config=llm_config),
        max_coroutines=1,
    )
    started_at = datetime.now(timezone.utc)
    try:
        # Neo4jDriver schedules index creation when it is constructed. Await
        # that task instead of issuing the same CREATE statements concurrently.
        init_task = getattr(graphiti.driver, "_init_task", None)
        if init_task is not None:
            await init_task
        else:
            await graphiti.build_indices_and_constraints()
        ingestion = None
        if not options.search_only:
            ingestion = await ingest(graphiti, documents, output, options.reset)
            (output / "ingestion.json").write_text(
                json.dumps(ingestion, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
        rows: list[dict[str, Any]] = []
        if not options.ingest_only:
            rows = await search(graphiti, documents, questions, options.top_k)
            (output / "retrieval.jsonl").write_text(
                "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows),
                encoding="utf-8",
            )
        completed_at = datetime.now(timezone.utc)
        manifest = {
            "schema_version": "1.0",
            "experiment": "graphiti-p1-retrieval",
            "status": "completed",
            "started_at": started_at.isoformat(),
            "completed_at": completed_at.isoformat(),
            "duration_ms": round((completed_at - started_at).total_seconds() * 1000),
            "graphiti_version": "0.29.3",
            "graphiti_commit": git_commit(Path(r"D:\tools\fragrach\graphiti-src")),
            "neo4j": {"uri": credentials["NEO4J_URI"], "database": GRAPHITI_GROUP_ID},
            "llm_provider": options.llm_provider,
            "llm_model": options.llm_model,
            "reasoning_effort": (
                options.reasoning_effort
                if options.llm_provider == "codex-app-server"
                else None
            ),
            "embedding_model": options.embedding_model,
            "embedding_dim": 768,
            "structured_output_mode": "json_schema",
            "max_coroutines": 1,
            "source_prefix": options.source_prefix,
            "documents": len(documents),
            "max_documents": options.max_documents,
            "questions": len(questions),
            "top_k": options.top_k,
            "custom_extraction_instructions": CUSTOM_EXTRACTION_INSTRUCTIONS,
            "inputs": {
                "questions_sha256": sha256_file(corpus / "evaluation/questions.jsonl"),
                "documents": {
                    document.relative_path: sha256_file(document.path) for document in documents
                },
            },
            "ingestion": ingestion,
            "llm_calls": getattr(llm_client, "call_count", None),
            "llm_duration_ms": getattr(llm_client, "duration_ms", None),
        }
        (output / "manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    finally:
        await graphiti.close()
        if isinstance(llm_client, CodexAppServerClient):
            llm_client.close_bridge()


def main() -> None:
    options = parse_args()
    asyncio.run(run(options))


if __name__ == "__main__":
    main()
