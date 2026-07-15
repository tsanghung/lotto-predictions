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

npx --yes supabase db push --project-ref $env:SUPABASE_PROJECT_REF
npx --yes supabase functions deploy lotto-train-agent --project-ref $env:SUPABASE_PROJECT_REF --use-api --no-verify-jwt
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
