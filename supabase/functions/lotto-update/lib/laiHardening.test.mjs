import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migrationUrl = new URL(
  "../../../migrations/20260715000000_harden_lai_draw_checkpoints.sql",
  import.meta.url,
);

test("follow-up migration safely deduplicates and protects non-null draw checkpoints", async () => {
  const source = await readFile(migrationUrl, "utf8");

  assert.match(source, /row_number\(\)\s+over\s*\(\s*partition by game_name,\s*last_learned_draw_id/is);
  assert.match(source, /set\s+last_learned_draw_id\s*=\s*null/is);
  assert.match(
    source,
    /create unique index[^;]+\(game_name,\s*last_learned_draw_id\)[^;]+where last_learned_draw_id is not null/is,
  );
});

test("activation RPC checks every historical checkpoint under the game advisory lock", async () => {
  const source = await readFile(migrationUrl, "utf8");
  const lockAt = source.indexOf("pg_advisory_xact_lock");
  const checkpointAt = source.indexOf("last_learned_draw_id = incoming_draw_id");
  const deactivateAt = source.indexOf("set is_active = false");

  assert.ok(lockAt >= 0, "migration must take the game advisory lock");
  assert.ok(checkpointAt > lockAt, "historical checkpoint lookup must happen under the lock");
  assert.ok(deactivateAt > checkpointAt, "historical checkpoint lookup must precede active-state mutation");
  assert.match(source, /incoming_draw_date\s*<\s*activated\.last_learned_draw_date/is);
  assert.match(source, /incoming_state_version\s*<=\s*activated\.state_version/is);
  assert.doesNotMatch(source, /return\s+coalesce\s*\(\s*activated/is);
});
