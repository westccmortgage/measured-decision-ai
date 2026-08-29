-- 042 · One mark, one requirement.
--
-- The plan reader reports schedule rows sheet by sheet, so a door that
-- appears in the door schedule and again on a floor plan came back as two
-- component_schedules entries — and the distiller wrote two requirements
-- for one physical component. Found on the real Hutton project: 101.1,
-- 104.1, 201.1 and friends each listed twice in Requirement vs evidence.
--
-- The distiller now merges schedule rows by (mark, category) before
-- writing: the strongest printed claim wins the quantity (consistent with
-- the existing greatest() rule), the fullest description survives, the
-- best stated confidence survives, and source_refs are the union — every
-- sheet that named the mark stays in the provenance. A mark that lives in
-- two categories (door 201 and window 201 are different components that
-- happen to share a number) stays two requirements, with keys that say
-- which is which. Same function, same signature, same grants.

create or replace function public.extract_project_requirements(p_baseline_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  baseline_record public.document_baselines%rowtype;
  actor_role public.studio_role;
  job uuid;
  deck jsonb;
  member jsonb;
  comp record;
  comp_key text;
  written integer := 0;
  member_quantity numeric;
  member_method text;
  member_confidence text;
begin
  select * into baseline_record from public.document_baselines where id = p_baseline_id;
  if baseline_record.id is null then
    raise exception 'That plan baseline is not in the record';
  end if;
  actor_role := public.property_role(baseline_record.property_id);
  if actor_role is null or actor_role not in ('owner', 'admin', 'reviewer', 'project_manager') then
    raise exception 'Requirement extraction runs for the people who run the project';
  end if;

  insert into public.intelligence_jobs (organization_id, property_id, channel, source_kind, source_id, state, started_at, attempts)
  values (baseline_record.organization_id, baseline_record.property_id, 'technical', 'baseline', p_baseline_id::text, 'processing', now(), 1)
  returning id into job;

  update public.project_requirements
  set state = 'superseded'
  where baseline_id = p_baseline_id and state = 'active';

  for deck in select * from jsonb_array_elements(coalesce(baseline_record.analysis->'framing_decks', '[]'::jsonb)) loop
    for member in select * from jsonb_array_elements(coalesce(deck->'beams', '[]'::jsonb) || coalesce(deck->'columns', '[]'::jsonb)) loop
      member_quantity := nullif(greatest(coalesce((member->>'count_drawn')::numeric, 0), coalesce((member->>'count_proposed')::numeric, 0)), 0);
      member_method := case when coalesce((member->>'count_drawn')::numeric, 0) > 0 then 'AI_PLAN_COUNT'
                            when member_quantity is not null then 'AI_PLAN_COUNT' else 'OPEN_RFI' end;
      member_confidence := case when coalesce((member->>'count_drawn')::numeric, 0) > 0 then 'high'
                                else coalesce(nullif(member->>'count_confidence', ''), 'none') end;
      insert into public.project_requirements (
        organization_id, property_id, baseline_id, component_key, description,
        quantity, unit, method, confidence, source_refs, job_id
      ) values (
        baseline_record.organization_id, baseline_record.property_id, p_baseline_id,
        coalesce(nullif(trim(member->>'mark'), ''), 'member'),
        coalesce(member->>'description', ''),
        member_quantity, 'count', member_method,
        case when member_confidence in ('high','medium','low','none') then member_confidence else 'none' end,
        coalesce(deck->'source_refs', '[]'::jsonb), job
      );
      written := written + 1;
      update public.intelligence_jobs set checkpoint = jsonb_build_object('written', written) where id = job;
      insert into public.processing_checkpoints (job_id, stage, cursor_value)
      values (job, 'framing_member', coalesce(member->>'mark', 'member'));
    end loop;

    if coalesce(deck->'piles'->>'description', '') <> '' then
      member_quantity := nullif(greatest(coalesce((deck->'piles'->>'count_drawn')::numeric, 0), coalesce((deck->'piles'->>'count_proposed')::numeric, 0)), 0);
      insert into public.project_requirements (
        organization_id, property_id, baseline_id, component_key, description,
        quantity, unit, method, confidence, source_refs, job_id
      ) values (
        baseline_record.organization_id, baseline_record.property_id, p_baseline_id,
        'P1', deck->'piles'->>'description', member_quantity, 'count',
        case when member_quantity is null then 'OPEN_RFI'
             when coalesce((deck->'piles'->>'count_drawn')::numeric, 0) > 0 then 'AI_PLAN_COUNT'
             else 'AI_PLAN_COUNT' end,
        coalesce(nullif(deck->'piles'->>'count_confidence', ''), 'none'),
        coalesce(deck->'source_refs', '[]'::jsonb), job
      );
      written := written + 1;
      update public.intelligence_jobs set checkpoint = jsonb_build_object('written', written) where id = job;
      insert into public.processing_checkpoints (job_id, stage, cursor_value) values (job, 'piles', 'P1');
    end if;
  end loop;

  -- The architectural vocabulary, merged before it is written: the reader
  -- reports sheet by sheet, the record speaks component by component.
  for comp in
    with schedule_rows as (
      select
        coalesce(nullif(trim(e->>'mark'), ''), nullif(trim(e->>'category'), ''), 'component') as mark_key,
        coalesce(nullif(trim(e->>'category'), ''), 'other') as category_key,
        e
      from jsonb_array_elements(coalesce(baseline_record.analysis->'component_schedules', '[]'::jsonb)) as e
    ),
    merged as (
      select
        r.mark_key,
        r.category_key,
        max(coalesce((r.e->>'count_scheduled')::numeric, 0)) as count_scheduled,
        max(coalesce((r.e->>'count_drawn')::numeric, 0)) as count_drawn,
        max(coalesce((r.e->>'count_proposed')::numeric, 0)) as count_proposed,
        (array_agg(coalesce(r.e->>'description', '') order by length(coalesce(r.e->>'description', '')) desc))[1] as description,
        (array_agg(nullif(trim(r.e->>'unit'), '')) filter (where nullif(trim(r.e->>'unit'), '') is not null))[1] as unit,
        min(case coalesce(nullif(r.e->>'count_confidence', ''), 'none')
              when 'high' then 1 when 'medium' then 2 when 'low' then 3 else 4 end) as confidence_rank,
        coalesce(jsonb_agg(distinct ref.value) filter (where ref.value is not null), '[]'::jsonb) as source_refs
      from schedule_rows r
      left join lateral jsonb_array_elements(coalesce(r.e->'source_refs', '[]'::jsonb)) as ref on true
      group by r.mark_key, r.category_key
    )
    select m.*, count(*) over (partition by m.mark_key) as categories_sharing_mark
    from merged m
    order by m.mark_key, m.category_key
  loop
    member_quantity := nullif(greatest(comp.count_scheduled, comp.count_drawn, comp.count_proposed), 0);
    member_method := case when member_quantity is null then 'OPEN_RFI' else 'AI_PLAN_COUNT' end;
    member_confidence := case
      when comp.count_scheduled > 0 or comp.count_drawn > 0 then 'high'
      else case comp.confidence_rank when 1 then 'high' when 2 then 'medium' when 3 then 'low' else 'none' end
    end;
    comp_key := case when comp.categories_sharing_mark > 1
                     then comp.mark_key || ' · ' || comp.category_key
                     else comp.mark_key end;
    insert into public.project_requirements (
      organization_id, property_id, baseline_id, component_key, description,
      quantity, unit, method, confidence, source_refs, job_id
    ) values (
      baseline_record.organization_id, baseline_record.property_id, p_baseline_id,
      comp_key,
      coalesce(comp.description, ''),
      member_quantity,
      coalesce(comp.unit, 'count'),
      member_method,
      member_confidence,
      comp.source_refs, job
    );
    written := written + 1;
    update public.intelligence_jobs set checkpoint = jsonb_build_object('written', written) where id = job;
    insert into public.processing_checkpoints (job_id, stage, cursor_value)
    values (job, 'component_schedule', comp_key);
  end loop;

  update public.intelligence_jobs
  set state = case when exists (
        select 1 from public.project_requirements
        where baseline_id = p_baseline_id and state = 'active' and method = 'OPEN_RFI'
      ) then 'complete_with_rfis' else 'complete' end,
      finished_at = now()
  where id = job;
  return job;
end;
$$;

comment on function public.extract_project_requirements(uuid) is
  'Distills a baseline''s analysis into project_requirements: framing members from framing_decks, and one requirement per component from component_schedules — schedule rows merged by (mark, category) so a mark read from several sheets is one requirement with united provenance. Printed and drawn counts only — never measured by scale.';

revoke all on function public.extract_project_requirements(uuid) from public, anon;
grant execute on function public.extract_project_requirements(uuid) to authenticated;
