# EnterpriseRAG-Bench外部分布評価

## 結論

EnterpriseRAG-Benchの全511,962文書では、BM25が検索の主経路として残った。ただし、この時点で評価したRuriはBM25 top-50候補内の再順位づけであり、全コーパスDense検索ではない。Lunaが作ったquery obligationのRRF統合、質問型・obligation数・検索結果の不確実性を使う選択ゲートもdevelopmentでBM25を上回らなかった。diagnosticだけならRRF 0.5のEvidence CeilingはBM25より2.2ポイント高いが、これを見て採用するのは後知恵になる。

固定6位置に対する改善は検索融合の後で再現した。最終Position Dossierは、検索1位文書を全文保持し、残りの長文書では`list`、`constraint`、`conflict`を10位置、`point`と`absence`を6位置へ縮約する。5,000文字以下の文書はそのまま保持する。この`rank1-complex-10`は、平均55,000文字以下という上限内で、developmentのEvidence Ceiling、Evidence Unit Recall、資料長の順に選んだ。diagnosticは方式選択に使っていない。

最終source-local定義では、diagnosticのEvidence Ceilingは固定6位置の50.5%から59.3%へ改善した。しかし、これは弱い固定圧縮に対する改善であり、一般的な強いRAGへの優位を意味しない。そこで、同じBM25 top-10を全文で渡す`Full Vanilla`と、Fragrachのdevelopment平均50,849文字以下で質問文だけを使う汎用圧縮を1〜12位置から調整した`Budget Vanilla`を追加した。Budget Vanillaは検索1位全文＋残りを一律7位置にする`rank1-7`となった。

同一Base Reader runでは、Budget VanillaとFragrachのDVAA-Grossはともに39.6%で、Full Vanillaは44.0%だった。同一Position Checklistを全条件へ与えたrunでも、Budget Vanilla 44.0%、Fragrach 42.9%、Full Vanilla 46.2%となった。FragrachはBudget Vanillaより完全根拠を1問多く保持したが、その1問を含めてもstrict合格は1問少なかった。Full Vanillaに対しては約24%少ないcontextを使う一方、strict合格も3問少ない。

Position ChecklistはBase Readerに対して、Fragrachを3問、Budget Vanillaを4問、Full Vanillaを2問、Gold Contextを3問改善した。したがって、回答計画の構造化には一般的なReader改善として価値があるが、Fragrach固有の優位ではない。以前の単独runで得たFragrach Accuracy 49.5%、Gross 47.3%、Net 79.6%は生成揺らぎを含む参考値へ降格し、強いVanillaと同時生成・同時採点した比較をheadlineとする。

結論として、現diagnosticは「Fragrachが一般的な強いRAGより高性能」という主張を支持しない。支持するのは、固定圧縮より根拠保持を改善できること、質問型別構造を評価可能な制御面へ移せること、Full Vanillaに近い性能を少ないcontextで目指せることまでである。現方式は同予算Vanillaにも勝っていないため、holdoutへ進む前に仕組みを改善する判断を維持する。

## 評価対象とGold監査

500問を質問種別ごとにdevelopment 100問、diagnostic 100問、holdout 100問、reserve 200問へ固定した。本文書で方式選択と回答評価に使ったのはdevelopmentとdiagnosticだけである。全511,962文書をTantivyへ一文書一recordで索引化し、titleとcontentをBM25検索した。Gold周辺だけを抜いた縮小コーパスは使っていない。

元データの`answer_facts`を期待文書へ照合し、曖昧な36問をLunaで意味監査した。期待文書IDと原文の支持箇所を確認できた17問を修復し、最終的にverified 451問、disputed 19問、null 20問、unmapped 10問とした。headlineはverifiedだけを分母とし、developmentとdiagnosticではそれぞれ91問が該当する。

## Evidence Unitの最終判定

初回の文書全体50% token照合は、長文中に一般語が散在するだけで完全根拠と判定する偽陽性を生んだ。その後90%の局所照合へ厳格化したが、qst_0142やqst_0424では要求された数値・識別子と回答箇所が資料中に存在するにもかかわらず、Gold周辺段落の背景語が少ないため偽陰性になった。

このため、現在のEvidence Unit合格条件を次に固定した。

- Gold factごとに、監査済みGold文書から256 tokenの局所windowを選ぶ。
- 数値、版、metric名、`snake_case`識別子、pathなど、Gold原文にも実在するexact anchorを指紋として保持する。
- 回答資料側の同一source内に、すべてのexact anchorと、Gold windowの80%以上のIDF加重lexical coverageを同時に満たす一つの局所windowがある場合だけ合格とする。
- Gold指紋は評価器だけが使い、検索、span選択、回答生成には渡さない。

80%は意味類似の緩和値ではない。exact anchorをhard gateにしたまま、同じ事実を含む局所箇所がGoldの前後文脈を逐語的に保持することまでは要求しない境界である。90%値は評価器の較正途中の記録であり、以後の表はすべて80%定義で再集計した。

## 検索：Hybridを無理に採用しない

BM25 top-10のDocument Recall@10はdevelopment 72.3%、diagnostic 68.0%だった。必要Gold文書をすべて取得できた質問はそれぞれ68.1%、61.5%である。source-local Evidence Unitをすべて揃えるEvidence Ceilingは68.1%、62.6%だった。R@kは通常RAGとの共通比較に必要だが、文書IDが入ったことと、回答に必要な局所根拠が揃ったことは同義ではない。

LunaはGoldを見ずに200問を`point` 100、`list` 57、`constraint` 38、`conflict` 4、`absence` 1へ分類し、検索obligationへ分解した。元質問BM25とobligation検索をRRFまたはround-robinで統合し、developmentのEvidence Ceiling、Evidence Unit Recallの順で一方式を選んだ。

| 検索条件 | Development Evidence Ceiling@10 | Diagnostic Evidence Ceiling@10 |
|---|---:|---:|
| **BM25** | **68.1%** | 62.6% |
| RRF 0.25 | 65.9% | 63.7% |
| RRF 0.50 | 65.9% | **64.8%** |
| RRF 1.00 | 62.6% | **64.8%** |
| Round-robin 1 | 67.0% | 62.6% |

さらに、`mode`別、obligation数別、BM25とRRFのtop-10重複率、BM25上位スコア差を使う選択ゲートをdevelopmentで学習した。どの規則も最適解はRRFへ0問を切り替えるBM25固定だった。よって、現データで支持されるHybridは「複数retrieverを必ず混ぜる方式」ではなく、BM25を保持し、Lunaの構造化結果を後段のDossierとReader制御へ使う方式である。

Ruriは`hf.co/Targoyle/ruri-v3-310m-GGUF:Q8_0`へ固定した。BM25 top-50内再順位づけはBM25を下回った。38,320個の文書spanをRuriで埋め込み、obligationごとに選ぶ方式も旧Evidence定義で固定6位置を下回った。この結果から棄却できるのは、BM25候補内の無条件な再順位づけと現行span selectorである。BM25に入らない文書をRuriが全コーパスから発見できるかは、この実験では測っていなかった。

この欠落はsemantic質問の監査で明確になった。公式の生成promptは、強い語彙一致と原文のexact keywordを避けたloose-match質問を作るよう指定している。development 25問、diagnostic 25問の計50問がsemanticに該当し、Gold文書をBM25が取得できたのはtop-10で18問、top-50でも23問だった。残る27問はBM25 top-50候補内Ruriでは到達不能である。したがって、表現揺らぎのテストがないのではなく、Denseの検索範囲をBM25候補へ制限した評価経路に問題があった。

このため、Ruriのtitle＋本文冒頭700文字を全511,962文書について埋め込み、LanceDBへ文書IDとともに格納する追加実験を開始した。まず索引を使わない全件cosine検索をRuri自体の基準値とし、その後にANNを同じベクトルへ適用する。BM25、全件Dense、developmentだけで重みを選ぶHybridを同じtop-10条件で比較し、全体値に加えてsemanticを分離報告する。これにより、埋め込みモデルの限界とANNの近似損失を混同しない。

## 固定圧縮からPosition Dossierへ

固定6位置は平均資料長を43,586文字へ抑えたが、diagnostic Evidence Ceilingは50.5%で、全文62.6%から11問を失った。失敗例では、完全列挙が複数段落へ分散し、質問に明記されない禁止条件が必要になり、現行と旧見解の両側を同時に残す必要があった。

開発集合で比較した主な候補は次のとおりである。平均55,000文字を超える候補は採用対象から外した。

| 条件 | 実行規則 | Dev平均文字数 | Dev Ceiling | Diagnostic平均文字数 | Diagnostic Ceiling |
|---|---|---:|---:|---:|---:|
| fixed-6 | 全問6位置 | 44,157 | 58.2% | 43,586 | 50.5% |
| complex-10 | complex型を10位置、その他6位置 | 49,072 | 60.4% | 48,730 | 57.1% |
| rank1-complex-8 | 1位全文＋complex型8位置、その他6位置 | 49,051 | 67.0% | 48,852 | 58.2% |
| **rank1-complex-10** | **1位全文＋complex型10位置、その他6位置** | **50,849** | **67.0%** | **50,735** | **59.3%** |
| rank1-governance | 1位全文＋list 8位置、constraint／conflict 10位置 | 51,379 | 67.0% | 51,193 | 60.4% |
| top-10全文 | 検索文書を全文保持 | 70,906 | 68.1% | 66,886 | 62.6% |

`rank1-complex-10`と`rank1-governance`はdevelopmentのCeilingとUnit Recallが同じで、前者の資料が小さいため前者を選んだ。diagnosticで後者が1問良いことは選択に使わない。選択方針は、検索1位を「質問の中心文書」として保護し、残りの文書は回答型が要求する完全性に応じて縮約するという単純な軸へ集約された。細かな文書関係はsource/chunk側に保持し、外部契約へ多数の属性を露出しない。

Position Dossierの不可分性は、検索した10文書を常に丸ごと渡すことではない。質問に必要な根拠集合と出典境界を壊さず、一つの回答資料としてReaderへ渡すことである。コンパイラには、削ってよい箇所を決めることと、削る根拠がない箇所を原文のまま保護することの両方が含まれる。

## 強いVanillaとの回答比較

回答とsemantic judgeはLuna、EmbeddingはRuriに固定した。LLM concurrencyは全体8とし、91問を23、23、23、22問の4 shardへ分け、各shardを2並列で実行した。各runでVanilla Full、Vanilla Budget、Fragrach、Gold Contextの364回答を同時生成・採点した。Answer Accuracyは、全`answer_facts`を表現し、矛盾がない場合だけ合格とした。

Budget Vanillaは、質問文だけでspanを順位づけし、検索1位を全文、残り9文書を一律7位置にする。development平均49,238文字、diagnostic平均49,251文字で、Fragrachの50,849文字、50,735文字よりわずかに小さい。development Evidence Ceilingは両方式とも67.0%だった。Full Vanillaはdiagnostic平均66,886文字である。

Base Readerの同時比較は次のとおりである。

| 条件 | Answer Accuracy | Evidence Ceiling | DVAA-Gross | DVAA-Net |
|---|---:|---:|---:|---:|
| Budget Vanilla | 41.8%（38/91） | 58.2%（53/91） | 39.6%（36/91） | 67.9%（36/53） |
| Fragrach Position Dossier | 41.8%（38/91） | 59.3%（54/91） | 39.6%（36/91） | 66.7%（36/54） |
| **Full Vanilla** | **46.2%（42/91）** | **62.6%（57/91）** | **44.0%（40/91）** | **70.2%（40/57）** |
| Gold Context | 86.8%（79/91） | 100% | 86.8%（79/91） | 86.8%（79/91） |

Position Checklistは、`list`の完全列挙、`constraint`の必須・禁止・条件・境界、`conflict`の状態分離、`absence`の確認scope、`point`の全節確認を要求する。同じLuna生成のmodeとobligationを全三条件へ同じ制御metadataとして渡し、事実根拠としては使わなかった。

| 条件 | Answer Accuracy | Evidence Ceiling | DVAA-Gross | DVAA-Net |
|---|---:|---:|---:|---:|
| Budget Vanilla＋Checklist | 45.1%（41/91） | 58.2%（53/91） | 44.0%（40/91） | **75.5%（40/53）** |
| Fragrach＋Checklist | 45.1%（41/91） | 59.3%（54/91） | 42.9%（39/91） | 72.2%（39/54） |
| **Full Vanilla＋Checklist** | **47.3%（43/91）** | **62.6%（57/91）** | **46.2%（42/91）** | 73.7%（42/57） |
| Gold Context＋Checklist | 90.1%（82/91） | 100% | 90.1%（82/91） | 90.1%（82/91） |

Checklist runの同予算比較では、Fragrachだけがstrict合格したのはqst_0321、qst_0322、qst_0424、Budget Vanillaだけが合格したのはqst_0076、qst_0141、qst_0313、qst_0458だった。FragrachだけがEvidence Completeになったqst_0424を含めても純差はBudget Vanilla +1問で、exact McNemar検定の両側p値は1.0である。Full Vanillaに対してはFragrachのみ3問、Fullのみ6問で、p=0.508だった。差は有意ではないが、少なくともFragrach優位の方向ではない。

Checklist runでもFragrachは完全根拠54問のうち15問をstrict正答へ変換できなかった。Gold Contextは9問を外した。資料構成による追加の6問分は、複数factsの取りこぼし、列挙不足、長い資料からの統合不足というReader側の問題である。

## Fragrachへの判断

今回の機構把握から、次の境界が得られた。

- 約50万文書でもBM25は強く、BM25候補内の無条件なDense再順位づけやquery expansionを採用する根拠はない。一方、全コーパスDenseの評価は未完了であり、Dense一般を棄却する結論にはできない。
- R@10が必要文書IDの取得を示しても、局所Evidence Unitの完備、圧縮後の保持、回答の完全性は示さない。
- 固定圧縮は根拠を壊すが、development調整した質問文だけの`rank1-7`は強く、Fragrachの質問型別配分とDVAA-Grossで同等以上だった。
- Position DossierはBudget VanillaよりEvidence Completeを1問増やしたが、Baseではstrict同数、Checklistではstrictが1問少なく、根拠保持を回答性能へ変換できていない。
- Position Checklistは全方式を改善したため、obligationによる回答計画は有効だがFragrach固有の差別化ではない。
- FragrachはFull Vanillaよりdiagnostic contextを約24%減らしたが、Baseでstrict 4問、Checklistで3問少ない。現状は効率面でも「同等品質」とはまだ言えない。
- 通常RAGでLLM任せになる「何を保持し、何を全件回答し、どの立場を分離するか」を制御面へ移す設計価値は残るが、性能優位は未証明である。
- 残る問題は、全文top-10でも根拠が揃わない34問、Fragrach圧縮で失う3問、Checklist下で完全根拠を回答へ変換できない15問に分解できる。

EnterpriseRAG-Benchのholdoutにはまだ進んでいない。次の改善でdiagnosticを再利用する場合、その値は一般化評価ではなく機構開発値として扱う。holdoutは方式、閾値、Reader契約、モデル条件を凍結した後の一度だけの確認に残す。

## 再現物と制限

主要成果物は次に保存した。

- Gold監査：`target/benchmarks/enterprise-rag-bench/prepared-v3/`
- 最終検索比較とゲート棄却：`query-dossiers-v6/`
- 最終選択的コンパイル：`adaptive-dossiers-v8/`
- 強いVanilla資料：`vanilla-dossiers-v3/`
- 強いVanillaとのBase Reader比較：`answers-strong-baseline-local-v1/`
- 全条件共通Checklist比較：`answers-strong-checklist-local-v1/`
- 強いVanillaとのpaired比較：`strong-baseline-comparison-v1/`
- Base Reader再採点：`answers-diagnostic-base-local-v1/`
- Position Checklist再採点：`answers-diagnostic-checklist-local-v1/`
- Reader契約比較：`reader-contract-comparison-v1/`
- Ruri span選択の棄却実験：`ruri-coverage-dossiers-v1/`
- semantic表現揺らぎ監査：`semantic-variation-audit-v1/`
- 全コーパスRuri入力・ベクトル：`ruri-full-corpus-input-v1/`、`ruri-full-corpus-v1/`
- LanceDB全コーパス表：`lancedb-ruri-full-corpus-v1/`

回答と意味採点には同じLunaを別リクエストで使っており、judge modelの独立性と複数seedは未評価である。source-local Evidence判定はexact anchor付きlexical fingerprintであり、意味的に同値な別表現を完全には扱わない。その代わり、Gold原文にないanchorを要求せず、長文全体の一般語散在を合格させない境界を明示している。
