#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), "..");

function parseArgs(argv) {
  const options = { inputs: [], output: null, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--input") options.inputs.push(path.resolve(argv[++index]));
    else if (arg === "--output") options.output = path.resolve(argv[++index]);
    else if (arg === "--json") options.json = true;
    else if (arg === "--help") options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (options.inputs.length === 0) {
    options.inputs.push(path.join(repositoryRoot, "target/benchmarks"));
  }
  return options;
}

function walk(directory, name, output = []) {
  if (!fs.existsSync(directory)) return output;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(fullPath, name, output);
    else if (entry.isFile() && entry.name === name) output.push(fullPath);
  }
  return output;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map(JSON.parse);
}

function relationQuality(manifestFile) {
  const buildDirectory = path.join(path.dirname(manifestFile), "knowledge-build");
  const profiles = readJsonl(path.join(buildDirectory, "document-profiles.jsonl"));
  const relations = readJsonl(path.join(buildDirectory, "document-relations.jsonl"));
  const sourceToDocument = new Map(profiles.map((profile) => [profile.source_id, profile.document_id]));
  const documentIds = new Set(sourceToDocument.values());
  const goldFile = path.join(repositoryRoot, "tests/corpora/fragrach-enterprise-ja-diverse/gold/relations.jsonl");
  const gold = readJsonl(goldFile).filter(
    (relation) => documentIds.has(relation.subject) && documentIds.has(relation.object),
  );
  if (gold.length === 0) return null;
  const key = (source, target, kind) => `${source}\u0000${target}\u0000${kind}`;
  const expected = new Set(gold.map((relation) => key(relation.subject, relation.object, relation.kind)));
  const predicted = new Set(relations.map((relation) => key(
    sourceToDocument.get(relation.source_id),
    sourceToDocument.get(relation.target_id),
    relation.kind,
  )));
  const correct = [...predicted].filter((item) => expected.has(item)).length;
  return {
    gold_relations: expected.size,
    correct_relations: correct,
    precision: predicted.size === 0 ? 0 : correct / predicted.size,
    recall: expected.size === 0 ? 0 : correct / expected.size,
  };
}

function cachedDurations(directory) {
  if (!fs.existsSync(directory)) return [];
  const durations = [];
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(fullPath);
      else if (entry.isFile() && entry.name.endsWith(".json")) {
        const value = readJson(fullPath)?.response?.usage?.duration_ms;
        if (Number.isFinite(value)) durations.push(value);
      }
    }
  }
  return durations;
}

function recordFromManifest(file, manifest) {
  const build = manifest.build_manifest;
  const metrics = build?.metrics;
  if (manifest.experiment !== "enterprise-actual-compile" || manifest.status !== "completed" || !metrics) {
    return null;
  }
  const strategy = build.compile_strategy ?? manifest.compile_strategy ?? "global-v1";
  const compileStep = manifest.steps?.find((step) => step.name === "compile");
  let profileWallMs = metrics.profile_wall_duration_ms ?? 0;
  if (profileWallMs === 0 && strategy === "global-v1") {
    const durations = cachedDurations(
      path.join(manifest.workspace, ".fragarach/cache/document-profile-extraction-v1"),
    );
    profileWallMs = durations.length > 0 ? Math.max(...durations) : 0;
  }
  const relationGold = relationQuality(file);
  return {
    manifest: file,
    run_id: manifest.run_id,
    started_at: manifest.started_at ?? null,
    strategy,
    domain_id: manifest.domain?.domain_id ?? null,
    intent_id: manifest.intent_id,
    provider: manifest.provider,
    model: manifest.model,
    documents: metrics.source_documents,
    evidence: metrics.evidence_units,
    claims: metrics.claims,
    profiles: metrics.document_profiles,
    relations: metrics.document_relations,
    decision_packets: metrics.decision_packets,
    compile_ms: compileStep?.duration_ms ?? metrics.duration_ms,
    build_ms: metrics.duration_ms,
    profile_wall_ms: profileWallMs,
    relation_wall_ms: metrics.relation_wall_duration_ms ?? 0,
    claim_calls: metrics.llm_calls,
    profile_calls: metrics.profile_llm_calls,
    relation_calls: metrics.relation_llm_calls ?? 0,
    total_calls: metrics.llm_calls + metrics.profile_llm_calls + (metrics.relation_llm_calls ?? 0),
    prompt_tokens: metrics.prompt_tokens + metrics.profile_prompt_tokens + (metrics.relation_prompt_tokens ?? 0),
    completion_tokens: metrics.completion_tokens + metrics.profile_completion_tokens + (metrics.relation_completion_tokens ?? 0),
    claim_cache_hits: metrics.extraction_cache_hits,
    profile_cache_hits: metrics.profile_cache_hits,
    relation_cache_hits: metrics.relation_cache_hits ?? 0,
    relation_candidate_edges: metrics.relation_candidate_edges ?? 0,
    relation_gold: relationGold,
  };
}

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.floor((ordered.length - 1) * fraction))];
}

function summarize(records) {
  const numeric = (field) => records.map((record) => record[field]).filter(Number.isFinite);
  const average = (field) => {
    const values = numeric(field);
    return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
  };
  return {
    runs: records.length,
    compile_ms: {
      mean: Math.round(average("compile_ms")),
      p50: percentile(numeric("compile_ms"), 0.5),
      p95: percentile(numeric("compile_ms"), 0.95),
    },
    profile_wall_ms: {
      mean: Math.round(average("profile_wall_ms")),
      share_of_compile_mean: average("compile_ms") === 0
        ? 0
        : Number((average("profile_wall_ms") / average("compile_ms")).toFixed(4)),
    },
    mean: {
      documents: Number(average("documents").toFixed(2)),
      evidence: Number(average("evidence").toFixed(2)),
      claims: Number(average("claims").toFixed(2)),
      relations: Number(average("relations").toFixed(2)),
      total_calls: Number(average("total_calls").toFixed(2)),
      prompt_tokens: Math.round(average("prompt_tokens")),
      completion_tokens: Math.round(average("completion_tokens")),
      relation_gold_precision: Number((records.reduce(
        (sum, record) => sum + (record.relation_gold?.precision ?? 0), 0,
      ) / records.filter((record) => record.relation_gold).length || 0).toFixed(4)),
      relation_gold_recall: Number((records.reduce(
        (sum, record) => sum + (record.relation_gold?.recall ?? 0), 0,
      ) / records.filter((record) => record.relation_gold).length || 0).toFixed(4)),
    },
  };
}

function pairedComparisons(records) {
  const byKey = {};
  for (const record of records) {
    const key = [record.domain_id, record.intent_id, record.provider, record.model].join("\u0000");
    const group = (byKey[key] ??= {});
    const current = group[record.strategy];
    if (!current || Date.parse(record.started_at ?? 0) >= Date.parse(current.started_at ?? 0)) {
      group[record.strategy] = record;
    }
  }
  return Object.values(byKey).flatMap((group) => {
    if (!group["global-v1"]) return [];
    return Object.entries(group)
      .filter(([strategy]) => strategy !== "global-v1")
      .map(([strategy, candidate]) => {
      const baseline = group["global-v1"];
      return {
        candidate_strategy: strategy,
        domain_id: candidate.domain_id,
        intent_id: candidate.intent_id,
        provider: candidate.provider,
        model: candidate.model,
        baseline_run_id: baseline.run_id,
        candidate_run_id: candidate.run_id,
        speedup: Number((baseline.compile_ms / candidate.compile_ms).toFixed(4)),
        compile_delta_ms: candidate.compile_ms - baseline.compile_ms,
        call_delta: candidate.total_calls - baseline.total_calls,
        prompt_token_delta: candidate.prompt_tokens - baseline.prompt_tokens,
        completion_token_delta: candidate.completion_tokens - baseline.completion_tokens,
        claim_delta: candidate.claims - baseline.claims,
        profile_delta: candidate.profiles - baseline.profiles,
        relation_delta: candidate.relations - baseline.relations,
        decision_packet_delta: candidate.decision_packets - baseline.decision_packets,
        baseline_relation_gold: baseline.relation_gold,
        candidate_relation_gold: candidate.relation_gold,
      };
    });
  });
}

function markdown(report) {
  const lines = [
    "# Compile Strategy Comparison",
    "",
    `Generated: ${report.generated_at}`,
    "",
    "| Strategy | Runs | Compile mean | P50 | P95 | Profile mean | Profile share | Calls | Prompt tokens | Completion tokens | Relation gold P/R |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const [strategy, summary] of Object.entries(report.strategies)) {
    lines.push(`| ${strategy} | ${summary.runs} | ${(summary.compile_ms.mean / 1000).toFixed(1)}s | ${(summary.compile_ms.p50 / 1000).toFixed(1)}s | ${(summary.compile_ms.p95 / 1000).toFixed(1)}s | ${(summary.profile_wall_ms.mean / 1000).toFixed(1)}s | ${(summary.profile_wall_ms.share_of_compile_mean * 100).toFixed(1)}% | ${summary.mean.total_calls.toFixed(1)} | ${summary.mean.prompt_tokens} | ${summary.mean.completion_tokens} | ${(summary.mean.relation_gold_precision * 100).toFixed(1)}% / ${(summary.mean.relation_gold_recall * 100).toFixed(1)}% |`);
  }
  if (report.pairs.length > 0) {
    lines.push(
      "",
      "## Paired comparisons",
      "",
      "| Strategy / Domain / Intent | Speedup | Compile delta | Call delta | Prompt token delta | Claims | Relations | Packets |",
      "|---|---:|---:|---:|---:|---:|---:|---:|",
    );
    for (const pair of report.pairs) {
      lines.push(`| ${pair.candidate_strategy} / ${pair.domain_id} / ${pair.intent_id} | ${pair.speedup.toFixed(2)}x | ${(pair.compile_delta_ms / 1000).toFixed(1)}s | ${pair.call_delta} | ${pair.prompt_token_delta} | ${pair.claim_delta} | ${pair.relation_delta} | ${pair.decision_packet_delta} |`);
    }
  }
  lines.push("", `Manifests: ${report.records.length}`, "");
  return `${lines.join("\n")}\n`;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node scripts/compare-compile-strategies.mjs [--input DIR]... [--output FILE] [--json]");
    return;
  }
  const files = [...new Set(options.inputs.flatMap((input) => walk(input, "manifest.json")))];
  const records = files
    .map((file) => recordFromManifest(file, readJson(file)))
    .filter(Boolean)
    .sort((left, right) => left.run_id.localeCompare(right.run_id));
  const grouped = {};
  for (const record of records) (grouped[record.strategy] ??= []).push(record);
  const strategies = Object.fromEntries(
    Object.entries(grouped).map(([strategy, entries]) => [strategy, summarize(entries)]),
  );
  const report = {
    schema_version: "1.0",
    generated_at: new Date().toISOString(),
    inputs: options.inputs,
    strategies,
    pairs: pairedComparisons(records),
    records,
  };
  const rendered = options.json ? `${JSON.stringify(report, null, 2)}\n` : markdown(report);
  if (options.output) {
    fs.mkdirSync(path.dirname(options.output), { recursive: true });
    fs.writeFileSync(options.output, rendered, "utf8");
  } else {
    process.stdout.write(rendered);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) main();
