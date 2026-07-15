# LAI v2 Task 7 Report

## Status

Complete. The lotto update Edge Function now scores saved LAI forecasts after each matching draw, checkpoints one normalized agent state per draw, and publishes LAI metrics in the performance snapshot.

## RED Evidence

### Pure scoring and state

- Command: `node --test supabase/functions/lotto-update/lib/lottoCore.test.mjs`
- Result before implementation: exit 1; 15 pass / 5 fail.
- Expected failures: `scoreModelForecast` and `buildNextAgentState` were not functions.

### Performance snapshot

- Command: `node --test --test-name-pattern="extends performance snapshot with LAI metrics" supabase/functions/lotto-update/lib/lottoCore.test.mjs`
- Result before implementation: exit 1; 0 pass / 1 fail.
- Expected failure: the legacy snapshot preserved its fields but returned `lai: undefined`.

### Production index wiring

- Command: `node --test --test-name-pattern="index wiring" supabase/functions/lotto-update/lib/lottoCore.test.mjs`
- Result before implementation: exit 1; 0 pass / 3 fail.
- Expected failures: `index.ts` lacked the scoring/state imports, forecast/score/RPC helpers, ordered learning flow, and LAI snapshot context.

## GREEN Implementation

- `scoreModelForecast` reuses prediction `brierScore`, `logLoss`, `brierSkillScore`, and `coverageMetrics`; Power main and special areas are scored independently.
- `buildNextAgentState` reuses `updateHedgeWeights` and `evaluatePromotion`, normalizes finite expert weights, increments `state_version` once, records the draw checkpoint, and returns `already_learned` for a repeated draw.
- `buildPerformanceSnapshot` preserves the two-argument legacy behavior and accepts optional per-game LAI aggregates.
- `evaluateReadyPredictions` fetches matching `lotto_model_forecasts` and the active state before evaluation persistence. Forecast/state query failures throw.
- Score rows use `on_conflict=forecast_id,draw_id` with `resolution=merge-duplicates`; the score upsert completes before `rpc/activate_lotto_agent_state`.
- The `already_learned` branch does not call the activation RPC, and the database RPC independently serializes activation and returns the existing matching checkpoint.
- Performance rebuild fetches ensemble score history plus active states, deduplicates draw checkpoints, and passes LAI aggregates into the snapshot builder.

## GREEN Evidence

- Focused index contract: 3 / 3 pass.
- Update suite: 24 / 24 pass.
- Command: `node --test supabase/functions/lotto-update/lib/lottoCore.test.mjs supabase/functions/lotto-predict-notify/lib/*.test.mjs`
- Result: exit 0; 115 pass / 0 fail.
- Prediction index contract: 3 / 3 pass.
- Command: `node --check supabase/functions/lotto-update/lib/lottoCore.js; node --check supabase/functions/lotto-update/lib/lottoCore.test.mjs; node --check supabase/functions/lotto-update/index.ts`
- Result: exit 0.
- Command: `git diff --check`
- Result: exit 0; only existing LF/CRLF conversion warnings were printed.

## Verification Boundary

- No live Supabase writes were executed. REST paths, payload fields, conflict keys, RPC order, and fail-fast branches were checked against the migration and source contract tests.

## Commit Scope

- `supabase/functions/lotto-update/lib/lottoCore.js`
- `supabase/functions/lotto-update/lib/lottoCore.test.mjs`
- `supabase/functions/lotto-update/index.ts`
- `.superpowers/sdd/task-7-report.md`
