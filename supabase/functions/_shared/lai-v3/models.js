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
const REGISTRATION_STATUSES = new Set([
  "baseline",
  "registered",
  "historical_passed",
  "shadow_verified",
  "canary",
  "champion",
  "cooldown",
  "disabled",
  "rejected",
]);
const CODE_COMMIT_PATTERN = /^[0-9a-f]{7,64}$/;
const MINIMUM_SEQUENCE_HISTORY = 30;

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

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function deepClone(value, label) {
  try {
    return structuredClone(value);
  } catch {
    throw new TypeError(`${label} must be structured-cloneable`);
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
  const drawIds = new Set();
  const chronology = new Set();
  for (const draw of draws) {
    if (!draw || typeof draw !== "object") throw new TypeError("draws must contain objects");
    const drawId = assertNonEmptyString(draw.draw_id, "draw_id");
    if (drawIds.has(drawId)) throw new RangeError("draw_id values must be unique");
    drawIds.add(drawId);
    const dateKey = draw.draw_date.slice(0, 10);
    if (chronology.has(dateKey)) throw new RangeError("draw chronology keys must be unique");
    chronology.add(dateKey);
    validateNumbers(draw.numbers, config, "numbers");
    if (config.secondaryNumber) {
      validateNumbers([draw.special_number], config.secondaryNumber, "special_number");
    }
  }
}

function chronologicalHistory(draws) {
  return [...draws].sort((left, right) => left.draw_date.localeCompare(right.draw_date));
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
  if (minimumSupport < 30) throw new RangeError("minimumSupport must be at least 30");
  if (!Number.isFinite(effectCap) || effectCap <= 0 || effectCap > 0.25) {
    throw new RangeError("effectCap must be greater than 0 and at most 0.25");
  }
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

function validateSequenceParameters(parameters) {
  assertPositiveInteger(parameters.minimumHistory, "minimum history");
  if (parameters.minimumHistory < MINIMUM_SEQUENCE_HISTORY) {
    throw new RangeError(`minimum history must be at least ${MINIMUM_SEQUENCE_HISTORY}`);
  }
  if (!parameters.calibration || typeof parameters.calibration !== "object" || Array.isArray(parameters.calibration)) {
    throw new TypeError("calibration metadata must be an object");
  }
  for (const field of ["method", "status", "version"]) {
    assertNonEmptyString(parameters.calibration[field], `calibration.${field}`);
  }
}

function validateRegistration(row, gameType) {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new TypeError("registration must be an object");
  }
  const id = assertNonEmptyString(row.id, "id");
  const name = assertNonEmptyString(row.model_name, "model_name");
  const version = assertNonEmptyString(row.model_version, "model_version");
  const featureVersion = assertNonEmptyString(row.feature_version, "feature_version");
  const gameName = assertNonEmptyString(row.game_name, "game_name");
  if (!Object.values(GAME_CONFIG).some((config) => config.name === gameName)) {
    throw new RangeError("game_name must name a known game");
  }
  if (!V3_MODEL_FAMILIES.includes(row.model_family)) {
    throw new RangeError("registration has an unsupported model family");
  }
  if (!REGISTRATION_STATUSES.has(row.status)) {
    throw new RangeError("registration has an unsupported status");
  }
  if (row.model_family === "uniform-null" && row.status !== "baseline") {
    throw new RangeError("uniform-null must remain baseline");
  }
  if (row.model_family !== "uniform-null" && row.status === "baseline") {
    throw new RangeError("non-uniform registrations cannot use baseline");
  }
  if (typeof row.code_commit !== "string" || !CODE_COMMIT_PATTERN.test(row.code_commit)) {
    throw new RangeError("code_commit must be a lowercase hexadecimal commit id");
  }
  if (typeof row.parameters !== "object" || !row.parameters || Array.isArray(row.parameters)) {
    throw new TypeError("registration parameters must be an object");
  }
  const parameters = deepClone(row.parameters, "registration parameters");
  const seed = parameters.random_seed;
  seededRandom(seed);
  return {
    id,
    name,
    family: row.model_family,
    version,
    featureVersion,
    gameName,
    codeCommit: row.code_commit,
    status: row.status,
    parameters,
    randomSeed: seed,
    isCurrentGame: gameName === GAME_CONFIG[gameType].name,
  };
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

function buildRegisteredForecast({ registration, gameType, history, generatedAt, mode }) {
  const config = GAME_CONFIG[gameType];
  const family = registration.family;
  const parameters = registration.parameters;
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
    validateSequenceParameters(parameters);
    if (history.length < parameters.minimumHistory) {
      throw new RangeError(`minimum history requires ${parameters.minimumHistory} draws`);
    }
    const scores = lstmScores(ML_WEIGHTS[gameType], history, config.maxNumber);
    if (!scores) throw new Error("invalid static LSTM weights");
    probabilities = normalizeProbabilityVector(scores, config.maxNumber, config.picks);
    featureSummary = {
      ...featureSummary,
      calibration: deepClone(parameters.calibration, "calibration metadata"),
      lstmWeights: true,
      specialArea: specialShape ? {
        policy: "independent-uniform-no-sequence-weights",
        status: "not-sequence-modeled",
      } : null,
    };
  }

  assertProbabilityVector(probabilities, config);
  if (specialShape) assertProbabilityVector(specialProbabilities, specialShape);
  return {
    status: "completed",
    registryId: registration.id,
    name: registration.name,
    family,
    version: registration.version,
    featureVersion: registration.featureVersion,
    parameters: deepClone(parameters, "registration parameters"),
    codeCommit: registration.codeCommit,
    probabilities,
    specialProbabilities,
    featureSummary,
    dataCutoff: generatedAt,
    randomSeed: registration.randomSeed,
  };
}

function failedResult(row, generatedAt, error) {
  const registration = row && typeof row === "object" && !Array.isArray(row) ? row : {};
  return {
    status: "failed",
    registryId: typeof registration.id === "string" && registration.id.trim() ? registration.id : null,
    name: typeof registration.model_name === "string" && registration.model_name.trim()
      ? registration.model_name
      : null,
    family: typeof registration.model_family === "string" ? registration.model_family : null,
    version: typeof registration.model_version === "string" && registration.model_version.trim()
      ? registration.model_version
      : null,
    featureVersion: typeof registration.feature_version === "string" && registration.feature_version.trim()
      ? registration.feature_version
      : null,
    dataCutoff: generatedAt,
    randomSeed: typeof registration.parameters?.random_seed === "string" || Number.isFinite(registration.parameters?.random_seed)
      ? registration.parameters.random_seed
      : null,
    failureReason: error instanceof Error ? error.message : String(error),
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
  const results = [];
  for (const row of registrations) {
    let registration;
    try {
      registration = validateRegistration(row, gameType);
    } catch (error) {
      results.push(failedResult(row, generatedAt, error));
      continue;
    }
    if (!registration.isCurrentGame) continue;
    if (registration.status === "disabled" || registration.status === "rejected") continue;
    if (SHADOW_ONLY_FAMILIES.has(registration.family) && mode !== "shadow") {
      throw new Error(`${registration.family} is shadow only`);
    }
    try {
      results.push(buildRegisteredForecast({ registration, gameType, history, generatedAt, mode }));
    } catch (error) {
      results.push(failedResult(row, generatedAt, error));
    }
  }
  return results;
}
