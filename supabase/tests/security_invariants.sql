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

rollback;
