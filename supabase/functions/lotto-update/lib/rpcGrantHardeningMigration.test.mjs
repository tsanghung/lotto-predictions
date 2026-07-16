import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../../../migrations/20260716010000_harden_server_rpc_grants.sql",
  import.meta.url,
);

test("server-side scheduler and LAI RPCs are not executable by client roles", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  const signatures = [
    "invoke_lotto_update\\(\\)",
    "invoke_lotto_predict_notify\\(\\)",
    "activate_lotto_agent_state\\(jsonb\\)",
    "claim_next_lai_learning\\(text, text, date, text, integer\\)",
    "recover_lai_learning_order\\(text, text, date\\)",
  ];

  for (const signature of signatures) {
    assert.match(
      sql,
      new RegExp(`revoke all on function public\\.${signature}[\\s\\S]*?from public, anon, authenticated`, "i"),
    );
    assert.match(
      sql,
      new RegExp(`grant execute on function public\\.${signature}[\\s\\S]*?to service_role`, "i"),
    );
  }
});
