#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildActualChunks } from "./run-upper-bound.mjs";
import {
  DenseIndex,
  documentVectors,
  embedCollection,
  embeddingProfiles,
} from "./run-hybrid-tuning.mjs";
import { scoreExternalRows } from "./score-external-retrieval.mjs";

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const defaultCorpus = path.resolve(scriptRoot, "../../corpora/fragrach-enterprise-ja-longform");
const defaultOutput = path.resolve(scriptRoot, "../../../target/benchmarks/longform-actual-dense");
const defaultCache = path.resolve(scriptRoot, "../../../target/benchmarks/embedding-cache");
const readJsonl = (file) => fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const pct = (value) => value == null ? "n/a" : `${(value * 100).toFixed(1)}%`;

function retrievalUnit(item, rank, additions = {}) {
  return {
    id: item.document.id,
    unit_type: item.document.unit_type ?? "compiled_unit",
    rank,
    score: item.score,
    text: item.document.text,
    retrieval_text: item.document.text,
    evidence: item.document.evidence ?? [],
    source: item.document.source ?? null,
    section: item.document.section ?? null,
    ...additions,
  };
}

export function compiledSourceId(document) {
  const parts = String(document.id).split("/");
  return parts.length >= 3 && document.id.startsWith("actual:evidence:") ? parts.at(-2) : null;
}

export function compactRelationHeader(document) {
  const seen = new Set();
  const evidence = (document.evidence ?? []).filter((item) => {
    const key = `${item.source}#${item.section}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    ...document,
    text: [
      "種別: Compiled Document Relation",
      `関係: ${document.relation?.kind ?? "relation"}`,
      `Source: ${document.relation?.source_id ?? ""}`,
      `Target: ${document.relation?.target_id ?? ""}`,
      ...evidence.map((item) => [
        `原文位置: ${item.section ?? "本文"}`,
        `要点: ${String(item.text ?? "").slice(0, 180)}`,
      ].join("\n")),
    ].join("\n"),
  };
}

export function evidencePriority(document) {
  const section = String(document.evidence?.[0]?.section ?? document.section ?? "");
  const text = String(document.evidence?.[0]?.text ?? document.text ?? "");
  if (/反映していない|食い違|矛盾/.test(text)) return 0.26;
  if (/現行規則/.test(section)) return 0.24;
  if (/全面的に置き換|適用.*終了/.test(text)) return 0.18;
  if (/更新状況/.test(section)) return 0.16;
  if (/適用期間|旧案内|承認規則/.test(section)) return 0.10;
  if (/決定|承認対象/.test(section)) return 0.06;
  if (/目的|背景|全体像|注意|ガイド/.test(section)) return -0.08;
  return 0;
}

function parseArgs(argv) {
  const options = {
    corpus: defaultCorpus,
    output: defaultOutput,
    build: null,
    domain: null,
    intent: null,
    endpoint: "http://127.0.0.1:11434",
    batchSize: 16,
    embeddingCache: defaultCache,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--corpus") options.corpus = path.resolve(argv[++index]);
    else if (argument === "--output") options.output = path.resolve(argv[++index]);
    else if (argument === "--build") options.build = path.resolve(argv[++index]);
    else if (argument === "--domain") options.domain = argv[++index];
    else if (argument === "--intent") options.intent = argv[++index];
    else if (argument === "--endpoint") options.endpoint = argv[++index];
    else if (argument === "--batch-size") options.batchSize = Number(argv[++index]);
    else if (argument === "--embedding-cache") options.embeddingCache = path.resolve(argv[++index]);
    else if (argument === "--help") options.help = true;
    else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

function markdown(report) {
  const rows = Object.entries(report.metrics.conditions).map(([condition, value]) =>
    `| ${condition} | ${value.units} | ${pct(value.recall_at_k["5"])} | ${pct(value.complete_at_k["5"])} | ${pct(value.precision_at_k["5"])} | ${pct(value.recall_at_k["10"])} | ${pct(value.complete_at_k["10"])} | ${pct(value.precision_at_k["10"])} | ${pct(value.recall_at_k["20"])} | ${pct(value.complete_at_k["20"])} | ${pct(value.precision_at_k["20"])} | ${pct(value.relation_path_recall_at_k["10"])} | ${pct(value.conflict_complete_rate_at_k["10"])} |`,
  ).join("\n");
  return `# 長文Fragrach Dense検索アブレーション\n\n` +
    `同じKnowledge BuildのCompiled UnitへRuri Dense検索を適用した。cosine類似度へcompile済みauthority boostを乗じ、上位20件を共通Gold採点器で評価する。\n\n` +
    `| 条件 | Unit | R@5 | C@5 | P@5 | R@10 | C@10 | P@10 | R@20 | C@20 | P@20 | Relation Path@10 | Conflict両側@10 |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n${rows}\n`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node run-longform-actual-dense.mjs --build PATH --domain ID --intent ID [--corpus PATH] [--output DIR]");
    return;
  }
  if (!options.build || !options.domain || !options.intent) throw new Error("--build, --domain and --intent are required");
  if (fs.existsSync(options.output)) throw new Error(`output already exists: ${options.output}`);
  const domains = readJsonl(path.join(options.corpus, "evaluation/rag-domains.jsonl"));
  const domain = domains.find((item) => item.domain_id === options.domain);
  if (!domain) throw new Error(`unknown domain: ${options.domain}`);
  const questions = readJsonl(path.join(options.corpus, "evaluation/questions.jsonl")).filter((question) =>
    question.industry === domain.industry && question.department === domain.department && question.intent_id === options.intent,
  );
  const profiles = readJsonl(path.join(options.corpus, "gold/profiles.jsonl"));
  const relations = readJsonl(path.join(options.corpus, "gold/relations.jsonl"));
  const configurations = {
    "fragrach-claim-ruri-dense": buildActualChunks([options.build], { authorityBoost: true }),
    "fragrach-dossier-ruri-dense": buildActualChunks([options.build], { authorityBoost: true, includeRelationDossiers: true }),
    "fragrach-claim-evidence-ruri-dense": buildActualChunks([options.build], { authorityBoost: true, evidenceFallback: true, includeDiagnosticAliases: true }),
    "fragrach-evidence-only-ruri-dense": buildActualChunks([options.build], { authorityBoost: false, evidenceFallback: true, includeClaims: false, includeConflicts: false, includeDiagnosticAliases: true }),
  };
  const layeredEvidence = buildActualChunks([options.build], {
    authorityBoost: true,
    evidenceFallback: true,
    includeClaims: false,
    includeConflicts: false,
    includeDiagnosticAliases: true,
  });
  const layeredEnrichedEvidence = configurations["fragrach-claim-evidence-ruri-dense"]
    .filter((chunk) => chunk.unit_type === "claim_evidence");
  const relationHeaders = configurations["fragrach-dossier-ruri-dense"]
    .filter((chunk) => chunk.id.startsWith("actual:relation-dossier:"))
    .map(compactRelationHeader);
  const profile = embeddingProfiles.ruri;
  const queryVectors = await embedCollection(questions.map((question) => profile.query(question.question)), {
    endpoint: options.endpoint,
    batchSize: options.batchSize,
    model: profile.model,
    label: "long-form Actual questions",
  });
  const rows = [];
  const embeddings = {};
  for (const [condition, chunks] of Object.entries(configurations)) {
    const stored = await documentVectors(chunks, condition, profile, {
      endpoint: options.endpoint,
      batchSize: options.batchSize,
      cacheDirectory: options.embeddingCache,
    });
    embeddings[condition] = stored.manifest;
    const index = new DenseIndex(chunks, stored.values, stored.manifest.dimensions);
    questions.forEach((question, questionIndex) => {
      const started = performance.now();
      const retrieved = index.search(
        queryVectors[questionIndex],
        chunks.length,
        (document) => !document.intent_id || document.intent_id === question.intent_id,
      ).map((item) => ({ ...item, score: item.score * Number(item.document.score_boost ?? 1) }))
        .sort((left, right) => right.score - left.score || left.document.id.localeCompare(right.document.id, "ja"))
        .slice(0, 20);
      rows.push({
        condition,
        question_id: question.id,
        question: question.question,
        elapsed_ms: performance.now() - started,
        retrieved_units: retrieved.map((item, indexValue) => retrievalUnit(item, indexValue + 1)),
      });
    });
  }
  const layeredCondition = "fragrach-layered-dossier-ruri-dense";
  const layeredEvidenceStored = await documentVectors(layeredEvidence, `${layeredCondition}-evidence`, profile, {
    endpoint: options.endpoint,
    batchSize: options.batchSize,
    cacheDirectory: options.embeddingCache,
  });
  const layeredEnrichedStored = await documentVectors(layeredEnrichedEvidence, `${layeredCondition}-enriched-evidence`, profile, {
    endpoint: options.endpoint,
    batchSize: options.batchSize,
    cacheDirectory: options.embeddingCache,
  });
  const relationStored = await documentVectors(relationHeaders, `${layeredCondition}-relations`, profile, {
    endpoint: options.endpoint,
    batchSize: options.batchSize,
    cacheDirectory: options.embeddingCache,
  });
  embeddings[layeredCondition] = {
    evidence: layeredEvidenceStored.manifest,
    enriched_evidence: layeredEnrichedStored.manifest,
    relations: relationStored.manifest,
  };
  const layeredEvidenceIndex = new DenseIndex(
    layeredEvidence,
    layeredEvidenceStored.values,
    layeredEvidenceStored.manifest.dimensions,
  );
  const relationIndex = new DenseIndex(
    relationHeaders,
    relationStored.values,
    relationStored.manifest.dimensions,
  );
  const layeredEnrichedIndex = new DenseIndex(
    layeredEnrichedEvidence,
    layeredEnrichedStored.values,
    layeredEnrichedStored.manifest.dimensions,
  );
  questions.forEach((question, questionIndex) => {
    const started = performance.now();
    const evidenceResults = layeredEvidenceIndex.search(
      queryVectors[questionIndex],
      layeredEvidence.length,
      (document) => !document.intent_id || document.intent_id === question.intent_id,
    ).map((item) => ({ ...item, score: item.score * Number(item.document.score_boost ?? 1) }));
    const enrichedResults = layeredEnrichedIndex.search(
      queryVectors[questionIndex],
      layeredEnrichedEvidence.length,
      (document) => !document.intent_id || document.intent_id === question.intent_id,
    ).map((item) => ({ ...item, score: item.score * Number(item.document.score_boost ?? 1) }))
      .sort((left, right) => right.score - left.score || left.document.id.localeCompare(right.document.id, "ja"));
    const relationResults = relationIndex.search(
      queryVectors[questionIndex],
      relationHeaders.length,
      (document) => !document.intent_id || document.intent_id === question.intent_id,
    ).slice(0, 2);
    const compactById = new Map(layeredEvidence.map((document) => [document.id, document]));
    const candidates = new Map();
    for (const [rank, item] of evidenceResults.entries()) {
      candidates.set(item.document.id, {
        score: 0.55 / (60 + rank + 1),
        document: item.document,
        semanticScore: item.score,
        relationExpansion: [],
      });
    }
    for (const [rank, item] of enrichedResults.entries()) {
      const compact = compactById.get(item.document.id);
      if (!compact) continue;
      const current = candidates.get(item.document.id) ?? {
        score: 0,
        document: compact,
        semanticScore: item.score,
        relationExpansion: [],
      };
      current.score += 0.45 / (60 + rank + 1);
      current.semanticScore = Math.max(current.semanticScore, item.score);
      candidates.set(item.document.id, current);
    }
    if (/食い違|矛盾|競合|どちら.*優先/.test(question.question)) {
      for (const candidate of candidates.values()) {
        candidate.score += Math.max(0, evidencePriority(candidate.document)) * 0.02;
      }
    }
    for (const [relationRank, relationResult] of relationResults.entries()) {
      const relation = relationResult.document.relation;
      for (const endpoint of [relation?.source_id, relation?.target_id].filter(Boolean)) {
        const endpointEvidence = [...candidates.values()]
          .filter((item) => compiledSourceId(item.document) === endpoint)
          .sort((left, right) =>
            (right.semanticScore + evidencePriority(right.document)) -
              (left.semanticScore + evidencePriority(left.document)) ||
            left.document.id.localeCompare(right.document.id, "ja"),
          )[0];
        if (!endpointEvidence) continue;
        endpointEvidence.score += relationRank === 0 ? 0.010 : 0.006;
        endpointEvidence.relationExpansion.push({
          relation_id: relationResult.document.relation_id,
          kind: relation.kind,
          endpoint,
        });
      }
    }
    const retrieved = [...candidates.values()]
      .sort((left, right) => right.score - left.score || left.document.id.localeCompare(right.document.id, "ja"))
      .slice(0, 20);
    rows.push({
      condition: layeredCondition,
      question_id: question.id,
      question: question.question,
      elapsed_ms: performance.now() - started,
      retrieved_units: retrieved.map((item, indexValue) => retrievalUnit(item, indexValue + 1, {
        relation_expansion: item.relationExpansion,
      })),
    });
  });
  const scored = scoreExternalRows({ rows, questions, profiles, relations });
  for (const [condition, value] of Object.entries(scored.conditions)) {
    if (configurations[condition]) value.units = configurations[condition].length;
  }
  scored.conditions[layeredCondition].units = layeredEvidence.length + relationHeaders.length;
  const report = {
    schema_version: "1.0",
    experiment: "longform-actual-ruri-dense",
    generated_at: new Date().toISOString(),
    corpus: options.corpus,
    build: options.build,
    domain_id: options.domain,
    intent_id: options.intent,
    questions: questions.length,
    model: profile.model,
    authority_rerank: "cosine * compiled score_boost",
    embeddings,
    metrics: { conditions: scored.conditions },
  };
  fs.mkdirSync(options.output, { recursive: true });
  fs.writeFileSync(path.join(options.output, "retrieval.jsonl"), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
  fs.writeFileSync(path.join(options.output, "metrics.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(options.output, "REPORT_ja.md"), markdown(report), "utf8");
  console.log(markdown(report));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
