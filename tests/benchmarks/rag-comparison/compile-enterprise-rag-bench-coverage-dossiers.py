#!/usr/bin/env python
"""Compile obligation-coverage Position Dossiers without using Gold for selection."""

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


def split_windows(text: str, width: int = 1400, overlap: int = 200) -> list[str]:
    if len(text) <= 5000:
        return [text]
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


def lexical_score(query: str, text: str) -> float:
    query_tokens = tokens(query)
    present = tokens(text)
    overlap = query_tokens & present
    return sum(4 if any(character.isdigit() for character in token) else 3 if len(token) >= 12 else 2 if len(token) >= 7 else 1 for token in overlap)


def compile_dossier(question: dict, compiled: dict, results: list[dict], config: dict) -> dict:
    documents = []
    for result in results:
        values = split_windows(result.get("content") or "")
        documents.append({"result": result, "windows": values})
    selected: dict[str, set[int]] = {document["result"]["doc_id"]: set() for document in documents}
    reasons: dict[tuple[str, int], set[str]] = {}

    def retain(document: dict, index: int, reason: str) -> None:
        doc_id = document["result"]["doc_id"]
        for candidate in range(max(0, index - config["neighbor_radius"]), min(len(document["windows"]), index + config["neighbor_radius"] + 1)):
            selected[doc_id].add(candidate)
            reasons.setdefault((doc_id, candidate), set()).add(reason)

    query_text = "\n".join([question["question"], *compiled["obligations"]])
    for document in documents:
        ranked = sorted(range(len(document["windows"])), key=lambda index: (-lexical_score(query_text, document["windows"][index]), index))
        for index in ranked[:config["baseline_per_document"]]:
            retain(document, index, "question")

    for obligation_index, obligation in enumerate(compiled["obligations"]):
        best_per_document = []
        for document in documents:
            ranked = sorted(range(len(document["windows"])), key=lambda index: (-lexical_score(obligation, document["windows"][index]), index))
            best_index = ranked[0]
            best_per_document.append((lexical_score(obligation, document["windows"][best_index]), document, best_index))
        best_per_document.sort(key=lambda item: (-item[0], item[1]["result"]["rank"], item[2]))
        for _, document, index in best_per_document[:config["sources_per_obligation"]]:
            retain(document, index, f"obligation:{obligation_index}")

    source_texts = {}
    sections = []
    selected_positions = []
    for document in documents:
        result = document["result"]
        doc_id = result["doc_id"]
        indices = sorted(selected[doc_id])
        excerpt = "\n\n[… position break …]\n\n".join(document["windows"][index] for index in indices)
        source_texts[doc_id] = f"{result['title']}\n\n{excerpt}"
        sections.append(f"SOURCE {doc_id}\nTITLE: {result['title']}\n{excerpt}")
        selected_positions.extend({
            "source": doc_id, "window": index, "reasons": sorted(reasons.get((doc_id, index), [])),
        } for index in indices)
    return {
        "id": f"enterprise-coverage-dossier:{question['id']}",
        "mode": compiled["mode"], "obligations": compiled["obligations"],
        "sources": list(source_texts), "source_texts": source_texts,
        "selected_positions": selected_positions,
        "text": "\n\n---\n\n".join(sections),
    }


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
    configs = [
        {"name": "b1-s1-n1", "baseline_per_document": 1, "sources_per_obligation": 1, "neighbor_radius": 1},
        {"name": "b1-s2-n1", "baseline_per_document": 1, "sources_per_obligation": 2, "neighbor_radius": 1},
        {"name": "b2-s1-n1", "baseline_per_document": 2, "sources_per_obligation": 1, "neighbor_radius": 1},
        {"name": "b2-s2-n1", "baseline_per_document": 2, "sources_per_obligation": 2, "neighbor_radius": 1},
        {"name": "b1-s2-n2", "baseline_per_document": 1, "sources_per_obligation": 2, "neighbor_radius": 2},
        {"name": "b2-s2-n2", "baseline_per_document": 2, "sources_per_obligation": 2, "neighbor_radius": 2},
    ]
    candidates = {
        config["name"]: {
            question["id"]: compile_dossier(question, obligations[question["id"]], retrieval[question["id"]], config)
            for question in questions
        }
        for config in configs
    }
    development = [q for q in questions if q["split"] == "development"]
    diagnostic = [q for q in questions if q["split"] == "diagnostic"]
    matrix = {name: {
        "development": evidence_metrics(development, rows),
        "diagnostic": evidence_metrics(diagnostic, rows),
        "mean_dossier_characters": sum(len(row["text"]) for row in rows.values()) / len(rows),
        "mean_selected_positions": sum(len(row["selected_positions"]) for row in rows.values()) / len(rows),
    } for name, rows in candidates.items()}
    selected = min(candidates, key=lambda name: (
        -matrix[name]["development"]["evidence_ceiling"],
        -matrix[name]["development"]["evidence_unit_recall"],
        matrix[name]["mean_dossier_characters"],
    ))
    dossiers = candidates[selected]
    rows = [{
        "condition": "fragrach-enterprise-obligation-coverage-dossier-v1",
        "question_id": question["id"], "split": question["split"], "category": question["category"],
        "results": [dossiers[question["id"]]],
    } for question in questions]
    report = {
        "schema_version": "1.0", "experiment": "enterprise-rag-bench-obligation-coverage-dossier",
        "leakage_contract": "Question, Luna obligations, and frozen BM25 top-10 source text only. Gold answers, facts, and source IDs are excluded from selection.",
        "selection_contract": "Every top-10 source retains baseline question positions; every obligation retains positions from its best source candidates plus neighboring positions. Select configuration by development Evidence Ceiling, then recall, then smaller context.",
        "selected_configuration": selected, "candidate_matrix": matrix,
    }
    options.output.mkdir(parents=True)
    with (options.output / "retrieval.jsonl").open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    (options.output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
