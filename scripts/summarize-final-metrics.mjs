#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), "..");

const defaultAnswerReport = path.join(
  repositoryRoot,
  "target/benchmarks/dynamic-validity-practical-variation-v2/answer-report.json",
);
const defaultQuestions = path.join(
  repositoryRoot,
  "tests/corpora/aobane-industries-ja-dynamic-validity-practical-variation/evaluation/questions.jsonl",
);
const defaultAnswersDirectory = path.join(
  repositoryRoot,
  "target/benchmarks/dynamic-validity-practical-variation-v2/answers",
);
const defaultOutputDirectory = path.join(
  repositoryRoot,
  "target/benchmarks/final-metrics-2026-08-09",
);
const defaultMarkdown = path.join(
  repositoryRoot,
  "docs/evaluations/final-metrics-2026-08-09_ja.md",
);
const defaultEnterpriseFragrach500Report = path.join(
  repositoryRoot,
  "target/benchmarks/enterprise-rag-fragrach-500/r0-bm25-pipeline-v1/report.json",
);

const conditionFiles = {
  "Raw-BM25": "raw-bm25-t1.jsonl",
  "Raw-Ruri-Dense": "raw-ruri-dense-t1.jsonl",
  "Raw-Fixed-Hybrid": "raw-fixed-hybrid-t1.jsonl",
  "Fragrach-Ruri-Packet": "fragrach-ruri-packet-t1.jsonl",
  "Fragrach-Fixed-Hybrid-Packet": "fragrach-fixed-hybrid-packet-t1.jsonl",
};

function parseArgs(argv) {
  const options = {
    answerReport: defaultAnswerReport,
    questions: defaultQuestions,
    answersDirectory: defaultAnswersDirectory,
    outputDirectory: defaultOutputDirectory,
    markdown: defaultMarkdown,
    enterpriseFragrach500Report: defaultEnterpriseFragrach500Report,
    iterations: 20_000,
    seed: 20_260_809,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--answer-report") options.answerReport = path.resolve(argv[++index]);
    else if (arg === "--questions") options.questions = path.resolve(argv[++index]);
    else if (arg === "--answers") options.answersDirectory = path.resolve(argv[++index]);
    else if (arg === "--output") options.outputDirectory = path.resolve(argv[++index]);
    else if (arg === "--markdown") options.markdown = path.resolve(argv[++index]);
    else if (arg === "--enterprise-fragrach-500-report") options.enterpriseFragrach500Report = path.resolve(argv[++index]);
    else if (arg === "--iterations") options.iterations = Number(argv[++index]);
    else if (arg === "--seed") options.seed = Number(argv[++index]);
    else if (arg === "--help") options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / (values.length || 1);
}

function percentile(values, probability) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const position = (ordered.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return ordered[lower];
  return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower);
}

export function wilsonInterval(successes, total, z = 1.959963984540054) {
  if (total === 0) return [null, null];
  const proportion = successes / total;
  const denominator = 1 + (z * z) / total;
  const center = (proportion + (z * z) / (2 * total)) / denominator;
  const margin = z * Math.sqrt(
    (proportion * (1 - proportion) + (z * z) / (4 * total)) / total,
  ) / denominator;
  const lower = Math.max(0, center - margin);
  const upper = Math.min(1, center + margin);
  return [lower < Number.EPSILON ? 0 : lower, upper];
}

function makeRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

export function bootstrapMeanInterval(values, iterations = 20_000, seed = 20_260_809) {
  const random = makeRandom(seed);
  const samples = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let total = 0;
    for (let index = 0; index < values.length; index += 1) {
      total += values[Math.floor(random() * values.length)];
    }
    samples.push(total / values.length);
  }
  return [percentile(samples, 0.025), percentile(samples, 0.975)];
}

export function pairedBootstrapDifference(
  baseline,
  candidate,
  iterations = 20_000,
  seed = 20_260_809,
) {
  if (baseline.length !== candidate.length || baseline.length === 0) {
    throw new Error("paired bootstrap requires non-empty arrays of the same length");
  }
  const differences = baseline.map((value, index) => candidate[index] - value);
  const interval = bootstrapMeanInterval(differences, iterations, seed);
  return { difference: mean(differences), ci95: interval };
}

function metricInterval(details, field) {
  const values = details.map((row) => Number(row[field]));
  const successes = values.reduce((sum, value) => sum + value, 0);
  if (values.every((value) => value === 0 || value === 1)) {
    return wilsonInterval(successes, values.length);
  }
  return bootstrapMeanInterval(values);
}

function conditionSummary(condition) {
  const { metrics, details } = condition.evaluation;
  const answerCorrect = details.filter((row) => row.answer_correct).length;
  const dvaaPass = details.filter((row) => row.dvaa_gross).length;
  return {
    questions: details.length,
    recall: metrics.recall_at_k,
    accuracy: metrics.answer_accuracy,
    dvaa: metrics.dvaa_gross,
    ci95: {
      recall: metricInterval(details, "recall_at_k"),
      accuracy: metricInterval(details, "answer_correct"),
      dvaa: metricInterval(details, "dvaa_gross"),
    },
    counts: {
      accuracy: answerCorrect,
      dvaa: dvaaPass,
    },
  };
}

export function enterpriseFragrach500Summary(source) {
  const atFive = source.overall?.at_k?.["5"];
  const holdoutAtFive = source.by_legacy_split?.holdout?.at_k?.["5"];
  if (!atFive || !holdoutAtFive) {
    throw new Error("Enterprise Fragrach 500 report must contain overall and holdout metrics at k=5");
  }
  return {
    experiment: source.experiment,
    phase: source.phase,
    corpus_documents: source.retrieval_contract?.corpus_documents,
    chunks: source.retrieval_contract?.chunks,
    top_k: 5,
    selected: {
      questions: source.question_counts?.selected,
      recall: atFive.document_recall,
      accuracy: null,
      dvaa: null,
    },
    holdout: {
      questions: source.by_legacy_split?.holdout?.questions,
      recall: holdoutAtFive.document_recall,
      accuracy: null,
      dvaa: null,
    },
    split_counts: source.question_counts?.by_legacy_split,
    answer_evaluation_status: "not_measured",
  };
}

function pairedComparison(answerReport, baselineName, candidateName, iterations, seed) {
  const baseline = answerReport.conditions[baselineName].evaluation.details;
  const candidateById = new Map(
    answerReport.conditions[candidateName].evaluation.details.map((row) => [row.question_id, row]),
  );
  const alignedCandidate = baseline.map((row) => candidateById.get(row.question_id));
  const fields = {
    recall: "recall_at_k",
    accuracy: "answer_correct",
    dvaa: "dvaa_gross",
  };
  const metrics = {};
  let offset = 0;
  for (const [name, field] of Object.entries(fields)) {
    const baselineValues = baseline.map((row) => Number(row[field]));
    const candidateValues = alignedCandidate.map((row) => Number(row[field]));
    metrics[name] = pairedBootstrapDifference(
      baselineValues,
      candidateValues,
      iterations,
      seed + offset,
    );
    offset += 1;
  }
  return { baseline: baselineName, candidate: candidateName, questions: baseline.length, metrics };
}

function pct(value, digits = 1) {
  return value === null || value === undefined ? "—" : `${(value * 100).toFixed(digits)}%`;
}

function pp(value, digits = 1) {
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(digits)} pt`;
}

function intervalText(interval, digits = 1) {
  if (interval[0] === null) return "—";
  return `${(interval[0] * 100).toFixed(digits)}–${(interval[1] * 100).toFixed(digits)} pt`;
}

function markdown(report) {
  const conditionRows = Object.entries(report.dynamic_validity.conditions).map(([name, value]) =>
    `| ${name} | ${pct(value.recall, 2)} | ${pct(value.accuracy, 2)} (${value.counts.accuracy}/${value.questions}) | ${pct(value.dvaa, 2)} (${value.counts.dvaa}/${value.questions}) |`,
  ).join("\n");
  const dense = report.dynamic_validity.paired_comparisons.ruri;
  const hybrid = report.dynamic_validity.paired_comparisons.fixed_hybrid;
  const metricLabels = { recall: "Recall", accuracy: "Accuracy", dvaa: "DVAA" };
  const comparisonRows = [dense, hybrid].flatMap((comparison) => Object.entries(comparison.metrics).map(
    ([metric, value]) => `| ${comparison.candidate} − ${comparison.baseline} | ${metricLabels[metric]} | ${pp(value.difference, 2)} | ${intervalText(value.ci95, 2)} |`,
  )).join("\n");
  const enterprise500 = report.enterprise_fragrach_500;
  return `# Fragrach 精度評価 最終版（2026-08-09）

## 結論

凍結済みの実践holdout 200問では、同じRuri Denseを入口にしたRaw RAGからFragrach Packetへ替えると、Recallは${pct(report.dynamic_validity.conditions["Raw-Ruri-Dense"].recall, 2)}から${pct(report.dynamic_validity.conditions["Fragrach-Ruri-Packet"].recall, 2)}、Accuracyは${pct(report.dynamic_validity.conditions["Raw-Ruri-Dense"].accuracy, 2)}から${pct(report.dynamic_validity.conditions["Fragrach-Ruri-Packet"].accuracy, 2)}、DVAAは${pct(report.dynamic_validity.conditions["Raw-Ruri-Dense"].dvaa, 2)}から${pct(report.dynamic_validity.conditions["Fragrach-Ruri-Packet"].dvaa, 2)}になった。DVAAの改善幅は${pp(dense.metrics.dvaa.difference, 1)}、質問単位bootstrapの95%信頼区間は${intervalText(dense.metrics.dvaa.ci95, 1)}である。併せて、私たちが選定したEnterprise Fragrach 500の61問ではRecall@5が${pct(enterprise500.selected.recall, 2)}、うちholdout 21問では${pct(enterprise500.holdout.recall, 2)}だった。

## 3つの指標の読み方

| 指標 | 指標の説明 | 算出方法 | 数値の読み方 |
|---|---|---|---|
| Recall@5 | 正答に必要な文書を、検索上位5件までにどれだけ取得できたかを測る | 各質問について、事前指定した正解根拠文書（Gold文書）のうち取得できた割合を求め、全質問で平均する | 高いほど必要文書の検索漏れが少ない。ただし、最終回答が正しいことは保証しない |
| Accuracy | 最終回答の値または判断が、事前に定めた正解（Gold）と一致したかを測る | 各質問を正答なら1、誤答なら0とし、全質問に占める正答の割合を求める | 高いほど正答が多い。ただし、使った根拠が有効か、必要な根拠が揃ったかは分からない |
| DVAA@5 | 最終回答が正しく、かつ、その回答を現在の質問に使える完全な根拠で支えられたかを測る | 正答、必要根拠の完備、根拠の時点・対象範囲・承認状態・発行主体・文書関係の条件をすべて満たした質問を1とし、全質問に占める割合を求める | 高いほど「正しい答えを、有効で不足のない根拠に基づいて出せた」質問が多い。どれか一条件でも欠ければ0になる |

### DVAAの定義

DVAA（Dynamic Validity-Aware Accuracy）は、正答だけでは合格にならない。評価対象の質問集合を \\(Q\\) とし、各質問 \\(q\\) について次の二値変数を定義する。

| 記号 | 1になる条件 |
|---|---|
| \\(C(q)\\) | 回答値または判断が、事前に定めた正解と一致する |
| \\(G_k(q)\\) | 検証に必要と事前定義した根拠単位が、検索上位\\(k\\)件の回答資料にすべて揃う |
| \\(T(q)\\) | 採用根拠が質問時点で有効である |
| \\(S(q)\\) | 採用根拠の対象範囲が質問対象と一致する |
| \\(P(q)\\) | 採用根拠の承認・状態・手続きが判断用途に適合する |
| \\(A(q)\\) | 採用根拠の発行主体、正本性、文書の役割が判断用途に適合する |
| \\(R(q)\\) | 必要な基本規則、追補、例外、実施記録が揃い、文書間の優先・変更・実施関係が正しく、禁止根拠を結論に採用していない |

根拠の有効性 \\(V(q)\\) とDVAA@\\(k\\)を次で定義する。

\\[
V(q)=T(q)\\,S(q)\\,P(q)\\,A(q)\\,R(q)
\\]

\\[
\\operatorname{DVAA}@k
=
\\frac{1}{|Q|}
\\sum_{q \\in Q}
C(q)\\,G_k(q)\\,V(q)
\\]

各変数は0または1である。したがって、正答、完全根拠、根拠の有効性のどれか一つでも満たさなければ、その質問のDVAAは0になる。本資料では \\(k=5\\) とし、完全根拠が揃った質問だけでなく全質問を分母にする。

3指標の違いは、次の例で読める。

| 例 | Recall | Accuracy | DVAA | 理由 |
|---|---:|---:|---:|---|
| 必要な現行文書はtop-5にあるが、回答では失効済み文書を根拠に同じ数値を答えた | 100% | 100% | 0% | 答えは合っていても、採用根拠が時間条件を満たさない |
| 必要文書の半分しか届いていないが、モデルが正答を推測した | 50% | 100% | 0% | 検証に必要な根拠が揃っていない |
| 現行の基本規則と適用対象の例外が揃い、両者の関係に従って正答した | 100% | 100% | 100% | 正答と有効・完全な根拠が両立している |

## 主評価: practical_holdout

対象は未見100系列から作った200問である。T1コーパス1,988文書、Ruri 512 token・overlap 64の34,875 chunk、candidate 1,000、top-k 5、Packet最大3件、Readerはgpt-5.6-luna / reasoning lowに固定した。回答は保存済みの5条件×200件を再利用し、同じ採点契約で集計した。

| 条件 | Recall@5 | Accuracy | DVAA |
|---|---:|---:|---:|
${conditionRows}

Raw Ruri Denseは157問で正答したが、有効かつ完全な根拠で支えた正答は0問だった。Fragrach Ruri Packetは197問で正答し、そのうち192問がDVAAを通過した。Recallの改善は${pp(dense.metrics.recall.difference, 2)}、Accuracyは${pp(dense.metrics.accuracy.difference, 2)}、DVAAは${pp(dense.metrics.dvaa.difference, 2)}である。つまり主な効果は、関連文書を一件見つけることより、現行版、例外、実施記録、台帳を一つの検証可能な回答資料として揃え、正答を有効な根拠へ結び付けたことにある。

### 対応あり差分と95%信頼区間

同じ200問を質問単位で20,000回再標本化したpercentile bootstrapを用いた。ここでも表示するのは3指標だけである。

| 比較 | 指標 | 差 | 95% CI |
|---|---|---:|---:|
${comparisonRows}

固定Hybridでも、Packet化によりRecallは${pp(hybrid.metrics.recall.difference, 2)}、Accuracyは${pp(hybrid.metrics.accuracy.difference, 2)}、DVAAは${pp(hybrid.metrics.dvaa.difference, 2)}改善した。RetrieverをRuri Denseに固定した比較と方向が一致している。

## Enterprise Fragrach 500

私たちがEnterpriseRAG-Benchから選定したサブセットを、500文書・${enterprise500.chunks.toLocaleString("ja-JP")} chunkのR0 BM25パイプラインで評価した。対象は61問で、内訳はdevelopment ${enterprise500.split_counts.development}問、diagnostic ${enterprise500.split_counts.diagnostic}問、holdout ${enterprise500.split_counts.holdout}問である。

| 評価範囲 | 質問数 | Recall@5 | Accuracy | DVAA |
|---|---:|---:|---:|---:|
| 選定サブセット全体 | ${enterprise500.selected.questions} | ${pct(enterprise500.selected.recall, 2)} | 未計測 | 未計測 |
| うちholdout | ${enterprise500.holdout.questions} | ${pct(enterprise500.holdout.recall, 2)} | 未計測 | 未計測 |

このrunは検索評価までであり、回答生成と根拠付き回答の採点は行っていない。そのため、AccuracyとDVAAの「未計測」を0%として扱わない。

## 解釈上の境界

この結果は、同一生成系の合成文書、明示metadata、未見100系列、複合的な表記揺れを含むpractical holdoutに対する値である。外部分布のMultiHop-RAG untouched holdoutではDVAA 26.7%、EnterpriseRAG-Bench diagnosticでは同予算Vanilla 42.9%に対してFragrach 48.4%だった。後者ではChecklist付きFull Vanillaが46.2%であり、一般的な強いRAG全体への優位は確定していない。VersionQAの100%は改善に使った開発集合への適合値なので、外部分布性能には数えない。

したがって、最終判断は主評価のRecall、Accuracy、DVAAで行い、外部分布の数値は一般化範囲を確認する参考値として扱う。原因分析に使う内部判定や運用コストは、この精度表へ混ぜない。

## 再現性

- 集計JSON: \`target/benchmarks/final-metrics-2026-08-09/report.json\`
- bootstrap: 質問単位、20,000回、seed ${report.statistics.seed}
- practical holdout: 方式・Retriever・Reader・top-k・採点を固定した保存回答を使用
- Enterprise Fragrach 500: 500文書・61問の選定サブセット、R0 BM25検索評価。AccuracyとDVAAは未計測
- 未評価: 未知企業文書構造、不完全または誤ったmetadata、同一purposeで13文書超の実データ、Production-weighted track

入力artifactのhashは集計JSONの\`inputs\`へ保存した。回答、採点、Goldのいずれかが変わった場合は、同じ「最終値」へ混ぜず、別runとして再生成する。
`;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node scripts/summarize-final-metrics.mjs [--output DIR] [--markdown FILE] [--iterations N] [--seed N]");
    return;
  }
  if (!Number.isInteger(options.iterations) || options.iterations < 1) {
    throw new Error("--iterations must be a positive integer");
  }
  const answerReport = readJson(options.answerReport);
  const enterpriseFragrach500Report = readJson(options.enterpriseFragrach500Report);
  const conditions = Object.fromEntries(Object.entries(answerReport.conditions).map(
    ([name, condition]) => [name, conditionSummary(condition)],
  ));
  const inputFiles = [...new Set([options.answerReport, options.questions,
    options.enterpriseFragrach500Report,
    ...Object.values(conditionFiles).map((file) => path.join(options.answersDirectory, file)),
  ])];
  const report = {
    schema_version: "2.0",
    generated_at: new Date().toISOString(),
    evaluation_date: "2026-08-09",
    metric_contract: {
      recall: "Mean fraction of required gold documents present in the top-k answer materials.",
      accuracy: "Fraction of questions whose final answer or decision is correct.",
      dvaa: "Fraction of all questions that are correct and supported by complete, valid evidence for time, scope, process, authority, and required relations.",
    },
    statistics: {
      bootstrap_unit: "question",
      bootstrap_method: "paired percentile bootstrap",
      iterations: options.iterations,
      seed: options.seed,
    },
    inputs: Object.fromEntries(inputFiles.map((file) => [
      path.relative(repositoryRoot, file).replaceAll("\\", "/"),
      { sha256: sha256(file), bytes: fs.statSync(file).size },
    ])),
    dynamic_validity: {
      evaluation_split: answerReport.evaluation_split,
      reader: answerReport.reader,
      top_k: answerReport.top_k,
      conditions,
      paired_comparisons: {
        ruri: pairedComparison(answerReport, "Raw-Ruri-Dense", "Fragrach-Ruri-Packet", options.iterations, options.seed),
        fixed_hybrid: pairedComparison(answerReport, "Raw-Fixed-Hybrid", "Fragrach-Fixed-Hybrid-Packet", options.iterations, options.seed + 100),
      },
    },
    enterprise_fragrach_500: enterpriseFragrach500Summary(enterpriseFragrach500Report),
  };

  fs.mkdirSync(options.outputDirectory, { recursive: true });
  fs.mkdirSync(path.dirname(options.markdown), { recursive: true });
  const jsonFile = path.join(options.outputDirectory, "report.json");
  fs.writeFileSync(jsonFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  fs.writeFileSync(options.markdown, markdown(report), "utf8");
  console.log(`Final metrics: ${path.relative(repositoryRoot, jsonFile)}`);
  console.log(`Report: ${path.relative(repositoryRoot, options.markdown)}`);
  console.log(`Ruri DVAA delta: ${pp(report.dynamic_validity.paired_comparisons.ruri.metrics.dvaa.difference, 2)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) main();
