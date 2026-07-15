import test from "node:test";
import assert from "node:assert/strict";

import {
  applyGeminiQuantDecision,
  backtestCombinations,
  buildAsiLearningContext,
  buildGeminiDecisionPayload,
  buildLineMessage,
  dueGamesForDate,
  generateAdaptivePrediction,
  generateHonestPrediction,
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

const powerDraws = [
  { draw_id: "115000039", draw_date: "2026-05-14", numbers: [4, 8, 10, 25, 29, 32], special_number: 4 },
  { draw_id: "115000040", draw_date: "2026-05-18", numbers: [5, 11, 18, 24, 31, 37], special_number: 5 },
  { draw_id: "115000041", draw_date: "2026-05-21", numbers: [2, 6, 13, 19, 28, 36], special_number: 7 },
  { draw_id: "115000042", draw_date: "2026-05-25", numbers: [3, 9, 16, 21, 33, 35], special_number: 8 },
  { draw_id: "115000043", draw_date: "2026-05-28", numbers: [1, 2, 24, 31, 34, 38], special_number: 3 },
];

const lotto649Draws = [
  { draw_id: "115000031", draw_date: "2026-06-02", numbers: [3, 12, 19, 24, 37, 45] },
  { draw_id: "115000032", draw_date: "2026-06-05", numbers: [7, 14, 22, 31, 38, 46] },
  { draw_id: "115000033", draw_date: "2026-06-09", numbers: [5, 16, 21, 33, 40, 47] },
  { draw_id: "115000034", draw_date: "2026-06-12", numbers: [8, 11, 25, 29, 41, 49] },
  { draw_id: "115000035", draw_date: "2026-06-16", numbers: [4, 13, 18, 27, 35, 44] },
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

test("generates Power Lottery predictions with first-area rules", () => {
  const prediction = generatePrediction({
    gameType: "power",
    draws: powerDraws,
    generatedAt: "2026-06-25T10:00:00+08:00",
  });

  assert.equal(prediction.game_name, "威力彩");
  assert.deepEqual(Object.keys(prediction.prediction.combinations), ["激進包牌", "穩健平衡", "統計趨勢"]);
  for (const nums of Object.values(prediction.prediction.combinations)) {
    assert.equal(nums.length, 6);
    assert.equal(new Set(nums).size, 6);
    assert.deepEqual(nums, [...nums].sort((a, b) => a - b));
    assert.ok(nums.every((n) => n >= 1 && n <= 38));
  }
  assert.equal(prediction.prediction.number_insights.full_history_sample_size, undefined);
});

test("generates Power Lottery second-area predictions with 8-pick-1 rules", () => {
  const prediction = generatePrediction({
    gameType: "power",
    draws: powerDraws,
    generatedAt: "2026-06-25T10:00:00+08:00",
  });

  const firstAreaStrategies = Object.keys(prediction.prediction.combinations);
  const secondArea = prediction.prediction.special_combinations;

  assert.deepEqual(Object.keys(secondArea), firstAreaStrategies);
  for (const nums of Object.values(secondArea)) {
    assert.equal(nums.length, 1);
    assert.equal(new Set(nums).size, 1);
    assert.ok(nums.every((n) => Number.isInteger(n) && n >= 1 && n <= 8));
  }
  assert.equal(prediction.prediction.special_number_insights.range.max, 8);
  assert.ok(prediction.prediction.special_number_insights.top_overdue.length > 0);
});

test("adds Power Lottery second-area statistical features to Gemini payload", () => {
  const payload = buildGeminiDecisionPayload({
    gameType: "power",
    draws: powerDraws,
    generatedAt: "2026-06-25T10:00:00+08:00",
  });

  assert.deepEqual(payload.secondary_number_range, { min: 1, max: 8, picks: 1 });
  assert.equal(payload.quantitative_features.second_area.raw_history_policy, "server_computed_special_number_only");
  assert.ok(payload.quantitative_features.second_area.all_time_hot.length > 0);
  assert.ok(payload.quantitative_features.second_area.top_overdue.length > 0);
});

test("keeps Power Lottery second-area prediction deterministic after Gemini enhancement", () => {
  const base = generatePrediction({
    gameType: "power",
    draws: powerDraws,
    generatedAt: "2026-06-25T10:00:00+08:00",
  });
  const payload = buildGeminiDecisionPayload({
    gameType: "power",
    draws: powerDraws,
    generatedAt: "2026-06-25T10:00:00+08:00",
  });
  const decision = {
    reasoning: "Gemini may rank first-area numbers, but second area remains server-computed.",
    strategy_weights: {
      "激進包牌": { prefer: [38, 37, 36, 35, 34, 33], avoid: [] },
      "穩健平衡": { prefer: [4, 8, 10, 24, 31, 37], avoid: [] },
      "統計趨勢": { prefer: [1, 2, 24, 31, 34, 38], avoid: [] },
    },
    candidate_pool: [
      { number: 38, score: 0.99 },
      { number: 37, score: 0.98 },
      { number: 36, score: 0.97 },
      { number: 35, score: 0.96 },
      { number: 34, score: 0.95 },
      { number: 33, score: 0.94 },
    ],
  };

  const record = applyGeminiQuantDecision({
    baseRecord: base,
    decision,
    payload,
    draws: powerDraws,
  });

  assert.deepEqual(record.prediction.special_combinations, base.prediction.special_combinations);
  assert.ok(record.prediction.verification.valid);
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

test("builds Power Lottery LINE message with first and second areas", () => {
  const prediction = generatePrediction({
    gameType: "power",
    draws: powerDraws,
    generatedAt: "2026-06-25T10:00:00+08:00",
  });

  const message = buildLineMessage(prediction, "2026-06-25");

  assert.match(message, /威力彩/);
  assert.match(message, /第一區：/);
  assert.match(message, /第二區：/);
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
  assert.ok(insights.selected_numbers);
  const picked = Object.values(prediction.prediction.combinations).flat();
  const firstPicked = String(picked[0]);
  assert.equal(insights[firstPicked].reason, insights.selected_numbers[firstPicked].reason);
  assert.ok(insights.selected_numbers[firstPicked].reason.includes("近 5 期") || insights.selected_numbers[firstPicked].reason.includes("已隔"));
});

test("builds Gemini payload with server-computed features and omits raw draw history", () => {
  const payload = buildGeminiDecisionPayload({
    gameType: "539",
    draws: dailyDraws,
    generatedAt: "2026-06-12T14:35:16+08:00",
  });

  assert.equal(payload.game_name, "今彩539");
  assert.equal(Object.hasOwn(payload, "full_history"), false);
  assert.equal(payload.quantitative_features.full_history_sample_size, dailyDraws.length);
  assert.equal(payload.quantitative_features.raw_history_policy, "omitted_from_prompt");
  assert.ok(payload.quantitative_features.trend_windows["5"].hot.length > 0);
  assert.ok(payload.quantitative_features.methodology.includes("statistical"));
});

test("normalizes recent ASI learning records for Gemini context", () => {
  const context = buildAsiLearningContext([
    {
      game_name: "今彩539",
      target_draw_date: "2026-06-17",
      matched_numbers: [10, 8],
      missed_numbers: [3, 1, 2],
      strategy_effectiveness: {
        balanced: { hits: 2, analysis: "balanced caught recurring mid-zone numbers" },
      },
      next_adjustments: [
        "降低過冷號碼的單次權重。",
        "補強近期同開號碼與遺漏區間的交叉驗證。",
      ],
      reasoning_source: "gemini_quantitative",
      model_name: "gemini-2.5-flash",
    },
  ]);

  assert.equal(context.length, 1);
  assert.equal(context[0].game_name, "今彩539");
  assert.deepEqual(context[0].matched_numbers, [8, 10]);
  assert.deepEqual(context[0].missed_numbers, [1, 2, 3]);
  assert.ok(context[0].lessons.includes("降低過冷號碼的單次權重。"));
  assert.ok(context[0].strategy_notes[0].includes("balanced"));
});

test("adds ASI learning memory into Gemini decision payload", () => {
  const payload = buildGeminiDecisionPayload({
    gameType: "539",
    draws: dailyDraws,
    generatedAt: "2026-06-18T10:00:00+08:00",
    learningRecords: [
      {
        game_name: "今彩539",
        target_draw_date: "2026-06-17",
        matched_numbers: [8],
        missed_numbers: [2, 4, 6],
        strategy_effectiveness: { aggressive: { hits: 1, analysis: "too cold-heavy" } },
        next_adjustments: ["降低冷門反彈假設的權重。"],
      },
    ],
  });

  assert.equal(payload.asi_learning_memory.length, 1);
  assert.equal(payload.asi_learning_memory[0].target_draw_date, "2026-06-17");
  assert.ok(payload.quantitative_features.methodology.includes("ASI learning"));
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
  const aggressive = record.prediction.combinations["激進包牌"];
  assert.equal(aggressive.length, 5);
  assert.ok(maxConsecutiveRun(aggressive) < 4); // 新政策：不得出現 4 連號（即使 Gemini 偏好連號池）
  const preferredHonored = [35, 36, 37, 38, 39].filter((number) => aggressive.includes(number)).length;
  assert.ok(preferredHonored >= 4); // 仍盡量採用 Gemini 偏好號
  assert.ok(record.prediction.number_insights.selected_numbers["39"].reason.includes("Gemini 量化訊號"));
  assert.equal(record.prediction.number_insights["39"].metaphysics_signal, "尾數 9");
  assert.ok(record.prediction.verification.valid);
  assert.ok(record.prediction.backtest.window_size > 0);
});

test("diversifies Gemini strategies when preference pools overlap", () => {
  const base = generatePrediction({
    gameType: "539",
    draws: dailyDraws,
    generatedAt: "2026-06-15T10:05:00+08:00",
  });
  const payload = buildGeminiDecisionPayload({
    gameType: "539",
    draws: dailyDraws,
    generatedAt: "2026-06-15T10:05:00+08:00",
  });
  const decision = {
    reasoning: "Gemini deliberately gives two strategies the same first-choice pool.",
    strategy_weights: {
      "激進包牌": { prefer: [39, 38, 37, 36, 35], avoid: [] },
      "穩健平衡": { prefer: [2, 8, 20, 28, 31, 35, 12], avoid: [] },
      "統計趨勢": { prefer: [2, 8, 20, 28, 31, 35, 12, 15], avoid: [] },
    },
    candidate_pool: [
      { number: 2, score: 0.99 },
      { number: 8, score: 0.98 },
      { number: 20, score: 0.97 },
      { number: 28, score: 0.96 },
      { number: 31, score: 0.95 },
      { number: 35, score: 0.94 },
      { number: 12, score: 0.93 },
      { number: 15, score: 0.92 },
    ],
  };

  const record = applyGeminiQuantDecision({
    baseRecord: base,
    decision,
    payload,
    draws: dailyDraws,
  });
  const balanced = record.prediction.combinations["穩健平衡"];
  const trend = record.prediction.combinations["統計趨勢"];
  const overlap = trend.filter((number) => balanced.includes(number)).length;

  assert.notDeepEqual(trend, balanced);
  assert.ok(overlap <= 3);
  assert.ok(record.prediction.verification.valid);
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

test("calculates next Power Lottery draw date as Monday or Thursday", () => {
  assert.equal(nextDrawDate("power", "2026-06-19"), "2026-06-22");
  assert.equal(nextDrawDate("power", "2026-06-22"), "2026-06-25");
});

test("targets the same draw date for 10 AM draw-day predictions", () => {
  assert.equal(predictionTargetDate("539", "2026-06-15"), "2026-06-15");
  assert.equal(predictionTargetDate("649", "2026-06-16"), "2026-06-16");
  assert.equal(predictionTargetDate("power", "2026-06-25"), "2026-06-25");
  assert.equal(predictionTargetDate("539", "2026-06-14"), null);
  assert.equal(predictionTargetDate("649", "2026-06-15"), null);
  assert.equal(predictionTargetDate("power", "2026-06-23"), null);
});

test("due games are only games drawing on that calendar date", () => {
  assert.deepEqual(dueGamesForDate("2026-06-15"), ["539", "power"]);
  assert.deepEqual(dueGamesForDate("2026-06-16"), ["539", "649"]);
  assert.deepEqual(dueGamesForDate("2026-06-25"), ["539", "power"]);
  assert.deepEqual(dueGamesForDate("2026-06-14"), []);
});

test("detects notifications sent before draw-day 10 AM release time", () => {
  assert.equal(notificationSentBeforeRelease("2026-06-13T14:25:33Z", "2026-06-15"), true);
  assert.equal(notificationSentBeforeRelease("2026-06-15T01:59:59Z", "2026-06-15"), true);
  assert.equal(notificationSentBeforeRelease("2026-06-15T02:00:00Z", "2026-06-15"), false);
  assert.equal(notificationSentBeforeRelease(null, "2026-06-15"), false);
});

function maxConsecutiveRun(numbers) {
  const sorted = [...numbers].sort((a, b) => a - b);
  let run = 1;
  let best = 1;
  for (let i = 1; i < sorted.length; i += 1) {
    run = sorted[i] === sorted[i - 1] + 1 ? run + 1 : 1;
    best = Math.max(best, run);
  }
  return best;
}

test("honest game-theory engine: fairness diagnostic + low-split combinations + honest message", () => {
  for (const [gameType, draws] of [["539", dailyDraws], ["power", powerDraws]]) {
    const record = generateHonestPrediction({ gameType, draws, generatedAt: "2026-06-30T10:00:00+08:00" });
    assert.equal(record.prediction.model, "game-theory-v1");
    assert.equal(record.prediction.reasoning_source, "honest_game_theory");
    assert.equal(typeof record.prediction.fairness_diagnostic.uniform_p, "number");
    const combos = record.prediction.combinations;
    assert.equal(Object.keys(combos).length, 2);             // 兩組：穩健平衡 + 心跳明牌
    assert.ok("穩健平衡" in combos);
    assert.ok("心跳明牌" in combos);
    const maxN = { "539": 39, power: 38 }[gameType];
    const k = { "539": 5, power: 6 }[gameType];
    const balanced = combos["穩健平衡"];
    assert.equal(balanced.length, k);                        // 一組 k 顆
    assert.equal(new Set(balanced).size, balanced.length);   // 不重複
    assert.ok(maxConsecutiveRun(balanced) < 4);              // 無長連號
    assert.ok(balanced.every((n) => n >= 1 && n <= maxN));   // 範圍內
    // 心跳明牌：依節奏挑號 + 內附 walk-forward 校正回歸
    const heartbeat = record.prediction.heartbeat;
    assert.ok(Array.isArray(heartbeat.combination) && heartbeat.combination.length >= 1);
    assert.deepEqual(combos["心跳明牌"], heartbeat.combination);
    assert.equal(typeof heartbeat.calibration.hit_rate, "number");
    assert.equal(typeof heartbeat.calibration.base_rate, "number");
    const message = buildLineMessage(record, "2026-06-30");
    assert.ok(message.includes("公正性健診"));
    assert.ok(message.includes("不預測號碼") || message.includes("不預測"));
    assert.ok(message.includes("穩健平衡"));
    assert.ok(message.includes("心跳明牌"));
    assert.ok(!message.includes("AI 樂透預測"));
  }
});

test("generateAdaptivePrediction stores two groups, baseline state, and forecast evidence", () => {
  const result = generateAdaptivePrediction({
    gameType: "539",
    draws: dailyDraws,
    generatedAt: "2026-07-10T10:00:00+08:00",
    targetDrawDate: "2026-07-10",
    dataStatus: "fresh",
  });

  assert.equal(result.record.prediction.model, "lai-v2");
  assert.deepEqual(Object.keys(result.record.prediction.combinations), ["機率主攻", "覆蓋探索"]);
  assert.equal(result.record.prediction.agent_status, "baseline");
  assert.equal(result.record.prediction.agent_state_version, 0);
  assert.ok(result.record.prediction.expert_weights.uniform > 0);
  assert.equal(result.record.prediction.evidence.target_draw_date, "2026-07-10");
  assert.equal(result.record.prediction.evidence.model_version, "lai-v2");
  assert.equal(result.record.prediction.evidence.state_status, "baseline");
  assert.equal(result.record.prediction.evidence.last_learned_draw_date, null);
  assert.equal(result.record.prediction.evidence.champion_model, "uniform");
  assert.equal(result.record.prediction.evidence.data_status, "fresh");
  assert.equal(Object.hasOwn(result.record.prediction, "forecasts"), false);
  assert.ok(Array.isArray(result.forecasts));
  assert.ok(result.forecasts.length >= 2);
  assert.ok(result.forecasts.some((forecast) => forecast.name === "ensemble"));
  for (const forecast of result.forecasts) {
    assert.equal(forecast.evidence.target_draw_date, "2026-07-10");
    assert.equal(forecast.evidence.model_version, "lai-v2");
    assert.equal(forecast.evidence.state_status, "baseline");
    assert.equal(forecast.evidence.data_status, "fresh");
  }

  const ensemble = result.forecasts.find((forecast) => forecast.name === "ensemble");
  assert.deepEqual(ensemble.final_groups.combinations, result.record.prediction.combinations);
});

test("generateAdaptivePrediction emits exactly two legal Lotto649 groups", () => {
  const result = generateAdaptivePrediction({
    gameType: "649",
    draws: lotto649Draws,
    generatedAt: "2026-07-14T10:00:00+08:00",
    targetDrawDate: "2026-07-14",
    dataStatus: "fresh",
  });

  const combinations = result.record.prediction.combinations;
  assert.deepEqual(Object.keys(combinations), ["機率主攻", "覆蓋探索"]);
  assert.equal(Object.hasOwn(result.record.prediction, "special_combinations"), false);
  assert.notDeepEqual(combinations["機率主攻"], combinations["覆蓋探索"]);
  for (const numbers of Object.values(combinations)) {
    assert.equal(numbers.length, 6);
    assert.equal(new Set(numbers).size, 6);
    assert.deepEqual(numbers, [...numbers].sort((a, b) => a - b));
    assert.ok(numbers.every((number) => number >= 1 && number <= 49));
  }
});

test("generateAdaptivePrediction keeps Power Lottery first and second areas in two independent groups", () => {
  const result = generateAdaptivePrediction({
    gameType: "power",
    draws: powerDraws,
    generatedAt: "2026-07-13T10:00:00+08:00",
    targetDrawDate: "2026-07-13",
    dataStatus: "stale",
  });

  const combinations = result.record.prediction.combinations;
  const special = result.record.prediction.special_combinations;
  assert.deepEqual(Object.keys(combinations), ["機率主攻", "覆蓋探索"]);
  assert.deepEqual(Object.keys(special), ["機率主攻", "覆蓋探索"]);
  assert.notDeepEqual(combinations["機率主攻"], combinations["覆蓋探索"]);
  assert.notDeepEqual(special["機率主攻"], special["覆蓋探索"]);
  for (const numbers of Object.values(combinations)) {
    assert.equal(numbers.length, 6);
    assert.equal(new Set(numbers).size, 6);
    assert.deepEqual(numbers, [...numbers].sort((a, b) => a - b));
    assert.ok(numbers.every((number) => number >= 1 && number <= 38));
  }
  for (const numbers of Object.values(special)) {
    assert.equal(numbers.length, 1);
    assert.ok(numbers.every((number) => number >= 1 && number <= 8));
  }
});

test("generateAdaptivePrediction falls back to deterministic uniform Power special groups when only lstm is active", () => {
  const result = generateAdaptivePrediction({
    gameType: "power",
    draws: powerDraws,
    generatedAt: "2026-07-13T10:00:00+08:00",
    targetDrawDate: "2026-07-13",
    agentState: {
      status: "champion",
      state_version: 7,
      expert_weights: { lstm: 1 },
    },
    dataStatus: "stale",
  });

  const special = result.record.prediction.special_combinations;
  const repeat = generateAdaptivePrediction({
    gameType: "power",
    draws: powerDraws,
    generatedAt: "2026-07-13T10:00:00+08:00",
    targetDrawDate: "2026-07-13",
    agentState: {
      status: "champion",
      state_version: 7,
      expert_weights: { lstm: 1 },
    },
    dataStatus: "stale",
  });
  assert.equal(Object.keys(special).length, 2);
  assert.deepEqual(Object.keys(special), Object.keys(result.record.prediction.combinations));
  assert.equal(result.record.prediction.evidence.special_area_fallback, "deterministic_uniform_no_active_expert");
  assert.deepEqual(repeat.record.prediction.special_combinations, special);
  const specialGroups = Object.values(special);
  assert.notDeepEqual(specialGroups[0], specialGroups[1]);
  for (const numbers of specialGroups) {
    assert.equal(numbers.length, 1);
    assert.ok(numbers.every((number) => number >= 1 && number <= 8));
  }

  const lstmForecast = result.forecasts.find((forecast) => forecast.name === "lstm");
  assert.equal(
    lstmForecast?.featureSummary?.specialAreaFallback,
    "deterministic_uniform_no_active_expert",
  );
});

test("builds LAI LINE message with explicit evidence status, exactly two groups, and no guaranteed-hit claim", () => {
  const result = generateAdaptivePrediction({
    gameType: "539",
    draws: dailyDraws,
    generatedAt: "2026-07-10T10:00:00+08:00",
    targetDrawDate: "2026-07-10",
    dataStatus: "fresh",
  });

  const message = buildLineMessage(result.record, "2026-07-10");

  assert.match(message, /LAI v2/);
  assert.match(message, /agent_status:\s*baseline/);
  assert.match(message, /state_status:\s*baseline/);
  assert.match(message, /data_status:\s*fresh/);
  assert.match(message, /proven_above_random:\s*no/);
  assert.match(message, /union_size:\s*\d+/);
  assert.match(message, /overlap_count:\s*\d+/);
  assert.equal((message.match(/^\[/gm) || []).length, 2);
  assert.match(message, /提醒：本訊息僅提供量化分組、狀態與覆蓋資訊，不保證命中。/);
});

test("builds Power LAI LINE message with first and second areas for both groups", () => {
  const result = generateAdaptivePrediction({
    gameType: "power",
    draws: powerDraws,
    generatedAt: "2026-07-13T10:00:00+08:00",
    targetDrawDate: "2026-07-13",
    agentState: {
      status: "champion",
      state_version: 9,
      expert_weights: {
        uniform: 0.3,
        bayesian_frequency: 0.1,
        multi_window: 0.1,
        hazard: 0.1,
        cooccurrence: 0.1,
        markov: 0.1,
        lstm: 0.1,
        structure: 0.1,
      },
    },
    dataStatus: "fresh",
  });

  const message = buildLineMessage(result.record, "2026-07-13");

  assert.match(message, /agent_status:\s*champion/);
  assert.match(message, /proven_above_random:\s*yes/);
  assert.equal((message.match(/area_1/g) || []).length, 2);
  assert.equal((message.match(/area_2/g) || []).length, 2);
});

test("statistical strategies avoid 4+ consecutive runs; balanced strategy spreads across the range", () => {
  const cases = [
    ["539", dailyDraws, 39],
    ["power", powerDraws, 38],
  ];
  for (const [gameType, draws, maxNumber] of cases) {
    const record = generatePrediction({ gameType, draws, generatedAt: "2026-06-26T10:00:00+08:00" });
    const combinations = record.prediction.combinations;
    for (const [strategy, numbers] of Object.entries(combinations)) {
      assert.ok(
        maxConsecutiveRun(numbers) < 4,
        `${gameType} ${strategy} should not contain a 4+ consecutive run: ${numbers}`,
      );
    }
    const balanced = combinations["穩健平衡"];
    const spread = Math.max(...balanced) - Math.min(...balanced);
    assert.ok(
      spread >= maxNumber / 2,
      `${gameType} 穩健平衡 should span the range, got ${balanced} (spread ${spread})`,
    );
  }
});
