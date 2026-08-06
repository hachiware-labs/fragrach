#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import { createStructuredChat } from "./structured-chat.mjs";
import { loadDynamicValidityPack, scoreDvaaRun } from "./dynamic-validity-score.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../../..");
const defaultCorpusRoot = path.resolve(scriptDirectory, "../../corpora/aobane-industries-ja-dynamic-validity");
const defaultInputDirectory = path.resolve(repositoryRoot, "target/benchmarks/dynamic-validity");

function readJsonl(filePath) {
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function writeJsonl(filePath, rows) {
  fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

export async function concurrentMap(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run(workerIndex) {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index, workerIndex);
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(concurrency, items.length) }, (_, index) => run(index),
  ));
  return results;
}

function retrievalMap(rows) {
  return new Map(rows.map((row) => [row.question_id, row.results]));
}

export function answerSchema(questionIds, materials) {
  const resultProperties = (questionId, allowedMaterials, includeQuestionId) => ({
    type: "object",
    additionalProperties: false,
    required: [
      ...(includeQuestionId ? ["question_id"] : []),
      "decision", "answer_value", "explanation", "materials_used",
    ],
    properties: {
      ...(includeQuestionId ? { question_id: { type: "string", const: questionId } } : {}),
      decision: { type: "string", enum: ["answer", "unresolved", "insufficient"] },
      answer_value: { type: "string" },
      explanation: { type: "string" },
      materials_used: {
        type: "array",
        items: { type: "string", enum: allowedMaterials },
      },
    },
  });
  if (materials instanceof Map) {
    return {
      type: "object",
      additionalProperties: false,
      required: ["results"],
      properties: {
        results: {
          type: "object",
          additionalProperties: false,
          required: questionIds,
          properties: Object.fromEntries(questionIds.map((questionId) => [
            questionId,
            resultProperties(questionId, materials.get(questionId) ?? [], false),
          ])),
        },
      },
    };
  }
  return {
    type: "object",
    additionalProperties: false,
    required: ["results"],
    properties: {
      results: {
        type: "array",
        minItems: questionIds.length,
        maxItems: questionIds.length,
        items: { anyOf: questionIds.map((questionId) => resultProperties(questionId, materials, true)) },
      },
    },
  };
}

export function answerPrompt(questions, stage, retrieval, topK) {
  const blocks = questions.map((question) => {
    const context = (retrieval.get(question.id) ?? []).slice(0, topK)
      .map((item) => {
        const sources = item.citation_sources ?? item.sources ?? [item.source];
        return `ANSWER MATERIAL: ${item.source}\nCITABLE SOURCES:\n${sources.map((source) => `- ${source}`).join("\n")}\n${item.text}`;
      })
      .join("\n\n");
    return `## ${question.id}\n質問: ${question.question}\n対象時点: ${question.stages[stage].as_of}\n対象scope: ${JSON.stringify(question.scope)}\n\n検索context:\n${context}`;
  }).join("\n\n---\n\n");
  return `あなたは企業向けRAGの回答readerです。検索器が返したcontextだけを使い、各質問へ回答してください。

強い通常RAGのbaselineとして、文書本文に明記された適用日、対象scope、承認・draft・失効、発行主体、新版・追補・例外を考慮してください。新しいだけのdraftや対象外文書は判断根拠にしません。同じ権威とscopeを持つ承認済み文書が矛盾し、contextから優先関係を決められない場合はdecisionをunresolved、answer_valueをunresolvedとします。

Document Position Dossierは、結論候補と、その文書を採用または不採用にできることを証明する管理記録をまとめた不可分な回答資料です。質問に適合するDossierが必要な根拠を含む場合は、そのDossierだけを一つのANSWER MATERIALとして選んでください。Dossier内の原文sourceへの展開と根拠用途の付与はFragrachが機械的に行います。

materials_usedには、実際に判断へ使ったANSWER MATERIALのIDだけを記録します。検索されたという理由だけで無関係な資料を列挙しないでください。answer_valueは「6 mm」「30日」「必要」のように短く正規化してください。

${blocks}`;
}

function selectedEvidence(result, retrieved) {
  const byMaterial = new Map((retrieved ?? []).map((item) => [item.source, item]));
  const selected = [...new Set(result.materials_used ?? [])]
    .map((material) => byMaterial.get(material))
    .filter(Boolean);
  const priority = result.decision === "unresolved"
    ? { reference: 1, governing: 2, conflict: 3 }
    : { reference: 1, conflict: 2, governing: 3 };
  const bySource = new Map();
  for (const material of selected) {
    const roles = Array.isArray(material.evidence_roles) && material.evidence_roles.length > 0
      ? material.evidence_roles
      : (material.citation_sources ?? material.sources ?? [material.source])
        .map((source) => ({ source, use: "governing" }));
    for (const role of roles) {
      if (!role?.source || !priority[role.use]) continue;
      const current = bySource.get(role.source);
      if (!current || priority[role.use] > priority[current]) bySource.set(role.source, role.use);
    }
  }
  return [...bySource.entries()].map(([source, use]) => ({ source, use }));
}

export function normalizeResults(content, questions, retrieval, topK = 5) {
  const expected = new Set(questions.map((question) => question.id));
  const seen = new Set();
  const rows = [];
  const rawResults = Array.isArray(content.results)
    ? content.results
    : Object.entries(content.results ?? {}).map(([questionId, result]) => ({
      ...result, question_id: questionId,
    }));
  for (const result of rawResults) {
    if (!expected.has(result.question_id) || seen.has(result.question_id)) continue;
    seen.add(result.question_id);
    const retrieved = (retrieval.get(result.question_id) ?? []).slice(0, topK);
    rows.push({
      ...result,
      materials_used: [...new Set(result.materials_used ?? [])],
      evidence: selectedEvidence(result, retrieved),
    });
  }
  return rows;
}

function percentage(value) {
  if (value === null || value === undefined) return "n/a";
  return `${(value * 100).toFixed(1)}%`;
}

function renderMarkdown(report) {
  const rows = Object.entries(report.conditions).map(([name, condition]) => {
    const metrics = condition.evaluation.metrics;
    const questions = condition.evaluation.questions;
    const correct = Math.round(metrics.answer_accuracy * questions);
    const valid = Math.round(metrics.dvaa_gross * questions);
    const ceiling = Math.round(metrics.evidence_ceiling * questions);
    const unsupported = correct - valid;
    const netCount = metrics.dvaa_net === null ? "n/a" : `${valid}/${ceiling}`;
    return `| ${name} | ${percentage(metrics.recall_at_k)} | ${percentage(metrics.answer_accuracy)}（${correct}/${questions}） | ${percentage(metrics.dvaa_gross)}（${valid}/${questions}） | ${percentage(metrics.evidence_ceiling)}（${ceiling}/${questions}） | ${percentage(metrics.dvaa_net)}（${netCount}） | ${percentage(metrics.validity_gap)}（${unsupported}/${questions}） |`;
  }).join("\n");
  return `# Dynamic Validity answer evaluation\n\n実施日時: ${report.generated_at}\n評価split: ${report.evaluation_split}\n\n全条件で同じLuna reader、回答形式、top-kを使った。DVAA-Grossは従来のDVAA-Fullと同じく評価splitの全質問を分母とする。Evidence Ceilingは完全根拠がcontextに存在する質問率、DVAA-Netはその質問だけを分母にした通過率であり、Gross = Ceiling × Netとなる。Ceilingが0の場合、Netは算出しない。\n\n| 条件 | 必要文書のR@5 | 判断・回答値の正答 | DVAA-Gross | Evidence Ceiling | DVAA-Net | 正答だが根拠不成立 |\n|---|---:|---:|---:|---:|---:|---:|\n${rows}\n`;
}

function parseArguments(argv) {
  const options = {
    corpusRoot: defaultCorpusRoot,
    inputDirectory: defaultInputDirectory,
    outputDirectory: null,
    provider: "codex-app-server",
    model: "gpt-5.6-luna",
    endpoint: "http://127.0.0.1:11434",
    reasoningEffort: "low",
    topK: 5,
    seed: 42,
    reuseExisting: false,
    batchSize: 2,
    concurrency: null,
    split: null,
    conditions: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--corpus") options.corpusRoot = path.resolve(argv[++index]);
    else if (argument === "--input") options.inputDirectory = path.resolve(argv[++index]);
    else if (argument === "--output") options.outputDirectory = path.resolve(argv[++index]);
    else if (argument === "--provider") options.provider = argv[++index];
    else if (argument === "--model") options.model = argv[++index];
    else if (argument === "--endpoint") options.endpoint = argv[++index];
    else if (argument === "--reasoning-effort") options.reasoningEffort = argv[++index];
    else if (argument === "--top-k") options.topK = Number.parseInt(argv[++index], 10);
    else if (argument === "--batch-size") options.batchSize = Number.parseInt(argv[++index], 10);
    else if (argument === "--concurrency") options.concurrency = Number.parseInt(argv[++index], 10);
    else if (argument === "--split") options.split = argv[++index];
    else if (argument === "--condition") options.conditions.push(parseConditionArgument(argv[++index]));
    else if (argument === "--reuse-existing") options.reuseExisting = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`unknown argument: ${argument}`);
  }
  options.concurrency ??= options.provider === "ollama" ? 1 : 8;
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
    throw new Error("--concurrency must be a positive integer");
  }
  options.outputDirectory ??= options.inputDirectory;
  return options;
}

export function parseConditionArgument(value) {
  const [name, file, stage = "T1", ...extra] = String(value).split(",");
  if (!name || !file || extra.length > 0 || !["T0", "T1"].includes(stage)) {
    throw new Error("--condition must be NAME,FILE[,T0|T1]");
  }
  return { name, file, stage };
}

export async function runDynamicValidityAnswers(options) {
  const pack = loadDynamicValidityPack(options.corpusRoot);
  const evaluationSplit = options.split ?? "holdout";
  const evaluationQuestions = options.split
    ? pack.questions.filter((question) => question.split === options.split)
    : pack.questions;
  if (evaluationQuestions.length === 0) throw new Error(`no questions found for split: ${options.split}`);
  const conditions = options.conditions.length > 0 ? options.conditions : [
    { name: "V-Frozen/T0", stage: "T0", file: "vanilla-frozen-t0.jsonl" },
    { name: "V-Frozen/T1", stage: "T1", file: "vanilla-frozen-t1.jsonl" },
    { name: "V-Retuned/T1", stage: "T1", file: "vanilla-retuned-t1.jsonl" },
    { name: "F-Compile/T1", stage: "T1", file: "f-compile-t1.jsonl" },
  ].filter((condition) => fs.existsSync(path.join(options.inputDirectory, "retrieval", condition.file)));
  for (const condition of conditions) {
    const file = path.join(options.inputDirectory, "retrieval", condition.file);
    if (!fs.existsSync(file)) throw new Error(`retrieval condition does not exist: ${file}`);
  }
  if (conditions.length === 0) throw new Error(`no retrieval conditions found under ${options.inputDirectory}`);
  fs.mkdirSync(options.outputDirectory, { recursive: true });
  const answersDirectory = path.join(options.outputDirectory, "answers");
  fs.mkdirSync(answersDirectory, { recursive: true });
  const clients = await Promise.all(Array.from({ length: options.concurrency }, () =>
    createStructuredChat({
      provider: options.provider,
      endpoint: options.endpoint,
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      cwd: repositoryRoot,
    })));
  const report = {
    schema_version: "1.0",
    experiment: "dynamic-validity-answers",
    generated_at: new Date().toISOString(),
    reader: clients[0].label,
    concurrency: options.concurrency,
    top_k: options.topK,
    evaluation_split: evaluationSplit,
    conditions: {},
  };
  const responseCache = new Map();
  try {
    for (const condition of conditions) {
      const rows = readJsonl(path.join(options.inputDirectory, "retrieval", condition.file));
      const retrieval = retrievalMap(rows);
      const existingPath = path.join(answersDirectory, condition.file);
      const existingById = options.reuseExisting && fs.existsSync(existingPath)
        ? new Map(readJsonl(existingPath)
          .filter((row) => Array.isArray(row.materials_used))
          .map((row) => [row.question_id, row]))
        : new Map();
      const batches = [];
      for (let offset = 0; offset < evaluationQuestions.length; offset += options.batchSize) {
        batches.push(evaluationQuestions.slice(offset, offset + options.batchSize));
      }
      const responses = await concurrentMap(
        batches, options.concurrency, async (batch, _batchIndex, workerIndex) => {
        const materials = new Map(batch.map((question) => [
          question.id,
          [...new Set((retrieval.get(question.id) ?? []).slice(0, options.topK)
            .map((item) => item.source))].sort(),
        ]));
        const prompt = answerPrompt(batch, condition.stage, retrieval, options.topK);
        const schema = answerSchema(batch.map((question) => question.id), materials);
        const responseKey = crypto.createHash("sha256")
          .update(prompt)
          .update("\0")
          .update(JSON.stringify(schema))
          .digest("hex");
        let response = responseCache.get(responseKey);
        if (!response && batch.every((question) => existingById.has(question.id))) {
          response = {
            content: { results: Object.fromEntries(batch.map((question) => {
              const { question_id: _questionId, ...result } = existingById.get(question.id);
              return [question.id, result];
            })) },
            usage: { reused_existing: true },
          };
        }
        if (!response) response = await clients[workerIndex].chat(prompt, schema, options.seed);
        responseCache.set(responseKey, response);
        return {
          outputs: normalizeResults(response.content, batch, retrieval, options.topK),
          usage: response.usage,
        };
      });
      const outputs = responses.flatMap((response) => response.outputs);
      const usages = responses.map((response) => response.usage);
      writeJsonl(existingPath, outputs);
      report.conditions[condition.name] = {
        usage: usages,
        full: scoreDvaaRun({
          questions: evaluationQuestions, stage: condition.stage, outputs, retrieval,
          profiles: pack.profiles, topK: options.topK,
        }),
        evaluation: scoreDvaaRun({
          questions: pack.questions, stage: condition.stage, outputs, retrieval,
          profiles: pack.profiles, topK: options.topK, split: evaluationSplit,
        }),
      };
      report.conditions[condition.name].holdout = report.conditions[condition.name].evaluation;
    }
  } finally {
    await Promise.all(clients.map((client) => client.close()));
  }
  const serializedReport = `${JSON.stringify(report, null, 2)}\n`;
  const renderedFindings = renderMarkdown(report);
  fs.writeFileSync(path.join(options.outputDirectory, "answer-report.json"), serializedReport);
  fs.writeFileSync(path.join(options.outputDirectory, "ANSWER_FINDINGS_ja.md"), renderedFindings);
  // Keep the original filenames while existing benchmark automation still refers to them.
  fs.writeFileSync(path.join(options.outputDirectory, "vanilla-answer-report.json"), serializedReport);
  fs.writeFileSync(path.join(options.outputDirectory, "VANILLA_ANSWER_FINDINGS_ja.md"), renderedFindings);
  return report;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node run-dynamic-validity-answers.mjs [--input <dir>] [--provider codex-app-server] [--model gpt-5.6-luna] [--batch-size 2] [--concurrency 8] [--split development|holdout] [--condition NAME,FILE[,T0|T1]]");
    return;
  }
  const report = await runDynamicValidityAnswers(options);
  for (const [name, condition] of Object.entries(report.conditions)) {
    const metrics = condition.evaluation.metrics;
    console.log(`${name}: R@5 ${percentage(metrics.recall_at_k)} Accuracy ${percentage(metrics.answer_accuracy)} DVAA-Gross ${percentage(metrics.dvaa_gross)} Ceiling ${percentage(metrics.evidence_ceiling)} DVAA-Net ${percentage(metrics.dvaa_net)}`);
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Error: ${error.stack ?? error.message}`);
    process.exitCode = 1;
  });
}
