#!/usr/bin/env python
"""Freeze the strongest exact retrieval condition using development metrics only."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def read_jsonl(file: Path) -> list[dict]:
    return [json.loads(line) for line in file.read_text(encoding="utf-8").splitlines() if line]


def preference(condition: str) -> int:
    if condition.startswith("bm25-"):
        return 0
    if condition.startswith("hybrid-"):
        return 1
    return 2


def main() -> None:
    options = parse_args()
    if options.output.exists():
        raise FileExistsError(f"output already exists: {options.output}")
    report = json.loads((options.input / "report.json").read_text(encoding="utf-8"))
    if report["dense_search"]["mode"] != "flat":
        raise ValueError("quality selection must use the exhaustive flat run, not ANN")
    candidates = []
    for condition, values in report["conditions"].items():
        development = values["development"]
        semantic = values["semantic_development"]
        candidates.append({
            "condition": condition,
            "development": development,
            "semantic_development": semantic,
        })
    selected = min(candidates, key=lambda row: (
        -row["development"]["evidence_ceiling_at_k"],
        -row["development"]["evidence_unit_recall_at_k"],
        -row["development"]["document_recall_at_k"],
        -row["semantic_development"]["document_recall_at_k"],
        preference(row["condition"]),
        row["condition"],
    ))
    rows = [
        row for row in read_jsonl(options.input / "retrieval.jsonl")
        if row["condition"] == selected["condition"]
    ]
    if len(rows) != 200:
        raise ValueError(f"selected retrieval must contain 200 development+diagnostic rows, found {len(rows)}")
    options.output.mkdir(parents=True)
    with (options.output / "retrieval.jsonl").open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    selection_report = {
        "schema_version": "1.0",
        "experiment": "enterprise-rag-bench-strongest-exact-retrieval-selection",
        "source": str(options.input),
        "selected_condition": selected["condition"],
        "selection_contract": (
            "Development only: Evidence Ceiling@10, Evidence Unit Recall@10, document recall@10, then semantic "
            "document recall@10. Exact ties prefer BM25, then Hybrid, then Dense. Diagnostic and holdout are excluded."
        ),
        "candidates": candidates,
        "diagnostic": report["conditions"][selected["condition"]]["diagnostic"],
        "semantic_diagnostic": report["conditions"][selected["condition"]]["semantic_diagnostic"],
        "holdout_status": "reserved and untouched",
    }
    (options.output / "report.json").write_text(
        json.dumps(selection_report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(selection_report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
