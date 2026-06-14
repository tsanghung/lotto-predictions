import test from "node:test";
import assert from "node:assert/strict";

import { predictionVisibleAtTaipei } from "../frontend/src/services/predictionVisibility.js";

test("hides future target draw predictions before draw-day 10 AM Taipei time", () => {
  const prediction = { target_draw_date: "2026-06-15" };

  assert.equal(predictionVisibleAtTaipei(prediction, new Date("2026-06-14T23:59:59+08:00")), false);
  assert.equal(predictionVisibleAtTaipei(prediction, new Date("2026-06-15T09:59:59+08:00")), false);
  assert.equal(predictionVisibleAtTaipei(prediction, new Date("2026-06-15T10:00:00+08:00")), true);
});

test("keeps legacy predictions without target draw date visible", () => {
  assert.equal(predictionVisibleAtTaipei({ timestamp: "2026-06-12T10:00:00+08:00" }), true);
});
