#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { loadDynamicValidityPack, normalizeSource } from "./dynamic-validity-score.mjs";
import { buildActualChunks } from "./run-upper-bound.mjs";
import { DenseIndex, documentVectors, embedCollection, embeddingProfiles } from "./run-hybrid-tuning.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../../..");

function parseArguments(argv) {
  const options = {
    corpus: path.resolve(scriptDirectory, "../../corpora/aobane-industries-ja-dynamic-validity-scale"),
    builds: [],
    output: path.resolve(repositoryRoot, "target/benchmarks/dynamic-validity-scale-v1"),
    cache: path.resolve(repositoryRoot, "target/benchmarks/embedding-cache"),
    endpoint: "http://127.0.0.1:11434",
    batchSize: 16,
    topK: 5,
    packetLane: true,
    packetAnchorK: 5,
    packetBudget: 3,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--corpus") options.corpus = path.resolve(argv[++index]);
    else if (argument === "--build") options.builds.push(path.resolve(argv[++index]));
    else if (argument === "--output") options.output = path.resolve(argv[++index]);
    else if (argument === "--cache") options.cache = path.resolve(argv[++index]);
    else if (argument === "--endpoint") options.endpoint = argv[++index];
    else if (argument === "--batch-size") options.batchSize = Number.parseInt(argv[++index], 10);
    else if (argument === "--top-k") options.topK = Number.parseInt(argv[++index], 10);
    else if (argument === "--no-packet-lane") options.packetLane = false;
    else if (argument === "--packet-anchor-k") options.packetAnchorK = Number.parseInt(argv[++index], 10);
    else if (argument === "--packet-budget") options.packetBudget = Number.parseInt(argv[++index], 10);
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (options.builds.length === 0) {
    const root = path.resolve(repositoryRoot, "target/benchmarks/dynamic-validity-scale-fcompile-v2");
    options.builds = [1, 2, 3, 4].map((index) => path.join(root, `knowledge-build-${index}`));
  }
  return options;
}

function uniqueSourceIds(document) {
  return [...new Set((document.evidence ?? []).map((item) => item.source_id).filter(Boolean))];
}

function packetRelationSourceIds(document) {
  const relation = document.relation ?? {};
  return [...new Set([
    ...uniqueSourceIds(document),
    relation.source_id,
    relation.target_id,
    ...(relation.verifier_source_ids ?? []),
    ...(relation.operative_source_ids ?? []),
    ...(relation.excluded_source_ids ?? []),
    ...(relation.contender_source_ids ?? []),
  ].filter(Boolean))];
}

function packetComponentKeys(packetDocuments) {
  const parent = new Map();
  const find = (value) => {
    if (!parent.has(value)) parent.set(value, value);
    const current = parent.get(value);
    if (current === value) return value;
    const root = find(current);
    parent.set(value, root);
    return root;
  };
  const union = (left, right) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot === rightRoot) return;
    const [first, second] = [leftRoot, rightRoot].sort();
    parent.set(second, first);
  };
  for (const document of packetDocuments) {
    const sourceIds = packetRelationSourceIds(document);
    for (const sourceId of sourceIds) find(sourceId);
    for (let index = 1; index < sourceIds.length; index += 1) {
      union(sourceIds[0], sourceIds[index]);
    }
  }
  return new Map(packetDocuments.map((document) => {
    const sourceIds = packetRelationSourceIds(document);
    return [document.id, sourceIds.length > 0 ? find(sourceIds[0]) : document.id];
  }));
}

function packetPositionPriority(document) {
  return document.relation?.position === "non_effective" ? 1 : 0;
}

function isDecisionPacket(document) {
  return document.unit_type === "relation_dossier" || Boolean(document.relation);
}

function positionSourceIds(relation) {
  const sourceId = relation.source_id;
  const targetId = relation.target_id;
  const idsOr = (values, fallback) => Array.isArray(values) && values.length > 0
    ? values
    : fallback.filter(Boolean);
  const verifier = new Set(idsOr(
    relation.verifier_source_ids,
    (relation.evidence ?? [])
      .map((item) => item.source_id)
      .filter((id) => id !== sourceId && id !== targetId),
  ));
  const position = relation.position;
  if (position === "dominates") return {
    operative: new Set(idsOr(relation.operative_source_ids, [sourceId])),
    excluded: new Set(idsOr(relation.excluded_source_ids, [targetId])),
    contenders: new Set(), verifier,
  };
  if (position === "conditional") return {
    operative: new Set(idsOr(relation.operative_source_ids, [sourceId, targetId])),
    excluded: new Set(), contenders: new Set(), verifier,
  };
  if (position === "non_effective") return {
    operative: new Set(idsOr(relation.operative_source_ids, [targetId])),
    excluded: new Set(idsOr(relation.excluded_source_ids, [sourceId])),
    contenders: new Set(), verifier,
  };
  return {
    operative: new Set(), excluded: new Set(),
    contenders: new Set(idsOr(relation.contender_source_ids, [sourceId, targetId])),
    verifier,
  };
}

function decisionPacketRoles(document) {
  const relation = document.relation ?? {};
  const groups = positionSourceIds(relation);
  const bySource = new Map();
  for (const cited of document.evidence ?? []) {
    const source = normalizeSource(cited.source);
    if (!source) continue;
    let use = "reference";
    let basis = "supporting";
    if (groups.contenders.has(cited.source_id)) {
      use = "conflict";
      basis = "contender";
    } else if (groups.operative.has(cited.source_id)) {
      use = "governing";
      basis = "operative";
    } else if (groups.verifier.has(cited.source_id)) {
      use = relation.position === "unresolved" ? "reference" : "governing";
      basis = "verifier";
    } else if (groups.excluded.has(cited.source_id)) {
      basis = "excluded";
    }
    const current = bySource.get(source);
    if (!current || current.use === "reference" || use === "conflict") {
      bySource.set(source, { source, use, basis });
    }
  }
  return [...bySource.values()];
}

function writeJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

export function expandCompiledResults(ranked, topK) {
  const results = [];
  const seen = new Set();
  for (const item of ranked) {
    if (isDecisionPacket(item.document)) {
      const evidence = [];
      const sources = [];
      const dossierSeen = new Set();
      for (const cited of item.document.evidence ?? []) {
        const source = normalizeSource(cited.source);
        if (!source || dossierSeen.has(source)) continue;
        dossierSeen.add(source);
        sources.push(source);
        evidence.push({
          source,
          section: cited.section ?? "本文",
          text: cited.text ?? "",
        });
      }
      if (sources.length === 0) continue;
      results.push({
        rank: results.length + 1,
        source: item.document.id,
        sources,
        citation_sources: sources,
        evidence_roles: decisionPacketRoles(item.document),
        section: "Document Position Dossier",
        text: [
          "種別: 不可分なDocument Position Dossier",
          `引用可能な原文: ${sources.join(", ")}`,
          item.document.text,
          ...evidence.map((cited) => `原文: ${cited.source} / ${cited.section}\n${cited.text}`),
        ].join("\n\n"),
        score: item.score,
        dense_rank: item.rank,
        sparse_rank: null,
        compiled_unit_id: item.document.id,
        compiled_unit_type: item.document.unit_type,
      });
      if (results.length === topK) return results;
      continue;
    }
    for (const evidence of item.document.evidence ?? []) {
      const source = normalizeSource(evidence.source);
      if (!source || seen.has(source)) continue;
      seen.add(source);
      results.push({
        rank: results.length + 1,
        source,
        sources: [source],
        citation_sources: [source],
        evidence_roles: [{ source, use: "governing" }],
        section: evidence.section ?? "本文",
        text: [item.document.text, `原文位置: ${evidence.section ?? "本文"}`, `原文: ${evidence.text ?? ""}`].join("\n"),
        score: item.score,
        dense_rank: item.rank,
        sparse_rank: null,
        compiled_unit_id: item.document.id,
        compiled_unit_type: item.document.unit_type,
      });
      if (results.length === topK) return results;
    }
  }
  return results;
}

export function composeDecisionPacketResults(
  ranked, packetDocuments, topK, { anchorK = 5, packetBudget = 3 } = {},
) {
  const anchors = ranked
    .filter((item) => !isDecisionPacket(item.document))
    .slice(0, anchorK);
  const anchorBySourceId = new Map();
  for (const anchor of anchors) {
    for (const sourceId of uniqueSourceIds(anchor.document)) {
      if (!anchorBySourceId.has(sourceId)) anchorBySourceId.set(sourceId, anchor);
    }
  }
  const componentByPacket = packetComponentKeys(packetDocuments);
  const directCandidates = packetDocuments
    .map((document) => {
      const matches = [...new Map(uniqueSourceIds(document)
        .map((sourceId) => anchorBySourceId.get(sourceId))
        .filter(Boolean)
        .map((item) => [item.document.id, item])).values()]
        .sort((left, right) => left.rank - right.rank);
      if (matches.length === 0) return null;
      return {
        component: componentByPacket.get(document.id) ?? document.id,
        document,
        matches,
      };
    })
    .filter(Boolean);
  const activationByComponent = new Map();
  for (const candidate of directCandidates) {
    const activation = activationByComponent.get(candidate.component) ?? new Map();
    for (const match of candidate.matches) activation.set(match.document.id, match);
    activationByComponent.set(candidate.component, activation);
  }
  const documentsByComponent = new Map();
  for (const document of packetDocuments) {
    const component = componentByPacket.get(document.id) ?? document.id;
    const documents = documentsByComponent.get(component) ?? [];
    documents.push(document);
    documentsByComponent.set(component, documents);
  }
  const componentCandidates = [...activationByComponent].map(([component, activation]) => {
    const matches = [...activation.values()].sort((left, right) => left.rank - right.rank);
    const directByDocument = new Map(directCandidates
      .filter((candidate) => candidate.component === component)
      .map((candidate) => [candidate.document.id, candidate.matches[0].rank]));
    const document = [...(documentsByComponent.get(component) ?? [])]
      .sort((left, right) => packetPositionPriority(left) - packetPositionPriority(right)
        || (directByDocument.get(left.id) ?? Number.POSITIVE_INFINITY)
          - (directByDocument.get(right.id) ?? Number.POSITIVE_INFINITY)
        || left.id.localeCompare(right.id, "ja"))[0];
    const anchor = matches[0];
    const queryEvidence = matches.slice(0, 2).map((item) => item.document.text).join("\n\n");
    return {
      component,
      rank: anchor.rank,
      score: anchor.score,
      matchedAnchors: matches.length,
      document: {
        ...document,
        text: `${document.text}\n\n質問関連anchor:\n${queryEvidence}`,
      },
    };
  });
  const packets = componentCandidates
    .sort((left, right) => left.rank - right.rank
      || right.matchedAnchors - left.matchedAnchors
      || left.document.id.localeCompare(right.document.id, "ja"))
    .slice(0, packetBudget);
  if (packets.length < packetBudget) {
    const selectedIds = new Set(packets.map((item) => item.document.id));
    const fallbacks = directCandidates
      .map((candidate) => {
        const anchor = candidate.matches[0];
        const queryEvidence = candidate.matches.slice(0, 2)
          .map((item) => item.document.text).join("\n\n");
        return {
          component: candidate.component,
          rank: anchor.rank,
          score: anchor.score,
          matchedAnchors: candidate.matches.length,
          document: {
            ...candidate.document,
            text: `${candidate.document.text}\n\n質問関連anchor:\n${queryEvidence}`,
          },
        };
      })
      .sort((left, right) => left.rank - right.rank
        || packetPositionPriority(left.document) - packetPositionPriority(right.document)
        || left.document.id.localeCompare(right.document.id, "ja"));
    for (const fallback of fallbacks) {
      if (selectedIds.has(fallback.document.id)) continue;
      packets.push(fallback);
      selectedIds.add(fallback.document.id);
      if (packets.length === packetBudget) break;
    }
  }
  const selected = new Set(packets.map((item) => item.document.id));
  const remaining = ranked.filter((item) => !selected.has(item.document.id));
  return expandCompiledResults([...packets, ...remaining], topK);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node run-dynamic-validity-fcompile-retrieval.mjs [--build DIR] [--output DIR] [--no-packet-lane]");
    return;
  }
  const pack = loadDynamicValidityPack(options.corpus);
  const profile = embeddingProfiles.ruri;
  const units = buildActualChunks(options.builds, {
    authorityBoost: true,
    evidenceFallback: true,
    includeDiagnosticAliases: true,
    includeRelationDossiers: true,
  });
  const stored = await documentVectors(units, "dynamic-validity-fcompile-t1-ruri", profile, {
    endpoint: options.endpoint,
    batchSize: options.batchSize,
    cacheDirectory: options.cache,
  });
  const questions = pack.questions;
  const queryVectors = await embedCollection(questions.map((question) => profile.query(question.question)), {
    endpoint: options.endpoint,
    batchSize: options.batchSize,
    model: profile.model,
    label: "F-Compile T1 questions",
  });
  const index = new DenseIndex(units, stored.values, stored.manifest.dimensions);
  const packetDocuments = units.filter(isDecisionPacket);
  const rows = questions.map((question, questionIndex) => {
    const ranked = index.search(queryVectors[questionIndex], Math.min(100, units.length))
      .map((item, indexValue) => ({
        ...item,
        rank: indexValue + 1,
        score: item.score * Number(item.document.score_boost ?? 1),
      }))
      .sort((left, right) => right.score - left.score || left.document.id.localeCompare(right.document.id, "ja"));
    return {
      question_id: question.id,
      stage: "T1",
      results: options.packetLane
        ? composeDecisionPacketResults(ranked, packetDocuments, options.topK, {
          anchorK: options.packetAnchorK,
          packetBudget: options.packetBudget,
        })
        : expandCompiledResults(ranked, options.topK),
    };
  });
  const outputFile = path.join(options.output, "retrieval/f-compile-t1.jsonl");
  writeJsonl(outputFile, rows);
  const manifest = {
    schema_version: "1.0",
    experiment: "dynamic-validity-fcompile-retrieval",
    stage: "T1",
    builds: options.builds,
    questions: questions.length,
    compiled_units: units.length,
    retrieval: options.packetLane
      ? "Ruri anchor retrieval followed by deterministic Decision Packet relation expansion"
      : "Ruri dense over Actual Knowledge Build; Position Dossiers remain one answer material with multiple citable sources",
    packet_lane: options.packetLane,
    packet_anchor_k: options.packetAnchorK,
    packet_budget: options.packetBudget,
    top_k: options.topK,
    embedding: stored.manifest,
    output: outputFile,
  };
  fs.writeFileSync(path.join(options.output, "f-compile-retrieval-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(manifest, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
