---
document_id: "M-PRJ-004-ADR"
title: "モバイル認証 ADR"
document_type: "adr"
status: "accepted"
authority: "implementation_record"
owner: "主任技師"
created_at: "2026-07-28"
generation: "ollama"
---

# モバイル認証 ADR

## 状況

モバイル認証の技術判断として、端末紛失時の個別失効性を理由に短期トークンと更新トークンの採用が決定された。

モバイル認証の技術判断を記録する。

## 決定

採用案は短期トークンと更新トークンである。

## 理由

判断理由は端末紛失時に個別失効できるため。

## 不採用案

端末固有パスワードは採用しない。
