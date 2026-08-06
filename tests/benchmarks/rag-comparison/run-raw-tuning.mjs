#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  Bm25Index,
  buildRawChunks,
  enrichQuestionsWithConflictGold,
  readCorpusGold,
  scoreRetrieval,
} from "./run-upper-bound.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultCorpusRoot = path.resolve(
  scriptDirectory,
  "../../corpora/aobane-industries-ja-medium",
);
const defaultOutputDirectory = path.resolve(
  scriptDirectory,
  "../../../target/benchmarks/raw-rag-tuning",
);

function readJsonl(filePath) {
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function percentage(value) {
  return value === null || value === undefined
    ? "n/a"
    : `${(value * 100).toFixed(1)}%`;
}

function stableHash(value) {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function splitQuestions(questions) {
  const groups = new Map();
  for (const question of questions) {
    const cohort = question.id.startsWith("M-") ? "added84" : "legacy16";
    const key = `${cohort}:${question.intent_id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(question);
  }
  const development = [];
  const holdout = [];
  for (const group of groups.values()) {
    const sorted = [...group].sort(
      (left, right) => stableHash(left.id) - stableHash(right.id),
    );
    sorted.forEach((question, index) => {
      if (index % 4 === 0) holdout.push(question);
      else development.push(question);
    });
  }
  return { development, holdout };
}

function retrievalFor(index, questions, maximumK, queryMode) {
  return new Map(
    questions.map((question) => {
      const query = queryMode === "question-as-of"
        ? `${question.question}\n対象時点: ${question.as_of}`
        : question.question;
      return [question.id, index.search(query, maximumK)];
    }),
  );
}

function compactScore(score) {
  return {
    questions: score.questions,
    recall_at_k: score.recall_at_k,
    complete_at_k: score.complete_at_k,
    precision_at_k: score.precision_at_k,
    distractor_rate_at_k: score.distractor_rate_at_k,
    conflict_recall_at_k: score.conflict_recall_at_k,
    conflict_complete_rate_at_k: score.conflict_complete_rate_at_k,
    resolution_accuracy_at_k: score.resolution_accuracy_at_k,
    resolution_coverage_at_k: score.resolution_coverage_at_k,
    by_cohort: score.by_cohort,
    by_intent: score.by_intent,
  };
}

export function compareCandidates(left, right) {
  const comparisons = [
    [right.development.recall_at_k["5"], left.development.recall_at_k["5"]],
    [right.development.recall_at_k["10"], left.development.recall_at_k["10"]],
    [
      right.development.conflict_complete_rate_at_k["10"] ?? -1,
      left.development.conflict_complete_rate_at_k["10"] ?? -1,
    ],
    [
      left.development.distractor_rate_at_k["5"] ?? 1,
      right.development.distractor_rate_at_k["5"] ?? 1,
    ],
    [left.chunk_count, right.chunk_count],
  ];
  for (const [leftValue, rightValue] of comparisons) {
    if (leftValue !== rightValue) return leftValue - rightValue;
  }
  return left.id.localeCompare(right.id, "ja");
}

function chunkConfigurations() {
  return [
    { name: "paragraph", strategy: "paragraph" },
    { name: "paragraph-no-metadata", strategy: "paragraph", includeMetadata: false },
    { name: "fixed-256", strategy: "fixed", maxChars: 256, overlapParagraphs: 0 },
    { name: "fixed-256-overlap-1", strategy: "fixed", maxChars: 256, overlapParagraphs: 1 },
    { name: "fixed-512", strategy: "fixed", maxChars: 512, overlapParagraphs: 0 },
    { name: "fixed-512-overlap-1", strategy: "fixed", maxChars: 512, overlapParagraphs: 1 },
    { name: "fixed-1024", strategy: "fixed", maxChars: 1024, overlapParagraphs: 0 },
    { name: "fixed-1024-overlap-1", strategy: "fixed", maxChars: 1024, overlapParagraphs: 1 },
    { name: "fixed-2048-overlap-1", strategy: "fixed", maxChars: 2048, overlapParagraphs: 1 },
    { name: "section", strategy: "section" },
  ];
}

function structureConfigurations() {
  const result = [];
  const ngrams = [[2], [3], [2, 3], [1, 2]];
  for (const chunking of chunkConfigurations()) {
    for (const ngramSizes of ngrams) {
      for (const queryMode of ["question-only", "question-as-of"]) {
        result.push({ chunking, ngramSizes, queryMode, k1: 1.5, b: 0.75 });
      }
    }
  }
  return result;
}

function bm25Configurations(structureWinners) {
  const result = [];
  for (const winner of structureWinners) {
    for (const k1 of [0.6, 0.9, 1.2, 1.5, 1.8]) {
      for (const b of [0.25, 0.5, 0.75, 1]) {
        result.push({
          chunking: winner.configuration.chunking,
          ngramSizes: winner.configuration.ngramSizes,
          queryMode: winner.configuration.queryMode,
          k1,
          b,
        });
      }
    }
  }
  return result;
}

function configurationId(configuration) {
  return [
    configuration.chunking.name,
    `ngram-${configuration.ngramSizes.join("-")}`,
    configuration.queryMode,
    `k1-${configuration.k1}`,
    `b-${configuration.b}`,
  ].join("__");
}

function evaluateConfiguration(
  corpusRoot,
  questions,
  split,
  configuration,
  chunkCache,
) {
  const chunkKey = JSON.stringify(configuration.chunking);
  if (!chunkCache.has(chunkKey)) {
    chunkCache.set(
      chunkKey,
      buildRawChunks(corpusRoot, configuration.chunking),
    );
  }
  const chunks = chunkCache.get(chunkKey);
  const index = new Bm25Index(chunks, {
    k1: configuration.k1,
    b: configuration.b,
    ngramSizes: configuration.ngramSizes,
  });
  const evaluate = (selected) => compactScore(
    scoreRetrieval(
      selected,
      retrievalFor(index, selected, 20, configuration.queryMode),
      [5, 10, 20],
      { supportsConflictUnits: false },
    ),
  );
  return {
    id: configurationId(configuration),
    configuration,
    chunk_count: chunks.length,
    development: evaluate(split.development),
    holdout: evaluate(split.holdout),
    full: evaluate(questions),
  };
}

function summaryTable(rows, field = "development", limit = 10) {
  const header = [
    "| 順位 | 条件 | chunks | R@5 | R@10 | R@20 | Conflict complete@10 | D@5 |",
    "|---:|---|---:|---:|---:|---:|---:|---:|",
  ];
  const body = rows.slice(0, limit).map((row, index) => {
    const score = row[field];
    return `| ${index + 1} | \`${row.id}\` | ${row.chunk_count} | ${percentage(score.recall_at_k["5"])} | ${percentage(score.recall_at_k["10"])} | ${percentage(score.recall_at_k["20"])} | ${percentage(score.conflict_complete_rate_at_k["10"])} | ${percentage(score.distractor_rate_at_k["5"])} |`;
  });
  return [...header, ...body].join("\n");
}

function renderMarkdown(report) {
  const winner = report.winner;
  const baseline = report.current_baseline;
  return `# Tuned Raw RAG検索評価

実施日時: ${report.generated_at}

500文書・100問に対して、純粋なRaw RAGのチャンク構成、日本語n-gram、質問への対象時点付加、BM25の\`k1\`と\`b\`を調整した。回答LLMとFragrachのコンパイル結果は使用していない。

条件選択には${report.split.development_questions}問の開発群を使い、${report.split.holdout_questions}問は選択に使わず確認した。主判定は開発群のR@5、同率時はR@10、Conflict complete@10、不要単位率、索引サイズの順である。

## 結果

| 条件 | 質問群 | R@5 | R@10 | R@20 | Conflict complete@10 | 解決精度@10 | 解決Coverage@10 | D@5 |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| 現行Raw | 全100問 | ${percentage(baseline.full.recall_at_k["5"])} | ${percentage(baseline.full.recall_at_k["10"])} | ${percentage(baseline.full.recall_at_k["20"])} | ${percentage(baseline.full.conflict_complete_rate_at_k["10"])} | ${percentage(baseline.full.resolution_accuracy_at_k["10"])} | ${percentage(baseline.full.resolution_coverage_at_k["10"])} | ${percentage(baseline.full.distractor_rate_at_k["5"])} |
| Tuned Raw | 開発群 | ${percentage(winner.development.recall_at_k["5"])} | ${percentage(winner.development.recall_at_k["10"])} | ${percentage(winner.development.recall_at_k["20"])} | ${percentage(winner.development.conflict_complete_rate_at_k["10"])} | ${percentage(winner.development.resolution_accuracy_at_k["10"])} | ${percentage(winner.development.resolution_coverage_at_k["10"])} | ${percentage(winner.development.distractor_rate_at_k["5"])} |
| Tuned Raw | 保留群 | ${percentage(winner.holdout.recall_at_k["5"])} | ${percentage(winner.holdout.recall_at_k["10"])} | ${percentage(winner.holdout.recall_at_k["20"])} | ${percentage(winner.holdout.conflict_complete_rate_at_k["10"])} | ${percentage(winner.holdout.resolution_accuracy_at_k["10"])} | ${percentage(winner.holdout.resolution_coverage_at_k["10"])} | ${percentage(winner.holdout.distractor_rate_at_k["5"])} |
| Tuned Raw | 全100問 | ${percentage(winner.full.recall_at_k["5"])} | ${percentage(winner.full.recall_at_k["10"])} | ${percentage(winner.full.recall_at_k["20"])} | ${percentage(winner.full.conflict_complete_rate_at_k["10"])} | ${percentage(winner.full.resolution_accuracy_at_k["10"])} | ${percentage(winner.full.resolution_coverage_at_k["10"])} | ${percentage(winner.full.distractor_rate_at_k["5"])} |

選択条件は\`${winner.id}\`、索引は${winner.chunk_count} chunksである。全100問の値は既知質問を含む最終記述値であり、未知質問への見積もりには保留群の値を優先する。

## 開発群の上位条件

${summaryTable(report.ranked_candidates, "development", 10)}
`;
}

function parseArguments(argv) {
  const options = {
    corpusRoot: defaultCorpusRoot,
    outputDirectory: defaultOutputDirectory,
    topStructures: 8,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--corpus") options.corpusRoot = path.resolve(argv[++index]);
    else if (argument === "--output") options.outputDirectory = path.resolve(argv[++index]);
    else if (argument === "--top-structures") options.topStructures = Number.parseInt(argv[++index], 10);
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node run-raw-tuning.mjs [--corpus <path>] [--output <path>] [--top-structures <n>]");
    return;
  }
  fs.mkdirSync(options.outputDirectory, { recursive: true });
  const rawQuestions = readJsonl(
    path.join(options.corpusRoot, "evaluation/questions.jsonl"),
  );
  const gold = readCorpusGold(options.corpusRoot);
  const questions = enrichQuestionsWithConflictGold(
    rawQuestions,
    gold.answers,
    gold.conflicts,
  );
  const split = splitQuestions(questions);
  const chunkCache = new Map();

  const baselineConfiguration = {
    chunking: { name: "paragraph", strategy: "paragraph" },
    ngramSizes: [2, 3],
    queryMode: "question-as-of",
    k1: 1.5,
    b: 0.75,
  };
  const currentBaseline = evaluateConfiguration(
    options.corpusRoot,
    questions,
    split,
    baselineConfiguration,
    chunkCache,
  );

  const structureResults = structureConfigurations().map((configuration, index, all) => {
    if (index % 10 === 0) console.log(`Structure grid ${index}/${all.length}`);
    return evaluateConfiguration(
      options.corpusRoot,
      questions,
      split,
      configuration,
      chunkCache,
    );
  }).sort(compareCandidates);
  const finalists = structureResults.slice(0, options.topStructures);
  const bm25Results = bm25Configurations(finalists).map((configuration, index, all) => {
    if (index % 20 === 0) console.log(`BM25 grid ${index}/${all.length}`);
    return evaluateConfiguration(
      options.corpusRoot,
      questions,
      split,
      configuration,
      chunkCache,
    );
  });
  const rankedCandidates = [...structureResults, ...bm25Results]
    .sort(compareCandidates)
    .filter((row, index, rows) =>
      rows.findIndex((candidate) => candidate.id === row.id) === index
    );

  const report = {
    schema_version: "1.0",
    experiment: "tuned-raw-rag",
    generated_at: new Date().toISOString(),
    corpus_root: options.corpusRoot,
    selection_order: [
      "development.recall_at_5 desc",
      "development.recall_at_10 desc",
      "development.conflict_complete_at_10 desc",
      "development.distractor_at_5 asc",
      "chunk_count asc",
    ],
    split: {
      development_questions: split.development.length,
      holdout_questions: split.holdout.length,
      development_ids: split.development.map((question) => question.id).sort(),
      holdout_ids: split.holdout.map((question) => question.id).sort(),
    },
    searched: {
      structure_configurations: structureResults.length,
      bm25_configurations: bm25Results.length,
    },
    current_baseline: currentBaseline,
    winner: rankedCandidates[0],
    ranked_candidates: rankedCandidates,
  };
  fs.writeFileSync(
    path.join(options.outputDirectory, "raw-tuning-report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(options.outputDirectory, "RAW_TUNING_FINDINGS_ja.md"),
    renderMarkdown(report),
  );
  console.log(`Winner: ${report.winner.id}`);
  console.log(`Full R@5 ${percentage(report.winner.full.recall_at_k["5"])} R@10 ${percentage(report.winner.full.recall_at_k["10"])} R@20 ${percentage(report.winner.full.recall_at_k["20"])}`);
  console.log(`Report: ${path.join(options.outputDirectory, "raw-tuning-report.json")}`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main();
}
