import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveChunkSourceId,
  sourceIdentity,
} from "./run-dynamic-validity-metadata-slide-pilot.mjs";

test("chunkはパスより文書IDと版を優先してcompiled sourceへ接続する", () => {
  const units = [{
    evidence: [{
      source_id: "src_compiled",
      source: "sources/original/location.md",
    }],
  }];
  const profiles = [{
    source_id: "src_compiled",
    document_id: "STD-001",
    revision: "2",
  }];
  const identity = sourceIdentity(units, profiles);

  assert.equal(resolveChunkSourceId({
    source: "sources/moved/location.md",
    document_id: "STD-001",
    revision: "2",
  }, identity), "src_compiled");
});

test("既知のsource_idがchunkにあれば直接接続し、未知IDはパスへfallbackする", () => {
  const units = [{
    evidence: [{ source_id: "src_known", source: "sources/a.md" }],
  }];
  const identity = sourceIdentity(units);

  assert.equal(resolveChunkSourceId({
    source_id: "src_known",
    source: "sources/moved.md",
  }, identity), "src_known");
  assert.equal(resolveChunkSourceId({
    source_id: "src_stale",
    source: "sources/a.md",
  }, identity), "src_known");
});
