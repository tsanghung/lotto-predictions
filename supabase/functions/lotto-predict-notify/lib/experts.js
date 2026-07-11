import { GAME_CONFIG } from "./gameConfig.js";
import { ML_WEIGHTS } from "./mlWeights.js";
import { normalizeProbabilityVector } from "./scoring.js";

export const EXPERT_VERSIONS = {
  uniform: "uniform-v1",
  bayesian_frequency: "bayesian-frequency-v1",
  multi_window: "multi-window-v1",
  hazard: "hazard-v1",
  cooccurrence: "cooccurrence-v1",
  markov: "markov-v1",
  lstm: "lstm-static-v1",
  structure: "structure-v1",
};

function targetDate(generatedAt) {
  if (typeof generatedAt !== "string") return null;
  const match = generatedAt.match(/^(\d{4}-\d{2}-\d{2})/);
  return match && !Number.isNaN(Date.parse(`${match[1]}T00:00:00Z`)) ? match[1] : null;
}

function chronologicalHistory(draws, generatedAt) {
  if (!Array.isArray(draws)) {
    throw new TypeError("draws must be an array");
  }
  const cutoff = targetDate(generatedAt);
  return draws.filter((draw) => {
    if (!draw || typeof draw !== "object") return false;
    if (!cutoff || typeof draw.draw_date !== "string") return true;
    return draw.draw_date <= cutoff;
  });
}

function validNumbers(draw, maxNumber) {
  const seen = new Set();
  for (const value of draw?.numbers || []) {
    const number = Number(value);
    if (Number.isInteger(number) && number >= 1 && number <= maxNumber) seen.add(number);
  }
  return [...seen];
}

function specialDraws(draws, maxNumber) {
  return draws.flatMap((draw) => {
    const number = Number(draw?.special_number);
    return Number.isInteger(number) && number >= 1 && number <= maxNumber
      ? [{ draw_date: draw.draw_date, numbers: [number] }]
      : [];
  });
}

function counts(draws, maxNumber) {
  const result = new Array(maxNumber).fill(0);
  for (const draw of draws) {
    for (const number of validNumbers(draw, maxNumber)) result[number - 1] += 1;
  }
  return result;
}

function uniformRaw(maxNumber) {
  return new Array(maxNumber).fill(1);
}

function bayesianFrequencyRaw(draws, maxNumber) {
  return counts(draws, maxNumber).map((count) => count + 1);
}

function multiWindowRaw(draws, maxNumber) {
  const windows = [5, 20, 100];
  const result = new Array(maxNumber).fill(1);
  windows.forEach((window, index) => {
    const sample = draws.slice(-Math.min(window, draws.length));
    const weight = windows.length - index;
    const sampleCounts = counts(sample, maxNumber);
    for (let i = 0; i < maxNumber; i += 1) {
      result[i] += weight * sampleCounts[i] / Math.max(1, sample.length);
    }
  });
  return result;
}

function drawDateMs(draw) {
  if (typeof draw?.draw_date !== "string") return null;
  const value = Date.parse(`${draw.draw_date}T00:00:00Z`);
  return Number.isNaN(value) ? null : value;
}

function forecastMs(draws, generatedAt) {
  const cutoff = targetDate(generatedAt);
  if (cutoff) return Date.parse(`${cutoff}T00:00:00Z`);
  for (let index = draws.length - 1; index >= 0; index -= 1) {
    const value = drawDateMs(draws[index]);
    if (value !== null) return value;
  }
  return 0;
}

function hazardRaw(draws, maxNumber, generatedAt) {
  const occurrences = Array.from({ length: maxNumber }, () => []);
  for (const draw of draws) {
    const ms = drawDateMs(draw);
    if (ms === null) continue;
    for (const number of validNumbers(draw, maxNumber)) occurrences[number - 1].push(ms);
  }
  const now = forecastMs(draws, generatedAt);
  const datedHistory = draws.map(drawDateMs).filter((value) => value !== null);
  const historySpan = datedHistory.length > 1
    ? Math.max(1, (datedHistory.at(-1) - datedHistory[0]) / 86400000)
    : 1;
  return occurrences.map((seen) => {
    if (!seen.length) return historySpan + 1;
    let meanGap = historySpan / Math.max(1, seen.length);
    if (seen.length > 1) {
      let gapSum = 0;
      for (let index = 1; index < seen.length; index += 1) gapSum += seen[index] - seen[index - 1];
      meanGap = Math.max(1, gapSum / (seen.length - 1) / 86400000);
    }
    const currentGap = Math.max(0, (now - seen.at(-1)) / 86400000);
    return 1 + currentGap / meanGap;
  });
}

function cooccurrenceRaw(draws, maxNumber) {
  const result = new Array(maxNumber).fill(1);
  if (!draws.length) return result;
  const latest = new Set(validNumbers(draws.at(-1), maxNumber));
  for (const draw of draws.slice(0, -1)) {
    const numbers = validNumbers(draw, maxNumber);
    const overlap = numbers.reduce((sum, number) => sum + Number(latest.has(number)), 0);
    if (!overlap) continue;
    for (const number of numbers) result[number - 1] += overlap;
  }
  return result;
}

export function markovScores(draws, maxNumber) {
  const trans = Array.from({ length: maxNumber + 1 }, () => [[1, 1], [1, 1]]);
  let previous = null;
  for (const draw of draws) {
    const current = new Array(maxNumber + 1).fill(0);
    for (const number of validNumbers(draw, maxNumber)) current[number] = 1;
    if (previous) {
      for (let number = 1; number <= maxNumber; number += 1) {
        trans[number][previous[number]][current[number]] += 1;
      }
    }
    previous = current;
  }
  const scores = new Array(maxNumber).fill(0);
  if (!previous) return scores;
  for (let number = 1; number <= maxNumber; number += 1) {
    const state = previous[number];
    scores[number - 1] = trans[number][state][1]
      / (trans[number][state][0] + trans[number][state][1]);
  }
  return scores;
}

export function lstmScores(weights, draws) {
  if (!weights) return null;
  const { N, H } = weights;
  const sigmoid = (value) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, value))));
  const matvec = (matrix, vector) => matrix.map((row) => {
    let result = 0;
    for (let index = 0; index < vector.length; index += 1) result += row[index] * vector[index];
    return result;
  });
  let hidden = new Array(H).fill(0);
  let cell = new Array(H).fill(0);
  const input = new Array(N + H).fill(0);
  for (const draw of draws) {
    for (let index = 0; index < N; index += 1) input[index] = 0;
    for (const number of validNumbers(draw, N)) input[number - 1] = 1;
    for (let index = 0; index < H; index += 1) input[N + index] = hidden[index];
    const forgetGate = matvec(weights.Wf, input);
    const inputGate = matvec(weights.Wi, input);
    const candidateGate = matvec(weights.Wg, input);
    const outputGate = matvec(weights.Wo, input);
    const nextHidden = new Array(H);
    const nextCell = new Array(H);
    for (let index = 0; index < H; index += 1) {
      const forget = sigmoid(forgetGate[index] + weights.bf[index]);
      const include = sigmoid(inputGate[index] + weights.bi[index]);
      const candidate = Math.tanh(candidateGate[index] + weights.bg[index]);
      const output = sigmoid(outputGate[index] + weights.bo[index]);
      nextCell[index] = forget * cell[index] + include * candidate;
      nextHidden[index] = output * Math.tanh(nextCell[index]);
    }
    hidden = nextHidden;
    cell = nextCell;
  }
  const logits = matvec(weights.Wy, hidden);
  return logits.map((value, index) => sigmoid(value + weights.by[index]));
}

function structureRaw(maxNumber, picks) {
  const bandSize = maxNumber / picks;
  return Array.from({ length: maxNumber }, (_, index) => {
    const number = index + 1;
    const band = Math.min(picks - 1, Math.floor((number - 1) / bandSize));
    const low = Math.floor(band * bandSize) + 1;
    const high = band === picks - 1 ? maxNumber : Math.floor((band + 1) * bandSize);
    const center = (low + high) / 2;
    return 1 + 1 / (1 + Math.abs(number - center));
  });
}

function rawForecasts({ gameType, draws, generatedAt, config }) {
  const secondary = config.secondaryNumber;
  const secondaryDraws = secondary ? specialDraws(draws, secondary.maxNumber) : [];
  const secondaryRaw = (builder) => secondary ? builder(secondaryDraws, secondary.maxNumber) : null;
  const mainLstm = lstmScores(ML_WEIGHTS[gameType], draws);
  return [
    {
      name: "uniform",
      probabilities: uniformRaw(config.maxNumber),
      specialProbabilities: secondary ? uniformRaw(secondary.maxNumber) : null,
      featureSummary: { historySize: draws.length, baseline: "uniform" },
    },
    {
      name: "bayesian_frequency",
      probabilities: bayesianFrequencyRaw(draws, config.maxNumber),
      specialProbabilities: secondaryRaw(bayesianFrequencyRaw),
      featureSummary: { historySize: draws.length, prior: 1 },
    },
    {
      name: "multi_window",
      probabilities: multiWindowRaw(draws, config.maxNumber),
      specialProbabilities: secondaryRaw(multiWindowRaw),
      featureSummary: { historySize: draws.length, windows: [5, 20, 100] },
    },
    {
      name: "hazard",
      probabilities: hazardRaw(draws, config.maxNumber, generatedAt),
      specialProbabilities: secondary
        ? hazardRaw(secondaryDraws, secondary.maxNumber, generatedAt)
        : null,
      featureSummary: { historySize: draws.length, targetDate: targetDate(generatedAt) },
    },
    {
      name: "cooccurrence",
      probabilities: cooccurrenceRaw(draws, config.maxNumber),
      specialProbabilities: secondaryRaw(cooccurrenceRaw),
      featureSummary: { historySize: draws.length, conditionedOnLatestDraw: draws.length > 0 },
    },
    {
      name: "markov",
      probabilities: markovScores(draws, config.maxNumber),
      specialProbabilities: secondaryRaw(markovScores),
      featureSummary: { historySize: draws.length, order: 1, laplacePrior: 1 },
    },
    {
      name: "lstm",
      probabilities: mainLstm || uniformRaw(config.maxNumber),
      specialProbabilities: null,
      featureSummary: {
        historySize: draws.length,
        staticWeights: Boolean(ML_WEIGHTS[gameType]),
        hiddenUnits: ML_WEIGHTS[gameType]?.H ?? 0,
      },
    },
    {
      name: "structure",
      probabilities: structureRaw(config.maxNumber, config.picks),
      specialProbabilities: secondary
        ? structureRaw(secondary.maxNumber, secondary.picks)
        : null,
      featureSummary: { historySize: draws.length, bands: config.picks },
    },
  ];
}

function normalizeForecast(forecast, config) {
  const secondary = config.secondaryNumber;
  return {
    name: forecast.name,
    version: EXPERT_VERSIONS[forecast.name],
    probabilities: normalizeProbabilityVector(
      forecast.probabilities,
      config.maxNumber,
      config.picks,
    ),
    specialProbabilities: secondary && forecast.specialProbabilities
      ? normalizeProbabilityVector(
          forecast.specialProbabilities,
          secondary.maxNumber,
          secondary.picks,
        )
      : null,
    featureSummary: forecast.featureSummary,
  };
}

export function buildExpertForecasts({ gameType, draws, generatedAt }) {
  const config = GAME_CONFIG[gameType];
  if (!config) throw new Error(`Unsupported game type: ${gameType}`);
  const history = chronologicalHistory(draws, generatedAt);
  return rawForecasts({ gameType, draws: history, generatedAt, config })
    .map((forecast) => normalizeForecast(forecast, config));
}
