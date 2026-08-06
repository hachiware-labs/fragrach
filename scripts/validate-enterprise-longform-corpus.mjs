import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildCorpusModel } from "./generate-enterprise-diverse-corpus.mjs";
import { buildOutline, corpusRoot, DEFAULT_DOMAINS } from "./generate-enterprise-longform-corpus.mjs";

const readJsonl = (file) => fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const count = (text, needle) => text.split(needle).length - 1;

export function validateLongformCorpus(options = {}) {
  const domains = new Set(options.domains ?? DEFAULT_DOMAINS);
  const full = buildCorpusModel();
  const documents = full.documents.filter((doc) => domains.has(`${doc.industry}-${doc.department}`));
  const expectedLong = documents.filter((doc) => {
    if (doc.purpose === "governance") return doc.type === "policy" && doc.relativePath.endsWith("pol-v2.md");
    if (doc.purpose === "technical_spec") return doc.type === "technical_specification";
    if (doc.purpose === "planning") return doc.type === "decision_minutes";
    if (doc.purpose === "operations") return doc.type === "operating_procedure";
    if (doc.purpose === "incident_change") return doc.type === "incident_report" && doc.relativePath.endsWith("final.md");
    if (doc.purpose === "commercial_compliance") return doc.type === "master_agreement";
    return false;
  });
  const longIds = new Set(expectedLong.map((doc) => doc.id));
  const errors = [];
  const rows = [];
  for (const doc of documents) {
    const file = path.join(corpusRoot, "sources", ...doc.relativePath.split("/"));
    if (!fs.existsSync(file)) {
      errors.push(`missing document: ${doc.relativePath}`);
      continue;
    }
    const text = fs.readFileSync(file, "utf8");
    const isLong = longIds.has(doc.id);
    rows.push({ id: doc.id, purpose: doc.purpose, is_long: isLong, chars: text.length });
    if (text.includes("undefined")) errors.push(`undefined text: ${doc.id}`);
    for (const section of doc.sections) {
      if (count(text, section.anchor) !== 1) errors.push(`gold anchor count is not one: ${doc.id}#${section.heading}`);
    }
    if (isLong) {
      const outline = buildOutline(doc);
      const outlineFile = path.join(corpusRoot, "generation", "outlines", `${doc.id}.json`);
      if (!fs.existsSync(outlineFile)) errors.push(`missing outline: ${doc.id}`);
      if (!text.includes(`outline_id: ${JSON.stringify(outline.outline_id)}`)) errors.push(`outline mismatch: ${doc.id}`);
      if (!text.includes(`generation_contract: "realistic-v4-structured-numeric-gate"`)) errors.push(`generation contract mismatch: ${doc.id}`);
      if (text.length < 3000) errors.push(`long document too short: ${doc.id}/${text.length}`);
      const headings = outline.sections.map((item) => `## ${item.heading}`);
      for (const heading of headings) if (!text.includes(heading)) errors.push(`missing outline heading: ${doc.id}/${heading}`);
      const anchorOffsets = doc.sections.map((section) => text.indexOf(section.anchor));
      if (!(anchorOffsets[0] < anchorOffsets[1] && anchorOffsets[1] < anchorOffsets[2])) errors.push(`anchor order changed: ${doc.id}`);
      if (anchorOffsets[0] < text.length * 0.05 || anchorOffsets[2] > text.length * 0.97) errors.push(`anchors not distributed inside document: ${doc.id}`);
    }
  }

  const requiredFiles = [
    path.join(corpusRoot, "manifest.json"),
    path.join(corpusRoot, "world", "documents.jsonl"),
    path.join(corpusRoot, "gold", "profiles.jsonl"),
    path.join(corpusRoot, "gold", "relations.jsonl"),
    path.join(corpusRoot, "gold", "answers.jsonl"),
    path.join(corpusRoot, "evaluation", "questions.jsonl"),
    path.join(corpusRoot, "evaluation", "rag-domains.jsonl"),
  ];
  for (const file of requiredFiles) if (!fs.existsSync(file)) errors.push(`missing metadata: ${path.relative(corpusRoot, file)}`);
  const questionsFile = path.join(corpusRoot, "evaluation", "questions.jsonl");
  const questions = fs.existsSync(questionsFile)
    ? readJsonl(questionsFile).filter((question) => domains.has(`${question.industry}-${question.department}`))
    : [];
  const profilesFile = path.join(corpusRoot, "gold", "profiles.jsonl");
  const documentIds = new Set(documents.map((doc) => doc.id));
  const profiles = fs.existsSync(profilesFile)
    ? readJsonl(profilesFile).filter((profile) => documentIds.has(profile.source_id))
    : [];
  if (profiles.length !== documents.length) errors.push(`profile count: ${profiles.length}/${documents.length}`);
  const sourcePaths = new Set(documents.map((doc) => `sources/${doc.relativePath}`));
  for (const question of questions) {
    for (const evidence of question.required_evidence ?? []) {
      if (!sourcePaths.has(evidence.source)) errors.push(`unknown Gold source: ${question.id}/${evidence.source}`);
    }
  }
  const values = rows.map((item) => item.chars).sort((a, b) => a - b);
  const percentile = (ratio) => values[Math.min(values.length - 1, Math.floor(values.length * ratio))] ?? 0;
  const report = {
    valid: errors.length === 0,
    error_count: errors.length,
    errors: errors.slice(0, 100),
    domains: [...domains],
    documents: rows.length,
    long_documents: rows.filter((item) => item.is_long).length,
    short_documents: rows.filter((item) => !item.is_long).length,
    questions: questions.length,
    profiles: profiles.length,
    min_chars: values[0] ?? 0,
    average_chars: values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0,
    p50_chars: percentile(0.5),
    p90_chars: percentile(0.9),
    max_chars: values.at(-1) ?? 0,
    by_purpose: Object.fromEntries([...new Set(rows.map((item) => item.purpose))].sort().map((purpose) => {
      const selected = rows.filter((item) => item.purpose === purpose);
      return [purpose, {
        documents: selected.length,
        long_documents: selected.filter((item) => item.is_long).length,
        average_chars: Math.round(selected.reduce((sum, item) => sum + item.chars, 0) / selected.length),
      }];
    })),
  };
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const domainIndex = process.argv.indexOf("--domains");
  const domains = domainIndex >= 0 ? process.argv[domainIndex + 1].split(",").filter(Boolean) : undefined;
  const outputIndex = process.argv.indexOf("--output");
  const report = validateLongformCorpus({ domains });
  const reportFile = outputIndex >= 0
    ? path.resolve(process.argv[outputIndex + 1])
    : path.join(
      corpusRoot,
      "generation",
      domains ? `validation-report-${domains.join("-")}.json` : "validation-report.json",
    );
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(reportFile, `${JSON.stringify({ ...report, validated_at: new Date().toISOString() }, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
  if (!report.valid) process.exitCode = 1;
}
