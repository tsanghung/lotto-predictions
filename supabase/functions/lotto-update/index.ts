import {
  buildAsiLearningRecord,
  buildDrawRevision,
  buildLaiLearningEvidence,
  buildPerformanceSnapshot,
  chooseFreshestDraw,
  drawPayloadChanged,
  evaluatePredictionRecord,
  hasExplicitDrawRevision,
  latestByDrawId,
  needsSecondaryDaily539Check,
  parseAuzonetDaily539Html,
  parseOfficialPayload,
  runPostDrawLearning,
  taiwanDateParts,
  toLottoDrawRow,
} from "./lib/lottoCore.js";
import { runEvidenceLearning } from "./lib/evidenceLearning.js";
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
  corrections: EvidenceCorrectionContext[];
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
  raw?: Record<string, unknown>;
};

type EvidenceCorrectionContext = {
  gameName: string;
  drawId: string;
  sourceRevision: string;
  previousRevision: string;
  previousDraw: DrawRow;
};

type ModelForecastRow = {
  id: string;
  game_name: string;
  target_draw_date: string;
  model_name: string;
  model_version: string;
  forecast_mode: "shadow" | "canary" | "production";
  probabilities: number[];
  special_probabilities: number[] | null;
  final_groups: Record<string, unknown>;
  agent_state_version: number | null;
  registry_id?: string | null;
  experiment_run_id?: string | null;
  feature_version?: string | null;
  random_seed?: string | null;
  code_commit?: string | null;
  replay_digest?: string | null;
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
  learning_claim_token?: string;
  prediction_source_key?: string;
  last_learned_draw_date: string | null;
};


type LearningClaimRequest = {
  game_name: string;
  draw_id: string;
  draw_date: string;
  source_key: string;
};

type LearningClaimResult = {
  status: "claimed" | "already_learned" | "deferred_earlier_draw" | "in_progress" | "not_eligible";
  draw_id?: string;
  claim_token: string | null;
  blocking_draw_id?: string;
  blocking_draw_date?: string;
  lease_expires_at?: string;
};
type LearningRecoveryResult = {
  status: "rewound" | "already_learned" | "deferred_earlier_draw" | "not_needed" | "not_eligible";
  draw_id?: string;
  blocking_draw_id?: string;
  replay_from_date?: string;
  replay_through_date?: string;
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

async function fetchExistingDraw(
  supabaseUrl: string,
  serviceRoleKey: string,
  gameName: string,
  drawId: string,
): Promise<DrawRow | null> {
  const params = new URLSearchParams({
    select: "game_name,draw_id,draw_date,numbers,special_number,raw",
    game_name: `eq.${gameName}`,
    draw_id: `eq.${drawId}`,
    limit: "1",
  });
  const response = await fetch(`${supabaseUrl}/rest/v1/lotto_draws?${params}`, {
    headers: supabaseHeaders(serviceRoleKey),
  });
  if (!response.ok) {
    throw new Error(`Supabase draw lookup failed: ${response.status} ${await response.text()}`);
  }
  const rows = await response.json() as DrawRow[];
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

async function fetchAgentStateCheckpoint(
  supabaseUrl: string,
  serviceRoleKey: string,
  gameName: string,
  drawId: string,
): Promise<AgentStatePayload | null> {
  const params = new URLSearchParams({
    select: "game_name,state_version,status,champion_model,expert_weights,learning_config,metrics,last_learned_draw_id,last_learned_draw_date",
    game_name: `eq.${gameName}`,
    last_learned_draw_id: `eq.${drawId}`,
    order: "state_version.desc",
    limit: "1",
  });
  const response = await fetch(`${supabaseUrl}/rest/v1/lotto_agent_states?${params}`, {
    headers: supabaseHeaders(serviceRoleKey),
  });

  if (!response.ok) {
    throw new Error(`Supabase agent checkpoint query failed: ${response.status} ${await response.text()}`);
  }

  const rows = await response.json() as AgentStatePayload[];
  return rows[0] ?? null;
}

async function recoverAgentLearningOrder(
  supabaseUrl: string,
  serviceRoleKey: string,
  request: Omit<LearningClaimRequest, "source_key">,
): Promise<LearningRecoveryResult> {
  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/recover_lai_learning_order`, {
    method: "POST",
    headers: supabaseHeaders(serviceRoleKey),
    body: JSON.stringify({
      p_game_name: request.game_name,
      p_draw_id: request.draw_id,
      p_draw_date: request.draw_date,
    }),
  });

  if (!response.ok) {
    throw new Error(`Supabase learning order recovery failed: ${response.status} ${await response.text()}`);
  }

  const payload = await response.json() as LearningRecoveryResult | LearningRecoveryResult[];
  const recovery = Array.isArray(payload) ? payload[0] : payload;
  const allowedStatuses = new Set([
    "rewound",
    "already_learned",
    "deferred_earlier_draw",
    "not_needed",
    "not_eligible",
  ]);
  if (!recovery || !allowedStatuses.has(recovery.status)) {
    throw new Error("Supabase learning order recovery returned an invalid status");
  }
  return recovery;
}
async function claimAgentLearning(
  supabaseUrl: string,
  serviceRoleKey: string,
  request: LearningClaimRequest,
): Promise<LearningClaimResult> {
  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/claim_next_lai_learning`, {
    method: "POST",
    headers: supabaseHeaders(serviceRoleKey),
    body: JSON.stringify({
      p_game_name: request.game_name,
      p_draw_id: request.draw_id,
      p_draw_date: request.draw_date,
      p_source_key: request.source_key,
      p_lease_seconds: 120,
    }),
  });

  if (!response.ok) {
    throw new Error(`Supabase ordered learning claim failed: ${response.status} ${await response.text()}`);
  }

  const payload = await response.json() as LearningClaimResult | LearningClaimResult[];
  const claim = Array.isArray(payload) ? payload[0] : payload;
  const allowedStatuses = new Set([
    "claimed",
    "already_learned",
    "deferred_earlier_draw",
    "in_progress",
    "not_eligible",
  ]);
  if (!claim || !allowedStatuses.has(claim.status)) {
    throw new Error("Supabase ordered learning claim returned an invalid status");
  }
  if (claim.status === "claimed" && !claim.claim_token) {
    throw new Error("Supabase ordered learning claim returned no claim_token");
  }
  return claim;
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
    registry_id: "is.null",
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
      "forecast.registry_id": "is.null",
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
    `${supabaseUrl}/rest/v1/rpc/upsert_lotto_model_scores`,
    {
      method: "POST",
      headers: supabaseHeaders(serviceRoleKey),
      body: JSON.stringify({ p_scores: persistedRows }),
    },
  );

  if (!response.ok) {
    throw new Error(`Supabase model score upsert failed: ${response.status} ${await response.text()}`);
  }
}

async function fetchV3Forecasts(
  supabaseUrl: string,
  serviceRoleKey: string,
  gameName: string,
  targetDrawDate: string,
): Promise<ModelForecastRow[]> {
  const params = new URLSearchParams({
    select: "id,game_name,target_draw_date,model_name,model_version,forecast_mode,probabilities,special_probabilities,final_groups,agent_state_version,registry_id,experiment_run_id,feature_version,random_seed,code_commit,replay_digest",
    game_name: `eq.${gameName}`,
    target_draw_date: `eq.${targetDrawDate}`,
    registry_id: "not.is.null",
    order: "model_name.asc,model_version.asc,forecast_mode.asc",
  });
  const response = await fetch(`${supabaseUrl}/rest/v1/lotto_model_forecasts?${params}`, {
    headers: supabaseHeaders(serviceRoleKey),
  });
  if (!response.ok) {
    throw new Error(`Supabase LAI v3 forecast query failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function fetchV3ValidScoreHistory(
  supabaseUrl: string,
  serviceRoleKey: string,
  gameName: string,
  throughDrawDate: string,
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  const pageSize = 1000;
  let offset = 0;
  while (true) {
    const params = new URLSearchParams({
      select: "id,forecast_id,game_name,draw_id,draw_date,metrics,weight_before,weight_after,evaluator_version,source_revision,is_valid,supersedes_score_id,forecast:lotto_model_forecasts!inner(registry_id,model_name,forecast_mode,experiment_run_id,registry:lai_model_registry!inner(model_family))",
      game_name: `eq.${gameName}`,
      draw_date: `lte.${throughDrawDate}`,
      is_valid: "eq.true",
      "forecast.registry_id": "not.is.null",
      order: "draw_date.asc,draw_id.asc",
      limit: String(pageSize),
      offset: String(offset),
    });
    const response = await fetch(`${supabaseUrl}/rest/v1/lotto_model_scores?${params}`, {
      headers: supabaseHeaders(serviceRoleKey),
    });
    if (!response.ok) {
      throw new Error(`Supabase LAI v3 score history query failed: ${response.status} ${await response.text()}`);
    }
    const page = await response.json() as Record<string, unknown>[];
    rows.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }
  return rows;
}

async function insertV3ScoresIdempotently(
  supabaseUrl: string,
  serviceRoleKey: string,
  scoreRows: Record<string, unknown>[],
): Promise<void> {
  if (!scoreRows.length) return;
  const persistedRows = scoreRows.map((row) => {
    const { registry_id: _registryId, model_name: _modelName, model_family: _modelFamily, forecast_mode: _forecastMode, ...persisted } = row;
    return persisted;
  });
  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/upsert_lotto_model_scores`, {
    method: "POST",
    headers: supabaseHeaders(serviceRoleKey),
    body: JSON.stringify({ p_scores: persistedRows }),
  });
  if (!response.ok) {
    throw new Error(`Supabase LAI v3 score upsert failed: ${response.status} ${await response.text()}`);
  }
}

async function fetchV3Registry(
  supabaseUrl: string,
  serviceRoleKey: string,
  gameName: string,
): Promise<Record<string, unknown>[]> {
  const params = new URLSearchParams({
    select: "id,game_name,model_name,model_family,status",
    game_name: `eq.${gameName}`,
    order: "model_family.asc,model_name.asc",
  });
  const response = await fetch(`${supabaseUrl}/rest/v1/lai_model_registry?${params}`, {
    headers: supabaseHeaders(serviceRoleKey),
  });
  if (!response.ok) {
    throw new Error(`Supabase LAI v3 registry query failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function recordV3Decision(
  supabaseUrl: string,
  serviceRoleKey: string,
  decision: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/record_lai_v3_decision`, {
    method: "POST",
    headers: supabaseHeaders(serviceRoleKey),
    body: JSON.stringify({ p_decision: decision }),
  });
  if (!response.ok) {
    throw new Error(`Supabase LAI v3 decision failed: ${response.status} ${await response.text()}`);
  }
  const payload = await response.json() as Record<string, unknown> | Record<string, unknown>[];
  return Array.isArray(payload) ? payload[0] : payload;
}

async function activateAuthorizedV3State(
  supabaseUrl: string,
  serviceRoleKey: string,
  decision: Record<string, unknown>,
  state: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/activate_lai_v3_state`, {
    method: "POST",
    headers: supabaseHeaders(serviceRoleKey),
    body: JSON.stringify({ p_decision_id: decision.id, p_state: state }),
  });
  if (!response.ok) {
    throw new Error(`Supabase LAI v3 activation failed: ${response.status} ${await response.text()}`);
  }
  const payload = await response.json() as Record<string, unknown> | Record<string, unknown>[];
  return Array.isArray(payload) ? payload[0] : payload;
}

async function recordV3Failure(
  supabaseUrl: string,
  serviceRoleKey: string,
  failure: Record<string, unknown>,
): Promise<void> {
  const experimentRunId = typeof failure.experimentRunId === "string" ? failure.experimentRunId : null;
  if (!experimentRunId) return;
  const response = await fetch(`${supabaseUrl}/rest/v1/lai_experiment_runs?id=eq.${encodeURIComponent(experimentRunId)}`, {
    method: "PATCH",
    headers: { ...supabaseHeaders(serviceRoleKey), Prefer: "return=minimal" },
    body: JSON.stringify({ status: "failed", error_text: String(failure.message ?? "LAI v3 evidence failure") }),
  });
  if (!response.ok) {
    throw new Error(`Supabase LAI v3 failure record failed: ${response.status} ${await response.text()}`);
  }
}

async function recordV3Correction(
  supabaseUrl: string,
  serviceRoleKey: string,
  correction: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/record_lai_v3_correction`, {
    method: "POST",
    headers: supabaseHeaders(serviceRoleKey),
    body: JSON.stringify({ p_correction: correction }),
  });
  if (!response.ok) {
    throw new Error(`Supabase LAI v3 correction failed: ${response.status} ${await response.text()}`);
  }
  const payload = await response.json() as Record<string, unknown> | Record<string, unknown>[];
  return Array.isArray(payload) ? payload[0] : payload;
}

async function activateAgentState(
  supabaseUrl: string,
  serviceRoleKey: string,
  nextState: AgentStatePayload,
): Promise<AgentStatePayload> {
  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/activate_lotto_agent_state`, {
    method: "POST",
    headers: supabaseHeaders(serviceRoleKey),
    body: JSON.stringify({ p_state: nextState }),
  });

  if (!response.ok) {
    throw new Error(`Supabase agent state activation failed: ${response.status} ${await response.text()}`);
  }

  const payload = await response.json() as AgentStatePayload | AgentStatePayload[];
  const activated = Array.isArray(payload) ? payload[0] : payload;
  if (!activated ||
    typeof activated.game_name !== "string" ||
    !Number.isFinite(Number(activated.state_version)) ||
    activated.last_learned_draw_id == null) {
    throw new Error("Supabase agent state activation returned an invalid checkpoint");
  }
  return activated;
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
    select: "game_name,draw_id,draw_date,numbers,special_number,raw",
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runEvidenceLearningForDraw(
  supabaseUrl: string,
  serviceRoleKey: string,
  draw: DrawRow,
  correction: EvidenceCorrectionContext | null = null,
): Promise<Record<string, unknown>> {
  const sourceRevision = correction?.sourceRevision ?? await buildDrawRevision(draw);
  return runEvidenceLearning({
    gameName: draw.game_name,
    draw,
    config: gameConfigForName(draw.game_name),
    sourceRevision,
    ...(correction ? {
      correction: {
        previousRevision: correction.previousRevision,
        previousDraw: correction.previousDraw,
        reason: "official_draw_payload_changed",
      },
    } : {}),
  }, {
    fetchV3Forecasts: (gameName: string, drawDate: string) =>
      fetchV3Forecasts(supabaseUrl, serviceRoleKey, gameName, drawDate),
    fetchValidScoreHistory: (gameName: string, drawDate: string) =>
      fetchV3ValidScoreHistory(supabaseUrl, serviceRoleKey, gameName, drawDate),
    insertScoresIdempotently: (rows: Record<string, unknown>[]) =>
      insertV3ScoresIdempotently(supabaseUrl, serviceRoleKey, rows),
    fetchRegistry: (gameName: string) => fetchV3Registry(supabaseUrl, serviceRoleKey, gameName),
    fetchActiveState: (gameName: string) => fetchActiveAgentState(supabaseUrl, serviceRoleKey, gameName),
    recordDecision: (decision: Record<string, unknown>) => recordV3Decision(supabaseUrl, serviceRoleKey, decision),
    activateAuthorizedState: (decision: Record<string, unknown>, state: Record<string, unknown>) =>
      activateAuthorizedV3State(supabaseUrl, serviceRoleKey, decision, state),
    recordFailure: (failure: Record<string, unknown>) => recordV3Failure(supabaseUrl, serviceRoleKey, failure),
    recordCorrection: (payload: Record<string, unknown>) => recordV3Correction(supabaseUrl, serviceRoleKey, payload),
  });
}

async function runEvidenceLearningIsolated(
  supabaseUrl: string,
  serviceRoleKey: string,
  draw: DrawRow,
  correction: EvidenceCorrectionContext | null = null,
): Promise<Record<string, unknown>> {
  let v3Result: Record<string, unknown> = { status: "disabled" };
  try {
    v3Result = await runEvidenceLearningForDraw(supabaseUrl, serviceRoleKey, draw, correction);
  } catch (error) {
    try {
      await recordV3Failure(supabaseUrl, serviceRoleKey, { message: errorMessage(error) });
    } catch {
      // The evidence path must never roll back a confirmed draw or LAI v2 checkpoint.
    }
    v3Result = { status: "failed_isolated", root_cause: errorMessage(error) };
  }
  return v3Result;
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
  correctionsByDraw = new Map<string, EvidenceCorrectionContext>(),
  v3Evidence: Record<string, unknown>[] = [],
): Promise<Array<{ source_key: string; game_name: string; target_draw_date: string; draw_id: string }>> {
  const predictions = await fetchReadyPredictions(supabaseUrl, serviceRoleKey, targetDate);
  const evaluated = [];

  for (const prediction of predictions) {
    const draw = await fetchDrawForPrediction(supabaseUrl, serviceRoleKey, prediction);
    if (!draw) {
      continue;
    }

    const evaluation = evaluatePredictionRecord(prediction, draw);
    const learningResult = await runPostDrawLearning({
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
        fetchAgentStateCheckpoint: (gameName: string, drawId: string) =>
          fetchAgentStateCheckpoint(
            supabaseUrl,
            serviceRoleKey,
            gameName,
            drawId,
          ),
        recoverAgentLearningOrder: (request: Omit<LearningClaimRequest, "source_key">) =>
          recoverAgentLearningOrder(
            supabaseUrl,
            serviceRoleKey,
            request,
          ),
        claimAgentLearning: (request: LearningClaimRequest) => claimAgentLearning(
          supabaseUrl,
          serviceRoleKey,
          request,
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

    if (!["learned", "already_learned"].includes(learningResult.learning_status)) {
      continue;
    }

    const correction = correctionsByDraw.get(`${draw.game_name}|${draw.draw_id}`) ?? null;
    const v3Result = await runEvidenceLearningIsolated(supabaseUrl, serviceRoleKey, draw, correction);
    v3Evidence.push({
      game_name: draw.game_name,
      draw_id: draw.draw_id,
      ...v3Result,
    });

    const asiLearningRecord = buildAsiLearningRecord(prediction, draw, evaluation);
    const laiEvidence = buildLaiLearningEvidence(learningResult);
    if (laiEvidence) {
      asiLearningRecord.raw_learning_report = {
        ...(asiLearningRecord.raw_learning_report || {}),
        lai: laiEvidence,
      };
    }
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

  // Backfill every draw newer than the current latest draw, while also retaining
  // correction context for an existing draw whose authoritative payload changed.
  const rows: DrawRow[] = [];
  const corrections: EvidenceCorrectionContext[] = [];
  const orderedCandidates = [...candidates]
    .sort((left, right) => String(left.draw_id).localeCompare(String(right.draw_id), undefined, { numeric: true }));
  for (const candidate of orderedCandidates) {
    const row = toLottoDrawRow(game, candidate) as DrawRow;
    const sourceRevision = await buildDrawRevision(row);
    row.raw = {
      ...(row.raw || {}),
      source_revision: sourceRevision,
      source_revision_kind: hasExplicitDrawRevision(row) ? "official" : "canonical",
    };
    const existingDraw = await fetchExistingDraw(
      options.supabaseUrl,
      options.serviceRoleKey,
      row.game_name,
      row.draw_id,
    );
    const isCorrection = existingDraw != null && drawPayloadChanged(existingDraw, row);
    if (isCorrection) {
      corrections.push({
        gameName: row.game_name,
        drawId: row.draw_id,
        sourceRevision,
        previousRevision: await buildDrawRevision(existingDraw),
        previousDraw: existingDraw,
      });
    }
    if (isDrawNewerThanExisting(candidate, existing) || isCorrection) {
      rows.push(row);
    }
  }

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
    corrections,
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

    const correctionsByDraw = new Map<string, EvidenceCorrectionContext>(
      results.flatMap((result) => result.corrections)
        .map((correction) => [`${correction.gameName}|${correction.drawId}`, correction]),
    );
    const v3_evidence: Record<string, unknown>[] = [];
    const evaluated_predictions = dryRun
      ? []
      : await evaluateReadyPredictions(supabaseUrl, serviceRoleKey, targetDate, correctionsByDraw, v3_evidence);

    if (!dryRun) {
      const processedDraws = new Set(v3_evidence.map((result) => `${result.game_name}|${result.draw_id}`));
      for (const correction of correctionsByDraw.values()) {
        const key = `${correction.gameName}|${correction.drawId}`;
        if (processedDraws.has(key)) continue;
        const draw = await fetchExistingDraw(supabaseUrl, serviceRoleKey, correction.gameName, correction.drawId);
        if (!draw) continue;
        const v3Result = await runEvidenceLearningIsolated(supabaseUrl, serviceRoleKey, draw, correction);
        v3_evidence.push({ game_name: draw.game_name, draw_id: draw.draw_id, ...v3Result });
      }
    }

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
      v3_evidence,
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
      v3_evidence,
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
