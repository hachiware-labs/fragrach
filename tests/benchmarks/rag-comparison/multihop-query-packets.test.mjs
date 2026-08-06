import test from "node:test";
import assert from "node:assert/strict";

import {
  evidenceUnitMetrics,
  mentionedPublishers,
  queryClauses,
  sentencePassages,
} from "./multihop-query-packets.mjs";

test("質問文から独立した要求句を取り出す", () => {
  const clauses = queryClauses("Which company launched A, and what did its CEO say about B?");
  assert.equal(clauses.length, 2);
});

test("選択文の前後を根拠passageとして保持する", () => {
  const passages = sentencePassages("First sentence has context. Second sentence has the answer. Third sentence closes it.", "doc");
  assert.match(passages[1].text, /First sentence.*Second sentence.*Third sentence/);
});

test("質問に明記されたpublisherだけを抽出する", () => {
  assert.deepEqual(mentionedPublishers("reported by The Verge and TechCrunch", ["The Verge", "TechCrunch", "Reuters"]), ["The Verge", "TechCrunch"]);
});

test("文書IDだけでなくGold factを含むspanをEvidence Unitとして要求する", () => {
  const questions = [{
    id: "Q",
    gold_status: "verified",
    gold_evidence: { units: [{ source: "a", fact: "approved limit is 50" }] },
  }];
  const wrongSpan = new Map([["Q", [{ source: "packet", source_texts: { a: "document a without the answer" } }]]]);
  assert.equal(evidenceUnitMetrics(questions, wrongSpan).evidence_ceiling_at_k, 0);
  const rightSpan = new Map([["Q", [{ source: "packet", source_texts: { a: "The approved limit is 50." } }]]]);
  assert.equal(evidenceUnitMetrics(questions, rightSpan).evidence_ceiling_at_k, 1);
});
