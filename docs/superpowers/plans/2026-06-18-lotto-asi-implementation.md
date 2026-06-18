# 樂透 ASI v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Lotto ASI v1 by persisting post-draw learning records, feeding recent learning memory into Gemini predictions, and showing ASI learning on the frontend.

**Architecture:** Keep the current Supabase Edge Function architecture. Add one production-safe migration, extend existing pure core modules first, then wire the Edge Function HTTP/database layer, and finally expose the data through the existing Vue/Supabase frontend data path.

**Tech Stack:** Supabase Postgres, Supabase Edge Functions, JavaScript/TypeScript on Deno runtime, Node built-in test runner for core tests, Vue 3, Vite, Cloudflare Pages.

---

## File Structure

- Create: `supabase/migrations/20260618000000_create_asi_learning_records.sql`  
  Adds `asi_learning_records`, public read policy, indexes, and nullable compatibility columns on `prediction_records`.

- Modify: `supabase/functions/lotto-predict-notify/lib/predictCore.js`  
  Adds `buildAsiLearningContext()` and accepts `learningRecords` in `buildGeminiDecisionPayload()`.

- Modify: `supabase/functions/lotto-predict-notify/lib/predictCore.test.mjs`  
  Adds tests proving ASI learning context is normalized and included in Gemini payload.

- Modify: `supabase/functions/lotto-predict-notify/index.ts`  
  Fetches recent ASI learning records and passes them to payload generation.

- Modify: `supabase/functions/lotto-update/lib/lottoCore.js`  
  Adds `buildAsiLearningRecord()` from evaluated prediction + actual draw.

- Modify: `supabase/functions/lotto-update/lib/lottoCore.test.mjs`  
  Adds tests for the ASI learning record payload.

- Modify: `supabase/functions/lotto-update/index.ts`  
  Upserts ASI learning records after prediction evaluation.

- Modify: `frontend/src/services/supabaseData.js`  
  Fetches recent `asi_learning_records` and maps them into app state.

- Create: `frontend/src/components/AsiLearningPanel.vue`  
  Displays recent ASI learning records.

- Modify: `frontend/src/App.vue`  
  Wires `AsiLearningPanel` into each game page.

---

### Task 1: Database Migration

**Files:**
- Create: `supabase/migrations/20260618000000_create_asi_learning_records.sql`

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260618000000_create_asi_learning_records.sql`:

```sql
create table if not exists public.asi_learning_records (
  id uuid primary key default gen_random_uuid(),
  game_name text not null,
  target_draw_date date not null,
  draw_id text,
  prediction_source_key text not null,
  predicted_numbers jsonb not null default '[]'::jsonb,
  actual_numbers jsonb not null default '[]'::jsonb,
  matched_numbers jsonb not null default '[]'::jsonb,
  missed_numbers jsonb not null default '[]'::jsonb,
  selected_number_reasons jsonb not null default '{}'::jsonb,
  actual_number_analysis jsonb not null default '[]'::jsonb,
  strategy_effectiveness jsonb not null default '{}'::jsonb,
  next_adjustments jsonb not null default '[]'::jsonb,
  model_name text,
  reasoning_source text,
  raw_learning_report jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(game_name, target_draw_date, prediction_source_key)
);

create index if not exists asi_learning_records_game_date_idx
  on public.asi_learning_records (game_name, target_draw_date desc);

create index if not exists asi_learning_records_created_at_idx
  on public.asi_learning_records (created_at desc);

alter table public.prediction_records
  add column if not exists asi_state jsonb,
  add column if not exists asi_learning_context jsonb,
  add column if not exists model_name text,
  add column if not exists reasoning_source text;

alter table public.asi_learning_records enable row level security;

drop policy if exists "Public read ASI learning records" on public.asi_learning_records;
create policy "Public read ASI learning records"
on public.asi_learning_records for select
using (true);

drop trigger if exists set_asi_learning_records_updated_at on public.asi_learning_records;
create trigger set_asi_learning_records_updated_at
before update on public.asi_learning_records
for each row
execute function public.set_updated_at();
```

- [ ] **Step 2: Validate SQL text locally**

Run:

```powershell
Get-Content supabase/migrations/20260618000000_create_asi_learning_records.sql
```

Expected: SQL contains `create table if not exists public.asi_learning_records` and no placeholder text.

- [ ] **Step 3: Commit migration**

Run:

```powershell
git add supabase/migrations/20260618000000_create_asi_learning_records.sql
git commit -m "Add ASI learning records migration"
```

Expected: commit succeeds with one new migration file.

---

### Task 2: Prediction Core ASI Context

**Files:**
- Modify: `supabase/functions/lotto-predict-notify/lib/predictCore.js`
- Modify: `supabase/functions/lotto-predict-notify/lib/predictCore.test.mjs`

- [ ] **Step 1: Write failing tests for ASI context**

In `predictCore.test.mjs`, add imports:

```js
import {
  buildAsiLearningContext,
  buildGeminiDecisionPayload,
} from "./predictCore.js";
```

If the file already imports `buildGeminiDecisionPayload`, only add `buildAsiLearningContext` to the existing import list.

Add tests:

```js
test("normalizes recent ASI learning records for Gemini context", () => {
  const context = buildAsiLearningContext([
    {
      game_name: "今彩539",
      target_draw_date: "2026-06-17",
      matched_numbers: [8, 10],
      missed_numbers: [1, 2, 3],
      strategy_effectiveness: {
        balanced: { hits: 2, analysis: "balanced caught recurring mid-zone numbers" },
      },
      next_adjustments: [
        "降低單一冷號權重",
        "提高近期共現號碼交叉驗證",
      ],
      reasoning_source: "gemini_quantitative",
    },
  ]);

  assert.equal(context.length, 1);
  assert.equal(context[0].game_name, "今彩539");
  assert.deepEqual(context[0].matched_numbers, [8, 10]);
  assert.ok(context[0].lessons.includes("降低單一冷號權重"));
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
        next_adjustments: ["提高和值區間穩定性"],
      },
    ],
  });

  assert.equal(payload.asi_learning_memory.length, 1);
  assert.equal(payload.asi_learning_memory[0].target_draw_date, "2026-06-17");
  assert.ok(payload.quantitative_features.methodology.includes("ASI learning"));
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```powershell
node --test supabase/functions/lotto-predict-notify/lib/predictCore.test.mjs
```

Expected: FAIL because `buildAsiLearningContext` is not exported or `asi_learning_memory` is missing.

- [ ] **Step 3: Implement `buildAsiLearningContext`**

In `predictCore.js`, add:

```js
export function buildAsiLearningContext(records = [], limit = 5) {
  return records
    .filter((record) => record && record.target_draw_date)
    .slice(0, limit)
    .map((record) => {
      const strategyEntries = Object.entries(record.strategy_effectiveness || {});
      return {
        game_name: record.game_name,
        target_draw_date: record.target_draw_date,
        matched_numbers: record.matched_numbers || [],
        missed_numbers: record.missed_numbers || [],
        reasoning_source: record.reasoning_source || "unknown",
        lessons: (record.next_adjustments || []).filter(Boolean),
        strategy_notes: strategyEntries.map(([strategy, review]) => {
          const hits = review?.hits ?? review?.hit_count ?? "unknown";
          const analysis = review?.analysis || review?.learning_note || "no analysis";
          return `${strategy}: hits=${hits}; ${analysis}`;
        }),
      };
    });
}
```

- [ ] **Step 4: Extend `buildGeminiDecisionPayload` signature**

Find:

```js
export function buildGeminiDecisionPayload({ gameType, draws, generatedAt }) {
```

Change to:

```js
export function buildGeminiDecisionPayload({ gameType, draws, generatedAt, learningRecords = [] }) {
```

Inside the returned payload, add:

```js
const asiLearningMemory = buildAsiLearningContext(learningRecords);
```

Then include:

```js
asi_learning_memory: asiLearningMemory,
```

And append methodology text:

```js
methodology: [
  "statistical frequency, omission, co-occurrence, distribution balance",
  "ASI learning memory from recent post-draw evaluations",
].join("; "),
```

If `methodology` already exists, extend its string instead of replacing unrelated feature fields.

- [ ] **Step 5: Run prediction core tests**

Run:

```powershell
node --test supabase/functions/lotto-predict-notify/lib/predictCore.test.mjs
```

Expected: all tests pass.

- [ ] **Step 6: Commit prediction core context**

Run:

```powershell
git add supabase/functions/lotto-predict-notify/lib/predictCore.js supabase/functions/lotto-predict-notify/lib/predictCore.test.mjs
git commit -m "Feed ASI learning memory into Gemini payload"
```

---

### Task 3: Predict Edge Function Fetches Learning Records

**Files:**
- Modify: `supabase/functions/lotto-predict-notify/index.ts`

- [ ] **Step 1: Add helper to fetch recent ASI learning records**

In `index.ts`, near existing Supabase fetch helpers, add:

```ts
async function fetchRecentAsiLearningRecords(
  supabaseUrl: string,
  serviceRoleKey: string,
  gameName: string,
  limit = 5,
): Promise<Record<string, unknown>[]> {
  const params = new URLSearchParams({
    game_name: `eq.${gameName}`,
    select: [
      "game_name",
      "target_draw_date",
      "matched_numbers",
      "missed_numbers",
      "strategy_effectiveness",
      "next_adjustments",
      "reasoning_source",
      "model_name",
    ].join(","),
    order: "target_draw_date.desc",
    limit: String(limit),
  });

  const response = await supabaseRequest(
    supabaseUrl,
    serviceRoleKey,
    `asi_learning_records?${params}`,
  );

  if (!response.ok) {
    console.warn(`ASI learning context unavailable: ${response.status} ${await response.text()}`);
    return [];
  }

  return await response.json();
}
```

- [ ] **Step 2: Pass records into Gemini payload**

Find where `buildGeminiDecisionPayload({ gameType, draws, generatedAt })` is called.

Change the surrounding code to:

```ts
const learningRecords = await fetchRecentAsiLearningRecords(
  options.supabaseUrl,
  options.serviceRoleKey,
  predictionRow.game_name as string,
);

const payload = buildGeminiDecisionPayload({
  gameType,
  draws,
  generatedAt,
  learningRecords,
});
```

Also attach context to the row before `upsertPrediction`:

```ts
predictionRow.asi_learning_context = {
  version: "asi_learning_context_v1",
  records_used: learningRecords.length,
  latest_target_draw_date: learningRecords[0]?.target_draw_date || null,
};
```

- [ ] **Step 3: Run prediction tests**

Run:

```powershell
node --test supabase/functions/lotto-predict-notify/lib/predictCore.test.mjs
```

Expected: PASS.

- [ ] **Step 4: Commit Edge Function prediction wiring**

Run:

```powershell
git add supabase/functions/lotto-predict-notify/index.ts
git commit -m "Load ASI learning context before predictions"
```

---

### Task 4: Update Core Builds ASI Learning Records

**Files:**
- Modify: `supabase/functions/lotto-update/lib/lottoCore.js`
- Modify: `supabase/functions/lotto-update/lib/lottoCore.test.mjs`

- [ ] **Step 1: Write failing test for ASI learning record**

In `lottoCore.test.mjs`, add `buildAsiLearningRecord` to the import list.

Add:

```js
test("builds ASI learning record from evaluated prediction", () => {
  const predictionRecord = {
    source_key: "prediction|今彩539|2026-06-17",
    game_name: "今彩539",
    target_draw_date: "2026-06-17",
    prediction: {
      model: "gemini-quant-v2",
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
  assert.deepEqual(asi.actual_numbers, [8, 10, 15, 16, 37]);
  assert.ok(asi.matched_numbers.includes(8));
  assert.equal(asi.selected_number_reasons["8"], "recent co-occurrence support");
  assert.ok(asi.next_adjustments.length >= 1);
});
```

- [ ] **Step 2: Run test and verify failure**

Run:

```powershell
node --test supabase/functions/lotto-update/lib/lottoCore.test.mjs
```

Expected: FAIL because `buildAsiLearningRecord` is not exported.

- [ ] **Step 3: Implement `buildAsiLearningRecord`**

In `lottoCore.js`, add:

```js
export function buildAsiLearningRecord(record, draw, evaluation) {
  const prediction = record.prediction || {};
  const learningReport = evaluation.learning_report || {};
  const predictedRows = learningReport.predicted_numbers || [];
  const actualRows = learningReport.actual_numbers || [];
  const selected = prediction.number_insights?.selected_numbers || {};

  const selectedReasons = {};
  for (const item of predictedRows) {
    selectedReasons[String(item.number)] =
      item.selection_reason ||
      selected[String(item.number)]?.reason ||
      "no recorded reason";
  }

  return {
    game_name: record.game_name,
    target_draw_date: record.target_draw_date || draw.draw_date,
    draw_id: draw.draw_id,
    prediction_source_key: record.source_key,
    predicted_numbers: predictedRows.map((item) => item.number),
    actual_numbers: evaluation.actual_numbers || draw.numbers,
    matched_numbers: learningReport.summary?.hit_predicted_numbers || [],
    missed_numbers: learningReport.summary?.missed_predicted_numbers || [],
    selected_number_reasons: selectedReasons,
    actual_number_analysis: actualRows,
    strategy_effectiveness: learningReport.strategy_reviews || {},
    next_adjustments: learningReport.next_prediction_guidance || [],
    model_name: prediction.model || null,
    reasoning_source: prediction.reasoning_source || null,
    raw_learning_report: learningReport,
  };
}
```

- [ ] **Step 4: Run update core tests**

Run:

```powershell
node --test supabase/functions/lotto-update/lib/lottoCore.test.mjs
```

Expected: all tests pass.

- [ ] **Step 5: Commit update core learning builder**

Run:

```powershell
git add supabase/functions/lotto-update/lib/lottoCore.js supabase/functions/lotto-update/lib/lottoCore.test.mjs
git commit -m "Build ASI learning records after evaluation"
```

---

### Task 5: Update Edge Function Persists Learning Records

**Files:**
- Modify: `supabase/functions/lotto-update/index.ts`

- [ ] **Step 1: Import ASI builder**

Update the import from `./lib/lottoCore.js` to include:

```ts
buildAsiLearningRecord,
```

- [ ] **Step 2: Add upsert helper**

Near `upsertPerformanceSnapshot`, add:

```ts
async function upsertAsiLearningRecord(
  supabaseUrl: string,
  serviceRoleKey: string,
  row: Record<string, unknown>,
): Promise<void> {
  const response = await fetch(
    `${supabaseUrl}/rest/v1/asi_learning_records?on_conflict=game_name,target_draw_date,prediction_source_key`,
    {
      method: "POST",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify(row),
    },
  );

  if (!response.ok) {
    console.warn(`Supabase ASI learning upsert failed: ${response.status} ${await response.text()}`);
  }
}
```

- [ ] **Step 3: Persist after evaluation**

Find the loop that evaluates prediction records and updates `prediction_records`.

After successful evaluation row update, add:

```ts
const asiLearningRecord = buildAsiLearningRecord(prediction, actualDraw, evaluation);
await upsertAsiLearningRecord(supabaseUrl, serviceRoleKey, asiLearningRecord);
```

Use the actual local variable names in the function. The three required values are:

1. prediction record row
2. actual draw row
3. evaluation returned by `evaluatePredictionRecord`

- [ ] **Step 4: Run update tests**

Run:

```powershell
node --test supabase/functions/lotto-update/lib/lottoCore.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit persistence wiring**

Run:

```powershell
git add supabase/functions/lotto-update/index.ts
git commit -m "Persist ASI learning records during lotto update"
```

---

### Task 6: Frontend Data and ASI Panel

**Files:**
- Modify: `frontend/src/services/supabaseData.js`
- Create: `frontend/src/components/AsiLearningPanel.vue`
- Modify: `frontend/src/App.vue`

- [ ] **Step 1: Extend frontend data service**

In `frontend/src/services/supabaseData.js`, add to the parallel requests:

```js
requestAll('asi_learning_records?select=game_name,target_draw_date,draw_id,matched_numbers,missed_numbers,actual_numbers,strategy_effectiveness,next_adjustments,reasoning_source,model_name,created_at&order=target_draw_date.asc,created_at.asc')
```

Map rows:

```js
function mapAsiLearning(row) {
  return {
    game_name: row.game_name,
    target_draw_date: row.target_draw_date,
    draw_id: row.draw_id,
    matched_numbers: row.matched_numbers || [],
    missed_numbers: row.missed_numbers || [],
    actual_numbers: row.actual_numbers || [],
    strategy_effectiveness: row.strategy_effectiveness || {},
    next_adjustments: row.next_adjustments || [],
    reasoning_source: row.reasoning_source,
    model_name: row.model_name,
    created_at: row.created_at
  }
}
```

Return:

```js
asiLearning: learningRows.map(mapAsiLearning)
```

In `useLottoData.js`, add:

```js
const asiLearning = ref([])
```

Set:

```js
asiLearning.value = payload.asiLearning || []
```

Return `asiLearning`.

- [ ] **Step 2: Create `AsiLearningPanel.vue`**

Create `frontend/src/components/AsiLearningPanel.vue`:

```vue
<script setup>
const props = defineProps({
  gameName: { type: String, required: true },
  records: { type: Array, default: () => [] },
  accent: { type: String, default: '#38bdf8' }
})

const latestRecords = computed(() => {
  return [...props.records]
    .filter((record) => record.game_name === props.gameName)
    .sort((a, b) => new Date(b.target_draw_date) - new Date(a.target_draw_date))
    .slice(0, 10)
})

function formatNumbers(numbers) {
  if (!numbers?.length) return '無'
  return numbers.map((n) => String(n).padStart(2, '0')).join(' ')
}

function strategyRows(record) {
  return Object.entries(record.strategy_effectiveness || {}).map(([name, review]) => ({
    name,
    hits: review?.hits ?? review?.hit_count ?? '-',
    analysis: review?.analysis || review?.learning_note || '尚無分析'
  }))
}
</script>

<template>
  <section class="asi-panel">
    <div class="asi-heading">
      <p>ASI LEARNING</p>
      <h3>樂透 ASI 學習紀錄</h3>
    </div>

    <div v-if="!latestRecords.length" class="asi-empty">
      尚未累積 ASI 學習紀錄
    </div>

    <article v-for="record in latestRecords" :key="`${record.game_name}-${record.target_draw_date}-${record.draw_id}`" class="asi-record">
      <header>
        <strong>{{ record.target_draw_date }}</strong>
        <span>{{ record.model_name || 'statistical fallback' }}</span>
      </header>

      <div class="asi-grid">
        <div>
          <small>命中號碼</small>
          <b>{{ formatNumbers(record.matched_numbers) }}</b>
        </div>
        <div>
          <small>未命中號碼</small>
          <b>{{ formatNumbers(record.missed_numbers) }}</b>
        </div>
        <div>
          <small>實際開出</small>
          <b>{{ formatNumbers(record.actual_numbers) }}</b>
        </div>
      </div>

      <div class="asi-strategies">
        <div v-for="row in strategyRows(record)" :key="row.name">
          <strong>{{ row.name }}：{{ row.hits }} hit</strong>
          <span>{{ row.analysis }}</span>
        </div>
      </div>

      <ol class="asi-adjustments">
        <li v-for="item in record.next_adjustments" :key="item">{{ item }}</li>
      </ol>
    </article>
  </section>
</template>

<style scoped>
.asi-panel {
  border: 1px solid rgba(148, 163, 184, 0.18);
  border-radius: 8px;
  padding: 24px;
  background: rgba(15, 23, 42, 0.72);
}

.asi-heading p {
  color: v-bind(accent);
  font-size: 0.75rem;
  font-weight: 800;
  letter-spacing: 0.14em;
}

.asi-heading h3 {
  color: #f8fafc;
  font-size: 1.5rem;
  margin-top: 4px;
}

.asi-empty {
  margin-top: 16px;
  color: #94a3b8;
}

.asi-record {
  margin-top: 18px;
  padding-top: 18px;
  border-top: 1px solid rgba(148, 163, 184, 0.14);
}

.asi-record header,
.asi-grid,
.asi-strategies > div {
  display: grid;
  gap: 8px;
}

.asi-record header {
  grid-template-columns: 1fr auto;
  color: #e2e8f0;
}

.asi-record header span,
.asi-grid small,
.asi-strategies span {
  color: #94a3b8;
}

.asi-grid {
  grid-template-columns: repeat(3, minmax(0, 1fr));
  margin-top: 14px;
}

.asi-grid b {
  color: #f8fafc;
  font-size: 1.05rem;
}

.asi-strategies,
.asi-adjustments {
  margin-top: 14px;
}

.asi-strategies > div {
  padding: 12px;
  border-radius: 8px;
  background: rgba(15, 23, 42, 0.6);
}

.asi-strategies strong {
  color: #f8fafc;
}

.asi-adjustments {
  color: #cbd5e1;
  padding-left: 20px;
}

@media (max-width: 720px) {
  .asi-grid {
    grid-template-columns: 1fr;
  }
}
</style>
```

- [ ] **Step 3: Wire panel into `App.vue`**

Import:

```js
import AsiLearningPanel from './components/AsiLearningPanel.vue'
```

From `useLottoData()`, destructure `asiLearning`.

Add below each `PredictionHistoryPanel`:

```vue
<AsiLearningPanel game-name="大樂透" :records="asiLearning" accent="#2dd4bf" />
```

For Daily539:

```vue
<AsiLearningPanel game-name="今彩539" :records="asiLearning" accent="#a78bfa" />
```

- [ ] **Step 4: Run frontend build**

Run:

```powershell
npm run build:cloudflare
```

from `frontend`.

Expected: Vite build succeeds.

- [ ] **Step 5: Commit frontend ASI panel**

Run:

```powershell
git add frontend/src/services/supabaseData.js frontend/src/composables/useLottoData.js frontend/src/components/AsiLearningPanel.vue frontend/src/App.vue
git commit -m "Show ASI learning records on dashboard"
```

---

### Task 7: Verification, Deploy, and Production Check

**Files:**
- No new files unless tests reveal a defect.

- [ ] **Step 1: Run all core tests**

Run:

```powershell
node --test supabase/functions/lotto-predict-notify/lib/predictCore.test.mjs
node --test supabase/functions/lotto-update/lib/lottoCore.test.mjs
```

Expected: both commands exit 0.

- [ ] **Step 2: Run frontend build**

Run:

```powershell
npm run build:cloudflare
```

from `frontend`.

Expected: build exits 0.

- [ ] **Step 3: Apply migration to production**

Run:

```powershell
npx --yes supabase db push --project-ref qscqemykkkarzsufudji
```

Expected: migration `20260618000000_create_asi_learning_records.sql` is applied.

- [ ] **Step 4: Deploy Edge Functions**

Run:

```powershell
npx --yes supabase functions deploy lotto-predict-notify --project-ref qscqemykkkarzsufudji
npx --yes supabase functions deploy lotto-update --project-ref qscqemykkkarzsufudji
```

Expected: both deploy commands succeed.

- [ ] **Step 5: Push frontend changes**

Run:

```powershell
git push origin main
```

Expected: Cloudflare Pages starts a production deployment from `main`.

- [ ] **Step 6: Production dry run for prediction**

Invoke a dry run without LINE push:

```powershell
$body = @{
  game = "due"
  target_date = "2026-06-19"
  dry_run = $true
} | ConvertTo-Json

npx --yes supabase functions invoke lotto-predict-notify `
  --project-ref qscqemykkkarzsufudji `
  --body $body
```

Expected: response includes `dry_run=true` and no LINE notification is sent.

- [ ] **Step 7: Production check ASI table**

Query:

```powershell
$pub=((npx --yes supabase projects api-keys --project-ref qscqemykkkarzsufudji | ConvertFrom-Json).keys | Where-Object { $_.type -eq 'publishable' } | Select-Object -First 1 -ExpandProperty api_key)
$headers=@{ apikey=$pub; Authorization="Bearer $pub" }
$uri='https://qscqemykkkarzsufudji.supabase.co/rest/v1/asi_learning_records?select=game_name,target_draw_date,matched_numbers,missed_numbers&order=target_draw_date.desc&limit=5'
Invoke-WebRequest -Uri $uri -Headers $headers -UseBasicParsing
```

Expected: returns `[]` before the next evaluated draw, or rows after `lotto-update` evaluates predictions.

- [ ] **Step 8: Production frontend check**

Poll live bundle:

```powershell
$r=Invoke-WebRequest -Uri 'https://lotto.simonsynapse.net/?t=asi' -Headers @{ 'Cache-Control'='no-cache'; 'Pragma'='no-cache' } -UseBasicParsing
($r.Content | Select-String -Pattern 'assets/[^"'']+' -AllMatches).Matches.Value | Sort-Object -Unique
```

Expected: new JS asset hash appears after Cloudflare deploy.

Then open:

```text
https://lotto.simonsynapse.net/
```

Expected: each game page renders without connection errors and shows the ASI learning panel.

---

## Self-Review Checklist

- Spec coverage:
  - Data sensing: covered through recent learning and Supabase query paths.
  - Statistical features: preserved in existing `buildGeminiDecisionPayload`, extended with ASI memory.
  - Gemini decision: learning memory added to prompt payload.
  - System verification: existing verifier remains the final selection gate.
  - Post-draw learning: formalized into `asi_learning_records`.
  - Frontend: new panel added.
  - LINE: not expanded in v1 implementation plan because existing LINE already sends prediction insight; ASI status can be a follow-up after learning records are stable.

- Placeholder scan:
  - No `TBD`, `TODO`, or vague implementation-only steps.

- Type consistency:
  - `prediction_source_key` maps to existing `prediction_records.source_key`.
  - `target_draw_date` remains date text in JSON and date in Postgres.
  - `matched_numbers`, `missed_numbers`, and `actual_numbers` are arrays in JavaScript and `jsonb` in Postgres.
