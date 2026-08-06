import test from "node:test";
import assert from "node:assert/strict";

import { retrievalMetrics } from "./run-multihop-rag-retrieval.mjs";

test("R@kと全Evidence文書完備を分けて測る", () => {
  const questions = [{
    id: "Q1",
    gold_status: "verified",
    gold_evidence: { sources: ["a", "b"] },
  }];
  const partial = new Map([["Q1", [{ source: "a" }]]]);
  assert.deepEqual(retrievalMetrics(questions, partial, 5), {
    questions: 1,
    document_recall_at_k: 0.5,
    evidence_ceiling_at_k: 0,
  });
  partial.get("Q1").push({ source: "b" });
  assert.deepEqual(retrievalMetrics(questions, partial, 5), {
    questions: 1,
    document_recall_at_k: 1,
    evidence_ceiling_at_k: 1,
  });
});

test("Gold文書を持たないnull質問は通常Recallの分母へ入れない", () => {
  const questions = [{ id: "Q0", gold_status: "verified", gold_evidence: { sources: [] } }];
  assert.deepEqual(retrievalMetrics(questions, new Map([["Q0", []]]), 5), {
    questions: 0,
    document_recall_at_k: null,
    evidence_ceiling_at_k: null,
  });
});
