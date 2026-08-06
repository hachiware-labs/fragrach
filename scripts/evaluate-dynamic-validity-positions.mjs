#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArguments(argv) {
  const options = {
    corpus: path.join(repositoryRoot, "tests/corpora/aobane-industries-ja-dynamic-validity-scale"),
    builds: [],
    output: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--corpus") options.corpus = path.resolve(argv[++index]);
    else if (argument === "--build") options.builds.push(path.resolve(argv[++index]));
    else if (argument === "--output") options.output = path.resolve(argv[++index]);
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (options.builds.length === 0) throw new Error("at least one --build is required");
  return options;
}

function readJsonl(filePath) {
  const text = fs.readFileSync(filePath, "utf8").trim();
  return text ? text.split(/\r?\n/).map((line) => JSON.parse(line)) : [];
}

function readOptionalJsonl(filePath) {
  return fs.existsSync(filePath) ? readJsonl(filePath) : [];
}

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(target) : [target];
  });
}

function frontMatter(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  return Object.fromEntries(match[1].split(/\r?\n/).map((line) => {
    const separator = line.indexOf(":");
    if (separator < 0) return [line.trim(), ""];
    const key = line.slice(0, separator).trim();
    const raw = line.slice(separator + 1).trim();
    try { return [key, JSON.parse(raw)]; } catch { return [key, raw]; }
  }));
}

function identity(documentId, revision) {
  return `${documentId}@${revision ?? ""}`;
}

function positionKey(source, position, target) {
  return `${source}|${position}|${target}`;
}

function expectedPositions(corpus) {
  const sourcesRoot = path.join(corpus, "sources/70-dynamic");
  return walk(sourcesRoot).filter((filePath) => filePath.endsWith(".md")).flatMap((filePath) => {
    const metadata = frontMatter(filePath);
    if (!metadata.position) return [];
    return [{
      source_path: path.relative(corpus, filePath).replaceAll("\\", "/"),
      source: identity(metadata.document_id, metadata.revision),
      position: metadata.position,
      target: identity(metadata.position_target_document_id, metadata.position_target_revision),
      verifier: metadata.position_verified_by,
    }];
  });
}

function countBy(rows, key) {
  return Object.fromEntries([...new Set(rows.map((row) => row[key]))].sort().map((value) => [
    value,
    rows.filter((row) => row[key] === value).length,
  ]));
}

function fineRelationCovered(relation, sourceMetadata, actualBySource) {
  const source = sourceMetadata.get(relation.from);
  const target = sourceMetadata.get(relation.to);
  if (!source || !target) return false;
  const expectedPosition = {
    supersedes: "dominates",
    draft_of: "non_effective",
    amends: "conditional",
    exception_to: "conditional",
    expired_exception_to: "non_effective",
    rejected_change_to: "non_effective",
    research_for: "non_effective",
    conflicts_with: "unresolved",
    equal_authority: "unresolved",
  }[relation.type];
  if (!expectedPosition) return false;
  const candidates = actualBySource.get(identity(source.document_id, source.revision)) ?? [];
  return candidates.some((candidate) => candidate.position === expectedPosition
    && (relation.type === "research_for" || candidate.target === identity(target.document_id, target.revision)));
}

export function evaluatePositions({ corpus, builds }) {
  const expected = expectedPositions(corpus);
  const profiles = builds.flatMap((build) => readJsonl(path.join(build, "document-profiles.jsonl")));
  const relations = builds.flatMap((build) => readJsonl(path.join(build, "document-relations.jsonl")));
  const dossiers = builds.flatMap((build) => readOptionalJsonl(path.join(build, "relation-dossiers.jsonl")));
  const packets = builds.flatMap((build) => readOptionalJsonl(path.join(build, "decision-packets.jsonl")));
  const profileBySource = new Map(profiles.map((profile) => [profile.source_id, profile]));
  const dossierByRelation = new Map(dossiers.map((dossier) => [dossier.relation_id, dossier]));
  const packetByRelation = new Map(packets.flatMap((packet) =>
    (packet.purpose?.kind === "decision" ? packet.purpose.relation_ids ?? [] : [])
      .map((relationId) => [relationId, packet])));
  const actual = relations.map((relation) => {
    const source = profileBySource.get(relation.source_id);
    const target = profileBySource.get(relation.target_id);
    const evidenceDocuments = new Set(relation.evidence.map((reference) => profileBySource.get(reference.source_id)?.document_id).filter(Boolean));
    const dossier = dossierByRelation.get(relation.id);
    const packet = packetByRelation.get(relation.id);
    return {
      id: relation.id,
      source: identity(source?.document_id, source?.revision),
      position: relation.position,
      target: identity(target?.document_id, target?.revision),
      kind: relation.kind,
      evidence_documents: [...evidenceDocuments].sort(),
      decision_chunks: packet
        ? new Set((packet.materials ?? [])
          .filter((material) => (material.evidence_ids ?? []).length > 0)
          .map((material) => material.source_id)).size
        : (dossier?.text.match(/\/ 判断に用いる基準\]/g) ?? []).length,
    };
  });
  const actualByKey = new Map(actual.map((row) => [positionKey(row.source, row.position, row.target), row]));
  const expectedKeys = new Set(expected.map((row) => positionKey(row.source, row.position, row.target)));
  const missing = expected.filter((row) => !actualByKey.has(positionKey(row.source, row.position, row.target)));
  const unexpected = actual.filter((row) => !expectedKeys.has(positionKey(row.source, row.position, row.target)));
  const verifierComplete = expected.filter((row) => actualByKey.get(positionKey(row.source, row.position, row.target))?.evidence_documents.includes(row.verifier));
  const decisionChunkComplete = expected.filter((row) => actualByKey.get(positionKey(row.source, row.position, row.target))?.decision_chunks >= 3);

  const sourceMetadata = new Map(walk(path.join(corpus, "sources/70-dynamic")).filter((filePath) => filePath.endsWith(".md")).map((filePath) => [
    path.relative(corpus, filePath).replaceAll("\\", "/"),
    frontMatter(filePath),
  ]));
  const actualBySource = new Map();
  for (const row of actual) {
    if (!actualBySource.has(row.source)) actualBySource.set(row.source, []);
    actualBySource.get(row.source).push(row);
  }
  const fineRelations = readJsonl(path.join(corpus, "gold/relations.jsonl"));
  const coveredFineRelations = fineRelations.filter((relation) => fineRelationCovered(relation, sourceMetadata, actualBySource));

  return {
    schema_version: "1.0",
    expected_positions: expected.length,
    actual_positions: actual.length,
    expected_by_position: countBy(expected, "position"),
    actual_by_position: countBy(actual, "position"),
    operational_position_relations: actual.filter((row) => row.kind === "operational_position").length,
    missing_positions: missing,
    unexpected_positions: unexpected,
    verifier_evidence: { passed: verifierComplete.length, total: expected.length },
    three_decision_chunks: { passed: decisionChunkComplete.length, total: expected.length },
    fine_relation_coverage: { passed: coveredFineRelations.length, total: fineRelations.length },
  };
}

function reportMarkdown(report) {
  const rows = ["dominates", "conditional", "non_effective", "unresolved"].map((position) =>
    `| \`${position}\` | ${report.expected_by_position[position] ?? 0} | ${report.actual_by_position[position] ?? 0} |`,
  ).join("\n");
  return `# Dynamic Validity Position Gate\n\n| Position | 期待 | Actual |\n|---|---:|---:|\n${rows}\n\n- Position一致: ${report.expected_positions - report.missing_positions.length}/${report.expected_positions}\n- 予期しないPosition: ${report.unexpected_positions.length}\n- 確認台帳Evidence: ${report.verifier_evidence.passed}/${report.verifier_evidence.total}\n- Source・Target・台帳の判断chunk: ${report.three_decision_chunks.passed}/${report.three_decision_chunks.total}\n- 100 Gold Relationの四値写像coverage: ${report.fine_relation_coverage.passed}/${report.fine_relation_coverage.total}\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArguments(process.argv.slice(2));
  const report = evaluatePositions(options);
  if (options.output) {
    fs.mkdirSync(options.output, { recursive: true });
    fs.writeFileSync(path.join(options.output, "position-gate.json"), `${JSON.stringify(report, null, 2)}\n`);
    fs.writeFileSync(path.join(options.output, "POSITION_GATE_ja.md"), reportMarkdown(report));
  }
  console.log(JSON.stringify(report, null, 2));
}
