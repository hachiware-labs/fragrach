# Mコーパス500文書・100問評価

通常条件で7つのIntentをすべてコンパイルし、100問を評価した。その後、抽出カバレッジが低かったIncident ResponseとOnboardingの抽出契約を改善し、500文書の条件を揃えて再測定した。

初回評価では、Fragrachは利用目的とClaim抽出が適合した質問群でRaw RAGより良かった。Design ReviewはR@5が37.5%から62.5%、Project Historyは50.0%から62.5%へ上がった。Design ReviewのEvidence Dossierは最終回答のStrict Passを0%から50.0%へ改善した。

一方、初回の100問全体ではActual ClaimのR@5が44.7%で、Raw RAGの57.7%を下回った。Incident Response、Compliance Audit、Onboardingでは、必要な事実がClaimにならず、top 20へ広げても回復しなかった。

抽出契約の改善後、Incident ResponseはR@10が13.0%から94.2%、OnboardingはR@5が46.4%から71.4%へ改善した。現在の7 Intent Buildを組み合わせた100問検索評価では、Actual ClaimのR@5はRawと同じ57.7%、R@10はRawを1.3ポイント上回る73.5%まで回復した。Incident ResponseのEvidence Dossierも、同じ23問・top 10の直接比較でStrict Pass 82.6%となり、Raw RAGの21.7%とClaim直接回答の52.2%を上回った。ただし、Actual ClaimのR@20はRawより12.2ポイント低く、100問の最終回答評価も行っていないため、製品全体でRaw RAGより高精度とはまだ結論しない。

## 評価条件

Source Corpusは500文書、206,860文字である。パーサーは完全重複31文書を除いた469文書から5,065 Evidenceを生成した。質問は旧100文書から引き継いだ16問と、追加した84問の合計100問である。

検索評価には日本語文字n-gram BM25を使い、回答モデルや採点モデルを呼ばない。根拠の一致にはSourceとSectionだけでなく、質問ごとに定義した`content_terms`も必要とする。同じ見出しの別段落を取得しても成功には数えない。

Gold Oracleには追加84問の`gold/answers.jsonl`、Conflict、Alias、Versionを読み込む。旧16問は`evaluation/questions.jsonl`から同じ形式へ補完する。Oracleの検索文には評価質問そのものを入れていない。

Actual Claimは、500文書を質問のIntentごとに通常のsource-separated条件でコンパイルしたBuildを使う。複数Sourceを一つの抽出要求へまとめる実験Buildは使っていない。公開ポリシーで停止したBuildも、保存されたClaims、Evidence、Conflictsを検索評価に使用した。

## 通常コンパイルの結果

全Intentとも494回のLLM呼び出しを行った。Data Export OperationとCompliance Auditは未解決Conflictを許可しないため、成果物を保存して公開を停止した。これは実行障害ではなく、期待どおりのConflictゲート動作である。

| Intent | 状態 | Claims | 棄却 | Conflicts | 未解決 | 警告 | 時間 |
|---|---|---:|---:|---:|---:|---:|---:|
| Design Review | 警告付き完了 | 210 | 14 | 10 | 6 | 20 | 32.7分 |
| Incident Response | 警告付き完了 | 99 | 36 | 5 | 5 | 41 | 25.3分 |
| Developer Onboarding | 警告付き完了 | 206 | 41 | 5 | 2 | 45 | 34.0分 |
| Data Export Operation | Conflictゲート停止 | 110 | 38 | 6 | 2 | 40 | 26.2分 |
| Compliance Audit | Conflictゲート停止 | 1,170 | 484 | 6 | 4 | 488 | 141.4分 |
| Onboarding | 警告付き完了 | 274 | 119 | 0 | 0 | 119 | 44.5分 |
| Project History | 警告付き完了 | 651 | 192 | 30 | 26 | 218 | 77.6分 |

Compliance Auditは282,499 completion tokensを生成し、他Intentより大幅に長かった。Project Historyも145,625 completion tokensを要した。キャッシュ、進捗表示、途中再開に加え、Intentごとの出力制御が必要である。

## 100問のLLMなし検索評価

全体ではActual ClaimがRaw RAGを下回った。

| 条件 | R@5 | R@10 | R@20 |
|---|---:|---:|---:|
| Raw RAG | 57.7% | 72.2% | 92.7% |
| Actual Claim | 44.7% | 52.5% | 55.0% |
| Gold Oracle | 96.8% | 97.2% | 97.7% |

既存16問ではActual ClaimがRawを上回ったが、追加84問では大きく下回った。小規模評価で確認した改善を、そのまま新しい質問分布へ一般化できない。

| 質問群 | Raw R@5 | Claim R@5 | Raw R@20 | Claim R@20 |
|---|---:|---:|---:|---:|
| 既存16問 | 60.4% | 69.8% | 72.9% | 75.0% |
| 追加84問 | 57.1% | 39.9% | 96.4% | 51.2% |

Intent別では、Design ReviewとProject HistoryだけがR@5を改善した。Data Export Operationは2問しかなく同率なので、改善とは判定しない。

| Intent | 問数 | Raw R@5 | Claim R@5 | 差 | Claim R@20 |
|---|---:|---:|---:|---:|---:|
| Design Review | 8 | 37.5% | 62.5% | +25.0pt | 62.5% |
| Project History | 20 | 50.0% | 62.5% | +12.5pt | 100.0% |
| Data Export Operation | 2 | 100.0% | 100.0% | 0.0pt | 100.0% |
| Compliance Audit | 30 | 60.0% | 48.3% | -11.7pt | 55.0% |
| Developer Onboarding | 3 | 83.3% | 50.0% | -33.3pt | 66.7% |
| Onboarding | 14 | 71.4% | 46.4% | -25.0pt | 46.4% |
| Incident Response | 23 | 52.9% | 11.6% | -41.4pt | 13.0% |

Project HistoryはR@20で100%へ達するため、残る問題は主に順位である。Design ReviewはRawより良いがR@20でも62.5%に止まり、Claim欠落も残る。

Incident Response、Onboarding、Compliance AuditはR@20でもほとんど回復しない。追加Evidenceのうち、少なくとも一つのClaimから参照された割合は、Incident 2.2%、Compliance表形式ケース7.9%、Onboarding 16.0%、Project History 21.5%だった。Incident追加20問では全問で必要Evidenceの一部がClaim検索から欠落した。現在の抽出PromptとPredicateカタログは、規程上の義務や期限には比較的強いが、事象の経緯、表の全項目、オンボーディング資料の組み合わせを十分に残していない。

これはrerankだけでは直せない。Compile段階でGoldに相当する事実がClaimまたは回答用Evidenceとして存在するかを、検索評価より前に測る必要がある。

## 良好な質問群の最終回答評価

検索R@5がRawを上回ったDesign ReviewとProject Historyだけ、`gemma4:latest`で最終回答を評価した。Raw、Claim直接回答、Evidence Dossier、Gold Oracleを比較している。生成と採点は質問ごとに隔離した。

### Design Review 8問

| 条件 | Strict Pass | 根拠 | 引用 | 回答要素 | 動作 | 禁止誤答 | 入力token |
|---|---:|---:|---:|---:|---:|---:|---:|
| Raw RAG | 0.0% | 37.5% | 50.0% | 71.9% | 87.5% | 0.0% | 6,539 |
| Claim直接回答 | 12.5% | 62.5% | 68.8% | 84.4% | 100.0% | 0.0% | 11,014 |
| Evidence Dossier | 50.0% | 68.8% | 93.8% | 92.7% | 100.0% | 0.0% | 25,310 |
| Gold Oracle | 75.0% | 93.8% | 93.8% | 96.9% | 100.0% | 0.0% | 8,543 |

通常条件のDossierは、Claim直接回答に対してStrict Passを37.5ポイント、引用を25.0ポイント、回答要素を8.3ポイント改善した。同じClaim Buildを使っているため、この差は検索後のEvidence Dossier組み立てによる。

一方、入力tokenはRawの約3.9倍である。品質改善は明確だが、Dossierの圧縮余地は大きい。

### Project History 20問

| 条件 | Strict Pass | 根拠 | 引用 | 回答要素 | 動作 | 禁止誤答 | 入力token |
|---|---:|---:|---:|---:|---:|---:|---:|
| Raw RAG | 0.0% | 50.0% | 47.5% | 98.3% | 100.0% | 5.0% | 14,324 |
| Claim直接回答 | 20.0% | 60.0% | 57.5% | 93.3% | 100.0% | 0.0% | 19,700 |
| Evidence Dossier | 20.0% | 70.0% | 57.5% | 100.0% | 100.0% | 0.0% | 42,945 |
| Gold Oracle | 35.0% | 100.0% | 70.0% | 95.0% | 100.0% | 0.0% | 22,476 |

DossierはClaim直接回答に対して根拠を10.0ポイント、回答要素を6.7ポイント改善したが、Strict Passと引用は同率だった。Rawにあった禁止誤答を0%へ下げた点は有効である。

Gold OracleでもStrict Passは35.0%に止まる。Project Historyでは検索以外に、引用選択、複数時点の記述、採点契約との整合がボトルネックとして残る。

## Incident・Onboarding抽出契約の改善

Compile Coverage導入後、追加質問の欠落を再分析した。Incident Responseでは確定原因と恒久対策、Onboardingでは正式責任者の未指定と担当経験者の未承認がClaimになりにくかった。

抽出契約へ`incident_cause`、`temporary_remediation`、`permanent_remediation`、`has_formal_owner`、`is_approved_as`を追加し、各Intentにも対応する質問を加えた。否定文を空の値として返さないよう、`unspecified`と真偽値を使う例をPromptとSchemaへ加えている。

Source Corpus全体ではなく、該当する生成文書だけを部分走査して抽出再現性を確認した。Sourceパスの起点が通常Buildと異なるため、この実験ではR@kを比較していない。GoldのSource suffix、Section、`content_terms`を満たすEvidenceがClaimから参照されたかを直接照合した。

| 質問群 | 旧Build Compile Coverage | 新契約・補強前 | 新契約・補強後 |
|---|---:|---:|---:|
| Incident追加20問 | 42.5% | 80.0% | 100.0% |
| Onboarding追加14問 | 46.4% | 100.0% | 100.0% |

Incidentの補強前に残った8件も、原因または恒久対策のClaim自体は生成されていた。LLMが専用の「原因」「恒久対策」節ではなく、同じ内容を含む概要節だけを引用したため、Sectionを含むCompile Coverageでは欠落として扱われていた。そこで、同一Source内にある述語対応の専用節を決定的にEvidenceへ追加した。再抽出は不要で、保存済み80バッチをすべて再利用し、LLM 0回、189msで40/40根拠へ改善した。

| Intent | 対象文書 | 初回LLM呼び出し | 入力token | 初回時間 | Claims | 棄却 |
|---|---:|---:|---:|---:|---:|---:|
| Incident Response | 80 | 80 | 211,534 | 22.7分 | 262 | 1 |
| Onboarding | 70 | 70 | 177,133 | 15.0分 | 180 | 0 |

Incident Buildは`has_status`の未解決Conflictを1件検出し、Intentが未解決Conflictを許可しないため公開を停止した。抽出処理の失敗ではなく、Conflictゲートの期待動作である。

この結果は抽出カバレッジの改善を示すが、通常Buildより索引対象が狭い。Raw RAGとのR@kおよび最終回答精度は、Sourceパスと500文書の索引範囲を揃えたBuildで改めて評価する必要がある。

## Incident・Onboardingの500文書再測定

部分走査で確認した抽出契約を使い、469文書、5,065 Evidenceの通常条件で再コンパイルした。両Intentとも494回のLLM呼び出しを行い、キャッシュは初回測定のため全件missだった。

| Intent | 状態 | Claims | 棄却 | Conflicts | 未解決 | 警告 | 時間 |
|---|---|---:|---:|---:|---:|---:|---:|
| Incident Response | Conflictゲート停止 | 495 | 0 | 7 | 6 | 6 | 53.0分 |
| Onboarding | 警告付き完了 | 409 | 0 | 8 | 8 | 8 | 45.3分 |

Incident Responseは未解決Conflictを許可しないため公開を停止した。検索評価には、停止時に保存されたClaims、Evidence、Conflictsを使用した。OnboardingはIntent設定に従い、未解決Conflictを警告として成果物を生成した。

検索評価は、初回と同じ質問、500文書、BM25、Gold照合条件で行った。

| Intent | 条件 | Compile Coverage | R@5 | R@10 | R@20 |
|---|---|---:|---:|---:|---:|
| Incident Response | 旧Claim | 13.0% | 11.6% | 13.0% | 13.0% |
| Incident Response | 新Claim | 100.0% | 52.9% | 94.2% | 100.0% |
| Incident Response | Raw RAG | 100.0% | 52.9% | 61.6% | 98.6% |
| Onboarding | 旧Claim | 46.4% | 46.4% | 46.4% | 46.4% |
| Onboarding | 新Claim | 92.9% | 71.4% | 71.4% | 85.7% |
| Onboarding | Raw RAG | 100.0% | 71.4% | 92.9% | 100.0% |

Incident Responseでは、新ClaimのR@10がRawを32.6ポイント上回った。追加20問だけを見るとR@10は95.0%であり、旧Buildの0%から回復した。R@5はRawと同率なので、抽出後の知識は存在するものの、必要な複数Evidenceを上位5件へ集める順位付けは残る。

Onboardingでは、「正式責任者が定められていない」「担当経験者は正式責任者として承認されていない」という情報不在・否定の8問がR@5 100%へ改善した。一方、役割に関する6問はR@5 33.3%、R@20 66.7%である。Claim数が増えたことで必要な知識も残るようになったが、役割Claimの順位が希釈されている。

検索結果が良好だったIncident Responseだけ、top 10で最終回答を比較した。Raw、Gold Oracle、新Claimは検索結果から直接回答し、Evidence Dossierは回答スロットを計画してから根拠を組み立てた。

| 条件 | Strict Pass | 根拠 | 引用 | 回答要素 | 動作 | 禁止誤答 | 入力token |
|---|---:|---:|---:|---:|---:|---:|---:|
| Raw RAG | 21.7% | 61.6% | 58.7% | 79.7% | 100.0% | 0.0% | 31,142 |
| 新Claim直接回答 | 52.2% | 94.2% | 92.8% | 82.6% | 100.0% | 4.3% | 45,881 |
| Evidence Dossier | 82.6% | 98.6% | 98.6% | 95.7% | 100.0% | 0.0% | 64,205 |
| Gold Oracle直接回答 | 73.9% | 92.0% | 96.4% | 96.0% | 100.0% | 0.0% | 40,893 |

新ClaimはRawに対してStrict Passを30.5ポイント改善し、Evidence Dossierはさらに30.4ポイント改善した。Dossierは19/23問に合格し、禁止誤答も0件だった。抽出契約で必要なEvidenceを残し、Dossierで回答スロットへ割り当てる一連の設計が、検索改善を最終回答へ変換できている。

Gold Oracleは直接回答アダプター、新ClaimのDossierはスロット計画と不足Evidenceの補完を使うため、このOracleは数学的な上限ではない。DossierがOracleのStrict Passを上回った結果は、Gold知識の品質よりも回答組み立て方式の差を含む。

### 矛盾と不要根拠を含む検索品質

R@kは必要根拠の再現率であり、不要な検索単位が混ざっても減点しない。この性質を分離するため、不要単位率、矛盾両側の再現率、Conflictユニット再現率、解決順位の正しさを追加した。Resolution Accuracyは矛盾の両側を取得できた質問だけを分母にし、評価可能率をCoverageとして併記する。

Incident Response 23問のうち、矛盾開示が必要な質問はIR-001とIR-003の2問である。

| 条件 | k | 不要単位率 | 矛盾両側の再現率 | 両側完全取得 | Conflict Unit | 解決精度 | 解決Coverage |
|---|---:|---:|---:|---:|---:|---:|---:|
| Raw RAG | 5 | 78.3% | 75.0% | 50.0% | 対象外 | 0.0% | 50.0% |
| Raw RAG | 10 | 87.4% | 75.0% | 50.0% | 対象外 | 0.0% | 50.0% |
| 新Claim | 5 | 78.3% | 50.0% | 0.0% | 0.0% | 判定不能 | 0.0% |
| 新Claim | 10 | 80.9% | 75.0% | 50.0% | 0.0% | 0.0% | 50.0% |
| 新Claim | 20 | 89.8% | 100.0% | 100.0% | 0.0% | 0.0% | 100.0% |
| Evidence Dossier | 10 | 79.3% | 75.0% | 50.0% | 0.0% | 0.0% | 50.0% |

新ClaimはR@10 94.2%まで改善したが、上位10検索単位の80.9%はGold根拠または質問別の矛盾根拠に一致しない。必要根拠は増えた一方、回答へ渡す候補はまだ十分に絞れていない。不要単位率はkを広げるほど構造的に上がりやすいため、異なるk同士ではなく、同じkの条件間で比較する。

Conflictユニット再現率はtop 20でも0%だった。Buildは7件のConflictを持つが、IR-001とIR-003の矛盾両側を結ぶConflictユニットが検索上位へ入っていない。Dossierも両側の通常Evidenceから矛盾開示を生成しており、保存されたConflictを利用していない。

解決精度も0%だった。IR-003ではFAQの競合記載が、経営管理部長の承認を定める正規手順より上位にある。IR-001はtop 10で矛盾の片側しかGold条件を満たさず、top 20で両側が揃っても競合FAQが正規標準より上位だった。最終回答の動作適合100%と禁止誤答0%は維持したが、検索段階の権威順序は正しくない。

Onboarding 14問には矛盾質問がないため、矛盾関連指標は対象外である。不要単位率はRawと新Claimで、top 5がともに74.3%、top 10が85.0%と87.1%だった。新Claimは必要情報を残せるようになったものの、役割Claimの順位希釈を解消できていないという先の判断と一致する。

### 現在の100問検索評価

改善済みのIncident ResponseとOnboardingを、他の5 Intentの既存Buildと組み合わせて100問を再評価した。これは現在利用できる7 Intentの検索品質を表す。

| 条件 | Compile Coverage | R@5 | R@10 | R@20 |
|---|---:|---:|---:|---:|
| Raw RAG | 99.5% | 57.7% | 72.2% | 92.7% |
| 旧Actual Claim | 未計測 | 44.7% | 52.5% | 55.0% |
| 現Actual Claim | 87.5% | 57.7% | 73.5% | 80.5% |
| Gold Oracle | 100.0% | 96.8% | 97.2% | 97.7% |

現Actual Claimは旧Build構成からR@5を13.0ポイント、R@10を21.0ポイント、R@20を25.5ポイント改善した。Rawとの比較ではR@5が同率、R@10は1.3ポイント上回る。ただし、R@20は12.2ポイント下回るため、Compliance Auditなどに残るCompile Coverage不足を解消する必要がある。

矛盾開示が必要な26問では、別の課題が見える。

| 条件 | k | 不要単位率 | 矛盾両側の再現率 | 両側完全取得 | Conflict Unit | 解決精度 | 解決Coverage |
|---|---:|---:|---:|---:|---:|---:|---:|
| Raw RAG | 10 | 85.9% | 92.3% | 84.6% | 対象外 | 90.9% | 84.6% |
| 現Actual Claim | 10 | 85.1% | 71.2% | 42.3% | 0.0% | 63.6% | 42.3% |
| Raw RAG | 20 | 90.9% | 94.2% | 88.5% | 対象外 | 87.0% | 88.5% |
| 現Actual Claim | 20 | 91.6% | 73.1% | 46.2% | 3.8% | 66.7% | 46.2% |

Actual Claimは通常質問を含む全体R@10ではRawをわずかに上回ったが、矛盾質問ではRawより弱い。top 10で矛盾の両側を完全取得できたのは11/26問、関連Conflictユニットは0/26問だった。top 20でもConflictユニットは1/26問にしか届かない。今後はClaim量を増やすだけでなく、コンパイル済みConflictを質問時の検索へ確実に接続しなければならない。

Dossierの入力tokenはRawの約2.1倍であり、目標の1.5倍以内には届いていない。次の精度課題はIncidentのtop 5順位とOnboardingの役割Claim、効率課題はDossierの圧縮である。

## 大バッチ化は採用しない

複数Sourceを一つのLLM要求へまとめる実験では、Design Reviewは48 Evidence単位で79 Claims、R@5 68.8%だった。一方、Incident Responseは192 Evidence単位で20 Claimsしか生成せず、R@5は5.8%まで落ちた。

単純な大バッチ化はClaim抽出を大きく損なうため、実験実装は製品コードから戻した。本レポートの正式結果には通常条件のBuildだけを使用している。

## 現時点の判断

Fragrachの価値は、初回評価より強い条件で確認できた。抽出契約を利用目的へ適合させることで、500文書でも検索と最終回答が改善した。

> Fragrachは、利用目的に必要な事実をClaimへコンパイルし、Raw RAGより正しい根拠を上位へ配置できる。Evidence Dossierは、その検索改善を引用可能で制約に沿った回答へ変換する。

現時点では、次の表現はできない。

> Fragrachは100問全体で通常RAGより高精度である。

100問全体の検索再評価ではR@10がRawをわずかに上回ったが、最終回答の改善を確認したのはIncident Response 23問だけである。次の実装優先度は以下である。

1. Onboardingの役割Claimを、別名と承認状態を使ってrerankする。
2. Incident Responseの矛盾両側をConflictユニットへ結び、正規根拠を権威順で上位へ置く。
3. Compliance Auditの表形式Evidenceに対応する抽出契約を追加する。
4. Project Historyは抽出量を増やすより、時点・決定状態によるrerankと引用選択を改善する。
5. Dossierの入力tokenをRawの1.5倍程度へ圧縮する。
6. 残るIntentを改善した後、100問全体の最終回答を評価する。

## 再実行

100問の検索評価は、既存Buildを`--compiled-build`で一つずつ指定して再実行する。

```powershell
node tests/benchmarks/rag-comparison/run-upper-bound.mjs `
  --corpus tests/corpora/aobane-industries-ja-medium `
  --output target/benchmarks/medium-500-all-intents-retrieval `
  --retrieval-only `
  --retrieval-k 5,10,20 `
  --compiled-build <design-review-build> `
  --compiled-build <incident-response-build> `
  --compiled-build <developer-onboarding-build> `
  --compiled-build <data-export-operation-build> `
  --compiled-build <compliance-audit-build> `
  --compiled-build <onboarding-build> `
  --compiled-build <project-history-build> `
  --actual-variant baseline
```

Evidence DossierはAnswer Slot計画にLLMを使うため、`--retrieval-only`とは併用しない。
