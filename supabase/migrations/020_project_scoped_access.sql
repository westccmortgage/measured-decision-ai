-- Per-project authorization, prepared but not yet switched on.
--
-- Today every permission is organization-wide: a member of an organization can
-- read every property in it. That is correct for one builder with one team and
-- wrong for the first customer who has two clients who must not see each other,
-- or who wants to give a lender one project and nothing else.
--
-- Changing that later means touching every policy on every table, which is the
-- kind of migration that gets postponed forever. So the table and the check
-- function exist now, and every future policy can be written against
-- public.can_access_property() instead of public.is_org_member().
--
-- Behaviour is deliberately unchanged: with no rows in property_members, this
-- function answers exactly what is_org_member answers today.

create table if not exists public.property_members (
  property_id uuid not null references public.properties(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  role public.studio_role not null,
  granted_by uuid references auth.users(id),
  granted_at timestamptz not null default now(),
  expires_at timestamptz,
  primary key (property_id, user_id)
);

create index if not exists property_members_user_idx on public.property_members(user_id, property_id);

alter table public.property_members enable row level security;

drop policy if exists property_members_read on public.property_members;
create policy property_members_read on public.property_members for select
  using (public.is_org_member(organization_id));

drop policy if exists property_members_write on public.property_members;
create policy property_members_write on public.property_members for all
  using (public.has_org_role(organization_id, array['owner','admin']::public.studio_role[]))
  with check (public.has_org_role(organization_id, array['owner','admin']::public.studio_role[]));

-- Read access to one property. Organization membership still grants it, so this
-- is additive: it can only widen access for someone explicitly named on a
-- project, never narrow it for someone who has access today.
create or replace function public.can_access_property(target_property uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists(
    select 1 from public.properties p
    where p.id = target_property and public.is_org_member(p.organization_id)
  ) or exists(
    select 1 from public.property_members m
    where m.property_id = target_property
      and m.user_id = auth.uid()
      and (m.expires_at is null or m.expires_at > now())
  );
$$;

create or replace function public.property_role(target_property uuid)
returns public.studio_role language sql stable security definer set search_path = public as $$
  select coalesce(
    (select m.role from public.property_members m
      where m.property_id = target_property and m.user_id = auth.uid()
        and (m.expires_at is null or m.expires_at > now())),
    (select om.role from public.properties p
      join public.organization_members om on om.organization_id = p.organization_id
     where p.id = target_property and om.user_id = auth.uid())
  );
$$;

comment on table public.property_members is
  'Per-project authorization. Empty by design: while it holds no rows, access is exactly organization-wide access, as it was before this table existed.';
comment on function public.can_access_property(uuid) is
  'Write new policies against this, not is_org_member, so project-scoped access becomes a policy change rather than a schema migration.';
