---
document_id: "M-PRJ-010-ADR"
title: "イベントスキーマ管理 ADR"
document_type: "adr"
status: "accepted"
authority: "implementation_record"
owner: "主任技師"
created_at: "2026-07-28"
generation: "ollama"
---

# イベントスキーマ管理 ADR

## 状況

イベントスキーマ管理における技術判断として、配備前の破壊的変更検出に有効な互換性検査付きレジストリを採用する。

イベントスキーマ管理の技術判断を記録する。

## 決定

採用案は互換性検査付きレジストリである。

## 理由

判断理由は配備前に破壊的変更を検出するため。

## 不採用案

文書だけでの管理は採用しない。
