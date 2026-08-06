import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyVersionQuestion,
  diffAnswerFocus,
  extractImportForms,
  familyFromQuestion,
  requestedVersion,
  subjectTerms,
} from "./versionqa-query-packets.mjs";

test("質問文だけから版一覧・変更・本文を分類する", () => {
  assert.equal(classifyVersionQuestion("How many Node.js versions are you aware of?"), "inventory");
  assert.equal(classifyVersionQuestion("When was ERR_X added to Node.js?"), "change");
  assert.equal(classifyVersionQuestion("What change was made to badges in Bootstrap v5.3.3?"), "content");
});

test("要求版の原文からESMとCommonJSのimport形を重複なく抽出する", () => {
  assert.deepEqual(extractImportForms(`
import assert from 'node:assert';
const assert = require('node:assert');
const strict = require('node:assert/strict');
const assert = require('node:assert');
  `), [
    "import assert from 'node:assert';",
    "const assert = require('node:assert');",
    "const strict = require('node:assert/strict');",
  ]);
});

test("製品名と対象語から文書familyを決める", () => {
  assert.equal(familyFromQuestion("What Apache Spark versions are available?"), "spark-release");
  assert.equal(familyFromQuestion("What is ERR_ACCESS_DENIED in Node.js?"), "nodejs-errors");
  assert.equal(familyFromQuestion("How is assert imported in Node.js?"), "nodejs-assert");
});

test("要求版と差分subjectをGoldなしで抽出する", () => {
  assert.equal(requestedVersion("What changed in Node.js version 17.9.1?"), "17.9.1");
  assert.deepEqual(subjectTerms("When was ERR_ACCESS_DENIED added?"), ["ERR_ACCESS_DENIED"]);
  assert.deepEqual(subjectTerms("Were WeakMap and WeakSet examples changed?"), ["WeakMap", "WeakSet"]);
});

test("例の変更質問ではsnapshotとAPI履歴の時間軸を分離する", () => {
  const focus = diffAnswerFocus("Were examples about partialDeepStrictEqual changed in any version?");
  assert.match(focus, /Before and After document snapshots/);
  assert.match(focus, /Do not report embedded API-history/);
  assert.equal(diffAnswerFocus("When was ERR_X added?"), null);
});
