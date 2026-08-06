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
  const dateOnly = input.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const dateTime = input.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/);
  const parts = dateOnly ?? dateTime;
  if (!parts) {
    throw new TypeError(`${label} must be a valid date or timestamp`);
  }
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const hour = dateTime ? Number(parts[4]) : 0;
  const minute = dateTime ? Number(parts[5]) : 0;
  const second = dateTime && parts[6] ? Number(parts[6]) : 0;
  const millisecond = dateTime && parts[7]
    ? Number(parts[7].slice(1, 4).padEnd(3, "0"))
    : 0;
  if (hour > 23 || minute > 59 || second > 59) {
    throw new TypeError(`${label} must be a valid date or timestamp`);
  }
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  calendar.setUTCHours(hour, minute, second, millisecond);
  if (
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day
  ) {
    throw new TypeError(`${label} must be a valid date or timestamp`);
  }
  if (!dateTime || parts[8] === "Z") return calendar.getTime();
  const offset = parts[8].match(/^([+-])(\d{2}):(\d{2})$/);
  const offsetHours = Number(offset[2]);
  const offsetMinutes = Number(offset[3]);
  if (offsetHours > 23 || offsetMinutes > 59) {
    throw new TypeError(`${label} must be a valid date or timestamp`);
  }
  const offsetMs = (offsetHours * 60 + offsetMinutes) * 60000;
  return calendar.getTime() + (offset[1] === "+" ? -offsetMs : offsetMs);
}

function taiwanCalendarDate(timestamp) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function canonicalChronologyInstant(value) {
  const input = typeof value === "string" ? value.trim() : value;
  const timestamp = parseTimestamp(input, "draw_date");
  return /^\d{4}-\d{2}-\d{2}$/.test(input)
    ? timestamp - 8 * 60 * 60 * 1000
    : timestamp;
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
  const generatedAtTaiwanDate = taiwanCalendarDate(generatedAtMs);
  if (!Array.isArray(draws)) throw new TypeError("draws must be an array");
  for (const draw of draws) {
    if (!draw || typeof draw !== "object") throw new TypeError("draws must contain objects");
    const drawDate = typeof draw.draw_date === "string" ? draw.draw_date.trim() : draw.draw_date;
    const drawMs = parseTimestamp(drawDate, "draw_date");
    if (typeof drawDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(drawDate) && drawDate >= generatedAtTaiwanDate) {
      throw new RangeError("draw violates the data cutoff");
    }
    if (drawMs >= generatedAtMs) {
      throw new RangeError("draw violates the data cutoff");
    }
  }
}
