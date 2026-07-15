import test from "node:test";
import assert from "node:assert/strict";

import {
  brierScore,
  brierSkillScore,
  coverageMetrics,
  logLoss,
  normalizeProbabilityVector,
} from "./scoring.js";

test("normalizes a probability vector to the game pick count", () => {
  const p = normalizeProbabilityVector([1, 1, 2, 0], 4, 2);

  assert.equal(Number(p.reduce((a, b) => a + b, 0).toFixed(10)), 2);
  assert.ok(p.every((value) => value >= 0 && value <= 1));
});

test("projects oversized scores onto the capped simplex", () => {
  const p = normalizeProbabilityVector([10, 0, 0], 3, 2);

  assert.deepEqual(p.map((value) => Number(value.toFixed(12))), [1, 0.5, 0.5]);
});

test("returns the lower and upper capped simplex boundaries", () => {
  assert.deepEqual(normalizeProbabilityVector([4, -1, 2], 3, 0), [0, 0, 0]);
  assert.deepEqual(normalizeProbabilityVector([4, -1, 2], 3, 3), [1, 1, 1]);
});

test("preserves the pick sum when probabilities are near the caps", () => {
  const p = normalizeProbabilityVector(
    [0.5 - 5e-16, 0.5 - 5e-16, 5e-16, 5e-16],
    4,
    1,
  );

  assert.equal(p.reduce((sum, probability) => sum + probability, 0), 1);
  assert.ok(p.every((probability) => probability >= 0 && probability <= 1));
});

test("projects large symmetric scores without index bias", () => {
  const p = normalizeProbabilityVector([1e100, 1e100], 2, 1);

  assert.deepEqual(p, [0.5, 0.5]);
});

test("rejects malformed normalization inputs", () => {
  assert.throws(() => normalizeProbabilityVector([1, 2], 3, 1), /length/);
  assert.throws(() => normalizeProbabilityVector([1, Number.NaN], 2, 1), /finite/);
  assert.throws(() => normalizeProbabilityVector([1, 2], 2, -1), /picks/);
  assert.throws(() => normalizeProbabilityVector([1, 2], 2, 3), /picks/);
  assert.throws(() => normalizeProbabilityVector([1, 2], 2.5, 1), /maxNumber/);
});

test("uniform forecast has zero Brier skill against itself", () => {
  const uniform = Array(39).fill(5 / 39);
  const actual = [1, 2, 3, 4, 5];
  const bs = brierScore(uniform, actual, 39);

  assert.equal(brierSkillScore(bs, bs), 0);
});

test("calculates Brier score as per-number mean squared error", () => {
  assert.equal(brierScore([1, 0, 0, 0], [1], 4), 0);
  assert.equal(brierScore([0.5, 0.5, 0.5, 0.5], [1, 2], 4), 0.25);
});

test("calculates Log Loss with epsilon for zero and one probabilities", () => {
  const epsilon = 1e-12;
  const score = logLoss([0, 1], [1], 2, epsilon);
  const expected = -(Math.log(epsilon) + Math.log(epsilon)) / 2;

  assert.equal(score, expected);
});

test("supports Power Lottery second-area probability vectors", () => {
  const probabilities = normalizeProbabilityVector([0, 0, 5, 0, 0, 0, 0, 0], 8, 1);

  assert.equal(probabilities.length, 8);
  assert.equal(Number(probabilities.reduce((a, b) => a + b, 0).toFixed(10)), 1);
  assert.equal(brierScore(probabilities, [3], 8), 0);
  assert.ok(logLoss(probabilities, [3], 8) > 0);
  assert.ok(logLoss(probabilities, [3], 8) < 1e-9);
});

test("rejects invalid scoring vectors and actual numbers", () => {
  assert.throws(() => brierScore([1, 0], [1], 3), /length/);
  assert.throws(() => brierScore([1.2, 0], [1], 2), /\[0, 1\]/);
  assert.throws(() => brierScore([1, 0], [3], 2), /actual/);
  assert.throws(() => logLoss([1, 0], [1], 2, 0), /epsilon/);
  assert.throws(() => coverageMetrics(null, [1], [1]), /array/);
});

test("coverage metrics report union hits and overlap", () => {
  const result = coverageMetrics([1, 2, 3], [3, 4, 5], [2, 4, 6]);

  assert.deepEqual(result, {
    group_a_hits: 1,
    group_b_hits: 1,
    union_hits: 2,
    overlap_count: 1,
    union_size: 5,
  });
});

test("coverage metrics deduplicate repeated numbers", () => {
  assert.deepEqual(
    coverageMetrics([1, 1, 2], [2, 2, 3], [1, 2, 3]),
    {
      group_a_hits: 2,
      group_b_hits: 2,
      union_hits: 3,
      overlap_count: 1,
      union_size: 3,
    },
  );
});
