# Metadataコンパイル増分評価（2026-08-06）

## 評価の目的

現行のFragrachが、企業文書のDocument ProfileとRelationをどこまで原文からコンパイルできるかを確認した。今回の結果は検索・回答品質やVanilla RAGとの比較ではなく、Knowledge Buildを作る段階だけの評価である。

評価前の方式はコミット`61ac59b`として固定した。その後、承認関係を表現できない問題と、古いFAQの矛盾関係が安定しない問題を修正し、同じ12文書を再評価した。続いて、データを一度に広げず、同じ部門のplanningとoperationsを12文書ずつ追加した。さらに、業界と部門を跨いだ再現性を見るため、医療・品質薬事部のgovernanceとoperationsを24文書追加した。Relation coverage passの実装後は、金融・コンプライアンス部、ソフトウェア・セキュリティ部、エネルギー・系統運用部のoperationsを12文書ずつfresh実行した。最後に、operations以外へ用途を広げ、小売・店舗運営部のgovernanceと物流・通関部のtechnical_specを追加した。

## 対象と条件

対象は`fragrach-enterprise-ja-diverse`の7業界・7部門である。ProviderはCodex App Server、モデルは`gpt-5.6-luna`、reasoning effortは`low`、対象日は2026-07-15とした。各fresh実行では12文書のClaim抽出と、12文書をまとめたProfile・Relation抽出を新規に行った。

| 部門・用途 | 異なる文書数 | Gold Relation | 独立LLM応答 | 公開Build |
|---|---:|---:|---:|---:|
| 製品設計・governance | 12 | 9 | 2 | 2 |
| 製品設計・planning | 12 | 9 | 1 | 1 |
| 製品設計・operations | 12 | 9 | 2 | 2 |
| 品質薬事・governance | 12 | 9 | 1 | 1 |
| 品質薬事・operations | 12 | 9 | 4 | 4 |
| 金融コンプライアンス・operations | 12 | 9 | 1 | 1 |
| ソフトウェアセキュリティ・operations | 12 | 9 | 1 | 1 |
| エネルギー系統運用・operations | 12 | 9 | 1 | 1 |
| 店舗運営・governance | 12 | 9 | 1 | 1 |
| 物流通関・technical_spec | 12 | 9 | 2 | 2 |
| 合計 | 120 | 90 | 16 | 16 |

したがって、現時点で確認した範囲は120文書、7業界・7部門、4用途に限られる。製品設計のgovernanceとplanningは抽出契約v4、製品設計のoperationsと品質薬事の2用途はv5で測定しており、単一契約版の全体性能を示す集計ではない。品質薬事operationsの4応答はすべて初回compileでProfile、Relation、Claimを保存したが、未解決Conflictを許可しないIntentの公開条件を満たさなかった。その後、Conflict解析とRelation coverage passを修正し、LLMを再実行しないrecompileで4応答とも公開できた。追加した3部門はコミット`44e2086`の現行compileでfresh抽出し、その後にexecution relation familyの補完だけをrecompileで検証した。物流通関の2応答は、`proposes_change_to`追加前と追加後の独立したProfile・Relation抽出である。表の公開Buildは、これらの現行コードによる再コンパイル結果を含む。

## governanceの結果

Relation IRへ`approves`を追加し、承認と実行記録を分離した。また、Relationの端点に一意な管理文書番号が返った場合だけ、対応する`source_id`へ正規化するようにした。古いcommunicationと現行normativeの非有効関係については、両端に同じ単一値predicateの異なるClaimがある場合だけ`conflicts_with`へ精緻化する。

修正後は、二つの独立したLLM応答のどちらでもGold 9本をすべて回収した。内訳は`supersedes` 3本、`conflicts_with` 3本、`approves` 3本である。各実行にはGold外の`order_of_precedence`が1本あり、Goldを完全な正例集合とみなした場合のRelation precisionは90%、recallは100%となる。fresh実行では12 Profile、10 Relation、40 Claimを生成し、Profile・Relation診断は0件だった。

修正前の固定版では、各実行の厳密一致は4/9だった。ただし、当時のIRには`approves`が存在しなかったため、この数値は抽出器だけの性能ではなく、表現力不足を含む。

## planningで見つかった境界

planningのfresh実行では12 Profile、5 Relation、38 Claimを生成した。front matterの`decision_minutes`と`options_analysis`が型表に登録されておらず、それぞれ`reference`へ落ちていたため、前者を`record`、後者を`analysis`へ修正した。

一方、planningのGold Relation 9本は、現状のまま一つの精度値へまとめるべきではない。

- `evaluates` 3本と`implements_decision` 3本は、現在のRelation IRに対応する型がない。
- `approves` 3本はIRで表現できるが、決定議事録は採用方式を述べるだけで、承認対象となる計画文書を管理文書番号などで特定していない。計画側も承認済みであることは示すが、どの議事録が承認したかを特定していない。
- 抽出器はこの条件で`approves`を出さず、提案と現行計画の不一致を表す関係を出した。この挙動は、原文にない端点を推測しないという抽出契約とは整合する。

このため、planningの0/9をそのまま実装精度と解釈することはできない。6本は語彙未対応、3本はGoldと原文の対応を先に監査する必要がある。

## operationsで確認した再現性

operationsのGold 9本は、`applies_to`、`exception_to`、`records_execution_of`が各3本で、いずれも現行IRで表現できる。初回のv4実行では、front matterの`operating_procedure`、`work_instruction`、`temporary_deviation`が`reference`へ落ち、Gold一致は`exception_to` 3本だけだった。

そこで3種類を`instruction`へ対応づけ、抽出契約v5で各Relationの成立条件を明示した。v5の二回のfresh実行は、Profile 12件のroleをすべて正しくコンパイルし、質問が要求する`exception_to`も両方3/3だった。一方、コーパス全体のGoldに対する結果は一致しなかった。

| operations実行 | 初回Gold一致 | 現行Gold一致 | 現行出力Relation | 現行precision | 現行recall |
|---|---:|---:|---:|---:|---:|
| v4初回 | 3/9 | 5/9 | 10 | 50.0% | 55.6% |
| v5 fresh 1 | 5/9 | 7/9 | 9 | 77.8% | 77.8% |
| v5 fresh 2 | 9/9 | 9/9 | 9 | 100% | 100% |

v5の一回目は`records_execution_of`を2/3抽出し、`applies_to`は0/3だった。代わりに、本文が明示する`order_of_precedence`を2本出した。現行のcoverage passは、この優先関係を削除せず、両端が承認済みInstruction、権限が下位から上位、source scopeがtarget scopeの厳密な細分化、source側Evidenceがある、という条件をすべて満たす場合だけ`applies_to`も補完する。この再コンパイルによりv5の一回目は7/9まで改善した。v4の保存Profileもfront matterを現行規則で再適用してroleを直したため、3/9から5/9になった。v5の二回目は3種類を各3本抽出しており、補完による変更はなかった。

これらは保存済みLLM応答を現行の決定的処理へ通した結果であり、fresh抽出自体が安定したことを示さない。同じ入力と設定で生のRelation列挙が揺れる問題は残るが、二つの部門で同じ限定条件の補完が働き、正しいRelationを失う退行は確認されなかった。

## 品質薬事部へ広げた結果

品質薬事部のgovernance 12文書では、12 Profile、8 Relation、41 Claimを生成し、Gold 7/9と一致した。`supersedes`と`approves`は各3/3だったが、FAQから現行規程への`conflicts_with`は1/3に留まった。Gold外では旧版規程から現行規程への`conflicts_with`を1本生成した。Goldを完全な正例集合とみなしたprecisionは87.5%、recallは77.8%である。質問が要求する6本に限ると、`supersedes` 3本と`conflicts_with` 1本の計4/6だった。製品設計部で得たgovernanceの90% / 100%は、部門を跨いでそのまま再現しなかった。

品質薬事部のoperationsは、同一条件で2回fresh実行した。いずれも12 Profileを保存し、Gold一致は7/9だったが、出力数と誤った端点が異なった。

| operations実行 | Gold一致 | 出力Relation | precision | recall | 未解決Conflict | 公開結果 |
|---|---:|---:|---:|---:|---:|---|
| 品質薬事 fresh 1 | 7/9 | 8 | 87.5% | 77.8% | 5 | 失敗 |
| 品質薬事 fresh 2 | 7/9 | 10 | 70.0% | 77.8% | 2 | 失敗 |

両実行とも`applies_to`は3/3、質問が要求する`exception_to`は2/3、`records_execution_of`は2/3だった。S1のLOGについては、Providerが16桁の`source_id`から末尾1文字を落としたためProfileがfallbackとなり、LOGから例外指示へのRelationも端点不正で棄却された。別の`exception_to`は、fresh 1ではS3の例外指示がS2の手順を指し、fresh 2ではS2の例外指示が手順ではなく現場指示を指した。

最初の2応答では、Relation精度とは別の公開失敗も起きた。同じS1内で、通常手順の「一営業日以内」と期限付き例外の「二時間以内」が異なるClaimとして抽出され、`exception_to` Relationも存在していた。しかし、修正前のClaim Conflict解析は適用期間、状態、宣言済み権威順だけを使い、Document Relationを参照していなかった。このため正当な期限付き例外を未解決Conflictと判定し、`unresolved_conflicts_allowed: false`の公開条件により両Buildが失敗した。データ拡張によって、Relationを抽出するだけでなくConflict解決へ接続する必要が明確になった。

## 例外関係をConflict解決へ接続した結果

Conflict解析を修正し、基準日時点で有効な`exception_to`の両端がClaimのEvidence sourceと一致する場合だけ、例外側を明示的なoverrideとして解決するようにした。同じscopeで同じ手順へ`applies_to`する現場指示にもこの判断を伝播する。Profileが`record`である文書と、`records_execution_of`のsourceは非規範として扱い、実施結果を新しい規則にしない。期限付きRelationに基準日がない場合、期限外、端点不一致、scope不一致では従来どおり未解決に残す。

加えて、同じsourceが異なる明示条件で示す期限は条件分岐として保持し、一桁の漢数字と算用数字だけが異なる値は同値とみなす。これにより、対象内の「二時間以内」と対象外の「一営業日以内」、および「一営業日以内」と「1営業日以内」を偽のConflictにしない。

この修正で、先の品質薬事operations 2応答は、LLM呼び出し0のrecompileにより未解決Conflictがそれぞれ5→0、2→0となり、どちらも`completed_with_warnings`で公開できた。Relation精度そのものは7/9のままであり、Conflict解決の改善とRelation抽出精度は分けて評価する必要がある。

修正中と修正後に、同じ12文書をさらに2回fresh実行した。

| 追加operations実行 | Gold一致 | 出力Relation | precision | recall | 初回未解決Conflict | 現行コードでの公開 |
|---|---:|---:|---:|---:|---:|---|
| 品質薬事 fresh 3 | 8/9 | 8 | 100% | 88.9% | 2 | recompileで成功 |
| 品質薬事 fresh 4 | 8/9 | 11 | 72.7% | 88.9% | 2 | recompileで成功 |

fresh 3は`exception_to`と`applies_to`を各3/3、`records_execution_of`を2/3抽出した。初回compile後に条件分岐と数字表記の規則を追加したため、保存済み応答をrecompileし、未解決Conflict 2→0で公開できた。

fresh 4の生応答は、質問必須の`exception_to`を3/3、`records_execution_of`を2/3抽出したが、`applies_to`は0/3だった。代わりに現場指示から手順への`order_of_precedence`を3本出した。coverage passで前節と同じ限定条件を検証すると、3組とも適用関係を併存できると判断でき、Gold一致は5/9から8/9になった。元の優先関係3本は原文根拠があるため保持しており、Goldを完全な正例集合としたprecisionは72.7%となる。

この補完後も、全社手順の「一営業日以内」と現場指示の「受付後一営業日以内」を異なる期限とみなす偽Conflictが1件残った。そこで、期限値を起点文言から切り離し、数値・単位・上限または下限として正規化した。最終的にfresh 4はLLM呼び出し0のrecompileで未解決Conflict 2→0となり、`completed_with_warnings`で公開できた。

4回の品質薬事operations応答を通じて、質問必須の`exception_to`は2/3、2/3、3/3、3/3と改善した。生応答の全Relation厳密一致は7/9、7/9、8/9、5/9と揺れたが、現行recompileでは最後の応答を8/9まで補完し、4応答すべてを公開できた。正しいRelationを安全に利用する経路と、限定条件下の分類揺れを吸収する経路は改善したが、端点誤りや列挙漏れは補完していない。

## 3業界へoperationsを広げた結果

coverage passの過剰補完を確認するため、既評価部門と離れた金融コンプライアンス、ソフトウェアセキュリティ、エネルギー系統運用で各12文書をfresh実行した。いずれもProfile 12件を生成して公開でき、未解決Conflictは0件だった。

| fresh実行 | 生応答Gold一致 | 現行Gold一致 | 現行出力Relation | 現行precision | 現行recall | coverage追加 |
|---|---:|---:|---:|---:|---:|---:|
| 金融コンプライアンス | 8/9 | 9/9 | 14 | 64.3% | 100% | 1 |
| ソフトウェアセキュリティ | 9/9 | 9/9 | 12 | 75.0% | 100% | 0 |
| エネルギー系統運用 | 9/9 | 9/9 | 12 | 75.0% | 100% | 0 |

3応答とも`applies_to`と`exception_to`を各3/3抽出した。`records_execution_of`はソフトウェアとエネルギーで3/3、金融で2/3だった。金融のS3実施記録は、同じ実行内のS2と異なり、`records_execution_of`ではなく`non_effective operational_position`だけを返した。この分類揺れに対し、sourceがfront matter上の`execution_log`かつ公式Record、targetが承認済み`temporary_deviation`、両Profileのscopeが一致し、source側Evidenceで接地された非有効Positionである場合だけ、`records_execution_of`を併存させる補完を追加した。補完した1件はGoldと一致し、金融のrecallは88.9%から100%になった。

ソフトウェアとエネルギーでは、必要なRelationがすでに揃っていたためcoverage passは発火しなかった。36文書を通じた追加は正例1件だけで、観測範囲内の誤補完は0件である。ただし、実際の発火数が1件にすぎないため、execution補完のprecisionを一般化できる規模ではない。Gold外のRelationは、各応答の`order_of_precedence` 3件に加え、金融で`operational_position` 2件が残った。これらは原文根拠があるため削除しておらず、Goldを完全な正例集合とみなしたprecisionがrecallより低い主因になっている。

## governanceとtechnical_specへ用途を広げた結果

小売・店舗運営部のgovernanceは、12 Profile、9 Relation、40 Claimを生成した。Gold 9本と出力9本がすべて一致し、precisionとrecallはともに100%だった。Relation coverage passの追加は0件、未解決Conflictと警告も0件である。少なくともこの1応答では、operations向けの補完が別用途へ誤発火しなかった。

物流・通関部のtechnical_specでは、最初のfresh実行でGold 9本のうち6本を回収した。`amends`と`records_execution_of`は各3/3だったが、未承認の第4版案から現行第3版への`proposes_change_to`をIRで表現できず、3本すべて欠落した。代わりに、承認済み追補から現行仕様への`conflicts_with`を3本余分に出したため、出力9本に対するprecisionとrecallはともに66.7%だった。また、`technical_specification`、`specification_amendment`、`technical_draft`が文書型表になく、Profile roleが`reference`へ落ちていた。

原文を監査すると、第4版案は現行値と次期候補を区別し、未承認で運用へ適用してはならないことを明記していた。この関係は既存の`amends`へ統合すると提案と承認済み変更を区別できないため、IRへ`proposes_change_to`を追加した。抽出条件は、未承認のproposalまたはdraftが、識別できる現行規則・仕様への将来変更を原文で明示する場合に限る。Relationのpositionは`non_effective`とし、提案を現行規則へ昇格させない。

一方、同じ追補・仕様・条項に`amends`と`conflicts_with`が併存する場合は、意図的な承認済み条項変更を二重表現している。そこで、sourceがfront matter上の`specification_amendment`、両端が承認済み、向きと条項が同一という条件をすべて満たす場合だけ、`amends`へ統合して冗長な競合を除く。別条項、別端点、一般文書間の競合は残す。

抽出契約を更新して同じ12文書をfresh実行した結果、`amends`、`records_execution_of`、`proposes_change_to`を各3本抽出し、Gold 9/9、出力9本、precision 100%、recall 100%となった。coverage追加と競合統合の発火は0件であり、今回の9本はすべてモデルが原文から抽出した。Profile roleも仕様と追補が`normative`、第4版案が`proposal`になった。

Claim層では、正しい`amends`が存在しても旧仕様と追補の値を未解決とする1件と、未承認案の比較候補を統治上の競合とする1件が残った。Conflict解析をRelation群へ接続し、基準日時点で有効かつ同じ条項を指す`amends`だけを明示overrideとして扱った。また、未承認proposalだけに由来する候補値は現行規則を変えないため、統治上の未解決Conflictから除外した。LLMを再実行しないrecompileで未解決Conflictは2→0、警告は2→0となり、12文書、40 Claim、9 RelationのBuildは`completed`になった。

追加前の保存応答も現行コードで再コンパイルした。欠落した提案関係は推測補完しないためGold一致は6/9のままだが、同一条項の冗長な`conflicts_with` 3本は除かれ、出力6本、未解決Conflict 0、警告0になった。さらに、technical_spec以外の保存済み15 Buildを再コンパイルしたところ、`document-relations.jsonl`のSHA-256は15件すべて入力Buildと一致した。今回の競合統合が既評価用途へ発火した例はない。

## 現時点の判断

製品設計部のgovernance 12文書では、今回の修正により既知のRelation欠落を再現可能な形で解消した。operationsのcoverage passは製品設計と品質薬事の両方で働き、保存応答の分類揺れを限定条件付きで補完できた。正当な期限付き例外と実施記録を偽の未解決Conflictにする問題も、対象の4応答では解消した。technical_specでは、提案・追補・現行仕様を別のRelationとして表現し、1応答で9/9を得た。一方、品質薬事governanceは7/9に留まり、Relation端点のコピー誤りと列挙漏れも残るため、部門横断の再現率が十分とはいえない。

確認済みデータは120文書まで増えたが、全2,880文書の一部にすぎず、Vanilla RAGを上回ったとは判断できない。今回測ったのもコンパイル段階だけであり、検索順位、必要根拠の回収、最終回答の正しさは別に評価する必要がある。technical_specの100%も1部門・1現行応答の結果であり、用途全体へ一般化できない。

次は、technical_specを別部門へ広げ、`proposes_change_to`の端点精度と、`amends`への競合統合が別の文体でも再現するかを確認する。governanceも小売の1応答だけで判断せず、品質薬事で残った列挙漏れと合わせて部門を増やす。Conflict解決側で曖昧なRelation型を無条件に読み替える方法は採らない。planningについては、Relation型を増やす前にGold Relationが原文から追跡できるよう、文書IDまたは明示的な参照をSourceへ加えるべきかを判断する。

## 実行記録

- governance初回応答と現行コードでの再処理: `target/benchmarks/enterprise-domain-actual/2026-08-06-relation-v4-manufacturing-product-design-governance-luna-v1/knowledge-build-refined-v2/`
- governance fresh再実行: `target/benchmarks/enterprise-domain-actual/2026-08-06-relation-v4-manufacturing-product-design-governance-luna-v2/`
- planning fresh実行と型修正後の再処理: `target/benchmarks/enterprise-domain-actual/2026-08-06-relation-v4-manufacturing-product-design-planning-luna-v1/knowledge-build-refined/`
- operations v4初回と現行recompile: `target/benchmarks/enterprise-domain-actual/2026-08-06-relation-v4-manufacturing-product-design-operations-luna-v1/knowledge-build-recompiled-coverage-v2/`
- operations v5 fresh 1と現行recompile: `target/benchmarks/enterprise-domain-actual/2026-08-06-relation-v5-manufacturing-product-design-operations-luna-v2/knowledge-build-recompiled-coverage-v1/`
- operations v5 fresh 2: `target/benchmarks/enterprise-domain-actual/2026-08-06-relation-v5-manufacturing-product-design-operations-luna-v3/`
- 品質薬事 governance v5 fresh: `target/benchmarks/enterprise-domain-actual/2026-08-06-relation-v5-healthcare-quality-regulatory-governance-luna-v1/`
- 品質薬事 operations v5 fresh 1（failed-build保存）: `target/benchmarks/enterprise-domain-actual/2026-08-06-relation-v5-healthcare-quality-regulatory-operations-luna-v1/`
- 品質薬事 operations v5 fresh 2（failed-build保存）: `target/benchmarks/enterprise-domain-actual/2026-08-06-relation-v5-healthcare-quality-regulatory-operations-luna-v2/`
- 品質薬事 operations v6 fresh 3とrecompile成功: `target/benchmarks/enterprise-domain-actual/2026-08-06-relation-v6-healthcare-quality-regulatory-operations-luna-v3/`
- 品質薬事 operations v6 fresh 4とcoverage pass後のrecompile成功: `target/benchmarks/enterprise-domain-actual/2026-08-06-relation-v6-healthcare-quality-regulatory-operations-luna-v4/knowledge-build-recompiled-coverage-v2/`
- 金融コンプライアンス operations fresh実行とrelation family補完: `target/benchmarks/enterprise-domain-actual/2026-08-06-44e2086-finance-compliance-operations-luna-v1/knowledge-build-recompiled-relation-family-v1/`
- ソフトウェアセキュリティ operations fresh実行と非退行確認: `target/benchmarks/enterprise-domain-actual/2026-08-06-44e2086-software-security-operations-luna-v1/knowledge-build-recompiled-relation-family-v1/`
- エネルギー系統運用 operations fresh実行と非退行確認: `target/benchmarks/enterprise-domain-actual/2026-08-06-44e2086-energy-grid-operations-operations-luna-v1/knowledge-build-recompiled-relation-family-v1/`
- 店舗運営 governance fresh実行: `target/benchmarks/enterprise-domain-actual/2026-08-06-6f159ce-retail-store-operations-governance-luna-v1/knowledge-build/`
- 物流通関 technical_spec追加前のfresh実行と現行コードでの再処理: `target/benchmarks/enterprise-domain-actual/2026-08-06-6f159ce-logistics-customs-technical-spec-luna-v1/knowledge-build-old-response-current-code/`
- 物流通関 technical_spec現行fresh実行とConflict再処理: `target/benchmarks/enterprise-domain-actual/2026-08-06-6f159ce-logistics-customs-technical-spec-luna-v1/knowledge-build-relation-family-v2-current/`
