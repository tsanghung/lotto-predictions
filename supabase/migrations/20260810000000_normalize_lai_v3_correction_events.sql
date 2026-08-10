alter table public.lai_evidence_corrections
  add column if not exists event_key text,
  add column if not exists event_payload jsonb;

do $migration$
declare
  correction_table oid := pg_catalog.to_regclass('public.lai_evidence_corrections');
  immutable_function oid := pg_catalog.to_regprocedure('public.prevent_lai_evidence_mutation()');
  immutable_trigger oid;
  immutable_trigger_function oid;
  immutable_trigger_type smallint;
  needs_backfill boolean := false;
begin
  if correction_table is null or immutable_function is null then
    raise exception 'correction event backfill requires the correction table and immutable trigger function';
  end if;

  select triggers.oid, triggers.tgfoid, triggers.tgtype
  into immutable_trigger, immutable_trigger_function, immutable_trigger_type
  from pg_catalog.pg_trigger as triggers
  where triggers.tgrelid = correction_table
    and triggers.tgname = 'prevent_lai_evidence_corrections_mutation'
    and not triggers.tgisinternal;

  if immutable_trigger is not null
    and (immutable_trigger_function is distinct from immutable_function
      or immutable_trigger_type is distinct from 27) then
    raise exception 'correction immutable trigger has an unexpected definition';
  end if;

  select exists (
    select 1
    from public.lai_evidence_corrections
    where event_key is null
      or pg_catalog.btrim(event_key) = ''
      or event_payload is null
  ) into needs_backfill;

  if needs_backfill then
    if immutable_trigger is not null then
      execute pg_catalog.format(
        'drop trigger %I on public.lai_evidence_corrections',
        'prevent_lai_evidence_corrections_mutation'
      );
      immutable_trigger := null;
    end if;

    update public.lai_evidence_corrections
    set event_key = coalesce(
          nullif(pg_catalog.btrim(event_key), ''),
          'legacy:' || id::text
        ),
        event_payload = case
          when event_payload is null or event_key is null or pg_catalog.btrim(event_key) = '' then
            pg_catalog.jsonb_build_object(
              'event_key', coalesce(
                nullif(pg_catalog.btrim(event_key), ''),
                'legacy:' || id::text
              ),
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
          else event_payload
        end
    where event_key is null
      or pg_catalog.btrim(event_key) = ''
      or event_payload is null;
  end if;

  if immutable_trigger is null then
    execute 'create trigger prevent_lai_evidence_corrections_mutation
      before update or delete on public.lai_evidence_corrections
      for each row execute function public.prevent_lai_evidence_mutation()';
  end if;
  execute 'alter table public.lai_evidence_corrections enable trigger prevent_lai_evidence_corrections_mutation';

  if exists (
    select 1
    from public.lai_evidence_corrections
    where event_key is null
      or pg_catalog.btrim(event_key) = ''
      or event_payload is null
      or pg_catalog.jsonb_typeof(event_payload) <> 'object'
  ) then
    raise exception 'correction event backfill did not establish complete event identities';
  end if;
end;
$migration$;

do $migration$
declare
  correction_table oid := pg_catalog.to_regclass('public.lai_evidence_corrections');
  game_name_attnum smallint;
  draw_id_attnum smallint;
  previous_revision_attnum smallint;
  corrected_revision_attnum smallint;
  event_key_attnum smallint;
  event_payload_attnum smallint;
  legacy_unique_attnums smallint[];
  event_identity_attnums smallint[];
  legacy_constraint_name text;
  legacy_constraint_count integer := 0;
  constraint_found boolean := false;
  constraint_type "char";
  constraint_columns smallint[];
  constraint_validated boolean;
  constraint_deferrable boolean;
  constraint_deferred boolean;
  constraint_definition text;
  event_key_not_null boolean := false;
  event_payload_not_null boolean := false;
  event_identity_count integer := 0;
begin
  if correction_table is null then
    raise exception 'correction event constraints require public.lai_evidence_corrections';
  end if;

  select attributes.attnum::smallint into game_name_attnum
  from pg_catalog.pg_attribute as attributes
  where attributes.attrelid = correction_table and attributes.attname = 'game_name' and not attributes.attisdropped;
  select attributes.attnum::smallint into draw_id_attnum
  from pg_catalog.pg_attribute as attributes
  where attributes.attrelid = correction_table and attributes.attname = 'draw_id' and not attributes.attisdropped;
  select attributes.attnum::smallint into previous_revision_attnum
  from pg_catalog.pg_attribute as attributes
  where attributes.attrelid = correction_table and attributes.attname = 'previous_revision' and not attributes.attisdropped;
  select attributes.attnum::smallint into corrected_revision_attnum
  from pg_catalog.pg_attribute as attributes
  where attributes.attrelid = correction_table and attributes.attname = 'corrected_revision' and not attributes.attisdropped;
  select attributes.attnum::smallint into event_key_attnum
  from pg_catalog.pg_attribute as attributes
  where attributes.attrelid = correction_table and attributes.attname = 'event_key' and not attributes.attisdropped;
  select attributes.attnum::smallint into event_payload_attnum
  from pg_catalog.pg_attribute as attributes
  where attributes.attrelid = correction_table and attributes.attname = 'event_payload' and not attributes.attisdropped;

  if game_name_attnum is null or draw_id_attnum is null
    or previous_revision_attnum is null or corrected_revision_attnum is null
    or event_key_attnum is null or event_payload_attnum is null then
    raise exception 'correction event constraint columns are incomplete';
  end if;

  legacy_unique_attnums := array[
    game_name_attnum, draw_id_attnum, corrected_revision_attnum
  ];
  event_identity_attnums := array[
    game_name_attnum, draw_id_attnum, previous_revision_attnum,
    corrected_revision_attnum, event_key_attnum
  ];

  for legacy_constraint_name in
    select constraints.conname
    from pg_catalog.pg_constraint as constraints
    where constraints.conrelid = correction_table
      and constraints.contype = 'u'
      and constraints.conkey = legacy_unique_attnums
  loop
    legacy_constraint_count := legacy_constraint_count + 1;
    if legacy_constraint_count > 1 then
      raise exception 'multiple legacy correction unique constraints matched the exact legacy columns';
    end if;
    execute pg_catalog.format('alter table public.lai_evidence_corrections drop constraint %I', legacy_constraint_name);
  end loop;

  if exists (
    select 1
    from pg_catalog.pg_constraint as constraints
    where constraints.conrelid = correction_table
      and constraints.contype = 'u'
      and constraints.conkey = legacy_unique_attnums
  ) then
    raise exception 'legacy correction unique constraint still exists after catalog drop';
  end if;

  select attributes.attnotnull into event_key_not_null
  from pg_catalog.pg_attribute as attributes
  where attributes.attrelid = correction_table and attributes.attnum = event_key_attnum;
  if not event_key_not_null then
    execute 'alter table public.lai_evidence_corrections alter column event_key set not null';
  end if;

  select attributes.attnotnull into event_payload_not_null
  from pg_catalog.pg_attribute as attributes
  where attributes.attrelid = correction_table and attributes.attnum = event_payload_attnum;
  if not event_payload_not_null then
    execute 'alter table public.lai_evidence_corrections alter column event_payload set not null';
  end if;

  constraint_found := false;
  select true, constraints.contype, constraints.conkey, constraints.convalidated,
         pg_catalog.pg_get_constraintdef(constraints.oid, true)
  into constraint_found, constraint_type, constraint_columns, constraint_validated, constraint_definition
  from pg_catalog.pg_constraint as constraints
  where constraints.conrelid = correction_table
    and constraints.conname = 'lai_evidence_corrections_event_key_nonempty';
  if constraint_found then
    if constraint_type <> 'c' or constraint_columns <> array[event_key_attnum]
      or pg_catalog.strpos(constraint_definition, 'btrim(event_key)') = 0
      or pg_catalog.strpos(constraint_definition, '<>') = 0 then
      raise exception 'lai_evidence_corrections_event_key_nonempty has an unexpected definition';
    end if;
    if not constraint_validated then
      execute 'alter table public.lai_evidence_corrections validate constraint lai_evidence_corrections_event_key_nonempty';
    end if;
  else
    execute 'alter table public.lai_evidence_corrections
      add constraint lai_evidence_corrections_event_key_nonempty
      check (pg_catalog.btrim(event_key) <> '''')';
  end if;

  constraint_found := false;
  select true, constraints.contype, constraints.conkey, constraints.convalidated,
         pg_catalog.pg_get_constraintdef(constraints.oid, true)
  into constraint_found, constraint_type, constraint_columns, constraint_validated, constraint_definition
  from pg_catalog.pg_constraint as constraints
  where constraints.conrelid = correction_table
    and constraints.conname = 'lai_evidence_corrections_event_payload_object';
  if constraint_found then
    if constraint_type <> 'c' or constraint_columns <> array[event_payload_attnum]
      or pg_catalog.strpos(constraint_definition, 'jsonb_typeof(event_payload)') = 0
      or pg_catalog.strpos(constraint_definition, '''object''') = 0 then
      raise exception 'lai_evidence_corrections_event_payload_object has an unexpected definition';
    end if;
    if not constraint_validated then
      execute 'alter table public.lai_evidence_corrections validate constraint lai_evidence_corrections_event_payload_object';
    end if;
  else
    execute 'alter table public.lai_evidence_corrections
      add constraint lai_evidence_corrections_event_payload_object
      check (pg_catalog.jsonb_typeof(event_payload) = ''object'')';
  end if;

  constraint_found := false;
  select true, constraints.contype, constraints.conkey,
         constraints.condeferrable, constraints.condeferred
  into constraint_found, constraint_type, constraint_columns,
       constraint_deferrable, constraint_deferred
  from pg_catalog.pg_constraint as constraints
  where constraints.conrelid = correction_table
    and constraints.conname = 'lai_evidence_corrections_event_identity_key';
  if constraint_found then
    if constraint_type <> 'u' or constraint_columns <> event_identity_attnums
      or constraint_deferrable or constraint_deferred then
      raise exception 'lai_evidence_corrections_event_identity_key has an unexpected definition';
    end if;
  else
    if exists (
      select 1
      from pg_catalog.pg_constraint as constraints
      where constraints.conrelid = correction_table
        and constraints.contype = 'u'
        and constraints.conkey = event_identity_attnums
    ) then
      raise exception 'event identity uniqueness exists under an unexpected constraint name';
    end if;
    execute 'alter table public.lai_evidence_corrections
      add constraint lai_evidence_corrections_event_identity_key
      unique (game_name, draw_id, previous_revision, corrected_revision, event_key)';
  end if;

  select pg_catalog.count(*)::integer into event_identity_count
  from pg_catalog.pg_constraint as constraints
  where constraints.conrelid = correction_table
    and constraints.contype = 'u'
    and constraints.conkey = event_identity_attnums;
  if event_identity_count <> 1 then
    raise exception 'event identity unique constraint count must equal one';
  end if;
end;
$migration$;

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
    or nullif(pg_catalog.btrim(p_correction->>'event_key'), '') is null
    or nullif(p_correction->>'game_name', '') is null
    or nullif(p_correction->>'draw_id', '') is null
    or nullif(p_correction->>'previous_revision', '') is null
    or nullif(p_correction->>'corrected_revision', '') is null
    or pg_catalog.jsonb_typeof(p_correction->'previous_draw') <> 'object'
    or pg_catalog.jsonb_typeof(p_correction->'corrected_draw') <> 'object'
    or pg_catalog.jsonb_typeof(p_correction->'invalidated_score_ids') <> 'array'
    or pg_catalog.jsonb_typeof(p_correction->'replacement_scores') <> 'array'
    or nullif(p_correction->>'reason', '') is null then
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
      or nullif(rows.score->>'forecast_id', '') is null
      or nullif(rows.score->>'draw_date', '') is null
      or pg_catalog.jsonb_typeof(rows.score->'metrics') <> 'object'
      or nullif(rows.score->>'evaluator_version', '') is null
      or nullif(rows.score->>'supersedes_score_id', '') is null
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
  select coalesce(
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
