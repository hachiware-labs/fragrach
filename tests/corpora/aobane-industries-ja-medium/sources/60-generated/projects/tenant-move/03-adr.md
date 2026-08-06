---
document_id: "M-PRJ-014-ADR"
title: "顧客領域移行 ADR"
document_type: "adr"
status: "accepted"
authority: "implementation_record"
owner: "主任技師"
created_at: "2026-07-28"
generation: "ollama"
---

# 顧客領域移行 ADR

## 状況

顧客領域移行における技術判断として、停止時間を短縮できる二重書き込みによる段階移行を採用する。

顧客領域移行の技術判断を記録する。

## 決定

採用案は二重書き込みによる段階移行である。

## 理由

判断理由は停止時間を短縮するため。

## 不採用案

停止を伴う一括移行は採用しない。
