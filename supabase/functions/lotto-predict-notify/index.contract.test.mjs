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

test("production path invokes executePredictionFlow with engine and both LAI flags", () => {
  assert.match(
    indexSource,
    /import\s*\{[^}]*executePredictionFlow[^}]*parseBooleanEnvFlag[^}]*\}\s*from\s*["']\.\/lib\/notifyRuntime\.js["']/s,
  );

  const processGameSource = sourceBetween("async function processGame", "async function handleRequest");
  assert.match(processGameSource, /executePredictionFlow\s*\(/);
  assert.match(processGameSource, /requestedEngine:\s*options\.requestedEngine/);
  assert.match(processGameSource, /laiEnabled:\s*options\.laiEnabled/);
  assert.match(processGameSource, /shadowEnabled:\s*options\.shadowEnabled/);

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
  assert.match(handleRequestSource, /requestedEngine,\s*laiEnabled,\s*shadowEnabled,/s);
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
