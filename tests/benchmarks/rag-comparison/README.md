# Raw RAGとFragrachの比較評価

このベンチマークは、同じSource Corpusから作った通常のRAGとFragrach経由のRAGを、同じ質問と正解根拠で比較する。検索方式やモデルの差ではなく、RAGへ投入する知識をコンパイルした効果を測ることが目的である。

## 比較する三つの系統

| 系統 | 索引へ入れる内容 | 確認する効果 |
|---|---|---|
| `raw-rag` | `sources/`の文書を通常どおり分割したチャンク | 比較の基準値 |
| `compiled-data` | Fragrachが生成したClaim、Evidence、Conflict | 投入データを改善した効果 |
| `full-fragarach` | `compiled-data`にRetrieval ProfileとAnswer Contractを適用 | Fragrach全体の効果 |

`raw-rag`と`compiled-data`では、Embeddingモデル、Vector Store、生成LLM、検索件数、温度、最大出力Tokenを同じにする。`full-fragarach`だけは、Fragrachが生成した検索・回答仕様を使うため、設定差を含む製品全体の評価となる。

索引対象はコーパスの`sources/`だけである。`evaluation/`、`ground-truth/`、`intents/`、`scenarios/`を索引へ入れると正解が漏れるため、入力してはならない。

## 一件の評価結果

各系統は、一質問につき一行のJSONLを出力する。`question_id`はコーパスの`evaluation/questions.jsonl`と対応させる。

```json
{
  "question_id": "DR-001",
  "answer": "外部仕様に影響するため、実装前の設計レビューが必要です。",
  "retrieved_evidence": [
    {
      "source": "sources/20-quality-assurance/standards/design-review-standard-v2.md",
      "section": "レビューが必要な変更",
      "rank": 1
    }
  ],
  "citations": [
    {
      "source": "sources/20-quality-assurance/standards/design-review-standard-v2.md",
      "section": "レビューが必要な変更"
    }
  ],
  "behavior": "answer",
  "judgment": {
    "satisfied_answer_elements": [
      "外部仕様に影響する変更",
      "実装開始前に設計レビューが必要"
    ],
    "present_forbidden_answer_elements": [],
    "unsupported_citations": []
  },
  "usage": {
    "input_tokens": 1400,
    "output_tokens": 90,
    "latency_ms": 850
  }
}
```

`retrieved_evidence`は検索器が返した順序を`rank`で記録する。`required_evidence`に`content_terms`がある質問では、文書と見出しだけでなく、`retrieval_text`に必要な本文語が含まれる場合だけ取得成功とする。同じ見出しにある別段落を正解として数えないためである。`citations`には最終回答が実際に根拠として示した箇所を入れる。パスはコーパスを起点とする`/`区切りの相対パスに統一する。

`judgment`は回答生成とは別の判定処理が付与する。判定時には系統名を隠し、同じモデル、プロンプト、温度を使用する。人手で判定する場合も、`questions.jsonl`にある期待要素のうち満たしたものと、実際に現れた禁止要素だけを記録する。`judgment`を省略した場合、評価器は単純な部分文字列一致へ切り替わるため、言い換えを含む本評価には適さない。

## 集計

三つの結果が揃ったら、次のように実行する。

```powershell
node tests/benchmarks/rag-comparison/evaluate.mjs `
  --run raw-rag=artifacts/raw-rag.jsonl `
  --run compiled-data=artifacts/compiled-data.jsonl `
  --run full-fragarach=artifacts/full-fragarach.jsonl `
  --top-k 5 `
  --json-out artifacts/comparison-report.json
```

評価器は次の値を系統別に集計する。

- `evidence_recall_at_k`: 上位k件に正解根拠が含まれた割合
- `citation_recall`: 最終回答が正解根拠を引用した割合
- `answer_element_recall`: 必須回答要素を満たした割合
- `behavior_accuracy`: 回答、競合開示、時点解決、情報不足の動作が期待と一致した割合
- `forbidden_error_rate`: 禁止された誤答を一つ以上含んだ質問の割合
- `unsupported_citation_error_rate`: 根拠にならない引用を含んだ質問の割合
- `strict_pass_rate`: 必須要素、根拠取得、引用、期待動作をすべて満たし、禁止誤答と不正な引用がない質問の割合

品質指標は全質問の平均として計算し、Tokenと応答時間は別に表示する。費用や速度を品質点へ混ぜないことで、品質向上と運用コストの交換条件を確認できる。

## 実行順序

最初に各系統で固定質問すべてを実行し、回答、検索結果、引用、利用量を保存する。次に、回答生成とは独立した判定処理で`judgment`を付ける。最後にこの評価器で集計し、Intent別およびタグ別のStrict Pass率を確認する。

LLMの揺らぎを測る場合は、同じ条件で複数回実行し、一回ごとに別の結果ファイルを作る。比較の初期段階では、まず一回の実行で契約と失敗分類が正しく機能することを確認してから反復回数を増やす。

このディレクトリの評価器は、結果の検証と集計だけを担当する。Embedding、Vector Store、回答生成、LLM判定の実装は、各系統のアダプター側で行う。

## T0／T1動的文書評価

`aobane-industries-ja-dynamic-validity`は、初期文書だけの`T0`と、旧版、追補、例外、未承認案、管理外copy、承認台帳などが加わった`T1`を同じ質問で評価する。通常のRecall@5とAnswer Accuracyに加え、回答がその時点で有効な完全根拠に基づくかをDVAAで測る。全問を分母とする`DVAA-Gross`、完全根拠がtop-kに揃った質問だけを分母とする`DVAA-Net`、その分母である`Evidence Ceiling`を併記する。指標の定義と比較条件は`docs/requirements/03-fragrach-requirements-definition-and-evaluation_ja.md`を参照する。

Vanillaは固定設定ではなく、`T0`の開発質問でchunk、BM25、日本語n-gram、Ruri／Qwen3 Dense、RRF重みを探索する。その勝者を固定して`V-Frozen/T1`へ適用し、さらに`T1`の開発質問で同じ探索をやり直した`V-Retuned/T1`と比較する。

```powershell
npm run benchmark:dynamic-validity:tune
npm run benchmark:dynamic-validity:answers
```

結果は`target/benchmarks/dynamic-validity/`へ出力する。

2026年8月4日の16問探索pilotでは、T0とT1の探索がどちらもQwen3 Dense単独を選び、holdoutのRecall@5とAnswer Accuracyは全Vanilla条件で100%だった。一方、DVAA-Fullは`V-Frozen/T0`の100%から`V-Frozen/T1`の87.5%へ低下し、`V-Retuned/T1`も87.5%に留まった。このpilotは実装と評価の識別性を確認した過去の小標本であり、Ruriへ統一した正式比較には含めない。

正式なスケーリング確認には`aobane-industries-ja-dynamic-validity-scale`を使う。T0の838文書へT1で150文書を追加し、100問を系列単位で開発40問とholdout 60問に分ける。動的文書の中央値は3,304文字で、EmbeddingはRuri、readerはLunaへ固定する。

```powershell
npm run corpus:dynamic-validity-scale:generate
npm run corpus:dynamic-validity-scale:check
npm run benchmark:dynamic-validity-scale:tune
npm run benchmark:dynamic-validity-scale:fcompile
npm run benchmark:dynamic-validity-scale:fcompile-retrieval
npm run benchmark:dynamic-validity-scale:answers
```

初回測定では、Vanillaのholdout Recall@5がT0の100%からT1固定適用の95.8%へ低下し、T1再調整で100%へ戻った。一方、T1で必要な規範本文と管理台帳の組はVanillaのtop-5に一問も揃わず、DVAAはFrozen／Retunedとも0%になった。その後、四値Position、不可分Dossier、決定的Decision Packet、source ID anchorからの専用lane、根拠用途の機械展開を順に実装した。同じfresh Buildの内部比較では、dense-onlyがCeiling 73.3%、Net 59.1%、Gross 43.3%、Decision Packet laneがCeiling 98.3%、Net 100.0%、Gross 98.3%だった。さらに200系列へ拡大し、Relation component単位のPacket選択をdevelopmentで固定した後、未使用120系列240問を一度だけ評価した。final holdoutはCeiling 98.3%（236/240）、Net 100.0%（236/236）、Gross 98.3%（236/240）だった。これは同一生成template内の容量評価であり、製品精度やVanillaへの一般的優位性ではない。設計、結果、制限は`docs/evaluations/dynamic-validity-scale-pilot-2026-08-04_ja.md`へ記録している。

表記揺れに対する実践テストでは、別の100系列200問へ複数の語彙・表記変換を重ね、評価splitを見ずに固定したBM25、Ruri Dense、HybridとDecision Packetを比較する。RuriとLuna以外のモデルは使わない。

```powershell
npm run corpus:dynamic-validity-practical:generate
npm run corpus:dynamic-validity-practical:check
npm run corpus:dynamic-validity-practical:chunks
npm run benchmark:dynamic-validity-practical:fcompile
npm run benchmark:dynamic-validity-practical:retrieval
npm run benchmark:dynamic-validity-practical:answers
```

正式な`k1=0.9`条件では、Raw Ruri DenseのRecall@5は92.75%、Evidence Ceilingは9.0%、DVAA-Grossは0%だった。同じDense anchorをFragrach Packetへ展開すると、Recall@5は97.5%、Evidence Ceilingは97.5%、Answer Accuracyは98.5%、DVAA-Grossは96.0%となった。これは助数詞と頻度表現の意味同値を全条件で正規化して既存回答を再採点した値である。固定Hybridはこの表記揺れ集合でDense単体を下回ったため、「Hybridが常にDenseより強い」という結果ではない。詳細と制限、初回失敗19件の分類は同じ評価記録の「未見系列・複合表記揺れによる実践テスト」に記載している。

同じLuna回答を固定し、確認台帳除去とPosition用途反転へのDVAA応答を再計算する。

```powershell
node tests/benchmarks/rag-comparison/analyze-dynamic-validity-decision-packet.mjs `
  --input target/benchmarks/dynamic-validity-scale-decision-packet-eval-v1
```

## VersionQA外部データ評価

版が変化する技術文書への移植性は、VersionRAGが公開するVersionQAで確認する。外部リポジトリはGit管理外の`target/external/versionrag`へ取得し、adapterが34文書と100問を評価用形式へ変換する。EmbeddingはRuri、readerとjudgeはLunaへ固定する。

```powershell
npm run benchmark:versionqa:prepare
npm run benchmark:versionqa:chunks
npm run benchmark:versionqa:raw
npm run benchmark:versionqa:fragrach-retrieval
npm run benchmark:versionqa:answers
npm run benchmark:versionqa:rescore
npm run benchmark:versionqa:query-packets
npm run benchmark:versionqa:query-answers
```

VersionQAはGold evidence spanを持たないため、`versionqa-evidence-contracts.json`で`source_span`、`document_absence`、`version_inventory`、`semantic_diff`を原文監査して付与する。通常のDocument Recall@5は診断値として残すが、Evidence CeilingとDVAAには使わない。原文とGold回答が矛盾する質問は`disputed`として理由を残し、headlineの分母から隔離する。`benchmark:versionqa:rescore`は保存済みのLuna回答と判定を固定したまま、新契約だけで再採点する。2026年8月4日から5日の実測、失敗例、次のVersion／Diff Packet要件は`docs/evaluations/versionqa-external-pilot-2026-08-04_ja.md`に記録している。

質問相対のVersion／Inventory／Diff Packetは質問文とSource Corpusだけから決定的に作る。Gold回答、Gold文書対応、Evidence Unit annotationは生成・順位づけへ渡さない。原文矛盾7問を除く53問の再現runでは、Evidence Ceiling、LunaのAnswer Accuracy、DVAA-Gross／Netがすべて100%だった。この値は開発集合への適合確認であり、外部分布性能としては扱わない。

## MultiHop-RAGとEnterpriseRAG-Bench

VersionQAで作った質問相対Packetの外部分布確認として、MultiHop-RAGとEnterpriseRAG-Benchを使う。MultiHop-RAGはRuri Hybrid top-5からobligation別に異なる記事を揃え、記事と選択chunkを一つのEvidence Packetへ保つ。EnterpriseRAG-Benchは全511,962文書をBM25 top-10で検索し、Ruri候補再順位づけ、obligation RRF、Position Dossierを比較する。

MultiHop-RAGの凍結holdoutではEvidence CeilingがRaw 25.0%からFragrach 30.0%へ改善した。EnterpriseRAG-BenchのdevelopmentではBM25が最良で、固定6位置のDossierはdiagnostic Evidence Ceilingを63.7%から53.8%へ悪化させた。後者のholdoutにはまだ進まず、BM25を保持する選択的gateと必要根拠被覆付きspan selectorを次の改善対象とする。

実験契約、DVAA、失敗条件は[MultiHop-RAG外部分布評価](../../../docs/evaluations/multihop-rag-external-pilot-2026-08-05_ja.md)と[EnterpriseRAG-Bench外部分布評価](../../../docs/evaluations/enterprise-rag-bench-external-pilot-2026-08-05_ja.md)に記録した。

## 長文企業コーパス

長文評価では、見出し境界を保った共通token chunkをRaw、外部OSS、Fragrachで共有する。まず通常RAGのBM25、Ruri Dense、Hybridを比較する。

```powershell
uv run --with tiktoken python tests/benchmarks/rag-comparison/prepare-longform-chunks.py `
  --output target/benchmarks/longform/chunks-1024.jsonl `
  --chunk-tokens 1024 `
  --overlap-tokens 128

node tests/benchmarks/rag-comparison/run-longform-raw-comparison.mjs `
  --chunks target/benchmarks/longform/chunks-1024.jsonl `
  --output target/benchmarks/longform/raw-1024
```

Actual Knowledge Buildには、Claim、原文Evidence、短いRelation検索ヘッダーを別々に索引化するLayered Dossier条件がある。Relationが検索された場合だけ、その両端文書から質問に近い原文Evidenceを補強する。矛盾質問ではAnswer Contractが要求する「現行規則」と「更新状況」を優先し、巨大なDossier全文を一件の検索結果として返さない。

```powershell
node tests/benchmarks/rag-comparison/run-longform-actual-dense.mjs `
  --build target/path/to/knowledge-build `
  --domain manufacturing-product-design `
  --intent governance `
  --output target/benchmarks/longform/fragrach-layered
```

検索Unitへ`o200k_base`の実token数を付け、同じ固定予算で再採点する。

```powershell
uv run --with tiktoken python tests/benchmarks/rag-comparison/annotate-retrieval-tokens.py `
  --input target/benchmarks/longform/fragrach-layered/retrieval.jsonl `
  --output target/benchmarks/longform/fragrach-layered/retrieval-tokenized.jsonl

node tests/benchmarks/rag-comparison/analyze-longform-external.mjs `
  --input target/benchmarks/longform/fragrach-layered/retrieval-tokenized.jsonl `
  --canonical-chunks target/benchmarks/longform/chunks-1024.jsonl `
  --output target/benchmarks/longform/fragrach-layered-context `
  --source-prefix sources/manufacturing/product-design/governance
```

先行結果、LightRAGとの構築コスト比較、固定token診断、未解決点は`docs/evaluations/longform-pilot-2026-08-02_ja.md`へ記録している。

## P1 Graphiti比較

更新型企業文書を扱う外部OSSとのP1比較には、Graphiti用アダプターを使う。GraphitiへはSource本文とmetadataだけを時系列順に投入し、Gold質問やGold Relationは渡さない。LLMを使うKnowledge BuildはCodex App Serverの`gpt-5.6-luna`へ統一し、埋め込みだけRuriを使う。

前提はGraphiti 0.29.3を入れた専用Python環境、Neo4j Community 5.26、Java 21、Ollama上のRuriである。Neo4jの接続情報は次のキーを持つGit管理外のenvファイルへ保存する。

```text
NEO4J_URI=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=<password>
```

最初にCodex App Serverの構造化JSONL bridgeをビルドする。

```powershell
cargo build --quiet `
  -p fragarach-llm `
  --example codex_structured_chat_bridge
```

専用評価DBだけを対象に、12文書を取り込んで6問を検索する。`--reset`は設定したNeo4j graphを消去するため、他用途と共有したDBへ指定してはならない。

```powershell
$graphitiPython = "D:\tools\fragrach\graphiti-venv\Scripts\python.exe"

& $graphitiPython tests/benchmarks/rag-comparison/run-graphiti-p1.py `
  --credentials D:\data\fragrach-evaluation\neo4j\credentials.env `
  --output target/benchmarks/p1-open-source/<run-id> `
  --llm-provider codex-app-server `
  --llm-model gpt-5.6-luna `
  --reasoning-effort low `
  --reset
```

出力されたGraph factと原文provenanceを、Raw / Fragrachと同じsection・content term規則で採点する。

```powershell
node tests/benchmarks/rag-comparison/score-external-retrieval.mjs `
  --input target/benchmarks/p1-open-source/<run-id>/retrieval.jsonl `
  --output target/benchmarks/p1-open-source/<run-id>-scored `
  --source-prefix sources/manufacturing/product-design/governance
```

`graphiti_edge_hybrid_history`は版・矛盾の両側を含む履歴検索、`graphiti_edge_hybrid_current`は質問時点で無効なFactを除いた検索である。更新理由を説明するVersion Goldは旧版根拠も要求するため、主要比較にはHistoryを使い、Currentは現行値だけを返す場合の補助条件として扱う。

2026年8月2日の実測値、失敗経緯、コスト、Fragrachとの差は`docs/evaluations/p1-graphiti-comparison-2026-08-02_ja.md`に記録している。

## P1外部OSS全体比較

Graphitiに加えて、LightRAG、FastGraphRAG、Cognee、Microsoft GraphRAG Local Searchを同じ12文書・6問・Luna・Ruriで実行するadapterがある。

| 方式 | adapter | 主条件 |
|---|---|---|
| LightRAG 1.5.5 | `run-lightrag-p1.py` | `naive`、`local`、`global`、`hybrid`、`mix` |
| FastGraphRAG 0.0.5 | `run-fast-graphrag-p1.py` | PPR chunk retrieval |
| Cognee 1.4.1 | `run-cognee-p1.py` | Chunks、Hybrid |
| Microsoft GraphRAG 3.1.0 | `run-ms-graphrag-p1.py` | Local Searchが選んだText Unit |

日本語コーパスではLightRAGの既定summary languageであるEnglishを使わず、adapterの既定値`--summary-language Japanese`を使う。英語entity・relationを日本語質問で検索する不利を避けるための言語設定であり、検索後の恣意的な補正ではない。

各adapterは外部OSSごとの専用Python環境で実行する。共通する最小引数は次の形である。

```powershell
& <専用Python> tests/benchmarks/rag-comparison/<adapter>.py `
  --output target/benchmarks/p1-open-source/<run-id> `
  --working-dir D:/data/fragrach-evaluation/<system>/<run-id>
```

CogneeのローカルNeo4j条件は、Git管理外の`credentials.env`を既定で`D:/data/fragrach-evaluation/neo4j/credentials.env`から読み、Neo4j driverと対応版APOCを必要とする。Microsoft GraphRAG adapterは公式CLIの最終回答を呼ばず、Standard Indexを作った後、Local Search context builderが選んだ原文Text Unitだけを保存する。

検索出力はすべて共通Gold採点器へ渡す。

```powershell
node tests/benchmarks/rag-comparison/score-external-retrieval.mjs `
  --input target/benchmarks/p1-open-source/<run-id>/retrieval.jsonl `
  --output target/benchmarks/p1-open-source/<run-id>-scored `
  --source-prefix sources/manufacturing/product-design/governance
```

回答へ渡す実テキスト量は`o200k_base`で再計測する。

```powershell
$graphRagPython = "D:\tools\fragrach\ms-graphrag-venv\Scripts\python.exe"

& $graphRagPython tests/benchmarks/rag-comparison/measure-p1-context.py `
  --output target/benchmarks/p1-open-source/<context-run-id>
```

2026年8月2日の全結果、方式別の導入障害、context tokens、次の判断は`docs/evaluations/p1-open-source-comparison-2026-08-02_ja.md`に記録している。

## コンセプトの上限実験

Fragrach本体のClaim抽出が完成する前に、コンパイル済み知識の改善余地を確認する場合は、Oracle Compiled実験を使う。

```powershell
node tests/benchmarks/rag-comparison/run-upper-bound.mjs `
  --model gemma4:latest `
  --top-k 5
```

回答と採点のProviderは分離できる。たとえば、回答をCodex App ServerのLuna、盲検採点をOllamaのGemmaで実行する場合は次のように指定する。

```powershell
node tests/benchmarks/rag-comparison/run-upper-bound.mjs `
  --answer-provider codex-app-server `
  --answer-model gpt-5.6-luna `
  --answer-reasoning-effort low `
  --judge-provider ollama `
  --judge-model gemma4:latest `
  --top-k 5
```

Codex App Server経路は既存のRust ProviderをJSONLブリッジ経由で再利用し、構造化JSON Schemaを強制する。Ollamaの`seed`は指定できるが、Codex App Server経路にはseedを渡せないため、Luna条件は同一設定でも反復差を測る必要がある。

既定のOracle実験では、`raw-rag`がSource文書の段落を直接検索し、`oracle-compiled`が`ground-truth/expected.json`のClaim、Conflict、Alias、Version Group、Event Sequence、Missing Informationを検索する。検索器は両者とも日本語文字n-gramを使う同一のBM25で、回答と判定には同じローカルOllamaモデルを使う。

Oracleは実装済みFragrachの精度を表さない。正しく知識をコンパイルできた場合の上限を測り、通常RAGに対して改善余地があるかを確認するための実験である。Oracleでも差が出ない場合は、コーパス、質問、検索単位、製品コンセプトのいずれかを見直す。差が出た場合は、その差を実際のコンパイラがどこまで再現できるかを次の評価対象にする。

結果は既定で`target/benchmarks/rag-comparison/`へ保存される。

2026年7月28日に47文書へ拡張して実施したRaw、Oracle、Actualの結果と判定上の注意は、`UPPER_BOUND_FINDINGS_ja.md`に記録している。

500文書・100問でRaw RAGのチャンクとBM25を調整した条件、開発／保留群の検索値、Fragrachが超えるべきSparse目標は`TUNED_RAW_FINDINGS_ja.md`に記録している。

同じRaw chunksへQwen3とRuriのDense検索を追加し、BM25とのHybridを比較した結果は`HYBRID_FINDINGS_ja.md`に記録している。

## アブレーション

Actualの検索単位を切り替え、権威加点、Conflict、Alias、Claim本文、Evidence fallbackの効果を回答生成なしで比較する。

```powershell
node tests/benchmarks/rag-comparison/run-ablation.mjs `
  --compiled-build target/expanded-builds-v1/design-review `
  --compiled-build target/expanded-builds-v1/incident-response `
  --compiled-build target/expanded-builds-v1/developer-onboarding `
  --compiled-build target/path/to/data-export-operation-build `
  --top-k 5,10,20 `
  --output target/benchmarks/rag-ablation/retrieval-ablation.json
```

有望な条件を回答生成まで確認する場合は、`run-upper-bound.mjs`の`--actual-variant`を使う。`evidence-fallback`は全Evidenceを検索可能にし、`aliases`はMissing Informationの根拠へ完全重複文書の別名を伝播する。

```powershell
node tests/benchmarks/rag-comparison/run-upper-bound.mjs `
  --actual-only `
  --actual-variant evidence-fallback `
  --compiled-build target/expanded-builds-v1/design-review `
  --compiled-build target/expanded-builds-v1/incident-response `
  --compiled-build target/expanded-builds-v1/developer-onboarding `
  --compiled-build target/path/to/data-export-operation-build
```

`dossier`は、質問をAnswer Slotsへ分解し、Slot別のClaim検索、正規語展開、関連Conflictの別枠追加、Slot不足時だけのEvidence fallback、構造化回答、自然文生成を順に実行する。単一質問を調べる場合は`--question DR-001`のように質問IDを指定できる。

```powershell
node tests/benchmarks/rag-comparison/run-upper-bound.mjs `
  --actual-only `
  --actual-variant dossier `
  --question DR-001 `
  --compiled-build target/medium-builds-v1/design-review `
  --compiled-build target/medium-builds-v1/incident-response
```

回答生成を行わず、検索だけを100問で測る場合は`--retrieval-only`を使う。既定ではR/C/Pを@5、@10、@20で一度に計算し、既存16問、追加84問、Intent、Tag別の内訳も`retrieval-report.json`へ保存する。

同じレポートの`compile_coverage`は、順位やtop-kに関係なくGoldの必要根拠が各知識集合のどこかに存在する割合を示す。特に`actual_compiled`の値は、正解情報がClaimまたは関連する検索単位としてKnowledge Buildへ残ったかを測る。Compile Coverageが低い質問は抽出・検証工程、Coverageは高いのにR@kが低い質問は検索・順位付け工程の改善対象として切り分けられる。

主要な検索品質はR/C/Pで表す。R@kは必要なGold根拠の回収率、C@kは必要根拠をすべて取得できた質問率、P@kは上位k件のうち未取得Goldを新たに追加した検索Unitの割合である。同じGoldを繰り返すUnitはPへ重ねて数えないため、類似チャンクや重複Evidenceが上位を占有するとPが下がる。R/C/Pだけでは文書間関係や矛盾の扱いを表せないため、検索レポートは次の診断指標も出力する。

| 指標 | 意味 |
|---|---|
| `distractor_rate_at_k` | 上位k検索単位のうち、Gold根拠にも質問別の矛盾根拠にも一致しない単位の割合 |
| `conflict_recall_at_k` | 矛盾開示が必要な質問で、正規側と競合側のGold根拠を取得した割合 |
| `conflict_complete_rate_at_k` | 正規側と競合側を両方とも完全に取得した質問の割合 |
| `conflict_unit_recall_at_k` | FragrachまたはOracleのConflict検索単位が、矛盾の両側を参照した状態で上位kへ入った割合。Raw RAGでは該当しない |
| `resolution_accuracy_at_k` | 両側を取得できた質問のうち、正規根拠が競合根拠より上位だった割合 |
| `resolution_coverage_at_k` | Resolution Accuracyを判定できた質問が、矛盾質問全体に占める割合 |

Resolution Accuracyは両側を取得できた質問だけを分母にする。したがって、AccuracyだけでなくCoverageも併記する。質問別の正規側と競合側は`conflict_evidence`で指定し、追加Goldでは`canonical_citation`と`gold/conflicts.jsonl`から補完する。

```powershell
node tests/benchmarks/rag-comparison/run-upper-bound.mjs `
  --corpus tests/corpora/aobane-industries-ja-medium `
  --output target/benchmarks/medium-500-retrieval `
  --retrieval-only `
  --retrieval-k 5,10,20
```

`--retrieval-only`はLLMを使うAnswer Slot計画を実行しないため、`--actual-variant dossier`とは併用できない。まずRaw、Oracle、Claim baselineを検索専用評価で比較し、改善したIntentだけDossierの回答評価へ進める。

実測と判断は`ABLATION_FINDINGS_ja.md`に記録している。
