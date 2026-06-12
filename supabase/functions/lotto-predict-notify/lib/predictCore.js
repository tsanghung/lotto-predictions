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

export function generatePrediction({ gameType, draws, generatedAt }) {
  const config = GAME_CONFIG[gameType];
  if (!config) {
    throw new Error(`Unsupported game type: ${gameType}`);
  }
  if (!Array.isArray(draws) || draws.length < 3) {
    throw new Error(`${config.name} requires at least 3 historical draws`);
  }

  const recentDraws = draws.slice(-30);
  const stats = numberStats(recentDraws, config.maxNumber);
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

  const combinations = {
    "穩健平衡": uniqueTake(balancedCandidates(stats, averageTarget), config.picks, config.maxNumber),
    "統計趨勢": uniqueTake(hot, config.picks, config.maxNumber),
    "冷門補位": uniqueTake(cold, config.picks, config.maxNumber),
  };

  return {
    timestamp: generatedAt,
    game_name: config.name,
    is_offline: false,
    prediction: {
      model: "supabase-statistical-v1",
      reasoning: `依最近 ${recentDraws.length} 期開獎頻率、遺漏期數與平均和值產生三組推薦。此模型為統計輔助，不保證命中。`,
      combinations,
      number_insights: {
        latest_draw_id: draws.at(-1)?.draw_id,
        latest_draw_date: draws.at(-1)?.draw_date,
        sample_size: recentDraws.length,
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
  let message = `AI 樂透預測\n\n`;
  message += `日期：${targetDate}\n`;
  message += `彩種：${record.game_name}\n`;
  message += `------------------\n`;
  message += `分析：\n${record.prediction?.reasoning || "統計模型產生推薦組合。"}\n`;
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
