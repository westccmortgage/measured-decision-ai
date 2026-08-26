-- A person answers what the sheets did not.
--
-- The takeoff draft carries gaps the AI refused to guess at: drawn marks it
-- could not count with confidence, a guardrail with no printed run. Counting
-- the P1 circles on a foundation plan is reading the drawing — and a person
-- standing in front of the sheet can do it where the model could not. Without
-- a place to write that number down, a gap is a dead end; with one, it is a
-- question with a named, signed answer.
--
-- The answers ride with the approval, verbatim, attributed to the approver.
-- They are the person's reading, shown as such — never merged silently into
-- the calculator's lines, never presented as something the AI read.

alter table public.material_takeoffs
  add column if not exists answers jsonb not null default '[]'::jsonb;

comment on column public.material_takeoffs.answers is
  'Gap answers supplied by the approver at signing: [{question, answer}], verbatim. The person''s reading of the sheets, attributed to them by approved_by.';

-- The signature grows one argument. The old shape is dropped, not overloaded:
-- two candidates with a default argument would make every call ambiguous.
drop function if exists public.approve_material_takeoff(uuid, text, jsonb, jsonb, jsonb, integer, text, text);

create or replace function public.approve_material_takeoff(
  p_baseline_id uuid,
  p_kind text,
  p_lines jsonb,
  p_traces jsonb,
  p_gaps jsonb,
  p_measured_walls integer,
  p_calculator_version text,
  p_note text default null,
  p_answers jsonb default '[]'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  baseline_record public.document_baselines%rowtype;
  actor_role public.studio_role;
  answer jsonb;
  new_id uuid;
begin
  if p_kind not in ('wood_framing') then
    raise exception 'That is not a takeoff this record knows';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'A takeoff with no lines is not a takeoff';
  end if;
  if jsonb_typeof(coalesce(p_answers, '[]'::jsonb)) <> 'array' then
    raise exception 'Answers arrive as a list of question and answer pairs';
  end if;
  for answer in select * from jsonb_array_elements(coalesce(p_answers, '[]'::jsonb)) loop
    if jsonb_typeof(answer) <> 'object'
       or nullif(trim(coalesce(answer->>'question', '')), '') is null
       or nullif(trim(coalesce(answer->>'answer', '')), '') is null then
      raise exception 'An answer that does not say what it answers is not an answer';
    end if;
  end loop;

  select * into baseline_record from public.document_baselines where id = p_baseline_id;
  if baseline_record.id is null then
    raise exception 'That plan baseline is not in the record';
  end if;

  -- The same authority that approves the roadmap approves the material it
  -- implies. The definer bypasses row-level security, so this is checked here.
  actor_role := public.property_role(baseline_record.property_id);
  if actor_role is null or actor_role not in ('owner', 'admin', 'reviewer', 'project_manager') then
    raise exception 'Only an owner, administrator, reviewer or project manager can approve a takeoff';
  end if;

  -- One live takeoff per kind per baseline. The old one is superseded, never
  -- overwritten: what was signed stays what was signed.
  update public.material_takeoffs
  set state = 'superseded'
  where baseline_id = p_baseline_id and kind = p_kind and state = 'approved';

  insert into public.material_takeoffs (
    organization_id, property_id, baseline_id, kind,
    lines, traces, gaps, measured_walls, answers,
    calculator_version, agent_contract_version,
    approved_by, note
  ) values (
    baseline_record.organization_id, baseline_record.property_id, p_baseline_id, p_kind,
    p_lines, coalesce(p_traces, '[]'::jsonb), coalesce(p_gaps, '[]'::jsonb),
    greatest(0, coalesce(p_measured_walls, 0)), coalesce(p_answers, '[]'::jsonb),
    coalesce(nullif(trim(p_calculator_version), ''), 'unknown'),
    baseline_record.agent_contract_version,
    auth.uid(), nullif(trim(coalesce(p_note, '')), '')
  ) returning id into new_id;

  insert into public.audit_events (
    organization_id, actor_id, action, entity_type, entity_id, detail
  ) values (
    baseline_record.organization_id, auth.uid(), 'takeoff.approved',
    'material_takeoff', new_id::text,
    jsonb_build_object(
      'property_id', baseline_record.property_id,
      'baseline_id', p_baseline_id,
      'kind', p_kind,
      'line_count', jsonb_array_length(p_lines),
      'gap_count', jsonb_array_length(coalesce(p_gaps, '[]'::jsonb)),
      'answer_count', jsonb_array_length(coalesce(p_answers, '[]'::jsonb)),
      'measured_walls', greatest(0, coalesce(p_measured_walls, 0)),
      'note', nullif(trim(coalesce(p_note, '')), '')
    )
  );

  return new_id;
end;
$$;

comment on function public.approve_material_takeoff(uuid, text, jsonb, jsonb, jsonb, integer, text, text, jsonb) is
  'A person signs the draft lumber order computed from the plans, answering the gaps the sheets left open. Supersedes, never overwrites; draft and answers are stored verbatim.';

revoke all on function public.approve_material_takeoff(uuid, text, jsonb, jsonb, jsonb, integer, text, text, jsonb) from public;
grant execute on function public.approve_material_takeoff(uuid, text, jsonb, jsonb, jsonb, integer, text, text, jsonb) to authenticated;
