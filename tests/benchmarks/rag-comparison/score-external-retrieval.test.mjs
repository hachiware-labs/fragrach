import assert from "node:assert/strict";
import test from "node:test";

import { scoreExternalRows } from "./score-external-retrieval.mjs";

test("external retrieval uses the shared section and content-term matcher", () => {
  const questions = [{
    id: "Q-1",
    intent_id: "governance",
    tags: ["version"],
    required_relations: ["DOC-NEW supersedes DOC-OLD"],
    required_evidence: [
      { source: "sources/new.md", document_id: "DOC-NEW", section: "現行規則", content_terms: ["五年間"] },
      { source: "sources/old.md", document_id: "DOC-OLD", section: "承認規則", content_terms: ["二年間"] },
    ],
  }];
  const profiles = [
    { source_id: "DOC-NEW", relative_path: "sources/new.md", status: "current", force: { rank: 9 } },
    { source_id: "DOC-OLD", relative_path: "sources/old.md", status: "superseded", force: { rank: 9 } },
  ];
  const relations = [];
  const rows = [{
    condition: "external",
    question_id: "Q-1",
    elapsed_ms: 10,
    retrieved_units: [{
      id: "edge-1",
      retrieval_text: "五年間保存する。旧版では二年間保存する。",
      evidence: [
        { source: "sources/new.md", section: "現行規則", text: "五年間保存する" },
        { source: "sources/old.md", section: "承認規則", text: "二年間保存する" },
      ],
    }],
  }];
  const result = scoreExternalRows({ rows, questions, profiles, relations });
  assert.equal(result.conditions.external.recall_at_k["5"], 1);
  assert.equal(result.conditions.external.complete_at_k["5"], 1);
  assert.equal(result.conditions.external.precision_at_k["5"], 1);
  assert.equal(result.conditions.external.relation_path_recall_at_k["10"], 1);
});

test("a source match without the required section text is not counted", () => {
  const questions = [{
    id: "Q-2",
    intent_id: "governance",
    tags: [],
    required_relations: [],
    required_evidence: [
      { source: "sources/current.md", document_id: "DOC", section: "現行規則", content_terms: ["共同承認"] },
    ],
  }];
  const profiles = [{ source_id: "DOC", relative_path: "sources/current.md", status: "current", force: { rank: 9 } }];
  const rows = [{
    condition: "external",
    question_id: "Q-2",
    elapsed_ms: 10,
    retrieved_units: [{
      id: "edge-2",
      retrieval_text: "共同承認",
      evidence: [{ source: "sources/current.md", section: "目的", text: "共同承認" }],
    }],
  }];
  const result = scoreExternalRows({ rows, questions, profiles, relations: [] });
  assert.equal(result.conditions.external.recall_at_k["5"], 0);
});

test("rows outside the selected question subset are ignored", () => {
  const questions = [{
    id: "q-selected",
    required_evidence: [{ source: "sources/a.md", section: "規則", content_terms: ["共同承認"] }],
    required_relations: [],
    tags: [],
  }];
  const rows = [
    {
      condition: "example",
      question_id: "q-selected",
      retrieved_units: [{ id: "a", text: "共同承認", evidence: [{ source: "sources/a.md", section: "規則", text: "共同承認" }] }],
    },
    {
      condition: "example",
      question_id: "q-outside",
      retrieved_units: [],
    },
  ];
  const result = scoreExternalRows({ rows, questions, profiles: [], relations: [] });
  assert.equal(result.conditions.example.questions, 1);
  assert.equal(result.scoredRows.length, 1);
  assert.equal(result.scoredRows[0].question_id, "q-selected");
});
