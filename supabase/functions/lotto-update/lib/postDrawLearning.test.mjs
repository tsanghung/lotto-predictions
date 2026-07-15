import test from "node:test";
import assert from "node:assert/strict";

import * as lottoCore from "./lottoCore.js";

const DRAW = {
  draw_id: "115000160",
  draw_date: "2026-07-10",
  numbers: [1, 2, 3, 4, 5],
  special_number: null,
};

const PREDICTION = {
  source_key: "prediction-539-2026-07-10",
  game_name: "今彩539",
  target_draw_date: "2026-07-10",
};

const FORECASTS = [
  {
    id: "forecast-uniform",
    game_name: "今彩539",
    model_name: "uniform",
    probabilities: Array(39).fill(5 / 39),
    final_groups: {
      combinations: {
        "機率主攻": [1, 2, 3, 4, 5],
        "覆蓋探索": [6, 7, 8, 9, 10],
      },
    },
  },
  {
    id: "forecast-markov",
    game_name: "今彩539",
    model_name: "markov",
    probabilities: Array(39).fill(5 / 39),
    final_groups: {
      combinations: {
        "機率主攻": [1, 2, 3, 4, 5],
        "覆蓋探索": [5, 6, 7, 8, 9],
      },
    },
  },
];

function baselineState(overrides = {}) {
  return {
    game_name: "今彩539",
    state_version: 7,
    status: "baseline",
    champion_model: "uniform",
    expert_weights: { uniform: 0.5, markov: 0.5 },
    learning_config: { gamma: 0.1 },
    metrics: { evaluated_draws: 29 },
    last_learned_draw_id: "115000159",
    last_learned_draw_date: "2026-07-09",
    ...overrides,
  };
}

function clone(value) {
  return structuredClone(value);
}

function createHarness({
  activeState = baselineState(),
  crashAfterScoreOnce = false,
  crashAfterRpcOnce = false,
  loseRpcResponseOnce = false,
} = {}) {
  const db = {
    activeState: clone(activeState),
    scores: new Map(),
    predictionEvaluated: false,
  };
  const calls = {
    scorePayloads: [],
    statePayloads: [],
    markCount: 0,
  };
  let scoreCrashPending = crashAfterScoreOnce;
  let postRpcCrashPending = crashAfterRpcOnce;
  let responseLossPending = loseRpcResponseOnce;

  const deps = {
    fetchForecasts: async () => clone(FORECASTS),
    fetchActiveState: async () => clone(db.activeState),
    fetchScoreHistory: async () => [...db.scores.values()].map(clone),
    upsertModelScores: async (rows) => {
      calls.scorePayloads.push(clone(rows));
      for (const row of rows) {
        db.scores.set(`${row.forecast_id}|${row.draw_id}`, clone(row));
      }
      if (scoreCrashPending) {
        scoreCrashPending = false;
        throw new Error("crash after score commit");
      }
    },
    activateAgentState: async (state) => {
      calls.statePayloads.push(clone(state));
      db.activeState = clone(state);
      if (responseLossPending) {
        responseLossPending = false;
        throw new Error("RPC response lost after commit");
      }
    },
    markPredictionEvaluated: async () => {
      if (postRpcCrashPending) {
        postRpcCrashPending = false;
        throw new Error("crash after RPC success");
      }
      calls.markCount += 1;
      db.predictionEvaluated = true;
    },
  };

  return { db, calls, deps };
}

function run(harness, overrides = {}) {
  return lottoCore.runPostDrawLearning({
    prediction: PREDICTION,
    draw: DRAW,
    evaluation: { draw_id: DRAW.draw_id },
    config: { maxNumber: 39, picks: 5 },
    forecastsFallbackExpertNames: ["uniform", "markov"],
    deps: harness.deps,
    ...overrides,
  });
}

test("score commit followed by crash retries the identical score and state payloads", async () => {
  assert.equal(typeof lottoCore.runPostDrawLearning, "function");
  const harness = createHarness({ crashAfterScoreOnce: true });

  await assert.rejects(run(harness), /crash after score commit/);
  await run(harness);

  assert.equal(harness.calls.scorePayloads.length, 2);
  assert.deepEqual(harness.calls.scorePayloads[1], harness.calls.scorePayloads[0]);
  assert.equal(harness.calls.statePayloads.length, 1);
  assert.equal(harness.calls.statePayloads[0].state_version, 8);
  assert.equal(harness.db.activeState.state_version, 8);
});

test("crash after RPC success retries without another score upsert or state version", async () => {
  const harness = createHarness({ crashAfterRpcOnce: true });

  await assert.rejects(run(harness), /crash after RPC success/);
  const committedScores = clone(harness.calls.scorePayloads[0]);
  const committedState = clone(harness.db.activeState);
  await run(harness);

  assert.equal(harness.calls.scorePayloads.length, 1);
  assert.deepEqual(harness.calls.scorePayloads[0], committedScores);
  assert.equal(harness.calls.statePayloads.length, 1);
  assert.deepEqual(harness.db.activeState, committedState);
  assert.equal(harness.db.activeState.state_version, 8);
  assert.equal(harness.calls.markCount, 1);
});

test("lost RPC response retries from the committed checkpoint without rewriting scores", async () => {
  const harness = createHarness({ loseRpcResponseOnce: true });

  await assert.rejects(run(harness), /RPC response lost after commit/);
  const committedScores = clone(harness.calls.scorePayloads[0]);
  const committedState = clone(harness.db.activeState);
  await run(harness);

  assert.equal(harness.calls.scorePayloads.length, 1);
  assert.deepEqual(harness.calls.scorePayloads[0], committedScores);
  assert.equal(harness.calls.statePayloads.length, 1);
  assert.deepEqual(harness.db.activeState, committedState);
  assert.equal(harness.calls.markCount, 1);
});

test("stale draw retry leaves the later active state unchanged", async () => {
  const laterState = baselineState({
    state_version: 9,
    last_learned_draw_id: "115000161",
    last_learned_draw_date: "2026-07-11",
  });
  const harness = createHarness({ activeState: laterState });

  const result = await run(harness);

  assert.equal(result.learning_status, "stale_draw");
  assert.equal(harness.calls.scorePayloads.length, 0);
  assert.equal(harness.calls.statePayloads.length, 0);
  assert.deepEqual(harness.db.activeState, laterState);
  assert.equal(harness.calls.markCount, 1);
});
