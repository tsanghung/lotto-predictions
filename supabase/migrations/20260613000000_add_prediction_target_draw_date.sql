alter table public.prediction_records
  add column if not exists target_draw_date date;

create index if not exists prediction_records_game_target_draw_date_idx
  on public.prediction_records (game_name, target_draw_date desc, predicted_at desc);

create index if not exists prediction_records_pending_target_draw_date_idx
  on public.prediction_records (target_draw_date)
  where is_evaluated = false and target_draw_date is not null;
