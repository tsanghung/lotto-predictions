# Runtime Triggers

## 正式環境責任邊界

GitHub 只作為原始碼倉庫與 CI 入口，不負責正式環境的排程、部署、資料更新、AI 預測或 LINE 推送。

| 範圍 | 負責平台 | Trigger | 用途 |
| --- | --- | --- | --- |
| 前端網站 | Cloudflare Pages | Cloudflare Git integration 監聽 `main` push | 建置並服務 `lotto.simonsynapse.net` |
| DNS / CDN | Cloudflare | Cloudflare Dashboard | 管理網域、DNS、快取與 HTTPS |
| 資料庫 | Supabase Postgres | Supabase migrations | 儲存開獎紀錄、預測紀錄、通知紀錄與統計快照 |
| 補開獎資料 | Supabase Cron + Edge Function | `0 22 * * *` UTC，台灣時間 06:00 | 查詢台灣昨天的開獎資料並回寫資料庫 |
| AI 預測與 LINE | Supabase Cron + Edge Function | `0 2 * * *` UTC，台灣時間 10:00 | 產生當天開獎遊戲的 AI 預測並推送 LINE |
| 語法檢查 | GitHub Actions | Push / pull request | 只做 Python compile check |

## 每日 Checkpoint

### 台灣時間 06:00：補前一天開獎資料

Supabase Cron job：

```sql
select public.invoke_lotto_update();
```

預期流程：

1. 用資料庫時間計算 `target_date = 台灣昨天`。
2. 呼叫 `lotto-update?game=all&target_date=YYYY-MM-DD`。
3. 查詢台灣彩券官方 API。
4. 若今彩 539 官方 API 缺少 `target_date`，改查第二來源。
5. Upsert `lotto_draws`。
6. 對 `target_draw_date <= target_date` 的待對獎預測執行對獎。
7. 更新 performance snapshots 與 app metadata。

### 台灣時間 10:00：AI 預測與 LINE 推送

Supabase Cron job：

```sql
select public.invoke_lotto_predict_notify();
```

預期流程：

1. 用資料庫時間計算 `target_date = 台灣今天`。
2. 呼叫 `lotto-predict-notify?game=due&target_date=YYYY-MM-DD`。
3. 依日期選出當天有開獎的遊戲：
   - 今彩 539：週一至週六。
   - 大樂透：週二、週五。
4. Gemini 主導產生 AI 預測。
5. 寫入 `prediction_records`。
6. 透過 `notification_logs` 保證同一遊戲與日期只推送一次。
7. 發送 LINE。

## GitHub Actions 邊界

正式 runtime workflows 已從 `.github/workflows` 移除，避免混用 GitHub、Supabase 與 Cloudflare 造成觸發來源不明。

目前只保留 `ci.yml`，因為它不會更新資料、不會部署前端、不會產生預測，也不會發送 LINE。

若正式環境需要手動修復，請使用：

1. Supabase SQL Editor。
2. Supabase Edge Function invocation。
3. Cloudflare Dashboard。

不要重新加入 GitHub Actions schedule 或正式 runtime workflow。

## Cloudflare 邊界

Cloudflare Pages 應透過 Git integration 自行監聽 repo push 並部署前端。

repo 不再使用 GitHub Actions 執行 Cloudflare Pages deploy，避免同時存在兩個部署權威。
