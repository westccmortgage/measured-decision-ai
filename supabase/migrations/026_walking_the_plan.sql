-- Walking the project instead of scrolling it.
--
-- A plan set already says which rooms open into which: a door on a sheet is a
-- fact drawn on the sheet, not an inference. Until now that fact was thrown
-- away — the analysis extracted the rooms and forgot how they connect, so the
-- record was a list of rooms with no shape. In a headset that is the whole
-- difference between looking at evidence and being in the building.
--
-- What this stores is one thing only: room A opens into room B, this is the
-- kind of opening it is, and here is the sheet it was read from. No geometry,
-- no coordinates, no distances — none of that is legible from a plan set with
-- enough confidence to stand behind, and a route drawn from a guess is exactly
-- the kind of believable wrong this product exists to refuse.
--
-- A route the AI read is not a route until a person says so. The link carries
-- its own state and every screen that shows it shows that state, the same way
-- a marker in a room is amber until somebody confirms it. Confirmation is not
-- assumed by silence and it is not granted by use.
--
-- The link is undirected: a door between the hall and the kitchen is one door,
-- not two. That is enforced rather than trusted, by storing the smaller id
-- first and refusing anything else, so the same opening cannot be recorded
-- twice under two names.

create table if not exists public.plan_space_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  baseline_id uuid not null references public.document_baselines(id) on delete cascade,
  from_plan_space_id uuid not null references public.plan_spaces(id) on delete cascade,
  to_plan_space_id uuid not null references public.plan_spaces(id) on delete cascade,
  -- What a plan actually shows. Anything a sheet does not distinguish is
  -- 'opening', which says less and is therefore safer than a guess.
  connection text not null default 'opening'
    check (connection in ('door', 'opening', 'stairs', 'corridor', 'exterior_door', 'other')),
  source_refs jsonb not null default '[]'::jsonb,
  state text not null default 'suggested'
    check (state in ('suggested', 'confirmed', 'rejected')),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint plan_space_links_not_self check (from_plan_space_id <> to_plan_space_id),
  -- One door, one row. Stored in a fixed order so the pair is the identity.
  constraint plan_space_links_ordered check (from_plan_space_id < to_plan_space_id),
  unique (baseline_id, from_plan_space_id, to_plan_space_id, connection)
);

create index if not exists plan_space_links_baseline_idx
  on public.plan_space_links(baseline_id, state);
create index if not exists plan_space_links_from_idx
  on public.plan_space_links(from_plan_space_id);
create index if not exists plan_space_links_to_idx
  on public.plan_space_links(to_plan_space_id);

comment on table public.plan_space_links is
  'How the plan set says rooms connect. Read by an agent, unconfirmed until a person confirms it, and never presented as a fact before then.';
comment on column public.plan_space_links.state is
  'suggested until a named person confirms or rejects it. Using a route does not confirm it.';

alter table public.plan_space_links enable row level security;

-- Read access matches its siblings — plan_spaces, construction_phases and the
-- rest of the baseline — deliberately, rather than reaching for the newer
-- can_access_property. That function is revoked from anon on purpose (022), so
-- a policy built on it turns a signed-out read into "permission denied for
-- function" where every other table returns nothing at all. Both refuse, but
-- one of them answers a question nobody asked. Project-scoped access is still
-- empty by design; when it is switched on, this policy moves with the others.
drop policy if exists plan_space_links_read on public.plan_space_links;
create policy plan_space_links_read on public.plan_space_links for select
using (public.is_org_member(organization_id));

-- Writes are server-owned, as they are for every other thing an agent produces.
-- Review goes through the RPC below so it can be checked and recorded.

-- One person says whether a route the plans appear to show is really there.
create or replace function public.review_space_link(
  p_link_id uuid,
  p_state text,
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  link_record public.plan_space_links%rowtype;
  actor_role public.studio_role;
begin
  if p_state not in ('confirmed', 'rejected') then
    raise exception 'A route is either confirmed or rejected';
  end if;

  select * into link_record from public.plan_space_links where id = p_link_id for update;
  if link_record.id is null then
    raise exception 'Route not found';
  end if;

  -- The definer bypasses row-level security, so authorization is checked here
  -- or it is not checked at all.
  actor_role := public.property_role(link_record.property_id);
  if actor_role is null or actor_role not in ('owner', 'admin', 'reviewer', 'project_manager') then
    raise exception 'Only an owner, administrator, reviewer or project manager can confirm how rooms connect';
  end if;

  update public.plan_space_links
  set state = p_state,
      reviewed_by = auth.uid(),
      reviewed_at = now()
  where id = p_link_id;

  insert into public.audit_events (
    organization_id, actor_id, action, entity_type, entity_id, detail
  ) values (
    link_record.organization_id, auth.uid(), 'space_link.' || p_state,
    'plan_space_link', p_link_id::text,
    jsonb_build_object(
      'property_id', link_record.property_id,
      'baseline_id', link_record.baseline_id,
      'previous_state', link_record.state,
      'connection', link_record.connection,
      'note', nullif(trim(coalesce(p_note, '')), '')
    )
  );

  return p_link_id;
end;
$$;

-- Somebody who knows the building can say a door exists that the plans do not
-- show — a route added by a person is confirmed by the same act, because the
-- person adding it is the authority the confirmation was waiting for.
create or replace function public.add_space_link(
  p_from_space_id uuid,
  p_to_space_id uuid,
  p_connection text default 'door'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  from_room public.spaces%rowtype;
  to_room public.spaces%rowtype;
  actor_role public.studio_role;
  baseline uuid;
  low uuid;
  high uuid;
  existing uuid;
  new_id uuid;
begin
  if p_connection not in ('door', 'opening', 'stairs', 'corridor', 'exterior_door', 'other') then
    raise exception 'That is not a kind of opening this record knows';
  end if;

  select * into from_room from public.spaces where id = p_from_space_id;
  select * into to_room from public.spaces where id = p_to_space_id;
  if from_room.id is null or to_room.id is null then
    raise exception 'Both rooms have to be in the record before they can be connected';
  end if;
  if from_room.property_id <> to_room.property_id then
    raise exception 'Those two rooms are in different projects';
  end if;
  if from_room.id = to_room.id then
    raise exception 'A room does not open into itself';
  end if;

  actor_role := public.property_role(from_room.property_id);
  if actor_role is null or actor_role not in ('owner', 'admin', 'reviewer', 'project_manager') then
    raise exception 'Only an owner, administrator, reviewer or project manager can record how rooms connect';
  end if;

  -- A link lives against a baseline because that is what the rooms belong to.
  select active_baseline_id into baseline from public.properties where id = from_room.property_id;
  if baseline is null then
    select id into baseline from public.document_baselines
     where property_id = from_room.property_id
     order by version desc limit 1;
  end if;
  if baseline is null then
    raise exception 'This project has no approved plan set to record the route against';
  end if;

  -- Rooms carry their plan identity; a room created by hand may have none, and
  -- that is a real limit rather than something to paper over.
  if from_room.plan_space_id is null or to_room.plan_space_id is null then
    raise exception 'One of those rooms is not on the plan set, so there is nothing to connect it to yet';
  end if;

  low := least(from_room.plan_space_id, to_room.plan_space_id);
  high := greatest(from_room.plan_space_id, to_room.plan_space_id);

  select id into existing from public.plan_space_links
   where baseline_id = baseline and from_plan_space_id = low and to_plan_space_id = high;
  if existing is not null then
    -- Already read from the plans. Somebody saying it out loud confirms it.
    update public.plan_space_links
    set state = 'confirmed', reviewed_by = auth.uid(), reviewed_at = now()
    where id = existing;
    new_id := existing;
  else
    insert into public.plan_space_links (
      organization_id, property_id, baseline_id,
      from_plan_space_id, to_plan_space_id, connection,
      source_refs, state, reviewed_by, reviewed_at
    ) values (
      from_room.organization_id, from_room.property_id, baseline,
      low, high, p_connection,
      '[]'::jsonb, 'confirmed', auth.uid(), now()
    )
    returning id into new_id;
  end if;

  insert into public.audit_events (
    organization_id, actor_id, action, entity_type, entity_id, detail
  ) values (
    from_room.organization_id, auth.uid(), 'space_link.added_by_person',
    'plan_space_link', new_id::text,
    jsonb_build_object(
      'property_id', from_room.property_id,
      'baseline_id', baseline,
      'from_space_id', p_from_space_id,
      'to_space_id', p_to_space_id,
      'connection', p_connection,
      'existing', existing is not null
    )
  );

  return new_id;
end;
$$;

-- How the project connects, as the record can actually show it.
--
-- Every route names both rooms as the record holds them, so a screen can walk
-- somebody from one to the next. Where the plans name a room the record does
-- not have, the route is still returned and says so — the alternative is a
-- route that silently vanishes, which reads as "there is no door there" and is
-- a different and untrue statement.
create or replace function public.project_space_links(p_property_id uuid)
returns table (
  link_id uuid,
  state text,
  connection text,
  from_room_id uuid,
  from_room_name text,
  from_plan_name text,
  from_evidence_count bigint,
  to_room_id uuid,
  to_room_name text,
  to_plan_name text,
  to_evidence_count bigint,
  source_refs jsonb,
  reviewed_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org uuid;
  v_baseline uuid;
begin
  select organization_id, active_baseline_id into v_org, v_baseline
  from public.properties
  where id = p_property_id and deleted_at is null;
  if v_org is null then
    return;
  end if;
  if not public.can_access_property(p_property_id) then
    raise exception 'Not authorized for this project';
  end if;

  if v_baseline is null then
    select id into v_baseline from public.document_baselines
     where property_id = p_property_id
     order by version desc limit 1;
  end if;
  if v_baseline is null then
    return;
  end if;

  return query
  select
    l.id,
    l.state,
    l.connection,
    from_room.id,
    from_room.name,
    from_plan.name,
    coalesce(from_count.total, 0),
    to_room.id,
    to_room.name,
    to_plan.name,
    coalesce(to_count.total, 0),
    l.source_refs,
    l.reviewed_at
  from public.plan_space_links l
  join public.plan_spaces from_plan on from_plan.id = l.from_plan_space_id
  join public.plan_spaces to_plan on to_plan.id = l.to_plan_space_id
  left join public.spaces from_room on from_room.plan_space_id = from_plan.id
  left join public.spaces to_room on to_room.plan_space_id = to_plan.id
  left join lateral (
    select count(*) as total from public.evidence_items e
     where e.space_id = from_room.id and e.deleted_at is null
  ) from_count on true
  left join lateral (
    select count(*) as total from public.evidence_items e
     where e.space_id = to_room.id and e.deleted_at is null
  ) to_count on true
  where l.baseline_id = v_baseline
    and l.state <> 'rejected'
  order by from_plan.name, to_plan.name;
end;
$$;

comment on function public.project_space_links(uuid) is
  'The walkable shape of a project. A route with no room behind it is still returned, saying so, because dropping it would read as there being no door.';

revoke all on function public.review_space_link(uuid, text, text) from public;
revoke all on function public.add_space_link(uuid, uuid, text) from public;
revoke all on function public.project_space_links(uuid) from public;
grant execute on function public.review_space_link(uuid, text, text) to authenticated;
grant execute on function public.add_space_link(uuid, uuid, text) to authenticated;
grant execute on function public.project_space_links(uuid) to authenticated;
