-- Self-service onboarding for authenticated Studio users.
-- Creates one private organization and owner membership when the user has none.

create or replace function public.bootstrap_personal_organization(
  workspace_name text default null
)
returns table (
  organization_id uuid,
  role public.studio_role
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_user_id uuid := auth.uid();
  existing_organization_id uuid;
  created_organization_id uuid;
  resolved_name text;
begin
  if current_user_id is null then
    raise exception 'Authentication required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(current_user_id::text, 0));

  select m.organization_id
    into existing_organization_id
  from public.organization_members m
  where m.user_id = current_user_id
  order by m.created_at
  limit 1;

  if existing_organization_id is not null then
    return query
      select m.organization_id, m.role
      from public.organization_members m
      where m.user_id = current_user_id
        and m.organization_id = existing_organization_id;
    return;
  end if;

  resolved_name := coalesce(
    nullif(btrim(workspace_name), ''),
    'My Property Workspace'
  );

  insert into public.organizations (name)
  values (left(resolved_name, 120))
  returning id into created_organization_id;

  insert into public.organization_members (organization_id, user_id, role)
  values (created_organization_id, current_user_id, 'owner');

  return query
    select created_organization_id, 'owner'::public.studio_role;
end;
$$;

revoke all on function public.bootstrap_personal_organization(text) from public;
grant execute on function public.bootstrap_personal_organization(text) to authenticated;
