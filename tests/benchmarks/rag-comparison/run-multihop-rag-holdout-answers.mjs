#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { answerCorrect } from "./multihop-answer-score.mjs";
import { factCoverage } from "./prepare-multihop-rag.mjs";
import { createStructuredChat } from "./structured-chat.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../../..");
const root = path.join(repositoryRoot, "target/benchmarks/multihop-rag");
const output = path.join(root, "answers-holdout-v1");
const readJsonl = (file) => fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));

function batches(items, size) {
  const result = [];
  for (let offset = 0; offset < items.length; offset += size) result.push(items.slice(offset, offset + size));
  return result;
}

async function concurrentMap(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

function schema(ids) {
  return { type: "object", additionalProperties: false, required: ["results"], properties: { results: {
    type: "array", minItems: ids.length, maxItems: ids.length, items: { type: "object", additionalProperties: false,
      required: ["result_id", "answer"], properties: { result_id: { type: "string", enum: ids }, answer: { type: "string" } } },
  } } };
}

function prompt(batch) {
  const blocks = batch.map((item) => `## ${item.result_id}\nQuestion: ${item.question}\n\n${item.material}`).join("\n\n---\n\n");
  return `Answer each question using only its supplied SOURCE materials.

Return only the shortest answer value: an entity name, yes/no, a date, or the requested number. Do not explain. If the sources do not support an answer, return "Insufficient information". Do not treat packet headers, retrieval metadata, or retrieval hypotheses as evidence.

${blocks}`;
}

function goldSourceTexts(question) {
  const grouped = new Map();
  for (const unit of question.gold_evidence.units) {
    if (!grouped.has(unit.source)) grouped.set(unit.source, []);
    grouped.get(unit.source).push(unit.fact);
  }
  return Object.fromEntries([...grouped].map(([source, facts]) => [source, facts.join("\n\n")]));
}

function evidenceComplete(question, sourceTexts) {
  return question.gold_evidence.units.length > 0
    && question.gold_evidence.units.every((unit) => factCoverage(unit.fact, sourceTexts[unit.source] ?? "") >= 0.8);
}

function summarize(rows) {
  const correct = rows.filter((row) => row.answer_correct).length;
  const complete = rows.filter((row) => row.evidence_complete).length;
  const strict = rows.filter((row) => row.answer_correct && row.evidence_complete).length;
  return { questions: rows.length, answer_accuracy: correct / (rows.length || 1), evidence_unit_ceiling: complete / (rows.length || 1),
    dvaa_gross: strict / (rows.length || 1), dvaa_net: complete === 0 ? null : strict / complete,
    counts: { answer_correct: correct, evidence_complete: complete, strict } };
}

if (fs.existsSync(output)) throw new Error(`output already exists: ${output}`);
const questions = readJsonl(path.join(root, "prepared-v2/evaluation/questions.jsonl")).filter((question) => question.split === "holdout");
const answerable = questions.filter((question) => question.gold_evidence.units.length > 0);
const questionById = new Map(questions.map((question) => [question.id, question]));
const packets = new Map(readJsonl(path.join(root, "query-packets-holdout-v1/retrieval.jsonl")).map((row) => [row.question_id, row.results[0]]));
const inputs = [
  ...questions.map((question) => ({ result_id: `fragrach:${question.id}`, condition: "fragrach-multihop-evidence-packet-v1", question_id: question.id,
    question: question.question, material: packets.get(question.id)?.text ?? "No source material." })),
  ...answerable.map((question) => ({ result_id: `gold:${question.id}`, condition: "gold-context", question_id: question.id,
    question: question.question, material: question.gold_evidence.units.map((unit) => `SOURCE: ${unit.source}\n${unit.fact}`).join("\n\n") })),
];
const client = await createStructuredChat({ provider: "codex-app-server", cwd: repositoryRoot, model: "gpt-5.6-luna", reasoningEffort: "low" });
try {
  const responses = await concurrentMap(batches(inputs, 10), 8, async (batch) => {
    const response = await client.chat(prompt(batch), schema(batch.map((item) => item.result_id)));
    const byId = new Map(response.content.results.map((item) => [item.result_id, item.answer]));
    return batch.map((item) => ({ ...item, answer: byId.get(item.result_id) ?? "" }));
  });
  const rows = responses.flat().map((item) => {
    const question = questionById.get(item.question_id);
    const sourceTexts = item.condition === "gold-context" ? goldSourceTexts(question) : packets.get(item.question_id)?.source_texts ?? {};
    return { condition: item.condition, question_id: item.question_id, category: question.category, answer: item.answer, gold_answer: question.answer,
      answer_correct: answerCorrect(item.answer, question.answer), evidence_complete: evidenceComplete(question, sourceTexts) };
  });
  const packetRows = rows.filter((row) => row.condition === "fragrach-multihop-evidence-packet-v1");
  const packetAnswerable = packetRows.filter((row) => row.category !== "null_query");
  const packetNull = packetRows.filter((row) => row.category === "null_query");
  const goldRows = rows.filter((row) => row.condition === "gold-context");
  const report = {
    schema_version: "1.0", experiment: "multihop-rag-dvaa-untouched-holdout", model: "gpt-5.6-luna",
    answer_scoring: "NFKC lowercase alphanumeric exact match or whole normalized Gold phrase contained in the concise generated answer; leading English articles are ignored.",
    dvaa_contract: "Gross and Net are calculated only on 60 answerable questions. The 20 null questions have no positive Evidence Unit and are reported separately as refusal accuracy.",
    conditions: {
      "fragrach-multihop-evidence-packet-v1": { answerable: summarize(packetAnswerable), null_questions: summarize(packetNull), all_answer_accuracy: summarize(packetRows).answer_accuracy },
      "gold-context": { answerable: summarize(goldRows) },
    },
  };
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, "answers.jsonl"), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
  fs.writeFileSync(path.join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
} finally {
  await client.close();
}
