# P1外部OSS検索比較 2026-08-02

## 結論

P1で予定したローカル実行可能な外部OSSは、Graphiti、LightRAG、FastGraphRAG、Cognee、Microsoft GraphRAG Local Searchまで同じコーパスとGoldで測定できた。

この12文書・6問では、検索精度の最大値はLightRAG HybridのR@5 100%だった。ただしLightRAG Naiveも同じ100%であり、Graphを使った改善ではない。Cogneeも純粋Chunksが100%、Hybridが91.7%で、Graph追加によりR@5が8.3ポイント下がった。したがって、現時点のトップは「LightRAGのGraph方式」ではなく、Ruriと短い全文書単位を組み合わせたDense検索である。

Graphを使う条件だけを見ると、LightRAG HybridがR@5 100%、Fragrach Relation DossierとCognee Hybridが91.7%、Graphiti Historyが75.0%、FastGraphRAGが66.7%、Microsoft GraphRAG Localが58.3%だった。ただしLightRAGとCogneeは上位5件へ平均約2,811〜2,821 tokensを渡し、不要候補率@5も60%以上である。Fragrachは2,308 tokensで91.7%、Graphitiは1,793 tokensで75.0%だった。

Graphitiはトップではないため、当初の条件どおりGraphiti固有の深掘りを直ちに優先しない。次は、全文書Dense検索の100%が文書数12件への過適合でないか、関連の薄い文書を増やし、固定token budgetと同一chunk粒度で確認する。その上で、LightRAG、Graphiti、Fragrachの上位条件だけを拡大評価する。

## P1の範囲

ここでいうP1は、外部OSSをローカルへ導入し、同じSource、質問、Gold、LLM、Embeddingで検索結果を実測できる段階を指す。

| 対象 | P1での扱い | 理由 |
|---|---|---|
| [Graphiti](https://github.com/getzep/graphiti) | 実測済み | 時点付きFactと逐次更新が企業文書の更新系列に近い |
| [LightRAG](https://github.com/HKUDS/LightRAG) | 実測済み | Entity/Relationshipと原文chunkを使う複数検索modeを持つ |
| [FastGraphRAG](https://github.com/circlemind-ai/fast-graphrag) | 実測済み | PPRでGraph近傍と原文chunkを取得する軽量GraphRAG |
| [Cognee](https://github.com/topoteretes/cognee) | 実測済み | Local Graph、Vector、Chunks、Hybrid retrievalを持つ |
| [Microsoft GraphRAG](https://github.com/microsoft/graphrag) | Local Searchを実測済み | Entity、Relationship、Community Report、Text Unitを局所質問用に組み立てる |
| ai-knowledge-graph | 主表外 | 一文書から探索・可視化用SPOを作る実装で、同等の原文retrieval APIではない |
| HippoRAG 2、GraphRAG Global/DRIFT | P2 | multi-hopまたはglobal sensemaking用Goldが必要 |
| AWS Context Ontology Accelerator | 主表外 | AWS semantic layer全体であり、同じローカル検索部品として分離できない |

Microsoft GraphRAGのLocal Searchは、Graph情報と原文Text Unitを混ぜた局所回答用contextを作る公式方式である。Global SearchはCommunity Report全体を扱うため、今回の規程値・旧版・FAQ・正式規程を問う6問には混ぜなかった。[Microsoft GraphRAG Query Overview](https://github.com/microsoft/graphrag/blob/main/docs/query/overview.md)

## 共通評価契約

### データ

対象は`tests/corpora/fragrach-enterprise-ja-diverse/sources/manufacturing/product-design/governance`配下の12文書である。3シナリオに、第1版規程、第2版規程、更新未反映FAQ、承認記録が各1件ある。

質問は次の6問で、各問に必須原文根拠が2件ある。

- 2026年7月時点の現行規則と旧版の終了を問うVersion質問3問
- stale FAQと正式規程の両方を要求するConflict質問3問

R@kの分母は12必須根拠であり、1根拠が8.3ポイントに相当する。Conflict両側@kの分母は3問であり、1問が33.3ポイントに相当する。

### 統一条件

| 項目 | 条件 |
|---|---|
| Knowledge Build LLM | Codex App Server / `gpt-5.6-luna` / reasoning `low` |
| Embedding | `hf.co/Targoyle/ruri-v3-310m-GGUF:Q8_0`、768次元 |
| 検索評価 | LLM不使用。保存された検索順位を共通Gold照合器で採点 |
| top-k | 5、10、20 |
| 原文判定 | Source path、section、Gold content termsが一致した場合のみ正解 |
| context tokens | 各方式が返した`retrieval_text`を順位通り連結し、`o200k_base`で再計測 |
| 権威rerank | 各OSSの標準方式にはFragrach固有の権威加点を追加しない |

質問、Gold Profile、Gold Relation、期待回答はKnowledge Buildへ投入していない。Source本文とSource metadataだけを入力した。

## 比較条件の詳細

| 条件 | Index / Knowledge Build | 検索単位 | Query処理 |
|---|---|---|---|
| Raw Tuned + Purpose | 原文を最大1,024文字で分割 | 原文chunk | 日本語文字2-gram BM25、governance 12文書に絞る |
| Fragrach Relation Dossier | Claim、Profile、Relation、Conflict、両側原文を目的別にcompile | Relation DossierとClaim | 同じ日本語文字2-gram BM25、権威加点あり |
| Graphiti History | EpisodeからEntityと時間付きFactを抽出しNeo4jへ保存 | FactとEpisode provenanceの短い原文section | Edge BM25 + Ruri cosine + RRF |
| LightRAG Naive | 文書chunkをRuri vector indexへ保存 | 原文chunk | Dense検索のみ |
| LightRAG Hybrid | Entity、Relationship、chunkを抽出 | 原文chunk | Keyword抽出後、local/global/vector結果を統合 |
| FastGraphRAG PPR | Entity、Relation、chunkを抽出 | 原文chunk | Query EntityからPersonalized PageRank |
| Cognee Chunks | Cognify済みDocumentChunkをLanceDBへ保存 | 原文chunk | Ruri vector検索 |
| Cognee Hybrid | Cognify済みChunk、Entity、FactをNeo4j/LanceDBへ保存 | 回答context中の原文chunk | Chunk laneとEntity/Fact laneを並列取得 |
| Microsoft GraphRAG Local | Entity、Relationship、Community、Report、Text Unitを生成 | Local contextへ選ばれたText Unit | Queryに近いEntityからRelationship、Report、Text Unitを編成 |

LightRAGとCogneeでは、今回の短文書が一文書一chunkとなった。これはRaw Tunedの最大1,024文字chunkやGraphitiのFact単位より大きく、R@5に有利である。そのため精度だけでなくcontext tokensと不要候補率を必ず併記する。

## 検索品質

太字は主な上位値である。不要候補率は低い方がよい。

| 条件 | R@5 | R@10 | R@20 | Relation Path@10 | Conflict両側@10 | 不要候補率@5 |
|---|---:|---:|---:|---:|---:|---:|
| Raw Tuned + Purpose | 58.3% | 75.0% | 91.7% | **100.0%** | 0.0% | 76.7% |
| Fragrach Relation Dossier | 91.7% | 91.7% | 91.7% | **100.0%** | 66.7% | 53.3% |
| Graphiti History | 75.0% | 91.7% | **100.0%** | 83.3% | 66.7% | **33.3%** |
| LightRAG Naive | **100.0%** | **100.0%** | **100.0%** | **100.0%** | **100.0%** | 60.0% |
| LightRAG Hybrid | **100.0%** | **100.0%** | **100.0%** | **100.0%** | **100.0%** | 60.0% |
| FastGraphRAG PPR | 66.7% | 91.7% | **100.0%** | 83.3% | 66.7% | 73.3% |
| Cognee Chunks | **100.0%** | **100.0%** | **100.0%** | **100.0%** | **100.0%** | 60.0% |
| Cognee Hybrid | 91.7% | **100.0%** | **100.0%** | **100.0%** | **100.0%** | 63.3% |
| Microsoft GraphRAG Local | 58.3% | 91.7% | 91.7% | 83.3% | 66.7% | 76.7% |

### Graphの寄与はまだ分離できていない

LightRAGはNaiveとHybridが全指標で同じだった。CogneeはChunksのR@5 100%に対しHybridが91.7%へ低下した。少なくとも今回の6問では、LightRAG/Cogneeの最高値をGraph抽出の効果とは解釈できない。

一方、Fragrachは同じBM25系のRaw Tuned + PurposeよりR@5を33.4ポイント改善した。GraphitiもRawより16.7ポイント高く、不要候補率を43.4ポイント下げた。ただし両方式は検索単位とEmbedding利用が異なるため、純粋なKnowledge Build寄与を確定するには同じDense retrieverとchunk粒度でのアブレーションが必要である。

### Conflictの100%にも注意が必要

LightRAG NaiveとCognee ChunksはConflict両側@5が100%だったが、不要候補率@5は60%である。各問で必要な2文書に加えて平均3文書の不要候補を渡している。12文書しかない条件では成立しても、関連の薄い文書が数百件へ増えた場合に同じ順位を維持できるとは限らない。

FragrachはRelation Dossierが一つの検索枠で両側原文を返すが、3シナリオ中1件のRelationをcompile時に取りこぼし、Conflict両側@5は2/3だった。Graphitiは全原文を保持したものの、S1の正式規程側が15位となり、Conflict両側@10は2/3だった。

## 回答へ渡すcontext量

| 条件 | 平均tokens@5 | 平均tokens@10 | 正解根拠/1,000 tokens@5 |
|---|---:|---:|---:|
| Raw Tuned + Purpose | **714** | **1,343** | **1.63** |
| Graphiti History | 1,793 | 3,595 | **0.84** |
| Fragrach Relation Dossier | 2,308 | 4,533 | 0.79 |
| LightRAG Naive | 2,821 | 5,646 | 0.71 |
| LightRAG Hybrid | 2,821 | 5,646 | 0.71 |
| FastGraphRAG PPR | 2,817 | 5,652 | 0.47 |
| Cognee Chunks | 2,821 | 5,646 | 0.71 |
| Cognee Hybrid | 2,811 | 5,642 | 0.65 |
| Microsoft GraphRAG Local | 2,874 | 5,713 | 0.41 |

Rawは小さい原文chunkのため、取得できた正解1件あたりのtoken効率は高いが、R@5 58.3%で4割以上の根拠を失う。低tokenだけで優劣は決められない。

Compiled/Graph条件ではGraphitiの正解根拠/1,000 tokens@5が0.84で最も高く、Fragrachが0.79で続く。FragrachはGraphitiよりR@5が16.7ポイント高い代わりに、平均515 tokens多い。LightRAGはさらに約513 tokens多く使ってR@5を8.3ポイント上げた。今後はtop-k固定ではなくtoken budget固定も主要評価にする。

## Knowledge Buildと検索コスト

| 方式 | 取り込み時間 | Luna calls | Luna total tokens | 平均検索時間 |
|---|---:|---:|---:|---:|
| Graphiti | 991.9秒 | 102 | 1,123,795 | 184.8ms |
| LightRAG 全5mode実行 | 466.8秒 | 51 | 544,660 | Naive 73.8ms / Hybrid 8,399.1ms |
| FastGraphRAG | 298.5秒 | 18 | 195,333 | 7,554.4ms |
| Cognee | 387.5秒 | 25 | 251,637 | Chunks 215.7ms / Hybrid 248.5ms |
| Microsoft GraphRAG | 765.3秒 | 49 | 528,634 | 192.0ms |
| Fragrach Relation v2 warm | 82.7秒 | 1 | 32,228 | 検索6問を含む評価全体979ms |

LightRAGの51 callsには、Naive以外の4mode×6問で行うquery keyword抽出が含まれる。FastGraphRAGの18 callsにも6問のquery entity抽出が含まれる。CogneeとMicrosoft GraphRAGは回答生成を呼ばず、検索時はRuri embeddingだけを使った。したがって表のLuna tokensは「今回の正式実行全体」の値であり、全方式のcold buildだけを厳密に揃えた値ではない。

Fragrachのwarm値はSource別Claim cache 12件を再利用し、Profile/Relationを再生成した実行である。空cacheからの同一コード一体実行ではないため、外部方式とのcold build倍率には使わない。構造上はSource別抽出12 callsとIntent全体Relation抽出1 callへ集約できるが、正式なcold/warm比較は次段階で別に測る。

## 方式別の所見

### LightRAG

一文書一chunkのRuri Dense検索が6問すべての必須根拠をtop 5へ入れた。Hybridも同じ精度だが、query keyword抽出にLunaを使い、平均待ち時間が約8.4秒へ増えた。今回の局所質問ではHybridを使う理由は確認できない。

初回実行では、LightRAGがfile pathをbasenameへ縮約したため、3シナリオに重複する`approval.md`、`faq.md`、`pol-v1.md`、`pol-v2.md`を4文書として扱った。評価アダプターで相対pathを一意なbasenameへ符号化し、12/12件処理をhard gateで確認した。企業フォルダ投入では同名文書が普通に存在するため、実運用上の注意点である。

v3はLightRAG既定のsummary languageであるEnglishを使っており、日本語文書から英語entity・relationを抽出していた。NaiveとHybridが同じ100%で、取得結果も原文chunk中心だったため短文P1の首位値は維持するが、日本語Graph検索を最適化した条件とは扱わない。長文拡大評価では`addon_params.language=Japanese`を明示し、英語Graphと日本語質問の言語不一致を除く。

### Graphiti

top 5の不要候補率33.3%とcontext効率0.84は、Compiled/Graph条件で最良だった。R@20では12/12根拠を回収し、履歴を広く保持する能力も強い。一方、Fact単位で`COVERS`、`OWNED_BY`等が複数枠を使い、矛盾の両側をtop 10へ固定できない。

12文書で102 Luna calls、約112万tokensを使い、候補中もっとも高コストだった。逐次更新、Entity解決、Fact重複判定、時間境界抽出を行う価値と引き換えである。

### Cognee

Chunksは100%だったが、Hybridは91.7%へ下がった。今回のGoldではGraph laneが原文chunk順位を改善していない。Windowsの既定Ladybug/Kuzu構成はJSON extensionの非UTF-8エラーで起動できず、Neo4jへ切り替えた後もNeo4j driverとAPOCが追加で必要だった。APOCはNeo4j配布物の`labs`にある5.26.28完全一致版を使用した。APOCはNeo4j内部APIに依存するためNeo4jと対応版を揃える必要がある。[APOC Installation](https://neo4j.com/docs/apoc/current/installation/)

### FastGraphRAG

Luna callsとtotal tokensは外部Graph候補で最少だった。R@20は100%だが、R@5 66.7%、不要候補率@5 73.3%で、少数contextを正確にする用途では弱い。query entity抽出にLunaを使うため平均7.6秒かかる。

### Microsoft GraphRAG Local Search

43 Entity、56 Relationship、7 Community Report、12 Text Unitを生成したが、R@5はRaw Tuned + Purposeと同じ58.3%だった。Local SearchはQuery Entityとの関連からText Unitを選ぶため、旧版・FAQ・正式規程の両側原文を少数枠へ入れる今回のGoldには合わなかった。

インストールは135 packagesで、初回導入約7.2分、初回import約58秒、正式index約12.8分だった。Community Reportを含む広域sensemakingには別の価値があるため、この結果をGraphRAG全体の否定には使わない。global/DRIFT用Goldを作った段階でP2評価する。

## Graphitiを深掘りするか

今回の条件ではGraphitiはトップではない。したがって、GraphitiへRelation展開や権威rerankを追加する深掘りは保留する。

ただしGraphitiは次の2点で上位候補に残す。

1. Compiled/Graph条件で最も低い不要候補率@5と最も高い根拠/token効率を持つ。
2. R@20 100%で、Fragrachがcompile時に落とした原文根拠も保持している。

次の拡大評価で、固定token budget下のR@kまたは関連薄文書追加後のR@5がLightRAG/Cogneeを上回った場合に、Graphiti固有改善へ進む。

## 次の検証

優先順は次のとおりとする。

1. 同じ12正解文書へ、同業務・別業務・同名文書のdistractorを段階的に88件以上追加する。
2. 全方式を一文書一chunk、1,024文字chunk、目的別chunkの3粒度で比較する。
3. top-kだけでなく、1,500 / 2,500 / 4,000 tokensの固定budgetで根拠再現率とConflict両側率を測る。
4. LightRAG Naive、LightRAG Hybrid、Cognee Chunks、Cognee Hybridを同一Ruri index条件で比較し、Graph寄与を分離する。
5. FragrachへRaw Recall Laneを追加し、Relation DossierのR@5 91.7%を維持したままR@20 100%を目指す。
6. Conflict compileの取りこぼし1件を修正し、Conflict両側@5 100%を目標にする。
7. 上記で残った上位方式だけを、technical spec、incident、contract/complianceへ広げる。

最終回答評価へ進める条件は、検索方式が固定token budgetでRaw Tuned + Purposeを上回り、Conflict両側率を維持することである。現時点では小規模コーパスのR@5だけで「通常RAGより最終回答が高精度」とは表現しない。

## 実行上の失敗と採否

| 方式 | 失敗実行 | 原因 | 正式値への扱い |
|---|---|---|---|
| LightRAG | v1、v2 | 重複basenameで4/12文書だけ処理、provenance path mapping不備 | 不採用。v3のみ採用 |
| Cognee | v1 | Ladybug/Kuzu JSON extensionのWindows非UTF-8 decode error | 不採用 |
| Cognee | v2 | Neo4j Python driverがoptional dependency | driver追加後に再試行 |
| Cognee | v3 | APOC procedure未導入 | 同梱APOC追加後、v4を採用 |
| Microsoft GraphRAG | init v1 | 3.1.0の`init`が対話入力を要求 | 不採用。API経由v2を採用 |
| Microsoft GraphRAG | help診断 | timeout後の子Pythonが残留し初期化競合 | 対象プロセスのみ停止、単一processで再確認 |

成功値だけでなく、導入時に必要だった修正も再現可能性の一部として残す。

## 成果物

- 共通Gold採点器: `tests/benchmarks/rag-comparison/score-external-retrieval.mjs`
- context量測定器: `tests/benchmarks/rag-comparison/measure-p1-context.py`
- Graphiti adapter: `tests/benchmarks/rag-comparison/run-graphiti-p1.py`
- LightRAG adapter: `tests/benchmarks/rag-comparison/run-lightrag-p1.py`
- FastGraphRAG adapter: `tests/benchmarks/rag-comparison/run-fast-graphrag-p1.py`
- Cognee adapter: `tests/benchmarks/rag-comparison/run-cognee-p1.py`
- Microsoft GraphRAG adapter: `tests/benchmarks/rag-comparison/run-ms-graphrag-p1.py`
- context測定結果: `target/benchmarks/p1-open-source/2026-08-02-p1-context-size-v1`
- 各正式実行: `target/benchmarks/p1-open-source/2026-08-02-*-governance-*`

## 評価上の制約

- 6問、必須根拠12件だけであり、1件の差が8.3ポイントになる。
- 対象は製造業・製品設計部のgovernanceだけである。
- LightRAG/Cogneeの一文書一chunkは、短い合成文書に有利である。
- Codex App Serverはseedを固定できず、Knowledge Buildの反復一致率を測っていない。
- 主表は検索評価であり、回答生成、引用、禁止誤答、Strict Passを含まない。
- Build costは各OSSの正式実行全体を記録したが、LightRAG/FastGraphRAGはquery時Luna callsを含む。Fragrachはwarm buildであり、cold build倍率は未確定である。
