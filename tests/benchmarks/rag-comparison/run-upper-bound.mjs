#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { scoreRun } from "./evaluate.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultCorpusRoot = path.resolve(
  scriptDirectory,
  "../../corpora/aobane-industries-ja",
);
const defaultOutputDirectory = path.resolve(
  scriptDirectory,
  "../../../target/benchmarks/rag-comparison",
);

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
    evidence: [{ source, section: section || title || "本文" }],
    text: [
      `文書: ${title || source}`,
      `セクション: ${section || title || "本文"}`,
      cleanText,
    ].join("\n"),
  };
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

export function buildRawChunks(corpusRoot = defaultCorpusRoot) {
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

  return chunks;
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

export function buildOracleChunks(expected, rawChunks) {
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

  return chunks;
}

export function buildActualChunks(buildDirectories, options = {}) {
  const {
    authorityBoost = true,
    evidenceFallback = false,
    includeClaims = true,
    includeConflicts = true,
    includeDiagnosticAliases = false,
  } = options;
  const claimsById = new Map();
  const evidenceById = new Map();
  const conflictsById = new Map();
  const diagnosticsById = new Map();
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

export function tokenize(input) {
  const normalized = String(input)
    .normalize("NFKC")
    .toLowerCase();
  const tokens = normalized.match(/[a-z0-9_]+/g) ?? [];
  const compact = Array.from(normalized.replace(/[^\p{L}\p{N}]+/gu, ""));
  for (const size of [2, 3]) {
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
    this.documentTokens = documents.map((document) => tokenize(document.text));
    this.averageLength =
      this.documentTokens.reduce((sum, tokens) => sum + tokens.length, 0) /
      Math.max(this.documentTokens.length, 1);
    this.documentFrequency = new Map();

    for (const tokens of this.documentTokens) {
      for (const token of new Set(tokens)) {
        this.documentFrequency.set(
          token,
          (this.documentFrequency.get(token) ?? 0) + 1,
        );
      }
    }
  }

  search(query, limit = 5, filter = null) {
    const queryTokens = tokenize(query);
    const queryFrequency = new Map();
    for (const token of queryTokens) {
      queryFrequency.set(token, (queryFrequency.get(token) ?? 0) + 1);
    }

    const scored = this.documents.map((document, documentIndex) => {
      const tokens = this.documentTokens[documentIndex];
      const termFrequency = new Map();
      for (const token of tokens) {
        termFrequency.set(token, (termFrequency.get(token) ?? 0) + 1);
      }

      let score = 0;
      for (const [token, queryCount] of queryFrequency) {
        const frequency = termFrequency.get(token) ?? 0;
        if (frequency === 0) continue;
        const documentsWithToken = this.documentFrequency.get(token) ?? 0;
        const idf = Math.log(
          1 +
            (this.documents.length - documentsWithToken + 0.5) /
              (documentsWithToken + 0.5),
        );
        const denominator =
          frequency +
          this.k1 *
            (1 -
              this.b +
              this.b * (tokens.length / Math.max(this.averageLength, 1)));
        score +=
          idf *
          ((frequency * (this.k1 + 1)) / denominator) *
          Math.min(queryCount, 3);
      }
      score *= document.score_boost ?? 1;
      return { document, score };
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

export function retrieve(index, questions, topK) {
  const byQuestion = new Map();
  const supportsIntentFilter = index.documents.some(
    (document) => document.intent_id,
  );
  for (const question of questions) {
    const query = `${question.question}\n対象時点: ${question.as_of}`;
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

export function retrievalRecall(question, retrieved) {
  if (question.required_evidence.length === 0) return 1;
  const actual = expandedEvidence(retrieved);
  const matched = question.required_evidence.filter((required) =>
    actual.some((candidate) => evidenceMatches(required, candidate)),
  ).length;
  return matched / question.required_evidence.length;
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
              enum: [
                "answer",
                "answer_with_conflict_disclosure",
                "answer_with_temporal_resolution",
                "insufficient_information",
              ],
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
              enum: [
                "answer",
                "answer_with_conflict_disclosure",
                "answer_with_temporal_resolution",
                "insufficient_information",
              ],
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

async function ollamaChat(endpoint, model, prompt, schema, seed) {
  const startedAt = performance.now();
  const response = await fetch(`${endpoint.replace(/\/$/, "")}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      stream: false,
      think: false,
      format: schema,
      options: {
        temperature: 0,
        seed,
        num_ctx: 65536,
        num_predict: 4096,
      },
    }),
    signal: AbortSignal.timeout(15 * 60 * 1000),
  });
  if (!response.ok) {
    throw new Error(`Ollama ${response.status}: ${await response.text()}`);
  }
  const body = await response.json();
  let content;
  try {
    content = JSON.parse(body.message.content);
  } catch (error) {
    throw new Error(`Ollama returned invalid JSON: ${error.message}`);
  }
  return {
    content,
    usage: {
      promptTokens: body.prompt_eval_count ?? null,
      outputTokens: body.eval_count ?? null,
      durationMs: performance.now() - startedAt,
    },
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

function dossierSlotSchema(plan) {
  return {
    type: "object",
    properties: {
      behavior: {
        type: "string",
        enum: [
          "answer",
          "answer_with_conflict_disclosure",
          "answer_with_temporal_resolution",
          "insufficient_information",
        ],
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
- Conflictが質問の対象に関係する場合は隠さず、behaviorをanswer_with_conflict_disclosureにする。

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
    const citationIds = [...new Set((raw.citation_ids ?? [])
      .map((id) => String(id).trim().replace(/^\[|\]$/g, ""))
      .filter((id) => lookup.has(id)))];
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
  const allowedBehaviors = new Set([
    "answer",
    "answer_with_conflict_disclosure",
    "answer_with_temporal_resolution",
    "insufficient_information",
  ]);
  return {
    behavior: hasUnresolved
      ? "answer_with_conflict_disclosure"
      : hasMissing
        ? "insufficient_information"
        : allowedBehaviors.has(content.behavior)
          ? content.behavior
          : "answer",
    slots,
    guardrails: (content.guardrails ?? []).map(String),
  };
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
  endpoint,
  model,
  seed,
}) {
  const retrievalByQuestion =
    pipelineMode === "direct" ? retrieve(index, questions, topK) : new Map();
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
    `${label}: generating ${questions.length} isolated ${pipelineMode === "dossier" ? "dossiers and " : ""}answers with ${model}`,
  );
  const answerByQuestion = new Map();
  const answerUsageByQuestion = new Map();
  const answerUsages = [];
  const dossierByQuestion = new Map();
  for (const [questionIndex, question] of questions.entries()) {
    if (pipelineMode === "dossier") {
      const stageUsages = [];
      const planResponse = await ollamaChat(
        endpoint,
        model,
        dossierPlanPrompt(question),
        dossierPlanSchema(),
        seed + questionIndex,
      );
      stageUsages.push(planResponse.usage);
      const plan = normalizeDossierPlan(planResponse.content);
      let dossier = assembleDossierRetrieval(
        index,
        fallbackIndex,
        question,
        plan,
        topK,
      );
      let slotResponse = await ollamaChat(
        endpoint,
        model,
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
        slotResponse = await ollamaChat(
          endpoint,
          model,
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
      const answerResponse = await ollamaChat(
        endpoint,
        model,
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
      const answerResponse = await ollamaChat(
        endpoint,
        model,
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

  console.log(`${label}: judging answers with isolated blind prompts`);
  const judgmentByQuestion = new Map();
  const judgeUsages = [];
  for (const [questionIndex, question] of questions.entries()) {
    const oneAnswer = new Map([
      [question.id, answerByQuestion.get(question.id)],
    ]);
    const judgeResponse = await ollamaChat(
      endpoint,
      model,
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

  return {
    results,
    retrievalMacro,
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
}

function parseArguments(argv) {
  const options = {
    corpusRoot: defaultCorpusRoot,
    outputDirectory: defaultOutputDirectory,
    endpoint: "http://localhost:11434",
    model: "gemma4:latest",
    topK: 5,
    seed: 42,
    compiledBuilds: [],
    actualOnly: false,
    actualVariant: "baseline",
    intents: [],
    questionIds: [],
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
    } else if (argument === "--top-k") {
      options.topK = Number.parseInt(argv[++index], 10);
    } else if (argument === "--seed") {
      options.seed = Number.parseInt(argv[++index], 10);
    } else if (argument === "--compiled-build") {
      options.compiledBuilds.push(path.resolve(argv[++index]));
    } else if (argument === "--actual-only") {
      options.actualOnly = true;
    } else if (argument === "--actual-variant") {
      options.actualVariant = argv[++index];
    } else if (argument === "--intent") {
      options.intents.push(argv[++index]);
    } else if (argument === "--question") {
      options.questionIds.push(argv[++index]);
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
  --top-k <number>   Retrieved chunks per question (default: 5)
  --seed <number>    Reproducibility seed (default: 42)
  --compiled-build <path>
                     Add an actual Fragrach Knowledge Build (repeatable)
  --actual-only      Skip Raw and Oracle answer generation
  --actual-variant <name>
                     Actual adapter: baseline, aliases, evidence-fallback,
                     fallback-no-authority, fallback-evidence-only, or dossier
  --intent <id>      Evaluate only this Intent (repeatable)
  --question <id>    Evaluate only this question ID (repeatable)
  --help             Show this help`);
}

export function filterQuestionsByIntent(questions, intents) {
  if (intents.length === 0) return questions;
  const selected = new Set(intents);
  return questions.filter((question) => selected.has(question.intent_id));
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
    dossier: {},
  };
  if (!(name in variants)) {
    throw new Error(`unknown --actual-variant: ${name}`);
  }
  return variants[name];
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

  fs.mkdirSync(options.outputDirectory, { recursive: true });
  const intentQuestions = filterQuestionsByIntent(
    readJsonl(
      path.join(options.corpusRoot, "evaluation/questions.jsonl"),
    ),
    options.intents,
  );
  const selectedQuestionIds = new Set(options.questionIds);
  const questions = options.questionIds.length === 0
    ? intentQuestions
    : intentQuestions.filter((question) =>
        selectedQuestionIds.has(question.id),
      );
  if (questions.length === 0) {
    throw new Error(
      "--intent/--question did not match any evaluation questions",
    );
  }
  const expected = readJson(
    path.join(options.corpusRoot, "ground-truth/expected.json"),
  );
  const rawChunks = buildRawChunks(options.corpusRoot);
  const oracleChunks = buildOracleChunks(expected, rawChunks);
  const actualChunks =
    options.compiledBuilds.length > 0
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

  const raw = options.actualOnly
    ? null
    : await runPipeline({
        label: "raw-rag",
        index: new Bm25Index(rawChunks),
        questions,
        ...options,
      });
  const oracle = options.actualOnly
    ? null
    : await runPipeline({
        label: "oracle-compiled",
        index: new Bm25Index(oracleChunks),
        questions,
        ...options,
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
    schema_version: "0.1",
    experiment: options.actualOnly ? "actual-only" : "upper-bound",
    model: options.model,
    top_k: options.topK,
    seed: options.seed,
    actual_variant: options.actualVariant,
    intent_filter: options.intents,
    question_filter: options.questionIds,
    generated_at: new Date().toISOString(),
    indexes: {
      raw_chunks: rawChunks.length,
      oracle_knowledge_units: oracleChunks.length,
      actual_knowledge_units: actualChunks.length,
    },
    retrieval_only: {
      ...(raw ? { raw_rag: raw.retrievalMacro } : {}),
      ...(oracle ? { oracle_compiled: oracle.retrievalMacro } : {}),
      ...(actual ? { actual_compiled: actual.retrievalMacro } : {}),
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
