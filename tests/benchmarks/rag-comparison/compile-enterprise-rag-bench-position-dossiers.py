#!/usr/bin/env python
"""Compile compact, indivisible Position Dossiers from selected Enterprise retrieval."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--questions", type=Path, required=True)
    parser.add_argument("--obligations", type=Path, required=True)
    parser.add_argument("--retrieval", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--k", type=int, default=10)
    return parser.parse_args()


def read_jsonl(file: Path) -> list[dict]:
    return [json.loads(line) for line in file.read_text(encoding="utf-8").splitlines() if line]


def tokens(text: str) -> set[str]:
    return set(re.findall(r"[a-z0-9][a-z0-9_.:/-]*", text.lower()))


def fact_coverage(fact: str, text: str) -> float:
    expected = set(re.findall(r"[a-z0-9]+", fact.lower()))
    actual = set(re.findall(r"[a-z0-9]+", text.lower()))
    return len(expected & actual) / max(len(expected), 1)


def windows(text: str, width: int = 1400, overlap: int = 200) -> list[str]:
    paragraphs = [part.strip() for part in re.split(r"\n\s*\n", text) if part.strip()]
    result = []
    for paragraph in paragraphs:
        if len(paragraph) <= width:
            result.append(paragraph)
            continue
        step = width - overlap
        for start in range(0, len(paragraph), step):
            value = paragraph[start:start + width].strip()
            if value:
                result.append(value)
            if start + width >= len(paragraph):
                break
    return result or [text[:width]]


def select_spans(document: dict, query_text: str, count: int) -> str:
    content = document.get("content") or ""
    if count == 0 or len(content) <= 5000:
        return content
    query_tokens = tokens(query_text)
    values = windows(content)
    ranked = []
    for index, value in enumerate(values):
        present = tokens(value)
        overlap = query_tokens & present
        score = sum(3 if any(character.isdigit() for character in token) or len(token) >= 9 else 1 for token in overlap)
        ranked.append((score, index, value))
    chosen = sorted(sorted(ranked, key=lambda item: (-item[0], item[1]))[:count], key=lambda item: item[1])
    return "\n\n[… position break …]\n\n".join(value for _, _, value in chosen)


def evidence_metrics(questions: list[dict], dossiers: dict[str, dict]) -> dict:
    verified = [q for q in questions if q["gold_status"] == "verified" and q["gold_evidence"]["units"]]
    recalls = []
    complete = 0
    for question in verified:
        source_texts = dossiers[question["id"]]["source_texts"]
        hits = sum(fact_coverage(unit["fact"], source_texts.get(unit["source"], "")) >= 0.5 for unit in question["gold_evidence"]["units"])
        recalls.append(hits / len(question["gold_evidence"]["units"]))
        complete += hits == len(question["gold_evidence"]["units"])
    return {"questions": len(verified), "evidence_unit_recall": sum(recalls) / max(len(recalls), 1), "evidence_ceiling": complete / max(len(verified), 1)}


def main() -> None:
    options = parse_args()
    if options.output.exists():
        raise FileExistsError(f"output already exists: {options.output}")
    questions = [q for q in read_jsonl(options.questions) if q["split"] in {"development", "diagnostic"}]
    obligations = {row["question_id"]: row for row in read_jsonl(options.obligations)}
    retrieval = {row["question_id"]: row["results"][:options.k] for row in read_jsonl(options.retrieval)}
    candidates = {}
    for span_count in (1, 2, 3, 4, 5, 6, 0):
        by_question = {}
        for question in questions:
            compiled = obligations[question["id"]]
            query_text = "\n".join([question["question"], *compiled["obligations"]])
            source_texts = {}
            sections = []
            for result in retrieval[question["id"]]:
                excerpt = select_spans(result, query_text, span_count)
                source_texts[result["doc_id"]] = f"{result['title']}\n\n{excerpt}"
                sections.append(f"SOURCE {result['doc_id']}\nTITLE: {result['title']}\n{excerpt}")
            by_question[question["id"]] = {
                "id": f"enterprise-position-dossier:{question['id']}",
                "mode": compiled["mode"],
                "obligations": compiled["obligations"],
                "sources": list(source_texts),
                "source_texts": source_texts,
                "text": "\n\n---\n\n".join(sections),
            }
        candidates[span_count] = by_question
    development = [q for q in questions if q["split"] == "development"]
    diagnostic = [q for q in questions if q["split"] == "diagnostic"]
    matrix = {str(count): {
        "development": evidence_metrics(development, rows),
        "diagnostic": evidence_metrics(diagnostic, rows),
        "mean_dossier_characters": sum(len(row["text"]) for row in rows.values()) / len(rows),
    } for count, rows in candidates.items()}
    selected = min(candidates, key=lambda count: (
        -matrix[str(count)]["development"]["evidence_ceiling"],
        -matrix[str(count)]["development"]["evidence_unit_recall"],
        matrix[str(count)]["mean_dossier_characters"],
    ))
    dossiers = candidates[selected]
    rows = [{
        "condition": "fragrach-enterprise-position-dossier-v1",
        "question_id": question["id"], "split": question["split"], "category": question["category"],
        "results": [dossiers[question["id"]]],
    } for question in questions]
    report = {
        "schema_version": "1.0",
        "experiment": "enterprise-rag-bench-position-dossier",
        "compile_contract": "Top-10 selected documents are preserved by document ID. Query-relative spans are chosen deterministically from question plus Luna obligations; Gold facts and answers are excluded. The dossier is one indivisible answer material.",
        "selection_contract": "Choose span count by development Evidence Ceiling, then Evidence Unit Recall, then smaller context; diagnostic is not used for selection.",
        "selected_spans_per_long_document": "full" if selected == 0 else selected,
        "candidate_matrix": matrix,
        "mean_dossier_characters": sum(len(row["results"][0]["text"]) for row in rows) / len(rows),
    }
    options.output.mkdir(parents=True)
    with (options.output / "retrieval.jsonl").open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    (options.output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
