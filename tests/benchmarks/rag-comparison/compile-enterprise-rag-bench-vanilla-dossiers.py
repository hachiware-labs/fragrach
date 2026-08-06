#!/usr/bin/env python
"""Compile full and context-budget-matched Vanilla EnterpriseRAG-Bench materials."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

from enterprise_rag_bench_metrics import LocalEvidenceScorer


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--questions", type=Path, required=True)
    parser.add_argument("--retrieval", type=Path, required=True)
    parser.add_argument("--retrieval-condition")
    parser.add_argument("--gold-documents", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--context-budget", type=float, default=50_849)
    parser.add_argument("--k", type=int, default=10)
    return parser.parse_args()


def read_jsonl(file: Path) -> list[dict]:
    return [json.loads(line) for line in file.read_text(encoding="utf-8").splitlines() if line]


def tokens(text: str) -> set[str]:
    return set(re.findall(r"[a-z0-9][a-z0-9_.:/-]*", text.lower()))


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


def select_spans(document: dict, question: str, count: int, full_below_characters: int = 5000) -> str:
    content = document.get("content") or ""
    if count == 0 or len(content) <= full_below_characters:
        return content
    query_tokens = tokens(question)
    ranked = []
    for index, value in enumerate(windows(content)):
        overlap = query_tokens & tokens(value)
        score = sum(3 if any(character.isdigit() for character in token) or len(token) >= 9 else 1 for token in overlap)
        ranked.append((score, index, value))
    chosen = sorted(sorted(ranked, key=lambda item: (-item[0], item[1]))[:count], key=lambda item: item[1])
    return "\n\n[… position break …]\n\n".join(value for _, _, value in chosen)


def compile_material(question: dict, results: list[dict], span_count: int, full_top_documents: int) -> dict:
    source_texts = {}
    sections = []
    for rank, result in enumerate(results, start=1):
        excerpt = select_spans(result, question["question"], 0 if rank <= full_top_documents else span_count)
        source_texts[result["doc_id"]] = f"{result['title']}\n\n{excerpt}"
        sections.append(f"SOURCE {result['doc_id']}\nTITLE: {result['title']}\n{excerpt}")
    return {
        "id": f"enterprise-vanilla-material:{question['id']}",
        "mode": "point",
        "obligations": [],
        "sources": list(source_texts),
        "source_texts": source_texts,
        "text": "\n\n---\n\n".join(sections),
        "compile_span_count": "full" if span_count == 0 else span_count,
        "compile_full_top_documents": full_top_documents,
        "compile_query": "question-only",
    }


def write_rows(file: Path, questions: list[dict], dossiers: dict[str, dict], condition: str) -> None:
    with file.open("w", encoding="utf-8") as handle:
        for question in questions:
            handle.write(json.dumps({
                "condition": condition,
                "question_id": question["id"],
                "split": question["split"],
                "category": question["category"],
                "results": [dossiers[question["id"]]],
            }, ensure_ascii=False) + "\n")


def main() -> None:
    options = parse_args()
    if options.output.exists():
        raise FileExistsError(f"output already exists: {options.output}")
    questions = [row for row in read_jsonl(options.questions) if row["split"] in {"development", "diagnostic"}]
    retrieval_rows = read_jsonl(options.retrieval)
    available_conditions = sorted({row["condition"] for row in retrieval_rows})
    if options.retrieval_condition is None:
        if len(available_conditions) != 1:
            raise ValueError(f"--retrieval-condition is required; available={available_conditions}")
        retrieval_condition = available_conditions[0]
    else:
        retrieval_condition = options.retrieval_condition
        if retrieval_condition not in available_conditions:
            raise ValueError(f"retrieval condition not found: {retrieval_condition}; available={available_conditions}")
    retrieval = {
        row["question_id"]: row["results"][:options.k]
        for row in retrieval_rows if row["condition"] == retrieval_condition
    }
    gold_documents = {row["doc_id"]: row["content"] for row in read_jsonl(options.gold_documents)}
    scorer = LocalEvidenceScorer(questions, gold_documents)
    if len(retrieval) != len(questions):
        raise ValueError(f"input mismatch: questions={len(questions)}, retrieval={len(retrieval)}")

    strategies = [(count, full_top) for full_top in (0, 1) for count in range(1, 13)]
    candidates = {
        f"{'rank1-' if full_top else 'fixed-'}{count}": {
            question["id"]: compile_material(question, retrieval[question["id"]], count, full_top)
            for question in questions
        }
        for count, full_top in strategies
    }
    capped = {}
    for question in questions:
        ranked = [candidates[f"rank1-{count}"][question["id"]] for count in range(1, 13)]
        eligible_materials = [row for row in ranked if len(row["text"]) <= options.context_budget]
        capped[question["id"]] = max(eligible_materials or ranked[:1], key=lambda row: len(row["text"]))
    candidates["rank1-character-cap"] = capped
    full = {
        question["id"]: compile_material(question, retrieval[question["id"]], 0, options.k)
        for question in questions
    }
    development = [question for question in questions if question["split"] == "development"]
    diagnostic = [question for question in questions if question["split"] == "diagnostic"]
    matrix = {}
    for policy, dossiers in candidates.items():
        matrix[policy] = {
            "development": scorer.metrics(development, dossiers),
            "diagnostic": scorer.metrics(diagnostic, dossiers),
            "mean_characters": {
                "development": sum(len(dossiers[row["id"]]["text"]) for row in development) / len(development),
                "diagnostic": sum(len(dossiers[row["id"]]["text"]) for row in diagnostic) / len(diagnostic),
            },
        }
    eligible = [
        policy for policy in candidates
        if matrix[policy]["mean_characters"]["development"] <= options.context_budget
    ]
    selected = min(eligible, key=lambda policy: (
        -matrix[policy]["development"]["evidence_ceiling"],
        -matrix[policy]["development"]["evidence_unit_recall"],
        matrix[policy]["mean_characters"]["development"],
        policy,
    ))
    full_metrics = {
        "development": scorer.metrics(development, full),
        "diagnostic": scorer.metrics(diagnostic, full),
        "mean_characters": {
            "development": sum(len(full[row["id"]]["text"]) for row in development) / len(development),
            "diagnostic": sum(len(full[row["id"]]["text"]) for row in diagnostic) / len(diagnostic),
        },
    }

    options.output.mkdir(parents=True)
    write_rows(options.output / "full.jsonl", questions, full, f"vanilla-{retrieval_condition}-top10-full")
    write_rows(options.output / "budget.jsonl", questions, candidates[selected], f"vanilla-{retrieval_condition}-budget-question-only-{selected}")
    report = {
        "schema_version": "1.0",
        "experiment": "enterprise-rag-bench-strong-vanilla-materials",
        "retrieval_condition": retrieval_condition,
        "full_condition": f"vanilla-{retrieval_condition}-top10-full",
        "budget_condition": f"vanilla-{retrieval_condition}-budget-question-only-{selected}",
        "compile_contract": "The selected retrieval condition's top-10 document IDs are fixed. Full keeps every document. Budget candidates use only the question text, fixed span counts or a per-question character cap, and optionally preserve rank 1; Luna mode and obligations are excluded.",
        "selection_contract": "Select the budget candidate under the Fragrach development mean-character budget by development Evidence Ceiling, then Evidence Unit Recall, then smaller context. Diagnostic is not used.",
        "development_context_budget": options.context_budget,
        "selected_budget_policy": selected,
        "candidate_matrix": matrix,
        "full": full_metrics,
    }
    (options.output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
