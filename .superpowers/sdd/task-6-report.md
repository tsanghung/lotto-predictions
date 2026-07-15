# LAI v2 Task 6 Report

## Status

Task 6A complete. The pure LINE formatting and notification orchestration layer is green. `index.ts` wiring remains Task 6B and is not claimed complete here.

## RED Evidence

- `predictCore.test.mjs`: initially failed to load after the interrupted refactor, then reached 29 pass / 1 fail because ensemble `final_groups` did not match the canonical public combination labels.
- `notifyRuntime.test.mjs`: initially reached 2 pass / 7 fail because the dependency contract omitted injected `notificationKey` and `sourceKey`.
- The interrupted implementation also produced a `STRATEGY_NAMES` syntax error; Task 6A restored the legacy string semantics before proceeding.

## GREEN Implementation

- `predictCore.js` dispatches an LAI-specific LINE formatter with exactly two named groups, Power first/second areas, agent status, overlap, union size, evidence status and no guaranteed-hit claim.
- Ensemble `final_groups` uses the public record's canonical `prediction.combinations` shape.
- `notifyRuntime.js` provides a pure dependency-injected orchestration contract for flags, engine validation, state fetch, forecast persistence, dry-run, shadow selection, prediction evidence, reservation and LINE delivery.
- Active-state query failure is fatal; a successful empty query returns `null` and uses baseline state generation.
- Side-effect order is forecast persistence, dry-run return or prediction evidence persistence, notification reservation, then LINE send.

## Verification

- `predictCore.test.mjs`: 30 / 30 pass.
- `notifyRuntime.test.mjs`: 10 / 10 pass.
- All prediction library tests: 88 / 88 pass.
- Prediction visibility tests: 4 / 4 pass.
- `node --check` for `predictCore.js` and `notifyRuntime.js`: pass.
- `git diff --check`: pass; only existing LF/CRLF conversion warnings were printed.

## Commit Scope

- `supabase/functions/lotto-predict-notify/lib/predictCore.js`
- `supabase/functions/lotto-predict-notify/lib/predictCore.test.mjs`
- `supabase/functions/lotto-predict-notify/lib/notifyRuntime.js`
- `supabase/functions/lotto-predict-notify/lib/notifyRuntime.test.mjs`

## Findings Fix

- P3：逐段對照 `git show c7a754b:supabase/functions/lotto-predict-notify/lib/predictCore.js`，review 指定的註解區塊均已恢復為可讀的繁體中文，且目前 diff 不再包含這些註解的 mojibake 變更。
- P3：`predictCore.js` 已移除 UTF-8 BOM；檔案開頭 bytes 為 `69 6D 70`，未偵測到 replacement character 或常見 mojibake pattern。
- P3：未改動 legacy runtime 邏輯；功能差異僅限 Task 6A 的 evidence status、深層複製與 notification runtime／測試責任檔。

## Concerns

- `index.ts` does not use `notifyRuntime.js` yet. Task 6B must wire the tested orchestration into the actual Edge Function before Task 6 can be marked complete.

## Task 6B Production Wiring

### RED Evidence

- Command: `node --test supabase/functions/lotto-predict-notify/index.contract.test.mjs`
- Result: exit 1; 0 pass / 1 fail.
- Expected failure: `index.ts` did not import `executePredictionFlow` and `parseBooleanEnvFlag` from `lib/notifyRuntime.js`.

### GREEN Implementation

- `index.ts` imports and calls `executePredictionFlow` from the real `processGame` path.
- Request parsing passes `engine`, `LAI_V2_ENABLED`, and `LAI_V2_SHADOW_ENABLED` through the reviewed runtime helpers.
- Production adapters fetch active agent state on demand, upsert forecast rows with the migration conflict key, preserve ASI learning context, and wrap the existing prediction, notification, and LINE functions.

### GREEN Evidence

- Command: `node --test supabase/functions/lotto-predict-notify/index.contract.test.mjs`
- Result: exit 0; 1 pass / 0 fail.
- Command: `node --test supabase/functions/lotto-predict-notify/lib/*.test.mjs supabase/functions/lotto-predict-notify/index.contract.test.mjs`
- Result: exit 0; 89 pass / 0 fail.
- Command: `node --check supabase/functions/lotto-predict-notify/index.ts`
- Result: exit 0.
- Command: `node --check supabase/functions/lotto-predict-notify/index.contract.test.mjs`
- Result: exit 0.
- Command: `node --check supabase/functions/lotto-predict-notify/lib/notifyRuntime.js`
- Result: exit 0.
- Command: `node --check supabase/functions/lotto-predict-notify/lib/predictCore.js`
- Result: exit 0.
- Command: `git diff --check`
- Result: exit 0; only the existing LF/CRLF conversion warning for `index.ts` was printed.
- Command: `deno --version`
- Result: exit 1 because Deno is not installed or not on `PATH`; the available Node runtime successfully checked `index.ts` syntax.

### Task 6B Commit Scope

- `supabase/functions/lotto-predict-notify/index.ts`
- `supabase/functions/lotto-predict-notify/index.contract.test.mjs`
- `.superpowers/sdd/task-6-report.md`

## LINE Retry Idempotency Finding

### RED Evidence

- Command: `node --test supabase/functions/lotto-predict-notify/lib/notifyRuntime.test.mjs`
- Result before implementation: exit 1; 13 pass / 2 fail.
- Expected failures: `executePredictionFlow` passed `undefined` instead of a retry key, and an accepted LINE `409` was still thrown and marked failed.
- Command: `node --test supabase/functions/lotto-predict-notify/index.contract.test.mjs`
- Result before implementation: exit 1; 1 pass / 2 fail.
- Expected failures: the first push lacked `X-Line-Retry-Key`, and the LINE adapter did not inspect `x-line-accepted-request-id`.

### GREEN Implementation

- `notifyRuntime.js` derives a deterministic RFC UUID v5-shaped retry key from the notification key using SHA-1, passes it to `sendLineMessage`, and treats only a `409` with an accepted request id as `sent`.
- `index.ts` sends `X-Line-Retry-Key` on the first push and preserves accepted `409` response metadata for the runtime to mark `sent`; other `409` responses remain failures.
- Tests cover stable same-key UUIDs, UUID format, accepted `409`, and non-accepted `409` fail-fast behavior.

### GREEN Evidence

- Command: `node --test supabase/functions/lotto-predict-notify/index.contract.test.mjs`
- Result: exit 0; 3 pass / 0 fail.
- Command: `node --test supabase/functions/lotto-predict-notify/lib/*.test.mjs supabase/functions/lotto-predict-notify/index.contract.test.mjs`
- Result: exit 0; 94 pass / 0 fail.
- Command: `node --check supabase/functions/lotto-predict-notify/index.ts; node --check supabase/functions/lotto-predict-notify/index.contract.test.mjs; node --check supabase/functions/lotto-predict-notify/lib/notifyRuntime.js; node --check supabase/functions/lotto-predict-notify/lib/notifyRuntime.test.mjs`
- Result: exit 0.
- Command: `git diff --check`
- Result: exit 0; only existing LF/CRLF conversion warnings were printed.

### Commit Scope

- `supabase/functions/lotto-predict-notify/lib/notifyRuntime.js`
- `supabase/functions/lotto-predict-notify/lib/notifyRuntime.test.mjs`
- `supabase/functions/lotto-predict-notify/index.ts`
- `supabase/functions/lotto-predict-notify/index.contract.test.mjs`
- `.superpowers/sdd/task-6-report.md`

## Task 6B Production Wiring

### RED Evidence

- Command: `node --test supabase/functions/lotto-predict-notify/index.contract.test.mjs`
- Result: exit 1; 0 pass / 1 fail.
- Expected failure: `index.ts` did not import `executePredictionFlow` and `parseBooleanEnvFlag` from `lib/notifyRuntime.js`, proving the production wiring contract was absent before the implementation change.

### GREEN Implementation

- `index.ts` imports and calls `executePredictionFlow` from the real `processGame` path.
- Request parsing passes `engine`, `LAI_V2_ENABLED`, and `LAI_V2_SHADOW_ENABLED` through the reviewed runtime helpers.
- Production adapters fetch the active agent state on demand, batch-upsert forecast rows with the migration conflict key, preserve ASI learning context in prediction rows, and wrap the existing prediction, notification, and LINE functions.

### GREEN Evidence

- Command: `node --test supabase/functions/lotto-predict-notify/index.contract.test.mjs`
- Result: exit 0; 1 pass / 0 fail.
- Command: `node --test supabase/functions/lotto-predict-notify/lib/*.test.mjs supabase/functions/lotto-predict-notify/index.contract.test.mjs`
- Result: exit 0; 89 pass / 0 fail.
- Command: `node --check supabase/functions/lotto-predict-notify/index.ts`
- Result: exit 0.
- Command: `node --check supabase/functions/lotto-predict-notify/index.contract.test.mjs`
- Result: exit 0.
- Command: `node --check supabase/functions/lotto-predict-notify/lib/notifyRuntime.js`
- Result: exit 0.
- Command: `node --check supabase/functions/lotto-predict-notify/lib/predictCore.js`
- Result: exit 0.
- Command: `git diff --check`
- Result: exit 0; only the existing LF/CRLF conversion warning for `index.ts` was printed.

### Environment Note

- Command: `deno --version`
- Result: exit 1 because Deno is not installed or not on `PATH`; `node --check` successfully validated the TypeScript syntax used by `index.ts` in the available Node runtime.

### Task 6B Commit Scope

- `supabase/functions/lotto-predict-notify/index.ts`
- `supabase/functions/lotto-predict-notify/index.contract.test.mjs`
- `.superpowers/sdd/task-6-report.md`
