#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import { generateScaleCorpus } from "./generate-dynamic-validity-scale-corpus.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const practicalCorpusRoot = path.join(
  repositoryRoot, "tests", "corpora", "aobane-industries-ja-dynamic-validity-practical-variation",
);

const japaneseNumbers = new Map([[5, "五"], [6, "六"]]);
const processVariations = [
  {
    process: "受け入れ部材の抜き取り検査",
    facts: ["何台に1台を検査しますか", "検査記録は何年間保管しますか"],
    tags: ["kanji_okurigana", "paraphrase"],
  },
  {
    process: "一時エクスポート・ファイルの後処理",
    facts: ["自動消去されるまで何時間保持しますか", "削除ジョブの登録前に何人で確認しますか"],
    tags: ["loanword_script", "case_spacing", "paraphrase"],
  },
  {
    process: "製造設備の予防メンテナンス",
    facts: ["定期点検は何日おきですか", "点検記録は何年間残しますか"],
    tags: ["business_synonym", "paraphrase"],
  },
  {
    process: "重大インシデント発生時の初報対応",
    facts: ["初報は何時間以内ですか", "正式報告は何時間以内ですか"],
    tags: ["business_synonym", "abbreviation", "paraphrase"],
  },
  {
    process: "特権IDの定期レビュー",
    facts: ["見直しは何日ごとですか", "証跡は何年間保管しますか"],
    tags: ["abbreviation", "business_synonym", "paraphrase"],
  },
];

function variedSiteName(siteName, familyIndex) {
  const mode = familyIndex % 4;
  if (mode === 0) return {
    text: siteName.replace(/第(\d+)/, "$1"),
    tags: ["site_ordinal_notation"],
  };
  if (mode === 1) return {
    text: siteName.replace(/第(\d+)/, (_match, value) => `第${japaneseNumbers.get(Number(value)) ?? value}`),
    tags: ["site_kanji_numeral"],
  };
  if (mode === 2) return {
    text: siteName.replace(/^(.*?)(第\d+)(工場|センター)$/, "$1・$2$3"),
    tags: ["site_punctuation"],
  };
  return {
    text: siteName.replace(/工場$/, "製造拠点").replace(/センター$/, "技術拠点"),
    tags: ["site_business_synonym"],
  };
}

export function practicalQuestion(row, { scenario, suffix }) {
  const processIndex = scenario.index % processVariations.length;
  const variation = processVariations[processIndex];
  const site = variedSiteName(scenario.siteName, scenario.index);
  const fact = variation.facts[suffix === "A" ? 0 : 1];
  const templates = [
    `${site.text}における${variation.process}の現行ルールを確認したい。${fact}`,
    `${site.text}で${variation.process}を行う場合、${fact}`,
    `${variation.process}について、${site.text}では${fact}`,
    `${site.text}の${variation.process}：${fact}`,
  ];
  return {
    ...row,
    split: "practical_holdout",
    canonical_question: row.question,
    question: templates[scenario.index % templates.length],
    surface_variations: [...new Set([
      ...variation.tags,
      ...site.tags,
      scenario.index % templates.length >= 2 ? "word_order" : "sentence_form",
    ])],
  };
}

export function practicalScenario(scenario) {
  if (scenario.index < 200) return { ...scenario, split: "archive" };
  return { ...scenario, split: "practical_holdout", transformQuestion: practicalQuestion };
}

export function generatePracticalCorpus(outputRoot = practicalCorpusRoot) {
  return generateScaleCorpus({
    outputRoot,
    cohorts: 6,
    transformScenario: practicalScenario,
    corpusId: "aobane-industries-ja-dynamic-validity-practical-variation",
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(generatePracticalCorpus(), null, 2));
}
