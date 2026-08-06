#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { factCoverage } from "./prepare-multihop-rag.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../../..");
const corpus = path.join(repositoryRoot, "target/benchmarks/multihop-rag/prepared-v2");
const packetFile = path.join(repositoryRoot, process.argv[2] ?? "target/benchmarks/multihop-rag/query-packets-frozen-v1/retrieval.jsonl");

const readJsonl = (file) => fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const questions = readJsonl(path.join(corpus, "evaluation/questions.jsonl"))
  .filter((question) => question.split === "development" || question.split === "diagnostic")
  .filter((question) => question.gold_status === "verified" && question.gold_evidence.units.length > 0);
const packets = new Map(readJsonl(packetFile).map((row) => [row.question_id, row.results[0]]));

function summarize(rows) {
  const units = rows.flatMap((row) => row.units);
  return {
    questions: rows.length,
    source_recall: units.filter((unit) => unit.source_selected).length / (units.length || 1),
    evidence_unit_recall: units.filter((unit) => unit.span_selected).length / (units.length || 1),
    span_retention_given_source: units.filter((unit) => unit.span_selected).length
      / (units.filter((unit) => unit.source_selected).length || 1),
    source_ceiling: rows.filter((row) => row.units.every((unit) => unit.source_selected)).length / (rows.length || 1),
    evidence_ceiling: rows.filter((row) => row.units.every((unit) => unit.span_selected)).length / (rows.length || 1),
  };
}

const rows = questions.map((question) => {
  const packet = packets.get(question.id);
  return {
    id: question.id,
    split: question.split,
    category: question.category,
    units: question.gold_evidence.units.map((unit) => ({
      source: unit.source,
      source_selected: Boolean(packet?.sources?.includes(unit.source)),
      span_selected: factCoverage(unit.fact, packet?.source_texts?.[unit.source] ?? "") >= 0.8,
    })),
  };
});

const dimensions = {
  overall: ["all"],
  split: [...new Set(rows.map((row) => row.split))],
  category: [...new Set(rows.map((row) => row.category))],
};
const report = {
  overall: summarize(rows),
  by_split: Object.fromEntries(dimensions.split.map((value) => [value, summarize(rows.filter((row) => row.split === value))])),
  by_category: Object.fromEntries(dimensions.category.map((value) => [value, summarize(rows.filter((row) => row.category === value))])),
};
console.log(JSON.stringify(report, null, 2));
