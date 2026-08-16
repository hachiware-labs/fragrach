<p align="center">
  <img src="../assets/fragrach-logo-answerer.png" alt="Fragrach — The Answerer" width="360">
</p>

# Fragrach Soft Rerank v1

Fragrachライブラリの標準rerankは`fragrach-soft-rerank-v1`である。Hybrid検索が返した上位20文書を入力とし、候補を追加・削除せず、Decision Packetの文書roleで提示順だけを変える。`fragarach-resolver`の`rerank`はこのv1アルゴリズムを呼び出す。

調整順位は次の式で計算する。順位は1始まりで、小さい値を先に置く。同じ調整順位になった文書は、元の検索順位を維持する。

```text
adjusted_rank = original_rank + role_offset
```

| role | offset |
|---|---:|
| `governing` | -4 |
| `verifier` | -2 |
| roleなし | 0 |
| `contender` | +2 |
| `excluded` | +6 |

一つの文書が複数roleに現れる場合は、`excluded`、`contender`、`verifier`、`governing`の順で一つを選ぶ。この優先順は`primary_role`として公開している。

## Rust API

既定の`rerank`へ、検索順の候補と各候補のroleを返す関数を渡す。入力が20件を超える場合、候補を黙って切り捨てず`RerankError::CandidateLimitExceeded`を返す。

```rust
use fragarach_resolver::{RerankRole, rerank};

#[derive(Debug)]
struct Candidate {
    document_id: String,
    role: Option<RerankRole>,
}

let candidates = vec![
    Candidate {
        document_id: "policy-v1".into(),
        role: Some(RerankRole::Excluded),
    },
    Candidate {
        document_id: "policy-v2".into(),
        role: Some(RerankRole::Governing),
    },
];

let reranked = rerank(candidates, |candidate| candidate.role.clone())
    .expect("Hybrid候補は20件以内");

assert_eq!(reranked[0].document_id, "policy-v2");
```

アルゴリズムを明示的に固定する利用者は`soft_rerank_v1`を呼び出せる。将来、標準方式を変更するときは既存関数の意味を変えず、先に版付きの新関数として追加する。

## 境界

このrerankerは文書順だけを決める。回答時にFragrachメタデータを添える処理と、選ばれた文書からSparse／Dense双方のチャンクを再展開する処理は別段階である。`excluded`はFragrachがコンパイルした文書roleであり、評価用DVAAのharmful正解ラベルではない。

Knowledge Buildの`retrieval-profile.yaml`にも、アルゴリズム名、候補上限、offset、候補集合不変、同順位時の規則を書き出す。Rust以外のRAGアダプターはこの設定を同じ意味で実装できる。
