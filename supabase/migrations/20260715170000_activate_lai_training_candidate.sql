create or replace function public.activate_lotto_training_candidate(p_run_id uuid)
returns public.lotto_agent_states
language plpgsql
security definer
set search_path = public
as $$
declare
  training_run public.lotto_training_runs;
  candidate_state jsonb;
  final_snapshot public.lotto_training_draw_snapshots;
  snapshot_count integer;
  mismatched_snapshot_count integer;
  activated public.lotto_agent_states;
begin
  select * into training_run
  from public.lotto_training_runs
  where id = p_run_id
  for update;

  if training_run.id is null then
    raise exception 'Training run % was not found', p_run_id;
  end if;
  if training_run.run_type <> 'walk_forward_initialization'
    or training_run.algorithm_version <> 'lai-v2' then
    raise exception 'Training run % is not an LAI v2 initialization run', p_run_id;
  end if;
  if training_run.status <> 'completed' or training_run.completed_at is null then
    raise exception 'Training run % is not completed', p_run_id;
  end if;
  if training_run.range_start <> 0 or training_run.range_end <= 0 then
    raise exception 'Training run % must cover a non-empty full-history range', p_run_id;
  end if;
  if training_run.checkpoint_cursor <> training_run.range_end then
    raise exception 'Training run % checkpoint has not reached range_end', p_run_id;
  end if;
  if coalesce(training_run.summary #>> '{snapshot,frozen}', 'false') <> 'true'
    or coalesce((training_run.summary #>> '{snapshot,draw_count}')::integer, -1) <> training_run.range_end then
    raise exception 'Training run % does not have a complete immutable snapshot', p_run_id;
  end if;

  candidate_state := training_run.summary->'state';
  if jsonb_typeof(candidate_state) <> 'object'
    or candidate_state->>'game_name' is distinct from training_run.game_name
    or candidate_state->>'status' is null
    or candidate_state->>'status' not in ('baseline', 'champion', 'degraded')
    or nullif(candidate_state->>'champion_model', '') is null
    or jsonb_typeof(candidate_state->'expert_weights') <> 'object'
    or jsonb_typeof(candidate_state->'learning_config') <> 'object'
    or jsonb_typeof(candidate_state->'metrics') <> 'object' then
    raise exception 'Training run % candidate state is malformed', p_run_id;
  end if;
  if coalesce((candidate_state->>'state_version')::bigint, -1) <> training_run.range_end
    or coalesce((candidate_state #>> '{metrics,evaluated_draws}')::integer, -1) <> training_run.range_end then
    raise exception 'Training run % candidate counters do not match range_end', p_run_id;
  end if;

  select
    count(*)::integer,
    (count(*) filter (where game_name is distinct from training_run.game_name))::integer
  into snapshot_count, mismatched_snapshot_count
  from public.lotto_training_draw_snapshots
  where run_id = p_run_id;

  select * into final_snapshot
  from public.lotto_training_draw_snapshots
  where run_id = p_run_id
  order by sequence_no desc
  limit 1;

  if snapshot_count <> training_run.range_end
    or final_snapshot.sequence_no <> training_run.range_end - 1 then
    raise exception 'Training run % snapshot sequence is incomplete', p_run_id;
  end if;
  if mismatched_snapshot_count <> 0 then
    raise exception 'Training run % snapshot contains a different game', p_run_id;
  end if;
  if candidate_state->>'last_learned_draw_id' is distinct from final_snapshot.draw_id
    or candidate_state->>'last_learned_draw_date' is distinct from final_snapshot.draw_date::text then
    raise exception 'Training run % candidate checkpoint does not match its snapshot', p_run_id;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(training_run.game_name, 0));

  if exists (
    select 1 from public.lotto_agent_states
    where game_name = training_run.game_name
  ) then
    raise exception 'Training seed refused: % already has agent state history', training_run.game_name;
  end if;
  if exists (
    select 1 from public.lotto_learning_claims
    where game_name = training_run.game_name
  ) then
    raise exception 'Training seed refused: % already has ordered learning claims', training_run.game_name;
  end if;

  insert into public.lotto_agent_states (
    game_name, state_version, status, champion_model, expert_weights,
    learning_config, metrics, last_learned_draw_id, last_learned_draw_date,
    is_active, activated_at
  ) values (
    training_run.game_name,
    (candidate_state->>'state_version')::bigint,
    candidate_state->>'status',
    candidate_state->>'champion_model',
    candidate_state->'expert_weights',
    candidate_state->'learning_config',
    candidate_state->'metrics' || jsonb_build_object(
      'training_seed_run_id', p_run_id,
      'training_snapshot_draw_count', snapshot_count,
      'training_seeded_at', now()
    ),
    final_snapshot.draw_id,
    final_snapshot.draw_date,
    true, now()
  )
  returning * into activated;

  update public.lotto_training_runs
  set summary = jsonb_set(
    summary,
    '{production_seed}',
    jsonb_build_object(
      'agent_state_id', activated.id,
      'state_version', activated.state_version,
      'activated_at', activated.activated_at
    ),
    true
  )
  where id = p_run_id;

  return activated;
end;
$$;

revoke all on function public.activate_lotto_training_candidate(uuid) from public;
revoke all on function public.activate_lotto_training_candidate(uuid) from anon;
revoke all on function public.activate_lotto_training_candidate(uuid) from authenticated;
grant execute on function public.activate_lotto_training_candidate(uuid) to service_role;
