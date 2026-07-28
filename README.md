# Fragrach

Fragrachは、資料群と利用目的から、RAGへ投入する前の知識をコンパイルするツールです。検索APIやチャットUIは提供せず、原本へ遡れるEvidence、Claim、競合、検索仕様、回答仕様を目的別のKnowledge Buildとして生成します。

現在の開発版には、Rust CLI、差分走査、Usage Intent、OllamaによるEvidence付きClaim抽出、時点・権威性・矛盾・不足の診断、Knowledge Build、Report、JSONL Exporter、LLMを呼ばない再コンパイル、npmランチャーがあります。npmレジストリにはまだ公開していません。

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

cargo run -p fragarach-cli -- export `
  --build target/design-review-build `
  --output target/design-review-rag.jsonl
```

## テスト

```powershell
cargo test --workspace
npm test
```

架空社内コーパスは`tests/corpora/aobane-industries-ja/`、通常のRAGとの比較手順は`tests/benchmarks/rag-comparison/`にあります。

矛盾をWarningとして残す方法と、コンパイル時の停止・明示的解決を切り替える方針は`docs/architecture/conflict-diagnostics_ja.md`にあります。

現行版の操作方法は`docs/user-manual_ja.md`、そのマニュアルだけを読んだ利用者視点の評価は`docs/user-manual-reader-review_ja.md`にあります。

Knowledge Buildの縦切り実装からnpm配布、マニュアル再評価までの順序は`docs/implementation-plan-phase1_ja.md`にあります。
