import {
  benjaminiHochberg,
  createBaselineState,
  evaluatePromotion,
} from "../../lotto-predict-notify/lib/agentState.js";
import { updateHedgeWeights } from "../../lotto-predict-notify/lib/ensemble.js";
import {
  brierScore,
  brierSkillScore,
  combinedAreaBrier,
  coverageMetrics,
  logLoss,
} from "../../lotto-predict-notify/lib/scoring.js";

export const GAME_NAMES = {
  "539": "今彩539",
  "649": "大樂透",
  "power": "威力彩",
};

const OFFICIAL_KEYS = {
  "539": "daily539Res",
  "649": "lotto649Res",
  "power": "superLotto638Res",
};

export function normalizeNumbers(numbers) {
  return [...numbers].map((value) => Number(value)).sort((a, b) => a - b);
}

export function parseOfficialPayload(gameType, payload) {
  if (!payload || payload.rtCode !== 0) {
    throw new Error(`Taiwan Lottery API returned an invalid response for ${gameType}`);
  }

  const resultKey = OFFICIAL_KEYS[gameType];
  const rows = payload.content?.[resultKey];
  if (!Array.isArray(rows)) {
    throw new Error(`Taiwan Lottery API response is missing ${resultKey}`);
  }

  return rows.map((row) => {
    const drawNumbers = row.drawNumberSize || [];
    const baseNumbers = gameType === "649" || gameType === "power"
      ? drawNumbers.slice(0, 6)
      : drawNumbers.slice(0, 5);
    const specialNumber = gameType === "649" || gameType === "power" ? Number(drawNumbers[6]) : null;

    return {
      draw_id: String(row.period),
      date: String(row.lotteryDate).split("T")[0],
      numbers: normalizeNumbers(baseNumbers),
      special_number: Number.isFinite(specialNumber) ? specialNumber : null,
      source: "taiwan_lottery_official",
      raw: row,
    };
  });
}

export function latestByDrawId(draws) {
  if (!draws.length) {
    return null;
  }

  return [...draws].sort((left, right) =>
    String(left.draw_id).localeCompare(String(right.draw_id), undefined, { numeric: true })
  ).at(-1);
}

export function parseAuzonetDaily539Html(html) {
  const normalized = html.replace(/\s+/g, " ");
  const titleMatches = [...normalized.matchAll(/今彩\s*539開獎號碼/g)];
  const candidates = titleMatches.length
    ? titleMatches.map((match) => normalized.slice(match.index, match.index + 2500)).reverse()
    : [normalized];

  for (const candidate of candidates) {
    if (!candidate.includes("開出號碼")) {
      continue;
    }

    const drawIdMatch = candidate.match(/(?:第\s*)?(\d{9})\s*期/);
    const dateMatch = candidate.match(/(20\d{2}-\d{2}-\d{2})/);
    if (!drawIdMatch || !dateMatch) {
      continue;
    }

    const numberArea = candidate.slice(candidate.indexOf("開出號碼"));
    const rawNumbers = [...numberArea.matchAll(/(?:>|^|\s)(\d{1,2})(?:<|\s|$)/g)]
      .map((match) => Number(match[1]))
      .filter((value) => value >= 1 && value <= 39);

    const numbers = rawNumbers.slice(0, 5);
    if (numbers.length !== 5) {
      continue;
    }

    return {
      draw_id: drawIdMatch[1],
      date: dateMatch[1],
      numbers: normalizeNumbers(numbers),
      special_number: null,
      source: "auzonet",
      raw: { source: "auzonet" },
    };
  }

  throw new Error("Auzonet Daily539 HTML is missing a valid Daily539 draw block");
}

function sameDrawIdentity(left, right) {
  return String(left.draw_id) === String(right.draw_id) && left.date === right.date;
}

function sameNumbers(left, right) {
  return JSON.stringify(normalizeNumbers(left.numbers)) === JSON.stringify(normalizeNumbers(right.numbers)) &&
    (left.special_number ?? null) === (right.special_number ?? null);
}

export function chooseFreshestDraw(officialDraw, secondaryDraw) {
  if (!officialDraw) {
    return secondaryDraw;
  }
  if (!secondaryDraw) {
    return officialDraw;
  }

  if (sameDrawIdentity(officialDraw, secondaryDraw) && !sameNumbers(officialDraw, secondaryDraw)) {
    throw new Error(
      `Same draw has conflicting numbers: official=${JSON.stringify(officialDraw)} secondary=${JSON.stringify(secondaryDraw)}`,
    );
  }

  if (
    secondaryDraw.date > officialDraw.date ||
    String(secondaryDraw.draw_id).localeCompare(String(officialDraw.draw_id), undefined, { numeric: true }) > 0
  ) {
    return secondaryDraw;
  }

  return officialDraw;
}

export function isDaily539ExpectedDrawDate(dateString) {
  const date = new Date(`${dateString}T00:00:00Z`);
  const day = date.getUTCDay();
  return day >= 1 && day <= 6;
}

export function needsSecondaryDaily539Check({ latestOfficialDate, targetDate, taiwanHour }) {
  return isDaily539ExpectedDrawDate(targetDate) &&
    (!latestOfficialDate || latestOfficialDate < targetDate);
}

export function toLottoDrawRow(gameType, draw) {
  return {
    game_name: GAME_NAMES[gameType],
    draw_id: String(draw.draw_id),
    draw_date: draw.date,
    numbers: normalizeNumbers(draw.numbers),
    special_number: draw.special_number ?? null,
    raw: {
      source: draw.source,
      payload: draw.raw,
    },
  };
}

export function canonicalDrawPayload(draw) {
  return {
    game_name: draw?.game_name,
    draw_id: String(draw?.draw_id),
    draw_date: draw?.draw_date ?? draw?.date,
    sorted_numbers: normalizeNumbers(draw?.numbers || []),
    special_number: draw?.special_number ?? null,
  };
}

function explicitDrawRevision(draw) {
  const raw = draw?.raw && typeof draw.raw === "object" ? draw.raw : {};
  const payload = raw.payload && typeof raw.payload === "object" ? raw.payload : {};
  const storedRevision = raw.source_revision_kind === "canonical"
    ? null
    : (draw?.source_revision
    ?? draw?.sourceRevision
    ?? raw.source_revision
    ?? raw.sourceRevision);
  const value = storedRevision
    ?? payload.revision_id
    ?? payload.revisionId
    ?? payload.revision;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function hasExplicitDrawRevision(draw) {
  return explicitDrawRevision(draw) != null;
}

export function drawPayloadChanged(existing, incoming) {
  const left = canonicalDrawPayload(existing);
  const right = canonicalDrawPayload(incoming);
  return JSON.stringify(left) !== JSON.stringify(right)
    || explicitDrawRevision(existing) !== explicitDrawRevision(incoming);
}

export async function buildDrawRevision(draw) {
  const raw = draw?.raw && typeof draw.raw === "object" ? draw.raw : {};
  if (raw.source_revision_kind === "canonical"
    && typeof raw.source_revision === "string" && raw.source_revision.trim()) {
    return raw.source_revision.trim();
  }
  const explicitRevision = explicitDrawRevision(draw);
  if (explicitRevision) return explicitRevision;
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalDrawPayload(draw)));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function uniqueSortedNumbers(numbers) {
  return normalizeNumbers(
    [...new Set((numbers || []).map((value) => Number(value)).filter(Number.isFinite))]
  );
}

function buildStrategyIndex(combinations) {
  const byNumber = new Map();

  for (const [strategyName, predictedNumbers] of Object.entries(combinations || {})) {
    for (const number of uniqueSortedNumbers(predictedNumbers)) {
      if (!byNumber.has(number)) {
        byNumber.set(number, []);
      }
      byNumber.get(number).push(strategyName);
    }
  }

  return byNumber;
}

function selectedNumberInsights(prediction) {
  const insights = prediction?.number_insights || {};
  const selected = insights.selected_numbers && typeof insights.selected_numbers === "object"
    ? insights.selected_numbers
    : insights;
  return selected && typeof selected === "object" ? selected : {};
}

function aiCandidateMap(prediction) {
  return new Map((prediction?.ai_decision?.candidate_pool || [])
    .map((item) => [Number(item?.number), item])
    .filter(([number]) => Number.isFinite(number)));
}

function selectionReasonForNumber(number, prediction) {
  const insights = selectedNumberInsights(prediction);
  const candidateByNumber = aiCandidateMap(prediction);
  const insight = insights[String(number)] || {};
  const candidate = candidateByNumber.get(number) || {};
  const directReason = typeof insight.reason === "string" ? insight.reason.trim() : "";

  if (directReason) {
    return directReason;
  }

  const signals = [];
  const statisticsReason = insight.ai_statistics_reason || candidate.statistics_reason;
  const metaphysicsSignal = insight.metaphysics_signal || candidate.metaphysics_signal;
  if (statisticsReason) {
    signals.push(`AI 統計訊號：${statisticsReason}`);
  }
  if (metaphysicsSignal) {
    signals.push(`玄學因子：${metaphysicsSignal}`);
  }
  if (Number.isFinite(Number(insight.overdue_index))) {
    signals.push(`即將開出指數 ${Number(insight.overdue_index).toFixed(2)}`);
  }

  return signals.length
    ? signals.join("；")
    : "原始紀錄未保留細部選號理由，僅能確認此號碼由當期策略組合納入。";
}

function chooseBestStrategy(strategies) {
  let best = null;

  for (const [strategyName, stats] of Object.entries(strategies || {})) {
    const hits = Number(stats?.hits || 0);
    const missCount = Number(stats?.miss_count || 0);
    if (
      !best ||
      hits > best.hits ||
      (hits === best.hits && missCount < best.missCount)
    ) {
      best = { name: strategyName, hits, missCount };
    }
  }

  return best;
}

function predictedNumberAnalysis(outcome) {
  if (outcome === "hit") {
    return {
      post_draw_analysis: "命中：此號碼實際開出，代表當期選號訊號與結果同向。後續可保留這類因子，但仍需用多期回測避免單期過度擬合。",
      learning_note: "保留此號碼背後的選號因子，觀察同類訊號是否能在多期持續產生命中。",
    };
  }

  return {
    post_draw_analysis: "未中：此號碼沒有開出，表示當期模型可能高估此訊號，或被短期隨機性抵銷。後續應檢查相同理由在歷史回測中的命中率。",
    learning_note: "降低單一冷熱、遺漏或玄學訊號的孤立權重，要求與共開、和值、區間分布等訊號交叉確認。",
  };
}

function actualNumberAnalysis(number, wasPredicted) {
  if (wasPredicted) {
    return {
      opening_analysis: "實際開出且已被模型納入，表示當期量化訊號至少捕捉到此號碼。後續應追蹤相同訊號是否有穩定性。",
      learning_note: "將此命中號碼的選號理由列為正向樣本，用於檢查同類因子的長期命中率。",
    };
  }

  return {
    opening_analysis: "實際開出但未被任何組合納入，代表模型漏抓此號碼。樂透結果具隨機性，無法做確定因果歸因，只能回頭檢查近期頻率、遺漏期數、共開關聯與區間分布是否被低估。",
    learning_note: `underweighted actual signal: 下次預測要回測 ${number} 是否有弱訊號轉強、共開關聯或分布補位價值。`,
  };
}

function strategyReview(strategyName, stats) {
  const hits = Number(stats?.hits || 0);
  const predictedCount = hits + Number(stats?.miss_count || 0);
  const hitText = `${hits} / ${predictedCount}`;

  if (predictedCount > 0 && hits >= Math.ceil(predictedCount / 2)) {
    return {
      analysis: `${strategyName} 本期命中 ${hitText}，是相對有效的策略樣本，可保留核心因子並避免過度調整。`,
      next_adjustment: "維持此策略的主要權重，但要求下期檢查命中號碼的共通訊號，避免只複製單期結果。",
    };
  }
  if (hits > 0) {
    return {
      analysis: `${strategyName} 本期命中 ${hitText}，捕捉到部分訊號，但仍有明顯誤差需要拆解。`,
      next_adjustment: "降低未中號碼的單一訊號權重，優先找出命中號碼與漏抓號碼之間的統計差異。",
    };
  }

  return {
    analysis: `${strategyName} 本期命中 ${hitText}，當期策略訊號未能對應實際開獎。`,
    next_adjustment: "下期應降低此策略的既有權重，並要求 Gemini 重新檢查候選池排序與風險分散。",
  };
}

function buildPostDrawLearningReport(record, actualNumbers, strategies) {
  const prediction = record?.prediction || {};
  const combinations = prediction.combinations || {};
  const strategyByNumber = buildStrategyIndex(combinations);
  const predictedNumbers = uniqueSortedNumbers([...strategyByNumber.keys()]);
  const actualSet = new Set(actualNumbers);
  const hitPredictedNumbers = predictedNumbers.filter((number) => actualSet.has(number));
  const missedPredictedNumbers = predictedNumbers.filter((number) => !actualSet.has(number));
  const uncoveredActualNumbers = actualNumbers.filter((number) => !strategyByNumber.has(number));
  const bestStrategy = chooseBestStrategy(strategies);

  const predictedNumberRows = predictedNumbers.map((number) => {
    const outcome = actualSet.has(number) ? "hit" : "miss";
    return {
      number,
      outcome,
      strategies: strategyByNumber.get(number) || [],
      selection_reason: selectionReasonForNumber(number, prediction),
      ...predictedNumberAnalysis(outcome),
    };
  });

  const actualNumberRows = actualNumbers.map((number) => {
    const wasPredicted = strategyByNumber.has(number);
    return {
      number,
      was_predicted: wasPredicted,
      matched_strategies: strategyByNumber.get(number) || [],
      ...actualNumberAnalysis(number, wasPredicted),
    };
  });

  const strategyReviews = Object.fromEntries(
    Object.entries(strategies || {}).map(([strategyName, stats]) => [
      strategyName,
      {
        hits: Number(stats?.hits || 0),
        matches: stats?.matches || [],
        missed_numbers: stats?.missed_numbers || [],
        ...strategyReview(strategyName, stats),
      },
    ]),
  );

  const nextPredictionGuidance = [
    uncoveredActualNumbers.length
      ? `回測漏抓號碼 ${uncoveredActualNumbers.join("、")} 的近期頻率、遺漏期數、共開關聯與區間分布，確認是否被模型 underweighted。`
      : "本期實際開出號碼都曾被模型納入，下一期可把命中理由列為正向樣本。",
    missedPredictedNumbers.length
      ? `檢查未中號碼 ${missedPredictedNumbers.join("、")} 的選號理由在歷史回測中的命中率，避免單一訊號權重過高。`
      : "本期沒有未中預測號碼，下一期仍需維持風險分散，避免過度擬合。",
    bestStrategy
      ? `保留 ${bestStrategy.name} 的有效因子，並要求 Gemini 對其他策略補強與最佳策略不同的候選來源。`
      : "下期需重新檢查三組策略的候選池，確保每組策略都有可追溯的量化理由。",
    "下次預測時將本期 learning_report 納入檢討脈絡，對高誤差訊號降權，對漏抓訊號建立補強觀察清單。",
  ];

  return {
    version: "post_draw_learning_v1",
    summary: {
      best_strategy: bestStrategy?.name || null,
      best_strategy_hits: bestStrategy?.hits ?? 0,
      unique_predicted_count: predictedNumbers.length,
      hit_predicted_numbers: hitPredictedNumbers,
      missed_predicted_numbers: missedPredictedNumbers,
      uncovered_actual_numbers: uncoveredActualNumbers,
    },
    predicted_numbers: predictedNumberRows,
    actual_numbers: actualNumberRows,
    strategy_reviews: strategyReviews,
    next_prediction_guidance: nextPredictionGuidance,
    limitation: "樂透開獎是隨機事件，此報告只能做統計歸因、誤差拆解與下期模型調整依據，不代表可確定預測開獎結果。",
  };
}

export function evaluatePredictionRecord(record, draw) {
  const actualNumbers = normalizeNumbers(draw.numbers || []);
  const actualSet = new Set(actualNumbers);
  const actualSpecialNumber = Number(draw.special_number);
  const combinations = record?.prediction?.combinations || {};
  const specialCombinations = record?.prediction?.special_combinations || {};
  const strategies = {};

  for (const [strategyName, predictedNumbers] of Object.entries(combinations)) {
    const predicted = normalizeNumbers(predictedNumbers || []);
    const matches = predicted.filter((number) => actualSet.has(number));
    const missed = predicted.filter((number) => !actualSet.has(number));
    const predictedSpecial = normalizeNumbers(specialCombinations[strategyName] || []);
    const specialMatches = Number.isInteger(actualSpecialNumber)
      ? predictedSpecial.filter((number) => number === actualSpecialNumber)
      : [];
    const specialMissed = Number.isInteger(actualSpecialNumber)
      ? predictedSpecial.filter((number) => number !== actualSpecialNumber)
      : predictedSpecial;

    strategies[strategyName] = {
      hits: matches.length,
      matches,
      miss_count: missed.length,
      missed_numbers: missed,
      special_hits: specialMatches.length,
      special_matches: specialMatches,
      special_miss_count: specialMissed.length,
      special_missed_numbers: specialMissed,
    };
  }

  return {
    draw_id: String(draw.draw_id),
    draw_date: draw.draw_date ?? draw.date,
    actual_numbers: actualNumbers,
    special_number: draw.special_number ?? null,
    strategies,
    learning_report: buildPostDrawLearningReport(record, actualNumbers, strategies),
    attribution_report: null,
    attribution_trigger: "supabase_edge_basic_evaluation",
  };
}

function forecastGroups(finalGroups, key) {
  const groups = finalGroups?.[key];
  if (!groups || typeof groups !== "object") {
    return [[], []];
  }

  const values = Object.values(groups).filter(Array.isArray);
  return [
    groups["機率主攻"] ?? values[0] ?? [],
    groups["覆蓋探索"] ?? values[1] ?? [],
  ];
}

function areaScore({ probabilities, actualNumbers, maxNumber, picks, groups }) {
  const baseline = Array(maxNumber).fill(picks / maxNumber);
  const brier = brierScore(probabilities, actualNumbers, maxNumber);
  const baselineBrier = brierScore(baseline, actualNumbers, maxNumber);

  return {
    brier,
    baseline_brier: baselineBrier,
    log_loss: logLoss(probabilities, actualNumbers, maxNumber),
    brier_skill_score: brierSkillScore(brier, baselineBrier),
    coverage: coverageMetrics(groups[0], groups[1], actualNumbers),
  };
}

export function scoreModelForecast({ forecast, draw, config }) {
  const metrics = areaScore({
    probabilities: forecast?.probabilities,
    actualNumbers: draw?.numbers || [],
    maxNumber: config?.maxNumber,
    picks: config?.picks,
    groups: forecastGroups(forecast?.final_groups, "combinations"),
  });

  if (config?.secondaryNumber) {
    metrics.special_area = Array.isArray(forecast?.special_probabilities)
      ? areaScore({
        probabilities: forecast.special_probabilities,
        actualNumbers: [draw?.special_number],
        maxNumber: config.secondaryNumber.maxNumber,
        picks: config.secondaryNumber.picks,
        groups: forecastGroups(forecast?.final_groups, "special_combinations"),
      })
      : {
        available: false,
        reason: "special_probabilities_unavailable",
      };
  }

  metrics.combined_brier = combinedAreaBrier(
    metrics.brier,
    Number.isFinite(metrics.special_area?.brier) ? metrics.special_area.brier : null,
  );
  metrics.main_brier_skill_score = metrics.brier_skill_score;
  const combinedBaselineBrier = combinedAreaBrier(
    metrics.baseline_brier,
    Number.isFinite(metrics.special_area?.baseline_brier)
      ? metrics.special_area.baseline_brier
      : null,
  );
  metrics.combined_brier_skill_score = brierSkillScore(
    metrics.combined_brier,
    combinedBaselineBrier,
  );
  metrics.brier_skill_score = metrics.combined_brier_skill_score;

  return {
    forecast_id: String(forecast?.id),
    game_name: forecast?.game_name,
    model_name: forecast?.model_name,
    draw_id: String(draw?.draw_id),
    draw_date: draw?.draw_date ?? draw?.date,
    metrics,
    evaluator_version: "lai-v2-post-draw-v1",
  };
}

function mean(values) {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
}

function normalCdf(value) {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * x);
  const erf = sign * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t
    - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x));
  return (1 + erf) / 2;
}

function deterministicInference(values) {
  const average = mean(values);
  if (!Number.isFinite(average) || values.length < 2) {
    return { lower95: null, pValue: null };
  }
  const variance = values.reduce((sum, value) => sum + ((value - average) ** 2), 0) /
    (values.length - 1);
  const standardError = Math.sqrt(Math.max(variance, 0) / values.length);
  if (standardError === 0) {
    return {
      lower95: average,
      pValue: average > 0 ? 0 : 1,
    };
  }
  const z = average / standardError;
  return {
    lower95: average - (1.96 * standardError),
    pValue: Math.max(0, Math.min(1, 1 - normalCdf(z))),
  };
}

function scoreModelName(score) {
  return score?.model_name ?? score?.forecast?.model_name ?? null;
}

function compareScoreDraw(left, right) {
  return String(left?.draw_date || "").localeCompare(String(right?.draw_date || "")) ||
    String(left?.draw_id || "").localeCompare(String(right?.draw_id || ""), undefined, {
      numeric: true,
    });
}

function isThroughDraw(score, throughDraw) {
  if (!throughDraw) return true;
  return compareScoreDraw(score, throughDraw) <= 0;
}

function pairedCandidateSamples(scores, candidateName, baselineName) {
  const baselineByDraw = new Map(scores
    .filter((score) => scoreModelName(score) === baselineName)
    .map((score) => [String(score.draw_id), score]));

  return scores
    .filter((score) => scoreModelName(score) === candidateName)
    .map((candidate) => ({ candidate, baseline: baselineByDraw.get(String(candidate.draw_id)) }))
    .filter(({ candidate, baseline }) => (
      baseline &&
      Number.isFinite(candidate?.metrics?.combined_brier ?? candidate?.metrics?.brier) &&
      Number.isFinite(baseline?.metrics?.combined_brier ?? baseline?.metrics?.brier) &&
      (baseline.metrics.combined_brier ?? baseline.metrics.brier) > 0
    ))
    .sort((left, right) => compareScoreDraw(left.candidate, right.candidate));
}

function metricsForCandidate(samples, candidateModel, picks) {
  const skillValues = samples.map(({ candidate, baseline }) =>
    1 - (
      (candidate.metrics.combined_brier ?? candidate.metrics.brier) /
      (baseline.metrics.combined_brier ?? baseline.metrics.brier)
    ));
  const recent100 = skillValues.slice(-100);
  const recent500 = skillValues.slice(-500);
  const inference = deterministicInference(recent500);
  const coverageDeltas = samples.slice(-500)
    .map(({ candidate, baseline }) => {
      const candidateHits = candidate?.metrics?.coverage?.union_hits;
      const baselineHits = baseline?.metrics?.coverage?.union_hits;
      return Number.isFinite(candidateHits) && Number.isFinite(baselineHits) && picks > 0
        ? (candidateHits - baselineHits) / picks
        : null;
    })
    .filter(Number.isFinite);

  return {
    candidateModel,
    productionSamples: samples.length,
    recent100Skill: mean(recent100),
    recent500Skill: mean(recent500),
    bootstrapLower95: inference.lower95,
    pValue: inference.pValue,
    adjustedQ: null,
    unionCoverageDelta: coverageDeltas.length === samples.slice(-500).length
      ? mean(coverageDeltas)
      : null,
  };
}

function scoreHistoryFromTrainingState(activeState) {
  const recent = activeState?.metrics?.recent_model_scores;
  if (!Array.isArray(recent)) return [];
  return recent.flatMap((entry) => Object.entries(entry?.models || {}).map(([modelName, score]) => ({
    model_name: modelName,
    draw_id: String(entry.draw_id),
    draw_date: entry.draw_date,
    metrics: {
      brier: score?.brier,
      combined_brier: score?.combined_brier ?? score?.brier,
      coverage: null,
    },
  })));
}

export function buildCandidatePromotionDecision({
  scoreHistory = [],
  currentScores = [],
  candidateNames = [],
  baselineName = "uniform",
  picks,
  throughDraw = null,
}) {
  const byModelAndDraw = new Map();
  for (const score of [...scoreHistory, ...currentScores]) {
    const modelName = scoreModelName(score);
    if (!modelName || score?.draw_id == null || !isThroughDraw(score, throughDraw)) continue;
    byModelAndDraw.set(`${modelName}|${score.draw_id}`, { ...score, model_name: modelName });
  }
  const scores = [...byModelAndDraw.values()];
  const names = [...new Set(candidateNames)]
    .filter((name) => typeof name === "string" && name && name !== baselineName)
    .sort();
  const metricsByName = Object.fromEntries(names.map((name) => [
    name,
    metricsForCandidate(pairedCandidateSamples(scores, name, baselineName), name, picks),
  ]));
  const finitePValueNames = names.filter((name) => Number.isFinite(metricsByName[name].pValue));
  const adjusted = benjaminiHochberg(finitePValueNames.map((name) => metricsByName[name].pValue));
  finitePValueNames.forEach((name, index) => {
    metricsByName[name].adjustedQ = adjusted[index];
  });

  const candidates = Object.fromEntries(names.map((name) => {
    const metrics = metricsByName[name];
    return [name, {
      ...metrics,
      promotion: evaluatePromotion(metrics),
    }];
  }));
  const passing = Object.values(candidates)
    .filter((candidate) => candidate.promotion.promoted)
    .sort((left, right) => (
      right.recent500Skill - left.recent500Skill ||
      right.recent100Skill - left.recent100Skill ||
      right.bootstrapLower95 - left.bootstrapLower95 ||
      left.adjustedQ - right.adjustedQ ||
      left.candidateModel.localeCompare(right.candidateModel)
    ));
  const selected = passing[0] ?? null;
  const { promotion: selectedPromotion, ...selectedMetrics } = selected ?? {};

  return {
    candidateModel: selected?.candidateModel ?? null,
    metrics: selected ? selectedMetrics : null,
    promotion: selectedPromotion ?? {
      promoted: false,
      reason: names.some((name) => metricsByName[name].productionSamples > 0)
        ? "no_candidate_passed"
        : "promotion_metrics_unavailable",
    },
    candidates,
  };
}

export function buildNextAgentState({
  activeState,
  scoredForecasts,
  draw,
  promotionDecision = null,
}) {
  if (String(activeState?.last_learned_draw_id) === String(draw?.draw_id)) {
    return { status: "already_learned" };
  }

  const evaluatedDraws = Number(activeState?.metrics?.evaluated_draws || 0) + 1;
  const losses = Object.fromEntries((scoredForecasts || [])
    .map((score) => [score, score?.metrics?.combined_brier ?? score?.metrics?.brier])
    .filter(([score, loss]) => typeof score?.model_name === "string" && Number.isFinite(loss))
    .map(([score, loss]) => [score.model_name, loss]));
  const gamma = Number.isFinite(activeState?.learning_config?.gamma)
    ? activeState.learning_config.gamma
    : 0.1;
  const expertWeights = updateHedgeWeights({
    weights: activeState?.expert_weights,
    losses,
    sampleCount: evaluatedDraws,
    baselineName: "uniform",
    gamma,
  });
  const eligibleNames = new Set(Object.keys(expertWeights));
  const promotedModel = promotionDecision?.candidateModel;
  const promotionMetrics = promotionDecision?.metrics;
  const promotionIsValid = promotionDecision?.promotion?.promoted === true &&
    typeof promotedModel === "string" &&
    eligibleNames.has(promotedModel) &&
    promotionMetrics?.candidateModel === promotedModel;
  const promotion = promotionIsValid
    ? promotionDecision.promotion
    : {
      promoted: false,
      reason: promotionDecision?.promotion?.promoted
        ? "candidate_identity_mismatch"
        : promotionDecision?.promotion?.reason ?? "promotion_metrics_unavailable",
    };

  return {
    game_name: activeState?.game_name,
    state_version: Number(activeState?.state_version) + 1,
    status: promotionIsValid ? "champion" : activeState?.status,
    champion_model: promotionIsValid ? promotedModel : activeState?.champion_model,
    expert_weights: expertWeights,
    learning_config: structuredClone(activeState?.learning_config || {}),
    metrics: {
      ...(activeState?.metrics || {}),
      ...(promotionIsValid ? promotionMetrics : {}),
      evaluated_draws: evaluatedDraws,
      promotion,
      promotion_candidates: promotionDecision?.candidates ?? {},
    },
    last_learned_draw_id: String(draw?.draw_id),
    last_learned_draw_date: draw?.draw_date ?? draw?.date,
  };
}

function compareDrawCheckpoint(activeState, draw) {
  const learnedId = activeState?.last_learned_draw_id;
  const drawId = draw?.draw_id;
  if (learnedId == null || drawId == null) return "new_draw";
  if (String(learnedId) === String(drawId)) return "already_learned";

  const learnedDate = String(activeState?.last_learned_draw_date || "");
  const drawDate = String(draw?.draw_date ?? draw?.date ?? "");
  if (learnedDate && drawDate && learnedDate !== drawDate) {
    return learnedDate > drawDate ? "stale_draw" : "new_draw";
  }

  const learnedNumber = Number(learnedId);
  const drawNumber = Number(drawId);
  if (Number.isFinite(learnedNumber) && Number.isFinite(drawNumber)) {
    return learnedNumber > drawNumber ? "stale_draw" : "new_draw";
  }
  return String(learnedId).localeCompare(String(drawId), undefined, { numeric: true }) > 0
    ? "stale_draw"
    : "new_draw";
}

function scoreRowsWithWeights(scoredForecasts, activeState, nextState) {
  return scoredForecasts.map((score) => {
    const weightBefore = activeState.expert_weights?.[score.model_name];
    const weightAfter = nextState.expert_weights?.[score.model_name];
    return {
      ...score,
      weight_before: Number.isFinite(weightBefore) ? weightBefore : null,
      weight_after: Number.isFinite(weightAfter) ? weightAfter : null,
    };
  });
}

const MAX_AGENT_ACTIVATION_ATTEMPTS = 3;

function stateMatchesExpectedCheckpoint(state, expectedState) {
  return String(state?.game_name) === String(expectedState?.game_name) &&
    Number(state?.state_version) === Number(expectedState?.state_version) &&
    String(state?.last_learned_draw_id) === String(expectedState?.last_learned_draw_id) &&
    String(state?.last_learned_draw_date) === String(expectedState?.last_learned_draw_date);
}

function stateMatchesDrawCheckpoint(state, gameName, draw) {
  return String(state?.game_name) === String(gameName) &&
    String(state?.last_learned_draw_id) === String(draw?.draw_id);
}

async function fetchExactDrawCheckpoint(deps, gameName, draw) {
  if (typeof deps.fetchAgentStateCheckpoint !== "function") return null;
  const checkpoint = await deps.fetchAgentStateCheckpoint(gameName, draw.draw_id);
  return stateMatchesDrawCheckpoint(checkpoint, gameName, draw) ? checkpoint : null;
}

async function claimOrderedAgentLearning(deps, prediction, draw) {
  if (typeof deps.claimAgentLearning !== "function") {
    throw new Error("LAI ordered learning requires claimAgentLearning");
  }
  const claim = await deps.claimAgentLearning({
    game_name: prediction.game_name,
    draw_id: String(draw.draw_id),
    draw_date: draw.draw_date ?? draw.date,
    source_key: prediction.source_key,
  });
  const status = claim?.status;
  if (status === "claimed") {
    if (typeof claim.claim_token !== "string" || !claim.claim_token) {
      throw new Error("LAI ordered learning claim is missing claim_token");
    }
    return claim;
  }
  if (["already_learned", "deferred_earlier_draw", "in_progress", "not_eligible"].includes(status)) {
    return claim;
  }
  throw new Error(`LAI ordered learning returned invalid status: ${String(status)}`);
}

async function recoverStaleAgentLearning(deps, prediction, draw) {
  if (typeof deps.recoverAgentLearningOrder !== "function") {
    throw new Error("LAI stale learning gap requires recoverAgentLearningOrder");
  }
  const recovery = await deps.recoverAgentLearningOrder({
    game_name: prediction.game_name,
    draw_id: String(draw.draw_id),
    draw_date: draw.draw_date ?? draw.date,
  });
  const allowedStatuses = [
    "rewound",
    "already_learned",
    "deferred_earlier_draw",
    "not_needed",
    "not_eligible",
  ];
  if (!allowedStatuses.includes(recovery?.status)) {
    throw new Error(`LAI learning order recovery returned invalid status: ${String(recovery?.status)}`);
  }
  return recovery;
}
export async function runPostDrawLearning({
  prediction,
  draw,
  evaluation,
  config,
  forecastsFallbackExpertNames = [],
  deps,
}) {
  const [forecasts, fetchedActiveState] = await Promise.all([
    deps.fetchForecasts(prediction),
    deps.fetchActiveState(prediction.game_name),
  ]);

  if (!forecasts.length) {
    return { learning_status: "no_forecasts" };
  }

  const scoredForecasts = forecasts.map((forecast) => scoreModelForecast({
    forecast,
    draw,
    config,
  }));
  let activeState = fetchedActiveState ?? createBaselineState({
    gameName: prediction.game_name,
    expertNames: forecastsFallbackExpertNames.length
      ? forecastsFallbackExpertNames
      : forecasts
        .filter((forecast) => forecast.model_name !== "ensemble")
        .map((forecast) => forecast.model_name),
  });

  const initialCheckpointStatus = compareDrawCheckpoint(activeState, draw);
  if (initialCheckpointStatus === "already_learned") {
    await deps.markPredictionEvaluated(prediction.source_key, evaluation);
    return { learning_status: "already_learned" };
  }
  if (initialCheckpointStatus === "stale_draw") {
    const historicalCheckpoint = await fetchExactDrawCheckpoint(
      deps,
      prediction.game_name,
      draw,
    );
    if (historicalCheckpoint) {
      await deps.markPredictionEvaluated(prediction.source_key, evaluation);
      return { learning_status: "already_learned" };
    }

    const recovery = await recoverStaleAgentLearning(deps, prediction, draw);
    if (recovery.status === "already_learned") {
      const recoveredCheckpoint = await fetchExactDrawCheckpoint(
        deps,
        prediction.game_name,
        draw,
      );
      if (!recoveredCheckpoint) {
        throw new Error(`LAI recovery reported learned without checkpoint for ${prediction.game_name} draw ${draw.draw_id}`);
      }
      await deps.markPredictionEvaluated(prediction.source_key, evaluation);
      return { learning_status: "already_learned" };
    }
    if (recovery.status === "deferred_earlier_draw") {
      return {
        learning_status: "deferred_earlier_draw",
        blocking_draw_id: recovery.blocking_draw_id ?? null,
      };
    }
    if (recovery.status !== "rewound") {
      throw new Error(
        `LAI stale learning gap was not recoverable: ${recovery.status} for ${prediction.game_name} draw ${draw.draw_id}`,
      );
    }

    activeState = await deps.fetchActiveState(prediction.game_name) ?? createBaselineState({
      gameName: prediction.game_name,
      expertNames: forecastsFallbackExpertNames.length
        ? forecastsFallbackExpertNames
        : forecasts
          .filter((forecast) => forecast.model_name !== "ensemble")
          .map((forecast) => forecast.model_name),
    });
    const recoveredStatus = compareDrawCheckpoint(activeState, draw);
    if (recoveredStatus === "already_learned") {
      await deps.markPredictionEvaluated(prediction.source_key, evaluation);
      return { learning_status: "already_learned" };
    }
    if (recoveredStatus !== "new_draw") {
      throw new Error(
        `LAI learning order recovery did not rewind before ${prediction.game_name} draw ${draw.draw_id}`,
      );
    }
  }
  const claim = await claimOrderedAgentLearning(deps, prediction, draw);
  if (claim.status === "already_learned") {
    const historicalCheckpoint = await fetchExactDrawCheckpoint(
      deps,
      prediction.game_name,
      draw,
    );
    if (!historicalCheckpoint) {
      throw new Error(`LAI claim reported learned without checkpoint for ${prediction.game_name} draw ${draw.draw_id}`);
    }
    await deps.markPredictionEvaluated(prediction.source_key, evaluation);
    return { learning_status: "already_learned" };
  }
  if (claim.status !== "claimed") {
    return {
      learning_status: claim.status,
      blocking_draw_id: claim.blocking_draw_id ?? null,
    };
  }

  for (let attempt = 1; attempt <= MAX_AGENT_ACTIVATION_ATTEMPTS; attempt += 1) {
    const checkpointStatus = compareDrawCheckpoint(activeState, draw);
    if (checkpointStatus === "already_learned") {
      await deps.markPredictionEvaluated(prediction.source_key, evaluation);
      return { learning_status: "already_learned" };
    }
    if (checkpointStatus === "stale_draw") {
      const historicalCheckpoint = await fetchExactDrawCheckpoint(
        deps,
        prediction.game_name,
        draw,
      );
      if (historicalCheckpoint) {
        await deps.markPredictionEvaluated(prediction.source_key, evaluation);
        return { learning_status: "already_learned" };
      }
      return { learning_status: "deferred_learning_order" };
    }

    const scoreHistory = deps.fetchScoreHistory
      ? await deps.fetchScoreHistory(prediction.game_name, draw)
      : [];
    const promotionDecision = buildCandidatePromotionDecision({
      scoreHistory: [...scoreHistoryFromTrainingState(activeState), ...scoreHistory],
      currentScores: scoredForecasts,
      candidateNames: Object.keys(activeState.expert_weights || {}),
      baselineName: "uniform",
      picks: config?.picks,
      throughDraw: draw,
    });
    const nextState = buildNextAgentState({
      activeState,
      scoredForecasts,
      draw,
      promotionDecision,
    });
    const scoreRows = scoreRowsWithWeights(scoredForecasts, activeState, nextState);
    const claimedNextState = {
      ...nextState,
      learning_claim_token: claim.claim_token,
      prediction_source_key: prediction.source_key,
    };

    await deps.upsertModelScores(scoreRows);
    const activatedState = await deps.activateAgentState(claimedNextState);
    if (stateMatchesExpectedCheckpoint(activatedState, nextState)) {
      const learnedResult = {
        learning_status: "learned",
        score_rows: scoreRows,
        next_state: nextState,
        previous_state: {
          state_version: activeState.state_version,
          status: activeState.status,
          champion_model: activeState.champion_model,
        },
        activation_attempts: attempt,
      };
      const laiEvidence = buildLaiLearningEvidence(learnedResult);
      const enrichedEvaluation = laiEvidence
        ? {
          ...structuredClone(evaluation),
          learning_report: {
            ...(structuredClone(evaluation?.learning_report) || {}),
            lai: laiEvidence,
          },
        }
        : evaluation;
      await deps.markPredictionEvaluated(prediction.source_key, enrichedEvaluation);
      return learnedResult;
    }

    const historicalCheckpoint = await fetchExactDrawCheckpoint(
      deps,
      prediction.game_name,
      draw,
    );
    if (historicalCheckpoint) {
      await deps.markPredictionEvaluated(prediction.source_key, evaluation);
      return {
        learning_status: "already_learned",
        activation_attempts: attempt,
      };
    }

    if (attempt === MAX_AGENT_ACTIVATION_ATTEMPTS) {
      throw new Error(
        `LAI activation checkpoint conflict after ${MAX_AGENT_ACTIVATION_ATTEMPTS} attempts for ${prediction.game_name} draw ${draw.draw_id}`,
      );
    }

    const latestActiveState = await deps.fetchActiveState(prediction.game_name);
    if (!latestActiveState) {
      throw new Error(
        `LAI activation checkpoint conflict could not reload active state for ${prediction.game_name} draw ${draw.draw_id}`,
      );
    }
    activeState = latestActiveState;
  }

  throw new Error(`LAI activation checkpoint retry invariant failed for ${prediction.game_name}`);
}

export function buildLaiLearningEvidence(learningResult) {
  if (learningResult?.learning_status !== "learned" || !learningResult?.next_state) {
    return null;
  }
  const scoreRows = Array.isArray(learningResult.score_rows) ? learningResult.score_rows : [];
  const ensemble = scoreRows.find((row) => row?.model_name === "ensemble") ?? null;
  const weightChanges = scoreRows
    .filter((row) => (
      row?.model_name !== "ensemble" &&
      Number.isFinite(row?.weight_before) &&
      Number.isFinite(row?.weight_after)
    ))
    .map((row) => ({
      model: row.model_name,
      before: row.weight_before,
      after: row.weight_after,
      delta: Number((row.weight_after - row.weight_before).toFixed(12)),
    }));
  const previousChampion = learningResult.previous_state?.champion_model ?? null;
  const nextChampion = learningResult.next_state?.champion_model ?? null;

  return {
    state_version: learningResult.next_state.state_version ?? null,
    agent_status: learningResult.next_state.status ?? null,
    weight_changes: weightChanges,
    champion_changed: previousChampion != null && nextChampion != null
      ? previousChampion !== nextChampion
      : null,
    previous_champion_model: previousChampion,
    champion_model: nextChampion,
    brier_skill_score: Number.isFinite(ensemble?.metrics?.brier_skill_score)
      ? ensemble.metrics.brier_skill_score
      : null,
    coverage: ensemble?.metrics?.coverage
      ? structuredClone(ensemble.metrics.coverage)
      : null,
    limitation: "Single-draw outcomes update quantitative loss only and do not establish causal number patterns.",
  };
}
export function buildAsiLearningRecord(record, draw, evaluation) {
  const prediction = record?.prediction || {};
  const learningReport = evaluation?.learning_report || {};
  const predictedRows = learningReport.predicted_numbers || [];
  const actualRows = learningReport.actual_numbers || [];
  const selected = prediction.number_insights?.selected_numbers || {};

  const selectedReasons = {};
  for (const item of predictedRows) {
    selectedReasons[String(item.number)] =
      item.selection_reason ||
      selected[String(item.number)]?.reason ||
      "no recorded reason";
  }

  return {
    game_name: record.game_name,
    target_draw_date: record.target_draw_date || draw.draw_date || draw.date,
    draw_id: String(draw.draw_id),
    prediction_source_key: record.source_key,
    predicted_numbers: predictedRows.map((item) => item.number),
    actual_numbers: evaluation.actual_numbers || normalizeNumbers(draw.numbers || []),
    matched_numbers: learningReport.summary?.hit_predicted_numbers || [],
    missed_numbers: learningReport.summary?.missed_predicted_numbers || [],
    selected_number_reasons: selectedReasons,
    actual_number_analysis: actualRows,
    strategy_effectiveness: learningReport.strategy_reviews || {},
    next_adjustments: learningReport.next_prediction_guidance || [],
    model_name: prediction.model || null,
    reasoning_source: prediction.reasoning_source || null,
    raw_learning_report: learningReport,
  };
}

function recordTargetDate(record) {
  return record?.target_draw_date ||
    record?.evaluation?.draw_date ||
    record?.predicted_at?.slice(0, 10) ||
    record?.timestamp?.slice(0, 10) ||
    "";
}

function choosePerformanceRecord(current, candidate) {
  if (!current) {
    return candidate;
  }

  const currentTime = new Date(current.predicted_at || current.timestamp || 0).getTime();
  const candidateTime = new Date(candidate.predicted_at || candidate.timestamp || 0).getTime();
  return candidateTime > currentTime ? candidate : current;
}

function latestEvaluatedByTargetDate(records) {
  const byTargetDate = new Map();

  for (const record of records || []) {
    if (!record?.is_evaluated || !record?.evaluation?.strategies || !record?.game_name) {
      continue;
    }

    const targetDate = recordTargetDate(record);
    if (!targetDate) {
      continue;
    }

    const key = `${record.game_name}|${targetDate}`;
    byTargetDate.set(key, choosePerformanceRecord(byTargetDate.get(key), record));
  }

  return [...byTargetDate.values()].sort((left, right) =>
    recordTargetDate(left).localeCompare(recordTargetDate(right)) ||
    String(left.game_name).localeCompare(String(right.game_name)) ||
    new Date(left.predicted_at || left.timestamp || 0).getTime() -
      new Date(right.predicted_at || right.timestamp || 0).getTime()
  );
}

export function buildPerformanceSnapshot(
  records,
  generatedAt = new Date().toISOString(),
  laiByGame = {},
) {
  const performance = {
    last_updated: generatedAt,
    games: {},
  };

  for (const record of latestEvaluatedByTargetDate(records)) {
    const gameName = record.game_name;
    if (!performance.games[gameName]) {
      performance.games[gameName] = {
        total_draws_evaluated: 0,
        strategies: {},
        trend: [],
      };
    }

    const gamePerf = performance.games[gameName];
    gamePerf.total_draws_evaluated += 1;

    const trendData = {
      date: record.evaluation.draw_date || recordTargetDate(record),
      draw_id: String(record.evaluation.draw_id || ""),
      strategies: {},
    };

    for (const [strategy, stats] of Object.entries(record.evaluation.strategies || {})) {
      if (!gamePerf.strategies[strategy]) {
        gamePerf.strategies[strategy] = {
          total_hits: 0,
          total_misses: 0,
        };
      }

      const hits = Number(stats?.hits || 0);
      const predictedCount = record.prediction?.combinations?.[strategy]?.length;
      const missCount = Number.isFinite(Number(stats?.miss_count))
        ? Number(stats.miss_count)
        : Math.max(Number(predictedCount || 0) - hits, 0);

      gamePerf.strategies[strategy].total_hits += hits;
      gamePerf.strategies[strategy].total_misses += missCount;
      trendData.strategies[strategy] = hits;

      const specialPredictedCount = record.prediction?.special_combinations?.[strategy]?.length || 0;
      const hasSpecialStats = specialPredictedCount > 0 ||
        Number.isFinite(Number(stats?.special_hits)) ||
        Number.isFinite(Number(stats?.special_miss_count));

      if (hasSpecialStats) {
        if (!gamePerf.second_area) {
          gamePerf.second_area = {
            label: "第二區",
            total_hits: 0,
            total_misses: 0,
            strategies: {},
          };
        }
        if (!gamePerf.second_area.strategies[strategy]) {
          gamePerf.second_area.strategies[strategy] = {
            total_hits: 0,
            total_misses: 0,
          };
        }
        if (!trendData.second_area) {
          trendData.second_area = { strategies: {} };
        }

        const specialHits = Number(stats?.special_hits || 0);
        const specialMissCount = Number.isFinite(Number(stats?.special_miss_count))
          ? Number(stats.special_miss_count)
          : Math.max(specialPredictedCount - specialHits, 0);

        gamePerf.second_area.total_hits += specialHits;
        gamePerf.second_area.total_misses += specialMissCount;
        gamePerf.second_area.strategies[strategy].total_hits += specialHits;
        gamePerf.second_area.strategies[strategy].total_misses += specialMissCount;
        trendData.second_area.strategies[strategy] = specialHits;
      }
    }

    gamePerf.trend.push(trendData);
  }

  for (const [gameName, gamePerf] of Object.entries(performance.games)) {
    for (const stats of Object.values(gamePerf.strategies)) {
      const total = stats.total_hits + stats.total_misses;
      stats.win_rate = total > 0 ? Number((stats.total_hits / total).toFixed(4)) : 0;
    }
    if (gamePerf.second_area) {
      const total = gamePerf.second_area.total_hits + gamePerf.second_area.total_misses;
      gamePerf.second_area.hit_rate = total > 0 ? Number((gamePerf.second_area.total_hits / total).toFixed(4)) : 0;
      for (const stats of Object.values(gamePerf.second_area.strategies)) {
        const strategyTotal = stats.total_hits + stats.total_misses;
        stats.hit_rate = strategyTotal > 0 ? Number((stats.total_hits / strategyTotal).toFixed(4)) : 0;
      }
    }

    const lai = laiByGame?.[gameName];
    if (lai) {
      const actualNumberCount = Number(lai.actualNumberCount || 0);
      const evaluatedDraws = Number(lai.evaluatedDraws || 0);
      gamePerf.lai = {
        brier_skill_score: lai.latestMetrics?.brier_skill_score ?? null,
        union_coverage_rate: actualNumberCount > 0
          ? Number(lai.unionHits || 0) / actualNumberCount
          : 0,
        average_group_a_hits: evaluatedDraws > 0
          ? Number(lai.groupAHits || 0) / evaluatedDraws
          : 0,
        average_group_b_hits: evaluatedDraws > 0
          ? Number(lai.groupBHits || 0) / evaluatedDraws
          : 0,
        champion_model: lai.latestState?.champion_model ?? null,
        agent_status: lai.latestState?.status ?? null,
      };
    }
  }

  return performance;
}

export function taiwanDateParts(now = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(formatter.formatToParts(now).map((part) => [part.type, part.value]));

  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
  };
}
