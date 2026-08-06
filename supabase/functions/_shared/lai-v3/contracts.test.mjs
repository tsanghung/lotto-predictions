import test from "node:test";
import assert from "node:assert/strict";

import {
  V3_GATE_CONFIG,
  V3_MODEL_FAMILIES,
  V3_STAGES,
  assertForecastCutoff,
  assertProbabilityVector,
} from "./contracts.js";

test("v3 model families and stages expose the approved registry vocabulary", () => {
  assert.deepEqual(V3_MODEL_FAMILIES, [
    "uniform-null",
    "bayesian-drift",
    "transition-regularized",
    "sequence-challenger",
  ]);
  assert.deepEqual(V3_STAGES, [
    "baseline",
    "registered",
    "historical_passed",
    "shadow_verified",
    "canary",
    "champion",
    "cooldown",
    "disabled",
    "rejected",
  ]);
});

test("gate constants preserve approved sample boundaries", () => {
  assert.deepEqual(V3_GATE_CONFIG, {
    qMax: 0.05,
    confidence: 0.95,
    shadowLiveDraws: 30,
    canaryLiveDraws: 20,
    canaryWeightMax: 0.10,
    rollingDemotionWindow: 30,
    bootstrapIterations: 2000,
    permutationIterations: 5000,
  });
});

test("probability vectors require a bounded finite vector with the configured pick sum", () => {
  assert.doesNotThrow(() => assertProbabilityVector([0.2, 0.8, 0], { maxNumber: 3, picks: 1 }));
  assert.doesNotThrow(() => assertProbabilityVector([1, 1, 1], { maxNumber: 3, picks: 3 }));
  assert.throws(() => assertProbabilityVector([0.5, 0.5], { maxNumber: 3, picks: 1 }), /length/i);
  assert.throws(() => assertProbabilityVector([0.5, Number.NaN], { maxNumber: 2, picks: 1 }), /finite/i);
  assert.throws(() => assertProbabilityVector([1.1, -0.1], { maxNumber: 2, picks: 1 }), /\[0, 1\]/);
  assert.throws(() => assertProbabilityVector([0.4, 0.4, 0.1], { maxNumber: 3, picks: 1 }), /sum/i);
  assert.throws(() => assertProbabilityVector([0.5, 0.5], { maxNumber: 2, picks: 2.5 }), /picks/i);
  assert.throws(() => assertProbabilityVector([], null), /maxNumber/i);
});

test("forecast cutoff permits only draws strictly before generation", () => {
  const draws = [{ draw_id: "1", draw_date: "2026-08-05", numbers: [1, 2, 3, 4, 5] }];
  assert.doesNotThrow(() => assertForecastCutoff(draws, "2026-08-06T10:00:00+08:00"));
  assert.throws(
    () => assertForecastCutoff([{ ...draws[0], draw_date: "2026-08-07" }], "2026-08-06T10:00:00+08:00"),
    /data cutoff/i,
  );
  assert.throws(
    () => assertForecastCutoff([{ ...draws[0], draw_date: "2026-08-06T10:00:00+08:00" }], "2026-08-06T10:00:00+08:00"),
    /data cutoff/i,
  );
  assert.throws(() => assertForecastCutoff([{ draw_date: "not-a-date" }], "2026-08-06T10:00:00+08:00"), /date/i);
  assert.throws(() => assertForecastCutoff([{ draw_date: "2026-02-30" }], "2026-08-06T10:00:00+08:00"), /date/i);
  assert.throws(() => assertForecastCutoff(draws, "not-a-date"), /generatedAt/i);
  assert.throws(() => assertForecastCutoff(draws, "2026-02-30T10:00:00+08:00"), /generatedAt/i);
});

test("forecast cutoff parses date-only strings as UTC midnight and offsets as equivalent instants", () => {
  assert.throws(
    () => assertForecastCutoff([{ draw_date: "2026-08-06" }], "2026-08-06T00:00:00Z"),
    /data cutoff/i,
  );
  assert.doesNotThrow(() => assertForecastCutoff([{ draw_date: "2026-08-05" }], "2026-08-06"));
  assert.throws(
    () => assertForecastCutoff([{ draw_date: "2026-08-06T08:00:00+08:00" }], "2026-08-06T00:00:00Z"),
    /data cutoff/i,
  );
  assert.doesNotThrow(() => assertForecastCutoff(
    [{ draw_date: "2026-08-06T07:59:59+08:00" }],
    "2026-08-06T00:00:00Z",
  ));
});

test("forecast cutoff rejects timezone-less date-times instead of using host local time", () => {
  const validDraws = [{ draw_date: "2026-08-05" }];
  assert.throws(() => assertForecastCutoff(validDraws, "2026-08-06T00:00:00"), /generatedAt/i);
  assert.throws(
    () => assertForecastCutoff([{ draw_date: "2026-08-05T00:00:00" }], "2026-08-06T00:00:00Z"),
    /draw_date/i,
  );
});
