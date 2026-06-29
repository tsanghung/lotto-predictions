# CLAUDE.md

本檔給在此專案工作的 Claude/開發者。請先讀懂「核心定位」再動任何選號相關邏輯。

## 核心定位：誠實，不預測

本專案**不預測號碼**。公正抽獎下每一組號碼的中獎機率都相同，沒有「明牌」。
所有對外輸出都必須誠實地停在「**描述**」，不得越界到「**預測**」。招牌是
公正性健診（卡方均勻性 + 前後期獨立性），用來證明開獎與真隨機無法區分。

## 兩組核心輸出（每個彩種、每個開獎日各一組）

這兩個關鍵詞是整個專案真正的核心重點，命名說的是每組「**到底是什麼**」，
而不是它「**能幫你贏**」：

### ① 穩健平衡 ＝ 統計啟發
把號碼結構鋪得均勻、有條理的一種「啟發式」。是「選號的核心方法論」。

### ② 心跳明牌 ＝ 節奏觀察
把每個號碼的開出節奏的一種「觀察」。回測已證實 ≈ 隨機，所以它是「現象的呈現」。

> 換句話說：①是「選號的方法論」、②是「現象的呈現」，兩者都**不提高中獎機率**，
> 文案與 UI 一律據此標示（不保證命中、僅供參考）。心跳明牌永遠存在、固定一組。

## 架構速覽

- **預測產生**：Supabase Edge Function `supabase/functions/lotto-predict-notify`
  由 Supabase Cron（台灣時間每日 10:00）觸發，產生當天應開彩種的選號並推送 LINE。
  純運算邏輯在 `lib/predictCore.js`（`generateHonestPrediction` 為入口）。
- **開獎後評估**：`supabase/functions/lotto-update`（`evaluatePredictionRecord`）
  逐期比對 `prediction.combinations`，寫入 `evaluation`；新加的組合若放進
  `combinations` 會被自動評估。
- **前端**：Vue 3 + Vite，部署於 Cloudflare Pages；只讀 Supabase，不靠 `data/` 檔。
  選號卡片在 `frontend/src/components/PredictionCard.vue`。
- **資料快照**：`data/predictions.json` 只是 Supabase 的提交快照，可用
  `scripts/export_predictions.py`（Supabase→檔案）刷新；正本是 Supabase。
- **誠實工具**：`scripts/randomness_audit.py`、`bias_tests.py`、
  `rolling_calibration.py`、`heartbeat_predict.py` 等都用來「證明贏不過隨機」。

## 部署注意

- 預測管線已**刻意**從 GitHub Actions 移到 Supabase Cron（見
  `docs/runtime-triggers.md`）。不要重新加入 GitHub Actions 的排程或正式 runtime workflow。
- Edge Function `lotto-predict-notify` 的 `verify_jwt` 為 **false**（自訂 apikey
  驗證），重新部署時務必維持。
- 最可靠的 Edge Function 部署方式是 CLI：
  `supabase functions deploy lotto-predict-notify --project-ref <ref>`
  （直接讀磁碟、保證逐字節正確）。

## 寫文案/改邏輯的底線

- 不得宣稱任何選號「會中」「提高中獎機率」「準」。
- 任何號碼選法都不影響中獎機率；唯一影響的是注數（多買不同注）。
- 保留每組輸出的誠實註記（統計啟發式／節奏觀察、回測≈隨機、期望值為負）。
