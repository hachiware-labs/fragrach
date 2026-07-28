#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  Bm25Index,
  buildActualChunks,
  buildOracleChunks,
  buildRawChunks,
  documentMatchesAsOf,
  expandedEvidence,
  retrievalRecall,
  retrieve,
} from "./run-upper-bound.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultCorpusRoot = path.resolve(
  scriptDirectory,
  "../../corpora/aobane-industries-ja",
);
const defaultOutputPath = path.resolve(
  scriptDirectory,
  "../../../target/benchmarks/rag-ablation/retrieval-ablation.json",
);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readJsonl(filePath) {
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function parseArguments(argv) {
  const options = {
    corpusRoot: defaultCorpusRoot,
    outputPath: defaultOutputPath,
    compiledBuilds: [],
    topKValues: [5, 10, 20],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--corpus") {
      options.corpusRoot = path.resolve(argv[++index]);
    } else if (argument === "--output") {
      options.outputPath = path.resolve(argv[++index]);
    } else if (argument === "--compiled-build") {
      options.compiledBuilds.push(path.resolve(argv[++index]));
    } else if (argument === "--top-k") {
      options.topKValues = argv[++index]
        .split(",")
        .map((value) => Number.parseInt(value, 10));
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return options;
}

function printHelp() {
  console.log(`Usage:
  node run-ablation.mjs --compiled-build <path> [options]

Options:
  --corpus <path>         Corpus root
  --output <path>         JSON report path
  --compiled-build <path> Add an actual Fragrach Knowledge Build (repeatable)
  --top-k <values>        Comma-separated retrieval depths (default: 5,10,20)
  --help                  Show this help`);
}

function evaluateVariant(documents, questions, topKValues) {
  const index = new Bm25Index(documents);
  const retrieval = {};
  for (const topK of topKValues) {
    const byQuestion = retrieve(index, questions, topK);
    const perQuestion = Object.fromEntries(
      questions.map((question) => {
        const retrieved = byQuestion.get(question.id) ?? [];
        return [
          question.id,
          {
            recall: retrievalRecall(question, retrieved),
            retrieved_units: retrieved.map((item) => item.document.id),
            retrieved_evidence: expandedEvidence(retrieved),
          },
        ];
      }),
    );
    const recalls = Object.values(perQuestion).map((result) => result.recall);
    retrieval[topK] = {
      macro_recall: recalls.reduce((sum, value) => sum + value, 0) / recalls.length,
      perfect_questions: recalls.filter((value) => value === 1).length,
      per_question: perQuestion,
    };
  }
  return {
    knowledge_units: documents.length,
    retrieval,
  };
}

function searchQuestion(index, question, limit) {
  const query = `${question.question}\n対象時点: ${question.as_of}`;
  return index.search(
    query,
    limit,
    index.documents.some((document) => document.intent_id)
      ? (document) =>
          document.intent_id === question.intent_id &&
          documentMatchesAsOf(document, question.as_of)
      : null,
  );
}

function evaluateHybrid(
  primaryDocuments,
  fallbackDocuments,
  questions,
  topKValues,
  primaryRatio,
) {
  const primaryIndex = new Bm25Index(primaryDocuments);
  const fallbackIndex = new Bm25Index(fallbackDocuments);
  const retrieval = {};
  for (const topK of topKValues) {
    const primaryLimit = Math.max(1, Math.ceil(topK * primaryRatio));
    const fallbackLimit = topK - primaryLimit;
    const perQuestion = Object.fromEntries(
      questions.map((question) => {
        const primary = searchQuestion(primaryIndex, question, primaryLimit);
        const seen = new Set(primary.map((item) => item.document.id));
        const fallback = [];
        if (fallbackLimit > 0) {
          for (const item of searchQuestion(
            fallbackIndex,
            question,
            topK + fallbackLimit + 10,
          )) {
            if (seen.has(item.document.id)) continue;
            seen.add(item.document.id);
            fallback.push(item);
            if (fallback.length === fallbackLimit) break;
          }
        }
        const retrieved = [...primary, ...fallback];
        return [
          question.id,
          {
            recall: retrievalRecall(question, retrieved),
            retrieved_units: retrieved.map((item) => item.document.id),
            retrieved_evidence: expandedEvidence(retrieved),
          },
        ];
      }),
    );
    const recalls = Object.values(perQuestion).map((result) => result.recall);
    retrieval[topK] = {
      macro_recall: recalls.reduce((sum, value) => sum + value, 0) / recalls.length,
      perfect_questions: recalls.filter((value) => value === 1).length,
      primary_slots: primaryLimit,
      fallback_slots: fallbackLimit,
      per_question: perQuestion,
    };
  }
  return {
    knowledge_units: primaryDocuments.length + fallbackDocuments.length,
    primary_knowledge_units: primaryDocuments.length,
    fallback_knowledge_units: fallbackDocuments.length,
    retrieval,
  };
}

function percentage(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (options.compiledBuilds.length === 0) {
    throw new Error("at least one --compiled-build is required");
  }
  if (
    options.topKValues.length === 0 ||
    options.topKValues.some((value) => !Number.isInteger(value) || value < 1)
  ) {
    throw new Error("--top-k values must be positive integers");
  }

  const questions = readJsonl(
    path.join(options.corpusRoot, "evaluation/questions.jsonl"),
  );
  const expected = readJson(
    path.join(options.corpusRoot, "ground-truth/expected.json"),
  );
  const rawChunks = buildRawChunks(options.corpusRoot);
  const variants = [
    {
      label: "raw-rag",
      kind: "raw",
      options: {},
      chunks: rawChunks,
    },
    {
      label: "oracle-compiled",
      kind: "oracle",
      options: {},
      chunks: buildOracleChunks(expected, rawChunks),
    },
    {
      label: "actual-baseline",
      kind: "actual",
      options: {},
    },
    {
      label: "actual-aliases",
      kind: "actual",
      options: { includeDiagnosticAliases: true },
    },
    {
      label: "actual-no-authority",
      kind: "actual",
      options: { authorityBoost: false },
    },
    {
      label: "actual-no-conflicts",
      kind: "actual",
      options: { includeConflicts: false },
    },
    {
      label: "actual-evidence-fallback",
      kind: "actual",
      options: {
        evidenceFallback: true,
        includeDiagnosticAliases: true,
      },
    },
    {
      label: "actual-fallback-no-authority",
      kind: "actual",
      options: {
        authorityBoost: false,
        evidenceFallback: true,
        includeDiagnosticAliases: true,
      },
    },
    {
      label: "actual-fallback-evidence-only",
      kind: "actual",
      options: {
        evidenceFallback: true,
        includeClaims: false,
        includeDiagnosticAliases: true,
      },
    },
  ];

  const results = {};
  for (const variant of variants) {
    const chunks =
      variant.chunks ??
      buildActualChunks(options.compiledBuilds, variant.options);
    results[variant.label] = {
      kind: variant.kind,
      options: variant.options,
      ...evaluateVariant(chunks, questions, options.topKValues),
    };
  }
  const hybridPrimary = buildActualChunks(options.compiledBuilds, {
    includeDiagnosticAliases: true,
  });
  const hybridFallback = buildActualChunks(options.compiledBuilds, {
    evidenceFallback: true,
    includeClaims: false,
    includeConflicts: false,
    includeDiagnosticAliases: true,
  });
  for (const [label, primaryRatio] of [
    ["actual-hybrid-80", 0.8],
    ["actual-hybrid-60", 0.6],
  ]) {
    results[label] = {
      kind: "actual",
      options: {
        retrieval: "claim-first-evidence-fallback",
        primaryRatio,
      },
      ...evaluateHybrid(
        hybridPrimary,
        hybridFallback,
        questions,
        options.topKValues,
        primaryRatio,
      ),
    };
  }

  const baseline = results["actual-baseline"];
  const report = {
    schema_version: "0.1",
    experiment: "retrieval-ablation",
    generated_at: new Date().toISOString(),
    questions: questions.length,
    top_k_values: options.topKValues,
    variants: results,
    deltas_from_actual_baseline: Object.fromEntries(
      Object.entries(results)
        .filter(([label]) => label.startsWith("actual-") && label !== "actual-baseline")
        .map(([label, result]) => [
          label,
          Object.fromEntries(
            options.topKValues.map((topK) => [
              topK,
              result.retrieval[topK].macro_recall -
                baseline.retrieval[topK].macro_recall,
            ]),
          ),
        ]),
    ),
  };

  fs.mkdirSync(path.dirname(options.outputPath), { recursive: true });
  fs.writeFileSync(
    options.outputPath,
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );

  const headings = ["variant", "units", ...options.topKValues.map((k) => `R@${k}`)];
  console.log(headings.join("\t"));
  for (const [label, result] of Object.entries(results)) {
    console.log(
      [
        label,
        result.knowledge_units,
        ...options.topKValues.map((topK) =>
          percentage(result.retrieval[topK].macro_recall),
        ),
      ].join("\t"),
    );
  }
  console.log(`Report: ${options.outputPath}`);
}

try {
  main();
} catch (error) {
  console.error(`Error: ${error.stack ?? error.message}`);
  process.exitCode = 1;
}
