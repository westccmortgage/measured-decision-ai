-- The owner report: the document the pilot is sold on.
--
-- An owner's representative sends one page a week: what changed, what is
-- missing, what needs attention, what was decided, and the numbers — counted
-- by the product from its own record, never estimated. Most of that page the
-- Studio already assembles client-side from what it has loaded. What it could
-- not reach until now lives behind the audit table's owner/admin-only policy:
-- the decision log, and the counts that make an honest metrics panel.
--
-- This function hands both to the people who run the project — the same four
-- roles that approve baselines and takeoffs — for one property at a time.
-- AI actions are not decisions and are not in the log; a decision row names
-- the person who made it.

create or replace function public.owner_report_data(
  p_property_id uuid,
  p_since timestamptz default now() - interval '30 days'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  property_record public.properties%rowtype;
  actor_role public.studio_role;
  decision_log jsonb;
  decision_count integer := 0;
  report_metrics jsonb;
  rooms_missing jsonb;
  baseline_gap_count integer := 0;
  takeoff_gap_count integer := 0;
begin
  select * into property_record from public.properties where id = p_property_id;
  if property_record.id is null then
    raise exception 'That project is not in the record';
  end if;
  actor_role := public.property_role(p_property_id);
  if actor_role is null or actor_role not in ('owner', 'admin', 'reviewer', 'project_manager') then
    raise exception 'The owner report is for the people who run the project';
  end if;

  -- The decision log. Every row is a person deciding something, scoped to
  -- this property either by the property_id its detail carries or, for
  -- suggestion decisions, through the suggestion's own property.
  select coalesce(jsonb_agg(entry.value order by entry.at desc), '[]'::jsonb) into decision_log
  from (
    select e.created_at as at, jsonb_build_object(
      'at', e.created_at,
      'action', e.action,
      'actor', coalesce(u.email, 'a member of the project'),
      'entity_type', e.entity_type,
      'detail', e.detail - 'property_id'
    ) as value
    from public.audit_events e
    left join auth.users u on u.id = e.actor_id
    where e.organization_id = property_record.organization_id
      and e.created_at >= p_since
      and (
        (e.action in (
          'plan_baseline.approved', 'plan_baseline.governing_set_attested', 'takeoff.approved',
          'capture_task.waived', 'capture_task.waiver_lifted', 'vision_release.approved',
          'space_link.confirmed', 'space_link.rejected', 'space_link.added_by_person',
          'evidence.moved', 'evidence.deleted', 'evidence.restored'
        ) and e.detail->>'property_id' = p_property_id::text)
        or (e.action in ('decision.made', 'decision.changed') and exists (
          select 1
          from public.suggestion_reviews review
          join public.ai_suggestions suggestion on suggestion.id = review.suggestion_id
          where review.id::text = e.entity_id and suggestion.property_id = p_property_id
        ))
      )
    order by e.created_at desc
    limit 60
  ) entry;

  -- The metric is the true count, not the length of a capped list.
  select count(*) into decision_count
  from public.audit_events e
  where e.organization_id = property_record.organization_id
    and e.created_at >= p_since
    and (
      (e.action in (
        'plan_baseline.approved', 'plan_baseline.governing_set_attested', 'takeoff.approved',
        'capture_task.waived', 'capture_task.waiver_lifted', 'vision_release.approved',
        'space_link.confirmed', 'space_link.rejected', 'space_link.added_by_person',
        'evidence.moved', 'evidence.deleted', 'evidence.restored'
      ) and e.detail->>'property_id' = p_property_id::text)
      or (e.action in ('decision.made', 'decision.changed') and exists (
        select 1
        from public.suggestion_reviews review
        join public.ai_suggestions suggestion on suggestion.id = review.suggestion_id
        where review.id::text = e.entity_id and suggestion.property_id = p_property_id
      ))
    );

  -- Open gaps, counted from the records that hold them: the active plan
  -- baseline, and the live takeoff after the signer's answers are subtracted.
  select coalesce(jsonb_array_length(b.gaps), 0) into baseline_gap_count
  from public.document_baselines b
  where b.id = property_record.active_baseline_id;

  select coalesce((
    select count(*)::integer
    from jsonb_array_elements_text(t.gaps) gap(question)
    where not exists (
      select 1 from jsonb_array_elements(t.answers) answer(entry)
      where answer.entry->>'question' = gap.question
    )
  ), 0) into takeoff_gap_count
  from public.material_takeoffs t
  where t.property_id = p_property_id and t.state = 'approved'
  order by t.approved_at desc
  limit 1;

  select jsonb_build_object(
    'since', p_since,
    'decisions_period', decision_count,
    'evidence_added_period', (
      select count(*) from public.evidence_items
      where property_id = p_property_id and deleted_at is null and created_at >= p_since
    ),
    'rooms_total', (select count(*) from public.spaces where property_id = p_property_id),
    'rooms_with_evidence', (
      select count(distinct space_id) from public.evidence_items
      where property_id = p_property_id and deleted_at is null and space_id is not null
    ),
    'gaps_open', coalesce(baseline_gap_count, 0) + coalesce(takeoff_gap_count, 0),
    'takeoffs_signed', (
      select count(*) from public.material_takeoffs
      where property_id = p_property_id and state = 'approved'
    ),
    'releases_approved', (
      select count(*) from public.vision_releases
      where property_id = p_property_id and state = 'approved'
    )
  ) into report_metrics;

  select coalesce(jsonb_agg(s.name order by s.name), '[]'::jsonb) into rooms_missing
  from (
    select name from public.spaces
    where property_id = p_property_id
      and id not in (
        select space_id from public.evidence_items
        where property_id = p_property_id and deleted_at is null and space_id is not null
      )
    order by name
    limit 30
  ) s;

  return jsonb_build_object(
    'decisions', decision_log,
    'metrics', report_metrics,
    'rooms_without_evidence', rooms_missing
  );
end;
$$;

comment on function public.owner_report_data(uuid, timestamptz) is
  'Decision log and product-counted metrics for the owner report. For the roles that run the project; AI actions are not decisions and are not listed.';

revoke all on function public.owner_report_data(uuid, timestamptz) from public;
grant execute on function public.owner_report_data(uuid, timestamptz) to authenticated;
