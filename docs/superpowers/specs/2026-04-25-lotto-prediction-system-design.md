# 樂透投注號碼預測系統 - 專案設計與執行計畫書

**日期**：2026-04-25
**狀態**：已批准 (Approved)
**版本**：v1.0

## 1. 專案目標
開發一套完全佈署於 GitHub 的自動化「大樂透」與「今彩 539」預測系統。結合歷史數據統計、網路輿情分析與 LLM 深度推理，實現自動化數據撈取、號碼預測與 LINE Notify 每日推送。

## 2. 系統架構 (Architecture)

### 前端 (SPA)
- **技術棧**：HTML5, Vanilla CSS / Tailwind (UI-UX Pro Max 引導), JavaScript。
- **功能**：數據視覺化報表、AI 推理過程紀錄、最新開獎號碼。
- **託管**：GitHub Pages。

### 後端與自動化 (Serverless)
- **技術棧**：Python 3.10+, GitHub Actions。
- **儲存**：`data/lotto_history.json` (Git-based JSON Database)。
- **自動化任務**：
    - 每日開獎號碼爬蟲 (預設 21:00 執行)。
    - AI 推理引擎與號碼生成 (開獎日 11:00 執行)。
    - LINE Notify 推播服務 (開獎日 12:00 執行)。

## 3. 子任務分解 (Phase-based Tasks)

### 第一階段：數據基礎建設 (Data Foundation)
- **Task 1.1**: 設定 GitHub Actions 工作流、環境變數 (`LINE_NOTIFY_TOKEN`)。
- **Task 1.2**: 實作 `scraper.py`，支援台彩官網數據抓取與雙重驗證邏輯。
- **Task 1.3**: 初始化歷史完整數據庫，確保數據 100% 正確性。

### 第二階段：核心分析與預測 (AI Engine)
- **Task 2.1**: 開發統計模型模組 (冷熱門、遺漏值、迴歸分析)。
- **Task 2.2**: 實作 `predictor.py`，整合 LLM 進行深度推理，產出預測與推論過程。
- **Task 2.3**: 實作 `notifier.py` 與 LINE Notify API 介接。

### 第三階段：專屬介面開發 (Visual & Deployment)
- **Task 3.1**: 設計並實作 SPA 數據展示頁面，確保手機版完美呈現。
- **Task 3.2**: 完成 GitHub Pages 佈署流程，確保數據同步更新。

## 4. 驗證計劃 (Validation Plan)
- **數據驗證**：比對台彩官網與本地 JSON 數據。
- **自動化驗證**：手動觸發 GitHub Actions 測試推播與數據更新。
- **UI 驗證**：使用跨裝置模擬器確保 RWD 效果。

## 5. 免責聲明
預測結果僅供參考，不保證獲獎。本系統僅作為技術研究與數據分析工具。

---
*此文件由小賽 (Antigravity) 透過 brainstorming 技能產出。*
