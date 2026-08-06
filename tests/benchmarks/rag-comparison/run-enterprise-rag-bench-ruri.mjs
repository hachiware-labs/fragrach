#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DenseIndex,
  documentVectors,
  embedCollection,
  embeddingProfiles,
  weightedReciprocalRankFusion,
} from "./run-hybrid-tuning.mjs";
import { factCoverage } from "./prepare-multihop-rag.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../../..");
const root = path.join(repositoryRoot, "target/benchmarks/enterprise-rag-bench");
const output = path.join(root, "ruri-candidate-rerank-v2");
const readJsonl = (file) => fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
if (fs.existsSync(output)) throw new Error(`output already exists: ${output}`);

function metrics(questions, retrieval, k = 10) {
  const mapped = questions.filter((question) => ["verified", "disputed"].includes(question.gold_status) && question.gold_evidence.sources.length > 0);
  const verified = questions.filter((question) => question.gold_status === "verified" && question.gold_evidence.units.length > 0);
  const documentRows = mapped.map((question) => {
    const expected = new Set(question.gold_evidence.sources);
    const found = new Set((retrieval.get(question.id) ?? []).slice(0, k).map((item) => item.document.id));
    const hits = [...expected].filter((id) => found.has(id)).length;
    return { recall: hits / expected.size, complete: hits === expected.size };
  });
  const evidenceRows = verified.map((question) => {
    const materials = new Map((retrieval.get(question.id) ?? []).slice(0, k).map((item) => [item.document.id, item.document.full_text]));
    const hits = question.gold_evidence.units.filter((unit) => factCoverage(unit.fact, materials.get(unit.source) ?? "") >= 0.5).length;
    return { recall: hits / question.gold_evidence.units.length, complete: hits === question.gold_evidence.units.length };
  });
  return {
    document_questions: documentRows.length,
    document_recall_at_k: documentRows.reduce((sum, row) => sum + row.recall, 0) / (documentRows.length || 1),
    document_complete_at_k: documentRows.filter((row) => row.complete).length / (documentRows.length || 1),
    evidence_questions: evidenceRows.length,
    evidence_unit_recall_at_k: evidenceRows.reduce((sum, row) => sum + row.recall, 0) / (evidenceRows.length || 1),
    evidence_ceiling_at_k: evidenceRows.filter((row) => row.complete).length / (evidenceRows.length || 1),
  };
}

const questions = readJsonl(path.join(root, "prepared-v2/questions.jsonl"))
  .filter((question) => question.split === "development" || question.split === "diagnostic");
const questionById = new Map(questions.map((question) => [question.id, question]));
const bm25Rows = readJsonl(path.join(root, "bm25-v1/retrieval.jsonl")).filter((row) => questionById.has(row.question_id));
const documentById = new Map();
for (const row of bm25Rows) {
  for (const item of row.results) {
    documentById.set(item.doc_id, {
      id: item.doc_id,
      source: item.doc_id,
      title: item.title,
      content: item.content,
      full_text: `${item.title}\n\n${item.content}`,
      text: `${item.title}\n\n${item.content}`.slice(0, 700),
    });
  }
}
const documents = [...documentById.values()].sort((left, right) => left.id.localeCompare(right.id));
const profile = embeddingProfiles.ruri;
const stored = await documentVectors(documents, "enterprise-rag-bench-ruri-bm25-top50-devdiag-v1", profile, {
  cacheDirectory: path.join(repositoryRoot, "target/benchmarks/embedding-cache"),
  endpoint: "http://127.0.0.1:11434",
  batchSize: 16,
  truncate: true,
});
const queryVectors = await embedCollection(questions.map((question) => profile.query(question.question)), {
  endpoint: "http://127.0.0.1:11434",
  model: profile.model,
  batchSize: 16,
  label: "EnterpriseRAG-Bench questions",
});
const globalDense = new DenseIndex(documents, stored.values, stored.manifest.dimensions);
const bm25 = new Map(bm25Rows.map((row) => [row.question_id, row.results.map((item) => ({
  document: documentById.get(item.doc_id),
  score: item.score,
}))]));
const dense = new Map(questions.map((question, index) => {
  const candidates = new Set((bm25.get(question.id) ?? []).map((item) => item.document.id));
  return [question.id, globalDense.search(queryVectors[index], candidates.size, (document) => candidates.has(document.id))];
}));
const development = questions.filter((question) => question.split === "development");
const diagnostic = questions.filter((question) => question.split === "diagnostic");
const weights = [0, 0.25, 0.5, 0.75, 0.9, 1];
const candidates = weights.map((weight) => {
  const retrieval = new Map(questions.map((question) => [question.id, weightedReciprocalRankFusion(bm25.get(question.id) ?? [], dense.get(question.id) ?? [], weight, 50)]));
  return { weight, retrieval, score: metrics(development, retrieval, 10) };
}).sort((left, right) => right.score.evidence_ceiling_at_k - left.score.evidence_ceiling_at_k
  || right.score.document_recall_at_k - left.score.document_recall_at_k
  || right.weight - left.weight);
const selected = candidates[0];
const conditions = {
  "bm25-full-corpus": bm25,
  "ruri-within-bm25-top50": dense,
  [`hybrid-candidate-rerank-sparse-${selected.weight.toFixed(2)}`]: selected.retrieval,
};
const report = {
  schema_version: "1.0",
  experiment: "enterprise-rag-bench-ruri-candidate-rerank",
  limitation: "Ruri ranks only each question's BM25 top-50 candidates; this is not full-corpus dense retrieval.",
  embedding_text_contract: "The combined title + content is capped at 700 characters, with Ollama token truncation also enabled because this local Ruri GGUF rejects longer code-dense batches; retrieved answer material retains full content.",
  embedding: stored.manifest,
  tuning: { selected_sparse_weight: selected.weight, development: selected.score },
  conditions: Object.fromEntries(Object.entries(conditions).map(([name, retrieval]) => [name, {
    development: metrics(development, retrieval, 10),
    diagnostic: metrics(diagnostic, retrieval, 10),
  }])),
  holdout_status: "reserved; candidate documents were not embedded or scored",
};
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, "retrieval.jsonl"), `${Object.entries(conditions).flatMap(([condition, retrieval]) => questions.map((question) => ({
  condition,
  question_id: question.id,
  split: question.split,
  category: question.category,
  results: (retrieval.get(question.id) ?? []).slice(0, 10).map((item, index) => ({ rank: index + 1, score: item.score, doc_id: item.document.id, title: item.document.title, content: item.document.content })),
}))).map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
fs.writeFileSync(path.join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
