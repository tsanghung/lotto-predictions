import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import * as lottoCore from "./lottoCore.js";

test("lotto-update runs v3 only after v2 and isolates v3 failures", async () => {
  const source = await readFile(new URL("../index.ts", import.meta.url), "utf8");
  const evaluationSource = source.slice(source.indexOf("async function evaluateReadyPredictions"));

  assert.match(source, /import \{[\s\S]*?runEvidenceLearning[\s\S]*?\} from "\.\/lib\/evidenceLearning\.js"/);
  assert.match(evaluationSource, /await runPostDrawLearning\([\s\S]+?await runEvidenceLearningIsolated\(/);
  assert.match(source, /async function runEvidenceLearningIsolated[\s\S]+?await runEvidenceLearningForDraw\(/);
  assert.match(source, /v3Result = \{ status: "failed_isolated", root_cause: errorMessage\(error\) \}/);
});

test("lotto-update reads the full valid v3 score history before evaluating gates", async () => {
  const source = await readFile(new URL("../index.ts", import.meta.url), "utf8");
  const v3History = source.slice(
    source.indexOf("async function fetchV3ValidScoreHistory"),
    source.indexOf("async function insertV3ScoresIdempotently"),
  );

  assert.match(source, /readStablePaginatedRows/);
  assert.match(v3History, /fetchStableV3RestRows/);
  assert.match(v3History, /order: "draw_date\.asc,draw_id\.asc,id\.asc"/);
  assert.match(v3History, /snapshotColumn: "evaluated_at"/);
});

test("every invocation merges bounded durable v3 pending work after v2", async () => {
  const source = await readFile(new URL("../index.ts", import.meta.url), "utf8");
  const handler = source.slice(source.indexOf("async function handleRequest"));
  const v2Offset = handler.indexOf("await evaluateReadyPredictions");
  const durableOffset = handler.indexOf("await fetchDurableV3PendingDraws");

  assert.match(source, /async function fetchDurableV3PendingDraws/);
  assert.match(source, /buildV3PendingWorklist/);
  assert.ok(v2Offset >= 0 && durableOffset > v2Offset, "durable v3 work must run after v2");
  assert.match(handler, /confirmedDrawRows[\s\S]+?durablePendingDraws[\s\S]+?buildV3PendingWorklist/);
  assert.match(handler, /for \(const pendingDraw of v3Worklist\)/);
});

test("confirmed draws have a v3 entry point independent of ready predictions and activation is disabled", async () => {
  const source = await readFile(new URL("../index.ts", import.meta.url), "utf8");
  const evidenceSource = await readFile(new URL("./evidenceLearning.js", import.meta.url), "utf8");
  const handler = source.slice(source.indexOf("async function handleRequest"));

  assert.match(handler, /for \(const pendingDraw of v3Worklist\)/);
  assert.match(source, /activationAuthorized: false/);
  assert.doesNotMatch(source, /candidateEvidence\.sampleCount,\s*canaryDraws/);
  assert.match(evidenceSource, /persisted\?\.authorized === true/);
  assert.match(evidenceSource, /LAI v3 activation requires a complete active-state claim contract/);
  assert.match(evidenceSource, /liveShadowDraws: Number\.isInteger\(lifecycle\.liveShadowDraws\)/);
});

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
  recoveryHandler = null,
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
    claimAgentLearning: async (request) => ({ status: "claimed", claim_token: `claim-${request.draw_id}` }),
    recoverAgentLearningOrder: async (request) => {
      if (!recoveryHandler) return { status: "not_needed" };
      return recoveryHandler({ request, db, calls });
    },
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

test("stale legacy gap is rewound once and learned instead of retrying forever", async () => {
  const laterState = baselineState({
    state_version: 9,
    last_learned_draw_id: "115000161",
    last_learned_draw_date: "2026-07-11",
  });
  const predecessorState = baselineState();
  const harness = createHarness({
    activeState: laterState,
    recoveryHandler: ({ db }) => {
      db.activeState = clone(predecessorState);
      return { status: "rewound", replay_from_draw_id: DRAW.draw_id };
    },
  });

  const result = await run(harness);

  assert.equal(result.learning_status, "learned");
  assert.equal(harness.calls.scorePayloads.length, 1);
  assert.equal(harness.calls.statePayloads.length, 1);
  assert.equal(harness.db.activeState.last_learned_draw_id, DRAW.draw_id);
  assert.equal(harness.calls.markCount, 1);
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
      claimAgentLearning: async (request) => ({ status: "claimed", claim_token: `claim-${request.draw_id}` }),
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

function createOrderedLearningHarness() {
  const earlierDraw = clone(DRAW);
  const laterDraw = {
    ...clone(DRAW),
    draw_id: "115000161",
    draw_date: "2026-07-11",
  };
  const predictions = new Map([
    [earlierDraw.draw_id, clone(PREDICTION)],
    [laterDraw.draw_id, {
      ...clone(PREDICTION),
      source_key: "prediction-539-2026-07-11",
      target_draw_date: laterDraw.draw_date,
    }],
  ]);
  const db = {
    activeState: baselineState(),
    checkpoints: new Map(),
    claims: new Map(),
    scores: new Map(),
    evaluated: new Set(),
  };
  const calls = {
    claimDrawIds: [],
    activationDrawIds: [],
    scoreKeys: [],
  };
  let claimSequence = 0;
  let claimLock = Promise.resolve();

  async function orderedClaim(request) {
    const previous = claimLock;
    let release;
    claimLock = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      calls.claimDrawIds.push(String(request.draw_id));
      if (db.checkpoints.has(String(request.draw_id))) {
        return { status: "already_learned", claim_token: null };
      }
      const earliest = [earlierDraw, laterDraw]
        .filter((candidate) => !db.checkpoints.has(String(candidate.draw_id)))
        .sort((left, right) => left.draw_date.localeCompare(right.draw_date))[0];
      if (String(earliest.draw_id) !== String(request.draw_id)) {
        return {
          status: "deferred_earlier_draw",
          blocking_draw_id: String(earliest.draw_id),
          claim_token: null,
        };
      }
      claimSequence += 1;
      const claimToken = `claim-${claimSequence}-${request.draw_id}`;
      db.claims.set(String(request.draw_id), claimToken);
      return { status: "claimed", claim_token: claimToken };
    } finally {
      release();
    }
  }

  function depsFor(draw) {
    return {
      fetchForecasts: async () => clone(FORECASTS).map((forecast) => ({
        ...forecast,
        id: `${forecast.id}-${draw.draw_id}`,
      })),
      fetchActiveState: async () => clone(db.activeState),
      fetchAgentStateCheckpoint: async (_gameName, drawId) => clone(
        db.checkpoints.get(String(drawId)) ?? null,
      ),
      claimAgentLearning: orderedClaim,
      fetchScoreHistory: async () => [...db.scores.values()].map(clone),
      upsertModelScores: async (rows) => {
        for (const row of rows) {
          const key = `${row.forecast_id}|${row.draw_id}`;
          db.scores.set(key, clone(row));
          calls.scoreKeys.push(key);
        }
      },
      activateAgentState: async (state) => {
        const drawId = String(state.last_learned_draw_id);
        assert.equal(state.learning_claim_token, db.claims.get(drawId));
        calls.activationDrawIds.push(drawId);
        db.activeState = clone(state);
        db.checkpoints.set(drawId, clone(state));
        return clone(state);
      },
      markPredictionEvaluated: async (sourceKey) => db.evaluated.add(sourceKey),
    };
  }

  async function runDraw(draw) {
    const prediction = predictions.get(String(draw.draw_id));
    return lottoCore.runPostDrawLearning({
      prediction,
      draw,
      evaluation: { draw_id: draw.draw_id },
      config: { maxNumber: 39, picks: 5 },
      forecastsFallbackExpertNames: ["uniform", "markov"],
      deps: depsFor(draw),
    });
  }

  return { earlierDraw, laterDraw, predictions, db, calls, runDraw };
}

test("later draw defers, then learns after the earlier draw without duplicate durable work", async () => {
  const harness = createOrderedLearningHarness();

  const deferred = await harness.runDraw(harness.laterDraw);
  assert.equal(deferred.learning_status, "deferred_earlier_draw");
  assert.equal(harness.db.evaluated.size, 0);

  const earlier = await harness.runDraw(harness.earlierDraw);
  const later = await harness.runDraw(harness.laterDraw);

  assert.equal(earlier.learning_status, "learned");
  assert.equal(later.learning_status, "learned");
  assert.deepEqual(harness.calls.activationDrawIds, [
    harness.earlierDraw.draw_id,
    harness.laterDraw.draw_id,
  ]);
  assert.equal(new Set(harness.calls.scoreKeys).size, 4);
  assert.equal(harness.calls.scoreKeys.length, 4);
  assert.equal(harness.db.checkpoints.size, 2);
  assert.deepEqual(
    [...harness.db.evaluated].sort(),
    [...harness.predictions.values()].map((prediction) => prediction.source_key).sort(),
  );
});

test("concurrent claims for different draws cannot leapfrog the earlier pending draw", async () => {
  const harness = createOrderedLearningHarness();

  const [laterResult, earlierResult] = await Promise.all([
    harness.runDraw(harness.laterDraw),
    harness.runDraw(harness.earlierDraw),
  ]);

  assert.equal(laterResult.learning_status, "deferred_earlier_draw");
  assert.equal(earlierResult.learning_status, "learned");
  assert.deepEqual(harness.calls.activationDrawIds, [harness.earlierDraw.draw_id]);
  assert.equal(harness.db.evaluated.has(harness.predictions.get(harness.laterDraw.draw_id).source_key), false);

  const retry = await harness.runDraw(harness.laterDraw);
  assert.equal(retry.learning_status, "learned");
  assert.deepEqual(harness.calls.activationDrawIds, [
    harness.earlierDraw.draw_id,
    harness.laterDraw.draw_id,
  ]);
});
