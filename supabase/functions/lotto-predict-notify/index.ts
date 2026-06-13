import {
  buildLineMessage,
  generatePrediction,
  GAME_CONFIG,
  nextDrawDate,
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

function dueGamesForDate(dateString: string): GameType[] {
  const day = new Date(`${dateString}T00:00:00Z`).getUTCDay();
  const games: GameType[] = [];
  if (day >= 1 && day <= 6) {
    games.push("539");
  }
  if (day === 2 || day === 5) {
    games.push("649");
  }
  return games;
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
  const params = new URLSearchParams({
    select: "draw_id,draw_date,numbers,special_number",
    game_name: `eq.${gameName}`,
    order: "draw_date.desc,draw_id.desc",
    limit: "500",
  });
  const response = await supabaseRequest(supabaseUrl, serviceRoleKey, `lotto_draws?${params}`);
  if (!response.ok) {
    throw new Error(`Supabase draw query failed: ${response.status} ${await response.text()}`);
  }
  const rows = await response.json() as DrawRow[];
  return rows.sort((left, right) =>
    left.draw_date.localeCompare(right.draw_date) ||
    left.draw_id.localeCompare(right.draw_id)
  );
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
    `notification_logs?notification_key=eq.${encodeURIComponent(key)}&select=notification_key,status`,
  );
  if (!existingResponse.ok) {
    throw new Error(`Supabase notification lookup failed: ${existingResponse.status} ${await existingResponse.text()}`);
  }
  const existingRows = await existingResponse.json() as Array<{ status?: string }>;
  const existing = existingRows[0];
  if (existing?.status !== "failed") {
    return false;
  }

  const retryResponse = await supabaseRequest(
    supabaseUrl,
    serviceRoleKey,
    `notification_logs?notification_key=eq.${encodeURIComponent(key)}&status=eq.failed`,
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

async function enhanceReasoningWithGemini(record: Record<string, unknown>): Promise<Record<string, unknown>> {
  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) {
    return record;
  }

  const model = Deno.env.get("GEMINI_MODEL_PREDICTION") || "gemini-2.5-flash";
  const prediction = record.prediction as Record<string, unknown> | undefined;
  if (!prediction) {
    return record;
  }

  const prompt = [
    "請根據以下樂透統計資料，輸出繁體中文 JSON。",
    "reasoning 必須模仿專業統計洞察口吻，包含近 N 期最熱、最冷、即將開出指數、同開號碼對，並逐一說明【激進包牌】、【穩健平衡】、【統計趨勢】策略。",
    "不要保證命中，不要加入 Markdown。",
    JSON.stringify({
      game_name: record.game_name,
      number_insights: prediction.number_insights,
      combinations: prediction.combinations,
    }),
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
              text: "你是台灣彩券統計分析助手。你只根據提供的統計資料撰寫分析，不編造不存在的數據。",
            }],
          },
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.35,
            responseMimeType: "application/json",
            responseSchema: {
              type: "OBJECT",
              properties: {
                reasoning: { type: "STRING" },
                risk_warning: { type: "STRING" },
              },
              required: ["reasoning"],
            },
          },
        }),
      },
    );

    if (!response.ok) {
      console.warn(`Gemini reasoning enhancement failed: ${response.status} ${await response.text()}`);
      return record;
    }

    const body = await response.json();
    const text = body?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      return record;
    }
    const geminiResult = JSON.parse(text);
    if (typeof geminiResult.reasoning !== "string" || !geminiResult.reasoning.trim()) {
      return record;
    }

    return {
      ...record,
      prediction: {
        ...prediction,
        model,
        reasoning: geminiResult.reasoning.trim(),
        risk_warning: typeof geminiResult.risk_warning === "string"
          ? geminiResult.risk_warning.trim()
          : prediction.risk_warning,
        reasoning_source: "gemini",
      },
    };
  } catch (error) {
    console.warn(`Gemini reasoning enhancement error: ${error instanceof Error ? error.message : String(error)}`);
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
  let record: Record<string, unknown> = generatePrediction({
    gameType,
    draws,
    generatedAt: options.generatedAt,
  });
  record = await enhanceReasoningWithGemini(record);
  const gameName = GAME_CONFIG[gameType].name;
  const drawTargetDate = nextDrawDate(gameType, options.targetDate);
  const key = notificationKey(gameName, drawTargetDate, "prediction");
  const message = buildLineMessage(record, drawTargetDate);
  const predictionSourceKey = sourceKey(gameName, drawTargetDate);

  const predictionRow = {
    source_key: predictionSourceKey,
    game_name: gameName,
    predicted_at: options.generatedAt,
    target_draw_date: drawTargetDate,
    prediction: record.prediction,
    is_evaluated: false,
    evaluation: record.evaluation,
    raw: {
      ...record,
      target_draw_date: drawTargetDate,
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
      ? dueGamesForDate(targetDate)
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
