# 青羽精機 Dynamic Validity Benchmark

企業文書が追加されたとき、初回調整済みのVanilla Hybrid RAGとFragrachの差を、Recall@kとDVAAで比較する二段階コーパスである。

- `T0`: 初期文書集合。Vanillaのchunking、BM25、Dense、fusionを開発質問で調整する。
- `T1`: 新版、例外、追補、draft、同格Conflict、管理外copy、文書管理台帳、変更承認台帳を追加する。旧文書は削除しない。
- `evaluation/questions.jsonl`: 同じ質問に対するT0/T1の回答Gold、Recall Gold、DVAA Gold。
- `gold/profiles.jsonl`: DVAAの`T/S/P/A`を採点するための文書Profile。
- `gold/relations.jsonl`: DVAA-Fullの文書構成を検証するRelation。

質問の`split=development`だけを条件選択へ使い、`holdout`は最終比較まで使用しない。`V-Frozen/T1`はT0で選んだ設定を固定し、新文書を索引へ追加するだけとする。`V-Retuned/T1`はT1の開発質問で再調整する。

このコーパスはValidity Challenge trackであり、実運用上の質問頻度を再現するものではない。差が確認できた後、Production-weighted trackを別に作る。

現在のpilotは27文書、16質問で、開発8問とholdout 8問に分けている。答えを含む規範本文と、その版や変更要求の効力を確定する管理台帳が別文書にあるケースを含むため、答えの文書だけを取得するRecall@kと、有効な根拠集合を要求するDVAA-Fullを分離して検証できる。
