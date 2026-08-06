#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { scoreRetrieval } from "./run-upper-bound.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const scriptRoot = path.dirname(scriptPath);
const defaultCorpus = path.resolve(scriptRoot, "../../corpora/fragrach-enterprise-ja-diverse");
const ks = [5, 10, 20];
const normalize = (value) => String(value ?? "").replaceAll("\\", "/").replace(/^\.\//, "");
const readJsonl = (file) => fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const pct = (value) => value === null || value === undefined ? "n/a" : `${(value * 100).toFixed(1)}%`;

function parseArgs(argv) {
  const options = { corpus: defaultCorpus, input: null, output: null, sourcePrefix: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--corpus") options.corpus = path.resolve(argv[++index]);
    else if (argv[index] === "--input") options.input = path.resolve(argv[++index]);
    else if (argv[index] === "--output") options.output = path.resolve(argv[++index]);
    else if (argv[index] === "--source-prefix") options.sourcePrefix = normalize(argv[++index]).replace(/\/$/, "");
    else if (argv[index] === "--help") options.help = true;
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  return options;
}

function authorityScore(profile) {
  return Number(profile.force?.rank ?? 0) +
    (profile.status === "current" ? 10 : 0) +
    (profile.force?.approved ? 2 : 0) +
    (profile.official_record ? 2 : 0);
}

export function enrichConflicts(questions, profiles, relations) {
  const profileById = new Map(profiles.map((profile) => [profile.source_id, profile]));
  const relationByText = new Map(relations.map((relation) => [
    `${relation.subject} ${relation.kind} ${relation.object}`,
    relation,
  ]));
  return questions.map((question) => {
    const text = (question.required_relations ?? []).find((item) => item.includes(" conflicts_with "));
    const relation = relationByText.get(text);
    if (!relation) return question;
    const endpoints = [profileById.get(relation.subject), profileById.get(relation.object)]
      .filter(Boolean)
      .sort((left, right) => authorityScore(right) - authorityScore(left));
    if (endpoints.length !== 2) return question;
    const evidenceFor = (id) => question.required_evidence.filter((item) => item.document_id === id);
    return {
      ...question,
      conflict_evidence: {
        conflict_id: relation.id,
        resolution: relation.status ?? "unresolved",
        canonical: evidenceFor(endpoints[0].source_id),
        conflicting: evidenceFor(endpoints[1].source_id),
      },
    };
  });
}

function relationRecall(questions, retrieval, sourceById) {
  return Object.fromEntries(ks.map((k) => [String(k), mean(questions.map((question) => {
    const sources = new Set(
      (retrieval.get(question.id) ?? [])
        .slice(0, k)
        .flatMap((item) => item.document.evidence ?? [])
        .map((item) => normalize(item.source)),
    );
    const required = question.required_relations ?? [];
    if (required.length === 0) return 1;
    return required.filter((text) => {
      const parts = text.split(" ");
      return sources.has(sourceById.get(parts[0])) && sources.has(sourceById.get(parts.at(-1)));
    }).length / required.length;
  }))]));
}

function questionRelationRecall(question, retrieved, sourceById, k) {
  const required = question.required_relations ?? [];
  if (required.length === 0) return 1;
  const sources = new Set(
    retrieved.slice(0, k).flatMap((item) => item.document.evidence ?? []).map((item) => normalize(item.source)),
  );
  return required.filter((text) => {
    const parts = text.split(" ");
    return sources.has(sourceById.get(parts[0])) && sources.has(sourceById.get(parts.at(-1)));
  }).length / required.length;
}

function markdown(report) {
  const rows = Object.entries(report.conditions).map(([name, metrics]) =>
    `| ${name} | ${pct(metrics.recall_at_k["5"])} | ${pct(metrics.complete_at_k["5"])} | ${pct(metrics.precision_at_k["5"])} | ${pct(metrics.recall_at_k["10"])} | ${pct(metrics.complete_at_k["10"])} | ${pct(metrics.precision_at_k["10"])} | ${pct(metrics.recall_at_k["20"])} | ${pct(metrics.complete_at_k["20"])} | ${pct(metrics.precision_at_k["20"])} | ${pct(metrics.relation_path_recall_at_k["10"])} | ${pct(metrics.conflict_complete_rate_at_k["10"])} | ${metrics.average_latency_ms.toFixed(1)} ms |`,
  ).join("\n");
  const graphitiNote = Object.keys(report.conditions).some((name) => name.startsWith("graphiti_"))
    ? "\n\n`history`はGraphitiの公開edge hybrid検索をそのまま採点する。`current`は同じ検索結果からGraphitiの`valid_at`、`invalid_at`、`expired_at`を使い、質問時点で有効なFactだけを残す補助条件である。"
    : "";
  return `# 外部検索方式の共通Gold評価

このレポートは外部方式が返した検索Unitを、FragrachのRaw／Actual評価と同じGold照合関数で採点した結果である。文書名だけではなく、取得Unitから遡れる原文sectionとcontent termsが一致した場合だけ正解根拠として数える。

| 条件 | R@5 | C@5 | P@5 | R@10 | C@10 | P@10 | R@20 | C@20 | P@20 | Relation Path@10 | Conflict両側@10 | 平均検索時間 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
${rows}
${graphitiNote}
`;
}

export function scoreExternalRows({ rows, questions, profiles, relations }) {
  const enrichedQuestions = enrichConflicts(questions, profiles, relations);
  const questionIds = new Set(enrichedQuestions.map((question) => question.id));
  const selectedRows = rows.filter((row) => questionIds.has(row.question_id));
  const sourceById = new Map(profiles.map((profile) => [profile.source_id, normalize(profile.relative_path)]));
  const conditions = {};
  const scoredRows = [];
  for (const condition of [...new Set(selectedRows.map((row) => row.condition))].sort()) {
    const conditionRows = selectedRows.filter((row) => row.condition === condition);
    const byQuestion = new Map(conditionRows.map((row) => [
      row.question_id,
      (row.retrieved_units ?? []).map((unit) => ({
        score: unit.score ?? 0,
        document: {
          id: unit.id,
          unit_type: unit.unit_type ?? "external_unit",
          text: unit.retrieval_text ?? unit.text ?? unit.fact ?? "",
          evidence: unit.evidence ?? [],
        },
      })),
    ]));
    const score = scoreRetrieval(enrichedQuestions, byQuestion, ks, { supportsConflictUnits: false });
    conditions[condition] = {
      questions: score.questions,
      recall_at_k: score.recall_at_k,
      complete_at_k: score.complete_at_k,
      precision_at_k: score.precision_at_k,
      relation_path_recall_at_k: relationRecall(enrichedQuestions, byQuestion, sourceById),
      distractor_rate_at_k: score.distractor_rate_at_k,
      conflict_recall_at_k: score.conflict_recall_at_k,
      conflict_complete_rate_at_k: score.conflict_complete_rate_at_k,
      conflict_unit_recall_at_k: score.conflict_unit_recall_at_k,
      resolution_accuracy_at_k: score.resolution_accuracy_at_k,
      resolution_coverage_at_k: score.resolution_coverage_at_k,
      average_latency_ms: mean(conditionRows.map((row) => Number(row.elapsed_ms ?? 0))),
      by_tag: score.by_tag,
    };
    for (const row of conditionRows) {
      const detail = score.questions_detail.find((item) => item.question_id === row.question_id);
      const question = enrichedQuestions.find((item) => item.id === row.question_id);
      const retrieved = byQuestion.get(row.question_id) ?? [];
      scoredRows.push({
        ...row,
        required_evidence: question.required_evidence,
        required_relations: question.required_relations,
        metrics: {
          recall_at_k: detail.recall_at_k,
          complete_at_k: detail.complete_at_k,
          precision_at_k: detail.precision_at_k,
          distractor_rate_at_k: detail.distractor_rate_at_k,
          conflict_recall_at_k: detail.conflict_recall_at_k,
          conflict_complete_at_k: detail.conflict_complete_at_k,
          resolution_accuracy_at_k: detail.resolution_accuracy_at_k,
          relation_path_recall_at_k: Object.fromEntries(
            ks.map((k) => [String(k), questionRelationRecall(question, retrieved, sourceById, k)]),
          ),
        },
      });
    }
  }
  return { conditions, scoredRows };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node score-external-retrieval.mjs --input retrieval.jsonl --output DIR --source-prefix sources/<industry>/<department>/<intent>");
    return;
  }
  if (!options.input || !options.output || !options.sourcePrefix) {
    throw new Error("--input, --output, and --source-prefix are required");
  }
  if (fs.existsSync(options.output)) throw new Error(`output directory already exists: ${options.output}`);
  const parts = options.sourcePrefix.split("/");
  if (parts.length < 4) throw new Error("invalid --source-prefix");
  const [industry, department, intent] = parts.slice(1, 4);
  const questions = readJsonl(path.join(options.corpus, "evaluation/questions.jsonl")).filter((question) =>
    question.industry === industry && question.department === department && question.intent_id === intent
  );
  const profiles = readJsonl(path.join(options.corpus, "gold/profiles.jsonl"));
  const relations = readJsonl(path.join(options.corpus, "gold/relations.jsonl"));
  const rows = readJsonl(options.input);
  const { conditions, scoredRows } = scoreExternalRows({ rows, questions, profiles, relations });
  const report = {
    schema_version: "1.0",
    experiment: "external-retrieval-shared-gold",
    input: options.input,
    source_prefix: options.sourcePrefix,
    questions: questions.length,
    conditions,
  };
  fs.mkdirSync(options.output, { recursive: true });
  fs.writeFileSync(path.join(options.output, "metrics.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(options.output, "retrieval.jsonl"), `${scoredRows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
  fs.writeFileSync(path.join(options.output, "REPORT_ja.md"), markdown(report), "utf8");
  console.log(Object.entries(conditions).map(([name, value]) => `${name}: R@5 ${pct(value.recall_at_k["5"])}, R@10 ${pct(value.recall_at_k["10"])}`).join("\n"));
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) main();
