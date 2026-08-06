#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  Bm25Index,
  buildActualChunks,
  buildRawChunks,
  rawProfileOptions,
  scoreCompileCoverage,
  scoreRetrieval,
} from "./run-upper-bound.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const scriptRoot = path.dirname(scriptPath);
const repositoryRoot = path.resolve(scriptRoot, "../../..");
const defaultCorpus = path.resolve(scriptRoot, "../../corpora/fragrach-enterprise-ja-diverse");
const defaultOutput = path.resolve(repositoryRoot, "target/benchmarks/enterprise-actual-retrieval");
const ks = [5, 10, 20];
const normalize = (value) => String(value ?? "").replaceAll("\\", "/").replace(/^\.\//, "");
const readJsonl = (file) => fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const sha256File = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const pct = (value) => value === null || value === undefined ? "n/a" : `${(value * 100).toFixed(1)}%`;

function authorityScore(profile) {
  return Number(profile.force?.rank ?? 0) + (profile.status === "current" ? 10 : 0) + (profile.force?.approved ? 2 : 0) + (profile.official_record ? 2 : 0);
}

function enrichConflicts(questions, profiles, relations) {
  const profileById = new Map(profiles.map((profile) => [profile.source_id, profile]));
  const relationByText = new Map(relations.map((relation) => [`${relation.subject} ${relation.kind} ${relation.object}`, relation]));
  return questions.map((question) => {
    const text = (question.required_relations ?? []).find((item) => item.includes(" conflicts_with "));
    const relation = relationByText.get(text);
    if (!relation) return question;
    const endpoints = [profileById.get(relation.subject), profileById.get(relation.object)].filter(Boolean).sort((left, right) => authorityScore(right) - authorityScore(left));
    const evidenceFor = (id) => question.required_evidence.filter((item) => item.document_id === id);
    return { ...question, conflict_evidence: { conflict_id: relation.id, resolution: relation.status, canonical: evidenceFor(endpoints[0].source_id), conflicting: evidenceFor(endpoints[1].source_id) } };
  });
}

function retrieve(chunks, questions, profile) {
  const index = new Bm25Index(chunks, profile.index);
  return new Map(questions.map((question) => [question.id, index.search(question.question, Math.max(...ks), chunks.some((chunk) => chunk.intent_id) ? (document) => document.intent_id === question.intent_id : null)]));
}

export function selectCanonicalRawChunks(chunks, domainId, intent) {
  const department = chunks
    .filter((chunk) => chunk.domain_id === domainId)
    .map((chunk) => ({ ...chunk, intent_id: intent }));
  return {
    department,
    purpose: department.filter((chunk) => chunk.purpose === intent),
  };
}

function relationRecall(questions, retrieval, sourceById) {
  return Object.fromEntries(ks.map((k) => [String(k), mean(questions.map((question) => {
    const sources = new Set((retrieval.get(question.id) ?? []).slice(0, k).flatMap((item) => item.document.evidence ?? []).map((item) => normalize(item.source)));
    const required = question.required_relations ?? [];
    return required.length === 0 ? 1 : required.filter((text) => {
      const parts = text.split(" ");
      return sources.has(sourceById.get(parts[0])) && sources.has(sourceById.get(parts.at(-1)));
    }).length / required.length;
  }))]));
}

function compact(score, relationPath, coverage) {
  return {
    units: coverage.documents,
    compile_coverage: coverage.compile_coverage,
    questions: score.questions,
    recall_at_k: score.recall_at_k,
    complete_at_k: score.complete_at_k,
    precision_at_k: score.precision_at_k,
    relation_path_recall_at_k: relationPath,
    distractor_rate_at_k: score.distractor_rate_at_k,
    conflict_complete_rate_at_k: score.conflict_complete_rate_at_k,
    conflict_unit_recall_at_k: score.conflict_unit_recall_at_k,
    resolution_accuracy_at_k: score.resolution_accuracy_at_k,
    resolution_coverage_at_k: score.resolution_coverage_at_k,
  };
}

function parseArgs(argv) {
  const options = { corpus: defaultCorpus, output: defaultOutput, build: null, domain: null, intent: null, runId: null, canonicalChunks: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--corpus") options.corpus = path.resolve(argv[++index]);
    else if (argv[index] === "--output") options.output = path.resolve(argv[++index]);
    else if (argv[index] === "--build") options.build = path.resolve(argv[++index]);
    else if (argv[index] === "--domain") options.domain = argv[++index];
    else if (argv[index] === "--intent") options.intent = argv[++index];
    else if (argv[index] === "--run-id") options.runId = argv[++index];
    else if (argv[index] === "--canonical-chunks") options.canonicalChunks = path.resolve(argv[++index]);
    else if (argv[index] === "--help") options.help = true;
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  return options;
}

function markdownBase(report) {
  const labels = { raw_tuned: "Raw Tuned", raw_tuned_purpose: "Raw Tuned + Purpose", actual_claim: "Actual Claim", actual_relation_dossier: "Actual Claim + Decision Packet", actual_claim_evidence: "Actual Claim + Evidence", actual_evidence_only: "Actual Evidence only" };
  const rows = Object.entries(report.conditions).map(([name, value]) => `| ${labels[name]} | ${value.units} | ${pct(value.compile_coverage)} | ${pct(value.recall_at_k["5"])} | ${pct(value.recall_at_k["10"])} | ${pct(value.relation_path_recall_at_k["10"])} | ${pct(value.conflict_complete_rate_at_k["10"])} | ${pct(value.conflict_unit_recall_at_k["10"])} |`).join("\n");
  const detailRows = report.question_comparisons.map((item) => {
    const metric = (condition, name, k) => item.conditions[condition]?.[name]?.[String(k)];
    return `| ${item.question_id} | ${item.kind} | ${pct(metric("raw_tuned", "recall_at_k", 5))} | ${pct(metric("raw_tuned_purpose", "recall_at_k", 5))} | ${pct(metric("actual_claim", "recall_at_k", 5))} | ${pct(metric("actual_relation_dossier", "recall_at_k", 5))} | ${pct(metric("actual_relation_dossier", "recall_at_k", 10))} | ${pct(metric("actual_relation_dossier", "conflict_unit_recall_at_k", 10))} |`;
  }).join("\n");
  const raw = report.conditions.raw_tuned;
  const purpose = report.conditions.raw_tuned_purpose;
  const dossier = report.conditions.actual_relation_dossier;
  const delta = (left, right, k) => ((left.recall_at_k[String(k)] - right.recall_at_k[String(k)]) * 100).toFixed(1);
  const metrics = report.build_manifest.metrics;
  return `# 企業部門コーパス Actual検索評価\n\nこのレポートは、調整済みのRaw RAGとActual Fragrach Buildを同じ部門・質問・BM25設定で比較する。Decision PacketとRaw Tuned + Purposeの差は、R@5で${delta(dossier, purpose, 5)}ポイント、R@10で${delta(dossier, purpose, 10)}ポイントである。一方、6問の小規模評価であり、回答生成品質はこの検索評価だけでは判断しない。\n\n実行ID: \`${report.run_id}\`  \n対象: ${report.domain_id} / ${report.intent_id}、${report.questions}問  \nBuild状態: ${report.build_manifest.status}\n\n## 比較条件\n\nRaw Tunedは部門内の全用途を含む${raw.units} Unitを検索する。Raw Tuned + Purposeは質問の利用目的が既知という前提で${purpose.units} Unitへ絞るため、Raw側の強い基準である。Actual Claimはコンパイル済みClaim、Actual Claim + Decision PacketはClaimに文書関係と両側原文を追加する。Actual Claim + Evidenceは全Evidenceを混在させる。Actual条件にはGold Profile、Gold Relation、質問文、期待回答を投入していない。\n\n## 全体結果\n\n| 条件 | Unit | Compile coverage | R@5 | R@10 | Relation Path@10 | Conflict両側@10 | Conflict Unit@10 |\n|---|---:|---:|---:|---:|---:|---:|---:|\n${rows}\n\nDecision PacketとRaw TunedのR@5差は${delta(dossier, raw, 5)}ポイント、Raw Tuned + Purposeとの差は${delta(dossier, purpose, 5)}ポイントである。ClaimだけではRaw Tuned + Purposeを下回る。全Evidenceを常時混ぜる条件もDecision Packetを下回るため、Evidence fallbackは不足時だけ使う設計を次の比較対象とする。\n\n## 質問別結果\n\n| 質問ID | 種別 | Raw Tuned R@5 | Raw + Purpose R@5 | Actual Claim R@5 | Decision Packet R@5 | Decision Packet R@10 | Conflict Unit@10 |\n|---|---|---:|---:|---:|---:|---:|---:|\n${detailRows}\n\n質問別の取得Unitとスコアは\`retrieval.jsonl\`に全件保存している。表のConflict Unitは、矛盾を一つの検索Unitとして取得できた割合である。RawにはConflict Unitが存在しないためn/aとなる。\n\n## Buildと実行条件\n\nBuildは${metrics.source_documents}文書、${metrics.evidence_units} Evidence、${metrics.claims} Claim、${metrics.document_profiles ?? 0} Profile、${metrics.document_relations ?? 0} Relation、${metrics.decision_packets ?? metrics.relation_dossiers ?? 0} Decision Packetを含む。Conflictは${metrics.conflicts}件で、未解決は${metrics.unresolved_conflicts}件である。Providerは\`${report.build_manifest.provider}\`、モデルは\`${report.build_manifest.model}\`、Build IDは\`${report.build_manifest.build_id}\`である。\n\nこのディレクトリの\`manifest.json\`には入力と評価器のSHA-256、\`metrics.json\`には集計値、\`retrieval.jsonl\`には質問別の全順位、\`command.txt\`には再実行コマンドを保存している。\n`;
}

function markdown(report) {
  const raw = report.conditions.raw_tuned;
  const purpose = report.conditions.raw_tuned_purpose;
  const claim = report.conditions.actual_claim;
  const dossier = report.conditions.actual_relation_dossier;
  const claimEvidence = report.conditions.actual_claim_evidence;
  const evidenceOnly = report.conditions.actual_evidence_only;
  const rawChunking = report.raw_input.canonical_chunks
    ? `共通token chunk（${report.raw_input.chunk_count} Unit）を使う`
    : "tuningで選んだ固定長最大1,024文字・段落overlapなしのchunkingを使う";
  const details = `Raw条件は、${rawChunking}。Actual条件はRaw chunkerを使わず、Fragrachが生成したUnitを索引化する。文字2-gram BM25（\`k1=1.8\`、\`b=0.75\`）と質問文だけのqueryは全条件で共通である。

| 条件 | 文書範囲・Unit数 | 検索Unitの内容 | 権威・関係の利用 | 評価上の役割 |
|---|---|---|---|---|
| Raw Tuned | 製品設計部の全6用途、72文書、${raw.units} chunk | 原文を最大1,024文字に分割したchunk | なし | 部門横断RAGに近い運用参考値 |
| Raw Tuned + Purpose | governanceのみ、12文書、${purpose.units} chunk | Raw Tunedと同じ原文chunk | 文書範囲だけを利用目的で絞る | **主要比較基準**。Raw側にも利用目的を与えた強いベースライン |
| Actual Claim | governance Build、${claim.units} Unit | 短い原文抜粋、正規化Claim、compile済みConflict | 権威優先順位 | Claim化単体のアブレーション |
| Actual Claim + Relation Dossier | 同じBuild、${dossier.units} Unit | Actual Claimに文書関係と両側原文のDossierを追加 | 権威、版、競合、優先関係 | **Fragrachの評価対象** |
| Actual Claim + Evidence | 同じBuild、${claimEvidence.units} Unit | Claim/Conflictに全Evidenceを常時追加 | 権威、診断由来の別名 | Evidence常時混在のアブレーション |
| Actual Evidence only | 同じBuild、${evidenceOnly.units} Unit | 原文Evidence。ClaimとConflictは除外 | 診断由来の別名のみ。権威加点なし | 原文主体compiled経路の下限アブレーション |

### 比較基準と指標の優先順位

比較相手の主要基準は\`Raw Tuned + Purpose\`、製品候補は\`Actual Claim + Relation Dossier\`とする。同じgovernance 12文書を起点とするため、Purpose絞り込みではなくFragrachの事前コンパイルが生む差を評価できる。\`Raw Tuned\`は実運用参考、残るActual条件は原因分析用のアブレーションである。

| 優先度 | 層 | 基準とする指標 | 判定方法 | この検索レポートでの扱い |
|---:|---|---|---|---|
| 1 | 最終回答 | **Strict Pass** | 最終的な製品KPI。Raw Tuned + Purposeを上回ること | 別の最終回答評価で判定 |
| 2 | 検索 | **根拠再現率R@5** | 主要検索KPI。Raw Tuned + Purposeを下回らないこと | Actual ${pct(dossier.recall_at_k["5"])}、Raw + Purpose ${pct(purpose.recall_at_k["5"])} |
| 3 | 矛盾処理 | **Conflict Unit@10 / Conflict両側@10** | 関係Unitと両側原文を分けて測ること | Actual ${pct(dossier.conflict_unit_recall_at_k["10"])} / ${pct(dossier.conflict_complete_rate_at_k["10"])} |
| 4 | 回答変換 | **回答要素再現率 / 引用再現率** | どちらもRaw Tuned + Purposeを下回らないこと | 別の最終回答評価で判定 |
| 5 | 安全性 | **禁止誤答率 / behavior accuracy** | 0% / 100%を維持すること | 別の最終回答評価で判定 |
| 6 | 効率 | **平均待ち時間 / 入力tokens** | 品質と分離して倍率を報告すること | 別の最終回答評価で判定 |

検索方式の選択にはR@5とConflict指標を使うが、製品としての採否はStrict Passで決める。`;
  return markdownBase(report).replace(
    "\n\n## 全体結果",
    `\n\n${details}\n\n## 全体結果`,
  );
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node run-enterprise-actual-retrieval.mjs --build PATH --domain ID --intent ID [--canonical-chunks FILE] [--run-id ID]");
    return;
  }
  if (!options.build || !options.domain || !options.intent) throw new Error("--build, --domain, and --intent are required");
  const started = new Date();
  const runId = options.runId ?? started.toISOString().replace(/[:.]/g, "-");
  const runDirectory = path.join(options.output, runId);
  if (fs.existsSync(runDirectory)) throw new Error(`run directory already exists: ${runDirectory}`);
  fs.mkdirSync(runDirectory, { recursive: true });
  const domains = readJsonl(path.join(options.corpus, "evaluation/rag-domains.jsonl"));
  const domain = domains.find((item) => item.domain_id === options.domain);
  if (!domain) throw new Error(`unknown domain: ${options.domain}`);
  const profiles = readJsonl(path.join(options.corpus, "gold/profiles.jsonl"));
  const relations = readJsonl(path.join(options.corpus, "gold/relations.jsonl"));
  const questions = enrichConflicts(readJsonl(path.join(options.corpus, "evaluation/questions.jsonl")).filter((question) => question.industry === domain.industry && question.department === domain.department && question.intent_id === options.intent), profiles, relations);
  const sourceById = new Map(profiles.map((profile) => [profile.source_id, normalize(profile.relative_path)]));
  const profile = rawProfileOptions("tuned-sparse-v1");
  const sourceRawChunks = options.canonicalChunks
    ? readJsonl(options.canonicalChunks)
    : buildRawChunks(options.corpus, profile.chunking)
      .filter((chunk) => normalize(chunk.source).startsWith(domain.source_prefix));
  const canonicalSelection = options.canonicalChunks
    ? selectCanonicalRawChunks(sourceRawChunks, options.domain, options.intent)
    : null;
  const departmentRawChunks = canonicalSelection?.department ?? sourceRawChunks
    .map((chunk) => ({ ...chunk, intent_id: options.intent }));
  const rawChunks = canonicalSelection?.purpose ?? departmentRawChunks.filter((chunk) =>
    normalize(chunk.source).startsWith(`${domain.source_prefix}${options.intent}/`)
  );
  const configurations = {
    raw_tuned: departmentRawChunks,
    raw_tuned_purpose: rawChunks,
    actual_claim: buildActualChunks([options.build], { authorityBoost: true }),
    actual_relation_dossier: buildActualChunks([options.build], { authorityBoost: true, includeRelationDossiers: true }),
    actual_claim_evidence: buildActualChunks([options.build], { authorityBoost: true, evidenceFallback: true, includeDiagnosticAliases: true }),
    actual_evidence_only: buildActualChunks([options.build], { authorityBoost: false, evidenceFallback: true, includeClaims: false, includeConflicts: false, includeDiagnosticAliases: true }),
  };
  const conditions = {};
  const retrievalRows = [];
  for (const [name, chunks] of Object.entries(configurations)) {
    const retrieval = retrieve(chunks, questions, profile);
    const score = scoreRetrieval(questions, retrieval, ks);
    const coverage = scoreCompileCoverage(questions, chunks);
    conditions[name] = compact(score, relationRecall(questions, retrieval, sourceById), { ...coverage, documents: chunks.length });
    for (const question of questions) {
      const detail = score.questions_detail.find((item) => item.question_id === question.id);
      const { retrieved: duplicated, ...metrics } = detail;
      retrievalRows.push({ condition: name, question_id: question.id, question: question.question, required_evidence: question.required_evidence, required_relations: question.required_relations, metrics, retrieved_units: (retrieval.get(question.id) ?? []).map((item, index) => ({ rank: index + 1, score: item.score, id: item.document.id, unit_type: item.document.unit_type ?? "document", text: item.document.text ?? "", retrieval_text: item.document.text ?? "", evidence: item.document.evidence ?? [], token_count: item.document.token_count ?? null, relative_position: item.document.relative_position ?? null, source: item.document.source ?? null, section: item.document.section ?? null })) });
    }
  }
  const questionComparisons = questions.map((question) => ({
    question_id: question.id,
    question: question.question,
    kind: (question.tags ?? []).includes("conflict") ? "Conflict" : "Version",
    conditions: Object.fromEntries(
      Object.keys(configurations).map((condition) => {
        const row = retrievalRows.find((item) =>
          item.condition === condition && item.question_id === question.id
        );
        return [condition, row?.metrics ?? null];
      }),
    ),
  }));
  const buildManifestPath = path.join(options.build, "build-manifest.json");
  const buildManifest = JSON.parse(fs.readFileSync(buildManifestPath, "utf8"));
  const completed = new Date();
  const rawInput = {
    canonical_chunks: options.canonicalChunks,
    chunk_count: sourceRawChunks.length,
  };
  const report = { schema_version: "1.2", experiment: "enterprise-actual-retrieval", run_id: runId, status: "completed", started_at: started.toISOString(), completed_at: completed.toISOString(), duration_ms: completed - started, domain_id: options.domain, intent_id: options.intent, questions: questions.length, build: options.build, build_manifest: buildManifest, raw_input: rawInput, conditions, question_comparisons: questionComparisons };
  const manifest = { ...report, command: `node ${path.relative(repositoryRoot, scriptPath).replaceAll("\\", "/")} ${process.argv.slice(2).join(" ")}`, inputs: { build_manifest: { sha256: sha256File(buildManifestPath) }, questions: { sha256: sha256File(path.join(options.corpus, "evaluation/questions.jsonl")) }, profiles: { sha256: sha256File(path.join(options.corpus, "gold/profiles.jsonl")) }, relations: { sha256: sha256File(path.join(options.corpus, "gold/relations.jsonl")) }, canonical_chunks: options.canonicalChunks ? { path: options.canonicalChunks, sha256: sha256File(options.canonicalChunks) } : null, evaluator: { sha256: sha256File(scriptPath) } }, gold_indexed_by_actual: false };
  fs.writeFileSync(path.join(runDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(runDirectory, "metrics.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(runDirectory, "retrieval.jsonl"), `${retrievalRows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
  fs.writeFileSync(path.join(runDirectory, "REPORT_ja.md"), markdown(report), "utf8");
  fs.writeFileSync(path.join(runDirectory, "command.txt"), `${manifest.command}\n`, "utf8");
  fs.writeFileSync(path.join(options.output, "latest-run.txt"), `${runId}\n`, "utf8");
  console.log(`Run ${runId}; questions ${questions.length}; Raw R@5 ${pct(conditions.raw_tuned_purpose.recall_at_k["5"])}; Actual Claim R@5 ${pct(conditions.actual_claim.recall_at_k["5"])}; Actual Claim+Evidence R@5 ${pct(conditions.actual_claim_evidence.recall_at_k["5"])}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) main();
