#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadDynamicValidityPack, normalizeSource } from "./dynamic-validity-score.mjs";
import { buildDynamicValidityChunks } from "./dynamic-validity-corpus.mjs";
import { Bm25Index } from "./run-upper-bound.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../../..");
const defaultCorpusRoot = path.resolve(scriptDirectory, "../../corpora/aobane-industries-ja-dynamic-validity");
const defaultOutputDirectory = path.resolve(repositoryRoot, "target/benchmarks/dynamic-validity");

function stageIndex(stage) {
  return stage === "T0" ? 0 : 1;
}

function stageSources(manifest, stage) {
  return new Set(manifest.documents
    .filter((document) => stageIndex(document.introduced_at) <= stageIndex(stage))
    .map((document) => normalizeSource(document.source)));
}

function bestChunk(source, question, chunksBySource) {
  const candidates = chunksBySource.get(normalizeSource(source)) ?? [];
  if (candidates.length === 0) throw new Error(`Gold-Context sourceにchunkがありません: ${source}`);
  return new Bm25Index(candidates, { ngramSizes: [1, 2, 3] }).search(question, 1)[0]?.document ?? candidates[0];
}

function serializeItem(document, rank, oracleReason) {
  return {
    rank,
    source: normalizeSource(document.source),
    section: document.section,
    text: document.text,
    score: 1 / rank,
    sparse_rank: null,
    dense_rank: null,
    oracle_reason: oracleReason,
  };
}

export function goldContextRetrieval(pack, corpusRoot, stage, fallbackRows = []) {
  const allowed = stageSources(pack.manifest, stage);
  const chunks = buildDynamicValidityChunks(corpusRoot, pack.manifest, { strategy: "fixed", maxChars: 1024, overlapParagraphs: 1 })
    .filter((chunk) => allowed.has(normalizeSource(chunk.source)));
  const chunksBySource = new Map();
  for (const chunk of chunks) {
    const source = normalizeSource(chunk.source);
    if (!chunksBySource.has(source)) chunksBySource.set(source, []);
    chunksBySource.get(source).push(chunk);
  }
  const fallbackByQuestion = new Map(fallbackRows.map((row) => [row.question_id, row.results]));
  return pack.questions.map((question) => {
    const gold = question.stages[stage];
    const required = gold.required_evidence_sets[0].map(normalizeSource);
    const results = required.map((source, index) =>
      serializeItem(bestChunk(source, question.question, chunksBySource), index + 1, "gold-required-evidence"),
    );
    const seen = new Set(required);
    for (const item of fallbackByQuestion.get(question.id) ?? []) {
      const source = normalizeSource(item.source);
      if (seen.has(source)) continue;
      seen.add(source);
      results.push({ ...item, rank: results.length + 1, oracle_reason: "vanilla-fallback" });
      if (results.length === 20) break;
    }
    return { question_id: question.id, stage, results };
  });
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8").trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
}

function writeJsonl(filePath, rows) {
  fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

function parseArguments(argv) {
  const options = { corpusRoot: defaultCorpusRoot, outputDirectory: defaultOutputDirectory };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--corpus") options.corpusRoot = path.resolve(argv[++index]);
    else if (argument === "--output") options.outputDirectory = path.resolve(argv[++index]);
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node run-dynamic-validity-oracle.mjs [--output <dir>]");
    return;
  }
  const pack = loadDynamicValidityPack(options.corpusRoot);
  const retrievalDirectory = path.join(options.outputDirectory, "retrieval");
  fs.mkdirSync(retrievalDirectory, { recursive: true });
  for (const stage of ["T0", "T1"]) {
    const fallback = readJsonl(path.join(retrievalDirectory, `vanilla-frozen-${stage.toLowerCase()}.jsonl`));
    const rows = goldContextRetrieval(pack, options.corpusRoot, stage, fallback);
    writeJsonl(path.join(retrievalDirectory, `gold-context-${stage.toLowerCase()}.jsonl`), rows);
  }
  console.log(`Gold-Context retrieval: ${retrievalDirectory}`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) main();
