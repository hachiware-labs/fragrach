from __future__ import annotations

import unittest

from enterprise_rag_bench_metrics import LocalEvidenceScorer


class LocalEvidenceScorerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.unit = {
            "source": "doc-1",
            "fact": "Each contract ledger entry must include service_a and run_id.",
        }
        self.question = {
            "id": "q-1",
            "gold_status": "verified",
            "gold_evidence": {"units": [self.unit]},
        }
        self.scorer = LocalEvidenceScorer(
            [self.question],
            {"doc-1": "Required columns: timestamp, service_a, endpoint, result, run_id."},
        )

    def test_rejects_document_wide_common_word_overlap_without_exact_anchors(self) -> None:
        material = (
            "Each contract has a ledger. Every entry must include required data. "
            "The service publishes results and a run produces an identifier."
        )
        self.assertFalse(self.scorer.unit_complete(self.unit, material))

    def test_accepts_one_local_window_with_gold_source_anchors(self) -> None:
        material = "Required ledger columns include service_a and run_id for each contract entry."
        self.assertTrue(self.scorer.unit_complete(self.unit, material))

    def test_accepts_eighty_percent_local_coverage_when_anchor_is_present(self) -> None:
        unit = {"source": "doc-2", "fact": "alpha beta gamma delta run_id"}
        question = {"id": "q-2", "gold_status": "verified", "gold_evidence": {"units": [unit]}}
        scorer = LocalEvidenceScorer([question], {"doc-2": "alpha beta gamma delta run_id"})
        self.assertTrue(scorer.unit_complete(unit, "alpha beta gamma run_id"))

    def test_rejects_high_coverage_when_exact_anchor_is_missing(self) -> None:
        unit = {"source": "doc-2", "fact": "alpha beta gamma delta run_id"}
        question = {"id": "q-2", "gold_status": "verified", "gold_evidence": {"units": [unit]}}
        scorer = LocalEvidenceScorer([question], {"doc-2": "alpha beta gamma delta run_id"})
        self.assertFalse(scorer.unit_complete(unit, "alpha beta gamma delta"))


if __name__ == "__main__":
    unittest.main()
