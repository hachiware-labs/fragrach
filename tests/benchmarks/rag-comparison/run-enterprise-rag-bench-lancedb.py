#!/usr/bin/env python
"""Evaluate full-corpus Ruri Dense and development-tuned Hybrid retrieval in LanceDB."""

from __future__ import annotations

import argparse
import json
import re
import time
from collections import defaultdict
from pathlib import Path

import lancedb
import numpy as np
import tantivy


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--table", default="enterprise_rag_bench_ruri")
    parser.add_argument("--vectors", type=Path, required=True)
    parser.add_argument("--questions", type=Path, required=True)
    parser.add_argument("--gold-documents", type=Path, required=True)
    parser.add_argument("--bm25", type=Path)
    parser.add_argument("--tantivy-index", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--category", action="append", dest="categories")
    parser.add_argument("--dense-only", action="store_true")
    parser.add_argument("--candidate-k", type=int, default=50)
    parser.add_argument("--chunk-oversample", type=int, default=10)
    parser.add_argument("--mode", choices=("flat", "ann"), default="flat")
    parser.add_argument("--nprobes", type=int, default=20)
    parser.add_argument("--refine-factor", type=int)
    parser.add_argument("--allow-partial", action="store_true")
    return parser.parse_args()


def read_jsonl(file: Path) -> list[dict]:
    return [json.loads(line) for line in file.read_text(encoding="utf-8").splitlines() if line]


def fact_coverage(fact: str, text: str) -> float:
    expected = set(re.findall(r"[a-z0-9]+", fact.lower()))
    actual = set(re.findall(r"[a-z0-9]+", text.lower()))
    return len(expected & actual) / max(len(expected), 1)


def summarize(questions: list[dict], retrieval: dict[str, list[dict]], gold_documents: dict[str, dict], k: int) -> dict:
    mapped = [
        question for question in questions
        if question["gold_status"] in {"verified", "disputed"} and question["gold_evidence"]["sources"]
    ]
    verified = [
        question for question in questions
        if question["gold_status"] == "verified" and question["gold_evidence"]["units"]
    ]
    document_recalls = []
    document_complete = 0
    for question in mapped:
        expected = set(question["gold_evidence"]["sources"])
        found = {row["doc_id"] for row in retrieval.get(question["id"], [])[:k]}
        hits = len(expected & found)
        document_recalls.append(hits / len(expected))
        document_complete += hits == len(expected)
    evidence_recalls = []
    evidence_complete = 0
    for question in verified:
        found = {row["doc_id"] for row in retrieval.get(question["id"], [])[:k]}
        hits = 0
        for unit in question["gold_evidence"]["units"]:
            document = gold_documents.get(unit["source"])
            material = "" if unit["source"] not in found or document is None else f"{document['title']}\n\n{document['content']}"
            hits += fact_coverage(unit["fact"], material) >= 0.5
        evidence_recalls.append(hits / len(question["gold_evidence"]["units"]))
        evidence_complete += hits == len(question["gold_evidence"]["units"])
    return {
        "document_questions": len(mapped),
        "document_recall_at_k": sum(document_recalls) / max(len(document_recalls), 1),
        "document_complete_at_k": document_complete / max(len(mapped), 1),
        "evidence_questions": len(verified),
        "evidence_unit_recall_at_k": sum(evidence_recalls) / max(len(evidence_recalls), 1),
        "evidence_ceiling_at_k": evidence_complete / max(len(verified), 1),
    }


def rrf(sparse: list[dict], dense: list[dict], sparse_weight: float, candidate_k: int) -> list[dict]:
    documents = {}
    scores = defaultdict(float)
    provenance = defaultdict(list)
    for source, rows, weight in (("bm25", sparse, sparse_weight), ("ruri", dense, 1 - sparse_weight)):
        for rank, row in enumerate(rows[:candidate_k], start=1):
            doc_id = row["doc_id"]
            documents[doc_id] = row
            scores[doc_id] += weight / (60 + rank)
            provenance[doc_id].append({"source": source, "rank": rank})
    ranked = sorted(documents, key=lambda doc_id: (-scores[doc_id], doc_id))
    return [
        {
            **documents[doc_id],
            "score": scores[doc_id],
            "retrieval_provenance": provenance[doc_id],
        }
        for doc_id in ranked[:candidate_k]
    ]


def hydrate(searcher, index, doc_ids: set[str]) -> dict[str, dict]:
    documents = {}
    for position, doc_id in enumerate(sorted(doc_ids), start=1):
        query = index.parse_query(doc_id, ["doc_id"])
        result = searcher.search(query, limit=1)
        if not result.hits:
            raise KeyError(f"document missing from Tantivy index: {doc_id}")
        stored = searcher.doc(result.hits[0][1]).to_dict()
        documents[doc_id] = {
            "doc_id": stored["doc_id"][0],
            "source_type": stored["source_type"][0],
            "title": stored["title"][0],
            "content": stored["content"][0],
        }
        if position % 1000 == 0:
            print(json.dumps({"hydrated": position, "total": len(doc_ids)}), flush=True)
    return documents


def main() -> None:
    options = parse_args()
    if not options.dense_only and options.bm25 is None:
        raise ValueError("--bm25 is required unless --dense-only is selected")
    if options.output.exists():
        raise FileExistsError(f"output already exists: {options.output}")
    state = json.loads((options.database / "fragrach-ingest-state.json").read_text(encoding="utf-8"))
    if not state.get("complete") and not options.allow_partial:
        raise RuntimeError(
            f"LanceDB corpus is incomplete: {state.get('loaded_documents')}/{state.get('expected_documents')} documents"
        )
    questions = [
        row for row in read_jsonl(options.questions)
        if row["split"] in {"development", "diagnostic"}
        and (not options.categories or row["category"] in options.categories)
    ]
    question_by_id = {row["id"]: row for row in questions}
    gold_documents = {row["doc_id"]: row for row in read_jsonl(options.gold_documents)}
    query_manifest = json.loads((options.vectors / "queries.json").read_text(encoding="utf-8"))
    if query_manifest["model"] != state["model"] or query_manifest["dimensions"] != state["dimensions"]:
        raise ValueError("query and document embeddings use different contracts")
    query_indexes = {question_id: index for index, question_id in enumerate(query_manifest["question_ids"])}
    missing_query_vectors = set(question_by_id) - set(query_indexes)
    if missing_query_vectors:
        raise ValueError(f"query vectors are missing for: {sorted(missing_query_vectors)}")
    query_vectors = np.memmap(
        options.vectors / "queries.f32",
        dtype=np.float32,
        mode="r",
        shape=(query_manifest["rows"], query_manifest["dimensions"]),
    )
    bm25 = {}
    if not options.dense_only:
        bm25_rows = [row for row in read_jsonl(options.bm25) if row["question_id"] in question_by_id]
        bm25 = {row["question_id"]: row["results"][:options.candidate_k] for row in bm25_rows}
        missing_bm25 = set(question_by_id) - set(bm25)
        if missing_bm25:
            raise ValueError(f"BM25 results are missing for: {sorted(missing_bm25)}")

    database = lancedb.connect(str(options.database))
    table = database.open_table(options.table)
    chunked = "unit_id" in table.schema.names
    dense = {}
    latencies = []
    for index, question in enumerate(questions):
        started = time.perf_counter()
        selected_columns = ["doc_id", "_distance"]
        if chunked:
            selected_columns = ["row_id", "unit_id", "doc_id", "chunk_index", "_distance"]
        query = (
            table.search(query_vectors[query_indexes[question["id"]]], vector_column_name="vector")
            .distance_type("cosine")
            .limit(options.candidate_k * options.chunk_oversample if chunked else options.candidate_k)
            .select(selected_columns)
        )
        if options.mode == "flat":
            query = query.bypass_vector_index()
        else:
            query = query.nprobes(options.nprobes)
            if options.refine_factor is not None:
                query = query.refine_factor(options.refine_factor)
        rows = query.to_arrow().to_pylist()
        latencies.append(time.perf_counter() - started)
        unique_documents = []
        seen_documents = set()
        for row in rows:
            if row["doc_id"] in seen_documents:
                continue
            seen_documents.add(row["doc_id"])
            unique_documents.append({
                "doc_id": row["doc_id"],
                "score": -float(row["_distance"]),
                **({
                    "dense_unit_id": row["unit_id"],
                    "dense_chunk_index": row["chunk_index"],
                } if chunked else {}),
            })
            if len(unique_documents) == options.candidate_k:
                break
        dense[question["id"]] = unique_documents
        if (index + 1) % 25 == 0:
            print(json.dumps({
                "searched": index + 1,
                "total": len(questions),
                "mean_latency_ms": 1000 * sum(latencies) / len(latencies),
            }), flush=True)

    development = [row for row in questions if row["split"] == "development"]
    diagnostic = [row for row in questions if row["split"] == "diagnostic"]
    development_semantic = [row for row in development if row["category"] == "semantic"]
    candidates = []
    selected = None
    if options.dense_only:
        conditions = {f"ruri-dense-{options.mode}": dense}
    else:
        for sparse_weight in (0.0, 0.25, 0.5, 0.75, 1.0):
            retrieval = {
                question["id"]: rrf(bm25[question["id"]], dense[question["id"]], sparse_weight, options.candidate_k)
                for question in questions
            }
            candidates.append({
                "sparse_weight": sparse_weight,
                "retrieval": retrieval,
                "development": summarize(development, retrieval, gold_documents, 10),
                "development_semantic": summarize(development_semantic, retrieval, gold_documents, 10),
            })
        candidates.sort(key=lambda row: (
            -row["development"]["evidence_ceiling_at_k"],
            -row["development"]["evidence_unit_recall_at_k"],
            -row["development"]["document_recall_at_k"],
            -row["development_semantic"]["document_recall_at_k"],
            abs(row["sparse_weight"] - 0.5),
        ))
        selected = candidates[0]
        conditions = {
            "bm25-full-corpus": bm25,
            f"ruri-full-corpus-{options.mode}": dense,
            f"hybrid-rrf-sparse-{selected['sparse_weight']:.2f}": selected["retrieval"],
        }

    selected_doc_ids = {
        row["doc_id"]
        for retrieval in conditions.values()
        for question in questions
        for row in retrieval[question["id"]][:10]
    }
    tantivy_index = tantivy.Index.open(str(options.tantivy_index))
    hydrated = hydrate(tantivy_index.searcher(), tantivy_index, selected_doc_ids)
    by_category = defaultdict(list)
    for question in questions:
        by_category[question["category"]].append(question)
    report = {
        "schema_version": "1.0",
        "experiment": (
            "enterprise-rag-bench-lancedb-dense-pilot"
            if options.dense_only else "enterprise-rag-bench-lancedb-full-corpus-ruri"
        ),
        "corpus": state,
        "embedding": query_manifest,
        "dense_search": {
            "engine": f"LanceDB {lancedb.__version__}",
            "mode": options.mode,
            "contract": (
                "flat exhaustive cosine search" if options.mode == "flat"
                else f"ANN cosine search with nprobes={options.nprobes}, refine_factor={options.refine_factor}"
            ),
            "candidate_k": options.candidate_k,
            "chunked": chunked,
            "chunk_oversample": options.chunk_oversample if chunked else 1,
            "mean_latency_ms": 1000 * sum(latencies) / len(latencies),
            "p95_latency_ms": 1000 * float(np.percentile(latencies, 95)),
        },
        "question_selection": {
            "splits": ["development", "diagnostic"],
            "categories": options.categories or "all",
            "questions": len(questions),
        },
        "tuning": None if options.dense_only else {
            "selected_sparse_weight": selected["sparse_weight"],
            "selection_contract": (
                "Development only: Evidence Ceiling, Evidence Unit Recall, document recall, then semantic document recall; "
                "ties prefer the weight nearest 0.5."
            ),
            "candidates": [
                {key: value for key, value in row.items() if key != "retrieval"}
                for row in candidates
            ],
        },
        "conditions": {
            name: {
                "development": summarize(development, retrieval, gold_documents, 10),
                "diagnostic": summarize(diagnostic, retrieval, gold_documents, 10),
                "semantic_development": summarize(
                    [row for row in development if row["category"] == "semantic"], retrieval, gold_documents, 10
                ),
                "semantic_diagnostic": summarize(
                    [row for row in diagnostic if row["category"] == "semantic"], retrieval, gold_documents, 10
                ),
                "by_category": {
                    category: summarize(rows, retrieval, gold_documents, 10)
                    for category, rows in by_category.items()
                },
            }
            for name, retrieval in conditions.items()
        },
        "holdout_status": "reserved and untouched",
    }
    options.output.mkdir(parents=True)
    with (options.output / "retrieval.jsonl").open("w", encoding="utf-8") as handle:
        for name, retrieval in conditions.items():
            for question in questions:
                results = []
                for rank, row in enumerate(retrieval[question["id"]][:10], start=1):
                    document = hydrated[row["doc_id"]]
                    results.append({
                        **row,
                        **document,
                        "rank": rank,
                    })
                handle.write(json.dumps({
                    "condition": name,
                    "question_id": question["id"],
                    "split": question["split"],
                    "category": question["category"],
                    "results": results,
                }, ensure_ascii=False) + "\n")
    (options.output / "report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
