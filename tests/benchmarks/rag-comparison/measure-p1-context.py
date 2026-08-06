#!/usr/bin/env python
"""Measure answer-context size for the fixed P1 retrieval outputs."""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path
from typing import Any

import tiktoken


DEFAULT_INPUTS = [
    Path("target/benchmarks/enterprise-actual-retrieval/2026-08-02-manufacturing-product-design-governance-luna-relation-v4-context/retrieval.jsonl"),
    Path("target/benchmarks/p1-open-source/2026-08-02-graphiti-0.29.3-luna-ruri-governance-v6-scored/retrieval.jsonl"),
    Path("target/benchmarks/p1-open-source/2026-08-02-lightrag-1.5.5-luna-ruri-governance-v3-scored/retrieval.jsonl"),
    Path("target/benchmarks/p1-open-source/2026-08-02-fast-graphrag-0.0.5-luna-ruri-governance-v1-scored/retrieval.jsonl"),
    Path("target/benchmarks/p1-open-source/2026-08-02-cognee-1.4.1-luna-ruri-governance-v4-scored/retrieval.jsonl"),
    Path("target/benchmarks/p1-open-source/2026-08-02-ms-graphrag-3.1.0-luna-ruri-governance-v2-scored/retrieval.jsonl"),
]
KS = (5, 10, 20)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--input", action="append", type=Path, dest="inputs")
    parser.add_argument("--encoding", default="o200k_base")
    return parser.parse_args()


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    return [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line
    ]


def mean(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def main() -> None:
    options = parse_args()
    inputs = [path.resolve() for path in (options.inputs or DEFAULT_INPUTS)]
    missing = [str(path) for path in inputs if not path.is_file()]
    if missing:
        raise FileNotFoundError(f"missing P1 retrieval inputs: {missing}")
    if options.output.exists():
        raise FileExistsError(f"output directory already exists: {options.output}")
    tokenizer = tiktoken.get_encoding(options.encoding)
    rows_by_condition: dict[str, list[dict[str, Any]]] = defaultdict(list)
    source_files: dict[str, str] = {}
    for path in inputs:
        for row in read_jsonl(path):
            rows_by_condition[row["condition"]].append(row)
            source_files[row["condition"]] = str(path)

    conditions = {}
    for condition, rows in sorted(rows_by_condition.items()):
        at_k = {}
        for k in KS:
            tokens: list[float] = []
            chars: list[float] = []
            units: list[float] = []
            correct_evidence = 0.0
            for row in rows:
                selected = (row.get("retrieved_units") or [])[:k]
                texts = [
                    str(unit.get("retrieval_text") or unit.get("text") or unit.get("fact") or "")
                    for unit in selected
                ]
                context = "\n\n".join(texts)
                token_count = len(tokenizer.encode(context))
                tokens.append(float(token_count))
                chars.append(float(len(context)))
                units.append(float(len(selected)))
                recall = ((row.get("metrics") or {}).get("recall_at_k") or {}).get(str(k))
                required = row.get("required_evidence") or []
                if recall is not None:
                    correct_evidence += float(recall) * len(required)
            total_tokens = sum(tokens)
            at_k[str(k)] = {
                "average_tokens": mean(tokens),
                "average_chars": mean(chars),
                "average_units": mean(units),
                "correct_evidence_per_1000_tokens": (
                    correct_evidence * 1000 / total_tokens if total_tokens else 0.0
                ),
            }
        conditions[condition] = {
            "questions": len(rows),
            "source": source_files[condition],
            "at_k": at_k,
        }

    report = {
        "schema_version": "1.0",
        "experiment": "p1-answer-context-size",
        "tokenizer": options.encoding,
        "inputs": [str(path) for path in inputs],
        "conditions": conditions,
    }
    options.output.mkdir(parents=True)
    (options.output / "metrics.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    for name, values in conditions.items():
        print(
            f"{name}: @5 {values['at_k']['5']['average_tokens']:.1f} tokens, "
            f"@10 {values['at_k']['10']['average_tokens']:.1f} tokens"
        )


if __name__ == "__main__":
    main()
