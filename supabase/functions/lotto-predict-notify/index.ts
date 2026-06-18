import {
  applyGeminiQuantDecision,
  buildGeminiDecisionPayload,
  buildLineMessage,
  dueGamesForDate,
  generatePrediction,
  GAME_CONFIG,
  notificationSentBeforeRelease,
  predictionTargetDate,
  notificationKey,
  sourceKey,
} from "./lib/predictCore.js";

type GameType = "539" | "649";

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

function assertAuthorized(request: Request, serviceRoleKey: string): void {
  const allowedKeys = new Set([serviceRoleKey, ...secretKeys()]);
  const providedApiKey = request.headers.get("apikey") ?? "";
  const providedBearer = bearerToken(request);
  if (!allowedKeys.has(providedApiKey) && !allowedKeys.has(providedBearer)) {
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
  const response = await supabaseRequest(
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
    throw new Error(`Supabase prediction upsert failed: ${response.status} ${await response.text()}`);
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
    `notification_logs?notification_key=eq.${encodeURIComponent(key)}&select=notification_key,status,target_date,sent_at`,
  );
  if (!existingResponse.ok) {
    throw new Error(`Supabase notification lookup failed: ${existingResponse.status} ${await existingResponse.text()}`);
  }
  const existingRows = await existingResponse.json() as Array<{ status?: string; target_date?: string; sent_at?: string | null }>;
  const existing = existingRows[0];
  const canRetryFailed = existing?.status === "failed";
  const canRetryEarlySent = existing?.status === "sent" &&
    notificationSentBeforeRelease(existing.sent_at, String(row.target_date ?? existing.target_date ?? ""));
  if (!canRetryFailed && !canRetryEarlySent) {
    return false;
  }

  const retryResponse = await supabaseRequest(
    supabaseUrl,
    serviceRoleKey,
    `notification_logs?notification_key=eq.${encodeURIComponent(key)}&status=eq.${canRetryFailed ? "failed" : "sent"}`,
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

async function enhancePredictionWithGemini(
  record: Record<string, unknown>,
  payload: Record<string, unknown>,
  draws: DrawRow[],
): Promise<Record<string, unknown>> {
  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) {
    const prediction = record.prediction as Record<string, unknown> | undefined;
    return {
      ...record,
      prediction: {
        ...prediction,
        reasoning_source: "statistical_fallback_no_gemini_key",
      },
    };
  }

  const model = Deno.env.get("GEMINI_MODEL_PREDICTION") || "gemini-2.5-flash";
  const prediction = record.prediction as Record<string, unknown> | undefined;
  if (!prediction) {
    return record;
  }

  const prompt = [
    "你會收到 full_history，這是此彩種目前資料庫內的全部歷史開獎資料，已依日期由舊到新排序。",
    "請依照統計、機率、資料方法論進行量化推理，Gemini 必須主導候選號碼池與三種策略權重。",
    "科學的盡頭是玄學，但玄學只能作為 5% 到 10% 的娛樂輔助權重，必須清楚標示 metaphysics_note，不能宣稱保證命中。",
    "請輸出繁體中文 JSON，不要 Markdown。",
    "strategy_weights 必須包含【激進包牌】、【穩健平衡】、【統計趨勢】，每個策略提供 weight、prefer、avoid、rationale。",
    "candidate_pool 請給 12 到 20 個候選號碼，每個號碼包含 score、statistics_reason、metaphysics_signal。",
    JSON.stringify(payload),
  ].join("\n\n");

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{
              text: "你是台灣彩券量化預測引擎。你必須只根據提供的完整歷史資料與量化特徵做分析，不編造資料，不承諾中獎。你的任務是產生可被程式驗證的候選號碼池、策略權重與科學 reasoning。",
            }],
          },
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.45,
            responseMimeType: "application/json",
            responseSchema: {
              type: "OBJECT",
              properties: {
                reasoning: { type: "STRING" },
                risk_warning: { type: "STRING" },
                metaphysics_note: { type: "STRING" },
                strategy_weights: {
                  type: "OBJECT",
                  properties: {
                    "激進包牌": {
                      type: "OBJECT",
                      properties: {
                        weight: { type: "NUMBER" },
                        prefer: { type: "ARRAY", items: { type: "INTEGER" } },
                        avoid: { type: "ARRAY", items: { type: "INTEGER" } },
                        rationale: { type: "STRING" },
                      },
                    },
                    "穩健平衡": {
                      type: "OBJECT",
                      properties: {
                        weight: { type: "NUMBER" },
                        prefer: { type: "ARRAY", items: { type: "INTEGER" } },
                        avoid: { type: "ARRAY", items: { type: "INTEGER" } },
                        rationale: { type: "STRING" },
                      },
                    },
                    "統計趨勢": {
                      type: "OBJECT",
                      properties: {
                        weight: { type: "NUMBER" },
                        prefer: { type: "ARRAY", items: { type: "INTEGER" } },
                        avoid: { type: "ARRAY", items: { type: "INTEGER" } },
                        rationale: { type: "STRING" },
                      },
                    },
                  },
                },
                candidate_pool: {
                  type: "ARRAY",
                  items: {
                    type: "OBJECT",
                    properties: {
                      number: { type: "INTEGER" },
                      score: { type: "NUMBER" },
                      statistics_reason: { type: "STRING" },
                      metaphysics_signal: { type: "STRING" },
                    },
                  },
                },
              },
              required: ["reasoning", "strategy_weights", "candidate_pool"],
            },
          },
        }),
      },
    );

    if (!response.ok) {
      console.warn(`Gemini quantitative prediction failed: ${response.status} ${await response.text()}`);
      return record;
    }

    const body = await response.json();
    const text = body?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      return record;
    }
    const geminiResult = JSON.parse(text);
    const enhanced = applyGeminiQuantDecision({
      baseRecord: record,
      decision: geminiResult,
      payload,
      draws,
    });
    return {
      ...enhanced,
      prediction: {
        ...(enhanced.prediction as Record<string, unknown>),
        model,
      },
    };
  } catch (error) {
    console.warn(`Gemini quantitative prediction error: ${error instanceof Error ? error.message : String(error)}`);
    return record;
  }
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
  const payload = buildGeminiDecisionPayload({
    gameType,
    draws,
    generatedAt: options.generatedAt,
    learningRecords,
  });
  let record: Record<string, unknown> = generatePrediction({
    gameType,
    draws,
    generatedAt: options.generatedAt,
  });
  record = await enhancePredictionWithGemini(record, payload, draws);
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

    if (!["due", "all", "539", "649"].includes(requestedGame)) {
      return failFast(400, "Unsupported game parameter", requestedGame, "Use game=due, game=all, game=539, or game=649.");
    }

    const games: GameType[] = requestedGame === "due"
      ? dueGamesForDate(targetDate) as GameType[]
      : requestedGame === "539"
      ? ["539"]
      : requestedGame === "649"
        ? ["649"]
        : ["539", "649"];

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
