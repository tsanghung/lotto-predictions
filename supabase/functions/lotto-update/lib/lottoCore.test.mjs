import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPerformanceSnapshot,
  chooseFreshestDraw,
  evaluatePredictionRecord,
  isDaily539ExpectedDrawDate,
  needsSecondaryDaily539Check,
  parseAuzonetDaily539Html,
  parseOfficialPayload,
  toLottoDrawRow,
} from "./lottoCore.js";

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

test("checks Daily539 secondary source only after expected draw time", () => {
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
      taiwanHour: 19,
    }),
    false,
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
      },
      "穩健平衡": {
        hits: 5,
        matches: [6, 8, 18, 29, 31],
        miss_count: 0,
        missed_numbers: [],
      },
    },
    attribution_report: null,
    attribution_trigger: "supabase_edge_basic_evaluation",
  });
  assert.equal(evaluation.learning_report.version, "post_draw_learning_v1");
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
