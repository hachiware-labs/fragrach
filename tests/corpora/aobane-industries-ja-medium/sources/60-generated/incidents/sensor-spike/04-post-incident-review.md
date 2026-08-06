---
document_id: "M-INC-013-PIR"
title: "温度グラフの異常値表示 障害後レビュー"
document_type: "post_incident_review"
status: "approved"
authority: "approved_review_record"
owner: "品質保証部"
created_at: "2026-07-28"
generation: "ollama"
---

# 温度グラフの異常値表示 障害後レビュー

## 振り返り

本件は単位変換の二重適用が原因であり、恒久対策として単位付きデータ型への移行を実施します。

温度グラフの異常値表示の対応を振り返った。

## 原因確認

確定原因は単位変換の二重適用である。

## 恒久対策

恒久対策として単位付きデータ型へ移行する。

## 責任

完了責任者は運用マネージャーである。
