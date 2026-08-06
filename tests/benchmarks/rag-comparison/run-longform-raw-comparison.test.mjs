import assert from "node:assert/strict";
import test from "node:test";

import {
  diagnostics,
  evidenceTargets,
  scoreRowsByDomain,
  truncateForBudget,
} from "./run-longform-raw-comparison.mjs";

test("long-form diagnostics measure exact section position and evidence density", () => {
  const questions = [{ id: "q1", required_evidence: [
    { source: "sources/a.md", section: "後半" },
    { source: "sources/b.md", section: "前半" },
  ] }];
  const chunks = [
    { source: "sources/a.md", section: "後半", relative_position: 0.9 },
    { source: "sources/b.md", section: "前半", relative_position: 0.1 },
  ];
  const rows = [{
    condition: "example",
    question_id: "q1",
    retrieved_units: [{
      section: "後半",
      token_count: 500,
      evidence: [{ source: "sources/a.md" }],
    }],
  }];
  const result = diagnostics(rows, evidenceTargets(questions, chunks), [5]);
  assert.equal(result.example["5"].evidence_hits_per_1000_tokens, 2);
  assert.equal(result.example["5"].gold_position_recall.start, 0);
  assert.equal(result.example["5"].gold_position_recall.end, 1);
});

test("token budget retains the first oversized unit and stops before later overflow", () => {
  const rows = [{ condition: "example", question_id: "q1", retrieved_units: [
    { token_count: 1200 },
    { token_count: 100 },
  ] }];
  const [truncated] = truncateForBudget(rows, 1000);
  assert.equal(truncated.retrieved_units.length, 1);
  assert.equal(truncated.context_tokens, 1200);
});

test("long-form scores remain separated by department RAG domain", () => {
  const questions = [
    {
      id: "q-a",
      industry: "manufacturing",
      department: "design",
      intent_id: "governance",
      tags: [],
      required_evidence: [{ source: "sources/manufacturing/design/governance/a.md", section: "規則" }],
    },
    {
      id: "q-b",
      industry: "healthcare",
      department: "quality",
      intent_id: "governance",
      tags: [],
      required_evidence: [{ source: "sources/healthcare/quality/governance/b.md", section: "規則" }],
    },
  ];
  const rows = [
    {
      condition: "dense",
      question_id: "q-a",
      retrieved_units: [{ id: "a", evidence: [{ source: "sources/manufacturing/design/governance/a.md", section: "規則" }] }],
    },
    { condition: "dense", question_id: "q-b", retrieved_units: [] },
  ];
  const domains = ["manufacturing-design", "healthcare-quality"];

  const result = scoreRowsByDomain({ rows, questions, domains, profiles: [], relations: [] });

  assert.equal(result["manufacturing-design"].dense.recall_at_k["5"], 1);
  assert.equal(result["healthcare-quality"].dense.recall_at_k["5"], 0);
});
