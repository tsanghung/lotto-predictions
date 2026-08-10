import test from "node:test";
import assert from "node:assert/strict";

import { GAME_CONFIG } from "./gameConfig.js";
import {
  optimizeEvidenceGroups,
  optimizeEvidencePowerGroups,
} from "./evidenceOptimizer.js";
import { normalizeProbabilityVector } from "./scoring.js";

const descending539 = Array.from({ length: 39 }, (_, index) => 39 - index);
const descendingTotal = descending539.reduce((sum, value) => sum + value, 0);
const calibrated539 = normalizeProbabilityVector(
  descending539.map((value) => value * 5 / descendingTotal),
  39,
  5,
);
const concentrated539 = normalizeProbabilityVector(descending539, 39, 5);
const uniformInput = {
  probabilities: Array(39).fill(5 / 39),
  config: GAME_CONFIG["539"],
  seed: "uniform-539",
  minUtilityRatio: 0.90,
  maxOverlap: 1,
};
const powerInput = {
  mainProbabilities: Array(38).fill(6 / 38),
  specialProbabilities: normalizeProbabilityVector([8, 7, 6, 5, 4, 3, 2, 1], 8, 1),
  config: GAME_CONFIG.power,
  seed: "power-proof",
};

test("coverage group meets utility and overlap constraints", () => {
  const result = optimizeEvidenceGroups({
    probabilities: calibrated539,
    config: GAME_CONFIG["539"],
    seed: "539|2026-08-06|state-1",
    minUtilityRatio: 0.90,
    maxOverlap: 1,
  });

  assert.equal(result.evidenceAttack.length, 5);
  assert.equal(result.coverageFallback.length, 5);
  assert.ok(result.metrics.overlapCount <= 1);
  assert.ok(result.metrics.coverageUtility >= result.metrics.attackUtility * 0.90);
});

test("uniform baseline produces deterministic disjoint groups", () => {
  const first = optimizeEvidenceGroups(uniformInput);
  const replay = optimizeEvidenceGroups(uniformInput);

  assert.deepEqual(replay, first);
  assert.equal(first.metrics.overlapCount, 0);
});

test("Power second areas are independent and distinct", () => {
  const result = optimizeEvidencePowerGroups(powerInput);

  assert.equal(result.specialEvidenceAttack.length, 1);
  assert.equal(result.specialCoverageFallback.length, 1);
  assert.notEqual(result.specialEvidenceAttack[0], result.specialCoverageFallback[0]);
});

test("infeasible utility and overlap constraints fail closed", () => {
  assert.throws(() => optimizeEvidenceGroups({
    probabilities: concentrated539,
    config: GAME_CONFIG["539"],
    seed: "infeasible-539",
    minUtilityRatio: 1,
    maxOverlap: 0,
  }), /coverage_constraints_infeasible/);
});
