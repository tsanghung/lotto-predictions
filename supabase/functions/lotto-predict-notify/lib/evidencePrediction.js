import { createHash } from "node:crypto";

import { buildEvidenceForecasts } from "../../_shared/lai-v3/models.js";
import { aggregateForecasts } from "./ensemble.js";
import { GAME_CONFIG } from "./gameConfig.js";
import {
  optimizeEvidenceGroups,
  optimizeEvidencePowerGroups,
} from "./evidenceOptimizer.js";
import { notificationKey, sourceKey } from "./predictCore.js";

const APPROVED_REGISTRY_STATUSES = new Set(["baseline", "canary", "champion"]);
const APPROVED_STAGES = new Set(["baseline", "canary", "champion"]);
const CODE_COMMIT_PATTERN = /^[0-9a-f]{7,64}$/;
const OPTIMIZER_VERSION = "evidence-constrained-v1";

function clone(value) {
  return structuredClone(value);
}

function rejectIncompleteState() {
  throw new Error("no_complete_approved_state");
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical JSON requires finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError("canonical JSON requires plain objects, arrays, and JSON primitives");
  }
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(",")}}`;
}

function digestSnapshot(snapshot) {
  return createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
}

function assertCompleteInput(input, config) {
  const {
    targetDrawDate,
    generatedAt,
    dataStatus,
    codeCommit,
    approvedState,
    approvedRegistrations,
    shadowRegistrations,
    draws,
  } = input;
  if (!config || dataStatus !== "complete" || !CODE_COMMIT_PATTERN.test(codeCommit ?? "")) {
    rejectIncompleteState();
  }
  if (
    typeof targetDrawDate !== "string"
    || !/^\d{4}-\d{2}-\d{2}$/.test(targetDrawDate)
    || typeof generatedAt !== "string"
    || !generatedAt.startsWith(`${targetDrawDate}T`)
    || Number.isNaN(Date.parse(generatedAt))
    || !Array.isArray(draws)
    || draws.length === 0
    || !Array.isArray(approvedRegistrations)
    || approvedRegistrations.length === 0
    || !Array.isArray(shadowRegistrations)
  ) {
    rejectIncompleteState();
  }
  if (
    !approvedState
    || typeof approvedState !== "object"
    || approvedState.game_name !== config.name
    || !Number.isInteger(approvedState.state_version)
    || approvedState.state_version < 0
    || !["baseline", "champion"].includes(approvedState.status)
    || typeof approvedState.champion_model !== "string"
    || !approvedState.champion_model.trim()
  ) {
    rejectIncompleteState();
  }

  const metrics = approvedState.metrics;
  const ci = metrics?.brier_ci;
  if (
    !metrics
    || !APPROVED_STAGES.has(metrics.promotion_stage)
    || !Number.isFinite(metrics.brier_skill)
    || !ci
    || !Number.isFinite(ci.lower95)
    || !Number.isFinite(ci.upper95)
    || ci.lower95 > ci.upper95
  ) {
    rejectIncompleteState();
  }

  const weights = approvedState.expert_weights;
  if (!weights || typeof weights !== "object" || Array.isArray(weights)) {
    rejectIncompleteState();
  }
  const weightEntries = Object.entries(weights);
  const weightTotal = weightEntries.reduce((sum, [, weight]) => sum + weight, 0);
  if (
    weightEntries.length === 0
    || weightEntries.some(([, weight]) => !Number.isFinite(weight) || weight < 0)
    || Math.abs(weightTotal - 1) > 1e-9
  ) {
    rejectIncompleteState();
  }

  const ids = new Set();
  const names = new Set();
  for (const registration of approvedRegistrations) {
    if (
      !registration
      || typeof registration !== "object"
      || !APPROVED_REGISTRY_STATUSES.has(registration.status)
      || registration.game_name !== config.name
      || registration.code_commit !== codeCommit
      || typeof registration.id !== "string"
      || !registration.id.trim()
      || typeof registration.model_name !== "string"
      || !registration.model_name.trim()
      || ids.has(registration.id)
      || names.has(registration.model_name)
    ) {
      rejectIncompleteState();
    }
    ids.add(registration.id);
    names.add(registration.model_name);
  }
  if (
    !names.has(approvedState.champion_model)
    || weightEntries.some(([name, weight]) => weight > 0 && !names.has(name))
  ) {
    rejectIncompleteState();
  }
  if (
    metrics.promotion_stage === "champion"
    && !approvedRegistrations.some((registration) => (
      registration.model_name === approvedState.champion_model
      && registration.status === "champion"
    ))
  ) {
    rejectIncompleteState();
  }
  if (
    metrics.promotion_stage === "canary"
    && !approvedRegistrations.some((registration) => registration.status === "canary")
  ) {
    rejectIncompleteState();
  }
}

function publicEvidence(approvedState) {
  const metrics = approvedState.metrics;
  const sampleSource = metrics.sample_counts && typeof metrics.sample_counts === "object"
    ? metrics.sample_counts
    : {};
  const sampleCounts = {};
  for (const field of [
    "evaluated_draws",
    "historical_draws",
    "shadow_draws",
    "canary_draws",
    "recent_draws",
    "candidate_draws",
    "baseline_draws",
  ]) {
    const value = field === "evaluated_draws"
      ? sampleSource[field] ?? metrics.evaluated_draws
      : sampleSource[field];
    if (Number.isInteger(value) && value >= 0) sampleCounts[field] = value;
  }
  return {
    champion_model: approvedState.champion_model,
    promotion_stage: metrics.promotion_stage,
    sample_counts: sampleCounts,
    brier_skill: metrics.brier_skill,
    brier_ci: clone(metrics.brier_ci),
    decision_reason: typeof metrics.decision_reason === "string"
      ? metrics.decision_reason
      : "approved_state",
    evidence_status: "尚無證據優於隨機",
    limitation: "分組僅重播已核准量化證據，不構成隨機開獎的因果解釋或預測優勢。",
  };
}

function safeForecast(forecast, additions) {
  const { parameters: _parameters, ...safe } = forecast;
  return {
    ...clone(safe),
    ...clone(additions),
  };
}

function latestDrawDate(draws) {
  return draws.reduce((latest, draw) => (
    typeof draw?.draw_date === "string" && draw.draw_date > latest ? draw.draw_date : latest
  ), "");
}

export async function generateEvidencePrediction(input = {}) {
  const config = GAME_CONFIG[input.gameType];
  assertCompleteInput(input, config);
  const {
    gameType,
    targetDrawDate,
    generatedAt,
    dataStatus,
    codeCommit,
    approvedState,
    approvedRegistrations,
    shadowRegistrations,
    draws,
  } = input;

  const approvedForecasts = buildEvidenceForecasts({
    gameType,
    draws,
    generatedAt,
    registrations: approvedRegistrations,
    mode: "shadow",
  });
  if (
    approvedForecasts.length !== approvedRegistrations.length
    || approvedForecasts.some((forecast) => forecast.status !== "completed")
  ) {
    rejectIncompleteState();
  }
  const completedByName = new Map(approvedForecasts.map((forecast) => [forecast.name, forecast]));
  if (Object.entries(approvedState.expert_weights).some(([name, weight]) => (
    weight > 0 && !completedByName.has(name)
  ))) {
    rejectIncompleteState();
  }

  let aggregated;
  try {
    aggregated = aggregateForecasts({
      forecasts: approvedForecasts,
      activeState: approvedState,
      config,
    });
  } catch {
    rejectIncompleteState();
  }
  const seed = `${config.name}|${targetDrawDate}|lai-v3|state-${approvedState.state_version}|${codeCommit}`;
  const optimized = config.secondaryNumber
    ? optimizeEvidencePowerGroups({
        mainProbabilities: aggregated.probabilities,
        specialProbabilities: aggregated.specialProbabilities,
        config,
        seed,
      })
    : optimizeEvidenceGroups({
        probabilities: aggregated.probabilities,
        config,
        seed,
        minUtilityRatio: 0.90,
        maxOverlap: Math.floor(config.picks / 3),
      });
  const evidence = publicEvidence(approvedState);
  const combinations = {
    "證據主攻": clone(optimized.evidenceAttack),
    "覆蓋保底": clone(optimized.coverageFallback),
  };
  const specialCombinations = config.secondaryNumber
    ? {
        "證據主攻": clone(optimized.specialEvidenceAttack),
        "覆蓋保底": clone(optimized.specialCoverageFallback),
      }
    : null;
  const optimizerConfig = {
    version: OPTIMIZER_VERSION,
    max_number: config.maxNumber,
    picks: config.picks,
    min_utility_ratio: 0.90,
    max_overlap: Math.floor(config.picks / 3),
    ...(config.secondaryNumber
      ? {
          special_max_number: config.secondaryNumber.maxNumber,
          special_picks: config.secondaryNumber.picks,
          special_min_utility_ratio: 0,
          special_max_overlap: 0,
        }
      : {}),
  };
  const record = {
    timestamp: generatedAt,
    game_name: config.name,
    is_offline: false,
    prediction: {
      model: "lai-v3",
      engine: "lai-v3-evidence-agent",
      reasoning_source: "computed_evidence_only",
      agent_status: approvedState.status,
      agent_state_version: approvedState.state_version,
      combinations: clone(combinations),
      ...(specialCombinations ? { special_combinations: clone(specialCombinations) } : {}),
      group_metrics: clone(optimized.metrics),
      ...(optimized.specialMetrics ? { special_group_metrics: clone(optimized.specialMetrics) } : {}),
      evidence: clone(evidence),
    },
    is_evaluated: false,
    evaluation: { draw_id: null, actual_numbers: [], strategies: {} },
  };
  const championRegistration = approvedRegistrations.find((registration) => (
    registration.model_name === approvedState.champion_model
  ));
  const snapshotWithoutDigest = {
    prediction_source_key: sourceKey(config.name, targetDrawDate),
    game_name: config.name,
    target_draw_date: targetDrawDate,
    champion_registry_id: championRegistration.id,
    agent_state_version: approvedState.state_version,
    model_version: "lai-v3",
    data_cutoff: latestDrawDate(draws),
    data_status: dataStatus,
    main_probabilities: clone(aggregated.probabilities),
    special_probabilities: aggregated.specialProbabilities
      ? clone(aggregated.specialProbabilities)
      : null,
    groups: {
      combinations: clone(combinations),
      special_combinations: clone(specialCombinations),
      optimizer_config: optimizerConfig,
      state: {
        status: approvedState.status,
        state_version: approvedState.state_version,
        champion_model: approvedState.champion_model,
        promotion_stage: approvedState.metrics.promotion_stage,
        expert_weights: clone(approvedState.expert_weights),
      },
      registry_versions: approvedRegistrations.map((registration) => ({
        id: registration.id,
        model_name: registration.model_name,
        model_family: registration.model_family,
        model_version: registration.model_version,
        feature_version: registration.feature_version,
        code_commit: registration.code_commit,
        status: registration.status,
        random_seed: registration.parameters?.random_seed ?? null,
      })),
      public_evidence: clone(evidence),
    },
    group_metrics: {
      main: clone(optimized.metrics),
      special: clone(optimized.specialMetrics ?? null),
    },
    optimizer_version: OPTIMIZER_VERSION,
    random_seed: seed,
    code_commit: codeCommit,
    notification_key: notificationKey(config.name, targetDrawDate, "prediction"),
    generated_at: generatedAt,
  };
  const evidenceSnapshot = {
    ...snapshotWithoutDigest,
    replay_digest: digestSnapshot(snapshotWithoutDigest),
  };
  const shadowForecasts = buildEvidenceForecasts({
    gameType,
    draws,
    generatedAt,
    registrations: shadowRegistrations,
    mode: "shadow",
  }).map((forecast) => safeForecast(forecast, {
    forecast_mode: "shadow",
    active_weight: 0,
    evidence: clone(evidence),
  }));
  const formalForecasts = approvedForecasts.map((forecast) => safeForecast(forecast, {
    forecast_mode: approvedRegistrations.find((registration) => (
      registration.id === forecast.registryId
    ))?.status === "canary" ? "canary" : "production",
    active_weight: approvedState.expert_weights[forecast.name] ?? 0,
    evidence: clone(evidence),
  }));
  formalForecasts.push({
    status: "completed",
    registryId: championRegistration.id,
    name: "evidence-ensemble",
    family: "approved-evidence-ensemble",
    version: "lai-v3",
    featureVersion: OPTIMIZER_VERSION,
    codeCommit,
    randomSeed: seed,
    probabilities: clone(aggregated.probabilities),
    specialProbabilities: clone(aggregated.specialProbabilities),
    featureSummary: {
      optimizerConfig: clone(optimizerConfig),
      groupMetrics: clone(optimized.metrics),
      specialGroupMetrics: clone(optimized.specialMetrics ?? null),
    },
    forecast_mode: "production",
    active_weight: 1,
    final_groups: {
      combinations: clone(combinations),
      ...(specialCombinations ? { special_combinations: clone(specialCombinations) } : {}),
    },
    evidence: clone(evidence),
  });

  return {
    record,
    forecasts: [...formalForecasts, ...shadowForecasts],
    evidenceSnapshot,
  };
}
