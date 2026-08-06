# Fragrach S3と既存RAG手法の比較

調査日: 2026-08-01

Fragrach S3は、検索Graphそのものを新規性とする方式ではない。文書からProfileと限定Relationを事前抽出し、質問の用途・対象・時点に応じて、文書を`canonical`、`instance_exception`、`execution_record`、`historical`、`reference`、`excluded`、`unresolved`へ決定的に分類する文書有力度Resolverである。

既存手法とは得意な質問と評価データが異なるため、論文ごとのスコアを直接比較しない。ここでは、各方式がどの段階を改善し、企業文書の効力判断をどこまで明示的に扱うかを比較する。

## 目的と処理段階

| 手法 | 主目的 | 事前に作るもの | 質問時の中心処理 | S3との関係 |
|---|---|---|---|---|
| 標準RAG | 関連passageを取得して生成を外部知識で補う | Passage index | 類似検索＋生成 | S3の下に置く候補取得Baseline。文書間の効力は定義しない。 |
| Hybrid検索＋rerank | 字面一致と言い換えを両立し、関連候補を上位化する | Sparse / Dense index | 融合＋関連度rerank | 相補的。S3は関連度では決められない旧版、例外、正本を処理する。 |
| Contextual Retrieval / Late Chunking | 孤立チャンクへ文書内Contextを補う | 文脈付きChunkまたは文脈化Embedding | 通常の検索 | S3より前のRetrieval View。文書間の優先・例外関係は扱わない。 |
| CRAG / Self-RAG | 取得品質を質問時に評価し、追加検索・生成批評を行う | 評価器または専用学習済みモデル | 質問ごとの補正・自己批評 | 未知質問へのfallbackとして相補的。質問ごとのLLM費用と揺れが残る。 |
| RAPTOR | 長文を複数の抽象度で検索する | 再帰的な要約木 | Tree retrieval | 長文横断・要約質問向け。条項効力や正本性ではなく文脈統合が中心。 |
| Microsoft GraphRAG | コーパス全体のglobal sensemaking | Entity graph＋Community summary | Community単位のmap-reduce | 全体傾向の質問に強い。S3は局所的な規程・対象・時点判断に限定したGraph。 |
| HippoRAG 2 | 事実・連想・sensemakingを非parametric memoryとして統合 | Knowledge graph＋passage連携 | Personalized PageRank＋LLM利用 | 多段・連想検索の比較対象。文書効力のDispositionは中心契約ではない。 |
| PropRAG | Proposition間の多段Evidence経路を取得する | 文脈付きProposition graph | LLMを使わないbeam search | S3に最も近い実行形態。違いは、PropRAGがEvidence取得、S3が文書の採否・役割決定を目的にする点。 |
| RA-RAG / Astute RAG | 不完全な取得とsource reliability、内外知識競合へ対処する | Reliability推定またはsource-aware表現 | 信頼性に基づく統合 | S3のauthority判断に近い。ただしS3は一つの信頼度へ集約せず、Scope・Role・Relationを順序付きで適用する。 |
| Conflict-aware RAG | 競合を検出・分類し、回答前に処理する | Conflict signalまたは分類器 | 競合検出＋選択的解決 | FragrachのConflict gateに近い。S3は競合以外に追補、例外、実施記録、正本系譜も同じDecision契約へ置く。 |
| Temporal KG / E²RAG / ATOM | 変化する事実、Event、観測時点と有効時点を保持する | Temporal / Entity-Event graph | 時点・因果に沿った検索 | S3の時点設計に近い先行領域。現行S3は単一の有効期間が中心で、dual timeは未実装。 |
| **Fragrach S3** | **企業文書を用途・対象・時点ごとの効力へ解決する** | **原文Evidence＋Document Profile＋限定Relation** | **Rustによるfilter-first＋Relation graph解決** | **検索器を置き換えず、取得候補を回答可能な役割へ決定的に分類する。** |

標準RAGは、parametric memoryと外部のnon-parametric memoryを組み合わせる枠組みとして提案された。[Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks](https://arxiv.org/abs/2005.11401) RAPTORは再帰的なclusterとsummaryによるTree retrievalを行う。[RAPTOR](https://proceedings.iclr.cc/paper_files/paper/2024/hash/8a2acd174940dbca361a6398a4f9df91-Abstract-Conference.html) GraphRAGはEntity GraphとCommunity Summaryを事前生成し、主にコーパス全体を問うglobal sensemakingを対象にする。[From Local to Global: A Graph RAG Approach](https://www.microsoft.com/en-us/research/publication/from-local-to-global-a-graph-rag-approach-to-query-focused-summarization/)

Contextual Retrievalは各Chunkへ短い文脈を付加し、原文を置換せず検索用表現を増やす。[Contextual Retrieval](https://www.anthropic.com/engineering/contextual-retrieval) ColBERTv2はToken単位のlate interactionによって細かな意味対応をrerankへ利用する。[ColBERTv2](https://aclanthology.org/2022.naacl-main.272/) どちらも候補取得を強くするが、取得後の文書効力を定義するものではない。

質問時補正では、CRAGが取得結果を評価して補正し、Self-RAGが必要時の取得と生成批評をreflection tokenで制御する。[Corrective Retrieval Augmented Generation](https://openreview.net/pdf?id=HHeDtTQibwg) [Self-RAG](https://research.ibm.com/publications/self-rag-learning-to-retrieve-generate-and-critique-through-self-reflection) これらはS3の代替というより、S3が`unresolved`を返した場合のfallback候補である。

## 文書有力度に必要な能力

`○`は主要な設計対象、`△`は部分的または拡張によって対応、`—`は中心契約ではないことを表す。

| 手法 | Scope・対象 | 版・時点 | 条項追補 | 個別例外 | 規範と実績の分離 | 正本・Copy | 未解決を返す | 質問時の決定性 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 標準RAG | — | — | — | — | — | — | — | △ |
| Hybrid＋rerank | △ | △ | — | — | — | — | — | ○ |
| CRAG / Self-RAG | △ | △ | △ | △ | △ | △ | ○ | — |
| RAPTOR / GraphRAG | △ | △ | △ | — | — | — | — | △ |
| HippoRAG 2 / PropRAG | △ | △ | △ | △ | △ | — | — | ○※ |
| RA-RAG / Astute RAG | △ | △ | — | — | — | △ | △ | — |
| Conflict-aware RAG | — | △ | — | △ | — | △ | ○ | △ |
| Temporal KG / E²RAG / ATOM | △ | ○ | △ | △ | △ | — | △ | ○ |
| **Fragrach S3** | **○** | **○** | **○** | **○** | **○** | **○** | **○** | **○** |

※PropRAGは質問時のEvidence経路探索に生成LLMを使わないが、HippoRAG 2はオンラインLLMも利用する。PropRAGは文脈付きProposition上をbeam searchし、多段Evidence取得を改善する。[PropRAG](https://arxiv.org/abs/2504.18070) HippoRAG 2はPersonalized PageRankとpassage統合を用いて事実・連想・sensemakingを扱う。[HippoRAG 2](https://arxiv.org/abs/2502.14802)

信頼性と競合を扱う先行研究もS3に近い。RA-RAGは複数sourceの相互照合からreliabilityを推定して関連度と併用する。[Reliability-Aware RAG](https://aclanthology.org/2025.emnlp-main.1738/) Astute RAGは内部知識と外部知識をsource-awareに統合する。[Astute RAG](https://arxiv.org/abs/2410.07176) ConflictRAGは回答前に競合を検出・分類・解決するが、2026年8月時点ではプレプリントである。[ConflictRAG](https://arxiv.org/abs/2605.17301)

時点については、古い情報が現行情報と共存するだけでRAG精度が低下することがHoHで示されている。[How Outdated Information Harms RAG](https://aclanthology.org/2025.acl-long.301/) E²RAGはEntityとEventを別Graphへ分け、時間・因果の変化を保持する。[Entity-Event RAG](https://aclanthology.org/2026.eacl-long.90/) ATOMは情報を観測した時点と事実が有効な時点を分けるdual-time Temporal KGを構築する。[ATOM](https://aclanthology.org/2026.findings-eacl.49/) この比較から、dual timeはFragrachが先行研究より進んでいる点ではなく、次に取り込むべき未実装要件である。

## Fragrach S3の位置づけ

S3の構成要素を個別に見ると、Graphの事前構築、LLMを使わない経路探索、source reliability、競合処理、Temporal KGには先行研究がある。したがって、現段階で「既存研究を全面的に超えた新方式」とは結論しない。

一方、今回調査した主要手法では、次の組合せは中心的な製品契約になっていない。

1. 原文を削除せず、ProfileとRelationを追加ArtifactとしてCompileする。
2. `amends`、`exception_to`、`records_execution_of`、`derived_from`を異なる意味で扱い、単一のGraph距離や信頼度へ潰さない。
3. Scope、Role、承認、時点を先にfilterし、その後に局所Relationを適用する。
4. 採用文書だけでなく、例外、実績、履歴、参考、除外、未解決を型付きで返す。
5. Relationの未知targetや不正IDをCompile時に拒否し、厳格運用では公開を止める。
6. 質問時の文書解決をLLMに任せず、同じ入力から同じDecisionとRelation pathを返す。

このため、S3の独自性候補は「Graph RAG」ではなく、企業文書の局所効力を事前コンパイルし、検証済みGraphを決定的な文書採否へ変換するgovernance compilerにある。新規性の確定には、さらに体系的な文献調査と他業種Holdoutが必要である。

## 現時点の実測

| 条件 | Strict case | Decision | Relation path | Abstention |
|---|---:|---:|---:|---:|
| 開発用28問、S2 Profile only | 71.4% | 84.8% | 0.0% | 100.0% |
| 開発用28問、S3 Oracle | 100.0% | 100.0% | 100.0% | 100.0% |
| 第一Holdout 20問、初回S3 Oracle | 65.0% | 90.6% | 78.3% | 100.0% |
| 第一Holdout、一般規則修正後S3 Oracle | 100.0% | 100.0% | 100.0% | 100.0% |
| 第一Holdout、Codex抽出＋修正後S3 | 85.0% | 100.0% | 87.0% | 100.0% |

この数値はFragrach内の同一評価契約によるアブレーションであり、上記論文のQAスコアとの直接比較ではない。現時点で実証できたのは、ProfileだけのS2よりRelationを使うS3が文書有力度判断を改善し、未調整Holdoutで見つかった合成・連鎖規則を一般化可能な形で実装できたことまでである。
