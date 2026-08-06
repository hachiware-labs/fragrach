import test from "node:test";
import assert from "node:assert/strict";

import { answerCorrect } from "./multihop-answer-score.mjs";

test("短いGold回答を句読点や定型句に依存せず採点する", () => {
  assert.equal(answerCorrect("The answer is Sam Bankman-Fried.", "Sam Bankman-Fried"), true);
  assert.equal(answerCorrect("14 years", "4"), false);
  assert.equal(answerCorrect("4 years", "4"), true);
  assert.equal(answerCorrect("European Commission", "The European Commission."), true);
});
