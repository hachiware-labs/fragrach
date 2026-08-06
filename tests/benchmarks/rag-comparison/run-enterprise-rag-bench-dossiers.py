#!/usr/bin/env python
"""Compile query-relative EnterpriseRAG-Bench dossiers and compare them with BM25."""

from __future__ import annotations

import argparse
import json
import re
from collections import defaultdict
from pathlib import Path

import tantivy

from enterprise_rag_bench_metrics import LocalEvidenceScorer


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--index", type=Path, required=True)
    parser.add_argument("--questions", type=Path, required=True)
    parser.add_argument("--obligations", type=Path, required=True)
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--gold-documents", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--search-k", type=int, default=30)
    parser.add_argument("--result-k", type=int, default=10)
    return parser.parse_args()


def read_jsonl(file: Path) -> list[dict]:
    return [json.loads(line) for line in file.read_text(encoding="utf-8").splitlines() if line]


def score(questions: list[dict], retrieval: dict[str, list[dict]], k: int, scorer: LocalEvidenceScorer) -> dict:
    dossiers = {
        question["id"]: {"source_texts": {
            row["doc_id"]: f"{row['title']}\n\n{row['content']}"
            for row in retrieval[question["id"]][:k]
        }}
        for question in questions
    }
    metrics = scorer.metrics(questions, dossiers)
    return {
        "questions": metrics["questions"],
        "evidence_unit_recall_at_k": metrics["evidence_unit_recall"],
        "evidence_ceiling_at_k": metrics["evidence_ceiling"],
    }


def condition_order(matrix: dict[str, dict], split: str = "development") -> list[str]:
    return sorted(matrix, key=lambda condition: (
        -matrix[condition][split]["evidence_ceiling_at_k"],
        -matrix[condition][split]["evidence_unit_recall_at_k"],
        condition != "bm25",
        condition,
    ))


def obligation_count_bucket(row: dict) -> str:
    count = len(row["obligations"])
    return str(count) if count < 3 else "3+"


def build_development_gate(
    *,
    questions: list[dict],
    development: list[dict],
    obligations: dict[str, dict],
    candidates: dict[str, dict[str, list[dict]]],
    scorer: LocalEvidenceScorer,
    result_k: int,
    feature: str,
    minimum_group_questions: int = 12,
) -> tuple[dict[str, list[dict]], dict]:
    def value(question: dict) -> str:
        compiled = obligations[question["id"]]
        if feature == "mode":
            return compiled["mode"]
        if feature == "obligation-count":
            return obligation_count_bucket(compiled)
        raise ValueError(f"unknown gate feature: {feature}")

    groups = sorted({value(question) for question in questions})
    assignments = {}
    group_reports = {}
    for group in groups:
        rows = [question for question in development if value(question) == group]
        if len(rows) < minimum_group_questions:
            assignments[group] = "bm25"
            group_reports[group] = {
                "development_questions": len(rows),
                "selected_condition": "bm25",
                "selection_reason": f"fallback: fewer than {minimum_group_questions} development questions",
            }
            continue
        matrix = {
            condition: {"development": score(rows, retrieval, result_k, scorer)}
            for condition, retrieval in candidates.items()
        }
        selected = condition_order(matrix)[0]
        assignments[group] = selected
        group_reports[group] = {
            "development_questions": len(rows),
            "selected_condition": selected,
            "selection_reason": "development Evidence Ceiling, then Evidence Unit Recall; BM25 wins exact ties",
            "candidate_metrics": {condition: metrics["development"] for condition, metrics in matrix.items()},
        }

    retrieval = {
        question["id"]: candidates[assignments.get(value(question), "bm25")][question["id"]]
        for question in questions
    }
    return retrieval, {
        "feature": feature,
        "minimum_development_questions": minimum_group_questions,
        "runtime_inputs": "Luna-compiled mode or obligation count only; no Gold labels at runtime",
        "groups": group_reports,
    }


def build_threshold_gate(
    *,
    questions: list[dict],
    development: list[dict],
    candidates: dict[str, dict[str, list[dict]]],
    scorer: LocalEvidenceScorer,
    result_k: int,
    signal: str,
) -> tuple[dict[str, list[dict]], dict]:
    bm25 = candidates["bm25"]
    alternative_name = "rrf-0.5"
    alternative = candidates[alternative_name]

    def signal_value(question: dict) -> float:
        original = bm25[question["id"]][:result_k]
        expanded = alternative[question["id"]][:result_k]
        if signal == "top10-overlap":
            original_ids = {row["doc_id"] for row in original}
            expanded_ids = {row["doc_id"] for row in expanded}
            return len(original_ids & expanded_ids) / max(len(original_ids | expanded_ids), 1)
        if signal == "bm25-margin":
            if len(original) < 2:
                return 1.0
            return (original[0]["score"] - original[1]["score"]) / max(abs(original[0]["score"]), 1e-12)
        raise ValueError(f"unknown threshold signal: {signal}")

    values = {question["id"]: signal_value(question) for question in questions}
    thresholds = [-1.0, *sorted({values[question["id"]] for question in development})]
    trials = []
    for threshold in thresholds:
        retrieval = {
            question["id"]: (alternative if values[question["id"]] <= threshold else bm25)[question["id"]]
            for question in questions
        }
        metrics = score(development, retrieval, result_k, scorer)
        switches = sum(values[question["id"]] <= threshold for question in development)
        trials.append((metrics, switches, threshold, retrieval))
    metrics, development_switches, threshold, retrieval = sorted(trials, key=lambda row: (
        -row[0]["evidence_ceiling_at_k"],
        -row[0]["evidence_unit_recall_at_k"],
        row[1],
        row[2],
    ))[0]
    split_switches = {
        split: sum(values[question["id"]] <= threshold for question in questions if question["split"] == split)
        for split in ("development", "diagnostic")
    }
    return retrieval, {
        "signal": signal,
        "alternative_condition": alternative_name,
        "rule": f"use {alternative_name} when {signal} <= selected threshold; otherwise use BM25",
        "selected_threshold": threshold,
        "development_metrics": metrics,
        "switches": split_switches,
        "selection_contract": "Threshold selected only on development Evidence Ceiling, then Evidence Unit Recall; exact ties minimize RRF switches.",
    }


def search(searcher, index, query_text: str, limit: int) -> list[dict]:
    query, _ = index.parse_query_lenient(query_text, ["text"])
    rows = []
    for rank, (bm25_score, address) in enumerate(searcher.search(query, limit=limit).hits, start=1):
        stored = searcher.doc(address).to_dict()
        rows.append({
            "rank": rank,
            "score": bm25_score,
            "doc_id": stored["doc_id"][0],
            "source_type": stored["source_type"][0],
            "title": stored["title"][0],
            "content": stored["content"][0],
        })
    return rows


def rrf(original: list[dict], obligation_runs: list[list[dict]], weight: float, k: int) -> list[dict]:
    documents = {}
    scores = defaultdict(float)
    provenance = defaultdict(list)
    for row in original:
        documents[row["doc_id"]] = row
        scores[row["doc_id"]] += 1.0 / (20 + row["rank"])
        provenance[row["doc_id"]].append({"query": "original", "rank": row["rank"]})
    for obligation_index, rows in enumerate(obligation_runs):
        for row in rows:
            documents[row["doc_id"]] = row
            scores[row["doc_id"]] += weight / (20 + row["rank"])
            provenance[row["doc_id"]].append({"query": obligation_index, "rank": row["rank"]})
    ranked = sorted(documents.values(), key=lambda row: (-scores[row["doc_id"]], row["doc_id"]))[:k]
    return [{**row, "rank": rank, "dossier_score": scores[row["doc_id"]], "retrieval_provenance": provenance[row["doc_id"]]}
            for rank, row in enumerate(ranked, start=1)]


def round_robin(original: list[dict], obligation_runs: list[list[dict]], per_obligation: int, k: int) -> list[dict]:
    selected = []
    seen = set()
    provenance = defaultdict(list)
    for obligation_index, rows in enumerate(obligation_runs):
        added = 0
        for row in rows:
            if row["doc_id"] in seen:
                continue
            selected.append(row)
            seen.add(row["doc_id"])
            provenance[row["doc_id"]].append({"query": obligation_index, "rank": row["rank"]})
            added += 1
            if added >= per_obligation or len(selected) >= k:
                break
        if len(selected) >= k:
            break
    for row in original:
        if len(selected) >= k:
            break
        if row["doc_id"] not in seen:
            selected.append(row)
            seen.add(row["doc_id"])
            provenance[row["doc_id"]].append({"query": "original", "rank": row["rank"]})
    return [{**row, "rank": rank, "retrieval_provenance": provenance[row["doc_id"]]}
            for rank, row in enumerate(selected, start=1)]


def main() -> None:
    options = parse_args()
    if options.output.exists():
        raise FileExistsError(f"output already exists: {options.output}")
    questions = [q for q in read_jsonl(options.questions) if q["split"] in {"development", "diagnostic"}]
    obligations = {row["question_id"]: row for row in read_jsonl(options.obligations)}
    baseline_rows = read_jsonl(options.baseline)
    baseline = {row["question_id"]: row["results"] for row in baseline_rows if row["question_id"] in obligations}
    gold_documents = {row["doc_id"]: row["content"] for row in read_jsonl(options.gold_documents)}
    evidence_scorer = LocalEvidenceScorer(questions, gold_documents)
    if len(obligations) != len(questions) or len(baseline) != len(questions):
        raise ValueError(f"input mismatch: questions={len(questions)}, obligations={len(obligations)}, baseline={len(baseline)}")

    index = tantivy.Index.open(str(options.index))
    searcher = index.searcher()
    obligation_retrieval = {}
    for position, question in enumerate(questions, start=1):
        obligation_retrieval[question["id"]] = [
            search(searcher, index, obligation, options.search_k)
            for obligation in obligations[question["id"]]["obligations"]
        ]
        if position % 25 == 0:
            print(json.dumps({"searched": position}), flush=True)

    candidates = {"bm25": {question["id"]: baseline[question["id"]][:options.result_k] for question in questions}}
    for weight in (0.25, 0.5, 1.0, 2.0):
        key = f"rrf-{weight:g}"
        candidates[key] = {
            question["id"]: rrf(baseline[question["id"]], obligation_retrieval[question["id"]], weight, options.result_k)
            for question in questions
        }
    for quota in (1, 2):
        key = f"round-robin-{quota}"
        candidates[key] = {
            question["id"]: round_robin(baseline[question["id"]], obligation_retrieval[question["id"]], quota, options.result_k)
            for question in questions
        }

    splits = {name: [q for q in questions if q["split"] == name] for name in ("development", "diagnostic")}
    atomic_candidates = dict(candidates)
    gate_definitions = {}
    for feature in ("mode", "obligation-count"):
        key = f"development-gate-{feature}"
        candidates[key], gate_definitions[key] = build_development_gate(
            questions=questions,
            development=splits["development"],
            obligations=obligations,
            candidates=atomic_candidates,
            scorer=evidence_scorer,
            result_k=options.result_k,
            feature=feature,
        )
    threshold_gate_definitions = {}
    for signal in ("top10-overlap", "bm25-margin"):
        key = f"development-threshold-{signal}"
        candidates[key], threshold_gate_definitions[key] = build_threshold_gate(
            questions=questions,
            development=splits["development"],
            candidates=atomic_candidates,
            scorer=evidence_scorer,
            result_k=options.result_k,
            signal=signal,
        )
    matrix = {condition: {split: score(rows, retrieval, options.result_k, evidence_scorer) for split, rows in splits.items()}
              for condition, retrieval in candidates.items()}
    ranked = condition_order(matrix)
    selected = ranked[0]
    selected_retrieval = candidates[selected]
    by_mode = {}
    by_category = {}
    for mode in sorted({row["mode"] for row in obligations.values()}):
        rows = [q for q in splits["diagnostic"] if obligations[q["id"]]["mode"] == mode]
        by_mode[mode] = score(rows, selected_retrieval, options.result_k, evidence_scorer)
    for category in sorted({q["category"] for q in splits["diagnostic"]}):
        rows = [q for q in splits["diagnostic"] if q["category"] == category]
        by_category[category] = score(rows, selected_retrieval, options.result_k, evidence_scorer)

    report = {
        "schema_version": "1.0",
        "experiment": "enterprise-rag-bench-query-relative-dossier",
        "selection_contract": "Select one retrieval condition by development Evidence Ceiling@10, then Evidence Unit Recall@10; diagnostic is never used for selection.",
        "answer_material_contract": "Only retrieved source documents enter the dossier; generated obligations and retrieval scores are control metadata, not answer evidence.",
        "evidence_contract": "Source-local 256-token anchored evidence definition with 80% Gold-window-relative lexical coverage; evaluator-only Gold source fingerprints never enter retrieval.",
        "selected_condition": selected,
        "candidate_matrix": matrix,
        "development_gate_definitions": gate_definitions,
        "development_threshold_gate_definitions": threshold_gate_definitions,
        "selected_diagnostic_by_mode": by_mode,
        "selected_diagnostic_by_category": by_category,
    }
    options.output.mkdir(parents=True)
    with (options.output / "retrieval.jsonl").open("w", encoding="utf-8") as handle:
        for question in questions:
            compiled = obligations[question["id"]]
            handle.write(json.dumps({
                "condition": f"fragrach-enterprise-dossier-{selected}",
                "question_id": question["id"],
                "split": question["split"],
                "category": question["category"],
                "mode": compiled["mode"],
                "obligations": compiled["obligations"],
                "results": selected_retrieval[question["id"]],
            }, ensure_ascii=False) + "\n")
    (options.output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
