import { createHash } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";

import { generateEvidencePrediction } from "./evidencePrediction.js";
import { GAME_CONFIG } from "./gameConfig.js";

const CODE_COMMIT = "0123456789abcdef0123456789abcdef01234567";

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(",")}}`;
}

function replayDigest(snapshot) {
  const replay = { ...snapshot };
  delete replay.replay_digest;
  return createHash("sha256").update(canonicalJson(replay)).digest("hex");
}

function historicalDraws(gameType) {
  const config = GAME_CONFIG[gameType];
  return Array.from({ length: 120 }, (_, index) => ({
    draw_id: String(index + 1),
    draw_date: new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10),
    numbers: Array.from(
      { length: config.picks },
      (__, offset) => ((index * 7 + offset * 5) % config.maxNumber) + 1,
    ).sort((left, right) => left - right),
    ...(config.secondaryNumber ? { special_number: (index % 8) + 1 } : {}),
  }));
}

function approvedInput(gameType = "539") {
  const gameName = GAME_CONFIG[gameType].name;
  const uniformRegistration = {
    id: `uniform-${gameType}`,
    game_name: gameName,
    model_name: "uniform-null",
    model_family: "uniform-null",
    model_version: "uniform-null-v1",
    feature_version: "none-v1",
    parameters: { random_seed: `uniform-null-${gameType}` },
    code_commit: CODE_COMMIT,
    status: "baseline",
  };
  const championRegistration = {
    id: `bayes-${gameType}`,
    game_name: gameName,
    model_name: "bayesian-drift",
    model_family: "bayesian-drift",
    model_version: "bayesian-drift-v1",
    feature_version: "weighted-counts-v1",
    parameters: {
      halfLifeDraws: 100,
      priorStrength: 100,
      random_seed: `bayesian-drift-${gameType}`,
      service_role_key: "must-not-leak",
    },
    code_commit: CODE_COMMIT,
    status: "champion",
  };
  return {
    gameType,
    targetDrawDate: "2026-08-07",
    generatedAt: "2026-08-07T10:00:00+08:00",
    dataStatus: "complete",
    codeCommit: CODE_COMMIT,
    approvedState: {
      game_name: gameName,
      state_version: 1,
      status: "champion",
      champion_model: "bayesian-drift",
      expert_weights: { "uniform-null": 0.25, "bayesian-drift": 0.75 },
      metrics: {
        promotion_stage: "champion",
        evaluated_draws: 120,
        sample_counts: {
          evaluated_draws: 120,
          private_experiment_payload: "metric-private-payload",
        },
        brier_skill: 0.01,
        brier_ci: { lower95: 0.001, upper95: 0.02 },
        decision_reason: "all evidence gates passed",
      },
    },
    approvedRegistrations: [uniformRegistration, championRegistration],
    shadowRegistrations: [{
      id: `transition-${gameType}`,
      game_name: gameName,
      model_name: "transition-regularized",
      model_family: "transition-regularized",
      model_version: "transition-regularized-v1",
      feature_version: "transition-v1",
      parameters: {
        minimumSupport: 30,
        effectCap: 0.1,
        random_seed: `transition-${gameType}`,
        private_experiment_payload: "must-not-leak",
      },
      code_commit: CODE_COMMIT,
      status: "registered",
    }],
    draws: historicalDraws(gameType),
  };
}

test("v3 record contains exactly two approved groups and a replayable safe snapshot", async () => {
  const input = approvedInput();
  const result = await generateEvidencePrediction(input);

  assert.equal(result.record.prediction.model, "lai-v3");
  assert.equal(result.record.prediction.engine, "lai-v3-evidence-agent");
  assert.equal(result.record.prediction.reasoning_source, "computed_evidence_only");
  assert.deepEqual(
    Object.keys(result.record.prediction.combinations),
    ["證據主攻", "覆蓋保底"],
  );
  assert.equal(result.record.prediction.evidence.promotion_stage, "champion");
  assert.equal(result.evidenceSnapshot.replay_digest, replayDigest(result.evidenceSnapshot));
  assert.match(result.evidenceSnapshot.replay_digest, /^[0-9a-f]{64}$/);
  assert.equal(result.evidenceSnapshot.data_cutoff, "2026-04-30");
  assert.equal(result.evidenceSnapshot.code_commit, CODE_COMMIT);
  assert.equal(result.evidenceSnapshot.notification_key, "prediction|今彩539|2026-08-07");
  assert.equal(result.evidenceSnapshot.groups.optimizer_config.min_utility_ratio, 0.90);
  assert.equal(result.evidenceSnapshot.groups.optimizer_config.max_number, 39);
  assert.equal(result.evidenceSnapshot.groups.optimizer_config.picks, 5);
  assert.equal(result.evidenceSnapshot.groups.state.state_version, 1);
  assert.equal(result.evidenceSnapshot.groups.registry_versions.length, 2);
  assert.equal(JSON.stringify(result.evidenceSnapshot).includes("must-not-leak"), false);
  assert.equal(JSON.stringify(result.evidenceSnapshot).includes("metric-private-payload"), false);

  input.approvedState.expert_weights["bayesian-drift"] = 0;
  input.approvedRegistrations[1].parameters.halfLifeDraws = 1;
  assert.equal(result.evidenceSnapshot.groups.state.expert_weights["bayesian-drift"], 0.75);
  assert.equal(JSON.stringify(result.evidenceSnapshot).includes("halfLifeDraws"), false);
});

test("stale incomplete and unapproved state variants fail closed", async () => {
  const cases = [
    ["stale data", (input) => { input.dataStatus = "stale"; }],
    ["missing metrics", (input) => { input.approvedState.metrics = {}; }],
    ["unapproved registry", (input) => { input.approvedRegistrations[1].status = "registered"; }],
    ["unknown weighted member", (input) => { input.approvedState.expert_weights.unknown = 0.1; }],
    ["commit mismatch", (input) => { input.approvedRegistrations[1].code_commit = "abcdef0"; }],
  ];

  for (const [label, mutate] of cases) {
    const input = approvedInput();
    mutate(input);
    await assert.rejects(
      () => generateEvidencePrediction(input),
      /no_complete_approved_state/,
      label,
    );
  }
});

test("all games emit exactly two legal deterministic evidence groups", async () => {
  for (const gameType of ["539", "649", "power"]) {
    const input = approvedInput(gameType);
    const first = await generateEvidencePrediction(input);
    const replay = await generateEvidencePrediction(input);
    const config = GAME_CONFIG[gameType];
    const groups = first.record.prediction.combinations;

    assert.deepEqual(replay, first, `${gameType} must replay deterministically`);
    assert.deepEqual(Object.keys(groups), ["證據主攻", "覆蓋保底"]);
    for (const numbers of Object.values(groups)) {
      assert.equal(numbers.length, config.picks);
      assert.equal(new Set(numbers).size, config.picks);
      assert.ok(numbers.every((number) => number >= 1 && number <= config.maxNumber));
    }
    if (gameType === "power") {
      const special = first.record.prediction.special_combinations;
      assert.deepEqual(Object.keys(special), ["證據主攻", "覆蓋保底"]);
      assert.notEqual(special["證據主攻"][0], special["覆蓋保底"][0]);
    } else {
      assert.equal(Object.hasOwn(first.record.prediction, "special_combinations"), false);
    }
  }
});

test("shadow forecasts remain separate from the formal approved ensemble", async () => {
  const result = await generateEvidencePrediction(approvedInput());
  const shadow = result.forecasts.find((forecast) => forecast.name === "transition-regularized");
  const ensemble = result.forecasts.find((forecast) => forecast.name === "evidence-ensemble");

  assert.equal(shadow.forecast_mode, "shadow");
  assert.equal(shadow.active_weight, 0);
  assert.equal(ensemble.forecast_mode, "production");
  assert.deepEqual(ensemble.final_groups.combinations, result.record.prediction.combinations);
  assert.deepEqual(ensemble.probabilities, result.evidenceSnapshot.main_probabilities);
});
