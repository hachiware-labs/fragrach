import test from "node:test";
import assert from "node:assert/strict";
import {
  evidenceUnitSatisfied,
  resolveEvidenceContract,
  scoreEvidenceContract,
} from "./versionqa-evidence-score.mjs";

test("文書IDだけでは本文spanのEvidence Unitを満たさない", () => {
  const unit = {
    type: "source_span",
    source: "sources/a/2.md",
    required_terms: ["target clause", "approved"],
  };
  const materials = [{ sources: ["sources/a/2.md"], text: "Version 2" }];
  assert.equal(evidenceUnitSatisfied(unit, materials), false);
});

test("同じsourceを引用する複数chunkに必要語が揃えば本文spanを満たす", () => {
  const unit = {
    type: "source_span",
    source: "sources/a/2.md",
    required_terms: ["target clause", "approved"],
  };
  const materials = [
    { sources: ["sources/a/2.md"], text: "Target clause" },
    { sources: ["sources/a/2.md"], text: "Status: approved" },
  ];
  assert.equal(evidenceUnitSatisfied(unit, materials), true);
});

test("文書が存在するだけでは不在証明にならない", () => {
  const unit = {
    type: "document_absence",
    source: "sources/a/1.md",
    subject_terms: ["removed method"],
  };
  assert.equal(evidenceUnitSatisfied(unit, [{ sources: ["sources/a/1.md"], text: "full document" }]), false);
  assert.equal(evidenceUnitSatisfied(unit, [{
    sources: ["sources/a/1.md"],
    text: "The method is absent.",
    evidence_units: [{ type: "document_absence", source: "sources/a/1.md", subject_terms: ["removed method"] }],
  }]), true);
});

test("版の両文書IDだけではsemantic diffにならない", () => {
  const unit = {
    type: "semantic_diff",
    before_source: "sources/a/1.md",
    after_source: "sources/a/2.md",
    change_kind: "added",
    subject_terms: ["new method"],
  };
  const pair = [{ sources: ["sources/a/1.md", "sources/a/2.md"], text: "1 dominates 2" }];
  assert.equal(evidenceUnitSatisfied(unit, pair), false);
  pair[0].evidence_units = [{
    type: "semantic_diff",
    before_source: "sources/a/1.md",
    after_source: "sources/a/2.md",
    change_kind: "added",
    subject_terms: ["new method"],
  }];
  assert.equal(evidenceUnitSatisfied(unit, pair), true);
});

test("Inventoryは全版を一つの資料で明示した場合だけ成立する", () => {
  const question = {
    id: "Q",
    gold_evidence: {
      mode: "version_inventory",
      family: "a",
      versions: ["1", "2", "3"],
      sources: ["a/1", "a/2", "a/3"],
    },
  };
  const contract = resolveEvidenceContract(question);
  assert.equal(scoreEvidenceContract(contract, [
    { sources: ["a/1"], text: "Version 1" },
    { sources: ["a/2"], text: "Version 2" },
  ]).complete, false);
  assert.equal(scoreEvidenceContract(contract, [{
    sources: ["a/1", "a/2", "a/3"],
    text: "Available versions: 1, 2, 3",
  }]).complete, true);
});

test("原文で支持できないGoldはDVAAの分母から隔離する", () => {
  const result = scoreEvidenceContract({ status: "disputed", reason: "unsupported" }, []);
  assert.equal(result.scorable, false);
  assert.equal(result.recall, null);
});
