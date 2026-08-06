#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Bm25Index } from "./run-upper-bound.mjs";
import {
  DenseIndex,
  documentVectors,
  embedCollection,
  embeddingProfiles,
  weightedReciprocalRankFusion,
} from "./run-hybrid-tuning.mjs";
import { scoreExternalRows } from "./score-external-retrieval.mjs";

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const defaultCorpus = path.resolve(scriptRoot, "../../corpora/fragrach-enterprise-ja-longform");
const defaultOutput = path.resolve(scriptRoot, "../../../target/benchmarks/longform-raw-comparison");
const defaultEmbeddingCache = path.resolve(scriptRoot, "../../../target/benchmarks/embedding-cache");
const readJsonl = (file) => fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const pct = (value) => value == null ? "n/a" : `${(value * 100).toFixed(1)}%`;
const normalizeSource = (value) => String(value ?? "").replaceAll("\\", "/").replace(/^\.\//, "");

function positionBucket(value) {
  if (value < 1 / 3) return "start";
  if (value < 2 / 3) return "middle";
  return "end";
}

export function evidenceTargets(questions, chunks) {
  const chunksBySource = new Map();
  for (const chunk of chunks) {
    const source = normalizeSource(chunk.source);
    if (!chunksBySource.has(source)) chunksBySource.set(source, []);
    chunksBySource.get(source).push(chunk);
  }
  return new Map(questions.map((question) => [question.id, (question.required_evidence ?? []).map((evidence) => {
    const source = normalizeSource(evidence.source);
    const sourceChunks = chunksBySource.get(source) ?? [];
    const exact = sourceChunks.filter((chunk) => chunk.section === evidence.section);
    const candidates = exact.length > 0 ? exact : sourceChunks;
    const relativePosition = candidates.length === 0
      ? null
      : candidates.reduce((sum, chunk) => sum + Number(chunk.relative_position ?? 0.5), 0) / candidates.length;
    return {
      source,
      section: evidence.section,
      position: relativePosition == null ? null : positionBucket(relativePosition),
    };
  })]));
}

function unitMatchesTarget(unit, target) {
  const sources = new Set((unit.evidence ?? []).map((item) => normalizeSource(item.source)));
  if (!sources.has(target.source)) return false;
  return !target.section || !unit.section || unit.section === target.section;
}

export function diagnostics(rows, targetsByQuestion, ks = [5, 10, 20]) {
  const conditions = [...new Set(rows.map((row) => row.condition))];
  return Object.fromEntries(conditions.map((condition) => {
    const conditionRows = rows.filter((row) => row.condition === condition);
    const atK = Object.fromEntries(ks.map((k) => {
      const positions = Object.fromEntries(["start", "middle", "end"].map((position) => [position, { hit: 0, total: 0 }]));
      let evidenceHits = 0;
      let contextTokens = 0;
      for (const row of conditionRows) {
        const units = row.retrieved_units.slice(0, k);
        contextTokens += units.reduce((sum, unit) => sum + Number(unit.token_count ?? 0), 0);
        for (const target of targetsByQuestion.get(row.question_id) ?? []) {
          const hit = units.some((unit) => unitMatchesTarget(unit, target));
          if (hit) evidenceHits += 1;
          if (target.position) {
            positions[target.position].total += 1;
            if (hit) positions[target.position].hit += 1;
          }
        }
      }
      return [String(k), {
        average_context_tokens: conditionRows.length === 0 ? 0 : contextTokens / conditionRows.length,
        evidence_hits_per_1000_tokens: contextTokens === 0 ? 0 : evidenceHits * 1000 / contextTokens,
        gold_position_recall: Object.fromEntries(Object.entries(positions).map(([position, value]) => [
          position,
          value.total === 0 ? null : value.hit / value.total,
        ])),
      }];
    }));
    return [condition, atK];
  }));
}

function parseArgs(argv) {
  const options = {
    corpus: defaultCorpus,
    chunks: null,
    output: defaultOutput,
    endpoint: "http://127.0.0.1:11434",
    batchSize: 16,
    candidateK: 100,
    sparseWeights: [0.85, 0.9],
    tokenBudgets: [1500, 2500, 4000],
    scope: "purpose",
    domains: null,
    embeddingCache: defaultEmbeddingCache,
    ollamaOptions: { num_ctx: 8192, num_batch: 32768 },
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--corpus") options.corpus = path.resolve(argv[++index]);
    else if (argument === "--chunks") options.chunks = path.resolve(argv[++index]);
    else if (argument === "--output") options.output = path.resolve(argv[++index]);
    else if (argument === "--endpoint") options.endpoint = argv[++index];
    else if (argument === "--batch-size") options.batchSize = Number(argv[++index]);
    else if (argument === "--candidate-k") options.candidateK = Number(argv[++index]);
    else if (argument === "--sparse-weights") options.sparseWeights = argv[++index].split(",").map(Number);
    else if (argument === "--token-budgets") options.tokenBudgets = argv[++index].split(",").map(Number);
    else if (argument === "--scope") options.scope = argv[++index];
    else if (argument === "--domains") options.domains = new Set(argv[++index].split(",").filter(Boolean));
    else if (argument === "--embedding-cache") options.embeddingCache = path.resolve(argv[++index]);
    else if (argument === "--help") options.help = true;
    else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

const questionDomain = (question) => `${question.industry}-${question.department}`;
const questionScope = (question, scope) => scope === "purpose"
  ? `${questionDomain(question)}::${question.intent_id}`
  : questionDomain(question);
const chunkScope = (chunk, scope) => scope === "purpose"
  ? `${chunk.domain_id}::${chunk.purpose}`
  : chunk.domain_id;

function externalRows(condition, questions, retrieval, elapsedMs) {
  return questions.map((question) => ({
    condition,
    question_id: question.id,
    question: question.question,
    elapsed_ms: elapsedMs.get(question.id) ?? 0,
    retrieved_units: (retrieval.get(question.id) ?? []).slice(0, 20).map((item, index) => ({
      id: item.document.id,
      unit_type: "canonical_raw_chunk",
      rank: index + 1,
      score: item.score,
      text: item.document.text,
      retrieval_text: item.document.text,
      evidence: item.document.evidence,
      token_count: item.document.token_count,
      relative_position: item.document.relative_position,
      source: item.document.source,
      section: item.document.section,
    })),
  }));
}

export function truncateForBudget(rows, budget) {
  return rows.map((row) => {
    let used = 0;
    const units = [];
    for (const unit of row.retrieved_units) {
      const tokens = Number(unit.token_count ?? 0);
      if (units.length > 0 && used + tokens > budget) break;
      units.push(unit);
      used += tokens;
    }
    return { ...row, retrieved_units: units, context_tokens: used, token_budget: budget };
  });
}

function relationRows(metrics) {
  return Object.entries(metrics.conditions).map(([condition, value]) => ({ condition, ...value }));
}

export function scoreRowsByDomain({ rows, questions, domains, profiles, relations }) {
  return Object.fromEntries(domains.map((domain) => {
    const domainId = typeof domain === "string" ? domain : domain.domain_id;
    const domainQuestions = questions.filter((question) => questionDomain(question) === domainId);
    const questionIds = new Set(domainQuestions.map((question) => question.id));
    const domainRows = rows.filter((row) => questionIds.has(row.question_id));
    return [domainId, scoreExternalRows({
      rows: domainRows,
      questions: domainQuestions,
      profiles,
      relations,
    }).conditions];
  }));
}

function markdown(report) {
  const rows = relationRows(report.metrics).map((row) =>
    `| ${row.condition} | ${pct(row.recall_at_k["5"])} | ${pct(row.complete_at_k["5"])} | ${pct(row.precision_at_k["5"])} | ${pct(row.recall_at_k["10"])} | ${pct(row.complete_at_k["10"])} | ${pct(row.precision_at_k["10"])} | ${pct(row.recall_at_k["20"])} | ${pct(row.complete_at_k["20"])} | ${pct(row.precision_at_k["20"])} | ${pct(row.relation_path_recall_at_k["10"])} | ${pct(row.conflict_complete_rate_at_k["10"])} | ${row.average_latency_ms.toFixed(1)} ms |`,
  ).join("\n");
  const budgets = Object.entries(report.token_budget_metrics).flatMap(([budget, conditions]) =>
    Object.entries(conditions).map(([condition, value]) =>
      `| ${budget} | ${condition} | ${pct(value.recall_at_k["20"])} | ${pct(value.relation_path_recall_at_k["20"])} | ${pct(value.conflict_complete_rate_at_k["20"])} | ${report.token_budget_diagnostics[budget][condition]["20"].average_context_tokens.toFixed(0)} | ${report.token_budget_diagnostics[budget][condition]["20"].evidence_hits_per_1000_tokens.toFixed(2)} |`,
    )).join("\n");
  const positions = Object.entries(report.retrieval_diagnostics).map(([condition, values]) =>
    `| ${condition} | ${pct(values["10"].gold_position_recall.start)} | ${pct(values["10"].gold_position_recall.middle)} | ${pct(values["10"].gold_position_recall.end)} | ${values["10"].evidence_hits_per_1000_tokens.toFixed(2)} |`,
  ).join("\n");
  const domainRows = Object.entries(report.metrics_by_domain).flatMap(([domain, conditions]) =>
    Object.entries(conditions).map(([condition, value]) =>
      `| ${domain} | ${condition} | ${pct(value.recall_at_k["5"])} | ${pct(value.recall_at_k["10"])} | ${pct(value.recall_at_k["20"])} | ${pct(value.relation_path_recall_at_k["10"])} | ${pct(value.conflict_complete_rate_at_k["10"])} |`,
    ),
  ).join("\n");
  return `# 長文Raw検索比較\n\n` +
    `共通token chunkを部門ごとの独立索引へ投入し、BM25、Ruri Dense、重み付きRRF Hybridを同じGoldで比較した。\n\n` +
    `| 条件 | R@5 | C@5 | P@5 | R@10 | C@10 | P@10 | R@20 | C@20 | P@20 | Relation Path@10 | Conflict両側@10 | 平均時間 |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n${rows}\n\n` +
    `## 固定context budget\n\nR@budgetはbudget内へ入った全chunkをR@20欄として採点した値である。\n\n` +
    `| tokens | 条件 | 根拠再現 | Relation Path | Conflict両側 | 実使用tokens | 根拠/1k tokens |\n|---:|---|---:|---:|---:|---:|---:|\n${budgets}\n\n` +
    `## Gold位置別診断（@10）\n\n| 条件 | 前半 | 中盤 | 後半 | 根拠/1k tokens |\n|---|---:|---:|---:|---:|\n${positions}\n\n` +
    `## 部門別\n\n| 部門RAG | 条件 | R@5 | R@10 | R@20 | Relation Path@10 | Conflict両側@10 |\n|---|---|---:|---:|---:|---:|---:|\n${domainRows}\n`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node run-longform-raw-comparison.mjs --chunks FILE [--scope purpose|department] [--domains id,id] [--corpus PATH] [--output DIR]");
    return;
  }
  if (!options.chunks) throw new Error("--chunks is required");
  if (!["purpose", "department"].includes(options.scope)) throw new Error("--scope must be purpose or department");
  if (fs.existsSync(options.output)) throw new Error(`output already exists: ${options.output}`);
  fs.mkdirSync(options.output, { recursive: true });
  const chunks = readJsonl(options.chunks).filter((chunk) => !options.domains || options.domains.has(chunk.domain_id));
  const questions = readJsonl(path.join(options.corpus, "evaluation/questions.jsonl"))
    .filter((question) => !options.domains || options.domains.has(questionDomain(question)));
  const profiles = readJsonl(path.join(options.corpus, "gold/profiles.jsonl"));
  const relations = readJsonl(path.join(options.corpus, "gold/relations.jsonl"));
  const domains = [...new Set(questions.map(questionDomain))];
  const scopes = [...new Set(questions.map((question) => questionScope(question, options.scope)))];
  const chunksByScope = new Map(scopes.map((scope) => [scope, chunks.filter((chunk) => chunkScope(chunk, options.scope) === scope)]));
  for (const scope of scopes) if (chunksByScope.get(scope).length === 0) throw new Error(`no chunks for ${scope}`);

  const sparseIndexes = new Map(scopes.map((scope) => [scope, new Bm25Index(chunksByScope.get(scope), {
    ngramSizes: [2], k1: 1.8, b: 0.75,
  })]));
  const sparse = new Map();
  const sparseElapsed = new Map();
  for (const question of questions) {
    const started = performance.now();
    sparse.set(question.id, sparseIndexes.get(questionScope(question, options.scope)).search(question.question, options.candidateK));
    sparseElapsed.set(question.id, performance.now() - started);
  }

  const profile = embeddingProfiles.ruri;
  const cacheDirectory = options.embeddingCache;
  const stored = await documentVectors(chunks, `ruri-${path.basename(options.chunks)}`, profile, {
    endpoint: options.endpoint,
    batchSize: options.batchSize,
    cacheDirectory,
    ollamaOptions: options.ollamaOptions,
  });
  const queryVectors = await embedCollection(questions.map((question) => profile.query(question.question)), {
    endpoint: options.endpoint,
    batchSize: options.batchSize,
    model: profile.model,
    label: "ruri long-form questions",
    ollamaOptions: options.ollamaOptions,
  });
  const denseIndex = new DenseIndex(chunks, stored.values, stored.manifest.dimensions);
  const dense = new Map();
  const denseElapsed = new Map();
  questions.forEach((question, index) => {
    const started = performance.now();
    const scope = questionScope(question, options.scope);
    dense.set(question.id, denseIndex.search(queryVectors[index], options.candidateK, (document) => chunkScope(document, options.scope) === scope));
    denseElapsed.set(question.id, performance.now() - started);
  });

  const retrievals = new Map([
    ["raw-bm25", { retrieval: sparse, elapsed: sparseElapsed }],
    ["ruri-dense", { retrieval: dense, elapsed: denseElapsed }],
  ]);
  for (const weight of options.sparseWeights) {
    const retrieval = new Map();
    const elapsed = new Map();
    for (const question of questions) {
      const started = performance.now();
      retrieval.set(question.id, weightedReciprocalRankFusion(
        sparse.get(question.id), dense.get(question.id), weight, options.candidateK,
      ));
      elapsed.set(question.id, performance.now() - started + sparseElapsed.get(question.id) + denseElapsed.get(question.id));
    }
    retrievals.set(`ruri-hybrid-sparse-${weight.toFixed(2)}`, { retrieval, elapsed });
  }
  const rows = [...retrievals].flatMap(([condition, value]) => externalRows(condition, questions, value.retrieval, value.elapsed));
  const targetsByQuestion = evidenceTargets(questions, chunks);
  const scored = scoreExternalRows({ rows, questions, profiles, relations });
  const metricsByDomain = scoreRowsByDomain({ rows, questions, domains, profiles, relations });
  const tokenBudgetMetrics = {};
  const tokenBudgetMetricsByDomain = {};
  const tokenBudgetDiagnostics = {};
  for (const budget of options.tokenBudgets) {
    const budgetRows = truncateForBudget(rows, budget);
    tokenBudgetMetrics[String(budget)] = scoreExternalRows({ rows: budgetRows, questions, profiles, relations }).conditions;
    tokenBudgetMetricsByDomain[String(budget)] = scoreRowsByDomain({
      rows: budgetRows,
      questions,
      domains,
      profiles,
      relations,
    });
    tokenBudgetDiagnostics[String(budget)] = diagnostics(budgetRows, targetsByQuestion, [20]);
  }
  const report = {
    schema_version: "1.0",
    experiment: "longform-raw-canonical-chunks",
    generated_at: new Date().toISOString(),
    corpus: options.corpus,
    chunks: options.chunks,
    chunk_count: chunks.length,
    document_count: new Set(chunks.map((chunk) => chunk.source)).size,
    questions: questions.length,
    domains,
    retrieval_scope: options.scope,
    embedding: stored.manifest,
    embedding_cache: cacheDirectory,
    metrics: { conditions: scored.conditions },
    metrics_by_domain: metricsByDomain,
    retrieval_diagnostics: diagnostics(rows, targetsByQuestion),
    token_budget_metrics: tokenBudgetMetrics,
    token_budget_metrics_by_domain: tokenBudgetMetricsByDomain,
    token_budget_diagnostics: tokenBudgetDiagnostics,
  };
  fs.writeFileSync(path.join(options.output, "retrieval.jsonl"), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
  fs.writeFileSync(path.join(options.output, "metrics.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(options.output, "REPORT_ja.md"), markdown(report), "utf8");
  console.log(markdown(report));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
