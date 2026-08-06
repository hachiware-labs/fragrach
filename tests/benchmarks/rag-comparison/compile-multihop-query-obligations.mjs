#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createStructuredChat } from "./structured-chat.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../../..");
const corpus = path.join(repositoryRoot, "target/benchmarks/multihop-rag/prepared-v2");
let output = path.join(repositoryRoot, "target/benchmarks/multihop-rag/query-obligations-v1.jsonl");
let selectedSplits = ["development", "diagnostic"];
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument === "--output") output = path.resolve(process.argv[++index]);
  else if (argument === "--splits") selectedSplits = process.argv[++index].split(",");
  else throw new Error(`unknown argument: ${argument}`);
}
const readJsonl = (file) => fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const writeJsonl = (file, rows) => fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");

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

function schema(questionIds) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["results"],
    properties: {
      results: {
        type: "array",
        minItems: questionIds.length,
        maxItems: questionIds.length,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["question_id", "obligations"],
          properties: {
            question_id: { type: "string", enum: questionIds },
            obligations: {
              type: "array",
              minItems: 1,
              maxItems: 6,
              items: { type: "string" },
            },
          },
        },
      },
    },
  };
}

function prompt(batch) {
  const questions = batch.map((item) => `${item.id}: ${item.question}`).join("\n\n");
  return `Decompose each multi-hop question into independently retrievable evidence obligations.

Rules:
- Do not answer the question and do not use outside knowledge.
- Create one obligation for each distinct reported fact, comparison item, or time-specific event that needs its own source evidence.
- Preserve publisher names, quoted phrases, named entities, dates, quantities, and relation wording from the question.
- Make each obligation a self-contained search query by repeating the shared subject clues when needed.
- Do not create a separate obligation merely for the final act of identifying the common answer.
- Return one to six concise obligations in the same language as the question.

Questions:
${questions}`;
}

if (fs.existsSync(output)) throw new Error(`output already exists: ${output}`);
const questions = readJsonl(path.join(corpus, "evaluation/questions.jsonl"))
  .filter((question) => selectedSplits.includes(question.split));
const client = await createStructuredChat({
  provider: "codex-app-server",
  cwd: repositoryRoot,
  model: "gpt-5.6-luna",
  reasoningEffort: "low",
});
try {
  const responses = await concurrentMap(batches(questions, 10), 8, async (batch) => {
    const ids = batch.map((item) => item.id);
    const response = await client.chat(prompt(batch), schema(ids));
    const byId = new Map(response.content.results.map((item) => [item.question_id, item]));
    return batch.map((item) => {
      const result = byId.get(item.id);
      if (!result) throw new Error(`missing obligations for ${item.id}`);
      return { question_id: item.id, split: item.split, category: item.category, obligations: result.obligations };
    });
  });
  fs.mkdirSync(path.dirname(output), { recursive: true });
  writeJsonl(output, responses.flat());
  console.log(JSON.stringify({ output, splits: selectedSplits, questions: questions.length, model: "gpt-5.6-luna", concurrency: 8 }, null, 2));
} finally {
  await client.close();
}
