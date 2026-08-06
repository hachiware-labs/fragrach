---
document_id: "M-PRJ-002-ADR"
title: "公開APIの版管理 ADR"
document_type: "adr"
status: "accepted"
authority: "implementation_record"
owner: "主任技師"
created_at: "2026-07-28"
generation: "ollama"
---

# 公開APIの版管理 ADR

## 状況

公開APIの版管理に関する技術判断記録（ADR）であり、メジャー版をURLへ含める方式を採用し、日付だけの版番号は採用しないという決定に至った経緯をまとめている。

公開APIの版管理の技術判断を記録する。

## 決定

採用案はメジャー版をURLへ含める方式である。

## 理由

判断理由は移行期間を明示できるため。

## 不採用案

日付だけの版番号は採用しない。
