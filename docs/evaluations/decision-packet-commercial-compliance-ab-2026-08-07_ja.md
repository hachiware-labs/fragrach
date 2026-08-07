# Decision Packet契約判断統合A/B（2026-08-07）

## 結論

Decision Packetの直下属性を`id`、`intent_id`、`purpose`、`materials`の4個に固定したまま、`commercial_compliance`で分断されていた基本契約、個別契約、未署名提案を一つの契約判断へ統合した。

最終方式を既存24部門・用途、288文書、144問へ逆適用した結果、Packet R@5は84.1%から85.6%、Complete@5は66.7%から70.1%へ改善した。R@10、Complete@10、Relation Path@5、Path@10は維持され、24組を個別に比較してもR@5、R@10、Complete@5、Complete@10、Path@5、Path@10の低下は0件だった。

したがって、Packetの4属性契約は変更せず、次の二つを固定規則とする。

1. 契約優先関係では、Relation種別だけでなく明示された`source_clauses`と`target_clauses`をEvidence選択へ使う。
2. `proposes_change_to`の未署名提案と、同じ基準文書・互換scopeを持つ契約優先関係を一つのPacketへ統合する。

## 原因

追加評価の`commercial_compliance`はRelation Path@5が100%である一方、Complete@5が45.8%だった。Relation欠落ではなく、次の二つが原因だった。

- 小売・サプライチェーンでは、個別契約から基本契約への優先関係3本が`order_of_precedence`ではなく`applies_to`として抽出された。両端のclauseは`優先`、`優先順位`を保持していたが、Relation種別中心のEvidence選択では基本契約の優先順位をPacketへ入れられなかった。
- 未署名提案の質問に必要なEvidenceはProposalの契約状態・適用可否と、SOWの現行個別条件にまたがる。従来は`Proposal → Master`と`SOW → Master`が別Packetになり、top-5で同時に取得できる場合にしかCompleteにならなかった。

直下属性の不足ではなく、既存属性へ材料を落とす選択規則とPacket境界の問題だった。

## A: 契約優先clauseを使うEvidence選択

Relationが契約優先を表す場合だけ、各endpointに明示されたclauseと一致するEvidenceを優先する。`order_of_precedence`はそのまま認識し、分類が揺れた場合も`position=conditional`かつclauseに`優先`、`precedence`、`priority`があれば契約優先として扱う。

対象4部門・24問の結果は次のとおりだった。

| 指標 | Baseline | A | 差 |
|---|---:|---:|---:|
| R@5 | 77.1% | 83.3% | +6.3pt |
| R@10 | 87.5% | 87.5% | 0pt |
| Complete@5 | 45.8% | 58.3% | +12.5pt |
| Complete@10 | 66.7% | 66.7% | 0pt |

小売・サプライチェーンの適用条件3問がすべて回復し、他3部門は不変だった。

## B: 同一契約判断のPacket統合

次の全条件を満たす二つのPacketだけを統合する。

- 一方が`proposes_change_to`かつ`non_effective`の除外提案である。
- もう一方が`order_of_precedence`、または明示clauseから契約優先と判定できる。
- 同じ`governing` materialを共有する。
- 同じsourceに異なるmaterial roleを割り当てない。
- Relation scopeが同値、または一方が他方の厳密な具体化である。

統合後も新しい属性は追加しない。`purpose.relation_ids`に両Relationを保持し、`materials`にSOW、Master、Proposalを置き、Proposalを`excluded`とする。

| 指標 | Baseline | A+B | 差 |
|---|---:|---:|---:|
| R@5 | 77.1% | 86.1% | +9.0pt |
| R@10 | 87.5% | 87.5% | 0pt |
| Complete@5 | 45.8% | 66.7% | +20.8pt |
| Complete@10 | 66.7% | 66.7% | 0pt |

4部門のPacket数は26から15へ減った。

## 統合条件の縮約

探索中、Bを「除外materialと基準materialを共有する全Packet」へ適用すると、契約以外のtechnical specificationとgovernanceで局所回帰が起きた。そのため、永続化属性を増やすのではなく、統合条件を`proposes_change_to`と契約優先関係の組へ縮約した。

同様に、Aのclause加点を全Relationへ適用すると、契約以外のEvidence順序を変える回帰が残った。最終方式では契約優先関係だけに限定している。

## 既存24組への回帰

比較対象は、前回12組の現行再コンパイル結果と追加12組の最終結果である。保存済みProfile、Relation、Claimを現行コードで再コンパイルしたため、LLM呼び出しは0回だった。

| 指標 | Baseline | 最終方式 | 差 |
|---|---:|---:|---:|
| Packet R@5 | 84.1% | 85.6% | +1.5pt |
| Packet R@10 | 89.5% | 89.5% | 0pt |
| Packet Complete@5 | 66.7% | 70.1% | +3.5pt |
| Packet Complete@10 | 76.4% | 76.4% | 0pt |
| Packet Path@5 | 96.2% | 96.2% | 0pt |
| Packet Path@10 | 99.3% | 99.3% | 0pt |

| Artifact | 結果 |
|---|---:|
| 部門・用途 | 24 |
| 文書 | 288 |
| 質問 | 144 |
| Packet | 154 |
| Packet bytes | 73,141 |
| Packet直下属性不一致 | 0 / 154 |
| LLM呼び出し | 0 |
| error | 0 |
| 個別指標の低下 | 0 |

Packet数は168から154、保存量は76,879 bytesから73,141 bytesへ減った。

## 判断

今回の失点は4属性契約の不足ではなく、契約優先Evidenceの選び方と、同じ契約判断をRelation単位へ細分化していたことに起因した。限定した二規則でComplete@5を改善し、既存24組の回帰もなく、Packet数と保存量も減ったため、このPacket方式を固定する。

以後の未使用データ評価ではPacket属性を増やさず、同じ4属性と統合規則を維持する。新しいデータで失点が出た場合も、まず既存のRelation、scope、material role、Evidence選択で説明できるかを確認する。

## 検証

- `cargo test --workspace`
- `npm test`
- `cargo fmt --all -- --check`
- `git diff --check`

