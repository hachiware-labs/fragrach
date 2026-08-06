---
document_id: "M-PRJ-020-ADR"
title: "多言語文言管理 ADR"
document_type: "adr"
status: "accepted"
authority: "implementation_record"
owner: "主任技師"
created_at: "2026-07-28"
generation: "ollama"
---

# 多言語文言管理 ADR

## 状況

多言語文言管理に関する技術判断として、翻訳更新を配備から分離できる外部管理の翻訳資源を採用し、ソースコードへの埋め込みは採用しないと記録する。

多言語文言管理の技術判断を記録する。

## 決定

採用案は翻訳資源の外部管理である。

## 理由

判断理由は翻訳更新を配備から分離するため。

## 不採用案

ソースコードへの埋め込みは採用しない。
