# Lotto predictions - 投注成效追蹤與歸因分析 - 系統規格與實作計畫 (v1.0)

**文件狀態**: 待執行
**最後更新**: 2026-04-26
**核心方針**: 數據驅動成效追蹤、嚴謹數理歸因、AI 不幻想、完美視覺呈現

---

## 1. 需求分析與架構擴充設計

依據 `新增功能.txt` 的需求，系統需要在原有的「數據獲取 -> AI 推論 -> 推播 -> 視覺化」四大階段之上，疊加**「成效評估 (Evaluation)」**與**「回溯歸因 (Attribution)」**的閉環機制。

### 1.1 資料儲存層擴充
- **`data/predictions.json` (增強)**：
  目前已具備 `timestamp`, `game_name`, `prediction` (含 reasoning 與 combinations)。未來對獎完成後，系統會將對獎結果（Hit/Miss）與「歸因分析報告」直接 append 回相對應的預測紀錄中，以保持資料單一來源。
- **`data/performance.json` (新增)**：
  儲存每一期的統計快取資料（如：總命中數、各期中獎率趨勢等），供前端快速繪製圖表。

### 1.2 後端對獎與歸因引擎
- **自動對獎機制 (`evaluator.py`)**：在每日 `update_latest.py` 成功抓取新期數資料後觸發，比對該期的實際開獎號碼與昨日的預測號碼。
- **科學歸因 AI 模組 (`scientific_attribution.py`)**：
  若命中數不如預期（如 < 3 個），呼叫 LLM 進行嚴格的統計學分析。
  **System Prompt 限制**：嚴禁發揮想像力。必須引用變異數分析 (ANOVA)、偏態分佈 (Skewness)、大數法則之樣本偏差 (Law of Large Numbers) 或自相關性 (Autocorrelation) 的具體數字變化來解釋未命中的原因。

### 1.3 前端視覺化擴充
- 新增 `PerformanceDashboard.vue` 組件。
- 引入新的 Chart.js 圖表：
  - **長條圖 (Bar Chart)**：單期命中/未命中號碼數量對比。
  - **折線圖 (Line Chart)**：累積中獎率趨勢變化。
  - **圓餅圖 (Pie Chart)**：各類策略（激進、穩健、隨機）的歷史勝率佔比。

---

## 2. 實作計畫與子任務切分 (Phased Implementation Plan)

### 📈 階段五：對獎引擎與成效統計 (Phase 5: Evaluation Engine)
*目標：當最新號碼出爐時，自動比對預測紀錄，結算命中與未命中個數。*
- **Task 5.1**: 擴充 `predictions.json` 資料模型，準備儲存 `matches` (命中號碼), `hits` (命中數), `misses` (未命中數) 欄位。
- **Task 5.2**: 開發 `src/analyzer/evaluator.py`，實作自動對獎邏輯。
- **Task 5.3**: 實作統計快照，將累計的總中獎率與趨勢寫入 `data/performance.json`。

### 🧠 階段六：科學歸因 AI 模組 (Phase 6: Scientific Attribution)
*目標：針對未命中的號碼，產出嚴謹的數學與統計理論分析報告。*
- **Task 6.1**: 開發 `src/analyzer/scientific_attribution.py`，設計針對「預測失誤」的專屬分析 Prompt，並強制 LLM 提供數理統計上的解釋。
- **Task 6.2**: 將歸因分析模組整合進 `evaluator.py` 的工作流中：只要執行對獎，就對成效進行歸因並存檔。
- **Task 6.3**: 更新 GitHub Actions 排程 (`update_data.yml`)，確保在「抓取最新開獎號碼」後，接著執行「對獎與歸因腳本」。

### 📊 階段七：前端成效看板與視覺化 (Phase 7: Performance Dashboard)
*目標：將死板的資料庫數字，轉化為具備 RWD 與 Premium 質感的精美儀表板。*
- **Task 7.1**: 擴充前端 `useLottoData.js`，加入 `performance.json` 的獲取邏輯。
- **Task 7.2**: 開發 `PerformanceChart.vue`，利用 Chart.js 實作「中獎率/未中獎率」的趨勢折線圖與長條圖。
- **Task 7.3**: 開發 `AttributionReport.vue`，以高質感的 UI 展示 AI 對於近期未命中原因的科學歸因報告。
- **Task 7.4**: 將成效看板整合至 `App.vue` 的主視覺版面中，確保在行動裝置與電腦端皆可清晰閱讀。

---

## 3. 執行規範
1. **資料不可變性**：在執行 Task 5 的對獎引擎時，應避免破壞原有的預測紀錄結構，採取安全更新 (Safe Update)。
2. **防幻覺機制**：在 Task 6 中，必須設定 `temperature=0.2` 或更低，並在 Prompt 中嚴格封鎖任何沒有根據的玄學或運氣解釋。
