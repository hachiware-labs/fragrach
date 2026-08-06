#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Bm25Index } from "./run-upper-bound.mjs";
import { retrievalMetrics } from "./run-multihop-rag-retrieval.mjs";
import { buildMultiHopPacket, evidenceUnitMetrics, sourceMetadata } from "./multihop-query-packets.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../../..");
const root = path.join(repositoryRoot, "target/benchmarks/multihop-rag");
const corpus = path.join(root, "prepared-v2");
const output = path.join(root, "query-packets-holdout-v1");
const readJsonl = (file) => fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
if (fs.existsSync(output)) throw new Error(`output already exists: ${output}`);

const questions = readJsonl(path.join(corpus, "evaluation/questions.jsonl")).filter((question) => question.split === "holdout");
const chunks = readJsonl(path.join(root, "chunks-512.jsonl"));
const rawRows = readJsonl(path.join(root, "raw-retrieval-v2/retrieval.jsonl"))
  .filter((row) => row.condition === "hybrid-retuned-0.90-t1" && row.split === "holdout");
const rawById = new Map(rawRows.map((row) => [row.question_id, row.results]));
const obligations = new Map(readJsonl(path.join(root, "query-obligations-holdout-v1.jsonl")).map((row) => [row.question_id, row.obligations]));
const metadata = sourceMetadata(corpus, [...new Set(chunks.map((chunk) => chunk.source))]);
const bm25 = new Bm25Index(chunks);
const rows = questions.map((question) => {
  const packet = buildMultiHopPacket(question.question, {
    chunks,
    bm25,
    rawResults: rawById.get(question.id) ?? [],
    metadata,
    obligations: obligations.get(question.id) ?? [],
  });
  return {
    condition: "fragrach-multihop-evidence-packet-v1",
    question_id: question.id,
    category: question.category,
    split: question.split,
    results: packet ? [{
      rank: 1,
      source: packet.id,
      sources: packet.sources,
      source_texts: packet.source_texts,
      text: packet.text,
      packet_type: packet.packet_type,
      estimated_tokens: packet.estimated_tokens,
    }] : [],
  };
});
const rawRetrieval = new Map(rawRows.map((row) => [row.question_id, row.results]));
const rawMaterials = new Map(rawRows.map((row) => [row.question_id, row.results.slice(0, 5).map((item) => ({ source: item.source, text: item.text }))]));
const packetMaterials = new Map(rows.map((row) => [row.question_id, row.results]));
const score = (selected) => ({
  raw_document: retrievalMetrics(selected, rawRetrieval, 5),
  raw_evidence_unit: evidenceUnitMetrics(selected, rawMaterials),
  fragrach_evidence_unit: evidenceUnitMetrics(selected, packetMaterials),
});
const report = {
  schema_version: "1.0",
  experiment: "multihop-rag-untouched-holdout",
  frozen_contract: {
    chunk_tokens: 512,
    top_k: 5,
    raw_hybrid_sparse_weight: 0.9,
    source_limit: 4,
    chunk_limit: 5,
    llm: "gpt-5.6-luna",
    embedding: "hf.co/Targoyle/ruri-v3-310m-GGUF:Q8_0",
    note: "No setting was changed after diagnostic evaluation; Gold was first scored in this run.",
  },
  questions: questions.length,
  overall: score(questions),
  by_category: Object.fromEntries([...new Set(questions.map((question) => question.category))].map((category) => [category, score(questions.filter((question) => question.category === category))])),
};
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, "retrieval.jsonl"), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
fs.writeFileSync(path.join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
