#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadDynamicValidityPack, normalizeSource, recallAtK } from "./dynamic-validity-score.mjs";
import { buildDynamicValidityChunks } from "./dynamic-validity-corpus.mjs";
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
const defaultCorpusRoot = path.resolve(scriptDirectory, "../../corpora/aobane-industries-ja-dynamic-validity");
const defaultOutputDirectory = path.resolve(repositoryRoot, "target/benchmarks/dynamic-validity");

function percentage(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function mean(values) {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stageOrder(stage) {
  if (stage === "T0") return 0;
  if (stage === "T1") return 1;
  throw new Error(`unknown stage: ${stage}`);
}

export function stageDocumentSources(manifest, stage) {
  const maximum = stageOrder(stage);
  return new Set(manifest.documents
    .filter((document) => stageOrder(document.introduced_at) <= maximum)
    .map((document) => normalizeSource(document.source)));
}

function stageQuestions(questions, stage, split = null) {
  return questions
    .filter((question) => !split || question.split === split)
    .map((question) => ({ ...question, gold: question.stages[stage], stage }));
}

function queryText(question, configuration) {
  return configuration.queryMode === "question-as-of"
    ? `${question.question}\n対象時点: ${question.gold.as_of}`
    : question.question;
}

function chunkConfigurations() {
  return [
    { name: "paragraph", strategy: "paragraph" },
    { name: "section", strategy: "section" },
    { name: "fixed-256", strategy: "fixed", maxChars: 256, overlapParagraphs: 1 },
    { name: "fixed-512", strategy: "fixed", maxChars: 512, overlapParagraphs: 1 },
    { name: "fixed-1024", strategy: "fixed", maxChars: 1024, overlapParagraphs: 1 },
  ];
}

function sparseStructuralConfigurations() {
  const rows = [];
  for (const chunking of chunkConfigurations()) {
    for (const ngramSizes of [[2], [3], [2, 3], [1, 2]]) {
      for (const queryMode of ["question-only", "question-as-of"]) {
        rows.push({ kind: "sparse", chunking, ngramSizes, queryMode, k1: 1.5, b: 0.75 });
      }
    }
  }
  return rows;
}

function sparseConfigurations(structures = sparseStructuralConfigurations()) {
  const rows = [];
  for (const structure of structures) {
    for (const k1 of [0.9, 1.5, 1.8]) {
      for (const b of [0.25, 0.75, 1]) {
        rows.push({ ...structure, k1, b });
      }
    }
  }
  return rows;
}

function uniqueConfigurations(configurations) {
  const rows = new Map();
  for (const configuration of configurations) {
    rows.set(configurationId(configuration), configuration);
  }
  return [...rows.values()];
}

function rerankSparseStructures(rows, finalistCount) {
  return rows.slice().sort(compareTuningRows).slice(0, finalistCount).map((row) => row.configuration);
}

function configurationId(configuration) {
  const base = [
    configuration.kind,
    configuration.chunking.name,
    `ngram-${configuration.ngramSizes.join("-")}`,
    configuration.queryMode,
    `k1-${configuration.k1}`,
    `b-${configuration.b}`,
  ];
  if (configuration.embeddingProfile) base.push(configuration.embeddingProfile);
  if (configuration.sparseWeight !== undefined) base.push(`sw-${configuration.sparseWeight.toFixed(2)}`);
  return base.join("__");
}

function chunksFor(corpusRoot, manifest, stage, chunking, cache) {
  const key = JSON.stringify(chunking);
  if (!cache.has(key)) cache.set(key, buildDynamicValidityChunks(corpusRoot, manifest, chunking));
  const allowed = stageDocumentSources(manifest, stage);
  return cache.get(key).filter((chunk) => allowed.has(normalizeSource(chunk.source)));
}

function sparseRetrieval(chunks, questions, configuration, maximumK = 20, preparedIndex = null) {
  const index = preparedIndex
    ? preparedIndex.withParameters({ k1: configuration.k1, b: configuration.b })
    : new Bm25Index(chunks, {
      k1: configuration.k1,
      b: configuration.b,
      ngramSizes: configuration.ngramSizes,
    });
  return new Map(questions.map((question) => [
    question.id,
    index.search(queryText(question, configuration), maximumK),
  ]));
}

function retrievalScore(questions, retrieval, topK) {
  return mean(questions.map((question) =>
    recallAtK(question, question.stage, retrieval.get(question.id), topK),
  ));
}

export function compareTuningRows(left, right) {
  if (left.recall_at_5 !== right.recall_at_5) return right.recall_at_5 - left.recall_at_5;
  if (left.recall_at_10 !== right.recall_at_10) return right.recall_at_10 - left.recall_at_10;
  if (left.chunk_count !== right.chunk_count) return left.chunk_count - right.chunk_count;
  return left.id.localeCompare(right.id, "ja");
}

function evaluateRetrieval(configuration, chunks, questions, retrieval) {
  return {
    id: configurationId(configuration),
    configuration,
    chunk_count: chunks.length,
    recall_at_5: retrievalScore(questions, retrieval, 5),
    recall_at_10: retrievalScore(questions, retrieval, 10),
  };
}

function uniqueSparseFinalists(rows, limit = 8) {
  const seen = new Set();
  const result = [];
  for (const row of rows) {
    const key = JSON.stringify({
      chunking: row.configuration.chunking,
      ngramSizes: row.configuration.ngramSizes,
      queryMode: row.configuration.queryMode,
      k1: row.configuration.k1,
      b: row.configuration.b,
    });
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(row);
    if (result.length === limit) break;
  }
  return result;
}

async function denseQueryVectors(questions, profileName, options, cache) {
  const key = `${profileName}:${questions.map((question) => `${question.id}:${question.stage}`).join(",")}`;
  if (!cache.has(key)) {
    const profile = embeddingProfiles[profileName];
    cache.set(key, await embedCollection(
      questions.map((question) => profile.query(question.question)),
      { ...options, model: profile.model, label: `${profileName} ${questions[0]?.stage ?? "stage"} queries` },
    ));
  }
  return cache.get(key);
}

async function hybridRowsForSparse({ sparseRow, corpusRoot, manifest, stage, questions, chunkCache, queryVectorCache, options }) {
  const configuration = sparseRow.configuration;
  const chunks = chunksFor(corpusRoot, manifest, stage, configuration.chunking, chunkCache);
  const sparse = sparseRetrieval(chunks, questions, configuration, options.candidateK);
  const rows = [];
  for (const profileName of options.profiles) {
    const profile = embeddingProfiles[profileName];
    if (!profile) throw new Error(`unknown embedding profile: ${profileName}`);
    const stored = await documentVectors(chunks, profileName, profile, options);
    const denseIndex = new DenseIndex(chunks, stored.values, stored.manifest.dimensions);
    const vectors = await denseQueryVectors(questions, profileName, options, queryVectorCache);
    const dense = new Map(questions.map((question, index) => [
      question.id,
      denseIndex.search(vectors[index], options.candidateK),
    ]));
    for (const sparseWeight of options.sparseWeights) {
      const hybrid = new Map(questions.map((question) => [
        question.id,
        weightedReciprocalRankFusion(
          sparse.get(question.id), dense.get(question.id), sparseWeight, 20,
        ),
      ]));
      const hybridConfiguration = {
        ...configuration,
        kind: sparseWeight === 0 ? "dense" : "hybrid",
        embeddingProfile: profileName,
        sparseWeight,
      };
      rows.push(evaluateRetrieval(hybridConfiguration, chunks, questions, hybrid));
    }
  }
  return rows;
}

async function tuneStage(corpusRoot, pack, stage, options) {
  const development = stageQuestions(pack.questions, stage, "development");
  const chunkCache = new Map();
  let activeChunkingKey = null;
  let activeIndexKey = null;
  let activeIndex = null;
  const evaluateSparse = (configuration) => {
    const chunkingKey = JSON.stringify(configuration.chunking);
    if (chunkingKey !== activeChunkingKey) {
      chunkCache.clear();
      activeChunkingKey = chunkingKey;
      activeIndexKey = null;
      activeIndex = null;
    }
    const chunks = chunksFor(corpusRoot, pack.manifest, stage, configuration.chunking, chunkCache);
    const indexKey = JSON.stringify({ chunking: configuration.chunking, ngramSizes: configuration.ngramSizes });
    if (indexKey !== activeIndexKey) {
      activeIndexKey = indexKey;
      activeIndex = new Bm25Index(chunks, { ngramSizes: configuration.ngramSizes });
    }
    const retrieval = sparseRetrieval(chunks, development, configuration, 20, activeIndex);
    return evaluateRetrieval(configuration, chunks, development, retrieval);
  };
  const structures = sparseStructuralConfigurations();
  let sparseRows;
  let sparseSearchMode;
  if (pack.manifest.documents.length <= (options.exhaustiveDocumentThreshold ?? 200)) {
    sparseRows = sparseConfigurations(structures).map(evaluateSparse).sort(compareTuningRows);
    sparseSearchMode = "exhaustive";
  } else {
    const structuralRows = structures.map(evaluateSparse);
    const structureFinalistCount = options.sparseStructureFinalists ?? 12;
    const finalists = rerankSparseStructures(structuralRows, structureFinalistCount);
    const expanded = uniqueConfigurations(sparseConfigurations(finalists));
    const structuralIds = new Set(structuralRows.map((row) => row.id));
    sparseRows = [
      ...structuralRows,
      ...expanded.filter((configuration) => !structuralIds.has(configurationId(configuration))).map(evaluateSparse),
    ].sort(compareTuningRows);
    sparseSearchMode = `staged-all-structures-top-${structureFinalistCount}-parameter-grid`;
  }
  const finalists = uniqueSparseFinalists(sparseRows, options.hybridFinalists);
  const queryVectorCache = new Map();
  const hybridRows = [];
  for (const sparseRow of finalists) {
    hybridRows.push(...await hybridRowsForSparse({
      sparseRow, corpusRoot, manifest: pack.manifest, stage, questions: development,
      chunkCache, queryVectorCache, options,
    }));
  }
  const ranked = [...sparseRows, ...hybridRows].sort(compareTuningRows);
  return { winner: ranked[0], ranked, sparseWinner: sparseRows[0], hybridRows: hybridRows.length, sparseSearchMode };
}

async function retrieveConfiguration(corpusRoot, pack, stage, configuration, questions, options) {
  const chunks = chunksFor(corpusRoot, pack.manifest, stage, configuration.chunking, new Map());
  const sparse = sparseRetrieval(chunks, questions, configuration, options.candidateK);
  if (configuration.kind === "sparse") return { chunks, retrieval: sparse };
  const profile = embeddingProfiles[configuration.embeddingProfile];
  const stored = await documentVectors(chunks, configuration.embeddingProfile, profile, options);
  const vectors = await denseQueryVectors(questions, configuration.embeddingProfile, options, new Map());
  const denseIndex = new DenseIndex(chunks, stored.values, stored.manifest.dimensions);
  const dense = new Map(questions.map((question, index) => [
    question.id,
    denseIndex.search(vectors[index], options.candidateK),
  ]));
  if (configuration.kind === "dense") return { chunks, retrieval: dense };
  return {
    chunks,
    retrieval: new Map(questions.map((question) => [
      question.id,
      weightedReciprocalRankFusion(
        sparse.get(question.id), dense.get(question.id), configuration.sparseWeight, 20,
      ),
    ])),
  };
}

function serializeRetrieval(questions, retrieval) {
  return questions.map((question) => ({
    question_id: question.id,
    stage: question.stage,
    results: (retrieval.get(question.id) ?? []).map((item, index) => ({
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

function writeJsonl(filePath, rows) {
  fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

function conditionReport(questions, retrieval, topK = 5) {
  const development = questions.filter((question) => question.split === "development");
  const holdout = questions.filter((question) => question.split === "holdout");
  return {
    development_recall_at_k: retrievalScore(development, retrieval, topK),
    holdout_recall_at_k: retrievalScore(holdout, retrieval, topK),
    full_recall_at_k: retrievalScore(questions, retrieval, topK),
  };
}

function renderMarkdown(report) {
  const rows = Object.entries(report.conditions).map(([name, condition]) =>
    `| ${name} | ${percentage(condition.development_recall_at_k)} | ${percentage(condition.holdout_recall_at_k)} | ${percentage(condition.full_recall_at_k)} |`,
  ).join("\n");
  return `# Dynamic Validity Vanilla tuning\n\n実施日時: ${report.generated_at}\n\nT0の開発質問だけでVanilla Hybrid RAGを調整し、設定を固定したままT1へ新文書を追加した条件と、T1開発質問で再調整した条件を比較する。\n\n| 条件 | Development R@5 | Holdout R@5 | Full R@5 |\n|---|---:|---:|---:|\n${rows}\n\n- T0 winner: \`${report.tuning.t0.winner.id}\`\n- T1 retuned winner: \`${report.tuning.t1.winner.id}\`\n`;
}

function parseArguments(argv) {
  const options = {
    corpusRoot: defaultCorpusRoot,
    outputDirectory: defaultOutputDirectory,
    endpoint: "http://127.0.0.1:11434",
    batchSize: 16,
    candidateK: 50,
    profiles: ["ruri"],
    sparseWeights: [0, 0.25, 0.4, 0.5, 0.6, 0.75, 0.85, 0.95],
    hybridFinalists: 6,
    exhaustiveDocumentThreshold: 200,
    sparseStructureFinalists: 12,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--corpus") options.corpusRoot = path.resolve(argv[++index]);
    else if (argument === "--output") options.outputDirectory = path.resolve(argv[++index]);
    else if (argument === "--endpoint") options.endpoint = argv[++index];
    else if (argument === "--profiles") options.profiles = argv[++index].split(",").filter(Boolean);
    else if (argument === "--hybrid-finalists") options.hybridFinalists = Number.parseInt(argv[++index], 10);
    else if (argument === "--sparse-structure-finalists") options.sparseStructureFinalists = Number.parseInt(argv[++index], 10);
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

export async function runDynamicValidityTuning(options) {
  const pack = loadDynamicValidityPack(options.corpusRoot);
  fs.mkdirSync(options.outputDirectory, { recursive: true });
  options.cacheDirectory = path.join(options.outputDirectory, "embedding-cache");
  const t0Tuning = await tuneStage(options.corpusRoot, pack, "T0", options);
  const t1Tuning = await tuneStage(options.corpusRoot, pack, "T1", options);
  const allT0 = stageQuestions(pack.questions, "T0");
  const allT1 = stageQuestions(pack.questions, "T1");
  const t0Frozen = await retrieveConfiguration(options.corpusRoot, pack, "T0", t0Tuning.winner.configuration, allT0, options);
  const t1Frozen = await retrieveConfiguration(options.corpusRoot, pack, "T1", t0Tuning.winner.configuration, allT1, options);
  const t1Retuned = await retrieveConfiguration(options.corpusRoot, pack, "T1", t1Tuning.winner.configuration, allT1, options);
  const retrievalDirectory = path.join(options.outputDirectory, "retrieval");
  fs.mkdirSync(retrievalDirectory, { recursive: true });
  writeJsonl(path.join(retrievalDirectory, "vanilla-frozen-t0.jsonl"), serializeRetrieval(allT0, t0Frozen.retrieval));
  writeJsonl(path.join(retrievalDirectory, "vanilla-frozen-t1.jsonl"), serializeRetrieval(allT1, t1Frozen.retrieval));
  writeJsonl(path.join(retrievalDirectory, "vanilla-retuned-t1.jsonl"), serializeRetrieval(allT1, t1Retuned.retrieval));
  const report = {
    schema_version: "1.0",
    experiment: "dynamic-validity-vanilla-tuning",
    generated_at: new Date().toISOString(),
    corpus_root: options.corpusRoot,
    selection: "development Recall@5, Recall@10, chunk count",
    tuning: {
      t0: { winner: t0Tuning.winner, sparse_winner: t0Tuning.sparseWinner, searched: t0Tuning.ranked.length, sparse_search: t0Tuning.sparseSearchMode },
      t1: { winner: t1Tuning.winner, sparse_winner: t1Tuning.sparseWinner, searched: t1Tuning.ranked.length, sparse_search: t1Tuning.sparseSearchMode },
    },
    conditions: {
      "V-Frozen/T0": conditionReport(allT0, t0Frozen.retrieval),
      "V-Frozen/T1": conditionReport(allT1, t1Frozen.retrieval),
      "V-Retuned/T1": conditionReport(allT1, t1Retuned.retrieval),
    },
  };
  fs.writeFileSync(path.join(options.outputDirectory, "vanilla-tuning-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(options.outputDirectory, "VANILLA_TUNING_FINDINGS_ja.md"), renderMarkdown(report));
  return report;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node run-dynamic-validity-tuning.mjs [--profiles ruri,qwen3] [--output <dir>]");
    return;
  }
  const report = await runDynamicValidityTuning(options);
  console.log(`T0 winner: ${report.tuning.t0.winner.id}`);
  console.log(`T1 winner: ${report.tuning.t1.winner.id}`);
  for (const [name, condition] of Object.entries(report.conditions)) {
    console.log(`${name}: holdout R@5 ${percentage(condition.holdout_recall_at_k)}`);
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Error: ${error.stack ?? error.message}`);
    process.exitCode = 1;
  });
}
