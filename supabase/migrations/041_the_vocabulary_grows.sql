-- 041 · The vocabulary grows: architectural schedules become requirements.
--
-- extract_project_requirements distilled only framing members — beams,
-- columns, piles — so an architectural set (door schedules, window
-- schedules, fixture schedules) yielded zero requirements and the
-- comparison had nothing to compare against. Found on the real Hutton
-- project. The plan reader now records component_schedules (printed
-- schedules only, never measured by scale); this teaches the distiller to
-- read them. Same function, same signature, same grants — one new loop.

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
  component jsonb;
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

  -- The architectural vocabulary: one requirement per printed schedule row.
  -- The schedule's own printed quantity is the strongest claim, then marks
  -- counted drawn on the plans, then the reader's proposal — never a number
  -- derived from area, scale, or typical practice.
  for component in select * from jsonb_array_elements(coalesce(baseline_record.analysis->'component_schedules', '[]'::jsonb)) loop
    member_quantity := nullif(greatest(
      coalesce((component->>'count_scheduled')::numeric, 0),
      coalesce((component->>'count_drawn')::numeric, 0),
      coalesce((component->>'count_proposed')::numeric, 0)), 0);
    member_method := case when member_quantity is null then 'OPEN_RFI' else 'AI_PLAN_COUNT' end;
    member_confidence := case
      when coalesce((component->>'count_scheduled')::numeric, 0) > 0
        or coalesce((component->>'count_drawn')::numeric, 0) > 0 then 'high'
      else coalesce(nullif(component->>'count_confidence', ''), 'none') end;
    insert into public.project_requirements (
      organization_id, property_id, baseline_id, component_key, description,
      quantity, unit, method, confidence, source_refs, job_id
    ) values (
      baseline_record.organization_id, baseline_record.property_id, p_baseline_id,
      coalesce(nullif(trim(component->>'mark'), ''), coalesce(nullif(trim(component->>'category'), ''), 'component')),
      coalesce(component->>'description', ''),
      member_quantity,
      coalesce(nullif(trim(component->>'unit'), ''), 'count'),
      member_method,
      case when member_confidence in ('high','medium','low','none') then member_confidence else 'none' end,
      coalesce(component->'source_refs', '[]'::jsonb), job
    );
    written := written + 1;
    update public.intelligence_jobs set checkpoint = jsonb_build_object('written', written) where id = job;
    insert into public.processing_checkpoints (job_id, stage, cursor_value)
    values (job, 'component_schedule', coalesce(component->>'mark', 'component'));
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
  'Distills a baseline''s analysis into project_requirements: framing members from framing_decks, and one requirement per printed architectural schedule row from component_schedules. Printed and drawn counts only — never measured by scale.';

revoke all on function public.extract_project_requirements(uuid) from public, anon;
grant execute on function public.extract_project_requirements(uuid) to authenticated;
