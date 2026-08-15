#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const options = {
    output: path.join(repositoryRoot, "target/benchmarks/large-single-purpose-dossier/fixture"),
    groups: 4,
    supporting: 0,
    scopeMode: "complete",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--output") options.output = path.resolve(argv[++index]);
    else if (arg === "--groups") options.groups = Number(argv[++index]);
    else if (arg === "--supporting") options.supporting = Number(argv[++index]);
    else if (arg === "--scope-mode") options.scopeMode = argv[++index];
    else if (arg === "--help") options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isInteger(options.groups) || options.groups < 1) {
    throw new Error("--groups must be a positive integer");
  }
  if (!Number.isInteger(options.supporting) || options.supporting < 0) {
    throw new Error("--supporting must be a non-negative integer");
  }
  if (!["complete", "noisy-id", "missing-link", "ambiguous"].includes(options.scopeMode)) {
    throw new Error("--scope-mode must be complete, noisy-id, missing-link, or ambiguous");
  }
  return options;
}

function frontMatter(fields) {
  return [
    "---",
    ...Object.entries(fields).map(([key, value]) => (
      `${key}: ${typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value)}`
    )),
    "---",
  ].join("\n");
}

function document(fields, sections) {
  return `${frontMatter(fields)}\n\n# ${fields.title}\n\n${sections.map(
    ([heading, text]) => `## ${heading}\n\n${text}`,
  ).join("\n\n")}\n`;
}

function writeDocument(directory, name, fields, sections) {
  fs.writeFileSync(path.join(directory, name), document(fields, sections), "utf8");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node scripts/generate-large-dossier-fixture.mjs [--output DIR] [--groups N] [--supporting N] [--scope-mode complete|noisy-id|missing-link|ambiguous]");
    return;
  }
  if (fs.existsSync(options.output)) {
    throw new Error(`output already exists: ${options.output}`);
  }
  const sources = path.join(options.output, "sources", "commercial");
  fs.mkdirSync(sources, { recursive: true });
  const scenario = "large-commercial-portfolio-01";
  const purpose = "commercial_compliance";
  const common = {
    company: "北辰クラウドサービス",
    industry: "software",
    department: "vendor_management",
    scenario,
    purpose,
    valid_from: "2026-04-01",
    synthetic: true,
  };
  const masterId = "LARGE-COMMERCIAL-MASTER-001";
  writeDocument(sources, "master.md", {
    ...common,
    document_id: masterId,
    title: "クラウド運用支援基本契約",
    document_type: "master_agreement",
    status: "current",
    authority: "executed_contract",
    approved: true,
    force: "mandatory",
    force_rank: 9,
    official_record: true,
    scope: { organization: common.company, contract: masterId },
  }, [
    ["契約対象", "本契約は複数のクラウド運用支援サービスに共通する基本条件を定める。"],
    ["標準条件", "重大な依頼への一次応答は四時間以内とする。"],
    ["優先順位", "署名済みの個別契約で明示した条件は、その対象サービスに限り本基本契約より優先する。"],
  ]);

  const gold = [];
  for (let index = 1; index <= options.groups; index += 1) {
    const suffix = String(index).padStart(3, "0");
    const product = `運用サービス-${suffix}`;
    const sowId = `LARGE-COMMERCIAL-SOW-${suffix}`;
    const proposalId = `LARGE-COMMERCIAL-PROPOSAL-${suffix}`;
    const auditId = `LARGE-COMMERCIAL-AUDIT-${suffix}`;
    const scope = { organization: common.company, contract: masterId, product };
    writeDocument(sources, `sow-${suffix}.md`, {
      ...common,
      document_id: sowId,
      title: `${product} 個別契約書`,
      document_type: "statement_of_work",
      status: "current",
      authority: "executed_contract",
      approved: true,
      force: "mandatory",
      force_rank: 9,
      official_record: true,
      scope,
    }, [
      ["対象", `本個別契約は${product}を対象とし、基本契約「${masterId}」に基づく。`],
      ["個別条件", `${product}の一次応答は${index + 1}時間以内とする。`],
      ["優先", `本個別条件は${product}の範囲に限り基本契約「${masterId}」より優先する。`],
    ]);
    writeDocument(sources, `proposal-${suffix}.md`, {
      ...common,
      document_id: proposalId,
      title: `${product} 供給元改善提案`,
      document_type: "vendor_proposal",
      status: "proposed",
      authority: "external_proposal",
      approved: false,
      force: "proposed",
      force_rank: 1,
      official_record: false,
      scope,
    }, [
      ["提案", `${product}について一次応答を30分以内とする改善案を提示する。`],
      ["契約状態", `本提案は基本契約「${masterId}」の契約変更として署名されていない。`],
      ["適用", `未署名の提案「${proposalId}」を現在の契約義務として扱ってはならない。`],
    ]);
    const auditScope = options.scopeMode === "noisy-id"
      ? { organization: common.company, contract: [masterId, `  ${sowId.toLowerCase()}  `] }
      : ["missing-link", "ambiguous"].includes(options.scopeMode)
        ? { organization: common.company, contract: masterId }
        : scope;
    const auditSections = options.scopeMode === "ambiguous"
      ? [
        ["監査対象", `${product}に対応する個別契約の履行を監査した。`],
        ["評価基準", `${product}の一次応答実績を対象契約の条件と照合した。`],
        ["記録性", `本書「${auditId}」は履行評価の記録であり契約条件を新設しない。`],
      ]
      : [
        ["監査対象", `監査対象は個別契約「${sowId}」に基づく${product}の履行である。`],
        ["評価基準", `${product}の一次応答実績を個別契約「${sowId}」の条件と照合した。`],
        ["記録性", `本書「${auditId}」は履行評価の記録であり契約条件を新設しない。`],
      ];
    writeDocument(sources, `audit-${suffix}.md`, {
      ...common,
      document_id: auditId,
      title: `${product} 履行監査記録`,
      document_type: "audit_record",
      status: "completed",
      authority: "official_record",
      approved: true,
      force: "informational",
      force_rank: 7,
      official_record: true,
      scope: auditScope,
    }, auditSections);
    gold.push(
      { id: `${sowId}-R1`, kind: "order_of_precedence", subject: sowId, object: masterId },
      { id: `${proposalId}-R1`, kind: "proposes_change_to", subject: proposalId, object: masterId },
      { id: `${auditId}-R1`, kind: "records_execution_of", subject: auditId, object: sowId },
    );
  }
  for (let index = 1; index <= options.supporting; index += 1) {
    const suffix = String(index).padStart(3, "0");
    writeDocument(sources, `supporting-${suffix}.md`, {
      ...common,
      document_id: `LARGE-COMMERCIAL-SUPPORT-${suffix}`,
      title: `契約ポートフォリオ補足資料 ${suffix}`,
      document_type: "supporting_note",
      status: "current",
      authority: "internal_reference",
      approved: true,
      force: "informational",
      force_rank: 2,
      official_record: false,
      scope: { organization: common.company, contract: masterId },
    }, [
      ["目的", "本資料は契約ポートフォリオの検索補助情報を記録する。"],
      ["効力", "本資料は契約条件を新設、変更または証明するものではない。"],
    ]);
  }
  const documentCount = 1 + options.groups * 3 + options.supporting;
  fs.writeFileSync(
    path.join(options.output, "gold-relations.jsonl"),
    `${gold.map((relation) => JSON.stringify(relation)).join("\n")}\n`,
    "utf8",
  );
  fs.copyFileSync(
    path.join(repositoryRoot, "tests/corpora/fragrach-enterprise-ja-diverse/intents/commercial_compliance.yaml"),
    path.join(options.output, "intent.yaml"),
  );
  fs.writeFileSync(path.join(options.output, "fixture.json"), `${JSON.stringify({
    schema_version: "1.0",
    scenario,
    purpose,
    groups: options.groups,
    supporting: options.supporting,
    scope_mode: options.scopeMode,
    documents: documentCount,
    gold_relations: gold.length,
  }, null, 2)}\n`, "utf8");
  console.log(`Generated ${documentCount} documents and ${gold.length} gold relations in ${options.output}`);
}

main();
