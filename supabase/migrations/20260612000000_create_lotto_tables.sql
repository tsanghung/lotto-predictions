create table if not exists public.lotto_draws (
  game_name text not null,
  draw_id text not null,
  draw_date date not null,
  numbers integer[] not null,
  special_number integer,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (game_name, draw_id)
);

create index if not exists lotto_draws_game_date_idx
  on public.lotto_draws (game_name, draw_date desc);

create table if not exists public.prediction_records (
  source_key text primary key,
  game_name text not null,
  predicted_at timestamptz not null,
  prediction jsonb not null default '{}'::jsonb,
  is_evaluated boolean not null default false,
  evaluation jsonb,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists prediction_records_game_time_idx
  on public.prediction_records (game_name, predicted_at desc);

create table if not exists public.performance_snapshots (
  snapshot_key text primary key,
  last_updated timestamptz,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.app_meta (
  meta_key text primary key,
  last_updated timestamptz,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_lotto_draws_updated_at on public.lotto_draws;
create trigger set_lotto_draws_updated_at
before update on public.lotto_draws
for each row execute function public.set_updated_at();

drop trigger if exists set_prediction_records_updated_at on public.prediction_records;
create trigger set_prediction_records_updated_at
before update on public.prediction_records
for each row execute function public.set_updated_at();

drop trigger if exists set_performance_snapshots_updated_at on public.performance_snapshots;
create trigger set_performance_snapshots_updated_at
before update on public.performance_snapshots
for each row execute function public.set_updated_at();

drop trigger if exists set_app_meta_updated_at on public.app_meta;
create trigger set_app_meta_updated_at
before update on public.app_meta
for each row execute function public.set_updated_at();

alter table public.lotto_draws enable row level security;
alter table public.prediction_records enable row level security;
alter table public.performance_snapshots enable row level security;
alter table public.app_meta enable row level security;

drop policy if exists "Public read lotto draws" on public.lotto_draws;
create policy "Public read lotto draws"
on public.lotto_draws for select
using (true);

drop policy if exists "Public read prediction records" on public.prediction_records;
create policy "Public read prediction records"
on public.prediction_records for select
using (true);

drop policy if exists "Public read performance snapshots" on public.performance_snapshots;
create policy "Public read performance snapshots"
on public.performance_snapshots for select
using (true);

drop policy if exists "Public read app meta" on public.app_meta;
create policy "Public read app meta"
on public.app_meta for select
using (true);
