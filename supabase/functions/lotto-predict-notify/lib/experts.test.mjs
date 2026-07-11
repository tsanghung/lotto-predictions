import test from "node:test";
import assert from "node:assert/strict";

import { buildExpertForecasts, EXPERT_VERSIONS } from "./experts.js";
import { GAME_CONFIG } from "./predictCore.js";

const NOW = "2026-06-12T10:00:00+08:00";

const fixtures = {
  "539": [
    { draw_id: "539-1", draw_date: "2026-06-06", numbers: [1, 7, 13, 25, 39] },
    { draw_id: "539-2", draw_date: "2026-06-08", numbers: [2, 7, 14, 26, 38] },
    { draw_id: "539-3", draw_date: "2026-06-09", numbers: [3, 8, 15, 27, 37] },
    { draw_id: "539-4", draw_date: "2026-06-10", numbers: [4, 9, 16, 28, 36] },
    { draw_id: "539-5", draw_date: "2026-06-11", numbers: [5, 10, 17, 29, 35] },
  ],
  "649": [
    { draw_id: "649-1", draw_date: "2026-05-26", numbers: [1, 8, 17, 26, 35, 44] },
    { draw_id: "649-2", draw_date: "2026-05-29", numbers: [2, 9, 18, 27, 36, 45] },
    { draw_id: "649-3", draw_date: "2026-06-02", numbers: [3, 10, 19, 28, 37, 46] },
    { draw_id: "649-4", draw_date: "2026-06-05", numbers: [4, 11, 20, 29, 38, 47] },
    { draw_id: "649-5", draw_date: "2026-06-09", numbers: [5, 12, 21, 30, 39, 48] },
  ],
  power: [
    { draw_id: "power-1", draw_date: "2026-05-25", numbers: [1, 7, 13, 19, 25, 31], special_number: 1 },
    { draw_id: "power-2", draw_date: "2026-05-28", numbers: [2, 8, 14, 20, 26, 32], special_number: 2 },
    { draw_id: "power-3", draw_date: "2026-06-01", numbers: [3, 9, 15, 21, 27, 33], special_number: 3 },
    { draw_id: "power-4", draw_date: "2026-06-04", numbers: [4, 10, 16, 22, 28, 34], special_number: 4 },
    { draw_id: "power-5", draw_date: "2026-06-08", numbers: [5, 11, 17, 23, 29, 35], special_number: 5 },
  ],
};

function assertLegalVector(probabilities, maxNumber, picks) {
  assert.equal(probabilities.length, maxNumber);
  assert.ok(probabilities.every((value) => Number.isFinite(value) && value >= 0 && value <= 1));
  assert.equal(Number(probabilities.reduce((sum, value) => sum + value, 0).toFixed(8)), picks);
}

for (const gameType of ["539", "649", "power"]) {
  test(`${gameType} experts emit legal probability vectors and stable metadata`, () => {
    const forecasts = buildExpertForecasts({ gameType, draws: fixtures[gameType], generatedAt: NOW });
    const config = GAME_CONFIG[gameType];

    assert.ok(forecasts.some((forecast) => forecast.name === "uniform"));
    assert.deepEqual(
      forecasts.map(({ name, version }) => [name, version]),
      Object.entries(EXPERT_VERSIONS),
    );
    for (const forecast of forecasts) {
      assertLegalVector(forecast.probabilities, config.maxNumber, config.picks);
      assert.equal(typeof forecast.featureSummary, "object");
      assert.doesNotThrow(() => JSON.stringify(forecast));
    }
  });
}

test("the same history prefix replays deterministically while a new known draw changes forecasts", () => {
  const prefix = fixtures["539"].slice(0, 4);
  const before = buildExpertForecasts({ gameType: "539", draws: prefix, generatedAt: NOW });
  const after = buildExpertForecasts({ gameType: "539", draws: fixtures["539"], generatedAt: NOW });
  const replay = buildExpertForecasts({ gameType: "539", draws: prefix, generatedAt: NOW });

  assert.deepEqual(replay, before);
  assert.notDeepEqual(after, before);
});

test("draws after the target date cannot leak into an earlier forecast", () => {
  const known = fixtures["539"].slice(0, 4);
  const futureDraw = { draw_id: "539-future", draw_date: "2026-06-13", numbers: [6, 11, 18, 30, 34] };

  assert.deepEqual(
    buildExpertForecasts({ gameType: "539", draws: [...known, futureDraw], generatedAt: NOW }),
    buildExpertForecasts({ gameType: "539", draws: known, generatedAt: NOW }),
  );
});

test("Power Lottery always includes a legal uniform second-area forecast", () => {
  const forecasts = buildExpertForecasts({ gameType: "power", draws: fixtures.power, generatedAt: NOW });
  const uniform = forecasts.find((forecast) => forecast.name === "uniform");

  assert.ok(uniform);
  assertLegalVector(uniform.specialProbabilities, 8, 1);
  for (const forecast of forecasts) {
    assert.ok(forecast.specialProbabilities === null || Array.isArray(forecast.specialProbabilities));
    if (forecast.specialProbabilities) {
      assertLegalVector(forecast.specialProbabilities, 8, 1);
    }
  }
});

for (const draws of [[], fixtures["539"].slice(0, 1), fixtures["539"].slice(0, 2)]) {
  test(`empty or short history (${draws.length}) still emits deterministic legal forecasts`, () => {
    const first = buildExpertForecasts({ gameType: "539", draws, generatedAt: NOW });
    const second = buildExpertForecasts({ gameType: "539", draws, generatedAt: NOW });

    assert.deepEqual(second, first);
    assert.equal(first.length, Object.keys(EXPERT_VERSIONS).length);
    for (const forecast of first) {
      assertLegalVector(forecast.probabilities, 39, 5);
    }
  });
}
