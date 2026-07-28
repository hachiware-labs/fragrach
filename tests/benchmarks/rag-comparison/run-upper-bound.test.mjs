import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  Bm25Index,
  buildActualChunks,
  buildOracleChunks,
  documentMatchesAsOf,
  tokenize,
} from "./run-upper-bound.mjs";

test("日本語文字n-gramで分かち書きのない質問を検索できる", () => {
  const tokens = tokenize("設計レビューが必要ですか");
  assert(tokens.includes("設計"));
  assert(tokens.includes("レビ"));
});

test("Actual Buildを根拠単位に束ねてConflictとともに検索する", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fragarach-actual-"));
  const writeJsonl = (name, rows) =>
    fs.writeFileSync(
      path.join(directory, name),
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    );
  fs.writeFileSync(
    path.join(directory, "build-manifest.json"),
    JSON.stringify({ intent_id: "design-review" }),
  );
  fs.writeFileSync(
    path.join(directory, "provenance.json"),
    JSON.stringify({
      authority_precedence: ["corporate_standard", "guidance"],
    }),
  );
  writeJsonl("evidence.jsonl", [
    {
      source_id: "src",
      evidence_id: "ev",
      source_path: "policy.md",
      source_aliases: ["copies/policy-copy.md"],
      heading_path: ["承認"],
      text: "承認が必要",
      authority: "corporate_standard",
    },
  ]);
  writeJsonl("claims.jsonl", [
    {
      id: "claim",
      subject: "変更",
      predicate: "requires",
      object: "承認",
      evidence: [{ source_id: "src", evidence_id: "ev" }],
    },
  ]);
  writeJsonl("conflicts.jsonl", [
    {
      id: "conflict",
      kind: "semantic",
      status: "unresolved",
      claim_ids: ["claim"],
      diagnostic_id: "diagnostic",
    },
  ]);
  writeJsonl("diagnostics.jsonl", [
    { id: "diagnostic", message: "判断できません", reason: "根拠不足" },
  ]);

  const actual = buildActualChunks([directory]);
  assert.equal(actual.length, 2);
  assert(
    actual.some(
      (chunk) =>
        chunk.text.includes("種別: Compiled Retrieval Unit") &&
        chunk.text.includes("根拠本文: 承認が必要"),
    ),
  );
  assert(actual.some((chunk) => chunk.text.includes("判断できません")));
  assert.equal(actual[0].evidence[0].source, "sources/policy.md");
  assert.equal(actual[0].evidence[1].source, "sources/copies/policy-copy.md");
  assert.equal(actual[0].intent_id, "design-review");
  assert(actual[0].text.includes("権威優先順位: 1"));
  assert.equal(actual[0].score_boost, 1.1);
});

test("BM25は関連する規則を上位へ返す", () => {
  const documents = [
    {
      id: "unrelated",
      text: "勤怠申請と休暇の手続",
      evidence: [],
    },
    {
      id: "review",
      text: "外部仕様を変更する場合は設計レビューが必要",
      evidence: [],
    },
  ];
  const result = new Bm25Index(documents).search(
    "外部仕様の変更にはレビューが必要ですか",
    1,
  );
  assert.equal(result[0].document.id, "review");
});

test("Actual Buildの検索単位を対象日時で絞り込む", () => {
  assert(
    documentMatchesAsOf(
      { valid_from: "2025-07-01", valid_to: "2026-03-31" },
      "2025-12-15",
    ),
  );
  assert(
    !documentMatchesAsOf(
      { valid_from: "2026-04-01" },
      "2025-12-15",
    ),
  );
  assert(
    !documentMatchesAsOf(
      {
        validity_ranges: [
          { valid_from: "2025-07-01", valid_to: "2026-03-31" },
          { valid_from: "2026-04-01" },
        ],
      },
      "2025-12-15",
    ),
  );
});

test("Oracle知識はClaimとConflictを検索単位にする", () => {
  const raw = [
    {
      id: "raw:1",
      source: "sources/policy.md",
      section: "承認",
      evidence: [{ source: "sources/policy.md", section: "承認" }],
      text: "高リスク変更の承認",
    },
  ];
  const expected = {
    expected_claims: [
      {
        id: "claim-1",
        subject: "高リスク変更",
        predicate: "requires",
        object: "承認",
        evidence: { source: "sources/policy.md", section: "承認" },
      },
    ],
    expected_conflicts: [
      {
        id: "conflict-1",
        topic: "承認者",
        type: "authority_conflict",
        resolution: "正式規程を優先する",
        sources: ["sources/policy.md"],
      },
    ],
    event_sequences: [
      {
        id: "sequence-1",
        topic: "承認規則の変更",
        events: [
          {
            date: "2026-01-01",
            state: "effective",
            value: "正式規程を適用",
            source: "sources/policy.md",
            section: "承認",
          },
        ],
      },
    ],
  };

  const oracle = buildOracleChunks(expected, raw);
  assert.equal(oracle.length, 3);
  assert(oracle.some((chunk) => chunk.text.includes("種別: Claim")));
  assert(oracle.some((chunk) => chunk.text.includes("種別: Conflict")));
  assert(oracle.some((chunk) => chunk.text.includes("種別: Event Sequence")));
});
