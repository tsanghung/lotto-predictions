create table if not exists public.notification_logs (
  notification_key text primary key,
  game_name text not null,
  target_date date not null,
  notification_type text not null,
  status text not null default 'reserved',
  payload jsonb not null default '{}'::jsonb,
  response jsonb,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists notification_logs_game_date_idx
  on public.notification_logs (game_name, target_date desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_notification_logs_updated_at on public.notification_logs;
create trigger set_notification_logs_updated_at
before update on public.notification_logs
for each row execute function public.set_updated_at();

alter table public.notification_logs enable row level security;

drop policy if exists "No public read notification logs" on public.notification_logs;
create policy "No public read notification logs"
on public.notification_logs for select
using (false);

create or replace function public.invoke_lotto_predict_notify()
returns bigint
language plpgsql
security definer
set search_path = public, vault, extensions, net
as $$
declare
  service_role_key text;
  request_id bigint;
begin
  select decrypted_secret
    into service_role_key
    from vault.decrypted_secrets
   where name = 'lotto_update_service_role_key'
   limit 1;

  if service_role_key is null or length(service_role_key) = 0 then
    raise exception 'Missing Vault secret: lotto_update_service_role_key';
  end if;

  select net.http_post(
    url := 'https://qscqemykkkarzsufudji.supabase.co/functions/v1/lotto-predict-notify?game=due',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', service_role_key,
      'Authorization', 'Bearer ' || service_role_key
    ),
    body := jsonb_build_object(
      'source', 'supabase_cron',
      'job', 'lotto-predict-notify-after-update'
    )
  )
    into request_id;

  return request_id;
end;
$$;

revoke all on function public.invoke_lotto_predict_notify() from public;
grant execute on function public.invoke_lotto_predict_notify() to postgres;

do $$
begin
  perform cron.unschedule('lotto-predict-notify-after-update');
exception
  when others then
    null;
end;
$$;

select cron.schedule(
  'lotto-predict-notify-after-update',
  '25 14 * * *',
  $$select public.invoke_lotto_predict_notify();$$
);

comment on function public.invoke_lotto_predict_notify() is
  'Invokes lotto-predict-notify Edge Function. Cron runs at 14:25 UTC / 22:25 Asia/Taipei.';
