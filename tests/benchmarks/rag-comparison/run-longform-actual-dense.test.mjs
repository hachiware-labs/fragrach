import assert from "node:assert/strict";
import test from "node:test";

import {
  compactRelationHeader,
  compiledSourceId,
  evidencePriority,
} from "./run-longform-actual-dense.mjs";

test("layered dossier keeps retrieval headers compact and removes duplicate evidence", () => {
  const header = compactRelationHeader({
    id: "actual:relation-dossier:governance/rel-1",
    relation: { kind: "conflicts_with", source_id: "faq", target_id: "policy" },
    evidence: [
      { source: "faq.md", section: "更新状況", text: "第2版を反映していない。" },
      { source: "faq.md", section: "更新状況", text: "第2版を反映していない。" },
      { source: "policy.md", section: "現行規則", text: "共同承認を得る。" },
    ],
    text: "巨大な回答用Dossier",
  });

  assert.match(header.text, /conflicts_with/);
  assert.match(header.text, /共同承認を得る/);
  assert.equal(header.text.match(/第2版を反映していない/g)?.length, 1);
  assert.doesNotMatch(header.text, /巨大な回答用Dossier/);
});

test("layered dossier prioritizes operative and stale-state evidence", () => {
  const current = { evidence: [{ section: "規程 / 現行規則", text: "共同承認を得る。" }] };
  const stale = { evidence: [{ section: "FAQ / 更新状況", text: "第2版を反映していない。" }] };
  const background = { evidence: [{ section: "規程 / 制定・改訂の背景", text: "背景説明" }] };

  assert.ok(evidencePriority(stale) > evidencePriority(current));
  assert.ok(evidencePriority(current) > evidencePriority(background));
});

test("compiled evidence id exposes its source endpoint", () => {
  assert.equal(
    compiledSourceId({ id: "actual:evidence:governance/src-policy/ev-1" }),
    "src-policy",
  );
  assert.equal(compiledSourceId({ id: "actual:relation-dossier:governance/rel-1" }), null);
});
