import test from "node:test";
import assert from "node:assert/strict";

import {
  benjaminiHochberg,
  createBaselineState,
  evaluatePromotion,
} from "./agentState.js";

const PASSING_METRICS = {
  recent100Skill: 0.2,
  recent500Skill: 0.2,
  productionSamples: 30,
  bootstrapLower95: 0.1,
  adjustedQ: 0.01,
  unionCoverageDelta: 0.1,
};

test("one lucky draw cannot promote a challenger", () => {
  const result = evaluatePromotion({ ...PASSING_METRICS, productionSamples: 1 });
  assert.deepEqual(result, { promoted: false, reason: "insufficient_production_samples" });
});

test("evaluatePromotion enforces every promotion gate", () => {
  const cases = [
    ["recent_100_not_skillful", { recent100Skill: 0 }],
    ["recent_500_not_skillful", { recent500Skill: 0 }],
    ["confidence_interval_crosses_zero", { bootstrapLower95: 0 }],
    ["multiple_test_threshold_failed", { adjustedQ: 0.051 }],
    ["coverage_regression", { unionCoverageDelta: -0.001 }],
  ];

  for (const [reason, override] of cases) {
    assert.deepEqual(evaluatePromotion({ ...PASSING_METRICS, ...override }), {
      promoted: false,
      reason,
    });
  }
  assert.deepEqual(evaluatePromotion(PASSING_METRICS), {
    promoted: true,
    reason: "all_gates_passed",
  });
});

test("benjaminiHochberg sorts p-values but maps adjusted q-values back to original order", () => {
  assert.deepEqual(benjaminiHochberg([0.04, 0.01, 0.03]), [0.04, 0.03, 0.04]);
  assert.deepEqual(benjaminiHochberg([0.5, 0.5, 0.01]), [0.5, 0.5, 0.03]);
});

test("benjaminiHochberg rejects missing, non-finite, and out-of-range p-values", () => {
  assert.throws(() => benjaminiHochberg(), /array/);
  assert.throws(() => benjaminiHochberg([0.1, Number.NaN]), /finite/);
  assert.throws(() => benjaminiHochberg([-0.1]), /\[0, 1\]/);
});

test("baseline state keeps uniform as Champion and does not share mutable input state", () => {
  const learningConfig = { gamma: 0.1, windows: [100, 500] };
  const baseline = createBaselineState({
    gameName: "今彩539",
    expertNames: ["frequency", "uniform", "frequency"],
    learningConfig,
  });
  baseline.learning_config.windows.push(1000);
  baseline.expert_weights.uniform = 0;

  const another = createBaselineState({
    gameName: "今彩539",
    expertNames: ["frequency", "uniform", "frequency"],
    learningConfig,
  });

  assert.equal(baseline.status, "baseline");
  assert.equal(baseline.champion_model, "uniform");
  assert.equal(another.expert_weights.uniform, 0.5);
  assert.deepEqual(another.learning_config, { gamma: 0.1, windows: [100, 500] });
  assert.deepEqual(evaluatePromotion({ ...PASSING_METRICS, productionSamples: 29 }), {
    promoted: false,
    reason: "insufficient_production_samples",
  });
});
