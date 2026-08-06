# Relation Dossier Actual評価 2026-08-02

この評価では、製造業・製品設計部の規程12文書と6問を使い、文書関係を事前コンパイルしたRelation Dossierが検索と最終回答をどこまで改善するかを確認した。検索品質はRaw RAGを明確に上回った。一方、検索結果を回答スロットへ変換する工程には失敗が残り、6問のStrict Passは1問にとどまった。

## 実装した経路

Knowledge BuildはClaimに加えて`document-profiles.jsonl`、`document-relations.jsonl`、`relation-dossiers.jsonl`を発行する。Relation Dossierには文書関係、両端のProfile、関係判断に必要な短い原文を保持する。回答時は質問をAnswer Contractのslotへ分解し、Relation Dossierを含むClaim索引を先に検索する。slotが`missing`になった場合だけEvidence-only索引へ戻り、関係Unitを引用した場合は、その関係を支える両側の原文を引用へ展開する。

状態判定では、`has_status`を複数値が共存できるファセットとして扱い、`stale`を現行状態より弱い状態にした。Source front matterの`valid_from`、`valid_to`、`authority`もClaimとProfileへ伝播する。この変更により、以前は公開停止となった規程Buildが、未解決Conflict 0件の`completed_with_warnings`として公開可能になった。

## コンパイル時間とキャッシュ

Relation/Profile抽出はIntent全体を1回で処理する。v1では144 Evidenceをすべて渡したため、Profile promptは34,948 tokensだった。v2では各文書から関係判断に有効なEvidenceを最大8件選び、27,991 tokensまで20.0%削減した。completionは4,237 tokensで、合計32,228 tokensとなり、設定した32Kコンテキスト内に収まった。

| 条件 | Claim cache | Profile cache | LLM calls | 所要時間 |
|---|---:|---:|---:|---:|
| Relation v2 初回 | 12 hit / 0 miss | 0 hit / 1 miss | Profile 1 | 82.7秒 |
| Relation v2 同一入力再実行 | 12 hit / 0 miss | 1 hit / 0 miss | 0 | 76ms |

Source metadata伝播を追加した最初の再実行では、Claim入力自体が変わったためClaim cacheが12件とも正当に失効した。Relation/Profileの追加だけでClaim cacheが失効したわけではない。同一入力の再実行ではClaim 12件とProfile 1件がすべて命中した。

Relation Dossierは、両文書の全文を保持するv1の67,276 bytesから、関係別の短い原文だけを保持するv2の35,969 bytesへ46.5%縮小した。v2は12 Profile、10 Relation、10 Dossierを発行した。Goldで必要な3組の`supersedes`はすべて抽出したが、FAQ対正式規程の`conflicts_with`は2組にとどまり、1組を取りこぼした。

## 検索結果

検索条件は、同じ6問に対する文字2-gram BM25のtop-kである。ActualはGold ProfileやGold Relationを索引へ投入していない。

### 比較条件の定義

Raw条件は、tuningで選んだ固定長最大1,024文字・段落overlapなしのchunkingを使う。Actual条件はRaw chunkerを使わず、Fragrachが生成したUnitを索引化する。文字2-gram BM25（`k1=1.8`、`b=0.75`）と質問文だけのqueryは全条件で共通である。

| 条件 | 文書範囲 | 検索Unit | コンパイル情報 | 評価上の位置づけ |
|---|---|---|---|---|
| Raw Tuned | 製品設計部の全6用途、72文書、360 chunk | 最大1,024文字の原文chunk | なし | 部門横断RAGに近い運用参考値 |
| Raw Tuned + Purpose | governanceのみ、12文書、60 chunk | Raw Tunedと同じ原文chunk | Purposeによる文書範囲の絞り込みだけ | **主要比較基準**。Raw側にも利用目的を与えた強いベースライン |
| Actual Claim | governance Build、41 Unit | 短い原文抜粋、正規化Claim、compile済みConflict | 権威優先順位 | Claim化単体のアブレーション |
| Actual Claim + Relation Dossier | 同じBuild、51 Unit | Actual Claimに文書関係と両側原文のDossierを追加 | 権威、版、競合、優先関係 | **Fragrachの評価対象** |
| Actual Claim + Evidence | 同じBuild、146 Unit | Claim/Conflictに全Evidenceを常時追加 | 権威、診断由来の別名 | Evidence常時混在のアブレーション |
| Actual Evidence only | 同じBuild、144 Unit | 原文Evidence。ClaimとConflictは除外 | 診断由来の別名のみ。権威加点なし | 原文主体compiled経路の下限アブレーション |

主要な比較は`Raw Tuned + Purpose`対`Actual Claim + Relation Dossier`とする。同じgovernance 12文書を起点にするため、利用目的による範囲縮小ではなく、Fragrachの事前コンパイルが生む差を比較できる。Raw Tunedは実運用参考、その他のActual条件は原因分析用である。

### 採否に使う指標

| 優先度 | 層 | 指標 | 基準 |
|---:|---|---|---|
| 1 | 最終回答 | **Strict Pass** | 最終的な製品KPI。Raw Tuned + Purposeを上回ること |
| 2 | 検索 | **根拠再現率R@5** | 主要検索KPI。Raw Tuned + Purposeの58.3%を下回らないこと |
| 3 | 矛盾処理 | **Conflict Unit@10 / Conflict両側@10** | 関係Unitと両側原文を分けて測り、取りこぼしを残さないこと |
| 4 | 回答変換 | **回答要素再現率 / 引用再現率** | どちらもRaw Tuned + Purposeを下回らないこと |
| 5 | 安全性 | **禁止誤答率 / behavior accuracy** | 0% / 100%を維持すること |
| 6 | 効率 | **平均待ち時間 / 入力tokens** | 品質と分離して倍率を報告し、多段処理の削減に使うこと |

現状は、検索R@5と引用は基準を超え、Strict Passも1問増えた。しかし回答要素再現率と効率は未達である。したがって、Relation Dossierは検索層の採用候補だが、Actualの多段回答経路はまだ既定にしない。

| 条件 | R@5 | R@10 | Relation Path@10 | Conflict両側@10 | Conflict Unit@10 |
|---|---:|---:|---:|---:|---:|
| Raw Tuned + Purpose | 58.3% | 75.0% | 100.0% | 0.0% | n/a |
| Actual Claim | 41.7% | 66.7% | 83.3% | 0.0% | 0.0% |
| Actual Claim + Relation Dossier v1 | 91.7% | 91.7% | 100.0% | 66.7% | 0.0% |
| Actual Claim + Relation Dossier v2 | 91.7% | 91.7% | 100.0% | 66.7% | 66.7% |
| Actual Claim + Evidence | 50.0% | 58.3% | 100.0% | 0.0% | n/a |

Relation Dossier v2はRawに対してR@5を33.4ポイント、R@10を16.7ポイント改善した。Dossierを短くしてもR@5とR@10は維持され、`conflicts_with`の明示によりConflict Unit@10は0%から66.7%へ改善した。ただし3つ目のFAQ関係を抽出できなかったため、Conflict両側とConflict Unitは100%に届いていない。

## 最終回答結果

回答モデルは`gemma4:latest`、top-kは5、seedは42である。6問を個別に実行し、各実行ディレクトリへ回答、Dossier、slot、fallback、judge、usageを保存した。Answer Contractには、時点付きの規則質問で「現行版と旧版の失効」を確認するslot、FAQ矛盾質問で「旧案内と未反映状態」「正式規程の現行要件」を確認するslotを決定的に補った。

| 指標 | 6問集計 |
|---|---:|
| 根拠再現率@5 | 83.3% |
| 引用再現率 | 75.0% |
| 回答要素再現率 | 61.1% |
| behavior accuracy | 100.0% |
| 禁止誤答率 | 0.0% |
| Strict Pass | 16.7%（1/6） |
| Evidence fallback発火 | 50.0%（3/6） |
| 入力tokens合計 | 66,337 |
| 出力tokens合計 | 9,062 |
| 平均待ち時間 | 44.5秒/問 |

### Raw Tunedとの直接比較

同じ6問、`gemma4:latest`、top-k 5、seed 42で、製品設計部の全用途72文書・360 chunkを検索するRaw Tunedと、用途が既知という前提でgovernanceの12文書・60 chunkへ絞ったRaw Tuned + Purposeも回答まで測定した。Actual側はRelation Dossier検索後にAnswer Contract、slot充足、必要時のEvidence fallback、回答検証を行うため、tokenと待ち時間は検索索引だけでなくパイプライン全体の差である。

| 指標 | Raw Tuned | Raw Tuned + Purpose | Actual Relation Dossier |
|---|---:|---:|---:|
| 根拠再現率@5 | 41.7% | 58.3% | 83.3% |
| 引用再現率 | 41.7% | 50.0% | 75.0% |
| 回答要素再現率 | 66.7% | 63.9% | 61.1% |
| behavior accuracy | 100.0% | 100.0% | 100.0% |
| 禁止誤答率 | 0.0% | 0.0% | 0.0% |
| Strict Pass | 0.0%（0/6） | 0.0%（0/6） | 16.7%（1/6） |
| 入力tokens合計 | 8,633 | 8,808 | 66,337 |
| 出力tokens合計 | 1,440 | 1,473 | 9,062 |
| 平均待ち時間 | 6.95秒/問 | 8.94秒/問 | 44.48秒/問 |

Actualは純粋なRaw Tunedに対して根拠を41.6ポイント、引用を33.3ポイント改善した。用途で絞った強いRaw基準に対しても両指標を25ポイント改善したが、回答要素再現率は両Raw条件を下回った。S2の2問では必要根拠を100%取得したにもかかわらず、slotとcitation IDの接続または自然文化で情報を落とした。一方、S1の版質問ではActualだけが新旧両側を引用してStrict Passとなり、S3の矛盾質問ではRaw + Purposeの回答要素0%をActualが100%へ回復した。したがって、Relation Dossierの検索上の価値は確認できるが、回答経路とコストは改善途上である。

質問別の数値、失敗段階、再現用ファイルは`target/benchmarks/enterprise-actual-retrieval/2026-08-02-manufacturing-product-design-governance-luna-relation-v3-detailed/REPORT_ja.md`にまとめた。

### Luna回答との比較

検索索引を変えず、回答変換を`gpt-5.6-luna`、reasoning effort `low`へ替え、採点は`gemma4:latest`に固定した。さらにRaw Tuned + PurposeもLunaで回答させ、Luna単体の効果とFragrachの効果を分けた。

| 指標 | Raw + Purpose / Gemma | Actual / Gemma | Raw + Purpose / Luna | Actual / Luna |
|---|---:|---:|---:|---:|
| 根拠再現率@5 | 58.3% | 83.3% | 58.3% | 83.3% |
| 引用再現率 | 50.0% | 75.0% | 58.3% | **91.7%** |
| 回答要素再現率 | 63.9% | 61.1% | 94.4% | **100.0%** |
| 自動Strict Pass | 0.0% | 16.7% | 16.7% | **50.0%** |
| 監査後Strict Pass | 0.0% | 16.7% | 16.7% | **66.7%** |
| 入力tokens | 8,808 | 66,337 | 62,029 | 197,455 |
| 平均回答待ち時間 | 8.94秒 | 44.48秒 | 10.78秒 | 40.09秒 |

Actual / Lunaは回答要素を100%まで回復し、Gemmaで3問発火したEvidence fallbackを0問にした。同じLuna同士でも、ActualはRaw + Purposeより自動Strict Passを16.7%から50.0%へ改善した。したがって、検索資料と回答モデルの組み合わせに効果がある。

自動採点ではS2-GOV-2を禁止誤答としたが、回答は旧FAQの単独承認を明確に否定し、現行の二者承認を結論としている。採点規則に従って訂正するとActual / LunaはStrict Pass 4/6、禁止誤答率0%となる。詳細な質問別比較と監査理由は`docs/evaluations/luna-answer-comparison-2026-08-02_ja.md`に記録した。

Q1は、現行要件、適用版、旧版失効、両側の原文引用をすべて満たし、Strict Passとなった。これはRelation Dossier、版系列slot、関係Unitの引用展開が組み合わさると、検索改善を最終回答へ移せることを示す。

残る5問の失敗は検索だけでは説明できない。Q3とQ4は根拠再現率100%でも回答要素がそれぞれ0%と33.3%だった。Q5は根拠、回答要素、behaviorが100%でも旧版側の引用がなく、引用再現率50%でStrictを落とした。Q2とQ6は根拠再現率が50%であり、取りこぼしたFAQ関係の影響も受けた。Evidence fallbackは3問で動いたが、Q3では取得した原文を有効なcitation IDへ変換できず、slotが`missing`のまま残った。

この結果から、検索層ではRelation Dossierを採用する根拠が得られたが、回答層を既定経路とするにはまだ不十分である。また、Gemmaによる多段処理は平均44.5秒を要し、対話用途には重い。全6問を一括実行すると10分を超え、評価器が全問終了時まで成果物を書かないため途中経過を失う問題も確認した。

## 次の改善

次は検索方式を増やすより、Relationの完全性とslot充足を改善する。

1. front matterから確定できるDocument Profileを決定的に生成し、LLMにはRelationだけを短い出力で求める。出力上限による後半Relationの取りこぼしを減らす。
2. 同じ文書対に`conflicts_with`と`order_of_precedence`が併存することを検証し、期待される関係種別の欠落をWarningまたは公開ゲートへ渡す。
3. fallback後にEvidence IDを再割り当てし、値を抽出できたのにcitation IDがないため`missing`へ戻る経路を修正する。
4. slot構造化と自然文化を統合するアブレーションを追加し、禁止誤答率0%を維持しながら呼び出し回数と待ち時間を減らす。
5. 規程6問でRelation完全性とStrict Passを改善してから、製品設計部の残り5用途、代表業種、全40部門の順でActual評価を拡張する。

## 実験記録

Knowledge Build v2は`target/benchmarks/enterprise-domain-actual/2026-08-02-manufacturing-product-design-governance-luna-v1/knowledge-build-relation-v2/`、全キャッシュ命中の再実行は同階層の`knowledge-build-relation-v2-cache/`に保存した。

検索評価の詳細版は`target/benchmarks/enterprise-actual-retrieval/2026-08-02-manufacturing-product-design-governance-luna-relation-v3-detailed/`にあり、Raw Tuned、Raw Tuned + Purpose、Actual各条件の`metrics.json`、`retrieval.jsonl`、`REPORT_ja.md`、`manifest.json`、`command.txt`を保持する。

最終回答評価は`target/benchmarks/enterprise-answer-evaluation/2026-08-02-manufacturing-product-design-governance-luna-relation-dossier-v4-q1/`から`v4-q6/`までに分割保存した。各ディレクトリの`upper-bound-report.json`と`actual-compiled.jsonl`に質問別の取得根拠、Dossier、Answer Contract、fallback、回答、judge、usageがある。

Raw Tuned + Purposeの最終回答評価は`target/benchmarks/enterprise-answer-evaluation/2026-08-02-manufacturing-product-design-governance-raw-tuned-purpose-answer-v1/`に保存した。`upper-bound-report.json`が集計、`raw-rag.jsonl`が質問別の回答とjudgeである。

純粋なRaw Tunedの最終回答評価は`target/benchmarks/enterprise-answer-evaluation/2026-08-02-manufacturing-product-design-raw-tuned-answer-v1/`に保存した。

Luna回答評価は`target/benchmarks/enterprise-answer-evaluation/2026-08-02-manufacturing-product-design-governance-luna-answer-v1/`、Raw Tuned + Purpose / Lunaは`target/benchmarks/enterprise-answer-evaluation/2026-08-02-manufacturing-product-design-governance-raw-tuned-purpose-luna-answer-v1/`に保存した。各ディレクトリの`manual-adjudication.json`に自動採点からの監査差分を保持する。

その後のgovernance 3反復、technical_spec、金融コンプライアンスを含む18問の拡張評価は`docs/evaluations/expanded-luna-evaluation-2026-08-02_ja.md`に記録した。Relation DossierはRaw + Purposeより検索R@5とStrict Passを改善したが、Dossier Planの非決定性とRelationの欠落・誤接続が次の主要課題になった。
