-- Human governance for an approved plan set whose status cannot be established
-- from the PDF content alone. AI gaps remain preserved; a named manager records
-- the authority for using the set as the field-capture baseline.

alter table public.document_baselines
  add column if not exists governance_attestation jsonb not null default '{}'::jsonb;

create or replace function public.approve_document_baseline(target_baseline uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  baseline_record public.document_baselines%rowtype;
  actor_role public.studio_role;
  has_blocking_gaps boolean;
  has_governing_attestation boolean;
begin
  select * into baseline_record
  from public.document_baselines
  where id = target_baseline
  for update;

  if baseline_record.id is null then
    raise exception 'Baseline not found';
  end if;

  select role into actor_role
  from public.organization_members
  where organization_id = baseline_record.organization_id
    and user_id = auth.uid();

  if actor_role is null or actor_role not in ('owner', 'admin', 'reviewer') then
    raise exception 'Not authorized to approve this baseline';
  end if;

  if baseline_record.state not in ('draft', 'review') then
    raise exception 'Only a draft or review baseline can be approved';
  end if;

  has_blocking_gaps := jsonb_path_exists(
    baseline_record.gaps,
    '$[*] ? (@.blocks_activation == true)'
  );
  has_governing_attestation :=
    baseline_record.governance_attestation ->> 'status' = 'official_approved'
    and nullif(trim(baseline_record.governance_attestation ->> 'approval_reference'), '') is not null
    and nullif(trim(baseline_record.governance_attestation ->> 'confirmed_by'), '') is not null
    and nullif(trim(baseline_record.governance_attestation ->> 'confirmed_at'), '') is not null;

  if has_blocking_gaps and not has_governing_attestation then
    raise exception 'Resolve blocking plan gaps or record governing-set confirmation before approval';
  end if;

  update public.document_baselines
  set state = 'superseded'
  where property_id = baseline_record.property_id
    and state = 'approved'
    and id <> target_baseline;

  update public.document_baselines
  set state = 'approved', approved_by = auth.uid(), approved_at = now()
  where id = target_baseline;

  update public.spaces s
  set plan_space_id = ps.id
  from public.plan_spaces ps
  where ps.baseline_id = target_baseline
    and s.property_id = baseline_record.property_id
    and s.plan_space_id is null
    and lower(trim(s.name)) = lower(trim(ps.name))
    and lower(trim(coalesce(s.building, ''))) = lower(trim(ps.building))
    and lower(trim(coalesce(s.level, ''))) = lower(trim(ps.level));

  insert into public.spaces (
    organization_id, property_id, name, building, level,
    review_state, created_by, plan_space_id
  )
  select
    ps.organization_id, ps.property_id, ps.name, ps.building, ps.level,
    'needs_review', auth.uid(), ps.id
  from public.plan_spaces ps
  where ps.baseline_id = target_baseline
    and not exists (
      select 1 from public.spaces s where s.plan_space_id = ps.id
    );

  update public.capture_tasks task
  set status = 'ready',
      space_id = s.id,
      updated_at = now()
  from public.capture_requirements requirement
  left join public.spaces s on s.plan_space_id = requirement.plan_space_id
  where task.requirement_id = requirement.id
    and task.baseline_id = target_baseline
    and task.status = 'blocked';

  update public.properties
  set workflow_state = 'active', active_baseline_id = target_baseline, updated_at = now()
  where id = baseline_record.property_id;

  insert into public.audit_events (
    organization_id, actor_id, action, entity_type, entity_id, detail
  ) values (
    baseline_record.organization_id, auth.uid(), 'plan_baseline.approved',
    'document_baseline', target_baseline::text,
    jsonb_build_object(
      'property_id', baseline_record.property_id,
      'version', baseline_record.version,
      'governing_attestation_used', has_governing_attestation
    )
  );

  return target_baseline;
end;
$$;

revoke all on function public.approve_document_baseline(uuid) from public;
grant execute on function public.approve_document_baseline(uuid) to authenticated;

create or replace function public.attest_and_approve_document_baseline(
  target_baseline uuid,
  approval_reference text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  baseline_record public.document_baselines%rowtype;
  actor_role public.studio_role;
  blocker_snapshot jsonb;
  normalized_reference text;
begin
  normalized_reference := nullif(trim(approval_reference), '');
  if normalized_reference is null or char_length(normalized_reference) < 3 then
    raise exception 'Enter the permit, approval stamp, approval email, or other governing-set reference';
  end if;

  select * into baseline_record
  from public.document_baselines
  where id = target_baseline
  for update;

  if baseline_record.id is null then
    raise exception 'Baseline not found';
  end if;

  select role into actor_role
  from public.organization_members
  where organization_id = baseline_record.organization_id
    and user_id = auth.uid();

  if actor_role is null or actor_role not in ('owner', 'admin', 'reviewer') then
    raise exception 'Not authorized to confirm this governing set';
  end if;

  if baseline_record.state not in ('draft', 'review') then
    raise exception 'Only a draft or review baseline can be confirmed';
  end if;

  blocker_snapshot := jsonb_path_query_array(
    baseline_record.gaps,
    '$[*] ? (@.blocks_activation == true)'
  );

  update public.document_baselines
  set governance_attestation = jsonb_build_object(
    'status', 'official_approved',
    'approval_reference', normalized_reference,
    'confirmation', 'Authorized manager confirmed the selected source documents are the official approved governing set for field-capture planning.',
    'confirmed_by', auth.uid(),
    'confirmed_at', now(),
    'blocking_gaps_snapshot', blocker_snapshot
  )
  where id = target_baseline;

  insert into public.audit_events (
    organization_id, actor_id, action, entity_type, entity_id, detail
  ) values (
    baseline_record.organization_id, auth.uid(), 'plan_baseline.governing_set_attested',
    'document_baseline', target_baseline::text,
    jsonb_build_object(
      'property_id', baseline_record.property_id,
      'version', baseline_record.version,
      'approval_reference', normalized_reference,
      'blocking_gap_count', jsonb_array_length(blocker_snapshot)
    )
  );

  return public.approve_document_baseline(target_baseline);
end;
$$;

revoke all on function public.attest_and_approve_document_baseline(uuid, text) from public;
grant execute on function public.attest_and_approve_document_baseline(uuid, text) to authenticated;

comment on column public.document_baselines.governance_attestation is
  'Named human confirmation of the governing approved plan set. AI-reported gaps remain unchanged and auditable.';
comment on function public.attest_and_approve_document_baseline(uuid, text) is
  'Records a governing-set reference and atomically activates its field-capture roadmap.';
