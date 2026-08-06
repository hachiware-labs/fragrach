# Decision Packetデータ拡張評価 2（2026-08-06）

## 結論

Decision Packetの直下属性を`id`、`intent_id`、`purpose`、`materials`の4個に固定したまま、SRE部の`incident_change`と、金融コンプライアンス部の`commercial_compliance`へ評価を広げた。

`incident_change`は2026-08-02の保存済みLuna抽出を現行コードで再コンパイルした。縮約版は旧Relation Dossierより88.1%小さく、決定的検索では旧版を下回らなかった。

`commercial_compliance`には過去Buildが存在しなかったため、12文書を現行コードと`gpt-5.6-luna`でfresh抽出した。これにより、古いコンパイルを流用していない現行方式の評価対象が一つ増えた。fresh応答が取りこぼした未署名提案のRelationは、文書型の別名を契約概念へ統合し、明示された契約状態とscopeから再コンパイル時に補完した。Packet属性は増やしていない。

## 対象とコンパイル条件

| 部門・用途 | 抽出 | 文書 | Evidence | 有効Claim | Relation / Packet | LLM呼び出し |
|---|---|---:|---:|---:|---:|---:|
| ソフトウェア・SRE / incident_change | 2026-08-02保存結果を現行recompile | 12 | 144 | 54 | 6 | 0 |
| 金融・コンプライアンス / commercial_compliance | 現行fresh抽出 | 12 | 144 | 40 | 9 | Claim 12 + Profile 1 |

基準日はどちらも2026-07-15とした。`commercial_compliance`は42 Claim候補のうち2件を未知Evidence参照として棄却し、warning 2件、未解決Conflict 0件で公開した。

## 属性を増やさず統合したもの

### 実施関係

`records_execution_of`のEvidence選択を、実施・適用・完了だけでなく、決定・承認も含む一つの実施状態規則へ戻した。これにより、実施記録と対象変更の承認を同じPacketで取得できる。

### 契約文書型

データセット上の別名を新しい属性にせず、既存の文書役割へ統合した。

| 入力document_type | 統合後の概念・役割 |
|---|---|
| `master_contract`、`master_agreement` | 基本契約 / normative |
| `sow`、`statement_of_work` | 個別契約 / instruction |
| `vendor_proposal` | 未承認提案 / proposal |

### 未署名提案Relation

次の条件をすべて満たす場合だけ、`proposes_change_to`を現行再コンパイルで補完する。

- `vendor_proposal`であり、未承認である
- 本文に契約変更が署名されていないことが明記されている
- 同じ契約scopeに承認済みの基本契約が一意に存在する

Relation根拠には、契約状態だけでなく質問中の提案内容も保持する。これにより、保存属性を増やさずBM25で提案Packetを検索できる。

## incident_change

### 構造

| 指標 | 旧Relation Dossier | 4属性Packet |
|---|---:|---:|
| Unit | 6 | 6 |
| bytes | 23,281 | 2,778 |
| 削減 | - | 88.1% |
| endpoint不一致 | - | 0 / 6 |
| Packet直下属性不一致 | - | 0 / 6 |

36件の旧Evidence参照のうち35件は同一だった。残る1件は、変更理由のEvidenceを、質問へ直接答える変更内容のEvidenceへ置き換えた。検索結果はこの変更後に改善した。

### 決定的検索A/B

| 指標 | 旧Dossier | 4属性Packet | 差 |
|---|---:|---:|---:|
| Compile coverage | 100% | 100% | 0.0pt |
| R@5 | 91.7% | 100% | +8.3pt |
| R@10 | 100% | 100% | 0.0pt |
| Complete@5 | 83.3% | 100% | +16.7pt |
| Complete@10 | 100% | 100% | 0.0pt |
| Relation Path@5 | 100% | 100% | 0.0pt |

初回縮約版は承認Evidenceを落としてR@5 83.3%、R@10 83.3%、Complete@5 66.7%まで低下した。実施状態規則を統合した最終版は上表まで回復した。6問なので改善とは断定せず、非退行gate通過と扱う。

## commercial_compliance

### Relation coverage

fresh LLM応答は、3件の`order_of_precedence`を正しく抽出した一方、正解で必要な3件の`proposes_change_to`を抽出しなかった。代わりに、提案と監査記録の値の差を3件の`conflicts_with`として抽出した。

| 段階 | 必須Relation | Coverage |
|---|---:|---:|
| fresh抽出直後 | 3 / 6 | 50% |
| 契約概念統合後のrecompile | 6 / 6 | 100% |

最終Buildは、必須6 Relationに加え、値の非互換を示す`conflicts_with` 3件を保持する。必須Relationのcoverageは100%だが、Relation全体の厳密precisionを100%と主張するものではない。

### 決定的検索

| 指標 | 用途限定Raw | fresh Packet | 契約概念統合後Packet |
|---|---:|---:|---:|
| Compile coverage | 100% | 100% | 100% |
| R@5 | 36.1% | 77.8% | 88.9% |
| R@10 | 47.2% | 83.3% | 88.9% |
| Complete@5 | 0% | 50.0% | 66.7% |
| Relation Path@5 | 50.0% | 66.7% | 100% |

代表質問では、`proposes_change_to` Packetが10位から1位へ上がった。ただし提案判断Packetと、現行条件を持つ個別契約の優先Packetはまだ別Unitである。このため3シナリオの提案質問のうち2問はtop-5で必要Evidenceを完備しなかった。次の改善候補は属性追加ではなく、同じ契約判断に属するRelation Packetの統合である。

## 回答評価の扱い

6問一括の回答A/Bは、現行Codex CLI readerが補助プロセスを反復し、ローカル`gemma4`も一括実行では上限を超えたため、今回は有効な集計を作れなかった。検索評価と混ぜず、未測定とする。

代表1問だけを`gemma4:latest`のreader/judge、top-k 5で確認した。禁止結論は出ず、Behaviorは100%、回答要素判定は100%だったが、Evidence recallは33.3%、Strict Passは0%だった。回答も「契約義務ではない」と確定せず「未解決」と弱く表現した。したがって、`commercial_compliance`は検索・Relation gateは前進したが、回答gateは未通過である。

## 現時点の判断

- Packet直下は4属性のまま維持できた。
- `incident_change`は縮約による検索低下なしを確認した。
- `commercial_compliance`を現行方式のfresh抽出データとして追加できた。
- 契約文書型の揺れは属性追加ではなく概念統合で吸収できた。
- 未署名提案の必須Relation coverageは50%から100%へ改善した。
- `commercial_compliance`のtop-5回答材料はまだ不十分で、同じ契約判断に属するPacketの統合を次に検証する。

次のデータ追加では、別部門の`commercial_compliance`を同じ規則でfresh抽出し、部門固有語へ過適合していないことを確認する。同時に、同一契約の提案・基本契約・個別契約を属性追加なしで一つの検索判断へ統合できるかをA/Bする。
