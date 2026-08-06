---
document_id: "M-PRJ-009-ADR"
title: "通知サービス統合 ADR"
document_type: "adr"
status: "accepted"
authority: "implementation_record"
owner: "主任技師"
created_at: "2026-07-28"
generation: "ollama"
---

# 通知サービス統合 ADR

## 状況

通知サービス統合における技術判断として、再試行と重複抑止を一元化できる共通配送キューを採用する。

通知サービス統合の技術判断を記録する。

## 決定

採用案は共通配送キューである。

## 理由

判断理由は再試行と重複抑止を一元化するため。

## 不採用案

各機能から直接送信は採用しない。
