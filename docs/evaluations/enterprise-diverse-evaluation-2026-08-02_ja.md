# 企業部門コーパス検索評価 2026-08-02

この評価の目的は、多様な企業文書でも文書関係を事前コンパイルする価値があるかを確かめ、その上限と現在のFragrach実装の差を分けて把握することである。全40部門のOracle評価ではRelation Dossierに改善余地が確認できたが、Lunaで実際にコンパイルした2用途では結果が分かれた。現時点では、Fragrachが通常RAGを安定して上回ったとは言えない。

## 評価対象と比較条件

コーパスは8業種、40部門、2,880文書、1,440問で構成される。各部門は72文書と36問を持ち、規程、技術仕様、企画、運用、障害・変更、契約・コンプライアンスの6用途を含む。すべての質問に必要な原文根拠と文書関係を付与している。

Rawは部門単位の原文索引である。`Raw Tuned + Purpose Filter`では1024文字固定チャンク、文字2-gram BM25に加え、質問の利用目的と同じ文書だけを候補にする。これは、Fragrachだけを有利にしないために追加した強いRaw基準である。

Oracle Profileは、Goldの状態、権威、拘束力、有効期間を原文チャンクへ付加する。Oracle Relation Dossierは、さらにGoldの文書関係と関係両端の原文を一つの検索単位へ束ねる。いずれも質問文、期待回答要素、禁止回答、Gold Evidenceの検索語を索引へ入れていない。ただしGoldの文書プロフィールと関係を使うため、Fragrachの実装値ではなく、完全にコンパイルできた場合の上限である。

## 全40部門の検索上限

| 条件 | R@5 | R@10 | R@20 | Relation Path@10 | Conflict両側@10 | Conflict Unit@10 | 誤誘導率@10 |
|---|---:|---:|---:|---:|---:|---:|---:|
| Raw Current | 55.2% | 67.4% | 80.2% | 86.9% | 0.0% | n/a | 84.4% |
| Raw Tuned | 56.8% | 69.3% | 90.8% | 90.2% | 32.5% | n/a | 85.5% |
| Raw Tuned + Purpose Filter | 59.2% | 69.6% | 91.7% | 90.2% | 32.5% | n/a | 85.4% |
| Oracle Profile | 55.4% | 68.7% | 90.0% | 99.1% | 99.2% | n/a | 85.8% |
| Oracle Relation Dossier | 63.8% | 83.4% | 99.5% | 99.1% | 100.0% | 100.0% | 73.3% |

Relation Dossierは、最も強いRaw基準に対してR@5を4.5ポイント、R@10を13.8ポイント、R@20を7.8ポイント改善した。特に、矛盾する二文書を上位10件へそろえる割合は32.5%から100%になった。文書関係を検索単位として束ねる効果は、単に検索対象を利用目的で狭めた効果とは別に残っている。

一方、プロフィールを原文へ付加して権威加点するだけでは、R@5が3.8ポイント低下した。Relation Path@10とConflict両側@10は改善しているため、情報自体は役立つが、BM25の文書長や加点規則が通常の関連度を崩したと考えられる。プロフィール抽出を追加するだけでは不十分で、関係単位の構成と検索時の使い分けが必要である。

用途別では、DossierのR@5は規程で75.0%、契約・コンプライアンスで50.6%となり、Rawの68.1%、37.8%を上回った。技術仕様は両者とも25.0%であり、関係を束ねるだけでは改善しなかった。部門別のDossier差は、Raw比で-1.9ポイントから+14.8ポイントまで分布した。全用途・全部門で一様に効く手法ではない。

## LunaによるActualコンパイル

ActualはCodex App Serverの`gpt-5.6-luna`、reasoning effort `low`、Source単位の12 calls、キャッシュ有効で実行した。対象は製造業・製品設計部の2用途、合計24文書・12問である。この12問は全体の一部であり、Actualの一般化性能を示すサンプル数ではない。現在のコンパイル挙動とOracleとの差を発見するスモーク評価として扱う。

### 規程

12文書から51 Claimを生成し、棄却は0件だった。12 callsの初回実行は214.3秒、promptは141,815 tokens、completionは8,652 tokensである。5 Conflictのうち3件を未解決と判定し、Intentが未解決Conflictを許可しないためBuildを公開せず、成果物をfailed-buildsへ保存した。

| 条件 | Compile coverage | R@5 | R@10 | Relation Path@10 | Conflict両側@10 | Conflict Unit@10 |
|---|---:|---:|---:|---:|---:|---:|
| Raw Tuned・用途別索引 | 100.0% | 58.3% | 75.0% | 100.0% | 0.0% | n/a |
| Actual Claim | 100.0% | 33.3% | 50.0% | 100.0% | 0.0% | 0.0% |
| Actual Claim + Evidence | 100.0% | 50.0% | 50.0% | 100.0% | 0.0% | 0.0% |

Compile coverageは100%なので、必要な原文がBuildから消えたわけではない。FAQの更新状況が上位を占め、対になる正式規程の具体的条項が上位10件へ入らないため、3つのConflict質問がすべて0点になった。Claimを短いEvidence単位へ分割した結果、同じ関係にある二文書を一緒に取得できなくなっている。

未解決診断3件のうち2件は、`stale`と「第2版を反映していない」、`approved`と`current`を同じ`has_status`述語の矛盾として扱ったものだった。これらは状態の異なる側面であり、相互排他的ではない。残る保存期間2年と5年は実質的な競合だが、旧版と現行版の時点関係で解決できる。Conflictゲートは停止機構として動いたものの、状態語彙とSource metadataを使った解決が不足している。

### 技術仕様

12文書から38 Claimを発行し、3候補を不正なEvidence参照として棄却した。初回実行は193.8秒、promptは141,847 tokens、completionは7,476 tokensである。2 Conflictを未解決として警告したが、このIntentは未解決Conflictを許可するためBuildは`completed_with_warnings`で公開された。

| 条件 | Compile coverage | R@5 | R@10 | Relation Path@10 |
|---|---:|---:|---:|---:|
| Raw Tuned・用途別索引 | 100.0% | 25.0% | 47.2% | 100.0% |
| Actual Claim | 94.4% | 30.6% | 52.8% | 91.7% |
| Actual Claim + Evidence | 100.0% | 25.0% | 47.2% | 100.0% |
| Actual Evidence only | 100.0% | 25.0% | 41.7% | 100.0% |

ClaimはR@5とR@10を5.6ポイント改善した。ただしCompile coverageとRelation Pathが低下しており、全面的な改善ではない。Evidenceをすべて混ぜるとRawと同じR@5へ戻ったため、Fallbackは低スコア時ではなく、回答に必要な要素が不足した場合だけ実行する方針が妥当である。

## 判断と次の実装

今回の結果から、文書関係を事前コンパイルしてDossierとして検索する方向には価値がある。全40部門でR@10とConflict取得が大きく改善したため、特定の小規模コーパスだけに合わせた効果ではない。一方、現在のKnowledge BuildはRelation Dossierを発行経路へ統合しておらず、Claimと細粒度Evidenceだけでは複数文書質問を悪化させる場合がある。

次の実装は、Actual評価をそのまま40部門へ拡大する前に、次の三点へ絞る。

1. Source front matterから得た状態、版、有効期間、文書役割をClaimとConflict解決へ引き継ぎ、`approved`と`current`のような両立する状態を矛盾にしない。
2. Profile / Relation抽出結果をKnowledge Buildへ保存し、関係の両端と短い原文を束ねた検索Unitを発行する。
3. Claim検索で回答スロットが不足したときだけEvidenceへ戻り、Conflict Unitは通常のtop-kと別枠で回答資料へ追加する。

この三点を実装した後、まず製品設計部の6用途36問でRaw、Actual Claim、Actual Relation Dossierを比較する。そこでR@5がRaw以上、R@10がOracle改善方向へ近づき、Conflict両側@10が改善することを確認してから、8業種の代表部門、最後に全40部門へ展開する。

## 実験記録

全40部門のOracle実行IDは `2026-08-02-full40-v2` である。記録は `target/benchmarks/enterprise-domain-oracle/2026-08-02-full40-v2/` にあり、条件と入力SHA-256を含む`manifest.json`、集計の`metrics.json`、全質問・全条件の順位を持つ`retrieval.jsonl`、失敗索引、実行コマンド、標準出力を保存している。

Actual compileと検索評価の実行IDは次の通りである。

- `2026-08-02-manufacturing-product-design-governance-luna-v1`
- `2026-08-02-manufacturing-product-design-technical-spec-luna-v1`

コンパイル記録は `target/benchmarks/enterprise-domain-actual/`、検索記録は `target/benchmarks/enterprise-actual-retrieval/` の各実行ID配下に保存した。Provider警告、Fragrach診断、失敗Build、キャッシュ、全質問順位を削除せず保持している。評価記録の共通規約は `docs/evaluation-recording_ja.md` に定めた。

その後に実装したActual Relation Dossier、Answer Contract、Evidence fallbackの結果は、`docs/evaluations/relation-dossier-actual-evaluation-2026-08-02_ja.md`に記録した。
