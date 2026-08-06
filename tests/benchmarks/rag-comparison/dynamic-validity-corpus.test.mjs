import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildDynamicValidityChunks } from "./dynamic-validity-corpus.mjs";

test("manifestの複数source rootから宣言文書だけを読む", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "fragrach-dv-roots-"));
  const corpus = path.join(temporary, "corpus");
  const background = path.join(temporary, "background");
  fs.mkdirSync(path.join(corpus, "sources", "dynamic"), { recursive: true });
  fs.mkdirSync(path.join(background, "sources", "background"), { recursive: true });
  fs.writeFileSync(path.join(corpus, "sources", "dynamic", "rule.md"), "# 動的規則\n\n本文", "utf8");
  fs.writeFileSync(path.join(background, "sources", "background", "note.md"), "# 背景資料\n\n本文", "utf8");
  fs.writeFileSync(path.join(background, "sources", "background", "excluded.md"), "# 対象外\n\n本文", "utf8");
  const manifest = {
    source_roots: [".", "../background"],
    documents: [
      { source: "sources/dynamic/rule.md", introduced_at: "T0" },
      { source: "sources/background/note.md", introduced_at: "T0" },
    ],
  };
  const chunks = buildDynamicValidityChunks(corpus, manifest, { strategy: "paragraph" });
  assert.deepEqual([...new Set(chunks.map((chunk) => chunk.source))].sort(), [
    "sources/background/note.md",
    "sources/dynamic/rule.md",
  ]);
});
