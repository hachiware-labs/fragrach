#!/usr/bin/env python
"""Create an IVF-FLAT cosine index after the complete Ruri corpus has been loaded."""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import lancedb
from lancedb.index import IvfFlat


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--table", default="enterprise_rag_bench_ruri")
    parser.add_argument("--partitions", type=int, default=256)
    return parser.parse_args()


def main() -> None:
    options = parse_args()
    state_file = options.database / "fragrach-ingest-state.json"
    state = json.loads(state_file.read_text(encoding="utf-8"))
    if not state.get("complete"):
        raise RuntimeError(
            f"refusing to index an incomplete corpus: {state.get('loaded_documents')}/{state.get('expected_documents')}"
        )
    database = lancedb.connect(str(options.database))
    table = database.open_table(options.table)
    started = time.perf_counter()
    table.create_index(
        "vector",
        config=IvfFlat(distance_type="cosine", num_partitions=options.partitions),
        replace=True,
    )
    elapsed = time.perf_counter() - started
    indices = list(table.list_indices())
    report = {
        "schema_version": "1.0",
        "engine": f"LanceDB {lancedb.__version__}",
        "table": options.table,
        "documents": state["loaded_documents"],
        "index_type": "IVF_FLAT",
        "distance": "cosine",
        "partitions": options.partitions,
        "elapsed_seconds": elapsed,
        "indices": [str(index) for index in indices],
        "evaluation_contract": (
            "Use the flat exhaustive run as the Ruri reference, then measure ANN loss at multiple nprobes values."
        ),
    }
    (options.database / "fragrach-index-state.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
