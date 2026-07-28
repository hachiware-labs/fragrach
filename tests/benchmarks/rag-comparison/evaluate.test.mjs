import test from "node:test";
import assert from "node:assert/strict";

import { scoreRun } from "./evaluate.mjs";

const questions = [
  {
    id: "Q-1",
    intent_id: "intent-a",
    expected_behavior: "answer",
    expected_answer_elements: ["要素A", "要素B"],
    forbidden_answer_elements: ["誤答A"],
    required_evidence: [{ source: "sources/policy.md", section: "規則" }],
    tags: ["authority"],
  },
  {
    id: "Q-2",
    intent_id: "intent-b",
    expected_behavior: "insufficient_information",
    expected_answer_elements: ["担当者の記載がない"],
    forbidden_answer_elements: ["担当者は運用部"],
    required_evidence: [{ source: "sources/checklist.md", section: "確認" }],
    tags: ["missing-owner"],
  },
];

test("すべての条件を満たす結果はStrict Passになる", () => {
  const results = [
    {
      question_id: "Q-1",
      answer: "回答1",
      retrieved_evidence: [
        { source: "sources/policy.md", section: "規則", rank: 1 },
      ],
      citations: [{ source: "sources/policy.md", section: "規則" }],
      behavior: "answer",
      judgment: {
        satisfied_answer_elements: ["要素A", "要素B"],
        present_forbidden_answer_elements: [],
        unsupported_citations: [],
      },
      usage: { input_tokens: 100, output_tokens: 20, latency_ms: 500 },
    },
    {
      question_id: "Q-2",
      answer: "回答2",
      retrieved_evidence: [
        { source: "sources/checklist.md", section: "確認", rank: 2 },
      ],
      citations: [{ source: "sources/checklist.md", section: "確認" }],
      behavior: "insufficient_information",
      judgment: {
        satisfied_answer_elements: ["担当者の記載がない"],
        present_forbidden_answer_elements: [],
        unsupported_citations: [],
      },
      usage: { input_tokens: 120, output_tokens: 30, latency_ms: 700 },
    },
  ];

  const score = scoreRun(questions, results, { topK: 5, label: "pass" });

  assert.equal(score.metrics.strict_pass_rate, 1);
  assert.equal(score.metrics.evidence_recall_at_k, 1);
  assert.equal(score.metrics.citation_recall, 1);
  assert.equal(score.metrics.answer_element_recall, 1);
  assert.equal(score.metrics.behavior_accuracy, 1);
  assert.equal(score.metrics.forbidden_error_rate, 0);
  assert.equal(score.usage.total_input_tokens, 220);
  assert.equal(score.usage.average_latency_ms, 600);
});

test("欠落、誤答、検索順位超過を失敗として集計する", () => {
  const results = [
    {
      question_id: "Q-1",
      answer: "誤った回答",
      retrieved_evidence: [
        { source: "sources/policy.md", section: "規則", rank: 6 },
      ],
      citations: [],
      behavior: "answer_with_conflict_disclosure",
      judgment: {
        satisfied_answer_elements: ["要素A"],
        present_forbidden_answer_elements: ["誤答A"],
        unsupported_citations: [],
      },
    },
  ];

  const score = scoreRun(questions, results, { topK: 5, label: "fail" });

  assert.equal(score.results_present, 1);
  assert.equal(score.results_missing, 1);
  assert.equal(score.metrics.evidence_recall_at_k, 0);
  assert.equal(score.metrics.citation_recall, 0);
  assert.equal(score.metrics.answer_element_recall, 0.25);
  assert.equal(score.metrics.behavior_accuracy, 0);
  assert.equal(score.metrics.forbidden_error_rate, 0.5);
  assert.equal(score.metrics.strict_pass_rate, 0);
});

test("質問定義にない判定要素を拒否する", () => {
  const results = [
    {
      question_id: "Q-1",
      answer: "回答",
      retrieved_evidence: [],
      citations: [],
      behavior: "answer",
      judgment: {
        satisfied_answer_elements: ["存在しない要素"],
        present_forbidden_answer_elements: [],
        unsupported_citations: [],
      },
    },
  ];

  assert.throws(
    () => scoreRun(questions, results, { label: "invalid" }),
    /質問定義と一致しない値/,
  );
});

test("文書タイトルを含む見出しパスは末尾セクションで照合する", () => {
  const pathQuestions = [
    {
      id: "Q-PATH",
      intent_id: "intent-a",
      expected_behavior: "answer",
      expected_answer_elements: ["要素A"],
      forbidden_answer_elements: [],
      required_evidence: [
        {
          source: "sources/policy.md",
          section: "承認",
        },
      ],
      tags: ["evidence"],
    },
  ];
  const pathResults = [
    {
      question_id: "Q-PATH",
      answer: "要素A",
      retrieved_evidence: [
        {
          source: "sources/policy.md",
          section: "設計レビュー標準 / 承認",
          rank: 1,
        },
      ],
      citations: [
        {
          source: "sources/policy.md",
          section: "設計レビュー標準 / 承認",
        },
      ],
      behavior: "answer",
    },
  ];

  const report = scoreRun(pathQuestions, pathResults);
  assert.equal(report.metrics.evidence_recall_at_k, 1);
  assert.equal(report.metrics.citation_recall, 1);
});

test("本文条件がある根拠は同じ見出しの別段落を取得成功にしない", () => {
  const contentQuestions = [{
    id: "Q-CONTENT",
    intent_id: "intent-a",
    expected_behavior: "answer",
    expected_answer_elements: ["レビューが必要"],
    forbidden_answer_elements: [],
    required_evidence: [{
      source: "sources/policy.md",
      section: "レビュー",
      content_terms: ["外部仕様", "設計レビュー"],
    }],
    tags: ["evidence"],
  }];
  const result = {
    question_id: "Q-CONTENT",
    answer: "レビューが必要",
    citations: [{ source: "sources/policy.md", section: "レビュー" }],
    behavior: "answer",
  };
  const wrong = scoreRun(contentQuestions, [{
    ...result,
    retrieved_evidence: [{
      source: "sources/policy.md",
      section: "レビュー",
      rank: 1,
      retrieval_text: "誤字修正はレビューを省略できる",
    }],
  }]);
  const right = scoreRun(contentQuestions, [{
    ...result,
    retrieved_evidence: [{
      source: "sources/policy.md",
      section: "レビュー",
      rank: 1,
      retrieval_text: "外部仕様の変更には設計レビューが必要",
    }],
  }]);

  assert.equal(wrong.metrics.evidence_recall_at_k, 0);
  assert.equal(wrong.metrics.citation_recall, 1);
  assert.equal(right.metrics.evidence_recall_at_k, 1);
});
