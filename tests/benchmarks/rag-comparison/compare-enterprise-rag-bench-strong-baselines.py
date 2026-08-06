#!/usr/bin/env python
"""Compare Fragrach with full and context-budget-matched strong Vanilla RAG."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path


GOLD = "gold-context"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-answers", type=Path)
    parser.add_argument("--checklist-answers", type=Path)
    parser.add_argument("--vanilla-report", type=Path, required=True)
    parser.add_argument("--fragrach-report", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def read_jsonl(file: Path) -> list[dict]:
    return [json.loads(line) for line in file.read_text(encoding="utf-8").splitlines() if line]


def read_json(file: Path) -> dict:
    return json.loads(file.read_text(encoding="utf-8"))


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


def exact_mcnemar_p(left_only: int, right_only: int) -> float:
    discordant = left_only + right_only
    if discordant == 0:
        return 1.0
    lower = min(left_only, right_only)
    tail = sum(math.comb(discordant, index) for index in range(lower + 1)) / (2 ** discordant)
    return min(1.0, 2 * tail)


def paired(left: dict[str, dict], right: dict[str, dict]) -> dict:
    left_only = []
    right_only = []
    evidence_left_only = []
    evidence_right_only = []
    for question_id in sorted(left):
        left_strict = left[question_id]["answer_correct"] and left[question_id]["evidence_complete"]
        right_strict = right[question_id]["answer_correct"] and right[question_id]["evidence_complete"]
        if left_strict and not right_strict:
            left_only.append(question_id)
        if right_strict and not left_strict:
            right_only.append(question_id)
        if left[question_id]["evidence_complete"] and not right[question_id]["evidence_complete"]:
            evidence_left_only.append(question_id)
        if right[question_id]["evidence_complete"] and not left[question_id]["evidence_complete"]:
            evidence_right_only.append(question_id)
    return {
        "strict_left_only": left_only,
        "strict_right_only": right_only,
        "strict_net_left_minus_right": len(left_only) - len(right_only),
        "exact_mcnemar_two_sided_p": exact_mcnemar_p(len(left_only), len(right_only)),
        "evidence_left_only": evidence_left_only,
        "evidence_right_only": evidence_right_only,
    }


def main() -> None:
    options = parse_args()
    if options.output.exists():
        raise FileExistsError(f"output already exists: {options.output}")
    runs = {}
    if options.base_answers is not None:
        runs["base"] = read_jsonl(options.base_answers)
    if options.checklist_answers is not None:
        runs["position_checklist"] = read_jsonl(options.checklist_answers)
    if not runs:
        raise ValueError("at least one of --base-answers or --checklist-answers is required")
    vanilla_report = read_json(options.vanilla_report)
    fragrach_report = read_json(options.fragrach_report)
    budget = vanilla_report["budget_condition"]
    full = vanilla_report["full_condition"]
    fragrach = fragrach_report["output_condition"]
    conditions = (budget, fragrach, full, GOLD)
    report_runs = {}
    for run_name, rows in runs.items():
        indexed = {
            condition: {row["question_id"]: row for row in rows if row["condition"] == condition}
            for condition in conditions
        }
        if any(len(values) != 91 for values in indexed.values()):
            raise ValueError(f"run does not contain 91 rows per condition: {run_name}")
        report_runs[run_name] = {
            "conditions": {condition: summarize(list(indexed[condition].values())) for condition in conditions},
            "fragrach_vs_budget": paired(indexed[fragrach], indexed[budget]),
            "fragrach_vs_full": paired(indexed[fragrach], indexed[full]),
        }

    selected = vanilla_report["selected_budget_policy"]
    report = {
        "schema_version": "1.0",
        "experiment": "enterprise-rag-bench-strong-vanilla-comparison",
        "retrieval_condition": vanilla_report["retrieval_condition"],
        "condition_names": {"budget": budget, "fragrach": fragrach, "full": full, "gold": GOLD},
        "comparison_contract": "All conditions use the same selected-retriever top-10 document IDs, Luna, answer budget, semantic judge, and reader contract within each run. Budget Vanilla is selected on development under the Fragrach mean-character budget using question-only compression. Diagnostic is not used for material selection.",
        "context_characters": {
            budget: vanilla_report["candidate_matrix"][selected]["mean_characters"],
            fragrach: fragrach_report["candidate_matrix"][fragrach_report["selected_policy"]]["mean_characters"],
            full: vanilla_report["full"]["mean_characters"],
        },
        "runs": report_runs,
        "interpretation": "Use the paired diagnostic results to judge whether Fragrach improves DVAA-Gross over development-tuned Budget Vanilla and Full Vanilla under the selected strongest retrieval condition. Do not generalize beyond this diagnostic or inspect holdout before freezing the system.",
    }
    options.output.mkdir(parents=True)
    (options.output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
