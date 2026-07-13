import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const indexSource = await readFile(new URL("./index.ts", import.meta.url), "utf8");

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
