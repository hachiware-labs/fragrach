# 長文企業コーパス先行評価

実施日: 2026-08-02

## 目的

短い文書を中心とした従来のP1評価では、文書全体を一つの検索単位として扱う方式が有利になりやすかった。本評価では、規程、技術仕様、議事録、手順書、障害報告、契約文書を長文化し、文書の中盤・後半にある根拠も含めて検索方式を比較する。

本書は、最初に製造業・製品設計部門で評価系を検証し、その後4領域288文書・144問へ広げた評価記録である。製造業6問で設計したFragrach条件は開発値として分離し、別領域の保留評価で再現性を確認する。

その後、同じ構成の医療・品質規制部門36問も追加し、業種差の先行確認を行った。

## 評価対象

| 項目 | 内容 |
|---|---|
| 対象領域 | `manufacturing-product-design` |
| 文書数 | 72文書 |
| 長文 | 18文書 |
| 短文 | 54文書 |
| 質問数 | 36問 |
| 利用目的 | governance、technical_spec、planning、operations、incident_change、commercial_compliance |
| 検索範囲 | 質問と同じ利用目的の文書だけを対象とする独立索引 |
| Gold | 必須根拠、文書関係、矛盾の両側、禁止対象、質問タグ |

長文はGemma 4で生成したが、根拠となるGold文は決定的なテンプレートから挿入している。生成文に未許可の数値や識別子が混入した場合は、該当する文だけを除去する。長文生成に使うモデルの知識を正解判定には用いない。

領域単独の検証はエラー0件で成功した。文書長は最小928文字、平均2,797文字、p50 1,057文字、p90 8,503文字、最大10,051文字だった。各利用目的には12文書があり、そのうち3文書が長文である。

## 共通チャンク

`o200k_base`でトークン数を測り、見出し・段落境界を優先して分割した。Goldを含む段落は途中で切らない。

| 設定 | overlap | チャンク数 | 平均tokens | p50 | p90 | 最大 |
|---:|---:|---:|---:|---:|---:|---:|
| 512 | 64 | 503 | 273.67 | 289 | 477 | 505 |
| 1024 | 128 | 426 | 293.19 | 235 | 537 | 727 |

1024設定でも最大値が727なのは、上限まで機械的に連結せず、意味境界を優先しているためである。

## 比較条件

| 条件 | 検索内容 | 位置づけ |
|---|---|---|
| `raw-bm25` | 日本語文字2-gram、BM25 `k1=1.8`、`b=0.75` | 語彙一致を調整したRaw基準 |
| `ruri-dense` | Ruri v3 310M Q8、cosine類似度 | 日本語Dense基準 |
| `ruri-hybrid-sparse-0.85` | BM25とRuriをweighted RRF、Sparse重み0.85 | Raw Hybrid候補 |
| `ruri-hybrid-sparse-0.90` | BM25とRuriをweighted RRF、Sparse重み0.90 | Raw Hybrid候補 |

## チャンク上限の比較

| 上限 | 条件 | R@5 | R@10 | R@20 | Relation Path@10 | Conflict両側@10 |
|---:|---|---:|---:|---:|---:|---:|
| 512 | raw-bm25 | 57.4% | 69.0% | 93.5% | 63.9% | 0.0% |
| 512 | ruri-dense | 61.1% | 77.3% | 90.7% | 97.2% | 33.3% |
| 512 | ruri-hybrid-sparse-0.85 | 57.4% | 70.4% | 94.4% | 75.0% | 0.0% |
| 512 | ruri-hybrid-sparse-0.90 | 57.4% | 71.3% | 93.5% | 66.7% | 0.0% |
| 1024 | raw-bm25 | 57.4% | 69.0% | 92.1% | 63.9% | 0.0% |
| 1024 | ruri-dense | 62.0% | 77.3% | 92.6% | 97.2% | 33.3% |
| 1024 | ruri-hybrid-sparse-0.85 | 57.4% | 71.8% | 92.1% | 77.8% | 33.3% |
| 1024 | ruri-hybrid-sparse-0.90 | 57.4% | 72.7% | 92.1% | 72.2% | 33.3% |

1024設定はDenseのR@5が512設定より0.9ポイント高く、R@10は同率だった。差は小さいため、4領域の本測定で再判定する。外部方式の先行スモークには1024設定を使用する。

## 固定コンテキスト予算

1024設定の結果を、回答モデルへ渡す検索コンテキストの上限で切り詰めた。

| 予算 | 条件 | 根拠再現 | Relation Path | Conflict両側 | 平均実使用tokens | 根拠/1k tokens |
|---:|---|---:|---:|---:|---:|---:|
| 1500 | raw-bm25 | 70.4% | 72.2% | 0.0% | 1394 | 1.08 |
| 1500 | ruri-dense | 78.2% | 97.2% | 33.3% | 1321 | 1.26 |
| 1500 | ruri-hybrid-sparse-0.85 | 70.4% | 72.2% | 0.0% | 1373 | 1.09 |
| 2500 | raw-bm25 | 86.1% | 91.7% | 33.3% | 2328 | 0.80 |
| 2500 | ruri-dense | 86.6% | 97.2% | 33.3% | 2302 | 0.81 |
| 2500 | ruri-hybrid-sparse-0.85 | 87.0% | 100.0% | 33.3% | 2289 | 0.83 |
| 4000 | raw-bm25 | 92.1% | 94.4% | 33.3% | 3451 | 0.58 |
| 4000 | ruri-dense | 90.3% | 100.0% | 100.0% | 3567 | 0.55 |
| 4000 | ruri-hybrid-sparse-0.85 | 92.1% | 100.0% | 33.3% | 3436 | 0.58 |

1500トークンではRuri Denseが再現率と根拠密度の両方で最良だった。2500トークンではHybrid 0.85が根拠再現87.0%、Relation Path 100.0%で僅差の首位になる。4000トークンまで広げると主要方式の根拠再現は90%を超えるが、根拠密度は下がる。

## 文書位置別の診断

1024設定、上位10件で必要根拠の位置別再現率を測った。

| 条件 | 文書前半 | 文書中盤 | 文書後半 |
|---|---:|---:|---:|
| raw-bm25 | 60.0% | 78.3% | 64.0% |
| ruri-dense | 100.0% | 87.0% | 68.0% |
| ruri-hybrid-sparse-0.85 | 80.0% | 82.6% | 64.0% |
| ruri-hybrid-sparse-0.90 | 80.0% | 82.6% | 66.0% |

全条件で後半の根拠が弱い。Ruri Denseは前半と関係探索に強いが、後半は68.0%に留まる。この差は、文書構造と関係情報を事前コンパイルするFragrachが改善すべき対象になる。

## 現時点の判断

- 長文化しても、Ruri DenseはBM25よりR@5と関係探索に強い。
- Sparseを0.85以上に寄せた従来のHybridはR@20では強いが、上位5件ではDenseを超えていない。
- 通常RAGは矛盾の片側を取得しても、両側を@10へ揃える能力が低い。
- 1024設定を暫定代表値とするが、512との差は最終判断に足りない。
- 文書後半の根拠、矛盾の両側、少ない入力トークンでのRelation Pathを主要な差別化指標とする。

## LightRAGと比較するgovernance基準

LightRAGの先行実行はgovernance 6問だけを対象とするため、Rawも同じ6問へ限定して共通Gold採点器で再集計した。

| 条件 | R@5 | R@10 | R@20 | Relation Path@10 | Conflict両側@10 |
|---|---:|---:|---:|---:|---:|
| raw-bm25 | 66.7% | 75.0% | 83.3% | 83.3% | 0.0% |
| ruri-dense | 66.7% | 83.3% | 100.0% | 100.0% | 33.3% |
| ruri-hybrid-sparse-0.85 | 66.7% | 83.3% | 83.3% | 100.0% | 33.3% |
| ruri-hybrid-sparse-0.90 | 66.7% | 83.3% | 83.3% | 100.0% | 33.3% |

この6問ではRuri Denseを検索精度のRaw代表とする。1500トークン予算での平均実使用は1,264トークン、根拠密度は1.32件/1,000トークンである。

## LightRAGの完了結果

LightRAG 1.5.5は、日本語summaryを明示した条件で66共通チャンクの投入と6問の検索を完了した。NaiveとHybridの検索精度は同値だった。

| 条件 | R@5 | R@10 | R@20 | Relation Path@10 | Conflict両側@10 |
|---|---:|---:|---:|---:|---:|
| Raw Ruri Dense | 66.7% | 83.3% | 100.0% | 100.0% | 33.3% |
| LightRAG Naive | 66.7% | 83.3% | 100.0% | 100.0% | 33.3% |
| LightRAG Hybrid | 66.7% | 83.3% | 100.0% | 100.0% | 33.3% |

この先行6問ではLightRAGのグラフ化による検索精度の上積みはなかった。平均検索時間はNaive 117ms、Hybrid 9,923msだった。1500トークン上限でHybridの平均実使用は1,277トークン、根拠密度は1.30件/1,000トークンで、Raw Ruri Denseの1,264トークン、1.32件/1,000トークンとほぼ同じである。

構築には49分40秒、Luna 145回、入力1,612,372 tokens、出力100,357 tokens、合計1,712,729 tokensを要した。これは検索品質だけでなく、知識構築コストを比較するための基準値として残す。

## Fragrachの長文先行結果

同じgovernance 12文書をLunaでコンパイルした。Knowledge Buildには281 Evidence、111 Claim、12 Document Profile、8 Document Relation、8 Relation Dossier、2 Conflictが含まれる。Compile coverageは100%であり、Gold根拠がBuildから消失した例はなかった。

Cold buildは10分10秒だった。Claim抽出はLuna 27回、入力328,594 tokens、出力17,912 tokens、Document Profile抽出は1回、入力29,670 tokens、出力3,614 tokensである。合計は28回、入力358,264 tokens、出力21,526 tokens、379,790 tokensとなる。LightRAGに対して時間は約4.9分の1、トークンは約4.5分の1、LLM呼び出しは約5.2分の1である。Dossierの抜粋上限だけを変えた再コンパイルは全抽出キャッシュが命中し、LLM呼び出し0回、336msで完了した。

単純なCompiled Unit検索は長文で弱かった。Ruri DenseではClaimがR@5 16.7%、R@10 50.0%、巨大なRelation Dossierが58.3%、66.7%である。情報欠落ではなく、長いDossierと多数の一般説明Claimが検索順位を圧迫した。

そこで、検索用の短い関係ヘッダー、Claim付きEvidence検索、回答用の短い原文Evidenceを分離した。関係ヘッダーが取得された場合だけ両端文書のEvidenceを補強し、矛盾質問では「現行規則」と「更新状況」をAnswer Contractの必須スロットとして優先する。この実験条件を`fragrach-layered-dossier-ruri-dense`とする。

| 条件 | R@5 | R@10 | R@20 | Relation Path@10 | Conflict両側@10 | 平均tokens@5 | 平均tokens@10 |
|---|---:|---:|---:|---:|---:|---:|---:|
| Raw Ruri Dense | 66.7% | 83.3% | 100.0% | 100.0% | 33.3% | 826 | 2,016 |
| Fragrach巨大Dossier | 58.3% | 66.7% | 66.7% | 100.0% | 33.3% | 3,183 | 4,715 |
| Fragrach Layered Dossier | 75.0% | 83.3% | 83.3% | 100.0% | 33.3% | 495 | 1,035 |

Layered DossierはR@5でRawを8.3ポイント上回り、R@10は同率だった。上位10件の平均入力はRawの約51%である。一方、R@20はRawより16.7ポイント低く、1500トークン固定予算では両者とも根拠再現83.3%、Conflict両側33.3%で、Rawの方が平均実使用は157トークン少ない。したがって現時点の強みは「少ない上位件数で必要根拠を集めること」であり、固定予算全体でRawを超えたとはまだいえない。

この条件は6問を見ながら設計した開発条件である。別領域へ設定を固定して適用し、再現できた場合に限って一般的な改善として扱う。

## 医療・品質規制の保留評価

製造業で決めたLayered Dossierの重みと必須スロットを変更せず、医療・品質規制のgovernance 12文書・6問へ適用した。医療文書と質問はLayered Dossierの調整には使っていない。

Cold buildは10分7秒、Claim抽出27回、Document Profile抽出1回だった。入力は合計361,306 tokens、出力22,449 tokens、合計383,755 tokensである。117 Claim、277 Evidence、11 Profile、6 Relationを得たが、Lunaが一つのSource Profileを別Source IDで重複出力し、欠けたProfileを端点とする2 Relationが検証で棄却された。

この不完全BuildでもLayered DossierはR@5 75.0%、R@10 83.3%となり、Rawの58.3%、75.0%を上回った。次に、欠けたProfileを原文front matterから保守的に復元する決定的fallbackを追加した。LLM出力を推測で修正せず、document type、status、有効期間、原文Evidenceだけを使う。キャッシュ再コンパイルはLLM呼び出し0回、268msで、12 Profile、8 Relationへ回復した。

| 条件 | R@5 | R@10 | R@20 | Relation Path@10 | Conflict両側@10 | 平均tokens@5 | 平均tokens@10 |
|---|---:|---:|---:|---:|---:|---:|---:|
| Raw Ruri Dense | 58.3% | 75.0% | 100.0% | 100.0% | 33.3% | 995 | 2,171 |
| Fragrach Layered、Profile欠落 | 75.0% | 83.3% | 83.3% | 100.0% | 33.3% | 506 | 1,144 |
| Fragrach Layered、Profile fallback | 83.3% | 83.3% | 83.3% | 100.0% | 33.3% | 487 | 1,141 |

fallback後はR@5でRawを25.0ポイント、R@10で8.3ポイント上回った。上位10件の平均入力はRawの約53%である。1500-token固定予算でも、Raw Denseは根拠再現75.0%、平均1,440 tokens、Layered Dossierは83.3%、1,435 tokensで、Conflict両側はいずれも33.3%だった。製造業では固定予算が同率だったが、医療保留領域では同等の入力量で改善が再現した。

一方、R@20はRawが100.0%、Fragrachが83.3%である。Layered Dossierは少数上位件数と短いコンテキストに強いが、広く20件取得する網羅性ではRawに届かない。また、保留領域は業種・部門を分けたものの、質問構造は同じgovernance系列である。一般化の主張には、technical_specやincident_changeなど別の利用目的で同じ結果が出ることが必要になる。

## R/C/Pによる再採点

保存済みの検索順位を2026年8月3日に再採点し、根拠再現率R、必要根拠をすべて取得できた質問率C、未取得Goldを新たに追加した検索Unitの割合Pを比較した。Pは同じGoldを繰り返すUnitを分子へ重ねて数えない。

| 部門 | 条件 | R/C/P@5 | R/C/P@10 | R/C/P@20 |
|---|---|---:|---:|---:|
| 製造・製品設計 | Raw Ruri Dense | 66.7 / 33.3 / 26.7% | 83.3 / 66.7 / 16.7% | 100.0 / 100.0 / 10.0% |
| 製造・製品設計 | Fragrach Layered | **75.0 / 50.0 / 30.0%** | 83.3 / 66.7 / **18.3%** | 83.3 / 66.7 / 9.2% |
| 医療・品質規制 | Raw Ruri Dense | 58.3 / 16.7 / 23.3% | 75.0 / 50.0 / 15.0% | 100.0 / 100.0 / 10.0% |
| 医療・品質規制 | Fragrach Layered | **83.3 / 66.7 / 33.3%** | **83.3 / 66.7 / 16.7%** | 83.3 / 66.7 / 10.0% |

Fragrachは両部門の@5でR、C、Pをすべて改善した。製造では完全取得できた質問が33.3%から50.0%、医療では16.7%から66.7%へ増えている。少数候補で回答根拠一式を揃えるという設計目的は、RだけでなくCとPでも支持された。

@20ではRawが両部門ともR=100%、C=100%へ到達し、FragrachはR=83.3%、C=66.7%で止まる。Fragrachは上位へ根拠を集中させる一方、11件目以降で未取得根拠を追加できていない。PはGold数が少ない質問ほどkの増加に伴って構造的に下がるため、異なるkの絶対値ではなく同じkの方式間で比較する。

## 医療・品質規制部門の追加結果

医療・品質規制部門も検証エラー0件だった。72文書の平均は2,847文字、p90は8,302文字、最大9,927文字である。1024設定では426チャンク、平均295.81トークン、最大676トークンになった。

| 条件 | R@5 | R@10 | R@20 | Relation Path@10 | Conflict両側@10 |
|---|---:|---:|---:|---:|---:|
| raw-bm25 | 58.3% | 67.6% | 85.6% | 66.7% | 0.0% |
| ruri-dense | 55.6% | 72.2% | 83.8% | 80.6% | 33.3% |
| ruri-hybrid-sparse-0.85 | 58.3% | 67.6% | 88.4% | 66.7% | 0.0% |
| ruri-hybrid-sparse-0.90 | 58.3% | 67.6% | 88.4% | 66.7% | 0.0% |

製品設計部門とは異なり、R@5はBM25とHybridがDenseを2.7ポイント上回った。一方、R@10とRelation Path@10はDenseが最良である。したがって「Ruri Denseを全領域の固定勝者とする」という判断はできない。検索方式は目的別に選ぶか、開発群で重みを選んで保留群へ固定する必要がある。

Gold位置別@10はBM25が前半75.0%、中盤75.0%、後半63.0%、Denseが75.0%、90.0%、63.0%だった。製造業と同様に後半根拠が最弱であり、長文後半の難しさは業種を跨いで再現した。

## 4領域288文書・144問のRaw本測定

製造業・製品設計、医療・品質規制、金融・コンプライアンス、ソフトウェア・SREの4部門を生成し、検証エラー0件を確認した。各部門は72文書・36問、全体では288文書・144問、長文72文書である。文書長は最小926文字、平均2,810文字、p50 1,086文字、p90 8,503文字、最大11,521文字だった。長文72件のうち14件は先行生成を再利用し、残り58件をGemma 4で1時間59分かけて生成した。生成失敗は0件である。

| 設定 | チャンク数 | 平均tokens | p50 | p90 | 最大 |
|---:|---:|---:|---:|---:|---:|
| 512 / overlap 64 | 2,011 | 274.72 | 274 | 474 | 512 |
| 1024 / overlap 128 | 1,704 | 295.94 | 266 | 550 | 868 |

| 上限 | 条件 | R@5 | R@10 | R@20 | Relation Path@10 | Conflict両側@10 |
|---:|---|---:|---:|---:|---:|---:|
| 512 | raw-bm25 | 58.6% | 67.1% | 88.9% | 67.4% | 0.0% |
| 512 | ruri-dense | 57.5% | 75.7% | 84.6% | 86.8% | 33.3% |
| 512 | ruri-hybrid-sparse-0.85 | 60.2% | 67.8% | 90.7% | 70.1% | 8.3% |
| 512 | ruri-hybrid-sparse-0.90 | 59.3% | 68.5% | 90.3% | 68.1% | 8.3% |
| 1024 | raw-bm25 | 58.0% | 66.7% | 89.2% | 67.4% | 0.0% |
| 1024 | ruri-dense | 58.1% | 75.7% | 86.7% | 86.8% | 33.3% |
| 1024 | ruri-hybrid-sparse-0.85 | 59.5% | 68.4% | 90.9% | 70.8% | 16.7% |
| 1024 | ruri-hybrid-sparse-0.90 | 58.7% | 68.9% | 90.9% | 69.4% | 16.7% |

R@5は512 Hybrid 0.85、R@10とRelation Pathは両設定のRuri Dense、R@20は1024 Hybridが最良であり、一つの方式が全指標を支配していない。1024は512より307チャンク少なく、1500-token予算のDense根拠再現も72.7%対72.3%で僅かに高いため、以後の長文比較では1024を代表設定とする。

1024設定の部門別内訳は次のとおりである。

| 部門RAG | 条件 | R@5 | R@10 | R@20 | Relation Path@10 | Conflict両側@10 |
|---|---|---:|---:|---:|---:|---:|
| 製造・製品設計 | BM25 | 57.4% | 69.0% | 92.1% | 63.9% | 0.0% |
| 製造・製品設計 | Ruri Dense | 62.0% | 77.3% | 92.6% | 97.2% | 33.3% |
| 製造・製品設計 | Hybrid 0.85 | 57.4% | 71.8% | 92.1% | 77.8% | 33.3% |
| 製造・製品設計 | Hybrid 0.90 | 57.4% | 72.7% | 92.1% | 72.2% | 33.3% |
| 医療・品質規制 | BM25 | 58.3% | 67.6% | 85.6% | 66.7% | 0.0% |
| 医療・品質規制 | Ruri Dense | 55.6% | 72.2% | 83.8% | 80.6% | 33.3% |
| 医療・品質規制 | Hybrid 0.85 | 58.3% | 67.6% | 88.4% | 66.7% | 0.0% |
| 医療・品質規制 | Hybrid 0.90 | 58.3% | 67.6% | 88.4% | 66.7% | 0.0% |
| 金融・コンプライアンス | BM25 | 58.3% | 63.0% | 88.0% | 66.7% | 0.0% |
| 金融・コンプライアンス | Ruri Dense | 55.6% | 75.9% | 85.2% | 91.7% | 33.3% |
| 金融・コンプライアンス | Hybrid 0.85 | 60.2% | 63.9% | 90.7% | 66.7% | 0.0% |
| 金融・コンプライアンス | Hybrid 0.90 | 59.3% | 64.8% | 90.7% | 66.7% | 0.0% |
| ソフトウェア・SRE | BM25 | 57.9% | 67.1% | 91.2% | 72.2% | 0.0% |
| ソフトウェア・SRE | Ruri Dense | 59.3% | 77.3% | 85.2% | 77.8% | 33.3% |
| ソフトウェア・SRE | Hybrid 0.85 | 62.0% | 70.4% | 92.1% | 72.2% | 33.3% |
| ソフトウェア・SRE | Hybrid 0.90 | 59.7% | 70.4% | 92.1% | 72.2% | 33.3% |

部門差は明確である。R@5は製造ではDense、医療ではBM25/Hybrid、金融とSREではHybrid 0.85が最良だった。一方、R@10は4部門すべてでDenseが最良である。したがってRaw基準は一つの検索器だけでなく、R@5重視とR@10・関係探索重視の二つを残す。

1024の1500-token条件ではRuri Denseが根拠再現72.7%、Relation Path 84.0%、Conflict両側33.3%で最良だった。4000 tokensではHybrid 0.85が根拠再現88.8%、DenseがRelation Path 100.0%とConflict両側83.3%である。回答コンテキストを増やすと根拠再現は上がるが、Denseの根拠密度は1.14件/1,000 tokensから0.51件へ下がった。

位置別@10はBM25が前半80.0%、中盤74.2%、後半59.3%、Denseが93.3%、84.9%、67.6%だった。先行2部門で見えた後半の弱さは、全4部門でも再現した。

## 今回の到達点

長文を含む288文書・144問について、Raw RAGの調整済み基準を確立した。Rawでは、R@5は部門によってBM25、Dense、Hybridの勝者が変わり、R@10とRelation PathはRuri Denseが一貫して強い。したがって、未調整の単純BM25ではなく、目的別に調整したRawを今後の基準とする。

Fragrach Layered Dossierは、製造・製品設計のgovernance 6問でRaw DenseよりR@5を8.3ポイント改善し、上位10件の入力を約49%削減した。設定を固定した医療・品質規制の保留6問でも、R@5を25.0ポイント、R@10を8.3ポイント改善した。1500-token固定条件では、ほぼ同じ入力量で75.0%から83.3%へ改善した。少数上位件数または限られた入力予算で、関係文書から回答根拠を集める仮説は二つの部門で支持された。

一方、R@20ではRawがFragrachを上回り、Conflict両側@10は33.3%から改善していない。また、二つの検証はいずれもgovernance型の質問である。現時点で言えるのは「長文・更新・権威関係を含む部門RAGのgovernance探索で、Rawより早い順位に必要根拠を集約できる」であり、全用途のRAG精度や最終回答精度で優位とはまだ言えない。

Document Profile欠落への決定的fallbackも追加した。LLMがProfileを欠落・重複しても、front matterと原文Evidenceだけから保守的なProfileを作り、Relationを失わずにコンパイルできる。推測による補完はせず、診断メッセージを残すため、再現性と監査可能性を維持する。

## 次の検証

1. `technical_spec`または`incident_change`を開発未使用の保留タスクにし、Layered Dossierの重みを固定したまま外部妥当性を確認する。
2. R@20とConflict両側の低下原因を質問単位で分解し、関係展開のrecall層と回答コンテキストのprecision層を別々に調整する。
3. 代表チャンク設定でGraphitiなど残るP1外部OSSと、精度・構築時間・LLM token・検索時間を同じ表で比較する。
4. 検索で良好だったRaw DenseとFragrach Layered DossierだけをLuna回答評価へ進め、回答要素、引用、禁止誤答、Strict Passを測る。

LightRAGの最初の試行は21/66チャンクで停止した。既定のsummary languageがEnglishであり、日本語文書から英語のentity・relationを生成していたためである。日本語質問との埋め込み比較を不必要に悪化させる条件なので、部分成果とログは失敗記録として残し、`addon_params.language=Japanese`を明示した試行を主要条件とする。

## 再現用成果物

- 評価計画: `docs/evaluations/longform-rag-comparison-plan-2026-08-02_ja.md`
- コーパス生成: `scripts/generate-enterprise-longform-corpus.mjs`
- 検証: `scripts/validate-enterprise-longform-corpus.mjs`
- 共通チャンク生成: `tests/benchmarks/rag-comparison/prepare-longform-chunks.py`
- Raw比較: `tests/benchmarks/rag-comparison/run-longform-raw-comparison.mjs`
- Fragrach Dense／Layered Dossier比較: `tests/benchmarks/rag-comparison/run-longform-actual-dense.mjs`
- 外部検索の固定token診断: `tests/benchmarks/rag-comparison/analyze-longform-external.mjs`
- 検索Unitのtoken注釈: `tests/benchmarks/rag-comparison/annotate-retrieval-tokens.py`
- LightRAG adapter: `tests/benchmarks/rag-comparison/run-lightrag-p1.py`
- 機械可読な先行結果: `target/benchmarks/longform-pilot/raw-1024-purpose-v2/metrics.json`
- 4領域512結果: `target/benchmarks/longform/raw-512-purpose/metrics.json`
- 4領域1024結果（部門別を含む）: `target/benchmarks/longform/raw-1024-purpose-domain-v3/metrics.json`
- 製造governance Fragrach Layered結果: `target/benchmarks/longform-pilot/fragrach-actual-dense-layered-v4/metrics.json`
- 製造governance Fragrach固定token診断: `target/benchmarks/longform-pilot/fragrach-actual-dense-layered-v4-context/metrics.json`
- 医療governance Raw結果: `target/benchmarks/longform-pilot/raw-healthcare-governance-context-v1/metrics.json`
- 医療governance Fragrach保留結果: `target/benchmarks/longform-pilot/fragrach-actual-dense-healthcare-holdout-fallback-v2/metrics.json`
- 医療governance Fragrach固定token診断: `target/benchmarks/longform-pilot/fragrach-actual-dense-healthcare-holdout-fallback-v2-context/metrics.json`
- 製造governance Raw R/C/P再採点: `target/benchmarks/longform-pilot/raw-product-governance-rcp-v1/metrics.json`
- 製造governance Fragrach R/C/P再採点: `target/benchmarks/longform-pilot/fragrach-actual-dense-layered-v4-rcp-v1/metrics.json`
- 医療governance Raw R/C/P再採点: `target/benchmarks/longform-pilot/raw-healthcare-governance-rcp-v1/metrics.json`
- 医療governance Fragrach R/C/P再採点: `target/benchmarks/longform-pilot/fragrach-actual-dense-healthcare-holdout-fallback-v2-rcp-v1/metrics.json`

埋め込みキャッシュは出力ディレクトリから分離し、チャンクIDと本文、モデルIDを含む内容ハッシュで管理する。出力先を変えた再測定でも同じ入力なら再利用し、コーパスやチャンクが変われば自動的に無効化する。
