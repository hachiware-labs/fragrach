#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DenseIndex, documentVectors, embedCollection, embeddingProfiles } from "./run-hybrid-tuning.mjs";
import { factCoverage } from "./prepare-multihop-rag.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../../..");
const root = path.join(repositoryRoot, "target/benchmarks/enterprise-rag-bench");
const output = path.join(root, "ruri-coverage-dossiers-v1");
const readJsonl = (file) => fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map(JSON.parse);
if (fs.existsSync(output)) throw new Error(`output already exists: ${output}`);

function tokens(text) {
  return new Set(text.toLowerCase().match(/[a-z0-9][a-z0-9_.:/-]*/g) ?? []);
}

function lexicalScore(queryTokens, passageTokens) {
  let score = 0;
  for (const token of queryTokens) {
    if (!passageTokens.has(token)) continue;
    score += /\d/.test(token) ? 4 : token.length >= 12 ? 3 : token.length >= 7 ? 2 : 1;
  }
  return score;
}

function splitWindows(text, width = 900, overlap = 150) {
  const paragraphs = text.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
  const windows = [];
  for (const paragraph of paragraphs) {
    if (paragraph.length <= width) {
      windows.push(paragraph);
      continue;
    }
    const step = width - overlap;
    for (let start = 0; start < paragraph.length; start += step) {
      const value = paragraph.slice(start, start + width).trim();
      if (value) windows.push(value);
      if (start + width >= paragraph.length) break;
    }
  }
  return windows.length > 0 ? windows : [text.slice(0, width)];
}

function evidenceMetrics(questions, dossiers) {
  const verified = questions.filter((question) => question.gold_status === "verified" && question.gold_evidence.units.length > 0);
  const rows = verified.map((question) => {
    const sourceTexts = dossiers.get(question.id).source_texts;
    const hits = question.gold_evidence.units.filter((unit) => factCoverage(unit.fact, sourceTexts[unit.source] ?? "") >= 0.5).length;
    return { recall: hits / question.gold_evidence.units.length, complete: hits === question.gold_evidence.units.length };
  });
  return {
    questions: rows.length,
    evidence_unit_recall: rows.reduce((sum, row) => sum + row.recall, 0) / (rows.length || 1),
    evidence_ceiling: rows.filter((row) => row.complete).length / (rows.length || 1),
  };
}

const questions = readJsonl(path.join(root, "prepared-v3/questions.jsonl"))
  .filter((question) => question.split === "development" || question.split === "diagnostic");
const questionById = new Map(questions.map((question) => [question.id, question]));
const obligationsById = new Map(readJsonl(path.join(root, "query-obligations-v1.jsonl")).map((row) => [row.question_id, row]));
const retrievalRows = readJsonl(path.join(root, "query-dossiers-v2/retrieval.jsonl"));
const retrievalById = new Map(retrievalRows.map((row) => [row.question_id, row.results.slice(0, 10)]));

const sourceById = new Map();
for (const row of retrievalRows) {
  for (const result of row.results.slice(0, 10)) sourceById.set(result.doc_id, result);
}
const spans = [];
const spansBySource = new Map();
for (const source of [...sourceById.values()].sort((left, right) => left.doc_id.localeCompare(right.doc_id))) {
  const values = splitWindows(source.content ?? "");
  const rows = values.map((text, index) => ({
    id: `${source.doc_id}:span:${index}`, source: source.doc_id, source_rank: null,
    index, title: source.title, text, embedding_text: `${source.title}\n\n${text}`.slice(0, 700),
    passage_tokens: tokens(`${source.title}\n${text}`),
  }));
  spans.push(...rows);
  spansBySource.set(source.doc_id, rows);
}
const spanById = new Map(spans.map((span) => [span.id, span]));

const profile = embeddingProfiles.ruri;
const stored = await documentVectors(spans.map((span) => ({ id: span.id, text: span.embedding_text })), "enterprise-rag-bench-ruri-top10-spans-v1", profile, {
  cacheDirectory: path.join(repositoryRoot, "target/benchmarks/embedding-cache"),
  endpoint: "http://127.0.0.1:11434", batchSize: 16, truncate: true,
});
const dense = new DenseIndex(spans, stored.values, stored.manifest.dimensions);
const queryTexts = [];
const queryIndex = new Map();
function registerQuery(text) {
  if (!queryIndex.has(text)) {
    queryIndex.set(text, queryTexts.length);
    queryTexts.push(text);
  }
}
for (const question of questions) {
  registerQuery(question.question);
  for (const obligation of obligationsById.get(question.id).obligations) registerQuery(obligation);
}
const queryVectors = await embedCollection(queryTexts.map((text) => profile.query(text)), {
  endpoint: "http://127.0.0.1:11434", model: profile.model, batchSize: 16,
  truncate: true, label: "Enterprise obligation and question queries",
});

function rankSpans(query, allowedSources, sparseWeight) {
  const allowed = new Set(allowedSources);
  const count = allowedSources.reduce((sum, source) => sum + (spansBySource.get(source)?.length ?? 0), 0);
  const queryVector = queryVectors[queryIndex.get(query)];
  const denseRows = dense.search(queryVector, count, (span) => allowed.has(span.source));
  const queryTokens = tokens(query);
  const sparseRows = spans.filter((span) => allowed.has(span.source))
    .map((span) => ({ span, score: lexicalScore(queryTokens, span.passage_tokens) }))
    .sort((left, right) => right.score - left.score || left.span.id.localeCompare(right.span.id));
  const scores = new Map();
  denseRows.forEach((row, index) => scores.set(row.document.id, (1 - sparseWeight) / (20 + index + 1)));
  sparseRows.forEach((row, index) => scores.set(row.span.id, (scores.get(row.span.id) ?? 0) + sparseWeight / (20 + index + 1)));
  return [...scores].map(([id, score]) => ({ span: spanById.get(id), score }))
    .sort((left, right) => right.score - left.score || left.span.id.localeCompare(right.span.id));
}

const rankCache = new Map();
function cachedRank(query, sources, sparseWeight) {
  const key = `${sparseWeight}\0${query}\0${sources.join("\0")}`;
  if (!rankCache.has(key)) rankCache.set(key, rankSpans(query, sources, sparseWeight));
  return rankCache.get(key);
}

function compile(question, config) {
  const compiled = obligationsById.get(question.id);
  const results = retrievalById.get(question.id);
  const sourceRanks = new Map(results.map((row, index) => [row.doc_id, index + 1]));
  const sources = results.map((row) => row.doc_id);
  const selected = new Map(sources.map((source) => [source, new Set()]));
  const reasons = new Map();
  function retain(span, reason) {
    const sourceSpans = spansBySource.get(span.source);
    for (let index = Math.max(0, span.index - config.neighborRadius); index <= Math.min(sourceSpans.length - 1, span.index + config.neighborRadius); index += 1) {
      selected.get(span.source).add(index);
      const key = `${span.source}:${index}`;
      if (!reasons.has(key)) reasons.set(key, new Set());
      reasons.get(key).add(reason);
    }
  }
  const baseline = cachedRank(question.question, sources, config.sparseWeight);
  for (const source of sources) {
    const sourceRows = baseline.filter((row) => row.span.source === source).slice(0, config.baselinePerSource);
    for (const row of sourceRows) retain(row.span, "question");
  }
  compiled.obligations.forEach((obligation, obligationIndex) => {
    const ranked = cachedRank(obligation, sources, config.sparseWeight);
    const bySource = new Map();
    for (const row of ranked) {
      if (!bySource.has(row.span.source)) bySource.set(row.span.source, []);
      bySource.get(row.span.source).push(row);
    }
    const sourceOrder = [...bySource].sort((left, right) => right[1][0].score - left[1][0].score || sourceRanks.get(left[0]) - sourceRanks.get(right[0]));
    const sourceLimit = compiled.mode === "conflict" ? Math.max(2, config.sourcesPerObligation) : config.sourcesPerObligation;
    for (const [, rows] of sourceOrder.slice(0, sourceLimit)) {
      for (const row of rows.slice(0, config.windowsPerSource)) retain(row.span, `obligation:${obligationIndex}`);
    }
  });
  const sourceTexts = {};
  const sections = [];
  const selectedPositions = [];
  for (const result of results) {
    const sourceSpans = spansBySource.get(result.doc_id);
    const indices = [...selected.get(result.doc_id)].sort((left, right) => left - right);
    const excerpt = indices.map((index) => sourceSpans[index].text).join("\n\n[… position break …]\n\n");
    sourceTexts[result.doc_id] = `${result.title}\n\n${excerpt}`;
    sections.push(`SOURCE ${result.doc_id}\nTITLE: ${result.title}\n${excerpt}`);
    selectedPositions.push(...indices.map((index) => ({ source: result.doc_id, window: index, reasons: [...(reasons.get(`${result.doc_id}:${index}`) ?? [])].sort() })));
  }
  return {
    id: `enterprise-ruri-coverage-dossier:${question.id}`, mode: compiled.mode,
    obligations: compiled.obligations, sources, source_texts: sourceTexts,
    selected_positions: selectedPositions, text: sections.join("\n\n---\n\n"),
  };
}

const configurations = [];
for (const sparseWeight of [0, 0.25, 0.5, 0.75]) {
  configurations.push({ name: `sw${sparseWeight}-b1-s1-w1-n1`, sparseWeight, baselinePerSource: 1, sourcesPerObligation: 1, windowsPerSource: 1, neighborRadius: 1 });
  configurations.push({ name: `sw${sparseWeight}-b1-s1-w2-n1`, sparseWeight, baselinePerSource: 1, sourcesPerObligation: 1, windowsPerSource: 2, neighborRadius: 1 });
  configurations.push({ name: `sw${sparseWeight}-b1-s2-w2-n1`, sparseWeight, baselinePerSource: 1, sourcesPerObligation: 2, windowsPerSource: 2, neighborRadius: 1 });
  configurations.push({ name: `sw${sparseWeight}-b2-s1-w2-n1`, sparseWeight, baselinePerSource: 2, sourcesPerObligation: 1, windowsPerSource: 2, neighborRadius: 1 });
}
const development = questions.filter((question) => question.split === "development");
const diagnostic = questions.filter((question) => question.split === "diagnostic");
const candidates = new Map();
const matrix = {};
for (const config of configurations) {
  const dossiers = new Map(questions.map((question) => [question.id, compile(question, config)]));
  candidates.set(config.name, dossiers);
  matrix[config.name] = {
    development: evidenceMetrics(development, dossiers), diagnostic: evidenceMetrics(diagnostic, dossiers),
    mean_dossier_characters: [...dossiers.values()].reduce((sum, dossier) => sum + dossier.text.length, 0) / dossiers.size,
    mean_selected_positions: [...dossiers.values()].reduce((sum, dossier) => sum + dossier.selected_positions.length, 0) / dossiers.size,
  };
}
const selected = configurations.map((config) => config.name).sort((left, right) =>
  matrix[right].development.evidence_ceiling - matrix[left].development.evidence_ceiling
  || matrix[right].development.evidence_unit_recall - matrix[left].development.evidence_unit_recall
  || matrix[left].mean_dossier_characters - matrix[right].mean_dossier_characters
  || left.localeCompare(right)
)[0];
const dossiers = candidates.get(selected);
const rows = questions.map((question) => ({
  condition: "fragrach-enterprise-ruri-obligation-coverage-dossier-v1",
  question_id: question.id, split: question.split, category: question.category,
  results: [dossiers.get(question.id)],
}));
const report = {
  schema_version: "1.0", experiment: "enterprise-rag-bench-ruri-obligation-coverage-dossier",
  leakage_contract: "Question, Luna obligations, frozen BM25 top-10 source text, and Ruri span embeddings only. Gold answers, facts, and source IDs are excluded from selection.",
  embedding: stored.manifest, span_contract: "900-character source windows with 150-character overlap; at most 700 characters plus title enter Ruri, while the original window enters the answer dossier.",
  selection_contract: "Each top-10 source keeps question-ranked baseline windows. Each obligation keeps its best source/window candidates and neighbors. Configuration is selected by development Evidence Ceiling, then recall, then context size.",
  selected_configuration: selected, candidate_matrix: matrix,
};
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, "retrieval.jsonl"), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
fs.writeFileSync(path.join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
