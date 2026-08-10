import { evaluateCandidateSeries, scoreEvidenceForecast } from "../../_shared/lai-v3/evaluation.js";
import { evaluatePromotionGate } from "../../_shared/lai-v3/promotionGate.js";
import { benjaminiHochberg } from "../../_shared/lai-v3/statistics.js";
import { GAME_CONFIG } from "../../lotto-predict-notify/lib/gameConfig.js";

const EVALUATOR_VERSION = "lai-v3-evidence-v1";
const ORIGINAL_REVISION = "original";

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function registryIdOf(row) { return row?.registryId ?? row?.registry_id ?? null; }
function modelNameOf(row) { return row?.modelName ?? row?.model_name ?? row?.name ?? null; }
function familyOf(row) { return row?.family ?? row?.modelFamily ?? row?.model_family ?? null; }
function sourceRevisionOf(row) { return row?.source_revision ?? row?.sourceRevision ?? ORIGINAL_REVISION; }

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function assertGameConfig(gameName, config) {
  const expected = Object.values(GAME_CONFIG).find((candidate) => candidate.name === gameName);
  const shape = (candidate) => ({
    maxNumber: candidate?.maxNumber,
    picks: candidate?.picks,
    secondaryNumber: candidate?.secondaryNumber
      ? { maxNumber: candidate.secondaryNumber.maxNumber, picks: candidate.secondaryNumber.picks }
      : null,
  });
  if (!expected || stableJson(shape(config)) !== stableJson(shape(expected))) {
    throw new Error(`game config does not match ${gameName}`);
  }
  return config;
}

function canonicalActual(numbers, specialNumber, config, label) {
  if (!config || !Number.isInteger(config.picks) || !Number.isInteger(config.maxNumber)) {
    throw new Error(`${label} requires a valid game config`);
  }
  if (!Array.isArray(numbers) || numbers.length !== config.picks) {
    throw new Error(`${label} actual_numbers count must equal ${config.picks}`);
  }
  if (numbers.some((value) => !Number.isInteger(value))) {
    throw new Error(`${label} actual_numbers must contain integers`);
  }
  if (numbers.some((value) => value < 1 || value > config.maxNumber)) {
    throw new Error(`${label} actual_numbers must stay within 1..${config.maxNumber}`);
  }
  if (new Set(numbers).size !== numbers.length) {
    throw new Error(`${label} actual_numbers must be unique`);
  }
  const specialConfig = config.secondaryNumber ?? null;
  if (specialConfig) {
    if (!Number.isInteger(specialNumber) || specialNumber < 1 || specialNumber > specialConfig.maxNumber) {
      throw new Error(`${label} actual_special_number must stay within 1..${specialConfig.maxNumber}`);
    }
  } else if (specialNumber != null && (!Number.isInteger(specialNumber) || specialNumber < 1 || specialNumber > config.maxNumber)) {
    throw new Error(`${label} actual_special_number must be null or stay within 1..${config.maxNumber}`);
  }
  return { numbers: [...numbers].sort((left, right) => left - right), special_number: specialNumber ?? null };
}

function actualFromDraw(draw, config) {
  return canonicalActual(draw?.numbers, draw?.special_number ?? draw?.specialNumber ?? null, config, "confirmed draw");
}

function actualFromScore(row, config) {
  const metrics = assertPlainObject(row?.metrics, "valid LAI v3 score metrics");
  return canonicalActual(metrics.actual_numbers, metrics.actual_special_number ?? null, config, "valid LAI v3 score");
}

function sameActual(left, right) {
  return stableJson(left) === stableJson(right);
}

function assertRegistry(registry, gameName) {
  const byId = new Map();
  for (const row of registry || []) {
    if (!row?.id || row.game_name !== gameName || !modelNameOf(row) || !familyOf(row)) {
      throw new Error("LAI v3 registry identity is incomplete or belongs to another game");
    }
    if (byId.has(row.id)) throw new Error(`LAI v3 registry has duplicate id ${row.id}`);
    byId.set(row.id, row);
  }
  const baselines = [...byId.values()].filter((row) => familyOf(row) === "uniform-null" && row.status === "baseline");
  if (baselines.length !== 1) throw new Error("LAI v3 requires exactly one same-game uniform-null baseline");
  return { byId, baseline: baselines[0] };
}

function enrichForecast(forecast, registryById, gameName) {
  const registry = registryById.get(registryIdOf(forecast));
  if (!forecast?.id || !registry || registry.game_name !== gameName) {
    throw new Error("forecast registry identity is missing or does not match the game");
  }
  if (modelNameOf(forecast) !== registry.model_name) {
    throw new Error("forecast model identity does not match its registry");
  }
  const embedded = forecast.registry;
  if (embedded && (embedded.id !== registry.id || embedded.game_name !== registry.game_name || embedded.model_name !== registry.model_name || familyOf(embedded) !== familyOf(registry))) {
    throw new Error("forecast embedded registry identity does not match registry_id");
  }
  return { ...forecast, model_family: registry.model_family, registry };
}

function enrichHistoryRow(row, registryById, gameName) {
  const forecast = row?.forecast ?? {};
  const embeddedRegistry = forecast?.registry ?? {};
  const registryId = registryIdOf(row) ?? registryIdOf(forecast) ?? registryIdOf(embeddedRegistry);
  const registry = registryById.get(registryId);
  if (!registry || registry.game_name !== gameName
    || registryIdOf(forecast) !== registry.id
    || embeddedRegistry.id !== registry.id
    || embeddedRegistry.game_name !== registry.game_name
    || modelNameOf(forecast) !== registry.model_name
    || modelNameOf(embeddedRegistry) !== registry.model_name
    || familyOf(embeddedRegistry) !== familyOf(registry)) {
    throw new Error("valid LAI v3 score history has unverifiable forecast-registry identity");
  }
  return {
    ...row,
    registry_id: registryId,
    model_name: registry.model_name,
    model_family: registry.model_family,
    forecast_mode: forecast.forecast_mode ?? forecast.forecastMode ?? "shadow",
  };
}

function isIsoDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function validateScoreHistory(rows, registryById, input) {
  const enriched = [];
  const drawDateById = new Map();
  const drawIdByDate = new Map();
  const actualByRevision = new Map();
  const validForecastDraws = new Set();

  for (const raw of rows) {
    const row = enrichHistoryRow(raw, registryById, input.gameName);
    const forecast = row.forecast;
    if (!row.id || !row.forecast_id || !row.draw_id || !isIsoDate(row.draw_date)
      || row.game_name !== input.gameName || row.is_valid === false
      || typeof row.source_revision !== "string" || !row.source_revision.trim()) {
      throw new Error("valid LAI v3 score history identity is incomplete or belongs to another game");
    }
    if (forecast.id !== row.forecast_id || forecast.game_name !== row.game_name
      || forecast.target_draw_date !== row.draw_date) {
      throw new Error("valid LAI v3 score history forecast and draw date identity do not match");
    }

    const forecastDrawKey = scoreKey(row.forecast_id, row.draw_id);
    if (validForecastDraws.has(forecastDrawKey)) {
      throw new Error(`multiple valid LAI v3 scores exist for forecast ${row.forecast_id} and draw ${row.draw_id}`);
    }
    validForecastDraws.add(forecastDrawKey);

    const drawId = String(row.draw_id);
    if (drawDateById.has(drawId) && drawDateById.get(drawId) !== row.draw_date) {
      throw new Error("valid LAI v3 score history draw identity maps one draw id to multiple dates");
    }
    if (drawIdByDate.has(row.draw_date) && drawIdByDate.get(row.draw_date) !== drawId) {
      throw new Error("valid LAI v3 score history draw identity maps one date to multiple draw ids");
    }
    drawDateById.set(drawId, row.draw_date);
    drawIdByDate.set(row.draw_date, drawId);

    const actual = actualFromScore(row, input.config);
    const revisionKey = `${row.game_name}|${drawId}|${sourceRevisionOf(row)}`;
    const canonical = stableJson(actual);
    if (actualByRevision.has(revisionKey) && actualByRevision.get(revisionKey) !== canonical) {
      throw new Error("same draw and revision score history must share one canonical actual payload");
    }
    actualByRevision.set(revisionKey, canonical);
    enriched.push(row);
  }
  return enriched;
}

function asScoredRow(score, forecast, input, sourceRevision = ORIGINAL_REVISION) {
  const actual = actualFromDraw(input.draw, input.config);
  return {
    forecast_id: forecast.id,
    registry_id: registryIdOf(forecast),
    game_name: input.gameName,
    model_name: modelNameOf(forecast),
    model_family: familyOf(forecast),
    forecast_mode: forecast.forecast_mode ?? forecast.forecastMode ?? "shadow",
    draw_id: String(input.draw.draw_id),
    draw_date: input.draw.draw_date,
    metrics: { main: score.main, special: score.special, combined: score.combined, actual_numbers: actual.numbers, actual_special_number: actual.special_number },
    weight_before: null,
    weight_after: null,
    evaluator_version: EVALUATOR_VERSION,
    source_revision: sourceRevision,
    is_valid: true,
  };
}

function hasCurrentActualScore(scoreHistory, score, input) {
  const matching = scoreHistory.filter((row) => row?.forecast_id === score.forecast_id && String(row?.draw_id) === String(score.draw_id) && row?.is_valid !== false);
  if (matching.length > 1) throw new Error(`multiple valid LAI v3 scores exist for forecast ${score.forecast_id} and draw ${score.draw_id}`);
  if (!matching.length) return false;
  return sameActual(actualFromScore(matching[0], input.config), actualFromDraw(input.draw, input.config));
}

function withFamilyIdentity(row) { return { ...row, drawId: String(row.draw_id), drawDate: row.draw_date, family: familyOf(row) }; }

export function applyFamilyFdr(evidenceByRegistry) {
  const entries = Object.entries(evidenceByRegistry);
  const finite = entries.filter(([, evidence]) => Number.isFinite(evidence?.permutationP));
  const adjusted = benjaminiHochberg(finite.map(([, evidence]) => evidence.permutationP));
  const byRegistry = new Map(finite.map(([registryId], index) => [registryId, adjusted[index]]));
  return Object.fromEntries(entries.map(([registryId, evidence]) => [registryId, {
    ...evidence,
    adjustedQ: byRegistry.get(registryId) ?? null,
    main: evidence.main ? { ...evidence.main, adjustedQ: byRegistry.get(registryId) ?? null } : evidence.main,
    combined: evidence.combined ? { ...evidence.combined, adjustedQ: byRegistry.get(registryId) ?? null } : evidence.combined,
    specialArea: evidence.specialArea ? { ...evidence.specialArea, adjustedQ: byRegistry.get(registryId) ?? null } : evidence.specialArea,
  }]));
}

function compareOrderedRows(left, right, orderFields) {
  for (const field of orderFields) {
    const leftValue = left?.[field];
    const rightValue = right?.[field];
    if (leftValue == null || rightValue == null) throw new Error(`stable pagination order field ${field} is missing`);
    const leftText = String(leftValue);
    const rightText = String(rightValue);
    const comparison = leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function parseContentRange(contentRange) {
  if (typeof contentRange !== "string") throw new Error("stable pagination requires a Content-Range total");
  const populated = contentRange.match(/^(\d+)-(\d+)\/(\d+)$/);
  if (populated) return { start: Number(populated[1]), end: Number(populated[2]), total: Number(populated[3]) };
  const empty = contentRange.match(/^\*\/(\d+)$/);
  if (empty) return { start: null, end: null, total: Number(empty[1]) };
  throw new Error("stable pagination requires valid Content-Range coordinates and total");
}

async function scanStablePages({ fetchPage, orderFields, identityFields, pageSize, maxRows, maxPages, pass }) {
  const collected = [];
  const ids = new Set();
  let expectedTotal = null;
  let offset = 0;
  let previous = null;

  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    const requestedEnd = offset + pageSize - 1;
    const pageResult = await fetchPage({ offset, limit: pageSize, requestedEnd, pass });
    const rows = pageResult?.rows;
    if (!Array.isArray(rows)) throw new Error("stable pagination page rows must be an array");
    const range = parseContentRange(pageResult?.contentRange);
    if (!Number.isSafeInteger(range.total) || range.total < 0) throw new Error("stable pagination total is invalid");
    if (range.total > maxRows) throw new Error("stable pagination exceeds the bounded row limit");
    if (expectedTotal != null && range.total !== expectedTotal) throw new Error("stable pagination total changed between pages");
    expectedTotal = range.total;

    if (!rows.length) {
      if (offset === 0 && range.total === 0 && range.start == null && range.end == null) return collected;
      throw new Error("stable pagination returned a missing page");
    }
    if (range.start !== offset || range.end !== offset + rows.length - 1 || range.end > requestedEnd) {
      throw new Error("stable pagination Content-Range coordinates do not match the requested range and page length");
    }

    for (const row of rows) {
      const identityParts = identityFields.map((field) => row?.[field]);
      if (identityParts.some((value) => typeof value !== "string" || !value)) throw new Error("stable pagination row identity is required");
      const identity = identityParts.join("\u0000");
      if (ids.has(identity)) throw new Error(`stable pagination duplicate ${identityFields.length === 1 && identityFields[0] === "id" ? "id" : "identity"} ${identityParts.join("|")}`);
      if (previous && compareOrderedRows(previous, row, orderFields) >= 0) {
        throw new Error("stable pagination composite order must be strictly increasing");
      }
      ids.add(identity);
      collected.push(row);
      previous = row;
    }
    if (collected.length > expectedTotal) throw new Error("stable pagination exceeded its Content-Range total");
    if (collected.length === expectedTotal) return collected;
    offset += rows.length;
  }
  throw new Error("stable pagination exceeded the bounded page limit");
}

export async function readStablePaginatedRows({
  fetchPage,
  orderFields,
  identityFields = ["id"],
  pageSize = 1000,
  maxRows = 100000,
  maxPages = 200,
}) {
  if (typeof fetchPage !== "function" || !Array.isArray(orderFields) || !orderFields.length || !Array.isArray(identityFields) || !identityFields.length) {
    throw new Error("stable pagination requires fetchPage, orderFields, and identityFields");
  }
  if (![pageSize, maxRows, maxPages].every((value) => Number.isInteger(value) && value > 0)) {
    throw new Error("stable pagination bounds must be positive integers");
  }
  const first = await scanStablePages({ fetchPage, orderFields, identityFields, pageSize, maxRows, maxPages, pass: 1 });
  const second = await scanStablePages({ fetchPage, orderFields, identityFields, pageSize, maxRows, maxPages, pass: 2 });
  if (stableJson(first) !== stableJson(second)) throw new Error("stable pagination detected same-snapshot drift");
  return first;
}

function drawKey(draw) { return `${draw?.game_name}|${String(draw?.draw_id)}`; }
function drawDateKey(row) { return `${row?.game_name}|${row?.draw_date ?? row?.target_draw_date}`; }
function scoreKey(forecastId, drawId) { return `${forecastId}|${String(drawId)}`; }

export function buildV3PendingWorklist({ confirmedDraws = [], draws = [], forecasts = [], scores = [], configByGame = {} }) {
  const drawsByDate = new Map();
  for (const draw of draws) {
    const config = configByGame[draw?.game_name];
    assertGameConfig(draw?.game_name, config);
    actualFromDraw(draw, config);
    const key = drawDateKey(draw);
    if (!draw?.draw_id || !draw?.draw_date || drawsByDate.has(key)) {
      throw new Error("durable v3 worklist requires one confirmed draw per game and draw date");
    }
    drawsByDate.set(key, draw);
  }

  const forecastsById = new Map();
  for (const forecast of forecasts) {
    if (!forecast?.id || !forecast?.registry_id || !forecast?.game_name || !isIsoDate(forecast?.target_draw_date)
      || forecastsById.has(forecast.id)) {
      throw new Error("durable v3 worklist forecast identity is incomplete or duplicated");
    }
    forecastsById.set(forecast.id, forecast);
  }

  const validScoresByForecastDraw = new Map();
  for (const score of scores) {
    if (score?.is_valid === false) continue;
    if (!score?.forecast_id || !score?.draw_id || !score?.game_name || !isIsoDate(score?.draw_date)) {
      throw new Error("durable v3 worklist score identity is incomplete");
    }
    const forecast = forecastsById.get(score.forecast_id);
    const draw = forecast ? drawsByDate.get(drawDateKey(forecast)) : null;
    if (!forecast || !draw || score.game_name !== forecast.game_name || score.game_name !== draw.game_name
      || score.draw_date !== forecast.target_draw_date || score.draw_date !== draw.draw_date
      || String(score.draw_id) !== String(draw.draw_id)) {
      throw new Error("durable v3 worklist score draw date, draw, and forecast identity do not match");
    }
    actualFromScore(score, configByGame[score.game_name]);
    const key = scoreKey(score.forecast_id, score.draw_id);
    if (validScoresByForecastDraw.has(key)) throw new Error("durable v3 worklist found duplicate valid forecast and draw scores");
    validScoresByForecastDraw.set(key, score);
  }

  const pending = new Map();
  for (const draw of confirmedDraws) {
    actualFromDraw(draw, configByGame[draw?.game_name]);
    pending.set(drawKey(draw), draw);
  }
  for (const forecast of forecasts) {
    const draw = drawsByDate.get(drawDateKey(forecast));
    if (!draw) continue;
    const currentActual = actualFromDraw(draw, configByGame[draw.game_name]);
    const score = validScoresByForecastDraw.get(scoreKey(forecast.id, draw.draw_id));
    if (score && score.game_name !== draw.game_name) throw new Error("durable v3 worklist score belongs to another game");
    if (!score || !sameActual(actualFromScore(score, configByGame[draw.game_name]), currentActual)) {
      pending.set(drawKey(draw), draw);
    }
  }

  return [...pending.values()].sort((left, right) => (
    String(left.draw_date).localeCompare(String(right.draw_date)) ||
    String(left.game_name).localeCompare(String(right.game_name)) ||
    String(left.draw_id).localeCompare(String(right.draw_id))
  ));
}

async function buildEvidenceByRegistry(history, registryById, baseline, input) {
  const allRows = history.map((row) => withFamilyIdentity(row));
  const baselineRows = allRows.filter((row) => registryIdOf(row) === baseline.id);
  if (!baselineRows.length) return { evidence: {}, reason: "missing_baseline_score_history" };
  const evidence = {};
  for (const candidate of registryById.values()) {
    if (candidate.id === baseline.id) continue;
    const candidateRows = allRows.filter((row) => registryIdOf(row) === candidate.id);
    if (!candidateRows.length) continue;
    evidence[candidate.id] = evaluateCandidateSeries({ candidateRows, baselineRows, seed: `${input.gameName}|${input.draw.draw_id}|${candidate.id}` });
  }
  return { evidence: applyFamilyFdr(evidence), reason: null };
}

function lifecycleCounters(input, registry) {
  const lifecycle = input.lifecycleEvidence?.[registry.id] ?? {};
  return {
    liveShadowDraws: Number.isInteger(lifecycle.liveShadowDraws) && lifecycle.liveShadowDraws >= 0 ? lifecycle.liveShadowDraws : 0,
    canaryDraws: Number.isInteger(lifecycle.canaryDraws) && lifecycle.canaryDraws >= 0 ? lifecycle.canaryDraws : 0,
  };
}

function assertActivationContext(context, input) {
  const state = context?.activeState;
  if (!state || state.game_name !== input.gameName || !Number.isInteger(state.state_version) || !state.learning_claim_token || !state.prediction_source_key || String(state.last_learned_draw_id) !== String(input.draw.draw_id) || state.last_learned_draw_date !== input.draw.draw_date) {
    throw new Error("LAI v3 activation requires a complete active-state claim contract");
  }
  return state;
}

function assertDecisionActiveState(state, input) {
  const weights = state?.expert_weights;
  const config = state?.learning_config;
  const metrics = state?.metrics;
  const weightEntries = weights && typeof weights === "object" && !Array.isArray(weights)
    ? Object.entries(weights)
    : [];
  const weightsValid = weightEntries.length > 0
    && weightEntries.every(([name, weight]) => typeof name === "string" && name.length > 0
      && typeof weight === "number" && Number.isFinite(weight) && weight >= 0)
    && weightEntries.reduce((total, [, weight]) => total + weight, 0) > 0;
  const championWeight = weights?.[state?.champion_model];
  const configValid = config && typeof config === "object" && !Array.isArray(config)
    && typeof config.gamma === "number" && Number.isFinite(config.gamma) && config.gamma >= 0;
  const metricsValid = metrics && typeof metrics === "object" && !Array.isArray(metrics)
    && Number.isInteger(metrics.evaluated_draws) && metrics.evaluated_draws >= 0
    && (metrics.promotion_stage === undefined
      || ["baseline", "registered", "historical_passed", "shadow_verified", "canary", "champion", "cooldown", "disabled"].includes(metrics.promotion_stage));
  if (!state || state.game_name !== input.gameName
    || !Number.isSafeInteger(state.state_version) || state.state_version < 0
    || !["baseline", "champion", "degraded"].includes(state.status)
    || typeof state.champion_model !== "string" || !state.champion_model
    || !weightsValid || typeof championWeight !== "number" || !Number.isFinite(championWeight) || championWeight <= 0
    || !configValid || !metricsValid) {
    throw new Error("LAI v3 decision requires a complete active state game, version, and model source contract");
  }
  return state;
}

function buildActivationState(activeState, decision, registry) {
  const weights = { ...(activeState.expert_weights || {}) };
  weights[registry.model_name] = Number(decision.authorized_weight ?? decision.authorizedWeight ?? 0);
  return { ...activeState, state_version: Number(activeState.state_version) + 1, champion_model: decision.toStatus === "champion" ? registry.model_name : activeState.champion_model, expert_weights: weights, metrics: { ...(activeState.metrics || {}), promotion_stage: decision.toStatus } };
}

async function persistDecisionsAndAuthorizedActivations({ evidence, registryById, input, deps }) {
  const decisions = [];
  const activations = [];
  const entries = Object.entries(evidence);
  if (!entries.length) return { decisions, activation: null };
  const decisionActiveState = assertDecisionActiveState(await deps.fetchActiveState(input.gameName), input);
  for (const [registryId, candidateEvidence] of entries) {
    const registry = registryById.get(registryId);
    const evidenceDigest = await sha256(stableJson(candidateEvidence));
    const gateDecision = evaluatePromotionGate({
      stage: registry.status,
      evidence: candidateEvidence,
      evidenceDigest,
      previousEvidenceDigest: null,
      ...lifecycleCounters(input, registry),
      health: { dataValid: true, replayDigestValid: true, modelValid: true },
    });
    if (!gateDecision) continue;
    let activationState = null;
    if (input.activationAuthorized === true && gateDecision.decision === "promote" && ["canary", "champion"].includes(gateDecision.toStatus)) {
      activationState = assertActivationContext(await deps.fetchActivationContext?.(input.gameName, registryId), input);
      if (Number(activationState.state_version) !== Number(decisionActiveState.state_version)) {
        throw new Error("LAI v3 activation claim state does not match the validated decision state");
      }
    }
    const persisted = await deps.recordDecision({ registry_id: registryId, registryId, game_name: input.gameName, gameName: input.gameName, from_status: gateDecision.fromStatus, fromStatus: gateDecision.fromStatus, decision: gateDecision.decision, to_status: gateDecision.toStatus, toStatus: gateDecision.toStatus, gate_version: gateDecision.gateVersion, gateVersion: gateDecision.gateVersion, evidence: candidateEvidence, evidence_digest: gateDecision.evidenceDigest, evidenceDigest: gateDecision.evidenceDigest, reason: gateDecision.reason, authorized_weight: gateDecision.authorizedWeight, authorizedWeight: gateDecision.authorizedWeight });
    const outcome = { registryId, ...gateDecision, decisionId: persisted?.id ?? null, evidence: candidateEvidence };
    decisions.push(outcome);
    if (activationState && persisted?.authorized === true && persisted?.decision === "promote" && ["canary", "champion"].includes(persisted?.to_status ?? persisted?.toStatus)) {
      activations.push(await deps.activateAuthorizedState(persisted, buildActivationState(activationState, outcome, registry)));
    }
  }
  return { decisions, activation: activations.length ? activations : null };
}

function groupCorrectionRows(entries, draw, label) {
  if (!entries.length) return [];
  const payloads = new Set(entries.map(({ actual }) => stableJson(actual)));
  if (payloads.size !== 1) throw new Error(`${label} must share one canonical actual payload`);
  const groups = new Map();
  for (const entry of entries) {
    const revision = sourceRevisionOf(entry.row);
    if (!entry.row.id) throw new Error(`${label} requires durable score ids`);
    if (!groups.has(revision)) groups.set(revision, []);
    groups.get(revision).push(entry.row);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([previousRevision, oldScores]) => ({
      previousRevision,
      oldScores: oldScores.sort((left, right) => String(left.id).localeCompare(String(right.id))),
      previousActual: entries.find(({ row }) => sourceRevisionOf(row) === previousRevision).actual,
      draw,
    }));
}

function findCorrectionGroups(scoreHistory, draw, config) {
  const sameDraw = scoreHistory.filter((row) => String(row.draw_id) === String(draw.draw_id) && row.is_valid !== false);
  const currentActual = actualFromDraw(draw, config);
  const stale = sameDraw.map((row) => ({ row, actual: actualFromScore(row, config) }))
    .filter(({ actual }) => !sameActual(actual, currentActual));
  return groupCorrectionRows(stale, draw, "stale rows for one previous revision");
}

function findNormalizationGroups(scoreHistory, draw, correctedRevision, config) {
  const currentActual = actualFromDraw(draw, config);
  const current = scoreHistory
    .filter((row) => String(row.draw_id) === String(draw.draw_id) && row.is_valid !== false)
    .map((row) => ({ row, actual: actualFromScore(row, config) }))
    .filter(({ actual }) => sameActual(actual, currentActual));
  if (!current.some(({ row }) => sourceRevisionOf(row) === correctedRevision)) return [];
  return groupCorrectionRows(
    current.filter(({ row }) => sourceRevisionOf(row) !== correctedRevision),
    draw,
    "normalization rows",
  );
}

function canonicalDrawPayload(draw, config) {
  const actual = actualFromDraw(draw, config);
  return {
    game_name: draw.game_name,
    draw_id: String(draw.draw_id),
    draw_date: draw.draw_date,
    numbers: actual.numbers,
    special_number: actual.special_number,
  };
}

async function recordCorrectionGroups({ groups, eventType, reason, scoreRowsByForecast, input, deps }) {
  let replacementsWritten = 0;
  for (const group of groups) {
    if (group.oldScores.some((row) => !scoreRowsByForecast.has(row.forecast_id))) {
      throw new Error("correction requires replacement forecasts for every stale score");
    }
    const replacementScores = group.oldScores.map((oldScore) => ({
      ...scoreRowsByForecast.get(oldScore.forecast_id),
      source_revision: input.sourceRevision,
      supersedes_score_id: oldScore.id,
    }));
    const invalidatedScoreIds = group.oldScores.map((row) => String(row.id));
    const eventDigest = await sha256(stableJson({
      event_type: eventType,
      game_name: input.gameName,
      draw_id: String(input.draw.draw_id),
      previous_revision: group.previousRevision,
      corrected_revision: input.sourceRevision,
      invalidated_score_ids: invalidatedScoreIds,
    }));
    await deps.recordCorrection({
      event_key: `${eventType}:${eventDigest}`,
      game_name: input.gameName,
      draw_id: String(input.draw.draw_id),
      previous_revision: group.previousRevision,
      corrected_revision: input.sourceRevision,
      previous_draw: {
        game_name: input.gameName,
        draw_id: String(input.draw.draw_id),
        draw_date: input.draw.draw_date,
        numbers: group.previousActual.numbers,
        special_number: group.previousActual.special_number,
      },
      corrected_draw: canonicalDrawPayload(input.draw, input.config),
      invalidated_score_ids: invalidatedScoreIds,
      replacement_scores: replacementScores,
      reason,
    });
    replacementsWritten += replacementScores.length;
  }
  return replacementsWritten;
}

export async function runEvidenceLearning(input, deps) {
  if (typeof input?.sourceRevision !== "string" || !input.sourceRevision.trim()) {
    throw new Error("LAI v3 evidence learning requires a non-empty source revision");
  }
  assertGameConfig(input.gameName, input.config);
  const registryRows = await deps.fetchRegistry(input.gameName);
  let registry;
  try { registry = assertRegistry(registryRows, input.gameName); } catch (error) {
    return { status: "blocked_registry", scoresWritten: 0, decisions: [], activation: null, failures: [{ message: error instanceof Error ? error.message : String(error) }] };
  }
  let scoreHistory = validateScoreHistory(
    await deps.fetchValidScoreHistory(input.gameName, input.draw.draw_date),
    registry.byId,
    input,
  );
  const correctionGroups = findCorrectionGroups(scoreHistory, input.draw, input.config);
  const forecasts = await deps.fetchV3Forecasts(input.gameName, input.draw.draw_date);
  if (correctionGroups.length && !forecasts.length) throw new Error("correction requires replacement forecasts");
  const failures = [];
  const validForecasts = [];
  for (const rawForecast of forecasts) {
    try {
      const forecast = enrichForecast(rawForecast, registry.byId, input.gameName);
      const score = scoreEvidenceForecast({ forecast, draw: input.draw, config: input.config });
      validForecasts.push({ forecast, score });
    } catch (error) {
      const failure = { registryId: registryIdOf(rawForecast), forecastId: rawForecast?.id ?? null, experimentRunId: rawForecast?.experimentRunId ?? rawForecast?.experiment_run_id ?? null, message: error instanceof Error ? error.message : String(error) };
      failures.push(failure);
      await deps.recordFailure(failure);
    }
  }
  if (correctionGroups.length && !validForecasts.length) throw new Error("correction requires replacement forecasts");
  if (!validForecasts.length) return { status: "no_v3_forecasts", scoresWritten: 0, decisions: [], activation: null, failures };
  if (!validForecasts.some(({ forecast }) => registryIdOf(forecast) === registry.baseline.id)) {
    return { status: "blocked_registry", scoresWritten: 0, decisions: [], activation: null, failures };
  }
  const scoreRows = validForecasts.map(({ forecast, score }) => asScoredRow(score, forecast, input, ORIGINAL_REVISION));
  const scoreRowsByForecast = new Map(scoreRows.map((row) => [row.forecast_id, row]));
  if (scoreRowsByForecast.size !== scoreRows.length) throw new Error("correction has duplicate scored forecasts");

  let scoresWritten = await recordCorrectionGroups({
    groups: correctionGroups,
    eventType: "actual-correction",
    reason: "official_draw_payload_changed",
    scoreRowsByForecast,
    input,
    deps,
  });

  if (correctionGroups.length) {
    scoreHistory = validateScoreHistory(
      await deps.fetchValidScoreHistory(input.gameName, input.draw.draw_date),
      registry.byId,
      input,
    );
  }

  const pending = scoreRows.filter((row) => !hasCurrentActualScore(scoreHistory, row, input));
  if (pending.length) {
    await deps.insertScoresIdempotently(pending);
    scoresWritten += pending.length;
    scoreHistory = validateScoreHistory(
      await deps.fetchValidScoreHistory(input.gameName, input.draw.draw_date),
      registry.byId,
      input,
    );
  }

  const normalizationGroups = findNormalizationGroups(
    scoreHistory,
    input.draw,
    input.sourceRevision,
    input.config,
  );
  scoresWritten += await recordCorrectionGroups({
    groups: normalizationGroups,
    eventType: "revision-normalization",
    reason: "late_score_revision_normalization",
    scoreRowsByForecast,
    input,
    deps,
  });

  if (!scoresWritten) return { status: "already_scored", scoresWritten: 0, decisions: [], activation: null, failures };
  if (normalizationGroups.length) {
    scoreHistory = validateScoreHistory(
      await deps.fetchValidScoreHistory(input.gameName, input.draw.draw_date),
      registry.byId,
      input,
    );
  }
  const built = await buildEvidenceByRegistry(scoreHistory, registry.byId, registry.baseline, input);
  const status = correctionGroups.length ? "corrected" : normalizationGroups.length ? "normalized" : "learned";
  if (built.reason) return { status: `${status}_without_decision`, scoresWritten, failures, decisions: [], activation: null, reason: built.reason };
  return { status, scoresWritten, failures, ...(await persistDecisionsAndAuthorizedActivations({ evidence: built.evidence, registryById: registry.byId, input, deps })) };
}
