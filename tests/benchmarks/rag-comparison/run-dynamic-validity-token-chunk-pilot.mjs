#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  completeEvidenceAtK,
  loadDynamicValidityPack,
  normalizeSource,
  recallAtK,
} from "./dynamic-validity-score.mjs";
import {
  DenseIndex,
  documentVectors,
  embedCollection,
  embeddingProfiles,
  weightedReciprocalRankFusion,
} from "./run-hybrid-tuning.mjs";
import { Bm25Index } from "./run-upper-bound.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../../..");

function readJsonl(file) {
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function parseArguments(argv) {
  const options = {
    corpus: path.resolve(scriptDirectory, "../../corpora/aobane-industries-ja-dynamic-validity-scale"),
    output: path.resolve(repositoryRoot, "target/benchmarks/dynamic-validity-token-chunk-pilot-v1/retrieval"),
    variants: [],
    endpoint: "http://127.0.0.1:11434",
    batchSize: 16,
    candidateK: 50,
    sparseWeight: 0.4,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--corpus") options.corpus = path.resolve(argv[++index]);
    else if (argument === "--output") options.output = path.resolve(argv[++index]);
    else if (argument === "--variant") options.variants.push({ name: argv[++index], file: path.resolve(argv[++index]) });
    else if (argument === "--endpoint") options.endpoint = argv[++index];
    else if (argument === "--batch-size") options.batchSize = Number(argv[++index]);
    else if (argument === "--candidate-k") options.candidateK = Number(argv[++index]);
    else if (argument === "--sparse-weight") options.sparseWeight = Number(argv[++index]);
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

function stageOrder(stage) {
  if (stage === "T0") return 0;
  if (stage === "T1") return 1;
  throw new Error(`unknown stage: ${stage}`);
}

function stageSources(manifest, stage) {
  const maximum = stageOrder(stage);
  return new Set(manifest.documents
    .filter((document) => stageOrder(document.introduced_at) <= maximum)
    .map((document) => normalizeSource(document.source)));
}

function stageQuestions(questions, stage) {
  return questions
    .filter((question) => question.split === "development")
    .map((question) => ({ ...question, stage, gold: question.stages[stage] }));
}

function queryText(question) {
  return `${question.question}\n対象時点: ${question.gold.as_of}`;
}

function mean(values) {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function summarize(questions, retrieval, k) {
  const recalls = questions.map((question) => recallAtK(question, question.stage, retrieval.get(question.id), k));
  const complete = questions.map((question) => completeEvidenceAtK(
    question, question.stage, retrieval.get(question.id), k,
  ));
  return {
    questions: questions.length,
    recall_at_k: mean(recalls),
    evidence_ceiling_at_k: mean(complete.map(Number)),
    complete_evidence_questions: complete.filter(Boolean).length,
  };
}

function conditionMetrics(questions, retrieval) {
  return {
    at_5: summarize(questions, retrieval, 5),
    at_10: summarize(questions, retrieval, 10),
    by_category_at_5: Object.fromEntries([...new Set(questions.map((question) => question.category))].map((category) => {
      const selected = questions.filter((question) => question.category === category);
      return [category, summarize(selected, retrieval, 5)];
    })),
  };
}

function serializeRetrieval(questions, condition, retrieval) {
  return questions.map((question) => ({
    condition,
    question_id: question.id,
    stage: question.stage,
    split: question.split,
    results: (retrieval.get(question.id) ?? []).slice(0, 20).map((item, index) => ({
      rank: index + 1,
      source: normalizeSource(item.document.source),
      section: item.document.section,
      text: item.document.text,
      score: item.score,
      sparse_rank: item.sparse_rank ?? null,
      dense_rank: item.dense_rank ?? null,
    })),
  }));
}

async function evaluateVariant(variant, pack, options, queryVectorCache) {
  const chunks = readJsonl(variant.file);
  const profile = embeddingProfiles.ruri;
  const stored = await documentVectors(chunks, `ruri-dvx-token-${variant.name}`, profile, {
    endpoint: options.endpoint,
    batchSize: options.batchSize,
    cacheDirectory: path.join(options.output, "embedding-cache"),
    ollamaOptions: { num_ctx: 8192, num_batch: 32768 },
  });
  const denseIndex = new DenseIndex(chunks, stored.values, stored.manifest.dimensions);
  const stages = {};
  const serialized = [];
  for (const stage of ["T0", "T1"]) {
    const questions = stageQuestions(pack.questions, stage);
    const allowed = stageSources(pack.manifest, stage);
    const stageChunks = chunks.filter((chunk) => allowed.has(normalizeSource(chunk.source)));
    const sparseIndex = new Bm25Index(stageChunks, { ngramSizes: [1, 2], k1: 0.9, b: 0.25 });
    const sparse = new Map(questions.map((question) => [
      question.id, sparseIndex.search(queryText(question), options.candidateK),
    ]));
    const queryKey = stage;
    if (!queryVectorCache.has(queryKey)) {
      queryVectorCache.set(queryKey, await embedCollection(
        questions.map((question) => profile.query(queryText(question))),
        {
          endpoint: options.endpoint,
          batchSize: options.batchSize,
          model: profile.model,
          label: `ruri Dynamic Validity development ${stage}`,
          ollamaOptions: { num_ctx: 8192, num_batch: 32768 },
        },
      ));
    }
    const queryVectors = queryVectorCache.get(queryKey);
    const dense = new Map(questions.map((question, index) => [
      question.id,
      denseIndex.search(
        queryVectors[index], options.candidateK,
        (chunk) => allowed.has(normalizeSource(chunk.source)),
      ),
    ]));
    const hybrid = new Map(questions.map((question) => [
      question.id,
      weightedReciprocalRankFusion(
        sparse.get(question.id), dense.get(question.id), options.sparseWeight, options.candidateK,
      ),
    ]));
    const conditions = {
      bm25: sparse,
      "ruri-dense-exact": dense,
      [`hybrid-sparse-${options.sparseWeight.toFixed(2)}`]: hybrid,
    };
    stages[stage] = {
      documents: new Set(stageChunks.map((chunk) => chunk.source)).size,
      chunks: stageChunks.length,
      conditions: Object.fromEntries(Object.entries(conditions).map(([name, retrieval]) => [
        name, conditionMetrics(questions, retrieval),
      ])),
    };
    for (const [name, retrieval] of Object.entries(conditions)) {
      serialized.push(...serializeRetrieval(questions, name, retrieval));
    }
  }
  return { chunks, stages, serialized, embedding: stored.manifest };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help || options.variants.length === 0) {
    console.log("Usage: node run-dynamic-validity-token-chunk-pilot.mjs --variant 256 chunks.jsonl --variant 512 chunks.jsonl");
    return;
  }
  if (fs.existsSync(path.join(options.output, "report.json"))) {
    throw new Error(`output already contains a completed report: ${options.output}`);
  }
  fs.mkdirSync(options.output, { recursive: true });
  const pack = loadDynamicValidityPack(options.corpus);
  const queryVectorCache = new Map();
  const variants = {};
  for (const variant of options.variants) {
    const result = await evaluateVariant(variant, pack, options, queryVectorCache);
    variants[variant.name] = {
      input: variant.file,
      total_chunks: result.chunks.length,
      embedding: result.embedding,
      stages: result.stages,
    };
    fs.writeFileSync(
      path.join(options.output, `retrieval-${variant.name}.jsonl`),
      `${result.serialized.map((row) => JSON.stringify(row)).join("\n")}\n`,
      "utf8",
    );
  }
  const report = {
    schema_version: "1.0",
    experiment: "dynamic-validity-ruri-token-chunk-development-pilot",
    corpus: options.corpus,
    question_contract: "development 40 questions only; T0 and T1 evaluated separately",
    retrieval_contract: {
      dense: "Ruri exact exhaustive cosine; no ANN approximation",
      sparse: "BM25 Japanese 1-2 gram, k1=0.9, b=0.25, question plus as_of",
      hybrid_sparse_weight: options.sparseWeight,
      candidate_k: options.candidateK,
    },
    variants,
    holdout_status: "reserved and untouched",
  };
  fs.writeFileSync(path.join(options.output, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
