function cloneJson(value) {
  return value === undefined ? {} : structuredClone(value);
}

export function createBaselineState({ gameName = null, expertNames = [], learningConfig = {} } = {}) {
  const names = [];
  for (const name of expertNames) {
    if (typeof name === "string" && name && !names.includes(name)) names.push(name);
  }
  if (!names.includes("uniform")) names.push("uniform");
  const weight = 1 / names.length;

  return {
    game_name: gameName,
    state_version: 0,
    status: "baseline",
    champion_model: "uniform",
    expert_weights: Object.fromEntries(names.map((name) => [name, weight])),
    learning_config: cloneJson(learningConfig),
    metrics: {},
    last_learned_draw_id: null,
    last_learned_draw_date: null,
  };
}

export function benjaminiHochberg(pValues) {
  if (!Array.isArray(pValues)) throw new TypeError("pValues must be an array");
  const ranked = pValues.map((value, index) => {
    if (!Number.isFinite(value)) throw new TypeError("pValues must contain finite numbers");
    if (value < 0 || value > 1) throw new RangeError("pValues must be within [0, 1]");
    return { value, index };
  }).sort((left, right) => left.value - right.value || left.index - right.index);
  const adjusted = Array(pValues.length);
  let runningMinimum = 1;
  for (let index = ranked.length - 1; index >= 0; index -= 1) {
    const candidate = Math.min(1, ranked[index].value * ranked.length / (index + 1));
    runningMinimum = Math.min(runningMinimum, candidate);
    adjusted[ranked[index].index] = runningMinimum;
  }
  return adjusted;
}

export function evaluatePromotion(metrics = {}) {
  if (!Number.isFinite(metrics.productionSamples) || metrics.productionSamples < 30) {
    return { promoted: false, reason: "insufficient_production_samples" };
  }
  if (!Number.isFinite(metrics.recent100Skill) || metrics.recent100Skill <= 0) {
    return { promoted: false, reason: "recent_100_not_skillful" };
  }
  if (!Number.isFinite(metrics.recent500Skill) || metrics.recent500Skill <= 0) {
    return { promoted: false, reason: "recent_500_not_skillful" };
  }
  if (!Number.isFinite(metrics.bootstrapLower95) || metrics.bootstrapLower95 <= 0) {
    return { promoted: false, reason: "confidence_interval_crosses_zero" };
  }
  if (!Number.isFinite(metrics.adjustedQ) || metrics.adjustedQ < 0 || metrics.adjustedQ > 0.05) {
    return { promoted: false, reason: "multiple_test_threshold_failed" };
  }
  if (!Number.isFinite(metrics.unionCoverageDelta) || metrics.unionCoverageDelta < 0) {
    return { promoted: false, reason: "coverage_regression" };
  }
  return { promoted: true, reason: "all_gates_passed" };
}
