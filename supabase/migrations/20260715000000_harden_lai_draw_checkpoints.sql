with ranked_checkpoints as (
  select
    id,
    row_number() over (
      partition by game_name, last_learned_draw_id
      order by
        is_active desc,
        activated_at desc nulls last,
        state_version desc,
        id desc
    ) as checkpoint_rank
  from public.lotto_agent_states
  where last_learned_draw_id is not null
)
update public.lotto_agent_states as states
set
  last_learned_draw_id = null,
  last_learned_draw_date = null
from ranked_checkpoints as ranked
where states.id = ranked.id
  and ranked.checkpoint_rank > 1;

create unique index if not exists lotto_agent_states_game_draw_checkpoint_idx
  on public.lotto_agent_states (game_name, last_learned_draw_id)
  where last_learned_draw_id is not null;

create or replace function public.activate_lotto_agent_state(p_state jsonb)
returns public.lotto_agent_states
language plpgsql
security definer
set search_path = public
as $$
declare
  activated public.lotto_agent_states;
  historical_checkpoint public.lotto_agent_states;
  incoming_game_name text := nullif(p_state->>'game_name', '');
  incoming_draw_id text := nullif(p_state->>'last_learned_draw_id', '');
  incoming_draw_date date := nullif(p_state->>'last_learned_draw_date', '')::date;
  incoming_state_version bigint := nullif(p_state->>'state_version', '')::bigint;
begin
  if incoming_game_name is null
    or incoming_draw_id is null
    or incoming_draw_date is null
    or incoming_state_version is null then
    raise exception 'activate_lotto_agent_state requires game, draw checkpoint, date, and state version';
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
    if activated.id is not null then
      return activated;
    end if;
    return historical_checkpoint;
  end if;

  if activated.id is not null and (
    incoming_draw_date < activated.last_learned_draw_date
    or incoming_state_version <= activated.state_version
  ) then
    return activated;
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

  return activated;
end;
$$;

revoke all on function public.activate_lotto_agent_state(jsonb) from public;
grant execute on function public.activate_lotto_agent_state(jsonb) to service_role;
