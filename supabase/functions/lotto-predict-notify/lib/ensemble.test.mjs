import test from "node:test";
import assert from "node:assert/strict";

import {
  aggregateForecasts,
  updateHedgeWeights,
} from "./ensemble.js";

const DAILY_CONFIG = { maxNumber: 4, picks: 2 };
const POWER_CONFIG = {
  maxNumber: 4,
  picks: 2,
  secondaryNumber: { maxNumber: 3, picks: 1 },
};

function forecast(name, probabilities, specialProbabilities = null) {
  return { name, probabilities, specialProbabilities };
}

test("lower-loss expert gains relative weight without removing baseline", () => {
  const next = updateHedgeWeights({
    weights: { uniform: 0.5, frequency: 0.5 },
    losses: { uniform: 0.12, frequency: 0.08 },
    sampleCount: 20,
    baselineName: "uniform",
    gamma: 0.1,
  });

  assert.ok(next.frequency > next.uniform);
  assert.ok(next.uniform > 0);
  assert.equal(Number(Object.values(next).reduce((a, b) => a + b, 0).toFixed(10)), 1);
});

test("hedge ignores missing, non-finite, and negative weights or losses", () => {
  const next = updateHedgeWeights({
    weights: { uniform: 0.5, missingLoss: 0.5, nanWeight: Number.NaN, negativeWeight: -1, nanLoss: 1, badLoss: 1 },
    losses: { uniform: 0.2, nanWeight: 0.1, negativeWeight: 0.1, nanLoss: Number.NaN, badLoss: -0.1 },
    sampleCount: 10,
    baselineName: "uniform",
  });

  assert.deepEqual(Object.keys(next), ["uniform"]);
  assert.deepEqual(next, { uniform: 1 });
});

test("hedge normalizes finite weights for zero, negative, and non-finite sample counts", () => {
  for (const sampleCount of [0, -10, Number.NaN, Number.POSITIVE_INFINITY]) {
    const next = updateHedgeWeights({
      weights: { uniform: 0.5, frequency: 0.5 },
      losses: { uniform: 1, frequency: 0 },
      sampleCount,
      baselineName: "uniform",
      gamma: 0,
    });

    assert.ok(next.frequency > next.uniform);
    assert.equal(Number(Object.values(next).reduce((sum, value) => sum + value, 0).toFixed(10)), 1);
  }
});

test("hedge remains finite and normalized when every exponent underflows", () => {
  const next = updateHedgeWeights({
    weights: { uniform: 0.5, frequency: 0.5 },
    losses: { uniform: 1e308, frequency: 1e308 },
    sampleCount: 1,
    baselineName: "uniform",
    gamma: 0.1,
  });

  assert.ok(Object.values(next).every(Number.isFinite));
  assert.equal(Number(Object.values(next).reduce((sum, value) => sum + value, 0).toFixed(10)), 1);
  assert.deepEqual(next, { uniform: 0.5, frequency: 0.5 });
});

test("aggregateForecasts renormalizes surviving main-area weights before Task 2 projection", () => {
  const result = aggregateForecasts({
    forecasts: [
      forecast("uniform", [1, 1, 0, 0]),
      forecast("unavailable", [1, 2]),
    ],
    weights: { uniform: 0.25, unavailable: 0.75 },
    config: DAILY_CONFIG,
  });

  assert.deepEqual(result.probabilities, [1, 1, 0, 0]);
  assert.deepEqual(result.expertWeights, { uniform: 1 });
  assert.equal(Number(result.probabilities.reduce((sum, value) => sum + value, 0).toFixed(10)), 2);
});

test("aggregateForecasts handles a single surviving expert without dilution", () => {
  const result = aggregateForecasts({
    forecasts: [
      forecast("uniform", [0, 0, 3, 1]),
      forecast("missing", null),
    ],
    weights: { uniform: 1, missing: 99 },
    config: DAILY_CONFIG,
  });

  assert.deepEqual(result.expertWeights, { uniform: 1 });
  assert.equal(Number(result.probabilities.reduce((sum, value) => sum + value, 0).toFixed(10)), 2);
  assert.ok(result.probabilities[2] > result.probabilities[0]);
});

test("aggregateForecasts accepts the active state's expert weights", () => {
  const result = aggregateForecasts({
    forecasts: [forecast("uniform", [1, 1, 0, 0])],
    activeState: { expert_weights: { uniform: 1 } },
    config: DAILY_CONFIG,
  });

  assert.deepEqual(result.expertWeights, { uniform: 1 });
  assert.deepEqual(result.probabilities, [1, 1, 0, 0]);
});

test("aggregateForecasts projects main and Power special areas independently", () => {
  const result = aggregateForecasts({
    forecasts: [
      forecast("uniform", [1, 1, 0, 0], [1, 0, 0]),
      forecast("frequency", [0, 0, 1, 1], null),
      forecast("invalidSpecial", [0, 0, 1, 1], [1, 1]),
    ],
    weights: { uniform: 1, frequency: 1, invalidSpecial: 10 },
    config: POWER_CONFIG,
  });

  assert.equal(Number(result.probabilities.reduce((sum, value) => sum + value, 0).toFixed(10)), 2);
  assert.equal(Number(result.specialProbabilities.reduce((sum, value) => sum + value, 0).toFixed(10)), 1);
  assert.deepEqual(result.specialProbabilities, [1, 0, 0]);
  assert.deepEqual(result.specialExpertWeights, { uniform: 1 });
});

test("aggregateForecasts rejects a configuration with no surviving main expert", () => {
  assert.throws(() => aggregateForecasts({
    forecasts: [forecast("wrongLength", [1, 1])],
    weights: { wrongLength: 1 },
    config: DAILY_CONFIG,
  }), /available main-area experts/);
});
