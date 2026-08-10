# Task 8 Report

## Status

`DONE_WITH_CONCERNS`

Task 8 now provides a deterministic constrained optimizer, an approved-state LAI v3 prediction builder, replayable SHA-256 evidence snapshots, and a dedicated LAI v3 LINE formatter. Every game emits exactly `證據主攻` and `覆蓋保底`; Power Lottery optimizes its second areas independently and keeps them different.

LAI v3 remains shadow-only at runtime. `activationAuthorized: false` was not changed, and Task 8 did not wire runtime activation or persistence.

Production was not touched.

## Changed Files

- `supabase/functions/lotto-predict-notify/lib/evidenceOptimizer.js`
- `supabase/functions/lotto-predict-notify/lib/evidenceOptimizer.test.mjs`
- `supabase/functions/lotto-predict-notify/lib/evidencePrediction.js`
- `supabase/functions/lotto-predict-notify/lib/evidencePrediction.test.mjs`
- `supabase/functions/lotto-predict-notify/lib/predictCore.js`
- `supabase/functions/lotto-predict-notify/lib/predictCore.test.mjs`
- `.superpowers/sdd/2026-08-06-lai-v3-evidence-agent-implementation/task-8-report.md`

## RED Evidence

1. `node --test supabase/functions/lotto-predict-notify/lib/evidenceOptimizer.test.mjs`
   - Expected RED: `ERR_MODULE_NOT_FOUND` for `evidenceOptimizer.js`.
2. `node --test supabase/functions/lotto-predict-notify/lib/evidencePrediction.test.mjs`
   - Expected RED: `ERR_MODULE_NOT_FOUND` for `evidencePrediction.js`.
3. `node --test --test-name-pattern="LAI v3 LINE" supabase/functions/lotto-predict-notify/lib/predictCore.test.mjs`
   - Expected RED: the existing generic formatter emitted `AI 樂透預測` and omitted LAI v3 evidence fields.
4. `node --test --test-name-pattern="replayable safe snapshot" supabase/functions/lotto-predict-notify/lib/evidencePrediction.test.mjs`
   - Expected RED during hardening: arbitrary nested `metrics.sample_counts` data entered public evidence.

## GREEN Evidence

1. `node --test supabase/functions/lotto-predict-notify/lib/evidenceOptimizer.test.mjs supabase/functions/lotto-predict-notify/lib/evidencePrediction.test.mjs supabase/functions/lotto-predict-notify/lib/predictCore.test.mjs`
   - Result: 39 passed, 0 failed.
2. `$tests = rg --files supabase/functions -g '*.test.mjs'; node --test $tests`
   - Result: 366 passed, 0 failed, 6 existing slow statistical tests skipped; 372 tests total.
3. Syntax and diff checks are rerun immediately before commit and recorded in the final Task 8 handoff.

## Implementation Contract

- Main-area optimization takes the probability-ranked attack group, then enumerates overlap from 0 through `floor(picks / 3)` and accepts the first coverage group reaching the fixed 0.90 utility ratio.
- Infeasible utility and overlap constraints throw `coverage_constraints_infeasible`; they are never silently relaxed.
- Power Lottery uses a separate seed and optimizer call for the second area with utility ratio 0 and maximum overlap 0.
- The formal ensemble uses only complete baseline, canary, or champion registry rows named by the approved state. Unknown weights, stale data, incomplete metrics, registry status drift, commit mismatch, or failed approved forecasts reject with `no_complete_approved_state`.
- Shadow forecasts are returned with zero active weight and never enter the formal aggregate.
- Snapshots align with the existing `lai_evidence_snapshots` field names. Their `groups` JSON includes optimizer config, state, registry versions, public evidence, and exact groups; calibrated vectors and a canonical SHA-256 replay digest are included.
- Public evidence is allowlisted to champion, promotion stage, bounded sample counts, Brier skill and interval, decision reason, evidence status, and limitation text. Registry parameters, credentials, and private experiment payloads are omitted.
- LAI v3 LINE output only formats the computed two groups, optional Power second areas, stage, champion, Brier skill interval, and evidence limitation. It does not invoke Gemini or rewrite numbers.
- LAI v2 prediction and LINE shapes remain unchanged.

## Fixture Correction

The plan's literal `normalizeProbabilityVector([39..1], 39, 5)` fixture projects to five probabilities of 1 and 34 probabilities of 0. With maximum overlap 1, coverage utility can reach only 20% of attack utility, so the required 90% floor is mathematically infeasible.

The feasible constraint test now scales the descending vector to a total of 5 before capped-simplex normalization. The original concentrated projection is retained in a separate fail-closed test. Production constraints and optimizer behavior were not weakened.

## Residual Risks

- Task 9 still owns runtime flags, Supabase repository writes, scheduler behavior, production fallback, dry-run boundaries, and LINE delivery. This task intentionally does not exercise those integration paths.
- Six existing slow statistical tests remain skipped by their declared test configuration.
- No production deployment, Supabase migration or database write, scheduler invocation, frontend change, LINE send, Gemini selection change, or activation-policy change was performed.
