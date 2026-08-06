# 青羽精機 Validity Holdout

> この集合は2026-08-01のresolver改善に使用済みである。ディレクトリ名は互換性のため維持するが、未知データへの一般化を測るholdoutではなく、開発・回帰評価用として扱う。2026-08-04の再監査は `docs/evaluations/document-validity-regression-audit-2026-08-04_ja.md` を参照する。

当初は、開発用28問で調整したResolverの一般化を確認する独立評価Packとして作成した。既存のP0文書と質問は複製せず、Relationの連鎖と複数Scopeの合成を中心にしている。初回評価後にこの集合を使ってresolverを改善したため、現在は回帰評価用である。

- 5類型・20問
- 16文書・10 Relation
- 候補集合は固定され、Retrieverの性能は含まない
- 初回結果を保存するまでS3の規則を変更しない

対象類型は、追補の連鎖、法人・拠点・製品Scopeの合成、緊急指示、正本の訂正系譜、規程から実施記録までの系譜です。

## 実行

```text
npm run benchmark:validity-holdout-oracle

npm run benchmark:validity-holdout-codex
npm run benchmark:validity-holdout-e2e-codex

npm run benchmark:validity-holdout-gemma
npm run benchmark:validity-holdout-e2e-gemma
```

Profile / Relation抽出がValidatorに拒否された場合、E2Eは失敗終了する。無効なRelationを黙って除去して精度を計算しない。
