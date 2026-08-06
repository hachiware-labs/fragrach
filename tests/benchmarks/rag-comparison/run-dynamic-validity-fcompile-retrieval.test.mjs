import assert from "node:assert/strict";
import test from "node:test";

import {
  composeDecisionPacketResults, expandCompiledResults,
} from "./run-dynamic-validity-fcompile-retrieval.mjs";

test("Position Dossierは複数原文を引用できる一つの回答資料として保持する", () => {
  const ranked = [
    {
      rank: 1,
      score: 0.9,
      document: {
        id: "actual:relation-dossier:test/rel-1",
        unit_type: "relation_dossier",
        text: "関係: amends",
        relation: {
          position: "dominates",
          source_id: "new",
          target_id: "old",
          evidence: [
            { source_id: "new" }, { source_id: "old" }, { source_id: "ledger" },
          ],
        },
        evidence: [
          { source_id: "old", source: "sources/a.md", section: "基準", text: "元基準" },
          { source_id: "old", source: "sources/a.md", section: "別節", text: "重複" },
          { source_id: "new", source: "sources/b.md", section: "追補", text: "変更" },
        ],
      },
    },
  ];

  const results = expandCompiledResults(ranked, 5);

  assert.equal(results.length, 1);
  assert.equal(results[0].source, "actual:relation-dossier:test/rel-1");
  assert.deepEqual(results[0].citation_sources, ["sources/a.md", "sources/b.md"]);
  assert.match(results[0].text, /関係: amends/);
  assert.match(results[0].text, /元基準/);
  assert.match(results[0].text, /変更/);
  assert.equal(results[0].compiled_unit_type, "relation_dossier");
  assert.deepEqual(results[0].evidence_roles, [
    { source: "sources/a.md", use: "reference", basis: "excluded" },
    { source: "sources/b.md", use: "governing", basis: "operative" },
  ]);
});

test("F-Compile検索結果はtop-kで打ち切る", () => {
  const ranked = [
    {
      rank: 1,
      score: 0.8,
      document: {
        id: "actual:evidence:test/ev-1",
        unit_type: "claim_evidence",
        text: "compiled",
        evidence: [
          { source: "sources/a.md", text: "A" },
          { source: "sources/b.md", text: "B" },
        ],
      },
    },
  ];

  assert.deepEqual(expandCompiledResults(ranked, 1).map((item) => item.source), ["sources/a.md"]);
});

test("通常chunkのsource_idをanchorにして対応Decision Packetを先頭へ合成する", () => {
  const anchor = {
    rank: 1,
    score: 0.92,
    document: {
      id: "actual:evidence:test/new",
      unit_type: "claim_evidence",
      text: "質問に一致する新基準は6 mm",
      evidence: [{ source_id: "new", source: "sources/new.md", text: "6 mm" }],
    },
  };
  const unrelated = {
    rank: 2,
    score: 0.7,
    document: {
      id: "actual:evidence:test/other",
      unit_type: "claim_evidence",
      text: "別件",
      evidence: [{ source_id: "other", source: "sources/other.md", text: "別件" }],
    },
  };
  const packet = {
    id: "actual:relation-dossier:test/rel-new-old",
    unit_type: "relation_dossier",
    text: "Position: dominates",
    relation: {
      position: "dominates",
      source_id: "new",
      target_id: "old",
      evidence: [
        { source_id: "new" }, { source_id: "old" }, { source_id: "ledger" },
      ],
    },
    evidence: [
      { source_id: "new", source: "sources/new.md", text: "6 mm" },
      { source_id: "old", source: "sources/old.md", text: "8 mm" },
      { source_id: "ledger", source: "sources/ledger.md", text: "new is current" },
    ],
  };

  const results = composeDecisionPacketResults([anchor, unrelated], [packet], 2);

  assert.equal(results[0].source, packet.id);
  assert.match(results[0].text, /質問関連anchor/);
  assert.match(results[0].text, /質問に一致する新基準/);
  assert.deepEqual(results[0].evidence_roles, [
    { source: "sources/new.md", use: "governing", basis: "operative" },
    { source: "sources/old.md", use: "reference", basis: "excluded" },
    { source: "sources/ledger.md", use: "governing", basis: "verifier" },
  ]);
});

test("同じRelation componentでは有効側Packetを非有効側より優先する", () => {
  const anchor = {
    rank: 1,
    score: 0.9,
    document: {
      id: "chunk:base",
      unit_type: "raw_document_chunk",
      text: "現行基準",
      evidence: [{ source_id: "base", source: "sources/base.md", text: "基準" }],
    },
  };
  const nonEffective = {
    id: "packet:expired",
    unit_type: "relation_dossier",
    text: "期限切れ例外",
    relation: {
      position: "non_effective", source_id: "expired", target_id: "base",
      verifier_source_ids: ["ledger"],
    },
    evidence: [
      { source_id: "expired", source: "sources/expired.md", text: "期限切れ" },
      { source_id: "base", source: "sources/base.md", text: "基準" },
      { source_id: "ledger", source: "sources/ledger.md", text: "台帳" },
    ],
  };
  const conditional = {
    id: "packet:exception",
    unit_type: "relation_dossier",
    text: "有効な例外",
    relation: {
      position: "conditional", source_id: "exception", target_id: "base",
      verifier_source_ids: ["ledger"],
    },
    evidence: [
      { source_id: "exception", source: "sources/exception.md", text: "例外" },
      { source_id: "base", source: "sources/base.md", text: "基準" },
      { source_id: "ledger", source: "sources/ledger.md", text: "台帳" },
    ],
  };

  const results = composeDecisionPacketResults(
    [anchor], [nonEffective, conditional], 1, { anchorK: 1, packetBudget: 1 },
  );

  assert.equal(results[0].source, "packet:exception");
});

test("Packet枠は同じRelation componentの重複より別componentを優先する", () => {
  const anchor = (rank, id) => ({
    rank,
    score: 1 - rank / 10,
    document: {
      id: `chunk:${id}`,
      unit_type: "raw_document_chunk",
      text: id,
      evidence: [{ source_id: id, source: `sources/${id}.md`, text: id }],
    },
  });
  const packet = (id, position, sourceId, targetId, verifier) => ({
    id: `packet:${id}`,
    unit_type: "relation_dossier",
    text: id,
    relation: {
      position, source_id: sourceId, target_id: targetId, verifier_source_ids: [verifier],
    },
    evidence: [
      { source_id: sourceId, source: `sources/${sourceId}.md`, text: sourceId },
      { source_id: targetId, source: `sources/${targetId}.md`, text: targetId },
      { source_id: verifier, source: `sources/${verifier}.md`, text: verifier },
    ],
  });
  const results = composeDecisionPacketResults(
    [anchor(1, "a"), anchor(2, "b"), anchor(3, "c")],
    [
      packet("a-active", "dominates", "a-new", "a", "a-ledger"),
      packet("a-draft", "non_effective", "a-draft", "a", "a-ledger"),
      packet("b", "dominates", "b-new", "b", "b-ledger"),
      packet("c", "unresolved", "c", "c-peer", "c-ledger"),
    ],
    3,
    { anchorK: 3, packetBudget: 3 },
  );

  assert.deepEqual(results.map((item) => item.source), [
    "packet:a-active", "packet:b", "packet:c",
  ]);
});
