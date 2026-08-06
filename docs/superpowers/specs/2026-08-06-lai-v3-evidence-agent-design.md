# LAI v3 Evidence Agent 設計規格

- 日期：2026-08-06
- 狀態：已核准設計，待建立實作計畫
- 適用彩種：今彩 539、大樂透、威力彩

## 1. 決策摘要

LAI v3 採用「證偽優先的自適應智能體」作為 production 主路徑，以「雙組覆蓋最佳化」作為保底機制；所有新模型一律先進入 shadow 實驗場，不得直接影響正式推薦、LINE 通知或前端正式紀錄。

系統不以單期命中數宣稱模型進步。只有在嚴格的樣本外評估中，相對均勻隨機基準同時通過機率品質、投注效用與統計可信度門檻，挑戰模型才可分階段進入 production。沒有模型通過時，系統必須維持原冠軍或退回均勻基準。

## 2. 背景與問題

目前 LAI v2 已具備多專家、walk-forward、Brier score、log loss、Hedge 權重與 promotion gate，但 production 證據顯示部分彩種的 ensemble Brier skill 仍低於均勻基準，且各專家權重長期接近平均，無法有效淘汰沒有增益的訊號。短期命中數也容易受隨機波動影響，不能作為模型升級依據。

本次改版要解決四個核心問題：

1. 將模型探索與正式推薦徹底隔離，避免偶然命中或模型幻覺污染 production。
2. 以可重播、可審計的樣本外證據決定模型升降級。
3. 正式推薦固定為兩組，分別承擔機率主攻與號碼覆蓋目的。
4. 讓每日開獎結果驅動評分與學習，但不能讓模型自行繞過驗證閘門。

## 3. 目標與非目標

### 3.1 目標

1. 建立永久均勻基準，所有模型必須以相同資料截止點與限制條件公平比較。
2. 建立 production、shadow 與雙組最佳化三條隔離路徑。
3. 讓每次預測、評分、promotion 決策與模型版本都可完整重播。
4. 對今彩 539、大樂透與威力彩分別評估；威力彩第 1 區與第 2 區必須獨立計分。
5. 正式輸出固定為「證據主攻」與「覆蓋保底」兩組。
6. 在資料、模型或排程異常時維持最後一個完整有效狀態，不產生未驗證替代結果。

### 3.2 非目標

1. 不承諾能預知設計為隨機事件的開獎結果。
2. 不以單期命中、連續幾期命中或人工主觀判斷升級模型。
3. 不讓 Gemini 或其他 LLM 計算正式號碼、模型權重、特徵值或 promotion 結果。
4. 不在本階段一次導入大量新模型；第一版只建立可被證偽的實驗與升級制度。

## 4. 成功條件

模型只有在樣本外證據通過以下條件時，才可被描述為優於均勻基準：

1. Brier skill 相對均勻基準為正，且配對 block bootstrap 的 95% 信賴區間下界大於 0。
2. Log loss 不得惡化，校準誤差不得顯著增加。
3. 與相同組數、相同彩種限制及相同重疊約束的隨機投注組相比，兩組推薦的聯集覆蓋效用不得退步。
4. permutation test 通過，且多重檢定使用 Benjamini-Hochberg 控制，要求 `q <= 0.05`。
5. shadow 階段至少累積 30 個有效 live draws；canary 階段至少再觀察 20 個有效 draws。
6. recent-100 與 recent-500 視窗的 skill 都必須大於 0；資料不足以形成完整視窗時，不得用較短視窗冒充已通過。

若任一必要條件未通過，結論只能是「尚無足夠證據」，不得宣稱準確率已提升。

## 5. 系統架構與邊界

### 5.1 Production baseline lane

1. 保存目前已核准 champion 與永久 `uniform-null` 基準。
2. LINE、前端正式推薦與 `prediction_records` 只讀取已核准且完整的 production state。
3. 沒有 challenger 通過 promotion gate 時，production 不變。
4. champion 失效或證據撤銷時，系統退回上一個有效 champion；若不存在，退回 `uniform-null`。

### 5.2 Shadow lab

1. 所有新模型、特徵、參數、視窗與演算法先在 shadow 執行。
2. 每次實驗必須記錄模型版本、資料截止點、特徵版本、參數、程式 commit、隨機種子與輸出摘要。
3. 相同輸入與隨機種子必須能重播相同預測、評分與 promotion 判定。
4. Shadow 模型不得發送 LINE、不得寫入正式推薦，也不得覆寫 active production state。

### 5.3 Two-group optimizer

最佳化器只接受已核准 production probability vector，輸出兩組合法且可解釋的投注組合：

1. 「證據主攻」：在彩種限制下，最大化經校準後的入選機率總和。
2. 「覆蓋保底」：在效用下限內，最大化兩組號碼聯集並控制重疊，避免兩組成為近似複本。
3. 威力彩第 1 區與第 2 區分別計算、評分，再組合為完整投注組合；第 2 區不得由第 1 區特徵推導。
4. 若輸入機率不合法、過期或缺漏，最佳化器必須拒絕產生新結果。

### 5.4 權責分離

- 模型負責提出機率預測。
- Scorer 負責以實際開獎結果證偽或支持預測。
- Promotion gate 負責核准、維持、降級或停用模型。
- Production runtime 只消費已核准狀態。
- Gemini 只負責將系統已計算完成的證據轉成使用者可讀文字。

任何單一元件都不能同時提出模型、評分自己並直接啟用自己。

## 6. 每日資料流

所有時間均為台灣時間 `Asia/Taipei`。

### 6.1 每日 06:00

1. 搜尋並回寫前一日實際開獎資料；沒有開獎則記錄正常跳過。
2. 驗證資料完整性、彩種規則、期別唯一性與來源一致性。
3. 對 production 與 shadow 預測進行不可變評分。
4. 更新 Brier score、log loss、校準、命中、聯集覆蓋與威力彩第 2 區指標。
5. 由獨立 promotion gate 判斷 `promote`、`hold`、`demote` 或 `disable`。
6. 若資料缺漏、衝突或遭官方更正，停止該期學習並進入更正流程。

### 6.2 開獎日每日 10:00

1. 讀取該彩種最後一個完整且已核准的 production state。
2. 由 two-group optimizer 產生「證據主攻」與「覆蓋保底」。
3. 寫入包含資料截止點、模型版本、機率版本與最佳化參數的 evidence snapshot。
4. 使用唯一通知鍵發送一次 LINE，並提供前端正式推薦。
5. Shadow 與 canary 實驗不得另外發送通知。

## 7. 模型實驗場

第一版只允許下列四個模型家族：

### 7.1 `uniform-null`

永久存在的零假設與安全基準。每個合法號碼具有相同邊際機率，並依各彩種規則正規化。此模型不得被刪除或停用。

### 7.2 `bayesian-drift`

以 Bayesian shrinkage 將近期觀測收縮回均勻先驗，降低小樣本熱冷號碼的過度解讀。衰減半衰期必須預先登錄，不得看完測試結果後修改同一實驗。

### 7.3 `transition-regularized`

重做 Markov 與 co-occurrence 訊號，加入強正則化、最小樣本門檻與效果上限。未達最小樣本的轉移或號碼對必須退回先驗，不可用稀疏事件製造高信心。

### 7.4 `sequence-challenger`

既有 LSTM 與未來較複雜的序列模型只可在 shadow 執行。若資料量不足、機率未校準或沒有樣本外增益，狀態維持 research-only。

### 7.5 Ensemble 限制

1. 同一訊號家族的高度相關模型不得重複取得完整投票權。
2. 權重依相對 `uniform-null` 的 excess loss 更新，而非只比較模型彼此名次。
3. 長期 skill 為負的模型進入 cooldown，production 權重設為 0。
4. 新模型在 shadow 通過前，production 權重固定為 0。

## 8. 評分與投注效用

### 8.1 機率品質

每個彩種及威力彩各區獨立計算：

1. Brier score 與相對均勻基準的 Brier skill。
2. Log loss。
3. Calibration curve 與校準誤差。
4. Recent-30、recent-100、recent-500 與全期 walk-forward 摘要；只有預先指定的 promotion 視窗可決定升級。

### 8.2 投注效用

1. 每組平均命中數。
2. 兩組聯集命中數。
3. 至少命中 1、2、3 個號碼的經驗機率。
4. 兩組重疊率與有效覆蓋數。
5. 威力彩第 2 區命中率與主區、第二區聯合結果。

所有投注效用都必須與相同組數、相同遊戲限制與相同重疊約束的隨機投注基準比較。

### 8.3 統計可信度

1. 使用嚴格 walk-forward，任何特徵只能使用該期預測時間以前的資料。
2. 使用配對 block bootstrap 建立 95% 信賴區間，保留時間相依結構。
3. 使用 permutation test 檢查觀察差異是否可由隨機交換產生。
4. 同時測試多個模型或參數時，使用 Benjamini-Hochberg 控制 false discovery rate。
5. 單一期高命中或零命中不得觸發升級或降級。

## 9. Promotion 狀態機

模型狀態依序為：

1. `registered`：模型、特徵、參數與評估方法已登錄。
2. `historical_passed`：完整歷史 walk-forward 通過必要門檻。
3. `shadow_verified`：至少 30 個有效 live shadow draws，主要 skill 的 95% 信賴區間下界大於 0。
4. `canary`：production ensemble 權重上限 10%，持續至少 20 個有效 draws；仍不得產生額外 LINE 訊息。
5. `champion`：recent-100 與 recent-500 skill 皆為正、信賴區間通過、log loss 與 coverage 無退步。

下列任一條件成立時，canary 或 champion 應降級或撤銷：

1. Rolling-30 Brier skill 低於 0。
2. 校準顯著惡化。
3. 資料、模型或重播一致性檢查失敗。
4. 投注覆蓋效用低於相符隨機基準。

每次決策都必須保存門檻、輸入證據、結果與理由；不得只保存最後狀態。

## 10. 資料契約

沿用既有 `lotto_model_forecasts` 與 `lotto_model_scores`，新增下列表格或等價的不可變紀錄：

### 10.1 `lai_model_registry`

保存模型家族、版本、特徵版本、參數、程式 commit、登錄時間、目前狀態與狀態理由。

### 10.2 `lai_experiment_runs`

保存資料截止點、walk-forward 範圍、隨機種子、輸入摘要、評分結果、重播摘要與執行狀態。

### 10.3 `lai_promotion_decisions`

保存 promotion gate 版本、候選模型、比較基準、必要門檻、實際證據、決策與可讀理由。

### 10.4 Evidence snapshot

每次正式推薦必須能追溯：

1. 彩種、預測日期與目標期別。
2. 開獎資料截止點與來源版本。
3. Champion、ensemble 與最佳化器版本。
4. 兩組推薦、各號碼邊際機率與兩組重疊度。
5. 產生時間、通知唯一鍵與程式 commit。

## 11. Gemini 使用邊界

Gemini 可執行：

1. 將系統算好的統計、模型證據與選號貢獻轉成繁體中文說明。
2. 說明某號碼被選入的量化原因，以及命中或未命中的事後證據。
3. 明確標示不確定性與「不代表可預知隨機開獎」。

Gemini 不可執行：

1. 直接決定正式號碼或覆寫最佳化器輸出。
2. 設定模型權重、promotion 狀態或統計門檻。
3. 從文字自行創造未計算的數值、特徵或因果解釋。
4. 將事後生成文字回灌為下一期數值特徵。

## 12. 失敗處理與一致性

1. 開獎資料過期、缺漏或來源衝突時，停止該期評分與學習，保留前一個 active state。
2. Shadow timeout、非法機率或模型失敗只標記該實驗失敗，不得影響 production。
3. 評分、決策與啟用使用 idempotency key、資料庫交易與同彩種 advisory lock。
4. 官方資料更正必須建立 correction event，撤銷並重算受影響的 score 與 evidence，不可靜默覆寫。
5. 新 state 啟用失敗時，production 繼續使用上一個完整 state。
6. LINE 維持唯一通知鍵；重試不得造成重複推送。

## 13. 前端呈現

正式推薦仍只顯示兩組，不增加 shadow 候選號碼。新增精簡的「模型證據狀態」區塊：

1. 目前 champion 與版本。
2. Shadow 有效樣本數。
3. Brier skill 與 95% 信賴區間。
4. Promotion 狀態。
5. 最近一次維持、升級、降級或停用理由。

頁面不得使用「必勝」、「提高中獎保證」或無統計證據的準確率宣稱。

## 14. 測試策略

### 14.1 Unit tests

涵蓋 Brier skill、log loss、校準、block bootstrap、permutation test、FDR、promotion gate 與雙組最佳化器。

### 14.2 Property tests

1. 機率向量合法且總和符合各彩種的邊際機率約束。
2. 兩組號碼合法、組內不重複、符合期望重疊限制。
3. 相同 snapshot 與 seed 可重播相同結果。
4. 威力彩第 1 區與第 2 區皆符合各自範圍與數量限制。

### 14.3 Synthetic falsification tests

1. 純隨機資料中的 false promotion rate 不得高於預設 alpha。
2. 注入可控制、可重現的弱偏差時，系統應能在足夠樣本後偵測並升級有效模型。

### 14.4 Historical replay tests

完整歷史 walk-forward 必須能逐期重播相同預測、score 與 decision，並驗證沒有未來資料洩漏。

### 14.5 Production boundary tests

驗證 RLS、RPC、Cron、通知去重、shadow 不寫正式推薦、dry-run 不發 LINE，以及失敗時回退上一個 active state。

## 15. 分階段上線

### Phase A：證據基礎建設

建立 registry、experiment、decision schema、scorer 與重播能力；不改 production 推薦。

### Phase B：歷史證偽

完整重播三個彩種歷史資料，所有 challenger 僅在 shadow，確認 false promotion 測試與無未來資料洩漏。

### Phase C：Live shadow 與 canary

每個候選模型至少累積 30 個有效 live shadow draws；通過者才能以最高 10% 權重進入 canary，再觀察至少 20 個有效 draws。

### Phase D：Champion promotion

只有通過全部機率品質、投注效用、統計可信度與 production 邊界測試的模型，才可成為 champion。任何未通過項目都維持原 champion 或 `uniform-null`。

## 16. 驗收準則

1. 三條路徑在資料表、權限與 runtime 上可證明隔離。
2. 任一 shadow 模型都無法直接寫入正式推薦或發送 LINE。
3. 每次正式推薦與 promotion 決策都能從資料截止點重播。
4. 純隨機 synthetic test 不會超過設定的 false promotion rate。
5. 威力彩第 2 區具獨立機率、評分、命中率與顯示。
6. Production 固定輸出兩組，且覆蓋組與主攻組符合重疊限制。
7. 資料或模型故障時不產生未驗證推薦，並保留上一個完整 active state。
8. 前端只陳述可由 evidence snapshot 證明的模型狀態與統計結果。

## 17. 科學依據

本設計採用可重播的樣本外評估與 proper scoring rules，並將 lottery randomness auditing 視為零假設背景；任何結論都以「能否拒絕均勻基準」為核心，而不是假定歷史序列必然具有可預測模式。

1. Gneiting, T. and Raftery, A. E. (2007), Strictly Proper Scoring Rules, Prediction, and Estimation: https://sites.stat.washington.edu/people/raftery/Research/PDF/Gneiting2007jasa.pdf
2. Cesa-Bianchi et al. (2019), Hedge in stochastic regimes: https://www.jmlr.org/papers/v20/18-869.html
3. Haigh (2008), Lottery randomness auditing example: https://arxiv.org/abs/0806.4595
