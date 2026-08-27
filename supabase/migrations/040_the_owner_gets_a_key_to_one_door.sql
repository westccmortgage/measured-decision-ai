-- The owner gets a key to one door.
--
-- The Owner View shipped inside the Studio access model: to see a release
-- you had to be an organization member, and an organization member sees
-- every project. Both halves are wrong for an external owner — a client
-- must see their own project and nothing else, and must never need (or
-- receive) the keys to the workshop.
--
-- The access model already exists: property_members (migration 020) is
-- per-project, role-carrying, expirable, and already wired into
-- can_access_property() and property_role(). This migration does not
-- duplicate it. It adds the three missing pieces:
--
--   1. a read-only role, 'owner_viewer' — a role no action RPC lists, so
--      every gate in the product already refuses it;
--   2. an invitation by email, because the person being invited usually
--      has no account yet: the project team invites an address, the owner
--      signs in with a magic link, and the invitation becomes a
--      property_members row on first sight — expirable, revocable;
--   3. the grant/accept/revoke doors, each a governed RPC.
--
-- What an owner_viewer can reach: the vision-release worker's read
-- actions, which serve only human-approved releases and published
-- technical results. What they cannot reach: every table (policies check
-- organization membership), every action RPC (role gates), and the
-- Studio itself (it requires an organization). The boundary is the point.

alter type public.studio_role add value if not exists 'owner_viewer';

-- The signed-in caller's email, for matching invitations. Anon gets null;
-- executable by anon on purpose — it runs inside an RLS policy, and a
-- signed-out SELECT must answer with emptiness, not a permission error.
create or replace function public.request_email()
returns text language sql stable security definer set search_path = public as $$
  select lower(email) from auth.users where id = auth.uid()
$$;
revoke all on function public.request_email() from public;
grant execute on function public.request_email() to anon, authenticated;

create table if not exists public.property_invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  invited_email text not null check (position('@' in invited_email) > 1),
  role public.studio_role not null,
  state text not null default 'invited' check (state in ('invited', 'accepted', 'revoked')),
  expires_at timestamptz,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  accepted_by uuid references auth.users(id),
  accepted_at timestamptz,
  unique (property_id, invited_email)
);

comment on table public.property_invitations is
  'An emailed key to one project. Becomes a property_members row when the invitee signs in; revocable and expirable at both stages.';

alter table public.property_invitations enable row level security;

drop policy if exists property_invitations_read on public.property_invitations;
create policy property_invitations_read on public.property_invitations for select
using (
  public.has_org_role(organization_id, array['owner', 'admin']::public.studio_role[])
  or lower(invited_email) = public.request_email()
);
-- No insert/update/delete policies: the doors below are the only writers.

-- The project team hands out the key.
create or replace function public.invite_owner_viewer(
  p_property_id uuid,
  p_email text,
  p_expires_at timestamptz default null
)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  property_record public.properties%rowtype;
  invitation_id uuid;
  clean_email text := lower(trim(coalesce(p_email, '')));
begin
  select * into property_record from public.properties where id = p_property_id;
  if property_record.id is null then
    raise exception 'That project is not in the record';
  end if;
  if not public.has_org_role(property_record.organization_id, array['owner', 'admin']::public.studio_role[]) then
    raise exception 'Only a project owner or admin invites an owner viewer';
  end if;
  if position('@' in clean_email) <= 1 then
    raise exception 'A valid email address is required';
  end if;
  if p_expires_at is not null and p_expires_at <= now() then
    raise exception 'An invitation cannot expire before it is sent';
  end if;

  insert into public.property_invitations (
    organization_id, property_id, invited_email, role, state, expires_at, created_by
  ) values (
    property_record.organization_id, p_property_id, clean_email,
    'owner_viewer', 'invited', p_expires_at, auth.uid()
  )
  on conflict (property_id, invited_email) do update
    set state = 'invited', role = 'owner_viewer', expires_at = excluded.expires_at,
        created_by = excluded.created_by, accepted_by = null, accepted_at = null
  returning id into invitation_id;

  insert into public.audit_events (organization_id, actor_id, action, entity_type, entity_id, detail)
  values (property_record.organization_id, auth.uid(), 'owner_view.invited', 'property_invitation',
          invitation_id::text, jsonb_build_object('property_id', p_property_id, 'expires_at', p_expires_at));
  return invitation_id;
end;
$$;

-- The invitee turns the key. Called by the Owner View on every sign-in;
-- idempotent, matches by the signed-in email, honours expiry.
create or replace function public.accept_property_invitations()
returns integer
language plpgsql security definer set search_path = public as $$
declare
  invitation record;
  accepted integer := 0;
begin
  if auth.uid() is null then
    raise exception 'Sign in to accept an invitation';
  end if;
  for invitation in
    select * from public.property_invitations
    where lower(invited_email) = public.request_email()
      and state = 'invited'
      and (expires_at is null or expires_at > now())
  loop
    insert into public.property_members (property_id, user_id, organization_id, role, granted_by, expires_at)
    values (invitation.property_id, auth.uid(), invitation.organization_id,
            invitation.role, invitation.created_by, invitation.expires_at)
    on conflict (property_id, user_id) do update
      set role = excluded.role, expires_at = excluded.expires_at, granted_by = excluded.granted_by;
    update public.property_invitations
      set state = 'accepted', accepted_by = auth.uid(), accepted_at = now()
      where id = invitation.id;
    accepted := accepted + 1;
  end loop;
  return accepted;
end;
$$;

-- The team takes the key back — at either stage, invitation or grant.
create or replace function public.revoke_owner_view(p_property_id uuid, p_email text)
returns void
language plpgsql security definer set search_path = public as $$
declare
  property_record public.properties%rowtype;
  clean_email text := lower(trim(coalesce(p_email, '')));
begin
  select * into property_record from public.properties where id = p_property_id;
  if property_record.id is null then
    raise exception 'That project is not in the record';
  end if;
  if not public.has_org_role(property_record.organization_id, array['owner', 'admin']::public.studio_role[]) then
    raise exception 'Only a project owner or admin revokes an owner viewer';
  end if;

  update public.property_invitations
    set state = 'revoked'
    where property_id = p_property_id and lower(invited_email) = clean_email and state <> 'revoked';
  -- Only the viewer key is taken: this door never deletes a builder's grant.
  delete from public.property_members m
    using auth.users u
    where m.property_id = p_property_id and m.user_id = u.id
      and lower(u.email) = clean_email and m.role = 'owner_viewer';

  insert into public.audit_events (organization_id, actor_id, action, entity_type, entity_id, detail)
  values (property_record.organization_id, auth.uid(), 'owner_view.revoked', 'property',
          p_property_id::text, jsonb_build_object('email', clean_email));
end;
$$;

revoke all on function public.invite_owner_viewer(uuid, text, timestamptz) from public, anon;
grant execute on function public.invite_owner_viewer(uuid, text, timestamptz) to authenticated;
revoke all on function public.accept_property_invitations() from public, anon;
grant execute on function public.accept_property_invitations() to authenticated;
revoke all on function public.revoke_owner_view(uuid, text) from public, anon;
grant execute on function public.revoke_owner_view(uuid, text) to authenticated;
