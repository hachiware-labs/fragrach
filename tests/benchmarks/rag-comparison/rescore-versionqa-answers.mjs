#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { metrics } from "./run-versionqa-answers.mjs";
import { loadEvidenceAnnotations } from "./versionqa-evidence-score.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../../..");

function readJsonl(file) {
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function retrievalMap(rows, condition) {
  return new Map(rows.filter((row) => row.condition === condition).map((row) => [row.question_id, row.results]));
}

function parseArguments(argv) {
  const options = {
    corpus: path.join(repositoryRoot, "target/benchmarks/versionqa/prepared"),
    rawRetrieval: path.join(repositoryRoot, "target/benchmarks/versionqa/raw-retrieval/retrieval.jsonl"),
    fragrachRetrieval: path.join(repositoryRoot, "target/benchmarks/versionqa/fragrach-retrieval/retrieval.jsonl"),
    answers: path.join(repositoryRoot, "target/benchmarks/versionqa/answers"),
    output: path.join(repositoryRoot, "target/benchmarks/versionqa/answers-evidence-unit"),
    evidenceContracts: path.join(scriptDirectory, "versionqa-evidence-contracts.json"),
    topK: 5,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--corpus") options.corpus = path.resolve(argv[++index]);
    else if (argument === "--raw-retrieval") options.rawRetrieval = path.resolve(argv[++index]);
    else if (argument === "--fragrach-retrieval") options.fragrachRetrieval = path.resolve(argv[++index]);
    else if (argument === "--answers") options.answers = path.resolve(argv[++index]);
    else if (argument === "--output") options.output = path.resolve(argv[++index]);
    else if (argument === "--evidence-contracts") options.evidenceContracts = path.resolve(argv[++index]);
    else if (argument === "--top-k") options.topK = Number.parseInt(argv[++index], 10);
    else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

const options = parseArguments(process.argv.slice(2));
if (fs.existsSync(options.output)) throw new Error(`output already exists: ${options.output}`);

const questions = readJsonl(path.join(options.corpus, "evaluation/questions.jsonl"))
  .filter((question) => question.version_sensitive);
const annotations = loadEvidenceAnnotations(options.evidenceContracts);
const rawRows = readJsonl(options.rawRetrieval);
const fragrachRows = readJsonl(options.fragrachRetrieval);
const conditions = [
  ["raw-ruri-hybrid", retrievalMap(rawRows, "ruri-hybrid-sparse-0.90")],
  ["fragrach-decision-packet", retrievalMap(fragrachRows, "fragrach-decision-packet")],
];

const report = {
  schema_version: "2.0",
  experiment: "versionqa-answer-evidence-unit-rescore",
  source_answer_run: path.relative(repositoryRoot, options.answers).replaceAll("\\", "/"),
  top_k: options.topK,
  evaluation_contract: {
    evidence_granularity: "evidence-unit",
    evidence_unit_types: ["source_span", "document_absence", "version_inventory", "semantic_diff"],
    disputed_gold_policy: "exclude from headline denominators and retain case-level reason",
    document_recall_role: "diagnostic only; never used as the DVAA ceiling",
  },
  conditions: {},
};

for (const [name, retrieval] of conditions) {
  const answers = readJsonl(path.join(options.answers, `${name}-answers.jsonl`));
  const judgments = readJsonl(path.join(options.answers, `${name}-judgments.jsonl`));
  report.conditions[name] = { metrics: metrics(questions, answers, judgments, retrieval, options.topK, annotations) };
}

report.completed_at = new Date().toISOString();
fs.mkdirSync(options.output, { recursive: true });
fs.writeFileSync(path.join(options.output, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");

for (const [name, condition] of Object.entries(report.conditions)) {
  console.log(name, JSON.stringify(condition.metrics.overall));
}
