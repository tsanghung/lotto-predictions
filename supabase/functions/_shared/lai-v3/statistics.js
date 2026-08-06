import { assertProbabilityVector } from "./contracts.js";

function assertFiniteArray(values, label, minimumLength = 1) {
  if (!Array.isArray(values) || values.length < minimumLength) {
    throw new RangeError(`${label} must contain at least ${minimumLength === 1 ? "one" : minimumLength} value${minimumLength === 1 ? "" : "s"}`);
  }
  if (values.some((value) => !Number.isFinite(value))) {
    throw new TypeError(`${label} must contain finite numbers`);
  }
}

function canonicalSeed(seed) {
  if (typeof seed === "string") {
    const normalized = seed.trim();
    if (normalized) return normalized;
  } else if (typeof seed === "number" && Number.isFinite(seed)) {
    return String(seed);
  }
  throw new TypeError("seed must be a non-empty string or finite number");
}

function assertResamplingInput({ deltas, blockLength, iterations, seed }) {
  assertFiniteArray(deltas, "deltas", 2);
  if (!Number.isInteger(blockLength) || blockLength < 1 || blockLength > deltas.length) {
    throw new RangeError("blockLength is outside the sample range");
  }
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new RangeError("iterations must be a positive integer");
  }
  return canonicalSeed(seed);
}

function actualNumberSet(values, maxNumber, picks) {
  if (!Array.isArray(values) || values.length !== picks) {
    throw new RangeError("actualNumbers length must equal picks");
  }
  const actual = new Set();
  for (const value of values) {
    if (!Number.isInteger(value) || value < 1 || value > maxNumber) {
      throw new RangeError("actualNumbers must contain valid lottery numbers");
    }
    actual.add(value);
  }
  if (actual.size !== picks) throw new RangeError("actualNumbers must not contain duplicates");
  return actual;
}

export function mean(values) {
  assertFiniteArray(values, "values");
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function seededRandom(seed) {
  const canonical = canonicalSeed(seed);
  let state = 2166136261;
  for (const char of canonical) {
    state ^= char.charCodeAt(0);
    state = Math.imul(state, 16777619);
  }
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function pairedBlockBootstrap({ deltas, blockLength, iterations = 2000, seed } = {}) {
  const canonical = assertResamplingInput({ deltas, blockLength, iterations, seed });
  const rng = seededRandom(canonical);
  const means = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const sample = [];
    while (sample.length < deltas.length) {
      const start = Math.floor(rng() * deltas.length);
      for (let offset = 0; offset < blockLength && sample.length < deltas.length; offset += 1) {
        sample.push(deltas[(start + offset) % deltas.length]);
      }
    }
    means.push(mean(sample));
  }
  means.sort((left, right) => left - right);
  return {
    mean: mean(deltas),
    lower95: means[Math.floor((means.length - 1) * 0.025)],
    upper95: means[Math.ceil((means.length - 1) * 0.975)],
  };
}

export function pairedPermutationTest({ deltas, blockLength, iterations = 5000, seed } = {}) {
  const canonical = assertResamplingInput({ deltas, blockLength, iterations, seed });
  const observed = mean(deltas);
  const rng = seededRandom(canonical);
  let atLeastObserved = 0;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const signs = new Map();
    const permutedMean = deltas.reduce((sum, value, index) => {
      const block = Math.floor(index / blockLength);
      if (!signs.has(block)) signs.set(block, rng() < 0.5 ? -1 : 1);
      return sum + value * signs.get(block);
    }, 0) / deltas.length;
    if (permutedMean >= observed) atLeastObserved += 1;
  }
  return (atLeastObserved + 1) / (iterations + 1);
}

export function benjaminiHochberg(pValues) {
  if (!Array.isArray(pValues)) throw new TypeError("pValues must be an array");
  const ranked = pValues.map((value, index) => {
    if (!Number.isFinite(value)) throw new TypeError("pValues must contain finite numbers");
    if (value < 0 || value > 1) throw new RangeError("pValues must be within [0, 1]");
    return { value, index };
  }).sort((left, right) => left.value - right.value || left.index - right.index);
  const adjusted = Array(pValues.length);
  let runningMinimum = 1;
  for (let index = ranked.length - 1; index >= 0; index -= 1) {
    const candidate = Math.min(1, ranked[index].value * ranked.length / (index + 1));
    runningMinimum = Math.min(runningMinimum, candidate);
    adjusted[ranked[index].index] = runningMinimum;
  }
  return adjusted;
}

export function expectedCalibrationError(observations) {
  if (!Array.isArray(observations)) throw new TypeError("observations must be an array");
  if (observations.length === 0) return null;
  const bins = Array.from({ length: 10 }, () => ({ count: 0, probability: 0, outcome: 0 }));
  for (const observation of observations) {
    if (!observation || typeof observation !== "object") throw new TypeError("observations must contain objects");
    const { probabilities, actualNumbers, maxNumber, picks } = observation;
    assertProbabilityVector(probabilities, { maxNumber, picks });
    const actual = actualNumberSet(actualNumbers, maxNumber, picks);
    probabilities.forEach((probability, index) => {
      const bin = bins[Math.min(9, Math.floor(probability * 10))];
      bin.count += 1;
      bin.probability += probability;
      bin.outcome += Number(actual.has(index + 1));
    });
  }
  const total = bins.reduce((sum, bin) => sum + bin.count, 0);
  return bins.reduce((error, bin) => {
    if (bin.count === 0) return error;
    return error + (bin.count / total) * Math.abs(bin.probability / bin.count - bin.outcome / bin.count);
  }, 0);
}
