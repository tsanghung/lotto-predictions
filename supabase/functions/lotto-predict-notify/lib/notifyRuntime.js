export function parseBooleanEnvFlag(value) {
  return String(value ?? "").trim().toLowerCase() === "true";
}

function cloneJsonReady(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

const LINE_RETRY_NAMESPACE = Uint8Array.from([
  0x6b, 0xa7, 0xb8, 0x10, 0x9d, 0xad, 0x11, 0xd1,
  0x80, 0xb4, 0x00, 0xc0, 0x4f, 0xd4, 0x30, 0xc8,
]);

function formatUuid(bytes) {
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function buildLineRetryKey(notificationKey) {
  const nameBytes = new TextEncoder().encode(String(notificationKey));
  const input = new Uint8Array(LINE_RETRY_NAMESPACE.length + nameBytes.length);
  input.set(LINE_RETRY_NAMESPACE);
  input.set(nameBytes, LINE_RETRY_NAMESPACE.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", input));
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  return formatUuid(digest.slice(0, 16));
}

function isAcceptedLineRetryError(error) {
  return error && error.status === 409 && typeof error.acceptedRequestId === "string" && error.acceptedRequestId.length > 0;
}

export function resolveLaiExecution({
  dryRun,
  requestedEngine,
  laiEnabled,
  shadowEnabled,
}) {
  if (requestedEngine === "lai-v2" && !dryRun) {
    throw new Error("engine=lai-v2 requires dry_run=1");
  }

  const laiDryRun = dryRun && requestedEngine === "lai-v2";
  const useLaiRecord = laiEnabled || laiDryRun;
  const runLaiForecasts = useLaiRecord || shadowEnabled;

  return {
    laiDryRun,
    useLaiRecord,
    runLaiForecasts,
    forecastMode: runLaiForecasts ? (useLaiRecord ? "production" : "shadow") : null,
  };
}

export function resolveAgentExecution({
  dryRun,
  requestedEngine,
  laiEnabled,
  shadowEnabled,
  v3ShadowEnabled = false,
  v3ProductionEnabled = false,
} = {}) {
  if (requestedEngine === "lai-v3" && !dryRun) {
    throw new Error("engine=lai-v3 requires dry_run=1");
  }

  const v3DryRun = dryRun && requestedEngine === "lai-v3";
  const v2 = resolveLaiExecution({
    dryRun,
    requestedEngine: v3DryRun ? null : requestedEngine,
    laiEnabled,
    shadowEnabled,
  });
  const v3ProductionBlocked = v3ProductionEnabled === true;

  return {
    ...v2,
    v3DryRun,
    runV2Forecasts: v3DryRun ? false : v2.runLaiForecasts,
    runV3Shadow: !dryRun && (v3ShadowEnabled === true || v3ProductionBlocked),
    v3ProductionBlocked,
    formalEngine: v3DryRun
      ? "lai-v3"
      : v2.useLaiRecord
        ? "lai-v2"
        : v3ProductionBlocked
          ? null
          : "honest",
    fallbackEngine: v2.useLaiRecord ? "lai-v2" : null,
  };
}

export function buildForecastRows({
  predictionSourceKey,
  gameName,
  targetDrawDate,
  generatedAt,
  forecastMode,
  forecasts,
}) {
  if (!forecastMode) {
    return [];
  }

  return (forecasts || []).map((forecast) => {
    const v3EvidenceColumns = forecast.registryId == null
      ? {}
      : {
          registry_id: forecast.registryId,
          experiment_run_id: forecast.experimentRunId ?? null,
          feature_version: forecast.featureVersion ?? null,
          random_seed: forecast.randomSeed ?? null,
          code_commit: forecast.codeCommit ?? null,
          replay_digest: forecast.replayDigest ?? null,
        };
    return {
      prediction_source_key: predictionSourceKey,
      game_name: gameName,
      target_draw_date: targetDrawDate,
      model_name: forecast.name,
      model_version: forecast.version,
      forecast_mode: forecastMode,
      probabilities: forecast.probabilities,
      special_probabilities: forecast.specialProbabilities ?? null,
      final_groups: cloneJsonReady(forecast.final_groups) ?? {},
      feature_summary: cloneJsonReady(forecast.featureSummary) ?? {},
      agent_state_version: forecast.evidence?.state_version ?? null,
      data_status: forecast.evidence?.data_status ?? "unknown",
      generated_at: generatedAt,
      ...v3EvidenceColumns,
    };
  });
}

function latestDrawDate(draws) {
  const dates = (draws || [])
    .map((draw) => draw?.draw_date)
    .filter((value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value));
  if (!dates.length) throw new Error("LAI v3 shadow run requires historical draw dates");
  return dates.sort().at(-1);
}

function buildShadowExperiment({ registration, gameName, draws, targetDrawDate, generatedAt, codeCommit }) {
  if (!registration || typeof registration.id !== "string" || !registration.id.trim()) {
    throw new Error("LAI v3 shadow registration is missing its registry id");
  }
  if (typeof registration.feature_version !== "string" || !registration.feature_version.trim()) {
    throw new Error("LAI v3 shadow registration is missing its feature version");
  }
  const randomSeed = registration.parameters?.random_seed;
  if (typeof randomSeed !== "string" || !randomSeed.trim()) {
    throw new Error("LAI v3 shadow registration is missing its random seed");
  }
  if (typeof codeCommit !== "string" || !/^[0-9a-f]{7,64}$/.test(codeCommit)) {
    throw new Error("LOTTO_CODE_COMMIT is required for LAI v3 shadow evidence");
  }
  return {
    registry_id: registration.id,
    game_name: gameName,
    run_mode: "shadow",
    status: "running",
    data_cutoff: latestDrawDate(draws),
    range_start: 0,
    range_end: draws.length,
    checkpoint_cursor: 0,
    random_seed: randomSeed,
    code_commit: codeCommit,
    feature_version: registration.feature_version,
    metrics: { target_draw_date: targetDrawDate, generated_at: generatedAt, kind: "prediction_shadow" },
    started_at: generatedAt,
  };
}

async function runV3ShadowLane({ options, deps, predictionSourceKey }) {
  for (const dependency of [
    "fetchShadowRegistrations",
    "createV3Experiment",
    "generateEvidenceShadow",
    "persistV3ForecastRows",
    "completeV3Experiment",
    "failV3Experiment",
  ]) {
    if (typeof deps[dependency] !== "function") {
      throw new Error(`LAI v3 shadow dependency is unavailable: ${dependency}`);
    }
  }
  const registrations = await deps.fetchShadowRegistrations(options.gameName);
  if (!Array.isArray(registrations)) {
    throw new Error("LAI v3 shadow registry read did not return an array");
  }
  if (!registrations.length) return { status: "no_shadow_registrations", forecastsWritten: 0 };

  const experiments = [];
  const terminalExperimentIds = new Set();
  try {
    for (const registration of registrations) {
      const experiment = await deps.createV3Experiment(buildShadowExperiment({
        registration,
        gameName: options.gameName,
        draws: options.draws,
        targetDrawDate: options.drawTargetDate,
        generatedAt: options.generatedAt,
        codeCommit: options.codeCommit,
      }));
      if (!experiment || typeof experiment.id !== "string" || !experiment.id.trim()) {
        throw new Error("LAI v3 shadow experiment create did not return an id");
      }
      experiments.push({ registration, experiment });
    }

    const shadow = await deps.generateEvidenceShadow({
      gameType: options.gameType,
      draws: options.draws,
      generatedAt: options.generatedAt,
      targetDrawDate: options.drawTargetDate,
      dataStatus: options.dataStatus,
      codeCommit: options.codeCommit,
      shadowRegistrations: registrations,
    });
    const experimentByRegistry = new Map(experiments.map(({ registration, experiment }) => [registration.id, experiment.id]));
    if (!Array.isArray(shadow?.forecasts)) {
      throw new Error("LAI v3 shadow generation did not return forecast results");
    }
    const forecastsByRegistry = new Map();
    for (const forecast of shadow.forecasts) {
      if (!forecast || !experimentByRegistry.has(forecast.registryId) || forecastsByRegistry.has(forecast.registryId)) {
        throw new Error("LAI v3 shadow generation returned an invalid registry result");
      }
      forecastsByRegistry.set(forecast.registryId, forecast);
    }

    const completedForecasts = [];
    const failedRegistrations = [];
    for (const { registration, experiment } of experiments) {
      const forecast = forecastsByRegistry.get(registration.id);
      if (forecast?.status === "completed") {
        completedForecasts.push({
          ...forecast,
          experimentRunId: experiment.id,
          replayDigest: shadow.replay_digest ?? forecast.replayDigest ?? null,
        });
        continue;
      }
      const error = new Error(forecast?.failureReason ?? "LAI v3 shadow forecast did not complete");
      await deps.failV3Experiment(experiment, error);
      terminalExperimentIds.add(experiment.id);
      failedRegistrations.push(registration.id);
    }
    if (!completedForecasts.length) {
      throw new Error("LAI v3 shadow generation produced no completed forecasts");
    }
    const forecastRows = buildForecastRows({
      predictionSourceKey,
      gameName: options.gameName,
      targetDrawDate: options.drawTargetDate,
      generatedAt: options.generatedAt,
      forecastMode: "shadow",
      forecasts: completedForecasts,
    });
    await deps.persistV3ForecastRows(forecastRows);
    const metrics = {
      ...(shadow.metrics ?? {}),
      forecasts_written: forecastRows.length,
      failed_registration_count: failedRegistrations.length,
    };
    for (const { registration, experiment } of experiments) {
      if (terminalExperimentIds.has(experiment.id)) continue;
      await deps.completeV3Experiment(experiment, {
        metrics: { ...metrics, registry_id: registration.id },
        replay_digest: shadow.replay_digest ?? null,
      });
      terminalExperimentIds.add(experiment.id);
    }
    return {
      status: failedRegistrations.length ? "completed_with_failures" : "completed",
      forecastsWritten: forecastRows.length,
      failedRegistrations,
    };
  } catch (error) {
    await Promise.allSettled(experiments
      .filter(({ experiment }) => !terminalExperimentIds.has(experiment.id))
      .map(({ experiment }) => deps.failV3Experiment(experiment, error)));
    throw error;
  }
}

export async function executePredictionFlow(options, deps) {
  const {
    gameType,
    draws,
    gameName,
    targetDate,
    drawTargetDate,
    generatedAt,
    dryRun,
    requestedEngine,
    laiEnabled,
    shadowEnabled,
    v3ShadowEnabled = false,
    v3ProductionEnabled = false,
    codeCommit = null,
    dataStatus = "unknown",
    v3DataStatus = dataStatus,
  } = options;

  if (!drawTargetDate) {
    return {
      game: gameType,
      status: "skipped_not_draw_date",
      target_date: targetDate,
    };
  }

  const execution = resolveAgentExecution({
    dryRun,
    requestedEngine,
    laiEnabled,
    shadowEnabled,
    v3ShadowEnabled,
    v3ProductionEnabled,
  });
  const key = deps.notificationKey(gameName, drawTargetDate, "prediction");
  const predictionSourceKey = deps.sourceKey(gameName, drawTargetDate);

  if (execution.v3DryRun) {
    try {
      if (typeof deps.fetchApprovedV3Context !== "function" || typeof deps.generateEvidencePrediction !== "function") {
        throw new Error("LAI v3 preview dependencies are unavailable");
      }
      const approvedContext = await deps.fetchApprovedV3Context(gameName);
      if (!approvedContext?.state || !Array.isArray(approvedContext.registrations)) {
        throw new Error("no_complete_approved_state");
      }
      const preview = await deps.generateEvidencePrediction({
        gameType,
        draws,
        generatedAt,
        targetDrawDate: drawTargetDate,
        dataStatus: v3DataStatus,
        codeCommit,
        approvedState: approvedContext.state,
        approvedRegistrations: approvedContext.registrations,
        shadowRegistrations: [],
      });
      const message = deps.buildLineMessage(preview.record, drawTargetDate);
      return {
        game: gameType,
        status: "dry_run",
        notification_key: key,
        target_date: drawTargetDate,
        prediction: preview.record.prediction,
        message,
        formal_engine: "lai-v3",
        v3_status: "preview_only",
      };
    } catch (error) {
      return {
        game: gameType,
        status: "blocked_no_valid_state",
        target_date: drawTargetDate,
        formal_engine: null,
        v3_status: "blocked",
        root_cause: error instanceof Error ? error.message : String(error),
      };
    }
  }

  let selectedRecord = null;
  let v3Status = { status: "disabled" };

  if (execution.runV2Forecasts) {
    const agentState = await deps.fetchActiveAgentState(gameName);
    const laiResult = deps.generateAdaptivePrediction({
      gameType,
      draws,
      generatedAt,
      targetDrawDate: drawTargetDate,
      agentState,
      dataStatus,
    });
    const forecastRows = buildForecastRows({
      predictionSourceKey,
      gameName,
      targetDrawDate: drawTargetDate,
      generatedAt,
      forecastMode: execution.forecastMode,
      forecasts: laiResult.forecasts,
    });
    await deps.persistForecastRows(forecastRows);

    if (execution.useLaiRecord) {
      selectedRecord = laiResult.record;
    }
  }

  if (execution.runV3Shadow) {
    try {
      v3Status = await runV3ShadowLane({
        options: { ...options, dataStatus: v3DataStatus },
        deps,
        predictionSourceKey,
      });
    } catch (error) {
      v3Status = {
        status: "failed_isolated",
        root_cause: error instanceof Error ? error.message : String(error),
      };
      try {
        await deps.recordV3Failure?.(error);
      } catch {
        // Shadow telemetry must never affect the formal LAI v2 delivery path.
      }
    }
  }

  if (!selectedRecord && execution.formalEngine === null) {
    return {
      game: gameType,
      status: "blocked_no_valid_state",
      target_date: drawTargetDate,
      formal_engine: null,
      v3_status: v3Status.status,
      root_cause: "LAI_V3_PRODUCTION_ENABLED is shadow-only; enable an approved LAI v2 state for formal delivery",
    };
  }

  if (!selectedRecord) {
    selectedRecord = deps.generateHonestPrediction({
      gameType,
      draws,
      generatedAt,
    });
  }

  const message = deps.buildLineMessage(selectedRecord, drawTargetDate);
  if (dryRun) {
    return {
      game: gameType,
      status: "dry_run",
      notification_key: key,
      target_date: drawTargetDate,
      prediction: selectedRecord.prediction,
      message,
      formal_engine: execution.formalEngine,
      v3_status: v3Status.status,
    };
  }

  const predictionRow = deps.buildPredictionRow(
    selectedRecord,
    gameName,
    generatedAt,
    drawTargetDate,
  );
  await deps.upsertPrediction(predictionRow);

  const reserved = await deps.reserveNotification(key, {
    prediction_source_key: predictionSourceKey,
  });
  if (!reserved) {
    return {
      game: gameType,
      status: "skipped_duplicate",
      notification_key: key,
      target_date: drawTargetDate,
      prediction: selectedRecord.prediction,
      formal_engine: execution.formalEngine,
      v3_status: v3Status.status,
    };
  }

  try {
    const retryKey = await buildLineRetryKey(key);
    const lineResponse = await deps.sendLineMessage(message, retryKey);
    await deps.markNotificationSent(key, "sent", lineResponse);
    return {
      game: gameType,
      status: "sent",
      notification_key: key,
      target_date: drawTargetDate,
      prediction: selectedRecord.prediction,
      formal_engine: execution.formalEngine,
      v3_status: v3Status.status,
    };
  } catch (error) {
    if (isAcceptedLineRetryError(error)) {
      await deps.markNotificationSent(key, "sent", error.response ?? {
        status: error.status,
        accepted_request_id: error.acceptedRequestId,
      });
      return {
        game: gameType,
        status: "sent",
        notification_key: key,
        target_date: drawTargetDate,
        prediction: selectedRecord.prediction,
        formal_engine: execution.formalEngine,
        v3_status: v3Status.status,
      };
    }
    await deps.markNotificationSent(
      key,
      "failed",
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }
}
