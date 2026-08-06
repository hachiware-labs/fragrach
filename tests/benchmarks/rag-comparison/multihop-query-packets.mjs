import fs from "node:fs";
import path from "node:path";

import { Bm25Index } from "./run-upper-bound.mjs";
import { factCoverage } from "./prepare-multihop-rag.mjs";

function normalize(value) {
  return String(value ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

export function queryClauses(question) {
  const cleaned = String(question).replace(/[?]+$/g, "").trim();
  const parts = cleaned.split(/\s*(?:;|,\s+(?:and|while|whereas)|\band\s+(?=(?:what|which|who|when|where|how|is|are|was|were|did|does)\b))\s*/i)
    .map((part) => part.trim())
    .filter((part) => part.split(/\s+/).length >= 4);
  return [...new Set(parts.length > 0 ? parts : [cleaned])].slice(0, 4);
}

export function mentionedPublishers(question, publishers) {
  const text = normalize(question);
  return publishers.filter((publisher) => text.includes(normalize(publisher)));
}

export function sourceMetadata(corpus, sources) {
  return new Map(sources.map((source) => {
    const text = fs.readFileSync(path.join(corpus, ...source.split("/")), "utf8");
    return [source, {
      publisher: /^publisher:\s*"([^"]*)"/m.exec(text)?.[1] ?? "",
      published_at: /^published_at:\s*"([^"]*)"/m.exec(text)?.[1] ?? "",
      text: text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim(),
    }];
  }));
}

export function sentencePassages(text, source = "source") {
  const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
  const sentences = String(text).split(/\r?\n\s*\r?\n/).flatMap((paragraph) => [...segmenter.segment(paragraph.replace(/\s+/g, " ").trim())]
    .map((item) => item.segment.trim())
    .filter((item) => item.length >= 24));
  return sentences.map((sentence, index) => ({
    id: `${source}:sentence:${index}`,
    source,
    text: [sentences[index - 1], sentence, sentences[index + 1]].filter(Boolean).join(" "),
  }));
}

function addCandidates(store, items, reason, weight = 1) {
  items.forEach((item, index) => {
    const document = item.document ?? item;
    const current = store.get(document.id) ?? { document, score: 0, reasons: [] };
    current.score += weight / (index + 1);
    current.reasons.push(reason);
    store.set(document.id, current);
  });
}

function chooseDistinct(selected, candidates, predicate = () => true) {
  const used = new Set(selected.map((item) => item.document.source));
  const choice = candidates.find((item) => predicate(item) && !used.has(item.document.source));
  if (choice) selected.push(choice);
}

export function buildMultiHopPacket(question, { chunks, bm25 = new Bm25Index(chunks), rawResults = [], metadata, obligations = null, sourceLimit = 4, chunkLimit = 5 }) {
  const candidates = new Map();
  addCandidates(candidates, rawResults.map((item) => ({ ...item, document: chunks.find((chunk) => chunk.id === item.chunk_id) })).filter((item) => item.document), "raw-hybrid", 2);
  addCandidates(candidates, bm25.search(question, 40), "whole-query", 1.5);
  const clauses = obligations?.length > 0 ? obligations : queryClauses(question);
  for (const clause of clauses) addCandidates(candidates, bm25.search(clause, 15), `clause:${clause}`, 1);
  const publishers = [...new Set([...metadata.values()].map((item) => item.publisher).filter(Boolean))];
  const requestedPublishers = mentionedPublishers(question, publishers);
  const obligationSearches = [];
  for (const clause of clauses) {
    const clausePublishers = mentionedPublishers(clause, publishers);
    const results = bm25.search(clause, 40, clausePublishers.length === 0
      ? undefined
      : (document) => clausePublishers.includes(metadata.get(document.source)?.publisher));
    obligationSearches.push({ clause, publishers: clausePublishers, results });
  }
  for (const publisher of requestedPublishers) {
    addCandidates(candidates, bm25.search(question, 15, (document) => metadata.get(document.source)?.publisher === publisher), `publisher:${publisher}`, 3);
  }
  const ranked = [...candidates.values()].sort((left, right) => right.score - left.score || left.document.id.localeCompare(right.document.id));
  const grouped = new Map();
  for (const candidate of ranked) {
    if (!grouped.has(candidate.document.source)) grouped.set(candidate.document.source, []);
    grouped.get(candidate.document.source).push(candidate);
  }
  const sourceCandidates = [...grouped.entries()].map(([source, items]) => ({
    source,
    items,
    score: items.slice(0, 2).reduce((sum, item) => sum + item.score, 0),
    document: items[0].document,
  })).sort((left, right) => right.score - left.score || left.source.localeCompare(right.source));
  const selectedSources = [];
  const assignedChunks = new Map();
  for (const obligation of obligationSearches) {
    const used = new Set(selectedSources.map((item) => item.source));
    const match = obligation.results.find((item) => !used.has(item.document.source));
    const source = match && sourceCandidates.find((item) => item.source === match.document.source);
    if (source && selectedSources.length < sourceLimit) {
      selectedSources.push(source);
      assignedChunks.set(source.source, [match.document.id]);
    }
  }
  for (const publisher of requestedPublishers) {
    chooseDistinct(selectedSources, sourceCandidates, (item) => metadata.get(item.source)?.publisher === publisher);
  }
  while (selectedSources.length < sourceLimit) {
    const before = selectedSources.length;
    chooseDistinct(selectedSources, sourceCandidates);
    if (selectedSources.length === before) break;
  }
  const chunksBySource = new Map();
  for (const chunk of chunks) {
    if (!chunksBySource.has(chunk.source)) chunksBySource.set(chunk.source, []);
    chunksBySource.get(chunk.source).push(chunk);
  }
  const rerankedSources = selectedSources.map((source) => {
    const localChunks = chunksBySource.get(source.source) ?? [];
    const localIndex = new Bm25Index(localChunks);
    const localCandidates = new Map();
    addCandidates(localCandidates, rawResults
      .filter((item) => item.source === source.source)
      .map((item) => ({ ...item, document: localChunks.find((chunk) => chunk.id === item.chunk_id) }))
      .filter((item) => item.document), "raw-hybrid-local", 2);
    addCandidates(localCandidates, localIndex.search(question, localChunks.length), "whole-query-local", 1.5);
    const publisher = metadata.get(source.source)?.publisher;
    const relevantClauses = clauses.filter((clause) => {
      const clausePublishers = mentionedPublishers(clause, publishers);
      return clausePublishers.length === 0 || clausePublishers.includes(publisher);
    });
    for (const clause of relevantClauses.length > 0 ? relevantClauses : clauses) {
      addCandidates(localCandidates, localIndex.search(clause, localChunks.length), `obligation-local:${clause}`, 1);
    }
    const items = [...localCandidates.values()]
      .sort((left, right) => right.score - left.score || left.document.id.localeCompare(right.document.id));
    return { ...source, items };
  });
  const selectedChunks = rerankedSources.map((source) => {
    const assigned = assignedChunks.get(source.source) ?? [];
    return source.items.find((item) => assigned.includes(item.document.id)) ?? source.items[0];
  }).filter(Boolean);
  const extras = rerankedSources.flatMap((source) => source.items.slice(1)).sort((left, right) => right.score - left.score);
  for (const extra of extras) {
    if (selectedChunks.length >= chunkLimit) break;
    if (selectedChunks.some((item) => item.document.id === extra.document.id)) continue;
    selectedChunks.push(extra);
  }
  const estimatedTokens = selectedChunks.reduce((sum, item) => sum + (item.document.token_count ?? Math.ceil(item.document.text.length / 4)), 0);
  const finalSources = rerankedSources.slice(0, sourceLimit).sort((left, right) => Date.parse(metadata.get(left.source)?.published_at ?? 0)
    - Date.parse(metadata.get(right.source)?.published_at ?? 0));
  if (finalSources.length === 0) return null;
  const sourceTexts = Object.fromEntries(finalSources.map((item) => [item.source, selectedChunks
    .filter((chunk) => chunk.document.source === item.source)
    .map((chunk) => chunk.document.text)
    .join("\n\n") ]));
  return {
    id: `actual:temporal-evidence-packet:${question.replace(/[^a-z0-9]+/gi, "-").slice(0, 48).toLowerCase()}`,
    packet_type: "temporal_evidence_packet",
    sources: finalSources.map((item) => item.source),
    source_texts: sourceTexts,
    estimated_tokens: estimatedTokens,
    text: [
      "Type: Query-relative Temporal Evidence Packet",
      `Publishers explicitly requested: ${requestedPublishers.join(", ") || "none"}`,
      "Retrieval hypotheses and generated query expansions are not part of this answer material.",
      "Evidence is ordered by publication time. Publication order is not by itself proof of supersession.",
      ...finalSources.map((item) => {
        const meta = metadata.get(item.source);
        return `SOURCE: ${item.source}\nPUBLISHER: ${meta?.publisher ?? ""}\nPUBLISHED_AT: ${meta?.published_at ?? ""}\n${sourceTexts[item.source]}`;
      }),
    ].join("\n\n"),
  };
}

export function evidenceUnitMetrics(questions, materialsByQuestion) {
  const answerable = questions.filter((question) => question.gold_status === "verified" && question.gold_evidence.units.length > 0);
  const rows = answerable.map((question) => {
    const materials = materialsByQuestion.get(question.id) ?? [];
    const units = question.gold_evidence.units;
    const hits = units.filter((unit) => materials.some((material) => {
      const sourceText = material.source_texts?.[unit.source]
        ?? (material.source === unit.source ? material.text : "");
      return sourceText && factCoverage(unit.fact, sourceText) >= 0.8;
    })).length;
    return { recall: hits / units.length, complete: hits === units.length };
  });
  return {
    questions: rows.length,
    evidence_unit_recall_at_k: rows.reduce((sum, row) => sum + row.recall, 0) / (rows.length || 1),
    evidence_ceiling_at_k: rows.filter((row) => row.complete).length / (rows.length || 1),
  };
}
