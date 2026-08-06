import assert from "node:assert/strict";
import test from "node:test";

import { buildCorpusModel } from "./generate-enterprise-diverse-corpus.mjs";
import { buildOutline, DEFAULT_DOMAINS, generate, removeUngroundedFactualSentences } from "./generate-enterprise-longform-corpus.mjs";

test("long-form corpus selects four department RAG domains and a mixed length profile", async () => {
  const result = await generate({ dryRun: true });
  assert.deepEqual(result.domains, DEFAULT_DOMAINS);
  assert.equal(result.documents, 288);
  assert.equal(result.long_documents, 72);
  assert.equal(result.short_documents, 216);
  assert(result.target_long_characters >= 500_000);
});

test("outline is deterministic and distributes protected Gold sections", () => {
  const doc = buildCorpusModel().documents.find((item) =>
    item.industry === "manufacturing" &&
    item.department === "product-design" &&
    item.type === "technical_specification");
  const first = buildOutline(doc);
  const second = buildOutline(doc);
  assert.deepEqual(first, second);
  assert.equal(first.target_chars, 10_000);
  assert.equal(first.sections.filter((item) => item.kind === "gold_anchor").length, 3);
  assert(first.sections[0].kind === "generated_context");
  assert(first.sections.at(-1).kind === "generated_context");
  const positions = first.sections.map((item) => item.kind).reduce((values, kind, index) => kind === "gold_anchor" ? [...values, index] : values, []);
  assert(positions[0] < positions[1] && positions[1] < positions[2]);
});

test("selected long-form documents have one authority profile each", () => {
  const model = buildCorpusModel();
  const domains = new Set(DEFAULT_DOMAINS);
  const documents = model.documents.filter((item) => domains.has(`${item.industry}-${item.department}`));
  const ids = new Set(documents.map((item) => item.id));
  const profiles = model.profiles.filter((item) => ids.has(item.source_id));
  assert.equal(profiles.length, documents.length);
  assert(profiles.every((item) => item.relative_path.startsWith("sources/")));
});

test("unsupported generated numbers are removed sentence by sentence", () => {
  const content = "対象はAX-14である。未定義の第4.2.1節も参照する。既知の値は30分である。一般的な照合観点を説明する。";
  const sanitized = removeUngroundedFactualSentences(content, "AX-14\n30分");
  assert.equal(sanitized, "対象はAX-14である。既知の値は30分である。一般的な照合観点を説明する。");
});
