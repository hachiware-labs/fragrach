import assert from "node:assert/strict";
import test from "node:test";

import { mergeRows } from "../src/scripts/merge_r0_answer_shards.mjs";

test("merge requires the exact unique pipeline question count", () => {
  const rows = mergeRows(
    [
      [
        { question_id: "q1", legacy_split: "development" },
        { question_id: "q2", legacy_split: "diagnostic" },
      ],
    ],
    2,
  );
  assert.equal(rows.length, 2);
});

test("merge rejects duplicate IDs", () => {
  assert.throws(
    () =>
      mergeRows(
        [
          [{ question_id: "q1", legacy_split: "development" }],
          [{ question_id: "q1", legacy_split: "diagnostic" }],
        ],
        2,
      ),
    /duplicate question IDs/,
  );
});

test("merge rejects reserve rows", () => {
  assert.throws(
    () => mergeRows([[{ question_id: "q1", legacy_split: "reserve" }]], 1),
    /reserve answer/,
  );
});
