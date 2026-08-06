# Luna回答モデル比較 2026-08-02

この評価では、検索索引を変えずに回答モデルを`gemma4:latest`から`gpt-5.6-luna`へ替え、回答変換の失敗がモデル能力によるものかを確認した。主要比較基準のRaw Tuned + PurposeにもLunaを使い、Fragrachの効果とLuna単体の効果を分離した。

結論として、LunaはFragrachのDossierをGemmaより有効に利用した。Actual Relation Dossierの回答要素再現率は61.1%から100.0%、自動Strict Passは16.7%から50.0%へ改善した。同じLunaでRaw Tuned + Purposeと比較しても、Strict Passは16.7%から50.0%へ上がった。したがって、これまでの主要な失敗はコンパイル結果だけでなく、Gemmaによる回答変換にもあった。

ただし6問だけの結果であり、Luna経路はseedを適用できず、入力tokenも多い。現段階では有望な参照実装であって、一般化された製品優位性の証明ではない。

## 比較条件

全条件で同じ6問、top-k 5、同じGold、Gemmaによる質問単位の独立採点を使った。Raw Tuned + Purposeはgovernanceの12文書・60原文chunk、Actualは同じ12文書から作った51個のClaim + Relation Dossier Unitを検索する。

| 条件 | 検索資料 | 回答経路 | 回答モデル | 採点モデル | 評価上の役割 |
|---|---|---|---|---|---|
| Raw + Purpose / Gemma | 調整済み原文chunk | top 5から直接回答 | `gemma4:latest` | `gemma4:latest` | 従来の主要Raw基準 |
| Actual Dossier / Gemma | Claim + Relation Dossier | Plan、slot、必要時fallback、自然文化 | `gemma4:latest` | `gemma4:latest` | 従来のFragrach結果 |
| Raw + Purpose / Luna | 調整済み原文chunk | top 5から直接回答 | `gpt-5.6-luna`、effort `low` | `gemma4:latest` | Luna単体の回答能力を測る基準 |
| Actual Dossier / Luna | Claim + Relation Dossier | Plan、slot、必要時fallback、自然文化 | `gpt-5.6-luna`、effort `low` | `gemma4:latest` | FragrachとLunaを組み合わせた評価対象 |

ActualのKnowledge Build自体も`gpt-5.6-luna`で生成済みである。今回変更したのは検索後のPlan、slot、最終回答生成であり、索引と検索スコアはGemma回答評価から変更していない。

## 集計結果

| 指標 | Raw + Purpose / Gemma | Actual / Gemma | Raw + Purpose / Luna | Actual / Luna |
|---|---:|---:|---:|---:|
| 根拠再現率@5 | 58.3% | 83.3% | 58.3% | 83.3% |
| 引用再現率 | 50.0% | 75.0% | 58.3% | **91.7%** |
| 回答要素再現率 | 63.9% | 61.1% | 94.4% | **100.0%** |
| behavior accuracy | 100.0% | 100.0% | 100.0% | 100.0% |
| 自動禁止誤答率 | 0.0% | 0.0% | 16.7% | 16.7% |
| 自動Strict Pass | 0.0%（0/6） | 16.7%（1/6） | 16.7%（1/6） | **50.0%（3/6）** |
| 監査後Strict Pass | 0.0%（0/6） | 16.7%（1/6） | 16.7%（1/6） | **66.7%（4/6）** |
| 入力tokens | 8,808 | 66,337 | 62,029 | 197,455 |
| 出力tokens | 1,473 | 9,062 | 1,727 | 7,308 |
| 平均回答待ち時間 | 8.94秒 | 44.48秒 | 10.78秒 | 40.09秒 |
| Evidence fallback | n/a | 3/6 | n/a | 0/6 |

Luna同士で比較すると、ActualはRaw + Purposeより根拠再現率を25.0ポイント、引用を33.4ポイント、回答要素を5.6ポイント、自動Strict Passを33.3ポイント改善した。これは回答モデルをLunaへ揃えてもFragrachの検索資料に効果があることを示す。

Actual同士で回答モデルを比較すると、LunaはGemmaより引用を16.7ポイント、回答要素を38.9ポイント、自動Strict Passを33.3ポイント改善した。Lunaでは全slotを最初のDossierで充足し、Evidence fallbackが一度も発火しなかった。Gemmaでは3問でfallbackが必要だったため、Lunaは入力tokenが約3倍であるにもかかわらず、平均回答待ち時間は約10%短かった。

## 質問別結果

数値は根拠再現率、引用再現率、回答要素再現率の順である。

| 質問 | Raw + Purpose / Luna | Actual / Luna | Actual自動Strict | 主な結果 |
|---|---:|---:|---:|---|
| S1-GOV-1 | 100 / 100 / 100% | 50 / 50 / 100% | NG | Lunaは回答要素を満たしたが、ActualのPlanが旧版側根拠をtop 5へ入れなかった |
| S1-GOV-2 | 50 / 50 / 67% | 100 / 100 / 100% | PASS | DossierによりFAQ未反映、共同承認、正式規程優先をすべて回答した |
| S2-GOV-1 | 50 / 50 / 100% | 100 / 100 / 100% | PASS | Gemmaで失敗したslotとcitation IDの接続をLunaが完了した |
| S2-GOV-2 | 50 / 50 / 100% | 100 / 100 / 100% | NG | 内容は正しいが、Gemma採点が否定された旧規則を禁止誤答と誤判定した |
| S3-GOV-1 | 50 / 50 / 100% | 100 / 100 / 100% | PASS | 現行5年、v2適用、旧版失効を両側引用で回答した |
| S3-GOV-2 | 50 / 50 / 100% | 50 / 100 / 100% | NG | 回答と引用は揃ったが、コンパイル時に取りこぼしたFAQ RelationのためGold根拠が片側不足した |

## Q4の採点監査

S2-GOV-2のLuna回答は、「FAQには『担当課長の単独承認でよい』という旧案内が残っていますが、正式規程（第2版）が優先されます」「部門長と統制責任者の二者承認を得てください」と述べた。採点規則は、禁止要素を誤りとして否定・訂正した記述を`present_forbidden_answer_elements`へ含めないと定めている。それにもかかわらず、Gemma採点は引用された旧案内を「現行規則として断定」と判定した。

この判定は採点規則と回答内容に反するため、監査後はS2-GOV-2を禁止誤答なし、Strict Passとして扱う。Actual / Lunaの監査後Strict Passは4/6、禁止誤答率は0%になる。同じ誤判定はRaw + Purpose / Lunaにも発生したが、Raw側は必要根拠と引用が50%のため、訂正してもStrict Passは1/6のままである。自動集計値は再現性のため変更せず、監査値を別記録とした。

## 残った課題

今回、回答変換のボトルネックは大きく改善したが、次の課題は残る。

- Actual / Lunaの入力tokenはRaw + Purpose / Lunaの3.18倍である。Plan、slot、自然文化の三段処理を統合する余地がある。
- S1-GOV-1は単独スモークではStrict Passしたが、6問実行では旧版側根拠を取りこぼした。Codex App Server経路は評価器のseedを適用できないため、Plan生成の再現性を別途測る必要がある。
- S3-GOV-2は回答モデルでは救えず、コンパイル時のRelation完全性が制約になっている。
- 採点モデルがGemma一種類であり、否定文を含む禁止要素判定に誤りが出た。決定的な規則判定と独立した別モデルによる監査が必要である。
- 6問では1問が16.7ポイントに相当する。次の判断には、他の用途・部門を含む質問数の拡大が必要である。

現時点では、`Actual Relation Dossier + Luna回答`が最良の測定条件である。検索資料の価値と回答変換の改善が同時に確認できたため、次の参照経路として採用する。ただし既定の製品経路へ昇格させる前に、再現性、Relation完全性、採点器、tokenコストを改善する。

## 実験記録

Actual / Lunaは`target/benchmarks/enterprise-answer-evaluation/2026-08-02-manufacturing-product-design-governance-luna-answer-v1/`、Raw + Purpose / Lunaは`target/benchmarks/enterprise-answer-evaluation/2026-08-02-manufacturing-product-design-governance-raw-tuned-purpose-luna-answer-v1/`に保存した。各`upper-bound-report.json`に集計、JSONLに質問別の検索結果、回答、引用、Dossier、judge、usageを保持する。

Gemma比較は、Actualが`target/benchmarks/enterprise-answer-evaluation/2026-08-02-manufacturing-product-design-governance-luna-relation-dossier-v4-q1/`から`v4-q6/`、Raw + Purposeが`target/benchmarks/enterprise-answer-evaluation/2026-08-02-manufacturing-product-design-governance-raw-tuned-purpose-answer-v1/`にある。

この6問を3回反復し、technical_specと金融コンプライアンスへ広げた評価は`docs/evaluations/expanded-luna-evaluation-2026-08-02_ja.md`に記録した。反復により、検索専用評価が固定でもLunaのDossier Plan生成が取得根拠とStrict Passを変動させることが分かった。
