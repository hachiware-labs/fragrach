#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createStructuredChat } from "./structured-chat.mjs";
import {
  loadEvidenceAnnotations,
  resolveEvidenceContract,
  scoreEvidenceContract,
} from "./versionqa-evidence-score.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../../..");

function parseArguments(argv) {
  const options = {
    corpus: path.join(repositoryRoot, "target/benchmarks/versionqa/prepared"),
    rawRetrieval: path.join(repositoryRoot, "target/benchmarks/versionqa/raw-retrieval/retrieval.jsonl"),
    fragrachRetrieval: path.join(repositoryRoot, "target/benchmarks/versionqa/fragrach-retrieval/retrieval.jsonl"),
    queryPacketRetrieval: null,
    onlyCondition: null,
    output: path.join(repositoryRoot, "target/benchmarks/versionqa/answers"),
    model: "gpt-5.6-luna",
    reasoningEffort: "low",
    batchSize: 2,
    concurrency: 8,
    topK: 5,
    evidenceContracts: path.join(scriptDirectory, "versionqa-evidence-contracts.json"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--corpus") options.corpus = path.resolve(argv[++index]);
    else if (argument === "--raw-retrieval") options.rawRetrieval = path.resolve(argv[++index]);
    else if (argument === "--fragrach-retrieval") options.fragrachRetrieval = path.resolve(argv[++index]);
    else if (argument === "--query-packet-retrieval") options.queryPacketRetrieval = path.resolve(argv[++index]);
    else if (argument === "--only-condition") options.onlyCondition = argv[++index];
    else if (argument === "--output") options.output = path.resolve(argv[++index]);
    else if (argument === "--model") options.model = argv[++index];
    else if (argument === "--reasoning-effort") options.reasoningEffort = argv[++index];
    else if (argument === "--batch-size") options.batchSize = Number.parseInt(argv[++index], 10);
    else if (argument === "--concurrency") options.concurrency = Number.parseInt(argv[++index], 10);
    else if (argument === "--top-k") options.topK = Number.parseInt(argv[++index], 10);
    else if (argument === "--evidence-contracts") options.evidenceContracts = path.resolve(argv[++index]);
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

function readJsonl(file) {
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function writeJsonl(file, rows) {
  fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

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

function retrievalMap(rows, condition) {
  return new Map(rows.filter((row) => row.condition === condition).map((row) => [row.question_id, row.results]));
}

function materialIds(retrieval, questions, topK) {
  return [...new Set(questions.flatMap((question) =>
    (retrieval.get(question.id) ?? []).slice(0, topK).map((item) => item.source)
  ))].sort();
}

function answerSchema(questionIds, materials) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["results"],
    properties: {
      results: {
        type: "array",
        minItems: questionIds.length,
        maxItems: questionIds.length,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["question_id", "answer", "materials_used"],
          properties: {
            question_id: { type: "string", enum: questionIds },
            answer: { type: "string" },
            materials_used: { type: "array", items: { type: "string", enum: materials } },
          },
        },
      },
    },
  };
}

function answerPrompt(questions, retrieval, topK) {
  const blocks = questions.map((question) => {
    const materials = (retrieval.get(question.id) ?? []).slice(0, topK).map((item) =>
      `ANSWER MATERIAL: ${item.source}\nCITABLE SOURCES: ${(item.sources ?? [item.source]).join(", ")}\n${item.text}`
    ).join("\n\n");
    return `## ${question.id}\nQuestion: ${question.question}\n\n${materials}`;
  }).join("\n\n---\n\n");
  return `Answer each technical-documentation question using only its supplied answer materials.

An explicit version in the question is binding. A superseded version remains valid evidence when that historical version is requested. For a change question, compare the relevant adjacent versions. In a Semantic Diff Packet, Before/After identify document-snapshot versions. Embedded \`added\` or \`removed\` metadata instead identifies upstream API history: keep these two time axes distinct, and report the snapshot version when the question asks in which corpus version an observed example or wording changed. A Version Inventory Packet describes only the versions present in this corpus; do not invent versions from outside knowledge. If a full-document check verifies that the subject is absent, answer that no information is available in the requested version. Otherwise, if the materials do not support an answer, say "Insufficient information".

Keep the answer concise but include every item requested by the question. Record only the ANSWER MATERIAL identifiers actually used.

${blocks}`;
}

function judgeSchema(questionIds) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["results"],
    properties: {
      results: {
        type: "array",
        minItems: questionIds.length,
        maxItems: questionIds.length,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["question_id", "correct", "reason"],
          properties: {
            question_id: { type: "string", enum: questionIds },
            correct: { type: "boolean" },
            reason: { type: "string" },
          },
        },
      },
    },
  };
}

function judgePrompt(questions, answers) {
  const byId = new Map(answers.map((answer) => [answer.question_id, answer]));
  const blocks = questions.map((question) => `## ${question.id}\nQuestion: ${question.question}\nReference answer: ${question.answer}\nCandidate answer: ${byId.get(question.id)?.answer ?? ""}`).join("\n\n");
  return `Judge whether each candidate answer is factually equivalent to the reference answer for the question. Accept concise paraphrases, reordered lists, and harmless extra explanation. Treat "No information available", "not documented in the requested version", and "Insufficient information" as equivalent negative answers when the candidate does not invent a factual answer. A reference version wildcard such as 16.* accepts a specific matching version such as 16.20.2. Reject a genuinely conflicting version, missing requested item, or contradiction. Do not reject an equivalent negative answer merely because it also says that a full-document check found the subject absent. Return one decision per question.\n\n${blocks}`;
}

function normalizeBatch(content, questionIds, kind) {
  const expected = new Set(questionIds);
  const seen = new Set();
  const rows = [];
  for (const row of content.results ?? []) {
    if (!expected.has(row.question_id) || seen.has(row.question_id)) continue;
    seen.add(row.question_id);
    rows.push(kind === "answer"
      ? { ...row, materials_used: [...new Set(row.materials_used ?? [])] }
      : row);
  }
  if (rows.length !== questionIds.length) throw new Error(`${kind} response omitted questions`);
  return rows;
}

function selectedMaterials(answer, retrieval, topK) {
  const byMaterial = new Map((retrieval.get(answer.question_id) ?? []).slice(0, topK).map((item) => [item.source, item]));
  return (answer.materials_used ?? []).map((id) => byMaterial.get(id)).filter(Boolean);
}

function contextMaterials(questionId, retrieval, topK) {
  return (retrieval.get(questionId) ?? []).slice(0, topK);
}

function sourcesFromMaterials(materials) {
  return new Set(materials.flatMap((item) => item.citation_sources ?? item.sources ?? [item.source]));
}

export function metrics(questions, answers, judgments, retrieval, topK, annotations) {
  const answerById = new Map(answers.map((answer) => [answer.question_id, answer]));
  const judgeById = new Map(judgments.map((judge) => [judge.question_id, judge]));
  const rows = questions.map((question) => {
    const gold = question.gold_evidence.sources;
    const answer = answerById.get(question.id);
    const correct = Boolean(judgeById.get(question.id)?.correct);
    const context = contextMaterials(question.id, retrieval, topK);
    const selected = selectedMaterials(answer, retrieval, topK);
    const contextSources = sourcesFromMaterials(context);
    const contract = resolveEvidenceContract(question, annotations[question.id]);
    const contextEvidence = scoreEvidenceContract(contract, context);
    const selectedEvidence = scoreEvidenceContract(contract, selected);
    const documentRecall = gold.length === 0 ? 1 : gold.filter((source) => contextSources.has(source)).length / gold.length;
    return {
      question_id: question.id,
      category: question.category,
      scorable: contextEvidence.scorable,
      excluded_reason: contextEvidence.reason ?? null,
      correct,
      document_recall_at_k: documentRecall,
      evidence_unit_recall_at_k: contextEvidence.recall,
      evidence_ceiling: contextEvidence.complete,
      selected_evidence_complete: selectedEvidence.complete,
      dvaa_valid: contextEvidence.scorable && correct && selectedEvidence.complete,
    };
  });
  const aggregate = (selected) => {
    const scorable = selected.filter((row) => row.scorable);
    const count = scorable.length;
    const correct = scorable.filter((row) => row.correct).length;
    const ceiling = scorable.filter((row) => row.evidence_ceiling).length;
    const valid = scorable.filter((row) => row.dvaa_valid).length;
    const average = (field) => count === 0 ? null : scorable.reduce((sum, row) => sum + row[field], 0) / count;
    return {
      questions_observed: selected.length,
      questions_scorable: count,
      questions_excluded: selected.length - count,
      answer_accuracy: count === 0 ? null : correct / count,
      document_recall_at_k: average("document_recall_at_k"),
      evidence_unit_recall_at_k: average("evidence_unit_recall_at_k"),
      evidence_ceiling: count === 0 ? null : ceiling / count,
      dvaa_gross: count === 0 ? null : valid / count,
      dvaa_net: ceiling === 0 ? null : valid / ceiling,
      counts: { correct, ceiling, valid, excluded: selected.length - count },
    };
  };
  return {
    overall: aggregate(rows),
    by_category: Object.fromEntries([...new Set(rows.map((row) => row.category))]
      .map((category) => [category, aggregate(rows.filter((row) => row.category === category))])),
    rows,
  };
}

async function runCondition(client, condition, questions, retrieval, options, annotations) {
  const answerBatches = batches(questions, options.batchSize);
  const answerResponses = await concurrentMap(answerBatches, options.concurrency, async (batch, index) => {
    const ids = batch.map((question) => question.id);
    const response = await client.chat(
      answerPrompt(batch, retrieval, options.topK),
      answerSchema(ids, materialIds(retrieval, batch, options.topK)),
    );
    console.log(`${condition}: answered ${Math.min((index + 1) * options.batchSize, questions.length)}/${questions.length}`);
    return { rows: normalizeBatch(response.content, ids, "answer"), usage: response.usage };
  });
  const answers = answerResponses.flatMap((response) => response.rows);
  const judgeBatches = batches(questions, Math.max(4, options.batchSize * 2));
  const judgeResponses = await concurrentMap(judgeBatches, options.concurrency, async (batch, index) => {
    const ids = batch.map((question) => question.id);
    const response = await client.chat(judgePrompt(batch, answers), judgeSchema(ids));
    console.log(`${condition}: judged ${Math.min((index + 1) * Math.max(4, options.batchSize * 2), questions.length)}/${questions.length}`);
    return { rows: normalizeBatch(response.content, ids, "judge"), usage: response.usage };
  });
  const judgments = judgeResponses.flatMap((response) => response.rows);
  return {
    answers,
    judgments,
    answer_usage: answerResponses.map((response) => response.usage),
    judge_usage: judgeResponses.map((response) => response.usage),
    metrics: metrics(questions, answers, judgments, retrieval, options.topK, annotations),
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node run-versionqa-answers.mjs [--output DIR] [--concurrency 8]");
    return;
  }
  if (fs.existsSync(options.output)) throw new Error(`output already exists: ${options.output}`);
  const questions = readJsonl(path.join(options.corpus, "evaluation/questions.jsonl")).filter((question) => question.version_sensitive);
  const annotations = loadEvidenceAnnotations(options.evidenceContracts);
  const rawRows = readJsonl(options.rawRetrieval);
  const fragrachRows = readJsonl(options.fragrachRetrieval);
  const conditions = [
    ["raw-ruri-hybrid", retrievalMap(rawRows, "ruri-hybrid-sparse-0.90")],
    ["fragrach-decision-packet", retrievalMap(fragrachRows, "fragrach-decision-packet")],
  ];
  if (options.queryPacketRetrieval) {
    conditions.push([
      "fragrach-query-packet-v1",
      retrievalMap(readJsonl(options.queryPacketRetrieval), "fragrach-query-packet-v1"),
    ]);
  }
  const selectedConditions = options.onlyCondition
    ? conditions.filter(([name]) => name === options.onlyCondition)
    : conditions;
  if (selectedConditions.length === 0) throw new Error(`condition not found: ${options.onlyCondition}`);
  const client = await createStructuredChat({
    provider: "codex-app-server",
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    cwd: repositoryRoot,
  });
  fs.mkdirSync(options.output, { recursive: true });
  const report = {
    schema_version: "1.0",
    experiment: "versionqa-answer-evaluation",
    evaluation_contract: {
      evidence_granularity: "evidence-unit",
      evidence_unit_types: ["source_span", "document_absence", "version_inventory", "semantic_diff"],
      evidence_recall_definition: "mean fraction of verified Gold Evidence Units satisfied by the top-k answer materials",
      evidence_ceiling_definition: "all verified Gold Evidence Units are satisfied by the top-k answer materials",
      dvaa_definition: "the answer is correct and the reader-selected answer materials satisfy all verified Gold Evidence Units",
      disputed_gold_policy: "questions whose Gold answer is not supported by the supplied source documents are reported and excluded from headline denominators",
      document_recall_role: "source-document recall is retained as a conventional retrieval diagnostic but is not used as the DVAA ceiling",
    },
    model: options.model,
    reasoning_effort: options.reasoningEffort,
    concurrency: options.concurrency,
    batch_size: options.batchSize,
    top_k: options.topK,
    questions: questions.length,
    conditions: {},
  };
  try {
    for (const [name, retrieval] of selectedConditions) {
      const result = await runCondition(client, name, questions, retrieval, options, annotations);
      writeJsonl(path.join(options.output, `${name}-answers.jsonl`), result.answers);
      writeJsonl(path.join(options.output, `${name}-judgments.jsonl`), result.judgments);
      report.conditions[name] = {
        metrics: result.metrics,
        answer_usage: result.answer_usage,
        judge_usage: result.judge_usage,
      };
      fs.writeFileSync(path.join(options.output, "report.partial.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    }
  } finally {
    await client.close();
  }
  report.completed_at = new Date().toISOString();
  fs.writeFileSync(path.join(options.output, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
