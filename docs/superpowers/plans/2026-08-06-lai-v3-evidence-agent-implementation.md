# LAI v3 Evidence Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立可證偽、可重播且與 production 隔離的 LAI v3 Evidence Agent，讓三個彩種固定輸出兩組正式推薦，並只依通過統計閘門的樣本外證據調整 production。

**Architecture:** LAI v2 保留為 production 回退路徑；LAI v3 的共用數學核心位於 `supabase/functions/_shared/lai-v3`，供預測、開獎後評分與 checkpointed training 共用。新模型先寫入 shadow evidence，獨立 promotion gate 才能核准 canary 或 champion；正式兩組由已核准機率向量經「證據主攻／覆蓋保底」最佳化器產生，Gemini 只轉述系統已計算完成的證據。

**Tech Stack:** Supabase Postgres migrations、RLS、Postgres RPC、Supabase Cron、Deno/TypeScript Edge Functions、ES modules、Node.js `node:test`、Vue 3、Vite、Cloudflare Pages。

## Global Constraints

- 正式排程維持台灣時間每日 06:00 更新及評分，開獎日每日 10:00 預測及發送 LINE；不得新增 GitHub Actions 正式排程。
- LAI v2 必須持續作為最後有效 production 回退，直到 LAI v3 完成 shadow 與 canary 閘門。
- 所有新模型的 production 權重初始值為 `0`；shadow 預測不得寫入 `prediction_records`、不得建立 `notification_logs`、不得發送 LINE。
- 永久保留 `uniform-null`；沒有 challenger 通過時，維持原 champion 或回退 `uniform-null`。
- 正式推薦固定為「證據主攻」與「覆蓋保底」兩組；今彩 539 每組 5 號，大樂透與威力彩第 1 區每組 6 號。
- 威力彩第 2 區必須使用獨立的 1 至 8 機率向量、最佳化、評分與命中率，不得由第 1 區特徵推導。
- Promotion 主要門檻為 Brier skill 的 paired block bootstrap 95% 信賴區間下界大於 `0`、log loss 不退步、coverage 不退步、Benjamini-Hochberg `q <= 0.05`。
- `shadow_verified` 至少需要 30 個有效 live draws；`canary` 權重上限為 10%，且至少再觀察 20 個有效 draws。
- `lotto_agent_states.status` 繼續使用既有 `baseline|champion|degraded` 契約；v3 的 `baseline|registered|historical_passed|shadow_verified|canary|champion|cooldown|disabled|rejected` 階段存於 registry，active state 只在 `metrics.promotion_stage` 鏡射目前階段。
- Champion 必須同時滿足 recent-100 與 recent-500 skill 大於 `0`；資料不足時只能回報「尚無足夠證據」。
- Rolling-30 Brier skill 小於 `0`、校準顯著惡化、資料錯誤或 replay digest 不一致時，必須降級、停用或回退。
- 單期高命中或零命中不得直接升級或降級模型。
- Gemini 不得產生正式號碼、機率、特徵、權重、統計門檻或 promotion 決策，也不得把文字解釋回灌為數值特徵。
- 每次 forecast、score、experiment、decision 與 evidence snapshot 都必須帶有資料截止點、版本、seed、code commit 與 replay digest。
- 官方資料更正必須建立 correction event，失效舊 score 後新增重算結果，不得靜默覆寫。
- 同彩種的 scoring、decision 與 state activation 必須使用 idempotency key、資料庫交易與 `pg_advisory_xact_lock`。
- Edge Function 中的歷史重播維持 `chunk_size = 25`；不得把完整 replay 放入每日 10:00 的通知請求。
- `.claude/settings.local.json` 是既有使用者變更，任何實作 commit 都不得納入或修改它。

---

## File Structure

### New files

- `supabase/migrations/20260806000000_create_lai_v3_evidence_agent.sql`：建立 model registry、experiment、promotion decision、evidence snapshot、correction 與原子 RPC。
- `supabase/functions/_shared/lai-v3/contracts.js`：集中定義狀態、模式、模型家族、閘門常數與資料驗證。
- `supabase/functions/_shared/lai-v3/contracts.test.mjs`：驗證跨 Function 資料契約。
- `supabase/functions/_shared/lai-v3/statistics.js`：deterministic RNG、block bootstrap、permutation、FDR 與 calibration。
- `supabase/functions/_shared/lai-v3/statistics.test.mjs`：數值、決定性與錯誤輸入測試。
- `supabase/functions/_shared/lai-v3/models.js`：`uniform-null`、`bayesian-drift`、`transition-regularized`、`sequence-challenger`。
- `supabase/functions/_shared/lai-v3/models.test.mjs`：機率合法性、資料截止點與威力彩分區測試。
- `supabase/functions/_shared/lai-v3/evaluation.js`：proper scoring、matched-random ticket utility 與候選模型證據彙總。
- `supabase/functions/_shared/lai-v3/evaluation.test.mjs`：主區、第二區、random baseline 與樣本配對測試。
- `supabase/functions/_shared/lai-v3/promotionGate.js`：狀態機、promotion、demotion、cooldown 與 production 權重。
- `supabase/functions/_shared/lai-v3/promotionGate.test.mjs`：各階段閘門與 family cap 測試。
- `supabase/functions/_shared/lai-v3/falsification.test.mjs`：純隨機 false promotion 與注入弱偏差的 synthetic tests。
- `supabase/functions/lotto-train-agent/lib/evidenceTraining.js`：LAI v3 checkpointed walk-forward 與 replay digest。
- `supabase/functions/lotto-train-agent/lib/evidenceTraining.test.mjs`：chunk continuation、無未來洩漏與 bit-for-bit replay。
- `supabase/functions/lotto-update/lib/evidenceLearning.js`：每日 score、decision、correction 與 state transition orchestration。
- `supabase/functions/lotto-update/lib/evidenceLearning.test.mjs`：冪等、錯誤隔離、correction 與 promotion persistence。
- `supabase/functions/lotto-predict-notify/lib/evidenceOptimizer.js`：證據主攻與覆蓋保底 constrained optimizer。
- `supabase/functions/lotto-predict-notify/lib/evidenceOptimizer.test.mjs`：合法性、效用下限、重疊與威力彩第 2 區測試。
- `supabase/functions/lotto-predict-notify/lib/evidencePrediction.js`：LAI v3 正式／shadow prediction record 與 evidence snapshot builder。
- `supabase/functions/lotto-predict-notify/lib/evidencePrediction.test.mjs`：approved-state、兩組輸出與 stale state 測試。
- `supabase/functions/lotto-predict-notify/lib/evidenceRepository.js`：LAI v3 registry、experiment 與 snapshot 的 Supabase REST adapter。
- `supabase/functions/lotto-predict-notify/lib/evidenceRepository.test.mjs`：REST path、service-role 與失敗回傳測試。
- `frontend/src/components/ModelEvidencePanel.vue`：顯示 champion、shadow 樣本、Brier skill CI、promotion 與理由。
- `scripts/lai_v3_replay.mjs`：從 Supabase 或本地 JSON 執行唯讀完整歷史 replay。
- `scripts/lai_v3_replay.test.mjs`：CLI 參數、資料排序、digest 與預設唯讀測試。
- `scripts/lai_v3_verify.mjs`：唯讀檢查 schema、RLS、RPC、active state、shadow 與 LINE 去重邊界。

### Existing files to modify

- `supabase/functions/lotto-predict-notify/lib/scoring.js:141-214`：沿用 per-number Brier/log loss，供 LAI v3 evaluation 匯入。
- `supabase/functions/lotto-predict-notify/lib/experts.js:149-340`：只匯出既有 sequence 分數供 shadow challenger 使用，不改 LAI v2 輸出。
- `supabase/functions/lotto-predict-notify/lib/agentState.js:1-63`：保留 LAI v2 API，改為 re-export 共用 FDR 實作。
- `supabase/functions/lotto-predict-notify/lib/predictCore.js:1443-1690`：加入 LAI v3 LINE formatter 與相容判斷，不把新數學邏輯塞回此大檔。
- `supabase/functions/lotto-predict-notify/lib/notifyRuntime.js:34-216`：加入 v3 shadow／production lane、核准狀態回退與 shadow failure isolation。
- `supabase/functions/lotto-predict-notify/lib/notifyRuntime.test.mjs:1-575`：新增 v3 runtime 與 LINE 不重複測試。
- `supabase/functions/lotto-predict-notify/index.ts:1-625`：讀取 v3 flags、注入 evidence repository、支援 `engine=lai-v3` dry-run。
- `supabase/functions/lotto-predict-notify/index.contract.test.mjs`：驗證 secrets、service-role、dry-run 與 persistence 順序。
- `supabase/functions/lotto-train-agent/lib/trainingCore.js:248-421`：依 `algorithm_version` dispatch LAI v2 或 LAI v3 chunk processor。
- `supabase/functions/lotto-train-agent/lib/trainingCore.test.mjs:1-337`：保留 v2 regression，新增 v3 dispatch contract。
- `supabase/functions/lotto-train-agent/lib/trainingHttp.js:74-230`：讀寫 `lai_experiment_runs` 與 model registry，不允許 v3 training 直接 activate state。
- `supabase/functions/lotto-train-agent/lib/trainingHttp.test.mjs:1-134`：驗證 v3 repository 路徑與 server-only 權限。
- `supabase/functions/lotto-update/lib/lottoCore.js:422-1047`：委派 v3 scoring／gate，保留 LAI v2 wrappers 與既有 ordered-learning 行為。
- `supabase/functions/lotto-update/lib/lottoCore.test.mjs:1-1115`：加入 v3 score shape 與 v2 regression。
- `supabase/functions/lotto-update/index.ts:464-1025`：提供 v3 dependencies、correction detection 與 failure isolation。
- `supabase/functions/lotto-update/lib/postDrawLearning.test.mjs:1-507`：驗證同一期只學習一次、shadow 失敗不影響正式資料。
- `frontend/src/services/laiPresentation.js:1-151`：相容 `lai-v2` 與 `lai-v3`，映射證據狀態。
- `frontend/src/services/laiPresentation.test.mjs:1-207`：加入 v3 evidence view tests。
- `frontend/src/components/LaiAgentPanel.vue:1-100`：顯示動態版本與嵌入證據狀態。
- `frontend/src/components/PredictionCard.vue:1-264`：以 `isLaiPredictionRecord` 判斷 v2/v3，不再硬編碼 `lai-v2`。
- `frontend/src/components/PerformanceChart.vue:1-258`：顯示具 CI 的 Brier skill，避免只顯示單一點估計。
- `frontend/src/services/responsiveLayout.test.mjs:1-21`：加入證據面板的 mobile overflow contract。
- `docs/runtime-triggers.md`：記錄 v3 flags、06:00/10:00 checkpoint、shadow/canary/champion 與 rollback。
- `docs/deployment-cloudflare-supabase.md`：記錄 migration、Function deploy、Cloudflare build 與 production 驗證。
- `README.md`：更新正式引擎、科學限制與兩組推薦名稱。

---

### Task 1: 建立 LAI v3 證據資料模型與安全 RPC

**Files:**
- Create: `supabase/migrations/20260806000000_create_lai_v3_evidence_agent.sql`
- Create: `supabase/functions/_shared/lai-v3/schemaMigration.test.mjs`

**Interfaces:**
- Consumes: `lotto_agent_states`、`lotto_model_forecasts`、`lotto_model_scores`、`lotto_training_runs`、`activate_lotto_agent_state(jsonb)`。
- Produces: `lai_model_registry`、`lai_experiment_runs`、`lai_promotion_decisions`、`lai_evidence_snapshots`、`lai_evidence_corrections`、`record_lai_v3_decision(jsonb)`、`activate_lai_v3_state(uuid,jsonb)`、`record_lai_v3_correction(jsonb)`。

- [ ] **Step 1: 寫入會先失敗的 migration contract test**

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = new URL(
  "../../../migrations/20260806000000_create_lai_v3_evidence_agent.sql",
  import.meta.url,
);

test("LAI v3 schema is private, auditable, and atomically activated", async () => {
  const sql = await readFile(migration, "utf8");
  for (const table of [
    "lai_model_registry",
    "lai_experiment_runs",
    "lai_promotion_decisions",
    "lai_evidence_snapshots",
    "lai_evidence_corrections",
  ]) {
    assert.match(sql, new RegExp(`create table if not exists public\\.${table}`, "i"));
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`, "i"));
    assert.match(sql, new RegExp(`revoke all on table public\\.${table} from anon`, "i"));
  }
  assert.match(sql, /pg_advisory_xact_lock/i);
  assert.match(sql, /record_lai_v3_decision\(p_decision jsonb\)/i);
  assert.match(sql, /activate_lai_v3_state\(p_decision_id uuid, p_state jsonb\)/i);
  assert.match(sql, /challenger_weight > 0\.10/i);
  assert.match(sql, /algorithm_version <> 'lai-v2'/i);
  assert.doesNotMatch(sql, /grant execute[\s\S]*to (anon|authenticated)/i);
});
```

- [ ] **Step 2: 執行 test 並確認 RED**

Run:

```powershell
node --test supabase/functions/_shared/lai-v3/schemaMigration.test.mjs
```

Expected: FAIL with `ENOENT` because the migration does not exist.

- [ ] **Step 3: 建立五張表與不可變欄位**

Migration 必須使用下列欄位與狀態：

```sql
create table if not exists public.lai_model_registry (
  id uuid primary key default gen_random_uuid(),
  game_name text not null,
  model_name text not null,
  model_family text not null check (model_family in (
    'uniform-null', 'bayesian-drift', 'transition-regularized', 'sequence-challenger'
  )),
  model_version text not null,
  feature_version text not null,
  parameters jsonb not null default '{}'::jsonb,
  code_commit text not null check (code_commit ~ '^[0-9a-f]{7,64}$'),
  status text not null check (status in (
    'baseline', 'registered', 'historical_passed', 'shadow_verified',
    'canary', 'champion', 'cooldown', 'disabled', 'rejected'
  )),
  status_reason text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (game_name, model_name, model_version)
);

create table if not exists public.lai_experiment_runs (
  id uuid primary key default gen_random_uuid(),
  registry_id uuid not null references public.lai_model_registry(id),
  game_name text not null,
  run_mode text not null check (run_mode in ('historical', 'shadow', 'canary')),
  status text not null check (status in ('queued', 'running', 'completed', 'failed')),
  data_cutoff date not null,
  range_start integer not null default 0,
  range_end integer not null,
  checkpoint_cursor integer not null default 0,
  random_seed text not null,
  code_commit text not null,
  feature_version text not null,
  metrics jsonb not null default '{}'::jsonb,
  replay_digest text,
  error_text text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.lai_promotion_decisions (
  id uuid primary key default gen_random_uuid(),
  registry_id uuid not null references public.lai_model_registry(id),
  game_name text not null,
  from_status text not null,
  decision text not null check (decision in ('promote', 'hold', 'demote', 'disable')),
  to_status text not null,
  gate_version text not null,
  evidence jsonb not null,
  evidence_digest text not null,
  reason text not null,
  decided_at timestamptz not null default now(),
  unique (registry_id, evidence_digest, decision)
);

create table if not exists public.lai_evidence_snapshots (
  id uuid primary key default gen_random_uuid(),
  prediction_source_key text not null unique,
  game_name text not null,
  target_draw_date date not null,
  champion_registry_id uuid references public.lai_model_registry(id),
  agent_state_version bigint,
  model_version text not null,
  data_cutoff date not null,
  data_status text not null,
  main_probabilities jsonb not null,
  special_probabilities jsonb,
  groups jsonb not null,
  group_metrics jsonb not null,
  optimizer_version text not null,
  random_seed text not null,
  code_commit text not null,
  notification_key text not null,
  replay_digest text not null,
  generated_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists public.lai_evidence_corrections (
  id uuid primary key default gen_random_uuid(),
  game_name text not null,
  draw_id text not null,
  previous_revision text not null,
  corrected_revision text not null,
  previous_draw jsonb not null,
  corrected_draw jsonb not null,
  invalidated_score_ids jsonb not null default '[]'::jsonb,
  replacement_score_ids jsonb not null default '[]'::jsonb,
  reason text not null,
  created_at timestamptz not null default now(),
  unique (game_name, draw_id, corrected_revision)
);
```

同一 migration 必須：

1. 為 `lotto_model_forecasts` 新增 `registry_id`、`experiment_run_id`、`feature_version`、`random_seed`、`code_commit`、`replay_digest`。
2. 將 `forecast_mode` check 擴充為 `shadow`、`canary`、`production`。
3. 為 `lotto_training_runs` 新增 nullable `experiment_run_id`。
4. 為 `lotto_model_scores` 新增 `source_revision`、`is_valid`、`invalidated_at`、`supersedes_score_id`，並將唯一性改為只限制 `is_valid = true` 的 `(forecast_id, draw_id)`。
5. 禁止 `activate_lotto_training_candidate(uuid)` 接受 `algorithm_version <> 'lai-v2'`，確保 v3 training 不可繞過新 gate。
6. 建立 partial unique index，限制每彩種只有一筆 `uniform-null + baseline`，以及每個 `(game_name, model_family)` 最多一筆 `canary|champion`。
7. 對 registry 與 experiment 套用既有 `set_updated_at()` trigger，並為 `(game_name, status)`、`(registry_id, decided_at)`、`(game_name, target_draw_date)` 建立查詢 index。
8. 五張新表全部 enable RLS、revoke `public|anon|authenticated`，並只 grant 必要的 service-role CRUD/execute。

- [ ] **Step 4: 建立原子 decision、activation 與 correction RPC**

`record_lai_v3_decision` 必須鎖定彩種、insert immutable decision，並只更新 registry 的 `status`、`status_reason`、`updated_at`。`activate_lai_v3_state` 必須重新讀取 decision；只有 `promote -> canary|champion` 可啟用 state，且 canary challenger 權重不得超過 `0.10`。

```sql
perform pg_advisory_xact_lock(hashtextextended(decision_row.game_name, 0));

if decision_row.decision <> 'promote'
   or decision_row.to_status not in ('canary', 'champion') then
  raise exception 'decision does not authorize activation';
end if;

challenger_weight := coalesce(
  (p_state->'expert_weights'->>registry_row.model_name)::numeric,
  0
);
if decision_row.to_status = 'canary' and challenger_weight > 0.10 then
  raise exception 'challenger_weight > 0.10';
end if;

if p_state #>> '{metrics,promotion_stage}' <> decision_row.to_status then
  raise exception 'agent state promotion_stage does not match decision';
end if;

if decision_row.to_status = 'canary'
   and p_state->>'status' not in ('baseline', 'champion', 'degraded') then
  raise exception 'canary must preserve the existing lotto_agent_states status contract';
end if;
```

`record_lai_v3_correction` 必須在同一 transaction 中將舊 score 設為 `is_valid = false`、寫入 replacement scores，再寫 correction event。所有 RPC 只授權 `service_role`。

另建立三個 protection triggers：model registry update 只允許變更 `status`、`status_reason`、`updated_at`；completed experiment 不可改 model/data cutoff/seed/digest；promotion decisions、evidence snapshots 與 correction events 禁止 update/delete。

- [ ] **Step 5: 執行 migration contract test 並確認 GREEN**

```powershell
node --test supabase/functions/_shared/lai-v3/schemaMigration.test.mjs
git diff --check
```

Expected: migration contract PASS；`git diff --check` exit `0`。

- [ ] **Step 6: 對 linked project 執行唯讀 migration dry-run**

```powershell
if (-not $env:SUPABASE_PROJECT_REF) { throw 'SUPABASE_PROJECT_REF is required.' }
npx --yes supabase link --project-ref $env:SUPABASE_PROJECT_REF
npx --yes supabase migration list
npx --yes supabase db push --dry-run
```

Expected: dry-run 只列出 `20260806000000_create_lai_v3_evidence_agent.sql`，不修改 remote database。

- [ ] **Step 7: Commit**

```powershell
git add supabase/migrations/20260806000000_create_lai_v3_evidence_agent.sql supabase/functions/_shared/lai-v3/schemaMigration.test.mjs
git commit -m "feat: add LAI v3 evidence schema"
```

---

### Task 2: 建立共用契約與決定性統計核心

**Files:**
- Create: `supabase/functions/_shared/lai-v3/contracts.js`
- Create: `supabase/functions/_shared/lai-v3/contracts.test.mjs`
- Create: `supabase/functions/_shared/lai-v3/statistics.js`
- Create: `supabase/functions/_shared/lai-v3/statistics.test.mjs`
- Modify: `supabase/functions/lotto-predict-notify/lib/agentState.js:26-41`

**Interfaces:**
- Produces: `V3_MODEL_FAMILIES`、`V3_STAGES`、`V3_GATE_CONFIG`、`assertProbabilityVector`、`assertForecastCutoff`、`mean`、`seededRandom`、`pairedBlockBootstrap`、`pairedPermutationTest`、`benjaminiHochberg`、`expectedCalibrationError`。
- Compatibility: `agentState.js` 繼續 export `benjaminiHochberg`，現有 LAI v2 import 不需改名。

- [ ] **Step 1: 寫入 contracts 與 statistics 的 failing tests**

```js
test("gate constants preserve approved sample boundaries", () => {
  assert.deepEqual(V3_GATE_CONFIG, {
    qMax: 0.05,
    confidence: 0.95,
    shadowLiveDraws: 30,
    canaryLiveDraws: 20,
    canaryWeightMax: 0.10,
    rollingDemotionWindow: 30,
    bootstrapIterations: 2000,
    permutationIterations: 5000,
  });
});

test("paired bootstrap is deterministic for the same seed", () => {
  const input = { deltas: [0.1, 0.2, -0.1, 0.3], blockLength: 2, iterations: 200, seed: "same" };
  assert.deepEqual(pairedBlockBootstrap(input), pairedBlockBootstrap(input));
});

test("Benjamini-Hochberg preserves input order", () => {
  assert.deepEqual(benjaminiHochberg([0.01, 0.04, 0.03]), [0.03, 0.04, 0.04]);
});
```

- [ ] **Step 2: 執行 tests 並確認 RED**

```powershell
node --test supabase/functions/_shared/lai-v3/contracts.test.mjs supabase/functions/_shared/lai-v3/statistics.test.mjs
```

Expected: FAIL because the modules do not exist.

- [ ] **Step 3: 實作固定契約與輸入驗證**

```js
export const V3_MODEL_FAMILIES = Object.freeze([
  "uniform-null",
  "bayesian-drift",
  "transition-regularized",
  "sequence-challenger",
]);

export const V3_STAGES = Object.freeze([
  "baseline",
  "registered",
  "historical_passed",
  "shadow_verified",
  "canary",
  "champion",
  "cooldown",
  "disabled",
  "rejected",
]);

export const V3_GATE_CONFIG = Object.freeze({
  qMax: 0.05,
  confidence: 0.95,
  shadowLiveDraws: 30,
  canaryLiveDraws: 20,
  canaryWeightMax: 0.10,
  rollingDemotionWindow: 30,
  bootstrapIterations: 2000,
  permutationIterations: 5000,
});
```

`assertProbabilityVector(values, { maxNumber, picks })` 必須驗證 length、finite、`0 <= p <= 1`，以及 `sum(p)` 在 `1e-9` 內等於 picks。`assertForecastCutoff(draws, generatedAt)` 必須拒絕 `draw_date >= generatedAt` 的資料。

- [ ] **Step 4: 實作 deterministic resampling**

```js
export function seededRandom(seed) {
  let state = 2166136261;
  for (const char of String(seed)) {
    state ^= char.charCodeAt(0);
    state = Math.imul(state, 16777619);
  }
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function pairedBlockBootstrap({ deltas, blockLength, iterations = 2000, seed }) {
  if (!Array.isArray(deltas) || deltas.length < 2) throw new RangeError("at least two deltas are required");
  if (!Number.isInteger(blockLength) || blockLength < 1 || blockLength > deltas.length) {
    throw new RangeError("blockLength is outside the sample range");
  }
  const rng = seededRandom(seed);
  const means = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const sample = [];
    while (sample.length < deltas.length) {
      const start = Math.floor(rng() * deltas.length);
      for (let offset = 0; offset < blockLength && sample.length < deltas.length; offset += 1) {
        sample.push(deltas[(start + offset) % deltas.length]);
      }
    }
    means.push(sample.reduce((sum, value) => sum + value, 0) / sample.length);
  }
  means.sort((left, right) => left - right);
  return {
    mean: deltas.reduce((sum, value) => sum + value, 0) / deltas.length,
    lower95: means[Math.floor((means.length - 1) * 0.025)],
    upper95: means[Math.ceil((means.length - 1) * 0.975)],
  };
}

export function pairedPermutationTest({ deltas, blockLength, iterations = 5000, seed }) {
  const observed = deltas.reduce((sum, value) => sum + value, 0) / deltas.length;
  const rng = seededRandom(seed);
  let atLeastObserved = 0;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const permuted = deltas.map((value, index) => {
      const block = Math.floor(index / blockLength);
      return { value, block };
    });
    const signs = new Map();
    const mean = permuted.reduce((sum, row) => {
      if (!signs.has(row.block)) signs.set(row.block, rng() < 0.5 ? -1 : 1);
      return sum + row.value * signs.get(row.block);
    }, 0) / deltas.length;
    if (mean >= observed) atLeastObserved += 1;
  }
  return (atLeastObserved + 1) / (iterations + 1);
}
```

`expectedCalibrationError` 將每期每個號碼視為 Bernoulli outcome，固定使用 10 個 bins；空樣本回傳 `null`，不得回傳 `0` 冒充完美校準。

- [ ] **Step 5: 保持 LAI v2 FDR 相容**

```js
import { benjaminiHochberg } from "../../_shared/lai-v3/statistics.js";
export { benjaminiHochberg };
```

刪除 `agentState.js` 內重複的 FDR 函式，但不得改動 `createBaselineState` 或 `evaluatePromotion` 的 LAI v2 行為。

- [ ] **Step 6: 執行新舊統計 tests**

```powershell
node --test supabase/functions/_shared/lai-v3/contracts.test.mjs supabase/functions/_shared/lai-v3/statistics.test.mjs supabase/functions/lotto-predict-notify/lib/agentState.test.mjs
```

Expected: all tests PASS，且相同 seed 的 bootstrap/permutation bit-for-bit 相同。

- [ ] **Step 7: Commit**

```powershell
git add supabase/functions/_shared/lai-v3 supabase/functions/lotto-predict-notify/lib/agentState.js
git commit -m "feat: add deterministic LAI v3 statistics"
```

---

### Task 3: 建立四個受控模型家族

**Files:**
- Create: `supabase/functions/_shared/lai-v3/models.js`
- Create: `supabase/functions/_shared/lai-v3/models.test.mjs`
- Modify: `supabase/functions/lotto-predict-notify/lib/experts.js:149-234`

**Interfaces:**
- Consumes: `{ gameType, draws, generatedAt, registrations }`、`GAME_CONFIG`、既有 `lstmScores`。
- Produces: `buildEvidenceForecasts(input)` returning `EvidenceForecast[]`。
- `EvidenceForecast`: `{ registryId, name, family, version, featureVersion, parameters, codeCommit, probabilities, specialProbabilities, featureSummary, dataCutoff, randomSeed }`。

- [ ] **Step 1: 寫入模型 contract failing tests**

```js
const NOW = "2026-08-06T10:00:00+08:00";
const fixtures = {
  "539": [
    { draw_id: "1", draw_date: "2026-08-01", numbers: [1, 2, 3, 4, 5] },
    { draw_id: "2", draw_date: "2026-08-03", numbers: [6, 7, 8, 9, 10] },
    { draw_id: "3", draw_date: "2026-08-05", numbers: [11, 12, 13, 14, 15] },
  ],
  "649": [
    { draw_id: "1", draw_date: "2026-07-28", numbers: [1, 8, 16, 24, 32, 40] },
    { draw_id: "2", draw_date: "2026-07-31", numbers: [2, 9, 17, 25, 33, 41] },
    { draw_id: "3", draw_date: "2026-08-04", numbers: [3, 10, 18, 26, 34, 42] },
  ],
  power: [
    { draw_id: "1", draw_date: "2026-07-27", numbers: [1, 7, 13, 19, 25, 31], special_number: 1 },
    { draw_id: "2", draw_date: "2026-07-30", numbers: [2, 8, 14, 20, 26, 32], special_number: 2 },
    { draw_id: "3", draw_date: "2026-08-03", numbers: [3, 9, 15, 21, 27, 33], special_number: 3 },
  ],
};
const registration = (gameType, family) => ({
  id: `${gameType}-${family}`,
  game_name: GAME_CONFIG[gameType].name,
  model_name: family,
  model_family: family,
  model_version: `${family}-v1`,
  feature_version: `${family}-features-v1`,
  parameters: family === "bayesian-drift"
    ? { halfLifeDraws: 100, priorStrength: 100, random_seed: `${gameType}-${family}` }
    : family === "transition-regularized"
      ? { minimumSupport: 30, effectCap: 0.25, random_seed: `${gameType}-${family}` }
      : { random_seed: `${gameType}-${family}` },
  code_commit: "0123456789abcdef0123456789abcdef01234567",
  status: family === "uniform-null" ? "baseline" : "registered",
});
const registrations = ["539", "649", "power"].flatMap((gameType) => [
  registration(gameType, "uniform-null"),
  registration(gameType, "bayesian-drift"),
  registration(gameType, "transition-regularized"),
]);

for (const gameType of ["539", "649", "power"]) {
  test(`${gameType} v3 forecasts are legal and replayable`, () => {
    const first = buildEvidenceForecasts({ gameType, draws: fixtures[gameType], generatedAt: NOW, registrations });
    const replay = buildEvidenceForecasts({ gameType, draws: fixtures[gameType], generatedAt: NOW, registrations });
    assert.deepEqual(replay, first);
    for (const forecast of first) {
      assertProbabilityVector(forecast.probabilities, GAME_CONFIG[gameType]);
      if (gameType === "power") {
        assertProbabilityVector(forecast.specialProbabilities, GAME_CONFIG.power.secondaryNumber);
      }
    }
  });
}

test("future draw never changes an earlier forecast", () => {
  const prefix = fixtures["539"].slice(0, -1);
  const before = buildEvidenceForecasts({ gameType: "539", draws: prefix, generatedAt: NOW, registrations });
  assert.deepEqual(
    buildEvidenceForecasts({ gameType: "539", draws: structuredClone(prefix), generatedAt: NOW, registrations }),
    before,
  );
  assert.throws(() => buildEvidenceForecasts({
    gameType: "539",
    draws: [...prefix, { draw_id: "future", draw_date: "2026-08-07", numbers: [1, 6, 11, 16, 21] }],
    generatedAt: NOW,
    registrations,
  }), /data cutoff/i);
});

test("sequence challenger cannot be requested as production", () => {
  assert.throws(() => buildEvidenceForecasts({
    gameType: "539",
    draws: fixtures["539"],
    generatedAt: NOW,
    registrations: [{ ...registration("539", "sequence-challenger"), parameters: { shadowOnly: true, random_seed: "sequence" } }],
    mode: "production",
  }), /shadow only/i);
});
```

- [ ] **Step 2: 執行 tests 並確認 RED**

```powershell
node --test supabase/functions/_shared/lai-v3/models.test.mjs
```

Expected: FAIL because `models.js` does not exist.

- [ ] **Step 3: 實作永久均勻基準與 Bayesian drift**

```js
function bayesianArea(draws, { maxNumber, picks }, { halfLifeDraws, priorStrength }, numberSelector) {
  const baseRate = picks / maxNumber;
  const weightedCounts = Array(maxNumber).fill(0);
  let totalWeight = 0;
  draws.forEach((draw, index) => {
    const age = draws.length - 1 - index;
    const weight = 0.5 ** (age / halfLifeDraws);
    totalWeight += weight;
    for (const number of numberSelector(draw)) weightedCounts[number - 1] += weight;
  });
  const raw = weightedCounts.map((count) => (
    (priorStrength * baseRate + count) / (priorStrength + totalWeight)
  ));
  return normalizeProbabilityVector(raw, maxNumber, picks);
}
```

`halfLifeDraws` 與 `priorStrength` 只能來自 immutable registry parameters。第 1 區使用 `draw.numbers`，威力彩第 2 區只使用 `draw.special_number`。

- [ ] **Step 4: 實作 regularized transition 與 sequence shadow wrapper**

`transition-regularized` 使用最後一期號碼作為 source，計算歷史 source-to-next transitions；低於 `minimumSupport = 30` 的訊號回退 base rate，log-odds effect 限制在 `[-0.25, 0.25]` 後再正規化。

```js
const effect = Math.max(-effectCap, Math.min(effectCap, conditionalLogit - baseLogit));
const rawProbability = baseRate * Math.exp(effect);
```

`sequence-challenger` 只包裝既有 `lstmScores`，並強制 `mode === 'shadow'`。若 weights shape、歷史長度或 calibration metadata 不合法，回傳 failed experiment reason，不得產生 production fallback。

- [ ] **Step 5: 實作 registry-driven builder**

```js
export function buildEvidenceForecasts({ gameType, draws, generatedAt, registrations, mode = "shadow" }) {
  assertForecastCutoff(draws, generatedAt);
  return registrations
    .filter((row) => row.game_name === GAME_CONFIG[gameType].name)
    .filter((row) => row.status !== "disabled" && row.status !== "rejected")
    .map((row) => buildRegisteredForecast({ row, gameType, draws, generatedAt, mode }));
}
```

每個 output 必須複製 registry 的 `id`、version、feature version、parameters、code commit 與 deterministic seed；禁止以函式內預設參數覆寫已登錄參數。

- [ ] **Step 6: 執行模型與 LAI v2 regression tests**

```powershell
node --test supabase/functions/_shared/lai-v3/models.test.mjs supabase/functions/lotto-predict-notify/lib/experts.test.mjs supabase/functions/lotto-predict-notify/lib/predictCore.test.mjs
```

Expected: v3 tests PASS；LAI v2 forecast signatures 不變。

- [ ] **Step 7: Commit**

```powershell
git add supabase/functions/_shared/lai-v3/models.js supabase/functions/_shared/lai-v3/models.test.mjs supabase/functions/lotto-predict-notify/lib/experts.js
git commit -m "feat: add LAI v3 shadow model families"
```

---

### Task 4: 建立 proper scoring 與 matched-random 投注效用

**Files:**
- Create: `supabase/functions/_shared/lai-v3/evaluation.js`
- Create: `supabase/functions/_shared/lai-v3/evaluation.test.mjs`
- Modify: `supabase/functions/lotto-predict-notify/lib/scoring.js:141-214`
- Modify: `supabase/functions/lotto-predict-notify/lib/scoring.test.mjs:1-117`

**Interfaces:**
- Consumes: forecast、actual draw、uniform forecast、兩組推薦與 deterministic seed。
- Produces: `scoreEvidenceForecast`、`matchedRandomCoverage`、`pairCandidateWithBaseline`、`evaluateCandidateSeries`。
- `CandidateEvidence`: `{ sampleCount, recent30Skill, recent100Skill, recent500Skill, brierSkill, meanExcessLoss, brierCi, logLossDelta, calibrationDelta, calibrationCi, coverageDelta, coverageCi, permutationP, adjustedQ, specialArea }`。

- [ ] **Step 1: 寫入 per-draw 與 series failing tests**

```js
const candidateRows = [
  { drawId: "101", brier: 0.12 },
  { drawId: "102", brier: 0.10 },
  { drawId: "103", brier: 0.09 },
];
const baselineRows = [
  { drawId: "102", brier: 0.11 },
  { drawId: "103", brier: 0.10 },
  { drawId: "104", brier: 0.13 },
];
const powerForecast = {
  probabilities: Array(38).fill(6 / 38),
  special_probabilities: Array(8).fill(1 / 8),
  final_groups: {
    combinations: { "證據主攻": [1, 2, 3, 4, 5, 6], "覆蓋保底": [7, 8, 9, 10, 11, 12] },
    special_combinations: { "證據主攻": [3], "覆蓋保底": [6] },
  },
};
const powerDraw = {
  draw_id: "p1",
  draw_date: "2026-08-03",
  numbers: [1, 8, 15, 22, 29, 36],
  special_number: 3,
};

test("candidate evidence pairs only identical draw ids", () => {
  const pairs = pairCandidateWithBaseline(candidateRows, baselineRows);
  assert.deepEqual(pairs.map((row) => row.drawId), ["102", "103"]);
});

test("matched random baseline preserves group shape and overlap", () => {
  const result = matchedRandomCoverage({
    maxNumber: 39,
    picks: 5,
    groupA: [1, 2, 3, 4, 5],
    groupB: [5, 6, 7, 8, 9],
    actualNumbers: [1, 6, 10, 11, 12],
    simulations: 1000,
    seed: "draw-1",
  });
  assert.equal(result.constraints.overlapCount, 1);
  assert.equal(result.constraints.groupCount, 2);
  assert.equal(result.samples.length, 1000);
});

test("Power areas are scored independently before combination", () => {
  const score = scoreEvidenceForecast({ forecast: powerForecast, draw: powerDraw, config: GAME_CONFIG.power });
  assert.ok(Number.isFinite(score.main.brier));
  assert.ok(Number.isFinite(score.special.brier));
  assert.equal(score.special.coverage.unionHits, 1);
});
```

- [ ] **Step 2: 執行 tests 並確認 RED**

```powershell
node --test supabase/functions/_shared/lai-v3/evaluation.test.mjs
```

Expected: FAIL because `evaluation.js` does not exist.

- [ ] **Step 3: 補齊 scoring 的 calibration observation helper**

在既有 `scoring.js` 新增但不改變既有函式：

```js
export function calibrationObservations(probabilities, actualNumbers, maxNumber) {
  const actual = new Set(actualNumbers.map(Number));
  return probabilities.map((probability, index) => ({
    probability,
    outcome: actual.has(index + 1) ? 1 : 0,
  }));
}
```

- [ ] **Step 4: 實作 matched-random baseline**

每次模擬必須產生兩組合法號碼，且 group count、picks 與實際推薦的 overlap count 完全相同。不得把不受約束的隨機組合當比較基準。

```js
function takeRandom(pool, count, rng) {
  const remaining = [...pool];
  const selected = [];
  while (selected.length < count) {
    const index = Math.floor(rng() * remaining.length);
    selected.push(remaining.splice(index, 1)[0]);
  }
  return selected;
}

function sampleTwoGroupsWithOverlap({ maxNumber, picks, overlapCount, rng }) {
  const universe = Array.from({ length: maxNumber }, (_, index) => index + 1);
  if (maxNumber < (2 * picks) - overlapCount) throw new RangeError("matched overlap is infeasible");
  const common = takeRandom(universe, overlapCount, rng);
  const afterCommon = universe.filter((number) => !common.includes(number));
  const groupAOnly = takeRandom(afterCommon, picks - overlapCount, rng);
  const afterA = afterCommon.filter((number) => !groupAOnly.includes(number));
  const groupBOnly = takeRandom(afterA, picks - overlapCount, rng);
  return {
    groupA: [...common, ...groupAOnly].sort((a, b) => a - b),
    groupB: [...common, ...groupBOnly].sort((a, b) => a - b),
  };
}

export function matchedRandomCoverage(input) {
  const rng = seededRandom(input.seed);
  const overlapCount = intersectionSize(input.groupA, input.groupB);
  const samples = Array.from({ length: input.simulations }, () => {
    const { groupA, groupB } = sampleTwoGroupsWithOverlap({ ...input, overlapCount, rng });
    return coverageMetrics(groupA, groupB, input.actualNumbers).union_hits;
  });
  return { constraints: { groupCount: 2, overlapCount }, samples };
}
```

- [ ] **Step 5: 實作 paired evidence summary**

使用 `uniform-null` 相同期別 score 建立 paired values。每期 Brier skill 定義為 `1 - candidate_brier / baseline_brier`，因此正值代表 challenger 較佳；log loss delta 定義為 `candidate_log_loss - baseline_log_loss`，因此不得大於 `0`。

```js
const brierSkillValues = pairs.map(({ candidate, baseline }) => 1 - (candidate.brier / baseline.brier));
const meanExcessLoss = mean(pairs.map(({ candidate, baseline }) => candidate.brier - baseline.brier));
const logLossDelta = mean(pairs.map(({ candidate, baseline }) => candidate.logLoss - baseline.logLoss));
const brierCi = pairedBlockBootstrap({
  deltas: brierSkillValues,
  blockLength: Math.max(2, Math.round(Math.cbrt(brierSkillValues.length))),
  iterations: 2000,
  seed: `${seed}|brier`,
});
```

Recent windows 使用同一組已排序 paired rows 的尾端 30、100、500 筆；樣本不足時回傳 `null`，不可用短樣本冒充完整視窗。

- [ ] **Step 6: 執行 evaluation 與既有 scoring tests**

```powershell
node --test supabase/functions/_shared/lai-v3/evaluation.test.mjs supabase/functions/lotto-predict-notify/lib/scoring.test.mjs
```

Expected: all tests PASS；Power `main`、`special` 與 combined evidence 同時存在。

- [ ] **Step 7: Commit**

```powershell
git add supabase/functions/_shared/lai-v3/evaluation.js supabase/functions/_shared/lai-v3/evaluation.test.mjs supabase/functions/lotto-predict-notify/lib/scoring.js supabase/functions/lotto-predict-notify/lib/scoring.test.mjs
git commit -m "feat: add LAI v3 evidence evaluation"
```

---

### Task 5: 建立獨立 promotion gate 與 production 權重規則

**Files:**
- Create: `supabase/functions/_shared/lai-v3/promotionGate.js`
- Create: `supabase/functions/_shared/lai-v3/promotionGate.test.mjs`
- Create: `supabase/functions/_shared/lai-v3/falsification.test.mjs`

**Interfaces:**
- Consumes: `stage`、`CandidateEvidence`、live/canary sample counters、health flags、候選 family。
- Produces: `evaluatePromotionGate(input)`、`buildProductionWeights(input)`、`selectFamilyRepresentatives(candidates)`。
- `GateDecision`: `{ decision, fromStatus, toStatus, reason, gateVersion, evidenceDigest, authorizedWeight }`。

- [ ] **Step 1: 寫入狀態轉移 failing tests**

```js
const healthy = Object.freeze({ dataValid: true, replayDigestValid: true, modelValid: true });
const passingEvidence = (overrides = {}) => ({
  sampleCount: 600,
  recent30Skill: 0.01,
  recent100Skill: 0.01,
  recent500Skill: 0.01,
  brierCi: { lower95: 0.001, upper95: 0.02 },
  logLossDelta: -0.001,
  calibrationDelta: -0.001,
  calibrationCi: { lower95: -0.003, upper95: 0 },
  coverageCi: { lower95: 0, upper95: 0.04 },
  adjustedQ: 0.01,
  ...overrides,
});

test("one lucky draw stays registered", () => {
  const result = evaluatePromotionGate({
    stage: "registered",
    evidence: passingEvidence({ sampleCount: 1, recent500Skill: null }),
    liveShadowDraws: 1,
    canaryDraws: 0,
    health: healthy,
  });
  assert.equal(result.decision, "hold");
  assert.equal(result.fromStatus, "registered");
  assert.equal(result.toStatus, "registered");
  assert.equal(result.reason, "historical_window_incomplete");
});

test("30 live draws promote historical_passed to shadow_verified", () => {
  const result = evaluatePromotionGate({
    stage: "historical_passed",
    evidence: passingEvidence(),
    liveShadowDraws: 30,
    canaryDraws: 0,
    health: healthy,
  });
  assert.equal(result.toStatus, "shadow_verified");
  assert.equal(result.decision, "promote");
});

test("canary cannot exceed ten percent", () => {
  const weights = buildProductionWeights({
    baselineName: "uniform-null",
    currentChampion: null,
    challenger: { name: "bayes-v1", family: "bayesian-drift", stage: "canary" },
    familyEvidence: { "bayes-v1": passingEvidence() },
  });
  assert.equal(weights["bayes-v1"], 0.10);
  assert.equal(weights["uniform-null"], 0.90);
});
```

- [ ] **Step 2: 執行 promotion tests 並確認 RED**

```powershell
node --test supabase/functions/_shared/lai-v3/promotionGate.test.mjs
```

Expected: FAIL because `promotionGate.js` does not exist.

- [ ] **Step 3: 實作明確狀態機**

`evaluatePromotionGate` 依下列順序做 fail-fast 判斷：

```js
export function evaluatePromotionGate(input) {
  if (!input.health.dataValid || !input.health.replayDigestValid || !input.health.modelValid) {
    return makeDecision(input.stage, "disable", "disabled", "health_check_failed", 0);
  }
  if (Number.isFinite(input.evidence.recent30Skill) && input.evidence.recent30Skill < 0) {
    return makeDecision(input.stage, "demote", "cooldown", "rolling_30_skill_negative", 0);
  }
  if (
    input.evidence.calibrationDelta > 0 &&
    input.evidence.calibrationCi?.lower95 > 0 &&
    input.evidence.adjustedQ <= 0.05
  ) {
    return makeDecision(input.stage, "demote", "cooldown", "calibration_significantly_worse", 0);
  }
  return evaluateStageRequirements(input);
}
```

`evaluateStageRequirements` 使用固定規則：

1. `registered -> historical_passed`：至少 500 個 historical pairs；recent-100、recent-500 skill 皆大於 0；Brier CI lower95 大於 0；log loss delta 小於等於 0；coverage CI lower95 大於等於 0；adjusted q 小於等於 0.05。
2. `historical_passed -> shadow_verified`：上述條件持續成立，且 `liveShadowDraws >= 30`。
3. `shadow_verified -> canary`：下一個新 evidence digest 仍通過全部條件，authorized weight 固定為 `0.10`。
4. `canary -> champion`：`canaryDraws >= 20`、recent-100／recent-500 通過、CI／q／log loss／coverage 通過。
5. `champion`：條件持續成立則 `hold`；沒有新 evidence digest 時不得重複 decision。

- [ ] **Step 4: 實作 family isolation 與保守權重**

```js
export function selectFamilyRepresentatives(candidates) {
  const byFamily = new Map();
  for (const candidate of candidates) {
    const current = byFamily.get(candidate.family);
    if (!current || compareEvidence(candidate.evidence, current.evidence) > 0) {
      byFamily.set(candidate.family, candidate);
    }
  }
  return [...byFamily.values()];
}

function compareEvidence(left, right) {
  return (left.brierCi.lower95 - right.brierCi.lower95)
    || (left.recent500Skill - right.recent500Skill)
    || (left.recent100Skill - right.recent100Skill);
}
```

同一彩種每個非 uniform family 最多一個 active representative。Canary 固定 10%；其餘既有權重先正規化至 90%，若沒有既有 champion，`uniform-null` 取得 90%。Champion 模式固定保留 `uniform-null = 0.25`，其餘 0.75 依 `exp(-5 * excessLoss)` 在通過閘門的 family representatives 間正規化。長期 recent-100 或 recent-500 skill 小於等於 0 的 family 權重為 0。

```js
const eligible = selectFamilyRepresentatives(candidates).filter((row) => (
  row.evidence.recent100Skill > 0 && row.evidence.recent500Skill > 0
));
const raw = Object.fromEntries(eligible.map((row) => [
  row.name,
  Math.exp(-5 * row.evidence.meanExcessLoss),
]));
const rawTotal = Object.values(raw).reduce((sum, value) => sum + value, 0);
const weights = {
  "uniform-null": 0.25,
  ...Object.fromEntries(Object.entries(raw).map(([name, value]) => [name, 0.75 * value / rawTotal])),
};
```

- [ ] **Step 5: 寫入 deterministic synthetic falsification tests**

```js
test("pure random streams keep false promotion at or below alpha", () => {
  const decisions = Array.from({ length: 200 }, (_, seed) => runNullExperiment({ seed, draws: 600 }));
  const falsePromotionRate = decisions.filter((row) => row.toStatus === "champion").length / decisions.length;
  assert.ok(falsePromotionRate <= 0.05, `false promotion rate ${falsePromotionRate}`);
});

test("registered weak signal is detected with enough out-of-sample draws", () => {
  const result = runInjectedBiasExperiment({ seed: 539, draws: 1200, favoredNumber: 7, lift: 0.035 });
  assert.equal(result.historicalDecision.toStatus, "historical_passed");
  assert.ok(result.evidence.brierCi.lower95 > 0);
});
```

`runNullExperiment` 以 `seededRandom(String(seed))` 逐期做無放回均勻抽樣，使用前 500 期 historical、後 30 期 shadow、再 20 期 canary，並依序呼叫 `evaluateCandidateSeries` 與 `evaluatePromotionGate`。`runInjectedBiasExperiment` 使用相同流程，但把 favored number 的抽樣權重乘以 `1 + lift` 後重新正規化。Fixtures 不得呼叫 `Math.random()`，避免 flaky test。

```js
function weightedDraw({ maxNumber, picks, weights, rng }) {
  const remaining = Array.from({ length: maxNumber }, (_, index) => ({
    number: index + 1,
    weight: weights[index],
  }));
  const selected = [];
  while (selected.length < picks) {
    const total = remaining.reduce((sum, row) => sum + row.weight, 0);
    let target = rng() * total;
    const index = remaining.findIndex((row) => ((target -= row.weight) <= 0));
    selected.push(remaining.splice(Math.max(0, index), 1)[0].number);
  }
  return selected.sort((left, right) => left - right);
}
```

- [ ] **Step 6: 執行 gate 與 synthetic tests**

```powershell
node --test supabase/functions/_shared/lai-v3/promotionGate.test.mjs supabase/functions/_shared/lai-v3/falsification.test.mjs
```

Expected: all tests PASS；200 個 pure-random experiments 的 false promotion rate 不高於 5%。

- [ ] **Step 7: Commit**

```powershell
git add supabase/functions/_shared/lai-v3/promotionGate.js supabase/functions/_shared/lai-v3/promotionGate.test.mjs supabase/functions/_shared/lai-v3/falsification.test.mjs
git commit -m "feat: add falsification-first promotion gate"
```

---

### Task 6: 擴充 checkpointed training 為 LAI v3 experiment runner

**Files:**
- Create: `supabase/functions/lotto-train-agent/lib/evidenceTraining.js`
- Create: `supabase/functions/lotto-train-agent/lib/evidenceTraining.test.mjs`
- Modify: `supabase/functions/lotto-train-agent/lib/trainingCore.js:248-421`
- Modify: `supabase/functions/lotto-train-agent/lib/trainingCore.test.mjs:248-337`
- Modify: `supabase/functions/lotto-train-agent/lib/trainingHttp.js:74-230`
- Modify: `supabase/functions/lotto-train-agent/lib/trainingHttp.test.mjs:1-134`

**Interfaces:**
- Consumes: frozen `lotto_training_draw_snapshots`、candidate registry row、同彩種 `uniform-null` baseline row、experiment row、cursor、`chunkSize <= 25`。
- Produces: `createInitialEvidenceState`、`walkForwardEvidenceChunk`、`canonicalJson`、`digestReplay`、`finalizeEvidenceRun`、completed `lai_experiment_runs` metrics/replay digest。
- Compatibility: `algorithm_version = 'lai-v2'` 繼續走既有 `walkForwardChunk`；`algorithm_version = 'lai-v3'` 才走新 processor。

- [ ] **Step 1: 寫入 chunk 與 replay failing tests**

```js
const draws = Array.from({ length: 140 }, (_, index) => ({
  draw_id: String(index + 1),
  draw_date: new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10),
  numbers: Array.from({ length: 5 }, (__, offset) => ((index * 5 + offset) % 39) + 1).sort((a, b) => a - b),
}));
const registration = {
  id: "registry-539-bayes",
  game_name: GAME_CONFIG["539"].name,
  model_name: "bayesian-drift",
  model_family: "bayesian-drift",
  model_version: "bayesian-drift-v1",
  feature_version: "weighted-counts-v1",
  parameters: { halfLifeDraws: 100, priorStrength: 100, random_seed: "training-proof" },
  code_commit: "0123456789abcdef0123456789abcdef01234567",
  status: "registered",
};
const baselineRegistration = {
  id: "registry-539-uniform",
  game_name: GAME_CONFIG["539"].name,
  model_name: "uniform-null",
  model_family: "uniform-null",
  model_version: "uniform-null-v1",
  feature_version: "none-v1",
  parameters: { random_seed: "uniform-null-v1" },
  code_commit: "0123456789abcdef0123456789abcdef01234567",
  status: "baseline",
};
const initial = createInitialEvidenceState(registration, baselineRegistration);
const input = { gameType: "539", draws, registration, baselineRegistration };

test("two v3 chunks equal one combined chunk", async () => {
  const first = walkForwardEvidenceChunk({ ...input, cursor: 100, chunkSize: 10, state: initial });
  const second = walkForwardEvidenceChunk({ ...input, cursor: 110, chunkSize: 10, state: first.state });
  const combined = walkForwardEvidenceChunk({ ...input, cursor: 100, chunkSize: 20, state: initial });
  assert.deepEqual(second.state, combined.state);
  assert.equal(await digestReplay(second.state), await digestReplay(combined.state));
});

test("each target only sees the preceding prefix", () => {
  const result = walkForwardEvidenceChunk({ ...input, cursor: 3, chunkSize: 1 });
  assert.equal(result.steps[0].historySize, 3);
  assert.equal(result.steps[0].targetDrawId, draws[3].draw_id);
  assert.equal(result.steps[0].dataCutoff, draws[2].draw_date);
});

test("v3 completed run never activates agent state", async () => {
  const request = { run_id: "training-run-v3", chunk_size: 25 };
  const repository = makeInMemoryV3Repository({ draws, registration, baselineRegistration });
  const processors = { walkForwardEvidenceChunk, walkForwardV2Chunk: walkForwardChunk };
  await executeTrainingRun({ input: request, repository, processors });
  assert.equal(repository.calls.activateAgentState, 0);
  assert.equal(repository.calls.completeExperiment, 1);
});
```

`makeInMemoryV3Repository` 必須實作 `fetchRun`、`claimRun`、`ensureSnapshot`、`fetchDraws`、`fetchExperiment`、`fetchRegistration`、`fetchUniformBaseline`、`saveCheckpoint`、`completeExperiment`、`markFailed`，並以 `calls` counters 驗證沒有 production activation method 被呼叫。

- [ ] **Step 2: 執行 training tests 並確認 RED**

```powershell
node --test supabase/functions/lotto-train-agent/lib/evidenceTraining.test.mjs
```

Expected: FAIL because `evidenceTraining.js` does not exist.

- [ ] **Step 3: 實作 v3 walk-forward state**

```js
export function createInitialEvidenceState(registration, baselineRegistration) {
  return {
    registryId: registration.id,
    baselineRegistryId: baselineRegistration.id,
    modelVersion: registration.model_version,
    featureVersion: registration.feature_version,
    codeCommit: registration.code_commit,
    processedDraws: 0,
    scoreRows: [],
    recentRows: [],
    randomSeed: registration.parameters.random_seed,
  };
}

export function walkForwardEvidenceChunk({ gameType, draws, cursor, chunkSize, state, registration, baselineRegistration }) {
  const end = Math.min(cursor + chunkSize, draws.length);
  let next = structuredClone(state);
  const steps = [];
  for (let targetIndex = cursor; targetIndex < end; targetIndex += 1) {
    const history = draws.slice(0, targetIndex);
    const target = draws[targetIndex];
    const forecasts = buildEvidenceForecasts({
      gameType,
      draws: history,
      generatedAt: `${target.draw_date}T10:00:00+08:00`,
      registrations: [baselineRegistration, registration],
      mode: "shadow",
    });
    const baseline = forecasts.find((row) => row.family === "uniform-null");
    const candidate = forecasts.find((row) => row.registryId === registration.id);
    next = appendEvidencePair(next, {
      baseline: scoreEvidenceForecast({ forecast: baseline, draw: target }),
      candidate: scoreEvidenceForecast({ forecast: candidate, draw: target }),
    });
    steps.push({
      targetDrawId: target.draw_id,
      historySize: history.length,
      dataCutoff: history.at(-1)?.draw_date ?? null,
    });
  }
  return { nextCursor: end, done: end === draws.length, state: compactState(next), steps };
}
```

`compactState` 最多保留 recent 500 明細；全期統計使用 running sums，避免 Edge Function memory 隨歷史長度無限增加。

- [ ] **Step 4: 實作 SHA-256 replay digest 與 final evidence**

Canonical JSON 必須遞迴排序 object keys，array 順序維持不變，再使用 `crypto.subtle.digest('SHA-256', bytes)`。`finalizeEvidenceRun` 以 frozen snapshot、registration 與 compact state 產生 metrics，不得讀取 snapshot 以外的新 draw。

```js
export async function digestReplay(value) {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
```

- [ ] **Step 5: 在 training core 依 algorithm version dispatch**

```js
const processor = claimed.algorithm_version === "lai-v3"
  ? processors.walkForwardEvidenceChunk
  : processors.walkForwardV2Chunk;

if (claimed.algorithm_version === "lai-v3" && request.chunkSize > 25) {
  throw new RangeError("LAI v3 chunk_size must be from 1 through 25");
}
```

V3 run 完成時呼叫 `repository.completeExperiment(experimentRunId, evidence)`；不得呼叫既有 `activate_lotto_training_candidate`。

- [ ] **Step 6: 擴充 HTTP repository**

新增 `fetchExperiment`、`fetchRegistration`、`fetchUniformBaseline`、`saveExperimentCheckpoint`、`completeExperiment`、`failExperiment`。所有 request 使用 service-role headers；experiment、candidate registry 或同彩種唯一 baseline 不存在時 fail fast，不建立臨時模型。

```js
async fetchRegistration(registryId) {
  return fetchOne(`lai_model_registry?id=eq.${encodeURIComponent(registryId)}&select=*&limit=1`);
}

async fetchUniformBaseline(gameName) {
  const rows = await fetchRows(`lai_model_registry?game_name=eq.${encodeURIComponent(gameName)}&model_family=eq.uniform-null&status=eq.baseline&select=*&limit=2`);
  if (rows.length !== 1) throw new Error("exactly one uniform-null baseline is required");
  return rows[0];
}
```

- [ ] **Step 7: 執行完整 training regression**

```powershell
node --test supabase/functions/lotto-train-agent/lib/*.test.mjs
```

Expected: LAI v2 與 v3 tests 全部 PASS；v3 chunk 上限固定 25；v3 training 不會 activate production state。

- [ ] **Step 8: Commit**

```powershell
git add supabase/functions/lotto-train-agent
git commit -m "feat: run checkpointed LAI v3 experiments"
```

---

### Task 7: 將每日開獎後流程接上評分、correction 與獨立決策

**Files:**
- Create: `supabase/functions/lotto-update/lib/evidenceLearning.js`
- Create: `supabase/functions/lotto-update/lib/evidenceLearning.test.mjs`
- Modify: `supabase/functions/lotto-update/lib/lottoCore.js:422-1047`
- Modify: `supabase/functions/lotto-update/lib/lottoCore.test.mjs:422-736`
- Modify: `supabase/functions/lotto-update/index.ts:464-1025`
- Modify: `supabase/functions/lotto-update/lib/postDrawLearning.test.mjs:1-507`

**Interfaces:**
- Consumes: confirmed draw、該期未評分 v3 forecasts、valid score history、registry、active state。
- Produces: immutable score rows、promotion decision、optional canary/champion state activation、correction event。
- `runEvidenceLearning(input, deps)` returns `{ status, scoresWritten, decisions, activation, failures }`。

- [ ] **Step 1: 寫入冪等與隔離 failing tests**

```js
const input = {
  gameName: "今彩539",
  draw: { draw_id: "539-20260805", draw_date: "2026-08-05", numbers: [1, 7, 13, 25, 39] },
  config: GAME_CONFIG["539"],
  sourceRevision: "official-r1",
};
const deps = makeEvidenceLearningDeps({
  forecasts: [validUniform, validBayesian],
  activeState: baselineState,
});

test("same draw and revision scores once", async () => {
  const first = await runEvidenceLearning(input, deps);
  const replay = await runEvidenceLearning(input, deps);
  assert.equal(first.status, "learned");
  assert.equal(replay.status, "already_scored");
  assert.equal(deps.insertedScores.length, first.scoresWritten);
});

test("shadow model failure does not change active state", async () => {
  deps.fetchForecasts = async () => [validUniform, malformedShadow];
  const result = await runEvidenceLearning(input, deps);
  assert.equal(result.failures[0].registryId, malformedShadow.registry_id);
  assert.equal(deps.activations.length, 0);
  assert.ok(deps.insertedScores.some((row) => row.forecast_id === validUniform.id));
});

test("official correction invalidates and replaces scores", async () => {
  const result = await runEvidenceLearning(correctedInput, correctionDeps);
  assert.equal(result.status, "corrected");
  assert.equal(correctionDeps.corrections.length, 1);
  assert.ok(correctionDeps.oldScores.every((row) => row.is_valid === false));
  assert.ok(correctionDeps.newScores.every((row) => row.source_revision === "official-r2"));
});
```

`makeEvidenceLearningDeps` 必須提供並記錄以下 calls：`fetchV3Forecasts`、`fetchValidScoreHistory`、`insertScoresIdempotently`、`fetchRegistry`、`fetchActiveState`、`recordDecision`、`activateAuthorizedState`、`recordFailure`、`recordCorrection`。`validUniform` 與 `validBayesian` 使用 Task 4 的合法 forecast shape；`baselineState.metrics.promotion_stage = 'baseline'`。

- [ ] **Step 2: 執行 evidence learning tests 並確認 RED**

```powershell
node --test supabase/functions/lotto-update/lib/evidenceLearning.test.mjs
```

Expected: FAIL because `evidenceLearning.js` does not exist.

- [ ] **Step 3: 實作 score-first、gate-second orchestration**

```js
export async function runEvidenceLearning(input, deps) {
  const forecasts = await deps.fetchV3Forecasts(input.gameName, input.draw.draw_date);
  const validForecasts = forecasts.filter((row) => validateForecastOrRecordFailure(row, input, deps));
  if (!validForecasts.length) return { status: "no_v3_forecasts", scoresWritten: 0, decisions: [] };

  const scoreRows = validForecasts.map((forecast) => toScoreRow(
    scoreEvidenceForecast({ forecast, draw: input.draw, config: input.config }),
    input.sourceRevision,
  ));
  await deps.insertScoresIdempotently(scoreRows);
  const evidenceByRegistry = await buildRegistryEvidence(scoreRows, input, deps);
  const decisions = evaluateAllCandidatesWithFdr(evidenceByRegistry, input);
  return persistDecisionsAndAuthorizedActivations(decisions, input, deps);
}
```

FDR 必須在同一期同彩種的全部候選 p-values 上一次計算，再把 adjusted q 寫回各自 evidence；禁止每個候選單獨假設 `q = p`。

- [ ] **Step 4: 實作 correction branch**

在 upsert 新 draw 前先讀取相同 `(game_name, draw_id)` 的現有資料。numbers、special number 或官方 revision 不同時，呼叫 `record_lai_v3_correction`；正常新資料走 standard scoring。

若官方 payload 沒有 revision id，`buildDrawRevision` 使用 canonical `{ game_name, draw_id, draw_date, sorted_numbers, special_number }` 的 SHA-256 hex；不得使用抓取時間或來源名稱，確保第二來源與官方來源內容相同時不會誤判為更正。

```ts
const existing = await fetchExistingDraw(supabaseUrl, serviceRoleKey, row.game_name, row.draw_id);
const sourceRevision = buildDrawRevision(row);
if (existing && drawPayloadChanged(existing, row)) {
  await recordEvidenceCorrection({ existing, corrected: row, sourceRevision });
}
```

- [ ] **Step 5: 限制 activation 只能來自 decision RPC**

`runEvidenceLearning` 先呼叫 `record_lai_v3_decision`。只有回傳 decision 為 `promote` 且 `to_status` 為 `canary` 或 `champion` 時，才能用 decision id 呼叫 `activate_lai_v3_state`。`hold`、`demote`、`disable` 不得 activate 新 state；既有完整 state 繼續有效或依 RPC 回退。

- [ ] **Step 6: 在 lotto-update 隔離 v3 failure**

LAI v2 的既有 ordered learning 完成後，再執行 v3 evidence learning。V3 error 寫入 experiment failure 與 Function result，但不得回滾已驗證的 draw upsert、prediction evaluation 或 LAI v2 checkpoint。

```ts
let v3Result: unknown = { status: "disabled" };
try {
  v3Result = await runEvidenceLearningForDraw(context);
} catch (error) {
  await recordEvidenceFailure(context, error);
  v3Result = { status: "failed_isolated", root_cause: errorMessage(error) };
}
```

- [ ] **Step 7: 執行 update regression suite**

```powershell
node --test supabase/functions/lotto-update/lib/*.test.mjs
```

Expected: existing ordered-learning tests PASS；同 draw/revision 不重複 score；correction 可追溯；shadow failure 不改 active state。

- [ ] **Step 8: Commit**

```powershell
git add supabase/functions/lotto-update
git commit -m "feat: score and gate LAI v3 after each draw"
```

---

### Task 8: 建立雙組 constrained optimizer 與 LAI v3 prediction builder

**Files:**
- Create: `supabase/functions/lotto-predict-notify/lib/evidenceOptimizer.js`
- Create: `supabase/functions/lotto-predict-notify/lib/evidenceOptimizer.test.mjs`
- Create: `supabase/functions/lotto-predict-notify/lib/evidencePrediction.js`
- Create: `supabase/functions/lotto-predict-notify/lib/evidencePrediction.test.mjs`
- Modify: `supabase/functions/lotto-predict-notify/lib/predictCore.js:1443-1690`
- Modify: `supabase/functions/lotto-predict-notify/lib/predictCore.test.mjs:600-682`

**Interfaces:**
- Consumes: approved probability vector、approved state、registry rows、target date、code commit、data status。
- Produces: `optimizeEvidenceGroups`、`optimizeEvidencePowerGroups`、`generateEvidencePrediction`、LAI v3 LINE message。
- `generateEvidencePrediction` returns `{ record, forecasts, evidenceSnapshot }`。

- [ ] **Step 1: 寫入 optimizer failing tests**

```js
const calibrated539 = normalizeProbabilityVector(
  Array.from({ length: 39 }, (_, index) => 39 - index),
  39,
  5,
);
const uniformInput = {
  probabilities: Array(39).fill(5 / 39),
  config: GAME_CONFIG["539"],
  seed: "uniform-539",
  minUtilityRatio: 0.90,
  maxOverlap: 1,
};
const powerInput = {
  mainProbabilities: Array(38).fill(6 / 38),
  specialProbabilities: normalizeProbabilityVector([8, 7, 6, 5, 4, 3, 2, 1], 8, 1),
  config: GAME_CONFIG.power,
  seed: "power-proof",
};

test("coverage group meets utility and overlap constraints", () => {
  const result = optimizeEvidenceGroups({
    probabilities: calibrated539,
    config: GAME_CONFIG["539"],
    seed: "539|2026-08-06|state-1",
    minUtilityRatio: 0.90,
    maxOverlap: 1,
  });
  assert.equal(result.evidenceAttack.length, 5);
  assert.equal(result.coverageFallback.length, 5);
  assert.ok(result.metrics.overlapCount <= 1);
  assert.ok(result.metrics.coverageUtility >= result.metrics.attackUtility * 0.90);
});

test("uniform baseline produces deterministic disjoint groups", () => {
  const first = optimizeEvidenceGroups(uniformInput);
  const replay = optimizeEvidenceGroups(uniformInput);
  assert.deepEqual(replay, first);
  assert.equal(first.metrics.overlapCount, 0);
});

test("Power second areas are independent and distinct", () => {
  const result = optimizeEvidencePowerGroups(powerInput);
  assert.equal(result.specialEvidenceAttack.length, 1);
  assert.equal(result.specialCoverageFallback.length, 1);
  assert.notEqual(result.specialEvidenceAttack[0], result.specialCoverageFallback[0]);
});
```

- [ ] **Step 2: 執行 optimizer tests 並確認 RED**

```powershell
node --test supabase/functions/lotto-predict-notify/lib/evidenceOptimizer.test.mjs
```

Expected: FAIL because `evidenceOptimizer.js` does not exist.

- [ ] **Step 3: 實作有限 overlap enumeration**

Group A 依 probability、seed tie-break、number 排序取前 picks。Group B 依 overlap count 從 `0` 到 `maxOverlap` 枚舉：取 Group A 內最高的 overlapCount 個號碼，加上 Group A 外最高的 `picks - overlapCount` 個號碼；選擇第一個達到 utility floor 的最小 overlap 解。

```js
const tieRng = seededRandom(seed);
const ranked = probabilities
  .map((probability, index) => ({
    number: index + 1,
    probability,
    tie: tieRng(),
  }))
  .sort((left, right) => (
    right.probability - left.probability || right.tie - left.tie || left.number - right.number
  ));
const attack = ranked.slice(0, config.picks);
const attackSet = new Set(attack.map((row) => row.number));
const attackUtility = attack.reduce((sum, row) => sum + row.probability, 0);

for (let overlap = 0; overlap <= maxOverlap; overlap += 1) {
  const inside = ranked.filter((row) => attackSet.has(row.number)).slice(0, overlap);
  const outside = ranked.filter((row) => !attackSet.has(row.number)).slice(0, config.picks - overlap);
  const candidate = [...inside, ...outside];
  const utility = candidate.reduce((sum, row) => sum + row.probability, 0);
  if (candidate.length === config.picks && utility >= attackUtility * minUtilityRatio) {
    const evidenceAttack = attack.map((row) => row.number).sort((a, b) => a - b);
    const coverageFallback = candidate.map((row) => row.number).sort((a, b) => a - b);
    return {
      evidenceAttack,
      coverageFallback,
      metrics: {
        attackUtility,
        coverageUtility: utility,
        overlapCount: evidenceAttack.filter((number) => coverageFallback.includes(number)).length,
        unionSize: new Set([...evidenceAttack, ...coverageFallback]).size,
      },
    };
  }
}
throw new Error("coverage_constraints_infeasible");
```

主區固定 `minUtilityRatio = 0.90`、`maxOverlap = floor(picks / 3)`；威力彩第 2 區固定 `minUtilityRatio = 0`、`maxOverlap = 0`，確保兩組第 2 區不同。

- [ ] **Step 4: 寫入 prediction builder failing tests**

```js
const uniformRegistration = {
  id: "uniform-539", game_name: "今彩539", model_name: "uniform-null",
  model_family: "uniform-null", model_version: "uniform-null-v1",
  feature_version: "none-v1", parameters: { random_seed: "uniform-null-v1" },
  code_commit: "0123456789abcdef0123456789abcdef01234567", status: "baseline",
};
const championRegistration = {
  id: "bayes-539", game_name: "今彩539", model_name: "bayesian-drift",
  model_family: "bayesian-drift", model_version: "bayesian-drift-v1",
  feature_version: "weighted-counts-v1",
  parameters: { halfLifeDraws: 100, priorStrength: 100, random_seed: "bayesian-drift-v1" },
  code_commit: "0123456789abcdef0123456789abcdef01234567", status: "champion",
};
const historical539 = Array.from({ length: 120 }, (_, index) => ({
  draw_id: String(index + 1),
  draw_date: new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10),
  numbers: Array.from({ length: 5 }, (__, offset) => ((index * 7 + offset * 5) % 39) + 1).sort((a, b) => a - b),
}));
const approvedInput = {
  gameType: "539",
  targetDrawDate: "2026-08-07",
  generatedAt: "2026-08-07T10:00:00+08:00",
  dataStatus: "complete",
  codeCommit: "0123456789abcdef0123456789abcdef01234567",
  approvedState: {
    game_name: "今彩539",
    state_version: 1,
    status: "champion",
    champion_model: "bayesian-drift",
    expert_weights: { "uniform-null": 0.25, "bayesian-drift": 0.75 },
    metrics: { promotion_stage: "champion", brier_skill: 0.01, brier_ci: { lower95: 0.001, upper95: 0.02 } },
  },
  approvedRegistrations: [uniformRegistration, championRegistration],
  shadowRegistrations: [],
  draws: historical539,
};
const staleInput = {
  ...approvedInput,
  dataStatus: "stale",
  approvedState: { ...approvedInput.approvedState, metrics: {} },
};

test("v3 record contains exactly two approved groups and evidence snapshot", async () => {
  const result = await generateEvidencePrediction(approvedInput);
  assert.equal(result.record.prediction.model, "lai-v3");
  assert.deepEqual(Object.keys(result.record.prediction.combinations), ["證據主攻", "覆蓋保底"]);
  assert.equal(result.evidenceSnapshot.replay_digest.length, 64);
  assert.equal(result.record.prediction.evidence.promotion_stage, "champion");
});

test("unapproved or stale state is rejected", async () => {
  await assert.rejects(() => generateEvidencePrediction(staleInput), /no_complete_approved_state/);
});
```

- [ ] **Step 5: 實作 approved-state prediction builder**

`generateEvidencePrediction` 只接受 `baseline`、`canary`、`champion` registry members，以及具完整 evidence metadata 的 active state。Registry stage 由 `approvedState.metrics.promotion_stage` 取得；不得把 `lotto_agent_states.status` 改成 `canary`。Shadow forecast 可一併回傳供 persistence，但不得進入 formal ensemble。

```js
const record = {
  timestamp: generatedAt,
  game_name: config.name,
  is_offline: false,
  prediction: {
    model: "lai-v3",
    engine: "lai-v3-evidence-agent",
    reasoning_source: "computed_evidence_only",
    agent_status: approvedState.status,
    agent_state_version: approvedState.state_version,
    combinations: {
      "證據主攻": optimized.evidenceAttack,
      "覆蓋保底": optimized.coverageFallback,
    },
    special_combinations: optimized.specialEvidenceAttack
      ? {
          "證據主攻": optimized.specialEvidenceAttack,
          "覆蓋保底": optimized.specialCoverageFallback,
        }
      : undefined,
    group_metrics: optimized.metrics,
    evidence: {
      ...publicEvidence,
      promotion_stage: approvedState.metrics.promotion_stage,
    },
  },
  is_evaluated: false,
  evaluation: { draw_id: null, actual_numbers: [], strategies: {} },
};
```

- [ ] **Step 6: 產生完整 immutable evidence snapshot**

Snapshot 必須包含 calibrated probabilities、兩組、optimizer config、target date、data cutoff、state/registry versions、seed、code commit、notification key 與 SHA-256 replay digest。Public evidence 只放 champion、stage、sample counts、Brier skill CI、最近 decision reason 與限制文字，不暴露 service credentials 或完整 experiment payload。

- [ ] **Step 7: 加入 LAI v3 LINE formatter**

`buildLineMessage` 接受 `lai-v2` 與 `lai-v3`。V3 LINE 只顯示兩組、第 2 區、champion/stage、Brier skill CI 與「尚無證據優於隨機」狀態；不得呼叫 Gemini 重新選號或改寫數值。

- [ ] **Step 8: 執行 prediction tests 與 v2 regression**

```powershell
node --test supabase/functions/lotto-predict-notify/lib/evidenceOptimizer.test.mjs supabase/functions/lotto-predict-notify/lib/evidencePrediction.test.mjs supabase/functions/lotto-predict-notify/lib/predictCore.test.mjs
```

Expected: v3 tests PASS；v2 record 與 LINE tests 仍 PASS；三彩種皆固定兩組，威力彩兩組皆有第 2 區。

- [ ] **Step 9: Commit**

```powershell
git add supabase/functions/lotto-predict-notify/lib/evidenceOptimizer.js supabase/functions/lotto-predict-notify/lib/evidenceOptimizer.test.mjs supabase/functions/lotto-predict-notify/lib/evidencePrediction.js supabase/functions/lotto-predict-notify/lib/evidencePrediction.test.mjs supabase/functions/lotto-predict-notify/lib/predictCore.js supabase/functions/lotto-predict-notify/lib/predictCore.test.mjs
git commit -m "feat: build evidence-first two-group predictions"
```

---

### Task 9: 接入 prediction runtime、Supabase persistence 與 LINE 邊界

**Files:**
- Create: `supabase/functions/lotto-predict-notify/lib/evidenceRepository.js`
- Create: `supabase/functions/lotto-predict-notify/lib/evidenceRepository.test.mjs`
- Modify: `supabase/functions/lotto-predict-notify/lib/notifyRuntime.js:34-216`
- Modify: `supabase/functions/lotto-predict-notify/lib/notifyRuntime.test.mjs:1-575`
- Modify: `supabase/functions/lotto-predict-notify/index.ts:1-625`
- Modify: `supabase/functions/lotto-predict-notify/index.contract.test.mjs`

**Interfaces:**
- Consumes: `LAI_V3_SHADOW_ENABLED`、`LAI_V3_PRODUCTION_ENABLED`、既有 LAI v2 flags、approved state/registry、draw history。
- Produces: scheduled v3 shadow rows、optional v3 formal record、immutable evidence snapshot、一次性 LINE notification。
- `resolveAgentExecution(input)` returns `{ formalEngine, runV2Forecasts, runV3Shadow, v3DryRun, fallbackEngine }`。

- [ ] **Step 1: 寫入 execution lane failing tests**

```js
const approvedV2State = { state_version: 10, status: "baseline", champion_model: "uniform" };
const approvedV3Context = {
  state: {
    state_version: 11,
    status: "champion",
    champion_model: "bayesian-drift",
    metrics: { promotion_stage: "champion" },
  },
  registrations: [{ id: "bayes-539", model_name: "bayesian-drift", status: "champion" }],
};
const shadowRegistrations = [{
  id: "transition-539",
  model_name: "transition-regularized",
  model_family: "transition-regularized",
  status: "registered",
}];
const v2Result = { record: { prediction: { model: "lai-v2" } }, forecasts: [] };
const v3Result = { record: { prediction: { model: "lai-v3" } }, forecasts: [], evidenceSnapshot: {} };
const shadowResult = { forecasts: [{ forecast_mode: "shadow" }], experiment: { status: "completed" } };
const options = {
  gameType: "539",
  draws: [
    { draw_id: "1", draw_date: "2026-08-03", numbers: [1, 2, 3, 4, 5] },
    { draw_id: "2", draw_date: "2026-08-05", numbers: [6, 7, 8, 9, 10] },
  ],
  gameName: "今彩539",
  targetDate: "2026-08-07",
  drawTargetDate: "2026-08-07",
  generatedAt: "2026-08-07T10:00:00+08:00",
  dryRun: false,
  requestedEngine: null,
  v2Enabled: true,
  v2ShadowEnabled: false,
  v3ShadowEnabled: false,
  v3ProductionEnabled: false,
  dataStatus: "complete",
};
const makeRuntimeDeps = (overrides = {}) => ({
  lineCalls: 0,
  predictionWrites: 0,
  snapshotWrites: 0,
  notificationWrites: 0,
  failedExperiments: [],
  v3ForecastRows: [],
  fetchActiveAgentState: async () => approvedV2State,
  fetchApprovedV3Context: async () => approvedV3Context,
  fetchShadowRegistrations: async () => shadowRegistrations,
  generateAdaptivePrediction: () => v2Result,
  generateEvidencePrediction: async () => v3Result,
  generateEvidenceShadow: async () => shadowResult,
  persistForecastRows: async function (rows) { this.v3ForecastRows.push(...rows); },
  insertEvidenceSnapshot: async function () { this.snapshotWrites += 1; },
  upsertPrediction: async function () { this.predictionWrites += 1; },
  reserveNotification: async function () { this.notificationWrites += 1; return true; },
  sendLineMessage: async function () { this.lineCalls += 1; return { status: 200 }; },
  markNotificationSent: async () => {},
  failExperiment: async function (error) { this.failedExperiments.push(error); },
  ...overrides,
});
const shadowOptions = { ...options, v3ShadowEnabled: true };
const productionOptions = { ...options, v3ProductionEnabled: true };

test("v3 shadow preserves v2 formal record and LINE", async () => {
  const deps = makeRuntimeDeps();
  const result = await executePredictionFlow({
    ...options,
    v2Enabled: true,
    v3ShadowEnabled: true,
    v3ProductionEnabled: false,
  }, deps);
  assert.equal(result.prediction.model, "lai-v2");
  assert.equal(deps.v3ForecastRows.every((row) => row.forecast_mode === "shadow"), true);
  assert.equal(deps.lineCalls, 1);
});

test("v3 shadow failure cannot replace formal result", async () => {
  const deps = makeRuntimeDeps();
  deps.generateEvidenceShadow = async () => { throw new Error("invalid shadow vector"); };
  const result = await executePredictionFlow(shadowOptions, deps);
  assert.equal(result.status, "sent");
  assert.equal(result.prediction.model, "lai-v2");
  assert.equal(deps.lineCalls, 1);
  assert.equal(deps.failedExperiments.length, 1);
});

test("v3 production falls back to approved v2 when state is incomplete", async () => {
  const deps = makeRuntimeDeps();
  deps.fetchApprovedV3Context = async () => null;
  const result = await executePredictionFlow(productionOptions, deps);
  assert.equal(result.prediction.model, "lai-v2");
  assert.equal(result.fallback_reason, "no_complete_approved_v3_state");
});

test("dry-run v3 creates no prediction, snapshot, notification, or LINE write", async () => {
  const deps = makeRuntimeDeps();
  await executePredictionFlow({ ...productionOptions, dryRun: true, requestedEngine: "lai-v3" }, deps);
  assert.equal(deps.predictionWrites, 0);
  assert.equal(deps.snapshotWrites, 0);
  assert.equal(deps.notificationWrites, 0);
  assert.equal(deps.lineCalls, 0);
});
```

- [ ] **Step 2: 執行 runtime tests 並確認 RED**

```powershell
node --test supabase/functions/lotto-predict-notify/lib/notifyRuntime.test.mjs supabase/functions/lotto-predict-notify/lib/evidenceRepository.test.mjs
```

Expected: FAIL because v3 dependencies and repository do not exist.

- [ ] **Step 3: 實作 evidence REST repository**

```js
export function makeEvidenceRepository({ supabaseUrl, serviceKey, fetchFn = fetch }) {
  return {
    fetchApprovedContext: (gameName) => fetchApprovedContext(fetchFn, supabaseUrl, serviceKey, gameName),
    fetchShadowRegistrations: (gameName) => fetchRegistry(fetchFn, supabaseUrl, serviceKey, gameName, [
      "registered", "historical_passed", "shadow_verified", "canary", "champion",
    ]),
    createExperiment: (row) => insertOne("lai_experiment_runs", row),
    completeExperiment: (id, patch) => patchOne("lai_experiment_runs", id, patch),
    failExperiment: (id, error) => patchOne("lai_experiment_runs", id, {
      status: "failed",
      error_text: error instanceof Error ? error.message : String(error),
      completed_at: new Date().toISOString(),
    }),
    insertEvidenceSnapshot: (row) => insertOne("lai_evidence_snapshots", row),
  };
}
```

所有 writes 使用 `Prefer: return=representation`；HTTP 非 2xx、空回傳或重複 snapshot 都回傳具體 error，不吞錯。

- [ ] **Step 4: 擴充 execution resolver**

```js
export function resolveAgentExecution(input) {
  if (input.requestedEngine === "lai-v3" && !input.dryRun) {
    throw new Error("engine=lai-v3 requires dry_run=1");
  }
  const v3DryRun = input.dryRun && input.requestedEngine === "lai-v3";
  return {
    v3DryRun,
    runV3Shadow: v3DryRun || input.v3ShadowEnabled || input.v3ProductionEnabled,
    runV2Forecasts: input.v2Enabled || input.v2ShadowEnabled || input.v3ProductionEnabled,
    formalEngine: v3DryRun || input.v3ProductionEnabled ? "lai-v3" : input.v2Enabled ? "lai-v2" : "honest",
    fallbackEngine: input.v2Enabled ? "lai-v2" : null,
  };
}
```

當 formal v3 context 不完整或 optimizer 拒絕輸入時，只能回退 approved LAI v2；若 v2 也不可用，回傳 `blocked_no_valid_state` 並停止 prediction/notification，不得臨時呼叫未驗證模型。

- [ ] **Step 5: 實作 persistence 順序**

Scheduled v3 shadow：create experiment -> generate -> persist `shadow` forecasts -> complete experiment。V3 formal：persist forecasts -> insert evidence snapshot -> upsert prediction -> reserve notification -> send LINE -> mark sent。

```js
await deps.persistForecastRows(v3Result.forecasts);
const persistedSnapshot = await deps.insertEvidenceSnapshot(v3Result.evidenceSnapshot);
predictionRow.prediction.evidence.snapshot_id = persistedSnapshot.id;
await deps.upsertPrediction(predictionRow);
const reserved = await deps.reserveNotification(notificationKey, {
  prediction_source_key: predictionSourceKey,
  evidence_snapshot_id: persistedSnapshot.id,
});
```

任一步驟在 reserve 之前失敗，不得發 LINE。Reserve 之後的 LINE retry 繼續使用既有 deterministic `X-Line-Retry-Key`。

- [ ] **Step 6: 在 index.ts 注入 v3 flags 與 dependencies**

```ts
const v3ShadowEnabled = parseBooleanEnvFlag(Deno.env.get("LAI_V3_SHADOW_ENABLED"));
const v3ProductionEnabled = parseBooleanEnvFlag(Deno.env.get("LAI_V3_PRODUCTION_ENABLED"));
```

支援 `engine=lai-v3&dry_run=1`；`engine=lai-v3` 非 dry-run 回傳 HTTP 400。將 `codeCommit` 從必填 secret `LOTTO_CODE_COMMIT` 注入 evidence；缺少時 v3 shadow 記為 failed、formal 回退 v2，不可填入假版本。

- [ ] **Step 7: 加入 static contract assertions**

`index.contract.test.mjs` 必須驗證：

```js
assert.match(source, /LAI_V3_SHADOW_ENABLED/);
assert.match(source, /LAI_V3_PRODUCTION_ENABLED/);
assert.match(source, /LOTTO_CODE_COMMIT/);
assert.match(source, /engine=lai-v3 requires dry_run=1/);
assert.match(source, /insertEvidenceSnapshot[\s\S]*upsertPrediction[\s\S]*reserveNotification[\s\S]*sendLineMessage/);
```

- [ ] **Step 8: 執行完整 predict-notify suite**

```powershell
node --test supabase/functions/lotto-predict-notify/lib/*.test.mjs supabase/functions/lotto-predict-notify/index.contract.test.mjs
```

Expected: all tests PASS；shadow 不改 formal record；dry-run 零寫入；duplicate invocation 仍為 `skipped_duplicate`。

- [ ] **Step 9: Commit**

```powershell
git add supabase/functions/lotto-predict-notify
git commit -m "feat: isolate LAI v3 shadow and production runtime"
```

---

### Task 10: 在前端呈現可驗證的模型證據狀態

**Files:**
- Create: `frontend/src/components/ModelEvidencePanel.vue`
- Modify: `frontend/src/services/laiPresentation.js:1-151`
- Modify: `frontend/src/services/laiPresentation.test.mjs:1-207`
- Modify: `frontend/src/components/LaiAgentPanel.vue:1-100`
- Modify: `frontend/src/components/PredictionCard.vue:1-100`
- Modify: `frontend/src/components/PerformanceChart.vue:1-258`
- Modify: `frontend/src/services/responsiveLayout.test.mjs:1-21`

**Interfaces:**
- Consumes: `prediction.model = 'lai-v3'` 與 `prediction.evidence` public subset。
- Produces: `toModelEvidenceView(record)` 與 compact `ModelEvidencePanel`。
- View model: `{ champion, promotionStage, shadowSamples, brierSkill, ciLower95, ciUpper95, decisionReason, provenAboveRandom, limitation }`。

- [ ] **Step 1: 寫入 v3 presentation failing tests**

```js
const V3_RECORD = {
  game_name: "今彩539",
  target_draw_date: "2026-08-07",
  prediction: {
    model: "lai-v3",
    combinations: { "證據主攻": [1, 7, 13, 25, 39], "覆蓋保底": [2, 8, 14, 26, 38] },
    evidence: {
      champion_model: "uniform-null",
      promotion_stage: "baseline",
      shadow_live_draws: 18,
      brier_skill: -0.012,
      brier_ci: { lower95: -0.031, upper95: 0.008 },
      latest_decision_reason: "confidence_interval_crosses_zero",
      proven_above_random: false,
    },
  },
};
const V3_RECORD_WITHOUT_CI = structuredClone(V3_RECORD);
delete V3_RECORD_WITHOUT_CI.prediction.evidence.brier_ci;

test("maps only stored LAI v3 evidence", () => {
  const view = toLaiViewModel(V3_RECORD);
  assert.equal(view.version, "LAI v3");
  assert.deepEqual(view.groups.map((group) => group.label), ["證據主攻", "覆蓋保底"]);
  assert.deepEqual(view.evidence, {
    champion: "uniform-null",
    promotionStage: "baseline",
    shadowSamples: 18,
    brierSkill: -0.012,
    ciLower95: -0.031,
    ciUpper95: 0.008,
    decisionReason: "confidence_interval_crosses_zero",
    provenAboveRandom: false,
    limitation: "尚無足夠樣本外證據優於均勻隨機基準。",
  });
});

test("missing confidence interval stays unavailable", () => {
  const view = toModelEvidenceView(V3_RECORD_WITHOUT_CI);
  assert.equal(view.ciLower95, null);
  assert.equal(view.ciUpper95, null);
  assert.equal(view.provenAboveRandom, false);
});
```

- [ ] **Step 2: 執行 frontend tests 並確認 RED**

```powershell
Push-Location frontend
npm.cmd test
Pop-Location
```

Expected: FAIL because v3 presentation mapper and component do not exist.

- [ ] **Step 3: 擴充 LAI view model，不推導缺漏值**

```js
export function isLaiPredictionRecord(record) {
  return ["lai-v2", "lai-v3"].includes(record?.prediction?.model);
}

const groupLabelsFor = (model) => model === "lai-v3"
  ? ["證據主攻", "覆蓋保底"]
  : ["機率主攻", "覆蓋保底"];

export function toModelEvidenceView(record) {
  if (record?.prediction?.model !== "lai-v3") return null;
  const source = record.prediction.evidence || {};
  return {
    champion: typeof source.champion_model === "string" ? source.champion_model : null,
    promotionStage: typeof source.promotion_stage === "string" ? source.promotion_stage : null,
    shadowSamples: Number.isInteger(source.shadow_live_draws) ? source.shadow_live_draws : null,
    brierSkill: Number.isFinite(source.brier_skill) ? source.brier_skill : null,
    ciLower95: Number.isFinite(source.brier_ci?.lower95) ? source.brier_ci.lower95 : null,
    ciUpper95: Number.isFinite(source.brier_ci?.upper95) ? source.brier_ci.upper95 : null,
    decisionReason: typeof source.latest_decision_reason === "string" ? source.latest_decision_reason : null,
    provenAboveRandom: source.proven_above_random === true,
    limitation: source.proven_above_random === true
      ? "目前通過既定樣本外統計閘門，不代表未來開獎可被保證預測。"
      : "尚無足夠樣本外證據優於均勻隨機基準。",
  };
}
```

- [ ] **Step 4: 建立 compact evidence panel**

`ModelEvidencePanel.vue` 顯示五個欄位：champion、promotion stage、shadow samples、Brier skill 95% CI、latest reason。數值不存在時顯示「資料不足」，不得顯示 `0`。Status 必須有文字，不可只靠顏色。

```vue
<template>
  <section class="model-evidence" aria-labelledby="model-evidence-title">
    <header><h3 id="model-evidence-title">模型證據狀態</h3><strong>{{ stageLabel }}</strong></header>
    <dl>
      <div><dt>目前模型</dt><dd>{{ evidence.champion || '資料不足' }}</dd></div>
      <div><dt>Shadow 樣本</dt><dd>{{ evidence.shadowSamples ?? '資料不足' }}</dd></div>
      <div><dt>Brier skill 95% CI</dt><dd>{{ confidenceIntervalLabel }}</dd></div>
      <div><dt>最近決策</dt><dd>{{ reasonLabel }}</dd></div>
    </dl>
    <p>{{ evidence.limitation }}</p>
  </section>
</template>
```

Cards 維持最大 8 px radius；desktop 使用 4-column definition grid，720 px 以下改 1 column；長 model/reason 文字使用 `overflow-wrap: anywhere`。

- [ ] **Step 5: 接上 PredictionCard、LaiAgentPanel 與 PerformanceChart**

`PredictionCard` 改用 `isLaiPredictionRecord(latestPrediction)`；`LaiAgentPanel` title 取 `view.version` 並嵌入 `ModelEvidencePanel`。PerformanceChart 只在 CI 完整時顯示區間，不再以單一正值宣稱優於隨機。

- [ ] **Step 6: 加入 responsive contract 並 build**

```js
test("model evidence panel has a mobile single-column rule", async () => {
  const source = await readFile(new URL("../components/ModelEvidencePanel.vue", import.meta.url), "utf8");
  assert.match(source, /@media \(max-width: 720px\)/);
  assert.match(source, /grid-template-columns:\s*1fr/);
  assert.match(source, /overflow-wrap:\s*anywhere/);
});
```

```powershell
Push-Location frontend
npm.cmd test
npm.cmd run build:cloudflare
Pop-Location
```

Expected: frontend tests PASS；Cloudflare build exit `0`；無 overflow contract failure。

- [ ] **Step 7: Commit**

```powershell
git add frontend/src/services/laiPresentation.js frontend/src/services/laiPresentation.test.mjs frontend/src/components/ModelEvidencePanel.vue frontend/src/components/LaiAgentPanel.vue frontend/src/components/PredictionCard.vue frontend/src/components/PerformanceChart.vue frontend/src/services/responsiveLayout.test.mjs
git commit -m "feat: show LAI v3 model evidence"
```

---

### Task 11: 建立完整歷史 replay 與唯讀 production verifier

**Files:**
- Create: `scripts/lai_v3_replay.mjs`
- Create: `scripts/lai_v3_replay.test.mjs`
- Create: `scripts/lai_v3_verify.mjs`

**Interfaces:**
- Replay consumes: `--game=539|649|power`、`--source=local|supabase`、例如 `--seed=proof-1`，以及可省略的 `--output=reports/lai-v3-539.json`。
- Replay produces: JSON evidence report，預設只寫 stdout 或指定 output，不寫 Supabase。
- Verify consumes: `SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`，以及可省略的 `--require-stage=shadow_verified|canary|champion`；只執行 GET/RPC metadata checks。

- [ ] **Step 1: 寫入 CLI failing tests**

```js
const fixtureInput = {
  gameType: "539",
  seed: "replay-proof",
  registration: {
    id: "uniform-539",
    game_name: "今彩539",
    model_name: "uniform-null",
    model_family: "uniform-null",
    model_version: "uniform-null-v1",
    feature_version: "none-v1",
    parameters: { random_seed: "uniform-null-v1" },
    code_commit: "0123456789abcdef0123456789abcdef01234567",
    status: "baseline",
  },
  draws: [
    { draw_id: "1", draw_date: "2026-08-01", numbers: [1, 2, 3, 4, 5] },
    { draw_id: "2", draw_date: "2026-08-03", numbers: [6, 7, 8, 9, 10] },
    { draw_id: "3", draw_date: "2026-08-05", numbers: [11, 12, 13, 14, 15] },
  ],
};
const [draw1, draw2] = fixtureInput.draws;

test("replay defaults to read-only", () => {
  const args = parseArgs(["--game=539", "--source=local", "--seed=proof-1"]);
  assert.equal(args.persist, false);
  assert.equal(args.game, "539");
});

test("draws are sorted and duplicate identities are rejected", () => {
  assert.throws(() => normalizeReplayDraws([draw2, draw1, draw1]), /duplicate draw identity/i);
});

test("same input produces the same replay digest", async () => {
  const first = await runReplay(fixtureInput);
  const second = await runReplay(fixtureInput);
  assert.equal(first.replay_digest, second.replay_digest);
  assert.deepEqual(first.metrics, second.metrics);
});
```

- [ ] **Step 2: 執行 CLI tests 並確認 RED**

```powershell
node --test scripts/lai_v3_replay.test.mjs
```

Expected: FAIL because the replay module does not exist.

- [ ] **Step 3: 實作嚴格 CLI parser 與資料 adapters**

```js
export function parseArgs(argv) {
  const values = Object.fromEntries(argv.map((arg) => {
    const match = /^--([a-z-]+)=(.+)$/.exec(arg);
    if (!match) throw new Error(`Invalid argument: ${arg}`);
    return [match[1], match[2]];
  }));
  if (!['539', '649', 'power'].includes(values.game)) throw new Error('Invalid --game');
  if (!['local', 'supabase'].includes(values.source)) throw new Error('Invalid --source');
  if (!values.seed) throw new Error('--seed is required');
  return { game: values.game, source: values.source, seed: values.seed, output: values.output || null, persist: false };
}
```

Local adapter 分別讀取 `data/daily539.json`、`data/lotto649.json`、`data/power.json`；Supabase adapter 使用 service-role GET 分頁讀取 `lotto_draws`。兩者都必須依 `(draw_date, draw_id)` 排序並拒絕重複 identity。

- [ ] **Step 4: 實作唯讀 full replay report**

Report 必須包含：draw count、data cutoff、model/feature/code versions、recent-30/100/500、Brier/log loss/calibration、coverage、Power second area、CI、permutation p、adjusted q、promotion simulation 與 replay digest。CLI 不提供 `--persist` 模式，避免操作員誤把本地 replay 直接升級 production。

- [ ] **Step 5: 實作 production verifier**

`lai_v3_verify.mjs` 只做：

1. 檢查五張 v3 tables 可由 service role 讀取、anon key 不可讀取。
2. 檢查三彩種各有且只有一個 `uniform-null` baseline registration。
3. 檢查 experiment 的 cursor、data cutoff、digest 與 status 一致。
4. 檢查 shadow rows 沒有對應 v3 `prediction_records` 或 `notification_logs`。
5. 檢查 active state 每彩種最多一筆，canary weight 不超過 10%。
6. 檢查同 notification key 最多一筆 `sent`。

指定 `--require-stage` 時，三彩種都必須至少存在該階段的最新有效 decision 或 active state；未達門檻 exit `1`，不得自動 promote 或寫入資料。

任何失敗使用 JSON `{ Status, RootCause, SuggestedFix }` 輸出並 exit `1`。

- [ ] **Step 6: 執行三彩種本地 replay 與 tests**

```powershell
node --test scripts/lai_v3_replay.test.mjs
node scripts/lai_v3_replay.mjs --game=539 --source=local --seed=lai-v3-539
node scripts/lai_v3_replay.mjs --game=649 --source=local --seed=lai-v3-649
node scripts/lai_v3_replay.mjs --game=power --source=local --seed=lai-v3-power
```

Expected: tests PASS；三份 replay 都有 64-character digest；資料不足的視窗明確為 `null`，不顯示偽造的 0。

- [ ] **Step 7: Commit**

```powershell
git add scripts/lai_v3_replay.mjs scripts/lai_v3_replay.test.mjs scripts/lai_v3_verify.mjs
git commit -m "test: add LAI v3 replay and production verifier"
```

---

### Task 12: 完成文件、部署與分階段 production 驗收

**Files:**
- Modify: `docs/runtime-triggers.md`
- Modify: `docs/deployment-cloudflare-supabase.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: fully tested code、linked Supabase project、Cloudflare Git integration、server-side secrets。
- Produces: Phase A/B shadow deployment、Phase C canary checkpoint、Phase D champion checkpoint、可驗證 rollback runbook。

- [ ] **Step 1: 執行全 repo local verification**

```powershell
$supabaseTests = @(rg --files supabase/functions | Where-Object { $_ -like '*.test.mjs' })
node --test $supabaseTests
node --test scripts/lai_v3_replay.test.mjs
Push-Location frontend
npm.cmd test
npm.cmd run build:cloudflare
Pop-Location
git diff --check
```

Expected: every test command and build exits `0`；`git diff --check` 無輸出。

- [ ] **Step 2: 更新三份 runbook 文件**

文件必須記錄：

1. 06:00：draw update -> revision check -> v2 learning -> v3 immutable scoring -> FDR -> decision -> authorized activation。
2. 10:00：approved context -> two-group optimizer -> snapshot -> prediction -> notification reservation -> LINE。
3. `LAI_V3_SHADOW_ENABLED` 與 `LAI_V3_PRODUCTION_ENABLED` truth table。
4. `engine=lai-v3&dry_run=1` 為零寫入驗證。
5. Phase C 需要 30 個有效 shadow draws；Phase D 需要 20 個有效 canary draws，不能在部署當日宣告完成。
6. Gemini 僅產生敘述，不參與數值或 promotion。
7. Edge replay 使用 25-draw checkpoints；不得放入通知 request path。
8. Correction、rollback、LINE 去重與 `Status + RootCause + SuggestedFix` 故障格式。

- [ ] **Step 3: 檢查 remote migration history 並取得 production 核准**

```powershell
if (-not $env:SUPABASE_PROJECT_REF) { throw 'SUPABASE_PROJECT_REF is required.' }
if (-not $env:SUPABASE_URL) { throw 'SUPABASE_URL is required.' }
if (-not $env:SUPABASE_SERVICE_ROLE_KEY) { throw 'SUPABASE_SERVICE_ROLE_KEY is required.' }
npx --yes supabase link --project-ref $env:SUPABASE_PROJECT_REF
npx --yes supabase migration list
npx --yes supabase db push --dry-run
```

Expected: dry-run 只包含已審核 migration。停止執行，向使用者呈現 migration 清單並取得明確 production 核准；未核准不得繼續。

- [ ] **Step 4: 套用已核准 migration**

```powershell
npx --yes supabase db push
npx --yes supabase migration list
```

Expected: push exit `0`；remote migration history 出現 `20260806000000`。

- [ ] **Step 5: Deploy 三個 Edge Functions 並設定不可偽造版本**

```powershell
$codeCommit = (git rev-parse HEAD).Trim()
if ($codeCommit -notmatch '^[0-9a-f]{40}$') { throw 'Cannot resolve a full Git commit.' }
npx --yes supabase secrets set LOTTO_CODE_COMMIT=$codeCommit LAI_V3_SHADOW_ENABLED=true LAI_V3_PRODUCTION_ENABLED=false --project-ref $env:SUPABASE_PROJECT_REF
npx --yes supabase functions deploy lotto-predict-notify --project-ref $env:SUPABASE_PROJECT_REF --no-verify-jwt
npx --yes supabase functions deploy lotto-update --project-ref $env:SUPABASE_PROJECT_REF --no-verify-jwt
npx --yes supabase functions deploy lotto-train-agent --project-ref $env:SUPABASE_PROJECT_REF --no-verify-jwt
```

Expected: deploys succeed；v3 shadow on；v3 production off；LAI v2 production flag 保持原值。

- [ ] **Step 6: 登錄永久 baseline 與三個 shadow challenger**

使用實際 `$codeCommit` 建立每個彩種四筆 immutable registrations：

```powershell
$headers = @{
  apikey = $env:SUPABASE_SERVICE_ROLE_KEY
  Authorization = "Bearer $($env:SUPABASE_SERVICE_ROLE_KEY)"
  "Content-Type" = "application/json"
  Prefer = "return=representation"
}
$games = @('今彩539', '大樂透', '威力彩')
$models = @(
  @{ name='uniform-null'; family='uniform-null'; version='uniform-null-v1'; feature='none-v1'; status='baseline'; parameters=@{ random_seed='uniform-null-v1' } },
  @{ name='bayesian-drift'; family='bayesian-drift'; version='bayesian-drift-v1'; feature='weighted-counts-v1'; status='registered'; parameters=@{ halfLifeDraws=100; priorStrength=100; random_seed='bayesian-drift-v1' } },
  @{ name='transition-regularized'; family='transition-regularized'; version='transition-regularized-v1'; feature='transition-counts-v1'; status='registered'; parameters=@{ minimumSupport=30; effectCap=0.25; random_seed='transition-regularized-v1' } },
  @{ name='sequence-challenger'; family='sequence-challenger'; version='sequence-challenger-v1'; feature='lstm-static-v1'; status='registered'; parameters=@{ shadowOnly=$true; random_seed='sequence-challenger-v1' } }
)
$rows = foreach ($game in $games) { foreach ($model in $models) {
  @{
    game_name=$game; model_name=$model.name; model_family=$model.family;
    model_version=$model.version; feature_version=$model.feature;
    parameters=$model.parameters; code_commit=$codeCommit;
    status=$model.status; status_reason='initial_registered_configuration'
  }
} }
foreach ($row in $rows) {
  $game = [uri]::EscapeDataString([string]$row.game_name)
  $name = [uri]::EscapeDataString([string]$row.model_name)
  $version = [uri]::EscapeDataString([string]$row.model_version)
  $existing = @(Invoke-RestMethod -Method Get -Uri "$env:SUPABASE_URL/rest/v1/lai_model_registry?game_name=eq.$game&model_name=eq.$name&model_version=eq.$version&select=*" -Headers $headers)
  if ($existing.Count -eq 0) {
    Invoke-RestMethod -Method Post -Uri "$env:SUPABASE_URL/rest/v1/lai_model_registry?select=*" -Headers $headers -Body ($row | ConvertTo-Json -Depth 8)
    continue
  }
  $existingParameters = $existing[0].parameters | ConvertTo-Json -Depth 8 -Compress
  $expectedParameters = $row.parameters | ConvertTo-Json -Depth 8 -Compress
  if ($existing.Count -ne 1 -or $existing[0].code_commit -ne $row.code_commit -or $existing[0].feature_version -ne $row.feature_version -or $existing[0].model_family -ne $row.model_family -or $existingParameters -ne $expectedParameters) {
    throw "Existing immutable registration does not match $($row.game_name)/$($row.model_name)/$($row.model_version)."
  }
}
```

Expected: 每彩種恰好一筆 baseline 與三筆 registered challenger；sequence production weight 為 0。

- [ ] **Step 7: 建立並跑完三彩種 historical experiments**

每個 challenger 建立一筆 `lai_experiment_runs(run_mode='historical')`，再把回傳的 experiment UUID 寫入對應 `lotto_training_runs.experiment_run_id`，且 `algorithm_version='lai-v3'`。以既有 immutable snapshot RPC 凍結 draw range，反覆呼叫 `lotto-train-agent`，每次 `chunk_size = 25`，並在每次呼叫後確認 cursor 增加。

```powershell
$challengers = @(Invoke-RestMethod -Method Get -Uri "$env:SUPABASE_URL/rest/v1/lai_model_registry?status=eq.registered&select=*" -Headers $headers)
foreach ($challenger in $challengers) {
  $encodedGame = [uri]::EscapeDataString([string]$challenger.game_name)
  $countHeaders = $headers.Clone()
  $countHeaders.Prefer = 'count=exact'
  $countResponse = Invoke-WebRequest -Method Get -Uri "$env:SUPABASE_URL/rest/v1/lotto_draws?game_name=eq.$encodedGame&select=draw_id&limit=1" -Headers $countHeaders
  $contentRange = [string]$countResponse.Headers['Content-Range']
  if ($contentRange -notmatch '/(\d+)$') { throw "Cannot read draw count for $($challenger.game_name)." }
  $drawCount = [int]$Matches[1]
  if ($drawCount -lt 500) { throw "Historical gate requires at least 500 draws for $($challenger.game_name)." }
  $latestDraw = @(Invoke-RestMethod -Method Get -Uri "$env:SUPABASE_URL/rest/v1/lotto_draws?game_name=eq.$encodedGame&select=draw_date&order=draw_date.desc,draw_id.desc&limit=1" -Headers $headers)[0]
  if (-not $latestDraw.draw_date) { throw "Cannot resolve data cutoff for $($challenger.game_name)." }

  $experimentBody = @{
    registry_id=$challenger.id; game_name=$challenger.game_name; run_mode='historical';
    status='queued'; data_cutoff=$latestDraw.draw_date; range_start=0;
    range_end=$drawCount; checkpoint_cursor=0;
    random_seed=$challenger.parameters.random_seed; code_commit=$challenger.code_commit;
    feature_version=$challenger.feature_version; metrics=@{}
  } | ConvertTo-Json -Depth 8
  $experiment = @(Invoke-RestMethod -Method Post -Uri "$env:SUPABASE_URL/rest/v1/lai_experiment_runs?select=*" -Headers $headers -Body $experimentBody)[0]

  $trainingBody = @{
    game_name=$challenger.game_name; run_type='lai_v3_historical'; algorithm_version='lai-v3';
    status='queued'; range_start=0; range_end=$drawCount; checkpoint_cursor=0;
    experiment_run_id=$experiment.id;
    summary=@{ registry_id=$challenger.id; experiment_run_id=$experiment.id }
  } | ConvertTo-Json -Depth 8
  $training = @(Invoke-RestMethod -Method Post -Uri "$env:SUPABASE_URL/rest/v1/lotto_training_runs?select=*" -Headers $headers -Body $trainingBody)[0]
  $runId = [string]$training.id

  do {
    $before = @(Invoke-RestMethod -Method Get -Uri "$env:SUPABASE_URL/rest/v1/lotto_training_runs?id=eq.$runId&select=status,checkpoint_cursor,error_text" -Headers $headers)[0]
    if ($before.status -eq 'failed') { throw $before.error_text }
    if ($before.status -eq 'completed') { break }
    $payload = @{ run_id=$runId; chunk_size=25 } | ConvertTo-Json -Compress
    $after = Invoke-RestMethod -Method Post -Uri "$env:SUPABASE_URL/functions/v1/lotto-train-agent" -Headers $headers -Body $payload
    if ($after.status -ne 'completed' -and [int]$after.checkpoint_cursor -le [int]$before.checkpoint_cursor) {
      throw 'Training checkpoint did not advance.'
    }
  } while ($true)
  $completedExperiment = @(Invoke-RestMethod -Method Get -Uri "$env:SUPABASE_URL/rest/v1/lai_experiment_runs?id=eq.$($experiment.id)&select=status,replay_digest,error_text" -Headers $headers)[0]
  if ($completedExperiment.status -ne 'completed' -or $completedExperiment.replay_digest -notmatch '^[0-9a-f]{64}$') {
    throw "Experiment did not complete with a valid digest: $($experiment.id)"
  }
}
```

Expected: all runs `completed`；experiment digest 為 64 hex；這一步不新增 active state，也不改 LINE。

- [ ] **Step 8: 執行 v3 dry-run 與 production verifier**

```powershell
$dryRunUrl = "$env:SUPABASE_URL/functions/v1/lotto-predict-notify?game=all&dry_run=1&engine=lai-v3"
$dryRun = Invoke-RestMethod -Method Post -Uri $dryRunUrl -Headers $headers -Body '{}'
$dryRun | ConvertTo-Json -Depth 20
node scripts/lai_v3_verify.mjs
```

Expected: dry-run 每個 due game 有兩組合法號碼；威力彩有兩個不同第 2 區；dry-run 前後 prediction、snapshot、notification、LINE counts 不變；verifier exit `0`。

- [ ] **Step 9: 啟用 Phase B live shadow，保留 production v2**

```powershell
npx --yes supabase secrets set LAI_V3_SHADOW_ENABLED=true LAI_V3_PRODUCTION_ENABLED=false --project-ref $env:SUPABASE_PROJECT_REF
```

觀察至少 30 個「該彩種實際有開獎且 forecast 已成功評分」的 live draws。Calendar days、Function invocations 與 skipped dates 不得計入 sample count。期間 LINE 與前端正式推薦仍為 LAI v2。

- [ ] **Step 10: 只有 gate 產生 canary decision 後才啟用 Phase C**

Read-only query 必須確認最新 decision 為 `promote -> canary`、evidence digest 對應最新 score、authorized weight 小於等於 0.10，才執行：

```powershell
node scripts/lai_v3_verify.mjs --require-stage=canary
if ($LASTEXITCODE -ne 0) { throw 'Canary evidence gate is not satisfied.' }
npx --yes supabase secrets set LAI_V3_SHADOW_ENABLED=true LAI_V3_PRODUCTION_ENABLED=true --project-ref $env:SUPABASE_PROJECT_REF
```

Canary 至少觀察 20 個有效 draws。任何 rolling-30 skill negative、significant calibration regression、invalid data 或 digest mismatch，必須由 gate 回退；runtime 隨即使用 approved LAI v2。

- [ ] **Step 11: 只有 champion decision 通過才完成 Phase D**

驗證 recent-100、recent-500、Brier CI、log loss、coverage CI、adjusted q、20 canary draws 全部通過，且 `activate_lai_v3_state` 已產生完整 active state。然後執行一次 due-date production invocation，確認每彩種只有一筆 prediction 與一筆 LINE sent；重複 invocation 必須回傳 `skipped_duplicate`。

```powershell
node scripts/lai_v3_verify.mjs --require-stage=champion
if ($LASTEXITCODE -ne 0) { throw 'Champion evidence gate is not satisfied.' }
```

不要手動重送 LINE。等待下一次既有 10:00 Cron 完成後，使用 verifier 檢查該 target date 的 prediction 與 `notification_logs` 唯一性；再以 `dry_run=1` 驗證重複產生路徑不增加任何 sent count。

- [ ] **Step 12: 驗證 rollback**

```powershell
npx --yes supabase secrets set LAI_V3_SHADOW_ENABLED=false LAI_V3_PRODUCTION_ENABLED=false --project-ref $env:SUPABASE_PROJECT_REF
```

Expected: 下一次 dry-run 回到 approved LAI v2；v3 registry、experiments、scores、decisions、snapshots 與 corrections 保留；不刪除證據資料。

- [ ] **Step 13: Commit 文件**

```powershell
git add docs/runtime-triggers.md docs/deployment-cloudflare-supabase.md README.md
git commit -m "docs: add LAI v3 rollout and rollback runbook"
```

---

## Test Acceptance Checklist

### A. Schema、權限與一致性

- [ ] 五張 LAI v3 tables、forecast/score extensions 與三個 RPC migration contract tests PASS。
- [ ] 所有 v3 tables 啟用 RLS；`anon`、`authenticated` 無 direct grants；只有 `service_role` 可操作。
- [ ] `activate_lotto_training_candidate` 明確拒絕 LAI v3 run。
- [ ] Canary activation 對 challenger weight 大於 10% fail fast。
- [ ] 同彩種 decision/activation 使用 transaction-level advisory lock。
- [ ] Evidence snapshot 與 promotion decision 具唯一 digest/idempotency constraint。
- [ ] 官方 correction 會 invalid 舊 score 並新增 replacement，不會靜默 update metrics。

### B. 數學與模型

- [ ] 所有主區機率均在 `[0, 1]` 且總和等於 picks。
- [ ] 威力彩第 2 區機率長度為 8、總和為 1，且不讀取第 1 區特徵。
- [ ] 相同 data cutoff、registration、seed、commit 產生 bit-for-bit 相同 forecast 與 digest。
- [ ] 未來 draw 無法改變過去 forecast。
- [ ] Bayesian parameters 只來自 immutable registry。
- [ ] Transition support 小於 30 時回退 prior；effect cap 不超過 0.25 log-odds。
- [ ] Sequence challenger 在 production mode 被拒絕。
- [ ] Pure-random synthetic false promotion rate 不高於 5%。
- [ ] Controlled weak-bias synthetic data 在足夠樣本後可被偵測。

### C. Scoring、promotion 與學習

- [ ] Brier、log loss、calibration、coverage 與 Power special-area tests PASS。
- [ ] Candidate 與 uniform 只依相同 draw id 配對。
- [ ] Matched-random baseline 保持相同組數、picks 與 overlap constraints。
- [ ] Bootstrap、permutation 與 FDR 對相同 seed 完全可重播。
- [ ] Recent-30、100、500 樣本不足時為 `null`。
- [ ] 單期結果不能升級或降級。
- [ ] 30 live shadow 與 20 live canary 門檻無法被 skipped dates 或重複評分灌水。
- [ ] 同 family 最多一個 active representative。
- [ ] 長期 negative skill 進 cooldown 且 production weight 為 0。
- [ ] V3 score/gate failure 不影響官方 draw、LAI v2 learning 或 prior active state。

### D. 正式兩組與通知

- [ ] 三彩種 production response 都只有「證據主攻」與「覆蓋保底」兩組。
- [ ] 今彩 539 每組 5 個合法不重複號碼；大樂透與威力彩每組 6 個。
- [ ] Main coverage group utility 至少為 attack group 的 90%。
- [ ] Main overlap 不超過 `floor(picks / 3)`。
- [ ] 威力彩兩組各有一個 1 至 8 的第 2 區，且兩個第 2 區不同。
- [ ] Shadow 不寫 formal prediction、snapshot、notification 或 LINE。
- [ ] V3 dry-run 為零寫入。
- [ ] Snapshot 在 prediction、notification reservation 與 LINE 之前完成。
- [ ] 同 notification key 重試不產生第二筆 LINE。
- [ ] 無完整 approved v3 state 時回退 approved LAI v2；兩者皆無時停止通知。

### E. 前端、文件與 production 邊界

- [ ] 前端顯示 champion、stage、shadow samples、Brier skill CI 與 latest reason。
- [ ] Missing CI 顯示「資料不足」，不顯示 0。
- [ ] 未通過 gate 時顯示「尚無足夠樣本外證據」，不宣稱提高中獎率。
- [ ] Desktop、720 px mobile contract 與 Cloudflare build PASS，文字不 overflow。
- [ ] Gemini 沒有任何正式機率、號碼、權重或 promotion write path。
- [ ] 06:00 與 10:00 Cron names/schedules 不變，GitHub Actions 無正式 runtime job。
- [ ] Phase A/B deploy 後 production 仍為 LAI v2。
- [ ] Phase C 未累積 30 個有效 shadow draws 前不得開始。
- [ ] Phase D 未累積 20 個有效 canary draws 及全部閘門前不得宣告 champion。
- [ ] Rollback 只切 flags，不刪除任何 v3 evidence。
- [ ] `.claude/settings.local.json` 未被 staged、committed 或修改。

## Final Commands

```powershell
$allSupabaseTests = @(rg --files supabase/functions | Where-Object { $_ -like '*.test.mjs' })
node --test $allSupabaseTests
node --test scripts/lai_v3_replay.test.mjs
Push-Location frontend
npm.cmd test
npm.cmd run build:cloudflare
Pop-Location
git diff --check
git status --short
```

Expected before deployment: all tests PASS；build exit `0`；diff check clean；`git status` 只顯示本 task 預期檔案與既有 `.claude/settings.local.json` 變更。

## Operational References

- Supabase Edge Functions architecture and guidance for short-lived, idempotent work: https://supabase.com/docs/guides/functions
- Supabase hosted Edge Function limits: https://supabase.com/docs/guides/functions/limits
- Supabase CLI `db push --dry-run` and deployment reference: https://supabase.com/docs/reference/cli/supabase-projects-create
- PostgreSQL transaction-level advisory locks: https://www.postgresql.org/docs/current/functions-admin.html
