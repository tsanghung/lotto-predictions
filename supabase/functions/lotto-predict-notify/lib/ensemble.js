import { normalizeProbabilityVector } from "./scoring.js";

function isFiniteNonNegative(value) {
  return Number.isFinite(value) && value >= 0;
}

function normalizedAvailableWeights(forecasts, weights, vectorKey, maxNumber) {
  const available = [];
  const seen = new Set();

  for (const forecast of forecasts || []) {
    const name = forecast?.name;
    const vector = forecast?.[vectorKey];
    const weight = weights?.[name];
    if (
      typeof name !== "string"
      || seen.has(name)
      || !Array.isArray(vector)
      || vector.length !== maxNumber
      || !vector.every(Number.isFinite)
      || !Number.isFinite(weight)
      || weight <= 0
    ) {
      continue;
    }
    seen.add(name);
    available.push({ name, vector, weight });
  }

  const total = available.reduce((sum, item) => sum + item.weight, 0);
  if (!(total > 0) || !Number.isFinite(total)) return [];

  return available.map((item) => ({ ...item, weight: item.weight / total }));
}

function weightedScores(available, length) {
  return Array.from({ length }, (_, index) => available.reduce(
    (sum, item) => sum + item.weight * item.vector[index],
    0,
  ));
}

function weightsByName(available) {
  return Object.fromEntries(available.map(({ name, weight }) => [name, weight]));
}

export function aggregateForecasts({ forecasts, weights, activeState, config }) {
  const activeWeights = weights || activeState?.expert_weights;
  const main = normalizedAvailableWeights(forecasts, activeWeights, "probabilities", config?.maxNumber);
  if (!main.length) {
    throw new RangeError("aggregateForecasts requires available main-area experts");
  }

  const result = {
    probabilities: normalizeProbabilityVector(
      weightedScores(main, config.maxNumber),
      config.maxNumber,
      config.picks,
    ),
    expertWeights: weightsByName(main),
    specialProbabilities: null,
    specialExpertWeights: {},
  };
  const secondary = config.secondaryNumber;
  if (!secondary) return result;

  const mainNames = new Set(main.map(({ name }) => name));
  const specialForecasts = (forecasts || []).filter((forecast) => mainNames.has(forecast?.name));
  const special = normalizedAvailableWeights(
    specialForecasts,
    activeWeights,
    "specialProbabilities",
    secondary.maxNumber,
  );
  if (!special.length) return result;

  result.specialProbabilities = normalizeProbabilityVector(
    weightedScores(special, secondary.maxNumber),
    secondary.maxNumber,
    secondary.picks,
  );
  result.specialExpertWeights = weightsByName(special);
  return result;
}

export function updateHedgeWeights({ weights, losses, sampleCount, baselineName, gamma = 0.1 }) {
  if (!weights || typeof weights !== "object" || !losses || typeof losses !== "object") {
    throw new TypeError("weights and losses must be objects");
  }
  if (!Number.isFinite(gamma) || gamma < 0 || gamma > 1) {
    throw new RangeError("gamma must be finite and within [0, 1]");
  }
  void baselineName;

  const names = Object.keys(weights).filter((name) => (
    isFiniteNonNegative(weights[name]) && isFiniteNonNegative(losses[name])
  ));
  if (!names.length) {
    throw new RangeError("updateHedgeWeights requires at least one finite non-negative weight and loss");
  }

  const effectiveSamples = Number.isFinite(sampleCount) && sampleCount > 0 ? sampleCount : 1;
  const eta = Math.sqrt((2 * Math.log(Math.max(names.length, 2))) / effectiveSamples);
  const logWeights = names.map((name) => (
    weights[name] > 0 ? Math.log(weights[name]) - eta * losses[name] : Number.NEGATIVE_INFINITY
  ));
  const maxLogWeight = Math.max(...logWeights);
  const scaled = Number.isFinite(maxLogWeight)
    ? logWeights.map((value) => Math.exp(value - maxLogWeight))
    : names.map(() => 1);
  const scaledTotal = scaled.reduce((sum, value) => sum + value, 0);
  const uniformShare = gamma / names.length;

  return Object.fromEntries(names.map((name, index) => {
    const normalized = scaledTotal > 0 && Number.isFinite(scaledTotal)
      ? scaled[index] / scaledTotal
      : 1 / names.length;
    return [name, (1 - gamma) * normalized + uniformShare];
  }));
}
