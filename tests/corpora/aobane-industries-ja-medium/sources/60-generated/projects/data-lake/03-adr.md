---
document_id: "M-PRJ-008-ADR"
title: "分析データ保管 ADR"
document_type: "adr"
status: "accepted"
authority: "implementation_record"
owner: "主任技師"
created_at: "2026-07-28"
generation: "ollama"
---

# 分析データ保管 ADR

## 状況

分析データ保管の技術判断として、システム負荷とセキュリティを理由に本番DB直接参照ではなく匿名化された分析用保管領域を採用する。

分析データ保管の技術判断を記録する。

## 決定

採用案は匿名化した分析用保管領域である。

## 理由

判断理由は本番負荷と権限を分離するため。

## 不採用案

本番DBの直接参照は採用しない。
