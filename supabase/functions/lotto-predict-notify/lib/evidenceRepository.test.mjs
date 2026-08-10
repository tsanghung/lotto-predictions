import test from "node:test";
import assert from "node:assert/strict";

import { makeEvidenceRepository } from "./evidenceRepository.js";

const URL = "https://example.supabase.co";
const SERVICE_KEY = "service-role-test-key";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("evidence repository requires a server-only Supabase service key", () => {
  assert.throws(
    () => makeEvidenceRepository({ supabaseUrl: URL, serviceKey: "" }),
    /service key/i,
  );
});

test("repository reads an active state with formal registry members and shadow registrations", async () => {
  const requests = [];
  const repository = makeEvidenceRepository({
    supabaseUrl: URL,
    serviceKey: SERVICE_KEY,
    fetchFn: async (url, options = {}) => {
      requests.push([String(url), options]);
      if (String(url).includes("lotto_agent_states")) {
        return jsonResponse([{ game_name: "今彩539", state_version: 2, status: "baseline" }]);
      }
      if (String(url).includes("lai_model_registry") && String(url).includes("status=in.")) {
        return jsonResponse([
          { id: "uniform", model_name: "uniform-null", status: "baseline" },
          { id: "bayes", model_name: "bayesian-drift", status: "champion" },
        ]);
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  const approved = await repository.fetchApprovedContext("今彩539");
  const shadow = await repository.fetchShadowRegistrations("今彩539");

  assert.equal(approved.state.game_name, "今彩539");
  assert.equal(approved.registrations.length, 2);
  assert.equal(shadow.length, 2);
  assert.equal(requests.every(([, options]) => options.headers.apikey === SERVICE_KEY), true);
  assert.equal(requests.every(([, options]) => options.headers.Authorization === `Bearer ${SERVICE_KEY}`), true);
});

test("repository writes require a representation and fail closed on empty or non-2xx responses", async () => {
  const requests = [];
  const repository = makeEvidenceRepository({
    supabaseUrl: URL,
    serviceKey: SERVICE_KEY,
    fetchFn: async (url, options = {}) => {
      requests.push([String(url), options]);
      if (String(url).includes("lai_experiment_runs") && options.method === "POST") {
        return jsonResponse([{ id: "experiment-1", status: "running" }]);
      }
      if (String(url).includes("lai_experiment_runs") && options.method === "PATCH") {
        return jsonResponse([{ id: "experiment-1", status: "completed" }]);
      }
      if (String(url).includes("lotto_model_forecasts")) {
        return jsonResponse([{ id: "forecast-1" }]);
      }
      if (String(url).includes("lai_evidence_snapshots")) {
        return jsonResponse([]);
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  const experiment = await repository.createExperiment({ registry_id: "registry-1", game_name: "今彩539" });
  await repository.persistForecastRows([{ model_name: "bayesian-drift" }]);
  await repository.completeExperiment(experiment, { metrics: {}, replay_digest: "digest" });
  await assert.rejects(
    () => repository.insertEvidenceSnapshot({ prediction_source_key: "source-key" }),
    /representation/i,
  );

  assert.equal(requests.some(([url, options]) => (
    url.includes("lai_experiment_runs") && options.method === "POST" && options.headers.Prefer.includes("return=representation")
  )), true);
  assert.equal(requests.some(([url, options]) => (
    url.includes("lotto_model_forecasts") && options.headers.Prefer.includes("return=representation")
  )), true);
});
