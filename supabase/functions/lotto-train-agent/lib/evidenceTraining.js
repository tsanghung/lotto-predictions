import { evaluateCandidateSeries, scoreEvidenceForecast } from "../../_shared/lai-v3/evaluation.js";
import { buildEvidenceForecasts } from "../../_shared/lai-v3/models.js";
import { GAME_CONFIG } from "../../lotto-predict-notify/lib/gameConfig.js";

const RECENT_ROW_LIMIT = 500;

function clone(value) {
  return structuredClone(value);
}

function assertGameType(gameType) {
  if (typeof gameType !== "string" || !GAME_CONFIG[gameType]) {
    throw new RangeError("gameType must be one of 539, 649, or power");
  }
}

function assertCursor(cursor, draws) {
  if (!Number.isInteger(cursor) || cursor < 0 || cursor > draws.length) {
    throw new RangeError("cursor must be an integer from 0 through draws.length");
  }
}

function assertChunkSize(chunkSize) {
  if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > 25) {
    throw new RangeError("chunkSize must be an integer from 1 through 25");
  }
}

function assertRegistration(registration, expectedFamily, label) {
  if (!registration || typeof registration !== "object" || Array.isArray(registration)) {
    throw new TypeError(`${label} must be an object`);
  }
  if (registration.model_family !== expectedFamily) {
    throw new RangeError(`${label} must use the ${expectedFamily} family`);
  }
  if (typeof registration.id !== "string" || !registration.id.trim()) {
    throw new TypeError(`${label}.id must be a non-empty string`);
  }
}

function assertState(state, registration, baselineRegistration) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new TypeError("state must be an object");
  }
  if (state.registryId !== registration.id || state.baselineRegistryId !== baselineRegistration.id) {
    throw new RangeError("state registry ids do not match the experiment registrations");
  }
  if (!Number.isInteger(state.processedDraws) || state.processedDraws < 0) {
    throw new RangeError("state.processedDraws must be a non-negative integer");
  }
  if (!Array.isArray(state.scoreRows) || !Array.isArray(state.recentRows)) {
    throw new TypeError("state score rows must be arrays");
  }
}

function emptyRunningSums() {
  return {
    sampleCount: 0,
    candidate: { mainBrier: 0, mainLogLoss: 0, combinedBrier: 0, combinedLogLoss: 0 },
    baseline: { mainBrier: 0, mainLogLoss: 0, combinedBrier: 0, combinedLogLoss: 0 },
  };
}

function numeric(value) {
  return Number.isFinite(value) ? value : 0;
}

function addToRunningSums(current, pair) {
  const next = clone(current ?? emptyRunningSums());
  next.sampleCount += 1;
  for (const name of ["candidate", "baseline"]) {
    const score = pair[name];
    next[name].mainBrier += numeric(score.main?.brier);
    next[name].mainLogLoss += numeric(score.main?.logLoss);
    next[name].combinedBrier += numeric(score.combined?.brier);
    next[name].combinedLogLoss += numeric(score.combined?.logLoss);
  }
  return next;
}

function appendEvidencePair(state, pair) {
  if (pair.candidate.drawId !== pair.baseline.drawId) {
    throw new Error("candidate and baseline must score the same target draw");
  }
  const row = {
    drawId: pair.candidate.drawId,
    drawDate: pair.candidate.drawDate,
    candidate: pair.candidate,
    baseline: pair.baseline,
  };
  return {
    ...clone(state),
    processedDraws: state.processedDraws + 1,
    scoreRows: [...state.scoreRows, row],
    runningSums: addToRunningSums(state.runningSums, pair),
  };
}

function compactState(state) {
  const recentRows = [...state.recentRows, ...state.scoreRows].slice(-RECENT_ROW_LIMIT);
  return {
    ...clone(state),
    scoreRows: [],
    recentRows,
    runningSums: clone(state.runningSums ?? emptyRunningSums()),
  };
}

function completedForecast(forecasts, predicate, label) {
  const forecast = forecasts.find(predicate);
  if (!forecast || forecast.status !== "completed") {
    throw new Error(`${label} evidence forecast was not completed`);
  }
  return forecast;
}

export function createInitialEvidenceState(registration, baselineRegistration) {
  assertRegistration(registration, registration?.model_family, "registration");
  assertRegistration(baselineRegistration, "uniform-null", "baselineRegistration");
  return {
    registryId: registration.id,
    baselineRegistryId: baselineRegistration.id,
    modelVersion: registration.model_version,
    featureVersion: registration.feature_version,
    codeCommit: registration.code_commit,
    processedDraws: 0,
    scoreRows: [],
    recentRows: [],
    randomSeed: registration.parameters.random_seed,
    runningSums: emptyRunningSums(),
  };
}

export function walkForwardEvidenceChunk({
  gameType,
  draws,
  cursor,
  chunkSize,
  state,
  registration,
  baselineRegistration,
} = {}) {
  assertGameType(gameType);
  if (!Array.isArray(draws)) throw new TypeError("draws must be an array");
  assertCursor(cursor, draws);
  assertChunkSize(chunkSize);
  assertRegistration(registration, registration?.model_family, "registration");
  assertRegistration(baselineRegistration, "uniform-null", "baselineRegistration");
  if (registration.game_name !== GAME_CONFIG[gameType].name
    || baselineRegistration.game_name !== GAME_CONFIG[gameType].name) {
    throw new RangeError("experiment registrations must match gameType");
  }

  const immutableDraws = clone(draws);
  let next = state
    ? clone(state)
    : createInitialEvidenceState(registration, baselineRegistration);
  assertState(next, registration, baselineRegistration);
  const end = Math.min(cursor + chunkSize, immutableDraws.length);
  const steps = [];

  for (let targetIndex = cursor; targetIndex < end; targetIndex += 1) {
    const history = immutableDraws.slice(0, targetIndex);
    const target = immutableDraws[targetIndex];
    const forecasts = buildEvidenceForecasts({
      gameType,
      draws: history,
      generatedAt: `${target.draw_date}T10:00:00+08:00`,
      registrations: [baselineRegistration, registration],
      mode: "shadow",
    });
    const baseline = completedForecast(
      forecasts,
      (row) => row.family === "uniform-null" && row.registryId === baselineRegistration.id,
      "uniform-null baseline",
    );
    const candidate = completedForecast(
      forecasts,
      (row) => row.registryId === registration.id,
      "candidate",
    );
    next = appendEvidencePair(next, {
      baseline: scoreEvidenceForecast({ forecast: baseline, draw: target, config: GAME_CONFIG[gameType] }),
      candidate: scoreEvidenceForecast({ forecast: candidate, draw: target, config: GAME_CONFIG[gameType] }),
    });
    steps.push({
      targetDrawId: target.draw_id,
      historySize: history.length,
      dataCutoff: history.at(-1)?.draw_date ?? null,
    });
  }

  return {
    nextCursor: end,
    done: end === immutableDraws.length,
    state: compactState(next),
    steps,
  };
}

export function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical JSON requires finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError("canonical JSON requires plain objects, arrays, and JSON primitives");
  }
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(",")}}`;
}

export async function digestReplay(value) {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function finalizeEvidenceRun({
  draws,
  registration,
  baselineRegistration,
  state,
} = {}) {
  if (!Array.isArray(draws)) throw new TypeError("draws must be the frozen snapshot array");
  assertRegistration(registration, registration?.model_family, "registration");
  assertRegistration(baselineRegistration, "uniform-null", "baselineRegistration");
  assertState(state, registration, baselineRegistration);
  const compact = compactState(state);
  const recent = evaluateCandidateSeries({
    candidateRows: compact.recentRows.map((row) => row.candidate),
    baselineRows: compact.recentRows.map((row) => row.baseline),
    seed: compact.randomSeed,
  });
  const replay = {
    frozenSnapshot: clone(draws),
    registration: clone(registration),
    baselineRegistration: clone(baselineRegistration),
    state: compact,
  };
  return {
    metrics: {
      sampleCount: compact.runningSums.sampleCount,
      fullRun: compact.runningSums,
      recent,
    },
    replayDigest: await digestReplay(replay),
  };
}
