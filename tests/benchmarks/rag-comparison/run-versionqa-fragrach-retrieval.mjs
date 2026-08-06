#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildActualChunks } from "./run-upper-bound.mjs";
import {
  composeDecisionPacketResults,
  expandCompiledResults,
} from "./run-dynamic-validity-fcompile-retrieval.mjs";
import {
  DenseIndex,
  documentVectors,
  embedCollection,
  embeddingProfiles,
} from "./run-hybrid-tuning.mjs";
import { scoreRows } from "./run-versionqa-raw-retrieval.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../../..");

function parseArguments(argv) {
  const options = {
    corpus: path.join(repositoryRoot, "target/benchmarks/versionqa/prepared"),
    build: path.join(repositoryRoot, "target/benchmarks/versionqa/fragrach-build"),
    output: path.join(repositoryRoot, "target/benchmarks/versionqa/fragrach-retrieval"),
    endpoint: "http://127.0.0.1:11434",
    batchSize: 16,
    topK: 5,
    candidateK: 100,
    packetAnchorK: 5,
    packetBudget: 3,
    embeddingCache: path.join(repositoryRoot, "target/benchmarks/embedding-cache"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--corpus") options.corpus = path.resolve(argv[++index]);
    else if (argument === "--build") options.build = path.resolve(argv[++index]);
    else if (argument === "--output") options.output = path.resolve(argv[++index]);
    else if (argument === "--endpoint") options.endpoint = argv[++index];
    else if (argument === "--batch-size") options.batchSize = Number.parseInt(argv[++index], 10);
    else if (argument === "--top-k") options.topK = Number.parseInt(argv[++index], 10);
    else if (argument === "--candidate-k") options.candidateK = Number.parseInt(argv[++index], 10);
    else if (argument === "--packet-anchor-k") options.packetAnchorK = Number.parseInt(argv[++index], 10);
    else if (argument === "--packet-budget") options.packetBudget = Number.parseInt(argv[++index], 10);
    else if (argument === "--embedding-cache") options.embeddingCache = path.resolve(argv[++index]);
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

function readJsonl(file) {
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function versionKey(value) {
  return String(value).split(".").map(Number);
}

function compareVersions(left, right) {
  const a = versionKey(left);
  const b = versionKey(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return 0;
}

function inventoryPackets(build, units) {
  const profiles = readJsonl(path.join(build, "document-profiles.jsonl"));
  const evidenceBySourceId = new Map();
  for (const unit of units) {
    for (const evidence of unit.evidence ?? []) {
      if (evidence.source_id && !evidenceBySourceId.has(evidence.source_id)) {
        evidenceBySourceId.set(evidence.source_id, evidence);
      }
    }
  }
  const byDocument = new Map();
  for (const profile of profiles) {
    if (!profile.document_id || !profile.revision) continue;
    if (!byDocument.has(profile.document_id)) byDocument.set(profile.document_id, []);
    byDocument.get(profile.document_id).push(profile);
  }
  return [...byDocument.entries()].map(([documentId, members]) => {
    members.sort((left, right) => compareVersions(left.revision, right.revision));
    const sourceIds = members.map((member) => member.source_id);
    const evidence = members.map((member) => evidenceBySourceId.get(member.source_id)).filter(Boolean);
    return {
      id: `actual:version-inventory:${documentId}`,
      unit_type: "relation_dossier",
      intent_id: "versionqa",
      evidence,
      relation: {
        kind: "version_inventory",
        position: "conditional",
        source_id: sourceIds.at(-1),
        target_id: sourceIds[0],
        operative_source_ids: sourceIds,
        excluded_source_ids: [],
        evidence,
      },
      text: [
        "Type: Version Inventory Packet",
        `Document family: ${documentId}`,
        `Available versions: ${members.map((member) => member.revision).join(", ")}`,
        `Oldest version: ${members[0].revision}`,
        `Latest version: ${members.at(-1).revision}`,
        `Number of versions: ${members.length}`,
      ].join("\n"),
    };
  });
}

function ranked(index, vector, candidateK) {
  return index.search(vector, candidateK)
    .map((item, rank) => ({
      ...item,
      rank: rank + 1,
      score: item.score * Number(item.document.score_boost ?? 1),
    }))
    .sort((left, right) => right.score - left.score || left.document.id.localeCompare(right.document.id));
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node run-versionqa-fragrach-retrieval.mjs [--build DIR] [--output DIR]");
    return;
  }
  if (fs.existsSync(options.output)) throw new Error(`output already exists: ${options.output}`);
  const questions = readJsonl(path.join(options.corpus, "evaluation/questions.jsonl"));
  const compiledUnits = buildActualChunks([options.build], {
    authorityBoost: true,
    evidenceFallback: false,
    includeDiagnosticAliases: true,
    includeRelationDossiers: true,
  });
  const inventories = inventoryPackets(options.build, compiledUnits);
  const units = [...compiledUnits, ...inventories];
  const embeddingTextMaxChars = 3000;
  const embeddingUnits = units.map((unit) => ({
    ...unit,
    text: unit.text.slice(0, embeddingTextMaxChars),
  }));
  const profile = embeddingProfiles.ruri;
  const stored = await documentVectors(embeddingUnits, "versionqa-fragrach-ruri-3k", profile, {
    endpoint: options.endpoint,
    batchSize: options.batchSize,
    cacheDirectory: options.embeddingCache,
  });
  const queryVectors = await embedCollection(questions.map((question) => profile.query(question.question)), {
    endpoint: options.endpoint,
    model: profile.model,
    batchSize: options.batchSize,
    label: "VersionQA Fragrach questions",
  });
  const index = new DenseIndex(units, stored.values, stored.manifest.dimensions);
  const packetDocuments = units.filter((unit) => unit.unit_type === "relation_dossier");
  const rows = [];
  questions.forEach((question, questionIndex) => {
    const candidates = ranked(index, queryVectors[questionIndex], Math.min(options.candidateK, units.length));
    for (const [condition, results] of [
      ["fragrach-compiled-dense", expandCompiledResults(candidates, options.topK)],
      ["fragrach-decision-packet", composeDecisionPacketResults(candidates, packetDocuments, options.topK, {
        anchorK: options.packetAnchorK,
        packetBudget: options.packetBudget,
      })],
    ]) {
      rows.push({
        condition,
        question_id: question.id,
        category: question.category,
        version_sensitive: question.version_sensitive,
        results: results.map((result) => ({
          ...result,
          source: result.source,
        })),
      });
    }
  });
  const buildManifest = JSON.parse(fs.readFileSync(path.join(options.build, "build-manifest.json"), "utf8"));
  const report = {
    schema_version: "1.0",
    experiment: "versionqa-fragrach-retrieval",
    build_id: buildManifest.build_id,
    build_metrics: buildManifest.metrics,
    compiled_units: compiledUnits.length,
    inventory_packets: inventories.length,
    packet_documents: packetDocuments.length,
    retrieval: {
      embedding: { profile: "ruri", ...stored.manifest },
      embedding_text_max_chars: embeddingTextMaxChars,
      top_k: options.topK,
      candidate_k: options.candidateK,
      packet_anchor_k: options.packetAnchorK,
      packet_budget: options.packetBudget,
    },
    metrics: scoreRows(rows, questions, [options.topK]),
    version_sensitive_metrics: scoreRows(rows.filter((row) => row.version_sensitive), questions, [options.topK]),
  };
  fs.mkdirSync(options.output, { recursive: true });
  fs.writeFileSync(path.join(options.output, "retrieval.jsonl"), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
  fs.writeFileSync(path.join(options.output, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
