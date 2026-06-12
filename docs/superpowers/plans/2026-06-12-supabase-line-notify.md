# Supabase Line Notify Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move prediction generation and LINE push notifications from GitHub Actions to Supabase Edge Functions with database-level duplicate prevention.

**Architecture:** Add a `lotto-predict-notify` Edge Function that reads `lotto_draws`, generates deterministic statistical prediction combinations, upserts `prediction_records`, sends LINE push messages, and records each send in `notification_logs`. Supabase Cron invokes the function after the draw update schedule, while GitHub `predict_and_notify.yml` remains manual fallback only.

**Tech Stack:** Supabase Edge Functions, Deno, Supabase REST, LINE Messaging API, Node test runner for pure logic, SQL migrations for `notification_logs` and Cron.

---

### Task 1: Prediction Core

**Files:**
- Create: `supabase/functions/lotto-predict-notify/lib/predictCore.js`
- Create: `supabase/functions/lotto-predict-notify/lib/predictCore.test.mjs`

- [x] **Step 1: Write failing tests**

Cover frequency ranking, cold number ranking, balanced combinations, stable source keys, and LINE message formatting.

- [x] **Step 2: Run tests and confirm RED**

Run: `node --test supabase/functions/lotto-predict-notify/lib/predictCore.test.mjs`

- [x] **Step 3: Implement core helpers**

Implement `generatePrediction`, `sourceKey`, `notificationKey`, `buildLineMessage`, and `nextDrawDate`.

- [x] **Step 4: Run tests and confirm GREEN**

Run: `node --test supabase/functions/lotto-predict-notify/lib/predictCore.test.mjs`

### Task 2: Edge Function

**Files:**
- Create: `supabase/functions/lotto-predict-notify/index.ts`

- [x] **Step 1: Implement request handler**

Accept `game=all|539|649`, `dry_run=1`, and `target_date=YYYY-MM-DD`.

- [x] **Step 2: Add duplicate prevention**

Insert `notification_logs` before sending. If a unique conflict happens, skip sending.

- [x] **Step 3: Upsert prediction records**

Persist predictions with stable source keys and Taipei timestamps.

### Task 3: SQL Migration

**Files:**
- Create: `supabase/migrations/20260612020000_schedule_lotto_predict_notify.sql`

- [x] **Step 1: Create notification log table**

Add unique `notification_key`.

- [x] **Step 2: Create invocation function and Cron**

Schedule `lotto-predict-notify-after-update` at Taiwan time 22:25.

### Task 4: GitHub Fallback

**Files:**
- Modify: `.github/workflows/predict_and_notify.yml`

- [x] **Step 1: Disable automatic GitHub triggers**

Remove `workflow_run` and keep `workflow_dispatch` only.

### Task 5: Verification and Deploy

**Files:**
- None

- [x] **Step 1: Run tests**

Run Node and Python tests.

- [x] **Step 2: Deploy function**

Deploy with `npx supabase functions deploy lotto-predict-notify --no-verify-jwt`.

- [x] **Step 3: Apply migration**

Apply migration through Supabase Management API.

- [x] **Step 4: Dry-run function**

Call with `dry_run=1` and confirm no LINE message is sent.
