import { GAME_CONFIG } from "../../lotto-predict-notify/lib/gameConfig.js";
import {
  brierScore,
  calibrationObservations,
  combinedAreaBrier,
  coverageMetrics,
  logLoss,
} from "../../lotto-predict-notify/lib/scoring.js";
import {
  expectedCalibrationError,
  mean,
  pairedBlockBootstrap,
  pairedPermutationTest,
  seededRandom,
} from "./statistics.js";

const FAILED_STATUSES = new Set(["failed", "rejected", "invalid"]);

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function assertPositiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive integer`);
  }
}

function finiteNumber(value, label, { nonNegative = false, positive = false } = {}) {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be a finite number`);
  if (positive && value <= 0) throw new RangeError(`${label} must be positive`);
  if (nonNegative && value < 0) throw new RangeError(`${label} must be non-negative`);
  return value;
}

function assertUsableRow(row, label) {
  assertObject(row, label);
  const statuses = [row.status, row.experimentStatus, row.experiment_status]
    .filter((value) => typeof value === "string")
    .map((value) => value.toLowerCase());
  if (statuses.some((status) => FAILED_STATUSES.has(status))) {
    throw new RangeError(`${label} contains a failed model row`);
  }
  if (row.isValid === false || row.is_valid === false) {
    throw new RangeError(`${label} contains an invalid model row`);
  }
}

function assertUniformBaselineIdentity(row, label) {
  const aliases = ["family", "modelFamily", "model_family"];
  const present = aliases
    .filter((alias) => Object.hasOwn(row, alias))
    .map((alias) => row[alias]);
  if (present.length === 0) {
    throw new RangeError(`${label} family identity is required`);
  }
  if (new Set(present).size !== 1) {
    throw new RangeError(`${label} family aliases conflict`);
  }
  if (present[0] !== "uniform-null") {
    throw new RangeError(`${label} must use the uniform-null family`);
  }
}

function drawIdOf(row, label) {
  const value = row.drawId ?? row.draw_id;
  if ((typeof value !== "string" && typeof value !== "number") || !String(value).trim()) {
    throw new TypeError(`${label} draw id must be a non-empty string or finite number`);
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError(`${label} draw id must be a non-empty string or finite number`);
  }
  return String(value).trim();
}

function chronologyOf(row) {
  return String(row.drawDate ?? row.draw_date ?? "");
}

function comparePairs(left, right) {
  return chronologyOf(left.candidate).localeCompare(chronologyOf(right.candidate))
    || left.drawId.localeCompare(right.drawId, undefined, { numeric: true });
}

function validateLotteryNumbers(values, { maxNumber, picks }, label) {
  assertPositiveInteger(maxNumber, `${label} maxNumber`);
  assertPositiveInteger(picks, `${label} picks`);
  if (picks > maxNumber) throw new RangeError(`${label} picks cannot exceed maxNumber`);
  if (!Array.isArray(values) || values.length !== picks) {
    throw new RangeError(`${label} must contain exactly ${picks} numbers`);
  }
  const numbers = values.map((value) => {
    if (!Number.isInteger(value) || value < 1 || value > maxNumber) {
      throw new RangeError(`${label} must contain valid lottery numbers`);
    }
    return value;
  });
  if (new Set(numbers).size !== numbers.length) {
    throw new RangeError(`${label} must not contain duplicates`);
  }
  return [...numbers];
}

function intersectionSize(left, right) {
  const rightSet = new Set(right);
  return left.filter((value) => rightSet.has(value)).length;
}

function takeRandom(pool, count, rng) {
  const remaining = [...pool];
  const selected = [];
  while (selected.length < count) {
    const index = Math.floor(rng() * remaining.length);
    selected.push(remaining.splice(index, 1)[0]);
  }
  return selected;
}

function sampleTwoGroupsWithOverlap({ maxNumber, picks, overlapCount, rng }) {
  if (maxNumber < (2 * picks) - overlapCount) {
    throw new RangeError("matched overlap is infeasible");
  }
  const universe = Array.from({ length: maxNumber }, (_, index) => index + 1);
  const common = takeRandom(universe, overlapCount, rng);
  const afterCommon = universe.filter((number) => !common.includes(number));
  const groupAOnly = takeRandom(afterCommon, picks - overlapCount, rng);
  const afterA = afterCommon.filter((number) => !groupAOnly.includes(number));
  const groupBOnly = takeRandom(afterA, picks - overlapCount, rng);
  return {
    groupA: [...common, ...groupAOnly].sort((left, right) => left - right),
    groupB: [...common, ...groupBOnly].sort((left, right) => left - right),
  };
}

function matchedShape(input, label) {
  assertObject(input, label);
  const { maxNumber, picks } = input;
  const groupA = validateLotteryNumbers(input.groupA, { maxNumber, picks }, `${label} groupA`);
  const groupB = validateLotteryNumbers(input.groupB, { maxNumber, picks }, `${label} groupB`);
  const actualNumbers = validateLotteryNumbers(
    input.actualNumbers,
    { maxNumber, picks },
    `${label} actualNumbers`,
  );
  return {
    maxNumber,
    picks,
    groupA,
    groupB,
    actualNumbers,
    overlapCount: intersectionSize(groupA, groupB),
  };
}

function coverageUnionHits(groupA, groupB, actualNumbers) {
  return coverageMetrics(groupA, groupB, actualNumbers).union_hits;
}

export function matchedRandomCoverage(input) {
  assertObject(input, "matched random input");
  assertPositiveInteger(input.simulations, "simulations");
  const rng = seededRandom(input.seed);
  const main = matchedShape(input, "main area");
  const special = input.specialArea == null
    ? null
    : matchedShape(input.specialArea, "special area");
  const samples = [];
  const specialSamples = [];
  const combinedSamples = [];

  for (let index = 0; index < input.simulations; index += 1) {
    const mainGroups = sampleTwoGroupsWithOverlap({ ...main, rng });
    const mainHits = coverageUnionHits(mainGroups.groupA, mainGroups.groupB, main.actualNumbers);
    samples.push(mainHits);
    if (special) {
      const specialGroups = sampleTwoGroupsWithOverlap({ ...special, rng });
      const specialHits = coverageUnionHits(
        specialGroups.groupA,
        specialGroups.groupB,
        special.actualNumbers,
      );
      specialSamples.push(specialHits);
      combinedSamples.push(mainHits + specialHits);
    }
  }

  return {
    constraints: {
      groupCount: 2,
      maxNumber: main.maxNumber,
      picks: main.picks,
      overlapCount: main.overlapCount,
      specialArea: special ? {
        groupCount: 2,
        maxNumber: special.maxNumber,
        picks: special.picks,
        overlapCount: special.overlapCount,
      } : null,
    },
    samples,
    specialSamples,
    combinedSamples,
  };
}

function configuredGame(config, forecast) {
  if (config) return config;
  const gameType = forecast?.gameType ?? forecast?.game_type;
  if (gameType && GAME_CONFIG[gameType]) return GAME_CONFIG[gameType];
  const gameName = forecast?.gameName ?? forecast?.game_name;
  return Object.values(GAME_CONFIG).find((candidate) => candidate.name === gameName) ?? null;
}

function groupPair(finalGroups, key, shape) {
  if (finalGroups == null) return null;
  assertObject(finalGroups, "final groups");
  const groups = finalGroups[key];
  if (groups == null) return null;
  assertObject(groups, `${key} groups`);
  const entries = Object.values(groups);
  if (entries.length !== 2 || entries.some((value) => !Array.isArray(value))) {
    throw new RangeError(`${key} must contain exactly two groups`);
  }
  return entries.map((group, index) => (
    validateLotteryNumbers(group, shape, `${key} group ${index + 1}`)
  ));
}

function mappedCoverage(groups, actualNumbers) {
  if (!groups) return null;
  const metrics = coverageMetrics(groups[0], groups[1], actualNumbers);
  return {
    groupAHits: metrics.group_a_hits,
    groupBHits: metrics.group_b_hits,
    unionHits: metrics.union_hits,
    overlapCount: metrics.overlap_count,
    unionSize: metrics.union_size,
  };
}

function scoreArea(probabilities, actualNumbers, shape, groups) {
  return {
    brier: brierScore(probabilities, actualNumbers, shape.maxNumber),
    logLoss: logLoss(probabilities, actualNumbers, shape.maxNumber),
    calibrationObservations: calibrationObservations(
      probabilities,
      actualNumbers,
      shape.maxNumber,
    ),
    coverage: mappedCoverage(groups, actualNumbers),
    coverageDelta: null,
  };
}

function attachMatchedCoverage({ main, special, matched, config }) {
  const mainMean = mean(matched.samples);
  main.coverage.matchedRandomMean = mainMean;
  main.coverageDelta = (main.coverage.unionHits - mainMean) / config.picks;
  if (special) {
    const specialMean = mean(matched.specialSamples);
    special.coverage.matchedRandomMean = specialMean;
    special.coverageDelta = (
      special.coverage.unionHits - specialMean
    ) / config.secondaryNumber.picks;
  }
}

export function scoreEvidenceForecast({ forecast, draw, config, seed, simulations = 1000 } = {}) {
  assertUsableRow(forecast, "forecast");
  assertObject(draw, "draw");
  const resolvedConfig = configuredGame(config, forecast);
  assertObject(resolvedConfig, "config");
  const mainNumbers = validateLotteryNumbers(draw.numbers, resolvedConfig, "draw numbers");
  const finalGroups = forecast.final_groups ?? forecast.finalGroups ?? null;
  const mainGroups = groupPair(finalGroups, "combinations", resolvedConfig);
  const main = scoreArea(forecast.probabilities, mainNumbers, resolvedConfig, mainGroups);
  let special = null;
  let specialGroups = null;

  if (resolvedConfig.secondaryNumber) {
    const specialNumber = draw.special_number ?? draw.specialNumber;
    const specialNumbers = validateLotteryNumbers(
      [specialNumber],
      resolvedConfig.secondaryNumber,
      "draw special number",
    );
    const specialProbabilities = forecast.specialProbabilities ?? forecast.special_probabilities;
    specialGroups = groupPair(
      finalGroups,
      "special_combinations",
      resolvedConfig.secondaryNumber,
    );
    special = scoreArea(
      specialProbabilities,
      specialNumbers,
      resolvedConfig.secondaryNumber,
      specialGroups,
    );
    if (Boolean(mainGroups) !== Boolean(specialGroups)) {
      throw new RangeError("Power recommendation groups require matching main and special-area structures");
    }
  }

  const explicitSeed = seed ?? forecast.randomSeed ?? forecast.random_seed ?? null;
  if (explicitSeed != null && main.coverage) {
    const matched = matchedRandomCoverage({
      maxNumber: resolvedConfig.maxNumber,
      picks: resolvedConfig.picks,
      groupA: mainGroups[0],
      groupB: mainGroups[1],
      actualNumbers: mainNumbers,
      simulations,
      seed: `${explicitSeed}|${draw.draw_id ?? draw.drawId}`,
      ...(special?.coverage ? {
        specialArea: {
          maxNumber: resolvedConfig.secondaryNumber.maxNumber,
          picks: resolvedConfig.secondaryNumber.picks,
          groupA: specialGroups[0],
          groupB: specialGroups[1],
          actualNumbers: [draw.special_number ?? draw.specialNumber],
        },
      } : {}),
    });
    attachMatchedCoverage({ main, special, matched, config: resolvedConfig });
  }

  const combined = {
    brier: combinedAreaBrier(main.brier, special?.brier ?? null),
    logLoss: combinedAreaBrier(main.logLoss, special?.logLoss ?? null),
    calibrationObservations: special
      ? [...main.calibrationObservations, ...special.calibrationObservations]
      : [...main.calibrationObservations],
    coverage: main.coverage ? {
      mainUnionHits: main.coverage.unionHits,
      specialUnionHits: special?.coverage?.unionHits ?? null,
      totalUnionHits: main.coverage.unionHits + (special?.coverage?.unionHits ?? 0),
    } : null,
    coverageDelta: main.coverageDelta == null || (special && special.coverageDelta == null)
      ? null
      : special
        ? (
          (main.coverageDelta * resolvedConfig.picks)
          + (special.coverageDelta * resolvedConfig.secondaryNumber.picks)
        ) / (resolvedConfig.picks + resolvedConfig.secondaryNumber.picks)
        : main.coverageDelta,
  };

  return {
    drawId: drawIdOf(draw, "draw"),
    drawDate: draw.draw_date ?? draw.drawDate ?? null,
    registryId: forecast.registryId ?? forecast.registry_id ?? null,
    modelName: forecast.name ?? forecast.modelName ?? forecast.model_name ?? null,
    family: forecast.family ?? forecast.model_family ?? null,
    main,
    special,
    combined,
  };
}

export function pairCandidateWithBaseline(candidateRows, baselineRows) {
  if (!Array.isArray(candidateRows) || !Array.isArray(baselineRows)) {
    throw new TypeError("candidateRows and baselineRows must be arrays");
  }
  const baselineByDraw = new Map();
  baselineRows.forEach((row, index) => {
    assertUsableRow(row, `baselineRows[${index}]`);
    assertUniformBaselineIdentity(row, `baselineRows[${index}]`);
    const drawId = drawIdOf(row, `baselineRows[${index}]`);
    if (baselineByDraw.has(drawId)) throw new RangeError("baseline draw ids must be unique");
    baselineByDraw.set(drawId, row);
  });
  const candidateIds = new Set();
  return candidateRows.flatMap((candidate, index) => {
    assertUsableRow(candidate, `candidateRows[${index}]`);
    const drawId = drawIdOf(candidate, `candidateRows[${index}]`);
    if (candidateIds.has(drawId)) throw new RangeError("candidate draw ids must be unique");
    candidateIds.add(drawId);
    const baseline = baselineByDraw.get(drawId);
    return baseline ? [{ drawId, candidate, baseline }] : [];
  }).sort(comparePairs);
}

function metricRow(row, area) {
  const source = row.metrics && typeof row.metrics === "object" ? row.metrics : row;
  if (source[area] && typeof source[area] === "object") return source[area];
  if (area === "combined" && Object.hasOwn(source, "brier")) return source;
  if (area === "main" && Object.hasOwn(source, "brier") && !source.combined) return source;
  return null;
}

function validatePairedCalibrationObservations(candidate, baseline, drawId) {
  if (candidate == null && baseline == null) return;
  if (candidate == null || baseline == null) {
    throw new RangeError(`paired calibration observations are incomplete for draw ${drawId}`);
  }
  if (!Array.isArray(candidate) || !Array.isArray(baseline) || candidate.length === 0 || baseline.length === 0) {
    throw new RangeError(`paired calibration observations must be non-empty arrays for draw ${drawId}`);
  }
  if (candidate.length !== baseline.length) {
    throw new RangeError(`paired calibration observations must have identical length for draw ${drawId}`);
  }
  expectedCalibrationError(candidate);
  expectedCalibrationError(baseline);
  candidate.forEach((observation, index) => {
    if (observation.outcome !== baseline[index].outcome) {
      throw new RangeError(`paired calibration outcomes must match at every index for draw ${drawId}`);
    }
  });
}

function blockLengthFor(sampleCount) {
  return Math.min(sampleCount, Math.max(2, Math.round(Math.cbrt(sampleCount))));
}

function calibrationDifference(rows) {
  return expectedCalibrationError(rows.flatMap((row) => row.candidateObservations))
    - expectedCalibrationError(rows.flatMap((row) => row.baselineObservations));
}

function pairedCalibrationBootstrap(rows, seed) {
  if (rows.length < 2) return null;
  const blockLength = blockLengthFor(rows.length);
  const rng = seededRandom(seed);
  const estimates = [];
  for (let iteration = 0; iteration < 2000; iteration += 1) {
    const sample = [];
    while (sample.length < rows.length) {
      const start = Math.floor(rng() * rows.length);
      for (let offset = 0; offset < blockLength && sample.length < rows.length; offset += 1) {
        sample.push(rows[(start + offset) % rows.length]);
      }
    }
    estimates.push(calibrationDifference(sample));
  }
  estimates.sort((left, right) => left - right);
  return {
    mean: calibrationDifference(rows),
    lower95: estimates[Math.floor((estimates.length - 1) * 0.025)],
    upper95: estimates[Math.ceil((estimates.length - 1) * 0.975)],
  };
}

function bootstrap(deltas, seed) {
  if (deltas.length < 2) return null;
  return pairedBlockBootstrap({
    deltas,
    blockLength: blockLengthFor(deltas.length),
    iterations: 2000,
    seed,
  });
}

function recentMean(values, window) {
  return values.length >= window ? mean(values.slice(-window)) : null;
}

function evidenceForArea(pairs, area, seed) {
  const values = pairs.map(({ drawId, candidate, baseline }) => {
    const candidateMetric = metricRow(candidate, area);
    const baselineMetric = metricRow(baseline, area);
    if (!candidateMetric || !baselineMetric) {
      throw new RangeError(`${area} evidence is missing for draw ${drawId}`);
    }
    const candidateBrier = finiteNumber(candidateMetric.brier, "candidate brier", { nonNegative: true });
    const baselineBrier = finiteNumber(baselineMetric.brier, "baseline brier", { positive: true });
    const candidateLogLoss = finiteNumber(candidateMetric.logLoss, "candidate logLoss", { nonNegative: true });
    const baselineLogLoss = finiteNumber(baselineMetric.logLoss, "baseline logLoss", { nonNegative: true });
    const candidateObservations = candidateMetric.calibrationObservations ?? null;
    const baselineObservations = baselineMetric.calibrationObservations ?? null;
    validatePairedCalibrationObservations(candidateObservations, baselineObservations, drawId);
    const coverageDelta = candidateMetric.coverageDelta;
    if (coverageDelta != null) finiteNumber(coverageDelta, "coverageDelta");
    return {
      brierSkill: 1 - (candidateBrier / baselineBrier),
      excessLoss: candidateBrier - baselineBrier,
      logLossDelta: candidateLogLoss - baselineLogLoss,
      candidateObservations,
      baselineObservations,
      coverageDelta: coverageDelta ?? null,
    };
  });
  const brierSkills = values.map((row) => row.brierSkill);
  const coverageDeltas = values.map((row) => row.coverageDelta);
  const hasCompleteCalibration = values.every((row) => row.candidateObservations != null);
  const hasCompleteCoverage = coverageDeltas.every(Number.isFinite);
  const calibrationDelta = values.length && hasCompleteCalibration
    ? calibrationDifference(values)
    : null;

  return {
    sampleCount: values.length,
    recent30Skill: recentMean(brierSkills, 30),
    recent100Skill: recentMean(brierSkills, 100),
    recent500Skill: recentMean(brierSkills, 500),
    brierSkill: values.length ? mean(brierSkills) : null,
    meanExcessLoss: values.length ? mean(values.map((row) => row.excessLoss)) : null,
    brierCi: bootstrap(brierSkills, `${seed}|${area}|brier`),
    logLossDelta: values.length ? mean(values.map((row) => row.logLossDelta)) : null,
    calibrationDelta,
    calibrationCi: values.length && hasCompleteCalibration
      ? pairedCalibrationBootstrap(values, `${seed}|${area}|calibration`)
      : null,
    coverageDelta: values.length && hasCompleteCoverage ? mean(coverageDeltas) : null,
    coverageCi: values.length && hasCompleteCoverage
      ? bootstrap(coverageDeltas, `${seed}|${area}|coverage`)
      : null,
    permutationP: values.length >= 2 ? pairedPermutationTest({
      deltas: brierSkills,
      blockLength: blockLengthFor(values.length),
      iterations: 5000,
      seed: `${seed}|${area}|permutation`,
    }) : null,
    adjustedQ: null,
  };
}

function emptyEvidence() {
  return {
    sampleCount: 0,
    recent30Skill: null,
    recent100Skill: null,
    recent500Skill: null,
    brierSkill: null,
    meanExcessLoss: null,
    brierCi: null,
    logLossDelta: null,
    calibrationDelta: null,
    calibrationCi: null,
    coverageDelta: null,
    coverageCi: null,
    permutationP: null,
    adjustedQ: null,
  };
}

export function evaluateCandidateSeries({ candidateRows, baselineRows, seed } = {}) {
  seededRandom(seed);
  const pairs = pairCandidateWithBaseline(candidateRows, baselineRows);
  if (pairs.length === 0) {
    const empty = emptyEvidence();
    return { ...empty, main: { ...empty }, combined: { ...empty }, specialArea: null };
  }
  const combined = evidenceForArea(pairs, "combined", seed);
  const main = evidenceForArea(pairs, "main", seed);
  const hasSpecial = pairs.some(({ candidate, baseline }) => (
    metricRow(candidate, "special") != null || metricRow(baseline, "special") != null
  ));
  const specialArea = hasSpecial ? evidenceForArea(pairs, "special", seed) : null;
  return {
    ...combined,
    main,
    combined: { ...combined },
    specialArea,
  };
}
