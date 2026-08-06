#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

let input = null;
let output = null;
let questionsPath = null;
let batchSize = 64;
let startShard = 0;
let endShard = Number.POSITIVE_INFINITY;
let ollamaNumBatch = null;
const endpoint = "http://127.0.0.1:11434";
const model = "hf.co/Targoyle/ruri-v3-310m-GGUF:Q8_0";
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument === "--input") input = path.resolve(process.argv[++index]);
  else if (argument === "--output") output = path.resolve(process.argv[++index]);
  else if (argument === "--questions") questionsPath = path.resolve(process.argv[++index]);
  else if (argument === "--batch-size") batchSize = Number.parseInt(process.argv[++index], 10);
  else if (argument === "--start-shard") startShard = Number.parseInt(process.argv[++index], 10);
  else if (argument === "--end-shard") endShard = Number.parseInt(process.argv[++index], 10);
  else if (argument === "--ollama-num-batch") ollamaNumBatch = Number.parseInt(process.argv[++index], 10);
  else throw new Error(`unknown argument: ${argument}`);
}
if (!input || !output || !questionsPath) throw new Error("--input, --output, and --questions are required");
const readJsonl = (file) => fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map(JSON.parse);
const manifest = JSON.parse(fs.readFileSync(path.join(input, "manifest.json"), "utf8"));
fs.mkdirSync(output, { recursive: true });

async function embed(values, label) {
  const vectors = [];
  for (let offset = 0; offset < values.length; offset += batchSize) {
    const batch = values.slice(offset, offset + batchSize);
    let error = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await fetch(`${endpoint}/api/embed`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model,
            input: batch,
            truncate: true,
            ...(ollamaNumBatch === null ? {} : { options: { num_batch: ollamaNumBatch, num_ctx: 8192 } }),
          }),
        });
        if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
        const payload = await response.json();
        if (payload.embeddings?.length !== batch.length) throw new Error("embedding response count mismatch");
        vectors.push(...payload.embeddings);
        error = null;
        break;
      } catch (caught) {
        error = caught;
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      }
    }
    if (error) throw error;
    const completed = Math.min(offset + batch.length, values.length);
    if (completed === values.length || completed % (batchSize * 20) === 0) {
      console.log(JSON.stringify({ label, embedded: completed, total: values.length }));
    }
  }
  return vectors;
}

function flatten(vectors) {
  const dimensions = vectors[0]?.length ?? 0;
  if (!dimensions || vectors.some((vector) => vector.length !== dimensions)) throw new Error("invalid vector dimensions");
  const values = new Float32Array(vectors.length * dimensions);
  vectors.forEach((vector, row) => values.set(vector, row * dimensions));
  return { dimensions, values };
}

function validShard(vectorFile, manifestFile, rows) {
  if (!fs.existsSync(vectorFile) || !fs.existsSync(manifestFile)) return false;
  const saved = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  return saved.rows === rows && fs.statSync(vectorFile).size === rows * saved.dimensions * 4;
}

const queryVectorFile = path.join(output, "queries.f32");
const queryManifestFile = path.join(output, "queries.json");
if (!fs.existsSync(queryVectorFile) || !fs.existsSync(queryManifestFile)) {
  const questions = readJsonl(questionsPath).filter((row) => ["development", "diagnostic"].includes(row.split));
  const started = Date.now();
  const embedded = flatten(await embed(questions.map((row) => `クエリ: ${row.question}`), "questions"));
  fs.writeFileSync(`${queryVectorFile}.tmp`, Buffer.from(embedded.values.buffer));
  fs.renameSync(`${queryVectorFile}.tmp`, queryVectorFile);
  fs.writeFileSync(queryManifestFile, `${JSON.stringify({
    schema_version: "1.0", model, rows: questions.length, dimensions: embedded.dimensions,
    question_ids: questions.map((row) => row.id), elapsed_ms: Date.now() - started,
  }, null, 2)}\n`, "utf8");
}

const selected = manifest.shards.filter((_, index) => index >= startShard && index < endShard);
for (const [position, shard] of selected.entries()) {
  const stem = path.basename(shard.file, ".jsonl");
  const vectorFile = path.join(output, `${stem}.f32`);
  const shardManifestFile = path.join(output, `${stem}.json`);
  if (validShard(vectorFile, shardManifestFile, shard.rows)) {
    console.log(JSON.stringify({ shard: stem, status: "cache-hit", position: position + 1, selected: selected.length }));
    continue;
  }
  const rows = readJsonl(path.join(input, shard.file));
  const started = Date.now();
  const embedded = flatten(await embed(rows.map((row) => `文章: ${row.text}`), stem));
  fs.writeFileSync(`${vectorFile}.tmp`, Buffer.from(embedded.values.buffer));
  fs.renameSync(`${vectorFile}.tmp`, vectorFile);
  fs.writeFileSync(shardManifestFile, `${JSON.stringify({
    schema_version: "1.0", model, input: shard.file, start_row: shard.start_row,
    rows: rows.length, dimensions: embedded.dimensions, batch_size: batchSize,
    ollama_num_batch: ollamaNumBatch,
    elapsed_ms: Date.now() - started, generated_at: new Date().toISOString(),
  }, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ shard: stem, status: "written", rows: rows.length, elapsed_ms: Date.now() - started }));
}
