# P1 Graphiti性能比較 2026-08-02

## 結論

製造業・製品設計部の更新系列12文書と6問では、Fragrach Relation Dossierが上位5件の根拠回収で最良だった。R@5はRaw Tuned + Purposeの58.3%に対し、Graphiti Historyが75.0%、Fragrachが91.7%である。R@10ではGraphitiとFragrachがともに91.7%となり、Graphitiも十分に強かった。

Graphitiは上位20件まで広げると全根拠を回収し、不要候補率もFragrachより低かった。一方、FAQと正式規程の矛盾を上位10件で両側取得できたのは3問中2問で、Fragrachと同率だった。Graphitiには矛盾を専用検索単位として上位へ固定する仕組みがなく、Fragrachにはその仕組みがあるものの、コンパイル時に1関係を取りこぼした。現時点では、両方式とも矛盾両側@10の目標100%には達していない。

この結果は「FragrachがGraphitiより常に高精度」という証明ではない。6問だけの局所的な版・権威・矛盾質問では、Fragrachの目的別Relation Dossierがtop 5を改善し、Graphitiの時間グラフは広い候補回収と低い不要候補率に強い、という初期結果である。

## この評価でいうP1

本レポートのP1は、外部OSSをローカルに実装し、同じSourceとGoldで実測する段階を指す。Fragrach内部ロードマップのP1とは別の分類である。

最初の外部実装にはGraphiti 0.29.3を選んだ。Graphitiはエピソードを逐次追加し、事実の有効・無効時点と原文provenanceを持つtemporal knowledge graphであり、今回の更新型企業文書と比較軸が最も重なるためである。Graphitiの公開APIとデータモデルは公式リポジトリに従った。[Graphiti公式リポジトリ](https://github.com/getzep/graphiti)

Microsoft GraphRAGのglobal searchやCommunity Summaryは、コーパス全体の傾向を問う用途に向く。今回の6問は一つの規程値、旧版、FAQ、正式規程の関係を問う局所質問であるため、このP1検索値へ混ぜなかった。global sensemaking用Goldを追加した後の別評価対象とする。

## コーパス

対象は`tests/corpora/fragrach-enterprise-ja-diverse`のうち、`sources/manufacturing/product-design/governance`配下の12文書である。3シナリオそれぞれに次の4文書がある。

| 文書 | 評価する性質 |
|---|---|
| 第1版規程 | 旧規則、適用終了日 |
| 第2版規程 | 現行規則、旧版の置換 |
| stale FAQ | 旧値を案内し、第2版を未反映と明記 |
| 承認記録 | 第2版の承認、施行日、承認主体 |

Goldは2026年7月15日時点のVersion質問3問と、FAQ対正式規程のConflict質問3問である。各問は2件の必須原文根拠を持つため、根拠判定は合計12件となる。既存データだけで版更新、失効、権威差、stale文書、複数文書質問を評価できたため、今回Ollamaによる追加生成は行っていない。比較途中で質問分布を変えないことを優先した。

`evaluation/questions.jsonl`、Intent、Gold RelationはGraphitiの取り込み対象へ入れていない。Graphitiへ渡したのは12件のSource本文とSource metadataだけである。

## 比較条件

| 条件 | 対象 | 検索単位 | Knowledge Build | 検索 |
|---|---:|---|---|---|
| Raw Tuned + Purpose | 12文書、60 chunk | 最大1,024文字の原文chunk | なし | 日本語文字2-gram BM25、`k1=1.8`、`b=0.75` |
| Fragrach Relation Dossier | 12文書、51 unit | Claimと文書関係の両側原文を束ねたDossier | Codex App Server / `gpt-5.6-luna` low | Rawと同じ日本語文字2-gram BM25 |
| Graphiti History | 12 episode、64 fact | Graph factと、そのFactのprovenanceにある短い原文section | Codex App Server / `gpt-5.6-luna` low、Ruri埋め込み | Graphiti edge BM25 + cosine similarity + RRF |
| Graphiti Current | Graphiti Historyと同じ | 質問時点で無効なFactを候補から除外 | Graphiti Historyと同じ | History順位を時間属性で後処理 |

Graphitiへは企業規程に合わせた4種類のEntity型を指定した。

- `EnterpriseDocument`: 規程、FAQ、承認記録、文書版
- `OrganizationUnit`: 会社、部門、チーム
- `BusinessRole`: 承認者、責任者、役職
- `GovernedSubject`: 規程が管理する業務、記録、対象

Graphiti標準のFactだけでは回答時に原文引用へ戻れないため、検索アダプターは各FactのEpisode provenanceから原文sectionを添付した。これはGraphitiの検索順位を変更しない。Fragrachと同じ権威加点やConflict別枠はGraphitiへ追加していない。

## LLMと実行環境

正式比較でLLMを使用したKnowledge BuildはすべてCodex App Serverの`gpt-5.6-luna`、reasoning effort `low`に揃えた。Raw検索、R@k採点、Gold照合にはLLMを使っていない。Graphitiの埋め込みは`hf.co/Targoyle/ruri-v3-310m-GGUF:Q8_0`、768次元である。

| 項目 | 値 |
|---|---|
| OS | Windows x64 |
| CPU | AMD Ryzen AI MAX+ 395、16 core / 32 logical processor |
| RAM | 63.6 GiB |
| GPU | AMD Radeon 8060S Graphics |
| Codex CLI | 0.144.3 |
| Graphiti | 0.29.3、commit `021d3a57d511f21b10adaf7fa923bd5c1fce5e9d` |
| Neo4j | Community 5.26.28 |
| Java | Zulu OpenJDK 21.0.12 LTS |
| Python | 3.13.5 |
| Node.js | 22.17.1 |

Neo4j CommunityはWindowsへ直接導入し、専用評価DBをlocalhostだけで起動した。Graphiti 0.29.3の要件に合わせてNeo4j 5.26系を使っている。Windowsでの配置とサービス運用の一般要件はNeo4j公式手順に従う。[Neo4j Windowsインストール](https://neo4j.com/docs/operations-manual/current/installation/windows/)

## 検索結果

R@kは全12必須根拠の回収率である。Conflict両側@10はConflict 3問のうち、FAQと正式規程を両方取得した質問率である。不要候補率は低い方がよい。

| 指標 | Raw Tuned + Purpose | Fragrach Relation Dossier | Graphiti History | Graphiti Current |
|---|---:|---:|---:|---:|
| R@5 | 58.3%（7/12） | **91.7%（11/12）** | 75.0%（9/12） | 50.0%（6/12） |
| R@10 | 75.0%（9/12） | **91.7%（11/12）** | **91.7%（11/12）** | 66.7%（8/12） |
| R@20 | 91.7%（11/12） | 91.7%（11/12） | **100.0%（12/12）** | 75.0%（9/12） |
| Relation Path@10 | **100.0%（6/6）** | **100.0%（6/6）** | 83.3%（5/6） | 33.3%（2/6） |
| Conflict両側@10 | 0.0%（0/3） | **66.7%（2/3）** | **66.7%（2/3）** | **66.7%（2/3）** |
| Conflict専用Unit@10 | 該当なし | 66.7%（2/3） | 該当なし | 該当なし |
| 不要候補率@5 | 76.7% | 53.3% | 33.3% | **30.0%** |
| Resolution Accuracy@10 | 判定対象なし | 0.0% | 0.0% | 0.0% |

### top 5ではFragrachが強い

FragrachはGraphitiより2件多い必須根拠をtop 5へ入れた。Relation Dossierが版関係やFAQ対正式規程を一つの検索単位に束ねるため、同じ質問語に一致する周辺Factへ順位枠を使い過ぎない。今回の「RAGへ渡す少数資料を正確にする」という目的では、この差が重要である。

### Graphitiは広い候補集合に強い

Graphiti Historyはtop 20で12/12を回収し、Fragrachがコンパイル時に取りこぼしたS3のFAQ Relationも原文provenance経由で回収した。不要候補率@5もFragrachより20ポイント低い。EntityとFactが適切に抽出できれば、BM25とRuriのHybridは局所検索でも強い。

ただし、Fact単位の順位では同じ主題に関する`COVERS`、`OWNED_BY`、`APPLIES_TO`などが複数枠を使う。S1のConflict質問ではFAQ未反映Factが3位に入った一方、正式規程第2版の原文へ戻れるFactは15位だった。このためtop 10ではFAQ側しか満たせなかった。

### Currentだけでは更新理由を説明できない

Graphiti DBには64 Factがあり、59件に`valid_at`、14件に`invalid_at`、9件に`expired_at`が付いた。時間属性そのものは生成できている。

一方、Version Goldは現行規程だけでなく、旧版が2026年3月31日に終了した根拠も要求する。Current条件は旧Factを除くため、Version 3問のR@10がすべて50%になった。企業RAGでは「現在値だけを返す検索」と「なぜ現在値になったかを説明する履歴Dossier」を分ける必要がある。

また、一部の旧Factでは`invalid_at`が原文の2026年3月31日にならず、Graphiti処理時刻の`expired_at`が付いた。History検索では原文provenanceを保持するため根拠回収に影響しなかったが、厳密なas-of filterへそのまま使うには時間属性の検証が必要である。

### 矛盾解決は両方式とも未達

FragrachとGraphitiはConflict両側@10がともに2/3だった。ただし失敗原因は異なる。

- FragrachはS3のFAQ対正式規程Relationをコンパイル時に取りこぼした。
- GraphitiはS1の両文書をグラフに保持したが、正式規程側が15位となった。

両側を取得できた質問でも、正規側を競合側より先に置くResolution Accuracyは0%だった。FragrachはConflict専用Unitを持つが、その後の正規側順位付けが必要である。Graphitiは権威・文書状態をFactとして保持したものの、標準edge RRFではそれを決定的な優先規則として使わない。

## Knowledge Buildのコスト

Graphiti正式実行は12文書で102回のLuna呼び出しを行った。Entity抽出だけでなく、既存Entityの解決、Fact抽出、重複・矛盾判定、時間境界抽出を逐次行うためである。

| 項目 | Graphiti正式実行 |
|---|---:|
| 取り込み時間 | 991.9秒 |
| 検索を含む全体 | 995.2秒 |
| Luna calls | 102 |
| input tokens | 1,103,460 |
| output tokens | 20,335 |
| 取り込み後 | 12 Episode、24 Entity、64 Fact |
| DB全体 | 36 node、134 relationship |
| 平均検索待ち時間 | 184.8ms/問 |

Fragrachの現在のRelation v2実行は、既存Claim cache 12件を再利用し、Profile / RelationをLuna 1 call、82.7秒、input 27,991 tokens、output 4,237 tokensで生成した。同じ12文書のSource別Claim初回抽出は別実行で12 calls、約194〜214秒と記録されている。ただし現在のRelation v2と同一コード・空cacheによる一体実行ではないため、Graphitiとの正確なcold build比率には使わない。

構造上は、FragrachがSource別抽出12 callsとIntent全体のRelation抽出1 callへ集約するのに対し、Graphitiは文書追加ごとに複数の解決処理を行う。今回の102 callsは、更新ごとに細かくグラフを維持する利点と引き換えのコストである。次の速度比較では、専用の空cacheディレクトリを使い、Fragrach cold build、warm build、Graphiti initial build、Graphiti一文書incremental updateを別々に測る。

## 実装中に確認した失敗

成功値だけを残さず、次の失敗も記録した。

| 実行 | 結果 | 原因と対応 |
|---|---|---|
| Gemma v1 | 取り込み前に失敗 | 新規EpisodeへUUIDを渡し、既存Episode更新として解釈された。nameによる存在確認へ修正 |
| Gemma v2 | 2文書とも0 Entity / 0 Fact | Graphiti既定の固有Entity基準が企業規程の抽象概念を除外。企業文書向けEntity型を指定 |
| Gemma v3 smoke | 7 Entity / 4 Fact、118.3秒 | 型指定で互換性を確認 |
| Luna v4 smoke | Schema 400 error | Codex strict outputが全propertyの`required`列挙を要求。共有bridgeのSchema正規化を修正 |
| Luna v5 smoke | 6 Entity / 5 Fact、30.1秒 | Luna経路の互換性を確認 |
| Luna v6 | 12文書・6問完了 | 正式比較に採用 |

Gemmaの1文書スモークとLunaのスモークは、入力Entity型を揃えても生成数が異なる。1文書だけなので品質差は判断しないが、処理時間はLunaが約4分の1だった。ユーザー指定と既存評価結果を踏まえ、正式比較はLunaへ統一した。

## 評価上の制約

- 6問、必須根拠12件であり、1根拠が8.3ポイント、1質問が16.7ポイントに相当する。
- 対象は製造業・製品設計部のgovernanceだけである。技術仕様、企画、インシデント、契約で同じ順位になるとは限らない。
- Graphitiへ企業文書向けEntity型と抽出指示を与えた。無調整の標準設定では0 Entityだったため、実運用可能な設定を比較した。
- Graphiti FactにはEpisode由来の短い原文sectionを添付した。裸のFact検索よりRAG用途に適するが、Fact一件が複数sectionを返すためtoken量の比較が必要である。
- 今回の主表は検索専用評価であり、回答生成やLLM judgeを含まない。したがってGemma judgeの既存結果は主表へ入れていない。
- Codex App Server経路にはseedを固定できない。Knowledge Buildの反復一致率は未測定である。

## 判断

P1時点の判断は次のとおりである。

1. Fragrachの目的別コンパイルは、強いGraphiti Hybridと比べてもtop 5の根拠密度に価値がある。
2. GraphitiはR@10でFragrachへ並び、R@20と不要候補率で上回る。外部比較対象として十分に強く、単純Rawだけを相手にした改善ではないことを確認できた。
3. Fragrachの差別化はKnowledge Graphの有無ではなく、権威、版、矛盾、原文両側を回答用Dossierへ事前編成し、公開可否を管理する点に置くべきである。
4. ただしConflict両側@10は2/3、Resolution Accuracyは0%であり、現段階で「企業文書の矛盾を解決できる」とは表現できない。

## 次の比較

次は、同じ固定データで次の条件を追加する。

1. Graphiti Historyへ一段Relation展開だけを加え、標準RRFとの差を測る。
2. FragrachへRaw Recall LaneとConflict別枠を加え、R@20 100%とConflict両側@10 100%を目指す。
3. 権威・状態rerankをGraphitiとFragrachの共通後処理として適用し、Knowledge Build差とreranker差を分離する。
4. 保存済みtop 5からLunaで回答を生成し、回答要素、引用、禁止誤答をLuna条件だけで比較する。
5. technical spec、incident change、commercial complianceへP1を広げる。

回答比較へ進む条件はGraphiti HistoryとFragrach Relation Dossierが満たした。Raw、Graphiti、Fragrachの検索結果は保存済みなので、Knowledge Buildを再実行せず回答プロンプトだけを反復できる。

## 成果物

- Graphitiアダプター: `tests/benchmarks/rag-comparison/run-graphiti-p1.py`
- 共通Gold採点器: `tests/benchmarks/rag-comparison/score-external-retrieval.mjs`
- 正式実行: `target/benchmarks/p1-open-source/2026-08-02-graphiti-0.29.3-luna-ruri-governance-v6`
- 採点結果: `target/benchmarks/p1-open-source/2026-08-02-graphiti-0.29.3-luna-ruri-governance-v6-scored`
- Fragrach比較値: `target/benchmarks/enterprise-actual-retrieval/2026-08-02-manufacturing-product-design-governance-luna-relation-v3-detailed`

