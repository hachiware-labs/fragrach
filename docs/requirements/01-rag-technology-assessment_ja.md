<p align="center">
  <img src="../../assets/fragrach-logo.png" alt="Fragrach — The Anserer" width="360">
</p>

# Fragrach要件根拠：RAG技術の現状評価

文書区分: 要件根拠（技術調査）  
文書体系: 1 / 3  
基準日: 2026-08-04  
後続文書: [Fragrach要件分析：動的な企業知識](02-dynamic-enterprise-knowledge-requirements-analysis_ja.md)

## 本書の位置づけ

本書は、Fragrachの正式な要件文書群において、技術選択と問題設定の外部根拠を与える第一文書である。RAGについて現在どのような論考と比較研究があり、どこまで知見が一致し、どこから見解が分かれているかを整理する。本書自体はFragrachの必須要件を規定せず、ここで確認した知見を後続の要件分析へ渡す。とくに、次の問題意識を調査の出発点とした。

- コーパスが大きくなるとDense retrievalは難しくなり、BM25の方が強くなるという報告がある。
- Graph RAGは構築・検索費用の割に通常RAGを安定して上回らず、効果が見えるのはmulti-hopなど一部の質問ではないか。
- 結局はSparseとDenseを組み合わせ、rerankerで絞るHybrid RAGを丁寧に調整することが、依然として強いのではないか。
- Graph、Agent、routingといった新しい方式は、RAG全体を置き換えたのか、それとも限定的な処理を追加したにすぎないのか。

ここでは、この見方を最初から結論とはしない。一般的な総説、Graph RAGの総説、統一条件での横断比較、規模を変えた実験、強いbaselineを固定したablationを分け、それぞれが実際に何を示したかを追う。Fragrach内の評価は最後に外部研究との対応として扱い、一般的な文献知見と混同しない。

## サーベイ状況をどう読むか

RAGの文献には、性格の異なるものが同じ「survey」や「benchmark」として並んでいる。少なくとも次の四種類を区別する必要がある。

| 文献の種類 | 主に分かること | その文献だけでは分からないこと |
|---|---|---|
| 技術総説・taxonomy | 方式の構成要素、研究領域、代表手法 | 同じ条件でどの方式が勝つか |
| 個別方式の提案論文 | その方式が想定する課題と、選ばれたbaselineに対する効果 | 強いHybridや別Graph方式に対する一般的優位性 |
| 統一benchmark・横断比較 | 特定のコーパス、質問分布、モデル条件での相対性能 | 別domain、別言語、別規模への一般化 |
| Scaling study・ablation | 規模や構成要素を変えたときの劣化と寄与 | 未比較のembedding、reranker、fusionを含む最良構成 |

[Retrieval-Augmented Generation for Large Language Models: A Survey](https://arxiv.org/abs/2312.10997) は、RAGの発展をNaive、Advanced、Modularという段階で整理した代表的な総説である。この整理では、検索前処理、検索、生成、評価を交換可能なmoduleとして捉える。その後の研究は、単一の「新しいRAG」が旧方式を置き換えるというより、query transformation、routing、rerank、hierarchical retrieval、graph、verificationをmoduleとして追加する方向へ広がった。

Graph RAGについては、[Graph Retrieval-Augmented Generation: A Survey](https://arxiv.org/abs/2408.08921) がGraph-based indexing、Graph-guided retrieval、Graph-enhanced generationという工程で整理し、[Retrieval-Augmented Generation with Graphs (GraphRAG)](https://arxiv.org/abs/2501.00309) がquery processor、retriever、organizer、generator、data sourceを含む広い枠組みを提示している。両者は研究領域の地図として有用だが、Graph RAGが通常RAGより有効だという統一比較ではない。また、既存のKnowledge Graphを検索する方式と、非構造文書からLLMでGraphを新規構築する方式を同じGraphRAGの中に含むため、「GraphRAGの性能」を一つの数値で論じること自体が難しい。

現在の論争を理解するには、方式を列挙する総説に加えて、2025年から2026年に増えた横断比較とnegative resultを見る必要がある。そこでは「高度な方式を足すほど良い」という初期の期待よりも、baselineの強さ、質問型、コーパス規模、候補Recall、reranker、計算費用が結果を左右することが前面に出ている。

## 論考の流れ

RAG研究の流れを大づかみに並べると、次のようになる。

1. 2020年前後から、Dense retrieverとgeneratorを結合し、意味的な検索によって外部知識を利用する構成が広がった。
2. 2021年には、Denseの低次元表現が索引規模の増加に弱いという理論的・実験的な反論がすでに出ていた。
3. 2023年から2024年には、Naive RAGの欠点を補うAdvanced／Modular RAG、階層索引、自己検証、Graph RAGが多数提案された。
4. 2024年から2025年のGraph RAG総説は、関係構造、global sensemaking、multi-hopを主要な期待領域として整理した。
5. 2025年から2026年には、Graph方式同士と通常RAGを揃えた比較、強いrerankerを固定したablation、数十万文書までのscaling studyが現れた。
6. これらの比較では、単純QAにおける通常RAG、Sparse retrieval、Hybrid、rerankerの強さと、Graph／Agentの費用および適用範囲の狭さが再確認されている。一方で、complex reasoning、global summarization、temporal／comparisonの一部ではGraphの増分も報告されている。

したがって、現在は「Graph RAGが有望か否か」という二択ではない。提案中心だった研究領域が、どの質問に、どのGraph表現を、どのbaselineと費用条件で使うと増分が出るのかを切り分ける段階へ移っている。

## Dense retrievalは規模が増えると難しくなるのか

### 2021年から存在するDense scalingへの警告

[The Curse of Dense Low-Dimensional Information Retrieval for Large Index Sizes](https://aclanthology.org/2021.acl-short.77/) は、Dense retrievalが大規模索引でSparse retrievalより速く劣化し得ることを、理論と実験の両面から示したACL 2021の査読論文である。低次元空間へ多数の文書を詰め込むほど、質問と無関係なのに近傍へ入るfalse positiveの確率が上がる。条件によっては、索引規模のある地点でSparseとDenseの順位が逆転する。

この論文が示したのは「Denseは常にBM25より弱い」ことではない。劣化率が表現次元と索引規模に依存し、小規模benchmarkで得たDense優位を大規模索引へそのまま外挿できないということである。embedding model、次元、hard negative学習、候補数を変えれば転換点も変わる。

### 「BM25 Wins at Scale」が追加した証拠

指定された[Hugging Face Papersの論文](https://huggingface.co/papers/2607.26497)、[BM25 Wins at Scale: A Scaling Study of Retrieval-Augmented Generation Paradigms](https://arxiv.org/abs/2607.26497) は、2026年7月31日改訂のarXivプレプリントである。EnterpriseRAG-Benchの質問と基礎文書を固定し、背景文書を加えて、1,144文書・約170万tokensから511,959文書・約6億tokensまで28段階に拡張した。比較対象はBM25、DenseRAG、File-System Agent、HippoRAG 2、LinearRAG、Microsoft GraphRAG、LightRAGで、reader、top-k、評価条件を可能な範囲で揃えている。

最小tierではFile-System Agent 77.4、BM25 74.7、DenseRAG 58.1だった。規模の拡大に伴い各方式が劣化し、約1,000万コーパストークン付近からBM25が先行する。最大tierではBM25 50.5、File-System Agent 30.7、DenseRAG 29.9となった。重要なのは、BM25も74.7から50.5へ落ちている点である。BM25が大規模検索を解決したのではなく、比較方式の中で劣化が緩く、構築費用も小さかった。

この結果は2021年のDense scaling論を、企業文書、hard negative、回答生成を含むより大きな設定で再確認したものと読める。ただし、Dense側はQwen3-Embedding-0.6B、原則top 5であり、BM25＋Dense Hybrid、cross-encoder rerank、learned sparseは比較されていない。約1,000万tokensという逆転点も普遍的なしきい値ではなく、このbenchmarkの観測値である。

### 文書増加による「検索希釈」という別の論考

[When More Documents Hurt RAG](https://arxiv.org/abs/2606.11350) は、道路行政の実運用コーパスで、54文書から1,128文書へ増やすとDense＋Sparse Hybridでも正答率が75%から40%未満へ低下したと報告する。著者らが有効としたのは複雑なmulti-agent構成ではなく、組織metadataで検索対象を先に絞るdomain scopingで、P@10は0.77から0.86へ上がった。

これは2026年6月のプレプリントで、単一の運用事例を一般法則にはできない。それでも、規模問題がSparse対Denseだけではなく、同じ語彙や意味を持つ異分野文書が候補集合を希釈する問題でもあることを示している。検索器の選択とは別に、scope、metadata、document familyをどう使うかが研究論点になっている。

### 現在の理解

Dense scalingに関しては、少なくとも「索引を増やしても小規模時の相対性能が保たれるとは限らない」という知見は強い。理由として、低次元空間のfalse positive、意味的hard negative、異domainの類似文書、固定されたtop-kの狭さが挙げられる。一方、どの規模でBM25が逆転するか、強い多言語embeddingやlate interactionでも同じか、候補を広く取ってrerankすればどこまで回復するかは未決着である。

## BM25再評価は何を意味するのか

2026年の文献で再評価されているのは、古典BM25そのものだけではなく、固有名、番号、数値、専門語を保持するlexical／sparse signal全体である。

[T2-RAGBench](https://aclanthology.org/2026.eacl-long.8/) は、文章と表を含む23,088件のQAを用いたEACL 2026の査読論文で、SparseとDenseを組み合わせるHybrid BM25を最も有効な取得方式と報告した。表の数値や列名のように語彙一致が重要である一方、質問と文書の表現差にはDenseが役立つためである。

同じtext-and-table領域で10方式を比較したプレプリント[From BM25 to Corrective RAG](https://arxiv.org/abs/2604.01733) では、BM25がDense単独を上回り、Hybrid候補をneural rerankerで絞る構成がRecall@5 0.816、MRR@3 0.605で最良だった。HyDE、multi-query、adaptive retrievalは正確な数値を問う質問では改善が限定的で、contextual retrievalは比較的一貫して改善した。

会話型QAでも、EACL 2026 Student Research Workshopの[Comprehensive Comparison of RAG Methods Across Multi-Domain Conversational QA](https://aclanthology.org/2026.eacl-srw.17/) は8データセットを比較し、rerank、Hybrid BM25、HyDEのような比較的単純な方式が安定した一方、高度な方式の一部はdatasetによってNo-RAGを下回ると報告した。ここでも、一方式の普遍的な勝利より、datasetと会話turnへの依存が強調されている。

ただし、「Sparseが強い」を「古典BM25だけを使えばよい」と読み替えるべきではない。[GigitAI at SemEval-2026 Task 8](https://aclanthology.org/2026.semeval-1.389/) では、learned sparseのSPLADE-v3がBM25を上回り、DenseとのHybridとrerankerを組み合わせた。この種の結果は、現在の再評価対象が語彙信号を捨てない検索であり、その実装はBM25、learned sparse、query expansionを含み得ることを示す。

BM25が強く見える理由もdomainごとに異なる。企業文書や表では識別子、製品名、規程番号、日付、正確な数値が重要である。大規模索引では、それらを共有しない文書を語彙的に排除できる。一方、言い換え、目的、原因、暗黙の関係を問う質問ではDenseが候補を救う。この補完性がHybrid論の基礎になっている。

## Graph RAGのサーベイと比較研究は何を示すか

### 初期の期待は関係探索とglobal sensemakingにあった

Graph RAGが解こうとした問題は一つではない。既存Knowledge GraphへのQA、文書から抽出したentity-relation graphの探索、文書クラスタの階層要約、個人記憶や履歴graph、global corpus summarizationが同じ名称の下にある。

Microsoftの[From Local to Global: A Graph RAG Approach to Query-Focused Summarization](https://www.microsoft.com/en-us/research/publication/from-local-to-global-a-graph-rag-approach-to-query-focused-summarization/) は、通常のRAGが苦手とするコーパス全体の主題や傾向を問うglobal questionを主要な問題とした。entity graphからcommunityを作り、community summaryを段階的に集約する。これは、一つの規程番号や局所的な事実を探す検索の代替というより、global sensemakingのための方式である。

2024年と2025年の二つのGraph RAG総説は、この可能性を広く体系化した。しかし、総説が示すのは「Graphをどこへ挿入できるか」であり、「flatなHybrid RAGより平均的に強い」という実証ではない。その実証を試みたのが、その後の横断比較である。

### 統一比較では、質問型によって勝者が変わる

[RAG vs. GraphRAG: A Systematic Evaluation and Key Insights](https://arxiv.org/abs/2502.11371) の2026年3月改訂版は、Dense RAG、RAPTOR、KG triplet、Community local／global、HippoRAG 2を、同じchunk、embedding、generatorに近い条件で比較した。Natural Questionsでは通常RAGのF1 64.78に対し、HippoRAG 2は61.03、Community Localは63.01だった。MultiHop-RAGでは通常RAG 67.02、RAPTOR 68.78、Community Local 69.01、HippoRAG 2 70.27となり、Graph系の一部が上回った。

同研究の読み方は、「Graphはmulti-hopで強いが、それ以外では弱い」という傾向を支持する。ただし差は方式によって異なり、Graphであれば一律に改善するわけではない。Global Community Searchは細部を要約で失いやすく、detail-oriented QAや情報不足質問に弱かった。Knowledge Graphでは必要entityが抽出されず、answer entity coverageが約65%にとどまる問題も報告された。

また、通常RAGとGraphRAGを質問ごとに選ぶSelection、両方の根拠を使うIntegrationも評価された。MultiHop-RAGとLlama 3.1-70Bの条件では、最良単独方式に対しSelectionは1.1%、Integrationは6.4%改善した。ただし通常RAG側はDense baselineで、十分に調整されたBM25＋Dense＋cross-encoder rerankではない。Graphの増分が強いHybrid baselineに対しても残るかは、この論文だけでは分からない。

[When to use Graphs in RAG](https://arxiv.org/abs/2506.05690) の2026年2月改訂版は、7つのGraph frameworkを、fact retrieval、complex reasoning、contextual summarization、creative generationで比較した。単純なfact retrievalでは通常RAGが同等以上だった一方、一部Graph方式はcomplex reasoning、summarization、creative taskで改善した。ただしGraph方式間の分散が大きく、prompt量もHippoRAG 2の約1K tokensからLightRAGの約100K tokensまで桁が異なった。「Graphを使うか」より「どのGraph表現を、どの質問へ、どのcontext budgetで使うか」が本当の比較軸である。

### multi-hopでさえGraphの効果は自動的ではない

2026年7月のプレプリント[When Do Multimodal and Graph-Augmented RAG Help?](https://arxiv.org/abs/2607.16604) は、1,000ページの文書QAでtext、graph、visual、combined retrievalを分離し、single-passage、multi-hop、figure questionを評価した。Knowledge Graph追加は、複数のgeneratorと質問型を通じて信頼できる精度向上を示さず、multi-hopでも明確な利益が出なかった。

この研究は一つの文書集合と一つのGraph設計に限られ、Graph RAG全体を否定するものではない。しかし、「質問がmulti-hopである」だけではGraphの有効条件として不十分だと分かる。必要な関係がGraphへ正しく保存され、queryから適切なseed nodeへ到達し、経路展開が必要な原文を持ち込み、追加noiseが経路情報の価値を上回らないことまで必要である。

### 強いrerankerの後ではGraph expansionの増分が消えるという報告

[Beyond the Reranker](https://arxiv.org/abs/2606.28367) は、PDF、Markdown、code、表、proseが混在するHetDocQAと既存benchmarkを使い、強いlistwise rerankerを固定して、HyDE、RAPTOR、cross-document tier、Graph PageRank expansion、RRF、routing、Corrective RAGなどをablationした。

HetDocQAではrerankerを外すとnDCG@10が0.644から0.034、回答F1が0.548から0.249へ大きく低下した。複数benchmarkで統計的に安定したのはrerankerで、HyDEとscore calibrationは一部datasetで改善したが、Graph expansion、RAPTOR、cross-document tier、RRF、router、Corrective RAGは強いrerankerの上で信頼できる増分を示さなかった。

この結果にも限定がある。first-stage retrievalはDenseで、RRFはBM25＋Denseの比較ではなく、Graphも一つのPageRank expansionである。test sampleで有意差がなかったことは効果が厳密にゼロという意味ではない。それでも、候補poolに必要根拠が入り、強いrerankerが上位を選べる条件では、候補の追加・再配置を行う複雑なmoduleの限界利益が小さくなり得るという重要な反論である。

### 大規模構築の壁

「BM25 Wins at Scale」でGraph系が直面した最大の問題は、回答精度以前に索引を構築できる規模だった。HippoRAG 2とLinearRAGは131,876文書まで、Microsoft GraphRAGは8,750文書まで、LightRAGは2,254文書までで評価が止まった。full-scale buildの外挿は、HippoRAG 2で約29億generation tokens・約3日、Microsoft GraphRAGで約79億tokens・約50日、LightRAGで約1,020億tokens・単一instance約4年だった。

したがって、この論文を「完成した50万文書Graph indexがBM25に負けた」と要約するのは正確でない。実際には、Graph方式は共有できた小さなtierでBM25を上回らず、多くは最大tierまで構築できなかった。これはGraphの推論能力だけでなく、更新、再構築、LLM抽出費用を含むsystem-level scalingへの批判である。

同論文の500問は470問がsource-grounded、10問が高レベル質問、20問がnot-foundで、global／relational questionが中心ではない。Graphに不利な分布である一方、一般的な企業QAでrelational questionが少数なら、その少数のために全コーパスをGraph化する費用を正当化できるかという実務的な問いを突きつけている。

## Hybrid RAGを詰めるという論考

Hybridが有力だという文献上の主張は、「BM25とDenseのscoreを固定比率で足す」という一手法より広い。多くの成功例は、次の段階を分けている。

1. metadataやdomainで検索範囲を制御する。
2. SparseとDenseを独立した候補生成laneとして使う。
3. score normalization、weighted fusion、RRFなどで候補を統合する。
4. cross-encoderまたはlistwise rerankerで広い候補を少数へ絞る。
5. 必要な質問だけquery expansion、relation expansion、corrective retrievalを起動する。
6. 最終的な根拠量と回答品質を同じtoken budgetで測る。

T2-RAGBench、From BM25 to Corrective RAG、会話型QA比較、SemEvalのシステム報告は、Sparse＋Dense＋rerankという実務的な収束を支持する。Beyond the Rerankerは、その中でもrerankerの寄与が大きく、後付けの高度なmoduleは強いbaselineの上で検証し直す必要があると主張する。When More Documents Hurt RAGは、Hybridであってもscopeを誤れば規模拡大に耐えないと補足する。

一方、Hybridが常に各単独方式を上回るわけではない。SparseとDenseの誤りが相関している場合、fusionしても候補Recallは増えない。score scaleが異なるままweighted sumすると一方のlaneが消える。候補数が狭ければrerankerは取得漏れを救えない。質問型やdomainごとに勝者が変わるのに、全体平均で一つの重みを選ぶと少数群を悪化させることもある。

したがって、現時点の「Hybridを詰める」という論考は、華やかな新方式がないという意味での停滞というより、評価対象が単一retrieverからretrieval pipeline全体へ移ったことを表す。進歩の単位が新しいindex名ではなく、candidate recall、fusion、rerank、scope、cost、回答時の根拠利用へ細分化されたとも言える。

## Agentic RAGとroutingをめぐる見解

Agentについても、全文書探索を置き換える立場と、ranked retrieval後の分解・統合に使う立場が分かれている。

「BM25 Wins at Scale」の最大tierにおける150問の追加実験では、raw file treeを探索するFile-System Agentは36.9、BM25は54.8だったが、Agentへ最初にBM25結果を与えるAgent+BM25は69.4へ上がった。文書recallは36.8から72.4へ改善し、質問あたりの使用tokensは895Kから101Kへ減った。この結果は、Agentic reasoningがglobal candidate discoveryを代替するより、ranked discoveryの後でquery decompositionやevidence synthesisを行う方が有効だという論考を支える。

[RAGRouter-Bench](https://arxiv.org/abs/2602.00296) は、7,727質問、21,460文書、5つのRAG paradigmを比較し、すべての質問に最適な単一方式はなく、queryとcorpusの相互作用に応じたroutingの余地があると報告した。これはrouterの上限可能性を示す。一方、Beyond the Rerankerでは実装されたrouterが強い固定baselineを上回らなかった。方式ごとのoracle差が存在することと、その差を実用的なrouterが予測できることは別問題であり、ここは現在も未決着である。

## 主要文献の位置づけ

| 文献 | 種別・状態 | 主な対象 | 報告された論点 | 読む際の制約 |
|---|---|---|---|---|
| RAG Survey, Gao et al. | arXiv総説、2024年最終改訂 | RAG全般 | Naive／Advanced／Modular RAGの体系 | 方式間の統一性能比較ではない |
| Graph Retrieval-Augmented Generation: A Survey | arXiv総説、2024 | Graph RAG全般 | indexing／retrieval／generationのtaxonomy | 効果量のsystematic evaluationではない |
| Retrieval-Augmented Generation with Graphs | arXiv総説、2025 | domain別Graph RAG | GraphRAGの広い構成要素と応用 | 既存Graphと文書由来Graphを含み異質性が高い |
| Curse of Dense Low-Dimensional IR | ACL 2021査読 | 索引規模 | Denseは規模と低次元性によりSparseより速く劣化し得る | 現在の全embedding architectureを網羅しない |
| BM25 Wins at Scale | arXiv preprint、2026 | 1,144〜511,959文書 | 大規模でBM25がDense／Agentより緩やかに劣化、Graphは構築壁 | Hybrid、reranker、learned sparseを未比較 |
| T2-RAGBench | EACL 2026査読 | 文章＋表QA | Sparse＋DenseのHybrid BM25が最良 | text-and-table領域に限定 |
| From BM25 to Corrective RAG | arXiv preprint、2026 | 文章＋表QA | Hybrid＋neural rerankが最良 | T2系列の単一領域 |
| RAG vs. GraphRAG | arXiv preprint、2026年改訂 | 通常RAGと複数Graph方式 | single-hopは通常RAG、multi-hopは一部Graphが優位 | 通常baselineがDense中心 |
| When to use Graphs in RAG | arXiv preprint、2026年改訂 | 7 Graph framework、4 task群 | simple factは通常RAG、一部複雑taskはGraph | framework間の費用とprompt量の差が大きい |
| Multimodal and Graph-Augmented RAG | arXiv preprint、2026 | 文書QA 1,000ページ | Graph追加はmulti-hopを含め安定改善せず | corpusとGraph設計が限定的 |
| Beyond the Reranker | arXiv preprint、2026 | heterogeneous document QA | 強いreranker後はGraph等の追加効果が不明確 | BM25＋Dense Hybrid自体のablationではない |
| When More Documents Hurt RAG | arXiv preprint、2026 | 行政文書の運用事例 | 文書増加でHybridも希釈、domain scopeが改善 | 単一deploymentからの報告 |
| RAGRouter-Bench | arXiv preprint、2026 | adaptive routing | 質問ごとに最適方式が異なる | oracle余地と実router性能は別 |

この表から分かるように、Graph RAGの体系を示す総説はすでに複数あるが、効果に関する強い合意を作っているのは総説ではなく、後発の比較研究である。そして比較研究の多くは2026年のpreprintで、再現、追試、査読を待つ段階にある。現時点の知見は方向性としては収束しつつあるが、最終決着と呼べる成熟度ではない。

## 研究間で結果が割れる理由

### 質問分布

単一事実、固有名、番号、数値が多いbenchmarkではSparseが有利になる。比較、時間順序、複数文書の関係、コーパス全体の傾向が多ければ、Graphやdecompositionの機会が増える。「平均点」だけでは、質問構成の違いを方式差と誤認しやすい。

### 通常RAG baselineの強さ

Graph論文の通常baselineがvanilla Dense top-kである場合、Graphの候補拡張や要約の増分が大きく見える。BM25、Dense、広いcandidate pool、cross-encoder rerank、metadata filterまで含むbaselineにすると、その増分が消える可能性がある。RAG vs. GraphRAGとBeyond the Rerankerの見かけ上の違いは、このbaseline差で一部説明できる。

### Graphの作り方

Graphが既存の正規Knowledge Graphなのか、LLM抽出したentity graphなのか、chunk間類似graphなのか、community summary treeなのかで性質が異なる。抽出Graphはrelation recallを失い、要約Graphは細部と引用可能な原文を失い、類似graphはsemantic retrievalのnoiseを別形態で引き継ぐ。

### 候補発見と推論の混同

GraphやAgentが失敗したとき、必要文書へ到達できなかったのか、到達後の推論を誤ったのかを分けない評価が多い。Agent+BM25の改善は、推論能力より先にcandidate discoveryを安定させる必要を示す。Graphについても、seed retrieval、node linking、edge traversal、text groundingを分離しないと原因が分からない。

### 評価予算

同じtop-kでも、Graph summary一件と原文chunk一件はtoken量が異なる。Graph方式は索引構築時のLLM tokens、storage、更新費、query時の展開量を含む。回答精度だけを比較すると、数十倍から数千倍の構築費を隠す。逆に、global summarizationのように通常RAGでは答えにくいtaskでは、費用が高くてもGraphを使う価値があり得る。

## 現時点で支持される知見と、未決着の論点

### 複数研究が同じ方向を示す知見

- Dense retrievalは、小規模benchmarkの優位を大規模索引へそのまま維持できず、Sparseより速く劣化する場合がある。
- BM25を含むlexical／sparse retrievalは、企業文書、表、数値、固有名、識別子、大規模索引で依然として強いbaselineである。
- SparseとDenseには補完性があり、候補を統合して強いrerankerで絞る構成は、複数domainで有力な実務baselineになっている。
- Graph RAGは単純なfact retrievalの全面的な代替ではなく、complex reasoning、multi-hop、temporal／comparison、global summarizationなどに価値が偏る。
- multi-hopというラベルだけではGraphの改善を保証しない。Graph coverage、seed retrieval、原文grounding、noise、context budgetが揃う必要がある。
- GraphとAgentは、全コーパスの最初の候補発見より、ranked retrieval後の限定的な展開や統合へ置く方が成功しやすいという証拠が増えている。
- 新しいmoduleの効果は、強いHybridとrerankerをbaselineにすると小さくなることがある。

### まだ決着していないこと

- 最新の大規模・多言語embedding、late interaction、より大きなベクトル次元でもDenseの転換点がどこに来るか。
- BM25＋Dense＋強いrerankerを数十万文書へ拡張したとき、BM25単独に対する増分が維持されるか。
- learned sparseが古典BM25をどのdomainで安定して上回るか。
- Graphが有効な質問を、実行前に十分な精度と低コストで識別できるか。
- 全面Graph構築ではなく、検索済みEvidenceから一段だけrelationを展開する方式が、費用対効果を改善するか。
- retrieval metricの小さな改善が、引用、忠実性、拒答、長文回答の品質へ実際に結びつくか。
- 2026年に集中するpreprintの結果が、独立再現と査読を経ても維持されるか。

## Fragrach内の現在の調査状況との対応

Fragrach内の評価は、外部文献と同じ傾向を一部示している。ただし、最大でも500文書規模であり、「BM25 Wins at Scale」の50万文書級scalingを再現したものではない。以下は文献上の一般知見ではなく、ローカルな観測である。

初期のRaw Dense・Hybrid検索評価では、500文書、2,461 chunks、100問で、Tuned SparseがR@5 74.0%、R@10 89.5%、Qwen Denseが48.7%／79.5%、Ruri Denseが65.7%／86.5%だった。Qwen HybridのSparse比率0.85は75.0%／91.5%で、Sparseに対する増分は小さいが存在した。保留27問ではR@5が70.4%から72.2%へ上がり、R@10は85.2%で同じだった。現行の結果は[最終評価](../evaluations/final-metrics_ja.md)を正とする。

Conflict両側@10はHybridで92.3%から96.2%へ改善した一方、両側を取得できた質問で正規側を上位へ置くResolution Accuracyは83.3%から80.0%へ下がった。これは、Denseが関係文書を追加で拾えても、現行版、正本、例外を関連度だけで決められないことを示す。

[長文企業コーパス先行評価](../evaluations/longform-pilot-2026-08-02_ja.md) は、288文書、144問、4領域で、1024設定のBM25がR@5／R@10／R@20で58.0%／66.7%／89.2%、Ruri Denseが58.1%／75.7%／86.7%、Hybrid 0.85が59.5%／68.4%／90.9%だった。R@5とR@20はHybrid、R@10とRelation Path@10はDenseが最良で、領域別の勝者も異なった。この結果は「BM25が常勝」ではなく、Sparseを捨てないHybrid baselineが妥当だという外部文献の読みと整合する。

同評価のLightRAG先行6問では、NaiveとHybridの検索精度は同じで、平均検索時間は117msと9,923msだった。[P1外部OSS検索比較](../evaluations/p1-open-source-comparison-2026-08-02_ja.md) でも、LightRAGはNaiveとGraph Hybridが同値、CogneeはChunksがGraph Hybridを上回った。小標本なのでGraph一般への結論にはできないが、少なくとも現在のFragrach質問群では、Graphの有無よりembedding、検索単位、原文保持、relation coverageの影響が大きい。

[Fragrachの方式整理と差別化戦略](../research/fragrach-differentiation-strategy-2026-08-02_ja.md) では、30問の回答比較でActual Relation DossierがRaw Tuned + Purposeに対し、R@5を58.3%から75.0%、引用再現率を56.7%から80.0%、Strict Passを23.3%から53.3%へ改善した。一方、R@20は90.0%から88.9%へ低下し、入力tokensは3.21倍、待ち時間は3.99倍だった。これは全面Graph RAGの優位ではなく、版、時点、権威、矛盾を回答前に編成する限定的なrelation処理の初期証拠と位置づけるべきである。

Fragrach内で未検証なのは、数千〜数万文書のnested scaling、BM25＋Denseの広い候補を同一cross-encoderでrerankする条件、learned sparse、Graphが得意なglobal／multi-hop質問を十分に含む評価、同じtoken budgetでの最終回答比較である。この未検証範囲を残したまま、BM25、Hybrid、Graph、Fragrachの普遍的な優劣は決められない。

## 調査から見える現在地

現在の文献には、たしかに「高度なRAG方式が増えた割に、強いSparse／Hybrid／rerankへ戻っている」という論考がある。Denseの規模劣化は2021年から知られ、2026年の大規模研究が企業文書と回答生成を含む条件で再び示した。Graph RAGの総説は方法の広がりを示したが、後発の横断比較は、その有効範囲をmulti-hop、complex reasoning、global summarizationなどへ狭め、強いrerankerや構築費を含めると増分が消える例も報告している。

一方で、これは「研究がまったく進歩していない」ことの証明ではない。Graphによってglobal questionを扱う方法、質問ごとに方式を選ぶという問題設定、retrievalの各段階をablationする評価、索引構築費を含むscaling評価は進んだ。その結果として明らかになったのが、単一の万能retrieverではなく、Sparse、Dense、rerank、scope、relation、generationを分離し、質問とコーパスに応じて組み合わせる必要性である。

したがって、2026年8月時点の研究状況は「Hybrid RAGが普遍的な最終解」と確定した状態ではない。より正確には、強いHybrid＋rerankが新方式を評価する際の最低baselineになりつつあり、GraphやAgentはそのbaselineで残る特定の失敗を、追加費用に見合う形で解けるかを問われている段階である。
