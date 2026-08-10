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

## LAI v2 walk-forward 初始化（僅限人工執行）

'lotto-train-agent' 只處理已建立的 'lotto_training_runs'，每次最多前進一個 chunk。這個 Function 不加入每日排程，也不會直接寫入或啟用 production 'lotto_agent_states'。

### 1. 部署 Function

先在本機工作階段設定環境變數，不要把真實 project ref 或 service-role key 寫進 repo：

~~~powershell
$env:SUPABASE_PROJECT_REF = "<PROJECT_REF>"
$env:SUPABASE_URL = "https://<PROJECT_REF>.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY = "<SERVICE_ROLE_KEY>"

npx --yes supabase link --project-ref $env:SUPABASE_PROJECT_REF
npx --yes supabase db push
npx --yes supabase functions deploy lotto-train-agent --project-ref $env:SUPABASE_PROJECT_REF --no-verify-jwt
~~~

'lotto-train-agent' 會在 handler 內比對完整 service secret，因此使用新的 'sb_secret_...' key 時必須以 '--no-verify-jwt' 部署，避免 gateway 在 handler 前把非 JWT key 拒絕。舊版 service-role JWT 也走同一套 handler 驗證。若要輪替或並存多把 server key，將 JSON object 存入 Edge Function secret 'LOTTO_SERVICE_SECRET_KEYS'；不要使用保留的 'SUPABASE_' 前綴建立自訂 secret。

'SUPABASE_SERVICE_ROLE_KEY' 與 'LOTTO_SERVICE_SECRET_KEYS' 只能存在本機環境變數或 Supabase secret。禁止提交到 Git、文件範例、前端環境變數或 Cloudflare Pages。'--no-verify-jwt' 不代表公開存取；未帶入完全相符 server secret 的請求仍會由 Function 回傳 401。

### 2. 為 3 個彩種建立 run

下列指令會分別查詢「今彩 539」、「大樂透」與「威力彩」當下的精確資料筆數，再以該筆數建立 'range_end'。第一次執行 chunk 時，資料庫會把這些期數複製到 'lotto_training_draw_snapshots'；後續 chunk 只讀取該 immutable snapshot，因此歷史補登不會改變既有 run 的 cursor 語意。不可共用 fixture 數量或手動猜測筆數。

~~~powershell
$headers = @{
  apikey = $env:SUPABASE_SERVICE_ROLE_KEY
  Authorization = "Bearer $($env:SUPABASE_SERVICE_ROLE_KEY)"
  "Content-Type" = "application/json"
}
$countHeaders = $headers.Clone()
$countHeaders.Prefer = "count=exact"
$createHeaders = $headers.Clone()
$createHeaders.Prefer = "return=representation"

$gameNames = @("今彩539", "大樂透", "威力彩")
$runs = @($gameNames | ForEach-Object {
  $gameName = $_
  $encodedGameName = [uri]::EscapeDataString($gameName)
  $countUri = "$env:SUPABASE_URL/rest/v1/lotto_draws?game_name=eq.$encodedGameName&select=draw_id&limit=1"
  $countResponse = Invoke-WebRequest -Method Get -Uri $countUri -Headers $countHeaders
  $contentRange = [string]$countResponse.Headers["Content-Range"]
  if ($contentRange -notmatch '/(\d+)$') {
    throw "Cannot read exact draw count for $gameName."
  }
  $drawCount = [int]$Matches[1]
  if ($drawCount -le 0) {
    throw "No historical draws found for $gameName."
  }

  $runBody = @{
    game_name = $gameName
    run_type = "walk_forward_initialization"
    algorithm_version = "lai-v2"
    status = "queued"
    range_start = 0
    range_end = $drawCount
    checkpoint_cursor = 0
    summary = @{}
  } | ConvertTo-Json -Depth 6

  $created = Invoke-RestMethod -Method Post -Uri "$env:SUPABASE_URL/rest/v1/lotto_training_runs?select=id,game_name,status,range_end,checkpoint_cursor" -Headers $createHeaders -Body $runBody
  $created[0]
})
$runs | Format-Table id, game_name, status, range_end, checkpoint_cursor
~~~

### 3. 逐 chunk 執行單一 run

把上一段產生的 UUID 填入 '$runId'。每次呼叫最多處理 25 期；Function 僅接受整數 'chunk_size' 1 至 100。

~~~powershell
$runId = "<TRAINING_RUN_UUID>"
$encodedRunId = [uri]::EscapeDataString($runId)
$previousCursor = -1

while ($true) {
  $inspectUri = "$env:SUPABASE_URL/rest/v1/lotto_training_runs?id=eq.$encodedRunId&select=*"
  $run = @(Invoke-RestMethod -Method Get -Uri $inspectUri -Headers $headers)[0]
  if (-not $run) { throw "Training run not found: $runId" }
  if ($run.status -eq "completed") { break }
  if ($run.status -eq "failed") { throw "Training failed: $($run.error_text)" }
  if ([int]$run.checkpoint_cursor -le $previousCursor) {
    throw "Checkpoint did not progress; stop instead of retrying blindly."
  }

  $previousCursor = [int]$run.checkpoint_cursor
  $invokeBody = @{ run_id = $runId; chunk_size = 25 } | ConvertTo-Json -Compress
  $progress = Invoke-RestMethod -Method Post -Uri "$env:SUPABASE_URL/functions/v1/lotto-train-agent" -Headers $headers -Body $invokeBody

  if ($progress.status -ne "completed" -and [int]$progress.checkpoint_cursor -le $previousCursor) {
    throw "Function returned a non-progressing checkpoint."
  }
  $progress | Format-List status, run_id, checkpoint_cursor, range_end
}
~~~

對 '$runs' 中的 3 個 run 分別執行，不要建立自動連續重訓排程。

### 4. 檢查 checkpoint 與完成條件

~~~powershell
$runId = "<TRAINING_RUN_UUID>"
$encodedRunId = [uri]::EscapeDataString($runId)
$fields = "id,game_name,status,range_start,range_end,checkpoint_cursor,summary,error_text,started_at,completed_at"
Invoke-RestMethod -Method Get -Uri "$env:SUPABASE_URL/rest/v1/lotto_training_runs?id=eq.$encodedRunId&select=$fields" -Headers $headers
Invoke-RestMethod -Method Get -Uri "$env:SUPABASE_URL/rest/v1/lotto_training_draw_snapshots?run_id=eq.$encodedRunId&select=sequence_no,draw_id,draw_date&order=sequence_no.asc" -Headers $headers
~~~

只有同時符合 'status = completed'、'checkpoint_cursor = range_end'、'summary.snapshot.frozen = true'，且 snapshot 筆數等於 'range_end' 的 run，才可進入後續人工驗證與 candidate state 匯入流程。'queued'、'running'、'failed' 或 cursor 未到終點的 run，一律不得作為 production state 種子。


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

## LAI v2 正式切換 Runbook

### 1. 旗標狀態

| `LAI_V2_SHADOW_ENABLED` | `LAI_V2_ENABLED` | 正式 prediction／LINE | LAI forecast |
| --- | --- | --- | --- |
| `false` | `false` | 舊版 `game-theory-v1` | 不執行 |
| `true` | `false` | 舊版 `game-theory-v1` | 寫入 `shadow` 證據 |
| `false` | `true` | LAI v2 固定 2 組 | 寫入 `production` 證據 |

兩個旗標應互斥。`engine=lai-v2` 只允許搭配 `dry_run=1`，可在不保留 LINE notification、不發送 LINE 的前提下驗證 LAI output。

### 2. 部署前檢查

```powershell
$env:SUPABASE_PROJECT_REF = "<PROJECT_REF>"
$env:SUPABASE_URL = "https://<PROJECT_REF>.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY = "<SERVER_SECRET>"

npx --yes supabase link --project-ref $env:SUPABASE_PROJECT_REF
npx --yes supabase migration list
npx --yes supabase db push --dry-run
npx --yes supabase secrets set LAI_V2_SHADOW_ENABLED=false LAI_V2_ENABLED=false --project-ref $env:SUPABASE_PROJECT_REF
```

`db push --dry-run` 只用來預覽；確認 migration 順序包含 `20260710000000`、`20260715000000`、`20260715150000`、`20260715160000` 與 `20260715170000` 後，才可執行正式 `db push`。若 `migration list` 顯示 remote history 不一致，停止部署並先釐清；不可直接執行 `migration repair` 猜測狀態。

### 3. 套用 migration 與部署 Functions

```powershell
npx --yes supabase db push
npx --yes supabase functions deploy lotto-predict-notify --project-ref $env:SUPABASE_PROJECT_REF --no-verify-jwt
npx --yes supabase functions deploy lotto-update --project-ref $env:SUPABASE_PROJECT_REF --no-verify-jwt
npx --yes supabase functions deploy lotto-train-agent --project-ref $env:SUPABASE_PROJECT_REF --no-verify-jwt
npx --yes supabase secrets list --project-ref $env:SUPABASE_PROJECT_REF
```

這 3 個 Functions 都由 handler 再次比對 server secret。使用 `sb_secret_...` 時，它不是 JWT，因此 gateway 的 JWT 驗證必須停用；`--no-verify-jwt` 不等於公開存取。`SUPABASE_SERVICE_ROLE_KEY`、`SUPABASE_SECRET_KEYS` 或自訂 `LOTTO_SERVICE_SECRET_KEYS` 不得放入前端、Cloudflare Pages 或 Git。

### 4. 完整歷史初始化與人工 seed

先依本文件前段流程建立並完成 3 個 `lotto_training_runs`。每個 run 必須同時符合：

1. `run_type = walk_forward_initialization`、`algorithm_version = lai-v2`。
2. `status = completed`、`checkpoint_cursor = range_end`。
3. `range_start = 0`，且 `summary.snapshot.frozen = true`。
4. snapshot 實際筆數與 `range_end` 相同。
5. `summary.state` 的最後 draw id／date 與 snapshot 最後一筆完全相同。

檢查 SQL：

```sql
select
  id,
  game_name,
  status,
  range_end,
  checkpoint_cursor,
  summary #>> '{snapshot,frozen}' as snapshot_frozen,
  summary #>> '{snapshot,draw_count}' as snapshot_draw_count,
  jsonb_array_length(summary->'state'->'metrics'->'recent_model_scores') as recent_score_count
from public.lotto_training_runs
order by created_at desc;
```

`recent_model_scores` 最多保留 500 期，提供最近 100／500 期 promotion window。完成後，以專用 RPC 一次性 seed；禁止直接修改 `lotto_agent_states`：

```powershell
$headers = @{
  apikey = $env:SUPABASE_SERVICE_ROLE_KEY
  Authorization = "Bearer $($env:SUPABASE_SERVICE_ROLE_KEY)"
  "Content-Type" = "application/json"
}

foreach ($run in $runs) {
  $seedBody = @{ p_run_id = $run.id } | ConvertTo-Json -Compress
  Invoke-RestMethod -Method Post `
    -Uri "$env:SUPABASE_URL/rest/v1/rpc/activate_lotto_training_candidate" `
    -Headers $headers -Body $seedBody
}
```

`activate_lotto_training_candidate` 只允許第一次初始化：若該彩種已有任何 `lotto_agent_states` 或 `lotto_learning_claims`，RPC 會拒絕。此時應停止並保存現況，不可刪除 state、claim、score 或 forecast 後重試。

### 5. Shadow 驗證

```powershell
npx --yes supabase secrets set LAI_V2_SHADOW_ENABLED=true LAI_V2_ENABLED=false --project-ref $env:SUPABASE_PROJECT_REF

$targetDate = "<DRAW_DATE_YYYY-MM-DD>"
$shadowUrl = "$env:SUPABASE_URL/functions/v1/lotto-predict-notify?game=due&dry_run=1&target_date=$targetDate"
$beforeSent = Invoke-RestMethod -Method Get `
  -Uri "$env:SUPABASE_URL/rest/v1/notification_logs?target_date=eq.$targetDate&status=eq.sent&select=notification_key" `
  -Headers $headers
$shadow = Invoke-RestMethod -Method Post -Uri $shadowUrl -Headers $headers -Body '{}'
$afterSent = Invoke-RestMethod -Method Get `
  -Uri "$env:SUPABASE_URL/rest/v1/notification_logs?target_date=eq.$targetDate&status=eq.sent&select=notification_key" `
  -Headers $headers
if ($afterSent.Count -ne $beforeSent.Count) { throw "Shadow dry run changed sent notifications." }
```

再查 `lotto_model_forecasts`：相同彩種、日期、model name、version 與 `forecast_mode = shadow` 只能有 1 筆；機率向量長度、值域與總和必須符合各彩種規則。Shadow 不得改寫前端 prediction，也不得發 LINE。

### 6. Production dry run

旗標仍維持 Shadow 狀態即可；`engine=lai-v2` 會讓這次 dry run 選用 LAI，但不影響正式旗標：

```powershell
$dryRunUrl = "$env:SUPABASE_URL/functions/v1/lotto-predict-notify?game=all&dry_run=1&engine=lai-v2&target_date=$targetDate"
$dryRun = Invoke-RestMethod -Method Post -Uri $dryRunUrl -Headers $headers -Body '{}'
$dryRun | ConvertTo-Json -Depth 20
```

必須確認每個彩種只有「機率主攻」與「覆蓋探索」2 組；今彩 539 每組 5 號，大樂透與威力彩第一區每組 6 號，威力彩兩組各有 1 個合法第二區號碼。`notification_logs` 的 `sent` 數量不得增加。

### 7. 正式啟用與 Checkpoint

```powershell
npx --yes supabase secrets set LAI_V2_SHADOW_ENABLED=false LAI_V2_ENABLED=true --project-ref $env:SUPABASE_PROJECT_REF
```

Secrets 儲存後立即生效，不需要重新 deploy。等待下一次台灣時間 10:00 正式排程，再依序確認：

1. `lotto_model_forecasts.forecast_mode = production`。
2. `prediction_records.prediction->>'model' = lai-v2`，且每個彩種／日期只有 1 筆 prediction。
3. 每筆 prediction 只有 2 組，威力彩包含兩組第二區。
4. `notification_logs` 同一 notification key 只有 1 筆 `sent`。
5. 重複 invoke 回傳 `skipped_duplicate`，不再次推送 LINE。
6. 隔日 06:00 對獎後，`lotto_model_scores`、下一版 active state 與 `asi_learning_records.raw_learning_report.lai` 同步出現。

```sql
select game_name, state_version, status, champion_model,
       last_learned_draw_id, last_learned_draw_date, is_active, activated_at
from public.lotto_agent_states
order by game_name, state_version desc;

select game_name, draw_date, model_name,
       metrics->>'brier_skill_score' as brier_skill_score,
       weight_before, weight_after
from public.lotto_model_scores
order by draw_date desc, game_name, model_name;
```

每個彩種只能有 1 筆 `is_active = true`。相同 draw 重跑不得增加第二個 draw checkpoint 或重複 score。

### 8. Rollback

```powershell
npx --yes supabase secrets set LAI_V2_SHADOW_ENABLED=false LAI_V2_ENABLED=false --project-ref $env:SUPABASE_PROJECT_REF
```

Rollback 只切回 `game-theory-v1`，不刪除 `lotto_agent_states`、training runs、forecasts、scores、claims 或 learning reports。先以 `dry_run=1` 驗證 response 的 model 已回到舊版，再等待下一個 10:00 排程。若是資料一致性事故，除了關閉旗標，也應暫停相關 Cron job 並保留所有證據，確認原因後才恢復。

## LAI v3 Evidence Agent（目前僅限 Shadow）

目前正式交付 lane 固定為既有 LAI v2 或 honest fallback。LAI v3 僅能產生隔離的 shadow evidence；所有呼叫 `runEvidenceLearningForDraw` 的路徑皆以 `activationAuthorized: false` 執行，因此不會啟用 v3 active state、覆寫正式推薦或發送額外 LINE。

### 1. 台灣時間 06:00：開獎資料、對獎與證據學習

`0 22 * * *` UTC 的 `public.invoke_lotto_update()` 依序執行：

1. 以台灣前一天為 `target_date` 取得各彩種官方開獎資料，必要時套用第二來源與修正資料。
2. Upsert `lotto_draws`，偵測既有期別的 canonical payload 是否變更；變更會留下 LAI v3 correction evidence，不會靜默覆蓋評分脈絡。
3. 對已可對獎的正式 `prediction_records` 執行 LAI v2 對獎、模型評分、active state checkpoint 與效能快照更新。
4. 對已確認開獎且存在 v3 forecast 的期別，計算不可變 v3 proper score、更新 experiment evidence 與 promotion decision。v3 失敗只記錄 `failed_isolated`，不得回滾已確認的開獎資料或干擾 v2 checkpoint。

有效樣本以「同一彩種、已成功產生 forecast 且已成功評分」的 draw 為準；calendar day、沒有開獎日、重複呼叫與失敗期別都不得灌入樣本數。

### 2. 台灣時間 10:00：當日預測與通知

`0 2 * * *` UTC 的 `public.invoke_lotto_predict_notify()` 只處理當日應開獎的彩種：

1. 讀取截至當下可確認的歷史資料與既有正式 v2 active state。
2. 產生既有正式 prediction，先寫入 `prediction_records`，再 reserve 唯一 `notification_key`，最後才發送 LINE；重試沿用 deterministic retry key。
3. 當 `LAI_V3_SHADOW_ENABLED=true` 時，額外建立 v3 experiment 並只寫入 `lotto_model_forecasts.forecast_mode = shadow`。此步驟不得寫入 v3 `prediction_records`、evidence snapshot 或 notification log，也不得發送第二筆 LINE。
4. V3 shadow 失敗會回報 isolated status，正式 v2／honest lane 照既有規則繼續或明確失敗。

### 3. LAI v3 旗標真值表

| `LAI_V3_SHADOW_ENABLED` | `LAI_V3_PRODUCTION_ENABLED` | 現行 v3 行為 | 正式預測與 LINE |
| --- | --- | --- | --- |
| `false` | `false` | 不執行 v3 | 既有 v2／honest lane |
| `true` | `false` | 只寫入 shadow forecast 與 experiment evidence | 既有 v2／honest lane |
| `false` | `true` | 視為安全阻擋，仍只嘗試 shadow | v3 不可正式交付；有 v2 state 時仍走 v2，否則回傳 `blocked_no_valid_state` |
| `true` | `true` | 同上，production flag 不會提高 v3 權限 | 同上 |

`LAI_V3_PRODUCTION_ENABLED` 不是 canary 或 champion 的開關。現行程式故意拒絕 `engine=lai-v3` 的非 dry-run 請求；`engine=lai-v3&dry_run=1` 也是零寫入 preview，且只有在未來存在完整且已核准的 v3 state 時才會回傳號碼。

### 4. 階段門檻與人工授權

1. Phase A：migration、Function 與本機 replay 全數通過，仍不改變正式 lane。
2. Phase B：經人工部署後才可啟用 `LAI_V3_SHADOW_ENABLED=true`，每個候選模型與每個彩種至少累積 `30` 個有效 live shadow draws。
3. Phase C：目前 runtime 鎖定，不能靠任何 secret 或 URL 參數進入 canary。必須新增可審查的 activation boundary、通過 `--require-stage=canary` 的唯讀 verifier，並取得新的明確人工授權後，才可修改此政策。
4. Phase D：同樣不能自動進入 champion。除完整 gate、至少 `20` 個有效 canary draws 與回退驗證外，還需要新的程式變更與人工授權。

### 5. 唯讀驗證與回復

```powershell
$env:SUPABASE_URL = "https://<PROJECT_REF>.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY = "<SERVICE_ROLE_KEY>"
$env:SUPABASE_ANON_KEY = "<ANON_KEY>"

node scripts/lai_v3_verify.mjs
node scripts/lai_v3_verify.mjs --require-stage=shadow_verified
```

Verifier 只使用 Supabase REST `GET`，檢查 v3 RLS、每彩種唯一 `uniform-null` baseline、experiment cursor 與 digest、shadow isolation、active state、canary 10% 上限與 LINE sent key 去重。任何失敗皆以 JSON `Status`、`RootCause`、`SuggestedFix` 回報並以非零 exit code 結束。

若需要立即停止 v3 shadow，僅將兩個 v3 flag 都設為 `false`，保留所有 experiment、forecast、score、correction 與 decision evidence 供事後稽核；不得刪除資料，也不得為了補送手動重送 LINE。
