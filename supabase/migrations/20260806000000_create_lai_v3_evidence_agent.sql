create table if not exists public.lai_model_registry (
  id uuid primary key default gen_random_uuid(),
  game_name text not null,
  model_name text not null,
  model_family text not null check (model_family in (
    'uniform-null', 'bayesian-drift', 'transition-regularized', 'sequence-challenger'
  )),
  model_version text not null,
  feature_version text not null,
  parameters jsonb not null default '{}'::jsonb,
  code_commit text not null check (code_commit ~ '^[0-9a-f]{7,64}$'),
  status text not null check (status in (
    'baseline', 'registered', 'historical_passed', 'shadow_verified',
    'canary', 'champion', 'cooldown', 'disabled', 'rejected'
  )),
  status_reason text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (game_name, model_name, model_version)
);

create table if not exists public.lai_experiment_runs (
  id uuid primary key default gen_random_uuid(),
  registry_id uuid not null references public.lai_model_registry(id),
  game_name text not null,
  run_mode text not null check (run_mode in ('historical', 'shadow', 'canary')),
  status text not null check (status in ('queued', 'running', 'completed', 'failed')),
  data_cutoff date not null,
  range_start integer not null default 0,
  range_end integer not null,
  checkpoint_cursor integer not null default 0,
  random_seed text not null,
  code_commit text not null,
  feature_version text not null,
  metrics jsonb not null default '{}'::jsonb,
  replay_digest text,
  error_text text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.lai_promotion_decisions (
  id uuid primary key default gen_random_uuid(),
  registry_id uuid not null references public.lai_model_registry(id),
  game_name text not null,
  from_status text not null,
  decision text not null check (decision in ('promote', 'hold', 'demote', 'disable')),
  to_status text not null,
  gate_version text not null,
  evidence jsonb not null,
  evidence_digest text not null,
  reason text not null,
  decided_at timestamptz not null default now(),
  unique (registry_id, evidence_digest, decision)
);

create table if not exists public.lai_evidence_snapshots (
  id uuid primary key default gen_random_uuid(),
  prediction_source_key text not null unique,
  game_name text not null,
  target_draw_date date not null,
  champion_registry_id uuid references public.lai_model_registry(id),
  agent_state_version bigint,
  model_version text not null,
  data_cutoff date not null,
  data_status text not null,
  main_probabilities jsonb not null,
  special_probabilities jsonb,
  groups jsonb not null,
  group_metrics jsonb not null,
  optimizer_version text not null,
  random_seed text not null,
  code_commit text not null,
  notification_key text not null,
  replay_digest text not null,
  generated_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists public.lai_evidence_corrections (
  id uuid primary key default gen_random_uuid(),
  game_name text not null,
  draw_id text not null,
  previous_revision text not null,
  corrected_revision text not null,
  previous_draw jsonb not null,
  corrected_draw jsonb not null,
  invalidated_score_ids jsonb not null default '[]'::jsonb,
  replacement_score_ids jsonb not null default '[]'::jsonb,
  reason text not null,
  created_at timestamptz not null default now(),
  unique (game_name, draw_id, corrected_revision)
);

alter table public.lotto_model_forecasts
  add column if not exists registry_id uuid references public.lai_model_registry(id),
  add column if not exists experiment_run_id uuid references public.lai_experiment_runs(id),
  add column if not exists feature_version text,
  add column if not exists random_seed text,
  add column if not exists code_commit text,
  add column if not exists replay_digest text;

alter table public.lotto_model_forecasts
  drop constraint if exists lotto_model_forecasts_forecast_mode_check;
alter table public.lotto_model_forecasts
  add constraint lotto_model_forecasts_forecast_mode_check
  check (forecast_mode in ('shadow', 'canary', 'production'));

alter table public.lotto_training_runs
  add column if not exists experiment_run_id uuid references public.lai_experiment_runs(id);

alter table public.lotto_model_scores
  add column if not exists source_revision text not null default 'original',
  add column if not exists is_valid boolean not null default true,
  add column if not exists invalidated_at timestamptz,
  add column if not exists supersedes_score_id uuid references public.lotto_model_scores(id);

alter table public.lotto_model_scores
  drop constraint if exists lotto_model_scores_forecast_id_draw_id_key;
create unique index if not exists lotto_model_scores_one_valid_forecast_draw_idx
  on public.lotto_model_scores (forecast_id, draw_id)
  where is_valid = true;

-- The inherited activation function rejects algorithm_version <> 'lai-v2', so v3
-- experiment rows cannot bypass the existing LAI v2 training activation gate.

create unique index if not exists lai_model_registry_one_uniform_baseline_idx
  on public.lai_model_registry (game_name, model_family)
  where model_family = 'uniform-null' and status = 'baseline';
create unique index if not exists lai_model_registry_one_active_family_idx
  on public.lai_model_registry (game_name, model_family)
  where status in ('canary', 'champion');

create index if not exists lai_model_registry_game_name_status_idx
  on public.lai_model_registry (game_name, status);
create index if not exists lai_promotion_decisions_registry_id_decided_at_idx
  on public.lai_promotion_decisions (registry_id, decided_at);
create index if not exists lai_evidence_snapshots_game_name_target_draw_date_idx
  on public.lai_evidence_snapshots (game_name, target_draw_date);

drop trigger if exists set_lai_model_registry_updated_at on public.lai_model_registry;
create trigger set_lai_model_registry_updated_at
before update on public.lai_model_registry
for each row execute function public.set_updated_at();

drop trigger if exists set_lai_experiment_runs_updated_at on public.lai_experiment_runs;
create trigger set_lai_experiment_runs_updated_at
before update on public.lai_experiment_runs
for each row execute function public.set_updated_at();

create or replace function public.protect_lai_model_registry_update()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if (to_jsonb(new) - 'status' - 'status_reason' - 'updated_at')
      is distinct from (to_jsonb(old) - 'status' - 'status_reason' - 'updated_at') then
    raise exception 'lai_model_registry permits only status, status_reason, and updated_at changes';
  end if;
  return new;
end;
$$;

drop trigger if exists protect_lai_model_registry_update on public.lai_model_registry;
create trigger protect_lai_model_registry_update
before update on public.lai_model_registry
for each row execute function public.protect_lai_model_registry_update();

create or replace function public.protect_completed_lai_experiment_run()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.status = 'completed' and (
    new.registry_id is distinct from old.registry_id
    or new.game_name is distinct from old.game_name
    or new.data_cutoff is distinct from old.data_cutoff
    or new.random_seed is distinct from old.random_seed
    or new.code_commit is distinct from old.code_commit
    or new.feature_version is distinct from old.feature_version
    or new.replay_digest is distinct from old.replay_digest
  ) then
    raise exception 'completed lai_experiment_runs are immutable for model, cutoff, seed, commit, feature, and digest';
  end if;
  return new;
end;
$$;

drop trigger if exists protect_completed_lai_experiment_run on public.lai_experiment_runs;
create trigger protect_completed_lai_experiment_run
before update on public.lai_experiment_runs
for each row execute function public.protect_completed_lai_experiment_run();

create or replace function public.prevent_lai_evidence_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception '% rows are immutable', tg_table_name;
end;
$$;

drop trigger if exists prevent_lai_promotion_decisions_mutation on public.lai_promotion_decisions;
create trigger prevent_lai_promotion_decisions_mutation
before update or delete on public.lai_promotion_decisions
for each row execute function public.prevent_lai_evidence_mutation();

drop trigger if exists prevent_lai_evidence_snapshots_mutation on public.lai_evidence_snapshots;
create trigger prevent_lai_evidence_snapshots_mutation
before update or delete on public.lai_evidence_snapshots
for each row execute function public.prevent_lai_evidence_mutation();

drop trigger if exists prevent_lai_evidence_corrections_mutation on public.lai_evidence_corrections;
create trigger prevent_lai_evidence_corrections_mutation
before update or delete on public.lai_evidence_corrections
for each row execute function public.prevent_lai_evidence_mutation();

alter table public.lai_model_registry enable row level security;
alter table public.lai_experiment_runs enable row level security;
alter table public.lai_promotion_decisions enable row level security;
alter table public.lai_evidence_snapshots enable row level security;
alter table public.lai_evidence_corrections enable row level security;

revoke all on table public.lai_model_registry from public;
revoke all on table public.lai_model_registry from anon;
revoke all on table public.lai_model_registry from authenticated;
grant all on table public.lai_model_registry to service_role;
revoke all on table public.lai_experiment_runs from public;
revoke all on table public.lai_experiment_runs from anon;
revoke all on table public.lai_experiment_runs from authenticated;
grant all on table public.lai_experiment_runs to service_role;
revoke all on table public.lai_promotion_decisions from public;
revoke all on table public.lai_promotion_decisions from anon;
revoke all on table public.lai_promotion_decisions from authenticated;
grant all on table public.lai_promotion_decisions to service_role;
revoke all on table public.lai_evidence_snapshots from public;
revoke all on table public.lai_evidence_snapshots from anon;
revoke all on table public.lai_evidence_snapshots from authenticated;
grant all on table public.lai_evidence_snapshots to service_role;
revoke all on table public.lai_evidence_corrections from public;
revoke all on table public.lai_evidence_corrections from anon;
revoke all on table public.lai_evidence_corrections from authenticated;
grant all on table public.lai_evidence_corrections to service_role;

create or replace function public.record_lai_v3_decision(p_decision jsonb)
returns public.lai_promotion_decisions
language plpgsql
security definer
set search_path = public
as $$
declare
  registry_row public.lai_model_registry;
  decision_row public.lai_promotion_decisions;
begin
  if jsonb_typeof(p_decision) <> 'object'
    or nullif(p_decision->>'registry_id', '') is null
    or nullif(p_decision->>'game_name', '') is null
    or nullif(p_decision->>'from_status', '') is null
    or nullif(p_decision->>'decision', '') is null
    or nullif(p_decision->>'to_status', '') is null
    or nullif(p_decision->>'gate_version', '') is null
    or jsonb_typeof(p_decision->'evidence') <> 'object'
    or nullif(p_decision->>'evidence_digest', '') is null
    or nullif(p_decision->>'reason', '') is null then
    raise exception 'record_lai_v3_decision requires complete decision evidence';
  end if;

  select * into registry_row
  from public.lai_model_registry
  where id = (p_decision->>'registry_id')::uuid
  for update;

  if registry_row.id is null then
    raise exception 'LAI v3 model registry row was not found';
  end if;
  if registry_row.game_name <> p_decision->>'game_name' then
    raise exception 'decision game does not match registry game';
  end if;
  if registry_row.status <> p_decision->>'from_status' then
    raise exception 'decision from_status does not match registry status';
  end if;

  insert into public.lai_promotion_decisions (
    registry_id, game_name, from_status, decision, to_status,
    gate_version, evidence, evidence_digest, reason
  ) values (
    registry_row.id, registry_row.game_name, registry_row.status,
    p_decision->>'decision', p_decision->>'to_status',
    p_decision->>'gate_version', p_decision->'evidence',
    p_decision->>'evidence_digest', p_decision->>'reason'
  ) returning * into decision_row;

  update public.lai_model_registry
  set status = decision_row.to_status,
      status_reason = decision_row.reason,
      updated_at = now()
  where id = registry_row.id;

  return decision_row;
end;
$$;

create or replace function public.activate_lai_v3_state(p_decision_id uuid, p_state jsonb)
returns public.lotto_agent_states
language plpgsql
security definer
set search_path = public
as $$
declare
  decision_row public.lai_promotion_decisions;
  registry_row public.lai_model_registry;
  challenger_weight numeric;
  activated public.lotto_agent_states;
begin
  select decisions, registries
  into decision_row, registry_row
  from public.lai_promotion_decisions as decisions
  join public.lai_model_registry as registries on registries.id = decisions.registry_id
  where decisions.id = p_decision_id
  for update of decisions, registries;

  if decision_row.id is null then
    raise exception 'LAI v3 promotion decision was not found';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(decision_row.game_name, 0));

  if decision_row.decision <> 'promote'
     or decision_row.to_status not in ('canary', 'champion') then
    raise exception 'decision does not authorize activation';
  end if;
  if p_state->>'game_name' <> decision_row.game_name then
    raise exception 'agent state game does not match decision';
  end if;
  if p_state->>'champion_model' <> registry_row.model_name then
    raise exception 'agent state champion_model does not match decision registry';
  end if;

  challenger_weight := coalesce(
    (p_state->'expert_weights'->>registry_row.model_name)::numeric,
    0
  );
  if challenger_weight < 0 then
    raise exception 'challenger weight must be non-negative';
  end if;
  if decision_row.to_status = 'canary' and challenger_weight > 0.10 then
    raise exception 'challenger_weight > 0.10';
  end if;

  if p_state #>> '{metrics,promotion_stage}' <> decision_row.to_status then
    raise exception 'agent state promotion_stage does not match decision';
  end if;

  if decision_row.to_status = 'canary'
     and p_state->>'status' not in ('baseline', 'champion', 'degraded') then
    raise exception 'canary must preserve the existing lotto_agent_states status contract';
  end if;

  select public.activate_lotto_agent_state(p_state) into activated;
  return activated;
end;
$$;

create or replace function public.record_lai_v3_correction(p_correction jsonb)
returns public.lai_evidence_corrections
language plpgsql
security definer
set search_path = public
as $$
declare
  invalidated_count integer := 0;
  replacement_count integer := 0;
  requested_invalidations integer := 0;
  requested_replacements integer := 0;
  correction_row public.lai_evidence_corrections;
begin
  if jsonb_typeof(p_correction) <> 'object'
    or nullif(p_correction->>'game_name', '') is null
    or nullif(p_correction->>'draw_id', '') is null
    or nullif(p_correction->>'previous_revision', '') is null
    or nullif(p_correction->>'corrected_revision', '') is null
    or jsonb_typeof(p_correction->'previous_draw') <> 'object'
    or jsonb_typeof(p_correction->'corrected_draw') <> 'object'
    or jsonb_typeof(p_correction->'invalidated_score_ids') <> 'array'
    or jsonb_typeof(p_correction->'replacement_score_ids') <> 'array'
    or nullif(p_correction->>'reason', '') is null then
    raise exception 'record_lai_v3_correction requires complete correction evidence';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_correction->>'game_name', 0));

  select count(*)::integer, count(distinct score_id)::integer
  into requested_invalidations, invalidated_count
  from jsonb_array_elements_text(p_correction->'invalidated_score_ids') as ids(score_id);
  if requested_invalidations <> invalidated_count then
    raise exception 'invalidated_score_ids must not contain duplicates';
  end if;

  update public.lotto_model_scores as scores
  set is_valid = false, invalidated_at = now()
  where scores.id in (
    select score_id::uuid
    from jsonb_array_elements_text(p_correction->'invalidated_score_ids') as ids(score_id)
  )
    and scores.game_name = p_correction->>'game_name'
    and scores.draw_id = p_correction->>'draw_id'
    and scores.source_revision = p_correction->>'previous_revision'
    and scores.is_valid = true;
  get diagnostics invalidated_count = row_count;
  if invalidated_count <> requested_invalidations then
    raise exception 'correction must invalidate each requested valid score';
  end if;

  select count(*)::integer, count(distinct score_id)::integer
  into requested_replacements, replacement_count
  from jsonb_array_elements_text(p_correction->'replacement_score_ids') as ids(score_id);
  if requested_replacements <> replacement_count then
    raise exception 'replacement_score_ids must not contain duplicates';
  end if;

  select count(*)::integer into replacement_count
  from public.lotto_model_scores as scores
  where scores.id in (
    select score_id::uuid
    from jsonb_array_elements_text(p_correction->'replacement_score_ids') as ids(score_id)
  )
    and scores.game_name = p_correction->>'game_name'
    and scores.draw_id = p_correction->>'draw_id'
    and scores.source_revision = p_correction->>'corrected_revision'
    and scores.is_valid = true;
  if replacement_count <> requested_replacements then
    raise exception 'correction replacement scores must be valid and match the corrected revision';
  end if;

  insert into public.lai_evidence_corrections (
    game_name, draw_id, previous_revision, corrected_revision,
    previous_draw, corrected_draw, invalidated_score_ids,
    replacement_score_ids, reason
  ) values (
    p_correction->>'game_name', p_correction->>'draw_id',
    p_correction->>'previous_revision', p_correction->>'corrected_revision',
    p_correction->'previous_draw', p_correction->'corrected_draw',
    p_correction->'invalidated_score_ids', p_correction->'replacement_score_ids',
    p_correction->>'reason'
  ) returning * into correction_row;

  return correction_row;
end;
$$;

revoke all on function public.protect_lai_model_registry_update() from public, anon, authenticated;
revoke all on function public.protect_completed_lai_experiment_run() from public, anon, authenticated;
revoke all on function public.prevent_lai_evidence_mutation() from public, anon, authenticated;
revoke all on function public.record_lai_v3_decision(jsonb) from public, anon, authenticated;
grant execute on function public.record_lai_v3_decision(jsonb) to service_role;
revoke all on function public.activate_lai_v3_state(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.activate_lai_v3_state(uuid, jsonb) to service_role;
revoke all on function public.record_lai_v3_correction(jsonb) from public, anon, authenticated;
grant execute on function public.record_lai_v3_correction(jsonb) to service_role;
