#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createStructuredChat } from "./structured-chat.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../../..");
const root = path.join(repositoryRoot, "target/benchmarks/enterprise-rag-bench");
let output = path.join(root, "query-obligations-v1.jsonl");
let limit = null;
let offset = 0;
let concurrency = 8;
let batchSize = 10;
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument === "--output") output = path.resolve(process.argv[++index]);
  else if (argument === "--limit") limit = Number.parseInt(process.argv[++index], 10);
  else if (argument === "--offset") offset = Number.parseInt(process.argv[++index], 10);
  else if (argument === "--concurrency") concurrency = Number.parseInt(process.argv[++index], 10);
  else if (argument === "--batch-size") batchSize = Number.parseInt(process.argv[++index], 10);
  else throw new Error(`unknown argument: ${argument}`);
}
const readJsonl = (file) => fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));

function batches(items, size) {
  const result = [];
  for (let offset = 0; offset < items.length; offset += size) result.push(items.slice(offset, offset + size));
  return result;
}

async function concurrentMap(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

function schema(ids) {
  return { type: "object", additionalProperties: false, required: ["results"], properties: { results: {
    type: "array", minItems: ids.length, maxItems: ids.length, items: { type: "object", additionalProperties: false,
      required: ["question_id", "mode", "obligations"], properties: {
        question_id: { type: "string", enum: ids },
        mode: { type: "string", enum: ["point", "list", "conflict", "constraint", "absence"] },
        obligations: { type: "array", minItems: 1, maxItems: 12, items: { type: "string" } },
      } },
  } } };
}

function prompt(batch) {
  const questions = batch.map((item) => `${item.id}: ${item.question}`).join("\n\n");
  return `Compile each enterprise search question into independent retrieval obligations. Do not answer any question and do not use outside knowledge.

Choose one mode:
- point: one governing fact or one-document answer
- list: all matching items or a completeness request
- conflict: both incompatible statements or positions must be retrieved
- constraint: only facts satisfying an explicit team, date, state, source, or other filter count
- absence: the question may require proving that no supported information exists

Rules:
- Preserve exact product, project, person, metric, date, quantity, source-system, and quoted identifier clues.
- Split independently sourced subquestions into separate self-contained search queries.
- For conflict, create obligations for both sides. For list, create obligations for each explicitly named class or item; do not invent unknown members. For constraint, repeat the binding constraint in every affected obligation.
- Do not include a guessed answer, document ID, or fact not present in the question.

Questions:
${questions}`;
}

if (fs.existsSync(output)) throw new Error(`output already exists: ${output}`);
const questions = readJsonl(path.join(root, "prepared-v2/questions.jsonl"))
  .filter((question) => question.split === "development" || question.split === "diagnostic")
  .slice(offset, limit === null ? undefined : offset + limit);
const client = await createStructuredChat({ provider: "codex-app-server", cwd: repositoryRoot, model: "gpt-5.6-luna", reasoningEffort: "low" });
try {
  const responses = await concurrentMap(batches(questions, batchSize), concurrency, async (batch, batchIndex) => {
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await client.chat(prompt(batch), schema(batch.map((item) => item.id)));
        const byId = new Map(response.content.results.map((item) => [item.question_id, item]));
        const missing = batch.filter((item) => !byId.has(item.id)).map((item) => item.id);
        if (missing.length > 0 || byId.size !== batch.length) {
          throw new Error(`structured response IDs mismatch; missing=${missing.join(",")}, unique=${byId.size}, expected=${batch.length}`);
        }
        return batch.map((item) => {
          const result = byId.get(item.id);
          return { question_id: item.id, split: item.split, category: item.category, mode: result.mode, obligations: result.obligations };
        });
      } catch (error) {
        lastError = error;
        console.error(`Enterprise obligation batch ${batchIndex} attempt ${attempt} failed: ${error.message}`);
      }
    }
    throw lastError;
  });
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${responses.flat().map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
  console.log(JSON.stringify({ output, questions: questions.length, model: "gpt-5.6-luna", concurrency, batch_size: batchSize }, null, 2));
} finally {
  await client.close();
}
