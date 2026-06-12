# Supabase Lotto Update Cron

This project now runs the production draw update job from Supabase instead of GitHub Actions.

## Required Secrets

Supabase hosted Edge Functions include `SUPABASE_URL`, `SUPABASE_SECRET_KEYS`, and legacy `SUPABASE_SERVICE_ROLE_KEY` automatically.

Set this Vault secret in Supabase SQL Editor:

```sql
select vault.create_secret(
  'your_service_role_key',
  'lotto_update_service_role_key',
  'Used by Supabase Cron to invoke the lotto-update Edge Function'
);
```

## Deploy Function

```bash
$env:SUPABASE_ACCESS_TOKEN='your_supabase_access_token'
npx supabase functions deploy lotto-update --project-ref qscqemykkkarzsufudji --no-verify-jwt
```

## Apply Migration

Apply `supabase/migrations/20260612010000_schedule_lotto_update_function.sql` with the Supabase SQL Editor or Supabase CLI.

The cron schedule is:

```text
17 14 * * *
```

That is Taiwan time 22:17.

## Manual Test

After deployment, call the function in dry-run mode:

```bash
curl -X POST "https://qscqemykkkarzsufudji.supabase.co/functions/v1/lotto-update?game=all&dry_run=1" ^
  -H "Authorization: Bearer your_service_role_key" ^
  -H "apikey: your_service_role_key"
```

Run a real update:

```bash
curl -X POST "https://qscqemykkkarzsufudji.supabase.co/functions/v1/lotto-update?game=all" ^
  -H "Authorization: Bearer your_service_role_key" ^
  -H "apikey: your_service_role_key"
```

Trigger the scheduled database function manually:

```sql
select public.invoke_lotto_update();
```
