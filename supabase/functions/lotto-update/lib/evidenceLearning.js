import { evaluateCandidateSeries, scoreEvidenceForecast } from "../../_shared/lai-v3/evaluation.js";
import { evaluatePromotionGate } from "../../_shared/lai-v3/promotionGate.js";
import { benjaminiHochberg } from "../../_shared/lai-v3/statistics.js";

const EVALUATOR_VERSION = "lai-v3-evidence-v1";

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

function registryIdOf(row) {
  return row?.registryId ?? row?.registry_id ?? null;
}

function modelNameOf(row) {
  return row?.modelName ?? row?.model_name ?? row?.name ?? null;
}

function familyOf(row) {
  return row?.family ?? row?.modelFamily ?? row?.model_family ?? null;
}

function asScoredRow(score, forecast, input) {
  return {
    forecast_id: forecast.id,
    registry_id: registryIdOf(forecast),
    game_name: input.gameName,
    model_name: modelNameOf(forecast),
    model_family: familyOf(forecast),
    forecast_mode: forecast.forecast_mode ?? forecast.forecastMode ?? "shadow",
    draw_id: String(input.draw.draw_id),
    draw_date: input.draw.draw_date,
    metrics: {
      main: score.main,
      special: score.special,
      combined: score.combined,
    },
    weight_before: null,
    weight_after: null,
    evaluator_version: EVALUATOR_VERSION,
    source_revision: input.sourceRevision,
    is_valid: true,
  };
}

function sourceRevisionOf(row) {
  return row?.source_revision ?? row?.sourceRevision ?? "original";
}

function isSameScore(row, score) {
  return row?.forecast_id === score.forecast_id
    && String(row?.draw_id) === String(score.draw_id)
    && sourceRevisionOf(row) === score.source_revision
    && row?.is_valid !== false;
}

function enrichHistoryRow(row) {
  const forecast = row?.forecast ?? {};
  const registry = forecast?.registry ?? {};
  return {
    ...row,
    registry_id: registryIdOf(row) ?? registryIdOf(forecast) ?? registryIdOf(registry),
    model_name: modelNameOf(row) ?? modelNameOf(forecast),
    model_family: familyOf(row) ?? familyOf(forecast) ?? familyOf(registry),
    forecast_mode: row?.forecast_mode ?? row?.forecastMode ?? forecast.forecast_mode ?? forecast.forecastMode ?? "shadow",
  };
}

function withFamilyIdentity(row) {
  return {
    ...row,
    drawId: String(row.draw_id),
    drawDate: row.draw_date,
    family: familyOf(row),
  };
}

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
    specialArea: evidence.specialArea
      ? { ...evidence.specialArea, adjustedQ: byRegistry.get(registryId) ?? null }
      : evidence.specialArea,
  }]));
}

async function buildEvidenceByRegistry(scoreRows, input, deps) {
  const history = (await deps.fetchValidScoreHistory(input.gameName, input.draw.draw_date)).map(enrichHistoryRow);
  const allRows = [...history];
  const registry = await deps.fetchRegistry(input.gameName);
  const registryById = new Map(registry.map((row) => [row.id, row]));
  const baselineRows = allRows
    .filter((row) => familyOf(row) === "uniform-null")
    .map(withFamilyIdentity);
  const candidates = registry.filter((row) => row.model_family !== "uniform-null");
  const evidence = {};

  for (const candidate of candidates) {
    const candidateRows = allRows
      .filter((row) => registryIdOf(row) === candidate.id)
      .map(withFamilyIdentity);
    if (!candidateRows.length) continue;
    if (!registryById.has(candidate.id)) continue;
    evidence[candidate.id] = evaluateCandidateSeries({
      candidateRows,
      baselineRows,
      seed: `${input.gameName}|${input.draw.draw_id}|${candidate.id}`,
    });
  }
  return { evidence: applyFamilyFdr(evidence), registryById, allRows };
}

function buildActivationState(activeState, decision, registry) {
  const status = decision.to_status;
  const weights = { ...(activeState.expert_weights || {}) };
  weights[registry.model_name] = Number(decision.authorized_weight ?? decision.authorizedWeight ?? 0);
  return {
    ...activeState,
    state_version: Number(activeState.state_version) + 1,
    champion_model: status === "champion" ? registry.model_name : activeState.champion_model,
    expert_weights: weights,
    metrics: {
      ...(activeState.metrics || {}),
      promotion_stage: status,
    },
  };
}

async function persistDecisionsAndAuthorizedActivations({ evidence, registryById, input, deps }) {
  const activeState = await deps.fetchActiveState(input.gameName);
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
      liveShadowDraws: candidateEvidence.sampleCount,
      canaryDraws: registry.status === "canary" ? candidateEvidence.sampleCount : 0,
      health: { dataValid: true, replayDigestValid: true, modelValid: true },
    });
    if (!gateDecision) continue;
    const persisted = await deps.recordDecision({
      registry_id: registryId,
      registryId,
      game_name: input.gameName,
      gameName: input.gameName,
      from_status: gateDecision.fromStatus,
      fromStatus: gateDecision.fromStatus,
      decision: gateDecision.decision,
      to_status: gateDecision.toStatus,
      toStatus: gateDecision.toStatus,
      gate_version: gateDecision.gateVersion,
      gateVersion: gateDecision.gateVersion,
      evidence: candidateEvidence,
      evidence_digest: gateDecision.evidenceDigest,
      evidenceDigest: gateDecision.evidenceDigest,
      reason: gateDecision.reason,
      authorized_weight: gateDecision.authorizedWeight,
      authorizedWeight: gateDecision.authorizedWeight,
    });
    const outcome = {
      registryId,
      ...gateDecision,
      decisionId: persisted?.id ?? null,
      evidence: candidateEvidence,
    };
    decisions.push(outcome);
    const persistedDecision = persisted?.decision ?? gateDecision.decision;
    const persistedStatus = persisted?.to_status ?? persisted?.toStatus ?? gateDecision.toStatus;
    if (persistedDecision === "promote" && ["canary", "champion"].includes(persistedStatus)) {
      const state = buildActivationState(activeState, outcome, registry);
      activations.push(await deps.activateAuthorizedState(persisted, state));
    }
  }
  return { decisions, activation: activations.length ? activations : null };
}

export async function runEvidenceLearning(input, deps) {
  const forecasts = await deps.fetchV3Forecasts(input.gameName, input.draw.draw_date);
  const failures = [];
  const validForecasts = [];
  for (const forecast of forecasts) {
    try {
      if (!registryIdOf(forecast) || !forecast?.id || !modelNameOf(forecast) || !familyOf(forecast)) {
        throw new Error("forecast is missing LAI v3 registry identity");
      }
      const score = scoreEvidenceForecast({ forecast, draw: input.draw, config: input.config });
      validForecasts.push({ forecast, score });
    } catch (error) {
      const failure = {
        registryId: registryIdOf(forecast),
        forecastId: forecast?.id ?? null,
        experimentRunId: forecast?.experimentRunId ?? forecast?.experiment_run_id ?? null,
        message: error instanceof Error ? error.message : String(error),
      };
      failures.push(failure);
      await deps.recordFailure(failure);
    }
  }
  if (!validForecasts.length) {
    return { status: "no_v3_forecasts", scoresWritten: 0, decisions: [], activation: null, failures };
  }

  const scoreRows = validForecasts.map(({ forecast, score }) => asScoredRow(score, forecast, input));
  const existing = (await deps.fetchValidScoreHistory(input.gameName, input.draw.draw_date)).map(enrichHistoryRow);
  if (input.correction) {
    const oldScores = existing.filter((row) => String(row.draw_id) === String(input.draw.draw_id)
      && sourceRevisionOf(row) === input.correction.previousRevision && row.is_valid !== false);
    if (!oldScores.length) {
      return { status: "already_scored", scoresWritten: 0, decisions: [], activation: null, failures };
    }
    const oldByForecast = new Map(oldScores.map((row) => [row.forecast_id, row]));
    const replacementScores = scoreRows.map((row) => {
      const superseded = oldByForecast.get(row.forecast_id);
      if (!superseded?.id) throw new Error(`correction is missing a prior score for forecast ${row.forecast_id}`);
      return { ...row, supersedes_score_id: superseded.id };
    });
    if (replacementScores.length !== oldScores.length) {
      throw new Error("correction forecasts do not match every prior valid score");
    }
    await deps.recordCorrection({
      game_name: input.gameName,
      draw_id: String(input.draw.draw_id),
      previous_revision: input.correction.previousRevision,
      corrected_revision: input.sourceRevision,
      previous_draw: input.correction.previousDraw,
      corrected_draw: input.draw,
      invalidated_score_ids: oldScores.map((row) => row.id),
      replacement_scores: replacementScores,
      reason: input.correction.reason ?? "official_draw_payload_changed",
    });
    const persistence = await persistDecisionsAndAuthorizedActivations({
      ...(await buildEvidenceByRegistry(replacementScores, input, deps)),
      input,
      deps,
    });
    return { status: "corrected", scoresWritten: replacementScores.length, failures, ...persistence };
  }

  const pending = scoreRows.filter((row) => !existing.some((stored) => isSameScore(stored, row)));
  if (!pending.length) {
    return { status: "already_scored", scoresWritten: 0, decisions: [], activation: null, failures };
  }
  await deps.insertScoresIdempotently(pending);
  const persistence = await persistDecisionsAndAuthorizedActivations({
    ...(await buildEvidenceByRegistry(pending, input, deps)),
    input,
    deps,
  });
  return { status: "learned", scoresWritten: pending.length, failures, ...persistence };
}
