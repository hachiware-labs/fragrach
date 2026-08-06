#!/usr/bin/env python
"""Compare two EnterpriseRAG-Bench reader contracts on identical dossiers."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-answers", type=Path, required=True)
    parser.add_argument("--checklist-answers", type=Path, required=True)
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
        "answer_accuracy": correct / len(rows),
        "evidence_ceiling": complete / len(rows),
        "dvaa_gross": strict / len(rows),
        "dvaa_net": strict / complete if complete else None,
        "counts": {"answer_correct": correct, "evidence_complete": complete, "strict": strict},
    }


def main() -> None:
    options = parse_args()
    if options.output.exists():
        raise FileExistsError(f"output already exists: {options.output}")
    base_rows = read_jsonl(options.base_answers)
    checklist_rows = read_jsonl(options.checklist_answers)
    base = {(row["condition"], row["question_id"]): row for row in base_rows}
    checklist = {(row["condition"], row["question_id"]): row for row in checklist_rows}
    if set(base) != set(checklist):
        raise ValueError("base/checklist row keys differ")
    if any(base[key]["evidence_complete"] != checklist[key]["evidence_complete"] for key in base):
        raise ValueError("reader comparison requires identical Evidence Complete judgments")

    conditions = sorted({condition for condition, _ in base})
    report_conditions = {}
    for condition in conditions:
        keys = sorted(key for key in base if key[0] == condition)
        old = [base[key] for key in keys]
        new = [checklist[key] for key in keys]
        false_to_true = [key[1] for key in keys if not base[key]["answer_correct"] and checklist[key]["answer_correct"]]
        true_to_false = [key[1] for key in keys if base[key]["answer_correct"] and not checklist[key]["answer_correct"]]
        report_conditions[condition] = {
            "base": summarize(old),
            "position_checklist": summarize(new),
            "answer_flips": {
                "false_to_true": false_to_true,
                "true_to_false": true_to_false,
                "net_correct_change": len(false_to_true) - len(true_to_false),
            },
        }

    report = {
        "schema_version": "1.0",
        "experiment": "enterprise-rag-bench-reader-contract-comparison",
        "comparison_contract": "Base and position-checklist readers use byte-identical v7/v8 Position Dossiers, Luna, answer budget, and semantic judge contract. Separate generations remain stochastic; Gold Context is rerun as a control for run-level variation.",
        "evidence_contract": "Source-local 256-token anchored evidence definition with 80% Gold-window-relative IDF-weighted lexical coverage.",
        "conditions": report_conditions,
    }
    options.output.mkdir(parents=True)
    (options.output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
