# 文書有力度Resolver 回帰・抽出契約監査

実施日: 2026-08-04  
対象: `aobane-industries-ja-validity-holdout`（16文書、20問、10 Relation）

## この評価の位置づけ

この評価では、文書の役割、適用範囲、時点、承認状態と文書間Relationから、各候補を `canonical`、`historical`、`execution_record` などへ分類する処理を検証した。候補文書集合は質問ごとに固定しているため、検索性能や回答生成性能、DVAAは測っていない。これはFragrachの回答経路より上流にある、Position判定の回帰監査である。

ディレクトリ名には `holdout` が含まれるが、この集合は2026-08-01の一般規則改善に使用済みであり、当時の記録にも「今後は開発用集合として扱う」と明記されている。したがって、今回値を未知データへの一般化性能として扱ってはならない。第二ホールドアウトへ進む前に、現在の実装と抽出契約の不整合を発見するために再利用した。

## 固定した条件

Gold Profile / Relationを使う上限測定と、Lunaが原文から抽出したProfile / Relationを使うE2E測定を行った。Luna条件は `gpt-5.6-luna`、reasoning effort `low` である。結果を見てprompt、normalizer、resolver、Goldは変更していない。Scopeの日本語表記は、あらかじめ用意されたNormalization Catalogで正規化した。

実行結果は次のartifactへ保存した。

- Gold上限: `target/benchmarks/document-validity/holdout-oracle.json`
- Luna抽出: `target/benchmarks/document-validity/holdout-profile-codex.json`
- Luna抽出込みE2E: `target/benchmarks/document-validity/holdout-e2e-codex.json`

## 結果

| 入力 | Resolver | Strict case | Decision | Reason | Relation path | Abstention |
|---|---|---:|---:|---:|---:|---:|
| Gold | Relevance only | 0.0% | 14.1% | 0.0% | 0.0% | 0.0% |
| Gold | Weighted metadata | 0.0% | 23.4% | 0.0% | 0.0% | 0.0% |
| Gold | Filter first | 45.0% | 84.4% | 41.7% | 0.0% | 100.0% |
| Gold | Relation graph | **100.0%** | **100.0%** | **100.0%** | **100.0%** | **100.0%** |
| Luna抽出 | Relevance only | 0.0% | 14.1% | 0.0% | 0.0% | 0.0% |
| Luna抽出 | Weighted metadata | 0.0% | 25.0% | 0.0% | 0.0% | 0.0% |
| Luna抽出 | Filter first | 40.0% | 81.3% | 41.7% | 0.0% | 100.0% |
| Luna抽出 | Relation graph | **70.0%** | **95.3%** | **100.0%** | **87.0%** | **100.0%** |

Gold入力で20問すべてに正答したため、現在のresolverにはこの集合を表現できる能力がある。一方、Luna抽出込みでは14問に留まった。失敗6問は独立した6種類の欠陥ではなく、二つの根因が各3問へ波及した結果である。

抽出単体では16文書をすべて構造化でき、Role、Force level、Approval、Scope dimension、Official recordは100%だった。Temporalは93.8%で、事故記録へGoldにない `observed_at` を追加した1件が差となった。RelationはGold 10本に対して11本を出力し、endpoint単位のprecisionは81.8%、recallは90.0%だった。Scope値の文字列一致は30.0%だが、7件の差は「名古屋工場」と `nagoya` のような既知aliasであり、正規化後のE2Eでは18値がcatalogにより解決された。したがって、この30.0%を意味的なScope抽出失敗とは解釈しない。

## 失敗の根因

### 局所規則の合成: Goldにだけある権威順位

`H-LOCAL-01`、`02`、`04`では、全社規程が `canonical` ではなく `reference` になった。Gold Profileは全社規程、日本法人補則、名古屋手順にそれぞれ9、8、7の `authority_rank` を与えている。Luna抽出は8、8、6だったため、同じ `normative` Roleの全社規程と日本法人補則が同順位になり、resolverは検索関連度の高い日本法人補則を初期勝者にした。`applies_to` はsource側を追加で `canonical` にするが、target側の全社規程は昇格させない。この組合せで3問が同じ失敗になった。

ただし、原文front matterには `authority_rank` がなく、抽出評価の対象fieldにも含まれていない。つまり、E2E判定は文書から直接観測できず、抽出精度としても採点していない値に依存していた。これはLunaの単純な抽出誤りではない。Gold作成、抽出契約、resolver入力の三者が一致していない評価設計上の欠陥である。

この監査では凍結条件を守るため、Gold順位の注入やresolver修正による再測定は行っていない。因果帰属は、Profile差分と `filter_first_outcome`、`RelationKind::AppliesTo` の実行経路を照合したコード監査による。

### 実行記録の系譜: 1 Relationの欠落

`H-EXEC-01`、`02`、`03`では、事故記録から上位規程へつながる `records_execution_of` 1本をLunaが抽出しなかった。事故記録自体のDispositionは3問とも正しい `execution_record` で、失敗したのは要求Relation pathだけである。同じ1本の欠落が3問へ現れたため、ケース正答率だけを見ると欠陥数を過大に感じやすい。

したがって、第二ホールドアウトではケース単位の成否に加え、原因となった一意なProfile field差分とRelation欠落数を併記する。質問を増やして同じ関係を繰り返し問うだけでは、仕組みの一般化を測ったことにならない。

## 以前の85%との違い

2026-08-01の記録には、同じ集合のLuna抽出込みStrict caseが85.0%、Decisionが100.0%とある。今回の再実行は70.0%、95.3%だった。保存済みの過去抽出と今回抽出の差に加え、model alias、prompt、schema、normalizer、resolverの実行時同一性をartifactだけから完全には復元できないため、差の一因を断定できない。

この再現性不足自体が次回の要件になる。評価artifactには、モデルの解決済み識別子、promptとschemaのhash、compiler / resolverのcommit、Normalization Catalogのhash、入力文書manifestを保存し、同じ表示名のrunを同一条件とみなさない。

## 第二ホールドアウトへ持ち越す条件

今回の監査から、次の未観測セットでは少なくとも以下を満たす必要がある。

- Goldに使う値は、原文に明示される値、組織が別台帳で管理する値、または事前に固定した決定規則から導く値に限る。`authority_rank` を使うなら、出所と導出規則を明記し、抽出またはlookup精度も評価する。
- Profile / Relation抽出、Position判定、Packet検索、Luna回答を分離して測る。最終結果ではRecall@k、Evidence Ceiling、DVAA-Gross、DVAA-Netへ接続する。
- 文書系列を単位として開発集合とholdoutを分離し、holdout出力を見た後はprompt、normalizer、resolverを変更しない。
- ケース失敗数だけでなく、一意な抽出欠陥数と波及ケース数を残す。
- 背景文書を候補から除外せず、短い合成文書だけに依存しない。明示metadataがない本文からの抽出と、長文中の局所的な改廃も含める。
- Lunaを回答生成、Ruriをembeddingに固定し、run identityをartifactへ保存する。

次の評価対象は、この条件で新規作成するDynamic Validity第二ホールドアウトとする。今回の16文書セットは今後もresolverと抽出契約の回帰試験には使えるが、製品の一般化根拠には戻さない。
