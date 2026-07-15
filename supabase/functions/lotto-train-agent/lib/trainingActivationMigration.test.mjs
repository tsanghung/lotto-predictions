import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../../../migrations/20260715170000_activate_lai_training_candidate.sql",
  import.meta.url,
);

test("training candidate activation is guarded, auditable, and service-role only", async () => {
  const sql = await readFile(migrationUrl, "utf8");

  assert.match(sql, /create or replace function public\.activate_lotto_training_candidate\(p_run_id uuid\)/i);
  assert.match(sql, /from public\.lotto_training_runs[\s\S]*for update/i);
  assert.match(sql, /status <> 'completed'/i);
  assert.match(sql, /checkpoint_cursor <> training_run\.range_end/i);
  assert.match(sql, /summary #>> '\{snapshot,frozen\}'/i);
  assert.match(sql, /snapshot_count <> training_run\.range_end/i);
  assert.match(sql, /count\(\*\) filter \(where game_name is distinct from training_run\.game_name\)/i);
  assert.match(sql, /mismatched_snapshot_count <> 0/i);
  assert.match(sql, /candidate_state->>'status' is null/i);
  assert.match(sql, /candidate_state->>'last_learned_draw_id'.*final_snapshot\.draw_id/is);
  assert.match(sql, /pg_advisory_xact_lock/i);
  assert.match(sql, /exists \([\s\S]*from public\.lotto_agent_states/i);
  assert.match(sql, /exists \([\s\S]*from public\.lotto_learning_claims/i);
  assert.match(sql, /'training_seed_run_id'/i);
  assert.match(sql, /is_active, activated_at[\s\S]*true, now\(\)/i);
  assert.match(sql, /grant execute on function public\.activate_lotto_training_candidate\(uuid\) to service_role/i);
  assert.doesNotMatch(sql, /grant execute[\s\S]*to (anon|authenticated)/i);
});
