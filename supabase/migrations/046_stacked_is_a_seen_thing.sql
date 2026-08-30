-- 046 · Stacked is a seen thing.
--
-- "Bought is not installed" rested on subtraction: delivered minus
-- installed, and whatever remained was called material on site. That is an
-- inference, and it is the weakest kind — it is equally consistent with
-- material that went in and nobody could identify, material that went to
-- another job, and material that never arrived despite the paperwork.
--
-- A camera that can see a pallet of studs standing in a room can say so.
-- That is evidence, and it belongs in the record as its own observation
-- rather than as the residue of an arithmetic. Once it exists, the two can
-- be told apart on screen: what somebody saw standing there, and what the
-- numbers merely imply is standing there. When both exist and disagree,
-- that disagreement is worth more than either number alone.
--
-- The kind is deliberately narrow. It says: this component is present on
-- site and not built in. It never says where it came from, whether it is
-- the right material, or whose it is.

alter table public.project_observations
  drop constraint if exists project_observations_kind_check;

alter table public.project_observations
  add constraint project_observations_kind_check
  check (kind in ('installed_seen', 'delivered_documented', 'on_site_not_installed', 'observed', 'capture_coverage'));

create or replace function public.record_observation(
  p_property_id uuid,
  p_component_key text,
  p_kind text,
  p_quantity numeric default null,
  p_space_id uuid default null,
  p_evidence_ids uuid[] default '{}'::uuid[],
  p_coverage text default null,
  p_method text default 'AI_VISION',
  p_confidence text default 'medium',
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  property_record public.properties%rowtype;
  actor_role public.studio_role;
  new_id uuid;
begin
  select * into property_record from public.properties where id = p_property_id;
  if property_record.id is null then
    raise exception 'That project is not in the record';
  end if;
  actor_role := public.property_role(p_property_id);
  if actor_role is null or actor_role not in ('owner', 'admin', 'reviewer', 'contributor', 'project_manager') then
    raise exception 'Observations are recorded by the project''s own people and workers';
  end if;
  if nullif(trim(coalesce(p_component_key, '')), '') is null then
    raise exception 'An observation names the component it observed';
  end if;
  if p_kind = 'capture_coverage' and p_coverage is null then
    raise exception 'A coverage observation states the coverage';
  end if;
  /* Seeing material standing on site is a claim about how much. Without a
     number it is an impression, and an impression must not enter the record
     wearing the same clothes as a count. */
  if p_kind = 'on_site_not_installed' and (p_quantity is null or p_quantity <= 0) then
    raise exception 'An on-site observation states how much was seen standing there';
  end if;
  /* A delivery document proves a delivery. It cannot prove that the material
     is still on site, and it never sees a pallet. */
  if p_kind = 'on_site_not_installed' and p_method = 'DOCUMENT' then
    raise exception 'Material standing on site is seen, not documented';
  end if;

  insert into public.project_observations (
    organization_id, property_id, space_id, channel, component_key, kind,
    quantity, coverage, evidence_ids, method, confidence, note, recorded_by
  ) values (
    property_record.organization_id, p_property_id, p_space_id,
    case when p_method = 'DOCUMENT' then 'documents' else 'visual' end,
    trim(p_component_key), p_kind, p_quantity, p_coverage,
    coalesce(p_evidence_ids, '{}'::uuid[]), p_method, p_confidence,
    nullif(trim(coalesce(p_note, '')), ''), auth.uid()
  ) returning id into new_id;
  return new_id;
end;
$$;

comment on function public.record_observation(uuid, text, text, numeric, uuid, uuid[], text, text, text, text) is
  'Records one observation against a component. Material standing on site is a seen thing: it needs a quantity and cannot come from a document.';

revoke all on function public.record_observation(uuid, text, text, numeric, uuid, uuid[], text, text, text, text) from public, anon;
grant execute on function public.record_observation(uuid, text, text, numeric, uuid, uuid[], text, text, text, text) to authenticated;

-- The period pass learns to tell the two apart.
create or replace function public.reconcile_period(
  p_property_id uuid,
  p_since timestamptz default now() - interval '7 days',
  p_until timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  property_record public.properties%rowtype;
  actor_role public.studio_role;
  arrived jsonb;
  installed jsonb;
  seen_standing jsonb;
  on_site jsonb;
  awaiting jsonb;
  phase_order jsonb;
  latest_baseline uuid;
begin
  select * into property_record from public.properties where id = p_property_id;
  if property_record.id is null then
    raise exception 'That project is not in the record';
  end if;
  actor_role := public.property_role(p_property_id);
  if actor_role is null or actor_role not in ('owner', 'admin', 'reviewer', 'project_manager') then
    raise exception 'The period pass is for the people who run the project';
  end if;
  if p_until < p_since then
    raise exception 'A period ends after it begins';
  end if;

  select coalesce(jsonb_agg(row_to_json(entry) order by entry.component_key), '[]'::jsonb)
    into arrived
  from (
    select component_key,
           sum(coalesce(quantity, 0)) as quantity,
           count(*) as documents,
           min(confidence) as weakest_confidence
      from public.project_observations
     where property_id = p_property_id
       and state = 'active'
       and kind = 'delivered_documented'
       and observed_at >= p_since and observed_at <= p_until
     group by component_key
  ) entry;

  select coalesce(jsonb_agg(row_to_json(entry) order by entry.component_key), '[]'::jsonb)
    into installed
  from (
    select component_key,
           sum(coalesce(quantity, 0)) as quantity,
           count(*) as observations,
           min(confidence) as weakest_confidence
      from public.project_observations
     where property_id = p_property_id
       and state = 'active'
       and kind = 'installed_seen'
       and observed_at >= p_since and observed_at <= p_until
     group by component_key
  ) entry;

  -- Somebody looked and saw it standing there. The strongest of the three.
  select coalesce(jsonb_agg(row_to_json(entry) order by entry.component_key), '[]'::jsonb)
    into seen_standing
  from (
    select component_key,
           sum(coalesce(quantity, 0)) as quantity,
           count(*) as observations,
           max(observed_at) as last_seen,
           min(confidence) as weakest_confidence
      from public.project_observations
     where property_id = p_property_id
       and state = 'active'
       and kind = 'on_site_not_installed'
       and observed_at <= p_until
     group by component_key
  ) entry;

  -- What the numbers imply is standing there. Kept apart from what was seen,
  -- because an inference and an observation are not the same evidence, and a
  -- disagreement between them is worth more than either on its own.
  select coalesce(jsonb_agg(row_to_json(entry) order by entry.component_key), '[]'::jsonb)
    into on_site
  from (
    select component_key,
           delivered_total,
           installed_total,
           delivered_total - installed_total as difference
      from (
        select component_key,
               sum(case when kind = 'delivered_documented' then coalesce(quantity, 0) else 0 end) as delivered_total,
               sum(case when kind = 'installed_seen' then coalesce(quantity, 0) else 0 end) as installed_total
          from public.project_observations
         where property_id = p_property_id
           and state = 'active'
           and kind in ('delivered_documented', 'installed_seen')
           and observed_at <= p_until
         group by component_key
      ) totals
     where delivered_total - installed_total > 0
  ) entry;

  select coalesce(jsonb_agg(row_to_json(entry) order by entry.component_key), '[]'::jsonb)
    into awaiting
  from (
    select r.component_key,
           r.description,
           r.quantity as required_quantity,
           r.unit,
           r.method
      from public.project_requirements r
     where r.property_id = p_property_id
       and r.state = 'active'
       and not exists (
         select 1 from public.project_observations o
          where o.property_id = r.property_id
            and o.state = 'active'
            and o.kind = 'installed_seen'
            and o.component_key = r.component_key
            and o.observed_at <= p_until
       )
  ) entry;

  select id into latest_baseline
    from public.document_baselines
   where property_id = p_property_id
   order by version desc
   limit 1;

  select coalesce(jsonb_agg(row_to_json(entry) order by entry.sequence), '[]'::jsonb)
    into phase_order
  from (
    select p.sequence,
           p.code,
           p.name,
           p.starts_when,
           p.ends_when,
           p.concealment_risk,
           (select count(*) from public.capture_requirements c
             where c.phase_id = p.id) as capture_requirements,
           (select count(*) from public.capture_requirements c
             where c.phase_id = p.id and c.priority in ('critical', 'high')) as before_concealment
      from public.construction_phases p
     where p.baseline_id = latest_baseline
  ) entry;

  return jsonb_build_object(
    'property_id', p_property_id,
    'since', p_since,
    'until', p_until,
    'arrived', arrived,
    'installed', installed,
    'on_site_seen', seen_standing,
    'on_site_not_installed', on_site,
    'awaiting_evidence', awaiting,
    'plan_sequence', phase_order,
    'doctrine', 'Counted from the record. A delivery document is never proof of installation, '
      || 'and a component the capture could not identify is not counted rather than counted as zero. '
      || 'on_site_seen is material somebody looked at and saw standing there; on_site_not_installed is '
      || 'what delivered minus installed implies, which is an inference and not the same thing. '
      || 'This pass holds no budget and makes no forecast.'
  );
end;
$$;

comment on function public.reconcile_period(uuid, timestamptz, timestamptz) is
  'What happened between two dates: what arrived, what went in, what was seen standing on site, what the numbers imply is standing on site, what is still awaiting evidence, and the plan''s own phase order. No budget, no forecast — the record holds neither.';

revoke all on function public.reconcile_period(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.reconcile_period(uuid, timestamptz, timestamptz) to authenticated;

-- The camera's own door learns the second kind. A frame can show a component
-- built in and a pallet of the same component standing against a wall; those
-- are two different facts about the same key, and the record now holds both.
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
  seen_kind text;
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
    if nullif(trim(coalesce(entry->>'component_key', '')), '') is null then
      continue;
    end if;
    /* Built in, and standing on site waiting to be. Same key, same room, two
       separate claims — recorded one at a time so neither can be mistaken for
       the other later. */
    foreach seen_kind in array array['installed_seen', 'on_site_not_installed'] loop
      entry_count := coalesce((entry->>(case when seen_kind = 'installed_seen'
        then 'count_visible' else 'count_on_site' end))::numeric, 0);
      if entry_count <= 0 then
        continue; -- a zero is not an observation; absence of evidence stays absent
      end if;

      update public.project_observations
      set state = 'superseded'
      where property_id = p_property_id and state = 'active'
        and component_key = trim(entry->>'component_key')
        and kind = seen_kind and method = 'AI_VISION'
        and coalesce(space_id::text, '') = coalesce(p_space_id::text, '');

      insert into public.project_observations (
        organization_id, property_id, space_id, channel, component_key, kind,
        quantity, evidence_ids, method, confidence, note, recorded_by
      ) values (
        property_record.organization_id, p_property_id, p_space_id, 'visual',
        trim(entry->>'component_key'), seen_kind,
        entry_count, coalesce(p_evidence_ids, '{}'::uuid[]), 'AI_VISION',
        case when entry->>'confidence' in ('high', 'medium', 'low') then entry->>'confidence' else 'low' end,
        nullif(trim(coalesce(entry->>'note', '')), ''), auth.uid()
      );
      written := written + 1;
    end loop;
  end loop;
  return written;
end;
$$;

comment on function public.record_vision_counts(uuid, uuid, uuid[], jsonb) is
  'Records what a reading saw in one room: components built in, and components standing on site not yet built in. A zero is never an observation.';

revoke all on function public.record_vision_counts(uuid, uuid, uuid[], jsonb) from public, anon;
grant execute on function public.record_vision_counts(uuid, uuid, uuid[], jsonb) to authenticated;
