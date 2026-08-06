#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../../..");
const root = path.join(repositoryRoot, "target/benchmarks/enterprise-rag-bench");
const input = path.join(root, "prepared-v2");
const output = path.join(root, "prepared-v3");
const readJsonl = (file) => fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map(JSON.parse);
const writeJsonl = (file, rows) => fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");

if (fs.existsSync(output)) throw new Error(`output already exists: ${output}`);
const questions = readJsonl(path.join(input, "questions.jsonl"));
const documents = readJsonl(path.join(input, "gold-documents.jsonl"));
const auditFiles = [0, 12, 24].map((offset) => path.join(root, `gold-audit-shard-${offset}.jsonl`));
const audits = auditFiles.flatMap(readJsonl);
const disputed = questions.filter((row) => row.gold_status === "disputed");
const auditById = new Map(audits.map((row) => [row.question_id, row]));
const missing = disputed.filter((row) => !auditById.has(row.id)).map((row) => row.id);
if (audits.length !== disputed.length || auditById.size !== disputed.length || missing.length > 0) {
  throw new Error(`Gold audit merge mismatch: rows=${audits.length}, unique=${auditById.size}, expected=${disputed.length}, missing=${missing.join(",")}`);
}
const repaired = questions.map((question) => {
  const audit = auditById.get(question.id);
  if (!audit) return question;
  const fullySupported = audit.facts.every((fact) => fact.supported && fact.source_id && fact.evidence_excerpt);
  if (!fullySupported) return { ...question, gold_defects: [...question.gold_defects, { type: "semantic_gold_audit_failed", facts: audit.facts }] };
  return {
    ...question,
    gold_status: "verified",
    gold_defects: [],
    gold_evidence: {
      sources: question.gold_evidence.sources,
      units: audit.facts.map((fact, index) => ({
        type: "source_span", source: fact.source_id, fact: fact.evidence_excerpt,
        claim: question.answer_facts[index], provenance: "luna-semantic-gold-audit",
      })),
    },
  };
});
fs.mkdirSync(output, { recursive: true });
writeJsonl(path.join(output, "questions.jsonl"), repaired);
writeJsonl(path.join(output, "gold-documents.jsonl"), documents);
writeJsonl(path.join(output, "semantic-gold-audit.jsonl"), disputed.map((row) => auditById.get(row.id)));
const statusCounts = Object.fromEntries([...new Set(repaired.map((row) => row.gold_status))].sort().map((status) => [status, repaired.filter((row) => row.gold_status === status).length]));
const report = {
  schema_version: "1.0", model: "gpt-5.6-luna",
  audit_contract: "Only provisional lexical-audit failures were semantically audited. A fact is repaired only when Luna identifies an expected source and copies a supporting excerpt; unsupported cases remain disputed.",
  disputed_audited: disputed.length,
  repaired_to_verified: disputed.filter((row) => repaired.find((item) => item.id === row.id).gold_status === "verified").length,
  remaining_disputed: repaired.filter((row) => row.gold_status === "disputed").length,
  status_counts: statusCounts,
};
fs.writeFileSync(path.join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
