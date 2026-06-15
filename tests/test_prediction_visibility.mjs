import test from "node:test";
import assert from "node:assert/strict";

import {
  predictionHasDetailedInsight,
  predictionVisibleAtTaipei,
} from "../frontend/src/services/predictionVisibility.js";

test("hides future target draw predictions before draw-day 10 AM Taipei time", () => {
  const prediction = { target_draw_date: "2026-06-15" };

  assert.equal(predictionVisibleAtTaipei(prediction, new Date("2026-06-14T23:59:59+08:00")), false);
  assert.equal(predictionVisibleAtTaipei(prediction, new Date("2026-06-15T09:59:59+08:00")), false);
  assert.equal(predictionVisibleAtTaipei(prediction, new Date("2026-06-15T10:00:00+08:00")), true);
});

test("keeps legacy predictions without target draw date visible", () => {
  assert.equal(predictionVisibleAtTaipei({ timestamp: "2026-06-12T10:00:00+08:00" }), true);
});

test("detects old low-detail statistical fallback predictions", () => {
  assert.equal(predictionHasDetailedInsight({
    prediction: {
      model: "supabase-statistical-v1",
      reasoning: "依最近 30 期開獎頻率、遺漏期數與平均和值產生三組推薦。此模型為統計輔助，不保證命中。",
      number_insights: {
        sample_size: 30,
        latest_draw_id: "115000143",
      },
    },
  }), false);
});

test("keeps statistical predictions that include per-number reasons", () => {
  assert.equal(predictionHasDetailedInsight({
    prediction: {
      model: "supabase-statistical-v1",
      reasoning: "近 300 期數據顯示最熱號碼為 8(49次)，並依三種策略建立推薦組合。",
      number_insights: {
        selected_numbers: {
          8: { reason: "近期熱門：近 300 期開出 49 次", tag: "hot" },
        },
      },
    },
  }), true);
});
