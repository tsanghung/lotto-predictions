import { createBaselineState } from "../../lotto-predict-notify/lib/agentState.js";
import { updateHedgeWeights } from "../../lotto-predict-notify/lib/ensemble.js";
import { buildExpertForecasts, EXPERT_VERSIONS } from "../../lotto-predict-notify/lib/experts.js";
import { GAME_CONFIG } from "../../lotto-predict-notify/lib/gameConfig.js";
import {
  brierScore,
  brierSkillScore,
  combinedAreaBrier,
  logLoss,
} from "../../lotto-predict-notify/lib/scoring.js";
import {
  canonicalJson,
  createInitialEvidenceState,
  digestReplay,
  finalizeEvidenceRun,
  walkForwardEvidenceChunk,
} from "./evidenceTraining.js";

const RECENT_SCORE_LIMIT = 500;

const GAME_TYPES_BY_NAME = Object.fromEntries(
  Object.entries(GAME_CONFIG).map(([gameType, config]) => [config.name, gameType]),
);

function clone(value) {
  return structuredClone(value);
}

function assertGameType(gameType) {
  if (typeof gameType !== "string" || !GAME_CONFIG[gameType]) {
    throw new RangeError("gameType must be one of 539, 649, or power");
  }
}

function isIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function compareDraws(left, right) {
  return left.draw_date.localeCompare(right.draw_date)
    || String(left.draw_id).localeCompare(String(right.draw_id), undefined, { numeric: true });
}

function assertNumbers(numbers, config, label) {
  if (!Array.isArray(numbers) || numbers.length !== config.picks) {
    throw new RangeError(`${label}.numbers must contain exactly ${config.picks} values`);
  }
  const unique = new Set();
  for (const value of numbers) {
    if (!Number.isInteger(value) || value < 1 || value > config.maxNumber) {
      throw new RangeError(`${label}.numbers must be integers from 1 to ${config.maxNumber}`);
    }
    if (unique.has(value)) {
      throw new RangeError(`${label}.numbers must not contain duplicates`);
    }
    unique.add(value);
  }
}

function assertDraws(draws, gameType) {
  if (!Array.isArray(draws)) throw new TypeError("draws must be an array");
  const config = GAME_CONFIG[gameType];
  for (let index = 0; index < draws.length; index += 1) {
    const draw = draws[index];
    const label = `draws[${index}]`;
    if (!draw || typeof draw !== "object") throw new TypeError(`${label} must be an object`);
    if (typeof draw.draw_id !== "string" || !draw.draw_id.trim()) {
      throw new TypeError(`${label}.draw_id must be a non-empty string`);
    }
    if (!isIsoDate(draw.draw_date)) throw new RangeError(`${label}.draw_date must be an ISO date`);
    assertNumbers(draw.numbers, config, label);
    if (config.secondaryNumber) {
      const special = draw.special_number;
      if (!Number.isInteger(special) || special < 1 || special > config.secondaryNumber.maxNumber) {
        throw new RangeError(`${label}.special_number must be an integer from 1 to ${config.secondaryNumber.maxNumber}`);
      }
    }
    if (index > 0 && compareDraws(draws[index - 1], draw) >= 0) {
      throw new RangeError("draws must be in strict chronological order");
    }
  }
}

function assertState(state, gameType) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new TypeError("state must be an object");
  }
  if (state.game_name !== GAME_CONFIG[gameType].name) {
    throw new RangeError("state.game_name does not match gameType");
  }
  if (!Number.isInteger(state.state_version) || state.state_version < 0) {
    throw new RangeError("state.state_version must be a non-negative integer");
  }
  if (!state.expert_weights || typeof state.expert_weights !== "object") {
    throw new TypeError("state.expert_weights must be an object");
  }
  const entries = Object.entries(state.expert_weights);
  if (!entries.length || entries.some(([, weight]) => !Number.isFinite(weight) || weight < 0)) {
    throw new RangeError("state.expert_weights must contain finite non-negative weights");
  }
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  if (!(total > 0)) throw new RangeError("state.expert_weights must have positive total weight");
  const evaluatedDraws = state.metrics?.evaluated_draws;
  if (!Number.isInteger(evaluatedDraws) || evaluatedDraws < 0) {
    throw new RangeError("state.metrics.evaluated_draws must be a non-negative integer");
  }
}

function emptyMetricMaps() {
  return {
    cumulative_main_brier: {},
    cumulative_special_brier: {},
    cumulative_combined_brier: {},
    cumulative_brier_skill: {},
  };
}

export function createInitialTrainingState(gameType) {
  assertGameType(gameType);
  const state = createBaselineState({
    gameName: GAME_CONFIG[gameType].name,
    expertNames: Object.keys(EXPERT_VERSIONS),
    learningConfig: {
      algorithm_version: "lai-v2",
      gamma: 0.1,
      evaluation: "prequential_walk_forward",
    },
  });
  return {
    ...state,
    metrics: {
      evaluated_draws: 0,
      recent_model_scores: [],
      ...emptyMetricMaps(),
    },
  };
}

export function scoreTrainingForecast(forecast, target, config) {
  const mainBrier = brierScore(forecast.probabilities, target.numbers, config.maxNumber);
  const mainLogLoss = logLoss(forecast.probabilities, target.numbers, config.maxNumber);
  const metrics = {
    main_brier: mainBrier,
    main_log_loss: mainLogLoss,
    special_brier: null,
    special_log_loss: null,
    combined_brier: mainBrier,
  };
  if (config.secondaryNumber && Array.isArray(forecast.specialProbabilities)) {
    const specialNumbers = [target.special_number];
    metrics.special_brier = brierScore(
      forecast.specialProbabilities,
      specialNumbers,
      config.secondaryNumber.maxNumber,
    );
    metrics.special_log_loss = logLoss(
      forecast.specialProbabilities,
      specialNumbers,
      config.secondaryNumber.maxNumber,
    );
    metrics.combined_brier = combinedAreaBrier(metrics.main_brier, metrics.special_brier);
  }
  return metrics;
}

function scoreForecasts(forecasts, target, config, weights) {
  const byName = Object.fromEntries(
    forecasts.map((forecast) => [forecast.name, scoreTrainingForecast(forecast, target, config)]),
  );
  const baseline = byName.uniform;
  if (!baseline) throw new Error("uniform forecast is required for walk-forward scoring");

  for (const forecast of forecasts) {
    const metrics = byName[forecast.name];
    metrics.brier_skill = brierSkillScore(metrics.combined_brier, baseline.combined_brier);
    metrics.weight_before = weights[forecast.name] ?? null;
  }
  return byName;
}

function forecastSignature(forecasts) {
  const serialized = JSON.stringify(forecasts.map((forecast) => ({
    name: forecast.name,
    version: forecast.version,
    probabilities: forecast.probabilities,
    specialProbabilities: forecast.specialProbabilities,
  })));
  let hash = 0x811c9dc5;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function incrementMetricMap(target, name, value) {
  if (Number.isFinite(value)) target[name] = (target[name] ?? 0) + value;
}

function nextTrainingState(state, scores, target) {
  const recentModelScores = [
    ...(Array.isArray(state.metrics.recent_model_scores)
      ? state.metrics.recent_model_scores
      : []),
    {
      draw_id: String(target.draw_id),
      draw_date: target.draw_date,
      models: Object.fromEntries(Object.entries(scores).map(([name, score]) => [name, {
        brier: score.main_brier,
        combined_brier: score.combined_brier,
        special_brier: score.special_brier,
        brier_skill_score: score.brier_skill,
      }])),
    },
  ].slice(-RECENT_SCORE_LIMIT);
  const metrics = {
    ...(state.metrics || {}),
    evaluated_draws: state.metrics.evaluated_draws + 1,
    recent_model_scores: recentModelScores,
    cumulative_main_brier: { ...(state.metrics.cumulative_main_brier || {}) },
    cumulative_special_brier: { ...(state.metrics.cumulative_special_brier || {}) },
    cumulative_combined_brier: { ...(state.metrics.cumulative_combined_brier || {}) },
    cumulative_brier_skill: { ...(state.metrics.cumulative_brier_skill || {}) },
  };
  for (const [name, score] of Object.entries(scores)) {
    incrementMetricMap(metrics.cumulative_main_brier, name, score.main_brier);
    incrementMetricMap(metrics.cumulative_special_brier, name, score.special_brier);
    incrementMetricMap(metrics.cumulative_combined_brier, name, score.combined_brier);
    incrementMetricMap(metrics.cumulative_brier_skill, name, score.brier_skill);
  }

  const losses = Object.fromEntries(
    Object.entries(scores).map(([name, score]) => [name, score.combined_brier]),
  );
  const expertWeights = updateHedgeWeights({
    weights: state.expert_weights,
    losses,
    sampleCount: metrics.evaluated_draws,
    baselineName: "uniform",
    gamma: state.learning_config?.gamma ?? 0.1,
  });

  return {
    ...clone(state),
    state_version: state.state_version + 1,
    expert_weights: expertWeights,
    metrics,
    last_learned_draw_id: target.draw_id,
    last_learned_draw_date: target.draw_date,
  };
}

export function walkForwardChunk({ gameType, draws, cursor, chunkSize, state }) {
  assertGameType(gameType);
  assertDraws(draws, gameType);
  if (!Number.isInteger(cursor) || cursor < 0 || cursor > draws.length) {
    throw new RangeError("cursor must be an integer from 0 through draws.length");
  }
  if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > 100) {
    throw new RangeError("chunkSize must be an integer from 1 through 100");
  }
  assertState(state, gameType);

  const immutableDraws = clone(draws);
  let nextState = clone(state);
  const end = Math.min(cursor + chunkSize, immutableDraws.length);
  const steps = [];

  for (let targetIndex = cursor; targetIndex < end; targetIndex += 1) {
    const target = immutableDraws[targetIndex];
    const history = immutableDraws.slice(0, targetIndex);
    const forecasts = buildExpertForecasts({
      gameType,
      draws: history,
      generatedAt: `${target.draw_date}T10:00:00+08:00`,
    });
    const scores = scoreForecasts(forecasts, target, GAME_CONFIG[gameType], nextState.expert_weights);
    nextState = nextTrainingState(nextState, scores, target);
    steps.push({
      target_draw_id: target.draw_id,
      target_draw_date: target.draw_date,
      history_size: history.length,
      forecast_signature: forecastSignature(forecasts),
      metrics: scores,
    });
  }

  return {
    nextCursor: end,
    done: end >= immutableDraws.length,
    state: nextState,
    steps,
  };
}

export function validateTrainingRequest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("run_id and chunk_size are required");
  }
  if (typeof input.run_id !== "string" || !input.run_id.trim()) {
    throw new TypeError("run_id must be a non-empty string");
  }
  if (!Number.isInteger(input.chunk_size) || input.chunk_size < 1 || input.chunk_size > 100) {
    throw new RangeError("chunk_size must be an integer from 1 through 100");
  }
  return { runId: input.run_id.trim(), chunkSize: input.chunk_size };
}

export function isServiceRoleRequest(headers, secretKeys) {
  if (!Array.isArray(secretKeys) || !secretKeys.length) return false;
  const allowed = new Set(secretKeys.filter((value) => typeof value === "string" && value));
  const apiKey = typeof headers?.apikey === "string" ? headers.apikey : "";
  const authorization = typeof headers?.authorization === "string" ? headers.authorization : "";
  const bearer = authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice("bearer ".length).trim()
    : "";
  return allowed.has(apiKey) || allowed.has(bearer);
}

function assertAlgorithmVersion(run) {
  if (!["lai-v2", "lai-v3"].includes(run.algorithm_version)) {
    throw new RangeError("Training run algorithm_version must be lai-v2 or lai-v3");
  }
}

function assertTrainingRun(run) {
  if (!run || typeof run !== "object") throw new Error("Training run was not found");
  if (!GAME_TYPES_BY_NAME[run.game_name]) throw new RangeError("Training run has an unsupported game_name");
  assertAlgorithmVersion(run);
  if (!["queued", "running"].includes(run.status)) {
    throw new RangeError("Training run status must be queued or running");
  }
  for (const field of ["range_start", "range_end", "checkpoint_cursor"]) {
    if (!Number.isInteger(run[field]) || run[field] < 0) {
      throw new RangeError(`Training run ${field} must be a non-negative integer`);
    }
  }
  if (run.range_start > run.range_end) throw new RangeError("Training run range_start exceeds range_end");
  if (run.algorithm_version === "lai-v3" && run.checkpoint_cursor < run.range_start) {
    throw new RangeError("Training run checkpoint_cursor precedes range_start");
  }
  if (run.checkpoint_cursor > run.range_end) {
    throw new RangeError("Training run checkpoint_cursor exceeds range_end");
  }
}

function checkpointSummary(run, result, startedCursor, snapshot) {
  const summary = { ...(run.summary || {}) };
  delete summary.lease;
  return {
    ...summary,
    state: result.state,
    snapshot,
    last_chunk: {
      from_cursor: startedCursor,
      to_cursor: result.nextCursor,
      processed: result.steps.length,
      last_draw_id: result.steps.at(-1)?.target_draw_id ?? result.steps.at(-1)?.targetDrawId ?? null,
    },
  };
}

function assertV3Experiment(experiment, claimed) {
  if (!experiment || typeof experiment !== "object") {
    throw new Error("LAI v3 experiment run was not found");
  }
  if (experiment.id !== claimed.experiment_run_id) {
    throw new Error("LAI v3 experiment id does not match the training run");
  }
  if (experiment.game_name !== claimed.game_name) {
    throw new Error("LAI v3 experiment game_name does not match the training run");
  }
  for (const field of ["range_start", "range_end", "checkpoint_cursor"]) {
    if (!Number.isInteger(experiment[field]) || experiment[field] < 0) {
      throw new Error(`LAI v3 experiment ${field} is invalid`);
    }
  }
  if (experiment.range_start !== claimed.range_start || experiment.range_end !== claimed.range_end) {
    throw new Error("LAI v3 experiment range provenance does not match the training run");
  }
  if (experiment.checkpoint_cursor > claimed.checkpoint_cursor) {
    throw new Error("LAI v3 experiment checkpoint is ahead of its training run authority");
  }
  if (!['queued', 'running'].includes(experiment.status)) {
    throw new Error("LAI v3 experiment status must be queued or running");
  }
  if (claimed.summary?.experiment_run_id !== experiment.id
    || claimed.summary?.registry_id !== experiment.registry_id) {
    throw new Error("LAI v3 training summary provenance does not match the experiment");
  }
}

const ELIGIBLE_CANDIDATE_STATUSES = new Set([
  "registered",
  "historical_passed",
  "shadow_verified",
  "canary",
  "champion",
]);

function nonEmptyString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function v3Provenance({ claimed, experiment, registration, baselineRegistration, snapshot }) {
  if (!registration || registration.id !== experiment.registry_id) {
    throw new Error("LAI v3 candidate provenance does not match the experiment registry_id");
  }
  if (registration.model_family === "uniform-null") {
    throw new Error("LAI v3 candidate provenance cannot use the uniform-null family");
  }
  if (!ELIGIBLE_CANDIDATE_STATUSES.has(registration.status)) {
    throw new Error("LAI v3 candidate status is not eligible for evidence training");
  }
  if (!baselineRegistration || baselineRegistration.model_family !== "uniform-null"
    || baselineRegistration.status !== "baseline") {
    throw new Error("LAI v3 baseline provenance requires an eligible uniform-null baseline");
  }
  if (baselineRegistration.id === registration.id) {
    throw new Error("LAI v3 candidate and baseline ids must be different");
  }
  if (registration.game_name !== claimed.game_name || baselineRegistration.game_name !== claimed.game_name) {
    throw new Error("LAI v3 candidate and baseline game provenance must match the training run");
  }
  const candidateSeed = registration.parameters?.random_seed;
  nonEmptyString(String(candidateSeed ?? ""), "LAI v3 candidate random seed");
  nonEmptyString(String(baselineRegistration.parameters?.random_seed ?? ""), "LAI v3 baseline random seed");
  if (experiment.random_seed !== candidateSeed) {
    throw new Error("LAI v3 experiment seed provenance does not match the candidate");
  }
  if (experiment.code_commit !== registration.code_commit
    || baselineRegistration.code_commit !== registration.code_commit) {
    throw new Error("LAI v3 experiment, candidate, and baseline commit provenance must match");
  }
  if (experiment.feature_version !== registration.feature_version) {
    throw new Error("LAI v3 experiment feature provenance does not match the candidate");
  }
  if (experiment.data_cutoff !== snapshot.data_cutoff) {
    throw new Error("LAI v3 experiment cutoff provenance does not match the frozen snapshot");
  }
  return {
    experimentId: experiment.id,
    registryId: registration.id,
    baselineRegistryId: baselineRegistration.id,
    gameName: claimed.game_name,
    rangeStart: claimed.range_start,
    rangeEnd: claimed.range_end,
    dataCutoff: experiment.data_cutoff,
    randomSeed: experiment.random_seed,
    codeCommit: experiment.code_commit,
    featureVersion: experiment.feature_version,
    baselineSeed: baselineRegistration.parameters.random_seed,
    baselineFeatureVersion: baselineRegistration.feature_version,
    snapshotDigest: snapshot.digest,
  };
}

function assertCanonicalEqual(actual, expected, message) {
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error(message);
}

async function frozenSnapshotDescriptor(draws, claimed, createdAt) {
  const first = draws[0] ?? null;
  const last = draws.at(-1) ?? null;
  return {
    frozen: true,
    version: "lai-training-snapshot-v1",
    digest: await digestReplay({ version: "lai-training-snapshot-v1", draws }),
    draw_count: draws.length,
    range_start: claimed.range_start,
    range_end: claimed.range_end,
    first_draw_id: first ? String(first.draw_id) : null,
    first_draw_date: first?.draw_date ?? null,
    last_draw_id: last ? String(last.draw_id) : null,
    last_draw_date: last?.draw_date ?? null,
    data_cutoff: last?.draw_date ?? null,
    created_at: claimed.summary?.snapshot?.created_at || createdAt,
  };
}

function assertV3CheckpointContinuity(claimed, draws, snapshot) {
  const cursor = claimed.checkpoint_cursor;
  const summary = claimed.summary || {};
  if (cursor > claimed.range_start && !summary.state) {
    throw new Error("LAI v3 advanced cursor requires checkpoint state");
  }
  if (summary.last_chunk) {
    const chunk = summary.last_chunk;
    const expectedLast = cursor > claimed.range_start ? draws[cursor - 1] : null;
    if (chunk.to_cursor !== cursor
      || chunk.processed !== chunk.to_cursor - chunk.from_cursor
      || chunk.last_draw_id !== (expectedLast ? String(expectedLast.draw_id) : null)) {
      throw new Error("LAI v3 stale summary does not match checkpoint cursor continuity");
    }
  } else if (cursor > claimed.range_start) {
    throw new Error("LAI v3 stale summary is missing last_chunk continuity");
  }
  if (summary.snapshot) {
    assertCanonicalEqual(summary.snapshot, snapshot, "LAI v3 frozen snapshot digest drift was detected");
  }
}

function requireV3Repository(repository) {
  for (const name of [
    "fetchExperiment",
    "fetchRegistration",
    "fetchUniformBaseline",
    "saveExperimentCheckpoint",
    "completeExperiment",
    "failExperiment",
  ]) {
    if (typeof repository[name] !== "function") {
      throw new TypeError(`repository.${name} is required for LAI v3 training`);
    }
  }
}

function concurrencyConflict(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /already claimed|active processing lease|lost its concurrency lease/i.test(message);
}

async function reconcileCompletedV3Run(run, repository) {
  requireV3Repository(repository);
  const terminal = run.summary?.v3_terminal;
  if (!terminal || terminal.version !== "lai-v3-terminal-v1"
    || terminal.experimentId !== run.experiment_run_id
    || !terminal.evidence?.replayDigest
    || !terminal.experimentUpdatedAt) {
    throw new Error("Completed LAI v3 training run is missing recoverable terminal evidence");
  }
  const experiment = await repository.fetchExperiment(run.experiment_run_id);
  if (!experiment || experiment.id !== terminal.experimentId) {
    throw new Error("LAI v3 terminal experiment was not found");
  }
  if (experiment.status === "completed") {
    if (experiment.checkpoint_cursor !== run.range_end
      || experiment.replay_digest !== terminal.evidence.replayDigest) {
      throw new Error("LAI v3 completed terminal evidence conflicts with the experiment");
    }
    if (canonicalJson(experiment.metrics) !== canonicalJson(terminal.evidence.metrics)) {
      throw new Error("LAI v3 completed terminal metrics conflict with the experiment");
    }
    return clone(run);
  }
  if (!["queued", "running"].includes(experiment.status)
    || experiment.updated_at !== terminal.experimentUpdatedAt) {
    throw new Error("LAI v3 experiment completion lost its concurrency lease");
  }
  const completed = await repository.completeExperiment(experiment, {
    ...terminal.evidence,
    checkpointCursor: run.range_end,
  });
  if (!completed) throw new Error("LAI v3 experiment completion lost its concurrency lease");
  return clone(run);
}

async function reconcileFailedV3Run(run, repository) {
  requireV3Repository(repository);
  const terminal = run.summary?.v3_failure_terminal;
  if (!terminal || terminal.version !== "lai-v3-failure-v1"
    || terminal.experimentId !== run.experiment_run_id
    || !terminal.failure
    || terminal.failure.status !== "failed") {
    throw new Error("Failed LAI v3 training run is missing recoverable terminal evidence");
  }
  if (!terminal.followerRequired) return clone(run);
  if (!terminal.experimentUpdatedAt) {
    throw new Error("LAI v3 experiment failure terminal is missing its owned version");
  }
  const experiment = await repository.fetchExperiment(run.experiment_run_id);
  if (!experiment || experiment.id !== terminal.experimentId) {
    throw new Error("LAI v3 failed terminal experiment was not found");
  }
  if (experiment.status === "failed") {
    const actual = {
      status: experiment.status,
      error_text: experiment.error_text,
      completed_at: experiment.completed_at,
    };
    if (canonicalJson(actual) !== canonicalJson(terminal.failure)) {
      throw new Error("LAI v3 failed terminal evidence conflicts with the experiment");
    }
    return clone(run);
  }
  if (!["queued", "running"].includes(experiment.status)
    || experiment.updated_at !== terminal.experimentUpdatedAt) {
    throw new Error("LAI v3 experiment failure write lost its concurrency lease");
  }
  const failed = await repository.failExperiment(experiment, terminal.failure);
  if (!failed) throw new Error("LAI v3 experiment failure write lost its concurrency lease");
  return clone(run);
}

export async function executeTrainingRun({
  input,
  repository,
  now = () => new Date().toISOString(),
  token = () => crypto.randomUUID(),
  processors = {
    walkForwardV2Chunk: walkForwardChunk,
    walkForwardEvidenceChunk,
    createInitialEvidenceState,
    finalizeEvidenceRun,
  },
}) {
  const request = validateTrainingRequest(input);
  if (!repository || typeof repository.fetchRun !== "function") {
    throw new TypeError("repository.fetchRun is required");
  }

  const run = await repository.fetchRun(request.runId);
  if (!run) throw new Error("Training run was not found");
  assertAlgorithmVersion(run);
  if (run.status === "completed") {
    return run.algorithm_version === "lai-v3"
      ? reconcileCompletedV3Run(run, repository)
      : clone(run);
  }
  if (run.status === "failed" && run.algorithm_version === "lai-v3") {
    return reconcileFailedV3Run(run, repository);
  }
  assertTrainingRun(run);

  const claimedAt = now();
  const lease = { token: token(), claimed_at: claimedAt };
  const claimed = await repository.claimRun(run, lease);
  if (!claimed) throw new Error("Training run is already claimed by another invocation");
  assertTrainingRun(claimed);
  const isV3 = claimed.algorithm_version === "lai-v3";

  let experiment = null;
  let runCheckpointSaved = false;

  try {
    const gameType = GAME_TYPES_BY_NAME[claimed.game_name];
    if (isV3) {
      requireV3Repository(repository);
      if (typeof claimed.experiment_run_id !== "string" || !claimed.experiment_run_id) {
        throw new Error("LAI v3 training run requires an experiment_run_id");
      }
      experiment = await repository.fetchExperiment(claimed.experiment_run_id);
      assertV3Experiment(experiment, claimed);
      if (request.chunkSize > 25) {
        throw new RangeError("LAI v3 chunk_size must be from 1 through 25");
      }
    }
    if (typeof repository.ensureSnapshot !== "function") {
      throw new TypeError("repository.ensureSnapshot is required");
    }
    const snapshotCount = await repository.ensureSnapshot(claimed);
    if (snapshotCount !== claimed.range_end) {
      throw new Error("Training draw snapshot is incomplete; checkpoint cannot progress");
    }
    const draws = await repository.fetchDraws(claimed.id, claimed.range_end);
    if (!Array.isArray(draws) || draws.length !== claimed.range_end) {
      throw new Error("Training draw range is incomplete; checkpoint cannot progress");
    }
    const boundedDraws = clone(draws);
    assertDraws(boundedDraws, gameType);
    const cursor = isV3
      ? claimed.checkpoint_cursor
      : Math.max(claimed.checkpoint_cursor, claimed.range_start);
    const snapshot = isV3
      ? await frozenSnapshotDescriptor(boundedDraws, claimed, claimedAt)
      : {
        frozen: true,
        draw_count: snapshotCount,
        created_at: claimed.summary?.snapshot?.created_at || claimedAt,
      };
    let result;
    let v3Context = null;
    if (isV3) {
      const registration = await repository.fetchRegistration(experiment.registry_id);
      if (!registration || registration.id !== experiment.registry_id) {
        throw new Error("LAI v3 experiment candidate registration was not found");
      }
      const baselineRegistration = await repository.fetchUniformBaseline(claimed.game_name);
      const provenance = v3Provenance({
        claimed,
        experiment,
        registration,
        baselineRegistration,
        snapshot,
      });
      assertV3CheckpointContinuity(claimed, boundedDraws, snapshot);
      if (claimed.summary?.provenance) {
        assertCanonicalEqual(
          claimed.summary.provenance,
          provenance,
          "LAI v3 checkpoint provenance drift was detected",
        );
      } else if (cursor > claimed.range_start) {
        throw new Error("LAI v3 advanced cursor is missing checkpoint provenance");
      }
      if (experiment.checkpoint_cursor < cursor) {
        const synchronized = await repository.saveExperimentCheckpoint(experiment, {
          checkpoint_cursor: cursor,
          status: "running",
          error_text: null,
        });
        if (!synchronized) {
          throw new Error("LAI v3 experiment checkpoint lost its concurrency lease");
        }
        experiment = synchronized;
      }
      const state = claimed.summary?.state || processors.createInitialEvidenceState(
        registration,
        baselineRegistration,
      );
      result = processors.walkForwardEvidenceChunk({
        gameType,
        draws: boundedDraws,
        rangeStart: claimed.range_start,
        cursor,
        chunkSize: request.chunkSize,
        state,
        registration,
        baselineRegistration,
      });
      v3Context = { registration, baselineRegistration, provenance };
    } else {
      const state = claimed.summary?.state || createInitialTrainingState(gameType);
      result = processors.walkForwardV2Chunk({
        gameType,
        draws: boundedDraws,
        cursor,
        chunkSize: request.chunkSize,
        state,
      });
    }
    const expectedNextCursor = Math.min(cursor + request.chunkSize, claimed.range_end);
    if (!result || result.nextCursor !== expectedNextCursor
      || !Array.isArray(result.steps)
      || result.steps.length !== expectedNextCursor - cursor
      || result.done !== (expectedNextCursor === claimed.range_end)) {
      throw new Error("Training processor returned a discontinuous checkpoint");
    }

    const completed = result.nextCursor === claimed.range_end;
    const summary = checkpointSummary(claimed, result, cursor, snapshot);
    if (isV3) summary.provenance = v3Context.provenance;
    const checkpoint = {
      checkpoint_cursor: result.nextCursor,
      summary,
      status: completed ? "completed" : "running",
      error_text: null,
      completed_at: completed ? now() : null,
    };
    let evidence = null;
    if (isV3 && completed) {
      evidence = await processors.finalizeEvidenceRun({
        draws: boundedDraws,
        snapshot,
        registration: v3Context.registration,
        baselineRegistration: v3Context.baselineRegistration,
        state: result.state,
      });
      checkpoint.summary.v3_terminal = {
        version: "lai-v3-terminal-v1",
        experimentId: experiment.id,
        experimentUpdatedAt: experiment.updated_at,
        evidence,
      };
    }
    const saved = await repository.saveCheckpoint(claimed, checkpoint);
    if (!saved) throw new Error("Training checkpoint lost its concurrency lease");
    runCheckpointSaved = true;
    if (isV3) {
      const experimentSaved = completed
        ? await repository.completeExperiment(experiment, {
          ...evidence,
          checkpointCursor: result.nextCursor,
        })
        : await repository.saveExperimentCheckpoint(experiment, {
          checkpoint_cursor: result.nextCursor,
          status: "running",
          error_text: null,
        });
      if (!experimentSaved) {
        throw new Error(completed
          ? "LAI v3 experiment completion lost its concurrency lease"
          : "LAI v3 experiment checkpoint lost its concurrency lease");
      }
    }
    return saved;
  } catch (error) {
    if (runCheckpointSaved || (isV3 && concurrencyConflict(error))) throw error;
    const failure = {
      status: "failed",
      error_text: error instanceof Error ? error.message : String(error),
      completed_at: now(),
    };
    if (isV3) {
      const failureSummary = { ...(claimed.summary || {}) };
      delete failureSummary.lease;
      failureSummary.v3_failure_terminal = {
        version: "lai-v3-failure-v1",
        experimentId: claimed.experiment_run_id,
        experimentUpdatedAt: experiment?.updated_at ?? null,
        followerRequired: Boolean(experiment),
        failure,
      };
      let failedRun = null;
      try {
        failedRun = typeof repository.markFailed === "function"
          ? await repository.markFailed(claimed, { ...failure, summary: failureSummary })
          : null;
      } catch {
        throw new Error("LAI v3 failure write lost its concurrency lease", { cause: error });
      }
      if (!failedRun) {
        throw new Error("LAI v3 failure write lost its concurrency lease", { cause: error });
      }
      if (experiment) {
        let failedExperiment = null;
        try {
          failedExperiment = await repository.failExperiment(experiment, failure);
        } catch {
          throw new Error("LAI v3 experiment failure write lost its concurrency lease", { cause: error });
        }
        if (!failedExperiment) {
          throw new Error("LAI v3 experiment failure write lost its concurrency lease", { cause: error });
        }
      }
      throw error;
    }
    if (typeof repository.markFailed === "function") {
      try {
        await repository.markFailed(claimed, failure);
      } catch {
        // Preserve the original processing error while making failure marking best effort.
      }
    }
    throw error;
  }
}
