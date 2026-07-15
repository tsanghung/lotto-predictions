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

## 6. LAI v2 部署狀態機

此章是正式切換程序，不是已部署證明。只有 production migration、Functions、training seed、shadow、dry run 與正式 10:00 checkpoint 全部留下驗證結果後，才能把 LAI v2 標記為已上線。

### Phase A：Schema 與 Functions

```powershell
$env:SUPABASE_PROJECT_REF = "<PROJECT_REF>"
npx --yes supabase link --project-ref $env:SUPABASE_PROJECT_REF
npx --yes supabase migration list
npx --yes supabase db push --dry-run
npx --yes supabase db push

npx --yes supabase functions deploy lotto-predict-notify --project-ref $env:SUPABASE_PROJECT_REF --no-verify-jwt
npx --yes supabase functions deploy lotto-update --project-ref $env:SUPABASE_PROJECT_REF --no-verify-jwt
npx --yes supabase functions deploy lotto-train-agent --project-ref $env:SUPABASE_PROJECT_REF --no-verify-jwt
```

必須先部署 migration，再部署 Functions；新版 Functions 依賴以下資料庫物件：

```text
lotto_agent_states
lotto_model_forecasts
lotto_model_scores
lotto_training_runs
lotto_training_draw_snapshots
lotto_learning_claims
claim_next_lai_learning(...)
activate_lotto_agent_state(jsonb)
activate_lotto_training_candidate(uuid)
```

Supabase 官方流程是先 `link`，再以 `db push --dry-run` 預覽、`db push` 套用 migration。不要在 SQL Editor 手動貼同一批 migration，以免 schema 與 migration history 分離。參考：[Database Migrations](https://supabase.com/docs/guides/deployment/database-migrations)、[CLI db push](https://supabase.com/docs/reference/cli/supabase-db-push)。

### Phase B：Secrets 與初始化

```powershell
npx --yes supabase secrets set `
  LAI_V2_SHADOW_ENABLED=false `
  LAI_V2_ENABLED=false `
  --project-ref $env:SUPABASE_PROJECT_REF
npx --yes supabase secrets list --project-ref $env:SUPABASE_PROJECT_REF
```

`SUPABASE_URL` 與 Supabase server keys 是 hosted Functions 的平台 secrets；`GEMINI_API_KEY`、`LINE_CHANNEL_ACCESS_TOKEN`、`LINE_USER_ID` 與 LAI flags 是專案自訂 Secrets。Secret 更新後立即生效，不需重新部署 Function。參考：[Edge Function Secrets](https://supabase.com/docs/guides/functions/secrets)。

先為「今彩 539」、「大樂透」、「威力彩」各完成 1 個 immutable walk-forward run，再呼叫：

```text
POST /rest/v1/rpc/activate_lotto_training_candidate
Body: { "p_run_id": "<COMPLETED_RUN_UUID>" }
```

此 RPC 是一次性 bootstrap guard。只要該彩種已有 state history 或 ordered learning claim 就會 fail fast，不會覆寫 production 狀態。完整 PowerShell 與 checkpoint SQL 見 [runtime-triggers.md](./runtime-triggers.md)。

### Phase C：Shadow 與 Dry Run

1. 設定 `LAI_V2_SHADOW_ENABLED=true`、`LAI_V2_ENABLED=false`。
2. 以 `game=due&dry_run=1` 呼叫 draw day，確認只新增 `forecast_mode=shadow` 證據。
3. 比較呼叫前後 `notification_logs.status=sent` 數量，必須不變。
4. 以 `game=all&dry_run=1&engine=lai-v2` 驗證每個彩種固定 2 組；威力彩兩組都必須有第二區。
5. 機率向量不合法、forecast 缺漏、prediction 組數不符或 notification 數量增加，任一項發生都不得進入 production。

### Phase D：Production

```powershell
npx --yes supabase secrets set `
  LAI_V2_SHADOW_ENABLED=false `
  LAI_V2_ENABLED=true `
  --project-ref $env:SUPABASE_PROJECT_REF
```

正式驗證以台灣時間 10:00 排程結果為準，不用手動 non-dry invoke 製造第二次 LINE。必須保存下列 checkpoint：

| Checkpoint | 合格條件 |
| --- | --- |
| Forecast | 每個 expert／version／date 只有 1 筆 `production` row |
| Prediction | 每個 game／date 只有 1 筆，model 為 `lai-v2`、固定 2 組 |
| LINE | notification key 只有 1 筆 `sent` |
| Frontend | 顯示「機率主攻」、「覆蓋探索」、state version 與證據狀態 |
| Post-draw | 隔日 06:00 產生 score、下一版 active state 與 LAI learning report |
| Idempotency | 重跑回傳 duplicate／already learned，不新增 state 或 score |

## 7. Rollback 與資料保留

```powershell
npx --yes supabase secrets set `
  LAI_V2_SHADOW_ENABLED=false `
  LAI_V2_ENABLED=false `
  --project-ref $env:SUPABASE_PROJECT_REF
```

Rollback 後：

1. 下一次 prediction／LINE 回到 `game-theory-v1`。
2. LAI tables、training snapshots、forecast、score、claim 與 active state 全部保留。
3. 不回滾或刪除 migration；資料結構保留供診斷與再次 dry run。
4. 若是資料順序或重複學習事故，先停用相關 Supabase Cron，再保存 Function log、state、claim 與 recovery audit。
5. 修正後先重做 shadow 與 production dry run，禁止直接重新開 `LAI_V2_ENABLED`。

Functions 使用 server-to-server secret 並在 handler 內再次驗證，因此 deploy 採 `--no-verify-jwt`。Supabase gateway 不會把 `sb_secret_...` 當 JWT；關閉 gateway JWT 檢查後仍必須由 handler 驗證 secret。參考：[Authorization Headers](https://supabase.com/docs/guides/functions/auth-headers)、[Securing Edge Functions](https://supabase.com/docs/guides/functions/auth)。
