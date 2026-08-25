-- A 360 capture belongs to a room, not to a project.
--
-- Two camera originals uploaded into Hallway 200A, and the room reported
-- itself empty. The rows were in the record with Hallway 200A on them; what
-- was wrong was the grouping. A dual-lens capture is two files and one thing,
-- so it is drawn and stitched as one — and both halves of the product grouped
-- it by capture key across the whole project, with no regard for the room.
--
-- Upload the same capture to a second room and it merged into the first room's
-- group, which kept the first room's space_id because `on conflict` only
-- touched updated_at. The screen showed the second room as empty and the
-- stitched master would have been filed in the first room too.
--
-- The room joins the key. The same capture in two rooms is two captures, which
-- is what it is: two uploads, two rooms, two records. A pair accidentally split
-- across rooms now shows as two incomplete captures rather than one of them
-- silently joining the other — wrong in a way somebody can see and fix, rather
-- than wrong invisibly.
--
-- Existing rows are safe: they are unique under (property_id, capture_key), and
-- adding a column to a unique key can only ever split, never collide.

alter table public.capture_360_groups
  drop constraint if exists capture_360_groups_property_id_capture_key_key;

-- space_id is NOT NULL on this table, so nulls-not-distinct is belt to that
-- brace rather than a requirement — it costs nothing and removes a way for a
-- future nullable column to quietly allow duplicates.
create unique index if not exists capture_360_groups_room_capture_key
  on public.capture_360_groups (property_id, space_id, capture_key) nulls not distinct;

comment on index public.capture_360_groups_room_capture_key is
  'A capture is identified by its room as well as its key. The same capture uploaded to two rooms is two captures.';

-- The reconciler, with the room carried through both halves: the group it finds
-- or creates, and the originals it gathers into it.
create or replace function public.reconcile_insta360_capture(p_evidence_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_evidence public.evidence_items%rowtype;
  v_filename text;
  v_capture_key text;
  v_group_id uuid;
  v_source_ids uuid[];
begin
  select * into v_evidence from public.evidence_items where id = p_evidence_id;
  if not found then raise exception 'Evidence source not found'; end if;
  v_filename := lower(v_evidence.original_filename);
  if v_filename !~ '\.insv$' then return null; end if;
  v_capture_key := regexp_replace(v_filename, '_(00|10)_([0-9]+)\.insv$', '_\2');
  if v_capture_key = v_filename then v_capture_key := regexp_replace(v_filename, '\.insv$', ''); end if;

  -- A capture with no room cannot be grouped by room, and guessing one would
  -- put somebody's evidence somewhere nobody chose.
  if v_evidence.space_id is null then return null; end if;

  insert into public.capture_360_groups(organization_id,property_id,space_id,project_intake_access_id,capture_key)
  values(v_evidence.organization_id,v_evidence.property_id,v_evidence.space_id,v_evidence.project_intake_access_id,v_capture_key)
  on conflict(property_id,space_id,capture_key) do update set updated_at=now()
  returning id into v_group_id;

  -- Only the originals in this room. Gathering them project-wide is what put
  -- one room's files into another room's capture.
  select array_agg(e.id order by e.original_filename) into v_source_ids
  from public.evidence_items e
  where e.property_id=v_evidence.property_id
    and e.space_id=v_evidence.space_id
    and e.deleted_at is null
    and lower(e.original_filename) ~ '\.insv$'
    and regexp_replace(lower(e.original_filename), '_(00|10)_([0-9]+)\.insv$', '_\2')=v_capture_key;

  update public.capture_360_groups set source_evidence_ids=coalesce(v_source_ids,array[p_evidence_id]),
    state=case when cardinality(coalesce(v_source_ids,array[p_evidence_id]))>=expected_source_count then 'ready' else 'waiting_for_pair' end,
    updated_at=now() where id=v_group_id;

  if cardinality(coalesce(v_source_ids,array[p_evidence_id]))>=2 then
    insert into public.capture_360_jobs(organization_id,property_id,capture_group_id,state,progress,stage)
    values(v_evidence.organization_id,v_evidence.property_id,v_group_id,'waiting_for_sdk',5,'Original pair verified')
    on conflict(capture_group_id) do update set stage='Original pair verified',progress=greatest(public.capture_360_jobs.progress,5),updated_at=now();
  end if;
  return v_group_id;
end; $$;

revoke all on function public.reconcile_insta360_capture(uuid) from public, anon, authenticated;

-- Re-group what is already in the record, so a capture uploaded to a second
-- room before this migration stops being invisible there.
do $$
declare source_record record;
begin
  for source_record in
    select id from public.evidence_items
    where deleted_at is null
      and space_id is not null
      and lower(original_filename) ~ '\.insv$'
    order by created_at
  loop
    perform public.reconcile_insta360_capture(source_record.id);
  end loop;
end $$;
