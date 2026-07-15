import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import * as lottoCore from "./lottoCore.js";

import {
  buildAsiLearningRecord,
  buildPerformanceSnapshot,
  chooseFreshestDraw,
  evaluatePredictionRecord,
  isDaily539ExpectedDrawDate,
  needsSecondaryDaily539Check,
  parseAuzonetDaily539Html,
  parseOfficialPayload,
  toLottoDrawRow,
} from "./lottoCore.js";

const updateIndexSource = await readFile(new URL("../index.ts", import.meta.url), "utf8");

function updateIndexSourceBetween(startMarker, endMarker) {
  const start = updateIndexSource.indexOf(startMarker);
  const end = updateIndexSource.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `Missing update index source marker: ${startMarker}`);
  assert.notEqual(end, -1, `Missing update index source marker: ${endMarker}`);
  return updateIndexSource.slice(start, end);
}

test("index wiring learns from matching forecasts and activates only after score upsert", () => {
  assert.match(
    updateIndexSource,
    /import\s*\{[^}]*runPostDrawLearning[^}]*\}\s*from\s*["']\.\/lib\/lottoCore\.js["']/s,
  );

  const source = updateIndexSourceBetween(
    "async function evaluateReadyPredictions",
    "async function updateGame",
  );
  assert.match(source, /await runPostDrawLearning\s*\(/);
  assert.match(source, /fetchForecasts:[^]*fetchUnscoredModelForecasts\s*\(/);
  assert.match(source, /fetchActiveState:[^]*fetchActiveAgentState\s*\(/);
  assert.match(source, /fetchAgentStateCheckpoint:[^]*fetchAgentStateCheckpoint\s*\(/);
  assert.match(source, /upsertModelScores:[^]*upsertModelScores\s*\(/);
  assert.match(source, /activateAgentState:[^]*activateAgentState\s*\(/);
  assert.match(source, /markPredictionEvaluated:[^]*markPredictionEvaluated\s*\(/);
  assert.match(source, /fetchScoreHistory:[^]*fetchModelScoreHistory\s*\(/);
});

test("index fetches real per-candidate score history through the current draw", () => {
  const source = updateIndexSourceBetween(
    "async function fetchModelScoreHistory",
    "async function upsertModelScores",
  );
  assert.match(source, /lotto_model_scores/);
  assert.match(source, /forecast:lotto_model_forecasts!inner\(model_name\)/);
  assert.match(source, /game_name/);
  assert.match(source, /draw_date/);
  assert.match(source, /while\s*\(true\)/);
  assert.match(source, /limit/);
  assert.match(source, /offset/);
  assert.match(source, /if\s*\(!response\.ok\)\s*\{\s*throw new Error/s);
  assert.doesNotMatch(source, /Promise\.resolve\(\[\]\)/);
});

test("index wiring uses idempotent score and state endpoints with fail-fast errors", () => {
  const forecastSource = updateIndexSourceBetween(
    "async function fetchUnscoredModelForecasts",
    "async function upsertModelScores",
  );
  assert.match(forecastSource, /lotto_model_forecasts/);
  assert.match(forecastSource, /game_name/);
  assert.match(forecastSource, /target_draw_date/);
  assert.match(forecastSource, /if\s*\(!response\.ok\)\s*\{\s*throw new Error/s);

  const scoreSource = updateIndexSourceBetween(
    "async function upsertModelScores",
    "async function activateAgentState",
  );
  assert.match(scoreSource, /lotto_model_scores\?on_conflict=forecast_id,draw_id/);
  assert.match(scoreSource, /resolution=merge-duplicates/);
  assert.match(scoreSource, /if\s*\(!response\.ok\)\s*\{\s*throw new Error/s);

  const activationSource = updateIndexSourceBetween(
    "async function activateAgentState",
    "async function fetchReadyPredictions",
  );
  assert.match(activationSource, /rpc\/activate_lotto_agent_state/);
  assert.match(activationSource, /if\s*\(!response\.ok\)\s*\{\s*throw new Error/s);
  assert.match(activationSource, /const\s+payload\s*=\s*await\s+response\.json\(\)/);
  assert.match(activationSource, /return\s+activated/);
  assert.doesNotMatch(`${forecastSource}${scoreSource}${activationSource}`, /console\.warn/);
});

test("index wiring passes fetched LAI metrics into the performance snapshot", () => {
  const source = updateIndexSourceBetween(
    "async function rebuildPerformanceSnapshot",
    "async function fetchDrawForPrediction",
  );
  assert.match(source, /fetchLaiPerformanceByGame\s*\(/);
  assert.match(
    source,
    /buildPerformanceSnapshot\s*\(\s*evaluatedPredictions\s*,[^,]+,\s*laiByGame\s*\)/s,
  );
});

test("scores every saved model probability against the draw", () => {
  const score = lottoCore.scoreModelForecast({
    forecast: {
      id: "forecast-539",
      game_name: "今彩539",
      model_name: "uniform",
      probabilities: Array(39).fill(5 / 39),
      final_groups: {
        combinations: {
          "機率主攻": [1, 2, 3, 4, 5],
          "覆蓋探索": [6, 7, 8, 9, 10],
        },
      },
    },
    draw: {
      draw_id: "115000160",
      draw_date: "2026-07-10",
      numbers: [1, 2, 3, 4, 5],
      special_number: null,
    },
    config: { maxNumber: 39, picks: 5 },
  });

  assert.ok(Number.isFinite(score.metrics.brier));
  assert.ok(Number.isFinite(score.metrics.log_loss));
  assert.equal(score.metrics.coverage.union_hits, 5);
});

test("same forecast and draw produce the same score payload", () => {
  const input = {
    forecast: {
      id: "forecast-deterministic",
      game_name: "今彩539",
      model_name: "markov",
      probabilities: Array(39).fill(5 / 39),
      final_groups: {
        combinations: {
          "機率主攻": [1, 2, 3, 4, 5],
          "覆蓋探索": [5, 6, 7, 8, 9],
        },
      },
    },
    draw: {
      draw_id: "115000160",
      draw_date: "2026-07-10",
      numbers: [1, 2, 3, 4, 5],
      special_number: null,
    },
    config: { maxNumber: 39, picks: 5 },
  };

  assert.deepEqual(
    lottoCore.scoreModelForecast(input),
    lottoCore.scoreModelForecast(input),
  );
});

test("scores Power Lottery main and special areas independently", () => {
  const score = lottoCore.scoreModelForecast({
    forecast: {
      id: "forecast-power",
      game_name: "威力彩",
      model_name: "uniform",
      probabilities: Array(38).fill(6 / 38),
      special_probabilities: Array(8).fill(1 / 8),
      final_groups: {
        combinations: {
          "機率主攻": [1, 2, 3, 4, 5, 6],
          "覆蓋探索": [6, 7, 8, 9, 10, 11],
        },
        special_combinations: {
          "機率主攻": [3],
          "覆蓋探索": [7],
        },
      },
    },
    draw: {
      draw_id: "115000055",
      draw_date: "2026-07-13",
      numbers: [1, 2, 3, 4, 5, 6],
      special_number: 3,
    },
    config: {
      maxNumber: 38,
      picks: 6,
      secondaryNumber: { maxNumber: 8, picks: 1 },
    },
  });

  assert.ok(Number.isFinite(score.metrics.brier));
  assert.ok(Number.isFinite(score.metrics.log_loss));
  assert.equal(score.metrics.coverage.union_hits, 6);
  assert.ok(Number.isFinite(score.metrics.special_area.brier));
  assert.ok(Number.isFinite(score.metrics.special_area.log_loss));
  assert.deepEqual(score.metrics.special_area.coverage, {
    group_a_hits: 1,
    group_b_hits: 0,
    union_hits: 1,
    overlap_count: 0,
    union_size: 2,
  });
});

test("Power score records an explicit reason when special probabilities are unavailable", () => {
  const score = lottoCore.scoreModelForecast({
    forecast: {
      id: "forecast-power-missing-special",
      game_name: "威力彩",
      model_name: "markov",
      probabilities: Array(38).fill(6 / 38),
      special_probabilities: null,
      final_groups: { combinations: {} },
    },
    draw: {
      draw_id: "115000055",
      draw_date: "2026-07-13",
      numbers: [1, 2, 3, 4, 5, 6],
      special_number: 3,
    },
    config: {
      maxNumber: 38,
      picks: 6,
      secondaryNumber: { maxNumber: 8, picks: 1 },
    },
  });

  assert.deepEqual(score.metrics.special_area, {
    available: false,
    reason: "special_probabilities_unavailable",
  });
});

function candidateScore({ draw, modelName, brier, unionHits = 4 }) {
  return {
    forecast_id: `${modelName}-${draw}`,
    game_name: "今彩539",
    model_name: modelName,
    draw_id: String(115000000 + draw),
    draw_date: `2026-${String(1 + Math.floor((draw - 1) / 28)).padStart(2, "0")}-${String(1 + ((draw - 1) % 28)).padStart(2, "0")}`,
    metrics: {
      brier,
      coverage: { union_hits: unionHits },
    },
  };
}

test("builds deterministic per-candidate promotion metrics through the current draw", () => {
  assert.equal(typeof lottoCore.buildCandidatePromotionDecision, "function");
  const scoreHistory = [];
  for (let draw = 1; draw <= 39; draw += 1) {
    scoreHistory.push(
      candidateScore({ draw, modelName: "uniform", brier: 0.12 }),
      candidateScore({ draw, modelName: "markov", brier: 0.08 }),
      candidateScore({ draw, modelName: "lstm", brier: 0.14, unionHits: 3 }),
    );
  }
  const currentScores = [
    candidateScore({ draw: 40, modelName: "uniform", brier: 0.12 }),
    candidateScore({ draw: 40, modelName: "markov", brier: 0.08 }),
    candidateScore({ draw: 40, modelName: "lstm", brier: 0.01, unionHits: 3 }),
  ];
  const input = {
    scoreHistory,
    currentScores,
    candidateNames: ["markov", "lstm"],
    baselineName: "uniform",
    picks: 5,
    throughDraw: currentScores[0],
  };

  const decision = lottoCore.buildCandidatePromotionDecision(input);

  assert.deepEqual(lottoCore.buildCandidatePromotionDecision(input), decision);
  assert.equal(decision.candidateModel, "markov");
  assert.equal(decision.promotion.promoted, true);
  assert.equal(decision.metrics.candidateModel, "markov");
  assert.equal(decision.metrics.productionSamples, 40);
  assert.ok(Math.abs(decision.metrics.recent100Skill - (1 / 3)) < 1e-12);
  assert.ok(Math.abs(decision.metrics.recent500Skill - (1 / 3)) < 1e-12);
  assert.ok(decision.metrics.bootstrapLower95 > 0);
  assert.ok(decision.metrics.adjustedQ <= 0.05);
  assert.equal(decision.metrics.unionCoverageDelta, 0);
  assert.ok(decision.candidates.markov.pValue <= decision.candidates.markov.adjustedQ);
  assert.ok(decision.candidates.lstm.adjustedQ >= decision.candidates.lstm.pValue);
});

test("missing paired candidate history cannot promote away from baseline", () => {
  const decision = lottoCore.buildCandidatePromotionDecision({
    scoreHistory: Array.from({ length: 40 }, (_, index) =>
      candidateScore({ draw: index + 1, modelName: "markov", brier: 0.01 })),
    currentScores: [],
    candidateNames: ["markov"],
    baselineName: "uniform",
    picks: 5,
  });
  const activeState = {
    game_name: "今彩539",
    state_version: 4,
    status: "baseline",
    champion_model: "uniform",
    expert_weights: { uniform: 0.5, markov: 0.5 },
    learning_config: { gamma: 0.1 },
    metrics: { evaluated_draws: 40 },
    last_learned_draw_id: "115000039",
    last_learned_draw_date: "2026-02-11",
  };
  const next = lottoCore.buildNextAgentState({
    activeState,
    scoredForecasts: [
      { model_name: "uniform", metrics: { brier: 0.12 } },
      { model_name: "markov", metrics: { brier: 0.01 } },
    ],
    draw: { draw_id: "115000040", draw_date: "2026-02-12" },
    promotionDecision: decision,
  });

  assert.equal(decision.candidateModel, null);
  assert.equal(decision.promotion.promoted, false);
  assert.equal(next.status, "baseline");
  assert.equal(next.champion_model, "uniform");
});

test("next state promotes only the candidate whose own metrics passed every gate", () => {
  const activeState = {
    game_name: "今彩539",
    state_version: 4,
    status: "baseline",
    champion_model: "uniform",
    expert_weights: { uniform: 0.34, markov: 0.33, lstm: 0.33 },
    learning_config: { gamma: 0.1 },
    metrics: { evaluated_draws: 40 },
    last_learned_draw_id: "115000039",
    last_learned_draw_date: "2026-02-11",
  };
  const scoredForecasts = [
    { model_name: "uniform", metrics: { brier: 0.12 } },
    { model_name: "markov", metrics: { brier: 0.08 } },
    { model_name: "lstm", metrics: { brier: 0.01 } },
  ];
  const passingMetrics = {
    candidateModel: "markov",
    productionSamples: 40,
    recent100Skill: 0.2,
    recent500Skill: 0.2,
    bootstrapLower95: 0.1,
    adjustedQ: 0.01,
    unionCoverageDelta: 0,
  };
  const next = lottoCore.buildNextAgentState({
    activeState,
    scoredForecasts,
    draw: { draw_id: "115000040", draw_date: "2026-02-12" },
    promotionDecision: {
      candidateModel: "markov",
      metrics: passingMetrics,
      promotion: { promoted: true, reason: "all_gates_passed" },
      candidates: {},
    },
  });
  const mismatched = lottoCore.buildNextAgentState({
    activeState,
    scoredForecasts,
    draw: { draw_id: "115000040", draw_date: "2026-02-12" },
    promotionDecision: {
      candidateModel: "lstm",
      metrics: passingMetrics,
      promotion: { promoted: true, reason: "all_gates_passed" },
      candidates: {},
    },
  });

  assert.equal(next.status, "champion");
  assert.equal(next.champion_model, "markov");
  assert.equal(mismatched.status, "baseline");
  assert.equal(mismatched.champion_model, "uniform");
});

test("next state records one draw checkpoint and normalized weights", () => {
  const activeState = {
    game_name: "今彩539",
    state_version: 4,
    status: "baseline",
    champion_model: "uniform",
    expert_weights: { uniform: 0.5, markov: 0.5 },
    learning_config: { gamma: 0.1 },
    metrics: { evaluated_draws: 8 },
    last_learned_draw_id: "115000159",
    last_learned_draw_date: "2026-07-09",
  };
  const draw = {
    draw_id: "115000160",
    draw_date: "2026-07-10",
    numbers: [1, 2, 3, 4, 5],
  };
  const scoredForecasts = [
    { model_name: "uniform", metrics: { brier: 0.12 } },
    { model_name: "markov", metrics: { brier: 0.08 } },
  ];

  const next = lottoCore.buildNextAgentState({
    activeState,
    scoredForecasts,
    draw,
    promotionMetrics: { productionSamples: 9 },
  });

  assert.equal(next.state_version, 5);
  assert.equal(next.last_learned_draw_id, "115000160");
  assert.equal(next.last_learned_draw_date, "2026-07-10");
  assert.equal(next.metrics.evaluated_draws, 9);
  assert.equal(
    Number(Object.values(next.expert_weights).reduce((sum, weight) => sum + weight, 0).toFixed(10)),
    1,
  );
  assert.ok(Object.values(next.expert_weights).every(Number.isFinite));
});

test("next state is idempotent when the draw was already learned", () => {
  const result = lottoCore.buildNextAgentState({
    activeState: {
      game_name: "今彩539",
      state_version: 5,
      status: "baseline",
      champion_model: "uniform",
      expert_weights: { uniform: 1 },
      learning_config: {},
      metrics: { evaluated_draws: 9 },
      last_learned_draw_id: "115000160",
      last_learned_draw_date: "2026-07-10",
    },
    scoredForecasts: [{ model_name: "uniform", metrics: { brier: 0.12 } }],
    draw: {
      draw_id: "115000160",
      draw_date: "2026-07-10",
      numbers: [1, 2, 3, 4, 5],
    },
    promotionMetrics: {},
  });

  assert.deepEqual(result, { status: "already_learned" });
});

test("parses Taiwan Lottery Daily539 official payload", () => {
  const payload = {
    rtCode: 0,
    content: {
      daily539Res: [
        {
          period: "115000142",
          lotteryDate: "2026-06-11T00:00:00",
          drawNumberSize: [29, 20, 8, 15, 31],
        },
      ],
    },
  };

  const draws = parseOfficialPayload("539", payload);

  assert.deepEqual(draws, [
    {
      draw_id: "115000142",
      date: "2026-06-11",
      numbers: [8, 15, 20, 29, 31],
      special_number: null,
      source: "taiwan_lottery_official",
      raw: payload.content.daily539Res[0],
    },
  ]);
});

test("parses Taiwan Lottery Lotto649 official payload with special number", () => {
  const payload = {
    rtCode: 0,
    content: {
      lotto649Res: [
        {
          period: "115000060",
          lotteryDate: "2026-06-09T00:00:00",
          drawNumberSize: [13, 18, 25, 39, 40, 46, 31],
        },
      ],
    },
  };

  const draws = parseOfficialPayload("649", payload);

  assert.equal(draws[0].draw_id, "115000060");
  assert.deepEqual(draws[0].numbers, [13, 18, 25, 39, 40, 46]);
  assert.equal(draws[0].special_number, 31);
});

test("parses Taiwan Lottery Power Lottery official payload with second area", () => {
  const payload = {
    rtCode: 0,
    content: {
      superLotto638Res: [
        {
          period: "115000043",
          lotteryDate: "2026-05-28T00:00:00",
          drawNumberSize: [31, 1, 24, 38, 2, 34, 3],
        },
      ],
    },
  };

  const draws = parseOfficialPayload("power", payload);

  assert.equal(draws[0].draw_id, "115000043");
  assert.equal(draws[0].date, "2026-05-28");
  assert.deepEqual(draws[0].numbers, [1, 2, 24, 31, 34, 38]);
  assert.equal(draws[0].special_number, 3);
});

test("parses Auzonet Daily539 HTML as the secondary source", () => {
  const html = `
    <section>
      <h2>大樂透開獎號碼</h2>
      <span>第115000060期</span>
      <time>2026-06-09(二)</time>
      <div>開出號碼：</div>
      <b>13</b><b>18</b><b>25</b><b>39</b><b>40</b><b>46</b>
    </section>
    <section>
      <h2>今彩539開獎號碼</h2>
      <span>第115000142期</span>
      <time>2026-06-11(四)</time>
      <div>開出號碼：</div>
      <b>29</b><b>20</b><b>08</b><b>15</b><b>31</b>
    </section>
  `;

  const draw = parseAuzonetDaily539Html(html);

  assert.deepEqual(draw, {
    draw_id: "115000142",
    date: "2026-06-11",
    numbers: [8, 15, 20, 29, 31],
    special_number: null,
    source: "auzonet",
    raw: { source: "auzonet" },
  });
});

test("uses secondary draw when official Daily539 data is stale", () => {
  const official = {
    draw_id: "115000141",
    date: "2026-06-10",
    numbers: [1, 4, 32, 35, 39],
    special_number: null,
  };
  const secondary = {
    draw_id: "115000142",
    date: "2026-06-11",
    numbers: [8, 15, 20, 29, 31],
    special_number: null,
  };

  const selected = chooseFreshestDraw(official, secondary);

  assert.equal(selected.draw_id, "115000142");
});

test("rejects same Daily539 draw with conflicting numbers", () => {
  const official = {
    draw_id: "115000142",
    date: "2026-06-11",
    numbers: [8, 15, 20, 29, 31],
    special_number: null,
  };
  const secondary = {
    draw_id: "115000142",
    date: "2026-06-11",
    numbers: [8, 15, 20, 29, 30],
    special_number: null,
  };

  assert.throws(
    () => chooseFreshestDraw(official, secondary),
    /conflicting numbers/,
  );
});

test("checks Daily539 secondary source whenever expected draw data is stale", () => {
  assert.equal(isDaily539ExpectedDrawDate("2026-06-11"), true);
  assert.equal(isDaily539ExpectedDrawDate("2026-06-07"), false);

  assert.equal(
    needsSecondaryDaily539Check({
      latestOfficialDate: "2026-06-10",
      targetDate: "2026-06-11",
      taiwanHour: 22,
    }),
    true,
  );

  assert.equal(
    needsSecondaryDaily539Check({
      latestOfficialDate: "2026-06-10",
      targetDate: "2026-06-11",
      taiwanHour: 6,
    }),
    true,
  );
});

test("maps draw to Supabase row", () => {
  const row = toLottoDrawRow("539", {
    draw_id: "115000142",
    date: "2026-06-11",
    numbers: [8, 15, 20, 29, 31],
    special_number: null,
    source: "taiwan_lottery_official",
    raw: { period: "115000142" },
  });

  assert.deepEqual(row, {
    game_name: "今彩539",
    draw_id: "115000142",
    draw_date: "2026-06-11",
    numbers: [8, 15, 20, 29, 31],
    special_number: null,
    raw: {
      source: "taiwan_lottery_official",
      payload: { period: "115000142" },
    },
  });
});

test("maps Power Lottery draw to Supabase row", () => {
  const row = toLottoDrawRow("power", {
    draw_id: "115000043",
    date: "2026-05-28",
    numbers: [1, 2, 24, 31, 34, 38],
    special_number: 3,
    source: "taiwan_lottery_official",
    raw: { period: "115000043" },
  });

  assert.deepEqual(row, {
    game_name: "威力彩",
    draw_id: "115000043",
    draw_date: "2026-05-28",
    numbers: [1, 2, 24, 31, 34, 38],
    special_number: 3,
    raw: {
      source: "taiwan_lottery_official",
      payload: { period: "115000043" },
    },
  });
});

test("evaluates a prediction record against its target draw", () => {
  const evaluation = evaluatePredictionRecord(
    {
      prediction: {
        combinations: {
          "激進包牌": [1, 6, 18, 29, 33],
          "穩健平衡": [6, 8, 18, 29, 31],
        },
      },
    },
    {
      draw_id: "115000143",
      draw_date: "2026-06-12",
      numbers: [6, 8, 18, 29, 31],
      special_number: null,
    },
  );

  assert.deepEqual({
    draw_id: evaluation.draw_id,
    draw_date: evaluation.draw_date,
    actual_numbers: evaluation.actual_numbers,
    special_number: evaluation.special_number,
    strategies: evaluation.strategies,
    attribution_report: evaluation.attribution_report,
    attribution_trigger: evaluation.attribution_trigger,
  }, {
    draw_id: "115000143",
    draw_date: "2026-06-12",
    actual_numbers: [6, 8, 18, 29, 31],
    special_number: null,
    strategies: {
      "激進包牌": {
        hits: 3,
        matches: [6, 18, 29],
        miss_count: 2,
        missed_numbers: [1, 33],
        special_hits: 0,
        special_matches: [],
        special_miss_count: 0,
        special_missed_numbers: [],
      },
      "穩健平衡": {
        hits: 5,
        matches: [6, 8, 18, 29, 31],
        miss_count: 0,
        missed_numbers: [],
        special_hits: 0,
        special_matches: [],
        special_miss_count: 0,
        special_missed_numbers: [],
      },
    },
    attribution_report: null,
    attribution_trigger: "supabase_edge_basic_evaluation",
  });
  assert.equal(evaluation.learning_report.version, "post_draw_learning_v1");
});

test("evaluates Power Lottery second-area special number matches", () => {
  const evaluation = evaluatePredictionRecord(
    {
      prediction: {
        combinations: {
          aggressive: [1, 2, 3, 4, 5, 6],
          balanced: [8, 10, 18, 24, 31, 37],
        },
        special_combinations: {
          aggressive: [3],
          balanced: [7],
        },
      },
    },
    {
      draw_id: "115000043",
      draw_date: "2026-05-28",
      numbers: [1, 2, 24, 31, 34, 38],
      special_number: 3,
    },
  );

  assert.deepEqual(evaluation.strategies.aggressive.special_matches, [3]);
  assert.equal(evaluation.strategies.aggressive.special_hits, 1);
  assert.deepEqual(evaluation.strategies.balanced.special_matches, []);
  assert.deepEqual(evaluation.strategies.balanced.special_missed_numbers, [7]);
  assert.equal(evaluation.special_number, 3);
});

test("builds post-draw learning report with hit, miss, and uncovered actual analysis", () => {
  const evaluation = evaluatePredictionRecord(
    {
      prediction: {
        combinations: {
          aggressive: [1, 2, 3, 4, 5],
          balanced: [2, 6, 7, 8, 9],
        },
        number_insights: {
          selected_numbers: {
            "1": { reason: "cold rebound candidate" },
            "2": { reason: "recent hot candidate" },
            "6": { reason: "overdue balance candidate" },
          },
        },
        ai_decision: {
          candidate_pool: [
            { number: 7, statistics_reason: "pair frequency support", metaphysics_signal: "tail 7" },
          ],
        },
      },
    },
    {
      draw_id: "115000144",
      draw_date: "2026-06-13",
      numbers: [2, 6, 10, 11, 12],
      special_number: null,
    },
  );

  assert.equal(evaluation.learning_report.version, "post_draw_learning_v1");
  assert.equal(evaluation.learning_report.summary.best_strategy, "balanced");
  assert.deepEqual(evaluation.learning_report.summary.uncovered_actual_numbers, [10, 11, 12]);

  const predictedTwo = evaluation.learning_report.predicted_numbers.find((item) => item.number === 2);
  assert.equal(predictedTwo.outcome, "hit");
  assert.deepEqual(predictedTwo.strategies, ["aggressive", "balanced"]);
  assert.equal(predictedTwo.selection_reason, "recent hot candidate");

  const predictedOne = evaluation.learning_report.predicted_numbers.find((item) => item.number === 1);
  assert.equal(predictedOne.outcome, "miss");
  assert.equal(predictedOne.selection_reason, "cold rebound candidate");

  const uncoveredTen = evaluation.learning_report.actual_numbers.find((item) => item.number === 10);
  assert.equal(uncoveredTen.was_predicted, false);
  assert.match(uncoveredTen.learning_note, /underweighted/i);

  assert.ok(evaluation.learning_report.strategy_reviews.balanced.analysis.includes("2 / 5"));
  assert.ok(evaluation.learning_report.next_prediction_guidance.length >= 3);
});

test("builds ASI learning record from evaluated prediction", () => {
  const predictionRecord = {
    source_key: "prediction|今彩539|2026-06-17",
    game_name: "今彩539",
    target_draw_date: "2026-06-17",
    prediction: {
      model: "gemini-2.5-flash",
      reasoning_source: "gemini_quantitative",
      combinations: {
        aggressive: [1, 2, 3, 4, 5],
        balanced: [8, 10, 15, 16, 37],
      },
      number_insights: {
        selected_numbers: {
          "8": { reason: "recent co-occurrence support" },
        },
      },
    },
  };
  const draw = {
    draw_id: "115000147",
    draw_date: "2026-06-17",
    numbers: [8, 10, 15, 16, 37],
    special_number: null,
  };
  const evaluation = evaluatePredictionRecord(predictionRecord, draw);
  const asi = buildAsiLearningRecord(predictionRecord, draw, evaluation);

  assert.equal(asi.game_name, "今彩539");
  assert.equal(asi.target_draw_date, "2026-06-17");
  assert.equal(asi.prediction_source_key, "prediction|今彩539|2026-06-17");
  assert.equal(asi.model_name, "gemini-2.5-flash");
  assert.equal(asi.reasoning_source, "gemini_quantitative");
  assert.deepEqual(asi.actual_numbers, [8, 10, 15, 16, 37]);
  assert.ok(asi.matched_numbers.includes(8));
  assert.equal(asi.selected_number_reasons["8"], "recent co-occurrence support");
  assert.ok(asi.next_adjustments.length >= 1);
  assert.equal(asi.raw_learning_report.version, "post_draw_learning_v1");
});

test("builds performance snapshot from latest evaluated prediction per target draw date", () => {
  const records = [
    {
      game_name: "Daily539",
      predicted_at: "2026-06-12T02:00:00+00:00",
      target_draw_date: "2026-06-12",
      is_evaluated: true,
      prediction: { combinations: { aggressive: [1, 2, 3, 4, 5] } },
      evaluation: {
        draw_id: "115000143",
        draw_date: "2026-06-12",
        strategies: {
          aggressive: { hits: 1, miss_count: 4 },
        },
      },
    },
    {
      game_name: "Daily539",
      predicted_at: "2026-06-13T02:00:00+00:00",
      target_draw_date: "2026-06-13",
      is_evaluated: true,
      prediction: { combinations: { aggressive: [1, 2, 3, 4, 5] } },
      evaluation: {
        draw_id: "115000144",
        draw_date: "2026-06-13",
        strategies: {
          aggressive: { hits: 2, miss_count: 3 },
        },
      },
    },
    {
      game_name: "Daily539",
      predicted_at: "2026-06-13T03:00:00+00:00",
      target_draw_date: "2026-06-13",
      is_evaluated: true,
      prediction: { combinations: { aggressive: [6, 7, 8, 9, 10] } },
      evaluation: {
        draw_id: "115000144",
        draw_date: "2026-06-13",
        strategies: {
          aggressive: { hits: 3, miss_count: 2 },
        },
      },
    },
    {
      game_name: "Daily539",
      predicted_at: "2026-06-15T02:00:00+00:00",
      target_draw_date: "2026-06-15",
      is_evaluated: false,
      prediction: { combinations: { aggressive: [1, 2, 3, 4, 5] } },
      evaluation: null,
    },
  ];

  const snapshot = buildPerformanceSnapshot(records, "2026-06-15T00:00:00.000Z");

  assert.equal(snapshot.last_updated, "2026-06-15T00:00:00.000Z");
  assert.equal(snapshot.games.Daily539.total_draws_evaluated, 2);
  assert.deepEqual(
    snapshot.games.Daily539.trend.map((item) => [item.date, item.draw_id, item.strategies.aggressive]),
    [
      ["2026-06-12", "115000143", 1],
      ["2026-06-13", "115000144", 3],
    ],
  );
  assert.deepEqual(snapshot.games.Daily539.strategies.aggressive, {
    total_hits: 4,
    total_misses: 6,
    win_rate: 0.4,
  });
});

test("extends performance snapshot with LAI metrics without replacing legacy fields", () => {
  const records = [{
    game_name: "Daily539",
    predicted_at: "2026-07-10T02:00:00+00:00",
    target_draw_date: "2026-07-10",
    is_evaluated: true,
    prediction: { combinations: { aggressive: [1, 2, 3, 4, 5] } },
    evaluation: {
      draw_id: "115000160",
      draw_date: "2026-07-10",
      strategies: { aggressive: { hits: 2, miss_count: 3 } },
    },
  }];

  const snapshot = buildPerformanceSnapshot(
    records,
    "2026-07-11T00:00:00.000Z",
    {
      Daily539: {
        latestMetrics: { brier_skill_score: 0.125 },
        latestState: { champion_model: "markov", status: "champion" },
        unionHits: 4,
        actualNumberCount: 5,
        groupAHits: 2,
        groupBHits: 3,
        evaluatedDraws: 1,
      },
    },
  );

  assert.deepEqual(snapshot.games.Daily539.strategies.aggressive, {
    total_hits: 2,
    total_misses: 3,
    win_rate: 0.4,
  });
  assert.deepEqual(snapshot.games.Daily539.lai, {
    brier_skill_score: 0.125,
    union_coverage_rate: 0.8,
    average_group_a_hits: 2,
    average_group_b_hits: 3,
    champion_model: "markov",
    agent_status: "champion",
  });
});

test("performance snapshot emits null when no ensemble Brier skill exists", () => {
  const records = [{
    game_name: "今彩539",
    target_draw_date: "2026-07-10",
    is_evaluated: true,
    prediction: { combinations: { aggressive: [1, 2, 3, 4, 5] } },
    evaluation: {
      draw_id: "115000160",
      draw_date: "2026-07-10",
      strategies: { aggressive: { hits: 1, miss_count: 4 } },
    },
  }];
  const snapshot = buildPerformanceSnapshot(records, "2026-07-11T00:00:00.000Z", {
    今彩539: {
      latestMetrics: {},
      latestState: { champion_model: "uniform", status: "baseline" },
      unionHits: 0,
      actualNumberCount: 0,
      groupAHits: 0,
      groupBHits: 0,
      evaluatedDraws: 0,
    },
  });

  assert.equal(snapshot.games["今彩539"].lai.brier_skill_score, null);
});

test("builds Power Lottery second-area cumulative hit rates", () => {
  const records = [
    {
      game_name: "威力彩",
      predicted_at: "2026-06-22T02:00:00+00:00",
      target_draw_date: "2026-06-22",
      is_evaluated: true,
      prediction: {
        combinations: {
          "激進包牌": [1, 2, 3, 4, 5, 6],
          "穩健平衡": [7, 8, 9, 10, 11, 12],
        },
        special_combinations: {
          "激進包牌": [3],
          "穩健平衡": [7],
        },
      },
      evaluation: {
        draw_id: "115000050",
        draw_date: "2026-06-22",
        strategies: {
          "激進包牌": { hits: 1, miss_count: 5, special_hits: 1, special_miss_count: 0 },
          "穩健平衡": { hits: 0, miss_count: 6, special_hits: 0, special_miss_count: 1 },
        },
      },
    },
    {
      game_name: "威力彩",
      predicted_at: "2026-06-25T02:00:00+00:00",
      target_draw_date: "2026-06-25",
      is_evaluated: true,
      prediction: {
        combinations: {
          "激進包牌": [1, 2, 3, 4, 5, 6],
          "穩健平衡": [7, 8, 9, 10, 11, 12],
        },
        special_combinations: {
          "激進包牌": [4],
          "穩健平衡": [8],
        },
      },
      evaluation: {
        draw_id: "115000051",
        draw_date: "2026-06-25",
        strategies: {
          "激進包牌": { hits: 0, miss_count: 6, special_hits: 0, special_miss_count: 1 },
          "穩健平衡": { hits: 2, miss_count: 4, special_hits: 1, special_miss_count: 0 },
        },
      },
    },
  ];

  const snapshot = buildPerformanceSnapshot(records, "2026-06-26T00:00:00.000Z");

  assert.deepEqual(snapshot.games["威力彩"].second_area, {
    label: "第二區",
    total_hits: 2,
    total_misses: 2,
    hit_rate: 0.5,
    strategies: {
      "激進包牌": { total_hits: 1, total_misses: 1, hit_rate: 0.5 },
      "穩健平衡": { total_hits: 1, total_misses: 1, hit_rate: 0.5 },
    },
  });
});
