import test from "node:test";
import assert from "node:assert/strict";

import { GAME_CONFIG } from "../../lotto-predict-notify/lib/gameConfig.js";
import {
  evaluateCandidateSeries,
  matchedRandomCoverage,
  pairCandidateWithBaseline,
  scoreEvidenceForecast,
} from "./evaluation.js";

const candidateRows = [
  { drawId: "101", brier: 0.12 },
  { drawId: "102", brier: 0.10 },
  { drawId: "103", brier: 0.09 },
];
const baselineRows = [
  { drawId: "102", brier: 0.11, family: "uniform-null" },
  { drawId: "103", brier: 0.10, family: "uniform-null" },
  { drawId: "104", brier: 0.13, family: "uniform-null" },
];
const powerForecast = {
  probabilities: Array(38).fill(6 / 38),
  special_probabilities: Array(8).fill(1 / 8),
  final_groups: {
    combinations: { "證據主攻": [1, 2, 3, 4, 5, 6], "覆蓋保底": [7, 8, 9, 10, 11, 12] },
    special_combinations: { "證據主攻": [3], "覆蓋保底": [6] },
  },
};
const powerDraw = {
  draw_id: "p1",
  draw_date: "2026-08-03",
  numbers: [1, 8, 15, 22, 29, 36],
  special_number: 3,
};

test("candidate evidence pairs only identical draw ids", () => {
  const pairs = pairCandidateWithBaseline(candidateRows, baselineRows);
  assert.deepEqual(pairs.map((row) => row.drawId), ["102", "103"]);
});

test("baseline pairing requires an explicit trusted family identity", () => {
  assert.throws(() => pairCandidateWithBaseline(
    [{ drawId: "1", brier: 0.1 }],
    [{ drawId: "1", brier: 0.1 }],
  ), /family identity.*required/i);
});

test("baseline pairing rejects conflicting family aliases", () => {
  assert.throws(() => pairCandidateWithBaseline(
    [{ drawId: "1", brier: 0.1 }],
    [{ drawId: "1", brier: 0.1, family: "uniform-null", model_family: "bayesian-drift" }],
  ), /family aliases.*conflict/i);
});

test("baseline pairing accepts agreeing uniform-null aliases", () => {
  const pairs = pairCandidateWithBaseline(
    [{ drawId: "1", brier: 0.1 }],
    [{
      drawId: "1",
      brier: 0.1,
      family: "uniform-null",
      modelFamily: "uniform-null",
      model_family: "uniform-null",
    }],
  );

  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].baseline.family, "uniform-null");
});

test("matched random baseline preserves group shape and overlap", () => {
  const input = {
    maxNumber: 39,
    picks: 5,
    groupA: [1, 2, 3, 4, 5],
    groupB: [5, 6, 7, 8, 9],
    actualNumbers: [1, 6, 10, 11, 12],
    simulations: 1000,
    seed: "draw-1",
  };
  const result = matchedRandomCoverage(input);

  assert.equal(result.constraints.overlapCount, 1);
  assert.equal(result.constraints.groupCount, 2);
  assert.equal(result.constraints.picks, 5);
  assert.equal(result.samples.length, 1000);
  assert.deepEqual(matchedRandomCoverage(input), result);
});

test("Power matched random baseline preserves second-area structure", () => {
  const result = matchedRandomCoverage({
    maxNumber: 38,
    picks: 6,
    groupA: [1, 2, 3, 4, 5, 6],
    groupB: [6, 7, 8, 9, 10, 11],
    actualNumbers: powerDraw.numbers,
    simulations: 100,
    seed: "power-draw-1",
    specialArea: {
      maxNumber: 8,
      picks: 1,
      groupA: [3],
      groupB: [6],
      actualNumbers: [powerDraw.special_number],
    },
  });

  assert.deepEqual(result.constraints.specialArea, {
    groupCount: 2,
    maxNumber: 8,
    picks: 1,
    overlapCount: 0,
  });
  assert.equal(result.specialSamples.length, 100);
  assert.equal(result.combinedSamples.length, 100);
});

test("Power areas are scored independently before combination", () => {
  const score = scoreEvidenceForecast({ forecast: powerForecast, draw: powerDraw, config: GAME_CONFIG.power });

  assert.ok(Number.isFinite(score.main.brier));
  assert.ok(Number.isFinite(score.special.brier));
  assert.ok(Number.isFinite(score.combined.brier));
  assert.equal(score.special.coverage.unionHits, 1);
  assert.equal(score.main.calibrationObservations.length, 38);
  assert.equal(score.special.calibrationObservations.length, 8);
  assert.deepEqual(score.special.calibrationObservations[2], { probability: 1 / 8, outcome: 1 });
});

test("Power recommendation groups require matching main and second-area structures", () => {
  const malformed = structuredClone(powerForecast);
  delete malformed.final_groups.special_combinations;

  assert.throws(() => scoreEvidenceForecast({
    forecast: malformed,
    draw: powerDraw,
    config: GAME_CONFIG.power,
    seed: "power-structure",
  }), /Power.*structures/i);
});

test("paired evidence uses proper score directions and complete recent windows", () => {
  const candidate = Array.from({ length: 30 }, (_, index) => ({
    drawId: String(index + 1),
    brier: 0.08,
    logLoss: 0.20,
    calibrationObservations: [{ probability: 0.8, outcome: 1 }],
    coverageDelta: 0.1,
  }));
  const baseline = Array.from({ length: 30 }, (_, index) => ({
    drawId: String(index + 1),
    family: "uniform-null",
    brier: 0.10,
    logLoss: 0.25,
    calibrationObservations: [{ probability: 0.7, outcome: 1 }],
  }));

  const evidence = evaluateCandidateSeries({ candidateRows: candidate, baselineRows: baseline, seed: "series" });

  assert.ok(Math.abs(evidence.brierSkill - 0.2) < 1e-12);
  assert.ok(evidence.meanExcessLoss < 0);
  assert.ok(evidence.logLossDelta < 0);
  assert.ok(evidence.calibrationDelta < 0);
  assert.equal(evidence.recent30Skill, evidence.brierSkill);
  assert.equal(evidence.recent100Skill, null);
  assert.equal(evidence.recent500Skill, null);
  assert.ok(evidence.brierCi.lower95 > 0);
});

test("production evaluator defaults remain 2000 bootstrap and 5000 permutation iterations", async () => {
  const evaluation = await import("./evaluation.js");
  assert.deepEqual(evaluation.DEFAULT_EVALUATION_RESAMPLING, {
    bootstrapIterations: 2000,
    permutationIterations: 5000,
  });

  const candidate = Array.from({ length: 30 }, (_, index) => ({
    drawId: String(index + 1),
    brier: 0.08,
    logLoss: 0.20,
    calibrationObservations: [{ probability: 0.8, outcome: 1 }],
    coverageDelta: 0.1,
  }));
  const baseline = Array.from({ length: 30 }, (_, index) => ({
    drawId: String(index + 1),
    family: "uniform-null",
    brier: 0.10,
    logLoss: 0.25,
    calibrationObservations: [{ probability: 0.7, outcome: 1 }],
  }));
  const input = { candidateRows: candidate, baselineRows: baseline, seed: "resampling-defaults" };

  assert.deepEqual(
    evaluateCandidateSeries(input),
    evaluateCandidateSeries({
      ...input,
      resampling: { bootstrapIterations: 2000, permutationIterations: 5000 },
    }),
  );
});

test("production evaluator accepts a deterministic test resampling budget", () => {
  const candidate = Array.from({ length: 30 }, (_, index) => ({
    drawId: String(index + 1),
    brier: index % 3 === 0 ? 0.08 : 0.09,
    logLoss: 0.20,
    calibrationObservations: [{ probability: 0.8, outcome: index % 2 }],
    coverageDelta: index % 2 ? 0.1 : -0.1,
  }));
  const baseline = Array.from({ length: 30 }, (_, index) => ({
    drawId: String(index + 1),
    family: "uniform-null",
    brier: 0.10,
    logLoss: 0.25,
    calibrationObservations: [{ probability: 0.7, outcome: index % 2 }],
  }));

  const evidence = evaluateCandidateSeries({
    candidateRows: candidate,
    baselineRows: baseline,
    seed: "resampling-test-budget",
    resampling: { bootstrapIterations: 19, permutationIterations: 19 },
  });

  assert.ok(Math.abs((evidence.permutationP * 20) - Math.round(evidence.permutationP * 20)) < 1e-12);
});

test("test resampling can use a bounded tail without changing the complete sample count", () => {
  const candidate = Array.from({ length: 30 }, (_, index) => ({
    drawId: String(index + 1),
    brier: 0.075 + ((index % 7) * 0.003),
    logLoss: 0.20 + ((index % 5) * 0.002),
    calibrationObservations: [{ probability: 0.55 + ((index % 4) * 0.05), outcome: index % 2 }],
    coverageDelta: ((index % 5) - 2) / 10,
  }));
  const baseline = Array.from({ length: 30 }, (_, index) => ({
    drawId: String(index + 1),
    family: "uniform-null",
    brier: 0.10,
    logLoss: 0.25,
    calibrationObservations: [{ probability: 0.50, outcome: index % 2 }],
  }));
  const resampling = { bootstrapIterations: 19, permutationIterations: 19 };
  const bounded = evaluateCandidateSeries({
    candidateRows: candidate,
    baselineRows: baseline,
    seed: "bounded-tail",
    resampling: { ...resampling, maxSamples: 10 },
  });
  const tail = evaluateCandidateSeries({
    candidateRows: candidate.slice(-10),
    baselineRows: baseline.slice(-10),
    seed: "bounded-tail",
    resampling,
  });

  assert.equal(bounded.sampleCount, 30);
  assert.equal(bounded.brierSkill, tail.brierSkill);
  assert.equal(bounded.meanExcessLoss, tail.meanExcessLoss);
  assert.equal(bounded.logLossDelta, tail.logLossDelta);
  assert.equal(bounded.calibrationDelta, tail.calibrationDelta);
  assert.equal(bounded.coverageDelta, tail.coverageDelta);
  assert.deepEqual(bounded.brierCi, tail.brierCi);
  assert.deepEqual(bounded.calibrationCi, tail.calibrationCi);
  assert.deepEqual(bounded.coverageCi, tail.coverageCi);
  assert.equal(bounded.permutationP, tail.permutationP);
});

test("calibration delta is ECE over preserved paired observations", () => {
  const shared = { brier: 0.1, logLoss: 0.2 };
  const evidence = evaluateCandidateSeries({
    candidateRows: [
      { drawId: "1", ...shared, calibrationObservations: [{ probability: 0.8, outcome: 1 }] },
      { drawId: "2", ...shared, calibrationObservations: [{ probability: 0.8, outcome: 0 }] },
    ],
    baselineRows: [
      { drawId: "1", family: "uniform-null", ...shared, calibrationObservations: [{ probability: 0.5, outcome: 1 }] },
      { drawId: "2", family: "uniform-null", ...shared, calibrationObservations: [{ probability: 0.5, outcome: 0 }] },
    ],
    seed: "ece",
  });

  assert.ok(Math.abs(evidence.calibrationDelta - 0.3) < 1e-12);
  assert.ok(Math.abs(evidence.calibrationCi.mean - 0.3) < 1e-12);
  assert.ok(Math.abs(evidence.calibrationCi.lower95 - 0.3) < 1e-12);
  assert.ok(Math.abs(evidence.calibrationCi.upper95 - 0.3) < 1e-12);
});

test("paired calibration requires identical observation lengths", () => {
  const shared = { brier: 0.1, logLoss: 0.2 };
  assert.throws(() => evaluateCandidateSeries({
    candidateRows: [{
      drawId: "1",
      ...shared,
      calibrationObservations: [
        { probability: 0.8, outcome: 1 },
        { probability: 0.2, outcome: 0 },
      ],
    }],
    baselineRows: [{
      drawId: "1",
      family: "uniform-null",
      ...shared,
      calibrationObservations: [{ probability: 0.5, outcome: 1 }],
    }],
    seed: "length-mismatch",
  }), /identical length/i);
});

test("paired calibration requires aligned outcomes at every index", () => {
  const shared = { brier: 0.1, logLoss: 0.2 };
  assert.throws(() => evaluateCandidateSeries({
    candidateRows: [{
      drawId: "1",
      ...shared,
      calibrationObservations: [
        { probability: 0.8, outcome: 1 },
        { probability: 0.2, outcome: 0 },
      ],
    }],
    baselineRows: [{
      drawId: "1",
      family: "uniform-null",
      ...shared,
      calibrationObservations: [
        { probability: 0.5, outcome: 0 },
        { probability: 0.5, outcome: 1 },
      ],
    }],
    seed: "outcome-mismatch",
  }), /outcomes.*index/i);
});

test("paired calibration accepts aligned outcomes with different probabilities", () => {
  const shared = { brier: 0.1, logLoss: 0.2 };
  const evidence = evaluateCandidateSeries({
    candidateRows: [{
      drawId: "1",
      ...shared,
      calibrationObservations: [
        { probability: 0.8, outcome: 1 },
        { probability: 0.2, outcome: 0 },
      ],
    }],
    baselineRows: [{
      drawId: "1",
      family: "uniform-null",
      ...shared,
      calibrationObservations: [
        { probability: 0.6, outcome: 1 },
        { probability: 0.4, outcome: 0 },
      ],
    }],
    seed: "aligned",
  });

  assert.ok(Number.isFinite(evidence.calibrationDelta));
});

test("paired calibration rejects malformed flat observations", () => {
  const shared = { brier: 0.1, logLoss: 0.2 };
  assert.throws(() => evaluateCandidateSeries({
    candidateRows: [{
      drawId: "1",
      ...shared,
      calibrationObservations: [{ probability: Number.NaN, outcome: 1 }],
    }],
    baselineRows: [{
      drawId: "1",
      family: "uniform-null",
      ...shared,
      calibrationObservations: [{ probability: 0.5, outcome: 1 }],
    }],
    seed: "malformed-observation",
  }), /finite/i);
});

test("empty and one-pair evidence do not fabricate inferential windows", () => {
  const empty = evaluateCandidateSeries({ candidateRows: [], baselineRows: [], seed: "empty" });
  assert.equal(empty.sampleCount, 0);
  assert.equal(empty.brierSkill, null);
  assert.equal(empty.brierCi, null);
  assert.equal(empty.permutationP, null);

  const one = evaluateCandidateSeries({
    candidateRows: [{ drawId: "1", brier: 0.09, logLoss: 0.2 }],
    baselineRows: [{ drawId: "1", family: "uniform-null", brier: 0.1, logLoss: 0.2 }],
    seed: "one",
  });
  assert.equal(one.sampleCount, 1);
  assert.equal(one.recent30Skill, null);
  assert.equal(one.brierCi, null);
  assert.equal(one.permutationP, null);
});

test("failed rows and malformed non-finite values are rejected", () => {
  assert.throws(() => pairCandidateWithBaseline(
    [{ drawId: "1", brier: 0.1, status: "failed" }],
    [{ drawId: "1", brier: 0.1, family: "uniform-null" }],
  ), /failed/i);
  assert.throws(() => evaluateCandidateSeries({
    candidateRows: [{ drawId: "1", brier: Number.NaN, logLoss: 0.2 }],
    baselineRows: [{ drawId: "1", family: "uniform-null", brier: 0.1, logLoss: 0.2 }],
    seed: "bad",
  }), /finite/i);
  assert.throws(() => pairCandidateWithBaseline(
    [{ drawId: "1", brier: 0.1 }],
    [{ drawId: "1", brier: 0.1, family: "bayesian-drift" }],
  ), /uniform-null/i);
  assert.throws(() => matchedRandomCoverage({
    maxNumber: 5,
    picks: 4,
    groupA: [1, 2, 3, 4],
    groupB: [2, 3, 4, 6],
    actualNumbers: [1, 2, 3, 4],
    simulations: 10,
    seed: "infeasible",
  }), /valid lottery numbers/i);
});

test("forecast scoring does not mutate its inputs", () => {
  const forecast = structuredClone(powerForecast);
  const draw = structuredClone(powerDraw);
  const originalForecast = structuredClone(forecast);
  const originalDraw = structuredClone(draw);

  scoreEvidenceForecast({ forecast, draw, config: GAME_CONFIG.power });

  assert.deepEqual(forecast, originalForecast);
  assert.deepEqual(draw, originalDraw);
});
