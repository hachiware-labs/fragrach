#!/usr/bin/env python
"""Audit whether EnterpriseRAG-Bench exercises low-lexical-overlap retrieval."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--questions", type=Path, required=True)
    parser.add_argument("--bm25", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def read_jsonl(file: Path) -> list[dict]:
    return [json.loads(line) for line in file.read_text(encoding="utf-8").splitlines() if line]


def coverage(questions: list[dict], retrieval: dict[str, list[dict]], k: int) -> dict:
    rows = []
    for question in questions:
        expected = set(question["gold_evidence"]["sources"])
        found = {row["doc_id"] for row in retrieval.get(question["id"], [])[:k]}
        hits = len(expected & found)
        rows.append({
            "question_id": question["id"],
            "split": question["split"],
            "question": question["question"],
            "gold_documents": sorted(expected),
            "hits": hits,
            "complete": bool(expected) and hits == len(expected),
        })
    return {
        "questions": len(rows),
        "gold_document_hit_questions": sum(row["hits"] > 0 for row in rows),
        "gold_document_complete_questions": sum(row["complete"] for row in rows),
        "misses": [row for row in rows if row["hits"] == 0],
    }


def main() -> None:
    options = parse_args()
    questions = [
        row for row in read_jsonl(options.questions)
        if row["split"] in {"development", "diagnostic"}
    ]
    semantic = [row for row in questions if row["category"] == "semantic"]
    bm25_rows = [row for row in read_jsonl(options.bm25) if row["question_id"] in {q["id"] for q in questions}]
    retrieval = {row["question_id"]: row["results"] for row in bm25_rows}
    report = {
        "schema_version": "1.0",
        "finding": (
            "The benchmark explicitly contains low-lexical-overlap semantic questions, but the existing Ruri run "
            "only reranks each question's BM25 top-50 and therefore cannot test full-corpus Dense retrieval."
        ),
        "benchmark_design_evidence": {
            "methodology": "target/external/enterprise-rag-bench-metadata/methodology.md: semantic questions are designed as challenging loose matches",
            "generation_prompt": (
                "target/external/enterprise-rag-bench-metadata/src/prompts/basic_questions.py: "
                "SEMANTIC_QUERIES_PROMPT avoids strong lexical and exact keyword matches"
            ),
        },
        "scope": {
            "questions": len(questions),
            "semantic_questions": len(semantic),
            "semantic_by_split": {
                split: sum(row["split"] == split for row in semantic)
                for split in ("development", "diagnostic")
            },
        },
        "semantic_bm25_gold_document_coverage": {
            "at_10": coverage(semantic, retrieval, 10),
            "at_50": coverage(semantic, retrieval, 50),
        },
        "interpretation": {
            "candidate_rerank_blind_spot": (
                "A gold document absent from BM25 top-50 is unreachable by the existing Ruri candidate reranker."
            ),
            "required_comparison": (
                "Evaluate BM25 full corpus, Ruri full-corpus Dense, and a development-tuned Hybrid on the same "
                "development/diagnostic questions, reporting semantic separately."
            ),
            "holdout_status": "reserved and untouched",
        },
    }
    options.output.mkdir(parents=True, exist_ok=False)
    (options.output / "report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
