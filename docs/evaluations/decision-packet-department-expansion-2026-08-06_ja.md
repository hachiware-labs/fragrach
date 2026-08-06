# Decision Packet部門拡張評価（2026-08-06）

## 結論

Decision Packetの直下属性を`id`、`intent_id`、`purpose`、`materials`の4個に固定したまま、物流・通関部の`technical_spec`と、エネルギー・系統運用部の`operations`へ評価を広げた。どちらも新しいPacket属性を必要とせず、roleとEvidenceの変換不一致は0件だった。

決定的な検索評価は両部門で旧Packetと同値だった。独立生成した6問ずつの回答評価も、最終rendererではStrict Pass、Evidence recall、回答要素、behaviorのすべてで旧版を下回らなかった。小標本かつ生成揺らぎがあるため改善とは断定しないが、縮約契約を維持して次の部門へ進める。

## 固定した契約

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

今回の部門拡張では、この型へ属性を追加していない。用途固有の意味は既存`DocumentRelation`を参照し、検索用textはPacket、Profile、Relation、Evidenceのjoin時に生成した。

初回の物流回答A/Bでは、縮約rendererがEvidenceの順序とrole表記を変更したため、補助指標が一時的に低下した。これに対して属性を戻さず、rendererを「確認資料を先に置く」「Position表記を統一する」「Evidence見出しへ内部role名を混ぜない」という一つの表示規則へ統合した。保存Packetは変更していない。

## 対象

| 部門・用途 | 文書 | Evidence | Claim | Relation / Packet | Relation型 | 質問 |
|---|---:|---:|---:|---:|---|---:|
| 物流・通関 / technical_spec | 12 | 144 | 40 | 9 | `amends`、`proposes_change_to`、`records_execution_of` | 6 |
| エネルギー・系統運用 / operations | 12 | 144 | 41 | 12 | `exception_to`、`records_execution_of`、`order_of_precedence`、`applies_to` | 6 |

どちらも2026-07-15時点、既存のLuna抽出結果を現行コードでLLM呼び出しなしに再コンパイルした。

## 構造と保存量

| 部門・用途 | 旧bytes | 縮約bytes | 削減 | role不一致 | Evidence不一致 | Packet直下属性 |
|---|---:|---:|---:|---:|---:|---:|
| 物流・通関 / technical_spec | 28,467 | 3,960 | 86.1% | 0 / 9 | 0 / 9 | 4 |
| エネルギー・系統運用 / operations | 38,855 | 5,094 | 86.9% | 0 / 12 | 0 / 12 | 4 |

両部門の全Packetで、旧版のoperative、excluded、contender、verifierと、新版`materials.role`の対応が一致した。Evidence参照集合も一致した。

## 決定的検索A/B

### 物流・通関 / technical_spec

| 指標 | 旧版 | 縮約版 | 差 |
|---|---:|---:|---:|
| Compile coverage | 100% | 100% | 0.0pt |
| R@5 | 88.9% | 88.9% | 0.0pt |
| R@10 | 88.9% | 88.9% | 0.0pt |
| Complete@5 | 66.7% | 66.7% | 0.0pt |
| Relation Path@5 | 100% | 100% | 0.0pt |

### エネルギー・系統運用 / operations

| 指標 | 旧版 | 縮約版 | 差 |
|---|---:|---:|---:|
| Compile coverage | 100% | 100% | 0.0pt |
| R@5 | 83.3% | 83.3% | 0.0pt |
| R@10 | 100% | 100% | 0.0pt |
| Complete@5 | 66.7% | 66.7% | 0.0pt |
| Relation Path@5 | 100% | 100% | 0.0pt |

## 独立回答A/B

readerは`gpt-5.6-luna`、reasoning effortは`low`、judgeは`gemma4:latest`、top-kは5に固定した。旧版と縮約版は別々に生成した。

### 物流・通関 / technical_spec

| 指標 | 旧版 | 縮約版・最終renderer | 差 |
|---|---:|---:|---:|
| Strict Pass | 33.3% | 50.0% | +16.7pt |
| Evidence recall | 69.4% | 75.0% | +5.6pt |
| 回答要素 | 83.3% | 91.7% | +8.4pt |
| Behavior | 100% | 100% | 0.0pt |

初回の縮約rendererはStrict Pass 33.3%、Evidence recall 61.1%、回答要素75.0%、Behavior 100%だった。保存属性ではなく表示規則を統合した後に上表まで回復した。

### エネルギー・系統運用 / operations

| 指標 | 旧版 | 縮約版 | 差 |
|---|---:|---:|---:|
| Strict Pass | 33.3% | 50.0% | +16.7pt |
| Evidence recall | 75.0% | 83.3% | +8.3pt |
| 回答要素 | 94.4% | 94.4% | 0.0pt |
| Behavior | 100% | 100% | 0.0pt |

各部門6問なので、正答1問で16.7pt動く。上昇値を方式の改善とは扱わず、「縮約版が旧版を大きく下回っていない」というgate判定だけに用いる。

## 現時点の判断

これまでの1,200文書Dynamic Validity評価に加え、二つの部門・二つの用途・七つのRelation型で4属性Packetを確認した。新しい関係型をPacket属性へ昇格させなくても、`purpose`のRelation参照と`materials`で検索・回答資料を構成できた。

したがって、Packetの汎用性は表現上だけでなく、異なる部門・用途でも追加属性なしに精度gateを通るところまで確認できた。ただし部門評価は各6問に限られる。次は`commercial_compliance`または`incident_change`を追加し、契約・監査資料や時系列変更でも4属性を維持できるか確認する。
