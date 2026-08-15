import assert from "node:assert/strict";
import test from "node:test";

import {
  bootstrapMeanInterval,
  enterpriseFragrach500Summary,
  pairedBootstrapDifference,
  wilsonInterval,
} from "./summarize-final-metrics.mjs";

test("Enterprise Fragrach 500はRecallだけを集計し回答指標を未計測にする", () => {
  const result = enterpriseFragrach500Summary({
    experiment: "enterprise-500",
    phase: "pipeline",
    retrieval_contract: { corpus_documents: 500, chunks: 4_121 },
    question_counts: {
      selected: 61,
      by_legacy_split: { development: 16, diagnostic: 24, holdout: 21 },
    },
    overall: { at_k: { "5": { document_recall: 0.885 } } },
    by_legacy_split: {
      holdout: { questions: 21, at_k: { "5": { document_recall: 0.957 } } },
    },
  });
  assert.equal(result.corpus_documents, 500);
  assert.equal(result.selected.questions, 61);
  assert.equal(result.selected.recall, 0.885);
  assert.equal(result.holdout.recall, 0.957);
  assert.equal(result.selected.accuracy, null);
  assert.equal(result.selected.dvaa, null);
});

test("Wilson interval contains the observed proportion", () => {
  const [lower, upper] = wilsonInterval(192, 200);
  assert.ok(lower < 0.96);
  assert.ok(upper > 0.96);
});

test("Wilson interval reports an exact zero lower bound for zero successes", () => {
  const [lower] = wilsonInterval(0, 200);
  assert.equal(lower, 0);
});

test("paired bootstrap preserves a constant difference", () => {
  const result = pairedBootstrapDifference([0, 0, 0], [1, 1, 1], 500, 42);
  assert.equal(result.difference, 1);
  assert.deepEqual(result.ci95, [1, 1]);
});

test("bootstrap is deterministic for a fixed seed", () => {
  const first = bootstrapMeanInterval([0, 1, 1, 0, 1], 1_000, 1234);
  const second = bootstrapMeanInterval([0, 1, 1, 0, 1], 1_000, 1234);
  assert.deepEqual(first, second);
});
