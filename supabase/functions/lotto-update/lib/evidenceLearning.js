import { evaluateCandidateSeries, scoreEvidenceForecast } from "../../_shared/lai-v3/evaluation.js";
import { evaluatePromotionGate } from "../../_shared/lai-v3/promotionGate.js";
import { benjaminiHochberg } from "../../_shared/lai-v3/statistics.js";

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
function normalizeNumbers(numbers) { return [...(numbers || [])].map(Number).filter(Number.isFinite).sort((a, b) => a - b); }

function canonicalActual(draw) {
  return {
    numbers: normalizeNumbers(draw?.numbers),
    special_number: draw?.special_number == null ? null : Number(draw.special_number),
  };
}

function sameActual(left, right) {
  return JSON.stringify(canonicalActual(left)) === JSON.stringify(canonicalActual(right));
}

function actualFromScore(row) {
  const metrics = row?.metrics || {};
  if (!Array.isArray(metrics.actual_numbers)) return null;
  return {
    numbers: normalizeNumbers(metrics.actual_numbers),
    special_number: metrics.actual_special_number == null ? null : Number(metrics.actual_special_number),
  };
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
  if (!registry || registry.game_name !== gameName || modelNameOf(forecast) !== registry.model_name || familyOf(embeddedRegistry) !== familyOf(registry)) {
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

function asScoredRow(score, forecast, input, sourceRevision = ORIGINAL_REVISION) {
  const actual = canonicalActual(input.draw);
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

function isSameScore(row, score) {
  return row?.forecast_id === score.forecast_id && String(row?.draw_id) === String(score.draw_id) && sourceRevisionOf(row) === score.source_revision && row?.is_valid !== false;
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

function buildActivationState(activeState, decision, registry) {
  const weights = { ...(activeState.expert_weights || {}) };
  weights[registry.model_name] = Number(decision.authorized_weight ?? decision.authorizedWeight ?? 0);
  return { ...activeState, state_version: Number(activeState.state_version) + 1, champion_model: decision.toStatus === "champion" ? registry.model_name : activeState.champion_model, expert_weights: weights, metrics: { ...(activeState.metrics || {}), promotion_stage: decision.toStatus } };
}

async function persistDecisionsAndAuthorizedActivations({ evidence, registryById, input, deps }) {
  const decisions = [];
  const activations = [];
  for (const [registryId, candidateEvidence] of Object.entries(evidence)) {
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

function findCorrection(scoreHistory, draw) {
  const sameDraw = scoreHistory.filter((row) => String(row.draw_id) === String(draw.draw_id) && row.is_valid !== false);
  const stale = sameDraw.filter((row) => {
    const actual = actualFromScore(row);
    if (!actual) throw new Error("valid LAI v3 score lacks durable actual draw payload for correction");
    return !sameActual(actual, draw);
  });
  if (!stale.length) return null;
  const revisions = [...new Set(stale.map(sourceRevisionOf))];
  if (revisions.length !== 1 || stale.some((row) => !row.id)) {
    throw new Error("stale LAI v3 scores do not satisfy one durable previous revision correction contract");
  }
  return { oldScores: stale, previousRevision: revisions[0], previousDraw: { game_name: draw.game_name, draw_id: String(draw.draw_id), draw_date: draw.draw_date, ...actualFromScore(stale[0]) } };
}

export async function runEvidenceLearning(input, deps) {
  const registryRows = await deps.fetchRegistry(input.gameName);
  let registry;
  try { registry = assertRegistry(registryRows, input.gameName); } catch (error) {
    return { status: "blocked_registry", scoresWritten: 0, decisions: [], activation: null, failures: [{ message: error instanceof Error ? error.message : String(error) }] };
  }
  const scoreHistory = (await deps.fetchValidScoreHistory(input.gameName, input.draw.draw_date)).map((row) => enrichHistoryRow(row, registry.byId, input.gameName));
  const correction = findCorrection(scoreHistory, input.draw);
  const forecasts = await deps.fetchV3Forecasts(input.gameName, input.draw.draw_date);
  if (correction && !forecasts.length) throw new Error("correction requires replacement forecasts");
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
  if (correction && !validForecasts.length) throw new Error("correction requires replacement forecasts");
  if (!validForecasts.length) return { status: "no_v3_forecasts", scoresWritten: 0, decisions: [], activation: null, failures };
  if (!validForecasts.some(({ forecast }) => registryIdOf(forecast) === registry.baseline.id)) {
    return { status: "blocked_registry", scoresWritten: 0, decisions: [], activation: null, failures };
  }
  const scoreRows = validForecasts.map(({ forecast, score }) => asScoredRow(score, forecast, input, correction ? input.sourceRevision : ORIGINAL_REVISION));
  if (correction) {
    const oldByForecast = new Map(correction.oldScores.map((row) => [row.forecast_id, row]));
    if (oldByForecast.size !== scoreRows.length || scoreRows.some((row) => !oldByForecast.has(row.forecast_id))) throw new Error("correction forecasts do not match every prior valid score");
    const replacementScores = scoreRows.map((row) => ({ ...row, supersedes_score_id: oldByForecast.get(row.forecast_id).id }));
    await deps.recordCorrection({ game_name: input.gameName, draw_id: String(input.draw.draw_id), previous_revision: correction.previousRevision, corrected_revision: input.sourceRevision, previous_draw: correction.previousDraw, corrected_draw: input.draw, invalidated_score_ids: correction.oldScores.map((row) => row.id), replacement_scores: replacementScores, reason: "official_draw_payload_changed" });
    const updatedHistory = (await deps.fetchValidScoreHistory(input.gameName, input.draw.draw_date)).map((row) => enrichHistoryRow(row, registry.byId, input.gameName));
    const built = await buildEvidenceByRegistry(updatedHistory, registry.byId, registry.baseline, input);
    if (built.reason) return { status: "corrected_without_decision", scoresWritten: replacementScores.length, failures, decisions: [], activation: null, reason: built.reason };
    return { status: "corrected", scoresWritten: replacementScores.length, failures, ...(await persistDecisionsAndAuthorizedActivations({ evidence: built.evidence, registryById: registry.byId, input, deps })) };
  }
  const currentRows = scoreHistory.filter((row) => String(row.draw_id) === String(input.draw.draw_id));
  if (currentRows.length && currentRows.every((row) => sameActual(actualFromScore(row), input.draw))) return { status: "already_scored", scoresWritten: 0, decisions: [], activation: null, failures };
  const pending = scoreRows.filter((row) => !scoreHistory.some((stored) => isSameScore(stored, row)));
  if (!pending.length) return { status: "already_scored", scoresWritten: 0, decisions: [], activation: null, failures };
  await deps.insertScoresIdempotently(pending);
  const updatedHistory = (await deps.fetchValidScoreHistory(input.gameName, input.draw.draw_date)).map((row) => enrichHistoryRow(row, registry.byId, input.gameName));
  const built = await buildEvidenceByRegistry(updatedHistory, registry.byId, registry.baseline, input);
  if (built.reason) return { status: "scored_without_decision", scoresWritten: pending.length, failures, decisions: [], activation: null, reason: built.reason };
  return { status: "learned", scoresWritten: pending.length, failures, ...(await persistDecisionsAndAuthorizedActivations({ evidence: built.evidence, registryById: registry.byId, input, deps })) };
}
