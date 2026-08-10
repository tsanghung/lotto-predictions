function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function headersFor(serviceKey, prefer = null) {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json",
    ...(prefer ? { Prefer: prefer } : {}),
  };
}

async function parseResponse(response, operation) {
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`${operation} returned invalid JSON (${response.status})`);
    }
  }
  if (!response.ok) {
    throw new Error(`${operation} failed: ${response.status} ${text.slice(0, 300)}`);
  }
  return body;
}

function requireRows(value, operation) {
  if (!Array.isArray(value)) {
    throw new Error(`${operation} did not return a representation array`);
  }
  return value;
}

export function makeEvidenceRepository({ supabaseUrl, serviceKey, fetchFn = fetch, now = () => new Date() } = {}) {
  const baseUrl = requireNonEmptyString(supabaseUrl, "supabase URL").replace(/\/+$/, "");
  const key = requireNonEmptyString(serviceKey, "Supabase service key");
  if (typeof fetchFn !== "function") throw new TypeError("fetchFn must be a function");

  async function readRows(path, operation) {
    const response = await fetchFn(`${baseUrl}/rest/v1/${path}`, {
      headers: headersFor(key),
    });
    return requireRows(await parseResponse(response, operation), operation);
  }

  async function writeRows(path, method, body, operation) {
    const response = await fetchFn(`${baseUrl}/rest/v1/${path}`, {
      method,
      headers: headersFor(key, "return=representation"),
      body: JSON.stringify(body),
    });
    const rows = requireRows(await parseResponse(response, operation), operation);
    if (!rows.length) throw new Error(`${operation} did not return a representation`);
    return rows;
  }

  return {
    async fetchApprovedContext(gameName) {
      const game = requireNonEmptyString(gameName, "game name");
      const stateRows = await readRows(
        `lotto_agent_states?game_name=eq.${encodeURIComponent(game)}&is_active=eq.true&select=*&limit=2`,
        "LAI v3 active state read",
      );
      if (stateRows.length > 1) throw new Error("LAI v3 active state is ambiguous");
      if (!stateRows.length) return null;
      const registrations = await readRows(
        `lai_model_registry?game_name=eq.${encodeURIComponent(game)}&status=in.(baseline,canary,champion)&select=*`,
        "LAI v3 approved registry read",
      );
      return { state: stateRows[0], registrations };
    },

    fetchShadowRegistrations(gameName) {
      const game = requireNonEmptyString(gameName, "game name");
      return readRows(
        `lai_model_registry?game_name=eq.${encodeURIComponent(game)}&model_family=neq.uniform-null&status=in.(registered,historical_passed,shadow_verified,canary,champion)&select=*`,
        "LAI v3 shadow registry read",
      );
    },

    async createExperiment(row) {
      return (await writeRows("lai_experiment_runs", "POST", [row], "LAI v3 experiment create"))[0];
    },

    async completeExperiment(experiment, evidence = {}) {
      const id = requireNonEmptyString(experiment?.id, "experiment id");
      return (await writeRows(
        `lai_experiment_runs?id=eq.${encodeURIComponent(id)}&status=in.(queued,running)`,
        "PATCH",
        {
          status: "completed",
          metrics: evidence.metrics ?? {},
          replay_digest: evidence.replay_digest ?? null,
          error_text: null,
          completed_at: now().toISOString(),
        },
        "LAI v3 experiment complete",
      ))[0];
    },

    async failExperiment(experiment, error) {
      const id = requireNonEmptyString(experiment?.id, "experiment id");
      return (await writeRows(
        `lai_experiment_runs?id=eq.${encodeURIComponent(id)}&status=in.(queued,running)`,
        "PATCH",
        {
          status: "failed",
          error_text: error instanceof Error ? error.message : String(error),
          completed_at: now().toISOString(),
        },
        "LAI v3 experiment fail",
      ))[0];
    },

    async persistForecastRows(rows) {
      if (!Array.isArray(rows)) throw new TypeError("forecast rows must be an array");
      if (!rows.length) return [];
      return writeRows(
        "lotto_model_forecasts?on_conflict=game_name,target_draw_date,model_name,model_version,forecast_mode",
        "POST",
        rows,
        "LAI v3 forecast persistence",
      );
    },

    async insertEvidenceSnapshot(row) {
      return (await writeRows("lai_evidence_snapshots", "POST", [row], "LAI v3 evidence snapshot insert"))[0];
    },
  };
}
