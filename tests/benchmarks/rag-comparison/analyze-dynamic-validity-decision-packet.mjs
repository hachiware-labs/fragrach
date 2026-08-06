#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadDynamicValidityPack, scoreDvaaRun } from "./dynamic-validity-score.mjs";
import { normalizeResults } from "./run-dynamic-validity-answers.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));

function readJsonl(filePath) {
  return fs.readFileSync(filePath, "utf8").trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
}

function parseArguments(argv) {
  const options = {
    corpus: path.resolve(scriptDirectory, "../../corpora/aobane-industries-ja-dynamic-validity-scale"),
    input: null,
    output: null,
    topK: 5,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--corpus") options.corpus = path.resolve(argv[++index]);
    else if (argument === "--input") options.input = path.resolve(argv[++index]);
    else if (argument === "--output") options.output = path.resolve(argv[++index]);
    else if (argument === "--top-k") options.topK = Number.parseInt(argv[++index], 10);
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (!options.input) throw new Error("--input is required");
  options.output ??= options.input;
  return options;
}

function mapRetrieval(rows, transform) {
  return rows.map((row) => ({
    ...row,
    results: row.results.map((result) => transform(structuredClone(result))),
  }));
}

function withoutVerifier(result) {
  const removed = new Set((result.evidence_roles ?? [])
    .filter((role) => role.basis === "verifier")
    .map((role) => role.source));
  if (removed.size === 0) return result;
  result.evidence_roles = result.evidence_roles.filter((role) => !removed.has(role.source));
  result.sources = (result.sources ?? []).filter((source) => !removed.has(source));
  result.citation_sources = (result.citation_sources ?? []).filter((source) => !removed.has(source));
  return result;
}

function invertPositionUse(result) {
  result.evidence_roles = (result.evidence_roles ?? []).map((role) => {
    if (role.basis === "operative") return { ...role, use: "reference" };
    if (role.basis === "excluded") return { ...role, use: "governing" };
    return role;
  });
  return result;
}

function scoreCondition(pack, rows, rawAnswers, topK) {
  const retrieval = new Map(rows.map((row) => [row.question_id, row.results]));
  const outputs = normalizeResults({ results: rawAnswers }, pack.questions, retrieval, topK);
  const report = scoreDvaaRun({
    questions: pack.questions,
    stage: "T1",
    outputs,
    retrieval,
    profiles: pack.profiles,
    topK,
    split: "holdout",
  });
  const { dvaa_gross: gross, evidence_ceiling: ceiling, dvaa_net: net } = report.metrics;
  if (net !== null && Math.abs(gross - ceiling * net) > 1e-12) {
    throw new Error(`DVAA decomposition invariant failed: ${gross} != ${ceiling} * ${net}`);
  }
  return report;
}

function percentage(value) {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function renderMarkdown(report) {
  const rows = Object.entries(report.conditions).map(([name, condition]) => {
    const metrics = condition.metrics;
    return `| ${name} | ${percentage(metrics.recall_at_k)} | ${percentage(metrics.answer_accuracy)} | ${percentage(metrics.evidence_ceiling)} | ${percentage(metrics.dvaa_net)} | ${percentage(metrics.dvaa_gross)} |`;
  }).join("\n");
  return `# Decision Packet causal ablation\n\n同じLuna回答と同じ検索順位を固定し、FragrachがPacketから展開する根拠役割だけを変更した。これは再生成性能ではなく、DVAAが文書効力構造へ反応するかを確かめる因果診断である。\n\n| 条件 | R@5 | Answer Accuracy | Evidence Ceiling | DVAA-Net | DVAA-Gross |\n|---|---:|---:|---:|---:|---:|\n${rows}\n\n` +
    "`packet_full`は正しいPosition、`without_verifier`は確認台帳を除去、`position_use_inverted`は採用文書と除外文書の用途を反転した。各条件で `Gross = Ceiling × Net` が丸め前に成立する。\n";
}

export function analyzeDecisionPacket(options) {
  const pack = loadDynamicValidityPack(options.corpus);
  const retrievalPath = path.join(options.input, "retrieval/f-compile-t1.jsonl");
  const answersPath = path.join(options.input, "answers/f-compile-t1.jsonl");
  const retrievalRows = readJsonl(retrievalPath);
  const rawAnswers = readJsonl(answersPath).map(({ evidence: _evidence, ...answer }) => answer);
  const conditions = {
    packet_full: scoreCondition(pack, retrievalRows, rawAnswers, options.topK),
    without_verifier: scoreCondition(
      pack, mapRetrieval(retrievalRows, withoutVerifier), rawAnswers, options.topK,
    ),
    position_use_inverted: scoreCondition(
      pack, mapRetrieval(retrievalRows, invertPositionUse), rawAnswers, options.topK,
    ),
  };
  const report = {
    schema_version: "1.0",
    experiment: "dynamic-validity-decision-packet-causal-ablation",
    generated_at: new Date().toISOString(),
    fixed: ["questions", "retrieval rank", "Luna answer", "selected material"],
    conditions,
  };
  fs.mkdirSync(options.output, { recursive: true });
  fs.writeFileSync(path.join(options.output, "decision-packet-ablation.json"), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(options.output, "DECISION_PACKET_ABLATION_ja.md"), renderMarkdown(report));
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = analyzeDecisionPacket(parseArguments(process.argv.slice(2)));
  for (const [name, condition] of Object.entries(report.conditions)) {
    const metrics = condition.metrics;
    console.log(`${name}: Ceiling ${percentage(metrics.evidence_ceiling)} Net ${percentage(metrics.dvaa_net)} Gross ${percentage(metrics.dvaa_gross)}`);
  }
}
