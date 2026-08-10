import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const indexSource = await readFile(new URL("./index.ts", import.meta.url), "utf8");
const runtimeSource = await readFile(new URL("./lib/notifyRuntime.js", import.meta.url), "utf8");
const notifyRuntime = await import("./lib/notifyRuntime.js");

function sourceBetween(startMarker, endMarker) {
  const start = indexSource.indexOf(startMarker);
  const end = indexSource.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `Missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `Missing source marker: ${endMarker}`);
  return indexSource.slice(start, end);
}

function runtimeBetween(startMarker, endMarker) {
  const start = runtimeSource.indexOf(startMarker);
  const end = runtimeSource.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `Missing runtime marker: ${startMarker}`);
  assert.notEqual(end, -1, `Missing runtime marker: ${endMarker}`);
  return runtimeSource.slice(start, end);
}

test("production path binds LAI v3 only to the isolated shadow lane", () => {
  assert.match(
    indexSource,
    /import\s*\{[^}]*executePredictionFlow[^}]*parseBooleanEnvFlag[^}]*resolveAgentExecution[^}]*\}\s*from\s*["']\.\/lib\/notifyRuntime\.js["']/s,
  );
  assert.match(indexSource, /import\s*\{[^}]*generateEvidencePrediction[^}]*generateEvidenceShadow[^}]*\}\s*from\s*["']\.\/lib\/evidencePrediction\.js["']/s);
  assert.match(indexSource, /makeEvidenceRepository/);

  const processGameSource = sourceBetween("async function processGame", "async function handleRequest");
  assert.match(processGameSource, /executePredictionFlow\s*\(/);
  assert.match(processGameSource, /requestedEngine:\s*options\.requestedEngine/);
  assert.match(processGameSource, /laiEnabled:\s*options\.laiEnabled/);
  assert.match(processGameSource, /shadowEnabled:\s*options\.shadowEnabled/);
  assert.match(processGameSource, /v3ShadowEnabled:\s*options\.v3ShadowEnabled/);
  assert.match(processGameSource, /v3ProductionEnabled:\s*options\.v3ProductionEnabled/);
  assert.match(processGameSource, /codeCommit:\s*options\.codeCommit/);
  assert.match(processGameSource, /v3DataStatus:\s*v3EvidenceDataStatus/);
  assert.match(processGameSource, /persistV3ForecastRows/);
  assert.match(processGameSource, /fetchApprovedV3Context/);
  assert.match(processGameSource, /fetchShadowRegistrations/);

  const handleRequestSource = indexSource.slice(indexSource.indexOf("async function handleRequest"));
  assert.match(handleRequestSource, /const requestedEngine = url\.searchParams\.get\(["']engine["']\)/);
  assert.match(
    handleRequestSource,
    /const laiEnabled = parseBooleanEnvFlag\(Deno\.env\.get\(["']LAI_V2_ENABLED["']\)\)/,
  );
  assert.match(
    handleRequestSource,
    /const shadowEnabled = parseBooleanEnvFlag\(Deno\.env\.get\(["']LAI_V2_SHADOW_ENABLED["']\)\)/,
  );
  assert.match(handleRequestSource, /const v3ShadowEnabled = parseBooleanEnvFlag\(Deno\.env\.get\(["']LAI_V3_SHADOW_ENABLED["']\)\)/);
  assert.match(handleRequestSource, /const v3ProductionEnabled = parseBooleanEnvFlag\(Deno\.env\.get\(["']LAI_V3_PRODUCTION_ENABLED["']\)\)/);
  assert.match(handleRequestSource, /const codeCommit = Deno\.env\.get\(["']LOTTO_CODE_COMMIT["']\) \?\? ["']["']/);
  assert.match(handleRequestSource, /resolveAgentExecution\s*\(/);
  assert.match(handleRequestSource, /engine=lai-v3 only with dry_run=1/);

  const v3LaneSource = runtimeBetween("async function runV3ShadowLane", "export async function executePredictionFlow");
  assert.match(v3LaneSource, /await deps\.persistV3ForecastRows\(forecastRows\)/);
  assert.doesNotMatch(v3LaneSource, /sendLineMessage|reserveNotification|upsertPrediction|insertEvidenceSnapshot/);
  assert.match(runtimeSource, /engine=lai-v3 requires dry_run=1/);
  assert.match(runtimeSource, /LAI_V3_PRODUCTION_ENABLED is shadow-only/);
});

test("the first LINE push carries a deterministic hexadecimal UUID retry key", async () => {
  const sendLineSource = sourceBetween("async function sendLineMessage", "async function processGame");
  assert.match(sendLineSource, /async function sendLineMessage\(message: string, retryKey: string\)/);
  assert.match(sendLineSource, /["']X-Line-Retry-Key["']:\s*retryKey/);
  assert.match(runtimeSource, /await deps\.sendLineMessage\(message, retryKey\)/);

  assert.equal(typeof notifyRuntime.buildLineRetryKey, "function");
  const first = await notifyRuntime.buildLineRetryKey("daily-539:2026-07-10:prediction");
  const retry = await notifyRuntime.buildLineRetryKey("daily-539:2026-07-10:prediction");
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(first, retry);
});

test("LINE accepted retry conflicts are sent while other 409 responses fail", () => {
  const sendLineSource = sourceBetween("async function sendLineMessage", "async function processGame");
  assert.match(sendLineSource, /x-line-accepted-request-id/);
  assert.match(sendLineSource, /response\.status\s*===\s*409/);
  assert.match(runtimeSource, /markNotificationSent\(\s*key,\s*["']sent["']/);
  assert.match(runtimeSource, /markNotificationSent\(\s*key,\s*["']failed["']/);
});
