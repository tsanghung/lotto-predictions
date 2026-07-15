import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migrationUrl = new URL(
  "../../../migrations/20260715160000_snapshot_lai_training_draws.sql",
  import.meta.url,
);

test("training snapshot migration freezes ordered draw payloads per run", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /create table if not exists public\.lotto_training_draw_snapshots/i);
  assert.match(sql, /primary key \(run_id, sequence_no\)/i);
  assert.match(sql, /unique \(run_id, draw_id\)/i);
  assert.match(sql, /for update/i);
  assert.match(sql, /order by draw_date, draw_id/i);
  assert.match(sql, /limit training_run\.range_end/i);
  assert.match(sql, /snapshot_count <> training_run\.range_end/i);
  assert.match(sql, /grant execute .* to service_role/i);
  assert.match(sql, /revoke all .* from authenticated/i);
});
