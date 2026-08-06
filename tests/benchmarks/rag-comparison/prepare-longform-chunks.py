#!/usr/bin/env python
"""Create a canonical token-based chunk set shared by long-form retrievers."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import tiktoken


@dataclass
class Section:
    heading: str
    paragraphs: list[str]
    start_char: int


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--corpus",
        type=Path,
        default=Path("tests/corpora/fragrach-enterprise-ja-longform"),
    )
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--chunk-tokens", type=int, required=True)
    parser.add_argument("--overlap-tokens", type=int, default=0)
    parser.add_argument("--encoding", default="o200k_base")
    parser.add_argument(
        "--domains",
        help="optional comma-separated industry-department identifiers",
    )
    return parser.parse_args()


def parse_frontmatter(text: str) -> tuple[dict[str, Any], str, int]:
    if not text.startswith("---"):
        return {}, text, 0
    parts = text.split("---", 2)
    if len(parts) != 3:
        return {}, text, 0
    metadata: dict[str, Any] = {}
    for line in parts[1].splitlines():
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        raw = value.strip()
        try:
            metadata[key.strip()] = json.loads(raw)
        except json.JSONDecodeError:
            metadata[key.strip()] = raw
    offset = len(parts[0]) + len(parts[1]) + 6
    return metadata, parts[2].lstrip(), offset


def parse_sections(body: str, body_offset: int) -> tuple[str, list[Section]]:
    title_match = re.search(r"(?m)^#\s+(.+)$", body)
    title = title_match.group(1).strip() if title_match else "本文"
    matches = list(re.finditer(r"(?m)^##\s+(.+)$", body))
    sections: list[Section] = []
    for index, match in enumerate(matches):
        start = match.end()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(body)
        content = body[start:end].strip()
        paragraphs = [part.strip() for part in re.split(r"\n\s*\n", content) if part.strip()]
        sections.append(
            Section(
                heading=match.group(1).strip(),
                paragraphs=paragraphs,
                start_char=body_offset + start,
            )
        )
    if not sections:
        paragraphs = [part.strip() for part in re.split(r"\n\s*\n", body) if part.strip()]
        sections.append(Section("本文", paragraphs, body_offset))
    return title, sections


def split_long_paragraph(text: str, encoding: Any, limit: int, overlap: int) -> list[str]:
    tokens = encoding.encode(text)
    if len(tokens) <= limit:
        return [text]
    step = max(1, limit - overlap)
    return [encoding.decode(tokens[start : start + limit]).strip() for start in range(0, len(tokens), step)]


def section_chunks(
    section: Section,
    encoding: Any,
    limit: int,
    overlap: int,
) -> list[tuple[str, int, int]]:
    paragraphs: list[tuple[str, int]] = []
    char_cursor = section.start_char
    for paragraph in section.paragraphs:
        parts = split_long_paragraph(paragraph, encoding, limit, overlap)
        for part in parts:
            paragraphs.append((part, char_cursor))
            char_cursor += len(part) + 2
    chunks: list[tuple[str, int, int]] = []
    cursor = 0
    while cursor < len(paragraphs):
        selected: list[tuple[str, int]] = []
        tokens = 0
        end = cursor
        while end < len(paragraphs):
            paragraph, offset = paragraphs[end]
            count = len(encoding.encode(paragraph)) + (2 if selected else 0)
            if selected and tokens + count > limit:
                break
            selected.append((paragraph, offset))
            tokens += count
            end += 1
        text = "\n\n".join(item[0] for item in selected)
        chunks.append((text, selected[0][1], selected[-1][1] + len(selected[-1][0])))
        if end >= len(paragraphs):
            break
        overlap_count = 0
        next_cursor = end
        while next_cursor > cursor + 1 and overlap_count < overlap:
            next_cursor -= 1
            overlap_count += len(encoding.encode(paragraphs[next_cursor][0]))
        cursor = max(cursor + 1, next_cursor)
    return chunks


def corpus_source_files(corpus: Path) -> list[tuple[str, Path]]:
    manifest_file = corpus / "manifest.json"
    if manifest_file.exists():
        manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
        if isinstance(manifest.get("documents"), list) and all(
            isinstance(row, dict) and "source" in row for row in manifest["documents"]
        ):
            roots = [(corpus / root).resolve() for root in manifest.get("source_roots", ["."])]
            rows = []
            for document in manifest["documents"]:
                source = document["source"].replace("\\", "/")
                file = next((root / source for root in roots if (root / source).is_file()), None)
                if file is None:
                    raise FileNotFoundError(f"manifest document is missing from source roots: {source}")
                rows.append((source, file))
            return rows
    return [
        (file.relative_to(corpus).as_posix(), file)
        for file in sorted((corpus / "sources").rglob("*.md"))
    ]


def stable_source_id(source: str) -> str:
    """Match Fragarach's source ID for files scanned below a corpus sources root."""
    normalized = source.replace("\\", "/")
    relative = normalized.removeprefix("sources/")
    return f"src_{hashlib.sha256(relative.encode('utf-8')).hexdigest()[:16]}"


def build_chunks(
    corpus: Path,
    token_limit: int,
    overlap: int,
    encoding_name: str,
    domains: set[str] | None = None,
) -> list[dict[str, Any]]:
    if encoding_name == "ruri":
        from transformers import AutoTokenizer

        tokenizer = AutoTokenizer.from_pretrained("cl-nagoya/ruri-v3-310m")

        class RuriTokenizer:
            @staticmethod
            def encode(text: str) -> list[int]:
                return tokenizer.encode(text, add_special_tokens=False)

            @staticmethod
            def decode(tokens: list[int]) -> str:
                return tokenizer.decode(tokens, skip_special_tokens=True)

        encoding = RuriTokenizer()
    else:
        encoding = tiktoken.get_encoding(encoding_name)
    chunks: list[dict[str, Any]] = []
    for source, file in corpus_source_files(corpus):
        raw = file.read_text(encoding="utf-8")
        metadata, body, body_offset = parse_frontmatter(raw)
        domain_id = f"{metadata.get('industry')}-{metadata.get('department')}"
        if domains and domain_id not in domains:
            continue
        title, sections = parse_sections(body, body_offset)
        document_chars = len(raw)
        for section_index, section in enumerate(sections):
            header = f"文書: {title}\nセクション: {section.heading}\n"
            available_tokens = max(64, token_limit - len(encoding.encode(header)))
            for chunk_index, (content, start_char, end_char) in enumerate(
                section_chunks(section, encoding, available_tokens, min(overlap, available_tokens - 1))
            ):
                retrieval_text = f"{header}{content}"
                chunk_id = hashlib.sha256(
                    f"{source}\0{section.heading}\0{chunk_index}\0{retrieval_text}".encode()
                ).hexdigest()[:24]
                chunks.append(
                    {
                        "id": f"canonical:{token_limit}:{chunk_id}",
                        "source": source,
                        "source_id": stable_source_id(source),
                        "document_id": metadata.get("document_id"),
                        "revision": metadata.get("revision"),
                        "domain_id": domain_id,
                        "purpose": metadata.get("purpose"),
                        "section": section.heading,
                        "section_index": section_index,
                        "chunk_index": chunk_index,
                        "start_char": start_char,
                        "end_char": end_char,
                        "relative_position": round(start_char / max(1, document_chars), 6),
                        "token_count": len(encoding.encode(retrieval_text)),
                        "text": retrieval_text,
                        "evidence": [
                            {
                                "source": source,
                                "source_id": stable_source_id(source),
                                "document_id": metadata.get("document_id"),
                                "revision": metadata.get("revision"),
                                "section": section.heading,
                                "text": content,
                            }
                        ],
                    }
                )
    return chunks


def main() -> None:
    options = parse_args()
    if options.overlap_tokens >= options.chunk_tokens:
        raise ValueError("overlap must be smaller than chunk size")
    chunks = build_chunks(
        options.corpus.resolve(),
        options.chunk_tokens,
        options.overlap_tokens,
        options.encoding,
        set(options.domains.split(",")) if options.domains else None,
    )
    options.output.parent.mkdir(parents=True, exist_ok=True)
    options.output.write_text(
        "".join(json.dumps(item, ensure_ascii=False) + "\n" for item in chunks),
        encoding="utf-8",
    )
    token_values = sorted(item["token_count"] for item in chunks)
    report = {
        "schema_version": "1.0",
        "corpus": str(options.corpus.resolve()),
        "output": str(options.output.resolve()),
        "encoding": options.encoding,
        "chunk_tokens": options.chunk_tokens,
        "overlap_tokens": options.overlap_tokens,
        "domains": options.domains.split(",") if options.domains else None,
        "chunks": len(chunks),
        "documents": len({item["source"] for item in chunks}),
        "average_tokens": round(sum(token_values) / len(token_values), 2),
        "p50_tokens": token_values[len(token_values) // 2],
        "p90_tokens": token_values[int(len(token_values) * 0.9)],
        "max_tokens": max(token_values),
    }
    report_file = options.output.with_suffix(".report.json")
    report_file.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
