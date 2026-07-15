create table if not exists public.lotto_training_draw_snapshots (
  run_id uuid not null references public.lotto_training_runs(id) on delete cascade,
  sequence_no integer not null check (sequence_no >= 0),
  game_name text not null,
  draw_id text not null,
  draw_date date not null,
  numbers integer[] not null,
  special_number integer,
  created_at timestamptz not null default now(),
  primary key (run_id, sequence_no),
  unique (run_id, draw_id)
);

create index if not exists lotto_training_draw_snapshots_run_date_idx
  on public.lotto_training_draw_snapshots (run_id, draw_date, draw_id);

alter table public.lotto_training_draw_snapshots enable row level security;

create or replace function public.initialize_lotto_training_snapshot(p_run_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  training_run public.lotto_training_runs;
  snapshot_count integer;
begin
  select * into training_run
  from public.lotto_training_runs
  where id = p_run_id
  for update;

  if training_run.id is null then
    raise exception 'Training run % was not found', p_run_id;
  end if;
  if training_run.status not in ('queued', 'running') then
    raise exception 'Training run % cannot initialize a snapshot from status %', p_run_id, training_run.status;
  end if;

  select count(*)::integer into snapshot_count
  from public.lotto_training_draw_snapshots
  where run_id = p_run_id;

  if snapshot_count = 0 then
    insert into public.lotto_training_draw_snapshots (
      run_id, sequence_no, game_name, draw_id, draw_date, numbers, special_number
    )
    select
      p_run_id,
      row_number() over (order by draw_date, draw_id) - 1,
      game_name,
      draw_id,
      draw_date,
      numbers,
      special_number
    from public.lotto_draws
    where game_name = training_run.game_name
    order by draw_date, draw_id
    limit training_run.range_end;

    select count(*)::integer into snapshot_count
    from public.lotto_training_draw_snapshots
    where run_id = p_run_id;
  end if;

  if snapshot_count <> training_run.range_end then
    raise exception 'Training snapshot count % does not match range_end % for run %',
      snapshot_count, training_run.range_end, p_run_id;
  end if;

  return snapshot_count;
end;
$$;

revoke all on function public.initialize_lotto_training_snapshot(uuid) from public;
revoke all on function public.initialize_lotto_training_snapshot(uuid) from anon;
revoke all on function public.initialize_lotto_training_snapshot(uuid) from authenticated;
grant execute on function public.initialize_lotto_training_snapshot(uuid) to service_role;

revoke all on table public.lotto_training_draw_snapshots from anon;
revoke all on table public.lotto_training_draw_snapshots from authenticated;
grant select, insert, update, delete on table public.lotto_training_draw_snapshots to service_role;
