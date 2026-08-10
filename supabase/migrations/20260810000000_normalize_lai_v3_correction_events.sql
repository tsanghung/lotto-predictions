alter table public.lai_evidence_corrections
  add column if not exists event_key text,
  add column if not exists event_payload jsonb;

update public.lai_evidence_corrections
set event_key = 'legacy:' || id::text
where event_key is null or pg_catalog.btrim(event_key) = '';

update public.lai_evidence_corrections
set event_payload = pg_catalog.jsonb_build_object(
  'event_key', event_key,
  'game_name', game_name,
  'draw_id', draw_id,
  'previous_revision', previous_revision,
  'corrected_revision', corrected_revision,
  'previous_draw', previous_draw,
  'corrected_draw', corrected_draw,
  'invalidated_score_ids', invalidated_score_ids,
  'replacement_score_ids', replacement_score_ids,
  'reason', reason,
  'legacy_backfill', true
)
where event_payload is null;

alter table public.lai_evidence_corrections
  drop constraint if exists lai_evidence_corrections_game_name_draw_id_corrected_revision_key;

alter table public.lai_evidence_corrections
  add constraint lai_evidence_corrections_event_key_nonempty
    check (pg_catalog.btrim(event_key) <> ''),
  add constraint lai_evidence_corrections_event_payload_object
    check (pg_catalog.jsonb_typeof(event_payload) = 'object'),
  alter column event_key set not null,
  alter column event_payload set not null,
  add constraint lai_evidence_corrections_event_identity_key
    unique (game_name, draw_id, previous_revision, corrected_revision, event_key);

revoke all on table public.lai_evidence_corrections from service_role;
grant select on table public.lai_evidence_corrections to service_role;

create or replace function public.record_lai_v3_correction(p_correction jsonb)
returns public.lai_evidence_corrections
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  invalidated_count integer := 0;
  requested_invalidations integer := 0;
  requested_replacements integer := 0;
  valid_replacements integer := 0;
  replacement_score_ids jsonb := '[]'::jsonb;
  correction_event_key text;
  canonical_event_payload jsonb;
  correction_row public.lai_evidence_corrections;
begin
  if pg_catalog.jsonb_typeof(p_correction) <> 'object'
    or pg_catalog.nullif(pg_catalog.btrim(p_correction->>'event_key'), '') is null
    or pg_catalog.nullif(p_correction->>'game_name', '') is null
    or pg_catalog.nullif(p_correction->>'draw_id', '') is null
    or pg_catalog.nullif(p_correction->>'previous_revision', '') is null
    or pg_catalog.nullif(p_correction->>'corrected_revision', '') is null
    or pg_catalog.jsonb_typeof(p_correction->'previous_draw') <> 'object'
    or pg_catalog.jsonb_typeof(p_correction->'corrected_draw') <> 'object'
    or pg_catalog.jsonb_typeof(p_correction->'invalidated_score_ids') <> 'array'
    or pg_catalog.jsonb_typeof(p_correction->'replacement_scores') <> 'array'
    or pg_catalog.nullif(p_correction->>'reason', '') is null then
    raise exception 'record_lai_v3_correction requires event_key, correction payloads, and evidence';
  end if;

  correction_event_key := pg_catalog.btrim(p_correction->>'event_key');
  canonical_event_payload := pg_catalog.jsonb_build_object(
    'event_key', correction_event_key,
    'game_name', p_correction->>'game_name',
    'draw_id', p_correction->>'draw_id',
    'previous_revision', p_correction->>'previous_revision',
    'corrected_revision', p_correction->>'corrected_revision',
    'previous_draw', p_correction->'previous_draw',
    'corrected_draw', p_correction->'corrected_draw',
    'invalidated_score_ids', p_correction->'invalidated_score_ids',
    'replacement_scores', p_correction->'replacement_scores',
    'reason', p_correction->>'reason'
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_correction->>'game_name', 0)
  );

  select * into correction_row
  from public.lai_evidence_corrections
  where game_name = p_correction->>'game_name'
    and draw_id = p_correction->>'draw_id'
    and previous_revision = p_correction->>'previous_revision'
    and corrected_revision = p_correction->>'corrected_revision'
    and event_key = correction_event_key;

  if correction_row.id is not null then
    if correction_row.event_payload is distinct from canonical_event_payload then
      raise exception 'correction event_key replay payload mismatch';
    end if;
    return correction_row;
  end if;

  select pg_catalog.count(*)::integer, pg_catalog.count(distinct score_id)::integer
  into requested_invalidations, invalidated_count
  from pg_catalog.jsonb_array_elements_text(p_correction->'invalidated_score_ids') as ids(score_id);
  if requested_invalidations = 0 or requested_invalidations <> invalidated_count then
    raise exception 'invalidated_score_ids must be a non-empty unique list';
  end if;
  requested_replacements := pg_catalog.jsonb_array_length(p_correction->'replacement_scores');
  if requested_replacements <> requested_invalidations then
    raise exception 'replacement_scores must match invalidated scores one-for-one';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_correction->'replacement_scores') as rows(score)
    where pg_catalog.jsonb_typeof(rows.score) <> 'object'
      or rows.score->>'game_name' is distinct from p_correction->>'game_name'
      or rows.score->>'draw_id' is distinct from p_correction->>'draw_id'
      or rows.score->>'source_revision' is distinct from p_correction->>'corrected_revision'
      or pg_catalog.nullif(rows.score->>'forecast_id', '') is null
      or pg_catalog.nullif(rows.score->>'draw_date', '') is null
      or pg_catalog.jsonb_typeof(rows.score->'metrics') <> 'object'
      or pg_catalog.nullif(rows.score->>'evaluator_version', '') is null
      or pg_catalog.nullif(rows.score->>'supersedes_score_id', '') is null
  ) then
    raise exception 'replacement_scores contain an invalid correction payload';
  end if;

  update public.lotto_model_scores as scores
  set is_valid = false, invalidated_at = pg_catalog.now()
  where scores.id in (
    select score_id::uuid
    from pg_catalog.jsonb_array_elements_text(p_correction->'invalidated_score_ids') as ids(score_id)
  )
    and scores.game_name = p_correction->>'game_name'
    and scores.draw_id = p_correction->>'draw_id'
    and scores.source_revision = p_correction->>'previous_revision'
    and scores.is_valid = true;
  get diagnostics invalidated_count = row_count;
  if invalidated_count <> requested_invalidations then
    raise exception 'correction must invalidate each requested valid score';
  end if;

  select pg_catalog.count(*)::integer into valid_replacements
  from pg_catalog.jsonb_array_elements(p_correction->'replacement_scores') as rows(score)
  join public.lotto_model_scores as superseded
    on superseded.id = (rows.score->>'supersedes_score_id')::uuid
   and superseded.id in (
     select score_id::uuid
     from pg_catalog.jsonb_array_elements_text(p_correction->'invalidated_score_ids') as ids(score_id)
   )
   and superseded.forecast_id = (rows.score->>'forecast_id')::uuid
   and superseded.game_name = p_correction->>'game_name'
   and superseded.draw_id = p_correction->>'draw_id'
   and superseded.source_revision = p_correction->>'previous_revision'
   and superseded.is_valid = false
   and superseded.invalidated_at is not null;
  if valid_replacements <> requested_replacements
    or valid_replacements <> (
      select pg_catalog.count(distinct rows.score->>'supersedes_score_id')::integer
      from pg_catalog.jsonb_array_elements(p_correction->'replacement_scores') as rows(score)
    ) then
    raise exception 'replacement_scores must supersede each invalidated score exactly once';
  end if;

  with inserted as (
    insert into public.lotto_model_scores (
      forecast_id, game_name, draw_id, draw_date, metrics,
      weight_before, weight_after, evaluator_version, source_revision,
      is_valid, invalidated_at, supersedes_score_id
    )
    select
      (rows.score->>'forecast_id')::uuid,
      rows.score->>'game_name',
      rows.score->>'draw_id',
      (rows.score->>'draw_date')::date,
      rows.score->'metrics',
      (rows.score->>'weight_before')::numeric,
      (rows.score->>'weight_after')::numeric,
      rows.score->>'evaluator_version',
      rows.score->>'source_revision',
      true,
      null,
      (rows.score->>'supersedes_score_id')::uuid
    from pg_catalog.jsonb_array_elements(p_correction->'replacement_scores') as rows(score)
    returning id
  )
  select pg_catalog.coalesce(
    pg_catalog.jsonb_agg(pg_catalog.to_jsonb(id) order by id),
    '[]'::jsonb
  ) into replacement_score_ids
  from inserted;

  insert into public.lai_evidence_corrections (
    game_name, draw_id, previous_revision, corrected_revision, event_key,
    previous_draw, corrected_draw, invalidated_score_ids,
    replacement_score_ids, reason, event_payload
  ) values (
    p_correction->>'game_name', p_correction->>'draw_id',
    p_correction->>'previous_revision', p_correction->>'corrected_revision',
    correction_event_key, p_correction->'previous_draw', p_correction->'corrected_draw',
    p_correction->'invalidated_score_ids', replacement_score_ids,
    p_correction->>'reason', canonical_event_payload
  ) returning * into correction_row;

  return correction_row;
end;
$$;

revoke all on function public.record_lai_v3_correction(jsonb) from public, anon, authenticated;
grant execute on function public.record_lai_v3_correction(jsonb) to service_role;
