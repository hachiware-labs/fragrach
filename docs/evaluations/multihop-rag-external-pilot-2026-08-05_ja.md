# MultiHop-RAG外部分布評価

## 結論

MultiHop-RAGでは、質問を独立した検索obligationへ分解し、各obligationから異なる記事を一件ずつ選び、選択理由になった原文chunkと記事を不可分なEvidence Packetへまとめる方法が有効だった。untouched holdout 60問で、Raw Hybridに対してEvidence Ceilingは25.0%から30.0%、DVAA-GrossはFragrachで26.7%となった。完全根拠が揃った18問のうち16問をLunaが正答し、DVAA-Netは88.9%だった。

ただし、これはmulti-hop検索を解決した水準ではない。完全根拠が揃ったのは60問中18問にすぎず、主要な残差はreaderではなくEvidence Packetを構成する前の候補発見にある。特にinference質問はholdoutのEvidence Ceilingが10.0%に留まった。Fragrachの効果は、比較と時間質問で複数記事を一つの回答資料へ揃える範囲に限定して確認された。

## 評価契約

公開データ609記事、2,556問から、質問種別ごとにdevelopment 20問、diagnostic 20問、untouched holdout 20問を固定した。各splitはinference、comparison、temporal、nullを各20問含む。Gold answer、Gold URL、Gold factは検索、obligation生成、Packet順位づけへ渡していない。

EmbeddingはRuri `hf.co/Targoyle/ruri-v3-310m-GGUF:Q8_0`、readerはLuna `gpt-5.6-luna`へ固定した。Rawは512-token chunk、top-5、T1で再調整したSparse weight 0.90のHybridである。Fragrachも同じRaw候補からPacketを作り、新しい外部文書を追加していない。

一つのGold記事IDが候補へ入っただけではEvidence Unitを満たさない。その記事のGold factに対応する原文が回答資料に存在する場合だけUnitを取得済みとし、全Unitが揃った質問だけをEvidence Ceilingへ数える。DVAA-Grossは正答かつ完全根拠の質問数を全回答可能質問で割り、DVAA-Netは同じ合格数を完全根拠が揃った質問数で割る。

## 改善前の問題と採用した変更

Raw Hybridは関連する一記事を繰り返し上位へ出しやすく、二つから四つの独立記事を必要とする質問で候補枠を使い切っていた。そこでLunaは質問文だけから検索obligationを生成し、Packet compilerがobligationごとに異なるsourceとpublisherを優先した。生成した仮説文は回答根拠へ入れず、実際に検索された記事本文だけを回答資料へ残した。

途中でentity bridgeも試した。固有表現を介して追加記事を探索するとEvidence Unit Recallは増えたが、誤ったbridgeが候補枠を消費し、完全根拠率は下がった。開発集合で悪化したため採用していない。最終方式は、選んだ記事と、その記事を選ぶ根拠になったBM25 chunkを分離せず保持する単純な構造である。

## Developmentとdiagnostic

回答可能120問の結果を示す。

| 条件 | Evidence Unit Recall | Evidence Ceiling | Answer Accuracy | DVAA-Gross | DVAA-Net |
|---|---:|---:|---:|---:|---:|
| Raw Hybrid | 45.6% | 18.3% | ― | ― | ― |
| Fragrach Evidence Packet | 51.8% | 27.5% | 73.3% | 20.8% | 75.8% |
| Gold Context | 100.0% | 100.0% | 81.7% | 81.7% | 81.7% |

FragrachはEvidence Ceilingを9.2ポイント改善した。diagnostic単独ではEvidence Ceiling 33.3%、Answer Accuracy 76.7%、DVAA-Gross 26.7%、Net 80.0%だった。

inferenceではAnswer Accuracyが97.5%なのにEvidence CeilingとDVAA-Grossは10.0%だった。Lunaが一般知識や不完全な記事から正解らしい短答を生成できても、完全根拠付き回答にはならない。この乖離はRecall@kやAnswer Accuracyだけでは見えず、DVAAを置く理由を具体的に示した。

## Untouched holdout

方式、chunk、top-k、Sparse weight、source上限を凍結してからholdoutを初めて採点した。

通常のDocument Recall@5はRaw Hybridで57.6%、必要文書がすべて揃ったDocument Complete@5は30.0%だった。しかし、同じRawの原文spanまで要求するEvidence Ceilingは25.0%である。文書IDが入っただけでは必要factが回答資料に残るとは限らず、Document RecallだけではDVAAの上限を説明できない。

| 条件 | Evidence Unit Recall | Evidence Ceiling | Answer Accuracy | DVAA-Gross | DVAA-Net |
|---|---:|---:|---:|---:|---:|
| Raw Hybrid | 52.2% | 25.0% | ― | ― | ― |
| Fragrach Evidence Packet | 52.8% | 30.0% | 73.3% | 26.7% | 88.9% |
| Gold Context | 100.0% | 100.0% | 78.3% | 78.3% | 78.3% |

Fragrachの改善はRecallの0.6ポイントではなく、完全根拠を揃えた質問が15問から18問へ増えた点にある。comparisonはEvidence Ceiling 40.0%から45.0%、temporalは25.0%から35.0%へ改善し、inferenceは10.0%のままだった。null 20問はすべて情報不足として拒否でき、全80問のAnswer Accuracyは80.0%だった。

DVAA-Net 88.9%がGold Context 78.3%より高いことは、FragrachがGoldより優れたreaderであることを意味しない。Netは「Fragrachが完全根拠を揃えられた18問」という条件付き部分集合であり、その部分集合が相対的に易しいためである。Gold Contextは60問全部を分母にする校正値であるため、Netは必ずGross、Evidence Ceiling、件数と併記する。

## 得られた一般則

通常RAGがreaderへ暗黙に任せている「質問を複数の必要根拠へ分ける」「別sourceを揃える」「選択理由となった原文を最後まで保持する」を、検索と回答の間の構造へ移すと、multi-hopの完全根拠率は改善する。一方、質問分解だけでは候補にない記事を発見できず、entity graphを無条件に広げるとnoiseが増える。

したがってFragrachの汎用要件として残すのは、obligation、source diversity、不可分な原文Packet、Gold非依存の生成契約である。entity bridgeや「Graphを使えばmulti-hopが解ける」という規則は残さない。次の改善対象はinference向けの限定bridgeと、obligationごとの不足を検出して再検索する停止条件である。

## 再現物と制限

主要成果物は`target/benchmarks/multihop-rag/query-packets-frozen-v1/`、`answers-development-diagnostic-v2/`、`query-packets-holdout-v1/`、`answers-holdout-v1/`に保存した。Luna回答は一回測定であり、Codex App Server経路にはseedを指定できない。Gold Contextの短答正答率も100%ではないため、DVAA-Grossの絶対上限はreaderと採点契約に依存する。
