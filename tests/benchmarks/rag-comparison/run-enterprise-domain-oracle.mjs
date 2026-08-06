#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  Bm25Index,
  buildRawChunks,
  rawProfileOptions,
  scoreRetrieval,
} from "./run-upper-bound.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const scriptRoot = path.dirname(scriptPath);
const repositoryRoot = path.resolve(scriptRoot, "../../..");
const defaultCorpus = path.resolve(scriptRoot, "../../corpora/fragrach-enterprise-ja-diverse");
const defaultOutput = path.resolve(repositoryRoot, "target/benchmarks/enterprise-domain-oracle");
const retrievalKs = [5, 10, 20];

const readJsonl = (file) => fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const pct = (value) => value === null || value === undefined ? "n/a" : `${(value * 100).toFixed(1)}%`;
const normalizeSource = (source) => String(source ?? "").replaceAll("\\", "/").replace(/^\.\//, "");

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function safeGit(args) {
  try {
    return execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function profileText(profile) {
  return [
    "種別: Oracle Document Profile",
    `文書ID: ${profile.source_id}`,
    `業種: ${profile.industry}`,
    `部門: ${profile.department}`,
    `用途: ${profile.purpose}`,
    `文書役割: ${profile.role}`,
    `状態: ${profile.status}`,
    `権威: ${profile.authority}`,
    `拘束力: ${profile.force?.level ?? "unknown"}`,
    `拘束力順位: ${profile.force?.rank ?? "unknown"}`,
    `承認済み: ${profile.force?.approved === true ? "はい" : "いいえ"}`,
    `正式記録: ${profile.official_record === true ? "はい" : "いいえ"}`,
    `有効開始: ${profile.time?.valid_from ?? "不明"}`,
    `有効終了: ${profile.time?.valid_to ?? "なし"}`,
    profile.version ? `版: ${profile.version}` : "",
  ].filter(Boolean).join("\n");
}

function authorityBoost(profile) {
  const rank = Number(profile.force?.rank ?? 0);
  const current = profile.status === "current" ? 0.25 : profile.status === "superseded" || profile.status === "stale" ? -0.15 : 0;
  const approved = profile.force?.approved ? 0.1 : 0;
  const official = profile.official_record ? 0.1 : 0;
  return Math.max(0.5, 1 + rank * 0.025 + current + approved + official);
}

function buildOracleProfileChunks(rawChunks, profiles) {
  const bySource = new Map(profiles.map((profile) => [normalizeSource(profile.relative_path), profile]));
  return rawChunks.map((chunk) => {
    const profile = bySource.get(normalizeSource(chunk.source));
    if (!profile) throw new Error(`profile missing for ${chunk.source}`);
    return {
      ...chunk,
      id: `oracle-profile:${chunk.id}`,
      intent_id: profile.purpose,
      score_boost: authorityBoost(profile),
      valid_from: profile.time?.valid_from ?? null,
      valid_to: profile.time?.valid_to ?? null,
      oracle_source: "gold/profiles.jsonl",
      text: `${profileText(profile)}\n\n原文:\n${chunk.text}`,
    };
  });
}

function attachPurposeToRawChunks(rawChunks, profiles) {
  const bySource = new Map(profiles.map((profile) => [normalizeSource(profile.relative_path), profile.purpose]));
  return rawChunks.map((chunk) => ({
    ...chunk,
    id: `raw-purpose:${chunk.id}`,
    intent_id: bySource.get(normalizeSource(chunk.source)),
  }));
}

const relationLabels = {
  amends: "改訂する",
  applies_to: "適用される",
  approves: "承認する",
  conflicts_with: "矛盾する",
  derived_from: "根拠として導出される",
  evaluates: "評価する",
  exception_to: "例外である",
  implements_decision: "決定を実施する",
  order_of_precedence: "優先順位を定める",
  proposes_change_to: "変更を提案する",
  records_execution_of: "実施を記録する",
  supersedes: "置き換える",
};

function buildOracleDossierChunks(profileChunks, profiles, relations) {
  const profileById = new Map(profiles.map((profile) => [profile.source_id, profile]));
  const chunksBySource = new Map();
  for (const chunk of profileChunks) {
    const source = normalizeSource(chunk.source);
    if (!chunksBySource.has(source)) chunksBySource.set(source, []);
    chunksBySource.get(source).push(chunk);
  }
  const relationUnits = relations.map((relation) => {
    const subject = profileById.get(relation.subject);
    const object = profileById.get(relation.object);
    if (!subject || !object) throw new Error(`relation endpoint missing: ${relation.id}`);
    const endpointChunks = [subject, object].flatMap((profile) => chunksBySource.get(normalizeSource(profile.relative_path)) ?? []);
    const evidence = endpointChunks.flatMap((chunk) => chunk.evidence ?? []);
    const stronger = authorityBoost(subject) >= authorityBoost(object) ? subject : object;
    return {
      id: `oracle-dossier:${relation.id}`,
      unit_type: relation.kind === "conflicts_with" ? "conflict" : "relation",
      intent_id: subject.purpose,
      score_boost: relation.kind === "conflicts_with" ? 1.2 : 1,
      oracle_source: "gold/relations.jsonl+gold/profiles.jsonl",
      evidence,
      text: [
        "種別: Oracle Relation Dossier",
        `関係: ${relation.subject} ${relationLabels[relation.kind] ?? relation.kind} ${relation.object}`,
        `関係種別: ${relation.kind}`,
        relation.status ? `解決状態: ${relation.status}` : "",
        relation.effective_from ? `発効日: ${relation.effective_from}` : "",
        `優先候補: ${stronger.source_id}`,
        profileText(subject),
        profileText(object),
        "原文証拠:",
        ...endpointChunks.map((chunk) => chunk.text),
      ].filter(Boolean).join("\n\n"),
    };
  });
  return [...profileChunks, ...relationUnits];
}

function enrichConflictQuestions(questions, profiles, relations) {
  const profileById = new Map(profiles.map((profile) => [profile.source_id, profile]));
  const relationByTriple = new Map(relations.map((relation) => [`${relation.subject} ${relation.kind} ${relation.object}`, relation]));
  return questions.map((question) => {
    const conflictText = (question.required_relations ?? []).find((value) => value.includes(" conflicts_with "));
    if (!conflictText) return question;
    const relation = relationByTriple.get(conflictText);
    if (!relation) return question;
    const endpoints = [relation.subject, relation.object].map((id) => profileById.get(id)).filter(Boolean);
    if (endpoints.length !== 2) return question;
    endpoints.sort((left, right) => authorityBoost(right) - authorityBoost(left));
    const evidenceFor = (documentId) => (question.required_evidence ?? []).filter((item) => item.document_id === documentId);
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

function retrieve(chunks, questions, profile) {
  const index = new Bm25Index(chunks, profile.index);
  return new Map(questions.map((question) => {
    const query = profile.queryMode === "question-only" ? question.question : `${question.question}\n対象時点: ${question.as_of}`;
    const hasIntent = chunks.some((chunk) => chunk.intent_id);
    return [question.id, index.search(query, Math.max(...retrievalKs), hasIntent ? (document) => document.intent_id === question.intent_id : null)];
  }));
}

function relationPathRecall(questions, retrieval, sourceByDocumentId) {
  return Object.fromEntries(retrievalKs.map((k) => {
    const values = questions.map((question) => {
      const required = question.required_relations ?? [];
      if (required.length === 0) return 1;
      const sources = new Set((retrieval.get(question.id) ?? []).slice(0, k).flatMap((item) => item.document.evidence ?? []).map((item) => normalizeSource(item.source)));
      const matched = required.filter((text) => {
        const parts = text.split(" ");
        const subject = sourceByDocumentId.get(parts[0]);
        const object = sourceByDocumentId.get(parts.at(-1));
        return subject && object && sources.has(subject) && sources.has(object);
      }).length;
      return matched / required.length;
    });
    return [String(k), mean(values)];
  }));
}

function questionRelationPathRecall(question, retrieved, sourceByDocumentId, k) {
  const required = question.required_relations ?? [];
  if (required.length === 0) return 1;
  const sources = new Set(retrieved.slice(0, k).flatMap((item) => item.document.evidence ?? []).map((item) => normalizeSource(item.source)));
  return required.filter((text) => {
    const parts = text.split(" ");
    const subject = sourceByDocumentId.get(parts[0]);
    const object = sourceByDocumentId.get(parts.at(-1));
    return subject && object && sources.has(subject) && sources.has(object);
  }).length / required.length;
}

function compactScore(score, relationRecall) {
  return {
    questions: score.questions,
    conflict_questions: score.conflict_questions,
    recall_at_k: score.recall_at_k,
    complete_at_k: score.complete_at_k,
    precision_at_k: score.precision_at_k,
    relation_path_recall_at_k: relationRecall,
    distractor_rate_at_k: score.distractor_rate_at_k,
    conflict_complete_rate_at_k: score.conflict_complete_rate_at_k,
    conflict_unit_recall_at_k: score.conflict_unit_recall_at_k,
    resolution_accuracy_at_k: score.resolution_accuracy_at_k,
    resolution_coverage_at_k: score.resolution_coverage_at_k,
    by_intent: score.by_intent,
    by_tag: score.by_tag,
  };
}

function serializeRetrieval(domain, condition, questions, retrieval, score, sourceByDocumentId) {
  const detailByQuestion = new Map(score.questions_detail.map((detail) => [detail.question_id, detail]));
  return questions.map((question) => {
    const retrieved = retrieval.get(question.id) ?? [];
    const { retrieved: duplicatedExpandedEvidence, ...questionMetrics } = detailByQuestion.get(question.id);
    return {
      domain_id: domain.domain_id,
      industry: domain.industry,
      department: domain.department,
      condition,
      question_id: question.id,
      intent_id: question.intent_id,
      question: question.question,
      required_evidence: question.required_evidence,
      required_relations: question.required_relations,
      metrics: {
        ...questionMetrics,
        relation_path_recall_at_k: Object.fromEntries(retrievalKs.map((k) => [String(k), questionRelationPathRecall(question, retrieved, sourceByDocumentId, k)])),
      },
      retrieved_units: retrieved.map((item, index) => ({
        rank: index + 1,
        score: item.score,
        id: item.document.id,
        unit_type: item.document.unit_type ?? "document",
        evidence: item.document.evidence ?? [],
        oracle_source: item.document.oracle_source ?? null,
      })),
    };
  });
}

function aggregateRows(domainRows, conditionNames) {
  return Object.fromEntries(conditionNames.map((condition) => {
    const rows = domainRows.map((row) => row.conditions[condition]);
    const averageField = (field) => Object.fromEntries(retrievalKs.map((k) => [String(k), mean(rows.map((row) => row[field][String(k)]).filter((value) => value !== null))]));
    return [condition, {
      questions: rows.reduce((sum, row) => sum + row.questions, 0),
      recall_at_k: averageField("recall_at_k"),
      complete_at_k: averageField("complete_at_k"),
      precision_at_k: averageField("precision_at_k"),
      relation_path_recall_at_k: averageField("relation_path_recall_at_k"),
      distractor_rate_at_k: averageField("distractor_rate_at_k"),
      conflict_complete_rate_at_k: averageField("conflict_complete_rate_at_k"),
      conflict_unit_recall_at_k: averageField("conflict_unit_recall_at_k"),
      resolution_accuracy_at_k: averageField("resolution_accuracy_at_k"),
      resolution_coverage_at_k: averageField("resolution_coverage_at_k"),
    }];
  }));
}

function markdown(report) {
  const labels = { raw_current: "Raw Current", raw_tuned: "Raw Tuned", raw_tuned_purpose: "Raw Tuned + Purpose Filter", oracle_profile: "Oracle Profile Claim", oracle_dossier: "Oracle Relation Dossier" };
  const lines = Object.entries(report.aggregate).map(([name, score]) => `| ${labels[name]} | ${pct(score.recall_at_k["5"])} | ${pct(score.recall_at_k["10"])} | ${pct(score.recall_at_k["20"])} | ${pct(score.relation_path_recall_at_k["10"])} | ${pct(score.conflict_complete_rate_at_k["10"])} | ${pct(score.conflict_unit_recall_at_k["10"])} | ${pct(score.distractor_rate_at_k["10"])} |`);
  const deltas = Object.fromEntries(["oracle_profile", "oracle_dossier"].map((name) => [name, report.aggregate[name].recall_at_k["5"] - report.aggregate.raw_tuned_purpose.recall_at_k["5"]]));
  return `# 企業部門コーパス Oracle検索評価\n\n` +
    `実行ID: \`${report.run_id}\`  \n` +
    `対象: ${report.scope.domains}部門、${report.scope.questions}問、${report.scope.documents}文書  \n` +
    `位置づけ: Gold文書プロフィールとGold文書関係を使った検索上限評価。FragrachのActual精度ではない。\n\n` +
    `| 条件 | R@5 | R@10 | R@20 | Relation Path@10 | Conflict両側@10 | Conflict Unit@10 | 誤誘導率@10 |\n|---|---:|---:|---:|---:|---:|---:|---:|\n${lines.join("\n")}\n\n` +
    `用途フィルタ付きRaw Tuned比のR@5差は、Oracle Profileが ${(deltas.oracle_profile * 100).toFixed(1)}pt、Oracle Dossierが ${(deltas.oracle_dossier * 100).toFixed(1)}pt。\n\n` +
    `## 条件の境界\n\n` +
    `- Rawは原文だけを索引化する。Tunedは固定長1024文字、2-gram BM25である。Purpose Filterは文書パスから既知の利用目的だけを絞る。\n` +
    `- Oracle ProfileはGoldの状態・権威・拘束力・有効期間を原文チャンクへ付加する。\n` +
    `- Oracle DossierはさらにGoldの文書間関係と関係両端の原文を束ねる。\n` +
    `- 質問文、期待回答要素、禁止回答、Gold Evidenceのcontent_termsは索引へ投入していない。\n` +
    `- Goldを用いるため、結果は「コンパイルが完全なら到達可能な上限」であり、実装成果とは区別する。\n\n` +
    `## 保存物\n\n` +
    `同じ実行ディレクトリに manifest.json、metrics.json、retrieval.jsonl、failures.jsonl、command.txt を保存した。retrieval.jsonlには全質問・全条件の順位と根拠を含む。\n`;
}

function parseArgs(argv) {
  const options = { corpus: defaultCorpus, output: defaultOutput, domains: null, runId: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--corpus") options.corpus = path.resolve(argv[++index]);
    else if (argv[index] === "--output") options.output = path.resolve(argv[++index]);
    else if (argv[index] === "--domains") options.domains = new Set(argv[++index].split(",").filter(Boolean));
    else if (argv[index] === "--run-id") options.runId = argv[++index];
    else if (argv[index] === "--help") options.help = true;
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  return options;
}

export function evaluateEnterpriseOracle(corpusRoot, selectedDomainIds = null) {
  const profiles = readJsonl(path.join(corpusRoot, "gold/profiles.jsonl"));
  const relations = readJsonl(path.join(corpusRoot, "gold/relations.jsonl"));
  const allQuestions = enrichConflictQuestions(readJsonl(path.join(corpusRoot, "evaluation/questions.jsonl")), profiles, relations);
  const questionById = new Map(allQuestions.map((question) => [question.id, question]));
  const domains = readJsonl(path.join(corpusRoot, "evaluation/rag-domains.jsonl")).filter((domain) => !selectedDomainIds || selectedDomainIds.has(domain.domain_id));
  const sourceByDocumentId = new Map(profiles.map((profile) => [profile.source_id, normalizeSource(profile.relative_path)]));
  const currentProfile = rawProfileOptions("current");
  const tunedProfile = rawProfileOptions("tuned-sparse-v1");
  const rawCurrentAll = buildRawChunks(corpusRoot, currentProfile.chunking);
  const rawTunedAll = buildRawChunks(corpusRoot, tunedProfile.chunking);
  const domainRows = [];
  const retrievalRows = [];
  const conditionNames = ["raw_current", "raw_tuned", "raw_tuned_purpose", "oracle_profile", "oracle_dossier"];

  for (const domain of domains) {
    const domainProfiles = profiles.filter((profile) => normalizeSource(profile.relative_path).startsWith(domain.source_prefix));
    const documentIds = new Set(domainProfiles.map((profile) => profile.source_id));
    const domainRelations = relations.filter((relation) => documentIds.has(relation.subject) && documentIds.has(relation.object));
    const questions = domain.question_ids.map((id) => questionById.get(id)).filter(Boolean);
    const rawCurrent = rawCurrentAll.filter((chunk) => normalizeSource(chunk.source).startsWith(domain.source_prefix));
    const rawTuned = rawTunedAll.filter((chunk) => normalizeSource(chunk.source).startsWith(domain.source_prefix));
    const rawTunedPurpose = attachPurposeToRawChunks(rawTuned, domainProfiles);
    const oracleProfile = buildOracleProfileChunks(rawTuned, domainProfiles);
    const oracleDossier = buildOracleDossierChunks(oracleProfile, domainProfiles, domainRelations);
    const configurations = {
      raw_current: { chunks: rawCurrent, profile: currentProfile },
      raw_tuned: { chunks: rawTuned, profile: tunedProfile },
      raw_tuned_purpose: { chunks: rawTunedPurpose, profile: tunedProfile },
      oracle_profile: { chunks: oracleProfile, profile: tunedProfile },
      oracle_dossier: { chunks: oracleDossier, profile: tunedProfile },
    };
    const conditions = {};
    for (const [name, configuration] of Object.entries(configurations)) {
      const retrieval = retrieve(configuration.chunks, questions, configuration.profile);
      const score = scoreRetrieval(questions, retrieval, retrievalKs);
      const relationRecall = relationPathRecall(questions, retrieval, sourceByDocumentId);
      conditions[name] = { units: configuration.chunks.length, ...compactScore(score, relationRecall) };
      retrievalRows.push(...serializeRetrieval(domain, name, questions, retrieval, score, sourceByDocumentId));
    }
    domainRows.push({ domain_id: domain.domain_id, industry: domain.industry, department: domain.department, documents: domain.document_count, questions: questions.length, relations: domainRelations.length, conditions });
  }
  return { domains: domainRows, aggregate: aggregateRows(domainRows, conditionNames), retrievalRows };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node run-enterprise-domain-oracle.mjs [--corpus PATH] [--domains id,id] [--output PATH] [--run-id ID]");
    return;
  }
  const startedAt = new Date();
  const runId = options.runId ?? startedAt.toISOString().replace(/[:.]/g, "-");
  const runDirectory = path.join(options.output, runId);
  fs.mkdirSync(runDirectory, { recursive: true });
  const command = `node ${path.relative(repositoryRoot, scriptPath).replaceAll("\\", "/")} ${process.argv.slice(2).join(" ")}`.trim();
  fs.writeFileSync(path.join(runDirectory, "command.txt"), `${command}\n`, "utf8");
  try {
    const result = evaluateEnterpriseOracle(options.corpus, options.domains);
    const completedAt = new Date();
    const report = {
      schema_version: "1.0",
      experiment: "enterprise-department-oracle-retrieval",
      run_id: runId,
      started_at: startedAt.toISOString(),
      completed_at: completedAt.toISOString(),
      duration_ms: completedAt - startedAt,
      status: "completed",
      scope: {
        domains: result.domains.length,
        documents: result.domains.reduce((sum, row) => sum + row.documents, 0),
        questions: result.domains.reduce((sum, row) => sum + row.questions, 0),
        relations: result.domains.reduce((sum, row) => sum + row.relations, 0),
      },
      aggregate: result.aggregate,
      domains: result.domains,
    };
    const inputFiles = ["evaluation/questions.jsonl", "evaluation/rag-domains.jsonl", "gold/profiles.jsonl", "gold/relations.jsonl", "generation/validation-report.json"];
    const manifest = {
      ...report,
      command,
      cwd: repositoryRoot,
      corpus_root: options.corpus,
      selected_domains: options.domains ? [...options.domains] : null,
      retrieval_k: retrievalKs,
      conditions: {
        raw_current: rawProfileOptions("current"),
        raw_tuned: rawProfileOptions("tuned-sparse-v1"),
        raw_tuned_purpose: { ...rawProfileOptions("tuned-sparse-v1"), metadata_filter: "intent_id from source path" },
        oracle_profile: { base: "tuned-sparse-v1", gold_inputs: ["profiles"], answer_gold_indexed: false },
        oracle_dossier: { base: "oracle_profile", gold_inputs: ["relations"], answer_gold_indexed: false },
      },
      runtime: { node: process.version, platform: process.platform, arch: process.arch, cpus: os.cpus().length },
      git: { head: safeGit(["rev-parse", "HEAD"]), branch: safeGit(["branch", "--show-current"]), dirty: Boolean(safeGit(["status", "--porcelain"])) },
      inputs: Object.fromEntries(inputFiles.map((relative) => [relative, { sha256: sha256File(path.join(options.corpus, relative)), bytes: fs.statSync(path.join(options.corpus, relative)).size }])),
      evaluator: { path: path.relative(repositoryRoot, scriptPath).replaceAll("\\", "/"), sha256: sha256File(scriptPath) },
    };
    const failures = result.retrievalRows
      .filter((row) => row.metrics.recall_at_k["10"] < 1 || row.metrics.relation_path_recall_at_k["10"] < 1)
      .map((row) => ({
        domain_id: row.domain_id,
        condition: row.condition,
        question_id: row.question_id,
        intent_id: row.intent_id,
        recall_at_10: row.metrics.recall_at_k["10"],
        relation_path_recall_at_10: row.metrics.relation_path_recall_at_k["10"],
        retrieved_unit_ids: row.retrieved_units.slice(0, 10).map((unit) => unit.id),
        retrieval_record_key: `${row.domain_id}/${row.condition}/${row.question_id}`,
      }));
    fs.writeFileSync(path.join(runDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    fs.writeFileSync(path.join(runDirectory, "metrics.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    fs.writeFileSync(path.join(runDirectory, "retrieval.jsonl"), `${result.retrievalRows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
    fs.writeFileSync(path.join(runDirectory, "failures.jsonl"), failures.length ? `${failures.map((row) => JSON.stringify(row)).join("\n")}\n` : "", "utf8");
    fs.writeFileSync(path.join(runDirectory, "REPORT_ja.md"), markdown(report), "utf8");
    fs.writeFileSync(path.join(runDirectory, "stdout.log"), `Run ${runId}; domains ${report.scope.domains}; questions ${report.scope.questions}; Raw tuned+purpose R@5 ${pct(report.aggregate.raw_tuned_purpose.recall_at_k["5"])}; Oracle profile R@5 ${pct(report.aggregate.oracle_profile.recall_at_k["5"])}; Oracle dossier R@5 ${pct(report.aggregate.oracle_dossier.recall_at_k["5"])}\n`, "utf8");
    fs.writeFileSync(path.join(options.output, "latest-run.txt"), `${runId}\n`, "utf8");
    console.log(`Run ${runId}; domains ${report.scope.domains}; questions ${report.scope.questions}; Raw tuned+purpose R@5 ${pct(report.aggregate.raw_tuned_purpose.recall_at_k["5"])}; Oracle profile R@5 ${pct(report.aggregate.oracle_profile.recall_at_k["5"])}; Oracle dossier R@5 ${pct(report.aggregate.oracle_dossier.recall_at_k["5"])}`);
  } catch (error) {
    const failedAt = new Date();
    fs.writeFileSync(path.join(runDirectory, "error.json"), `${JSON.stringify({ run_id: runId, status: "failed", started_at: startedAt.toISOString(), failed_at: failedAt.toISOString(), duration_ms: failedAt - startedAt, command, error: { name: error.name, message: error.message, stack: error.stack } }, null, 2)}\n`, "utf8");
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) main();
