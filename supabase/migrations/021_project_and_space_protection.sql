-- Projects and spaces get the protection evidence already has.
--
-- Two things were reachable from a browser that should never have been.
--
-- 1. `properties_write` was a FOR ALL policy covering owner, admin *and*
--    contributor — and FOR ALL includes DELETE. A contributor could delete a
--    whole project with one PostgREST call, cascading to every space, every
--    evidence row and every analysis job in it. Nothing in the Studio offers
--    that button; the policy offered it anyway.
-- 2. A space could only be deleted "when empty" because the Studio checked
--    `room.evidence.length` before calling. That check lives in JavaScript the
--    caller controls. Deleting a space that still holds evidence sets every
--    `space_id` to null, so the files survive but stop belonging anywhere —
--    which for a record built on "which room is this?" is its own kind of loss.
--
-- Neither has a UI today. Both are one feature away from having one.

-- ------------------------------------------------------------------ projects
alter table public.properties
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid references auth.users(id),
  add column if not exists deletion_reason text;

create index if not exists properties_live_idx
  on public.properties(organization_id, created_at) where deleted_at is null;

drop policy if exists properties_read on public.properties;
create policy properties_read on public.properties for select
  using (public.is_org_member(organization_id) and deleted_at is null);

-- FOR ALL replaced by the three commands actually needed. There is no delete
-- policy, so no role can hard-delete a project from a client. Removing one is
-- soft_delete_project below, which keeps everything and writes itself down.
drop policy if exists properties_write on public.properties;
create policy properties_insert on public.properties for insert
  with check (public.has_org_role(organization_id, array['owner','admin','contributor']::public.studio_role[]));
create policy properties_update on public.properties for update
  using (public.has_org_role(organization_id, array['owner','admin','contributor']::public.studio_role[]))
  with check (public.has_org_role(organization_id, array['owner','admin','contributor']::public.studio_role[]));

create or replace function public.guard_property_deletion()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.deleted_at is distinct from old.deleted_at then
    if auth.uid() is not null
       and not public.has_org_role(new.organization_id, array['owner','admin']::public.studio_role[]) then
      raise exception 'Only an owner or administrator can remove or restore a project';
    end if;
  end if;
  return new;
end; $$;

drop trigger if exists property_deletion_guard on public.properties;
create trigger property_deletion_guard before update on public.properties
  for each row execute function public.guard_property_deletion();

-- Same shape as soft_delete_evidence, and for the same reason: the read policy
-- hides removed projects, so a plain UPDATE would make the row invisible to its
-- own author and Postgres would refuse it.
create or replace function public.soft_delete_project(p_property_id uuid, p_reason text default null)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_row public.properties%rowtype; v_evidence integer; v_spaces integer;
begin
  select * into v_row from public.properties where id = p_property_id;
  if not found then raise exception 'Project not found'; end if;
  if not public.has_org_role(v_row.organization_id, array['owner','admin']::public.studio_role[]) then
    raise exception 'Only an owner or administrator can remove a project';
  end if;
  if v_row.deleted_at is not null then return true; end if;

  select count(*) into v_evidence from public.evidence_items
    where property_id = p_property_id and deleted_at is null;
  select count(*) into v_spaces from public.spaces where property_id = p_property_id;

  update public.properties
     set deleted_at = now(), deleted_by = auth.uid(), deletion_reason = p_reason
   where id = p_property_id;

  -- The counts are recorded at the moment of removal so the entry says what was
  -- inside it, not what happens to be inside it whenever somebody reads back.
  perform public.record_audit_event(
    v_row.organization_id, 'project.removed', 'properties', p_property_id::text,
    p_property_id, auth.uid(), 'user', null,
    jsonb_build_object('name', v_row.name, 'reason', p_reason,
                       'evidence_count', v_evidence, 'space_count', v_spaces,
                       'everything_retained', true));
  return true;
end; $$;

create or replace function public.restore_project(p_property_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_row public.properties%rowtype;
begin
  select * into v_row from public.properties where id = p_property_id;
  if not found then raise exception 'Project not found'; end if;
  if not public.has_org_role(v_row.organization_id, array['owner','admin']::public.studio_role[]) then
    raise exception 'Only an owner or administrator can restore a project';
  end if;
  if v_row.deleted_at is null then return true; end if;

  update public.properties
     set deleted_at = null, deleted_by = null, deletion_reason = null
   where id = p_property_id;

  perform public.record_audit_event(
    v_row.organization_id, 'project.restored', 'properties', p_property_id::text,
    p_property_id, auth.uid(), 'user', null,
    jsonb_build_object('name', v_row.name, 'deleted_at', v_row.deleted_at));
  return true;
end; $$;

create or replace function public.removed_projects()
returns table (id uuid, name text, deleted_at timestamptz, deleted_by uuid, deletion_reason text)
language sql stable security definer set search_path = public as $$
  select p.id, p.name, p.deleted_at, p.deleted_by, p.deletion_reason
    from public.properties p
   where p.deleted_at is not null
     and public.has_org_role(p.organization_id, array['owner','admin']::public.studio_role[])
   order by p.deleted_at desc;
$$;

revoke all on function public.soft_delete_project(uuid, text) from public, anon;
revoke all on function public.restore_project(uuid) from public, anon;
revoke all on function public.removed_projects() from public, anon;
grant execute on function public.soft_delete_project(uuid, text) to authenticated;
grant execute on function public.restore_project(uuid) to authenticated;
grant execute on function public.removed_projects() to authenticated;

-- -------------------------------------------------------------------- spaces
-- "Only if it is empty" is now a fact about the database rather than a fact
-- about the browser that asked.
create or replace function public.guard_space_deletion()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_count integer;
begin
  select count(*) into v_count from public.evidence_items
   where space_id = old.id and deleted_at is null;
  if v_count > 0 then
    raise exception 'This space still holds % file(s). Move or remove them first — deleting the space would leave them belonging to no room.', v_count;
  end if;
  return old;
end; $$;

drop trigger if exists space_deletion_guard on public.spaces;
create trigger space_deletion_guard before delete on public.spaces
  for each row execute function public.guard_space_deletion();

-- --------------------------------------------------- events only a client sees
-- Generating a report and opening a file happen in a browser, so nothing on the
-- server would otherwise know they happened. `record_audit_event` is not
-- reachable from a browser and must not become reachable, so this is the narrow
-- door: a fixed list of actions, membership checked, actor forced to the caller.
-- A client cannot invent an action, attribute one to someone else, or write into
-- an organization it does not belong to.
create or replace function public.record_client_event(
  p_property_id uuid,
  p_action text,
  p_detail jsonb default '{}'::jsonb
) returns boolean language plpgsql security definer set search_path = public as $$
declare v_org uuid;
begin
  if p_action not in ('report.generated','report.exported','evidence.opened','vision.link_shared') then
    raise exception 'Unsupported event';
  end if;
  select organization_id into v_org from public.properties where id = p_property_id;
  if v_org is null then raise exception 'Project not found'; end if;
  if not public.is_org_member(v_org) then raise exception 'Not authorized for this project'; end if;

  perform public.record_audit_event(
    v_org, p_action, 'properties', p_property_id::text,
    p_property_id, auth.uid(), 'user', null,
    coalesce(p_detail, '{}'::jsonb));
  return true;
end; $$;

revoke all on function public.record_client_event(uuid, text, jsonb) from public, anon;
grant execute on function public.record_client_event(uuid, text, jsonb) to authenticated;
