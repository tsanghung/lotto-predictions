import test from "node:test";
import assert from "node:assert/strict";

import * as evidenceLearning from "./evidenceLearning.js";

const { applyFamilyFdr, runEvidenceLearning } = evidenceLearning;

const input = {
  gameName: "今彩539",
  draw: {
    draw_id: "539-20260805",
    draw_date: "2026-08-05",
    numbers: [1, 7, 13, 25, 39],
  },
  config: { maxNumber: 39, picks: 5 },
  sourceRevision: "official-r1",
};

function forecast({
  id,
  registryId,
  modelName,
  family,
  probabilities = Array(39).fill(5 / 39),
} = {}) {
  return {
    id,
    game_name: input.gameName,
    target_draw_date: input.draw.draw_date,
    registry_id: registryId,
    model_name: modelName,
    model_family: family,
    forecast_mode: "shadow",
    probabilities,
    final_groups: {
      combinations: {
        "機率主攻": [1, 7, 13, 25, 39],
        "覆蓋探索": [2, 8, 14, 26, 38],
      },
    },
  };
}

const validUniform = forecast({
  id: "forecast-uniform",
  registryId: "registry-uniform",
  modelName: "uniform",
  family: "uniform-null",
});
const validBayesian = forecast({
  id: "forecast-bayesian",
  registryId: "registry-bayesian",
  modelName: "bayesian",
  family: "bayesian-drift",
});
const malformedShadow = forecast({
  id: "forecast-malformed",
  registryId: "registry-malformed",
  modelName: "malformed",
  family: "transition-regularized",
  probabilities: [1],
});

const baselineState = {
  game_name: "今彩539",
  state_version: 7,
  status: "baseline",
  champion_model: "uniform",
  expert_weights: { uniform: 1 },
  learning_config: { gamma: 0.1 },
  metrics: { promotion_stage: "baseline", evaluated_draws: 0 },
  last_learned_draw_id: "539-20260804",
  last_learned_draw_date: "2026-08-04",
};

function clone(value) {
  return structuredClone(value);
}

function makeEvidenceLearningDeps({
  forecasts = [validUniform, validBayesian],
  activeState = baselineState,
  loseCorrectionResponses = 0,
  registry = [
    { id: "registry-uniform", game_name: input.gameName, model_name: "uniform", model_family: "uniform-null", status: "baseline" },
    { id: "registry-bayesian", game_name: input.gameName, model_name: "bayesian", model_family: "bayesian-drift", status: "registered" },
  ],
} = {}) {
  const insertedScores = [];
  const corrections = [];
  const decisions = [];
  const activations = [];
  const failures = [];
  const db = { scores: [], correctionEvents: new Map() };
  const historyRow = (row) => ({
    ...clone(row),
    forecast: {
      id: row.forecast_id,
      game_name: row.game_name,
      target_draw_date: row.draw_date,
      registry_id: row.registry_id,
      model_name: row.model_name,
      forecast_mode: row.forecast_mode,
      registry: clone(registry.find((entry) => entry.id === row.registry_id)),
    },
  });
  const deps = {
    insertedScores,
    corrections,
    decisions,
    activations,
    failures,
    db,
    fetchV3Forecasts: async () => clone(forecasts),
    fetchValidScoreHistory: async () => clone(db.scores.filter((row) => row.is_valid !== false)),
    insertScoresIdempotently: async (rows) => {
      for (const row of rows) {
        assert.equal(row.source_revision, "original", "upsert_lotto_model_scores accepts original rows only");
        assert.equal(row.supersedes_score_id, undefined, "upsert_lotto_model_scores rejects correction rows");
        if (!db.scores.some((stored) => stored.forecast_id === row.forecast_id
          && stored.draw_id === row.draw_id && stored.is_valid !== false)) {
          const persisted = historyRow({ ...clone(row), id: `score-${row.forecast_id}-${row.source_revision}` });
          db.scores.push(persisted);
          insertedScores.push(persisted);
        }
      }
    },
    fetchRegistry: async () => clone(registry),
    fetchActiveState: async () => clone(activeState),
    recordDecision: async (decision) => {
      const persisted = { ...clone(decision), id: `decision-${decisions.length + 1}` };
      decisions.push(persisted);
      return persisted;
    },
    activateAuthorizedState: async (decision, state) => {
      activations.push({ decision: clone(decision), state: clone(state) });
      return state;
    },
    recordFailure: async (failure) => failures.push(clone(failure)),
    recordCorrection: async (correction) => {
      assert.equal(typeof correction.event_key, "string", "correction RPC requires event_key");
      assert.ok(correction.event_key.length > 0, "correction RPC requires non-empty event_key");
      assert.ok(correction.invalidated_score_ids.length > 0, "correction RPC requires invalidations");
      assert.equal(correction.invalidated_score_ids.length, correction.replacement_scores.length, "correction RPC requires one replacement per invalidation");
      assert.ok(correction.replacement_scores.every((row) => row.source_revision === correction.corrected_revision && row.supersedes_score_id), "correction RPC requires corrected revision and supersession claim");
      const existing = db.correctionEvents.get(correction.event_key);
      if (existing) {
        assert.deepEqual(correction, existing.payload, "same event_key requires an exact canonical payload replay");
        return clone(existing.result);
      }
      corrections.push(clone(correction));
      const invalidated = new Set(correction.invalidated_score_ids);
      db.scores.forEach((row) => {
        if (invalidated.has(row.id)) row.is_valid = false;
      });
      correction.replacement_scores.forEach((row) => {
        db.scores.push(historyRow({ ...clone(row), id: `score-${row.forecast_id}-${row.source_revision}-${db.scores.length + 1}` }));
      });
      const result = { id: `correction-${corrections.length}` };
      db.correctionEvents.set(correction.event_key, { payload: clone(correction), result: clone(result) });
      if (corrections.length <= loseCorrectionResponses) throw new Error("simulated correction response loss");
      return result;
    },
  };
  return deps;
}

test("same draw and revision scores once", async () => {
  const deps = makeEvidenceLearningDeps();
  const first = await runEvidenceLearning(input, deps);
  const replay = await runEvidenceLearning(input, deps);

  assert.equal(first.status, "learned");
  assert.equal(replay.status, "already_scored");
  assert.equal(deps.insertedScores.length, first.scoresWritten);
});

test("shadow model failure does not change active state", async () => {
  const deps = makeEvidenceLearningDeps({ forecasts: [validUniform, malformedShadow] });
  const result = await runEvidenceLearning(input, deps);

  assert.equal(result.failures[0].registryId, malformedShadow.registry_id);
  assert.equal(deps.activations.length, 0);
  assert.ok(deps.insertedScores.some((row) => row.forecast_id === validUniform.id));
});

test("official correction invalidates and replaces scores", async () => {
  const correctionDeps = makeEvidenceLearningDeps();
  await runEvidenceLearning(input, correctionDeps);
  const correctedInput = {
    ...input,
    draw: { ...input.draw, numbers: [2, 8, 14, 26, 38] },
    sourceRevision: "official-r2",
  };

  const result = await runEvidenceLearning(correctedInput, correctionDeps);
  const oldScores = correctionDeps.db.scores.filter((row) => row.source_revision === "original");
  const newScores = correctionDeps.db.scores.filter((row) => row.source_revision === "official-r2");

  assert.equal(result.status, "corrected");
  assert.equal(correctionDeps.corrections.length, 1);
  assert.equal(correctionDeps.corrections[0].previous_revision, "original");
  assert.ok(oldScores.every((row) => row.is_valid === false));
  assert.ok(newScores.every((row) => row.source_revision === "official-r2"));
});

test("FDR adjusts all candidate p-values as one draw family before gate evaluation", () => {
  const evidence = applyFamilyFdr({
    "registry-a": { permutationP: 0.01 },
    "registry-b": { permutationP: 0.04 },
  });

  assert.equal(evidence["registry-a"].adjustedQ, 0.02);
  assert.equal(evidence["registry-b"].adjustedQ, 0.04);
});

test("repository-shaped forecasts inherit family identity only from their matching registry", async () => {
  const restUniform = structuredClone(validUniform);
  const restBayesian = structuredClone(validBayesian);
  delete restUniform.model_family;
  delete restBayesian.model_family;
  restUniform.registry = { id: "registry-uniform", game_name: input.gameName, model_name: "uniform", model_family: "uniform-null", status: "baseline" };
  restBayesian.registry = { id: "registry-bayesian", game_name: input.gameName, model_name: "bayesian", model_family: "bayesian-drift", status: "registered" };
  const deps = makeEvidenceLearningDeps({ forecasts: [restUniform, restBayesian] });

  const result = await runEvidenceLearning(input, deps);

  assert.equal(result.status, "learned");
  assert.equal(result.failures.length, 0);
  assert.ok(deps.insertedScores.every((row) => row.source_revision === "original"));
});

test("correction derives original revision and stale actual numbers from valid score history", async () => {
  const deps = makeEvidenceLearningDeps();
  await runEvidenceLearning(input, deps);
  const corrected = await runEvidenceLearning({
    ...input,
    draw: { ...input.draw, numbers: [2, 8, 14, 26, 38] },
    sourceRevision: "draw-canonical-r2",
  }, deps);

  assert.equal(corrected.status, "corrected");
  assert.equal(deps.corrections.length, 1);
  assert.equal(deps.corrections[0].previous_revision, "original");
  assert.equal(deps.corrections[0].corrected_revision, "draw-canonical-r2");
});

test("a stale valid score without replacement forecasts fails closed", async () => {
  const deps = makeEvidenceLearningDeps();
  await runEvidenceLearning(input, deps);
  deps.fetchV3Forecasts = async () => [];

  await assert.rejects(
    runEvidenceLearning({
      ...input,
      draw: { ...input.draw, numbers: [2, 8, 14, 26, 38] },
      sourceRevision: "draw-canonical-r2",
    }, deps),
    /replacement forecasts/i,
  );
});

test("missing same-game uniform baseline blocks scoring and decision persistence", async () => {
  const deps = makeEvidenceLearningDeps({
    registry: [{ id: "registry-bayesian", game_name: input.gameName, model_name: "bayesian", model_family: "bayesian-drift", status: "registered" }],
  });

  const result = await runEvidenceLearning(input, deps);

  assert.equal(result.status, "blocked_registry");
  assert.equal(deps.insertedScores.length, 0);
  assert.equal(deps.decisions.length, 0);
});

test("malformed durable actual numbers fail closed before correction persistence", async () => {
  const deps = makeEvidenceLearningDeps();
  await runEvidenceLearning(input, deps);
  deps.db.scores[0].metrics.actual_numbers = [1, 2];

  await assert.rejects(
    runEvidenceLearning({
      ...input,
      draw: { ...input.draw, numbers: [2, 8, 14, 26, 38] },
      sourceRevision: "draw-canonical-r2",
    }, deps),
    /actual_numbers.*count/i,
  );
  assert.equal(deps.corrections.length, 0);
});

test("a structurally valid config for the wrong game fails closed", async () => {
  const deps = makeEvidenceLearningDeps();
  await assert.rejects(
    runEvidenceLearning({ ...input, config: { maxNumber: 40, picks: 5 } }, deps),
    /game config.*does not match/i,
  );
  assert.equal(deps.insertedScores.length, 0);
  assert.equal(deps.decisions.length, 0);
});

test("durable actual numbers reject non-integers out-of-range values and duplicates", async (context) => {
  const cases = [
    { name: "non-integer", actual: [1, 7, 13, 25, 38.5], pattern: /integers/i },
    { name: "out-of-range", actual: [1, 7, 13, 25, 40], pattern: /within 1\.\.39/i },
    { name: "duplicate", actual: [1, 7, 13, 25, 25], pattern: /unique/i },
  ];
  for (const fixture of cases) {
    await context.test(fixture.name, async () => {
      const deps = makeEvidenceLearningDeps();
      await runEvidenceLearning(input, deps);
      deps.db.scores[0].metrics.actual_numbers = fixture.actual;
      await assert.rejects(runEvidenceLearning(input, deps), fixture.pattern);
      assert.equal(deps.corrections.length, 0);
    });
  }
});

test("stale rows for one previous revision require one canonical actual payload", async () => {
  const deps = makeEvidenceLearningDeps();
  await runEvidenceLearning(input, deps);
  deps.db.scores[1].metrics.actual_numbers = [2, 8, 14, 26, 38];

  await assert.rejects(
    runEvidenceLearning({
      ...input,
      draw: { ...input.draw, numbers: [3, 9, 15, 27, 37] },
      sourceRevision: "draw-canonical-r2",
    }, deps),
    /canonical actual payload/i,
  );
  assert.equal(deps.corrections.length, 0);
});

test("missing active state blocks every decision even while activation is disabled", async () => {
  const deps = makeEvidenceLearningDeps({ activeState: null });

  await assert.rejects(
    runEvidenceLearning({ ...input, activationAuthorized: false }, deps),
    /active state/i,
  );
  assert.equal(deps.decisions.length, 0);
  assert.equal(deps.activations.length, 0);
});

test("malformed active model source blocks decision persistence", async () => {
  const deps = makeEvidenceLearningDeps({ activeState: { ...baselineState, expert_weights: {} } });
  await assert.rejects(runEvidenceLearning({ ...input, activationAuthorized: false }, deps), /active state.*model source/i);
  assert.equal(deps.decisions.length, 0);
});

test("every valid score history row is identity-checked before a decision", async () => {
  const deps = makeEvidenceLearningDeps({ forecasts: [validUniform] });
  await runEvidenceLearning(input, deps);
  deps.db.scores[0].draw_date = "2026-08-04";
  deps.fetchV3Forecasts = async () => clone([validUniform, validBayesian]);

  await assert.rejects(runEvidenceLearning(input, deps), /score history.*draw date/i);
  assert.equal(deps.decisions.length, 0);
});

test("same draw and revision history requires one canonical actual payload before a decision", async () => {
  const deps = makeEvidenceLearningDeps();
  await runEvidenceLearning(input, deps);
  deps.db.scores[1].metrics.actual_numbers = [2, 8, 14, 26, 38];

  await assert.rejects(runEvidenceLearning(input, deps), /same draw and revision.*canonical actual/i);
  assert.equal(deps.decisions.length, 1);
});

test("strict active-state contract rejects malformed metadata before recordDecision", async (context) => {
  const cases = [
    ["numeric string version", { state_version: "7" }],
    ["unknown status", { status: "unknown" }],
    ["numeric string weight", { expert_weights: { uniform: "1" } }],
    ["null weight", { expert_weights: { uniform: null } }],
    ["negative weight", { expert_weights: { uniform: -1, bayesian: 2 } }],
    ["non-finite weight", { expert_weights: { uniform: Number.NaN } }],
    ["zero total weight", { expert_weights: { uniform: 0 } }],
    ["missing champion key", { champion_model: "bayesian", expert_weights: { uniform: 1 } }],
    ["numeric string metric", { metrics: { promotion_stage: "baseline", evaluated_draws: "0" } }],
    ["negative metric", { metrics: { promotion_stage: "baseline", evaluated_draws: -1 } }],
    ["numeric string config", { learning_config: { gamma: "0.1" } }],
    ["null config", { learning_config: { gamma: null } }],
  ];

  for (const [name, override] of cases) {
    await context.test(name, async () => {
      const deps = makeEvidenceLearningDeps({ activeState: { ...clone(baselineState), ...clone(override) } });
      await assert.rejects(runEvidenceLearning({ ...input, activationAuthorized: false }, deps), /active state/i);
      assert.equal(deps.decisions.length, 0);
    });
  }
});

test("a valid active state still reaches the existing gate and recordDecision", async () => {
  const deps = makeEvidenceLearningDeps({ activeState: clone(baselineState) });
  const result = await runEvidenceLearning({ ...input, activationAuthorized: false }, deps);

  assert.equal(result.status, "learned");
  assert.equal(deps.decisions.length, 1);
  assert.equal(deps.activations.length, 0);
});

test("a late candidate is scored after the baseline draw score already exists", async () => {
  const deps = makeEvidenceLearningDeps({ forecasts: [validUniform] });
  const baseline = await runEvidenceLearning(input, deps);
  deps.fetchV3Forecasts = async () => clone([validUniform, validBayesian]);

  const candidate = await runEvidenceLearning(input, deps);
  const replay = await runEvidenceLearning(input, deps);

  assert.equal(baseline.scoresWritten, 1);
  assert.equal(candidate.status, "learned");
  assert.equal(candidate.scoresWritten, 1);
  assert.equal(replay.status, "already_scored");
  assert.deepEqual(deps.insertedScores.map((row) => row.forecast_id), ["forecast-uniform", "forecast-bayesian"]);
});

test("correction replaces stale scores and inserts a newly arrived candidate", async () => {
  const deps = makeEvidenceLearningDeps({ forecasts: [validUniform] });
  await runEvidenceLearning(input, deps);
  deps.fetchV3Forecasts = async () => clone([validUniform, validBayesian]);

  const result = await runEvidenceLearning({
    ...input,
    draw: { ...input.draw, numbers: [2, 8, 14, 26, 38] },
    sourceRevision: "draw-canonical-r2",
  }, deps);

  assert.equal(result.status, "corrected");
  assert.equal(deps.corrections[0].replacement_scores.length, 1);
  assert.equal(deps.corrections[0].replacement_scores[0].forecast_id, "forecast-uniform");
  assert.ok(deps.insertedScores.some((row) => row.forecast_id === "forecast-bayesian"));
});

test("three-stage corrections normalize late original scores and survive every response-loss retry", async () => {
  const deps = makeEvidenceLearningDeps({ forecasts: [validUniform], loseCorrectionResponses: 3 });
  await runEvidenceLearning(input, deps);

  const revision2 = {
    ...input,
    draw: { ...input.draw, numbers: [2, 8, 14, 26, 38] },
    sourceRevision: "official-r2",
  };
  await assert.rejects(runEvidenceLearning(revision2, deps), /response loss/i);
  await runEvidenceLearning(revision2, deps);

  deps.fetchV3Forecasts = async () => clone([validUniform, validBayesian]);
  await assert.rejects(runEvidenceLearning(revision2, deps), /response loss/i);
  await runEvidenceLearning(revision2, deps);

  const afterNormalization = deps.db.scores.filter((row) => row.is_valid !== false);
  assert.equal(afterNormalization.length, 2);
  assert.deepEqual([...new Set(afterNormalization.map((row) => row.source_revision))], ["official-r2"]);

  const revision3 = {
    ...input,
    draw: { ...input.draw, numbers: [3, 9, 15, 27, 37] },
    sourceRevision: "official-r3",
  };
  await assert.rejects(runEvidenceLearning(revision3, deps), /response loss/i);
  const finalReplay = await runEvidenceLearning(revision3, deps);

  const current = deps.db.scores.filter((row) => row.is_valid !== false);
  assert.equal(finalReplay.status, "already_scored");
  assert.equal(current.length, 2);
  assert.ok(current.every((row) => row.source_revision === "official-r3"));
  assert.deepEqual(deps.corrections.map((event) => [event.previous_revision, event.corrected_revision]), [
    ["original", "official-r2"],
    ["original", "official-r2"],
    ["official-r2", "official-r3"],
  ]);
  assert.equal(new Set(deps.corrections.map((event) => event.event_key)).size, 3);
});

test("durable worklist merges confirmed draws with missing and stale score work", () => {
  assert.equal(typeof evidenceLearning.buildV3PendingWorklist, "function");
  const draws = [
    { game_name: input.gameName, draw_id: "draw-complete", draw_date: "2026-08-01", numbers: [1, 7, 13, 25, 39], special_number: null },
    { game_name: input.gameName, draw_id: "draw-missing", draw_date: "2026-08-02", numbers: [2, 8, 14, 26, 38], special_number: null },
    { game_name: input.gameName, draw_id: "draw-stale", draw_date: "2026-08-03", numbers: [3, 9, 15, 27, 37], special_number: null },
    { game_name: input.gameName, draw_id: "draw-confirmed", draw_date: "2026-08-04", numbers: [4, 10, 16, 28, 36], special_number: null },
  ];
  const forecasts = [
    { id: "forecast-complete", game_name: input.gameName, target_draw_date: "2026-08-01", registry_id: "registry-bayesian" },
    { id: "forecast-missing", game_name: input.gameName, target_draw_date: "2026-08-02", registry_id: "registry-bayesian" },
    { id: "forecast-stale", game_name: input.gameName, target_draw_date: "2026-08-03", registry_id: "registry-bayesian" },
  ];
  const scores = [
    { id: "score-complete", forecast_id: "forecast-complete", draw_id: "draw-complete", draw_date: "2026-08-01", game_name: input.gameName, is_valid: true, metrics: { actual_numbers: [1, 7, 13, 25, 39], actual_special_number: null } },
    { id: "score-stale", forecast_id: "forecast-stale", draw_id: "draw-stale", draw_date: "2026-08-03", game_name: input.gameName, is_valid: true, metrics: { actual_numbers: [5, 11, 17, 29, 35], actual_special_number: null } },
  ];

  const pending = evidenceLearning.buildV3PendingWorklist({
    confirmedDraws: [draws[3], draws[1]],
    draws,
    forecasts,
    scores,
    configByGame: { [input.gameName]: input.config },
  });

  assert.deepEqual(pending.map((draw) => draw.draw_id), ["draw-missing", "draw-stale", "draw-confirmed"]);
});

test("durable worklist rejects a valid score whose draw date does not match its forecast and draw", () => {
  const draw = { game_name: input.gameName, draw_id: input.draw.draw_id, draw_date: input.draw.draw_date, numbers: input.draw.numbers, special_number: null };
  assert.throws(() => evidenceLearning.buildV3PendingWorklist({
    confirmedDraws: [],
    draws: [draw],
    forecasts: [{ id: validUniform.id, game_name: input.gameName, target_draw_date: input.draw.draw_date, registry_id: validUniform.registry_id }],
    scores: [{ id: "score-wrong-date", forecast_id: validUniform.id, game_name: input.gameName, draw_id: input.draw.draw_id, draw_date: "2026-08-04", is_valid: true, metrics: { actual_numbers: input.draw.numbers, actual_special_number: null } }],
    configByGame: { [input.gameName]: input.config },
  }), /score.*draw date/i);
});

test("a forecast arriving after an empty invocation becomes durable pending work", () => {
  assert.equal(typeof evidenceLearning.buildV3PendingWorklist, "function");
  const draw = { game_name: input.gameName, draw_id: "draw-late", draw_date: "2026-08-05", numbers: [1, 7, 13, 25, 39], special_number: null };
  const empty = evidenceLearning.buildV3PendingWorklist({ confirmedDraws: [], draws: [draw], forecasts: [], scores: [], configByGame: { [input.gameName]: input.config } });
  const late = evidenceLearning.buildV3PendingWorklist({
    confirmedDraws: [],
    draws: [draw],
    forecasts: [{ id: "forecast-late", game_name: input.gameName, target_draw_date: draw.draw_date, registry_id: "registry-bayesian" }],
    scores: [],
    configByGame: { [input.gameName]: input.config },
  });

  assert.deepEqual(empty, []);
  assert.deepEqual(late.map((row) => row.draw_id), ["draw-late"]);
});

function pagedRows(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `score-${String(index).padStart(4, "0")}`,
    draw_date: `2026-08-${String(Math.floor(index / 100) + 1).padStart(2, "0")}`,
    draw_id: `draw-${String(index).padStart(4, "0")}`,
  }));
}

function cappedPageReader(sourceRows, { cap = 500, mutateSecondScan = null } = {}) {
  return async ({ offset, requestedEnd, pass }) => {
    const activeRows = pass === 2 && mutateSecondScan ? mutateSecondScan(sourceRows) : sourceRows;
    const endExclusive = Math.min(offset + cap, requestedEnd + 1, activeRows.length);
    const rows = activeRows.slice(offset, endExclusive);
    return {
      rows,
      contentRange: rows.length ? `${offset}-${offset + rows.length - 1}/${activeRows.length}` : `*/${activeRows.length}`,
    };
  };
}

test("stable pagination reads all 1200 rows when the API caps pages at 500", async () => {
  assert.equal(typeof evidenceLearning.readStablePaginatedRows, "function");
  const rows = pagedRows(1200);
  const result = await evidenceLearning.readStablePaginatedRows({
    fetchPage: cappedPageReader(rows),
    orderFields: ["draw_date", "draw_id", "id"],
    pageSize: 1000,
    maxRows: 2000,
    maxPages: 10,
  });
  assert.equal(result.length, 1200);
  assert.equal(result[1199].id, "score-1199");
});

test("stable pagination rejects wrong coordinates duplicate ids and non-increasing order", async () => {
  assert.equal(typeof evidenceLearning.readStablePaginatedRows, "function");
  const rows = pagedRows(3);
  await assert.rejects(evidenceLearning.readStablePaginatedRows({
    fetchPage: async () => ({ rows, contentRange: "1-3/3" }),
    orderFields: ["draw_date", "draw_id", "id"],
    maxRows: 10,
    maxPages: 2,
  }), /coordinates/i);
  await assert.rejects(evidenceLearning.readStablePaginatedRows({
    fetchPage: cappedPageReader([rows[0], { ...rows[1], id: rows[0].id }]),
    orderFields: ["draw_date", "draw_id", "id"],
    maxRows: 10,
    maxPages: 2,
  }), /duplicate id/i);
  await assert.rejects(evidenceLearning.readStablePaginatedRows({
    fetchPage: cappedPageReader([rows[1], rows[0]]),
    orderFields: ["draw_date", "draw_id", "id"],
    maxRows: 10,
    maxPages: 2,
  }), /strictly increasing/i);
});

test("stable pagination rejects missing or changing totals overflow and same-total drift", async () => {
  assert.equal(typeof evidenceLearning.readStablePaginatedRows, "function");
  const rows = pagedRows(3);
  await assert.rejects(evidenceLearning.readStablePaginatedRows({
    fetchPage: async () => ({ rows, contentRange: null }),
    orderFields: ["draw_date", "draw_id", "id"],
    maxRows: 10,
    maxPages: 2,
  }), /total/i);
  await assert.rejects(evidenceLearning.readStablePaginatedRows({
    fetchPage: async ({ offset }) => offset === 0
      ? { rows: rows.slice(0, 2), contentRange: "0-1/3" }
      : { rows: rows.slice(2), contentRange: "2-2/4" },
    orderFields: ["draw_date", "draw_id", "id"],
    pageSize: 2,
    maxRows: 10,
    maxPages: 3,
  }), /total changed/i);
  await assert.rejects(evidenceLearning.readStablePaginatedRows({
    fetchPage: async ({ offset }) => offset === 0
      ? { rows: rows.slice(0, 2), contentRange: "0-1/3" }
      : { rows: [], contentRange: "*/3" },
    orderFields: ["draw_date", "draw_id", "id"],
    pageSize: 2,
    maxRows: 10,
    maxPages: 3,
  }), /missing page/i);
  await assert.rejects(evidenceLearning.readStablePaginatedRows({
    fetchPage: cappedPageReader(rows),
    orderFields: ["draw_date", "draw_id", "id"],
    maxRows: 2,
    maxPages: 2,
  }), /bounded row limit/i);
  await assert.rejects(evidenceLearning.readStablePaginatedRows({
    fetchPage: cappedPageReader(rows, { mutateSecondScan: (current) => current.map((row, index) => index === 1 ? { ...row, payload: "mutated" } : row) }),
    orderFields: ["draw_date", "draw_id", "id"],
    maxRows: 10,
    maxPages: 2,
  }), /drift/i);
});
