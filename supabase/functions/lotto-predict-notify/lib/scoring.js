function assertPositiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

function toFiniteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new TypeError(`${label} must contain finite numbers`);
  }
  return number;
}

function toNumberSet(values, label, maxNumber) {
  if (!Array.isArray(values)) {
    throw new TypeError(`${label} must be an array`);
  }

  return new Set(values.map((value) => {
    const number = toFiniteNumber(value, label);
    if (!Number.isInteger(number) || (maxNumber !== undefined && (number < 1 || number > maxNumber))) {
      throw new RangeError(`${label} contains an invalid actual number`);
    }
    return number;
  }));
}

function validateProbabilityInputs(probabilities, actualNumbers, maxNumber) {
  assertPositiveInteger(maxNumber, "maxNumber");
  if (!Array.isArray(probabilities) || probabilities.length !== maxNumber) {
    throw new RangeError(`probabilities length must equal maxNumber (${maxNumber})`);
  }

  const values = probabilities.map((value) => toFiniteNumber(value, "probabilities"));
  if (values.some((value) => value < 0 || value > 1)) {
    throw new RangeError("probabilities must be within [0, 1]");
  }

  return { values, actual: toNumberSet(actualNumbers, "actualNumbers", maxNumber) };
}

function clamp(value, lower, upper) {
  return Math.min(upper, Math.max(lower, value));
}

function balanceResidual(probabilities, target, adjustableIndices) {
  for (let iteration = 0; iteration < probabilities.length + 2; iteration += 1) {
    const total = probabilities.reduce((sum, probability) => sum + probability, 0);
    const residual = target - total;
    if (residual === 0) return probabilities;

    const adjustable = adjustableIndices.filter((index) => (
      residual > 0 ? probabilities[index] < 1 : probabilities[index] > 0
    ));
    if (adjustable.length === 0) break;

    const share = residual / adjustable.length;
    let changed = false;
    for (const index of adjustable) {
      const next = clamp(probabilities[index] + share, 0, 1);
      changed ||= next !== probabilities[index];
      probabilities[index] = next;
    }
    if (!changed) break;
  }

  let residual = target - probabilities.reduce((sum, probability) => sum + probability, 0);
  const byCapacity = [...adjustableIndices].sort((left, right) => {
    const leftCapacity = residual > 0 ? 1 - probabilities[left] : probabilities[left];
    const rightCapacity = residual > 0 ? 1 - probabilities[right] : probabilities[right];
    return rightCapacity - leftCapacity;
  });
  for (const index of byCapacity) {
    if (residual === 0) break;
    const next = clamp(probabilities[index] + residual, 0, 1);
    if (next === probabilities[index]) continue;
    probabilities[index] = next;
    residual = target - probabilities.reduce((sum, probability) => sum + probability, 0);
  }

  return probabilities;
}

function projectCappedSimplex(scores, picks) {
  const ranked = scores
    .map((score, index) => ({ score, index }))
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const tolerance = 1e-12;

  for (let cappedCount = 0; cappedCount <= picks; cappedCount += 1) {
    const remaining = picks - cappedCount;
    if (remaining === 0) {
      const hasValidGap = cappedCount === scores.length
        || ranked[cappedCount - 1].score - ranked[cappedCount].score >= 1;
      if (!hasValidGap) continue;

      const projected = Array(scores.length).fill(0);
      for (let index = 0; index < cappedCount; index += 1) {
        projected[ranked[index].index] = 1;
      }
      return projected;
    }

    for (let freeCount = remaining + 1; freeCount <= scores.length - cappedCount; freeCount += 1) {
      const free = ranked.slice(cappedCount, cappedCount + freeCount);
      const reference = free[0].score;
      const offsets = free.map(({ score }) => score - reference);
      if (offsets.some((offset) => !Number.isFinite(offset))) continue;

      const thresholdOffset = offsets.reduce((sum, offset) => sum + offset, 0) / freeCount
        - remaining / freeCount;
      const freeProbabilities = offsets.map((offset) => offset - thresholdOffset);
      if (freeProbabilities.some((probability) => probability < -tolerance || probability > 1 + tolerance)) {
        continue;
      }

      const topIsCapped = cappedCount === 0
        || ranked[cappedCount - 1].score - reference - thresholdOffset >= 1 - tolerance;
      const firstZero = cappedCount + freeCount;
      const bottomIsZero = firstZero === scores.length
        || ranked[firstZero].score - reference - thresholdOffset <= tolerance;
      if (!topIsCapped || !bottomIsZero) continue;

      const projected = Array(scores.length).fill(0);
      for (let index = 0; index < cappedCount; index += 1) {
        projected[ranked[index].index] = 1;
      }
      const adjustableIndices = [];
      free.forEach(({ index }, freeIndex) => {
        projected[index] = clamp(freeProbabilities[freeIndex], 0, 1);
        adjustableIndices.push(index);
      });
      return balanceResidual(projected, picks, adjustableIndices);
    }
  }

  throw new Error("unable to project scores onto the capped simplex");
}

export function normalizeProbabilityVector(raw, maxNumber, picks) {
  assertPositiveInteger(maxNumber, "maxNumber");
  if (!Number.isInteger(picks) || picks < 0 || picks > maxNumber) {
    throw new RangeError(`picks must be an integer from 0 to maxNumber (${maxNumber})`);
  }
  if (!Array.isArray(raw) || raw.length !== maxNumber) {
    throw new RangeError(`raw length must equal maxNumber (${maxNumber})`);
  }

  const scores = raw.map((value) => toFiniteNumber(value, "raw"));
  if (picks === 0) {
    return Array(maxNumber).fill(0);
  }
  if (picks === maxNumber) {
    return Array(maxNumber).fill(1);
  }

  return projectCappedSimplex(scores, picks);
}

export function brierScore(probabilities, actualNumbers, maxNumber) {
  const { values, actual } = validateProbabilityInputs(probabilities, actualNumbers, maxNumber);
  return values.reduce((sum, probability, index) => {
    const outcome = actual.has(index + 1) ? 1 : 0;
    return sum + (probability - outcome) ** 2;
  }, 0) / maxNumber;
}

export function logLoss(probabilities, actualNumbers, maxNumber, epsilon = 1e-12) {
  if (!Number.isFinite(epsilon) || epsilon <= 0 || epsilon >= 0.5) {
    throw new RangeError("epsilon must be finite and between 0 and 0.5");
  }

  const { values, actual } = validateProbabilityInputs(probabilities, actualNumbers, maxNumber);
  return values.reduce((sum, probability, index) => {
    const bounded = clamp(probability, epsilon, 1 - epsilon);
    const outcome = actual.has(index + 1);
    const complement = clamp(1 - probability, epsilon, 1 - epsilon);
    return sum - (outcome ? Math.log(bounded) : Math.log(complement));
  }, 0) / maxNumber;
}

export function calibrationObservations(probabilities, actualNumbers, maxNumber) {
  const { values, actual } = validateProbabilityInputs(probabilities, actualNumbers, maxNumber);
  return values.map((probability, index) => ({
    probability,
    outcome: actual.has(index + 1) ? 1 : 0,
  }));
}

export function brierSkillScore(modelScore, baselineScore) {
  if (!Number.isFinite(modelScore) || !Number.isFinite(baselineScore)) {
    throw new TypeError("scores must be finite numbers");
  }
  return baselineScore > 0 ? 1 - modelScore / baselineScore : 0;
}

export function combinedAreaBrier(mainBrier, specialBrier = null) {
  if (!Number.isFinite(mainBrier) || mainBrier < 0) {
    throw new RangeError("mainBrier must be a finite non-negative number");
  }
  if (specialBrier == null) return mainBrier;
  if (!Number.isFinite(specialBrier) || specialBrier < 0) {
    throw new RangeError("specialBrier must be null or a finite non-negative number");
  }
  return (mainBrier + specialBrier) / 2;
}

export function coverageMetrics(groupA, groupB, actualNumbers) {
  const setA = toNumberSet(groupA, "groupA");
  const setB = toNumberSet(groupB, "groupB");
  const actual = toNumberSet(actualNumbers, "actualNumbers");
  const union = new Set([...setA, ...setB]);

  return {
    group_a_hits: [...setA].filter((number) => actual.has(number)).length,
    group_b_hits: [...setB].filter((number) => actual.has(number)).length,
    union_hits: [...union].filter((number) => actual.has(number)).length,
    overlap_count: [...setA].filter((number) => setB.has(number)).length,
    union_size: union.size,
  };
}
