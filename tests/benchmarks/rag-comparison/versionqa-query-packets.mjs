import fs from "node:fs";
import path from "node:path";

import { Bm25Index, tokenize } from "./run-upper-bound.mjs";

function normalize(value) {
  return String(value ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

export function compareVersions(left, right) {
  const a = String(left).split(".").map(Number);
  const b = String(right).split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return 0;
}

export function classifyVersionQuestion(question) {
  const text = normalize(question);
  if (/how many .*versions|versions .*available|versions .*aware|latest .*version|oldest .*version|does .*version .*exist|is .*aware of .*version/.test(text)) {
    return "inventory";
  }
  if (/what changed|with what .*version|what version introduced|when was .* (added|introduced)|was .*introduced|since when|were .*changed/.test(text)) {
    return "change";
  }
  return "content";
}

export function familyFromQuestion(question) {
  const text = normalize(question);
  if (text.includes("spark") || text.includes("apache release") || text.includes("apache version")) return "spark-release";
  if (text.includes("bootstrap")) return "bootstrap-release";
  if (/err_[a-z0-9_]+|cert_[a-z0-9_]+|openssl|error class|error code|versions about errors/.test(text)) return "nodejs-errors";
  if (text.includes("node")) return "nodejs-assert";
  return null;
}

export function requestedVersion(question) {
  const matches = [...String(question).matchAll(/(?:version|release|v)\s*([0-9]+(?:\.[0-9]+){1,2}(?:\.\*)?)/gi)];
  if (matches.length > 0) return matches.at(-1)[1];
  return /\b([0-9]+(?:\.[0-9]+){2})\b/.exec(String(question))?.[1] ?? null;
}

export function subjectTerms(question) {
  const terms = [];
  const add = (value) => {
    if (value && !terms.some((term) => normalize(term) === normalize(value))) terms.push(value);
  };
  for (const match of String(question).matchAll(/\b(?:ERR|CERT)_[A-Z0-9_]+\b/g)) add(match[0]);
  for (const match of String(question).matchAll(/\bassert\.[A-Za-z0-9_]+/g)) add(match[0]);
  for (const match of String(question).matchAll(/\b(?:CallTracker|WeakMap|WeakSet|NumPy|percentile_disc)\b/gi)) add(match[0]);
  const text = normalize(question);
  if (text.includes("partialdeepstrictequal")) add("assert.partialDeepStrictEqual");
  if (text.includes("openssl error code")) add("OpenSSL Error Codes");
  if (text.includes("node: syntax") || text.includes("node:assert")) add("node:assert");
  if (text.includes("error class") && text.includes("constructor")) add("new Error");
  if (text.includes("color mode")) add("color modes");
  if (text.includes("selector engine")) add("selector engine");
  if (text.includes("badges")) add("Badges");
  if (text.includes("accordion")) add("accordion");
  if (text.includes("avro")) add("Avro");
  if (text.includes("window")) add("window/session_window");
  return terms;
}

function sourceFamily(source) {
  return /^sources\/([^/]+)\//.exec(source)?.[1] ?? null;
}

function sourceVersion(source) {
  return /\/([^/]+)\.md$/.exec(source)?.[1] ?? null;
}

function sourcePath(corpus, source) {
  return path.join(corpus, ...source.split("/"));
}

function materialFromPacket(packet, rank = 1) {
  return {
    rank,
    source: packet.id,
    sources: packet.sources,
    citation_sources: packet.sources,
    evidence_roles: packet.sources.map((source) => ({ source, use: "governing", basis: packet.packet_type })),
    section: packet.packet_type,
    text: packet.text,
    evidence_units: packet.evidence_units,
    compiled_unit_id: packet.id,
    compiled_unit_type: packet.packet_type,
    score: 1,
  };
}

function sourceChunks(chunks, source) {
  return chunks.filter((chunk) => chunk.source === source);
}

export function extractImportForms(text) {
  const forms = [];
  const seen = new Set();
  for (const line of String(text).split(/\r?\n/)) {
    if (!/(?:\bimport\b.*\bfrom\s+['"](?:node:)?assert(?:\/strict)?['"]|\brequire\(['"](?:node:)?assert(?:\/strict)?['"]\))/i.test(line)) continue;
    const normalized = normalize(line);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    forms.push(line.trim());
  }
  return forms.slice(0, 12);
}

function contentPacket(question, family, version, corpus, chunks, bm25) {
  const requestedSource = version ? `sources/${family}/${version}.md` : null;
  const candidates = bm25.search(question.question, 3, (document) => requestedSource
    ? document.source === requestedSource
    : sourceFamily(document.source) === family).map((item) => item.document);
  if (candidates.length === 0 && requestedSource) candidates.push(...sourceChunks(chunks, requestedSource).slice(0, 2));
  if (candidates.length === 0) return null;
  const sources = [...new Set(candidates.map((candidate) => candidate.source))];
  const subjects = subjectTerms(question.question);
  const fullText = requestedSource ? fs.readFileSync(sourcePath(corpus, requestedSource), "utf8") : "";
  const importForms = /\bimport(?:ed|ing)?\b/i.test(question.question) ? extractImportForms(fullText) : [];
  const absent = Boolean(requestedSource) && subjects.length > 0
    && subjects.every((subject) => !normalize(fullText).includes(normalize(subject)));
  const evidenceUnits = absent ? [{
    type: "document_absence",
    source: requestedSource,
    subject_terms: subjects,
    evidence_text: `Full-document verification found no occurrence of: ${subjects.join(", ")}`,
  }] : [];
  return {
    id: `actual:version-packet:${family}:${version ?? "unbound"}:${question.id}`,
    packet_type: "version_packet",
    sources,
    evidence_units: evidenceUnits,
    text: [
      "Type: Query-relative Version Packet",
      `Document family: ${family}`,
      `Requested version: ${version ?? "not specified"}`,
      `Source: ${sources.join(", ")}`,
      absent ? `Verified absence: ${subjects.join(", ")}` : null,
      importForms.length > 0 ? `Import forms found in the requested document:\n${importForms.join("\n")}` : null,
      "Answer-bearing candidates:",
      ...candidates.map((chunk) => `[${chunk.section}]\n${chunk.text}`),
    ].filter(Boolean).join("\n\n"),
  };
}

function inventoryPacket(question, family, chunks) {
  const sources = [...new Set(chunks.filter((chunk) => sourceFamily(chunk.source) === family).map((chunk) => chunk.source))]
    .sort((left, right) => compareVersions(sourceVersion(left), sourceVersion(right)));
  if (sources.length === 0) return null;
  const versions = sources.map(sourceVersion);
  return {
    id: `actual:query-inventory:${family}:${question.id}`,
    packet_type: "version_inventory",
    sources,
    evidence_units: [{ type: "version_inventory", family, versions }],
    text: [
      "Type: Query-relative Version Inventory Packet",
      `Document family: ${family}`,
      `Available versions: ${versions.join(", ")}`,
      `Oldest version: ${versions[0]}`,
      `Latest version: ${versions.at(-1)}`,
      `Number of versions: ${versions.length}`,
    ].join("\n"),
  };
}

function bestExcerpt(lines, question, subjects, radius = 40) {
  const queryTokens = new Set(tokenize(`${question} ${subjects.join(" ")}`, { ngramSizes: [] }));
  let best = { found: false, score: -1, text: "" };
  const directMatches = lines.map((line, index) => ({ line: normalize(line), index }))
    .filter(({ line }) => subjects.some((subject) => line.includes(normalize(subject))));
  const centers = directMatches.length > 0 ? directMatches.map(({ index }) => index) : lines.map((_, index) => index);
  for (const index of centers) {
    const window = lines.slice(Math.max(0, index - radius), Math.min(lines.length, index + radius + 1)).join("\n");
    const normalized = normalize(window);
    const subjectHits = subjects.filter((subject) => normalized.includes(normalize(subject))).length;
    const windowTokens = new Set(tokenize(window, { ngramSizes: [] }));
    const overlap = [...queryTokens].filter((token) => windowTokens.has(token)).length;
    const positionBoost = directMatches.length > 0 ? 50 / (1 + index / 100) : 0;
    const score = subjectHits * 100 + overlap + positionBoost;
    if (score > best.score) best = { found: subjectHits > 0, score, text: window };
  }
  return best;
}

function changedMagnitude(before, after) {
  const left = new Set(normalize(before).split(" "));
  const right = new Set(normalize(after).split(" "));
  return [...left].filter((token) => !right.has(token)).length + [...right].filter((token) => !left.has(token)).length;
}

function preferredChangeKind(question) {
  const text = normalize(question);
  if (/introduced|added|since when/.test(text)) return "added";
  if (/changed|change/.test(text)) return "modified";
  return null;
}

export function diffAnswerFocus(question) {
  const text = normalize(question);
  if (/example|sample code/.test(text)) {
    return "Answer focus: compare the examples in the Before and After document snapshots. Do not report embedded API-history `added` metadata as the snapshot in which the examples changed.";
  }
  return null;
}

function pairCandidate(question, corpus, beforeSource, afterSource, subjects) {
  const beforeLines = fs.readFileSync(sourcePath(corpus, beforeSource), "utf8").split(/\r?\n/);
  const afterLines = fs.readFileSync(sourcePath(corpus, afterSource), "utf8").split(/\r?\n/);
  const before = bestExcerpt(beforeLines, question.question, subjects);
  const after = bestExcerpt(afterLines, question.question, subjects);
  let changeKind = "unchanged";
  if (!before.found && after.found) changeKind = "added";
  else if (before.found && !after.found) changeKind = "removed";
  else if (before.found && after.found && normalize(before.text) !== normalize(after.text)) changeKind = "modified";
  else if (!before.found && !after.found) changeKind = "unrelated";
  const preferred = preferredChangeKind(question.question);
  const kindBoost = preferred === changeKind ? 1000 : 0;
  const relevance = before.score + after.score;
  const magnitude = changeKind === "modified" ? changedMagnitude(before.text, after.text) : 0;
  const score = changeKind === "unrelated" ? -1 : kindBoost + relevance + magnitude;
  return { beforeSource, afterSource, before, after, changeKind, score };
}

function diffPacket(question, family, corpus, chunks) {
  const sources = [...new Set(chunks.filter((chunk) => sourceFamily(chunk.source) === family).map((chunk) => chunk.source))]
    .sort((left, right) => compareVersions(sourceVersion(left), sourceVersion(right)));
  const subjects = subjectTerms(question.question);
  if (sources.length < 2 || subjects.length === 0) return null;
  const version = requestedVersion(question.question);
  let pairs = sources.slice(1).map((afterSource, index) => [sources[index], afterSource]);
  if (version) {
    const targetIndex = sources.findIndex((source) => sourceVersion(source) === version);
    if (targetIndex > 0) pairs = [[sources[targetIndex - 1], sources[targetIndex]]];
  }
  const preferred = preferredChangeKind(question.question);
  const pairCandidates = pairs.map(([before, after]) => pairCandidate(question, corpus, before, after, subjects));
  const candidate = (preferred === "added" && pairCandidates.some((item) => item.changeKind === "added")
    ? pairCandidates.filter((item) => item.changeKind === "added")
      .sort((left, right) => compareVersions(sourceVersion(left.afterSource), sourceVersion(right.afterSource)))
    : pairCandidates.sort((left, right) => right.score - left.score
      || compareVersions(sourceVersion(left.afterSource), sourceVersion(right.afterSource))))[0];
  if (!candidate) return null;
  const evidenceText = `Before:\n${candidate.before.text}\n\nAfter:\n${candidate.after.text}`;
  return {
    id: `actual:diff-packet:${family}:${sourceVersion(candidate.beforeSource)}:${sourceVersion(candidate.afterSource)}:${question.id}`,
    packet_type: "semantic_diff",
    sources: [candidate.beforeSource, candidate.afterSource],
    evidence_units: [{
      type: "semantic_diff",
      before_source: candidate.beforeSource,
      after_source: candidate.afterSource,
      change_kind: candidate.changeKind,
      subject_terms: subjects,
      evidence_text: evidenceText,
    }],
    text: [
      "Type: Query-relative Semantic Diff Packet",
      `Document family: ${family}`,
      `Before: ${sourceVersion(candidate.beforeSource)} (${candidate.beforeSource})`,
      `After: ${sourceVersion(candidate.afterSource)} (${candidate.afterSource})`,
      "Version semantics: Before/After are corpus document-snapshot versions. Embedded `added` or `removed` metadata records upstream API history and is a different time axis.",
      diffAnswerFocus(question.question),
      `Change kind: ${candidate.changeKind}`,
      `Subject: ${subjects.join(", ")}`,
      evidenceText,
    ].join("\n\n"),
  };
}

export function createVersionQaPacket(question, { corpus, chunks, bm25 = new Bm25Index(chunks) }) {
  const mode = classifyVersionQuestion(question.question);
  const family = familyFromQuestion(question.question);
  if (!family) return { mode, family, packet: null };
  let packet = null;
  if (mode === "inventory") packet = inventoryPacket(question, family, chunks);
  else if (mode === "change") packet = diffPacket(question, family, corpus, chunks);
  else packet = contentPacket(question, family, requestedVersion(question.question), corpus, chunks, bm25);
  return { mode, family, packet };
}

export function queryPacketResults(question, options) {
  const result = createVersionQaPacket(question, options);
  return {
    ...result,
    results: result.packet ? [materialFromPacket(result.packet)] : [],
  };
}
