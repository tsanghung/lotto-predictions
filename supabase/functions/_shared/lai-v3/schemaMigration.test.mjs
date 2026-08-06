import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = new URL(
  "../../../migrations/20260806000000_create_lai_v3_evidence_agent.sql",
  import.meta.url,
);
const trainingMigration = new URL(
  "../../../migrations/20260715170000_activate_lai_training_candidate.sql",
  import.meta.url,
);

test("LAI v3 schema is private, auditable, and atomically activated", async () => {
  const sql = await readFile(migration, "utf8");
  for (const table of [
    "lai_model_registry",
    "lai_experiment_runs",
    "lai_promotion_decisions",
    "lai_evidence_snapshots",
    "lai_evidence_corrections",
  ]) {
    assert.match(sql, new RegExp(`create table if not exists public\\.${table}`, "i"));
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`, "i"));
    assert.match(sql, new RegExp(`revoke all on table public\\.${table} from anon`, "i"));
  }
  assert.match(sql, /pg_advisory_xact_lock/i);
  assert.match(sql, /record_lai_v3_decision\(p_decision jsonb\)/i);
  assert.match(sql, /activate_lai_v3_state\(p_decision_id uuid, p_state jsonb\)/i);
  assert.match(sql, /challenger_weight > 0\.10/i);
  assert.doesNotMatch(sql, /grant execute[\s\S]*to (anon|authenticated)/i);
});

function functionSource(sql, signature) {
  const start = sql.search(signature);
  assert.notEqual(start, -1, `Missing function signature: ${signature}`);
  const end = sql.indexOf("$$;", start);
  assert.notEqual(end, -1, `Missing function terminator: ${signature}`);
  return sql.slice(start, end + 3);
}

function tableSource(sql, table) {
  const start = sql.search(new RegExp(`create table if not exists public\\.${table}\\s*\\(`, "i"));
  assert.notEqual(start, -1, `Missing table: ${table}`);
  const end = sql.indexOf(");", start);
  assert.notEqual(end, -1, `Missing table terminator: ${table}`);
  return sql.slice(start, end + 2);
}

test("LAI v3 migration preserves score writes through a server-only partial-index RPC", async () => {
  const sql = await readFile(migration, "utf8");
  const source = functionSource(sql, /create or replace function public\.upsert_lotto_model_scores\(p_scores jsonb\)/i);

  assert.match(source, /security definer/i);
  assert.match(source, /set search_path = pg_catalog, pg_temp/i);
  assert.match(source, /insert into public\.lotto_model_scores/i);
  assert.match(source, /on conflict \(forecast_id, draw_id\) where is_valid/i);
  assert.match(sql, /lotto_model_scores_one_valid_forecast_draw_idx[\s\S]*where is_valid;/i);
  assert.match(tableSource(sql, "lai_promotion_decisions"), /decision_sequence bigint not null/i);
  assert.doesNotMatch(tableSource(sql, "lai_experiment_runs"), /decision_sequence bigint not null/i);
  assert.match(sql, /grant execute on function public\.upsert_lotto_model_scores\(jsonb\) to service_role/i);
  assert.doesNotMatch(sql, /grant execute[\s\S]*upsert_lotto_model_scores[\s\S]*to (anon|authenticated)/i);
});

test("LAI v3 decision transitions are ordered, consumed once, and cannot be satisfied by comments", async () => {
  const sql = await readFile(migration, "utf8");
  const decisionSource = functionSource(sql, /create or replace function public\.record_lai_v3_decision\(p_decision jsonb\)/i);
  const activationSource = functionSource(sql, /create or replace function public\.activate_lai_v3_state\(p_decision_id uuid, p_state jsonb\)/i);
  const trainingSql = await readFile(trainingMigration, "utf8");
  const trainingSource = functionSource(trainingSql, /create or replace function public\.activate_lotto_training_candidate\(p_run_id uuid\)/i);

  for (const transition of [
    /'registered'.*'historical_passed'/is,
    /'historical_passed'.*'shadow_verified'/is,
    /'shadow_verified'.*'canary'/is,
    /'canary'.*'champion'/is,
  ]) assert.match(decisionSource, transition);
  assert.match(decisionSource, /p_decision->>'decision' = 'hold'[\s\S]*to_status' <> registry_row\.status/i);
  assert.match(decisionSource, /p_decision->>'decision' = 'demote'[\s\S]*'cooldown'/i);
  assert.match(decisionSource, /p_decision->>'decision' = 'disable'[\s\S]*'disabled'/i);
  assert.match(decisionSource, /decision_sequence/i);
  assert.match(decisionSource, /pg_catalog\.pg_advisory_xact_lock/i);
  assert.match(activationSource, /activated_at is not null/i);
  assert.match(activationSource, /decision_sequence/i);
  assert.match(activationSource, /registry_row\.status <> decision_row\.to_status/i);
  assert.match(activationSource, /set activated_at = pg_catalog\.now\(\)/i);
  assert.match(trainingSource, /algorithm_version <> 'lai-v2'/i);
});

test("LAI v3 canary keeps the approved champion identity and uniform-null is permanent", async () => {
  const sql = await readFile(migration, "utf8");
  const activationSource = functionSource(sql, /create or replace function public\.activate_lai_v3_state\(p_decision_id uuid, p_state jsonb\)/i);

  assert.match(activationSource, /p_state->>'champion_model' <> active_state\.champion_model/i);
  assert.match(activationSource, /p_state->>'status' <> active_state\.status/i);
  assert.match(activationSource, /expected_weights/i);
  assert.match(activationSource, /decision_row\.to_status = 'champion'/i);
  assert.match(sql, /model_family <> 'uniform-null'\s+or status = 'baseline'/i);
  assert.match(sql, /uniform-null baseline rows cannot be deleted/i);
});

test("LAI v3 corrections insert replacement payloads after invalidation in one transaction", async () => {
  const sql = await readFile(migration, "utf8");
  const source = functionSource(sql, /create or replace function public\.record_lai_v3_correction\(p_correction jsonb\)/i);

  assert.match(source, /replacement_scores/i);
  assert.match(source, /set is_valid = false/i);
  assert.match(source, /insert into public\.lotto_model_scores/i);
  assert.match(source, /supersedes_score_id/i);
  assert.match(source, /superseded\.id in\s*\([\s\S]*invalidated_score_ids/i);
  assert.match(source, /source_revision/i);
  assert.ok(
    source.indexOf("set is_valid = false") < source.indexOf("insert into public.lotto_model_scores"),
    "replacement scores must be inserted after invalidation",
  );
  assert.ok(
    source.indexOf("insert into public.lotto_model_scores") < source.indexOf("insert into public.lai_evidence_corrections"),
    "correction event must be recorded after replacement scores",
  );
});

test("every LAI v3 SECURITY DEFINER RPC pins pg_catalog and schema-qualifies application access", async () => {
  const sql = await readFile(migration, "utf8");
  for (const signature of [
    /create or replace function public\.upsert_lotto_model_scores\(p_scores jsonb\)/i,
    /create or replace function public\.record_lai_v3_decision\(p_decision jsonb\)/i,
    /create or replace function public\.activate_lai_v3_state\(p_decision_id uuid, p_state jsonb\)/i,
    /create or replace function public\.record_lai_v3_correction\(p_correction jsonb\)/i,
  ]) {
    const source = functionSource(sql, signature);
    assert.match(source, /security definer\s+set search_path = pg_catalog, pg_temp/is);
    assert.doesNotMatch(source, /set search_path = public/i);
    assert.match(source, /public\./i);
  }
});
