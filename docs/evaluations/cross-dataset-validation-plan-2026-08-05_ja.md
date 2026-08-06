# VersionQA後の外部分布評価計画

## 目的

VersionQAでは、質問相対のVersion／Inventory／Diff PacketによってDVAAを制御できるところまで改善した。しかし、同じ質問を見ながら実装したため、この結果は一般化性能ではない。次は実装とモデル条件を凍結し、性質の異なるMultiHop-RAGとEnterpriseRAG-Benchで、通常RAGから何が変わるかを測る。

比較の中心はこれまでどおりR@k、DVAA-Gross、DVAA-Netとする。R@kはGold文書が検索候補へ入ったかを示す診断値であり、それだけでは複数根拠の完備、矛盾解消、不在証明、回答品質を表せない。DVAA-Grossは全採点対象のうち完全根拠付きで正答した割合、DVAA-Netは完全根拠を用意できた質問のうち正答した割合として読む。

## 固定する条件

EmbeddingはRuri、ReaderとJudgeはLuna、Ollama以外のLLM concurrencyは8に固定する。検索件数はMultiHop-RAGではtop-5、EnterpriseRAG-Benchでは公式条件に合わせてtop-10とする。Query-relative PacketのEvidence Unit契約は固定するが、質問型とadapterはデータセットのGoldを見ず、質問文とSource Corpusだけから作る。外部データ固有のadapterはSource Corpusの形式を共通IRへ写し、Gold回答やGold文書IDを検索・Packet生成へ渡さない。

各データセットでは、開発集合でadapterとGold監査を完了してから実装を凍結し、holdoutを一度だけ実行する。holdout結果を見た後に規則を直した場合、その集合は以後開発用へ降格する。

## MultiHop-RAG：自然文書の時系列multi-hop

[MultiHop-RAG](https://github.com/yixuantt/MultiHop-RAG/)は609件のニュース記事と2,556問を持ち、各質問の根拠が2〜4文書へ分散している。質問はcomparison、inference、temporal、nullに分かれ、各Gold evidenceには記事URL、公開日時、根拠factがある。VersionQAのような明示的な版系列ではなく、独立記事の公開順と複数根拠を扱うため、時間軸の一般化を確認できる。

adapterはURLから安定した`document_id`を作り、`published_at`を時間metadataとして保持する。Gold Evidence Unitは、元データが指定する各記事とfact spanの組にする。全Gold Unitがtop-5資料へ揃わない限りEvidence Ceilingを満たさない。

コーパスは公開日時でT0とT1に分ける。Vanilla Hybridは開発集合でT0を調整し、その重みをT1へ固定適用する条件と、T1で再調整する条件を置く。Fragrachは同じ検索候補から、質問に必要な公開時点と複数記事を不可分なTemporal Evidence Packetへまとめる。まずtemporal質問で時点選択を測り、comparisonとinferenceを対照群、nullを不在証明群として報告する。

## EnterpriseRAG-Bench：規模・矛盾・制約・不在

[EnterpriseRAG-Bench](https://github.com/onyx-dot-app/EnterpriseRAG-Bench)は約50万件の企業内文書を9種類の情報源として模擬し、500問を10分類で提供する。質問にはGold文書ID、期待回答、原子的な`answer_facts`がある。データ生成時に旧情報、near duplicate、競合、誤配置を意図的に加えており、VersionQAにはなかった企業文書のノイズと規模を測れる。

主対象は`conflicting_info` 20問、`constrained` 30問、`completeness` 20問、`info_not_found` 20問とする。`basic`と`semantic`から固定対照群を取り、構造化が単純検索を不必要に悪化させていないかも確認する。Gold Evidence Unitは期待文書内の`answer_facts`を原文spanへ対応づけ、競合質問では採用根拠と除外根拠、不在質問では検索候補が空であることではなく対象範囲の検証済み不在を要求する。

この集合は規模そのものが論点なので、Gold周辺だけを抜いた小さなコーパスを主結果には使わない。最初に質問とmetadataを監査し、配布archiveを段階的に索引化して10万件、25万件、全件で同じVanilla調整値とPacket規則を測る。これにより、文書数増加によるR@kの変化と、完全根拠を一単位にする効果を分けて読める。

## 判断基準

外部分布で期待するのは100%ではない。次の三点が同時に成立すれば、VersionQAで得た改善は特定データへの小細工ではなく、Compilerの一般則として残す価値がある。

- VanillaよりDVAA-Grossが高く、差がR@kの差だけでは説明できない。
- Evidence Ceilingが上がり、DVAA-Netが大きく下がらない。完全根拠を揃える代わりにLunaを混乱させるPacketは採用しない。
- temporal、conflict、completeness、absenceのどこで効き、どこで効かないかをcase-levelで説明できる。

MultiHop-RAGで時間順とmulti-hopに効き、EnterpriseRAG-Benchで競合・制約・規模にも効けば、質問相対PacketをFragrachの中核要件として固定する。一方、一方の集合だけで効く場合は、汎用Packetではなく質問型別Compilerとして境界を明記する。

## 2026年8月5日の到達点

MultiHop-RAGでは凍結方式をuntouched holdoutへ適用し、Raw Hybridに対してEvidence Ceilingを25.0%から30.0%へ改善した。FragrachのDVAA-Grossは26.7%、Netは88.9%だった。効果はcomparisonとtemporalにあり、inferenceは改善しなかった。詳細は[MultiHop-RAG外部分布評価](multihop-rag-external-pilot-2026-08-05_ja.md)に記録した。

EnterpriseRAG-Benchでは全511,962文書をBM25索引化した。開発集合で最良なのはBM25で、BM25 top-50内のRuri候補再順位づけとobligation RRFは採用されなかった。これは全コーパスDenseまたはANNの評価ではない。semanticはdevelopment 25問、diagnostic 25問あり、BM25がGold文書へ到達したのはtop-10で18/50、top-50で23/50だったため、Ruri全件DenseとBM25＋Dense HybridをLanceDBで追加評価する。まず全件フラット検索、その後ANNの順に測り、埋め込み性能と近似損失を分離する。質問型・obligation数・top-10重複率・BM25上位score差を使う従来の選択ゲートは、developmentでの最適解がRRFへ0問を切り替えるBM25固定だった。初回の文書全体token照合には長文中の一般語散在を完全根拠と誤認する欠陥があり、90%の局所照合には正しい局所根拠を落とす偽陰性があったため、Evidence Unitを256 tokenの局所span、Gold原文に実在するexact anchor、Gold span比80%以上のIDF加重coverageで判定する契約へ固定した。

この定義で、固定6位置のdiagnosticはEvidence Ceiling 50.5%、DVAA-Gross 37.4%、Net 73.9%だった。検索1位文書を全文保持し、残りを質問型別に6または10位置へ縮約する`rank1-complex-10`ではEvidence Ceilingが59.3%へ改善し、全文top-10の62.6%との差を3問へ縮めた。しかし、developmentで同じ文字budget以下に調整した質問文だけのVanilla `rank1-7`と同時比較すると、Base ReaderのGrossは両方式39.6%、全条件共通ChecklistではVanilla 44.0%、Fragrach 42.9%だった。Full Vanilla＋Checklistは46.2%である。Checklistは全方式を改善し、Fragrach固有の優位ではなかった。したがって一般的な強いRAGへの性能優位は支持されず、holdoutには進んでいない。詳細は[EnterpriseRAG-Bench外部分布評価](enterprise-rag-bench-external-pilot-2026-08-05_ja.md)に記録した。

この二つの結果から、質問相対Packetを一種類の汎用構造として固定する判断はしない。MultiHopではsource diversityと原文不可分契約を使う。企業文書ではBM25を主経路として保持するが、現行の質問型別縮約は強い同予算Vanillaを超えていない。両者に共通し得るのは資料の見た目ではなく、「質問に必要なEvidence Unitを一つの回答資料として欠落させない」というcompile contractである。ただし、この契約を持つことと、通常RAGより高いDVAAを出すことは分けて検証する。
