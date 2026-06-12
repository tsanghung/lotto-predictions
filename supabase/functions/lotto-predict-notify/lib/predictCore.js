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

  return {
    timestamp: generatedAt,
    game_name: config.name,
    is_offline: false,
    prediction: {
      model: "supabase-statistical-v1",
      reasoning,
      risk_warning: "樂透屬隨機事件，統計洞察僅供輔助參考，請理性投注。",
      combinations,
      number_insights: insights,
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
