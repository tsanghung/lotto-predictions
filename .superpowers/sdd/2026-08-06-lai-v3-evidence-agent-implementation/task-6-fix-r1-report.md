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
