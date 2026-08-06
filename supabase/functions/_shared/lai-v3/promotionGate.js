const GATE_VERSION = "lai-v3-promotion-gate-v1";
const CANARY_WEIGHT = 0.10;
const UNIFORM_CHAMPION_WEIGHT = 0.25;

const STAGES = new Set([
  "baseline",
  "registered",
  "historical_passed",
  "shadow_verified",
  "canary",
  "champion",
  "cooldown",
  "disabled",
  "rejected",
]);
const ACTIVE_STAGES = new Set(["historical_passed", "shadow_verified", "canary", "champion"]);
const TERMINAL_STAGES = new Set(["cooldown", "disabled", "rejected"]);

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function assertName(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function assertCounter(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative integer`);
  }
}

function finite(value) {
  return Number.isFinite(value);
}

function makeDecision(fromStatus, decision, toStatus, reason, evidenceDigest, authorizedWeight = 0) {
  return {
    decision,
    fromStatus,
    toStatus,
    reason,
    gateVersion: GATE_VERSION,
    evidenceDigest,
    authorizedWeight,
  };
}

function evidenceFailure(evidence) {
  if (!Number.isInteger(evidence.sampleCount) || evidence.sampleCount < 500) {
    return "historical_window_incomplete";
  }
  if (!finite(evidence.recent100Skill) || evidence.recent100Skill <= 0) {
    return "recent_100_skill_not_positive";
  }
  if (!finite(evidence.recent500Skill) || evidence.recent500Skill <= 0) {
    return "recent_500_skill_not_positive";
  }
  if (!finite(evidence.brierCi?.lower95) || evidence.brierCi.lower95 <= 0) {
    return "brier_ci_not_positive";
  }
  if (!finite(evidence.logLossDelta) || evidence.logLossDelta > 0) {
    return "log_loss_regressed";
  }
  if (!finite(evidence.coverageCi?.lower95) || evidence.coverageCi.lower95 < 0) {
    return "coverage_regressed";
  }
  if (!finite(evidence.adjustedQ) || evidence.adjustedQ < 0 || evidence.adjustedQ > 0.05) {
    return "fdr_not_significant";
  }
  return null;
}

function healthFailed(health) {
  assertObject(health, "health");
  for (const key of ["dataValid", "replayDigestValid", "modelValid"]) {
    if (typeof health[key] !== "boolean") throw new TypeError(`health.${key} must be boolean`);
    if (!health[key]) return true;
  }
  return false;
}

export function evaluatePromotionGate(input) {
  assertObject(input, "promotion gate input");
  const stage = assertName(input.stage, "stage");
  if (!STAGES.has(stage)) throw new RangeError("stage is unsupported");
  assertObject(input.evidence, "evidence");
  assertCounter(input.liveShadowDraws, "liveShadowDraws");
  assertCounter(input.canaryDraws, "canaryDraws");
  const evidenceDigest = assertName(input.evidenceDigest, "evidenceDigest");
  if (input.previousEvidenceDigest != null && typeof input.previousEvidenceDigest !== "string") {
    throw new TypeError("previousEvidenceDigest must be a string or null");
  }
  const unhealthy = healthFailed(input.health);
  if (input.previousEvidenceDigest === evidenceDigest) return null;

  if (stage === "baseline") {
    return makeDecision(stage, "hold", stage, "uniform_null_permanent", evidenceDigest);
  }
  if (TERMINAL_STAGES.has(stage)) {
    return makeDecision(stage, "hold", stage, "terminal_stage_retained", evidenceDigest);
  }
  if (unhealthy) {
    return makeDecision(stage, "disable", "disabled", "health_check_failed", evidenceDigest);
  }
  if (finite(input.evidence.recent30Skill) && input.evidence.recent30Skill < 0) {
    return ACTIVE_STAGES.has(stage)
      ? makeDecision(stage, "demote", "cooldown", "rolling_30_skill_negative", evidenceDigest)
      : makeDecision(stage, "hold", stage, "rolling_30_skill_negative", evidenceDigest);
  }
  if (finite(input.evidence.calibrationDelta)
    && input.evidence.calibrationDelta > 0
    && finite(input.evidence.calibrationCi?.lower95)
    && input.evidence.calibrationCi.lower95 > 0
    && finite(input.evidence.adjustedQ)
    && input.evidence.adjustedQ <= 0.05) {
    return ACTIVE_STAGES.has(stage)
      ? makeDecision(stage, "demote", "cooldown", "calibration_significantly_worse", evidenceDigest)
      : makeDecision(stage, "hold", stage, "calibration_significantly_worse", evidenceDigest);
  }
  const failure = evidenceFailure(input.evidence);
  if (failure) {
    return ACTIVE_STAGES.has(stage)
      ? makeDecision(stage, "demote", "cooldown", failure, evidenceDigest)
      : makeDecision(stage, "hold", stage, failure, evidenceDigest);
  }

  if (stage === "registered") {
    return makeDecision(stage, "promote", "historical_passed", "historical_evidence_passed", evidenceDigest);
  }
  if (stage === "historical_passed") {
    return input.liveShadowDraws >= 30
      ? makeDecision(stage, "promote", "shadow_verified", "live_shadow_verified", evidenceDigest)
      : makeDecision(stage, "hold", stage, "live_shadow_window_incomplete", evidenceDigest);
  }
  if (stage === "shadow_verified") {
    return makeDecision(stage, "promote", "canary", "canary_authorized", evidenceDigest, CANARY_WEIGHT);
  }
  if (stage === "canary") {
    return input.canaryDraws >= 20
      ? makeDecision(stage, "promote", "champion", "champion_authorized", evidenceDigest, 0.75)
      : makeDecision(stage, "hold", stage, "canary_window_incomplete", evidenceDigest, CANARY_WEIGHT);
  }
  return makeDecision(stage, "hold", stage, "champion_retained", evidenceDigest, 0.75);
}

function candidateEvidence(candidate, familyEvidence) {
  return candidate.evidence ?? familyEvidence?.[candidate.name] ?? null;
}

function candidateWithEvidence(candidate, familyEvidence) {
  assertObject(candidate, "candidate");
  const name = assertName(candidate.name, "candidate.name");
  const family = assertName(candidate.family, "candidate.family");
  const evidence = candidateEvidence(candidate, familyEvidence);
  assertObject(evidence, `evidence for ${name}`);
  return { ...candidate, name, family, evidence };
}

function compareEvidence(left, right) {
  const comparisons = [
    (left.brierCi?.lower95 ?? Number.NEGATIVE_INFINITY)
      - (right.brierCi?.lower95 ?? Number.NEGATIVE_INFINITY),
    (left.recent500Skill ?? Number.NEGATIVE_INFINITY)
      - (right.recent500Skill ?? Number.NEGATIVE_INFINITY),
    (left.recent100Skill ?? Number.NEGATIVE_INFINITY)
      - (right.recent100Skill ?? Number.NEGATIVE_INFINITY),
  ];
  return comparisons.find((value) => value !== 0 && !Number.isNaN(value)) ?? 0;
}

export function selectFamilyRepresentatives(candidates) {
  if (!Array.isArray(candidates)) throw new TypeError("candidates must be an array");
  const byFamily = new Map();
  for (const raw of candidates) {
    const candidate = candidateWithEvidence(raw);
    if (candidate.family === "uniform-null") continue;
    const current = byFamily.get(candidate.family);
    const comparison = current ? compareEvidence(candidate.evidence, current.evidence) : 1;
    if (!current || comparison > 0 || (comparison === 0 && candidate.name < current.name)) {
      byFamily.set(candidate.family, candidate);
    }
  }
  return [...byFamily.values()].sort((left, right) => left.family.localeCompare(right.family));
}

function sumWeights(weights) {
  return Object.values(weights).reduce((sum, value) => sum + value, 0);
}

function closeExactly(weights, adjustableName, target = 1) {
  weights[adjustableName] += target - sumWeights(weights);
  return weights;
}

function normalizedApprovedWeights({ baselineName, currentChampion, approvedWeights, total }) {
  const source = approvedWeights ?? (currentChampion
    ? { [baselineName]: UNIFORM_CHAMPION_WEIGHT, [currentChampion.name]: 0.75 }
    : { [baselineName]: 1 });
  assertObject(source, "approvedWeights");
  const entries = Object.entries(source);
  if (entries.length === 0) throw new RangeError("approvedWeights must not be empty");
  for (const [name, value] of entries) {
    assertName(name, "approved weight name");
    if (!finite(value) || value < 0) throw new RangeError("approvedWeights must be finite and non-negative");
  }
  if (!finite(source[baselineName]) || source[baselineName] <= 0) {
    throw new RangeError(`${baselineName} must retain positive approved weight`);
  }
  const sourceTotal = sumWeights(source);
  if (sourceTotal <= 0) throw new RangeError("approvedWeights must have positive total weight");
  const result = Object.fromEntries(entries.map(([name, value]) => [name, total * value / sourceTotal]));
  const adjustmentName = entries.reduce((best, entry) => (entry[1] > best[1] ? entry : best))[0];
  return closeExactly(result, adjustmentName, total);
}

function canEnterProduction(evidence) {
  return evidenceFailure(evidence) == null;
}

function canaryWeights(input, baselineName) {
  const challenger = candidateWithEvidence(input.challenger, input.familyEvidence);
  if (challenger.stage !== "canary") throw new RangeError("challenger must be at canary stage");
  if (input.currentChampion?.family === challenger.family) {
    throw new RangeError("only one active family representative is allowed");
  }
  if (!canEnterProduction(challenger.evidence)) {
    return normalizedApprovedWeights({ ...input, baselineName, total: 1 });
  }
  const weights = normalizedApprovedWeights({ ...input, baselineName, total: 0.90 });
  if (Object.hasOwn(weights, challenger.name)) {
    throw new RangeError("challenger is already present in approvedWeights");
  }
  const approvedAdjustment = Object.entries(weights)
    .reduce((best, entry) => (entry[1] > best[1] ? entry : best))[0];
  weights[challenger.name] = CANARY_WEIGHT;
  return closeExactly(weights, approvedAdjustment);
}

function championWeights(input, baselineName) {
  const originalCandidates = Array.isArray(input.candidates) ? input.candidates : [];
  const all = originalCandidates.map((candidate) => candidateWithEvidence(candidate, input.familyEvidence));
  if (input.currentChampion
    && !all.some((candidate) => candidate.name === input.currentChampion.name)) {
    all.push(candidateWithEvidence(input.currentChampion, input.familyEvidence));
  }

  const weights = { [baselineName]: UNIFORM_CHAMPION_WEIGHT };
  for (const candidate of all) weights[candidate.name] = 0;
  const eligible = selectFamilyRepresentatives(all.filter((candidate) => (
    candidate.stage === "champion" && canEnterProduction(candidate.evidence)
  )));
  if (eligible.length === 0) {
    weights[baselineName] = 1;
    return weights;
  }

  const scores = eligible.map((candidate) => {
    if (!finite(candidate.evidence.meanExcessLoss)) {
      throw new TypeError(`meanExcessLoss for ${candidate.name} must be finite`);
    }
    return -5 * candidate.evidence.meanExcessLoss;
  });
  const maxScore = Math.max(...scores);
  const raw = scores.map((score) => Math.exp(score - maxScore));
  const rawTotal = raw.reduce((sum, value) => sum + value, 0);
  eligible.forEach((candidate, index) => {
    weights[candidate.name] = 0.75 * raw[index] / rawTotal;
  });
  return closeExactly(weights, eligible.at(-1).name);
}

export function buildProductionWeights(input) {
  assertObject(input, "production weight input");
  const baselineName = assertName(input.baselineName, "baselineName");
  if (baselineName !== "uniform-null") throw new RangeError("baselineName must be uniform-null");
  if (input.challenger != null) return canaryWeights(input, baselineName);
  return championWeights(input, baselineName);
}
