#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createStructuredChat } from "./structured-chat.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../../..");
const root = path.join(repositoryRoot, "target/benchmarks/enterprise-rag-bench");
const input = path.join(root, "prepared-v2");
const output = path.join(root, "prepared-v3");
let auditOutput = null;
let offset = 0;
let limit = null;
let concurrency = 8;
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument === "--audit-output") auditOutput = path.resolve(process.argv[++index]);
  else if (argument === "--offset") offset = Number.parseInt(process.argv[++index], 10);
  else if (argument === "--limit") limit = Number.parseInt(process.argv[++index], 10);
  else if (argument === "--concurrency") concurrency = Number.parseInt(process.argv[++index], 10);
  else throw new Error(`unknown argument: ${argument}`);
}
const readJsonl = (file) => fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map(JSON.parse);
const writeJsonl = (file, rows) => fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");

async function concurrentMap(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

function schema(question) {
  return {
    type: "object", additionalProperties: false, required: ["facts"], properties: {
      facts: { type: "array", minItems: question.answer_facts.length, maxItems: question.answer_facts.length, items: {
        type: "object", additionalProperties: false,
        required: ["fact_index", "supported", "source_id", "evidence_excerpt"],
        properties: {
          fact_index: { type: "integer", enum: question.answer_facts.map((_, index) => index) },
          supported: { type: "boolean" },
          source_id: { type: "string", enum: ["", ...question.gold_evidence.sources] },
          evidence_excerpt: { type: "string" },
        },
      } },
    },
  };
}

function prompt(question, documents) {
  const facts = question.answer_facts.map((fact, index) => `${index}. ${fact}`).join("\n");
  const sources = documents.map((document) => `SOURCE ${document.doc_id}\nTITLE: ${document.title}\n${document.content}`).join("\n\n---\n\n");
  return `Audit whether every Gold answer fact is directly supported by at least one supplied expected source.

Rules:
- Judge semantic entailment, including paraphrases; do not require word overlap.
- Do not use outside knowledge or infer an unsupported fact.
- If supported, return the supporting source_id and a short verbatim evidence excerpt copied from that source (at most 80 words).
- If unsupported, set source_id and evidence_excerpt to empty strings.
- Return every fact index exactly once.

Question: ${question.question}
Gold answer: ${question.answer}

FACTS:
${facts}

EXPECTED SOURCES:
${sources}`;
}

if (auditOutput && fs.existsSync(auditOutput)) throw new Error(`audit output already exists: ${auditOutput}`);
if (!auditOutput && fs.existsSync(output)) throw new Error(`output already exists: ${output}`);
const questions = readJsonl(path.join(input, "questions.jsonl"));
const documents = readJsonl(path.join(input, "gold-documents.jsonl"));
const documentById = new Map(documents.map((row) => [row.doc_id, row]));
const allDisputed = questions.filter((row) => row.gold_status === "disputed");
const disputed = allDisputed.slice(offset, limit === null ? undefined : offset + limit);
const client = await createStructuredChat({ provider: "codex-app-server", cwd: repositoryRoot, model: "gpt-5.6-luna", reasoningEffort: "low" });
let audits;
try {
  audits = await concurrentMap(disputed, concurrency, async (question, position) => {
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await client.chat(
          prompt(question, question.gold_evidence.sources.map((id) => documentById.get(id)).filter(Boolean)),
          schema(question),
        );
        const byIndex = new Map(response.content.facts.map((fact) => [fact.fact_index, fact]));
        if (byIndex.size !== question.answer_facts.length) throw new Error(`fact index mismatch: ${byIndex.size}/${question.answer_facts.length}`);
        if ((position + 1) % 5 === 0) console.log(JSON.stringify({ audited: position + 1 }));
        return { question_id: question.id, facts: question.answer_facts.map((_, index) => byIndex.get(index)) };
      } catch (error) {
        lastError = error;
        console.error(`Gold audit ${question.id} attempt ${attempt} failed: ${error.message}`);
      }
    }
    throw lastError;
  });
} finally {
  await client.close();
}

if (auditOutput) {
  fs.mkdirSync(path.dirname(auditOutput), { recursive: true });
  writeJsonl(auditOutput, audits);
  console.log(JSON.stringify({ audit_output: auditOutput, questions: audits.length, offset, concurrency }, null, 2));
  process.exit(0);
}

const auditById = new Map(audits.map((row) => [row.question_id, row]));
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
        type: "source_span",
        source: fact.source_id,
        fact: fact.evidence_excerpt,
        claim: question.answer_facts[index],
        provenance: "luna-semantic-gold-audit",
      })),
    },
  };
});
fs.mkdirSync(output, { recursive: true });
writeJsonl(path.join(output, "questions.jsonl"), repaired);
writeJsonl(path.join(output, "gold-documents.jsonl"), documents);
writeJsonl(path.join(output, "semantic-gold-audit.jsonl"), audits);
const statusCounts = Object.fromEntries([...new Set(repaired.map((row) => row.gold_status))].sort().map((status) => [status, repaired.filter((row) => row.gold_status === status).length]));
const report = {
  schema_version: "1.0",
  model: "gpt-5.6-luna",
  audit_contract: "Only provisional lexical-audit failures were semantically audited. A fact is repaired only when Luna identifies an expected source and copies a supporting excerpt; unsupported cases remain disputed.",
  disputed_audited: disputed.length,
  repaired_to_verified: disputed.filter((row) => repaired.find((item) => item.id === row.id).gold_status === "verified").length,
  remaining_disputed: repaired.filter((row) => row.gold_status === "disputed").length,
  status_counts: statusCounts,
};
fs.writeFileSync(path.join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
