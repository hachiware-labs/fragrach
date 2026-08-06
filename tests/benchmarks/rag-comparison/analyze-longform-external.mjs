#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  diagnostics,
  evidenceTargets,
  truncateForBudget,
} from "./run-longform-raw-comparison.mjs";
import { scoreExternalRows } from "./score-external-retrieval.mjs";

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const defaultCorpus = path.resolve(scriptRoot, "../../corpora/fragrach-enterprise-ja-longform");
const readJsonl = (file) => fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const pct = (value) => value == null ? "n/a" : `${(value * 100).toFixed(1)}%`;

function parseArgs(argv) {
  const options = {
    corpus: defaultCorpus,
    input: null,
    canonicalChunks: null,
    output: null,
    sourcePrefix: null,
    tokenBudgets: [1500, 2500, 4000],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--corpus") options.corpus = path.resolve(argv[++index]);
    else if (argument === "--input") options.input = path.resolve(argv[++index]);
    else if (argument === "--canonical-chunks") options.canonicalChunks = path.resolve(argv[++index]);
    else if (argument === "--output") options.output = path.resolve(argv[++index]);
    else if (argument === "--source-prefix") options.sourcePrefix = argv[++index].replaceAll("\\", "/").replace(/\/$/, "");
    else if (argument === "--token-budgets") options.tokenBudgets = argv[++index].split(",").map(Number);
    else if (argument === "--help") options.help = true;
    else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

function markdown(report) {
  const primary = Object.entries(report.retrieval_diagnostics).flatMap(([condition, values]) =>
    [5, 10, 20].map((k) => {
      const value = values[String(k)];
      return `| ${condition} | ${k} | ${value.average_context_tokens.toFixed(0)} | ${value.evidence_hits_per_1000_tokens.toFixed(2)} | ${pct(value.gold_position_recall.start)} | ${pct(value.gold_position_recall.middle)} | ${pct(value.gold_position_recall.end)} |`;
    }),
  ).join("\n");
  const budgets = Object.entries(report.token_budget_diagnostics).flatMap(([budget, conditions]) =>
    Object.entries(conditions).map(([condition, values]) => {
      const value = values["20"];
      const accuracy = report.token_budget_metrics[budget][condition];
      return `| ${budget} | ${condition} | ${pct(accuracy.recall_at_k["20"])} | ${pct(accuracy.relation_path_recall_at_k["20"])} | ${pct(accuracy.conflict_complete_rate_at_k["20"])} | ${value.average_context_tokens.toFixed(0)} | ${value.evidence_hits_per_1000_tokens.toFixed(2)} | ${pct(value.gold_position_recall.start)} | ${pct(value.gold_position_recall.middle)} | ${pct(value.gold_position_recall.end)} |`;
    }),
  ).join("\n");
  return `# 長文外部検索のコンテキスト診断\n\n` +
    `検索方式が返した共通チャンクを、入力トークン効率とGold位置別に診断した。検索精度のR@kは共通Gold採点器の結果を参照する。\n\n` +
    `| 条件 | k | 平均tokens | 根拠/1k tokens | 前半 | 中盤 | 後半 |\n|---|---:|---:|---:|---:|---:|---:|\n${primary}\n\n` +
    `## 固定コンテキスト予算\n\n| 予算 | 条件 | 根拠再現 | Relation Path | Conflict両側 | 平均実使用tokens | 根拠/1k tokens | 前半 | 中盤 | 後半 |\n|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|\n${budgets}\n`;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node analyze-longform-external.mjs --input retrieval.jsonl --canonical-chunks chunks.jsonl --output DIR --source-prefix sources/<industry>/<department>/<intent>");
    return;
  }
  if (!options.input || !options.canonicalChunks || !options.output || !options.sourcePrefix) {
    throw new Error("--input, --canonical-chunks, --output and --source-prefix are required");
  }
  if (fs.existsSync(options.output)) throw new Error(`output already exists: ${options.output}`);
  const parts = options.sourcePrefix.split("/");
  if (parts.length !== 4 || parts[0] !== "sources") throw new Error("source prefix must be sources/<industry>/<department>/<intent>");
  const [, industry, department, intent] = parts;
  const questions = readJsonl(path.join(options.corpus, "evaluation/questions.jsonl")).filter((question) =>
    question.industry === industry && question.department === department && (question.intent_id ?? question.purpose) === intent,
  );
  const profiles = readJsonl(path.join(options.corpus, "gold/profiles.jsonl"));
  const relations = readJsonl(path.join(options.corpus, "gold/relations.jsonl"));
  const chunks = readJsonl(options.canonicalChunks).filter((chunk) => String(chunk.source).replaceAll("\\", "/").startsWith(`${options.sourcePrefix}/`));
  const rows = readJsonl(options.input);
  const questionIds = new Set(questions.map((question) => question.id));
  const selectedRows = rows.filter((row) => questionIds.has(row.question_id));
  if (questions.length === 0 || chunks.length === 0 || selectedRows.length === 0) throw new Error("no matching questions, chunks, or retrieval rows");
  const targetsByQuestion = evidenceTargets(questions, chunks);
  const tokenBudgetDiagnostics = {};
  const tokenBudgetMetrics = {};
  for (const budget of options.tokenBudgets) {
    const truncated = truncateForBudget(selectedRows, budget);
    tokenBudgetDiagnostics[String(budget)] = diagnostics(truncated, targetsByQuestion, [20]);
    tokenBudgetMetrics[String(budget)] = scoreExternalRows({
      rows: truncated,
      questions,
      profiles,
      relations,
    }).conditions;
  }
  const report = {
    schema_version: "1.0",
    experiment: "longform-external-context-diagnostics",
    generated_at: new Date().toISOString(),
    input: options.input,
    canonical_chunks: options.canonicalChunks,
    source_prefix: options.sourcePrefix,
    questions: questions.length,
    chunks: chunks.length,
    retrieval_diagnostics: diagnostics(selectedRows, targetsByQuestion),
    retrieval_metrics: scoreExternalRows({ rows: selectedRows, questions, profiles, relations }).conditions,
    token_budget_diagnostics: tokenBudgetDiagnostics,
    token_budget_metrics: tokenBudgetMetrics,
  };
  fs.mkdirSync(options.output, { recursive: true });
  fs.writeFileSync(path.join(options.output, "metrics.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(options.output, "REPORT_ja.md"), markdown(report), "utf8");
  console.log(markdown(report));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error); process.exitCode = 1; }
}
