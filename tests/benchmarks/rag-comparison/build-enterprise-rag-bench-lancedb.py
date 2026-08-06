#!/usr/bin/env python
"""Incrementally load restartable Ruri vector shards into a local LanceDB table."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import lancedb
import numpy as np
import pyarrow as pa


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--vectors", type=Path, required=True)
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--table", default="enterprise_rag_bench_ruri")
    parser.add_argument("--start-shard", type=int, default=0)
    parser.add_argument("--end-shard", type=int)
    return parser.parse_args()


def read_jsonl(file: Path) -> list[dict]:
    return [json.loads(line) for line in file.read_text(encoding="utf-8").splitlines() if line]


def write_state(file: Path, state: dict) -> None:
    temporary = file.with_suffix(".tmp")
    temporary.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(file)


def main() -> None:
    options = parse_args()
    source_manifest = json.loads((options.input / "manifest.json").read_text(encoding="utf-8"))
    query_manifest = json.loads((options.vectors / "queries.json").read_text(encoding="utf-8"))
    dimensions = int(query_manifest["dimensions"])
    options.database.mkdir(parents=True, exist_ok=True)
    state_file = options.database / "fragrach-ingest-state.json"
    if state_file.exists():
        state = json.loads(state_file.read_text(encoding="utf-8"))
        if state["corpus_fingerprint"] != source_manifest["corpus_fingerprint"]:
            raise ValueError("LanceDB state belongs to a different corpus projection")
        if state["model"] != query_manifest["model"] or state["dimensions"] != dimensions:
            raise ValueError("LanceDB state belongs to a different embedding contract")
    else:
        state = {
            "schema_version": "1.0",
            "corpus_fingerprint": source_manifest["corpus_fingerprint"],
            "model": query_manifest["model"],
            "dimensions": dimensions,
            "expected_documents": source_manifest["documents"],
            "expected_rows": source_manifest.get("units", source_manifest["documents"]),
            "completed_shards": [],
        }

    database = lancedb.connect(str(options.database))
    table_names = database.list_tables().tables
    fields = [
        pa.field("row_id", pa.int64()),
        pa.field("shard", pa.int32()),
        pa.field("doc_id", pa.string()),
        pa.field("embedding_text", pa.string()),
        pa.field("vector", pa.list_(pa.float32(), dimensions)),
    ]
    chunked = "units" in source_manifest
    if chunked:
        fields[2:2] = [pa.field("unit_id", pa.string()), pa.field("chunk_index", pa.int32())]
    schema = pa.schema(fields)
    if options.table in table_names:
        table = database.open_table(options.table)
    else:
        table = database.create_table(options.table, schema=schema)

    completed = set(state["completed_shards"])
    end_shard = options.end_shard if options.end_shard is not None else len(source_manifest["shards"])
    for shard_index, shard in enumerate(source_manifest["shards"]):
        if shard_index < options.start_shard or shard_index >= end_shard:
            continue
        shard_name = Path(shard["file"]).stem
        if shard_name in completed:
            print(json.dumps({"shard": shard_name, "status": "cache-hit"}), flush=True)
            continue
        vector_manifest_file = options.vectors / f"{shard_name}.json"
        vector_file = options.vectors / f"{shard_name}.f32"
        if not vector_manifest_file.exists() or not vector_file.exists():
            print(json.dumps({"shard": shard_name, "status": "vectors-pending"}), flush=True)
            continue
        vector_manifest = json.loads(vector_manifest_file.read_text(encoding="utf-8"))
        rows = read_jsonl(options.input / shard["file"])
        if vector_manifest["rows"] != len(rows) or vector_manifest["dimensions"] != dimensions:
            raise ValueError(f"invalid vector manifest for {shard_name}")
        expected_bytes = len(rows) * dimensions * 4
        if vector_file.stat().st_size != expected_bytes:
            raise ValueError(f"invalid vector byte count for {shard_name}")
        vectors = np.memmap(vector_file, dtype=np.float32, mode="r", shape=(len(rows), dimensions))
        flat_vectors = pa.array(np.asarray(vectors).reshape(-1), type=pa.float32())
        arrow_values = {
            "row_id": pa.array([row["row_id"] for row in rows], type=pa.int64()),
            "shard": pa.array([shard_index] * len(rows), type=pa.int32()),
            "doc_id": pa.array([row["doc_id"] for row in rows], type=pa.string()),
            "embedding_text": pa.array([row["text"] for row in rows], type=pa.string()),
            "vector": pa.FixedSizeListArray.from_arrays(flat_vectors, dimensions),
        }
        if chunked:
            arrow_values["unit_id"] = pa.array([row["unit_id"] for row in rows], type=pa.string())
            arrow_values["chunk_index"] = pa.array([row["chunk_index"] for row in rows], type=pa.int32())
        arrow = pa.table(arrow_values, schema=schema)
        # If a previous run stopped after add() but before state persistence, make the shard idempotent.
        table.delete(f"shard = {shard_index}")
        table.add(arrow)
        completed.add(shard_name)
        state["completed_shards"] = sorted(completed)
        state["loaded_documents"] = int(table.count_rows())
        write_state(state_file, state)
        print(json.dumps({
            "shard": shard_name,
            "status": "loaded",
            "rows": len(rows),
            "table_rows": state["loaded_documents"],
        }), flush=True)

    state["loaded_documents"] = int(table.count_rows())
    state["complete"] = (
        len(state["completed_shards"]) == len(source_manifest["shards"])
        and state["loaded_documents"] == state.get("expected_rows", state["expected_documents"])
    )
    write_state(state_file, state)
    print(json.dumps(state, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
