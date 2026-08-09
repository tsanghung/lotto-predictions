# Task 6 Fix Round 1 Report

## Scope

本輪依 `task-6-review.md` 修正全部 8 項 finding，維持 LAI v3 shadow-only，未新增 migration/schema，也未加入 promotion、activation、production prediction、LINE、Gemini 或 frontend 行為。LAI v2 request/response 與 `walkForwardChunk` 行為維持相容；LAI v3 chunk 上限仍為 `1..25`，且只使用 frozen snapshot 的 preceding prefix。

## Fix Summary

1. 將 LAI v3 failure protocol 改為先以原 claimed training-run version 執行 CAS，只有 ownership 仍成立時才可用原 experiment version 寫入 failed。`failExperiment` 不再重新讀取最新 experiment；任一 CAS miss 只回 concurrency conflict。
2. 將 checkpoint/terminal protocol 改為 training run 為權威紀錄、experiment 為可恢復 follower。最後 chunk 先把 state、metrics、replay digest 與 terminal evidence 以 training-run CAS 寫入 completed，再以原 experiment version 完成 experiment；training-run CAS miss 時不會留下 completed experiment。
3. completed training run 可冪等 reconcile experiment：若 experiment PATCH 已成功但 response 遺失，重試會驗證 cursor/digest 後直接返回；若 experiment 尚未寫入且仍符合 terminal ownership，重試可完成；版本或 digest 不符則 conflict。
4. Evidence state 新增 range、next cursor、processed count、last target identity 與 full evaluation population invariants；core 同時驗證 summary `last_chunk`、cursor、state 與 snapshot continuity，阻擋 gap、duplicate、advanced cursor without state 與 stale summary。
5. Candidate、baseline、experiment、training run provenance 全面 fail closed：驗證 game、linked ids、candidate 非 `uniform-null`、candidate/baseline id 不同、eligible status、seed、commit、feature、range 與 cutoff。
6. 每個 chunk 對完整 frozen snapshot 計算 `lai-training-snapshot-v1` SHA-256 digest，並固定 draw count、range、first/last draw bounds、data cutoff 與 created timestamp；後續 chunk 任一漂移即拒絕。
7. completed metrics 的 top-level 與 `fullRun` 都使用 Task 4 `CandidateEvidence` evaluator 的完整樣本母體。`recent`/`detailWindow` 僅使用最多 500 筆明細；full-run point estimate、CI、calibration、coverage 與 permutation p-value 不再混用 500-row evaluator 與 full sample count。
8. Dispatch 僅接受 `lai-v2` 或 `lai-v3`；未知版本在 processor 前拒絕。Evidence score 與 checkpoint aggregates 遇到 `NaN`/`Infinity` 直接失敗，不再轉成 `0`。

## Finding Mapping

### Critical 1: Stale Worker Failure Ownership

- `trainingCore.js` 先 CAS `markFailed(claimed, ...)` 證明 training-run ownership，再使用原始 experiment object 呼叫 `failExperiment`。
- `trainingHttp.js` 的 experiment failure PATCH 同時綁定原 `id + updated_at + status in (queued,running)`，不再 re-read winner。
- Adversarial coverage：run ownership CAS miss 不可呼叫 experiment failure；winner experiment re-read 被禁止。

### Critical 2: Terminal Consistency

- 最後 chunk 的寫入順序固定為 training-run CAS -> experiment completion CAS。
- training-run summary 保存 versioned terminal evidence，支援 response-loss recovery 與冪等 retry。
- training-run CAS miss 時 experiment completion 呼叫次數為 `0`；任何 conflict 不執行 failure cleanup。

### Important 3: State/Cursor Continuity

- State 綁定 `rangeStart`、`rangeEnd`、`nextCursor`、`processedDraws`、`lastTargetDrawId`、`lastTargetIdentity`。
- Core 驗證 `summary.last_chunk`、snapshot、state 與 cursor 一致，並檢查 processor 回傳的 cursor/step count/done。

### Important 4: Provenance

- Candidate 必須為非 `uniform-null` 且狀態屬於 eligible set；baseline 必須為唯一 `uniform-null + baseline`，兩者 id 不得相同。
- Experiment、run、candidate、baseline 的 game/linkage/seed/commit/feature/range/cutoff 必須一致。

### Important 5: Frozen Snapshot

- Snapshot descriptor 包含 version、SHA-256 digest、draw count、range、first/last draw id/date、data cutoff 與 stable created timestamp。
- 每個 chunk 都重新讀取 frozen rows 並比對 descriptor，count 相同但內容漂移也會失敗。

### Important 6: CandidateEvidence Metrics

- State 保留完整 deterministic evaluation rows，另將可展示的 recent details 限制為 500。
- `metrics.sampleCount`、`main`、`combined`、CI、calibration、coverage 與 p-value 全部來自同一 full-run population；`detailWindow` 明確標示 500-row window。

### Important 7: Algorithm Version

- Claim 前與 claim 後都驗證版本，只允許 `lai-v2`、`lai-v3`；未知版本不會進入任一 processor。
- LAI v2 chunk 上限與既有 execution/failure contract 保持不變。

### Minor 8: Non-finite Scores

- Running sums 與 state 中所有數字都必須 finite；`NaN`、`Infinity` 直接丟出錯誤。

## TDD Evidence

### RED

1. 初次 adversarial focused run：`35` passed、`17` failed。失敗涵蓋 full-run metrics、cursor/state continuity、provenance、snapshot drift、terminal ordering、unknown version 與 stale experiment failure。
2. 修正 unknown-version fixture 後，測試明確以「Missing expected rejection」失敗，證明舊實作把未知版本派到 v2 processor。
3. 額外 stale ownership test 在舊 failure ordering 下失敗：回傳原 processing error，且會先呼叫 experiment failure，而非 ownership conflict。

### GREEN

```powershell
node --test supabase/functions/lotto-train-agent/lib/evidenceTraining.test.mjs supabase/functions/lotto-train-agent/lib/trainingCore.test.mjs supabase/functions/lotto-train-agent/lib/trainingHttp.test.mjs
```

- `54` passed、`0` failed、`0` skipped。

```powershell
$allSupabaseTests = @(rg --files supabase/functions | Where-Object { $_ -like '*.test.mjs' })
node --test $allSupabaseTests
```

- `294` passed、`0` failed、`6` skipped existing slow stochastic tests。
- Node test summary：`300` tests、`294` pass、`0` fail、`6` skipped。

```powershell
git diff --check
```

- Exit `0`，無 whitespace error；Git 僅提示既有 Windows line-ending normalization warning。

## Residual Risks

1. 現有 schema 沒有可同時更新兩張表的 Task 6 RPC；Supabase Data REST 的兩個 PATCH 無法形成單一跨 request transaction。因此 protocol 刻意以 training run 作為權威 terminal record，允許短暫存在 `training run = completed`、`experiment = running`，並以 versioned terminal evidence 在重試時恢復。它不允許反向的假 completed experiment，也不會在 conflict 後自動覆寫新版本。
2. 為使 full-run bootstrap、permutation、calibration 與 coverage 使用同一母體，checkpoint state 會線性保留 compact evaluation rows；recent detail rows 仍限制為 500。極長歷史 replay 的 Edge memory 上限仍需在後續以 production-sized dry-run 驗證，但本輪未連線或部署 production。
3. 未執行 live Supabase、migration 或 deployment 驗證，符合本輪「不得部署或連 production」限制。完整 local Supabase Function tests 已通過；6 個標示 `slow` 的既有 stochastic tests 依原設定跳過。

## Fix Round 2

### Scope

本輪只修正 `task-6-r1-review.md` 的 4 個 open Important。沒有新增 migration/schema，沒有連線、部署或修改 production，也沒有加入 promotion、activation、production prediction、LINE、Gemini 或 frontend。LAI v3 仍為 shadow-only、chunk `1..25`、frozen snapshot 與 prefix-only；Round 1 已關閉的 7 項均保留。

### Finding Mapping

#### Important 1：Bounded Full-run CandidateEvidence

- 移除 checkpoint state 的無上限 `evaluationRows`，改用容量固定為 `500` 的 `deterministic-bottom-k-reservoir-v1`；`recentRows` 也維持最多 `500`，running sums 則保留完整母體的 deterministic aggregates。
- 每筆 reservoir entry 都保存可重算的 deterministic priority；state validation 拒絕 legacy `evaluationRows`、超限 reservoir、錯誤 priority、非 canonical 排序與非 finite aggregates。
- finalization 只建立固定上限 `500` 的 evaluator rows，並先恢復 draw chronology，再由同一組實際 evaluator rows 一次產出 point estimates、CI、calibration、coverage 與 permutation p-value。這可保留 Task 4 的 paired evaluator 與 block-resampling 時序語意。
- `metrics.statisticalPopulation` 與 `metrics.fullRun.statisticalPopulation` 明確記錄 `populationSampleCount`、實際 `evaluatorSampleCount`、`capacity`、`exact`、方法與實際 evaluator rows 的 SHA-256 `sampleDigest`。超過 `500` 筆時 `exact: false`；`metrics.sampleCount` 只回報 evaluator 實際收到的樣本數，不冒充 full population count。
- frozen replay 不再複製完整 draws，僅保存既有 frozen snapshot descriptor。20,000 筆對抗測試證明 state 的 recent rows 與 reservoir 都固定 `500`，序列化 payload 在 1,000 筆後不再隨母體線性成長。
- 此 bounded design 也避免逼近 Supabase Edge Function 官方列出的 `256 MB` memory limit：<https://supabase.com/docs/guides/functions/limits>。

#### Important 2：Failure PATCH Response-loss Reconciliation

- run failure CAS 現在先把 `lai-v3-failure-v1` terminal evidence 寫入 authoritative training-run summary，包含 experiment id、worker 原持有的 experiment `updated_at`、follower requirement 與 canonical failure payload。
- 若 `markFailed` 已提交但 response 遺失，下一次 retry 會辨識 `run.status = failed`，以 terminal evidence reconcile 尚未 failed 的 experiment follower。
- follower 已是相同 failure 時視為冪等成功；experiment version 或 terminal failure payload 不一致時 fail closed，且不覆寫 stale/newer row。
- HTTP repository boundary test 證明 failure PATCH 會保存 terminal evidence、移除 lease，並持續以原 run `updated_at` 執行 CAS。

#### Important 3：Completed Follower Metrics Reconciliation

- completed experiment reconciliation 除既有 cursor 與 replay digest 外，新增 `experiment.metrics` 與 `run.summary.v3_terminal.evidence.metrics` 的 canonical JSON equality check。
- matching cursor/digest 但 metrics 被竄改的 completed follower 現在會拒絕，不會被當成冪等完成。

#### Important 4：LAI v2 Non-zero Range Compatibility

- `checkpoint_cursor < range_start` 的嚴格 continuity validation 只套用於 LAI v3。
- LAI v2 恢復既有 cursor 計算：`Math.max(checkpoint_cursor, range_start)`。新增測試證明 non-zero `range_start` 且較低 checkpoint cursor 時，processor 從 `range_start` 開始。
- LAI v2 request/response、chunk 上限與 `walkForwardChunk` 均未修改。

### TDD Evidence

#### RED

1. bounded evidence tests 先因舊模組沒有 `accumulateEvidencePair` export 而失敗：`SyntaxError: evidenceTraining.js does not provide an export named accumulateEvidencePair`。
2. 4 個 core adversarial tests 在修正前為 `0/4`：v2 non-zero range 被 `Training run checkpoint_cursor precedes range_start` 拒絕；failed-run retries 被 `Training run status must be queued or running` 阻擋；completed follower metrics mismatch 則出現 `Missing expected rejection`。
3. 額外 chronology/digest 測試先以 sample digest mismatch 失敗，證明舊 finalization digest 的不是 evaluator 實際收到的時間序 rows。

#### GREEN

```powershell
node --test supabase/functions/lotto-train-agent/lib/evidenceTraining.test.mjs supabase/functions/lotto-train-agent/lib/trainingCore.test.mjs supabase/functions/lotto-train-agent/lib/trainingHttp.test.mjs
```

- Node test summary：`60` tests、`60` pass、`0` fail、`0` skipped。

```powershell
$allSupabaseTests = @(rg --files supabase/functions | Where-Object { $_ -like '*.test.mjs' })
node --test $allSupabaseTests
```

- Node test summary：`306` tests、`300` pass、`0` fail、`6` skipped。
- 6 項 skipped 均為既有明確標記的 slow stochastic tests。

```powershell
git diff --check
```

- Exit `0`，沒有 whitespace error；Git 僅顯示 Windows CRLF normalization warning。

### Residual Risks

1. 當 full population 超過 `500` 時，CandidateEvidence 是 deterministic bottom-k sample approximation，不是 exact full-population evaluator；輸出以 `exact: false`、population/evaluator counts 與 sample digest 明確揭露。所有統計量仍由同一 evaluator sample 產出，沒有混用 full aggregates 與 sampled CI/p-value。
2. 現有 schema 沒有跨 training run 與 experiment 的單一 transaction RPC；failure protocol 仍可能短暫存在 `run = failed`、`experiment = queued/running`，但 versioned terminal evidence 可在 retry 冪等收斂，stale version 只會 conflict。
3. 本輪依限制未執行 production-sized Edge invocation、live Supabase 或 deployment。完整 local `supabase/functions` tests 已通過；既有 6 個 slow stochastic tests 未執行。
