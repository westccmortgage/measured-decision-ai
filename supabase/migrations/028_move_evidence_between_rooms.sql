-- Putting a file in the room it belongs to.
--
-- Evidence lands in whichever room was selected when it was uploaded, and that
-- is sometimes the wrong one — the picker was left on the previous room, the
-- same capture went in twice, a room was chosen before anybody had walked the
-- building. Until now the only remedy was to delete the file and upload it
-- again, which destroys the upload time, the digest, and the audit trail: the
-- record forgets that the evidence ever existed in the first place and gains a
-- second, younger copy pretending to be the original.
--
-- Moving is not re-uploading. The file, its digest, its captured_at and its
-- whole history stay exactly as they are; what changes is which room the record
-- says it belongs to, and that change is itself recorded with who made it.
--
-- The rooms have to be in the same project. A file moved between projects would
-- be evidence about one property filed under another, which is the one thing
-- this record must never do.

create or replace function public.move_evidence_to_room(
  p_evidence_id uuid,
  p_space_id uuid,
  p_reason text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_evidence public.evidence_items%rowtype;
  v_target public.spaces%rowtype;
  v_from uuid;
  actor_role public.studio_role;
begin
  select * into v_evidence from public.evidence_items where id = p_evidence_id for update;
  if v_evidence.id is null then
    raise exception 'That file is not in the record';
  end if;
  if v_evidence.deleted_at is not null then
    raise exception 'That file has been removed from the record — put it back before moving it';
  end if;

  select * into v_target from public.spaces where id = p_space_id;
  if v_target.id is null then
    raise exception 'That room is not in the record';
  end if;
  -- Evidence about one property filed under another is the one thing this
  -- record must never do, so it is refused here rather than trusted to a screen.
  if v_target.property_id <> v_evidence.property_id then
    raise exception 'That room belongs to a different project';
  end if;

  -- The definer bypasses row-level security, so authorization is checked here
  -- or it is not checked at all. The same people who may correct a file's
  -- details may say which room it was taken in.
  actor_role := public.property_role(v_evidence.property_id);
  if actor_role is null or actor_role not in ('owner', 'admin', 'reviewer', 'contributor', 'project_manager') then
    raise exception 'Only an owner, administrator, reviewer, contributor or project manager can move a file between rooms';
  end if;

  v_from := v_evidence.space_id;
  if v_from is not distinct from p_space_id then
    return p_evidence_id;
  end if;

  update public.evidence_items
  set space_id = p_space_id
  where id = p_evidence_id;

  -- A dual-lens capture is grouped by room, so moving one of its originals
  -- changes two captures: the one it left and the one it joined. Both are
  -- rebuilt, or the group it left keeps claiming a file that is no longer in it.
  if lower(v_evidence.original_filename) ~ '\.insv$' then
    perform public.reconcile_insta360_capture(p_evidence_id);
    if v_from is not null then
      perform public.reconcile_insta360_capture(other.id)
      from public.evidence_items other
      where other.space_id = v_from
        and other.deleted_at is null
        and lower(other.original_filename) ~ '\.insv$'
      limit 1;
      -- The group it left may now hold nothing at all.
      update public.capture_360_groups g
      set source_evidence_ids = coalesce((
            select array_agg(e.id order by e.original_filename)
            from public.evidence_items e
            where e.space_id = g.space_id
              and e.deleted_at is null
              and lower(e.original_filename) ~ '\.insv$'
              and regexp_replace(lower(e.original_filename), '_(00|10)_([0-9]+)\.insv$', '_\2') = g.capture_key
          ), '{}'),
          state = case
            when coalesce((
              select count(*) from public.evidence_items e
              where e.space_id = g.space_id
                and e.deleted_at is null
                and lower(e.original_filename) ~ '\.insv$'
                and regexp_replace(lower(e.original_filename), '_(00|10)_([0-9]+)\.insv$', '_\2') = g.capture_key
            ), 0) >= g.expected_source_count then 'ready' else 'waiting_for_pair' end,
          updated_at = now()
      where g.space_id = v_from;
    end if;
  end if;

  insert into public.audit_events (
    organization_id, actor_id, action, entity_type, entity_id, detail
  ) values (
    v_evidence.organization_id, auth.uid(), 'evidence.moved',
    'evidence_item', p_evidence_id::text,
    jsonb_build_object(
      'property_id', v_evidence.property_id,
      'filename', v_evidence.original_filename,
      'from_space_id', v_from,
      'to_space_id', p_space_id,
      'reason', nullif(trim(coalesce(p_reason, '')), ''),
      -- Stated so nobody reading this later wonders whether a file was
      -- replaced. Nothing about the file itself changed.
      'file_unchanged', true
    )
  );

  return p_evidence_id;
end;
$$;

comment on function public.move_evidence_to_room(uuid, uuid, text) is
  'Says which room a file was taken in. The file, its digest and its history are untouched; the correction is recorded with who made it.';

-- Every file in a project, with the room it is in — the thing behind the count.
--
-- "31 files in this project" was a number with nothing under it: no way to see
-- what they were, which room each was in, or that the same capture had been
-- uploaded three times. A count somebody cannot open is not information.
create or replace function public.project_files(p_property_id uuid)
returns table (
  id uuid,
  filename text,
  media_type text,
  mime_type text,
  byte_size bigint,
  room_id uuid,
  room_name text,
  room_building text,
  room_level text,
  happened_at timestamptz,
  uploaded_at timestamptz,
  -- True when another file in this project carries the same name. That is not
  -- an error by itself — the same capture legitimately appears in two rooms —
  -- but it is the shape of every filing mistake so far, and it is invisible
  -- from inside a single room.
  duplicate_name boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org uuid;
begin
  select organization_id into v_org from public.properties
   where properties.id = p_property_id and deleted_at is null;
  if v_org is null then
    return;
  end if;
  if not public.can_access_property(p_property_id) then
    raise exception 'Not authorized for this project';
  end if;

  return query
  select
    e.id,
    e.original_filename,
    e.media_type,
    e.mime_type,
    e.byte_size,
    e.space_id,
    s.name,
    s.building,
    s.level,
    coalesce(e.captured_at, e.created_at),
    e.created_at,
    count(*) over (partition by lower(e.original_filename)) > 1
  from public.evidence_items e
  left join public.spaces s on s.id = e.space_id
  where e.property_id = p_property_id
    and e.deleted_at is null
  order by s.building nulls last, s.level nulls last, s.name nulls last, e.created_at;
end;
$$;

comment on function public.project_files(uuid) is
  'Every file in a project and the room it sits in. The list behind the count.';

revoke all on function public.move_evidence_to_room(uuid, uuid, text) from public;
revoke all on function public.project_files(uuid) from public;
grant execute on function public.move_evidence_to_room(uuid, uuid, text) to authenticated;
grant execute on function public.project_files(uuid) to authenticated;
