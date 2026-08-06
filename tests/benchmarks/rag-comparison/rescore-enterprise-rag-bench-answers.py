#!/usr/bin/env python
"""Rescore completed Enterprise answer runs with the source-local evidence contract."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from enterprise_rag_bench_metrics import LocalEvidenceScorer


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--answers", type=Path, required=True)
    parser.add_argument("--dossiers", type=Path, action="append", required=True)
    parser.add_argument("--questions", type=Path, required=True)
    parser.add_argument("--gold-documents", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def read_jsonl(file: Path) -> list[dict]:
    return [json.loads(line) for line in file.read_text(encoding="utf-8").splitlines() if line]


def summarize(rows: list[dict]) -> dict:
    correct = sum(row["answer_correct"] for row in rows)
    complete = sum(row["evidence_complete"] for row in rows)
    strict = sum(row["answer_correct"] and row["evidence_complete"] for row in rows)
    return {
        "questions": len(rows),
        "answer_accuracy": correct / max(len(rows), 1),
        "evidence_ceiling": complete / max(len(rows), 1),
        "dvaa_gross": strict / max(len(rows), 1),
        "dvaa_net": None if complete == 0 else strict / complete,
        "counts": {"answer_correct": correct, "evidence_complete": complete, "strict": strict},
    }


def main() -> None:
    options = parse_args()
    if options.output.exists():
        raise FileExistsError(f"output already exists: {options.output}")
    evaluation_questions = [
        row for row in read_jsonl(options.questions)
        if row["split"] in {"development", "diagnostic"}
        and row["gold_status"] == "verified" and row["gold_evidence"]["units"]
    ]
    questions = {row["id"]: row for row in evaluation_questions if row["split"] == "diagnostic"}
    dossiers = {
        (row["condition"], row["question_id"]): row["results"][0]
        for dossier_file in options.dossiers
        for row in read_jsonl(dossier_file)
    }
    gold_documents = {row["doc_id"]: row["content"] for row in read_jsonl(options.gold_documents)}
    # IDF is fixed over the declared development+diagnostic evaluation population,
    # so a condition receives the same score whether splits are reported together
    # or diagnostic is rescored later.
    scorer = LocalEvidenceScorer(evaluation_questions, gold_documents)
    rows = read_jsonl(options.answers)
    for row in rows:
        question = questions[row["question_id"]]
        row["evidence_complete"] = (
            True if row["condition"] == "gold-context"
            else scorer.question_complete(question, dossiers[(row["condition"], row["question_id"])]["source_texts"])
        )

    conditions = {}
    for condition in sorted({row["condition"] for row in rows}):
        selected = [row for row in rows if row["condition"] == condition]
        conditions[condition] = {
            "overall": summarize(selected),
            "by_category": {
                category: summarize([row for row in selected if row["category"] == category])
                for category in sorted({row["category"] for row in selected})
            },
        }
    report = {
        "schema_version": "2.0",
        "experiment": "enterprise-rag-bench-diagnostic-dvaa-source-local",
        "model": "gpt-5.6-luna",
        "population": "91 diagnostic questions with audited verified Gold; disputed, unmapped, null, development, and holdout questions excluded.",
        "answer_scoring": "Previously completed independent Luna semantic judgment: every answer_facts item expressed and no contradiction.",
        "evidence_scoring": "One 256-token source-local window must retain every exact numeric/identifier anchor found in the audited Gold source and at least 80% of that Gold window's IDF-weighted lexical coverage.",
        "dvaa_contract": "Gross = answer correct AND source-local evidence complete / all evaluated questions. Net = same strict passes / source-local evidence-complete questions.",
        "conditions": conditions,
    }
    options.output.mkdir(parents=True)
    with (options.output / "answers.jsonl").open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    (options.output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
