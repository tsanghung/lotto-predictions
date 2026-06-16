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
    learning_report: buildPostDrawLearningReport(record, actualNumbers, strategies),
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
