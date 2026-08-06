import test from "node:test";
import assert from "node:assert/strict";

import {
  benjaminiHochberg,
  expectedCalibrationError,
  mean,
  pairedBlockBootstrap,
  pairedPermutationTest,
  seededRandom,
} from "./statistics.js";

test("mean accepts only non-empty finite samples", () => {
  assert.ok(Math.abs(mean([0.1, 0.2, 0.3]) - 0.2) < 1e-12);
  assert.throws(() => mean([]), /at least one/i);
  assert.throws(() => mean([1, Number.POSITIVE_INFINITY]), /finite/i);
});

test("seeded random produces the same stream for the same explicit seed", () => {
  const first = seededRandom("seed");
  const second = seededRandom("seed");
  assert.deepEqual([first(), first(), first()], [second(), second(), second()]);
});

test("public resampling entry points reject invalid seed domains", () => {
  const invalidSeeds = [Number.NaN, Infinity, -Infinity, {}, [], true, false, null, undefined, "", "   "];
  const input = { deltas: [0.1, 0.2], blockLength: 1, iterations: 2 };
  for (const seed of invalidSeeds) {
    assert.throws(() => seededRandom(seed), /seed/i);
    assert.throws(() => pairedBlockBootstrap({ ...input, seed }), /seed/i);
    assert.throws(() => pairedPermutationTest({ ...input, seed }), /seed/i);
  }
});

test("numeric zero and negative zero canonicalize to the same deterministic seed", () => {
  const zero = seededRandom(0);
  const negativeZero = seededRandom(-0);
  assert.deepEqual([zero(), zero(), zero()], [negativeZero(), negativeZero(), negativeZero()]);
  const input = { deltas: [0.1, 0.2, -0.1, 0.3], blockLength: 2, iterations: 200 };
  assert.deepEqual(pairedBlockBootstrap({ ...input, seed: 0 }), pairedBlockBootstrap({ ...input, seed: -0 }));
  assert.equal(pairedPermutationTest({ ...input, seed: 0 }), pairedPermutationTest({ ...input, seed: -0 }));
});

test("paired bootstrap is deterministic for the same seed", () => {
  const input = { deltas: [0.1, 0.2, -0.1, 0.3], blockLength: 2, iterations: 200, seed: "same" };
  assert.deepEqual(pairedBlockBootstrap(input), pairedBlockBootstrap(input));
});

test("paired resampling rejects malformed samples and iteration settings", () => {
  assert.throws(() => pairedBlockBootstrap({ deltas: [0.1], blockLength: 1, seed: "x" }), /at least 2/i);
  assert.throws(() => pairedBlockBootstrap({ deltas: [0.1, Number.NaN], blockLength: 1, seed: "x" }), /finite/i);
  assert.throws(() => pairedBlockBootstrap({ deltas: [0.1, 0.2], blockLength: 3, seed: "x" }), /blockLength/i);
  assert.throws(() => pairedBlockBootstrap({ deltas: [0.1, 0.2], blockLength: 1, iterations: 0, seed: "x" }), /iterations/i);
  assert.throws(() => pairedPermutationTest({ deltas: [0.1, 0.2], blockLength: 1, iterations: 1.5, seed: "x" }), /iterations/i);
});

test("paired permutation is deterministic for the same seed", () => {
  const input = { deltas: [0.1, 0.2, -0.1, 0.3], blockLength: 2, iterations: 200, seed: "same" };
  assert.equal(pairedPermutationTest(input), pairedPermutationTest(input));
});

test("Benjamini-Hochberg preserves input order", () => {
  assert.deepEqual(benjaminiHochberg([0.01, 0.04, 0.03]), [0.03, 0.04, 0.04]);
  assert.throws(() => benjaminiHochberg([0.1, Number.NaN]), /finite/i);
});

test("ten-bin calibration error treats every draw-number pair as a Bernoulli outcome", () => {
  const observations = [
    { probabilities: [0.1, 0.9], actualNumbers: [2], maxNumber: 2, picks: 1 },
    { probabilities: [0.1, 0.9], actualNumbers: [2], maxNumber: 2, picks: 1 },
  ];
  assert.ok(Math.abs(expectedCalibrationError(observations) - 0.1) < 1e-12);
  assert.equal(expectedCalibrationError([{ probabilities: [0, 1], actualNumbers: [2], maxNumber: 2, picks: 1 }]), 0);
  assert.equal(expectedCalibrationError([]), null);
  assert.throws(() => expectedCalibrationError([{ probabilities: [0.5, 0.5], actualNumbers: [3], maxNumber: 2, picks: 1 }]), /actualNumbers/i);
});

test("ten-bin calibration error accepts flat probability-outcome observations", () => {
  assert.ok(Math.abs(expectedCalibrationError([
    { probability: 0.8, outcome: 1 },
    { probability: 0.8, outcome: 0 },
  ]) - 0.3) < 1e-12);
  assert.throws(() => expectedCalibrationError([
    { probability: Number.NaN, outcome: 1 },
  ]), /finite/i);
  assert.throws(() => expectedCalibrationError([
    { probability: 0.5, outcome: 2 },
  ]), /binary/i);
});
