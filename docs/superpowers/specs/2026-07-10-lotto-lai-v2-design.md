# 樂透 LAI v2 自我學習智能體設計規格

日期：2026-07-10

狀態：Design approved

適用範圍：威力彩、大樂透、今彩 539

## 1. 目標

建立「LAI v2（Lottery Adaptive Intelligence）」自我學習智能體，使用 Supabase 已保存的完整歷史開獎資料，在每個彩種的每個開獎日產生固定 2 組號碼，並在開獎後以可稽核、無資料洩漏的量化方式更新模型權重。

系統同時最佳化兩個目標：

1. 單組的機率預報品質與平均命中顆數。
2. 兩組合併後的實際開獎號碼覆蓋率。

LAI v2 不承諾預知獨立隨機事件。只有通過 out-of-sample 驗證的模型才可取得較高權重；沒有模型證明優於均勻隨機基準時，系統必須明確退回基準模型。

## 2. 現況與根因

目前 production 使用 Supabase Cron、Supabase Edge Functions 與 Cloudflare Pages：

1. 台灣時間每日 06:00 執行 `lotto-update`，補開獎資料並對獎。
2. 台灣時間每日 10:00 執行 `lotto-predict-notify`，產生當日應開獎彩種的號碼並推送 LINE。
3. `lotto-predict-notify` 使用 `generateHonestPrediction()`。
4. production 目前輸出「穩健平衡」與「心跳明牌」2 組。

現有系統無法形成真正學習閉環的原因：

1. Edge Function 讀取 `asi_learning_records`，但沒有把 learning records 傳入 `generateHonestPrediction()` 的數值決策。
2. 頻率、Markov、LSTM 的融合權重固定為 `1:1:1`。
3. LSTM 使用離線匯出的固定權重，production 不會隨新資料重新評估或更新。
4. 心跳模型固定按遺漏週期排序。
5. 賽後學習目前主要產生文字檢討，沒有更新下一期模型參數。

## 3. 科學邊界

1. 每個合法組合在公平抽獎下具有相同頭獎機率。
2. 歷史熱號、冷號、遺漏、連號與共現只能作為待驗證特徵，不預設具有預測力。
3. 隨機性檢定只能偵測偏差或異常，不能證明未來可預測。
4. 所有模型必須與均勻隨機基準比較。
5. 任何優勢都必須來自時間順序正確的 walk-forward 結果。
6. 不使用開獎後資訊重新修改已發布的預測或事前機率。
7. 不使用玄學訊號修改號碼機率或模型權重。
8. LLM 不直接選號、不計算機率、不更新權重；最多將既有量化結果轉成易讀說明。

## 4. 架構方案

採用 Champion-Challenger 多專家線上學習架構。

```text
完整歷史開獎資料
  -> 專家模型機率向量
  -> Hedge ensemble 聚合
  -> Group A 機率主攻
  -> Group B 覆蓋探索
  -> 保存事前機率與模型狀態
  -> LINE 與前端

實際開獎資料
  -> 對獎
  -> Brier / Log Loss / 命中 / union coverage
  -> Hedge 更新
  -> Champion-Challenger 驗證
  -> 新 agent state checkpoint
```

### 4.1 專家模型池

每個專家都必須輸出完整號碼空間的出現機率，不得只輸出推薦號碼。

初始專家模型：

1. 均勻隨機基準。
2. Bayesian 頻率模型，向均勻分布收縮。
3. 多時間窗頻率與趨勢模型。
4. 遺漏期數與 hazard 模型。
5. 共現號碼圖模型。
6. 一階 Markov 模型。
7. LSTM 模型。
8. 和值、奇偶、區段與連號結構模型。
9. 威力彩第二區獨立模型。

任一專家無法輸出合法機率時，本期隔離該專家，不得用零機率或空陣列代替。

### 4.2 程式模組

`lotto-predict-notify/lib` 拆分為：

1. `experts.js`：所有專家模型與機率向量介面。
2. `scoring.js`：Brier Score、Log Loss、Brier Skill Score、命中與 union coverage。
3. `ensemble.js`：Hedge 更新、安全收縮與聚合。
4. `optimizer.js`：Group A 與 Group B 組合最佳化。
5. `agentState.js`：Champion、Challenger、版本與 checkpoint。
6. `predictCore.js`：協調流程、驗證及既有輸出格式相容層。

`lotto-update/lib/lottoCore.js` 負責開獎後對獎與產生學習輸入；資料庫 I/O 仍由對應 Edge Function 的 `index.ts` 處理。

## 5. 機率與評分

### 5.1 機率向量約束

彩種號碼空間為 `N`、每期開出 `k` 個號碼。每個專家對號碼 `n` 輸出 `p(n)`：

```text
0 <= p(n) <= 1
sum(p(n)) = k
uniform p0(n) = k / N
```

威力彩第一區與第二區各自產生一個合法機率向量。

### 5.2 Brier Score

```text
BS = (1 / N) * sum((p(n) - y(n))^2)
```

實際開出時 `y(n) = 1`，否則為 `0`。Hedge 使用原始 Brier Loss 更新權重。

### 5.3 其他指標

每個模型、每個最終組合與每個彩種都記錄：

1. Log Loss，機率先限制在安全範圍。
2. Brier Skill Score，相對均勻基準的改善程度。
3. 每組命中顆數。
4. 兩組 union 命中顆數。
5. 兩組重疊顆數。
6. `0/1/2/3...` 顆命中分布。
7. 威力彩第二區獨立命中率。

Brier Skill Score 用於比較與顯示，不直接驅動權重更新。

## 6. Hedge 線上學習

每個有新標籤的開獎事件執行一次：

```text
temporary_weight_i = weight_i * exp(-eta * loss_i)
normalized_weight_i = temporary_weight_i / sum(temporary_weight)
new_weight_i = (1 - gamma) * normalized_weight_i
               + gamma * uniform_expert_weight
```

規則：

1. `eta` 隨累積樣本數降低，避免後期權重劇烈震盪。
2. `gamma` 保留均勻基準的安全權重。
3. 單期結果不得直接造成 Champion 變更。
4. 使用固定折扣讓近期結果具有有限影響，但不抹除長期證據。
5. 沒有新開獎標籤時不更新權重，記錄 `no_new_label`。
6. 同一 prediction 與 draw 只能學習一次。

## 7. Champion-Challenger

Challenger 必須同時符合以下條件才可晉升：

1. 全歷史 walk-forward 每一步只使用之前資料。
2. 最近 500 期 Brier Skill Score 大於 `0`。
3. 最近 100 期 Brier Skill Score 大於 `0`。
4. 至少有 30 期 production forward predictions。
5. Bootstrap 95% 信賴區間下限大於 `0`。
6. 多模型比較套用 Benjamini-Hochberg 修正後 `q <= 0.05`。
7. 兩組 union coverage 不低於現任 Champion。

沒有 Challenger 通過時，均勻基準繼續擔任 Champion。系統仍提供 2 組合法號碼，但必須標示目前沒有模型證明優於隨機。

## 8. 每期兩組號碼

### 8.1 Group A：機率主攻

```text
Group A = argmax valid_group sum(p(n))
```

### 8.2 Group B：覆蓋探索

```text
Group B = argmax valid_group (
  0.5 * sum(p(n) in Group B)
  + 0.5 * sum(p(n) in Group B but not Group A)
)
```

### 8.3 組合規則

1. 今彩 539 每組 5 個 `1..39` 不重複號碼。
2. 大樂透每組 6 個 `1..49` 不重複號碼。
3. 威力彩每組第一區 6 個 `1..38` 不重複號碼，第二區 1 個 `1..8` 號碼。
4. Group A 與 Group B 不得完全相同。
5. 不強迫奇偶、大小、冷熱、跨號段或連號限制。
6. 分數相同時使用彩種、目標開獎日與模型版本組成的可重現種子決定。
7. 威力彩 Group B 第二區優先增加相對 Group A 的覆蓋，但仍納入本身機率分數。

## 9. 資料庫

### 9.1 `lotto_agent_states`

保存每個彩種目前有效狀態：

1. `id uuid primary key`
2. `game_name text not null`
3. `state_version bigint not null`
4. `status text not null`
5. `champion_model text not null`
6. `expert_weights jsonb not null`
7. `learning_config jsonb not null`
8. `metrics jsonb not null`
9. `last_learned_draw_id text`
10. `last_learned_draw_date date`
11. `created_at timestamptz not null`
12. `activated_at timestamptz`

每個彩種只能有一個 active state。舊 state 保留以支援 rollback。

### 9.2 `lotto_model_forecasts`

保存開獎前不可變的專家預報：

1. 彩種、目標開獎日與 prediction source key。
2. 模型名稱與版本。
3. 第一區機率向量。
4. 威力彩第二區機率向量。
5. 當時 agent state version。
6. 特徵摘要、產生時間與完整性狀態。

唯一鍵防止同一模型、彩種與目標日期重複寫入。

### 9.3 `lotto_model_scores`

保存實際開獎後結果：

1. 對應 forecast 與 draw。
2. Brier、Log Loss 與 Brier Skill Score。
3. 模型排序與權重變化。
4. 每組命中、union coverage 與第二區結果。
5. 評估時間與 evaluator version。

同一 forecast 與 draw 只能評估一次。

### 9.4 `lotto_training_runs`

保存 walk-forward 與初始化任務：

1. 彩種、任務類型與演算法版本。
2. 開始與結束範圍。
3. checkpoint cursor。
4. `queued/running/completed/failed` 狀態。
5. 摘要、錯誤與執行時間。

### 9.5 既有資料表

1. `prediction_records` 繼續保存最終 Group A 與 Group B，新增 agent state、機率證據與組合指標摘要。
2. `asi_learning_records` 繼續保存人類可閱讀的賽後檢討。
3. `notification_logs` 繼續使用唯一 notification key 防止 LINE 重複推送。

## 10. 排程與資料流

### 10.1 台灣時間 06:00

`lotto-update`：

1. 搜尋並補齊前一天所有應開獎資料。
2. Upsert `lotto_draws`。
3. 找出尚未對獎且已取得實際開獎的 predictions。
4. 對獎並保存既有 evaluation 與 ASI learning record。
5. 讀取事前 model forecasts。
6. 計算每個專家的 loss 與最終兩組成效。
7. 冪等寫入 model scores。
8. 原子更新 agent state checkpoint。
9. 重建 performance snapshot。

### 10.2 台灣時間 10:00

`lotto-predict-notify`：

1. 只處理當日應開獎彩種。
2. 驗證資料新鮮度與 agent state。
3. 所有可用專家產生機率向量。
4. Hedge ensemble 聚合機率。
5. 產生 Group A 與 Group B。
6. 驗證彩種規則、差異與可重現性。
7. 先保存 prediction 與 model forecasts。
8. 成功保存證據後才保留 notification 並發送 LINE。
9. 寫入 LINE 成功或失敗狀態。

## 11. 前端

「AI 預測號碼」顯示：

1. `LAI v2` 版本。
2. `Champion`、`Baseline` 或 `Degraded` 狀態。
3. 資料完整性與最後學習日期。
4. Group A「機率主攻」。
5. Group B「覆蓋探索」。
6. 兩組重疊顆數與合併覆蓋號碼數。
7. 專家模型權重。
8. Brier Skill Score、平均命中與 union coverage。
9. 是否有模型已證明優於均勻基準。

「智能體學習回饋」增加：

1. 本期模型權重變化。
2. 升權與降權模型。
3. Group B 是否增加實際覆蓋。
4. Champion 是否變更。
5. 本期對長期信賴區間的影響。

前端不得顯示無法證明的「這期為什麼開這個號碼」因果敘述。

## 12. LINE

每個彩種固定推送 2 組：

```text
LAI v2 樂透預測
彩種：今彩 539
日期：YYYY-MM-DD
智能體狀態：Baseline / Champion / Degraded

機率主攻：
01、02、03、04、05

覆蓋探索：
06、07、08、09、10

兩組重疊：0 顆
合併覆蓋：10 個號碼
目前模型是否優於隨機：否
```

威力彩分別顯示第一區與第二區。通知必須帶有 prediction source key，以便追溯事前紀錄。

## 13. 錯誤與降級

1. 前一天預期開獎資料缺失：禁止 adaptive learning；仍以均勻基準產生 2 組並標示 `Degraded`。
2. 單一專家失敗：隔離該專家，其餘模型繼續。
3. 所有 adaptive 模型失敗：回退均勻基準。
4. Agent state 更新失敗：保留上一版 active state，不得產生半套權重。
5. Prediction 或 forecast 證據保存失敗：不發 LINE。
6. LINE 發送失敗：保留 prediction，通知標示失敗並允許安全重試。
7. 重複 Cron：依唯一鍵與已處理 draw id 保持冪等。
8. 未知模型版本或不合法 state：拒絕載入並回退上一版。
9. Walk-forward 超過單次 Edge Function 預算：保存 checkpoint，下一次從 cursor 繼續。

## 14. 測試

採測試先行，至少包含：

1. 每個專家的機率範圍合法且總和等於 `k`。
2. Uniform baseline 與理論值一致。
3. Brier、Log Loss、BSS 與 Hedge 固定案例。
4. 較準模型升權、較差模型降權。
5. 單期幸運不能觸發 Champion 晉升。
6. 修改未來資料不影響過去 forecast，證明無資料洩漏。
7. 三個彩種固定輸出 2 組合法號碼。
8. Group B 的新增覆蓋不低於複製 Group A 的對照。
9. 威力彩第一區與第二區獨立評分。
10. 相同 draw 重跑不重複學習或發送 LINE。
11. 資料缺失與模型失敗正確降級。
12. State 原子更新與 rollback。
13. Migration 安全與 RLS public read 範圍。
14. Edge Function dry run。
15. Vue production build。
16. Production smoke test 與當日 2 組可見性。

## 15. 上線

1. 新增 migration 與資料表，不改 production 行為。
2. 新增 `LAI_V2_SHADOW_ENABLED`，只保存 LAI v2 結果，不顯示、不發 LINE。
3. 使用完整歷史資料分批執行 walk-forward 初始化。
4. 驗證資料完整性、時間洩漏、效能與輸出相容性。
5. 開啟 `LAI_V2_ENABLED`，正式由 LAI v2 提供 2 組。
6. 保留舊引擎一個版本作為即時 rollback。
7. Production 驗證通過後移除 shadow flag，但不刪除歷史模型資料。

LAI v2 第一次啟用時若沒有模型通過 Champion 門檻，由均勻基準安全提供 2 組；不因模型尚未晉升而中斷當日預測與 LINE。

## 16. 非目標

本階段不做：

1. 宣稱保證中獎或預知獨立隨機事件。
2. 自動購買或代為投注。
3. 使用 LLM 直接決定號碼。
4. 建立外部大型 GPU 訓練平台。
5. 使用未保存事前機率的事後回測結果晉升模型。
6. 以單期命中或最高歷史命中作為模型優勢證據。

## 17. 參考依據

1. NIST SP 800-22：統計檢定可偵測非隨機特徵，但不能證明生成器未來可預測。
2. Gneiting 與 Raftery：proper scoring rules 與機率預報評估。
3. Dawid：prequential evaluation，只依事前預報與後續實際結果評估。
4. Hedge / Exponential Weights：prediction with expert advice。
5. Benjamini-Hochberg：多重檢定的 false discovery rate 控制。
6. Supabase Cron、Edge Functions 與分批 checkpoint 工作模式。
