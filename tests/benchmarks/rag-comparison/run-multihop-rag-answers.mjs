#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { factCoverage } from "./prepare-multihop-rag.mjs";
import { answerCorrect } from "./multihop-answer-score.mjs";
import { createStructuredChat } from "./structured-chat.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../../..");
const root = path.join(repositoryRoot, "target/benchmarks/multihop-rag");
const output = path.join(root, "answers-development-diagnostic-v1");
const readJsonl = (file) => fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const writeJsonl = (file, rows) => fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");

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

function answerSchema(ids) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["results"],
    properties: {
      results: {
        type: "array",
        minItems: ids.length,
        maxItems: ids.length,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["result_id", "answer"],
          properties: {
            result_id: { type: "string", enum: ids },
            answer: { type: "string" },
          },
        },
      },
    },
  };
}

function answerPrompt(batch) {
  const blocks = batch.map((item) => `## ${item.result_id}\nQuestion: ${item.question}\n\n${item.material}`).join("\n\n---\n\n");
  return `Answer each question using only its supplied SOURCE materials.

Return only the shortest answer value: an entity name, yes/no, a date, or the requested number. Do not explain. If the sources do not support an answer, return "Insufficient information". Do not treat packet headers, retrieval metadata, or retrieval hypotheses as evidence.

${blocks}`;
}

function evidenceComplete(question, material) {
  return question.gold_evidence.units.every((unit) => {
    const text = material.source_texts?.[unit.source] ?? "";
    return factCoverage(unit.fact, text) >= 0.8;
  });
}

function goldSourceTexts(question) {
  const grouped = new Map();
  for (const unit of question.gold_evidence.units) {
    if (!grouped.has(unit.source)) grouped.set(unit.source, []);
    grouped.get(unit.source).push(unit.fact);
  }
  return Object.fromEntries([...grouped].map(([source, facts]) => [source, facts.join("\n\n")]));
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
const questions = readJsonl(path.join(root, "prepared-v2/evaluation/questions.jsonl"))
  .filter((question) => question.split === "development" || question.split === "diagnostic")
  .filter((question) => question.gold_status === "verified" && question.gold_evidence.units.length > 0);
const questionById = new Map(questions.map((question) => [question.id, question]));
const packetRows = readJsonl(path.join(root, "query-packets-frozen-v1/retrieval.jsonl"));
const packets = new Map(packetRows.map((row) => [row.question_id, row.results[0]]));
const conditions = {
  "fragrach-multihop-evidence-packet-v1": new Map(questions.map((question) => [question.id, packets.get(question.id)])),
  "gold-context": new Map(questions.map((question) => [question.id, {
    source_texts: goldSourceTexts(question),
    text: question.gold_evidence.units.map((unit) => `SOURCE: ${unit.source}\n${unit.fact}`).join("\n\n"),
  }])),
};
const inputs = Object.entries(conditions).flatMap(([condition, materials]) => questions.map((question) => ({
  result_id: `${condition}:${question.id}`,
  condition,
  question_id: question.id,
  question: question.question,
  material: materials.get(question.id)?.text ?? "No source material.",
})));
const client = await createStructuredChat({ provider: "codex-app-server", cwd: repositoryRoot, model: "gpt-5.6-luna", reasoningEffort: "low" });
try {
  const responses = await concurrentMap(batches(inputs, 10), 8, async (batch) => {
    const response = await client.chat(answerPrompt(batch), answerSchema(batch.map((item) => item.result_id)));
    const byId = new Map(response.content.results.map((item) => [item.result_id, item.answer]));
    return batch.map((item) => ({ ...item, answer: byId.get(item.result_id) ?? "" }));
  });
  const rows = responses.flat().map((item) => {
    const question = questionById.get(item.question_id);
    const material = conditions[item.condition].get(item.question_id);
    return {
      condition: item.condition,
      question_id: item.question_id,
      split: question.split,
      category: question.category,
      answer: item.answer,
      gold_answer: question.answer,
      answer_correct: answerCorrect(item.answer, question.answer),
      evidence_complete: evidenceComplete(question, material),
    };
  });
  const report = {
    schema_version: "1.0",
    experiment: "multihop-rag-dvaa-development-diagnostic",
    model: "gpt-5.6-luna",
    answer_scoring: "NFKC lowercase alphanumeric exact match or whole normalized Gold phrase contained in the concise generated answer.",
    dvaa_contract: "Gross = answer correct AND every Gold source-span Evidence Unit present, divided by all answerable questions. Net = the same strict passes divided by questions whose complete evidence was supplied.",
    conditions: Object.fromEntries(Object.keys(conditions).map((condition) => {
      const selected = rows.filter((row) => row.condition === condition);
      return [condition, {
        overall: summarize(selected),
        by_split: Object.fromEntries(["development", "diagnostic"].map((split) => [split, summarize(selected.filter((row) => row.split === split))])),
        by_category: Object.fromEntries([...new Set(selected.map((row) => row.category))].map((category) => [category, summarize(selected.filter((row) => row.category === category))])),
      }];
    })),
  };
  fs.mkdirSync(output, { recursive: true });
  writeJsonl(path.join(output, "answers.jsonl"), rows);
  fs.writeFileSync(path.join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
} finally {
  await client.close();
}
