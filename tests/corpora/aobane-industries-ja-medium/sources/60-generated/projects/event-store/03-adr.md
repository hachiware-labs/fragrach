---
document_id: "M-PRJ-001-ADR"
title: "イベント履歴基盤 ADR"
document_type: "adr"
status: "accepted"
authority: "implementation_record"
owner: "主任技師"
created_at: "2026-07-28"
generation: "ollama"
---

# イベント履歴基盤 ADR

## 状況

イベント履歴基盤に関する技術判断記録（ADR）であり、用途別の追記専用ストアを採用し、単一の共有テーブルは採用しないという決定に至った経緯をまとめている。

イベント履歴基盤の技術判断を記録する。

## 決定

採用案は用途別の追記専用ストアである。

## 理由

判断理由は監査履歴を削除不能に保つため。

## 不採用案

単一の共有テーブルは採用しない。
