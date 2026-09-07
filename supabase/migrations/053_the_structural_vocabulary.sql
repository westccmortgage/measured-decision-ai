-- 053 · The structural vocabulary.
--
-- A framing set states its countable scope in beam, header, joist, rafter,
-- post, footing and hold-down schedules the way an architectural set states
-- it in door and window schedules. Until now the record had no field for
-- those rows: on 4423 Noble the reader named FB1–FB11, HDR1–HDR4, F.J.1,
-- F.J.2, D.J.1, the ridge and hip beams and the footings — and could only
-- put them in its questions, because the contract gave it nowhere else.
--
-- The reader now records structural_members, and this distiller writes one
-- requirement per scheduled member: a printed quantity is a printed fact, a
-- mark counted drawn on the plan is a count, a member nobody could count
-- stays an open RFI. A mark an architectural schedule also uses — lighting
-- F1 beside footing F1 — keeps a key that says which. The printed general
-- rules the sheets state (framing_defaults) are project requirements with
-- their exception clause; they are shown with the members and are not
-- turned into counted rows, because a rule is not a quantity.
--
-- Same function, same signature, same grants as 042.

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

  -- The structural vocabulary (053): a framing set states its countable
  -- scope in beam, header, joist, rafter, post, footing and hold-down
  -- schedules. One requirement per scheduled member. A printed quantity is
  -- a printed fact; a mark counted drawn is a count; a member nobody could
  -- count stays an open RFI. A mark that an architectural schedule also
  -- uses (lighting F1 beside footing F1) keeps a key that says which.
  for member in select * from jsonb_array_elements(coalesce(baseline_record.analysis->'structural_members', '[]'::jsonb)) loop
    member_quantity := nullif(greatest(
      coalesce((member->>'count_scheduled')::numeric, 0),
      coalesce((member->>'count_drawn')::numeric, 0),
      coalesce((member->>'count_proposed')::numeric, 0)), 0);
    member_method := case when member_quantity is null then 'OPEN_RFI'
                          when coalesce((member->>'count_scheduled')::numeric, 0) > 0 then 'PRINTED_FACT'
                          else 'AI_PLAN_COUNT' end;
    member_confidence := case when coalesce((member->>'count_scheduled')::numeric, 0) > 0 or coalesce((member->>'count_drawn')::numeric, 0) > 0 then 'high'
                              else coalesce(nullif(member->>'count_confidence', ''), 'none') end;
    comp_key := coalesce(nullif(trim(member->>'mark'), ''), coalesce(nullif(member->>'member_type', ''), 'member'));
    if exists (
      select 1 from jsonb_array_elements(coalesce(baseline_record.analysis->'component_schedules', '[]'::jsonb)) e
      where lower(trim(e->>'mark')) = lower(trim(comp_key))
    ) then
      comp_key := comp_key || ' · ' || coalesce(nullif(member->>'member_type', ''), 'member');
    end if;
    insert into public.project_requirements (
      organization_id, property_id, baseline_id, component_key, description,
      quantity, unit, method, confidence, source_refs, job_id
    ) values (
      baseline_record.organization_id, baseline_record.property_id, p_baseline_id,
      comp_key,
      trim(coalesce(replace(member->>'member_type', '_', ' '), 'member') || ' · ' || coalesce(member->>'description', '')),
      member_quantity,
      coalesce(nullif(trim(member->>'unit'), ''), 'count'),
      member_method,
      case when member_confidence in ('high','medium','low','none') then member_confidence else 'none' end,
      coalesce(member->'source_refs', '[]'::jsonb) || coalesce(member->'detail_refs', '[]'::jsonb),
      job
    );
    written := written + 1;
    update public.intelligence_jobs set checkpoint = jsonb_build_object('written', written) where id = job;
    insert into public.processing_checkpoints (job_id, stage, cursor_value)
    values (job, 'structural_member', comp_key);
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
  'Distills a baseline''s analysis into project_requirements: framing members from framing_decks, one requirement per scheduled structural member from structural_members (a printed quantity is PRINTED_FACT, a drawn count AI_PLAN_COUNT, an uncounted member OPEN_RFI), and one requirement per component from component_schedules — schedule rows merged by (mark, category). Printed and drawn counts only — never measured by scale.';

revoke all on function public.extract_project_requirements(uuid) from public, anon;
grant execute on function public.extract_project_requirements(uuid) to authenticated;
