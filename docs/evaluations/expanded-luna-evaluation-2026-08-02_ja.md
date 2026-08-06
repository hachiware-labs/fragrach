# Actual Relation Dossier + Luna 拡張評価（30問）

製造・金融・医療・ソフトウェアの5評価群、重複しない30問へ広げた。同じLuna回答モデルを使う比較では、`Actual Relation Dossier`が`Raw Tuned + Purpose`より検索R@5を58.3%から75.0%、自動Strict Passを23.3%から50.0%へ改善した。一方、検索R@20は90.0%から88.9%へ下がり、医療・品質薬事部ではStrict PassがRawと同率だった。したがって、Fragrachは上位検索と引用を改善する傾向を確認できたが、Relationを取りこぼした領域まで常にRawを上回るわけではない。

## 評価範囲

比較条件は全て、回答モデルをCodex App Server経由の`gpt-5.6-luna`、reasoning effortを`low`、採点モデルをOllamaの`gemma4:latest`、検索上限をtop 5に揃えた。Raw側は文字2-gram BM25と最大1,024文字の調整済みchunkingを使い、質問の用途が既知という前提で対象文書を12件へ絞った。Actual側は同じ12文書から生成したClaim、文書関係、両側原文を含むRelation Dossierを使った。

| 評価群 | 業種・部門 | 用途 | 問数 | 主に試す関係 | Actual試行数 | Raw試行数 |
|---|---|---|---:|---|---:|---:|
| A | 製造・製品設計部 | governance | 6 | 旧版、現行版、FAQ矛盾、優先関係 | 3 | 1 |
| B | 製造・製品設計部 | technical_spec | 6 | 仕様改訂、草案、試験記録 | 1 | 1 |
| C | 金融・コンプライアンス部 | governance | 6 | 規程改訂、FAQ矛盾、承認記録 | 1 | 1 |
| D | 医療・品質薬事部 | governance | 6 | 規程改訂、FAQ矛盾、承認記録 | 1 | 1 |
| E | ソフトウェア・SRE部 | incident_change | 6 | 初報、最終報、変更申請、リリース記録 | 1 | 1 |

企業コーパス全体は40部門、1,440問あるが、今回のActual評価はこのうち30問である。合成コーパス内の初期検証であり、実企業文書への一般化はまだ評価していない。

## 30問の比較結果

次の集計は、反復による重みの偏りを避けるため、各評価群の最初の1試行だけを使う。自動採点値を再現可能な一次結果とし、人手監査値は別記する。

| 層 | 指標 | Raw Tuned + Purpose | Actual Relation Dossier | 差 |
|---|---|---:|---:|---:|
| 検索 | 根拠再現率R@5 | 58.3% | **75.0%** | +16.7pt |
| 検索 | 根拠再現率R@10 | 72.8% | **82.8%** | +10.0pt |
| 検索 | 根拠再現率R@20 | **90.0%** | 88.9% | -1.1pt |
| 回答資料 | 根拠再現率@5 | 58.3% | **73.3%** | +15.0pt |
| 回答 | 引用再現率 | 56.7% | **80.0%** | +23.3pt |
| 回答 | 回答要素再現率 | 93.9% | **95.0%** | +1.1pt |
| 安全性 | behavior accuracy | 100.0% | 100.0% | 0.0pt |
| 安全性 | 自動禁止誤答率 | 6.7% | **3.3%** | -3.4pt |
| 最終 | 自動Strict Pass | 23.3%（7/30） | **50.0%（15/30）** | +26.7pt |
| 最終 | 監査後Strict Pass | 23.3%（7/30） | **53.3%（16/30）** | +30.0pt |
| 効率 | 入力tokens | 318,041 | 1,021,062 | 3.21倍 |
| 効率 | 平均回答待ち時間 | 10.10秒 | 40.33秒 | 3.99倍 |

禁止誤答の自動判定には、製品設計部governanceのRawとActual、医療governanceのRawで否定文の誤判定があった。いずれも旧FAQを現行規則として否定した回答を、Gemma judgeが禁止要素の断定と数えた。製品設計部Actualだけは他のStrict条件も満たすため、監査後に1問をPassへ訂正した。Raw側は根拠または引用も不足しており、訂正後もStrict Pass数は変わらない。

この30問でも、Actualの改善は回答要素を増やしたことより、必要根拠を取得して引用へ結び付けたことに表れている。回答要素はRawでも93.9%あるため、文章だけを見る評価ではRawがもっともらしく答えている問題を見逃す。Strict Passと引用再現率を主要指標に置く必要がある。一方、R@20でRawを下回ったことは、無効文書を除く処理より前に、必要な原文や関係を消していないことを確認するRecallゲートが必要だと示している。

## 評価群ごとの結果

| 評価群・条件 | 検索R@5 | 検索R@10 | 回答根拠 | 引用 | 回答要素 | 自動Strict | 入力tokens | 平均待ち時間 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 製品設計 governance / Raw | 58.3% | 75.0% | 58.3% | 58.3% | 94.4% | 16.7% | 62,029 | 10.78秒 |
| 製品設計 governance / Actual 1回目 | **91.7%** | **91.7%** | 83.3% | **91.7%** | 100.0% | **50.0%** | 197,455 | 40.09秒 |
| 製品設計 technical_spec / Raw | 25.0% | 47.2% | 25.0% | 25.0% | 100.0% | 0.0% | 63,328 | 10.34秒 |
| 製品設計 technical_spec / Actual | **50.0%** | **72.2%** | **66.7%** | **66.7%** | 100.0% | **50.0%** | 209,660 | 38.84秒 |
| 金融 compliance governance / Raw | 75.0% | 83.3% | 75.0% | 66.7% | **94.4%** | 33.3% | 63,849 | 10.06秒 |
| 金融 compliance governance / Actual | **83.3%** | 83.3% | 75.0% | **83.3%** | 91.7% | **50.0%** | 215,603 | 44.23秒 |
| 医療 quality-regulatory governance / Raw | 58.3% | **75.0%** | **58.3%** | 58.3% | **86.1%** | 33.3% | 63,627 | 11.62秒 |
| 医療 quality-regulatory governance / Actual | 58.3% | 66.7% | 50.0% | **75.0%** | 83.3% | 33.3% | 212,944 | 46.11秒 |
| Software SRE incident_change / Raw | 75.0% | 83.3% | 75.0% | 75.0% | 94.4% | 33.3% | 65,208 | 7.72秒 |
| Software SRE incident_change / Actual | **91.7%** | **100.0%** | **91.7%** | **83.3%** | **100.0%** | **66.7%** | 185,400 | 32.36秒 |

technical_specでは差が明確で、Actualは数値仕様の3問を全てStrict Passにした。Rawは回答要素を100%生成したにもかかわらず、必要な仕様書と改訂書を揃えて引用できず、6問全てStrict NGだった。一方、草案と試験記録が現行仕様を変えるかを問う3問はActualでも全てNGであり、関係抽出の欠落がそのまま上限になった。

金融コンプライアンスではActualの改善幅が小さい。Strict Passは2/6から3/6へ増え、引用は16.6ポイント改善したが、回答根拠は同率で、回答要素は2.7ポイント下がった。この結果は、Relation Dossierがどの領域でも一様に大差をつけるわけではないことも示している。

医療・品質薬事部では、ActualはStrict PassがRawと同じ2/6で、検索R@10、回答根拠、回答要素がRawを下回った。引用は改善したが、FAQ矛盾を3組とも抽出できず、scenario-02の版更新も欠落した。この評価群は、現在のコンパイルがRawに勝たない明確な反例である。

SREのincident_changeでは、ActualはStrict Passを2/6から4/6、検索R@10を83.3%から100%へ改善した。`release records_execution_of change`は3組とも正しく抽出でき、実施済みか提案段階かを分ける質問にRelation Dossierが有効だった。ただし、最終報と初報の関係を`supersedes`ではなく`amends`と分類しており、検索できたことと関係種別が正しいことは分けて評価する必要がある。

## governance反復で分かった非決定性

製品設計部governanceの検索専用評価は固定され、Relation DossierのR@5は91.7%である。しかし回答評価では、Lunaが質問ごとにDossier Planを生成し、そのPlanで再検索するため、回答へ渡る根拠集合も試行ごとに変わった。

| Actual試行 | Dossier根拠 | 引用 | 回答要素 | 自動Strict | 入力tokens | 平均待ち時間 |
|---|---:|---:|---:|---:|---:|---:|
| 1 | 83.3% | 91.7% | 100.0% | 50.0%（3/6） | 197,455 | 40.09秒 |
| 2 | 91.7% | 100.0% | 100.0% | 83.3%（5/6） | 212,805 | 42.73秒 |
| 3 | 75.0% | 83.3% | 100.0% | 33.3%（2/6） | 213,936 | 43.55秒 |
| 3試行合計 | 83.3% | 91.7% | 100.0% | 55.6%（10/18） | 624,196 | 42.13秒 |

監査後の合計Strict Passは11/18、61.1%になる。質問別ではS2-GOV-1だけが3/3でStrict Pass、S3-GOV-2は0/3だった。残る質問は1/3または2/3であり、偶然一度成功したことを機能完成とみなせない。Codex App Server経路では評価器のseedを適用できないため、同じ入力でもDossier Plan、slot選択、引用が変わる。

現在の回答経路は、1問あたり最低3回のLuna呼び出しを行う。slotが不足してEvidence fallbackを使う場合は、slot選択をもう一度呼び出す。

1. 質問からDossier Planを生成する。
2. 取得資料から回答slotとcitation IDを選ぶ。
3. 検証済みslotを自然文へ変換する。

この構造は自由回答より制御しやすいが、最初のPlanが非決定的なので検索結果まで揺らす。まずPlanを固定・保存して回答生成だけを反復する評価と、Planから全工程を反復する評価を分ける必要がある。

## コンパイル段階で見つかった欠落と誤接続

technical_spec Buildは12文書から37 Claim、12 Relation、12 Dossierを生成した。`amends`と`records_execution_of`は抽出したが、Goldで必要な`proposes_change_to`を3組とも生成していない。さらにscenario-03の`test.md`をscenario-02の`amd-01.md`へ接続しており、シナリオ境界を越えた誤Relationが1件ある。文書数やRelation数が揃っていても、種類と接続先が正しいとは限らない。

金融コンプライアンスBuildは42 Claim、8 Relation、8 Dossierを生成した。正式規程の`supersedes`は3組全て抽出したが、FAQの`conflicts_with`と`order_of_precedence`はscenario-02だけで、scenario-01と03を落とした。このためActualのR@20は83.3%で、Raw + Purposeの100%を下回った。

医療・品質薬事部Buildは38 Claim、4 Relation、4 Dossierに留まった。FAQの`conflicts_with`を3組とも抽出せず、scenario-02の`supersedes`も欠落した。SRE Buildは54 Claim、6 Relation、6 Dossierを生成し、変更申請とリリースの`records_execution_of`を3組全て正しく接続したが、最終報と初報の3組を`supersedes`ではなく`amends`へ分類した。

5評価群を関係型で見ると、`records_execution_of`は比較的安定している。一方、`conflicts_with`は製品設計、金融、医療で抽出率が変動し、`proposes_change_to`はtechnical_specで3組全て欠落した。現在の精度差は業種そのものより、Relation種別と文書表現への依存が大きい。

これらはGoldを製品へ埋め込む理由にはならない。コンパイラ自身が次の構造的不整合をWarningまたは公開ゲートとして検出できるようにする。

- 草案Profileがあるのに`proposes_change_to`がない。
- 試験記録の`records_execution_of`が異なるscenarioやscopeへ接続している。
- FAQと現行規程が同じ対象について異なる値を述べるのに、`conflicts_with`または優先関係がない。
- Relation数はあるが、対象文書が孤立している、または同じ文書対へ重複した意味のRelationが偏っている。

## コンパイル時間とキャッシュ

technical_specのRelation対応再コンパイルは309.4秒かかった。以前のClaim Buildが存在したが、現行コードでキャッシュキーが変わっていたため12文書全てがmissとなり、Claim抽出12回と文書関係Profile生成1回を再実行した。金融コンプライアンスは新規領域なので12 missが正常で、277.5秒だった。

精度改善時にprompt、schema、正規化、model IDのどれを変えたかをキャッシュキー内訳として記録しなければ、必要な再抽出と偶発的な全失効を区別できない。Dossier Plan、slot選択、自然文化、judgeにも段階別キャッシュを追加すると、回答反復のコストを大きく下げられる。

## 判断と次の改善順序

Relation Dossierは引き続き製品候補とする。30問全体で検索R@5、引用、Strict PassがRaw + Purposeを上回り、SREの時系列・変更記録でも効果を確認できたからである。ただし、医療ではStrictが同率で、R@20は全体でもRawを下回ったため、現在のまま既定経路へ昇格させない。次はコーパスをさらに増やす前に、Relation完全性とDossier組立の再現性を直す。

1. Dossier Planを成果物として保存し、同じPlanでslot・回答だけを反復できるようにする。既定PlanはintentのAnswer Contractから決定的に生成し、LLMによる追加slotは明示的な拡張として分離する。
2. Relation graphへscope整合性、文書role別の期待関係、孤立文書、重複関係の検査を加える。異なるscenarioへの誤接続はError候補、期待関係の欠落はWarning候補とする。
3. 採点を、根拠・引用の決定的照合と、回答要素・behaviorの意味判定へ分ける。禁止要素は否定・訂正された引用を数えない規則を先に適用する。
4. Plan、slot、自然文化の入力を記録し、選択したRelationと短い原文だけを渡す。品質を維持しながらActual入力をRawの1.5倍以内へ近づける。
5. 修正後、今回の5評価群を各5回反復する。検索はActualがRaw + PurposeのR@5を下回らず、R@20で必要関係を欠かさないことを回答評価の入口条件にする。
6. そのゲートを通過してから、物流・通関部のcommercial_complianceとエネルギー・系統運用部のoperationsを追加する。契約・法令優先関係と運用手順・例外記録という別の関係型を検証し、その後に40部門へ広げる。

現時点の結論は、「事前コンパイルはRaw RAGより正しい根拠を上位へ集め、引用とStrict Passを改善しやすい」という仮説を30問で支持した、である。ただし「必要情報を欠落させず、全領域でRawを上回る」という仮説は、R@20と医療の結果から支持されなかった。次の主要課題は検索方式の追加ではなく、関係グラフのRecall検証と回答資料組立の決定化である。

## 実験記録

- 製品設計governance検索: `target/benchmarks/enterprise-actual-retrieval/2026-08-02-manufacturing-product-design-governance-luna-relation-v3-detailed/`
- 製品設計governance Actual反復: `target/benchmarks/enterprise-answer-evaluation/2026-08-02-manufacturing-product-design-governance-luna-answer-v1/`、`target/benchmarks/enterprise-answer-evaluation/2026-08-02-manufacturing-product-design-governance-luna-answer-repeat-v2/`、`target/benchmarks/enterprise-answer-evaluation/2026-08-02-manufacturing-product-design-governance-luna-answer-repeat-v3/`
- 製品設計governance Raw: `target/benchmarks/enterprise-answer-evaluation/2026-08-02-manufacturing-product-design-governance-raw-tuned-purpose-luna-answer-v1/`
- 製品設計technical_spec Build: `target/benchmarks/enterprise-domain-actual/2026-08-02-manufacturing-product-design-technical-spec-luna-v1/knowledge-build-relation-v1/`
- 製品設計technical_spec検索: `target/benchmarks/enterprise-actual-retrieval/2026-08-02-manufacturing-product-design-technical-spec-luna-relation-v1/`
- 製品設計technical_spec回答: `target/benchmarks/enterprise-answer-evaluation/2026-08-02-manufacturing-product-design-technical-spec-luna-actual-v2/`、`target/benchmarks/enterprise-answer-evaluation/2026-08-02-manufacturing-product-design-technical-spec-luna-raw-purpose-v1/`
- 金融コンプライアンスBuild: `target/benchmarks/enterprise-domain-actual/2026-08-02-finance-compliance-governance-luna-v1/knowledge-build/`
- 金融コンプライアンス検索: `target/benchmarks/enterprise-actual-retrieval/2026-08-02-finance-compliance-governance-luna-relation-v1/`
- 金融コンプライアンス回答: `target/benchmarks/enterprise-answer-evaluation/2026-08-02-finance-compliance-governance-luna-actual-v1/`、`target/benchmarks/enterprise-answer-evaluation/2026-08-02-finance-compliance-governance-luna-raw-purpose-v1/`
- 医療・品質薬事部Build: `target/benchmarks/enterprise-domain-actual/2026-08-02-healthcare-quality-regulatory-governance-luna-v1/knowledge-build/`
- 医療・品質薬事部検索: `target/benchmarks/enterprise-actual-retrieval/2026-08-02-healthcare-quality-regulatory-governance-luna-relation-v1/`
- 医療・品質薬事部回答: `target/benchmarks/enterprise-answer-evaluation/2026-08-02-healthcare-quality-regulatory-governance-luna-actual-diagnostic-v1/`、`target/benchmarks/enterprise-answer-evaluation/2026-08-02-healthcare-quality-regulatory-governance-luna-raw-purpose-diagnostic-v1/`
- Software・SRE部Build: `target/benchmarks/enterprise-domain-actual/2026-08-02-software-sre-incident-change-luna-v1/knowledge-build/`
- Software・SRE部検索: `target/benchmarks/enterprise-actual-retrieval/2026-08-02-software-sre-incident-change-luna-relation-v1/`
- Software・SRE部回答: `target/benchmarks/enterprise-answer-evaluation/2026-08-02-software-sre-incident-change-luna-actual-v1/`、`target/benchmarks/enterprise-answer-evaluation/2026-08-02-software-sre-incident-change-luna-raw-purpose-v1/`

各検索ディレクトリには`manifest.json`、`metrics.json`、`retrieval.jsonl`、`REPORT_ja.md`、`command.txt`がある。各回答ディレクトリには`upper-bound-report.json`と条件別JSONLがあり、質問別の取得資料、Dossier Plan、slot、引用、回答、judge、usageを保持する。
