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
