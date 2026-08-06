#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { splitQuestions } from "./run-raw-tuning.mjs";
import {
  Bm25Index,
  buildRawChunks,
  enrichQuestionsWithConflictGold,
  rawProfileOptions,
  readCorpusGold,
  scoreRetrieval,
} from "./run-upper-bound.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultCorpusRoot = path.resolve(
  scriptDirectory,
  "../../corpora/aobane-industries-ja-medium",
);
const defaultOutputDirectory = path.resolve(
  scriptDirectory,
  "../../../target/benchmarks/raw-hybrid-tuning",
);

export const embeddingProfiles = {
  qwen3: {
    model: "hf.co/Qwen/Qwen3-Embedding-4B-GGUF:Q4_K_M",
    passage: (text) => text,
    query: (text) =>
      "Instruct: Retrieve relevant Japanese internal company documents " +
      `that answer the query.\nQuery: ${text}`,
  },
  ruri: {
    model: "hf.co/Targoyle/ruri-v3-310m-GGUF:Q8_0",
    passage: (text) => `文章: ${text}`,
    query: (text) => `クエリ: ${text}`,
  },
};

function readJsonl(filePath) {
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function percentage(value) {
  return value === null || value === undefined
    ? "n/a"
    : `${(value * 100).toFixed(1)}%`;
}

function cacheKey(profileName, model, documents) {
  const hash = crypto.createHash("sha256");
  hash.update("hybrid-embedding-cache-v1\0");
  hash.update(profileName);
  hash.update("\0");
  hash.update(model);
  for (const document of documents) {
    hash.update("\0");
    hash.update(document.id);
    hash.update("\0");
    hash.update(document.text);
  }
  return `${profileName}-${hash.digest("hex").slice(0, 20)}`;
}

function vectorPaths(cacheDirectory, key) {
  return {
    manifest: path.join(cacheDirectory, `${key}.json`),
    vectors: path.join(cacheDirectory, `${key}.f32`),
  };
}

function readVectorCache(cacheDirectory, key, expectedRows) {
  const locations = vectorPaths(cacheDirectory, key);
  if (!fs.existsSync(locations.manifest) || !fs.existsSync(locations.vectors)) {
    return null;
  }
  const manifest = JSON.parse(fs.readFileSync(locations.manifest, "utf8"));
  if (manifest.rows !== expectedRows || !Number.isInteger(manifest.dimensions)) {
    return null;
  }
  const bytes = fs.readFileSync(locations.vectors);
  if (bytes.byteLength !== manifest.rows * manifest.dimensions * 4) return null;
  const copied = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
  return { manifest, values: new Float32Array(copied) };
}

function writeVectorCache(cacheDirectory, key, manifest, values) {
  fs.mkdirSync(cacheDirectory, { recursive: true });
  const locations = vectorPaths(cacheDirectory, key);
  fs.writeFileSync(
    locations.vectors,
    Buffer.from(values.buffer, values.byteOffset, values.byteLength),
  );
  fs.writeFileSync(
    locations.manifest,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}

async function requestEmbeddings(endpoint, model, input, truncate = false, ollamaOptions = null) {
  const body = { model, input, truncate };
  if (ollamaOptions) body.options = ollamaOptions;
  const response = await fetch(`${endpoint.replace(/\/$/, "")}/api/embed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`embedding request failed: ${response.status} ${await response.text()}`);
  }
  const payload = await response.json();
  if (!Array.isArray(payload.embeddings) || payload.embeddings.length !== input.length) {
    throw new Error("embedding response count does not match input count");
  }
  return payload.embeddings;
}

export async function embedCollection(texts, options) {
  const vectors = [];
  for (let offset = 0; offset < texts.length; offset += options.batchSize) {
    const batch = texts.slice(offset, offset + options.batchSize);
    const embedded = await requestEmbeddings(
      options.endpoint,
      options.model,
      batch,
      options.truncate ?? false,
      options.ollamaOptions ?? null,
    );
    vectors.push(...embedded);
    const completed = Math.min(offset + batch.length, texts.length);
    if (completed === texts.length || completed % (options.batchSize * 10) === 0) {
      console.log(`${options.label}: embedded ${completed}/${texts.length}`);
    }
  }
  return vectors;
}

function flattenVectors(vectors) {
  const dimensions = vectors[0]?.length ?? 0;
  if (dimensions === 0 || vectors.some((vector) => vector.length !== dimensions)) {
    throw new Error("embedding vectors have inconsistent dimensions");
  }
  const values = new Float32Array(vectors.length * dimensions);
  vectors.forEach((vector, row) => values.set(vector, row * dimensions));
  return { dimensions, values };
}

export async function documentVectors(documents, profileName, profile, options) {
  const key = cacheKey(profileName, profile.model, documents);
  const cached = readVectorCache(options.cacheDirectory, key, documents.length);
  if (cached) {
    console.log(`${profileName}: document embedding cache hit (${cached.manifest.rows}x${cached.manifest.dimensions})`);
    return cached;
  }
  const started = Date.now();
  const vectors = await embedCollection(
    documents.map((document) => profile.passage(document.text)),
    {
      ...options,
      model: profile.model,
      label: `${profileName} documents`,
    },
  );
  const flattened = flattenVectors(vectors);
  const manifest = {
    schema_version: "1.0",
    profile: profileName,
    model: profile.model,
    rows: documents.length,
    dimensions: flattened.dimensions,
    elapsed_ms: Date.now() - started,
    generated_at: new Date().toISOString(),
  };
  writeVectorCache(options.cacheDirectory, key, manifest, flattened.values);
  return { manifest, values: flattened.values };
}

export class DenseIndex {
  constructor(documents, values, dimensions) {
    if (values.length !== documents.length * dimensions) {
      throw new Error("dense index vector count does not match documents");
    }
    this.documents = documents;
    this.values = values;
    this.dimensions = dimensions;
    this.norms = new Float32Array(documents.length);
    for (let row = 0; row < documents.length; row += 1) {
      let squared = 0;
      const start = row * dimensions;
      for (let column = 0; column < dimensions; column += 1) {
        const value = values[start + column];
        squared += value * value;
      }
      this.norms[row] = Math.sqrt(squared) || 1;
    }
  }

  search(queryVector, limit = 20, predicate = null) {
    let querySquared = 0;
    for (const value of queryVector) querySquared += value * value;
    const queryNorm = Math.sqrt(querySquared) || 1;
    const scored = this.documents.map((document, row) => {
      if (predicate && !predicate(document)) return null;
      let dot = 0;
      const start = row * this.dimensions;
      for (let column = 0; column < this.dimensions; column += 1) {
        dot += this.values[start + column] * queryVector[column];
      }
      return { document, score: dot / (this.norms[row] * queryNorm) };
    }).filter(Boolean);
    return scored
      .sort((left, right) =>
        right.score - left.score ||
        left.document.id.localeCompare(right.document.id, "ja")
      )
      .slice(0, limit);
  }
}

export function weightedReciprocalRankFusion(
  sparse,
  dense,
  sparseWeight,
  limit,
  rankConstant = 60,
) {
  const combined = new Map();
  const add = (items, weight, source) => items.forEach((item, index) => {
    const id = item.document.id;
    const current = combined.get(id) ?? {
      document: item.document,
      score: 0,
      sparse_rank: null,
      dense_rank: null,
    };
    current.score += weight / (rankConstant + index + 1);
    current[`${source}_rank`] = index + 1;
    combined.set(id, current);
  });
  add(sparse, sparseWeight, "sparse");
  add(dense, 1 - sparseWeight, "dense");
  return [...combined.values()]
    .sort((left, right) =>
      right.score - left.score ||
      left.document.id.localeCompare(right.document.id, "ja")
    )
    .slice(0, limit);
}

function compactScore(score) {
  return {
    questions: score.questions,
    recall_at_k: score.recall_at_k,
    complete_at_k: score.complete_at_k,
    precision_at_k: score.precision_at_k,
    distractor_rate_at_k: score.distractor_rate_at_k,
    conflict_recall_at_k: score.conflict_recall_at_k,
    conflict_complete_rate_at_k: score.conflict_complete_rate_at_k,
    resolution_accuracy_at_k: score.resolution_accuracy_at_k,
    resolution_coverage_at_k: score.resolution_coverage_at_k,
    by_cohort: score.by_cohort,
    by_intent: score.by_intent,
  };
}

function evaluate(questions, retrieval) {
  return compactScore(scoreRetrieval(questions, retrieval, [5, 10, 20], {
    supportsConflictUnits: false,
  }));
}

function selectRetrieval(retrieval, questions) {
  return new Map(questions.map((question) => [
    question.id,
    retrieval.get(question.id) ?? [],
  ]));
}

function evaluateSplit(retrieval, questions, split) {
  return {
    development: evaluate(
      split.development,
      selectRetrieval(retrieval, split.development),
    ),
    holdout: evaluate(split.holdout, selectRetrieval(retrieval, split.holdout)),
    full: evaluate(questions, retrieval),
  };
}

function compareRows(left, right) {
  const values = [
    [right.development.recall_at_k["5"], left.development.recall_at_k["5"]],
    [right.development.recall_at_k["10"], left.development.recall_at_k["10"]],
    [
      right.development.conflict_complete_rate_at_k["10"] ?? -1,
      left.development.conflict_complete_rate_at_k["10"] ?? -1,
    ],
    [
      left.development.distractor_rate_at_k["5"] ?? 1,
      right.development.distractor_rate_at_k["5"] ?? 1,
    ],
  ];
  for (const [leftValue, rightValue] of values) {
    if (leftValue !== rightValue) return leftValue - rightValue;
  }
  return left.id.localeCompare(right.id, "ja");
}

async function retrievalForProfile(
  profileName,
  profile,
  documents,
  questions,
  sparseRetrieval,
  options,
) {
  const stored = await documentVectors(documents, profileName, profile, options);
  const queryVectors = await embedCollection(
    questions.map((question) => profile.query(question.question)),
    {
      ...options,
      model: profile.model,
      label: `${profileName} questions`,
    },
  );
  const denseIndex = new DenseIndex(
    documents,
    stored.values,
    stored.manifest.dimensions,
  );
  const dense = new Map();
  const denseCandidates = new Map();
  questions.forEach((question, index) => {
    const candidates = denseIndex.search(queryVectors[index], options.candidateK);
    denseCandidates.set(question.id, candidates);
    dense.set(question.id, candidates.slice(0, 20));
  });
  const rows = [{
    id: `${profileName}-dense`,
    kind: "dense",
    model: profile.model,
    ...evaluateSplit(dense, questions, options.split),
  }];
  for (const sparseWeight of options.sparseWeights) {
    const hybrid = new Map(questions.map((question) => [
      question.id,
      weightedReciprocalRankFusion(
        sparseRetrieval.get(question.id),
        denseCandidates.get(question.id),
        sparseWeight,
        20,
      ),
    ]));
    rows.push({
      id: `${profileName}-hybrid-sparse-${sparseWeight.toFixed(2)}`,
      kind: "hybrid-rrf",
      model: profile.model,
      sparse_weight: sparseWeight,
      ...evaluateSplit(hybrid, questions, options.split),
    });
  }
  return { rows, embedding: stored.manifest };
}

function renderTable(rows, field = "full") {
  return [
    "| 条件 | R@5 | R@10 | R@20 | Conflict complete@10 | 解決精度@10 | D@5 |",
    "|---|---:|---:|---:|---:|---:|---:|",
    ...rows.map((row) => {
      const score = row[field];
      return `| \`${row.id}\` | ${percentage(score.recall_at_k["5"])} | ${percentage(score.recall_at_k["10"])} | ${percentage(score.recall_at_k["20"])} | ${percentage(score.conflict_complete_rate_at_k["10"])} | ${percentage(score.resolution_accuracy_at_k["10"])} | ${percentage(score.distractor_rate_at_k["5"])} |`;
    }),
  ].join("\n");
}

function renderMarkdown(report) {
  return `# Raw Dense・Hybrid検索評価

実施日時: ${report.generated_at}

Tuned Raw Sparseと同じ2,461 chunks、100問を使い、回答LLMを使わずDense単独と重み付きRRF Hybridを比較した。条件選択は開発73問だけで行い、保留27問は選択に使用していない。

## 全100問

${renderTable(report.rows, "full")}

## 選択結果

開発群で選ばれた条件は\`${report.winner.id}\`である。

| 質問群 | R@5 | R@10 | R@20 | Conflict complete@10 | 解決精度@10 | D@5 |
|---|---:|---:|---:|---:|---:|---:|
| 開発 | ${percentage(report.winner.development.recall_at_k["5"])} | ${percentage(report.winner.development.recall_at_k["10"])} | ${percentage(report.winner.development.recall_at_k["20"])} | ${percentage(report.winner.development.conflict_complete_rate_at_k["10"])} | ${percentage(report.winner.development.resolution_accuracy_at_k["10"])} | ${percentage(report.winner.development.distractor_rate_at_k["5"])} |
| 保留 | ${percentage(report.winner.holdout.recall_at_k["5"])} | ${percentage(report.winner.holdout.recall_at_k["10"])} | ${percentage(report.winner.holdout.recall_at_k["20"])} | ${percentage(report.winner.holdout.conflict_complete_rate_at_k["10"])} | ${percentage(report.winner.holdout.resolution_accuracy_at_k["10"])} | ${percentage(report.winner.holdout.distractor_rate_at_k["5"])} |
| 全体 | ${percentage(report.winner.full.recall_at_k["5"])} | ${percentage(report.winner.full.recall_at_k["10"])} | ${percentage(report.winner.full.recall_at_k["20"])} | ${percentage(report.winner.full.conflict_complete_rate_at_k["10"])} | ${percentage(report.winner.full.resolution_accuracy_at_k["10"])} | ${percentage(report.winner.full.distractor_rate_at_k["5"])} |
`;
}

function parseArguments(argv) {
  const options = {
    corpusRoot: defaultCorpusRoot,
    outputDirectory: defaultOutputDirectory,
    endpoint: "http://127.0.0.1:11434",
    batchSize: 16,
    candidateK: 100,
    profiles: ["qwen3", "ruri"],
    sparseWeights: [0.25, 0.4, 0.5, 0.6, 0.75, 0.8, 0.85, 0.9, 0.95],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--corpus") options.corpusRoot = path.resolve(argv[++index]);
    else if (argument === "--output") options.outputDirectory = path.resolve(argv[++index]);
    else if (argument === "--endpoint") options.endpoint = argv[++index];
    else if (argument === "--batch-size") options.batchSize = Number.parseInt(argv[++index], 10);
    else if (argument === "--candidate-k") options.candidateK = Number.parseInt(argv[++index], 10);
    else if (argument === "--profiles") options.profiles = argv[++index].split(",");
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node run-hybrid-tuning.mjs [--profiles qwen3,ruri] [--batch-size 16]");
    return;
  }
  fs.mkdirSync(options.outputDirectory, { recursive: true });
  options.cacheDirectory = path.join(options.outputDirectory, "embedding-cache");
  const rawProfile = rawProfileOptions("tuned-sparse-v1");
  const documents = buildRawChunks(options.corpusRoot, rawProfile.chunking);
  const rawQuestions = readJsonl(
    path.join(options.corpusRoot, "evaluation/questions.jsonl"),
  );
  const gold = readCorpusGold(options.corpusRoot);
  const questions = enrichQuestionsWithConflictGold(
    rawQuestions,
    gold.answers,
    gold.conflicts,
  );
  const split = splitQuestions(questions);
  const sparseIndex = new Bm25Index(documents, rawProfile.index);
  const sparseRetrieval = new Map(questions.map((question) => [
    question.id,
    sparseIndex.search(question.question, options.candidateK),
  ]));
  const sparse = {
    id: "tuned-raw-sparse",
    kind: "sparse",
    ...evaluateSplit(
      new Map(questions.map((question) => [
        question.id,
        sparseRetrieval.get(question.id).slice(0, 20),
      ])),
      questions,
      split,
    ),
  };

  const rows = [sparse];
  const embeddings = {};
  for (const profileName of options.profiles) {
    const profile = embeddingProfiles[profileName];
    if (!profile) throw new Error(`unknown embedding profile: ${profileName}`);
    const result = await retrievalForProfile(
      profileName,
      profile,
      documents,
      questions,
      sparseRetrieval,
      { ...options, split },
    );
    rows.push(...result.rows);
    embeddings[profileName] = result.embedding;
  }
  const ranked = [...rows].sort(compareRows);
  const rankedHybrid = rows
    .filter((row) => row.kind !== "sparse")
    .sort(compareRows);
  const report = {
    schema_version: "1.0",
    experiment: "raw-dense-hybrid-tuning",
    generated_at: new Date().toISOString(),
    corpus_root: options.corpusRoot,
    chunks: documents.length,
    questions: questions.length,
    split: {
      development_questions: split.development.length,
      holdout_questions: split.holdout.length,
    },
    candidate_k: options.candidateK,
    fusion: "weighted reciprocal rank fusion, k=60",
    embeddings,
    sparse_baseline: sparse,
    winner: ranked[0],
    best_hybrid: rankedHybrid[0],
    rows,
  };
  fs.writeFileSync(
    path.join(options.outputDirectory, "hybrid-tuning-report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(options.outputDirectory, "HYBRID_TUNING_FINDINGS_ja.md"),
    renderMarkdown(report),
    "utf8",
  );
  console.log(`Winner: ${report.winner.id}`);
  console.log(`Full R@5 ${percentage(report.winner.full.recall_at_k["5"])} R@10 ${percentage(report.winner.full.recall_at_k["10"])} R@20 ${percentage(report.winner.full.recall_at_k["20"])}`);
  console.log(`Report: ${path.join(options.outputDirectory, "hybrid-tuning-report.json")}`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) await main();
