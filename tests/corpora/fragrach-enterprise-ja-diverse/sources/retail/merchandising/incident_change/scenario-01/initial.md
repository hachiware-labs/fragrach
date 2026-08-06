---
document_id: "ENT-RETAIL-MERCHANDISING-S1-INCIDENT-CHANGE-INITIAL"
title: "クーポンの重複適用 初報"
company: "日和リテール"
industry: "retail"
department: "merchandising"
department_name: "商品部"
scenario: "retail-merchandising-S1"
purpose: "incident_change"
document_type: "incident_report"
status: "open"
authority: "operations_record"
owner: "商品部責任者"
approved: true
force: "informational"
force_rank: 6
valid_from: "2026-04-01"
official_record: true
scope: {"organization":"日和リテール"}
synthetic: true
generation_model: "gemma4:latest"
---

# クーポンの重複適用 初報

> 架空の評価用社内文書です。固有名詞・制度・数値は実在組織と無関係です。

## 事象

この文書群は、クーポンの重複適用というインシデントが発生し、その原因究明から恒久的な対策の実施に至るまでの経緯をまとめたものである。初報では原因が未確認であったものの、最終的に併用不可条件のキャッシュ反映漏れが確定原因として特定されたため、再発防止策として注文確定時の併用条件再検証ロジックを実装し、本番環境に適用した際の記録と変更申請手続きを確認する目的で作成されている。

クーポンの重複適用を2026年6月18日09時10分に検知した。

## 初期見解

この節では、推測を確定しない注意を書く。 記載された確定事項と文書の適用範囲を合わせて確認する。

初報時点の原因は未確認である。

## 初動

この節では、影響抑制の状況を書く。 記載された確定事項と文書の適用範囲を合わせて確認する。

暫定対応として対象クーポンを一時停止した。
