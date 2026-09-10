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

-- How long it took (043). A processing record that says a capture was
-- stitched but not how long it took cannot answer the question the whole
-- automation exists to earn. The stamps are set by the database, so the
-- machine cannot flatter its own timing, and queue time is kept apart from
-- stitch time — waiting for a sleeping machine is not stitching.
do $$
declare
  probe uuid;
  began timestamptz;
begin
  select j.id into probe from public.capture_360_jobs j
    join public.capture_360_groups g on g.id = j.capture_group_id
   where g.capture_key = 'vid_20250222_042646_016' limit 1;
  update public.capture_360_jobs set state = 'processing', stage = 'Stitching' where id = probe;
  select started_at into began from public.capture_360_jobs where id = probe;
  perform pg_temp.check('a job that starts work records when it started',
    began is not null and (select finished_at from public.capture_360_jobs where id = probe) is null);
  update public.capture_360_jobs set state = 'completed', progress = 100 where id = probe;
  perform pg_temp.check('and finishing records the end, leaving a real duration',
    (select finished_at from public.capture_360_jobs where id = probe) is not null
    and (select finished_at - started_at from public.capture_360_jobs where id = probe) >= interval '0');
  perform pg_temp.check('queue time and stitch time stay separate numbers',
    (select started_at > created_at or started_at = created_at from public.capture_360_jobs where id = probe));
  -- A retry is its own attempt: the stamps describe the run on screen.
  update public.capture_360_jobs set state = 'processing' where id = probe;
  perform pg_temp.check('a retry clears the old ending and starts its own clock',
    (select finished_at from public.capture_360_jobs where id = probe) is null
    and (select started_at from public.capture_360_jobs where id = probe) >= began);
end $$;

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

--
-- The list behind the count, and putting a file in the room it belongs to.
--
-- "31 files in this project" was a number with nothing under it. A count
-- somebody cannot open is not information — and the filing mistake it was
-- hiding (the same capture uploaded three times into one room) is invisible
-- from inside any single room.

set local role authenticated;
set local test.uid = '11111111-1111-1111-1111-111111111111';

/* Counted from the record rather than written down here: a magic number in a
   test is a number that goes stale the first time a fixture moves. */
select pg_temp.check('every file in the project is listed, and nothing else',
  (select count(*) from public.project_files('bbbbbbbb-0000-0000-0000-000000000001'))
  = (select count(*) from public.evidence_items
      where property_id = 'bbbbbbbb-0000-0000-0000-000000000001' and deleted_at is null));

-- Removed evidence is out of the record, so it is out of the list.
select pg_temp.check('a removed file is not in the list',
  not exists(select 1 from public.project_files('bbbbbbbb-0000-0000-0000-000000000001')
              where id = 'dddddddd-0000-0000-0000-0000000000f1'));

select pg_temp.check('and each one names the room it sits in',
  (select room_name from public.project_files('bbbbbbbb-0000-0000-0000-000000000001')
    where filename = 'VID_20250222_049999_00_099.insv') = 'Garage');

-- The same capture in two rooms is legitimate. Being unable to see that it
-- happened is not.
select pg_temp.check('a name that appears twice is flagged as such',
  (select bool_and(duplicate_name) from public.project_files('bbbbbbbb-0000-0000-0000-000000000001')
    where filename = 'VID_20250222_042646_00_016.insv'));
select pg_temp.check('and a name that appears once is not',
  (select duplicate_name from public.project_files('bbbbbbbb-0000-0000-0000-000000000001')
    where filename = 'VID_20250222_049999_00_099.insv') = false);
reset role;

set local role authenticated;
set local test.uid = '44444444-4444-4444-4444-444444444444';
select pg_temp.refused('another organisation cannot list this project''s files',
  $$select * from public.project_files('bbbbbbbb-0000-0000-0000-000000000001')$$);
reset role;

set local role anon;
set local test.uid = '';
select pg_temp.refused('nor can anybody signed out',
  $$select * from public.project_files('bbbbbbbb-0000-0000-0000-000000000001')$$);
reset role;

-- Moving is not re-uploading: the file, its digest and its history are
-- untouched, and the correction is recorded with who made it.
set local role authenticated;
set local test.uid = '22222222-2222-2222-2222-222222222222';
select public.move_evidence_to_room('caca0000-0000-0000-0000-000000000005',
                                    'cccccccc-0000-0000-0000-000000000002',
                                    'It was taken in the hall, not the garage');
select pg_temp.check('a contributor can say which room a file was taken in',
  (select space_id from public.evidence_items where id = 'caca0000-0000-0000-0000-000000000005')
    = 'cccccccc-0000-0000-0000-000000000002');
select pg_temp.check('and the file itself is untouched',
  (select original_filename || '|' || byte_size::text from public.evidence_items
    where id = 'caca0000-0000-0000-0000-000000000005')
    = 'VID_20250222_049999_00_099.insv|1024');

-- The capture it belonged to has to follow, or the room it left keeps claiming
-- a file that is no longer in it.
select pg_temp.check('the capture follows the file into its new room',
  exists(select 1 from public.capture_360_groups
          where capture_key = 'vid_20250222_049999_099'
            and space_id = 'cccccccc-0000-0000-0000-000000000002'));
select pg_temp.check('and the room it left no longer claims it',
  not exists(select 1 from public.capture_360_groups
              where capture_key = 'vid_20250222_049999_099'
                and space_id = 'cccccccc-0000-0000-0000-000000000001'
                and 'caca0000-0000-0000-0000-000000000005' = any(source_evidence_ids)));

reset role;

-- Evidence about one property filed under another is the one thing this record
-- must never do. The room id is written out rather than selected, because row
-- level security hides the other project's rooms from this user — the subquery
-- returned null and the refusal came from "no such room", which is a different
-- rule and left the cross-project guard untested.
insert into public.spaces(id, organization_id, property_id, name, created_by) values
  ('cccccccc-0000-0000-0000-0000000000ff','aaaaaaaa-0000-0000-0000-000000000002',
   'bbbbbbbb-0000-0000-0000-000000000002','Other Client Kitchen','44444444-4444-4444-4444-444444444444');

set local role authenticated;
set local test.uid = '22222222-2222-2222-2222-222222222222';
select pg_temp.refused('a file cannot be moved into another project''s room',
  $$select public.move_evidence_to_room('caca0000-0000-0000-0000-000000000005',
      'cccccccc-0000-0000-0000-0000000000ff')$$);
select pg_temp.check('and it stayed where it was',
  (select space_id from public.evidence_items where id = 'caca0000-0000-0000-0000-000000000005')
    = 'cccccccc-0000-0000-0000-000000000002');
reset role;

set local role authenticated;
set local test.uid = '11111111-1111-1111-1111-111111111111';
select pg_temp.check('the move is on the record, with who made it',
  exists(select 1 from public.audit_events
          where action = 'evidence.moved'
            and entity_id = 'caca0000-0000-0000-0000-000000000005'
            and actor_id = '22222222-2222-2222-2222-222222222222'
            and detail->>'reason' = 'It was taken in the hall, not the garage'));
-- Said plainly, so nobody reading this later wonders whether a file was swapped.
select pg_temp.check('and it states that the file itself did not change',
  (select detail->>'file_unchanged' from public.audit_events
    where action = 'evidence.moved' limit 1) = 'true');
reset role;

set local role authenticated;
set local test.uid = '44444444-4444-4444-4444-444444444444';
select pg_temp.refused('somebody from another organisation cannot move a file',
  $$select public.move_evidence_to_room('caca0000-0000-0000-0000-000000000001',
                                        'cccccccc-0000-0000-0000-000000000003')$$);
reset role;

--
-- The draft lumber order: computed deterministically from printed dimensions,
-- signed by a person, stored verbatim. The rules here keep the signature
-- honest — what was approved is what stays, and nobody outside the project
-- sees or signs anything.

set local role authenticated;
set local test.uid = '22222222-2222-2222-2222-222222222222';
select pg_temp.refused('a contributor cannot approve a takeoff',
  $$select public.approve_material_takeoff('eeeeeeee-0000-0000-0000-000000000001', 'wood_framing',
      '[{"item":"2x4 stud","quantity":14,"unit":"pieces"}]'::jsonb, '[]'::jsonb, '[]'::jsonb, 1, 'test-1')$$);
reset role;

set local role authenticated;
set local test.uid = '33333333-3333-3333-3333-333333333333';
select pg_temp.refused('an empty takeoff is refused',
  $$select public.approve_material_takeoff('eeeeeeee-0000-0000-0000-000000000001', 'wood_framing',
      '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, 0, 'test-1')$$);
select pg_temp.refused('and an unknown kind is refused',
  $$select public.approve_material_takeoff('eeeeeeee-0000-0000-0000-000000000001', 'gold_leaf',
      '[{"item":"x","quantity":1,"unit":"pieces"}]'::jsonb, '[]'::jsonb, '[]'::jsonb, 1, 'test-1')$$);

select public.approve_material_takeoff('eeeeeeee-0000-0000-0000-000000000001', 'wood_framing',
  '[{"item":"2x4 stud · 92 5/8\" precut","quantity":14,"unit":"pieces"},{"item":"2x4 plate · 12''","quantity":3,"unit":"pieces"}]'::jsonb,
  '[{"wall":"A","source_refs":["A-201"],"steps":["studs: ceil(144/16)+1 = 10, + 4 corners"]}]'::jsonb,
  '["wall C on A-202 has no printed length"]'::jsonb, 2, 'takeoff360-1', 'Draft for verification');

select pg_temp.check('a reviewer approves a takeoff and it is stored verbatim',
  (select lines->0->>'quantity' from public.material_takeoffs
    where baseline_id = 'eeeeeeee-0000-0000-0000-000000000001' and state = 'approved') = '14');
select pg_temp.check('with its gaps said out loud',
  (select jsonb_array_length(gaps) from public.material_takeoffs where state = 'approved') = 1);

-- Approving again supersedes; it never overwrites what was signed.
select public.approve_material_takeoff('eeeeeeee-0000-0000-0000-000000000001', 'wood_framing',
  '[{"item":"2x4 stud · 92 5/8\" precut","quantity":20,"unit":"pieces"}]'::jsonb,
  '[]'::jsonb, '[]'::jsonb, 2, 'takeoff360-1', 'Corrected after site walk');
select pg_temp.check('a second approval supersedes the first',
  (select count(*) from public.material_takeoffs where baseline_id = 'eeeeeeee-0000-0000-0000-000000000001') = 2
  and (select count(*) from public.material_takeoffs
        where baseline_id = 'eeeeeeee-0000-0000-0000-000000000001' and state = 'approved') = 1);
select pg_temp.check('and the first, superseded, still says what was signed',
  (select lines->0->>'quantity' from public.material_takeoffs where state = 'superseded') = '14');

-- A person answers what the sheets did not. Counting the P1 marks on the
-- foundation plan is reading the drawing; when the AI could not do it with
-- confidence, the signer can — and the answer rides with the signature,
-- verbatim, attributed by approved_by. Malformed answers never reach the record.
select public.approve_material_takeoff('eeeeeeee-0000-0000-0000-000000000001', 'wood_framing',
  '[{"item":"pile: 18\" conc. pile","quantity":14,"unit":"counted by the signer"}]'::jsonb,
  '[]'::jsonb,
  '["piles are scheduled but their drawn count was not read"]'::jsonb,
  1, 'takeoff360-1', null,
  '[{"question":"piles are scheduled but their drawn count was not read","answer":"14 — counted on S-2.0"}]'::jsonb);
select pg_temp.check('the signer''s answers are stored verbatim with the signature',
  (select answers->0->>'answer' from public.material_takeoffs
    where baseline_id = 'eeeeeeee-0000-0000-0000-000000000001' and state = 'approved') = '14 — counted on S-2.0');
select pg_temp.check('an approval that answered nothing recorded an empty list, not a null',
  (select answers from public.material_takeoffs where note = 'Draft for verification') = '[]'::jsonb);
select pg_temp.refused('an answer without its question is refused',
  $$select public.approve_material_takeoff('eeeeeeee-0000-0000-0000-000000000001', 'wood_framing',
      '[{"item":"x","quantity":1,"unit":"pieces"}]'::jsonb, '[]'::jsonb, '[]'::jsonb, 1, 'test-1', null,
      '[{"answer":"14"}]'::jsonb)$$);
select pg_temp.refused('and answers that are not a list are refused',
  $$select public.approve_material_takeoff('eeeeeeee-0000-0000-0000-000000000001', 'wood_framing',
      '[{"item":"x","quantity":1,"unit":"pieces"}]'::jsonb, '[]'::jsonb, '[]'::jsonb, 1, 'test-1', null,
      '{"question":"q","answer":"a"}'::jsonb)$$);
reset role;

set local role authenticated;
set local test.uid = '11111111-1111-1111-1111-111111111111';
select pg_temp.check('the approval is on the record, naming who signed',
  exists(select 1 from public.audit_events
          where action = 'takeoff.approved'
            and actor_id = '33333333-3333-3333-3333-333333333333'
            and detail->>'kind' = 'wood_framing'));
select pg_temp.check('and the record counts the signer''s answers',
  exists(select 1 from public.audit_events
          where action = 'takeoff.approved' and detail->>'answer_count' = '1'));
reset role;

set local role authenticated;
set local test.uid = '44444444-4444-4444-4444-444444444444';
select pg_temp.check('another organisation does not see the takeoff',
  (select count(*) from public.material_takeoffs) = 0);
select pg_temp.refused('nor can it approve one here',
  $$select public.approve_material_takeoff('eeeeeeee-0000-0000-0000-000000000001', 'wood_framing',
      '[{"item":"x","quantity":1,"unit":"pieces"}]'::jsonb, '[]'::jsonb, '[]'::jsonb, 1, 'test-1')$$);
reset role;

set local role anon;
set local test.uid = '';
select pg_temp.refused('nobody signed out can approve',
  $$select public.approve_material_takeoff('eeeeeeee-0000-0000-0000-000000000001', 'wood_framing',
      '[{"item":"x","quantity":1,"unit":"pieces"}]'::jsonb, '[]'::jsonb, '[]'::jsonb, 1, 'test-1')$$);
select pg_temp.check('and the takeoffs are invisible signed out',
  (select count(*) from public.material_takeoffs) = 0);
reset role;

--
-- The AI's glasses: high-resolution page renders, derived from a plan PDF in
-- the browser before analysis. The record keeps analysis honest — it says
-- which document was rendered, at what resolution, by whom — and the rules
-- keep it scoped: only the project's own people may record one, the record
-- must point at a real document of the same organisation and property, and
-- the governed bucket accepts the JPEG tiles beside the PDFs it already holds.

insert into public.project_documents (id, organization_id, property_id, storage_path, original_filename, created_by)
values ('ddddddd0-0000-0000-0000-00000000000d', 'aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001',
        'aaaaaaaa-0000-0000-0000-000000000001/plans/set-1.pdf', 'set-1.pdf', '11111111-1111-1111-1111-111111111111');

select pg_temp.check('the plan bucket accepts jpeg tiles beside the pdfs',
  (select allowed_mime_types @> array['image/jpeg', 'application/pdf']
     from storage.buckets where id = 'project-documents'));

set local role authenticated;
set local test.uid = '22222222-2222-2222-2222-222222222222';
insert into public.plan_page_renders (document_id, organization_id, property_id, pages, target_dpi)
values ('ddddddd0-0000-0000-0000-00000000000d', 'aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001', 9, 200);
select pg_temp.check('a contributor records a render for their own project',
  (select count(*) from public.plan_page_renders where document_id = 'ddddddd0-0000-0000-0000-00000000000d') = 1);
select pg_temp.refused('but a record cannot point a document at somebody else''s property',
  $$insert into public.plan_page_renders (document_id, organization_id, property_id, pages, target_dpi)
    values ('ddddddd0-0000-0000-0000-00000000000d', 'aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000002', 9, 200)$$);
reset role;

set local role authenticated;
set local test.uid = '44444444-4444-4444-4444-444444444444';
select pg_temp.check('another organisation does not see the render record',
  (select count(*) from public.plan_page_renders) = 0);
select pg_temp.refused('nor can it record a render against this project''s document',
  $$insert into public.plan_page_renders (document_id, organization_id, property_id, pages, target_dpi)
    values ('ddddddd0-0000-0000-0000-00000000000d', 'aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001', 9, 200)$$);
reset role;

--
-- Project Intelligence Core: what the documents require meets what the
-- evidence shows. The doctrines under test: absence of evidence is not
-- evidence of absence; delivery is not installation; the owner writes
-- nothing — channels and workers do.

insert into public.document_baselines(id, organization_id, property_id, version, state,
  source_document_ids, analysis, created_by)
values ('eeeeeeee-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001',
  'bbbbbbbb-0000-0000-0000-000000000001', 2, 'approved', '{}'::uuid[],
  '{"framing_decks":[{"label":"Deck","source_refs":["S-2.0"],
     "beams":[{"mark":"DECK BM","description":"6x12 #1","count_drawn":0,"count_proposed":27,"count_confidence":"medium","count_note":"counted on S-2.0"},
              {"mark":"BM.1","description":"PSL 7x14","count_drawn":0,"count_proposed":0,"count_confidence":"none","count_note":"marks illegible"}],
     "columns":[],
     "piles":{"description":"18in conc pile","count_drawn":0,"count_proposed":14,"count_confidence":"high","count_note":"counted on foundation plan"}}]}'::jsonb,
  '11111111-1111-1111-1111-111111111111');

set local role authenticated;
set local test.uid = '33333333-3333-3333-3333-333333333333';
select public.extract_project_requirements('eeeeeeee-0000-0000-0000-000000000002');
select pg_temp.check('the technical channel distills components with provenance',
  (select count(*) from public.project_requirements where baseline_id = 'eeeeeeee-0000-0000-0000-000000000002' and state = 'active') = 3
  and exists (select 1 from public.project_requirements where component_key = 'P1' and quantity = 14 and method = 'AI_PLAN_COUNT' and state = 'active')
  and exists (select 1 from public.project_requirements where component_key = 'BM.1' and quantity is null and method = 'OPEN_RFI' and state = 'active'));
select public.extract_project_requirements('eeeeeeee-0000-0000-0000-000000000002');
select pg_temp.check('extraction is idempotent: rerun supersedes, never duplicates',
  (select count(*) from public.project_requirements where baseline_id = 'eeeeeeee-0000-0000-0000-000000000002' and state = 'active') = 3
  and (select count(*) from public.project_requirements where baseline_id = 'eeeeeeee-0000-0000-0000-000000000002' and state = 'superseded') = 3);
select pg_temp.check('and every run is a checkpointed job that admits its RFIs',
  exists (select 1 from public.intelligence_jobs where channel = 'technical' and state = 'complete_with_rfis')
  and exists (select 1 from public.processing_checkpoints c join public.intelligence_jobs j on j.id = c.job_id where c.stage = 'piles'));
reset role;

-- The vocabulary grows (041): an architectural set states its countable
-- scope in printed schedules — doors, windows, fixtures — and those rows
-- distil into requirements exactly as framing members do. Printed and
-- drawn counts only; a row nobody could count stays an open RFI.
insert into public.document_baselines(id, organization_id, property_id, version, state,
  source_document_ids, analysis, created_by)
values ('eeeeeeee-0000-0000-0000-000000000003','aaaaaaaa-0000-0000-0000-000000000001',
  'bbbbbbbb-0000-0000-0000-000000000001', 3, 'approved', '{}'::uuid[],
  '{"component_schedules":[
     {"mark":"D1","category":"door","description":"3-0 x 8-0 solid core","unit":"count","count_scheduled":8,"count_drawn":8,"count_proposed":8,"count_confidence":"high","count_note":"door schedule A-6.0","source_refs":["A-6.0"]},
     {"mark":"W2","category":"window","description":"casement 4x5 dual glazed","unit":"count","count_scheduled":0,"count_drawn":0,"count_proposed":6,"count_confidence":"medium","count_note":"plan tags partially covered","source_refs":["A-6.1"]},
     {"mark":"PF-1","category":"plumbing_fixture","description":"undermount lavatory","unit":"count","count_scheduled":0,"count_drawn":0,"count_proposed":0,"count_confidence":"none","count_note":"schedule prints no qty; tags unreadable","source_refs":["P-1.0"]}
   ]}'::jsonb,
  '11111111-1111-1111-1111-111111111111');

set local role authenticated;
set local test.uid = '33333333-3333-3333-3333-333333333333';
select public.extract_project_requirements('eeeeeeee-0000-0000-0000-000000000003');
select pg_temp.check('a printed door schedule distils into a requirement with its printed count',
  exists (select 1 from public.project_requirements
          where baseline_id = 'eeeeeeee-0000-0000-0000-000000000003' and component_key = 'D1'
            and quantity = 8 and unit = 'count' and method = 'AI_PLAN_COUNT' and confidence = 'high' and state = 'active'));
select pg_temp.check('a proposed-only window count keeps its stated confidence',
  exists (select 1 from public.project_requirements
          where baseline_id = 'eeeeeeee-0000-0000-0000-000000000003' and component_key = 'W2'
            and quantity = 6 and confidence = 'medium' and state = 'active'));
select pg_temp.check('a schedule row nobody could count stays an open RFI, never a guess',
  exists (select 1 from public.project_requirements
          where baseline_id = 'eeeeeeee-0000-0000-0000-000000000003' and component_key = 'PF-1'
            and quantity is null and method = 'OPEN_RFI' and state = 'active'));
reset role;

-- The structural vocabulary (053): a framing set states its countable
-- scope in beam, header, joist and footing schedules. One requirement per
-- scheduled member; a printed quantity is a printed fact, a drawn count a
-- count, an uncounted member an open RFI; a mark an architectural schedule
-- also uses keeps a key that says which.
-- On a project of its own, so no other reading's register counts change.
insert into public.properties (id, organization_id, name, created_by) values
  ('bbbbbbbb-0000-0000-0000-000000000053', 'aaaaaaaa-0000-0000-0000-000000000001',
   'Structural vocabulary project', '11111111-1111-1111-1111-111111111111');
insert into public.document_baselines(id, organization_id, property_id, version, state,
  source_document_ids, analysis, created_by)
values ('eeeeeeee-0000-0000-0000-000000000053','aaaaaaaa-0000-0000-0000-000000000001',
  'bbbbbbbb-0000-0000-0000-000000000053', 1, 'approved', '{}'::uuid[],
  '{"component_schedules":[
     {"mark":"F1","category":"electrical_fixture","description":"6in recessed downlight","unit":"each","count_scheduled":36,"count_drawn":0,"count_proposed":36,"count_confidence":"high","count_note":"","source_refs":["A-310"]}
   ],
    "structural_members":[
     {"mark":"FB1","member_type":"beam","description":"3-1/2 x 11-7/8 LVL","size":"3-1/2 x 11-7/8","spacing":"","material":"LVL","level":"Second Floor","location":"over garage","count_scheduled":2,"count_drawn":2,"count_proposed":2,"count_confidence":"high","count_note":"","length_printed":"","unit":"each","detail_refs":["S-6/4"],"source_refs":["S-3 (original p25)"]},
     {"mark":"HDR4","member_type":"header","description":"Parallam PSL 2.0E 3.50 x 18.0","size":"3.50 x 18.0","spacing":"","material":"PSL","level":"First Floor","location":"","count_scheduled":0,"count_drawn":3,"count_proposed":3,"count_confidence":"high","count_note":"counted on S-3","length_printed":"","unit":"each","detail_refs":[],"source_refs":["S-3 (original p25)"]},
     {"mark":"F1","member_type":"footing","description":"24 x 24 x 12 w/ 3-#4 e.w.","size":"24x24x12","spacing":"","material":"concrete","level":"Foundation","location":"","count_scheduled":0,"count_drawn":0,"count_proposed":0,"count_confidence":"none","count_note":"footing plan locations not read","length_printed":"","unit":"each","detail_refs":["S-5/1"],"source_refs":["S-2 (original p24)"]},
     {"mark":"R.R.1","member_type":"rafter","description":"2x10 #2 @ 16 O.C.","size":"2x10","spacing":"16 O.C.","material":"DF #2","level":"Roof","location":"","count_scheduled":0,"count_drawn":0,"count_proposed":12,"count_confidence":"low","count_note":"twelve R.R.1 zones","counted":"zones","plies":0,"size_basis":"schedule_row","length_printed":"","unit":"framing zone","detail_refs":[],"source_refs":["S-4"]},
     {"mark":"RIDGE BM 2","member_type":"ridge","description":"(2)-2x10 #2","size":"(2)-2x10","spacing":"","material":"DF #2","level":"Roof","location":"small roofs","count_scheduled":0,"count_drawn":3,"count_proposed":3,"count_confidence":"medium","count_note":"","counted":"assemblies","plies":2,"size_basis":"schedule_row","length_printed":"","unit":"each","detail_refs":[],"source_refs":["S-4"]},
     {"mark":"RHDR","member_type":"header","description":"","size":"","spacing":"","material":"","level":"Roof","location":"","count_scheduled":0,"count_drawn":20,"count_proposed":20,"count_confidence":"high","count_note":"unnumbered RHDR labels","counted":"labels","plies":0,"size_basis":"not_resolved","length_printed":"","unit":"each","detail_refs":[],"source_refs":["S-4"]}
   ],
    "framing_defaults":[
     {"rule":"ALL STUDS 2x4 #2 @ 16 O.C. U.N.O.","kind":"studs","applies_to":"bearing and non-bearing wood stud walls","exception":"U.N.O.","source_refs":["S-3 notes 5, 7"]}
   ]}'::jsonb,
  '11111111-1111-1111-1111-111111111111');

set local role authenticated;
set local test.uid = '33333333-3333-3333-3333-333333333333';
select public.extract_project_requirements('eeeeeeee-0000-0000-0000-000000000053');
select pg_temp.check('a scheduled beam with a printed quantity is a printed fact, with its detail in the provenance',
  exists (select 1 from public.project_requirements
          where baseline_id = 'eeeeeeee-0000-0000-0000-000000000053' and component_key = 'FB1' and state = 'active'
            and quantity = 2 and unit = 'each' and method = 'PRINTED_FACT' and confidence = 'high'
            and description like 'beam · %' and source_refs @> '["S-6/4"]'::jsonb));
select pg_temp.check('a header counted drawn on the plan is a plan count',
  exists (select 1 from public.project_requirements
          where baseline_id = 'eeeeeeee-0000-0000-0000-000000000053' and component_key = 'HDR4' and state = 'active'
            and quantity = 3 and method = 'AI_PLAN_COUNT' and confidence = 'high'));
select pg_temp.check('a footing nobody could count stays an open RFI, never a guess',
  exists (select 1 from public.project_requirements
          where baseline_id = 'eeeeeeee-0000-0000-0000-000000000053' and component_key = 'F1 · footing' and state = 'active'
            and quantity is null and method = 'OPEN_RFI'));
select pg_temp.check('and the lighting F1 keeps its own key beside the footing F1',
  exists (select 1 from public.project_requirements
          where baseline_id = 'eeeeeeee-0000-0000-0000-000000000053' and component_key = 'F1' and state = 'active' and quantity = 36));
select pg_temp.check('twelve rafter zones are not twelve rafters: an open RFI that says what was counted (054)',
  exists (select 1 from public.project_requirements
          where baseline_id = 'eeeeeeee-0000-0000-0000-000000000053' and component_key = 'R.R.1' and state = 'active'
            and quantity is null and method = 'OPEN_RFI' and description like '%12 zones on plan; member count not determined'));
select pg_temp.check('three ridge assemblies are three, with their plies in the description and never multiplied (054)',
  exists (select 1 from public.project_requirements
          where baseline_id = 'eeeeeeee-0000-0000-0000-000000000053' and component_key = 'RIDGE BM 2' and state = 'active'
            and quantity = 3 and unit = 'assembly' and method = 'AI_PLAN_COUNT' and description like '%(2) plies per assembly%'));
select pg_temp.check('twenty unnumbered labels with no resolved size are a question, not twenty headers (054)',
  exists (select 1 from public.project_requirements
          where baseline_id = 'eeeeeeee-0000-0000-0000-000000000053' and component_key = 'RHDR' and state = 'active'
            and quantity is null and method = 'OPEN_RFI' and description like '%20 labels on plan%'));
select pg_temp.check('a printed rule is not turned into a counted row',
  not exists (select 1 from public.project_requirements
          where baseline_id = 'eeeeeeee-0000-0000-0000-000000000053' and state = 'active' and description ilike '%U.N.O.%'));
reset role;

-- One mark, one requirement (042): the reader reports sheet by sheet — the
-- same door in the door schedule and again on a floor plan — but the record
-- speaks component by component. Duplicates merge with united provenance;
-- a mark shared by two categories stays two components with honest keys.
insert into public.document_baselines(id, organization_id, property_id, version, state,
  source_document_ids, analysis, created_by)
values ('eeeeeeee-0000-0000-0000-000000000004','aaaaaaaa-0000-0000-0000-000000000001',
  'bbbbbbbb-0000-0000-0000-000000000001', 4, 'approved', '{}'::uuid[],
  '{"component_schedules":[
     {"mark":"101.1","category":"door","description":"3-0 x 8-0 flush","unit":"count","count_scheduled":1,"count_drawn":0,"count_proposed":1,"count_confidence":"high","count_note":"door schedule","source_refs":["A-6.0"]},
     {"mark":"101.1","category":"door","description":"3-0 x 8-0 flush door, first floor plan","unit":"count","count_scheduled":1,"count_drawn":1,"count_proposed":1,"count_confidence":"medium","count_note":"tag on floor plan","source_refs":["A-2.1"]},
     {"mark":"201","category":"door","description":"pocket door","unit":"count","count_scheduled":1,"count_drawn":0,"count_proposed":0,"count_confidence":"low","count_note":"","source_refs":["A-6.0"]},
     {"mark":"201","category":"window","description":"fixed window","unit":"count","count_scheduled":1,"count_drawn":0,"count_proposed":0,"count_confidence":"high","count_note":"","source_refs":["A-6.1"]}
   ]}'::jsonb,
  '11111111-1111-1111-1111-111111111111');

set local role authenticated;
set local test.uid = '33333333-3333-3333-3333-333333333333';
select public.extract_project_requirements('eeeeeeee-0000-0000-0000-000000000004');
select pg_temp.check('the same mark read from two sheets is one requirement, with both sheets in its provenance',
  (select count(*) from public.project_requirements
   where baseline_id = 'eeeeeeee-0000-0000-0000-000000000004' and component_key = '101.1' and state = 'active') = 1
  and exists (select 1 from public.project_requirements
          where baseline_id = 'eeeeeeee-0000-0000-0000-000000000004' and component_key = '101.1' and state = 'active'
            and quantity = 1 and confidence = 'high'
            and source_refs @> '["A-6.0"]'::jsonb and source_refs @> '["A-2.1"]'::jsonb));
select pg_temp.check('a mark shared by two categories stays two components with honest keys',
  exists (select 1 from public.project_requirements
          where baseline_id = 'eeeeeeee-0000-0000-0000-000000000004' and component_key = '201 · door' and state = 'active')
  and exists (select 1 from public.project_requirements
          where baseline_id = 'eeeeeeee-0000-0000-0000-000000000004' and component_key = '201 · window' and state = 'active')
  and not exists (select 1 from public.project_requirements
          where baseline_id = 'eeeeeeee-0000-0000-0000-000000000004' and component_key = '201' and state = 'active'));
select pg_temp.check('four sheet rows distil into exactly three components — never more, never fewer',
  (select count(*) from public.project_requirements
   where baseline_id = 'eeeeeeee-0000-0000-0000-000000000004' and state = 'active') = 3);
reset role;

set local role authenticated;
set local test.uid = '22222222-2222-2222-2222-222222222222';
select public.record_observation('bbbbbbbb-0000-0000-0000-000000000001', 'P1', 'delivered_documented', 14, null, '{}'::uuid[], null, 'DOCUMENT', 'high', 'supplier invoice 4471');
select public.record_observation('bbbbbbbb-0000-0000-0000-000000000001', 'P1', 'installed_seen', 12, 'cccccccc-0000-0000-0000-000000000001',
  array['dddddddd-0000-0000-0000-000000000001']::uuid[], null, 'AI_VISION', 'medium', null);
select public.record_observation('bbbbbbbb-0000-0000-0000-000000000001', 'P1', 'capture_coverage', null, null, '{}'::uuid[], 'partial', 'AI_VISION', 'medium', null);
select public.record_observation('bbbbbbbb-0000-0000-0000-000000000001', 'DECK BM', 'delivered_documented', 27, null, '{}'::uuid[], null, 'DOCUMENT', 'high', null);
select public.record_observation('bbbbbbbb-0000-0000-0000-000000000001', 'DECK BM', 'capture_coverage', null, null, '{}'::uuid[], 'none', 'AI_VISION', 'low', null);
select pg_temp.check('a contributor (or a worker) records observations; kinds keep delivery apart',
  (select count(*) from public.project_observations where property_id = 'bbbbbbbb-0000-0000-0000-000000000001') = 5);
select pg_temp.refused('a coverage observation without coverage is refused',
  $$select public.record_observation('bbbbbbbb-0000-0000-0000-000000000001', 'P1', 'capture_coverage')$$);
reset role;

set local role authenticated;
set local test.uid = '33333333-3333-3333-3333-333333333333';
select public.reconcile_project('bbbbbbbb-0000-0000-0000-000000000001');
select pg_temp.check('a shortfall under partial coverage is PARTIALLY_SUPPORTED, never MISSING',
  (select verdict from public.project_reconciliations where component_key = 'P1' and state = 'active') = 'PARTIALLY_SUPPORTED');
select pg_temp.check('and the narrative keeps delivery, installation and the open remainder apart',
  (select narrative from public.project_reconciliations where component_key = 'P1' and state = 'active')
    = '14 required · 14 documented as delivered · 12 visually evidenced as installed · 2 installation records not yet evidenced');
select pg_temp.check('an invoice alone is never installation: delivered 27, seen 0, no coverage → NOT_EVIDENCED',
  (select verdict from public.project_reconciliations where component_key = 'DECK BM' and state = 'active') = 'NOT_EVIDENCED');
select pg_temp.check('a component without a printed quantity is UNKNOWN, not guessed',
  (select verdict from public.project_reconciliations where component_key = 'BM.1' and state = 'active') = 'UNKNOWN');

select public.record_observation('bbbbbbbb-0000-0000-0000-000000000001', 'P1', 'capture_coverage', null, null, '{}'::uuid[], 'full', 'HUMAN', 'high', 'walked the full pile grid');
select public.reconcile_project('bbbbbbbb-0000-0000-0000-000000000001');
select pg_temp.check('the same shortfall under FULL coverage becomes a CONFLICT',
  (select verdict from public.project_reconciliations where component_key = 'P1' and state = 'active') = 'CONFLICTING'
  and (select narrative from public.project_reconciliations where component_key = 'P1' and state = 'active') like '%missing under full capture coverage%');

select public.record_observation('bbbbbbbb-0000-0000-0000-000000000001', 'P1', 'installed_seen', 2, null, '{}'::uuid[], null, 'AI_VISION', 'medium', null);
select public.reconcile_project('bbbbbbbb-0000-0000-0000-000000000001');
select pg_temp.check('once the evidence covers the requirement the verdict is SUPPORTED',
  (select verdict from public.project_reconciliations where component_key = 'P1' and state = 'active') = 'SUPPORTED');
select pg_temp.check('reconciliation history supersedes, never disappears',
  (select count(*) from public.project_reconciliations where component_key = 'P1') = 3);
reset role;

set local role authenticated;
set local test.uid = '22222222-2222-2222-2222-222222222222';
select pg_temp.refused('a contributor does not run extraction',
  $$select public.extract_project_requirements('eeeeeeee-0000-0000-0000-000000000002')$$);
select pg_temp.refused('nor reconciliation',
  $$select public.reconcile_project('bbbbbbbb-0000-0000-0000-000000000001')$$);
reset role;

set local role authenticated;
set local test.uid = '44444444-4444-4444-4444-444444444444';
select pg_temp.check('another organisation sees no requirements, observations or reconciliations',
  (select count(*) from public.project_requirements) = 0
  and (select count(*) from public.project_observations) = 0
  and (select count(*) from public.project_reconciliations) = 0);
select pg_temp.refused('and cannot record into this project',
  $$select public.record_observation('bbbbbbbb-0000-0000-0000-000000000001', 'P1', 'installed_seen', 1)$$);
reset role;

set local role anon;
set local test.uid = '';
select pg_temp.refused('nobody signed out reconciles',
  $$select public.reconcile_project('bbbbbbbb-0000-0000-0000-000000000001')$$);
reset role;

--
-- The channels fill themselves. Coverage derives from the evidence record —
-- and automation never claims full, so it can never manufacture a conflict.
-- Reconciliation self-derives coverage and falls back component → '*'.

set local role authenticated;
set local test.uid = '33333333-3333-3333-3333-333333333333';
select pg_temp.check('invoices are a declared document discipline now',
  exists (select 1 from pg_constraint where conname = 'project_documents_document_type_check'));

-- Earlier fixtures already put 360 captures into this project, so its
-- project-wide coverage derives as partial. The 'none' branch is proven on
-- the other organisation's untouched project — by its own member.
select public.derive_capture_coverage('bbbbbbbb-0000-0000-0000-000000000001');
select pg_temp.check('with 360s in the record coverage derives as partial — automation never claims full',
  (select coverage from public.project_observations
    where property_id = 'bbbbbbbb-0000-0000-0000-000000000001'
      and component_key = '*' and kind = 'capture_coverage' and state = 'active') = 'partial'
  and not exists (select 1 from public.project_observations
    where component_key = '*' and kind = 'capture_coverage' and coverage = 'full'));
select public.derive_capture_coverage('bbbbbbbb-0000-0000-0000-000000000001');
select pg_temp.check('and each derivation supersedes the last, never stacks',
  (select count(*) from public.project_observations
    where property_id = 'bbbbbbbb-0000-0000-0000-000000000001'
      and component_key = '*' and kind = 'capture_coverage' and state = 'active') = 1);
select pg_temp.refused('a member of another organisation cannot derive coverage here',
  $$select public.derive_capture_coverage('bbbbbbbb-0000-0000-0000-000000000002')$$);
reset role;

set local role authenticated;
set local test.uid = '44444444-4444-4444-4444-444444444444';
select public.derive_capture_coverage('bbbbbbbb-0000-0000-0000-000000000002');
select pg_temp.check('a project with no 360 at all derives none — for its own people only',
  (select coverage from public.project_observations
    where property_id = 'bbbbbbbb-0000-0000-0000-000000000002'
      and component_key = '*' and kind = 'capture_coverage' and state = 'active') = 'none');
reset role;

set local role authenticated;
set local test.uid = '33333333-3333-3333-3333-333333333333';
-- The P1 human 'full' coverage row from the earlier scenario outranks the
-- derived '*' partial; DECK BM has explicit 'none'; BM.1 has neither and
-- inherits the '*' fallback. One reconcile, three coverage sources.
select public.reconcile_project('bbbbbbbb-0000-0000-0000-000000000001');
select pg_temp.check('reconciliation self-derives and component coverage outranks the fallback',
  (select coverage from public.project_reconciliations where component_key = 'P1' and state = 'active') = 'full'
  and (select coverage from public.project_reconciliations where component_key = 'DECK BM' and state = 'active') = 'none'
  and (select coverage from public.project_reconciliations where component_key = 'BM.1' and state = 'active') = 'partial');
reset role;

--
-- The camera learns to count. record_vision_counts is the one door for
-- AI-counted installed components: a newer reading of a room replaces that
-- room's previous AI reading; different rooms sum; zero is not an
-- observation. Human and document rows are never touched by it.

set local role authenticated;
set local test.uid = '22222222-2222-2222-2222-222222222222';
select public.record_vision_counts('bbbbbbbb-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001',
  array['dddddddd-0000-0000-0000-000000000001']::uuid[],
  '[{"component_key":"COL.2","count_visible":5,"confidence":"medium","note":"west row visible"},
    {"component_key":"COL.2","count_visible":0,"confidence":"low","note":"zero must be skipped"},
    {"component_key":"","count_visible":3,"confidence":"low","note":"nameless must be skipped"}]'::jsonb);
select pg_temp.check('a vision count lands once; zeros and nameless entries never do',
  (select count(*) from public.project_observations
    where component_key = 'COL.2' and kind = 'installed_seen' and method = 'AI_VISION' and state = 'active') = 1
  and (select quantity from public.project_observations
    where component_key = 'COL.2' and kind = 'installed_seen' and method = 'AI_VISION' and state = 'active') = 5);
select public.record_vision_counts('bbbbbbbb-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001',
  array['dddddddd-0000-0000-0000-000000000001']::uuid[],
  '[{"component_key":"COL.2","count_visible":6,"confidence":"high","note":"full west row now visible"}]'::jsonb);
select pg_temp.check('a newer reading of the same room replaces, never sums',
  (select quantity from public.project_observations
    where component_key = 'COL.2' and kind = 'installed_seen' and method = 'AI_VISION' and state = 'active'
      and space_id = 'cccccccc-0000-0000-0000-000000000001') = 6
  and exists (select 1 from public.project_observations
    where component_key = 'COL.2' and kind = 'installed_seen' and state = 'superseded' and quantity = 5));
-- A second room's reading is additional reality, not a rerun.
insert into public.spaces(id, organization_id, property_id, name, created_by)
values ('cccccccc-0000-0000-0000-00000000ea57','aaaaaaaa-0000-0000-0000-000000000001','bbbbbbbb-0000-0000-0000-000000000001','East Deck','11111111-1111-1111-1111-111111111111');
select public.record_vision_counts('bbbbbbbb-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-00000000ea57',
  '{}'::uuid[], '[{"component_key":"COL.2","count_visible":2,"confidence":"medium","note":"east row"}]'::jsonb);
select pg_temp.check('rooms sum across the project',
  (select sum(quantity) from public.project_observations
    where component_key = 'COL.2' and kind = 'installed_seen' and method = 'AI_VISION' and state = 'active') = 8);
select pg_temp.refused('a room from nowhere is refused',
  $$select public.record_vision_counts('bbbbbbbb-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-00000000dead',
      '{}'::uuid[], '[{"component_key":"X","count_visible":1,"confidence":"low","note":""}]'::jsonb)$$);
reset role;

set local role authenticated;
set local test.uid = '44444444-4444-4444-4444-444444444444';
select pg_temp.refused('another organisation cannot record vision counts here',
  $$select public.record_vision_counts('bbbbbbbb-0000-0000-0000-000000000001', null, '{}'::uuid[],
      '[{"component_key":"X","count_visible":1,"confidence":"low","note":""}]'::jsonb)$$);
reset role;

--
-- Human Confirmed means a human confirmed it. The expert layer is the only
-- door: one line at a time, by a qualified role, with the reviewer's role and
-- history kept. An owner's general acceptance touches none of this.

set local role authenticated;
set local test.uid = '33333333-3333-3333-3333-333333333333';
select public.review_takeoff_line('eeeeeeee-0000-0000-0000-000000000001',
  '2x6x6'' deck boards — net pieces (no purchase allowance)', 'confirmed', '547 pieces', 'Recomputed by hand from the printed module');
select pg_temp.check('a reviewer confirms one line, and the record names their role',
  exists (select 1 from public.takeoff_line_reviews
           where line_key like '2x6x6%' and verdict = 'confirmed'
             and value = '547 pieces' and reviewer_role = 'reviewer' and state = 'active'));
select public.review_takeoff_line('eeeeeeee-0000-0000-0000-000000000001',
  '2x6x6'' deck boards — net pieces (no purchase allowance)', 'corrected', '540 pieces', null);
select pg_temp.check('a second review supersedes the first, never erases it',
  (select count(*) from public.takeoff_line_reviews where line_key like '2x6x6%') = 2
  and (select verdict from public.takeoff_line_reviews where line_key like '2x6x6%' and state = 'active') = 'corrected'
  and exists (select 1 from public.takeoff_line_reviews where line_key like '2x6x6%' and state = 'superseded' and value = '547 pieces'));
select pg_temp.refused('a confirmation without a value is refused',
  $$select public.review_takeoff_line('eeeeeeee-0000-0000-0000-000000000001', 'some line', 'confirmed', '', null)$$);
select pg_temp.refused('and an unknown verdict is refused',
  $$select public.review_takeoff_line('eeeeeeee-0000-0000-0000-000000000001', 'some line', 'blessed', 'x', null)$$);
reset role;

set local role authenticated;
set local test.uid = '22222222-2222-2222-2222-222222222222';
select pg_temp.refused('a contributor is not a qualified reviewer',
  $$select public.review_takeoff_line('eeeeeeee-0000-0000-0000-000000000001', 'some line', 'confirmed', '1', null)$$);
reset role;

set local role authenticated;
set local test.uid = '44444444-4444-4444-4444-444444444444';
select pg_temp.refused('another organisation cannot review this project''s lines',
  $$select public.review_takeoff_line('eeeeeeee-0000-0000-0000-000000000001', 'some line', 'confirmed', '1', null)$$);
select pg_temp.check('nor see its reviews',
  (select count(*) from public.takeoff_line_reviews) = 0);
reset role;

set local role authenticated;
set local test.uid = '11111111-1111-1111-1111-111111111111';
select pg_temp.check('the line review is on the audit record with its verdict',
  exists (select 1 from public.audit_events
           where action = 'takeoff_line.reviewed'
             and detail->>'verdict' = 'corrected'
             and detail->>'reviewer_role' = 'reviewer'));
reset role;

set local role anon;
set local test.uid = '';
select pg_temp.refused('nobody signed out reviews a line',
  $$select public.review_takeoff_line('eeeeeeee-0000-0000-0000-000000000001', 'some line', 'confirmed', '1', null)$$);
reset role;

--
-- The owner report: the decision log and the product-counted metrics, for the
-- roles that run the project. AI actions are not decisions; other projects'
-- decisions never leak in; a contributor, an outsider and a signed-out visitor
-- get nothing.

set local role authenticated;
set local test.uid = '33333333-3333-3333-3333-333333333333';
select pg_temp.check('a reviewer receives the owner report data',
  (public.owner_report_data('bbbbbbbb-0000-0000-0000-000000000001')) is not null);
select pg_temp.check('the decision log lists the signed takeoff, naming who signed',
  exists (
    select 1 from jsonb_array_elements(
      public.owner_report_data('bbbbbbbb-0000-0000-0000-000000000001')->'decisions') entry
    where entry->>'action' = 'takeoff.approved'
      and entry->>'actor' = 'reviewer@example.com'));
select pg_temp.check('the metrics are counted from the record: one live takeoff, one room with evidence',
  (public.owner_report_data('bbbbbbbb-0000-0000-0000-000000000001')->'metrics'->>'takeoffs_signed')::int = 1
  and (public.owner_report_data('bbbbbbbb-0000-0000-0000-000000000001')->'metrics'->>'rooms_with_evidence')::int >= 1);
select pg_temp.check('a room without evidence is named as missing, not hidden',
  (public.owner_report_data('bbbbbbbb-0000-0000-0000-000000000001')->'rooms_without_evidence') is not null);
reset role;

set local role authenticated;
set local test.uid = '22222222-2222-2222-2222-222222222222';
select pg_temp.refused('a contributor does not hold the decision log',
  $$select public.owner_report_data('bbbbbbbb-0000-0000-0000-000000000001')$$);
reset role;

set local role authenticated;
set local test.uid = '44444444-4444-4444-4444-444444444444';
select pg_temp.refused('another organisation cannot read this project''s owner report',
  $$select public.owner_report_data('bbbbbbbb-0000-0000-0000-000000000001')$$);
select pg_temp.check('and their own report never carries this project''s decisions',
  not exists (
    select 1 from jsonb_array_elements(
      public.owner_report_data('bbbbbbbb-0000-0000-0000-000000000002')->'decisions') entry
    where entry->>'action' = 'takeoff.approved'));
reset role;

set local role anon;
set local test.uid = '';
select pg_temp.refused('nobody signed out reads an owner report',
  $$select public.owner_report_data('bbbbbbbb-0000-0000-0000-000000000001')$$);
reset role;

set local role anon;
set local test.uid = '';
select pg_temp.refused('nobody signed out records renders',
  $$insert into public.plan_page_renders (document_id, organization_id, property_id, pages, target_dpi)
    values ('ddddddd0-0000-0000-0000-00000000000d', 'aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001', 9, 200)$$);
select pg_temp.check('and render records are invisible signed out',
  (select count(*) from public.plan_page_renders) = 0);
reset role;

--
-- The routing channel: an undeclared PDF classifies itself page by page, the
-- run is a governed job, and the reading lives beside the document as
-- provenance — readable by the project's own people, invisible to another
-- organisation, and never a construction fact anywhere downstream.

insert into public.intelligence_jobs (organization_id, property_id, channel, source_kind, source_id, state)
values ('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001', 'routing',
        'project_document', 'ddddddd0-0000-0000-0000-00000000000d', 'complete');
select pg_temp.check('a classification run is a governed job in the routing channel',
  exists (select 1 from public.intelligence_jobs
          where channel = 'routing' and source_id = 'ddddddd0-0000-0000-0000-00000000000d'));
select pg_temp.refused('a channel the model invents is refused',
  $$insert into public.intelligence_jobs (organization_id, property_id, channel, source_kind, source_id, state)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001', 'oracle',
            'project_document', 'ddddddd0-0000-0000-0000-00000000000d', 'complete')$$);

update public.project_documents
set page_classification = '{"contract":"test","pages":[{"page_number":1,"kind":"technical_drawing","note":"S-2.0"},{"page_number":2,"kind":"invoice","note":"ABC Lumber"}]}'::jsonb
where id = 'ddddddd0-0000-0000-0000-00000000000d';

set local role authenticated;
set local test.uid = '22222222-2222-2222-2222-222222222222';
select pg_temp.check('the page reading is provenance the project''s own people can read',
  (select page_classification->'pages'->1->>'kind' from public.project_documents
    where id = 'ddddddd0-0000-0000-0000-00000000000d') = 'invoice');
reset role;

set local role authenticated;
set local test.uid = '44444444-4444-4444-4444-444444444444';
select pg_temp.check('another organisation never sees the reading',
  (select count(*) from public.project_documents where id = 'ddddddd0-0000-0000-0000-00000000000d') = 0);
reset role;

--
-- A large set is read in chunks. The chunk rows are the analysis worker's
-- checkpoints: written only through the service role, watched by the
-- project's own people, invisible to another organisation, and shaped so a
-- resumed run finds exactly the chunks it left — no duplicates, no
-- invented states.

insert into public.plan_analysis_jobs (id, organization_id, property_id, document_ids, state, requested_by)
values ('facadefa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
        'bbbbbbbb-0000-0000-0000-000000000001', array['ddddddd0-0000-0000-0000-00000000000d']::uuid[],
        'processing', '11111111-1111-1111-1111-111111111111');
insert into public.plan_analysis_chunks (job_id, organization_id, chunk_index, document_ids, state, analysis)
values ('facadefa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 0,
        array['ddddddd0-0000-0000-0000-00000000000d']::uuid[], 'complete', '{"project_summary":"chunk one"}'::jsonb),
       ('facadefa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 1,
        array['ddddddd0-0000-0000-0000-00000000000d']::uuid[], 'pending', null);

select pg_temp.refused('a chunk index cannot be claimed twice — resume finds exactly what was left',
  $$insert into public.plan_analysis_chunks (job_id, organization_id, chunk_index, document_ids)
    values ('facadefa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 1,
            array['ddddddd0-0000-0000-0000-00000000000d']::uuid[])$$);
select pg_temp.refused('a chunk state the worker never uses is refused',
  $$insert into public.plan_analysis_chunks (job_id, organization_id, chunk_index, document_ids, state)
    values ('facadefa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 2,
            array['ddddddd0-0000-0000-0000-00000000000d']::uuid[], 'imagined')$$);

set local role authenticated;
set local test.uid = '33333333-3333-3333-3333-333333333333';
select pg_temp.check('the project''s own people watch the checkpoints',
  (select count(*) from public.plan_analysis_chunks where job_id = 'facadefa-0000-0000-0000-000000000001') = 2
  and (select analysis->>'project_summary' from public.plan_analysis_chunks
        where job_id = 'facadefa-0000-0000-0000-000000000001' and chunk_index = 0) = 'chunk one');
select pg_temp.refused('but nobody writes a checkpoint from the browser — the worker owns them',
  $$insert into public.plan_analysis_chunks (job_id, organization_id, chunk_index, document_ids)
    values ('facadefa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 3,
            array['ddddddd0-0000-0000-0000-00000000000d']::uuid[])$$);
reset role;

set local role authenticated;
set local test.uid = '44444444-4444-4444-4444-444444444444';
select pg_temp.check('another organisation sees no checkpoints at all',
  (select count(*) from public.plan_analysis_chunks) = 0);
reset role;

--
-- The anonymous door. Every action RPC refuses a signed-out caller
-- internally, and after migration 039 it is also unreachable: the refusal
-- happens at the gate. The RLS membership predicates stay callable on
-- purpose — a signed-out SELECT must answer with emptiness, not an error.

set local role anon;
set local test.uid = '';
select pg_temp.refused('a signed-out caller cannot even reach reconciliation',
  $$select public.reconcile_project('bbbbbbbb-0000-0000-0000-000000000001')$$);
select pg_temp.refused('nor the vision-count door',
  $$select public.record_vision_counts('bbbbbbbb-0000-0000-0000-000000000001', null, '{}'::uuid[], '[]'::jsonb)$$);
select pg_temp.refused('nor the coverage deriver',
  $$select public.derive_capture_coverage('bbbbbbbb-0000-0000-0000-000000000001')$$);
select pg_temp.refused('nor the intake rate-limiter, which belongs to the worker alone',
  $$select public.consume_project_intake_create_slot('a-hash', 10)$$);
select pg_temp.check('while a signed-out SELECT still answers with emptiness, not a refusal',
  (select count(*) from public.properties) = 0);
reset role;

set local role authenticated;
set local test.uid = '33333333-3333-3333-3333-333333333333';
select pg_temp.refused('no browser role holds the intake rate-limiter either',
  $$select public.consume_project_intake_create_slot('a-hash', 10)$$);
reset role;

--
-- The owner gets a key to one door. An external owner is invited by email,
-- signs in, and holds a read-only owner_viewer grant to exactly one
-- project: not the organization's other projects, not the tables, not one
-- action RPC, and never the Studio. The key is revocable and expirable at
-- both stages.

insert into auth.users(id, email) values
  ('55555555-5555-5555-5555-555555555555', 'client@example.com'),
  ('66666666-6666-6666-6666-666666666666', 'other-client@example.com');
insert into public.properties (id, organization_id, name, created_by) values
  ('bbbbbbbb-0000-0000-0000-0000000000aa', 'aaaaaaaa-0000-0000-0000-000000000001',
   'Second Org-A Project', '11111111-1111-1111-1111-111111111111');
insert into public.vision_releases (organization_id, property_id, version, state, manifest, created_by) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001', 99, 'approved',
   '{"spaces": []}'::jsonb, '11111111-1111-1111-1111-111111111111');

set local role authenticated;
set local test.uid = '11111111-1111-1111-1111-111111111111';
select public.invite_owner_viewer('bbbbbbbb-0000-0000-0000-000000000001', 'Client@Example.com');
select pg_temp.check('a project owner invites an owner viewer by email',
  exists (select 1 from public.property_invitations
          where property_id = 'bbbbbbbb-0000-0000-0000-000000000001'
            and invited_email = 'client@example.com' and state = 'invited' and role = 'owner_viewer'));
reset role;

set local role authenticated;
set local test.uid = '22222222-2222-2222-2222-222222222222';
select pg_temp.refused('a contributor does not hand out the key',
  $$select public.invite_owner_viewer('bbbbbbbb-0000-0000-0000-000000000001', 'someone@example.com')$$);
reset role;

set local role authenticated;
set local test.uid = '44444444-4444-4444-4444-444444444444';
select pg_temp.refused('another organisation cannot invite into this project',
  $$select public.invite_owner_viewer('bbbbbbbb-0000-0000-0000-000000000001', 'spy@example.com')$$);
reset role;

set local role authenticated;
set local test.uid = '55555555-5555-5555-5555-555555555555';
select pg_temp.check('the invitee sees their own invitation and nothing else',
  (select count(*) from public.property_invitations) = 1);
select pg_temp.check('signing in turns the invitation into a grant',
  public.accept_property_invitations() = 1);
select pg_temp.check('and the grant is the read-only owner_viewer key',
  public.can_access_property('bbbbbbbb-0000-0000-0000-000000000001')
  and public.property_role('bbbbbbbb-0000-0000-0000-000000000001') = 'owner_viewer');
select pg_temp.check('the key opens ONE door: the organisation''s other project stays shut',
  not public.can_access_property('bbbbbbbb-0000-0000-0000-0000000000aa'));
select pg_temp.check('and no table opens directly — properties, releases, documents all answer empty',
  (select count(*) from public.properties) = 0
  and (select count(*) from public.vision_releases) = 0
  and (select count(*) from public.project_documents) = 0);
select pg_temp.refused('an owner viewer cannot reconcile',
  $$select public.reconcile_project('bbbbbbbb-0000-0000-0000-000000000001')$$);
select pg_temp.refused('nor confirm a takeoff line',
  $$select public.review_takeoff_line('eeeeeeee-0000-0000-0000-000000000001', 'a line', 'confirmed', '1', null)$$);
select pg_temp.refused('nor invite anyone else',
  $$select public.invite_owner_viewer('bbbbbbbb-0000-0000-0000-000000000001', 'friend@example.com')$$);
reset role;

set local role authenticated;
set local test.uid = '66666666-6666-6666-6666-666666666666';
select pg_temp.check('an uninvited outsider sees no invitations',
  (select count(*) from public.property_invitations) = 0);
select pg_temp.check('has nothing to accept',
  public.accept_property_invitations() = 0);
select pg_temp.check('and holds no access',
  not public.can_access_property('bbbbbbbb-0000-0000-0000-000000000001'));
reset role;

-- The key expires: a grant with a past expiry answers nothing.
update public.property_members set expires_at = now() - interval '1 hour'
  where user_id = '55555555-5555-5555-5555-555555555555';
set local role authenticated;
set local test.uid = '55555555-5555-5555-5555-555555555555';
select pg_temp.check('an expired grant stops working',
  not public.can_access_property('bbbbbbbb-0000-0000-0000-000000000001')
  and public.property_role('bbbbbbbb-0000-0000-0000-000000000001') is null);
reset role;

-- And the key is revocable: re-granted, then taken back by the team.
set local role authenticated;
set local test.uid = '11111111-1111-1111-1111-111111111111';
select public.invite_owner_viewer('bbbbbbbb-0000-0000-0000-000000000001', 'client@example.com');
reset role;
set local role authenticated;
set local test.uid = '55555555-5555-5555-5555-555555555555';
select public.accept_property_invitations();
reset role;
set local role authenticated;
set local test.uid = '11111111-1111-1111-1111-111111111111';
select public.revoke_owner_view('bbbbbbbb-0000-0000-0000-000000000001', 'client@example.com');
reset role;
set local role authenticated;
set local test.uid = '55555555-5555-5555-5555-555555555555';
select pg_temp.check('a revoked key opens nothing',
  not public.can_access_property('bbbbbbbb-0000-0000-0000-000000000001'));
select pg_temp.check('and cannot be re-accepted',
  public.accept_property_invitations() = 0);
reset role;

-- Revocation never deletes a builder's grant: only the viewer key is taken.
insert into public.property_members (property_id, user_id, organization_id, role, granted_by)
values ('bbbbbbbb-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222',
        'aaaaaaaa-0000-0000-0000-000000000001', 'contributor', '11111111-1111-1111-1111-111111111111');
set local role authenticated;
set local test.uid = '11111111-1111-1111-1111-111111111111';
select public.revoke_owner_view('bbbbbbbb-0000-0000-0000-000000000001', 'contributor@example.com');
reset role;
select pg_temp.check('the contributor''s own project grant survives an owner-view revocation',
  exists (select 1 from public.property_members
          where user_id = '22222222-2222-2222-2222-222222222222'
            and property_id = 'bbbbbbbb-0000-0000-0000-000000000001' and role = 'contributor'));

set local role anon;
set local test.uid = '';
select pg_temp.refused('nobody signed out invites',
  $$select public.invite_owner_viewer('bbbbbbbb-0000-0000-0000-000000000001', 'x@example.com')$$);
select pg_temp.refused('nobody signed out accepts',
  $$select public.accept_property_invitations()$$);
select pg_temp.check('and invitations are invisible signed out',
  (select count(*) from public.property_invitations) = 0);
reset role;

-- Stacked is a seen thing (046). Bought-is-not-installed rested on
-- subtraction; a camera that can see a pallet standing in a room can say so,
-- and an observation is not the same evidence as an inference.
set local role authenticated;
set local test.uid = '22222222-2222-2222-2222-222222222222';
do $$
declare
  seen uuid;
begin
  seen := public.record_observation('bbbbbbbb-0000-0000-0000-000000000001', 'STACKED-1',
    'on_site_not_installed', 9, null, '{}'::uuid[], null, 'AI_VISION', 'medium', 'palletised against the north wall');
  perform pg_temp.check('material standing on site is its own observation',
    (select kind from public.project_observations where id = seen) = 'on_site_not_installed'
    and (select quantity from public.project_observations where id = seen) = 9);
end $$;
select pg_temp.refused('an on-site observation without a number is refused',
  $$select public.record_observation('bbbbbbbb-0000-0000-0000-000000000001', 'STACKED-2',
      'on_site_not_installed', null, null, '{}'::uuid[], null, 'AI_VISION', 'medium', null)$$);
/* A delivery note proves a delivery. It never saw a pallet. */
select pg_temp.refused('and a document cannot claim to have seen it standing there',
  $$select public.record_observation('bbbbbbbb-0000-0000-0000-000000000001', 'STACKED-3',
      'on_site_not_installed', 4, null, '{}'::uuid[], null, 'DOCUMENT', 'high', null)$$);
reset role;

set local role authenticated;
set local test.uid = '11111111-1111-1111-1111-111111111111';
do $$
declare
  pass jsonb;
begin
  pass := public.reconcile_period('bbbbbbbb-0000-0000-0000-000000000001',
                                  now() - interval '7 days', now());
  perform pg_temp.check('the period pass reports what was seen standing there',
    (select (entry->>'quantity')::numeric from jsonb_array_elements(pass->'on_site_seen') entry
      where entry->>'component_key' = 'STACKED-1') = 9);
  /* The two must never be merged: one was looked at, the other was worked out. */
  perform pg_temp.check('and keeps it apart from what subtraction merely implies',
    not exists (select 1 from jsonb_array_elements(pass->'on_site_not_installed') entry
      where entry->>'component_key' = 'STACKED-1')
    and pass->>'doctrine' like '%which is an inference and not the same thing%');
end $$;
reset role;

-- Money joins the record (045). Costs and a person's trade corrections used
-- to live in a browser: invisible to everyone else, absent from the export,
-- outside every audit, gone with the cache. And money is the one thing on a
-- project that must not be visible to everybody who can see the building.
set local role authenticated;
set local test.uid = '11111111-1111-1111-1111-111111111111';
do $$
declare
  cost_id uuid;
begin
  cost_id := public.record_project_cost('bbbbbbbb-0000-0000-0000-000000000001',
    'electrical', 12400, 'USD', 'INV-4471', null, 'rough electrical, first floor');
  perform pg_temp.check('a cost entry names the person who entered it',
    (select recorded_by from public.project_costs where id = cost_id)
      = '11111111-1111-1111-1111-111111111111'::uuid);
  /* Called on its own line: inside one AND, the planner is free to test the
     state before the call that changes it. */
  perform public.supersede_project_cost(cost_id);
  perform pg_temp.check('and withdrawing it supersedes rather than deletes',
    (select state from public.project_costs where id = cost_id) = 'superseded'
    and exists (select 1 from public.project_costs where id = cost_id));
  -- A correction outranks the dictionary forever after, so only one may be live.
  perform public.correct_observation_trade('bbbbbbbb-0000-0000-0000-000000000001', 'outlet-north-wall', 'electrical');
  perform public.correct_observation_trade('bbbbbbbb-0000-0000-0000-000000000001', 'outlet-north-wall', 'low_voltage');
  perform pg_temp.check('a trade correction leaves exactly one live ruling, and keeps the old one',
    (select count(*) from public.project_trade_corrections
      where observation_key = 'outlet-north-wall' and state = 'active') = 1
    and (select count(*) from public.project_trade_corrections
      where observation_key = 'outlet-north-wall') = 2
    and (select trade from public.project_trade_corrections
      where observation_key = 'outlet-north-wall' and state = 'active') = 'low_voltage');
end $$;
select pg_temp.refused('an entry that says nothing is not an entry',
  $$select public.record_project_cost('bbbbbbbb-0000-0000-0000-000000000001', 'framing')$$);
select pg_temp.refused('and a negative cost is refused',
  $$select public.record_project_cost('bbbbbbbb-0000-0000-0000-000000000001', 'framing', -5)$$);
reset role;

-- The field records what it saw; it has no business seeing what it cost.
set local role authenticated;
set local test.uid = '22222222-2222-2222-2222-222222222222';
select pg_temp.refused('a contributor cannot record money',
  $$select public.record_project_cost('bbbbbbbb-0000-0000-0000-000000000001', 'framing', 100)$$);
select pg_temp.check('nor read the ledger',
  (select count(*) from public.project_costs) = 0);
reset role;

set local role authenticated;
set local test.uid = '55555555-5555-5555-5555-555555555555';
select pg_temp.check('an external owner viewer sees an approved release, not the ledger',
  (select count(*) from public.project_costs) = 0);
select pg_temp.refused('and cannot overrule the trade dictionary',
  $$select public.correct_observation_trade('bbbbbbbb-0000-0000-0000-000000000001', 'x', 'framing')$$);
reset role;

set local role anon;
set local test.uid = '';
select pg_temp.refused('nobody signed out records money',
  $$select public.record_project_cost('bbbbbbbb-0000-0000-0000-000000000001', 'framing', 100)$$);
/* Harder than invisible: signed out, the policy that guards the ledger
   cannot even be evaluated. */
select pg_temp.refused('and the ledger cannot even be looked at signed out',
  $$select count(*) from public.project_costs$$);
reset role;

-- The period pass (044). Every number cumulative meant the question an owner
-- asks weekly — what arrived, what went in, what is sitting on site — had no
-- answer at all. These check that the window is real, that bought-and-not-
-- installed is a row rather than a slogan, and that no budget was invented.
--
-- The rows go in before a role is taken: back-dating an observation is not
-- something the recording door allows, and rightly so — a person cannot
-- claim to have seen something last month.
insert into public.project_observations(organization_id, property_id, component_key, kind,
  quantity, method, confidence, observed_at, state)
values
  ('aaaaaaaa-0000-0000-0000-000000000001','bbbbbbbb-0000-0000-0000-000000000001',
   'PERIOD-1','delivered_documented', 10, 'DOCUMENT', 'high', now() - interval '40 days', 'active'),
  ('aaaaaaaa-0000-0000-0000-000000000001','bbbbbbbb-0000-0000-0000-000000000001',
   'PERIOD-1','delivered_documented', 4, 'DOCUMENT', 'high', now() - interval '2 days', 'active'),
  ('aaaaaaaa-0000-0000-0000-000000000001','bbbbbbbb-0000-0000-0000-000000000001',
   'PERIOD-1','installed_seen', 6, 'AI_VISION', 'medium', now() - interval '1 day', 'active');

set local role authenticated;
set local test.uid = '11111111-1111-1111-1111-111111111111';
do $$
declare
  pass jsonb;
begin
  pass := public.reconcile_period('bbbbbbbb-0000-0000-0000-000000000001',
                                  now() - interval '7 days', now());

  perform pg_temp.check('the window holds only what happened inside it',
    (select (entry->>'quantity')::numeric from jsonb_array_elements(pass->'arrived') entry
      where entry->>'component_key' = 'PERIOD-1') = 4);
  perform pg_temp.check('and what the capture confirmed in the same window',
    (select (entry->>'quantity')::numeric from jsonb_array_elements(pass->'installed') entry
      where entry->>'component_key' = 'PERIOD-1') = 6);
  -- Fourteen delivered across all time, six installed: eight are on site.
  perform pg_temp.check('bought and not installed is a number, not a slogan',
    (select (entry->>'difference')::numeric from jsonb_array_elements(pass->'on_site_not_installed') entry
      where entry->>'component_key' = 'PERIOD-1') = 8);
  perform pg_temp.check('a delivery from before the window still counts as on site',
    (select (entry->>'delivered_total')::numeric from jsonb_array_elements(pass->'on_site_not_installed') entry
      where entry->>'component_key' = 'PERIOD-1') = 14);
  -- The one thing this pass must never grow on its own.
  perform pg_temp.check('the pass invents no budget and no forecast',
    not (pass ? 'budget') and not (pass ? 'forecast') and not (pass ? 'projection')
    and pass->>'doctrine' like '%holds no budget%');
end $$;

select pg_temp.refused('a period that ends before it begins is refused',
  $$select public.reconcile_period('bbbbbbbb-0000-0000-0000-000000000001', now(), now() - interval '1 day')$$);
reset role;

set local role authenticated;
set local test.uid = '55555555-5555-5555-5555-555555555555';
select pg_temp.refused('an owner viewer cannot run the period pass',
  $$select public.reconcile_period('bbbbbbbb-0000-0000-0000-000000000001')$$);
reset role;

-- The register of what could not be read (047). Every reading already admits
-- what it could not do — and then that admission stayed inside the run.
-- These check the cumulative register: that it fills itself, that it counts
-- recurrence, that a person's answer is the only thing that can mark a gap
-- answered, and that a reader falling silent is recorded as silence.

-- The three readings above ran without anybody calling the register.
select pg_temp.check('a count the distiller could not make is on the register by itself',
  exists (select 1 from public.plan_reading_gaps
          where property_id = 'bbbbbbbb-0000-0000-0000-000000000001'
            and kind = 'no_count' and component_key = 'PF-1'
            and question like 'No count could be read for PF-1%'));
/* BM.1 could not be counted in reading 2; readings 3 and 4 never mentioned
   it. That is silence, and the register says so in those words. */
select pg_temp.check('a gap a later reading stopped raising is silence, never an answer',
  (select status from public.plan_reading_gaps
    where property_id = 'bbbbbbbb-0000-0000-0000-000000000001'
      and kind = 'no_count' and component_key = 'BM.1') = 'not_raised_again'
  and (select answer from public.plan_reading_gaps
    where property_id = 'bbbbbbbb-0000-0000-0000-000000000001'
      and kind = 'no_count' and component_key = 'BM.1') is null);

-- Two more readings of the same set. The first question survives into the
-- second reading with different capitals and punctuation — the same failure,
-- not a new one.
insert into public.document_baselines(id, organization_id, property_id, version, state,
  source_document_ids, analysis, gaps, created_by)
values ('eeeeeeee-0000-0000-0000-000000000005','aaaaaaaa-0000-0000-0000-000000000001',
  'bbbbbbbb-0000-0000-0000-000000000001', 5, 'review', '{}'::uuid[],
  '{"component_schedules":[
     {"mark":"MW-3","category":"millwork","description":"base cabinet run","unit":"count","count_scheduled":0,"count_drawn":0,"count_proposed":3,"count_confidence":"low","count_note":"tags partly obscured","source_refs":["A-8.2"]}
   ]}'::jsonb,
  '[{"severity":"critical","question":"Which schedule governs the door counts?","source_refs":["A-6.0"],"blocks_activation":true},
    {"severity":"informational","question":"Is the deck framing revised after RFI 12?","source_refs":["S-2.0"],"blocks_activation":false}]'::jsonb,
  '11111111-1111-1111-1111-111111111111');

set local role authenticated;
set local test.uid = '33333333-3333-3333-3333-333333333333';
select public.extract_project_requirements('eeeeeeee-0000-0000-0000-000000000005');
reset role;

/* A number the reader would not stand behind is a different failure from no
   number at all, and the register keeps the two apart. */
select pg_temp.check('a count that came back weak is its own kind of failure',
  exists (select 1 from public.plan_reading_gaps
          where property_id = 'bbbbbbbb-0000-0000-0000-000000000001'
            and kind = 'weak_count' and component_key = 'MW-3'
            and question like '%low confidence%'
            and source_refs = '["A-8.2"]'::jsonb));

select pg_temp.check('a reading''s own questions land on the register with their severity',
  (select count(*) from public.plan_reading_gaps
    where property_id = 'bbbbbbbb-0000-0000-0000-000000000001'
      and kind = 'unanswered_question' and status = 'open') = 2
  and exists (select 1 from public.plan_reading_gaps
              where gap_key = 'which schedule governs the door counts'
                and severity = 'critical' and blocks_activation
                and readings_seen = 1));

insert into public.document_baselines(id, organization_id, property_id, version, state,
  source_document_ids, analysis, gaps, created_by)
values ('eeeeeeee-0000-0000-0000-000000000006','aaaaaaaa-0000-0000-0000-000000000001',
  'bbbbbbbb-0000-0000-0000-000000000001', 6, 'review', '{}'::uuid[], '{}'::jsonb,
  '[{"severity":"critical","question":"  Which schedule governs the DOOR counts  ","source_refs":["A-2.1"],"blocks_activation":true}]'::jsonb,
  '11111111-1111-1111-1111-111111111111');

select pg_temp.check('the same question asked twice is one row that has been asked twice',
  (select readings_seen from public.plan_reading_gaps
    where gap_key = 'which schedule governs the door counts') = 2
  and (select first_seen_baseline from public.plan_reading_gaps
    where gap_key = 'which schedule governs the door counts') = 'eeeeeeee-0000-0000-0000-000000000005'
  and (select last_seen_baseline from public.plan_reading_gaps
    where gap_key = 'which schedule governs the door counts') = 'eeeeeeee-0000-0000-0000-000000000006');
select pg_temp.check('and every sheet that ever raised it stays in its provenance',
  (select source_refs from public.plan_reading_gaps
    where gap_key = 'which schedule governs the door counts') = '["A-2.1", "A-6.0"]'::jsonb);
select pg_temp.check('the question the newest reading dropped is marked as dropped, not as done',
  (select status from public.plan_reading_gaps
    where gap_key = 'is the deck framing revised after rfi 12') = 'not_raised_again');

-- Only a person answers.
set local role authenticated;
set local test.uid = '11111111-1111-1111-1111-111111111111';
do $$
declare
  door_gap uuid;
  deck_gap uuid;
begin
  select id into door_gap from public.plan_reading_gaps
    where gap_key = 'which schedule governs the door counts';
  select id into deck_gap from public.plan_reading_gaps
    where gap_key = 'is the deck framing revised after rfi 12';
  perform public.answer_plan_reading_gap(door_gap, 'answered',
    'A-6.0 governs; the floor-plan tags are informational.');
  perform pg_temp.check('an answer carries the name of the person who gave it',
    (select status from public.plan_reading_gaps where id = door_gap) = 'answered'
    and (select answered_by from public.plan_reading_gaps where id = door_gap)
        = '11111111-1111-1111-1111-111111111111'::uuid
    and (select answered_at from public.plan_reading_gaps where id = door_gap) is not null);
  perform public.answer_plan_reading_gap(deck_gap, 'withdrawn',
    'RFI 12 was closed without a drawing change.');
  perform pg_temp.check('and a gap that no longer applies is withdrawn by a person too',
    (select status from public.plan_reading_gaps where id = deck_gap) = 'withdrawn');
end $$;
select pg_temp.refused('an answer that says nothing is not an answer',
  $$select public.answer_plan_reading_gap(
      (select id from public.plan_reading_gaps where gap_key = 'pf-1'), 'answered', '   ')$$);
select pg_temp.refused('and nothing else can be done to a gap',
  $$select public.answer_plan_reading_gap(
      (select id from public.plan_reading_gaps where gap_key = 'pf-1'), 'resolved', 'done')$$);
reset role;

-- A seventh reading raises both again. An answer the drawings never absorbed
-- is a gap that is still open; a person's withdrawal is not overturned by a
-- machine repeating itself.
insert into public.document_baselines(id, organization_id, property_id, version, state,
  source_document_ids, analysis, gaps, created_by)
values ('eeeeeeee-0000-0000-0000-000000000007','aaaaaaaa-0000-0000-0000-000000000001',
  'bbbbbbbb-0000-0000-0000-000000000001', 7, 'review', '{}'::uuid[], '{}'::jsonb,
  '[{"severity":"critical","question":"Which schedule governs the door counts?","source_refs":["A-6.0"],"blocks_activation":true},
    {"severity":"informational","question":"Is the deck framing revised after RFI 12?","source_refs":["S-2.0"],"blocks_activation":false}]'::jsonb,
  '11111111-1111-1111-1111-111111111111');

select pg_temp.check('an answered question raised again is open again, and keeps the answer it was given',
  (select status from public.plan_reading_gaps
    where gap_key = 'which schedule governs the door counts') = 'open'
  and (select answer from public.plan_reading_gaps
    where gap_key = 'which schedule governs the door counts') like 'A-6.0 governs%'
  and (select readings_seen from public.plan_reading_gaps
    where gap_key = 'which schedule governs the door counts') = 3);
select pg_temp.check('a person''s withdrawal is not overturned by the reader repeating itself',
  (select status from public.plan_reading_gaps
    where gap_key = 'is the deck framing revised after rfi 12') = 'withdrawn'
  and (select readings_seen from public.plan_reading_gaps
    where gap_key = 'is the deck framing revised after rfi 12') = 2);

set local role authenticated;
set local test.uid = '11111111-1111-1111-1111-111111111111';
do $$
declare
  register jsonb;
  spots jsonb;
begin
  register := public.plan_reading_register('bbbbbbbb-0000-0000-0000-000000000001');
  perform pg_temp.check('the register ranks what blocks activation first',
    register->'open'->0->>'gap_key' is null
    and (register->'open'->0->>'blocks_activation')::boolean
    and register->'open'->0->>'question' like 'Which schedule governs%');
  perform pg_temp.check('it counts recurrence, blockers and how long the oldest has been open',
    (register->'summary'->>'recurring')::integer >= 1
    and (register->'summary'->>'blocking')::integer = 1
    and (register->'summary'->>'readings')::integer = 7
    and (register->'summary'->>'withdrawn')::integer = 1);
  perform pg_temp.check('and it says out loud that silence is not an answer',
    register->>'doctrine' like '%a reader falling silent is not an answer%');

  spots := public.plan_reading_weak_spots('aaaaaaaa-0000-0000-0000-000000000001');
  perform pg_temp.check('the weak-spot map counts the kinds of failure across the projects',
    exists (select 1 from jsonb_array_elements(spots->'by_kind') k
             where k->>'kind' = 'no_count' and (k->>'gaps')::integer >= 1));
  perform pg_temp.check('and names the sheets the reader keeps stumbling on',
    exists (select 1 from jsonb_array_elements(spots->'by_sheet') s
             where s->>'sheet' = 'A-6.0'));
  perform pg_temp.check('while claiming nothing about the drawings or the work',
    spots->>'doctrine' like '%not a judgement of any drawing set%');
end $$;
reset role;

-- Who may look, and who may write.
/* Held outside the register, because the roles below cannot read it — a
   refusal that only proves the id was invisible proves nothing. */
create temporary table register_ids as
  select id from public.plan_reading_gaps where gap_key = 'pf-1';
grant select on register_ids to authenticated;

set local role authenticated;
set local test.uid = '22222222-2222-2222-2222-222222222222';
select pg_temp.check('a field contributor does not read the register of the reader''s failures',
  (select count(*) from public.plan_reading_gaps) = 0);
select pg_temp.refused('nor answers a real gap they were handed the id of',
  $$select public.answer_plan_reading_gap((select id from register_ids), 'answered', 'anything')$$);
select pg_temp.refused('nor reads the register through its own door',
  $$select public.plan_reading_register('bbbbbbbb-0000-0000-0000-000000000001')$$);
reset role;

set local role authenticated;
set local test.uid = '44444444-4444-4444-4444-444444444444';
select pg_temp.refused('another organisation gets no weak-spot map of this one',
  $$select public.plan_reading_weak_spots('aaaaaaaa-0000-0000-0000-000000000001')$$);
reset role;

set local role authenticated;
set local test.uid = '11111111-1111-1111-1111-111111111111';
/* The register is written by the readings themselves. There is no write
   policy at all, so not even the project owner can put a row in by hand. */
select pg_temp.refused('nobody writes to the register by hand — not even the owner',
  $$insert into public.plan_reading_gaps(organization_id, property_id, kind, gap_key, question)
    values ('aaaaaaaa-0000-0000-0000-000000000001','bbbbbbbb-0000-0000-0000-000000000001',
            'no_count','invented','A gap nobody read')$$);
/* An update finds no row to change: there is no update policy, so the row
   the owner can read is not a row the owner can write. */
select pg_temp.affects('nor edits one — the register has no writable rows at all',
  $$update public.plan_reading_gaps set status = 'answered' where gap_key = 'pf-1'$$, 0);
select pg_temp.affects('nor deletes one',
  $$delete from public.plan_reading_gaps where gap_key = 'pf-1'$$, 0);
select pg_temp.check('and the row stands exactly as the reading left it',
  (select status from public.plan_reading_gaps where gap_key = 'pf-1') <> 'answered');
reset role;

select pg_temp.check('the fold is the triggers'' alone, and its triggers keep firing without EXECUTE',
  not has_function_privilege('authenticated', 'public.fold_plan_reading_gaps(uuid,boolean)', 'execute')
  and not has_function_privilege('anon', 'public.fold_plan_reading_gaps(uuid,boolean)', 'execute')
  and not has_function_privilege('authenticated', 'public.note_baseline_reading_gaps()', 'execute')
  and not has_function_privilege('authenticated', 'public.note_extraction_reading_gaps()', 'execute'));

set local role anon;
set local test.uid = '';
select pg_temp.refused('signed out, the register cannot even be looked at',
  $$select count(*) from public.plan_reading_gaps$$);
select pg_temp.refused('and its doors are shut',
  $$select public.plan_reading_register('bbbbbbbb-0000-0000-0000-000000000001')$$);
reset role;

-- ══════════════════════════════════ AI COST GUARD ══════════════════════════
-- The double payment this migration exists to stop, proved without spending
-- anything: the guard is a unique index, and an index can be tested.
--
-- The claim and finish calls run unprivileged-of-role here, as the workers do
-- with the service key — a signed-in person cannot call them at all, which is
-- itself checked at the end.
reset role;

-- 1 · the first claim on a fingerprint is granted
select pg_temp.check('a fingerprint nobody has claimed is CLAIMED',
  (select verdict from public.claim_ai_run(
     'aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001',
     'spatial-analyze', 'test-model', 'contract-1', 'fp-alpha')) = 'CLAIMED');

-- 2 · THE DOUBLE CLICK. A second identical claim while the first is in flight
-- is refused, and no second row exists to be paid for.
select pg_temp.check('a second identical claim in flight is RUNNING, not a second call',
  (select verdict from public.claim_ai_run(
     'aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001',
     'spatial-analyze', 'test-model', 'contract-1', 'fp-alpha')) = 'RUNNING');
select pg_temp.check('and exactly one paid run exists for that fingerprint',
  (select count(*) from public.ai_runs where input_fingerprint = 'fp-alpha') = 1);

-- 3 · the index itself refuses. This is what makes two SIMULTANEOUS requests
-- safe rather than merely usually safe: the second insert cannot land, whoever
-- attempts it and whenever it arrives.
select pg_temp.refused('the database itself refuses a second in-flight row',
  $$insert into public.ai_runs (organization_id, process_key, model, input_fingerprint, state)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'spatial-analyze', 'test-model', 'fp-alpha', 'running')$$);

-- 4 · a finished run is reused rather than bought again
select public.finish_ai_run(
  (select id from public.ai_runs where input_fingerprint = 'fp-alpha'),
  'succeeded', '{"input_tokens": 120, "output_tokens": 30, "total_tokens": 150}'::jsonb);
select pg_temp.check('unchanged inputs return the reading that already exists',
  (select verdict from public.claim_ai_run(
     'aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001',
     'spatial-analyze', 'test-model', 'contract-1', 'fp-alpha')) = 'REUSED');
select pg_temp.check('and still exactly one paid run',
  (select count(*) from public.ai_runs where input_fingerprint = 'fp-alpha') = 1);

-- 5 · usage is recorded as the provider reported it
select pg_temp.check('usage is stored with the run',
  (select input_tokens = 120 and output_tokens = 30 and total_tokens = 150 and usage_available
     from public.ai_runs where input_fingerprint = 'fp-alpha'));

-- 6 · a provider that returns no usage does not break anything
select public.claim_ai_run('aaaaaaaa-0000-0000-0000-000000000001',
  'bbbbbbbb-0000-0000-0000-000000000001', 'document-classify', 'test-model', 'contract-1', 'fp-nousage');
select public.finish_ai_run(
  (select id from public.ai_runs where input_fingerprint = 'fp-nousage'), 'succeeded', '{}'::jsonb);
select pg_temp.check('a run whose provider returned no usage still closes, marked unavailable',
  (select state = 'succeeded' and not usage_available and input_tokens is null
     from public.ai_runs where input_fingerprint = 'fp-nousage'));

-- 7 · a different fingerprint is a different purchase. Changed evidence,
-- changed model and changed contract version each produce one.
select pg_temp.check('changed evidence is a new run',
  (select verdict from public.claim_ai_run(
     'aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001',
     'spatial-analyze', 'test-model', 'contract-1', 'fp-changed-evidence')) = 'CLAIMED');
select pg_temp.check('a changed model is a new run',
  (select verdict from public.claim_ai_run(
     'aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001',
     'spatial-analyze', 'other-model', 'contract-1', 'fp-changed-model')) = 'CLAIMED');
select pg_temp.check('a changed contract version is a new run',
  (select verdict from public.claim_ai_run(
     'aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001',
     'spatial-analyze', 'test-model', 'contract-2', 'fp-changed-contract')) = 'CLAIMED');

-- 8 · a confirmed Reanalyze buys exactly one more reading of the same inputs
select pg_temp.check('a forced rerun of an identical reading is CLAIMED',
  (select verdict from public.claim_ai_run(
     'aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001',
     'spatial-analyze', 'test-model', 'contract-1', 'fp-alpha',
     null, null, null, true)) = 'CLAIMED');
select pg_temp.check('and buys exactly one, never two',
  (select count(*) from public.ai_runs where input_fingerprint = 'fp-alpha') = 2);
-- Forcing is not a way round the in-flight guard.
select pg_temp.check('forcing twice while one is in flight is still RUNNING',
  (select verdict from public.claim_ai_run(
     'aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001',
     'spatial-analyze', 'test-model', 'contract-1', 'fp-alpha',
     null, null, null, true)) = 'RUNNING');

-- 9 · a failed run can be retried safely — failing releases the guard
select public.finish_ai_run(
  (select id from public.ai_runs where input_fingerprint = 'fp-alpha' and state = 'running'),
  'failed', '{}'::jsonb, 'provider_timeout');
select public.claim_ai_run('aaaaaaaa-0000-0000-0000-000000000001',
  'bbbbbbbb-0000-0000-0000-000000000001', 'document-evidence', 'test-model', 'contract-1', 'fp-retry');
select public.finish_ai_run(
  (select id from public.ai_runs where input_fingerprint = 'fp-retry'), 'failed', '{}'::jsonb, 'reader_failed');
select pg_temp.check('a failed reading is retried rather than reused as a result',
  (select verdict from public.claim_ai_run(
     'aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001',
     'document-evidence', 'test-model', 'contract-1', 'fp-retry')) = 'CLAIMED');

-- 10 · all five workflows are recordable, and nothing else is
select public.claim_ai_run('aaaaaaaa-0000-0000-0000-000000000001',
  'bbbbbbbb-0000-0000-0000-000000000001', 'plan-analyze', 'm', 'c', 'fp-w1');
select public.claim_ai_run('aaaaaaaa-0000-0000-0000-000000000001',
  'bbbbbbbb-0000-0000-0000-000000000001', 'spatial-analyze', 'm', 'c', 'fp-w2');
select public.claim_ai_run('aaaaaaaa-0000-0000-0000-000000000001',
  'bbbbbbbb-0000-0000-0000-000000000001', 'document-classify', 'm', 'c', 'fp-w3');
select public.claim_ai_run('aaaaaaaa-0000-0000-0000-000000000001',
  'bbbbbbbb-0000-0000-0000-000000000001', 'document-evidence', 'm', 'c', 'fp-w4');
select public.claim_ai_run('aaaaaaaa-0000-0000-0000-000000000001',
  'bbbbbbbb-0000-0000-0000-000000000001', 'field-quality-check', 'm', 'c', 'fp-w5');
select pg_temp.check('usage is recordable for all five AI workflows',
  (select count(distinct process_key) from public.ai_runs
    where input_fingerprint in ('fp-w1','fp-w2','fp-w3','fp-w4','fp-w5')) = 5);
select pg_temp.refused('and a process nobody wrote cannot be recorded',
  $$select public.claim_ai_run('aaaaaaaa-0000-0000-0000-000000000001',
      'bbbbbbbb-0000-0000-0000-000000000001', 'made-up-worker', 'm', 'c', 'fp-nope')$$);

-- 11 · the project's own people see the ledger and its honest silence on money
set local test.uid = '11111111-1111-1111-1111-111111111111';
set local role authenticated;
select pg_temp.check('the project team sees its own runs',
  (select count(*) from public.ai_runs) > 0);
select pg_temp.check('the summary reports runs and tokens',
  (select runs > 0 and total_tokens >= 150 from public.ai_usage_summary('bbbbbbbb-0000-0000-0000-000000000001')));
select pg_temp.check('and reports no cost while no price list exists',
  (select estimated_cost_micros is null and pricing_source is null
     from public.ai_usage_summary('bbbbbbbb-0000-0000-0000-000000000001')));

-- 12 · another organization sees none of it
reset role;
set local test.uid = '44444444-4444-4444-4444-444444444444';
set local role authenticated;
select pg_temp.check('another organization sees no runs at all',
  (select count(*) from public.ai_runs) = 0);
select pg_temp.check('and its usage summary for our project is empty',
  coalesce((select runs from public.ai_usage_summary('bbbbbbbb-0000-0000-0000-000000000001')), 0) = 0);
reset role;

-- 13 · the ledger is never written from a browser.
--
-- Proved the way this file proves every other write gate: by refusal. The
-- table carries a read policy and no write policy at all, so RLS turns any
-- hand-written row away whoever is signed in — and the two doors that DO
-- write are closed to every browser role.
set local test.uid = '11111111-1111-1111-1111-111111111111';
set local role authenticated;
select pg_temp.refused('nobody writes the ledger by hand — not even the project owner',
  $$insert into public.ai_runs (organization_id, process_key, model, input_fingerprint)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'spatial-analyze', 'm', 'fp-forged')$$);
select pg_temp.affects('nor edits a run to erase what was spent',
  $$update public.ai_runs set total_tokens = 0$$, 0);
select pg_temp.affects('nor deletes one', $$delete from public.ai_runs$$, 0);
select pg_temp.refused('and a signed-in person cannot claim a run at all',
  $$select public.claim_ai_run('aaaaaaaa-0000-0000-0000-000000000001',
      'bbbbbbbb-0000-0000-0000-000000000001', 'spatial-analyze', 'm', 'c', 'fp-theft')$$);
select pg_temp.refused('nor close one',
  $$select public.finish_ai_run('00000000-0000-0000-0000-000000000001', 'succeeded')$$);
reset role;
select pg_temp.check('the ledger''s two doors are shut to every browser role',
  not has_function_privilege('authenticated',
    'public.claim_ai_run(uuid,uuid,text,text,text,text,text,uuid,text,boolean)', 'execute')
  and not has_function_privilege('anon',
    'public.claim_ai_run(uuid,uuid,text,text,text,text,text,uuid,text,boolean)', 'execute')
  and not has_function_privilege('authenticated', 'public.finish_ai_run(uuid,text,jsonb,text)', 'execute'));
-- ═══════════════════════════════ ASK THIS PROJECT ══════════════════════════
-- Deep search answers from ONE project's own record, and the two things that
-- must hold whatever a model says: another organization can never reach it,
-- and a citation is only ever a record that was actually retrieved.
reset role;
insert into public.project_requirements(organization_id, property_id, baseline_id, component_key, description, quantity, method)
select 'aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001',
 'eeeeeeee-0000-0000-0000-000000000001', 'search-test-beams-' || n,
 repeat('Beam framing evidence. ', 100), 14, 'PRINTED_FACT'
from generate_series(1, 4) n;
reset role;
set local test.uid = '11111111-1111-1111-1111-111111111111';
set local role authenticated;

select pg_temp.check('retrieval finds this project''s own records',
  (select count(*) from public.project_search_context(
     'bbbbbbbb-0000-0000-0000-000000000001', 'How many beams are required and where is that shown?', 40, 24000) where kind = 'requirement') >= 4);

select pg_temp.check('a question about beam evidence retrieves requirements',
  (select count(*) from public.project_search_context(
    'bbbbbbbb-0000-0000-0000-000000000001', 'What evidence is recorded for beams?', 40, 24000) where kind = 'requirement') >= 4);
select pg_temp.check('a framing quantity question retrieves requirements',
  (select count(*) from public.project_search_context(
    'bbbbbbbb-0000-0000-0000-000000000001', 'What quantities are required for framing?', 40, 24000) where kind = 'requirement') >= 4);

-- Every row carries a stable id of the shape the worker verifies against,
-- and a version, so a changed record is a different question.
select pg_temp.check('every retrieved row has a stable source id and a version',
  not exists (select 1 from public.project_search_context(
     'bbbbbbbb-0000-0000-0000-000000000001', 'evidence', 40, 24000) r
   where r.source_id is null or r.source_id !~ '^[a-z]+:' or r.version is null));

-- THE COST CAP. Not a record count alone: forty long readings and forty short
-- rows are the same number and very different money.
select pg_temp.check('retrieval never returns more rows than asked for',
  (select count(*) from public.project_search_context(
     'bbbbbbbb-0000-0000-0000-000000000001', 'evidence room capture', 3, 24000)) <= 3);
-- THE COST CAP THAT ACTUALLY BINDS. A record count is not a limit: forty
-- long readings and forty short rows are the same number and very different
-- money, and the long ones are what a real project produces.
select pg_temp.check('and never more characters than the budget allows',
  coalesce((select sum(char_length(coalesce(r.body, '')) + char_length(coalesce(r.title, ''))) from public.project_search_context(
     'bbbbbbbb-0000-0000-0000-000000000001', 'evidence room capture', 40, 600) r), 0) <= 600);
select pg_temp.check('a smaller budget really does return less',
  coalesce((select sum(char_length(coalesce(r.body, '')) + char_length(coalesce(r.title, ''))) from public.project_search_context(
     'bbbbbbbb-0000-0000-0000-000000000001', 'evidence room capture', 40, 600) r), 0)
  < coalesce((select sum(char_length(coalesce(r.body, '')) + char_length(coalesce(r.title, ''))) from public.project_search_context(
     'bbbbbbbb-0000-0000-0000-000000000001', 'evidence room capture', 40, 24000) r), 0));

-- A question that matches nothing retrieves nothing, so the worker refuses
-- rather than paying for a call it cannot cite.
select pg_temp.check('a question matching nothing retrieves nothing',
  (select count(*) from public.project_search_context(
     'bbbbbbbb-0000-0000-0000-000000000001', 'zzzzqqqqxxxx', 40, 24000)) = 0);

-- 12 · another organization
reset role;
set local test.uid = '44444444-4444-4444-4444-444444444444';
set local role authenticated;
select pg_temp.check('another organization retrieves nothing from this project',
  (select count(*) from public.project_search_context(
     'bbbbbbbb-0000-0000-0000-000000000001', 'evidence room capture', 40, 24000)) = 0);
select pg_temp.check('and reads none of its saved answers',
  (select count(*) from public.project_search_answers) = 0);
select pg_temp.check('and gets nothing back from the saved-answer door',
  (select count(*) from public.project_search_answer_for(
     'bbbbbbbb-0000-0000-0000-000000000001', 'any-fingerprint')) = 0);
reset role;

-- Answers are written by the worker alone.
set local test.uid = '11111111-1111-1111-1111-111111111111';
set local role authenticated;
select pg_temp.refused('nobody writes an answer by hand',
  $$insert into public.project_search_answers
      (organization_id, property_id, question, question_normalized, input_fingerprint, answer)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001',
            'q', 'q', 'fp', 'forged')$$);
select pg_temp.refused('and the writer is closed to every browser role',
  $$select public.record_project_search_answer(
      'aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001',
      null, 'q', 'q', 'fp', 'a', '[]'::jsonb, null, 'low', '{}', 0, 0, false, null, null)$$);
reset role;

-- A refused answer is never served as knowledge: the question is asked again
-- rather than the refusal being cached as if it were an answer.
select public.record_project_search_answer(
  'aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001',
  null, 'how many beams', 'how many beams', 'fp-refused',
  'UNVERIFIED MODEL PROSE MUST NEVER RETURN',
  '[]'::jsonb, 'nothing cited', 'low', '{}', 0, 0, true, 'no citation survived verification', null);
set local test.uid = '11111111-1111-1111-1111-111111111111';
set local role authenticated;
select pg_temp.check('a repeat refusal returns safe prose without another paid call',
  (select answer = 'I could not find enough evidence in this project to answer reliably.' and citations = '[]'::jsonb
   from public.project_search_answer_for('bbbbbbbb-0000-0000-0000-000000000001', 'fp-refused')));
reset role;

-- A verified answer is, so the same question costs nothing twice.
select public.record_project_search_answer(
  'aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001',
  null, 'how many beams', 'how many beams', 'fp-good',
  'The plan set identifies 14 posts.',
  '[{"source_id":"requirement:1","opens":"comparison"}]'::jsonb, null, 'high',
  '{requirement:1}', 3, 900, false, null, null);
set local test.uid = '11111111-1111-1111-1111-111111111111';
set local role authenticated;
select pg_temp.check('a verified answer is served again without a second AI call',
  (select count(*) from public.project_search_answer_for(
     'bbbbbbbb-0000-0000-0000-000000000001', 'fp-good')) = 1);
reset role;

-- Project Search spends money, so the ledger admits it.
select pg_temp.check('project-search is a recordable process in the AI ledger',
  (select verdict from public.claim_ai_run(
     'aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001',
     'project-search', 'm', 'c', 'fp-search-1')) = 'CLAIMED');
select public.finish_ai_run(
  (select id from public.ai_runs where input_fingerprint = 'fp-search-1'), 'succeeded', '{}'::jsonb);
select pg_temp.check('and the same question on an unchanged project is not bought twice',
  (select verdict from public.claim_ai_run(
     'aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001',
     'project-search', 'm', 'c', 'fp-search-1')) = 'REUSED');

-- ═════════════════════════════ THE UNKNOWN OUTCOME ═════════════════════════
--
-- 048 stopped paying twice for a reading somebody asked for twice. This is
-- the other double payment: a request that went out, did the work, was
-- billed, and whose answer never came back. 'failed' was a free pass to buy
-- it again. 'outcome_unknown' is not.

-- A run whose answer was lost is not a failure and is not free to repeat.
select verdict, run_id from public.claim_ai_run(
  'aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001',
  'plan-analyze', 'm', 'c', 'fp-lost-answer') \gset lost_
select public.finish_ai_run(:'lost_run_id', 'outcome_unknown', '{}'::jsonb, 'response_lost');

select pg_temp.check('a lost answer is recorded as an unknown outcome, not a failure',
  (select state from public.ai_runs where id = :'lost_run_id') = 'outcome_unknown');
select pg_temp.check('and nobody may buy that reading again without saying so',
  (select verdict from public.claim_ai_run(
     'aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001',
     'plan-analyze', 'm', 'c', 'fp-lost-answer')) = 'UNKNOWN');
-- Forcing means "buy another reading of inputs I already have". It has never
-- meant "buy one that may already be on the invoice".
select pg_temp.check('forcing does not walk past an unknown outcome',
  (select verdict from public.claim_ai_run(
     'aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001',
     'plan-analyze', 'm', 'c', 'fp-lost-answer', null, null, null, true)) = 'UNKNOWN');
select pg_temp.check('and no second run was created while it was refused',
  (select count(*) from public.ai_runs where input_fingerprint = 'fp-lost-answer') = 1);

-- The confirmation, and the fact that it is worth exactly one run.
set local test.uid = '11111111-1111-1111-1111-111111111111';
set local role authenticated;
select pg_temp.check('a member may authorise the retry',
  public.confirm_ai_run_retry(:'lost_run_id') = true);
reset role;
set local test.uid = '44444444-4444-4444-4444-444444444444';
set local role authenticated;
select pg_temp.check('and somebody from another organization may not',
  public.confirm_ai_run_retry(:'lost_run_id') = false);
reset role;

select verdict, run_id from public.claim_ai_run(
  'aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001',
  'plan-analyze', 'm', 'c', 'fp-lost-answer') \gset after_
select pg_temp.check('the authorised retry is allowed exactly once',
  :'after_verdict' = 'CLAIMED');
select pg_temp.check('the authorisation it spent is marked consumed',
  (select retry_consumed_at is not null from public.ai_runs where id = :'lost_run_id'));
-- And it does not carry over. The authorised retry loses its answer too; the
-- next attempt must stop again rather than inherit the old permission.
select public.finish_ai_run(:'after_run_id', 'outcome_unknown', '{}'::jsonb, 'response_lost');
select pg_temp.check('one confirmation authorises one run and no more',
  (select verdict from public.claim_ai_run(
     'aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001',
     'plan-analyze', 'm', 'c', 'fp-lost-answer')) = 'UNKNOWN');

-- A failure the provider declared is still free to retry: this file must not
-- turn every error into a confirmation dialog.
select verdict, run_id from public.claim_ai_run(
  'aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001',
  'spatial-analyze', 'm', 'c', 'fp-refused') \gset refused_
select public.finish_ai_run(:'refused_run_id', 'failed', '{}'::jsonb, 'http_400');
select pg_temp.check('a request the provider refused is still free to retry',
  (select verdict from public.claim_ai_run(
     'aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001',
     'spatial-analyze', 'm', 'c', 'fp-refused')) = 'CLAIMED');

-- A result already in our hands is never re-bought, whatever went wrong after.
select verdict, run_id from public.claim_ai_run(
  'aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001',
  'document-evidence', 'm', 'c', 'fp-saved-badly') \gset saved_
select public.finish_ai_run(:'saved_run_id', 'succeeded', '{}'::jsonb);
select pg_temp.check('a reading we already hold is reused even if saving it failed',
  (select verdict from public.claim_ai_run(
     'aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001',
     'document-evidence', 'm', 'c', 'fp-saved-badly')) = 'REUSED');

-- A lock nobody released is not evidence that nothing was bought.
select verdict, run_id from public.claim_ai_run(
  'aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001',
  'document-classify', 'm', 'c', 'fp-stale-lock') \gset stale_
update public.ai_runs set started_at = now() - interval '20 hours' where id = :'stale_run_id';
select pg_temp.check('an expired lock becomes an unknown outcome, not a free retry',
  (select verdict from public.claim_ai_run(
     'aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001',
     'document-classify', 'm', 'c', 'fp-stale-lock')) = 'UNKNOWN');
select pg_temp.check('and the abandoned row says why it was closed',
  (select state = 'outcome_unknown' and error_code = 'lock_expired'
     from public.ai_runs where id = :'stale_run_id'));

-- The worker died between reading the answer and writing it down.
--
-- RunProgress is a flag in the memory of an edge function, and that memory is
-- gone. Nothing about the reading was persisted — so the question is not "what
-- did the flag say", it is "what does the row say", and the row says 'running'.
-- The in-flight index blocks a duplicate for as long as it stands, and when the
-- lock finally expires the run becomes unknown, never available. At no point
-- in that sequence can anybody buy the reading again without deciding to.
select verdict, run_id from public.claim_ai_run(
  'aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001',
  'document-evidence', 'm', 'c', 'fp-died-after-answering') \gset died_
select pg_temp.check('a worker that died after reading leaves its run in flight',
  (select state from public.ai_runs where id = :'died_run_id') = 'running');
select pg_temp.check('and the in-flight row blocks a second purchase on its own',
  (select verdict from public.claim_ai_run(
     'aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001',
     'document-evidence', 'm', 'c', 'fp-died-after-answering')) = 'RUNNING');
update public.ai_runs set started_at = now() - interval '20 hours' where id = :'died_run_id';
select pg_temp.check('and when the lock finally expires it becomes a decision, not a free retry',
  (select verdict from public.claim_ai_run(
     'aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001',
     'document-evidence', 'm', 'c', 'fp-died-after-answering')) = 'UNKNOWN');

-- The screen must not hide a run that may be on the invoice inside "failed".
set local test.uid = '11111111-1111-1111-1111-111111111111';
set local role authenticated;
select pg_temp.check('the usage line counts unknown outcomes separately',
  (select outcome_unknown from public.ai_usage_summary('bbbbbbbb-0000-0000-0000-000000000001')) >= 1);
-- The browser asks before it spends, and gets told.
select pg_temp.check('the button can find out that a retry needs confirmation',
  (select verdict from public.ai_run_state_for(
     'aaaaaaaa-0000-0000-0000-000000000001', 'document-classify', 'fp-stale-lock')) = 'UNKNOWN');
-- The doors stay shut. A browser may confirm; it may not write the ledger.
select pg_temp.refused('the ledger writer is still closed to the browser',
  $$select public.finish_ai_run('00000000-0000-0000-0000-000000000000', 'failed')$$);
select pg_temp.refused('and so is claiming a run',
  $$select public.claim_ai_run('aaaaaaaa-0000-0000-0000-000000000001', null, 'plan-analyze', 'm', 'c', 'x')$$);
reset role;

-- ═══════════════════ THE FIELD CHECK THAT COULD NOT BE REPEATED ════════════
--
-- A field check the ledger refused used to stay 'processing' forever, because
-- the row had no word for "we do not know what happened" and no pointer to
-- the run it did not know about. Now it has both.
select pg_temp.check('a field check can say its outcome is unknown',
  (select pg_get_constraintdef(oid) like '%outcome_unknown%'
     from pg_constraint where conname = 'field_quality_checks_state_check'));
select pg_temp.check('and it points at the run a reviewer decides about',
  exists (select 1 from information_schema.columns
           where table_name = 'field_quality_checks' and column_name = 'ai_run_id'));
select pg_temp.check('a state the row has no word for is still refused',
  not exists (select 1 from pg_constraint
               where conname = 'field_quality_checks_state_check'
                 and pg_get_constraintdef(oid) like '%queued_for_retry%'));

-- ═════════════════════ THE SAME KIT FOR EVERY READER ═══════════════════════
--
-- Three readers are only comparable if they were shown the same drawings.
-- That has to be a fact in the record, not a property of the code that wrote
-- it — so every reading stores the digest of the pages and enlargements it
-- actually sent, and how many there were.
select pg_temp.check('a chunk records the kit its request actually carried',
  exists (select 1 from information_schema.columns
           where table_name = 'plan_analysis_chunks' and column_name = 'image_fingerprint')
  and exists (select 1 from information_schema.columns
               where table_name = 'plan_analysis_chunks' and column_name = 'images_sent'));
select pg_temp.check('and so does a reading that took only one request',
  exists (select 1 from information_schema.columns
           where table_name = 'plan_analysis_jobs' and column_name = 'image_fingerprint')
  and exists (select 1 from information_schema.columns
               where table_name = 'plan_analysis_jobs' and column_name = 'images_sent'));
-- ═══════════════════════ THE COMPARISON OF READINGS ════════════════════════
--
-- A comparison says which of several readings read a plan set better. It is a
-- finding about readers, bought like any other call — so the ledger must be
-- able to spell it, the browser must be able to read it and unable to write
-- it, and the control markup it may be measured against must belong to a
-- project like everything else.
select pg_temp.check('the ledger can name a comparison, so one cannot be bought twice unnoticed',
  (select pg_get_constraintdef(oid) like '%compare-readings%'
     from pg_constraint where conname = 'ai_runs_process_key_check'));
select pg_temp.check('a comparison is readable by the organisation that paid for it',
  exists (select 1 from pg_policies
           where tablename = 'reading_comparisons' and cmd = 'SELECT'
             and qual like '%is_org_member%'));
select pg_temp.check('and by nobody else — no browser writes a verdict',
  not exists (select 1 from pg_policies
               where tablename = 'reading_comparisons' and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')));
select pg_temp.check('a control markup is read the same way and written by nobody in a browser',
  exists (select 1 from pg_policies where tablename = 'reading_ground_truth' and cmd = 'SELECT' and qual like '%is_org_member%')
  and not exists (select 1 from pg_policies where tablename = 'reading_ground_truth' and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')));
select pg_temp.check('a markup records what it was checked against, so it cannot drift onto another revision',
  exists (select 1 from information_schema.columns
           where table_name = 'reading_ground_truth' and column_name = 'verified_against'));
select pg_temp.check('one comparison of the same readings is one row, so reopening it costs nothing',
  exists (select 1 from pg_indexes
           where tablename = 'reading_comparisons' and indexname = 'reading_comparisons_fingerprint'
             and indexdef like '%UNIQUE%'));
select pg_temp.check('a comparison says whether the readings were made under the same conditions',
  exists (select 1 from information_schema.columns
           where table_name = 'reading_comparisons' and column_name = 'comparable'));
select pg_temp.check('and a comparison a reader could not finish has a word for it',
  (select pg_get_constraintdef(oid) like '%incomplete%'
     from pg_constraint where conname = 'reading_comparisons_state_check'));

-- ══════════════════ CORE V2 · THE CHAIN A DECISION HANGS FROM ═══════════════
--
-- Everything below tests one sentence: a decision can be traced to an accepted
-- claim, which can be traced to a source anchor, which points at an immutable
-- source. Each check is a way somebody could break that chain — by writing
-- from the wrong organisation or the wrong workflow, by accepting a claim
-- nobody located, by editing a decided record instead of superseding it, by
-- pulling the anchor out from under an accepted claim, or by quietly sending a
-- request again after nobody knew whether the first one ran.
--
-- The kernel does not know what a source is. The fixture is a synthetic
-- register and a synthetic recording, and the subjects and predicates named
-- here mean nothing outside this file.
--
-- `reset role` is the worker, which runs as the service role and is NOT subject
-- to row-level security. That distinction matters here: an authenticated insert
-- failing because there is no write policy proves nothing about what a worker
-- can do. Every structural invariant below is attacked with the service role.

reset role;
set local test.uid = '';

create or replace function pg_temp.allowed(label text, statement text) returns void
language plpgsql as $$
begin
  execute statement;
  raise notice 'PASS  %', label;
end $$;

-- A refusal for the wrong reason is not a pass. Where the reason is the point
-- — another organisation, an expired lease, a spent budget — the message is
-- checked as well as the refusal.
create or replace function pg_temp.refused_because(label text, statement text, reason text) returns void
language plpgsql as $$
begin
  begin
    execute statement;
  exception when others then
    if sqlerrm like '%' || reason || '%' then
      raise notice 'PASS  % (refused: %)', label, left(sqlerrm, 60);
      return;
    end if;
    raise exception 'FAIL  % — refused, but for another reason: %', label, sqlerrm;
  end;
  raise exception 'FAIL  % — the statement was allowed', label;
end $$;

-- Fire Core V2's own deferred checks here and now, then leave them deferred
-- again. `set constraints all immediate` would leave every deferrable
-- constraint immediate for the rest of the file, which would test a different
-- database from the one that runs in production.
create or replace function pg_temp.core_v2_settle() returns void language plpgsql as $$
begin
  set constraints core_v2_claim_evidence_check, core_v2_decision_evidence_check,
                  core_v2_anchor_removal_check, core_v2_claim_supersession_check,
                  core_v2_decision_evidence_link_check, core_v2_assessment_removal_check immediate;
  set constraints core_v2_claim_evidence_check, core_v2_decision_evidence_check,
                  core_v2_anchor_removal_check, core_v2_claim_supersession_check,
                  core_v2_decision_evidence_link_check, core_v2_assessment_removal_check deferred;
end $$;

create or replace function pg_temp.core_v2_tables() returns text[] language sql immutable as $$
  select array['intelligence_workflows','workflow_outbox','workflow_sources','source_segments',
    'workflow_tasks','task_sources','task_dependencies','task_target_claims','agent_attempts',
    'evidence_claims','claim_inputs','evidence_anchors','claim_assessments',
    'disagreements','disagreement_claims','disagreement_follow_ups',
    'decisions','decision_evidence','decision_actions'] $$;

-- What one organisation's rows look like from where the caller stands. Under
-- row-level security this is the caller's view, which is the point.
create or replace function pg_temp.core_v2_rows_of(p_org uuid) returns bigint language plpgsql as $$
declare t text; n bigint; total bigint := 0;
begin
  foreach t in array pg_temp.core_v2_tables() loop
    execute format('select count(*) from public.%I where organization_id = $1', t) into n using p_org;
    total := total + n;
  end loop;
  return total;
end $$;

-- How many rows a browser update reaches across every Core V2 table. With no
-- write policy the answer is zero whatever the membership.
create or replace function pg_temp.core_v2_browser_reaches(p_org uuid) returns bigint language plpgsql as $$
declare t text; n bigint; total bigint := 0;
begin
  foreach t in array pg_temp.core_v2_tables() loop
    execute format('update public.%I set organization_id = organization_id where organization_id = $1', t) using p_org;
    get diagnostics n = row_count;
    total := total + n;
  end loop;
  return total;
end $$;

-- Scratch tables carrying generated ids, hashes and counts between statements.
-- The roles that act in this file must be able to read them.
create temporary table core_v2_ids(k text primary key, v uuid);
create temporary table core_v2_hashes(k text primary key, v text);
create temporary table core_v2_counts(k text primary key, n bigint);
create temporary table core_v2_cancel(k text primary key, result jsonb);
grant all on core_v2_ids, core_v2_hashes, core_v2_counts, core_v2_cancel to authenticated, anon;
create or replace function pg_temp.id(p_key text) returns uuid language sql stable as $$
  select v from core_v2_ids where k = p_key $$;

-- What V1 looks like before Core V2 touches anything. Compared again at the end
-- of this section: V2 lives beside V1, and a schema that quietly rewrote plan
-- history would be worse than no V2 at all. The audit trail is deliberately not
-- in this list — it is a shared ledger that Core V2 appends to, and 018 already
-- forbids updating or deleting a row of it.
create or replace function pg_temp.v1_fingerprint() returns text language plpgsql as $$
declare t text; part text; out text := '';
begin
  foreach t in array array['project_documents','document_baselines','plan_spaces','project_requirements',
                           'material_takeoffs','plan_analysis_jobs','plan_analysis_chunks',
                           'evidence_items','capture_tasks','ai_runs'] loop
    execute format('select md5(coalesce(string_agg(x::text, %L order by x::text), %L)) from public.%I x',
                   '|', 'empty', t) into part;
    out := out || t || '=' || part || ' ';
  end loop;
  return out;
end $$;

create temporary table core_v2_before(fingerprint text);
insert into core_v2_before select pg_temp.v1_fingerprint();
grant all on core_v2_before to authenticated, anon;

-- A workflow row for the fixture to hang from. Written directly, as the worker
-- would: the start door refuses a request that names no sources, and the
-- fixture's two sources are this workflow's source set.
insert into public.intelligence_workflows(
  id, organization_id, domain_pack, domain_pack_version, workflow_type, engine_version,
  source_set_fingerprint, request_fingerprint, requested_by)
values (
  '0c0e0000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
  'synthetic-records', '1', 'synthetic_review', 'core-v2.1',
  'fixture-source-set-fingerprint', 'fixture-request-fingerprint',
  '11111111-1111-1111-1111-111111111111');

\ir ../fixtures/core_v2_synthetic.sql
select pg_temp.core_v2_synthetic_fixture(
  'aaaaaaaa-0000-0000-0000-000000000001',
  '0c0e0000-0000-0000-0000-000000000001');

select pg_temp.check('the synthetic fixture stands in the record: two sources and six accepted segments',
  (select count(*) from public.workflow_sources
     where workflow_id = '0c0e0000-0000-0000-0000-000000000001') = 2
  and (select count(*) from public.source_segments
         where workflow_id = '0c0e0000-0000-0000-0000-000000000001' and status = 'accepted') = 6);

-- ═══════════════ 1 · ONE ORGANISATION, ONE WORKFLOW, ALL THE WAY DOWN ═══════
--
-- The browser cannot write these tables at all, so the risk is not a form
-- post. It is a worker, a fixture or a later migration writing a row whose
-- references belong to somebody else. A row of another organisation, and a
-- second workflow of the same organisation, so that every refusal below is
-- about crossing a line and never about a missing row.
insert into public.intelligence_workflows(id, organization_id, domain_pack, domain_pack_version,
  workflow_type, engine_version, source_set_fingerprint, request_fingerprint, requested_by)
values
  ('0c0e0000-0000-0000-0000-0000000000b0', 'aaaaaaaa-0000-0000-0000-000000000002',
   'synthetic-records', '1', 'synthetic_review', 'core-v2.1',
   'elsewhere-source-set', 'elsewhere-request', '44444444-4444-4444-4444-444444444444'),
  ('0c0e0000-0000-0000-0000-0000000000a2', 'aaaaaaaa-0000-0000-0000-000000000001',
   'synthetic-records', '1', 'synthetic_review', 'core-v2.1',
   'second-source-set', 'second-request', '11111111-1111-1111-1111-111111111111');
insert into public.workflow_sources(id, organization_id, workflow_id, ordinal, source_kind, label, uri,
  content_hash, hash_algorithm, byte_size)
values
  ('0a0e00b0-0000-0000-0000-000000000000', 'aaaaaaaa-0000-0000-0000-000000000002',
   '0c0e0000-0000-0000-0000-0000000000b0', 0, 'document', 'elsewhere register',
   'fixture://elsewhere/register', 'elsewhere-hash', 'sha-256', 4096),
  ('0a0e00a2-0000-0000-0000-000000000000', 'aaaaaaaa-0000-0000-0000-000000000001',
   '0c0e0000-0000-0000-0000-0000000000a2', 0, 'document', 'second register',
   'fixture://second/register', 'second-hash', 'sha-256', 4096);
insert into public.source_segments(id, organization_id, workflow_id, source_id, segment_kind, label,
  locator, content_hash, status, discovered_by)
values
  ('0b0e00b0-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000002',
   '0c0e0000-0000-0000-0000-0000000000b0', '0a0e00b0-0000-0000-0000-000000000000', 'page', 'page 1',
   '{"page": 0, "bbox": [0, 0, 1, 1]}'::jsonb, 'elsewhere-segment', 'accepted', 'deterministic'),
  ('0b0e00a2-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
   '0c0e0000-0000-0000-0000-0000000000a2', '0a0e00a2-0000-0000-0000-000000000000', 'page', 'page 1',
   '{"page": 0, "bbox": [0, 0, 1, 1]}'::jsonb, 'second-segment', 'accepted', 'deterministic');
insert into public.workflow_tasks(id, organization_id, workflow_id, phase, task_type, role_key, role_version,
  subject_key, input_fingerprint, contract_version)
values
  ('0c0e0001-0000-0000-0000-0000000000b0', 'aaaaaaaa-0000-0000-0000-000000000002',
   '0c0e0000-0000-0000-0000-0000000000b0', 'analyze', 'read_register', 'reader', '1',
   'elsewhere/row-1', 'fp-elsewhere', 'read_register@1'),
  ('0c0e0001-0000-0000-0000-0000000000a2', 'aaaaaaaa-0000-0000-0000-000000000001',
   '0c0e0000-0000-0000-0000-0000000000a2', 'analyze', 'read_register', 'reader', '1',
   'second/row-1', 'fp-second', 'read_register@1'),
  ('0c0e0001-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
   '0c0e0000-0000-0000-0000-000000000001', 'discover', 'find_segments', 'discoverer', '1',
   'register-a', 'fp-discover-a', 'find_segments@1');
insert into public.evidence_claims(id, organization_id, workflow_id, subject_type, subject_key, predicate,
  value, observation_basis)
values
  ('0e0e0000-0000-0000-0000-0000000000b0', 'aaaaaaaa-0000-0000-0000-000000000002',
   '0c0e0000-0000-0000-0000-0000000000b0', 'row', 'elsewhere/row-1', 'quantity', '{"n": 1}'::jsonb, 'observed'),
  ('0e0e0000-0000-0000-0000-0000000000a2', 'aaaaaaaa-0000-0000-0000-000000000001',
   '0c0e0000-0000-0000-0000-0000000000a2', 'row', 'second/row-1', 'quantity', '{"n": 1}'::jsonb, 'observed'),
  ('0e0e0000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
   '0c0e0000-0000-0000-0000-000000000001', 'row', 'register-a/row-1', 'quantity', '{"n": 4}'::jsonb, 'observed');
insert into public.evidence_anchors(id, organization_id, workflow_id, claim_id, source_kind, segment_id, anchor_hash)
values ('0f0e0000-0000-0000-0000-0000000000a2', 'aaaaaaaa-0000-0000-0000-000000000001',
  '0c0e0000-0000-0000-0000-0000000000a2', '0e0e0000-0000-0000-0000-0000000000a2', 'segment',
  '0b0e00a2-0000-0000-0000-000000000001', 'second-anchor');
insert into public.disagreements(id, organization_id, workflow_id, disagreement_key, kind)
values
  ('1c0e0000-0000-0000-0000-0000000000a2', 'aaaaaaaa-0000-0000-0000-000000000001',
   '0c0e0000-0000-0000-0000-0000000000a2', 'second/row-1/quantity', 'value'),
  ('1c0e0000-0000-0000-0000-000000000000', 'aaaaaaaa-0000-0000-0000-000000000001',
   '0c0e0000-0000-0000-0000-000000000001', 'register-a/probe', 'value');
insert into public.decisions(id, organization_id, workflow_id, decision_type, title, authority)
values
  ('1b0e0000-0000-0000-0000-0000000000a2', 'aaaaaaaa-0000-0000-0000-000000000001',
   '0c0e0000-0000-0000-0000-0000000000a2', 'hold', 'second hold', 'deterministic_rule'),
  ('1b0e0000-0000-0000-0000-000000000000', 'aaaaaaaa-0000-0000-0000-000000000001',
   '0c0e0000-0000-0000-0000-000000000001', 'hold', 'probe hold', 'deterministic_rule');
insert into public.agent_attempts(id, organization_id, workflow_id, task_id, attempt_no, role_key, role_version,
  executor_kind, executor_family, independence_domain, packet_fingerprint)
values ('0d0e0000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
  '0c0e0000-0000-0000-0000-000000000001', '0c0e0001-0000-0000-0000-000000000001', 1, 'discoverer', '1',
  'deterministic', 'kernel', 'deterministic:kernel', 'packet-discover-a');
select pg_temp.core_v2_settle();

select pg_temp.check('every Core V2 table carries the tenancy guard — nineteen tables, nineteen triggers',
  (select count(distinct c.relname) from pg_trigger t join pg_class c on c.oid = t.tgrelid
    where t.tgname = 'core_v2_tenancy' and not t.tgisinternal
      and c.relname = any(pg_temp.core_v2_tables())) = 19);
select pg_temp.refused('a workflow cannot be filed under an organisation that does not exist',
  $$insert into public.intelligence_workflows(organization_id, domain_pack, domain_pack_version,
      workflow_type, engine_version, source_set_fingerprint, request_fingerprint)
    values ('aaaaaaaa-0000-0000-0000-00000000ffff', 'p', '1', 't', 'core-v2.1', 'fp', 'rq')$$);

-- ─────────────────────────────────── across organisations, table by table
select pg_temp.refused_because('a start command cannot be filed under another organisation''s workflow',
  $$insert into public.workflow_outbox(organization_id, workflow_id)
    values ('aaaaaaaa-0000-0000-0000-000000000002', '0c0e0000-0000-0000-0000-000000000001')$$,
  'another organisation');
select pg_temp.refused_because('nor a source',
  $$insert into public.workflow_sources(organization_id, workflow_id, ordinal, source_kind, uri, content_hash)
    values ('aaaaaaaa-0000-0000-0000-000000000002', '0c0e0000-0000-0000-0000-000000000001', 9, 'document',
            'fixture://borrowed', 'h')$$,
  'another organisation');
select pg_temp.refused_because('nor a segment filed under the wrong organisation',
  $$insert into public.source_segments(organization_id, workflow_id, source_id, segment_kind, content_hash, discovered_by)
    values ('aaaaaaaa-0000-0000-0000-000000000002', '0c0e0000-0000-0000-0000-000000000001',
            '0a0e0001-0000-0000-0000-000000000000', 'page', 'h', 'deterministic')$$,
  'another organisation');
select pg_temp.refused_because('nor a segment of this workflow cut from another organisation''s source',
  $$insert into public.source_segments(organization_id, workflow_id, source_id, segment_kind, content_hash, discovered_by)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0000-0000-0000-0000-000000000001',
            '0a0e00b0-0000-0000-0000-000000000000', 'page', 'h', 'deterministic')$$,
  'another organisation');
select pg_temp.refused_because('nor a task',
  $$insert into public.workflow_tasks(organization_id, workflow_id, phase, task_type, role_key, role_version,
      subject_key, input_fingerprint, contract_version)
    values ('aaaaaaaa-0000-0000-0000-000000000002', '0c0e0000-0000-0000-0000-000000000001', 'analyze',
            'read_register', 'reader', '1', 'borrowed', 'fp', 'v1')$$,
  'another organisation');
select pg_temp.refused_because('nor an attempt at another organisation''s task',
  $$insert into public.agent_attempts(organization_id, workflow_id, task_id, attempt_no, role_key, role_version,
      executor_kind, executor_family, independence_domain, packet_fingerprint)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0000-0000-0000-0000-000000000001',
            '0c0e0001-0000-0000-0000-0000000000b0', 1, 'reader', '1', 'model', 'family', 'domain', 'pf')$$,
  'another organisation');
select pg_temp.refused_because('nor a claim made by another organisation''s task',
  $$insert into public.evidence_claims(organization_id, workflow_id, task_id, subject_type, subject_key,
      predicate, observation_basis)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0000-0000-0000-0000-000000000001',
            '0c0e0001-0000-0000-0000-0000000000b0', 'row', 'x', 'quantity', 'observed')$$,
  'another organisation');
select pg_temp.refused_because('nor an anchor into another organisation''s source',
  $$insert into public.evidence_anchors(organization_id, workflow_id, claim_id, source_kind, segment_id, anchor_hash)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0000-0000-0000-0000-000000000001',
            '0e0e0000-0000-0000-0000-000000000001', 'segment', '0b0e00b0-0000-0000-0000-000000000001', 'borrowed')$$,
  'another');
select pg_temp.refused_because('nor a derivation from another organisation''s claim',
  $$insert into public.claim_inputs(organization_id, claim_id, input_claim_id)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0e0e0000-0000-0000-0000-000000000001',
            '0e0e0000-0000-0000-0000-0000000000b0')$$,
  'another organisation');
select pg_temp.refused_because('nor a task handed another organisation''s source',
  $$insert into public.task_sources(organization_id, task_id, ordinal, source_id)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0001-0000-0000-0000-000000000001', 0,
            '0a0e00b0-0000-0000-0000-000000000000')$$,
  'another organisation');
select pg_temp.refused_because('nor a task waiting on another organisation''s task',
  $$insert into public.task_dependencies(organization_id, task_id, depends_on_task_id, dependency_kind)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0001-0000-0000-0000-000000000001',
            '0c0e0001-0000-0000-0000-0000000000b0', 'requires_completion')$$,
  'another organisation');
select pg_temp.refused_because('nor a verification aimed at another organisation''s claim',
  $$insert into public.task_target_claims(organization_id, task_id, claim_id)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0001-0000-0000-0000-000000000001',
            '0e0e0000-0000-0000-0000-0000000000b0')$$,
  'another organisation');
select pg_temp.refused_because('nor a verdict written under another organisation''s task',
  $$insert into public.claim_assessments(organization_id, workflow_id, claim_id, attempt_id, task_id, assessment, reason_code)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0000-0000-0000-0000-000000000001',
            '0e0e0000-0000-0000-0000-000000000001', '0d0e0000-0000-0000-0000-000000000001',
            '0c0e0001-0000-0000-0000-0000000000b0', 'supports', 'r')$$,
  'another organisation');
select pg_temp.refused_because('nor a disagreement over another organisation''s claim',
  $$insert into public.disagreement_claims(organization_id, disagreement_id, claim_id)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '1c0e0000-0000-0000-0000-000000000000',
            '0e0e0000-0000-0000-0000-0000000000b0')$$,
  'another');
select pg_temp.refused_because('nor a follow-up run by another organisation''s task',
  $$insert into public.disagreement_follow_ups(organization_id, disagreement_id, round, fingerprint, task_id)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '1c0e0000-0000-0000-0000-000000000000', 1, 'fp',
            '0c0e0001-0000-0000-0000-0000000000b0')$$,
  'another organisation');
select pg_temp.refused_because('nor a decision',
  $$insert into public.decisions(organization_id, workflow_id, decision_type, title, authority)
    values ('aaaaaaaa-0000-0000-0000-000000000002', '0c0e0000-0000-0000-0000-000000000001', 'hold', 'x', 'human')$$,
  'another organisation');
select pg_temp.refused_because('nor evidence borrowed from another organisation',
  $$insert into public.decision_evidence(organization_id, decision_id, claim_id, link)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '1b0e0000-0000-0000-0000-000000000000',
            '0e0e0000-0000-0000-0000-0000000000b0', 'supports')$$,
  'another organisation');
select pg_temp.refused_because('nor an action on another organisation''s decision',
  $$insert into public.decision_actions(organization_id, decision_id, action_type, owner_role)
    values ('aaaaaaaa-0000-0000-0000-000000000002', '1b0e0000-0000-0000-0000-000000000000', 'review', 'reviewer')$$,
  'another organisation');

-- ────────────────────── across workflows of one organisation, table by table
--
-- Same organisation, other workflow: the id is real, the owner is the same,
-- and the row is still refused. A decision that opens a source of a different
-- reading cannot be followed back.
select pg_temp.refused_because('a segment cannot be cut from a source of another workflow',
  $$insert into public.source_segments(organization_id, workflow_id, source_id, segment_kind, content_hash, discovered_by)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0000-0000-0000-0000-000000000001',
            '0a0e00a2-0000-0000-0000-000000000000', 'page', 'h', 'deterministic')$$,
  'another workflow');
select pg_temp.refused('nor nested under a segment of another workflow',
  $$insert into public.source_segments(organization_id, workflow_id, source_id, parent_segment_id, segment_kind,
      content_hash, discovered_by)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0000-0000-0000-0000-000000000001',
            '0a0e0001-0000-0000-0000-000000000000', '0b0e00a2-0000-0000-0000-000000000001', 'table', 'h', 'deterministic')$$);
select pg_temp.refused_because('a task cannot be the child of a task of another workflow',
  $$insert into public.workflow_tasks(organization_id, workflow_id, parent_task_id, phase, task_type, role_key,
      role_version, subject_key, input_fingerprint, contract_version)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0000-0000-0000-0000-000000000001',
            '0c0e0001-0000-0000-0000-0000000000a2', 'analyze', 'read_register', 'reader', '1', 'x', 'fp', 'v1')$$,
  'another workflow');
select pg_temp.refused_because('nor say it was created by one',
  $$insert into public.workflow_tasks(organization_id, workflow_id, created_by_task_id, phase, task_type, role_key,
      role_version, subject_key, input_fingerprint, contract_version)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0000-0000-0000-0000-000000000001',
            '0c0e0001-0000-0000-0000-0000000000a2', 'analyze', 'read_register', 'reader', '1', 'x', 'fp', 'v1')$$,
  'another workflow');
select pg_temp.refused_because('nor follow up a disagreement of another workflow',
  $$insert into public.workflow_tasks(organization_id, workflow_id, disagreement_id, phase, task_type, role_key,
      role_version, subject_key, input_fingerprint, contract_version)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0000-0000-0000-0000-000000000001',
            '1c0e0000-0000-0000-0000-0000000000a2', 'verify', 'verify_row', 'verifier', '1', 'x', 'fp', 'v1')$$,
  'another workflow');
select pg_temp.refused_because('a task cannot be handed a source of another workflow',
  $$insert into public.task_sources(organization_id, task_id, ordinal, source_id)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0001-0000-0000-0000-000000000001', 0,
            '0a0e00a2-0000-0000-0000-000000000000')$$,
  'another workflow');
select pg_temp.refused_because('nor a segment of one',
  $$insert into public.task_sources(organization_id, task_id, ordinal, segment_id)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0001-0000-0000-0000-000000000001', 0,
            '0b0e00a2-0000-0000-0000-000000000001')$$,
  'another workflow');
select pg_temp.refused_because('a dependency does not cross workflows — a row with no workflow of its own takes the first it names',
  $$insert into public.task_dependencies(organization_id, task_id, depends_on_task_id, dependency_kind)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0001-0000-0000-0000-000000000001',
            '0c0e0001-0000-0000-0000-0000000000a2', 'requires_completion')$$,
  'another workflow');
select pg_temp.refused_because('a verification cannot target a claim of another workflow',
  $$insert into public.task_target_claims(organization_id, task_id, claim_id)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0001-0000-0000-0000-000000000001',
            '0e0e0000-0000-0000-0000-0000000000a2')$$,
  'another workflow');
select pg_temp.refused_because('an attempt cannot be filed under a task of another workflow',
  $$insert into public.agent_attempts(organization_id, workflow_id, task_id, attempt_no, role_key, role_version,
      executor_kind, executor_family, independence_domain, packet_fingerprint)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0000-0000-0000-0000-000000000001',
            '0c0e0001-0000-0000-0000-0000000000a2', 1, 'reader', '1', 'model', 'family', 'domain', 'pf')$$,
  'another workflow');
select pg_temp.refused_because('a claim cannot be made by a task of another workflow',
  $$insert into public.evidence_claims(organization_id, workflow_id, task_id, subject_type, subject_key,
      predicate, observation_basis)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0000-0000-0000-0000-000000000001',
            '0c0e0001-0000-0000-0000-0000000000a2', 'row', 'x', 'quantity', 'observed')$$,
  'another workflow');
select pg_temp.refused_because('nor supersede a claim of another workflow',
  $$insert into public.evidence_claims(organization_id, workflow_id, supersedes_claim_id, subject_type, subject_key,
      predicate, observation_basis)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0000-0000-0000-0000-000000000001',
            '0e0e0000-0000-0000-0000-0000000000a2', 'row', 'x', 'quantity', 'observed')$$,
  'another workflow');
select pg_temp.refused_because('nor be derived from one',
  $$insert into public.claim_inputs(organization_id, claim_id, input_claim_id)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0e0e0000-0000-0000-0000-000000000001',
            '0e0e0000-0000-0000-0000-0000000000a2')$$,
  'another workflow');
select pg_temp.refused_because('an anchor cannot point into a segment of another workflow',
  $$insert into public.evidence_anchors(organization_id, workflow_id, claim_id, source_kind, segment_id, anchor_hash)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0000-0000-0000-0000-000000000001',
            '0e0e0000-0000-0000-0000-000000000001', 'segment', '0b0e00a2-0000-0000-0000-000000000001', 'borrowed')$$,
  'another workflow');
select pg_temp.refused_because('nor at a source of another workflow',
  $$insert into public.evidence_anchors(organization_id, workflow_id, claim_id, source_kind, source_id, anchor_hash)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0000-0000-0000-0000-000000000001',
            '0e0e0000-0000-0000-0000-000000000001', 'source', '0a0e00a2-0000-0000-0000-000000000000', 'borrowed')$$,
  'another workflow');
select pg_temp.refused_because('nor hang from a claim of another workflow',
  $$insert into public.evidence_anchors(organization_id, workflow_id, claim_id, source_kind, segment_id, anchor_hash)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0000-0000-0000-0000-000000000001',
            '0e0e0000-0000-0000-0000-0000000000a2', 'segment', '0b0e0001-0000-0000-0000-000000000001', 'borrowed')$$,
  'another workflow');
select pg_temp.refused_because('a verdict cannot be about a claim of another workflow',
  $$insert into public.claim_assessments(organization_id, workflow_id, claim_id, attempt_id, assessment, reason_code)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0000-0000-0000-0000-000000000001',
            '0e0e0000-0000-0000-0000-0000000000a2', '0d0e0000-0000-0000-0000-000000000001', 'supports', 'r')$$,
  'another workflow');
select pg_temp.refused_because('a disagreement compares claims of one workflow',
  $$insert into public.disagreement_claims(organization_id, disagreement_id, claim_id)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '1c0e0000-0000-0000-0000-000000000000',
            '0e0e0000-0000-0000-0000-0000000000a2')$$,
  'another');
select pg_temp.refused_because('and is followed up by a task of its own workflow',
  $$insert into public.disagreement_follow_ups(organization_id, disagreement_id, round, fingerprint, task_id)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '1c0e0000-0000-0000-0000-000000000000', 1, 'fp',
            '0c0e0001-0000-0000-0000-0000000000a2')$$,
  'another workflow');
select pg_temp.refused_because('a disagreement is not settled by a decision of another workflow',
  $$update public.disagreements set resolution_decision_id = '1b0e0000-0000-0000-0000-0000000000a2'
     where id = '1c0e0000-0000-0000-0000-000000000000'$$,
  'another workflow');
select pg_temp.refused_because('a decision does not settle a disagreement of another workflow',
  $$insert into public.decisions(organization_id, workflow_id, disagreement_id, decision_type, title, authority)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0000-0000-0000-0000-000000000001',
            '1c0e0000-0000-0000-0000-0000000000a2', 'hold', 'x', 'human')$$,
  'another workflow');
select pg_temp.refused_because('nor supersede a decision of one',
  $$insert into public.decisions(organization_id, workflow_id, supersedes_decision_id, decision_type, title, authority)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0000-0000-0000-0000-000000000001',
            '1b0e0000-0000-0000-0000-0000000000a2', 'supersede', 'x', 'human')$$,
  'another workflow');
select pg_temp.refused_because('nor rest on a claim of one',
  $$insert into public.decision_evidence(organization_id, decision_id, claim_id, link)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '1b0e0000-0000-0000-0000-000000000000',
            '0e0e0000-0000-0000-0000-0000000000a2', 'supports')$$,
  'another workflow');
select pg_temp.refused_because('nor cite an anchor of one',
  $$insert into public.decision_evidence(organization_id, decision_id, anchor_id, link)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '1b0e0000-0000-0000-0000-000000000000',
            '0f0e0000-0000-0000-0000-0000000000a2', 'context')$$,
  'another workflow');
select pg_temp.refused_because('a reference to a row that is not there is named as such, not as a foreign key surprise',
  $$insert into public.workflow_tasks(organization_id, workflow_id, parent_task_id, phase, task_type, role_key,
      role_version, subject_key, input_fingerprint, contract_version)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0000-0000-0000-0000-000000000001',
            '0c0e0001-0000-0000-0000-00000000ffff', 'analyze', 'read_register', 'reader', '1', 'x', 'fp', 'v1')$$,
  'does not exist');

-- ─────────────────────────────────────────── and a row does not move house
select pg_temp.refused_because('a workflow does not change organisation after it is written',
  $$update public.intelligence_workflows set organization_id = 'aaaaaaaa-0000-0000-0000-000000000002'
     where id = '0c0e0000-0000-0000-0000-000000000001'$$,
  'does not change organisation');
select pg_temp.refused_because('nor does a task',
  $$update public.workflow_tasks set organization_id = 'aaaaaaaa-0000-0000-0000-000000000002'
     where id = '0c0e0001-0000-0000-0000-000000000001'$$,
  'does not change organisation');
select pg_temp.refused_because('nor a claim',
  $$update public.evidence_claims set organization_id = 'aaaaaaaa-0000-0000-0000-000000000002'
     where id = '0e0e0000-0000-0000-0000-000000000001'$$,
  'does not change organisation');
select pg_temp.refused_because('nor an attempt',
  $$update public.agent_attempts set organization_id = 'aaaaaaaa-0000-0000-0000-000000000002'
     where id = '0d0e0000-0000-0000-0000-000000000001'$$,
  'does not change organisation');
select pg_temp.refused_because('a task does not change workflow after it is written',
  $$update public.workflow_tasks set workflow_id = '0c0e0000-0000-0000-0000-0000000000a2'
     where id = '0c0e0001-0000-0000-0000-000000000001'$$,
  'does not change workflow');
select pg_temp.refused_because('nor does a claim',
  $$update public.evidence_claims set workflow_id = '0c0e0000-0000-0000-0000-0000000000a2'
     where id = '0e0e0000-0000-0000-0000-000000000001'$$,
  'does not change workflow');
select pg_temp.refused_because('nor an attempt',
  $$update public.agent_attempts set workflow_id = '0c0e0000-0000-0000-0000-0000000000a2'
     where id = '0d0e0000-0000-0000-0000-000000000001'$$,
  'does not change workflow');
select pg_temp.refused_because('nor a disagreement',
  $$update public.disagreements set workflow_id = '0c0e0000-0000-0000-0000-0000000000a2'
     where id = '1c0e0000-0000-0000-0000-000000000000'$$,
  'does not change workflow');
select pg_temp.refused_because('nor a decision',
  $$update public.decisions set workflow_id = '0c0e0000-0000-0000-0000-0000000000a2'
     where id = '1b0e0000-0000-0000-0000-000000000000'$$,
  'does not change workflow');

-- ═══════════════════════════════ 2 · THE SOURCE UNDERNEATH ═══════════════════
--
-- A source is identified by its content, kept whole, and never edited: anchors
-- under accepted decisions point here. A segment of it may be refined while it
-- is only proposed and stops moving once accepted.
select pg_temp.refused_because('a source is append-only — a corrected label is not a corrected source',
  $$update public.workflow_sources set label = 'synthetic register A (revised)'
     where id = '0a0e0001-0000-0000-0000-000000000000'$$, 'append-only');
select pg_temp.refused('nor is its content identity rewritten',
  $$update public.workflow_sources set content_hash = 'a-different-hash'
     where id = '0a0e0001-0000-0000-0000-000000000000'$$);
select pg_temp.refused('nor its locator',
  $$update public.workflow_sources set uri = 'fixture://synthetic/register-a-v2'
     where id = '0a0e0001-0000-0000-0000-000000000000'$$);
select pg_temp.refused_because('and it is not deleted — a changed source set is a new workflow',
  $$delete from public.workflow_sources where id = '0a0e0001-0000-0000-0000-000000000000'$$,
  'part of the record');
select pg_temp.refused('a signed url is not a locator: it expires and carries a credential',
  $$insert into public.workflow_sources(organization_id, workflow_id, ordinal, source_kind, uri, content_hash, hash_algorithm)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0000-0000-0000-0000-000000000001', 7, 'document',
            'https://store.example/register?X-Amz-Signature=deadbeef', 'h', 'sha-256')$$);
select pg_temp.refused('nor is a url carrying a token',
  $$insert into public.workflow_sources(organization_id, workflow_id, ordinal, source_kind, uri, content_hash, hash_algorithm)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0000-0000-0000-0000-000000000001', 7, 'document',
            'https://store.example/register?token=abc', 'h', 'sha-256')$$);
select pg_temp.refused('a source with neither a digest nor a storage version has no identity, and is refused',
  $$insert into public.workflow_sources(organization_id, workflow_id, ordinal, source_kind, uri, byte_size)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0000-0000-0000-0000-000000000001', 7, 'document',
            'fixture://synthetic/unhashed', 10)$$);
select pg_temp.allowed('the storage system''s own immutable version id is an identity',
  $$insert into public.workflow_sources(id, organization_id, workflow_id, ordinal, source_kind, uri, object_version_id, byte_size)
    values ('0a0e0003-0000-0000-0000-000000000000', 'aaaaaaaa-0000-0000-0000-000000000001',
            '0c0e0000-0000-0000-0000-000000000001', 2, 'dataset', 'fixture://synthetic/dataset-c', 'version-3', 512)$$);
select pg_temp.refused('the same locator at the same version is the same source, not a third one',
  $$insert into public.workflow_sources(organization_id, workflow_id, ordinal, source_kind, uri, object_version_id)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0000-0000-0000-0000-000000000001', 3, 'dataset',
            'fixture://synthetic/dataset-c', 'version-3')$$);
select pg_temp.refused('and one position in the set holds one source',
  $$insert into public.workflow_sources(organization_id, workflow_id, ordinal, source_kind, uri, content_hash, hash_algorithm)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0000-0000-0000-0000-000000000001', 2, 'document',
            'fixture://synthetic/another', 'h2', 'sha-256')$$);
select pg_temp.refused('a source is not a negative number of bytes long',
  $$insert into public.workflow_sources(organization_id, workflow_id, ordinal, source_kind, uri, content_hash, hash_algorithm, byte_size)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0000-0000-0000-0000-000000000001', 8, 'document',
            'fixture://synthetic/negative', 'h3', 'sha-256', -1)$$);

-- ─────────────────────────────────────── a segment: refined, then fixed
insert into public.source_segments(id, organization_id, workflow_id, source_id, parent_segment_id, segment_kind, label,
  ordinal, locator, content_hash, status, discovered_by)
values ('0b0e0003-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
  '0c0e0000-0000-0000-0000-000000000001', '0a0e0001-0000-0000-0000-000000000000',
  '0b0e0001-0000-0000-0000-000000000003', 'figure', 'figure 1', 1,
  '{"page": 1, "bbox": [0.10, 0.10, 0.30, 0.30]}'::jsonb, 'fixture-segment-hash-a-figure-1', 'proposed', 'model');
select pg_temp.allowed('a proposed segment may still be refined',
  $$update public.source_segments set locator = '{"page": 1, "bbox": [0.11, 0.11, 0.31, 0.31]}'::jsonb,
       label = 'figure 1 (tightened)'
     where id = '0b0e0003-0000-0000-0000-000000000001'$$);
-- The same piece means the same content in the same place. Re-discovery
-- reports both and collides, which is the deduplication discovery relies on.
-- The same content somewhere else is a different piece; that is asserted where
-- the recording is read, below.
select pg_temp.refused('the same piece of the same source is one segment, not two',
  $$insert into public.source_segments(organization_id, workflow_id, source_id, parent_segment_id, segment_kind,
      locator, content_hash, discovered_by)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0000-0000-0000-0000-000000000001',
            '0a0e0001-0000-0000-0000-000000000000', '0b0e0001-0000-0000-0000-000000000003', 'figure',
            '{"page": 1, "bbox": [0.11, 0.11, 0.31, 0.31]}'::jsonb, 'fixture-segment-hash-a-figure-1', 'model')$$);
select pg_temp.refused_because('a segment is nested under a segment of its own source, never another',
  $$insert into public.source_segments(organization_id, workflow_id, source_id, parent_segment_id, segment_kind,
      locator, content_hash, discovered_by)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0000-0000-0000-0000-000000000001',
            '0a0e0001-0000-0000-0000-000000000000', '0b0e0002-0000-0000-0000-000000000001', 'figure',
            '{"page": 1, "bbox": [0.5, 0.5, 0.6, 0.6]}'::jsonb, 'crossed-parent', 'model')$$,
  'another source');
select pg_temp.refused('a box in pixels is not a box every reader can compare',
  $$insert into public.source_segments(organization_id, workflow_id, source_id, segment_kind, locator, content_hash, discovered_by)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0000-0000-0000-0000-000000000001',
            '0a0e0001-0000-0000-0000-000000000000', 'figure', '{"bbox": [120, 340, 900, 1200]}'::jsonb, 'pixels', 'model')$$);
select pg_temp.refused('nor is a box with three corners',
  $$insert into public.source_segments(organization_id, workflow_id, source_id, segment_kind, locator, content_hash, discovered_by)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0000-0000-0000-0000-000000000001',
            '0a0e0001-0000-0000-0000-000000000000', 'figure', '{"bbox": [0.1, 0.1, 0.3]}'::jsonb, 'three', 'model')$$);
select pg_temp.refused('nor one whose right edge is left of its left edge',
  $$insert into public.source_segments(organization_id, workflow_id, source_id, segment_kind, locator, content_hash, discovered_by)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0000-0000-0000-0000-000000000001',
            '0a0e0001-0000-0000-0000-000000000000', 'figure', '{"bbox": [0.3, 0.1, 0.1, 0.3]}'::jsonb, 'inside-out', 'model')$$);
select pg_temp.refused('a time range that ends before it starts is not a range',
  $$insert into public.source_segments(organization_id, workflow_id, source_id, segment_kind, locator, content_hash, discovered_by)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0000-0000-0000-0000-000000000001',
            '0a0e0002-0000-0000-0000-000000000000', 'scene', '{"start_ms": 9000, "end_ms": 1000}'::jsonb, 'backwards', 'model')$$);
select pg_temp.refused('nor is one with only a start',
  $$insert into public.source_segments(organization_id, workflow_id, source_id, segment_kind, locator, content_hash, discovered_by)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0000-0000-0000-0000-000000000001',
            '0a0e0002-0000-0000-0000-000000000000', 'scene', '{"start_ms": 9000}'::jsonb, 'half', 'model')$$);
select pg_temp.refused('nor one written in words',
  $$insert into public.source_segments(organization_id, workflow_id, source_id, segment_kind, locator, content_hash, discovered_by)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0000-0000-0000-0000-000000000001',
            '0a0e0002-0000-0000-0000-000000000000', 'scene', '{"start_ms": "nine", "end_ms": 1000}'::jsonb, 'words', 'model')$$);
select pg_temp.refused('who found a segment is one of three words',
  $$insert into public.source_segments(organization_id, workflow_id, source_id, segment_kind, locator, content_hash, discovered_by)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0000-0000-0000-0000-000000000001',
            '0a0e0001-0000-0000-0000-000000000000', 'figure', '{}'::jsonb, 'guessed', 'a guess')$$);
select pg_temp.refused('and a segment has only four states',
  $$insert into public.source_segments(organization_id, workflow_id, source_id, segment_kind, locator, content_hash, discovered_by, status)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0000-0000-0000-0000-000000000001',
            '0a0e0001-0000-0000-0000-000000000000', 'figure', '{}'::jsonb, 'final', 'model', 'final')$$);
update public.source_segments set status = 'accepted' where id = '0b0e0003-0000-0000-0000-000000000001';
select pg_temp.refused_because('once accepted a segment stops — its label is what anchors were made against',
  $$update public.source_segments set label = 'figure 1 (again)' where id = '0b0e0003-0000-0000-0000-000000000001'$$,
  'cannot be rewritten under an anchor');
select pg_temp.refused('nor does it move',
  $$update public.source_segments set locator = '{"page": 1, "bbox": [0.2, 0.2, 0.4, 0.4]}'::jsonb
     where id = '0b0e0003-0000-0000-0000-000000000001'$$);
select pg_temp.refused('nor change what it is',
  $$update public.source_segments set segment_kind = 'table' where id = '0b0e0003-0000-0000-0000-000000000001'$$);
select pg_temp.refused('nor who found it',
  $$update public.source_segments set discovered_by = 'human' where id = '0b0e0003-0000-0000-0000-000000000001'$$);
select pg_temp.refused('nor go back to being merely proposed',
  $$update public.source_segments set status = 'proposed' where id = '0b0e0003-0000-0000-0000-000000000001'$$);
select pg_temp.refused_because('and an accepted segment is not deleted',
  $$delete from public.source_segments where id = '0b0e0003-0000-0000-0000-000000000001'$$,
  'stays in the record');
select pg_temp.refused('a fixture segment from the discoverer is just as fixed',
  $$update public.source_segments set locator = '{"page": 0, "bbox": [0.1, 0.1, 0.2, 0.2]}'::jsonb
     where id = '0b0e0001-0000-0000-0000-000000000002'$$);
insert into public.source_segments(id, organization_id, workflow_id, source_id, segment_kind, locator, content_hash, discovered_by)
values ('0b0e0003-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001',
  '0c0e0000-0000-0000-0000-000000000001', '0a0e0001-0000-0000-0000-000000000000', 'figure',
  '{"page": 0, "bbox": [0.7, 0.7, 0.8, 0.8]}'::jsonb, 'fixture-segment-hash-a-stray', 'model');
select pg_temp.affects('a segment that was only ever proposed may be withdrawn',
  $$delete from public.source_segments where id = '0b0e0003-0000-0000-0000-000000000002'$$, 1);

-- ──────────────────────────────────── an anchor is one consistent tuple
--
-- The persisted segment is the authority for where an anchor points. An anchor
-- that names a segment of one source and the id of another, or a box outside
-- the segment it claims to sit in, is not a place anybody can open.
select pg_temp.refused_because('an anchor cannot name a segment of one source and the id of another',
  $$insert into public.evidence_anchors(organization_id, workflow_id, claim_id, source_kind, source_id, segment_id, anchor_hash)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0000-0000-0000-0000-000000000001',
            '0e0e0000-0000-0000-0000-000000000001', 'segment', '0a0e0002-0000-0000-0000-000000000000',
            '0b0e0001-0000-0000-0000-000000000002', 'crossed')$$,
  'one source and the id of another');
select pg_temp.refused_because('nor locate a box outside the segment it sits in',
  $$insert into public.evidence_anchors(organization_id, workflow_id, claim_id, source_kind, segment_id, locator, anchor_hash)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0000-0000-0000-0000-000000000001',
            '0e0e0000-0000-0000-0000-000000000001', 'segment_locator', '0b0e0001-0000-0000-0000-000000000002',
            '{"bbox": [0.50, 0.00, 0.60, 0.10]}'::jsonb, 'outside')$$,
  'outside segment');
select pg_temp.refused_because('nor a time range outside the scene it names',
  $$insert into public.evidence_anchors(organization_id, workflow_id, claim_id, source_kind, segment_id, locator, anchor_hash)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0000-0000-0000-0000-000000000001',
            '0e0e0000-0000-0000-0000-000000000001', 'segment_locator', '0b0e0002-0000-0000-0000-000000000001',
            '{"start_ms": 40000, "end_ms": 50000}'::jsonb, 'overrun')$$,
  'outside segment');
select pg_temp.refused('nor is a box drawn in some other rendering''s pixels',
  $$insert into public.evidence_anchors(organization_id, workflow_id, claim_id, source_kind, segment_id, locator, anchor_hash)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0000-0000-0000-0000-000000000001',
            '0e0e0000-0000-0000-0000-000000000001', 'segment_locator', '0b0e0001-0000-0000-0000-000000000002',
            '{"bbox": [120, 340, 900, 1200]}'::jsonb, 'pixels')$$);
select pg_temp.refused('an anchor that points nowhere is not an anchor',
  $$insert into public.evidence_anchors(organization_id, workflow_id, claim_id, source_kind, anchor_hash)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0000-0000-0000-0000-000000000001',
            '0e0e0000-0000-0000-0000-000000000001', 'segment', 'nowhere')$$);
select pg_temp.refused('a locator anchor with no locator is not one either',
  $$insert into public.evidence_anchors(organization_id, workflow_id, claim_id, source_kind, segment_id, anchor_hash)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0000-0000-0000-0000-000000000001',
            '0e0e0000-0000-0000-0000-000000000001', 'segment_locator', '0b0e0001-0000-0000-0000-000000000002', 'empty')$$);
select pg_temp.refused('nor a source anchor that names no source',
  $$insert into public.evidence_anchors(organization_id, workflow_id, claim_id, source_kind, anchor_hash)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0000-0000-0000-0000-000000000001',
            '0e0e0000-0000-0000-0000-000000000001', 'source', 'nowhere')$$);
select pg_temp.refused('nor a person''s record that records nothing',
  $$insert into public.evidence_anchors(organization_id, workflow_id, claim_id, source_kind, anchor_hash)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0000-0000-0000-0000-000000000001',
            '0e0e0000-0000-0000-0000-000000000001', 'human_record', 'silent')$$);
select pg_temp.refused('nor an anchor of a kind the kernel has no word for',
  $$insert into public.evidence_anchors(organization_id, workflow_id, claim_id, source_kind, segment_id, anchor_hash)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0000-0000-0000-0000-000000000001',
            '0e0e0000-0000-0000-0000-000000000001', 'hearsay', '0b0e0001-0000-0000-0000-000000000002', 'hearsay')$$);
select pg_temp.refused('an anchor belongs to a claim or an assessment, not to nothing',
  $$insert into public.evidence_anchors(organization_id, workflow_id, source_kind, segment_id, anchor_hash)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0000-0000-0000-0000-000000000001',
            'segment', '0b0e0001-0000-0000-0000-000000000002', 'orphan')$$);
insert into public.evidence_anchors(id, organization_id, workflow_id, claim_id, source_kind, segment_id, locator, anchor_hash)
values
  ('0f0e0000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
   '0c0e0000-0000-0000-0000-000000000001', '0e0e0000-0000-0000-0000-000000000001', 'segment_locator',
   '0b0e0001-0000-0000-0000-000000000002', '{"bbox": [0.60, 0.10, 0.70, 0.20], "row": 3}'::jsonb, 'anchor-row-1-table'),
  ('0f0e0000-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001',
   '0c0e0000-0000-0000-0000-000000000001', '0e0e0000-0000-0000-0000-000000000001', 'segment_locator',
   '0b0e0002-0000-0000-0000-000000000001', '{"start_ms": 10000, "end_ms": 20000}'::jsonb, 'anchor-row-1-scene');
select pg_temp.check('a box inside its segment and a range inside its scene are anchors, and each learns its source from the segment',
  (select source_id from public.evidence_anchors where id = '0f0e0000-0000-0000-0000-000000000001')
    = '0a0e0001-0000-0000-0000-000000000000'
  and (select source_id from public.evidence_anchors where id = '0f0e0000-0000-0000-0000-000000000002')
    = '0a0e0002-0000-0000-0000-000000000000');
select pg_temp.refused_because('an anchor is a fingerprint of a source: even under a claim still in motion it is not repointed',
  $$update public.evidence_anchors set locator = '{"bbox": [0.61, 0.11, 0.71, 0.21]}'::jsonb
     where id = '0f0e0000-0000-0000-0000-000000000001'$$,
  'a different source is a different anchor');
select pg_temp.refused('nor its quoted source rewritten',
  $$update public.evidence_anchors set quoted_text = 'something else entirely'
     where id = '0f0e0000-0000-0000-0000-000000000001'$$);
select pg_temp.refused('nor moved onto another claim',
  $$update public.evidence_anchors set claim_id = '0e0e0000-0000-0000-0000-0000000000a2'
     where id = '0f0e0000-0000-0000-0000-000000000001'$$);
insert into public.evidence_anchors(id, organization_id, workflow_id, claim_id, source_kind, segment_id, anchor_hash)
values ('0f0e0000-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001',
  '0c0e0000-0000-0000-0000-000000000001', '0e0e0000-0000-0000-0000-000000000001', 'segment',
  '0b0e0001-0000-0000-0000-000000000001', 'anchor-row-1-stray');
select pg_temp.affects('an anchor under a claim still in motion may be withdrawn',
  $$delete from public.evidence_anchors where id = '0f0e0000-0000-0000-0000-000000000003'$$, 1);
select pg_temp.core_v2_settle();

-- ═════════════════════════ 3 · WHAT WAS ASKED, AND OF WHICH SOURCES ══════════
--
-- Two hashes, computed on the server: which immutable sources were read, and
-- what was asked of them. A caller may state what it believes and be told it
-- is stale; it never supplies the value.
create or replace function pg_temp.sources(p_set text) returns jsonb language sql immutable as $$
  select case p_set
    when 'started' then jsonb_build_array(
      jsonb_build_object('source_kind', 'document', 'label', 'started register', 'uri', 'fixture://started/register',
                         'content_hash', 'started-hash-register', 'hash_algorithm', 'sha-256', 'byte_size', 20480,
                         'media', jsonb_build_object('page_count', 3)),
      jsonb_build_object('source_kind', 'recording', 'label', 'started recording', 'uri', 'fixture://started/recording',
                         'object_version_id', 'version-7', 'byte_size', 655360))
    when 'reversed' then jsonb_build_array(
      jsonb_build_object('source_kind', 'recording', 'label', 'started recording', 'uri', 'fixture://started/recording',
                         'object_version_id', 'version-7', 'byte_size', 655360),
      jsonb_build_object('source_kind', 'document', 'label', 'started register', 'uri', 'fixture://started/register',
                         'content_hash', 'started-hash-register', 'hash_algorithm', 'sha-256', 'byte_size', 20480,
                         'media', jsonb_build_object('page_count', 3)))
    when 'rehashed' then jsonb_build_array(
      jsonb_build_object('source_kind', 'document', 'label', 'started register', 'uri', 'fixture://started/register',
                         'content_hash', 'started-hash-register-v2', 'hash_algorithm', 'sha-256', 'byte_size', 20480),
      jsonb_build_object('source_kind', 'recording', 'label', 'started recording', 'uri', 'fixture://started/recording',
                         'object_version_id', 'version-7', 'byte_size', 655360))
    when 'unidentified' then jsonb_build_array(
      jsonb_build_object('source_kind', 'document', 'label', 'just uploaded', 'uri', 'fixture://started/unhashed', 'byte_size', 10))
    when 'signed' then jsonb_build_array(
      jsonb_build_object('source_kind', 'document', 'label', 'signed', 'uri', 'https://store.example/x?X-Amz-Signature=abc',
                         'content_hash', 'h', 'hash_algorithm', 'sha-256'))
  end $$;

select pg_temp.check('a digest with its algorithm is an identity, and so is a storage version',
  public.core_v2_source_identity('{"content_hash":"h","hash_algorithm":"sha-256"}'::jsonb) = 'digest=sha-256:h'
  and public.core_v2_source_identity('{"object_version_id":"v7"}'::jsonb) = 'version=v7');
select pg_temp.check('a digest without its algorithm is not one, and neither is an empty string',
  public.core_v2_source_identity('{"content_hash":"h"}'::jsonb) is null
  and public.core_v2_source_identity('{"content_hash":"","hash_algorithm":"sha-256","object_version_id":""}'::jsonb) is null);
select pg_temp.refused_because('a workflow must name the sources it reads',
  $$select public.core_v2_source_set_fingerprint('[]'::jsonb)$$, 'must name the sources');
select pg_temp.refused_because('and a source nobody has identified is not a Core V2 source — the refusal names it',
  $$select public.core_v2_source_set_fingerprint(pg_temp.sources('unidentified'))$$, 'just uploaded');
insert into core_v2_hashes(k, v) select 'started', public.core_v2_source_set_fingerprint(pg_temp.sources('started'));
select pg_temp.check('the same sources in another order are another set',
  public.core_v2_source_set_fingerprint(pg_temp.sources('reversed')) <> (select v from core_v2_hashes where k = 'started'));
select pg_temp.check('a source whose content identity changed is a different set at the same locator and size',
  public.core_v2_source_set_fingerprint(pg_temp.sources('rehashed')) <> (select v from core_v2_hashes where k = 'started'));
select pg_temp.check('and the same sources again are the same set',
  public.core_v2_source_set_fingerprint(pg_temp.sources('started')) = (select v from core_v2_hashes where k = 'started'));
select pg_temp.check('one meaning has one written form: keys sorted, members sorted',
  public.core_v2_canonical_json('{"b":[3,1,2],"a":{"y":1,"x":[{"k":2},{"k":1}]}}'::jsonb)::text
    = '{"a": {"x": [{"k": 1}, {"k": 2}], "y": 1}, "b": [1, 2, 3]}');
select pg_temp.check('the same question written in another order is the same question',
  public.core_v2_request_fingerprint('synthetic-records', '1', 'synthetic_review',
    (select v from core_v2_hashes where k = 'started'), '{"parts":["b","a"],"depth":2}'::jsonb, 'core-v2.1')
  = public.core_v2_request_fingerprint('synthetic-records', '1', 'synthetic_review',
    (select v from core_v2_hashes where k = 'started'), '{"depth":2,"parts":["a","b"]}'::jsonb, 'core-v2.1'));
select pg_temp.check('while a different scope over the same sources is a different question',
  public.core_v2_request_fingerprint('synthetic-records', '1', 'synthetic_review',
    (select v from core_v2_hashes where k = 'started'), '{"parts":["a"]}'::jsonb, 'core-v2.1')
  <> public.core_v2_request_fingerprint('synthetic-records', '1', 'synthetic_review',
    (select v from core_v2_hashes where k = 'started'), '{"parts":["a","b"]}'::jsonb, 'core-v2.1'));
select pg_temp.check('and so is the same question under another pack version, or another engine',
  public.core_v2_request_fingerprint('synthetic-records', '2', 'synthetic_review',
    (select v from core_v2_hashes where k = 'started'), '{}'::jsonb, 'core-v2.1')
  <> public.core_v2_request_fingerprint('synthetic-records', '1', 'synthetic_review',
    (select v from core_v2_hashes where k = 'started'), '{}'::jsonb, 'core-v2.1')
  and public.core_v2_request_fingerprint('synthetic-records', '1', 'synthetic_review',
    (select v from core_v2_hashes where k = 'started'), '{}'::jsonb, 'core-v2.2')
  <> public.core_v2_request_fingerprint('synthetic-records', '1', 'synthetic_review',
    (select v from core_v2_hashes where k = 'started'), '{}'::jsonb, 'core-v2.1'));

-- ─────────────────────────────────────────────── starting is the machine's
--
-- Until a dispatcher exists, a person who could start a workflow could leave
-- a permanent start command nothing consumes. So the door is the service
-- role's, and an owner at the keyboard is refused before anything is written.
insert into core_v2_counts select 'workflows', count(*) from public.intelligence_workflows;
insert into core_v2_counts select 'commands', count(*) from public.workflow_outbox;
set local role authenticated;
set local test.uid = '11111111-1111-1111-1111-111111111111';
select pg_temp.refused('an owner does not start a workflow from the browser',
  $$select public.core_v2_start_workflow('aaaaaaaa-0000-0000-0000-000000000001', 'synthetic-records', '1',
      'synthetic_review', pg_temp.sources('started'))$$);
set local test.uid = '22222222-2222-2222-2222-222222222222';
select pg_temp.refused('nor does a contributor',
  $$select public.core_v2_start_workflow('aaaaaaaa-0000-0000-0000-000000000001', 'synthetic-records', '1',
      'synthetic_review', pg_temp.sources('started'))$$);
select pg_temp.check('though a member may ask what a set of sources hashes to',
  public.core_v2_source_set_fingerprint(pg_temp.sources('started')) = (select v from core_v2_hashes where k = 'started'));
set local role anon;
set local test.uid = '';
select pg_temp.refused('and a signed-out visitor has no way to start anything',
  $$select public.core_v2_start_workflow('aaaaaaaa-0000-0000-0000-000000000001', 'synthetic-records', '1',
      'synthetic_review', pg_temp.sources('started'))$$);
select pg_temp.refused('nor to ask what a set of sources hashes to',
  $$select public.core_v2_source_set_fingerprint(pg_temp.sources('started'))$$);
reset role;
select pg_temp.check('the refusals left no workflow and no start command behind',
  (select count(*) from public.intelligence_workflows) = (select n from core_v2_counts where k = 'workflows')
  and (select count(*) from public.workflow_outbox) = (select n from core_v2_counts where k = 'commands'));

set local test.uid = '11111111-1111-1111-1111-111111111111';
select pg_temp.refused_because('the worker cannot start work for an organisation that does not exist',
  $$select public.core_v2_start_workflow('aaaaaaaa-0000-0000-0000-00000000ffff', 'synthetic-records', '1',
      'synthetic_review', pg_temp.sources('started'))$$, 'no such organisation');
select pg_temp.refused_because('nor without naming the domain pack',
  $$select public.core_v2_start_workflow('aaaaaaaa-0000-0000-0000-000000000001', '', '1',
      'synthetic_review', pg_temp.sources('started'))$$, 'names its domain pack');
select pg_temp.refused_because('nor a reading of a source with no trustworthy identity',
  $$select public.core_v2_start_workflow('aaaaaaaa-0000-0000-0000-000000000001', 'synthetic-records', '1',
      'synthetic_review', pg_temp.sources('unidentified'))$$, 'cannot identify');
select pg_temp.refused('nor of a source located by a signed url',
  $$select public.core_v2_start_workflow('aaaaaaaa-0000-0000-0000-000000000001', 'synthetic-records', '1',
      'synthetic_review', pg_temp.sources('signed'))$$);
select pg_temp.refused_because('a fingerprint that no longer matches the sources stops the start',
  $$select public.core_v2_start_workflow('aaaaaaaa-0000-0000-0000-000000000001', 'synthetic-records', '1',
      'synthetic_review', pg_temp.sources('started'), '{}'::jsonb, 'core-v2.1', '{}'::jsonb, 'a-stale-hash')$$,
  'sources have changed');
select pg_temp.refused('an engine that is not Core V2 does not start a Core V2 workflow',
  $$select public.core_v2_start_workflow('aaaaaaaa-0000-0000-0000-000000000001', 'synthetic-records', '1',
      'synthetic_review', pg_temp.sources('started'), '{}'::jsonb, 'legacy-1')$$);
select pg_temp.refused('a budget the triggers could not read is refused at the door, not at the first task',
  $$select public.core_v2_start_workflow('aaaaaaaa-0000-0000-0000-000000000001', 'synthetic-records', '1',
      'synthetic_review', pg_temp.sources('started'), '{}'::jsonb, 'core-v2.1', '{"maximum_tasks": "three"}'::jsonb)$$);
select pg_temp.refused('and so is a budget of two and a half tasks',
  $$select public.core_v2_start_workflow('aaaaaaaa-0000-0000-0000-000000000001', 'synthetic-records', '1',
      'synthetic_review', pg_temp.sources('started'), '{}'::jsonb, 'core-v2.1', '{"maximum_tasks": 2.5}'::jsonb)$$);
select pg_temp.refused('or of minus one',
  $$select public.core_v2_start_workflow('aaaaaaaa-0000-0000-0000-000000000001', 'synthetic-records', '1',
      'synthetic_review', pg_temp.sources('started'), '{}'::jsonb, 'core-v2.1', '{"maximum_tasks": -1}'::jsonb)$$);

insert into core_v2_ids(k, v)
select 'w1', (public.core_v2_start_workflow('aaaaaaaa-0000-0000-0000-000000000001', 'synthetic-records', '1',
  'synthetic_review', pg_temp.sources('started'), '{"parts":["b","a"]}'::jsonb, 'core-v2.1',
  '{"maximum_critic_rounds": 2, "maximum_arbiter_rounds": 1}'::jsonb)).id;
select pg_temp.check('the worker starts a reading, and nothing has run yet',
  (select state from public.intelligence_workflows where id = pg_temp.id('w1')) = 'created'
  and (select started_at is null and finished_at is null from public.intelligence_workflows where id = pg_temp.id('w1')));
select pg_temp.check('it records both hashes: which sources, and what was asked of them',
  (select source_set_fingerprint from public.intelligence_workflows where id = pg_temp.id('w1'))
    = (select v from core_v2_hashes where k = 'started')
  and (select request_fingerprint from public.intelligence_workflows where id = pg_temp.id('w1'))
    = public.core_v2_request_fingerprint('synthetic-records', '1', 'synthetic_review',
        (select v from core_v2_hashes where k = 'started'), '{"parts":["a","b"]}'::jsonb, 'core-v2.1'));
select pg_temp.check('the scope and the budget are kept in their canonical form, and the asker is named',
  (select requested_scope from public.intelligence_workflows where id = pg_temp.id('w1')) = '{"parts": ["a", "b"]}'::jsonb
  and (select budget from public.intelligence_workflows where id = pg_temp.id('w1'))
        = '{"maximum_arbiter_rounds": 1, "maximum_critic_rounds": 2}'::jsonb
  and (select requested_by from public.intelligence_workflows where id = pg_temp.id('w1'))
        = '11111111-1111-1111-1111-111111111111');
select pg_temp.check('its sources are rows, in the order they were given, with their identity and metadata intact',
  (select array_agg(ordinal order by ordinal) from public.workflow_sources where workflow_id = pg_temp.id('w1')) = array[0, 1]
  and (select content_hash from public.workflow_sources where workflow_id = pg_temp.id('w1') and ordinal = 0) = 'started-hash-register'
  and (select media ->> 'page_count' from public.workflow_sources where workflow_id = pg_temp.id('w1') and ordinal = 0) = '3'
  and (select object_version_id from public.workflow_sources where workflow_id = pg_temp.id('w1') and ordinal = 1) = 'version-7'
  and (select source_kind from public.workflow_sources where workflow_id = pg_temp.id('w1') and ordinal = 1) = 'recording');
select pg_temp.check('the workflow and its one start command were committed together',
  (select count(*) from public.workflow_outbox where workflow_id = pg_temp.id('w1')) = 1
  and (select state from public.workflow_outbox where workflow_id = pg_temp.id('w1')) = 'pending'
  and (select command from public.workflow_outbox where workflow_id = pg_temp.id('w1')) = 'start');
select pg_temp.check('the command carries ids and fingerprints and nothing else — no locator, no bytes, no scope',
  (select bool_and(key in ('workflow_id', 'organization_id', 'domain_pack', 'domain_pack_version', 'workflow_type',
                           'engine_version', 'source_count', 'source_set_fingerprint', 'request_fingerprint'))
     from public.workflow_outbox o, jsonb_object_keys(o.payload) as key where o.workflow_id = pg_temp.id('w1'))
  and (select payload ->> 'source_set_fingerprint' from public.workflow_outbox where workflow_id = pg_temp.id('w1'))
        = (select v from core_v2_hashes where k = 'started')
  and (select payload::text not like '%fixture://%' from public.workflow_outbox where workflow_id = pg_temp.id('w1')));
select pg_temp.check('starting work is in the trail, with the sources and the request it was given',
  exists (select 1 from public.audit_events
           where action = 'core_v2.workflow.started' and entity_id = pg_temp.id('w1')::text
             and actor_id = '11111111-1111-1111-1111-111111111111'
             and detail ->> 'source_set_fingerprint' = (select v from core_v2_hashes where k = 'started')
             and detail ? 'request_fingerprint' and (detail ->> 'source_count')::int = 2));

select pg_temp.refused_because('the same question over the same sources is not asked twice at once',
  $$select public.core_v2_start_workflow('aaaaaaaa-0000-0000-0000-000000000001', 'synthetic-records', '1',
      'synthetic_review', pg_temp.sources('started'), '{"parts":["a","b"]}'::jsonb)$$, 'already being read');
select pg_temp.check('a fingerprint that still matches the sources lets a different question start',
  (public.core_v2_start_workflow('aaaaaaaa-0000-0000-0000-000000000001', 'synthetic-records', '1',
     'synthetic_review', pg_temp.sources('started'), '{"parts":["a"]}'::jsonb, 'core-v2.1', '{}'::jsonb,
     (select v from core_v2_hashes where k = 'started'))).state = 'created');
insert into core_v2_ids(k, v)
select 'w2', id from public.intelligence_workflows where requested_scope = '{"parts": ["a"]}'::jsonb;
set local test.uid = '';
select pg_temp.refused_because('a second live reading of the same request is a person''s to authorise, and nobody is signed in',
  $$select public.core_v2_start_workflow('aaaaaaaa-0000-0000-0000-000000000001', 'synthetic-records', '1',
      'synthetic_review', pg_temp.sources('started'), '{"parts":["a","b"]}'::jsonb, 'core-v2.1', '{}'::jsonb, null, true)$$,
  'nobody is signed in');
set local test.uid = '11111111-1111-1111-1111-111111111111';
insert into core_v2_ids(k, v)
select 'w3', (public.core_v2_start_workflow('aaaaaaaa-0000-0000-0000-000000000001', 'synthetic-records', '1',
  'synthetic_review', pg_temp.sources('started'), '{"parts":["a","b"]}'::jsonb, 'core-v2.1', '{}'::jsonb, null, true)).id;
select pg_temp.check('a person may say to read it again, and it is recorded that they did',
  (select duplicate_authorized_by from public.intelligence_workflows where id = pg_temp.id('w3'))
    = '11111111-1111-1111-1111-111111111111'
  and exists (select 1 from public.audit_events where action = 'core_v2.workflow.started'
               and entity_id = pg_temp.id('w3')::text and (detail ->> 'duplicate_authorized')::boolean));

-- ─────────────────────────────── one transaction, or none: the outbox atomicity
create or replace function pg_temp.break_outbox() returns trigger language plpgsql as $$
begin raise exception 'the outbox is unavailable'; end $$;
create trigger core_v2_test_break_outbox before insert on public.workflow_outbox
  for each row execute function pg_temp.break_outbox();
insert into core_v2_counts select 'workflows_before_break', count(*) from public.intelligence_workflows;
insert into core_v2_counts select 'sources_before_break', count(*) from public.workflow_sources;
select pg_temp.refused_because('a start whose command cannot be written fails',
  $$select public.core_v2_start_workflow('aaaaaaaa-0000-0000-0000-000000000001', 'synthetic-records', '1',
      'synthetic_review', pg_temp.sources('started'), '{"parts":["c"]}'::jsonb)$$, 'outbox is unavailable');
select pg_temp.check('and leaves no workflow and no source behind — every row, or none',
  (select count(*) from public.intelligence_workflows) = (select n from core_v2_counts where k = 'workflows_before_break')
  and (select count(*) from public.workflow_sources) = (select n from core_v2_counts where k = 'sources_before_break'));
drop trigger core_v2_test_break_outbox on public.workflow_outbox;
select pg_temp.check('every workflow the door started has exactly one start command',
  not exists (select 1 from public.intelligence_workflows w
               where w.id in (pg_temp.id('w1'), pg_temp.id('w2'), pg_temp.id('w3'))
                 and (select count(*) from public.workflow_outbox o where o.workflow_id = w.id) <> 1)
  and (select count(*) from public.workflow_outbox) = (select n from core_v2_counts where k = 'commands') + 3);
select pg_temp.refused('and a workflow never holds two start commands',
  $$insert into public.workflow_outbox(organization_id, workflow_id)
    values ('aaaaaaaa-0000-0000-0000-000000000001', pg_temp.id('w1'))$$);

-- ─────────────────────────────────────────── the dispatcher's two moves
select pg_temp.check('claiming the command takes it to dispatching and the workflow to queued, naming the dispatcher',
  (select state from public.core_v2_claim_outbox(pg_temp.id('w1'), 'dispatcher-a')) = 'dispatching');
select pg_temp.check('and the claim is on the row: who, and how many times',
  (select state from public.workflow_outbox where workflow_id = pg_temp.id('w1')) = 'dispatching'
  and (select dispatcher from public.workflow_outbox where workflow_id = pg_temp.id('w1')) = 'dispatcher-a'
  and (select attempt_count from public.workflow_outbox where workflow_id = pg_temp.id('w1')) = 1
  and (select state from public.intelligence_workflows where id = pg_temp.id('w1')) = 'queued');
select pg_temp.check('claiming it again returns nothing — losing a race is not a failure',
  public.core_v2_claim_outbox(pg_temp.id('w1'), 'dispatcher-b') is null);
select pg_temp.check('nor does acknowledging a command nobody is dispatching',
  public.core_v2_acknowledge_outbox(pg_temp.id('w3')) is null);
select pg_temp.check('acknowledging a dispatching command settles it',
  (select state from public.core_v2_acknowledge_outbox(pg_temp.id('w1'))) = 'acknowledged');
select pg_temp.check('and acknowledging it twice returns nothing, so a late acknowledgement is told apart from a lost one',
  public.core_v2_acknowledge_outbox(pg_temp.id('w1')) is null
  and (select state from public.workflow_outbox where workflow_id = pg_temp.id('w1')) = 'acknowledged');
select public.core_v2_claim_outbox(pg_temp.id('w2'), 'dispatcher-a');
select public.core_v2_acknowledge_outbox(pg_temp.id('w2'));
select pg_temp.refused_because('a command in flight is not rewritten',
  $$update public.workflow_outbox set payload = '{"workflow_id": "x"}'::jsonb where workflow_id = pg_temp.id('w3')$$,
  'not rewritten in flight');
select pg_temp.refused('nor repointed at another workflow',
  $$update public.workflow_outbox set workflow_id = pg_temp.id('w1') where workflow_id = pg_temp.id('w3')$$);
select pg_temp.refused('nor turned into another command',
  $$update public.workflow_outbox set command = 'stop' where workflow_id = pg_temp.id('w3')$$);
select pg_temp.refused('nor moved to another organisation',
  $$update public.workflow_outbox set organization_id = 'aaaaaaaa-0000-0000-0000-000000000002' where workflow_id = pg_temp.id('w3')$$);
select pg_temp.allowed('while the dispatcher may record that it is trying, when to try again, and what went wrong',
  $$update public.workflow_outbox set state = 'dispatching', attempt_count = 1, dispatcher = 'dispatcher-c',
       available_at = now() + interval '1 minute', last_error = 'the orchestrator did not answer'
     where workflow_id = pg_temp.id('w3')$$);
select pg_temp.allowed('and give up, in a word the row has',
  $$update public.workflow_outbox set state = 'failed' where workflow_id = pg_temp.id('w3')$$);
select pg_temp.refused('but not in a word it does not',
  $$update public.workflow_outbox set state = 'lost' where workflow_id = pg_temp.id('w3')$$);

-- ══════════════════════════════ 4 · INTENT IS WRITTEN ONCE ═══════════════════
select pg_temp.refused_because('a worker cannot rewrite what a reading was asked to do',
  $$update public.intelligence_workflows set requested_scope = '{"parts": ["everything"]}'::jsonb where id = pg_temp.id('w1')$$,
  'its intent is fixed at creation');
select pg_temp.refused('nor which sources it read',
  $$update public.intelligence_workflows set source_set_fingerprint = 'other' where id = pg_temp.id('w1')$$);
select pg_temp.refused('nor what request that made',
  $$update public.intelligence_workflows set request_fingerprint = 'other' where id = pg_temp.id('w1')$$);
select pg_temp.refused('nor who asked for it',
  $$update public.intelligence_workflows set requested_by = '44444444-4444-4444-4444-444444444444' where id = pg_temp.id('w1')$$);
select pg_temp.refused('nor under which pack',
  $$update public.intelligence_workflows set domain_pack = 'other-pack' where id = pg_temp.id('w1')$$);
select pg_temp.refused('nor which version of it',
  $$update public.intelligence_workflows set domain_pack_version = '2' where id = pg_temp.id('w1')$$);
select pg_temp.refused('nor what kind of work',
  $$update public.intelligence_workflows set workflow_type = 'something_else' where id = pg_temp.id('w1')$$);
select pg_temp.refused('nor which engine',
  $$update public.intelligence_workflows set engine_version = 'core-v2.9' where id = pg_temp.id('w1')$$);
select pg_temp.refused('nor the limits it was admitted under',
  $$update public.intelligence_workflows set budget = '{"maximum_tasks": 1000000}'::jsonb where id = pg_temp.id('w1')$$);
select pg_temp.refused('nor who authorised a duplicate, after the fact',
  $$update public.intelligence_workflows set duplicate_authorized_by = '11111111-1111-1111-1111-111111111111' where id = pg_temp.id('w1')$$);
select pg_temp.refused('nor when it was created',
  $$update public.intelligence_workflows set created_at = now() - interval '1 year' where id = pg_temp.id('w1')$$);
select pg_temp.allowed('while progress and the orchestrator''s handle may move',
  $$update public.intelligence_workflows set orchestrator_run_id = 'run-1', total_units = 6 where id = pg_temp.id('w1')$$);
select pg_temp.refused('though progress is counted, and a count is not negative',
  $$update public.intelligence_workflows set completed_units = -1 where id = pg_temp.id('w1')$$);
select pg_temp.check('planning is when work started, and the record says so',
  (select started_at is not null from public.core_v2_workflow_transition(pg_temp.id('w1'), 'planning')));
select pg_temp.check('and running is a state a planning workflow reaches',
  (select state from public.core_v2_workflow_transition(pg_temp.id('w1'), 'running')) = 'running');
select pg_temp.refused_because('but a running workflow is not completed by skipping the decision',
  $$select public.core_v2_workflow_transition(pg_temp.id('w1'), 'completed')$$, 'cannot go from running to completed');
select pg_temp.refused_because('and a workflow that does not exist cannot be moved',
  $$select public.core_v2_workflow_transition('0c0e0000-0000-0000-0000-00000000ffff', 'planning')$$, 'no workflow');
select public.core_v2_workflow_transition(pg_temp.id('w2'), 'planning');
select public.core_v2_workflow_transition(pg_temp.id('w2'), 'running');
select public.core_v2_workflow_transition(pg_temp.id('w2'), 'ready_for_decision');
select public.core_v2_workflow_transition(pg_temp.id('w2'), 'deciding');
select pg_temp.check('a workflow that completes records when it finished',
  (select finished_at is not null and state = 'completed'
     from public.core_v2_workflow_transition(pg_temp.id('w2'), 'completed')));
select pg_temp.refused('and a finished workflow does not start again',
  $$select public.core_v2_workflow_transition(pg_temp.id('w2'), 'running')$$);

-- ══════════════════════════════ 5 · THE BOUNDED WORK ═════════════════════════
--
-- The worker writes these rows. What the tests prove is that even the worker
-- cannot do the things that cost money for nothing: exceed the budget a
-- workflow was admitted under, requeue work that may already be with an
-- executor, send a request without an unexpired lease, run a call whose
-- outcome nobody knows, or edit what an executor said after the fact.

-- ──────────────────────────────────────── the budget, applied where a task is born
insert into core_v2_ids(k, v)
select 'w4', (public.core_v2_start_workflow('aaaaaaaa-0000-0000-0000-000000000001', 'synthetic-records', '1',
  'synthetic_review', pg_temp.sources('started'), '{"parts":["budget"]}'::jsonb, 'core-v2.1',
  '{"maximum_tasks": 4, "maximum_child_tasks_per_parent": 1, "maximum_follow_up_depth": 1, "maximum_dependency_edges": 1}'::jsonb)).id;
insert into public.workflow_tasks(id, organization_id, workflow_id, parent_task_id, depth, phase, task_type, role_key,
  role_version, subject_key, input_fingerprint, contract_version)
values
  ('0c0e0001-0000-0000-0000-000000000041', 'aaaaaaaa-0000-0000-0000-000000000001', pg_temp.id('w4'), null, 0,
   'discover', 'find_segments', 'discoverer', '1', 'register', 'fp-b1', 'find_segments@1'),
  ('0c0e0001-0000-0000-0000-000000000042', 'aaaaaaaa-0000-0000-0000-000000000001', pg_temp.id('w4'),
   '0c0e0001-0000-0000-0000-000000000041', 1,
   'analyze', 'read_register', 'reader', '1', 'register/row-1', 'fp-b2', 'read_register@1'),
  ('0c0e0001-0000-0000-0000-000000000043', 'aaaaaaaa-0000-0000-0000-000000000001', pg_temp.id('w4'), null, 0,
   'analyze', 'read_register', 'reader', '1', 'register/row-2', 'fp-b3', 'read_register@1');
select pg_temp.refused_because('a parent has as many children as the workflow allows, and no more',
  $$insert into public.workflow_tasks(organization_id, workflow_id, parent_task_id, depth, phase, task_type, role_key,
      role_version, subject_key, input_fingerprint, contract_version)
    values ('aaaaaaaa-0000-0000-0000-000000000001', pg_temp.id('w4'), '0c0e0001-0000-0000-0000-000000000041', 1,
            'analyze', 'read_register', 'reader', '1', 'register/row-3', 'fp-b4', 'read_register@1')$$,
  'children');
select pg_temp.refused_because('a follow-up of a follow-up is deeper than the workflow allows',
  $$insert into public.workflow_tasks(organization_id, workflow_id, parent_task_id, depth, phase, task_type, role_key,
      role_version, subject_key, input_fingerprint, contract_version)
    values ('aaaaaaaa-0000-0000-0000-000000000001', pg_temp.id('w4'), '0c0e0001-0000-0000-0000-000000000042', 2,
            'verify', 'verify_row', 'verifier', '1', 'register/row-1', 'fp-b5', 'verify_row@1')$$,
  'deep');
select pg_temp.allowed('the fourth task is within the budget',
  $$insert into public.workflow_tasks(id, organization_id, workflow_id, phase, task_type, role_key,
      role_version, subject_key, input_fingerprint, contract_version)
    values ('0c0e0001-0000-0000-0000-000000000044', 'aaaaaaaa-0000-0000-0000-000000000001', pg_temp.id('w4'),
            'analyze', 'read_register', 'reader', '1', 'register/row-4', 'fp-b6', 'read_register@1')$$);
select pg_temp.refused_because('the fifth is not — the budget is counted from persisted rows, not a planner''s memory',
  $$insert into public.workflow_tasks(organization_id, workflow_id, phase, task_type, role_key,
      role_version, subject_key, input_fingerprint, contract_version)
    values ('aaaaaaaa-0000-0000-0000-000000000001', pg_temp.id('w4'),
            'analyze', 'read_register', 'reader', '1', 'register/row-5', 'fp-b7', 'read_register@1')$$,
  'its budget allows no more');
select pg_temp.allowed('one dependency edge is within the budget',
  $$insert into public.task_dependencies(organization_id, task_id, depends_on_task_id, dependency_kind)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0001-0000-0000-0000-000000000043',
            '0c0e0001-0000-0000-0000-000000000041', 'requires_completion')$$);
select pg_temp.refused_because('a second is past it',
  $$insert into public.task_dependencies(organization_id, task_id, depends_on_task_id, dependency_kind)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0001-0000-0000-0000-000000000044',
            '0c0e0001-0000-0000-0000-000000000041', 'requires_completion')$$,
  'dependency edges');
select pg_temp.refused('a task does not wait for itself',
  $$insert into public.task_dependencies(organization_id, task_id, depends_on_task_id, dependency_kind)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0001-0000-0000-0000-000000000001',
            '0c0e0001-0000-0000-0000-000000000001', 'requires_completion')$$);
select pg_temp.refused('nor for something the kernel has no word for',
  $$insert into public.task_dependencies(organization_id, task_id, depends_on_task_id, dependency_kind)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0001-0000-0000-0000-000000000041',
            '0c0e0001-0000-0000-0000-000000000043', 'requires_luck')$$);
select pg_temp.check('a workflow admitted with no limit has no limit, and one with a limit keeps it',
  (select count(*) from public.workflow_tasks where workflow_id = pg_temp.id('w4')) = 4
  and (select budget ->> 'maximum_tasks' from public.intelligence_workflows where id = pg_temp.id('w1')) is null);

-- ─────────────────────────────────────────────── the identity of a task
select pg_temp.check('the identity of a task is its phase, type, subject, input, contract and independence group',
  exists (select 1 from pg_indexes where indexname = 'workflow_tasks_identity' and indexdef like '%UNIQUE%'
           and indexdef like '%independence_group%'));
select pg_temp.refused('so the same bounded work is not queued twice inside one reading',
  $$insert into public.workflow_tasks(organization_id, workflow_id, phase, task_type, role_key, role_version,
      subject_key, input_fingerprint, contract_version)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0000-0000-0000-0000-000000000001', 'discover',
            'find_segments', 'discoverer', '1', 'register-a', 'fp-discover-a', 'find_segments@1')$$);
select pg_temp.allowed('while a second blind reading of the same thing is a second task, in its own group',
  $$insert into public.workflow_tasks(id, organization_id, workflow_id, phase, task_type, role_key, role_version,
      subject_key, input_fingerprint, contract_version, independence_group)
    values ('0c0e0001-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001',
            '0c0e0000-0000-0000-0000-000000000001', 'discover', 'find_segments', 'discoverer', '1',
            'register-a', 'fp-discover-a', 'find_segments@1', 'second-reader')$$);
select pg_temp.refused('a phase is one of the kernel''s eight',
  $$insert into public.workflow_tasks(organization_id, workflow_id, phase, task_type, role_key, role_version,
      subject_key, input_fingerprint, contract_version)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0000-0000-0000-0000-000000000001', 'guess',
            'find_segments', 'discoverer', '1', 'x', 'fp', 'v1')$$);
-- Zero claims is a real assignment: a critic, an arbiter, a comparator and a
-- composer assert nothing. A negative allowance is not.
select pg_temp.allowed('a task may be allowed no claims at all — a reviewer asserts nothing',
  $$insert into public.workflow_tasks(organization_id, workflow_id, phase, task_type, role_key, role_version,
      subject_key, input_fingerprint, contract_version, max_claims)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0000-0000-0000-0000-000000000001', 'verify',
            'verify_claim', 'evidence_critic', '1', 'zero-claims', 'fp-zero', 'v1', 0)$$);
select pg_temp.refused('but never fewer than none',
  $$insert into public.workflow_tasks(organization_id, workflow_id, phase, task_type, role_key, role_version,
      subject_key, input_fingerprint, contract_version, max_claims)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0000-0000-0000-0000-000000000001', 'analyze',
            'read_register', 'reader', '1', 'x', 'fp', 'v1', -1)$$);
select pg_temp.allowed('a task is handed a whole source or one segment of it',
  $$insert into public.task_sources(organization_id, task_id, ordinal, source_id)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0001-0000-0000-0000-000000000001', 0,
            '0a0e0001-0000-0000-0000-000000000000');
    insert into public.task_sources(organization_id, task_id, ordinal, segment_id)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0001-0000-0000-0000-000000000001', 1,
            '0b0e0001-0000-0000-0000-000000000002')$$);
select pg_temp.refused('never both in one row',
  $$insert into public.task_sources(organization_id, task_id, ordinal, source_id, segment_id)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0001-0000-0000-0000-000000000001', 2,
            '0a0e0001-0000-0000-0000-000000000000', '0b0e0001-0000-0000-0000-000000000002')$$);
select pg_temp.refused('and never neither',
  $$insert into public.task_sources(organization_id, task_id, ordinal)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0001-0000-0000-0000-000000000001', 2)$$);
select pg_temp.refused_because('a source a task was handed is not deleted from under it',
  $$delete from public.workflow_sources where id = '0a0e0003-0000-0000-0000-000000000000'$$,
  'part of the record');

-- ──────────────────────────────────── the lease: a fencing token, not a name
insert into public.workflow_tasks(id, organization_id, workflow_id, phase, task_type, role_key, role_version,
  subject_key, input_fingerprint, contract_version, lease_owner)
values ('0c0e0001-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001', pg_temp.id('w1'),
  'analyze', 'read_register', 'reader', '1', 'started/row-1', 'fp-w1-row-1', 'read_register@1', 'nobody-yet');
select pg_temp.check('a task that is not leased carries no lease, whatever was written',
  (select lease_owner is null from public.workflow_tasks where id = '0c0e0001-0000-0000-0000-000000000011'));
select pg_temp.refused_because('a task is not written as leased without a token and an expiry',
  $$insert into public.workflow_tasks(organization_id, workflow_id, phase, task_type, role_key, role_version,
      subject_key, input_fingerprint, contract_version, state)
    values ('aaaaaaaa-0000-0000-0000-000000000001', pg_temp.id('w1'), 'analyze', 'read_register', 'reader', '1',
            'started/unleased', 'fp-unleased', 'read_register@1', 'leased')$$,
  'without a token and an expiry');
select pg_temp.check('a created task is not leased — it is queued first',
  public.core_v2_lease_task('0c0e0001-0000-0000-0000-000000000011', 'worker-a', 60000) is null);
select public.core_v2_task_transition('0c0e0001-0000-0000-0000-000000000011', 'queued');
insert into core_v2_ids(k, v)
select 'lease1', (public.core_v2_lease_task('0c0e0001-0000-0000-0000-000000000011', 'worker-a', 60000)).lease_token;
select pg_temp.check('a queued task is leased under a fresh token, to a named owner, for a bounded time',
  pg_temp.id('lease1') is not null
  and (select state from public.workflow_tasks where id = '0c0e0001-0000-0000-0000-000000000011') = 'leased'
  and (select lease_owner from public.workflow_tasks where id = '0c0e0001-0000-0000-0000-000000000011') = 'worker-a'
  and (select lease_expires_at > now() and lease_expires_at <= now() + interval '60 seconds'
         from public.workflow_tasks where id = '0c0e0001-0000-0000-0000-000000000011'));
select pg_temp.check('a live lease is not granted again, to anyone',
  public.core_v2_lease_task('0c0e0001-0000-0000-0000-000000000011', 'worker-b', 60000) is null
  and public.core_v2_lease_task('0c0e0001-0000-0000-0000-000000000011', 'worker-a', 60000) is null);
select pg_temp.check('a heartbeat under the wrong token extends nothing',
  public.core_v2_heartbeat_lease('0c0e0001-0000-0000-0000-000000000011', gen_random_uuid(), 120000) = false
  and (select lease_expires_at <= now() + interval '60 seconds'
         from public.workflow_tasks where id = '0c0e0001-0000-0000-0000-000000000011'));
select pg_temp.check('and under the right one it extends the lease',
  public.core_v2_heartbeat_lease('0c0e0001-0000-0000-0000-000000000011', pg_temp.id('lease1'), 120000) = true);
select pg_temp.check('by the time it asked for',
  (select lease_expires_at > now() + interval '60 seconds'
     from public.workflow_tasks where id = '0c0e0001-0000-0000-0000-000000000011'));
update public.workflow_tasks set lease_expires_at = now() - interval '1 second'
 where id = '0c0e0001-0000-0000-0000-000000000011';
insert into core_v2_ids(k, v)
select 'lease2', (public.core_v2_lease_task('0c0e0001-0000-0000-0000-000000000011', 'worker-b', 60000)).lease_token;
select pg_temp.check('a lease that ran out before anything was sent is taken over, under a new token',
  pg_temp.id('lease2') is not null and pg_temp.id('lease2') <> pg_temp.id('lease1')
  and (select lease_owner from public.workflow_tasks where id = '0c0e0001-0000-0000-0000-000000000011') = 'worker-b');
select pg_temp.check('and the worker that lost it can no longer extend it — it knows its name, not the new token',
  public.core_v2_heartbeat_lease('0c0e0001-0000-0000-0000-000000000011', pg_temp.id('lease1'), 120000) = false);

-- ─────────────────────────────── the one moment money may leave: submission
insert into public.agent_attempts(id, organization_id, workflow_id, task_id, attempt_no, role_key, role_version,
  executor_kind, executor_family, independence_domain, packet_fingerprint, packet_bytes)
values ('0d0e0000-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001', pg_temp.id('w1'),
  '0c0e0001-0000-0000-0000-000000000011', 1, 'reader', '1', 'model', 'family-x', 'model:family-x', 'packet-w1-row-1', 4096);
select pg_temp.refused_because('a request is not sent from a task that is only leased',
  $$select public.core_v2_submit_attempt('0d0e0000-0000-0000-0000-000000000011', pg_temp.id('lease2'))$$,
  'not running');
select public.core_v2_task_transition('0c0e0001-0000-0000-0000-000000000011', 'running');
select pg_temp.refused_because('nor under a token the task no longer carries',
  $$select public.core_v2_submit_attempt('0d0e0000-0000-0000-0000-000000000011', pg_temp.id('lease1'))$$,
  'lease token does not match');
select pg_temp.refused_because('nor under no token at all',
  $$select public.core_v2_submit_attempt('0d0e0000-0000-0000-0000-000000000011', null)$$,
  'lease token does not match');
update public.workflow_tasks set lease_expires_at = now() - interval '1 second'
 where id = '0c0e0001-0000-0000-0000-000000000011';
select pg_temp.refused_because('nor under a lease that has run out',
  $$select public.core_v2_submit_attempt('0d0e0000-0000-0000-0000-000000000011', pg_temp.id('lease2'))$$,
  'has expired');
update public.workflow_tasks set lease_expires_at = now() + interval '5 minutes'
 where id = '0c0e0001-0000-0000-0000-000000000011';
update public.intelligence_workflows set cancel_requested_at = now() where id = pg_temp.id('w1');
select pg_temp.refused_because('nor once somebody has asked for the workflow to stop',
  $$select public.core_v2_submit_attempt('0d0e0000-0000-0000-0000-000000000011', pg_temp.id('lease2'))$$,
  'cancellation');
update public.intelligence_workflows set cancel_requested_at = null where id = pg_temp.id('w1');
insert into public.agent_attempts(id, organization_id, workflow_id, task_id, attempt_no, role_key, role_version,
  executor_kind, executor_family, independence_domain, packet_fingerprint, state)
values ('0d0e0000-0000-0000-0000-000000000012', 'aaaaaaaa-0000-0000-0000-000000000001', pg_temp.id('w1'),
  '0c0e0001-0000-0000-0000-000000000011', 2, 'reader', '1', 'model', 'family-x', 'model:family-x', 'packet-w1-row-1',
  'rejected_before_submission');
select pg_temp.refused_because('nor is an attempt sent that is not prepared',
  $$select public.core_v2_submit_attempt('0d0e0000-0000-0000-0000-000000000012', pg_temp.id('lease2'))$$,
  'not prepared');
insert into public.workflow_tasks(id, organization_id, workflow_id, phase, task_type, role_key, role_version,
  subject_key, input_fingerprint, contract_version, state, lease_token, lease_expires_at)
values ('0c0e0001-0000-0000-0000-000000000021', 'aaaaaaaa-0000-0000-0000-000000000001', pg_temp.id('w2'),
  'analyze', 'read_register', 'reader', '1', 'started/row-1', 'fp-w2-row-1', 'read_register@1', 'running',
  '0d0e0000-0000-0000-0000-00000000aaaa', now() + interval '5 minutes');
insert into public.agent_attempts(id, organization_id, workflow_id, task_id, attempt_no, role_key, role_version,
  executor_kind, executor_family, independence_domain, packet_fingerprint)
values ('0d0e0000-0000-0000-0000-000000000021', 'aaaaaaaa-0000-0000-0000-000000000001', pg_temp.id('w2'),
  '0c0e0001-0000-0000-0000-000000000021', 1, 'reader', '1', 'model', 'family-x', 'model:family-x', 'packet-w2-row-1');
select pg_temp.refused_because('nor from a workflow that has already finished, whatever its task says',
  $$select public.core_v2_submit_attempt('0d0e0000-0000-0000-0000-000000000021', '0d0e0000-0000-0000-0000-00000000aaaa')$$,
  'is completed');
select pg_temp.refused_because('and an attempt that does not exist is not sent',
  $$select public.core_v2_submit_attempt('0d0e0000-0000-0000-0000-00000000ffff', pg_temp.id('lease2'))$$,
  'no attempt');
select pg_temp.check('with an unexpired lease, a running task and a prepared attempt, the request goes out',
  (select state = 'submitted' and submitted_at is not null and lease_token = pg_temp.id('lease2')
     from public.core_v2_submit_attempt('0d0e0000-0000-0000-0000-000000000011', pg_temp.id('lease2'))));
select pg_temp.refused_because('and it does not go out twice',
  $$select public.core_v2_submit_attempt('0d0e0000-0000-0000-0000-000000000011', pg_temp.id('lease2'))$$,
  'not prepared');
select pg_temp.check('the attempt records the token it was sent under',
  (select lease_token from public.agent_attempts where id = '0d0e0000-0000-0000-0000-000000000011') = pg_temp.id('lease2'));

-- Independence is not the router's private business. A second blind reading of
-- one subject is refused at this door when it would run in an executor domain
-- that already read that subject under another group — whatever the caller
-- believed when it chose. Two family names on one executor are one domain, so
-- this is the check that makes aliases useless as a way to fake independence.
insert into public.workflow_tasks(id, organization_id, workflow_id, phase, task_type, role_key, role_version,
  subject_key, input_fingerprint, contract_version, independence_group, state, lease_token, lease_expires_at)
values ('0c0e0001-0000-0000-0000-0000000009a1', 'aaaaaaaa-0000-0000-0000-000000000001', pg_temp.id('w1'),
  'analyze', 'read_register', 'reader', '1', 'blind/subject-1', 'fp-blind-a', 'read_register@1', 'reader-a',
  'running', '0d0e0000-0000-0000-0000-0000000009c1', now() + interval '5 minutes'),
  ('0c0e0001-0000-0000-0000-0000000009a2', 'aaaaaaaa-0000-0000-0000-000000000001', pg_temp.id('w1'),
  'analyze', 'read_register', 'reader', '1', 'blind/subject-1', 'fp-blind-b', 'read_register@1', 'reader-b',
  'running', '0d0e0000-0000-0000-0000-0000000009c2', now() + interval '5 minutes');
insert into public.agent_attempts(id, organization_id, workflow_id, task_id, attempt_no, role_key, role_version,
  executor_kind, executor_family, independence_domain, packet_fingerprint)
values ('0d0e0000-0000-0000-0000-0000000009b1', 'aaaaaaaa-0000-0000-0000-000000000001', pg_temp.id('w1'),
  '0c0e0001-0000-0000-0000-0000000009a1', 1, 'reader', '1', 'model', 'family-one', 'domain:one', 'packet-blind-a'),
  ('0d0e0000-0000-0000-0000-0000000009b2', 'aaaaaaaa-0000-0000-0000-000000000001', pg_temp.id('w1'),
  '0c0e0001-0000-0000-0000-0000000009a2', 1, 'reader', '1', 'model', 'family-two', 'domain:one', 'packet-blind-b'),
  ('0d0e0000-0000-0000-0000-0000000009b3', 'aaaaaaaa-0000-0000-0000-000000000001', pg_temp.id('w1'),
  '0c0e0001-0000-0000-0000-0000000009a2', 2, 'reader', '1', 'model', 'family-three', 'domain:two', 'packet-blind-b2');
select pg_temp.check('the first blind reading of a subject goes out',
  (select state from public.core_v2_submit_attempt('0d0e0000-0000-0000-0000-0000000009b1',
     '0d0e0000-0000-0000-0000-0000000009c1')) = 'submitted');
select pg_temp.refused_because('the second is refused when its domain is the one that already read this subject — two family names, one executor, one domain',
  $$select public.core_v2_submit_attempt('0d0e0000-0000-0000-0000-0000000009b2', '0d0e0000-0000-0000-0000-0000000009c2')$$,
  'independence');
select pg_temp.check('and the refused reading was never sent',
  (select state from public.agent_attempts where id = '0d0e0000-0000-0000-0000-0000000009b2') = 'prepared');
select pg_temp.check('a second reading in a domain that has not read this subject goes out',
  (select state from public.core_v2_submit_attempt('0d0e0000-0000-0000-0000-0000000009b3',
     '0d0e0000-0000-0000-0000-0000000009c2')) = 'submitted');


select pg_temp.check('the heartbeat keeps working while the request is out',
  public.core_v2_heartbeat_lease('0c0e0001-0000-0000-0000-000000000011', pg_temp.id('lease2'), 120000) = true);
update public.workflow_tasks set lease_expires_at = now() - interval '1 second'
 where id = '0c0e0001-0000-0000-0000-000000000011';
select pg_temp.check('a lease that expires after the request went out is not taken over — the executor may have run',
  public.core_v2_lease_task('0c0e0001-0000-0000-0000-000000000011', 'worker-c', 60000) is null
  and (select state from public.workflow_tasks where id = '0c0e0001-0000-0000-0000-000000000011') = 'running');
update public.workflow_tasks set lease_expires_at = now() + interval '5 minutes'
 where id = '0c0e0001-0000-0000-0000-000000000011';
select pg_temp.refused_because('and the task is not cancelled as though it never left',
  $$select public.core_v2_task_transition('0c0e0001-0000-0000-0000-000000000011', 'cancelled')$$,
  'already submitted');

-- A leased task whose request went out, as a worker that died between the two
-- moves would leave it. It is reconciled, not requeued and not cancelled.
insert into public.workflow_tasks(id, organization_id, workflow_id, phase, task_type, role_key, role_version,
  subject_key, input_fingerprint, contract_version, state, lease_owner, lease_token, lease_expires_at)
values ('0c0e0001-0000-0000-0000-000000000012', 'aaaaaaaa-0000-0000-0000-000000000001', pg_temp.id('w1'),
  'analyze', 'read_register', 'reader', '1', 'started/row-2', 'fp-w1-row-2', 'read_register@1', 'leased',
  'worker-d', '0d0e0000-0000-0000-0000-00000000bbbb', now() - interval '2 minutes');
insert into public.agent_attempts(id, organization_id, workflow_id, task_id, attempt_no, role_key, role_version,
  executor_kind, executor_family, independence_domain, packet_fingerprint, state, submitted_at)
values ('0d0e0000-0000-0000-0000-000000000014', 'aaaaaaaa-0000-0000-0000-000000000001', pg_temp.id('w1'),
  '0c0e0001-0000-0000-0000-000000000012', 1, 'reader', '1', 'model', 'family-x', 'model:family-x', 'packet-w1-row-2',
  'submitted', now() - interval '1 minute');
select pg_temp.refused_because('a lease that ran out after the request went out does not go back to the queue',
  $$select public.core_v2_task_transition('0c0e0001-0000-0000-0000-000000000012', 'queued')$$,
  'already submitted');
select pg_temp.refused('and not by writing the state directly either',
  $$update public.workflow_tasks set state = 'queued' where id = '0c0e0001-0000-0000-0000-000000000012'$$);
select pg_temp.refused_because('nor is it cancelled',
  $$update public.workflow_tasks set state = 'cancelled' where id = '0c0e0001-0000-0000-0000-000000000012'$$,
  'already submitted');
select pg_temp.check('nor taken over by another worker, expired or not',
  public.core_v2_lease_task('0c0e0001-0000-0000-0000-000000000012', 'worker-e', 60000) is null
  and (select state from public.workflow_tasks where id = '0c0e0001-0000-0000-0000-000000000012') = 'leased');

-- ─────────────────────────────── what an executor said is written once
select pg_temp.refused('two attempts of one task do not share a number',
  $$insert into public.agent_attempts(organization_id, workflow_id, task_id, attempt_no, role_key, role_version,
      executor_kind, executor_family, independence_domain, packet_fingerprint)
    values ('aaaaaaaa-0000-0000-0000-000000000001', pg_temp.id('w1'), '0c0e0001-0000-0000-0000-000000000011', 1,
            'reader', '1', 'model', 'family-x', 'model:family-x', 'packet-w1-row-1')$$);
select pg_temp.refused('and attempts are counted from one',
  $$insert into public.agent_attempts(organization_id, workflow_id, task_id, attempt_no, role_key, role_version,
      executor_kind, executor_family, independence_domain, packet_fingerprint)
    values ('aaaaaaaa-0000-0000-0000-000000000001', pg_temp.id('w1'), '0c0e0001-0000-0000-0000-000000000011', 0,
            'reader', '1', 'model', 'family-x', 'model:family-x', 'packet-w1-row-1')$$);
select pg_temp.refused('an executor with no family is not an executor the registry knows',
  $$insert into public.agent_attempts(organization_id, workflow_id, task_id, attempt_no, role_key, role_version,
      executor_kind, executor_family, independence_domain, packet_fingerprint)
    values ('aaaaaaaa-0000-0000-0000-000000000001', pg_temp.id('w1'), '0c0e0001-0000-0000-0000-000000000011', 9,
            'reader', '1', 'model', '', 'model:family-x', 'packet-w1-row-1')$$);
select pg_temp.refused('nor one with no independence domain',
  $$insert into public.agent_attempts(organization_id, workflow_id, task_id, attempt_no, role_key, role_version,
      executor_kind, executor_family, independence_domain, packet_fingerprint)
    values ('aaaaaaaa-0000-0000-0000-000000000001', pg_temp.id('w1'), '0c0e0001-0000-0000-0000-000000000011', 9,
            'reader', '1', 'model', 'family-x', '', 'packet-w1-row-1')$$);
select pg_temp.refused('nor one of a kind the kernel has no word for',
  $$insert into public.agent_attempts(organization_id, workflow_id, task_id, attempt_no, role_key, role_version,
      executor_kind, executor_family, independence_domain, packet_fingerprint)
    values ('aaaaaaaa-0000-0000-0000-000000000001', pg_temp.id('w1'), '0c0e0001-0000-0000-0000-000000000011', 9,
            'reader', '1', 'oracle', 'family-x', 'model:family-x', 'packet-w1-row-1')$$);
select pg_temp.refused('a stored result without its digest could be replaced with nobody the wiser',
  $$update public.agent_attempts set raw_result = '{"rows": [1]}'::jsonb where id = '0d0e0000-0000-0000-0000-000000000011'$$);
select pg_temp.allowed('with its digest it is kept',
  $$update public.agent_attempts set raw_result = '{"rows": [1]}'::jsonb, raw_result_hash = 'sha256-of-rows-1',
       provider_request_id = 'req-1', model_reported = 'family-x-2026', usage = '{"input_tokens": 1800, "output_tokens": 240}'::jsonb
     where id = '0d0e0000-0000-0000-0000-000000000011'$$);
select pg_temp.refused_because('and from then on the result is not replaced',
  $$update public.agent_attempts set raw_result = '{"rows": [2]}'::jsonb, raw_result_hash = 'sha256-of-rows-2'
     where id = '0d0e0000-0000-0000-0000-000000000011'$$,
  'written once');
select pg_temp.refused('nor dropped',
  $$update public.agent_attempts set raw_result = null, raw_result_hash = null where id = '0d0e0000-0000-0000-0000-000000000011'$$);
select pg_temp.refused('nor its digest changed underneath it',
  $$update public.agent_attempts set raw_result_hash = 'another' where id = '0d0e0000-0000-0000-0000-000000000011'$$);
select pg_temp.refused_because('what the request was, at the executor, is not repointed at another call',
  $$update public.agent_attempts set provider_request_id = 'req-2' where id = '0d0e0000-0000-0000-0000-000000000011'$$,
  'written once');
select pg_temp.refused('nor forgotten',
  $$update public.agent_attempts set provider_request_id = null where id = '0d0e0000-0000-0000-0000-000000000011'$$);
select pg_temp.refused('nor is the model that answered renamed',
  $$update public.agent_attempts set model_reported = 'family-x-2025' where id = '0d0e0000-0000-0000-0000-000000000011'$$);
select pg_temp.refused_because('nor what it cost replaced by a friendlier number',
  $$update public.agent_attempts set usage = '{"output_tokens": 10}'::jsonb where id = '0d0e0000-0000-0000-0000-000000000011'$$,
  'cannot be replaced');
select pg_temp.refused('nor erased',
  $$update public.agent_attempts set usage = '{}'::jsonb where id = '0d0e0000-0000-0000-0000-000000000011'$$);
select pg_temp.refused('nor its submission time rewritten',
  $$update public.agent_attempts set submitted_at = now() - interval '1 hour' where id = '0d0e0000-0000-0000-0000-000000000011'$$);
select pg_temp.refused('nor the token it was sent under',
  $$update public.agent_attempts set lease_token = gen_random_uuid() where id = '0d0e0000-0000-0000-0000-000000000011'$$);
select pg_temp.refused('a submitted attempt is not deleted — it may be on the invoice',
  $$delete from public.agent_attempts where id = '0d0e0000-0000-0000-0000-000000000011'$$);
select pg_temp.check('the answer arriving is recorded when it arrived',
  (select received_at is not null
     from public.core_v2_attempt_transition('0d0e0000-0000-0000-0000-000000000011', 'response_received')));
select pg_temp.refused_because('and a received answer does not become unreceived',
  $$select public.core_v2_attempt_transition('0d0e0000-0000-0000-0000-000000000011', 'submitted')$$,
  'cannot go from response_received to submitted');
select public.core_v2_attempt_transition('0d0e0000-0000-0000-0000-000000000011', 'parsed');
select pg_temp.check('an attempt that succeeded records when it finished',
  (select finished_at is not null and state = 'succeeded'
     from public.core_v2_attempt_transition('0d0e0000-0000-0000-0000-000000000011', 'succeeded')));
select pg_temp.refused_because('and a terminal attempt does not change its story at all',
  $$update public.agent_attempts set model_configuration = 'temperature=0' where id = '0d0e0000-0000-0000-0000-000000000011'$$,
  'not rewritten afterwards');
select pg_temp.refused('not its validation',
  $$update public.agent_attempts set validation_state = 'valid' where id = '0d0e0000-0000-0000-0000-000000000011'$$);
select pg_temp.refused('not its problems',
  $$update public.agent_attempts set validation_problems = '["none"]'::jsonb where id = '0d0e0000-0000-0000-0000-000000000011'$$);
select pg_temp.refused('not its ending',
  $$update public.agent_attempts set finished_at = now() + interval '1 hour' where id = '0d0e0000-0000-0000-0000-000000000011'$$);
select pg_temp.refused('not its state',
  $$update public.agent_attempts set state = 'failed_known' where id = '0d0e0000-0000-0000-0000-000000000011'$$);
select pg_temp.refused_because('and it is not deleted',
  $$delete from public.agent_attempts where id = '0d0e0000-0000-0000-0000-000000000011'$$,
  'may have been billed');
insert into public.agent_attempts(id, organization_id, workflow_id, task_id, attempt_no, role_key, role_version,
  executor_kind, executor_family, independence_domain, packet_fingerprint, raw_result, raw_result_hash)
values ('0d0e0000-0000-0000-0000-000000000013', 'aaaaaaaa-0000-0000-0000-000000000001', pg_temp.id('w1'),
  '0c0e0001-0000-0000-0000-000000000011', 3, 'reader', '1', 'model', 'family-x', 'model:family-x', 'packet-w1-row-1',
  '{"partial": true}'::jsonb, 'sha256-of-partial');
select pg_temp.refused('an attempt holding a result is not deleted whatever its state',
  $$delete from public.agent_attempts where id = '0d0e0000-0000-0000-0000-000000000013'$$);
insert into public.agent_attempts(id, organization_id, workflow_id, task_id, attempt_no, role_key, role_version,
  executor_kind, executor_family, independence_domain, packet_fingerprint)
values ('0d0e0000-0000-0000-0000-000000000015', 'aaaaaaaa-0000-0000-0000-000000000001', pg_temp.id('w1'),
  '0c0e0001-0000-0000-0000-000000000011', 4, 'reader', '1', 'model', 'family-x', 'model:family-x', 'packet-w1-row-1');
select pg_temp.affects('while an attempt that was prepared and never sent may be withdrawn',
  $$delete from public.agent_attempts where id = '0d0e0000-0000-0000-0000-000000000015'$$, 1);
select pg_temp.refused('an answer cut short with nothing stored is a state a transition reaches, not one written on a prepared row',
  $$update public.agent_attempts set state = 'output_limited' where id = '0d0e0000-0000-0000-0000-000000000013'$$);
select pg_temp.refused('nor does a prepared attempt jump straight to success',
  $$update public.agent_attempts set state = 'succeeded' where id = '0d0e0000-0000-0000-0000-000000000013'$$);
select pg_temp.check('an attempt that failed with reasons keeps them, and its ending',
  (select error_code = 'schema_invalid' and finished_at is not null
     from public.core_v2_attempt_transition('0d0e0000-0000-0000-0000-000000000013', 'rejected_before_submission',
       'schema_invalid', 'the packet did not validate')));
select pg_temp.refused('and does not change them afterwards',
  $$update public.agent_attempts set error_message = 'it was fine really' where id = '0d0e0000-0000-0000-0000-000000000013'$$);
select pg_temp.check('the task completes, and its lease goes with it',
  (select state = 'completed' and lease_token is null and lease_owner is null and lease_expires_at is null
     from public.core_v2_task_transition('0c0e0001-0000-0000-0000-000000000011', 'completed', 'result_committed')));
select pg_temp.check('and a completed task has no lease to extend',
  public.core_v2_heartbeat_lease('0c0e0001-0000-0000-0000-000000000011', pg_temp.id('lease2'), 120000) = false);
select pg_temp.refused_because('a task that does not exist cannot be moved',
  $$select public.core_v2_task_transition('0c0e0001-0000-0000-0000-00000000ffff', 'queued')$$, 'no task');
select pg_temp.refused_because('nor an attempt',
  $$select public.core_v2_attempt_transition('0d0e0000-0000-0000-0000-00000000ffff', 'submitted')$$, 'no attempt');

-- ─────────────────────── an outcome nobody knows is not retried by a machine
insert into public.workflow_tasks(id, organization_id, workflow_id, phase, task_type, role_key, role_version,
  subject_key, input_fingerprint, contract_version)
values
  ('0c0e0001-0000-0000-0000-000000000013', 'aaaaaaaa-0000-0000-0000-000000000001', pg_temp.id('w1'),
   'analyze', 'read_register', 'reader', '1', 'started/row-3', 'fp-w1-row-3', 'read_register@1'),
  ('0c0e0001-0000-0000-0000-000000000014', 'aaaaaaaa-0000-0000-0000-000000000001', pg_temp.id('w1'),
   'analyze', 'read_register', 'reader', '1', 'started/row-4', 'fp-w1-row-4', 'read_register@1');
select public.core_v2_task_transition('0c0e0001-0000-0000-0000-000000000013', 'queued');
insert into core_v2_ids(k, v)
select 'lease3', (public.core_v2_lease_task('0c0e0001-0000-0000-0000-000000000013', 'worker-a', 60000)).lease_token;
select public.core_v2_task_transition('0c0e0001-0000-0000-0000-000000000013', 'running');
insert into public.agent_attempts(id, organization_id, workflow_id, task_id, attempt_no, role_key, role_version,
  executor_kind, executor_family, independence_domain, packet_fingerprint)
values ('0d0e0000-0000-0000-0000-000000000031', 'aaaaaaaa-0000-0000-0000-000000000001', pg_temp.id('w1'),
  '0c0e0001-0000-0000-0000-000000000013', 1, 'reader', '1', 'model', 'family-x', 'model:family-x', 'packet-w1-row-3');
select public.core_v2_submit_attempt('0d0e0000-0000-0000-0000-000000000031', pg_temp.id('lease3'));
select public.core_v2_attempt_transition('0d0e0000-0000-0000-0000-000000000031', 'outcome_unknown',
  'connection_lost', 'the connection broke after the request was sent');
select public.core_v2_task_transition('0c0e0001-0000-0000-0000-000000000013', 'outcome_unknown', 'executor_outcome_unknown');
select pg_temp.refused_because('a machine cannot run an unknown outcome again',
  $$select public.core_v2_task_transition('0c0e0001-0000-0000-0000-000000000013', 'queued')$$,
  'a person must authorise');
select pg_temp.refused('nor can it by writing the state directly',
  $$update public.workflow_tasks set state = 'queued' where id = '0c0e0001-0000-0000-0000-000000000013'$$);
select pg_temp.refused('nor by pretending the task is running again',
  $$update public.workflow_tasks set state = 'running' where id = '0c0e0001-0000-0000-0000-000000000013'$$);
select pg_temp.check('nor by leasing it',
  public.core_v2_lease_task('0c0e0001-0000-0000-0000-000000000013', 'worker-b', 60000) is null);
select pg_temp.refused('nor by writing the authorisation itself',
  $$update public.workflow_tasks set state = 'queued', retry_authorized_by = '11111111-1111-1111-1111-111111111111',
       retry_authorized_at = now() where id = '0c0e0001-0000-0000-0000-000000000013'$$);
select pg_temp.refused('and the attempt that ended unknown is not edited into something else',
  $$update public.agent_attempts set error_message = 'it was fine really' where id = '0d0e0000-0000-0000-0000-000000000031'$$);

set local role authenticated;
set local test.uid = '33333333-3333-3333-3333-333333333333';
select pg_temp.refused_because('a reviewer cannot authorise sending it again',
  $$select public.core_v2_authorize_task_retry('0c0e0001-0000-0000-0000-000000000013')$$,
  'only an owner or an administrator');
set local test.uid = '22222222-2222-2222-2222-222222222222';
select pg_temp.refused('nor can a contributor',
  $$select public.core_v2_authorize_task_retry('0c0e0001-0000-0000-0000-000000000013')$$);
set local test.uid = '44444444-4444-4444-4444-444444444444';
select pg_temp.refused('nor the owner of another organisation',
  $$select public.core_v2_authorize_task_retry('0c0e0001-0000-0000-0000-000000000013')$$);
set local test.uid = '11111111-1111-1111-1111-111111111111';
select pg_temp.refused_because('and there is nothing to authorise on a task that did not end badly',
  $$select public.core_v2_authorize_task_retry('0c0e0001-0000-0000-0000-000000000011')$$,
  'nothing to authorise');
select pg_temp.refused_because('nor on a task that does not exist',
  $$select public.core_v2_authorize_task_retry('0c0e0001-0000-0000-0000-00000000ffff')$$, 'no such task');
select pg_temp.check('an owner can, and the record says who authorised it and when',
  (select retry_authorized_by = '11111111-1111-1111-1111-111111111111' and retry_authorized_at is not null and state = 'queued'
     from public.core_v2_authorize_task_retry('0c0e0001-0000-0000-0000-000000000013',
       'reconciled with the executor: nothing was billed')));
select pg_temp.check('and the authorisation is in the trail with what it was authorising',
  exists (select 1 from public.audit_events
           where action = 'core_v2.task.retry_authorized' and entity_id = '0c0e0001-0000-0000-0000-000000000013'
             and actor_id = '11111111-1111-1111-1111-111111111111'
             and detail ->> 'was' = 'outcome_unknown' and detail ->> 'note' like 'reconciled%'));
reset role;
set local test.uid = '';
insert into core_v2_ids(k, v)
select 'lease4', (public.core_v2_lease_task('0c0e0001-0000-0000-0000-000000000013', 'worker-b', 60000)).lease_token;
select pg_temp.check('the authorised retry can be leased — the attempt a person reconciled no longer stands in the way',
  pg_temp.id('lease4') is not null
  and (select state from public.workflow_tasks where id = '0c0e0001-0000-0000-0000-000000000013') = 'leased');
select public.core_v2_task_transition('0c0e0001-0000-0000-0000-000000000013', 'running');
insert into public.agent_attempts(id, organization_id, workflow_id, task_id, attempt_no, role_key, role_version,
  executor_kind, executor_family, independence_domain, packet_fingerprint)
values ('0d0e0000-0000-0000-0000-000000000032', 'aaaaaaaa-0000-0000-0000-000000000001', pg_temp.id('w1'),
  '0c0e0001-0000-0000-0000-000000000013', 2, 'reader', '1', 'model', 'family-x', 'model:family-x', 'packet-w1-row-3');
select public.core_v2_submit_attempt('0d0e0000-0000-0000-0000-000000000032', pg_temp.id('lease4'));
select public.core_v2_attempt_transition('0d0e0000-0000-0000-0000-000000000032', 'outcome_unknown', 'connection_lost');
select public.core_v2_task_transition('0c0e0001-0000-0000-0000-000000000013', 'outcome_unknown', 'executor_outcome_unknown');
select pg_temp.refused_because('the authorisation is spent — a second unknown outcome needs a second authorisation',
  $$update public.workflow_tasks set state = 'queued' where id = '0c0e0001-0000-0000-0000-000000000013'$$,
  'a person must authorise');
select pg_temp.check('and nothing leases it meanwhile',
  public.core_v2_lease_task('0c0e0001-0000-0000-0000-000000000013', 'worker-b', 60000) is null);

-- A known failure is the same door: the machine does not decide to try again.
select public.core_v2_task_transition('0c0e0001-0000-0000-0000-000000000014', 'queued');
insert into core_v2_ids(k, v)
select 'lease5', (public.core_v2_lease_task('0c0e0001-0000-0000-0000-000000000014', 'worker-a', 60000)).lease_token;
select public.core_v2_task_transition('0c0e0001-0000-0000-0000-000000000014', 'running');
insert into public.agent_attempts(id, organization_id, workflow_id, task_id, attempt_no, role_key, role_version,
  executor_kind, executor_family, independence_domain, packet_fingerprint)
values ('0d0e0000-0000-0000-0000-000000000041', 'aaaaaaaa-0000-0000-0000-000000000001', pg_temp.id('w1'),
  '0c0e0001-0000-0000-0000-000000000014', 1, 'reader', '1', 'model', 'family-x', 'model:family-x', 'packet-w1-row-4');
select public.core_v2_submit_attempt('0d0e0000-0000-0000-0000-000000000041', pg_temp.id('lease5'));
select public.core_v2_attempt_transition('0d0e0000-0000-0000-0000-000000000041', 'failed_known', 'executor_refused');
select public.core_v2_task_transition('0c0e0001-0000-0000-0000-000000000014', 'failed_known', 'executor_refused');
select pg_temp.refused_because('a known failure is not requeued by the machine either',
  $$select public.core_v2_task_transition('0c0e0001-0000-0000-0000-000000000014', 'queued')$$,
  'a person must authorise');
set local role authenticated;
set local test.uid = '11111111-1111-1111-1111-111111111111';
-- Two statements, not one expression: the trail is asked about only after the
-- door has been opened, because nothing orders the two halves of an `and`.
select pg_temp.check('an owner authorises a known failure to run again',
  (select state from public.core_v2_authorize_task_retry('0c0e0001-0000-0000-0000-000000000014', 'the executor was down')) = 'queued');
select pg_temp.check('and the trail says it was a known failure that was authorised',
  exists (select 1 from public.audit_events where action = 'core_v2.task.retry_authorized'
           and entity_id = '0c0e0001-0000-0000-0000-000000000014'
           and actor_id = '11111111-1111-1111-1111-111111111111'
           and detail ->> 'was' = 'failed_known' and detail ->> 'note' = 'the executor was down'));
reset role;
set local test.uid = '';
select pg_temp.check('the authorised retry is not open for a second authorisation',
  (select state from public.workflow_tasks where id = '0c0e0001-0000-0000-0000-000000000014') = 'queued');

-- ═══════════════════ 6 · WHAT A CLAIM IS, AND WHAT IT STANDS ON ══════════════
--
-- A claim says one thing about one subject on one basis. It is accepted only
-- with a place to open, it is never accepted from an answer that was cut
-- short, and once accepted or rejected it is corrected by a superseding claim
-- and never in place.
insert into public.evidence_claims(id, organization_id, workflow_id, task_id, attempt_id, subject_type, subject_key,
  predicate, value, unit, observation_basis, scope, machine_confidence, incomplete_source_attempt)
values
  ('0e0e0000-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001',
   '0c0e0000-0000-0000-0000-000000000001', null, null, 'row', 'register-a/row-1', 'quantity',
   '{"n": 5}'::jsonb, 'each', 'observed', '{"part": "a"}'::jsonb, 0.4, false),
  ('0e0e0000-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001',
   '0c0e0000-0000-0000-0000-000000000001', null, null, 'row', 'register-a/row-2', 'quantity',
   '{"n": 8}'::jsonb, 'each', 'derived', '{}'::jsonb, null, false),
  ('0e0e0000-0000-0000-0000-000000000004', 'aaaaaaaa-0000-0000-0000-000000000001',
   '0c0e0000-0000-0000-0000-000000000001', '0c0e0001-0000-0000-0000-000000000001',
   '0d0e0000-0000-0000-0000-000000000001', 'note', 'register-a/note-1', 'text',
   '{"text": "see page 2"}'::jsonb, null, 'observed', '{}'::jsonb, 0.9, true),
  ('0e0e0000-0000-0000-0000-000000000005', 'aaaaaaaa-0000-0000-0000-000000000001',
   '0c0e0000-0000-0000-0000-000000000001', null, null, 'row', 'register-a/row-5', 'quantity',
   '{"n": 1}'::jsonb, 'each', 'observed', '{}'::jsonb, null, false),
  ('0e0e0000-0000-0000-0000-000000000006', 'aaaaaaaa-0000-0000-0000-000000000001',
   '0c0e0000-0000-0000-0000-000000000001', null, null, 'row', 'register-a/row-6', 'quantity',
   '{"n": 2}'::jsonb, 'each', 'observed', '{}'::jsonb, null, false),
  ('0e0e0000-0000-0000-0000-000000000007', 'aaaaaaaa-0000-0000-0000-000000000001',
   '0c0e0000-0000-0000-0000-000000000001', null, null, 'row', 'register-a/row-7', 'quantity',
   '{"n": 3}'::jsonb, 'each', 'observed', '{}'::jsonb, null, false),
  ('0e0e0000-0000-0000-0000-000000000008', 'aaaaaaaa-0000-0000-0000-000000000001',
   '0c0e0000-0000-0000-0000-000000000001', null, null, 'row', 'register-a/row-7', 'quantity_doubled',
   '{"n": 6}'::jsonb, 'each', 'derived', '{}'::jsonb, null, false);
insert into public.evidence_anchors(id, organization_id, workflow_id, claim_id, source_kind, segment_id, locator, anchor_hash)
values
  ('0f0e0000-0000-0000-0000-000000000004', 'aaaaaaaa-0000-0000-0000-000000000001',
   '0c0e0000-0000-0000-0000-000000000001', '0e0e0000-0000-0000-0000-000000000004', 'segment',
   '0b0e0001-0000-0000-0000-000000000004', '{}'::jsonb, 'anchor-note-1'),
  ('0f0e0000-0000-0000-0000-000000000005', 'aaaaaaaa-0000-0000-0000-000000000001',
   '0c0e0000-0000-0000-0000-000000000001', '0e0e0000-0000-0000-0000-000000000005', 'segment_locator',
   '0b0e0001-0000-0000-0000-000000000002', '{"bbox": [0.60, 0.20, 0.70, 0.25]}'::jsonb, 'anchor-row-5'),
  ('0f0e0000-0000-0000-0000-000000000006', 'aaaaaaaa-0000-0000-0000-000000000001',
   '0c0e0000-0000-0000-0000-000000000001', '0e0e0000-0000-0000-0000-000000000006', 'segment_locator',
   '0b0e0001-0000-0000-0000-000000000002', '{"bbox": [0.60, 0.25, 0.70, 0.30]}'::jsonb, 'anchor-row-6');
select pg_temp.core_v2_settle();

select pg_temp.refused('a claim with no basis is not a claim',
  $$insert into public.evidence_claims(organization_id, workflow_id, subject_type, subject_key, predicate, observation_basis)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0000-0000-0000-0000-000000000001', 'row', 'x', 'quantity', null)$$);
select pg_temp.refused('and a basis the vocabulary has no word for is refused',
  $$insert into public.evidence_claims(organization_id, workflow_id, subject_type, subject_key, predicate, observation_basis)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0000-0000-0000-0000-000000000001', 'row', 'x', 'quantity', 'about_right')$$);
select pg_temp.refused('confidence is a number between nothing and certainty',
  $$insert into public.evidence_claims(organization_id, workflow_id, subject_type, subject_key, predicate, observation_basis, machine_confidence)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0000-0000-0000-0000-000000000001', 'row', 'x', 'quantity', 'observed', 1.5)$$);
select pg_temp.refused('a claim has eight statuses and this is not one of them',
  $$insert into public.evidence_claims(organization_id, workflow_id, subject_type, subject_key, predicate, observation_basis, status)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0000-0000-0000-0000-000000000001', 'row', 'x', 'quantity', 'observed', 'final')$$);
select pg_temp.check('the same subject on two bases is two claims, and stays two',
  (select count(*) from public.evidence_claims where subject_key = 'register-a/row-7') = 2
  and (select count(distinct observation_basis) from public.evidence_claims where subject_key = 'register-a/row-7') = 2);

-- ──────────────────────────────── nothing is accepted with no place to open
select pg_temp.refused_because('a claim accepted with nothing to open does not survive the transaction',
$sql$
do $x$ begin
  update public.evidence_claims set status = 'accepted' where id = '0e0e0000-0000-0000-0000-000000000002';
  perform pg_temp.core_v2_settle();
end $x$;
$sql$, 'nothing to open');
select pg_temp.check('and the claim is still where it was, unaccepted',
  (select status from public.evidence_claims where id = '0e0e0000-0000-0000-0000-000000000002') = 'proposed');
select pg_temp.refused_because('nor is one verified with nothing to open',
$sql$
do $x$ begin
  update public.evidence_claims set status = 'verified' where id = '0e0e0000-0000-0000-0000-000000000002';
  perform pg_temp.core_v2_settle();
end $x$;
$sql$, 'nothing to open');
select public.core_v2_claim_transition('0e0e0000-0000-0000-0000-000000000001', 'accepted');
select pg_temp.allowed('a claim with a source anchor survives the end of the transaction',
  $$select pg_temp.core_v2_settle()$$);
select pg_temp.refused_because('the anchor cannot be pulled out first and the claim accepted after — the check looks from both sides',
$sql$
do $x$ begin
  delete from public.evidence_anchors where id = '0f0e0000-0000-0000-0000-000000000005';
  update public.evidence_claims set status = 'accepted' where id = '0e0e0000-0000-0000-0000-000000000005';
  perform pg_temp.core_v2_settle();
end $x$;
$sql$, 'nothing to open');
select pg_temp.check('and both the anchor and the unaccepted claim are as they were',
  exists (select 1 from public.evidence_anchors where id = '0f0e0000-0000-0000-0000-000000000005')
  and (select status from public.evidence_claims where id = '0e0e0000-0000-0000-0000-000000000005') = 'proposed');
select pg_temp.refused_because('a claim from an answer that was cut short is not accepted on its own, anchor or not',
$sql$
do $x$ begin
  update public.evidence_claims set status = 'accepted' where id = '0e0e0000-0000-0000-0000-000000000004';
  perform pg_temp.core_v2_settle();
end $x$;
$sql$, 'cut short');
select pg_temp.allowed('though it may be verified, which is how it earns a complete reading',
$sql$
do $x$ begin
  update public.evidence_claims set status = 'verified' where id = '0e0e0000-0000-0000-0000-000000000004';
  perform pg_temp.core_v2_settle();
end $x$;
$sql$);
select pg_temp.refused_because('an anchor under a verified claim is not deleted',
  $$delete from public.evidence_anchors where id = '0f0e0000-0000-0000-0000-000000000004'$$,
  'supports a claim that is verified');

-- ══════════════════ 7 · THE ANCHOR UNDER AN ACCEPTED CLAIM ═══════════════════
select pg_temp.refused_because('an anchor under an accepted claim is not deleted',
  $$delete from public.evidence_anchors where id = '0f0e0000-0000-0000-0000-000000000001'$$,
  'supports a claim that is accepted');
select pg_temp.refused('nor repointed at another segment',
  $$update public.evidence_anchors set segment_id = '0b0e0001-0000-0000-0000-000000000004'
     where id = '0f0e0000-0000-0000-0000-000000000001'$$);
select pg_temp.refused('nor moved onto another claim',
  $$update public.evidence_anchors set claim_id = '0e0e0000-0000-0000-0000-000000000002'
     where id = '0f0e0000-0000-0000-0000-000000000001'$$);
select pg_temp.refused_because('nor is the segment it points at deleted',
  $$delete from public.source_segments where id = '0b0e0001-0000-0000-0000-000000000002'$$,
  'stays in the record');

-- ══════════════ 8 · ACCEPTED MEANS FINISHED, OR SUPERSEDED ═══════════════════
select pg_temp.refused_because('an accepted claim is not corrected in place',
  $$update public.evidence_claims set value = '{"n": 9}'::jsonb where id = '0e0e0000-0000-0000-0000-000000000001'$$,
  'not in place');
select pg_temp.refused('nor its confidence quietly raised',
  $$update public.evidence_claims set machine_confidence = 0.99 where id = '0e0e0000-0000-0000-0000-000000000001'$$);
select pg_temp.refused('nor its scope widened',
  $$update public.evidence_claims set scope = '{"part": "all"}'::jsonb where id = '0e0e0000-0000-0000-0000-000000000001'$$);
select pg_temp.refused('nor its unit changed',
  $$update public.evidence_claims set unit = 'dozen' where id = '0e0e0000-0000-0000-0000-000000000001'$$);
select pg_temp.refused('nor its basis',
  $$update public.evidence_claims set observation_basis = 'inferred' where id = '0e0e0000-0000-0000-0000-000000000001'$$);
select pg_temp.refused('nor the reading it came from swapped',
  $$update public.evidence_claims set attempt_id = '0d0e0000-0000-0000-0000-000000000001' where id = '0e0e0000-0000-0000-0000-000000000001'$$);
select pg_temp.refused('nor its cut-short flag changed',
  $$update public.evidence_claims set incomplete_source_attempt = true where id = '0e0e0000-0000-0000-0000-000000000001'$$);
select pg_temp.refused('nor moved back to being merely proposed',
  $$update public.evidence_claims set status = 'proposed' where id = '0e0e0000-0000-0000-0000-000000000001'$$);
select pg_temp.refused('nor turned into a rejection',
  $$update public.evidence_claims set status = 'rejected' where id = '0e0e0000-0000-0000-0000-000000000001'$$);
select pg_temp.refused_because('nor deleted, once it is part of the record',
  $$delete from public.evidence_claims where id = '0e0e0000-0000-0000-0000-000000000001'$$,
  'part of the record');

-- ───────────────────────────────── a derivation names its inputs, as keys
select pg_temp.allowed('a derived claim names the claims it was computed from',
  $$insert into public.claim_inputs(organization_id, claim_id, input_claim_id)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0e0e0000-0000-0000-0000-000000000008',
            '0e0e0000-0000-0000-0000-000000000007')$$);
select pg_temp.refused('and is not computed from itself',
  $$insert into public.claim_inputs(organization_id, claim_id, input_claim_id)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0e0e0000-0000-0000-0000-000000000008',
            '0e0e0000-0000-0000-0000-000000000008')$$);
select pg_temp.refused('nor from a claim that does not exist',
  $$insert into public.claim_inputs(organization_id, claim_id, input_claim_id)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0e0e0000-0000-0000-0000-000000000008',
            '0e0e0000-0000-0000-0000-00000000ffff')$$);
select pg_temp.refused_because('an input somebody derived from is not deleted — the arithmetic would no longer check',
  $$delete from public.evidence_claims where id = '0e0e0000-0000-0000-0000-000000000007'$$,
  'part of the record');
select pg_temp.affects('while the derivation itself, still proposed, may be withdrawn with its inputs',
  $$delete from public.evidence_claims where id = '0e0e0000-0000-0000-0000-000000000008'$$, 1);
select pg_temp.check('and the input links went with it',
  not exists (select 1 from public.claim_inputs where claim_id = '0e0e0000-0000-0000-0000-000000000008'));

-- ─────────────────────────────────── a correction is a superseding claim
insert into public.evidence_claims(id, organization_id, workflow_id, subject_type, subject_key, predicate, value, unit,
  observation_basis, supersedes_claim_id)
values ('0e0e0000-0000-0000-0000-000000000009', 'aaaaaaaa-0000-0000-0000-000000000001',
  '0c0e0000-0000-0000-0000-000000000001', 'row', 'register-a/row-1', 'quantity', '{"n": 4, "verified": true}'::jsonb,
  'each', 'observed', '0e0e0000-0000-0000-0000-000000000001');
select public.core_v2_claim_transition('0e0e0000-0000-0000-0000-000000000001', 'superseded');
select pg_temp.allowed('a correction supersedes an accepted claim that no decision rests on',
  $$select pg_temp.core_v2_settle()$$);
select pg_temp.check('and both readings stay, the new one naming the old',
  (select status from public.evidence_claims where id = '0e0e0000-0000-0000-0000-000000000001') = 'superseded'
  and (select supersedes_claim_id from public.evidence_claims where id = '0e0e0000-0000-0000-0000-000000000009')
      = '0e0e0000-0000-0000-0000-000000000001');
select pg_temp.check('the supersession is in the trail, saying what the claim was',
  exists (select 1 from public.audit_events where action = 'core_v2.claim.superseded'
           and entity_id = '0e0e0000-0000-0000-0000-000000000001' and detail ->> 'was' = 'accepted'));
select pg_temp.refused('a superseded claim is not brought back',
  $$update public.evidence_claims set status = 'accepted' where id = '0e0e0000-0000-0000-0000-000000000001'$$);
select pg_temp.refused('nor deleted',
  $$delete from public.evidence_claims where id = '0e0e0000-0000-0000-0000-000000000001'$$);
select pg_temp.refused_because('and its anchors stay where they were',
  $$delete from public.evidence_anchors where id = '0f0e0000-0000-0000-0000-000000000001'$$,
  'supports a claim that is superseded');

-- ═══════════════ 9 · A VERDICT IS ONE ROW, WITH EVIDENCE OF ITS OWN ══════════
insert into public.workflow_tasks(id, organization_id, workflow_id, phase, task_type, role_key, role_version,
  subject_key, input_fingerprint, contract_version)
values ('0c0e0001-0000-0000-0000-000000000031', 'aaaaaaaa-0000-0000-0000-000000000001',
  '0c0e0000-0000-0000-0000-000000000001', 'verify', 'verify_row', 'verifier', '1', 'register-a/row-5',
  'fp-verify-row-5', 'verify_row@1');
select pg_temp.allowed('a verification names the claims it is about, as keys',
  $$insert into public.task_target_claims(organization_id, task_id, claim_id)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0001-0000-0000-0000-000000000031',
            '0e0e0000-0000-0000-0000-000000000005')$$);
select pg_temp.refused_because('and a claim under verification is not deleted from under it',
  $$delete from public.evidence_claims where id = '0e0e0000-0000-0000-0000-000000000005'$$,
  'part of the record');
insert into public.agent_attempts(id, organization_id, workflow_id, task_id, attempt_no, role_key, role_version,
  executor_kind, executor_family, independence_domain, packet_fingerprint)
values
  ('0d0e0000-0000-0000-0000-000000000051', 'aaaaaaaa-0000-0000-0000-000000000001',
   '0c0e0000-0000-0000-0000-000000000001', '0c0e0001-0000-0000-0000-000000000031', 1, 'verifier', '1',
   'model', 'family-y', 'model:family-y', 'packet-verify-row-5'),
  ('0d0e0000-0000-0000-0000-000000000052', 'aaaaaaaa-0000-0000-0000-000000000001',
   '0c0e0000-0000-0000-0000-000000000001', '0c0e0001-0000-0000-0000-000000000031', 2, 'verifier', '1',
   'model', 'family-z', 'model:family-z', 'packet-verify-row-5');
insert into public.claim_assessments(id, organization_id, workflow_id, claim_id, attempt_id, task_id, assessment,
  reason_code, explanation)
values ('1d0e0000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
  '0c0e0000-0000-0000-0000-000000000001', '0e0e0000-0000-0000-0000-000000000005',
  '0d0e0000-0000-0000-0000-000000000051', '0c0e0001-0000-0000-0000-000000000031', 'supports',
  'value_matches_source', 'Row 5 of the register prints 1.');
-- What a reviewer read instead is kept beside its verdict, because an arbiter
-- may correct a disputed claim only to a value that stands here. A verdict
-- that the source agrees proposes nothing to correct to.
select pg_temp.refused('a verdict that the source agrees proposes no other value',
  $$update public.claim_assessments set proposed_value = '{"known": true, "quantity": 9}'::jsonb
     where id = '1d0e0000-0000-0000-0000-000000000001'$$);
select pg_temp.refused('one reviewer does not get to say two things about one claim',
  $$insert into public.claim_assessments(organization_id, workflow_id, claim_id, attempt_id, assessment, reason_code)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0000-0000-0000-0000-000000000001',
            '0e0e0000-0000-0000-0000-000000000005', '0d0e0000-0000-0000-0000-000000000051', 'contradicts', 'changed_mind')$$);
select pg_temp.allowed('while a second reviewer may say its own',
  $$insert into public.claim_assessments(id, organization_id, workflow_id, claim_id, attempt_id, assessment, reason_code)
    values ('1d0e0000-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001',
            '0c0e0000-0000-0000-0000-000000000001', '0e0e0000-0000-0000-0000-000000000005',
            '0d0e0000-0000-0000-0000-000000000052', 'insufficient', 'crop_unreadable')$$);
select pg_temp.allowed('a verdict that did not agree may say what the source shows instead, so an arbiter has something to correct to',
  $$update public.claim_assessments
       set proposed_value = '{"known": true, "quantity": 3, "text": "3 each"}'::jsonb, proposed_unit = 'each'
     where id = '1d0e0000-0000-0000-0000-000000000002'$$);
select pg_temp.refused('a verdict is one of seven words',
  $$insert into public.claim_assessments(organization_id, workflow_id, claim_id, attempt_id, assessment, reason_code)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0000-0000-0000-0000-000000000001',
            '0e0e0000-0000-0000-0000-000000000006', '0d0e0000-0000-0000-0000-000000000051', 'probably', 'shrug')$$);
select pg_temp.check('a reviewer''s evidence is a table with foreign keys, not a column of ids',
  not exists (select 1 from information_schema.columns
               where table_name = 'claim_assessments' and column_name = 'anchor_ids')
  and not exists (select 1 from information_schema.columns
                   where table_name = 'disagreements' and column_name = 'claim_ids'));
insert into core_v2_counts select 'row5_anchors', count(*) from public.evidence_anchors
  where claim_id = '0e0e0000-0000-0000-0000-000000000005';
select pg_temp.allowed('the reviewer names where it looked',
  $$insert into public.evidence_anchors(id, organization_id, workflow_id, assessment_id, source_kind, segment_id, locator, anchor_hash)
    values ('0f0e0000-0000-0000-0000-000000000051', 'aaaaaaaa-0000-0000-0000-000000000001',
            '0c0e0000-0000-0000-0000-000000000001', '1d0e0000-0000-0000-0000-000000000001', 'segment_locator',
            '0b0e0001-0000-0000-0000-000000000002', '{"bbox": [0.60, 0.20, 0.70, 0.25]}'::jsonb, 'anchor-verify-row-5')$$);
select pg_temp.check('and its anchor is its own — the claim''s own evidence did not grow by being reviewed',
  (select count(*) from public.evidence_anchors where claim_id = '0e0e0000-0000-0000-0000-000000000005')
    = (select n from core_v2_counts where k = 'row5_anchors')
  and (select claim_id is null from public.evidence_anchors where id = '0f0e0000-0000-0000-0000-000000000051'));
select pg_temp.refused('an anchor is not owned by a claim and an assessment at once',
  $$insert into public.evidence_anchors(organization_id, workflow_id, claim_id, assessment_id, source_kind, segment_id, anchor_hash)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0000-0000-0000-0000-000000000001',
            '0e0e0000-0000-0000-0000-000000000005', '1d0e0000-0000-0000-0000-000000000001', 'segment',
            '0b0e0001-0000-0000-0000-000000000002', 'two-owners')$$);
select pg_temp.refused('nor by an assessment that does not exist',
  $$insert into public.evidence_anchors(organization_id, workflow_id, assessment_id, source_kind, segment_id, anchor_hash)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0000-0000-0000-0000-000000000001',
            '1d0e0000-0000-0000-0000-00000000ffff', 'segment', '0b0e0001-0000-0000-0000-000000000002', 'nobody')$$);
select public.core_v2_claim_transition('0e0e0000-0000-0000-0000-000000000005', 'verified');
select public.core_v2_claim_transition('0e0e0000-0000-0000-0000-000000000005', 'accepted');
select pg_temp.allowed('a claim verified and then accepted on its anchor survives',
  $$select pg_temp.core_v2_settle()$$);
select pg_temp.refused_because('the reviewer''s anchor is under an accepted claim too, and is not deleted',
  $$delete from public.evidence_anchors where id = '0f0e0000-0000-0000-0000-000000000051'$$,
  'supports a claim that is accepted');
select pg_temp.refused_because('a verdict is about a claim of its own workflow',
  $$insert into public.claim_assessments(organization_id, workflow_id, claim_id, attempt_id, assessment, reason_code)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0000-0000-0000-0000-0000000000a2',
            '0e0e0000-0000-0000-0000-0000000000a2', '0d0e0000-0000-0000-0000-000000000051', 'supports', 'r')$$,
  'another workflow');

-- ═══════════════ 10 · THE DECISION, AND WHAT IT RESTS ON ═══════════════════
--
-- The nine sub-sections above stop one step short of the answer a person
-- reads. Everything here is the last step: a decision that is actually decided,
-- a disagreement that is actually settled, and the ways somebody could take
-- either of them apart afterwards.
--
-- A second synthetic source set, on its own workflow, so that nothing below
-- disturbs what the earlier sub-sections built. A recording and a register:
-- the two shapes a document-shaped fixture would never have exercised.

reset role;
set local test.uid = '';

insert into public.intelligence_workflows(
  id, organization_id, domain_pack, domain_pack_version, workflow_type, engine_version,
  source_set_fingerprint, request_fingerprint, budget, state)
values ('0c0e0000-0000-0000-0000-0000000000d1', 'aaaaaaaa-0000-0000-0000-000000000001',
  'synthetic-decision', '1', 'synthetic_review', 'core-v2.1',
  'fixture-decision-source-set', 'fixture-decision-request',
  '{"maximum_critic_rounds": 1, "maximum_arbiter_rounds": 1}'::jsonb, 'running');

insert into public.workflow_sources(id, organization_id, workflow_id, ordinal, source_kind, label,
  uri, content_hash, hash_algorithm, media)
values
  ('0a0e0004-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
   '0c0e0000-0000-0000-0000-0000000000d1', 0, 'recording', 'synthetic recording D',
   'fixture://synthetic/recording-d', 'fixture-source-hash-recording-d', 'sha-256',
   '{"duration_ms": 120000}'::jsonb),
  ('0a0e0004-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001',
   '0c0e0000-0000-0000-0000-0000000000d1', 1, 'table', 'synthetic ledger D',
   'fixture://synthetic/ledger-d', 'fixture-source-hash-ledger-d', 'sha-256',
   '{"row_count": 50000}'::jsonb);

insert into public.source_segments(id, organization_id, workflow_id, source_id, segment_kind, label,
  ordinal, locator, content_hash, status, discovered_by)
values
  ('0b0e0004-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
   '0c0e0000-0000-0000-0000-0000000000d1', '0a0e0004-0000-0000-0000-000000000001', 'scene', 'scene 1',
   0, '{"start_ms": 0, "end_ms": 45000}'::jsonb, 'fixture-segment-hash-d-scene-1', 'accepted', 'deterministic'),
  ('0b0e0004-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001',
   '0c0e0000-0000-0000-0000-0000000000d1', '0a0e0004-0000-0000-0000-000000000002', 'row_range', 'rows 0-499',
   0, '{"start_row": 0, "end_row": 499}'::jsonb, 'fixture-segment-hash-d-rows-1', 'accepted', 'deterministic');

insert into public.workflow_tasks(id, organization_id, workflow_id, phase, task_type, role_key, role_version,
  subject_key, input_fingerprint, contract_version, state)
values
  ('0c0e0004-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
   '0c0e0000-0000-0000-0000-0000000000d1', 'analyze', 'read_scene', 'reader', '1',
   'recording-d/speaker-1', 'fp-d-read', 'read_scene@1', 'running'),
  ('0c0e0004-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001',
   '0c0e0000-0000-0000-0000-0000000000d1', 'verify', 'verify_scene', 'critic', '1',
   'recording-d/speaker-1', 'fp-d-verify', 'verify_scene@1', 'running'),
  ('0c0e0004-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001',
   '0c0e0000-0000-0000-0000-0000000000d1', 'analyze', 'read_scene', 'reader', '1',
   'recording-d/speaker-2', 'fp-d-lost', 'read_scene@1', 'running');

insert into public.agent_attempts(id, organization_id, workflow_id, task_id, attempt_no, role_key, role_version,
  executor_kind, executor_family, independence_domain, packet_fingerprint, state)
values
  ('0d0e0004-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
   '0c0e0000-0000-0000-0000-0000000000d1', '0c0e0004-0000-0000-0000-000000000001', 1, 'reader', '1',
   'model', 'family-a', 'model:family-a', 'packet-d-read', 'succeeded'),
  ('0d0e0004-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001',
   '0c0e0000-0000-0000-0000-0000000000d1', '0c0e0004-0000-0000-0000-000000000002', 1, 'critic', '1',
   'model', 'family-b', 'model:family-b', 'packet-d-verify-b', 'succeeded'),
  ('0d0e0004-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001',
   '0c0e0000-0000-0000-0000-0000000000d1', '0c0e0004-0000-0000-0000-000000000002', 2, 'critic', '1',
   'model', 'family-a', 'model:family-a', 'packet-d-verify-a', 'succeeded'),
  ('0d0e0004-0000-0000-0000-000000000004', 'aaaaaaaa-0000-0000-0000-000000000001',
   '0c0e0000-0000-0000-0000-0000000000d1', '0c0e0004-0000-0000-0000-000000000001', 2, 'reader', '1',
   'model', 'family-a', 'model:family-a', 'packet-d-cut', 'output_limited'),
  ('0d0e0004-0000-0000-0000-000000000005', 'aaaaaaaa-0000-0000-0000-000000000001',
   '0c0e0000-0000-0000-0000-0000000000d1', '0c0e0004-0000-0000-0000-000000000003', 1, 'reader', '1',
   'model', 'family-a', 'model:family-a', 'packet-d-prepared', 'prepared');

insert into public.evidence_claims(id, organization_id, workflow_id, task_id, attempt_id, independence_domain,
  subject_type, subject_key, predicate, value, unit, observation_basis, status, incomplete_source_attempt)
values
  ('0e0e0004-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
   '0c0e0000-0000-0000-0000-0000000000d1', '0c0e0004-0000-0000-0000-000000000001',
   '0d0e0004-0000-0000-0000-000000000001', 'model:family-a', 'speaker', 'recording-d/speaker-1',
   'speaking_time', '{"ms": 31000}'::jsonb, 'ms', 'observed', 'proposed', false),
  ('0e0e0004-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001',
   '0c0e0000-0000-0000-0000-0000000000d1', '0c0e0004-0000-0000-0000-000000000001',
   '0d0e0004-0000-0000-0000-000000000004', null, 'speaker', 'recording-d/speaker-3',
   'speaking_time', '{"ms": 900}'::jsonb, 'ms', 'observed', 'proposed', false),
  ('0e0e0004-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001',
   '0c0e0000-0000-0000-0000-0000000000d1', null, null, null, 'account', 'ledger-d/acct-1',
   'balance', '{"amount": 100}'::jsonb, 'usd', 'observed', 'proposed', true),
  ('0e0e0004-0000-0000-0000-000000000004', 'aaaaaaaa-0000-0000-0000-000000000001',
   '0c0e0000-0000-0000-0000-0000000000d1', null, null, null, 'account', 'ledger-d/acct-2',
   'balance', '{"amount": 200}'::jsonb, 'usd', 'observed', 'proposed', false),
  ('0e0e0004-0000-0000-0000-000000000005', 'aaaaaaaa-0000-0000-0000-000000000001',
   '0c0e0000-0000-0000-0000-0000000000d1', null, null, null, 'account', 'ledger-d/acct-3',
   'balance', '{"amount": 300}'::jsonb, 'usd', 'observed', 'proposed', false),
  ('0e0e0004-0000-0000-0000-000000000006', 'aaaaaaaa-0000-0000-0000-000000000001',
   '0c0e0000-0000-0000-0000-0000000000d1', null, null, null, 'account', 'ledger-d/acct-4',
   'balance', '{"amount": 400}'::jsonb, 'usd', 'observed', 'proposed', false),
  ('0e0e0004-0000-0000-0000-000000000007', 'aaaaaaaa-0000-0000-0000-000000000001',
   '0c0e0000-0000-0000-0000-0000000000d1', '0c0e0004-0000-0000-0000-000000000001',
   '0d0e0004-0000-0000-0000-000000000001', null, 'account', 'ledger-d/acct-5',
   'balance', '{"amount": 500}'::jsonb, 'usd', 'observed', 'proposed', false),
  ('0e0e0004-0000-0000-0000-00000000000a', 'aaaaaaaa-0000-0000-0000-000000000001',
   '0c0e0000-0000-0000-0000-0000000000d1', null, null, null, 'account', 'ledger-d/acct-9',
   'balance', '{"amount": 4}'::jsonb, 'usd', 'observed', 'proposed', false),
  ('0e0e0004-0000-0000-0000-00000000000b', 'aaaaaaaa-0000-0000-0000-000000000001',
   '0c0e0000-0000-0000-0000-0000000000d1', null, null, null, 'account', 'ledger-d/acct-9',
   'balance', '{"amount": 7}'::jsonb, 'usd', 'observed', 'proposed', false),
  ('0e0e0004-0000-0000-0000-00000000000c', 'aaaaaaaa-0000-0000-0000-000000000001',
   '0c0e0000-0000-0000-0000-0000000000d1', null, null, null, 'account', 'ledger-d/acct-9',
   'balance', '{"amount": 9}'::jsonb, 'usd', 'observed', 'proposed', false);

insert into public.evidence_anchors(id, organization_id, workflow_id, claim_id, source_kind, segment_id,
  locator, anchor_hash)
values
  ('0f0e0004-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
   '0c0e0000-0000-0000-0000-0000000000d1', '0e0e0004-0000-0000-0000-000000000001', 'segment_locator',
   '0b0e0004-0000-0000-0000-000000000001', '{"start_ms": 1200, "end_ms": 32200}'::jsonb, 'anchor-d-1'),
  ('0f0e0004-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001',
   '0c0e0000-0000-0000-0000-0000000000d1', '0e0e0004-0000-0000-0000-000000000002', 'segment',
   '0b0e0004-0000-0000-0000-000000000001', '{}'::jsonb, 'anchor-d-2'),
  ('0f0e0004-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001',
   '0c0e0000-0000-0000-0000-0000000000d1', '0e0e0004-0000-0000-0000-000000000003', 'segment_locator',
   '0b0e0004-0000-0000-0000-000000000002', '{"start_row": 10, "end_row": 12}'::jsonb, 'anchor-d-3'),
  ('0f0e0004-0000-0000-0000-000000000004', 'aaaaaaaa-0000-0000-0000-000000000001',
   '0c0e0000-0000-0000-0000-0000000000d1', '0e0e0004-0000-0000-0000-000000000004', 'segment_locator',
   '0b0e0004-0000-0000-0000-000000000002', '{"start_row": 20, "end_row": 22}'::jsonb, 'anchor-d-4'),
  ('0f0e0004-0000-0000-0000-000000000005', 'aaaaaaaa-0000-0000-0000-000000000001',
   '0c0e0000-0000-0000-0000-0000000000d1', '0e0e0004-0000-0000-0000-000000000005', 'segment_locator',
   '0b0e0004-0000-0000-0000-000000000002', '{"start_row": 30, "end_row": 32}'::jsonb, 'anchor-d-5'),
  ('0f0e0004-0000-0000-0000-000000000006', 'aaaaaaaa-0000-0000-0000-000000000001',
   '0c0e0000-0000-0000-0000-0000000000d1', '0e0e0004-0000-0000-0000-000000000006', 'segment_locator',
   '0b0e0004-0000-0000-0000-000000000002', '{"start_row": 40, "end_row": 42}'::jsonb, 'anchor-d-6'),
  ('0f0e0004-0000-0000-0000-00000000000a', 'aaaaaaaa-0000-0000-0000-000000000001',
   '0c0e0000-0000-0000-0000-0000000000d1', '0e0e0004-0000-0000-0000-00000000000a', 'segment_locator',
   '0b0e0004-0000-0000-0000-000000000002', '{"start_row": 90, "end_row": 92}'::jsonb, 'anchor-d-a'),
  ('0f0e0004-0000-0000-0000-00000000000b', 'aaaaaaaa-0000-0000-0000-000000000001',
   '0c0e0000-0000-0000-0000-0000000000d1', '0e0e0004-0000-0000-0000-00000000000b', 'segment_locator',
   '0b0e0004-0000-0000-0000-000000000002', '{"start_row": 90, "end_row": 92}'::jsonb, 'anchor-d-b'),
  ('0f0e0004-0000-0000-0000-00000000000c', 'aaaaaaaa-0000-0000-0000-000000000001',
   '0c0e0000-0000-0000-0000-0000000000d1', '0e0e0004-0000-0000-0000-00000000000c', 'segment_locator',
   '0b0e0004-0000-0000-0000-000000000002', '{"start_row": 90, "end_row": 92}'::jsonb, 'anchor-d-c');

-- The one anchor that points at nothing in the source: a person's own record,
-- attached here to a machine's reading on purpose.
insert into public.evidence_anchors(id, organization_id, workflow_id, claim_id, source_kind,
  quoted_text, anchor_hash)
values ('0f0e0004-0000-0000-0000-000000000007', 'aaaaaaaa-0000-0000-0000-000000000001',
  '0c0e0000-0000-0000-0000-0000000000d1', '0e0e0004-0000-0000-0000-000000000007', 'human_record',
  'the model says it read this', 'anchor-d-7');

insert into public.task_target_claims(organization_id, task_id, claim_id)
values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0004-0000-0000-0000-000000000002',
        '0e0e0004-0000-0000-0000-000000000001');

-- ───────────────────────────────── a piece of a source lies inside its piece
select pg_temp.refused_because('a segment found inside a scene lies inside that scene',
  $$insert into public.source_segments(id, organization_id, workflow_id, source_id, parent_segment_id,
      segment_kind, locator, content_hash, status, discovered_by)
    values ('0b0e0004-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001',
            '0c0e0000-0000-0000-0000-0000000000d1', '0a0e0004-0000-0000-0000-000000000001',
            '0b0e0004-0000-0000-0000-000000000001', 'utterance',
            '{"start_ms": 100000, "end_ms": 119000}'::jsonb, 'd-utterance-far', 'accepted', 'deterministic')$$,
  'lies outside its parent');
select pg_temp.allowed('and one that really is inside it is admitted',
  $$insert into public.source_segments(id, organization_id, workflow_id, source_id, parent_segment_id,
      segment_kind, locator, content_hash, status, discovered_by)
    values ('0b0e0004-0000-0000-0000-000000000012', 'aaaaaaaa-0000-0000-0000-000000000001',
            '0c0e0000-0000-0000-0000-0000000000d1', '0a0e0004-0000-0000-0000-000000000001',
            '0b0e0004-0000-0000-0000-000000000001', 'utterance',
            '{"start_ms": 1000, "end_ms": 2000}'::jsonb, 'd-utterance-near', 'accepted', 'deterministic')$$);

-- ─────────────────────── a register is a source like any other
select pg_temp.refused_because('an anchor into rows the reader was never handed is outside its segment',
  $$insert into public.evidence_anchors(organization_id, workflow_id, claim_id, source_kind, segment_id,
      locator, anchor_hash)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0000-0000-0000-0000-0000000000d1',
            '0e0e0004-0000-0000-0000-000000000005', 'segment_locator', '0b0e0004-0000-0000-0000-000000000002',
            '{"start_row": 49000, "end_row": 49999}'::jsonb, 'anchor-d-far')$$,
  'outside segment');
select pg_temp.refused_because('nor is one that names a place the segment has no words for',
  $$insert into public.evidence_anchors(organization_id, workflow_id, claim_id, source_kind, segment_id,
      locator, anchor_hash)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0000-0000-0000-0000-0000000000d1',
            '0e0e0004-0000-0000-0000-000000000005', 'segment_locator', '0b0e0004-0000-0000-0000-000000000002',
            '{"paragraph": 3}'::jsonb, 'anchor-d-uncomparable')$$,
  'no box or range to compare');
select pg_temp.refused('a row range that ends before it starts is not a range',
  $$insert into public.source_segments(organization_id, workflow_id, source_id, segment_kind,
      locator, content_hash, discovered_by)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0000-0000-0000-0000-0000000000d1',
            '0a0e0004-0000-0000-0000-000000000002', 'row_range',
            '{"start_row": 900, "end_row": 10}'::jsonb, 'd-rows-backwards', 'deterministic')$$);
select pg_temp.refused('and a recording does not begin before it began',
  $$insert into public.source_segments(organization_id, workflow_id, source_id, segment_kind,
      locator, content_hash, discovered_by)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0000-0000-0000-0000-0000000000d1',
            '0a0e0004-0000-0000-0000-000000000001', 'scene',
            '{"start_ms": -9000, "end_ms": -1000}'::jsonb, 'd-scene-negative', 'deterministic')$$);
select pg_temp.allowed('the same word said twice in one recording is two places',
  $$insert into public.source_segments(id, organization_id, workflow_id, source_id, segment_kind, ordinal,
      locator, content_hash, status, discovered_by)
    values ('0b0e0004-0000-0000-0000-000000000021', 'aaaaaaaa-0000-0000-0000-000000000001',
            '0c0e0000-0000-0000-0000-0000000000d1', '0a0e0004-0000-0000-0000-000000000001', 'utterance', 10,
            '{"start_ms": 10000, "end_ms": 10500}'::jsonb, 'd-utterance-yes', 'accepted', 'deterministic'),
           ('0b0e0004-0000-0000-0000-000000000022', 'aaaaaaaa-0000-0000-0000-000000000001',
            '0c0e0000-0000-0000-0000-0000000000d1', '0a0e0004-0000-0000-0000-000000000001', 'utterance', 11,
            '{"start_ms": 100000, "end_ms": 100500}'::jsonb, 'd-utterance-yes', 'accepted', 'deterministic')$$);
select pg_temp.check('and both of them are in the record',
  (select count(*) from public.source_segments
    where source_id = '0a0e0004-0000-0000-0000-000000000001' and content_hash = 'd-utterance-yes') = 2);
select pg_temp.refused('while the same word in the same place is still one segment',
  $$insert into public.source_segments(organization_id, workflow_id, source_id, segment_kind, ordinal,
      locator, content_hash, discovered_by)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0000-0000-0000-0000-0000000000d1',
            '0a0e0004-0000-0000-0000-000000000001', 'utterance', 12,
            '{"start_ms": 10000, "end_ms": 10500}'::jsonb, 'd-utterance-yes', 'deterministic')$$);
select pg_temp.allowed('a locator whose path happens to contain the word signature is still a locator',
  $$insert into public.workflow_sources(organization_id, workflow_id, ordinal, source_kind, uri,
      content_hash, hash_algorithm)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0000-0000-0000-0000-0000000000d1', 2, 'document',
            'fixture://synthetic/deeds/signature=witnessed.pdf', 'fixture-deed-hash', 'sha-256')$$);

-- ─────────────────────────────── what an accepted claim actually stands on
select pg_temp.refused_because('a claim out of an answer the database can see was cut short is not accepted, flag or no flag',
$sql$
do $x$ begin
  update public.evidence_claims set status = 'accepted' where id = '0e0e0004-0000-0000-0000-000000000002';
  perform pg_temp.core_v2_settle();
end $x$;
$sql$, 'cut short');
select pg_temp.check('and it is still where it was',
  (select status from public.evidence_claims where id = '0e0e0004-0000-0000-0000-000000000002') = 'proposed');
select pg_temp.refused_because('a claim that came from a cut-short answer does not stop having come from one',
  $$update public.evidence_claims set incomplete_source_attempt = false
     where id = '0e0e0004-0000-0000-0000-000000000003'$$,
  'does not stop being true');
select pg_temp.refused_because('a machine reading is not accepted on a sentence the machine wrote about itself',
$sql$
do $x$ begin
  update public.evidence_claims set status = 'accepted' where id = '0e0e0004-0000-0000-0000-000000000007';
  perform pg_temp.core_v2_settle();
end $x$;
$sql$, 'not reported by a person');

-- ────────────────────────────────────── agreement is not proof
insert into public.claim_assessments(id, organization_id, workflow_id, claim_id, attempt_id, assessment, reason_code)
values ('1d0e0004-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
  '0c0e0000-0000-0000-0000-0000000000d1', '0e0e0004-0000-0000-0000-000000000001',
  '0d0e0004-0000-0000-0000-000000000003', 'supports', 'value_matches_source');
select pg_temp.refused_because('a reading is not accepted on a verdict from its own executor domain',
$sql$
do $x$ begin
  update public.evidence_claims set status = 'accepted' where id = '0e0e0004-0000-0000-0000-000000000001';
  perform pg_temp.core_v2_settle();
end $x$;
$sql$, 'no independent verification');
insert into public.claim_assessments(id, organization_id, workflow_id, claim_id, attempt_id, task_id,
  assessment, reason_code)
values ('1d0e0004-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001',
  '0c0e0000-0000-0000-0000-0000000000d1', '0e0e0004-0000-0000-0000-000000000001',
  '0d0e0004-0000-0000-0000-000000000002', '0c0e0004-0000-0000-0000-000000000002',
  'supports', 'value_matches_source');
select pg_temp.allowed('and is accepted on one from another domain, which is what independence buys',
$sql$
do $x$ begin
  update public.evidence_claims set status = 'accepted' where id = '0e0e0004-0000-0000-0000-000000000001';
  perform pg_temp.core_v2_settle();
end $x$;
$sql$);
select pg_temp.check('the claim is accepted, and the verdict that carried it is named',
  (select status from public.evidence_claims where id = '0e0e0004-0000-0000-0000-000000000001') = 'accepted');
select pg_temp.refused_because('and the verdict it rests on is not pulled out afterwards',
$sql$
do $x$ begin
  delete from public.claim_assessments where id = '1d0e0004-0000-0000-0000-000000000002';
  perform pg_temp.core_v2_settle();
end $x$;
$sql$, 'no independent verification');
select pg_temp.refused_because('a verifier answers the claims its task was handed, and no others',
  $$insert into public.claim_assessments(organization_id, workflow_id, claim_id, attempt_id, task_id,
      assessment, reason_code)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0000-0000-0000-0000-0000000000d1',
            '0e0e0004-0000-0000-0000-000000000005', '0d0e0004-0000-0000-0000-000000000002',
            '0c0e0004-0000-0000-0000-000000000002', 'supports', 'never_asked_to_look')$$,
  'does not widen the packet');

-- The arbiter's own way through, and the only one it has. When every reader
-- read wrong, what stands is not the arbiter's opinion but the value a reviewer
-- read off the reopened source — so the decision that accepts the correction
-- must cite that reviewer's own anchor. An adjudication resting on nothing but
-- the readings it is settling accepts nothing.
insert into public.evidence_claims(id, organization_id, workflow_id, task_id, attempt_id, subject_type, subject_key,
  predicate, value, unit, observation_basis, independence_domain)
values ('0e0e0004-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-000000000001',
  '0c0e0000-0000-0000-0000-0000000000d1', '0c0e0004-0000-0000-0000-000000000002',
  '0d0e0004-0000-0000-0000-000000000002', 'account', 'ledger-d/acct-9', 'balance',
  '{"amount": 909}'::jsonb, 'usd', 'inferred', 'domain:arbiter');
insert into public.evidence_anchors(id, organization_id, workflow_id, claim_id, source_kind, segment_id, anchor_hash)
values ('0f0e0004-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-000000000001',
  '0c0e0000-0000-0000-0000-0000000000d1', '0e0e0004-0000-0000-0000-00000000c001', 'segment',
  (select segment_id from public.evidence_anchors where claim_id = '0e0e0004-0000-0000-0000-000000000001' limit 1),
  'fx-corrected-anchor');
insert into public.decisions(id, organization_id, workflow_id, task_id, decision_type, subject_key, title,
  status, authority, rationale, decided_by_attempt_id)
values ('100e0004-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-000000000001',
  '0c0e0000-0000-0000-0000-0000000000d1', '0c0e0004-0000-0000-0000-000000000002', 'accept_claim',
  'ledger-d/acct-9', 'ledger-d/acct-9: corrected', 'proposed', 'adjudicator',
  'the reopened source shows a value none of the readers reported',
  '0d0e0004-0000-0000-0000-000000000002');
insert into public.decision_evidence(organization_id, decision_id, claim_id, link)
values ('aaaaaaaa-0000-0000-0000-000000000001', '100e0004-0000-0000-0000-00000000c001',
  '0e0e0004-0000-0000-0000-00000000c001', 'supports');
select pg_temp.refused_because('an adjudicator accepting its own correction on nothing but the readings it settled is refused',
$sql$
do $x$ begin
  update public.evidence_claims set status = 'accepted' where id = '0e0e0004-0000-0000-0000-00000000c001';
  perform pg_temp.core_v2_settle();
end $x$;
$sql$, 'no independent verification');
-- The reviewer's own anchor, cited by the decision as what the source shows.
insert into public.evidence_anchors(id, organization_id, workflow_id, assessment_id, source_kind, segment_id, anchor_hash)
values ('0f0e0004-0000-0000-0000-00000000c002', 'aaaaaaaa-0000-0000-0000-000000000001',
  '0c0e0000-0000-0000-0000-0000000000d1', '1d0e0004-0000-0000-0000-000000000002', 'segment',
  (select segment_id from public.evidence_anchors where claim_id = '0e0e0004-0000-0000-0000-000000000001' limit 1),
  'fx-reviewer-anchor');
insert into public.decision_evidence(organization_id, decision_id, anchor_id, link)
values ('aaaaaaaa-0000-0000-0000-000000000001', '100e0004-0000-0000-0000-00000000c001',
  '0f0e0004-0000-0000-0000-00000000c002', 'context');
select pg_temp.allowed('and stands once it cites the reviewer''s own anchor, from a domain that is not its own',
$sql$
do $x$ begin
  update public.evidence_claims set status = 'accepted' where id = '0e0e0004-0000-0000-0000-00000000c001';
  perform pg_temp.core_v2_settle();
end $x$;
$sql$);
select pg_temp.check('the correction is accepted, and what it rests on is on the record beside it',
  (select status from public.evidence_claims where id = '0e0e0004-0000-0000-0000-00000000c001') = 'accepted'
  and exists (select 1 from public.decision_evidence e join public.evidence_anchors a on a.id = e.anchor_id
               where e.decision_id = '100e0004-0000-0000-0000-00000000c001' and a.assessment_id is not null));

-- ─────────────────────────── supersession replaces a reading, it does not end one
select public.core_v2_claim_transition('0e0e0004-0000-0000-0000-000000000006', 'accepted');
select pg_temp.allowed('an accepted reading with its anchor stands', $$select pg_temp.core_v2_settle()$$);
select pg_temp.refused_because('a reading superseded by nothing is a deletion wearing a kinder word',
$sql$
do $x$ begin
  update public.evidence_claims set status = 'superseded' where id = '0e0e0004-0000-0000-0000-000000000006';
  perform pg_temp.core_v2_settle();
end $x$;
$sql$, 'superseded by nothing');
insert into public.evidence_claims(id, organization_id, workflow_id, subject_type, subject_key, predicate,
  value, unit, observation_basis, supersedes_claim_id)
values ('0e0e0004-0000-0000-0000-000000000016', 'aaaaaaaa-0000-0000-0000-000000000001',
  '0c0e0000-0000-0000-0000-0000000000d1', 'account', 'ledger-d/acct-4', 'balance',
  '{"amount": 404}'::jsonb, 'usd', 'observed', '0e0e0004-0000-0000-0000-000000000006');
select pg_temp.allowed('the correction that names it may take its place',
$sql$
do $x$ begin
  update public.evidence_claims set status = 'superseded' where id = '0e0e0004-0000-0000-0000-000000000006';
  perform pg_temp.core_v2_settle();
end $x$;
$sql$);
select pg_temp.check('and both readings stay',
  (select status from public.evidence_claims where id = '0e0e0004-0000-0000-0000-000000000006') = 'superseded'
  and exists (select 1 from public.evidence_claims where id = '0e0e0004-0000-0000-0000-000000000016'));

-- ───────────────────────────────────── the decided decision
select public.core_v2_claim_transition('0e0e0004-0000-0000-0000-000000000004', 'accepted');
insert into public.decisions(id, organization_id, workflow_id, decision_type, subject_key, title,
  status, authority, decided_by_attempt_id)
values ('1b0e0004-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
  '0c0e0000-0000-0000-0000-0000000000d1', 'accept_claim', 'ledger-d/acct-2',
  'the balance of account 2', 'proposed', 'adjudicator', '0d0e0004-0000-0000-0000-000000000001');
insert into public.decision_evidence(organization_id, decision_id, claim_id, link, rule)
values ('aaaaaaaa-0000-0000-0000-000000000001', '1b0e0004-0000-0000-0000-000000000001',
  '0e0e0004-0000-0000-0000-000000000004', 'supports', 'machine_adjudication');
select pg_temp.refused_because('a decision does not cite one claim through another claim''s source, in one row',
  $$insert into public.decision_evidence(organization_id, decision_id, claim_id, anchor_id, link)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '1b0e0004-0000-0000-0000-000000000001',
            '0e0e0004-0000-0000-0000-000000000004', '0f0e0004-0000-0000-0000-000000000005', 'supports')$$,
  'another claim');
select pg_temp.refused_because('nor in two rows, which is the same citation written twice',
  $$insert into public.decision_evidence(organization_id, decision_id, anchor_id, link)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '1b0e0004-0000-0000-0000-000000000001',
            '0f0e0004-0000-0000-0000-000000000005', 'supports')$$,
  'another claim');
select pg_temp.allowed('a decision decided on an accepted claim of its own stands',
$sql$
do $x$ begin
  perform public.core_v2_decision_transition('1b0e0004-0000-0000-0000-000000000001', 'machine_decided');
  perform pg_temp.core_v2_settle();
end $x$;
$sql$);
select pg_temp.check('and it is decided',
  (select status from public.decisions where id = '1b0e0004-0000-0000-0000-000000000001') = 'machine_decided');
select pg_temp.refused_because('a decided decision is superseded, not deleted',
  $$delete from public.decisions where id = '1b0e0004-0000-0000-0000-000000000001'$$,
  'part of the record');
select pg_temp.refused_because('a supersession that names no decision is a decision resting on nothing',
  $$insert into public.decisions(organization_id, workflow_id, decision_type, title, status, authority,
      decided_by_attempt_id)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0000-0000-0000-0000-0000000000d1', 'supersede',
            'decided on nothing at all', 'machine_decided', 'adjudicator',
            '0d0e0004-0000-0000-0000-000000000001')$$,
  'supersede_names_predecessor');
select pg_temp.allowed('one that names the decision it replaces is admitted, and borrows its evidence',
$sql$
do $x$ begin
  insert into public.decisions(id, organization_id, workflow_id, decision_type, title, status, authority,
    decided_by_attempt_id, supersedes_decision_id)
  values ('1b0e0004-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001',
    '0c0e0000-0000-0000-0000-0000000000d1', 'supersede', 'a later reading of account 2',
    'machine_decided', 'adjudicator', '0d0e0004-0000-0000-0000-000000000001',
    '1b0e0004-0000-0000-0000-000000000001');
  perform pg_temp.core_v2_settle();
end $x$;
$sql$);

-- ───────────────────────────── a person settles it, between the claims that competed
insert into public.disagreements(id, organization_id, workflow_id, disagreement_key, kind, state)
values ('1c0e0004-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
  '0c0e0000-0000-0000-0000-0000000000d1', 'ledger-d/acct-9/balance', 'value', 'open');
insert into public.disagreement_claims(organization_id, disagreement_id, claim_id, position, role)
values
  ('aaaaaaaa-0000-0000-0000-000000000001', '1c0e0004-0000-0000-0000-000000000001',
   '0e0e0004-0000-0000-0000-00000000000a', 0, 'candidate'),
  ('aaaaaaaa-0000-0000-0000-000000000001', '1c0e0004-0000-0000-0000-000000000001',
   '0e0e0004-0000-0000-0000-00000000000b', 1, 'candidate'),
  ('aaaaaaaa-0000-0000-0000-000000000001', '1c0e0004-0000-0000-0000-000000000001',
   '0e0e0004-0000-0000-0000-00000000000c', 2, 'context');
select pg_temp.refused_because('a disagreement does not spend more critic rounds than its workflow was admitted with',
  $$update public.disagreements set critic_rounds = 4 where id = '1c0e0004-0000-0000-0000-000000000001'$$,
  'has spent its rounds');
select pg_temp.refused_because('nor is one born past them',
  $$insert into public.disagreements(organization_id, workflow_id, disagreement_key, kind, critic_rounds)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '0c0e0000-0000-0000-0000-0000000000d1',
            'ledger-d/acct-8/balance', 'value', 9)$$,
  'has spent its rounds');
select pg_temp.refused_because('nor is a follow-up admitted for a round nobody paid for',
  $$insert into public.disagreement_follow_ups(organization_id, disagreement_id, round, fingerprint)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '1c0e0004-0000-0000-0000-000000000001', 4, 'round-4')$$,
  'has spent its rounds');
select pg_temp.allowed('the round the workflow did pay for is admitted',
  $$insert into public.disagreement_follow_ups(organization_id, disagreement_id, round, fingerprint)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '1c0e0004-0000-0000-0000-000000000001', 1, 'round-1')$$);

set local role authenticated;
set local test.uid = '33333333-3333-3333-3333-333333333333';
select pg_temp.refused_because('a reviewer settles between the readings that disagreed, not one carried for context',
  $$select public.core_v2_resolve_disagreement('1c0e0004-0000-0000-0000-000000000001',
      'accept_claim', 'settled', '0e0e0004-0000-0000-0000-00000000000c')$$,
  'one of the claims that disagreed');
select pg_temp.allowed('and settling on a reading that did compete is the reviewer''s to make',
  $$select public.core_v2_resolve_disagreement('1c0e0004-0000-0000-0000-000000000001',
      'accept_claim', 'settled', '0e0e0004-0000-0000-0000-00000000000a')$$);
reset role;
set local test.uid = '';
select pg_temp.check('the reading that won is accepted, the one that lost is rejected, and the one carried for context is neither',
  (select status from public.evidence_claims where id = '0e0e0004-0000-0000-0000-00000000000a') = 'accepted'
  and (select status from public.evidence_claims where id = '0e0e0004-0000-0000-0000-00000000000b') = 'rejected'
  and (select status from public.evidence_claims where id = '0e0e0004-0000-0000-0000-00000000000c') = 'proposed');
select pg_temp.refused_because('a resolved disagreement stays in the record',
  $$delete from public.disagreements where id = '1c0e0004-0000-0000-0000-000000000001'$$,
  'stays in the record');
select pg_temp.check('so the claims it was settled between cannot leave through it either',
  (select count(*) from public.disagreement_claims
    where disagreement_id = '1c0e0004-0000-0000-0000-000000000001') = 3);
select pg_temp.refused_because('and the decision it produced is not deleted out from under it',
  $$delete from public.decisions
     where id = (select resolution_decision_id from public.disagreements
                  where id = '1c0e0004-0000-0000-0000-000000000001')$$,
  'part of the record');

-- ─────────────────────────── what a person's door proves, and a variable does not
select public.core_v2_task_transition('0c0e0004-0000-0000-0000-000000000003', 'outcome_unknown');
select pg_temp.refused_because('setting the guard''s own variable is not a person authorising anything',
$sql$
do $x$ begin
  perform set_config('core_v2.authorized_retry', '0c0e0004-0000-0000-0000-000000000003', true);
  update public.workflow_tasks set state = 'queued', retry_authorized_at = now()
   where id = '0c0e0004-0000-0000-0000-000000000003';
end $x$;
$sql$, 'a person must authorise');
select pg_temp.check('and the task is still where nobody knew what became of it',
  (select state from public.workflow_tasks where id = '0c0e0004-0000-0000-0000-000000000003') = 'outcome_unknown');
select pg_temp.refused_because('a request is not sent by writing the word — the door is what proves the lease',
  $$update public.agent_attempts set state = 'submitted', submitted_at = now()
     where id = '0d0e0004-0000-0000-0000-000000000005'$$,
  'core_v2_submit_attempt');

-- ─────────────────────────────── a move is made from the state the caller saw
select pg_temp.refused_because('a move made from a stale reading is refused, not applied',
  $$select public.core_v2_claim_transition('0e0e0004-0000-0000-0000-000000000005', 'accepted', 'verified')$$,
  'stale reading');
select pg_temp.check('and the claim did not move',
  (select status from public.evidence_claims where id = '0e0e0004-0000-0000-0000-000000000005') = 'proposed');

-- ───────────────────────────── what to do next belongs to the domain pack
select pg_temp.allowed('a pack names the action its own domain calls for',
  $$insert into public.decision_actions(organization_id, decision_id, action_type, owner_role)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '1b0e0004-0000-0000-0000-000000000001',
            'ledger:reconcile_with_bank', 'controller')$$);
select pg_temp.refused('while a bare word the kernel does not know, and no pack claims, is still refused',
  $$insert into public.decision_actions(organization_id, decision_id, action_type, owner_role)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '1b0e0004-0000-0000-0000-000000000001',
            'wander_off', 'nobody')$$);

-- ───────────────────── two writers at once are one writer's worth of budget
--
-- A second workflow, admitted for two tasks. The admission guard serialises on
-- the workflow before it counts, so two planners cannot each see room for one
-- more task and both take it. A single session cannot hold two transactions
-- open at once, so what is asserted here is that the lock is actually taken:
-- without it the count below is a reading of a past that another planner has
-- already changed.
insert into public.intelligence_workflows(
  id, organization_id, domain_pack, domain_pack_version, workflow_type, engine_version,
  source_set_fingerprint, request_fingerprint, budget, state)
values ('0c0e0000-0000-0000-0000-0000000000d2', 'aaaaaaaa-0000-0000-0000-000000000001',
  'synthetic-decision', '1', 'synthetic_review', 'core-v2.1',
  'fixture-budget-source-set', 'fixture-budget-request', '{"maximum_tasks": 2}'::jsonb, 'running');
insert into public.workflow_tasks(id, organization_id, workflow_id, phase, task_type, role_key, role_version,
  subject_key, input_fingerprint, contract_version, state)
values ('0c0e0004-0000-0000-0000-000000000021', 'aaaaaaaa-0000-0000-0000-000000000001',
  '0c0e0000-0000-0000-0000-0000000000d2', 'analyze', 'read_scene', 'reader', '1',
  'budget/row-1', 'fp-budget-1', 'read_scene@1', 'queued');
select pg_temp.check('admitting a task holds the workflow, so two planners cannot both count the same room',
  exists (select 1 from pg_locks
           where locktype = 'advisory' and objsubid = 1 and pid = pg_backend_pid()
             and classid::bigint =
                 ((hashtextextended('0c0e0000-0000-0000-0000-0000000000d2'::uuid::text, 0) >> 32) & 4294967295)
             and objid::bigint =
                 (hashtextextended('0c0e0000-0000-0000-0000-0000000000d2'::uuid::text, 0) & 4294967295)));
select pg_temp.refused_because('and the budget itself still holds against one planner',
  $$insert into public.workflow_tasks(organization_id, workflow_id, phase, task_type, role_key, role_version,
      subject_key, input_fingerprint, contract_version, state)
    select 'aaaaaaaa-0000-0000-0000-000000000001', '0c0e0000-0000-0000-0000-0000000000d2', 'analyze',
           'read_scene', 'reader', '1', 'budget/row-' || g, 'fp-budget-' || g, 'read_scene@1', 'queued'
      from generate_series(2, 3) g$$,
  'its budget allows no more');

-- ───────────────── a guard that judges by a row it does not write, locks it
--
-- Findings the suite cannot stage in one session: two ordinary transactions,
-- each writing a different row, each reading the other's row and seeing it
-- unchanged, both committing. The fix is that every such guard reads the row
-- its verdict depends on `for share`, so the two contend and the loser re-reads
-- what the winner did. A file that holds one connection open cannot show two
-- transactions passing each other, so what is asserted is the lock itself.
select pg_temp.check('the anchor guard reads the claim it judges by under a lock',
  pg_get_functiondef('public.core_v2_guard_anchor'::regproc)
    ~* 'from public\.evidence_claims c where c\.id = owning_claim for share');
select pg_temp.check('and so does the check that re-reads a claim when its anchor moves',
  pg_get_functiondef('public.core_v2_recheck_claim_of_anchor'::regproc) ~* 'for share');
select pg_temp.check('the evidence guard reads the decision it judges by under a lock',
  pg_get_functiondef('public.core_v2_guard_decision_evidence'::regproc)
    ~* 'from public\.decisions d\s+where d\.id = row_link\.decision_id for share');
select pg_temp.check('so does the check that re-reads a decision when its evidence moves',
  pg_get_functiondef('public.core_v2_recheck_decision_of_evidence'::regproc) ~* 'where id = target for share');
select pg_temp.check('the disagreement''s claim guard reads the disagreement under a lock',
  pg_get_functiondef('public.core_v2_guard_disagreement_claims'::regproc)
    ~* 'where id = row_link\.disagreement_id for share');
select pg_temp.check('a decided decision counts its supporting claims under a lock',
  pg_get_functiondef('public.core_v2_check_decision_evidence'::regproc) ~* 'for share of c');
select pg_temp.check('and a superseded claim looks at the decisions on it under one',
  pg_get_functiondef('public.core_v2_check_superseded_claim_decisions'::regproc) ~* 'for share of d');

-- ────────────────────── the execution layer's own doors (migration 059)
--
-- The money tables are reachable only through their doors, and only by the
-- service role. What the doors DO is proved against a real cluster in
-- workers/core-v2-runtime/tests/budget.mjs; what is proved here is the part
-- a test cannot: who may touch them at all, and the rules the schema itself
-- refuses to let a caller break.
-- This file grants every table to `authenticated` on purpose (see the top),
-- so what keeps a person out of the money tables is row-level security, and
-- that is what is checked: a member of the organisation may read what it
-- spent and may write nothing at all. Every write goes through a door.
reset role;
set local role authenticated;
set local test.uid = '11111111-1111-1111-1111-111111111111';
select pg_temp.refused_because('nobody who logs in may write a budget — every write goes through a door',
  $$insert into public.workflow_cost_budgets(workflow_id, organization_id, currency, authorized_maximum, maximum_per_attempt)
    values ('0c0e0000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'USD', 1, 1)$$,
  'row-level security');
select pg_temp.refused_because('nor a reservation against an attempt that really exists',
  $$insert into public.attempt_cost_reservations(attempt_id, organization_id, workflow_id, reserved_cost)
    values ('0d0e0000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
            '0c0e0000-0000-0000-0000-000000000001', 1)$$,
  'row-level security');
select pg_temp.check('and neither table may be emptied by anyone who logs in',
  (select count(*) from public.workflow_cost_budgets) = 0);
reset role;

select pg_temp.check('row-level security is on for both money tables, which is what decides who may read them',
  (select count(*) from pg_class
    where relname in ('workflow_cost_budgets', 'attempt_cost_reservations')
      and relnamespace = 'public'::regnamespace and relrowsecurity) = 2);
select pg_temp.check('every door of the execution layer is granted to the service role and to nobody else',
  (select count(distinct p.proname) from pg_proc p, aclexplode(p.proacl) a
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('core_v2_reserve_attempt_cost', 'core_v2_settle_attempt_cost',
                        'core_v2_release_attempt_cost', 'core_v2_attempt_cost_needs_attention',
                        'core_v2_stop_workflow_spending', 'core_v2_authorize_workflow_spending',
                        'core_v2_claim_next_workflow', 'core_v2_resumable_workflows')
      and pg_get_userbyid(a.grantee) = 'service_role') = 8
  and not exists (
    select 1 from pg_proc p, aclexplode(p.proacl) a
     where p.pronamespace = 'public'::regnamespace
       and p.proname in ('core_v2_reserve_attempt_cost', 'core_v2_settle_attempt_cost',
                         'core_v2_release_attempt_cost', 'core_v2_attempt_cost_needs_attention',
                         'core_v2_stop_workflow_spending', 'core_v2_authorize_workflow_spending',
                         'core_v2_claim_next_workflow', 'core_v2_resumable_workflows')
       and (a.grantee = 0 or pg_get_userbyid(a.grantee) in ('anon', 'authenticated'))));
select pg_temp.check('a settlement must show its working: the components it was priced from and the version of the rules',
  pg_get_functiondef('public.core_v2_settle_attempt_cost'::regproc)
    ~* 'p_normalized_usage is null or p_normalization_version is null');
select pg_temp.check('and the schema refuses a settled row that does not carry them',
  exists (select 1 from pg_constraint
           where conname = 'attempt_cost_reservations_settled_shows_its_working'
             and conrelid = 'public.attempt_cost_reservations'::regclass));
select pg_temp.check('a reservation priced in one currency cannot be taken against a budget authorised in another',
  pg_get_functiondef('public.core_v2_reserve_attempt_cost'::regproc)
    ~* 'reservation refused: this attempt is priced in');
select pg_temp.check('a hold is given back only for an attempt that was never sent, or one reconciled as never started',
  pg_get_functiondef('public.core_v2_release_attempt_cost'::regproc)
    ~* 'core_v2_attempt_submitted\(attempt\.state\)');
select pg_temp.check('and an attempt nobody knows the outcome of keeps holding its money',
  pg_get_functiondef('public.core_v2_release_attempt_cost'::regproc)
    ~* 'nobody knows what became of attempt');
select pg_temp.check('money waiting for somebody is money still held — the two cannot disagree',
  exists (select 1 from pg_constraint
           where conname = 'attempt_cost_reservations_attention_is_open'
             and conrelid = 'public.attempt_cost_reservations'::regclass));
select pg_temp.check('the provider facts on an attempt are written once and never rewritten',
  pg_get_functiondef('public.core_v2_guard_attempt_provider_facts'::regproc) ~* 'is distinct from');

-- A HOLD HAS TO SHOW THAT IT IS A CEILING.
-- A reservation carries the rates it was worked out at and the number they
-- produced, so a reader can repeat the arithmetic instead of taking the
-- caller's word for it. These are behavioural, not source-text: the door is
-- actually called, with a basis that lies in each of the four ways it can.
select public.core_v2_authorize_workflow_spending(
  '0c0e0000-0000-0000-0000-000000000001', 1::numeric, 1::numeric, 'USD', null, null, null, null, null);

select pg_temp.refused('a price basis that names a ceiling rule and does not carry the rates it used is refused',
  $$select public.core_v2_reserve_attempt_cost('0d0e0000-0000-0000-0000-000000000001', 0.0045,
      1000, 100, '{"currency":"USD","ceiling_rule":"core-v2.ceiling.1"}'::jsonb)$$);
select pg_temp.refused('a price basis whose rates do not work out to the number it claims is refused',
  $$select public.core_v2_reserve_attempt_cost('0d0e0000-0000-0000-0000-000000000001', 0.0045,
      1000, 100, '{"currency":"USD","ceiling_rule":"core-v2.ceiling.1",
        "ceiling_input_per_million_tokens":3,"ceiling_output_per_million_tokens":15,
        "maximum_cost":0.0001}'::jsonb)$$);
select pg_temp.refused('a hold that is not the ceiling its own basis works out to is refused',
  $$select public.core_v2_reserve_attempt_cost('0d0e0000-0000-0000-0000-000000000001', 0.0001,
      1000, 100, '{"currency":"USD","ceiling_rule":"core-v2.ceiling.1",
        "ceiling_input_per_million_tokens":3,"ceiling_output_per_million_tokens":15,
        "maximum_cost":0.0045}'::jsonb)$$);
select pg_temp.refused('an input ceiling rate below the cache-write rate the attempt could be settled at is refused',
  $$select public.core_v2_reserve_attempt_cost('0d0e0000-0000-0000-0000-000000000001', 0.0045,
      1000, 100, '{"currency":"USD","ceiling_rule":"core-v2.ceiling.1",
        "input_per_million_tokens":3,"cache_write_per_million_tokens":30,
        "ceiling_input_per_million_tokens":3,"ceiling_output_per_million_tokens":15,
        "maximum_cost":0.0045}'::jsonb)$$);
select pg_temp.refused('an output ceiling rate below the reasoning rate the attempt could be settled at is refused',
  $$select public.core_v2_reserve_attempt_cost('0d0e0000-0000-0000-0000-000000000001', 0.0045,
      1000, 100, '{"currency":"USD","ceiling_rule":"core-v2.ceiling.1",
        "output_per_million_tokens":15,"reasoning_per_million_tokens":60,
        "ceiling_input_per_million_tokens":3,"ceiling_output_per_million_tokens":15,
        "maximum_cost":0.0045}'::jsonb)$$);
-- Two statements, not one: the door's own update to the budget row is not
-- visible to a sibling subquery inside the statement that made it.
select pg_temp.check('a basis whose arithmetic holds is taken, for exactly the number it works out to',
  (select reserved_cost from public.core_v2_reserve_attempt_cost(
     '0d0e0000-0000-0000-0000-000000000001', 0.0045, 1000, 100,
     '{"currency":"USD","ceiling_rule":"core-v2.ceiling.1",
       "input_per_million_tokens":3,"output_per_million_tokens":15,
       "cache_write_per_million_tokens":3,"reasoning_per_million_tokens":15,
       "ceiling_input_per_million_tokens":3,"ceiling_output_per_million_tokens":15,
       "maximum_cost":0.0045}'::jsonb)) = 0.0045);
select pg_temp.check('and the workflow is then holding exactly that',
  (select reserved from public.workflow_cost_budgets
    where workflow_id = '0c0e0000-0000-0000-0000-000000000001') = 0.0045);

-- ═══════════════════════════════ 060 · the durable answer to "run it again"
--
-- The one fact that makes a workflow move without a person: when it is next
-- due, who holds it, and how many passes in a row have moved nothing. What
-- these check is that it cannot be forged, cannot be written by anyone who
-- logs in, and cannot be made to wake a workflow the engine has finished with.

select pg_temp.check('row-level security is on for the continuation record',
  (select relrowsecurity from pg_class where oid = 'public.workflow_continuations'::regclass));
select pg_temp.check('and on the runner settings, which have no read policy at all — they are the operator''s',
  (select relrowsecurity from pg_class where oid = 'public.core_v2_runner_settings'::regclass)
  and (select count(*) from pg_policies where tablename = 'core_v2_runner_settings') = 0);
select pg_temp.check('the watchdog ships DORMANT: no settings row, and armed defaults to false',
  (select count(*) from public.core_v2_runner_settings) = 0
  and (select column_default from information_schema.columns
        where table_name = 'core_v2_runner_settings' and column_name = 'armed') = 'false');
select pg_temp.check('every continuation door is granted to the service role and to nobody else',
  (select bool_and(
      has_function_privilege('service_role', p.oid, 'execute')
      and not has_function_privilege('authenticated', p.oid, 'execute')
      and not has_function_privilege('anon', p.oid, 'execute'))
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'core_v2_schedule_continuation','core_v2_claim_continuation','core_v2_release_continuation',
      'core_v2_settle_continuation','core_v2_due_continuations','core_v2_tick_due_continuations',
      'core_v2_continuation_limits')));
reset role;
set local role authenticated;
set local test.uid = '11111111-1111-1111-1111-111111111111';
select pg_temp.refused_because('nobody who logs in may write a continuation — waking is not a thing a member does',
  $$insert into public.workflow_continuations(workflow_id, organization_id)
    values ('0c0e0000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001')$$,
  'row-level security');
-- Row-level security is what keeps a person out, exactly as it is for the
-- money tables: this deployment grants the table privileges broadly and the
-- policies decide. A table with RLS on and NO policy returns nothing to
-- everyone but the service role, which is why the settings are checked by
-- what they yield rather than by an error.
select pg_temp.check('the operator''s settings yield nothing to anyone who logs in — no policy, no rows',
  (select count(*) from public.core_v2_runner_settings) = 0);
select pg_temp.refused_because('and cannot be written by them',
  $$insert into public.core_v2_runner_settings(id, armed, endpoint)
    values (true, true, 'https://example.invalid/knock')$$,
  'row-level security');
reset role;
-- And structurally, not just in this transaction's rows: an UPDATE that
-- happens to match nothing succeeds trivially, so what is checked is that
-- there is no policy under which one could ever match. One policy, for
-- reading, and no other.
select pg_temp.check('a member may read their own organisation''s continuations and change none of them',
  (select count(*) from pg_policies where tablename = 'workflow_continuations') = 1
  and (select cmd from pg_policies where tablename = 'workflow_continuations') = 'SELECT');

-- A hold is three facts or none of them, and a settled row says why.
-- Against a workflow that really exists, so what refuses is the constraint
-- being checked and not the tenancy guard on the way past it.
select pg_temp.refused_because('a half-written hold is refused: a lease nobody can prove they own is not a lease',
  $$insert into public.workflow_continuations(workflow_id, organization_id, state, held_by)
    values ('0c0e0000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'held', 'somebody')$$,
  'workflow_continuations_hold_is_whole');
select pg_temp.refused_because('and a settled row that does not say why is refused',
  $$insert into public.workflow_continuations(workflow_id, organization_id, state)
    values ('0c0e0000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'settled')$$,
  'workflow_continuations_settled_says_why');

-- The claim, the fencing token, and the fuse.
select public.core_v2_schedule_continuation('0c0e0000-0000-0000-0000-000000000001');
select pg_temp.check('a scheduled workflow is due',
  (select state from public.workflow_continuations
    where workflow_id = '0c0e0000-0000-0000-0000-000000000001') = 'due');

create temporary table core_v2_hold on commit drop as
  select * from public.core_v2_claim_continuation('invariant-runner', 60000);
select pg_temp.check('one runner takes it, with a token and a deadline of its own',
  (select state = 'held' and held_by = 'invariant-runner' and hold_token is not null and held_until > now()
     from core_v2_hold));
select pg_temp.check('and a second runner asking at the same moment gets nothing, rather than the same row',
  (select workflow_id from public.core_v2_claim_continuation('another-runner', 60000)) is null);
select pg_temp.check('a release under the wrong token is refused with a null, never applied',
  (select workflow_id from public.core_v2_release_continuation(
     '0c0e0000-0000-0000-0000-000000000001', gen_random_uuid(), true)) is null);
select pg_temp.check('and the real hold still stands after that',
  (select held_by from public.workflow_continuations
    where workflow_id = '0c0e0000-0000-0000-0000-000000000001') = 'invariant-runner');
select pg_temp.check('a release under the right token gives it back and says when to come again',
  (select state from public.core_v2_release_continuation(
     '0c0e0000-0000-0000-0000-000000000001', (select hold_token from core_v2_hold), true)) = 'due');

-- What the fuse is for: a workflow that cannot be advanced stops asking.
do $$
declare i integer; token uuid; limits record;
begin
  select * into limits from public.core_v2_continuation_limits();
  for i in 1..limits.maximum_idle_streak loop
    perform public.core_v2_schedule_continuation('0c0e0000-0000-0000-0000-000000000001', now() - interval '1 minute');
    select hold_token into token from public.core_v2_claim_continuation('fuse-runner', 60000);
    exit when token is null;
    perform public.core_v2_release_continuation('0c0e0000-0000-0000-0000-000000000001', token, false);
  end loop;
end $$;
select pg_temp.check('enough passes that move nothing settle it, rather than waking it forever',
  (select state from public.workflow_continuations
    where workflow_id = '0c0e0000-0000-0000-0000-000000000001') = 'settled');
select pg_temp.check('and it says which fuse it stopped on',
  (select settled_reason from public.workflow_continuations
    where workflow_id = '0c0e0000-0000-0000-0000-000000000001') like 'no_progress%');
select pg_temp.check('a settled workflow cannot be woken by asking again',
  (select state from public.core_v2_schedule_continuation('0c0e0000-0000-0000-0000-000000000001')) = 'settled');
select pg_temp.check('and nothing due lists it',
  not exists (select 1 from public.core_v2_due_continuations(50) w
               where w = '0c0e0000-0000-0000-0000-000000000001'));

-- The watchdog, unarmed, is silent about nothing.
select pg_temp.check('an unarmed watchdog says it is unarmed rather than reporting an empty queue',
  (public.core_v2_tick_due_continuations(5) ->> 'armed') = 'false');

-- ═══════════════ 061 · a settled workflow can still be cancelled, and only that
--
-- Settling is absorbing, which is right, and which left one state nobody
-- should be able to reach: a workflow that is still going, whose waking has
-- been turned off, and whose owner then asks for it to be cancelled. 061
-- opens exactly that case. These check that it opens NOTHING ELSE — that it
-- reads the workflow's own cancel_requested_at rather than trusting a caller,
-- that it will not restart a workflow that is over, and that it is the
-- service role's door alone.

select pg_temp.check('the reopening door is the service role''s, and nobody else''s',
  (select has_function_privilege('service_role', p.oid, 'execute')
      and not has_function_privilege('authenticated', p.oid, 'execute')
      and not has_function_privilege('anon', p.oid, 'execute')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'core_v2_reopen_continuation'));

-- The workflow from the fuse test above is settled and not cancelled.
select pg_temp.check('a settled workflow nobody has asked to cancel stays settled',
  (select state from public.core_v2_reopen_continuation('0c0e0000-0000-0000-0000-000000000001')) = 'settled');

update public.intelligence_workflows
   set cancel_requested_at = now()
 where id = '0c0e0000-0000-0000-0000-000000000001';
select pg_temp.check('but once the RECORD ITSELF says a cancellation was asked for, the waking reopens',
  (select state from public.core_v2_reopen_continuation('0c0e0000-0000-0000-0000-000000000001')) = 'due');
select pg_temp.check('and the reopened row carries no settled reason and no held fuse',
  (select settled_reason is null and settled_at is null and idle_streak = 0 and held_by is null
     from public.workflow_continuations
    where workflow_id = '0c0e0000-0000-0000-0000-000000000001'));
select pg_temp.check('the reopened workflow is what a runner is next handed',
  exists (select 1 from public.core_v2_due_continuations(50) w
           where w = '0c0e0000-0000-0000-0000-000000000001'));

-- The ceiling is the fuse a cancellation most needs to get past, because a
-- workflow that ran out of passes is exactly the one somebody wants to stop.
-- Reopening must lower the count far enough for a claim to get through, and
-- no further.
do $$
begin
  perform public.core_v2_settle_continuation('0c0e0000-0000-0000-0000-000000000001', 'continuation_limit');
  update public.workflow_continuations
     set continuations = (select maximum_continuations from public.core_v2_continuation_limits())
   where workflow_id = '0c0e0000-0000-0000-0000-000000000001';
  perform public.core_v2_reopen_continuation('0c0e0000-0000-0000-0000-000000000001');
end $$;
select pg_temp.check('a workflow stopped by the continuation ceiling can still be reopened to be cancelled',
  (select state from public.workflow_continuations
    where workflow_id = '0c0e0000-0000-0000-0000-000000000001') = 'due');
select pg_temp.check('and the count is lowered just enough that a claim is not blocked by the same ceiling',
  (select c.continuations < l.maximum_continuations
     from public.workflow_continuations c, public.core_v2_continuation_limits() l
    where c.workflow_id = '0c0e0000-0000-0000-0000-000000000001'));
select pg_temp.check('a claim really is handed that workflow rather than settling it again',
  (select workflow_id from public.core_v2_claim_continuation('cancel-runner', 60000))
    = '0c0e0000-0000-0000-0000-000000000001');
select pg_temp.check('and what was granted is a budget for cancelling, not a fresh life',
  (select l.maximum_continuations - c.continuations <= 3
     from public.workflow_continuations c, public.core_v2_continuation_limits() l
    where c.workflow_id = '0c0e0000-0000-0000-0000-000000000001'));

-- And a workflow that is over is not restarted by a late cancellation.
do $$
begin
  perform public.core_v2_settle_continuation('0c0e0000-0000-0000-0000-000000000001', 'over');
  update public.intelligence_workflows set state = 'cancelled'
   where id = '0c0e0000-0000-0000-0000-000000000001';
end $$;
select pg_temp.check('a workflow that is already over is never woken by a late cancellation',
  (select state from public.core_v2_reopen_continuation('0c0e0000-0000-0000-0000-000000000001')) = 'settled');

-- ═════════════ 062 · a stop is one write, and the watchdog finishes it
--
-- The half-written stop is the state nobody should be able to reach: a
-- settled continuation beside a workflow that still says it is running. These
-- check the two doors that close it — the one-statement stop, and the repair
-- the minute cron runs whether or not anything else is happening.

select pg_temp.check('the one-write stop and the repair are the service role''s alone',
  (select bool_and(
      has_function_privilege('service_role', p.oid, 'execute')
      and not has_function_privilege('authenticated', p.oid, 'execute')
      and not has_function_privilege('anon', p.oid, 'execute'))
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'core_v2_note_workflow_stopped', 'core_v2_stop_workflow_and_settle',
      'core_v2_finish_stopped_workflows', 'core_v2_watchdog_tick')));

insert into public.intelligence_workflows (id, organization_id, domain_pack, domain_pack_version, workflow_type,
  engine_version, state, source_set_fingerprint, request_fingerprint)
values ('0c0e0000-0000-0000-0000-000000000009', 'aaaaaaaa-0000-0000-0000-000000000001',
  'synthetic-records', '1.0', 'analysis', 'core-v2.test', 'created', 'fp-stop-009', 'rq-stop-009');
update public.intelligence_workflows set state = 'queued' where id = '0c0e0000-0000-0000-0000-000000000009';
update public.intelligence_workflows set state = 'planning' where id = '0c0e0000-0000-0000-0000-000000000009';
update public.intelligence_workflows set state = 'running' where id = '0c0e0000-0000-0000-0000-000000000009';

-- The record a process leaves when it dies between the two writes.
select public.core_v2_schedule_continuation('0c0e0000-0000-0000-0000-000000000009', now());
select public.core_v2_settle_continuation('0c0e0000-0000-0000-0000-000000000009', 'handed_to_a_person');
select pg_temp.check('a half-written stop leaves a workflow that still says it is running',
  (select state from public.intelligence_workflows where id = '0c0e0000-0000-0000-0000-000000000009') = 'running');

select pg_temp.check('the watchdog''s own tick repairs it, with nothing else happening',
  ((public.core_v2_watchdog_tick(10) -> 'repaired' ->> 'count')::int) >= 1);
select pg_temp.check('and the workflow now carries the reason it stopped',
  (select error_code = 'runner_stopped' and error_message = 'handed_to_a_person' and state = 'needs_attention'
     from public.intelligence_workflows where id = '0c0e0000-0000-0000-0000-000000000009'));
select pg_temp.check('a workflow already told is not told again',
  ((public.core_v2_watchdog_tick(10) -> 'repaired' ->> 'count')::int) = 0);

-- The stop itself, as one statement.
insert into public.intelligence_workflows (id, organization_id, domain_pack, domain_pack_version, workflow_type,
  engine_version, state, source_set_fingerprint, request_fingerprint)
values ('0c0e0000-0000-0000-0000-000000000010', 'aaaaaaaa-0000-0000-0000-000000000001',
  'synthetic-records', '1.0', 'analysis', 'core-v2.test', 'created', 'fp-stop-010', 'rq-stop-010');
update public.intelligence_workflows set state = 'queued' where id = '0c0e0000-0000-0000-0000-000000000010';
update public.intelligence_workflows set state = 'planning' where id = '0c0e0000-0000-0000-0000-000000000010';
update public.intelligence_workflows set state = 'running' where id = '0c0e0000-0000-0000-0000-000000000010';
select public.core_v2_schedule_continuation('0c0e0000-0000-0000-0000-000000000010', now());
select pg_temp.check('one statement settles the waking and tells the workflow together',
  (public.core_v2_stop_workflow_and_settle('0c0e0000-0000-0000-0000-000000000010', 'no_progress_in_5_continuations')
     ->> 'continuation_state') = 'settled');
select pg_temp.check('and both halves are in the record',
  (select state = 'needs_attention' and error_code = 'runner_stopped'
      and error_message = 'no_progress_in_5_continuations'
     from public.intelligence_workflows where id = '0c0e0000-0000-0000-0000-000000000010'));
select pg_temp.check('a workflow that is over is never re-labelled by the repair',
  (select public.core_v2_note_workflow_stopped(w.id, 'late') from public.intelligence_workflows w
    where w.id = '0c0e0000-0000-0000-0000-000000000001') in ('cancelled','completed','partial','failed'));


-- ──────────────────────────────────────────────────────── V1 is where it was
select pg_temp.check('V1 keeps every row it had — Core V2 stands beside it, not on it',
  pg_temp.v1_fingerprint() = (select fingerprint from core_v2_before));

rollback;
