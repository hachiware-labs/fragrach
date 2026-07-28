# 増分再コンパイル試験

各シナリオでは、元の`aobane-industries-ja`を作業用ディレクトリへ複製してから操作してください。期待結果は`ground-truth/expected.json`の`incremental_scenarios`に記載しています。

## 1. 新しい資料を追加する

`add-source/new-security-guidance.md`を、作業用コーパスの`sources/40-information-systems/guides/`へ追加します。

Source Manifestには一件の追加が記録されます。既存文書のParse結果は再利用し、新しいEvidenceと、影響する設計レビューおよびオンボーディング用Buildだけを更新します。

## 2. 現行標準を改訂する

`replace-source/design-review-standard-v2.1.md`を、現行の`design-review-standard-v2.md`と入れ替えます。

内容ハッシュ、版、施行日が変わり、設計レビューに関係するClaimと診断が更新対象になります。障害対応だけで使うEvidenceの再抽出は不要です。

## 3. 唯一の根拠を削除する

作業用コーパスから`sources/30-product-development/notes/architecture-forum-2026-05-28.md`を削除します。

認証キャッシュ変更の個別事例は、現行Evidenceを失います。その文書だけを根拠とするClaimは削除せず、`unsupported`へ遷移させます。
