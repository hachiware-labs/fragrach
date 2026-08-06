# Dynamic Validity Scale Track 初回評価

## 評価の目的

16問・27短文のpilotでは強いreaderがほぼ全問を解けたため、文書数、文書長、系列分離を増やしたscale trackを作成した。この評価の目的は、RuriとLunaへモデルを固定したうえで、T0調整済みVanillaを文書追加後も固定した場合と、T1で再調整した場合を分け、Recall@5、Answer Accuracy、DVAA-Fullが同じ動きをするか確認することである。

コーパスはT0の838文書からT1の988文書へ増える。うち788文書は既存の中規模・長文コーパスを背景文書として参照し、200文書は50の動的系列を構成する。位置づけmetadata追加後の動的文書の中央値は3,592文字である。質問は100問あり、開発40問とholdout 60問を文書系列単位で分離した。

## 比較条件

T0の開発問ではRuri Denseとsection chunkが選ばれた。T1の再調整では同じsection chunkを使い、Ruri DenseへSparseを40%融合するHybridが選ばれた。いずれもRuriだけをEmbeddingに使い、Qwen3による結果は正式値に含めていない。

`V-Frozen`はT0で決めた検索設定を文書追加後も固定し、`V-Retuned`はT1の開発問で検索設定を再調整する。`F-Compile`はGoldのProfile、Relation、質問、期待回答を使わず、同じ原文から現行Fragrachが生成したKnowledge BuildをRuri Denseで検索する。回答生成は全条件でLuna、reasoning effort `low`、top-5、同じpromptと回答schemaへ固定した。

今回の`F-Compile`は現行能力を早期確認する予備条件である。50系列200文書を系列が分断されないよう4つのBuildへ分けて並列コンパイルし、検索時に統合した。788件の背景文書はコンパイルしていないため、Vanillaとの最終的な同条件比較ではない。背景文書がないぶん検索候補はF-Compileに有利であり、この値から製品優位性は主張しない。

| 条件 | 必要文書のRecall@5 | 判断・回答値の正答 | 有効根拠付き正答（DVAA-Full） | 正答だが根拠不成立 |
|---|---:|---:|---:|---:|
| `V-Frozen/T0` | 100.0% | 100.0%（60/60） | 100.0%（60/60） | 0.0%（0/60） |
| `V-Frozen/T1` | 95.8% | 100.0%（60/60） | 0.0%（0/60） | 100.0%（60/60） |
| `V-Retuned/T1` | 100.0% | 98.3%（59/60） | 0.0%（0/60） | 98.3%（59/60） |
| `F-Compile/T1` | 98.3% | 63.3%（38/60） | 0.0%（0/60） | 63.3%（38/60） |

`判断・回答値の正答`は、Goldの`decision`と`answer_value`だけを採点する従来型のAnswer Accuracyである。説明の論理性、引用文書の適否、根拠の完全性は含まない。これに対してDVAA-Fullは、判断と回答値が正しいことに加え、回答が対象時点、scope、承認状態、権威、文書間Relationを満たす完全な根拠で成立している場合だけ1点とする。表の`正答だが根拠不成立`は両者の差であり、独立した指標ではない。

この区別により、`V-Frozen/T1`の意味が明確になる。Lunaは60問すべてで期待された回答値を返したが、回答が必要とする規範本文と管理台帳の組を検索contextに揃えられなかったため、DVAA-Fullは全問0点だった。間違った文書や不完全な文書集合から正解値を推測できても、企業判断として検証可能な回答とはみなさないのがDVAAである。

`F-Compile/T1`はRecall@5を98.3%に保ったが、判断・回答値の正答は38問に低下し、有効な完全根拠で成立した回答は0問だった。検索top-5にGoldが要求する根拠集合がすべて揃った質問は26問あったものの、Lunaが回答根拠としてその集合をすべて採用・引用した質問はなかった。したがって、現在の失敗は検索だけでは説明できない。Buildが文書関係を明確な回答材料へ変換できず、readerも分散したEvidenceから完全な根拠構成を復元できていない。

## 結果をそのまま差別化根拠にしない理由

T1 holdout 60問について、Goldが要求する根拠集合が検索top-5に完全に揃った質問は、FrozenとRetunedのどちらも0問だった。top-10でもFrozen 2問、Retuned 0問に留まる。通常検索は回答値を含む規範文書を取得できる一方、正本、承認、追補、例外、却下、同格競合を確定する別管理の台帳を同じ候補枠へ揃えられていない。したがってVanillaのDVAA 0%は採点器の異常ではないが、全問が同じ理由で失敗する床効果を含む。

現行Fragrachは200文書から10,600 Evidenceと1,905 Claimを生成した一方、Document RelationとRelation Dossierは各1件だけだった。Goldでは同じ200文書に100件のRelationが定義されている。さらに157件のConflictをすべて未解決として出力した。Buildは原文を細かい検索単位へ変換できているが、版、追補、例外、承認台帳、却下台帳、競合解決台帳を結ぶRelation compilerとしては、今回の長文・多数系列を処理できていない。

このため、F-Compileの高いRecall@5をFragrachの中核効果とは読めない。背景文書を除いた小さい候補集合と細粒度Evidenceが回答値を含む文書の取得を助けた一方、Relationがほぼないため、回答contextには大量の断片と未解決Conflictが残った。その結果、Answer AccuracyはVanillaより低下し、DVAAも回復しなかった。

## 四値Positionへの単純化パイロット

上記の失敗を受け、Compilerの主要出力を多数の独立属性から、`dominates`、`conditional`、`non_effective`、`unresolved`の四値Positionへ縮約した。文書自身の`document_id`と`revision`を内部`source_id`から分離し、細かな変更内容と理由は原文chunkへ残す。Positionは文書ID、対象文書ID、対象版、確認台帳IDを含む小さな文書管理metadataから決定的に作り、LLMが本文だけから優先関係を再推論した結果より優先する。

最初に`dvx-001`の旧版、現行版、未承認検討資料、文書管理台帳の4文書をLunaで試した。文書IDと版は4件すべて正しく保持できたが、LLMだけのPosition抽出では現行版が旧版を置き換える1件しか得られず、未承認資料と台帳証拠が落ちた。これはラベルを四値に減らすだけではRelation recallが改善しないことを示す。

そこで同じ4文書に明記したPosition metadataをCompilerが直接解決する方式へ変更した。最終Buildでは、現行版から旧版への`dominates`と、未承認検討資料から現行版への`non_effective`の期待2件を2件とも生成した。両Dossierは、関係両端だけでなく文書管理台帳の「現行正本・旧版失効・検討資料未承認」のchunkを証拠に含む。さらに判断値chunkを定型の確認文より優先してDossierへ収録したため、`dominates` Dossierには新旧の回答値と台帳根拠が同時に入った。

この結果は4文書1系列だけの構造確認であり、DVAA改善を示すものではない。ただし、旧構造の「LLMが多数属性を抽出し、readerが関係を再構成する」経路より、文書管理metadataでPositionを決め、原文chunkを証明として添付する経路の方が、期待した最小成果物を安定して作れた。初回Luna処理後、同じ入力からの再Buildは全抽出cache hitで140msだった。成果物は`target/benchmarks/document-position-pilot-dvx-001/knowledge-build-v5-final`に保存した。

## 四値Positionのscale track適用

四値Positionを50系列200文書へ適用した。各文書は内部`source_id`とは別に企業文書としての`document_id`と`revision`を持ち、変更側文書のmetadataが、対象文書ID、対象版、四値Position、確認台帳IDを宣言する。Compilerはこの明示metadataを決定的に解決し、LLMが本文から推定した競合Relationより優先する。細かな変更値、適用条件、理由は原文chunkに残した。

4 shardのBuildは200文書から10,800 Evidence、2,078 Claim、90件の`operational_position`を生成した。Position Gateは次をすべて満たした。

| Gate | 結果 |
|---|---:|
| 期待Positionとの一致 | 90/90 |
| `dominates` | 10/10 |
| `conditional` | 20/20 |
| `non_effective` | 50/50 |
| `unresolved` | 10/10 |
| 予期しないPosition | 0 |
| 確認台帳Evidenceを含むDossier | 90/90 |
| Source・Target・台帳の判断chunkを含むDossier | 90/90 |
| 100 Gold Relationの四値への写像coverage | 100/100 |

初回の全件compileはLunaで約30分を要した。誤ったLLM Relationが1件混入したため、明示Positionで管理される文書をendpointに持つ推定Relationを抑止する規則を追加した。抽出cacheを再利用した4 shardの再Buildは各約1.7～2.0秒で、最終BuildのRelationは期待した90件だけになった。これは四値化がLLMのRelation推論を自動的に改善した結果ではなく、企業側の文書管理metadataをCompilerが検証可能なIRへ変換した結果である。

### 同じRuri・Lunaによる回答評価

最終BuildをRuri Denseで検索し、従来評価と同じLuna reader、reasoning effort `low`、top-5、prompt、回答schemaでholdout 60問を再評価した。背景788文書は引き続きF-Compile候補に含めていないため、以下は旧F-Compileとの構造変更比較であり、Vanillaへの優位性比較ではない。

| F-Compile構造 | 必要文書のRecall@5 | 完全な必要根拠集合がTop-5に存在 | 判断・回答値の正答 | DVAA-Full |
|---|---:|---:|---:|---:|
| 旧・細粒度Evidence中心 | 98.3% | 43.3%（26/60） | 63.3%（38/60） | 0.0%（0/60） |
| 四値Position Dossier | 96.7% | 68.3%（41/60） | 78.3%（47/60） | 6.7%（4/60） |

Position Dossierにより、完全根拠集合の検索は25.0 point、回答正答率は15.0 point改善した。単純なRecall@5は1.6 point下がったため、改善を「関連文書を広く拾えるようになった」とは説明できない。答えを持つ本文、変更側文書、効力を確認する台帳を同じ候補枠へ集めたことが効いている。

ただし、DVAA-Fullは4問に留まった。完全根拠がTop-5に揃った41問の内訳は、正答かつ完全根拠を回答に明示した4問、正答したが必要文書の一部を引用しなかった28問、誤答9問である。完全根拠が揃わなかった19問でも15問は回答値だけ正答した。したがって、Answer Accuracy 78.3%をそのまま文書効力解決の成功とは読めない。

主因は、Dossierの内部構造と回答時の契約がまだ一致していないことにある。Build内部のDossierはSource・Target・確認台帳を保持するが、検索adapterはそれを個別sourceへ展開してtop-5へ渡す。さらに共通reader promptは「実際に判断へ採用した文書だけ」をEvidenceへ記録するため、Lunaは回答値を含む規範や追補だけを引用し、その効力を確定した台帳を補助資料として省略しやすい。DVAA-Fullは台帳を含む完全な根拠集合を要求するため、正答でも0点になる。これは採点を緩める理由ではなく、FragrachがDossierを「検索された文書の束」ではなく「結論と効力証明を不可分にした回答資料」としてreaderへ渡せていないことを示す。

未解決競合は依然として最も難しい。`unresolved_conflict_primary`の完全根拠集合はholdout 6問中0問しかTop-5に揃わず、Answer Accuracyも3/6だった。四値Positionを正しく生成しても、そのDossier自体を質問に対して上位へ出せなければ効果はない。

## 不可分Dossier契約とLLM並列化の再検証

上記の残差に対して、検索adapterとreaderの契約を変更した。Position Dossierを複数の原文sourceへ分解してtop-kを消費させず、Dossier全体を一つの`ANSWER MATERIAL`として渡す。Dossierは内包する原文source一覧を持ち、readerはDossier IDではなく、回答値を支える文書と、その文書を採用できることを証明する台帳の双方を引用する。同時にDVAAの定義とGold根拠集合は変更していない。

まず同じ四値Position Buildと同じRuri検索順位を再利用し、受け渡し契約だけを変更した。Recall@5 96.7%と完全根拠集合41/60は変わらないため、次表の差は別の検索調整によるものではない。

| 条件 | Recall@5 | Answer Accuracy | DVAA-Full | Validity Gap |
|---|---:|---:|---:|---:|
| 四値Position・原文sourceへ再分散 | 96.7% | 78.3%（47/60） | 6.7%（4/60） | 71.7% |
| 同一Build・不可分Dossier契約 | 96.7% | 85.0%（51/60） | 28.3%（17/60） | 56.7% |

DVAA-Fullは21.6 point改善した。Position Dossierを作るだけでなく、その効力証明を回答時まで不可分に保つ必要がある、というR4の仮説を支持する。一方、17/60はまだ低く、完全根拠が揃った質問でも引用roleを誤る例、回答値は正しいが台帳を採用根拠に含めない例が残る。readerの入力prompt tokenは601,024から642,420へ6.9%増えたため、改善にはcontext費用が伴う。

次に、Codex App Server用の複数client poolと、入力batch順へ結果を戻す上限付きschedulerを実装した。CodexのCLI既定並列度は8、Ollamaは1とし、`--llm-concurrency`で明示変更できる。動的scale trackは4 shardを並列に動かしているため、過大な同時実行を避けて各shard 2、合計上限8 requestでfresh compileした。cacheを持たない新規workspaceで測定した。CLI既定8は単一compile向けであり、複数processでは各値の積ではなく全processの合計並列度を管理する。

| Compile | shard内並列度 | Wall-clock | 前回比 |
|---|---:|---:|---:|
| 逐次batch×4 shard | 1 | 1,801.3秒（30.0分） | 基準 |
| 並列batch×4 shard | 2 | 994.3秒（16.6分） | 44.8%短縮 |

並列Buildの各shardは894.9～983.4秒で完了した。Profile抽出はClaim batch後に各shard一回実行するため、理論上の50%短縮には届かない。Position Gateはfresh Buildでも90/90、確認台帳Evidence 90/90、三者判断chunk 90/90を維持し、完了順によるPosition差は生じなかった。

ただし、fresh Buildの周辺ClaimとDossier本文にはLuna生成の揺れがあり、compiled unitは11,026から11,040へ変化した。Ruri Recall@5は95.0%、完全根拠集合は36/60、Dossierをtop-5に含む質問は17/60となり、同じreader契約でAnswer Accuracy 83.3%、DVAA-Full 25.0%（15/60）だった。したがって、並列化がPositionを壊した証拠はないが、同一入力から完全に同じ検索Buildを再現できたとも言えない。Positionの決定性と、LLM生成された検索本文の決定性は分けて管理する必要がある。

## Decision Packet laneとDVAA-Gross／Net

上記の残差に対し、Dossierをより単純なDecision Packetへ変更した。Packet本文はLLM Profile全文ではなく、四値Position、変更側と基準側の`document_id`・`revision`、scope、有効期間、選択済み原文chunkから決定的に構成する。`operative`、`excluded`、`contender`、`verifier`のsource ID集合もBuildへ保持する。

検索時は、Ruriで得た通常chunk上位5件のsource IDから関係するPacketを引き、最大3件をtop-5の先頭へ合成する。Goldの質問family ID、期待回答、必要根拠集合は参照していない。Lunaは回答値、判断、使用した不可分material IDだけを返し、Packet内の原文sourceと`governing`、`conflict`、`reference`の用途はFragrachが機械的に展開する。

fresh並列Buildの抽出cacheを再利用してPacket Buildを作り直した。4 shardともLLM callは0件、各Buildは約1.9～2.5秒で完了し、Position 90/90、確認台帳Evidence 90/90、三者判断chunk 90/90、詳細Relation coverage 100/100を維持した。RuriとLunaは従来どおり固定した。

DVAAは一問ごとのFull gateを変えず、全60問を分母とする`DVAA-Gross`と、完全根拠がtop-5に存在する質問だけを分母とする`DVAA-Net`で再集計した。`Evidence Ceiling`は後者の分母であり、特定readerの実測Gold Context正答率ではない。

| F-Compile条件 | Recall@5 | Answer Accuracy | Evidence Ceiling | DVAA-Net | DVAA-Gross |
|---|---:|---:|---:|---:|---:|
| 同じBuildのRuri dense-only | 95.0% | 85.0%（51/60） | 73.3%（44/60） | 59.1%（26/44） | 43.3%（26/60） |
| Decision Packet lane | 98.3% | 98.3%（59/60） | 98.3%（59/60） | 100.0%（59/59） | 98.3%（59/60） |

両条件で`DVAA-Gross = Evidence Ceiling × DVAA-Net`が丸め前に成立する。dense-onlyは必要文書Recallが95.0%あっても、完全根拠は44問にしか揃わず、そのうち有効根拠付き正答へ変換できたのは26問だった。Packet laneは59問で完全根拠を揃え、その59問をすべて通過させた。失敗した`DVX-017-A`は、Ruri anchorが別系列を取得し、対象系列のPacketを引けなかった検索失敗である。

100%のNetがPosition構造ではなく採点偶然で生じた可能性を調べるため、質問、検索順位、Luna回答、選択materialを固定し、Packetから展開する根拠だけを変更した。

| 因果診断 | Evidence Ceiling | DVAA-Net | DVAA-Gross |
|---|---:|---:|---:|
| 正しいPacket | 98.3% | 100.0% | 98.3% |
| 確認台帳を除去 | 25.0% | 0.0% | 0.0% |
| operativeとexcludedの用途を反転 | 98.3% | 59.3% | 58.3% |

確認台帳を外すと完全根拠の上限自体が下がり、残った質問も効力証明を欠くためNetは0%になった。旧版・却下案などを`governing`へ反転するとCeilingは変わらないがNetが低下した。したがってDVAAは、回答文字列だけでなく、Packetが保持する効力根拠と採否へ意図どおり反応している。

## Ruri token単位のchunk長監査

Dense検索の弱さにchunk設計が影響していないかを切り分けるため、2026年8月6日にRuri公式tokenizerで256 token・overlap 32と512 token・overlap 64を比較した。これはPosition metadataもDecision Packet展開も適用しないRaw Vanilla検索の監査であり、Fragrach検索の成績ではない。対象は開発40問だけとし、T0とT1を別々に評価した。DenseはANN近似を使わない全件cosine検索、BM25は既存の最良設定である日本語1–2 gram、`k1=0.9`、`b=0.25`、質問への対象時点付与へ固定した。HybridのSparse比率も既存のT1最良値0.40から変更していない。

256設定はT0で5,545 chunk、T1で9,395 chunk、512設定はT0で5,025 chunk、T1で8,875 chunkになった。しかし検索結果の指標は完全に同じだった。

| Stage・検索条件 | Recall@5 | Evidence Ceiling@5 | Recall@10 | Evidence Ceiling@10 |
|---|---:|---:|---:|---:|
| T0・BM25／Ruri Dense／Hybrid | 100.0% | 100.0%（40/40） | 100.0% | 100.0%（40/40） |
| T1・BM25 | 95.0% | 0.0%（0/40） | 100.0% | 0.0%（0/40） |
| T1・Ruri Dense exact | 100.0% | 0.0%（0/40） | 100.0% | 5.0%（2/40） |
| T1・Hybrid 0.40 | 100.0% | 0.0%（0/40） | 100.0% | 0.0%（0/40） |

Ruri Denseでは、256と512の上位文書順がT0・T1の全80ケースでtop-5、top-10とも同一だった。BM25とHybridでは一部のchunk順位が変わったが、RecallとEvidence Ceilingは変わらなかった。T1のtop-5では両設定とも完全根拠が一問も揃わないため、Lunaを追加評価してもDVAA-Grossは必ず0%になる。この条件で回答生成まで繰り返す意味はなく、LLM評価は実施していない。

1024 tokenも変換だけ確認したが、512設定と8,875 chunkすべての本文が一致した。現行chunkerはsection境界を越えて本文を連結せず、このコーパスの最大chunkも447 Ruri tokenだからである。したがって現行コーパスでは512 tokenを採用する。これは512が精度で勝ったためではなく、256と検索品質が同じでchunk数が少なく、1024へ広げても入力が変わらないためである。今後、512 tokenを超えるsectionを持つ実コーパスへ移る場合は、この判断をそのまま適用せず再監査する。

## Position metadataを文書側からchunk側へ移す比較

Raw chunkにコンパイル済みmetadataが付いていなかった問題を分離し、Positionを文書側で解決する構造と、同じPositionを各chunkの検索本文へ投影する構造を比較した。対象はT1開発40問、512/64 Ruri-tokenの8,875 chunkである。既存Buildの200文書Profileと90件のPosition Dossierを再利用し、追加のLLMコンパイルは行っていない。第二ホールドアウトも使用していない。

文書側条件では、Dense検索面を原文chunkのまま保ち、chunkが持つ文書source IDから対応するDecision Packetを展開した。chunk側条件では、文書ID、版、承認、権威順位、有効期間、scope、四値Positionを短いHeaderへし、対象文書の全chunkへ機械的に付加してから同じRuriで再Embeddingした。Packet、質問、top-k、Ruriは共通である。

| Positionの置き場所 | Raw anchor Recall@5 | Raw anchor完全根拠@5 | Packet展開後Recall@5 | Packet展開後Evidence Ceiling@5 | Packet起動率 |
|---|---:|---:|---:|---:|---:|
| 文書側で保持し、raw chunkを文書IDで接続 | 100.0% | 0.0%（0/40） | 100.0% | 100.0%（40/40） | 100.0% |
| Position Headerを全chunkへ投影 | 40.0% | 2.5%（1/40） | 96.3% | 90.0%（36/40） | 90.0% |

単純なchunk側投影は改善しなかった。Headerなしではraw anchor上位5件が平均4.03文書に分散したが、Headerありでは2.50文書まで減った。同じ文書属性を全chunkへ反復したため、その文書の類似chunkが検索上位を占有し、別文書を押し出した。またHeaderが短い本文と同じEmbedding入力へ入ることで、質問と判断値本文の類似度も薄まった。

失敗した4問はすべて、同順位の緊急指示2文書を同時に取得すべき未解決競合だった。各系列の旧標準chunkが上位10件をほぼ占有し、競合する緊急指示が10位以内へ入らなかった。実装上のsource ID欠落ではなく、正しいHeaderとRelationが付いた状態で生じた順位占有である。

原因確認として、同じHeader Embeddingを再利用し、候補中の同一文書を一つのanchorへ畳む診断も行った。Packet起動率は100.0%へ戻ったが、展開後Evidence Ceilingは95.0%（38/40）に留まった。残る2問では正しい競合文書が文書単位でもanchor上位5件の外にあり、重複除去だけではHeaderによる意味希釈を戻せなかった。

この比較から、Positionを検索本文として全chunkへ複製する構造は採用しない。Position Dossierは文書単位の成果物として保持し、各chunkは安定した文書ID・版との接続だけを持つ。Denseは原文の意味的候補発見に使い、一件のanchorから文書側Packetを展開する。chunk側に必要なのはPosition全文の複製ではなく、検索後に文書側構造へ到達できるidentityである。

### 文書identity接続の修正後再計測

上記判断を実装へ反映した。Ruri chunkへ`document_id`、`revision`、内部`source_id`を検索本文とは別の構造化fieldとして保持し、Evidenceにも同じidentityを残した。検索adapterは、既知の`source_id`、`document_id + revision`、source pathの順にCompilerの文書Profileを解決する。文書が移動してpathが変わっても企業文書IDと版が一致すれば同じPosition Dossierへ到達できる。Position HeaderはEmbedding本文へ追加していない。

修正後の512/64 Ruri-token chunk 8,875件を作り直し、T1開発40問だけを再計測した。200動的文書はすべてCompiler Profileへ接続できた。既存の90 Decision Packet、Ruri、Luna、top-5、Packet anchor 5件・最大3件の条件は変えていない。Lunaは`gpt-5.6-luna`、reasoning effort `low`であり、第二ホールドアウトの質問は検索、prompt、採点のいずれにも使用していない。

| 修正後の文書ID接続 | 結果 |
|---|---:|
| Raw anchor Recall@5 | 100.0% |
| Raw anchor Evidence Ceiling@5 | 0.0%（0/40） |
| Decision Packet起動率 | 100.0%（40/40） |
| Packet展開後Recall@5 | 100.0% |
| Packet展開後Evidence Ceiling@5 | 100.0%（40/40） |
| Luna Answer Accuracy | 100.0%（40/40） |
| DVAA-Gross | 100.0%（40/40） |
| DVAA-Net | 100.0%（40/40） |

32問を`answer`、未解決競合8問を`unresolved`として正しく処理し、使用materialが空の回答はなかった。10評価categoryも各4問すべてDVAA-Fullを通過した。したがって、原文chunkのDense検索、文書identity、文書側Position、Decision Packet、Luna回答、根拠用途の機械展開は、この開発集合では欠落なく接続した。

ただし、以前の同一条件で文書identityを落としたLuna評価はないため、100%を修正による改善幅とは解釈しない。これは採用した契約の整合確認であり、同じ開発集合を繰り返し観測した結果でもある。一般化性能または製品精度の根拠にはせず、次の別データセット評価へ進むための固定候補とする。

## 何が問題で、何が効いたか

一連の改善で分かったのは、最初の問題が単一の検索精度不足ではなかったことである。文書関係を作る段階、質問に必要な関係を検索する段階、揃った関係をreaderへ渡す段階、根拠を回答へ結び付ける段階に、それぞれ別の損失があった。後段だけをpromptで補っても、前段で完全根拠が欠けていればDVAAは上がらない。逆にRelationを正しく生成しても、それを分解して通常chunkと同じランキングへ戻せば効果は失われた。

| 観測した問題 | 原因の判断 | 行った改善 | 改善が効いたと判断した根拠 |
|---|---|---|---|
| 16問・27短文ではVanillaもほぼ全問正答した | 文書数と系列が少なく、意味検索だけで正解文書を識別できた | 838文書のT0へ150文書を加えるT1、50系列200動的文書、100問のscale trackを作った | RecallとAnswer Accuracyが高くても、規範本文と管理台帳が揃わずDVAAが落ちる現象を再現できた |
| 初期F-Compileは200動的文書からRelationをほぼ作れなかった | LLMに多数属性と細かなRelationを一度に推論させ、文書identityもパス由来IDに依存していた | `document_id`と`revision`を保持し、後継・条件付き・無効・未解決を四値Positionへ縮約した | 明示metadataのPosition 90/90、台帳Evidence 90/90、詳細Relation写像100/100を再現した |
| 四値Position後もDVAA-Grossは4/60だった | RelationはBuildに存在したが、Source、Target、台帳を個別の検索結果へ再分散し、readerが効力証明を再構成していた | Position Dossierをtop-kの一枠で渡す不可分material契約にした | 同じBuildと検索順位でDVAA-Grossが4/60から17/60へ増え、Positionを回答時まで束ねる効果を確認した |
| 不可分Dossierでもfresh Buildは15/60に留まった | Dossier本文にLLM Profileの揺れが残り、通常Evidenceと同じdenseランキングに混在したため、必要なDossier自体が上位へ出なかった | Position、文書identity、scope、有効期間、選択済み原文だけで決定的なDecision Packetを構成し、通常chunkのsource IDをanchorに専用laneから合成した | dense-onlyのEvidence Ceiling 44/60に対し、Packet laneは59/60まで完全根拠を揃えた |
| 完全根拠が揃ってもLunaが台帳引用や根拠用途を落とした | 回答生成と、文書効力を証明する引用集合の再構成を同じLLM出力へ負わせていた | Lunaは回答と使用materialだけを選び、原文sourceと`governing`、`conflict`、`reference`はPositionから機械展開する契約にした | dense-onlyのDVAA-Net 26/44からPacket laneの59/59へ改善し、台帳除去と用途反転のアブレーションでは再び低下した |
| 従来DVAAだけでは、検索上限とreaderの失敗を読み分けにくかった | 検索で完全根拠が揃わない失敗と、揃った根拠を回答へ変換できない失敗を一つの割合へ混在させていた | 全問分母のDVAA-Grossと、Evidence Ceilingで正規化するDVAA-Netへ分解した | dense-onlyの課題をCeiling 73.3%とNet 59.1%に分け、Packet laneの残差をCeiling側の一問だけに特定できた |
| Position Headerを全chunkへ投影すると展開後Ceilingが40/40から36/40へ落ちた | 同一Headerを反復したchunkが上位を占有し、本文のDense類似度も薄まった | 原文chunkは文書IDだけで文書側Position Dossierへ接続し、Position本文をEmbeddingへ混ぜない | 文書側接続は40/40、chunk投影は36/40、文書重複を除いた診断でも38/40だった |

特に効果が大きかったのは、LLMへさらに詳しい属性を出させたことではない。通常RAGがreaderへ暗黙に任せていた、現行版の選択、基本規則と例外の合成、旧版・draft・却下案の除外、管理台帳による効力証明、未解決競合での断定回避を、`Document Identity → Position → Decision Packet → 根拠用途`として構造化したことである。文書管理metadataからPositionを単純に確定し、そのPositionと必要原文を不可分なPacketにして検索し、根拠用途をCompiler側で決めた結果、Lunaの役割は、ばらばらの文書から制度的な効力を毎回再推論することから、質問に適合するPacketを選び、回答値を読むことへ縮小した。

この結果は、回答生成をルールベースへ置き換えるべきだという結論ではない。意味的な候補発見と自然言語回答は引き続きRuriとLunaが担い、Fragrachは両者の間に残っていた文書の使用資格と証明集合を構造化した。今回の特定データに限った観測ではあるが、通常RAGでLLM任せになりやすい制度的判断へ、Compilerによる再現可能な境界を入れられる手応えが得られた。

一方、今回の改善は「Dense検索が不要になった」ことを意味しない。Packet laneも最初の候補発見にはRuriを使っており、唯一の失敗もanchor検索が対象系列を外したために起きた。したがってFragrachの効果はretrieverの置換ではなく、retrieverが見つけた一つの文書から、回答に必要な後継・旧版・台帳・競合を一つの判断資料へ展開する点にある。

## 現時点の判断

同じ60問の診断セットでは、DVAAを構造変更で上げ、根拠除去と採否反転で下げられるところまで因果関係を確認した。ボトルネックも、dense-onlyでは完全根拠取得と取得後の関係解決の双方、Packet laneでは残る一件のanchor検索、と分離できる。第二ホールドアウトへ進む前に求めていた「このデータでDVAAの挙動を制御し、説明できる」状態には到達したと判断する。

ただし、98.3%を製品精度または一般化性能とは扱わない。今回のF-Compile候補には背景788文書が含まれず、合成系列は語彙上区別しやすい。また、機構を改善しながらこの60問の結果を繰り返し観測したため、この集合は今後、最終holdoutではなく開発・因果診断用セットとして扱う。97/100問でLunaが選んだmaterialは一件の同系列Packetだけで、選択したPacketが別系列だった例はなかったが、これは同一分布上の監査にすぎない。

次の外部検証では、現在のPacket契約、Ruri、Luna、top-k、prompt、根拠の機械展開を凍結し、未観測系列と背景文書を含む第二ホールドアウトを一度だけ評価する必要がある。そこで同じ傾向が再現しなければ、今回の100% Netは合成データへの適合であり、Fragrachの一般的な差別化根拠にはならない。明示metadataがない文書で四値Positionをどこまで安全に作れるかも、別の抽出課題として残る。

## 200系列への容量拡大

40問で100%となった接続契約が、系列数と類似文書を増やしただけで崩れないかを確認するため、同じ生成規則を4 cohortへ広げた。新しいコーパスは、背景788文書と動的800文書の計1,588文書、200系列、400問で構成する。T0は988文書、T1で600文書を追加する。系列単位でdevelopment 80問、validation 80問、final holdout 240問へ分け、今回使用したのは前二者だけである。final holdoutは検索、prompt、採点のいずれにも使用していない。

この試験は新しい文書構造への一般化評価ではない。拠点名と文書IDを増やし、同じ業務主題を持つ別系列を大量に混ぜたときの容量試験である。したがって、validationは未観測familyではあるが、生成templateそのものはdevelopmentと共通している。

### 明示metadataだけをコンパイルする経路

今回の動的800文書は、文書ID、版、四値Position、対象文書、確認台帳をfront matterに明記している。この入力で本文からClaimを再抽出する必要はないため、`metadata` providerを追加した。これはLLMを呼ばず、明示metadataを決定的なDocument Profile、Position Relation、Decision Packetへ変換し、通常の検証と成果物生成を通す限定経路である。本文からClaimやPositionを推定するproviderの代替ではない。

8 shardのBuildは17.0秒で完了し、800 Profile、43,200 Evidence、360 Position Relationと360 Dossierを生成した。LLM call、profile LLM call、warning、errorはいずれも0件だった。これに対し、全1,588文書から作った512/64 Ruri-token chunkは24,475件で、Ruri Embeddingの更新に360.3秒を要した。明示metadataが利用できる範囲では、今回の更新費用の中心はCompilerではなくDense index側へ移った。

### developmentとvalidationの固定条件評価

検索条件は、Headerを混ぜない原文chunk、文書ID接続、Ruri exact cosine、anchor 5件、Decision Packet最大3件、最終top-5へ固定した。回答生成はLuna `gpt-5.6-luna`、reasoning effort `low`、batch size 8である。次表のEvidence Ceilingは、必要な完全根拠集合がPacket展開後top-5に存在した割合を示す。

| Split | Raw anchor Recall@5 | Packet展開後Recall@5 | Evidence Ceiling | Answer Accuracy | DVAA-Gross | DVAA-Net |
|---|---:|---:|---:|---:|---:|---:|
| development（80問） | 93.75% | 97.50% | 93.75%（75/80） | 100.00%（80/80） | 91.25%（73/80） | 97.33%（73/75） |
| validation（80問） | 95.63% | 97.50% | 96.25%（77/80） | 98.75%（79/80） | 95.00%（76/80） | 98.70%（76/77） |
| 合計（160問） | 94.69% | 97.50% | 95.00%（152/160） | 99.38%（159/160） | 93.13%（149/160） | 98.03%（149/152） |

Packetは160問すべてで起動し、全問で1位へ入った。40問の開発集合で得た100%は容量を増やすと維持されなかったが、validationがdevelopmentを下回る崩れ方はしていない。完全根拠が届いた152問のうち149問がDVAA-Fullを通過しており、reader側の変換率を表すDVAA-Netは98.03%だった。validationでLunaが回答を誤ったのは、完全根拠が届かなかった`DVX-067-A`の1問だけである。したがって、この容量試験でも主な残差は回答生成力ではなく検索・Packet選択側にある。

Evidence Ceilingを外した8問のうち6問は、正しい系列の文書をanchorできていた。しかし同じ文書に結び付く複数Dossierのうち、現行の規則がID順で`non_effective`側を先に選び、有効な例外または追補側をPacket枠から落としていた。残る2問は、類似した別拠点の系列が上位Packet枠を重複して使い、正しい系列が押し出された。これはPositionの生成失敗ではなく、複数Relationを持つ文書からどのPacketを出すか、同じRelation componentへ何枠を与えるかという検索adapterの問題である。

完全根拠が届いたにもかかわらずDVAA-Fullを外した3問も残った。回答値はすべて正しかったが、Lunaが却下案の扱いまたは効力根拠の一部を最終materialとして採用しなかった。Netが100%ではなく98.03%へ下がったことで、40問の100%が理論的な保証ではなく、小さい開発集合で観測された上限だったことも確認できた。

現段階では、容量を4倍にしても`Document Identity → Position → Decision Packet → 根拠用途`の接続自体は維持された。一方、次の改善対象はPosition属性の追加ではない。developmentで観測した失敗だけを使い、Packet候補をRelation component単位で多様化し、同一文書に複数Positionがある場合の優先規則を決める。その後に規則を凍結し、今回未使用のfinal holdout 240問を一度だけ評価する。別template・別データセットでの構造一般化は、その容量評価とは分けて行う。

### Relation component選択とfinal holdout

上記の残差に対して、developmentの失敗だけを使ってPacket選択を変更した。従来は、anchorへ直接結び付くDossierを個別に順位付けしていたため、同じ文書系列の複数DossierがPacket枠を重複消費した。また、質問が期限切れ例外やdraftに意味的に近い場合、その非有効Dossierが同じ系列の有効Dossierより先に選ばれた。

修正後は、Source、Target、確認台帳で接続されたDossier群を一つのRelation componentとして扱う。componentの検索順位は、その中で最も高いraw anchor順位から継承する。一方、readerへ渡す代表Packetは、component内のPositionから有効側を先に選ぶ。Packet最大3件を配るときも、同一componentの二件目より別componentの一件目を優先する。これにより、「どの文書系列が質問に近いか」と「その系列でどの関係が有効か」を一つの順位へ混ぜずに処理する。

単純に有効側Packetの直接anchor順位を使う案もdevelopmentで試したが、Evidence Ceilingは75/80から76/80にしか上がらず、正しいcomponent自体を上位枠から落とした。componentの最良anchor順位と代表Positionの選択を分離した最終規則では、development 80問のPacket展開後Recall、Evidence Ceiling、Answer Accuracy、DVAA-Gross、DVAA-Netがすべて100%になった。ここで規則、Ruri、Luna、top-k、Packet budget、prompt、採点を凍結した。

その後、未使用だった120系列240問のfinal holdoutを一度だけ検索し、得られたcontextを変更せずLunaへ渡した。

| 固定規則のfinal holdout | 結果 |
|---|---:|
| Raw anchor Recall@5 | 93.13% |
| Raw anchor Evidence Ceiling@5 | 0.42%（1/240） |
| Decision Packet起動率・1位率 | 100.00%（240/240） |
| Packet展開後Recall@5 | 98.33%（236/240） |
| Packet展開後Evidence Ceiling | 98.33%（236/240） |
| Luna Answer Accuracy | 99.58%（239/240） |
| DVAA-Gross | 98.33%（236/240） |
| DVAA-Net | 100.00%（236/236） |
| Validity Gap | 1.25%（3/240） |

完全根拠が届いた236問はすべてDVAA-Fullを通過した。Lunaが誤答した一問もEvidence Ceilingの外側にあり、readerが完全根拠を受け取った後の失敗はなかった。したがって、このholdoutでは最終的な上限を決めたのは回答生成ではなくPacket検索だった。

失敗した4問は`DVX-117-A`、`DVX-162-A`、`DVX-167-A`、`DVX-187-A`で、すべて変更対象値を尋ねる`rejected_change_primary`または`unresolved_conflict_primary`だった。正しい系列のraw anchorはそれぞれ2位、4位、4位、5位に存在したが、それより上位の別系列3 componentがPacket budgetを使い切った。Relation component規則は同一系列の重複を除けるが、Denseが別系列をより高く並べた場合に正しいcomponentを3枠へ残す保証はない。4問中3問はLunaが不完全なcontextから期待値を返したものの、DVAAは完全根拠を欠くため正しく不成立とした。

回答評価はLunaのclient poolを8並列にし、8問batchを入力順へ戻して採点した。240問30 requestのwall-clockは107秒だった。これは評価実行時間の改善であり、検索品質やDVAAの改善要因には含めない。

今回のone-shot holdoutは、系列数と類似拠点を増やしても、文書identityからPositionと完全根拠へ展開する構造が同一生成分布内で維持されることを示した。特に、Raw anchorだけでは完全根拠が1/240しか揃わない条件で、Decision Packetは236/240まで回復させている。一方、同じ文書template、明示front matter、同じ時点設計を共有する合成データであり、未知の企業文書構造や不完全metadataへの一般化は検証していない。この98.33%は容量耐性の証拠として扱い、一般的なRAGへの優位性を主張する根拠にはしない。次の評価は、このholdoutを再調整に使わず、別templateまたは実データで行う。

## 未見系列・複合表記揺れによる実践テスト

容量評価だけでは、質問と文書が同じ語を共有しているため、Dense検索の意味的な寄与を確認しにくい。そこで既観測200系列とは別に100系列を追加し、その200問だけを`practical_holdout`として評価した。Gold文書、対象時点、期待回答は変えず、質問側へ送り仮名、英字とカタカナ、大小文字と空白、業務同義語、略語、拠点名の漢数字・序数・句読点、語順、疑問文形式の変換を複数重ねた。評価用の表記揺れを見て検索設定を再調整していない。

T1コーパスは1,988文書、Ruri tokenizerによる512 token・overlap 64の検索面は34,875 chunkである。全検索条件で一つの文書から上位へ残すchunkを一件に制限し、候補は1,000件、最終回答contextはtop-5へ固定した。DenseはRuriの全件cosine検索でありANN近似を使っていない。BM25は既存の開発評価で固定した日本語1–2文字gram、`k1=0.9`、`b=0.25`、HybridはBM25を0.40とする重み付きRRFである。回答生成は全条件でLuna `gpt-5.6-luna`、reasoning effort `low`、8問batch、8並列に揃えた。

| 条件 | Recall@5 | Answer Accuracy | Evidence Ceiling | DVAA-Gross | DVAA-Net |
|---|---:|---:|---:|---:|---:|
| Raw BM25 | 1.5% | 2.0%（4/200） | 0.0%（0/200） | 0.0%（0/200） | 算出不能 |
| Raw Ruri Dense | 92.75% | 78.5%（157/200） | 9.0%（18/200） | 0.0%（0/200） | 0.0%（0/18） |
| Raw固定Hybrid | 87.25% | 78.5%（157/200） | 5.0%（10/200） | 1.0%（2/200） | 20.0%（2/10） |
| Fragrach・Ruri Packet | 97.5% | 98.5%（197/200） | 97.5%（195/200） | 96.0%（192/200） | 98.46%（192/195） |
| Fragrach・固定Hybrid Packet | 91.0% | 93.0%（186/200） | 91.0%（182/200） | 90.0%（180/200） | 98.90%（180/182） |

このテストでは、表記揺れを拾う入口としてRuri DenseがBM25より明確に強かった。略語を含む80問でRaw DenseのRecall@5は88.75%、業務同義語を含む120問で91.67%、拠点番号の漢数字または序数表記を含む各50問で94.0%と91.0%だった。固定Hybridは全体でもDense単体を5.5 point下回った。語彙一致を意図的に弱めた質問では、過去に固定したSparse比率0.40が順位を悪化させたためである。これはBM25一般の否定ではなく、Hybridの重みを一つに固定すれば常にDenseを上回るわけではないことを示す。

Fragrachの効果は、同じRuri Denseを入口にしたRawとPacketの差で読むのが最も明瞭である。Packet展開によりRecall@5は92.75%から97.5%へ4.75 point上がっただけだが、完全根拠がtop-5に揃うEvidence Ceilingは9.0%から97.5%へ88.5 point上がった。さらにAnswer Accuracyは20.0 point、DVAA-Grossは96.0 point改善した。通常検索が一つの関連chunkを見つけた後、Document IdentityとPosition Relationを使って同じ系列の有効文書、非有効文書、確認台帳を不可分な回答資料へ展開したことが、この差を生んでいる。

Raw Denseは完全根拠が18問に存在したにもかかわらずDVAAを一問も通らず、回答値だけは157問で正解した。この乖離は、Lunaが不完全なcontextから正解らしい値を生成できる一方、通常のtop-k文書列だけでは、文書の採否と効力証明を回答まで一貫して保持できないことを示す。

初回集計ではFragrach・Ruri PacketのAnswer Accuracyを181/200、DVAA-Grossを176/200と報告したが、失敗19件を質問単位で監査すると、16件は「2名」に対する「2人」と「20台ごとに1台」に対する「20台に1台」を文字列不一致にした採点上の偽陰性だった。助数詞と頻度の意味同値を正規化して同じLuna回答を再採点した値が上表である。この修正はFragrachだけでなく全条件へ同じように適用した。

修正後、完全根拠が届いた195問のうちDVAAを外したのは3問になった。元の回答runでは、2問が8問batch内の別質問に属するPacket IDを選び、1問が正しい完全根拠から「2名」を「必要」と答えていた。そこで回答Schemaを、batch全体のmaterial列挙から、質問IDごとにその質問のtop-5だけを列挙するobjectへ変更した。質問間Packetの選択はSchema上表現できなくなった。

修正後Schemaによる診断再実行でもDVAA-Grossは192/200、Netは192/195で、集計値は変わらなかった。ただし失敗の内容は変わり、回答値の誤りは0件、資料採用の誤りが3件となった。2問は同じ質問のtop-5にある別文書系列のPacketを選び、1問は正しいPacketに加えて却下された変更要求を`governing`として採用した。したがって、残るreader側の改善対象は回答文生成ではなく、質問に対して選択可能なPacketと、追加原文を`governing`へ昇格できる条件の制御である。この再実行は失敗を見た後の診断であり、新しいholdoutの未調整結果としては扱わない。

この結果は、同じDense anchor、同じchunk、同じLunaを使うRaw RAGに対して、Fragrachの文書関係コンパイルが実質的な効果を持つことを支持する。ただし、比較したHybridはcross-encoder reranker、query expansion、質問別の動的重みを持たない固定再現条件であり、あらゆる本番Hybrid RAGより強いという結論ではない。また、未見の100系列と複合表記揺れを使っているが、文書templateと明示metadataは従来の合成コーパスと共通である。したがって、今回の証拠は「同一データ生成系の容量と表現変動に対する優位」であり、異なる企業文書構造への一般化は次の別データセットで評価する。
