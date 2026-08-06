# Metadataコンパイル増分評価（2026-08-06）

## 評価の目的

現行のFragrachが、企業文書のDocument ProfileとRelationをどこまで原文からコンパイルできるかを確認した。今回の結果は検索・回答品質やVanilla RAGとの比較ではなく、Knowledge Buildを作る段階だけの評価である。

評価前の方式はコミット`61ac59b`として固定した。その後、承認関係を表現できない問題と、古いFAQの矛盾関係が安定しない問題を修正し、同じ12文書を再評価した。続いて、データを一度に広げず、同じ部門のplanningとoperationsを12文書ずつ追加した。

## 対象と条件

対象は`fragrach-enterprise-ja-diverse`の製造業・製品設計部である。ProviderはCodex App Server、モデルは`gpt-5.6-luna`、reasoning effortは`low`、対象日は2026-07-15とした。各fresh実行では12文書のClaim抽出と、12文書をまとめたProfile・Relation抽出を新規に行った。

| 用途 | 異なる文書数 | Gold Relation | 現行コードで処理した独立LLM応答 |
|---|---:|---:|---:|
| governance | 12 | 9 | 2 |
| planning | 12 | 9 | 1 |
| operations | 12 | 9 | 2 |
| 合計 | 36 | 27 | 5 |

したがって、現時点で確認した範囲は36文書、1部門、3用途に限られる。governanceとplanningは抽出契約v4、operationsは関係定義を追加したv5で測定しており、全企業コーパスや単一契約版の性能を示す規模ではない。

## governanceの結果

Relation IRへ`approves`を追加し、承認と実行記録を分離した。また、Relationの端点に一意な管理文書番号が返った場合だけ、対応する`source_id`へ正規化するようにした。古いcommunicationと現行normativeの非有効関係については、両端に同じ単一値predicateの異なるClaimがある場合だけ`conflicts_with`へ精緻化する。

修正後は、二つの独立したLLM応答のどちらでもGold 9本をすべて回収した。内訳は`supersedes` 3本、`conflicts_with` 3本、`approves` 3本である。各実行にはGold外の`order_of_precedence`が1本あり、Goldを完全な正例集合とみなした場合のRelation precisionは90%、recallは100%となる。fresh実行では12 Profile、10 Relation、40 Claimを生成し、Profile・Relation診断は0件だった。

修正前の固定版では、各実行の厳密一致は4/9だった。ただし、当時のIRには`approves`が存在しなかったため、この数値は抽出器だけの性能ではなく、表現力不足を含む。

## planningで見つかった境界

planningのfresh実行では12 Profile、5 Relation、38 Claimを生成した。front matterの`decision_minutes`と`options_analysis`が型表に登録されておらず、それぞれ`reference`へ落ちていたため、前者を`record`、後者を`analysis`へ修正した。

一方、planningのGold Relation 9本は、現状のまま一つの精度値へまとめるべきではない。

- `evaluates` 3本と`implements_decision` 3本は、現在のRelation IRに対応する型がない。
- `approves` 3本はIRで表現できるが、決定議事録は採用方式を述べるだけで、承認対象となる計画文書を管理文書番号などで特定していない。計画側も承認済みであることは示すが、どの議事録が承認したかを特定していない。
- 抽出器はこの条件で`approves`を出さず、提案と現行計画の不一致を表す関係を出した。この挙動は、原文にない端点を推測しないという抽出契約とは整合する。

このため、planningの0/9をそのまま実装精度と解釈することはできない。6本は語彙未対応、3本はGoldと原文の対応を先に監査する必要がある。

## operationsで確認した再現性

operationsのGold 9本は、`applies_to`、`exception_to`、`records_execution_of`が各3本で、いずれも現行IRで表現できる。初回のv4実行では、front matterの`operating_procedure`、`work_instruction`、`temporary_deviation`が`reference`へ落ち、Gold一致は`exception_to` 3本だけだった。

そこで3種類を`instruction`へ対応づけ、抽出契約v5で各Relationの成立条件を明示した。v5の二回のfresh実行は、Profile 12件のroleをすべて正しくコンパイルし、質問が要求する`exception_to`も両方3/3だった。一方、コーパス全体のGoldに対する結果は一致しなかった。

| operations実行 | Gold一致 | 出力Relation | precision | recall |
|---|---:|---:|---:|---:|
| v5 fresh 1 | 5/9 | 7 | 71.4% | 55.6% |
| v5 fresh 2 | 9/9 | 9 | 100% | 100% |

一回目は`records_execution_of`を2/3抽出し、`applies_to`は0/3だった。代わりに、本文が明示する`order_of_precedence`を2本出した。二回目は3種類を各3本抽出し、余分なRelationもなかった。同じ入力と設定で4本差があるため、成功した二回目だけを現行性能とはみなせない。質問必須Relationは安定しているが、背景グラフ全体の列挙はまだ非決定的である。

## 現時点の判断

governance 12文書では、今回の修正により既知のRelation欠落を再現可能な形で解消した。operationsでは質問必須の例外関係を再現できたが、全Relationの列挙は5/9から9/9まで揺れた。確認済みデータは36文書だけであり、Vanilla RAGを上回ったとは判断できない。今回測ったのはコンパイル段階であり、検索順位、必要根拠の回収、最終回答の正しさは別に評価する必要がある。

次に文書数を増やす前に、Relationを一括応答から漏れなく列挙させる方法を分離して検討する。候補は関係候補ごとの第二段抽出または検証可能なcoverage passであり、同じ入力の反復成功だけに依存する方式は採らない。planningについては、Relation型を増やす前にGold Relationが原文から追跡できるよう、文書IDまたは明示的な参照をSourceへ加えるべきかを判断する。

## 実行記録

- governance初回応答と現行コードでの再処理: `target/benchmarks/enterprise-domain-actual/2026-08-06-relation-v4-manufacturing-product-design-governance-luna-v1/knowledge-build-refined-v2/`
- governance fresh再実行: `target/benchmarks/enterprise-domain-actual/2026-08-06-relation-v4-manufacturing-product-design-governance-luna-v2/`
- planning fresh実行と型修正後の再処理: `target/benchmarks/enterprise-domain-actual/2026-08-06-relation-v4-manufacturing-product-design-planning-luna-v1/knowledge-build-refined/`
- operations v4初回: `target/benchmarks/enterprise-domain-actual/2026-08-06-relation-v4-manufacturing-product-design-operations-luna-v1/`
- operations v5 fresh 1: `target/benchmarks/enterprise-domain-actual/2026-08-06-relation-v5-manufacturing-product-design-operations-luna-v2/`
- operations v5 fresh 2: `target/benchmarks/enterprise-domain-actual/2026-08-06-relation-v5-manufacturing-product-design-operations-luna-v3/`
