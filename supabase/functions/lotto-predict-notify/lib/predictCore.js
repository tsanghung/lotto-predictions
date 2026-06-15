import { createHash } from "node:crypto";

export const GAME_CONFIG = {
  "539": {
    name: "今彩539",
    maxNumber: 39,
    picks: 5,
  },
  "649": {
    name: "大樂透",
    maxNumber: 49,
    picks: 6,
  },
};

const STRATEGY_NAMES = ["激進包牌", "穩健平衡", "統計趨勢"];

export function normalizeNumbers(numbers) {
  return [...numbers].map(Number).sort((a, b) => a - b);
}

function sha1(text) {
  return createHash("sha1").update(text).digest("hex");
}

export function sourceKey(gameName, timestamp) {
  return sha1(`${gameName}|${timestamp}`);
}

export function notificationKey(gameName, targetDate, type = "prediction") {
  return `${type}|${gameName}|${targetDate}`;
}

function dateAdd(dateString, days) {
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function dayOfWeek(dateString) {
  return new Date(`${dateString}T00:00:00Z`).getUTCDay();
}

export function isDrawDate(gameType, dateString) {
  const day = dayOfWeek(dateString);
  if (gameType === "539") {
    return day >= 1 && day <= 6;
  }
  if (gameType === "649") {
    return day === 2 || day === 5;
  }
  return false;
}

export function dueGamesForDate(dateString) {
  return Object.keys(GAME_CONFIG).filter((gameType) => isDrawDate(gameType, dateString));
}

export function predictionTargetDate(gameType, runDate) {
  return isDrawDate(gameType, runDate) ? runDate : null;
}

export function predictionReleaseTime(targetDrawDate) {
  return new Date(`${targetDrawDate}T10:00:00+08:00`);
}

export function notificationSentBeforeRelease(sentAt, targetDrawDate) {
  if (!sentAt || !targetDrawDate) {
    return false;
  }
  return new Date(sentAt).getTime() < predictionReleaseTime(targetDrawDate).getTime();
}

export function nextDrawDate(gameType, fromDate) {
  let date = dateAdd(fromDate, 1);
  while (true) {
    const day = dayOfWeek(date);
    if (gameType === "539" && day >= 1 && day <= 6) {
      return date;
    }
    if (gameType === "649" && (day === 2 || day === 5)) {
      return date;
    }
    date = dateAdd(date, 1);
  }
}

function numberStats(draws, maxNumber) {
  const frequency = new Map();
  const lastSeen = new Map();
  for (let number = 1; number <= maxNumber; number += 1) {
    frequency.set(number, 0);
    lastSeen.set(number, Number.POSITIVE_INFINITY);
  }

  draws.forEach((draw, index) => {
    for (const number of draw.numbers || []) {
      frequency.set(number, (frequency.get(number) || 0) + 1);
      lastSeen.set(number, draws.length - index);
    }
  });

  return Array.from({ length: maxNumber }, (_, index) => {
    const number = index + 1;
    return {
      number,
      frequency: frequency.get(number) || 0,
      lastSeen: lastSeen.get(number) || Number.POSITIVE_INFINITY,
    };
  });
}

function recentPeriodFor(gameType, drawCount) {
  const target = gameType === "649" ? 100 : 300;
  return Math.min(target, drawCount);
}

function frequencyCounts(draws, maxNumber) {
  const counts = new Map();
  for (let number = 1; number <= maxNumber; number += 1) {
    counts.set(number, 0);
  }
  for (const draw of draws) {
    for (const number of draw.numbers || []) {
      counts.set(number, (counts.get(number) || 0) + 1);
    }
  }
  return counts;
}

function rankCounts(counts, direction = "desc") {
  return [...counts.entries()]
    .map(([number, count]) => ({ number, count }))
    .sort((left, right) =>
      direction === "desc"
        ? right.count - left.count || left.number - right.number
        : left.count - right.count || left.number - right.number
    );
}

function missingValues(draws, maxNumber) {
  const missing = new Map();
  for (let number = 1; number <= maxNumber; number += 1) {
    missing.set(number, draws.length);
  }
  for (let index = draws.length - 1; index >= 0; index -= 1) {
    for (const number of draws[index].numbers || []) {
      if (missing.get(number) === draws.length) {
        missing.set(number, draws.length - 1 - index);
      }
    }
  }
  return missing;
}

function averageIntervals(draws, maxNumber) {
  const indexes = new Map();
  for (let number = 1; number <= maxNumber; number += 1) {
    indexes.set(number, []);
  }
  draws.forEach((draw, index) => {
    for (const number of draw.numbers || []) {
      indexes.get(number)?.push(index);
    }
  });

  const averages = new Map();
  for (let number = 1; number <= maxNumber; number += 1) {
    const seen = indexes.get(number) || [];
    if (seen.length < 2) {
      averages.set(number, seen.length === 1 ? draws.length / 1 : draws.length || 1);
      continue;
    }
    let totalGap = 0;
    for (let i = 1; i < seen.length; i += 1) {
      totalGap += seen[i] - seen[i - 1];
    }
    averages.set(number, totalGap / (seen.length - 1));
  }
  return averages;
}

function daysBetween(leftDate, rightDate) {
  if (!leftDate || !rightDate) {
    return null;
  }
  const left = new Date(`${leftDate}T00:00:00Z`);
  const right = new Date(`${rightDate}T00:00:00Z`);
  if (Number.isNaN(left.getTime()) || Number.isNaN(right.getTime())) {
    return null;
  }
  return Math.max(0, Math.round((right.getTime() - left.getTime()) / 86400000));
}

function overdueRanks(draws, maxNumber) {
  const missing = missingValues(draws, maxNumber);
  const intervals = averageIntervals(draws, maxNumber);
  return Array.from({ length: maxNumber }, (_, index) => {
    const number = index + 1;
    const gap = missing.get(number) || 0;
    const avg = intervals.get(number) || 1;
    return {
      number,
      gap,
      average_interval: Number(avg.toFixed(1)),
      index: Number((gap / avg).toFixed(2)),
    };
  }).sort((left, right) =>
    right.index - left.index ||
    right.gap - left.gap ||
    left.number - right.number
  );
}

function pairFrequencies(draws, topK = 10) {
  const pairs = new Map();
  for (const draw of draws) {
    const numbers = normalizeNumbers(draw.numbers || []);
    for (let i = 0; i < numbers.length; i += 1) {
      for (let j = i + 1; j < numbers.length; j += 1) {
        const key = `${numbers[i]}-${numbers[j]}`;
        pairs.set(key, (pairs.get(key) || 0) + 1);
      }
    }
  }
  return [...pairs.entries()]
    .map(([key, count]) => ({ pair: key.split("-").map(Number), count }))
    .sort((left, right) =>
      right.count - left.count ||
      left.pair[0] - right.pair[0] ||
      left.pair[1] - right.pair[1]
    )
    .slice(0, topK);
}

function sumStats(draws) {
  if (!draws.length) {
    return {
      period_count: 0,
      average: 0,
      min: 0,
      max: 0,
      band_minus_10pct: 0,
      band_plus_10pct: 0,
      band_minus_20pct: 0,
      band_plus_20pct: 0,
    };
  }
  const sums = draws.map((draw) => (draw.numbers || []).reduce((sum, number) => sum + number, 0));
  const average = sums.reduce((sum, value) => sum + value, 0) / sums.length;
  return {
    period_count: draws.length,
    average: Number(average.toFixed(1)),
    min: Math.min(...sums),
    max: Math.max(...sums),
    band_minus_10pct: Number((average * 0.9).toFixed(1)),
    band_plus_10pct: Number((average * 1.1).toFixed(1)),
    band_minus_20pct: Number((average * 0.8).toFixed(1)),
    band_plus_20pct: Number((average * 1.2).toFixed(1)),
  };
}

function oddEvenStats(draws) {
  if (!draws.length) {
    return { period_count: 0, avg_odd_per_draw: 0, avg_even_per_draw: 0, aggregate_odd_even_ratio: "0:0" };
  }
  let odd = 0;
  let even = 0;
  for (const draw of draws) {
    for (const number of draw.numbers || []) {
      if (number % 2 === 0) {
        even += 1;
      } else {
        odd += 1;
      }
    }
  }
  return {
    period_count: draws.length,
    avg_odd_per_draw: Number((odd / draws.length).toFixed(2)),
    avg_even_per_draw: Number((even / draws.length).toFixed(2)),
    aggregate_odd_even_ratio: `${odd}:${even}`,
  };
}

function largeSmallStats(draws, maxNumber) {
  if (!draws.length) {
    return { period_count: 0, avg_large_per_draw: 0, avg_small_per_draw: 0, aggregate_large_small_ratio: "0:0" };
  }
  const midpoint = Math.ceil(maxNumber / 2);
  let small = 0;
  let large = 0;
  for (const draw of draws) {
    for (const number of draw.numbers || []) {
      if (number > midpoint) {
        large += 1;
      } else {
        small += 1;
      }
    }
  }
  return {
    period_count: draws.length,
    avg_large_per_draw: Number((large / draws.length).toFixed(2)),
    avg_small_per_draw: Number((small / draws.length).toFixed(2)),
    aggregate_large_small_ratio: `${large}:${small}`,
  };
}

function buildSelectedNumberInsights({ combinations, draws, recentDraws, config, recentPeriods, aiCandidates = [] }) {
  const picked = normalizeNumbers(
    [...new Set(Object.values(combinations || {}).flatMap((numbers) => numbers || []).map(Number))]
  );
  if (!picked.length || !draws.length) {
    return {};
  }

  const recentCounts = frequencyCounts(recentDraws, config.maxNumber);
  const allCounts = frequencyCounts(draws, config.maxNumber);
  const missing = missingValues(draws, config.maxNumber);
  const intervals = averageIntervals(draws, config.maxNumber);
  const latestDate = draws.at(-1)?.draw_date;
  const firstDate = draws[0]?.draw_date;
  const historyDays = daysBetween(firstDate, latestDate);
  const averageDaysPerDraw = historyDays && draws.length > 1 ? historyDays / (draws.length - 1) : null;
  const avgRecent = recentPeriods * config.picks / config.maxNumber;
  const aiByNumber = new Map(aiCandidates.map((item) => [item.number, item]));

  const lastSeenDateByNumber = new Map();
  for (let index = draws.length - 1; index >= 0; index -= 1) {
    for (const number of draws[index].numbers || []) {
      if (!lastSeenDateByNumber.has(number)) {
        lastSeenDateByNumber.set(number, draws[index].draw_date);
      }
    }
  }

  return Object.fromEntries(picked.map((number) => {
    const gapDraws = missing.get(number) || 0;
    const avgIntervalDraws = intervals.get(number) || 1;
    const overdueIndex = Number((gapDraws / avgIntervalDraws).toFixed(2));
    const recentFreq = recentCounts.get(number) || 0;
    const appearances = allCounts.get(number) || 0;
    const lastSeenDate = lastSeenDateByNumber.get(number) || null;
    const gapDays = daysBetween(lastSeenDate, latestDate);
    const avgIntervalDays = averageDaysPerDraw
      ? Number((avgIntervalDraws * averageDaysPerDraw).toFixed(1))
      : null;
    const aiSignal = aiByNumber.get(number);

    let tag = "balanced";
    let reason = "";
    if (overdueIndex >= 1.5 && gapDraws > 0) {
      tag = "overdue";
      const daysText = gapDays === null ? `${gapDraws} 期` : `${gapDays} 天（${gapDraws} 期未開）`;
      const avgText = avgIntervalDays ? `${avgIntervalDays.toFixed(0)} 天` : `${avgIntervalDraws.toFixed(1)} 期`;
      reason = `久未開出：已隔 ${daysText}，約為自身平均週期 ${avgText} 的 ${overdueIndex.toFixed(1)} 倍，具冷門反彈觀察價值`;
    } else if (recentFreq >= avgRecent * 1.3) {
      tag = "hot";
      reason = `近期熱門：近 ${recentPeriods} 期開出 ${recentFreq} 次，高於理論平均約 ${avgRecent.toFixed(1)} 次；史上累計 ${appearances} 次`;
    } else if (gapDraws <= 1) {
      tag = "fresh";
      reason = gapDays === null || gapDays === 0
        ? "剛開出：上一期才出現，短期節奏仍在觀察範圍"
        : `剛開出：${gapDays} 天前才出現，短期節奏仍在觀察範圍`;
    } else {
      const gapText = gapDays === null ? `已隔 ${gapDraws} 期` : `已隔 ${gapDays} 天`;
      const avgText = avgIntervalDays ? `，貼近平均 ${avgIntervalDays.toFixed(0)} 天` : "";
      reason = `週期穩定：${gapText}${avgText}，近 ${recentPeriods} 期開出 ${recentFreq} 次，作為結構平衡補位`;
    }

    if (aiSignal?.statistics_reason) {
      reason += `；Gemini 量化訊號：${aiSignal.statistics_reason}`;
    }
    if (aiSignal?.metaphysics_signal) {
      reason += `；玄學輔助：${aiSignal.metaphysics_signal}`;
    }

    return [String(number), {
      reason,
      tag,
      gap_days: gapDays,
      gap_draws: gapDraws,
      avg_interval_draws: Number(avgIntervalDraws.toFixed(1)),
      avg_interval_days: avgIntervalDays,
      overdue_index: overdueIndex,
      recent_freq: recentFreq,
      appearances,
      ai_score: aiSignal?.score ?? null,
      ai_statistics_reason: aiSignal?.statistics_reason || "",
      metaphysics_signal: aiSignal?.metaphysics_signal || "",
    }];
  }));
}

function trendWindow(draws, config, period) {
  const sample = draws.slice(-period);
  const counts = frequencyCounts(sample, config.maxNumber);
  return {
    period_count: sample.length,
    hot: rankCounts(counts, "desc").slice(0, 10),
    cold_by_frequency: rankCounts(counts, "asc").slice(0, 10),
    overdue: overdueRanks(sample, config.maxNumber).slice(0, 10),
    sum: sumStats(sample),
    odd_even: oddEvenStats(sample),
    large_small: largeSmallStats(sample, config.maxNumber),
    top_pairs: pairFrequencies(sample, 10),
  };
}

function fullHistoryRows(draws) {
  return draws.map((draw) => ({
    draw_id: String(draw.draw_id),
    draw_date: String(draw.draw_date),
    numbers: normalizeNumbers(draw.numbers || []),
    special_number: draw.special_number ?? null,
  }));
}

export function buildGeminiDecisionPayload({ gameType, draws, generatedAt }) {
  const config = GAME_CONFIG[gameType];
  if (!config) {
    throw new Error(`Unsupported game type: ${gameType}`);
  }
  if (!Array.isArray(draws) || draws.length < 3) {
    throw new Error(`${config.name} requires at least 3 historical draws`);
  }

  const allCounts = frequencyCounts(draws, config.maxNumber);
  const recentPeriods = recentPeriodFor(gameType, draws.length);
  const windows = [...new Set([Math.min(draws.length, 30), Math.min(draws.length, 50), Math.min(draws.length, 100), Math.min(draws.length, 300), recentPeriods])]
    .filter((period) => period > 0)
    .sort((left, right) => left - right);

  return {
    game_type: gameType,
    game_name: config.name,
    generated_at: generatedAt,
    number_range: { min: 1, max: config.maxNumber, picks: config.picks },
    full_history: fullHistoryRows(draws),
    quantitative_features: {
      methodology: "statistical frequency, recency gaps, average intervals, co-occurrence pairs, sum distribution, odd-even distribution, large-small distribution, verifier and rolling backtest; metaphysical signals are entertainment-only and capped at 10 percent.",
      full_history_sample_size: draws.length,
      first_draw_date: draws[0]?.draw_date,
      latest_draw_id: draws.at(-1)?.draw_id,
      latest_draw_date: draws.at(-1)?.draw_date,
      all_time_hot: rankCounts(allCounts, "desc").slice(0, 15),
      all_time_cold: rankCounts(allCounts, "asc").slice(0, 15),
      all_time_overdue: overdueRanks(draws, config.maxNumber).slice(0, 15),
      all_time_sum: sumStats(draws),
      all_time_odd_even: oddEvenStats(draws),
      all_time_large_small: largeSmallStats(draws, config.maxNumber),
      trend_windows: Object.fromEntries(windows.map((period) => [String(period), trendWindow(draws, config, period)])),
      metaphysics_framework: {
        label: "entertainment_only",
        max_weight: 0.1,
        allowed_signals: ["draw_date_digit_sum", "weekday_rhythm", "tail_number_rhythm", "recent_counterintuitive_pattern"],
        rule: "玄學因子只能作為 5% 到 10% 的輔助排序，不可覆蓋統計與機率訊號。",
      },
    },
  };
}

function uniqueTake(candidates, count, maxNumber) {
  const values = [];
  for (const candidate of candidates) {
    if (candidate >= 1 && candidate <= maxNumber && !values.includes(candidate)) {
      values.push(candidate);
    }
    if (values.length === count) {
      return normalizeNumbers(values);
    }
  }

  for (let number = 1; number <= maxNumber && values.length < count; number += 1) {
    if (!values.includes(number)) {
      values.push(number);
    }
  }

  return normalizeNumbers(values);
}

function overlapCount(left, right) {
  const rightSet = new Set(right);
  return left.filter((number) => rightSet.has(number)).length;
}

function diversifyAgainstPrior(combination, candidates, priorCombinations, config) {
  let diversified = normalizeNumbers(combination);
  const maxOverlap = Math.max(0, config.picks - 2);
  let candidateIndex = 0;

  for (const prior of priorCombinations) {
    let guard = 0;
    while (overlapCount(diversified, prior) > maxOverlap && guard < config.maxNumber) {
      guard += 1;
      const replacement = candidates.slice(candidateIndex).find((number) =>
        Number.isInteger(number) &&
        number >= 1 &&
        number <= config.maxNumber &&
        !diversified.includes(number) &&
        !prior.includes(number)
      );
      if (!replacement) {
        break;
      }
      candidateIndex = candidates.indexOf(replacement) + 1;

      const removable = [...diversified]
        .reverse()
        .find((number) => prior.includes(number));
      if (removable === undefined) {
        break;
      }

      diversified = normalizeNumbers(
        diversified.map((number) => number === removable ? replacement : number)
      );
    }
  }

  return diversified;
}

function averageSum(draws) {
  if (!draws.length) {
    return 0;
  }
  return Math.round(draws.reduce((sum, draw) => sum + (draw.numbers || []).reduce((a, b) => a + b, 0), 0) / draws.length);
}

function balancedCandidates(stats, averageTarget) {
  return [...stats].sort((left, right) => {
    const leftCenter = Math.abs(left.number - averageTarget);
    const rightCenter = Math.abs(right.number - averageTarget);
    if (leftCenter !== rightCenter) {
      return leftCenter - rightCenter;
    }
    if (right.frequency !== left.frequency) {
      return right.frequency - left.frequency;
    }
    return left.number - right.number;
  }).map((item) => item.number);
}

function asNumberArray(value) {
  return Array.isArray(value)
    ? value.map(Number).filter((number) => Number.isInteger(number))
    : [];
}

function sanitizeCandidatePool(decision, maxNumber) {
  const pool = Array.isArray(decision?.candidate_pool) ? decision.candidate_pool : [];
  return pool
    .map((item) => ({
      number: Number(item?.number),
      score: Number.isFinite(Number(item?.score)) ? Number(item.score) : 0,
      statistics_reason: typeof item?.statistics_reason === "string" ? item.statistics_reason : "",
      metaphysics_signal: typeof item?.metaphysics_signal === "string" ? item.metaphysics_signal : "",
    }))
    .filter((item) => Number.isInteger(item.number) && item.number >= 1 && item.number <= maxNumber)
    .sort((left, right) => right.score - left.score || left.number - right.number);
}

function verifyCombinations(combinations, config) {
  const errors = [];
  for (const [strategy, numbers] of Object.entries(combinations)) {
    if (!Array.isArray(numbers)) {
      errors.push(`${strategy} is not an array`);
      continue;
    }
    if (numbers.length !== config.picks) {
      errors.push(`${strategy} has ${numbers.length} numbers, expected ${config.picks}`);
    }
    if (new Set(numbers).size !== numbers.length) {
      errors.push(`${strategy} contains duplicate numbers`);
    }
    if (numbers.some((number) => !Number.isInteger(number) || number < 1 || number > config.maxNumber)) {
      errors.push(`${strategy} contains out-of-range numbers`);
    }
    const sorted = normalizeNumbers(numbers);
    if (JSON.stringify(sorted) !== JSON.stringify(numbers)) {
      errors.push(`${strategy} is not sorted`);
    }
  }
  const entries = Object.entries(combinations).filter(([, numbers]) => Array.isArray(numbers));
  const maxOverlap = Math.max(0, config.picks - 2);
  for (let leftIndex = 0; leftIndex < entries.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex += 1) {
      const [leftStrategy, leftNumbers] = entries[leftIndex];
      const [rightStrategy, rightNumbers] = entries[rightIndex];
      const overlap = overlapCount(leftNumbers, rightNumbers);
      if (overlap > maxOverlap) {
        errors.push(`${leftStrategy} and ${rightStrategy} overlap ${overlap} numbers, max ${maxOverlap}`);
      }
    }
  }
  return {
    valid: errors.length === 0,
    errors,
    checked_at: new Date().toISOString(),
  };
}

export function backtestCombinations({ combinations, draws, maxWindow = 50 }) {
  const sample = draws.slice(-Math.min(maxWindow, draws.length));
  const strategies = {};
  for (const [strategy, numbers] of Object.entries(combinations)) {
    const picks = new Set(numbers);
    const hitCounts = sample.map((draw) => (draw.numbers || []).filter((number) => picks.has(number)).length);
    const hitDistribution = {};
    for (const hits of hitCounts) {
      hitDistribution[String(hits)] = (hitDistribution[String(hits)] || 0) + 1;
    }
    const totalHits = hitCounts.reduce((sum, hits) => sum + hits, 0);
    strategies[strategy] = {
      best_hits: hitCounts.length ? Math.max(...hitCounts) : 0,
      average_hits: hitCounts.length ? Number((totalHits / hitCounts.length).toFixed(2)) : 0,
      hit_distribution: hitDistribution,
    };
  }
  return {
    window_size: sample.length,
    strategies,
  };
}

export function applyGeminiQuantDecision({ baseRecord, decision, payload, draws }) {
  const gameType = payload?.game_type;
  const config = GAME_CONFIG[gameType];
  if (!config) {
    throw new Error(`Unsupported game type: ${gameType}`);
  }

  const prediction = baseRecord.prediction || {};
  const insights = prediction.number_insights || {};
  const sanitizedAiCandidates = sanitizeCandidatePool(decision, config.maxNumber);
  const aiPool = sanitizedAiCandidates.map((item) => item.number);
  const allTimeHot = (payload.quantitative_features?.all_time_hot || []).map((item) => item.number);
  const allTimeOverdue = (payload.quantitative_features?.all_time_overdue || []).map((item) => item.number);
  const recentHot = (insights.recent_hot || []).map((item) => item.number);
  const recentCold = (insights.recent_cold || []).map((item) => item.number);
  const baseline = prediction.combinations || {};
  const strategyWeights = decision?.strategy_weights || {};

  const combinations = {};
  for (const strategy of STRATEGY_NAMES) {
    const strategyDecision = strategyWeights[strategy] || {};
    const prefer = asNumberArray(strategyDecision.prefer);
    const avoid = new Set(asNumberArray(strategyDecision.avoid));
    const candidates = [
      ...prefer,
      ...aiPool,
      ...(baseline[strategy] || []),
      ...allTimeOverdue,
      ...recentCold,
      ...recentHot,
      ...allTimeHot,
    ].filter((number) => !avoid.has(number));
    combinations[strategy] = diversifyAgainstPrior(
      uniqueTake(candidates, config.picks, config.maxNumber),
      candidates,
      Object.values(combinations),
      config,
    );
  }

  const verification = verifyCombinations(combinations, config);
  const backtest = backtestCombinations({
    combinations,
    draws,
    maxWindow: Math.min(100, Math.max(10, Math.floor(draws.length / 4))),
  });
  const recentPeriods = recentPeriodFor(gameType, draws.length);
  const selectedNumberInsights = buildSelectedNumberInsights({
    combinations,
    draws,
    recentDraws: draws.slice(-recentPeriods),
    config,
    recentPeriods,
    aiCandidates: sanitizedAiCandidates,
  });

  return {
    ...baseRecord,
    prediction: {
      ...prediction,
      model: "gemini-quant-v2",
      engine: "gemini-quant-v2",
      reasoning: typeof decision?.reasoning === "string" && decision.reasoning.trim()
        ? decision.reasoning.trim()
        : prediction.reasoning,
      risk_warning: typeof decision?.risk_warning === "string" && decision.risk_warning.trim()
        ? decision.risk_warning.trim()
        : prediction.risk_warning,
      reasoning_source: "gemini_quantitative",
      combinations,
      number_insights: {
        ...insights,
        ...selectedNumberInsights,
        selected_numbers: selectedNumberInsights,
        full_history_sample_size: payload.quantitative_features?.full_history_sample_size,
        ai_strategy_weights: strategyWeights,
      },
      ai_decision: {
        strategy_weights: strategyWeights,
        candidate_pool: sanitizedAiCandidates.slice(0, 20),
      },
      metaphysics_note: typeof decision?.metaphysics_note === "string"
        ? decision.metaphysics_note.trim()
        : "玄學因子僅作娛樂輔助，不視為科學證據。",
      verification,
      backtest,
    },
  };
}

function formatNumberCount(items, suffix, limit = 3) {
  return items.slice(0, limit).map((item) => `${item.number}(${item.count}${suffix})`).join("、");
}

function formatOverdue(items, limit = 3) {
  return items.slice(0, limit).map((item) => `${item.number}(${item.index.toFixed(2)}，遺漏${item.gap}期)`).join("、");
}

function formatPairs(items, limit = 2) {
  return items.slice(0, limit).map((item) => `[${item.pair.join(", ")}](${item.count}次)`).join("、");
}

function buildInsightPayload({ gameType, draws, recentDraws, config }) {
  const recentCounts = frequencyCounts(recentDraws, config.maxNumber);
  const allCounts = frequencyCounts(draws, config.maxNumber);
  const recentHot = rankCounts(recentCounts, "desc").slice(0, 10);
  const allTimeHot = rankCounts(allCounts, "desc").slice(0, 10);
  const overdue = overdueRanks(draws, config.maxNumber);
  const pairs = pairFrequencies(recentDraws, 10);
  const recentPeriod = recentPeriodFor(gameType, draws.length);
  const averageTarget = Math.max(1, Math.round(averageSum(recentDraws) / config.picks));

  return {
    recent_periods: recentPeriod,
    latest_draw_id: draws.at(-1)?.draw_id,
    latest_draw_date: draws.at(-1)?.draw_date,
    sample_size: recentDraws.length,
    average_sum: averageSum(recentDraws),
    average_number: averageTarget,
    recent_hot: recentHot,
    recent_cold: overdue.slice(0, 10),
    all_time_hot: allTimeHot,
    top_overdue: overdue.slice(0, 8),
    top_pairs: pairs,
  };
}

function buildReasoning(insights, combinations) {
  const hotText = formatNumberCount(insights.recent_hot, "次");
  const coldText = insights.recent_cold.slice(0, 3).map((item) => `${item.number}(遺漏${item.gap}期)`).join("、");
  const overdueText = formatOverdue(insights.top_overdue, 2);
  const allTimeText = formatNumberCount(insights.all_time_hot, "次", 2);
  const trendText = formatNumberCount(insights.recent_hot, "次", 2);
  const pairText = formatPairs(insights.top_pairs, 2) || "本期樣本未形成明顯同開號碼對";
  const aggressive = (combinations["激進包牌"] || []).slice(0, 3).join("、");
  const balanced = (combinations["穩健平衡"] || []).slice(0, 3).join("、");
  const trend = (combinations["統計趨勢"] || []).slice(0, 3).join("、");

  return (
    `近 ${insights.recent_periods} 期數據顯示最熱號碼為 ${hotText}，而最冷號碼為 ${coldText}。` +
    `【激進包牌】策略鎖定即將開出指數最高之 ${overdueText}，並納入 ${aggressive} 以搏冷門反彈。` +
    `【穩健平衡】策略採取冷熱與和值中位分布，參考史上熱門 ${allTimeText} 與均值區間，選入 ${balanced} 維持結構平衡。` +
    `【統計趨勢】策略順勢採用近 ${insights.recent_periods} 期高頻號碼 ${trendText}，並引用強同開號碼對 ${pairText}，選入 ${trend} 補強。`
  );
}

export function generatePrediction({ gameType, draws, generatedAt }) {
  const config = GAME_CONFIG[gameType];
  if (!config) {
    throw new Error(`Unsupported game type: ${gameType}`);
  }
  if (!Array.isArray(draws) || draws.length < 3) {
    throw new Error(`${config.name} requires at least 3 historical draws`);
  }

  const recentPeriods = recentPeriodFor(gameType, draws.length);
  const recentDraws = draws.slice(-recentPeriods);
  const stats = numberStats(recentDraws, config.maxNumber);
  const insights = buildInsightPayload({ gameType, draws, recentDraws, config });
  const hot = [...stats].sort((left, right) =>
    right.frequency - left.frequency ||
    left.lastSeen - right.lastSeen ||
    left.number - right.number
  ).map((item) => item.number);
  const cold = [...stats].sort((left, right) =>
    right.lastSeen - left.lastSeen ||
    left.frequency - right.frequency ||
    left.number - right.number
  ).map((item) => item.number);
  const averageTarget = Math.max(1, Math.round(averageSum(recentDraws) / config.picks));
  const overdue = insights.top_overdue.map((item) => item.number);
  const pairNumbers = insights.top_pairs.flatMap((item) => item.pair);
  const allTimeHot = insights.all_time_hot.map((item) => item.number);

  const combinations = {
    "激進包牌": uniqueTake([...overdue, ...cold], config.picks, config.maxNumber),
    "穩健平衡": uniqueTake(balancedCandidates(stats, averageTarget), config.picks, config.maxNumber),
    "統計趨勢": uniqueTake([...hot, ...pairNumbers, ...allTimeHot], config.picks, config.maxNumber),
  };
  const reasoning = buildReasoning(insights, combinations);
  const selectedNumberInsights = buildSelectedNumberInsights({
    combinations,
    draws,
    recentDraws,
    config,
    recentPeriods,
  });

  return {
    timestamp: generatedAt,
    game_name: config.name,
    is_offline: false,
    prediction: {
      model: "supabase-statistical-v1",
      reasoning,
      risk_warning: "樂透屬隨機事件，統計洞察僅供輔助參考，請理性投注。",
      combinations,
      number_insights: {
        ...insights,
        ...selectedNumberInsights,
        selected_numbers: selectedNumberInsights,
      },
    },
    is_evaluated: false,
    evaluation: {
      draw_id: null,
      actual_numbers: [],
      strategies: {},
      attribution_report: null,
    },
  };
}

export function buildLineMessage(record, targetDate) {
  const combinations = record.prediction?.combinations || {};
  const insights = record.prediction?.number_insights || {};
  const hotText = Array.isArray(insights.recent_hot) ? formatNumberCount(insights.recent_hot, "次", 5) : "";
  const coldText = Array.isArray(insights.recent_cold)
    ? insights.recent_cold.slice(0, 5).map((item) => `${item.number}(遺漏${item.gap}期)`).join("、")
    : "";
  const overdueText = Array.isArray(insights.top_overdue) ? formatOverdue(insights.top_overdue, 5) : "";
  const pairText = Array.isArray(insights.top_pairs) ? formatPairs(insights.top_pairs, 5) : "";
  let message = `AI 樂透預測\n\n`;
  message += `日期：${targetDate}\n`;
  message += `彩種：${record.game_name}\n`;
  message += `------------------\n`;
  message += `統計洞察：\n`;
  if (insights.recent_periods) {
    message += `近 ${insights.recent_periods} 期最熱：${hotText}\n`;
    message += `近 ${insights.recent_periods} 期最冷：${coldText}\n`;
  }
  message += `即將開出指數：${overdueText}\n`;
  message += `同開號碼對：${pairText || "樣本未形成明顯同開號碼對"}\n`;
  message += `------------------\n`;
  message += `分析預測：\n${record.prediction?.reasoning || "統計模型產生推薦組合。"}\n`;
  if (record.prediction?.verification || record.prediction?.backtest) {
    const verificationText = record.prediction.verification?.valid ? "通過" : "未通過";
    const backtest = record.prediction.backtest;
    const bestHits = backtest?.strategies
      ? Math.max(...Object.values(backtest.strategies).map((item) => item.best_hits || 0))
      : 0;
    message += `系統驗證：${verificationText}；回測視窗：近 ${backtest?.window_size || 0} 期，最高命中 ${bestHits} 顆。\n`;
  }
  if (record.prediction?.metaphysics_note) {
    message += `玄學輔助：${record.prediction.metaphysics_note}\n`;
  }
  message += `------------------\n`;
  message += `推薦組合：\n`;

  for (const [strategy, numbers] of Object.entries(combinations)) {
    const numberText = numbers.map((number) => String(number).padStart(2, "0")).join(", ");
    message += `[${strategy}]\n${numberText}\n\n`;
  }

  message += `------------------\n`;
  message += `提醒：樂透屬隨機事件，請理性投注。`;
  return message;
}
