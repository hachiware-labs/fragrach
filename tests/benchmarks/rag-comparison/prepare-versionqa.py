#!/usr/bin/env python3
"""Prepare the external VersionQA repository without redistributing its data."""

from __future__ import annotations

import argparse
import csv
import json
import re
from dataclasses import dataclass
from pathlib import Path

from pypdf import PdfReader


@dataclass(frozen=True)
class SourceDocument:
    input_path: Path
    family: str
    version: str
    extension: str


SOURCE_PATTERNS = (
    (re.compile(r"^assert nodejs ([0-9.]+)\.md$", re.I), "nodejs-assert"),
    (re.compile(r"^errors nodejs ([0-9.]+)\.md$", re.I), "nodejs-errors"),
    (re.compile(r"^Release v([0-9.]+) · twbs_bootstrap\.md$", re.I), "bootstrap-release"),
    (re.compile(r"^Spark Release ([0-9.]+) _ Apache Spark\.pdf$", re.I), "spark-release"),
)


def version_key(value: str) -> tuple[int, ...]:
    return tuple(int(part) for part in value.split("."))


def discover_documents(raw_root: Path) -> list[SourceDocument]:
    documents: list[SourceDocument] = []
    unknown: list[str] = []
    for source in sorted(raw_root.iterdir()):
        if not source.is_file():
            continue
        matched = False
        for pattern, family in SOURCE_PATTERNS:
            match = pattern.match(source.name)
            if match:
                documents.append(SourceDocument(source, family, match.group(1), source.suffix.lower()))
                matched = True
                break
        if not matched:
            unknown.append(source.name)
    if unknown:
        raise ValueError(f"unrecognized VersionQA source files: {unknown}")
    return sorted(documents, key=lambda item: (item.family, version_key(item.version)))


def read_document(source: SourceDocument) -> tuple[str, int | None]:
    if source.extension == ".md":
        return source.input_path.read_text(encoding="utf-8"), None
    reader = PdfReader(str(source.input_path))
    pages = []
    for index, page in enumerate(reader.pages, start=1):
        text = page.extract_text() or ""
        pages.append(f"## Page {index}\n\n{text.strip()}")
    return "\n\n".join(pages), len(reader.pages)


def yaml_string(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def front_matter(document: SourceDocument, predecessor: str | None, latest: bool) -> str:
    document_id = f"VERSIONQA-{document.family.upper()}"
    document_type = "release_notes" if document.family.endswith("release") else "technical_documentation"
    lines = [
        "---",
        f"document_id: {yaml_string(document_id)}",
        f"revision: {yaml_string(document.version)}",
        f"document_type: {yaml_string(document_type)}",
        f"status: {yaml_string('current' if latest else 'superseded')}",
        "approved: true",
        "official_record: true",
        f"versionqa_family: {yaml_string(document.family)}",
    ]
    if predecessor is not None:
        lines.extend(
            [
                'position: "dominates"',
                f"position_target_document_id: {yaml_string(document_id)}",
                f"position_target_revision: {yaml_string(predecessor)}",
            ]
        )
    lines.extend(["---", ""])
    return "\n".join(lines)


def infer_family(text: str) -> str | None:
    lowered = text.lower()
    if "spark" in lowered or "apache release" in lowered or "apache version" in lowered:
        return "spark-release"
    if "bootstrap" in lowered or "color-modes" in lowered or "decorative svgs" in lowered:
        return "bootstrap-release"
    if "about errors" in lowered or "node.js errors" in lowered or "nodejs errors" in lowered:
        return "nodejs-errors"
    assert_markers = (
        "assert.", "assertion", "calltracker", "deepstrict", "deepequal", "weakmap",
        "weakset", "partialdeep", "node:assert", "node.js assert", "nodejs assert", "assert module",
    )
    if any(marker in lowered for marker in assert_markers):
        return "nodejs-assert"
    if "err_" in lowered or "error" in lowered:
        return "nodejs-errors"
    if "node.js" in lowered or "nodejs" in lowered:
        return "nodejs-assert"
    return None


def explicit_versions(text: str) -> list[str]:
    return re.findall(r"(?<![A-Za-z0-9])v?([0-9]+\.[0-9]+(?:\.[0-9]+)?)(?![A-Za-z0-9])", text)


def resolve_versions(text: str, available: list[str]) -> list[str]:
    exact = explicit_versions(text)
    wildcard_majors = re.findall(r"(?<![A-Za-z0-9])([0-9]+)\.\*(?![A-Za-z0-9])", text)
    resolved = list(exact)
    for major in wildcard_majors:
        matches = [version for version in available if version.split(".", 1)[0] == major]
        if matches:
            resolved.append(matches[0])
    return resolved


def evidence_for_question(row: dict[str, str], families: dict[str, list[str]]) -> dict[str, object]:
    category = row["Type"].strip()
    question = row["Question"].strip()
    answer = row["Answer"].strip()
    family = infer_family(f"{question}\n{answer}")
    available = families.get(family, []) if family is not None else []
    question_versions = resolve_versions(question, available)
    answer_versions = resolve_versions(answer, available)
    evidence_versions: list[str] = []
    mode = "unresolved"

    if family is not None and category == "Version Listing & Inquiry":
        evidence_versions = families[family]
        mode = "version_inventory"
    elif family is not None and category == "Version-Specific Content Retrieval" and question_versions:
        evidence_versions = [question_versions[-1]]
        mode = "requested_version"
    elif family is not None and category == "Change Retrieval (e)":
        versions = question_versions or answer_versions
        if versions:
            evidence_versions = [versions[-1]]
            mode = "explicit_change"
    elif family is not None and category == "Change Retrieval (i)":
        versions = answer_versions or question_versions
        if versions:
            target = versions[-1]
            available = families[family]
            if target in available:
                index = available.index(target)
                evidence_versions = available[max(0, index - 1): index + 1]
            else:
                evidence_versions = [target]
            mode = "implicit_change_pair"
    elif family is not None and category in {"Content Retrieval", "Content Retrieval Complex"}:
        evidence_versions = [families[family][-1]]
        mode = "latest_version"

    return {
        "family": family,
        "versions": evidence_versions,
        "sources": [f"sources/{family}/{version}.md" for version in evidence_versions] if family else [],
        "mode": mode,
    }


def write_jsonl(path: Path, rows: list[dict[str, object]]) -> None:
    with path.open("w", encoding="utf-8", newline="\n") as stream:
        for row in rows:
            stream.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--versionqa-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    versionqa_root = args.versionqa_root.resolve()
    output = args.output.resolve()
    if output.exists() and any(output.iterdir()):
        raise FileExistsError(f"output already exists and is not empty: {output}")
    raw_root = versionqa_root / "data" / "raw"
    evaluation_csv = versionqa_root / "data" / "test" / "evaluation_set.csv"
    documents = discover_documents(raw_root)
    families: dict[str, list[str]] = {}
    for document in documents:
        families.setdefault(document.family, []).append(document.version)

    output.mkdir(parents=True, exist_ok=True)
    manifest_documents: list[dict[str, object]] = []
    for document in documents:
        versions = families[document.family]
        index = versions.index(document.version)
        predecessor = versions[index - 1] if index > 0 else None
        latest = index == len(versions) - 1
        body, pages = read_document(document)
        destination = output / "sources" / document.family / f"{document.version}.md"
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(
            front_matter(document, predecessor, latest)
            + f"\n# {document.family} {document.version}\n\n"
            + body.strip()
            + "\n",
            encoding="utf-8",
            newline="\n",
        )
        manifest_documents.append(
            {
                "source": destination.relative_to(output).as_posix(),
                "family": document.family,
                "version": document.version,
                "predecessor": predecessor,
                "latest": latest,
                "source_name": document.input_path.name,
                "source_format": document.extension.removeprefix("."),
                "pages": pages,
            }
        )

    with evaluation_csv.open(encoding="utf-8-sig", newline="") as stream:
        source_questions = list(csv.DictReader(stream))
    questions: list[dict[str, object]] = []
    for index, row in enumerate(source_questions, start=1):
        evidence = evidence_for_question(row, families)
        questions.append(
            {
                "id": f"VQA-{index:03d}",
                "category": row["Type"].strip(),
                "question": row["Question"].strip(),
                "answer": row["Answer"].strip(),
                "version_sensitive": row["Type"].strip() not in {"Content Retrieval", "Content Retrieval Complex"},
                "gold_evidence": evidence,
            }
        )

    evaluation_root = output / "evaluation"
    evaluation_root.mkdir(parents=True, exist_ok=True)
    write_jsonl(evaluation_root / "questions.jsonl", questions)
    manifest = {
        "schema_version": "1.0",
        "corpus_id": "versionqa-external-adapter",
        "source_repository": "https://github.com/danielhuwiler/versionrag",
        "source_commit": "2a2cbe8f285557f99dc7a79d6df7134e1e3eccff",
        "redistribution": False,
        "documents": manifest_documents,
        "families": families,
        "questions": len(questions),
        "version_sensitive_questions": sum(bool(item["version_sensitive"]) for item in questions),
        "unresolved_gold_mappings": [
            item["id"] for item in questions if item["gold_evidence"]["mode"] == "unresolved"
        ],
    }
    (output / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    print(json.dumps({
        "output": str(output),
        "documents": len(documents),
        "families": {key: len(value) for key, value in families.items()},
        "questions": len(questions),
        "version_sensitive_questions": manifest["version_sensitive_questions"],
        "unresolved_gold_mappings": manifest["unresolved_gold_mappings"],
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
