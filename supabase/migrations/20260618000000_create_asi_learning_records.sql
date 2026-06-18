create table if not exists public.asi_learning_records (
  id uuid primary key default gen_random_uuid(),
  game_name text not null,
  target_draw_date date not null,
  draw_id text,
  prediction_source_key text not null,
  predicted_numbers jsonb not null default '[]'::jsonb,
  actual_numbers jsonb not null default '[]'::jsonb,
  matched_numbers jsonb not null default '[]'::jsonb,
  missed_numbers jsonb not null default '[]'::jsonb,
  selected_number_reasons jsonb not null default '{}'::jsonb,
  actual_number_analysis jsonb not null default '[]'::jsonb,
  strategy_effectiveness jsonb not null default '{}'::jsonb,
  next_adjustments jsonb not null default '[]'::jsonb,
  model_name text,
  reasoning_source text,
  raw_learning_report jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(game_name, target_draw_date, prediction_source_key)
);

create index if not exists asi_learning_records_game_date_idx
  on public.asi_learning_records (game_name, target_draw_date desc);

create index if not exists asi_learning_records_created_at_idx
  on public.asi_learning_records (created_at desc);

alter table public.prediction_records
  add column if not exists asi_state jsonb,
  add column if not exists asi_learning_context jsonb,
  add column if not exists model_name text,
  add column if not exists reasoning_source text;

alter table public.asi_learning_records enable row level security;

drop policy if exists "Public read ASI learning records" on public.asi_learning_records;
create policy "Public read ASI learning records"
on public.asi_learning_records for select
using (true);

drop trigger if exists set_asi_learning_records_updated_at on public.asi_learning_records;
create trigger set_asi_learning_records_updated_at
before update on public.asi_learning_records
for each row
execute function public.set_updated_at();
