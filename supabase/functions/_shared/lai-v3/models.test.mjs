import test from "node:test";
import assert from "node:assert/strict";

import { assertProbabilityVector } from "./contracts.js";
import { buildEvidenceForecasts } from "./models.js";
import { GAME_CONFIG } from "../../lotto-predict-notify/lib/gameConfig.js";
import { ML_WEIGHTS } from "../../lotto-predict-notify/lib/mlWeights.js";

const NOW = "2026-08-06T10:00:00+08:00";
const fixtures = {
  "539": [
    { draw_id: "1", draw_date: "2026-08-01", numbers: [1, 2, 3, 4, 5] },
    { draw_id: "2", draw_date: "2026-08-03", numbers: [6, 7, 8, 9, 10] },
    { draw_id: "3", draw_date: "2026-08-05", numbers: [11, 12, 13, 14, 15] },
  ],
  "649": [
    { draw_id: "1", draw_date: "2026-07-28", numbers: [1, 8, 16, 24, 32, 40] },
    { draw_id: "2", draw_date: "2026-07-31", numbers: [2, 9, 17, 25, 33, 41] },
    { draw_id: "3", draw_date: "2026-08-04", numbers: [3, 10, 18, 26, 34, 42] },
  ],
  power: [
    { draw_id: "1", draw_date: "2026-07-27", numbers: [1, 7, 13, 19, 25, 31], special_number: 1 },
    { draw_id: "2", draw_date: "2026-07-30", numbers: [2, 8, 14, 20, 26, 32], special_number: 2 },
    { draw_id: "3", draw_date: "2026-08-03", numbers: [3, 9, 15, 21, 27, 33], special_number: 3 },
  ],
};

const registration = (gameType, family) => ({
  id: `${gameType}-${family}`,
  game_name: GAME_CONFIG[gameType].name,
  model_name: family,
  model_family: family,
  model_version: `${family}-v1`,
  feature_version: `${family}-features-v1`,
  parameters: family === "bayesian-drift"
    ? { halfLifeDraws: 100, priorStrength: 100, random_seed: `${gameType}-${family}` }
    : family === "transition-regularized"
      ? { minimumSupport: 30, effectCap: 0.25, random_seed: `${gameType}-${family}` }
      : { random_seed: `${gameType}-${family}` },
  code_commit: "0123456789abcdef0123456789abcdef01234567",
  status: family === "uniform-null" ? "baseline" : "registered",
});

const registrations = ["539", "649", "power"].flatMap((gameType) => [
  registration(gameType, "uniform-null"),
  registration(gameType, "bayesian-drift"),
  registration(gameType, "transition-regularized"),
]);

function sequenceRegistration(gameType = "539") {
  return {
    ...registration(gameType, "sequence-challenger"),
    parameters: {
      random_seed: `${gameType}-sequence`,
      minimumHistory: 30,
      calibration: {
        method: "isotonic",
        status: "shadow-pending",
        version: "sequence-calibration-v1",
      },
    },
  };
}

function sequenceHistory() {
  return Array.from({ length: 30 }, (_, index) => ({
    draw_id: `sequence-${index + 1}`,
    draw_date: `2026-07-${String(index + 1).padStart(2, "0")}`,
    numbers: [
      (index % 35) + 1,
      ((index + 7) % 35) + 1,
      ((index + 14) % 35) + 1,
      ((index + 21) % 35) + 1,
      ((index + 28) % 35) + 1,
    ],
  }));
}

for (const gameType of ["539", "649", "power"]) {
  test(`${gameType} v3 forecasts are legal and replayable`, () => {
    const first = buildEvidenceForecasts({ gameType, draws: fixtures[gameType], generatedAt: NOW, registrations });
    const replay = buildEvidenceForecasts({ gameType, draws: fixtures[gameType], generatedAt: NOW, registrations });

    assert.deepEqual(replay, first);
    assert.deepEqual(first.map((forecast) => forecast.family), [
      "uniform-null",
      "bayesian-drift",
      "transition-regularized",
    ]);
    for (const forecast of first) {
      assertProbabilityVector(forecast.probabilities, GAME_CONFIG[gameType]);
      if (gameType === "power") {
        assertProbabilityVector(forecast.specialProbabilities, GAME_CONFIG.power.secondaryNumber);
      }
    }
  });
}

test("future draw never changes an earlier forecast", () => {
  const prefix = fixtures["539"].slice(0, -1);
  const before = buildEvidenceForecasts({ gameType: "539", draws: prefix, generatedAt: NOW, registrations });

  assert.deepEqual(
    buildEvidenceForecasts({ gameType: "539", draws: structuredClone(prefix), generatedAt: NOW, registrations }),
    before,
  );
  assert.throws(() => buildEvidenceForecasts({
    gameType: "539",
    draws: [...prefix, { draw_id: "future", draw_date: "2026-08-07", numbers: [1, 6, 11, 16, 21] }],
    generatedAt: NOW,
    registrations,
  }), /data cutoff/i);
});

test("sequence challenger cannot be requested as production", () => {
  assert.throws(() => buildEvidenceForecasts({
    gameType: "539",
    draws: fixtures["539"],
    generatedAt: NOW,
    registrations: [{
      ...registration("539", "sequence-challenger"),
      parameters: { shadowOnly: true, random_seed: "sequence" },
    }],
    mode: "production",
  }), /shadow only/i);
});

test("every non-sequence challenger remains shadow-only with zero production weight", () => {
  for (const family of ["bayesian-drift", "transition-regularized"]) {
    const [forecast] = buildEvidenceForecasts({
      gameType: "539",
      draws: fixtures["539"],
      generatedAt: NOW,
      registrations: [registration("539", family)],
    });

    assert.equal(forecast.featureSummary.shadowOnly, true);
    assert.equal(forecast.featureSummary.productionWeight, 0);
    assert.throws(() => buildEvidenceForecasts({
      gameType: "539",
      draws: fixtures["539"],
      generatedAt: NOW,
      registrations: [registration("539", family)],
      mode: "production",
    }), /shadow only/i);
  }
});

test("sequence challenger emits calibrated shadow-only evidence only with valid weights and history", () => {
  const [result] = buildEvidenceForecasts({
    gameType: "539",
    draws: sequenceHistory(),
    generatedAt: NOW,
    registrations: [sequenceRegistration()],
  });

  assert.equal(result.status, "completed");
  assertProbabilityVector(result.probabilities, GAME_CONFIG["539"]);
  assert.deepEqual(result.featureSummary.calibration, {
    method: "isotonic",
    status: "shadow-pending",
    version: "sequence-calibration-v1",
  });
  assert.equal(result.featureSummary.shadowOnly, true);
  assert.equal(result.featureSummary.productionWeight, 0);
});

test("sequence failures return failed results without probabilities", () => {
  const cases = [
    {
      name: "short-history",
      draws: fixtures["539"],
      row: sequenceRegistration(),
      reason: /minimum history/i,
    },
    {
      name: "missing-calibration",
      draws: sequenceHistory(),
      row: { ...sequenceRegistration(), parameters: { random_seed: "missing-calibration", minimumHistory: 30 } },
      reason: /calibration/i,
    },
  ];

  for (const scenario of cases) {
    const [result] = buildEvidenceForecasts({
      gameType: "539",
      draws: scenario.draws,
      generatedAt: NOW,
      registrations: [scenario.row],
    });
    assert.equal(result.status, "failed", scenario.name);
    assert.match(result.failureReason, scenario.reason, scenario.name);
    assert.equal("probabilities" in result, false, scenario.name);
    assert.equal("specialProbabilities" in result, false, scenario.name);
  }
});

test("invalid static LSTM weights return failed sequence evidence without a uniform substitute", () => {
  const original = ML_WEIGHTS["539"];
  try {
    ML_WEIGHTS["539"] = { N: 39, H: 1 };
    const [result] = buildEvidenceForecasts({
      gameType: "539",
      draws: sequenceHistory(),
      generatedAt: NOW,
      registrations: [sequenceRegistration()],
    });
    assert.equal(result.status, "failed");
    assert.match(result.failureReason, /lstm weights/i);
    assert.equal("probabilities" in result, false);
  } finally {
    ML_WEIGHTS["539"] = original;
  }
});

test("Power sequence special area is explicit independent non-sequence policy", () => {
  const powerHistory = sequenceHistory().map((draw, index) => ({
    ...draw,
    numbers: [
      (index % 38) + 1,
      ((index + 6) % 38) + 1,
      ((index + 12) % 38) + 1,
      ((index + 18) % 38) + 1,
      ((index + 24) % 38) + 1,
      ((index + 30) % 38) + 1,
    ],
    special_number: (index % 8) + 1,
  }));
  const [result] = buildEvidenceForecasts({
    gameType: "power",
    draws: powerHistory,
    generatedAt: NOW,
    registrations: [sequenceRegistration("power")],
  });

  assert.equal(result.status, "completed");
  assert.equal(result.featureSummary.specialArea.policy, "independent-uniform-no-sequence-weights");
  assertProbabilityVector(result.specialProbabilities, GAME_CONFIG.power.secondaryNumber);
});

test("builder does not mutate caller history or registry parameters", () => {
  const draws = structuredClone(fixtures.power);
  const rows = [
    registration("power", "uniform-null"),
    registration("power", "bayesian-drift"),
    registration("power", "transition-regularized"),
  ];
  const before = structuredClone({ draws, rows });

  buildEvidenceForecasts({ gameType: "power", draws, generatedAt: NOW, registrations: rows });

  assert.deepEqual({ draws, rows }, before);
});

test("invalid historical numbers and seeds fail fast", () => {
  assert.throws(() => buildEvidenceForecasts({
    gameType: "539",
    draws: [{ draw_id: "bad", draw_date: "2026-08-05", numbers: [1, 2, 3, 4, 40] }],
    generatedAt: NOW,
    registrations: [registration("539", "uniform-null")],
  }), /numbers/i);
  const [failed] = buildEvidenceForecasts({
    gameType: "539",
    draws: fixtures["539"],
    generatedAt: NOW,
    registrations: [{
      ...registration("539", "uniform-null"),
      parameters: { random_seed: "  " },
    }],
  });
  assert.equal(failed.status, "failed");
  assert.match(failed.failureReason, /seed/i);
});

test("history rejects duplicate identities and same-date chronology before sorting", () => {
  const history = structuredClone(fixtures["539"]);
  assert.throws(() => buildEvidenceForecasts({
    gameType: "539",
    draws: [...history, { ...history[0], draw_date: "2026-08-04" }],
    generatedAt: NOW,
    registrations: [registration("539", "uniform-null")],
  }), /draw_id/i);
  assert.throws(() => buildEvidenceForecasts({
    gameType: "539",
    draws: [...history, { ...history[0], draw_id: "new-id", draw_date: "2026-08-03" }],
    generatedAt: NOW,
    registrations: [registration("539", "uniform-null")],
  }), /chronology/i);
});

test("invalid registration rows are isolated while valid current-game rows complete", () => {
  const invalid = {
    ...registration("539", "bayesian-drift"),
    id: "invalid-challenger",
    code_commit: "invalid",
  };
  const results = buildEvidenceForecasts({
    gameType: "539",
    draws: fixtures["539"],
    generatedAt: NOW,
    registrations: [
      registration("539", "uniform-null"),
      invalid,
      registration("649", "uniform-null"),
      { ...registration("539", "uniform-null"), id: "unknown-game", game_name: "not-a-known-game" },
    ],
  });

  assert.equal(results.length, 3);
  assert.equal(results[0].status, "completed");
  assert.equal(results[1].status, "failed");
  assert.match(results[1].failureReason, /code_commit/i);
  assert.equal(results[2].status, "failed");
  assert.match(results[2].failureReason, /game_name/i);
});

test("registry status and transition guardrails fail closed per registration", () => {
  const rows = [
    { ...registration("539", "uniform-null"), id: "uniform-status", status: "registered" },
    { ...registration("539", "bayesian-drift"), id: "challenger-status", status: "baseline" },
    {
      ...registration("539", "transition-regularized"),
      id: "support-too-low",
      parameters: { minimumSupport: 29, effectCap: 0.25, random_seed: "support-too-low" },
    },
    {
      ...registration("539", "transition-regularized"),
      id: "cap-too-high",
      parameters: { minimumSupport: 30, effectCap: 0.26, random_seed: "cap-too-high" },
    },
  ];
  const results = buildEvidenceForecasts({
    gameType: "539",
    draws: fixtures["539"],
    generatedAt: NOW,
    registrations: rows,
  });

  assert.deepEqual(results.map((result) => result.status), ["failed", "failed", "failed", "failed"]);
  assert.match(results[0].failureReason, /baseline/i);
  assert.match(results[1].failureReason, /baseline/i);
  assert.match(results[2].failureReason, /minimumSupport/i);
  assert.match(results[3].failureReason, /effectCap/i);
});

test("completed metadata deep-clones nested registration parameters", () => {
  const row = registration("539", "uniform-null");
  row.parameters = { random_seed: "nested", provenance: { revision: 1 } };
  const [result] = buildEvidenceForecasts({
    gameType: "539",
    draws: fixtures["539"],
    generatedAt: NOW,
    registrations: [row],
  });
  result.parameters.provenance.revision = 2;
  assert.equal(row.parameters.provenance.revision, 1);
});
