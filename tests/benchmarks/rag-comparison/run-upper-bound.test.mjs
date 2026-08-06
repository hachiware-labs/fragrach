import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ANSWER_BEHAVIORS,
  Bm25Index,
  actualVariantOptions,
  augmentDossierPlan,
  assembleDossierRetrieval,
  buildActualChunks,
  buildOracleChunks,
  completeGoldAnswers,
  documentMatchesAsOf,
  enrichQuestionsWithConflictGold,
  expandRelationCitationIds,
  filterQuestionsByIntent,
  filterChunksBySourcePrefix,
  readCorpusGold,
  retrievalRecall,
  rawProfileOptions,
  scoreCompileCoverage,
  scoreRetrieval,
  structuredChatConfigs,
  tokenize,
} from "./run-upper-bound.mjs";
import { selectCanonicalRawChunks } from "./run-enterprise-actual-retrieval.mjs";

test("回答動作schemaは根拠付き回答を表現できる", () => {
  assert.ok(ANSWER_BEHAVIORS.includes("answer_with_provenance"));
});

test("Raw比較は部門のSource prefixへ限定できる", () => {
  const chunks = [
    { id: "a", evidence: [{ source: "sources/manufacturing/product-design/a.md" }] },
    { id: "b", evidence: [{ source: "sources/finance/accounting/b.md" }] },
  ];
  assert.deepEqual(
    filterChunksBySourcePrefix(chunks, "manufacturing/product-design").map((item) => item.id),
    ["a"],
  );
});

test("回答と採点のProviderを分離できる", () => {
  const configs = structuredChatConfigs({
    answerProvider: "codex-app-server",
    answerEndpoint: null,
    answerModel: "gpt-5.6-luna",
    answerReasoningEffort: "low",
    judgeProvider: "ollama",
    judgeEndpoint: null,
    judgeModel: "gemma4:latest",
    judgeReasoningEffort: "low",
    endpoint: "http://localhost:11434",
    model: "gemma4:latest",
    codexCommand: "codex",
  });
  assert.equal(configs.answer.provider, "codex-app-server");
  assert.equal(configs.answer.model, "gpt-5.6-luna");
  assert.equal(configs.judge.provider, "ollama");
  assert.equal(configs.judge.model, "gemma4:latest");
});

test("Answer Contractは時点付き規則質問に版系列slotを補う", () => {
  const plan = augmentDossierPlan(
    { question: "2026年7月時点でどの規則を適用しますか。" },
    { slots: [{ id: "rule", label: "適用規則", search_query: "規則" }] },
  );
  assert.ok(plan.slots.some((slot) => slot.id === "applicable_version"));
});

test("Answer ContractはFAQ矛盾質問に未反映と現行要件を補う", () => {
  const plan = augmentDossierPlan(
    { question: "FAQと正式規程が食い違う場合はどうしますか。" },
    { slots: [{ id: "priority", label: "優先順位", search_query: "正式規程を優先" }] },
  );
  assert.ok(plan.slots.some((slot) => slot.id === "stale_guidance"));
  assert.ok(plan.slots.some((slot) => slot.id === "canonical_requirement"));
});

test("Relation Dossierの引用は同じ関係Unitの両側原文へ展開する", () => {
  const question = { id: "Q1" };
  const retrieved = [{
    document: {
      relation: { kind: "supersedes" },
      evidence: [
        { source: "current.md", section: "現行規則" },
        { source: "old.md", section: "適用期間" },
      ],
    },
  }];
  assert.deepEqual(
    expandRelationCitationIds(["Q1-C1-E1"], question, retrieved),
    ["Q1-C1-E1", "Q1-C1-E2"],
  );
});

test("Actualアブレーション名を検索単位オプションへ変換する", () => {
  assert.deepEqual(actualVariantOptions("baseline"), {});
  assert.deepEqual(actualVariantOptions("evidence-fallback"), {
    evidenceFallback: true,
    includeDiagnosticAliases: true,
  });
  assert.deepEqual(actualVariantOptions("dossier"), {
    includeRelationDossiers: true,
  });
  assert.throws(
    () => actualVariantOptions("unknown"),
    /unknown --actual-variant/,
  );
});

test("Tuned Raw profileは測定済みの検索条件を固定する", () => {
  assert.deepEqual(rawProfileOptions("tuned-sparse-v1"), {
    chunking: {
      strategy: "fixed",
      maxChars: 1024,
      overlapParagraphs: 0,
    },
    index: {
      ngramSizes: [2],
      k1: 1.8,
      b: 0.75,
    },
    queryMode: "question-only",
  });
});

test("根拠再現率は同じ見出し内の必要本文まで照合する", () => {
  const question = {
    required_evidence: [{
      source: "sources/policy.md",
      section: "レビュー",
      content_terms: ["外部仕様", "設計レビュー"],
    }],
  };
  const wrongParagraph = [{
    document: {
      evidence: [{ source: "sources/policy.md", section: "レビュー" }],
      text: "誤字修正はレビューを省略できる",
    },
  }];
  const rightParagraph = [{
    document: {
      evidence: [{ source: "sources/policy.md", section: "レビュー" }],
      text: "外部仕様を変更する場合は設計レビューが必要",
    },
  }];
  assert.equal(retrievalRecall(question, wrongParagraph), 0);
  assert.equal(retrievalRecall(question, rightParagraph), 1);
});

test("Evidence Dossierはslot別Claimと関連Conflictを分けて集める", () => {
  const documents = [
    {
      id: "review",
      unit_type: "claim_evidence",
      intent_id: "design-review",
      text: "外部仕様 変更 requires_review 設計レビューが必要",
      evidence: [{ source: "sources/policy.md", section: "レビュー" }],
    },
    {
      id: "deadline",
      unit_type: "claim_evidence",
      intent_id: "design-review",
      text: "事後レビュー deadline 二営業日以内",
      evidence: [{ source: "sources/policy.md", section: "期限" }],
    },
    {
      id: "conflict",
      unit_type: "conflict",
      intent_id: "design-review",
      text: "事後レビュー期限 二営業日 五営業日 conflict",
      evidence: [{ source: "sources/policy.md", section: "期限" }],
    },
  ];
  const question = {
    id: "q1",
    intent_id: "design-review",
    question: "外部仕様変更のレビューと期限は",
    as_of: "2026-06-30",
  };
  const dossier = assembleDossierRetrieval(
    new Bm25Index(documents),
    null,
    question,
    {
      slots: [
        {
          id: "review",
          label: "レビュー要否",
          search_query: "外部仕様 requires_review",
        },
        {
          id: "deadline",
          label: "期限",
          search_query: "事後レビュー deadline",
        },
      ],
    },
    2,
  );
  assert.deepEqual(
    dossier.primary.map((item) => item.document.id).sort(),
    ["deadline", "review"],
  );
  assert.deepEqual(
    dossier.conflicts.map((item) => item.document.id),
    ["conflict"],
  );
});

test("指定したIntentの質問だけを評価対象にする", () => {
  const questions = [
    { id: "q1", intent_id: "design-review" },
    { id: "q2", intent_id: "incident-response" },
    { id: "q3", intent_id: "customer-support" },
  ];
  assert.deepEqual(
    filterQuestionsByIntent(questions, ["design-review", "incident-response"]),
    questions.slice(0, 2),
  );
  assert.equal(filterQuestionsByIntent(questions, []), questions);
});

test("日本語文字n-gramで分かち書きのない質問を検索できる", () => {
  const tokens = tokenize("設計レビューが必要ですか");
  assert(tokens.includes("設計"));
  assert(tokens.includes("レビ"));
});

test("BM25のtokenized corpusを共有してk1とbだけを変更できる", () => {
  const documents = [
    { id: "a", text: "品質基準の改訂" },
    { id: "b", text: "障害報告の手順" },
  ];
  const prepared = new Bm25Index(documents, { ngramSizes: [2, 3] });
  const tuned = prepared.withParameters({ k1: 0.9, b: 0.25 });
  assert.equal(tuned.postings, prepared.postings);
  assert.equal(tuned.documentLengths, prepared.documentLengths);
  assert.equal(tuned.k1, 0.9);
  assert.equal(tuned.b, 0.25);
  assert.equal(tuned.search("品質基準", 1)[0].document.id, "a");
});

test("Actual Buildを根拠単位に束ねてConflictとともに検索する", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fragarach-actual-"));
  const writeJsonl = (name, rows) =>
    fs.writeFileSync(
      path.join(directory, name),
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    );
  fs.writeFileSync(
    path.join(directory, "build-manifest.json"),
    JSON.stringify({ intent_id: "design-review" }),
  );
  fs.writeFileSync(
    path.join(directory, "provenance.json"),
    JSON.stringify({
      authority_precedence: ["corporate_standard", "guidance"],
    }),
  );
  writeJsonl("evidence.jsonl", [
    {
      source_id: "src",
      evidence_id: "ev",
      source_path: "policy.md",
      source_aliases: ["copies/policy-copy.md"],
      heading_path: ["承認"],
      text: "承認が必要",
      authority: "corporate_standard",
    },
    {
      source_id: "src",
      evidence_id: "ev-unclaimed",
      source_path: "supplement.md",
      heading_path: ["補足"],
      text: "申請フォームを使う",
      authority: "guidance",
    },
  ]);
  writeJsonl("claims.jsonl", [
    {
      id: "claim",
      subject: "変更",
      predicate: "requires",
      object: "承認",
      evidence: [{ source_id: "src", evidence_id: "ev" }],
    },
  ]);
  writeJsonl("conflicts.jsonl", [
    {
      id: "conflict",
      kind: "semantic",
      status: "unresolved",
      claim_ids: ["claim"],
      diagnostic_id: "diagnostic",
    },
  ]);
  writeJsonl("diagnostics.jsonl", [
    { id: "diagnostic", message: "判断できません", reason: "根拠不足" },
    {
      id: "missing-owner",
      code: "FRG-CST-MISSING-OWNER",
      message: "担当者がありません",
      reason: "原文に記載がありません",
      evidence_ids: ["ev"],
    },
  ]);
  writeJsonl("relation-dossiers.jsonl", [
    {
      id: "dossier:design-review:relation",
      intent_id: "design-review",
      relation_id: "relation",
      kind: "conflicts_with",
      source_id: "src",
      target_id: "src-2",
      evidence: [{ source_id: "src", evidence_id: "ev" }],
      text: "種別: Relation Dossier\n変更規程と案内が矛盾する",
    },
  ]);

  const actual = buildActualChunks([directory]);
  assert.equal(actual.length, 3);
  assert(
    actual.some(
      (chunk) =>
        chunk.text.includes("種別: Compiled Retrieval Unit") &&
        chunk.text.includes("根拠本文: 承認が必要"),
    ),
  );
  assert(actual.some((chunk) => chunk.text.includes("判断できません")));
  assert.equal(actual[0].evidence[0].source, "sources/policy.md");
  assert.equal(actual[0].evidence[1].source, "sources/copies/policy-copy.md");
  assert.equal(actual[0].intent_id, "design-review");
  assert(actual[0].text.includes("権威優先順位: 1"));
  assert.equal(actual[0].score_boost, 1.1);

  const withRelationDossier = buildActualChunks([directory], {
    includeRelationDossiers: true,
  });
  assert.equal(withRelationDossier.length, 4);
  assert(
    withRelationDossier.some(
      (chunk) =>
        chunk.unit_type === "conflict" &&
        chunk.text.includes("種別: Relation Dossier"),
    ),
  );

  writeJsonl("document-profiles.jsonl", [
    { source_id: "src", document_id: "POL-1", revision: "2" },
    { source_id: "src-2", document_id: "FAQ-1", revision: "1" },
  ]);
  writeJsonl("document-relations.jsonl", [
    {
      id: "relation",
      position: "unresolved",
      kind: "conflicts_with",
      source_id: "src",
      target_id: "src-2",
      scope: {},
      evidence: [{ source_id: "src", evidence_id: "ev" }],
    },
    {
      id: "relation-implementation",
      position: "non_effective",
      kind: "implements_decision",
      source_id: "src-2",
      target_id: "src",
      scope: {},
      evidence: [{ source_id: "src", evidence_id: "ev" }],
    },
  ]);
  writeJsonl("decision-packets.jsonl", [
    {
      id: "packet:design-review:relation",
      intent_id: "design-review",
      purpose: {
        kind: "decision",
        relation_ids: ["relation", "relation-implementation"],
      },
      materials: [
        { source_id: "src", role: "contender", evidence_ids: ["ev"] },
        { source_id: "src-2", role: "contender" },
      ],
    },
  ]);
  const withDecisionPacket = buildActualChunks([directory], {
    includeDecisionPackets: true,
  });
  const compactPacket = withDecisionPacket.find((chunk) =>
    chunk.id.startsWith("actual:decision-packet:"));
  assert(compactPacket);
  assert.equal(compactPacket.relation.position, "unresolved");
  assert.equal(
    withDecisionPacket.filter((chunk) => chunk.id.startsWith("actual:decision-packet:")).length,
    1,
  );
  assert.deepEqual(
    compactPacket.relations.map((relation) => relation.id),
    ["relation", "relation-implementation"],
  );
  assert.deepEqual(compactPacket.relation.contender_source_ids, ["src", "src-2"]);
  assert(compactPacket.text.includes("変更側: POL-1 revision 2"));
  assert(compactPacket.text.includes("位置づけ: Unresolved"));
  assert(compactPacket.text.includes("詳細関係: src-2 implements_decision src"));
  assert(!compactPacket.text.includes("/ contender]"));
  assert.equal(compactPacket.text.match(/承認が必要/g)?.length, 1);

  const fallback = buildActualChunks([directory], {
    evidenceFallback: true,
  });
  assert.equal(fallback.length, 4);
  assert(
    fallback.some(
      (chunk) =>
        chunk.id.includes("ev-unclaimed") &&
        chunk.text.includes("根拠本文: 申請フォームを使う"),
    ),
  );

  const withoutAuthorityBoost = buildActualChunks([directory], {
    authorityBoost: false,
  });
  assert.equal(withoutAuthorityBoost[0].score_boost, 1);

  const withoutConflicts = buildActualChunks([directory], {
    includeConflicts: false,
  });
  assert.equal(withoutConflicts.length, 2);

  const evidenceOnly = buildActualChunks([directory], {
    evidenceFallback: true,
    includeClaims: false,
  });
  assert(!evidenceOnly[0].text.includes("Claim 1"));

  const withDiagnosticAliases = buildActualChunks([directory], {
    includeDiagnosticAliases: true,
  });
  const missingInformation = withDiagnosticAliases.find((chunk) =>
    chunk.id.includes("missing-owner"),
  );
  assert.equal(missingInformation.evidence.length, 2);
  assert.equal(
    missingInformation.evidence[1].source,
    "sources/copies/policy-copy.md",
  );
});

test("Actual比較の共通チャンクは部門全体と利用目的を分ける", () => {
  const chunks = [
    { id: "g", domain_id: "manufacturing-product-design", purpose: "governance" },
    { id: "t", domain_id: "manufacturing-product-design", purpose: "technical_spec" },
    { id: "x", domain_id: "software-sre", purpose: "governance" },
  ];
  const selected = selectCanonicalRawChunks(chunks, "manufacturing-product-design", "governance");
  assert.deepEqual(selected.department.map((chunk) => chunk.id), ["g", "t"]);
  assert.deepEqual(selected.purpose.map((chunk) => chunk.id), ["g"]);
  assert.ok(selected.department.every((chunk) => chunk.intent_id === "governance"));
});

test("BM25は関連する規則を上位へ返す", () => {
  const documents = [
    {
      id: "unrelated",
      text: "勤怠申請と休暇の手続",
      evidence: [],
    },
    {
      id: "review",
      text: "外部仕様を変更する場合は設計レビューが必要",
      evidence: [],
    },
  ];
  const result = new Bm25Index(documents).search(
    "外部仕様の変更にはレビューが必要ですか",
    1,
  );
  assert.equal(result[0].document.id, "review");
});

test("Actual Buildの検索単位を対象日時で絞り込む", () => {
  assert(
    documentMatchesAsOf(
      { valid_from: "2025-07-01", valid_to: "2026-03-31" },
      "2025-12-15",
    ),
  );
  assert(
    !documentMatchesAsOf(
      { valid_from: "2026-04-01" },
      "2025-12-15",
    ),
  );
  assert(
    !documentMatchesAsOf(
      {
        validity_ranges: [
          { valid_from: "2025-07-01", valid_to: "2026-03-31" },
          { valid_from: "2026-04-01" },
        ],
      },
      "2025-12-15",
    ),
  );
});

test("Oracle知識はClaimとConflictを検索単位にする", () => {
  const raw = [
    {
      id: "raw:1",
      source: "sources/policy.md",
      section: "承認",
      evidence: [{ source: "sources/policy.md", section: "承認" }],
      text: "高リスク変更の承認",
    },
  ];
  const expected = {
    expected_claims: [
      {
        id: "claim-1",
        subject: "高リスク変更",
        predicate: "requires",
        object: "承認",
        evidence: { source: "sources/policy.md", section: "承認" },
      },
    ],
    expected_conflicts: [
      {
        id: "conflict-1",
        topic: "承認者",
        type: "authority_conflict",
        resolution: "正式規程を優先する",
        sources: ["sources/policy.md"],
      },
    ],
    event_sequences: [
      {
        id: "sequence-1",
        topic: "承認規則の変更",
        events: [
          {
            date: "2026-01-01",
            state: "effective",
            value: "正式規程を適用",
            source: "sources/policy.md",
            section: "承認",
          },
        ],
      },
    ],
  };

  const oracle = buildOracleChunks(expected, raw);
  assert.equal(oracle.length, 3);
  assert(oracle.some((chunk) => chunk.text.includes("種別: Claim")));
  assert(oracle.some((chunk) => chunk.text.includes("種別: Conflict")));
  assert(oracle.some((chunk) => chunk.text.includes("種別: Event Sequence")));
});

test("追加GoldをOracleのClaim、Conflict、Alias、Versionへ変換する", () => {
  const raw = [
    {
      id: "raw:policy",
      source: "sources/policy.md",
      section: "現行規則",
      evidence: [{ source: "sources/policy.md", section: "現行規則" }],
      text: "監査ログは二年間保管する",
    },
    {
      id: "raw:faq",
      source: "sources/faq.md",
      section: "案内",
      evidence: [{ source: "sources/faq.md", section: "案内" }],
      text: "監査ログは一年間保管する",
    },
  ];
  const gold = {
    answers: [{
      question_id: "M-1",
      required_answer_elements: ["二年間保管する"],
      expected_behavior: "answer_with_conflict_disclosure",
      gold_evidence: [{
        source: "sources/policy.md",
        section: "現行規則",
        content_terms: ["監査ログ", "二年間"],
      }],
    }],
    conflicts: [{
      conflict_id: "CF-1",
      topic: "監査ログ",
      status: "resolved",
      canonical_value: "二年間",
      conflicting_value: "一年間",
      sources: ["sources/policy.md", "sources/faq.md"],
    }],
    aliases: [{
      alias_id: "AL-1",
      canonical: "Atlas",
      aliases: ["Atlasポータル"],
      owner: "業務システム管理者",
      evidence: "sources/policy.md",
    }],
    versions: [{
      series_id: "V-1",
      topic: "監査ログ",
      current: "CUR",
      superseded: ["OLD"],
      source: "sources/policy.md",
    }],
  };

  const oracle = buildOracleChunks({}, raw, gold);
  assert.equal(oracle.length, 4);
  assert(oracle.some((chunk) => chunk.text.includes("種別: Gold Claim Bundle")));
  assert(oracle.some((chunk) => chunk.text.includes("種別: Gold Conflict")));
  assert(oracle.some((chunk) => chunk.text.includes("種別: Gold Alias")));
  assert(oracle.some((chunk) => chunk.text.includes("種別: Gold Version Group")));
});

test("追加Goldにない既存質問もOracle回答単位へ補完する", () => {
  const questions = [{
    id: "DR-001",
    intent_id: "design-review",
    question: "レビューは必要ですか",
    as_of: "2026-01-01",
    expected_answer_elements: ["必要"],
    forbidden_answer_elements: ["不要"],
    expected_behavior: "answer",
    required_evidence: [{
      source: "sources/review.md",
      section: "規則",
    }],
  }];
  const completed = completeGoldAnswers(questions, []);
  assert.equal(completed.length, 1);
  assert.equal(completed[0].question_id, "DR-001");
  assert.deepEqual(completed[0].required_answer_elements, ["必要"]);
  assert.deepEqual(completed[0].gold_evidence, questions[0].required_evidence);
});

test("追加Goldから質問別の矛盾両側と正規根拠を補完する", () => {
  const questions = [{
    id: "M-PL-001",
    expected_behavior: "answer_with_conflict_disclosure",
    required_evidence: [
      { source: "sources/policy.md", section: "現行規則" },
      { source: "sources/faq.md", section: "案内" },
    ],
  }];
  const answers = [{
    question_id: "M-PL-001",
    canonical_citation: "sources/policy.md",
    gold_evidence: questions[0].required_evidence,
  }];
  const conflicts = [{
    conflict_id: "CF-1",
    status: "resolved_by_authority_and_time",
    sources: ["sources/policy.md", "sources/faq.md"],
  }];

  const enriched = enrichQuestionsWithConflictGold(
    questions,
    answers,
    conflicts,
  );

  assert.deepEqual(enriched[0].conflict_evidence.canonical, [
    questions[0].required_evidence[0],
  ]);
  assert.deepEqual(enriched[0].conflict_evidence.conflicting, [
    questions[0].required_evidence[1],
  ]);
  assert.equal(enriched[0].conflict_evidence.conflict_id, "CF-1");
});

test("コーパスにGoldがない場合は空の集合として読む", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fragarach-gold-"));
  assert.deepEqual(readCorpusGold(directory), {
    answers: [],
    conflicts: [],
    aliases: [],
    versions: [],
    duplicates: [],
  });
});

test("検索専用評価を既存、追加、Intent、Tag別に集計する", () => {
  const questions = [
    {
      id: "DR-001",
      intent_id: "design-review",
      tags: ["authority"],
      required_evidence: [{
        source: "sources/review.md",
        section: "規則",
      }],
    },
    {
      id: "M-PL-001",
      intent_id: "compliance-audit",
      tags: ["authority", "conflict"],
      required_evidence: [{
        source: "sources/policy.md",
        section: "現行規則",
      }],
    },
  ];
  const retrieval = new Map([
    ["DR-001", [{
      document: {
        text: "設計レビュー",
        evidence: [{ source: "sources/review.md", section: "規則" }],
      },
    }]],
    ["M-PL-001", []],
  ]);

  const score = scoreRetrieval(questions, retrieval, [1, 5]);
  assert.equal(score.recall_at_k["1"], 0.5);
  assert.equal(score.complete_at_k["1"], 0.5);
  assert.equal(score.precision_at_k["1"], 0.5);
  assert.equal(score.by_cohort.legacy16.recall_at_k["5"], 1);
  assert.equal(score.by_cohort.added84.recall_at_k["5"], 0);
  assert.equal(score.by_intent["design-review"].questions, 1);
  assert.equal(score.by_tag.authority.questions, 2);
});

test("検索評価は矛盾、不要単位、解決順位をR@kから分離する", () => {
  const canonical = {
    source: "sources/policy.md",
    section: "現行規則",
    content_terms: ["二年間"],
  };
  const conflicting = {
    source: "sources/faq.md",
    section: "案内",
    content_terms: ["一年間"],
  };
  const question = {
    id: "M-PL-001",
    intent_id: "compliance-audit",
    tags: ["conflict"],
    required_evidence: [canonical, conflicting],
    conflict_evidence: {
      resolution: "canonical_preferred",
      canonical: [canonical],
      conflicting: [conflicting],
    },
  };
  const retrieval = new Map([[
    question.id,
    [
      {
        document: {
          id: "canonical",
          unit_type: "claim_evidence",
          text: "監査ログは二年間保管する",
          evidence: [{
            source: canonical.source,
            section: canonical.section,
          }],
        },
      },
      {
        document: {
          id: "conflict-unit",
          unit_type: "conflict",
          text: "二年間と一年間が競合する",
          evidence: [
            { source: canonical.source, section: canonical.section },
            { source: conflicting.source, section: conflicting.section },
          ],
        },
      },
      {
        document: {
          id: "distractor",
          text: "勤怠申請",
          evidence: [{
            source: "sources/attendance.md",
            section: "申請",
          }],
        },
      },
      {
        document: {
          id: "conflicting",
          unit_type: "claim_evidence",
          text: "監査ログは一年間保管する",
          evidence: [{
            source: conflicting.source,
            section: conflicting.section,
          }],
        },
      },
    ],
  ]]);

  const score = scoreRetrieval(
    [question],
    retrieval,
    [2, 4],
    { supportsConflictUnits: true },
  );

  assert.equal(score.conflict_recall_at_k["2"], 1);
  assert.equal(score.complete_at_k["2"], 1);
  assert.equal(score.precision_at_k["2"], 1);
  assert.equal(score.conflict_complete_rate_at_k["2"], 1);
  assert.equal(score.conflict_unit_recall_at_k["2"], 1);
  assert.equal(score.resolution_accuracy_at_k["2"], null);
  assert.equal(score.resolution_coverage_at_k["2"], 0);
  assert.equal(score.resolution_accuracy_at_k["4"], 1);
  assert.equal(score.resolution_coverage_at_k["4"], 1);
  assert.equal(score.distractor_rate_at_k["4"], 0.25);
  assert.equal(score.precision_at_k["4"], 0.5);
});

test("Compile Coverageは順位に依存せずKnowledge Build内のGold根拠を測る", () => {
  const questions = [
    {
      id: "DR-001",
      intent_id: "design-review",
      tags: ["authority"],
      required_evidence: [
        {
          source: "sources/review.md",
          section: "規則",
          content_terms: ["外部仕様", "設計レビュー"],
        },
        {
          source: "sources/review.md",
          section: "期限",
          content_terms: ["二営業日"],
        },
      ],
    },
  ];
  const documents = [
    {
      text: "外部仕様の変更には設計レビューが必要",
      evidence: [{ source: "sources/review.md", section: "規則" }],
    },
    {
      text: "無関係な補足",
      evidence: [{ source: "sources/review.md", section: "期限" }],
    },
  ];

  const score = scoreCompileCoverage(questions, documents);

  assert.equal(score.compile_coverage, 0.5);
  assert.equal(score.by_cohort.legacy16.compile_coverage, 0.5);
  assert.equal(score.by_intent["design-review"].compile_coverage, 0.5);
  assert.equal(score.questions_detail[0].matched_required_evidence.length, 1);
  assert.equal(score.questions_detail[0].missing_required_evidence.length, 1);
});
