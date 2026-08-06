---
document_id: "M-PRJ-007-ADR"
title: "機能フラグ管理 ADR"
document_type: "adr"
status: "accepted"
authority: "implementation_record"
owner: "主任技師"
created_at: "2026-07-28"
generation: "ollama"
---

# 機能フラグ管理 ADR

## 状況

機能フラグ管理の技術判断として、履歴追跡が必要なため設定ファイルへの直書きではなく監査付き管理サービスを採用する。

機能フラグ管理の技術判断を記録する。

## 決定

採用案は監査付き管理サービスである。

## 理由

判断理由は変更者と適用時刻を追跡するため。

## 不採用案

設定ファイルへの直書きは採用しない。
