import test from "node:test";
import assert from "node:assert/strict";

import {
  accumulateEvidencePair,
  canonicalJson,
  createInitialEvidenceState,
  digestReplay,
  finalizeEvidenceRun,
  walkForwardEvidenceChunk,
} from "./evidenceTraining.js";
import { evaluateCandidateSeries } from "../../_shared/lai-v3/evaluation.js";
import { GAME_CONFIG } from "../../lotto-predict-notify/lib/gameConfig.js";

const draws = Array.from({ length: 140 }, (_, index) => ({
  draw_id: String(index + 1),
  draw_date: new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10),
  numbers: Array.from({ length: 5 }, (__, offset) => ((index * 5 + offset) % 39) + 1)
    .sort((left, right) => left - right),
}));

const registration = {
  id: "registry-539-bayes",
  game_name: GAME_CONFIG["539"].name,
  model_name: "bayesian-drift",
  model_family: "bayesian-drift",
  model_version: "bayesian-drift-v1",
  feature_version: "weighted-counts-v1",
  parameters: { halfLifeDraws: 100, priorStrength: 100, random_seed: "training-proof" },
  code_commit: "0123456789abcdef0123456789abcdef01234567",
  status: "registered",
};

const baselineRegistration = {
  id: "registry-539-uniform",
  game_name: GAME_CONFIG["539"].name,
  model_name: "uniform-null",
  model_family: "uniform-null",
  model_version: "uniform-null-v1",
  feature_version: "none-v1",
  parameters: { random_seed: "uniform-null-v1" },
  code_commit: "0123456789abcdef0123456789abcdef01234567",
  status: "baseline",
};

const input = { gameType: "539", draws, registration, baselineRegistration };

test("two v3 chunks equal one combined chunk", async () => {
  const initial = createInitialEvidenceState(registration, baselineRegistration);
  const first = walkForwardEvidenceChunk({ ...input, rangeStart: 100, cursor: 100, chunkSize: 10, state: initial });
  const second = walkForwardEvidenceChunk({ ...input, rangeStart: 100, cursor: 110, chunkSize: 10, state: first.state });
  const combined = walkForwardEvidenceChunk({ ...input, rangeStart: 100, cursor: 100, chunkSize: 20, state: initial });
  assert.deepEqual(second.state, combined.state);
  assert.equal(await digestReplay(second.state), await digestReplay(combined.state));
});

test("each target only sees the preceding prefix", () => {
  const result = walkForwardEvidenceChunk({ ...input, rangeStart: 3, cursor: 3, chunkSize: 1 });
  assert.equal(result.steps[0].historySize, 3);
  assert.equal(result.steps[0].targetDrawId, draws[3].draw_id);
  assert.equal(result.steps[0].dataCutoff, draws[2].draw_date);
});

test("v3 chunks never process more than 25 targets", () => {
  assert.throws(
    () => walkForwardEvidenceChunk({ ...input, cursor: 100, chunkSize: 26 }),
    /chunkSize must be an integer from 1 through 25/,
  );
});

test("canonical replay JSON sorts object keys without changing array order", async () => {
  const left = { z: [2, 1], a: { y: true, b: null } };
  const right = { a: { b: null, y: true }, z: [2, 1] };
  assert.equal(canonicalJson(left), '{"a":{"b":null,"y":true},"z":[2,1]}');
  assert.equal(await digestReplay(left), await digestReplay(right));
});

test("compact evidence keeps bounded detail and evaluator samples from the full population", async () => {
  const extendedDraws = Array.from({ length: 510 }, (_, index) => ({
    draw_id: String(index + 1),
    draw_date: new Date(Date.UTC(2024, 0, index + 1)).toISOString().slice(0, 10),
    numbers: Array.from({ length: 5 }, (__, offset) => ((index * 5 + offset) % 39) + 1)
      .sort((left, right) => left - right),
  }));
  const result = walkForwardEvidenceChunk({
    ...input,
    draws: extendedDraws,
    rangeStart: 0,
    cursor: 0,
    chunkSize: 25,
  });
  let state = result.state;
  for (let cursor = result.nextCursor; cursor < extendedDraws.length; cursor += 25) {
    state = walkForwardEvidenceChunk({
      ...input,
      draws: extendedDraws,
      rangeStart: 0,
      cursor,
      chunkSize: 25,
      state,
    }).state;
  }
  assert.equal(state.processedDraws, 510);
  assert.equal(state.recentRows.length, 500);
  assert.equal(state.recentRows[0].drawId, "11");
  assert.equal(state.runningSums.sampleCount, 510);
  assert.equal(state.evaluationReservoir.length, 500);
  assert.equal(Object.hasOwn(state, "evaluationRows"), false);
  const evidence = await finalizeEvidenceRun({
    draws: extendedDraws,
    registration,
    baselineRegistration,
    state,
    resampling: { bootstrapIterations: 20, permutationIterations: 20 },
  });
  assert.equal(evidence.metrics.sampleCount, 500);
  assert.equal(evidence.metrics.combined.sampleCount, 500);
  assert.equal(evidence.metrics.main.sampleCount, 500);
  assert.deepEqual(evidence.metrics.statisticalPopulation, {
    method: "deterministic-bottom-k-reservoir-v1",
    populationSampleCount: 510,
    evaluatorSampleCount: 500,
    capacity: 500,
    exact: false,
    sampleDigest: evidence.metrics.statisticalPopulation.sampleDigest,
  });
  assert.match(evidence.metrics.statisticalPopulation.sampleDigest, /^[0-9a-f]{64}$/);
  assert.equal(evidence.metrics.detailWindow.sampleCount, 500);
  const sampledRows = state.evaluationReservoir
    .map((entry) => entry.row)
    .sort((left, right) => left.drawDate.localeCompare(right.drawDate)
      || left.drawId.localeCompare(right.drawId, undefined, { numeric: true }));
  const expected = evaluateCandidateSeries({
    candidateRows: sampledRows.map((row) => row.candidate),
    baselineRows: sampledRows.map((row) => row.baseline),
    seed: state.randomSeed,
    resampling: { bootstrapIterations: 20, permutationIterations: 20 },
  });
  assert.deepEqual(
    Object.fromEntries(Object.keys(expected).map((key) => [key, evidence.metrics.fullRun[key]])),
    expected,
  );
  assert.equal(evidence.metrics.statisticalPopulation.sampleDigest, await digestReplay(sampledRows));
  assert.ok(Number.isFinite(evidence.metrics.brierSkill));
  assert.ok(Number.isFinite(evidence.metrics.logLossDelta));
  assert.ok(Number.isFinite(evidence.metrics.permutationP));
});

test("high-sample evidence state payload remains bounded", () => {
  let state = createInitialEvidenceState(registration, baselineRegistration);
  let sizeAtOneThousand = null;
  for (let index = 0; index < 20_000; index += 1) {
    const drawId = `high-${String(index).padStart(5, "0")}`;
    const score = (registryId, family, brier) => ({
      drawId,
      drawDate: `sample-${String(index).padStart(5, "0")}`,
      registryId,
      family,
      main: { brier, logLoss: brier + 0.1, calibrationObservations: null, coverageDelta: null },
      special: null,
      combined: { brier, logLoss: brier + 0.1, calibrationObservations: null, coverageDelta: null },
    });
    state = accumulateEvidencePair(state, {
      candidate: score(registration.id, registration.model_family, 0.1),
      baseline: score(baselineRegistration.id, "uniform-null", 0.2),
    });
    if (index === 999) sizeAtOneThousand = Buffer.byteLength(JSON.stringify(state));
  }

  const finalSize = Buffer.byteLength(JSON.stringify(state));
  assert.equal(state.processedDraws, 20_000);
  assert.equal(state.recentRows.length, 500);
  assert.equal(state.evaluationReservoir.length, 500);
  assert.equal(Object.hasOwn(state, "evaluationRows"), false);
  assert.ok(finalSize <= sizeAtOneThousand + 100_000, `${finalSize} exceeded bounded payload growth`);
  assert.ok(finalSize < 1_000_000, `${finalSize} exceeded the compact-state payload budget`);
});

test("final evidence is derived from the frozen snapshot and compact state", async () => {
  const result = walkForwardEvidenceChunk({ ...input, rangeStart: 100, cursor: 100, chunkSize: 10 });
  const evidence = await finalizeEvidenceRun({
    draws: draws.slice(0, 110),
    registration,
    baselineRegistration,
    state: result.state,
  });
  assert.equal(evidence.metrics.sampleCount, 10);
  assert.equal(evidence.metrics.recent.sampleCount, 10);
  assert.match(evidence.replayDigest, /^[0-9a-f]{64}$/);
});

test("v3 state rejects cursor gaps and advanced cursors without checkpoint state", () => {
  const first = walkForwardEvidenceChunk({
    ...input,
    rangeStart: 100,
    cursor: 100,
    chunkSize: 2,
  });
  assert.throws(
    () => walkForwardEvidenceChunk({
      ...input,
      rangeStart: 100,
      cursor: 103,
      chunkSize: 1,
      state: first.state,
    }),
    /state.*cursor|cursor.*state/i,
  );
  assert.throws(
    () => walkForwardEvidenceChunk({
      ...input,
      rangeStart: 100,
      cursor: 101,
      chunkSize: 1,
    }),
    /checkpoint state/i,
  );
});

test("v3 state rejects a duplicate resume target and non-finite aggregates", () => {
  const first = walkForwardEvidenceChunk({
    ...input,
    rangeStart: 100,
    cursor: 100,
    chunkSize: 2,
  });
  const duplicate = structuredClone(first.state);
  duplicate.nextCursor = 101;
  duplicate.processedDraws = 1;
  assert.throws(
    () => walkForwardEvidenceChunk({
      ...input,
      rangeStart: 100,
      cursor: 101,
      chunkSize: 1,
      state: duplicate,
    }),
    /last target|continuity|continuous|reservoir/i,
  );

  const poisoned = structuredClone(first.state);
  poisoned.runningSums.candidate.mainBrier = Number.POSITIVE_INFINITY;
  assert.throws(
    () => walkForwardEvidenceChunk({
      ...input,
      rangeStart: 100,
      cursor: 102,
      chunkSize: 1,
      state: poisoned,
    }),
    /finite/i,
  );
});
