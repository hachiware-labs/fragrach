# 文書有力度Resolver Oracle比較

実施日: 2026-08-01  
対象: `aobane-industries-ja-validity` 7類型・28問

## 結果

同一の固定Candidate Snapshotへ、GoldのDocument ProfileとRelationを与えてR0、S1、S2、S3を比較した。

| 方式 | Strict case | Decision | Reason recall | Relation path | Abstention |
|---|---:|---:|---:|---:|---:|
| R0 Relevance-only | 0.0% | 11.4% | 0.0% | 0.0% | 0.0% |
| S1 Weighted metadata | 0.0% | 22.8% | 0.0% | 0.0% | 0.0% |
| S2 Filter-first | 71.4% | 84.8% | 57.1% | 0.0% | 100.0% |
| S3 Relation graph | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% |

S2は適用範囲、文書Role、承認状態、有効時点、入力不足時の棄却を順序付きで判定する。単一Scoreへ混ぜるS1よりDecision精度が62.0ポイント高く、対象情報が足りないケースでは全件を`unresolved`にできた。

S2が失敗した8問は、期限付き個別例外2問、条項追補2問、契約内優先1問、正本と共有Copyの区別3問である。これらはProfileの属性だけではなく、二文書間の局所Relationを必要とする。

S3は`exception_to`、`amends`、`order_of_precedence`、`derived_from`を適用して8問を解消した。Relationを使わないScope、Role、時点の問題ではS2と同じ結果を維持した。

## この結果から言えること

- Relevanceだけで文書の採否を決めることはできない。
- metadata加重より、Scope不一致、未承認、時点不一致を先に除外する方が適している。
- Profileだけで解ける問題と、文書間Relationが必要な問題を分離できた。
- 解決不能な入力をScoreで推測せず、`unresolved`と不足fieldを返す契約が動作した。

## この結果からはまだ言えないこと

S3の100%は、評価Goldと同じOracle RelationをResolverへ与えた上限試験である。自然文からRelationを抽出できることや、未知の文書で100%になることは示していない。また、R0とS1は文書採否を返さない方式へ共通Disposition契約を適用しているため、数値は回答精度ではなくResolverとしての不足量を表す。

次の実験ではC1 Front Matter・規則抽出、C2 Gemma 4、C3/C4 Codex App ServerのProfile・Relation精度を測り、S3の上限からどれだけ落ちるかを確認する。既存500文書・100問は検索回帰として別に固定し、Validity 28問と混ぜない。

## 再実行

```text
npm run benchmark:validity-oracle
```

機械可読な結果は`target/benchmarks/document-validity/oracle-comparison.json`へ出力される。
