export function parseBooleanEnvFlag(value) {
  return String(value ?? "").trim().toLowerCase() === "true";
}

function cloneJsonReady(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
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

  return (forecasts || []).map((forecast) => ({
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
  }));
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
    dataStatus = "unknown",
  } = options;

  if (!drawTargetDate) {
    return {
      game: gameType,
      status: "skipped_not_draw_date",
      target_date: targetDate,
    };
  }

  const execution = resolveLaiExecution({
    dryRun,
    requestedEngine,
    laiEnabled,
    shadowEnabled,
  });
  const key = deps.notificationKey(gameName, drawTargetDate, "prediction");
  const predictionSourceKey = deps.sourceKey(gameName, drawTargetDate);
  let selectedRecord = null;

  if (execution.runLaiForecasts) {
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
    };
  }

  try {
    const lineResponse = await deps.sendLineMessage(message);
    await deps.markNotificationSent(key, "sent", lineResponse);
    return {
      game: gameType,
      status: "sent",
      notification_key: key,
      target_date: drawTargetDate,
      prediction: selectedRecord.prediction,
    };
  } catch (error) {
    await deps.markNotificationSent(
      key,
      "failed",
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }
}
