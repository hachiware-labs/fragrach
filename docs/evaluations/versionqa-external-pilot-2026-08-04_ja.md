# VersionQA外部データ評価：質問相対Packetで版差分を回答資料にする

## 結論

最初の外部分布評価では、汎用Decision Packetは版の存在と前後関係を集めたものの、指定版の本文と版間差分を質問に合わせて選べなかった。文書IDの回収はRaw Hybridの65.2%から89.4%へ上がった一方、LunaのAnswer Accuracyは58.3%から46.7%へ下がった。Positionだけを不可分にしても、質問に必要な内容を回答資料へできなければ精度は上がらない。

そこでDVAAのGoldを文書IDから本文span、不在証明、完全な版一覧、意味差分へ改め、質問を`content`、`inventory`、`change`へ分けるQuery-relative Packetを実装した。原文とGoldが矛盾する7問は理由を残して分母から除外した。残る53問をLunaで再評価した最終runでは、Evidence Ceiling、Answer Accuracy、DVAA-Gross、DVAA-Netがすべて100%になった。

これはVersionQAで一般性能100%を達成したという意味ではない。この集合は改善に使用した開発集合であり、とくに暗黙変更10問のうち6問がGold不整合で採点対象外になった。確認できたのは、通常RAGでLLMへ暗黙に委ねていた「どの版を読むか」「全版を数えるか」「どの二版を比較するか」「不在をどう証明するか」をCompilerの資料構造へ移すと、同じLunaの挙動を制御できるという点である。一般化は、方式を凍結したうえで別の二つのデータセットで測る。

## 2026年8月5日追補：Evidence Unitによる再採点

上記の制約を注記だけで済ませず、DVAAのGold根拠を文書IDから`source_span`、`document_absence`、`version_inventory`、`semantic_diff`へ変更した。通常のDocument Recall@5は診断値として残すが、Evidence CeilingとDVAAには使用しない。不在回答は対象文書IDだけでなく検証済みの不在Evidence Unit、暗黙変更は二文書IDと版順だけでなく変更対象・変更種別・両側原文を結んだDiff Unitを要求する。

Gold監査では、原文と矛盾する7問を発見した。`VQA-049`と`VQA-081`はError constructorの`options/cause`の有無、`VQA-082`はOpenSSL Error Codesの既存版への掲載、`VQA-087`はWeakMap／WeakSet例の既存版への掲載がGoldと一致しない。`VQA-084`、`VQA-086`、`VQA-088`は、文書スナップショットの版と原文中のAPI導入版`v16.7.0`、`v14.2.0`、`v22.13.0`をGoldが混同している。これらは失敗を隠すために正答扱いせず、`disputed`としてcase-levelに残し、headlineの分母から除外した。

既存のLuna回答と採点結果を固定し、検索・回答を再実行せず53問を再採点した。

| 条件 | Document Recall@5 | Evidence Unit Ceiling | Answer Accuracy | DVAA-Net | DVAA-Gross |
|---|---:|---:|---:|---:|---:|
| Raw Ruri Hybrid | 66.2% | 35.8%（19/53） | 66.0%（35/53） | 47.4%（9/19） | 17.0%（9/53） |
| Fragrach Decision Packet | 88.0% | 39.6%（21/53） | 52.8%（28/53） | 81.0%（17/21） | 32.1%（17/53） |

文書ID proxyではPacketのCeilingを88.3%としていたが、Evidence Unitでは39.6%まで下がった。RawとのCeiling差も41.6 pointではなく3.8 pointである。PacketのDVAA-GrossはRawより15.1 point高いが、これは版一覧のGrossが0%から65%へ上がったためであり、一般的な版質問の改善ではない。

| 質問群 | Raw Evidence Ceiling / Gross | Packet Evidence Ceiling / Gross |
|---|---:|---:|
| 指定版本文（19問） | 63.2% / 26.3% | 10.5% / 5.3% |
| 版一覧（20問） | 0.0% / 0.0% | 70.0% / 65.0% |
| 暗黙変更（4問） | 0.0% / 0.0% | 0.0% / 0.0% |
| 明示変更（10問） | 70.0% / 40.0% | 50.0% / 30.0% |

この再採点により、現行Packetの効果はInventoryへ限定されることが以前より明確になった。指定版本文ではGold文書IDを100%含んでいたにもかかわらず、回答spanを含む資料は10.5%しかない。暗黙変更では両文書IDを100%含んでいても、意味差分は一件も作られていない。したがって、次の改善対象は検索重みではなくVersion PacketとDiff Packetである。

Evidence Unit annotationは評価時だけ読み込み、retrieval、compile、Luna回答promptへは渡していない。実装と再採点結果は`tests/benchmarks/rag-comparison/versionqa-evidence-contracts.json`、`versionqa-evidence-score.mjs`、`target/benchmarks/versionqa/answers-evidence-unit-v3/report.json`に保存した。

## 質問相対Packetによる改善

質問文だけから文書family、要求版、質問型、比較対象を決め、次の三種類の資料を作った。Version Packetは要求版の全文だけを検査し、質問に関連するspanと検証済み不在をまとめる。Inventory Packetはfamily内の完全な版集合を一単位にする。Diff Packetは隣接版の対応spanを比較し、追加・削除・変更をBefore／Afterとともに渡す。文書スナップショット版と原文中のAPI履歴版は別の時間軸として明示した。

Packet生成にはGold回答、Gold文書対応、Evidence Unit annotationを渡していない。60問すべてで質問型、文書family、Packet生成に成功し、採点対象53問のEvidence Ceilingは100%だった。生成はLLMを使わず約13秒で完了した。

| 質問群 | 採点対象 | Evidence Ceiling | Answer Accuracy | DVAA-Gross / Net |
|---|---:|---:|---:|---:|
| 指定版本文 | 19 | 100% | 100% | 100% / 100% |
| 版一覧 | 20 | 100% | 100% | 100% / 100% |
| 暗黙変更 | 4 | 100% | 100% | 100% / 100% |
| 明示変更 | 10 | 100% | 100% | 100% / 100% |
| 全体 | 53 | 100% | 100% | 100% / 100% |

最初の改善runは52/53だった。残る`VQA-090`では、例の変更を問われたLunaがDiff内のAPI履歴`added`を不要に付記した。例・sample codeの変更質問ではBefore／Afterの文書スナップショットだけを答える一般規則を加え、freshな再現runで53/53になった。この差は、回答生成力をモデル交換で補うのではなく、回答に使う時間軸をCompilerが限定した効果である。

## データセットの位置づけ

[VersionRAG論文](https://arxiv.org/abs/2510.08109)は、版が変化する技術文書を独立したRAG課題として扱い、34文書、100件の手作業質問からなるVersionQAを公開している。論文報告値はVersionRAG 90%、Naive RAG 58%、GraphRAG 64%で、暗黙の変更検出ではVersionRAG 60%、baseline 0–10%である。実装とデータは[公開リポジトリ](https://github.com/danielhuwiler/versionrag)を参照した。

今回の評価対象は100問のうち、次の版依存60問である。

| 質問群 | 問数 | 求められる能力 |
|---|---:|---|
| Version-Specific Content Retrieval | 20 | 指定された版の本文を答える |
| Version Listing & Inquiry | 20 | 保持する版の一覧、件数、最新版を答える |
| Change Retrieval (implicit) | 10 | 明記されていない版間差分を検出する |
| Change Retrieval (explicit) | 10 | release noteなどに明記された変更を答える |

VersionQAはFragrachが対象とする動的文書の一部をよく表す。ただし、対象は主に技術文書の版系列であり、承認、権威、scope、期限付き例外、正本性は含まない。このため、本評価はFragrachの全要件を測る外部holdoutではなく、`document_id`、`revision`、版順序、変更取得の移植性を測るpilotである。

## 評価条件

公開リポジトリのcommit `2a2cbe8f285557f99dc7a79d6df7134e1e3eccff`をローカル参照し、データ自体は本リポジトリへ再配布していない。adapterはNode.js Assert 13版、Node.js Errors 9版、Bootstrap release 6版、Spark release 6版の計34文書を取り込む。PDFであるSpark 6版は全25ページをテキスト化し、先頭ページを画像として目視確認した。

各文書には、元ファイル名から決定的に作った`document_id`、`revision`、同系列内の前後関係を付与した。質問や期待回答をCompilerへは渡していない。質問のGold文書対応づけは評価時だけ使用する。

| 項目 | 固定条件 |
|---|---|
| Embedding | Ruri `hf.co/Targoyle/ruri-v3-310m-GGUF:Q8_0`、768次元 |
| Reader / Judge | Luna `gpt-5.6-luna`、reasoning effort `low` |
| Chunk | 512 token、50 token overlap、1,466 chunk |
| 検索件数 | top-5 |
| Raw Hybrid | Ruri DenseとBM25、Sparse比率0.90。VersionQAでは再調整していない |
| Fragrach compile | Luna、LLM concurrency 8、34文書を一つのBuildへcompile |
| 回答評価 | 条件名を含めない同一prompt。同じLunaで生成と別batchの判定を実施 |

論文の評価は別モデルと人手確認を含むため、今回の値を論文報告値と直接比較しない。今回の比較目的は、同じRuriとLunaのもとで、Raw Hybridから現行Fragrach Packetへ変えたときの差を確認することである。

## Compile結果と運用費

34文書のfresh compileは28分01秒を要し、5,735,763 prompt tokenと561,646 completion tokenを使用した。

| Build成果物 | 件数 |
|---|---:|
| Source document | 34 |
| Evidence | 19,024 |
| Claim candidate | 5,225 |
| Claim | 5,194 |
| Document Profile | 34 |
| Document Relation / Relation Dossier | 30 / 30 |
| LLM call | 325 |
| Warning / Error | 15 / 0 |

Relation 30件は、4系列それぞれで隣接版を結んだ本数と一致する。構造coverageは高いが、本文の大半をLLMで再解釈しており、版順序を作るだけの処理としては重い。外部データで現れた次の課題は、精度だけでなく運用上も重要である。版番号と文書familyは決定的に解析し、sectionまたは行差分を先に計算し、LLMは変更blockの意味づけに限定すべきである。

## 初回の検索結果

次表は版依存60問に対するtop-5である。`R@5`は質問ごとに必要なGold文書の回収率、`文書集合完備`は必要文書IDがすべてtop-5資料に含まれた質問率である。`旧・別版混入`は取得した同一family文書のうちGoldでない版の割合であり、同じ内容の別版が候補枠を占有する程度を示す。

| 条件 | R@5 | 文書集合完備 | Gold文書precision | 旧・別版混入 | 別family混入 |
|---|---:|---:|---:|---:|---:|
| BM25 | 65.1% | 46.7% | 35.4% | 45.0% | 19.7% |
| Ruri Dense | 61.5% | 43.3% | 40.9% | 40.2% | 18.9% |
| Ruri Hybrid | 65.2% | 46.7% | 38.1% | 44.9% | 17.0% |
| Fragrach compiled dense | 66.8% | 48.3% | 34.6% | 53.2% | 12.1% |
| Fragrach Decision Packet | 89.4% | 88.3% | 32.1% | 55.8% | 12.1% |

PacketはGold文書の回収を大きく改善した。しかし、同一familyの別版もまとめて返すため、Gold文書precisionはRaw Hybridより低く、旧・別版混入は高い。**Goldを含める能力と、必要版だけに絞る能力が反対方向へ動いた**ことが、回答結果を読む前から分かる。

質問群別では差がさらに明確である。

| 質問群 | Raw Hybrid R@5 / 文書集合完備 | Packet R@5 / 文書集合完備 |
|---|---:|---:|
| 指定版本文 | 85.0% / 85.0% | 100.0% / 100.0% |
| 版一覧 | 38.1% / 0.0% | 73.1% / 70.0% |
| 暗黙変更 | 45.0% / 10.0% | 100.0% / 100.0% |
| 明示変更 | 100.0% / 100.0% | 90.0% / 90.0% |

一覧質問では、通常top-5で13版すべてを返すこと自体ができない。全版を一つにまとめたInventory Packetは、この検索単位の不一致を正しく解消した。一方、暗黙変更で両版の文書IDが存在しても、その差分本文がPacketに入っているとは限らない。

## 初回のLuna回答と文書ID proxy

| 条件 | Answer Accuracy | 文書ID Evidence Ceiling | DVAA-Net | DVAA-Gross |
|---|---:|---:|---:|---:|
| Raw Ruri Hybrid | 58.3%（35/60） | 46.7%（28/60） | 75.0%（21/28） | 35.0%（21/60） |
| Fragrach Decision Packet | 46.7%（28/60） | 88.3%（53/60） | 39.6%（21/53） | 35.0%（21/60） |

Packetは文書ID上のCeilingを41.6 point引き上げたが、Answer Accuracyを11.6 point下げ、有効根拠付き正答の絶対件数は21問のままだった。回答生成prompt tokenもRawの402,852からPacketの609,433へ51.3%増えた。現行Packetは、より多くの版をより長いcontextでLunaへ渡しているが、回答に必要な版と差分を明示できていない。

質問群別の回答値は次のとおりである。

| 質問群 | Raw Accuracy / Ceiling / Gross | Packet Accuracy / Ceiling / Gross |
|---|---:|---:|
| 指定版本文 | 70.0% / 85.0% / 55.0% | 20.0% / 100.0% / 20.0% |
| 版一覧 | 55.0% / 0.0% / 0.0% | 85.0% / 70.0% / 65.0% |
| 暗黙変更 | 10.0% / 10.0% / 10.0% | 0.0% / 100.0% / 0.0% |
| 明示変更 | 90.0% / 100.0% / 90.0% | 70.0% / 90.0% / 40.0% |

Inventory Packetの効果は実在する。版一覧のAccuracyは55%から85%へ上がった。しかし指定版本文と変更取得では、構造化がreaderを助けるのではなく、答えを持つ原文を押し流した。

## 初回失敗が起きた同じ根

検索結果の改善と回答精度の低下は別々の問題ではない。どちらも、現行Packetが**文書の位置を表すが、質問に必要な内容を表すIRではない**ことから生じている。

### 1. Positionが現行版中心で、質問相対ではない

現行Dossierは「3.5.3が3.4.4をdominatesする」のような隣接版の位置を表す。ところがVersionQAは「2.4.7はどの種類のreleaseか」「23.11.0の特定methodのstabilityは何か」と問う。必要なのは対象版を固定し、その版の該当sectionだけを`governing`として渡すことである。

実例`VQA-042`では、Goldの23.11.0文書ID自体は資料集合に含まれていたが、検索上位は15.14.0対14.21.3などの隣接版Dossierだった。LunaはRaw Hybridでは`1.2 - Release candidate`と正答し、Packetでは`Insufficient information`と答えた。文書IDの存在だけでは、質問対象の一節が回答資料に存在することを保証しない。

### 2. 版順序は差分ではない

暗黙変更は二つの版を並べるだけでは解けない。追加、削除、変更なしをsectionまたは意味単位で比較した差分が必要である。

`VQA-081`はNode.js 17.9.1のError constructorについて「何も変わっていない」が正解である。Packetは17.9.1と16.20.2の前後関係を返したが、比較結果を持たないためLunaは`Insufficient information`と答えた。`VQA-082`ではOpenSSL error codeの変更版が22.14.0であるのに、19.9.0の隣接Dossierから19.9.0と誤答した。Position labelを内容変更の証拠として読ませたことが誤りである。

### 3. 不可分にすべき単位は質問型によって異なる

社内診断trackでは、規範本文、旧版、効力台帳を一つのDecision Packetにすることが効いた。VersionQAの版一覧では、全版を一つにしたInventory Packetが効いた。同じ原則は維持できるが、不可分にする中身は一種類ではない。

| 質問型 | 必要な不可分資料 |
|---|---|
| 指定版本文 | 対象`document_id`・`revision`と、質問に対応する原文span |
| 版一覧 | family内の完全なrevision一覧と、最新判定 |
| 版間変更 | 比較元・比較先、追加・削除・変更なしを示すDiff、双方の原文span |
| 現行効力 | 採用文書、除外文書、scope、効力台帳、未解決状態 |

一つの汎用Position Dossierへ多くの版を詰める設計では、一覧には足りず、本文質問には過剰で、変更質問には差分が不足する。

### 4. 初回Ceilingは文書ID proxyだった

VersionQAにはGold回答はあるが、Gold evidence spanはない。adapterは質問のfamilyと版指定からGold文書を対応づけた。このため、今回の`Evidence Ceiling`は「必要文書IDが資料に含まれた」ことしか判定していない。

本来のDVAAでいう完全根拠は、回答を支持する本文、変更なら比較可能な両側spanと差分、効力判断ならPositionを証明する台帳まで含む。VersionQAで計算したDVAA-Gross／Netは、版の正しさだけをhard gateにした**source-document粒度のproxy**であり、要件定義上のDVAA-Fullではない。特にPacketのNet 39.6%を「完全根拠があるのにLunaが6割失敗した」とだけ読むのは誤りである。53件のCeilingの中に、答えを持つspanがない見かけ上のCeilingが含まれる。

## 実装した判断と凍結条件

初回結果を受け、VersionQAを開発用データとして使って次の構造を実装した。

1. 質問から`target_document_id`、`target_revision`、`comparison_revision`、`query_mode`を抽出する。`query_mode`は少なくとも`content`、`inventory`、`change`、`current-validity`を持つ。
2. `content`では対象版以外のDossierを既定資料から外し、対象版内の質問関連spanを一つのVersion Packetへ入れる。
3. `change`では隣接Relationを返すだけでなく、section対応づけと追加・削除・変更なしを決定的に計算したDiff Packetを作る。LLMは曖昧な変更blockの意味づけだけに使う。
4. `inventory`ではfamilyをまたぐ製品単位の集約規則を持つ。`VQA-061`ではNode.js Errorsの9版だけを数えて誤答したため、文書familyと製品familyを分離する。
5. 回答資料ごとに、文書IDだけでなく`evidence_span_id`または`diff_id`を保持する。DVAAのCeilingはその単位で判定する。
6. 全文の再compileを避ける。文書hash、section hash、版間diff hashをcacheし、変更したsectionと依存Packetだけを再生成する。

Evidence Unit CeilingとDVAA-Grossは全質問群で100%となり、VersionQA上では資料構造と回答挙動を制御できた。ただし、改善に使った以上、この値を未知データへの一般化性能とは扱わない。以後はQuery-relative Packet、Evidence Unit契約、Ruri、Luna、top-5、回答・採点promptを凍結し、MultiHop-RAGとEnterpriseRAG-Benchへ移す。

## 再現手順と成果物

外部リポジトリはGit管理外の`target/external/versionrag`へ取得する。adapterは元データを複製せず、ローカルの取得物から評価用corpusを生成する。

```powershell
npm run benchmark:versionqa:prepare
npm run benchmark:versionqa:chunks
npm run benchmark:versionqa:raw
npm run benchmark:versionqa:fragrach-retrieval
npm run benchmark:versionqa:answers
```

実装は次にある。

- `tests/benchmarks/rag-comparison/prepare-versionqa.py`
- `tests/benchmarks/rag-comparison/versionqa-intent.yaml`
- `tests/benchmarks/rag-comparison/run-versionqa-raw-retrieval.mjs`
- `tests/benchmarks/rag-comparison/run-versionqa-fragrach-retrieval.mjs`
- `tests/benchmarks/rag-comparison/run-versionqa-answers.mjs`

実測成果物は`target/benchmarks/versionqa/`に保存した。このdirectoryは再生成可能な実験成果物であり、Git管理対象にはしない。
