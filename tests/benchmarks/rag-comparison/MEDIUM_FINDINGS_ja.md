# Mコーパス旧100文書スナップショット評価

## 結論

Mコーパスを500文書へ拡張する前の100文書スナップショットを11問で評価したところ、Evidence Dossierを使うFragrachがRaw RAGの回答品質を上回りました。本文まで照合する評価で、Strict PassはRaw RAGの9.1%から45.5%、根拠再現率は51.5%から78.8%へ改善しました。

従来のClaim baselineも、根拠再現率60.6%、Strict Pass 18.2%でRawを上回っています。Knowledge Buildによる検索改善に加え、質問をAnswer Slotsへ分解し、関連するClaim、原文、権威性、時点、Conflictを回答用資料へ組み立てる処理が、最終回答の改善に寄与しました。

ただし、質問数は11問であり、Dossierの入力tokenはRawの約3.25倍です。今回の結果は初期実証であり、一般的な精度保証ではありません。

## 評価範囲

- Source Corpus: 500文書版へ拡張する前の100文書スナップショット
- 走査結果: 99文書を解析、完全重複1文書、エラー0
- Raw RAG: 511チャンク
- 回答評価: `design-review` 8問、`incident-response` 3問
- モデル: `gemma4:latest`
- 検索: 日本語文字n-gram BM25
- top k: 5
- seed: 42
- 回答生成と採点: 質問ごとに独立したプロンプト、方式名を見せないブラインド採点

MediumにはSmallと同じ16問があります。今回実コンパイルした2 Intentに属する11問だけを比較し、未コンパイルIntentを0点として扱っていません。

## 評価粒度の修正

最初の評価では、同じ文書と見出しに属する段落をすべて同じ根拠として数えていました。DR-001では、「外部仕様変更はレビュー必須」という段落ではなく、同じ見出しにある「動作を変えない修正は省略可能」という別段落を取得しても、根拠取得成功になっていました。

この偽陽性を防ぐため、`required_evidence`へ`content_terms`を追加しました。現在の根拠再現率は、文書と見出しに加え、必要な本文語が取得単位に含まれることを確認します。引用再現率は、回答が参照した文書と見出しで評価します。

この修正により絶対値は下がりましたが、Rawに対するClaim baselineの改善幅は9.1ポイントのまま維持されました。

## コンパイル結果

厳格版の`design-review.yaml`は、未解決矛盾2件を検出してKnowledge Buildの公開を停止しました。99文書から975 evidence、140 claims、5 conflictsを抽出し、所要時間は905,281 ms、LLM callは100回でした。

評価では、未解決矛盾をWarningと未解決質問として残して公開する`*-warn.yaml`を使いました。

| Intent | 状態 | Claims | Conflicts | 未解決 | Warnings | LLM calls | 時間 |
|---|---:|---:|---:|---:|---:|---:|---:|
| design-review | completed_with_warnings | 141 | 6 | 3 | 18 | 100 | 895,260 ms |
| incident-response | completed_with_warnings | 53 | 2 | 1 | 25 | 100 | 527,729 ms |

同じ入力とモデルでも、設計レビューの厳格実行とWarning実行にはclaims +1、conflicts +1、未解決 +1の差がありました。LLM抽出件数には小さな揺らぎがあります。

## Evidence Dossier

Dossier版は、検索結果をtop-k順の平坦なコンテキストとして渡しません。

1. 質問を1〜5個のAnswer Slotsへ分解する。
2. 質問から`requires_review`、`requires_approval`、`deadline`などの関係語を補う。
3. 用語集から「外部仕様」のような社内正規語を取得し、判断Slotを再検索する。
4. SlotごとにClaimと短い原文を取得する。
5. 取得したClaimと根拠を共有するConflictだけを別枠で追加する。
6. Slotが`missing`の場合だけEvidence fallbackを実行する。
7. 各Slotを`supported`、`unresolved`、`missing`として構造化する。
8. 構造化結果だけを使って最終回答を生成し、citation IDを検証する。

これによりDR-001では、用語集の「顧客が利用する画面の挙動」を「外部仕様」へ接続し、現行の設計レビュー標準から必要段落を取得できました。従来回答の「直接的な記述はない」という誤りは解消し、Strict Passになりました。

## 検索結果

| 検索方式 | R@5 | R@10 | R@20 |
|---|---:|---:|---:|
| Raw RAG | 51.5% | 60.6% | 69.7% |
| Oracle compiled | 66.7% | 66.7% | 66.7% |
| Actual Claim baseline | 60.6% | 60.6% | 60.6% |
| Actual no authority | 51.5% | 60.6% | 60.6% |
| Actual evidence fallback | 65.2% | 69.7% | 72.7% |
| Actual evidence only | 51.5% | 72.7% | 72.7% |
| Actual hybrid 60% Claim | 56.1% | 65.2% | 68.2% |
| Actual Evidence Dossier | **78.8%** | — | — |

権威性加点を外すとClaim baselineのR@5は60.6%から51.5%へ下がり、Rawと同じになります。Knowledge Buildに保存した権威順が検索順位へ寄与しています。

DossierはSlot別検索と必要時fallbackを含むため、固定インデックスへ一度だけ問い合わせる他方式とは処理が異なります。R@5は、最終Dossierの主要Claim 5件に、関連Conflictと不足時Evidenceを加えた取得集合に対する値です。

## 回答品質

| 方式 | 根拠再現率 | 引用再現率 | 回答要素再現率 | 禁止誤答率 | Strict Pass | 入力token |
|---|---:|---:|---:|---:|---:|---:|
| Raw RAG | 51.5% | 57.6% | 88.6% | 0.0% | 9.1% | 9,067 |
| Oracle compiled | 66.7% | 57.6% | **97.7%** | 9.1% | 18.2% | 12,306 |
| Actual Claim baseline | 60.6% | 71.2% | 88.6% | 0.0% | 18.2% | 15,109 |
| Actual Evidence Dossier | **78.8%** | **74.2%** | 90.9% | **0.0%** | **45.5%** | 29,478 |

DossierはRawに対し、根拠再現率を27.3ポイント、引用再現率を16.6ポイント、回答要素再現率を2.3ポイント、Strict Passを36.4ポイント改善しました。禁止誤答は発生していません。

Strict PassになったのはDR-001、DR-004、DR-005、IR-002、DR-007です。DR-002、IR-001、IR-003、MG-001は回答要素を満たしても必要な本文または引用が不足しました。DR-003は必要根拠を取得したものの回答要素を落とし、DR-006は必要本文を取得しても引用を落としました。

### 決定的レンダリングのアブレーション

構造化Slotを追加LLMなしで連結する条件も試しました。入力tokenは24,868まで16%減り、Strict Passは45.5%を維持しましたが、回答要素再現率が86.4%へ下がり、禁止誤答率が9.1%になりました。

今回の目的は精度改善なので、この条件は採用していません。最終自然文化は読みやすさだけでなく、Slot間の条件とGuardrailを統合する役割を持っていました。

## 現在の判断

今回の単一実行では、FragrachのEvidence DossierがRaw RAGより高いStrict Passを得ました。Knowledge Buildの検索改善を最終回答へ変換できる構成が初めて確認できた段階です。

一方、入力tokenは目標としたRawの1.5倍以内に収まらず、約3.25倍でした。次は精度を固定したまま、質問計画の再利用、短いDossier表現、fallback再評価の部分更新によってコストを下げる必要があります。

また、Oracleの本文根拠再現率が66.7%に留まっています。現在のOracle knowledge unitが全質問の必要段落を表現していないため、完全な上限ではありません。Oracle定義も本文粒度に合わせて見直す必要があります。

## 次の改善対象

1. DR-002とIR-001で不足したConflict根拠を、Claimとの根拠共有だけでなく論点関係でも選べるようにする。
2. DR-003のSlot値から承認者一覧を欠落させないSchema制約を追加する。
3. DR-006で構造化Slotのcitation IDが最終回答へ必ず残るよう検証する。
4. Dossierを質問ごとに中間保存し、Ollama待機や再実行時に途中から再開できるようにする。
5. Dossierの入力tokenをRawの1.5倍以内へ近づける。
6. 複数seedとMedium固有質問で再評価する。

## 再実行

```powershell
node tests/benchmarks/rag-comparison/run-upper-bound.mjs `
  --corpus tests/corpora/aobane-industries-ja-medium `
  --intent design-review `
  --intent incident-response `
  --compiled-build target/medium-builds-v1/design-review `
  --compiled-build target/medium-builds-v1/incident-response `
  --actual-only `
  --actual-variant dossier `
  --top-k 5 `
  --model gemma4:latest `
  --output target/benchmarks/medium-rag-dossier-v1
```

`--question DR-001`のように質問IDを指定すると、単一質問だけを再実行できます。
