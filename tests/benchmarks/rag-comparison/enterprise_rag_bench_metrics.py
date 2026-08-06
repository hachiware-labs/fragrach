"""Shared, source-local evidence metrics for EnterpriseRAG-Bench experiments."""

from __future__ import annotations

import math
import re
from collections import Counter


TOKEN_PATTERN = re.compile(r"[a-z0-9]+(?:[_.:/-][a-z0-9]+)*")
WINDOW_TOKENS = 256
WINDOW_STRIDE = 32
REFERENCE_RATIO = 0.80


def tokens(text: str) -> list[str]:
    return TOKEN_PATTERN.findall(text.lower())


def is_anchor(token: str) -> bool:
    """Return true for exact identifiers, paths, versions, numbers, and metrics."""
    return any(character.isdigit() for character in token) or any(character in token for character in "_.:/")


class LocalEvidenceScorer:
    """Compare material with the best source-local lexical fingerprint of each Gold fact.

    The original Gold source is used only by the evaluator. Compilation never sees the
    resulting fingerprint. Exact anchors are required only when they occur literally in
    the Gold source, so semantic paraphrases in audited Gold are not invented as anchors.
    """

    def __init__(self, questions: list[dict], gold_documents: dict[str, str]):
        units = [
            unit
            for question in questions
            if question.get("gold_status") == "verified"
            for unit in question.get("gold_evidence", {}).get("units", [])
        ]
        document_frequency = Counter()
        for unit in units:
            document_frequency.update(set(tokens(unit["fact"])))
        population = max(len(units), 1)
        self.weights = {
            token: math.log((population + 1) / (frequency + 1)) + 1
            for token, frequency in document_frequency.items()
        }
        self.gold_documents = gold_documents
        self.references = {}
        for unit in units:
            key = (unit["source"], unit["fact"])
            if key not in self.references:
                self.references[key] = self._reference(unit["fact"], gold_documents.get(unit["source"], ""))

    def _windows(self, values: list[str]) -> list[list[str]]:
        if len(values) <= WINDOW_TOKENS:
            return [values]
        starts = list(range(0, len(values) - WINDOW_TOKENS + 1, WINDOW_STRIDE))
        final_start = len(values) - WINDOW_TOKENS
        if starts[-1] != final_start:
            starts.append(final_start)
        return [values[start:start + WINDOW_TOKENS] for start in starts]

    def _coverage(self, fact_tokens: set[str], present: set[str]) -> float:
        denominator = sum(self.weights.get(token, 1.0) for token in fact_tokens)
        numerator = sum(self.weights.get(token, 1.0) for token in fact_tokens if token in present)
        return numerator / max(denominator, 1.0)

    def _reference(self, fact: str, source_text: str) -> dict:
        fact_tokens = set(tokens(fact))
        source_tokens = tokens(source_text)
        source_present = set(source_tokens)
        available_anchors = {token for token in fact_tokens if is_anchor(token) and token in source_present}
        ranked = []
        for index, window in enumerate(self._windows(source_tokens)):
            present = set(window)
            anchors = available_anchors & present
            ranked.append((len(anchors), self._coverage(fact_tokens, present), -index, anchors))
        anchor_count, coverage, _, anchors = max(ranked, default=(0, 0.0, 0, set()))
        return {
            "fact_tokens": fact_tokens,
            "anchors": anchors if anchor_count else set(),
            "coverage": coverage,
        }

    def unit_complete(self, unit: dict, material_text: str) -> bool:
        reference = self.references[(unit["source"], unit["fact"])]
        required_anchors = reference["anchors"]
        required_coverage = reference["coverage"] * REFERENCE_RATIO
        for window in self._windows(tokens(material_text)):
            present = set(window)
            if not required_anchors.issubset(present):
                continue
            if self._coverage(reference["fact_tokens"], present) >= required_coverage:
                return True
        return False

    def question_complete(self, question: dict, source_texts: dict[str, str]) -> bool:
        return all(
            self.unit_complete(unit, source_texts.get(unit["source"], ""))
            for unit in question["gold_evidence"]["units"]
        )

    def metrics(self, questions: list[dict], dossiers: dict[str, dict]) -> dict:
        verified = [
            question for question in questions
            if question["gold_status"] == "verified" and question["gold_evidence"]["units"]
        ]
        recalls = []
        complete = 0
        for question in verified:
            source_texts = dossiers[question["id"]]["source_texts"]
            hits = sum(
                self.unit_complete(unit, source_texts.get(unit["source"], ""))
                for unit in question["gold_evidence"]["units"]
            )
            recalls.append(hits / len(question["gold_evidence"]["units"]))
            complete += hits == len(question["gold_evidence"]["units"])
        return {
            "questions": len(verified),
            "evidence_unit_recall": sum(recalls) / max(len(recalls), 1),
            "evidence_ceiling": complete / max(len(verified), 1),
        }
