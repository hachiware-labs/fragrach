import assert from "node:assert/strict";
import test from "node:test";
import { buildCorpusModel, buildDomains, EXPECTED, stableContextSeed } from "./generate-enterprise-diverse-corpus.mjs";

test("diverse corpus models 40 independent department RAG domains", () => {
  const domains = buildDomains();
  assert.equal(domains.length, EXPECTED.departments);
  assert.equal(new Set(domains.map((item) => item.id)).size, EXPECTED.departments);
  assert(domains.every((item) => item.scenarios.length === EXPECTED.scenarios_per_purpose));
  const counts = new Map();
  for (const domain of domains) counts.set(domain.industryId, (counts.get(domain.industryId) ?? 0) + 1);
  assert.deepEqual([...counts.values()], Array(EXPECTED.industries).fill(5));
});

test("diverse corpus has deterministic per-domain documents and Gold questions", () => {
  const model = buildCorpusModel();
  assert.equal(model.documents.length, EXPECTED.documents);
  assert.equal(model.questions.length, EXPECTED.questions);
  assert.equal(new Set(model.documents.map((item) => item.id)).size, EXPECTED.documents);
  assert.equal(new Set(model.documents.map((item) => item.relativePath)).size, EXPECTED.documents);
  assert.equal(new Set(model.questions.map((item) => item.id)).size, EXPECTED.questions);
  const documentIds = new Set(model.documents.map((item) => item.id));
  assert(model.relations.every((item) => documentIds.has(item.subject) && documentIds.has(item.object)));
  assert(model.questions.every((item) => item.required_evidence.length >= 1));
  assert(model.questions.every((item) => item.forbidden_answer_elements.length >= 1));

  for (const domain of buildDomains()) {
    const docs = model.documents.filter((item) => item.industry === domain.industryId && item.department === domain.departmentId);
    const questions = model.questions.filter((item) => item.industry === domain.industryId && item.department === domain.departmentId);
    assert.equal(docs.length, EXPECTED.documents_per_department, domain.id);
    assert.equal(questions.length, EXPECTED.questions_per_department, domain.id);
    for (const purpose of ["governance", "technical_spec", "planning", "operations", "incident_change", "commercial_compliance"]) {
      assert.equal(docs.filter((item) => item.purpose === purpose).length, 12, `${domain.id}/${purpose}`);
      assert.equal(questions.filter((item) => item.purpose === purpose).length, 6, `${domain.id}/${purpose}`);
    }
  }
});

test("non-primary departments receive department-specific scenario facts", () => {
  const model = buildCorpusModel();
  for (const [index, domain] of buildDomains().entries()) {
    if (index % 5 === 0) continue;
    const scenario = `${domain.id}-S1`;
    const documents = model.documents.filter((item) => item.scenario === scenario);
    const byPurpose = new Map(documents.map((item) => [item.purpose, `${item.title}\n${item.sections.map((section) => section.anchor).join("\n")}`]));
    assert(byPurpose.get("governance").includes(domain.focus), domain.id);
    assert(byPurpose.get("technical_spec").includes(domain.subject), domain.id);
    assert(byPurpose.get("planning").includes(domain.focus), domain.id);
    assert(byPurpose.get("operations").includes(domain.focus), domain.id);
    assert(byPurpose.get("incident_change").includes(domain.focus), domain.id);
    assert(byPurpose.get("commercial_compliance").includes(domain.focus), domain.id);
  }
});

test("Ollama seed depends on context identity rather than generation order", () => {
  const first = stableContextSeed(20260801, "finance-claims-S1::governance");
  assert.equal(first, stableContextSeed(20260801, "finance-claims-S1::governance"));
  assert.notEqual(first, stableContextSeed(20260801, "finance-claims-S1::technical_spec"));
  assert.notEqual(first, stableContextSeed(20260801, "finance-claims-S1::governance", 1));
});
