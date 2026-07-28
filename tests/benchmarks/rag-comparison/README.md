# Raw RAGとFragrachの比較評価

このベンチマークは、同じSource Corpusから作った通常のRAGとFragrach経由のRAGを、同じ質問と正解根拠で比較する。検索方式やモデルの差ではなく、RAGへ投入する知識をコンパイルした効果を測ることが目的である。

## 比較する三つの系統

| 系統 | 索引へ入れる内容 | 確認する効果 |
|---|---|---|
| `raw-rag` | `sources/`の文書を通常どおり分割したチャンク | 比較の基準値 |
| `compiled-data` | Fragrachが生成したClaim、Evidence、Conflict | 投入データを改善した効果 |
| `full-fragarach` | `compiled-data`にRetrieval ProfileとAnswer Contractを適用 | Fragrach全体の効果 |

`raw-rag`と`compiled-data`では、Embeddingモデル、Vector Store、生成LLM、検索件数、温度、最大出力Tokenを同じにする。`full-fragarach`だけは、Fragrachが生成した検索・回答仕様を使うため、設定差を含む製品全体の評価となる。

索引対象はコーパスの`sources/`だけである。`evaluation/`、`ground-truth/`、`intents/`、`scenarios/`を索引へ入れると正解が漏れるため、入力してはならない。

## 一件の評価結果

各系統は、一質問につき一行のJSONLを出力する。`question_id`はコーパスの`evaluation/questions.jsonl`と対応させる。

```json
{
  "question_id": "DR-001",
  "answer": "外部仕様に影響するため、実装前の設計レビューが必要です。",
  "retrieved_evidence": [
    {
      "source": "sources/20-quality-assurance/standards/design-review-standard-v2.md",
      "section": "レビューが必要な変更",
      "rank": 1
    }
  ],
  "citations": [
    {
      "source": "sources/20-quality-assurance/standards/design-review-standard-v2.md",
      "section": "レビューが必要な変更"
    }
  ],
  "behavior": "answer",
  "judgment": {
    "satisfied_answer_elements": [
      "外部仕様に影響する変更",
      "実装開始前に設計レビューが必要"
    ],
    "present_forbidden_answer_elements": [],
    "unsupported_citations": []
  },
  "usage": {
    "input_tokens": 1400,
    "output_tokens": 90,
    "latency_ms": 850
  }
}
```

`retrieved_evidence`は検索器が返した順序を`rank`で記録する。`citations`には最終回答が実際に根拠として示した箇所を入れる。パスはコーパスを起点とする`/`区切りの相対パスに統一する。

`judgment`は回答生成とは別の判定処理が付与する。判定時には系統名を隠し、同じモデル、プロンプト、温度を使用する。人手で判定する場合も、`questions.jsonl`にある期待要素のうち満たしたものと、実際に現れた禁止要素だけを記録する。`judgment`を省略した場合、評価器は単純な部分文字列一致へ切り替わるため、言い換えを含む本評価には適さない。

## 集計

三つの結果が揃ったら、次のように実行する。

```powershell
node tests/benchmarks/rag-comparison/evaluate.mjs `
  --run raw-rag=artifacts/raw-rag.jsonl `
  --run compiled-data=artifacts/compiled-data.jsonl `
  --run full-fragarach=artifacts/full-fragarach.jsonl `
  --top-k 5 `
  --json-out artifacts/comparison-report.json
```

評価器は次の値を系統別に集計する。

- `evidence_recall_at_k`: 上位k件に正解根拠が含まれた割合
- `citation_recall`: 最終回答が正解根拠を引用した割合
- `answer_element_recall`: 必須回答要素を満たした割合
- `behavior_accuracy`: 回答、競合開示、時点解決、情報不足の動作が期待と一致した割合
- `forbidden_error_rate`: 禁止された誤答を一つ以上含んだ質問の割合
- `unsupported_citation_error_rate`: 根拠にならない引用を含んだ質問の割合
- `strict_pass_rate`: 必須要素、根拠取得、引用、期待動作をすべて満たし、禁止誤答と不正な引用がない質問の割合

品質指標は全質問の平均として計算し、Tokenと応答時間は別に表示する。費用や速度を品質点へ混ぜないことで、品質向上と運用コストの交換条件を確認できる。

## 実行順序

最初に各系統で固定質問すべてを実行し、回答、検索結果、引用、利用量を保存する。次に、回答生成とは独立した判定処理で`judgment`を付ける。最後にこの評価器で集計し、Intent別およびタグ別のStrict Pass率を確認する。

LLMの揺らぎを測る場合は、同じ条件で複数回実行し、一回ごとに別の結果ファイルを作る。比較の初期段階では、まず一回の実行で契約と失敗分類が正しく機能することを確認してから反復回数を増やす。

このディレクトリの評価器は、結果の検証と集計だけを担当する。Embedding、Vector Store、回答生成、LLM判定の実装は、各系統のアダプター側で行う。

## コンセプトの上限実験

Fragrach本体のClaim抽出が完成する前に、コンパイル済み知識の改善余地を確認する場合は、Oracle Compiled実験を使う。

```powershell
node tests/benchmarks/rag-comparison/run-upper-bound.mjs `
  --model gemma4:latest `
  --top-k 5
```

この実験では、`raw-rag`がSource文書の段落を直接検索し、`oracle-compiled`が`ground-truth/expected.json`のClaim、Conflict、Alias、Version Group、Event Sequence、Missing Informationを検索する。検索器は両者とも日本語文字n-gramを使う同一のBM25で、回答と判定には同じローカルOllamaモデルを使う。

Oracleは実装済みFragrachの精度を表さない。正しく知識をコンパイルできた場合の上限を測り、通常RAGに対して改善余地があるかを確認するための実験である。Oracleでも差が出ない場合は、コーパス、質問、検索単位、製品コンセプトのいずれかを見直す。差が出た場合は、その差を実際のコンパイラがどこまで再現できるかを次の評価対象にする。

結果は既定で`target/benchmarks/rag-comparison/`へ保存される。

2026年7月27日に実施した一回目の結果と判定上の注意は、`UPPER_BOUND_FINDINGS_ja.md`に記録している。
