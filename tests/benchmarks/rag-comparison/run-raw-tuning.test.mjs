import assert from "node:assert/strict";
import test from "node:test";

import {
  compareCandidates,
  splitQuestions,
} from "./run-raw-tuning.mjs";

test("splitQuestions is deterministic and keeps all questions", () => {
  const questions = Array.from({ length: 12 }, (_, index) => ({
    id: `M-Q-${String(index + 1).padStart(3, "0")}`,
    intent_id: index < 6 ? "first" : "second",
  }));
  const first = splitQuestions(questions);
  const second = splitQuestions([...questions].reverse());
  assert.deepEqual(
    first.development.map((item) => item.id).sort(),
    second.development.map((item) => item.id).sort(),
  );
  assert.deepEqual(
    [...first.development, ...first.holdout].map((item) => item.id).sort(),
    questions.map((item) => item.id).sort(),
  );
  assert.ok(first.holdout.length > 0);
});

test("compareCandidates prioritizes development R@5", () => {
  const candidate = (id, recall5, recall10) => ({
    id,
    chunk_count: 10,
    development: {
      recall_at_k: { "5": recall5, "10": recall10 },
      conflict_complete_rate_at_k: { "10": 0 },
      distractor_rate_at_k: { "5": 0.5 },
    },
  });
  const rows = [candidate("a", 0.7, 0.9), candidate("b", 0.8, 0.8)]
    .sort(compareCandidates);
  assert.equal(rows[0].id, "b");
});
