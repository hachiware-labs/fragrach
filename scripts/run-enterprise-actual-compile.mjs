#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), "..");
const defaultCorpus = path.join(repositoryRoot, "tests/corpora/fragrach-enterprise-ja-diverse");
const defaultOutput = path.join(repositoryRoot, "target/benchmarks/enterprise-domain-actual");
const defaultCli = path.join(repositoryRoot, "target/debug/fragarach.exe");

const readJsonl = (file) => fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const sha256File = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function parseArgs(argv) {
  const options = {
    corpus: defaultCorpus,
    output: defaultOutput,
    cli: defaultCli,
    domain: null,
    intent: null,
    provider: "ollama",
    model: "gemma4:latest",
    codexCommand: "codex",
    reasoningEffort: "low",
    batchSize: 12,
    runId: null,
    validationReport: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--corpus") options.corpus = path.resolve(argv[++index]);
    else if (arg === "--output") options.output = path.resolve(argv[++index]);
    else if (arg === "--cli") options.cli = path.resolve(argv[++index]);
    else if (arg === "--domain") options.domain = argv[++index];
    else if (arg === "--intent") options.intent = argv[++index];
    else if (arg === "--provider") options.provider = argv[++index];
    else if (arg === "--model") options.model = argv[++index];
    else if (arg === "--codex-command") options.codexCommand = path.resolve(argv[++index]);
    else if (arg === "--reasoning-effort") options.reasoningEffort = argv[++index];
    else if (arg === "--batch-size") options.batchSize = Number(argv[++index]);
    else if (arg === "--run-id") options.runId = argv[++index];
    else if (arg === "--validation-report") options.validationReport = path.resolve(argv[++index]);
    else if (arg === "--help") options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function executableIdentity(command) {
  const result = spawnSync(command, ["--version"], { encoding: "utf8", timeout: 30_000 });
  return {
    path: command,
    sha256: fs.existsSync(command) ? sha256File(command) : null,
    version: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
    status: result.status,
    error: result.error?.message ?? null,
  };
}

function ollamaIdentity(model) {
  const result = spawnSync("ollama", ["show", model, "--modelfile"], { encoding: "utf8", timeout: 30_000 });
  const tags = spawnSync("powershell", ["-NoProfile", "-Command", "(Invoke-RestMethod http://127.0.0.1:11434/api/tags | ConvertTo-Json -Depth 5 -Compress)"], { encoding: "utf8", timeout: 30_000 });
  let digest = null;
  try {
    const parsed = JSON.parse(tags.stdout);
    const candidate = parsed.models.find((item) => item.name === model || item.model === model);
    digest = candidate?.digest ?? null;
  } catch {
    // The raw command output is retained in the step log below.
  }
  return { model, digest, show_status: result.status, show_output: result.stdout, show_error: result.stderr };
}

function runStep(runDirectory, index, name, command, args, timeoutMs) {
  const startedAt = new Date();
  const result = spawnSync(command, args, { cwd: repositoryRoot, encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  const completedAt = new Date();
  const record = {
    index,
    name,
    command,
    args,
    started_at: startedAt.toISOString(),
    completed_at: completedAt.toISOString(),
    duration_ms: completedAt - startedAt,
    status: result.status,
    signal: result.signal,
    error: result.error ? { name: result.error.name, message: result.error.message, stack: result.error.stack } : null,
  };
  fs.writeFileSync(path.join(runDirectory, `${String(index).padStart(2, "0")}-${name}.stdout.log`), result.stdout ?? "", "utf8");
  fs.writeFileSync(path.join(runDirectory, `${String(index).padStart(2, "0")}-${name}.stderr.log`), result.stderr ?? "", "utf8");
  fs.writeFileSync(path.join(runDirectory, `${String(index).padStart(2, "0")}-${name}.json`), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  if (result.error || result.status !== 0) {
    const error = new Error(`${name} failed with status ${result.status}: ${result.error?.message ?? result.stderr}`);
    error.step = record;
    throw error;
  }
  return record;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node scripts/run-enterprise-actual-compile.mjs --domain ID --intent ID [--provider ollama|codex-app-server] [--model ID] [--validation-report FILE] [--run-id ID]");
    return;
  }
  if (!options.domain || !options.intent) throw new Error("--domain and --intent are required");
  if (!Number.isInteger(options.batchSize) || options.batchSize < 1) throw new Error("--batch-size must be a positive integer");
  if (!fs.existsSync(options.cli)) throw new Error(`Fragrach CLI not found: ${options.cli}; run cargo build -p fragarach-cli`);
  const domains = readJsonl(path.join(options.corpus, "evaluation/rag-domains.jsonl"));
  const domain = domains.find((candidate) => candidate.domain_id === options.domain);
  if (!domain) throw new Error(`unknown domain: ${options.domain}`);
  if (!domain.intent_ids.includes(options.intent)) throw new Error(`intent ${options.intent} is not defined for ${options.domain}`);
  const intentFile = path.join(options.corpus, "intents", `${options.intent}.yaml`);
  const fullValidation = path.join(options.corpus, "generation/validation-report.json");
  const domainValidation = path.join(options.corpus, "generation", `validation-report-${options.domain}.json`);
  const validationReport = options.validationReport ?? (fs.existsSync(fullValidation) ? fullValidation : domainValidation);
  if (!fs.existsSync(validationReport)) {
    throw new Error(`validation report not found: ${validationReport}; validate the full corpus or pass --validation-report`);
  }
  const startedAt = new Date();
  const runId = options.runId ?? `${startedAt.toISOString().replace(/[:.]/g, "-")}-${options.domain}-${options.intent}-${options.provider}`;
  const runDirectory = path.join(options.output, runId);
  if (fs.existsSync(runDirectory)) throw new Error(`run directory already exists: ${runDirectory}`);
  fs.mkdirSync(runDirectory, { recursive: true });
  const workspace = path.join(runDirectory, "workspace");
  const build = path.join(runDirectory, "knowledge-build");
  const include = `${domain.industry}/${domain.department}/${options.intent}/**`;
  const steps = [];
  const baseManifest = {
    schema_version: "1.0",
    experiment: "enterprise-actual-compile",
    run_id: runId,
    status: "running",
    started_at: startedAt.toISOString(),
    repository_root: repositoryRoot,
    corpus_root: options.corpus,
    domain,
    intent_id: options.intent,
    include,
    provider: options.provider,
    model: options.model,
    reasoning_effort: options.reasoningEffort,
    batch_size: options.batchSize,
    context_length: options.provider === "ollama" ? 32768 : "provider-managed",
    cache_enabled: true,
    cli: executableIdentity(options.cli),
    provider_executable: options.provider === "codex-app-server" ? executableIdentity(options.codexCommand) : ollamaIdentity(options.model),
    inputs: {
      intent: { path: intentFile, sha256: sha256File(intentFile) },
      questions: { path: path.join(options.corpus, "evaluation/questions.jsonl"), sha256: sha256File(path.join(options.corpus, "evaluation/questions.jsonl")) },
      validation: { path: validationReport, sha256: sha256File(validationReport) },
    },
    runtime: { node: process.version, platform: process.platform, arch: process.arch, cpus: os.cpus().length },
  };
  fs.writeFileSync(path.join(runDirectory, "manifest.json"), `${JSON.stringify(baseManifest, null, 2)}\n`, "utf8");
  try {
    steps.push(runStep(runDirectory, 1, "init", options.cli, ["--json", "init", workspace], 120_000));
    steps.push(runStep(runDirectory, 2, "scan", options.cli, ["--json", "scan", "--source", path.join(options.corpus, "sources"), "--workspace", workspace, "--include", include], 300_000));
    const compileArgs = ["--json", "compile", "--workspace", workspace, "--intent", intentFile, "--output", build, "--provider", options.provider, "--model", options.model, "--batch-size", String(options.batchSize), "--as-of", "2026-07-15", "--on-unresolved-conflict", "warn"];
    if (options.provider === "codex-app-server") compileArgs.push("--codex-command", options.codexCommand, "--reasoning-effort", options.reasoningEffort);
    steps.push(runStep(runDirectory, 3, "compile", options.cli, compileArgs, 30 * 60_000));
    const buildManifest = JSON.parse(fs.readFileSync(path.join(build, "build-manifest.json"), "utf8"));
    const completedAt = new Date();
    const manifest = { ...baseManifest, status: "completed", completed_at: completedAt.toISOString(), duration_ms: completedAt - startedAt, workspace, build, steps, build_manifest: buildManifest };
    fs.writeFileSync(path.join(runDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    fs.writeFileSync(path.join(options.output, "latest-run.txt"), `${runId}\n`, "utf8");
    console.log(`Run ${runId}; documents ${buildManifest.metrics.source_documents}; claims ${buildManifest.metrics.claims}; LLM calls ${buildManifest.metrics.llm_calls}; cache hits ${buildManifest.metrics.extraction_cache_hits}; duration ${buildManifest.metrics.duration_ms} ms`);
  } catch (error) {
    const failedAt = new Date();
    fs.writeFileSync(path.join(runDirectory, "manifest.json"), `${JSON.stringify({ ...baseManifest, status: "failed", failed_at: failedAt.toISOString(), duration_ms: failedAt - startedAt, steps, error: { name: error.name, message: error.message, stack: error.stack, step: error.step ?? null } }, null, 2)}\n`, "utf8");
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) main();
