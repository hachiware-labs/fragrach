import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildCorpusModel } from "./generate-enterprise-diverse-corpus.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceCorpusRoot = path.join(repoRoot, "tests", "corpora", "fragrach-enterprise-ja-diverse");
export const corpusRoot = path.join(repoRoot, "tests", "corpora", "fragrach-enterprise-ja-longform");
const sourcesRoot = path.join(corpusRoot, "sources");
const generationRoot = path.join(corpusRoot, "generation");
const outlineRoot = path.join(generationRoot, "outlines");
const cacheRoot = path.join(generationRoot, "cache");

export const DEFAULT_DOMAINS = Object.freeze([
  "manufacturing-product-design",
  "software-sre",
  "finance-compliance",
  "healthcare-quality-regulatory",
]);

const LONG_TYPES = new Map([
  ["policy", 6500],
  ["technical_specification", 10000],
  ["decision_minutes", 8500],
  ["operating_procedure", 7500],
  ["incident_report", 8000],
  ["master_agreement", 9000],
]);

const SELECT_LONG_DOCUMENT = Object.freeze({
  governance: (doc) => doc.type === "policy" && doc.relativePath.endsWith("pol-v2.md"),
  technical_spec: (doc) => doc.type === "technical_specification",
  planning: (doc) => doc.type === "decision_minutes",
  operations: (doc) => doc.type === "operating_procedure",
  incident_change: (doc) => doc.type === "incident_report" && doc.relativePath.endsWith("final.md"),
  commercial_compliance: (doc) => doc.type === "master_agreement",
});

const CHAPTERS = Object.freeze({
  governance: [
    ["文書の目的と位置づけ", "この正式規程を参照する業務場面と、文書体系上の位置づけを説明する。"],
    ["制定・改訂の背景", "制度が必要になった業務背景を、確定事項を増やさずに説明する。"],
    ["対象業務の全体像", "対象業務の開始から記録までの一般的な流れを説明する。"],
    ["関係者の確認観点", "担当者、管理者、監査担当が文書を読むときの観点を説明する。"],
    ["用語の読み方", "本文で使う業務用語を一般的に説明し、固有の義務は追加しない。"],
    ["関係文書との照合", "旧版、案内、承認記録を照合するときの一般的な手順を説明する。"],
    ["適用判断の注意", "対象、時点、版を取り違えないための読解上の注意を説明する。"],
    ["記録とレビュー", "適用判断を後から確認できるようにする一般的な記録観点を説明する。"],
    ["改訂時の引継ぎ", "改訂時に利用者が確認すべき一般的な引継ぎ観点を説明する。"],
    ["検索・参照ガイド", "RAGや文書検索でこの規程を探す際の自然な語彙と参照順を説明する。"],
  ],
  technical_spec: [
    ["仕様書の目的", "この仕様書が設計、製造、検証で果たす役割を説明する。"],
    ["対象システムの概観", "対象機器やシステムの構成を、入力にない性能値を加えずに説明する。"],
    ["適用範囲と境界", "仕様を適用する対象と、別文書を参照する境界を一般的に説明する。"],
    ["設計上の前提", "設計者が共有すべき前提を、追加の閾値や要件を作らずに説明する。"],
    ["インターフェース", "周辺工程や関連部門との受け渡しを一般的に説明する。"],
    ["品質特性", "安全性、保守性、追跡可能性などの確認観点を説明する。"],
    ["検証方針", "試験やレビューで仕様への適合を確認する一般的な方法を説明する。"],
    ["例外と非適用", "追補や個別条件を読む際に、適用範囲を拡張しない注意を説明する。"],
    ["トレーサビリティ", "要求、設計、試験記録を結び付ける一般的な管理方法を説明する。"],
    ["変更管理", "版、追補、草案、試験記録を区別して読む方法を説明する。"],
    ["運用移管", "設計情報を運用や保守へ引き渡す際の一般的な観点を説明する。"],
    ["付録・参照ガイド", "文書内検索で使える用語群と章間の参照方法を説明する。"],
  ],
  planning: [
    ["会議の目的", "審議会が扱った業務上の目的を、決定内容を先取りせずに説明する。"],
    ["検討の背景", "企画が必要になった背景と関係部門の問題意識を説明する。"],
    ["参加部門の観点", "企画、現場、技術、管理の各観点を一般化して説明する。"],
    ["審議資料の読み方", "提案、比較資料、正式決定、実施計画の役割の違いを説明する。"],
    ["主要な論点", "費用、移行、安全性、運用影響などの論点を、新しい結論を加えず説明する。"],
    ["検討された代替案", "複数案を比較する際の評価方法を、採否を創作せず説明する。"],
    ["リスクの確認", "導入や変更に伴う一般的なリスク確認の観点を説明する。"],
    ["決定事項の読み方", "議論中の発言と正式決定を区別する読み方を説明する。"],
    ["実施部門への引継ぎ", "決定後に実施計画へ情報を渡す一般的な方法を説明する。"],
    ["未解決事項の管理", "決定されていない論点を決定済みとして扱わない記録方法を説明する。"],
    ["議事録の承認と保管", "正式記録としてレビュー、確定、参照する一般的な流れを説明する。"],
    ["検索・参照ガイド", "提案と決定を検索で区別するための語彙と参照順を説明する。"],
  ],
  operations: [
    ["手順書の目的", "現場で一貫した作業を行うための文書の役割を説明する。"],
    ["対象業務の流れ", "準備、実施、確認、記録の一般的な流れを説明する。"],
    ["役割分担", "実施者、確認者、管理者の一般的な役割を説明する。"],
    ["事前確認", "作業開始前に対象、版、状態を確認する観点を説明する。"],
    ["実施上の注意", "誤操作や対象違いを防ぐ一般的な注意事項を説明する。"],
    ["例外の扱い", "期限付き例外や個別指示を対象外へ広げない読み方を説明する。"],
    ["記録方法", "実施事実を後から追跡するための一般的な記録観点を説明する。"],
    ["異常時の連携", "想定外の状態を検出した際の一般的な連携観点を説明する。"],
    ["レビュー", "作業結果と記録の整合を確認する一般的なレビュー方法を説明する。"],
    ["教育と引継ぎ", "手順の理解を担当者間で揃える一般的な方法を説明する。"],
    ["変更管理", "標準手順、現場指示、例外、実施記録を区別する方法を説明する。"],
    ["検索・参照ガイド", "対象と時点に合う手順を検索するための語彙を説明する。"],
  ],
  incident_change: [
    ["報告書の目的", "障害の事実、分析、対応を後から追跡する文書の役割を説明する。"],
    ["影響の捉え方", "利用者、業務、システムへの影響を整理する一般的な観点を説明する。"],
    ["情報源", "監視、ログ、関係者確認などの情報を照合する方法を説明する。"],
    ["時系列の読み方", "初報から確定報告まで、見解が更新されることを説明する。"],
    ["原因分析の方法", "仮説と確定原因を区別する一般的な分析方法を説明する。"],
    ["暫定対応", "影響抑制の対応と恒久対策を区別して記録する方法を説明する。"],
    ["恒久対策", "変更申請、承認、適用記録を別の状態として追跡する方法を説明する。"],
    ["検証観点", "復旧確認と再発防止確認を区別する一般的な方法を説明する。"],
    ["関係部門との連携", "技術、運用、管理部門間の情報共有観点を説明する。"],
    ["残存リスク", "未解決事項を解決済みと誤認しない記録方法を説明する。"],
    ["教訓と改善", "個別障害から一般的な改善候補を整理する方法を説明する。"],
    ["検索・参照ガイド", "初期見解、確定原因、変更、リリース記録を検索で区別する語彙を説明する。"],
  ],
  commercial_compliance: [
    ["契約文書の目的", "基本契約が共通条件を定める役割を説明する。"],
    ["取引の背景", "対象取引と関係部門の一般的な業務背景を説明する。"],
    ["文書体系", "基本契約、個別契約、提案、監査記録の役割の違いを説明する。"],
    ["適用範囲", "組織、対象業務、契約単位を確認する一般的な方法を説明する。"],
    ["責任分界", "当事者間の責任を読む際の一般的な観点を説明する。"],
    ["履行確認", "契約上の条件と実績記録を照合する一般的な方法を説明する。"],
    ["例外と優先順位", "個別条件を対象外へ広げずに読む方法を説明する。"],
    ["未署名資料の扱い", "提案を契約義務として扱わない読解上の注意を説明する。"],
    ["変更と更新", "改定、更新、個別合意を追跡する一般的な管理方法を説明する。"],
    ["監査証跡", "判断根拠と参照文書を後から確認する一般的な記録方法を説明する。"],
    ["部門間の照会", "法務、調達、事業部門が確認事項を受け渡す観点を説明する。"],
    ["検索・参照ガイド", "対象契約と文書優先順位を検索で確認する語彙を説明する。"],
  ],
});

const normalize = (value) => value.replaceAll("\\", "/");
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};
const writeJsonl = (file, values) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${values.map((value) => JSON.stringify(value)).join("\n")}\n`, "utf8");
};
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const domainId = (doc) => `${doc.industry}-${doc.department}`;
const isLongDocument = (doc) => SELECT_LONG_DOCUMENT[doc.purpose]?.(doc) ?? false;

function targetChars(doc, scale = 1) {
  const base = LONG_TYPES.get(doc.type) ?? 7000;
  return Math.max(3000, Math.round(base * scale));
}

function anchorPositions(generatedCount, anchorCount, documentId) {
  const seed = Number.parseInt(sha256(documentId).slice(0, 8), 16);
  const positions = [];
  for (let index = 0; index < anchorCount; index += 1) {
    const center = Math.round(((index + 1) * generatedCount) / (anchorCount + 1));
    const jitter = ((seed >> (index * 3)) % 3) - 1;
    positions.push(Math.max(1, Math.min(generatedCount - 1, center + jitter)));
  }
  return positions;
}

export function buildOutline(doc, options = {}) {
  const target = targetChars(doc, options.targetScale ?? 1);
  const templates = CHAPTERS[doc.purpose];
  if (!templates) throw new Error(`no chapter template for ${doc.purpose}`);
  const generatedTarget = Math.max(300, Math.floor((target - doc.sections.reduce((sum, item) => sum + item.anchor.length, 0)) / templates.length));
  const generated = templates.map(([heading, instruction], index) => ({
    id: `context-${String(index + 1).padStart(2, "0")}`,
    kind: "generated_context",
    heading,
    instruction,
    target_chars: generatedTarget,
  }));
  const positions = anchorPositions(generated.length, doc.sections.length, doc.id);
  const sections = [...generated];
  doc.sections.forEach((item, index) => {
    sections.splice(positions[index] + index, 0, {
      id: `gold-${String(index + 1).padStart(2, "0")}`,
      kind: "gold_anchor",
      heading: item.heading,
      anchor: item.anchor,
      guidance: item.guidance,
    });
  });
  return {
    schema_version: "1.0",
    outline_id: `outline-${sha256(`${doc.id}:realistic-v1`).slice(0, 16)}`,
    document_id: doc.id,
    title: doc.title,
    domain: domainId(doc),
    purpose: doc.purpose,
    document_type: doc.type,
    target_chars: target,
    gold_anchor_placement: "deterministic-distributed",
    sections,
  };
}

function stripCodeFence(value) {
  return value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
}

function factualTokens(text) {
  return new Set([
    ...(text.match(/\d+(?:[.,]\d+)*/g) ?? []),
    ...(text.match(/[A-Z]{2,}-(?:[A-Z0-9]+-?)+/g) ?? []),
  ]);
}

export function removeUngroundedFactualSentences(content, allowed) {
  return content
    .split(/(?<=[。！？\n])/)
    .filter((sentence) =>
      [...factualTokens(sentence)].every((token) => allowed.includes(token))
    )
    .join("")
    .trim();
}

function parseGenerated(raw, doc, expectedSections) {
  const parsed = JSON.parse(stripCodeFence(raw.response ?? raw));
  const expected = new Map(expectedSections.map((item) => [item.id, item]));
  const allowed = [doc.title, ...doc.sections.map((item) => item.anchor)].join("\n");
  const values = new Map();
  for (const item of parsed.sections ?? []) {
    if (!expected.has(item.id)) continue;
    let content = String(item.content ?? "").trim();
    if (content.length < Math.min(220, expected.get(item.id).target_chars * 0.35)) continue;
    if (/^#|\n#/.test(content)) continue;
    const unsupported = [...factualTokens(content)].filter((token) => !allowed.includes(token));
    if (unsupported.length > 0) content = removeUngroundedFactualSentences(content, allowed);
    if (content.length < Math.min(220, expected.get(item.id).target_chars * 0.35)) continue;
    if ([...factualTokens(content)].some((token) => !allowed.includes(token))) continue;
    values.set(item.id, content);
  }
  return values;
}

function promptFor(doc, outline, attempt, sections) {
  const fixedFacts = doc.sections.map((item) => ({ heading: item.heading, text: item.anchor }));
  const responseSkeleton = { sections: sections.map((item) => ({ id: item.id, content: "このIDに対応する補足章本文" })) };
  return `あなたは架空企業の長文社内文書を執筆する編集者です。先に設計済みの骨子に従い、各補足章の本文だけを作成してください。\n` +
    `文書は「${doc.title}」、文書種別は「${doc.type}」、利用目的は「${doc.purpose}」です。\n` +
    `補足章は文書らしい背景、読解方法、確認観点、部門間の受け渡しを詳しく説明します。各章は同じ導入や結論を繰り返さず、前後の章と役割を分けてください。\n` +
    `fixed_factsは別工程で原文へそのまま挿入します。補足章では、入力にない日付、数値、期間、閾値、人名、製品コード、採否、承認状態、適用範囲、原因、義務、例外を新しく作ってはいけません。\n` +
    `確定要件のように断言せず、一般的な説明と参照上の注意に限定してください。「必ず」「しなければならない」「してはならない」「義務」「無効」「求められる」「要求される」「必要がある」という表現は禁止します。\n` +
    `「一般にはこの観点で整理される」「参照時の観点になる」のような非規範表現を使います。Markdown見出し、表、コードフェンス、前置きは出力しません。\n` +
    `各contentは指定文字数の八割以上を目安にしてください。試行番号は${attempt}です。JSON以外を返してはいけません。\n` +
    `sections配列には、骨子にある${sections.length}個のIDを省略せず一度ずつ、提示順のまま出力してください。一章だけを出力して終了してはいけません。\n` +
    `出力骨格:${JSON.stringify(responseSkeleton)}\n` +
    `fixed_facts:${JSON.stringify(fixedFacts)}\n骨子:${JSON.stringify(sections)}`;
}

async function modelDigest(options) {
  const response = await fetch(`${options.endpoint}/api/tags`);
  if (!response.ok) throw new Error(`Ollama tags HTTP ${response.status}: ${await response.text()}`);
  const payload = await response.json();
  const model = (payload.models ?? []).find((item) => item.name === options.model || item.model === options.model);
  if (!model?.digest) throw new Error(`Ollama model not found: ${options.model}`);
  return model.digest;
}

async function generateDocument(doc, outline, options) {
  const cacheIdentity = JSON.stringify({
    schema: "enterprise-longform-realistic-v5-sentence-factual-gate",
    model: options.model,
    model_digest: options.modelDigest,
    seed: options.seed,
    temperature: options.temperature,
    num_ctx: 32768,
    outline,
    facts: doc.sections,
  });
  const cacheKey = sha256(cacheIdentity);
  const cacheFile = path.join(cacheRoot, `${cacheKey}.json`);
  if (!options.noCache && fs.existsSync(cacheFile)) {
    const raw = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    const expectedSections = outline.sections.filter((item) => item.kind === "generated_context");
    const sections = parseGenerated(raw, doc, expectedSections);
    if (sections.size === expectedSections.length) {
      return { sections, cached: true, cacheKey, metrics: raw.metrics ?? {} };
    }
  }
  let lastError;
  const expectedSections = outline.sections.filter((item) => item.kind === "generated_context");
  const collected = new Map();
  const metrics = { total_duration: 0, prompt_eval_count: 0, eval_count: 0, attempts: 0 };
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const missing = expectedSections.filter((item) => !collected.has(item.id));
    if (missing.length === 0) break;
    const prompt = promptFor(doc, outline, attempt, missing);
    const response = await fetch(`${options.endpoint}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: options.model,
        stream: false,
        format: "json",
        keep_alive: "30m",
        prompt,
        options: {
          temperature: options.temperature,
          seed: (options.seed + Number.parseInt(sha256(doc.id).slice(0, 8), 16) + attempt * 104729) % 2147483647,
          num_ctx: 32768,
          num_predict: Math.min(12288, Math.max(2048, Math.ceil(missing.reduce((sum, item) => sum + item.target_chars, 0) * 0.9))),
        },
      }),
    });
    if (!response.ok) {
      lastError = new Error(`Ollama HTTP ${response.status}: ${await response.text()}`);
      continue;
    }
    const raw = await response.json();
    try {
      const sections = parseGenerated(raw, doc, missing);
      for (const [id, content] of sections) collected.set(id, content);
      metrics.total_duration += raw.total_duration ?? 0;
      metrics.prompt_eval_count += raw.prompt_eval_count ?? 0;
      metrics.eval_count += raw.eval_count ?? 0;
      metrics.attempts = attempt;
      if (collected.size !== expectedSections.length) throw new Error(`valid sections ${collected.size}/${expectedSections.length}`);
    } catch (error) {
      writeJson(
        path.join(generationRoot, "failed-responses", `${doc.id}-attempt-${attempt}.json`),
        { document_id: doc.id, attempt, error: String(error), response: raw.response, metrics: {
          total_duration: raw.total_duration,
          prompt_eval_count: raw.prompt_eval_count,
          eval_count: raw.eval_count,
        } },
      );
      lastError = error;
    }
  }
  if (collected.size === expectedSections.length) {
    const cachedValue = {
      response: JSON.stringify({ sections: expectedSections.map((item) => ({ id: item.id, content: collected.get(item.id) })) }),
      metrics,
    };
    writeJson(cacheFile, cachedValue);
    return { sections: collected, cached: false, cacheKey, metrics };
  }
  throw new Error(`${doc.id}: ${lastError ?? "generation failed"}`);
}

function frontmatter(doc, options, outline) {
  const fields = {
    document_id: doc.id,
    title: doc.title,
    company: doc.company,
    industry: doc.industry,
    department: doc.department,
    department_name: doc.departmentName,
    scenario: doc.scenario,
    purpose: doc.purpose,
    document_type: doc.type,
    status: doc.status,
    authority: doc.authority,
    owner: doc.owner,
    approved: doc.approved,
    force: doc.force,
    force_rank: doc.forceRank,
    valid_from: doc.validFrom,
    valid_to: doc.validTo,
    version: doc.version,
    official_record: doc.officialRecord,
    scope: doc.scope,
    synthetic: true,
    generation_model: options.model,
    length_profile: "realistic-v1",
    outline_id: outline.outline_id,
    generation_contract: "realistic-v4-structured-numeric-gate",
  };
  return `---\n${Object.entries(fields).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n")}\n---\n\n`;
}

function renderLongDocument(doc, outline, generated, options) {
  const body = outline.sections.map((item) => {
    const content = item.kind === "gold_anchor" ? item.anchor : generated.get(item.id);
    return `## ${item.heading}\n\n${content}`;
  }).join("\n\n");
  return `${frontmatter(doc, options, outline)}# ${doc.title}\n\n> 架空の評価用社内文書です。固有名詞・制度・数値は実在組織と無関係です。\n\n${body}\n`;
}

function copyShortDocuments(documents, options) {
  for (const doc of documents.filter((item) => !isLongDocument(item))) {
    const from = path.join(sourceCorpusRoot, "sources", ...doc.relativePath.split("/"));
    const to = path.join(sourcesRoot, ...doc.relativePath.split("/"));
    if (!fs.existsSync(from)) throw new Error(`source corpus document not found: ${doc.relativePath}`);
    if (!options.force && fs.existsSync(to)) continue;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
}

function writeCorpusMetadata(full, documents, domains, options) {
  const ids = new Set(documents.map((doc) => doc.id));
  const questions = full.questions.filter((item) => domains.has(`${item.industry}-${item.department}`));
  const relations = full.relations.filter((item) => ids.has(item.subject) && ids.has(item.object));
  const profiles = full.profiles.filter((item) => ids.has(item.source_id));
  writeJsonl(path.join(corpusRoot, "world", "documents.jsonl"), documents.map((doc) => ({
    document_id: doc.id,
    relative_path: `sources/${doc.relativePath}`,
    title: doc.title,
    industry: doc.industry,
    department: doc.department,
    scenario: doc.scenario,
    purpose: doc.purpose,
    anchors: doc.sections.map((item) => ({ section: item.heading, text: item.anchor })),
    length_profile: isLongDocument(doc) ? "realistic-v1-long" : "realistic-v1-short",
  })));
  writeJsonl(path.join(corpusRoot, "gold", "profiles.jsonl"), profiles);
  writeJsonl(path.join(corpusRoot, "gold", "relations.jsonl"), relations);
  writeJsonl(path.join(corpusRoot, "evaluation", "questions.jsonl"), questions);
  writeJsonl(path.join(corpusRoot, "gold", "answers.jsonl"), questions.map((item) => ({
    question_id: item.id,
    expected_behavior: item.expected_behavior,
    required_answer_elements: item.expected_answer_elements,
    prohibited_conclusions: item.forbidden_answer_elements,
    gold_evidence: item.required_evidence,
    required_relations: item.required_relations,
  })));
  const ragDomains = [...domains].map((id) => {
    const domainDocs = documents.filter((doc) => domainId(doc) === id);
    const domainQuestions = questions.filter((item) => `${item.industry}-${item.department}` === id);
    return {
      domain_id: id,
      industry: domainDocs[0].industry,
      department: domainDocs[0].department,
      source_prefix: `sources/${domainDocs[0].industry}/${domainDocs[0].department}/`,
      document_count: domainDocs.length,
      long_document_count: domainDocs.filter(isLongDocument).length,
      question_count: domainQuestions.length,
      document_ids: domainDocs.map((doc) => doc.id),
      question_ids: domainQuestions.map((item) => item.id),
      intent_ids: [...new Set(domainQuestions.map((item) => item.intent_id))],
    };
  });
  writeJsonl(path.join(corpusRoot, "evaluation", "rag-domains.jsonl"), ragDomains);
  for (const file of fs.readdirSync(path.join(sourceCorpusRoot, "intents"))) {
    const from = path.join(sourceCorpusRoot, "intents", file);
    const to = path.join(corpusRoot, "intents", file);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
  const manifest = {
    schema_version: "1.0",
    corpus_id: "fragrach-enterprise-ja-longform",
    language: "ja",
    synthetic: true,
    derived_from: "fragrach-enterprise-ja-diverse",
    generator: "scripts/generate-enterprise-longform-corpus.mjs",
    generation_model: options.model,
    generation_model_digest: options.modelDigest,
    length_profile: "realistic-v1",
    domains: ragDomains,
    counts: {
      documents: documents.length,
      long_documents: documents.filter(isLongDocument).length,
      short_documents: documents.filter((doc) => !isLongDocument(doc)).length,
      questions: questions.length,
      relations: relations.length,
    },
    design: {
      outline_before_generation: true,
      gold_anchors_are_deterministic: true,
      gold_anchors_distributed_through_document: true,
      ollama_generates_non_normative_context_only: true,
      mixed_document_lengths: true,
    },
  };
  writeJson(path.join(corpusRoot, "manifest.json"), manifest);
}

function documentStats(documents) {
  const rows = documents.map((doc) => {
    const file = path.join(sourcesRoot, ...doc.relativePath.split("/"));
    const chars = fs.existsSync(file) ? fs.readFileSync(file, "utf8").length : 0;
    return { id: doc.id, type: doc.type, purpose: doc.purpose, long: isLongDocument(doc), chars };
  });
  const values = rows.map((item) => item.chars).sort((a, b) => a - b);
  const percentile = (ratio) => values[Math.min(values.length - 1, Math.floor(values.length * ratio))] ?? 0;
  return {
    documents: rows.length,
    long_documents: rows.filter((item) => item.long).length,
    min_chars: values[0] ?? 0,
    average_chars: values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0,
    p50_chars: percentile(0.5),
    p90_chars: percentile(0.9),
    max_chars: values.at(-1) ?? 0,
    by_purpose: Object.fromEntries([...new Set(rows.map((item) => item.purpose))].sort().map((purpose) => {
      const selected = rows.filter((item) => item.purpose === purpose);
      return [purpose, {
        documents: selected.length,
        long_documents: selected.filter((item) => item.long).length,
        average_chars: Math.round(selected.reduce((sum, item) => sum + item.chars, 0) / selected.length),
      }];
    })),
  };
}

export async function generate(options = {}) {
  options = {
    model: "gemma4:latest",
    endpoint: process.env.OLLAMA_HOST || "http://127.0.0.1:11434",
    seed: 20260802,
    temperature: 0.25,
    domains: DEFAULT_DOMAINS,
    force: false,
    noCache: false,
    dryRun: false,
    maxDocuments: null,
    targetScale: 1,
    metadataOnly: false,
    ...options,
  };
  const domainSet = new Set(options.domains);
  const full = buildCorpusModel();
  const documents = full.documents.filter((doc) => domainSet.has(domainId(doc)));
  if (documents.length === 0) throw new Error("no matching domains");
  const longDocuments = documents.filter(isLongDocument);
  const outlines = longDocuments.map((doc) => buildOutline(doc, options));
  if (options.dryRun) {
    return {
      domains: [...domainSet],
      documents: documents.length,
      long_documents: longDocuments.length,
      short_documents: documents.length - longDocuments.length,
      target_long_characters: outlines.reduce((sum, item) => sum + item.target_chars, 0),
    };
  }
  options.modelDigest = options.modelDigest ?? await modelDigest(options);
  fs.mkdirSync(corpusRoot, { recursive: true });
  writeCorpusMetadata(full, documents, domainSet, options);
  copyShortDocuments(documents, options);
  for (const outline of outlines) writeJson(path.join(outlineRoot, `${outline.document_id}.json`), outline);
  if (options.metadataOnly) {
    return {
      status: "metadata_updated",
      documents: documents.length,
      long_documents: longDocuments.length,
      domains: [...domainSet],
    };
  }
  const report = {
    schema_version: "1.0",
    corpus_id: "fragrach-enterprise-ja-longform",
    model: options.model,
    model_digest: options.modelDigest,
    started_at: new Date().toISOString(),
    domains: [...domainSet],
    requested_long_documents: longDocuments.length,
    generated_documents: 0,
    resumed_documents: 0,
    cache_hits: 0,
    failures: [],
    documents: [],
  };
  let candidates = longDocuments.filter((doc) => {
    const file = path.join(sourcesRoot, ...doc.relativePath.split("/"));
    if (options.force || !fs.existsSync(file)) return true;
    const text = fs.readFileSync(file, "utf8");
    const outline = outlines.find((item) => item.document_id === doc.id);
    const valid = text.includes(`outline_id: ${JSON.stringify(outline.outline_id)}`) &&
      text.includes(`generation_contract: "realistic-v4-structured-numeric-gate"`) &&
      doc.sections.every((item) => text.includes(item.anchor));
    if (valid) report.resumed_documents += 1;
    return !valid;
  });
  if (options.maxDocuments != null) candidates = candidates.slice(0, options.maxDocuments);
  console.log(`Long-form generation: ${candidates.length} pending; ${report.resumed_documents} resumed; ${documents.length} total documents.`);
  for (let index = 0; index < candidates.length; index += 1) {
    const doc = candidates[index];
    const outline = outlines.find((item) => item.document_id === doc.id);
    const started = Date.now();
    try {
      const result = await generateDocument(doc, outline, options);
      const text = renderLongDocument(doc, outline, result.sections, options);
      if (!doc.sections.every((item) => text.includes(item.anchor))) throw new Error("gold anchor lost during render");
      const file = path.join(sourcesRoot, ...doc.relativePath.split("/"));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text, "utf8");
      report.generated_documents += 1;
      if (result.cached) report.cache_hits += 1;
      report.documents.push({
        document_id: doc.id,
        relative_path: `sources/${doc.relativePath}`,
        chars: text.length,
        target_chars: outline.target_chars,
        cached: result.cached,
        elapsed_ms: Date.now() - started,
        cache_key: result.cacheKey,
        ...result.metrics,
      });
      console.log(`Progress ${index + 1}/${candidates.length}: ${doc.id} ${text.length} chars${result.cached ? " (cache)" : ""}`);
    } catch (error) {
      report.failures.push({ document_id: doc.id, error: String(error) });
      console.error(`Failed ${doc.id}: ${error}`);
    }
    writeJson(path.join(generationRoot, "ollama-generation-report.json"), report);
  }
  report.completed_at = new Date().toISOString();
  report.stats = documentStats(documents);
  writeJson(path.join(generationRoot, "ollama-generation-report.json"), report);
  const readme = `# Fragrach 長文企業文書コーパス\n\n` +
    `短文中心の \`fragrach-enterprise-ja-diverse\` から、四つの部門RAGを選び、実務に近い長さの文書を混在させた派生コーパスです。\n\n` +
    `- 対象領域: ${[...domainSet].join("、")}\n` +
    `- 文書数: ${documents.length}（長文 ${longDocuments.length}、短文 ${documents.length - longDocuments.length}）\n` +
    `- Gold質問: ${full.questions.filter((item) => domainSet.has(`${item.industry}-${item.department}`)).length}\n` +
    `- 長文化対象: 現行規程、技術仕様、決裁議事録、標準手順、最終障害報告、基本契約\n\n` +
    `生成は、決定的な文書骨子を先に保存し、Ollamaで非規範の補足章だけを生成し、Gold文を先頭・中央・末尾へ分散挿入します。` +
    `短いFAQ、承認記録、草案、実施ログなどは元コーパスのまま保持します。\n\n` +
    `生成: \`npm run corpus:longform:generate\`\n\n検証: \`npm run corpus:longform:check\`\n`;
  fs.writeFileSync(path.join(corpusRoot, "README.md"), readme, "utf8");
  return report;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--model") options.model = argv[++index];
    else if (arg === "--endpoint") options.endpoint = argv[++index].replace(/\/$/, "");
    else if (arg === "--domains") options.domains = argv[++index].split(",").filter(Boolean);
    else if (arg === "--seed") options.seed = Number(argv[++index]);
    else if (arg === "--temperature") options.temperature = Number(argv[++index]);
    else if (arg === "--target-scale") options.targetScale = Number(argv[++index]);
    else if (arg === "--max-documents") options.maxDocuments = Number(argv[++index]);
    else if (arg === "--metadata-only") options.metadataOnly = true;
    else if (arg === "--force") options.force = true;
    else if (arg === "--no-cache") options.noCache = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--help") options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node scripts/generate-enterprise-longform-corpus.mjs [--model NAME] [--domains id,id] [--target-scale N] [--max-documents N] [--metadata-only] [--force] [--no-cache] [--dry-run]");
  } else {
    generate(options).then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  }
}
