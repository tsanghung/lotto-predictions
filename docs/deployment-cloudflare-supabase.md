# Cloudflare Pages 與 Supabase 部署說明

## 1. 架構定位

| 平台 | 責任 |
| --- | --- |
| Cloudflare Pages | 前端網站 hosting 與自動部署 |
| Cloudflare DNS | `lotto.simonsynapse.net` 網域、DNS、HTTPS |
| Supabase Postgres | 正式資料庫 |
| Supabase Edge Functions | 後端資料更新、AI 預測、LINE 推送 |
| Supabase Cron | 每日 06:00 與 10:00 台灣時間的正式排程 |
| GitHub | 原始碼版本管理與 CI syntax check |

## 2. Supabase

### 套用資料庫 migration

```bash
supabase link --project-ref <project-ref>
supabase db push
```

正式排程由 Supabase migration 建立：

```text
supabase/migrations/20260616000000_rehome_runtime_triggers_to_supabase.sql
```

### 每日正式排程

| 作業 | 台灣時間 | UTC cron | 呼叫 |
| --- | --- | --- | --- |
| 補前一天開獎資料 | 06:00 | `0 22 * * *` | `public.invoke_lotto_update()` |
| AI 預測與 LINE 推送 | 10:00 | `0 2 * * *` | `public.invoke_lotto_predict_notify()` |

### 必要 Secret

Supabase Vault 必須存在：

```text
lotto_update_service_role_key
```

Supabase Edge Functions 必須設定：

```text
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
SUPABASE_ANON_KEY
GEMINI_API_KEY
LINE_CHANNEL_ACCESS_TOKEN
LINE_USER_ID
```

## 3. Cloudflare Pages

Cloudflare Pages 應使用 Git integration 連接 GitHub repo，監聽 `main` branch。

建置設定：

```text
Root directory: frontend
Build command: npm run build:cloudflare
Build output directory: dist
```

Cloudflare Pages 環境變數：

```text
VITE_BASE_PATH=/
VITE_SUPABASE_URL=<SUPABASE_URL>
VITE_SUPABASE_ANON_KEY=<SUPABASE_ANON_KEY>
```

正式網域：

```text
lotto.simonsynapse.net
```

## 4. GitHub Actions

GitHub Actions 不再負責正式部署或正式排程。

保留項目：

```text
.github/workflows/ci.yml
```

移除項目：

```text
deploy_cloudflare_pages.yml
keep_alive.yml
manual_lotto_update.yml
predict_and_notify.yml
repair_prediction_record.yml
update_data.yml
```

## 5. 驗證指令

### 驗證 Cloudflare Pages

```bash
curl -I https://lotto.simonsynapse.net/
```

### 驗證 Supabase Cron

```sql
select jobid, jobname, schedule, command, active
from cron.job
order by jobid;
```

預期：

```text
lotto-update-after-draw              0 22 * * *
lotto-predict-notify-after-update    0 2 * * *
```

### 驗證正式資料來源

前端應從 Supabase REST API 讀取：

```text
/rest/v1/app_meta
/rest/v1/lotto_draws
/rest/v1/prediction_records
```
