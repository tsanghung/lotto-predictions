import { evaluateCandidateSeries, scoreEvidenceForecast } from "../../_shared/lai-v3/evaluation.js";
import { buildEvidenceForecasts } from "../../_shared/lai-v3/models.js";
import { seededRandom } from "../../_shared/lai-v3/statistics.js";
import { GAME_CONFIG } from "../../lotto-predict-notify/lib/gameConfig.js";

const RECENT_ROW_LIMIT = 500;
const EVALUATION_RESERVOIR_LIMIT = 500;
const RESERVOIR_METHOD = "deterministic-bottom-k-reservoir-v1";

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

function assertRangeStart(rangeStart, cursor) {
  if (!Number.isInteger(rangeStart) || rangeStart < 0 || rangeStart > cursor) {
    throw new RangeError("rangeStart must be an integer from 0 through cursor");
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

function assertFiniteNumbers(value, label) {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${label} must contain only finite numbers`);
    return;
  }
  if (value == null || typeof value === "string" || typeof value === "boolean") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertFiniteNumbers(entry, `${label}[${index}]`));
    return;
  }
  if (typeof value === "object") {
    Object.entries(value).forEach(([key, entry]) => assertFiniteNumbers(entry, `${label}.${key}`));
  }
}

function targetIdentity(draw) {
  return canonicalJson({
    drawId: String(draw.draw_id),
    drawDate: draw.draw_date,
    numbers: draw.numbers,
    specialNumber: draw.special_number ?? null,
  });
}

function assertState(state, registration, baselineRegistration, context = null) {
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
  if (Object.hasOwn(state, "evaluationRows")) {
    throw new RangeError("state.evaluationRows is an unbounded legacy evidence population");
  }
  if (!Array.isArray(state.evaluationReservoir)
    || state.evaluationReservoir.length > EVALUATION_RESERVOIR_LIMIT
    || state.evaluationReservoir.length > state.processedDraws) {
    throw new RangeError("state evaluation reservoir is outside its bounded population");
  }
  if (state.recentRows.length > RECENT_ROW_LIMIT) {
    throw new RangeError(`state.recentRows cannot exceed ${RECENT_ROW_LIMIT} rows`);
  }
  if (state.runningSums?.sampleCount !== state.processedDraws) {
    throw new RangeError("state running sums do not match processedDraws");
  }
  assertFiniteNumbers(state.runningSums, "state.runningSums");
  for (const entry of state.evaluationReservoir) {
    if (!entry || typeof entry !== "object" || !/^[0-9a-f]{16}$/.test(entry.priority)) {
      throw new TypeError("state evaluation reservoir priorities must be 16 lowercase hex characters");
    }
    if (entry.priority !== reservoirPriority(entry.row, state.randomSeed)) {
      throw new RangeError("state evaluation reservoir priority does not match its score row");
    }
  }
  const sortedReservoir = [...state.evaluationReservoir].sort(compareReservoirEntries);
  if (canonicalJson(sortedReservoir) !== canonicalJson(state.evaluationReservoir)) {
    throw new RangeError("state evaluation reservoir must remain canonically ordered");
  }
  if (!context) return;
  const { rangeStart, draws, cursor } = context;
  if (state.rangeStart !== rangeStart || state.rangeEnd !== draws.length) {
    throw new RangeError("state range does not match the frozen experiment range");
  }
  if (state.nextCursor !== cursor || state.processedDraws !== cursor - rangeStart) {
    throw new RangeError("state cursor continuity does not match the requested cursor");
  }
  const priorTarget = cursor > rangeStart ? draws[cursor - 1] : null;
  if (priorTarget) {
    if (state.lastTargetDrawId !== String(priorTarget.draw_id)
      || state.lastTargetIdentity !== targetIdentity(priorTarget)) {
      throw new RangeError("state last target continuity does not match the frozen snapshot");
    }
  } else if (state.lastTargetDrawId != null || state.lastTargetIdentity != null) {
    throw new RangeError("state last target must be empty at rangeStart");
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
  if (!Number.isFinite(value)) throw new TypeError("evidence scores must be finite numbers");
  return value;
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

function evidenceRow(pair) {
  if (pair.candidate.drawId !== pair.baseline.drawId) {
    throw new Error("candidate and baseline must score the same target draw");
  }
  const row = {
    drawId: pair.candidate.drawId,
    drawDate: pair.candidate.drawDate,
    candidate: pair.candidate,
    baseline: pair.baseline,
  };
  assertFiniteNumbers(row, "evidence score row");
  return row;
}

function reservoirPriority(row, seed) {
  const rng = seededRandom(`${seed}|${RESERVOIR_METHOD}|${canonicalJson(row)}`);
  const high = Math.floor(rng() * 0x100000000).toString(16).padStart(8, "0");
  const low = Math.floor(rng() * 0x100000000).toString(16).padStart(8, "0");
  return `${high}${low}`;
}

function compareReservoirEntries(left, right) {
  return left.priority.localeCompare(right.priority)
    || left.row.drawDate.localeCompare(right.row.drawDate)
    || left.row.drawId.localeCompare(right.row.drawId, undefined, { numeric: true });
}

function compareEvidenceRows(left, right) {
  return left.drawDate.localeCompare(right.drawDate)
    || left.drawId.localeCompare(right.drawId, undefined, { numeric: true });
}

function nextReservoir(current, row, seed) {
  return [...current, { priority: reservoirPriority(row, seed), row }]
    .sort(compareReservoirEntries)
    .slice(0, EVALUATION_RESERVOIR_LIMIT);
}

export function accumulateEvidencePair(state, pair) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new TypeError("state must be an object");
  }
  const row = evidenceRow(pair);
  return {
    ...state,
    processedDraws: state.processedDraws + 1,
    scoreRows: [],
    recentRows: [...state.recentRows, row].slice(-RECENT_ROW_LIMIT),
    evaluationReservoir: nextReservoir(state.evaluationReservoir, row, state.randomSeed),
    runningSums: addToRunningSums(state.runningSums, pair),
  };
}

function compactState(state) {
  return {
    ...clone(state),
    scoreRows: [],
    recentRows: [...state.recentRows].slice(-RECENT_ROW_LIMIT),
    evaluationReservoir: [...state.evaluationReservoir]
      .sort(compareReservoirEntries)
      .slice(0, EVALUATION_RESERVOIR_LIMIT),
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
    evaluationReservoir: [],
    randomSeed: registration.parameters.random_seed,
    runningSums: emptyRunningSums(),
    rangeStart: null,
    rangeEnd: null,
    nextCursor: null,
    lastTargetDrawId: null,
    lastTargetIdentity: null,
  };
}

export function walkForwardEvidenceChunk({
  gameType,
  draws,
  rangeStart = 0,
  cursor,
  chunkSize,
  state,
  registration,
  baselineRegistration,
} = {}) {
  assertGameType(gameType);
  if (!Array.isArray(draws)) throw new TypeError("draws must be an array");
  assertCursor(cursor, draws);
  assertRangeStart(rangeStart, cursor);
  assertChunkSize(chunkSize);
  assertRegistration(registration, registration?.model_family, "registration");
  assertRegistration(baselineRegistration, "uniform-null", "baselineRegistration");
  if (registration.game_name !== GAME_CONFIG[gameType].name
    || baselineRegistration.game_name !== GAME_CONFIG[gameType].name) {
    throw new RangeError("experiment registrations must match gameType");
  }

  const immutableDraws = clone(draws);
  if (!state && cursor !== rangeStart) {
    throw new Error("checkpoint state is required when cursor is advanced beyond rangeStart");
  }
  let next = state
    ? clone(state)
    : createInitialEvidenceState(registration, baselineRegistration);
  if (next.rangeStart == null && next.processedDraws === 0) {
    next.rangeStart = rangeStart;
    next.rangeEnd = immutableDraws.length;
    next.nextCursor = cursor;
  }
  assertState(next, registration, baselineRegistration, {
    rangeStart,
    draws: immutableDraws,
    cursor,
  });
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
    next = accumulateEvidencePair(next, {
      baseline: scoreEvidenceForecast({ forecast: baseline, draw: target, config: GAME_CONFIG[gameType] }),
      candidate: scoreEvidenceForecast({ forecast: candidate, draw: target, config: GAME_CONFIG[gameType] }),
    });
    next.nextCursor = targetIndex + 1;
    next.lastTargetDrawId = String(target.draw_id);
    next.lastTargetIdentity = targetIdentity(target);
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
  snapshot,
  registration,
  baselineRegistration,
  state,
  resampling,
} = {}) {
  if (!Array.isArray(draws)) throw new TypeError("draws must be the frozen snapshot array");
  assertRegistration(registration, registration?.model_family, "registration");
  assertRegistration(baselineRegistration, "uniform-null", "baselineRegistration");
  assertState(state, registration, baselineRegistration);
  const compact = compactState(state);
  const evaluationRows = compact.evaluationReservoir
    .map((entry) => entry.row)
    .sort(compareEvidenceRows);
  const fullRun = evaluateCandidateSeries({
    candidateRows: evaluationRows.map((row) => row.candidate),
    baselineRows: evaluationRows.map((row) => row.baseline),
    seed: compact.randomSeed,
    resampling,
  });
  const statisticalPopulation = {
    method: RESERVOIR_METHOD,
    populationSampleCount: compact.processedDraws,
    evaluatorSampleCount: fullRun.sampleCount,
    capacity: EVALUATION_RESERVOIR_LIMIT,
    exact: compact.processedDraws <= EVALUATION_RESERVOIR_LIMIT,
    sampleDigest: await digestReplay(evaluationRows),
  };
  const detailWindow = evaluateCandidateSeries({
    candidateRows: compact.recentRows.map((row) => row.candidate),
    baselineRows: compact.recentRows.map((row) => row.baseline),
    seed: compact.randomSeed,
    resampling,
  });
  const frozenSnapshot = snapshot
    ? clone(snapshot)
    : {
      frozen: true,
      version: "lai-training-snapshot-v1",
      digest: await digestReplay(draws),
      draw_count: draws.length,
    };
  if (frozenSnapshot.draw_count !== draws.length || !/^[0-9a-f]{64}$/.test(frozenSnapshot.digest)) {
    throw new Error("frozen snapshot descriptor does not match the final evidence population");
  }
  const replay = {
    frozenSnapshot,
    registration: clone(registration),
    baselineRegistration: clone(baselineRegistration),
    state: compact,
  };
  return {
    metrics: {
      ...fullRun,
      statisticalPopulation,
      fullRun: { ...fullRun, statisticalPopulation },
      detailWindow: { ...detailWindow, retainedRows: compact.recentRows.length },
      recent: detailWindow,
      aggregates: compact.runningSums,
    },
    replayDigest: await digestReplay(replay),
  };
}
