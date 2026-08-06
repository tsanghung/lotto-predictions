import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = new URL(
  "../../../migrations/20260806000000_create_lai_v3_evidence_agent.sql",
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
  assert.match(sql, /algorithm_version <> 'lai-v2'/i);
  assert.doesNotMatch(sql, /grant execute[\s\S]*to (anon|authenticated)/i);
});
