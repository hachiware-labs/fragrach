#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../../..");
const root = path.join(repositoryRoot, "target/benchmarks/enterprise-rag-bench");
const output = path.join(root, "query-obligations-v1.jsonl");
const inputs = ["0", "1", "2a", "2b", "3a", "3b"].map((suffix) =>
  path.join(root, `query-obligations-shard-${suffix}.jsonl`),
);

if (fs.existsSync(output)) throw new Error(`output already exists: ${output}`);
const rows = inputs.flatMap((file) => fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map(JSON.parse));
const expected = fs.readFileSync(path.join(root, "prepared-v2/questions.jsonl"), "utf8")
  .split(/\r?\n/).filter(Boolean).map(JSON.parse)
  .filter((row) => row.split === "development" || row.split === "diagnostic");
const byId = new Map(rows.map((row) => [row.question_id, row]));
const missing = expected.filter((row) => !byId.has(row.id)).map((row) => row.id);
if (rows.length !== expected.length || byId.size !== expected.length || missing.length > 0) {
  throw new Error(`obligation merge mismatch: rows=${rows.length}, unique=${byId.size}, expected=${expected.length}, missing=${missing.join(",")}`);
}
const ordered = expected.map((row) => byId.get(row.id));
fs.writeFileSync(output, `${ordered.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
const modes = Object.groupBy(ordered, (row) => row.mode);
console.log(JSON.stringify({ output, questions: ordered.length, modes: Object.fromEntries(Object.entries(modes).map(([key, value]) => [key, value.length])) }, null, 2));
