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

export function buildActualChunks(buildDirectories) {
  const claimsById = new Map();
  const evidenceById = new Map();
  const conflictsById = new Map();
  const diagnosticsById = new Map();
  const authorityPrecedenceByIntent = new Map();

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
      }));
  const unitsByEvidence = new Map();
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
      intent_id: intentId,
      valid_from: evidence.valid_from,
      valid_to: evidence.valid_to,
      score_boost:
        authorityRank < 0
          ? 1
          : 1 + (precedence.length - authorityRank) * 0.05,
      evidence: [
        evidence.source_path,
        ...(evidence.source_aliases ?? []),
      ].map((sourcePath) => ({
        source: normalizeSource(`sources/${sourcePath}`),
        section: (evidence.heading_path ?? []).join(" / ") || "本文",
      })),
      text: [
        "種別: Compiled Retrieval Unit",
        `根拠位置: ${(evidence.heading_path ?? []).join(" / ") || "本文"}`,
        `根拠本文: ${evidence.text}`,
        authority ? `文書権威: ${authority}` : "",
        authorityRank >= 0
          ? `権威優先順位: ${authorityRank + 1}（小さいほど優先）`
          : "",
        ...[...claims.values()].flatMap((claim, index) => [
          `Claim ${index + 1}`,
          `主語: ${valueText(claim.subject)}`,
          `述語: ${valueText(claim.predicate)}`,
          `目的語: ${valueText(claim.object)}`,
          claim.predicate === "is_alias_of"
            ? `別名関係: ${[
                claim.subject,
                ...(Array.isArray(claim.object) ? claim.object : [claim.object]),
              ].join(" = ")}`
            : "",
          claim.condition ? `条件: ${claim.condition}` : "",
          claim.status ? `状態: ${claim.status}` : "",
          claim.valid_from ? `有効開始: ${claim.valid_from}` : "",
          claim.valid_to ? `有効終了: ${claim.valid_to}` : "",
          claim.authority ? `権威: ${claim.authority}` : "",
        ]),
      ]
        .filter(Boolean)
        .join("\n"),
      };
    },
  );

  for (const conflict of conflictsById.values()) {
    const claims = (conflict.claim_ids ?? [])
      .map((id) => claimsById.get(`${conflict.intent_id}/${id}`))
      .filter(Boolean);
    const diagnostic = diagnosticsById.get(
      `${conflict.intent_id}/${conflict.diagnostic_id}`,
    );
    chunks.push({
      id: `actual:conflict:${conflict.intent_id}/${conflict.id}`,
      intent_id: conflict.intent_id,
      validity_ranges: claims.map((claim) => ({
        valid_from: claim.valid_from,
        valid_to: claim.valid_to,
      })),
      evidence: claims.flatMap(claimEvidence),
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
      intent_id: diagnostic.intent_id,
      valid_from: cited[0]?.valid_from,
      valid_to: cited[0]?.valid_to,
      evidence: cited.map((item) => ({
        source: normalizeSource(`sources/${item.source_path}`),
        section: (item.heading_path ?? []).join(" / ") || "本文",
      })),
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

function retrieve(index, questions, topK) {
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

function expandedEvidence(retrieved) {
  const evidence = [];
  const seen = new Set();
  for (const [index, item] of retrieved.entries()) {
    for (const reference of item.document.evidence ?? []) {
      const key = `${reference.source}#${reference.section}`;
      if (seen.has(key)) continue;
      seen.add(key);
      evidence.push({ ...reference, rank: index + 1 });
    }
  }
  return evidence;
}

function evidenceMatches(left, right) {
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

function retrievalRecall(question, retrieved) {
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
  questions,
  topK,
  endpoint,
  model,
  seed,
}) {
  const retrievalByQuestion = retrieve(index, questions, topK);
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

  console.log(
    `${label}: retrieval evidence recall@${topK} ${(retrievalMacro * 100).toFixed(1)}%`,
  );
  console.log(
    `${label}: generating ${questions.length} isolated answers with ${model}`,
  );
  const answerByQuestion = new Map();
  const answerUsageByQuestion = new Map();
  const answerUsages = [];
  for (const [questionIndex, question] of questions.entries()) {
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
    if ((questionIndex + 1) % 4 === 0 || questionIndex + 1 === questions.length) {
      console.log(
        `${label}: answered ${questionIndex + 1}/${questions.length}`,
      );
    }
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
                     Add an actual FRAGARACH Knowledge Build (repeatable)
  --actual-only      Skip Raw and Oracle answer generation
  --help             Show this help`);
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
  const questions = readJsonl(
    path.join(options.corpusRoot, "evaluation/questions.jsonl"),
  );
  const expected = readJson(
    path.join(options.corpusRoot, "ground-truth/expected.json"),
  );
  const rawChunks = buildRawChunks(options.corpusRoot);
  const oracleChunks = buildOracleChunks(expected, rawChunks);
  const actualChunks =
    options.compiledBuilds.length > 0
      ? buildActualChunks(options.compiledBuilds)
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
