import test from "node:test";
import assert from "node:assert/strict";

import {
  buildLineMessage,
  GAME_CONFIG,
  generateAdaptivePrediction,
  generateHonestPrediction,
  notificationKey,
  sourceKey,
} from "./predictCore.js";
import {
  buildForecastRows,
  executePredictionFlow,
  parseBooleanEnvFlag,
  resolveAgentExecution,
  resolveLaiExecution,
} from "./notifyRuntime.js";

const dailyDraws = [
  { draw_id: "115000138", draw_date: "2026-06-06", numbers: [13, 27, 30, 37, 38] },
  { draw_id: "115000139", draw_date: "2026-06-08", numbers: [8, 14, 17, 18, 28] },
  { draw_id: "115000140", draw_date: "2026-06-09", numbers: [10, 17, 20, 25, 28] },
  { draw_id: "115000141", draw_date: "2026-06-10", numbers: [1, 4, 32, 35, 39] },
  { draw_id: "115000142", draw_date: "2026-06-11", numbers: [8, 15, 20, 29, 31] },
];

const powerDraws = [
  { draw_id: "115000039", draw_date: "2026-05-14", numbers: [4, 8, 10, 25, 29, 32], special_number: 4 },
  { draw_id: "115000040", draw_date: "2026-05-18", numbers: [5, 11, 18, 24, 31, 37], special_number: 5 },
  { draw_id: "115000041", draw_date: "2026-05-21", numbers: [2, 6, 13, 19, 28, 36], special_number: 7 },
  { draw_id: "115000042", draw_date: "2026-05-25", numbers: [3, 9, 16, 21, 33, 35], special_number: 8 },
  { draw_id: "115000043", draw_date: "2026-05-28", numbers: [1, 2, 24, 31, 34, 38], special_number: 3 },
];

function makePredictionRow(record, gameName, generatedAt, drawTargetDate) {
  return {
    source_key: sourceKey(gameName, drawTargetDate),
    game_name: gameName,
    predicted_at: generatedAt,
    target_draw_date: drawTargetDate,
    prediction: record.prediction,
    model_name: record.prediction?.model ?? null,
    reasoning_source: record.prediction?.reasoning_source ?? null,
    is_evaluated: false,
    evaluation: record.evaluation,
    raw: { ...record, target_draw_date: drawTargetDate },
  };
}

test("parses boolean env flags case-insensitively", () => {
  assert.equal(parseBooleanEnvFlag("true"), true);
  assert.equal(parseBooleanEnvFlag("TRUE"), true);
  assert.equal(parseBooleanEnvFlag(" True "), true);
  assert.equal(parseBooleanEnvFlag("1"), false);
  assert.equal(parseBooleanEnvFlag("false"), false);
  assert.equal(parseBooleanEnvFlag(""), false);
});

test("rejects engine=lai-v2 unless the invocation is a dry run", () => {
  assert.throws(
    () => resolveLaiExecution({
      dryRun: false,
      requestedEngine: "lai-v2",
      laiEnabled: false,
      shadowEnabled: false,
    }),
    /dry_run=1/,
  );
});

test("LAI v3 production configuration remains shadow-only and direct v3 requires dry run", () => {
  const execution = resolveAgentExecution({
    dryRun: false,
    requestedEngine: null,
    laiEnabled: true,
    shadowEnabled: false,
    v3ShadowEnabled: false,
    v3ProductionEnabled: true,
  });
  assert.equal(execution.formalEngine, "lai-v2");
  assert.equal(execution.runV3Shadow, true);
  assert.equal(execution.v3ProductionBlocked, true);
  assert.equal(execution.fallbackEngine, "lai-v2");
  assert.throws(
    () => resolveAgentExecution({
      dryRun: false,
      requestedEngine: "lai-v3",
      laiEnabled: true,
      shadowEnabled: false,
      v3ShadowEnabled: false,
      v3ProductionEnabled: false,
    }),
    /engine=lai-v3 requires dry_run=1/,
  );
});

test("v3 shadow evidence cannot replace the LAI v2 formal record or LINE send", async () => {
  const calls = [];
  const v2 = generateAdaptivePrediction({
    gameType: "539",
    draws: dailyDraws,
    generatedAt: "2026-07-10T10:00:00+08:00",
    targetDrawDate: "2026-07-10",
    dataStatus: "complete",
  });
  const result = await executePredictionFlow({
    gameType: "539",
    draws: dailyDraws,
    gameName: GAME_CONFIG["539"].name,
    targetDate: "2026-07-10",
    drawTargetDate: "2026-07-10",
    generatedAt: "2026-07-10T10:00:00+08:00",
    dryRun: false,
    requestedEngine: null,
    laiEnabled: true,
    shadowEnabled: false,
    v3ShadowEnabled: true,
    v3ProductionEnabled: false,
    codeCommit: "0123456789abcdef0123456789abcdef01234567",
    dataStatus: "complete",
  }, {
    notificationKey,
    sourceKey,
    fetchActiveAgentState: async () => ({ status: "baseline", state_version: 0, expert_weights: { uniform: 1 } }),
    generateAdaptivePrediction: () => v2,
    persistForecastRows: async (rows) => calls.push(["persistV2", rows.map((row) => row.forecast_mode)]),
    persistV3ForecastRows: async (rows) => calls.push(["persistV3", rows.map((row) => row.forecast_mode)]),
    fetchShadowRegistrations: async () => [{
      id: "shadow-1", game_name: GAME_CONFIG["539"].name, model_name: "bayesian-drift",
      model_version: "bayes-v1", feature_version: "weighted-v1", parameters: { random_seed: "shadow-seed" },
    }],
    createV3Experiment: async () => ({ id: "experiment-1", status: "running" }),
    generateEvidenceShadow: async () => ({
      forecasts: [{
        status: "completed", registryId: "shadow-1", name: "bayesian-drift", version: "bayes-v1",
        featureVersion: "weighted-v1", randomSeed: "shadow-seed", codeCommit: "0123456789abcdef0123456789abcdef01234567",
        probabilities: Array(39).fill(5 / 39), specialProbabilities: null, featureSummary: {},
      }],
      metrics: { candidates: 1 }, replay_digest: "shadow-digest",
    }),
    completeV3Experiment: async () => calls.push(["completeV3"]),
    failV3Experiment: async () => calls.push(["failV3"]),
    generateHonestPrediction,
    buildLineMessage,
    buildPredictionRow: makePredictionRow,
    upsertPrediction: async (row) => calls.push(["upsert", row.model_name]),
    reserveNotification: async () => true,
    sendLineMessage: async () => { calls.push(["line"]); return { status: 200 }; },
    markNotificationSent: async () => {},
  });

  assert.equal(result.prediction.model, "lai-v2");
  assert.equal(calls.some(([name]) => name === "completeV3"), true);
  assert.equal(calls.some(([name]) => name === "failV3"), false);
  assert.equal(calls.some(([name, modes]) => name === "persistV3" && modes.every((mode) => mode === "shadow")), true);
  assert.deepEqual(calls.filter(([name]) => name === "line"), [["line"]]);
});

test("v3 shadow failure is isolated from the LAI v2 formal record and LINE delivery", async () => {
  const calls = [];
  const v2 = generateAdaptivePrediction({
    gameType: "539",
    draws: dailyDraws,
    generatedAt: "2026-07-10T10:00:00+08:00",
    targetDrawDate: "2026-07-10",
    dataStatus: "complete",
  });
  const result = await executePredictionFlow({
    gameType: "539",
    draws: dailyDraws,
    gameName: GAME_CONFIG["539"].name,
    targetDate: "2026-07-10",
    drawTargetDate: "2026-07-10",
    generatedAt: "2026-07-10T10:00:00+08:00",
    dryRun: false,
    requestedEngine: null,
    laiEnabled: true,
    shadowEnabled: false,
    v3ShadowEnabled: true,
    codeCommit: "0123456789abcdef0123456789abcdef01234567",
    dataStatus: "complete",
  }, {
    notificationKey,
    sourceKey,
    fetchActiveAgentState: async () => ({ status: "baseline", state_version: 0, expert_weights: { uniform: 1 } }),
    generateAdaptivePrediction: () => v2,
    persistForecastRows: async () => calls.push(["persistV2"]),
    fetchShadowRegistrations: async () => [{
      id: "shadow-1", game_name: GAME_CONFIG["539"].name, model_name: "bayesian-drift",
      model_version: "bayes-v1", feature_version: "weighted-v1", parameters: { random_seed: "shadow-seed" },
    }],
    createV3Experiment: async () => ({ id: "experiment-1", status: "running" }),
    generateEvidenceShadow: async () => { throw new Error("shadow generator failed"); },
    persistV3ForecastRows: async () => calls.push(["persistV3"]),
    completeV3Experiment: async () => calls.push(["completeV3"]),
    failV3Experiment: async () => calls.push(["failV3"]),
    generateHonestPrediction,
    buildLineMessage,
    buildPredictionRow: makePredictionRow,
    upsertPrediction: async () => calls.push(["upsert"]),
    reserveNotification: async () => true,
    sendLineMessage: async () => { calls.push(["line"]); return { status: 200 }; },
    markNotificationSent: async () => {},
  });

  assert.equal(result.status, "sent");
  assert.equal(result.prediction.model, "lai-v2");
  assert.equal(result.v3_status, "failed_isolated");
  assert.equal(calls.some(([name]) => name === "failV3"), true);
  assert.equal(calls.some(([name]) => name === "line"), true);
  assert.equal(calls.some(([name]) => name === "persistV3"), false);
});

test("direct LAI v3 preview is dry-run only and never writes predictions, snapshots, or LINE notifications", async () => {
  const calls = [];
  const result = await executePredictionFlow({
    gameType: "539",
    draws: dailyDraws,
    gameName: GAME_CONFIG["539"].name,
    targetDate: "2026-07-10",
    drawTargetDate: "2026-07-10",
    generatedAt: "2026-07-10T10:00:00+08:00",
    dryRun: true,
    requestedEngine: "lai-v3",
    laiEnabled: true,
    shadowEnabled: false,
    v3ShadowEnabled: true,
    codeCommit: "0123456789abcdef0123456789abcdef01234567",
    dataStatus: "complete",
  }, {
    notificationKey,
    sourceKey,
    fetchApprovedV3Context: async () => {
      calls.push(["fetchApprovedV3Context"]);
      return { state: { state_version: 1 }, registrations: [] };
    },
    generateEvidencePrediction: async () => {
      calls.push(["generateEvidencePrediction"]);
      return { record: { prediction: { model: "lai-v3", combinations: {} } } };
    },
    buildLineMessage: () => {
      calls.push(["buildLineMessage"]);
      return "preview";
    },
    fetchActiveAgentState: async () => { throw new Error("must not fetch v2 state"); },
    generateAdaptivePrediction: () => { throw new Error("must not generate v2"); },
    persistForecastRows: async () => { throw new Error("must not persist v2"); },
    fetchShadowRegistrations: async () => { throw new Error("must not read shadow registry"); },
    createV3Experiment: async () => { throw new Error("must not create experiment"); },
    generateEvidenceShadow: async () => { throw new Error("must not generate shadow"); },
    persistV3ForecastRows: async () => { throw new Error("must not persist v3"); },
    completeV3Experiment: async () => { throw new Error("must not complete experiment"); },
    failV3Experiment: async () => { throw new Error("must not fail experiment"); },
    generateHonestPrediction: () => { throw new Error("must not fall back"); },
    buildPredictionRow: () => { throw new Error("must not build prediction row"); },
    upsertPrediction: async () => { throw new Error("must not upsert prediction"); },
    reserveNotification: async () => { throw new Error("must not reserve notification"); },
    sendLineMessage: async () => { throw new Error("must not send LINE"); },
    markNotificationSent: async () => { throw new Error("must not mark notification"); },
  });

  assert.equal(result.status, "dry_run");
  assert.equal(result.formal_engine, "lai-v3");
  assert.deepEqual(calls.map(([name]) => name), [
    "fetchApprovedV3Context",
    "generateEvidencePrediction",
    "buildLineMessage",
  ]);
});

test("LAI v3 production flag records shadow evidence but blocks formal delivery without LAI v2", async () => {
  const calls = [];
  const result = await executePredictionFlow({
    gameType: "539",
    draws: dailyDraws,
    gameName: GAME_CONFIG["539"].name,
    targetDate: "2026-07-10",
    drawTargetDate: "2026-07-10",
    generatedAt: "2026-07-10T10:00:00+08:00",
    dryRun: false,
    requestedEngine: null,
    laiEnabled: false,
    shadowEnabled: false,
    v3ShadowEnabled: false,
    v3ProductionEnabled: true,
    codeCommit: "0123456789abcdef0123456789abcdef01234567",
    dataStatus: "complete",
  }, {
    notificationKey,
    sourceKey,
    fetchActiveAgentState: async () => { throw new Error("must not read LAI v2 state"); },
    generateAdaptivePrediction: () => { throw new Error("must not generate LAI v2"); },
    persistForecastRows: async () => { throw new Error("must not persist LAI v2"); },
    fetchShadowRegistrations: async () => [
      {
        id: "shadow-good", game_name: GAME_CONFIG["539"].name, model_name: "bayesian-drift",
        model_version: "bayes-v1", feature_version: "weighted-v1", parameters: { random_seed: "good-seed" },
      },
      {
        id: "shadow-bad", game_name: GAME_CONFIG["539"].name, model_name: "transition-regularized",
        model_version: "transition-v1", feature_version: "weighted-v1", parameters: { random_seed: "bad-seed" },
      },
    ],
    createV3Experiment: async (row) => ({ id: `experiment-${row.registry_id}`, status: "running" }),
    generateEvidenceShadow: async () => ({
      forecasts: [
        {
          status: "completed", registryId: "shadow-good", name: "bayesian-drift", version: "bayes-v1",
          featureVersion: "weighted-v1", randomSeed: "good-seed", codeCommit: "0123456789abcdef0123456789abcdef01234567",
          probabilities: Array(39).fill(5 / 39), specialProbabilities: null, featureSummary: {},
        },
        {
          status: "failed", registryId: "shadow-bad", name: "transition-regularized", version: "transition-v1",
          failureReason: "candidate validation failed",
        },
      ],
      metrics: { candidates: 2 }, replay_digest: "shadow-digest",
    }),
    persistV3ForecastRows: async (rows) => calls.push(["persistV3", rows]),
    completeV3Experiment: async (experiment) => calls.push(["completeV3", experiment.id]),
    failV3Experiment: async (experiment) => calls.push(["failV3", experiment.id]),
    generateHonestPrediction: () => { throw new Error("must not fall back to honest prediction"); },
    buildLineMessage: () => { throw new Error("must not build LINE message"); },
    buildPredictionRow: () => { throw new Error("must not build prediction row"); },
    upsertPrediction: async () => { throw new Error("must not upsert prediction"); },
    reserveNotification: async () => { throw new Error("must not reserve notification"); },
    sendLineMessage: async () => { throw new Error("must not send LINE"); },
    markNotificationSent: async () => { throw new Error("must not mark notification"); },
  });

  assert.equal(result.status, "blocked_no_valid_state");
  assert.equal(result.v3_status, "completed_with_failures");
  const v3Rows = calls.find(([name]) => name === "persistV3")[1];
  assert.equal(v3Rows.length, 1);
  assert.equal(v3Rows[0].forecast_mode, "shadow");
  assert.equal(v3Rows[0].registry_id, "shadow-good");
  assert.equal(v3Rows[0].experiment_run_id, "experiment-shadow-good");
  assert.equal(v3Rows[0].replay_digest, "shadow-digest");
  assert.deepEqual(calls.filter(([name]) => name === "completeV3"), [["completeV3", "experiment-shadow-good"]]);
  assert.deepEqual(calls.filter(([name]) => name === "failV3"), [["failV3", "experiment-shadow-bad"]]);
});

test("shadow mode persists LAI forecasts but keeps the legacy prediction record", async () => {
  const calls = [];
  const result = await executePredictionFlow({
    gameType: "539",
    draws: dailyDraws,
    gameName: GAME_CONFIG["539"].name,
    targetDate: "2026-07-10",
    drawTargetDate: "2026-07-10",
    generatedAt: "2026-07-10T10:00:00+08:00",
    dryRun: false,
    requestedEngine: null,
    laiEnabled: false,
    shadowEnabled: true,
    dataStatus: "fresh",
  }, {
    notificationKey,
    sourceKey,
    fetchActiveAgentState: async () => ({ status: "baseline", state_version: 0, expert_weights: { uniform: 1 } }),
    generateAdaptivePrediction: (options) => {
      calls.push(["generateAdaptivePrediction", options.targetDrawDate]);
      return generateAdaptivePrediction(options);
    },
    persistForecastRows: async (rows) => {
      calls.push(["persistForecastRows", rows.map((row) => row.forecast_mode)]);
    },
    generateHonestPrediction: (options) => {
      calls.push(["generateHonestPrediction", options.gameType]);
      return generateHonestPrediction(options);
    },
    buildLineMessage: (record, drawTargetDate) => {
      calls.push(["buildLineMessage", record.prediction.model, drawTargetDate]);
      return buildLineMessage(record, drawTargetDate);
    },
    buildPredictionRow: makePredictionRow,
    upsertPrediction: async (row) => {
      calls.push(["upsertPrediction", row.model_name]);
    },
    reserveNotification: async () => {
      calls.push(["reserveNotification"]);
      return false;
    },
    sendLineMessage: async () => {
      calls.push(["sendLineMessage"]);
      return { status: 200 };
    },
    markNotificationSent: async () => {
      calls.push(["markNotificationSent"]);
    },
  });

  assert.equal(result.prediction.model, "game-theory-v1");
  assert.deepEqual(calls[1], ["persistForecastRows", ["shadow", "shadow", "shadow", "shadow", "shadow", "shadow", "shadow", "shadow", "shadow"]]);
  assert.deepEqual(calls.at(-1), ["reserveNotification"]);
  assert.equal(calls.some(([name]) => name === "sendLineMessage"), false);
});

test("builds forecast rows for every expert and the ensemble with unique conflict keys", () => {
  const lai = generateAdaptivePrediction({
    gameType: "power",
    draws: powerDraws,
    generatedAt: "2026-07-13T10:00:00+08:00",
    targetDrawDate: "2026-07-13",
    dataStatus: "fresh",
  });

  const rows = buildForecastRows({
    predictionSourceKey: sourceKey(GAME_CONFIG.power.name, "2026-07-13"),
    gameName: GAME_CONFIG.power.name,
    targetDrawDate: "2026-07-13",
    generatedAt: "2026-07-13T10:00:00+08:00",
    forecastMode: "production",
    forecasts: lai.forecasts,
  });

  assert.ok(rows.some((row) => row.model_name === "ensemble"));
  assert.equal(rows.every((row) => row.forecast_mode === "production"), true);
  assert.equal(
    new Set(rows.map((row) => [
      row.game_name,
      row.target_draw_date,
      row.model_name,
      row.model_version,
      row.forecast_mode,
    ].join("|"))).size,
    rows.length,
  );

  const ensemble = rows.find((row) => row.model_name === "ensemble");
  assert.deepEqual(ensemble.final_groups.combinations, lai.record.prediction.combinations);
  assert.deepEqual(ensemble.final_groups.special_combinations, lai.record.prediction.special_combinations);
  assert.equal(rows.every((row) => !Object.hasOwn(row, "registry_id")), true);
});

test("buildForecastRows isolates persistence-row mutations from forecasts, record, and LINE output", () => {
  const lai = generateAdaptivePrediction({
    gameType: "power",
    draws: powerDraws,
    generatedAt: "2026-07-13T10:00:00+08:00",
    targetDrawDate: "2026-07-13",
    dataStatus: "fresh",
  });
  const originalLine = buildLineMessage(lai.record, "2026-07-13");
  const originalMainNumber = lai.record.prediction.combinations["機率主攻"][0];
  const ensembleForecast = lai.forecasts.find((forecast) => forecast.name === "ensemble");
  const lstmForecast = lai.forecasts.find((forecast) => forecast.name === "lstm");
  const originalFallback = lstmForecast?.featureSummary?.specialAreaFallback;

  const rows = buildForecastRows({
    predictionSourceKey: sourceKey(GAME_CONFIG.power.name, "2026-07-13"),
    gameName: GAME_CONFIG.power.name,
    targetDrawDate: "2026-07-13",
    generatedAt: "2026-07-13T10:00:00+08:00",
    forecastMode: "production",
    forecasts: lai.forecasts,
  });

  const ensembleRow = rows.find((row) => row.model_name === "ensemble");
  const lstmRow = rows.find((row) => row.model_name === "lstm");

  ensembleRow.final_groups.combinations["機率主攻"][0] = 99;
  ensembleRow.final_groups.special_combinations["機率主攻"][0] = 8;
  lstmRow.feature_summary.specialAreaFallback = "mutated";

  assert.equal(ensembleRow.final_groups.combinations["機率主攻"][0], 99);
  assert.equal(lstmRow.feature_summary.specialAreaFallback, "mutated");
  assert.equal(lai.record.prediction.combinations["機率主攻"][0], originalMainNumber);
  assert.equal(ensembleForecast.final_groups.combinations["機率主攻"][0], originalMainNumber);
  assert.equal(lstmForecast?.featureSummary?.specialAreaFallback, originalFallback);
  assert.equal(buildLineMessage(lai.record, "2026-07-13"), originalLine);
});

test("fails fast when the active LAI agent state query fails", async () => {
  await assert.rejects(
    executePredictionFlow({
      gameType: "539",
      draws: dailyDraws,
      gameName: GAME_CONFIG["539"].name,
      targetDate: "2026-07-10",
      drawTargetDate: "2026-07-10",
      generatedAt: "2026-07-10T10:00:00+08:00",
      dryRun: false,
      requestedEngine: null,
      laiEnabled: true,
      shadowEnabled: false,
      dataStatus: "fresh",
    }, {
      notificationKey,
      sourceKey,
      fetchActiveAgentState: async () => {
        throw new Error("Agent state query failed: 500 boom");
      },
      generateAdaptivePrediction,
      persistForecastRows: async () => {},
      generateHonestPrediction,
      buildLineMessage,
      buildPredictionRow: makePredictionRow,
      upsertPrediction: async () => {},
      reserveNotification: async () => true,
      sendLineMessage: async () => ({ status: 200 }),
      markNotificationSent: async () => {},
    }),
    /Agent state query failed/,
  );
});

test("active state empty rows fall back to baseline LAI generation", async () => {
  const result = await executePredictionFlow({
    gameType: "539",
    draws: dailyDraws,
    gameName: GAME_CONFIG["539"].name,
    targetDate: "2026-07-10",
    drawTargetDate: "2026-07-10",
    generatedAt: "2026-07-10T10:00:00+08:00",
    dryRun: true,
    requestedEngine: "lai-v2",
    laiEnabled: false,
    shadowEnabled: false,
    dataStatus: "fresh",
  }, {
    notificationKey,
    sourceKey,
    fetchActiveAgentState: async () => null,
    generateAdaptivePrediction,
    persistForecastRows: async () => {},
    generateHonestPrediction,
    buildLineMessage,
    buildPredictionRow: makePredictionRow,
    upsertPrediction: async () => {},
    reserveNotification: async () => true,
    sendLineMessage: async () => ({ status: 200 }),
    markNotificationSent: async () => {},
  });

  assert.equal(result.status, "dry_run");
  assert.equal(result.prediction.model, "lai-v2");
  assert.equal(result.prediction.agent_status, "baseline");
});

test("dry-run LAI persists forecasts but does not reserve or send LINE", async () => {
  const calls = [];
  const result = await executePredictionFlow({
    gameType: "539",
    draws: dailyDraws,
    gameName: GAME_CONFIG["539"].name,
    targetDate: "2026-07-10",
    drawTargetDate: "2026-07-10",
    generatedAt: "2026-07-10T10:00:00+08:00",
    dryRun: true,
    requestedEngine: "lai-v2",
    laiEnabled: false,
    shadowEnabled: false,
    dataStatus: "fresh",
  }, {
    notificationKey,
    sourceKey,
    fetchActiveAgentState: async () => ({ status: "baseline", state_version: 0, expert_weights: { uniform: 1 } }),
    generateAdaptivePrediction: (options) => generateAdaptivePrediction(options),
    persistForecastRows: async (rows) => {
      calls.push(["persistForecastRows", rows.length]);
    },
    generateHonestPrediction,
    buildLineMessage: (record, drawTargetDate) => {
      calls.push(["buildLineMessage", record.prediction.model]);
      return buildLineMessage(record, drawTargetDate);
    },
    buildPredictionRow: () => {
      calls.push(["buildPredictionRow"]);
      return {};
    },
    upsertPrediction: async () => {
      calls.push(["upsertPrediction"]);
    },
    reserveNotification: async () => {
      calls.push(["reserveNotification"]);
      return true;
    },
    sendLineMessage: async () => {
      calls.push(["sendLineMessage"]);
      return { status: 200 };
    },
    markNotificationSent: async () => {},
  });

  assert.equal(result.status, "dry_run");
  assert.equal(result.prediction.model, "lai-v2");
  assert.deepEqual(calls.map(([name]) => name), ["persistForecastRows", "buildLineMessage"]);
});

test("forecast persistence failure does not reserve or send LINE", async () => {
  const calls = [];
  await assert.rejects(
    executePredictionFlow({
      gameType: "539",
      draws: dailyDraws,
      gameName: GAME_CONFIG["539"].name,
      targetDate: "2026-07-10",
      drawTargetDate: "2026-07-10",
      generatedAt: "2026-07-10T10:00:00+08:00",
      dryRun: false,
      requestedEngine: null,
      laiEnabled: true,
      shadowEnabled: false,
      dataStatus: "fresh",
    }, {
      notificationKey,
      sourceKey,
      fetchActiveAgentState: async () => ({ status: "baseline", state_version: 0, expert_weights: { uniform: 1 } }),
      generateAdaptivePrediction,
      persistForecastRows: async () => {
        calls.push(["persistForecastRows"]);
        throw new Error("forecast write failed");
      },
      generateHonestPrediction,
      buildLineMessage,
      buildPredictionRow: makePredictionRow,
      upsertPrediction: async () => {
        calls.push(["upsertPrediction"]);
      },
      reserveNotification: async () => {
        calls.push(["reserveNotification"]);
        return true;
      },
      sendLineMessage: async () => {
        calls.push(["sendLineMessage"]);
        return { status: 200 };
      },
      markNotificationSent: async () => {},
    }),
    /forecast write failed/,
  );

  assert.deepEqual(calls, [["persistForecastRows"]]);
});

test("production evidence write failure does not reserve or send LINE", async () => {
  const calls = [];
  await assert.rejects(
    executePredictionFlow({
      gameType: "539",
      draws: dailyDraws,
      gameName: GAME_CONFIG["539"].name,
      targetDate: "2026-07-10",
      drawTargetDate: "2026-07-10",
      generatedAt: "2026-07-10T10:00:00+08:00",
      dryRun: false,
      requestedEngine: null,
      laiEnabled: true,
      shadowEnabled: false,
      dataStatus: "fresh",
    }, {
      notificationKey,
      sourceKey,
      fetchActiveAgentState: async () => ({ status: "baseline", state_version: 0, expert_weights: { uniform: 1 } }),
      generateAdaptivePrediction,
      persistForecastRows: async () => {
        calls.push(["persistForecastRows"]);
      },
      generateHonestPrediction,
      buildLineMessage,
      buildPredictionRow: (record, gameName, generatedAt, drawTargetDate) => {
        calls.push(["buildPredictionRow", record.prediction.model]);
        return makePredictionRow(record, gameName, generatedAt, drawTargetDate);
      },
      upsertPrediction: async () => {
        calls.push(["upsertPrediction"]);
        throw new Error("prediction evidence write failed");
      },
      reserveNotification: async () => {
        calls.push(["reserveNotification"]);
        return true;
      },
      sendLineMessage: async () => {
        calls.push(["sendLineMessage"]);
        return { status: 200 };
      },
      markNotificationSent: async () => {},
    }),
    /prediction evidence write failed/,
  );

  assert.deepEqual(calls.map(([name]) => name), ["persistForecastRows", "buildPredictionRow", "upsertPrediction"]);
});

test("duplicate reservation does not re-send the LINE message and keeps notification key uniqueness", async () => {
  const calls = [];
  const result = await executePredictionFlow({
    gameType: "539",
    draws: dailyDraws,
    gameName: GAME_CONFIG["539"].name,
    targetDate: "2026-07-10",
    drawTargetDate: "2026-07-10",
    generatedAt: "2026-07-10T10:00:00+08:00",
    dryRun: false,
    requestedEngine: null,
    laiEnabled: true,
    shadowEnabled: false,
    dataStatus: "fresh",
  }, {
    notificationKey,
    sourceKey,
    fetchActiveAgentState: async () => ({ status: "baseline", state_version: 0, expert_weights: { uniform: 1 } }),
    generateAdaptivePrediction,
    persistForecastRows: async () => {
      calls.push(["persistForecastRows"]);
    },
    generateHonestPrediction,
    buildLineMessage,
    buildPredictionRow: makePredictionRow,
    upsertPrediction: async () => {
      calls.push(["upsertPrediction"]);
    },
    reserveNotification: async (key) => {
      calls.push(["reserveNotification", key]);
      return false;
    },
    sendLineMessage: async () => {
      calls.push(["sendLineMessage"]);
      return { status: 200 };
    },
    markNotificationSent: async () => {},
  });

  assert.equal(result.status, "skipped_duplicate");
  assert.equal(result.notification_key, notificationKey(GAME_CONFIG["539"].name, "2026-07-10", "prediction"));
  assert.equal(calls.some(([name]) => name === "sendLineMessage"), false);
});

test("passes a stable UUID retry key derived from the notification key to LINE", async () => {
  const retryKeys = [];
  const options = {
    gameType: "539",
    draws: dailyDraws,
    gameName: GAME_CONFIG["539"].name,
    targetDate: "2026-07-10",
    drawTargetDate: "2026-07-10",
    generatedAt: "2026-07-10T10:00:00+08:00",
    dryRun: false,
    requestedEngine: null,
    laiEnabled: false,
    shadowEnabled: false,
  };
  const deps = {
    notificationKey,
    sourceKey,
    generateHonestPrediction,
    buildLineMessage,
    buildPredictionRow: makePredictionRow,
    upsertPrediction: async () => {},
    reserveNotification: async () => true,
    sendLineMessage: async (_message, retryKey) => {
      retryKeys.push(retryKey);
      return { status: 200 };
    },
    markNotificationSent: async () => {},
  };

  await executePredictionFlow(options, deps);
  await executePredictionFlow(options, deps);

  assert.match(retryKeys[0], /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(retryKeys[0], retryKeys[1]);
});

test("accepted LINE retry responses are marked sent instead of failed", async () => {
  const marks = [];
  const acceptedError = Object.assign(new Error("LINE push failed: 409"), {
    status: 409,
    acceptedRequestId: "accepted-request-id",
    response: {
      status: 409,
      accepted_request_id: "accepted-request-id",
    },
  });

  const result = await executePredictionFlow({
    gameType: "539",
    draws: dailyDraws,
    gameName: GAME_CONFIG["539"].name,
    targetDate: "2026-07-10",
    drawTargetDate: "2026-07-10",
    generatedAt: "2026-07-10T10:00:00+08:00",
    dryRun: false,
    requestedEngine: null,
    laiEnabled: false,
    shadowEnabled: false,
  }, {
    notificationKey,
    sourceKey,
    generateHonestPrediction,
    buildLineMessage,
    buildPredictionRow: makePredictionRow,
    upsertPrediction: async () => {},
    reserveNotification: async () => true,
    sendLineMessage: async () => {
      throw acceptedError;
    },
    markNotificationSent: async (...args) => {
      marks.push(args);
    },
  });

  assert.equal(result.status, "sent");
  assert.equal(marks.length, 1);
  assert.equal(marks[0][1], "sent");
  assert.deepEqual(marks[0][2], acceptedError.response);
});

test("a LINE 409 without an accepted request id fails fast", async () => {
  const marks = [];
  const conflictError = Object.assign(new Error("LINE push failed: 409"), {
    status: 409,
    acceptedRequestId: null,
  });

  await assert.rejects(
    executePredictionFlow({
      gameType: "539",
      draws: dailyDraws,
      gameName: GAME_CONFIG["539"].name,
      targetDate: "2026-07-10",
      drawTargetDate: "2026-07-10",
      generatedAt: "2026-07-10T10:00:00+08:00",
      dryRun: false,
      requestedEngine: null,
      laiEnabled: false,
      shadowEnabled: false,
    }, {
      notificationKey,
      sourceKey,
      generateHonestPrediction,
      buildLineMessage,
      buildPredictionRow: makePredictionRow,
      upsertPrediction: async () => {},
      reserveNotification: async () => true,
      sendLineMessage: async () => {
        throw conflictError;
      },
      markNotificationSent: async (...args) => {
        marks.push(args);
      },
    }),
    /LINE push failed: 409/,
  );

  assert.equal(marks[0][1], "failed");
});
