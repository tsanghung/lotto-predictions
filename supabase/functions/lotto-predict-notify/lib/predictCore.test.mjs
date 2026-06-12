import test from "node:test";
import assert from "node:assert/strict";

import {
  buildLineMessage,
  generatePrediction,
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
  assert.equal(Object.keys(prediction.prediction.combinations).length, 3);
  for (const nums of Object.values(prediction.prediction.combinations)) {
    assert.equal(nums.length, 5);
    assert.equal(new Set(nums).size, 5);
    assert.deepEqual(nums, [...nums].sort((a, b) => a - b));
    assert.ok(nums.every((n) => n >= 1 && n <= 39));
  }
});

test("source key is stable for game and generated timestamp", () => {
  assert.equal(
    sourceKey("今彩539", "2026-06-12T14:35:16+08:00"),
    sourceKey("今彩539", "2026-06-12T14:35:16+08:00"),
  );
  assert.notEqual(
    sourceKey("今彩539", "2026-06-12T14:35:16+08:00"),
    sourceKey("大樂透", "2026-06-12T14:35:16+08:00"),
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
  assert.match(message, /穩健平衡/);
  assert.match(message, /統計趨勢/);
  assert.match(message, /冷門補位/);
});

test("calculates next Daily539 draw date by skipping Sunday", () => {
  assert.equal(nextDrawDate("539", "2026-06-13"), "2026-06-15");
  assert.equal(nextDrawDate("539", "2026-06-12"), "2026-06-13");
});

test("calculates next Lotto649 draw date as Tuesday or Friday", () => {
  assert.equal(nextDrawDate("649", "2026-06-12"), "2026-06-16");
  assert.equal(nextDrawDate("649", "2026-06-15"), "2026-06-16");
});
