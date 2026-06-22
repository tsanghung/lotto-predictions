# 樂透 ASI v1 設計規格

日期：2026-06-18  
狀態：Design approved for implementation planning  
目標：把現有樂透預測系統升級為可持續學習的「樂透 ASI 智能體」架構。

## 1. 定義與邊界

「樂透 ASI」不是宣稱系統能超越隨機性或保證中獎，而是把現有資料、模型、統計、回測、賽後檢討與自動排程整合成一個持續改良的智能體。

本系統必須維持三個原則：

1. 不宣稱保證命中。
2. 每一期預測都必須留下可審計的資料、推理、策略權重與驗證結果。
3. 每一期開獎後都必須產生賽後學習紀錄，作為下一期預測的輸入之一。

## 2. 現況

目前正式 production 流程如下：

1. Supabase cron 每天台灣時間 06:00 執行前一天開獎資料更新。
2. Supabase cron 每天台灣時間 10:00 執行當天應開獎遊戲的預測與 LINE 推送。
3. Supabase Edge Function `lotto-predict-notify` 目前使用 Gemini API。
4. 沒有設定 `GEMINI_MODEL_PREDICTION` 時，預設模型為 `gemini-2.5-flash`。
5. 前端 production 已改為透過 Supabase public key 讀取資料庫最新資料。

## 3. ASI v1 智能層

### 3.1 資料感知層

責任：

1. 讀取完整歷史開獎資料。
2. 檢查台灣彩券官方來源與第二來源的一致性。
3. 確認 Supabase 資料庫、前端可見資料、當日排程狀態是否一致。
4. 產生資料健康狀態：`freshness`, `source_confidence`, `missing_draws`, `last_verified_at`。

### 3.2 統計特徵層

每期預測前必須建立統計特徵包，至少包含：

1. 全歷史頻率。
2. 近 10、30、50、100 期頻率。
3. 遺漏期數。
4. 和值分布。
5. 奇偶比。
6. 大小區間。
7. 連號與尾數分布。
8. 共現號碼組。
9. 最近 N 期策略命中回饋。
10. 前幾期 ASI 賽後學習摘要。

### 3.3 Gemini 量化決策層

Gemini 必須參與候選號碼池與策略權重，不只產生文字解釋。

輸入：

1. 完整歷史開獎資料。
2. 統計特徵包。
3. 最近賽後學習紀錄。
4. 遊戲規則與硬性約束。
5. 玄學因子限制：只能作為低權重輔助，不得覆蓋統計判斷。

輸出：

1. `candidate_pool`：候選號碼、分數、統計理由、玄學信號。
2. `strategy_weights`：三種策略的權重、偏好、排除號碼、理由。
3. `risk_notes`：本期風險提醒。
4. `reasoning_summary`：可顯示於前端與 LINE 的濃縮推理。

### 3.4 系統驗證層

Gemini 不能直接決定最終合法組合。最終號碼必須經由系統驗證器處理。

驗證規則：

1. 號碼範圍合法。
2. 數量合法。
3. 無重複號碼。
4. 三種策略不得完全相同。
5. 不得與最近 3 期開獎組合完全相同。
6. 不得與同日同遊戲既有 prediction record 重複。
7. 若 Gemini 輸出不合格，系統使用統計 fallback，並記錄 `reasoning_source`。

### 3.5 賽後學習層

每期開獎後，ASI 必須產生可回饋下一期的 learning memory。

每筆學習紀錄包含：

1. 本期預測號碼。
2. 實際開獎號碼。
3. 命中號碼與未命中號碼。
4. 當初選每個號碼的原因。
5. 實際開出號碼的統計位置與近期狀態。
6. 哪些策略因子有效。
7. 哪些策略因子失效。
8. 下期應調高或調低的權重。
9. 給 Gemini 下一期的行為指令。

## 4. 資料庫設計

### 4.1 新增 `asi_learning_records`

用途：保存每期賽後學習結果。

欄位：

1. `id uuid primary key`
2. `game_name text not null`
3. `target_draw_date date not null`
4. `draw_id text`
5. `prediction_record_id uuid`
6. `predicted_numbers jsonb not null`
7. `actual_numbers jsonb not null`
8. `matched_numbers jsonb not null`
9. `missed_numbers jsonb not null`
10. `selected_number_reasons jsonb not null`
11. `actual_number_analysis jsonb not null`
12. `strategy_effectiveness jsonb not null`
13. `next_adjustments jsonb not null`
14. `model_name text`
15. `created_at timestamptz not null default now()`

唯一約束：

`unique(game_name, target_draw_date, prediction_record_id)`

### 4.2 擴充 `prediction_records`

新增欄位：

1. `asi_state jsonb`
2. `asi_learning_context jsonb`
3. `model_name text`
4. `reasoning_source text`

如果現有欄位已包含部分資訊，實作時優先避免重複欄位，改以 `prediction` 內既有 JSON 結構兼容。

## 5. Edge Function 流程

### 5.1 預測前

`lotto-predict-notify` 取得：

1. 完整開獎資料。
2. 最近 ASI learning records。
3. 過去 prediction records 的命中狀態。
4. 統計特徵包。

然後組成 Gemini prompt。

### 5.2 預測中

Gemini 回傳量化決策後：

1. 系統解析 JSON。
2. 系統套用候選池與策略權重。
3. Strategy sampler 產生三組合法號碼。
4. Verifier 檢查策略差異與重複。
5. 寫入 `prediction_records`。
6. LINE 推送包含 ASI 統計洞察與今日選號理由。

### 5.3 開獎後

`lotto-update` 在寫入開獎資料後：

1. 找到可對獎的 prediction records。
2. 更新命中結果。
3. 產生 `asi_learning_records`。
4. 更新 performance snapshot。
5. 讓下一次預測讀取最新 learning memory。

## 6. 前端設計

新增「樂透 ASI 學習紀錄」區塊。

顯示內容：

1. 最近 10 期賽後學習摘要。
2. 每期命中與未命中號碼。
3. 策略有效因子。
4. 策略失效因子。
5. 下期調整建議。

既有「歷史推薦與開獎對照」應補上每筆 prediction 的 ASI 診斷摘要。

## 7. LINE 推送設計

每次預測通知增加：

1. ASI 狀態：資料新鮮度、模型、策略來源。
2. 統計洞察。
3. 三組推薦組合。
4. 今日選號理由。
5. 風險提醒。

每次開獎後可選擇是否推送賽後檢討。v1 預設不主動推送，先只寫入前端與資料庫，避免 LINE 訊息過量。

## 8. 錯誤處理

1. Gemini API 失敗：使用 statistical fallback，並記錄 `reasoning_source = statistical_fallback_gemini_error`。
2. Gemini API key 缺失：使用 statistical fallback，並記錄 `reasoning_source = statistical_fallback_no_gemini_key`。
3. JSON parse 失敗：保留 raw response 摘要，使用 fallback。
4. Supabase 寫入失敗：Edge Function 回傳非 200，並讓 cron log 保留錯誤。
5. 學習紀錄產生失敗：不得阻塞開獎資料寫入，但必須記錄錯誤。

## 9. 驗證標準

功能完成必須通過：

1. `lotto-predict-notify` 單元測試。
2. `lotto-update` 對獎與學習紀錄測試。
3. migration dry run 或 production-safe SQL 檢查。
4. production dry run：指定日期不實際推送 LINE。
5. production 驗證：前端可看到最新 prediction 與 ASI learning record。

## 10. 非目標

v1 不做：

1. 宣稱保證命中。
2. 付費會員系統。
3. 自動下單投注。
4. 多模型競標。
5. 大規模向量資料庫。

## 11. 實作順序

1. Migration：建立 ASI learning table 與必要欄位。
2. Core：新增 ASI learning builder。
3. Predict：把 learning memory 放進 Gemini prompt。
4. Update：開獎後產生 learning record。
5. Frontend：新增 ASI 學習區塊。
6. LINE：補 ASI 狀態與選號理由格式。
7. Verification：dry run、build、production check。
