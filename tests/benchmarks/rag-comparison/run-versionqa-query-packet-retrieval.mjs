#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Bm25Index } from "./run-upper-bound.mjs";
import { scoreRows } from "./run-versionqa-raw-retrieval.mjs";
import { createVersionQaPacket, queryPacketResults } from "./versionqa-query-packets.mjs";
import {
  loadEvidenceAnnotations,
  resolveEvidenceContract,
  scoreEvidenceContract,
} from "./versionqa-evidence-score.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../../..");

function readJsonl(file) {
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function expectedMode(question) {
  if (question.category === "Version Listing & Inquiry") return "inventory";
  if (question.category === "Change Retrieval (i)") return "change";
  return "content";
}

const corpus = path.join(repositoryRoot, "target/benchmarks/versionqa/prepared");
const chunksFile = path.join(repositoryRoot, "target/benchmarks/versionqa/chunks-512.jsonl");
const outputArgument = process.argv.indexOf("--output");
const output = outputArgument >= 0
  ? path.resolve(process.argv[outputArgument + 1])
  : path.join(repositoryRoot, "target/benchmarks/versionqa/query-packet-retrieval-v7");
if (fs.existsSync(output)) throw new Error(`output already exists: ${output}`);

const questions = readJsonl(path.join(corpus, "evaluation/questions.jsonl"));
const chunks = readJsonl(chunksFile);
const bm25 = new Bm25Index(chunks);
const annotations = loadEvidenceAnnotations(path.join(scriptDirectory, "versionqa-evidence-contracts.json"));
const rows = [];
const classifications = [];
for (const question of questions) {
  const packetResult = queryPacketResults(question, { corpus, chunks, bm25 });
  rows.push({
    condition: "fragrach-query-packet-v1",
    question_id: question.id,
    category: question.category,
    version_sensitive: question.version_sensitive,
    results: packetResult.results,
  });
  classifications.push({
    question_id: question.id,
    predicted_mode: packetResult.mode,
    expected_mode: expectedMode(question),
    predicted_family: packetResult.family,
    expected_family: question.gold_evidence.family,
    packet_created: Boolean(packetResult.packet),
  });
}

const evidenceRows = rows.filter((row) => row.version_sensitive).map((row) => {
  const question = questions.find((candidate) => candidate.id === row.question_id);
  const contract = resolveEvidenceContract(question, annotations[question.id]);
  return { question_id: question.id, ...scoreEvidenceContract(contract, row.results.slice(0, 5)) };
});
const scorable = evidenceRows.filter((row) => row.scorable);
const report = {
  schema_version: "1.0",
  experiment: "versionqa-query-relative-packets",
  leakage_contract: "question text and Source Corpus only; category, Gold answer, Gold source mapping, and Evidence Unit annotations are not used to create or rank packets",
  questions: questions.length,
  packets_created: classifications.filter((row) => row.packet_created).length,
  mode_accuracy: classifications.filter((row) => row.predicted_mode === row.expected_mode).length / classifications.length,
  family_accuracy: classifications.filter((row) => row.predicted_family === row.expected_family).length / classifications.length,
  document_metrics: scoreRows(rows, questions, [5]),
  evidence_unit_metrics: {
    questions_scorable: scorable.length,
    questions_excluded: evidenceRows.length - scorable.length,
    evidence_recall_at_5: scorable.reduce((sum, row) => sum + row.recall, 0) / scorable.length,
    evidence_ceiling_at_5: scorable.filter((row) => row.complete).length / scorable.length,
  },
  classifications,
  evidence_rows: evidenceRows,
};

fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, "retrieval.jsonl"), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
fs.writeFileSync(path.join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  packets_created: report.packets_created,
  mode_accuracy: report.mode_accuracy,
  family_accuracy: report.family_accuracy,
  evidence_unit_metrics: report.evidence_unit_metrics,
}, null, 2));
