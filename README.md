# Fragrach

Fragrachは、資料群と利用目的から、RAGへ投入する前の知識をコンパイルするツールです。検索APIやチャットUIは提供せず、原本へ遡れるEvidence、Claim、競合、検索仕様、回答仕様を目的別のKnowledge Buildとして生成します。

現在の開発版には、Rust CLI、差分走査、Usage Intent、OllamaまたはCodex App ServerによるEvidence付きClaim抽出、上限付き並列LLM実行、Source単位の抽出キャッシュと中断再開、時点・権威性・矛盾・不足の診断、Knowledge Build、Report、JSONL Exporter、LLMを呼ばない再コンパイル、npmランチャーがあります。npmレジストリにはまだ公開していません。

## Fragrachが対象とするRAG

Fragrachの主要ターゲットは、調整済みのHybrid RAGでも関連文書は取得できるものの、質問に対してどの文書を採用すべきかを関連度だけでは決められないケースです。検索器を置き換えるのではなく、Hybrid検索やrerankerへ渡す前の文書群に、版、権威、適用時点、例外、実施記録、矛盾と原文根拠を加えます。

特に、規程、仕様、手順、FAQ、提案、承認記録、障害報告などが同じフォルダに蓄積され、改訂や追加が続く企業内文書を想定しています。導入単位のスイートスポットは、全社の全データを一つへ集約するセマンティック基盤ではなく、RAGを導入する一つの部門や業務チームが管理している文書フォルダです。そのフォルダと利用目的をFragrachへ渡し、用途別のKnowledge Buildを既存RAGへ登録します。

次のような場合に効果が期待できます。

- 旧版と現行版が同時に検索される。
- 正式規程、FAQ、メモ、草案のどれを優先すべきかが質問によって変わる。
- 一般規則、個別例外、実施記録を分けて回答する必要がある。
- 文書間の矛盾を隠さず、判断できない場合は回答や公開を止めたい。
- 文書更新後に、影響するClaim、Relation、Conflictを再コンパイルしたい。

反対に、少数の静的な文書から関連箇所を探すだけなら、まずchunking、Hybrid検索、rerankerを調整する方が単純で高速です。構造化DBの集計や、全社規模のOntology・アクセス制御基盤もFragrachの対象外です。

現在の企業文書テストコーパスは、40部門を独立したRAG領域として扱い、一部門あたり72文書・36問で構成しています。詳細なActual E2E評価は、5評価群、用途ごと12文書、合計30問まで実施しています。部門フォルダという導入単位には評価設計も合っていますが、実企業文書での推奨文書数や上限はまだ確定していません。

## 開発中のCLI

ワークスペースを初期化します。

```powershell
cargo run -p fragarach-cli -- init .
```

文書フォルダを走査します。

```powershell
cargo run -p fragarach-cli -- scan `
  --source tests/corpora/aobane-industries-ja/sources `
  --workspace .
```

成果物は`.fragarach/manifest.json`と`.fragarach/parsed/`へ保存され、走査状態は`.fragarach/workspace.db`へ記録されます。同じ内容を再走査した場合、Parsed Documentを再利用します。

Intentを検証し、ローカルOllamaでKnowledge Buildを生成します。

```powershell
cargo run -p fragarach-cli -- intent validate `
  --file tests/corpora/aobane-industries-ja/intents/design-review.yaml

cargo run -p fragarach-cli -- compile `
  --workspace . `
  --intent tests/corpora/aobane-industries-ja/intents/design-review.yaml `
  --model gemma4:latest `
  --output target/design-review-build
```

同じコンパイル契約をCodex App Serverで実行する場合は、Codex CLIへ事前にサインインしてProviderを切り替えます。

```powershell
cargo run -p fragarach-cli -- compile `
  --workspace . `
  --intent tests/corpora/aobane-industries-ja/intents/design-review.yaml `
  --provider codex-app-server `
  --model gpt-5.6-luna `
  --reasoning-effort low `
  --output target/design-review-codex-build
```

```powershell
cargo run -p fragarach-cli -- cache report `
  --workspace .

cargo run -p fragarach-cli -- export `
  --build target/design-review-build `
  --output target/design-review-rag.jsonl

# 旧Buildとの差分だけを出力（upsert / delete / commit）
cargo run -p fragarach-cli -- export `
  --base-build target/design-review-build-v1 `
  --build target/design-review-build-v2 `
  --output target/design-review-v1-v2.delta.jsonl
```

## テスト

```powershell
cargo test --workspace
npm test
```

架空社内コーパスは`tests/corpora/aobane-industries-ja/`、コーパスの要求定義は`docs/corpus-requirements_ja.md`、通常のRAGとの比較手順は`tests/benchmarks/rag-comparison/`にあります。

矛盾をWarningとして残す方法と、コンパイル時の停止・明示的解決を切り替える方針は`docs/architecture/conflict-diagnostics_ja.md`にあります。

現行版の操作方法は`docs/user-manual_ja.md`、そのマニュアルだけを読んだ利用者視点の評価は`docs/user-manual-reader-review_ja.md`にあります。

現在の`compile`がEvidenceからKnowledge Buildを作る処理と、キャッシュ・検証・Conflictゲートの境界は`docs/compilation-pipeline_ja.md`にあります。

参照データの確定、手法調査、仮説検証、Provider比較、精度改善を反復する計画は`docs/accuracy-improvement-plan_ja.md`にあります。

2026年時点のRAG改善手法、検索時補正と事前コンパイルの比較、採用する比較条件と仮説は`docs/research/rag-methods-2026_ja.md`にあります。

Sparse / Dense / rerank、時点・権威性・矛盾、複数文書関係、回答検証までの詳細調査と、Fragrachで比較実装する優先順位は`docs/research/rag-existing-methods-deep-dive-2026_ja.md`にあります。

企業内で文書の効力が変わる条件、業種・部門別の活用ケース、現在の文書関係モデルに不足するScope・例外・正本性・Lineageの要件は`docs/research/enterprise-document-validity-cases_ja.md`にあります。

40部門・1,440問のOracle Relation Dossier評価と、Codex App Server / Lunaで実際にコンパイルした2用途のRaw・Actual比較は`docs/evaluations/enterprise-diverse-evaluation-2026-08-02_ja.md`にあります。実験台帳の保存規約は`docs/evaluation-recording_ja.md`にあります。

Weighted Metadata、Filter-first、Relation Graph、質問時LLM、Compiled Hybridを同じ候補集合で比較する実装順と採用ゲートは`docs/document-validity-improvement-plan_ja.md`にあります。

20文書からのProfile・Relation抽出と、固定28問に対するGemma 4 / Codex App Server・S2 / S3のE2E比較は`docs/research/document-profile-extraction-comparison_ja.md`にあります。

未調整20問でS3の一般化を測り、初回Oracle 65%から一般規則の修正後100%、Codex実抽出85%まで改善した経緯は`docs/research/document-validity-holdout-comparison_ja.md`にあります。

この20問は改善後には開発集合となったため、2026-08-04の再実行は一般化評価ではなく回帰・抽出契約監査として扱います。現行Luna抽出込みはStrict case 70%、Decision 95.3%で、Goldにだけある権威順位への依存と、1本のRelation欠落が3問へ波及する評価上の問題を`docs/evaluations/document-validity-regression-audit-2026-08-04_ja.md`に記録しています。

外部VersionQAでは、DVAAのGoldを文書IDから本文span・不在証明・完全な版一覧・意味差分のEvidence Unitへ修正し、原文と矛盾する7問を分母から隔離しました。従来Decision Packetの再採点53問はDVAA-Gross 32.1%でしたが、質問相対のVersion／Inventory／Diff PacketではEvidence Ceiling、LunaのAnswer Accuracy、DVAA-Gross／Netが53問すべて100%になりました。この集合は改善に使用した開発集合であり、とくに暗黙変更は4問しか採点できないため、一般化性能とは扱いません。実装、失敗原因、凍結条件は`docs/evaluations/versionqa-external-pilot-2026-08-04_ja.md`に記録しています。

標準RAG、CRAG / Self-RAG、RAPTOR / GraphRAG、HippoRAG / PropRAG、信頼性・競合・時間対応RAGとS3の能力比較は`docs/research/fragrach-s3-prior-methods-comparison_ja.md`にあります。

Fragrachの現行方式、強み・弱み、単純RAG、AWS Context Ontology Accelerator、AI Powered Knowledge Graph Generatorとの差と、Knowledge Compilerとして差異を広げる実装優先順位は`docs/research/fragrach-differentiation-strategy-2026-08-02_ja.md`にあります。

Knowledge Buildの縦切り実装からnpm配布、マニュアル再評価までの順序は`docs/implementation-plan-phase1_ja.md`にあります。
