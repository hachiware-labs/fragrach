#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Bm25Index } from "./run-upper-bound.mjs";
import {
  DenseIndex,
  documentVectors,
  embedCollection,
  embeddingProfiles,
  weightedReciprocalRankFusion,
} from "./run-hybrid-tuning.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../../..");

function parseArguments(argv) {
  const options = {
    corpus: path.join(repositoryRoot, "target/benchmarks/versionqa/prepared"),
    chunks: path.join(repositoryRoot, "target/benchmarks/versionqa/chunks-512.jsonl"),
    output: path.join(repositoryRoot, "target/benchmarks/versionqa/raw-retrieval"),
    endpoint: "http://127.0.0.1:11434",
    batchSize: 16,
    candidateK: 100,
    topK: 20,
    sparseWeight: 0.9,
    embeddingCache: path.join(repositoryRoot, "target/benchmarks/embedding-cache"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--corpus") options.corpus = path.resolve(argv[++index]);
    else if (argument === "--chunks") options.chunks = path.resolve(argv[++index]);
    else if (argument === "--output") options.output = path.resolve(argv[++index]);
    else if (argument === "--endpoint") options.endpoint = argv[++index];
    else if (argument === "--batch-size") options.batchSize = Number.parseInt(argv[++index], 10);
    else if (argument === "--candidate-k") options.candidateK = Number.parseInt(argv[++index], 10);
    else if (argument === "--top-k") options.topK = Number.parseInt(argv[++index], 10);
    else if (argument === "--sparse-weight") options.sparseWeight = Number.parseFloat(argv[++index]);
    else if (argument === "--embedding-cache") options.embeddingCache = path.resolve(argv[++index]);
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

function sourceFamily(source) {
  return /^sources\/([^/]+)\//.exec(source)?.[1] ?? null;
}

function sourceVersion(source) {
  return /\/([^/]+)\.md$/.exec(source)?.[1] ?? null;
}

function uniqueSources(items, limit) {
  const sources = [];
  const seen = new Set();
  for (const item of items.slice(0, limit)) {
    for (const source of item.sources ?? [item.source]) {
      if (!source || seen.has(source)) continue;
      seen.add(source);
      sources.push(source);
    }
  }
  return sources;
}

export function scoreRows(rows, questions, ks = [5, 10, 20]) {
  const byId = new Map(questions.map((question) => [question.id, question]));
  const conditions = [...new Set(rows.map((row) => row.condition))];
  const scoreCondition = (conditionRows) => Object.fromEntries(ks.map((k) => {
    let recall = 0;
    let complete = 0;
    let validPrecision = 0;
    let staleRate = 0;
    let wrongFamilyRate = 0;
    let inventoryFamilyHit = 0;
    for (const row of conditionRows) {
      const question = byId.get(row.question_id);
      const gold = new Set(question.gold_evidence.sources);
      const family = question.gold_evidence.family;
      const versions = new Set(question.gold_evidence.versions);
      const sources = uniqueSources(row.results, k);
      const hits = sources.filter((source) => gold.has(source)).length;
      recall += gold.size === 0 ? 0 : hits / gold.size;
      complete += gold.size > 0 && hits === gold.size ? 1 : 0;
      validPrecision += sources.length === 0 ? 0 : hits / sources.length;
      staleRate += sources.length === 0 ? 0 : sources.filter((source) =>
        sourceFamily(source) === family && !versions.has(sourceVersion(source))
      ).length / sources.length;
      wrongFamilyRate += sources.length === 0 ? 0 : sources.filter((source) =>
        sourceFamily(source) !== family
      ).length / sources.length;
      inventoryFamilyHit += question.gold_evidence.mode !== "version_inventory"
        ? 0
        : Number(sources.some((source) => sourceFamily(source) === family));
    }
    const count = conditionRows.length || 1;
    const inventoryCount = conditionRows.filter((row) =>
      byId.get(row.question_id).gold_evidence.mode === "version_inventory"
    ).length;
    return [String(k), {
      source_recall: recall / count,
      evidence_complete_rate: complete / count,
      valid_source_precision: validPrecision / count,
      stale_same_family_rate: staleRate / count,
      wrong_family_rate: wrongFamilyRate / count,
      inventory_family_hit_rate: inventoryCount === 0 ? null : inventoryFamilyHit / inventoryCount,
    }];
  }));
  return Object.fromEntries(conditions.map((condition) => {
    const conditionRows = rows.filter((row) => row.condition === condition);
    const overall = scoreCondition(conditionRows);
    const byCategory = Object.fromEntries([...new Set(conditionRows.map((row) => byId.get(row.question_id).category))]
      .map((category) => [category, scoreCondition(conditionRows.filter((row) => byId.get(row.question_id).category === category))]));
    return [condition, { questions: conditionRows.length, at_k: overall, by_category: byCategory }];
  }));
}

function compactResult(item, rank) {
  return {
    rank,
    chunk_id: item.document.id,
    source: item.document.source,
    section: item.document.section,
    score: item.score,
    sparse_rank: item.sparse_rank ?? null,
    dense_rank: item.dense_rank ?? null,
    text: item.document.text,
    token_count: item.document.token_count,
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node run-versionqa-raw-retrieval.mjs [--corpus DIR] [--chunks FILE] [--output DIR]");
    return;
  }
  if (fs.existsSync(options.output)) throw new Error(`output already exists: ${options.output}`);
  const questions = readJsonl(path.join(options.corpus, "evaluation/questions.jsonl"));
  const chunks = readJsonl(options.chunks);
  const profile = embeddingProfiles.ruri;
  const stored = await documentVectors(chunks, "versionqa-ruri-512", profile, {
    cacheDirectory: options.embeddingCache,
    endpoint: options.endpoint,
    batchSize: options.batchSize,
  });
  const queryVectors = await embedCollection(questions.map((question) => profile.query(question.question)), {
    endpoint: options.endpoint,
    model: profile.model,
    batchSize: options.batchSize,
    label: "VersionQA questions",
  });
  const bm25 = new Bm25Index(chunks);
  const dense = new DenseIndex(chunks, stored.values, stored.manifest.dimensions);
  const rows = [];
  questions.forEach((question, index) => {
    const sparse = bm25.search(question.question, options.candidateK);
    const denseResults = dense.search(queryVectors[index], options.candidateK);
    const hybrid = weightedReciprocalRankFusion(
      sparse,
      denseResults,
      options.sparseWeight,
      options.candidateK,
    );
    for (const [condition, results] of [
      ["bm25", sparse],
      ["ruri-dense", denseResults],
      [`ruri-hybrid-sparse-${options.sparseWeight.toFixed(2)}`, hybrid],
    ]) {
      rows.push({
        condition,
        question_id: question.id,
        category: question.category,
        version_sensitive: question.version_sensitive,
        results: results.slice(0, options.topK).map((item, rank) => compactResult(item, rank + 1)),
      });
    }
  });
  const report = {
    schema_version: "1.0",
    experiment: "versionqa-raw-retrieval",
    source_commit: JSON.parse(fs.readFileSync(path.join(options.corpus, "manifest.json"), "utf8")).source_commit,
    chunking: { tokens: 512, overlap_tokens: 50, chunks: chunks.length },
    embedding: { profile: "ruri", ...stored.manifest },
    hybrid: { sparse_weight: options.sparseWeight, rank_constant: 60 },
    questions: questions.length,
    version_sensitive_questions: questions.filter((question) => question.version_sensitive).length,
    metrics: scoreRows(rows, questions),
    version_sensitive_metrics: scoreRows(rows.filter((row) => row.version_sensitive), questions),
  };
  fs.mkdirSync(options.output, { recursive: true });
  writeJsonl(path.join(options.output, "retrieval.jsonl"), rows);
  fs.writeFileSync(path.join(options.output, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
