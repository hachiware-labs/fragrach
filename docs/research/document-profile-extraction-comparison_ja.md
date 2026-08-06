# Document Profile・Relation抽出比較

実施日: 2026-08-01  
対象: Validity Extension 20文書・9 Relation  
条件: 32KB context、temperature 0相当、20文書一括、構造化JSON Schema

この比較では、企業文書の有力度を判定する前段として、自然文から文書の役割、適用範囲、有効時点、正本性、文書間関係をどこまで抽出できるかを測った。初回結果を基にRole定義とRelation抽出規則を明確化し、原文にしか存在しなかった正本・記録の適用開始日はfront matterへ移した。表は改善後Promptによる再コンパイル結果である。

## 抽出結果

| 指標 | Gemma 4 | Codex App Server / gpt-5.6-luna low |
|---|---:|---:|
| Profile coverage | 100.0% | 100.0% |
| Role accuracy | 95.0% | 95.0% |
| Force level accuracy | 94.1% | 100.0% |
| Approval accuracy | 100.0% | 100.0% |
| Scope dimension accuracy（Raw） | 0.0% | 70.0% |
| Scope value exact（Raw） | 0.0% | 20.0% |
| Temporal accuracy | 66.7% | 66.7% |
| Official record accuracy | 100.0% | 100.0% |
| Relation precision | 100.0% | 100.0% |
| Relation recall | 11.1% | 88.9% |
| Evidence grounding | 100.0% | 100.0% |
| 実行時間 | 135.5秒 | 76.4秒 |
| Prompt / completion tokens | 2,767 / 5,376 | 11,581 / 3,781 |

authority rankは原文から絶対値を決められないため、精度指標から外した。Scope exactも、「大阪工場」と内部IDの`osaka`のような表記差を含むRaw診断値である。実運用では`normalization-catalog.json`によってCanonical IDへ変換してからResolverへ渡す。

Gemma 4のScopeが0%なのは、空配列をJSON配列ではなく文字列`"[]"`として出力したためである。Normalizerはこの値を空値として除去できるが、原文に存在するScopeを正しく抽出したことにはならないので、Raw抽出精度は0%のまま報告する。

Codexは9個のGold Relationのうち8個を抽出した。取得できたのは、拠点適用2件、期限付き例外2件、条項追補、版の置換、契約内優先、共有Copyの由来である。未取得は実施記録から規程への`records_execution_of`だった。Gemmaが取得したRelationは拠点適用1件だけだった。

## E2Eで見えた差

抽出結果をScope・条項辞書で正規化し、同じ28問へS2とS3を適用した。

| Compile / Resolver | Strict case | Decision | Reason recall | Relation path | Abstention |
|---|---:|---:|---:|---:|---:|
| Gemma + S2 Filter-first | 53.6% | 74.7% | 52.4% | 0.0% | 85.7% |
| Gemma + S3 Relation graph | 64.3% | 82.3% | 61.9% | 20.0% | 85.7% |
| Codex + S2 Filter-first | 64.3% | 82.3% | 57.1% | 0.0% | 100.0% |
| Codex + S3 Relation graph | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% |

Codexが`records_execution_of`を抽出していなくても、ProfileのRole分離だけで該当4問のDispositionを決定できた。一方、例外、追補、契約優先、正本性ではRelationが結果を変えた。S3がS2を35.7ポイント上回ったため、Relationは説明用metadataにとどまらず、文書採否へ実際に寄与している。

この100%は、今回の28問を使ってPrompt、Normalizer、Resolver規則を改善した後の同一評価集合上の結果である。未知の文書や別業種への一般化性能ではない。また、候補文書は固定されており、検索漏れも評価していない。現段階で実証できたのは、「この評価契約では、Codexによる事前Compileと決定的Resolverを組み合わせるとOracleと同じ判断を再現できる」という点までである。

## 実装上の判断

Profile / RelationのRaw応答、正規化済みIR、Resolutionを別々に保存する。Scope辞書、Validator、Resolverを変更してもLLMを再実行しない。この分離により、今回も保存済みCodex抽出からResolverの2不具合を直し、再コンパイルなしで92.9%から100%へ改善できた。

次は現在の28問を開発用集合として固定し、PromptとResolverの調整に使っていないHoldoutを追加する。文書順Permutationと複数回抽出でRelationの再現性も測る。Holdoutで低下した場合は、Relationが欠けたときに誤って断定せず`unresolved`へ落とす条件を優先して改善する。
