import assert from "node:assert/strict";
import test from "node:test";

import { buildScaleCorpusPlan } from "./generate-dynamic-validity-scale-corpus.mjs";
import { practicalQuestion, practicalScenario } from "./generate-dynamic-validity-practical-corpus.mjs";

test("practical corpusは既観測200系列と未観測100系列を分離する", () => {
  const plan = buildScaleCorpusPlan({ cohorts: 6, transformScenario: practicalScenario });
  const archive = plan.questions.filter((question) => question.split === "archive");
  const practical = plan.questions.filter((question) => question.split === "practical_holdout");

  assert.equal(archive.length, 400);
  assert.equal(practical.length, 200);
  assert.equal(new Set(practical.map((question) => question.family_id)).size, 100);
  assert.ok(practical.every((question) => Number(question.family_id.slice(4)) >= 201));
});

test("practical questionはGoldを変えず複数種類の表記揺れを持つ", () => {
  const row = {
    id: "DVX-201-A",
    question: "北関東第5工場の受入部材の抜取検査について、抜取頻度はいくつですか。",
    split: "archive",
    stages: { T0: { answer_values: ["10台ごとに1台"] }, T1: { answer_values: ["20台ごとに1台"] } },
  };
  const scenario = { index: 200, siteName: "北関東第5工場" };
  const transformed = practicalQuestion(row, { scenario, suffix: "A" });

  assert.equal(transformed.split, "practical_holdout");
  assert.equal(transformed.canonical_question, row.question);
  assert.notEqual(transformed.question, row.question);
  assert.match(transformed.question, /受け入れ部材の抜き取り検査/);
  assert.match(transformed.question, /何台に1台/);
  assert.ok(transformed.surface_variations.length >= 3);
  assert.deepEqual(transformed.stages, row.stages);
});
