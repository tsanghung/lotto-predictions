import { createHash } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";

import { GAME_CONFIG } from "../../lotto-predict-notify/lib/gameConfig.js";
import {
  brierScore,
  calibrationObservations,
  coverageMetrics,
  logLoss,
} from "../../lotto-predict-notify/lib/scoring.js";
import {
  evaluateCandidateSeries,
  matchedRandomCoverage,
  scoreEvidenceForecast,
} from "./evaluation.js";
import { evaluatePromotionGate } from "./promotionGate.js";
import { benjaminiHochberg, seededRandom } from "./statistics.js";

const CONFIG = GAME_CONFIG["539"];
const MAX_NUMBER = CONFIG.maxNumber;
const PICKS = CONFIG.picks;
const BASE_PROBABILITY = PICKS / MAX_NUMBER;
const STRUCTURED_PROBABILITY_SCALE = 2 ** 20;
const STRUCTURED_FAVORED_NUMBERS = Object.freeze([3, 7, 11, 19, 23]);
const WEAK_SIGNAL_LIFT = 0.035;
const SINGLE_NUMBER_LIFT_GRID = Object.freeze([0.035, 0.07, 0.14, 0.28, 0.56, 1.0]);
const STRUCTURED_DRIFT_INTENSITY_GRID = Object.freeze([
  0.07, 0.14, 0.21, 0.28, 0.35, 0.42, 0.49, 0.55,
]);
const MDE_TARGET_POWER = 0.80;
const MDE_CHECKPOINT = 20000;
const FAMILY_NAMES = Object.freeze([
  "bayesian-drift",
  "transition-regularized",
  "sequence-challenger",
]);
const HEALTHY = Object.freeze({ dataValid: true, replayDigestValid: true, modelValid: true });
const FAST_RESAMPLING = Object.freeze({ bootstrapIterations: 19, permutationIterations: 63 });
const SLOW_NULL_RESAMPLING = Object.freeze({
  bootstrapIterations: 19,
  permutationIterations: 63,
});
const SLOW_POWER_RESAMPLING = Object.freeze({
  bootstrapIterations: 3,
  permutationIterations: 63,
});

// These seeds selected the validation checkpoint and must never be used for acceptance.
const TUNING_SEEDS = Object.freeze([907, 211, 307, 401, 503, 601, 701, 809]);
// These observed seeds remain valid only for the 0.035 negative falsification.
const WEAK_SIGNAL_HOLDOUT_SEEDS = Object.freeze([
  1009, 1103, 1201, 1301, 1409, 1511, 1601, 1709, 1801, 1901, 2003, 2111,
]);
// These seeds were consumed by the invalidated tail-only Round 2 holdout.
const INVALIDATED_MDE_HOLDOUT_SEEDS = Object.freeze([
  3001, 3011, 3023, 3037, 3049, 3061, 3079, 3089,
  3109, 3121, 3137, 3163, 3181, 3191, 3203, 3221,
  3251, 3271, 3299, 3301, 3323, 3343, 3361, 3373,
]);
// These seeds were fixed before full-cumulative tuning and are reserved for one final holdout run.
const FINAL_MDE_HOLDOUT_SEEDS = Object.freeze([
  4001, 4013, 4021, 4049, 4051, 4073, 4091, 4099,
  4111, 4127, 4133, 4153, 4177, 4201, 4211, 4229,
  4241, 4253, 4271, 4283, 4297, 4327, 4337, 4357,
]);
// Set exactly once from full-cumulative tuning before any final holdout execution.
const SELECTED_MDE_INTENSITY = 0.42;
const NULL_LANE = process.env.LAI_V3_FALSIFICATION_NULL === "1";
const NEGATIVE_LANE = process.env.LAI_V3_FALSIFICATION_NEGATIVE === "1";
const SINGLE_DIAGNOSTIC_LANE = process.env.LAI_V3_FALSIFICATION_SINGLE_DIAGNOSTIC === "1";
const MDE_TUNING_LANE = process.env.LAI_V3_FALSIFICATION_MDE_TUNING === "1";
const MDE_HOLDOUT_LANE = process.env.LAI_V3_FALSIFICATION_MDE_HOLDOUT === "1";

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

function randomModelProbabilities(seed, family) {
  const rng = seededRandom(`model|${seed}|${family}`);
  return projectedProbabilities(
    Array.from({ length: MAX_NUMBER }, () => 0.95 + (0.10 * rng())),
  );
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

function structuredDriftProbabilities(intensity) {
  const favoredUnits = Math.round(
    BASE_PROBABILITY * (1 + intensity) * STRUCTURED_PROBABILITY_SCALE,
  );
  const otherCount = MAX_NUMBER - STRUCTURED_FAVORED_NUMBERS.length;
  const remainingUnits = (PICKS * STRUCTURED_PROBABILITY_SCALE)
    - (STRUCTURED_FAVORED_NUMBERS.length * favoredUnits);
  const otherUnits = Math.floor(remainingUnits / otherCount);
  let extraUnits = remainingUnits - (otherUnits * otherCount);
  const favoredSet = new Set(STRUCTURED_FAVORED_NUMBERS);
  return Array.from(
    { length: MAX_NUMBER },
    (_, index) => {
      if (favoredSet.has(index + 1)) return favoredUnits / STRUCTURED_PROBABILITY_SCALE;
      const units = otherUnits + (extraUnits > 0 ? 1 : 0);
      extraUnits -= Number(extraUnits > 0);
      return units / STRUCTURED_PROBABILITY_SCALE;
    },
  );
}

function systematicInclusionDraw(probabilities, rng) {
  const selected = [];
  const start = rng();
  let threshold = start;
  let cumulative = 0;
  probabilities.forEach((probability, index) => {
    cumulative += probability;
    if (threshold < cumulative && selected.length < PICKS) {
      selected.push(index + 1);
      threshold = start + selected.length;
    }
  });
  assert.equal(selected.length, PICKS);
  return selected;
}

function generateStructuredDriftDraws({ seed, draws, intensity }) {
  const rng = seededRandom(`structured-draws|${seed}`);
  const probabilities = structuredDriftProbabilities(intensity);
  return Array.from(
    { length: draws },
    () => systematicInclusionDraw(probabilities, rng),
  );
}

function generateNullDraws({ seed, draws }) {
  const rng = seededRandom(`null-draws|${seed}`);
  return Array.from({ length: draws }, () => weightedDraw({
    weights: Array(MAX_NUMBER).fill(1),
    rng,
  }));
}

function recommendationGroups(probabilities) {
  const ranked = probabilities
    .map((probability, index) => ({ number: index + 1, probability }))
    .sort((left, right) => right.probability - left.probability || left.number - right.number)
    .map((row) => row.number);
  return {
    combinations: {
      primary: ranked.slice(0, PICKS),
      secondary: ranked.slice(PICKS, PICKS * 2),
    },
  };
}

function forecastFor({ name, family, probabilities, withCoverage }) {
  return {
    name,
    family,
    probabilities,
    ...(withCoverage ? { final_groups: recommendationGroups(probabilities) } : {}),
  };
}

function drawRecord(numbers, index) {
  return { draw_id: String(index + 1), numbers };
}

function scoreRows({ actualDraws, probabilities, family, seed, coverageSimulations = 1 }) {
  const forecast = forecastFor({
    name: `${family}-candidate`,
    family,
    probabilities,
    withCoverage: true,
  });
  return actualDraws.map((numbers, index) => scoreEvidenceForecast({
    forecast,
    draw: drawRecord(numbers, index),
    config: CONFIG,
    seed: `${seed}|${family}|coverage`,
    simulations: coverageSimulations,
  }));
}

function baselineRows(actualDraws) {
  const forecast = forecastFor({
    name: "uniform-null",
    family: "uniform-null",
    probabilities: Array(MAX_NUMBER).fill(BASE_PROBABILITY),
    withCoverage: false,
  });
  return actualDraws.map((numbers, index) => scoreEvidenceForecast({
    forecast,
    draw: drawRecord(numbers, index),
    config: CONFIG,
  }));
}

function modelProbabilities({ seed, signalProbabilities }) {
  return {
    "bayesian-drift": signalProbabilities
      ?? randomModelProbabilities(seed, "bayesian-drift"),
    "transition-regularized": randomModelProbabilities(seed, "transition-regularized"),
    "sequence-challenger": randomModelProbabilities(seed, "sequence-challenger"),
  };
}

function adjustedEvidenceAtCounts({
  actualDraws,
  seed,
  signalProbabilities,
  counts,
  resampling,
}) {
  const baseline = baselineRows(actualDraws);
  const byCount = Object.fromEntries(counts.map((count) => [count, {}]));
  const probabilitiesByFamily = modelProbabilities({ seed, signalProbabilities });

  for (const family of FAMILY_NAMES) {
    const candidate = scoreRows({
      actualDraws,
      probabilities: probabilitiesByFamily[family],
      family,
      seed,
    });
    for (const count of counts) {
      byCount[count][family] = evaluateCandidateSeries({
        candidateRows: candidate.slice(0, count),
        baselineRows: baseline.slice(0, count),
        seed: `${seed}|${family}|${count}`,
        resampling,
      });
    }
  }

  for (const count of counts) {
    const adjusted = benjaminiHochberg(
      FAMILY_NAMES.map((family) => byCount[count][family].permutationP),
    );
    FAMILY_NAMES.forEach((family, index) => {
      byCount[count][family] = {
        ...byCount[count][family],
        adjustedQ: adjusted[index],
      };
    });
  }
  return byCount;
}

function digestEvidence({ family, sampleCount, evidence }) {
  const payload = JSON.stringify({ family, sampleCount, evidence });
  return createHash("sha256").update(payload).digest("hex");
}

function gate({ stage, evidence, family, sampleCount, previousEvidenceDigest, counters }) {
  const evidenceDigest = digestEvidence({ family, sampleCount, evidence });
  return evaluatePromotionGate({
    stage,
    evidence,
    evidenceDigest,
    previousEvidenceDigest,
    liveShadowDraws: counters.liveShadowDraws,
    canaryDraws: counters.canaryDraws,
    health: HEALTHY,
  });
}

function runNullExperiment(seed, resampling = SLOW_NULL_RESAMPLING) {
  const checkpoints = [500, 530, 531, 550];
  const evidenceByCount = adjustedEvidenceAtCounts({
    actualDraws: generateNullDraws({ seed, draws: 550 }),
    seed,
    signalProbabilities: null,
    counts: checkpoints,
    resampling,
  });
  const finalDecisions = {};
  const digestChains = {};

  for (const family of FAMILY_NAMES) {
    let stage = "registered";
    let previousEvidenceDigest = null;
    let lastDecision = null;
    const chain = [];
    const steps = [
      { count: 500, counters: { liveShadowDraws: 0, canaryDraws: 0 } },
      { count: 530, counters: { liveShadowDraws: 30, canaryDraws: 0 } },
      { count: 531, counters: { liveShadowDraws: 30, canaryDraws: 1 } },
      { count: 550, counters: { liveShadowDraws: 30, canaryDraws: 20 } },
    ];

    for (const step of steps) {
      const decision = gate({
        stage,
        evidence: evidenceByCount[step.count][family],
        family,
        sampleCount: step.count,
        previousEvidenceDigest,
        counters: step.counters,
      });
      lastDecision = decision;
      chain.push({
        sampleCount: step.count,
        previousEvidenceDigest,
        evidenceDigest: decision?.evidenceDigest ?? null,
        fromStatus: stage,
        toStatus: decision?.toStatus ?? null,
      });
      if (!decision || decision.decision !== "promote") {
        finalDecisions[family] = decision;
        break;
      }
      previousEvidenceDigest = decision.evidenceDigest;
      stage = decision.toStatus;

      if (step.count === 530) {
        const duplicate = gate({
          stage,
          evidence: evidenceByCount[step.count][family],
          family,
          sampleCount: step.count,
          previousEvidenceDigest,
          counters: step.counters,
        });
        assert.equal(duplicate, null);
      }
    }
    if (!Object.hasOwn(finalDecisions, family)) finalDecisions[family] = lastDecision;
    digestChains[family] = chain;
  }

  return {
    seed,
    sampleCounts: checkpoints,
    bhFamilySizes: checkpoints.map((count) => Object.keys(evidenceByCount[count]).length),
    digestChains,
    finalDecisions,
    promoted: Object.values(finalDecisions).some((decision) => decision?.toStatus === "champion"),
  };
}

function historicalOutcomes({
  seed,
  counts,
  alternative = "single-number",
  intensity = WEAK_SIGNAL_LIFT,
  resampling = SLOW_POWER_RESAMPLING,
}) {
  const maxCount = Math.max(...counts);
  const signalProbabilities = alternative === "structured-drift"
    ? structuredDriftProbabilities(intensity)
    : biasedInclusionProbabilities(intensity);
  const actualDraws = alternative === "structured-drift"
    ? generateStructuredDriftDraws({ seed, draws: maxCount, intensity })
    : generateBiasedDraws({ seed, draws: maxCount, lift: intensity });
  const evidenceByCount = adjustedEvidenceAtCounts({
    actualDraws,
    seed,
    signalProbabilities,
    counts,
    resampling,
  });
  return Object.fromEntries(counts.map((count) => {
    const evidence = evidenceByCount[count]["bayesian-drift"];
    const decision = gate({
      stage: "registered",
      evidence,
      family: "bayesian-drift",
      sampleCount: count,
      previousEvidenceDigest: null,
      counters: { liveShadowDraws: 0, canaryDraws: 0 },
    });
    return [count, { decision, evidence }];
  }));
}

function wilson95(successes, total) {
  const z = 1.959963984540054;
  const estimate = successes / total;
  const denominator = 1 + ((z ** 2) / total);
  const center = (estimate + ((z ** 2) / (2 * total))) / denominator;
  const margin = (z / denominator) * Math.sqrt(
    (estimate * (1 - estimate) / total) + ((z ** 2) / (4 * (total ** 2))),
  );
  return {
    estimate,
    lower95: successes === 0 ? 0 : Math.max(0, center - margin),
    upper95: successes === total ? 1 : Math.min(1, center + margin),
  };
}

function summarizeMetric(values) {
  const finite = values.filter(Number.isFinite);
  return {
    mean: finite.reduce((sum, value) => sum + value, 0) / finite.length,
    min: Math.min(...finite),
    max: Math.max(...finite),
  };
}

function componentMetrics(evaluations) {
  const evidence = evaluations.map((evaluation) => evaluation.evidence);
  const fields = {
    recent30Skill: (row) => row.recent30Skill,
    recent100Skill: (row) => row.recent100Skill,
    recent500Skill: (row) => row.recent500Skill,
    brierSkill: (row) => row.brierSkill,
    brierLower95: (row) => row.brierCi?.lower95,
    logLossDelta: (row) => row.logLossDelta,
    calibrationDelta: (row) => row.calibrationDelta,
    calibrationLower95: (row) => row.calibrationCi?.lower95,
    coverageDelta: (row) => row.coverageDelta,
    coverageLower95: (row) => row.coverageCi?.lower95,
    adjustedQ: (row) => row.adjustedQ,
  };
  return Object.fromEntries(Object.entries(fields).map(([name, read]) => [
    name,
    summarizeMetric(evidence.map(read)),
  ]));
}

function failureHistogram(evaluations) {
  return evaluations.reduce((histogram, evaluation) => {
    const reason = evaluation.decision.reason;
    histogram[reason] = (histogram[reason] ?? 0) + 1;
    return histogram;
  }, {});
}

function selectedGrid(grid, environmentName) {
  const raw = process.env[environmentName];
  if (raw == null) return grid;
  const selected = Number(raw);
  assert.ok(grid.includes(selected), `${environmentName} must select a pre-registered grid value`);
  return [selected];
}

test("weak-bias generator matches its declared inclusion probabilities", () => {
  const draws = generateBiasedDraws({
    seed: 539,
    draws: MDE_CHECKPOINT,
    lift: WEAK_SIGNAL_LIFT,
  });
  const probabilities = biasedInclusionProbabilities(WEAK_SIGNAL_LIFT);
  const observedFavored = draws.filter((draw) => draw.includes(7)).length / draws.length;
  assert.ok(Math.abs(observedFavored - probabilities[6]) < 0.006);
  assert.ok(Math.abs(probabilities.reduce((sum, value) => sum + value, 0) - PICKS) < 1e-12);
});

test("Wilson interval clamps exact binomial boundaries", () => {
  assert.equal(wilson95(0, 12).lower95, 0);
  assert.equal(wilson95(12, 12).upper95, 1);
});

test("synthetic MDE protocol fixes grid target checkpoint and disjoint holdout seeds", () => {
  const expectedFinalSeeds = [
    4001, 4013, 4021, 4049, 4051, 4073, 4091, 4099,
    4111, 4127, 4133, 4153, 4177, 4201, 4211, 4229,
    4241, 4253, 4271, 4283, 4297, 4327, 4337, 4357,
  ];
  assert.deepEqual(SINGLE_NUMBER_LIFT_GRID, [0.035, 0.07, 0.14, 0.28, 0.56, 1.0]);
  assert.deepEqual(
    STRUCTURED_DRIFT_INTENSITY_GRID,
    [0.07, 0.14, 0.21, 0.28, 0.35, 0.42, 0.49, 0.55],
  );
  assert.equal(MDE_TARGET_POWER, 0.80);
  assert.equal(MDE_CHECKPOINT, 20000);
  assert.deepEqual(SLOW_POWER_RESAMPLING, {
    bootstrapIterations: 3,
    permutationIterations: 63,
  });
  assert.equal(SELECTED_MDE_INTENSITY, 0.42);
  assert.deepEqual(TUNING_SEEDS, [907, 211, 307, 401, 503, 601, 701, 809]);
  assert.deepEqual(FINAL_MDE_HOLDOUT_SEEDS, expectedFinalSeeds);

  const seedSets = {
    null: Array.from({ length: 200 }, (_, seed) => seed),
    tuning: TUNING_SEEDS,
    weakSignal: WEAK_SIGNAL_HOLDOUT_SEEDS,
    invalidatedMde: INVALIDATED_MDE_HOLDOUT_SEEDS,
    finalMde: FINAL_MDE_HOLDOUT_SEEDS,
  };
  for (const [leftName, leftSeeds] of Object.entries(seedSets)) {
    assert.equal(new Set(leftSeeds).size, leftSeeds.length, `${leftName} seeds must be unique`);
    for (const [rightName, rightSeeds] of Object.entries(seedSets)) {
      if (leftName >= rightName) continue;
      const right = new Set(rightSeeds);
      assert.equal(
        leftSeeds.some((seed) => right.has(seed)),
        false,
        `${leftName} and ${rightName} seeds must be disjoint`,
      );
    }
  }
});

test("synthetic alternatives match the production scoring oracle contract", () => {
  for (const intensity of STRUCTURED_DRIFT_INTENSITY_GRID) {
    const probabilities = structuredDriftProbabilities(intensity);
    assert.equal(probabilities.reduce((sum, probability) => sum + probability, 0), PICKS);
    assert.ok(probabilities.every((probability) => Number.isInteger(probability * (2 ** 20))));
  }

  const alternatives = [
    {
      name: "single-number",
      probabilities: biasedInclusionProbabilities(WEAK_SIGNAL_LIFT),
      draws: generateBiasedDraws({ seed: 7019, draws: 20000, lift: WEAK_SIGNAL_LIFT }),
    },
    {
      name: "structured-drift",
      probabilities: structuredDriftProbabilities(0.42),
      draws: generateStructuredDriftDraws({ seed: 7027, draws: 20000, intensity: 0.42 }),
    },
  ];

  for (const alternative of alternatives) {
    const observed = Array(MAX_NUMBER).fill(0);
    for (const draw of alternative.draws) {
      draw.forEach((number) => { observed[number - 1] += 1; });
    }
    observed.forEach((count, index) => {
      assert.ok(
        Math.abs((count / alternative.draws.length) - alternative.probabilities[index]) < 0.008,
        `${alternative.name} number ${index + 1}`,
      );
    });
  }

  const probabilities = alternatives[1].probabilities;
  const forecast = forecastFor({
    name: "structured-drift-candidate",
    family: "bayesian-drift",
    probabilities,
    withCoverage: true,
  });
  const draw = drawRecord(alternatives[1].draws[0], 0);
  const seed = "oracle-contract";
  const simulations = 31;
  const snapshot = structuredClone(forecast);
  const score = scoreEvidenceForecast({ forecast, draw, config: CONFIG, seed, simulations });
  const groups = Object.values(forecast.final_groups.combinations);
  const coverage = coverageMetrics(groups[0], groups[1], draw.numbers);
  const matched = matchedRandomCoverage({
    maxNumber: MAX_NUMBER,
    picks: PICKS,
    groupA: groups[0],
    groupB: groups[1],
    actualNumbers: draw.numbers,
    simulations,
    seed: `${seed}|${draw.draw_id}`,
  });
  const matchedMean = matched.samples.reduce((sum, value) => sum + value, 0)
    / matched.samples.length;

  assert.deepEqual(forecast, snapshot);
  assert.deepEqual(score.main.calibrationObservations, calibrationObservations(
    probabilities,
    draw.numbers,
    MAX_NUMBER,
  ));
  assert.equal(score.main.brier, brierScore(probabilities, draw.numbers, MAX_NUMBER));
  assert.equal(score.main.logLoss, logLoss(probabilities, draw.numbers, MAX_NUMBER));
  assert.equal(score.main.coverage.unionHits, coverage.union_hits);
  assert.equal(score.main.coverageDelta, (coverage.union_hits - matchedMean) / PICKS);
});

test("fast smoke wires generated forecasts through the production evaluator and digest chain", () => {
  const outcome = runNullExperiment(17, FAST_RESAMPLING);
  assert.deepEqual(outcome.sampleCounts, [500, 530, 531, 550]);
  assert.ok(outcome.bhFamilySizes.every((size) => size === FAMILY_NAMES.length));
  for (const chain of Object.values(outcome.digestChains)) {
    chain.slice(1).forEach((step, index) => {
      assert.equal(step.previousEvidenceDigest, chain[index].evidenceDigest);
    });
  }
});

test("slow: 200 independent null experiments keep champion false promotion at or below alpha", {
  skip: !NULL_LANE,
}, () => {
  const outcomes = Array.from({ length: 200 }, (_, seed) => runNullExperiment(seed));
  const promoted = outcomes.filter((outcome) => outcome.promoted).length;
  const rate = promoted / outcomes.length;
  process.stdout.write(`LAI_V3_NULL=${JSON.stringify({ promoted, total: outcomes.length, rate })}\n`);
  assert.equal(new Set(outcomes.map((outcome) => outcome.seed)).size, 200);
  assert.ok(outcomes.every((outcome) => outcome.bhFamilySizes.every((size) => size === 3)));
  assert.ok(rate <= 0.05, `champion false-promotion rate ${rate}`);
});

test("slow negative: 0.035 weak signal remains undetected at 1200 draws", {
  skip: !NEGATIVE_LANE,
}, () => {
  const evaluations = TUNING_SEEDS.map((seed) => historicalOutcomes({
    seed,
    counts: [1200],
    intensity: WEAK_SIGNAL_LIFT,
  })[1200]);
  const decisions = evaluations.map((evaluation) => evaluation.decision);
  assert.ok(decisions.every((decision) => decision.toStatus === "registered"));
  assert.ok(decisions.every((decision) => decision.decision === "hold"));
});

test("slow negative: 0.035 weak signal remains undetected at 20000 draws", {
  skip: !NEGATIVE_LANE,
}, () => {
  const evaluations = WEAK_SIGNAL_HOLDOUT_SEEDS.map((seed) => historicalOutcomes({
    seed,
    counts: [MDE_CHECKPOINT],
    intensity: WEAK_SIGNAL_LIFT,
  })[MDE_CHECKPOINT]);
  const decisions = evaluations.map((evaluation) => evaluation.decision);
  const passed = decisions.filter((decision) => decision.toStatus === "historical_passed").length;
  const interval = wilson95(passed, decisions.length);
  const reasons = Object.fromEntries(WEAK_SIGNAL_HOLDOUT_SEEDS.map((seed, index) => [
    String(seed),
    decisions[index].reason,
  ]));
  process.stdout.write(`LAI_V3_WEAK_SIGNAL=${JSON.stringify({
    checkpoint: MDE_CHECKPOINT,
    lift: WEAK_SIGNAL_LIFT,
    passed,
    total: decisions.length,
    ...interval,
    reasons,
  })}\n`);
  assert.ok(decisions.every((decision) => decision.toStatus === "registered"));
  assert.ok(decisions.every((decision) => decision.decision === "hold"));
});

test("slow diagnostic: single-number synthetic alternative reports gate components", {
  skip: !SINGLE_DIAGNOSTIC_LANE,
}, () => {
  const results = [];
  const selectedLifts = selectedGrid(
    SINGLE_NUMBER_LIFT_GRID,
    "LAI_V3_FALSIFICATION_SINGLE_LIFT",
  );
  for (const lift of selectedLifts) {
    const evaluations = TUNING_SEEDS.map((seed) => historicalOutcomes({
      seed,
      counts: [MDE_CHECKPOINT],
      intensity: lift,
    })[MDE_CHECKPOINT]);
    const decisions = evaluations.map((evaluation) => evaluation.decision);
    const passed = decisions.filter((decision) => decision.toStatus === "historical_passed").length;
    results.push({
      lift,
      checkpoint: MDE_CHECKPOINT,
      passed,
      total: decisions.length,
      estimate: passed / decisions.length,
      failureHistogram: failureHistogram(evaluations),
      componentMetrics: componentMetrics(evaluations),
    });
  }
  process.stdout.write(`LAI_V3_SINGLE_NUMBER_DIAGNOSTIC=${JSON.stringify({
    grid: SINGLE_NUMBER_LIFT_GRID,
    results,
  })}\n`);
  assert.equal(results.length, selectedLifts.length);
});

test("slow tuning: structured-drift synthetic MDE detector power selects minimum intensity", {
  skip: !MDE_TUNING_LANE,
}, () => {
  const results = [];
  let selectedIntensity = null;
  for (const intensity of selectedGrid(
    STRUCTURED_DRIFT_INTENSITY_GRID,
    "LAI_V3_FALSIFICATION_MDE_INTENSITY",
  )) {
    const evaluations = TUNING_SEEDS.map((seed) => historicalOutcomes({
      seed,
      counts: [MDE_CHECKPOINT],
      alternative: "structured-drift",
      intensity,
    })[MDE_CHECKPOINT]);
    const decisions = evaluations.map((evaluation) => evaluation.decision);
    const passed = decisions.filter((decision) => decision.toStatus === "historical_passed").length;
    const estimate = passed / decisions.length;
    results.push({
      intensity,
      checkpoint: MDE_CHECKPOINT,
      passed,
      total: decisions.length,
      estimate,
      failureHistogram: failureHistogram(evaluations),
      componentMetrics: componentMetrics(evaluations),
    });
    if (estimate >= MDE_TARGET_POWER) {
      selectedIntensity = intensity;
      break;
    }
  }
  process.stdout.write(`LAI_V3_STRUCTURED_MDE_TUNING=${JSON.stringify({
    grid: STRUCTURED_DRIFT_INTENSITY_GRID,
    targetPower: MDE_TARGET_POWER,
    selectedIntensity,
    results,
  })}\n`);
  assert.notEqual(selectedIntensity, null, JSON.stringify(results));
});

test("slow holdout: structured-drift synthetic MDE detector power clears one-shot acceptance", {
  skip: !MDE_HOLDOUT_LANE,
}, () => {
  assert.ok(
    Number.isFinite(SELECTED_MDE_INTENSITY),
    "SELECTED_MDE_INTENSITY must be fixed after tuning",
  );
  assert.ok(STRUCTURED_DRIFT_INTENSITY_GRID.includes(SELECTED_MDE_INTENSITY));
  const evaluations = FINAL_MDE_HOLDOUT_SEEDS.map((seed) => historicalOutcomes({
    seed,
    counts: [MDE_CHECKPOINT],
    alternative: "structured-drift",
    intensity: SELECTED_MDE_INTENSITY,
  })[MDE_CHECKPOINT]);
  const decisions = evaluations.map((evaluation) => evaluation.decision);
  const passed = decisions.filter((decision) => decision.toStatus === "historical_passed").length;
  const interval = wilson95(passed, decisions.length);
  process.stdout.write(`LAI_V3_MDE_HOLDOUT=${JSON.stringify({
    checkpoint: MDE_CHECKPOINT,
    alternative: "structured-drift",
    intensity: SELECTED_MDE_INTENSITY,
    passed,
    total: decisions.length,
    ...interval,
    reasons: Object.fromEntries(FINAL_MDE_HOLDOUT_SEEDS.map((seed, index) => [
      String(seed),
      decisions[index].reason,
    ])),
    componentMetrics: componentMetrics(evaluations),
  })}\n`);
  assert.ok(interval.estimate >= MDE_TARGET_POWER, JSON.stringify(interval));
  assert.ok(interval.lower95 > 0.50, JSON.stringify(interval));
});
