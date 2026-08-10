import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = new URL(
  "../../../migrations/20260806000000_create_lai_v3_evidence_agent.sql",
  import.meta.url,
);
const correctionEventMigration = new URL(
  "../../../migrations/20260810000000_normalize_lai_v3_correction_events.sql",
  import.meta.url,
);
const trainingMigration = new URL(
  "../../../migrations/20260715170000_activate_lai_training_candidate.sql",
  import.meta.url,
);

function stripSqlComments(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--[^\r\n]*/g, "");
}

function executableSql(sql) {
  return stripSqlComments(sql);
}

test("LAI v3 schema is private, auditable, and atomically activated", async () => {
  const sql = executableSql(await readFile(migration, "utf8"));
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
  sql = executableSql(sql);
  const start = sql.search(signature);
  assert.notEqual(start, -1, `Missing function signature: ${signature}`);
  const end = sql.indexOf("$$;", start);
  assert.notEqual(end, -1, `Missing function terminator: ${signature}`);
  return sql.slice(start, end + 3);
}

function tableSource(sql, table) {
  sql = executableSql(sql);
  const start = sql.search(new RegExp(`create table if not exists public\\.${table}\\s*\\(`, "i"));
  assert.notEqual(start, -1, `Missing table: ${table}`);
  const end = sql.indexOf(");", start);
  assert.notEqual(end, -1, `Missing table terminator: ${table}`);
  return sql.slice(start, end + 2);
}

test("LAI v3 migration preserves score writes through a server-only partial-index RPC", async () => {
  const sql = executableSql(await readFile(migration, "utf8"));
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
  const sql = executableSql(await readFile(migration, "utf8"));
  const decisionSource = functionSource(sql, /create or replace function public\.record_lai_v3_decision\(p_decision jsonb\)/i);
  const activationSource = functionSource(sql, /create or replace function public\.activate_lai_v3_state\(p_decision_id uuid, p_state jsonb\)/i);
  const trainingSql = executableSql(await readFile(trainingMigration, "utf8"));
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
  const sql = executableSql(await readFile(migration, "utf8"));
  const activationSource = functionSource(sql, /create or replace function public\.activate_lai_v3_state\(p_decision_id uuid, p_state jsonb\)/i);

  assert.match(activationSource, /p_state->>'champion_model' <> active_state\.champion_model/i);
  assert.match(activationSource, /p_state->>'status' <> active_state\.status/i);
  assert.match(activationSource, /expected_weights/i);
  assert.match(activationSource, /decision_row\.to_status = 'champion'/i);
  assert.match(sql, /model_family <> 'uniform-null'\s+or status = 'baseline'/i);
  assert.match(sql, /uniform-null baseline rows cannot be deleted/i);
  assert.match(
    sql,
    /create trigger protect_uniform_null_baseline\s+before update or delete on public\.lai_model_registry\s+for each row execute function public\.protect_uniform_null_baseline\(\)/is,
  );
});

test("LAI v3 corrections insert replacement payloads after invalidation in one transaction", async () => {
  const sql = executableSql(await readFile(migration, "utf8"));
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
  const sql = executableSql(await readFile(migration, "utf8"));
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

test("comment-only SQL tokens cannot satisfy semantic migration assertions", () => {
  const sql = executableSql(`
    -- algorithm_version <> 'lai-v2'
    /* create trigger protect_uniform_null_baseline */
    select 1;
  `);
  assert.doesNotMatch(sql, /algorithm_version <> 'lai-v2'/i);
  assert.doesNotMatch(sql, /create trigger protect_uniform_null_baseline/i);
});

test("LAI v3 activation receipts require the requested state to be durably activated", async () => {
  const sql = executableSql(await readFile(migration, "utf8"));
  const source = functionSource(sql, /create or replace function public\.activate_lai_v3_state\(p_decision_id uuid, p_state jsonb\)/i);

  assert.match(source, /select public\.activate_lotto_agent_state\(p_state\) into activated/i);
  for (const field of [
    /activated\.state_version is distinct from \(p_state->>'state_version'\)::bigint/i,
    /activated\.last_learned_draw_id is distinct from p_state->>'last_learned_draw_id'/i,
    /activated\.last_learned_draw_date is distinct from \(p_state->>'last_learned_draw_date'\)::date/i,
    /activated\.champion_model is distinct from p_state->>'champion_model'/i,
    /activated\.expert_weights is distinct from p_state->'expert_weights'/i,
    /activated\.learning_config is distinct from p_state->'learning_config'/i,
    /activated\.metrics is distinct from p_state->'metrics'/i,
    /activated\.metrics #>> '\{promotion_stage\}' is distinct from decision_row\.to_status/i,
  ]) assert.match(source, field);
  assert.ok(
    source.indexOf("select public.activate_lotto_agent_state(p_state) into activated") < source.indexOf("update public.lai_promotion_decisions"),
    "activation result must be validated before receipt update",
  );
  assert.match(source, /raise exception 'LAI v3 activation returned a state different from the requested promotion state'/i);
});

test("LAI v3 score upsert serializes each game and preserves correction provenance", async () => {
  const sql = executableSql(await readFile(migration, "utf8"));
  const source = functionSource(sql, /create or replace function public\.upsert_lotto_model_scores\(p_scores jsonb\)/i);

  assert.match(source, /pg_catalog\.pg_advisory_xact_lock\(pg_catalog\.hashtextextended\(score_game_name, 0\)\)/i);
  assert.match(source, /count\(distinct rows\.score->>'game_name'\)/i);
  assert.match(source, /where public\.lotto_model_scores\.source_revision = 'original'\s+and public\.lotto_model_scores\.supersedes_score_id is null/is);
  assert.match(source, /on conflict \(forecast_id, draw_id\) where is_valid/i);
  assert.match(source, /source_revision = excluded\.source_revision/i);
});

test("follow-up migration supports immutable keyed correction events without direct service-role writes", async () => {
  const sql = executableSql(await readFile(correctionEventMigration, "utf8"));

  assert.match(sql, /alter table public\.lai_evidence_corrections[\s\S]*add column if not exists event_key text/i);
  assert.match(sql, /add column if not exists event_payload jsonb/i);
  assert.match(sql, /event_key[\s\S]*set not null/i);
  assert.match(sql, /event_payload[\s\S]*set not null/i);
  assert.match(sql, /unique \(game_name, draw_id, previous_revision, corrected_revision, event_key\)/i);
  assert.doesNotMatch(sql, /unique \(game_name, draw_id, corrected_revision\)/i);
  assert.match(sql, /revoke (?:all|insert, update, delete)[\s\S]*on table public\.lai_evidence_corrections[\s\S]*from service_role/i);
  assert.match(sql, /grant select on table public\.lai_evidence_corrections to service_role/i);
  assert.doesNotMatch(sql, /grant all on table public\.lai_evidence_corrections to service_role/i);
});

test("keyed correction RPC is exact-replay idempotent and keeps each event transactional", async () => {
  const sql = executableSql(await readFile(correctionEventMigration, "utf8"));
  const source = functionSource(sql, /create or replace function public\.record_lai_v3_correction\(p_correction jsonb\)/i);

  assert.match(source, /security definer\s+set search_path = pg_catalog, pg_temp/is);
  assert.match(source, /nullif\(pg_catalog\.btrim\(p_correction->>'event_key'\), ''\) is null/i);
  assert.match(source, /canonical_event_payload/i);
  assert.match(source, /previous_revision[\s\S]*corrected_revision[\s\S]*event_key/i);
  assert.match(source, /correction_row\.event_payload is distinct from canonical_event_payload/i);
  assert.match(source, /correction event_key replay payload mismatch/i);
  assert.match(source, /return correction_row/i);
  assert.ok(
    source.indexOf("select * into correction_row") < source.indexOf("set is_valid = false"),
    "exact event replay must be resolved before any score mutation",
  );
  assert.match(source, /replacement_scores must match invalidated scores one-for-one/i);
  assert.match(source, /scores\.source_revision = p_correction->>'previous_revision'/i);
  assert.match(source, /rows\.score->>'source_revision' is distinct from p_correction->>'corrected_revision'/i);
  assert.match(source, /insert into public\.lai_evidence_corrections[\s\S]*event_key[\s\S]*event_payload/i);
  assert.match(sql, /grant execute on function public\.record_lai_v3_correction\(jsonb\) to service_role/i);
  assert.doesNotMatch(sql, /grant execute[\s\S]*record_lai_v3_correction[\s\S]*to (anon|authenticated)/i);
});
