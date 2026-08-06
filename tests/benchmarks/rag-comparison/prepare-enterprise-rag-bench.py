#!/usr/bin/env python
"""Prepare deterministic splits and audit EnterpriseRAG-Bench Gold evidence."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from collections import Counter, defaultdict
from pathlib import Path

import pyarrow.parquet as pq


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--questions", type=Path, required=True)
    parser.add_argument("--documents", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def tokens(value: str) -> set[str]:
    return set(re.findall(r"[a-z0-9]+", value.lower()))


def fact_coverage(fact: str, text: str) -> float:
    expected = tokens(fact)
    if not expected:
        return 0.0
    return len(expected & tokens(text)) / len(expected)


def assigned_splits(questions: list[dict]) -> dict[str, str]:
    grouped: dict[str, list[dict]] = defaultdict(list)
    for question in questions:
        grouped[question["question_type"]].append(question)
    result: dict[str, str] = {}
    for rows in grouped.values():
        rows.sort(key=lambda row: hashlib.sha256(row["question_id"].encode()).hexdigest())
        width = len(rows) // 5
        for index, row in enumerate(rows):
            split = "development" if index < width else "diagnostic" if index < width * 2 else "holdout" if index < width * 3 else "reserve"
            result[row["question_id"]] = split
    return result


def main() -> None:
    options = parse_args()
    questions = [json.loads(line) for line in options.questions.read_text(encoding="utf-8").splitlines() if line]
    splits = assigned_splits(questions)
    required_ids = {doc_id for question in questions for doc_id in question.get("expected_doc_ids", [])}
    required_documents: dict[str, dict] = {}
    parquet = pq.ParquetFile(options.documents)
    corpus_rows = 0
    for batch in parquet.iter_batches(batch_size=4096, columns=["doc_id", "source_type", "title", "content"]):
        for row in batch.to_pylist():
            corpus_rows += 1
            if row["doc_id"] in required_ids:
                required_documents[row["doc_id"]] = row

    prepared = []
    defects = Counter()
    coverage_values: list[float] = []
    for question in questions:
        expected_ids = question.get("expected_doc_ids", [])
        facts = question.get("answer_facts", [])
        missing = [doc_id for doc_id in expected_ids if doc_id not in required_documents]
        units = []
        weak_facts = []
        for fact in facts:
            candidates = []
            for doc_id in expected_ids:
                document = required_documents.get(doc_id)
                if not document:
                    continue
                text = f"{document.get('title') or ''}\n\n{document.get('content') or ''}"
                candidates.append((fact_coverage(fact, text), doc_id))
            coverage, source = max(candidates, default=(0.0, None))
            coverage_values.append(coverage)
            if coverage < 0.5 or source is None:
                weak_facts.append({"fact": fact, "best_coverage": coverage, "best_source": source})
            else:
                units.append({"type": "source_span", "source": source, "fact": fact, "fact_token_coverage": coverage})

        question_defects = []
        if missing:
            question_defects.append({"type": "missing_expected_documents", "document_ids": missing})
            defects["missing_expected_documents"] += 1
        if weak_facts:
            question_defects.append({"type": "answer_fact_not_supported_by_expected_documents", "facts": weak_facts})
            defects["answer_fact_not_supported_by_expected_documents"] += 1
        if not expected_ids and question["question_type"] == "info_not_found":
            gold_status = "null"
        elif not expected_ids:
            gold_status = "unmapped"
            question_defects.append({"type": "no_expected_documents"})
            defects["no_expected_documents"] += 1
        elif question_defects:
            gold_status = "disputed"
        else:
            gold_status = "verified"
        prepared.append({
            "id": question["question_id"],
            "category": question["question_type"],
            "source_types": question.get("source_types", []),
            "question": question["question"],
            "answer": question["gold_answer"],
            "split": splits[question["question_id"]],
            "gold_status": gold_status,
            "gold_defects": question_defects,
            "gold_evidence": {"sources": expected_ids, "units": units},
            "answer_facts": facts,
        })

    options.output.mkdir(parents=True, exist_ok=True)
    with (options.output / "questions.jsonl").open("w", encoding="utf-8") as handle:
        for row in prepared:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    with (options.output / "gold-documents.jsonl").open("w", encoding="utf-8") as handle:
        for doc_id in sorted(required_documents):
            handle.write(json.dumps(required_documents[doc_id], ensure_ascii=False) + "\n")
    report = {
        "schema_version": "1.0",
        "source_questions": str(options.questions),
        "source_documents": str(options.documents),
        "corpus_documents": corpus_rows,
        "questions": len(prepared),
        "by_split": Counter(row["split"] for row in prepared),
        "by_category": Counter(row["category"] for row in prepared),
        "by_gold_status": Counter(row["gold_status"] for row in prepared),
        "required_document_ids": len(required_ids),
        "required_documents_found": len(required_documents),
        "defects": defects,
        "fact_coverage": {
            "facts": len(coverage_values),
            "below_0_5": sum(value < 0.5 for value in coverage_values),
            "mean": sum(coverage_values) / max(len(coverage_values), 1),
        },
    }
    (options.output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
