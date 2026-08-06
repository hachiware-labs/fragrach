#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Bm25Index, buildRawChunks, rawProfileOptions, scoreRetrieval } from "./run-upper-bound.mjs";

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const defaultCorpus = path.resolve(scriptRoot, "../../corpora/fragrach-enterprise-ja-diverse");
const defaultOutput = path.resolve(scriptRoot, "../../../target/benchmarks/enterprise-domain-raw");

const readJsonl = (file) => fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const pct = (value) => value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;

function retrievalFor(chunks, questions, profile) {
  const index = new Bm25Index(chunks, profile.index);
  return new Map(questions.map((question) => {
    const query = profile.queryMode === "question-as-of" ? `${question.question}\n対象時点: ${question.as_of}` : question.question;
    return [question.id, index.search(query, 20)];
  }));
}

function compact(score) {
  return {
    questions: score.questions, recall_at_k: score.recall_at_k,
    complete_at_k: score.complete_at_k,
    precision_at_k: score.precision_at_k,
    distractor_rate_at_k: score.distractor_rate_at_k,
    conflict_complete_rate_at_k: score.conflict_complete_rate_at_k,
    resolution_accuracy_at_k: score.resolution_accuracy_at_k,
  };
}

function relationPathRecall(questions, retrieval, sourceByDocumentId, ks = [5, 10, 20]) {
  return Object.fromEntries(ks.map((k) => {
    const scores = questions.map((question) => {
      const relations = question.required_relations ?? [];
      if (relations.length === 0) return 1;
      const sources = new Set((retrieval.get(question.id) ?? []).slice(0, k)
        .flatMap((item) => item.document.evidence ?? []).map((item) => item.source.replaceAll("\\", "/")));
      const hits = relations.filter((relation) => {
        const parts = relation.split(" ");
        const subject = sourceByDocumentId.get(parts[0]);
        const object = sourceByDocumentId.get(parts.at(-1));
        return subject && object && sources.has(subject) && sources.has(object);
      }).length;
      return hits / relations.length;
    });
    return [String(k), mean(scores)];
  }));
}

export function evaluateDepartmentDomains(corpusRoot, selectedDomainIds = null) {
  const domains = readJsonl(path.join(corpusRoot, "evaluation", "rag-domains.jsonl"))
    .filter((domain) => !selectedDomainIds || selectedDomainIds.has(domain.domain_id));
  const allQuestions = readJsonl(path.join(corpusRoot, "evaluation", "questions.jsonl"));
  const questionById = new Map(allQuestions.map((question) => [question.id, question]));
  const sourceByDocumentId = new Map(readJsonl(path.join(corpusRoot, "gold", "profiles.jsonl"))
    .map((profile) => [profile.source_id, profile.relative_path.replaceAll("\\", "/")]));
  const profileNames = ["current", "tuned-sparse-v1"];
  const chunksByProfile = Object.fromEntries(profileNames.map((name) => {
    const profile = rawProfileOptions(name);
    return [name, buildRawChunks(corpusRoot, profile.chunking)];
  }));
  const rows = [];
  const combined = Object.fromEntries(profileNames.map((name) => [name, { questions: [], retrieval: new Map() }]));

  for (const domain of domains) {
    const questions = domain.question_ids.map((id) => questionById.get(id)).filter(Boolean);
    const chunks = chunksByProfile.current.filter((chunk) => chunk.evidence.some((item) => item.source.startsWith(domain.source_prefix)));
    if (chunks.length === 0) throw new Error(`no source chunks for ${domain.domain_id}; corpus generation may be incomplete`);
    const profiles = {};
    for (const name of profileNames) {
      const profile = rawProfileOptions(name);
      const profileChunks = chunksByProfile[name]
        .filter((chunk) => chunk.evidence.some((item) => item.source.startsWith(domain.source_prefix)));
      const retrieval = retrievalFor(profileChunks, questions, profile);
      profiles[name] = {
        ...compact(scoreRetrieval(questions, retrieval, [5, 10, 20])),
        relation_path_recall_at_k: relationPathRecall(questions, retrieval, sourceByDocumentId),
      };
      combined[name].questions.push(...questions);
      for (const [id, items] of retrieval) combined[name].retrieval.set(id, items);
    }
    rows.push({
      domain_id: domain.domain_id, industry: domain.industry, department: domain.department,
      documents: domain.document_count, chunks: chunks.length, questions: questions.length, profiles,
    });
  }

  const aggregate = Object.fromEntries(profileNames.map((name) => [name, {
    ...compact(scoreRetrieval(combined[name].questions, combined[name].retrieval, [5, 10, 20])),
    relation_path_recall_at_k: relationPathRecall(combined[name].questions, combined[name].retrieval, sourceByDocumentId),
  }]));
  const byIndustry = [...new Set(rows.map((row) => row.industry))].map((industry) => {
    const selected = rows.filter((row) => row.industry === industry);
    return {
      industry, domains: selected.length,
      profiles: Object.fromEntries(profileNames.map((name) => [name, {
        recall_at_5: mean(selected.map((row) => row.profiles[name].recall_at_k["5"])),
        recall_at_10: mean(selected.map((row) => row.profiles[name].recall_at_k["10"])),
      }])),
    };
  });
  return { domains: rows, aggregate, by_industry: byIndustry };
}

function markdown(report) {
  const rows = report.domains.map((row) => `| ${row.industry} | ${row.department} | ${row.questions} | ${pct(row.profiles.current.recall_at_k["5"])} | ${pct(row.profiles.current.recall_at_k["10"])} | ${pct(row.profiles["tuned-sparse-v1"].recall_at_k["5"])} | ${pct(row.profiles["tuned-sparse-v1"].recall_at_k["10"])} |`).join("\n");
  return `# 部門別Raw RAGベースライン\n\n` +
    `各部門の文書だけで独立したBM25索引を構築し、同じ部門のGold質問で評価した結果です。\n\n` +
    `| 条件 | 全体R@5 | 全体R@10 | 全体R@20 | 関係Path@10 |\n|---|---:|---:|---:|---:|\n` +
    `| Current Raw | ${pct(report.aggregate.current.recall_at_k["5"])} | ${pct(report.aggregate.current.recall_at_k["10"])} | ${pct(report.aggregate.current.recall_at_k["20"])} | ${pct(report.aggregate.current.relation_path_recall_at_k["10"])} |\n` +
    `| Tuned Raw | ${pct(report.aggregate["tuned-sparse-v1"].recall_at_k["5"])} | ${pct(report.aggregate["tuned-sparse-v1"].recall_at_k["10"])} | ${pct(report.aggregate["tuned-sparse-v1"].recall_at_k["20"])} | ${pct(report.aggregate["tuned-sparse-v1"].relation_path_recall_at_k["10"])} |\n\n` +
    `| 業種 | 部門 | 質問 | Current R@5 | Current R@10 | Tuned R@5 | Tuned R@10 |\n|---|---|---:|---:|---:|---:|---:|\n${rows}\n`;
}

function parseArgs(argv) {
  const options = { corpus: defaultCorpus, output: defaultOutput, domains: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--corpus") options.corpus = path.resolve(argv[++index]);
    else if (argv[index] === "--output") options.output = path.resolve(argv[++index]);
    else if (argv[index] === "--domains") options.domains = new Set(argv[++index].split(",").filter(Boolean));
    else if (argv[index] === "--help") options.help = true;
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node run-enterprise-domain-baseline.mjs [--corpus PATH] [--domains id,id] [--output PATH]");
  } else {
    const result = evaluateDepartmentDomains(options.corpus, options.domains);
    const report = { schema_version: "1.0", experiment: "enterprise-department-raw-rag", generated_at: new Date().toISOString(), corpus_root: options.corpus, ...result };
    fs.mkdirSync(options.output, { recursive: true });
    fs.writeFileSync(path.join(options.output, "domain-raw-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    fs.writeFileSync(path.join(options.output, "DOMAIN_RAW_FINDINGS_ja.md"), markdown(report), "utf8");
    console.log(`Domains ${report.domains.length}; Current R@5 ${pct(report.aggregate.current.recall_at_k["5"])}; Tuned R@5 ${pct(report.aggregate["tuned-sparse-v1"].recall_at_k["5"])}`);
  }
}
