#!/usr/bin/env python
"""Compile Enterprise Position Dossiers with a development-fitted raw fallback gate."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

from enterprise_rag_bench_metrics import LocalEvidenceScorer


# The full dossier (68,896 characters on average) timed out during answer generation.
# 55k keeps the bounded run materially below that failed condition while allowing
# raw fallback for governance-sensitive question modes.
CONTEXT_BUDGET = 55_000


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--questions", type=Path, required=True)
    parser.add_argument("--obligations", type=Path, required=True)
    parser.add_argument("--retrieval", type=Path, required=True)
    parser.add_argument("--retrieval-condition")
    parser.add_argument("--gold-documents", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
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


def select_spans(document: dict, query_text: str, count: int, full_below_characters: int = 5000) -> str:
    content = document.get("content") or ""
    if count == 0 or len(content) <= full_below_characters:
        return content
    query_tokens = tokens(query_text)
    ranked = []
    for index, value in enumerate(windows(content)):
        overlap = query_tokens & tokens(value)
        score = sum(3 if any(character.isdigit() for character in token) or len(token) >= 9 else 1 for token in overlap)
        ranked.append((score, index, value))
    chosen = sorted(sorted(ranked, key=lambda item: (-item[0], item[1]))[:count], key=lambda item: item[1])
    return "\n\n[… position break …]\n\n".join(value for _, _, value in chosen)


def compile_dossier(
    question: dict,
    compiled: dict,
    results: list[dict],
    span_count: int,
    full_top_documents: int = 0,
    full_below_characters: int = 5000,
) -> dict:
    query_text = "\n".join([question["question"], *compiled["obligations"]])
    source_texts = {}
    sections = []
    for rank, result in enumerate(results, start=1):
        excerpt = select_spans(
            result,
            query_text,
            0 if rank <= full_top_documents else span_count,
            full_below_characters,
        )
        source_texts[result["doc_id"]] = f"{result['title']}\n\n{excerpt}"
        sections.append(f"SOURCE {result['doc_id']}\nTITLE: {result['title']}\n{excerpt}")
    return {
        "id": f"enterprise-position-dossier:{question['id']}",
        "mode": compiled["mode"],
        "obligations": compiled["obligations"],
        "sources": list(source_texts),
        "source_texts": source_texts,
        "text": "\n\n---\n\n".join(sections),
        "compile_span_count": "full" if span_count == 0 else span_count,
        "compile_full_top_documents": full_top_documents,
        "compile_full_below_characters": full_below_characters,
    }


def policy_strategy(policy: str, mode: str, obligation_count: int) -> tuple[int, int, int]:
    complex_mode = mode in {"conflict", "constraint", "list"}
    if policy == "fixed-6":
        return 6, 0, 5000
    if policy == "complex-8":
        return (8 if complex_mode else 6), 0, 5000
    if policy == "complex-10":
        return (10 if complex_mode else 6), 0, 5000
    if policy == "governance-full":
        return (0 if mode in {"conflict", "constraint"} else (8 if mode == "list" else 6)), 0, 5000
    if policy == "high-risk":
        return (0 if mode in {"conflict", "constraint"} else (10 if mode == "list" or obligation_count >= 3 else 6)), 0, 5000
    if policy == "obligations-3-full":
        return (0 if obligation_count >= 3 else 6), 0, 5000
    if policy == "complex-full":
        return (0 if complex_mode else 6), 0, 5000
    if policy == "rank1-6":
        return 6, 1, 5000
    if policy == "rank1-complex-8":
        return (8 if complex_mode else 6), 1, 5000
    if policy == "rank1-complex-10":
        return (10 if complex_mode else 6), 1, 5000
    if policy == "rank1-balanced":
        if mode in {"conflict", "constraint"}:
            return 8, 2, 5000
        if mode == "list" or obligation_count >= 3:
            return 8, 1, 5000
        return 6, 1, 5000
    if policy.startswith("rank1-governance"):
        threshold = 5000
        if "short8" in policy:
            threshold = 8000
        elif policy.endswith("short10"):
            threshold = 10000
        elif policy.endswith("short12"):
            threshold = 12000
        if mode in {"conflict", "constraint"}:
            return 10, 2, threshold
        if mode == "list" or obligation_count >= 3:
            return 10, 1, threshold
        return (5 if policy.endswith("short8-lean") else 6), 1, threshold
    raise ValueError(f"unknown policy: {policy}")


def main() -> None:
    options = parse_args()
    if options.output.exists():
        raise FileExistsError(f"output already exists: {options.output}")
    questions = [q for q in read_jsonl(options.questions) if q["split"] in {"development", "diagnostic"}]
    obligations = {row["question_id"]: row for row in read_jsonl(options.obligations)}
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
    evidence_scorer = LocalEvidenceScorer(questions, gold_documents)
    if len(questions) != len(obligations) or len(questions) != len(retrieval):
        raise ValueError(f"input mismatch: questions={len(questions)}, obligations={len(obligations)}, retrieval={len(retrieval)}")

    policies = (
        "fixed-6", "complex-8", "complex-10", "governance-full", "high-risk",
        "obligations-3-full", "complex-full", "rank1-6", "rank1-complex-8",
        "rank1-complex-10", "rank1-balanced", "rank1-governance",
        "rank1-governance-short8", "rank1-governance-short10", "rank1-governance-short12",
        "rank1-governance-short8-lean",
    )
    strategies = {
        policy_strategy(policy, compiled["mode"], len(compiled["obligations"]))
        for policy in policies for compiled in obligations.values()
    }
    span_candidates = {
        strategy: {
            question["id"]: compile_dossier(
                question,
                obligations[question["id"]],
                retrieval[question["id"]],
                strategy[0],
                strategy[1],
                strategy[2],
            )
            for question in questions
        }
        for strategy in strategies
    }
    candidates = {}
    for policy in policies:
        candidates[policy] = {}
        for question in questions:
            compiled = obligations[question["id"]]
            strategy = policy_strategy(policy, compiled["mode"], len(compiled["obligations"]))
            candidates[policy][question["id"]] = span_candidates[strategy][question["id"]]

    development = [q for q in questions if q["split"] == "development"]
    diagnostic = [q for q in questions if q["split"] == "diagnostic"]
    matrix = {}
    for policy, dossiers in candidates.items():
        development_chars = sum(len(dossiers[q["id"]]["text"]) for q in development) / len(development)
        diagnostic_chars = sum(len(dossiers[q["id"]]["text"]) for q in diagnostic) / len(diagnostic)
        full_fallbacks = sum(dossier["compile_span_count"] == "full" for dossier in dossiers.values())
        matrix[policy] = {
            "development": evidence_scorer.metrics(development, dossiers),
            "diagnostic": evidence_scorer.metrics(diagnostic, dossiers),
            "mean_characters": {"development": development_chars, "diagnostic": diagnostic_chars},
            "full_fallback_rate": full_fallbacks / len(dossiers),
        }

    eligible = [policy for policy in policies if matrix[policy]["mean_characters"]["development"] <= CONTEXT_BUDGET]
    selected = min(eligible, key=lambda policy: (
        -matrix[policy]["development"]["evidence_ceiling"],
        -matrix[policy]["development"]["evidence_unit_recall"],
        matrix[policy]["mean_characters"]["development"],
        policy,
    ))
    dossiers = candidates[selected]
    rows = [{
        "condition": f"fragrach-{retrieval_condition}-adaptive-dossier-{selected}",
        "question_id": question["id"],
        "split": question["split"],
        "category": question["category"],
        "results": [dossiers[question["id"]]],
    } for question in questions]
    report = {
        "schema_version": "1.0",
        "experiment": "enterprise-rag-bench-adaptive-position-dossier",
        "retrieval_condition": retrieval_condition,
        "output_condition": f"fragrach-{retrieval_condition}-adaptive-dossier-{selected}",
        "compile_contract": "The selected retrieval condition's top-10 document IDs stay fixed. The runtime gate uses only Luna obligation mode and count; Gold facts and answers are excluded. Each selected dossier remains one indivisible answer material.",
        "evidence_contract": "A Gold Evidence Unit is present only when one 256-token source-local window retains every exact numeric/identifier anchor found in the audited Gold source and at least 80% of that Gold window's IDF-weighted lexical coverage. Gold source fingerprints are evaluator-only and never enter compilation.",
        "selection_contract": f"Among policies whose development mean is at most {CONTEXT_BUDGET} characters, choose by development Evidence Ceiling, then Evidence Unit Recall, then smaller development context. Diagnostic is not used for selection.",
        "selected_policy": selected,
        "development_context_budget": CONTEXT_BUDGET,
        "candidate_matrix": matrix,
    }
    options.output.mkdir(parents=True)
    with (options.output / "retrieval.jsonl").open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    (options.output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
