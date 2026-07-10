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

  let lower = Math.min(...scores) - 1;
  let upper = Math.max(...scores);
  for (let iteration = 0; iteration < 80; iteration += 1) {
    const threshold = (lower + upper) / 2;
    const total = scores.reduce((sum, score) => sum + clamp(score - threshold, 0, 1), 0);
    if (total > picks) {
      lower = threshold;
    } else {
      upper = threshold;
    }
  }

  const probabilities = scores.map((score) => clamp(score - ((lower + upper) / 2), 0, 1));
  let remaining = picks - probabilities.reduce((sum, probability) => sum + probability, 0);
  for (let index = 0; index < probabilities.length && Math.abs(remaining) > Number.EPSILON; index += 1) {
    const capacity = remaining > 0 ? 1 - probabilities[index] : probabilities[index];
    const adjustment = Math.sign(remaining) * Math.min(Math.abs(remaining), capacity);
    probabilities[index] += adjustment;
    remaining -= adjustment;
  }

  return probabilities.map((probability) => {
    if (Math.abs(probability) < 1e-15) return 0;
    if (Math.abs(1 - probability) < 1e-15) return 1;
    return probability;
  });
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

export function brierSkillScore(modelScore, baselineScore) {
  if (!Number.isFinite(modelScore) || !Number.isFinite(baselineScore)) {
    throw new TypeError("scores must be finite numbers");
  }
  return baselineScore > 0 ? 1 - modelScore / baselineScore : 0;
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
