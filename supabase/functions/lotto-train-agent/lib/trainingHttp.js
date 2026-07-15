import {
  executeTrainingRun,
  isServiceRoleRequest,
} from "./trainingCore.js";

const LEASE_MILLISECONDS = 10 * 60 * 1000;

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function fail(status, rootCause, suggestedFix) {
  return jsonResponse(status, {
    status: "failed",
    root_cause: rootCause,
    suggested_fix: suggestedFix,
  });
}

function requireEnv(getEnv, name) {
  const value = getEnv(name);
  if (!value) throw new Error(`${name} is not configured`);
  return value.replace(/\/+$/, "");
}

export function configuredSecretKeys(getEnv) {
  const values = [];
  const json = getEnv("LOTTO_SERVICE_SECRET_KEYS") || getEnv("SUPABASE_SECRET_KEYS");
  if (json) {
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new TypeError("LOTTO_SERVICE_SECRET_KEYS must be a JSON object");
    }
    values.push(...Object.values(parsed).filter((value) => typeof value === "string" && value));
  }
  const legacy = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) values.push(legacy);
  return [...new Set(values)];
}

function headersFor(serviceKey, prefer) {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json",
    ...(prefer ? { Prefer: prefer } : {}),
  };
}

async function responseJson(response) {
  const text = await response.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`Supabase REST returned invalid JSON (${response.status})`);
    }
  }
  if (!response.ok) {
    throw new Error(`Supabase REST returned ${response.status}: ${text.slice(0, 300)}`);
  }
  return parsed;
}

function assertRows(value) {
  if (!Array.isArray(value)) throw new Error("Supabase REST did not return an array");
  return value;
}

export function makeTrainingRepository({ supabaseUrl, serviceKey, fetchFn = fetch, now = () => new Date() }) {
  async function patchRun(run, body) {
    const query = [
      `id=eq.${encodeURIComponent(String(run.id))}`,
      `updated_at=eq.${encodeURIComponent(String(run.updated_at))}`,
      "select=*",
    ].join("&");
    const response = await fetchFn(`${supabaseUrl}/rest/v1/lotto_training_runs?${query}`, {
      method: "PATCH",
      headers: headersFor(serviceKey, "return=representation"),
      body: JSON.stringify(body),
    });
    return assertRows(await responseJson(response))[0] ?? null;
  }

  return {
    async fetchRun(runId) {
      const query = `id=eq.${encodeURIComponent(runId)}&select=*&limit=1`;
      const response = await fetchFn(`${supabaseUrl}/rest/v1/lotto_training_runs?${query}`, {
        headers: headersFor(serviceKey),
      });
      return assertRows(await responseJson(response))[0] ?? null;
    },

    async claimRun(run, lease) {
      const previousLease = run.summary?.lease;
      const claimedAt = typeof previousLease?.claimed_at === "string"
        ? Date.parse(previousLease.claimed_at)
        : Number.NaN;
      if (
        run.status === "running" &&
        Number.isFinite(claimedAt) &&
        now().getTime() - claimedAt < LEASE_MILLISECONDS
      ) {
        throw new Error("Training run has an active processing lease");
      }
      return patchRun(run, {
        status: "running",
        started_at: run.started_at || now().toISOString(),
        error_text: null,
        summary: { ...(run.summary || {}), lease },
      });
    },

    async ensureSnapshot(run) {
      const response = await fetchFn(`${supabaseUrl}/rest/v1/rpc/initialize_lotto_training_snapshot`, {
        method: "POST",
        headers: headersFor(serviceKey),
        body: JSON.stringify({ p_run_id: run.id }),
      });
      const value = await responseJson(response);
      if (!Number.isInteger(value)) throw new Error("Training snapshot RPC returned an invalid count");
      return value;
    },

    async fetchDraws(runId, rangeEnd) {
      const draws = [];
      while (draws.length < rangeEnd) {
        const limit = Math.min(1000, rangeEnd - draws.length);
        const query = [
          `run_id=eq.${encodeURIComponent(runId)}`,
          "select=draw_id,draw_date,numbers,special_number",
          "order=sequence_no.asc",
          `limit=${limit}`,
          `offset=${draws.length}`,
        ].join("&");
        const response = await fetchFn(`${supabaseUrl}/rest/v1/lotto_training_draw_snapshots?${query}`, {
          headers: headersFor(serviceKey),
        });
        const page = assertRows(await responseJson(response));
        draws.push(...page);
        if (page.length < limit) break;
      }
      return draws;
    },

    saveCheckpoint(run, checkpoint) {
      return patchRun(run, checkpoint);
    },

    markFailed(run, failure) {
      const summary = { ...(run.summary || {}) };
      delete summary.lease;
      return patchRun(run, { ...failure, summary });
    },
  };
}

function errorStatus(message) {
  if (/not found/i.test(message)) return 404;
  if (/already claimed|active processing lease|lost its concurrency lease/i.test(message)) return 409;
  if (/run_id|chunk_size|range_|checkpoint_|game_name|chronological|draw/i.test(message)) return 400;
  return 500;
}

export function createTrainingHandler({
  getEnv,
  fetchFn = fetch,
  executeRun = executeTrainingRun,
  now = () => new Date(),
}) {
  return async function handleTrainingRequest(request) {
    if (request.method !== "POST") {
      return fail(405, "Only POST is supported.", "Send POST JSON with run_id and chunk_size.");
    }

    let secretKeys;
    try {
      secretKeys = configuredSecretKeys(getEnv);
    } catch (error) {
      return fail(500, error instanceof Error ? error.message : String(error), "Fix LOTTO_SERVICE_SECRET_KEYS JSON.");
    }
    if (!secretKeys.length) {
      return fail(500, "No Supabase service secret is configured.", "Configure LOTTO_SERVICE_SECRET_KEYS or SUPABASE_SERVICE_ROLE_KEY.");
    }
    if (!isServiceRoleRequest({
      apikey: request.headers.get("apikey") || "",
      authorization: request.headers.get("authorization") || "",
    }, secretKeys)) {
      return fail(401, "The request is not service-role authenticated.", "Use the server-side Supabase service secret.");
    }

    let input;
    try {
      input = await request.json();
    } catch {
      return fail(400, "Request body is not valid JSON.", "Send JSON with run_id and chunk_size from 1 to 100.");
    }

    try {
      const supabaseUrl = requireEnv(getEnv, "SUPABASE_URL");
      const result = await executeRun({
        input,
        repository: makeTrainingRepository({
          supabaseUrl,
          serviceKey: secretKeys[0],
          fetchFn,
          now,
        }),
      });
      return jsonResponse(200, {
        status: String(result.status),
        run_id: String(result.id),
        checkpoint_cursor: Number(result.checkpoint_cursor),
        range_end: Number(result.range_end),
        summary: result.summary,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return fail(
        errorStatus(message),
        message,
        "Inspect lotto_training_runs and retry only after correcting the reported condition.",
      );
    }
  };
}
