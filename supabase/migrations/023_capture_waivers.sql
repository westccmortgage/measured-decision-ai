-- A gap that will never be filled has to be closable — by a person, with a
-- reason, on the record.
--
-- The roadmap a plan set produces asks for evidence of every phase, including
-- phases that finished before anyone started keeping a record. Demolition and
-- foundation on a house somebody buys mid-project are the ordinary case, not
-- the exception. Until now those items stayed "blocked" for ever: the record
-- was permanently red about something nobody would ever photograph, and a
-- record that is permanently wrong stops being read.
--
-- What this is not: it is not deletion, and it is not completion. The record
-- keeps saying no evidence exists. What changes is that a named person with the
-- authority to say so accepted that, gave a reason, and it stops being asked
-- again. Anyone reading the project later sees the acceptance and who made it.
--
-- Two kinds, because they mean different things to whoever reads the record:
--   not_applicable      — this work is not part of this project at all
--   accepted_no_evidence — it happened, and no evidence of it exists
--
-- Known limit, stated rather than hidden: capture tasks belong to a baseline,
-- so approving a new baseline creates new tasks and the waivers do not follow
-- them. Carrying acceptance across baselines needs the same identity work that
-- 016 did for spaces, and is not attempted here.

alter table public.capture_tasks
  add column if not exists waiver_kind text
    check (waiver_kind is null or waiver_kind in ('not_applicable', 'accepted_no_evidence')),
  add column if not exists waiver_reason text,
  add column if not exists waived_by uuid references auth.users(id),
  add column if not exists waived_at timestamptz;

comment on column public.capture_tasks.waiver_reason is
  'Why a named person accepted this capture never being made. The absence of evidence is unchanged and still reported.';

-- One person accepts one capture that will not be made.
create or replace function public.waive_capture_task(
  p_task_id uuid,
  p_kind text,
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  task_record public.capture_tasks%rowtype;
  actor_role public.studio_role;
  normalized_reason text;
  evidence_count integer;
begin
  normalized_reason := nullif(trim(p_reason), '');
  if normalized_reason is null or char_length(normalized_reason) < 10 then
    raise exception 'Say why this capture will not be made — a reader of this record needs the reason, not the fact alone';
  end if;

  if p_kind not in ('not_applicable', 'accepted_no_evidence') then
    raise exception 'A waiver is either not_applicable or accepted_no_evidence';
  end if;

  select * into task_record from public.capture_tasks where id = p_task_id for update;
  if task_record.id is null then
    raise exception 'Capture task not found';
  end if;

  select role into actor_role
  from public.organization_members
  where organization_id = task_record.organization_id
    and user_id = auth.uid();

  -- The same people who may approve a baseline may accept a gap in it.
  if actor_role is null or actor_role not in ('owner', 'admin', 'reviewer', 'project_manager') then
    raise exception 'Only an owner, administrator, reviewer or project manager can accept a missing capture';
  end if;

  if task_record.status = 'verified' then
    raise exception 'This capture is already recorded and verified — there is nothing to accept';
  end if;

  -- Evidence that exists is not a gap. Waiving here would hide a real record
  -- behind a sentence saying none was made.
  select count(*) into evidence_count
  from public.evidence_items
  where capture_task_id = task_record.id and deleted_at is null;
  if evidence_count > 0 then
    raise exception 'Evidence has already been added to this capture — review it instead of accepting it as missing';
  end if;

  update public.capture_tasks
  set status = 'waived',
      waiver_kind = p_kind,
      waiver_reason = normalized_reason,
      waived_by = auth.uid(),
      waived_at = now(),
      updated_at = now()
  where id = p_task_id;

  insert into public.audit_events (
    organization_id, actor_id, action, entity_type, entity_id, detail
  ) values (
    task_record.organization_id, auth.uid(), 'capture_task.waived',
    'capture_task', p_task_id::text,
    jsonb_build_object(
      'property_id', task_record.property_id,
      'baseline_id', task_record.baseline_id,
      'previous_status', task_record.status,
      'kind', p_kind,
      'reason', normalized_reason
    )
  );

  return p_task_id;
end;
$$;

-- A whole phase at once, because "we were not here for the demolition" is one
-- decision about one phase, not eleven decisions about eleven captures.
create or replace function public.waive_capture_phase(
  p_baseline_id uuid,
  p_phase_id uuid,
  p_kind text,
  p_reason text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  task_id uuid;
  waived integer := 0;
begin
  for task_id in
    select task.id
    from public.capture_tasks task
    join public.capture_requirements requirement on requirement.id = task.requirement_id
    where task.baseline_id = p_baseline_id
      and requirement.phase_id = p_phase_id
      and task.status not in ('verified', 'waived')
      and not exists (
        select 1 from public.evidence_items evidence
        where evidence.capture_task_id = task.id and evidence.deleted_at is null
      )
  loop
    perform public.waive_capture_task(task_id, p_kind, p_reason);
    waived := waived + 1;
  end loop;

  if waived = 0 then
    raise exception 'Nothing in this phase is waitable — every capture in it is already recorded or already accepted';
  end if;

  return waived;
end;
$$;

-- Acceptance is not permanent. Evidence can turn up, and a decision made on
-- bad information can be withdrawn; both leave the earlier acceptance in the
-- audit record.
create or replace function public.lift_capture_waiver(p_task_id uuid, p_reason text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  task_record public.capture_tasks%rowtype;
  actor_role public.studio_role;
begin
  select * into task_record from public.capture_tasks where id = p_task_id for update;
  if task_record.id is null then
    raise exception 'Capture task not found';
  end if;
  if task_record.status <> 'waived' then
    raise exception 'This capture has not been accepted as missing';
  end if;

  select role into actor_role
  from public.organization_members
  where organization_id = task_record.organization_id
    and user_id = auth.uid();
  if actor_role is null or actor_role not in ('owner', 'admin', 'reviewer', 'project_manager') then
    raise exception 'Only an owner, administrator, reviewer or project manager can reopen an accepted capture';
  end if;

  update public.capture_tasks
  set status = case when task_record.space_id is null then 'blocked' else 'ready' end,
      waiver_kind = null,
      waiver_reason = null,
      waived_by = null,
      waived_at = null,
      updated_at = now()
  where id = p_task_id;

  insert into public.audit_events (
    organization_id, actor_id, action, entity_type, entity_id, detail
  ) values (
    task_record.organization_id, auth.uid(), 'capture_task.waiver_lifted',
    'capture_task', p_task_id::text,
    jsonb_build_object(
      'property_id', task_record.property_id,
      'baseline_id', task_record.baseline_id,
      'previous_reason', task_record.waiver_reason,
      'reason', nullif(trim(coalesce(p_reason, '')), '')
    )
  );

  return p_task_id;
end;
$$;

revoke all on function public.waive_capture_task(uuid, text, text) from public;
revoke all on function public.waive_capture_phase(uuid, uuid, text, text) from public;
revoke all on function public.lift_capture_waiver(uuid, text) from public;
grant execute on function public.waive_capture_task(uuid, text, text) to authenticated;
grant execute on function public.waive_capture_phase(uuid, uuid, text, text) to authenticated;
grant execute on function public.lift_capture_waiver(uuid, text) to authenticated;

comment on function public.waive_capture_task(uuid, text, text) is
  'A named person accepts that one planned capture will never be made, and says why. The missing evidence stays missing in the record.';
comment on function public.waive_capture_phase(uuid, uuid, text, text) is
  'The same acceptance applied to every outstanding capture in one phase.';
comment on function public.lift_capture_waiver(uuid, text) is
  'Withdraws an acceptance and returns the capture to the roadmap.';
