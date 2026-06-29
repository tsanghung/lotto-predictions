import {
  buildLineMessage,
  dueGamesForDate,
  generateHonestPrediction,
  GAME_CONFIG,
  notificationSentBeforeRelease,
  predictionTargetDate,
  notificationKey,
  sourceKey,
} from "./lib/predictCore.js";

type GameType = "539" | "649" | "power";

type DrawRow = {
  draw_id: string;
  draw_date: string;
  numbers: number[];
  special_number: number | null;
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function failFast(status: number, message: string, rootCause: unknown, suggestedFix: string): Response {
  return jsonResponse(status, {
    Status: "failed",
    "Root Cause": String(rootCause),
    "Suggested Fix": suggestedFix,
    message,
  });
}

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(`${name} is not configured`);
  }
  return value.replace(/\/+$/, "");
}

function secretKeys(): string[] {
  const keys: string[] = [];
  const secretKeyJson = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (secretKeyJson) {
    const parsed = JSON.parse(secretKeyJson) as Record<string, string>;
    keys.push(...Object.values(parsed).filter(Boolean));
  }

  const legacyServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacyServiceRoleKey) {
    keys.push(legacyServiceRoleKey);
  }

  return [...new Set(keys)];
}

function requireServiceKey(): string {
  const keys = secretKeys();
  if (!keys.length) {
    throw new Error("No Supabase secret key is configured");
  }
  return keys[0];
}

function bearerToken(request: Request): string {
  const authorization = request.headers.get("authorization") ?? "";
  return authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice("bearer ".length).trim()
    : "";
}

function jwtRole(token: string): string | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) {
      return null;
    }
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), "=");
    return JSON.parse(atob(padded))?.role ?? null;
  } catch {
    return null;
  }
}

function assertAuthorized(request: Request, serviceRoleKey: string): void {
  const allowedKeys = new Set([serviceRoleKey, ...secretKeys()]);
  const providedApiKey = request.headers.get("apikey") ?? "";
  const providedBearer = bearerToken(request);
  if (
    !allowedKeys.has(providedApiKey) &&
    !allowedKeys.has(providedBearer) &&
    jwtRole(providedBearer) !== "service_role" &&
    jwtRole(providedApiKey) !== "service_role"
  ) {
    throw new Error("Unauthorized request. Provide a valid Supabase secret key in the apikey header.");
  }
}

function supabaseHeaders(serviceRoleKey: string): HeadersInit {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
  };
}

function taipeiNow(): { date: string; timestamp: string } {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(formatter.formatToParts(now).map((part) => [part.type, part.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    timestamp: `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}+08:00`,
  };
}

async function supabaseRequest(
  supabaseUrl: string,
  serviceRoleKey: string,
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  return fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...options,
    headers: {
      ...supabaseHeaders(serviceRoleKey),
      ...(options.headers || {}),
    },
  });
}

async function fetchDraws(
  supabaseUrl: string,
  serviceRoleKey: string,
  gameType: GameType,
): Promise<DrawRow[]> {
  const gameName = GAME_CONFIG[gameType].name;
  const pageSize = 1000;
  const rows: DrawRow[] = [];

  for (let offset = 0;; offset += pageSize) {
    const params = new URLSearchParams({
      select: "draw_id,draw_date,numbers,special_number",
      game_name: `eq.${gameName}`,
      order: "draw_date.asc,draw_id.asc",
      limit: String(pageSize),
      offset: String(offset),
    });
    const response = await supabaseRequest(supabaseUrl, serviceRoleKey, `lotto_draws?${params}`);
    if (!response.ok) {
      throw new Error(`Supabase draw query failed: ${response.status} ${await response.text()}`);
    }
    const page = await response.json() as DrawRow[];
    rows.push(...page);
    if (page.length < pageSize) {
      break;
    }
  }

  return rows.sort((left, right) =>
    left.draw_date.localeCompare(right.draw_date) ||
    left.draw_id.localeCompare(right.draw_id)
  );
}

async function fetchRecentAsiLearningRecords(
  supabaseUrl: string,
  serviceRoleKey: string,
  gameName: string,
  limit = 5,
): Promise<Record<string, unknown>[]> {
  const params = new URLSearchParams({
    game_name: `eq.${gameName}`,
    select: [
      "game_name",
      "target_draw_date",
      "matched_numbers",
      "missed_numbers",
      "strategy_effectiveness",
      "next_adjustments",
      "reasoning_source",
      "model_name",
    ].join(","),
    order: "target_draw_date.desc",
    limit: String(limit),
  });

  const response = await supabaseRequest(
    supabaseUrl,
    serviceRoleKey,
    `asi_learning_records?${params}`,
  );

  if (!response.ok) {
    console.warn(`ASI learning context unavailable: ${response.status} ${await response.text()}`);
    return [];
  }

  return await response.json() as Record<string, unknown>[];
}

async function upsertPrediction(
  supabaseUrl: string,
  serviceRoleKey: string,
  record: Record<string, unknown>,
): Promise<void> {
  let response = await supabaseRequest(
    supabaseUrl,
    serviceRoleKey,
    "prediction_records?on_conflict=source_key",
    {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify([record]),
    },
  );
  if (!response.ok) {
    const errorText = await response.text();
    const compatibilityColumns = ["asi_state", "asi_learning_context", "model_name", "reasoning_source"];
    if (compatibilityColumns.some((column) => errorText.includes(column))) {
      const compatibleRecord = { ...record };
      for (const column of compatibilityColumns) {
        delete compatibleRecord[column];
      }
      response = await supabaseRequest(
        supabaseUrl,
        serviceRoleKey,
        "prediction_records?on_conflict=source_key",
        {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify([compatibleRecord]),
        },
      );
      if (response.ok) {
        console.warn(`Prediction upsert used compatibility mode because ASI columns are not migrated yet: ${errorText}`);
        return;
      }
      throw new Error(`Supabase prediction compatibility upsert failed: ${response.status} ${await response.text()}`);
    }
    throw new Error(`Supabase prediction upsert failed: ${response.status} ${errorText}`);
  }
}

async function reserveNotification(
  supabaseUrl: string,
  serviceRoleKey: string,
  row: Record<string, unknown>,
): Promise<boolean> {
  const response = await supabaseRequest(
    supabaseUrl,
    serviceRoleKey,
    "notification_logs?on_conflict=notification_key",
    {
      method: "POST",
      headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
      body: JSON.stringify([row]),
    },
  );
  if (!response.ok) {
    throw new Error(`Supabase notification reservation failed: ${response.status} ${await response.text()}`);
  }
  const body = await response.json();
  if (Array.isArray(body) && body.length > 0) {
    return true;
  }

  const key = String(row.notification_key);
  const existingResponse = await supabaseRequest(
    supabaseUrl,
    serviceRoleKey,
    `notification_logs?notification_key=eq.${encodeURIComponent(key)}&select=notification_key,status,target_date,sent_at,created_at`,
  );
  if (!existingResponse.ok) {
    throw new Error(`Supabase notification lookup failed: ${existingResponse.status} ${await existingResponse.text()}`);
  }
  const existingRows = await existingResponse.json() as Array<{
    status?: string;
    target_date?: string;
    sent_at?: string | null;
    created_at?: string;
  }>;
  const existing = existingRows[0];
  const reservedAgeMs = existing?.created_at ? Date.now() - new Date(existing.created_at).getTime() : 0;
  const canRetryFailed = existing?.status === "failed";
  const canRetryStaleReserved = existing?.status === "reserved" &&
    !existing.sent_at &&
    reservedAgeMs > 5 * 60 * 1000;
  const canRetryEarlySent = existing?.status === "sent" &&
    notificationSentBeforeRelease(existing.sent_at, String(row.target_date ?? existing.target_date ?? ""));
  if (!canRetryFailed && !canRetryStaleReserved && !canRetryEarlySent) {
    return false;
  }

  const retryStatus = canRetryFailed ? "failed" : canRetryStaleReserved ? "reserved" : "sent";
  const retryResponse = await supabaseRequest(
    supabaseUrl,
    serviceRoleKey,
    `notification_logs?notification_key=eq.${encodeURIComponent(key)}&status=eq.${retryStatus}`,
    {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        status: "reserved",
        payload: row.payload,
        response: null,
        sent_at: null,
      }),
    },
  );
  if (!retryResponse.ok) {
    throw new Error(`Supabase notification retry reservation failed: ${retryResponse.status} ${await retryResponse.text()}`);
  }
  const retryRows = await retryResponse.json();
  return Array.isArray(retryRows) && retryRows.length > 0;
}

async function markNotificationSent(
  supabaseUrl: string,
  serviceRoleKey: string,
  key: string,
  status: "sent" | "failed" | "dry_run",
  responseBody: unknown,
): Promise<void> {
  const response = await supabaseRequest(
    supabaseUrl,
    serviceRoleKey,
    `notification_logs?notification_key=eq.${encodeURIComponent(key)}`,
    {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        status,
        sent_at: status === "sent" ? new Date().toISOString() : null,
        response: responseBody,
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`Supabase notification update failed: ${response.status} ${await response.text()}`);
  }
}

async function sendLineMessage(message: string): Promise<unknown> {
  const accessToken = requireEnv("LINE_CHANNEL_ACCESS_TOKEN");
  const userId = requireEnv("LINE_USER_ID");
  const response = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      to: userId,
      messages: [{ type: "text", text: message }],
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`LINE push failed: ${response.status} ${text}`);
  }
  return { status: response.status, body: text };
}

async function processGame(
  gameType: GameType,
  options: {
    supabaseUrl: string;
    serviceRoleKey: string;
    targetDate: string;
    generatedAt: string;
    dryRun: boolean;
  },
) {
  const draws = await fetchDraws(options.supabaseUrl, options.serviceRoleKey, gameType);
  const gameName = GAME_CONFIG[gameType].name;
  const learningRecords = await fetchRecentAsiLearningRecords(
    options.supabaseUrl,
    options.serviceRoleKey,
    gameName,
  );
  // 誠實版：不預測號碼；公正性健診 + 穩健平衡（每彩種一組）+ 心跳明牌（固定一組）。
  const record: Record<string, unknown> = generateHonestPrediction({
    gameType,
    draws,
    generatedAt: options.generatedAt,
  });
  const drawTargetDate = predictionTargetDate(gameType, options.targetDate);
  if (!drawTargetDate) {
    return {
      game: gameType,
      status: "skipped_not_draw_date",
      target_date: options.targetDate,
    };
  }
  const key = notificationKey(gameName, drawTargetDate, "prediction");
  const message = buildLineMessage(record, drawTargetDate);
  const predictionSourceKey = sourceKey(gameName, drawTargetDate);

  const predictionRow = {
    source_key: predictionSourceKey,
    game_name: gameName,
    predicted_at: options.generatedAt,
    target_draw_date: drawTargetDate,
    prediction: record.prediction,
    model_name: (record.prediction as Record<string, unknown> | undefined)?.model ?? null,
    reasoning_source: (record.prediction as Record<string, unknown> | undefined)?.reasoning_source ?? null,
    asi_learning_context: {
      version: "asi_learning_context_v1",
      records_used: learningRecords.length,
      latest_target_draw_date: learningRecords[0]?.target_draw_date || null,
    },
    is_evaluated: false,
    evaluation: record.evaluation,
    raw: {
      ...record,
      target_draw_date: drawTargetDate,
      asi_learning_context: {
        version: "asi_learning_context_v1",
        records_used: learningRecords.length,
        latest_target_draw_date: learningRecords[0]?.target_draw_date || null,
      },
    },
  };

  if (options.dryRun) {
    return {
      game: gameType,
      status: "dry_run",
      notification_key: key,
      target_date: drawTargetDate,
      prediction: record.prediction,
      message,
    };
  }

  const reserved = await reserveNotification(options.supabaseUrl, options.serviceRoleKey, {
    notification_key: key,
    game_name: gameName,
    target_date: drawTargetDate,
    notification_type: "prediction",
    status: "reserved",
    payload: { prediction_source_key: predictionSourceKey },
  });

  if (!reserved) {
    return {
      game: gameType,
      status: "skipped_duplicate",
      notification_key: key,
      target_date: drawTargetDate,
    };
  }

  await upsertPrediction(options.supabaseUrl, options.serviceRoleKey, predictionRow);

  try {
    const lineResponse = await sendLineMessage(message);
    await markNotificationSent(options.supabaseUrl, options.serviceRoleKey, key, "sent", lineResponse);
    return {
      game: gameType,
      status: "sent",
      notification_key: key,
      target_date: drawTargetDate,
    };
  } catch (error) {
    await markNotificationSent(
      options.supabaseUrl,
      options.serviceRoleKey,
      key,
      "failed",
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }
}

async function handleRequest(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  try {
    const supabaseUrl = requireEnv("SUPABASE_URL");
    const serviceRoleKey = requireServiceKey();
    assertAuthorized(request, serviceRoleKey);

    const url = new URL(request.url);
    const requestedGame = url.searchParams.get("game") ?? "due";
    const dryRun = url.searchParams.get("dry_run") === "1";
    const now = taipeiNow();
    const targetDate = url.searchParams.get("target_date") ?? now.date;
    const generatedAt = url.searchParams.get("generated_at") ?? now.timestamp;

    if (!["due", "all", "539", "649", "power"].includes(requestedGame)) {
      return failFast(400, "Unsupported game parameter", requestedGame, "Use game=due, game=all, game=539, game=649, or game=power.");
    }

    const games: GameType[] = requestedGame === "due"
      ? dueGamesForDate(targetDate) as GameType[]
      : requestedGame === "539"
      ? ["539"]
      : requestedGame === "649"
        ? ["649"]
        : requestedGame === "power"
          ? ["power"]
          : ["539", "649", "power"];

    const results = [];
    for (const game of games) {
      results.push(await processGame(game, {
        supabaseUrl,
        serviceRoleKey,
        targetDate,
        generatedAt,
        dryRun,
      }));
    }

    return jsonResponse(200, {
      Status: "ok",
      dry_run: dryRun,
      target_date: targetDate,
      results,
    });
  } catch (error) {
    return failFast(
      500,
      "Lotto predict notify failed.",
      error instanceof Error ? error.message : error,
      "Check LINE secrets, Supabase function secrets, draw history availability, and notification log constraints.",
    );
  }
}

Deno.serve(handleRequest);
