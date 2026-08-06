#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../../..");

function normalize(value) {
  return String(value ?? "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function hash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

export function documentId(url) {
  return `mhr-${hash(url).slice(0, 20)}`;
}

export function factCoverage(fact, body) {
  const factTokens = new Set(normalize(fact).split(" ").filter(Boolean));
  const bodyTokens = new Set(normalize(body).split(" ").filter(Boolean));
  if (factTokens.size === 0) return 1;
  return [...factTokens].filter((token) => bodyTokens.has(token)).length / factTokens.size;
}

export function assignPilotSplits(rows, perType = 20) {
  const result = new Map();
  for (const type of [...new Set(rows.map((row) => row.question_type))]) {
    const ordered = rows.filter((row) => row.question_type === type)
      .map((row) => ({ row, key: hash(`${row.query}\n${row.answer}`) }))
      .sort((left, right) => left.key.localeCompare(right.key));
    ordered.forEach(({ row }, index) => {
      result.set(row, index < perType
        ? "development"
        : index < perType * 2
          ? "diagnostic"
          : index < perType * 3
            ? "holdout"
            : "reserve");
    });
  }
  return result;
}

function yamlString(value) {
  return JSON.stringify(String(value ?? ""));
}

function sourcePath(id) {
  return `sources/articles/${id}.md`;
}

function parseArguments(argv) {
  const options = {
    input: path.join(repositoryRoot, "target/external/multihop-rag-data"),
    output: path.join(repositoryRoot, "target/benchmarks/multihop-rag/prepared"),
    perType: 20,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--input") options.input = path.resolve(argv[++index]);
    else if (argument === "--output") options.output = path.resolve(argv[++index]);
    else if (argument === "--per-type") options.perType = Number.parseInt(argv[++index], 10);
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node prepare-multihop-rag.mjs [--input DIR] [--output DIR] [--per-type 20]");
    return;
  }
  if (fs.existsSync(options.output)) throw new Error(`output already exists: ${options.output}`);
  const corpus = JSON.parse(fs.readFileSync(path.join(options.input, "corpus.json"), "utf8"));
  const rawQuestions = JSON.parse(fs.readFileSync(path.join(options.input, "MultiHopRAG.json"), "utf8"));
  const dates = corpus.map((document) => Date.parse(document.published_at)).sort((left, right) => left - right);
  const cutoffMs = dates[Math.floor(dates.length / 2)];
  const byUrl = new Map(corpus.map((document) => [document.url, document]));
  const splits = assignPilotSplits(rawQuestions, options.perType);
  const sourceDirectory = path.join(options.output, "sources/articles");
  fs.mkdirSync(sourceDirectory, { recursive: true });
  for (const document of corpus) {
    const id = documentId(document.url);
    const markdown = [
      "---",
      `document_id: ${yamlString(id)}`,
      `published_at: ${yamlString(document.published_at)}`,
      `publisher: ${yamlString(document.source)}`,
      `author: ${yamlString(document.author)}`,
      `category: ${yamlString(document.category)}`,
      `canonical_url: ${yamlString(document.url)}`,
      "---",
      "",
      `# ${document.title}`,
      "",
      document.body,
      "",
    ].join("\n");
    fs.writeFileSync(path.join(sourceDirectory, `${id}.md`), markdown, "utf8");
  }

  const questions = rawQuestions.map((question, index) => {
    const units = (question.evidence_list ?? []).map((evidence) => {
      const document = byUrl.get(evidence.url);
      const id = document ? documentId(document.url) : null;
      return {
        type: "source_span",
        source: id ? sourcePath(id) : null,
        fact: evidence.fact,
        fact_token_coverage: document ? factCoverage(evidence.fact, document.body) : 0,
        published_at: evidence.published_at,
      };
    });
    const defects = units.flatMap((unit) => [
      ...(!unit.source ? ["evidence document is absent from corpus"] : []),
      ...(unit.fact_token_coverage < 0.8 ? [`fact token coverage is ${unit.fact_token_coverage.toFixed(3)}`] : []),
    ]);
    return {
      id: `MHR-${String(index + 1).padStart(4, "0")}`,
      category: question.question_type,
      question: question.query,
      answer: question.answer,
      split: splits.get(question),
      corpus_phase: units.some((unit) => Date.parse(unit.published_at) > cutoffMs) ? "T1" : "T0",
      gold_status: defects.length === 0 ? "verified" : "disputed",
      gold_defects: defects,
      gold_evidence: {
        sources: [...new Set(units.map((unit) => unit.source).filter(Boolean))],
        units,
      },
    };
  });
  fs.mkdirSync(path.join(options.output, "evaluation"), { recursive: true });
  fs.writeFileSync(path.join(options.output, "evaluation/questions.jsonl"), `${questions.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
  const counts = Object.fromEntries([...new Set(questions.map((question) => question.category))].sort().map((category) => [category, {
    total: questions.filter((question) => question.category === category).length,
    development: questions.filter((question) => question.category === category && question.split === "development").length,
    diagnostic: questions.filter((question) => question.category === category && question.split === "diagnostic").length,
    holdout: questions.filter((question) => question.category === category && question.split === "holdout").length,
    disputed: questions.filter((question) => question.category === category && question.gold_status === "disputed").length,
  }]));
  const manifest = {
    schema_version: "1.0",
    source_dataset: "yixuantt/MultiHopRAG",
    source_commit: "71ac0d0bd1f951d2d6b70311f7d2ae404e1ffa82",
    leakage_contract: "Gold answers and evidence are retained for evaluation only and must not be passed to retrieval or Packet generation.",
    documents: corpus.length,
    questions: questions.length,
    t0_t1_cutoff: new Date(cutoffMs).toISOString(),
    pilot_per_type: options.perType,
    counts,
  };
  fs.writeFileSync(path.join(options.output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(manifest, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
