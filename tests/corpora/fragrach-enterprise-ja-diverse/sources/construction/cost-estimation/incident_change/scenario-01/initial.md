---
document_id: "ENT-CONSTRUCTION-COST-ESTIMATION-S1-INCIDENT-CHANGE-INITIAL"
title: "工事原価と資材調達処理の状態表示誤り 初報"
company: "山城建設"
industry: "construction"
department: "cost-estimation"
department_name: "積算調達部"
scenario: "construction-cost-estimation-S1"
purpose: "incident_change"
document_type: "incident_report"
status: "open"
authority: "operations_record"
owner: "積算調達部責任者"
approved: true
force: "informational"
force_rank: 6
valid_from: "2026-04-01"
official_record: true
scope: {"organization":"山城建設"}
synthetic: true
generation_model: "gemma4:latest"
---

# 工事原価と資材調達処理の状態表示誤り 初報

> 架空の評価用社内文書です。固有名詞・制度・数値は実在組織と無関係です。

## 事象

積算調達部における工事原価と資材調達処理の状態表示誤りに関する一連の文書群である。本件は、状態更新イベントの順序逆転が原因で発生したシステム上の異常を検知し（2026年6月18日）、暫定対応を経て復旧に至った経緯をまとめている。最終的に、再発防止策として「更新世代を照合する整合性検査」を追加する恒久対策を実施・適用したため、その変更申請の承認状況や具体的なリリース記録を確認する必要がある。本文書群は、システム障害発生から恒久的な改善措置が完了し、業務プロセスへの反映に至るまでの経緯と証跡を共有している。

工事原価と資材調達処理の状態表示誤りを2026年6月18日09時10分に検知した。

## 初期見解

この節では、推測を確定しない注意を書く。 記載された確定事項と文書の適用範囲を合わせて確認する。

初報時点の原因は未確認である。

## 初動

この節では、影響抑制の状況を書く。 記載された確定事項と文書の適用範囲を合わせて確認する。

暫定対応として対象記録を原記録から再同期した。
