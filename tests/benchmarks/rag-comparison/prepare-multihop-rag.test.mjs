import test from "node:test";
import assert from "node:assert/strict";

import {
  assignPilotSplits,
  documentId,
  factCoverage,
} from "./prepare-multihop-rag.mjs";

test("URLから安定した文書IDを作る", () => {
  assert.equal(documentId("https://example.com/a"), documentId("https://example.com/a"));
  assert.notEqual(documentId("https://example.com/a"), documentId("https://example.com/b"));
});

test("Gold factの語が原文に含まれる割合を測る", () => {
  assert.equal(factCoverage("Policy allows short lived cache", "The policy allows a short-lived cache."), 1);
  assert.ok(factCoverage("unrelated missing words", "The policy allows a cache") < 0.5);
});

test("質問型ごとに開発・診断・holdoutを同数だけ固定する", () => {
  const rows = ["a", "b"].flatMap((type) => Array.from({ length: 9 }, (_, index) => ({
    question_type: type,
    query: `${type}-${index}`,
    answer: String(index),
  })));
  const splits = assignPilotSplits(rows, 2);
  for (const type of ["a", "b"]) {
    const selected = rows.filter((row) => row.question_type === type);
    assert.equal(selected.filter((row) => splits.get(row) === "development").length, 2);
    assert.equal(selected.filter((row) => splits.get(row) === "diagnostic").length, 2);
    assert.equal(selected.filter((row) => splits.get(row) === "holdout").length, 2);
    assert.equal(selected.filter((row) => splits.get(row) === "reserve").length, 3);
  }
});
