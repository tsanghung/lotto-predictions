create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;
create extension if not exists supabase_vault cascade;

create or replace function public.invoke_lotto_update()
returns bigint
language plpgsql
security definer
set search_path = public, vault, extensions, net
as $$
declare
  service_role_key text;
  request_id bigint;
  target_date date := ((now() at time zone 'Asia/Taipei')::date - interval '1 day')::date;
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
    url := 'https://qscqemykkkarzsufudji.supabase.co/functions/v1/lotto-update?game=all&target_date=' || target_date::text,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', service_role_key,
      'Authorization', 'Bearer ' || service_role_key
    ),
    body := jsonb_build_object(
      'source', 'supabase_cron',
      'job', 'lotto-update-after-draw',
      'checkpoint', 'taiwan_06_previous_draw_update',
      'target_date', target_date::text
    )
  )
    into request_id;

  return request_id;
end;
$$;

revoke all on function public.invoke_lotto_update() from public;
grant execute on function public.invoke_lotto_update() to postgres;

create or replace function public.invoke_lotto_predict_notify()
returns bigint
language plpgsql
security definer
set search_path = public, vault, extensions, net
as $$
declare
  service_role_key text;
  request_id bigint;
  target_date date := (now() at time zone 'Asia/Taipei')::date;
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
    url := 'https://qscqemykkkarzsufudji.supabase.co/functions/v1/lotto-predict-notify?game=due&target_date=' || target_date::text,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', service_role_key,
      'Authorization', 'Bearer ' || service_role_key
    ),
    body := jsonb_build_object(
      'source', 'supabase_cron',
      'job', 'lotto-predict-notify-after-update',
      'checkpoint', 'taiwan_10_due_prediction_notify',
      'target_date', target_date::text
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
  perform cron.unschedule('lotto-update-after-draw');
exception
  when others then
    null;
end;
$$;

do $$
begin
  perform cron.unschedule('lotto-predict-notify-after-update');
exception
  when others then
    null;
end;
$$;

select cron.schedule(
  'lotto-update-after-draw',
  '0 22 * * *',
  $$select public.invoke_lotto_update();$$
);

select cron.schedule(
  'lotto-predict-notify-after-update',
  '0 2 * * *',
  $$select public.invoke_lotto_predict_notify();$$
);

comment on function public.invoke_lotto_update() is
  'Invokes lotto-update Edge Function at 22:00 UTC / 06:00 Asia/Taipei and passes Taiwan yesterday as target_date.';

comment on function public.invoke_lotto_predict_notify() is
  'Invokes lotto-predict-notify Edge Function at 02:00 UTC / 10:00 Asia/Taipei for games due on Taiwan today.';
