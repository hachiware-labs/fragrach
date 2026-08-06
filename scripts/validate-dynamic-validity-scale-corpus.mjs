#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { corpusRoot } from "./generate-dynamic-validity-scale-corpus.mjs";

function readJsonl(filePath) {
  return fs.readFileSync(filePath, "utf8").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map(JSON.parse);
}

function stageIndex(stage) {
  return stage === "T0" ? 0 : stage === "T1" ? 1 : -1;
}

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) * ratio)];
}

export function validateScaleCorpus(root = corpusRoot) {
  const errors = [];
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  const profiles = readJsonl(path.join(root, "gold", "profiles.jsonl"));
  const relations = readJsonl(path.join(root, "gold", "relations.jsonl"));
  const questions = readJsonl(path.join(root, "evaluation", "questions.jsonl"));
  const expectedBackgrounds = manifest.design?.background_documents ?? 788;
  const expectedDynamic = manifest.design?.dynamic_documents ?? 200;
  const expectedFamilies = manifest.design?.dynamic_families ?? 50;
  const expectedDocuments = expectedBackgrounds + expectedDynamic;
  const expectedQuestions = expectedFamilies * 2;
  const expectedRelations = expectedFamilies * 2;
  const documentBySource = new Map(manifest.documents.map((document) => [document.source, document]));
  const profileCounts = new Map();
  for (const profile of profiles) profileCounts.set(profile.source, (profileCounts.get(profile.source) ?? 0) + 1);

  if (manifest.documents.length !== expectedDocuments) errors.push(`documents: ${manifest.documents.length}/${expectedDocuments}`);
  if (profiles.length !== manifest.documents.length) errors.push(`profiles: ${profiles.length}/${manifest.documents.length}`);
  if (relations.length !== expectedRelations) errors.push(`relations: ${relations.length}/${expectedRelations}`);
  if (questions.length !== expectedQuestions) errors.push(`questions: ${questions.length}/${expectedQuestions}`);
  if (documentBySource.size !== manifest.documents.length) errors.push("duplicate document source");

  const roots = manifest.source_roots.map((sourceRoot) => path.resolve(root, sourceRoot));
  const dynamicLengths = [];
  for (const document of manifest.documents) {
    const matches = roots.map((sourceRoot) => path.join(sourceRoot, document.source)).filter((filePath) => fs.existsSync(filePath));
    if (matches.length !== 1) errors.push(`${document.source}: source matches ${matches.length} roots`);
    if (profileCounts.get(document.source) !== 1) errors.push(`${document.source}: profile count ${profileCounts.get(document.source) ?? 0}`);
    if (document.source.startsWith("sources/70-dynamic/") && matches[0]) {
      dynamicLengths.push(fs.readFileSync(matches[0], "utf8").length);
    }
  }

  const splitFamilies = new Map([...new Set(questions.map((question) => question.split))]
    .map((split) => [split, new Set(questions
      .filter((question) => question.split === split)
      .map((question) => question.family_id))]));
  for (const [split, expectedCount] of Object.entries(manifest.design?.splits ?? {})) {
    const expectedFamilyCount = expectedCount / 2;
    if (splitFamilies.get(split)?.size !== expectedFamilyCount) {
      errors.push(`${split} families: ${splitFamilies.get(split)?.size ?? 0}/${expectedFamilyCount}`);
    }
  }
  const familyOwner = new Map();
  for (const [split, families] of splitFamilies) {
    for (const family of families) {
      if (familyOwner.has(family)) errors.push(`family leakage between ${familyOwner.get(family)} and ${split}: ${family}`);
      familyOwner.set(family, split);
    }
  }

  for (const question of questions) {
    if (question.question.includes(question.family_id.toUpperCase())) errors.push(`${question.id}: family id leaked into question`);
    for (const stage of ["T0", "T1"]) {
      const gold = question.stages?.[stage];
      if (!gold) {
        errors.push(`${question.id}: missing ${stage}`);
        continue;
      }
      const sources = new Set([
        ...gold.retrieval_gold,
        ...gold.required_evidence_sets.flat(),
        ...gold.forbidden_governing_evidence,
      ]);
      for (const source of sources) {
        const document = documentBySource.get(source);
        if (!document) errors.push(`${question.id}/${stage}: unknown source ${source}`);
        else if (stageIndex(document.introduced_at) > stageIndex(stage)) errors.push(`${question.id}/${stage}: future source ${source}`);
      }
    }
  }

  for (const relation of relations) {
    for (const source of [relation.from, relation.to, relation.evidence]) {
      if (!documentBySource.has(source)) errors.push(`relation unknown source: ${source}`);
    }
  }

  if (dynamicLengths.length !== expectedDynamic) errors.push(`dynamic documents: ${dynamicLengths.length}/${expectedDynamic}`);
  if (dynamicLengths.some((length) => length < 2500)) errors.push("dynamic document shorter than 2500 characters");

  return {
    ok: errors.length === 0,
    errors,
    inventory: {
      documents: manifest.documents.length,
      background_documents: manifest.documents.filter((document) => !document.source.startsWith("sources/70-dynamic/")).length,
      dynamic_documents: dynamicLengths.length,
      t0_documents: manifest.documents.filter((document) => document.introduced_at === "T0").length,
      t1_added_documents: manifest.documents.filter((document) => document.introduced_at === "T1").length,
      questions: questions.length,
      questions_by_split: Object.fromEntries([...splitFamilies].map(([split, families]) => [
        split, { questions: questions.filter((question) => question.split === split).length, families: families.size },
      ])),
      dynamic_characters: {
        min: Math.min(...dynamicLengths),
        median: percentile(dynamicLengths, 0.5),
        p90: percentile(dynamicLengths, 0.9),
        max: Math.max(...dynamicLengths),
      },
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rootIndex = process.argv.indexOf("--root");
  const root = rootIndex >= 0 ? path.resolve(process.argv[rootIndex + 1]) : corpusRoot;
  const result = validateScaleCorpus(root);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}
