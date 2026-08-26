-- The camera learns to count.
--
-- The last unfilled door in the intelligence core: installed_seen. The
-- evidence inspector already looks at every capture's frames; now, when a
-- project has a component vocabulary, it also counts what it can actually
-- see — and this function is the only way those counts enter the record,
-- so the rules live in one place:
--
--   - A newer reading of a room REPLACES that room's previous AI reading
--     for the same component. Two analyses of the same capture must never
--     sum into twice the piles.
--   - Different rooms still sum: the west half's 6 piles and the east
--     half's 8 are 14.
--   - Counts are Read by AI · not confirmed, like every AI reading here;
--     reconciliation already treats them as evidence of installation only,
--     never of conformity, and coverage still gates every conflict.

create or replace function public.record_vision_counts(
  p_property_id uuid,
  p_space_id uuid,
  p_evidence_ids uuid[],
  p_counts jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  property_record public.properties%rowtype;
  actor_role public.studio_role;
  entry jsonb;
  entry_count numeric;
  written integer := 0;
begin
  select * into property_record from public.properties where id = p_property_id;
  if property_record.id is null then
    raise exception 'That project is not in the record';
  end if;
  actor_role := public.property_role(p_property_id);
  if actor_role is null or actor_role not in ('owner', 'admin', 'reviewer', 'contributor', 'project_manager') then
    raise exception 'Vision counts are recorded by the project''s own people and workers';
  end if;
  if jsonb_typeof(coalesce(p_counts, '[]'::jsonb)) <> 'array' then
    raise exception 'Vision counts arrive as a list';
  end if;
  if p_space_id is not null and not exists (
    select 1 from public.spaces where id = p_space_id and property_id = p_property_id
  ) then
    raise exception 'That room is not in this project';
  end if;

  for entry in select * from jsonb_array_elements(coalesce(p_counts, '[]'::jsonb)) loop
    entry_count := coalesce((entry->>'count_visible')::numeric, 0);
    if nullif(trim(coalesce(entry->>'component_key', '')), '') is null or entry_count <= 0 then
      continue; -- a zero is not an observation; absence of evidence stays absent
    end if;

    update public.project_observations
    set state = 'superseded'
    where property_id = p_property_id and state = 'active'
      and component_key = trim(entry->>'component_key')
      and kind = 'installed_seen' and method = 'AI_VISION'
      and coalesce(space_id::text, '') = coalesce(p_space_id::text, '');

    insert into public.project_observations (
      organization_id, property_id, space_id, channel, component_key, kind,
      quantity, evidence_ids, method, confidence, note, recorded_by
    ) values (
      property_record.organization_id, p_property_id, p_space_id, 'visual',
      trim(entry->>'component_key'), 'installed_seen',
      entry_count, coalesce(p_evidence_ids, '{}'::uuid[]), 'AI_VISION',
      case when entry->>'confidence' in ('high', 'medium', 'low') then entry->>'confidence' else 'low' end,
      nullif(trim(coalesce(entry->>'note', '')), ''), auth.uid()
    );
    written := written + 1;
  end loop;
  return written;
end;
$$;

comment on function public.record_vision_counts(uuid, uuid, uuid[], jsonb) is
  'The only door for AI-counted installed components. A newer reading of a room replaces that room''s previous AI reading; rooms sum; zero is not an observation.';

revoke all on function public.record_vision_counts(uuid, uuid, uuid[], jsonb) from public;
grant execute on function public.record_vision_counts(uuid, uuid, uuid[], jsonb) to authenticated;
