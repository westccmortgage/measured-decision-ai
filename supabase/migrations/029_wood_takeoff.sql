-- A draft lumber order, read from the plans and approved by a person.
--
-- The pipeline: the plan agent extracts the dimensions a sheet actually PRINTS
-- — never measured by scale — each with its sheet citation. A deterministic
-- calculator in the Studio turns those into lumber counts by stated framing
-- conventions, with the arithmetic shown. What lands here is the moment a
-- person looked at that draft and signed it.
--
-- What this is not: a contractor's estimate. Waste, cut optimisation and
-- regional practice are a builder's judgement, and every screen showing a
-- takeoff says so. The approval records that a person accepted the draft as a
-- verification baseline — material the plans imply — not that anybody promised
-- a price or a purchase.
--
-- Lines and traces are stored as approved, verbatim. A takeoff whose numbers
-- could drift after signature is not a record of what was signed.

create table if not exists public.material_takeoffs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  baseline_id uuid not null references public.document_baselines(id) on delete cascade,
  kind text not null default 'wood_framing'
    check (kind in ('wood_framing')),
  -- The order draft: [{item, quantity, unit}], exactly as approved.
  lines jsonb not null,
  -- The arithmetic behind every line, wall by wall, with sheet citations.
  traces jsonb not null default '[]'::jsonb,
  -- What could not be computed and why: unmeasured walls, widthless openings.
  gaps jsonb not null default '[]'::jsonb,
  measured_walls integer not null default 0,
  calculator_version text not null,
  agent_contract_version text not null,
  state text not null default 'approved'
    check (state in ('approved', 'superseded')),
  approved_by uuid not null references auth.users(id),
  approved_at timestamptz not null default now(),
  note text,
  created_at timestamptz not null default now()
);

create index if not exists material_takeoffs_baseline_idx
  on public.material_takeoffs(baseline_id, kind, state);

comment on table public.material_takeoffs is
  'Draft lumber orders computed from printed plan dimensions and approved by a person. A verification baseline, not an estimate.';

alter table public.material_takeoffs enable row level security;

drop policy if exists material_takeoffs_read on public.material_takeoffs;
create policy material_takeoffs_read on public.material_takeoffs for select
using (public.is_org_member(organization_id));

-- Writes go through the RPC below, so the approval can be checked and audited.

create or replace function public.approve_material_takeoff(
  p_baseline_id uuid,
  p_kind text,
  p_lines jsonb,
  p_traces jsonb,
  p_gaps jsonb,
  p_measured_walls integer,
  p_calculator_version text,
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  baseline_record public.document_baselines%rowtype;
  actor_role public.studio_role;
  new_id uuid;
begin
  if p_kind not in ('wood_framing') then
    raise exception 'That is not a takeoff this record knows';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'A takeoff with no lines is not a takeoff';
  end if;

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
    lines, traces, gaps, measured_walls,
    calculator_version, agent_contract_version,
    approved_by, note
  ) values (
    baseline_record.organization_id, baseline_record.property_id, p_baseline_id, p_kind,
    p_lines, coalesce(p_traces, '[]'::jsonb), coalesce(p_gaps, '[]'::jsonb),
    greatest(0, coalesce(p_measured_walls, 0)),
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
      'measured_walls', greatest(0, coalesce(p_measured_walls, 0)),
      'note', nullif(trim(coalesce(p_note, '')), '')
    )
  );

  return new_id;
end;
$$;

comment on function public.approve_material_takeoff(uuid, text, jsonb, jsonb, jsonb, integer, text, text) is
  'A person signs the draft lumber order computed from the plans. Supersedes, never overwrites; the draft is stored verbatim.';

revoke all on function public.approve_material_takeoff(uuid, text, jsonb, jsonb, jsonb, integer, text, text) from public;
grant execute on function public.approve_material_takeoff(uuid, text, jsonb, jsonb, jsonb, integer, text, text) to authenticated;
