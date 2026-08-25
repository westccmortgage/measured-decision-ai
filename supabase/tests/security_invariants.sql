-- What must stay true, checked against a real Postgres.
--
-- Every assertion here is a property somebody could remove by accident: a policy
-- rewritten, a trigger dropped, a filter forgotten. Run this after any change to
-- the schema — see supabase/tests/README.md for how.
--
-- The test acts as real people by setting test.uid, which the harness wires to
-- auth.uid(). Nothing here uses the service role, because the service role
-- bypasses row-level security and would prove nothing about it.

\set ON_ERROR_STOP on
\set QUIET on
begin;

-- Supabase grants these; the local harness has to.
grant usage on schema public to authenticated, anon;
grant usage on schema auth to authenticated, anon;
grant select, insert, update, delete on all tables in schema public to authenticated;
-- Supabase grants anon SELECT on public tables and lets row-level security do
-- the deciding. Granting it here too means the signed-out checks below test what
-- production actually does, rather than a harness that is stricter than reality.
grant select on all tables in schema public to anon;
grant usage, select on all sequences in schema public to authenticated;

-- ------------------------------------------------------------------ fixtures
insert into auth.users(id, email) values
  ('11111111-1111-1111-1111-111111111111','owner@example.com'),
  ('22222222-2222-2222-2222-222222222222','contributor@example.com'),
  ('33333333-3333-3333-3333-333333333333','reviewer@example.com'),
  ('44444444-4444-4444-4444-444444444444','outsider@example.com');

insert into public.organizations(id, name) values
  ('aaaaaaaa-0000-0000-0000-000000000001','Builder A'),
  ('aaaaaaaa-0000-0000-0000-000000000002','Builder B');

insert into public.organization_members(organization_id, user_id, role) values
  ('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','owner'),
  ('aaaaaaaa-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222','contributor'),
  ('aaaaaaaa-0000-0000-0000-000000000001','33333333-3333-3333-3333-333333333333','reviewer'),
  ('aaaaaaaa-0000-0000-0000-000000000002','44444444-4444-4444-4444-444444444444','owner');

insert into public.properties(id, organization_id, name, created_by) values
  ('bbbbbbbb-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','Main House','11111111-1111-1111-1111-111111111111'),
  ('bbbbbbbb-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000002','Other Client','44444444-4444-4444-4444-444444444444');

insert into public.spaces(id, organization_id, property_id, name, created_by) values
  ('cccccccc-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','bbbbbbbb-0000-0000-0000-000000000001','Garage','11111111-1111-1111-1111-111111111111');

insert into public.evidence_items(id, organization_id, property_id, space_id, storage_path,
  original_filename, media_type, mime_type, byte_size, created_by, source_type)
values
  ('dddddddd-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','bbbbbbbb-0000-0000-0000-000000000001','cccccccc-0000-0000-0000-000000000001',
   'organizations/a/properties/b/evidence/one.jpg','one.jpg','Property evidence','image/jpeg',1024,'11111111-1111-1111-1111-111111111111','phone'),
  ('dddddddd-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000002','bbbbbbbb-0000-0000-0000-000000000002',null,
   'organizations/b/properties/c/evidence/two.jpg','two.jpg','Property evidence','image/jpeg',2048,'44444444-4444-4444-4444-444444444444','phone');

-- A plan baseline with one phase and two planned captures, so the rules about
-- accepting a capture that will never be made have something to act on.
insert into public.document_baselines(id, organization_id, property_id, version, state,
  source_document_ids, analysis, created_by)
values ('eeeeeeee-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001',
  'bbbbbbbb-0000-0000-0000-000000000001', 1, 'approved', '{}'::uuid[], '{}'::jsonb,
  '11111111-1111-1111-1111-111111111111');

insert into public.construction_phases(id, organization_id, property_id, baseline_id,
  code, name, sequence, objective, starts_when, ends_when, concealment_risk)
values ('ffffffff-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001',
  'bbbbbbbb-0000-0000-0000-000000000001','eeeeeeee-0000-0000-0000-000000000001',
  'DEMO','Selective demolition',1,'Record removals','demolition starts','new work covers it','high');

insert into public.capture_requirements(id, organization_id, property_id, baseline_id, phase_id,
  title, system, priority, capture_type, rationale, before_concealment)
values
  ('ffffffff-0000-0000-0000-00000000000a','aaaaaaaa-0000-0000-0000-000000000001',
   'bbbbbbbb-0000-0000-0000-000000000001','eeeeeeee-0000-0000-0000-000000000001',
   'ffffffff-0000-0000-0000-000000000001','Post-demolition record','structure','critical','photo',
   'Exposed conditions get covered','before new work'),
  ('ffffffff-0000-0000-0000-00000000000b','aaaaaaaa-0000-0000-0000-000000000001',
   'bbbbbbbb-0000-0000-0000-000000000001','eeeeeeee-0000-0000-0000-000000000001',
   'ffffffff-0000-0000-0000-000000000001','Removed finishes record','finishes','normal','photo',
   'Removals cannot be reconstructed','before new work');

insert into public.capture_tasks(id, organization_id, property_id, baseline_id, requirement_id, status)
values
  ('ffffffff-0000-0000-0000-0000000000aa','aaaaaaaa-0000-0000-0000-000000000001',
   'bbbbbbbb-0000-0000-0000-000000000001','eeeeeeee-0000-0000-0000-000000000001',
   'ffffffff-0000-0000-0000-00000000000a','ready'),
  ('ffffffff-0000-0000-0000-0000000000bb','aaaaaaaa-0000-0000-0000-000000000001',
   'bbbbbbbb-0000-0000-0000-000000000001','eeeeeeee-0000-0000-0000-000000000001',
   'ffffffff-0000-0000-0000-00000000000b','ready');

\set QUIET off
create or replace function pg_temp.check(label text, condition boolean) returns void
language plpgsql as $$
begin
  if condition then raise notice 'PASS  %', label;
  else raise exception 'FAIL  %', label; end if;
end $$;

create or replace function pg_temp.affects(label text, statement text, expected integer) returns void
language plpgsql as $$
declare n integer;
begin
  execute statement;
  get diagnostics n = row_count;
  if n = expected then raise notice 'PASS  % (% row(s))', label, n;
  else raise exception 'FAIL  % — expected % row(s), got %', label, expected, n; end if;
end $$;

create or replace function pg_temp.refused(label text, statement text) returns void
language plpgsql as $$
begin
  begin
    execute statement;
  exception when others then
    raise notice 'PASS  % (refused: %)', label, left(sqlerrm, 60);
    return;
  end;
  raise exception 'FAIL  % — the statement was allowed', label;
end $$;

-- ================================================ tenant isolation
set local role authenticated;
set local test.uid = '11111111-1111-1111-1111-111111111111';

select pg_temp.check('an owner sees their own evidence',
  (select count(*) from public.evidence_items) = 1);
select pg_temp.check('another organization''s evidence is invisible',
  (select count(*) from public.evidence_items where property_id = 'bbbbbbbb-0000-0000-0000-000000000002') = 0);
select pg_temp.check('another organization''s property is invisible',
  (select count(*) from public.properties) = 1);

set local test.uid = '44444444-4444-4444-4444-444444444444';
select pg_temp.check('the other tenant sees only their own',
  (select count(*) from public.evidence_items) = 1
  and (select count(*) from public.evidence_items where id = 'dddddddd-0000-0000-0000-000000000001') = 0);

-- ================================================ evidence immutability
set local test.uid = '22222222-2222-2222-2222-222222222222';
select pg_temp.affects('a contributor can still correct metadata',
  $$update public.evidence_items set media_type = 'Corrected'
    where id = 'dddddddd-0000-0000-0000-000000000001'$$, 1);

select pg_temp.refused('a contributor cannot delete evidence',
  $$select public.soft_delete_evidence('dddddddd-0000-0000-0000-000000000001')$$);
-- Belt and braces: the trigger refuses the same thing even without the RPC.
select pg_temp.refused('a contributor cannot delete evidence by writing the column directly',
  $$update public.evidence_items set deleted_at = now() where id = 'dddddddd-0000-0000-0000-000000000001'$$);

select pg_temp.refused('nobody can repoint stored bytes',
  $$update public.evidence_items set storage_path = 'somewhere/else.jpg' where id = 'dddddddd-0000-0000-0000-000000000001'$$);

select pg_temp.affects('no role may hard-delete evidence',
  $$delete from public.evidence_items where id = 'dddddddd-0000-0000-0000-000000000001'$$, 0);

set local test.uid = '11111111-1111-1111-1111-111111111111';
select pg_temp.check('an owner can delete evidence',
  public.soft_delete_evidence('dddddddd-0000-0000-0000-000000000001', 'wrong room') = true);
select pg_temp.check('the deletion wrote itself into the trail, with the reason',
  (select detail->>'reason' from public.audit_events where action = 'evidence.deleted') = 'wrong room');
select pg_temp.check('and it says the file itself was kept',
  (select detail->>'object_retained' from public.audit_events where action = 'evidence.deleted') = 'true');

select pg_temp.check('deleted evidence leaves every list',
  (select count(*) from public.evidence_items) = 0);

select pg_temp.check('an owner can still see what was deleted, on purpose',
  (select count(*) from public.deleted_evidence('bbbbbbbb-0000-0000-0000-000000000001')) = 1);

-- Separate statements on purpose: one query sees one snapshot, so a restore and
-- a count in the same statement would read the world as it was before the call.
select public.restore_evidence('dddddddd-0000-0000-0000-000000000001');
select pg_temp.check('and can bring it back',
  (select count(*) from public.evidence_items) = 1);

select pg_temp.check('restoring is recorded too',
  (select count(*) from public.audit_events where action = 'evidence.restored') = 1);

select pg_temp.check('an owner deletes it again for the checks that follow',
  public.soft_delete_evidence('dddddddd-0000-0000-0000-000000000001') = true);

set local test.uid = '33333333-3333-3333-3333-333333333333';
select pg_temp.refused('a reviewer cannot delete evidence either',
  $$select public.soft_delete_evidence('dddddddd-0000-0000-0000-000000000001')$$);
set local test.uid = '11111111-1111-1111-1111-111111111111';

reset role;
select pg_temp.check('the row and the object reference survive the deletion',
  (select storage_path from public.evidence_items
    where id = 'dddddddd-0000-0000-0000-000000000001')
  = 'organizations/a/properties/b/evidence/one.jpg'
  and (select deleted_by from public.evidence_items
        where id = 'dddddddd-0000-0000-0000-000000000001')
      = '11111111-1111-1111-1111-111111111111');
set local role authenticated;
set local test.uid = '11111111-1111-1111-1111-111111111111';

-- ================================================ the audit trail
reset role;
select pg_temp.check('every membership grant wrote itself down',
  (select count(*) from public.audit_events where action = 'member.added') = 4);

insert into public.analysis_jobs(id, organization_id, property_id, state, profile, profile_version,
  evidence_ids, requested_by)
values ('eeeeeeee-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001',
  'bbbbbbbb-0000-0000-0000-000000000001','queued','room_interpretation','1',
  array['dddddddd-0000-0000-0000-000000000001']::uuid[],'11111111-1111-1111-1111-111111111111');
update public.analysis_jobs set state = 'completed', model_version = 'gpt-x-2026-01-01',
  prompt_fingerprint = 'abc123' where id = 'eeeeeeee-0000-0000-0000-000000000001';

select pg_temp.check('an AI run records both its start and its end',
  (select count(*) from public.audit_events where action = 'analysis.queued') = 1
  and (select count(*) from public.audit_events where action = 'analysis.completed') = 1);

select pg_temp.check('the model that answered is recorded, not only the one requested',
  (select detail->>'model_version' from public.audit_events
    where action = 'analysis.completed') = 'gpt-x-2026-01-01');

insert into public.ai_suggestions(id, organization_id, job_id, property_id, suggestion_type,
  body, evidence_ids, layer)
values ('ffffffff-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001',
  'eeeeeeee-0000-0000-0000-000000000001','bbbbbbbb-0000-0000-0000-000000000001',
  'room_interpretation','{}'::jsonb, array['dddddddd-0000-0000-0000-000000000001']::uuid[],'interpretation');

insert into public.suggestion_reviews(organization_id, suggestion_id, state, reviewed_by)
values ('aaaaaaaa-0000-0000-0000-000000000001','ffffffff-0000-0000-0000-000000000001',
  'confirmed','33333333-3333-3333-3333-333333333333');

select pg_temp.check('a human decision writes itself into the trail',
  (select count(*) from public.audit_events where action = 'decision.made') = 1);

update public.suggestion_reviews set state = 'rejected'
  where suggestion_id = 'ffffffff-0000-0000-0000-000000000001';
select pg_temp.check('changing a decision records what it was before',
  (select detail->>'previous_state' from public.audit_events
    where action = 'decision.changed') = 'confirmed');

select pg_temp.refused('an audit entry cannot be edited, even by the owner of the database',
  $$update public.audit_events set action = 'nothing.happened' where action = 'decision.made'$$);
select pg_temp.refused('an audit entry cannot be deleted',
  $$delete from public.audit_events where action = 'decision.made'$$);

-- ================================================ AI cannot decide
select pg_temp.check('a decision requires a real account',
  (select attnotnull from pg_attribute
    where attrelid = 'public.suggestion_reviews'::regclass and attname = 'reviewed_by'));
select pg_temp.refused('a decision cannot be authored by nobody',
  $$insert into public.suggestion_reviews(organization_id, suggestion_id, state, reviewed_by)
    values ('aaaaaaaa-0000-0000-0000-000000000001','ffffffff-0000-0000-0000-000000000001','confirmed',null)$$);

-- ================================================ project-scoped access
set local role authenticated;
set local test.uid = '44444444-4444-4444-4444-444444444444';
select pg_temp.check('with property_members empty, access is exactly organization access',
  public.can_access_property('bbbbbbbb-0000-0000-0000-000000000001') = false
  and public.can_access_property('bbbbbbbb-0000-0000-0000-000000000002') = true);

reset role;
insert into public.property_members(property_id, user_id, organization_id, role)
values ('bbbbbbbb-0000-0000-0000-000000000001','44444444-4444-4444-4444-444444444444',
        'aaaaaaaa-0000-0000-0000-000000000001','external_reviewer');

set local role authenticated;
set local test.uid = '44444444-4444-4444-4444-444444444444';
select pg_temp.check('naming someone on a project grants them that project',
  public.can_access_property('bbbbbbbb-0000-0000-0000-000000000001') = true);
select pg_temp.check('and the role they hold there is the one they were given',
  public.property_role('bbbbbbbb-0000-0000-0000-000000000001')::text = 'external_reviewer');

reset role;
update public.property_members set expires_at = now() - interval '1 day'
  where user_id = '44444444-4444-4444-4444-444444444444';
set local role authenticated;
set local test.uid = '44444444-4444-4444-4444-444444444444';
select pg_temp.check('an expired grant is not a grant',
  public.can_access_property('bbbbbbbb-0000-0000-0000-000000000001') = false);

-- ================================================ projects and spaces
set local role authenticated;
set local test.uid = '22222222-2222-2222-2222-222222222222';
select pg_temp.affects('a contributor cannot delete a whole project',
  $$delete from public.properties where id = 'bbbbbbbb-0000-0000-0000-000000000001'$$, 0);
select pg_temp.refused('nor remove it any other way',
  $$select public.soft_delete_project('bbbbbbbb-0000-0000-0000-000000000001')$$);

set local test.uid = '11111111-1111-1111-1111-111111111111';
select pg_temp.affects('nor can an owner delete a project outright',
  $$delete from public.properties where id = 'bbbbbbbb-0000-0000-0000-000000000001'$$, 0);

reset role;
-- Give the space something to hold, so the guard has something to defend.
insert into public.evidence_items(id, organization_id, property_id, space_id, storage_path,
  original_filename, media_type, mime_type, byte_size, created_by)
values ('dddddddd-0000-0000-0000-000000000003','aaaaaaaa-0000-0000-0000-000000000001',
  'bbbbbbbb-0000-0000-0000-000000000001','cccccccc-0000-0000-0000-000000000001',
  'organizations/a/properties/b/evidence/three.jpg','three.jpg','Property evidence','image/jpeg',512,
  '11111111-1111-1111-1111-111111111111');

set local role authenticated;
set local test.uid = '11111111-1111-1111-1111-111111111111';
select pg_temp.refused('a space holding evidence cannot be deleted, whatever the browser thinks',
  $$delete from public.spaces where id = 'cccccccc-0000-0000-0000-000000000001'$$);

select pg_temp.check('an owner can remove a project, and it says what was inside',
  public.soft_delete_project('bbbbbbbb-0000-0000-0000-000000000001', 'duplicate') = true);
select pg_temp.check('the removed project leaves every list',
  (select count(*) from public.properties
    where id = 'bbbbbbbb-0000-0000-0000-000000000001') = 0);
select pg_temp.check('and the entry names what it contained at that moment',
  (select detail->>'evidence_count' from public.audit_events where action = 'project.removed') = '1'
  and (select detail->>'everything_retained' from public.audit_events where action = 'project.removed') = 'true');
select public.restore_project('bbbbbbbb-0000-0000-0000-000000000001');
select pg_temp.check('and it comes back whole',
  (select count(*) from public.properties where id = 'bbbbbbbb-0000-0000-0000-000000000001') = 1
  and (select count(*) from public.evidence_items where space_id = 'cccccccc-0000-0000-0000-000000000001') = 1);

-- ================================================ the client's narrow door
select pg_temp.check('a client may record the events it is allowed to record',
  public.record_client_event('bbbbbbbb-0000-0000-0000-000000000001','report.generated','{"scope":"project"}'::jsonb) = true);
select pg_temp.refused('and cannot invent one',
  $$select public.record_client_event('bbbbbbbb-0000-0000-0000-000000000001','evidence.purged','{}'::jsonb)$$);
set local test.uid = '44444444-4444-4444-4444-444444444444';
select pg_temp.refused('nor write into a project it has no part in',
  $$select public.record_client_event('bbbbbbbb-0000-0000-0000-000000000001','report.generated','{}'::jsonb)$$);
set local test.uid = '11111111-1111-1111-1111-111111111111';
reset role;
select pg_temp.check('a recorded client event is attributed to the person who caused it',
  (select actor_id from public.audit_events where action = 'report.generated')
  = '11111111-1111-1111-1111-111111111111');

-- ================================================ the signed-out caller
-- Every policy in this project is written without a TO clause, so Postgres
-- applies it TO PUBLIC and the Supabase dashboard prints "public" beside each
-- one. That reads alarming and is not: a permissive policy grants only the rows
-- its USING expression admits, and every USING here resolves through auth.uid().
-- For somebody signed out that is null, so the expression admits nothing.
--
-- Asserted rather than argued, because "it should be fine" is not a control.
set local role anon;
set local test.uid = '';
select pg_temp.check('a signed-out caller sees no evidence',
  (select count(*) from public.evidence_items) = 0);
select pg_temp.check('no projects',
  (select count(*) from public.properties) = 0);
select pg_temp.check('no rooms',
  (select count(*) from public.spaces) = 0);
select pg_temp.check('no AI findings',
  (select count(*) from public.ai_suggestions) = 0);
select pg_temp.check('no decisions',
  (select count(*) from public.suggestion_reviews) = 0);
select pg_temp.check('no audit trail',
  (select count(*) from public.audit_events) = 0);
select pg_temp.check('no organizations, and no member list to enumerate',
  (select count(*) from public.organizations) = 0
  and (select count(*) from public.organization_members) = 0);
select pg_temp.check('and no analysis jobs',
  (select count(*) from public.analysis_jobs) = 0);

-- A forged uid is a guess at somebody else's identity, not an identity. In
-- production auth.uid() comes from a signature-verified token and cannot be set
-- at all; here it can, which makes the check worth writing.
set local role authenticated;
set local test.uid = '99999999-9999-9999-9999-999999999999';
select pg_temp.check('a signed-in stranger sees nothing either',
  (select count(*) from public.evidence_items) = 0
  and (select count(*) from public.properties) = 0);
reset role;

-- ================================================ privileged helpers
reset role;
select pg_temp.check('record_audit_event is not reachable from the browser',
  not has_function_privilege('authenticated',
    'public.record_audit_event(uuid,text,text,text,uuid,uuid,text,text,jsonb,text,text,text)', 'execute')
  and not has_function_privilege('anon',
    'public.record_audit_event(uuid,text,text,text,uuid,uuid,text,text,jsonb,text,text,text)', 'execute'));

-- Revoking EXECUTE on a trigger function removes its REST endpoint. It must not
-- also remove the trigger, or every write in the product stops working.
select pg_temp.check('trigger functions are not reachable as REST endpoints',
  not has_function_privilege('authenticated', 'public.guard_evidence_deletion()', 'execute')
  and not has_function_privilege('anon', 'public.audit_decision_change()', 'execute')
  and not has_function_privilege('authenticated', 'public.audit_events_are_append_only()', 'execute'));

set local role authenticated;
set local test.uid = '22222222-2222-2222-2222-222222222222';
select pg_temp.affects('and the triggers still fire without it',
  $$update public.evidence_items set media_type = 'Still guarded'
    where id = 'dddddddd-0000-0000-0000-000000000003'$$, 1);
select pg_temp.refused('including the one that refuses a delete',
  $$update public.evidence_items set deleted_at = now() where id = 'dddddddd-0000-0000-0000-000000000003'$$);
reset role;

select pg_temp.check('the policy helpers stay callable, or every read would fail',
  has_function_privilege('authenticated', 'public.is_org_member(uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.has_org_role(uuid, public.studio_role[])', 'execute'));

select pg_temp.check('but nothing signed out can ask about project access',
  not has_function_privilege('anon', 'public.can_access_property(uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.can_access_property(uuid)', 'execute'));

select pg_temp.check('every table in public enforces row-level security',
  (select count(*) from pg_tables t
    where t.schemaname = 'public'
      and not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                      where n.nspname = 'public' and c.relname = t.tablename and c.relrowsecurity)) = 0);

-- ================================= starting the machine on its own
--
-- The record of every wake request is where a runaway bill becomes visible, so
-- it has to be readable by the people paying it and by nobody else.

insert into public.machine_wake_events(requested_by_kind, instance_id, outcome, queued_jobs, detail)
values ('upload', 'i-test', 'started', 3, '3 captures waiting');

-- Setting the role without clearing the identity leaves auth.uid() answering
-- with whoever ran the previous block, and "anon" then reads as a signed-in
-- member. The first draft of this check passed for that reason.
set local role anon;
set local test.uid = '';
select pg_temp.check('a signed-out caller cannot watch the machine',
  (select count(*) from public.machine_wake_events) = 0);
reset role;

-- A member of a different organisation still sees it, and that is the intent:
-- the machine is shared infrastructure rather than one customer's possession,
-- and the row carries no evidence and no customer text — only its own state.
set local role authenticated;
set local test.uid = '44444444-4444-4444-4444-444444444444';
select pg_temp.check('another organisation sees the shared machine, not its work',
  (select count(*) from public.machine_wake_events) = 1
  and (select count(*) from public.evidence_items
       where organization_id = 'aaaaaaaa-0000-0000-0000-000000000001') = 0);
reset role;

set local role authenticated;
set local test.uid = '11111111-1111-1111-1111-111111111111';
select pg_temp.check('a Studio member sees what the machine was asked to do',
  (select count(*) from public.machine_wake_events) = 1);
reset role;

-- ============================ accepting a capture that will never be made
--
-- Whole phases finish before anybody starts keeping a record. Demolition on a
-- house bought mid-project is the ordinary case. A manager has to be able to
-- close that gap for good — and the record has to keep saying the evidence
-- does not exist, name who accepted that, and say why.

set local role authenticated;
set local test.uid = '22222222-2222-2222-2222-222222222222';
select pg_temp.refused('a contributor cannot accept a missing capture',
  $$select public.waive_capture_task('ffffffff-0000-0000-0000-0000000000aa',
      'accepted_no_evidence', 'The demolition finished before we were engaged')$$);
reset role;

set local role authenticated;
set local test.uid = '11111111-1111-1111-1111-111111111111';
select pg_temp.refused('and nobody can accept one without saying why',
  $$select public.waive_capture_task('ffffffff-0000-0000-0000-0000000000aa',
      'accepted_no_evidence', 'n/a')$$);
select pg_temp.refused('nor invent a kind of acceptance',
  $$select public.waive_capture_task('ffffffff-0000-0000-0000-0000000000aa',
      'never_mind', 'The demolition finished before we were engaged')$$);
reset role;

set local role authenticated;
set local test.uid = '11111111-1111-1111-1111-111111111111';
select pg_temp.affects('an owner accepts it, with a reason',
  $$select public.waive_capture_task('ffffffff-0000-0000-0000-0000000000aa',
      'accepted_no_evidence', 'Demolition completed before this record began')$$, 1);
reset role;

select pg_temp.check('the record keeps saying no evidence exists, and names who accepted that',
  (select status from public.capture_tasks where id = 'ffffffff-0000-0000-0000-0000000000aa') = 'waived'
  and (select waived_by from public.capture_tasks where id = 'ffffffff-0000-0000-0000-0000000000aa')
      = '11111111-1111-1111-1111-111111111111'
  and (select waiver_reason from public.capture_tasks where id = 'ffffffff-0000-0000-0000-0000000000aa')
      = 'Demolition completed before this record began');

select pg_temp.check('and the acceptance is in the audit trail',
  (select count(*) from public.audit_events
    where action = 'capture_task.waived'
      and entity_id = 'ffffffff-0000-0000-0000-0000000000aa') = 1);

-- Evidence that exists is not a gap. Accepting one here would bury a real
-- record behind a sentence claiming none was made.
insert into public.evidence_items(id, organization_id, property_id, space_id, storage_path,
  original_filename, media_type, mime_type, byte_size, created_by, source_type, capture_task_id)
values ('dddddddd-0000-0000-0000-00000000000f','aaaaaaaa-0000-0000-0000-000000000001',
  'bbbbbbbb-0000-0000-0000-000000000001','cccccccc-0000-0000-0000-000000000001',
  'organizations/a/properties/b/evidence/demo.jpg','demo.jpg','Property evidence','image/jpeg',
  512,'11111111-1111-1111-1111-111111111111','phone','ffffffff-0000-0000-0000-0000000000bb');

set local role authenticated;
set local test.uid = '11111111-1111-1111-1111-111111111111';
select pg_temp.refused('a capture that already holds evidence cannot be accepted as missing',
  $$select public.waive_capture_task('ffffffff-0000-0000-0000-0000000000bb',
      'accepted_no_evidence', 'We never captured this one either')$$);

select pg_temp.affects('an acceptance can be withdrawn',
  $$select public.lift_capture_waiver('ffffffff-0000-0000-0000-0000000000aa',
      'The site photographer found the demolition set')$$, 1);
reset role;

select pg_temp.check('and the capture returns to the roadmap, carrying no trace of acceptance',
  (select status from public.capture_tasks where id = 'ffffffff-0000-0000-0000-0000000000aa') = 'blocked'
  and (select waiver_reason from public.capture_tasks where id = 'ffffffff-0000-0000-0000-0000000000aa') is null);

select pg_temp.check('while the withdrawal itself stays on the record',
  (select count(*) from public.audit_events
    where action = 'capture_task.waiver_lifted'
      and entity_id = 'ffffffff-0000-0000-0000-0000000000aa') = 1);

-- ================================================= finding things in the record

-- Inserted here rather than with the other fixtures: assertions above count
-- the evidence in the project, and a second row makes them fail. A fixture that
-- breaks an unrelated invariant is a fixture in the wrong place.
-- Something to search for: a capture with a name, a room, an AI reading nobody
-- has confirmed, and a plan document.
insert into public.evidence_items(id, organization_id, property_id, space_id, storage_path,
  original_filename, media_type, mime_type, byte_size, created_by, source_type, captured_at)
values ('dddddddd-0000-0000-0000-0000000000f1','aaaaaaaa-0000-0000-0000-000000000001',
  'bbbbbbbb-0000-0000-0000-000000000001','cccccccc-0000-0000-0000-000000000001',
  'organizations/a/properties/b/evidence/garage-framing-vr-master.mp4',
  'garage-framing-vr-master.mp4','360 capture','video/mp4',4096,
  '11111111-1111-1111-1111-111111111111','derived','2026-08-20T10:00:00Z');

insert into public.analysis_jobs(id, organization_id, property_id, space_id, state, profile,
  profile_version, evidence_ids, requested_by)
values ('aaaa0000-0000-0000-0000-0000000000a1','aaaaaaaa-0000-0000-0000-000000000001',
  'bbbbbbbb-0000-0000-0000-000000000001','cccccccc-0000-0000-0000-000000000001','completed',
  'room_interpretation','1', array['dddddddd-0000-0000-0000-0000000000f1']::uuid[],
  '11111111-1111-1111-1111-111111111111');

insert into public.ai_suggestions(id, organization_id, job_id, property_id, space_id,
  suggestion_type, body, evidence_ids)
values ('aaaa0000-0000-0000-0000-0000000000b1','aaaaaaaa-0000-0000-0000-000000000001',
  'aaaa0000-0000-0000-0000-0000000000a1','bbbbbbbb-0000-0000-0000-000000000001',
  'cccccccc-0000-0000-0000-000000000001','room_interpretation',
  jsonb_build_object('summary','Framing is complete and drywall has not started',
    'observations', jsonb_build_array('Studs exposed on the north wall'),
    'questions', jsonb_build_array('Was the window replaced')),
  array['dddddddd-0000-0000-0000-0000000000f1']::uuid[]);

--
-- One question, one answer, with the thing itself attached. What matters as
-- much as finding things is what it refuses to do: it finds, it does not
-- conclude, and an AI reading stays marked unconfirmed wherever it surfaces.

set local role authenticated;
set local test.uid = '11111111-1111-1111-1111-111111111111';

select pg_temp.check('a filename is findable',
  exists(select 1 from public.search_project_record('bbbbbbbb-0000-0000-0000-000000000001', 'framing')
         where kind = 'evidence' and title = 'garage-framing-vr-master.mp4'));

-- Somebody typing "205A" or "gara" means exactly that, so substring matching
-- has to work alongside the stemmed search.
select pg_temp.check('and so is a fragment of one',
  exists(select 1 from public.search_project_record('bbbbbbbb-0000-0000-0000-000000000001', 'gara')
         where kind = 'evidence'));

select pg_temp.check('the room itself is a result, not only the files in it',
  exists(select 1 from public.search_project_record('bbbbbbbb-0000-0000-0000-000000000001', 'Garage')
         where kind = 'room'));

-- The AI's prose needs stemming: "drywall" is in the summary, "framed" is not,
-- but "framing" must reach a sentence that says "Framing".
select pg_temp.check('what the AI read is findable by its words',
  exists(select 1 from public.search_project_record('bbbbbbbb-0000-0000-0000-000000000001', 'drywall')
         where kind = 'finding'));

select pg_temp.check('including the questions it left open',
  exists(select 1 from public.search_project_record('bbbbbbbb-0000-0000-0000-000000000001', 'window replaced')
         where kind = 'finding'));

-- The rule the whole product rests on. A search result is a place an
-- interpretation can escape as a fact, so it carries its status with it.
select pg_temp.check('an unconfirmed interpretation says so',
  (select confirmed from public.search_project_record('bbbbbbbb-0000-0000-0000-000000000001', 'drywall')
    where kind = 'finding' limit 1) = false);

insert into public.suggestion_reviews(organization_id, suggestion_id, state, reviewed_by)
values ('aaaaaaaa-0000-0000-0000-000000000001','aaaa0000-0000-0000-0000-0000000000b1',
  'confirmed','11111111-1111-1111-1111-111111111111');

select pg_temp.check('and a confirmed one says that instead',
  (select confirmed from public.search_project_record('bbbbbbbb-0000-0000-0000-000000000001', 'drywall')
    where kind = 'finding' limit 1) = true);

select pg_temp.check('a query that matches nothing returns nothing, not everything',
  (select count(*) from public.search_project_record('bbbbbbbb-0000-0000-0000-000000000001', 'zzzzznotathing')) = 0);

-- A single letter would match most of the record and answer nothing.
select pg_temp.check('and too short a query is refused rather than guessed at',
  (select count(*) from public.search_project_record('bbbbbbbb-0000-0000-0000-000000000001', 'a')) = 0);

-- Deleted evidence is out of the record, so it is out of the search. Removed
-- the way the product removes it: a plain UPDATE setting deleted_at is refused,
-- because the read policy hides the new row from its own author.
select public.soft_delete_evidence('dddddddd-0000-0000-0000-0000000000f1', 'no longer part of the record');
select pg_temp.check('removed evidence does not come back through search',
  not exists(select 1 from public.search_project_record('bbbbbbbb-0000-0000-0000-000000000001', 'framing')
             where kind = 'evidence'));
reset role;

-- The function is a definer, so it bypasses row-level security and has to do
-- the checking itself. This is the assertion that says it does.
set local role authenticated;
set local test.uid = '44444444-4444-4444-4444-444444444444';
select pg_temp.refused('another organisation cannot search this project',
  $$select * from public.search_project_record('bbbbbbbb-0000-0000-0000-000000000001', 'framing')$$);
reset role;

set local role anon;
set local test.uid = '';
select pg_temp.refused('nor can anybody signed out',
  $$select * from public.search_project_record('bbbbbbbb-0000-0000-0000-000000000001', 'framing')$$);
reset role;

--
-- Walking the project. The plans say which rooms open into which; that is a
-- fact drawn on a sheet, and it is still only a reading until a person says so.
-- What is asserted here is the whole of that rule, plus the one case that is
-- easy to get wrong by being tidy: a route to a room the record does not have
-- must still come back, saying so, because dropping it reads as "there is no
-- door there" — a different statement, and an untrue one.

insert into public.plan_spaces(id, organization_id, property_id, baseline_id, building, level, name)
values
  ('a1a1a1a1-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001',
   'bbbbbbbb-0000-0000-0000-000000000001','eeeeeeee-0000-0000-0000-000000000001','Main House','Level 1','Hall'),
  ('a1a1a1a1-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001',
   'bbbbbbbb-0000-0000-0000-000000000001','eeeeeeee-0000-0000-0000-000000000001','Main House','Level 1','Kitchen'),
  ('a1a1a1a1-0000-0000-0000-000000000003','aaaaaaaa-0000-0000-0000-000000000001',
   'bbbbbbbb-0000-0000-0000-000000000001','eeeeeeee-0000-0000-0000-000000000001','Main House','Level 2','Attic');

insert into public.spaces(id, organization_id, property_id, name, created_by, plan_space_id) values
  ('cccccccc-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001',
   'bbbbbbbb-0000-0000-0000-000000000001','Hall','11111111-1111-1111-1111-111111111111',
   'a1a1a1a1-0000-0000-0000-000000000001'),
  ('cccccccc-0000-0000-0000-000000000003','aaaaaaaa-0000-0000-0000-000000000001',
   'bbbbbbbb-0000-0000-0000-000000000001','Kitchen','11111111-1111-1111-1111-111111111111',
   'a1a1a1a1-0000-0000-0000-000000000002');
-- The attic is on the plans and nowhere in the record. That is the case.

update public.properties set active_baseline_id = 'eeeeeeee-0000-0000-0000-000000000001'
 where id = 'bbbbbbbb-0000-0000-0000-000000000001';

insert into public.plan_space_links(
  id, organization_id, property_id, baseline_id,
  from_plan_space_id, to_plan_space_id, connection, source_refs)
values
  ('a2a2a2a2-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001',
   'bbbbbbbb-0000-0000-0000-000000000001','eeeeeeee-0000-0000-0000-000000000001',
   least('a1a1a1a1-0000-0000-0000-000000000001'::uuid,'a1a1a1a1-0000-0000-0000-000000000002'::uuid),
   greatest('a1a1a1a1-0000-0000-0000-000000000001'::uuid,'a1a1a1a1-0000-0000-0000-000000000002'::uuid),
   'door', '["A-101"]'::jsonb),
  ('a2a2a2a2-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001',
   'bbbbbbbb-0000-0000-0000-000000000001','eeeeeeee-0000-0000-0000-000000000001',
   least('a1a1a1a1-0000-0000-0000-000000000001'::uuid,'a1a1a1a1-0000-0000-0000-000000000003'::uuid),
   greatest('a1a1a1a1-0000-0000-0000-000000000001'::uuid,'a1a1a1a1-0000-0000-0000-000000000003'::uuid),
   'stairs', '["A-102"]'::jsonb);

-- One door is one row, whichever way round somebody writes it.
select pg_temp.refused('the same opening cannot be recorded twice',
  $$insert into public.plan_space_links(organization_id, property_id, baseline_id,
      from_plan_space_id, to_plan_space_id, connection)
    values ('aaaaaaaa-0000-0000-0000-000000000001','bbbbbbbb-0000-0000-0000-000000000001',
      'eeeeeeee-0000-0000-0000-000000000001',
      least('a1a1a1a1-0000-0000-0000-000000000001'::uuid,'a1a1a1a1-0000-0000-0000-000000000002'::uuid),
      greatest('a1a1a1a1-0000-0000-0000-000000000001'::uuid,'a1a1a1a1-0000-0000-0000-000000000002'::uuid),
      'door')$$);

select pg_temp.refused('nor recorded backwards to get around that',
  $$insert into public.plan_space_links(organization_id, property_id, baseline_id,
      from_plan_space_id, to_plan_space_id, connection)
    values ('aaaaaaaa-0000-0000-0000-000000000001','bbbbbbbb-0000-0000-0000-000000000001',
      'eeeeeeee-0000-0000-0000-000000000001',
      greatest('a1a1a1a1-0000-0000-0000-000000000001'::uuid,'a1a1a1a1-0000-0000-0000-000000000002'::uuid),
      least('a1a1a1a1-0000-0000-0000-000000000001'::uuid,'a1a1a1a1-0000-0000-0000-000000000002'::uuid),
      'door')$$);

select pg_temp.refused('and a room does not open into itself',
  $$insert into public.plan_space_links(organization_id, property_id, baseline_id,
      from_plan_space_id, to_plan_space_id)
    values ('aaaaaaaa-0000-0000-0000-000000000001','bbbbbbbb-0000-0000-0000-000000000001',
      'eeeeeeee-0000-0000-0000-000000000001',
      'a1a1a1a1-0000-0000-0000-000000000001','a1a1a1a1-0000-0000-0000-000000000001')$$);

set local role authenticated;
set local test.uid = '11111111-1111-1111-1111-111111111111';

select pg_temp.check('an owner can see how the project connects',
  (select count(*) from public.project_space_links('bbbbbbbb-0000-0000-0000-000000000001')) = 2);

-- The rule the whole product rests on, in one more place it could escape.
select pg_temp.check('a route the AI read is not confirmed by being read',
  (select bool_and(state = 'suggested')
     from public.project_space_links('bbbbbbbb-0000-0000-0000-000000000001')));

select pg_temp.check('the walkable route names both rooms as the record holds them',
  exists(select 1 from public.project_space_links('bbbbbbbb-0000-0000-0000-000000000001')
          where from_room_name = 'Hall' and to_room_name = 'Kitchen' and connection = 'door'));

select pg_temp.check('and it carries the sheet it was read from',
  (select source_refs from public.project_space_links('bbbbbbbb-0000-0000-0000-000000000001')
    where connection = 'door') = '["A-101"]'::jsonb);

-- The tidy version of this function would drop this row and show three rooms
-- neatly joined. That would be the plans saying one thing and the screen saying
-- another, with nobody told.
select pg_temp.check('a route to a room the record does not have is still returned',
  exists(select 1 from public.project_space_links('bbbbbbbb-0000-0000-0000-000000000001')
          where to_plan_name = 'Attic' and to_room_id is null));

select pg_temp.check('and the room that is there says how much evidence it holds',
  (select from_evidence_count from public.project_space_links('bbbbbbbb-0000-0000-0000-000000000001')
    where connection = 'door') = 0);

set local test.uid = '22222222-2222-2222-2222-222222222222';
select pg_temp.refused('a contributor cannot confirm how rooms connect',
  $$select public.review_space_link('a2a2a2a2-0000-0000-0000-000000000001', 'confirmed')$$);
select pg_temp.refused('nor invent a verdict',
  $$select public.review_space_link('a2a2a2a2-0000-0000-0000-000000000001', 'probably')$$);
-- Writes are server-owned; there is no insert policy, by design.
select pg_temp.refused('nor draw a door straight into the table',
  $$insert into public.plan_space_links(organization_id, property_id, baseline_id,
      from_plan_space_id, to_plan_space_id)
    values ('aaaaaaaa-0000-0000-0000-000000000001','bbbbbbbb-0000-0000-0000-000000000001',
      'eeeeeeee-0000-0000-0000-000000000001',
      least('a1a1a1a1-0000-0000-0000-000000000002'::uuid,'a1a1a1a1-0000-0000-0000-000000000003'::uuid),
      greatest('a1a1a1a1-0000-0000-0000-000000000002'::uuid,'a1a1a1a1-0000-0000-0000-000000000003'::uuid))$$);

set local test.uid = '33333333-3333-3333-3333-333333333333';
select public.review_space_link('a2a2a2a2-0000-0000-0000-000000000001', 'confirmed', 'walked it');
select pg_temp.check('a reviewer can, and the record names them',
  exists(select 1 from public.plan_space_links
          where id = 'a2a2a2a2-0000-0000-0000-000000000001'
            and state = 'confirmed'
            and reviewed_by = '33333333-3333-3333-3333-333333333333'
            and reviewed_at is not null));

-- The audit trail is readable by owners and administrators only, so the
-- reviewer who just confirmed the route cannot see their own entry. That is the
-- existing rule, and worth stating here rather than working around.
select pg_temp.check('the reviewer who confirmed it cannot read the audit trail',
  (select count(*) from public.audit_events where action = 'space_link.confirmed') = 0);
set local test.uid = '11111111-1111-1111-1111-111111111111';
select pg_temp.check('and the confirmation is in the audit trail',
  exists(select 1 from public.audit_events
          where action = 'space_link.confirmed'
            and entity_id = 'a2a2a2a2-0000-0000-0000-000000000001'
            and detail->>'note' = 'walked it'));
set local test.uid = '33333333-3333-3333-3333-333333333333';

-- A door the plans show that is not there is a wrong turn in a headset, so
-- rejecting one has to take it out of the walk rather than grey it out.
select public.review_space_link('a2a2a2a2-0000-0000-0000-000000000002', 'rejected');
select pg_temp.check('a rejected route is not walkable',
  (select count(*) from public.project_space_links('bbbbbbbb-0000-0000-0000-000000000001')) = 1);

-- Somebody who knows the building can say a door exists that the plans missed.
select public.add_space_link('cccccccc-0000-0000-0000-000000000002',
                             'cccccccc-0000-0000-0000-000000000003', 'opening');
select pg_temp.check('a person saying a door is there confirms the one already read',
  (select count(*) from public.plan_space_links
    where property_id = 'bbbbbbbb-0000-0000-0000-000000000001' and state = 'confirmed') = 1);

-- A room somebody typed in by hand has no place on the plan set. Saying that is
-- better than connecting it to something and being wrong.
insert into public.spaces(id, organization_id, property_id, name, created_by) values
  ('cccccccc-0000-0000-0000-000000000004','aaaaaaaa-0000-0000-0000-000000000001',
   'bbbbbbbb-0000-0000-0000-000000000001','Shed','33333333-3333-3333-3333-333333333333');
select pg_temp.refused('a room that is not on the plan set cannot be connected yet',
  $$select public.add_space_link('cccccccc-0000-0000-0000-000000000002',
                                 'cccccccc-0000-0000-0000-000000000004', 'door')$$);
select pg_temp.refused('and a room does not open into itself here either',
  $$select public.add_space_link('cccccccc-0000-0000-0000-000000000002',
                                 'cccccccc-0000-0000-0000-000000000002', 'door')$$);
reset role;

set local role authenticated;
set local test.uid = '44444444-4444-4444-4444-444444444444';
select pg_temp.refused('another organisation cannot see how this project connects',
  $$select * from public.project_space_links('bbbbbbbb-0000-0000-0000-000000000001')$$);
select pg_temp.refused('nor confirm a route in it',
  $$select public.review_space_link('a2a2a2a2-0000-0000-0000-000000000001', 'rejected')$$);
reset role;

set local role anon;
set local test.uid = '';
select pg_temp.refused('nor can anybody signed out',
  $$select * from public.project_space_links('bbbbbbbb-0000-0000-0000-000000000001')$$);
select pg_temp.check('and the routes themselves are invisible signed out',
  (select count(*) from public.plan_space_links) = 0);
reset role;

--
-- A 360 capture belongs to a room. Two camera originals uploaded into a second
-- room used to merge into the first room's capture group, which kept the first
-- room's space_id — so the second room reported itself empty while its own rows
-- sat in the record with its id on them, and the stitched master would have
-- been filed in the first room too.

insert into public.evidence_items(id, organization_id, property_id, space_id, storage_path,
  original_filename, media_type, mime_type, byte_size, created_by, source_type)
values
  ('caca0000-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001',
   'bbbbbbbb-0000-0000-0000-000000000001','cccccccc-0000-0000-0000-000000000002',
   'org/a/hall/VID_20250222_042646_00_016.insv','VID_20250222_042646_00_016.insv',
   '360 camera original','application/octet-stream',1024,'11111111-1111-1111-1111-111111111111','360_camera'),
  ('caca0000-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001',
   'bbbbbbbb-0000-0000-0000-000000000001','cccccccc-0000-0000-0000-000000000002',
   'org/a/hall/VID_20250222_042646_10_016.insv','VID_20250222_042646_10_016.insv',
   '360 camera original','application/octet-stream',1024,'11111111-1111-1111-1111-111111111111','360_camera'),
  -- The identical capture, uploaded again into a different room.
  ('caca0000-0000-0000-0000-000000000003','aaaaaaaa-0000-0000-0000-000000000001',
   'bbbbbbbb-0000-0000-0000-000000000001','cccccccc-0000-0000-0000-000000000003',
   'org/a/kitchen/VID_20250222_042646_00_016.insv','VID_20250222_042646_00_016.insv',
   '360 camera original','application/octet-stream',1024,'11111111-1111-1111-1111-111111111111','360_camera'),
  ('caca0000-0000-0000-0000-000000000004','aaaaaaaa-0000-0000-0000-000000000001',
   'bbbbbbbb-0000-0000-0000-000000000001','cccccccc-0000-0000-0000-000000000003',
   'org/a/kitchen/VID_20250222_042646_10_016.insv','VID_20250222_042646_10_016.insv',
   '360 camera original','application/octet-stream',1024,'11111111-1111-1111-1111-111111111111','360_camera');

-- The server runs this after every upload, as the service role.
select public.reconcile_insta360_capture('caca0000-0000-0000-0000-000000000001');
select public.reconcile_insta360_capture('caca0000-0000-0000-0000-000000000002');
select public.reconcile_insta360_capture('caca0000-0000-0000-0000-000000000003');
select public.reconcile_insta360_capture('caca0000-0000-0000-0000-000000000004');

select pg_temp.check('the same capture in two rooms is two captures',
  (select count(*) from public.capture_360_groups
    where property_id = 'bbbbbbbb-0000-0000-0000-000000000001'
      and capture_key = 'vid_20250222_042646_016') = 2);

-- The failure exactly: one room's capture holding the other room's originals.
select pg_temp.check('each capture holds only the originals from its own room',
  (select bool_and(cardinality(source_evidence_ids) = 2)
     from public.capture_360_groups
    where capture_key = 'vid_20250222_042646_016'));

select pg_temp.check('and the second room really is one of them',
  exists(select 1 from public.capture_360_groups
          where capture_key = 'vid_20250222_042646_016'
            and space_id = 'cccccccc-0000-0000-0000-000000000003'));

-- A complete pair is what the machine stitches from, so each room gets its own
-- job rather than one room's capture being stitched and the other's forgotten.
select pg_temp.check('both are ready to stitch',
  (select count(*) from public.capture_360_groups
    where capture_key = 'vid_20250222_042646_016' and state = 'ready') = 2);
select pg_temp.check('and each has its own stitch job',
  (select count(*) from public.capture_360_jobs j
     join public.capture_360_groups g on g.id = j.capture_group_id
    where g.capture_key = 'vid_20250222_042646_016') = 2);

-- One lens on its own is not a capture, and saying so is what tells somebody a
-- file is missing rather than silently borrowing one from another room.
insert into public.evidence_items(id, organization_id, property_id, space_id, storage_path,
  original_filename, media_type, mime_type, byte_size, created_by, source_type)
values ('caca0000-0000-0000-0000-000000000005','aaaaaaaa-0000-0000-0000-000000000001',
   'bbbbbbbb-0000-0000-0000-000000000001','cccccccc-0000-0000-0000-000000000001',
   'org/a/garage/VID_20250222_049999_00_099.insv','VID_20250222_049999_00_099.insv',
   '360 camera original','application/octet-stream',1024,'11111111-1111-1111-1111-111111111111','360_camera');
select public.reconcile_insta360_capture('caca0000-0000-0000-0000-000000000005');
select pg_temp.check('a lone lens file waits for its pair instead of joining another room',
  (select state from public.capture_360_groups
    where capture_key = 'vid_20250222_049999_099') = 'waiting_for_pair');

rollback;
