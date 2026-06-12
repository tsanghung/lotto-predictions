# Supabase Lotto Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Move the daily lottery draw update job from GitHub Actions to Supabase Edge Functions and Supabase Cron.

**Architecture:** Keep the frontend on Cloudflare Pages and write fresh draw data directly into Supabase. The Edge Function fetches Taiwan Lottery official data, checks Auzonet as a secondary source when Daily539 looks stale, upserts `lotto_draws`, and updates `app_meta`. Supabase Cron invokes the function after the Taiwan evening draw.

**Tech Stack:** Supabase Edge Functions, Deno runtime, plain REST calls to Supabase PostgREST, Node built-in test runner for shared pure JavaScript logic, SQL migration for `pg_cron` and `pg_net`.

---

### Task 1: Shared Lotto Update Core

**Files:**
- Create: `supabase/functions/lotto-update/lib/lottoCore.js`
- Create: `supabase/functions/lotto-update/lib/lottoCore.test.mjs`

- [x] **Step 1: Write failing tests**

Add tests for official API parsing, stale official data detection, secondary source selection, and conflicting source rejection.

- [x] **Step 2: Run tests and confirm RED**

Run: `node --test supabase/functions/lotto-update/lib/lottoCore.test.mjs`

Expected: FAIL because `lottoCore.js` does not exist yet.

- [x] **Step 3: Implement pure core helpers**

Implement `parseOfficialPayload`, `parseAuzonetDaily539Html`, `chooseFreshestDraw`, `isDaily539ExpectedDrawDate`, `needsSecondaryDaily539Check`, and `toLottoDrawRow`.

- [x] **Step 4: Run tests and confirm GREEN**

Run: `node --test supabase/functions/lotto-update/lib/lottoCore.test.mjs`

Expected: PASS.

### Task 2: Supabase Edge Function

**Files:**
- Create: `supabase/functions/lotto-update/index.ts`

- [x] **Step 1: Implement HTTP and scheduled-compatible handler**

The handler accepts `game=all|539|649`, `dry_run=1`, and `target_date=YYYY-MM-DD`. It fetches official data, checks the secondary source when needed, upserts rows to Supabase, and returns a JSON summary.

- [x] **Step 2: Add fail-fast validation**

Return `500` with `Status`, `Root Cause`, and `Suggested Fix` when required secrets or source fetches fail.

### Task 3: Supabase Cron Migration

**Files:**
- Create: `supabase/migrations/20260612010000_schedule_lotto_update_function.sql`

- [x] **Step 1: Enable cron dependencies**

Enable `pg_cron`, `pg_net`, and `vault` extensions if available.

- [x] **Step 2: Store function invocation schedule**

Schedule `lotto-update-after-draw` at `17 14 * * *` UTC, which is Taiwan time 22:17.

- [x] **Step 3: Secure invocation token lookup**

Use Supabase Vault secret names so the database job does not hard-code keys in migration SQL.

### Task 4: GitHub Actions Deactivation

**Files:**
- Modify: `.github/workflows/update_data.yml`

- [x] **Step 1: Disable schedule trigger**

Remove the `schedule` trigger and keep `workflow_dispatch` only as a temporary manual fallback.

- [x] **Step 2: Add migration notice**

Add a clear comment that production scheduling now lives in Supabase Cron.

### Task 5: Verification

**Files:**
- None

- [x] **Step 1: Run core tests**

Run: `node --test supabase/functions/lotto-update/lib/lottoCore.test.mjs`

- [x] **Step 2: Run Python fallback tests**

Run: `python -m unittest tests.test_update_latest_fallback`

- [x] **Step 3: Inspect Git diff**

Run: `git diff --stat`

- [x] **Step 4: Deploy when credentials are available**

Run: `npx supabase functions deploy lotto-update --project-ref qscqemykkkarzsufudji`

Then apply the migration through Supabase CLI or SQL Editor.
