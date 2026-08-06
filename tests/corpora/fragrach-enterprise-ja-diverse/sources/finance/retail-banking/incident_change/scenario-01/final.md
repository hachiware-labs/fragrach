---
document_id: "ENT-FINANCE-RETAIL-BANKING-S1-INCIDENT-CHANGE-FINAL"
title: "保険料二重計上 最終報"
company: "瑞穂フィナンシャルサービス"
industry: "finance"
department: "retail-banking"
department_name: "個人金融部"
scenario: "finance-retail-banking-S1"
purpose: "incident_change"
document_type: "incident_report"
status: "closed"
authority: "official_record"
owner: "個人金融部責任者"
approved: true
force: "informational"
force_rank: 8
valid_from: "2026-04-01"
official_record: true
scope: {"organization":"瑞穂フィナンシャルサービス"}
synthetic: true
generation_model: "gemma4:latest"
---

# 保険料二重計上 最終報

> 架空の評価用社内文書です。固有名詞・制度・数値は実在組織と無関係です。

## 確定原因

当部署では、保険料二重計上事象を2026年6月18日9時10分に検知し、初動対応として重複仕訳の取消処理を実施しました。当初は原因が未確認でしたが、調査の結果、再送イベントにおける重複排除キーの欠落が確定的な原因であることが判明いたしました。これを受け、恒久対策として契約番号と計上月の一意制約を追加する変更を計画し、本変更申請は既に諮問会議で承認を得ております。つきましては、この一意制約追加による対応を2026年7月5日に本番適用した経緯を記録し、再発防止の証跡として関係者間で共有いたします。

保険料二重計上の確定原因は再送イベントの重複排除キー欠落である。

## 暫定対応

この節では、暫定措置の限界を書く。 記載された確定事項と文書の適用範囲を合わせて確認する。

復旧時には重複仕訳を取消処理した。

## 終結

この節では、時系列上の優先を説明する。 記載された確定事項と文書の適用範囲を合わせて確認する。

本最終報は初報の未確認事項を更新する。
