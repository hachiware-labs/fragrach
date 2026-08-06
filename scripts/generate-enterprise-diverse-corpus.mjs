import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const corpusRoot = path.join(repoRoot, "tests", "corpora", "fragrach-enterprise-ja-diverse");
const sourcesRoot = path.join(corpusRoot, "sources");
const cacheRoot = path.join(corpusRoot, "generation", "cache");

export const EXPECTED = Object.freeze({
  industries: 8, departments: 40, purposes: 6, scenarios_per_purpose: 3,
  documents_per_department: 72, questions_per_department: 36,
  documents: 2880, questions: 1440,
});

// Gold facts are authored here. Ollama only supplies non-normative connective prose.
const INDUSTRIES = [
  {
    id: "manufacturing", name: "製造", company: "東雲精工", site: "名古屋工場", subject: "AX-14制御盤",
    governance: ["設計変更の承認", "製造部長の単独承認でよい", "品質保証部長と主任技師の共同承認を得る"],
    technical: ["端子台TB-7の締付トルク", "42 N·m", "48 N·m"],
    planning: ["外観検査ライン更新", "全三工場を同日に切り替える", "名古屋工場から二段階で導入する", "停止影響を限定し検出率を比較できるため"],
    operations: ["プレス機の日常点検", "始業前に一回実施する", "試作ロットPX-8", "各シフト開始前に実施する"],
    incident: ["塗装膜厚の測定値ずれ", "校正係数の旧版参照", "対象ロットを出荷保留にした", "測定端末へ係数版の整合検査を追加する"],
    commercial: ["設備保守契約MFG-26", "障害一次応答は四時間以内", "重要設備の一次応答は二時間以内", "全設備を一時間以内とする"],
  },
  {
    id: "healthcare", name: "医療・製薬", company: "白峰メディカル", site: "中央検査センター", subject: "検体搬送装置MC-3",
    governance: ["検査結果の訂正承認", "担当技師だけで訂正できる", "担当技師と検査部門責任者の二者承認を得る"],
    technical: ["冷蔵検体の保管温度", "2〜10℃", "2〜8℃"],
    planning: ["服薬支援アプリ導入", "全診療科へ一括展開する", "循環器内科で先行検証してから展開する", "患者安全指標を導入前後で確認できるため"],
    operations: ["高リスク検体の照合", "受付時に一回実施する", "緊急検査票ER-12", "受付時と分析装置投入前に実施する"],
    incident: ["検査結果通知の遅延", "通知キューの優先度設定漏れ", "緊急結果を電話で連絡した", "緊急区分を使う配送優先制御を追加する"],
    commercial: ["検査試薬供給契約MED-26", "通常便は五営業日以内に納品する", "緊急指定品は二営業日以内に納品する", "全品を翌日納品する"],
  },
  {
    id: "finance", name: "金融・保険", company: "瑞穂フィナンシャルサービス", site: "東京事務センター", subject: "融資審査基盤LEND-X",
    governance: ["高額送金の承認", "支店長の単独承認でよい", "支店長と資金管理責任者の二者承認を得る"],
    technical: ["不正検知スコアの遮断閾値", "0.82", "0.87"],
    planning: ["本人確認基盤更改", "既存口座を一括移行する", "新規申込から段階的に移行する", "誤判定率と離脱率を分離して測定できるため"],
    operations: ["海外送金の制裁対象照合", "受付時に一回実施する", "高リスク国向け案件HR-9", "受付時と実行直前に実施する"],
    incident: ["保険料二重計上", "再送イベントの重複排除キー欠落", "重複仕訳を取消処理した", "契約番号と計上月の一意制約を追加する"],
    commercial: ["決済代行契約FIN-26", "月間稼働率は99.5%以上", "勘定系接続は99.9%以上", "すべての機能を99.99%以上とする"],
  },
  {
    id: "retail", name: "小売・EC", company: "日和リテール", site: "関東物流センター", subject: "受注管理OMS-R",
    governance: ["販売価格の緊急変更", "店舗責任者の単独承認でよい", "商品部責任者と経理責任者の共同承認を得る"],
    technical: ["冷凍商品の受入温度", "-15℃以下", "-18℃以下"],
    planning: ["需要予測システム導入", "全商品へ同時適用する", "季節商品二十品目で先行導入する", "欠品率と廃棄率への影響を比較できるため"],
    operations: ["返品商品の状態確認", "返送到着時に一回実施する", "高額家電返品RV-4", "返送到着時と返金承認前に実施する"],
    incident: ["クーポンの重複適用", "併用不可条件のキャッシュ反映漏れ", "対象クーポンを一時停止した", "注文確定時に併用条件を再検証する"],
    commercial: ["物流委託契約RTL-26", "通常出荷は受注翌営業日まで", "優先会員向けは受注当日中", "全注文を二時間以内に出荷する"],
  },
  {
    id: "software", name: "ソフトウェア・クラウド", company: "蒼空クラウド", site: "東日本運用センター", subject: "認証サービスAuth-N",
    governance: ["本番環境の緊急変更", "当番技師の単独承認でよい", "当番技師とインシデント指揮者の二者承認を得る"],
    technical: ["アクセストークンの有効時間", "60分", "20分"],
    planning: ["監査ログ基盤再設計", "単一共有テーブルを継続する", "用途別の追記専用ストアへ移行する", "保持期間と閲覧権限を用途別に制御できるため"],
    operations: ["重大リリースのロールバック確認", "配備後に一回実施する", "認証基盤変更REL-7", "配備前と配備後に実施する"],
    incident: ["API認証の断続的失敗", "署名鍵キャッシュの世代不一致", "旧世代キャッシュを削除した", "鍵世代を含む整合性検査を配備ゲートへ追加する"],
    commercial: ["クラウドサービス契約SaaS-26", "重大障害の一次応答は60分以内", "プレミアム契約は15分以内", "全顧客を5分以内とする"],
  },
  {
    id: "construction", name: "建設・エンジニアリング", company: "山城建設", site: "港北再開発現場", subject: "免震設備IS-5",
    governance: ["施工図の変更承認", "現場代理人の単独承認でよい", "設計責任者と現場代理人の共同承認を得る"],
    technical: ["高力ボルトM24の締付軸力", "220 kN", "245 kN"],
    planning: ["施工進捗計測の自動化", "全現場へ一括導入する", "港北現場の躯体工程で先行導入する", "測量誤差と報告工数を実工程で評価できるため"],
    operations: ["高所作業設備の使用前点検", "一日の開始時に一回実施する", "夜間シフトNW-3", "各シフト開始時に実施する"],
    incident: ["資材搬入ゲートの滞留", "予約枠と車両番号の同期欠落", "誘導員を追加配置した", "入場予約とゲート認証を同一識別子で連携する"],
    commercial: ["設備工事請負契約CST-26", "設計変更通知は十営業日前まで", "主要構造部は二十営業日前まで", "すべての変更を三十日前までとする"],
  },
  {
    id: "logistics", name: "物流・国際貿易", company: "北辰ロジスティクス", site: "横浜国際倉庫", subject: "通関管理システムCUS-2",
    governance: ["輸出管理判定の承認", "営業責任者の単独承認でよい", "輸出管理責任者と営業責任者の二者承認を得る"],
    technical: ["医薬品輸送容器の許容上限温度", "10℃", "8℃"],
    planning: ["配送経路最適化導入", "全国便を一括切替する", "関東圏の定期便で先行運用する", "遅配率と燃料使用量を同条件で比較できるため"],
    operations: ["封印番号の照合", "倉庫出庫時に一回実施する", "保税貨物BT-6", "倉庫出庫時と港湾搬入時に実施する"],
    incident: ["冷蔵貨物の温度逸脱", "中継拠点での電源接続確認漏れ", "予備冷却車へ積み替えた", "中継到着時の給電状態を自動通知する"],
    commercial: ["国際輸送契約LOG-26", "遅延通知は判明後24時間以内", "温度管理貨物は判明後2時間以内", "全貨物を判明後30分以内とする"],
  },
  {
    id: "energy", name: "エネルギー・公共インフラ", company: "青嶺エナジー", site: "西部制御所", subject: "変電監視SCADA-E",
    governance: ["系統保護設定の変更承認", "制御所長の単独承認でよい", "制御所長と系統技術責任者の共同承認を得る"],
    technical: ["変圧器巻線温度の警報閾値", "95℃", "90℃"],
    planning: ["設備予兆保全基盤導入", "全変電所へ同時導入する", "西部管内三変電所で先行検証する", "誤警報率と停止回避効果を確認できるため"],
    operations: ["非常用発電機の始動試験", "月に一回実施する", "台風警戒期間TY-2", "週に一回実施する"],
    incident: ["遠隔監視データの欠測", "通信ゲートウェイ証明書の期限切れ", "現地端末から手動監視へ切り替えた", "証明書期限の六十日前更新を自動化する"],
    commercial: ["保守委託契約ENG-26", "重大設備故障への現地到着は六時間以内", "基幹変電所は三時間以内", "全設備へ一時間以内に到着する"],
  },
];

const DEPARTMENTS = {
  manufacturing: [
    ["product-design", "製品設計部", "横浜開発拠点", "製品設計変更", "AX-14制御盤"],
    ["production-engineering", "生産技術部", "名古屋工場", "生産設備条件", "組立ラインAL-7"],
    ["quality-assurance", "品質保証部", "大阪品質センター", "製品検査と品質判定", "検査装置QI-4"],
    ["procurement", "調達部", "東京本社", "重要部材と供給元管理", "駆動部品DRV-8"],
    ["field-service", "保守サービス部", "東日本サービス拠点", "納入設備の保守", "保守対象機FS-2"],
  ],
  healthcare: [
    ["clinical-lab", "臨床検査部", "中央検査センター", "検体検査", "検体搬送装置MC-3"],
    ["pharmacovigilance", "安全性情報部", "東京安全管理室", "副作用情報評価", "安全性DB PV-6"],
    ["quality-regulatory", "品質薬事部", "神戸品質センター", "品質保証と規制対応", "製造記録GMP-5"],
    ["medical-affairs", "メディカル部", "東京本社", "医学情報提供", "医学情報基盤MI-2"],
    ["clinical-operations", "臨床開発部", "大阪開発拠点", "治験運営", "治験管理CTMS-4"],
  ],
  finance: [
    ["retail-banking", "個人金融部", "東京事務センター", "個人口座と融資", "融資審査基盤LEND-X"],
    ["risk-management", "リスク管理部", "東京本社", "市場・信用リスク", "リスク計測基盤RSK-8"],
    ["compliance", "コンプライアンス部", "大阪管理センター", "取引監視と規制対応", "取引監視AML-3"],
    ["claims", "保険金サービス部", "横浜査定センター", "保険金査定", "査定基盤CLM-5"],
    ["treasury", "資金管理部", "東京本社", "資金決済と流動性", "送金管理TRS-7"],
  ],
  retail: [
    ["merchandising", "商品部", "東京本社", "商品計画と価格", "商品管理MD-4"],
    ["store-operations", "店舗運営部", "新宿旗艦店", "店舗販売運営", "店舗管理POS-R"],
    ["ecommerce", "EC事業部", "東京ECセンター", "オンライン受注", "受注管理OMS-R"],
    ["supply-chain", "サプライチェーン部", "関東物流センター", "在庫と配送", "倉庫管理WMS-6"],
    ["customer-support", "顧客サポート部", "札幌サポートセンター", "返品と顧客対応", "顧客対応CRM-9"],
  ],
  software: [
    ["platform-engineering", "基盤開発部", "東京開発拠点", "共通クラウド基盤", "認証サービスAuth-N"],
    ["sre", "SRE部", "東日本運用センター", "信頼性と本番運用", "監視基盤OBS-7"],
    ["product-management", "プロダクト企画部", "東京本社", "製品計画と顧客価値", "製品管理PM-5"],
    ["security", "セキュリティ部", "横浜セキュリティセンター", "脆弱性とアクセス統制", "セキュリティ基盤SEC-4"],
    ["customer-success", "カスタマーサクセス部", "大阪顧客支援拠点", "顧客導入と利用支援", "顧客管理CS-8"],
  ],
  construction: [
    ["architectural-design", "建築設計部", "東京設計本部", "建築設計変更", "免震設備IS-5"],
    ["site-management", "施工管理部", "港北再開発現場", "工程と現場安全", "工程管理CST-7"],
    ["civil-engineering", "土木技術部", "関西技術センター", "土木構造と施工条件", "橋梁設備BRG-4"],
    ["cost-estimation", "積算調達部", "東京本社", "工事原価と資材調達", "積算基盤EST-3"],
    ["facility-engineering", "設備エンジニアリング部", "横浜技術拠点", "電気・空調設備", "設備設計MEP-6"],
  ],
  logistics: [
    ["warehouse", "倉庫運営部", "横浜国際倉庫", "保管と入出庫", "倉庫管理WMS-L"],
    ["transport", "輸配送部", "関東配車センター", "国内輸配送", "配車管理TMS-5"],
    ["customs", "通関部", "横浜通関センター", "輸出入通関", "通関管理CUS-2"],
    ["cold-chain", "コールドチェーン部", "成田温度管理拠点", "温度管理輸送", "温度監視TMP-8"],
    ["trade-compliance", "貿易管理部", "東京本社", "輸出管理と制裁対応", "貿易審査TRD-4"],
  ],
  energy: [
    ["grid-operations", "系統運用部", "西部制御所", "電力系統運用", "変電監視SCADA-E"],
    ["plant-maintenance", "発電保全部", "湾岸発電所", "発電設備保全", "発電設備GEN-9"],
    ["renewables", "再生可能エネルギー部", "北部運用拠点", "風力・太陽光運用", "発電予測REN-3"],
    ["retail-energy", "電力小売部", "東京顧客センター", "料金と契約管理", "顧客料金CIS-6"],
    ["safety-environment", "安全環境部", "中央安全管理室", "設備安全と環境管理", "安全管理HSE-4"],
  ],
};

const PURPOSES = ["governance", "technical_spec", "planning", "operations", "incident_change", "commercial_compliance"];
const INTENTS = [
  {
    id: "governance", goal: "対象日時点の正式な規程と承認要件を、旧版や未更新案内との関係を含めて示す",
    users: ["department-member", "manager", "internal-auditor"],
    tasks: ["現行版と旧版を適用時点で区別する", "正式規程と未更新FAQの食い違いを開示する", "承認記録から施行状態を確認する"],
    questions: ["対象日時点で有効な規則は何か", "案内と正式規程が食い違う場合はどう扱うか"],
    unresolved: false,
  },
  {
    id: "technical_spec", goal: "基本仕様、部分追補、未承認草案、試験記録を区別して現行の技術条件を示す",
    users: ["engineer", "quality-assurance-member", "reviewer"],
    tasks: ["追補を該当条項だけへ適用する", "草案を現行仕様として扱わない", "試験記録と規範文書を区別する"],
    questions: ["対象製品の現行基準値は何か", "草案や試験記録は仕様を変更するか"],
    unresolved: true,
  },
  {
    id: "planning", goal: "初期提案、比較分析、正式決定、実施計画を区別して採用案と理由を説明する",
    users: ["planner", "project-leader", "reviewer"],
    tasks: ["提案と正式決定を区別する", "採用理由を決定記録から確認する", "不採用案を現行計画へ混入させない"],
    questions: ["正式採用された方式と理由は何か", "初期提案は現在も実施対象か"],
    unresolved: true,
  },
  {
    id: "operations", goal: "全社手順、現場指示、期限付き例外、実施記録から対象別の運用を判断する",
    users: ["operator", "site-manager", "auditor"],
    tasks: ["例外の対象と期間を確認する", "対象外へ例外を拡張しない", "実施記録を新しい規則として扱わない"],
    questions: ["指定日時と対象に適用する手順は何か", "例外対象外の運用は変わるか"],
    unresolved: false,
  },
  {
    id: "incident_change", goal: "初報、最終報、変更申請、リリース記録から原因と対策の実施状態を説明する",
    users: ["incident-responder", "engineer", "service-owner"],
    tasks: ["初期見解と確定原因を区別する", "暫定対応と恒久対策を区別する", "承認と本番適用の両方を確認する"],
    questions: ["確定原因と暫定対応は何か", "恒久対策は提案か実施済みか"],
    unresolved: true,
  },
  {
    id: "commercial_compliance", goal: "基本契約、個別契約、未署名提案、監査記録から対象別の契約義務を示す",
    users: ["contract-manager", "procurement-member", "compliance-reviewer"],
    tasks: ["対象範囲における文書優先順位を適用する", "未署名提案を契約義務として扱わない", "監査記録と契約条項を区別する"],
    questions: ["対象業務へ適用する契約条件は何か", "供給元提案は現在の契約義務か"],
    unresolved: false,
  },
];
const quote = (value) => JSON.stringify(value);
const relPath = (domain, purpose, file) => {
  const scenario = domain.id.match(/-S(\d+)$/i)?.[1] ?? "1";
  return `${domain.industryId}/${domain.departmentId}/${purpose}/scenario-${scenario.padStart(2, "0")}/${file}.md`;
};

function scenarioFor(industry, department, variant) {
  const [departmentId, departmentName, site, focus, subject] = department;
  const base = {
    id: `${industry.id}-${departmentId}-S${variant + 1}`, industryId: industry.id,
    industryName: industry.name, departmentId, departmentName, company: industry.company,
    site, focus, subject,
  };
  if (variant === 0) {
    const primaryDepartment = DEPARTMENTS[industry.id][0][0] === departmentId;
    if (primaryDepartment) return {
      ...base, site: industry.site, subject: industry.subject,
      governance: industry.governance, technical: industry.technical,
      planning: industry.planning, operations: industry.operations,
      incident: industry.incident, commercial: industry.commercial,
    };
    return {
      ...base,
      governance: [`${focus}の重要変更承認`, "担当課長の単独承認でよい", "部門長と統制責任者の二者承認を得る"],
      technical: [`${subject}の重要設定変更後の確認期限`, "一営業日以内", "四時間以内"],
      planning: [`${focus}業務の標準化`, "全対象を同日に切り替える", `${site}の代表案件から段階的に導入する`, "業務影響と処理品質を段階ごとに比較できるため"],
      operations: [`${focus}の重要案件レビュー`, "受付後一営業日以内に実施する", `${departmentId.toUpperCase()}-PR-1`, "受付後二時間以内に実施する"],
      incident: [`${focus}処理の状態表示誤り`, "状態更新イベントの順序逆転", "対象記録を原記録から再同期した", "更新世代を照合する整合性検査を追加する"],
      commercial: [`${focus}支援契約-${departmentId.toUpperCase()}`, "重要依頼の一次応答は四時間以内", `${subject}に関する一次応答は一時間以内`, "すべての依頼へ十五分以内に応答する"],
    };
  }
  if (variant === 1) return {
    ...base,
    governance: [`${focus}の例外申請`, "担当課長の単独承認でよい", "部門長と統制責任者の二者承認を得る"],
    technical: [`${subject}の設定変更反映期限`, "五営業日以内", "二営業日以内"],
    planning: [`${focus}業務の自動化`, "全対象へ一括適用する", `${site}の代表業務で二段階導入する`, "誤処理率と作業時間を段階ごとに比較できるため"],
    operations: [`${focus}の管理記録確認`, "週に一回実施する", `${departmentId.toUpperCase()}-EX-2`, "毎営業日の終了時に実施する"],
    incident: [`${focus}データの反映遅延`, "更新ジョブの排他待ち", "対象ジョブを順番に再実行した", "更新単位を分割し滞留監視を追加する"],
    commercial: [`${focus}業務委託契約-${departmentId.toUpperCase()}`, "月次報告を五営業日以内に提出する", `${subject}の報告は二営業日以内に提出する`, "すべての報告を当日中に提出する"],
  };
  return {
    ...base,
    governance: [`${focus}記録の保存期間`, "二年間保存する", "五年間保存する"],
    technical: [`${subject}の監視データ保持期間`, "30日", "90日"],
    planning: [`${focus}の記録基盤更改`, "共有フォルダーを継続利用する", `${site}専用の監査付き記録領域へ移行する`, "変更履歴と閲覧権限を一体で追跡できるため"],
    operations: [`${focus}の月次照合`, "月末に一回実施する", `${departmentId.toUpperCase()}-AUD-3`, "毎週金曜日に実施する"],
    incident: [`${focus}記録の一部欠落`, "保存処理と締め処理の競合", "欠落対象を原記録から再登録した", "締め完了後に保存確認を行う制御を追加する"],
    commercial: [`${focus}記録保管契約-${departmentId.toUpperCase()}`, "契約終了後三年間保管する", `${subject}の監査記録は七年間保管する`, "すべての記録を無期限保管する"],
  };
}

export function buildDomains() {
  const domains = [];
  for (const industry of INDUSTRIES) {
    for (const department of DEPARTMENTS[industry.id]) {
      const [departmentId, departmentName, site, focus, subject] = department;
      domains.push({
        id: `${industry.id}-${departmentId}`, industryId: industry.id, industryName: industry.name,
        departmentId, departmentName, company: industry.company, site, focus, subject,
        scenarios: [0, 1, 2].map((variant) => scenarioFor(industry, department, variant)),
      });
    }
  }
  return domains;
}

function document(industry, purpose, code, title, type, status, authority, sections, extra = {}) {
  const id = `ENT-${industry.id.toUpperCase()}-${purpose.toUpperCase().replaceAll("_", "-")}-${code}`;
  return {
    id, relativePath: relPath(industry, purpose, code.toLowerCase()), title,
    industry: industry.industryId, industryName: industry.industryName,
    department: industry.departmentId, departmentName: industry.departmentName,
    scenario: industry.id, company: industry.company, purpose, type, status, authority,
    owner: extra.owner ?? `${industry.departmentName}責任者`, approved: extra.approved ?? true,
    force: extra.force ?? "informational", forceRank: extra.forceRank ?? 5,
    validFrom: extra.validFrom ?? "2026-04-01", validTo: extra.validTo,
    scope: extra.scope ?? { organization: industry.company }, officialRecord: extra.officialRecord ?? false,
    version: extra.version, sections,
  };
}

const section = (heading, anchor, guidance) => ({ heading, anchor, guidance });
const evidence = (doc, heading, terms) => ({ source: `sources/${doc.relativePath}`, document_id: doc.id, section: heading, content_terms: terms });

function question(industry, purpose, number, text, expected, requiredEvidence, forbidden, relations, tags, extra = {}) {
  return {
    id: `ENT-Q-${industry.id.toUpperCase()}-${purpose.toUpperCase().replaceAll("_", "-")}-${number}`,
    industry: industry.industryId, department: industry.departmentId, scenario: industry.id,
    purpose, intent_id: extra.intent ?? purpose,
    question: text, as_of: extra.asOf ?? "2026-07-15", scope: extra.scope ?? { organization: industry.company },
    expected_behavior: extra.behavior ?? "answer_with_provenance",
    expected_answer_elements: expected, required_evidence: requiredEvidence,
    forbidden_answer_elements: forbidden, required_relations: relations, tags: [industry.id, purpose, ...tags],
  };
}

function addGovernance(industry, model) {
  const [topic, oldRule, currentRule] = industry.governance;
  const old = document(industry, "governance", "POL-V1", `${topic}規程 第1版`, "policy", "superseded", "corporate_policy", [
    section("目的", `本規程は${topic}を定める。`, "旧制度が必要とされた背景を説明する。"),
    section("承認規則", `2025年4月1日から2026年3月31日まで、${topic}は${oldRule}。`, "旧規則の運用場面を説明する。"),
    section("適用期間", "本版の適用は2026年3月31日に終了した。", "改訂日を混同しない注意を書く。"),
  ], { validFrom: "2025-04-01", validTo: "2026-03-31", version: "1.0", force: "mandatory", forceRank: 9 });
  const current = document(industry, "governance", "POL-V2", `${topic}規程 第2版`, "policy", "current", "corporate_policy", [
    section("目的", `本規程は${topic}の現行要件を定める。`, "統制目的を説明する。"),
    section("現行規則", `2026年4月1日以降、${topic}は${currentRule}。`, "現行手続きを説明する。"),
    section("旧版の扱い", "第2版は第1版を全面的に置き換える。", "旧版参照時の注意を書く。"),
  ], { version: "2.0", force: "mandatory", forceRank: 9 });
  const faq = document(industry, "governance", "FAQ", `${topic}現場FAQ`, "faq", "stale", "local_guidance", [
    section("質問", `${topic}について現場から寄せられた質問を扱う。`, "問い合わせの状況を書く。"),
    section("旧案内", `このFAQでは${topic}を「${oldRule}」と案内している。`, "案内の読み方を書く。"),
    section("更新状況", "このFAQは第2版の改訂を反映していない。", "正式規程を優先する注意を書く。"),
  ], { forceRank: 3 });
  const approval = document(industry, "governance", "APPROVAL", `${topic}改訂承認記録`, "approval_record", "approved", "official_record", [
    section("承認対象", `承認対象は${topic}規程 第2版である。`, "審議対象の識別方法を書く。"),
    section("決定", `第2版を2026年4月1日から施行することを承認した。`, "決定記録の性質を書く。"),
    section("記録", "本記録は承認会議の正式記録である。", "証跡の保管について説明する。"),
  ], { officialRecord: true, forceRank: 8 });
  model.documents.push(old, current, faq, approval);
  model.relations.push(
    { id: `${current.id}-R1`, kind: "supersedes", subject: current.id, object: old.id, effective_from: "2026-04-01", scope: current.scope },
    { id: `${faq.id}-R1`, kind: "conflicts_with", subject: faq.id, object: current.id, status: "resolved_by_authority_and_time", scope: current.scope },
    { id: `${approval.id}-R1`, kind: "approves", subject: approval.id, object: current.id, effective_from: "2026-04-01", scope: current.scope },
  );
  model.questions.push(
    question(industry, "governance", 1, `2026年7月時点で${topic}にはどの規則を適用しますか。`, [currentRule, "第2版を適用"], [evidence(current, "現行規則", [topic, currentRule]), evidence(old, "適用期間", ["2026年3月31日", "終了"])], [`現行規則は${oldRule}`], [current.id + " supersedes " + old.id], ["version", "authority", "current-rule"]),
    question(industry, "governance", 2, `${topic}のFAQと正式規程が食い違う場合、どう扱いますか。`, ["FAQは第2版を反映していない", currentRule, "正式規程を優先"], [evidence(faq, "更新状況", ["第2版", "反映していない"]), evidence(current, "現行規則", [currentRule])], [oldRule + "を現行規則として断定"], [faq.id + " conflicts_with " + current.id], ["conflict", "stale-guidance", "multi-document"], { behavior: "answer_with_conflict_disclosure" }),
  );
}

function addTechnical(industry, model) {
  const [topic, baseValue, amendedValue] = industry.technical;
  const base = document(industry, "technical_spec", "SPEC-V3", `${industry.subject} 技術仕様 第3版`, "technical_specification", "current", "engineering_standard", [
    section("対象", `本仕様の対象は${industry.subject}である。`, "対象設備と境界を説明する。"),
    section("基準値", `${topic}の基準値は${baseValue}とする。`, "測定条件を一般的に説明する。"),
    section("変更管理", "承認済み追補がある場合は該当条項へ追補を適用する。", "追補確認の必要性を書く。"),
  ], { version: "3.0", force: "mandatory", forceRank: 9, scope: { organization: industry.company, product: industry.subject } });
  const amendment = document(industry, "technical_spec", "AMD-01", `${industry.subject} 技術仕様 追補1`, "specification_amendment", "current", "engineering_standard", [
    section("対象条項", `本追補は「${topic}」の条項だけを変更する。`, "変更範囲が限定されることを書く。"),
    section("変更値", `2026年6月1日以降、${topic}は${amendedValue}とする。`, "変更後の検証方法を説明する。"),
    section("非変更部分", "追補に記載のない条項は技術仕様 第3版を維持する。", "部分改訂の読み方を書く。"),
  ], { version: "3.0-A1", validFrom: "2026-06-01", force: "mandatory", forceRank: 9, scope: { organization: industry.company, product: industry.subject, clause: topic } });
  const draft = document(industry, "technical_spec", "DRAFT-V4", `${industry.subject} 技術仕様 第4版案`, "technical_draft", "draft", "working_draft", [
    section("検討目的", `${topic}の次期改訂を検討するための草案である。`, "草案の目的を書く。"),
    section("候補値", `${topic}について${amendedValue}とは異なる候補も比較中である。`, "候補が未確定であることを書く。"),
    section("承認状態", "第4版案は未承認であり運用へ適用してはならない。", "正式仕様との区別を書く。"),
  ], { approved: false, force: "proposed", forceRank: 2, validFrom: "2026-07-01", scope: { organization: industry.company, product: industry.subject } });
  const test = document(industry, "technical_spec", "TEST", `${industry.subject} 追補適合試験記録`, "test_record", "passed", "official_record", [
    section("試験対象", `試験対象は${industry.subject}の追補1適用個体である。`, "供試体の識別について書く。"),
    section("判定", `${topic}を${amendedValue}として適合を確認した。`, "判定が記録であることを書く。"),
    section("記録性", "本書は試験実施結果であり仕様そのものを変更しない。", "規範と記録の違いを書く。"),
  ], { officialRecord: true, force: "informational", forceRank: 7, scope: { organization: industry.company, product: industry.subject } });
  model.documents.push(base, amendment, draft, test);
  model.relations.push(
    { id: `${amendment.id}-R1`, kind: "amends", subject: amendment.id, object: base.id, clause: topic, effective_from: "2026-06-01", scope: amendment.scope },
    { id: `${test.id}-R1`, kind: "records_execution_of", subject: test.id, object: amendment.id, scope: test.scope },
    { id: `${draft.id}-R1`, kind: "proposes_change_to", subject: draft.id, object: base.id, status: "unapproved", scope: draft.scope },
  );
  model.questions.push(
    question(industry, "technical_spec", 1, `2026年7月の${industry.subject}で、${topic}はいくつですか。`, [amendedValue, "追補1が該当条項を変更"], [evidence(amendment, "変更値", [topic, amendedValue]), evidence(base, "変更管理", ["承認済み追補", "適用"])], [`${baseValue}だけを最終値とする`], [amendment.id + " amends " + base.id], ["amendment", "clause-scope", "numeric-fact"]),
    question(industry, "technical_spec", 2, `第4版案と適合試験記録は、${topic}の現行仕様を変更しますか。`, ["第4版案は未承認", "試験記録は仕様を変更しない", amendedValue], [evidence(draft, "承認状態", ["未承認", "適用してはならない"]), evidence(test, "記録性", ["仕様そのものを変更しない"]), evidence(amendment, "変更値", [amendedValue])], ["第4版案を現行仕様として適用", "試験記録を規程として扱う"], [draft.id + " proposes_change_to " + base.id, test.id + " records_execution_of " + amendment.id], ["proposal-vs-rule", "record-vs-norm", "multi-document"]),
  );
}

function addPlanning(industry, model) {
  const [project, rejected, selected, reason] = industry.planning;
  const proposal = document(industry, "planning", "PROPOSAL", `${project} 初期提案書`, "proposal", "draft", "project_team", [
    section("背景", `${project}の初期検討を行う。`, "業務上の背景を書く。"),
    section("初期案", `初期案では「${rejected}」を提案した。`, "初期案の狙いを書く。"),
    section("状態", "本提案は採否決定前の案である。", "決裁資料ではないことを書く。"),
  ], { approved: false, force: "proposed", forceRank: 2 });
  const analysis = document(industry, "planning", "ANALYSIS", `${project} 方式比較資料`, "options_analysis", "reviewed", "analysis", [
    section("比較対象", `「${rejected}」と「${selected}」を比較した。`, "比較観点を書く。"),
    section("評価", `「${selected}」は${reason}、評価上優位である。`, "評価の前提を書く。"),
    section("限界", "本資料は比較結果であり最終決定そのものではない。", "分析と決定の違いを書く。"),
  ], { forceRank: 5 });
  const minutes = document(industry, "planning", "DECISION", `${project} 投資審議会議事録`, "decision_minutes", "approved", "official_record", [
    section("議題", `${project}の実施方式を審議した。`, "会議の目的を書く。"),
    section("決定", `${project}では「${selected}」を正式採用した。`, "採択の結果を書く。"),
    section("理由", `採用理由は${reason}。`, "判断根拠の位置づけを書く。"),
  ], { officialRecord: true, forceRank: 8 });
  const plan = document(industry, "planning", "PLAN", `${project} 承認済み実施計画`, "implementation_plan", "current", "approved_plan", [
    section("採用方式", `実施方式は「${selected}」とする。`, "計画上の方式を説明する。"),
    section("不採用案", `「${rejected}」は実施対象に含めない。`, "不採用案との境界を書く。"),
    section("進捗管理", "実施結果は段階ごとの完了記録で確認する。", "確認方法を書く。"),
  ], { force: "mandatory", forceRank: 7 });
  model.documents.push(proposal, analysis, minutes, plan);
  model.relations.push(
    { id: `${analysis.id}-R1`, kind: "evaluates", subject: analysis.id, object: proposal.id, scope: analysis.scope },
    { id: `${minutes.id}-R1`, kind: "approves", subject: minutes.id, object: plan.id, scope: minutes.scope },
    { id: `${plan.id}-R1`, kind: "implements_decision", subject: plan.id, object: minutes.id, scope: plan.scope },
  );
  model.questions.push(
    question(industry, "planning", 1, `${project}で正式採用された方式と理由は何ですか。`, [selected, reason, "正式採用"], [evidence(minutes, "決定", [project, selected]), evidence(minutes, "理由", [reason])], [`${rejected}を正式採用`], [minutes.id + " approves " + plan.id], ["proposal-vs-decision", "decision-history"]),
    question(industry, "planning", 2, `初期提案の「${rejected}」は現在も実施対象ですか。`, ["実施対象に含めない", selected, "初期提案は採否決定前"], [evidence(proposal, "状態", ["採否決定前"]), evidence(plan, "不採用案", [rejected, "実施対象に含めない"])], [`${rejected}が現行計画`], [plan.id + " implements_decision " + minutes.id], ["rejected-option", "timeline", "multi-document"]),
  );
}

function addOperations(industry, model) {
  const [procedure, baseRule, exceptionScope, exceptionRule] = industry.operations;
  const standard = document(industry, "operations", "PROCEDURE", `${procedure} 全社手順`, "operating_procedure", "current", "corporate_standard", [
    section("対象", `本手順は${procedure}の標準運用を定める。`, "標準適用範囲を書く。"),
    section("頻度", `${procedure}は${baseRule}。`, "実施記録について書く。"),
    section("例外", "承認済みの期限付き逸脱がある場合だけ、その適用範囲で例外を認める。", "例外の限定性を書く。"),
  ], { force: "mandatory", forceRank: 9 });
  const local = document(industry, "operations", "SITE-WI", `${industry.site} ${procedure}作業指示`, "work_instruction", "current", "site_instruction", [
    section("適用場所", `本作業指示は${industry.site}に適用する。`, "現場固有の準備を書く。"),
    section("実施", `${industry.site}でも通常は${procedure}を${baseRule}。`, "担当者の確認方法を書く。"),
    section("上位手順", "全社手順と矛盾する場合は全社手順を優先する。", "文書階層を書く。"),
  ], { force: "mandatory", forceRank: 7, scope: { organization: industry.company, site: industry.site } });
  const deviation = document(industry, "operations", "DEVIATION", `${procedure} 一時逸脱承認`, "temporary_deviation", "active", "approved_exception", [
    section("適用対象", `本逸脱は${industry.site}の${exceptionScope}だけに適用する。`, "対象識別を説明する。"),
    section("例外規則", `2026年7月1日から2026年7月31日まで、${exceptionScope}では${procedure}を${exceptionRule}。`, "期限内の運用を書く。"),
    section("非対象", `${exceptionScope}以外には全社手順の「${baseRule}」を適用する。`, "例外の拡張禁止を書く。"),
  ], { validFrom: "2026-07-01", validTo: "2026-07-31", force: "mandatory", forceRank: 8, scope: { organization: industry.company, site: industry.site, case: exceptionScope } });
  const log = document(industry, "operations", "LOG", `${exceptionScope} 作業実施記録`, "execution_log", "completed", "official_record", [
    section("対象", `実施対象は${exceptionScope}である。`, "対象記録の確認について書く。"),
    section("実施結果", `${procedure}を${exceptionRule}ことを記録した。`, "実施記録の内容を書く。"),
    section("位置づけ", "本記録は実施証跡であり逸脱の適用範囲を変更しない。", "証跡と規範の違いを書く。"),
  ], { officialRecord: true, forceRank: 7, scope: { organization: industry.company, site: industry.site, case: exceptionScope } });
  model.documents.push(standard, local, deviation, log);
  model.relations.push(
    { id: `${local.id}-R1`, kind: "applies_to", subject: local.id, object: standard.id, scope: local.scope },
    { id: `${deviation.id}-R1`, kind: "exception_to", subject: deviation.id, object: standard.id, effective_from: "2026-07-01", effective_to: "2026-07-31", scope: deviation.scope },
    { id: `${log.id}-R1`, kind: "records_execution_of", subject: log.id, object: deviation.id, scope: log.scope },
  );
  model.questions.push(
    question(industry, "operations", 1, `2026年7月15日に${industry.site}の${exceptionScope}で${procedure}はどの頻度で行いますか。`, [exceptionRule, "期限付き逸脱", exceptionScope], [evidence(deviation, "例外規則", [exceptionScope, exceptionRule]), evidence(deviation, "適用対象", [industry.site, "だけ"])], [baseRule + "だけを適用"], [deviation.id + " exception_to " + standard.id], ["scoped-exception", "temporal"]),
    question(industry, "operations", 2, `2026年7月15日に${exceptionScope}以外で${procedure}の頻度は変わりますか。`, ["変わらない", baseRule, `${exceptionScope}だけが例外`], [evidence(deviation, "非対象", [exceptionScope, baseRule]), evidence(standard, "頻度", [procedure, baseRule])], [exceptionRule + "を全対象へ適用"], [deviation.id + " exception_to " + standard.id], ["negative-scope", "exception-boundary"]),
  );
}

function addIncident(industry, model) {
  const [incident, cause, workaround, permanent] = industry.incident;
  const initial = document(industry, "incident_change", "INITIAL", `${incident} 初報`, "incident_report", "open", "operations_record", [
    section("事象", `${incident}を2026年6月18日09時10分に検知した。`, "検知経路を書く。"),
    section("初期見解", "初報時点の原因は未確認である。", "推測を確定しない注意を書く。"),
    section("初動", `暫定対応として${workaround}。`, "影響抑制の状況を書く。"),
  ], { officialRecord: true, forceRank: 6 });
  const final = document(industry, "incident_change", "FINAL", `${incident} 最終報`, "incident_report", "closed", "official_record", [
    section("確定原因", `${incident}の確定原因は${cause}である。`, "調査完了の意味を書く。"),
    section("暫定対応", `復旧時には${workaround}。`, "暫定措置の限界を書く。"),
    section("終結", "本最終報は初報の未確認事項を更新する。", "時系列上の優先を説明する。"),
  ], { officialRecord: true, forceRank: 8 });
  const change = document(industry, "incident_change", "CHANGE", `${incident} 恒久対策変更申請`, "change_request", "approved", "change_control", [
    section("変更理由", `変更理由は${cause}の再発防止である。`, "変更が必要な理由を書く。"),
    section("変更内容", `恒久対策として${permanent}。`, "変更範囲を書く。"),
    section("承認", "本変更申請は変更諮問会議で承認済みである。", "承認状態を書く。"),
  ], { force: "mandatory", forceRank: 7 });
  const release = document(industry, "incident_change", "RELEASE", `${incident} 恒久対策リリース記録`, "release_record", "completed", "official_record", [
    section("実施内容", `${permanent}対応を2026年7月5日に本番適用した。`, "実施時刻と対象の確認を書く。"),
    section("確認", "本番適用後の再発がないことを監視で確認した。", "確認期間を書く。"),
    section("位置づけ", "本記録は変更申請の実施証跡である。", "承認文書との関係を書く。"),
  ], { officialRecord: true, forceRank: 8, validFrom: "2026-07-05" });
  model.documents.push(initial, final, change, release);
  model.relations.push(
    { id: `${final.id}-R1`, kind: "supersedes", subject: final.id, object: initial.id, scope: final.scope },
    { id: `${change.id}-R1`, kind: "derived_from", subject: change.id, object: final.id, scope: change.scope },
    { id: `${release.id}-R1`, kind: "records_execution_of", subject: release.id, object: change.id, effective_from: "2026-07-05", scope: release.scope },
  );
  model.questions.push(
    question(industry, "incident_change", 1, `${incident}の確定原因と復旧時の暫定対応は何ですか。`, [cause, workaround, "最終報が初報を更新"], [evidence(final, "確定原因", [incident, cause]), evidence(final, "暫定対応", [workaround])], ["初報時点の原因を確定原因とする"], [final.id + " supersedes " + initial.id], ["incident-timeline", "confirmed-cause"]),
    question(industry, "incident_change", 2, `恒久対策「${permanent}」は提案だけですか、それとも実施済みですか。`, ["承認済み", "2026年7月5日に本番適用", "実施済み"], [evidence(change, "承認", ["承認済み"]), evidence(release, "実施内容", [permanent, "2026年7月5日", "本番適用"])], ["未承認", "未実施"], [release.id + " records_execution_of " + change.id], ["change-control", "proposal-vs-execution", "multi-document"]),
  );
}

function addCommercial(industry, model) {
  const [contract, masterTerm, sowTerm, vendorTerm] = industry.commercial;
  const master = document(industry, "commercial_compliance", "MASTER", `${contract} 基本契約`, "master_agreement", "current", "executed_contract", [
    section("契約対象", `本契約は${contract}の共通条件を定める。`, "契約範囲を書く。"),
    section("標準条件", `${contract}では${masterTerm}。`, "標準サービス条件を書く。"),
    section("優先順位", "個別契約で対象を明示して変更した条件は、その対象に限り基本契約より優先する。", "文書優先関係を書く。"),
  ], { force: "mandatory", forceRank: 9, officialRecord: true, scope: { organization: industry.company, contract } });
  const sow = document(industry, "commercial_compliance", "SOW", `${contract} 個別契約書`, "statement_of_work", "current", "executed_contract", [
    section("対象", `本個別契約は${industry.subject}に関する業務を対象とする。`, "限定された契約対象を書く。"),
    section("個別条件", `${industry.subject}については${sowTerm}。`, "個別条件を書く。"),
    section("優先", "本個別条件は対象範囲に限り基本契約の標準条件に優先する。", "優先範囲を書く。"),
  ], { force: "mandatory", forceRank: 9, officialRecord: true, scope: { organization: industry.company, contract, product: industry.subject } });
  const proposal = document(industry, "commercial_compliance", "VENDOR-PROPOSAL", `${contract} 供給元改善提案`, "vendor_proposal", "proposed", "external_proposal", [
    section("提案", `供給元は「${vendorTerm}」とする改善案を提示した。`, "供給元の意図を書く。"),
    section("契約状態", "この改善案は契約変更として署名されていない。", "法的状態を書く。"),
    section("適用", "未署名の提案を契約上の義務として扱ってはならない。", "提案と契約の区別を書く。"),
  ], { approved: false, force: "proposed", forceRank: 1, scope: { organization: industry.company, contract } });
  const audit = document(industry, "commercial_compliance", "AUDIT", `${contract} 履行監査記録`, "audit_record", "completed", "official_record", [
    section("監査対象", `監査対象は${contract}および${industry.subject}の個別契約である。`, "監査範囲を書く。"),
    section("評価基準", `${industry.subject}の評価には「${sowTerm}」を用いた。`, "適用条項の選択を書く。"),
    section("記録性", "本書は履行評価の記録であり契約条件を新設しない。", "監査記録の効力を書く。"),
  ], { officialRecord: true, forceRank: 7, scope: { organization: industry.company, contract, product: industry.subject } });
  model.documents.push(master, sow, proposal, audit);
  model.relations.push(
    { id: `${sow.id}-R1`, kind: "order_of_precedence", subject: sow.id, object: master.id, clause: sowTerm, scope: sow.scope },
    { id: `${proposal.id}-R1`, kind: "proposes_change_to", subject: proposal.id, object: master.id, status: "unsigned", scope: proposal.scope },
    { id: `${audit.id}-R1`, kind: "records_execution_of", subject: audit.id, object: sow.id, scope: audit.scope },
  );
  model.questions.push(
    question(industry, "commercial_compliance", 1, `${industry.subject}について${contract}の適用条件は何ですか。`, [sowTerm, "個別契約が対象範囲で優先"], [evidence(sow, "個別条件", [industry.subject, sowTerm]), evidence(master, "優先順位", ["個別契約", "優先"])], [masterTerm + "だけを適用"], [sow.id + " order_of_precedence " + master.id], ["contract-hierarchy", "scope"]),
    question(industry, "commercial_compliance", 2, `供給元提案の「${vendorTerm}」は現在の契約義務ですか。`, ["契約義務ではない", "契約変更として未署名", sowTerm], [evidence(proposal, "契約状態", ["署名されていない"]), evidence(proposal, "適用", ["契約上の義務", "扱ってはならない"]), evidence(sow, "個別条件", [sowTerm])], [vendorTerm + "が現行の契約義務"], [proposal.id + " proposes_change_to " + master.id], ["proposal-vs-contract", "authority", "abstention"]),
  );
}

export function buildCorpusModel() {
  const model = { documents: [], profiles: [], relations: [], questions: [] };
  for (const domain of buildDomains()) {
    for (const scenario of domain.scenarios) {
      addGovernance(scenario, model);
      addTechnical(scenario, model);
      addPlanning(scenario, model);
      addOperations(scenario, model);
      addIncident(scenario, model);
      addCommercial(scenario, model);
    }
  }
  model.profiles = model.documents.map((doc) => ({
    source_id: doc.id, relative_path: `sources/${doc.relativePath}`, industry: doc.industry,
    department: doc.department, scenario: doc.scenario, purpose: doc.purpose,
    role: doc.type, force: { level: doc.force, rank: doc.forceRank, approved: doc.approved },
    scope: doc.scope, time: { valid_from: doc.validFrom, valid_to: doc.validTo ?? null },
    authority: doc.authority, official_record: doc.officialRecord, status: doc.status, version: doc.version ?? null,
  }));
  if (model.documents.length !== EXPECTED.documents || model.questions.length !== EXPECTED.questions) {
    throw new Error(`unexpected model size: ${model.documents.length} documents, ${model.questions.length} questions`);
  }
  return model;
}

function yaml(doc, model) {
  const fields = {
    document_id: doc.id, title: doc.title, company: doc.company, industry: doc.industry,
    department: doc.department, department_name: doc.departmentName, scenario: doc.scenario,
    purpose: doc.purpose, document_type: doc.type, status: doc.status, authority: doc.authority,
    owner: doc.owner, approved: doc.approved, force: doc.force, force_rank: doc.forceRank,
    valid_from: doc.validFrom, valid_to: doc.validTo, version: doc.version,
    official_record: doc.officialRecord, scope: doc.scope, synthetic: true, generation_model: model,
  };
  return `---\n${Object.entries(fields).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}: ${quote(value)}`).join("\n")}\n---\n\n`;
}

const contextKey = (doc) => `${doc.scenario}::${doc.purpose}`;
const groundedTokens = (text) => new Set([
  ...(text.match(/\d+(?:[.,]\d+)*/g) ?? []),
  ...(text.match(/[A-Z]{2,}-(?:[A-Z0-9]+-?)+/g) ?? []),
]);
function fallbackParagraph(doc, item) {
  return `${doc.company}における${doc.title}の背景と参照上の注意を整理する。ここで示す説明は、直後の確定記述の意味や効力を変更しない。`;
}

function renderDocument(doc, paragraphs, model) {
  const body = doc.sections.map((item, index) => {
    const generated = index === 0
      ? paragraphs.get(contextKey(doc)) ?? fallbackParagraph(doc, item)
      : `この節では、${item.guidance} 記載された確定事項と文書の適用範囲を合わせて確認する。`;
    return `## ${item.heading}\n\n${generated}\n\n${item.anchor}`;
  }).join("\n\n");
  return `${yaml(doc, model)}# ${doc.title}\n\n> 架空の評価用社内文書です。固有名詞・制度・数値は実在組織と無関係です。\n\n${body}\n`;
}

function promptFor(batch) {
  const groups = new Map();
  for (const doc of batch) {
    const key = contextKey(doc);
    if (!groups.has(key)) groups.set(key, { id: key, company: doc.company, industry: doc.industryName, department: doc.departmentName, purpose: doc.purpose, titles: [], fixed_facts: [] });
    groups.get(key).titles.push(doc.title);
    groups.get(key).fixed_facts.push(...doc.sections.map(({ anchor }) => anchor));
  }
  return `あなたは架空企業の社内文書編集者です。入力された関連文書群ごとに、4文書が共有できる自然な業務背景の段落を一つ作ってください。\n` +
    `導入段落は80〜180文字とし、業務背景、想定読者、確認方法、文書らしい言い回しに変化を付けます。\n` +
    `fixed_factsの事実を要約してよいですが、入力にない日付、数値、期間、閾値、人名、採否、承認状態、適用範囲、原因、義務を追加してはいけません。\n` +
    `見出し、Markdown、箇条書き、前置きは出力しません。JSON以外を返してはいけません。\n` +
    `形式: {"items":[{"id":"...","summary":"..."}]}\n入力:${JSON.stringify([...groups.values()])}`;
}

function parseParagraphs(raw, batch) {
  const parsed = JSON.parse(raw.response);
  const allowed = new Set(batch.map(contextKey));
  const allowedFacts = new Map();
  for (const doc of batch) {
    const key = contextKey(doc);
    const text = [doc.title, ...doc.sections.map((item) => item.anchor)].join("\n");
    allowedFacts.set(key, `${allowedFacts.get(key) ?? ""}\n${text}`);
  }
  const paragraphs = new Map();
  for (const item of parsed.items ?? []) {
    if (!allowed.has(item.id)) continue;
    const paragraph = String(item.summary ?? "").trim();
    if (paragraph.length < 30 || paragraph.length > 600 || paragraph.includes("#")) continue;
    const ungrounded = [...groundedTokens(paragraph)]
      .some((token) => !allowedFacts.get(item.id).includes(token));
    if (ungrounded) continue;
    paragraphs.set(item.id, paragraph);
  }
  return paragraphs;
}

function cacheKey(options, prompt) {
  const compilationSettings = {
    schema: "enterprise-diverse-v4-safe-context-id", model: options.model, seed: options.seed,
    model_digest: options.modelDigest ?? null, endpoint: options.endpoint,
    temperature: options.temperature, num_ctx: 8192,
  };
  return crypto.createHash("sha256").update(JSON.stringify(compilationSettings)).update("\u0000").update(prompt).digest("hex");
}

export function stableContextSeed(baseSeed, key, retry = 0) {
  const digest = crypto.createHash("sha256").update(key).digest();
  const contextValue = digest.readUInt32BE(0);
  return (baseSeed + contextValue + retry * 104729) % 2147483647;
}

async function resolveModelDigest(options) {
  const response = await fetch(`${options.endpoint}/api/tags`);
  if (!response.ok) throw new Error(`Ollama tags HTTP ${response.status}: ${await response.text()}`);
  const payload = await response.json();
  const model = (payload.models ?? []).find((item) => item.name === options.model || item.model === options.model);
  if (!model?.digest) throw new Error(`Ollama model not found: ${options.model}`);
  return model.digest;
}

async function enrich(batch, options) {
  const prompt = promptFor(batch);
  const key = cacheKey(options, prompt);
  const cacheFile = path.join(cacheRoot, `${key}.json`);
  let raw;
  if (!options.noCache && fs.existsSync(cacheFile)) {
    raw = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    const paragraphs = parseParagraphs(raw, batch);
    if (paragraphs.size === new Set(batch.map(contextKey)).size) {
      return { paragraphs, cached: true, metrics: { cache_key: key } };
    }
  }
  const response = await fetch(`${options.endpoint}/api/generate`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: options.model, stream: false, format: "json", keep_alive: "30m",
      options: { temperature: options.temperature, seed: options.seed, num_ctx: 8192, num_predict: Math.min(4096, batch.length * 220) }, prompt,
    }),
  });
  if (!response.ok) throw new Error(`Ollama HTTP ${response.status}: ${await response.text()}`);
  raw = await response.json();
  fs.mkdirSync(cacheRoot, { recursive: true });
  fs.writeFileSync(cacheFile, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  return {
    paragraphs: parseParagraphs(raw, batch), cached: false,
    metrics: { cache_key: key, total_duration: raw.total_duration, prompt_eval_count: raw.prompt_eval_count, eval_count: raw.eval_count },
  };
}

function validDocument(doc, text, contextDocuments = [doc]) {
  const structural = doc.sections.every((item) => text.includes(`## ${item.heading}`) && text.includes(item.anchor)) && text.includes(`document_id: ${quote(doc.id)}`);
  if (!structural || text.includes("undefined")) return false;
  const first = doc.sections[0];
  const marker = `## ${first.heading}\n\n`;
  const start = text.indexOf(marker);
  const end = text.indexOf(`\n\n${first.anchor}`, start + marker.length);
  if (start < 0 || end < 0) return false;
  const generated = text.slice(start + marker.length, end);
  const allowedFacts = contextDocuments.flatMap((item) => [item.title, ...item.sections.map((value) => value.anchor)]).join("\n");
  return [...groundedTokens(generated)].every((token) => allowedFacts.includes(token));
}

function writeJsonl(file, items) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${items.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
}

function writeMetadata(model, options) {
  writeJsonl(path.join(corpusRoot, "world", "documents.jsonl"), model.documents.map((doc) => ({
    document_id: doc.id, relative_path: `sources/${doc.relativePath}`, title: doc.title,
    industry: doc.industry, department: doc.department, scenario: doc.scenario, purpose: doc.purpose,
    anchors: doc.sections.map((item) => ({ section: item.heading, text: item.anchor })),
  })));
  writeJsonl(path.join(corpusRoot, "gold", "profiles.jsonl"), model.profiles);
  writeJsonl(path.join(corpusRoot, "gold", "relations.jsonl"), model.relations);
  writeJsonl(path.join(corpusRoot, "evaluation", "questions.jsonl"), model.questions);
  writeJsonl(path.join(corpusRoot, "gold", "answers.jsonl"), model.questions.map((item) => ({
    question_id: item.id, expected_behavior: item.expected_behavior,
    required_answer_elements: item.expected_answer_elements,
    prohibited_conclusions: item.forbidden_answer_elements,
    gold_evidence: item.required_evidence, required_relations: item.required_relations,
  })));
  const domains = buildDomains().map((domain) => {
    const documents = model.documents.filter((doc) => doc.industry === domain.industryId && doc.department === domain.departmentId);
    const questions = model.questions.filter((item) => item.industry === domain.industryId && item.department === domain.departmentId);
    return {
      domain_id: domain.id, industry: domain.industryId, industry_name: domain.industryName,
      department: domain.departmentId, department_name: domain.departmentName,
      company: domain.company, source_prefix: `sources/${domain.industryId}/${domain.departmentId}/`,
      document_count: documents.length, question_count: questions.length,
      document_ids: documents.map((doc) => doc.id), question_ids: questions.map((item) => item.id),
      intent_ids: INTENTS.map((intent) => intent.id),
      comparison_conditions: ["raw", "claim", "dossier"],
    };
  });
  writeJsonl(path.join(corpusRoot, "evaluation", "rag-domains.jsonl"), domains);
  for (const intent of INTENTS) {
    const yaml = `id: ${intent.id}\n` +
      `goal: ${intent.goal}\n` +
      `users:\n${intent.users.map((item) => `  - ${item}`).join("\n")}\n` +
      `tasks:\n${intent.tasks.map((item) => `  - ${item}`).join("\n")}\n` +
      `questions:\n${intent.questions.map((item) => `  - ${item}`).join("\n")}\n` +
      `requirements:\n  evidence_required: true\n  temporal_scope_required: true\n  unresolved_conflicts_allowed: ${intent.unresolved}\n`;
    const file = path.join(corpusRoot, "intents", `${intent.id}.yaml`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, yaml, "utf8");
  }
  const manifest = {
    schema_version: "1.0", corpus_id: "fragrach-enterprise-ja-diverse", language: "ja", synthetic: true,
    license: "TBD; intended to follow the package license", generator: "scripts/generate-enterprise-diverse-corpus.mjs",
    generation_model: options.model, generation_model_digest: options.modelDigest ?? null, counts: EXPECTED,
    industries: INDUSTRIES.map(({ id, name, company }) => ({ id, name, company })),
    rag_domains: domains.map(({ domain_id, industry, department, document_count, question_count }) => ({ domain_id, industry, department, document_count, question_count })),
    purposes: PURPOSES, intents: INTENTS.map((intent) => intent.id),
    design: { documents_per_scenario_purpose: 4, questions_per_scenario_purpose: 2, gold_facts_are_deterministic: true, ollama_generates_context_only: true },
  };
  fs.writeFileSync(path.join(corpusRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const readme = `# Fragrach 多業種・多目的 日本語企業文書コーパス\n\n` +
    `Fragrachの改善が特定企業・特定文書型への過適合でないかを確認するための、完全に架空の評価用コーパスです。\n\n` +
    `- 8業種: ${INDUSTRIES.map((item) => item.name).join("、")}\n` +
    `- 40部門RAG: 各業種5部門を独立した検索領域として評価\n` +
    `- 6目的: ガバナンス、技術仕様、企画検討、業務手順、障害・変更、契約・コンプライアンス\n` +
    `- 1部門あたり72文書・36質問、合計2,880文書・1,440質問\n` +
    `- 版更新、追補、草案、決裁、期限付き例外、実施記録、契約優先順位、未署名提案を収録\n\n` +
    `本文の補足段落はOllamaで生成しますが、評価対象の事実は生成器内のWorldで固定され、原文へそのまま挿入されます。` +
    `したがって、文章表現を多様化しながらGoldの再現性を維持できます。\n\n` +
    `生成: \`npm run corpus:diverse:generate\`\n\n検証: \`npm run corpus:diverse:check\`\n\n` +
    `部門別Raw RAG評価: \`npm run benchmark:diverse:raw\`\n\n` +
    `評価設計は [部門別RAGコーパスの設計と評価方法](../../../docs/enterprise-department-rag-evaluation_ja.md) を参照してください。\n\n` +
    `生成は文書単位で再開可能で、Ollama応答もプロンプトとモデルのハッシュでキャッシュします。` +
    `事実設計やプロンプトが変わると別キーになるため、古いキャッシュを誤用しません。\n\n` +
    `ライセンスは未確定です。自作コーパスとしてパッケージ本体と同一ライセンスにする想定です。\n`;
  fs.writeFileSync(path.join(corpusRoot, "README.md"), readme, "utf8");
}

function corpusHash() {
  const files = [];
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => entry.isDirectory() ? walk(path.join(dir, entry.name)) : files.push(path.join(dir, entry.name)));
  walk(sourcesRoot);
  const hash = crypto.createHash("sha256");
  for (const file of files.sort()) {
    hash.update(path.relative(corpusRoot, file).replaceAll("\\", "/"));
    hash.update("\u0000");
    hash.update(fs.readFileSync(file));
  }
  return hash.digest("hex");
}

export async function generate(options = {}) {
  options = {
    model: "gemma4:latest", endpoint: process.env.OLLAMA_HOST || "http://127.0.0.1:11434",
    seed: 20260801, batchSize: 8, temperature: 0.35, force: false, dryRun: false, noCache: false,
    industries: null, domains: null, ...options,
  };
  const full = buildCorpusModel();
  const selectedIndustries = options.industries?.length ? new Set(options.industries) : null;
  const selectedDomains = options.domains?.length ? new Set(options.domains) : null;
  const documents = full.documents.filter((doc) =>
    (!selectedIndustries || selectedIndustries.has(doc.industry)) &&
    (!selectedDomains || selectedDomains.has(`${doc.industry}-${doc.department}`)));
  if ((selectedIndustries || selectedDomains) && documents.length === 0) {
    throw new Error(`no matching corpus selection`);
  }
  if (options.dryRun) return { ...EXPECTED, selected_documents: documents.length, relation_count: full.relations.length };
  options.modelDigest = options.modelDigest ?? await resolveModelDigest(options);
  fs.mkdirSync(corpusRoot, { recursive: true });
  writeMetadata(full, options);
  const allByContext = new Map();
  for (const doc of documents) {
    const key = contextKey(doc);
    if (!allByContext.has(key)) allByContext.set(key, []);
    allByContext.get(key).push(doc);
  }
  const reportFile = path.join(corpusRoot, "generation", "ollama-generation-report.json");
  const fallbackDocumentIds = new Set();
  if (options.repairFallbacks && fs.existsSync(reportFile)) {
    const previous = JSON.parse(fs.readFileSync(reportFile, "utf8"));
    for (const value of previous.fallback_sections ?? []) fallbackDocumentIds.add(value.split("#", 1)[0]);
  }
  const pending = documents.filter((doc) => {
    const file = path.join(sourcesRoot, ...doc.relativePath.split("/"));
    return options.force || fallbackDocumentIds.has(doc.id) || !fs.existsSync(file) || !validDocument(doc, fs.readFileSync(file, "utf8"), allByContext.get(contextKey(doc)));
  });
  if (pending.length === 0 && fs.existsSync(reportFile)) {
    return {
      ...JSON.parse(fs.readFileSync(reportFile, "utf8")), status: "up_to_date",
      requested_documents: documents.length, resumed_documents: documents.length, generated_documents: 0,
    };
  }
  const report = {
    schema_version: "1.0", corpus_id: "fragrach-enterprise-ja-diverse", model: options.model,
    model_digest: options.modelDigest,
    seed: options.seed, temperature: options.temperature, started_at: new Date().toISOString(),
    requested_documents: documents.length, resumed_documents: documents.length - pending.length,
    generated_documents: 0, fallback_sections: [], batches: [],
  };
  console.log(`Generating ${pending.length} documents; ${report.resumed_documents} already valid.`);
  const pendingByContext = new Map();
  for (const doc of pending) {
    const key = contextKey(doc);
    if (!pendingByContext.has(key)) pendingByContext.set(key, []);
    pendingByContext.get(key).push(doc);
  }
  report.generation_unit = "department-scenario-purpose relation pack";
  report.requested_contexts = pendingByContext.size;
  let completed = 0;
  for (const [key, batch] of pendingByContext) {
    const promptBatch = allByContext.get(key);
    let result = { paragraphs: new Map(), cached: false, metrics: {} };
    try {
      result = await enrich(promptBatch, { ...options, seed: stableContextSeed(options.seed, key) });
    } catch (error) {
      result.error = String(error);
    }
    const retries = [];
    for (let retryIndex = 1; retryIndex <= 3 && !result.paragraphs.has(key); retryIndex += 1) {
      try {
        const retry = await enrich(promptBatch, { ...options, seed: stableContextSeed(options.seed, key, retryIndex) });
        for (const [key, value] of retry.paragraphs) result.paragraphs.set(key, value);
        retries.push({ context_id: key, attempt: retryIndex, cached: retry.cached, ...retry.metrics });
      } catch (error) {
        retries.push({ context_id: key, attempt: retryIndex, error: String(error) });
      }
    }
    report.batches.push({ offset: completed, context_id: key, document_ids: batch.map((doc) => doc.id), cached: result.cached, error: result.error, retries, ...result.metrics });
    for (const doc of batch) {
      const first = doc.sections[0];
      if (!result.paragraphs.has(contextKey(doc))) report.fallback_sections.push(`${doc.id}#${first.heading}`);
      const file = path.join(sourcesRoot, ...doc.relativePath.split("/"));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, renderDocument(doc, result.paragraphs, options.model), "utf8");
      report.generated_documents += 1;
    }
    completed += batch.length;
    console.log(`Progress ${completed}/${pending.length}${result.cached ? " (cache)" : ""}`);
  }
  report.completed_at = new Date().toISOString();
  report.ollama_calls_in_run = report.batches.reduce((sum, batch) => sum + (!batch.cached && !batch.error ? 1 : 0) + batch.retries.filter((item) => !item.cached && !item.error).length, 0);
  report.cache_hits_in_run = report.batches.reduce((sum, batch) => sum + (batch.cached ? 1 : 0) + batch.retries.filter((item) => item.cached).length, 0);
  report.corpus_hash = corpusHash();
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--model") options.model = argv[++index];
    else if (arg === "--endpoint") options.endpoint = argv[++index].replace(/\/$/, "");
    else if (arg === "--batch-size") options.batchSize = Number(argv[++index]);
    else if (arg === "--seed") options.seed = Number(argv[++index]);
    else if (arg === "--temperature") options.temperature = Number(argv[++index]);
    else if (arg === "--industries") options.industries = argv[++index].split(",").filter(Boolean);
    else if (arg === "--domains") options.domains = argv[++index].split(",").filter(Boolean);
    else if (arg === "--force") options.force = true;
    else if (arg === "--repair-fallbacks") options.repairFallbacks = true;
    else if (arg === "--no-cache") options.noCache = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--help") options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node scripts/generate-enterprise-diverse-corpus.mjs [--model NAME] [--industries id,id] [--domains industry-department,...] [--force] [--repair-fallbacks] [--no-cache] [--dry-run]");
  } else {
    generate(options).then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => { console.error(error); process.exitCode = 1; });
  }
}
