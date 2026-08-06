#!/usr/bin/env python
"""Create a material-paired comparison of fixed and adaptive Enterprise dossiers."""

from __future__ import annotations

import argparse
import copy
import json
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixed-answers", type=Path, required=True)
    parser.add_argument("--adaptive-answers", type=Path, required=True)
    parser.add_argument("--fixed-dossiers", type=Path, required=True)
    parser.add_argument("--adaptive-dossiers", type=Path, required=True)
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
    fixed_rows = [row for row in read_jsonl(options.fixed_answers) if row["condition"] != "gold-context"]
    adaptive_rows = [row for row in read_jsonl(options.adaptive_answers) if row["condition"] != "gold-context"]
    fixed = {row["question_id"]: row for row in fixed_rows}
    adaptive = {row["question_id"]: row for row in adaptive_rows}
    fixed_material = {row["question_id"]: row["results"][0]["text"] for row in read_jsonl(options.fixed_dossiers)}
    adaptive_material = {row["question_id"]: row["results"][0]["text"] for row in read_jsonl(options.adaptive_dossiers)}
    if set(fixed) != set(adaptive):
        raise ValueError("fixed/adaptive question IDs differ")

    controlled = []
    material_changed = []
    material_unchanged = []
    for question_id in sorted(fixed):
        same_material = fixed_material[question_id] == adaptive_material[question_id]
        if same_material:
            row = copy.deepcopy(fixed[question_id])
            row["evidence_complete"] = adaptive[question_id]["evidence_complete"]
            row["condition"] = "fragrach-enterprise-adaptive-material-paired"
            row["paired_answer_source"] = "fixed-run-identical-material"
            material_unchanged.append(question_id)
        else:
            row = copy.deepcopy(adaptive[question_id])
            row["condition"] = "fragrach-enterprise-adaptive-material-paired"
            row["paired_answer_source"] = "adaptive-run-changed-material"
            material_changed.append(question_id)
        controlled.append(row)

    evidence_gains = [qid for qid in sorted(fixed) if not fixed[qid]["evidence_complete"] and adaptive[qid]["evidence_complete"]]
    evidence_losses = [qid for qid in sorted(fixed) if fixed[qid]["evidence_complete"] and not adaptive[qid]["evidence_complete"]]
    report = {
        "schema_version": "1.0",
        "experiment": "enterprise-rag-bench-adaptive-material-paired-comparison",
        "comparison_contract": "For questions whose answer material is byte-identical, reuse the fixed-run answer and judgment. Use the adaptive-run answer only where compilation changed the material. This removes observed Luna regeneration variance on unchanged inputs; it does not remove variance on changed inputs.",
        "evidence_contract": "Source-local 256-token anchored evidence definition from enterprise_rag_bench_metrics.py.",
        "fixed_observed": summarize(fixed_rows),
        "adaptive_observed": summarize(adaptive_rows),
        "adaptive_material_paired": summarize(controlled),
        "material": {
            "changed_questions": len(material_changed),
            "unchanged_questions": len(material_unchanged),
            "evidence_gains": evidence_gains,
            "evidence_losses": evidence_losses,
        },
    }
    options.output.mkdir(parents=True)
    with (options.output / "answers.jsonl").open("w", encoding="utf-8") as handle:
        for row in controlled:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    (options.output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
