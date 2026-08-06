# 青羽精機 Validity Extension

企業文書の検索ではなく、候補取得後の文書有力度解決を比較するための決定的な評価Packです。

- `oracle/profiles.jsonl`: LLM抽出誤りを含まないDocument Profile
- `oracle/relations.jsonl`: 根拠確認済みの文書関係
- `evaluation/cases.jsonl`: 7類型・28問の固定Candidate Snapshotと期待Decision
- `world/normalization-catalog.json`: Scope・条項表記をCanonical IDへ変換する辞書
- `sources/`: 各類型の短い原文

R0、S1、S2、S3は同一Candidate Snapshotを入力にするため、Retrieverの変動はこの評価へ入りません。

## 実行

Oracle Profile / RelationでResolverだけを比較する。

```text
npm run benchmark:validity-oracle
```

Gemma 4またはCodexでProfile / Relationを抽出し、その保存結果をS2 / S3へ渡す。

```text
npm run benchmark:validity-gemma
npm run benchmark:validity-e2e-gemma

npm run benchmark:validity-codex
npm run benchmark:validity-e2e-codex
```

抽出結果を再利用するE2E評価ではLLMを再度呼ばない。Scope辞書、Validator、Resolverだけを変更した場合の試行錯誤を、Compile時間と切り離して実行できる。
