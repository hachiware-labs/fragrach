# Mediumコーパス評価結果

## 結論

Mediumコーパスでは、FragrachのKnowledge BuildはRaw RAGより正しい根拠へ到達しやすくなりました。ただし、11問の回答品質ではStrict Passが同率であり、通常のRAGを総合精度で上回ったとはまだ言えません。

Claim中心のActual adapterは、top 5の根拠再現率をRaw RAGの78.8%から87.9%へ、引用再現率を57.6%から71.2%へ改善しました。回答要素再現率はともに88.6%、Strict Passはともに36.4%です。現段階の成果は「検索と引用の改善」であり、「最終回答精度の改善」は次の課題です。

## 評価範囲

- Source Corpus: 100文書
- 走査結果: 99文書を解析、完全重複1文書、エラー0
- Raw RAG: 511チャンク
- 回答評価: `design-review` 8問、`incident-response` 3問の計11問
- モデル: `gemma4:latest`
- 検索: 日本語文字n-gram BM25
- 回答生成と採点: 質問ごとに独立したプロンプト、方式名を見せないブラインド採点
- top k: 5
- seed: 42

MediumにはSmallと同じ16問がありますが、今回実コンパイルした2 Intentに属する11問だけを比較しました。未コンパイルIntentを0点として扱ってはいません。

## コンパイル結果

### 厳格運用

`design-review.yaml`は`unresolved_conflicts_allowed: false`です。99文書から975 evidence、140 claims、5 conflictsを抽出しましたが、未解決矛盾2件を検出したため公開を停止しました。所要時間は905,281 ms、LLM callは100回です。

停止理由は、緊急配備の事後レビュー期限について複数文書が食い違い、適用時期、状態、権威順だけでは一意に決められなかったことです。これは意図して追加した矛盾文書が公開ゲートで機能した結果です。

### Warning付き公開

評価用に、同じIntent IDで`unresolved_conflicts_allowed: true`とした`*-warn.yaml`を用意しました。矛盾を削除したり勝手に解決したりせず、Warningと未解決質問をKnowledge Buildへ残して公開します。

| Intent | 状態 | Claims | Conflicts | 未解決 | Warnings | LLM calls | 時間 |
|---|---:|---:|---:|---:|---:|---:|---:|
| design-review | completed_with_warnings | 141 | 6 | 3 | 18 | 100 | 895,260 ms |
| incident-response | completed_with_warnings | 53 | 2 | 1 | 25 | 100 | 527,729 ms |

同じ入力、モデル、batch sizeで行った設計レビューの厳格実行とWarning実行には、claims +1、conflicts +1、未解決 +1の差がありました。ローカルLLM抽出には小さな揺らぎがあるため、件数を完全な決定値とは扱いません。

## 検索アブレーション

| 検索方式 | 検索単位 | R@5 | R@10 | R@20 |
|---|---:|---:|---:|---:|
| Raw RAG | 511 | 78.8% | 87.9% | 97.0% |
| Oracle compiled | 37 | 100.0% | 100.0% | 100.0% |
| Actual baseline | 167 | **87.9%** | 87.9% | 87.9% |
| Actual no authority | 167 | 78.8% | 87.9% | 87.9% |
| Actual evidence fallback | 1,958 | **87.9%** | **92.4%** | 95.5% |
| Actual evidence only | 1,958 | 74.2% | **95.5%** | 95.5% |
| Actual hybrid 60% Claim | 2,117 | 83.3% | **92.4%** | 95.5% |

top 5ではClaim中心のActualがRawより9.1ポイント高くなりました。権威性boostを外すとRawと同じ78.8%まで下がるため、権威順の利用が上位順位に寄与しています。

Evidenceだけを検索するとtop 5は74.2%へ悪化します。Claimは上位候補を絞るために有効です。一方、top 10以上ではEvidence fallbackが効くため、Claimを主経路、Evidenceを再現率補完として使う構成が妥当です。

## 回答品質

| 方式 | 根拠再現率 | 引用再現率 | 回答要素再現率 | 禁止事項誤り率 | Strict Pass |
|---|---:|---:|---:|---:|---:|
| Raw RAG | 78.8% | 57.6% | **88.6%** | 0.0% | **36.4%** |
| Oracle compiled | 100.0% | 57.6% | 97.7% | 9.1% | 27.3% |
| Actual evidence fallback | 87.9% | 57.6% | 79.5% | 0.0% | **36.4%** |
| Actual Claim baseline | **87.9%** | **71.2%** | **88.6%** | 0.0% | **36.4%** |

Actual Claim baselineは検索と引用を改善しましたが、回答要素とStrict PassではRawを上回りませんでした。Evidence fallbackはtop 5で検索再現率を増やさず、回答要素再現率を下げたため、回答生成の既定値には適しません。

OracleのStrict Passが低いのは、正しい根拠がすべて検索できても、回答モデルが引用を落としたり禁止事項を1問で述べたりしたためです。Strict Passは検索器だけの指標ではありません。

### 質問別に見えた変化

- ActualはDR-004とDR-005で引用を補い、Strict Passを獲得しました。
- DR-006は根拠再現率が0%から100%、DR-007は50%から100%へ改善しました。
- IR-001とIR-003は、Strictには届かないものの回答要素再現率が改善しました。
- DR-001では、正しい根拠を取得していたのに「直接的な記述はない」と回答し、回答要素を失いました。
- MG-001では根拠再現率と引用再現率が下がり、Strict Passを失いました。

差し引きでStrict Passは同率です。検索結果をClaimへ変換した効果は確認できますが、Claimの表現と回答プロンプトの組み合わせが、根拠の意味を弱める場合があります。

## 次に改善する点

1. Claim検索単位に、結論を弱めない短い原文抜粋を常に併記する。
2. 「直接記載があるのに記載なしと答える」失敗を回帰質問として固定する。
3. top 5はClaim中心、top 10以降はEvidence fallbackとし、単純な混在ではなくrerankする。
4. 未解決Conflictを通常Evidenceとは別枠で必ず回答文へ渡す。
5. Medium固有の追加文書を正解に使う質問を増やす。現在の11問はSmall由来であり、規模耐性しか測っていない。
6. 複数seedまたは複数回実行で、LLM抽出と回答採点の信頼区間を出す。

## 再実行

検索アブレーション:

```powershell
node tests/benchmarks/rag-comparison/run-ablation.mjs `
  --corpus tests/corpora/aobane-industries-ja-medium `
  --intent design-review `
  --intent incident-response `
  --compiled-build target/medium-builds-v1/design-review `
  --compiled-build target/medium-builds-v1/incident-response `
  --output target/benchmarks/medium-rag-ablation-v1/retrieval-ablation.json
```

回答比較:

```powershell
node tests/benchmarks/rag-comparison/run-upper-bound.mjs `
  --corpus tests/corpora/aobane-industries-ja-medium `
  --intent design-review `
  --intent incident-response `
  --compiled-build target/medium-builds-v1/design-review `
  --compiled-build target/medium-builds-v1/incident-response `
  --actual-variant baseline `
  --top-k 5 `
  --model gemma4:latest `
  --output target/benchmarks/medium-rag-answer-baseline-v1
```
