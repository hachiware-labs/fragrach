# 青羽精機 Dynamic Validity Scale Track

このコーパスは、小規模pilotでは測れなかった文書増加、長文化、文書系列の未知性を含めて、T0からT1への更新後に通常RAGの検索とDVAAがどう変わるかを調べるValidity Challenge trackである。実運用の質問頻度を再現するProduction-weighted trackではない。

T0には既存の中規模・長文コーパスから参照する背景788文書と、50系列の初期基準50文書がある。T1では各系列に新版、追補、期限付き特例、変更申請、研究記録、競合指示、文書管理台帳など合計150文書を追加し、文書総数を838件から988件へ増やす。動的文書は最短2,756文字、中央値3,304文字、最大3,592文字であり、規範値と有効性を確定する台帳を別の長文に置いている。

100問は文書系列単位で分割する。開発40問は20系列、holdout 60問は別の30系列に属し、同じ系列の別質問が開発側からholdout側へ漏れない。各系列には、T1で答えが変わる質問と、答えが同じでも採用すべき根拠集合が変わる質問を置く。

正式比較ではEmbeddingをRuri、readerをCodex App ServerのLunaへ固定する。VanillaはT0開発問でchunk、BM25、日本語n-gram、Dense／Sparse融合を調整し、その設定を固定した`V-Frozen/T1`と、T1開発問で再調整した`V-Retuned/T1`を比較する。

```powershell
npm run corpus:dynamic-validity-scale:generate
npm run corpus:dynamic-validity-scale:check
npm run benchmark:dynamic-validity-scale:tune
npm run benchmark:dynamic-validity-scale:oracle
npm run benchmark:dynamic-validity-scale:answers
```

生成器は背景文書を複製せず、`manifest.json`の`source_roots`から既存コーパスを参照する。Gold Profileは全988文書に一つずつあり、Gold Relationは100件、質問はT0／T1それぞれの回答、Recall Gold、DVAA Goldを持つ。

2026年8月4日の初回測定では、Ruri固定のVanillaがholdout Recall@5をT0の100%からT1固定適用の95.8%へ落とし、T1再調整で100%へ戻した。一方、T1の必要根拠集合はVanillaのtop-5に一問も完全には揃わず、DVAA-Fullは0%になった。この床効果は、関連度再調整だけでは別管理された台帳を回収できないことを示す診断結果だが、Fragrachの優位性を確定する結果ではない。Gold根拠を先頭へ置くOracleでもLunaのDVAA-Fullは61.7%であり、Relationを明示した実際のF-Compile条件と、Production-weighted trackでの確認が必要である。
