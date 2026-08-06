# Metadataコンパイル増分評価（2026-08-06）

## 評価の目的

現行のFragrachが、企業文書のDocument ProfileとRelationをどこまで原文からコンパイルできるかを確認した。今回の結果は検索・回答品質やVanilla RAGとの比較ではなく、Knowledge Buildを作る段階だけの評価である。

評価前の方式はコミット`61ac59b`として固定した。その後、承認関係を表現できない問題と、古いFAQの矛盾関係が安定しない問題を修正し、同じ12文書を再評価した。続いて、データを一度に広げず、同じ部門のplanningとoperationsを12文書ずつ追加した。さらに、業界と部門を跨いだ再現性を見るため、医療・品質薬事部のgovernanceとoperationsを24文書追加した。

## 対象と条件

対象は`fragrach-enterprise-ja-diverse`の製造業・製品設計部と医療・品質薬事部である。ProviderはCodex App Server、モデルは`gpt-5.6-luna`、reasoning effortは`low`、対象日は2026-07-15とした。各fresh実行では12文書のClaim抽出と、12文書をまとめたProfile・Relation抽出を新規に行った。

| 部門・用途 | 異なる文書数 | Gold Relation | 独立LLM応答 | 公開Build |
|---|---:|---:|---:|---:|
| 製品設計・governance | 12 | 9 | 2 | 2 |
| 製品設計・planning | 12 | 9 | 1 | 1 |
| 製品設計・operations | 12 | 9 | 2 | 2 |
| 品質薬事・governance | 12 | 9 | 1 | 1 |
| 品質薬事・operations | 12 | 9 | 2 | 0 |
| 合計 | 60 | 45 | 8 | 6 |

したがって、現時点で確認した範囲は60文書、2業界・2部門、3用途に限られる。製品設計のgovernanceとplanningは抽出契約v4、製品設計のoperationsと品質薬事の2用途はv5で測定しており、単一契約版の全体性能を示す集計ではない。品質薬事のoperationsは2回ともProfile、Relation、Claimをfailed-buildへ保存できたが、未解決Conflictを許可しないIntentの公開条件を満たさず、Knowledge Buildとしては公開されなかった。

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

## 品質薬事部へ広げた結果

品質薬事部のgovernance 12文書では、12 Profile、8 Relation、41 Claimを生成し、Gold 7/9と一致した。`supersedes`と`approves`は各3/3だったが、FAQから現行規程への`conflicts_with`は1/3に留まった。Gold外では旧版規程から現行規程への`conflicts_with`を1本生成した。Goldを完全な正例集合とみなしたprecisionは87.5%、recallは77.8%である。質問が要求する6本に限ると、`supersedes` 3本と`conflicts_with` 1本の計4/6だった。製品設計部で得たgovernanceの90% / 100%は、部門を跨いでそのまま再現しなかった。

品質薬事部のoperationsは、同一条件で2回fresh実行した。いずれも12 Profileを保存し、Gold一致は7/9だったが、出力数と誤った端点が異なった。

| operations実行 | Gold一致 | 出力Relation | precision | recall | 未解決Conflict | 公開結果 |
|---|---:|---:|---:|---:|---:|---|
| 品質薬事 fresh 1 | 7/9 | 8 | 87.5% | 77.8% | 5 | 失敗 |
| 品質薬事 fresh 2 | 7/9 | 10 | 70.0% | 77.8% | 2 | 失敗 |

両実行とも`applies_to`は3/3、質問が要求する`exception_to`は2/3、`records_execution_of`は2/3だった。S1のLOGについては、Providerが16桁の`source_id`から末尾1文字を落としたためProfileがfallbackとなり、LOGから例外指示へのRelationも端点不正で棄却された。別の`exception_to`は、fresh 1ではS3の例外指示がS2の手順を指し、fresh 2ではS2の例外指示が手順ではなく現場指示を指した。

公開失敗の原因はRelation精度とは別にある。同じS1内で、通常手順の「一営業日以内」と期限付き例外の「二時間以内」が異なるClaimとして抽出され、`exception_to` Relationも存在していた。しかし、現在のClaim Conflict解析は適用期間、状態、宣言済み権威順だけを使い、Document Relationを参照しない。このため正当な期限付き例外を未解決Conflictと判定し、`unresolved_conflicts_allowed: false`の公開条件により両Buildが失敗した。データ拡張によって、Relationを抽出するだけでなくConflict解決へ接続する必要が明確になった。

## 現時点の判断

製品設計部のgovernance 12文書では、今回の修正により既知のRelation欠落を再現可能な形で解消した。一方、品質薬事部ではgovernanceが7/9、operationsが2回とも7/9となり、同じ関係型でも部門横断の再現率はまだ十分ではない。operationsのProfile roleは両部門で正しくなったが、Relation端点のコピー誤り、列挙漏れ、正当な例外を未解決Conflictとする問題が残る。

確認済みデータは60文書まで増えたが、全2,880文書の一部にすぎず、Vanilla RAGを上回ったとは判断できない。今回測ったのもコンパイル段階だけであり、検索順位、必要根拠の回収、最終回答の正しさは別に評価する必要がある。

次の修正単位では、第一に`exception_to`をClaim Conflict解決へ安全に接続し、正当な期限付き例外を未解決扱いしないようにする。第二に、Relation候補ごとの抽出または検証可能なcoverage passを設け、端点コピーと列挙漏れを独立に検証する。planningについては、Relation型を増やす前にGold Relationが原文から追跡できるよう、文書IDまたは明示的な参照をSourceへ加えるべきかを判断する。

## 実行記録

- governance初回応答と現行コードでの再処理: `target/benchmarks/enterprise-domain-actual/2026-08-06-relation-v4-manufacturing-product-design-governance-luna-v1/knowledge-build-refined-v2/`
- governance fresh再実行: `target/benchmarks/enterprise-domain-actual/2026-08-06-relation-v4-manufacturing-product-design-governance-luna-v2/`
- planning fresh実行と型修正後の再処理: `target/benchmarks/enterprise-domain-actual/2026-08-06-relation-v4-manufacturing-product-design-planning-luna-v1/knowledge-build-refined/`
- operations v4初回: `target/benchmarks/enterprise-domain-actual/2026-08-06-relation-v4-manufacturing-product-design-operations-luna-v1/`
- operations v5 fresh 1: `target/benchmarks/enterprise-domain-actual/2026-08-06-relation-v5-manufacturing-product-design-operations-luna-v2/`
- operations v5 fresh 2: `target/benchmarks/enterprise-domain-actual/2026-08-06-relation-v5-manufacturing-product-design-operations-luna-v3/`
- 品質薬事 governance v5 fresh: `target/benchmarks/enterprise-domain-actual/2026-08-06-relation-v5-healthcare-quality-regulatory-governance-luna-v1/`
- 品質薬事 operations v5 fresh 1（failed-build保存）: `target/benchmarks/enterprise-domain-actual/2026-08-06-relation-v5-healthcare-quality-regulatory-operations-luna-v1/`
- 品質薬事 operations v5 fresh 2（failed-build保存）: `target/benchmarks/enterprise-domain-actual/2026-08-06-relation-v5-healthcare-quality-regulatory-operations-luna-v2/`
