#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaults = {
  corpus: path.join(repositoryRoot, "tests/corpora/aobane-industries-ja-dynamic-validity-scale"),
  output: path.join(repositoryRoot, "target/benchmarks/dynamic-validity-scale-fcompile-v2"),
  cli: path.join(repositoryRoot, "target/debug/fragarach.exe"),
  provider: "codex-app-server",
  model: "gpt-5.6-luna",
  codexCommand: "codex.cmd",
  reasoningEffort: "low",
  batchSize: 64,
  llmConcurrency: 2,
  shards: 4,
};

function parseArguments(argv) {
  const options = { ...defaults };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--corpus") options.corpus = path.resolve(argv[++index]);
    else if (argument === "--output") options.output = path.resolve(argv[++index]);
    else if (argument === "--cli") options.cli = path.resolve(argv[++index]);
    else if (argument === "--provider") options.provider = argv[++index];
    else if (argument === "--model") options.model = argv[++index];
    else if (argument === "--codex-command") options.codexCommand = argv[++index];
    else if (argument === "--reasoning-effort") options.reasoningEffort = argv[++index];
    else if (argument === "--batch-size") options.batchSize = Number.parseInt(argv[++index], 10);
    else if (argument === "--llm-concurrency") options.llmConcurrency = Number.parseInt(argv[++index], 10);
    else if (argument === "--shards") options.shards = Number.parseInt(argv[++index], 10);
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

function runStep(options, index, name, args, timeoutMs) {
  const startedAt = new Date();
  const result = spawnSync(options.cli, ["--json", ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 128 * 1024 * 1024,
  });
  const completedAt = new Date();
  const record = {
    index,
    name,
    started_at: startedAt.toISOString(),
    completed_at: completedAt.toISOString(),
    duration_ms: completedAt - startedAt,
    status: result.status,
    signal: result.signal,
    args,
    error: result.error?.message ?? null,
  };
  fs.writeFileSync(path.join(options.output, `${String(index).padStart(2, "0")}-${name}.stdout.log`), result.stdout ?? "", "utf8");
  fs.writeFileSync(path.join(options.output, `${String(index).padStart(2, "0")}-${name}.stderr.log`), result.stderr ?? "", "utf8");
  if (result.error || result.status !== 0) {
    throw new Error(`${name} failed: ${result.error?.message ?? result.stderr}`);
  }
  return record;
}

function runStepAsync(options, index, name, args, timeoutMs) {
  const startedAt = new Date();
  const stdout = fs.createWriteStream(path.join(options.output, `${String(index).padStart(2, "0")}-${name}.stdout.log`));
  const stderr = fs.createWriteStream(path.join(options.output, `${String(index).padStart(2, "0")}-${name}.stderr.log`));
  return new Promise((resolve, reject) => {
    const child = spawn(options.cli, ["--json", ...args], { cwd: repositoryRoot, windowsHide: true });
    child.stdout.pipe(stdout);
    child.stderr.pipe(stderr);
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("error", reject);
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      stdout.end();
      stderr.end();
      const completedAt = new Date();
      const record = {
        index, name,
        started_at: startedAt.toISOString(),
        completed_at: completedAt.toISOString(),
        duration_ms: completedAt - startedAt,
        status, signal, args,
      };
      if (status !== 0) reject(new Error(`${name} failed with status ${status}; see its stderr log`));
      else resolve(record);
    });
  });
}

function prepareShards(options) {
  const manifest = JSON.parse(fs.readFileSync(path.join(options.corpus, "manifest.json"), "utf8"));
  const families = new Map();
  for (const document of manifest.documents) {
    const source = String(document.source).replaceAll("\\", "/");
    const match = source.match(/^sources\/70-dynamic\/(dvx-\d+)\//);
    if (!match) continue;
    if (!families.has(match[1])) families.set(match[1], []);
    families.get(match[1]).push(source);
  }
  const shards = Array.from({ length: options.shards }, (_, index) => ({ index: index + 1, families: [], sources: [] }));
  [...families.entries()].sort(([left], [right]) => left.localeCompare(right)).forEach(([family, sources], index) => {
    const shard = shards[index % shards.length];
    shard.families.push(family);
    shard.sources.push(...sources);
  });
  for (const shard of shards) {
    shard.sourceRoot = path.join(options.output, "staged", `shard-${shard.index}`);
    for (const source of shard.sources) {
      const relative = source.replace(/^sources\//, "");
      const from = path.join(options.corpus, source);
      const to = path.join(shard.sourceRoot, relative);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    }
  }
  return shards;
}

export function compileArguments(options, workspace, build, intent) {
  const args = [
    "compile", "--workspace", workspace,
    "--intent", intent,
    "--output", build,
    "--provider", options.provider,
    "--model", options.model,
    "--batch-size", String(options.batchSize),
    "--llm-concurrency", String(options.llmConcurrency),
    "--as-of", "2026-08-15",
    "--on-unresolved-conflict", "warn",
  ];
  if (options.provider === "codex-app-server") {
    args.push("--codex-command", options.codexCommand, "--reasoning-effort", options.reasoningEffort);
  }
  return args;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node scripts/run-dynamic-validity-fcompile.mjs [--output DIR] [--batch-size N] [--llm-concurrency N] [--shards N]");
    return;
  }
  if (!Number.isInteger(options.batchSize) || options.batchSize < 1) throw new Error("--batch-size must be positive");
  if (!Number.isInteger(options.llmConcurrency) || options.llmConcurrency < 1) throw new Error("--llm-concurrency must be positive");
  if (!Number.isInteger(options.shards) || options.shards < 1) throw new Error("--shards must be positive");
  if (!fs.existsSync(options.cli)) throw new Error(`Fragrach CLI not found: ${options.cli}`);
  if (fs.existsSync(options.output)) throw new Error(`output already exists: ${options.output}`);
  fs.mkdirSync(options.output, { recursive: true });
  const intent = path.join(options.corpus, "intents/dynamic-validity.yaml");
  const shards = prepareShards(options);
  const startedAt = new Date();
  const manifest = {
    schema_version: "1.0",
    experiment: "dynamic-validity-fcompile-t1",
    status: "running",
    started_at: startedAt.toISOString(),
    stage: "T1",
    scope: "sources/70-dynamic/**",
    corpus: options.corpus,
    provider: options.provider,
    model: options.model,
    reasoning_effort: options.reasoningEffort,
    batch_size: options.batchSize,
    llm_concurrency: options.llmConcurrency,
    shards: shards.map((shard) => ({ index: shard.index, families: shard.families, documents: shard.sources.length })),
    builds: [],
    steps: [],
  };
  fs.writeFileSync(path.join(options.output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  try {
    for (const shard of shards) {
      shard.workspace = path.join(options.output, `workspace-${shard.index}`);
      shard.build = path.join(options.output, `knowledge-build-${shard.index}`);
      manifest.steps.push(runStep(options, shard.index * 10 + 1, `shard-${shard.index}-init`, ["init", shard.workspace], 120_000));
      manifest.steps.push(runStep(options, shard.index * 10 + 2, `shard-${shard.index}-scan`, [
        "scan", "--source", shard.sourceRoot,
        "--workspace", shard.workspace,
      ], 600_000));
    }
    const compileSteps = await Promise.all(shards.map((shard) => runStepAsync(
      options,
      shard.index * 10 + 3,
      `shard-${shard.index}-compile`,
      compileArguments(options, shard.workspace, shard.build, intent),
      60 * 60_000,
    )));
    manifest.steps.push(...compileSteps);
    manifest.status = "completed";
    manifest.completed_at = new Date().toISOString();
    manifest.duration_ms = new Date(manifest.completed_at) - startedAt;
    manifest.builds = shards.map((shard) => ({
      path: shard.build,
      manifest: JSON.parse(fs.readFileSync(path.join(shard.build, "build-manifest.json"), "utf8")),
    }));
    fs.writeFileSync(path.join(options.output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({
      status: manifest.status,
      builds: manifest.builds.map((item) => ({ path: item.path, metrics: item.manifest.metrics })),
    }, null, 2));
  } catch (error) {
    manifest.status = "failed";
    manifest.failed_at = new Date().toISOString();
    manifest.error = { name: error.name, message: error.message, stack: error.stack };
    fs.writeFileSync(path.join(options.output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
