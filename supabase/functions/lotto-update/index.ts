import {
  buildAsiLearningRecord,
  buildPerformanceSnapshot,
  chooseFreshestDraw,
  evaluatePredictionRecord,
  latestByDrawId,
  needsSecondaryDaily539Check,
  parseAuzonetDaily539Html,
  parseOfficialPayload,
  runPostDrawLearning,
  taiwanDateParts,
  toLottoDrawRow,
} from "./lib/lottoCore.js";
import { GAME_CONFIG } from "../lotto-predict-notify/lib/gameConfig.js";

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
  inserted_count: number;
  inserted_draw_ids: string[];
  latest_official_draw: LottoDraw | null;
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

type ModelForecastRow = {
  id: string;
  game_name: string;
  target_draw_date: string;
  model_name: string;
  model_version: string;
  forecast_mode: "shadow" | "production";
  probabilities: number[];
  special_probabilities: number[] | null;
  final_groups: Record<string, unknown>;
  agent_state_version: number | null;
};

type ModelScoreRow = {
  forecast_id: string;
  game_name: string;
  model_name: string;
  draw_id: string;
  draw_date: string;
  metrics: Record<string, unknown>;
  weight_before: number | null;
  weight_after: number | null;
  evaluator_version: string;
};

type ModelScoreHistoryDbRow = Omit<ModelScoreRow, "model_name"> & {
  forecast: { model_name: string } | null;
};

type AgentStatePayload = {
  game_name: string;
  state_version: number;
  status: "baseline" | "champion" | "degraded";
  champion_model: string;
  expert_weights: Record<string, number>;
  learning_config: Record<string, unknown>;
  metrics: Record<string, unknown>;
  last_learned_draw_id: string | null;
  last_learned_draw_date: string | null;
};

type EnsembleScoreRow = {
  draw_id: string;
  draw_date: string;
  metrics: {
    brier_skill_score?: number;
    coverage?: {
      union_hits?: number;
      group_a_hits?: number;
      group_b_hits?: number;
    };
  };
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

function gameConfigForName(gameName: string) {
  const config = Object.values(GAME_CONFIG).find((candidate) => candidate.name === gameName);
  if (!config) {
    throw new Error(`Unsupported LAI game name: ${gameName}`);
  }
  return config;
}

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

function monthOf(dateString: string): string {
  return dateString.slice(0, 7);
}

// draw_id 為遞增序號（如 115000159）；用數值比較判斷是否比 DB 現有最新期更新。
function isDrawNewerThanExisting(
  draw: { draw_id: string },
  existing: { draw_id: string } | null,
): boolean {
  if (!existing) {
    return true;
  }
  return String(draw.draw_id).localeCompare(String(existing.draw_id), undefined, { numeric: true }) > 0;
}

// 抓取 startMonth..endMonth 區間內的「所有」開獎（不再只取最新一期），
// 讓漏掉的期數能在後續執行時被補齊（見 updateGame 的 backfill 邏輯）。
async function fetchOfficialDrawsInRange(
  game: GameType,
  startMonth: string,
  endMonth: string,
): Promise<LottoDraw[]> {
  const params = new URLSearchParams({
    period: "",
    month: startMonth,
    endMonth,
    pageNum: "1",
    pageSize: "200",
  });
  const payload = await fetchJson(`${OFFICIAL_URLS[game]}?${params}`);
  return parseOfficialPayload(game, payload) as LottoDraw[];
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

async function fetchActiveAgentState(
  supabaseUrl: string,
  serviceRoleKey: string,
  gameName: string,
): Promise<AgentStatePayload | null> {
  const params = new URLSearchParams({
    select: "game_name,state_version,status,champion_model,expert_weights,learning_config,metrics,last_learned_draw_id,last_learned_draw_date",
    game_name: `eq.${gameName}`,
    is_active: "eq.true",
    limit: "1",
  });
  const response = await fetch(`${supabaseUrl}/rest/v1/lotto_agent_states?${params}`, {
    headers: supabaseHeaders(serviceRoleKey),
  });

  if (!response.ok) {
    throw new Error(`Supabase active agent state query failed: ${response.status} ${await response.text()}`);
  }

  const rows = await response.json() as AgentStatePayload[];
  return rows[0] ?? null;
}

async function fetchUnscoredModelForecasts(
  supabaseUrl: string,
  serviceRoleKey: string,
  gameName: string,
  targetDrawDate: string,
): Promise<ModelForecastRow[]> {
  const params = new URLSearchParams({
    select: "id,game_name,target_draw_date,model_name,model_version,forecast_mode,probabilities,special_probabilities,final_groups,agent_state_version",
    game_name: `eq.${gameName}`,
    target_draw_date: `eq.${targetDrawDate}`,
    order: "model_name.asc,model_version.asc,forecast_mode.asc",
  });
  const response = await fetch(`${supabaseUrl}/rest/v1/lotto_model_forecasts?${params}`, {
    headers: supabaseHeaders(serviceRoleKey),
  });

  if (!response.ok) {
    throw new Error(`Supabase model forecast query failed: ${response.status} ${await response.text()}`);
  }

  return response.json();
}

async function fetchModelScoreHistory(
  supabaseUrl: string,
  serviceRoleKey: string,
  gameName: string,
  throughDrawDate: string,
): Promise<ModelScoreRow[]> {
  const rows: ModelScoreHistoryDbRow[] = [];
  const pageSize = 1000;
  let offset = 0;

  while (true) {
    const params = new URLSearchParams({
      select: "forecast_id,game_name,draw_id,draw_date,metrics,weight_before,weight_after,evaluator_version,forecast:lotto_model_forecasts!inner(model_name)",
      game_name: `eq.${gameName}`,
      draw_date: `lte.${throughDrawDate}`,
      order: "draw_date.asc,draw_id.asc",
      limit: String(pageSize),
      offset: String(offset),
    });
    const response = await fetch(`${supabaseUrl}/rest/v1/lotto_model_scores?${params}`, {
      headers: supabaseHeaders(serviceRoleKey),
    });

    if (!response.ok) {
      throw new Error(`Supabase model score history query failed: ${response.status} ${await response.text()}`);
    }

    const page = await response.json() as ModelScoreHistoryDbRow[];
    rows.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }

  return rows.map(({ forecast, ...row }) => {
    if (!forecast?.model_name) {
      throw new Error(`Supabase model score history row ${row.forecast_id} is missing model identity`);
    }
    return { ...row, model_name: forecast.model_name };
  });
}

async function upsertModelScores(
  supabaseUrl: string,
  serviceRoleKey: string,
  scoreRows: ModelScoreRow[],
): Promise<void> {
  if (!scoreRows.length) {
    return;
  }

  const persistedRows = scoreRows.map(({ model_name: _modelName, ...row }) => row);
  const response = await fetch(
    `${supabaseUrl}/rest/v1/lotto_model_scores?on_conflict=forecast_id,draw_id`,
    {
      method: "POST",
      headers: {
        ...supabaseHeaders(serviceRoleKey),
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(persistedRows),
    },
  );

  if (!response.ok) {
    throw new Error(`Supabase model score upsert failed: ${response.status} ${await response.text()}`);
  }
}

async function activateAgentState(
  supabaseUrl: string,
  serviceRoleKey: string,
  nextState: AgentStatePayload,
): Promise<void> {
  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/activate_lotto_agent_state`, {
    method: "POST",
    headers: supabaseHeaders(serviceRoleKey),
    body: JSON.stringify({ p_state: nextState }),
  });

  if (!response.ok) {
    throw new Error(`Supabase agent state activation failed: ${response.status} ${await response.text()}`);
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

async function fetchEnsembleModelScores(
  supabaseUrl: string,
  serviceRoleKey: string,
  gameName: string,
): Promise<EnsembleScoreRow[]> {
  const params = new URLSearchParams({
    select: "draw_id,draw_date,metrics,forecast:lotto_model_forecasts!inner(model_name)",
    game_name: `eq.${gameName}`,
    "forecast.model_name": "eq.ensemble",
    order: "draw_date.asc,draw_id.asc",
  });
  const response = await fetch(`${supabaseUrl}/rest/v1/lotto_model_scores?${params}`, {
    headers: supabaseHeaders(serviceRoleKey),
  });

  if (!response.ok) {
    throw new Error(`Supabase ensemble score query failed: ${response.status} ${await response.text()}`);
  }

  return response.json();
}

async function fetchLaiPerformanceByGame(
  supabaseUrl: string,
  serviceRoleKey: string,
  gameNames: string[],
): Promise<Record<string, unknown>> {
  const entries = await Promise.all(gameNames.map(async (gameName) => {
    const config = gameConfigForName(gameName);
    const [scoreRows, latestState] = await Promise.all([
      fetchEnsembleModelScores(supabaseUrl, serviceRoleKey, gameName),
      fetchActiveAgentState(supabaseUrl, serviceRoleKey, gameName),
    ]);
    const byDraw = new Map<string, EnsembleScoreRow>();
    for (const row of scoreRows) {
      byDraw.set(String(row.draw_id), row);
    }
    const uniqueRows = [...byDraw.values()].sort((left, right) => (
      left.draw_date.localeCompare(right.draw_date) ||
      String(left.draw_id).localeCompare(String(right.draw_id), undefined, { numeric: true })
    ));
    const coverageTotals = uniqueRows.reduce((totals, row) => ({
      unionHits: totals.unionHits + Number(row.metrics?.coverage?.union_hits || 0),
      groupAHits: totals.groupAHits + Number(row.metrics?.coverage?.group_a_hits || 0),
      groupBHits: totals.groupBHits + Number(row.metrics?.coverage?.group_b_hits || 0),
    }), { unionHits: 0, groupAHits: 0, groupBHits: 0 });

    return [gameName, {
      latestMetrics: uniqueRows.at(-1)?.metrics ?? {},
      latestState,
      ...coverageTotals,
      actualNumberCount: uniqueRows.length * config.picks,
      evaluatedDraws: uniqueRows.length,
    }] as const;
  }));

  return Object.fromEntries(entries);
}

async function rebuildPerformanceSnapshot(
  supabaseUrl: string,
  serviceRoleKey: string,
): Promise<Record<string, unknown>> {
  const evaluatedPredictions = await fetchEvaluatedPredictions(supabaseUrl, serviceRoleKey);
  const gameNames = [...new Set(evaluatedPredictions.map((record) => record.game_name))];
  const laiByGame = await fetchLaiPerformanceByGame(supabaseUrl, serviceRoleKey, gameNames);
  const generatedAt = new Date().toISOString();
  const snapshot = buildPerformanceSnapshot(evaluatedPredictions, generatedAt, laiByGame);
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
    await runPostDrawLearning({
      prediction,
      draw,
      evaluation,
      config: gameConfigForName(prediction.game_name),
      deps: {
        fetchForecasts: () => fetchUnscoredModelForecasts(
          supabaseUrl,
          serviceRoleKey,
          prediction.game_name,
          prediction.target_draw_date,
        ),
        fetchActiveState: () => fetchActiveAgentState(
          supabaseUrl,
          serviceRoleKey,
          prediction.game_name,
        ),
        fetchScoreHistory: () => fetchModelScoreHistory(
          supabaseUrl,
          serviceRoleKey,
          prediction.game_name,
          draw.draw_date,
        ),
        upsertModelScores: (rows: ModelScoreRow[]) => upsertModelScores(
          supabaseUrl,
          serviceRoleKey,
          rows,
        ),
        activateAgentState: (state: AgentStatePayload) => activateAgentState(
          supabaseUrl,
          serviceRoleKey,
          state,
        ),
        markPredictionEvaluated: (sourceKey: string, result: Record<string, unknown>) =>
          markPredictionEvaluated(supabaseUrl, serviceRoleKey, sourceKey, result),
      },
    });

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

  // 從「DB 現有最新期所在月份」抓到「目標月份」——涵蓋任何漏掉的期數（含跨月缺口）。
  const targetMonth = monthOf(options.targetDate);
  const startMonth = existing?.draw_date ? monthOf(existing.draw_date) : targetMonth;
  const officialDraws = await fetchOfficialDrawsInRange(game, startMonth, targetMonth);
  if (!officialDraws.length) {
    throw new Error(`Official API returned no ${game} draws for ${startMonth}..${targetMonth}`);
  }
  const latestOfficial = latestByDrawId(officialDraws) as LottoDraw;

  // 539 備援：官方尚未公布當期最新開獎時，補抓 auzonet 取較新的一期。
  let secondaryDraw: LottoDraw | null = null;
  const candidates: LottoDraw[] = [...officialDraws];
  if (
    game === "539" &&
    needsSecondaryDaily539Check({
      latestOfficialDate: latestOfficial?.date,
      targetDate: options.targetDate,
      taiwanHour: options.taiwanHour,
    })
  ) {
    secondaryDraw = await fetchAuzonetDaily539();
    const freshest = chooseFreshestDraw(latestOfficial, secondaryDraw) as LottoDraw;
    if (!candidates.some((d) => String(d.draw_id) === String(freshest.draw_id))) {
      candidates.push(freshest);
    }
  }

  // 核心修正：把「所有比 DB 現有最新期更新的開獎」一次補齊，而不是只插入單一最新期。
  // 舊版只插最新一期，導致某天漏跑後，缺口永遠補不回來（見 07/01、07/02 事故）。
  const rows = candidates
    .filter((draw) => isDrawNewerThanExisting(draw, existing))
    .map((draw) => toLottoDrawRow(game, draw))
    .sort((a, b) => String(a.draw_id).localeCompare(String(b.draw_id), undefined, { numeric: true }));

  if (!options.dryRun && rows.length) {
    await upsertRows(options.supabaseUrl, options.serviceRoleKey, "lotto_draws", rows);
  }

  return {
    game,
    status: options.dryRun ? "dry_run" : rows.length ? "updated" : "unchanged",
    inserted_count: rows.length,
    inserted_draw_ids: rows.map((r) => String(r.draw_id)),
    latest_official_draw: latestOfficial,
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
