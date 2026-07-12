import { createHash } from "node:crypto";

import { coverageMetrics } from "./scoring.js";

function validateConfig(config) {
  if (!config || !Number.isInteger(config.maxNumber) || config.maxNumber <= 0) {
    throw new RangeError("config.maxNumber must be a positive integer");
  }
  if (!Number.isInteger(config.picks) || config.picks <= 0 || config.picks > config.maxNumber) {
    throw new RangeError("config.picks must be a positive integer within maxNumber");
  }
}

function validateProbabilities(probabilities, config) {
  if (!Array.isArray(probabilities) || probabilities.length !== config.maxNumber) {
    throw new RangeError(`probabilities length must equal maxNumber (${config.maxNumber})`);
  }
  return probabilities.map((value) => {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError("probabilities must contain finite non-negative values");
    }
    return value;
  });
}

function hashFraction(text) {
  const hex = createHash("sha1").update(text).digest("hex").slice(0, 8);
  return Number.parseInt(hex, 16) / 0xffffffff;
}

function uniformPriority(number, config, phase) {
  const band = config.maxNumber / config.picks;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < config.picks; index += 1) {
    const anchor = Math.max(1, Math.min(config.maxNumber, (index + phase) * band));
    bestDistance = Math.min(bestDistance, Math.abs(number - anchor));
  }
  return -bestDistance;
}

function rankCandidates(probabilities, config, seed, { selectedA = null, phase = 0.5, outsideBoost = 0 } = {}) {
  return probabilities.map((probability, index) => {
    const number = index + 1;
    const coverageBonus = selectedA && !selectedA.has(number) ? probability * outsideBoost : 0;
    return {
      number,
      probability,
      objective: probability + coverageBonus,
      uniform: uniformPriority(number, config, phase),
      tie: hashFraction(`${seed}|${number}`),
    };
  }).sort((left, right) => (
    right.objective - left.objective
    || right.uniform - left.uniform
    || right.tie - left.tie
    || left.number - right.number
  ));
}

function takeGroup(ranked, picks) {
  return ranked
    .slice(0, picks)
    .map((item) => item.number)
    .sort((left, right) => left - right);
}

function replaceLastWithNext(group, ranked) {
  const selected = new Set(group);
  const replacement = ranked.find((item) => !selected.has(item.number));
  if (!replacement) return group;

  const rankIndex = new Map(ranked.map((item, index) => [item.number, index]));
  const removable = [...group].sort((left, right) => (
    (rankIndex.get(right) ?? -1) - (rankIndex.get(left) ?? -1)
    || right - left
  ))[0];

  return group
    .filter((number) => number !== removable)
    .concat(replacement.number)
    .sort((left, right) => left - right);
}

export function optimizeTwoGroups({ probabilities, config, seed }) {
  validateConfig(config);
  const values = validateProbabilities(probabilities, config);
  const effectiveSeed = String(seed ?? "");

  const rankedA = rankCandidates(values, config, `${effectiveSeed}|group-a`, { phase: 0.5 });
  const groupA = takeGroup(rankedA, config.picks);
  const selectedA = new Set(groupA);

  const rankedB = rankCandidates(values, config, `${effectiveSeed}|group-b`, {
    selectedA,
    phase: 0.05,
    outsideBoost: 1,
  });
  let groupB = takeGroup(rankedB, config.picks);
  if (
    config.picks < config.maxNumber
    && groupA.length === groupB.length
    && groupA.every((number, index) => number === groupB[index])
  ) {
    groupB = replaceLastWithNext(groupB, rankedB);
  }

  return {
    groupA,
    groupB,
    metrics: coverageMetrics(groupA, groupB, []),
  };
}

export function optimizePowerGroups({ mainProbabilities, specialProbabilities, config, seed }) {
  validateConfig(config);
  if (!config.secondaryNumber) {
    throw new RangeError("Power optimization requires config.secondaryNumber");
  }

  const main = optimizeTwoGroups({
    probabilities: mainProbabilities,
    config: { maxNumber: config.maxNumber, picks: config.picks },
    seed: `${seed}|main`,
  });
  const special = optimizeTwoGroups({
    probabilities: specialProbabilities,
    config: config.secondaryNumber,
    seed: `${seed}|special`,
  });

  return {
    groupA: main.groupA,
    groupB: main.groupB,
    metrics: main.metrics,
    specialGroupA: special.groupA,
    specialGroupB: special.groupB,
    specialMetrics: special.metrics,
  };
}
