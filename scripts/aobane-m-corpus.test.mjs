import assert from "node:assert/strict";
import test from "node:test";
import { buildBlueprints, buildQuestions } from "./generate-aobane-m-corpus.mjs";

test("M corpus blueprint adds 400 documents with 30 duplicates",()=>{
  const items=buildBlueprints();
  assert.equal(items.length,400);
  assert.equal(items.filter(x=>x.duplicateOf).length,30);
  assert.equal(new Set(items.map(x=>x.relativePath)).size,400);
});

test("M corpus blueprint adds 84 structured questions",()=>{
  const items=buildQuestions();
  assert.equal(items.length,84);
  assert.equal(new Set(items.map(x=>x.id)).size,84);
  assert(items.every(x=>x.required_evidence.length>0));
  assert(items.every(x=>x.forbidden_answer_elements.length>0));
  assert(
    items
      .filter((item)=>item.id.startsWith("M-PL-"))
      .every((item)=>item.intent_id==="compliance-audit"),
  );
});
