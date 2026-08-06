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
import { composeDecisionPacketResults } from "./run-dynamic-validity-fcompile-retrieval.mjs";
import {
  diversifyBySource,
  loadProfiles,
  retrievalDocuments,
  sourceIdentity,
} from "./run-dynamic-validity-metadata-slide-pilot.mjs";
import {
  DenseIndex,
  documentVectors,
  embedCollection,
  embeddingProfiles,
  weightedReciprocalRankFusion,
} from "./run-hybrid-tuning.mjs";
import { Bm25Index, buildActualChunks } from "./run-upper-bound.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../../..");

function readJsonl(file) {
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

function parseArguments(argv) {
  const options = {
    corpus: path.resolve(scriptDirectory, "../../corpora/aobane-industries-ja-dynamic-validity-practical-variation"),
    chunks: path.resolve(repositoryRoot, "target/benchmarks/dynamic-validity-practical-variation-v2/ruri-512.jsonl"),
    output: path.resolve(repositoryRoot, "target/benchmarks/dynamic-validity-practical-variation-v2"),
    cache: path.resolve(repositoryRoot, "target/benchmarks/dynamic-validity-practical-variation-v2/embedding-cache"),
    builds: [],
    endpoint: "http://127.0.0.1:11434",
    batchSize: 16,
    split: "practical_holdout",
    candidateK: 1000,
    topK: 10,
    anchorK: 5,
    packetBudget: 3,
    sparseWeight: 0.4,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--corpus") options.corpus = path.resolve(argv[++index]);
    else if (argument === "--chunks") options.chunks = path.resolve(argv[++index]);
    else if (argument === "--output") options.output = path.resolve(argv[++index]);
    else if (argument === "--cache") options.cache = path.resolve(argv[++index]);
    else if (argument === "--build") options.builds.push(path.resolve(argv[++index]));
    else if (argument === "--endpoint") options.endpoint = argv[++index];
    else if (argument === "--batch-size") options.batchSize = Number(argv[++index]);
    else if (argument === "--split") options.split = argv[++index];
    else if (argument === "--candidate-k") options.candidateK = Number(argv[++index]);
    else if (argument === "--top-k") options.topK = Number(argv[++index]);
    else if (argument === "--anchor-k") options.anchorK = Number(argv[++index]);
    else if (argument === "--packet-budget") options.packetBudget = Number(argv[++index]);
    else if (argument === "--sparse-weight") options.sparseWeight = Number(argv[++index]);
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (options.builds.length === 0) {
    const root = path.resolve(repositoryRoot, "target/benchmarks/dynamic-validity-practical-metadata-build-v1");
    options.builds = Array.from({ length: 12 }, (_, index) => path.join(root, `knowledge-build-${index + 1}`));
  }
  return options;
}

export function practicalQuery(question) {
  return `${question.question}\n対象時点: ${question.stages.T1.as_of}`;
}

function rank(items) {
  return items.map((item, index) => ({ ...item, rank: index + 1 }));
}

function rawResult(item, resultRank) {
  const evidence = item.document.evidence?.[0] ?? {};
  const source = normalizeSource(evidence.source ?? item.document.source);
  return {
    rank: resultRank,
    source,
    sources: [source],
    citation_sources: [source],
    evidence_roles: [{ source, use: "governing", basis: "retrieved" }],
    section: evidence.section ?? item.document.section ?? "本文",
    text: item.document.text,
    score: item.score,
    dense_rank: item.dense_rank ?? null,
    sparse_rank: item.sparse_rank ?? null,
    compiled_unit_id: item.document.id,
    compiled_unit_type: "raw_document_chunk",
  };
}

function rawResults(ranked, topK) {
  return ranked.slice(0, topK).map((item, index) => rawResult(item, index + 1));
}

function summarize(questions, retrieval, k) {
  const recall = questions.map((question) => recallAtK(question, "T1", retrieval.get(question.id) ?? [], k));
  const complete = questions.map((question) => completeEvidenceAtK(
    question, "T1", retrieval.get(question.id) ?? [], k,
  ));
  return {
    questions: questions.length,
    recall_at_k: recall.reduce((sum, value) => sum + value, 0) / Math.max(questions.length, 1),
    evidence_ceiling_at_k: complete.filter(Boolean).length / Math.max(questions.length, 1),
    complete_evidence_questions: complete.filter(Boolean).length,
  };
}

function metricsFor(questions, retrieval) {
  const metrics = { at_5: summarize(questions, retrieval, 5) };
  metrics.at_10 = summarize(questions, retrieval, 10);
  return metrics;
}

function metricsByVariation(questions, retrieval) {
  const dimensions = [...new Set(questions.flatMap((question) => question.surface_variations ?? []))].sort();
  return Object.fromEntries(dimensions.map((dimension) => {
    const selected = questions.filter((question) => question.surface_variations?.includes(dimension));
    return [dimension, metricsFor(selected, retrieval)];
  }));
}

function serializeRows(questions, condition, retrieval) {
  return questions.map((question) => ({
    condition,
    question_id: question.id,
    stage: "T1",
    split: question.split,
    canonical_question: question.canonical_question,
    surface_variations: question.surface_variations,
    results: retrieval.get(question.id) ?? [],
  }));
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node run-dynamic-validity-practical-variation.mjs [--build DIR] [--chunks FILE] [--output DIR]");
    return;
  }
  if (!fs.existsSync(options.chunks)) throw new Error(`chunks do not exist: ${options.chunks}`);
  const retrievalDirectory = path.join(options.output, "retrieval");
  if (fs.existsSync(path.join(options.output, "retrieval-report.json"))) {
    throw new Error(`retrieval report already exists: ${options.output}`);
  }
  fs.mkdirSync(retrievalDirectory, { recursive: true });

  const pack = loadDynamicValidityPack(options.corpus);
  const questions = pack.questions.filter((question) => question.split === options.split);
  if (questions.length === 0) throw new Error(`no questions found for split: ${options.split}`);
  const chunks = readJsonl(options.chunks);
  const units = buildActualChunks(options.builds, {
    authorityBoost: true,
    evidenceFallback: true,
    includeDiagnosticAliases: true,
    includeRelationDossiers: true,
  });
  const packetDocuments = units.filter((unit) => unit.unit_type === "relation_dossier");
  const identity = sourceIdentity(units, loadProfiles(options.builds));
  const documents = retrievalDocuments(chunks, identity, new Map(), false);

  const profile = embeddingProfiles.ruri;
  const stored = await documentVectors(documents, "dynamic-validity-practical-ruri-512", profile, {
    endpoint: options.endpoint,
    batchSize: options.batchSize,
    cacheDirectory: options.cache,
    ollamaOptions: { num_ctx: 8192, num_batch: 32768 },
  });
  const queryVectors = await embedCollection(questions.map((question) => profile.query(practicalQuery(question))), {
    endpoint: options.endpoint,
    batchSize: options.batchSize,
    model: profile.model,
    label: "Ruri practical-variation questions",
    ollamaOptions: { num_ctx: 8192, num_batch: 32768 },
  });
  const denseIndex = new DenseIndex(documents, stored.values, stored.manifest.dimensions);
  const sparseIndex = new Bm25Index(documents, { ngramSizes: [1, 2], k1: 0.9, b: 0.25 });

  const retrievals = Object.fromEntries([
    "raw-bm25-t1",
    "raw-ruri-dense-t1",
    "raw-fixed-hybrid-t1",
    "fragrach-ruri-packet-t1",
    "fragrach-fixed-hybrid-packet-t1",
  ].map((name) => [name, new Map()]));

  questions.forEach((question, questionIndex) => {
    const query = practicalQuery(question);
    const dense = denseIndex.search(queryVectors[questionIndex], options.candidateK)
      .map((item, index) => ({ ...item, rank: index + 1, dense_rank: index + 1 }));
    const sparse = sparseIndex.search(query, options.candidateK)
      .map((item, index) => ({ ...item, rank: index + 1, sparse_rank: index + 1 }));
    const hybrid = rank(weightedReciprocalRankFusion(
      sparse, dense, options.sparseWeight, options.candidateK,
    ));
    const denseDiverse = rank(diversifyBySource(dense));
    const sparseDiverse = rank(diversifyBySource(sparse));
    const hybridDiverse = rank(diversifyBySource(hybrid));

    retrievals["raw-bm25-t1"].set(question.id, rawResults(sparseDiverse, options.topK));
    retrievals["raw-ruri-dense-t1"].set(question.id, rawResults(denseDiverse, options.topK));
    retrievals["raw-fixed-hybrid-t1"].set(question.id, rawResults(hybridDiverse, options.topK));
    retrievals["fragrach-ruri-packet-t1"].set(question.id, composeDecisionPacketResults(
      denseDiverse, packetDocuments, options.topK,
      { anchorK: options.anchorK, packetBudget: options.packetBudget },
    ));
    retrievals["fragrach-fixed-hybrid-packet-t1"].set(question.id, composeDecisionPacketResults(
      hybridDiverse, packetDocuments, options.topK,
      { anchorK: options.anchorK, packetBudget: options.packetBudget },
    ));
  });

  const conditions = {};
  for (const [name, retrieval] of Object.entries(retrievals)) {
    const rows = serializeRows(questions, name, retrieval);
    writeJsonl(path.join(retrievalDirectory, `${name}.jsonl`), rows);
    conditions[name] = {
      overall: metricsFor(questions, retrieval),
      by_surface_variation: metricsByVariation(questions, retrieval),
    };
  }
  const report = {
    schema_version: "1.0",
    experiment: "dynamic-validity-practical-unseen-surface-variation",
    generated_at: new Date().toISOString(),
    evaluation_contract: {
      split: options.split,
      questions: questions.length,
      families: new Set(questions.map((question) => question.family_id)).size,
      tuning_on_evaluation_split: false,
      source_diversity: "one chunk per source before top-k",
      chunking: "Ruri tokenizer 512 tokens / 64 overlap",
      dense: `${profile.model}; exhaustive cosine search`,
      bm25: "Japanese 1-2 character grams; k1=0.9; b=0.25",
      hybrid: `weighted RRF; sparse_weight=${options.sparseWeight}; rank_constant=60`,
      candidate_k: options.candidateK,
      top_k: options.topK,
      packet: `anchor_k=${options.anchorK}; packet_budget=${options.packetBudget}`,
    },
    corpus: { documents: new Set(chunks.map((chunk) => normalizeSource(chunk.source))).size, chunks: chunks.length },
    compiled: { units: units.length, packet_documents: packetDocuments.length },
    embedding: stored.manifest,
    conditions,
    limitation: "This is a fixed reproducible Hybrid baseline without a cross-encoder reranker or query expansion; it is not a claim against every tuned production RAG.",
  };
  fs.writeFileSync(path.join(options.output, "retrieval-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
