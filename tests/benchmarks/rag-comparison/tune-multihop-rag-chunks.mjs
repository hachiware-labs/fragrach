#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { evidenceUnitMetrics } from "./multihop-query-packets.mjs";
import { retrievalMetrics } from "./run-multihop-rag-retrieval.mjs";
import { Bm25Index } from "./run-upper-bound.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../../..");
const root = path.join(repositoryRoot, "target/benchmarks/multihop-rag");
const readJsonl = (file) => fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const questions = readJsonl(path.join(root, "prepared-v2/evaluation/questions.jsonl"))
  .filter((question) => question.split === "development" || question.split === "diagnostic");

function evaluate(chunkFile) {
  const chunks = readJsonl(path.join(root, chunkFile));
  const index = new Bm25Index(chunks);
  const byId = new Map(questions.map((question) => [question.id, index.search(question.question, 5)]));
  const materials = new Map([...byId].map(([id, rows]) => [id, rows.map((row) => ({ source: row.document.source, text: row.document.text }))]));
  const score = (split) => {
    const selected = questions.filter((question) => question.split === split);
    const document = retrievalMetrics(selected, byId, 5);
    const evidence = evidenceUnitMetrics(selected, materials);
    const selectedIds = new Set(selected.map((question) => question.id));
    const tokenCounts = [...byId].filter(([id]) => selectedIds.has(id)).flatMap(([, rows]) => rows.map((row) => row.document.token_count));
    return {
      ...document,
      evidence_unit_recall_at_k: evidence.evidence_unit_recall_at_k,
      evidence_unit_ceiling_at_k: evidence.evidence_ceiling_at_k,
      mean_context_tokens: tokenCounts.reduce((sum, value) => sum + value, 0) / (selected.length || 1),
    };
  };
  return { chunks: chunks.length, development: score("development"), diagnostic: score("diagnostic") };
}

const files = process.argv.slice(2);
if (files.length === 0) files.push("chunks-128.jsonl", "chunks-256.jsonl", "chunks-512.jsonl");
const results = Object.fromEntries(files.map((file) => [file, evaluate(file)]));
const selected = Object.entries(results).sort((left, right) =>
  right[1].development.evidence_unit_ceiling_at_k - left[1].development.evidence_unit_ceiling_at_k
  || right[1].development.document_recall_at_k - left[1].development.document_recall_at_k
  || left[1].development.mean_context_tokens - right[1].development.mean_context_tokens)[0][0];
console.log(JSON.stringify({ selection_contract: "Chunk size is selected only by development Evidence Unit Ceiling@5, then document Recall@5, then smaller context.", selected, results }, null, 2));
