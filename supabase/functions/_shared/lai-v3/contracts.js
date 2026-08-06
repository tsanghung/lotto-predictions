export const V3_MODEL_FAMILIES = Object.freeze([
  "uniform-null",
  "bayesian-drift",
  "transition-regularized",
  "sequence-challenger",
]);

export const V3_STAGES = Object.freeze([
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

export const V3_GATE_CONFIG = Object.freeze({
  qMax: 0.05,
  confidence: 0.95,
  shadowLiveDraws: 30,
  canaryLiveDraws: 20,
  canaryWeightMax: 0.10,
  rollingDemotionWindow: 30,
  bootstrapIterations: 2000,
  permutationIterations: 5000,
});

function assertGameShape({ maxNumber, picks }) {
  if (!Number.isInteger(maxNumber) || maxNumber <= 0) {
    throw new RangeError("maxNumber must be a positive integer");
  }
  if (!Number.isInteger(picks) || picks < 0 || picks > maxNumber) {
    throw new RangeError("picks must be an integer from 0 to maxNumber");
  }
}

function parseTimestamp(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must be a valid date or timestamp`);
  }
  const input = value.trim();
  const date = input.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|T)/);
  const timestamp = Date.parse(input);
  if (!date || !Number.isFinite(timestamp)) {
    throw new TypeError(`${label} must be a valid date or timestamp`);
  }
  const calendar = new Date(Date.UTC(Number(date[1]), Number(date[2]) - 1, Number(date[3])));
  if (
    calendar.getUTCFullYear() !== Number(date[1]) ||
    calendar.getUTCMonth() !== Number(date[2]) - 1 ||
    calendar.getUTCDate() !== Number(date[3])
  ) {
    throw new TypeError(`${label} must be a valid date or timestamp`);
  }
  return timestamp;
}

export function assertProbabilityVector(values, shape) {
  assertGameShape(shape ?? {});
  const { maxNumber, picks } = shape;
  if (!Array.isArray(values) || values.length !== maxNumber) {
    throw new RangeError(`probabilities length must equal maxNumber (${maxNumber})`);
  }
  if (values.some((value) => !Number.isFinite(value))) {
    throw new TypeError("probabilities must contain finite numbers");
  }
  if (values.some((value) => value < 0 || value > 1)) {
    throw new RangeError("probabilities must be within [0, 1]");
  }
  const total = values.reduce((sum, value) => sum + value, 0);
  if (Math.abs(total - picks) > 1e-9) {
    throw new RangeError("probabilities sum must equal picks within 1e-9");
  }
}

export function assertForecastCutoff(draws, generatedAt) {
  const generatedAtMs = parseTimestamp(generatedAt, "generatedAt");
  if (!Array.isArray(draws)) throw new TypeError("draws must be an array");
  for (const draw of draws) {
    if (!draw || typeof draw !== "object") throw new TypeError("draws must contain objects");
    const drawMs = parseTimestamp(draw.draw_date, "draw_date");
    if (drawMs >= generatedAtMs) {
      throw new RangeError("draw violates the data cutoff");
    }
  }
}
