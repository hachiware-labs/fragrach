import test from "node:test";
import assert from "node:assert/strict";

import {
  completeEvidenceAtK, recallAtK, scoreDvaaCase, scoreDvaaRun,
} from "./dynamic-validity-score.mjs";

const question = {
  id: "Q1",
  split: "holdout",
  category: "version",
  scope: {},
  stages: {
    T1: {
      as_of: "2026-08-01",
      expected_decision: "answer",
      answer_values: ["6 mm"],
      forbidden_answer_values: ["8 mm"],
      retrieval_gold: ["sources/v2.md"],
      required_evidence_sets: [["sources/v2.md"]],
      forbidden_governing_evidence: ["sources/v1.md", "sources/draft.md"],
    },
  },
};

const profiles = [
  { source: "sources/v1.md", role: "normative", status: "superseded", approved: true, official_record: true, authority_rank: 9, scope: {}, time: { valid_from: "2026-01-01", valid_to: "2026-06-30" } },
  { source: "sources/v2.md", role: "normative", status: "current", approved: true, official_record: true, authority_rank: 9, scope: {}, time: { valid_from: "2026-07-01" } },
  { source: "sources/draft.md", role: "proposal", status: "draft", approved: false, official_record: false, authority_rank: 5, scope: {}, time: { valid_from: "2026-07-20" } },
];

test("Recallが満点でも旧版を採用すればDVAAは0になる", () => {
  const retrieved = [{ source: "sources/v2.md" }, { source: "sources/v1.md" }];
  const output = {
    question_id: "Q1",
    decision: "answer",
    answer_value: "6 mm",
    evidence: [{ source: "sources/v1.md", use: "governing" }],
  };
  const score = scoreDvaaCase(question, "T1", output, profiles);
  assert.equal(recallAtK(question, "T1", retrieved, 5), 1);
  assert.equal(score.answer_correct, true);
  assert.equal(score.dvaa_t, false);
  assert.equal(score.dvaa_full, false);
});

test("現行版を採用した正答はDVAA-Fullを通る", () => {
  const output = {
    question_id: "Q1",
    decision: "answer",
    answer_value: "6 mm",
    evidence: [{ source: "sources/v2.md", use: "governing" }],
  };
  const score = scoreDvaaCase(question, "T1", output, profiles);
  assert.equal(score.dvaa_t, true);
  assert.equal(score.dvaa_ts, true);
  assert.equal(score.dvaa_tspa, true);
  assert.equal(score.dvaa_full, true);
});

test("日本語の助数詞と頻度表現の同値な回答を正答として扱う", () => {
  const peopleQuestion = structuredClone(question);
  peopleQuestion.stages.T1.answer_values = ["2名"];
  const people = scoreDvaaCase(peopleQuestion, "T1", {
    question_id: "Q1", decision: "answer", answer_value: "2人",
    evidence: [{ source: "sources/v2.md", use: "governing" }],
  }, profiles);
  assert.equal(people.answer_correct, true);

  const frequencyQuestion = structuredClone(question);
  frequencyQuestion.stages.T1.answer_values = ["20台ごとに1台"];
  const frequency = scoreDvaaCase(frequencyQuestion, "T1", {
    question_id: "Q1", decision: "answer", answer_value: "20台に1台",
    evidence: [{ source: "sources/v2.md", use: "governing" }],
  }, profiles);
  assert.equal(frequency.answer_correct, true);
});

test("run集計はValidity Gapを回答正解率との差として返す", () => {
  const retrieval = new Map([["Q1", [{ source: "sources/v2.md" }]]]);
  const report = scoreDvaaRun({
    questions: [question], stage: "T1", profiles, retrieval, topK: 5,
    outputs: [{ question_id: "Q1", decision: "answer", answer_value: "6 mm", evidence: [{ source: "sources/v1.md", use: "governing" }] }],
  });
  assert.equal(report.metrics.recall_at_k, 1);
  assert.equal(report.metrics.answer_accuracy, 1);
  assert.equal(report.metrics.dvaa_full, 0);
  assert.equal(report.metrics.dvaa_gross, 0);
  assert.equal(report.metrics.evidence_ceiling, 1);
  assert.equal(report.metrics.dvaa_net, 0);
  assert.equal(report.metrics.validity_gap, 1);
});

test("15分を禁止値5分へ部分一致させず、基本規則のreference引用を完全性へ数える", () => {
  const scopedQuestion = {
    id: "Q-SCOPE", split: "holdout", category: "scope", scope: { sites: "osaka" },
    stages: { T1: {
      as_of: "2026-08-01", expected_decision: "answer",
      answer_values: ["15分"], forbidden_answer_values: ["5分"],
      retrieval_gold: ["sources/base.md", "sources/local.md"],
      required_evidence_sets: [["sources/base.md", "sources/local.md"]],
      forbidden_governing_evidence: [],
    } },
  };
  const scopedProfiles = [
    { source: "sources/base.md", role: "normative", status: "current", approved: true, official_record: true, authority_rank: 8, scope: {}, time: { valid_from: "2026-01-01" } },
    { source: "sources/local.md", role: "normative", status: "current", approved: true, official_record: true, authority_rank: 9, scope: { sites: ["osaka"] }, time: { valid_from: "2026-07-01" } },
  ];
  const score = scoreDvaaCase(scopedQuestion, "T1", {
    question_id: "Q-SCOPE", decision: "answer", answer_value: "15分間",
    evidence: [
      { source: "sources/base.md", use: "reference" },
      { source: "sources/local.md", use: "governing" },
    ],
  }, scopedProfiles);
  assert.equal(score.answer_correct, true);
  assert.equal(score.dvaa_full, true);
});

test("公式管理台帳は規範本文の有効性を支える権威根拠として扱う", () => {
  const registerQuestion = {
    id: "Q-REGISTER", split: "holdout", category: "register", scope: {},
    stages: { T1: {
      as_of: "2026-08-01", expected_decision: "answer",
      answer_values: ["必要"], forbidden_answer_values: ["不要"],
      retrieval_gold: ["sources/rule.md"],
      required_evidence_sets: [["sources/rule.md", "sources/register.md"]],
      forbidden_governing_evidence: [],
    } },
  };
  const registerProfiles = [
    { source: "sources/rule.md", role: "normative", status: "current", approved: true, official_record: true, authority_rank: 9, scope: {}, time: { valid_from: "2026-07-01" } },
    { source: "sources/register.md", role: "record", status: "current", approved: true, official_record: true, authority_rank: 10, scope: {}, time: { valid_from: "2026-07-01" } },
  ];
  const score = scoreDvaaCase(registerQuestion, "T1", {
    question_id: "Q-REGISTER", decision: "answer", answer_value: "必要",
    evidence: [
      { source: "sources/rule.md", use: "governing" },
      { source: "sources/register.md", use: "governing" },
    ],
  }, registerProfiles);
  assert.equal(score.dvaa_tspa, true);
  assert.equal(score.dvaa_full, true);
});

test("不可分Dossierの複数sourceはtop-kの一枠でRecallへ数える", () => {
  const dossierQuestion = structuredClone(question);
  dossierQuestion.stages.T1.retrieval_gold = ["sources/v2.md", "sources/register.md"];
  const retrieved = [{
    source: "dossier:position-1",
    sources: ["sources/v2.md", "sources/register.md"],
    text: "position dossier",
  }];
  assert.equal(recallAtK(dossierQuestion, "T1", retrieved, 1), 1);
  dossierQuestion.stages.T1.required_evidence_sets = [["sources/v2.md", "sources/register.md"]];
  assert.equal(completeEvidenceAtK(dossierQuestion, "T1", retrieved, 1), true);
});

test("完全根拠が一問もない場合はDVAA-Netを算出しない", () => {
  const report = scoreDvaaRun({
    questions: [question], stage: "T1", outputs: [],
    retrieval: new Map([["Q1", [{ source: "sources/v1.md" }]]]),
    profiles, topK: 1,
  });
  assert.equal(report.metrics.evidence_ceiling, 0);
  assert.equal(report.metrics.dvaa_gross, 0);
  assert.equal(report.metrics.dvaa_net, null);
});
