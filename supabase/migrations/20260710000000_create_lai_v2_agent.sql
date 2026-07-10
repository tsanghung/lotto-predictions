create table if not exists public.lotto_agent_states (
  id uuid primary key default gen_random_uuid(),
  game_name text not null,
  state_version bigint not null,
  status text not null check (status in ('baseline', 'champion', 'degraded')),
  champion_model text not null,
  expert_weights jsonb not null,
  learning_config jsonb not null,
  metrics jsonb not null default '{}'::jsonb,
  last_learned_draw_id text,
  last_learned_draw_date date,
  is_active boolean not null default false,
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  unique (game_name, state_version)
);

create unique index if not exists lotto_agent_states_one_active_idx
  on public.lotto_agent_states (game_name)
  where is_active;

create table if not exists public.lotto_model_forecasts (
  id uuid primary key default gen_random_uuid(),
  prediction_source_key text not null,
  game_name text not null,
  target_draw_date date not null,
  model_name text not null,
  model_version text not null,
  forecast_mode text not null check (forecast_mode in ('shadow', 'production')),
  probabilities jsonb not null,
  special_probabilities jsonb,
  final_groups jsonb not null default '{}'::jsonb,
  feature_summary jsonb not null default '{}'::jsonb,
  agent_state_version bigint,
  data_status text not null,
  generated_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (game_name, target_draw_date, model_name, model_version, forecast_mode)
);

create index if not exists lotto_model_forecasts_game_name_target_draw_date_idx
  on public.lotto_model_forecasts (game_name, target_draw_date);

create table if not exists public.lotto_model_scores (
  id uuid primary key default gen_random_uuid(),
  forecast_id uuid not null references public.lotto_model_forecasts(id) on delete cascade,
  game_name text not null,
  draw_id text not null,
  draw_date date not null,
  metrics jsonb not null,
  weight_before numeric,
  weight_after numeric,
  evaluator_version text not null,
  evaluated_at timestamptz not null default now(),
  unique (forecast_id, draw_id)
);

create index if not exists lotto_model_scores_game_name_draw_date_idx
  on public.lotto_model_scores (game_name, draw_date);

create table if not exists public.lotto_training_runs (
  id uuid primary key default gen_random_uuid(),
  game_name text not null,
  run_type text not null,
  algorithm_version text not null,
  status text not null check (status in ('queued', 'running', 'completed', 'failed')),
  range_start integer not null default 0,
  range_end integer not null,
  checkpoint_cursor integer not null default 0,
  summary jsonb not null default '{}'::jsonb,
  error_text text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists lotto_training_runs_game_name_created_at_idx
  on public.lotto_training_runs (game_name, created_at);

create trigger set_lotto_training_runs_updated_at
  before update on public.lotto_training_runs
  for each row
  execute function public.set_updated_at();

alter table public.lotto_agent_states enable row level security;
alter table public.lotto_model_forecasts enable row level security;
alter table public.lotto_model_scores enable row level security;
alter table public.lotto_training_runs enable row level security;

create or replace function public.activate_lotto_agent_state(p_state jsonb)
returns public.lotto_agent_states
language plpgsql
security definer
set search_path = public
as $$
declare
  activated public.lotto_agent_states;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_state->>'game_name', 0));

  select * into activated
  from public.lotto_agent_states
  where game_name = p_state->>'game_name'
    and is_active
    and last_learned_draw_id is not distinct from p_state->>'last_learned_draw_id';

  if found then
    return activated;
  end if;

  update public.lotto_agent_states
  set is_active = false
  where game_name = p_state->>'game_name' and is_active;

  insert into public.lotto_agent_states (
    game_name, state_version, status, champion_model, expert_weights,
    learning_config, metrics, last_learned_draw_id, last_learned_draw_date,
    is_active, activated_at
  ) values (
    p_state->>'game_name',
    (p_state->>'state_version')::bigint,
    p_state->>'status',
    p_state->>'champion_model',
    p_state->'expert_weights',
    p_state->'learning_config',
    coalesce(p_state->'metrics', '{}'::jsonb),
    p_state->>'last_learned_draw_id',
    nullif(p_state->>'last_learned_draw_date', '')::date,
    true,
    now()
  )
  returning * into activated;

  return activated;
end;
$$;

revoke all on function public.activate_lotto_agent_state(jsonb) from public;
grant execute on function public.activate_lotto_agent_state(jsonb) to service_role;
