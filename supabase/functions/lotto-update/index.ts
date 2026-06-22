import {
  buildAsiLearningRecord,
  buildPerformanceSnapshot,
  chooseFreshestDraw,
  evaluatePredictionRecord,
  latestByDrawId,
  needsSecondaryDaily539Check,
  parseAuzonetDaily539Html,
  parseOfficialPayload,
  taiwanDateParts,
  toLottoDrawRow,
} from "./lib/lottoCore.js";

type GameType = "539" | "649" | "power";

type LottoDraw = {
  draw_id: string;
  date: string;
  numbers: number[];
  special_number: number | null;
  source?: string;
  raw?: unknown;
};

type UpdateResult = {
  game: GameType;
  status: "updated" | "unchanged" | "dry_run";
  selected_draw: LottoDraw;
  official_draw: LottoDraw;
  secondary_draw: LottoDraw | null;
};

type PredictionRow = {
  source_key: string;
  game_name: string;
  predicted_at?: string;
  target_draw_date: string;
  prediction: Record<string, unknown>;
  is_evaluated?: boolean;
  evaluation?: Record<string, unknown> | null;
};

type DrawRow = {
  game_name: string;
  draw_id: string;
  draw_date: string;
  numbers: number[];
  special_number: number | null;
};

const OFFICIAL_URLS: Record<GameType, string> = {
  "539": "https://api.taiwanlottery.com/TLCAPIWeB/Lottery/Daily539Result",
  "649": "https://api.taiwanlottery.com/TLCAPIWeB/Lottery/Lotto649Result",
  "power": "https://api.taiwanlottery.com/TLCAPIWeB/Lottery/SuperLotto638Result",
};

const GAME_NAMES: Record<GameType, string> = {
  "539": "今彩539",
  "649": "大樂透",
  "power": "威力彩",
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
    try {
      const parsed = JSON.parse(secretKeyJson) as Record<string, string>;
      keys.push(...Object.values(parsed).filter(Boolean));
    } catch {
      throw new Error("SUPABASE_SECRET_KEYS is not valid JSON");
    }
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

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { "User-Agent": "lotto-predictions-supabase-edge-function/1.0" },
  });

  if (!response.ok) {
    throw new Error(`${url} returned ${response.status} ${response.statusText}`);
  }

  return response.json();
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { "User-Agent": "lotto-predictions-supabase-edge-function/1.0" },
  });

  if (!response.ok) {
    throw new Error(`${url} returned ${response.status} ${response.statusText}`);
  }

  return response.text();
}

async function fetchOfficialLatest(game: GameType, targetDate: string): Promise<LottoDraw> {
  const month = targetDate.slice(0, 7);
  const params = new URLSearchParams({
    period: "",
    month,
    endMonth: month,
    pageNum: "1",
    pageSize: "200",
  });
  const payload = await fetchJson(`${OFFICIAL_URLS[game]}?${params}`);
  const draws = parseOfficialPayload(game, payload);
  const latest = latestByDrawId(draws);

  if (!latest) {
    throw new Error(`Official API returned no ${game} draws for ${month}`);
  }

  return latest as LottoDraw;
}

async function fetchAuzonetDaily539(): Promise<LottoDraw> {
  const html = await fetchText("https://lotto.auzo.tw/");
  return parseAuzonetDaily539Html(html) as LottoDraw;
}

function supabaseHeaders(serviceRoleKey: string): HeadersInit {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
  };
}

async function fetchExistingLatest(
  supabaseUrl: string,
  serviceRoleKey: string,
  game: GameType,
): Promise<{ draw_id: string; draw_date: string } | null> {
  const params = new URLSearchParams({
    select: "draw_id,draw_date",
    game_name: `eq.${GAME_NAMES[game]}`,
    order: "draw_date.desc,draw_id.desc",
    limit: "1",
  });
  const response = await fetch(`${supabaseUrl}/rest/v1/lotto_draws?${params}`, {
    headers: supabaseHeaders(serviceRoleKey),
  });

  if (!response.ok) {
    throw new Error(`Supabase latest query failed: ${response.status} ${await response.text()}`);
  }

  const rows = await response.json();
  return rows[0] ?? null;
}

async function fetchDrawCount(
  supabaseUrl: string,
  serviceRoleKey: string,
  game: GameType,
): Promise<number> {
  const params = new URLSearchParams({
    select: "draw_id",
    game_name: `eq.${GAME_NAMES[game]}`,
    limit: "1",
  });
  const response = await fetch(`${supabaseUrl}/rest/v1/lotto_draws?${params}`, {
    headers: {
      ...supabaseHeaders(serviceRoleKey),
      Prefer: "count=exact",
      Range: "0-0",
    },
  });

  if (!response.ok) {
    throw new Error(`Supabase count query failed: ${response.status} ${await response.text()}`);
  }

  const contentRange = response.headers.get("content-range") ?? "";
  const total = Number(contentRange.split("/").at(-1));
  if (!Number.isFinite(total)) {
    throw new Error(`Supabase count query returned invalid content-range: ${contentRange}`);
  }

  return total;
}

async function upsertRows(
  supabaseUrl: string,
  serviceRoleKey: string,
  table: string,
  rows: unknown[],
): Promise<void> {
  const response = await fetch(`${supabaseUrl}/rest/v1/${table}?on_conflict=game_name,draw_id`, {
    method: "POST",
    headers: {
      ...supabaseHeaders(serviceRoleKey),
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(rows),
  });

  if (!response.ok) {
    throw new Error(`Supabase ${table} upsert failed: ${response.status} ${await response.text()}`);
  }
}

async function upsertMeta(
  supabaseUrl: string,
  serviceRoleKey: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const response = await fetch(`${supabaseUrl}/rest/v1/app_meta?on_conflict=meta_key`, {
    method: "POST",
    headers: {
      ...supabaseHeaders(serviceRoleKey),
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify([{
      meta_key: "current",
      last_updated: new Date().toISOString(),
      payload,
    }]),
  });

  if (!response.ok) {
    throw new Error(`Supabase app_meta upsert failed: ${response.status} ${await response.text()}`);
  }
}

async function upsertPerformanceSnapshot(
  supabaseUrl: string,
  serviceRoleKey: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const response = await fetch(`${supabaseUrl}/rest/v1/performance_snapshots?on_conflict=snapshot_key`, {
    method: "POST",
    headers: {
      ...supabaseHeaders(serviceRoleKey),
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify([{
      snapshot_key: "current",
      last_updated: payload.last_updated,
      payload,
    }]),
  });

  if (!response.ok) {
    throw new Error(`Supabase performance snapshot upsert failed: ${response.status} ${await response.text()}`);
  }
}

async function upsertAsiLearningRecord(
  supabaseUrl: string,
  serviceRoleKey: string,
  row: Record<string, unknown>,
): Promise<void> {
  const response = await fetch(
    `${supabaseUrl}/rest/v1/asi_learning_records?on_conflict=game_name,target_draw_date,prediction_source_key`,
    {
      method: "POST",
      headers: {
        ...supabaseHeaders(serviceRoleKey),
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify([row]),
    },
  );

  if (!response.ok) {
    console.warn(`Supabase ASI learning upsert failed: ${response.status} ${await response.text()}`);
  }
}

async function fetchReadyPredictions(
  supabaseUrl: string,
  serviceRoleKey: string,
  targetDate: string,
): Promise<PredictionRow[]> {
  const params = new URLSearchParams({
    select: "source_key,game_name,target_draw_date,prediction",
    is_evaluated: "eq.false",
    target_draw_date: `lte.${targetDate}`,
    order: "target_draw_date.asc,predicted_at.asc",
  });
  const response = await fetch(`${supabaseUrl}/rest/v1/prediction_records?${params}`, {
    headers: supabaseHeaders(serviceRoleKey),
  });

  if (!response.ok) {
    throw new Error(`Supabase prediction query failed: ${response.status} ${await response.text()}`);
  }

  return response.json();
}

async function fetchEvaluatedPredictions(
  supabaseUrl: string,
  serviceRoleKey: string,
): Promise<PredictionRow[]> {
  const rows: PredictionRow[] = [];
  const pageSize = 1000;
  let offset = 0;

  while (true) {
    const params = new URLSearchParams({
      select: "source_key,game_name,predicted_at,target_draw_date,prediction,is_evaluated,evaluation",
      is_evaluated: "eq.true",
      order: "target_draw_date.asc,predicted_at.asc",
      limit: String(pageSize),
      offset: String(offset),
    });
    const response = await fetch(`${supabaseUrl}/rest/v1/prediction_records?${params}`, {
      headers: supabaseHeaders(serviceRoleKey),
    });

    if (!response.ok) {
      throw new Error(`Supabase evaluated prediction query failed: ${response.status} ${await response.text()}`);
    }

    const page = await response.json() as PredictionRow[];
    rows.push(...page);

    if (page.length < pageSize) {
      return rows;
    }

    offset += pageSize;
  }
}

async function rebuildPerformanceSnapshot(
  supabaseUrl: string,
  serviceRoleKey: string,
): Promise<Record<string, unknown>> {
  const evaluatedPredictions = await fetchEvaluatedPredictions(supabaseUrl, serviceRoleKey);
  const snapshot = buildPerformanceSnapshot(evaluatedPredictions);
  await upsertPerformanceSnapshot(supabaseUrl, serviceRoleKey, snapshot);
  return snapshot;
}

async function fetchDrawForPrediction(
  supabaseUrl: string,
  serviceRoleKey: string,
  prediction: PredictionRow,
): Promise<DrawRow | null> {
  const params = new URLSearchParams({
    select: "game_name,draw_id,draw_date,numbers,special_number",
    game_name: `eq.${prediction.game_name}`,
    draw_date: `eq.${prediction.target_draw_date}`,
    limit: "1",
  });
  const response = await fetch(`${supabaseUrl}/rest/v1/lotto_draws?${params}`, {
    headers: supabaseHeaders(serviceRoleKey),
  });

  if (!response.ok) {
    throw new Error(`Supabase draw lookup failed: ${response.status} ${await response.text()}`);
  }

  const rows = await response.json();
  return rows[0] ?? null;
}

async function markPredictionEvaluated(
  supabaseUrl: string,
  serviceRoleKey: string,
  sourceKey: string,
  evaluation: Record<string, unknown>,
): Promise<void> {
  const response = await fetch(
    `${supabaseUrl}/rest/v1/prediction_records?source_key=eq.${encodeURIComponent(sourceKey)}`,
    {
      method: "PATCH",
      headers: {
        ...supabaseHeaders(serviceRoleKey),
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        is_evaluated: true,
        evaluation,
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`Supabase prediction evaluation update failed: ${response.status} ${await response.text()}`);
  }
}

async function evaluateReadyPredictions(
  supabaseUrl: string,
  serviceRoleKey: string,
  targetDate: string,
): Promise<Array<{ source_key: string; game_name: string; target_draw_date: string; draw_id: string }>> {
  const predictions = await fetchReadyPredictions(supabaseUrl, serviceRoleKey, targetDate);
  const evaluated = [];

  for (const prediction of predictions) {
    const draw = await fetchDrawForPrediction(supabaseUrl, serviceRoleKey, prediction);
    if (!draw) {
      continue;
    }

    const evaluation = evaluatePredictionRecord(prediction, draw);
    await markPredictionEvaluated(supabaseUrl, serviceRoleKey, prediction.source_key, evaluation);
    const asiLearningRecord = buildAsiLearningRecord(prediction, draw, evaluation);
    await upsertAsiLearningRecord(supabaseUrl, serviceRoleKey, asiLearningRecord);
    evaluated.push({
      source_key: prediction.source_key,
      game_name: prediction.game_name,
      target_draw_date: prediction.target_draw_date,
      draw_id: draw.draw_id,
    });
  }

  return evaluated;
}

async function updateGame(
  game: GameType,
  options: {
    supabaseUrl: string;
    serviceRoleKey: string;
    targetDate: string;
    taiwanHour: number;
    dryRun: boolean;
  },
): Promise<UpdateResult> {
  const existing = await fetchExistingLatest(options.supabaseUrl, options.serviceRoleKey, game);
  const officialDraw = await fetchOfficialLatest(game, options.targetDate);
  let secondaryDraw: LottoDraw | null = null;
  let selectedDraw = officialDraw;

  if (
    game === "539" &&
    needsSecondaryDaily539Check({
      latestOfficialDate: officialDraw.date,
      targetDate: options.targetDate,
      taiwanHour: options.taiwanHour,
    })
  ) {
    secondaryDraw = await fetchAuzonetDaily539();
    selectedDraw = chooseFreshestDraw(officialDraw, secondaryDraw);
  }

  const row = toLottoDrawRow(game, selectedDraw);
  const isNew = !existing ||
    row.draw_date > existing.draw_date ||
    String(row.draw_id).localeCompare(String(existing.draw_id), undefined, { numeric: true }) > 0;

  if (!options.dryRun && isNew) {
    await upsertRows(options.supabaseUrl, options.serviceRoleKey, "lotto_draws", [row]);
  }

  return {
    game,
    status: options.dryRun ? "dry_run" : isNew ? "updated" : "unchanged",
    selected_draw: selectedDraw,
    official_draw: officialDraw,
    secondary_draw: secondaryDraw,
  };
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
    const requestedGame = url.searchParams.get("game") ?? "all";
    const dryRun = url.searchParams.get("dry_run") === "1";
    const taiwan = taiwanDateParts();
    const targetDate = url.searchParams.get("target_date") ?? taiwan.date;
    const games: GameType[] = requestedGame === "539"
      ? ["539"]
      : requestedGame === "649"
        ? ["649"]
        : requestedGame === "power"
          ? ["power"]
          : ["649", "539", "power"];

    if (!["all", "539", "649", "power"].includes(requestedGame)) {
      return failFast(400, "Unsupported game parameter", requestedGame, "Use game=all, game=539, game=649, or game=power.");
    }

    const results = [];
    for (const game of games) {
      results.push(await updateGame(game, {
        supabaseUrl,
        serviceRoleKey,
        targetDate,
        taiwanHour: taiwan.hour,
        dryRun,
      }));
    }

    const evaluated_predictions = dryRun
      ? []
      : await evaluateReadyPredictions(supabaseUrl, serviceRoleKey, targetDate);

    const performanceSnapshot = dryRun
      ? null
      : await rebuildPerformanceSnapshot(supabaseUrl, serviceRoleKey);
    const performanceSummary = performanceSnapshot
      ? {
        last_updated: performanceSnapshot.last_updated,
        games: Object.fromEntries(
          Object.entries((performanceSnapshot.games ?? {}) as Record<string, { total_draws_evaluated?: number; trend?: unknown[] }>)
            .map(([gameName, game]) => [gameName, {
              total_draws_evaluated: game.total_draws_evaluated,
              trend_points: game.trend?.length ?? 0,
            }]),
        ),
      }
      : null;

    const [lotto649Total, daily539Total, powerTotal] = await Promise.all([
      fetchDrawCount(supabaseUrl, serviceRoleKey, "649"),
      fetchDrawCount(supabaseUrl, serviceRoleKey, "539"),
      fetchDrawCount(supabaseUrl, serviceRoleKey, "power"),
    ]);

    const metaPayload = {
      last_updated: new Date().toISOString(),
      lotto649_total: lotto649Total,
      daily539_total: daily539Total,
      power_total: powerTotal,
      source: "supabase_edge_function",
      target_date: targetDate,
      results,
      evaluated_predictions,
      performance_snapshot: performanceSummary,
    };

    if (!dryRun) {
      await upsertMeta(supabaseUrl, serviceRoleKey, metaPayload);
    }

    return jsonResponse(200, {
      Status: "ok",
      dry_run: dryRun,
      target_date: targetDate,
      results,
      evaluated_predictions,
      performance_snapshot: performanceSummary,
    });
  } catch (error) {
    return failFast(
      500,
      "Lotto update failed.",
      error instanceof Error ? error.message : error,
      "Check Supabase function secrets, Taiwan Lottery source availability, and the secondary source parser.",
    );
  }
}

Deno.serve(handleRequest);
