import test from "node:test";
import assert from "node:assert/strict";

import {
  chooseFreshestDraw,
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
