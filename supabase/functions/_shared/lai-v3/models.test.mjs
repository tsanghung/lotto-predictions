import test from "node:test";
import assert from "node:assert/strict";

import { assertProbabilityVector } from "./contracts.js";
import { buildEvidenceForecasts } from "./models.js";
import { GAME_CONFIG } from "../../lotto-predict-notify/lib/gameConfig.js";

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

test("every non-uniform family remains shadow-only with zero production weight", () => {
  for (const family of ["bayesian-drift", "transition-regularized", "sequence-challenger"]) {
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
  assert.throws(() => buildEvidenceForecasts({
    gameType: "539",
    draws: fixtures["539"],
    generatedAt: NOW,
    registrations: [{
      ...registration("539", "uniform-null"),
      parameters: { random_seed: "  " },
    }],
  }), /seed/i);
});
