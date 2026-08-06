---
document_id: "M-PRJ-016-ADR"
title: "運用可観測性 ADR"
document_type: "adr"
status: "accepted"
authority: "implementation_record"
owner: "主任技師"
created_at: "2026-07-28"
generation: "ollama"
---

# 運用可観測性 ADR

## 状況

運用可観測性の技術判断として、サービス間の遅延箇所を追跡できるメトリクスとトレースの併用を採用し、ログだけの監視は採用しないと記録する。

運用可観測性の技術判断を記録する。

## 決定

採用案はメトリクスとトレースの併用である。

## 理由

判断理由は遅延箇所をサービス間で追跡するため。

## 不採用案

ログだけの監視は採用しない。
