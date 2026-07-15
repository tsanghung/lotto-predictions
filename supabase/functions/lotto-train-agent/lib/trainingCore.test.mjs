import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  createInitialTrainingState,
  executeTrainingRun,
  isServiceRoleRequest,
  validateTrainingRequest,
  walkForwardChunk,
} from "./trainingCore.js";

function dailyDraws(count = 10) {
  return Array.from({ length: count }, (_, index) => ({
    draw_id: `539-${String(index + 1).padStart(3, "0")}`,
    draw_date: `2026-01-${String(index + 1).padStart(2, "0")}`,
    numbers: Array.from({ length: 5 }, (__, offset) => ((index * 5 + offset) % 39) + 1)
      .sort((left, right) => left - right),
    special_number: null,
  }));
}

function powerDraws(count = 6) {
  return Array.from({ length: count }, (_, index) => ({
    draw_id: `power-${String(index + 1).padStart(3, "0")}`,
    draw_date: `2026-02-${String(index + 1).padStart(2, "0")}`,
    numbers: Array.from({ length: 6 }, (__, offset) => ((index * 6 + offset) % 38) + 1)
      .sort((left, right) => left - right),
    special_number: (index % 8) + 1,
  }));
}

test("walk-forward uses only the prefix before each target draw", () => {
  const draws = dailyDraws();
  const state = createInitialTrainingState("539");
  const changedTarget = structuredClone(draws);
  changedTarget[3].numbers = [30, 31, 32, 33, 34];
  const result = walkForwardChunk({ gameType: "539", draws, cursor: 3, chunkSize: 1, state });
  const replay = walkForwardChunk({ gameType: "539", draws: changedTarget, cursor: 3, chunkSize: 1, state });
  assert.equal(result.steps[0].history_size, 3);
  assert.equal(result.steps[0].target_draw_id, draws[3].draw_id);
  assert.equal(result.steps[0].forecast_signature, replay.steps[0].forecast_signature);
  assert.notDeepEqual(result.steps[0].metrics, replay.steps[0].metrics);
});

test("checkpoint continuation is bit-for-bit equal to one larger chunk", () => {
  const draws = dailyDraws();
  const state = createInitialTrainingState("539");
  const first = walkForwardChunk({ gameType: "539", draws, cursor: 2, chunkSize: 3, state });
  const second = walkForwardChunk({ gameType: "539", draws, cursor: first.nextCursor, chunkSize: 3, state: first.state });
  const combined = walkForwardChunk({ gameType: "539", draws, cursor: 2, chunkSize: 6, state });
  assert.deepEqual(second.state, combined.state);
  assert.equal(second.nextCursor, combined.nextCursor);
  assert.deepEqual([...first.steps, ...second.steps], combined.steps);
});

test("walk-forward processes no more than chunkSize targets", () => {
  const result = walkForwardChunk({
    gameType: "539", draws: dailyDraws(), cursor: 1, chunkSize: 2,
    state: createInitialTrainingState("539"),
  });
  assert.equal(result.steps.length, 2);
  assert.equal(result.nextCursor, 3);
  assert.equal(result.done, false);
});

test("invalid inputs fail fast", () => {
  const draws = dailyDraws();
  const state = createInitialTrainingState("539");
  assert.throws(() => walkForwardChunk({ gameType: "bad", draws, cursor: 0, chunkSize: 1, state }), /gameType/);
  assert.throws(() => walkForwardChunk({ gameType: "539", draws, cursor: -1, chunkSize: 1, state }), /cursor/);
  assert.throws(() => walkForwardChunk({ gameType: "539", draws, cursor: 0, chunkSize: 0, state }), /chunkSize/);
  assert.throws(() => walkForwardChunk({ gameType: "539", draws, cursor: 0, chunkSize: 101, state }), /chunkSize/);
  assert.throws(() => walkForwardChunk({ gameType: "539", draws: [...draws].reverse(), cursor: 0, chunkSize: 1, state }), /chronological/);
  assert.throws(() => walkForwardChunk({ gameType: "539", draws, cursor: 0, chunkSize: 1, state: {} }), /state/);
});

test("walk-forward does not mutate caller data", () => {
  const draws = dailyDraws();
  const state = createInitialTrainingState("539");
  const before = [structuredClone(draws), structuredClone(state)];
  walkForwardChunk({ gameType: "539", draws, cursor: 2, chunkSize: 2, state });
  assert.deepEqual(draws, before[0]);
  assert.deepEqual(state, before[1]);
});

test("a completed cursor returns a stable completed state", () => {
  const draws = dailyDraws(4);
  const state = createInitialTrainingState("539");
  const result = walkForwardChunk({ gameType: "539", draws, cursor: draws.length, chunkSize: 4, state });
  assert.deepEqual(result, { nextCursor: draws.length, done: true, state, steps: [] });
  assert.notEqual(result.state, state);
});

test("Power Lottery scores main and second areas", () => {
  const result = walkForwardChunk({
    gameType: "power", draws: powerDraws(), cursor: 3, chunkSize: 1,
    state: createInitialTrainingState("power"),
  });
  const metrics = result.steps[0].metrics.uniform;
  for (const key of ["main_brier", "special_brier", "combined_brier", "main_log_loss", "special_log_loss"]) {
    assert.ok(Number.isFinite(metrics[key]), key);
  }
});

test("training request validation requires run_id and integer chunk_size from 1 to 100", () => {
  assert.deepEqual(validateTrainingRequest({ run_id: "run-1", chunk_size: 25 }), {
    runId: "run-1", chunkSize: 25,
  });
  for (const input of [null, {}, { run_id: "", chunk_size: 1 }, { run_id: "x", chunk_size: 0 },
    { run_id: "x", chunk_size: 101 }, { run_id: "x", chunk_size: 1.5 }]) {
    assert.throws(() => validateTrainingRequest(input), /run_id|chunk_size/);
  }
});

test("service-role auth requires an exact configured secret and rejects unsigned role claims", () => {
  const secret = "server-side-service-secret";
  assert.equal(isServiceRoleRequest({ apikey: secret, authorization: "" }, [secret]), true);
  assert.equal(isServiceRoleRequest({ apikey: "", authorization: `Bearer ${secret}` }, [secret]), true);
  const payload = Buffer.from(JSON.stringify({ role: "service_role" })).toString("base64url");
  const forgedJwt = `x.${payload}.x`;
  assert.equal(isServiceRoleRequest({ apikey: forgedJwt, authorization: `Bearer ${forgedJwt}` }, [secret]), false);
  assert.equal(isServiceRoleRequest({ apikey: "anon", authorization: "Bearer anon" }, [secret]), false);
});

test("executeTrainingRun claims, loads, advances, and saves one checkpoint", async () => {
  const calls = [];
  const run = {
    id: "run-1", game_name: "\u4eca\u5f69539", status: "queued", range_start: 0, range_end: 6,
    checkpoint_cursor: 2, summary: { state: createInitialTrainingState("539") },
    started_at: null, updated_at: "2026-07-15T00:00:00Z",
  };
  const repository = {
    async fetchRun(runId) { calls.push(["fetchRun", runId]); return structuredClone(run); },
    async claimRun(value, lease) {
      calls.push(["claimRun", value.id, lease.token]);
      return { ...structuredClone(value), status: "running", summary: { ...value.summary, lease }, updated_at: "claimed" };
    },
    async fetchDraws(gameName, rangeEnd) {
      calls.push(["fetchDraws", gameName, rangeEnd]);
      return dailyDraws(rangeEnd);
    },
    async saveCheckpoint(value, checkpoint) {
      calls.push(["saveCheckpoint", value.id, checkpoint.checkpoint_cursor, checkpoint.status]);
      return { ...value, ...checkpoint };
    },
    async markFailed() { assert.fail("markFailed must not run"); },
  };
  const result = await executeTrainingRun({
    input: { run_id: "run-1", chunk_size: 2 }, repository,
    now: () => "2026-07-15T01:00:00.000Z", token: () => "lease-1",
  });
  assert.deepEqual(calls, [
    ["fetchRun", "run-1"], ["claimRun", "run-1", "lease-1"],
    ["fetchDraws", "\u4eca\u5f69539", 6], ["saveCheckpoint", "run-1", 4, "running"],
  ]);
  assert.equal(result.checkpoint_cursor, 4);
  assert.equal(result.summary.state.metrics.sample_count, 2);
  assert.equal("lease" in result.summary, false);
});

test("executeTrainingRun leaves completed runs unchanged", async () => {
  const run = { id: "done", status: "completed", checkpoint_cursor: 8, range_end: 8, summary: {} };
  const repository = {
    async fetchRun() { return run; },
    async claimRun() { assert.fail("completed run must not be claimed"); },
  };
  assert.deepEqual(await executeTrainingRun({
    input: { run_id: "done", chunk_size: 10 }, repository,
  }), run);
});

test("executeTrainingRun rejects a lost claim before reading draws", async () => {
  const run = {
    id: "busy", game_name: "\u4eca\u5f69539", status: "running", range_start: 0, range_end: 3,
    checkpoint_cursor: 1, summary: { state: createInitialTrainingState("539") }, updated_at: "old",
  };
  const repository = {
    async fetchRun() { return run; },
    async claimRun() { return null; },
    async fetchDraws() { assert.fail("draws must not load after a lost claim"); },
  };
  await assert.rejects(
    executeTrainingRun({ input: { run_id: "busy", chunk_size: 1 }, repository }),
    /already claimed/,
  );
});

test("executeTrainingRun marks incomplete draw ranges failed", async () => {
  let failure = null;
  const run = {
    id: "short", game_name: "\u4eca\u5f69539", status: "queued", range_start: 0, range_end: 4,
    checkpoint_cursor: 1, summary: { state: createInitialTrainingState("539") }, updated_at: "old",
  };
  const repository = {
    async fetchRun() { return run; },
    async claimRun(value, lease) { return { ...value, summary: { ...value.summary, lease } }; },
    async fetchDraws() { return dailyDraws(2); },
    async markFailed(value, update) { failure = [value.id, update]; },
  };
  await assert.rejects(
    executeTrainingRun({ input: { run_id: "short", chunk_size: 1 }, repository }),
    /incomplete/,
  );
  assert.equal(failure[0], "short");
  assert.equal(failure[1].status, "failed");
  assert.match(failure[1].error_text, /incomplete/);
});

test("the final chunk persists completed status at range_end", async () => {
  const run = {
    id: "final", game_name: "\u4eca\u5f69539", status: "running", range_start: 0, range_end: 4,
    checkpoint_cursor: 3, summary: { state: createInitialTrainingState("539") }, updated_at: "old",
  };
  const repository = {
    async fetchRun() { return run; },
    async claimRun(value, lease) { return { ...value, summary: { ...value.summary, lease } }; },
    async fetchDraws() { return dailyDraws(4); },
    async saveCheckpoint(value, checkpoint) { return { ...value, ...checkpoint }; },
    async markFailed() { assert.fail("completed chunk must not fail"); },
  };
  const result = await executeTrainingRun({
    input: { run_id: "final", chunk_size: 10 }, repository,
    now: () => "2026-07-15T02:00:00.000Z", token: () => "final-lease",
  });
  assert.equal(result.status, "completed");
  assert.equal(result.checkpoint_cursor, result.range_end);
  assert.equal(result.completed_at, "2026-07-15T02:00:00.000Z");
});


test("Edge Function source wires POST auth, persistence, and no scheduler", async () => {
  const source = await readFile(new URL("../index.ts", import.meta.url), "utf8");
  assert.match(source, /request\.method !== "POST"/);
  assert.match(source, /isServiceRoleRequest/);
  assert.match(source, /executeTrainingRun/);
  assert.match(source, /lotto_training_runs/);
  assert.match(source, /order=draw_date\.asc%2Cdraw_id\.asc/);
  assert.match(source, /updated_at=eq/);
  assert.doesNotMatch(source, /lotto_agent_states/);
  assert.doesNotMatch(source, /cron|schedule/i);
});
