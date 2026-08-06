#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Bm25Index } from "./run-upper-bound.mjs";
import {
  buildMultiHopPacket,
  evidenceUnitMetrics,
  sourceMetadata,
} from "./multihop-query-packets.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../../..");
const corpus = path.join(repositoryRoot, "target/benchmarks/multihop-rag/prepared-v2");
const chunksFile = path.join(repositoryRoot, "target/benchmarks/multihop-rag/chunks-512.jsonl");
const rawFile = path.join(repositoryRoot, "target/benchmarks/multihop-rag/raw-retrieval-v2/retrieval.jsonl");
const obligationsFile = path.join(repositoryRoot, "target/benchmarks/multihop-rag/query-obligations-v1.jsonl");
const output = path.join(repositoryRoot, "target/benchmarks/multihop-rag/query-packets-frozen-v1");
if (fs.existsSync(output)) throw new Error(`output already exists: ${output}`);
const readJsonl = (file) => fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const questions = readJsonl(path.join(corpus, "evaluation/questions.jsonl")).filter((question) => question.split === "development" || question.split === "diagnostic");
const chunks = readJsonl(chunksFile);
const rawRows = readJsonl(rawFile).filter((row) => row.condition === "hybrid-retuned-0.90-t1");
const rawById = new Map(rawRows.map((row) => [row.question_id, row.results]));
const obligationsById = new Map(readJsonl(obligationsFile).map((row) => [row.question_id, row.obligations]));
const metadata = sourceMetadata(corpus, [...new Set(chunks.map((chunk) => chunk.source))]);
const bm25 = new Bm25Index(chunks);
const rows = questions.map((question) => {
  const obligations = obligationsById.get(question.id) ?? [];
  const packet = buildMultiHopPacket(question.question, {
    chunks,
    bm25,
    rawResults: rawById.get(question.id) ?? [],
    metadata,
    obligations,
  });
  return {
    condition: "fragrach-multihop-evidence-packet-v1",
    question_id: question.id,
    category: question.category,
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
const materials = new Map(rows.map((row) => [row.question_id, row.results]));
const rawMaterials = new Map(rawRows.map((row) => [row.question_id, row.results.slice(0, 5).map((item) => ({ source: item.source, text: item.text }))]));
const byCategory = (materialMap) => Object.fromEntries([...new Set(questions.map((question) => question.category))].map((category) => [
  category,
  evidenceUnitMetrics(questions.filter((question) => question.category === category), materialMap),
]));
const report = {
  schema_version: "1.0",
  experiment: "multihop-rag-query-relative-packets",
  leakage_contract: "Question text, Source Corpus metadata/text, frozen Raw Hybrid candidates, and Luna-generated retrieval obligations only; Gold answers, Gold sources, and Gold facts are not used to create or rank packets. Generated retrieval hypotheses are omitted from answer materials.",
  questions: questions.length,
  conditions: {
    "raw-hybrid-retuned-0.90-t1": { overall: evidenceUnitMetrics(questions, rawMaterials), by_category: byCategory(rawMaterials) },
    "fragrach-multihop-evidence-packet-v1": { overall: evidenceUnitMetrics(questions, materials), by_category: byCategory(materials) },
  },
};
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, "retrieval.jsonl"), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
fs.writeFileSync(path.join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
