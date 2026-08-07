# Decision Packet固定属性・追加12部門評価（2026-08-07）

## 結論

Decision Packetの直下属性を`id`、`intent_id`、`purpose`、`materials`の4個に固定したまま、弱点が残っていた`operations`、`planning`、`commercial_compliance`を各4部門へ追加した。

追加分は12部門・用途、144文書、1,728 Evidence、72問である。すべて現行`gpt-5.6-luna`によるfresh抽出で、Claim抽出144回、Profile抽出12回、cache hit 0だった。最終BuildのPacket直下属性不一致は0 / 80で、新しい属性は増やしていない。

追加分のmacro平均は、用途限定Rawに対してPacketのR@5が63.0%から81.3%、Complete@5が33.3%から61.1%、Relation Path@5が36.1%から95.8%だった。必須Evidenceのcompile coverageは全12組で100%、Path@10も100%だった。

前回の12組へ今回の一般化を逆適用しても、Packet R@5は86.3%から87.0%、Complete@5は70.8%から72.2%、Path@5は96.5%のままで、回帰はなかった。前回分と追加分を合わせると24部門・用途、288文書、144問となり、Packet R@5は84.1%、Complete@5は66.7%、Path@5は96.2%である。

今回見つかった欠落は属性不足ではなかった。契約提案のscopeが基本契約より具体化される揺れと、運用文書チェーンのRelation抽出漏れを、既存のscope refinement、Claim、文書型、Relationへ統合して解消した。

## 追加対象

各組は3シナリオ、12文書、6問である。

| 分野・部門 | 用途 |
|---|---|
| 金融・リスク管理 | `operations` |
| ソフトウェア・基盤開発 | `operations` |
| 小売・顧客サポート | `operations` |
| 物流・輸配送 | `operations` |
| 医療・メディカル | `planning` |
| エネルギー・電力小売 | `planning` |
| 製造・保守サービス | `planning` |
| ソフトウェア・プロダクト企画 | `planning` |
| 金融・資金管理 | `commercial_compliance` |
| 建設・積算調達 | `commercial_compliance` |
| 小売・サプライチェーン | `commercial_compliance` |
| エネルギー・発電保全 | `commercial_compliance` |

## 実行条件

- CLI: コミット`12af8b1`へ今回のRelation補完を加えた作業版
- Provider / model: `codex-app-server` / `gpt-5.6-luna`
- reasoning effort: `low`
- Claim batch size: 12
- 基準日: 2026-07-15
- fresh抽出後、同じ保存済みProfile・Claimを最終コードでLLM呼び出しなしに再コンパイル

最初に3組を並列、`batch-size 4`で試した実行は、Codex CLIのsystem skill書き込み競合と403、およびClaim呼び出し数の増加が発生したため集計から除外した。正式集計は前回と同じ`batch-size 12`で全組を直列に取り直した結果だけを使う。

| 項目 | 追加12組 |
|---|---:|
| 文書 | 144 |
| Evidence | 1,728 |
| 有効Claim | 482 |
| Claim抽出呼び出し | 144 |
| Profile抽出呼び出し | 12 |
| Claim cache hit / miss | 0 / 144 |
| Relation | 92 |
| Packet | 80 |
| Packet bytes | 37,751 |
| Packet直下属性不一致 | 0 / 80 |
| warning / error | 11 / 0 |
| 最終未解決Conflict | 0 |

warning 11件の内訳は、未知Evidence参照によるClaim棄却9件、grounding不成立のProfile棄却1件、front matterへのfallback 1件である。不正なProvider出力をそのまま公開Buildへ入れていない。

## 属性を増やさず統合したもの

### 契約scopeの具体化

金融・資金管理のfresh Profileでは、未署名の供給元提案だけに製品scopeが補われ、基本契約は契約scopeまでだった。両者は同じ契約を参照していたが、完全一致判定では`proposes_change_to` 3本が欠落した。

提案scopeが基本契約scopeと一致するか、その厳密な具体化であり、同じ承認済み基本契約が一意に決まる場合を既存のscope refinementとして扱うようにした。結果は次のとおりだった。

| 指標 | 統合前 | 統合後 |
|---|---:|---:|
| Relation | 3 | 6 |
| Packet R@5 | 63.9% | 83.3% |
| Complete@5 | 33.3% | 66.7% |
| Path@5 | 33.3% | 100% |

この規則は建設、小売、エネルギーの契約データでも追加属性なしに適用できた。

### 運用文書チェーン

小売・顧客サポートのfresh実行では、期限付き逸脱と現場作業指示のClaimが衝突した一方、Providerが同シナリオの一部Relationを返さず、1件のConflictを解決できなかった。失敗Buildは破棄せず診断し、次の既存概念チェーンを一つの規則として補完した。

```text
operating_procedure
  └─ work_instruction applies_to
       └─ temporary_deviation exception_to operating_procedure
            └─ execution_log records_execution_of temporary_deviation
```

補完には、承認状態、文書型、scopeの同値または厳密な具体化、同じ単一値Claim slotの一致・非一致、対象候補が一意であることを必要とする。部門名や固有の業務語は条件に含めていない。

この統合により、当該BuildはRelation 5から9、未解決Conflict 1から0となり公開できた。検索もPacket R@5、Complete@5、Path@5がすべて100%だった。

## 追加12組の検索結果

| 指標 | Raw + purpose | Packet | 差 |
|---|---:|---:|---:|
| R@5 | 63.0% | 81.3% | +18.3pt |
| R@10 | 67.4% | 88.2% | +20.8pt |
| Complete@5 | 33.3% | 61.1% | +27.8pt |
| Complete@10 | 34.7% | 73.6% | +38.9pt |
| Relation Path@5 | 36.1% | 95.8% | +59.7pt |
| Relation Path@10 | - | 100% | - |

### 用途別

各用途4部門、24問のmacro平均である。

| 用途 | Raw R@5 | Packet R@5 | Raw Complete@5 | Packet Complete@5 | Packet Path@5 |
|---|---:|---:|---:|---:|---:|
| `operations` | 75.0% | 81.3% | 50.0% | 66.7% | 100% |
| `planning` | 75.0% | 85.4% | 50.0% | 70.8% | 87.5% |
| `commercial_compliance` | 38.9% | 77.1% | 0% | 45.8% | 100% |

`operations`では1部門だけPacket R@5がRawを8.3pt下回ったが、R@10はPacket 91.7%、Raw 83.3%で逆転し、Complete@5は同値だった。用途全体ではPacketがRawを上回った。

`planning`のPath@5は87.5%だがPath@10は100%で、Relation欠落ではなく統合Packetの順位が6位になる質問が残る。

`commercial_compliance`は全4部門でPath@5 100%だった。一方、小売・サプライチェーンはComplete@5 0%、Complete@10 66.7%であり、必要Relationはコンパイルできているが、契約階層Packetと未署名提案Packetをtop-5へ同時に入れる順位がまだ弱い。属性追加ではなく、検索時の判断単位統合またはrankingの課題として扱う。

## 前回12組への回帰

| 指標 | 前回コード | 今回コード | 差 |
|---|---:|---:|---:|
| Packet R@5 | 86.3% | 87.0% | +0.7pt |
| Packet Complete@5 | 70.8% | 72.2% | +1.4pt |
| Packet Path@5 | 96.5% | 96.5% | 0pt |
| Packet Path@10 | 98.6% | 98.6% | 0pt |

前回Buildの保存済み抽出結果を今回コードで再コンパイルした。Relationは97から98、Packetは87から88になったが、4属性契約の不一致は0だった。

## 累積24組

| 項目 | 結果 |
|---|---:|
| 部門・用途 | 24 |
| 文書 | 288 |
| Evidence | 3,456 |
| 有効Claim | 1,005 |
| Relation / Packet | 190 / 168 |
| 質問 | 144 |
| Packet直下属性不一致 | 0 / 168 |
| error | 0 |

| 指標 | Raw + purpose | Packet |
|---|---:|---:|
| R@5 | 60.5% | 84.1% |
| R@10 | 66.6% | 89.5% |
| Complete@5 | 31.3% | 66.7% |
| Complete@10 | 35.4% | 76.4% |
| Packet Path@5 | - | 96.2% |
| Packet Path@10 | - | 99.3% |

## 判断と次の評価

今回も、新しい分野・部門の追加によってPacket属性を増やす必要はなかった。欠落は既存概念のscope比較とRelation graphの不完全さであり、俯瞰した規則へ統合できた。4属性契約を維持してデータ追加を続ける判断は妥当である。

次は、構造coverageが100%でもComplete@5が低かった`commercial_compliance`を優先する。新属性は追加せず、同じ契約判断に属する基本契約・個別契約・未署名提案のPacketを検索時にどう束ねるかをA/Bする。同時に、`planning`のPath@5を落とす6位Packetについて、保存構造ではなくrendererとrankingの語彙重複を確認する。

## 検証

- `cargo test --workspace`: pass
- `npm test`: pass
- `cargo fmt --all -- --check`: pass
- `git diff --check`: pass
