import test from "node:test";
import assert from "node:assert/strict";

import {
  buildProductionWeights,
  evaluatePromotionGate,
  selectFamilyRepresentatives,
} from "./promotionGate.js";

const healthy = Object.freeze({ dataValid: true, replayDigestValid: true, modelValid: true });

function passingEvidence(overrides = {}) {
  return {
    sampleCount: 600,
    recent30Skill: 0.01,
    recent100Skill: 0.01,
    recent500Skill: 0.01,
    meanExcessLoss: -0.001,
    brierCi: { lower95: 0.001, upper95: 0.02 },
    logLossDelta: -0.001,
    calibrationDelta: -0.001,
    calibrationCi: { lower95: -0.003, upper95: 0 },
    coverageCi: { lower95: 0, upper95: 0.04 },
    adjustedQ: 0.01,
    ...overrides,
  };
}

function gateInput(stage, overrides = {}) {
  return {
    stage,
    evidence: passingEvidence(),
    evidenceDigest: `digest-${stage}`,
    previousEvidenceDigest: null,
    liveShadowDraws: 30,
    canaryDraws: 20,
    health: healthy,
    ...overrides,
  };
}

test("one lucky draw stays registered", () => {
  const result = evaluatePromotionGate(gateInput("registered", {
    evidence: passingEvidence({ sampleCount: 1, recent500Skill: null }),
    liveShadowDraws: 1,
    canaryDraws: 0,
  }));

  assert.deepEqual(result, {
    decision: "hold",
    fromStatus: "registered",
    toStatus: "registered",
    reason: "historical_window_incomplete",
    gateVersion: "lai-v3-promotion-gate-v1",
    evidenceDigest: "digest-registered",
    authorizedWeight: 0,
  });
});

test("lifecycle promotes exactly one stage at each valid boundary", () => {
  const cases = [
    ["registered", "historical_passed", 0],
    ["historical_passed", "shadow_verified", 0],
    ["shadow_verified", "canary", 0.10],
    ["canary", "champion", 0.75],
  ];

  for (const [stage, expected, weight] of cases) {
    const result = evaluatePromotionGate(gateInput(stage));
    assert.equal(result.decision, "promote", stage);
    assert.equal(result.fromStatus, stage, stage);
    assert.equal(result.toStatus, expected, stage);
    assert.equal(result.authorizedWeight, weight, stage);
  }
});

test("live sample thresholds cannot be skipped or inflated by invalid counts", () => {
  const shadow = evaluatePromotionGate(gateInput("historical_passed", { liveShadowDraws: 29 }));
  const canary = evaluatePromotionGate(gateInput("canary", { canaryDraws: 19 }));
  assert.equal(shadow.decision, "hold");
  assert.equal(shadow.toStatus, "historical_passed");
  assert.equal(shadow.reason, "live_shadow_window_incomplete");
  assert.equal(canary.decision, "hold");
  assert.equal(canary.toStatus, "canary");
  assert.equal(canary.reason, "canary_window_incomplete");

  for (const invalid of [-1, 1.5, Number.NaN, Infinity]) {
    assert.throws(
      () => evaluatePromotionGate(gateInput("historical_passed", { liveShadowDraws: invalid })),
      /liveShadowDraws/i,
    );
    assert.throws(
      () => evaluatePromotionGate(gateInput("canary", { canaryDraws: invalid })),
      /canaryDraws/i,
    );
  }
});

test("later stages revalidate the complete live shadow window before gaining weight", () => {
  for (const stage of ["shadow_verified", "canary", "champion"]) {
    const result = evaluatePromotionGate(gateInput(stage, {
      liveShadowDraws: 29,
      canaryDraws: 20,
    }));
    assert.equal(result.decision, "hold", stage);
    assert.equal(result.toStatus, stage, stage);
    assert.equal(result.reason, "live_shadow_window_incomplete", stage);
    assert.equal(result.authorizedWeight, 0, stage);
  }

  assert.throws(() => evaluatePromotionGate({
    ...gateInput("canary"),
    liveShadowDraws: undefined,
  }), /liveShadowDraws/i);
  assert.throws(() => evaluatePromotionGate({
    ...gateInput("champion"),
    liveShadowDraws: null,
  }), /liveShadowDraws/i);
});

test("health failure disables before promotion while permanent baseline is held", () => {
  for (const key of Object.keys(healthy)) {
    const result = evaluatePromotionGate(gateInput("canary", {
      health: { ...healthy, [key]: false },
    }));
    assert.equal(result.decision, "disable", key);
    assert.equal(result.toStatus, "disabled", key);
    assert.equal(result.reason, "health_check_failed", key);
    assert.equal(result.authorizedWeight, 0, key);
  }

  const baseline = evaluatePromotionGate(gateInput("baseline"));
  assert.equal(baseline.decision, "hold");
  assert.equal(baseline.toStatus, "baseline");
  assert.equal(baseline.reason, "uniform_null_permanent");
});

test("negative recent-30 skill and significant calibration regression demote active stages", () => {
  const rolling = evaluatePromotionGate(gateInput("champion", {
    evidence: passingEvidence({ recent30Skill: -Number.EPSILON }),
  }));
  assert.equal(rolling.decision, "demote");
  assert.equal(rolling.toStatus, "cooldown");
  assert.equal(rolling.reason, "rolling_30_skill_negative");

  const calibration = evaluatePromotionGate(gateInput("canary", {
    evidence: passingEvidence({
      calibrationDelta: 0.01,
      calibrationCi: { lower95: 0.001, upper95: 0.02 },
      adjustedQ: 0.05,
    }),
  }));
  assert.equal(calibration.decision, "demote");
  assert.equal(calibration.toStatus, "cooldown");
  assert.equal(calibration.reason, "calibration_significantly_worse");
});

test("registered regressions cannot bypass health gates or emit an invalid cooldown transition", () => {
  const rolling = evaluatePromotionGate(gateInput("registered", {
    evidence: passingEvidence({ recent30Skill: -0.001 }),
  }));
  assert.equal(rolling.decision, "hold");
  assert.equal(rolling.toStatus, "registered");
  assert.equal(rolling.reason, "rolling_30_skill_negative");

  const calibration = evaluatePromotionGate(gateInput("registered", {
    evidence: passingEvidence({
      calibrationDelta: 0.01,
      calibrationCi: { lower95: 0.001, upper95: 0.02 },
    }),
  }));
  assert.equal(calibration.decision, "hold");
  assert.equal(calibration.toStatus, "registered");
  assert.equal(calibration.reason, "calibration_significantly_worse");
});

test("every evidence gate is fail-closed with the correct metric direction", () => {
  const failures = [
    [{ sampleCount: 499 }, "historical_window_incomplete"],
    [{ recent100Skill: 0 }, "recent_100_skill_not_positive"],
    [{ recent500Skill: 0 }, "recent_500_skill_not_positive"],
    [{ brierCi: { lower95: 0, upper95: 0.02 } }, "brier_ci_not_positive"],
    [{ logLossDelta: Number.EPSILON }, "log_loss_regressed"],
    [{ coverageCi: { lower95: -Number.EPSILON, upper95: 0.04 } }, "coverage_regressed"],
    [{ adjustedQ: 0.0500000001 }, "fdr_not_significant"],
    [{ recent100Skill: null }, "recent_100_skill_not_positive"],
    [{ brierCi: null }, "brier_ci_not_positive"],
    [{ logLossDelta: null }, "log_loss_regressed"],
    [{ coverageCi: null }, "coverage_regressed"],
    [{ adjustedQ: null }, "fdr_not_significant"],
  ];

  for (const [override, reason] of failures) {
    const result = evaluatePromotionGate(gateInput("registered", {
      evidence: passingEvidence(override),
    }));
    assert.equal(result.decision, "hold", reason);
    assert.equal(result.toStatus, "registered", reason);
    assert.equal(result.reason, reason);
  }
});

test("recent-30 and calibration evidence must be complete finite and ordered", () => {
  const failures = [
    [{ recent30Skill: null }, "recent_30_skill_missing"],
    [{ recent30Skill: Number.NaN }, "recent_30_skill_missing"],
    [{ calibrationDelta: null }, "calibration_evidence_invalid"],
    [{ calibrationDelta: Number.NaN }, "calibration_evidence_invalid"],
    [{ calibrationCi: null }, "calibration_evidence_invalid"],
    [{ calibrationCi: { lower95: Number.NaN, upper95: 0 } }, "calibration_evidence_invalid"],
    [{ calibrationCi: { lower95: -0.01, upper95: Number.POSITIVE_INFINITY } }, "calibration_evidence_invalid"],
    [{ calibrationCi: { lower95: 0.01, upper95: -0.01 } }, "calibration_evidence_invalid"],
    [{ calibrationDelta: 0.02, calibrationCi: { lower95: -0.01, upper95: 0.01 } }, "calibration_evidence_invalid"],
  ];

  for (const [override, reason] of failures) {
    const result = evaluatePromotionGate(gateInput("registered", {
      evidence: passingEvidence(override),
    }));
    assert.equal(result.decision, "hold", reason);
    assert.equal(result.toStatus, "registered", reason);
    assert.equal(result.reason, reason);
  }
});

test("log-loss zero and adjusted-q alpha boundary pass while just-over values fail", () => {
  const boundary = evaluatePromotionGate(gateInput("registered", {
    evidence: passingEvidence({ logLossDelta: 0, adjustedQ: 0.05 }),
  }));
  assert.equal(boundary.decision, "promote");
  assert.equal(boundary.toStatus, "historical_passed");

  assert.equal(evaluatePromotionGate(gateInput("registered", {
    evidence: passingEvidence({ logLossDelta: Number.EPSILON }),
  })).reason, "log_loss_regressed");
  assert.equal(evaluatePromotionGate(gateInput("registered", {
    evidence: passingEvidence({ adjustedQ: 0.0500000001 }),
  })).reason, "fdr_not_significant");
});

test("the same evidence digest produces no duplicate decision", () => {
  assert.equal(evaluatePromotionGate(gateInput("shadow_verified", {
    evidenceDigest: "same-digest",
    previousEvidenceDigest: "same-digest",
  })), null);
  assert.equal(evaluatePromotionGate(gateInput("champion", {
    evidence: passingEvidence({ recent30Skill: -0.01 }),
    evidenceDigest: "same-unhealthy-digest",
    previousEvidenceDigest: "same-unhealthy-digest",
    health: { ...healthy, modelValid: false },
  })), null);
  assert.throws(
    () => evaluatePromotionGate(gateInput("registered", { evidenceDigest: "" })),
    /evidenceDigest/i,
  );
});

test("champion holds on fresh passing evidence and terminal states never re-enter lifecycle", () => {
  const champion = evaluatePromotionGate(gateInput("champion"));
  assert.equal(champion.decision, "hold");
  assert.equal(champion.toStatus, "champion");
  assert.equal(champion.reason, "champion_retained");

  for (const stage of ["cooldown", "disabled", "rejected"] ) {
    const result = evaluatePromotionGate(gateInput(stage));
    assert.equal(result.decision, "hold", stage);
    assert.equal(result.toStatus, stage, stage);
    assert.equal(result.authorizedWeight, 0, stage);
  }
  assert.throws(() => evaluatePromotionGate(gateInput("canary", { stage: "unknown" })), /stage/i);
});

test("family representatives keep one deterministic strongest non-uniform candidate", () => {
  const candidates = [
    { name: "uniform-null", family: "uniform-null", evidence: passingEvidence() },
    { name: "bayes-b", family: "bayesian-drift", evidence: passingEvidence({ brierCi: { lower95: 0.002, upper95: 0.02 } }) },
    { name: "bayes-a", family: "bayesian-drift", evidence: passingEvidence({ brierCi: { lower95: 0.002, upper95: 0.02 } }) },
    { name: "transition-a", family: "transition-regularized", evidence: passingEvidence({ recent500Skill: 0.02 }) },
  ];
  const snapshot = structuredClone(candidates);

  const representatives = selectFamilyRepresentatives(candidates);
  assert.deepEqual(representatives.map(({ name }) => name), ["bayes-a", "transition-a"]);
  assert.deepEqual(candidates, snapshot);
});

test("candidate identity rejects reserved names unknown families and cross-family duplicates", () => {
  assert.throws(() => selectFamilyRepresentatives([{
    name: "uniform-null",
    family: "bayesian-drift",
    evidence: passingEvidence(),
  }]), /uniform-null/i);
  assert.throws(() => selectFamilyRepresentatives([{
    name: "unknown-v1",
    family: "unknown-family",
    evidence: passingEvidence(),
  }]), /family/i);
  assert.throws(() => selectFamilyRepresentatives([
    { name: "duplicate-v1", family: "bayesian-drift", evidence: passingEvidence() },
    { name: "duplicate-v1", family: "transition-regularized", evidence: passingEvidence() },
  ]), /duplicate.*name/i);

  assert.throws(() => buildProductionWeights({
    baselineName: "uniform-null",
    currentChampion: {
      name: "duplicate-v1",
      family: "bayesian-drift",
      stage: "champion",
      evidence: passingEvidence(),
    },
    candidates: [{
      name: "duplicate-v1",
      family: "transition-regularized",
      stage: "champion",
      evidence: passingEvidence(),
    }],
  }), /duplicate.*name/i);
});

test("canary receives exactly 0.10 and approved weights are normalized to exactly 0.90", () => {
  const input = {
    baselineName: "uniform-null",
    currentChampion: { name: "bayes-v1", family: "bayesian-drift", stage: "champion" },
    approvedWeights: { "uniform-null": 0.25, "bayes-v1": 0.75 },
    approvedFamilies: { "uniform-null": "uniform-null", "bayes-v1": "bayesian-drift" },
    challenger: { name: "transition-v1", family: "transition-regularized", stage: "canary" },
    familyEvidence: {
      "bayes-v1": passingEvidence(),
      "transition-v1": passingEvidence(),
    },
  };
  const snapshot = structuredClone(input);

  const weights = buildProductionWeights(input);
  assert.equal(weights["transition-v1"], 0.10);
  assert.equal(weights["uniform-null"], 0.225);
  assert.equal(weights["bayes-v1"], 0.675);
  assert.equal(Object.values(weights).reduce((sum, value) => sum + value, 0), 1);
  assert.deepEqual(input, snapshot);
});

test("canary without a champion assigns the remaining 0.90 to uniform-null", () => {
  const weights = buildProductionWeights({
    baselineName: "uniform-null",
    currentChampion: null,
    challenger: { name: "bayes-v1", family: "bayesian-drift", stage: "canary" },
    familyEvidence: { "bayes-v1": passingEvidence() },
  });

  assert.deepEqual(weights, { "uniform-null": 0.90, "bayes-v1": 0.10 });
});

test("canary rejects approved weights that remove the permanent uniform baseline", () => {
  assert.throws(() => buildProductionWeights({
    baselineName: "uniform-null",
    currentChampion: { name: "bayes-v1", family: "bayesian-drift", stage: "champion" },
    approvedWeights: { "bayes-v1": 1 },
    approvedFamilies: { "bayes-v1": "bayesian-drift" },
    challenger: { name: "transition-v1", family: "transition-regularized", stage: "canary" },
    familyEvidence: { "transition-v1": passingEvidence() },
  }), /uniform-null/i);
  assert.throws(() => buildProductionWeights({
    baselineName: "uniform-null",
    currentChampion: { name: "bayes-v1", family: "bayesian-drift", stage: "champion" },
    approvedWeights: { "uniform-null": 0, "bayes-v1": 1 },
    approvedFamilies: { "uniform-null": "uniform-null", "bayes-v1": "bayesian-drift" },
    challenger: { name: "transition-v1", family: "transition-regularized", stage: "canary" },
    familyEvidence: { "transition-v1": passingEvidence() },
  }), /uniform-null/i);
});

test("canary approved state requires family metadata and one active representative per family", () => {
  const base = {
    baselineName: "uniform-null",
    currentChampion: { name: "bayes-v1", family: "bayesian-drift", stage: "champion" },
    approvedWeights: { "uniform-null": 0.25, "bayes-v1": 0.75 },
    challenger: { name: "transition-v1", family: "transition-regularized", stage: "canary" },
    familyEvidence: { "transition-v1": passingEvidence() },
  };
  assert.throws(() => buildProductionWeights(base), /approvedFamilies/i);
  assert.throws(() => buildProductionWeights({
    ...base,
    approvedWeights: { "uniform-null": 0.25, "bayes-v1": 0.50, "bayes-v2": 0.25 },
    approvedFamilies: {
      "uniform-null": "uniform-null",
      "bayes-v1": "bayesian-drift",
      "bayes-v2": "bayesian-drift",
    },
  }), /family representative/i);
  assert.throws(() => buildProductionWeights({
    ...base,
    approvedFamilies: { "uniform-null": "uniform-null", "bayes-v1": "unknown-family" },
  }), /family/i);
});

test("champion weights reserve 0.25 for uniform and share 0.75 by excess loss", () => {
  const candidates = [
    { name: "bayes-v1", family: "bayesian-drift", stage: "champion", evidence: passingEvidence({ meanExcessLoss: 0 }) },
    { name: "bayes-v2", family: "bayesian-drift", stage: "champion", evidence: passingEvidence({ meanExcessLoss: -0.02, brierCi: { lower95: 0.002, upper95: 0.03 } }) },
    { name: "transition-v1", family: "transition-regularized", stage: "champion", evidence: passingEvidence({ meanExcessLoss: 0.1 }) },
    { name: "sequence-v1", family: "sequence-challenger", stage: "champion", evidence: passingEvidence({ recent500Skill: 0 }) },
  ];

  const weights = buildProductionWeights({ baselineName: "uniform-null", candidates });
  const bayesRaw = Math.exp(0.1);
  const transitionRaw = Math.exp(-0.5);
  assert.equal(weights["uniform-null"], 0.25);
  assert.ok(Math.abs(weights["bayes-v2"] - (0.75 * bayesRaw / (bayesRaw + transitionRaw))) < 1e-12);
  assert.ok(Math.abs(weights["transition-v1"] - (0.75 * transitionRaw / (bayesRaw + transitionRaw))) < 1e-12);
  assert.equal(weights["bayes-v1"], 0);
  assert.equal(weights["sequence-v1"], 0);
  assert.equal(Object.values(weights).reduce((sum, value) => sum + value, 0), 1);
});

test("no eligible challenger retains a valid prior champion or falls back to uniform-null", () => {
  const prior = { name: "prior-v1", family: "bayesian-drift", stage: "champion", evidence: passingEvidence() };
  assert.deepEqual(buildProductionWeights({
    baselineName: "uniform-null",
    currentChampion: prior,
    candidates: [{ name: "bad-v1", family: "transition-regularized", stage: "champion", evidence: passingEvidence({ recent100Skill: 0 }) }],
  }), {
    "uniform-null": 0.25,
    "prior-v1": 0.75,
    "bad-v1": 0,
  });

  assert.deepEqual(buildProductionWeights({
    baselineName: "uniform-null",
    candidates: [{ name: "bad-v1", family: "transition-regularized", stage: "champion", evidence: passingEvidence({ recent500Skill: -0.01 }) }],
  }), {
    "uniform-null": 1,
    "bad-v1": 0,
  });
});

test("family isolation rejects a canary from the active champion family", () => {
  assert.throws(() => buildProductionWeights({
    baselineName: "uniform-null",
    currentChampion: { name: "bayes-v1", family: "bayesian-drift", stage: "champion" },
    approvedWeights: { "uniform-null": 0.25, "bayes-v1": 0.75 },
    approvedFamilies: { "uniform-null": "uniform-null", "bayes-v1": "bayesian-drift" },
    challenger: { name: "bayes-v2", family: "bayesian-drift", stage: "canary" },
    familyEvidence: { "bayes-v2": passingEvidence() },
  }), /family representative/i);
});
