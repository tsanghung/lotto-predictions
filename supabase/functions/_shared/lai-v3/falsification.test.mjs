import test from "node:test";
import assert from "node:assert/strict";

import { brierScore, logLoss } from "../../lotto-predict-notify/lib/scoring.js";
import { evaluatePromotionGate } from "./promotionGate.js";
import { benjaminiHochberg, seededRandom } from "./statistics.js";

const MAX_NUMBER = 39;
const PICKS = 5;
const BASE_PROBABILITY = PICKS / MAX_NUMBER;
const FAMILY_NAMES = Object.freeze([
  "bayesian-drift",
  "transition-regularized",
  "sequence-challenger",
]);
const HEALTHY = Object.freeze({ dataValid: true, replayDigestValid: true, modelValid: true });
const POWER_SEEDS = Object.freeze([101, 211, 307, 401, 503, 601, 701, 809]);

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function weightedDraw({ weights, rng }) {
  const remaining = Array.from({ length: weights.length }, (_, index) => ({
    number: index + 1,
    weight: weights[index],
  }));
  const selected = [];
  while (selected.length < PICKS) {
    const total = remaining.reduce((sum, row) => sum + row.weight, 0);
    let target = rng() * total;
    const index = remaining.findIndex((row) => ((target -= row.weight) <= 0));
    selected.push(remaining.splice(Math.max(0, index), 1)[0].number);
  }
  return selected.sort((left, right) => left - right);
}

function projectedProbabilities(weights) {
  const total = weights.reduce((sum, value) => sum + value, 0);
  return weights.map((value) => PICKS * value / total);
}

function calibrationError(probabilities, actualNumbers) {
  const actual = new Set(actualNumbers);
  const bins = Array.from({ length: 10 }, () => ({ count: 0, probability: 0, outcome: 0 }));
  probabilities.forEach((probability, index) => {
    const bin = bins[Math.min(9, Math.floor(probability * 10))];
    bin.count += 1;
    bin.probability += probability;
    bin.outcome += actual.has(index + 1) ? 1 : 0;
  });
  return bins.reduce((total, bin) => {
    if (bin.count === 0) return total;
    return total + (bin.count / MAX_NUMBER)
      * Math.abs((bin.probability / bin.count) - (bin.outcome / bin.count));
  }, 0);
}

function normalCi(values) {
  const point = mean(values);
  if (values.length < 2) return null;
  const variance = values.reduce((sum, value) => sum + ((value - point) ** 2), 0)
    / (values.length - 1);
  const margin = 1.959963984540054 * Math.sqrt(variance / values.length);
  return { mean: point, lower95: point - margin, upper95: point + margin };
}

function normalCdf(value) {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value) / Math.sqrt(2);
  const t = 1 / (1 + (0.3275911 * x));
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t
    - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x ** 2));
  return 0.5 * (1 + (sign * erf));
}

function oneSidedP(values) {
  const point = mean(values);
  const ci = normalCi(values);
  const standardError = (ci.upper95 - point) / 1.959963984540054;
  if (standardError === 0) return point > 0 ? 0 : point < 0 ? 1 : 0.5;
  return Math.max(0, Math.min(1, 1 - normalCdf(point / standardError)));
}

function buildSeries(actualDraws, candidateProbabilities) {
  const baselineProbabilities = Array(MAX_NUMBER).fill(BASE_PROBABILITY);
  return actualDraws.map((actualNumbers) => {
    const candidateBrier = brierScore(candidateProbabilities, actualNumbers, MAX_NUMBER);
    const baselineBrier = brierScore(baselineProbabilities, actualNumbers, MAX_NUMBER);
    return {
      brierSkill: 1 - (candidateBrier / baselineBrier),
      excessLoss: candidateBrier - baselineBrier,
      logLossDelta: logLoss(candidateProbabilities, actualNumbers, MAX_NUMBER)
        - logLoss(baselineProbabilities, actualNumbers, MAX_NUMBER),
      calibrationDelta: calibrationError(candidateProbabilities, actualNumbers)
        - calibrationError(baselineProbabilities, actualNumbers),
      coverageDelta: 0,
    };
  });
}

function evidenceFromSeries(series, sampleCount) {
  const rows = series.slice(0, sampleCount);
  const skills = rows.map((row) => row.brierSkill);
  const calibration = rows.map((row) => row.calibrationDelta);
  const coverage = rows.map((row) => row.coverageDelta);
  return {
    sampleCount: rows.length,
    recent30Skill: mean(skills.slice(-30)),
    recent100Skill: mean(skills.slice(-100)),
    recent500Skill: mean(skills.slice(-500)),
    brierSkill: mean(skills),
    meanExcessLoss: mean(rows.map((row) => row.excessLoss)),
    brierCi: normalCi(skills),
    logLossDelta: mean(rows.map((row) => row.logLossDelta)),
    calibrationDelta: mean(calibration),
    calibrationCi: normalCi(calibration),
    coverageDelta: mean(coverage),
    coverageCi: normalCi(coverage),
    permutationP: oneSidedP(skills),
    adjustedQ: null,
  };
}

function adjustedEvidence(seriesByFamily, sampleCount) {
  const rows = FAMILY_NAMES.map((family) => ({
    family,
    evidence: evidenceFromSeries(seriesByFamily[family], sampleCount),
  }));
  const adjusted = benjaminiHochberg(rows.map((row) => row.evidence.permutationP));
  return Object.fromEntries(rows.map((row, index) => [row.family, {
    ...row.evidence,
    adjustedQ: adjusted[index],
  }]));
}

function randomModelWeights(seed, family) {
  const rng = seededRandom(`model|${seed}|${family}`);
  return Array.from({ length: MAX_NUMBER }, () => 0.95 + (0.10 * rng()));
}

function generateDraws({ seed, draws, weights }) {
  const rng = seededRandom(`draws|${seed}`);
  return Array.from({ length: draws }, () => weightedDraw({ weights, rng }));
}

function biasedInclusionProbabilities(lift) {
  const favored = BASE_PROBABILITY * (1 + lift);
  const other = (PICKS - favored) / (MAX_NUMBER - 1);
  return Array.from({ length: MAX_NUMBER }, (_, index) => (index === 6 ? favored : other));
}

function takeUniform(pool, count, rng) {
  const remaining = [...pool];
  const selected = [];
  while (selected.length < count) {
    selected.push(remaining.splice(Math.floor(rng() * remaining.length), 1)[0]);
  }
  return selected;
}

function generateBiasedDraws({ seed, draws, lift }) {
  const rng = seededRandom(`biased-draws|${seed}`);
  const probabilities = biasedInclusionProbabilities(lift);
  const others = Array.from({ length: MAX_NUMBER }, (_, index) => index + 1)
    .filter((number) => number !== 7);
  return Array.from({ length: draws }, () => {
    const includeFavored = rng() < probabilities[6];
    const selected = takeUniform(others, includeFavored ? PICKS - 1 : PICKS, rng);
    if (includeFavored) selected.push(7);
    return selected.sort((left, right) => left - right);
  });
}

function gate(stage, evidence, seed, family, checkpoint, counters) {
  return evaluatePromotionGate({
    stage,
    evidence,
    evidenceDigest: `${seed}|${family}|${checkpoint}|${stage}`,
    previousEvidenceDigest: null,
    liveShadowDraws: counters.liveShadowDraws,
    canaryDraws: counters.canaryDraws,
    health: HEALTHY,
  });
}

function runNullExperiment(seed) {
  const draws = generateDraws({ seed, draws: 550, weights: Array(MAX_NUMBER).fill(1) });
  const seriesByFamily = Object.fromEntries(FAMILY_NAMES.map((family) => [
    family,
    buildSeries(draws, projectedProbabilities(randomModelWeights(seed, family))),
  ]));
  const historical = adjustedEvidence(seriesByFamily, 500);
  const shadow = adjustedEvidence(seriesByFamily, 530);
  const canary = adjustedEvidence(seriesByFamily, 550);
  const finalDecisions = {};

  for (const family of FAMILY_NAMES) {
    let decision = gate("registered", historical[family], seed, family, 500, {
      liveShadowDraws: 0,
      canaryDraws: 0,
    });
    if (decision.toStatus !== "historical_passed") {
      finalDecisions[family] = decision;
      continue;
    }
    decision = gate("historical_passed", shadow[family], seed, family, 530, {
      liveShadowDraws: 30,
      canaryDraws: 0,
    });
    if (decision.toStatus !== "shadow_verified") {
      finalDecisions[family] = decision;
      continue;
    }
    decision = gate("shadow_verified", shadow[family], seed, family, "530-canary", {
      liveShadowDraws: 30,
      canaryDraws: 0,
    });
    if (decision.toStatus !== "canary") {
      finalDecisions[family] = decision;
      continue;
    }
    finalDecisions[family] = gate("canary", canary[family], seed, family, 550, {
      liveShadowDraws: 30,
      canaryDraws: 20,
    });
  }

  return {
    seed,
    bhFamilySizes: [Object.keys(historical).length, Object.keys(shadow).length, Object.keys(canary).length],
    sampleCounts: [historical[FAMILY_NAMES[0]].sampleCount, shadow[FAMILY_NAMES[0]].sampleCount, canary[FAMILY_NAMES[0]].sampleCount],
    finalDecisions,
    promoted: Object.values(finalDecisions).some((decision) => decision.toStatus === "champion"),
  };
}

function biasedHistoricalOutcome({ seed, draws, lift }) {
  const candidateProbabilities = biasedInclusionProbabilities(lift);
  const actualDraws = generateBiasedDraws({ seed, draws, lift });
  const seriesByFamily = {
    "bayesian-drift": buildSeries(actualDraws, candidateProbabilities),
    "transition-regularized": buildSeries(
      actualDraws,
      projectedProbabilities(randomModelWeights(seed, "transition-regularized")),
    ),
    "sequence-challenger": buildSeries(
      actualDraws,
      projectedProbabilities(randomModelWeights(seed, "sequence-challenger")),
    ),
  };
  const evidence = adjustedEvidence(seriesByFamily, draws)["bayesian-drift"];
  const decision = gate("registered", evidence, seed, "bayesian-drift", draws, {
    liveShadowDraws: 0,
    canaryDraws: 0,
  });
  return { decision, evidence };
}

function runPowerSweep(drawCounts) {
  return drawCounts.map((draws) => {
    const outcomes = POWER_SEEDS.map((seed) => biasedHistoricalOutcome({ seed, draws, lift: 0.035 }));
    const passed = outcomes.filter((outcome) => outcome.decision.toStatus === "historical_passed").length;
    return {
      draws,
      seeds: [...POWER_SEEDS],
      passed,
      total: outcomes.length,
      historicalPassedRate: passed / outcomes.length,
      reasons: Object.fromEntries(outcomes.map((outcome, index) => [
        String(POWER_SEEDS[index]),
        outcome.decision.reason,
      ])),
    };
  });
}

test("200 independent pure-random experiments keep champion false promotion at or below alpha", () => {
  const outcomes = Array.from({ length: 200 }, (_, seed) => runNullExperiment(seed));
  assert.equal(new Set(outcomes.map((outcome) => outcome.seed)).size, 200);
  assert.ok(outcomes.every((outcome) => outcome.bhFamilySizes.every((size) => size === FAMILY_NAMES.length)));
  assert.ok(outcomes.every((outcome) => JSON.stringify(outcome.sampleCounts) === "[500,530,550]"));
  const falsePromotionRate = outcomes.filter((outcome) => outcome.promoted).length / outcomes.length;
  assert.ok(falsePromotionRate <= 0.05, `false promotion rate ${falsePromotionRate}`);
});

test("3.5 percent injected bias at 1200 draws remains insufficient evidence", () => {
  const outcomes = POWER_SEEDS.map((seed) => biasedHistoricalOutcome({
    seed,
    draws: 1200,
    lift: 0.035,
  }));
  assert.ok(outcomes.every((outcome) => outcome.decision.toStatus === "registered"));
  assert.ok(outcomes.every((outcome) => outcome.decision.decision === "hold"));
});

test("3.5 percent injected bias has stable multi-seed power at 200000 draws", () => {
  const outcomes = POWER_SEEDS.map((seed) => biasedHistoricalOutcome({
    seed,
    draws: 200000,
    lift: 0.035,
  }));
  const passed = outcomes.filter(
    (outcome) => outcome.decision.toStatus === "historical_passed",
  ).length;

  assert.equal(new Set(POWER_SEEDS).size, POWER_SEEDS.length);
  assert.ok(
    passed >= POWER_SEEDS.length / 2,
    `historical_passed power ${passed}/${POWER_SEEDS.length}`,
  );
});

test("weak-bias generator matches its declared inclusion probabilities", () => {
  const lift = 0.035;
  const draws = generateBiasedDraws({ seed: 539, draws: 20000, lift });
  const probabilities = biasedInclusionProbabilities(lift);
  const observedFavored = draws.filter((draw) => draw.includes(7)).length / draws.length;
  assert.ok(Math.abs(observedFavored - probabilities[6]) < 0.006);
  assert.ok(Math.abs(probabilities.reduce((sum, value) => sum + value, 0) - PICKS) < 1e-12);
});

if (process.env.LAI_V3_POWER_SWEEP === "1") {
  test("exploratory 3.5 percent injected-bias power sweep", () => {
    const drawCounts = (process.env.LAI_V3_POWER_SWEEP_COUNTS ?? "5000,20000,50000,100000")
      .split(",")
      .map(Number);
    const results = runPowerSweep(drawCounts);
    process.stdout.write(`LAI_V3_POWER_SWEEP=${JSON.stringify(results)}\n`);
    assert.equal(results.length, drawCounts.length);
  });
}
