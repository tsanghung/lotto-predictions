import { GAME_CONFIG } from "../../lotto-predict-notify/lib/gameConfig.js";
import { lstmScores } from "../../lotto-predict-notify/lib/experts.js";
import { ML_WEIGHTS } from "../../lotto-predict-notify/lib/mlWeights.js";
import { normalizeProbabilityVector } from "../../lotto-predict-notify/lib/scoring.js";
import { V3_MODEL_FAMILIES, assertForecastCutoff, assertProbabilityVector } from "./contracts.js";
import { seededRandom } from "./statistics.js";

const SHADOW_ONLY_FAMILIES = new Set([
  "bayesian-drift",
  "transition-regularized",
  "sequence-challenger",
]);

function assertPositiveFinite(value, label) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive finite number`);
  }
}

function assertPositiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive integer`);
  }
}

function validateNumbers(values, { maxNumber, picks }, label) {
  if (!Array.isArray(values) || values.length !== picks) {
    throw new RangeError(`${label} must contain exactly ${picks} numbers`);
  }
  const numbers = new Set();
  for (const value of values) {
    if (!Number.isInteger(value) || value < 1 || value > maxNumber) {
      throw new RangeError(`${label} must contain valid lottery numbers`);
    }
    numbers.add(value);
  }
  if (numbers.size !== picks) throw new RangeError(`${label} must not contain duplicates`);
  return [...numbers];
}

function validateHistory(draws, config) {
  for (const draw of draws) {
    validateNumbers(draw.numbers, config, "numbers");
    if (config.secondaryNumber) {
      validateNumbers([draw.special_number], config.secondaryNumber, "special_number");
    }
  }
}

function chronologicalHistory(draws) {
  return [...draws].sort((left, right) => (
    left.draw_date.localeCompare(right.draw_date)
    || String(left.draw_id ?? "").localeCompare(String(right.draw_id ?? ""))
  ));
}

function uniformArea(shape) {
  return normalizeProbabilityVector(Array(shape.maxNumber).fill(1), shape.maxNumber, shape.picks);
}

function bayesianArea(draws, shape, { halfLifeDraws, priorStrength }, numberSelector) {
  assertPositiveFinite(halfLifeDraws, "halfLifeDraws");
  assertPositiveFinite(priorStrength, "priorStrength");
  const baseRate = shape.picks / shape.maxNumber;
  const weightedCounts = Array(shape.maxNumber).fill(0);
  let totalWeight = 0;
  draws.forEach((draw, index) => {
    const age = draws.length - 1 - index;
    const weight = 0.5 ** (age / halfLifeDraws);
    totalWeight += weight;
    for (const number of numberSelector(draw)) weightedCounts[number - 1] += weight;
  });
  const raw = weightedCounts.map((count) => (
    (priorStrength * baseRate + count) / (priorStrength + totalWeight)
  ));
  return normalizeProbabilityVector(raw, shape.maxNumber, shape.picks);
}

function logit(probability) {
  const bounded = Math.min(1 - 1e-12, Math.max(1e-12, probability));
  return Math.log(bounded / (1 - bounded));
}

function transitionArea(draws, shape, { minimumSupport, effectCap }, numberSelector) {
  assertPositiveInteger(minimumSupport, "minimumSupport");
  assertPositiveFinite(effectCap, "effectCap");
  const baseRate = shape.picks / shape.maxNumber;
  const supports = Array(shape.maxNumber).fill(0);
  const successes = Array.from({ length: shape.maxNumber }, () => Array(shape.maxNumber).fill(0));

  for (let index = 1; index < draws.length; index += 1) {
    const source = numberSelector(draws[index - 1]);
    const target = new Set(numberSelector(draws[index]));
    for (const sourceNumber of source) {
      supports[sourceNumber - 1] += 1;
      for (let targetNumber = 1; targetNumber <= shape.maxNumber; targetNumber += 1) {
        successes[sourceNumber - 1][targetNumber - 1] += Number(target.has(targetNumber));
      }
    }
  }

  const latest = draws.length ? numberSelector(draws.at(-1)) : [];
  const eligibleSources = latest.filter((sourceNumber) => supports[sourceNumber - 1] >= minimumSupport);
  if (!eligibleSources.length) return uniformArea(shape);

  const baseLogit = logit(baseRate);
  const raw = Array.from({ length: shape.maxNumber }, (_, index) => {
    const meanEffect = eligibleSources.reduce((sum, sourceNumber) => {
      const conditional = successes[sourceNumber - 1][index] / supports[sourceNumber - 1];
      const effect = Math.max(-effectCap, Math.min(effectCap, logit(conditional) - baseLogit));
      return sum + effect;
    }, 0) / eligibleSources.length;
    return baseRate * Math.exp(meanEffect);
  });
  return normalizeProbabilityVector(raw, shape.maxNumber, shape.picks);
}

function validateRegistration(row, gameType) {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new TypeError("registration must be an object");
  }
  if (!V3_MODEL_FAMILIES.includes(row.model_family)) {
    throw new RangeError("registration has an unsupported model family");
  }
  if (typeof row.parameters !== "object" || !row.parameters || Array.isArray(row.parameters)) {
    throw new TypeError("registration parameters must be an object");
  }
  const seed = row.parameters.random_seed;
  seededRandom(seed);
  if (row.game_name !== GAME_CONFIG[gameType].name) {
    throw new RangeError("registration game name does not match game type");
  }
  return { ...row.parameters, random_seed: seed };
}

function baseFeatureSummary(family, historySize) {
  const shadowOnly = SHADOW_ONLY_FAMILIES.has(family);
  return {
    historySize,
    shadowOnly,
    productionWeight: shadowOnly ? 0 : 1,
    scientificRole: family === "uniform-null" ? "permanent-neutral-baseline" : "shadow-challenger",
  };
}

function buildRegisteredForecast({ row, gameType, history, generatedAt, mode }) {
  const config = GAME_CONFIG[gameType];
  const family = row.model_family;
  const parameters = validateRegistration(row, gameType);
  if (SHADOW_ONLY_FAMILIES.has(family) && mode !== "shadow") {
    throw new Error(`${family} is shadow only`);
  }

  const specialShape = config.secondaryNumber ?? null;
  let probabilities;
  let specialProbabilities = specialShape ? uniformArea(specialShape) : null;
  let featureSummary = baseFeatureSummary(family, history.length);

  if (family === "uniform-null") {
    probabilities = uniformArea(config);
    featureSummary = { ...featureSummary, baseline: "uniform" };
  } else if (family === "bayesian-drift") {
    probabilities = bayesianArea(history, config, parameters, (draw) => draw.numbers);
    if (specialShape) {
      specialProbabilities = bayesianArea(history, specialShape, parameters, (draw) => [draw.special_number]);
    }
    featureSummary = { ...featureSummary, halfLifeDraws: parameters.halfLifeDraws, priorStrength: parameters.priorStrength };
  } else if (family === "transition-regularized") {
    probabilities = transitionArea(history, config, parameters, (draw) => draw.numbers);
    if (specialShape) {
      specialProbabilities = transitionArea(history, specialShape, parameters, (draw) => [draw.special_number]);
    }
    featureSummary = {
      ...featureSummary,
      minimumSupport: parameters.minimumSupport,
      effectCap: parameters.effectCap,
    };
  } else {
    const scores = lstmScores(ML_WEIGHTS[gameType], history, config.maxNumber);
    probabilities = scores
      ? normalizeProbabilityVector(scores, config.maxNumber, config.picks)
      : uniformArea(config);
    featureSummary = {
      ...featureSummary,
      calibration: "projection-pending-shadow-evaluation",
      lstmWeights: Boolean(scores),
      failureReason: scores ? null : "invalid-or-missing-lstm-weights",
      specialArea: specialShape ? "independent-uniform-no-sequence-weights" : null,
    };
  }

  assertProbabilityVector(probabilities, config);
  if (specialShape) assertProbabilityVector(specialProbabilities, specialShape);
  return {
    registryId: row.id,
    name: row.model_name,
    family,
    version: row.model_version,
    featureVersion: row.feature_version,
    parameters,
    codeCommit: row.code_commit,
    probabilities,
    specialProbabilities,
    featureSummary,
    dataCutoff: generatedAt,
    randomSeed: parameters.random_seed,
  };
}

export function buildEvidenceForecasts({ gameType, draws, generatedAt, registrations, mode = "shadow" } = {}) {
  const config = GAME_CONFIG[gameType];
  if (!config) throw new Error(`Unsupported game type: ${gameType}`);
  if (mode !== "shadow" && mode !== "production") throw new RangeError("mode must be shadow or production");
  if (!Array.isArray(registrations)) throw new TypeError("registrations must be an array");
  assertForecastCutoff(draws, generatedAt);
  validateHistory(draws, config);
  const history = chronologicalHistory(draws);
  return registrations
    .filter((row) => row?.game_name === config.name)
    .filter((row) => row.status !== "disabled" && row.status !== "rejected")
    .map((row) => buildRegisteredForecast({ row, gameType, history, generatedAt, mode }));
}
