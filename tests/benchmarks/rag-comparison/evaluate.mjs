#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultQuestionsPath = path.resolve(
  scriptDirectory,
  "../../corpora/aobane-industries-ja/evaluation/questions.jsonl",
);

function readJsonl(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  const rows = [];

  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) continue;

    try {
      rows.push(JSON.parse(line));
    } catch (error) {
      throw new Error(`${filePath}:${index + 1}: ${error.message}`);
    }
  }

  return rows;
}

function normalizeSource(source) {
  return String(source ?? "")
    .replaceAll("\\", "/")
    .replace(/^\.\//, "");
}

function validateUniqueIds(rows, field, label) {
  const seen = new Set();

  for (const row of rows) {
    const id = row[field];
    if (typeof id !== "string" || id.length === 0) {
      throw new Error(`${label}に${field}がない行があります`);
    }
    if (seen.has(id)) {
      throw new Error(`${label}に重複した${field}があります: ${id}`);
    }
    seen.add(id);
  }
}

function validateQuestions(questions) {
  validateUniqueIds(questions, "id", "質問");

  for (const question of questions) {
    for (const field of [
      "expected_answer_elements",
      "required_evidence",
      "forbidden_answer_elements",
      "tags",
    ]) {
      if (!Array.isArray(question[field])) {
        throw new Error(`質問${question.id}の${field}は配列である必要があります`);
      }
    }
    if (typeof question.expected_behavior !== "string") {
      throw new Error(`質問${question.id}にexpected_behaviorがありません`);
    }
  }
}

function validateResults(results, knownQuestionIds, label) {
  validateUniqueIds(results, "question_id", `${label}の結果`);

  for (const result of results) {
    if (!knownQuestionIds.has(result.question_id)) {
      throw new Error(`${label}に未知のquestion_idがあります: ${result.question_id}`);
    }
    if (typeof result.answer !== "string") {
      throw new Error(`${label}/${result.question_id}のanswerは文字列である必要があります`);
    }
    for (const field of ["retrieved_evidence", "citations"]) {
      if (!Array.isArray(result[field])) {
        throw new Error(`${label}/${result.question_id}の${field}は配列である必要があります`);
      }
    }
    if (typeof result.behavior !== "string") {
      throw new Error(`${label}/${result.question_id}にbehaviorがありません`);
    }
  }
}

function evidenceMatches(required, actual) {
  if (normalizeSource(required.source) !== normalizeSource(actual.source)) return false;
  if (!required.section) return true;
  const requiredSection = String(required.section).trim();
  const actualSection = String(actual.section ?? "").trim();
  return (
    requiredSection === actualSection ||
    actualSection.endsWith(` / ${requiredSection}`) ||
    requiredSection.endsWith(` / ${actualSection}`)
  );
}

function recall(requiredItems, actualItems) {
  if (requiredItems.length === 0) return 1;
  const matched = requiredItems.filter((required) =>
    actualItems.some((actual) => evidenceMatches(required, actual)),
  ).length;
  return matched / requiredItems.length;
}

function asSet(values) {
  return new Set(Array.isArray(values) ? values : []);
}

function assertJudgmentSubset(question, result, field, allowedValues) {
  const values = result.judgment?.[field];
  if (values === undefined) return;
  if (!Array.isArray(values)) {
    throw new Error(`${result.question_id}のjudgment.${field}は配列である必要があります`);
  }

  const allowed = new Set(allowedValues);
  for (const value of values) {
    if (!allowed.has(value)) {
      throw new Error(
        `${result.question_id}のjudgment.${field}に質問定義と一致しない値があります: ${value}`,
      );
    }
  }
}

function getJudgment(question, result) {
  assertJudgmentSubset(
    question,
    result,
    "satisfied_answer_elements",
    question.expected_answer_elements,
  );
  assertJudgmentSubset(
    question,
    result,
    "present_forbidden_answer_elements",
    question.forbidden_answer_elements,
  );

  if (result.judgment) {
    return {
      mode: "provided",
      satisfied: asSet(result.judgment.satisfied_answer_elements),
      forbidden: asSet(result.judgment.present_forbidden_answer_elements),
      unsupportedCitations: Array.isArray(result.judgment.unsupported_citations)
        ? result.judgment.unsupported_citations
        : [],
    };
  }

  return {
    mode: "deterministic_substring",
    satisfied: new Set(
      question.expected_answer_elements.filter((element) => result.answer.includes(element)),
    ),
    forbidden: new Set(
      question.forbidden_answer_elements.filter((element) => result.answer.includes(element)),
    ),
    unsupportedCitations: [],
  };
}

function mean(values) {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function buildBreakdown(questionScores, key) {
  const groups = new Map();

  for (const score of questionScores) {
    const values = key === "intent" ? [score.intent_id] : score.tags;
    for (const value of values) {
      if (!groups.has(value)) groups.set(value, []);
      groups.get(value).push(score);
    }
  }

  return Object.fromEntries(
    [...groups.entries()]
      .sort(([left], [right]) => left.localeCompare(right, "ja"))
      .map(([value, scores]) => [
        value,
        {
          questions: scores.length,
          strict_pass_rate: mean(scores.map((score) => Number(score.strict_pass))),
        },
      ]),
  );
}

export function scoreRun(questions, results, options = {}) {
  const topK = options.topK ?? 5;
  if (!Number.isInteger(topK) || topK < 1) {
    throw new Error("topKは1以上の整数である必要があります");
  }

  validateQuestions(questions);
  const knownQuestionIds = new Set(questions.map((question) => question.id));
  validateResults(results, knownQuestionIds, options.label ?? "run");
  const resultByQuestion = new Map(results.map((result) => [result.question_id, result]));
  const questionScores = [];

  for (const question of questions) {
    const result = resultByQuestion.get(question.id);
    if (!result) {
      questionScores.push({
        question_id: question.id,
        intent_id: question.intent_id,
        tags: question.tags,
        missing: true,
        evidence_recall_at_k: 0,
        citation_recall: 0,
        answer_element_recall: 0,
        behavior_pass: false,
        forbidden_error: false,
        unsupported_citation_error: false,
        strict_pass: false,
        judgment_mode: "missing",
      });
      continue;
    }

    const retrieved = result.retrieved_evidence
      .map((item, index) => ({ ...item, rank: item.rank ?? index + 1 }))
      .filter((item) => item.rank <= topK);
    const judgment = getJudgment(question, result);
    const answerElementRecall =
      question.expected_answer_elements.length === 0
        ? 1
        : judgment.satisfied.size / question.expected_answer_elements.length;
    const evidenceRecall = recall(question.required_evidence, retrieved);
    const citationRecall = recall(question.required_evidence, result.citations);
    const behaviorPass = result.behavior === question.expected_behavior;
    const forbiddenError = judgment.forbidden.size > 0;
    const unsupportedCitationError = judgment.unsupportedCitations.length > 0;
    const strictPass =
      evidenceRecall === 1 &&
      citationRecall === 1 &&
      answerElementRecall === 1 &&
      behaviorPass &&
      !forbiddenError &&
      !unsupportedCitationError;

    questionScores.push({
      question_id: question.id,
      intent_id: question.intent_id,
      tags: question.tags,
      missing: false,
      evidence_recall_at_k: evidenceRecall,
      citation_recall: citationRecall,
      answer_element_recall: answerElementRecall,
      behavior_pass: behaviorPass,
      forbidden_error: forbiddenError,
      unsupported_citation_error: unsupportedCitationError,
      strict_pass: strictPass,
      judgment_mode: judgment.mode,
      usage: result.usage ?? null,
    });
  }

  const presentScores = questionScores.filter((score) => !score.missing);
  const inputTokens = presentScores
    .map((score) => score.usage?.input_tokens)
    .filter(Number.isFinite);
  const outputTokens = presentScores
    .map((score) => score.usage?.output_tokens)
    .filter(Number.isFinite);
  const latency = presentScores
    .map((score) => score.usage?.latency_ms)
    .filter(Number.isFinite);

  return {
    top_k: topK,
    questions: questions.length,
    results_present: presentScores.length,
    results_missing: questions.length - presentScores.length,
    metrics: {
      evidence_recall_at_k: mean(questionScores.map((score) => score.evidence_recall_at_k)),
      citation_recall: mean(questionScores.map((score) => score.citation_recall)),
      answer_element_recall: mean(questionScores.map((score) => score.answer_element_recall)),
      behavior_accuracy: mean(questionScores.map((score) => Number(score.behavior_pass))),
      forbidden_error_rate: mean(questionScores.map((score) => Number(score.forbidden_error))),
      unsupported_citation_error_rate: mean(
        questionScores.map((score) => Number(score.unsupported_citation_error)),
      ),
      strict_pass_rate: mean(questionScores.map((score) => Number(score.strict_pass))),
    },
    usage: {
      total_input_tokens: inputTokens.length
        ? inputTokens.reduce((sum, value) => sum + value, 0)
        : null,
      total_output_tokens: outputTokens.length
        ? outputTokens.reduce((sum, value) => sum + value, 0)
        : null,
      average_latency_ms: mean(latency),
    },
    by_intent: buildBreakdown(questionScores, "intent"),
    by_tag: buildBreakdown(questionScores, "tag"),
    questions_detail: questionScores,
  };
}

function parseArguments(argv) {
  const parsed = {
    questionsPath: defaultQuestionsPath,
    runs: [],
    topK: 5,
    jsonOut: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--questions") {
      parsed.questionsPath = path.resolve(argv[++index]);
    } else if (argument === "--run") {
      const value = argv[++index];
      const separator = value.indexOf("=");
      if (separator <= 0 || separator === value.length - 1) {
        throw new Error("--runはlabel=pathの形式で指定してください");
      }
      parsed.runs.push({
        label: value.slice(0, separator),
        filePath: path.resolve(value.slice(separator + 1)),
      });
    } else if (argument === "--top-k") {
      parsed.topK = Number.parseInt(argv[++index], 10);
    } else if (argument === "--json-out") {
      parsed.jsonOut = path.resolve(argv[++index]);
    } else if (argument === "--help" || argument === "-h") {
      parsed.help = true;
    } else {
      throw new Error(`未知の引数です: ${argument}`);
    }
  }

  return parsed;
}

function percentage(value) {
  return value === null ? "-" : `${(value * 100).toFixed(1)}%`;
}

function printReport(report) {
  const labels = Object.keys(report.runs);
  const header = [
    "run".padEnd(20),
    "present".padStart(8),
    "evidence".padStart(10),
    "citation".padStart(10),
    "elements".padStart(10),
    "behavior".padStart(10),
    "forbidden".padStart(11),
    "strict".padStart(10),
  ].join(" ");

  console.log(header);
  console.log("-".repeat(header.length));

  for (const label of labels) {
    const run = report.runs[label];
    console.log(
      [
        label.padEnd(20),
        `${run.results_present}/${run.questions}`.padStart(8),
        percentage(run.metrics.evidence_recall_at_k).padStart(10),
        percentage(run.metrics.citation_recall).padStart(10),
        percentage(run.metrics.answer_element_recall).padStart(10),
        percentage(run.metrics.behavior_accuracy).padStart(10),
        percentage(run.metrics.forbidden_error_rate).padStart(11),
        percentage(run.metrics.strict_pass_rate).padStart(10),
      ].join(" "),
    );
  }
}

function printHelp() {
  console.log(`Usage:
  node evaluate.mjs --run label=result.jsonl [--run label=result.jsonl ...]

Options:
  --questions <path>  質問JSONL。省略時は青羽精機コーパスを使用
  --run <label=path>  比較する結果。複数指定可能
  --top-k <number>    Evidence Recallの検索上限。既定値は5
  --json-out <path>   詳細なJSONレポートの保存先
  --help              この説明を表示`);
}

async function main() {
  const arguments_ = parseArguments(process.argv.slice(2));
  if (arguments_.help) {
    printHelp();
    return;
  }
  if (arguments_.runs.length === 0) {
    throw new Error("--runを一つ以上指定してください");
  }

  const questions = readJsonl(arguments_.questionsPath);
  const report = {
    schema_version: "0.1",
    questions_path: arguments_.questionsPath,
    generated_at: new Date().toISOString(),
    runs: {},
  };

  for (const run of arguments_.runs) {
    if (report.runs[run.label]) {
      throw new Error(`重複したrunラベルです: ${run.label}`);
    }
    report.runs[run.label] = scoreRun(questions, readJsonl(run.filePath), {
      topK: arguments_.topK,
      label: run.label,
    });
  }

  printReport(report);

  if (arguments_.jsonOut) {
    fs.mkdirSync(path.dirname(arguments_.jsonOut), { recursive: true });
    fs.writeFileSync(arguments_.jsonOut, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`\nJSON report: ${arguments_.jsonOut}`);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  });
}
