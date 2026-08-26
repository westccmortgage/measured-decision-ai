-- The channels fill themselves.
--
-- Reconciliation shipped with the doors open but nothing walking through
-- them. This migration makes two things automatic, both on the existing
-- record — no new pipelines:
--
--   1. Capture coverage derives itself from the evidence that already
--      exists: which rooms hold a playable 360, which hold nothing. The
--      automation NEVER claims 'full' — a machine that has not walked the
--      site cannot promise nothing was missed, and only a person (or a
--      future vision pass a person reviews) may say 'full'. Since a
--      shortfall only becomes CONFLICTING under full coverage, automation
--      alone can never manufacture a conflict. That asymmetry is the point.
--
--   2. Reconciliation derives coverage before it compares, and falls back
--      from component-level coverage to the project-wide reading, so it is
--      self-sufficient: one call, honest verdicts.
--
-- Also: invoices become a first-class document discipline, so the
-- document-evidence worker has a declared source to read.

alter table public.project_documents drop constraint if exists project_documents_document_type_check;
alter table public.project_documents add constraint project_documents_document_type_check
  check (document_type in (
    'architectural', 'structural', 'mechanical', 'electrical', 'plumbing',
    'civil', 'landscape', 'specification', 'schedule', 'permit',
    'addendum', 'change_order', 'invoice', 'delivery_ticket', 'receipt', 'other'
  ));

-- Project-wide coverage, read from the record. component_key '*' is the
-- fallback every component inherits unless it has its own coverage row.
create or replace function public.derive_capture_coverage(p_property_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  property_record public.properties%rowtype;
  rooms_total integer;
  rooms_with_spatial integer;
  derived text;
  coverage_note text;
begin
  select * into property_record from public.properties where id = p_property_id;
  if property_record.id is null then
    raise exception 'That project is not in the record';
  end if;
  if public.property_role(p_property_id) is null then
    raise exception 'Coverage derives for the project''s own people';
  end if;

  select count(*) into rooms_total from public.spaces where property_id = p_property_id;
  select count(distinct space_id) into rooms_with_spatial
  from public.evidence_items
  where property_id = p_property_id and deleted_at is null and space_id is not null
    and (media_type ilike '%360%' or media_type ilike '%spatial%' or original_filename ilike '%.insv');

  if rooms_with_spatial = 0 then
    derived := 'none';
    coverage_note := 'No playable 360 capture in the record yet.';
  else
    -- Never 'full' from automation: presence of captures does not prove
    -- nothing was missed. 'full' is a human''s statement to make.
    derived := 'partial';
    coverage_note := format('%s of %s room%s hold a 360 capture. Automation never claims full coverage; a person states that after walking the record.',
      rooms_with_spatial, rooms_total, case when rooms_total = 1 then '' else 's' end);
  end if;

  update public.project_observations
  set state = 'superseded'
  where property_id = p_property_id and state = 'active'
    and component_key = '*' and kind = 'capture_coverage' and method = 'AI_VISION';

  insert into public.project_observations (
    organization_id, property_id, channel, component_key, kind,
    coverage, method, confidence, note
  ) values (
    property_record.organization_id, p_property_id, 'visual', '*', 'capture_coverage',
    derived, 'AI_VISION', 'medium', coverage_note
  );
end;
$$;

comment on function public.derive_capture_coverage(uuid) is
  'Project-wide capture coverage read from the existing evidence record. Never claims full — only a person may — so automation alone can never manufacture a conflict.';

-- Reconciliation, now self-sufficient: derives coverage first, then falls
-- back component → '*' when a component has no coverage of its own.
create or replace function public.reconcile_project(p_property_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  property_record public.properties%rowtype;
  actor_role public.studio_role;
  job uuid;
  requirement record;
  installed numeric;
  delivered numeric;
  best_coverage text;
  component_verdict text;
  component_narrative text;
  remaining numeric;
begin
  select * into property_record from public.properties where id = p_property_id;
  if property_record.id is null then
    raise exception 'That project is not in the record';
  end if;
  actor_role := public.property_role(p_property_id);
  if actor_role is null or actor_role not in ('owner', 'admin', 'reviewer', 'project_manager') then
    raise exception 'Reconciliation runs for the people who run the project';
  end if;

  perform public.derive_capture_coverage(p_property_id);

  insert into public.intelligence_jobs (organization_id, property_id, channel, source_kind, source_id, state, started_at, attempts)
  values (property_record.organization_id, p_property_id, 'reconciliation', 'property', p_property_id::text, 'processing', now(), 1)
  returning id into job;

  update public.project_reconciliations
  set state = 'superseded'
  where property_id = p_property_id and state = 'active';

  for requirement in
    select * from public.project_requirements
    where property_id = p_property_id and state = 'active'
  loop
    select coalesce(sum(quantity), 0) into installed
    from public.project_observations
    where property_id = p_property_id and state = 'active'
      and component_key = requirement.component_key and kind = 'installed_seen';

    select sum(quantity) into delivered
    from public.project_observations
    where property_id = p_property_id and state = 'active'
      and component_key = requirement.component_key and kind = 'delivered_documented';

    -- Component coverage first; the project-wide '*' reading as fallback.
    select coalesce(min(case coverage when 'full' then 1 when 'partial' then 2 when 'none' then 3 end), 4) into best_coverage
    from public.project_observations
    where property_id = p_property_id and state = 'active'
      and component_key = requirement.component_key and kind = 'capture_coverage';
    if best_coverage = '4' then
      select coalesce(min(case coverage when 'full' then 1 when 'partial' then 2 when 'none' then 3 end), 4) into best_coverage
      from public.project_observations
      where property_id = p_property_id and state = 'active'
        and component_key = '*' and kind = 'capture_coverage';
    end if;
    best_coverage := case best_coverage when '1' then 'full' when '2' then 'partial' when '3' then 'none' else 'unknown' end;

    if requirement.quantity is null then
      component_verdict := 'UNKNOWN';
      component_narrative := 'The documents name this component but print no quantity to compare against.';
    elsif installed >= requirement.quantity then
      component_verdict := 'SUPPORTED';
      component_narrative := format('%s required · %s visually evidenced as installed.', requirement.quantity, installed);
    else
      remaining := requirement.quantity - installed;
      if installed = 0 and best_coverage <> 'full' then
        component_verdict := 'NOT_EVIDENCED';
      elsif best_coverage = 'full' then
        component_verdict := 'CONFLICTING';
      else
        component_verdict := 'PARTIALLY_SUPPORTED';
      end if;
      component_narrative := format('%s required', requirement.quantity)
        || case when delivered is not null then format(' · %s documented as delivered', delivered) else '' end
        || format(' · %s visually evidenced as installed', installed)
        || case when component_verdict = 'CONFLICTING'
             then format(' · %s missing under full capture coverage — conflict', remaining)
             else format(' · %s installation record%s not yet evidenced', remaining, case when remaining = 1 then '' else 's' end)
           end;
    end if;

    insert into public.project_reconciliations (
      organization_id, property_id, requirement_id, component_key,
      required_quantity, delivered_quantity, evidenced_quantity,
      coverage, verdict, narrative, job_id
    ) values (
      property_record.organization_id, p_property_id, requirement.id, requirement.component_key,
      requirement.quantity, delivered, installed, best_coverage, component_verdict, component_narrative, job
    );
    insert into public.processing_checkpoints (job_id, stage, cursor_value)
    values (job, 'component', requirement.component_key);
  end loop;

  update public.intelligence_jobs
  set state = case when exists (
        select 1 from public.project_reconciliations
        where property_id = p_property_id and state = 'active'
          and verdict in ('NOT_EVIDENCED', 'UNKNOWN', 'CONFLICTING')
      ) then 'complete_with_rfis' else 'complete' end,
      finished_at = now()
  where id = job;
  return job;
end;
$$;

revoke all on function public.derive_capture_coverage(uuid) from public;
grant execute on function public.derive_capture_coverage(uuid) to authenticated;
