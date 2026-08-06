import path from "node:path";

import { buildRawChunks } from "./run-upper-bound.mjs";
import { normalizeSource } from "./dynamic-validity-score.mjs";

export function dynamicValiditySourceRoots(corpusRoot, manifest) {
  const configured = manifest.source_roots ?? ["."];
  return configured.map((root) => path.resolve(corpusRoot, root));
}

export function buildDynamicValidityChunks(corpusRoot, manifest, options = {}) {
  const declared = new Set(manifest.documents.map((document) => normalizeSource(document.source)));
  const chunksById = new Map();
  for (const sourceRoot of dynamicValiditySourceRoots(corpusRoot, manifest)) {
    for (const chunk of buildRawChunks(sourceRoot, options)) {
      const source = normalizeSource(chunk.source);
      if (!declared.has(source)) continue;
      const key = `${source}\u0000${chunk.section}\u0000${chunk.body ?? chunk.text}`;
      if (!chunksById.has(key)) chunksById.set(key, chunk);
    }
  }
  return [...chunksById.values()];
}
