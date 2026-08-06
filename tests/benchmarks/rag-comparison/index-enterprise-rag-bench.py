#!/usr/bin/env python
"""Build the official-style one-document BM25 index with local Tantivy."""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import pyarrow.parquet as pq
import tantivy


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--documents", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def main() -> None:
    options = parse_args()
    if options.output.exists():
        raise FileExistsError(f"output already exists: {options.output}")
    options.output.mkdir(parents=True)
    builder = tantivy.SchemaBuilder()
    builder.add_text_field("doc_id", stored=True, tokenizer_name="raw", index_option="basic")
    builder.add_text_field("source_type", stored=True, tokenizer_name="raw", index_option="basic")
    builder.add_text_field("title", stored=True)
    builder.add_text_field("content", stored=True)
    builder.add_text_field("text")
    schema = builder.build()
    index = tantivy.Index(schema, path=str(options.output), reuse=False)
    writer = index.writer(heap_size=512_000_000, num_threads=4)
    parquet = pq.ParquetFile(options.documents)
    started = time.time()
    count = 0
    for batch in parquet.iter_batches(batch_size=2048, columns=["doc_id", "source_type", "title", "content"]):
        for row in batch.to_pylist():
            title = row.get("title") or ""
            content = row.get("content") or ""
            writer.add_document(tantivy.Document(
                doc_id=row["doc_id"],
                source_type=row.get("source_type") or "",
                title=title,
                content=content,
                text=f"{title}\n\n{content}",
            ))
            count += 1
        if count % 50_000 < 2048:
            print(json.dumps({"indexed": count, "elapsed_seconds": round(time.time() - started, 1)}), flush=True)
    writer.commit()
    index.reload()
    manifest = {
        "schema_version": "1.0",
        "documents": count,
        "source": str(options.documents),
        "engine": f"tantivy {tantivy.__version__}",
        "contract": "One record per source document; BM25 over title + content using Tantivy's default tokenizer.",
        "elapsed_seconds": time.time() - started,
    }
    (options.output / "fragrach-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
