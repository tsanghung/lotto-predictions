# Lotto predictions - 系統架構與實作設計書 (v2.0)

**文件狀態**: 修訂版 (Revised for Detailed Precision)
**最後更新**: 2026-04-25
**核心方針**: Fail Fast (快速失敗回報), 雙重驗證, 數據驅動, AI 極限推理

---

## 1. 系統架構與技術選型 (Architecture & Tech Stack)

為了符合「完全佈署於 GitHub」、「無伺服器架構 (Serverless)」、「高可靠性」的要求，系統架構精確定義如下：

### 1.1 儲存層 (Data Store)
- **格式選型**：採用 `JSON` 格式儲存於 Git Repository 內。優於 SQLite，因為 JSON 更利於 Git 追蹤變更 (Diff)，且靜態網頁 (Frontend) 可直接無伺服器透過 HTTP GET 讀取。
- **資料分區**：
  - `data/lotto649.json`：存放「大樂透」歷史至最新資料。
  - `data/daily539.json`：存放「今彩539」歷史至最新資料。
  - `data/meta.json`：記錄最後更新時間、總期數等中介資訊。
  - `data/predictions.json`：紀錄 AI 歷次的推論過程與推薦號碼。

### 1.2 前端展示層 (Frontend SPA)
- **核心框架**：使用 **Vue 3 (Composition API) + Vite** 建立單頁應用程式，具備極高的響應速度與組件化開發優勢。
- **UI/UX & 樣式**：導入 **Tailwind CSS**，結合 `UI-UX Pro Max` 技能指南，實作深色模式 (Dark Mode)、玻璃擬物化 (Glassmorphism) 以及流暢的微動畫，達到 Premium 等級的視覺體驗。
- **圖表庫**：採用 `Chart.js` 或 `ECharts` 繪製熱力圖 (Heatmap)、冷熱門頻率與機率分佈圖。
- **託管方案**：編譯成純靜態檔後，自動佈署至 **GitHub Pages**。

### 1.3 自動化與後端邏輯層 (Backend Logic via GitHub Actions)
- **執行環境**：**Python 3.10+** (搭配 `pandas`, `requests`, `numpy`, `google-genai` 等核心庫)。
- **觸發機制**：使用 GitHub Actions 的 `schedule (CRON)` 觸發。
  - **資料更新排程**：每日晚間 21:30 (台灣時間) 觸發當日開獎爬蟲與更新。
  - **預測與推播排程**：開獎日 (539為週一至六，大樂透為週二/五) 中午 12:00 (台灣時間) 觸發預測運算並發送 LINE Notify。

---

## 2. 核心模組詳細規格 (Core Modules Deep Dive)

### 2.1 歷史數據庫建立與驗證 (爬蟲模組 `src/scraper/`)
- **來源鎖定**：主要數據源為「台灣彩券官方網站」歷史查詢頁面，次要來源為可信之第三方 API（如開獎網/PChome等）。
- **雙重驗證邏輯 (Dual-Verification)**：
  1. 腳本 A 從主要來源撈取期數與號碼。
  2. 腳本 B 從次要來源撈取同期號碼。
  3. **Assert 比對**：一旦發現陣列不一致或長度異常，立即觸發 `Fail Fast` 機制，中斷執行並以 Error 格式回報，拒絕將錯誤資料污染 JSON 資料庫。

### 2.2 預測演算法與 AI 效能榨取 (推理模組 `src/analyzer/`)
- **A. 傳統統計學特徵萃取 (`stats_engine.py`)**：
  - **熱度分析**：計算近 10, 30, 50 期的出現機率與權重。
  - **遺漏值 (Missing Values)**：精確計算每個號碼目前連續未開出的期數。
  - **分佈統計**：奇偶比、大小比、同尾數 (如 12, 22, 32) 分佈特徵。
  - **進階演算法**：蒙地卡羅模擬隨機分佈、自相關係數 (找出號碼間的伴隨開出機率)。
- **B. 資訊檢索 (`web_search.py`)**：
  - 整合搜尋引擎 API（如 `DuckDuckGo Search`套件），抓取本週最新的樂透分析文章或時事關鍵字。
- **C. AI 深層推理 (`ai_predictor.py`)**：
  - 核心：將 **「傳統統計特徵數據」+「網路輿情/時評」** 整合作為 Context。
  - 傳入 LLM (如 Gemini 1.5 Pro)，透過 System Prompt 賦予「頂級博弈精算師」人設。
  - **強制輸出格式**：必須包含「推理邏輯 (Reasoning)」、「風險提示」與「最終投注組合 (Combinations)」。並確保格式化為 JSON 供記錄與前端使用。

### 2.3 預測號碼推播機制 (通知模組 `src/notifier/`)
- 整合 **LINE Notify API**。
- **推播內容設計**：
  - 標題：`【小賽 AI 樂透預測】 2026-04-25 大樂透`
  - 統計洞察：簡述今日推薦號碼的統計原因 (如：遺漏值達 30 期的冷門號即將反彈)。
  - 推薦組合：3 組不同偏好的組合 (激進包牌、穩健平衡、完全隨機)。
  - 結語：提醒理性投注免責聲明。

---

## 3. 專案執行計畫與子任務切分 (Phased Implementation Plan)

### 🥇 階段一：絕對數據 (Phase 1: Immutable Data Foundation)
*目標：建立具備雙重驗證、100% 正確的歷史資料庫。*
- **Task 1.1**: 初始化專案結構、配置 Python 虛擬環境、設定 GitHub Secrets (`LINE_NOTIFY_TOKEN`, `API_KEYS`)。
- **Task 1.2**: 開發 `scraper_core.py`，實作雙重驗證機制的爬蟲介面。
- **Task 1.3**: 執行歷史大建檔，撈取大樂透與今彩 539 歷年所有數據，產出 `data/lotto649.json` 與 `data/daily539.json`。

### 🥈 階段二：自動化閉環 (Phase 2: Automation & Push Notification)
*目標：實現每日自動更新數據，並能成功發送 LINE Notify。*
- **Task 2.1**: 開發每日抓取最新一期號碼的邏輯，並正確 append 至 JSON 檔。
- **Task 2.2**: 實作 `notifier.py`，完成 LINE Notify 訊息組裝與發送測試。
- **Task 2.3**: 撰寫 GitHub Actions `update_data.yml` 排程腳本，測試自動 Commit 修改的 JSON 檔案回 Repo。

### 🥉 階段三：大腦賦能 (Phase 3: AI Inference Engine & Analytics)
*目標：實作統計模組與 LLM 深度推理，產出真實預測。*
- **Task 3.1**: 實作 `stats_engine.py` (整合 Pandas)，產出當期冷熱、遺漏值特徵字典。
- **Task 3.2**: 實作 `web_search.py` 輿情檢索模組。
- **Task 3.3**: 開發 `ai_predictor.py`，串接 LLM，產出預測結果並寫入 `predictions.json`。
- **Task 3.4**: 撰寫 GitHub Actions `predict_and_notify.yml`，於開獎日中午 12:00 自動觸發：運算 -> 寫檔 -> LINE 推播。

### 🏅 階段四：前台視覺化體驗 (Phase 4: Premium UI/UX Frontend)
*目標：為使用者打造極致的數據看板。*
- **Task 4.1**: 建立 Vue 3 + Vite 專案 `frontend/`，配置 Tailwind CSS。
- **Task 4.2**: 核心組件開發 (依循 `UI-UX Pro Max` 規範建立 Dashboard、Data Fetcher 取回 JSON 內容)。
- **Task 4.3**: 視覺化圖表整合 (歷史號碼熱力圖、統計圓餅圖)。
- **Task 4.4**: 設立 GitHub Actions `deploy_pages.yml`，一鍵編譯建置並發佈到 GitHub Pages。

---

## 4. 開發與執行規範（Fail Fast 原則落實）

於接下來的每個 Task 實作中，強制落實以下檢查：
1. **防禦性程式設計**：任何網路請求 (Requests)、資料解析、JSON 讀寫，皆須包覆嚴謹的 `try-catch`。
2. **狀態回報格式 (發生異常時)**：
   - `Status`: [Error / Warning]
   - `Root Cause`: [詳細分析錯誤發生的根本原因]
   - `Suggested Fix`: [提出具體可行的修正方案或程式碼]
3. **不可逆動作確認點設定**：
   - 在執行 Phase 1.3 (大量初始數據寫入)、Phase 2.3 (正式推上 GitHub Repo) 時，小賽必須暫停腳本，並詢問使用者的許可。
