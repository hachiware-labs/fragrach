#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createStructuredChat } from "./structured-chat.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../../..");
const root = path.join(repositoryRoot, "target/benchmarks/multihop-rag");
const output = path.join(root, "query-entity-bridges-v1.jsonl");
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
          required: ["question_id", "bridge_entity", "confidence", "expanded_obligations"],
          properties: {
            question_id: { type: "string", enum: questionIds },
            bridge_entity: { type: "string" },
            confidence: { type: "string", enum: ["none", "low", "high"] },
            expanded_obligations: { type: "array", minItems: 1, maxItems: 6, items: { type: "string" } },
          },
        },
      },
    },
  };
}

function prompt(batch) {
  const blocks = batch.map((item) => `## ${item.id}\nQuestion: ${item.question}\nOriginal obligations:\n- ${item.obligations.join("\n- ")}\nInitial retrieved materials:\n${item.material}`).join("\n\n---\n\n");
  return `Use only the question and initial retrieved materials to prepare a second retrieval hop.

For each question:
1. Identify a bridge entity that plausibly connects the evidence obligations, but only if that entity is explicitly supported in at least one retrieved material. Otherwise return an empty bridge_entity and confidence none.
2. Rewrite each original obligation as a self-contained search query. Add the bridge entity only when supported. Preserve publisher, date, quantity, and claim wording.
3. Do not add facts from outside the materials. Do not decide that the bridge entity is the final answer; it is only a retrieval hypothesis.

${blocks}`;
}

if (fs.existsSync(output)) throw new Error(`output already exists: ${output}`);
const questions = readJsonl(path.join(root, "prepared-v2/evaluation/questions.jsonl"))
  .filter((question) => question.split === "development" || question.split === "diagnostic");
const obligations = new Map(readJsonl(path.join(root, "query-obligations-v1.jsonl")).map((row) => [row.question_id, row.obligations]));
const packets = new Map(readJsonl(path.join(root, "query-packets-v7/retrieval.jsonl")).map((row) => [row.question_id, row.results[0]?.text ?? ""]));
const inputs = questions.map((question) => ({
  id: question.id,
  split: question.split,
  category: question.category,
  question: question.question,
  obligations: obligations.get(question.id) ?? [question.question],
  material: packets.get(question.id) ?? "No material retrieved.",
}));
const client = await createStructuredChat({ provider: "codex-app-server", cwd: repositoryRoot, model: "gpt-5.6-luna", reasoningEffort: "low" });
try {
  const responses = await concurrentMap(batches(inputs, 4), 8, async (batch) => {
    const response = await client.chat(prompt(batch), schema(batch.map((item) => item.id)));
    const byId = new Map(response.content.results.map((item) => [item.question_id, item]));
    return batch.map((item) => ({ split: item.split, category: item.category, ...byId.get(item.id) }));
  });
  fs.mkdirSync(path.dirname(output), { recursive: true });
  writeJsonl(output, responses.flat());
  console.log(JSON.stringify({ output, questions: inputs.length, model: "gpt-5.6-luna", concurrency: 8 }, null, 2));
} finally {
  await client.close();
}
