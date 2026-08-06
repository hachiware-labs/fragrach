#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { answerCorrect } from "./multihop-answer-score.mjs";
import { factCoverage } from "./prepare-multihop-rag.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../../..");
const root = path.join(repositoryRoot, "target/benchmarks/multihop-rag");
const input = path.join(root, "answers-development-diagnostic-v1/answers.jsonl");
const output = path.join(root, "answers-development-diagnostic-v2");
const readJsonl = (file) => fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));

function goldSourceTexts(question) {
  const grouped = new Map();
  for (const unit of question.gold_evidence.units) {
    if (!grouped.has(unit.source)) grouped.set(unit.source, []);
    grouped.get(unit.source).push(unit.fact);
  }
  return Object.fromEntries([...grouped].map(([source, facts]) => [source, facts.join("\n\n")]));
}

function evidenceComplete(question, sourceTexts) {
  return question.gold_evidence.units.every((unit) => factCoverage(unit.fact, sourceTexts[unit.source] ?? "") >= 0.8);
}

function summarize(rows) {
  const correct = rows.filter((row) => row.answer_correct).length;
  const complete = rows.filter((row) => row.evidence_complete).length;
  const strict = rows.filter((row) => row.answer_correct && row.evidence_complete).length;
  return {
    questions: rows.length,
    answer_accuracy: correct / (rows.length || 1),
    evidence_unit_ceiling: complete / (rows.length || 1),
    dvaa_gross: strict / (rows.length || 1),
    dvaa_net: complete === 0 ? null : strict / complete,
    counts: { answer_correct: correct, evidence_complete: complete, strict },
  };
}

if (fs.existsSync(output)) throw new Error(`output already exists: ${output}`);
const questions = readJsonl(path.join(root, "prepared-v2/evaluation/questions.jsonl"));
const questionById = new Map(questions.map((question) => [question.id, question]));
const packets = new Map(readJsonl(path.join(root, "query-packets-frozen-v1/retrieval.jsonl"))
  .map((row) => [row.question_id, row.results[0]?.source_texts ?? {}]));
const rows = readJsonl(input).map((row) => {
  const question = questionById.get(row.question_id);
  const sourceTexts = row.condition === "gold-context" ? goldSourceTexts(question) : packets.get(row.question_id) ?? {};
  return {
    ...row,
    answer_correct: answerCorrect(row.answer, row.gold_answer),
    evidence_complete: evidenceComplete(question, sourceTexts),
  };
});
const conditionNames = [...new Set(rows.map((row) => row.condition))];
const report = {
  schema_version: "1.1",
  experiment: "multihop-rag-dvaa-development-diagnostic",
  model: "gpt-5.6-luna",
  correction: "Gold Context now concatenates multiple Gold facts from the same source; answer normalization ignores a leading English article.",
  answer_scoring: "NFKC lowercase alphanumeric exact match or whole normalized Gold phrase contained in the concise generated answer; leading English articles are ignored.",
  dvaa_contract: "Gross = answer correct AND every Gold source-span Evidence Unit present, divided by all answerable questions. Net = the same strict passes divided by questions whose complete evidence was supplied.",
  conditions: Object.fromEntries(conditionNames.map((condition) => {
    const selected = rows.filter((row) => row.condition === condition);
    return [condition, {
      overall: summarize(selected),
      by_split: Object.fromEntries(["development", "diagnostic"].map((split) => [split, summarize(selected.filter((row) => row.split === split))])),
      by_category: Object.fromEntries([...new Set(selected.map((row) => row.category))].map((category) => [category, summarize(selected.filter((row) => row.category === category))])),
    }];
  })),
};
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, "answers.jsonl"), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
fs.writeFileSync(path.join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
