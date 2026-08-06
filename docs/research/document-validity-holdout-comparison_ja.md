# S3文書有力度 Holdout検証

> **位置づけの更新（2026-08-04）**  
> この集合は2026-08-01のresolver改善に使用したため、以後は開発・回帰用集合であり、独立holdoutではない。現在実装をLunaで再監査した結果と、Goldにだけ存在する `authority_rank` への依存は、[文書有力度Resolver 回帰・抽出契約監査](../evaluations/document-validity-regression-audit-2026-08-04_ja.md)に記録した。

実施日: 2026-08-01  
開発用集合: 7類型・28問  
Holdout: 5類型・20問、16文書、10 Relation

開発用28問で100%になったS3が、関係構造を変えた文書群へ一般化するかを確認した。HoldoutのGoldを確定し、S3を変更する前にOracleとLLM抽出の初回結果を保存した。その後、失敗原因を関係型の一般規則として修正し、同じ保存済み抽出を再評価した。

## 初回結果

| 入力 | Strict case | Decision | Reason | Relation path | Abstention |
|---|---:|---:|---:|---:|---:|
| Oracle Profile / Relation | 65.0% | 90.6% | 100.0% | 78.3% | 100.0% |
| Codex抽出 | 60.0% | 82.8% | 100.0% | 65.2% | 100.0% |
| Gemma抽出 | E2E不実施 | E2E不実施 | ― | ― | ― |

Oracleでも7問を失敗したため、開発用100%はRelation Graphの一般化を保証していなかった。主な失敗は、追補チェーンの中間追補をCanonicalへ残すこと、全社要件と日本法人の追加要件を同一Roleの競合として片方だけ選ぶこと、`derived_from`が期限切れ原記録をCanonicalへ戻すことだった。また、`applies_to`はDispositionへ反映してもRelation経路を保存していなかった。

GemmaはProfile coverage、Role、時点を抽出できたが、5個のRelationすべてに未知targetまたは重複IDがあった。Validatorが公開前に拒否したため、無効Relationを除去した見かけ上の精度は計算していない。

Codexの初回抽出はRole、Scope dimension、Temporalが100%だった。Relationは11個を出力し、precision 81.8%、recall 90.0%だった。未取得は実施記録から上位規程への`records_execution_of`で、追加2件は名古屋手順から全社規程への直接`applies_to`と、振り返り文書から事故記録への`derived_from`だった。

## 一般規則の修正

Holdout固有の文書IDや質問IDはResolverへ追加していない。次の不変条件を実装した。

- `applies_to`で結ばれた適用要件は、同一Roleでも単一勝者へ絞らず合成し、Relation経路を残す。
- 追補が別の追補を同じ条項で再改訂した場合、中間追補をReferenceへ落とす。最終passで判定し、Relation入力順に依存させない。
- `derived_from`を非正本Copyの意味で使うのは、sourceが`official_record: false`、targetが`true`の場合に限る。
- `derived_from`のtargetが既にHistoricalまたはUnresolvedなら、Canonicalへ再昇格させない。

## 修正後

| 入力 | Strict case | Decision | Reason | Relation path | Abstention |
|---|---:|---:|---:|---:|---:|
| 開発用28問 Oracle | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% |
| Holdout Oracle | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% |
| Holdout Codex抽出 | 85.0% | 100.0% | 100.0% | 87.0% | 100.0% |

修正によって、Oracle Holdoutは65%から100%、Codex抽出は60%から85%へ上がった。既存28問は100%を維持した。Codex条件で残る3問は、同じ1 Relationの抽出漏れが3つの質問でRelation path不足として現れたもので、79個のDisposition判断はすべて正しかった。

この結果は、S3の基本構造が異なる文書関係へ拡張可能であることを示す一方、初回の65%が示すように、開発用集合だけでは合成と連鎖の規則を十分に発見できないことも示している。修正後Holdoutは既に調整へ使用したため、今後は開発用集合として扱う。

次は同じ16文書についてCodexの文書順Permutationと3回反復を行い、Relation集合の一致率と、欠落Relationが毎回同じかを確認する。その後、組込み参照と二重時点を新しいIR要件として追加し、第二Holdoutで初回性能を測る。

既存RAG、GraphRAG、PropRAG、Conflict-aware RAG、Temporal KGとの能力差は[Fragrach S3と既存RAG手法の比較](fragrach-s3-prior-methods-comparison_ja.md)に整理した。
