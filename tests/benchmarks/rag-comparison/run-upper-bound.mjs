#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { scoreRun } from "./evaluate.mjs";
import { createStructuredChat } from "./structured-chat.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../../..");
const defaultCorpusRoot = path.resolve(
  scriptDirectory,
  "../../corpora/aobane-industries-ja",
);
const defaultOutputDirectory = path.resolve(
  scriptDirectory,
  "../../../target/benchmarks/rag-comparison",
);

export const ANSWER_BEHAVIORS = [
  "answer",
  "answer_with_provenance",
  "answer_with_conflict_disclosure",
  "answer_with_temporal_resolution",
  "insufficient_information",
];

export function filterChunksBySourcePrefix(chunks, sourcePrefix) {
  if (!sourcePrefix) return chunks;
  const normalized = normalizeSource(`sources/${sourcePrefix}`)
    .replace(/\/+$/, "") + "/";
  return chunks.filter((chunk) =>
    (chunk.evidence ?? []).some((reference) =>
      normalizeSource(reference.source).startsWith(normalized)
    )
  );
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readJsonl(filePath) {
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`${filePath}:${index + 1}: ${error.message}`);
      }
    });
}

function readOptionalJsonl(filePath) {
  return fs.existsSync(filePath) ? readJsonl(filePath) : [];
}

export function readCorpusGold(corpusRoot = defaultCorpusRoot) {
  const goldRoot = path.join(corpusRoot, "gold");
  return {
    answers: readOptionalJsonl(path.join(goldRoot, "answers.jsonl")),
    conflicts: readOptionalJsonl(path.join(goldRoot, "conflicts.jsonl")),
    aliases: readOptionalJsonl(path.join(goldRoot, "aliases.jsonl")),
    versions: readOptionalJsonl(path.join(goldRoot, "versions.jsonl")),
    duplicates: readOptionalJsonl(path.join(goldRoot, "duplicates.jsonl")),
  };
}

export function completeGoldAnswers(questions, answers = []) {
  const byQuestionId = new Map(
    answers.map((answer) => [answer.question_id, answer]),
  );
  return questions.map((question) =>
    byQuestionId.get(question.id) ?? {
      question_id: question.id,
      intent: question.intent_id,
      question: question.question,
      as_of: question.as_of,
      required_answer_elements: question.expected_answer_elements,
      prohibited_conclusions: question.forbidden_answer_elements,
      expected_behavior: question.expected_behavior,
      gold_evidence: question.required_evidence,
    },
  );
}

export function enrichQuestionsWithConflictGold(
  questions,
  answers = [],
  conflicts = [],
) {
  const answersByQuestion = new Map(
    answers.map((answer) => [answer.question_id, answer]),
  );
  return questions.map((question) => {
    if (question.conflict_evidence) return question;
    const answer = answersByQuestion.get(question.id);
    if (
      question.expected_behavior !== "answer_with_conflict_disclosure" ||
      !answer?.canonical_citation
    ) {
      return question;
    }
    const goldEvidence = answer.gold_evidence ?? question.required_evidence ?? [];
    const evidenceSources = new Set(
      goldEvidence.map((item) => normalizeSource(item.source)),
    );
    const canonicalSource = normalizeSource(answer.canonical_citation);
    const conflict = conflicts.find((candidate) => {
      const sources = (candidate.sources ?? []).map(normalizeSource);
      return (
        sources.includes(canonicalSource) &&
        sources.length >= 2 &&
        sources.every((source) => evidenceSources.has(source))
      );
    });
    if (!conflict) return question;
    const conflictSources = new Set(
      conflict.sources.map(normalizeSource),
    );
    const canonical = goldEvidence.filter(
      (item) => normalizeSource(item.source) === canonicalSource,
    );
    const conflicting = goldEvidence.filter((item) => {
      const source = normalizeSource(item.source);
      return source !== canonicalSource && conflictSources.has(source);
    });
    if (canonical.length === 0 || conflicting.length === 0) return question;
    return {
      ...question,
      conflict_evidence: {
        conflict_id: conflict.conflict_id,
        resolution: conflict.status,
        canonical,
        conflicting,
      },
    };
  });
}

function writeJsonl(filePath, rows) {
  fs.writeFileSync(
    filePath,
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    "utf8",
  );
}

function normalizeSource(source) {
  return String(source ?? "")
    .replaceAll("\\", "/")
    .replace(/^\.\//, "");
}

function walkFiles(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(entryPath));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files.sort((left, right) => left.localeCompare(right, "ja"));
}

function headingFromLine(line) {
  const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
  return match ? { level: match[1].length, text: match[2] } : null;
}

function createRawChunk(source, section, title, text, index) {
  const cleanText = text.trim();
  return {
    id: `raw:${source}:${index}`,
    source,
    section: section || title || "本文",
    title: title || source,
    body: cleanText,
    is_metadata: section === "文書メタデータ",
    evidence: [{ source, section: section || title || "本文" }],
    text: [
      `文書: ${title || source}`,
      `セクション: ${section || title || "本文"}`,
      cleanText,
    ].join("\n"),
  };
}

function formatRawChunk(chunk, options = {}) {
  const lines = [];
  if (options.includeTitle ?? true) lines.push(`文書: ${chunk.title}`);
  if (options.includeSection ?? true) lines.push(`セクション: ${chunk.section}`);
  lines.push(chunk.body);
  return { ...chunk, text: lines.join("\n") };
}

function groupRawChunks(chunks, options = {}) {
  const strategy = options.strategy ?? "paragraph";
  const includeMetadata = options.includeMetadata ?? true;
  const selected = chunks.filter((chunk) => includeMetadata || !chunk.is_metadata);
  if (strategy === "paragraph") {
    return selected.map((chunk) => formatRawChunk(chunk, options));
  }

  if (!["section", "fixed"].includes(strategy)) {
    throw new Error(`unknown raw chunk strategy: ${strategy}`);
  }
  const maxChars = strategy === "section"
    ? Number.POSITIVE_INFINITY
    : options.maxChars;
  if (strategy === "fixed" && (!Number.isInteger(maxChars) || maxChars < 1)) {
    throw new Error("fixed raw chunks require a positive maxChars");
  }
  const overlapParagraphs = Math.max(0, options.overlapParagraphs ?? 0);
  const grouped = [];
  let cursor = 0;

  while (cursor < selected.length) {
    const first = selected[cursor];
    const sameSection = [];
    let sectionEnd = cursor;
    while (
      sectionEnd < selected.length &&
      selected[sectionEnd].source === first.source &&
      selected[sectionEnd].section === first.section
    ) {
      sameSection.push(selected[sectionEnd]);
      sectionEnd += 1;
    }

    let windowStart = 0;
    while (windowStart < sameSection.length) {
      const window = [];
      let bodyLength = 0;
      let windowEnd = windowStart;
      while (windowEnd < sameSection.length) {
        const candidate = sameSection[windowEnd];
        const nextLength = bodyLength + (window.length > 0 ? 2 : 0) + candidate.body.length;
        if (window.length > 0 && nextLength > maxChars) break;
        window.push(candidate);
        bodyLength = nextLength;
        windowEnd += 1;
      }
      const evidence = window.flatMap((chunk) => chunk.evidence);
      const combined = {
        ...first,
        id: `raw:${first.source}:group:${grouped.length}`,
        body: window.map((chunk) => chunk.body).join("\n\n"),
        evidence,
      };
      grouped.push(formatRawChunk(combined, options));
      if (windowEnd >= sameSection.length) break;
      windowStart = Math.max(windowStart + 1, windowEnd - overlapParagraphs);
    }
    cursor = sectionEnd;
  }
  return grouped;
}

function parseMarkdown(source, text) {
  const lines = text.split(/\r?\n/);
  const chunks = [];
  const headings = [];
  let title = "";
  let cursor = 0;
  let chunkIndex = 0;

  if (lines[0]?.trim() === "---") {
    const closing = lines.slice(1).findIndex((line) => line.trim() === "---");
    if (closing >= 0) {
      const end = closing + 1;
      chunks.push(
        createRawChunk(
          source,
          "文書メタデータ",
          title,
          lines.slice(0, end + 1).join("\n"),
          chunkIndex++,
        ),
      );
      cursor = end + 1;
    }
  }

  let block = [];
  let blockSection = "";
  const flush = () => {
    if (block.length === 0) return;
    chunks.push(
      createRawChunk(
        source,
        blockSection,
        title,
        block.join("\n"),
        chunkIndex++,
      ),
    );
    block = [];
  };

  for (; cursor < lines.length; cursor += 1) {
    const line = lines[cursor];
    const heading = headingFromLine(line);
    if (heading) {
      flush();
      headings.length = Math.min(headings.length, heading.level - 1);
      headings[heading.level - 1] = heading.text;
      if (heading.level === 1 && !title) title = heading.text;
      blockSection = headings.filter(Boolean).join(" / ");
    } else if (line.trim() === "") {
      flush();
    } else {
      if (block.length === 0) {
        blockSection = headings.filter(Boolean).join(" / ") || title || "本文";
      }
      block.push(line);
    }
  }
  flush();

  return chunks;
}

function parseText(source, text) {
  const lines = text.split(/\r?\n/);
  const title = lines.find((line) => line.trim())?.trim() || source;
  const chunks = [];
  let section = title;
  let block = [];
  let chunkIndex = 0;

  const flush = () => {
    if (block.length === 0) return;
    chunks.push(
      createRawChunk(source, section, title, block.join("\n"), chunkIndex++),
    );
    block = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^議題\d+\s+/.test(trimmed) || trimmed === "決定事項") {
      flush();
      section = trimmed;
    } else if (!trimmed) {
      flush();
    } else {
      block.push(line);
    }
  }
  flush();
  return chunks;
}

export function buildRawChunks(corpusRoot = defaultCorpusRoot, options = {}) {
  const sourcesRoot = path.join(corpusRoot, "sources");
  const chunks = [];

  for (const filePath of walkFiles(sourcesRoot)) {
    const extension = path.extname(filePath).toLowerCase();
    if (![".md", ".markdown", ".txt"].includes(extension)) continue;
    const source = `sources/${normalizeSource(path.relative(sourcesRoot, filePath))}`;
    const text = fs.readFileSync(filePath, "utf8");
    chunks.push(
      ...(extension === ".txt"
        ? parseText(source, text)
        : parseMarkdown(source, text)),
    );
  }

  return groupRawChunks(chunks, options);
}

function flattenEvidence(evidence) {
  if (!evidence) return [];
  return (Array.isArray(evidence) ? evidence : [evidence]).map((item) => ({
    source: normalizeSource(item.source),
    section: item.section || "本文",
  }));
}

function valueText(value) {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value, null, 0);
}

function bestEvidenceForSource(source, topic, rawChunks) {
  const candidates = rawChunks.filter((chunk) => chunk.source === source);
  if (candidates.length === 0) return { source, section: "本文" };
  const index = new Bm25Index(candidates);
  const best = index.search(topic, 1)[0]?.document ?? candidates[0];
  return { source: best.source, section: best.section };
}

function sourceIdsToEvidence(documentIds, rawChunks) {
  const evidence = [];
  for (const documentId of documentIds) {
    const chunk = rawChunks.find(
      (candidate) =>
        candidate.section === "文書メタデータ" &&
        candidate.text.includes(documentId),
    );
    if (chunk) evidence.push({ source: chunk.source, section: chunk.section });
  }
  return evidence;
}

export function buildOracleChunks(expected, rawChunks, gold = {}) {
  const chunks = [];

  for (const claim of expected.expected_claims ?? []) {
    chunks.push({
      id: `oracle:claim:${claim.id}`,
      evidence: flattenEvidence(claim.evidence),
      text: [
        "種別: Claim",
        `主語: ${valueText(claim.subject)}`,
        `述語: ${valueText(claim.predicate)}`,
        `目的語: ${valueText(claim.object)}`,
        claim.condition ? `条件: ${valueText(claim.condition)}` : "",
        claim.status ? `状態: ${claim.status}` : "",
        claim.valid_from ? `有効開始: ${claim.valid_from}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    });
  }

  for (const conflict of expected.expected_conflicts ?? []) {
    const evidence = conflict.evidence
      ? flattenEvidence(conflict.evidence)
      : (conflict.sources ?? []).map((source) =>
          bestEvidenceForSource(source, conflict.topic, rawChunks),
        );
    chunks.push({
      id: `oracle:conflict:${conflict.id}`,
      unit_type: "conflict",
      evidence,
      text: [
        "種別: Conflict",
        `論点: ${conflict.topic}`,
        `分類: ${conflict.type}`,
        `解決方針: ${conflict.resolution}`,
        conflict.severity ? `重大度: ${conflict.severity}` : "",
        conflict.open_question ? `未解決事項: ${conflict.open_question}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    });
  }

  for (const cluster of expected.alias_clusters ?? []) {
    chunks.push({
      id: `oracle:alias:${cluster.canonical}`,
      evidence: flattenEvidence(cluster.evidence),
      text: [
        "種別: Alias",
        `正式名称: ${cluster.canonical}`,
        `別名: ${(cluster.aliases ?? []).join("、")}`,
      ].join("\n"),
    });
  }

  for (const missing of expected.expected_missing_information ?? []) {
    chunks.push({
      id: `oracle:missing:${missing.id}`,
      evidence: [{ source: missing.source, section: missing.section }],
      text: [
        "種別: Missing Information",
        `対象: ${missing.subject}`,
        `不足: ${missing.type}`,
        `重大度: ${missing.severity}`,
      ].join("\n"),
    });
  }

  for (const item of expected.not_conflicts ?? []) {
    chunks.push({
      id: `oracle:not-conflict:${chunks.length}`,
      evidence: [bestEvidenceForSource(item.source, item.topic, rawChunks)],
      text: [
        "種別: Not Conflict",
        `論点: ${item.topic}`,
        `判断: ${item.reason}`,
      ].join("\n"),
    });
  }

  for (const group of expected.version_groups ?? []) {
    const documentIds = [group.current, ...(group.superseded ?? [])];
    chunks.push({
      id: `oracle:version:${group.series_id}`,
      evidence: sourceIdsToEvidence(documentIds, rawChunks),
      text: [
        "種別: Version Group",
        `系列: ${group.series_id}`,
        `現行: ${group.current}`,
        `旧版: ${(group.superseded ?? []).join("、")}`,
      ].join("\n"),
    });
  }

  for (const sequence of expected.event_sequences ?? []) {
    const evidence = (sequence.events ?? []).map((event) => ({
      source: normalizeSource(event.source),
      section: event.section || "本文",
    }));
    chunks.push({
      id: `oracle:event-sequence:${sequence.id}`,
      evidence,
      text: [
        "種別: Event Sequence",
        `論点: ${sequence.topic}`,
        ...(sequence.events ?? []).map(
          (event) =>
            `${event.date}: 状態=${event.state}, 内容=${valueText(event.value)}`,
        ),
      ].join("\n"),
    });
  }

  for (const answer of gold.answers ?? []) {
    chunks.push({
      id: `oracle:gold-answer:${answer.question_id}`,
      evidence: flattenEvidence(answer.gold_evidence),
      text: [
        "種別: Gold Claim Bundle",
        `回答要素: ${(answer.required_answer_elements ?? []).join("、")}`,
        `期待動作: ${answer.expected_behavior}`,
        ...(answer.gold_evidence ?? []).flatMap((item) =>
          (item.content_terms ?? []).map((term) => `根拠語: ${term}`),
        ),
      ].join("\n"),
    });
  }

  for (const conflict of gold.conflicts ?? []) {
    chunks.push({
      id: `oracle:gold-conflict:${conflict.conflict_id}`,
      unit_type: "conflict",
      evidence: (conflict.sources ?? []).map((source) =>
        bestEvidenceForSource(source, conflict.topic, rawChunks),
      ),
      text: [
        "種別: Gold Conflict",
        `論点: ${conflict.topic}`,
        `状態: ${conflict.status}`,
        `優先値: ${conflict.canonical_value}`,
        `競合値: ${conflict.conflicting_value}`,
      ].join("\n"),
    });
  }

  for (const alias of gold.aliases ?? []) {
    chunks.push({
      id: `oracle:gold-alias:${alias.alias_id}`,
      evidence: [{
        source: normalizeSource(alias.evidence),
        section: "本文",
      }],
      text: [
        "種別: Gold Alias",
        `正式名称: ${alias.canonical}`,
        `別名: ${(alias.aliases ?? []).join("、")}`,
        `担当: ${alias.owner}`,
      ].join("\n"),
    });
  }

  for (const version of gold.versions ?? []) {
    chunks.push({
      id: `oracle:gold-version:${version.series_id}`,
      evidence: [bestEvidenceForSource(version.source, version.topic, rawChunks)],
      text: [
        "種別: Gold Version Group",
        `論点: ${version.topic}`,
        `現行: ${version.current}`,
        `旧版: ${(version.superseded ?? []).join("、")}`,
      ].join("\n"),
    });
  }

  return chunks;
}

export function buildActualChunks(buildDirectories, options = {}) {
  const {
    authorityBoost = true,
    evidenceFallback = false,
    includeClaims = true,
    includeConflicts = true,
    includeDiagnosticAliases = false,
    includeRelationDossiers = false,
  } = options;
  const claimsById = new Map();
  const evidenceById = new Map();
  const conflictsById = new Map();
  const diagnosticsById = new Map();
  const relationDossiers = [];
  const authorityPrecedenceByIntent = new Map();
  const allEvidence = [];

  for (const buildDirectory of buildDirectories) {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(buildDirectory, "build-manifest.json"), "utf8"),
    );
    const intentId = manifest.intent_id;
    const provenancePath = path.join(buildDirectory, "provenance.json");
    if (fs.existsSync(provenancePath)) {
      const provenance = JSON.parse(fs.readFileSync(provenancePath, "utf8"));
      authorityPrecedenceByIntent.set(
        intentId,
        provenance.authority_precedence ?? [],
      );
    }
    for (const evidence of readJsonl(path.join(buildDirectory, "evidence.jsonl"))) {
      evidenceById.set(
        `${intentId}/${evidence.source_id}/${evidence.evidence_id}`,
        evidence,
      );
      allEvidence.push({ intentId, evidence });
    }
    for (const claim of readJsonl(path.join(buildDirectory, "claims.jsonl"))) {
      claimsById.set(`${intentId}/${claim.id}`, { ...claim, intent_id: intentId });
    }
    for (const conflict of readJsonl(path.join(buildDirectory, "conflicts.jsonl"))) {
      conflictsById.set(`${intentId}/${conflict.id}`, {
        ...conflict,
        intent_id: intentId,
      });
    }
    for (const diagnostic of readJsonl(path.join(buildDirectory, "diagnostics.jsonl"))) {
      diagnosticsById.set(`${intentId}/${diagnostic.id}`, {
        ...diagnostic,
        intent_id: intentId,
      });
    }
    if (includeRelationDossiers) {
      for (const dossier of readOptionalJsonl(path.join(buildDirectory, "relation-dossiers.jsonl"))) {
        relationDossiers.push({ ...dossier, intent_id: dossier.intent_id ?? intentId });
      }
    }
  }

  const claimEvidence = (claim) =>
    (claim.evidence ?? [])
      .map((reference) =>
        evidenceById.get(
          `${claim.intent_id}/${reference.source_id}/${reference.evidence_id}`,
        ),
      )
      .filter(Boolean)
      .map((evidence) => ({
        source_id: evidence.source_id,
        source: normalizeSource(`sources/${evidence.source_path}`),
        section: (evidence.heading_path ?? []).join(" / ") || "本文",
        text: evidence.text,
      }));
  const unitsByEvidence = new Map();
  if (evidenceFallback) {
    for (const { intentId, evidence } of allEvidence) {
      const key = `${intentId}/${evidence.source_id}/${evidence.evidence_id}`;
      unitsByEvidence.set(key, {
        intentId,
        evidence,
        claims: new Map(),
      });
    }
  }
  for (const claim of claimsById.values()) {
    for (const reference of claim.evidence ?? []) {
      const evidenceKey = `${reference.source_id}/${reference.evidence_id}`;
      const evidence = evidenceById.get(`${claim.intent_id}/${evidenceKey}`);
      if (!evidence) continue;
      const key = `${claim.intent_id}/${evidenceKey}`;
      if (!unitsByEvidence.has(key)) {
        unitsByEvidence.set(key, {
          intentId: claim.intent_id,
          evidence,
          claims: new Map(),
        });
      }
      unitsByEvidence.get(key).claims.set(claim.id, claim);
    }
  }
  const chunks = [...unitsByEvidence.entries()].map(
    ([key, { intentId, evidence, claims }]) => {
      const authority =
        evidence.authority ??
        [...claims.values()].find((claim) => claim.authority)?.authority;
      const precedence = authorityPrecedenceByIntent.get(intentId) ?? [];
      const authorityRank = precedence.indexOf(authority);
      return {
      id: `actual:evidence:${key}`,
      unit_type: "claim_evidence",
      intent_id: intentId,
      valid_from: evidence.valid_from,
      valid_to: evidence.valid_to,
      score_boost:
        !authorityBoost || authorityRank < 0
          ? 1
          : 1 + (precedence.length - authorityRank) * 0.05,
      evidence: [
        evidence.source_path,
        ...(evidence.source_aliases ?? []),
      ].map((sourcePath) => ({
        source_id: evidence.source_id,
        source: normalizeSource(`sources/${sourcePath}`),
        section: (evidence.heading_path ?? []).join(" / ") || "本文",
        text: evidence.text,
      })),
      evidence_excerpt: evidence.text,
      authority,
      authority_rank: authorityRank >= 0 ? authorityRank + 1 : null,
      claims: [...claims.values()],
      text: [
        "種別: Compiled Retrieval Unit",
        `根拠位置: ${(evidence.heading_path ?? []).join(" / ") || "本文"}`,
        `根拠本文: ${evidence.text}`,
        authority ? `文書権威: ${authority}` : "",
        authorityRank >= 0
          ? `権威優先順位: ${authorityRank + 1}（小さいほど優先）`
          : "",
        ...(includeClaims
          ? [...claims.values()].flatMap((claim, index) => [
              `Claim ${index + 1}`,
              `主語: ${valueText(claim.subject)}`,
              `述語: ${valueText(claim.predicate)}`,
              `目的語: ${valueText(claim.object)}`,
              claim.predicate === "is_alias_of"
                ? `別名関係: ${[
                    claim.subject,
                    ...(Array.isArray(claim.object)
                      ? claim.object
                      : [claim.object]),
                  ].join(" = ")}`
                : "",
              claim.condition ? `条件: ${claim.condition}` : "",
              claim.status ? `状態: ${claim.status}` : "",
              claim.valid_from ? `有効開始: ${claim.valid_from}` : "",
              claim.valid_to ? `有効終了: ${claim.valid_to}` : "",
              claim.authority ? `権威: ${claim.authority}` : "",
            ])
          : []),
      ]
        .filter(Boolean)
        .join("\n"),
      };
    },
  );

  for (const conflict of includeConflicts ? conflictsById.values() : []) {
    const claims = (conflict.claim_ids ?? [])
      .map((id) => claimsById.get(`${conflict.intent_id}/${id}`))
      .filter(Boolean);
    const diagnostic = diagnosticsById.get(
      `${conflict.intent_id}/${conflict.diagnostic_id}`,
    );
    chunks.push({
      id: `actual:conflict:${conflict.intent_id}/${conflict.id}`,
      unit_type: "conflict",
      intent_id: conflict.intent_id,
      validity_ranges: claims.map((claim) => ({
        valid_from: claim.valid_from,
        valid_to: claim.valid_to,
      })),
      evidence: claims.flatMap(claimEvidence),
      conflict: {
        id: conflict.id,
        kind: conflict.kind,
        status: conflict.status,
        resolution: conflict.resolution,
        diagnostic_message: diagnostic?.message,
        diagnostic_reason: diagnostic?.reason,
        claims,
      },
      text: [
        "種別: Conflict",
        `分類: ${conflict.kind}`,
        `状態: ${conflict.status}`,
        ...claims.map(
          (claim, index) =>
            `候補${index + 1}: ${claim.subject} ${claim.predicate} ${valueText(claim.object)}`,
        ),
        conflict.resolution ? `解決: ${conflict.resolution}` : "",
        diagnostic?.message ? `診断: ${diagnostic.message}` : "",
        diagnostic?.reason ? `理由: ${diagnostic.reason}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    });
  }
  for (const dossier of relationDossiers) {
    const cited = (dossier.evidence ?? [])
      .map((reference) => evidenceById.get(`${dossier.intent_id}/${reference.source_id}/${reference.evidence_id}`))
      .filter(Boolean);
    chunks.push({
      id: `actual:relation-dossier:${dossier.intent_id}/${dossier.id}`,
      unit_type: dossier.kind === "conflicts_with" ? "conflict" : "relation_dossier",
      intent_id: dossier.intent_id,
      evidence: cited.flatMap((item) => [item.source_path, ...(item.source_aliases ?? [])].map((sourcePath) => ({
        source_id: item.source_id,
        source: normalizeSource(`sources/${sourcePath}`),
        section: (item.heading_path ?? []).join(" / ") || "本文",
        text: item.text,
      }))),
      relation: dossier,
      text: dossier.text,
    });
  }
  for (const diagnostic of diagnosticsById.values()) {
    if (diagnostic.code !== "FRG-CST-MISSING-OWNER") continue;
    const cited = (diagnostic.evidence_ids ?? [])
      .map((evidenceId) =>
        [...evidenceById.values()].find(
          (item) =>
            item.evidence_id === evidenceId &&
            evidenceById.get(
              `${diagnostic.intent_id}/${item.source_id}/${item.evidence_id}`,
            ) === item,
        ),
      )
      .filter(Boolean);
    chunks.push({
      id: `actual:diagnostic:${diagnostic.intent_id}/${diagnostic.id}`,
      unit_type: "diagnostic",
      intent_id: diagnostic.intent_id,
      valid_from: cited[0]?.valid_from,
      valid_to: cited[0]?.valid_to,
      evidence: cited.flatMap((item) =>
        [
          item.source_path,
          ...(includeDiagnosticAliases ? item.source_aliases ?? [] : []),
        ].map((sourcePath) => ({
          source: normalizeSource(`sources/${sourcePath}`),
          section: (item.heading_path ?? []).join(" / ") || "本文",
          text: item.text,
        })),
      ),
      text: [
        "種別: Missing Information",
        `診断: ${diagnostic.message}`,
        `理由: ${diagnostic.reason}`,
        ...(diagnostic.suggestions ?? []).map((item) => `対応案: ${item}`),
        ...(diagnostic.questions ?? []).map((item) => `未解決質問: ${item}`),
      ].join("\n"),
    });
  }
  return chunks;
}

export function tokenize(input, options = {}) {
  const normalized = String(input)
    .normalize("NFKC")
    .toLowerCase();
  const tokens = normalized.match(/[a-z0-9_]+/g) ?? [];
  const compact = Array.from(normalized.replace(/[^\p{L}\p{N}]+/gu, ""));
  for (const size of options.ngramSizes ?? [2, 3]) {
    for (let index = 0; index <= compact.length - size; index += 1) {
      tokens.push(compact.slice(index, index + size).join(""));
    }
  }
  return tokens;
}

export class Bm25Index {
  constructor(documents, options = {}) {
    this.documents = documents;
    this.k1 = options.k1 ?? 1.5;
    this.b = options.b ?? 0.75;
    this.tokenizeOptions = { ngramSizes: options.ngramSizes ?? [2, 3] };
    this.documentLengths = [];
    this.documentFrequency = new Map();
    this.postings = new Map();
    let totalLength = 0;
    for (let documentIndex = 0; documentIndex < documents.length; documentIndex += 1) {
      const tokens = tokenize(documents[documentIndex].text, this.tokenizeOptions);
      this.documentLengths.push(tokens.length);
      totalLength += tokens.length;
      const frequencies = new Map();
      for (const token of tokens) {
        frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
      }
      for (const [token, frequency] of frequencies) {
        this.documentFrequency.set(
          token,
          (this.documentFrequency.get(token) ?? 0) + 1,
        );
        if (!this.postings.has(token)) this.postings.set(token, []);
        this.postings.get(token).push([documentIndex, frequency]);
      }
    }
    this.averageLength = totalLength / Math.max(documents.length, 1);
  }

  withParameters(options = {}) {
    const index = Object.create(Bm25Index.prototype);
    Object.assign(index, this, {
      k1: options.k1 ?? this.k1,
      b: options.b ?? this.b,
    });
    return index;
  }

  search(query, limit = 5, filter = null) {
    const queryTokens = tokenize(query, this.tokenizeOptions);
    const queryFrequency = new Map();
    for (const token of queryTokens) {
      queryFrequency.set(token, (queryFrequency.get(token) ?? 0) + 1);
    }

    const scores = new Map();
    for (const [token, queryCount] of queryFrequency) {
      const postings = this.postings.get(token) ?? [];
      const documentsWithToken = this.documentFrequency.get(token) ?? 0;
      const idf = Math.log(
        1 +
          (this.documents.length - documentsWithToken + 0.5) /
            (documentsWithToken + 0.5),
      );
      for (const [documentIndex, frequency] of postings) {
        const denominator =
          frequency +
          this.k1 *
            (1 -
              this.b +
              this.b * (this.documentLengths[documentIndex] / Math.max(this.averageLength, 1)));
        const contribution =
          idf *
          ((frequency * (this.k1 + 1)) / denominator) *
          Math.min(queryCount, 3);
        scores.set(documentIndex, (scores.get(documentIndex) ?? 0) + contribution);
      }
    }
    const scored = [...scores].map(([documentIndex, score]) => {
      const document = this.documents[documentIndex];
      return { document, score: score * (document.score_boost ?? 1) };
    });

    return scored
      .filter(
        (item) =>
          item.score > 0 && (!filter || filter(item.document)),
      )
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.document.id.localeCompare(right.document.id, "ja"),
      )
      .slice(0, limit);
  }
}

export function retrieve(index, questions, topK, options = {}) {
  const byQuestion = new Map();
  const supportsIntentFilter = index.documents.some(
    (document) => document.intent_id,
  );
  for (const question of questions) {
    const query = options.queryMode === "question-only"
      ? question.question
      : `${question.question}\n対象時点: ${question.as_of}`;
    byQuestion.set(
      question.id,
      index.search(
        query,
        topK,
        supportsIntentFilter
          ? (document) =>
              document.intent_id === question.intent_id &&
              documentMatchesAsOf(document, question.as_of)
          : null,
      ),
    );
  }
  return byQuestion;
}

export function documentMatchesAsOf(document, asOf) {
  const active = (range) =>
    (!range.valid_from || range.valid_from <= asOf) &&
    (!range.valid_to || asOf <= range.valid_to);
  if (Array.isArray(document.validity_ranges)) {
    const known = document.validity_ranges.filter(
      (range) => range.valid_from || range.valid_to,
    );
    const unknownCount = document.validity_ranges.length - known.length;
    if (known.length === 0 || unknownCount > 0) return true;
    return known.filter(active).length !== 1;
  }
  return active(document);
}

export function expandedEvidence(retrieved) {
  const evidence = [];
  const seen = new Set();
  for (const [index, item] of retrieved.entries()) {
    for (const reference of item.document.evidence ?? []) {
      const key = `${reference.source}#${reference.section}`;
      if (seen.has(key)) continue;
      seen.add(key);
      evidence.push({
        ...reference,
        rank: index + 1,
        retrieval_text: item.document.text,
      });
    }
  }
  return evidence;
}

function evidenceMatches(left, right) {
  const leftSection = String(left.section ?? "").trim();
  const rightSection = String(right.section ?? "").trim();
  const locationMatches =
    normalizeSource(left.source) === normalizeSource(right.source) &&
    (!left.section ||
      leftSection === rightSection ||
      rightSection.endsWith(` / ${leftSection}`) ||
      leftSection.endsWith(` / ${rightSection}`));
  if (!locationMatches) return false;
  const contentTerms = left.content_terms ?? [];
  if (contentTerms.length === 0) return true;
  const retrievalText = String(right.retrieval_text ?? right.text ?? "")
    .normalize("NFKC")
    .toLowerCase();
  return contentTerms.every((term) =>
    retrievalText.includes(String(term).normalize("NFKC").toLowerCase()),
  );
}

function evidenceLocationMatches(left, right) {
  const leftSection = String(left.section ?? "").trim();
  const rightSection = String(right.section ?? "").trim();
  return (
    normalizeSource(left.source) === normalizeSource(right.source) &&
    (!left.section ||
      leftSection === rightSection ||
      rightSection.endsWith(` / ${leftSection}`) ||
      leftSection.endsWith(` / ${rightSection}`))
  );
}

function requiredEvidenceForRelevance(question) {
  const conflictEvidence = question.conflict_evidence ?? {};
  return [
    ...(question.required_evidence ?? []),
    ...(conflictEvidence.canonical ?? []),
    ...(conflictEvidence.conflicting ?? []),
  ];
}

function documentMatchesEvidence(document, requiredEvidence) {
  const candidates = expandedEvidence([{ document }]);
  return requiredEvidence.some((required) =>
    candidates.some((candidate) => evidenceMatches(required, candidate))
  );
}

function documentMatchesConflictSides(document, conflictEvidence) {
  const references = document.evidence ?? [];
  const sideMatches = (side) =>
    side.every((required) =>
      references.some((candidate) =>
        evidenceLocationMatches(required, candidate)
      )
    );
  return (
    document.unit_type === "conflict" &&
    sideMatches(conflictEvidence.canonical ?? []) &&
    sideMatches(conflictEvidence.conflicting ?? [])
  );
}

function evidenceRank(required, retrieved) {
  for (const [index, item] of retrieved.entries()) {
    if (item.document.unit_type === "conflict") continue;
    const candidates = expandedEvidence([item]);
    if (candidates.some((candidate) => evidenceMatches(required, candidate))) {
      return index + 1;
    }
  }
  return null;
}

function conflictRetrievalMetrics(
  question,
  retrieved,
  supportsConflictUnits,
) {
  const conflictEvidence = question.conflict_evidence;
  if (!conflictEvidence) {
    return {
      conflict_recall: null,
      conflict_complete: null,
      conflict_unit_recall: null,
      resolution_accuracy: null,
    };
  }
  const actual = expandedEvidence(retrieved);
  const expected = [
    ...(conflictEvidence.canonical ?? []),
    ...(conflictEvidence.conflicting ?? []),
  ];
  const matched = expected.filter((required) =>
    actual.some((candidate) => evidenceMatches(required, candidate))
  ).length;
  const conflictRecall = expected.length === 0 ? null : matched / expected.length;
  const canonicalRanks = (conflictEvidence.canonical ?? [])
    .map((required) => evidenceRank(required, retrieved))
    .filter((rank) => rank !== null);
  const conflictingRanks = (conflictEvidence.conflicting ?? [])
    .map((required) => evidenceRank(required, retrieved))
    .filter((rank) => rank !== null);
  const resolutionAccuracy =
    canonicalRanks.length === (conflictEvidence.canonical ?? []).length &&
      conflictingRanks.length === (conflictEvidence.conflicting ?? []).length
      ? Math.min(...canonicalRanks) < Math.min(...conflictingRanks)
        ? 1
        : 0
      : null;
  return {
    conflict_recall: conflictRecall,
    conflict_complete: conflictRecall === 1 ? 1 : 0,
    conflict_unit_recall: supportsConflictUnits
      ? retrieved.some((item) =>
          documentMatchesConflictSides(item.document, conflictEvidence)
        )
        ? 1
        : 0
      : null,
    resolution_accuracy: resolutionAccuracy,
  };
}

function distractorRate(question, retrieved) {
  if (retrieved.length === 0) return null;
  const requiredEvidence = requiredEvidenceForRelevance(question);
  const relevant = retrieved.filter((item) =>
    documentMatchesEvidence(item.document, requiredEvidence) ||
    (question.conflict_evidence &&
      documentMatchesConflictSides(item.document, question.conflict_evidence))
  ).length;
  return 1 - relevant / retrieved.length;
}

export function retrievalRecall(question, retrieved) {
  if (question.required_evidence.length === 0) return 1;
  const actual = expandedEvidence(retrieved);
  const matched = question.required_evidence.filter((required) =>
    actual.some((candidate) => evidenceMatches(required, candidate)),
  ).length;
  return matched / question.required_evidence.length;
}

export function retrievalPrecision(question, retrieved) {
  const required = question.required_evidence ?? [];
  if (required.length === 0) return null;
  if (retrieved.length === 0) return 0;
  const unmatched = new Set(required.map((_, index) => index));
  let novelRelevantUnits = 0;
  for (const item of retrieved) {
    const candidates = expandedEvidence([item]);
    const matched = [...unmatched].filter((index) =>
      candidates.some((candidate) => evidenceMatches(required[index], candidate))
    );
    if (matched.length === 0) continue;
    novelRelevantUnits += 1;
    for (const index of matched) unmatched.delete(index);
  }
  return novelRelevantUnits / retrieved.length;
}

function mean(values) {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function retrievalBreakdown(details, field, retrievalKs) {
  const groups = new Map();
  for (const detail of details) {
    const values = field === "tags" ? detail.tags : [detail[field]];
    for (const value of values) {
      if (!groups.has(value)) groups.set(value, []);
      groups.get(value).push(detail);
    }
  }
  return Object.fromEntries(
    [...groups.entries()]
      .sort(([left], [right]) => left.localeCompare(right, "ja"))
      .map(([value, group]) => [
        value,
        {
          questions: group.length,
          recall_at_k: Object.fromEntries(
            retrievalKs.map((topK) => [
              String(topK),
              mean(group.map((item) => item.recall_at_k[String(topK)])),
            ]),
          ),
          complete_at_k: Object.fromEntries(
            retrievalKs.map((topK) => [
              String(topK),
              mean(group.map((item) => item.complete_at_k[String(topK)])),
            ]),
          ),
          precision_at_k: Object.fromEntries(
            retrievalKs.map((topK) => [
              String(topK),
              mean(
                group
                  .map((item) => item.precision_at_k[String(topK)])
                  .filter((value) => value !== null && value !== undefined),
              ),
            ]),
          ),
        },
      ]),
  );
}

export function scoreRetrieval(
  questions,
  retrievalByQuestion,
  retrievalKs = [5, 10, 20],
  options = {},
) {
  const supportsConflictUnits = options.supportsConflictUnits ??
    [...retrievalByQuestion.values()].some((items) =>
      items.some((item) => item.document.unit_type === "conflict")
    );
  const details = questions.map((question) => {
    const retrieved = retrievalByQuestion.get(question.id) ?? [];
    const qualityAtK = Object.fromEntries(
      retrievalKs.map((topK) => {
        const selected = retrieved.slice(0, topK);
        return [
          String(topK),
          {
            recall: retrievalRecall(question, selected),
            precision: retrievalPrecision(question, selected),
            distractor_rate: distractorRate(question, selected),
            ...conflictRetrievalMetrics(
              question,
              selected,
              supportsConflictUnits,
            ),
          },
        ];
      }),
    );
    return {
      question_id: question.id,
      cohort: question.id.startsWith("M-") ? "added84" : "legacy16",
      intent_id: question.intent_id,
      tags: question.tags,
      recall_at_k: Object.fromEntries(
        retrievalKs.map((topK) => [
          String(topK),
          qualityAtK[String(topK)].recall,
        ]),
      ),
      complete_at_k: Object.fromEntries(
        retrievalKs.map((topK) => [
          String(topK),
          qualityAtK[String(topK)].recall === 1 ? 1 : 0,
        ]),
      ),
      precision_at_k: Object.fromEntries(
        retrievalKs.map((topK) => [
          String(topK),
          qualityAtK[String(topK)].precision,
        ]),
      ),
      distractor_rate_at_k: Object.fromEntries(
        retrievalKs.map((topK) => [
          String(topK),
          qualityAtK[String(topK)].distractor_rate,
        ]),
      ),
      conflict_recall_at_k: Object.fromEntries(
        retrievalKs.map((topK) => [
          String(topK),
          qualityAtK[String(topK)].conflict_recall,
        ]),
      ),
      conflict_complete_at_k: Object.fromEntries(
        retrievalKs.map((topK) => [
          String(topK),
          qualityAtK[String(topK)].conflict_complete,
        ]),
      ),
      conflict_unit_recall_at_k: Object.fromEntries(
        retrievalKs.map((topK) => [
          String(topK),
          qualityAtK[String(topK)].conflict_unit_recall,
        ]),
      ),
      resolution_accuracy_at_k: Object.fromEntries(
        retrievalKs.map((topK) => [
          String(topK),
          qualityAtK[String(topK)].resolution_accuracy,
        ]),
      ),
      retrieved: expandedEvidence(retrieved),
    };
  });
  const conflictDetails = details.filter((item) =>
    questions.find((question) => question.id === item.question_id)
      ?.conflict_evidence
  );
  const nonNullMean = (values) =>
    mean(values.filter((value) => value !== null && value !== undefined));
  return {
    questions: questions.length,
    conflict_questions: conflictDetails.length,
    supports_conflict_units: supportsConflictUnits,
    recall_at_k: Object.fromEntries(
      retrievalKs.map((topK) => [
        String(topK),
        mean(details.map((item) => item.recall_at_k[String(topK)])),
      ]),
    ),
    complete_at_k: Object.fromEntries(
      retrievalKs.map((topK) => [
        String(topK),
        mean(details.map((item) => item.complete_at_k[String(topK)])),
      ]),
    ),
    precision_at_k: Object.fromEntries(
      retrievalKs.map((topK) => [
        String(topK),
        nonNullMean(
          details.map((item) => item.precision_at_k[String(topK)]),
        ),
      ]),
    ),
    distractor_rate_at_k: Object.fromEntries(
      retrievalKs.map((topK) => [
        String(topK),
        nonNullMean(
          details.map((item) => item.distractor_rate_at_k[String(topK)]),
        ),
      ]),
    ),
    conflict_recall_at_k: Object.fromEntries(
      retrievalKs.map((topK) => [
        String(topK),
        nonNullMean(
          conflictDetails.map(
            (item) => item.conflict_recall_at_k[String(topK)],
          ),
        ),
      ]),
    ),
    conflict_complete_rate_at_k: Object.fromEntries(
      retrievalKs.map((topK) => [
        String(topK),
        nonNullMean(
          conflictDetails.map(
            (item) => item.conflict_complete_at_k[String(topK)],
          ),
        ),
      ]),
    ),
    conflict_unit_recall_at_k: Object.fromEntries(
      retrievalKs.map((topK) => [
        String(topK),
        supportsConflictUnits
          ? nonNullMean(
              conflictDetails.map(
                (item) => item.conflict_unit_recall_at_k[String(topK)],
              ),
            )
          : null,
      ]),
    ),
    resolution_accuracy_at_k: Object.fromEntries(
      retrievalKs.map((topK) => [
        String(topK),
        nonNullMean(
          conflictDetails.map(
            (item) => item.resolution_accuracy_at_k[String(topK)],
          ),
        ),
      ]),
    ),
    resolution_evaluable_questions_at_k: Object.fromEntries(
      retrievalKs.map((topK) => [
        String(topK),
        conflictDetails.filter(
          (item) =>
            item.resolution_accuracy_at_k[String(topK)] !== null,
        ).length,
      ]),
    ),
    resolution_coverage_at_k: Object.fromEntries(
      retrievalKs.map((topK) => {
        const evaluable = conflictDetails.filter(
          (item) =>
            item.resolution_accuracy_at_k[String(topK)] !== null,
        ).length;
        return [
          String(topK),
          conflictDetails.length === 0 ? null : evaluable / conflictDetails.length,
        ];
      }),
    ),
    by_cohort: retrievalBreakdown(details, "cohort", retrievalKs),
    by_intent: retrievalBreakdown(details, "intent_id", retrievalKs),
    by_tag: retrievalBreakdown(details, "tags", retrievalKs),
    questions_detail: details,
  };
}

function coverageBreakdown(details, field) {
  const groups = new Map();
  for (const detail of details) {
    const values = field === "tags" ? detail.tags : [detail[field]];
    for (const value of values) {
      if (!groups.has(value)) groups.set(value, []);
      groups.get(value).push(detail);
    }
  }
  return Object.fromEntries(
    [...groups.entries()]
      .sort(([left], [right]) => left.localeCompare(right, "ja"))
      .map(([value, group]) => [
        value,
        {
          questions: group.length,
          compile_coverage: mean(group.map((item) => item.compile_coverage)),
        },
      ]),
  );
}

export function scoreCompileCoverage(questions, documents) {
  const details = questions.map((question) => {
    const matched = [];
    const missing = [];
    for (const required of question.required_evidence) {
      const present = documents.some((document) =>
        (document.evidence ?? []).some((candidate) =>
          evidenceMatches(required, {
            ...candidate,
            retrieval_text: document.text,
          })
        )
      );
      (present ? matched : missing).push(required);
    }
    return {
      question_id: question.id,
      cohort: question.id.startsWith("M-") ? "added84" : "legacy16",
      intent_id: question.intent_id,
      tags: question.tags,
      compile_coverage: question.required_evidence.length === 0
        ? 1
        : matched.length / question.required_evidence.length,
      matched_required_evidence: matched,
      missing_required_evidence: missing,
    };
  });
  return {
    questions: questions.length,
    compile_coverage: mean(details.map((item) => item.compile_coverage)),
    by_cohort: coverageBreakdown(details, "cohort"),
    by_intent: coverageBreakdown(details, "intent_id"),
    by_tag: coverageBreakdown(details, "tags"),
    questions_detail: details,
  };
}

function runRetrievalOnly(index, questions, retrievalKs, options = {}) {
  const maximumK = Math.max(...retrievalKs);
  return scoreRetrieval(
    questions,
    retrieve(index, questions, maximumK, options),
    retrievalKs,
    {
      supportsConflictUnits: index.documents.some(
        (document) => document.unit_type === "conflict",
      ),
    },
  );
}

function answerSchema(questionIds) {
  return {
    type: "object",
    properties: {
      results: {
        type: "array",
        minItems: questionIds.length,
        maxItems: questionIds.length,
        items: {
          type: "object",
          properties: {
            question_id: { type: "string", enum: questionIds },
            answer: { type: "string" },
            behavior: {
              type: "string",
              enum: ANSWER_BEHAVIORS,
            },
            citation_ids: {
              type: "array",
              items: { type: "string" },
            },
          },
          required: ["question_id", "answer", "behavior", "citation_ids"],
        },
      },
    },
    required: ["results"],
  };
}

function judgeSchema(questionIds) {
  return {
    type: "object",
    properties: {
      results: {
        type: "array",
        minItems: questionIds.length,
        maxItems: questionIds.length,
        items: {
          type: "object",
          properties: {
            question_id: { type: "string", enum: questionIds },
            behavior: {
              type: "string",
              enum: ANSWER_BEHAVIORS,
            },
            satisfied_answer_elements: {
              type: "array",
              items: { type: "string" },
            },
            present_forbidden_answer_elements: {
              type: "array",
              items: { type: "string" },
            },
          },
          required: [
            "question_id",
            "behavior",
            "satisfied_answer_elements",
            "present_forbidden_answer_elements",
          ],
        },
      },
    },
    required: ["results"],
  };
}

function evidenceId(questionId, contextIndex, evidenceIndex) {
  return `${questionId}-C${contextIndex + 1}-E${evidenceIndex + 1}`;
}

function contextText(questionId, retrieved) {
  return retrieved
    .map((item, index) => {
      const references = (item.document.evidence ?? [])
        .map(
          (reference, evidenceIndex) =>
            `[${evidenceId(questionId, index, evidenceIndex)}] ` +
            `${reference.source} # ${reference.section}`,
        )
        .join("\n");
      return [
        `### Context ${index + 1}`,
        `根拠候補:\n${references}`,
        item.document.text,
      ].join("\n");
    })
    .join("\n\n");
}

function searchForQuestion(index, question, query, limit, unitFilter = null) {
  const supportsIntentFilter = index.documents.some(
    (document) => document.intent_id,
  );
  return index.search(
    `${query}\n対象時点: ${question.as_of}`,
    limit,
    (document) =>
      (!supportsIntentFilter ||
        (document.intent_id === question.intent_id &&
          documentMatchesAsOf(document, question.as_of))) &&
      (!unitFilter || unitFilter(document)),
  );
}

function roundRobinUnique(resultLists, limit, seen = new Set()) {
  const selected = [];
  const maxLength = Math.max(0, ...resultLists.map((items) => items.length));
  for (let rank = 0; rank < maxLength && selected.length < limit; rank += 1) {
    for (const items of resultLists) {
      const item = items[rank];
      if (!item || seen.has(item.document.id)) continue;
      seen.add(item.document.id);
      selected.push(item);
      if (selected.length === limit) break;
    }
  }
  return selected;
}

function evidenceKey(reference) {
  return `${normalizeSource(reference.source)}#${reference.section ?? ""}`;
}

function relationQueryHints(text) {
  const hints = [];
  if (/レビュー/.test(text)) hints.push("requires_review");
  if (/承認/.test(text)) hints.push("requires_approval");
  if (/誰|担当|責任者|所有者/.test(text)) hints.push("has_owner");
  if (/期限|いつ|何営業日|何日|何時間|以内/.test(text)) {
    hints.push("deadline", "review_deadline", "notification_deadline");
  }
  if (/省略|不要|対象外/.test(text)) hints.push("allows_review_omission");
  return [...new Set(hints)].join(" ");
}

function canonicalTermsFromResults(results) {
  const terms = new Set();
  for (const item of results) {
    if (item.document.authority !== "corporate_reference") continue;
    for (const match of String(item.document.evidence_excerpt ?? "").matchAll(
      /\*\*([^*]+)\*\*/g,
    )) {
      terms.add(match[1].trim());
    }
  }
  return [...terms].filter(Boolean).slice(0, 6);
}

export function assembleDossierRetrieval(
  index,
  fallbackIndex,
  question,
  plan,
  topK,
  missingSlotIds = [],
) {
  const searchSlots = (canonicalTerms = []) => plan.slots.map((slot) =>
    searchForQuestion(
      index,
      question,
      `${question.question}\n回答項目: ${slot.label}\n検索語: ${slot.search_query}` +
        `\n関係ヒント: ${relationQueryHints(`${question.question} ${slot.label}`)}` +
        (canonicalTerms.length > 0
          ? `\n正規語: ${canonicalTerms.join(" ")}`
          : ""),
      topK,
      (document) => document.unit_type !== "conflict",
    ),
  );
  let claimLists = searchSlots();
  const initial = roundRobinUnique(claimLists, topK);
  const canonicalTerms = canonicalTermsFromResults(initial);
  if (canonicalTerms.length > 0) {
    claimLists = searchSlots(canonicalTerms);
  }
  const primary = roundRobinUnique(claimLists, topK);
  const primaryEvidence = new Set(
    primary.flatMap((item) => item.document.evidence ?? []).map(evidenceKey),
  );
  const conflictCandidates = searchForQuestion(
    index,
    question,
    `${question.question}\n${plan.slots.map((slot) => slot.search_query).join("\n")}`,
    2,
    (document) => document.unit_type === "conflict",
  );
  const conflicts = conflictCandidates.filter((item) => {
    return (item.document.evidence ?? []).some((reference) =>
      primaryEvidence.has(evidenceKey(reference)),
    );
  });

  const fallback = [];
  if (fallbackIndex && missingSlotIds.length > 0) {
    const missing = new Set(missingSlotIds);
    const fallbackLists = plan.slots
      .filter((slot) => missing.has(slot.id))
      .map((slot) =>
        searchForQuestion(
          fallbackIndex,
          question,
          `${question.question}\n不足している回答項目: ${slot.label}\n検索語: ${slot.search_query}`,
          2,
        ),
      );
    const seen = new Set(
      [...primary, ...conflicts].map((item) => item.document.id),
    );
    fallback.push(...roundRobinUnique(fallbackLists, missing.size * 2, seen));
  }
  return {
    primary,
    conflicts,
    fallback,
    retrieved: [...primary, ...conflicts, ...fallback],
  };
}

function dossierPlanSchema() {
  return {
    type: "object",
    properties: {
      slots: {
        type: "array",
        minItems: 1,
        maxItems: 5,
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            label: { type: "string" },
            search_query: { type: "string" },
          },
          required: ["id", "label", "search_query"],
        },
      },
    },
    required: ["slots"],
  };
}

function dossierPlanPrompt(question) {
  return `あなたは社内知識検索のプランナーです。質問へ答えるために必要な回答項目を、重複のない1〜5個のslotへ分解してください。答えそのものは作らず、検索語を作ってください。

規則:
- idは短い英小文字のsnake_caseにする。
- labelは「期限」「承認者」のような日本語の回答項目名にする。
- search_queryは日本語の対象語と関係語を必ず含め、末尾にKnowledge Buildのpredicate候補を英語で1〜2個加える。例: 「外部仕様 変更 設計レビュー 必要 requires_review」。
- 英語だけのsearch_queryは禁止する。
- 質問の具体表現に対応しそうな社内の正規語・上位概念・同義語を併記する。例: 「顧客向け画面の挙動 外部仕様」、「責任者 承認者 owner approver」。
- 各判断slotのsearch_queryにも質問の中心対象を繰り返す。関係語だけの検索にしない。
- 条件、例外、現行/旧版、権威性の確認が質問に必要なら独立slotにする。
- 同じ判断を「範囲」「要否」「工程」のように言い換えただけの重複slotは作らない。
- 単なる「概要」slotは作らない。

対象時点: ${question.as_of}
質問: ${question.question}`;
}

function normalizeDossierPlan(content) {
  const slots = [];
  const ids = new Set();
  for (const [index, raw] of (content.slots ?? []).entries()) {
    const base = String(raw.id ?? `slot_${index + 1}`)
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "") || `slot_${index + 1}`;
    let id = base;
    let suffix = 2;
    while (ids.has(id)) id = `${base}_${suffix++}`;
    ids.add(id);
    slots.push({
      id,
      label: String(raw.label ?? id).trim(),
      search_query: String(raw.search_query ?? raw.label ?? id).trim(),
    });
  }
  if (slots.length === 0) {
    throw new Error("dossier plan did not contain answer slots");
  }
  return { slots: slots.slice(0, 5) };
}

export function augmentDossierPlan(question, plan) {
  const slots = [...plan.slots];
  const searchable = () => slots
    .map((slot) => `${slot.id} ${slot.label} ${slot.search_query}`)
    .join(" ");
  const add = (slot, coveredBy) => {
    if (!coveredBy.test(searchable()) && slots.length < 5) slots.push(slot);
  };
  if (/どの規則|どの版|現行.*規則|規則.*適用/.test(question.question)) {
    add(
      {
        id: "applicable_version",
        label: "適用する現行版と旧版の失効",
        search_query: `${question.question} 第2版 第1版 置き換える 適用期間 終了 supersedes`,
      },
      /現行版|旧版|第2版|失効|supersed/,
    );
  }
  if (/FAQ/.test(question.question) && /食い違|矛盾|不一致|競合/.test(question.question)) {
    add(
      {
        id: "stale_guidance",
        label: "FAQの旧案内と最新版の未反映状態",
        search_query: `${question.question} FAQ 旧案内 第2版 反映していない`,
      },
      /未反映|反映していない|旧案内|stale/,
    );
    add(
      {
        id: "canonical_requirement",
        label: "正式規程の現行要件",
        search_query: `${question.question} 正式規程 現行規則 第2版 要件`,
      },
      /現行要件|現行規則|正式規程.*要件|canonical/,
    );
  }
  return { slots };
}

function dossierSlotSchema(plan) {
  return {
    type: "object",
    properties: {
      behavior: {
        type: "string",
        enum: ANSWER_BEHAVIORS,
      },
      slots: {
        type: "array",
        minItems: plan.slots.length,
        maxItems: plan.slots.length,
        items: {
          type: "object",
          properties: {
            slot_id: {
              type: "string",
              enum: plan.slots.map((slot) => slot.id),
            },
            status: {
              type: "string",
              enum: ["supported", "unresolved", "missing"],
            },
            value: { type: "string" },
            citation_ids: {
              type: "array",
              items: { type: "string" },
            },
          },
          required: ["slot_id", "status", "value", "citation_ids"],
        },
      },
      guardrails: {
        type: "array",
        items: { type: "string" },
      },
    },
    required: ["behavior", "slots", "guardrails"],
  };
}

function dossierSlotPrompt(question, plan, dossier) {
  const conflicts = dossier.conflicts.length > 0
    ? dossier.conflicts
        .map((item) => item.document.text)
        .join("\n\n")
    : "関連するConflictは取得されていません。";
  return `あなたはEvidence Dossierの組立担当です。検索資料だけを使い、各Answer Slotを構造化してください。まだ自然文の最終回答は作りません。

規則:
- status=supportedは、valueを直接支える根拠IDがある場合だけ。
- status=unresolvedは、候補が矛盾し権威・時点でも一意に解消できない場合。valueに候補と判断不能理由を書く。
- status=missingは資料が不足する場合。推測しない。
- citation_idsにはvalueを支える角括弧内IDを入れる。
- 正式文書、時点、権威順位を優先する。
- 根拠と出典を示して答えられる場合はbehaviorをanswer_with_provenanceにする。
- Conflictが未解決、または質問が文書間の食い違いを明示的に尋ねる場合は、behaviorをanswer_with_conflict_disclosureにする。
- 解決済みの過去版や古い案内が取得資料に含まれるだけなら、behaviorをanswer_with_conflict_disclosureにしない。

対象時点: ${question.as_of}
質問: ${question.question}
Answer Slots:
${plan.slots.map((slot) => `- ${slot.id}: ${slot.label}`).join("\n")}

取得資料:
${contextText(question.id, dossier.retrieved)}

Conflict別枠:
${conflicts}`;
}

function normalizeDossierSlots(content, plan, question, retrieved) {
  const lookup = citationLookup(question, retrieved);
  const rawById = new Map(
    (content.slots ?? []).map((slot) => [slot.slot_id, slot]),
  );
  const slots = plan.slots.map((planned) => {
    const raw = rawById.get(planned.id) ?? {};
    const citationIds = expandRelationCitationIds(
      [...new Set((raw.citation_ids ?? [])
      .map((id) => String(id).trim().replace(/^\[|\]$/g, ""))
      .filter((id) => lookup.has(id)))],
      question,
      retrieved,
    );
    const requestedStatus = ["supported", "unresolved", "missing"].includes(
      raw.status,
    )
      ? raw.status
      : "missing";
    const status =
      requestedStatus !== "missing" && citationIds.length === 0
        ? "missing"
        : requestedStatus;
    return {
      ...planned,
      status,
      value: status === "missing"
        ? String(raw.value || "根拠不足")
        : String(raw.value ?? "").trim(),
      citation_ids: citationIds,
    };
  });
  const hasUnresolved = slots.some((slot) => slot.status === "unresolved");
  const hasMissing = slots.some((slot) => slot.status === "missing");
  const allowedBehaviors = new Set(ANSWER_BEHAVIORS);
  const asksAboutConflict = /食い違|矛盾|不一致|競合/.test(question.question);
  const requestedBehavior = allowedBehaviors.has(content.behavior)
    ? content.behavior
    : "answer_with_provenance";
  return {
    behavior: hasUnresolved || asksAboutConflict
      ? "answer_with_conflict_disclosure"
      : hasMissing
        ? "insufficient_information"
        : requestedBehavior === "answer_with_conflict_disclosure"
          ? "answer_with_provenance"
          : requestedBehavior,
    slots,
    guardrails: (content.guardrails ?? []).map(String),
  };
}

export function expandRelationCitationIds(citationIds, question, retrieved) {
  const expanded = new Set(citationIds);
  for (const citationId of citationIds) {
    const match = citationId.match(/-C(\d+)-E\d+$/);
    if (!match) continue;
    const contextIndex = Number.parseInt(match[1], 10) - 1;
    const document = retrieved[contextIndex]?.document;
    if (!document?.relation) continue;
    for (const [evidenceIndex] of (document.evidence ?? []).entries()) {
      expanded.add(evidenceId(question.id, contextIndex, evidenceIndex));
    }
  }
  return [...expanded];
}

function dossierAnswerPrompt(question, structured) {
  return `あなたは検証済みAnswer Slotsを自然な日本語へ変換する担当です。新しい事実を考えず、slotのvalueだけを使って簡潔に回答してください。

規則:
- supportedの内容は明確に述べる。
- unresolvedは候補と矛盾を明示し、一意に断定しない。
- missingは不足を明示する。
- citation_idsには、使用した全slotのIDをそのまま入れる。
- behaviorは指定値を変更しない。

質問: ${question.question}
指定behavior: ${structured.behavior}
Answer Slots:
${structured.slots
    .map(
      (slot) =>
        `- ${slot.label}: status=${slot.status}; value=${slot.value}; citations=${slot.citation_ids.join(",")}`,
    )
    .join("\n")}
Guardrails:
${structured.guardrails.map((item) => `- ${item}`).join("\n") || "- なし"}`;
}

function combineUsages(usages) {
  return {
    promptTokens: usages.every((usage) => usage.promptTokens !== null)
      ? usages.reduce((sum, usage) => sum + usage.promptTokens, 0)
      : null,
    outputTokens: usages.every((usage) => usage.outputTokens !== null)
      ? usages.reduce((sum, usage) => sum + usage.outputTokens, 0)
      : null,
    durationMs: usages.reduce((sum, usage) => sum + usage.durationMs, 0),
  };
}

function answerPrompt(questions, retrievalByQuestion) {
  const cases = questions
    .map((question) =>
      [
        `## ${question.id}`,
        `対象時点: ${question.as_of}`,
        `質問: ${question.question}`,
        contextText(
          question.id,
          retrievalByQuestion.get(question.id) ?? [],
        ),
      ].join("\n"),
    )
    .join("\n\n");

  return `あなたは社内文書RAGの回答器です。以下の検索コンテキストだけを使い、全質問へ日本語で回答してください。

規則:
- 対象時点で有効な文書を優先し、旧版を現在の規則として扱わない。
- 正式文書、標準、部門手順、FAQ、議事録の権威性を区別する。
- Compiled Retrieval Unitに権威優先順位がある場合は、小さい順位を優先して結論を出す。
- 競合があれば結論と競合内容を明示する。
- 情報が不足する場合は推測せず、不足していると答える。
- citation_idsには、回答に実際に使った根拠候補の角括弧内IDだけを正確にコピーする。
- behaviorは回答内容に合う値を選ぶ。
- ${questions.length}件を一度ずつ返す。

${cases}`;
}

function citationLookup(question, retrieved) {
  const lookup = new Map();
  for (const [contextIndex, item] of retrieved.entries()) {
    for (const [evidenceIndex, reference] of (
      item.document.evidence ?? []
    ).entries()) {
      lookup.set(evidenceId(question.id, contextIndex, evidenceIndex), {
        source: reference.source,
        section: reference.section,
      });
    }
  }
  return lookup;
}

function normalizeAnswerResults(
  answerResponse,
  questions,
  retrievalByQuestion,
) {
  const expectedIds = new Set(questions.map((question) => question.id));
  const results = answerResponse.content.results;
  if (!Array.isArray(results)) throw new Error("answer results is not an array");
  const byId = new Map();
  for (const result of results) {
    if (expectedIds.has(result.question_id) && !byId.has(result.question_id)) {
      const question = questions.find(
        (candidate) => candidate.id === result.question_id,
      );
      const lookup = citationLookup(
        question,
        retrievalByQuestion.get(question.id) ?? [],
      );
      const citations = (result.citation_ids ?? []).map((rawId) => {
        const id = String(rawId).trim().replace(/^\[|\]$/g, "");
        return (
          lookup.get(id) ?? {
            source: "__unknown_citation_id__",
            section: String(id),
          }
        );
      });
      byId.set(result.question_id, { ...result, citations });
    }
  }
  for (const question of questions) {
    if (!byId.has(question.id)) {
      throw new Error(`answer is missing question ${question.id}`);
    }
  }
  return byId;
}

function judgePrompt(questions, answerByQuestion) {
  const cases = questions
    .map((question) => {
      const answer = answerByQuestion.get(question.id);
      return [
        `## ${question.id}`,
        `質問: ${question.question}`,
        `期待動作: ${question.expected_behavior}`,
        `必須要素: ${JSON.stringify(question.expected_answer_elements)}`,
        `禁止要素: ${JSON.stringify(question.forbidden_answer_elements)}`,
        `回答: ${answer.answer}`,
      ].join("\n");
    })
    .join("\n\n");

  return `あなたはRAG回答の独立評価者です。回答を意味的に評価してください。回答を生成した方式は知らされていません。

判定規則:
- satisfied_answer_elementsには、回答が意味的に満たした必須要素だけを、提示された文字列のままコピーする。
- present_forbidden_answer_elementsには、回答が結論として肯定した禁止要素だけをコピーする。誤りとして否定・訂正した記述は含めない。
- behaviorには、回答が実際に示した動作を選ぶ。期待動作をそのまま写さない。
- 各質問を一度ずつ返す。

${cases}`;
}

function normalizeJudgeResults(judgeResponse, questions) {
  const questionById = new Map(
    questions.map((question) => [question.id, question]),
  );
  const results = judgeResponse.content.results;
  if (!Array.isArray(results)) throw new Error("judge results is not an array");
  const byId = new Map();

  for (const result of results) {
    const question = questionById.get(result.question_id);
    if (!question || byId.has(result.question_id)) continue;
    const allowedSatisfied = new Set(question.expected_answer_elements);
    const allowedForbidden = new Set(question.forbidden_answer_elements);
    byId.set(result.question_id, {
      behavior: result.behavior,
      satisfied_answer_elements: (
        result.satisfied_answer_elements ?? []
      ).filter((item) => allowedSatisfied.has(item)),
      present_forbidden_answer_elements: (
        result.present_forbidden_answer_elements ?? []
      ).filter((item) => allowedForbidden.has(item)),
    });
  }

  for (const question of questions) {
    if (!byId.has(question.id)) {
      throw new Error(`judge is missing question ${question.id}`);
    }
  }
  return byId;
}

function unsupportedCitations(citations, retrievedEvidence) {
  return citations.filter(
    (citation) =>
      !retrievedEvidence.some((evidence) =>
        evidenceMatches(citation, evidence),
      ),
  );
}

async function runPipeline({
  label,
  index,
  fallbackIndex = null,
  pipelineMode = "direct",
  questions,
  topK,
  answerChatConfig,
  judgeChatConfig,
  seed,
  queryMode = "question-as-of",
}) {
  const answerClient = await createStructuredChat(answerChatConfig);
  const sameProvider = JSON.stringify(answerChatConfig) === JSON.stringify(judgeChatConfig);
  const judgeClient = sameProvider
    ? answerClient
    : await createStructuredChat(judgeChatConfig);
  const retrievalByQuestion =
    pipelineMode === "direct"
      ? retrieve(index, questions, topK, { queryMode })
      : new Map();
  if (pipelineMode === "direct") {
    const retrievalMacro = questions.reduce(
      (sum, question) =>
        sum +
        retrievalRecall(
          question,
          retrievalByQuestion.get(question.id) ?? [],
        ),
      0,
    ) / questions.length;
    console.log(
      `${label}: retrieval evidence recall@${topK} ${(retrievalMacro * 100).toFixed(1)}%`,
    );
  }
  console.log(
    `${label}: generating ${questions.length} isolated ${pipelineMode === "dossier" ? "dossiers and " : ""}answers with ${answerClient.label}`,
  );
  const answerByQuestion = new Map();
  const answerUsageByQuestion = new Map();
  const answerUsages = [];
  const dossierByQuestion = new Map();
  for (const [questionIndex, question] of questions.entries()) {
    if (pipelineMode === "dossier") {
      const stageUsages = [];
      const planResponse = await answerClient.chat(
        dossierPlanPrompt(question),
        dossierPlanSchema(),
        seed + questionIndex,
      );
      stageUsages.push(planResponse.usage);
      const plan = augmentDossierPlan(
        question,
        normalizeDossierPlan(planResponse.content),
      );
      let dossier = assembleDossierRetrieval(
        index,
        fallbackIndex,
        question,
        plan,
        topK,
      );
      let slotResponse = await answerClient.chat(
        dossierSlotPrompt(question, plan, dossier),
        dossierSlotSchema(plan),
        seed + 200 + questionIndex,
      );
      stageUsages.push(slotResponse.usage);
      let structured = normalizeDossierSlots(
        slotResponse.content,
        plan,
        question,
        dossier.retrieved,
      );
      const missingSlotIds = structured.slots
        .filter((slot) => slot.status === "missing")
        .map((slot) => slot.id);
      if (fallbackIndex && missingSlotIds.length > 0) {
        dossier = assembleDossierRetrieval(
          index,
          fallbackIndex,
          question,
          plan,
          topK,
          missingSlotIds,
        );
        slotResponse = await answerClient.chat(
          dossierSlotPrompt(question, plan, dossier),
          dossierSlotSchema(plan),
          seed + 400 + questionIndex,
        );
        stageUsages.push(slotResponse.usage);
        structured = normalizeDossierSlots(
          slotResponse.content,
          plan,
          question,
          dossier.retrieved,
        );
      }
      const answerResponse = await answerClient.chat(
        dossierAnswerPrompt(question, structured),
        answerSchema([question.id]),
        seed + 600 + questionIndex,
      );
      stageUsages.push(answerResponse.usage);
      const requiredCitationIds = [...new Set(
        structured.slots.flatMap((slot) => slot.citation_ids),
      )];
      const rendered = answerResponse.content.results?.find(
        (result) => result.question_id === question.id,
      );
      if (rendered) {
        rendered.behavior = structured.behavior;
        rendered.citation_ids = requiredCitationIds;
      }
      retrievalByQuestion.set(question.id, dossier.retrieved);
      const oneQuestionRetrieval = new Map([
        [question.id, dossier.retrieved],
      ]);
      const normalized = normalizeAnswerResults(
        answerResponse,
        [question],
        oneQuestionRetrieval,
      );
      answerByQuestion.set(question.id, normalized.get(question.id));
      const combinedUsage = combineUsages(stageUsages);
      answerUsageByQuestion.set(question.id, combinedUsage);
      answerUsages.push(combinedUsage);
      dossierByQuestion.set(question.id, {
        plan,
        slots: structured.slots,
        guardrails: structured.guardrails,
        conflicts: dossier.conflicts.map((item) => item.document.id),
        fallback_units: dossier.fallback.map((item) => item.document.id),
      });
    } else {
      const oneQuestionRetrieval = new Map([
        [question.id, retrievalByQuestion.get(question.id) ?? []],
      ]);
      const answerResponse = await answerClient.chat(
        answerPrompt([question], oneQuestionRetrieval),
        answerSchema([question.id]),
        seed + questionIndex,
      );
      const normalized = normalizeAnswerResults(
        answerResponse,
        [question],
        oneQuestionRetrieval,
      );
      answerByQuestion.set(question.id, normalized.get(question.id));
      answerUsageByQuestion.set(question.id, answerResponse.usage);
      answerUsages.push(answerResponse.usage);
    }
    if ((questionIndex + 1) % 4 === 0 || questionIndex + 1 === questions.length) {
      console.log(
        `${label}: answered ${questionIndex + 1}/${questions.length}`,
      );
    }
  }

  const retrievalMacro =
    questions.reduce(
      (sum, question) =>
        sum +
        retrievalRecall(
          question,
          retrievalByQuestion.get(question.id) ?? [],
        ),
      0,
    ) / questions.length;
  if (pipelineMode === "dossier") {
    console.log(
      `${label}: dossier evidence recall@${topK} ${(retrievalMacro * 100).toFixed(1)}%`,
    );
  }

  console.log(
    `${label}: judging answers with isolated blind prompts using ${judgeClient.label}`,
  );
  const judgmentByQuestion = new Map();
  const judgeUsages = [];
  for (const [questionIndex, question] of questions.entries()) {
    const oneAnswer = new Map([
      [question.id, answerByQuestion.get(question.id)],
    ]);
    const judgeResponse = await judgeClient.chat(
      judgePrompt([question], oneAnswer),
      judgeSchema([question.id]),
      seed + 1000 + questionIndex,
    );
    const normalized = normalizeJudgeResults(judgeResponse, [question]);
    judgmentByQuestion.set(question.id, normalized.get(question.id));
    judgeUsages.push(judgeResponse.usage);
    if ((questionIndex + 1) % 4 === 0 || questionIndex + 1 === questions.length) {
      console.log(
        `${label}: judged ${questionIndex + 1}/${questions.length}`,
      );
    }
  }

  const results = questions.map((question) => {
    const answer = answerByQuestion.get(question.id);
    const answerUsage = answerUsageByQuestion.get(question.id);
    const judgment = judgmentByQuestion.get(question.id);
    const retrievedEvidence = expandedEvidence(
      retrievalByQuestion.get(question.id) ?? [],
    );
    const citations = (answer.citations ?? []).map((citation) => ({
      source: normalizeSource(citation.source),
      section: citation.section,
    }));
    return {
      question_id: question.id,
      answer: answer.answer,
      retrieved_evidence: retrievedEvidence,
      citations,
      behavior: judgment.behavior,
      ...(dossierByQuestion.has(question.id)
        ? { dossier: dossierByQuestion.get(question.id) }
        : {}),
      judgment: {
        satisfied_answer_elements: judgment.satisfied_answer_elements,
        present_forbidden_answer_elements:
          judgment.present_forbidden_answer_elements,
        unsupported_citations: unsupportedCitations(
          citations,
          retrievedEvidence,
        ),
      },
      usage: {
        input_tokens: answerUsage.promptTokens,
        output_tokens: answerUsage.outputTokens,
        latency_ms: Math.round(answerUsage.durationMs),
      },
    };
  });

  const outcome = {
    results,
    retrievalMacro,
    retrievalQuality: scoreRetrieval(
      questions,
      retrievalByQuestion,
      [topK],
      {
        supportsConflictUnits: index.documents.some(
          (document) => document.unit_type === "conflict",
        ),
      },
    ),
    answerUsage: {
      promptTokens: answerUsages.every(
        (usage) => usage.promptTokens !== null,
      )
        ? answerUsages.reduce(
            (sum, usage) => sum + usage.promptTokens,
            0,
          )
        : null,
      outputTokens: answerUsages.every(
        (usage) => usage.outputTokens !== null,
      )
        ? answerUsages.reduce(
            (sum, usage) => sum + usage.outputTokens,
            0,
          )
        : null,
      durationMs: answerUsages.reduce(
        (sum, usage) => sum + usage.durationMs,
        0,
      ),
    },
    judgeUsage: {
      promptTokens: judgeUsages.every(
        (usage) => usage.promptTokens !== null,
      )
        ? judgeUsages.reduce((sum, usage) => sum + usage.promptTokens, 0)
        : null,
      outputTokens: judgeUsages.every(
        (usage) => usage.outputTokens !== null,
      )
        ? judgeUsages.reduce((sum, usage) => sum + usage.outputTokens, 0)
        : null,
      durationMs: judgeUsages.reduce(
        (sum, usage) => sum + usage.durationMs,
        0,
      ),
    },
  };
  await answerClient.close();
  if (judgeClient !== answerClient) await judgeClient.close();
  return outcome;
}

function parseArguments(argv) {
  const options = {
    corpusRoot: defaultCorpusRoot,
    outputDirectory: defaultOutputDirectory,
    endpoint: "http://localhost:11434",
    model: "gemma4:latest",
    answerProvider: "ollama",
    answerEndpoint: null,
    answerModel: null,
    answerReasoningEffort: "low",
    judgeProvider: null,
    judgeEndpoint: null,
    judgeModel: null,
    judgeReasoningEffort: "low",
    codexCommand: "codex",
    topK: 5,
    seed: 42,
    compiledBuilds: [],
    actualOnly: false,
    rawOnly: false,
    rawProfile: "current",
    rawSourcePrefix: "",
    actualVariant: "baseline",
    intents: [],
    questionIds: [],
    retrievalOnly: false,
    retrievalKs: [5, 10, 20],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--corpus") {
      options.corpusRoot = path.resolve(argv[++index]);
    } else if (argument === "--output") {
      options.outputDirectory = path.resolve(argv[++index]);
    } else if (argument === "--endpoint") {
      options.endpoint = argv[++index];
    } else if (argument === "--model") {
      options.model = argv[++index];
    } else if (argument === "--answer-provider") {
      options.answerProvider = argv[++index];
    } else if (argument === "--answer-endpoint") {
      options.answerEndpoint = argv[++index];
    } else if (argument === "--answer-model") {
      options.answerModel = argv[++index];
    } else if (argument === "--answer-reasoning-effort") {
      options.answerReasoningEffort = argv[++index];
    } else if (argument === "--judge-provider") {
      options.judgeProvider = argv[++index];
    } else if (argument === "--judge-endpoint") {
      options.judgeEndpoint = argv[++index];
    } else if (argument === "--judge-model") {
      options.judgeModel = argv[++index];
    } else if (argument === "--judge-reasoning-effort") {
      options.judgeReasoningEffort = argv[++index];
    } else if (argument === "--codex-command") {
      options.codexCommand = argv[++index];
    } else if (argument === "--top-k") {
      options.topK = Number.parseInt(argv[++index], 10);
    } else if (argument === "--seed") {
      options.seed = Number.parseInt(argv[++index], 10);
    } else if (argument === "--compiled-build") {
      options.compiledBuilds.push(path.resolve(argv[++index]));
    } else if (argument === "--actual-only") {
      options.actualOnly = true;
    } else if (argument === "--raw-only") {
      options.rawOnly = true;
    } else if (argument === "--raw-profile") {
      options.rawProfile = argv[++index];
    } else if (argument === "--raw-source-prefix") {
      options.rawSourcePrefix = argv[++index];
    } else if (argument === "--actual-variant") {
      options.actualVariant = argv[++index];
    } else if (argument === "--intent") {
      options.intents.push(argv[++index]);
    } else if (argument === "--question") {
      options.questionIds.push(argv[++index]);
    } else if (argument === "--retrieval-only") {
      options.retrievalOnly = true;
    } else if (argument === "--retrieval-k") {
      options.retrievalKs = argv[++index]
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
  node run-upper-bound.mjs [options]

Options:
  --corpus <path>    Corpus root
  --output <path>    Result directory
  --endpoint <url>   Ollama endpoint
  --model <name>     Ollama chat model (default: gemma4:latest)
  --answer-provider <name>
                     Answer provider: ollama or codex-app-server
  --answer-endpoint <url>
                     Answer Ollama endpoint; defaults to --endpoint
  --answer-model <name>
                     Answer model; defaults to --model
  --answer-reasoning-effort <level>
                     Codex answer reasoning effort (default: low)
  --judge-provider <name>
                     Judge provider; defaults to the answer provider
  --judge-endpoint <url>
                     Judge Ollama endpoint; defaults to --endpoint
  --judge-model <name>
                     Judge model; defaults to the selected answer model
  --judge-reasoning-effort <level>
                     Codex judge reasoning effort (default: low)
  --codex-command <path>
                     Codex executable for App Server (default: codex)
  --top-k <number>   Retrieved chunks per question (default: 5)
  --seed <number>    Reproducibility seed (default: 42)
  --compiled-build <path>
                     Add an actual Fragrach Knowledge Build (repeatable)
  --actual-only      Skip Raw and Oracle answer generation
  --raw-only         Evaluate only Raw RAG
  --raw-profile <name>
                     Raw profile: current or tuned-sparse-v1
  --raw-source-prefix <path>
                     Limit Raw documents, for example manufacturing/product-design
  --actual-variant <name>
                     Actual adapter: baseline, aliases, evidence-fallback,
                     fallback-no-authority, fallback-evidence-only, or dossier
  --intent <id>      Evaluate only this Intent (repeatable)
  --question <id>    Evaluate only this question ID (repeatable)
  --retrieval-only   Skip answer generation and judging
  --retrieval-k <csv>
                     Retrieval cutoffs (default: 5,10,20)
  --help             Show this help`);
}

export function filterQuestionsByIntent(questions, intents) {
  if (intents.length === 0) return questions;
  const selected = new Set(intents);
  return questions.filter((question) => selected.has(question.intent_id));
}

export function structuredChatConfigs(options) {
  const answer = {
    provider: options.answerProvider,
    endpoint: options.answerEndpoint ?? options.endpoint,
    model: options.answerModel ?? options.model,
    reasoningEffort: options.answerReasoningEffort,
    command: options.codexCommand,
    cwd: repositoryRoot,
  };
  const judgeProvider = options.judgeProvider ?? answer.provider;
  const judge = {
    provider: judgeProvider,
    endpoint: options.judgeEndpoint ?? options.endpoint,
    model:
      options.judgeModel ??
      (judgeProvider === answer.provider ? answer.model : options.model),
    reasoningEffort: options.judgeReasoningEffort,
    command: options.codexCommand,
    cwd: repositoryRoot,
  };
  return { answer, judge };
}

export function actualVariantOptions(name) {
  const variants = {
    baseline: {},
    aliases: {
      includeDiagnosticAliases: true,
    },
    "evidence-fallback": {
      evidenceFallback: true,
      includeDiagnosticAliases: true,
    },
    "fallback-no-authority": {
      authorityBoost: false,
      evidenceFallback: true,
      includeDiagnosticAliases: true,
    },
    "fallback-evidence-only": {
      evidenceFallback: true,
      includeClaims: false,
      includeDiagnosticAliases: true,
    },
    dossier: {
      includeRelationDossiers: true,
    },
  };
  if (!(name in variants)) {
    throw new Error(`unknown --actual-variant: ${name}`);
  }
  return variants[name];
}

export function rawProfileOptions(name) {
  const profiles = {
    current: {
      chunking: {},
      index: {},
      queryMode: "question-as-of",
    },
    "tuned-sparse-v1": {
      chunking: {
        strategy: "fixed",
        maxChars: 1024,
        overlapParagraphs: 0,
      },
      index: {
        ngramSizes: [2],
        k1: 1.8,
        b: 0.75,
      },
      queryMode: "question-only",
    },
  };
  if (!(name in profiles)) {
    throw new Error(`unknown --raw-profile: ${name}`);
  }
  return profiles[name];
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (!Number.isInteger(options.topK) || options.topK < 1) {
    throw new Error("--top-k must be a positive integer");
  }
  if (
    options.retrievalKs.length === 0 ||
    options.retrievalKs.some((value) => !Number.isInteger(value) || value < 1)
  ) {
    throw new Error("--retrieval-k must contain positive integers");
  }
  options.retrievalKs = [...new Set(options.retrievalKs)].sort(
    (left, right) => left - right,
  );
  if (options.retrievalOnly && options.actualVariant === "dossier") {
    throw new Error(
      "--retrieval-only cannot evaluate dossier because its slot planner uses an LLM",
    );
  }
  if (options.actualOnly && options.rawOnly) {
    throw new Error("--actual-only and --raw-only cannot be combined");
  }

  fs.mkdirSync(options.outputDirectory, { recursive: true });
  const intentQuestions = filterQuestionsByIntent(
    readJsonl(
      path.join(options.corpusRoot, "evaluation/questions.jsonl"),
    ),
    options.intents,
  );
  const selectedQuestionIds = new Set(options.questionIds);
  const selectedQuestions = options.questionIds.length === 0
    ? intentQuestions
    : intentQuestions.filter((question) =>
        selectedQuestionIds.has(question.id),
      );
  if (selectedQuestions.length === 0) {
    throw new Error(
      "--intent/--question did not match any evaluation questions",
    );
  }
  const gold = readCorpusGold(options.corpusRoot);
  const questions = enrichQuestionsWithConflictGold(
    selectedQuestions,
    gold.answers,
    gold.conflicts,
  );
  const oracleGold = {
    ...gold,
    answers: completeGoldAnswers(questions, gold.answers),
  };
  const rawProfile = rawProfileOptions(options.rawProfile);
  const rawChunks = options.actualOnly
    ? []
    : filterChunksBySourcePrefix(
        buildRawChunks(options.corpusRoot, rawProfile.chunking),
        options.rawSourcePrefix,
      );
  const oracleChunks = options.actualOnly || options.rawOnly
    ? []
    : buildOracleChunks(
        readJson(path.join(options.corpusRoot, "ground-truth/expected.json")),
        rawChunks,
        oracleGold,
      );
  const actualChunks =
    !options.rawOnly && options.compiledBuilds.length > 0
      ? buildActualChunks(
          options.compiledBuilds,
          actualVariantOptions(options.actualVariant),
        )
      : [];
  const actualFallbackChunks =
    options.compiledBuilds.length > 0 && options.actualVariant === "dossier"
      ? buildActualChunks(options.compiledBuilds, {
          evidenceFallback: true,
          includeClaims: false,
          includeConflicts: false,
          includeDiagnosticAliases: true,
        })
      : [];
  if (options.actualOnly && actualChunks.length === 0) {
    throw new Error("--actual-only requires at least one --compiled-build");
  }
  console.log(
    `Index: raw=${rawChunks.length} chunks, oracle=${oracleChunks.length} knowledge units` +
      (actualChunks.length > 0 ? `, actual=${actualChunks.length}` : ""),
  );

  if (options.retrievalOnly) {
    const runs = {};
    if (!options.actualOnly) {
      runs["raw-rag"] = runRetrievalOnly(
        new Bm25Index(rawChunks, rawProfile.index),
        questions,
        options.retrievalKs,
        { queryMode: rawProfile.queryMode },
      );
    }
    if (!options.actualOnly && !options.rawOnly) {
      runs["oracle-compiled"] = runRetrievalOnly(
        new Bm25Index(oracleChunks),
        questions,
        options.retrievalKs,
      );
    }
    if (actualChunks.length > 0) {
      runs["actual-compiled"] = runRetrievalOnly(
        new Bm25Index(actualChunks),
        questions,
        options.retrievalKs,
      );
    }
    const report = {
      schema_version: "0.3",
      experiment: "retrieval-only",
      raw_profile: options.rawProfile,
      raw_source_prefix: options.rawSourcePrefix || null,
      retrieval_k: options.retrievalKs,
      actual_variant: options.actualVariant,
      intent_filter: options.intents,
      question_filter: options.questionIds,
      generated_at: new Date().toISOString(),
      corpus_gold: Object.fromEntries(
        Object.entries(gold).map(([key, rows]) => [key, rows.length]),
      ),
      indexes: {
        raw_chunks: rawChunks.length,
        oracle_knowledge_units: oracleChunks.length,
        actual_knowledge_units: actualChunks.length,
      },
      compile_coverage: {
        ...(!options.actualOnly
          ? {
              raw_rag: scoreCompileCoverage(questions, rawChunks),
              ...(!options.rawOnly
                ? { oracle_compiled: scoreCompileCoverage(questions, oracleChunks) }
                : {}),
            }
          : {}),
        ...(actualChunks.length > 0
          ? { actual_compiled: scoreCompileCoverage(questions, actualChunks) }
          : {}),
      },
      runs,
    };
    const reportPath = path.join(
      options.outputDirectory,
      "retrieval-report.json",
    );
    fs.writeFileSync(
      reportPath,
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8",
    );
    console.log("\nRetrieval result");
    for (const [label, run] of Object.entries(runs)) {
      const coverage = report.compile_coverage[
        label.replaceAll("-", "_")
      ];
      console.log(
        `${label}: ${options.retrievalKs
          .map(
            (topK) =>
              `R@${topK} ${(run.recall_at_k[String(topK)] * 100).toFixed(1)}%`,
          )
          .join(", ")}, Compile Coverage ${(coverage.compile_coverage * 100).toFixed(1)}%`,
      );
      const percentage = (value) =>
        value === null || value === undefined
          ? "n/a"
          : `${(value * 100).toFixed(1)}%`;
      console.log(
        `${label}: ${options.retrievalKs
          .map((topK) => {
            const key = String(topK);
            return [
              `D@${topK} ${percentage(run.distractor_rate_at_k[key])}`,
              `Conflict R@${topK} ${percentage(run.conflict_recall_at_k[key])}`,
              `Conflict Unit@${topK} ${percentage(run.conflict_unit_recall_at_k[key])}`,
              `Resolution@${topK} ${percentage(run.resolution_accuracy_at_k[key])}`,
              `(coverage ${percentage(run.resolution_coverage_at_k[key])})`,
            ].join(", ");
          })
          .join("; ")}`,
      );
    }
    console.log(`Report: ${reportPath}`);
    return;
  }

  const chatConfigs = structuredChatConfigs(options);
  const pipelineChat = {
    answerChatConfig: chatConfigs.answer,
    judgeChatConfig: chatConfigs.judge,
  };
  const raw = options.actualOnly
    ? null
    : await runPipeline({
        label: "raw-rag",
        index: new Bm25Index(rawChunks, rawProfile.index),
        queryMode: rawProfile.queryMode,
        questions,
        ...options,
        ...pipelineChat,
      });
  const oracle = options.actualOnly || options.rawOnly
    ? null
    : await runPipeline({
        label: "oracle-compiled",
        index: new Bm25Index(oracleChunks),
        questions,
        ...options,
        ...pipelineChat,
      });
  const actual =
    actualChunks.length > 0
      ? await runPipeline({
          label: "actual-compiled",
          index: new Bm25Index(actualChunks),
          fallbackIndex:
            actualFallbackChunks.length > 0
              ? new Bm25Index(actualFallbackChunks)
              : null,
          pipelineMode:
            options.actualVariant === "dossier" ? "dossier" : "direct",
          questions,
          ...options,
          ...pipelineChat,
        })
      : null;

  const rawPath = path.join(options.outputDirectory, "raw-rag.jsonl");
  const oraclePath = path.join(
    options.outputDirectory,
    "oracle-compiled.jsonl",
  );
  if (raw) writeJsonl(rawPath, raw.results);
  if (oracle) writeJsonl(oraclePath, oracle.results);
  if (actual) {
    writeJsonl(
      path.join(options.outputDirectory, "actual-compiled.jsonl"),
      actual.results,
    );
  }

  const report = {
    schema_version: "0.3",
    experiment: options.actualOnly
      ? "actual-only"
      : options.rawOnly
        ? "raw-only"
        : "upper-bound",
    model: options.model,
    answer_provider: chatConfigs.answer.provider,
    answer_model: chatConfigs.answer.model,
    answer_reasoning_effort: chatConfigs.answer.reasoningEffort,
    answer_seed_supported: chatConfigs.answer.provider === "ollama",
    judge_provider: chatConfigs.judge.provider,
    judge_model: chatConfigs.judge.model,
    judge_reasoning_effort: chatConfigs.judge.reasoningEffort,
    judge_seed_supported: chatConfigs.judge.provider === "ollama",
    top_k: options.topK,
    seed: options.seed,
    actual_variant: options.actualVariant,
    raw_profile: options.rawProfile,
    raw_source_prefix: options.rawSourcePrefix || null,
    intent_filter: options.intents,
    question_filter: options.questionIds,
    generated_at: new Date().toISOString(),
    indexes: {
      raw_chunks: rawChunks.length,
      oracle_knowledge_units: oracleChunks.length,
      actual_knowledge_units: actualChunks.length,
    },
    compile_coverage: {
      ...(raw ? { raw_rag: scoreCompileCoverage(questions, rawChunks) } : {}),
      ...(oracle
        ? { oracle_compiled: scoreCompileCoverage(questions, oracleChunks) }
        : {}),
      ...(actual
        ? { actual_compiled: scoreCompileCoverage(questions, actualChunks) }
        : {}),
    },
    retrieval_only: {
      ...(raw ? { raw_rag: raw.retrievalMacro } : {}),
      ...(oracle ? { oracle_compiled: oracle.retrievalMacro } : {}),
      ...(actual ? { actual_compiled: actual.retrievalMacro } : {}),
    },
    retrieval_quality: {
      ...(raw ? { raw_rag: raw.retrievalQuality } : {}),
      ...(oracle ? { oracle_compiled: oracle.retrievalQuality } : {}),
      ...(actual ? { actual_compiled: actual.retrievalQuality } : {}),
    },
    runs: {
      ...(raw
        ? {
            "raw-rag": scoreRun(questions, raw.results, {
              topK: options.topK,
              label: "raw-rag",
            }),
          }
        : {}),
      ...(oracle
        ? {
            "oracle-compiled": scoreRun(questions, oracle.results, {
              topK: options.topK,
              label: "oracle-compiled",
            }),
          }
        : {}),
      ...(actual
        ? {
            "actual-compiled": scoreRun(questions, actual.results, {
              topK: options.topK,
              label: "actual-compiled",
            }),
          }
        : {}),
    },
  };
  const reportPath = path.join(
    options.outputDirectory,
    "upper-bound-report.json",
  );
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log("\nResult");
  for (const [label, run] of Object.entries(report.runs)) {
    console.log(
      `${label}: strict ${(run.metrics.strict_pass_rate * 100).toFixed(1)}%, ` +
        `evidence ${(run.metrics.evidence_recall_at_k * 100).toFixed(1)}%, ` +
        `elements ${(run.metrics.answer_element_recall * 100).toFixed(1)}%, ` +
        `behavior ${(run.metrics.behavior_accuracy * 100).toFixed(1)}%`,
    );
  }
  console.log(`Report: ${reportPath}`);
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(`Error: ${error.stack ?? error.message}`);
    process.exitCode = 1;
  });
}
