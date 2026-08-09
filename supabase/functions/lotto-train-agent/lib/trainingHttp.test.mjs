import test from "node:test";
import assert from "node:assert/strict";

import {
  createTrainingHandler,
  makeTrainingRepository,
} from "./trainingHttp.js";

const SECRET = "server-side-secret";
const ENV = {
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: SECRET,
};

function request(body, headers = {}, method = "POST") {
  return new Request("https://example.test/lotto-train-agent", {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: method === "POST" ? body : undefined,
  });
}

async function json(response) {
  return JSON.parse(await response.text());
}

test("handler rejects public requests before executing training", async () => {
  let executed = false;
  const handler = createTrainingHandler({
    getEnv: (name) => ENV[name],
    executeRun: async () => { executed = true; },
  });
  const response = await handler(request('{"run_id":"x","chunk_size":1}'));
  assert.equal(response.status, 401);
  assert.equal(executed, false);
});

test("handler rejects malformed JSON and unsupported methods", async () => {
  const handler = createTrainingHandler({ getEnv: (name) => ENV[name] });
  const headers = { apikey: SECRET, authorization: `Bearer ${SECRET}` };
  assert.equal((await handler(request("{", headers))).status, 400);
  assert.equal((await handler(request(null, headers, "GET"))).status, 405);
});

test("handler injects an authenticated repository and returns checkpoint status", async () => {
  let captured;
  const handler = createTrainingHandler({
    getEnv: (name) => ENV[name],
    fetchFn: async () => assert.fail("repository must stay lazy in this test"),
    executeRun: async (value) => {
      captured = value;
      return { id: "run-1", status: "running", checkpoint_cursor: 25, range_end: 100, summary: {} };
    },
  });
  const response = await handler(request('{"run_id":"run-1","chunk_size":25}', {
    apikey: SECRET,
    authorization: `Bearer ${SECRET}`,
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(captured.input, { run_id: "run-1", chunk_size: 25 });
  assert.equal(typeof captured.repository.fetchRun, "function");
  assert.equal((await json(response)).checkpoint_cursor, 25);
});

test("repository rejects an active lease without issuing a PATCH", async () => {
  let fetched = false;
  const repository = makeTrainingRepository({
    supabaseUrl: ENV.SUPABASE_URL,
    serviceKey: SECRET,
    fetchFn: async () => { fetched = true; return new Response("[]"); },
    now: () => new Date("2026-07-15T10:05:00Z"),
  });
  await assert.rejects(repository.claimRun({
    id: "run-1",
    status: "running",
    summary: { lease: { claimed_at: "2026-07-15T10:00:00Z" } },
  }, { token: "new", claimed_at: "2026-07-15T10:05:00Z" }), /active processing lease/);
  assert.equal(fetched, false);
});

test("repository CAS returns null when another invocation wins the claim", async () => {
  let url;
  const repository = makeTrainingRepository({
    supabaseUrl: ENV.SUPABASE_URL,
    serviceKey: SECRET,
    fetchFn: async (value) => { url = String(value); return new Response("[]", { status: 200 }); },
    now: () => new Date("2026-07-15T11:00:00Z"),
  });
  const result = await repository.claimRun({
    id: "run-1", status: "queued", summary: {}, updated_at: "2026-07-15T09:00:00Z",
  }, { token: "claim", claimed_at: "2026-07-15T11:00:00Z" });
  assert.equal(result, null);
  assert.match(url, /updated_at=eq\.2026-07-15T09%3A00%3A00Z/);
});

test("repository persists versioned v3 failure evidence before follower reconciliation", async () => {
  let request;
  const repository = makeTrainingRepository({
    supabaseUrl: ENV.SUPABASE_URL,
    serviceKey: SECRET,
    fetchFn: async (value, options = {}) => {
      request = { url: String(value), body: JSON.parse(options.body) };
      return new Response(JSON.stringify([{ id: "run-1", ...request.body }]));
    },
  });
  const terminal = {
    version: "lai-v3-failure-v1",
    experimentId: "experiment-1",
    experimentUpdatedAt: "2026-08-09T00:00:00Z",
    followerRequired: true,
    failure: {
      status: "failed",
      error_text: "processor failed",
      completed_at: "2026-08-09T00:01:00Z",
    },
  };

  await repository.markFailed({
    id: "run-1",
    status: "running",
    updated_at: "2026-08-09T00:00:00Z",
    summary: { lease: { token: "claim-1" } },
  }, {
    ...terminal.failure,
    summary: { lease: { token: "claim-1" }, v3_failure_terminal: terminal },
  });

  assert.deepEqual(request.body.summary, { v3_failure_terminal: terminal });
  assert.match(request.url, /updated_at=eq\.2026-08-09T00%3A00%3A00Z/);
});

test("repository initializes and reads the immutable draw snapshot in pages", async () => {
  const urls = [];
  const draw = (index) => ({
    draw_id: String(index), draw_date: "2026-01-01", numbers: [1, 2, 3, 4, 5], special_number: null,
  });
  const fetchFn = async (value) => {
    const url = String(value);
    urls.push(url);
    if (url.includes("/rpc/initialize_lotto_training_snapshot")) {
      return new Response("1001", { status: 200 });
    }
    if (url.includes("offset=0")) {
      return new Response(JSON.stringify(Array.from({ length: 1000 }, (_, index) => draw(index))), { status: 200 });
    }
    if (url.includes("offset=1000")) {
      return new Response(JSON.stringify([draw(1000)]), { status: 200 });
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  const repository = makeTrainingRepository({
    supabaseUrl: ENV.SUPABASE_URL, serviceKey: SECRET, fetchFn,
  });
  assert.equal(await repository.ensureSnapshot({ id: "run-1" }), 1001);
  assert.equal((await repository.fetchDraws("run-1", 1001)).length, 1001);
  assert.ok(urls.every((url) => !url.includes("/lotto_draws?")));
  assert.ok(urls.some((url) => url.includes("order=sequence_no.asc")));
});

test("handler maps lease conflicts to 409 and does not claim completion", async () => {
  const handler = createTrainingHandler({
    getEnv: (name) => ENV[name],
    executeRun: async () => { throw new Error("Training run has an active processing lease"); },
  });
  const response = await handler(request('{"run_id":"run-1","chunk_size":1}', {
    apikey: SECRET,
  }));
  assert.equal(response.status, 409);
  assert.match((await json(response)).root_cause, /active processing lease/);
});

test("repository reads and checkpoints a v3 experiment with exactly one uniform baseline", async () => {
  const urls = [];
  const experiment = {
    id: "experiment-1", registry_id: "registry-1", game_name: "\u4eca\u5f69539",
    status: "running", checkpoint_cursor: 25, updated_at: "2026-08-09T00:00:00Z",
  };
  const registration = { id: "registry-1", model_family: "bayesian-drift" };
  const baseline = { id: "uniform-1", model_family: "uniform-null", status: "baseline" };
  const fetchFn = async (value, options = {}) => {
    const url = String(value);
    urls.push({ url, method: options.method || "GET", body: options.body || null });
    if (url.includes("lai_experiment_runs?id=eq.experiment-1")) {
      if (options.method === "PATCH") return new Response(JSON.stringify([{ ...experiment, ...JSON.parse(options.body) }]));
      return new Response(JSON.stringify([experiment]));
    }
    if (url.includes("lai_model_registry?id=eq.registry-1")) {
      return new Response(JSON.stringify([registration]));
    }
    if (url.includes("model_family=eq.uniform-null")) {
      return new Response(JSON.stringify([baseline]));
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  const repository = makeTrainingRepository({
    supabaseUrl: ENV.SUPABASE_URL,
    serviceKey: SECRET,
    fetchFn,
    now: () => new Date("2026-08-09T01:00:00Z"),
  });

  assert.deepEqual(await repository.fetchExperiment("experiment-1"), experiment);
  assert.deepEqual(await repository.fetchRegistration("registry-1"), registration);
  assert.deepEqual(await repository.fetchUniformBaseline("\u4eca\u5f69539"), baseline);
  const checkpoint = await repository.saveExperimentCheckpoint(experiment, {
    checkpoint_cursor: 50,
    status: "running",
  });
  await repository.completeExperiment(checkpoint, {
    metrics: { sampleCount: 50 }, replayDigest: "a".repeat(64),
  });
  await repository.failExperiment(experiment, { status: "failed", error_text: "failed" });

  assert.ok(urls.some(({ url }) => url.includes("lai_experiment_runs?id=eq.experiment-1")));
  assert.ok(urls.some(({ url }) => url.includes("lai_model_registry?id=eq.registry-1")));
  assert.ok(urls.some(({ url }) => url.includes("model_family=eq.uniform-null") && url.includes("limit=2")));
  assert.equal(urls.filter(({ method }) => method === "PATCH").length, 3);
  assert.ok(urls.every(({ url }) => !url.includes("/lotto_draws?")));
});

test("repository rejects a missing or ambiguous uniform baseline", async () => {
  const repository = makeTrainingRepository({
    supabaseUrl: ENV.SUPABASE_URL,
    serviceKey: SECRET,
    fetchFn: async () => new Response(JSON.stringify([])),
  });
  await assert.rejects(repository.fetchUniformBaseline("\u4eca\u5f69539"), /exactly one uniform-null baseline/);
});

test("stale experiment failure stays bound to the worker version and never re-reads a winner", async () => {
  const requests = [];
  const original = {
    id: "experiment-1",
    status: "running",
    updated_at: "2026-08-09T00:00:00Z",
  };
  const repository = makeTrainingRepository({
    supabaseUrl: ENV.SUPABASE_URL,
    serviceKey: SECRET,
    fetchFn: async (value, options = {}) => {
      requests.push({ url: String(value), method: options.method || "GET", body: options.body });
      if (!options.method) {
        return new Response(JSON.stringify([{
          ...original,
          status: "completed",
          updated_at: "2026-08-09T00:01:00Z",
          replay_digest: "a".repeat(64),
        }]));
      }
      return new Response("[]", { status: 200 });
    },
  });

  assert.equal(await repository.failExperiment(original, {
    status: "failed",
    error_text: "stale worker",
  }), null);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "PATCH");
  assert.match(requests[0].url, /updated_at=eq\.2026-08-09T00%3A00%3A00Z/);
  assert.match(requests[0].url, /status=in\.\(queued%2Crunning\)/);
});
