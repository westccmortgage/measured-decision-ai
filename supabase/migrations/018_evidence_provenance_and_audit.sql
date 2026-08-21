-- Evidence provenance, evidence immutability, and an append-only audit trail.
--
-- Three things were true before this migration and should not have been.
--
-- 1. Pressing Delete destroyed evidence. The Edge Function removed the S3 object
--    and the row, the Studio said "deleted permanently", and it was telling the
--    truth. Anything derived from that file lost its parent, and nothing anywhere
--    recorded that the file had ever existed.
-- 2. `sha256` was declared on evidence_items and never written by anything. It
--    travelled into the Vision release manifest as null, so the manifest could
--    not answer "has this evidence changed?" — it only looked like it could.
-- 3. audit_events was a table anyone with the service key could rewrite. An audit
--    trail that can be edited is a log, not evidence.
--
-- None of this changes what a person sees or does. Uploading, analysing and
-- reviewing work exactly as before.

-- ---------------------------------------------------------------- provenance
-- Where a file came from, in the file's own terms. media_type already says what
-- the record is for; source_type says what produced it, which is a different
-- question and the one an auditor asks first.
alter table public.evidence_items
  add column if not exists source_type text
    check (source_type is null or source_type in
      ('phone','360_camera','drone','document','external_system','manual_upload','derived')),
  add column if not exists capture_device jsonb not null default '{}'::jsonb,
  add column if not exists capture_location jsonb not null default '{}'::jsonb,
  -- sha256 (already present) stays the plain whole-file digest. These say how a
  -- digest was arrived at, because "we hashed the whole file" and "the store gave
  -- us a checksum of the parts" are not the same claim and must not look alike.
  add column if not exists content_hash_algorithm text
    check (content_hash_algorithm is null or content_hash_algorithm in
      ('sha-256','s3-sha256-composite','s3-etag-md5')),
  add column if not exists content_hash_scope text
    check (content_hash_scope is null or content_hash_scope in
      ('whole-file','parts-composite')),
  add column if not exists content_hash_recorded_at timestamptz,
  add column if not exists content_hash_recorded_by text;

comment on column public.evidence_items.source_type is
  'What produced this file, not what it is used for. Null means the producer was not recorded; it is never guessed.';
comment on column public.evidence_items.sha256 is
  'Content digest. Meaningless without content_hash_algorithm — read them together or not at all.';
comment on column public.evidence_items.content_hash_algorithm is
  'How sha256 was produced. Null means no digest has been recorded and integrity cannot be asserted.';

-- Documents are evidence too: an invoice or a plan sheet has to answer the same
-- "has this changed?" question as a photograph.
alter table public.project_documents
  add column if not exists content_hash_algorithm text
    check (content_hash_algorithm is null or content_hash_algorithm in
      ('sha-256','s3-sha256-composite','s3-etag-md5')),
  add column if not exists content_hash_scope text
    check (content_hash_scope is null or content_hash_scope in
      ('whole-file','parts-composite')),
  add column if not exists content_hash_recorded_at timestamptz,
  add column if not exists content_hash_recorded_by text;

create index if not exists evidence_items_source_type_idx
  on public.evidence_items(organization_id, source_type);

-- ------------------------------------------------------- evidence immutability
-- Deleting evidence now means hiding it, not destroying it. Removing the bytes is
-- a second, separate, deliberate act — see purged_at.
alter table public.evidence_items
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid references auth.users(id),
  add column if not exists deletion_reason text,
  add column if not exists purged_at timestamptz,
  add column if not exists purged_by uuid references auth.users(id),
  -- Set when retention policy work lands. Nothing enforces it yet, and nothing
  -- pretends to: a null here means "no policy has been applied to this file".
  add column if not exists retention_policy text,
  add column if not exists retain_until timestamptz;

comment on column public.evidence_items.deleted_at is
  'Soft deletion. The row and the stored object both still exist; readers stop seeing it.';
comment on column public.evidence_items.purged_at is
  'The stored object was actually destroyed. Irreversible, and separate from deleted_at on purpose.';

create index if not exists evidence_items_live_idx
  on public.evidence_items(property_id, created_at) where deleted_at is null;

-- A soft-deleted file leaves every list it was in. This is enforced in the read
-- policy rather than in each query, because a filter that must be repeated in
-- twelve places is a filter that will be forgotten in one of them.
drop policy if exists evidence_read on public.evidence_items;
create policy evidence_read on public.evidence_items for select
  using (public.is_org_member(organization_id) and deleted_at is null);

-- Nothing may hard-delete an evidence row any more. The recovery path for a
-- mistake is restoration; the destruction path is an explicit purge that records
-- itself. Neither is a DELETE statement.
drop policy if exists evidence_delete on public.evidence_items;

-- Marking a file deleted is an owner/admin act, exactly as destroying it was.
-- Contributors keep the metadata-correction rights they already had.
create or replace function public.guard_evidence_deletion()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.deleted_at is distinct from old.deleted_at
     or new.purged_at is distinct from old.purged_at then
    if auth.uid() is not null
       and not public.has_org_role(new.organization_id, array['owner','admin']::public.studio_role[]) then
      raise exception 'Only an owner or administrator can delete or restore evidence';
    end if;
  end if;
  -- The original object identity is not editable. A different file is a new
  -- record with a parent, never the same record with new bytes behind it.
  if new.storage_path is distinct from old.storage_path
     or new.storage_bucket is distinct from old.storage_bucket then
    raise exception 'Stored evidence cannot be repointed. Create a derivative instead.';
  end if;
  return new;
end; $$;

drop trigger if exists evidence_deletion_guard on public.evidence_items;
create trigger evidence_deletion_guard before update on public.evidence_items
  for each row execute function public.guard_evidence_deletion();

-- Deleting from the browser goes through here rather than through a direct
-- UPDATE. It has to: the read policy hides deleted rows, so an ordinary update
-- that sets deleted_at makes the row invisible to its own author and Postgres
-- refuses it outright ("new row violates row-level security policy"). Routing it
-- through a definer function keeps the read policy strict — which is what stops
-- a deleted file reappearing in a list somebody forgot to filter — while still
-- checking the caller's role, in the function and again in the guard trigger.
create or replace function public.soft_delete_evidence(p_evidence_id uuid, p_reason text default null)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_row public.evidence_items%rowtype;
begin
  select * into v_row from public.evidence_items where id = p_evidence_id;
  if not found then raise exception 'Evidence not found'; end if;
  if not public.has_org_role(v_row.organization_id, array['owner','admin']::public.studio_role[]) then
    raise exception 'Only an owner or administrator can delete evidence';
  end if;
  if v_row.deleted_at is not null then return true; end if;

  update public.evidence_items
     set deleted_at = now(), deleted_by = auth.uid(), deletion_reason = p_reason
   where id = p_evidence_id;

  perform public.record_audit_event(
    v_row.organization_id, 'evidence.deleted', 'evidence_items', p_evidence_id::text,
    v_row.property_id, auth.uid(), 'user', null,
    jsonb_build_object('original_filename', v_row.original_filename,
                       'space_id', v_row.space_id,
                       'object_key', v_row.storage_path,
                       'reason', p_reason,
                       'object_retained', true));
  return true;
end; $$;

create or replace function public.restore_evidence(p_evidence_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_row public.evidence_items%rowtype;
begin
  select * into v_row from public.evidence_items where id = p_evidence_id;
  if not found then raise exception 'Evidence not found'; end if;
  if not public.has_org_role(v_row.organization_id, array['owner','admin']::public.studio_role[]) then
    raise exception 'Only an owner or administrator can restore evidence';
  end if;
  if v_row.purged_at is not null then
    raise exception 'This file was destroyed and cannot be brought back. The record of it remains.';
  end if;
  if v_row.deleted_at is null then return true; end if;

  update public.evidence_items
     set deleted_at = null, deleted_by = null, deletion_reason = null
   where id = p_evidence_id;

  perform public.record_audit_event(
    v_row.organization_id, 'evidence.restored', 'evidence_items', p_evidence_id::text,
    v_row.property_id, auth.uid(), 'user', null,
    jsonb_build_object('original_filename', v_row.original_filename,
                       'deleted_at', v_row.deleted_at));
  return true;
end; $$;

-- What an owner needs in order to decide whether anything should be destroyed.
create or replace function public.deleted_evidence(p_property_id uuid)
returns table (id uuid, original_filename text, media_type text, byte_size bigint,
               space_id uuid, deleted_at timestamptz, deleted_by uuid,
               deletion_reason text, purged_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare v_org uuid;
begin
  select organization_id into v_org from public.properties where properties.id = p_property_id;
  if v_org is null then raise exception 'Project not found'; end if;
  if not public.has_org_role(v_org, array['owner','admin']::public.studio_role[]) then
    raise exception 'Only an owner or administrator can see deleted evidence';
  end if;
  return query
    select e.id, e.original_filename, e.media_type, e.byte_size, e.space_id,
           e.deleted_at, e.deleted_by, e.deletion_reason, e.purged_at
      from public.evidence_items e
     where e.property_id = p_property_id and e.deleted_at is not null
     order by e.deleted_at desc;
end; $$;

revoke all on function public.soft_delete_evidence(uuid, text) from public, anon;
revoke all on function public.restore_evidence(uuid) from public, anon;
revoke all on function public.deleted_evidence(uuid) from public, anon;
grant execute on function public.soft_delete_evidence(uuid, text) to authenticated;
grant execute on function public.restore_evidence(uuid) to authenticated;
grant execute on function public.deleted_evidence(uuid) to authenticated;

-- ------------------------------------------------------------------- the audit
alter table public.audit_events
  add column if not exists property_id uuid references public.properties(id) on delete set null,
  -- Not every actor is a signed-in person. A field link, a capture guest, the
  -- stitching machine and a scheduled worker all act, and "actor_id is null" was
  -- previously the only thing distinguishing them from each other.
  add column if not exists actor_kind text not null default 'user'
    check (actor_kind in ('user','guest_link','service','worker','system')),
  add column if not exists actor_label text,
  add column if not exists request_ip inet,
  add column if not exists user_agent text,
  add column if not exists session_id text;

create index if not exists audit_events_org_time_idx
  on public.audit_events(organization_id, created_at desc);
create index if not exists audit_events_entity_idx
  on public.audit_events(entity_type, entity_id, created_at desc);

comment on table public.audit_events is
  'Append-only. Rows are never updated or deleted, including by the service role: an audit trail that can be edited is a log, not evidence.';

-- Append-only in the database, not merely by convention. The service key bypasses
-- row-level security, so this is a trigger — the one thing it cannot bypass.
create or replace function public.audit_events_are_append_only()
returns trigger language plpgsql as $$
begin
  raise exception 'audit_events is append-only: an entry cannot be edited or removed, and this includes cascades. Retire an organization by other means rather than erasing its history.';
end; $$;

drop trigger if exists audit_events_no_update on public.audit_events;
create trigger audit_events_no_update before update or delete on public.audit_events
  for each row execute function public.audit_events_are_append_only();

-- One way in, so every writer records the same shape.
create or replace function public.record_audit_event(
  p_organization_id uuid,
  p_action text,
  p_entity_type text,
  p_entity_id text,
  p_property_id uuid default null,
  p_actor_id uuid default null,
  p_actor_kind text default 'user',
  p_actor_label text default null,
  p_detail jsonb default '{}'::jsonb,
  p_request_ip text default null,
  p_user_agent text default null,
  p_session_id text default null
) returns bigint language plpgsql security definer set search_path = public as $$
declare v_id bigint;
begin
  insert into public.audit_events(
    organization_id, property_id, actor_id, actor_kind, actor_label,
    action, entity_type, entity_id, detail, request_ip, user_agent, session_id)
  values (
    p_organization_id, p_property_id, p_actor_id, coalesce(p_actor_kind,'user'), p_actor_label,
    p_action, p_entity_type, p_entity_id, coalesce(p_detail,'{}'::jsonb),
    nullif(p_request_ip,'')::inet, p_user_agent, p_session_id)
  returning id into v_id;
  return v_id;
end; $$;

revoke all on function public.record_audit_event(uuid,text,text,text,uuid,uuid,text,text,jsonb,text,text,text)
  from public, anon, authenticated;

-- ------------------------------------------------------- AI traceability
-- The model we asked for and the model that answered are different facts, and
-- only the second one reconstructs a conclusion.
alter table public.analysis_jobs
  add column if not exists model_version text,
  add column if not exists prompt_fingerprint text,
  add column if not exists input_evidence_count integer,
  add column if not exists usage jsonb not null default '{}'::jsonb;

comment on column public.analysis_jobs.model is
  'The model requested. What actually answered is model_version, which is the one that explains a finding.';

-- --------------------------------------------- observation / interpretation
-- The product rule, made structural: what was seen and what it might mean are
-- different rows, and neither of them is a decision. A decision lives only in
-- suggestion_reviews, whose reviewed_by references auth.users — which no model
-- has and no service key can forge.
alter table public.ai_suggestions
  add column if not exists layer text not null default 'interpretation'
    check (layer in ('observation','interpretation')),
  add column if not exists supporting_evidence_ids uuid[] not null default '{}',
  add column if not exists conflicting_evidence_ids uuid[] not null default '{}',
  add column if not exists missing_evidence jsonb not null default '[]'::jsonb;

comment on column public.ai_suggestions.layer is
  'observation = what was detected. interpretation = what it may support. Neither is a decision; decisions are rows in suggestion_reviews.';
comment on table public.suggestion_reviews is
  'The decision layer. reviewed_by is a real auth.users id, so an AI process cannot author one.';

-- ------------------------------------------------- audit that cannot be skipped
-- The events that matter most are the ones a client could forget to report, so
-- these are written by the database when the row changes, not by whoever changed
-- it. A decision, an AI run and a published release each leave a trace whether
-- the caller was the Studio, an Edge Function, a worker, or psql.

create or replace function public.audit_decision_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.audit_events(organization_id, actor_id, actor_kind, action,
    entity_type, entity_id, detail)
  values (
    new.organization_id, new.reviewed_by, 'user',
    case when tg_op = 'INSERT' then 'decision.made' else 'decision.changed' end,
    'suggestion_reviews', new.id::text,
    jsonb_build_object(
      'suggestion_id', new.suggestion_id,
      'state', new.state,
      'previous_state', case when tg_op = 'UPDATE' then old.state else null end,
      'note_present', new.reviewer_note is not null,
      'body_edited', new.edited_body is not null));
  return new;
end; $$;

drop trigger if exists suggestion_reviews_audit on public.suggestion_reviews;
create trigger suggestion_reviews_audit after insert or update on public.suggestion_reviews
  for each row execute function public.audit_decision_change();

create or replace function public.audit_analysis_state()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and new.state is not distinct from old.state then
    return new;
  end if;
  insert into public.audit_events(organization_id, property_id, actor_id, actor_kind,
    action, entity_type, entity_id, detail)
  values (
    new.organization_id, new.property_id, new.requested_by,
    case when new.requested_by is null then 'service' else 'user' end,
    'analysis.' || new.state::text, 'analysis_jobs', new.id::text,
    jsonb_build_object(
      'profile', new.profile,
      'profile_version', new.profile_version,
      'provider', new.provider,
      'model', new.model,
      'model_version', new.model_version,
      'prompt_fingerprint', new.prompt_fingerprint,
      'evidence_count', coalesce(new.input_evidence_count, array_length(new.evidence_ids, 1)),
      'error_code', new.error_code));
  return new;
end; $$;

drop trigger if exists analysis_jobs_audit on public.analysis_jobs;
create trigger analysis_jobs_audit after insert or update on public.analysis_jobs
  for each row execute function public.audit_analysis_state();

create or replace function public.audit_release_state()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and new.state is not distinct from old.state then
    return new;
  end if;
  insert into public.audit_events(organization_id, property_id, actor_id, actor_kind,
    action, entity_type, entity_id, detail)
  values (
    new.organization_id, new.property_id, coalesce(new.approved_by, new.created_by),
    case when coalesce(new.approved_by, new.created_by) is null then 'service' else 'user' end,
    'release.' || new.state::text, 'vision_releases', new.id::text,
    jsonb_build_object('version', new.version, 'approved_by', new.approved_by));
  return new;
end; $$;

drop trigger if exists vision_releases_audit on public.vision_releases;
create trigger vision_releases_audit after insert or update on public.vision_releases
  for each row execute function public.audit_release_state();

create or replace function public.audit_membership_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.audit_events(organization_id, actor_id, actor_kind, action,
    entity_type, entity_id, detail)
  values (
    coalesce(new.organization_id, old.organization_id), auth.uid(),
    case when auth.uid() is null then 'service' else 'user' end,
    case tg_op when 'INSERT' then 'member.added'
               when 'UPDATE' then 'member.role_changed'
               else 'member.removed' end,
    'organization_members', coalesce(new.user_id, old.user_id)::text,
    jsonb_build_object(
      'role', new.role,
      'previous_role', case when tg_op = 'UPDATE' then old.role else null end));
  return coalesce(new, old);
end; $$;

drop trigger if exists organization_members_audit on public.organization_members;
create trigger organization_members_audit after insert or update or delete on public.organization_members
  for each row execute function public.audit_membership_change();
