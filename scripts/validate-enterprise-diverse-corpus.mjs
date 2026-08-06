import fs from "node:fs";
import path from "node:path";
import { buildCorpusModel, buildDomains, corpusRoot, EXPECTED } from "./generate-enterprise-diverse-corpus.mjs";

const readJsonl = (file) => fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));

export function validateGeneratedCorpus(options = {}) {
  const model = buildCorpusModel();
  const selectedDomains = options.domains?.length ? new Set(options.domains) : null;
  const selectedDocuments = selectedDomains
    ? model.documents.filter((doc) => selectedDomains.has(`${doc.industry}-${doc.department}`))
    : model.documents;
  const errors = [];
  const allowedFactsByContext = new Map();
  for (const doc of model.documents) {
    const key = `${doc.scenario}\u0000${doc.purpose}`;
    const text = [doc.title, ...doc.sections.map((item) => item.anchor)].join("\n");
    allowedFactsByContext.set(key, `${allowedFactsByContext.get(key) ?? ""}\n${text}`);
  }
  let characters = 0;
  for (const doc of selectedDocuments) {
    const file = path.join(corpusRoot, "sources", ...doc.relativePath.split("/"));
    if (!fs.existsSync(file)) {
      errors.push(`missing document: ${doc.relativePath}`);
      continue;
    }
    const text = fs.readFileSync(file, "utf8");
    characters += text.length;
    if (text.includes("undefined")) errors.push(`undefined metadata or text: ${doc.id}`);
    for (const item of doc.sections) {
      if (!text.includes(`## ${item.heading}`)) errors.push(`missing section: ${doc.id}#${item.heading}`);
      if (!text.includes(item.anchor)) errors.push(`missing anchor: ${doc.id}#${item.heading}`);
    }
    const first = doc.sections[0];
    const contextStart = text.indexOf(`## ${first.heading}\n\n`) + `## ${first.heading}\n\n`.length;
    const anchorStart = text.indexOf(`\n\n${first.anchor}`, contextStart);
    if (contextStart >= 0 && anchorStart >= contextStart) {
      const generatedContext = text.slice(contextStart, anchorStart);
      const allowedFacts = allowedFactsByContext.get(`${doc.scenario}\u0000${doc.purpose}`) ?? "";
      const factualTokens = new Set([
        ...(generatedContext.match(/\d+(?:[.,]\d+)*/g) ?? []),
        ...(generatedContext.match(/[A-Z]{2,}-(?:[A-Z0-9]+-?)+/g) ?? []),
      ]);
      for (const token of factualTokens) {
        if (!allowedFacts.includes(token)) errors.push(`ungrounded factual token ${token}: ${doc.id}`);
      }
    }
  }

  const questionsFile = path.join(corpusRoot, "evaluation", "questions.jsonl");
  const domainsFile = path.join(corpusRoot, "evaluation", "rag-domains.jsonl");
  const profilesFile = path.join(corpusRoot, "gold", "profiles.jsonl");
  const relationsFile = path.join(corpusRoot, "gold", "relations.jsonl");
  for (const file of [questionsFile, domainsFile, profilesFile, relationsFile]) {
    if (!fs.existsSync(file)) errors.push(`missing metadata: ${path.relative(corpusRoot, file)}`);
  }
  const questions = fs.existsSync(questionsFile) ? readJsonl(questionsFile) : [];
  const domains = fs.existsSync(domainsFile) ? readJsonl(domainsFile) : [];
  const profiles = fs.existsSync(profilesFile) ? readJsonl(profilesFile) : [];
  const relations = fs.existsSync(relationsFile) ? readJsonl(relationsFile) : [];
  if (questions.length !== EXPECTED.questions) errors.push(`question count: ${questions.length}`);
  if (domains.length !== EXPECTED.departments) errors.push(`domain count: ${domains.length}`);
  if (profiles.length !== EXPECTED.documents) errors.push(`profile count: ${profiles.length}`);
  if (relations.length !== model.relations.length) errors.push(`relation count: ${relations.length}`);

  const documentIds = new Set(model.documents.map((item) => item.id));
  for (const item of questions) {
    for (const required of item.required_evidence ?? []) {
      if (!documentIds.has(required.document_id)) errors.push(`unknown evidence document: ${item.id}/${required.document_id}`);
    }
  }
  for (const domain of domains) {
    if (domain.document_count !== EXPECTED.documents_per_department) errors.push(`domain document count: ${domain.domain_id}`);
    if (domain.question_count !== EXPECTED.questions_per_department) errors.push(`domain question count: ${domain.domain_id}`);
  }

  const relationKinds = [...new Set(model.relations.map((item) => item.kind))].sort();
  const report = {
    valid: errors.length === 0, errors: errors.slice(0, 100), error_count: errors.length,
    industries: EXPECTED.industries, rag_domains: buildDomains().length,
    documents: selectedDocuments.length,
    questions: selectedDomains ? model.questions.filter((item) => selectedDomains.has(`${item.industry}-${item.department}`)).length : model.questions.length,
    relations: model.relations.length, relation_kinds: relationKinds,
    source_characters: characters,
    average_characters_per_document: selectedDocuments.length ? Math.round(characters / selectedDocuments.length) : 0,
  };
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith("validate-enterprise-diverse-corpus.mjs")) {
  const domainIndex = process.argv.indexOf("--domains");
  const domains = domainIndex >= 0 ? process.argv[domainIndex + 1].split(",").filter(Boolean) : null;
  const report = validateGeneratedCorpus({ domains });
  if (!domains) {
    const reportFile = path.join(corpusRoot, "generation", "validation-report.json");
    fs.mkdirSync(path.dirname(reportFile), { recursive: true });
    fs.writeFileSync(reportFile, `${JSON.stringify({ ...report, validated_at: new Date().toISOString() }, null, 2)}\n`, "utf8");
  }
  console.log(JSON.stringify(report, null, 2));
  if (!report.valid) process.exitCode = 1;
}
