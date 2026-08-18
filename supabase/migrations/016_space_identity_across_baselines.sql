-- A space is a physical room. A plan space is one baseline's description of it.
--
-- Approval used to relink only spaces whose plan_space_id was still null, and a
-- partial unique index allows one space per plan space. So a room already linked
-- to the previous baseline could not take the new baseline's plan space, and the
-- insert below created a second row for the same room. On Hutton Pl, approving
-- v11 produced 14 duplicates: the originals kept the 360 originals and photos,
-- while every new capture task pointed at the empty copies. One more duplicate
-- per room would appear on every future approval.
--
-- Approval now re-points the existing room to the new baseline's plan space,
-- matching on name, building, and level. When two rooms match the same plan
-- space, the one that already holds evidence wins, then the older one, so the
-- record stays with the room that has the history. Only a plan space with no
-- matching room at all creates a new one.

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

  -- Carry each room forward to this baseline's description of it. The link from
  -- the superseded baseline is released by the same statement, so the partial
  -- unique index on plan_space_id is never violated.
  with claim as (
    select
      ps.id as plan_space_id,
      (
        select s.id
        from public.spaces s
        where s.property_id = baseline_record.property_id
          and lower(trim(s.name)) = lower(trim(ps.name))
          and lower(trim(coalesce(s.building, ''))) = lower(trim(ps.building))
          and lower(trim(coalesce(s.level, ''))) = lower(trim(ps.level))
          and (
            s.plan_space_id is null
            or s.plan_space_id in (
              select inner_ps.id from public.plan_spaces inner_ps
              where inner_ps.property_id = baseline_record.property_id
            )
          )
        order by
          (select count(*) from public.evidence_items e where e.space_id = s.id) desc,
          s.created_at asc,
          s.id asc
        limit 1
      ) as space_id
    from public.plan_spaces ps
    where ps.baseline_id = target_baseline
  )
  update public.spaces s
  set plan_space_id = claim.plan_space_id
  from claim
  where s.id = claim.space_id
    and s.plan_space_id is distinct from claim.plan_space_id;

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
