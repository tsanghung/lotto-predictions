# Supabase Lotto Update Cron

> Current runtime boundary: see [runtime-triggers.md](../runtime-triggers.md). GitHub Actions no longer owns production runtime jobs.

## Required Secret

Supabase Vault must contain the service role key used by database cron jobs to invoke Edge Functions:

```sql
select vault.create_secret(
  'your_service_role_key',
  'lotto_update_service_role_key',
  'Used by Supabase Cron to invoke lotto Edge Functions'
);
```

## Deploy Function

```powershell
$env:SUPABASE_ACCESS_TOKEN='your_supabase_access_token'
npx supabase functions deploy lotto-update --project-ref qscqemykkkarzsufudji --no-verify-jwt
```

## Apply Migration

Apply the latest runtime trigger migration:

```text
supabase/migrations/20260616000000_rehome_runtime_triggers_to_supabase.sql
```

The production cron schedules are:

```text
lotto-update-after-draw              0 22 * * *  # 06:00 Asia/Taipei
lotto-predict-notify-after-update    0 2 * * *   # 10:00 Asia/Taipei
```

## Manual Verification

Dry-run yesterday's update:

```powershell
curl.exe -X POST "https://qscqemykkkarzsufudji.supabase.co/functions/v1/lotto-update?game=all&target_date=YYYY-MM-DD&dry_run=1" `
  -H "Authorization: Bearer your_service_role_key" `
  -H "apikey: your_service_role_key"
```

Inspect Supabase Cron:

```sql
select jobid, jobname, schedule, command, active
from cron.job
order by jobid;
```

Trigger the scheduled database function manually only when repairing production data:

```sql
select public.invoke_lotto_update();
```
