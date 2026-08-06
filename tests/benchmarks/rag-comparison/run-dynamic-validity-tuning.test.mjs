import test from "node:test";
import assert from "node:assert/strict";

import { compareTuningRows, stageDocumentSources } from "./run-dynamic-validity-tuning.mjs";

test("T0は初期文書だけ、T1は追加文書も含む", () => {
  const manifest = { documents: [
    { source: "sources/base.md", introduced_at: "T0" },
    { source: "sources/update.md", introduced_at: "T1" },
  ] };
  assert.deepEqual([...stageDocumentSources(manifest, "T0")], ["sources/base.md"]);
  assert.deepEqual([...stageDocumentSources(manifest, "T1")], ["sources/base.md", "sources/update.md"]);
});

test("tuningは開発Recall@5を最優先する", () => {
  const rows = [
    { id: "a", recall_at_5: 0.8, recall_at_10: 1, chunk_count: 10 },
    { id: "b", recall_at_5: 0.9, recall_at_10: 0.9, chunk_count: 20 },
  ];
  assert.equal([...rows].sort(compareTuningRows)[0].id, "b");
});
