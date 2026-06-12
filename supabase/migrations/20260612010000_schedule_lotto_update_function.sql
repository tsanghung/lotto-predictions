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
    url := 'https://qscqemykkkarzsufudji.supabase.co/functions/v1/lotto-update?game=all',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', service_role_key,
      'Authorization', 'Bearer ' || service_role_key
    ),
    body := jsonb_build_object(
      'source', 'supabase_cron',
      'job', 'lotto-update-after-draw'
    )
  )
    into request_id;

  return request_id;
end;
$$;

revoke all on function public.invoke_lotto_update() from public;
grant execute on function public.invoke_lotto_update() to postgres;

do $$
begin
  perform cron.unschedule('lotto-update-after-draw');
exception
  when others then
    null;
end;
$$;

select cron.schedule(
  'lotto-update-after-draw',
  '17 14 * * *',
  $$select public.invoke_lotto_update();$$
);

comment on function public.invoke_lotto_update() is
  'Invokes the lotto-update Edge Function. Requires Vault secret lotto_update_service_role_key. Cron runs at 14:17 UTC / 22:17 Asia/Taipei.';
