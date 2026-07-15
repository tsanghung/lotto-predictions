create table if not exists public.lotto_learning_claims (
  game_name text not null,
  draw_id text not null,
  draw_date date not null,
  prediction_source_key text not null,
  claim_token uuid not null,
  status text not null check (status in ('claimed', 'learned')),
  claimed_at timestamptz not null default now(),
  lease_expires_at timestamptz not null,
  learned_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (game_name, draw_id)
);

create index if not exists lotto_learning_claims_status_lease_idx
  on public.lotto_learning_claims (game_name, status, lease_expires_at);

alter table public.lotto_learning_claims enable row level security;

drop trigger if exists set_lotto_learning_claims_updated_at on public.lotto_learning_claims;
create trigger set_lotto_learning_claims_updated_at
before update on public.lotto_learning_claims
for each row execute function public.set_updated_at();

create table if not exists public.lotto_learning_recoveries (
  id uuid primary key default gen_random_uuid(),
  game_name text not null,
  requested_draw_id text not null,
  replay_from_date date not null,
  replay_through_date date not null,
  removed_checkpoints jsonb not null default '[]'::jsonb,
  removed_score_count integer not null default 0,
  requeued_prediction_count integer not null default 0,
  created_at timestamptz not null default now()
);

alter table public.lotto_learning_recoveries enable row level security;
create or replace function public.claim_next_lai_learning(
  p_game_name text,
  p_draw_id text,
  p_draw_date date,
  p_source_key text,
  p_lease_seconds integer default 120
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  checkpoint public.lotto_agent_states;
  existing_claim public.lotto_learning_claims;
  earliest record;
  next_token uuid;
begin
  if nullif(p_game_name, '') is null
    or nullif(p_draw_id, '') is null
    or p_draw_date is null
    or nullif(p_source_key, '') is null then
    raise exception 'claim_next_lai_learning requires game, draw, date, and source key';
  end if;
  if p_lease_seconds < 15 or p_lease_seconds > 900 then
    raise exception 'claim_next_lai_learning lease must be between 15 and 900 seconds';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_game_name, 0));

  select * into checkpoint
  from public.lotto_agent_states
  where game_name = p_game_name
    and last_learned_draw_id = p_draw_id
  order by state_version desc
  limit 1;

  if found then
    insert into public.lotto_learning_claims (
      game_name, draw_id, draw_date, prediction_source_key, claim_token,
      status, claimed_at, lease_expires_at, learned_at
    ) values (
      p_game_name, p_draw_id, p_draw_date, p_source_key, gen_random_uuid(),
      'learned', now(), now(), now()
    )
    on conflict (game_name, draw_id) do update
    set status = 'learned', learned_at = coalesce(lotto_learning_claims.learned_at, now());

    return jsonb_build_object(
      'status', 'already_learned',
      'draw_id', p_draw_id,
      'claim_token', null
    );
  end if;

  select
    draws.draw_id,
    draws.draw_date,
    predictions.source_key
  into earliest
  from public.lotto_draws as draws
  join public.prediction_records as predictions
    on predictions.game_name = draws.game_name
   and predictions.target_draw_date = draws.draw_date
  where draws.game_name = p_game_name
    and predictions.is_evaluated = false
    and exists (
      select 1
      from public.lotto_model_forecasts as forecasts
      where forecasts.game_name = draws.game_name
        and forecasts.target_draw_date = draws.draw_date
    )
    and not exists (
      select 1
      from public.lotto_agent_states as states
      where states.game_name = draws.game_name
        and states.last_learned_draw_id = draws.draw_id
    )
  order by draws.draw_date asc, draws.draw_id asc, predictions.source_key asc
  limit 1;

  if earliest.draw_id is null then
    return jsonb_build_object(
      'status', 'not_eligible',
      'draw_id', p_draw_id,
      'claim_token', null
    );
  end if;

  if earliest.draw_id = p_draw_id and earliest.draw_date <> p_draw_date then
    raise exception 'claim_next_lai_learning draw date does not match durable draw';
  end if;
  if earliest.draw_id <> p_draw_id then
    return jsonb_build_object(
      'status', 'deferred_earlier_draw',
      'draw_id', p_draw_id,
      'blocking_draw_id', earliest.draw_id,
      'blocking_draw_date', earliest.draw_date,
      'claim_token', null
    );
  end if;

  select * into existing_claim
  from public.lotto_learning_claims
  where game_name = p_game_name
    and draw_id = p_draw_id
  for update;

  if found
    and existing_claim.status = 'claimed'
    and existing_claim.lease_expires_at > now()
    and existing_claim.prediction_source_key <> p_source_key then
    return jsonb_build_object(
      'status', 'in_progress',
      'draw_id', p_draw_id,
      'claim_token', null,
      'lease_expires_at', existing_claim.lease_expires_at
    );
  end if;

  if found
    and existing_claim.status = 'claimed'
    and existing_claim.lease_expires_at > now()
    and existing_claim.prediction_source_key = p_source_key then
    return jsonb_build_object(
      'status', 'claimed',
      'draw_id', p_draw_id,
      'claim_token', existing_claim.claim_token,
      'lease_expires_at', existing_claim.lease_expires_at
    );
  end if;

  if found
    and existing_claim.status = 'claimed'
    and existing_claim.lease_expires_at <= now() then
    next_token := gen_random_uuid();
  else
    next_token := gen_random_uuid();
  end if;

  insert into public.lotto_learning_claims (
    game_name, draw_id, draw_date, prediction_source_key, claim_token,
    status, claimed_at, lease_expires_at, learned_at
  ) values (
    p_game_name, p_draw_id, p_draw_date, p_source_key, next_token,
    'claimed', now(), now() + make_interval(secs => p_lease_seconds), null
  )
  on conflict (game_name, draw_id) do update
  set
    draw_date = excluded.draw_date,
    prediction_source_key = excluded.prediction_source_key,
    claim_token = excluded.claim_token,
    status = 'claimed',
    claimed_at = excluded.claimed_at,
    lease_expires_at = excluded.lease_expires_at,
    learned_at = null;

  return jsonb_build_object(
    'status', 'claimed',
    'draw_id', p_draw_id,
    'claim_token', next_token,
    'lease_expires_at', now() + make_interval(secs => p_lease_seconds)
  );
end;
$$;

create or replace function public.recover_lai_learning_order(
  p_game_name text,
  p_draw_id text,
  p_draw_date date
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  checkpoint public.lotto_agent_states;
  active_state public.lotto_agent_states;
  earliest record;
  replay_through date;
  removed_checkpoints jsonb := '[]'::jsonb;
  removed_scores integer := 0;
  requeued_predictions integer := 0;
begin
  if nullif(p_game_name, '') is null
    or nullif(p_draw_id, '') is null
    or p_draw_date is null then
    raise exception 'recover_lai_learning_order requires game, draw, and date';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_game_name, 0));

  select * into checkpoint
  from public.lotto_agent_states
  where game_name = p_game_name
    and last_learned_draw_id = p_draw_id
  order by state_version desc
  limit 1;

  if found then
    return jsonb_build_object('status', 'already_learned', 'draw_id', p_draw_id);
  end if;

  select
    draws.draw_id,
    draws.draw_date
  into earliest
  from public.lotto_draws as draws
  join public.prediction_records as predictions
    on predictions.game_name = draws.game_name
   and predictions.target_draw_date = draws.draw_date
  where draws.game_name = p_game_name
    and predictions.is_evaluated = false
    and exists (
      select 1
      from public.lotto_model_forecasts as forecasts
      where forecasts.game_name = draws.game_name
        and forecasts.target_draw_date = draws.draw_date
    )
    and not exists (
      select 1
      from public.lotto_agent_states as states
      where states.game_name = draws.game_name
        and states.last_learned_draw_id = draws.draw_id
    )
  order by draws.draw_date asc, draws.draw_id asc, predictions.source_key asc
  limit 1;

  if earliest.draw_id is null then
    return jsonb_build_object('status', 'not_eligible', 'draw_id', p_draw_id);
  end if;
  if earliest.draw_id = p_draw_id and earliest.draw_date <> p_draw_date then
    raise exception 'recover_lai_learning_order draw date does not match durable draw';
  end if;
  if earliest.draw_id <> p_draw_id then
    return jsonb_build_object(
      'status', 'deferred_earlier_draw',
      'draw_id', p_draw_id,
      'blocking_draw_id', earliest.draw_id
    );
  end if;

  select * into active_state
  from public.lotto_agent_states
  where game_name = p_game_name
    and is_active
  for update;

  if active_state.id is null
    or active_state.last_learned_draw_date is null
    or active_state.last_learned_draw_date < p_draw_date then
    return jsonb_build_object('status', 'not_needed', 'draw_id', p_draw_id);
  end if;

  select
    max(last_learned_draw_date),
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'draw_id', last_learned_draw_id,
          'draw_date', last_learned_draw_date,
          'state_version', state_version
        ) order by last_learned_draw_date, state_version
      ),
      '[]'::jsonb
    )
  into replay_through, removed_checkpoints
  from public.lotto_agent_states
  where game_name = p_game_name
    and last_learned_draw_date >= p_draw_date;

  if replay_through is null then
    return jsonb_build_object('status', 'not_needed', 'draw_id', p_draw_id);
  end if;

  update public.prediction_records
  set is_evaluated = false, evaluation = null
  where game_name = p_game_name
    and target_draw_date between p_draw_date and replay_through;
  get diagnostics requeued_predictions = row_count;

  delete from public.lotto_model_scores
  where game_name = p_game_name
    and draw_date between p_draw_date and replay_through;
  get diagnostics removed_scores = row_count;

  delete from public.lotto_learning_claims
  where game_name = p_game_name
    and draw_date >= p_draw_date;

  delete from public.lotto_agent_states
  where game_name = p_game_name
    and last_learned_draw_date >= p_draw_date;

  update public.lotto_agent_states
  set is_active = true, activated_at = now()
  where id = (
    select id
    from public.lotto_agent_states
    where game_name = p_game_name
    order by state_version desc
    limit 1
  );

  insert into public.lotto_learning_recoveries (
    game_name, requested_draw_id, replay_from_date, replay_through_date,
    removed_checkpoints, removed_score_count, requeued_prediction_count
  ) values (
    p_game_name, p_draw_id, p_draw_date, replay_through,
    removed_checkpoints, removed_scores, requeued_predictions
  );

  return jsonb_build_object(
    'status', 'rewound',
    'draw_id', p_draw_id,
    'replay_from_date', p_draw_date,
    'replay_through_date', replay_through,
    'removed_score_count', removed_scores,
    'requeued_prediction_count', requeued_predictions
  );
end;
$$;
create or replace function public.activate_lotto_agent_state(p_state jsonb)
returns public.lotto_agent_states
language plpgsql
security definer
set search_path = public
as $$
declare
  activated public.lotto_agent_states;
  historical_checkpoint public.lotto_agent_states;
  learning_claim public.lotto_learning_claims;
  earliest record;
  incoming_game_name text := nullif(p_state->>'game_name', '');
  incoming_draw_id text := nullif(p_state->>'last_learned_draw_id', '');
  incoming_draw_date date := nullif(p_state->>'last_learned_draw_date', '')::date;
  incoming_state_version bigint := nullif(p_state->>'state_version', '')::bigint;
  incoming_claim_token uuid := nullif(p_state->>'learning_claim_token', '')::uuid;
  completed_claims integer := 0;
begin
  if incoming_game_name is null
    or incoming_draw_id is null
    or incoming_draw_date is null
    or incoming_state_version is null
    or incoming_claim_token is null then
    raise exception 'activate_lotto_agent_state requires game, draw checkpoint, date, state version, and learning_claim_token';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(incoming_game_name, 0));

  select * into activated
  from public.lotto_agent_states
  where game_name = incoming_game_name
    and is_active
  for update;

  select * into historical_checkpoint
  from public.lotto_agent_states
  where game_name = incoming_game_name
    and last_learned_draw_id = incoming_draw_id
  order by is_active desc, state_version desc
  limit 1;

  if found then
    update public.lotto_learning_claims
    set status = 'learned', learned_at = coalesce(learned_at, now())
    where game_name = incoming_game_name
      and draw_id = incoming_draw_id;
    if activated.id is not null then
      return activated;
    end if;
    return historical_checkpoint;
  end if;

  select * into learning_claim
  from public.lotto_learning_claims
  where game_name = incoming_game_name
    and draw_id = incoming_draw_id
  for update;

  if not found
    or learning_claim.status <> 'claimed'
    or learning_claim.claim_token <> incoming_claim_token
    or learning_claim.lease_expires_at <= now() then
    raise exception 'activate_lotto_agent_state requires a live ordered learning claim';
  end if;

  select
    draws.draw_id,
    draws.draw_date
  into earliest
  from public.lotto_draws as draws
  join public.prediction_records as predictions
    on predictions.game_name = draws.game_name
   and predictions.target_draw_date = draws.draw_date
  where draws.game_name = incoming_game_name
    and predictions.is_evaluated = false
    and exists (
      select 1
      from public.lotto_model_forecasts as forecasts
      where forecasts.game_name = draws.game_name
        and forecasts.target_draw_date = draws.draw_date
    )
    and not exists (
      select 1
      from public.lotto_agent_states as states
      where states.game_name = draws.game_name
        and states.last_learned_draw_id = draws.draw_id
    )
  order by draws.draw_date asc, draws.draw_id asc, predictions.source_key asc
  limit 1;

  if earliest.draw_id is null
    or earliest.draw_id <> incoming_draw_id
    or earliest.draw_date <> incoming_draw_date then
    raise exception 'activate_lotto_agent_state learning order changed before activation';
  end if;

  if activated.id is not null and (
    incoming_draw_date < activated.last_learned_draw_date
    or incoming_state_version <= activated.state_version
  ) then
    raise exception 'activate_lotto_agent_state rejected stale or non-incrementing ordered state';
  end if;

  update public.lotto_agent_states
  set is_active = false
  where game_name = incoming_game_name
    and is_active;

  insert into public.lotto_agent_states (
    game_name, state_version, status, champion_model, expert_weights,
    learning_config, metrics, last_learned_draw_id, last_learned_draw_date,
    is_active, activated_at
  ) values (
    incoming_game_name,
    incoming_state_version,
    p_state->>'status',
    p_state->>'champion_model',
    p_state->'expert_weights',
    p_state->'learning_config',
    coalesce(p_state->'metrics', '{}'::jsonb),
    incoming_draw_id,
    incoming_draw_date,
    true,
    now()
  )
  returning * into activated;

  update public.lotto_learning_claims
  set status = 'learned', learned_at = now(), lease_expires_at = now()
  where game_name = incoming_game_name
    and draw_id = incoming_draw_id
    and claim_token = incoming_claim_token;
  get diagnostics completed_claims = row_count;
  if completed_claims <> 1 then
    raise exception 'activate_lotto_agent_state failed to complete ordered learning claim';
  end if;

  return activated;
end;
$$;

revoke all on function public.recover_lai_learning_order(text, text, date) from public;
grant execute on function public.recover_lai_learning_order(text, text, date) to service_role;
revoke all on function public.claim_next_lai_learning(text, text, date, text, integer) from public;
grant execute on function public.claim_next_lai_learning(text, text, date, text, integer) to service_role;
revoke all on function public.activate_lotto_agent_state(jsonb) from public;
grant execute on function public.activate_lotto_agent_state(jsonb) to service_role;
