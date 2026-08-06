# Decision Packet縮約評価（2026-08-06）

## 結論

Decision Packetを13個の平坦な属性から、`id`、`intent_id`、型付き`purpose`、`materials`の4属性へ縮約しても、今回の固定評価では検索精度と回答精度は低下しなかった。Packetの保存量は1,782,080 bytesから320,940 bytesへ減り、82.0%削減できた。

この結果は別部門への展開を開始できる水準である。ただし、今回の対象はDynamic Validityの実務表現variationであり、部門横断の結果ではない。次は部門を一つずつ追加し、同じgateを通す。

## 変更した契約

旧`RelationDossier`は、Relationから導出できる`position`、`kind`、`source_id`、`target_id`、4種類のsource ID配列と、Evidenceから再構成できる`text`を保存していた。

縮約後は次の形に統一した。

```text
DecisionPacket
├─ id
├─ intent_id
├─ purpose
│  └─ Decision { relation_ids }
└─ materials[]
   ├─ source_id
   ├─ role
   └─ evidence_ids
```

上位属性は13個から4個へ69.2%削減した。用途固有の属性は`purpose`の型付きvariantへ閉じ込め、資料の役割と根拠は`materials`へ統合した。新しい用途、資料role、根拠種別が必要になっても、Packet直下へoptional属性を追加しない。

`position`やRelationの両端は`DocumentRelation`を参照して取得し、検索用textはProfile、Relation、Evidenceとのjoin時に生成する。保存Packetには検索用textを持たせない。旧`relation-dossiers.jsonl`は読み込み互換だけ残し、新規Buildは`decision-packets.jsonl`を出力する。

## 評価条件

- コーパス: `aobane-industries-ja-dynamic-validity-practical-variation`
- 評価split: `practical_holdout`
- 文書: 1,200件
- Evidence: 64,800件
- Profile: 1,200件
- Relation / Packet: 540件
- 質問: 200問、100 family
- 時点: T1（2026-08-15）
- 検索: 既存と同じRuri Dense、BM25、固定Hybrid
- 検索制約: top-k 10、anchor-k 5、Packet budget 3
- 再コンパイル: metadata provider、LLM呼び出し0件

旧版と縮約版でProfile、Relation、Evidenceの各JSONLは全12 shardで同一だった。Packet表現だけを変更して比較した。

## 構造と保存量

| 指標 | 旧版 | 縮約版 | 差 |
|---|---:|---:|---:|
| Packet数 | 540 | 540 | 0 |
| Packet直下属性 | 13 | 4 | -69.2% |
| Packet総bytes | 1,782,080 | 320,940 | -82.0% |
| 1 Packet平均bytes | 3,300.1 | 594.3 | -82.0% |
| role対応不一致 | - | 0 / 540 | なし |
| Evidence対応不一致 | - | 0 / 540 | なし |
| Relation参照不一致 | - | 0 / 540 | なし |

旧版textに含めていた原文を下流で再度Evidenceとして付加する重複も解消した。検索adapterが生成する回答資料では、各Evidence本文を一度だけ含める。

## Position gate

| gate | 結果 |
|---|---:|
| Position一致 | 540 / 540 |
| 予期しないPosition | 0 |
| 確認台帳Evidence | 540 / 540 |
| Source・Target・台帳の判断材料 | 540 / 540 |
| Gold Relation四値写像coverage | 600 / 600 |

Positionの内訳も、`dominates` 60、`conditional` 120、`non_effective` 300、`unresolved` 60で期待値と一致した。

## 検索精度

| 条件 | 指標 | 旧版 | 縮約版 | 差 |
|---|---|---:|---:|---:|
| Fragrach Ruri Packet | R@5 | 97.5% | 97.5% | 0.0pt |
| Fragrach Ruri Packet | R@10 | 98.75% | 98.75% | 0.0pt |
| Fragrach Ruri Packet | 完全Evidence@5 | 97.5% | 97.5% | 0.0pt |
| Fragrach Ruri Packet | 完全Evidence@10 | 98.0% | 98.0% | 0.0pt |
| Fragrach固定Hybrid Packet | R@5 | 91.0% | 91.0% | 0.0pt |
| Fragrach固定Hybrid Packet | R@10 | 96.5% | 96.5% | 0.0pt |
| Fragrach固定Hybrid Packet | 完全Evidence@5 | 91.0% | 91.0% | 0.0pt |
| Fragrach固定Hybrid Packet | 完全Evidence@10 | 91.5% | 91.5% | 0.0pt |

縮約版はPacket ID、Evidenceの並び、role表記を再構成するため、Packet条件の検索JSONL自体は旧版と同一ではない。一方、200問すべてで引用source集合は一致し、集計したR@5、R@10、完全Evidenceにも差はなかった。

## 回答精度の扱い

検索用textが変わったため、旧結果は流用せず、同じLuna reader、同じ回答形式、同じtop-kで200問を再生成した。

| 条件 | 指標 | 旧版 | 縮約版 | 差 |
|---|---|---:|---:|---:|
| Fragrach Ruri Packet | Answer Accuracy | 98.5% | 98.5% | 0.0pt |
| Fragrach Ruri Packet | DVAA Full | 96.0% | 97.0% | +1.0pt |
| Fragrach固定Hybrid Packet | Answer Accuracy | 93.0% | 93.0% | 0.0pt |
| Fragrach固定Hybrid Packet | DVAA Full | 90.0% | 91.0% | +1.0pt |

reader出力には生成揺らぎがあり得るため、DVAA Fullの+1.0ptを改善効果とは断定しない。今回の判断に必要なのは、大幅な低下がなく、Answer Accuracyも維持されたことである。

## 次の展開gate

別部門へは一度に混ぜず、各部門で次を満たしてから統合評価へ進む。

1. Packet直下4属性を維持し、部門固有属性を追加しない。
2. role、Evidence、Relation参照の変換不一致を0件にする。
3. 部門内の固定質問で、R@5、R@10、完全Evidenceの低下を各1.0pt以内にする。
4. 検索入力が変わった場合は、固定回答subsetでもAnswer AccuracyとDVAA Fullを再測定する。
5. 新しい属性が必要に見えた場合は、`purpose` variant、`materials` payload、または参照先のProfile/Relation概念へ統合できないか先に検討する。

今回の結果では精度低下がなく、縮約効果が大きいため、次の部門データを追加する判断とする。
