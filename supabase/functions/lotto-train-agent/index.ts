import {
  executeTrainingRun,
  isServiceRoleRequest,
} from "./lib/trainingCore.js";

type JsonRecord = Record<string, unknown>;

const DRAW_ORDER = "order=draw_date.asc%2Cdraw_id.asc";
const LEASE_MILLISECONDS = 10 * 60 * 1000;

function jsonResponse(status: number, body: JsonRecord): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function fail(status: number, rootCause: string, suggestedFix: string): Response {
  return jsonResponse(status, {
    status: "failed",
    root_cause: rootCause,
    suggested_fix: suggestedFix,
  });
}

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not configured`);
  return value.replace(/\/+$/, "");
}

function configuredSecretKeys(): string[] {
  const values: string[] = [];
  const json = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (json) {
    const parsed = JSON.parse(json) as Record<string, string>;
    values.push(...Object.values(parsed).filter(Boolean));
  }
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) values.push(legacy);
  return [...new Set(values)];
}

function headersFor(serviceKey: string, prefer?: string): HeadersInit {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json",
    ...(prefer ? { Prefer: prefer } : {}),
  };
}

async function responseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`Supabase REST returned ${response.status}: ${text.slice(0, 300)}`);
  }
  return parsed;
}

function assertRows(value: unknown): JsonRecord[] {
  if (!Array.isArray(value)) throw new Error("Supabase REST did not return an array");
  return value as JsonRecord[];
}

function makeRepository(supabaseUrl: string, serviceKey: string) {
  async function patchRun(run: JsonRecord, body: JsonRecord): Promise<JsonRecord | null> {
    const query = [
      `id=eq.${encodeURIComponent(String(run.id))}`,
      `updated_at=eq.${encodeURIComponent(String(run.updated_at))}`,
      "select=*",
    ].join("&");
    const response = await fetch(`${supabaseUrl}/rest/v1/lotto_training_runs?${query}`, {
      method: "PATCH",
      headers: headersFor(serviceKey, "return=representation"),
      body: JSON.stringify(body),
    });
    return assertRows(await responseJson(response))[0] ?? null;
  }

  return {
    async fetchRun(runId: string): Promise<JsonRecord | null> {
      const query = `id=eq.${encodeURIComponent(runId)}&select=*&limit=1`;
      const response = await fetch(`${supabaseUrl}/rest/v1/lotto_training_runs?${query}`, {
        headers: headersFor(serviceKey),
      });
      return assertRows(await responseJson(response))[0] ?? null;
    },

    async claimRun(run: JsonRecord, lease: JsonRecord): Promise<JsonRecord | null> {
      const previousLease = (run.summary as JsonRecord | undefined)?.lease as JsonRecord | undefined;
      const claimedAt = typeof previousLease?.claimed_at === "string"
        ? Date.parse(previousLease.claimed_at)
        : Number.NaN;
      if (
        run.status === "running"
        && Number.isFinite(claimedAt)
        && Date.now() - claimedAt < LEASE_MILLISECONDS
      ) {
        throw new Error("Training run has an active processing lease");
      }
      return patchRun(run, {
        status: "running",
        started_at: run.started_at || new Date().toISOString(),
        error_text: null,
        summary: {
          ...((run.summary as JsonRecord | null) || {}),
          lease,
        },
      });
    },

    async fetchDraws(gameName: string, rangeEnd: number): Promise<JsonRecord[]> {
      const draws: JsonRecord[] = [];
      while (draws.length < rangeEnd) {
        const limit = Math.min(1000, rangeEnd - draws.length);
        const query = [
          `game_name=eq.${encodeURIComponent(gameName)}`,
          "select=draw_id,draw_date,numbers,special_number",
          DRAW_ORDER,
          `limit=${limit}`,
          `offset=${draws.length}`,
        ].join("&");
        const response = await fetch(`${supabaseUrl}/rest/v1/lotto_draws?${query}`, {
          headers: headersFor(serviceKey),
        });
        const page = assertRows(await responseJson(response));
        draws.push(...page);
        if (page.length < limit) break;
      }
      return draws;
    },

    async saveCheckpoint(run: JsonRecord, checkpoint: JsonRecord): Promise<JsonRecord | null> {
      return patchRun(run, checkpoint);
    },

    async markFailed(run: JsonRecord, failure: JsonRecord): Promise<JsonRecord | null> {
      const summary = { ...((run.summary as JsonRecord | null) || {}) };
      delete summary.lease;
      return patchRun(run, { ...failure, summary });
    },
  };
}

export async function handleTrainingRequest(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return fail(405, "Only POST is supported.", "Send POST JSON with run_id and chunk_size.");
  }

  let secretKeys: string[];
  try {
    secretKeys = configuredSecretKeys();
  } catch (error) {
    return fail(500, error instanceof Error ? error.message : String(error), "Fix SUPABASE_SECRET_KEYS JSON.");
  }
  if (!secretKeys.length) {
    return fail(500, "No Supabase service secret is configured.", "Configure SUPABASE_SECRET_KEYS or SUPABASE_SERVICE_ROLE_KEY.");
  }
  if (!isServiceRoleRequest({
    apikey: request.headers.get("apikey") || "",
    authorization: request.headers.get("authorization") || "",
  }, secretKeys)) {
    return fail(401, "The request is not service-role authenticated.", "Use the server-side Supabase service secret.");
  }

  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return fail(400, "Request body is not valid JSON.", "Send JSON with run_id and chunk_size from 1 to 100.");
  }

  try {
    const supabaseUrl = requireEnv("SUPABASE_URL");
    const result = await executeTrainingRun({
      input,
      repository: makeRepository(supabaseUrl, secretKeys[0]),
    });
    return jsonResponse(200, {
      status: String(result.status),
      run_id: String(result.id),
      checkpoint_cursor: Number(result.checkpoint_cursor),
      range_end: Number(result.range_end),
      summary: result.summary as JsonRecord,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = /not found/i.test(message) ? 404
      : /already claimed|active processing lease|lost its concurrency lease/i.test(message) ? 409
      : /run_id|chunk_size|range_|checkpoint_|game_name|chronological|draw/i.test(message) ? 400
      : 500;
    return fail(status, message, "Inspect lotto_training_runs and retry only after correcting the reported condition.");
  }
}

Deno.serve(handleTrainingRequest);
