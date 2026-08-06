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

function readJsonl(file) {
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function writeJsonl(file, rows) {
  fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

function parseArguments(argv) {
  const options = {
    corpus: path.join(repositoryRoot, "target/benchmarks/multihop-rag/prepared-v2"),
    chunks: path.join(repositoryRoot, "target/benchmarks/multihop-rag/chunks-512.jsonl"),
    output: path.join(repositoryRoot, "target/benchmarks/multihop-rag/raw-retrieval-v2"),
    endpoint: "http://127.0.0.1:11434",
    batchSize: 16,
    candidateK: 100,
    topK: 20,
    weights: [0, 0.25, 0.5, 0.75, 0.9, 1],
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
    else if (argument === "--weights") options.weights = argv[++index].split(",").map(Number);
    else if (argument === "--embedding-cache") options.embeddingCache = path.resolve(argv[++index]);
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

function compact(item, rank) {
  return {
    rank,
    chunk_id: item.document.id,
    source: item.document.source,
    section: item.document.section,
    text: item.document.text,
    token_count: item.document.token_count,
    score: item.score,
    sparse_rank: item.sparse_rank ?? null,
    dense_rank: item.dense_rank ?? null,
  };
}

function retrievedSources(results, k) {
  return new Set(results.slice(0, k).map((item) => item.document?.source ?? item.source));
}

export function retrievalMetrics(questions, retrieval, k = 5) {
  const answerable = questions.filter((question) => question.gold_evidence.sources.length > 0 && question.gold_status === "verified");
  const rows = answerable.map((question) => {
    const gold = new Set(question.gold_evidence.sources);
    const found = retrievedSources(retrieval.get(question.id) ?? [], k);
    const hits = [...gold].filter((source) => found.has(source)).length;
    return { recall: hits / gold.size, complete: hits === gold.size };
  });
  return {
    questions: answerable.length,
    document_recall_at_k: rows.length === 0 ? null : rows.reduce((sum, row) => sum + row.recall, 0) / rows.length,
    evidence_ceiling_at_k: rows.length === 0 ? null : rows.filter((row) => row.complete).length / rows.length,
  };
}

function compareTune(left, right) {
  return right.metrics.evidence_ceiling_at_k - left.metrics.evidence_ceiling_at_k
    || right.metrics.document_recall_at_k - left.metrics.document_recall_at_k
    || right.weight - left.weight;
}

function sourcePublishedAt(corpus, source) {
  const text = fs.readFileSync(path.join(corpus, ...source.split("/")), "utf8");
  const value = /^published_at:\s*"([^"]+)"/m.exec(text)?.[1];
  if (!value) throw new Error(`published_at missing: ${source}`);
  return Date.parse(value);
}

function subsetVectors(chunks, values, dimensions, predicate) {
  const documents = [];
  const selected = [];
  chunks.forEach((chunk, index) => {
    if (!predicate(chunk)) return;
    documents.push(chunk);
    selected.push(index);
  });
  const subset = new Float32Array(documents.length * dimensions);
  selected.forEach((sourceRow, targetRow) => {
    subset.set(values.subarray(sourceRow * dimensions, (sourceRow + 1) * dimensions), targetRow * dimensions);
  });
  return { documents, values: subset };
}

function retrieve(indexes, questions, queryVectors, candidateK) {
  const result = new Map();
  questions.forEach((question) => {
    const vector = queryVectors.get(question.id);
    result.set(question.id, {
      sparse: indexes.bm25.search(question.question, candidateK),
      dense: indexes.dense.search(vector, candidateK),
    });
  });
  return result;
}

function fuse(base, questions, weight, candidateK) {
  return new Map(questions.map((question) => {
    const row = base.get(question.id);
    return [question.id, weightedReciprocalRankFusion(row.sparse, row.dense, weight, candidateK)];
  }));
}

function rowsFor(condition, questions, retrieval, topK) {
  return questions.map((question) => ({
    condition,
    question_id: question.id,
    category: question.category,
    split: question.split,
    corpus_phase: question.corpus_phase,
    results: (retrieval.get(question.id) ?? []).slice(0, topK).map((item, index) => compact(item, index + 1)),
  }));
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node run-multihop-rag-retrieval.mjs [--output DIR] [--weights 0,0.5,0.9,1]");
    return;
  }
  if (fs.existsSync(options.output)) throw new Error(`output already exists: ${options.output}`);
  const manifest = JSON.parse(fs.readFileSync(path.join(options.corpus, "manifest.json"), "utf8"));
  const allQuestions = readJsonl(path.join(options.corpus, "evaluation/questions.jsonl"));
  const questions = allQuestions.filter((question) => ["development", "diagnostic", "holdout"].includes(question.split));
  const development = questions.filter((question) => question.split === "development");
  const diagnostic = questions.filter((question) => question.split === "diagnostic");
  const holdout = questions.filter((question) => question.split === "holdout");
  const developmentT0 = development.filter((question) => question.corpus_phase === "T0");
  const chunks = readJsonl(options.chunks);
  const cutoff = Date.parse(manifest.t0_t1_cutoff);
  const phaseBySource = new Map([...new Set(chunks.map((chunk) => chunk.source))]
    .map((source) => [source, sourcePublishedAt(options.corpus, source) <= cutoff ? "T0" : "T1"]));
  const profile = embeddingProfiles.ruri;
  const chunkProfile = path.basename(options.chunks, path.extname(options.chunks));
  const stored = await documentVectors(chunks, `multihop-rag-ruri-${chunkProfile}`, profile, {
    cacheDirectory: options.embeddingCache,
    endpoint: options.endpoint,
    batchSize: options.batchSize,
  });
  const embedded = await embedCollection(questions.map((question) => profile.query(question.question)), {
    endpoint: options.endpoint,
    model: profile.model,
    batchSize: options.batchSize,
    label: "MultiHop-RAG pilot questions",
  });
  const queryVectors = new Map(questions.map((question, index) => [question.id, embedded[index]]));
  const t0Subset = subsetVectors(chunks, stored.values, stored.manifest.dimensions, (chunk) => phaseBySource.get(chunk.source) === "T0");
  const indexes = {
    T0: { bm25: new Bm25Index(t0Subset.documents), dense: new DenseIndex(t0Subset.documents, t0Subset.values, stored.manifest.dimensions) },
    T1: { bm25: new Bm25Index(chunks), dense: new DenseIndex(chunks, stored.values, stored.manifest.dimensions) },
  };
  const baseT0 = retrieve(indexes.T0, questions, queryVectors, options.candidateK);
  const baseT1 = retrieve(indexes.T1, questions, queryVectors, options.candidateK);
  const tune = (base, selected) => options.weights.map((weight) => {
    const retrieval = fuse(base, selected, weight, options.candidateK);
    return { weight, metrics: retrievalMetrics(selected, retrieval, 5) };
  }).sort(compareTune)[0];
  const frozen = tune(baseT0, developmentT0);
  const retuned = tune(baseT1, development);
  const retrievals = {
    "bm25-t1": new Map(questions.map((question) => [question.id, baseT1.get(question.id).sparse])),
    "ruri-dense-t1": new Map(questions.map((question) => [question.id, baseT1.get(question.id).dense])),
    [`hybrid-frozen-${frozen.weight.toFixed(2)}-t1`]: fuse(baseT1, questions, frozen.weight, options.candidateK),
    [`hybrid-retuned-${retuned.weight.toFixed(2)}-t1`]: fuse(baseT1, questions, retuned.weight, options.candidateK),
  };
  const rows = Object.entries(retrievals).flatMap(([condition, retrieval]) => rowsFor(condition, questions, retrieval, options.topK));
  const byCategory = (selected, retrieval) => Object.fromEntries([...new Set(selected.map((question) => question.category))].map((category) => [
    category,
    retrievalMetrics(selected.filter((question) => question.category === category), retrieval, 5),
  ]));
  const report = {
    schema_version: "1.0",
    experiment: "multihop-rag-t0-t1-raw-retrieval",
    source_commit: manifest.source_commit,
    leakage_contract: "Only development questions select Hybrid weights. Diagnostic Gold is used for iteration; untouched holdout Gold is reserved and is not scored in this run.",
    corpus: { documents: manifest.documents, chunks: chunks.length, t0_chunks: t0Subset.documents.length, cutoff: manifest.t0_t1_cutoff },
    questions: { development: development.length, development_t0: developmentT0.length, diagnostic: diagnostic.length, holdout_reserved: holdout.length },
    embedding: { profile: "ruri", ...stored.manifest },
    tuning: { frozen_t0: frozen, retuned_t1: retuned },
    conditions: Object.fromEntries(Object.entries(retrievals).map(([condition, retrieval]) => [condition, {
      development: retrievalMetrics(development, retrieval, 5),
      diagnostic: retrievalMetrics(diagnostic, retrieval, 5),
      diagnostic_by_category: byCategory(diagnostic, retrieval),
      holdout_status: "reserved; not scored in this run",
    }])),
  };
  fs.mkdirSync(options.output, { recursive: true });
  writeJsonl(path.join(options.output, "retrieval.jsonl"), rows);
  fs.writeFileSync(path.join(options.output, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
