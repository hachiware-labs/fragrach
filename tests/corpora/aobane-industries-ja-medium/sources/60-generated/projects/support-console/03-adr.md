---
document_id: "M-PRJ-017-ADR"
title: "サポート調査画面 ADR"
document_type: "adr"
status: "accepted"
authority: "implementation_record"
owner: "主任技師"
created_at: "2026-07-28"
generation: "ollama"
---

# サポート調査画面 ADR

## 状況

サポート調査画面に関する技術判断として、検索条件と閲覧者を記録する監査付き照会APIを採用し、本番DBの直接検索は採用しないと記録する。

サポート調査画面の技術判断を記録する。

## 決定

採用案は監査付き照会APIである。

## 理由

判断理由は検索条件と閲覧者を記録するため。

## 不採用案

本番DBの直接検索は採用しない。
