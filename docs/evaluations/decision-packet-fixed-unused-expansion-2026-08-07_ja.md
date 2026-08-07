# Decision Packet固定方式・未使用12部門評価（2026-08-07）

## 結論

コミット`5a21129`で固定したDecision Packetの4属性と契約判断統合規則を変更せず、既存24組に一度も含めていなかった12部門・用途へ評価を広げた。

追加分は8業界、12部門・用途、144文書、72問である。6用途を各2組含み、すべて現行`gpt-5.6-luna`でfresh抽出した。用途限定Rawに対して、PacketのR@5は59.3%から77.1%、Complete@5は30.6%から52.8%へ改善した。Relation Path@5は98.6%、Path@10は100%で、Packet直下属性不一致は0 / 80だった。

新しいデータで見つかった公開失敗はPacket属性の不足ではなく、通常期限と条件付き例外期限を同じClaim slotとして比較した誤Conflictだった。期限predicateのconditionを既存slot判定へ反映し、LLMを再実行しない再コンパイルで未解決Conflictを3から0へ解消した。この修正を既存24組へ逆適用しても、R@5、R@10、Complete@5、Complete@10、Path@5、Path@10は完全に同値だった。

## 追加対象

| 分野・部門 | 用途 |
|---|---|
| 製造・製品設計 | `governance` |
| ソフトウェア・セキュリティ | `governance` |
| 医療・臨床検査 | `technical_spec` |
| ソフトウェア・カスタマーサクセス | `technical_spec` |
| 金融・個人金融 | `planning` |
| 建設・建築設計 | `planning` |
| 小売・商品 | `operations` |
| 物流・通関 | `operations` |
| ソフトウェア・SRE | `incident_change` |
| 物流・貿易管理 | `incident_change` |
| 金融・保険金サービス | `commercial_compliance` |
| エネルギー・系統運用 | `commercial_compliance` |

各組は3シナリオ、12文書、6問である。

## 実行条件

- Packet方式: コミット`5a21129`の4属性契約と限定契約判断統合
- Provider / model: `codex-app-server` / `gpt-5.6-luna`
- reasoning effort: `low`
- Claim batch size: 12
- 基準日: 2026-07-15
- Claim抽出: 144回
- Profile抽出: 12回
- cache hit: 0

| Artifact | 結果 |
|---|---:|
| 部門・用途 | 12 |
| 文書 | 144 |
| Evidence | 1,728 |
| 有効Claim | 520 |
| Relation | 87 |
| Packet | 80 |
| Packet bytes | 36,382 |
| Packet直下属性不一致 | 0 / 80 |
| warning / error | 12 / 0 |
| 最終未解決Conflict | 0 |

warningの内訳は、不正Profile棄却2件、Profile fallback 2件、未知Evidence参照によるClaim棄却5件、不正Relation棄却3件である。Provider出力の不正要素は公開Buildへ入れていない。

## 条件付き期限の誤Conflict

物流・通関operationsのfresh抽出では、3シナリオ分の`applies_to`、`exception_to`、`records_execution_of`を各3本、合計9 Relationすべてコンパイルできた。一方、同じレビュー期限について次のClaimが共存した。

- 通常運用: 受付後一営業日以内
- 承認済み期間限定例外: 受付後二時間以内
- 通常の現場運用: 受付後一営業日以内

各Claimには通常運用、期間限定例外など異なるconditionがあったが、`review_deadline`のslot比較がconditionを使わず、3件を未解決Conflictにした。`operations` Intentは未解決Conflictを許可しないため、初回Buildは診断付きで保存され、公開されなかった。

期限predicateではconditionが異なるClaimを別slotとして扱うようにした。保存済みProfile、Relation、Claimを再コンパイルすると、LLM呼び出し0回でConflict 8件、未解決3件からConflict 0件、未解決0件となり、Buildを公開できた。

この変更はPacket構造、Relation、Evidence、material roleを変更しない。

## 追加12組の検索結果

| 指標 | Raw + purpose | Packet | 差 |
|---|---:|---:|---:|
| R@5 | 59.3% | 77.1% | +17.8pt |
| R@10 | 66.7% | 84.5% | +17.8pt |
| Complete@5 | 30.6% | 52.8% | +22.2pt |
| Complete@10 | 38.9% | 65.3% | +26.4pt |
| Relation Path@5 | - | 98.6% | - |
| Relation Path@10 | - | 100% | - |

### 用途別

各用途2部門、12問のmacro平均である。

| 用途 | Raw R@5 | Packet R@5 | Raw Complete@5 | Packet Complete@5 | Packet Path@5 |
|---|---:|---:|---:|---:|---:|
| `governance` | 66.7% | 87.5% | 33.3% | 75.0% | 100% |
| `technical_spec` | 25.0% | 55.6% | 0% | 16.7% | 100% |
| `planning` | 75.0% | 75.0% | 50.0% | 50.0% | 100% |
| `operations` | 75.0% | 70.8% | 50.0% | 41.7% | 100% |
| `incident_change` | 75.0% | 91.7% | 50.0% | 83.3% | 100% |
| `commercial_compliance` | 38.9% | 81.9% | 0% | 50.0% | 91.7% |

`operations`だけPacket R@5がRawを4.2pt、Complete@5が8.3pt下回った。物流・通関はRawと同値で、小売・商品がPacket R@5 66.7%、Complete@5 33.3%だった。Path@5は両部門とも100%であり、RelationやPacketの不在ではない。例外対象外質問でPacket内の具体的な標準頻度Evidenceが不足するため、次の診断対象は属性追加ではなく、`exception_to` Packetのendpoint Evidence選択である。

`technical_spec`はPacketがRawを大きく上回ったが、Complete@5は16.7%に留まる。Path@5は100%、R@10は80.6%まで上がるため、主にEvidence内容と順位の課題として分離する。

## 既存24組への回帰

期限condition修正の前後を、固定Packet方式の既存24組、144問で比較した。

| 指標 | 修正前 | 修正後 | 差 |
|---|---:|---:|---:|
| Packet R@5 | 85.6% | 85.6% | 0pt |
| Packet R@10 | 89.5% | 89.5% | 0pt |
| Packet Complete@5 | 70.1% | 70.1% | 0pt |
| Packet Complete@10 | 76.4% | 76.4% | 0pt |
| Packet Path@5 | 96.2% | 96.2% | 0pt |
| Packet Path@10 | 99.3% | 99.3% | 0pt |

24組を個別に比較した低下も0件だった。

## 累積36組

| 項目 | 結果 |
|---|---:|
| 部門・用途 | 36 |
| 文書 | 432 |
| Evidence | 5,184 |
| 有効Claim | 1,525 |
| Relation / Packet | 277 / 234 |
| 質問 | 216 |
| Packet bytes | 109,523 |
| Packet直下属性不一致 | 0 / 234 |
| error | 0 |

| 指標 | Raw + purpose | Packet |
|---|---:|---:|
| R@5 | 60.1% | 82.8% |
| R@10 | 66.6% | 87.8% |
| Complete@5 | 31.0% | 64.4% |
| Complete@10 | 36.6% | 72.7% |
| Packet Path@5 | - | 97.0% |
| Packet Path@10 | - | 99.5% |

## 判断

未使用データへ広げても、4属性PacketはRaw + purposeを主要指標で上回り、新しい属性は必要なかった。fresh抽出で生じた公開失敗も、既存のClaim conditionをslot判定へ接続することで解消できた。

Packet方式は固定を維持する。次は小売・商品operationsの`exception_to` Packetを対象に、標準頻度Evidenceが材料へ入らない理由を確認する。改善する場合も属性を追加せず、endpoint Evidence選択の範囲でA/Bし、既存36組への回帰を測る。

## 検証

- `cargo test --workspace`
- `npm test`
- `cargo fmt --all -- --check`
- `git diff --check`

