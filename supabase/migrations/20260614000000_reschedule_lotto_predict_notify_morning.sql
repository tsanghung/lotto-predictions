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
  '0 2 * * *',
  $$select public.invoke_lotto_predict_notify();$$
);

comment on function public.invoke_lotto_predict_notify() is
  'Invokes lotto-predict-notify Edge Function. Cron runs at 02:00 UTC / 10:00 Asia/Taipei on due draw dates only.';
