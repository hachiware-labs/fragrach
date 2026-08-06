#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  completeEvidenceAtK,
  loadDynamicValidityPack,
  normalizeSource,
  recallAtK,
} from "./dynamic-validity-score.mjs";
import { composeDecisionPacketResults } from "./run-dynamic-validity-fcompile-retrieval.mjs";
import { DenseIndex, documentVectors, embedCollection, embeddingProfiles } from "./run-hybrid-tuning.mjs";
import { buildActualChunks } from "./run-upper-bound.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../../..");

function readJsonl(file) {
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function parseArguments(argv) {
  const defaultBuildRoot = path.resolve(
    repositoryRoot, "target/benchmarks/dynamic-validity-scale-decision-packet-v2",
  );
  const options = {
    corpus: path.resolve(scriptDirectory, "../../corpora/aobane-industries-ja-dynamic-validity-scale"),
    chunks: path.resolve(repositoryRoot, "target/benchmarks/dynamic-validity-token-chunk-pilot-v1/ruri-512.jsonl"),
    builds: [1, 2, 3, 4].map((index) => path.join(defaultBuildRoot, `knowledge-build-${index}`)),
    output: path.resolve(repositoryRoot, "target/benchmarks/dynamic-validity-metadata-slide-pilot-v1"),
    cache: path.resolve(repositoryRoot, "target/benchmarks/dynamic-validity-token-chunk-pilot-v1/retrieval/embedding-cache"),
    endpoint: "http://127.0.0.1:11434",
    batchSize: 16,
    anchorK: 5,
    packetBudget: 3,
    topK: 5,
    splits: ["development"],
    conditions: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--corpus") options.corpus = path.resolve(argv[++index]);
    else if (argument === "--chunks") options.chunks = path.resolve(argv[++index]);
    else if (argument === "--build") {
      if (!options.buildsOverridden) options.builds = [];
      options.buildsOverridden = true;
      options.builds.push(path.resolve(argv[++index]));
    } else if (argument === "--output") options.output = path.resolve(argv[++index]);
    else if (argument === "--cache") options.cache = path.resolve(argv[++index]);
    else if (argument === "--endpoint") options.endpoint = argv[++index];
    else if (argument === "--batch-size") options.batchSize = Number(argv[++index]);
    else if (argument === "--anchor-k") options.anchorK = Number(argv[++index]);
    else if (argument === "--packet-budget") options.packetBudget = Number(argv[++index]);
    else if (argument === "--top-k") options.topK = Number(argv[++index]);
    else if (argument === "--splits") options.splits = argv[++index].split(",").filter(Boolean);
    else if (argument === "--condition") options.conditions.push(argv[++index]);
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

function documentIdentityKey(documentId, revision) {
  if (!documentId || revision === null || revision === undefined || revision === "") return null;
  return `${documentId}\0${revision}`;
}

export function sourceIdentity(units, profiles = []) {
  const sourceById = new Map();
  const idBySource = new Map();
  for (const unit of units) {
    for (const evidence of unit.evidence ?? []) {
      const source = normalizeSource(evidence.source);
      if (!source || !evidence.source_id) continue;
      sourceById.set(evidence.source_id, source);
      idBySource.set(source, evidence.source_id);
    }
  }
  const idByDocument = new Map();
  for (const profile of profiles) {
    const key = documentIdentityKey(profile.document_id, profile.revision);
    if (key && profile.source_id) idByDocument.set(key, profile.source_id);
  }
  return { sourceById, idBySource, idByDocument, knownSourceIds: new Set(sourceById.keys()) };
}

export function resolveChunkSourceId(chunk, identity) {
  if (chunk.source_id && identity.knownSourceIds.has(chunk.source_id)) return chunk.source_id;
  const key = documentIdentityKey(chunk.document_id, chunk.revision);
  if (key && identity.idByDocument.has(key)) return identity.idByDocument.get(key);
  return identity.idBySource.get(normalizeSource(chunk.source)) ?? null;
}

export function loadProfiles(builds) {
  return builds.flatMap((build) => readJsonl(path.join(build, "document-profiles.jsonl")));
}

function relationDescription(relation, sourceId, profileById) {
  const label = (id) => {
    const profile = profileById.get(id);
    return profile ? `${profile.document_id} revision ${profile.revision}` : id;
  };
  const verifier = relation.verifier_source_ids ?? [];
  if (relation.source_id === sourceId) {
    return `${relation.position}: この文書 → ${label(relation.target_id)}; 確認=${verifier.map(label).join(", ") || "なし"}`;
  }
  if (relation.target_id === sourceId) {
    return `${relation.position}: ${label(relation.source_id)} → この文書; 確認=${verifier.map(label).join(", ") || "なし"}`;
  }
  if (verifier.includes(sourceId)) {
    return `verifier: ${label(relation.source_id)} ${relation.position} ${label(relation.target_id)}`;
  }
  return null;
}

export function buildPositionHeaders(profiles, packetDocuments) {
  const profileById = new Map(profiles.map((profile) => [profile.source_id, profile]));
  const relations = packetDocuments.map((document) => document.relation).filter(Boolean);
  return new Map(profiles.map((profile) => {
    const lines = [
      "文書管理Position Header",
      `文書ID: ${profile.document_id}`,
      `版: ${profile.revision}`,
      `役割: ${profile.role}`,
      `承認: ${profile.force?.approved === true ? "approved" : "not-approved"}`,
      `権威順位: ${profile.force?.authority_rank ?? "未指定"}`,
      `正本: ${profile.official_record === true ? "yes" : "no"}`,
      `有効期間: ${profile.time?.valid_from ?? "未指定"} ～ ${profile.time?.valid_to ?? "未指定"}`,
      `適用範囲: ${JSON.stringify(profile.scope ?? {})}`,
    ];
    const positions = relations
      .map((relation) => relationDescription(relation, profile.source_id, profileById))
      .filter(Boolean);
    if (positions.length > 0) lines.push(...positions.map((position) => `位置づけ: ${position}`));
    return [profile.source_id, lines.join("\n")];
  }));
}

export function retrievalDocuments(chunks, identity, headers, withHeader) {
  return chunks.map((chunk) => {
    const source = normalizeSource(chunk.source);
    const sourceId = resolveChunkSourceId(chunk, identity);
    const header = sourceId ? headers.get(sourceId) : null;
    const text = withHeader && header ? `${header}\n\n${chunk.text}` : chunk.text;
    return {
      ...chunk,
      id: `${withHeader ? "position-header" : "document-anchor"}:${chunk.id}`,
      unit_type: "raw_document_chunk",
      source_id: sourceId,
      text,
      evidence: [{
        source_id: sourceId,
        document_id: chunk.document_id ?? null,
        revision: chunk.revision ?? null,
        source,
        section: chunk.section,
        text: chunk.text,
      }],
    };
  });
}

function summarize(questions, retrieval, k) {
  const recalls = questions.map((question) => recallAtK(question, "T1", retrieval.get(question.id), k));
  const complete = questions.map((question) => completeEvidenceAtK(question, "T1", retrieval.get(question.id), k));
  return {
    questions: questions.length,
    recall_at_k: recalls.reduce((sum, value) => sum + value, 0) / questions.length,
    evidence_ceiling_at_k: complete.filter(Boolean).length / questions.length,
    complete_evidence_questions: complete.filter(Boolean).length,
  };
}

export function resultRowFromRanked(item, rank) {
  const evidence = item.document.evidence?.[0] ?? {};
  return {
    rank,
    source: normalizeSource(evidence.source ?? item.document.source),
    sources: [normalizeSource(evidence.source ?? item.document.source)],
    section: evidence.section ?? item.document.section,
    text: item.document.text,
    score: item.score,
    chunk_id: item.document.id,
  };
}

function serializeRows(questions, condition, anchors, expanded) {
  return questions.map((question) => ({
    condition,
    question_id: question.id,
    stage: "T1",
    split: question.split,
    anchor_results: anchors.get(question.id).slice(0, 10).map((item, index) => resultRowFromRanked(item, index + 1)),
    results: expanded.get(question.id),
  }));
}

export function diversifyBySource(ranked) {
  const seen = new Set();
  return ranked.filter((item) => {
    const evidence = item.document.evidence?.[0] ?? {};
    const source = normalizeSource(evidence.source ?? item.document.source);
    if (!source || seen.has(source)) return false;
    seen.add(source);
    return true;
  });
}

async function evaluateCondition(name, documents, packetDocuments, questions, queryVectors, options, condition = {}) {
  const profile = embeddingProfiles.ruri;
  const stored = await documentVectors(documents, condition.embeddingProfileName ?? name, profile, {
    endpoint: options.endpoint,
    batchSize: options.batchSize,
    cacheDirectory: options.cache,
    ollamaOptions: { num_ctx: 8192, num_batch: 32768 },
  });
  const index = new DenseIndex(documents, stored.values, stored.manifest.dimensions);
  const anchors = new Map();
  const expanded = new Map();
  questions.forEach((question, questionIndex) => {
    let ranked = index.search(
      queryVectors[questionIndex],
      Math.min(condition.candidateK ?? 100, documents.length),
    )
      .map((item, indexValue) => ({ ...item, rank: indexValue + 1 }));
    if (condition.diversifySources) {
      ranked = diversifyBySource(ranked).map((item, indexValue) => ({ ...item, rank: indexValue + 1 }));
    }
    anchors.set(question.id, ranked);
    expanded.set(question.id, composeDecisionPacketResults(
      ranked, packetDocuments, options.topK,
      { anchorK: options.anchorK, packetBudget: options.packetBudget },
    ));
  });
  const anchorRetrieval = new Map([...anchors].map(([questionId, ranked]) => [
    questionId, ranked.map((item, index) => resultRowFromRanked(item, index + 1)),
  ]));
  const metricsFor = (selectedQuestions) => {
    const selectedPacketCounts = selectedQuestions.map((question) =>
      (expanded.get(question.id) ?? [])
        .filter((result) => result.compiled_unit_type === "relation_dossier").length
    );
    return {
      anchor_at_5: summarize(selectedQuestions, anchorRetrieval, 5),
      anchor_at_10: summarize(selectedQuestions, anchorRetrieval, 10),
      packet_at_5: summarize(selectedQuestions, expanded, 5),
      packet_activation_rate: selectedPacketCounts.filter((count) => count > 0).length
        / selectedQuestions.length,
      packet_rank_1_rate: selectedQuestions.filter((question) =>
        expanded.get(question.id)?.[0]?.compiled_unit_type === "relation_dossier"
      ).length / selectedQuestions.length,
      mean_packets_in_top_5: selectedPacketCounts.reduce((sum, count) => sum + count, 0)
        / selectedQuestions.length,
    };
  };
  return {
    embedding: stored.manifest,
    metrics: metricsFor(questions),
    metricsBySplit: Object.fromEntries([...new Set(questions.map((question) => question.split))]
      .map((split) => [split, metricsFor(questions.filter((question) => question.split === split))])),
    rows: serializeRows(questions, name, anchors, expanded),
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node run-dynamic-validity-metadata-slide-pilot.mjs [--chunks FILE] [--output DIR]");
    return;
  }
  if (fs.existsSync(options.output)) throw new Error(`output already exists: ${options.output}`);
  fs.mkdirSync(options.output, { recursive: true });
  const pack = loadDynamicValidityPack(options.corpus);
  const questions = pack.questions.filter((question) => options.splits.includes(question.split));
  if (questions.length === 0) throw new Error(`no questions found for splits: ${options.splits.join(",")}`);
  const chunks = readJsonl(options.chunks);
  const units = buildActualChunks(options.builds, {
    authorityBoost: true,
    evidenceFallback: true,
    includeDiagnosticAliases: true,
    includeRelationDossiers: true,
  });
  const packetDocuments = units.filter((unit) => unit.unit_type === "relation_dossier");
  const profiles = loadProfiles(options.builds);
  const identity = sourceIdentity(units, profiles);
  const headers = buildPositionHeaders(profiles, packetDocuments);
  const profile = embeddingProfiles.ruri;
  const queryVectors = await embedCollection(
    questions.map((question) => profile.query(`${question.question}\n対象時点: ${question.stages.T1.as_of}`)),
    {
      endpoint: options.endpoint,
      batchSize: options.batchSize,
      model: profile.model,
      label: "Ruri metadata slide development questions",
      ollamaOptions: { num_ctx: 8192, num_batch: 32768 },
    },
  );
  const conditions = {};
  let experimentConditions = [
    { name: "document-anchor", withHeader: false },
    { name: "chunk-position-header", withHeader: true },
    {
      name: "chunk-position-header-source-diverse",
      withHeader: true,
      embeddingProfileName: "chunk-position-header",
      diversifySources: true,
      candidateK: 1000,
    },
  ];
  if (options.conditions.length > 0) {
    experimentConditions = experimentConditions.filter((condition) =>
      options.conditions.includes(condition.name)
    );
    if (experimentConditions.length !== options.conditions.length) {
      throw new Error(`unknown or duplicate condition: ${options.conditions.join(",")}`);
    }
  }
  for (const condition of experimentConditions) {
    const { name, withHeader } = condition;
    const documents = retrievalDocuments(chunks, identity, headers, withHeader);
    const result = await evaluateCondition(
      name, documents, packetDocuments, questions, queryVectors, options, condition,
    );
    conditions[name] = {
      embedding: result.embedding,
      metrics: result.metrics,
      metrics_by_split: result.metricsBySplit,
    };
    fs.writeFileSync(
      path.join(options.output, `retrieval-${name}.jsonl`),
      `${result.rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
      "utf8",
    );
  }
  const annotatedSources = new Set(chunks
    .filter((chunk) => resolveChunkSourceId(chunk, identity))
    .map((chunk) => normalizeSource(chunk.source)));
  const report = {
    schema_version: "1.0",
    experiment: "dynamic-validity-document-metadata-slid-to-chunk-search-surface",
    question_contract: `T1 ${options.splits.join("+")} ${questions.length} questions only`,
    fixed: ["512/64 Ruri-token chunks", "compiled Build", "Decision Packets", "Ruri", "query", "top-k"],
    changed: "Position metadata is either document-side only or mechanically projected as a compact header on each chunk",
    diagnostic: "chunk-position-header-source-diverse reuses the same header embeddings and collapses candidate chunks to one anchor per source document",
    compilation: "No LLM recompilation; existing document profiles and operational_position relations are reused",
    chunks: chunks.length,
    annotated_documents: annotatedSources.size,
    packet_documents: packetDocuments.length,
    conditions,
    holdout_status: "non-evaluated splits reserved and untouched",
    evaluated_splits: options.splits,
  };
  fs.writeFileSync(path.join(options.output, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
