# Decision Packet複数分野拡張評価（2026-08-07）

## 結論

Decision Packetの直下属性を`id`、`intent_id`、`purpose`、`materials`の4個に固定したまま、製造、医療、小売、建設、物流、エネルギーの6分野、12部門・用途へ評価を広げた。12組すべてを現行コードと`gpt-5.6-luna`でfresh抽出しており、過去Buildの再利用ではない。

144文書、1,728 Evidence、72問の最終結果では、用途限定Rawに対してPacketのR@5は58.1%から86.3%、Complete@5は29.2%から70.8%、Relation Path@5は61.1%から96.5%だった。対象とした必須Relationのコンパイル充足はfresh直後の57 / 72から72 / 72へ改善した。

新しいPacket属性は追加していない。データ追加で現れた差異は、計画と決定、試験と仕様変更、古いFAQと現行規程、技術草案と現行仕様を、それぞれ既存の文書・Claim・Relation概念へ統合した。また、同じ判断材料を持つ複数Relationを一つのPacketへまとめた結果、Packet数は96から87、保存量は42,657 bytesから39,128 bytesへ減り、主要なR@5とComplete@5はわずかに上がった。

したがって、現時点では「分野が増えるたびに属性を足す」必要は見えていない。4属性のままデータ拡張を続けられる。ただし、今回は決定的検索の評価であり、回答生成の品質を同時に保証するものではない。

## 対象とfresh条件

各組は12文書、144 Evidence、6問である。`current`と`holdout`は異なる部門系列を使い、同じ用途を2部門で確認した。

| 系列 | 分野・部門 | 用途 |
|---|---|---|
| current | 製造・調達 | `commercial_compliance` |
| current | 医療・臨床運用 | `governance` |
| current | 小売・EC | `planning` |
| current | 建設・現場管理 | `operations` |
| current | 物流・コールドチェーン | `incident_change` |
| current | エネルギー・再生可能エネルギー | `technical_spec` |
| holdout | 製造・品質保証 | `technical_spec` |
| holdout | 医療・安全性監視 | `commercial_compliance` |
| holdout | 小売・店舗運営 | `incident_change` |
| holdout | 建設・土木 | `planning` |
| holdout | 物流・倉庫 | `governance` |
| holdout | エネルギー・安全環境 | `operations` |

fresh抽出の合計は次のとおりだった。

| 項目 | 結果 |
|---|---:|
| 文書 | 144 |
| Evidence | 1,728 |
| 有効Claim | 523 |
| Claim抽出LLM呼び出し | 144 |
| Profile抽出LLM呼び出し | 12 |
| Claim抽出cache hit / miss | 0 / 144 |
| 最終Relation | 97 |
| 最終Packet | 87 |
| Packet直下属性不一致 | 0 / 87 |
| warning / error | 19 / 0 |

抽出cache hitが0であるため、ここで比較したメタデータはすべて今回の現行方式で生成した。最終Buildは同じ抽出結果を現行コンパイラで再コンパイルし、ルール統合の影響だけを分離した。

## 属性を増やさず統合した概念

### 決定と実施計画

承認済み議事録と実施計画が同じ採用方式を明示する場合、議事録が計画を承認する`approves`と、計画が決定を実装する`implements_decision`を構成する。`implements_decision`はRelation語彙の追加であり、Packet属性ではない。

両Relationのsourceとmaterial roleが同じ場合は、二つのPacketを作らず、一つの`purpose.relation_ids`へまとめる。計画系列では12 Relationを6 Packetへ縮約できた。

### 試験実施と仕様変更

試験記録が、承認済み仕様変更と同じClaimのsubject/valueを裏づける場合に限り、`records_execution_of`を構成する。単語の近さだけで試験と仕様を接続せず、Claimと原文Evidenceの一致を必要条件にした。

### 古いFAQと現行規程

FAQ本文が改訂未反映であることを明示し、同じ単一値Claim slotに非互換な現行規程がある場合、`conflicts_with`の対象を最も具体的に重なる規程へ正規化する。文字列`"営業責任者"`と単一要素配列`["営業責任者"]`は同じ値として扱い、表現形式だけの差をConflictにしない。

### 技術草案と現行仕様

未承認の`technical_draft`が次期改訂対象を明示し、対応する承認済み`technical_specification`が一意に決まる場合に、`proposes_change_to`を構成する。分野固有の属性ではなく、提案と現行規範という既存概念へ統合した。

## Relation coverage

72問について、正解経路に必要なRelationがKnowledge Buildへ存在するかを順位と分けて測った。

| 段階 | 必須Relation | Coverage |
|---|---:|---:|
| fresh抽出直後 | 57 / 72 | 79.2% |
| 概念統合後 | 72 / 72 | 100% |

freshで不足したのは、計画と決定6件、試験実施と仕様変更3件、古いFAQと現行規程3件、技術草案と現行仕様3件だった。これらを用途ごとの個別属性として保存せず、上記のRelation形成規則へ統合した。

## 決定的検索

比較対象は、部門全体のRawから利用目的に合う文書だけへ限定した`Raw + purpose`と、4属性Packetである。12組72問のmacro平均を示す。

| 指標 | Raw + purpose | Packet | 差 |
|---|---:|---:|---:|
| R@5 | 58.1% | 86.3% | +28.2pt |
| R@10 | 65.7% | 90.7% | +25.0pt |
| Complete@5 | 29.2% | 70.8% | +41.7pt |
| Complete@10 | 36.1% | 79.2% | +43.1pt |
| Relation Path@5 | 61.1% | 96.5% | +35.4pt |
| Relation Path@10 | 86.1% | 98.6% | +12.5pt |

Claimだけを検索単位にした場合のR@5は56.3%だった。今回の差は、Claim数を増やしたことより、判断に必要な複数文書をRelationとPacketで不可分にした効果が大きい。

### 用途別

各用途は2部門、12問のmacro平均である。

| 用途 | Raw R@5 | Packet R@5 | Raw Complete@5 | Packet Complete@5 | Packet Path@5 |
|---|---:|---:|---:|---:|---:|
| `operations` | 75.0% | 75.0% | 50.0% | 50.0% | 100% |
| `technical_spec` | 25.0% | 86.1% | 0% | 66.7% | 95.8% |
| `governance` | 62.5% | 91.7% | 25.0% | 83.3% | 100% |
| `incident_change` | 75.0% | 95.8% | 50.0% | 91.7% | 100% |
| `commercial_compliance` | 36.1% | 81.9% | 0% | 58.3% | 91.7% |
| `planning` | 75.0% | 87.5% | 50.0% | 75.0% | 91.7% |

R@5とComplete@5でRawを下回った用途はなく、`operations`だけ同値だった。その他5用途ではPacketが上回った。

## Packet統合の影響

同じsourceとmaterial roleを持つRelationを一つの検索Unitへまとめる前後を比較した。

| 指標 | 統合前 | 統合後 | 差 |
|---|---:|---:|---:|
| Relation | 96 | 97 | +1 |
| Packet | 96 | 87 | -9（-9.4%） |
| Packet bytes | 42,657 | 39,128 | -3,529（-8.3%） |
| Packet R@5 | 85.6% | 86.3% | +0.7pt |
| Packet Complete@5 | 69.4% | 70.8% | +1.4pt |
| Packet Relation Path@5 | 97.9% | 96.5% | -1.4pt |

Relationが1件増えたのは、物流・倉庫の単一要素配列表現を同値化して誤ったConflict候補を除き、正しい関係を選べるようにしたためである。Packet統合は保存量を減らし、主要なR@5とComplete@5を維持・微増させた。一方、holdoutの計画質問1件で統合Packetが6位になり、Path@5は1.4pt低下した。Path@10は98.6%、Path@20は100%であり、属性を戻すほどの低下ではないが、次のデータ追加でも監視する。

## 診断と限界

最終Buildのwarning 19件は、未知Evidence参照のClaim棄却11件、未解決Conflict 3件、grounding不成立のProfile 2件とそのfront matter fallback 2件、grounding不成立のRelation棄却1件だった。errorは0件で、grounding不成立の出力は公開Buildへ無条件に採用していない。未解決Conflictは回答時に判断保留を要求する対象であり、精度成功として隠してはいない。

今回の限界は次のとおりである。

- 6分野へ広げたが、各部門・用途は12文書、6問であり、合計でも72問である。
- コーパスは分野別に独立生成した評価データであり、実運用文書のノイズを完全には再現しない。
- 今回はコンパイルと決定的検索を評価し、readerによる回答生成とjudgeによるStrict Passは測っていない。
- Packet統合後のPath@5に1.4ptの小さな低下があるため、次のholdout追加ではR@5だけでなくPath@5も継続して見る。

## 検証

- `cargo test --workspace`: pass
- `npm test`: 107 pass、0 fail
- `cargo fmt --all`: 適用済み
- 4属性契約検査: 87 / 87 pass

次は属性を固定したまま、各用途の部門数と質問数を増やす。特に同値だった`operations`、Path@5が91.7%だった`planning`と`commercial_compliance`を優先し、概念統合が未知の文書表現でも成立するかを確認する。
