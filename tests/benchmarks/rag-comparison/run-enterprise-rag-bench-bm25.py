#!/usr/bin/env python
"""Run full-corpus EnterpriseRAG-Bench BM25 retrieval and Evidence Unit scoring."""

from __future__ import annotations

import argparse
import json
import re
from collections import defaultdict
from pathlib import Path

import tantivy


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--index", type=Path, required=True)
    parser.add_argument("--questions", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--candidate-k", type=int, default=50)
    return parser.parse_args()


def fact_coverage(fact: str, text: str) -> float:
    expected = set(re.findall(r"[a-z0-9]+", fact.lower()))
    actual = set(re.findall(r"[a-z0-9]+", text.lower()))
    return len(expected & actual) / max(len(expected), 1)


def summarize(questions: list[dict], retrieval: dict[str, list[dict]], k: int) -> dict:
    mapped = [question for question in questions if question["gold_status"] in {"verified", "disputed"} and question["gold_evidence"]["sources"]]
    verified = [question for question in questions if question["gold_status"] == "verified" and question["gold_evidence"]["units"]]
    recalls = []
    document_complete = 0
    for question in mapped:
        expected = set(question["gold_evidence"]["sources"])
        found = {row["doc_id"] for row in retrieval[question["id"]][:k]}
        recalls.append(len(expected & found) / len(expected))
        document_complete += expected <= found
    evidence_recalls = []
    evidence_complete = 0
    for question in verified:
        materials = {row["doc_id"]: f"{row['title']}\n\n{row['content']}" for row in retrieval[question["id"]][:k]}
        hits = sum(fact_coverage(unit["fact"], materials.get(unit["source"], "")) >= 0.5 for unit in question["gold_evidence"]["units"])
        evidence_recalls.append(hits / len(question["gold_evidence"]["units"]))
        evidence_complete += hits == len(question["gold_evidence"]["units"])
    return {
        "document_questions": len(mapped),
        "document_recall_at_k": sum(recalls) / max(len(recalls), 1),
        "document_complete_at_k": document_complete / max(len(mapped), 1),
        "evidence_questions": len(verified),
        "evidence_unit_recall_at_k": sum(evidence_recalls) / max(len(evidence_recalls), 1),
        "evidence_ceiling_at_k": evidence_complete / max(len(verified), 1),
    }


def main() -> None:
    options = parse_args()
    if options.output.exists():
        raise FileExistsError(f"output already exists: {options.output}")
    questions = [json.loads(line) for line in options.questions.read_text(encoding="utf-8").splitlines() if line]
    index = tantivy.Index.open(str(options.index))
    searcher = index.searcher()
    retrieval: dict[str, list[dict]] = {}
    for question in questions:
        query, errors = index.parse_query_lenient(question["question"], ["text"])
        result = searcher.search(query, limit=options.candidate_k)
        rows = []
        for rank, (score, address) in enumerate(result.hits, start=1):
            stored = searcher.doc(address).to_dict()
            rows.append({
                "rank": rank,
                "score": score,
                "doc_id": stored["doc_id"][0],
                "source_type": stored["source_type"][0],
                "title": stored["title"][0],
                "content": stored["content"][0],
            })
        retrieval[question["id"]] = rows

    scored_questions = [question for question in questions if question["split"] in {"development", "diagnostic", "holdout"}]
    by_split = defaultdict(list)
    by_category = defaultdict(list)
    for question in scored_questions:
        by_split[question["split"]].append(question)
        by_category[question["category"]].append(question)
    report = {
        "schema_version": "1.0",
        "experiment": "enterprise-rag-bench-full-corpus-bm25",
        "retrieval_contract": "Tantivy BM25 over title + content, one record per all 511,962 documents; official top-10 evaluation.",
        "candidate_k": options.candidate_k,
        "overall_at_10": summarize(scored_questions, retrieval, 10),
        "by_split_at_10": {key: summarize(rows, retrieval, 10) for key, rows in by_split.items()},
        "by_category_at_10": {key: summarize(rows, retrieval, 10) for key, rows in by_category.items()},
    }
    options.output.mkdir(parents=True)
    with (options.output / "retrieval.jsonl").open("w", encoding="utf-8") as handle:
        for question in questions:
            handle.write(json.dumps({
                "condition": "bm25-full-corpus-top50",
                "question_id": question["id"],
                "split": question["split"],
                "category": question["category"],
                "results": retrieval[question["id"]],
            }, ensure_ascii=False) + "\n")
    (options.output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
