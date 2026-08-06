import test from "node:test";
import assert from "node:assert/strict";

import {
  answerPrompt, answerSchema, concurrentMap, normalizeResults, parseConditionArgument,
} from "./run-dynamic-validity-answers.mjs";

test("任意の検索条件を回答評価へ渡せる", () => {
  assert.deepEqual(
    parseConditionArgument("Fragrach-Ruri-Packet,fragrach-ruri-packet-t1.jsonl,T1"),
    { name: "Fragrach-Ruri-Packet", file: "fragrach-ruri-packet-t1.jsonl", stage: "T1" },
  );
  assert.throws(() => parseConditionArgument("broken"), /NAME,FILE/);
});

test("並列batchは上限を守りながら入力順へ結果を戻す", async () => {
  let active = 0;
  let maximum = 0;
  const results = await concurrentMap([20, 5, 10, 1], 2, async (delay, index) => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, delay));
    active -= 1;
    return `row-${index}`;
  });

  assert.deepEqual(results, ["row-0", "row-1", "row-2", "row-3"]);
  assert.equal(maximum, 2);
});

test("reader promptは時点と引用可能source付き回答資料を含む", () => {
  const questions = [{ id: "Q1", question: "規則は？", scope: {}, stages: { T1: { as_of: "2026-08-01" } } }];
  const retrieval = new Map([["Q1", [{
    source: "dossier:1",
    citation_sources: ["sources/v2.md", "sources/register.md"],
    text: "現行規則",
  }]]]);
  const prompt = answerPrompt(questions, "T1", retrieval, 5);
  assert.match(prompt, /対象時点: 2026-08-01/);
  assert.match(prompt, /ANSWER MATERIAL: dossier:1/);
  assert.match(prompt, /sources\/v2.md/);
  assert.match(prompt, /sources\/register.md/);
  assert.match(prompt, /不可分な回答資料/);
});

test("回答schemaは質問ごとに検索された不可分materialだけを許可する", () => {
  const schema = answerSchema(
    ["Q1", "Q2"],
    new Map([["Q1", ["dossier:1"]], ["Q2", ["dossier:2"]]]),
  );
  const results = schema.properties.results;
  assert.deepEqual(results.required, ["Q1", "Q2"]);
  assert.deepEqual(
    results.properties.Q1.properties.materials_used.items.enum,
    ["dossier:1"],
  );
  assert.deepEqual(
    results.properties.Q2.properties.materials_used.items.enum,
    ["dossier:2"],
  );
});

test("readerが選んだDossierを原文sourceと用途へ機械的に展開する", () => {
  const questions = [{ id: "Q1" }];
  const retrieval = new Map([["Q1", [{
    source: "dossier:1",
    citation_sources: ["sources/v2.md", "sources/v1.md", "sources/register.md"],
    evidence_roles: [
      { source: "sources/v2.md", use: "governing" },
      { source: "sources/v1.md", use: "reference" },
      { source: "sources/register.md", use: "governing" },
    ],
  }]]]);
  const rows = normalizeResults({ results: { Q1: {
    decision: "answer", answer_value: "6 mm",
    explanation: "現行版を採用", materials_used: ["dossier:1"],
  } } }, questions, retrieval, 5);

  assert.deepEqual(rows[0].evidence, [
    { source: "sources/v2.md", use: "governing" },
    { source: "sources/v1.md", use: "reference" },
    { source: "sources/register.md", use: "governing" },
  ]);
});
