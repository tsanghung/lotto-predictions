import { seededRandom } from "../../_shared/lai-v3/statistics.js";

function validateConfig(config) {
  if (!config || !Number.isInteger(config.maxNumber) || config.maxNumber < 1) {
    throw new RangeError("config.maxNumber must be a positive integer");
  }
  if (!Number.isInteger(config.picks) || config.picks < 1 || config.picks > config.maxNumber) {
    throw new RangeError("config.picks must be within maxNumber");
  }
}

function validateInput({ probabilities, config, seed, minUtilityRatio, maxOverlap }) {
  validateConfig(config);
  if (
    !Array.isArray(probabilities)
    || probabilities.length !== config.maxNumber
    || probabilities.some((value) => !Number.isFinite(value) || value < 0)
  ) {
    throw new RangeError("probabilities must be a complete finite non-negative vector");
  }
  if (typeof seed !== "string" || !seed.trim()) {
    throw new TypeError("seed must be a non-empty string");
  }
  if (!Number.isFinite(minUtilityRatio) || minUtilityRatio < 0 || minUtilityRatio > 1) {
    throw new RangeError("minUtilityRatio must be within [0, 1]");
  }
  if (!Number.isInteger(maxOverlap) || maxOverlap < 0 || maxOverlap >= config.picks) {
    throw new RangeError("maxOverlap must be an integer below the group size");
  }
}

function utility(rows) {
  return rows.reduce((sum, row) => sum + row.probability, 0);
}

function sortedNumbers(rows) {
  return rows.map((row) => row.number).sort((left, right) => left - right);
}

export function optimizeEvidenceGroups({
  probabilities,
  config,
  seed,
  minUtilityRatio = 0.90,
  maxOverlap = Math.floor(config?.picks / 3),
} = {}) {
  validateInput({ probabilities, config, seed, minUtilityRatio, maxOverlap });
  const tieRng = seededRandom(seed);
  const ranked = probabilities
    .map((probability, index) => ({
      number: index + 1,
      probability,
      tie: tieRng(),
    }))
    .sort((left, right) => (
      right.probability - left.probability
      || right.tie - left.tie
      || left.number - right.number
    ));
  const attack = ranked.slice(0, config.picks);
  const attackSet = new Set(attack.map((row) => row.number));
  const attackUtility = utility(attack);
  const insideAttack = ranked.filter((row) => attackSet.has(row.number));
  const outsideAttack = ranked.filter((row) => !attackSet.has(row.number));

  for (let overlap = 0; overlap <= maxOverlap; overlap += 1) {
    const candidate = [
      ...insideAttack.slice(0, overlap),
      ...outsideAttack.slice(0, config.picks - overlap),
    ];
    const coverageUtility = utility(candidate);
    if (
      candidate.length === config.picks
      && coverageUtility >= attackUtility * minUtilityRatio
    ) {
      const evidenceAttack = sortedNumbers(attack);
      const coverageFallback = sortedNumbers(candidate);
      return {
        evidenceAttack,
        coverageFallback,
        metrics: {
          attackUtility,
          coverageUtility,
          overlapCount: evidenceAttack.filter((number) => (
            coverageFallback.includes(number)
          )).length,
          unionSize: new Set([...evidenceAttack, ...coverageFallback]).size,
        },
      };
    }
  }

  throw new Error("coverage_constraints_infeasible");
}

export function optimizeEvidencePowerGroups({
  mainProbabilities,
  specialProbabilities,
  config,
  seed,
} = {}) {
  validateConfig(config);
  if (!config.secondaryNumber) {
    throw new RangeError("Power optimization requires config.secondaryNumber");
  }
  const main = optimizeEvidenceGroups({
    probabilities: mainProbabilities,
    config: { maxNumber: config.maxNumber, picks: config.picks },
    seed: `${seed}|main`,
    minUtilityRatio: 0.90,
    maxOverlap: Math.floor(config.picks / 3),
  });
  const special = optimizeEvidenceGroups({
    probabilities: specialProbabilities,
    config: config.secondaryNumber,
    seed: `${seed}|special`,
    minUtilityRatio: 0,
    maxOverlap: 0,
  });

  return {
    ...main,
    specialEvidenceAttack: special.evidenceAttack,
    specialCoverageFallback: special.coverageFallback,
    specialMetrics: special.metrics,
  };
}
