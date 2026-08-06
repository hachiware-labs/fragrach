#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createStructuredChat } from "./structured-chat.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../../..");
const root = path.join(repositoryRoot, "target/benchmarks/enterprise-rag-bench");
let output = null;
let offset = 0;
let limit = null;
let concurrency = 8;
const dossiersPaths = [];
let readerContract = "position-checklist-v1";
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument === "--output") output = path.resolve(process.argv[++index]);
  else if (argument === "--offset") offset = Number.parseInt(process.argv[++index], 10);
  else if (argument === "--limit") limit = Number.parseInt(process.argv[++index], 10);
  else if (argument === "--concurrency") concurrency = Number.parseInt(process.argv[++index], 10);
  else if (argument === "--dossiers") dossiersPaths.push(path.resolve(process.argv[++index]));
  else if (argument === "--reader-contract") readerContract = process.argv[++index];
  else throw new Error(`unknown argument: ${argument}`);
}
if (dossiersPaths.length === 0) dossiersPaths.push(path.join(root, "adaptive-dossiers-v8/retrieval.jsonl"));
if (!output) throw new Error("--output is required");
if (fs.existsSync(output)) throw new Error(`output already exists: ${output}`);
const readJsonl = (file) => fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map(JSON.parse);
const writeJsonl = (file, rows) => fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");

function batches(items, size) {
  const result = [];
  for (let offset = 0; offset < items.length; offset += size) result.push(items.slice(offset, offset + size));
  return result;
}

async function concurrentMap(items, width, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, run));
  return results;
}

function answerSchema(ids) {
  return { type: "object", additionalProperties: false, required: ["results"], properties: { results: {
    type: "array", minItems: ids.length, maxItems: ids.length, items: { type: "object", additionalProperties: false,
      required: ["result_id", "answer"], properties: {
        result_id: { type: "string", enum: ids }, answer: { type: "string" },
      } },
  } } };
}

function modeRule(mode) {
  if (mode === "list") return "Return the complete supported list, not examples or a partial summary.";
  if (mode === "constraint") return "State every supported required, forbidden, conditional, and boundary condition.";
  if (mode === "conflict") return "Separate the current position from earlier or conflicting positions and label their status.";
  if (mode === "absence") return "State the checked scope and claim absence only when the answer material supports it.";
  return "Answer every clause in the question, including clauses joined by and, versus, compared with, or instead of.";
}

function answerPrompt(items) {
  const blocks = items.map((item) => {
    const contract = readerContract === "position-checklist-v1"
      ? `\nANSWER CONTRACT (control metadata, not evidence):\nMODE: ${item.mode}\n${modeRule(item.mode)}\nCHECKLIST:\n${item.obligations.map((value) => `- ${value}`).join("\n")}`
      : "";
    return `## ${item.result_id}\nQUESTION: ${item.question}${contract}\n\nANSWER MATERIAL:\n${item.material}`;
  }).join("\n\n--- NEXT CASE ---\n\n");
  const instruction = readerContract === "position-checklist-v1"
    ? "Before finalizing, verify that the answer addresses every question clause and every ANSWER CONTRACT checklist item. A checklist item tells you what to look for but never supplies a fact."
    : "Answer the question directly from the material without using outside knowledge.";
  return `Answer each question using only its own ANSWER MATERIAL. ${instruction} Preserve exact names, identifiers, numbers, dates, units, constraints, exclusions, and conflicting positions. Be concise but complete. If the material does not support a requested item, identify that item as unsupported instead of inventing it. Do not treat metadata, the question, or retrieval obligations as evidence.\n\n${blocks}`;
}

function judgeSchema(ids) {
  return { type: "object", additionalProperties: false, required: ["results"], properties: { results: {
    type: "array", minItems: ids.length, maxItems: ids.length, items: { type: "object", additionalProperties: false,
      required: ["result_id", "answer_correct", "missing_fact_indices", "contradiction"], properties: {
        result_id: { type: "string", enum: ids },
        answer_correct: { type: "boolean" },
        missing_fact_indices: { type: "array", items: { type: "integer" } },
        contradiction: { type: "boolean" },
      } },
  } } };
}

function judgePrompt(items) {
  const blocks = items.map((item) => `## ${item.result_id}\nQUESTION: ${item.question}\nCANDIDATE ANSWER: ${item.answer}\nREQUIRED FACTS:\n${item.answerFacts.map((fact, index) => `${index}. ${fact}`).join("\n")}`).join("\n\n--- NEXT CASE ---\n\n");
  return `Judge each candidate answer against its REQUIRED FACTS. Semantic paraphrases are allowed. answer_correct is true only when every required fact is expressed and no statement contradicts a required fact. Do not use outside knowledge. List every missing fact index; contradiction is true when the answer conflicts with a required fact.\n\n${blocks}`;
}

function goldMaterial(question) {
  const grouped = new Map();
  for (const unit of question.gold_evidence.units) {
    if (!grouped.has(unit.source)) grouped.set(unit.source, []);
    grouped.get(unit.source).push(unit.fact);
  }
  const sourceTexts = Object.fromEntries([...grouped].map(([source, facts]) => [source, facts.join("\n\n")]));
  return { source_texts: sourceTexts, text: Object.entries(sourceTexts).map(([source, text]) => `SOURCE ${source}\n${text}`).join("\n\n---\n\n") };
}

const allQuestions = readJsonl(path.join(root, "prepared-v3/questions.jsonl"))
  .filter((row) => row.split === "diagnostic" && row.gold_status === "verified" && row.gold_evidence.units.length > 0);
const questions = allQuestions.slice(offset, limit === null ? undefined : offset + limit);
const questionById = new Map(questions.map((row) => [row.id, row]));
const dossierCollections = dossiersPaths.map((dossiersPath) => ({
  path: dossiersPath,
  rows: new Map(readJsonl(dossiersPath).map((row) => [row.question_id, {
    ...row.results[0],
    condition: row.condition,
  }])),
}));
for (const collection of dossierCollections) {
  if (questions.some((question) => !collection.rows.has(question.id))) {
    throw new Error(`dossier question mismatch: ${collection.path}`);
  }
}
function controlDossier(questionId) {
  return dossierCollections.map((collection) => collection.rows.get(questionId))
    .find((row) => row.obligations?.length > 0) ?? dossierCollections[0].rows.get(questionId);
}
const client = await createStructuredChat({ provider: "codex-app-server", cwd: repositoryRoot, model: "gpt-5.6-luna", reasoningEffort: "low" });
let generated;
try {
  const dossierInputs = questions.flatMap((question) => dossierCollections.map((collection) => {
    const dossier = collection.rows.get(question.id);
    const control = controlDossier(question.id);
    return {
      result_id: `${dossier.condition}:${question.id}`, condition: dossier.condition,
      question_id: question.id, question: question.question, material: dossier.text,
      mode: control.mode, obligations: control.obligations,
    };
  }));
  const dossierAnswers = (await concurrentMap(dossierInputs, concurrency, async (item) => {
    const response = await client.chat(answerPrompt([item]), answerSchema([item.result_id]));
    return { ...item, answer: response.content.results[0].answer };
  }));
  const goldInputs = questions.map((question) => ({
    result_id: `gold:${question.id}`, condition: "gold-context", question_id: question.id,
    question: question.question, material: goldMaterial(question).text,
    mode: controlDossier(question.id).mode, obligations: controlDossier(question.id).obligations,
  }));
  const goldAnswers = (await concurrentMap(batches(goldInputs, 5), concurrency, async (batch) => {
    const response = await client.chat(answerPrompt(batch), answerSchema(batch.map((item) => item.result_id)));
    const byId = new Map(response.content.results.map((row) => [row.result_id, row.answer]));
    return batch.map((item) => ({ ...item, answer: byId.get(item.result_id) ?? "" }));
  })).flat();
  generated = [...dossierAnswers, ...goldAnswers];
  const judged = (await concurrentMap(batches(generated, 8), concurrency, async (batch) => {
    const inputs = batch.map((item) => ({ ...item, answerFacts: questionById.get(item.question_id).answer_facts }));
    const response = await client.chat(judgePrompt(inputs), judgeSchema(inputs.map((item) => item.result_id)));
    const byId = new Map(response.content.results.map((row) => [row.result_id, row]));
    return inputs.map((item) => ({ ...item, judge: byId.get(item.result_id) }));
  })).flat();
  const rows = judged.map((item) => {
    const question = questionById.get(item.question_id);
    return {
      condition: item.condition, question_id: question.id, split: question.split, category: question.category,
      answer: item.answer, gold_answer: question.answer, answer_facts: question.answer_facts,
      answer_correct: Boolean(item.judge?.answer_correct), missing_fact_indices: item.judge?.missing_fact_indices ?? [],
      contradiction: Boolean(item.judge?.contradiction), evidence_complete: null,
    };
  });
  fs.mkdirSync(output, { recursive: true });
  writeJsonl(path.join(output, "answers.jsonl"), rows);
  fs.writeFileSync(path.join(output, "manifest.json"), `${JSON.stringify({
    schema_version: "1.0", model: "gpt-5.6-luna", offset, questions: questions.length,
    dossiers: dossiersPaths, concurrency, reader_contract: readerContract,
    answer_scoring: "Independent Luna semantic judge: every answer_facts item expressed and no contradiction.",
    evidence_scoring: "Pending canonical source-local rescore; answer generation does not compute an alternate Evidence score.",
  }, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ output, offset, questions: questions.length, answer_rows: rows.length }, null, 2));
} finally {
  await client.close();
}
