import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migrationUrl = new URL(
  "../../../migrations/20260715150000_serialize_lai_learning_by_draw_order.sql",
  import.meta.url,
);

async function migrationSource() {
  return readFile(migrationUrl, "utf8");
}

test("ordered claim ledger uses a renewable lease and one row per game draw", async () => {
  const source = await migrationSource();

  assert.match(source, /create table if not exists public\.lotto_learning_claims/is);
  assert.match(source, /primary key\s*\(game_name,\s*draw_id\)/is);
  assert.match(source, /claim_token\s+uuid/is);
  assert.match(source, /lease_expires_at\s+timestamptz/is);
  assert.match(source, /lease_expires_at\s*<=\s*now\(\)/is);
});

test("claim RPC serializes by game and selects the earliest eligible unlearned draw", async () => {
  const source = await migrationSource();
  const functionAt = source.indexOf("claim_next_lai_learning");
  const lockAt = source.indexOf("pg_advisory_xact_lock", functionAt);
  const pendingAt = source.indexOf("is_evaluated = false", lockAt);
  const orderAt = source.indexOf("order by draws.draw_date asc, draws.draw_id asc", pendingAt);
  const claimAt = source.indexOf("insert into public.lotto_learning_claims", orderAt);

  assert.ok(functionAt >= 0, "claim RPC must exist");
  assert.ok(lockAt > functionAt, "claim RPC must take the per-game transaction lock");
  assert.ok(pendingAt > lockAt, "eligible pending lookup must happen under the lock");
  assert.ok(orderAt > pendingAt, "eligible pending lookup must be chronological");
  assert.ok(claimAt > orderAt, "claim mutation must happen after chronological selection");
  assert.match(source, /exists\s*\([^)]*lotto_model_forecasts/is);
  assert.match(source, /not exists\s*\([^)]*lotto_agent_states/is);
  assert.match(source, /deferred_earlier_draw/);
});

test("activation RPC requires the live claim and durably completes it with the draw checkpoint", async () => {
  const source = await migrationSource();
  const activationAt = source.indexOf("create or replace function public.activate_lotto_agent_state");
  const tokenAt = source.indexOf("learning_claim_token", activationAt);
  const claimLockAt = source.indexOf("for update", tokenAt);
  const stateInsertAt = source.indexOf("insert into public.lotto_agent_states", claimLockAt);
  const learnedAt = source.indexOf("status = 'learned'", stateInsertAt);

  assert.ok(activationAt >= 0, "activation RPC replacement must exist");
  assert.ok(tokenAt > activationAt, "activation must require a claim token");
  assert.ok(claimLockAt > tokenAt, "activation must lock the durable claim row");
  assert.ok(stateInsertAt > claimLockAt, "state activation must follow claim verification");
  assert.ok(learnedAt > stateInsertAt, "claim must become learned after state checkpoint insertion");
  assert.match(source, /get diagnostics completed_claims = row_count/);
  assert.match(source, /learning_claim\.prediction_source_key\s*<>\s*incoming_source_key/is);
});

test("recovery RPC transactionally rewinds derived work and records an audit event", async () => {
  const source = await migrationSource();
  const recoveryAt = source.indexOf("create or replace function public.recover_lai_learning_order");
  const lockAt = source.indexOf("pg_advisory_xact_lock", recoveryAt);
  const resetAt = source.indexOf("update public.prediction_records", lockAt);
  const scoreDeleteAt = source.indexOf("delete from public.lotto_model_scores", resetAt);
  const stateDeleteAt = source.indexOf("delete from public.lotto_agent_states", scoreDeleteAt);
  const reactivateAt = source.indexOf("set is_active = true", stateDeleteAt);
  const auditAt = source.indexOf("insert into public.lotto_learning_recoveries", reactivateAt);

  assert.ok(recoveryAt >= 0, "recovery RPC must exist");
  assert.ok(lockAt > recoveryAt, "recovery must hold the per-game transaction lock");
  assert.ok(resetAt > lockAt, "affected predictions must be requeued under the lock");
  assert.ok(scoreDeleteAt > resetAt, "derived scores must be removed before replay");
  assert.ok(stateDeleteAt > scoreDeleteAt, "derived states must be removed before replay");
  assert.ok(reactivateAt > stateDeleteAt, "the predecessor state must be reactivated");
  assert.ok(auditAt > reactivateAt, "the rebase must be durably audited");
  assert.match(source, /create table if not exists public\.lotto_learning_recoveries/is);
  assert.match(source, /prediction->>'model'\s*=\s*'lai-v2'/is);
  assert.match(source, /removed_scores\s+jsonb/is);
  assert.match(source, /requeued_predictions\s+jsonb/is);
  assert.ok(
    source.indexOf("into removed_score_rows", lockAt) < scoreDeleteAt,
    "score payloads must be audited before deletion",
  );
  assert.ok(
    source.indexOf("into requeued_prediction_rows", lockAt) < resetAt,
    "prediction evaluations must be audited before requeue",
  );
});
