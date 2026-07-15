import { createHash } from "node:crypto";
// LSTM 權重（離線訓練，見 scripts/export_lstm_weights.py）。部署時 mlWeights.js 必須
// 與本檔一起上傳（建議用 supabase functions deploy CLI，逐字節正確）。某彩種無權重時，
// lstmScores 會回傳 null，融合自動退回「統計啟發 + 馬可夫」。
import { createBaselineState } from "./agentState.js";
import { aggregateForecasts } from "./ensemble.js";
import { buildExpertForecasts } from "./experts.js";
import { GAME_CONFIG } from "./gameConfig.js";
import { optimizePowerGroups, optimizeTwoGroups } from "./optimizer.js";
import { normalizeProbabilityVector } from "./scoring.js";

export { GAME_CONFIG } from "./gameConfig.js";
const POWER_SPECIAL_FALLBACK = "deterministic_uniform_no_active_expert";

const STRATEGY_NAMES = ["激進包牌", "穩健平衡", "統計趨勢"];

export function normalizeNumbers(numbers) {
  return [...numbers].map(Number).sort((a, b) => a - b);
}

function sha1(text) {
  return createHash("sha1").update(text).digest("hex");
}

function cloneJsonReady(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
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
  if (gameType === "power") {
    return day === 1 || day === 4;
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
    if (gameType === "power" && (day === 1 || day === 4)) {
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
  // 誠實版：三個彩種一律以「全歷史」資料做分析（不再 539 用近 300、大樂透/威力彩用近 100）。
  return drawCount;
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

function specialNumberDraws(draws, maxNumber) {
  return draws
    .map((draw) => {
      const number = Number(draw.special_number);
      return Number.isInteger(number) && number >= 1 && number <= maxNumber
        ? { ...draw, numbers: [number] }
        : null;
    })
    .filter(Boolean);
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
      reason = `歷史熱門：全歷史 ${recentPeriods} 期累計開出 ${recentFreq} 次，高於理論平均約 ${avgRecent.toFixed(1)} 次`;
    } else if (gapDraws <= 1) {
      tag = "fresh";
      reason = gapDays === null || gapDays === 0
        ? "剛開出：上一期才出現，短期節奏仍在觀察範圍"
        : `剛開出：${gapDays} 天前才出現，短期節奏仍在觀察範圍`;
    } else {
      const gapText = gapDays === null ? `已隔 ${gapDraws} 期` : `已隔 ${gapDays} 天`;
      const avgText = avgIntervalDays ? `，貼近平均 ${avgIntervalDays.toFixed(0)} 天` : "";
      reason = `週期穩定：${gapText}${avgText}，全歷史 ${recentPeriods} 期累計開出 ${recentFreq} 次，作為結構平衡補位`;
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

export function buildAsiLearningContext(records = [], limit = 5) {
  return records
    .filter((record) => record && record.target_draw_date)
    .slice(0, limit)
    .map((record) => {
      const strategyEntries = Object.entries(record.strategy_effectiveness || {});
      return {
        game_name: record.game_name || null,
        target_draw_date: record.target_draw_date,
        matched_numbers: normalizeNumbers(record.matched_numbers || []),
        missed_numbers: normalizeNumbers(record.missed_numbers || []),
        reasoning_source: record.reasoning_source || "unknown",
        model_name: record.model_name || null,
        lessons: (record.next_adjustments || []).filter(Boolean),
        strategy_notes: strategyEntries.map(([strategy, review]) => {
          const hits = review?.hits ?? review?.hit_count ?? "unknown";
          const analysis = review?.analysis || review?.learning_note || "no analysis";
          return `${strategy}: hits=${hits}; ${analysis}`;
        }),
      };
    });
}

/**
 * @param {{
 *   gameType: string,
 *   draws: Array<Record<string, unknown>>,
 *   generatedAt: string,
 *   learningRecords?: Array<Record<string, unknown>>,
 * }} options
 */
export function buildGeminiDecisionPayload({ gameType, draws, generatedAt, learningRecords = [] }) {
  const config = GAME_CONFIG[gameType];
  if (!config) {
    throw new Error(`Unsupported game type: ${gameType}`);
  }
  if (!Array.isArray(draws) || draws.length < 3) {
    throw new Error(`${config.name} requires at least 3 historical draws`);
  }

  const allCounts = frequencyCounts(draws, config.maxNumber);
  const recentPeriods = recentPeriodFor(gameType, draws.length);
  const asiLearningMemory = buildAsiLearningContext(learningRecords);
  const windows = [...new Set([Math.min(draws.length, 30), Math.min(draws.length, 50), Math.min(draws.length, 100), Math.min(draws.length, 300), recentPeriods])]
    .filter((period) => period > 0)
    .sort((left, right) => left - right);

  return {
    game_type: gameType,
    game_name: config.name,
    generated_at: generatedAt,
    number_range: { min: 1, max: config.maxNumber, picks: config.picks },
    ...(config.secondaryNumber
      ? { secondary_number_range: { min: 1, max: config.secondaryNumber.maxNumber, picks: config.secondaryNumber.picks } }
      : {}),
    asi_learning_memory: asiLearningMemory,
    quantitative_features: {
      methodology: "server-computed statistical frequency, recency gaps, average intervals, co-occurrence pairs, sum distribution, odd-even distribution, large-small distribution, verifier and rolling backtest; raw draw history is intentionally omitted from the prompt; ASI learning memory from recent post-draw evaluations; metaphysical signals are entertainment-only and capped at 10 percent.",
      raw_history_policy: "omitted_from_prompt",
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
      ...(config.secondaryNumber
        ? { second_area: buildSpecialNumberInsights({ draws, config, recentPeriods }) }
        : {}),
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

function balancedCandidates(stats, config) {
  // 「穩健平衡」應跨號段均勻分布，而非全擠在中位數附近（舊版排序「離中心最近」會
  // 直接吐出 22,23,24,25,26,27 這種中央連號團）。改為把 1..maxNumber 切成 picks 個
  // 連續號段，每段挑一個代表號（近期最熱，平手取靠近段中心者），確保橫跨全範圍、
  // 結構真正平衡，且不會形成長連號。
  const { maxNumber, picks } = config;
  const byNumber = new Map(stats.map((item) => [item.number, item]));
  const bandSize = maxNumber / picks;
  const primary = [];
  const chosen = new Set();
  for (let band = 0; band < picks; band += 1) {
    const low = Math.floor(band * bandSize) + 1;
    const high = band === picks - 1 ? maxNumber : Math.floor((band + 1) * bandSize);
    const center = (low + high) / 2;
    let best = null;
    for (let number = low; number <= high; number += 1) {
      const frequency = byNumber.get(number)?.frequency ?? 0;
      if (
        !best ||
        frequency > best.frequency ||
        (frequency === best.frequency && Math.abs(number - center) < Math.abs(best.number - center))
      ) {
        best = { number, frequency };
      }
    }
    if (best) {
      primary.push(best.number);
      chosen.add(best.number);
    }
  }
  // 備援池：剩餘號碼按近期頻率排序，供 uniqueTake 在邊界情況補足。
  const rest = [...stats]
    .filter((item) => !chosen.has(item.number))
    .sort((left, right) => right.frequency - left.frequency || left.number - right.number)
    .map((item) => item.number);
  return [...primary, ...rest];
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

function indexInsideLongRun(sorted) {
  let run = 1;
  for (let index = 1; index < sorted.length; index += 1) {
    run = sorted[index] === sorted[index - 1] + 1 ? run + 1 : 1;
    if (run >= 4) {
      return index; // 第 4 個連續號；移除它即可把連號段打斷成 <= 3
    }
  }
  return -1;
}

// 確保任何策略組合都不含 4 個（含）以上的連續整數（與舊版 Python 採樣器一致）。
// 作法：移除連號段中的第 4 個號，改從候選池補入一個不會重新形成長連號的號碼。
function breakConsecutiveRuns(numbers, candidates, config) {
  let combo = normalizeNumbers(numbers);
  const fallback = [...candidates, ...Array.from({ length: config.maxNumber }, (_, i) => i + 1)];
  let guard = 0;
  let runIndex = indexInsideLongRun(combo);
  while (runIndex !== -1 && guard < config.maxNumber * 2) {
    guard += 1;
    const removed = combo[runIndex];
    const without = combo.filter((number) => number !== removed);
    const replacement = fallback.find((number) =>
      Number.isInteger(number) &&
      number >= 1 &&
      number <= config.maxNumber &&
      !without.includes(number) &&
      indexInsideLongRun(normalizeNumbers([...without, number])) === -1
    );
    if (replacement === undefined) {
      break;
    }
    combo = normalizeNumbers([...without, replacement]);
    runIndex = indexInsideLongRun(combo);
  }
  return combo;
}

function verifyCombinations(combinations, config, specialCombinations = null) {
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
    let consecutiveRun = 1;
    for (let index = 1; index < sorted.length; index += 1) {
      consecutiveRun = sorted[index] === sorted[index - 1] + 1 ? consecutiveRun + 1 : 1;
      if (consecutiveRun >= 4) {
        errors.push(`${strategy} contains a run of 4+ consecutive numbers`);
        break;
      }
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
  if (config.secondaryNumber) {
    const secondary = config.secondaryNumber;
    for (const strategy of Object.keys(combinations)) {
      const numbers = specialCombinations?.[strategy];
      if (!Array.isArray(numbers)) {
        errors.push(`${strategy} second area is not an array`);
        continue;
      }
      if (numbers.length !== secondary.picks) {
        errors.push(`${strategy} second area has ${numbers.length} numbers, expected ${secondary.picks}`);
      }
      if (new Set(numbers).size !== numbers.length) {
        errors.push(`${strategy} second area contains duplicate numbers`);
      }
      if (numbers.some((number) => !Number.isInteger(number) || number < 1 || number > secondary.maxNumber)) {
        errors.push(`${strategy} second area contains out-of-range numbers`);
      }
    }
  }
  return {
    valid: errors.length === 0,
    errors,
    checked_at: new Date().toISOString(),
  };
}

export function backtestCombinations({ combinations, specialCombinations = null, draws, maxWindow = 50 }) {
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
    const specialPicks = new Set(specialCombinations?.[strategy] || []);
    const specialHitCounts = specialPicks.size
      ? sample.map((draw) => specialPicks.has(Number(draw.special_number)) ? 1 : 0)
      : [];
    const specialTotalHits = specialHitCounts.reduce((sum, hits) => sum + hits, 0);
    strategies[strategy] = {
      best_hits: hitCounts.length ? Math.max(...hitCounts) : 0,
      average_hits: hitCounts.length ? Number((totalHits / hitCounts.length).toFixed(2)) : 0,
      hit_distribution: hitDistribution,
      special_best_hits: specialHitCounts.length ? Math.max(...specialHitCounts) : 0,
      special_average_hits: specialHitCounts.length ? Number((specialTotalHits / specialHitCounts.length).toFixed(2)) : 0,
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
  const baselineSpecial = prediction.special_combinations || null;
  const computedSpecial = buildSpecialCombinations({ draws, config, recentPeriods: recentPeriodFor(gameType, draws.length) });
  const specialCombinations = baselineSpecial || computedSpecial?.combinations || null;
  const specialNumberInsights = prediction.special_number_insights || computedSpecial?.insights || null;
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
    combinations[strategy] = breakConsecutiveRuns(
      diversifyAgainstPrior(
        uniqueTake(candidates, config.picks, config.maxNumber),
        candidates,
        Object.values(combinations),
        config,
      ),
      candidates,
      config,
    );
  }

  const verification = verifyCombinations(combinations, config, specialCombinations);
  const backtest = backtestCombinations({
    combinations,
    specialCombinations,
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
      ...(specialCombinations
        ? {
            special_combinations: specialCombinations,
            special_number_insights: specialNumberInsights,
          }
        : {}),
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

function buildSpecialNumberInsights({ draws, config, recentPeriods }) {
  const secondary = config.secondaryNumber;
  if (!secondary) {
    return null;
  }

  const specialDraws = specialNumberDraws(draws, secondary.maxNumber);
  const recentSpecialDraws = specialDraws.slice(-Math.min(recentPeriods, specialDraws.length));
  const allCounts = frequencyCounts(specialDraws, secondary.maxNumber);
  const recentCounts = frequencyCounts(recentSpecialDraws, secondary.maxNumber);

  return {
    label: secondary.label,
    range: { min: 1, max: secondary.maxNumber, picks: secondary.picks },
    raw_history_policy: "server_computed_special_number_only",
    sample_size: specialDraws.length,
    recent_periods: recentSpecialDraws.length,
    all_time_hot: rankCounts(allCounts, "desc").slice(0, secondary.maxNumber),
    all_time_cold: rankCounts(allCounts, "asc").slice(0, secondary.maxNumber),
    recent_hot: rankCounts(recentCounts, "desc").slice(0, secondary.maxNumber),
    top_overdue: overdueRanks(specialDraws, secondary.maxNumber).slice(0, secondary.maxNumber),
  };
}

function buildSpecialCombinations({ draws, config, recentPeriods }) {
  const secondary = config.secondaryNumber;
  if (!secondary) {
    return null;
  }

  const specialDraws = specialNumberDraws(draws, secondary.maxNumber);
  const recentSpecialDraws = specialDraws.slice(-Math.min(recentPeriods, specialDraws.length));
  const insights = buildSpecialNumberInsights({ draws, config, recentPeriods });
  const allCounts = frequencyCounts(specialDraws, secondary.maxNumber);
  const expectedFrequency = specialDraws.length / secondary.maxNumber;
  const intervals = averageIntervals(specialDraws, secondary.maxNumber);
  const missing = missingValues(specialDraws, secondary.maxNumber);
  const balancedRank = Array.from({ length: secondary.maxNumber }, (_, index) => {
    const number = index + 1;
    return {
      number,
      frequencyDistance: Math.abs((allCounts.get(number) || 0) - expectedFrequency),
      intervalDistance: Math.abs((missing.get(number) || 0) - (intervals.get(number) || 1)),
    };
  }).sort((left, right) =>
    left.frequencyDistance - right.frequencyDistance ||
    left.intervalDistance - right.intervalDistance ||
    left.number - right.number
  ).map((item) => item.number);
  const recentHot = rankCounts(frequencyCounts(recentSpecialDraws, secondary.maxNumber), "desc")
    .map((item) => item.number);
  const overdue = insights.top_overdue.map((item) => item.number);
  const used = new Set();
  const choose = (candidates) => {
    const selected = candidates.find((number) => !used.has(number)) ?? candidates[0] ?? 1;
    used.add(selected);
    return [selected];
  };

  return {
    combinations: {
      [STRATEGY_NAMES[0]]: choose(overdue),
      [STRATEGY_NAMES[1]]: choose(balancedRank),
      [STRATEGY_NAMES[2]]: choose(recentHot),
    },
    insights,
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
  const overdue = insights.top_overdue.map((item) => item.number);
  const pairNumbers = insights.top_pairs.flatMap((item) => item.pair);
  const allTimeHot = insights.all_time_hot.map((item) => item.number);

  const aggressiveCandidates = [...overdue, ...cold];
  const balancedPool = balancedCandidates(stats, config);
  const trendCandidates = [...hot, ...pairNumbers, ...allTimeHot];
  const combinations = {
    "激進包牌": breakConsecutiveRuns(uniqueTake(aggressiveCandidates, config.picks, config.maxNumber), aggressiveCandidates, config),
    "穩健平衡": breakConsecutiveRuns(uniqueTake(balancedPool, config.picks, config.maxNumber), balancedPool, config),
    "統計趨勢": breakConsecutiveRuns(uniqueTake(trendCandidates, config.picks, config.maxNumber), trendCandidates, config),
  };
  const specialPrediction = buildSpecialCombinations({ draws, config, recentPeriods });
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
      ...(specialPrediction
        ? {
            special_combinations: specialPrediction.combinations,
            special_number_insights: specialPrediction.insights,
          }
        : {}),
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

// ── 誠實博弈版引擎：公正性健診 + 博弈低均分選號 ─────────────────────────────
function gammaln(x) {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  let y = x;
  for (let j = 0; j < 6; j += 1) { y += 1; ser += c[j] / y; }
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}

function gammaincUpper(a, x) {
  const ITMAX = 300, EPS = 1e-13, FPMIN = 1e-300;
  if (x <= 0) return 1;
  if (x < a + 1) {
    let ap = a, sum = 1 / a, del = 1 / a;
    for (let n = 0; n < ITMAX; n += 1) { ap += 1; del *= x / ap; sum += del; if (Math.abs(del) < Math.abs(sum) * EPS) break; }
    return 1 - sum * Math.exp(-x + a * Math.log(x) - gammaln(a));
  }
  let b = x + 1 - a, c = 1 / FPMIN, d = 1 / b, h = d;
  for (let i = 1; i < ITMAX; i += 1) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = b + an / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; const del = d * c; h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return Math.exp(-x + a * Math.log(x) - gammaln(a)) * h;
}

const chiSquareP = (chi2, df) => gammaincUpper(df / 2, chi2 / 2);

function erfApprox(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * ax);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}

const twoTailNormalP = (z) => 2 * (1 - 0.5 * (1 + erfApprox(Math.abs(z) / Math.SQRT2)));

export function fairnessDiagnostic(draws, config) {
  const N = config.maxNumber;
  const k = config.picks;
  const T = draws.length;
  const freq = new Array(N + 1).fill(0);
  for (const draw of draws) {
    for (const number of draw.numbers || []) {
      if (number >= 1 && number <= N) freq[number] += 1;
    }
  }
  const expected = T * k / N;
  let chi2 = 0;
  for (let n = 1; n <= N; n += 1) chi2 += (freq[n] - expected) ** 2 / expected;
  const uniformP = T > 0 ? chiSquareP(chi2, N - 1) : 1;

  let overlapSum = 0;
  for (let i = 1; i < T; i += 1) {
    const prev = new Set(draws[i - 1].numbers || []);
    overlapSum += (draws[i].numbers || []).filter((number) => prev.has(number)).length;
  }
  const theoOverlap = k * k / N;
  const theoVar = k * (k / N) * (1 - k / N) * (N - k) / (N - 1);
  const meanOverlap = T > 1 ? overlapSum / (T - 1) : 0;
  const zOverlap = (theoVar > 0 && T > 1) ? (meanOverlap - theoOverlap) / (Math.sqrt(theoVar) / Math.sqrt(T - 1)) : 0;
  const serialP = twoTailNormalP(zOverlap);

  return {
    sample_size: T,
    chi2: Number(chi2.toFixed(1)),
    uniform_p: Number(uniformP.toFixed(4)),
    serial_p: Number(serialP.toFixed(4)),
    passed: uniformP >= 0.05 && serialP >= 0.05,
  };
}

// ── 號碼心跳 / 節奏推算 ──────────────────────────────────────────────────
// 依各號碼「平均間隔(天)」的節奏，挑出 overdue 比值(已隔天數 / 自身平均間隔)最高、
// 最「久未開」的號碼。⚠ 公正抽獎是無記憶過程，回測命中率與隨機無異——此為節奏觀察，
// 不提高中獎機率。內附 walk-forward 校正回歸：逐期用新開獎結果重算並追蹤命中率。
const HEARTBEAT_NAME = "心跳明牌";
const erfc = (x) => 1 - erfApprox(x);

function drawDateMs(draw) {
  const t = new Date(`${draw.draw_date}T00:00:00Z`).getTime();
  return Number.isNaN(t) ? null : t;
}

function newHeartbeatState(maxNumber) {
  return {
    N: maxNumber,
    last: new Array(maxNumber + 1).fill(null),
    sumGap: new Array(maxNumber + 1).fill(0),
    nGap: new Array(maxNumber + 1).fill(0),
  };
}

function heartbeatUpdate(state, ms, numbers) {
  for (const number of numbers) {
    if (Number.isInteger(number) && number >= 1 && number <= state.N) {
      if (state.last[number] !== null) {
        state.sumGap[number] += (ms - state.last[number]) / 86400000;
        state.nGap[number] += 1;
      }
      state.last[number] = ms;
    }
  }
}

function heartbeatRank(state, todayMs, k) {
  const scored = [];
  const fallback = [];
  for (let n = 1; n <= state.N; n += 1) {
    if (state.last[n] !== null && state.nGap[n] > 0) {
      const mean = state.sumGap[n] / state.nGap[n];
      if (mean > 0) {
        const gap = (todayMs - state.last[n]) / 86400000;
        scored.push({ n, ratio: gap / mean, gap, mean });
        continue;
      }
    }
    const gap = state.last[n] !== null ? (todayMs - state.last[n]) / 86400000 : Infinity;
    fallback.push({ n, gap });
  }
  scored.sort((a, b) => b.ratio - a.ratio || b.gap - a.gap || a.n - b.n);
  const picks = scored.slice(0, k);
  if (picks.length < k) {
    fallback.sort((a, b) => b.gap - a.gap || a.n - b.n);
    for (const f of fallback) {
      if (picks.length >= k) break;
      picks.push({ n: f.n, ratio: null, gap: Number.isFinite(f.gap) ? f.gap : null, mean: null });
    }
  }
  return picks;
}

function numberSequence(draws, kind, maxNumber) {
  const seq = [];
  for (const draw of draws) {
    const ms = drawDateMs(draw);
    if (ms === null) continue;
    if (kind === "special") {
      const s = Number(draw.special_number);
      if (Number.isInteger(s) && s >= 1 && s <= maxNumber) seq.push({ ms, nums: [s] });
    } else {
      seq.push({ ms, nums: (draw.numbers || []).map(Number) });
    }
  }
  return seq;
}

function heartbeatPicks(draws, maxNumber, k, todayMs, kind = "main") {
  const state = newHeartbeatState(maxNumber);
  for (const ev of numberSequence(draws, kind, maxNumber)) heartbeatUpdate(state, ev.ms, ev.nums);
  return heartbeatRank(state, todayMs, k);
}

// walk-forward：只用過去資料預測下一期，累積命中率對隨機基準 k/N 做校正回歸。
function heartbeatCalibration(draws, maxNumber, k, window = 1500) {
  const seq = numberSequence(draws, "main", maxNumber);
  const T = seq.length;
  const warmup = Math.min(300, Math.floor(T / 3));
  const start = window > 0 ? Math.max(warmup, T - window) : warmup;
  const state = newHeartbeatState(maxNumber);
  for (let i = 0; i < start; i += 1) heartbeatUpdate(state, seq[i].ms, seq[i].nums);
  let hits = 0;
  let trials = 0;
  for (let i = start; i < T; i += 1) {
    const picks = heartbeatRank(state, seq[i].ms, k).map((p) => p.n);
    const actual = new Set(seq[i].nums);
    for (const n of picks) if (actual.has(n)) hits += 1;
    trials += k;
    heartbeatUpdate(state, seq[i].ms, seq[i].nums);
  }
  const base = k / maxNumber;
  const rate = trials ? hits / trials : 0;
  let pValue = 1;
  if (trials) {
    const se = Math.sqrt(base * (1 - base) / trials);
    const z = se > 0 ? (rate - base) / se : 0;
    pValue = 0.5 * erfc(z / Math.SQRT2);
  }
  return {
    window: T - start,
    trials,
    hits,
    hit_rate: Number((rate * 100).toFixed(2)),
    base_rate: Number((base * 100).toFixed(2)),
    p_value: Number(pValue.toFixed(3)),
    beats_random: pValue < 0.05 && rate > base,
  };
}

function buildHeartbeat(draws, config, todayMs) {
  const mainPicks = heartbeatPicks(draws, config.maxNumber, config.picks, todayMs, "main");
  const combination = normalizeNumbers(mainPicks.map((p) => p.n));
  const numbers = Object.fromEntries(mainPicks.map((p) => [String(p.n), {
    avg_interval_days: p.mean !== null ? Number(p.mean.toFixed(1)) : null,
    gap_days: p.gap !== null && Number.isFinite(p.gap) ? Math.round(p.gap) : null,
    overdue_ratio: p.ratio !== null ? Number(p.ratio.toFixed(2)) : null,
  }]));
  let secondArea = null;
  if (config.secondaryNumber) {
    const sec = config.secondaryNumber;
    const secPicks = heartbeatPicks(draws, sec.maxNumber, sec.picks, todayMs, "special");
    secondArea = normalizeNumbers(secPicks.map((p) => p.n));
  }
  return {
    label: HEARTBEAT_NAME,
    combination,
    second_area: secondArea,
    numbers,
    calibration: heartbeatCalibration(draws, config.maxNumber, config.picks),
    note: "依各號平均間隔(天)的節奏推算最久未開的號碼；回測命中率與隨機無異，僅供節奏對照，非中獎保證。",
  };
}

// ── 穩健平衡的方法論融合：統計啟發(頻率) + 馬可夫鏈 + LSTM ───────────────────
// 三法都不提高中獎機率(回測≈隨機)；融合只改變「同一號段裡挑哪個號」，維持穩健平衡的
// 跨號段均勻結構。各方法分數正規化到 [0,1] 後等權相加。
function minMaxNormalize(values) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  return values.map((x) => (x - min) / span);
}

function blendScores(parts, N) {
  const out = new Array(N).fill(0);
  for (const part of parts) {
    if (!part.score) continue;
    const norm = minMaxNormalize(part.score);
    for (let n = 0; n < N; n += 1) out[n] += part.weight * norm[n];
  }
  return out;
}

function balancedCandidatesByScore(score, config) {
  // 與 balancedCandidates 相同的「跨號段均勻」結構，但每段以融合分數(而非純頻率)挑代表號。
  const { maxNumber, picks } = config;
  const bandSize = maxNumber / picks;
  const primary = [];
  const chosen = new Set();
  for (let band = 0; band < picks; band += 1) {
    const low = Math.floor(band * bandSize) + 1;
    const high = band === picks - 1 ? maxNumber : Math.floor((band + 1) * bandSize);
    const center = (low + high) / 2;
    let best = null;
    for (let number = low; number <= high; number += 1) {
      const sc = score[number - 1] ?? 0;
      if (
        !best ||
        sc > best.sc ||
        (sc === best.sc && Math.abs(number - center) < Math.abs(best.number - center))
      ) {
        best = { number, sc };
      }
    }
    if (best) {
      primary.push(best.number);
      chosen.add(best.number);
    }
  }
  const rest = Array.from({ length: maxNumber }, (_, i) => i + 1)
    .filter((n) => !chosen.has(n))
    .sort((a, b) => (score[b - 1] ?? 0) - (score[a - 1] ?? 0) || a - b);
  return [...primary, ...rest];
}

export function generateHonestPrediction({ gameType, draws, generatedAt }) {
  const config = GAME_CONFIG[gameType];
  if (!config) {
    throw new Error(`Unsupported game type: ${gameType}`);
  }
  if (!Array.isArray(draws) || draws.length < 3) {
    throw new Error(`${config.name} requires at least 3 historical draws`);
  }

  const diagnostic = fairnessDiagnostic(draws, config);
  const recentPeriods = recentPeriodFor(gameType, draws.length);
  const recentDraws = draws.slice(-recentPeriods);

  // ① 穩健平衡（統計啟發 + 馬可夫 + LSTM 融合）：維持「跨號段均勻」結構，但每段以三法
  //    融合分數挑代表號。三法回測均≈隨機，融合只改變選哪個號、不提高中獎機率。
  const N = config.maxNumber;
  const stats = numberStats(recentDraws, N);
  const freqScore = stats.map((item) => item.frequency);
  const expertForecasts = buildExpertForecasts({ gameType, draws, generatedAt });
  const markov = expertForecasts.find((forecast) => forecast.name === "markov")?.probabilities;
  const lstmForecast = expertForecasts.find((forecast) => forecast.name === "lstm");
  const lstm = lstmForecast?.featureSummary.staticWeights ? lstmForecast.probabilities : null;
  const balancedMethods = ["統計啟發(頻率)", "馬可夫鏈"];
  if (lstm) balancedMethods.push("LSTM");
  const blended = blendScores([
    { weight: 1, score: freqScore },
    { weight: 1, score: markov },
    { weight: 1, score: lstm },
  ], N);
  const balancedPool = balancedCandidatesByScore(blended, config);
  const balanced = breakConsecutiveRuns(
    uniqueTake(balancedPool, config.picks, N),
    balancedPool,
    config,
  );
  const specialPrediction = buildSpecialCombinations({ draws, config, recentPeriods });
  const balancedSecond = specialPrediction?.combinations?.["穩健平衡"] || null;

  // ② 心跳明牌（節奏觀察，回測≈隨機；永遠固定一組）。
  const todayMs = (() => {
    const t = new Date(generatedAt).getTime();
    return Number.isNaN(t) ? (drawDateMs(draws.at(-1)) ?? 0) : t;
  })();
  const heartbeat = buildHeartbeat(draws, config, todayMs);

  const combinations = { "穩健平衡": balanced, [HEARTBEAT_NAME]: heartbeat.combination };
  const specialCombinations = (balancedSecond || heartbeat.second_area)
    ? {
        ...(balancedSecond ? { "穩健平衡": balancedSecond } : {}),
        ...(heartbeat.second_area ? { [HEARTBEAT_NAME]: heartbeat.second_area } : {}),
      }
    : null;
  const insights = buildInsightPayload({ gameType, draws, recentDraws, config });
  const selectedNumberInsights = buildSelectedNumberInsights({ combinations, draws, recentDraws, config, recentPeriods });

  const reasoning = `本期公正性健診：${diagnostic.passed ? "通過" : "異常待查"}（號碼均勻性 p=${diagnostic.uniform_p}、前後期獨立性 p=${diagnostic.serial_p}）。開獎在統計上與真隨機無法區分，每一組號碼的中獎機率都相同、沒有「明牌」。\n① 穩健平衡（融合 ${balancedMethods.join("＋")}）：跨號段均勻分布、結構平衡的一組選號——以三法融合分數在每個號段挑代表號；上述方法回測均≈隨機，融合只改變選號、不提高中獎機率。\n② 心跳明牌：依各號平均間隔天數的節奏挑最久未開的號碼，純屬節奏觀察——回測命中率與隨機無異（${heartbeat.calibration.hit_rate}% vs 隨機 ${heartbeat.calibration.base_rate}%、近 ${heartbeat.calibration.window} 期），不提高中獎機率。`;

  return {
    timestamp: generatedAt,
    game_name: config.name,
    is_offline: false,
    prediction: {
      model: "game-theory-v1",
      engine: "honest-game-theory",
      reasoning_source: "honest_game_theory",
      reasoning,
      risk_warning: "本系統不預測號碼。每組號碼中獎機率相同，樂透期望值為負，以下選號僅供參考，請理性投注、量力而為。",
      fairness_diagnostic: diagnostic,
      strategy_kind: "stable_balanced",
      balanced_methods: balancedMethods,
      combinations,
      ...(specialCombinations ? { special_combinations: specialCombinations } : {}),
      heartbeat,
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

export function generateAdaptivePrediction({
  gameType,
  draws,
  generatedAt,
  targetDrawDate,
  agentState = null,
  dataStatus = "unknown",
}) {
  const config = GAME_CONFIG[gameType];
  if (!config) {
    throw new Error(`Unsupported game type: ${gameType}`);
  }
  if (!Array.isArray(draws) || draws.length < 3) {
    throw new Error(`${config.name} requires at least 3 historical draws`);
  }

  const modelVersion = "lai-v2";
  const forecasts = buildExpertForecasts({ gameType, draws, generatedAt });
  const effectiveState = agentState ?? createBaselineState({
    gameName: config.name,
    expertNames: forecasts.map((forecast) => forecast.name),
  });
  const aggregated = aggregateForecasts({
    forecasts,
    activeState: effectiveState,
    config,
  });
  const powerSpecialFallback = config.secondaryNumber && !Array.isArray(aggregated.specialProbabilities)
    ? POWER_SPECIAL_FALLBACK
    : null;
  const specialProbabilities = powerSpecialFallback
    ? normalizeProbabilityVector(
        Array(config.secondaryNumber.maxNumber).fill(1),
        config.secondaryNumber.maxNumber,
        config.secondaryNumber.picks,
      )
    : aggregated.specialProbabilities;
  const seed = `${config.name}|${targetDrawDate}|${modelVersion}|state-${effectiveState.state_version}`;
  const optimized = config.secondaryNumber
    ? optimizePowerGroups({
        mainProbabilities: aggregated.probabilities,
        specialProbabilities,
        config,
        seed,
      })
    : optimizeTwoGroups({
        probabilities: aggregated.probabilities,
        config,
        seed,
      });

  const publicEvidence = {
    target_draw_date: targetDrawDate,
    model_version: modelVersion,
    state_status: effectiveState.status,
    state_version: effectiveState.state_version,
    last_learned_draw_id: effectiveState.last_learned_draw_id ?? null,
    last_learned_draw_date: effectiveState.last_learned_draw_date ?? null,
    champion_model: effectiveState.champion_model ?? "uniform",
    data_status: dataStatus,
    proven_above_random: effectiveState.status === "champion",
    ...(powerSpecialFallback ? { special_area_fallback: powerSpecialFallback } : {}),
  };
  const canonicalGroups = {
    "機率主攻": optimized.groupA,
    "覆蓋探索": optimized.groupB,
  };
  const canonicalSpecialGroups = config.secondaryNumber
    ? {
        "機率主攻": optimized.specialGroupA,
        "覆蓋探索": optimized.specialGroupB,
      }
    : null;
  const publicCombinations = cloneJsonReady(canonicalGroups);
  const publicSpecialCombinations = cloneJsonReady(canonicalSpecialGroups);
  const finalGroups = {
    combinations: cloneJsonReady(canonicalGroups),
    ...(canonicalSpecialGroups
      ? {
          special_combinations: cloneJsonReady(canonicalSpecialGroups),
        }
      : {}),
  };
  const persistedForecasts = forecasts.map((forecast) => {
    const activeWeight = effectiveState.expert_weights?.[forecast.name] ?? 0;
    return {
      ...forecast,
      featureSummary: powerSpecialFallback
        && activeWeight > 0
        && !Array.isArray(forecast.specialProbabilities)
        ? {
            ...cloneJsonReady(forecast.featureSummary),
            specialAreaFallback: powerSpecialFallback,
          }
        : cloneJsonReady(forecast.featureSummary),
      active_weight: activeWeight,
      evidence: { ...publicEvidence },
    };
  });
  persistedForecasts.push({
    name: "ensemble",
    version: modelVersion,
    probabilities: aggregated.probabilities,
    specialProbabilities: Array.isArray(specialProbabilities) ? specialProbabilities : null,
    featureSummary: {
      groupMetrics: optimized.metrics,
      ...(config.secondaryNumber ? { specialGroupMetrics: optimized.specialMetrics } : {}),
      expertWeights: aggregated.expertWeights,
      specialExpertWeights: aggregated.specialExpertWeights,
    },
    active_weight: 1,
    final_groups: finalGroups,
    evidence: { ...publicEvidence },
  });

  return {
    record: {
      timestamp: generatedAt,
      game_name: config.name,
      is_offline: false,
      prediction: {
        model: modelVersion,
        engine: "lai-adaptive-ensemble",
        reasoning_source: "lai_quantitative",
        agent_status: effectiveState.status,
        agent_state_version: effectiveState.state_version,
        expert_weights: effectiveState.expert_weights,
        evidence: publicEvidence,
        combinations: publicCombinations,
        ...(publicSpecialCombinations
          ? {
              special_combinations: publicSpecialCombinations,
              special_group_metrics: optimized.specialMetrics,
            }
          : {}),
        group_metrics: optimized.metrics,
      },
      is_evaluated: false,
      evaluation: {
        draw_id: null,
        actual_numbers: [],
        strategies: {},
      },
    },
    forecasts: persistedForecasts,
  };
}

export function buildLineMessage(record, targetDate) {
  if (record.prediction?.model === "lai-v2") {
    return buildLaiLineMessage(record, targetDate);
  }
  if (record.prediction?.model === "game-theory-v1" || record.prediction?.fairness_diagnostic) {
    return buildHonestLineMessage(record, targetDate);
  }
  const combinations = record.prediction?.combinations || {};
  const specialCombinations = record.prediction?.special_combinations || {};
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
    const secondArea = specialCombinations[strategy] || [];
    message += `[${strategy}]\n`;
    if (secondArea.length) {
      const secondAreaText = secondArea.map((number) => String(number).padStart(2, "0")).join(", ");
      message += `第一區：${numberText}\n`;
      message += `第二區：${secondAreaText}\n\n`;
    } else {
      message += `${numberText}\n\n`;
    }
  }

  message += `------------------\n`;
  message += `提醒：樂透屬隨機事件，請理性投注。`;
  return message;
}

function formatBalls(numbers) {
  return (numbers || []).map((n) => String(n).padStart(2, "0")).join(", ");
}

function buildLaiLineMessage(record, targetDate) {
  const prediction = record.prediction || {};
  const groups = prediction.combinations || {};
  const specialGroups = prediction.special_combinations || {};
  const metrics = prediction.group_metrics || {};
  const evidence = prediction.evidence || {};

  let message = "LAI v2\n\n";
  message += `日期：${targetDate}\n`;
  message += `彩種：${record.game_name}\n`;
  message += `agent_status: ${prediction.agent_status || evidence.state_status || "unknown"}\n`;
  message += `state_status: ${evidence.state_status || "unknown"}\n`;
  message += `data_status: ${evidence.data_status || "unknown"}\n`;
  message += `proven_above_random: ${evidence.proven_above_random ? "yes" : "no"}\n`;
  message += `union_size: ${metrics.union_size ?? 0}\n`;
  message += `overlap_count: ${metrics.overlap_count ?? 0}\n`;
  message += "------------------\n";

  for (const [label, numbers] of Object.entries(groups)) {
    message += `[${label}]\n`;
    const specialArea = specialGroups[label] || [];
    if (Array.isArray(specialArea) && specialArea.length) {
      message += `第一區（area_1）：${formatBalls(numbers)}\n`;
      message += `第二區（area_2）：${formatBalls(specialArea)}\n\n`;
    } else {
      message += `${formatBalls(numbers)}\n\n`;
    }
  }

  message += "------------------\n";
  message += "提醒：本訊息僅提供量化分組、狀態與覆蓋資訊，不保證命中。";
  return message;
}

function buildHonestLineMessage(record, targetDate) {
  const prediction = record.prediction || {};
  const diagnostic = prediction.fairness_diagnostic || {};
  const combinations = prediction.combinations || {};
  const specialCombinations = prediction.special_combinations || null;
  const heartbeat = prediction.heartbeat || null;

  let message = `🎲 樂透公正性健診 + 選號\n\n`;
  message += `日期：${targetDate}\n`;
  message += `彩種：${record.game_name}\n`;
  message += `------------------\n`;
  message += `公正性健診：${diagnostic.passed ? "✅ 通過" : "⚠ 異常待查"}\n`;
  message += `本期開獎在統計上與「真隨機」無法區分`;
  if (diagnostic.uniform_p !== undefined) {
    message += `（號碼均勻性 p=${diagnostic.uniform_p}、前後期獨立性 p=${diagnostic.serial_p}）`;
  }
  message += `。\n→ 沒有可預測的號碼，任何「明牌」都與隨機無異。\n`;

  // ① 穩健平衡（跨號段均勻分布的一組選號；統計啟發式，不保證命中）
  const balanced = combinations["穩健平衡"];
  if (Array.isArray(balanced)) {
    const second = specialCombinations?.["穩健平衡"];
    message += `------------------\n`;
    const methods = Array.isArray(prediction.balanced_methods) && prediction.balanced_methods.length
      ? prediction.balanced_methods.join("＋")
      : "統計啟發";
    message += `① 穩健平衡（融合 ${methods}）：\n`;
    message += Array.isArray(second) && second.length
      ? `第一區 ${formatBalls(balanced)}　第二區 ${formatBalls(second)}\n`
      : `${formatBalls(balanced)}\n`;
    message += `（跨號段均勻分布；三法回測均≈隨機，不保證命中、不提高中獎機率）\n`;
  }

  // ② 號碼心跳明牌（節奏觀察：回測命中率≈隨機，僅供對照）
  if (heartbeat && Array.isArray(heartbeat.combination)) {
    const second = heartbeat.second_area;
    message += `------------------\n`;
    message += `② 號碼心跳明牌（依各號平均間隔天數的節奏，挑最久未開的號）：\n`;
    message += Array.isArray(second) && second.length
      ? `第一區 ${formatBalls(heartbeat.combination)}　第二區 ${formatBalls(second)}\n`
      : `${formatBalls(heartbeat.combination)}\n`;
    const cal = heartbeat.calibration;
    if (cal) {
      message += `滾動校正：心跳命中率 ${cal.hit_rate}% ≈ 隨機 ${cal.base_rate}%（近 ${cal.window} 期回測）→ 僅供節奏對照\n`;
    }
  }

  message += `------------------\n`;
  message += `提醒：本系統不預測號碼。樂透期望值為負，請理性投注、量力而為。`;
  return message;
}
