#!/usr/bin/env python
"""Add exact tokenizer counts to retrieval JSONL units.

The retriever implementations intentionally stay tokenizer-agnostic. This
small post-processing step makes their contexts comparable under the same
fixed token budgets without changing retrieval order or text.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import tiktoken


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--encoding", default="o200k_base")
    return parser.parse_args()


def unit_text(unit: dict[str, Any]) -> str:
    return str(
        unit.get("retrieval_text")
        or unit.get("text")
        or unit.get("fact")
        or ""
    )


def main() -> None:
    options = parse_args()
    if not options.input.is_file():
        raise FileNotFoundError(options.input)
    if options.output.exists():
        raise FileExistsError(options.output)
    tokenizer = tiktoken.get_encoding(options.encoding)
    rows = [
        json.loads(line)
        for line in options.input.read_text(encoding="utf-8").splitlines()
        if line
    ]
    for row in rows:
        for unit in row.get("retrieved_units") or []:
            unit["token_count"] = len(tokenizer.encode(unit_text(unit)))
    options.output.parent.mkdir(parents=True, exist_ok=True)
    options.output.write_text(
        "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows),
        encoding="utf-8",
    )
    print(f"annotated {len(rows)} rows with {options.encoding}: {options.output}")


if __name__ == "__main__":
    main()
