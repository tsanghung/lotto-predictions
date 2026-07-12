import test from "node:test";
import assert from "node:assert/strict";

import { optimizePowerGroups, optimizeTwoGroups } from "./optimizer.js";

const DAILY_CONFIG = { maxNumber: 39, picks: 5 };
const POWER_MAIN_CONFIG = { maxNumber: 38, picks: 6 };
const POWER_SPECIAL_CONFIG = { maxNumber: 8, picks: 1 };

function assertSortedUniqueGroup(group, { picks, maxNumber }) {
  assert.equal(group.length, picks);
  assert.equal(new Set(group).size, picks);
  assert.deepEqual(group, [...group].sort((a, b) => a - b));
  assert.ok(group.every((number) => Number.isInteger(number) && number >= 1 && number <= maxNumber));
}

test("Daily539 emits two legal and different groups", () => {
  const result = optimizeTwoGroups({
    probabilities: Array.from({ length: 39 }, (_, index) => 39 - index),
    config: DAILY_CONFIG,
    seed: "今彩539|2026-07-10|lai-v2",
  });

  assertSortedUniqueGroup(result.groupA, DAILY_CONFIG);
  assertSortedUniqueGroup(result.groupB, DAILY_CONFIG);
  assert.notDeepEqual(result.groupA, result.groupB);
  assert.ok(result.metrics.union_size >= DAILY_CONFIG.picks);
});

test("optimizer is deterministic for the same seed", () => {
  const input = {
    probabilities: Array.from({ length: 39 }, (_, index) => (index % 7) + 1),
    config: DAILY_CONFIG,
    seed: "deterministic-seed",
  };

  const first = optimizeTwoGroups(input);
  const second = optimizeTwoGroups(input);

  assert.deepEqual(second, first);
});

test("equal-score inputs use a spread baseline instead of front-loading the range", () => {
  const result = optimizeTwoGroups({
    probabilities: Array(39).fill(1),
    config: DAILY_CONFIG,
    seed: "uniform-baseline",
  });

  assert.ok(
    Math.max(...result.groupA) - Math.min(...result.groupA) >= 20,
    `expected spread group A, got ${result.groupA.join(",")}`,
  );
  assert.ok(
    Math.max(...result.groupB) - Math.min(...result.groupB) >= 20,
    `expected spread group B, got ${result.groupB.join(",")}`,
  );
});

test("coverage group beats copying group A on incremental coverage", () => {
  const result = optimizeTwoGroups({
    probabilities: [0.99, 0.97, 0.95, 0.93, 0.91, 0.9, 0.89, ...Array(32).fill(0.01)],
    config: DAILY_CONFIG,
    seed: "coverage-fixed",
  });

  const copiedUnion = new Set(result.groupA).size;
  assert.ok(result.metrics.union_size >= copiedUnion);
  assert.ok(result.metrics.union_size >= copiedUnion + 1);
});

test("extreme concentration still swaps safely to avoid a duplicated group", () => {
  const result = optimizeTwoGroups({
    probabilities: [1, 0.99, 0.98, 0.97, 0.96, ...Array(34).fill(0)],
    config: DAILY_CONFIG,
    seed: "extreme-concentration",
  });

  assertSortedUniqueGroup(result.groupA, DAILY_CONFIG);
  assertSortedUniqueGroup(result.groupB, DAILY_CONFIG);
  assert.notDeepEqual(result.groupA, result.groupB);
});

test("Power Lottery returns independent first-area and second-area groups", () => {
  const result = optimizePowerGroups({
    mainProbabilities: Array.from({ length: 38 }, (_, index) => 38 - index),
    specialProbabilities: [0.9, 0.85, 0.8, 0.75, 0.7, 0.3, 0.2, 0.1],
    config: {
      maxNumber: POWER_MAIN_CONFIG.maxNumber,
      picks: POWER_MAIN_CONFIG.picks,
      secondaryNumber: POWER_SPECIAL_CONFIG,
    },
    seed: "power|2026-07-10|lai-v2",
  });

  assertSortedUniqueGroup(result.groupA, POWER_MAIN_CONFIG);
  assertSortedUniqueGroup(result.groupB, POWER_MAIN_CONFIG);
  assert.notDeepEqual(result.groupA, result.groupB);
  assertSortedUniqueGroup(result.specialGroupA, POWER_SPECIAL_CONFIG);
  assertSortedUniqueGroup(result.specialGroupB, POWER_SPECIAL_CONFIG);
  assert.notDeepEqual(result.specialGroupA, result.specialGroupB);
});
