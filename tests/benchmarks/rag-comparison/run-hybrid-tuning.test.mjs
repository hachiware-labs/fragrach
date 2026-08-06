import assert from "node:assert/strict";
import test from "node:test";

import {
  DenseIndex,
  embeddingProfiles,
  weightedReciprocalRankFusion,
} from "./run-hybrid-tuning.mjs";

test("embedding profileはモデル固有の検索接頭辞を付ける", () => {
  assert.match(embeddingProfiles.qwen3.query("期限は？"), /Instruct:/);
  assert.equal(embeddingProfiles.ruri.query("期限は？"), "クエリ: 期限は？");
  assert.equal(embeddingProfiles.ruri.passage("本文"), "文章: 本文");
});

test("DenseIndexはcosine類似度の高い文書を上位へ返す", () => {
  const documents = [{ id: "a", domain: "x" }, { id: "b", domain: "y" }, { id: "c", domain: "x" }];
  const index = new DenseIndex(
    documents,
    new Float32Array([1, 0, 0.8, 0.2, 0, 1]),
    2,
  );
  assert.deepEqual(
    index.search([1, 0], 3).map((item) => item.document.id),
    ["a", "b", "c"],
  );
  assert.deepEqual(
    index.search([1, 0], 3, (document) => document.domain === "y").map((item) => item.document.id),
    ["b"],
  );
});

test("重み付きRRFは両検索で上位の文書を優先する", () => {
  const documents = Object.fromEntries(
    ["a", "b", "c"].map((id) => [id, { id }]),
  );
  const sparse = ["a", "b"].map((id) => ({ document: documents[id], score: 1 }));
  const dense = ["c", "b"].map((id) => ({ document: documents[id], score: 1 }));
  const result = weightedReciprocalRankFusion(sparse, dense, 0.5, 3);
  assert.equal(result[0].document.id, "b");
  assert.equal(result[0].sparse_rank, 2);
  assert.equal(result[0].dense_rank, 2);
});
