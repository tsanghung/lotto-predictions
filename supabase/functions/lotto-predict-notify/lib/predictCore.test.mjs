import test from "node:test";
import assert from "node:assert/strict";

import {
  applyGeminiQuantDecision,
  backtestCombinations,
  buildGeminiDecisionPayload,
  buildLineMessage,
  dueGamesForDate,
  generatePrediction,
  notificationSentBeforeRelease,
  predictionTargetDate,
  nextDrawDate,
  notificationKey,
  sourceKey,
} from "./predictCore.js";

const dailyDraws = [
  { draw_id: "115000138", draw_date: "2026-06-06", numbers: [13, 27, 30, 37, 38] },
  { draw_id: "115000139", draw_date: "2026-06-08", numbers: [8, 14, 17, 18, 28] },
  { draw_id: "115000140", draw_date: "2026-06-09", numbers: [10, 17, 20, 25, 28] },
  { draw_id: "115000141", draw_date: "2026-06-10", numbers: [1, 4, 32, 35, 39] },
  { draw_id: "115000142", draw_date: "2026-06-11", numbers: [8, 15, 20, 29, 31] },
];

test("generates three deterministic Daily539 prediction combinations", () => {
  const prediction = generatePrediction({
    gameType: "539",
    draws: dailyDraws,
    generatedAt: "2026-06-12T14:35:16+08:00",
  });

  assert.equal(prediction.game_name, "今彩539");
  assert.deepEqual(Object.keys(prediction.prediction.combinations), ["激進包牌", "穩健平衡", "統計趨勢"]);
  for (const nums of Object.values(prediction.prediction.combinations)) {
    assert.equal(nums.length, 5);
    assert.equal(new Set(nums).size, 5);
    assert.deepEqual(nums, [...nums].sort((a, b) => a - b));
    assert.ok(nums.every((n) => n >= 1 && n <= 39));
  }
});

test("source key is stable for game and target draw date", () => {
  assert.equal(
    sourceKey("今彩539", "2026-06-13"),
    sourceKey("今彩539", "2026-06-13"),
  );
  assert.notEqual(
    sourceKey("今彩539", "2026-06-13"),
    sourceKey("大樂透", "2026-06-13"),
  );
});

test("notification key prevents duplicate sends per game and target date", () => {
  assert.equal(
    notificationKey("今彩539", "2026-06-12", "prediction"),
    "prediction|今彩539|2026-06-12",
  );
});

test("builds LINE message with game name and combinations", () => {
  const prediction = generatePrediction({
    gameType: "539",
    draws: dailyDraws,
    generatedAt: "2026-06-12T14:35:16+08:00",
  });

  const message = buildLineMessage(prediction, "2026-06-12");

  assert.match(message, /今彩539/);
  assert.match(message, /2026-06-12/);
  assert.match(message, /統計洞察/);
  assert.match(message, /近 5 期最熱/);
  assert.match(message, /最冷/);
  assert.match(message, /即將開出指數/);
  assert.match(message, /同開號碼對/);
  assert.match(message, /激進包牌/);
  assert.match(message, /穩健平衡/);
  assert.match(message, /統計趨勢/);
});

test("stores statistical insight payload used by the LINE message", () => {
  const prediction = generatePrediction({
    gameType: "539",
    draws: dailyDraws,
    generatedAt: "2026-06-12T14:35:16+08:00",
  });

  const insights = prediction.prediction.number_insights;
  assert.equal(insights.recent_periods, 5);
  assert.ok(insights.recent_hot.length > 0);
  assert.ok(insights.recent_cold.length > 0);
  assert.ok(insights.top_overdue.length > 0);
  assert.ok(insights.top_pairs.length > 0);
});

test("builds Gemini payload with full raw draw history and quantitative features", () => {
  const payload = buildGeminiDecisionPayload({
    gameType: "539",
    draws: dailyDraws,
    generatedAt: "2026-06-12T14:35:16+08:00",
  });

  assert.equal(payload.game_name, "今彩539");
  assert.equal(payload.full_history.length, dailyDraws.length);
  assert.deepEqual(payload.full_history.map((draw) => draw.draw_id), dailyDraws.map((draw) => draw.draw_id));
  assert.equal(payload.quantitative_features.full_history_sample_size, dailyDraws.length);
  assert.ok(payload.quantitative_features.trend_windows["5"].hot.length > 0);
  assert.ok(payload.quantitative_features.methodology.includes("statistical"));
});

test("Gemini quantitative decision drives combinations while verifier rejects invalid numbers", () => {
  const base = generatePrediction({
    gameType: "539",
    draws: dailyDraws,
    generatedAt: "2026-06-12T14:35:16+08:00",
  });
  const payload = buildGeminiDecisionPayload({
    gameType: "539",
    draws: dailyDraws,
    generatedAt: "2026-06-12T14:35:16+08:00",
  });
  const decision = {
    reasoning: "AI 以全歷史資料、近期期數與尾數節奏做出量化排序。",
    risk_warning: "僅供娛樂與統計參考。",
    metaphysics_note: "玄學因子僅作 5% 娛樂輔助權重。",
    strategy_weights: {
      "激進包牌": { weight: 0.35, prefer: [39, 38, 500, 37, 36, 35], avoid: [1], rationale: "遺漏與尾數節奏。" },
      "穩健平衡": { weight: 0.35, prefer: [8, 14, 17, 28, 31], avoid: [], rationale: "冷熱平衡。" },
      "統計趨勢": { weight: 0.3, prefer: [20, 25, 29, 31, 32], avoid: [2], rationale: "高頻與同開。" },
    },
    candidate_pool: [
      { number: 39, score: 0.98, statistics_reason: "高遺漏", metaphysics_signal: "尾數 9" },
      { number: 38, score: 0.88, statistics_reason: "近期冷", metaphysics_signal: "尾數 8" },
      { number: 37, score: 0.78, statistics_reason: "同開", metaphysics_signal: "連動" },
      { number: 36, score: 0.68, statistics_reason: "補位", metaphysics_signal: "節奏" },
      { number: 35, score: 0.58, statistics_reason: "補位", metaphysics_signal: "節奏" },
    ],
  };

  const record = applyGeminiQuantDecision({
    baseRecord: base,
    decision,
    payload,
    draws: dailyDraws,
  });

  assert.equal(record.prediction.model, "gemini-quant-v2");
  assert.equal(record.prediction.reasoning_source, "gemini_quantitative");
  assert.deepEqual(record.prediction.combinations["激進包牌"], [35, 36, 37, 38, 39]);
  assert.ok(record.prediction.verification.valid);
  assert.ok(record.prediction.backtest.window_size > 0);
});

test("backtests combinations against historical draws with hit distribution", () => {
  const result = backtestCombinations({
    combinations: {
      "激進包牌": [8, 14, 17, 18, 28],
      "穩健平衡": [1, 4, 32, 35, 39],
    },
    draws: dailyDraws,
    maxWindow: 4,
  });

  assert.equal(result.window_size, 4);
  assert.equal(result.strategies["激進包牌"].best_hits, 5);
  assert.ok(result.strategies["激進包牌"].average_hits > 0);
  assert.ok(result.strategies["穩健平衡"].hit_distribution["5"] >= 1);
});

test("calculates next Daily539 draw date by skipping Sunday", () => {
  assert.equal(nextDrawDate("539", "2026-06-13"), "2026-06-15");
  assert.equal(nextDrawDate("539", "2026-06-12"), "2026-06-13");
});

test("calculates next Lotto649 draw date as Tuesday or Friday", () => {
  assert.equal(nextDrawDate("649", "2026-06-12"), "2026-06-16");
  assert.equal(nextDrawDate("649", "2026-06-15"), "2026-06-16");
});

test("targets the same draw date for 10 AM draw-day predictions", () => {
  assert.equal(predictionTargetDate("539", "2026-06-15"), "2026-06-15");
  assert.equal(predictionTargetDate("649", "2026-06-16"), "2026-06-16");
  assert.equal(predictionTargetDate("539", "2026-06-14"), null);
  assert.equal(predictionTargetDate("649", "2026-06-15"), null);
});

test("due games are only games drawing on that calendar date", () => {
  assert.deepEqual(dueGamesForDate("2026-06-15"), ["539"]);
  assert.deepEqual(dueGamesForDate("2026-06-16"), ["539", "649"]);
  assert.deepEqual(dueGamesForDate("2026-06-14"), []);
});

test("detects notifications sent before draw-day 10 AM release time", () => {
  assert.equal(notificationSentBeforeRelease("2026-06-13T14:25:33Z", "2026-06-15"), true);
  assert.equal(notificationSentBeforeRelease("2026-06-15T01:59:59Z", "2026-06-15"), true);
  assert.equal(notificationSentBeforeRelease("2026-06-15T02:00:00Z", "2026-06-15"), false);
  assert.equal(notificationSentBeforeRelease(null, "2026-06-15"), false);
});
