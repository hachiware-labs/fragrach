# Fragrach Phase 1 実装計画

進捗（2026-07-28）: Knowledge IR、Usage Intent、Evidence付きClaim抽出、時点・権威性・Conflict診断、Knowledge Build、Report、JSONL Exporter、走査制限、ワークスペースロック、利用量集計、npm配布構成まで実装した。Evidence付きConflict overrideとnpmレジストリ公開は未完了である。実測結果は`tests/benchmarks/rag-comparison/UPPER_BOUND_FINDINGS_ja.md`、現行手順は`docs/user-manual_ja.md`を正とする。

## 判断

機能上の不足はある。現在はSource ManifestとParsed Documentまでで、Fragrachの中心価値であるUsage Intent、Claim、Conflict、Knowledge Buildを利用できない。この状態では、マニュアルを改善しても製品の良し悪しを読者が判断できない。

一方、実現不能と思われる設計上の障害は見えていない。難しいのは、LLM抽出の誤りをEvidence検証で抑えること、質問の対象時点で有効なClaimを選ぶこと、権威性と矛盾を安全に扱うことである。これらを避けて周辺機能を増やしても製品価値は確認できないため、最初の実装範囲に含める。

まず、架空社内コーパスを入力し、Usage Intentに対応したKnowledge Buildを一つ生成して、通常RAGと比較できる縦切りを完成させる。その後、運用上の不足を補い、実物だけを前提にユーザーマニュアルを改訂する。

## 最初の完成形

利用者が次の流れを実行できる状態をPhase 1の最初の完成形とする。

```text
init
  ↓
scan --source <documents>
  ↓
intent validate --file <intent.yaml>
  ↓
compile --intent <intent.yaml>
  ↓
report
  ↓
export --format jsonl
  ↓
通常RAGと同じ条件で比較
```

対応文書は当面MarkdownとUTF-8テキストに限定する。Domain Schemaの完全自動提案や多数の文書形式より、根拠付きClaim、時点解決、矛盾診断が正しくつながることを優先する。

## 実装する順序

### 1. Knowledge IRとBuild契約を固定する

現在のEvidence、Diagnostic、Conflictを基礎に、Usage Intent、Claim、Evidence参照、適用期間、権威性、状態、Knowledge Build ManifestをIRへ追加する。すべての成果物にSchema版を持たせ、Claimは一つ以上のEvidence IDがなければ有効にしない。

この段階でKnowledge Buildの最小構成を固定する。

```text
knowledge-build/
├─ manifest.json
├─ usage-intent.yaml
├─ claims.jsonl
├─ evidence.jsonl
├─ conflicts.jsonl
├─ diagnostics.jsonl
├─ unresolved-questions.md
├─ retrieval-profile.yaml
├─ answer-contract.yaml
└─ overview.md
```

受入条件:

- IRがJSONへ直列化・復元できる
- ClaimからSource Path、Evidence、原文行へ遡れる
- Schema版がManifestと個別成果物へ記録される
- EvidenceのないClaimが検証で拒否される

### 2. Usage Intentを読み込む

既存コーパスのIntent YAMLを正式な入力契約として読み込む。目的、利用者、質問、Evidence要件、時点要件、未解決Conflictの許容可否を検証し、不足項目を位置付きエラーとして返す。

最初は自由文からのIntent自動生成を実装せず、利用者が編集したYAMLを確実に読めることを優先する。

追加するCLI:

```text
fragarach intent validate --file <intent.yaml>
```

受入条件:

- 4つのテストIntentを読み込める
- ID重複や必須項目不足を分かるメッセージで拒否する
- `unresolved_conflicts_allowed`がBuild公開可否へ反映される

### 3. Evidence付きClaim抽出を実装する

Parsed DocumentのEvidence Unitを入力として、Claim候補を構造化出力で抽出する。LLM Providerは交換可能な境界を先に定義し、最初の実行ProviderとしてローカルOllamaを接続する。後からOpenAI互換APIを追加できる形にする。

LLMは候補を作るだけにし、Rust側で次を検証する。

- 参照したEvidence IDが実在する
- Claim本文がEvidenceの内容と無関係ではない
- `valid_from`、`valid_to`、`status`の形式が正しい
- Provider、モデル、Prompt、温度、入力Evidenceの版を記録する
- 検証できない候補を有効なClaimへ昇格しない

Front Matterにある文書ID、版、施行日、状態、所有部署は決定的に解析し、LLMの推測で上書きしない。

受入条件:

- 主要Claimの100%がEvidenceへ接続される
- 存在しないEvidence参照を拒否する
- 同じ入力と固定設定から再現可能な抽出記録を作る
- LLMが利用できない場合に、処理済み成果物を壊さず診断を残す

### 4. 版・時点・権威性・矛盾をコンパイルする

Claim抽出後に、版系列、適用期間、状態、文書の権威性を正規化する。質問に`as_of`がある場合は、その日時点で有効なClaimを選択できる形へ変換する。

解決は次の順で行う。

1. `valid_from`と`valid_to`による時点解決
2. 文書内で明示された権威性による解決
3. Evidence付きの人手override
4. それでも決まらなければ未解決Conflict

更新日が新しい、文章が詳しい、LLM信頼度が高いという理由だけでは真実を決定しない。

コンパイルオプション:

```text
--on-unresolved-conflict <warn|error>
--warnings-as-errors
--conflict-overrides <path>
```

受入条件:

- 2025年12月と2026年6月で異なる設計レビュー期限を選べる
- 提案、承認、実装を異なる状態として保持する
- 現行規程と未更新FAQの競合をConflictとして出す
- `warn`ではBuildへConflictを残して継続する
- `error`またはIntent不許可では非ゼロ終了し、公開可能Buildにしない
- override後も元のConflictと判断根拠を失わない

### 5. Knowledge Build、Report、汎用Exporterを完成させる

コンパイル結果は一時ディレクトリへ作り、検証に成功した後だけ完成Buildとして確定する。中断や失敗で前回の正常Buildを壊さない。

追加するCLI:

```text
fragarach compile --intent <intent.yaml>
fragarach report
fragarach export --format jsonl
```

最初のExporterは特定のVector Storeへ直結せず、根拠、適用期間、状態、Conflict IDを含む汎用JSONLを出す。これにより、Raw RAGと同じ検索器へ入力して比較できる。

受入条件:

- Buildに入力ハッシュ、Parser版、Provider、モデル、Prompt、Intent版を記録する
- Warning、Error、未解決Conflictの件数を人向けとJSONの両方で確認できる
- 失敗したBuildを完成Buildとして公開しない
- JSONLからClaimとEvidenceの接続を復元できる

### 6. 運用上の不足を補う

マニュアル読者レビューで見つかったうち、説明では解消できない機能不足を実装する。

- include・excludeパターン
- ファイルサイズ上限
- 文書ErrorやWarningの件数によるCI失敗条件
- 同一ワークスペースの並行実行を防ぐロック
- 中断後の安全な再実行
- 出力Schemaの互換性規則
- 処理件数、時間、キャッシュ率、LLM利用量の集計

25文書から47文書へ拡張したコーパスで測定した結果、4 Intentの初回コンパイルに合計約30分25秒を要し、Actualの回答品質もRaw RAGを下回った。現時点では推奨範囲を約束せず、抽出・検索を改善した後に、さらに大きな合成コーパスと実コーパスで再測定する。

### 7. npm配布を実装する

RustバイナリをOS別にビルドし、npmパッケージのランチャーから起動する。Python、Docker、Node-APIアドオンは基本機能の必須条件にしない。

受入条件:

- クリーン環境でnpmまたはnpxから`fragarach --help`を実行できる
- 未対応OSでは原因と対応OSを表示する
- npm版とCargo版で同じE2Eテストを通す
- パッケージ版とIR Schema版をBuildへ記録する

## 品質評価

実装後はOracle Compiledではなく、Fragrachが実際に生成したKnowledge Buildを使って比較する。

比較条件:

- 同じSource Corpus
- 同じ16問
- 同じ検索方式、top-k、回答モデル、温度、seed
- 質問ごとに独立した回答コンテキスト
- Raw RAG、Actual Compiled、Full Fragrachの三系統

合格判断では一つの総合点だけを使わない。

- 全ClaimがEvidenceへ接続されている
- 旧版、現行版、提案、実装を取り違えない
- 期待するConflictとWarningを検出できる
- 根拠再現率がRaw RAGを下回らない
- 逐次更新・矛盾の重点質問でRaw RAGより改善する
- 不明な場合に誤って断定せず、Warningまたは回答保留にできる

LLMによる自己判定だけには依存しない。時点、数値、禁止結論は決定的なルールでも評価し、重点質問は回答方式を隠した人手確認を併用する。

## マニュアルを見直す条件

マニュアルの全面改訂は、`compile`、`report`、JSONL Exporter、Warningポリシー、npm導入がE2Eで動いてから行う。それ以前は、実装済み範囲の追記だけに留める。

改訂版には、同じ架空文書を使った一つの完成例を載せる。

1. Source文書を置く
2. Usage Intentを選ぶ
3. Knowledge Buildを生成する
4. Warningを確認し、必要ならoverrideする
5. JSONLをRAGへ登録する
6. Raw RAGと回答を比較する

さらに、Manifest、Claim、Conflict、Diagnostic、Exporter出力の最小例、対応OS、推奨規模、外部LLMへ送る範囲、ローカル実行方法、中断復旧、CI判定を説明する。

改訂後は、再びマニュアルだけを読み、次を確認する。

- 対象利用者と担当分担が分かる
- 初回利用からRAG投入まで再現できる
- Warning付きBuildを使ってよい条件が分かる
- 外部送信、費用、対応規模を判断できる
- Raw RAGに対する改善と限界を説明できる

前回の読者レビューは残し、改訂後レビューとの差分を記録する。

## 後回しにするもの

最初の縦切りが成立するまで、次は実装範囲から外す。

- Web UIとグラフ編集画面
- SharePoint、メール、チャットの直接同期
- 多数のVector Store専用Exporter
- PDF、Office、OCRの高忠実度解析
- Domain Schemaの完全自動確定
- LLMによる無根拠な自動Conflict解消
- 全文書を対象にした完全な増分Knowledge Compile

これらは有用だが、Fragrachが通常RAGより良い知識を作れるかを最初に確認するための必須条件ではない。
