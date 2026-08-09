import test from "node:test";
import assert from "node:assert/strict";

import { applyFamilyFdr, runEvidenceLearning } from "./evidenceLearning.js";

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
  metrics: { promotion_stage: "baseline" },
  last_learned_draw_id: "539-20260804",
  last_learned_draw_date: "2026-08-04",
};

function clone(value) {
  return structuredClone(value);
}

function makeEvidenceLearningDeps({
  forecasts = [validUniform, validBayesian],
  activeState = baselineState,
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
  const db = { scores: [] };
  const historyRow = (row) => ({
    ...clone(row),
    forecast: {
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
      assert.ok(correction.invalidated_score_ids.length > 0, "correction RPC requires invalidations");
      assert.equal(correction.invalidated_score_ids.length, correction.replacement_scores.length, "correction RPC requires one replacement per invalidation");
      assert.ok(correction.replacement_scores.every((row) => row.source_revision === correction.corrected_revision && row.supersedes_score_id), "correction RPC requires corrected revision and supersession claim");
      corrections.push(clone(correction));
      const invalidated = new Set(correction.invalidated_score_ids);
      db.scores.forEach((row) => {
        if (invalidated.has(row.id)) row.is_valid = false;
      });
      correction.replacement_scores.forEach((row) => {
        db.scores.push(historyRow({ ...clone(row), id: `score-${row.forecast_id}-${row.source_revision}` }));
      });
      return { id: `correction-${corrections.length}` };
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
