#!/usr/bin/env python
"""Compare two Gold-inclusive Dense chunk pilot runs without overstating full-corpus quality."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--questions", type=Path, required=True)
    parser.add_argument("--variant", action="append", nargs=3, metavar=("NAME", "INPUT", "RESULT"), required=True)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def read_jsonl(file: Path) -> list[dict]:
    return [json.loads(line) for line in file.read_text(encoding="utf-8").splitlines() if line]


def main() -> None:
    options = parse_args()
    if options.output.exists():
        raise FileExistsError(f"output already exists: {options.output}")
    questions = {
        row["id"]: row
        for row in read_jsonl(options.questions)
        if row["split"] in {"development", "diagnostic"} and row["category"] == "semantic"
    }
    variants = {}
    completeness = {}
    fingerprints = set()
    for name, input_path, result_path in options.variant:
        source = json.loads((Path(input_path) / "manifest.json").read_text(encoding="utf-8"))
        report = json.loads((Path(result_path) / "report.json").read_text(encoding="utf-8"))
        rows = read_jsonl(Path(result_path) / "retrieval.jsonl")
        condition = next(iter(report["conditions"]))
        selected = {row["question_id"]: row for row in rows if row["condition"] == condition}
        completeness[name] = {
            question_id: set(question["gold_evidence"]["sources"]).issubset(
                {row["doc_id"] for row in selected[question_id]["results"]}
            )
            for question_id, question in questions.items()
        }
        fingerprints.add(source["selected_document_fingerprint"])
        variants[name] = {
            "chunk_tokens": source["chunk_tokens"],
            "overlap_tokens": source["overlap_tokens"],
            "documents": source["documents"],
            "chunks": source["units"],
            "chunks_per_document": source["units"] / source["documents"],
            "selection": source["selection"],
            "dense_search": report["dense_search"],
            "metrics": report["conditions"][condition],
        }
    if len(fingerprints) != 1:
        raise ValueError("variants do not use the same selected document set")
    names = list(variants)
    paired = None
    if len(names) == 2:
        first, second = names
        paired = {
            f"{first}_only_complete_at_10": sum(
                completeness[first][question_id] and not completeness[second][question_id]
                for question_id in questions
            ),
            f"{second}_only_complete_at_10": sum(
                completeness[second][question_id] and not completeness[first][question_id]
                for question_id in questions
            ),
            "same_outcome": sum(
                completeness[first][question_id] == completeness[second][question_id]
                for question_id in questions
            ),
        }
    output = {
        "schema_version": "1.0",
        "experiment": "enterprise-rag-bench-semantic-chunk-conversion-pilot",
        "purpose": "Choose a chunk conversion contract before paying the cost of a full-corpus conversion.",
        "selected_document_fingerprint": next(iter(fingerprints)),
        "questions": len(questions),
        "variants": variants,
        "paired_complete_at_10": paired,
        "interpretation_limit": (
            "Every evaluated semantic question's Gold documents were deliberately included with deterministic "
            "distractors. Compare variants and processing cost only; do not report these absolute scores as "
            "full-corpus R@10 or as evidence that Dense beats BM25/Hybrid."
        ),
        "holdout_status": "reserved and untouched",
    }
    options.output.mkdir(parents=True)
    (options.output / "report.json").write_text(
        json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(output, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
