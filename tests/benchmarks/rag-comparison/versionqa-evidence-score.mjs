import fs from "node:fs";

export function normalizeEvidenceText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function includesAll(text, terms = []) {
  const normalized = normalizeEvidenceText(text);
  return terms.every((term) => normalized.includes(normalizeEvidenceText(term)));
}

function materialSources(material) {
  return new Set(material.citation_sources ?? material.sources ?? (material.source ? [material.source] : []));
}

function structuredUnits(material) {
  return Array.isArray(material.evidence_units) ? material.evidence_units : [];
}

function structuredUnitMatches(candidate, expected) {
  if (candidate.type !== expected.type) return false;
  if (expected.type === "document_absence") {
    return candidate.source === expected.source
      && includesAll(`${(candidate.subject_terms ?? []).join(" ")} ${candidate.evidence_text ?? ""}`, expected.subject_terms);
  }
  if (expected.type === "semantic_diff") {
    return candidate.before_source === expected.before_source
      && candidate.after_source === expected.after_source
      && candidate.change_kind === expected.change_kind
      && includesAll(`${(candidate.subject_terms ?? []).join(" ")} ${candidate.evidence_text ?? ""}`, expected.subject_terms);
  }
  if (expected.type === "version_inventory") {
    return candidate.family === expected.family
      && expected.versions.every((version) => (candidate.versions ?? []).includes(version));
  }
  if (expected.type === "source_span") {
    return candidate.source === expected.source
      && includesAll((candidate.required_terms ?? []).join(" "), expected.required_terms);
  }
  return false;
}

export function resolveEvidenceContract(question, annotation) {
  if (question.gold_evidence?.mode === "version_inventory") {
    return {
      status: "verified",
      units: [{
        type: "version_inventory",
        family: question.gold_evidence.family,
        versions: question.gold_evidence.versions,
        sources: question.gold_evidence.sources,
      }],
    };
  }
  if (!annotation) throw new Error(`missing evidence-unit annotation for ${question.id}`);
  if (annotation.status === "disputed") return annotation;
  const sources = question.gold_evidence?.sources ?? [];
  return {
    status: "verified",
    units: annotation.units.map((unit) => {
      if (unit.type === "source_span" || unit.type === "document_absence") {
        return { ...unit, source: sources[unit.source_index] };
      }
      if (unit.type === "semantic_diff") {
        return {
          ...unit,
          before_source: sources[unit.before_source_index],
          after_source: sources[unit.after_source_index],
        };
      }
      return unit;
    }),
  };
}

function sourceText(materials, source) {
  return materials
    .filter((material) => materialSources(material).has(source))
    .map((material) => material.text ?? "")
    .join("\n");
}

export function evidenceUnitSatisfied(unit, materials) {
  if (materials.some((material) => structuredUnits(material)
    .some((candidate) => structuredUnitMatches(candidate, unit)))) return true;

  if (unit.type === "source_span") {
    return includesAll(sourceText(materials, unit.source), unit.required_terms);
  }
  if (unit.type === "version_inventory") {
    return materials.some((material) => {
      const sources = materialSources(material);
      return unit.sources.every((source) => sources.has(source))
        && includesAll(material.text, unit.versions);
    });
  }
  // Absence and semantic change cannot be proven by merely naming a document.
  // They require an explicit compiler-produced Evidence Unit.
  return false;
}

export function scoreEvidenceContract(contract, materials) {
  if (contract.status === "disputed") {
    return {
      scorable: false,
      complete: false,
      recall: null,
      satisfied_units: 0,
      total_units: 0,
      reason: contract.reason,
    };
  }
  const results = contract.units.map((unit) => evidenceUnitSatisfied(unit, materials));
  const satisfied = results.filter(Boolean).length;
  return {
    scorable: true,
    complete: satisfied === results.length,
    recall: results.length === 0 ? 1 : satisfied / results.length,
    satisfied_units: satisfied,
    total_units: results.length,
    unit_results: results,
  };
}

export function loadEvidenceAnnotations(file) {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  if (parsed.schema_version !== "1.0" || !parsed.contracts) {
    throw new Error(`unsupported VersionQA evidence annotation schema: ${file}`);
  }
  return parsed.contracts;
}
