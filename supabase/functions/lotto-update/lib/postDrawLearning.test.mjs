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
  activationHandler = null,
  historicalStates = [],
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
    fetchAgentStateCheckpoint: async (_gameName, drawId) => clone(
      historicalStates.find((state) => String(state.last_learned_draw_id) === String(drawId)) ?? null,
    ),
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
      if (activationHandler) {
        return activationHandler({ state: clone(state), db, calls });
      }
      db.activeState = clone(state);
      if (responseLossPending) {
        responseLossPending = false;
        throw new Error("RPC response lost after commit");
      }
      return clone(db.activeState);
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
  assert.equal(harness.calls.markCount, 0);
});

test("two different draws racing from one state version both activate in draw order", async () => {
  const shared = {
    activeState: baselineState(),
    checkpoints: new Map(),
    activationCalls: [],
    markKeys: [],
  };
  let initialFetches = 0;
  let releaseInitialFetches;
  const initialFetchBarrier = new Promise((resolve) => {
    releaseInitialFetches = resolve;
  });

  function depsFor(targetDraw) {
    return {
      fetchForecasts: async () => clone(FORECASTS).map((forecast) => ({
        ...forecast,
        id: `${forecast.id}-${targetDraw.draw_id}`,
      })),
      fetchActiveState: async () => {
        initialFetches += 1;
        if (initialFetches === 2) releaseInitialFetches();
        if (initialFetches <= 2) await initialFetchBarrier;
        return clone(shared.activeState);
      },
      fetchAgentStateCheckpoint: async (_gameName, drawId) => clone(
        shared.checkpoints.get(String(drawId)) ?? null,
      ),
      fetchScoreHistory: async () => [],
      upsertModelScores: async () => {},
      activateAgentState: async (state) => {
        shared.activationCalls.push(clone(state));
        if (state.state_version <= shared.activeState.state_version) {
          return clone(shared.activeState);
        }
        shared.activeState = clone(state);
        shared.checkpoints.set(String(state.last_learned_draw_id), clone(state));
        return clone(state);
      },
      markPredictionEvaluated: async (sourceKey) => shared.markKeys.push(sourceKey),
    };
  }

  const earlierDraw = clone(DRAW);
  const laterDraw = {
    ...clone(DRAW),
    draw_id: "115000161",
    draw_date: "2026-07-11",
  };
  await Promise.all([
    lottoCore.runPostDrawLearning({
      prediction: PREDICTION,
      draw: earlierDraw,
      evaluation: { draw_id: earlierDraw.draw_id },
      config: { maxNumber: 39, picks: 5 },
      deps: depsFor(earlierDraw),
    }),
    lottoCore.runPostDrawLearning({
      prediction: { ...PREDICTION, source_key: "prediction-539-2026-07-11", target_draw_date: "2026-07-11" },
      draw: laterDraw,
      evaluation: { draw_id: laterDraw.draw_id },
      config: { maxNumber: 39, picks: 5 },
      deps: depsFor(laterDraw),
    }),
  ]);

  assert.equal(shared.activeState.last_learned_draw_id, laterDraw.draw_id);
  assert.equal(shared.activeState.state_version, 9);
  assert.equal(shared.checkpoints.size, 2);
  assert.equal(shared.markKeys.length, 2);
  assert.deepEqual(shared.activationCalls.map((state) => state.state_version), [8, 8, 9]);
});

test("unrelated activation checkpoint reloads state and succeeds after recompute", async () => {
  const unrelatedState = baselineState({
    state_version: 8,
    expert_weights: { uniform: 0.8, markov: 0.2 },
  });
  let activationCount = 0;
  const harness = createHarness({
    activationHandler: ({ state, db }) => {
      activationCount += 1;
      if (activationCount === 1) {
        db.activeState = clone(unrelatedState);
        return clone(unrelatedState);
      }
      db.activeState = clone(state);
      return clone(state);
    },
  });

  const result = await run(harness);

  assert.equal(result.learning_status, "learned");
  assert.deepEqual(harness.calls.statePayloads.map((state) => state.state_version), [8, 9]);
  assert.equal(harness.calls.scorePayloads[1][0].weight_before, 0.8);
  assert.equal(harness.db.activeState.last_learned_draw_id, DRAW.draw_id);
  assert.equal(harness.calls.markCount, 1);
});

test("repeated activation conflicts exhaust bounded retries without marking evaluated", async () => {
  let conflictVersion = 7;
  const harness = createHarness({
    activationHandler: ({ db }) => {
      conflictVersion += 1;
      db.activeState = baselineState({ state_version: conflictVersion });
      return clone(db.activeState);
    },
  });

  await assert.rejects(run(harness), /activation checkpoint conflict.*3 attempts/i);

  assert.equal(harness.calls.statePayloads.length, 3);
  assert.equal(harness.calls.markCount, 0);
  assert.equal(harness.db.predictionEvaluated, false);
});

test("exact historical draw checkpoint remains idempotent and may be marked evaluated", async () => {
  const historicalState = baselineState({
    state_version: 8,
    last_learned_draw_id: DRAW.draw_id,
    last_learned_draw_date: DRAW.draw_date,
  });
  const harness = createHarness({
    activeState: baselineState({
      state_version: 9,
      last_learned_draw_id: "115000161",
      last_learned_draw_date: "2026-07-11",
    }),
    historicalStates: [historicalState],
  });

  const result = await run(harness);

  assert.equal(result.learning_status, "already_learned");
  assert.equal(harness.calls.scorePayloads.length, 0);
  assert.equal(harness.calls.statePayloads.length, 0);
  assert.equal(harness.calls.markCount, 1);
});
