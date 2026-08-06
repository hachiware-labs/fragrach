import test from "node:test";
import assert from "node:assert/strict";

import { buildScaleCorpusPlan } from "./generate-dynamic-validity-scale-corpus.mjs";

test("scale corpusは系列単位でdevelopmentとholdoutを分離する", () => {
  const plan = buildScaleCorpusPlan();
  const development = new Set(plan.questions.filter((question) => question.split === "development").map((question) => question.family_id));
  const holdout = new Set(plan.questions.filter((question) => question.split === "holdout").map((question) => question.family_id));
  assert.equal(development.size, 20);
  assert.equal(holdout.size, 30);
  assert.equal([...development].some((family) => holdout.has(family)), false);
});

test("scale corpusは788背景文書、200動的長文、100問を持つ", () => {
  const plan = buildScaleCorpusPlan();
  assert.equal(plan.backgrounds.length, 788);
  assert.equal(plan.contents.size, 200);
  assert.equal(plan.documents.length, 988);
  assert.equal(plan.profiles.length, 988);
  assert.equal(plan.questions.length, 100);
  assert.equal([...plan.contents.values()].every((content) => content.length >= 2500), true);
});

test("動的文書は文書番号と版を持ち、変更文書は四値の位置づけを宣言する", () => {
  const plan = buildScaleCorpusPlan();
  const contents = [...plan.contents.values()];
  assert.equal(contents.every((content) => content.includes("\ndocument_id: ")), true);
  assert.equal(contents.every((content) => content.includes("\nrevision: ")), true);
  assert.equal(contents.filter((content) => content.includes("\nposition: ")).length, 90);
  assert.equal(contents.some((content) => content.includes('position: "dominates"')), true);
  assert.equal(contents.some((content) => content.includes('position: "conditional"')), true);
  assert.equal(contents.some((content) => content.includes('position: "non_effective"')), true);
  assert.equal(contents.some((content) => content.includes('position: "unresolved"')), true);
});

test("volume trackは200系列を開発40・検証40・最終holdout 120へ分離する", () => {
  const plan = buildScaleCorpusPlan({ cohorts: 4 });
  const families = (split) => new Set(plan.questions
    .filter((question) => question.split === split)
    .map((question) => question.family_id));
  const development = families("development");
  const validation = families("validation");
  const finalHoldout = families("final_holdout");

  assert.equal(plan.contents.size, 800);
  assert.equal(plan.documents.length, 1_588);
  assert.equal(plan.questions.length, 400);
  assert.equal(development.size, 40);
  assert.equal(validation.size, 40);
  assert.equal(finalHoldout.size, 120);
  assert.equal([...development].some((family) => validation.has(family) || finalHoldout.has(family)), false);
  assert.equal([...validation].some((family) => finalHoldout.has(family)), false);
});
