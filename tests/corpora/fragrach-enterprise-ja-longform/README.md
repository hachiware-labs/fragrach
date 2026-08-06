# Fragrach 長文企業文書コーパス

短文中心の `fragrach-enterprise-ja-diverse` から、四つの部門RAGを選び、実務に近い長さの文書を混在させた派生コーパスです。

- 対象領域: manufacturing-product-design、software-sre、finance-compliance、healthcare-quality-regulatory
- 文書数: 288（長文 72、短文 216）
- Gold質問: 144
- 長文化対象: 現行規程、技術仕様、決裁議事録、標準手順、最終障害報告、基本契約

生成は、決定的な文書骨子を先に保存し、Ollamaで非規範の補足章だけを生成し、Gold文を先頭・中央・末尾へ分散挿入します。短いFAQ、承認記録、草案、実施ログなどは元コーパスのまま保持します。

生成: `npm run corpus:longform:generate`

検証: `npm run corpus:longform:check`
