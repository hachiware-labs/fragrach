import fs from "node:fs";
import path from "node:path";

function readJsonl(filePath) {
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function loadDynamicValidityPack(corpusRoot) {
  return {
    manifest: JSON.parse(fs.readFileSync(path.join(corpusRoot, "manifest.json"), "utf8")),
    profiles: readJsonl(path.join(corpusRoot, "gold/profiles.jsonl")),
    relations: readJsonl(path.join(corpusRoot, "gold/relations.jsonl")),
    questions: readJsonl(path.join(corpusRoot, "evaluation/questions.jsonl")),
  };
}

export function normalizeSource(value) {
  return String(value ?? "").replaceAll("\\", "/").replace(/^\.\//, "");
}

function normalizeValue(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/^(\d+)台に1台/, "$1台ごとに1台")
    .replace(/^(\d+)人/, "$1名");
}

function answerValueMatches(answer, candidate) {
  const expected = normalizeValue(candidate);
  return answer === expected || answer.startsWith(expected);
}

function mean(values) {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function inTime(profile, asOf) {
  const from = profile.time?.valid_from;
  const to = profile.time?.valid_to;
  return (!from || from <= asOf) && (!to || asOf <= to);
}

function inScope(profile, queryScope = {}) {
  for (const [dimension, allowed] of Object.entries(profile.scope ?? {})) {
    const requested = queryScope[dimension];
    if (requested === undefined || requested === null) return false;
    const requestedValues = Array.isArray(requested) ? requested : [requested];
    const allowedValues = Array.isArray(allowed) ? allowed : [allowed];
    if (!requestedValues.some((value) => allowedValues.includes(value))) return false;
  }
  return true;
}

function processValid(profile) {
  const invalid = new Set(["draft", "proposal", "rejected", "withdrawn", "discussion"]);
  return profile.approved === true && !invalid.has(profile.status);
}

function authorityValid(profile) {
  const authoritativeRole = profile.role === "normative" || profile.role === "record";
  return profile.official_record === true && Number(profile.authority_rank ?? 0) >= 7 && authoritativeRole;
}

function adoptedEvidence(output) {
  return (output?.evidence ?? [])
    .filter((item) => item.use === "governing" || item.use === "conflict")
    .map((item) => ({ ...item, source: normalizeSource(item.source) }));
}

function governingSources(output) {
  return new Set((output?.evidence ?? [])
    .filter((item) => item.use === "governing")
    .map((item) => normalizeSource(item.source)));
}

function citedSources(output) {
  return new Set((output?.evidence ?? []).map((item) => normalizeSource(item.source)));
}

function answerCorrect(gold, output) {
  if (!output || output.decision !== gold.expected_decision) return false;
  const answer = normalizeValue(output.answer_value ?? output.answer ?? "");
  const accepted = gold.answer_values.some((value) => answerValueMatches(answer, value));
  const forbidden = gold.forbidden_answer_values.some((value) => answerValueMatches(answer, value));
  return accepted && !forbidden;
}

function requiredEvidenceComplete(gold, sources) {
  return gold.required_evidence_sets.some((required) =>
    required.every((source) => sources.has(normalizeSource(source))),
  );
}

function forbiddenEvidenceAbsent(gold, sources) {
  return gold.forbidden_governing_evidence.every((source) => !sources.has(normalizeSource(source)));
}

export function scoreDvaaCase(question, stage, output, profileRows) {
  const gold = question.stages[stage];
  if (!gold) throw new Error(`${question.id}に${stage}のGoldがありません`);
  const profileBySource = new Map(profileRows.map((profile) => [normalizeSource(profile.source), profile]));
  const adopted = adoptedEvidence(output);
  const profiles = adopted.map((item) => profileBySource.get(item.source));
  const evidencePresent = adopted.length > 0 && profiles.every(Boolean);
  const cAns = answerCorrect(gold, output);
  const cT = evidencePresent && profiles.every((profile) => inTime(profile, gold.as_of));
  const cTS = cT && profiles.every((profile) => inScope(profile, question.scope));
  const cTSPA = cTS && profiles.every((profile) => processValid(profile) && authorityValid(profile));
  const governing = governingSources(output);
  const allCited = citedSources(output);
  const decisionEvidenceValid = gold.expected_decision === "unresolved"
    ? governing.size === 0 && requiredEvidenceComplete(gold, allCited)
    : governing.size > 0 && requiredEvidenceComplete(gold, allCited);
  const cFull = cTSPA && decisionEvidenceValid && forbiddenEvidenceAbsent(gold, governing);
  return {
    question_id: question.id,
    stage,
    split: question.split,
    category: question.category,
    answer_correct: cAns,
    evidence_t: cT,
    evidence_ts: cTS,
    evidence_tspa: cTSPA,
    evidence_full: cFull,
    dvaa_t: cAns && cT,
    dvaa_ts: cAns && cTS,
    dvaa_tspa: cAns && cTSPA,
    dvaa_full: cAns && cFull,
  };
}

function retrievedSources(retrieved, topK) {
  return new Set((retrieved ?? []).slice(0, topK).flatMap((item) => {
    const sources = item.sources ?? item.citation_sources;
    if (Array.isArray(sources) && sources.length > 0) return sources.map(normalizeSource);
    return [normalizeSource(item.source ?? item.document?.source)];
  }));
}

export function recallAtK(question, stage, retrieved, topK = 5) {
  const required = question.stages[stage].retrieval_gold.map(normalizeSource);
  if (required.length === 0) return 1;
  const actual = retrievedSources(retrieved, topK);
  return required.filter((source) => actual.has(source)).length / required.length;
}

export function completeEvidenceAtK(question, stage, retrieved, topK = 5) {
  const gold = question.stages[stage];
  if (!gold) throw new Error(`${question.id}に${stage}のGoldがありません`);
  return requiredEvidenceComplete(gold, retrievedSources(retrieved, topK));
}

function breakdown(details, field) {
  const groups = new Map();
  for (const detail of details) {
    if (!groups.has(detail[field])) groups.set(detail[field], []);
    groups.get(detail[field]).push(detail);
  }
  return Object.fromEntries([...groups.entries()].map(([key, rows]) => [key, {
    questions: rows.length,
    recall_at_k: mean(rows.map((row) => row.recall_at_k)),
    answer_accuracy: mean(rows.map((row) => Number(row.answer_correct))),
    dvaa_full: mean(rows.map((row) => Number(row.dvaa_full))),
  }]));
}

export function scoreDvaaRun({ questions, stage, outputs, retrieval, profiles, topK = 5, split = null }) {
  const selected = split ? questions.filter((question) => question.split === split) : questions;
  const outputById = new Map(outputs.map((output) => [output.question_id, output]));
  const details = selected.map((question) => {
    const score = scoreDvaaCase(question, stage, outputById.get(question.id), profiles);
    const completeEvidence = completeEvidenceAtK(
      question, stage, retrieval.get(question.id), topK,
    );
    return {
      ...score,
      recall_at_k: recallAtK(question, stage, retrieval.get(question.id), topK),
      complete_evidence_at_k: completeEvidence,
      dvaa_full: score.dvaa_full && completeEvidence,
      dvaa_gross: score.dvaa_full && completeEvidence,
    };
  });
  const answerAccuracy = mean(details.map((row) => Number(row.answer_correct)));
  const ceilingCount = details.filter((row) => row.complete_evidence_at_k).length;
  const grossCount = details.filter((row) => row.dvaa_gross).length;
  const dvaaGross = grossCount / details.length;
  const evidenceCeiling = ceilingCount / details.length;
  const dvaaNet = ceilingCount === 0 ? null : grossCount / ceilingCount;
  return {
    stage,
    split: split ?? "all",
    top_k: topK,
    questions: details.length,
    metrics: {
      recall_at_k: mean(details.map((row) => row.recall_at_k)),
      answer_accuracy: answerAccuracy,
      dvaa_t: mean(details.map((row) => Number(row.dvaa_t))),
      dvaa_ts: mean(details.map((row) => Number(row.dvaa_ts))),
      dvaa_tspa: mean(details.map((row) => Number(row.dvaa_tspa))),
      evidence_ceiling: evidenceCeiling,
      dvaa_net: dvaaNet,
      dvaa_gross: dvaaGross,
      dvaa_full: dvaaGross,
      validity_gap: answerAccuracy - dvaaGross,
    },
    by_category: breakdown(details, "category"),
    details,
  };
}
