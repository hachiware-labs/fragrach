#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../../..");
const root = path.join(repositoryRoot, "target/benchmarks/enterprise-rag-bench");
let output = path.join(root, "answers-diagnostic-v1");
let inputPrefix = "answers-diagnostic-bounded-shard-";
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument === "--output") output = path.resolve(process.argv[++index]);
  else if (argument === "--input-prefix") inputPrefix = process.argv[++index];
  else throw new Error(`unknown argument: ${argument}`);
}
const readJsonl = (file) => fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map(JSON.parse);
const writeJsonl = (file, rows) => fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");

function summarize(rows) {
  const correct = rows.filter((row) => row.answer_correct).length;
  return {
    questions: rows.length, answer_accuracy: correct / Math.max(rows.length, 1),
    evidence_ceiling: null, dvaa_gross: null, dvaa_net: null,
    evidence_status: "pending canonical source-local rescore",
    counts: { answer_correct: correct, evidence_complete: null, strict: null },
  };
}

if (fs.existsSync(output)) throw new Error(`output already exists: ${output}`);
const rows = ["0", "23", "46", "69"].flatMap((suffix) => readJsonl(path.join(root, `${inputPrefix}${suffix}/answers.jsonl`)));
const unique = new Set(rows.map((row) => `${row.condition}:${row.question_id}`));
const conditionNames = [...new Set(rows.map((row) => row.condition))].sort();
const invalidConditions = conditionNames.filter((condition) => rows.filter((row) => row.condition === condition).length !== 91);
const expected = conditionNames.length * 91;
if (rows.length !== expected || unique.size !== expected || invalidConditions.length > 0) {
  throw new Error(`answer merge mismatch: rows=${rows.length}, unique=${unique.size}, expected=${expected}, invalid_conditions=${invalidConditions.join(",")}`);
}
const conditions = Object.fromEntries(conditionNames.map((condition) => {
  const selected = rows.filter((row) => row.condition === condition);
  return [condition, {
    overall: summarize(selected),
    by_category: Object.fromEntries([...new Set(selected.map((row) => row.category))].sort().map((category) => [category, summarize(selected.filter((row) => row.category === category))])),
  }];
}));
const report = {
  schema_version: "1.0", experiment: "enterprise-rag-bench-diagnostic-dvaa", model: "gpt-5.6-luna",
  input_prefix: inputPrefix,
  population: "91 diagnostic questions with verified source-span Gold; disputed, unmapped, null, development, and holdout questions excluded.",
  answer_scoring: "Independent Luna semantic judge: every answer_facts item expressed and no contradiction.",
  evidence_scoring: "Pending enterprise_rag_bench_metrics.py source-local rescore; this merge report intentionally has no DVAA headline.",
  dvaa_contract: "Gross = answer correct AND every Gold Evidence Unit present / all evaluated questions. Net = same strict passes / questions with complete evidence.",
  conditions,
};
fs.mkdirSync(output, { recursive: true });
writeJsonl(path.join(output, "answers.jsonl"), rows);
fs.writeFileSync(path.join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
