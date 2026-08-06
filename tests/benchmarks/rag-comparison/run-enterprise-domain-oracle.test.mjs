import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { evaluateEnterpriseOracle } from "./run-enterprise-domain-oracle.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../corpora/fragrach-enterprise-ja-diverse");

test("enterprise oracle evaluator keeps Raw, Profile, and Dossier conditions distinct", () => {
  const result = evaluateEnterpriseOracle(root, new Set(["manufacturing-product-design"]));
  assert.equal(result.domains.length, 1);
  assert.equal(result.domains[0].questions, 36);
  assert.deepEqual(Object.keys(result.aggregate), [
    "raw_current",
    "raw_tuned",
    "raw_tuned_purpose",
    "oracle_profile",
    "oracle_dossier",
  ]);
  assert.equal(result.retrievalRows.length, 36 * 5);
  assert.ok(result.aggregate.oracle_dossier.relation_path_recall_at_k["10"] >= result.aggregate.raw_tuned.relation_path_recall_at_k["10"]);
  assert.ok(result.retrievalRows.every((row) => row.metrics.relation_path_recall_at_k["10"] !== undefined));
});
