# 樂透 LAI v2 自我學習智能體 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在既有 Supabase Edge Functions 與 Cloudflare Pages production 架構內，建立可稽核、無資料洩漏、每期固定輸出 2 組號碼並於開獎後量化更新的 LAI v2 智能體。

**Architecture:** 專家模型只輸出合法的號碼機率向量，由 Hedge ensemble 聚合，再由雙組最佳化器產生「機率主攻」與「覆蓋探索」。`lotto-predict-notify` 保存事前 forecast 並推送 LINE，`lotto-update` 對獎、評分並原子啟用下一版 agent state，歷史 walk-forward 由可 checkpoint 的 `lotto-train-agent` 分批執行。

**Tech Stack:** Supabase Postgres migrations、Supabase Cron、Deno/TypeScript Edge Functions、ES modules、Node.js `node:test`、Vue 3、Vite、Cloudflare Pages。

## Global Constraints

- 威力彩、大樂透、今彩 539 在每個開獎日固定輸出 2 組。
- 所有模型只可使用目標開獎日前已知資料；修改未來資料不得改變過去 forecast。
- 每個專家輸出 `0 <= p(n) <= 1` 且 `sum(p(n)) = k` 的完整機率向量。
- Hedge 使用原始 Brier Loss；Brier Skill Score 只用於比較與顯示。
- Group A 最佳化單組機率，Group B 以 `0.5` 機率分數加 `0.5` 新增覆蓋分數最佳化。
- 不強迫奇偶、大小、冷熱、跨號段或連號限制。
- 威力彩第一區與第二區分開預測及評分。
- LLM 不得直接選號、計算機率或更新模型權重。
- 沒有模型通過 Champion 門檻時使用均勻基準，仍須正常提供 2 組。
- 任何 prediction 證據保存失敗時不得發送 LINE。
- 保留 `.claude/settings.local.json` 的既有本機修改，不得納入任何 implementation commit。

---

## File Structure

### New production files

- `supabase/migrations/20260710000000_create_lai_v2_agent.sql`：LAI 狀態、forecast、score、training run 與原子啟用函式。
- `supabase/functions/lotto-predict-notify/lib/scoring.js`：機率正規化與評分。
- `supabase/functions/lotto-predict-notify/lib/scoring.test.mjs`：評分單元測試。
- `supabase/functions/lotto-predict-notify/lib/experts.js`：專家模型統一介面。
- `supabase/functions/lotto-predict-notify/lib/experts.test.mjs`：專家合法性與時間洩漏測試。
- `supabase/functions/lotto-predict-notify/lib/ensemble.js`：Hedge 聚合與權重更新。
- `supabase/functions/lotto-predict-notify/lib/ensemble.test.mjs`：權重與聚合測試。
- `supabase/functions/lotto-predict-notify/lib/optimizer.js`：Group A／B 最佳化。
- `supabase/functions/lotto-predict-notify/lib/optimizer.test.mjs`：雙組合法性與覆蓋測試。
- `supabase/functions/lotto-predict-notify/lib/agentState.js`：state 建立、promotion 與統計門檻。
- `supabase/functions/lotto-predict-notify/lib/agentState.test.mjs`：Champion-Challenger 測試。
- `supabase/functions/lotto-train-agent/index.ts`：分批 walk-forward 初始化與 checkpoint。
- `supabase/functions/lotto-train-agent/lib/trainingCore.js`：純函式 walk-forward chunk。
- `supabase/functions/lotto-train-agent/lib/trainingCore.test.mjs`：cursor 與無洩漏測試。
- `frontend/src/services/laiPresentation.js`：LAI prediction 與 learning view model。
- `frontend/src/services/laiPresentation.test.mjs`：前端 view model 測試。
- `frontend/src/components/LaiAgentPanel.vue`：智能體狀態、雙組與權重呈現。

### Existing files to modify

- `supabase/functions/lotto-predict-notify/lib/predictCore.js`：組合 LAI 核心並支援 LAI LINE 格式。
- `supabase/functions/lotto-predict-notify/lib/predictCore.test.mjs`：LAI record 與 LINE 測試。
- `supabase/functions/lotto-predict-notify/index.ts`：讀取 state、保存 forecasts、shadow/enable flag 與 evidence-first LINE。
- `supabase/functions/lotto-update/lib/lottoCore.js`：model forecast 評分與 LAI performance snapshot。
- `supabase/functions/lotto-update/lib/lottoCore.test.mjs`：賽後模型評分、union coverage 與冪等輸入。
- `supabase/functions/lotto-update/index.ts`：讀取未評分 forecasts、寫 scores、呼叫 state activation RPC。
- `frontend/src/services/supabaseData.js`：映射 LAI prediction 與 learning 欄位。
- `frontend/src/components/PredictionCard.vue`：LAI v2 使用新 panel，舊 prediction 保持相容。
- `frontend/src/components/AsiLearningPanel.vue`：顯示權重變化、覆蓋與 Champion 變更。
- `frontend/src/components/PerformanceChart.vue`：增加 Brier skill 與 union coverage 摘要。
- `frontend/src/components/PredictionHistoryPanel.vue`：顯示機率主攻／覆蓋探索名稱及 LAI 成效。
- `frontend/package.json`：加入純 Node 前端 service test script。
- `docs/runtime-triggers.md`：記錄 shadow、training 與正式切換流程。

---

### Task 1: 建立 LAI v2 資料模型與原子 state activation

**Files:**
- Create: `supabase/migrations/20260710000000_create_lai_v2_agent.sql`
- Test: migration SQL inspection and Supabase local migration

**Interfaces:**
- Consumes: existing `public.prediction_records`, `public.lotto_draws`, `public.set_updated_at()`.
- Produces: `lotto_agent_states`, `lotto_model_forecasts`, `lotto_model_scores`, `lotto_training_runs`, `activate_lotto_agent_state(jsonb)` RPC.

- [ ] **Step 1: Write migration contract assertions**

Run this read-only inspection before creating the file:

```powershell
rg -n "lotto_agent_states|lotto_model_forecasts|activate_lotto_agent_state" supabase/migrations
```

Expected: no matches, proving the migration is new.

- [ ] **Step 2: Create the migration**

Create the tables with these essential contracts:

```sql
create table if not exists public.lotto_agent_states (
  id uuid primary key default gen_random_uuid(),
  game_name text not null,
  state_version bigint not null,
  status text not null check (status in ('baseline', 'champion', 'degraded')),
  champion_model text not null,
  expert_weights jsonb not null,
  learning_config jsonb not null,
  metrics jsonb not null default '{}'::jsonb,
  last_learned_draw_id text,
  last_learned_draw_date date,
  is_active boolean not null default false,
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  unique (game_name, state_version)
);

create unique index if not exists lotto_agent_states_one_active_idx
  on public.lotto_agent_states (game_name)
  where is_active;

create table if not exists public.lotto_model_forecasts (
  id uuid primary key default gen_random_uuid(),
  prediction_source_key text not null,
  game_name text not null,
  target_draw_date date not null,
  model_name text not null,
  model_version text not null,
  forecast_mode text not null check (forecast_mode in ('shadow', 'production')),
  probabilities jsonb not null,
  special_probabilities jsonb,
  final_groups jsonb not null default '{}'::jsonb,
  feature_summary jsonb not null default '{}'::jsonb,
  agent_state_version bigint,
  data_status text not null,
  generated_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (game_name, target_draw_date, model_name, model_version, forecast_mode)
);

create table if not exists public.lotto_model_scores (
  id uuid primary key default gen_random_uuid(),
  forecast_id uuid not null references public.lotto_model_forecasts(id) on delete cascade,
  game_name text not null,
  draw_id text not null,
  draw_date date not null,
  metrics jsonb not null,
  weight_before numeric,
  weight_after numeric,
  evaluator_version text not null,
  evaluated_at timestamptz not null default now(),
  unique (forecast_id, draw_id)
);

create table if not exists public.lotto_training_runs (
  id uuid primary key default gen_random_uuid(),
  game_name text not null,
  run_type text not null,
  algorithm_version text not null,
  status text not null check (status in ('queued', 'running', 'completed', 'failed')),
  range_start integer not null default 0,
  range_end integer not null,
  checkpoint_cursor integer not null default 0,
  summary jsonb not null default '{}'::jsonb,
  error_text text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

Add indexes on `(game_name, target_draw_date)`, enable RLS on all four tables, and create no public policies because the frontend reads LAI summaries from `prediction_records` and `performance_snapshots`.

Add an atomic RPC that deactivates the previous state and activates the supplied state in one transaction:

```sql
create or replace function public.activate_lotto_agent_state(p_state jsonb)
returns public.lotto_agent_states
language plpgsql
security definer
set search_path = public
as $$
declare
  activated public.lotto_agent_states;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_state->>'game_name', 0));

  select * into activated
  from public.lotto_agent_states
  where game_name = p_state->>'game_name'
    and is_active
    and last_learned_draw_id = p_state->>'last_learned_draw_id';

  if found then
    return activated;
  end if;

  update public.lotto_agent_states
  set is_active = false
  where game_name = p_state->>'game_name' and is_active;

  insert into public.lotto_agent_states (
    game_name, state_version, status, champion_model, expert_weights,
    learning_config, metrics, last_learned_draw_id, last_learned_draw_date,
    is_active, activated_at
  ) values (
    p_state->>'game_name',
    (p_state->>'state_version')::bigint,
    p_state->>'status',
    p_state->>'champion_model',
    p_state->'expert_weights',
    p_state->'learning_config',
    coalesce(p_state->'metrics', '{}'::jsonb),
    p_state->>'last_learned_draw_id',
    nullif(p_state->>'last_learned_draw_date', '')::date,
    true,
    now()
  )
  returning * into activated;

  return activated;
end;
$$;

revoke all on function public.activate_lotto_agent_state(jsonb) from public;
grant execute on function public.activate_lotto_agent_state(jsonb) to service_role;
```

- [ ] **Step 3: Verify SQL syntax locally**

Run:

```powershell
npx --yes supabase db reset
```

Expected: all migrations apply with exit code `0`; the four LAI tables and RPC exist.

If Docker is unavailable, run the repository SQL lint/inspection and record local database verification as pending rather than claiming it passed.

- [ ] **Step 4: Commit**

```powershell
git add supabase/migrations/20260710000000_create_lai_v2_agent.sql
git commit -m "feat: add LAI v2 agent data model"
```

---

### Task 2: 實作機率正規化與 proper scoring

**Files:**
- Create: `supabase/functions/lotto-predict-notify/lib/scoring.js`
- Create: `supabase/functions/lotto-predict-notify/lib/scoring.test.mjs`

**Interfaces:**
- Consumes: raw expert scores, `{ maxNumber, picks }`, actual number arrays.
- Produces: `normalizeProbabilityVector(raw, maxNumber, picks)`, `brierScore(probabilities, actualNumbers, maxNumber)`, `logLoss(probabilities, actualNumbers, maxNumber, epsilon)`, `brierSkillScore(modelScore, baselineScore)`, `coverageMetrics(groupA, groupB, actualNumbers)`.

- [ ] **Step 1: Write failing scoring tests**

```js
test("normalizes a probability vector to the game pick count", () => {
  const p = normalizeProbabilityVector([1, 1, 2, 0], 4, 2);
  assert.equal(Number(p.reduce((a, b) => a + b, 0).toFixed(10)), 2);
  assert.ok(p.every((value) => value >= 0 && value <= 1));
});

test("uniform forecast has zero Brier skill against itself", () => {
  const uniform = Array(39).fill(5 / 39);
  const actual = [1, 2, 3, 4, 5];
  const bs = brierScore(uniform, actual, 39);
  assert.equal(brierSkillScore(bs, bs), 0);
});

test("coverage metrics report union hits and overlap", () => {
  const result = coverageMetrics([1, 2, 3], [3, 4, 5], [2, 4, 6]);
  assert.deepEqual(result, {
    group_a_hits: 1,
    group_b_hits: 1,
    union_hits: 2,
    overlap_count: 1,
    union_size: 5,
  });
});
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```powershell
node --test supabase/functions/lotto-predict-notify/lib/scoring.test.mjs
```

Expected: FAIL because `scoring.js` or its exports do not exist.

- [ ] **Step 3: Implement scoring functions**

Use capped simplex projection so every probability remains in `[0, 1]` while summing to `picks`. Implement Brier as per-number mean squared error and Log Loss with `epsilon = 1e-12`.

```js
export function brierScore(probabilities, actualNumbers, maxNumber) {
  const actual = new Set(actualNumbers.map(Number));
  return probabilities.reduce((sum, p, index) => {
    const y = actual.has(index + 1) ? 1 : 0;
    return sum + (p - y) ** 2;
  }, 0) / maxNumber;
}

export function brierSkillScore(modelScore, baselineScore) {
  return baselineScore > 0 ? 1 - modelScore / baselineScore : 0;
}
```

- [ ] **Step 4: Run tests and verify GREEN**

Run:

```powershell
node --test supabase/functions/lotto-predict-notify/lib/scoring.test.mjs
```

Expected: all scoring tests PASS.

- [ ] **Step 5: Commit**

```powershell
git add supabase/functions/lotto-predict-notify/lib/scoring.js supabase/functions/lotto-predict-notify/lib/scoring.test.mjs
git commit -m "feat: add LAI probability scoring"
```

---

### Task 3: 將現有訊號拆成專家機率模型

**Files:**
- Create: `supabase/functions/lotto-predict-notify/lib/experts.js`
- Create: `supabase/functions/lotto-predict-notify/lib/experts.test.mjs`
- Modify: `supabase/functions/lotto-predict-notify/lib/predictCore.js:1137-1435`

**Interfaces:**
- Consumes: `gameType`, chronological `draws`, `generatedAt`, `ML_WEIGHTS`.
- Produces: `buildExpertForecasts({ gameType, draws, generatedAt })` returning `{ name, version, probabilities, specialProbabilities, featureSummary }[]`.

- [ ] **Step 1: Write failing expert contract tests**

```js
for (const gameType of ["539", "649", "power"]) {
  test(`${gameType} experts emit legal probability vectors`, () => {
    const forecasts = buildExpertForecasts({ gameType, draws: fixtures[gameType], generatedAt: NOW });
    assert.ok(forecasts.some((item) => item.name === "uniform"));
    for (const forecast of forecasts) {
      const config = GAME_CONFIG[gameType];
      assert.equal(forecast.probabilities.length, config.maxNumber);
      assert.equal(Number(forecast.probabilities.reduce((a, b) => a + b, 0).toFixed(8)), config.picks);
    }
  });
}

test("future draws cannot change a forecast for an earlier prefix", () => {
  const prefix = dailyDraws.slice(0, 4);
  const before = buildExpertForecasts({ gameType: "539", draws: prefix, generatedAt: NOW });
  const after = buildExpertForecasts({ gameType: "539", draws: [...prefix, dailyDraws[4]], generatedAt: NOW });
  const replay = buildExpertForecasts({ gameType: "539", draws: prefix, generatedAt: NOW });
  assert.deepEqual(replay, before);
  assert.notDeepEqual(after, before);
});
```

- [ ] **Step 2: Run tests and verify RED**

```powershell
node --test supabase/functions/lotto-predict-notify/lib/experts.test.mjs
```

Expected: FAIL because `buildExpertForecasts` does not exist.

- [ ] **Step 3: Implement the expert registry**

Use the existing frequency, missing interval, pair, Markov and LSTM logic, but convert each signal to probabilities through `normalizeProbabilityVector`.

```js
export const EXPERT_VERSIONS = {
  uniform: "uniform-v1",
  bayesian_frequency: "bayesian-frequency-v1",
  multi_window: "multi-window-v1",
  hazard: "hazard-v1",
  cooccurrence: "cooccurrence-v1",
  markov: "markov-v1",
  lstm: "lstm-static-v1",
  structure: "structure-v1",
};

export function buildExpertForecasts({ gameType, draws, generatedAt }) {
  const config = GAME_CONFIG[gameType];
  const experts = [
    uniformForecast(config),
    bayesianFrequencyForecast(draws, config),
    multiWindowForecast(draws, config),
    hazardForecast(draws, config, generatedAt),
    cooccurrenceForecast(draws, config),
    markovForecast(draws, config),
    structureForecast(draws, config),
  ];
  const lstm = lstmForecast(gameType, draws, config);
  if (lstm) experts.push(lstm);
  return experts.map((expert) => validateExpertForecast(expert, config));
}
```

For Power Lottery, every expert must also return a second-area vector or explicitly omit it; the registry always includes a legal uniform second-area forecast.

- [ ] **Step 4: Remove duplicated private implementations from `predictCore.js`**

Import the expert registry instead of keeping separate private Markov/LSTM copies:

```js
import { buildExpertForecasts } from "./experts.js";
```

Do not remove the existing production generator yet; it remains the rollback path until Task 6.

- [ ] **Step 5: Run expert and existing prediction tests**

```powershell
node --test supabase/functions/lotto-predict-notify/lib/experts.test.mjs supabase/functions/lotto-predict-notify/lib/predictCore.test.mjs
```

Expected: all tests PASS and the legacy generator output remains unchanged.

- [ ] **Step 6: Commit**

```powershell
git add supabase/functions/lotto-predict-notify/lib/experts.js supabase/functions/lotto-predict-notify/lib/experts.test.mjs supabase/functions/lotto-predict-notify/lib/predictCore.js
git commit -m "feat: add LAI expert probability models"
```

---

### Task 4: 實作 Hedge ensemble 與 Champion-Challenger state

**Files:**
- Create: `supabase/functions/lotto-predict-notify/lib/ensemble.js`
- Create: `supabase/functions/lotto-predict-notify/lib/ensemble.test.mjs`
- Create: `supabase/functions/lotto-predict-notify/lib/agentState.js`
- Create: `supabase/functions/lotto-predict-notify/lib/agentState.test.mjs`

**Interfaces:**
- Consumes: expert forecasts, active state, per-expert Brier losses and promotion metrics.
- Produces: `aggregateForecasts`, `updateHedgeWeights`, `createBaselineState`, `benjaminiHochberg`, `evaluatePromotion`.

- [ ] **Step 1: Write failing Hedge tests**

```js
test("lower-loss expert gains relative weight without removing baseline", () => {
  const next = updateHedgeWeights({
    weights: { uniform: 0.5, frequency: 0.5 },
    losses: { uniform: 0.12, frequency: 0.08 },
    sampleCount: 20,
    baselineName: "uniform",
    gamma: 0.1,
  });
  assert.ok(next.frequency > next.uniform);
  assert.ok(next.uniform > 0);
  assert.equal(Number(Object.values(next).reduce((a, b) => a + b, 0).toFixed(10)), 1);
});

test("one lucky draw cannot promote a challenger", () => {
  const result = evaluatePromotion({
    recent100Skill: 0.2,
    recent500Skill: 0.2,
    productionSamples: 1,
    bootstrapLower95: 0.1,
    adjustedQ: 0.01,
    unionCoverageDelta: 0.1,
  });
  assert.deepEqual(result, { promoted: false, reason: "insufficient_production_samples" });
});
```

- [ ] **Step 2: Run tests and verify RED**

```powershell
node --test supabase/functions/lotto-predict-notify/lib/ensemble.test.mjs supabase/functions/lotto-predict-notify/lib/agentState.test.mjs
```

Expected: FAIL because modules do not exist.

- [ ] **Step 3: Implement adaptive Hedge aggregation**

```js
export function updateHedgeWeights({ weights, losses, sampleCount, baselineName, gamma = 0.1 }) {
  const names = Object.keys(weights).filter((name) => Number.isFinite(losses[name]));
  const eta = Math.sqrt((2 * Math.log(Math.max(names.length, 2))) / Math.max(sampleCount, 1));
  const raw = Object.fromEntries(names.map((name) => [name, weights[name] * Math.exp(-eta * losses[name])]));
  const total = Object.values(raw).reduce((sum, value) => sum + value, 0);
  const uniformShare = gamma / names.length;
  return Object.fromEntries(names.map((name) => {
    const normalized = total > 0 ? raw[name] / total : 1 / names.length;
    return [name, (1 - gamma) * normalized + uniformShare];
  }));
}
```

`aggregateForecasts` must ignore unavailable experts, renormalize surviving weights and re-project the weighted vector to the game pick count.

- [ ] **Step 4: Implement state and promotion gates**

```js
export function evaluatePromotion(metrics) {
  if (metrics.productionSamples < 30) return { promoted: false, reason: "insufficient_production_samples" };
  if (metrics.recent100Skill <= 0) return { promoted: false, reason: "recent_100_not_skillful" };
  if (metrics.recent500Skill <= 0) return { promoted: false, reason: "recent_500_not_skillful" };
  if (metrics.bootstrapLower95 <= 0) return { promoted: false, reason: "confidence_interval_crosses_zero" };
  if (metrics.adjustedQ > 0.05) return { promoted: false, reason: "multiple_test_threshold_failed" };
  if (metrics.unionCoverageDelta < 0) return { promoted: false, reason: "coverage_regression" };
  return { promoted: true, reason: "all_gates_passed" };
}
```

- [ ] **Step 5: Run tests and verify GREEN**

```powershell
node --test supabase/functions/lotto-predict-notify/lib/ensemble.test.mjs supabase/functions/lotto-predict-notify/lib/agentState.test.mjs
```

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```powershell
git add supabase/functions/lotto-predict-notify/lib/ensemble.js supabase/functions/lotto-predict-notify/lib/ensemble.test.mjs supabase/functions/lotto-predict-notify/lib/agentState.js supabase/functions/lotto-predict-notify/lib/agentState.test.mjs
git commit -m "feat: add LAI online ensemble state"
```

---

### Task 5: 實作 A+B 雙組最佳化與 LAI prediction record

**Files:**
- Create: `supabase/functions/lotto-predict-notify/lib/optimizer.js`
- Create: `supabase/functions/lotto-predict-notify/lib/optimizer.test.mjs`
- Modify: `supabase/functions/lotto-predict-notify/lib/predictCore.js:1436-1522`
- Modify: `supabase/functions/lotto-predict-notify/lib/predictCore.test.mjs`

**Interfaces:**
- Consumes: ensemble probabilities, game config, deterministic seed and active agent state.
- Produces: `optimizeTwoGroups`, `optimizePowerGroups`, `generateAdaptivePrediction` and LAI prediction JSON.

- [ ] **Step 1: Write failing optimizer tests**

```js
test("Daily539 emits two legal and different groups", () => {
  const result = optimizeTwoGroups({
    probabilities: Array.from({ length: 39 }, (_, i) => 39 - i),
    config: { maxNumber: 39, picks: 5 },
    seed: "今彩539|2026-07-10|lai-v2",
  });
  assert.equal(result.groupA.length, 5);
  assert.equal(result.groupB.length, 5);
  assert.equal(new Set(result.groupA).size, 5);
  assert.notDeepEqual(result.groupA, result.groupB);
  assert.ok(result.metrics.union_size >= 5);
});

test("coverage group beats copying group A on incremental coverage", () => {
  const result = optimizeTwoGroups({ probabilities: PROBABILITIES, config: DAILY_CONFIG, seed: "fixed" });
  const copiedUnion = new Set(result.groupA).size;
  assert.ok(result.metrics.union_size >= copiedUnion);
});

test("Power Lottery returns independent second-area groups", () => {
  const result = optimizePowerGroups({ mainProbabilities, specialProbabilities, seed: "power|date|v2" });
  assert.equal(result.specialGroupA.length, 1);
  assert.equal(result.specialGroupB.length, 1);
});
```

- [ ] **Step 2: Run tests and verify RED**

```powershell
node --test supabase/functions/lotto-predict-notify/lib/optimizer.test.mjs
```

Expected: FAIL because optimizer exports do not exist.

- [ ] **Step 3: Implement deterministic optimization**

```js
export function optimizeTwoGroups({ probabilities, config, seed }) {
  const rankedA = rankWithSeed(probabilities, seed, () => 0);
  const groupA = rankedA.slice(0, config.picks).map((item) => item.number).sort((a, b) => a - b);
  const selectedA = new Set(groupA);
  const rankedB = rankWithSeed(probabilities, `${seed}|coverage`, (number, probability) =>
    0.5 * probability + 0.5 * (selectedA.has(number) ? 0 : probability)
  );
  let groupB = rankedB.slice(0, config.picks).map((item) => item.number).sort((a, b) => a - b);
  if (groupB.every((number, index) => number === groupA[index])) {
    groupB = replaceLastWithNext(groupB, rankedB, selectedA);
  }
  return { groupA, groupB, metrics: groupPairMetrics(groupA, groupB) };
}
```

- [ ] **Step 4: Write failing LAI record test**

```js
test("generateAdaptivePrediction stores two groups, state and expert evidence", () => {
  const result = generateAdaptivePrediction({
    gameType: "539",
    draws: dailyDraws,
    generatedAt: "2026-07-10T10:00:00+08:00",
    targetDrawDate: "2026-07-10",
    agentState: baselineState,
    dataStatus: "fresh",
  });
  assert.equal(result.record.prediction.model, "lai-v2");
  assert.deepEqual(Object.keys(result.record.prediction.combinations), ["機率主攻", "覆蓋探索"]);
  assert.ok(result.record.prediction.expert_weights.uniform > 0);
  assert.equal(result.record.prediction.agent_status, "baseline");
  assert.ok(result.forecasts.length >= 2);
});
```

- [ ] **Step 5: Implement `generateAdaptivePrediction`**

Compose `buildExpertForecasts`, `aggregateForecasts` and `optimizeTwoGroups`. Return both the public prediction record and an internal `model_forecasts` array; do not let LLM output enter this function.

```js
return {
  record: {
    timestamp: generatedAt,
    game_name: config.name,
    prediction: {
      model: "lai-v2",
      engine: "lai-adaptive-ensemble",
      reasoning_source: "lai_quantitative",
      agent_status: effectiveState.status,
      agent_state_version: effectiveState.state_version,
      expert_weights: effectiveState.expert_weights,
      evidence: { data_status: dataStatus, proven_above_random: effectiveState.status === "champion" },
      combinations: { "機率主攻": groupA, "覆蓋探索": groupB },
      special_combinations: specialGroups,
      group_metrics: metrics,
    },
    is_evaluated: false,
    evaluation: { draw_id: null, actual_numbers: [], strategies: {} },
  },
  forecasts,
};
```

- [ ] **Step 6: Run optimizer and prediction tests**

```powershell
node --test supabase/functions/lotto-predict-notify/lib/optimizer.test.mjs supabase/functions/lotto-predict-notify/lib/predictCore.test.mjs
```

Expected: all tests PASS; legacy tests remain green.

- [ ] **Step 7: Commit**

```powershell
git add supabase/functions/lotto-predict-notify/lib/optimizer.js supabase/functions/lotto-predict-notify/lib/optimizer.test.mjs supabase/functions/lotto-predict-notify/lib/predictCore.js supabase/functions/lotto-predict-notify/lib/predictCore.test.mjs
git commit -m "feat: generate LAI probability and coverage groups"
```

---

### Task 6: 將 LAI v2 接入預測 Edge Function 與 evidence-first LINE

**Files:**
- Modify: `supabase/functions/lotto-predict-notify/index.ts:155-490`
- Modify: `supabase/functions/lotto-predict-notify/lib/predictCore.js:1523-1635`
- Modify: `supabase/functions/lotto-predict-notify/lib/predictCore.test.mjs`

**Interfaces:**
- Consumes: active agent state REST row, feature flags `LAI_V2_SHADOW_ENABLED`, `LAI_V2_ENABLED`.
- Produces: forecast rows saved before notification, LAI LINE message, legacy rollback path.

- [ ] **Step 1: Write failing LAI LINE tests**

```js
test("LAI LINE message contains exactly two named groups and evidence status", () => {
  const message = buildLineMessage(laiRecord, "2026-07-10");
  assert.match(message, /LAI v2/);
  assert.match(message, /機率主攻/);
  assert.match(message, /覆蓋探索/);
  assert.match(message, /目前模型是否優於隨機/);
});

test("Power LAI LINE message contains first and second areas for both groups", () => {
  const message = buildLineMessage(powerLaiRecord, "2026-07-09");
  assert.equal((message.match(/第一區/g) || []).length, 2);
  assert.equal((message.match(/第二區/g) || []).length, 2);
});
```

- [ ] **Step 2: Run tests and verify RED**

```powershell
node --test supabase/functions/lotto-predict-notify/lib/predictCore.test.mjs
```

Expected: FAIL because LAI-specific LINE output is missing.

- [ ] **Step 3: Implement flag parsing and state fetch**

```ts
const envFlag = (name: string) => (Deno.env.get(name) || "").toLowerCase() === "true";

async function fetchActiveAgentState(url: string, key: string, gameName: string) {
  const params = new URLSearchParams({
    select: "*",
    game_name: `eq.${gameName}`,
    is_active: "eq.true",
    limit: "1",
  });
  const response = await fetch(`${url}/rest/v1/lotto_agent_states?${params}`, { headers: serviceHeaders(key) });
  if (!response.ok) throw new Error(`Agent state query failed: ${response.status} ${await response.text()}`);
  return (await response.json())[0] || null;
}
```

- [ ] **Step 4: Implement forecast batch persistence**

Map every expert forecast to `lotto_model_forecasts` and upsert using the migration unique key. Save `final_groups` on the ensemble forecast row. Fail the request before reserving LINE if production forecast persistence fails.

- [ ] **Step 5: Wire shadow and production modes**

```ts
const laiEnabled = envFlag("LAI_V2_ENABLED");
const shadowEnabled = envFlag("LAI_V2_SHADOW_ENABLED");
const requestedEngine = url.searchParams.get("engine");
const laiDryRun = dryRun && requestedEngine === "lai-v2";
const useLaiRecord = laiEnabled || laiDryRun;

const lai = (useLaiRecord || shadowEnabled)
  ? generateAdaptivePrediction({ gameType, draws, generatedAt, targetDrawDate: drawTargetDate, agentState, dataStatus })
  : null;

if (lai) await upsertModelForecasts({
  supabaseUrl,
  serviceRoleKey,
  forecasts: lai.forecasts,
  forecastMode: useLaiRecord ? "production" : "shadow",
});
const record = useLaiRecord ? lai.record : generateHonestPrediction({ gameType, draws, generatedAt });
```

`shadowEnabled && !laiEnabled` must not change `prediction_records`, frontend output or LINE. `engine=lai-v2` must be rejected unless `dry_run=1`, and a dry run must never reserve or send a LINE notification.

- [ ] **Step 6: Implement LAI LINE formatter**

Add `buildLaiLineMessage` and dispatch when `prediction.model === "lai-v2"`. Use plain text, exactly 2 groups, group overlap, union size, agent status and `proven_above_random`.

- [ ] **Step 7: Run prediction tests**

```powershell
node --test supabase/functions/lotto-predict-notify/lib/*.test.mjs
```

Expected: all prediction tests PASS.

- [ ] **Step 8: Commit**

```powershell
git add supabase/functions/lotto-predict-notify/index.ts supabase/functions/lotto-predict-notify/lib/predictCore.js supabase/functions/lotto-predict-notify/lib/predictCore.test.mjs
git commit -m "feat: wire LAI forecasts and LINE delivery"
```

---

### Task 7: 開獎後評分、Hedge 更新與原子 state checkpoint

**Files:**
- Modify: `supabase/functions/lotto-update/lib/lottoCore.js:364-585`
- Modify: `supabase/functions/lotto-update/lib/lottoCore.test.mjs`
- Modify: `supabase/functions/lotto-update/index.ts:352-520`

**Interfaces:**
- Consumes: prediction record, model forecast rows, actual draw and active agent state.
- Produces: `scoreModelForecast`, `buildNextAgentState`, score rows, RPC payload, extended performance snapshot.

- [ ] **Step 1: Write failing post-draw score tests**

```js
test("scores every saved model probability against the draw", () => {
  const score = scoreModelForecast({
    forecast: { probabilities: Array(39).fill(5 / 39), final_groups: GROUPS },
    draw: { draw_id: "x", draw_date: "2026-07-10", numbers: [1, 2, 3, 4, 5] },
    config: { maxNumber: 39, picks: 5 },
  });
  assert.ok(Number.isFinite(score.metrics.brier));
  assert.equal(score.metrics.coverage.union_hits, 5);
});

test("same forecast and draw produce the same score payload", () => {
  assert.deepEqual(scoreModelForecast(INPUT), scoreModelForecast(INPUT));
});

test("next state records draw checkpoint and normalized weights", () => {
  const state = buildNextAgentState({ activeState, scoredForecasts, draw, promotionMetrics });
  assert.equal(state.last_learned_draw_id, draw.draw_id);
  assert.equal(Number(Object.values(state.expert_weights).reduce((a, b) => a + b, 0).toFixed(10)), 1);
});
```

- [ ] **Step 2: Run tests and verify RED**

```powershell
node --test supabase/functions/lotto-update/lib/lottoCore.test.mjs
```

Expected: FAIL because model scoring exports are missing.

- [ ] **Step 3: Implement pure scoring and next-state builders**

Import scoring and ensemble functions from the prediction lib by relative path. Produce deterministic JSON-ready rows and increment `state_version` by `1`. If the active state already contains the draw id, return `{ status: "already_learned" }`.

- [ ] **Step 4: Extend performance snapshot**

Add a `lai` object per game:

```js
gamePerf.lai = {
  brier_skill_score: latestMetrics.brier_skill_score,
  union_coverage_rate: unionHits / actualNumberCount,
  average_group_a_hits: groupAHits / evaluatedDraws,
  average_group_b_hits: groupBHits / evaluatedDraws,
  champion_model: latestState.champion_model,
  agent_status: latestState.status,
};
```

- [ ] **Step 5: Add Edge Function database operations**

Implement:

```ts
async function fetchUnscoredModelForecasts(
  supabaseUrl: string,
  serviceRoleKey: string,
  gameName: string,
  targetDrawDate: string,
): Promise<ModelForecastRow[]>;

async function upsertModelScores(
  supabaseUrl: string,
  serviceRoleKey: string,
  scoreRows: ModelScoreRow[],
): Promise<void>;

async function activateAgentState(
  supabaseUrl: string,
  serviceRoleKey: string,
  nextState: AgentStatePayload,
): Promise<void>;
```

Execution order per evaluated prediction: insert scores with `resolution=merge-duplicates` first, then call `rpc/activate_lotto_agent_state`. A repeated invocation finds existing score rows and matching `last_learned_draw_id`, so it performs no second update.

- [ ] **Step 6: Run update and prediction tests**

```powershell
node --test supabase/functions/lotto-update/lib/lottoCore.test.mjs supabase/functions/lotto-predict-notify/lib/*.test.mjs
```

Expected: all tests PASS.

- [ ] **Step 7: Commit**

```powershell
git add supabase/functions/lotto-update/lib/lottoCore.js supabase/functions/lotto-update/lib/lottoCore.test.mjs supabase/functions/lotto-update/index.ts
git commit -m "feat: learn LAI weights after each draw"
```

---

### Task 8: 建立可 checkpoint 的歷史 walk-forward 初始化

**Files:**
- Create: `supabase/functions/lotto-train-agent/index.ts`
- Create: `supabase/functions/lotto-train-agent/lib/trainingCore.js`
- Create: `supabase/functions/lotto-train-agent/lib/trainingCore.test.mjs`
- Modify: `docs/runtime-triggers.md`

**Interfaces:**
- Consumes: chronological draws, run cursor, chunk size and current simulated weights.
- Produces: `walkForwardChunk({ gameType, draws, cursor, chunkSize, state })`, updated run checkpoint and final baseline/challenger state.

- [ ] **Step 1: Write failing walk-forward tests**

```js
test("walk-forward uses only the prefix before each target draw", () => {
  const result = walkForwardChunk({ gameType: "539", draws: dailyDraws, cursor: 3, chunkSize: 1, state });
  assert.equal(result.steps[0].history_size, 3);
  assert.equal(result.steps[0].target_draw_id, dailyDraws[3].draw_id);
});

test("checkpoint continuation matches one larger chunk", () => {
  const first = walkForwardChunk({ gameType: "539", draws, cursor: 100, chunkSize: 20, state });
  const second = walkForwardChunk({ gameType: "539", draws, cursor: first.nextCursor, chunkSize: 20, state: first.state });
  const combined = walkForwardChunk({ gameType: "539", draws, cursor: 100, chunkSize: 40, state });
  assert.deepEqual(second.state, combined.state);
});
```

- [ ] **Step 2: Run tests and verify RED**

```powershell
node --test supabase/functions/lotto-train-agent/lib/trainingCore.test.mjs
```

Expected: FAIL because training core does not exist.

- [ ] **Step 3: Implement `walkForwardChunk`**

For each target index, call `buildExpertForecasts` with `draws.slice(0, targetIndex)`, score against `draws[targetIndex]`, update simulated weights and append compact metrics. Return `nextCursor`, `done`, `state` and `steps` through this stable contract:

```js
export function walkForwardChunk({ gameType, draws, cursor, chunkSize, state }) {
  const end = Math.min(cursor + chunkSize, draws.length);
  const steps = [];
  let nextState = structuredClone(state);

  for (let targetIndex = cursor; targetIndex < end; targetIndex += 1) {
    const history = draws.slice(0, targetIndex);
    const forecasts = buildExpertForecasts({
      gameType,
      draws: history,
      generatedAt: draws[targetIndex].draw_date,
    });
    const scored = forecasts.map((forecast) => scoreTrainingForecast(forecast, draws[targetIndex], gameType));
    nextState = updateTrainingState(nextState, scored, draws[targetIndex]);
    steps.push({
      target_draw_id: draws[targetIndex].draw_id,
      history_size: history.length,
      metrics: summarizeTrainingScores(scored),
    });
  }

  return { nextCursor: end, done: end >= draws.length, state: nextState, steps };
}
```

- [ ] **Step 4: Implement the training Edge Function**

Accept service-role authenticated JSON:

```json
{
  "run_id": "uuid",
  "chunk_size": 25
}
```

Load the training run and draws, process at most `chunk_size`, then update `checkpoint_cursor`, `summary` and status. Reject public anonymous calls. Do not schedule automatic continuous retraining in this task; initialization is invoked manually until completed.

```ts
const input = await request.json() as { run_id: string; chunk_size: number };
if (!input.run_id || !Number.isInteger(input.chunk_size) || input.chunk_size < 1 || input.chunk_size > 100) {
  return failFast(400, "Invalid training request.", input, "Provide run_id and chunk_size between 1 and 100.");
}

const run = await fetchTrainingRun(input.run_id);
const draws = await fetchChronologicalDraws(run.game_name);
const result = walkForwardChunk({
  gameType: gameTypeForName(run.game_name),
  draws,
  cursor: run.checkpoint_cursor,
  chunkSize: input.chunk_size,
  state: run.summary.state,
});
await saveTrainingCheckpoint(run.id, result);
```

- [ ] **Step 5: Document invocation and checkpoint inspection**

Add exact commands to `docs/runtime-triggers.md`:

```powershell
npx --yes supabase functions deploy lotto-train-agent --use-api
$headers = @{
  apikey = $env:SUPABASE_SERVICE_ROLE_KEY
  Authorization = "Bearer $($env:SUPABASE_SERVICE_ROLE_KEY)"
  Prefer = "return=representation"
  "Content-Type" = "application/json"
}
$gameName = "今彩539"
$encodedGameName = [uri]::EscapeDataString($gameName)
$countResponse = Invoke-WebRequest -Method Get -Uri "$env:SUPABASE_URL/rest/v1/lotto_draws?game_name=eq.$encodedGameName&select=draw_id&limit=1" -Headers ($headers + @{ Prefer = "count=exact" })
$drawCount = [int](($countResponse.Headers['Content-Range'] -split '/')[1])
$runBody = @{
  game_name = $gameName
  run_type = "walk_forward_initialization"
  algorithm_version = "lai-v2"
  status = "queued"
  range_start = 0
  range_end = $drawCount
  checkpoint_cursor = 0
  summary = @{ state = @{ status = "baseline"; state_version = 0 } }
} | ConvertTo-Json -Depth 6
$run = Invoke-RestMethod -Method Post -Uri "$env:SUPABASE_URL/rest/v1/lotto_training_runs?select=id" -Headers $headers -Body $runBody
$invokeBody = @{ run_id = $run[0].id; chunk_size = 25 } | ConvertTo-Json -Compress
Invoke-RestMethod -Method Post -Uri "$env:SUPABASE_URL/functions/v1/lotto-train-agent" -Headers $headers -Body $invokeBody
```

Repeat the same command for `大樂透` and `威力彩`. Document that only completed runs may seed a production candidate state and that `SUPABASE_SERVICE_ROLE_KEY` must never be committed.

- [ ] **Step 6: Run training tests**

```powershell
node --test supabase/functions/lotto-train-agent/lib/trainingCore.test.mjs
```

Expected: all tests PASS.

- [ ] **Step 7: Commit**

```powershell
git add supabase/functions/lotto-train-agent docs/runtime-triggers.md
git commit -m "feat: add checkpointed LAI walk-forward training"
```

---

### Task 9: 建立 LAI 前端 view model 與智能體狀態介面

**Files:**
- Create: `frontend/src/services/laiPresentation.js`
- Create: `frontend/src/services/laiPresentation.test.mjs`
- Create: `frontend/src/components/LaiAgentPanel.vue`
- Modify: `frontend/src/components/PredictionCard.vue:1-260`
- Modify: `frontend/src/services/supabaseData.js:60-125`
- Modify: `frontend/package.json`

**Interfaces:**
- Consumes: LAI prediction JSON already stored in `prediction_records`.
- Produces: `toLaiViewModel(predictionRecord)` and accessible LAI status panel.

- [ ] **Step 1: Write failing view-model tests**

```js
test("maps LAI prediction into two named groups and status", () => {
  const view = toLaiViewModel(LAI_RECORD);
  assert.equal(view.version, "LAI v2");
  assert.equal(view.status, "Baseline");
  assert.deepEqual(view.groups.map((group) => group.label), ["機率主攻", "覆蓋探索"]);
  assert.equal(view.unionSize, 10);
});

test("non-LAI records return null", () => {
  assert.equal(toLaiViewModel({ prediction: { model: "game-theory-v1" } }), null);
});
```

- [ ] **Step 2: Add frontend test script and verify RED**

Add:

```json
"test": "node --test src/services/*.test.mjs"
```

Run:

```powershell
npm.cmd test
```

from `frontend`. Expected: FAIL because `laiPresentation.js` does not exist.

- [ ] **Step 3: Implement the view model**

```js
export function toLaiViewModel(record) {
  const prediction = record?.prediction;
  if (prediction?.model !== 'lai-v2') return null;
  const labels = ['機率主攻', '覆蓋探索'];
  return {
    version: 'LAI v2',
    status: ({ baseline: 'Baseline', champion: 'Champion', degraded: 'Degraded' })[prediction.agent_status] || 'Degraded',
    stateVersion: prediction.agent_state_version,
    lastLearnedDate: prediction.evidence?.last_learned_draw_date || null,
    provenAboveRandom: Boolean(prediction.evidence?.proven_above_random),
    groups: labels.map((label) => ({ label, numbers: prediction.combinations?.[label] || [], special: prediction.special_combinations?.[label] || [] })),
    overlapCount: prediction.group_metrics?.overlap_count || 0,
    unionSize: prediction.group_metrics?.union_size || 0,
    expertWeights: prediction.expert_weights || {},
  };
}
```

- [ ] **Step 4: Implement `LaiAgentPanel.vue`**

Render a compact status header, two side-by-side groups, Power second area, overlap/union metrics and expert weights. Use existing game accent CSS variables, 8 px maximum card radius, and stack groups on mobile. Include visible text labels, not color-only status.

```vue
<script setup>
import { computed } from 'vue';
import { toLaiViewModel } from '../services/laiPresentation.js';

const props = defineProps({ record: { type: Object, required: true } });
const view = computed(() => toLaiViewModel(props.record));
</script>

<template>
  <section v-if="view" class="lai-agent" aria-labelledby="lai-agent-title">
    <header class="lai-agent__header">
      <h3 id="lai-agent-title">LAI v2 智能體</h3>
      <span class="lai-agent__status">{{ view.status }}</span>
    </header>
    <p>狀態版本 {{ view.stateVersion }}，最近學習 {{ view.lastLearnedDate || '尚無' }}</p>
    <div class="lai-agent__groups">
      <article v-for="group in view.groups" :key="group.label" class="lai-agent__group">
        <h4>{{ group.label }}</h4>
        <div class="lai-agent__numbers" :aria-label="`${group.label}號碼`">
          <span v-for="number in group.numbers" :key="number" class="number-ball">{{ String(number).padStart(2, '0') }}</span>
        </div>
        <p v-if="group.special.length">第二區：{{ group.special.join('、') }}</p>
      </article>
    </div>
    <p>聯集覆蓋 {{ view.unionSize }} 個號碼，兩組重疊 {{ view.overlapCount }} 個號碼。</p>
  </section>
</template>
```

- [ ] **Step 5: Branch PredictionCard by model**

```vue
<LaiAgentPanel
  v-if="latestPrediction?.prediction?.model === 'lai-v2'"
  :record="latestPrediction"
  :accent="accent"
/>
<template v-else>
  <!-- preserve the existing game-theory card without behavior changes -->
</template>
```

- [ ] **Step 6: Run frontend tests and build**

```powershell
npm.cmd test
npm.cmd run build:cloudflare
```

from `frontend`. Expected: tests PASS and Vite build exits `0`.

- [ ] **Step 7: Commit**

```powershell
git add frontend/src/services/laiPresentation.js frontend/src/services/laiPresentation.test.mjs frontend/src/components/LaiAgentPanel.vue frontend/src/components/PredictionCard.vue frontend/src/services/supabaseData.js frontend/package.json
git commit -m "feat: show LAI v2 prediction state"
```

---

### Task 10: 顯示賽後權重、coverage 與 performance

**Files:**
- Modify: `frontend/src/components/AsiLearningPanel.vue`
- Modify: `frontend/src/components/PerformanceChart.vue`
- Modify: `frontend/src/components/PredictionHistoryPanel.vue`
- Modify: `frontend/src/services/laiPresentation.js`
- Modify: `frontend/src/services/laiPresentation.test.mjs`

**Interfaces:**
- Consumes: extended `asi_learning_records.raw_learning_report`, prediction evaluation and `performance_snapshots.games[game].lai`.
- Produces: stable presentation rows for weight deltas, Champion changes, Brier skill and union coverage.

- [ ] **Step 1: Write failing learning-presentation tests**

```js
test("maps post-draw LAI learning without inventing causal explanations", () => {
  const view = toLaiLearningView(LEARNING_RECORD);
  assert.deepEqual(view.weightChanges, [{ model: "hazard", before: 0.2, after: 0.18, delta: -0.02 }]);
  assert.equal(view.championChanged, false);
  assert.equal(view.unionHits, 2);
  assert.ok(!JSON.stringify(view).includes("為什麼開"));
});
```

- [ ] **Step 2: Run tests and verify RED**

```powershell
npm.cmd test
```

from `frontend`. Expected: FAIL because `toLaiLearningView` is missing.

- [ ] **Step 3: Implement learning and performance mappers**

Return only recorded metrics and explicit limitations. Do not generate explanations from number outcome alone.

```js
export function toLaiLearningView(record) {
  const report = record?.raw_learning_report?.lai;
  if (!report) return null;
  return {
    drawDate: record.draw_date,
    weightChanges: report.weight_changes || [],
    championChanged: Boolean(report.champion_changed),
    championModel: report.champion_model || 'uniform',
    brierSkillScore: report.brier_skill_score ?? null,
    unionHits: report.coverage?.union_hits ?? 0,
    unionSize: report.coverage?.union_size ?? 0,
    limitation: '單期結果只能用於更新量化損失，不能證明特定號碼具有因果規律。',
  };
}
```

- [ ] **Step 4: Update the three components**

`AsiLearningPanel` adds weight-change rows and Champion status for LAI records while preserving legacy rows. `PerformanceChart` adds Brier Skill Score and union coverage summary cards. `PredictionHistoryPanel` uses the stored names「機率主攻」and「覆蓋探索」and keeps existing hit evaluation.

```vue
<template v-if="laiLearning">
  <p>Champion：{{ laiLearning.championModel }}</p>
  <p>Brier Skill Score：{{ formatScore(laiLearning.brierSkillScore) }}</p>
  <p>雙組聯集命中：{{ laiLearning.unionHits }} / {{ laiLearning.unionSize }}</p>
  <table>
    <thead><tr><th>專家</th><th>更新前</th><th>更新後</th><th>差異</th></tr></thead>
    <tbody>
      <tr v-for="row in laiLearning.weightChanges" :key="row.model">
        <td>{{ row.model }}</td><td>{{ row.before }}</td><td>{{ row.after }}</td><td>{{ row.delta }}</td>
      </tr>
    </tbody>
  </table>
  <p>{{ laiLearning.limitation }}</p>
</template>
```

- [ ] **Step 5: Run frontend tests and build**

```powershell
npm.cmd test
npm.cmd run build:cloudflare
```

Expected: tests PASS and build exits `0`.

- [ ] **Step 6: Commit**

```powershell
git add frontend/src/components/AsiLearningPanel.vue frontend/src/components/PerformanceChart.vue frontend/src/components/PredictionHistoryPanel.vue frontend/src/services/laiPresentation.js frontend/src/services/laiPresentation.test.mjs
git commit -m "feat: show LAI learning performance"
```

---

### Task 11: Shadow、production dry run 與正式切換驗證

**Files:**
- Modify: `docs/runtime-triggers.md`
- Modify: `docs/deployment-cloudflare-supabase.md`

**Interfaces:**
- Consumes: deployed migration/functions, Supabase secrets and completed training run.
- Produces: verified shadow forecast, production dry-run evidence, feature flag rollout and rollback instructions.

- [ ] **Step 1: Run the full local verification suite**

```powershell
node --test supabase/functions/lotto-predict-notify/lib/*.test.mjs
node --test supabase/functions/lotto-update/lib/lottoCore.test.mjs
node --test supabase/functions/lotto-train-agent/lib/trainingCore.test.mjs
npm.cmd test
npm.cmd run build:cloudflare
```

Run the npm commands from `frontend`. Expected: every command exits `0` with no failed tests.

- [ ] **Step 2: Apply migration and deploy functions**

```powershell
npx --yes supabase db push
npx --yes supabase functions deploy lotto-predict-notify --use-api
npx --yes supabase functions deploy lotto-update --use-api
npx --yes supabase functions deploy lotto-train-agent --use-api
```

Expected: migration and all three deployments succeed.

- [ ] **Step 3: Enable shadow mode only**

```powershell
npx --yes supabase secrets set LAI_V2_SHADOW_ENABLED=true LAI_V2_ENABLED=false
```

Invoke a dry run for one due game and verify:

1. Existing prediction/LINE payload remains legacy.
2. `lotto_model_forecasts.forecast_mode = 'shadow'` rows exist.
3. Exactly one forecast exists per expert/version/date.
4. All probability vectors are legal.

- [ ] **Step 4: Complete walk-forward initialization**

Create one training run per game and invoke `lotto-train-agent` repeatedly until `status = 'completed'`. The run-creation code must fetch each game's exact current draw count for `range_end`; it must not reuse a hard-coded fixture count. Invoke one chunk, re-read the row, and continue only while the cursor increases:

```powershell
do {
  $before = Invoke-RestMethod -Method Get -Uri "$env:SUPABASE_URL/rest/v1/lotto_training_runs?id=eq.$runId&select=status,checkpoint_cursor" -Headers $headers
  $invokeBody = @{ run_id = $runId; chunk_size = 25 } | ConvertTo-Json -Compress
  Invoke-RestMethod -Method Post -Uri "$env:SUPABASE_URL/functions/v1/lotto-train-agent" -Headers $headers -Body $invokeBody
  $after = Invoke-RestMethod -Method Get -Uri "$env:SUPABASE_URL/rest/v1/lotto_training_runs?id=eq.$runId&select=status,checkpoint_cursor,summary,error_text" -Headers $headers
  if ($after[0].status -eq 'failed') { throw $after[0].error_text }
  if ($after[0].status -ne 'completed' -and $after[0].checkpoint_cursor -le $before[0].checkpoint_cursor) {
    throw 'Training cursor did not advance.'
  }
} while ($after[0].status -ne 'completed')
```

Verify completed metrics include recent 100 and 500 windows.

- [ ] **Step 5: Run production-mode dry run without LINE**

Invoke `lotto-predict-notify` with its existing `dry_run=1` query contract and `LAI_V2_ENABLED=true` in a controlled deployment:

```powershell
$dryRunUrl = "$env:SUPABASE_URL/functions/v1/lotto-predict-notify?game=all&dry_run=1&engine=lai-v2&target_date=2026-07-10"
$dryRun = Invoke-RestMethod -Method Post -Uri $dryRunUrl -Headers $headers -Body '{}'
$dryRun | ConvertTo-Json -Depth 12
```

Verify response contains exactly two groups for each game, and Power Lottery includes two second-area values. Confirm `notification_logs` has no new `sent` row for this invocation.

- [ ] **Step 6: Enable LAI v2 and verify evidence-first behavior**

```powershell
npx --yes supabase secrets set LAI_V2_SHADOW_ENABLED=false LAI_V2_ENABLED=true
```

Verify in order:

1. `lotto_model_forecasts` production rows exist.
2. `prediction_records.prediction.model = 'lai-v2'`.
3. LINE notification is sent once per game/date.
4. Frontend shows「機率主攻」and「覆蓋探索」after Taiwan 10:00.
5. A repeated invocation is skipped by notification uniqueness.

- [ ] **Step 7: Verify rollback**

```powershell
npx --yes supabase secrets set LAI_V2_ENABLED=false
```

Run dry-run and confirm the legacy `game-theory-v1` record is generated without deleting LAI tables or history. Re-enable LAI only after rollback evidence is recorded.

- [ ] **Step 8: Update operations documentation**

Document exact flags, table checkpoints, dry-run commands, expected statuses and rollback sequence in both runtime/deployment documents.

- [ ] **Step 9: Final commit**

```powershell
git add docs/runtime-triggers.md docs/deployment-cloudflare-supabase.md
git commit -m "docs: add LAI v2 rollout runbook"
```

---

## Final Verification Checklist

- [ ] All new pure functions were introduced through RED-GREEN tests.
- [ ] Full prediction, update, training and frontend test commands exit `0`.
- [ ] `frontend` Cloudflare production build exits `0`.
- [ ] Migration applies without destructive table replacement.
- [ ] Shadow mode creates evidence but does not change LINE/frontend output.
- [ ] Production mode emits exactly 2 groups for every due game.
- [ ] Power Lottery emits first and second areas for both groups.
- [ ] Prediction and expert forecasts are saved before LINE send.
- [ ] Same draw cannot update weights twice.
- [ ] Missing data falls back to 2 uniform baseline groups with `Degraded` status.
- [ ] No model is marked Champion without all promotion gates.
- [ ] Rollback restores `game-theory-v1` without deleting LAI history.
- [ ] `.claude/settings.local.json` remains uncommitted and unchanged by implementation.
