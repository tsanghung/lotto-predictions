import test from "node:test";
import assert from "node:assert/strict";

import { brierScore, logLoss } from "../../lotto-predict-notify/lib/scoring.js";
import { evaluateCandidateSeries } from "./evaluation.js";
import { evaluatePromotionGate } from "./promotionGate.js";
import { benjaminiHochberg, seededRandom } from "./statistics.js";

const MAX_NUMBER = 39;
const PICKS = 5;
const BASE_PROBABILITY = PICKS / MAX_NUMBER;
const HEALTHY = Object.freeze({ dataValid: true, replayDigestValid: true, modelValid: true });

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

function metric(probabilities, actualNumbers) {
  return {
    brier: brierScore(probabilities, actualNumbers, MAX_NUMBER),
    logLoss: logLoss(probabilities, actualNumbers, MAX_NUMBER),
    coverageDelta: 0,
  };
}

function syntheticEvidence({ seed, draws, dataWeights, modelWeights }) {
  const rng = seededRandom(String(seed));
  const baselineProbabilities = Array(MAX_NUMBER).fill(BASE_PROBABILITY);
  const candidateProbabilities = projectedProbabilities(modelWeights);
  const candidateRows = [];
  const baselineRows = [];
  for (let index = 0; index < draws; index += 1) {
    const actualNumbers = weightedDraw({ weights: dataWeights, rng });
    const drawId = `${seed}-${index + 1}`;
    const drawDate = new Date(Date.UTC(2020, 0, index + 1)).toISOString();
    const candidateMetric = metric(candidateProbabilities, actualNumbers);
    const baselineMetric = metric(baselineProbabilities, actualNumbers);
    candidateRows.push({
      drawId,
      drawDate,
      metrics: { main: candidateMetric, combined: candidateMetric },
    });
    baselineRows.push({
      drawId,
      drawDate,
      family: "uniform-null",
      metrics: { main: baselineMetric, combined: baselineMetric },
    });
  }
  return evaluateCandidateSeries({ candidateRows, baselineRows, seed: `experiment-${seed}` });
}

function finalDecision(evidence, seed) {
  const stages = [
    ["registered", 0, 0],
    ["historical_passed", 30, 0],
    ["shadow_verified", 30, 0],
    ["canary", 30, 20],
  ];
  let result;
  for (const [stage, liveShadowDraws, canaryDraws] of stages) {
    result = evaluatePromotionGate({
      stage,
      evidence,
      evidenceDigest: `${seed}-${stage}`,
      previousEvidenceDigest: null,
      liveShadowDraws,
      canaryDraws,
      health: HEALTHY,
    });
    if (result.toStatus === stage) return result;
  }
  return result;
}

function nullEvidence(seed, draws) {
  const modelRng = seededRandom(`model-${seed}`);
  const modelWeights = Array.from({ length: MAX_NUMBER }, () => 0.95 + (0.10 * modelRng()));
  return syntheticEvidence({
    seed,
    draws,
    dataWeights: Array(MAX_NUMBER).fill(1),
    modelWeights,
  });
}

test("200 deterministic pure-random experiments keep false promotion at or below alpha", () => {
  const evidenceRows = Array.from({ length: 200 }, (_, seed) => nullEvidence(seed, 600));
  const adjusted = benjaminiHochberg(evidenceRows.map((row) => row.permutationP));
  const decisions = evidenceRows.map((evidence, seed) => finalDecision({
    ...evidence,
    adjustedQ: adjusted[seed],
  }, seed));
  const falsePromotionRate = decisions.filter((row) => row.toStatus === "champion").length / decisions.length;

  assert.ok(falsePromotionRate <= 0.05, `false promotion rate ${falsePromotionRate}`);
});

test("injected bias demonstrates out-of-sample power without weakening any gate", () => {
  const favoredNumber = 7;
  const lift = 1;
  const weights = Array(MAX_NUMBER).fill(1);
  weights[favoredNumber - 1] *= 1 + lift;
  const evidence = syntheticEvidence({
    seed: 539,
    draws: 1200,
    dataWeights: weights,
    modelWeights: weights,
  });
  const gatedEvidence = { ...evidence, adjustedQ: evidence.permutationP };
  const historicalDecision = evaluatePromotionGate({
    stage: "registered",
    evidence: gatedEvidence,
    evidenceDigest: "bias-539-registered",
    previousEvidenceDigest: null,
    liveShadowDraws: 0,
    canaryDraws: 0,
    health: HEALTHY,
  });

  assert.equal(
    historicalDecision.toStatus,
    "historical_passed",
    JSON.stringify({ decision: historicalDecision, evidence: gatedEvidence }),
  );
  assert.ok(gatedEvidence.recent100Skill > 0);
  assert.ok(gatedEvidence.recent500Skill > 0);
  assert.ok(gatedEvidence.brierCi.lower95 > 0);
  assert.ok(gatedEvidence.logLossDelta <= 0);
  assert.ok(gatedEvidence.coverageCi.lower95 >= 0);
  assert.ok(gatedEvidence.adjustedQ <= 0.05);
});
