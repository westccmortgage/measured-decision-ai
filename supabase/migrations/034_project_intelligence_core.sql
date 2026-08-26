-- Project Intelligence Core v1: two channels, one project model.
--
-- The platform already runs two working pipelines: the visual one
-- (360/photo/video through the GPU worker into evidence_items and spaces,
-- viewable to Vision Pro) and the technical one (plan sets through
-- plan-analyze into document_baselines and material_takeoffs). What was
-- missing is the seam: a structured layer where what the DOCUMENTS REQUIRE
-- meets what the EVIDENCE SHOWS, per component, with honest verdicts.
--
-- Three doctrines are load-bearing here:
--   1. Absence of evidence is not evidence of absence. A shortfall only
--      becomes a CONFLICT when capture coverage of the relevant area is
--      known to be full; otherwise it is "not yet evidenced".
--   2. Delivery is not installation. An invoice moves the narrative, never
--      the verdict.
--   3. The owner enters nothing. These tables are written by the channels
--      and their workers; the owner looks at the reconciliation.

-- ────────────────────────────────────────────────── jobs and checkpoints
-- Resumable processing for every channel. plan_analysis_jobs stays what it
-- is (the technical channel's provider-facing job); this is the umbrella
-- record any channel can use, with explicit checkpoints so an interrupted
-- worker resumes instead of restarting.

create table if not exists public.intelligence_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  channel text not null check (channel in ('technical', 'visual', 'documents', 'reconciliation')),
  source_kind text not null default 'baseline',
  source_id text,
  state text not null default 'queued'
    check (state in ('queued', 'processing', 'complete', 'complete_with_rfis', 'failed')),
  checkpoint jsonb not null default '{}'::jsonb,
  attempts integer not null default 0,
  error_message text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.processing_checkpoints (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.intelligence_jobs(id) on delete cascade,
  stage text not null,
  cursor_value text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- ────────────────────────────────────────────────── the shared model
-- What the technical documents require, one row per component, with the
-- same provenance statuses the takeoff wears.

create table if not exists public.project_requirements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  baseline_id uuid not null references public.document_baselines(id) on delete cascade,
  channel text not null default 'technical' check (channel in ('technical')),
  -- The shared component identity both channels speak: 'P1', 'COL.1',
  -- 'DECK BM', '2x6 deck boards'. Observations use the same keys.
  component_key text not null,
  description text not null default '',
  quantity numeric,
  unit text not null default 'count',
  method text not null check (method in (
    'PRINTED_FACT', 'AI_PLAN_COUNT', 'DERIVED_FROM_PRINTED_DIMENSIONS',
    'AI_SCALED_ESTIMATE', 'ESTIMATOR_ALLOWANCE', 'OPEN_RFI', 'HOLD', 'EXCLUDED', 'HUMAN_CONFIRMED'
  )),
  confidence text not null default 'medium' check (confidence in ('high', 'medium', 'low', 'none')),
  source_refs jsonb not null default '[]'::jsonb,
  job_id uuid references public.intelligence_jobs(id) on delete set null,
  state text not null default 'active' check (state in ('active', 'superseded')),
  created_at timestamptz not null default now()
);

create index if not exists project_requirements_lookup
  on public.project_requirements(property_id, state, component_key);

-- What the visual and documentary evidence shows. Kinds keep delivery,
-- presence and coverage apart on the type level — they can never be summed
-- into each other by accident.

create table if not exists public.project_observations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  space_id uuid references public.spaces(id) on delete set null,
  channel text not null default 'visual' check (channel in ('visual', 'documents')),
  component_key text not null,
  kind text not null check (kind in ('installed_seen', 'delivered_documented', 'observed', 'capture_coverage')),
  quantity numeric,
  coverage text check (coverage in ('full', 'partial', 'none')),
  evidence_ids uuid[] not null default '{}'::uuid[],
  method text not null default 'AI_VISION' check (method in ('AI_VISION', 'DOCUMENT', 'HUMAN')),
  confidence text not null default 'medium' check (confidence in ('high', 'medium', 'low')),
  note text,
  observed_at timestamptz not null default now(),
  recorded_by uuid references auth.users(id),
  job_id uuid references public.intelligence_jobs(id) on delete set null,
  state text not null default 'active' check (state in ('active', 'superseded')),
  created_at timestamptz not null default now()
);

create index if not exists project_observations_lookup
  on public.project_observations(property_id, state, component_key, kind);

-- Where requirement meets evidence: one verdict per component, recomputed
-- deterministically, history superseded never erased.

create table if not exists public.project_reconciliations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  requirement_id uuid references public.project_requirements(id) on delete set null,
  component_key text not null,
  required_quantity numeric,
  delivered_quantity numeric,
  evidenced_quantity numeric not null default 0,
  coverage text not null default 'unknown' check (coverage in ('full', 'partial', 'none', 'unknown')),
  verdict text not null check (verdict in (
    'SUPPORTED', 'PARTIALLY_SUPPORTED', 'NOT_EVIDENCED', 'CONFLICTING', 'UNKNOWN', 'NOT_APPLICABLE'
  )),
  narrative text not null default '',
  job_id uuid references public.intelligence_jobs(id) on delete set null,
  state text not null default 'active' check (state in ('active', 'superseded')),
  computed_at timestamptz not null default now()
);

create index if not exists project_reconciliations_lookup
  on public.project_reconciliations(property_id, state, verdict);

-- Reads are project-wide; writes go through the functions below.
alter table public.intelligence_jobs enable row level security;
alter table public.processing_checkpoints enable row level security;
alter table public.project_requirements enable row level security;
alter table public.project_observations enable row level security;
alter table public.project_reconciliations enable row level security;

drop policy if exists intelligence_jobs_read on public.intelligence_jobs;
create policy intelligence_jobs_read on public.intelligence_jobs for select
using (public.is_org_member(organization_id));
drop policy if exists processing_checkpoints_read on public.processing_checkpoints;
create policy processing_checkpoints_read on public.processing_checkpoints for select
using (exists (select 1 from public.intelligence_jobs j
               where j.id = processing_checkpoints.job_id and public.is_org_member(j.organization_id)));
drop policy if exists project_requirements_read on public.project_requirements;
create policy project_requirements_read on public.project_requirements for select
using (public.is_org_member(organization_id));
drop policy if exists project_observations_read on public.project_observations;
create policy project_observations_read on public.project_observations for select
using (public.is_org_member(organization_id));
drop policy if exists project_reconciliations_read on public.project_reconciliations;
create policy project_reconciliations_read on public.project_reconciliations for select
using (public.is_org_member(organization_id));

-- ─────────────────────────────── technical channel → requirements
-- Deterministic distillation of a baseline's framed-deck members into
-- component requirements. Idempotent: rerunning supersedes and rewrites;
-- the job row carries a checkpoint after every component so an interrupted
-- run is visible and a resumed run completes cleanly.

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

-- ─────────────────────────────── visual/documentary channel → observations
-- The door the workers and reviewers write through. The owner never does.

create or replace function public.record_observation(
  p_property_id uuid,
  p_component_key text,
  p_kind text,
  p_quantity numeric default null,
  p_space_id uuid default null,
  p_evidence_ids uuid[] default '{}'::uuid[],
  p_coverage text default null,
  p_method text default 'AI_VISION',
  p_confidence text default 'medium',
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  property_record public.properties%rowtype;
  actor_role public.studio_role;
  new_id uuid;
begin
  select * into property_record from public.properties where id = p_property_id;
  if property_record.id is null then
    raise exception 'That project is not in the record';
  end if;
  actor_role := public.property_role(p_property_id);
  if actor_role is null or actor_role not in ('owner', 'admin', 'reviewer', 'contributor', 'project_manager') then
    raise exception 'Observations are recorded by the project''s own people and workers';
  end if;
  if nullif(trim(coalesce(p_component_key, '')), '') is null then
    raise exception 'An observation names the component it observed';
  end if;
  if p_kind = 'capture_coverage' and p_coverage is null then
    raise exception 'A coverage observation states the coverage';
  end if;

  insert into public.project_observations (
    organization_id, property_id, space_id, channel, component_key, kind,
    quantity, coverage, evidence_ids, method, confidence, note, recorded_by
  ) values (
    property_record.organization_id, p_property_id, p_space_id,
    case when p_method = 'DOCUMENT' then 'documents' else 'visual' end,
    trim(p_component_key), p_kind, p_quantity, p_coverage,
    coalesce(p_evidence_ids, '{}'::uuid[]), p_method, p_confidence,
    nullif(trim(coalesce(p_note, '')), ''), auth.uid()
  ) returning id into new_id;
  return new_id;
end;
$$;

-- ─────────────────────────────── reconciliation
-- Requirement meets evidence, component by component. Deterministic; the
-- verdict table IS the doctrine:
--   evidenced >= required                        → SUPPORTED
--   nothing evidenced, coverage not full         → NOT_EVIDENCED
--   short, coverage full                         → CONFLICTING
--   short, coverage partial/unknown              → PARTIALLY_SUPPORTED
--   no required quantity                         → UNKNOWN
-- Delivery documents shape the narrative and never the verdict.

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

    select coalesce(min(case coverage when 'full' then 1 when 'partial' then 2 when 'none' then 3 end), 4) into best_coverage
    from public.project_observations
    where property_id = p_property_id and state = 'active'
      and component_key = requirement.component_key and kind = 'capture_coverage';
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

comment on function public.reconcile_project(uuid) is
  'Requirement meets evidence per component. Absence of evidence is not evidence of absence: shortfalls only conflict under full capture coverage. Delivery shapes the narrative, never the verdict.';

revoke all on function public.extract_project_requirements(uuid) from public;
revoke all on function public.record_observation(uuid, text, text, numeric, uuid, uuid[], text, text, text, text) from public;
revoke all on function public.reconcile_project(uuid) from public;
grant execute on function public.extract_project_requirements(uuid) to authenticated;
grant execute on function public.record_observation(uuid, text, text, numeric, uuid, uuid[], text, text, text, text) to authenticated;
grant execute on function public.reconcile_project(uuid) to authenticated;
