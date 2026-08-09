# Task 7 Report

## Status

`DONE_WITH_CONCERNS`

LAI v3 evidence learning is wired into the post-draw runtime after the existing LAI v2 ordered-learning path. V3 failures return `failed_isolated` and do not roll back the confirmed draw upsert, prediction evaluation, or LAI v2 checkpoint.

Production was not touched.

## Changed Files

- `supabase/functions/lotto-update/lib/evidenceLearning.js`
- `supabase/functions/lotto-update/lib/evidenceLearning.test.mjs`
- `supabase/functions/lotto-update/lib/lottoCore.js`
- `supabase/functions/lotto-update/lib/lottoCore.test.mjs`
- `supabase/functions/lotto-update/lib/postDrawLearning.test.mjs`
- `supabase/functions/lotto-update/index.ts`

## RED Evidence

1. `node --test supabase/functions/lotto-update/lib/evidenceLearning.test.mjs`
   - Expected RED: `ERR_MODULE_NOT_FOUND` for `evidenceLearning.js`.
2. `node --test supabase/functions/lotto-update/lib/postDrawLearning.test.mjs`
   - Expected RED: no post-v2 `runEvidenceLearningIsolated` wiring existed.
3. `node --test supabase/functions/lotto-update/lib/lottoCore.test.mjs`
   - Expected RED: an unchanged legacy payload versus a newly stored canonical revision was incorrectly detected as a correction (`true !== false`).
4. `node --test supabase/functions/lotto-update/lib/postDrawLearning.test.mjs`
   - Expected RED: v3 score history had no `pageSize`, `offset`, or pagination termination condition.

## GREEN Evidence

1. `node --test supabase/functions/lotto-update/lib/evidenceLearning.test.mjs supabase/functions/lotto-update/lib/lottoCore.test.mjs supabase/functions/lotto-update/lib/postDrawLearning.test.mjs`
   - Result: 53 passed, 0 failed.
2. `node --test supabase/functions/lotto-update/lib/*.test.mjs`
   - Result: 59 passed, 0 failed.
3. `node --test (rg --files supabase/functions -g '*.test.mjs')`
   - Result: 312 passed, 0 failed, 6 skipped existing slow tests.
4. `git diff --check`
   - Result: exit code 0; no whitespace errors.

## Interface Decisions

- V3 scores use `upsert_lotto_model_scores`; v2 queries explicitly select forecasts with `registry_id is null`, while v3 queries select `registry_id not.is.null`.
- V3 scoring invokes `scoreEvidenceForecast`; candidate history invokes `evaluateCandidateSeries`.
- Benjamini-Hochberg runs once over every finite candidate p-value for the same game and draw before each gate receives its adjusted q-value.
- Decisions are persisted through `record_lai_v3_decision`. Activation is attempted only when that RPC returns `decision = promote` and `to_status` is `canary` or `champion`, using the decision id with `activate_lai_v3_state`.
- Corrections preserve the old draw and revision, then use the atomic `record_lai_v3_correction` RPC to invalidate valid scores and insert one-for-one replacements.
- Missing official revision ids use a SHA-256 of canonical `{ game_name, draw_id, draw_date, sorted_numbers, special_number }`. Canonical provenance is retained so identical payloads from another source do not produce a false correction.
- V3 exceptions are caught after LAI v2 learning and surfaced as `failed_isolated`; service-role credentials remain server-side and are not returned or logged.

## Residual Risks

- `deno check supabase/functions/lotto-update/index.ts` could not run because `deno` is not installed or available on PATH in this environment. Node regression suites passed, but Edge TypeScript type-check remains unverified here.
- Function-level failures before a forecast is available have no experiment-run id to mark failed. Per-forecast failures with `experiment_run_id` are recorded in `lai_experiment_runs`.
- No production deployment, database write, scheduler invocation, or live API mutation was performed.

## Fix Round 1

### Status

`DONE_WITH_CONCERNS`

All 9 Critical/Important review findings were addressed. Production was not touched.

### Review Finding Mapping

1. Forecast REST shape: `fetchV3Forecasts` now joins `lai_model_registry` and the runner enriches by `registry_id`, rejecting cross-game, model-name, family, and embedded-registry mismatches.
2. Score revision contract: ordinary score rows always use `source_revision = original`; correction rows only go through `record_lai_v3_correction`, with one replacement and supersession claim per invalidated row. Tests enforce the Task 1 RPC restrictions.
3. Durable correction: current valid score history stores actual numbers in metrics. On every confirmed draw, stale valid scores reconstruct the prior payload and revision from durable rows. Missing replacement forecasts fail closed and are returned through the isolated v3 failure path.
4. Shadow-only gate counters: lifecycle counters are accepted only as explicit integer phase evidence, otherwise both are zero. Runtime passes `activationAuthorized: false`; historical sample count is never used as a lifecycle counter.
5. Canonical correction: `drawPayloadChanged` compares only canonical draw content. Explicit source revision changes alone do not create corrections.
6. Confirmed-draw entry point: after the v2 ready-prediction loop, every upserted confirmed draw is re-read and sent to the isolated v3 runner. This no longer depends on a ready production prediction or v2 `learned` result.
7. Fail-closed identities: registry uniqueness, same-game uniform-null baseline, forecast/registry identity, and valid score-history identity are verified before scoring or decisions. Missing baseline evidence produces a no-decision status.
8. Activation E2E: future activation requires all of `activationAuthorized === true`, local promotion target, complete active-state claim/source data before decision persistence, and persisted RPC `authorized === true`, `decision === promote`, and `to_status` canary/champion. Current runtime cannot satisfy the first condition.
9. History pagination: score history uses `draw_date, draw_id, id` ordering, `Prefer: count=exact`, Content-Range total verification, bounds of 100,000 rows and 200 pages, progress by returned row count for server caps below page size, and fail-closed missing-page/overflow checks.

### RED Evidence

Command:

```text
node --test supabase/functions/lotto-update/lib/evidenceLearning.test.mjs supabase/functions/lotto-update/lib/lottoCore.test.mjs supabase/functions/lotto-update/lib/postDrawLearning.test.mjs
```

Result before implementation: 51 passed, 7 failed. The failures covered repository-shaped registry enrichment, durable correction reconstruction, missing replacement forecast failure, baseline absence, canonical revision-only correction, deterministic bounded history pagination, and confirmed-draw v3 routing.

### GREEN Evidence

1. `node --test supabase/functions/lotto-update/lib/evidenceLearning.test.mjs supabase/functions/lotto-update/lib/lottoCore.test.mjs supabase/functions/lotto-update/lib/postDrawLearning.test.mjs`
   - 58 passed, 0 failed.
2. `node --test supabase/functions/lotto-update/lib/*.test.mjs`
   - 65 passed, 0 failed.
3. `$tests = rg --files supabase/functions | Where-Object { $_ -match '\\.test\\.(mjs|js)$' }; node --test $tests`
   - 317 passed, 0 failed, 6 skipped existing slow tests.
4. `node --check supabase/functions/lotto-update/lib/evidenceLearning.js`
   - exit code 0.
5. `git diff --check`
   - exit code 0.

### Interface Decisions

- The service-role Edge runtime reads only v3 forecasts with a registry join and sends no service-role secret in response or logs.
- Canonical draw revision remains draw/correction provenance only. The normal score RPC payload is fixed to `original` as required by Task 1.
- The v3 runner remains score-first, applies one Benjamini-Hochberg family adjustment per game/draw candidate set, then records hold/stage decisions. It has no local authorization fallback.
- V2 remains first. Any v3 exception is contained as `failed_isolated` after confirmed draw persistence and v2 work.

### Residual Risks

- `deno check supabase/functions/lotto-update/index.ts` remains unavailable because Deno is not installed and this repository has no reusable Edge TypeScript check configuration. No dependency was added for this check.
- The future activation boundary is intentionally unreachable in the current runtime. It needs a separately designed source of live lifecycle counters and active-state claim context before authorization can ever be enabled.
- No production deployment, database mutation, scheduler execution, or live external API mutation was performed.

## Fix Round 2

### Status

`DONE_WITH_CONCERNS`

All 4 open findings from the Fix Round 1 re-review were addressed. The six previously closed findings remain closed, `activationAuthorized` remains explicitly `false`, and production was not touched.

### Open Finding Mapping

1. Durable retry worklist:
   - Every non-dry-run invocation now reads bounded durable v3 forecasts, confirmed draws, and valid scores after LAI v2 finishes.
   - The worklist adds a draw when any current `(forecast_id, draw_id)` lacks a valid score or when a valid score's durable actual payload differs from the current confirmed draw.
   - Current invocation draw ids and durable pending draws are merged and deduplicated before isolated v3 execution. This recovers response loss, initially absent forecasts, late correction replacements, and partial score writes without a new schema.
2. Fail-closed validation:
   - Durable actual numbers must match game pick count and contain unique in-range integers; special-area values are validated against the game config.
   - Stale rows for one previous revision must reconstruct one identical canonical actual payload.
   - Before any decision RPC, the current active state must prove the same game, a valid version, status, champion model, champion weight source, learning config, and metrics. Future activation still requires the stricter claim/source contract.
3. Pagination:
   - Stable scans validate Content-Range coordinates against request offset and returned page length, exact total consistency, global identity uniqueness, and strictly increasing composite order.
   - Each scan is bounded by explicit row/page limits, uses a timestamp snapshot cutoff, then repeats the complete read and compares a stable full-row digest. Missing pages, changing totals, overflow, duplicate identities, ordering faults, coordinate faults, and same-total drift fail closed.
   - A server cap of 500 still returns all 1,200 fixture rows.
4. Late candidate:
   - Pending scoring is computed per current forecast and draw, independent of other valid scores for the draw.
   - A candidate arriving after the baseline is inserted alone and remains idempotent.
   - During correction, stale forecasts are replaced atomically through the correction RPC while newly arrived forecasts are inserted through the original-score RPC; a response loss between those operations is recoverable on the next durable invocation.

### RED Evidence

1. `node --test supabase/functions/lotto-update/lib/evidenceLearning.test.mjs`
   - Before implementation: 8 passed, 10 failed.
   - Failures covered malformed/conflicting durable actual payloads, missing active state, late candidates, correction plus late candidate, missing durable worklist, and missing stable pagination.
2. `node --test supabase/functions/lotto-update/lib/postDrawLearning.test.mjs`
   - Before Edge wiring: 11 passed, 3 failed.
   - Failures proved score history still used the prior reader and the handler lacked a durable pending worklist merged after v2.

### GREEN Evidence

1. `node --test supabase/functions/lotto-update/lib/evidenceLearning.test.mjs supabase/functions/lotto-update/lib/lottoCore.test.mjs supabase/functions/lotto-update/lib/postDrawLearning.test.mjs`
   - 74 passed, 0 failed.
2. `node --test supabase/functions/lotto-update/lib/*.test.mjs`
   - 81 passed, 0 failed.
3. `$tests = rg --files supabase/functions | Where-Object { $_ -match '\\.test\\.(mjs|js)$' }; node --test $tests`
   - 333 passed, 0 failed, 6 skipped existing slow tests.
4. `node --check supabase/functions/lotto-update/index.ts`
   - Exit code 0 under Node.js 24.15.0 syntax checking.
5. `git diff --check`
   - Exit code 0 before report append; rerun during final verification.

### Interface Decisions

- Durable discovery is read-only service-role REST over existing `lotto_model_forecasts`, `lotto_draws`, and `lotto_model_scores`; no migration or schema change was introduced.
- Forecast and draw scans are limited to 10,000 rows and 40 pages. Score scans are limited to 100,000 rows and 200 pages. Any exceeded bound fails closed inside the isolated v3 path.
- Snapshot columns use existing `created_at`, `updated_at`, and `evaluated_at` fields. Complete double reads detect mutation drift that preserves the same total.
- Normal score rows still use `source_revision = original`; corrections still use `record_lai_v3_correction`. Benjamini-Hochberg still runs once across the same game/draw candidate family before decisions.
- LAI v2 remains first. V3 worklist and evidence failures remain `failed_isolated` and cannot roll back draw persistence or v2 checkpoints.

### Residual Risks

- Deno is not installed in this environment, so `deno check supabase/functions/lotto-update/index.ts` remains unavailable. Node.js 24 syntax checking and all Node regression suites pass, but the Deno type graph is not independently verified here.
- Exact counts and complete double reads deliberately trade additional service-role REST work for deterministic fail-closed evidence. Explicit limits prevent unbounded accumulation; exceeding them requires an intentional future interface decision rather than silent truncation.
- No production deployment, database mutation, scheduler execution, frontend, LINE, or Gemini change was performed.
