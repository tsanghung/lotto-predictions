export const GAME_NAMES = {
  "539": "今彩539",
  "649": "大樂透",
};

const OFFICIAL_KEYS = {
  "539": "daily539Res",
  "649": "lotto649Res",
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
    const baseNumbers = gameType === "649"
      ? drawNumbers.slice(0, 6)
      : drawNumbers.slice(0, 5);
    const specialNumber = gameType === "649" ? Number(drawNumbers[6]) : null;

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
    taiwanHour >= 21 &&
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

export function evaluatePredictionRecord(record, draw) {
  const actualNumbers = normalizeNumbers(draw.numbers || []);
  const actualSet = new Set(actualNumbers);
  const combinations = record?.prediction?.combinations || {};
  const strategies = {};

  for (const [strategyName, predictedNumbers] of Object.entries(combinations)) {
    const predicted = normalizeNumbers(predictedNumbers || []);
    const matches = predicted.filter((number) => actualSet.has(number));
    const missed = predicted.filter((number) => !actualSet.has(number));

    strategies[strategyName] = {
      hits: matches.length,
      matches,
      miss_count: missed.length,
      missed_numbers: missed,
    };
  }

  return {
    draw_id: String(draw.draw_id),
    draw_date: draw.draw_date ?? draw.date,
    actual_numbers: actualNumbers,
    special_number: draw.special_number ?? null,
    strategies,
    attribution_report: null,
    attribution_trigger: "supabase_edge_basic_evaluation",
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

export function buildPerformanceSnapshot(records, generatedAt = new Date().toISOString()) {
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
    }

    gamePerf.trend.push(trendData);
  }

  for (const gamePerf of Object.values(performance.games)) {
    for (const stats of Object.values(gamePerf.strategies)) {
      const total = stats.total_hits + stats.total_misses;
      stats.win_rate = total > 0 ? Number((stats.total_hits / total).toFixed(4)) : 0;
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
