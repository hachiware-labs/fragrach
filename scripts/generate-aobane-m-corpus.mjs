import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const corpusRoot = path.join(repo, "tests", "corpora", "aobane-industries-ja-medium");
const generatedRoot = path.join(corpusRoot, "sources", "60-generated");

const policies = [
  ["vendor-access","外部委託先の本番アクセス申請","二営業日前までに申請する","四営業日前までに申請する","情報管理責任者"],
  ["backup-drill","バックアップ復元演習","半年に一回実施する","四半期に一回実施する","運用マネージャー"],
  ["audit-log","監査ログの保管","一年間保管する","二年間保管する","情報管理責任者"],
  ["supplier-review","重要供給元の定期レビュー","年に一回実施する","半年に一回実施する","品質保証部長"],
  ["release-freeze","年末の本番変更凍結","十二月二十五日から開始する","十二月二十二日から開始する","製品責任者"],
  ["key-rotation","サービス鍵の定期更新","百八十日ごとに行う","九十日ごとに行う","情報管理責任者"],
  ["data-export","顧客データの臨時エクスポート","チームリーダーの承認を得る","製品責任者と情報管理責任者の承認を得る","製品責任者"],
  ["maintenance-notice","計画保守の顧客通知","開始の二十四時間前までに送る","開始の七十二時間前までに送る","カスタマーサポート部長"],
  ["risk-register","高リスク項目の更新","月末までに更新する","判明した翌営業日までに更新する","経営管理部長"],
  ["incident-review","P2障害の事後レビュー","十営業日以内に開催する","五営業日以内に開催する","運用マネージャー"],
  ["test-evidence","高リスク変更の試験証跡","実施結果だけを保存する","入力値と期待値と実施結果を保存する","品質保証部長"],
  ["account-disable","退職者アカウントの無効化","退職日の翌営業日までに行う","退職時刻までに行う","情報管理責任者"],
  ["contract-archive","終了契約の記録保管","三年間保管する","五年間保管する","経営管理部長"],
  ["privacy-review","個人情報を扱う新機能の確認","出荷判定時に確認する","設計開始前に確認する","情報管理責任者"],
  ["emergency-contact","P1障害の第一報","三十分以内に連絡する","十五分以内に連絡する","運用マネージャー"],
  ["schema-change","互換性のないスキーマ変更","製品責任者だけが承認する","製品責任者と主任技師が承認する","主任技師"],
  ["training-expiry","本番作業教育の更新","二年ごとに受講する","一年ごとに受講する","情報システム部長"],
  ["vulnerability-fix","重大脆弱性の修正着手","十営業日以内に着手する","三営業日以内に着手する","情報管理責任者"],
  ["customer-escalation","重大苦情の部門間連携","翌営業日までに連携する","受領から二時間以内に連携する","カスタマーサポート部長"],
  ["document-review","正式規程の定期見直し","三年ごとに実施する","一年ごとに実施する","経営管理部長"],
];

const incidents = [
  ["metrics-delay","監視メトリクスの反映遅延","集計キューのワーカー停止","ワーカーを再起動した","キュー滞留監視を追加する"],
  ["login-loop","管理画面のログインループ","認証Cookieの属性不整合","旧Cookieを失効させた","配備前のCookie互換試験を追加する"],
  ["export-timeout","分析データの出力タイムアウト","一括検索のメモリ超過","対象期間を分割した","ストリーミング出力へ変更する"],
  ["mail-delay","アラートメールの配送遅延","外部配送事業者の地域障害","別経路へ切り替えた","配送経路の自動切替を実装する"],
  ["device-gap","設備データの欠測","ゲートウェイ証明書の期限切れ","証明書を手動更新した","期限の三十日前通知を追加する"],
  ["api-rate","公開APIの応答低下","特定顧客の再試行集中","顧客単位の流量制限を設定した","指数バックオフをSDKへ実装する"],
  ["search-stale","検索結果の更新遅延","索引更新ジョブの排他待ち","排他ジョブを終了した","更新ジョブを分割する"],
  ["mobile-crash","モバイル画面の起動失敗","設定値の空文字未処理","直前版へ戻した","空値を含む契約試験を追加する"],
  ["webhook-duplicate","Webhookの重複送信","再試行状態の保存失敗","重複抑止キーを再生成した","送信状態をトランザクション化する"],
  ["report-missing","月次報告の一部欠落","締め処理と集計処理の競合","集計を再実行した","締め処理後に集計を開始する制御を追加する"],
  ["backup-slow","復元試験の所要時間超過","低速保管層への早期移動","高速層へ一時的に戻した","復元対象の保管層を週次確認する"],
  ["permission-leak","権限解除の反映遅延","権限キャッシュの無効化漏れ","対象キャッシュを削除した","解除イベントで即時失効させる"],
  ["sensor-spike","温度グラフの異常値表示","単位変換の二重適用","変換処理を一段停止した","単位付きデータ型へ移行する"],
  ["billing-lag","利用量集計の確定遅延","日次バッチの時刻ずれ","対象バッチを再実行した","時刻基準をUTCへ統一する"],
  ["csv-garbled","CSVの文字化け","文字コード指定の欠落","UTF-8指定で再出力した","出力APIで文字コードを固定する"],
  ["alert-silence","夜間アラートの未通知","当番表同期の失敗","連絡先を手動同期した","同期失敗時の代替通知を追加する"],
  ["dashboard-blank","ダッシュボードの空白表示","CDNキャッシュの不整合","キャッシュを削除した","配備時のキャッシュ世代を検証する"],
  ["token-expiry","連携トークンの一斉失効","更新ジョブの対象条件誤り","失効前の状態へ復元した","対象件数の上限ゲートを追加する"],
  ["upload-stall","大容量ファイルのアップロード停止","プロキシの待機時間不足","分割アップロードを案内した","再開可能アップロードを標準化する"],
  ["status-page","障害情報ページの更新遅延","承認待ち通知の見落とし","運用当番が代理更新した","P1時の代理承認経路を自動通知する"],
];

const projects = [
  ["event-store","イベント履歴基盤","単一の共有テーブル","用途別の追記専用ストア","監査履歴を削除不能に保つため"],
  ["api-version","公開APIの版管理","日付だけの版番号","メジャー版をURLへ含める方式","移行期間を明示できるため"],
  ["search-engine","社内検索基盤","外部SaaSへの全面移行","既存基盤の段階的更新","機密区分ごとの移行検証が必要なため"],
  ["mobile-auth","モバイル認証","端末固有パスワード","短期トークンと更新トークン","端末紛失時に個別失効できるため"],
  ["telemetry","製品テレメトリ","全項目を無期限保存","項目別の保持期限","目的外保管を避けるため"],
  ["batch-window","夜間バッチ再設計","全処理の直列実行","依存関係ごとの並列実行","締め時刻までの余裕を確保するため"],
  ["feature-flags","機能フラグ管理","設定ファイルへの直書き","監査付き管理サービス","変更者と適用時刻を追跡するため"],
  ["data-lake","分析データ保管","本番DBの直接参照","匿名化した分析用保管領域","本番負荷と権限を分離するため"],
  ["notification","通知サービス統合","各機能から直接送信","共通配送キュー","再試行と重複抑止を一元化するため"],
  ["schema-registry","イベントスキーマ管理","文書だけでの管理","互換性検査付きレジストリ","配備前に破壊的変更を検出するため"],
  ["audit-viewer","監査ログ閲覧","全社員への閲覧開放","職務別の申請制","個人情報へのアクセスを限定するため"],
  ["edge-update","ゲートウェイ更新","全台同時配信","段階配信と自動停止","現地設備への一斉影響を避けるため"],
  ["reporting","定型報告生成","手作業の表計算","テンプレート付き自動生成","転記誤りを減らすため"],
  ["tenant-move","顧客領域移行","停止を伴う一括移行","二重書き込みによる段階移行","停止時間を短縮するため"],
  ["secrets","秘密情報管理","共有ファイルでの配布","期限付き取得サービス","配布後の失効を可能にするため"],
  ["observability","運用可観測性","ログだけの監視","メトリクスとトレースの併用","遅延箇所をサービス間で追跡するため"],
  ["support-console","サポート調査画面","本番DBの直接検索","監査付き照会API","検索条件と閲覧者を記録するため"],
  ["backup-format","長期バックアップ形式","製品固有形式","公開仕様のアーカイブ形式","将来の復元手段を確保するため"],
  ["release-train","定期リリース運用","随時配備","週次のリリース列車","部門間の確認時刻を揃えるため"],
  ["localization","多言語文言管理","ソースコードへの埋め込み","翻訳資源の外部管理","翻訳更新を配備から分離するため"],
];

const systems = ["Atlas","Beacon","Cedar","Delta","Echo","Forge","Grove","Harbor","Iris","Junction","Kite","Lumen","Meadow","Nexus","Orbit","Prism","Quartz","Relay","Summit","Tide"];
const owners = ["業務システム管理者","運用マネージャー","経営管理部長","品質保証部長","カスタマーサポート部長","主任技師","経営管理部長","品質保証部長","製品責任者","主任技師","カスタマーサポート部長","情報管理責任者","品質保証部長","情報システム部長","製品責任者","品質保証部長","情報システム部長","運用マネージャー","経営管理部長","主任技師"];
const tableTopics = ["本番アクセス申請","リリース判定","供給元監査","教育受講","障害フォロー","リスク登録","端末返却","契約更新","緊急変更","復元試験","個人情報確認","アカウント廃止","鍵更新","顧客通知","スキーマ変更","設備接続","データ出力申請","監査指摘","計画保守","設計レビュー"];

const n3 = (index) => String(index + 1).padStart(3, "0");
const bp = (id, relativePath, title, type, status, authority, owner, sections, facts, extra = {}) =>
  ({ id, relativePath, title, type, status, authority, owner, sections, facts, ...extra });

export function buildBlueprints() {
  const out = [];
  policies.forEach(([slug, topic, oldRule, currentRule, owner], i) => {
    const id = `M-POL-${n3(i)}`;
    out.push(
      bp(`${id}-CUR`,`policies/${slug}/standard-v2.md`,`${topic}標準 第2版`,"policy","current","corporate_standard",owner,["目的","現行規則","責任","旧版の扱い"],[`この標準は${topic}の現行運用を定める。`,`2026年4月1日以降、${topic}は${currentRule}。`,`責任者は${owner}である。`,`旧版の「${oldRule}」は現行判断に用いない。`],{version:"2.0",validFrom:"2026-04-01",supersedes:`${id}-OLD`}),
      bp(`${id}-OLD`,`policies/${slug}/archive/standard-v1.md`,`${topic}標準 第1版`,"policy","superseded","corporate_standard",owner,["目的","旧規則","適用期間","改訂"],[`この版は${topic}の旧運用を定めた。`,`2025年4月1日から2026年3月31日まで、${topic}は${oldRule}。`,`この版の適用は2026年3月31日に終了した。`,`2026年4月1日以降は第2版を参照する。`],{version:"1.0",validFrom:"2025-04-01",validTo:"2026-03-31"}),
      bp(`${id}-FAQ`,`policies/${slug}/faq.md`,`${topic} FAQ`,"faq","stale","guidance",owner,["質問","案内","注意","更新状況"],[`${topic}についてよくある質問を扱う。`,`${topic}は${oldRule}。`,`正式標準と異なる場合は正式標準を確認する。`,`このFAQは第2版の内容を反映していない。`]),
      bp(`${id}-MEM`,`policies/${slug}/notes/local-operation-memo.md`,`${topic}に関する運用メモ`,"personal_note","draft","record","担当者未設定",["背景","現場の状況","未決事項","参照先"],[`${topic}について担当者が残したメモである。`,`現場運用には未確認事項が残っている。`,`このメモだけで期限や承認者を変更してはならない。`,`正式標準を参照する必要がある。`],{omit:i%3===0}),
    );
  });
  incidents.forEach(([slug, symptom, cause, workaround, permanent], i) => {
    const id = `M-INC-${n3(i)}`, date=`2026-07-${String(i+2).padStart(2,"0")}`;
    out.push(
      bp(`${id}-INI`,`incidents/${slug}/01-initial-report.md`,`${symptom} 初報`,"incident_report","open","incident_record","運用当番",["概要","検知","初動","未確認事項"],[`${symptom}の初報である。`,`${date} 09:10に${symptom}を検知した。`,`影響範囲の確認を開始した。`,`初報の時点では原因と恒久対策は未確認である。`]),
      bp(`${id}-UPD`,`incidents/${slug}/02-status-update.md`,`${symptom} 状況更新`,"incident_report","mitigated","incident_record","運用マネージャー",["影響","暫定対応","復旧確認","残作業"],[`${symptom}の顧客影響を確認した。`,`暫定対応として${workaround}。`,`09:45に顧客影響が解消したことを確認した。`,`原因確認と恒久対策が残っている。`]),
      bp(`${id}-FIN`,`incidents/${slug}/03-final-report.md`,`${symptom} 最終報`,"incident_report","closed","incident_record","運用マネージャー",["概要","原因","復旧","判断"],[`${symptom}の確定した最終報である。`,`${symptom}の原因は${cause}である。`,`暫定復旧では${workaround}。`,`09:45に復旧を確認した。`]),
      bp(`${id}-PIR`,`incidents/${slug}/04-post-incident-review.md`,`${symptom} 障害後レビュー`,"post_incident_review","approved","approved_review_record","品質保証部",["振り返り","原因確認","恒久対策","責任"],[`${symptom}の対応を振り返った。`,`確定原因は${cause}である。`,`恒久対策として${permanent}。`,`完了責任者は運用マネージャーである。`]),
    );
  });
  projects.forEach(([slug, project, rejected, accepted, reason], i) => {
    const id = `M-PRJ-${n3(i)}`;
    out.push(
      bp(`${id}-PRO`,`projects/${slug}/01-proposal.md`,`${project} 提案書`,"proposal","draft","proposal","製品開発部",["背景","提案","期待効果","未決事項"],[`${project}の検討を開始した。`,`初期案では${rejected}を提案した。`,`期待効果は検証中である。`,`この提案書だけでは採用を確定しない。`]),
      bp(`${id}-MIN`,`projects/${slug}/02-decision-minutes.md`,`${project} 意思決定会議`,"meeting_minutes","approved","approved_review_record","製品責任者",["議題","比較","決定","後続作業"],[`${project}の方式を議題とした。`,`${rejected}と${accepted}を比較した。`,`${project}では${accepted}を採用すると決定した。`,`採用理由は${reason}。`]),
      bp(`${id}-ADR`,`projects/${slug}/03-adr.md`,`${project} ADR`,"adr","accepted","implementation_record","主任技師",["状況","決定","理由","不採用案"],[`${project}の技術判断を記録する。`,`採用案は${accepted}である。`,`判断理由は${reason}。`,`${rejected}は採用しない。`]),
      bp(`${id}-OUT`,`projects/${slug}/04-outcome.md`,`${project} 結果報告`,"project_report","completed","implementation_record","製品開発部",["実施内容","確認結果","残課題","参照"],[`${accepted}の初期導入を完了した。`,`採用案が動作することを確認した。`,`残課題は別途管理する。`,`初期案の${rejected}へは戻していない。`]),
    );
  });
  systems.forEach((system, i) => {
    const slug=system.toLowerCase(), owner=owners[i], id=`M-ONB-${n3(i)}`, missing=i<8;
    const handover=`onboarding/${slug}/03-handover.md`;
    out.push(
      bp(`${id}-ROL`,`onboarding/${slug}/01-role-guide.md`,`${system} 役割ガイド`,"role_guide","current","corporate_reference",owner,["目的","正式責任","別名","連絡"],missing?[`${system}の役割を確認する。`,`${system}の正式な問い合わせ責任者は文書に定められていない。`,`${system}ポータルは${system}の通称である。`,`責任者を担当経験者から推測してはならない。`]:[`${system}の役割を確認する。`,`${system}の正式な責任者は${owner}である。`,`${system}ポータルは${system}の通称である。`,`日常の連絡先も${owner}である。`]),
      bp(`${id}-SYS`,`onboarding/${slug}/02-system-guide.md`,`${system} 利用案内`,"system_guide","current","guidance",owner,["用途","利用開始","日常操作","問い合わせ"],[`${system}は架空の社内システムである。`,`利用開始には所属部門の申請が必要である。`,`操作記録を残す。`,`正式な役割ガイドを参照する。`]),
      bp(`${id}-HND`,handover,`${system} 引き継ぎ`,"handover","current","record",missing?"担当者未設定":owner,["引き継ぎ範囲","日常確認","相談先","未解決"],missing?[`${system}の日常運用を引き継ぐ。`,`日次の状態を確認する。`,`担当経験者は正式な問い合わせ責任者として承認されていない。`,`正式責任者の指定が未解決である。`]:[`${system}の日常運用を引き継ぐ。`,`日次の状態を確認する。`,`日常の相談先は${owner}である。`,`権限変更は正式な申請記録を残す。`],{omit:i%4===0}),
      i<10?bp(`${id}-CPY`,`onboarding/${slug}/copies/handover-shared-copy.md`,`${system} 引き継ぎ共有コピー`,"handover",null,null,null,[],[],{duplicateOf:handover}):bp(`${id}-MEM`,`onboarding/${slug}/04-personal-memo.md`,`${system} 個人メモ`,"personal_note","draft","record","担当者未設定",["背景","使い方","個人の見解","確認事項"],[`${system}についての個人メモである。`,`日常操作の覚え書きを含む。`,`正式な責任分担を変更しない。`,`不明点は正式資料で確認する必要がある。`],{omit:true}),
    );
  });
  tableTopics.forEach((topic,i)=>{
    const slug=`case-${String(i+1).padStart(2,"0")}`, id=`M-TBL-${n3(i)}`, key=`${["AC","RL","SA","TR","IN","RK","AS","CT","EC","BR","PV","AD","KY","NT","SC","DV","EX","AU","MT","DR"][i]}-${2600+i}`, missing=i<7, value=missing?"未記入":owners[i];
    const current=`tables/${slug}/01-current-register.md`;
    const table={headers:["管理番号","対象","責任項目","状態"],rows:[[key,`${topic}対象A`,value,missing?"確認待ち":"確認済み"],[`${key}-B`,`${topic}対象B`,"別担当","参考"]]};
    out.push(
      bp(`${id}-CUR`,current,`${topic}一覧`,"register","current","record","業務管理担当",["一覧の目的","対象行","確認","注意"],[`${topic}の現行一覧である。`,missing?`管理番号 ${key} の責任項目は未記入である。`:`管理番号 ${key} の責任項目は${value}である。`,`対象行は管理番号と責任項目を一緒に確認する。`,`他の行の値を対象行へ転用してはならない。`],{table}),
      bp(`${id}-MON`,`tables/${slug}/02-monthly-report.md`,`${topic}月次報告`,"report","approved","record","業務管理担当",["報告範囲","集計","例外","次月"],[`${topic}の月次報告である。`,`月次集計は二件である。`,`${key}は個別確認の対象である。`,`未完了項目を次月も確認する。`]),
      bp(`${id}-CPY`,`tables/${slug}/copies/register-shared-copy.md`,`${topic}一覧共有コピー`,"register",null,null,null,[],[],{duplicateOf:current}),
      bp(`${id}-TPL`,`tables/${slug}/99-empty-template.md`,`${topic}空テンプレート`,"template","draft","guidance","担当者未設定",["用途","入力欄","記入例","注意"],[`${topic}の空テンプレートである。`,`入力欄は未記入である。`,`記入例は確定情報ではない。`,`空欄を確定情報として扱ってはならない。`],{omit:i%2===0}),
    );
  });
  if(out.length!==400) throw new Error(`expected 400 blueprints, got ${out.length}`);
  return out;
}

export function buildQuestions(){
  const out=[];
  policies.forEach(([slug,topic,oldRule,currentRule],i)=>out.push({id:`M-PL-${n3(i)}`,intent_id:"compliance-audit",question:`2026年7月1日時点の「${topic}」にはどの規則を適用しますか。FAQもそのまま使えますか。`,as_of:"2026-07-01",expected_behavior:"answer_with_conflict_disclosure",expected_answer_elements:[currentRule,"第2版を適用","FAQは旧版の内容で競合"],required_evidence:[{source:`sources/60-generated/policies/${slug}/standard-v2.md`,section:"現行規則",content_terms:[topic,currentRule]},{source:`sources/60-generated/policies/${slug}/faq.md`,section:"案内",content_terms:[topic,oldRule]}],forbidden_answer_elements:[`現行規則は${oldRule}`],tags:["current-rule","temporal","authority","conflict","multi-document"]}));
  incidents.forEach(([slug,symptom,cause,workaround,permanent],i)=>out.push({id:`M-IR-${n3(i)}`,intent_id:"incident-response",question:`${symptom}の原因、暫定対応、恒久対策は何でしたか。`,as_of:"2026-07-28",expected_behavior:"answer",expected_answer_elements:[cause,workaround,permanent],required_evidence:[{source:`sources/60-generated/incidents/${slug}/03-final-report.md`,section:"原因",content_terms:[symptom,cause]},{source:`sources/60-generated/incidents/${slug}/04-post-incident-review.md`,section:"恒久対策",content_terms:[permanent]}],forbidden_answer_elements:["初報時点の推測を確定原因とする"],tags:["incident","timeline","multi-document","temporary-vs-permanent"]}));
  projects.forEach(([slug,project,rejected,accepted,reason],i)=>out.push({id:`M-PH-${n3(i)}`,intent_id:"project-history",question:`${project}で正式に採用された案と理由は何ですか。初期提案との違いも示してください。`,as_of:"2026-07-28",expected_behavior:"answer",expected_answer_elements:[accepted,reason,`${rejected}は不採用`],required_evidence:[{source:`sources/60-generated/projects/${slug}/02-decision-minutes.md`,section:"決定",content_terms:[project,accepted]},{source:`sources/60-generated/projects/${slug}/03-adr.md`,section:"不採用案",content_terms:[rejected,"採用しない"]}],forbidden_answer_elements:[`${rejected}を採用した`],tags:["decision-history","proposal-vs-decision","multi-document"]}));
  systems.slice(0,14).forEach((system,i)=>{const slug=system.toLowerCase(),missing=i<8,owner=owners[i];out.push({id:`M-ON-${n3(i)}`,intent_id:"onboarding",question:`${system}ポータルの正式な問い合わせ責任者は誰ですか。`,as_of:"2026-07-28",expected_behavior:missing?"insufficient_information":"answer",expected_answer_elements:missing?["正式な問い合わせ責任者は文書に定められていない","担当経験者を正式責任者と推測しない"]:[owner,`${system}ポータルは${system}の通称`],required_evidence:[{source:`sources/60-generated/onboarding/${slug}/01-role-guide.md`,section:"正式責任",content_terms:missing?[system,"定められていない"]:[system,owner]},...(missing?[{source:`sources/60-generated/onboarding/${slug}/03-handover.md`,section:"相談先",content_terms:["担当経験者","承認されていない"]}]:[])],forbidden_answer_elements:missing?["担当経験者が正式責任者"]:[`${owner}以外が正式責任者`],tags:missing?["onboarding","alias","information-absence","abstention","multi-document"]:["onboarding","alias","role"]})});
  tableTopics.slice(0,10).forEach((topic,i)=>{const slug=`case-${String(i+1).padStart(2,"0")}`,key=`${["AC","RL","SA","TR","IN","RK","AS","CT","EC","BR"][i]}-${2600+i}`,missing=i<7,value=owners[i];out.push({id:`M-TB-${n3(i)}`,intent_id:"compliance-audit",question:`${topic}一覧の管理番号 ${key} について責任項目と状態を答えてください。`,as_of:"2026-07-28",expected_behavior:missing?"insufficient_information":"answer",expected_answer_elements:missing?["責任項目は未記入","他の行から推測しない"]:[key,value,"確認済み"],required_evidence:[{source:`sources/60-generated/tables/${slug}/01-current-register.md`,section:"対象行",content_terms:missing?[key,"未記入"]:[key,value,"確認済み"]}],forbidden_answer_elements:missing?["責任項目は別担当"]:["別の行の値を回答"],tags:missing?["table","evidence-bundle","information-absence","abstention"]:["table","evidence-bundle","complete-answer"]})});
  if(out.length!==84) throw new Error(`expected 84 questions, got ${out.length}`);
  return out;
}

const yaml=(b)=>{const fields={document_id:b.id,title:b.title,document_type:b.type,status:b.status,authority:b.authority,owner:b.owner,created_at:"2026-07-28",valid_from:b.validFrom,valid_to:b.validTo,version:b.version,supersedes:b.supersedes,generation:"ollama"};const omit=b.omit?["status","authority","valid_from","valid_to","version"]:[];return `---\n${Object.entries(fields).filter(([k,v])=>v!=null&&!omit.includes(k)).map(([k,v])=>`${k}: ${JSON.stringify(v)}`).join("\n")}\n---\n\n`;};
const tableMd=(t)=>t?`\n\n| ${t.headers.join(" | ")} |\n| ${t.headers.map(()=> "---").join(" | ")} |\n${t.rows.map(r=>`| ${r.join(" | ")} |`).join("\n")}`:"";
const render=(b,summary)=>`${yaml(b)}# ${b.title}\n\n${b.sections.map((h,i)=>`## ${h}\n\n${i===0?`${summary}\n\n`:""}${b.facts[i]}${i===1?tableMd(b.table):""}`).join("\n\n")}\n`;
const target=(relative)=>path.join(generatedRoot,...relative.split("/"));
const valid=(b,text)=>b.facts.every(f=>text.includes(f))&&b.sections.every(h=>text.includes(`## ${h}`));
const writeJsonl=(file,items)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,`${items.map(x=>JSON.stringify(x)).join("\n")}\n`,"utf8");};

async function summaries(batch,options){
  const prompt=`架空企業「青羽精機株式会社」の社内文書について、各文書の導入文を一文だけ作る。入力事実を要約し、入力にない人物、日付、数値、期限、原因、決定を加えない。出力は{"items":[{"id":"...","summary":"..."}]}だけ。各summaryは40〜100文字。入力:${JSON.stringify(batch.map(b=>({id:b.id,title:b.title,type:b.type,status:b.status,facts:b.facts})))}`;
  const response=await fetch(`${options.endpoint}/api/generate`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({model:options.model,stream:false,format:"json",keep_alive:"30m",options:{temperature:.15,seed:options.seed,num_ctx:8192,num_predict:batch.length*160},prompt})});
  if(!response.ok) throw new Error(`Ollama HTTP ${response.status}: ${await response.text()}`);
  const raw=await response.json(), parsed=JSON.parse(raw.response);
  return {items:new Map((parsed.items??[]).map(x=>[x.id,String(x.summary??"").trim()])),metrics:{total_duration:raw.total_duration,eval_count:raw.eval_count,eval_duration:raw.eval_duration}};
}

function gold(blueprints,questions){
  const pathToId=new Map(blueprints.map(b=>[`sources/60-generated/${b.relativePath}`,b.id]));
  writeJsonl(path.join(corpusRoot,"gold/evidence.jsonl"),questions.flatMap(q=>q.required_evidence.map((e,i)=>({evidence_id:`${q.id}-E${i+1}`,question_id:q.id,document_id:pathToId.get(e.source),...e}))));
  writeJsonl(path.join(corpusRoot,"gold/aliases.jsonl"),systems.map((s,i)=>({alias_id:`M-AL-${n3(i)}`,canonical:s,aliases:[`${s}ポータル`],owner:owners[i],evidence:`sources/60-generated/onboarding/${s.toLowerCase()}/01-role-guide.md`})));
  writeJsonl(path.join(corpusRoot,"gold/versions.jsonl"),policies.map(([slug,topic],i)=>({series_id:`M-POL-${n3(i)}`,topic,current:`M-POL-${n3(i)}-CUR`,superseded:[`M-POL-${n3(i)}-OLD`],source:`sources/60-generated/policies/${slug}/standard-v2.md`})));
  writeJsonl(path.join(corpusRoot,"gold/conflicts.jsonl"),policies.map(([slug,topic,oldRule,currentRule],i)=>({conflict_id:`M-CF-${n3(i)}`,topic,status:"resolved_by_authority_and_time",canonical_value:currentRule,conflicting_value:oldRule,sources:[`sources/60-generated/policies/${slug}/standard-v2.md`,`sources/60-generated/policies/${slug}/faq.md`]})));
  writeJsonl(path.join(corpusRoot,"gold/duplicates.jsonl"),blueprints.filter(b=>b.duplicateOf).map((b,i)=>({duplicate_group_id:`M-DUP-${n3(i)}`,canonical:`sources/60-generated/${b.duplicateOf}`,duplicate:`sources/60-generated/${b.relativePath}`,expected_relation:"exact_duplicate"})));
  writeJsonl(path.join(corpusRoot,"gold/answers.jsonl"),questions.map(q=>({question_id:q.id,intent:q.intent_id,question:q.question,as_of:q.as_of,required_answer_elements:q.expected_answer_elements,prohibited_conclusions:q.forbidden_answer_elements,expected_behavior:q.expected_behavior,gold_evidence:q.required_evidence,canonical_citation:q.required_evidence[0].source,conflict_expectation:q.tags.includes("conflict")?"disclose":"none"})));
}

function corpusHash(){const files=[];const walk=d=>fs.readdirSync(d,{withFileTypes:true}).forEach(e=>e.isDirectory()?walk(path.join(d,e.name)):files.push(path.join(d,e.name)));walk(path.join(corpusRoot,"sources"));const h=crypto.createHash("sha256");for(const f of files.sort()){h.update(path.relative(corpusRoot,f).replaceAll("\\","/"));h.update("\0");h.update(fs.readFileSync(f));}return h.digest("hex");}

export async function generate(options={}){
  options={model:"gemma4:latest",endpoint:process.env.OLLAMA_HOST||"http://127.0.0.1:11434",seed:20260728,batchSize:12,force:false,dryRun:false,...options};
  const blueprints=buildBlueprints(),questions=buildQuestions(),canonical=blueprints.filter(b=>!b.duplicateOf);
  if(options.dryRun)return {blueprints:400,ollama_documents:370,duplicates:30,questions:84};
  fs.mkdirSync(generatedRoot,{recursive:true});
  const pending=canonical.filter(b=>options.force||!fs.existsSync(target(b.relativePath))||!valid(b,fs.readFileSync(target(b.relativePath),"utf8")));
  const report={schema_version:"1.0",corpus_id:"aobane-industries-ja-medium",model:options.model,seed:options.seed,temperature:.15,started_at:new Date().toISOString(),requested_documents:400,ollama_documents:370,exact_duplicates:30,resumed_documents:370-pending.length,generated_documents:0,fallback_documents:[],batches:[]};
  console.log(`Generating ${pending.length} documents; ${report.resumed_documents} already valid.`);
  for(let i=0;i<pending.length;i+=options.batchSize){
    const batch=pending.slice(i,i+options.batchSize);let result;
    try{result=await summaries(batch,{...options,seed:options.seed+i});report.batches.push({offset:i,document_ids:batch.map(b=>b.id),...result.metrics});}catch(error){report.batches.push({offset:i,error:String(error)});result={items:new Map()};}
    for(const b of batch){let summary=result.items.get(b.id);if(!summary||summary.length<20){summary=`この文書は、${b.title}について確認すべき範囲と記録上の位置づけを簡潔に示す。`;report.fallback_documents.push(b.id);}fs.mkdirSync(path.dirname(target(b.relativePath)),{recursive:true});fs.writeFileSync(target(b.relativePath),render(b,summary),"utf8");report.generated_documents++;}
    console.log(`Progress ${Math.min(i+batch.length,pending.length)}/${pending.length}`);
  }
  for(const b of blueprints.filter(x=>x.duplicateOf)){fs.mkdirSync(path.dirname(target(b.relativePath)),{recursive:true});fs.copyFileSync(target(b.duplicateOf),target(b.relativePath));}
  const qPath=path.join(corpusRoot,"evaluation/questions.jsonl"),existing=fs.readFileSync(qPath,"utf8").split(/\r?\n/).filter(Boolean).map(JSON.parse).filter(q=>!String(q.id).startsWith("M-"));writeJsonl(qPath,[...existing,...questions]);gold(blueprints,questions);
  const reportPath=path.join(corpusRoot,"generation/ollama-generation-report.json");if(pending.length===0&&fs.existsSync(reportPath))return {status:"up_to_date",...JSON.parse(fs.readFileSync(reportPath,"utf8"))};report.completed_at=new Date().toISOString();report.question_count=existing.length+questions.length;report.ollama_calls_in_run=report.batches.filter(x=>!x.error).length;report.corpus_hash=corpusHash();fs.mkdirSync(path.dirname(reportPath),{recursive:true});fs.writeFileSync(reportPath,`${JSON.stringify(report,null,2)}\n`,"utf8");return report;
}

function args(argv){const o={};for(let i=0;i<argv.length;i++){if(argv[i]==="--model")o.model=argv[++i];else if(argv[i]==="--endpoint")o.endpoint=argv[++i].replace(/\/$/,"");else if(argv[i]==="--seed")o.seed=Number(argv[++i]);else if(argv[i]==="--batch-size")o.batchSize=Number(argv[++i]);else if(argv[i]==="--force")o.force=true;else if(argv[i]==="--dry-run")o.dryRun=true;else if(argv[i]==="--help")o.help=true;else if(!argv[i].startsWith("--")&&!o.model)o.model=argv[i];else if(!argv[i].startsWith("--")&&!o.batchSize)o.batchSize=Number(argv[i]);else throw new Error(`unknown argument: ${argv[i]}`);}return o;}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){const o=args(process.argv.slice(2));if(o.help)console.log("Usage: node scripts/generate-aobane-m-corpus.mjs [--model NAME] [--batch-size N] [--force] [--dry-run]");else generate(o).then(r=>console.log(JSON.stringify(r,null,2))).catch(e=>{console.error(e);process.exitCode=1;});}
