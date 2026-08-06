#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
export const corpusRoot = path.join(repositoryRoot, "tests", "corpora", "aobane-industries-ja-dynamic-validity-scale");
export const volumeCorpusRoot = path.join(repositoryRoot, "tests", "corpora", "aobane-industries-ja-dynamic-validity-volume-200");

const backgroundCorpora = [
  "../aobane-industries-ja-medium",
  "../fragrach-enterprise-ja-longform",
];

const sites = [
  ["北関東工場", "kitakanto"], ["南関東工場", "minamikanto"],
  ["中部工場", "chubu"], ["関西工場", "kansai"],
  ["瀬戸内工場", "setouchi"], ["北陸工場", "hokuriku"],
  ["東北工場", "tohoku"], ["九州工場", "kyushu"],
  ["北海道工場", "hokkaido"], ["中央技術センター", "central-lab"],
];

const processes = [
  { name: "受入部材の抜取検査", short: "受入検査", factA: "抜取頻度", oldA: "10台ごとに1台", newA: "20台ごとに1台", altA: "30台ごとに1台", factB: "検査記録の保存期間", oldB: "3年間", altB: "5年間" },
  { name: "一時Exportファイルの後処理", short: "Export後処理", factA: "自動削除までの保持時間", oldA: "72時間", newA: "60時間", altA: "24時間", factB: "削除job登録前の確認者数", oldB: "2名", altB: "1名" },
  { name: "生産設備の予防保全", short: "予防保全", factA: "定期点検周期", oldA: "30日", newA: "21日", altA: "45日", factB: "点検記録の保存期間", oldB: "4年間", altB: "2年間" },
  { name: "重大障害の初動報告", short: "障害報告", factA: "一次報告の期限", oldA: "4時間", newA: "2時間", altA: "8時間", factB: "正式報告の期限", oldB: "24時間", altB: "48時間" },
  { name: "特権アカウントの棚卸し", short: "権限棚卸し", factA: "棚卸し周期", oldA: "90日", newA: "60日", altA: "120日", factB: "証跡の保存期間", oldB: "5年間", altB: "3年間" },
];

const patterns = ["version", "amendment", "scoped_exception", "rejected_change", "unresolved_conflict"];
const developmentSites = new Set([0, 2, 5, 7]);

function walkFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? walkFiles(target) : [target];
  });
}

function normalize(value) {
  return value.replaceAll("\\", "/");
}

function writeJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

function fillerParagraph(scenario, documentKind, index) {
  const actors = ["現場責任者", "品質保証担当", "文書管理担当", "運用管理者", "監査担当"];
  const records = ["実施記録", "確認票", "例外記録", "引継ぎ記録", "監査証跡"];
  const actor = actors[(scenario.index + index) % actors.length];
  const record = records[(scenario.index * 3 + index) % records.length];
  return `${scenario.siteName}の${scenario.process.name}では、${actor}が${record}と対象範囲を照合する。${documentKind}に記載された数値だけを転記せず、作業対象、実施日、承認経路、関連する記録番号を確認する。差異がある場合は判断を保留し、文書管理担当へ照会した経緯を残す。`; 
}

function renderLongDocument({ scenario, title, documentKind, lead, facts = [], tail, targetParagraphs = 24 }) {
  const sections = [
    ["目的", `${lead} 本文は${scenario.siteName}における${scenario.process.name}の運用境界と記録方法を定める。`],
    ["適用対象", `${scenario.siteName}で実施する${scenario.process.short}を対象とし、他拠点へは自動的に適用しない。`],
    ["責任分担", fillerParagraph(scenario, documentKind, 1)],
    ["事前確認", fillerParagraph(scenario, documentKind, 2)],
    ["運用手順", fillerParagraph(scenario, documentKind, 3)],
  ];
  for (let index = 4; index < Math.floor(targetParagraphs * 0.55); index += 1) {
    sections.push([`運用上の留意事項 ${index - 3}`, fillerParagraph(scenario, documentKind, index)]);
  }
  sections.push(["判断に用いる基準", facts.map((fact) => `- ${fact.label}: ${fact.value}`).join("\n")]);
  for (let index = Math.floor(targetParagraphs * 0.55); index < targetParagraphs; index += 1) {
    sections.push([`記録と確認 ${index}`, fillerParagraph(scenario, documentKind, index)]);
  }
  sections.push(["文書間の扱い", tail]);
  return `# ${title}\n\n${sections.map(([heading, body]) => `## ${heading}\n\n${body}`).join("\n\n")}\n`;
}

function sourcePath(scenario, name) {
  return `sources/70-dynamic/${scenario.familyId}/${name}.md`;
}

function profile(source, overrides = {}) {
  return {
    source,
    role: "normative",
    status: "current",
    approved: true,
    official_record: true,
    authority_rank: 9,
    scope: {},
    time: { valid_from: "2026-01-01" },
    ...overrides,
  };
}

function backgroundInventory(root = corpusRoot) {
  const rows = [];
  for (const relativeRoot of backgroundCorpora) {
    const absoluteRoot = path.resolve(root, relativeRoot);
    const sourcesRoot = path.join(absoluteRoot, "sources");
    for (const filePath of walkFiles(sourcesRoot)) {
      if (!/\.(md|markdown|txt)$/i.test(filePath)) continue;
      rows.push({
        source: `sources/${normalize(path.relative(sourcesRoot, filePath))}`,
        introduced_at: "T0",
        source_root: relativeRoot,
      });
    }
  }
  return rows.sort((left, right) => left.source.localeCompare(right.source, "ja"));
}

function stageGold({ asOf, decision = "answer", answers, forbidden, retrieval, required, forbiddenEvidence = [] }) {
  return {
    as_of: asOf,
    expected_decision: decision,
    answer_values: answers,
    forbidden_answer_values: forbidden,
    retrieval_gold: retrieval,
    required_evidence_sets: [required],
    forbidden_governing_evidence: forbiddenEvidence,
  };
}

function questionRow(scenario, suffix, factLabel, t0, t1) {
  const row = {
    id: `${scenario.familyId.toUpperCase()}-${suffix}`,
    family_id: scenario.familyId,
    split: scenario.split,
    category: `${scenario.pattern}_${suffix === "A" ? "primary" : "unchanged_or_secondary"}`,
    question: `${scenario.siteName}の${scenario.process.name}について、${factLabel}はいくつですか。`,
    scope: { sites: [scenario.siteCode] },
    stages: { T0: t0, T1: t1 },
  };
  return scenario.transformQuestion
    ? scenario.transformQuestion(row, { scenario, suffix, factLabel })
    : row;
}

function documentIdentity(source) {
  const parts = normalize(source).split("/");
  const familyId = parts.at(-2).toUpperCase();
  const stem = path.basename(parts.at(-1), ".md");
  const version = stem.match(/^\d+-operating-standard-v(\d+)$/);
  if (version) {
    return { document_id: `${familyId}-STD`, revision: version[1] };
  }
  return {
    document_id: `${familyId}-${stem.replace(/^\d+-/, "").replaceAll(/[^a-zA-Z0-9]+/g, "-").toUpperCase()}`,
    revision: "1",
  };
}

function identityLabel(source) {
  const identity = documentIdentity(source);
  return `${identity.document_id} revision ${identity.revision}`;
}

function renderDocumentMetadata(identity, documentProfile) {
  const documentType = documentProfile.role === "normative"
    ? "standard"
    : documentProfile.role === "record"
      ? "approval_record"
      : documentProfile.role;
  const fields = {
    document_id: identity.document_id,
    revision: identity.revision,
    document_type: documentType,
    status: documentProfile.status,
    approved: documentProfile.approved,
    official_record: documentProfile.official_record,
    valid_from: documentProfile.time?.valid_from,
    valid_to: documentProfile.time?.valid_to,
    position: documentProfile.position,
    position_target_document_id: documentProfile.position_target_source
      ? documentIdentity(documentProfile.position_target_source).document_id
      : undefined,
    position_target_revision: documentProfile.position_target_source
      ? documentIdentity(documentProfile.position_target_source).revision
      : undefined,
    position_verified_by: documentProfile.position_verified_by_source
      ? documentIdentity(documentProfile.position_verified_by_source).document_id
      : undefined,
  };
  const rows = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
  return `---\n${rows.join("\n")}\n---\n\n`;
}

function scenarioPlan(site, process, siteIndex, processIndex, cohortIndex = 0, cohorts = 1) {
  const index = cohortIndex * sites.length * processes.length
    + siteIndex * processes.length + processIndex;
  const cohortSuffix = cohortIndex === 0 ? "" : `第${cohortIndex + 1}`;
  const siteName = cohortIndex === 0
    ? site[0]
    : site[0].replace(/工場$/, `${cohortSuffix}工場`).replace(/センター$/, `${cohortSuffix}センター`);
  const split = cohorts === 1
    ? (developmentSites.has(siteIndex) ? "development" : "holdout")
    : index < 40
      ? "development"
      : index < 80
        ? "validation"
        : "final_holdout";
  return {
    index,
    familyId: `dvx-${String(index + 1).padStart(3, "0")}`,
    siteName,
    siteCode: cohortIndex === 0 ? site[1] : `${site[1]}-${cohortIndex + 1}`,
    process,
    pattern: patterns[(siteIndex + processIndex) % patterns.length],
    split,
  };
}

function addDocument(plan, source, stage, content, documentProfile) {
  const identity = documentIdentity(source);
  plan.documents.push({ source, introduced_at: stage });
  plan.contents.set(source, `${renderDocumentMetadata(identity, documentProfile)}${content}`);
  plan.profiles.push({ ...documentProfile, ...identity });
}

function addScenario(plan, scenario) {
  const p = scenario.process;
  const base = sourcePath(scenario, "01-operating-standard-v1");
  const scope = { sites: [scenario.siteCode] };
  const baseStatus = scenario.pattern === "version" ? "superseded" : "current";
  const baseTime = scenario.pattern === "version"
    ? { valid_from: "2026-01-01", valid_to: "2026-06-30" }
    : { valid_from: "2026-01-01" };
  addDocument(plan, base, "T0", renderLongDocument({
    scenario,
    title: `${scenario.siteName} ${p.name}運用標準`,
    documentKind: "運用標準",
    lead: "日常業務で参照する基準文書である。",
    facts: [{ label: p.factA, value: p.oldA }, { label: p.factB, value: p.oldB }],
    tail: "文書の有効版と承認状態は文書管理手続で確認する。共有フォルダの更新日時だけでは判断しない。",
  }), profile(base, { status: baseStatus, scope, time: baseTime }));

  const commonT0 = {
    A: stageGold({ asOf: "2026-06-15", answers: [p.oldA], forbidden: [p.newA, p.altA], retrieval: [base], required: [base] }),
    B: stageGold({ asOf: "2026-06-15", answers: [p.oldB], forbidden: [p.altB], retrieval: [base], required: [base] }),
  };
  let t1A;
  let t1B;

  if (scenario.pattern === "version") {
    const current = sourcePath(scenario, "02-operating-standard-v2");
    const candidate = sourcePath(scenario, "03-revision-working-paper");
    const register = sourcePath(scenario, "04-document-control-register");
    addDocument(plan, current, "T1", renderLongDocument({ scenario, title: `${scenario.siteName} ${p.name}運用標準 改訂版`, documentKind: "改訂標準", lead: "既存手順を再整理した版である。", facts: [{ label: p.factA, value: p.newA }, { label: p.factB, value: p.oldB }], tail: "この版の効力は文書管理台帳の正本指定によって確定する。" }), profile(current, { position: "dominates", position_target_source: base, position_verified_by_source: register, scope, time: { valid_from: "2026-07-01" } }));
    addDocument(plan, candidate, "T1", renderLongDocument({ scenario, title: `${scenario.siteName} ${p.name}改善検討資料`, documentKind: "検討資料", lead: "次回改訂候補を比較するための作業資料である。", facts: [{ label: p.factA, value: p.altA }, { label: p.factB, value: p.altB }], tail: "採否は別の承認手続で決まり、この資料だけでは業務基準を変更しない。" }), profile(candidate, { position: "non_effective", position_target_source: current, position_verified_by_source: register, role: "proposal", status: "draft", approved: false, official_record: false, authority_rank: 4, scope, time: { valid_from: "2026-07-20" } }));
    addDocument(plan, register, "T1", renderLongDocument({ scenario, title: `${scenario.siteName} 文書管理台帳`, documentKind: "管理台帳", lead: "正本と失効版を管理する公式記録である。", facts: [{ label: "現行正本", value: identityLabel(current) }, { label: "旧版", value: `${identityLabel(base)}・2026-06-30失効` }, { label: "改善検討資料", value: `${identityLabel(candidate)}・未承認` }], tail: "数値の内容は各正本文書を参照し、台帳はどの版を採用するかの判断に使う。", targetParagraphs: 20 }), profile(register, { role: "record", authority_rank: 10, scope, time: { valid_from: "2026-07-01" } }));
    plan.relations.push({ type: "supersedes", from: current, to: base, evidence: register }, { type: "draft_of", from: candidate, to: current, evidence: register });
    t1A = stageGold({ asOf: "2026-08-15", answers: [p.newA], forbidden: [p.oldA, p.altA], retrieval: [current], required: [current, register], forbiddenEvidence: [base, candidate] });
    t1B = stageGold({ asOf: "2026-08-15", answers: [p.oldB], forbidden: [p.altB], retrieval: [current], required: [current, register], forbiddenEvidence: [base, candidate] });
  } else if (scenario.pattern === "amendment") {
    const amendment = sourcePath(scenario, "02-approved-amendment");
    const candidate = sourcePath(scenario, "03-amendment-draft");
    const ledger = sourcePath(scenario, "04-amendment-approval-ledger");
    addDocument(plan, amendment, "T1", renderLongDocument({ scenario, title: `${scenario.siteName} ${p.name}追補`, documentKind: "追補", lead: "既存標準の一部だけを変更する文書である。", facts: [{ label: `${p.factA}の変更後値`, value: p.newA }], tail: `${p.factB}を含む記載のない条項は元の運用標準を維持する。効力は承認台帳で確認する。` }), profile(amendment, { position: "conditional", position_target_source: base, position_verified_by_source: ledger, scope, time: { valid_from: "2026-07-10" } }));
    addDocument(plan, candidate, "T1", renderLongDocument({ scenario, title: `${scenario.siteName} ${p.name}追加変更案`, documentKind: "変更案", lead: "追補後の追加改善を検討する資料である。", facts: [{ label: p.factA, value: p.altA }, { label: p.factB, value: p.altB }], tail: "承認記録が付与されるまでは運用へ適用しない。" }), profile(candidate, { position: "non_effective", position_target_source: amendment, position_verified_by_source: ledger, role: "proposal", status: "draft", approved: false, official_record: false, authority_rank: 4, scope, time: { valid_from: "2026-07-25" } }));
    addDocument(plan, ledger, "T1", renderLongDocument({ scenario, title: `${scenario.siteName} 追補承認台帳`, documentKind: "承認台帳", lead: "追補の承認と発効を管理する公式記録である。", facts: [{ label: "承認済み追補", value: identityLabel(amendment) }, { label: "発効日", value: "2026-07-10" }, { label: "追加変更案", value: `${identityLabel(candidate)}・審査前` }], tail: "追補と元標準を組み合わせて現行条件を判断する。", targetParagraphs: 20 }), profile(ledger, { role: "record", authority_rank: 10, scope, time: { valid_from: "2026-07-10" } }));
    plan.relations.push({ type: "amends", from: amendment, to: base, evidence: ledger }, { type: "draft_of", from: candidate, to: amendment, evidence: ledger });
    t1A = stageGold({ asOf: "2026-08-15", answers: [p.newA], forbidden: [p.oldA, p.altA], retrieval: [amendment], required: [base, amendment, ledger], forbiddenEvidence: [candidate] });
    t1B = stageGold({ asOf: "2026-08-15", answers: [p.oldB], forbidden: [p.altB], retrieval: [base], required: [base, amendment, ledger], forbiddenEvidence: [candidate] });
  } else if (scenario.pattern === "scoped_exception") {
    const exception = sourcePath(scenario, "02-site-exception");
    const expired = sourcePath(scenario, "03-expired-exception-copy");
    const register = sourcePath(scenario, "04-exception-register");
    addDocument(plan, exception, "T1", renderLongDocument({ scenario, title: `${scenario.siteName} ${p.name}限定特例`, documentKind: "限定特例", lead: "対象拠点だけに適用する追加条件である。", facts: [{ label: `${p.factA}の特例値`, value: p.newA }], tail: `${p.factB}は元の運用標準を維持する。対象期間と登録状態は特例台帳で確認する。` }), profile(exception, { position: "conditional", position_target_source: base, position_verified_by_source: register, scope, time: { valid_from: "2026-08-01", valid_to: "2026-09-30" } }));
    addDocument(plan, expired, "T1", renderLongDocument({ scenario, title: `${scenario.siteName} ${p.name}過去特例控え`, documentKind: "過去特例", lead: "過去の繁忙期に使用した条件の控えである。", facts: [{ label: p.factA, value: p.altA }, { label: p.factB, value: p.altB }], tail: "現在の適用可否は特例台帳で確認する。" }), profile(expired, { position: "non_effective", position_target_source: base, position_verified_by_source: register, status: "expired", scope, time: { valid_from: "2025-08-01", valid_to: "2025-09-30" } }));
    addDocument(plan, register, "T1", renderLongDocument({ scenario, title: `${scenario.siteName} 特例管理台帳`, documentKind: "特例台帳", lead: "期間限定特例の登録状態を管理する公式記録である。", facts: [{ label: "現行特例", value: identityLabel(exception) }, { label: "適用期間", value: "2026-08-01から2026-09-30" }, { label: "過去特例控え", value: `${identityLabel(expired)}・失効` }], tail: "特例に記載のない条項は元標準を適用する。", targetParagraphs: 20 }), profile(register, { role: "record", authority_rank: 10, scope, time: { valid_from: "2026-08-01" } }));
    plan.relations.push({ type: "exception_to", from: exception, to: base, evidence: register }, { type: "expired_exception_to", from: expired, to: base, evidence: register });
    t1A = stageGold({ asOf: "2026-08-15", answers: [p.newA], forbidden: [p.oldA, p.altA], retrieval: [exception], required: [base, exception, register], forbiddenEvidence: [expired] });
    t1B = stageGold({ asOf: "2026-08-15", answers: [p.oldB], forbidden: [p.altB], retrieval: [base], required: [base, exception, register], forbiddenEvidence: [expired] });
  } else if (scenario.pattern === "rejected_change") {
    const request = sourcePath(scenario, "02-change-request");
    const research = sourcePath(scenario, "03-research-note");
    const ledger = sourcePath(scenario, "04-change-approval-ledger");
    addDocument(plan, request, "T1", renderLongDocument({ scenario, title: `${scenario.siteName} ${p.name}変更申請`, documentKind: "変更申請", lead: "運用条件の変更を審査へ付す申請文書である。", facts: [{ label: `申請中の${p.factA}`, value: p.newA }, { label: `申請中の${p.factB}`, value: p.altB }], tail: "申請内容は承認台帳で承認されるまで現行条件にならない。" }), profile(request, { position: "non_effective", position_target_source: base, position_verified_by_source: ledger, role: "proposal", status: "rejected", approved: false, official_record: true, authority_rank: 5, scope, time: { valid_from: "2026-07-15" } }));
    addDocument(plan, research, "T1", renderLongDocument({ scenario, title: `${scenario.siteName} ${p.name}予備検証記録`, documentKind: "研究記録", lead: "変更候補の予備的な検証結果をまとめた記録である。", facts: [{ label: "試験条件", value: p.altA }, { label: "参考保存条件", value: p.altB }], tail: "試験結果だけでは運用標準を変更しない。" }), profile(research, { position: "non_effective", position_target_source: base, position_verified_by_source: ledger, role: "reference", status: "research", approved: false, official_record: true, authority_rank: 5, scope, time: { valid_from: "2026-07-18" } }));
    addDocument(plan, ledger, "T1", renderLongDocument({ scenario, title: `${scenario.siteName} 変更承認台帳`, documentKind: "承認台帳", lead: "変更申請の判定を管理する公式記録である。", facts: [{ label: "変更申請", value: `${identityLabel(request)}・却下` }, { label: "研究記録", value: `${identityLabel(research)}・参考` }, { label: "現行標準", value: `${identityLabel(base)}・変更なし` }], tail: "却下された申請と研究記録は現行条件の結論根拠にしない。", targetParagraphs: 20 }), profile(ledger, { role: "record", authority_rank: 10, scope, time: { valid_from: "2026-07-25" } }));
    plan.relations.push({ type: "rejected_change_to", from: request, to: base, evidence: ledger }, { type: "research_for", from: research, to: request, evidence: ledger });
    t1A = stageGold({ asOf: "2026-08-15", answers: [p.oldA], forbidden: [p.newA, p.altA], retrieval: [base], required: [base, ledger], forbiddenEvidence: [request, research] });
    t1B = stageGold({ asOf: "2026-08-15", answers: [p.oldB], forbidden: [p.altB], retrieval: [base], required: [base, ledger], forbiddenEvidence: [request, research] });
  } else {
    const orderA = sourcePath(scenario, "02-emergency-order-a");
    const orderB = sourcePath(scenario, "03-emergency-order-b");
    const ledger = sourcePath(scenario, "04-authority-ledger");
    addDocument(plan, orderA, "T1", renderLongDocument({ scenario, title: `${scenario.siteName} ${p.name}緊急指示A`, documentKind: "緊急指示", lead: "一時的な運用変更を命じる正式指示である。", facts: [{ label: p.factA, value: p.newA }, { label: p.factB, value: p.oldB }], tail: "競合する指示がある場合は権限台帳と上位決裁を確認する。" }), profile(orderA, { position: "unresolved", position_target_source: orderB, position_verified_by_source: ledger, authority_rank: 9, scope, time: { valid_from: "2026-07-20" } }));
    addDocument(plan, orderB, "T1", renderLongDocument({ scenario, title: `${scenario.siteName} ${p.name}緊急指示B`, documentKind: "緊急指示", lead: "一時的な運用変更を命じる正式指示である。", facts: [{ label: p.factA, value: p.altA }, { label: p.factB, value: p.altB }], tail: "競合する指示がある場合は権限台帳と上位決裁を確認する。" }), profile(orderB, { authority_rank: 9, scope, time: { valid_from: "2026-07-20" } }));
    addDocument(plan, ledger, "T1", renderLongDocument({ scenario, title: `${scenario.siteName} 緊急指示権限台帳`, documentKind: "権限台帳", lead: "緊急指示の発行権限と失効を管理する公式記録である。", facts: [{ label: "緊急指示A", value: `${identityLabel(orderA)}・承認済み・現行` }, { label: "緊急指示B", value: `${identityLabel(orderB)}・承認済み・現行` }, { label: "権威順位", value: "同順位" }], tail: "優先関係を決める上位決裁は未登録であり、台帳だけでは一方を採用できない。", targetParagraphs: 20 }), profile(ledger, { role: "record", authority_rank: 10, scope, time: { valid_from: "2026-07-20" } }));
    plan.relations.push({ type: "conflicts_with", from: orderA, to: orderB, evidence: ledger }, { type: "equal_authority", from: orderA, to: orderB, evidence: ledger });
    t1A = stageGold({ asOf: "2026-08-15", decision: "unresolved", answers: ["unresolved"], forbidden: [p.oldA, p.newA, p.altA], retrieval: [orderA, orderB], required: [orderA, orderB, ledger] });
    t1B = stageGold({ asOf: "2026-08-15", decision: "unresolved", answers: ["unresolved"], forbidden: [p.oldB, p.altB], retrieval: [orderA, orderB], required: [orderA, orderB, ledger] });
  }

  plan.questions.push(
    questionRow(scenario, "A", p.factA, commonT0.A, t1A),
    questionRow(scenario, "B", p.factB, commonT0.B, t1B),
  );
}

export function buildScaleCorpusPlan({
  outputRoot = corpusRoot, cohorts = 1, transformScenario = null,
} = {}) {
  if (!Number.isInteger(cohorts) || cohorts < 1) throw new Error("cohorts must be a positive integer");
  const backgrounds = backgroundInventory(outputRoot);
  const plan = {
    backgrounds,
    documents: [...backgrounds.map(({ source, introduced_at }) => ({ source, introduced_at }))],
    contents: new Map(),
    profiles: backgrounds.map(({ source }) => profile(source, {
      role: "reference", status: "background", approved: false,
      official_record: false, authority_rank: 1, scope: {}, time: { valid_from: "2000-01-01" },
    })),
    relations: [],
    questions: [],
  };
  for (let cohortIndex = 0; cohortIndex < cohorts; cohortIndex += 1) {
    for (let siteIndex = 0; siteIndex < sites.length; siteIndex += 1) {
      for (let processIndex = 0; processIndex < processes.length; processIndex += 1) {
        const scenario = scenarioPlan(
          sites[siteIndex], processes[processIndex], siteIndex, processIndex, cohortIndex, cohorts,
        );
        addScenario(plan, transformScenario ? transformScenario(scenario) : scenario);
      }
    }
  }
  return plan;
}

export function generateScaleCorpus({
  outputRoot = corpusRoot, cohorts = 1, transformScenario = null, corpusId = null,
} = {}) {
  const plan = buildScaleCorpusPlan({ outputRoot, cohorts, transformScenario });
  for (const [source, content] of plan.contents) {
    const target = path.join(outputRoot, source);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
  }
  const manifest = {
    schema_version: "1.0",
    corpus_id: corpusId ?? (cohorts === 1
      ? "aobane-industries-ja-dynamic-validity-scale"
      : `aobane-industries-ja-dynamic-validity-volume-${cohorts * sites.length * processes.length}`),
    stages: ["T0", "T1"],
    source_roots: [".", ...backgroundCorpora],
    documents: plan.documents,
    design: {
      background_documents: plan.backgrounds.length,
      dynamic_families: cohorts * sites.length * processes.length,
      dynamic_documents: plan.contents.size,
      questions: plan.questions.length,
      split_unit: "family_id",
      splits: Object.fromEntries([...new Set(plan.questions.map((question) => question.split))]
        .map((split) => [split, plan.questions.filter((question) => question.split === split).length])),
    },
  };
  fs.mkdirSync(outputRoot, { recursive: true });
  fs.writeFileSync(path.join(outputRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  writeJsonl(path.join(outputRoot, "gold", "profiles.jsonl"), plan.profiles);
  writeJsonl(path.join(outputRoot, "gold", "relations.jsonl"), plan.relations);
  writeJsonl(path.join(outputRoot, "evaluation", "questions.jsonl"), plan.questions);
  if (outputRoot !== corpusRoot) {
    const intentSource = path.join(corpusRoot, "intents", "dynamic-validity.yaml");
    const intentTarget = path.join(outputRoot, "intents", "dynamic-validity.yaml");
    fs.mkdirSync(path.dirname(intentTarget), { recursive: true });
    fs.copyFileSync(intentSource, intentTarget);
  }
  return {
    background_documents: plan.backgrounds.length,
    dynamic_documents: plan.contents.size,
    total_documents: plan.documents.length,
    profiles: plan.profiles.length,
    relations: plan.relations.length,
    questions: plan.questions.length,
    development_questions: plan.questions.filter((question) => question.split === "development").length,
    holdout_questions: plan.questions.filter((question) => question.split === "holdout").length,
    validation_questions: plan.questions.filter((question) => question.split === "validation").length,
    final_holdout_questions: plan.questions.filter((question) => question.split === "final_holdout").length,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const volume = process.argv.includes("--volume-200");
  console.log(JSON.stringify(generateScaleCorpus({
    outputRoot: volume ? volumeCorpusRoot : corpusRoot,
    cohorts: volume ? 4 : 1,
  }), null, 2));
}
