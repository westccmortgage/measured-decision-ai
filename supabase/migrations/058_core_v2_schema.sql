-- 058 · Core V2: the record a decision can be traced through.
--
-- Today a plan reading produces one large answer and the project believes it.
-- Core V2 replaces that with a chain nobody can shortcut:
--
--     decision -> accepted claim(s) -> source anchor(s) -> immutable source
--
-- Everything below exists to make that chain a property of the database rather
-- than a habit of the code that writes to it. A claim cannot be accepted with
-- nothing to point at. A decision cannot be decided with nothing accepted
-- behind it. A count read off marks cannot be accepted unless the marks were
-- individually anchored. A request whose outcome nobody knows is never retried
-- by a machine. An accepted record is never edited — it is superseded, and both
-- versions stay.
--
-- What this migration deliberately is NOT:
--   · it starts nothing. No worker, no provider call, no queue runs from here.
--   · it changes no V1 table. `document_baselines`, `plan_spaces`,
--     `project_requirements` and `material_takeoffs` keep every row and every
--     policy they have. V2 lives beside V1, not on top of it.
--   · it gives the browser no way to write machine state. There is not one
--     insert, update or delete policy on any table in this file. Machine rows
--     are written by the service role; people act through the four named
--     functions at the end, each of which checks who is asking.
--
-- Scope: sections 5.1–5.17 of the Core V2 specification. The provider
-- capability scores (5.18) and the spatial frames, registrations, anchors and
-- tracks (5.19–5.22) belong to the PRs that first use them; see docs/core-v2.md.

-- ═══════════════════════════════════════════════════════ 1 · the state machines
--
-- Every legal move, in one place, so a trigger and a reader consult the same
-- list. Anything not named here cannot happen, whoever asks — including the
-- service role. A machine that can jump anywhere is not a machine.
create or replace function public.core_v2_transition_allowed(
  p_machine text, p_from text, p_to text
) returns boolean language sql immutable as $$
  select exists (
    select 1 from (values
      -- workflow
      ('workflow','created','queued'),
      ('workflow','created','cancelled'),
      ('workflow','queued','planning'),
      ('workflow','queued','cancelled'),
      ('workflow','queued','failed'),
      ('workflow','planning','running'),
      ('workflow','planning','needs_attention'),
      ('workflow','planning','failed'),
      ('workflow','planning','cancelled'),
      ('workflow','running','needs_attention'),
      ('workflow','running','ready_for_decision'),
      ('workflow','running','cancelled'),
      ('workflow','running','failed'),
      ('workflow','needs_attention','running'),
      ('workflow','needs_attention','ready_for_decision'),
      ('workflow','needs_attention','cancelled'),
      ('workflow','needs_attention','failed'),
      ('workflow','ready_for_decision','deciding'),
      ('workflow','ready_for_decision','needs_attention'),
      ('workflow','deciding','completed'),
      ('workflow','deciding','partial'),
      ('workflow','deciding','needs_attention'),
      ('workflow','deciding','failed'),
      -- task
      ('task','created','blocked'),
      ('task','created','queued'),
      ('task','created','cancelled'),
      ('task','blocked','queued'),
      ('task','blocked','cancelled'),
      ('task','blocked','superseded'),
      ('task','queued','leased'),
      ('task','queued','cancelled'),
      ('task','queued','superseded'),
      ('task','leased','running'),
      ('task','leased','queued'),
      ('task','leased','cancelled'),
      ('task','running','completed'),
      ('task','running','failed_known'),
      ('task','running','outcome_unknown'),
      ('task','running','cancelled'),
      -- attempt
      ('attempt','prepared','submitted'),
      ('attempt','prepared','rejected_before_submission'),
      ('attempt','prepared','cancelled_before_submission'),
      ('attempt','submitted','response_received'),
      ('attempt','submitted','failed_known'),
      ('attempt','submitted','output_limited'),
      ('attempt','submitted','outcome_unknown'),
      ('attempt','response_received','parsed'),
      ('attempt','response_received','output_limited'),
      ('attempt','response_received','failed_known'),
      ('attempt','parsed','succeeded'),
      ('attempt','parsed','failed_known'),
      -- claim
      ('claim','proposed','corroborated'),
      ('claim','proposed','disputed'),
      ('claim','proposed','verified'),
      ('claim','proposed','accepted'),
      ('claim','proposed','rejected'),
      ('claim','proposed','unresolved'),
      ('claim','proposed','superseded'),
      ('claim','corroborated','disputed'),
      ('claim','corroborated','verified'),
      ('claim','corroborated','accepted'),
      ('claim','corroborated','rejected'),
      ('claim','corroborated','unresolved'),
      ('claim','corroborated','superseded'),
      ('claim','disputed','verified'),
      ('claim','disputed','accepted'),
      ('claim','disputed','rejected'),
      ('claim','disputed','unresolved'),
      ('claim','disputed','superseded'),
      ('claim','verified','accepted'),
      ('claim','verified','rejected'),
      ('claim','verified','disputed'),
      ('claim','verified','superseded'),
      ('claim','unresolved','disputed'),
      ('claim','unresolved','verified'),
      ('claim','unresolved','accepted'),
      ('claim','unresolved','rejected'),
      ('claim','unresolved','superseded'),
      -- an accepted or rejected claim is never edited back into another shape;
      -- the only way onward is supersession, which keeps both versions.
      ('claim','accepted','superseded'),
      ('claim','rejected','superseded'),
      -- disagreement
      ('disagreement','open','verifying'),
      ('disagreement','open','needs_human'),
      ('disagreement','open','resolved'),
      ('disagreement','open','superseded'),
      ('disagreement','verifying','resolved'),
      ('disagreement','verifying','needs_human'),
      ('disagreement','verifying','superseded'),
      ('disagreement','needs_human','resolved'),
      ('disagreement','needs_human','superseded'),
      ('disagreement','resolved','superseded'),
      -- page region
      ('region','proposed','accepted'),
      ('region','proposed','rejected'),
      ('region','proposed','superseded'),
      ('region','accepted','superseded'),
      ('region','rejected','superseded'),
      -- decision
      ('decision','proposed','machine_decided'),
      ('decision','proposed','needs_human'),
      ('decision','proposed','superseded'),
      ('decision','needs_human','human_decided'),
      ('decision','needs_human','superseded'),
      ('decision','machine_decided','superseded'),
      ('decision','human_decided','superseded')
    ) as t(machine, from_state, to_state)
    where t.machine = p_machine and t.from_state = p_from and t.to_state = p_to
  );
$$;

comment on function public.core_v2_transition_allowed(text, text, text) is
  'Every legal state move in Core V2. A move absent from this list cannot be made by anyone, including the service role.';

create or replace function public.core_v2_touch() returns trigger
language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

-- A box on a page, expressed the way every reader must express it: four
-- numbers between 0 and 1, in order. A pixel box from one rendering cannot be
-- compared with a pixel box from another; this one can.
create or replace function public.core_v2_is_normalised_bbox(p_bbox jsonb)
returns boolean language sql immutable as $$
  select p_bbox is null or (
    jsonb_typeof(p_bbox) = 'array'
    and jsonb_array_length(p_bbox) = 4
    and not exists (
      select 1 from jsonb_array_elements(p_bbox) as e(v)
      where jsonb_typeof(e.v) <> 'number'
         or (e.v)::numeric < 0 or (e.v)::numeric > 1
    )
    and (p_bbox->>0)::numeric <= (p_bbox->>2)::numeric
    and (p_bbox->>1)::numeric <= (p_bbox->>3)::numeric
  );
$$;

-- The quantity a claim carries, if it carries one. A written zero is a
-- measured value and comes back as 0; an absent or explicitly null quantity
-- comes back as null and stays unknown. Nothing here turns one into the other.
create or replace function public.core_v2_claim_quantity(p_value jsonb)
returns numeric language sql immutable as $$
  select case when jsonb_typeof(p_value -> 'quantity') = 'number'
              then (p_value ->> 'quantity')::numeric end;
$$;

comment on function public.core_v2_claim_quantity(jsonb) is
  'The numeric quantity of a claim, or null when it has none. Zero is a measurement; null is an absence. They never collapse into each other.';

-- ═══════════════════════════════════════════════════════════ 2 · the workflow
--
-- One requested analysis. Its id is also the durable orchestrator's workflow
-- id, which is what makes starting the same work twice harmless.
create table if not exists public.intelligence_workflows (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  workflow_type text not null check (workflow_type in (
    'plan_compile', 'revision_compile', 'photo_assimilation', 'benchmark', 'rebuild_projection')),
  engine_version text not null check (engine_version like 'core-v2%'),
  state text not null default 'created' check (state in (
    'created', 'queued', 'planning', 'running', 'needs_attention',
    'ready_for_decision', 'deciding', 'completed', 'partial', 'failed', 'cancelled')),

  -- Two hashes, because they answer two different questions. The source-set
  -- fingerprint says WHICH immutable documents were read: content digest or
  -- object version, storage location, size and revision. The request
  -- fingerprint says WHAT WAS ASKED of them: the type of work, that source set,
  -- the canonical scope, and the engine version. Reading S-2 alone and reading
  -- the whole set share a source fingerprint and are not the same request.
  --
  -- Both are computed on the server. A client may state what it believes and be
  -- told it is stale; it never supplies the value.
  source_set_fingerprint text not null,
  request_fingerprint text not null,
  requested_by uuid references auth.users(id),
  requested_scope jsonb not null default '{}'::jsonb,

  -- Set by the dispatcher after the orchestrator acknowledges the start.
  temporal_run_id text,
  cancel_requested_at timestamptz,

  -- Counted, never estimated. Elapsed time is not progress.
  completed_units integer not null default 0 check (completed_units >= 0),
  total_units integer not null default 0 check (total_units >= 0),
  attention_units integer not null default 0 check (attention_units >= 0),

  error_code text,
  error_message text,

  -- A second workflow over the same sources exists only because a person said
  -- so. This column is who said it; without it the refusal below has no
  -- exception and the specification's "unless explicitly authorized" could not
  -- be expressed.
  duplicate_authorized_by uuid references auth.users(id),

  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.intelligence_workflows is
  'One requested analysis, comparison, revision update or photo assimilation. The row id is the durable workflow id, so a duplicate start is harmless.';
comment on column public.intelligence_workflows.completed_units is
  'Terminal required tasks. Counted from persisted tasks — never derived from elapsed time.';
comment on column public.intelligence_workflows.duplicate_authorized_by is
  'The person who authorised a second live workflow over the same sources. Null for ordinary starts, which are refused as duplicates.';

create index if not exists intelligence_workflows_by_property
  on public.intelligence_workflows(property_id, created_at desc);
create index if not exists intelligence_workflows_by_state
  on public.intelligence_workflows(state, updated_at desc);

-- One live answer to one question. The request fingerprint, not the source
-- fingerprint: two different scopes over the same drawings are two requests and
-- neither blocks the other. A benchmark may deliberately repeat a request, and
-- so may a start a person explicitly authorised; nothing else may.
create unique index if not exists intelligence_workflows_one_live_request
  on public.intelligence_workflows(property_id, request_fingerprint)
  where state in ('created','queued','planning','running','needs_attention','ready_for_decision','deciding')
    and workflow_type <> 'benchmark'
    and duplicate_authorized_by is null;
create index if not exists intelligence_workflows_by_source_set
  on public.intelligence_workflows(property_id, source_set_fingerprint);

-- Durable command handoff. IDs only: no secrets, no document bytes.
create table if not exists public.workflow_outbox (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  workflow_id uuid not null unique references public.intelligence_workflows(id) on delete cascade,
  command text not null default 'start' check (command in ('start')),
  payload jsonb not null default '{}'::jsonb,
  state text not null default 'pending' check (state in ('pending','dispatching','acknowledged','failed')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  available_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.workflow_outbox is
  'One start command per workflow, committed in the same transaction as the workflow. The dispatcher acknowledges it; nothing here holds secrets or document bytes.';

create index if not exists workflow_outbox_ready
  on public.workflow_outbox(state, available_at) where state in ('pending','dispatching');

-- ═════════════════════════════════════════════════════════════ 3 · the sources
--
-- A page identity belongs to one revision of one document and never moves. A
-- changed drawing makes new pages; it does not quietly redefine what an
-- accepted decision was anchored to.
create table if not exists public.source_pages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  document_id uuid not null references public.project_documents(id) on delete restrict,
  page_index integer not null check (page_index >= 0),
  printed_sheet_number text,
  printed_sheet_title text,
  discipline text,
  revision_label text,
  issued_at date,
  page_width numeric,
  page_height numeric,
  text_content_path text,
  render_path text,
  content_hash text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (document_id, page_index)
);

comment on table public.source_pages is
  'Immutable page identity for one revision of one document. Anchors point here, so a new revision creates new pages rather than changing these.';

create index if not exists source_pages_by_property on public.source_pages(property_id, document_id, page_index);

create table if not exists public.page_regions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  page_id uuid not null references public.source_pages(id) on delete restrict,
  parent_region_id uuid references public.page_regions(id) on delete restrict,
  region_kind text not null check (region_kind in (
    'title_block','sheet_index','plan_view','schedule','legend','general_notes','keynotes',
    'detail','section','elevation','diagram','spec_text','photo','other')),
  label text,
  -- Normalised [x0,y0,x1,y1], every value between 0 and 1, so a region means
  -- the same thing whatever resolution it was found at.
  bbox jsonb not null,
  rotation integer not null default 0 check (rotation in (0,90,180,270)),
  crop_path text,
  text_content_path text,
  region_hash text not null,
  identified_by text not null,
  status text not null default 'proposed' check (status in ('proposed','accepted','rejected','superseded')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint page_regions_bbox_normalised check (public.core_v2_is_normalised_bbox(bbox))
);

comment on table public.page_regions is
  'A semantic area of a page — a schedule, a legend, a plan view. Regions may overlap and may be refined into children; an anchor pointing at one keeps its meaning.';

create index if not exists page_regions_by_page on public.page_regions(page_id, region_kind);
create index if not exists page_regions_by_property on public.page_regions(property_id, created_at desc);

-- ══════════════════════════════════════════════════════ 4 · the bounded work
--
-- One task reads one schedule, one legend, one symbol family, one packet. No
-- row here may ask a provider for a whole project baseline; that is the shape
-- of request Core V2 exists to replace.
create table if not exists public.extraction_tasks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  workflow_id uuid not null references public.intelligence_workflows(id) on delete cascade,
  parent_task_id uuid references public.extraction_tasks(id) on delete set null,
  task_type text not null check (task_type in (
    'ingest_page','map_page_regions','read_sheet_register','extract_schedule','extract_notes',
    'extract_legend','locate_symbol_family','extract_dimensions','resolve_relationships',
    'count_instances','derive_materials','detect_disagreements','verify_disagreement',
    'adjudicate','cluster_photo_scenes','locate_photo_scene','classify_work_stage','compare_revisions')),
  subject_key text not null,
  state text not null default 'created' check (state in (
    'created','blocked','queued','leased','running','completed','failed_known',
    'outcome_unknown','cancelled','superseded')),
  priority integer not null default 100,
  input_manifest jsonb not null default '{}'::jsonb,
  input_fingerprint text not null,
  contract_version text not null,
  -- Two extractors reading the same sources blind belong to different groups,
  -- so their tasks are two rows rather than one reused result.
  required_independence_group text,
  max_claims integer not null default 200 check (max_claims > 0),
  lease_owner text,
  lease_expires_at timestamptz,
  terminal_reason text,
  created_by_task_id uuid references public.extraction_tasks(id) on delete set null,
  -- Who authorised running this work again after it ended without a known
  -- outcome. A machine can never fill these in.
  retry_authorized_by uuid references auth.users(id),
  retry_authorized_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.extraction_tasks is
  'One bounded unit of work with a reproducible input fingerprint. No task asks for a complete project baseline.';
comment on column public.extraction_tasks.retry_authorized_by is
  'The person who authorised re-running a task whose provider outcome was unknown. Never set by a worker.';

create unique index if not exists extraction_tasks_identity
  on public.extraction_tasks(workflow_id, task_type, subject_key, input_fingerprint,
                             contract_version, coalesce(required_independence_group, ''));
create index if not exists extraction_tasks_runnable
  on public.extraction_tasks(state, priority, created_at);
create index if not exists extraction_tasks_by_workflow
  on public.extraction_tasks(workflow_id, state);
create index if not exists extraction_tasks_leases
  on public.extraction_tasks(lease_expires_at) where state = 'leased';

create table if not exists public.task_dependencies (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  task_id uuid not null references public.extraction_tasks(id) on delete cascade,
  depends_on_task_id uuid not null references public.extraction_tasks(id) on delete cascade,
  dependency_kind text not null check (dependency_kind in (
    'requires_completion','requires_claims','requires_resolution')),
  created_at timestamptz not null default now(),
  primary key (task_id, depends_on_task_id),
  constraint task_dependencies_not_self check (task_id <> depends_on_task_id)
);

comment on table public.task_dependencies is
  'What a task waits for. Cycles are rejected by planner validation before anything is queued.';

-- One actual attempt by one executor — deterministic code, a provider, or a
-- person. Whatever it returned is kept, including a partial answer that cost
-- money and a response that failed to parse.
create table if not exists public.agent_attempts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  task_id uuid not null references public.extraction_tasks(id) on delete cascade,
  attempt_no integer not null check (attempt_no >= 1),
  executor_type text not null check (executor_type in ('deterministic','openai','anthropic','google','human')),
  agent_role text not null,
  model text,
  model_reported text,
  reasoning_configuration jsonb not null default '{}'::jsonb,
  output_limit integer,
  state text not null default 'prepared' check (state in (
    'prepared','submitted','response_received','parsed','succeeded',
    'rejected_before_submission','failed_known','output_limited',
    'cancelled_before_submission','outcome_unknown')),
  provider_request_id text,
  ai_run_id uuid references public.ai_runs(id) on delete set null,
  raw_response_path text,
  response_hash text,
  usage jsonb not null default '{}'::jsonb,
  duration_ms bigint,
  error_code text,
  error_message text,
  started_at timestamptz,
  submitted_at timestamptz,
  received_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (task_id, attempt_no)
);

comment on table public.agent_attempts is
  'One executor attempt. A raw or partial response is never deleted because parsing failed, and an attempt that may have been billed keeps its usage.';
comment on column public.agent_attempts.state is
  'output_limited is a known outcome that keeps its partial response and usage; outcome_unknown means the provider may have run and is never retried automatically.';

create index if not exists agent_attempts_by_task on public.agent_attempts(task_id, attempt_no);
create index if not exists agent_attempts_open
  on public.agent_attempts(state, submitted_at) where state in ('submitted','response_received','outcome_unknown');

-- ═══════════════════════════════════════════════════════════ 5 · the evidence
--
-- One claim says one thing about one subject, in one scope, on one basis. Long
-- prose is not a claim.
create table if not exists public.evidence_claims (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  workflow_id uuid not null references public.intelligence_workflows(id) on delete cascade,
  attempt_id uuid references public.agent_attempts(id) on delete set null,
  subject_type text not null check (subject_type in (
    'building','level','space','component_type','component_instance','assembly','material',
    'requirement','system','photo_scene','work_state','document_identity')),
  subject_key text not null,
  predicate text not null,
  value jsonb not null default '{}'::jsonb,
  unit text,
  -- What kind of observation this is. Printed in a schedule, counted from
  -- individually marked instances, calculated by deterministic code, observed
  -- in the field, or inferred. These are four different facts about the same
  -- component and they are never merged without a decision.
  observation_basis text not null check (observation_basis in (
    'printed','counted_marks','calculated','field_observed','inferred')),
  scope jsonb not null default '{}'::jsonb,
  status text not null default 'proposed' check (status in (
    'proposed','corroborated','disputed','verified','accepted','rejected','unresolved','superseded')),
  machine_confidence numeric check (machine_confidence is null or (machine_confidence >= 0 and machine_confidence <= 1)),
  canonical_entity_id uuid,
  supersedes_claim_id uuid references public.evidence_claims(id) on delete set null,
  -- A claim parsed out of an attempt that ran out of output. It may be shown
  -- and it may be useful; it can never be accepted on its own.
  incomplete_source_attempt boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.evidence_claims is
  'One atomic assertion: subject, predicate, value, unit, basis and scope. Explanatory prose may accompany a claim; it can never replace this structure.';
comment on column public.evidence_claims.value is
  'Typed value with its original text. A quantity of 0 is a measurement; an absent or null quantity is unknown. See core_v2_claim_quantity.';

create index if not exists evidence_claims_by_workflow on public.evidence_claims(workflow_id, status);
create index if not exists evidence_claims_by_subject
  on public.evidence_claims(property_id, subject_type, subject_key, predicate);
create index if not exists evidence_claims_by_entity on public.evidence_claims(canonical_entity_id)
  where canonical_entity_id is not null;

-- Where a claim comes from. One claim may have many anchors; one anchor may
-- support many claims. An anchor that points nowhere is not an anchor, which
-- is why the check below insists on the reference its own kind requires.
create table if not exists public.evidence_anchors (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  claim_id uuid not null references public.evidence_claims(id) on delete restrict,
  source_kind text not null check (source_kind in (
    'page_region','page_bbox','document_text','photo','video_frame','human_record')),
  -- `restrict`, not `cascade`: the source under an accepted decision does not
  -- quietly disappear because a row somewhere upstream was deleted. Removing a
  -- document that Core V2 anchored to is refused, and that refusal is the
  -- point.
  document_id uuid references public.project_documents(id) on delete restrict,
  page_id uuid references public.source_pages(id) on delete restrict,
  region_id uuid references public.page_regions(id) on delete restrict,
  evidence_item_id uuid references public.evidence_items(id) on delete restrict,
  bbox jsonb,
  timecode_ms bigint,
  quoted_text text,
  anchor_hash text not null,
  -- Sheet number, tile, image id, capture direction — and, for a counted mark,
  -- which mark this is. That last one is what makes a count checkable.
  locator jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint evidence_anchors_bbox_normalised check (public.core_v2_is_normalised_bbox(bbox)),
  constraint evidence_anchors_points_somewhere check (
    case source_kind
      when 'page_region'   then region_id is not null
      when 'page_bbox'     then page_id is not null and bbox is not null
      when 'document_text' then document_id is not null
      when 'photo'         then evidence_item_id is not null
      when 'video_frame'   then evidence_item_id is not null and timecode_ms is not null
      when 'human_record'  then quoted_text is not null or locator <> '{}'::jsonb
      else false
    end)
);

comment on table public.evidence_anchors is
  'The source an accepted claim can be opened at. A quantity counted from marks needs one anchor per mark, not one reference to the sheet.';
comment on column public.evidence_anchors.locator is
  'Sheet number, tile, image id, capture direction. For a counted quantity, locator->>''mark'' names the individual mark this anchor is.';

create index if not exists evidence_anchors_by_claim on public.evidence_anchors(claim_id);
create index if not exists evidence_anchors_by_region on public.evidence_anchors(region_id) where region_id is not null;
create index if not exists evidence_anchors_by_page on public.evidence_anchors(page_id) where page_id is not null;

-- ══════════════════════════════════════════════════════ 6 · the project graph
--
-- A component type, a component instance, an assembly and a material are four
-- different things. A schedule row is a type. A symbol on a plan is an
-- instance. A material appears only from a deterministic rule or a printed
-- material quantity. Nothing here lets one become another by accident.
create table if not exists public.project_entities (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  entity_type text not null check (entity_type in (
    'building','level','space','component_type','component_instance','assembly',
    'material','system','photo_scene')),
  canonical_key text not null,
  display_name text not null,
  attributes jsonb not null default '{}'::jsonb,
  lifecycle_state text not null default 'unresolved' check (lifecycle_state in (
    'active','superseded','removed','unresolved')),
  first_seen_workflow_id uuid references public.intelligence_workflows(id) on delete set null,
  last_seen_workflow_id uuid references public.intelligence_workflows(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.project_entities is
  'The canonical project graph node. A component type, an instance, an assembly and a material are distinct entity types and share no identity.';

create unique index if not exists project_entities_active_identity
  on public.project_entities(property_id, entity_type, canonical_key)
  where lifecycle_state = 'active';
create index if not exists project_entities_by_property
  on public.project_entities(property_id, entity_type, canonical_key);

-- `2ND FLOOR` and `Second Floor` are one entity and two names. Both names stay.
create table if not exists public.entity_aliases (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  entity_id uuid not null references public.project_entities(id) on delete cascade,
  original_text text not null,
  normalized_text text not null,
  source_scope jsonb not null default '{}'::jsonb,
  resolution_method text not null check (resolution_method in (
    'deterministic','machine_proposed','human_confirmed')),
  attempt_id uuid references public.agent_attempts(id) on delete set null,
  status text not null default 'proposed' check (status in ('proposed','accepted','rejected','superseded')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.entity_aliases is
  'Original and normalised names for one entity, with how they were resolved. A human-confirmed alias outranks a machine-proposed one; a conflict becomes a disagreement rather than an overwrite.';

create index if not exists entity_aliases_by_entity on public.entity_aliases(entity_id);
create index if not exists entity_aliases_by_text on public.entity_aliases(property_id, normalized_text);

create table if not exists public.entity_relations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  from_entity_id uuid not null references public.project_entities(id) on delete cascade,
  relation_type text not null check (relation_type in (
    'instance_of','located_in','specified_by','shown_on','part_of','connects_to','replaces','observed_in')),
  to_entity_id uuid not null references public.project_entities(id) on delete cascade,
  decision_id uuid,
  valid_from_workflow_id uuid references public.intelligence_workflows(id) on delete set null,
  valid_to_workflow_id uuid references public.intelligence_workflows(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint entity_relations_not_self check (from_entity_id <> to_entity_id)
);

create index if not exists entity_relations_from on public.entity_relations(from_entity_id, relation_type);
create index if not exists entity_relations_to on public.entity_relations(to_entity_id, relation_type);

-- ═══════════════════════════════════════════════════ 7 · review and dispute
--
-- What a critic found, said about which claim, using which anchors. A review
-- that names no evidence is an opinion.
create table if not exists public.claim_assessments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  claim_id uuid not null references public.evidence_claims(id) on delete cascade,
  attempt_id uuid not null references public.agent_attempts(id) on delete cascade,
  assessment text not null check (assessment in (
    'supports','contradicts','insufficient','wrong_scope','wrong_unit','duplicate','unreadable')),
  reason_code text not null,
  explanation text,
  created_at timestamptz not null default now()
);

create index if not exists claim_assessments_by_claim on public.claim_assessments(claim_id);

-- The anchors a reviewer actually used. A uuid[] column could hold the id of an
-- anchor in another project, or of an anchor that no longer exists, and the
-- database would have no way to notice either.
create table if not exists public.claim_assessment_anchors (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  assessment_id uuid not null references public.claim_assessments(id) on delete cascade,
  anchor_id uuid not null references public.evidence_anchors(id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (assessment_id, anchor_id)
);

comment on table public.claim_assessment_anchors is
  'The evidence a reviewer used, as real foreign keys. Array-held ids cannot carry referential integrity or a tenant guard, so they are not used.';

create index if not exists claim_assessment_anchors_by_anchor
  on public.claim_assessment_anchors(anchor_id);
create index if not exists claim_assessment_anchors_by_property
  on public.claim_assessment_anchors(property_id, assessment_id);

-- Two readers disagreed, or one reader disagreed with the source. Both claims
-- are kept, and the losing one is kept too.
create table if not exists public.disagreements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  workflow_id uuid not null references public.intelligence_workflows(id) on delete cascade,
  disagreement_key text not null,
  kind text not null check (kind in (
    'missing','value','unit','scope','identity','count_basis','source','revision','geometry','duplicate')),
  subject_signature jsonb not null default '{}'::jsonb,
  severity text not null default 'material' check (severity in ('critical','material','informational')),
  state text not null default 'open' check (state in ('open','verifying','resolved','needs_human','superseded')),
  resolution_decision_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.disagreements is
  'A conflict between claims, kept as data. Resolution records which claim won and why; the claims that lost are never deleted.';

create unique index if not exists disagreements_identity
  on public.disagreements(workflow_id, disagreement_key);
create index if not exists disagreements_open
  on public.disagreements(property_id, state, severity) where state <> 'resolved';

-- The claims that disagree. Each one must belong to the same property AND the
-- same workflow as the disagreement, which a uuid[] column could never promise.
-- An absent counterpart — one reader saw a header the other did not — is a row
-- with role `missing_counterpart`, not a borrowed or invented id.
create table if not exists public.disagreement_claims (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  disagreement_id uuid not null references public.disagreements(id) on delete cascade,
  claim_id uuid not null references public.evidence_claims(id) on delete restrict,
  position integer not null default 0,
  role text not null default 'candidate'
    check (role in ('candidate','missing_counterpart','context')),
  created_at timestamptz not null default now(),
  primary key (disagreement_id, claim_id)
);

comment on table public.disagreement_claims is
  'The competing claims of one disagreement, as real foreign keys with a stable position. Every claim belongs to the disagreement''s property and workflow.';

create index if not exists disagreement_claims_by_claim
  on public.disagreement_claims(claim_id);
create index if not exists disagreement_claims_ordered
  on public.disagreement_claims(disagreement_id, position);

-- ═══════════════════════════════════════════════════════════ 8 · the decision
--
-- The record an owner actually reads. Everything above exists so that this row
-- can be opened and traced back to a drawing.
create table if not exists public.decisions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  workflow_id uuid not null references public.intelligence_workflows(id) on delete cascade,
  decision_type text not null check (decision_type in (
    'accept_claim','reject_claim','reject_all','hold','release_for_pricing','release_for_ordering',
    'request_information','create_field_check','supersede')),
  subject_entity_id uuid references public.project_entities(id) on delete set null,
  title text not null,
  decision jsonb not null default '{}'::jsonb,
  status text not null default 'proposed' check (status in (
    'proposed','machine_decided','needs_human','human_decided','superseded')),
  authority text not null check (authority in ('deterministic_rule','adjudicator','human')),
  rationale text not null default '',
  risk_level text not null default 'normal' check (risk_level in ('critical','high','normal','low')),
  decided_by_attempt_id uuid references public.agent_attempts(id) on delete set null,
  decided_by_user_id uuid references auth.users(id),
  supersedes_decision_id uuid references public.decisions(id) on delete set null,
  effective_at timestamptz,
  superseded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A decided record says who decided it, and exactly one of them: a machine
  -- attempt or a person.
  constraint decisions_decided_by_exactly_one check (
    status not in ('machine_decided','human_decided')
    or ((decided_by_attempt_id is not null) <> (decided_by_user_id is not null))),
  constraint decisions_human_decided_by_person check (
    status <> 'human_decided' or decided_by_user_id is not null)
);

comment on table public.decisions is
  'The user-facing record. A decided decision cannot exist without accepted evidence behind it, and is never edited afterwards — only superseded.';

create index if not exists decisions_by_property on public.decisions(property_id, status, created_at desc);
create index if not exists decisions_by_workflow on public.decisions(workflow_id, status);

-- Which claims and anchors a decision rests on, and how. `supports` is what
-- the decision was made on; `contradicts` is what it was made against and is
-- kept in full.
create table if not exists public.decision_evidence (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  decision_id uuid not null references public.decisions(id) on delete cascade,
  claim_id uuid references public.evidence_claims(id) on delete restrict,
  anchor_id uuid references public.evidence_anchors(id) on delete restrict,
  link text not null check (link in ('supports','contradicts','context')),
  -- When a link names both, the anchor must be one of that claim's own anchors.
  -- A decision that cites claim A through claim B's source is not traceable.
  --
  weight numeric,
  rule text,
  created_at timestamptz not null default now(),
  constraint decision_evidence_points_somewhere check (claim_id is not null or anchor_id is not null)
);

create index if not exists decision_evidence_by_decision on public.decision_evidence(decision_id, link);
create index if not exists decision_evidence_by_claim on public.decision_evidence(claim_id) where claim_id is not null;

create table if not exists public.decision_actions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  decision_id uuid not null references public.decisions(id) on delete cascade,
  action_type text not null check (action_type in (
    'verify_plan','verify_field','request_document','request_rfi','price','order','hold','review')),
  owner_role text not null,
  status text not null default 'open' check (status in ('open','assigned','completed','waived','superseded')),
  due_at timestamptz,
  completion_evidence_id uuid references public.evidence_items(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- An action completed by evidence names the evidence.
  constraint decision_actions_completion_named check (
    status <> 'completed' or completion_evidence_id is not null or action_type in ('price','order','review','hold'))
);

create index if not exists decision_actions_open on public.decision_actions(property_id, status, due_at);

-- The two forward references that could not be declared before their tables
-- existed.
alter table public.disagreements drop constraint if exists disagreements_resolution_decision_fk;
alter table public.disagreements add constraint disagreements_resolution_decision_fk
  foreign key (resolution_decision_id) references public.decisions(id) on delete set null;
alter table public.disagreements drop constraint if exists disagreements_resolved_has_decision;
alter table public.disagreements add constraint disagreements_resolved_has_decision
  check (state <> 'resolved' or resolution_decision_id is not null);

alter table public.entity_relations drop constraint if exists entity_relations_decision_fk;
alter table public.entity_relations add constraint entity_relations_decision_fk
  foreign key (decision_id) references public.decisions(id) on delete set null;

alter table public.evidence_claims drop constraint if exists evidence_claims_entity_fk;
alter table public.evidence_claims add constraint evidence_claims_entity_fk
  foreign key (canonical_entity_id) references public.project_entities(id) on delete set null;

-- ═════════════════════════════════════════════ 9 · what cannot happen at all
--
-- The guards below run for every writer, service role included. A rule that
-- only the application enforces is a rule that is one refactor from gone.
--
-- Immutability is checked by comparing the whole row, not a list of columns
-- somebody remembered to name. `core_v2_frozen_except` diffs the old and new
-- rows as JSON and reports the first field that moved, so a column added in a
-- later migration is protected the day it exists rather than the day somebody
-- notices it is not.
create or replace function public.core_v2_frozen_except(
  p_old jsonb, p_new jsonb, p_allowed text[]
) returns text language sql immutable as $$
  select key from jsonb_each(p_new) as n(key, value)
   where not (key = any(p_allowed))
     and n.value is distinct from (p_old -> n.key)
   order by key
   limit 1;
$$;

comment on function public.core_v2_frozen_except(jsonb, jsonb, text[]) is
  'The first business field that changed between two versions of a row, ignoring the named columns. Used so record immutability covers every column, including ones added later.';

create or replace function public.core_v2_guard_workflow() returns trigger
language plpgsql as $$
declare moved text;
begin
  if new.state is distinct from old.state
     and not public.core_v2_transition_allowed('workflow', old.state, new.state) then
    raise exception 'core_v2: a workflow cannot go from % to %', old.state, new.state
      using errcode = 'check_violation';
  end if;

  -- What was asked, of which sources, by whom, under which engine — write-once.
  -- Progress, lifecycle timestamps and the dispatcher's handle may move.
  moved := public.core_v2_frozen_except(to_jsonb(old), to_jsonb(new), array[
    'state','temporal_run_id','cancel_requested_at','completed_units','total_units',
    'attention_units','error_code','error_message','started_at','finished_at','updated_at']);
  if moved is not null then
    raise exception 'core_v2: workflow % cannot change % — its intent is fixed at creation', old.id, moved
      using errcode = 'check_violation';
  end if;
  new.updated_at := now();
  return new;
end $$;

create or replace function public.core_v2_guard_outbox() returns trigger
language plpgsql as $$
declare moved text;
begin
  moved := public.core_v2_frozen_except(to_jsonb(old), to_jsonb(new), array[
    'state','attempt_count','available_at','last_error','updated_at']);
  if moved is not null then
    raise exception 'core_v2: outbox row % cannot change % — a command is not rewritten in flight', old.id, moved
      using errcode = 'check_violation';
  end if;
  new.updated_at := now();
  return new;
end $$;

-- A page identity is append-only. A corrected render, a corrected hash, a
-- corrected title-block reading: each is a new page or a new source revision,
-- because anchors under accepted decisions point here.
create or replace function public.core_v2_guard_source_page() returns trigger
language plpgsql as $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'core_v2: source page % is part of the record — a revision creates new pages, it does not remove these', old.id
      using errcode = 'check_violation';
  end if;
  raise exception 'core_v2: source page % is append-only — correct it with a new page or source revision', old.id
    using errcode = 'check_violation';
end $$;

create or replace function public.core_v2_guard_region() returns trigger
language plpgsql as $$
declare moved text;
begin
  if TG_OP = 'DELETE' then
    if old.status <> 'proposed' then
      raise exception 'core_v2: region % is % — it stays in the record', old.id, old.status
        using errcode = 'check_violation';
    end if;
    return old;
  end if;
  if new.status is distinct from old.status
     and not public.core_v2_transition_allowed('region', old.status, new.status) then
    raise exception 'core_v2: a page region cannot go from % to %', old.status, new.status
      using errcode = 'check_violation';
  end if;
  -- A proposed region may still be refined. An accepted one is what anchors
  -- point at, so refinement from here on is a child or a superseding region.
  if old.status <> 'proposed' then
    moved := public.core_v2_frozen_except(to_jsonb(old), to_jsonb(new), array['status','updated_at']);
    if moved is not null then
      raise exception 'core_v2: region % is % — % cannot be rewritten under an anchor', old.id, old.status, moved
        using errcode = 'check_violation';
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;

create or replace function public.core_v2_guard_task() returns trigger
language plpgsql as $$
declare submitted_attempts integer;
begin
  if new.state is distinct from old.state then
    -- A task that ended without a known provider outcome, or with a known
    -- failure, does not go back into the queue on its own. A person authorises
    -- it, and core_v2_authorize_task_retry is the only thing that can say so.
    if old.state in ('outcome_unknown','failed_known') and new.state = 'queued' then
      if coalesce(current_setting('core_v2.authorized_retry', true), '') <> old.id::text then
        raise exception 'core_v2: task % ended as % — a person must authorise running it again', old.id, old.state
          using errcode = 'check_violation';
      end if;
    elsif not public.core_v2_transition_allowed('task', old.state, new.state) then
      raise exception 'core_v2: a task cannot go from % to %', old.state, new.state
        using errcode = 'check_violation';
    end if;

    -- A lease that expires before anything was sent may return the task to the
    -- queue. A lease that expires after a request went out may not: the
    -- provider may have run, and requeueing would buy it again. Cancelling is
    -- the same problem wearing a friendlier word — unsent work stops, sent work
    -- is reconciled.
    if (old.state = 'leased' and new.state = 'queued') or new.state = 'cancelled' then
      select count(*) into submitted_attempts from public.agent_attempts a
       where a.task_id = old.id
         and a.state in ('submitted','response_received','parsed','succeeded','output_limited','outcome_unknown');
      if submitted_attempts > 0 then
        raise exception 'core_v2: task % has an attempt that was already submitted — it is reconciled, not %',
          old.id, case when new.state = 'cancelled' then 'cancelled' else 'requeued' end
          using errcode = 'check_violation';
      end if;
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;

-- What a provider was asked, what it answered, what it cost and when: each fact
-- is write-once from the moment it is recorded, and a terminal attempt does not
-- move at all. This is the row a cost dispute is settled from.
create or replace function public.core_v2_guard_attempt() returns trigger
language plpgsql as $$
declare
  moved text;
  written text;
begin
  if new.state is distinct from old.state
     and not public.core_v2_transition_allowed('attempt', old.state, new.state) then
    raise exception 'core_v2: an attempt cannot go from % to %', old.state, new.state
      using errcode = 'check_violation';
  end if;

  if old.state in ('succeeded','failed_known','output_limited','outcome_unknown',
                   'rejected_before_submission','cancelled_before_submission') then
    moved := public.core_v2_frozen_except(to_jsonb(old), to_jsonb(new), array['updated_at']);
    if moved is not null then
      raise exception 'core_v2: attempt % ended as % — % is not rewritten afterwards', old.id, old.state, moved
        using errcode = 'check_violation';
    end if;
  end if;

  -- Write-once, one field at a time: null (or an empty object) may become a
  -- value; a value never becomes something else, and never becomes nothing.
  select f into written from unnest(array[
    'provider_request_id','ai_run_id','model','model_reported','output_limit',
    'raw_response_path','response_hash','duration_ms','error_code','error_message',
    'started_at','submitted_at','received_at','finished_at']) as t(f)
   where (to_jsonb(old) -> t.f) is not null
     and (to_jsonb(old) -> t.f) <> 'null'::jsonb
     and (to_jsonb(new) -> t.f) is distinct from (to_jsonb(old) -> t.f)
   limit 1;
  if written is not null then
    raise exception 'core_v2: attempt % already recorded % — a provider fact is written once', old.id, written
      using errcode = 'check_violation';
  end if;
  if old.usage <> '{}'::jsonb and new.usage is distinct from old.usage then
    raise exception 'core_v2: the recorded usage of attempt % cannot be replaced', old.id
      using errcode = 'check_violation';
  end if;
  if old.reasoning_configuration <> '{}'::jsonb
     and new.reasoning_configuration is distinct from old.reasoning_configuration then
    raise exception 'core_v2: the recorded configuration of attempt % cannot be replaced', old.id
      using errcode = 'check_violation';
  end if;

  perform public.core_v2_check_attempt_provenance(new);
  new.updated_at := now();
  return new;
end $$;

create or replace function public.core_v2_guard_attempt_insert() returns trigger
language plpgsql as $$
begin
  perform public.core_v2_check_attempt_provenance(new);
  return new;
end $$;

-- A provider attempt that has been sent has a ledger row, that row belongs to
-- the same project, and an answer cut short at its ceiling has the answer.
create or replace function public.core_v2_check_attempt_provenance(attempt public.agent_attempts)
returns void language plpgsql stable as $$
declare ledger public.ai_runs;
begin
  if attempt.executor_type in ('openai','anthropic','google')
     and attempt.state in ('submitted','response_received','parsed','succeeded',
                           'output_limited','outcome_unknown')
     and attempt.ai_run_id is null then
    raise exception 'core_v2: attempt % was sent to % with no ledger row — a call that may be billed is always claimed',
      attempt.id, attempt.executor_type using errcode = 'check_violation';
  end if;

  if attempt.ai_run_id is not null then
    select * into ledger from public.ai_runs where id = attempt.ai_run_id;
    if not found then
      raise exception 'core_v2: attempt % points at a ledger row that does not exist', attempt.id
        using errcode = 'check_violation';
    end if;
    if ledger.organization_id <> attempt.organization_id
       or ledger.property_id is distinct from attempt.property_id then
      raise exception 'core_v2: attempt % is claimed against another project''s ledger row', attempt.id
        using errcode = 'check_violation';
    end if;
  end if;

  if attempt.state = 'output_limited' then
    if attempt.raw_response_path is null then
      raise exception 'core_v2: attempt % ran out of output with nothing stored — the partial answer was paid for', attempt.id
        using errcode = 'check_violation';
    end if;
    if attempt.received_at is null or attempt.finished_at is null then
      raise exception 'core_v2: attempt % ran out of output without saying when it came back and ended', attempt.id
        using errcode = 'check_violation';
    end if;
  end if;
end $$;

create or replace function public.core_v2_guard_attempt_delete() returns trigger
language plpgsql as $$
begin
  if old.raw_response_path is not null or old.ai_run_id is not null
     or old.state in ('submitted','response_received','parsed','succeeded','output_limited','outcome_unknown') then
    raise exception 'core_v2: an attempt that may have been billed is not deleted'
      using errcode = 'check_violation';
  end if;
  return old;
end $$;

create or replace function public.core_v2_guard_claim() returns trigger
language plpgsql as $$
declare moved text;
begin
  if new.status is distinct from old.status
     and not public.core_v2_transition_allowed('claim', old.status, new.status) then
    raise exception 'core_v2: a claim cannot go from % to %', old.status, new.status
      using errcode = 'check_violation';
  end if;
  -- Once a decision has admitted or refused a claim, the claim itself stops
  -- moving — every field of it, not a chosen few. A correction is a new claim
  -- that supersedes this one, so both the old reading and the new one stay
  -- legible.
  if old.status in ('accepted','rejected') then
    moved := public.core_v2_frozen_except(to_jsonb(old), to_jsonb(new), array['status','updated_at']);
    if moved is not null then
      raise exception 'core_v2: claim % is % — % is corrected by a superseding claim, not in place', old.id, old.status, moved
        using errcode = 'check_violation';
    end if;
    if new.status is distinct from old.status and new.status <> 'superseded' then
      raise exception 'core_v2: claim % is % — supersession is the only way onward', old.id, old.status
        using errcode = 'check_violation';
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;

create or replace function public.core_v2_guard_claim_delete() returns trigger
language plpgsql as $$
begin
  if old.status in ('accepted','rejected','superseded')
     or exists (select 1 from public.disagreement_claims d where d.claim_id = old.id)
     or exists (select 1 from public.decision_evidence e where e.claim_id = old.id) then
    raise exception 'core_v2: claim % is part of the record — a claim that lost is kept, not deleted', old.id
      using errcode = 'check_violation';
  end if;
  return old;
end $$;

-- An anchor under an authoritative claim, or cited by a decided decision, is
-- the bottom of the traceable chain. It does not move and it does not go.
create or replace function public.core_v2_guard_anchor() returns trigger
language plpgsql as $$
declare
  claim_status text;
  moved text;
begin
  select c.status into claim_status from public.evidence_claims c where c.id = old.claim_id;
  if claim_status in ('verified','accepted','rejected','superseded') then
    raise exception 'core_v2: anchor % supports a % claim — it is not %', old.id, claim_status,
      case when TG_OP = 'DELETE' then 'deleted' else 'edited' end
      using errcode = 'check_violation';
  end if;
  if exists (select 1 from public.decision_evidence e
              join public.decisions d on d.id = e.decision_id
             where e.anchor_id = old.id
               and d.status in ('machine_decided','human_decided')) then
    raise exception 'core_v2: anchor % is cited by a decided decision — it is not %', old.id,
      case when TG_OP = 'DELETE' then 'deleted' else 'edited' end
      using errcode = 'check_violation';
  end if;
  if TG_OP = 'DELETE' then return old; end if;
  -- An anchor is a fingerprint of a source. Even on a claim still in motion it
  -- is not silently repointed; a different source is a different anchor.
  moved := public.core_v2_frozen_except(to_jsonb(old), to_jsonb(new), array[]::text[]);
  if moved is not null then
    raise exception 'core_v2: anchor % cannot change % — a different source is a different anchor', old.id, moved
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

-- Both named: the anchor must be one of that claim's own. A decision that cites
-- claim A through claim B's source cannot be followed back.
create or replace function public.core_v2_guard_decision_evidence() returns trigger
language plpgsql as $$
declare
  row_link public.decision_evidence := case when TG_OP = 'DELETE' then old else new end;
  decision_status text;
  anchor_claim uuid;
begin
  select d.status into decision_status from public.decisions d where d.id = row_link.decision_id;
  if decision_status in ('machine_decided','human_decided') then
    raise exception 'core_v2: decision % is decided — its evidence set is closed; more evidence makes a superseding decision',
      row_link.decision_id using errcode = 'check_violation';
  end if;
  if TG_OP = 'UPDATE' and old.decision_id is distinct from new.decision_id then
    select d.status into decision_status from public.decisions d where d.id = old.decision_id;
    if decision_status in ('machine_decided','human_decided') then
      raise exception 'core_v2: evidence cannot be moved off decided decision %', old.decision_id
        using errcode = 'check_violation';
    end if;
  end if;
  if TG_OP = 'DELETE' then return old; end if;
  if new.claim_id is not null and new.anchor_id is not null then
    select a.claim_id into anchor_claim from public.evidence_anchors a where a.id = new.anchor_id;
    if anchor_claim is distinct from new.claim_id then
      raise exception 'core_v2: that anchor belongs to another claim — a decision cites a claim through its own source'
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;

create or replace function public.core_v2_guard_disagreement() returns trigger
language plpgsql as $$
begin
  if new.state is distinct from old.state
     and not public.core_v2_transition_allowed('disagreement', old.state, new.state) then
    raise exception 'core_v2: a disagreement cannot go from % to %', old.state, new.state
      using errcode = 'check_violation';
  end if;
  new.updated_at := now();
  return new;
end $$;

-- The competing claims are the disagreement. Once it is settled, the set of
-- claims it was settled between is part of the record.
create or replace function public.core_v2_guard_disagreement_claims() returns trigger
language plpgsql as $$
declare
  row_link public.disagreement_claims := case when TG_OP = 'DELETE' then old else new end;
  dis public.disagreements;
  claim public.evidence_claims;
begin
  select * into dis from public.disagreements where id = row_link.disagreement_id;
  if found and dis.state in ('resolved','superseded') then
    raise exception 'core_v2: disagreement % is % — the claims it was settled between are the record',
      dis.id, dis.state using errcode = 'check_violation';
  end if;
  if TG_OP = 'DELETE' then return old; end if;
  select * into claim from public.evidence_claims where id = new.claim_id;
  if not found then
    raise exception 'core_v2: that claim does not exist' using errcode = 'check_violation';
  end if;
  if claim.workflow_id <> dis.workflow_id then
    raise exception 'core_v2: claim % was made by another reading — a disagreement compares claims of one workflow', claim.id
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create or replace function public.core_v2_guard_decision() returns trigger
language plpgsql as $$
declare moved text;
begin
  if new.status is distinct from old.status
     and not public.core_v2_transition_allowed('decision', old.status, new.status) then
    raise exception 'core_v2: a decision cannot go from % to %', old.status, new.status
      using errcode = 'check_violation';
  end if;
  if old.status in ('machine_decided','human_decided') then
    if new.status = 'superseded' and new.superseded_at is null then
      new.superseded_at := now();
    end if;
    moved := public.core_v2_frozen_except(to_jsonb(old), to_jsonb(new),
      array['status','superseded_at','updated_at']);
    if moved is not null then
      raise exception 'core_v2: decision % is decided — % is changed by superseding it, not by editing it', old.id, moved
        using errcode = 'check_violation';
    end if;
    if new.status is distinct from old.status and new.status <> 'superseded' then
      raise exception 'core_v2: decision % is decided — supersession is the only way onward', old.id
        using errcode = 'check_violation';
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;

create trigger core_v2_workflow_guard before update on public.intelligence_workflows
  for each row execute function public.core_v2_guard_workflow();
create trigger core_v2_outbox_guard before update on public.workflow_outbox
  for each row execute function public.core_v2_guard_outbox();
create trigger core_v2_source_page_guard before update or delete on public.source_pages
  for each row execute function public.core_v2_guard_source_page();
create trigger core_v2_region_guard before update or delete on public.page_regions
  for each row execute function public.core_v2_guard_region();
create trigger core_v2_task_guard before update on public.extraction_tasks
  for each row execute function public.core_v2_guard_task();
create trigger core_v2_attempt_insert_guard before insert on public.agent_attempts
  for each row execute function public.core_v2_guard_attempt_insert();
create trigger core_v2_attempt_guard before update on public.agent_attempts
  for each row execute function public.core_v2_guard_attempt();
create trigger core_v2_attempt_delete_guard before delete on public.agent_attempts
  for each row execute function public.core_v2_guard_attempt_delete();
create trigger core_v2_claim_guard before update on public.evidence_claims
  for each row execute function public.core_v2_guard_claim();
create trigger core_v2_claim_delete_guard before delete on public.evidence_claims
  for each row execute function public.core_v2_guard_claim_delete();
create trigger core_v2_anchor_guard before update or delete on public.evidence_anchors
  for each row execute function public.core_v2_guard_anchor();
create trigger core_v2_decision_evidence_guard before insert or update or delete on public.decision_evidence
  for each row execute function public.core_v2_guard_decision_evidence();
create trigger core_v2_disagreement_guard before update on public.disagreements
  for each row execute function public.core_v2_guard_disagreement();
create trigger core_v2_disagreement_claims_guard before insert or update or delete on public.disagreement_claims
  for each row execute function public.core_v2_guard_disagreement_claims();
create trigger core_v2_decision_guard before update on public.decisions
  for each row execute function public.core_v2_guard_decision();

create trigger core_v2_entity_touch before update on public.project_entities
  for each row execute function public.core_v2_touch();
create trigger core_v2_alias_touch before update on public.entity_aliases
  for each row execute function public.core_v2_touch();
create trigger core_v2_action_touch before update on public.decision_actions
  for each row execute function public.core_v2_touch();
-- ═════════════════════════════════ 10 · the chain, checked at commit
--
-- These are deferred on purpose. A claim and its anchors, or a decision and its
-- evidence, arrive as several statements in one transaction; checking after each
-- statement would forbid the ordinary case. Checking at commit forbids the thing
-- that actually matters: a transaction that ENDS with an accepted claim pointing
-- at nothing, a decided decision resting on nothing, or an accepted claim
-- superseded while the decision it justified still stands.
--
-- Each fires from both sides of its relationship. It is not enough to check when
-- the claim or the decision changes: mutating, moving or removing the evidence
-- underneath must be caught too.

create or replace function public.core_v2_check_claim_evidence() returns trigger
language plpgsql as $$
declare
  claim public.evidence_claims;
  anchors integer;
  marks integer;
  distinct_marks integer;
  distinct_boxes integer;
  quantity numeric;
begin
  select * into claim from public.evidence_claims where id = new.id;
  if not found or claim.status not in ('verified','accepted') then
    return null;
  end if;

  select count(*) into anchors from public.evidence_anchors a where a.claim_id = claim.id;
  if anchors = 0 then
    raise exception 'core_v2: claim % is % with nothing to open — every accepted claim has a source anchor', claim.id, claim.status
      using errcode = 'check_violation';
  end if;

  -- A count read off marks is only as good as the marks. Accepting "36" needs
  -- 36 anchors, each pointing at its own box on a page and naming its own mark.
  -- A list of invented names hung on one general region is exactly the thing
  -- this refuses: the marks must be distinct AND separately located.
  if claim.observation_basis = 'counted_marks' then
    quantity := public.core_v2_claim_quantity(claim.value);
    if quantity is not null then
      if quantity < 0 or quantity <> trunc(quantity) then
        raise exception 'core_v2: claim % counts % from marks — a count of marks is a whole number of them', claim.id, quantity
          using errcode = 'check_violation';
      end if;
      select count(*), count(distinct a.locator ->> 'mark'), count(distinct a.bbox::text)
        into marks, distinct_marks, distinct_boxes
        from public.evidence_anchors a
       where a.claim_id = claim.id
         and a.source_kind = 'page_bbox'
         and a.bbox is not null
         and a.page_id is not null
         and coalesce(a.locator ->> 'mark', '') <> '';
      if distinct_marks < quantity then
        raise exception 'core_v2: claim % counts % from marks but names only % of them individually',
          claim.id, quantity, distinct_marks using errcode = 'check_violation';
      end if;
      if distinct_boxes < quantity then
        raise exception 'core_v2: claim % counts % from marks but locates only % separate places on a page',
          claim.id, quantity, distinct_boxes using errcode = 'check_violation';
      end if;
      if marks <> distinct_marks or marks <> distinct_boxes then
        raise exception 'core_v2: claim % anchors the same mark or the same place twice — that is one instance, counted once', claim.id
          using errcode = 'check_violation';
      end if;
    end if;
  end if;

  -- A claim parsed out of a response that ran out of room may be shown. It
  -- cannot be accepted until something complete verifies it.
  if claim.status = 'accepted' and claim.incomplete_source_attempt then
    raise exception 'core_v2: claim % came from an attempt that was cut short — it needs a complete verification before acceptance', claim.id
      using errcode = 'check_violation';
  end if;
  return null;
end $$;

create or replace function public.core_v2_recheck_claim_of_anchor() returns trigger
language plpgsql as $$
declare claim public.evidence_claims;
begin
  select * into claim from public.evidence_claims
   where id = case when TG_OP = 'DELETE' then old.claim_id else new.claim_id end;
  if not found or claim.status not in ('verified','accepted') then
    return null;
  end if;
  if not exists (select 1 from public.evidence_anchors a where a.claim_id = claim.id) then
    raise exception 'core_v2: that would leave % claim % with nothing to open', claim.status, claim.id
      using errcode = 'check_violation';
  end if;
  -- The counted-mark rule is a property of the anchor set, so removing one
  -- anchor has to be judged against the same rule that admitted them.
  if claim.observation_basis = 'counted_marks' then
    perform public.core_v2_assert_counted_marks(claim);
  end if;
  return null;
end $$;

create or replace function public.core_v2_assert_counted_marks(claim public.evidence_claims)
returns void language plpgsql stable as $$
declare quantity numeric; distinct_marks integer;
begin
  quantity := public.core_v2_claim_quantity(claim.value);
  if quantity is null then return; end if;
  select count(distinct a.locator ->> 'mark') into distinct_marks
    from public.evidence_anchors a
   where a.claim_id = claim.id and a.source_kind = 'page_bbox' and a.bbox is not null
     and coalesce(a.locator ->> 'mark','') <> '';
  if distinct_marks < quantity then
    raise exception 'core_v2: claim % would count % from only % individually marked anchors',
      claim.id, quantity, distinct_marks using errcode = 'check_violation';
  end if;
end $$;

create or replace function public.core_v2_check_decision_evidence() returns trigger
language plpgsql as $$
declare
  decided public.decisions;
  supporting integer;
  disagreement public.disagreements;
  competing integer;
  contradicted integer;
  sourced integer;
begin
  select * into decided from public.decisions where id = new.id;
  if not found or decided.status not in ('machine_decided','human_decided') then
    return null;
  end if;
  -- A supersession is administrative: it records that a later reading replaced
  -- an earlier one, and the evidence lives on the decision it replaces.
  if decided.decision_type = 'supersede' then
    return null;
  end if;

  -- Rejecting everything is a real adjudication and carries a real burden: every
  -- competing claim linked as contradicted, and at least one anchor of its own
  -- saying what the source actually shows.
  if decided.decision_type = 'reject_all' then
    select * into disagreement from public.disagreements where resolution_decision_id = decided.id;
    if not found then
      raise exception 'core_v2: decision % rejects everything but settles no disagreement', decided.id
        using errcode = 'check_violation';
    end if;
    select count(*) into competing from public.disagreement_claims dc
     where dc.disagreement_id = disagreement.id and dc.role = 'candidate';
    select count(*) into contradicted
      from public.disagreement_claims dc
      join public.decision_evidence e
        on e.decision_id = decided.id and e.claim_id = dc.claim_id and e.link = 'contradicts'
     where dc.disagreement_id = disagreement.id and dc.role = 'candidate';
    if contradicted < competing then
      raise exception 'core_v2: decision % rejects % claims but names only % of them', decided.id, competing, contradicted
        using errcode = 'check_violation';
    end if;
    select count(*) into sourced from public.decision_evidence e
     where e.decision_id = decided.id and e.anchor_id is not null and e.link in ('context','supports');
    if sourced = 0 then
      raise exception 'core_v2: decision % rejects every reading without pointing at what the source does show', decided.id
        using errcode = 'check_violation';
    end if;
    return null;
  end if;

  select count(*) into supporting
    from public.decision_evidence e
    join public.evidence_claims c on c.id = e.claim_id
   where e.decision_id = decided.id and e.link = 'supports' and c.status = 'accepted';
  if supporting = 0 then
    raise exception 'core_v2: decision % is decided with no accepted claim supporting it', decided.id
      using errcode = 'check_violation';
  end if;
  return null;
end $$;

create or replace function public.core_v2_recheck_decision_of_evidence() returns trigger
language plpgsql as $$
declare
  target uuid := case when TG_OP = 'DELETE' then old.decision_id else new.decision_id end;
  probe public.decisions;
begin
  select * into probe from public.decisions where id = target;
  if not found then return null; end if;
  perform public.core_v2_check_decision_evidence_for(probe);
  return null;
end $$;

create or replace function public.core_v2_check_decision_evidence_for(decided public.decisions)
returns void language plpgsql stable as $$
declare supporting integer;
begin
  if decided.status not in ('machine_decided','human_decided')
     or decided.decision_type in ('supersede','reject_all') then
    return;
  end if;
  select count(*) into supporting
    from public.decision_evidence e
    join public.evidence_claims c on c.id = e.claim_id
   where e.decision_id = decided.id and e.link = 'supports' and c.status = 'accepted';
  if supporting = 0 then
    raise exception 'core_v2: decision % would be left with no accepted claim supporting it', decided.id
      using errcode = 'check_violation';
  end if;
end $$;

-- Superseding the claim a decision rests on, and leaving the decision standing,
-- would leave an owner reading a release that its own evidence no longer
-- supports. Both move, or neither does.
create or replace function public.core_v2_check_superseded_claim_decisions() returns trigger
language plpgsql as $$
declare
  claim public.evidence_claims;
  standing uuid;
begin
  select * into claim from public.evidence_claims where id = new.id;
  if not found or claim.status <> 'superseded' then
    return null;
  end if;
  select d.id into standing
    from public.decision_evidence e
    join public.decisions d on d.id = e.decision_id
   where e.claim_id = claim.id and e.link = 'supports'
     and d.status in ('machine_decided','human_decided')
   limit 1;
  if standing is not null then
    raise exception 'core_v2: claim % was superseded while decision % still rests on it — supersede the decision in the same breath',
      claim.id, standing using errcode = 'check_violation';
  end if;
  return null;
end $$;

create constraint trigger core_v2_claim_evidence_check
  after insert or update on public.evidence_claims
  deferrable initially deferred
  for each row execute function public.core_v2_check_claim_evidence();

create constraint trigger core_v2_claim_supersession_check
  after update on public.evidence_claims
  deferrable initially deferred
  for each row execute function public.core_v2_check_superseded_claim_decisions();

create constraint trigger core_v2_anchor_removal_check
  after insert or update or delete on public.evidence_anchors
  deferrable initially deferred
  for each row execute function public.core_v2_recheck_claim_of_anchor();

create constraint trigger core_v2_decision_evidence_check
  after insert or update on public.decisions
  deferrable initially deferred
  for each row execute function public.core_v2_check_decision_evidence();

create constraint trigger core_v2_decision_evidence_link_check
  after insert or update or delete on public.decision_evidence
  deferrable initially deferred
  for each row execute function public.core_v2_recheck_decision_of_evidence();
-- ══════════════════════════════════════════════════════════════ 11 · the trail
--
-- Starting work, stopping it, authorising a repeat, settling a disagreement and
-- superseding a decision all leave a row somebody can read later.
create or replace function public.core_v2_audit(
  p_organization_id uuid, p_action text, p_entity_type text, p_entity_id text, p_detail jsonb
) returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.audit_events(organization_id, actor_id, action, entity_type, entity_id, detail)
  values (p_organization_id, auth.uid(), p_action, p_entity_type, p_entity_id,
          coalesce(p_detail, '{}'::jsonb));
end $$;

create or replace function public.core_v2_audit_decision_superseded() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'superseded' and old.status is distinct from 'superseded' then
    perform public.core_v2_audit(new.organization_id, 'core_v2.decision.superseded', 'decision',
      new.id::text, jsonb_build_object('workflow_id', new.workflow_id, 'was', old.status));
  end if;
  return null;
end $$;

create or replace function public.core_v2_audit_claim_superseded() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'superseded' and old.status is distinct from 'superseded' then
    perform public.core_v2_audit(new.organization_id, 'core_v2.claim.superseded', 'evidence_claim',
      new.id::text, jsonb_build_object('workflow_id', new.workflow_id, 'was', old.status));
  end if;
  return null;
end $$;

create trigger core_v2_decision_supersession_audit after update on public.decisions
  for each row execute function public.core_v2_audit_decision_superseded();
create trigger core_v2_claim_supersession_audit after update on public.evidence_claims
  for each row execute function public.core_v2_audit_claim_superseded();

-- ═══════════════════════════════ 12 · how the machine moves its own records
--
-- The worker runs as the service role, which is not subject to row-level
-- security — so these functions are not a permission boundary. They are the
-- named moves, one per machine, so that a transition is written in exactly one
-- place and the guard above is never routed around.
create or replace function public.core_v2_workflow_transition(
  p_workflow_id uuid, p_to_state text, p_error_code text default null, p_error_message text default null
) returns public.intelligence_workflows language plpgsql security definer set search_path = public as $$
declare row public.intelligence_workflows;
begin
  update public.intelligence_workflows
     set state = p_to_state,
         error_code = coalesce(p_error_code, error_code),
         error_message = coalesce(p_error_message, error_message),
         started_at = case when p_to_state = 'planning' and started_at is null then now() else started_at end,
         finished_at = case when p_to_state in ('completed','partial','failed','cancelled') then now() else finished_at end
   where id = p_workflow_id
  returning * into row;
  if not found then raise exception 'core_v2: no workflow %', p_workflow_id; end if;
  return row;
end $$;

create or replace function public.core_v2_task_transition(
  p_task_id uuid, p_to_state text, p_terminal_reason text default null
) returns public.extraction_tasks language plpgsql security definer set search_path = public as $$
declare row public.extraction_tasks;
begin
  update public.extraction_tasks
     set state = p_to_state,
         terminal_reason = coalesce(p_terminal_reason, terminal_reason),
         lease_owner = case when p_to_state in ('leased','running') then lease_owner end,
         lease_expires_at = case when p_to_state in ('leased','running') then lease_expires_at end
   where id = p_task_id
  returning * into row;
  if not found then raise exception 'core_v2: no task %', p_task_id; end if;
  return row;
end $$;

create or replace function public.core_v2_attempt_transition(
  p_attempt_id uuid, p_to_state text, p_error_code text default null, p_error_message text default null,
  p_usage jsonb default null, p_raw_response_path text default null
) returns public.agent_attempts language plpgsql security definer set search_path = public as $$
declare row public.agent_attempts;
begin
  update public.agent_attempts
     set state = p_to_state,
         error_code = coalesce(p_error_code, error_code),
         error_message = coalesce(p_error_message, error_message),
         usage = case when p_usage is null then usage else p_usage end,
         raw_response_path = coalesce(p_raw_response_path, raw_response_path),
         submitted_at = case when p_to_state = 'submitted' and submitted_at is null then now() else submitted_at end,
         received_at = case when p_to_state in ('response_received','output_limited') and received_at is null then now() else received_at end,
         finished_at = case when p_to_state in ('succeeded','failed_known','output_limited','outcome_unknown',
                                                'rejected_before_submission','cancelled_before_submission')
                            then now() else finished_at end
   where id = p_attempt_id
  returning * into row;
  if not found then raise exception 'core_v2: no attempt %', p_attempt_id; end if;
  return row;
end $$;

create or replace function public.core_v2_claim_transition(p_claim_id uuid, p_to_status text)
returns public.evidence_claims language plpgsql security definer set search_path = public as $$
declare row public.evidence_claims;
begin
  update public.evidence_claims set status = p_to_status where id = p_claim_id returning * into row;
  if not found then raise exception 'core_v2: no claim %', p_claim_id; end if;
  return row;
end $$;

create or replace function public.core_v2_disagreement_transition(
  p_disagreement_id uuid, p_to_state text, p_resolution_decision_id uuid default null
) returns public.disagreements language plpgsql security definer set search_path = public as $$
declare row public.disagreements;
begin
  update public.disagreements
     set state = p_to_state,
         resolution_decision_id = coalesce(p_resolution_decision_id, resolution_decision_id)
   where id = p_disagreement_id
  returning * into row;
  if not found then raise exception 'core_v2: no disagreement %', p_disagreement_id; end if;
  return row;
end $$;

create or replace function public.core_v2_decision_transition(
  p_decision_id uuid, p_to_status text, p_decided_by_attempt_id uuid default null
) returns public.decisions language plpgsql security definer set search_path = public as $$
declare row public.decisions;
begin
  update public.decisions
     set status = p_to_status,
         decided_by_attempt_id = coalesce(p_decided_by_attempt_id, decided_by_attempt_id),
         effective_at = case when p_to_status in ('machine_decided','human_decided') and effective_at is null
                             then now() else effective_at end
   where id = p_decision_id
  returning * into row;
  if not found then raise exception 'core_v2: no decision %', p_decision_id; end if;
  return row;
end $$;

-- A lease that ran out before anything was sent. The guard refuses the rest.
create or replace function public.core_v2_reclaim_expired_lease(p_task_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare row public.extraction_tasks;
begin
  select * into row from public.extraction_tasks where id = p_task_id;
  if not found then raise exception 'core_v2: no task %', p_task_id; end if;
  if row.state <> 'leased' or row.lease_expires_at is null or row.lease_expires_at > now() then
    return false;
  end if;
  update public.extraction_tasks
     set state = 'queued', lease_owner = null, lease_expires_at = null
   where id = p_task_id;
  return true;
end $$;

comment on function public.core_v2_reclaim_expired_lease(uuid) is
  'Returns an expired lease to the queue. Refused by the task guard when any attempt for that task was already submitted — the provider may have run.';

-- ═══════════════════════════════════════════════ 13 · what a person may ask
--
-- Four doors, each of which checks who is knocking. Everything else a person
-- does with V2 is reading.

-- Scope, written the same way every time, so that two people asking the same
-- question in a different key are asking the same question. Object keys sorted,
-- array members sorted, no whitespace of its own.
create or replace function public.core_v2_canonical_json(p_value jsonb)
returns jsonb language sql immutable as $$
  select case jsonb_typeof(p_value)
    when 'object' then coalesce(
      (select jsonb_object_agg(k, public.core_v2_canonical_json(p_value -> k))
         from (select k from jsonb_object_keys(p_value) as t(k) order by k) as keys),
      '{}'::jsonb)
    when 'array' then coalesce(
      (select jsonb_agg(e order by e::text)
         from (select public.core_v2_canonical_json(v) as e
                 from jsonb_array_elements(p_value) as a(v)) as items),
      '[]'::jsonb)
    else coalesce(p_value, 'null'::jsonb)
  end;
$$;

comment on function public.core_v2_canonical_json(jsonb) is
  'One written form for one meaning: keys sorted, array members sorted. Two scopes that say the same thing hash the same.';

-- A document Core V2 may read from. Path and byte size say where a file is
-- kept and how big it was, not which bytes it holds — a re-upload to the same
-- key at the same size is a different drawing wearing the same label. So a V2
-- source must carry either a whole-file digest or the storage system's own
-- immutable version id.
create or replace function public.core_v2_source_identity(document public.project_documents)
returns text language sql immutable as $$
  select case
    when document.sha256 is not null
     and document.content_hash_algorithm is not null
     and document.content_hash_scope = 'whole-file'
      then format('digest=%s:%s', document.content_hash_algorithm, document.sha256)
    when document.object_version_id is not null
      then format('version=%s', document.object_version_id)
  end;
$$;

comment on function public.core_v2_source_identity(public.project_documents) is
  'The immutable content identity of a document: a whole-file digest, or the storage version id. Null means the file has no trustworthy identity and Core V2 will not read it.';

-- The fingerprint of a set of sources, computed here so that no browser can
-- claim two different sets are the same one. Every document must belong to the
-- property being read; an id borrowed from another project stops the call.
create or replace function public.core_v2_source_set_fingerprint(
  p_property_id uuid, p_document_ids uuid[]
) returns text language plpgsql stable security definer set search_path = public as $$
declare
  org uuid;
  parts text;
  found_count integer;
  unidentified text;
begin
  if p_document_ids is null or array_length(p_document_ids, 1) is null then
    raise exception 'core_v2: a workflow must name the sources it reads';
  end if;
  -- Not an existence oracle. Somebody who is not in this organisation learns
  -- nothing here about what it holds.
  select p.organization_id into org from public.properties p where p.id = p_property_id;
  if org is null or not public.is_org_member(org) then
    raise exception 'core_v2: no such project';
  end if;

  select string_agg(
           format('%s|%s|%s|%s|%s|%s|%s|%s',
                  d.id,
                  public.core_v2_source_identity(d),
                  coalesce(d.storage_provider, ''),
                  coalesce(d.storage_bucket, ''),
                  d.storage_path,
                  coalesce(d.byte_size, 0),
                  coalesce(d.revision_label, ''),
                  coalesce(d.issued_at::text, '')),
           E'\n' order by d.id),
         count(*),
         string_agg(d.original_filename, ', ' order by d.id)
           filter (where public.core_v2_source_identity(d) is null)
    into parts, found_count, unidentified
    from public.project_documents d
   where d.id = any(p_document_ids) and d.property_id = p_property_id;

  if found_count is distinct from (select count(distinct u) from unnest(p_document_ids) as u) then
    raise exception 'core_v2: a source named here does not belong to this project';
  end if;
  if unidentified is not null then
    raise exception 'core_v2: % has no whole-file digest and no storage version — Core V2 does not read a file it cannot identify', unidentified;
  end if;
  return encode(sha256(convert_to(parts, 'UTF8')), 'hex');
end $$;

comment on function public.core_v2_source_set_fingerprint(uuid, uuid[]) is
  'Server-side hash of the exact document revisions a workflow was asked to read: content identity, storage location, size and revision. Refuses a document from another project, and a document with no trustworthy content identity.';

create or replace function public.core_v2_request_fingerprint(
  p_workflow_type text, p_source_set_fingerprint text, p_requested_scope jsonb, p_engine_version text
) returns text language sql immutable as $$
  select encode(sha256(convert_to(
    format('%s|%s|%s|%s', p_workflow_type, p_source_set_fingerprint,
           public.core_v2_canonical_json(coalesce(p_requested_scope, '{}'::jsonb))::text,
           p_engine_version), 'UTF8')), 'hex');
$$;

comment on function public.core_v2_request_fingerprint(text, text, jsonb, text) is
  'What was asked, not only of which files: type, source set, canonical scope and engine version. Reading three sheets and reading the whole set are different requests over the same sources.';

-- Create a workflow and its start command in one transaction. Nothing runs from
-- here: the row and the outbox command are the whole effect, and a dispatcher
-- that never comes leaves a workflow saying `created`, which is the truth.
create or replace function public.core_v2_start_workflow(
  p_property_id uuid,
  p_workflow_type text,
  p_source_document_ids uuid[],
  p_requested_scope jsonb default '{}'::jsonb,
  p_engine_version text default 'core-v2.0',
  p_expected_fingerprint text default null,
  p_authorize_duplicate boolean default false
) returns public.intelligence_workflows language plpgsql security definer set search_path = public as $$
declare
  org uuid;
  fingerprint text;
  request text;
  live public.intelligence_workflows;
  duplicate boolean := false;
  row public.intelligence_workflows;
begin
  select p.organization_id into org from public.properties p where p.id = p_property_id;
  if org is null then raise exception 'core_v2: no such project'; end if;
  if not public.has_org_role(org, array['owner','admin']::public.studio_role[]) then
    raise exception 'core_v2: only an owner or an administrator starts an analysis';
  end if;

  fingerprint := public.core_v2_source_set_fingerprint(p_property_id, p_source_document_ids);
  if p_expected_fingerprint is not null and p_expected_fingerprint <> fingerprint then
    raise exception 'core_v2: the sources have changed since this was prepared — nothing was started';
  end if;
  request := public.core_v2_request_fingerprint(
    p_workflow_type, fingerprint, p_requested_scope, p_engine_version);

  select * into live from public.intelligence_workflows w
   where w.property_id = p_property_id
     and w.request_fingerprint = request
     and w.state in ('created','queued','planning','running','needs_attention','ready_for_decision','deciding')
   limit 1;
  duplicate := found;
  if duplicate and p_workflow_type <> 'benchmark' and not p_authorize_duplicate then
    raise exception 'core_v2: this is already being read by workflow % — open it, or authorise a second reading', live.id;
  end if;

  insert into public.intelligence_workflows(
    organization_id, property_id, workflow_type, engine_version,
    source_set_fingerprint, request_fingerprint,
    requested_by, requested_scope,
    duplicate_authorized_by)
  values (org, p_property_id, p_workflow_type, p_engine_version,
          fingerprint, request,
          auth.uid(), public.core_v2_canonical_json(coalesce(p_requested_scope, '{}'::jsonb)),
          case when duplicate and p_authorize_duplicate then auth.uid() end)
  returning * into row;

  -- Same transaction, always. A workflow without its start command would be a
  -- reading nobody ever runs; a command without its workflow would start work
  -- with nowhere to write it.
  insert into public.workflow_outbox(organization_id, property_id, workflow_id, command, payload)
  values (org, p_property_id, row.id, 'start',
          jsonb_build_object(
            'workflow_id', row.id,
            'property_id', p_property_id,
            'workflow_type', p_workflow_type,
            'engine_version', p_engine_version,
            'source_document_ids', to_jsonb(p_source_document_ids),
            'source_set_fingerprint', fingerprint,
            'request_fingerprint', request));

  perform public.core_v2_audit(org, 'core_v2.workflow.started', 'intelligence_workflow', row.id::text,
    jsonb_build_object('property_id', p_property_id, 'workflow_type', p_workflow_type,
                       'source_set_fingerprint', fingerprint, 'request_fingerprint', request,
                       'duplicate_authorized', coalesce(row.duplicate_authorized_by is not null, false)));
  return row;
end $$;

comment on function public.core_v2_start_workflow(uuid, text, uuid[], jsonb, text, text, boolean) is
  'Creates a workflow and its one start command atomically. Calls no provider, spends nothing, and refuses a second live request over the same sources and scope unless a person authorises it.';

-- Stop what has not been sent. What was sent is not un-sent: it is named and
-- left to reconcile, because a request that may already have been billed cannot
-- be undone by a button.
create or replace function public.core_v2_cancel_workflow(p_workflow_id uuid, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  wf public.intelligence_workflows;
  unsent integer := 0;
  submitted integer := 0;
  preserved integer := 0;
begin
  select * into wf from public.intelligence_workflows where id = p_workflow_id;
  if not found then raise exception 'core_v2: no such workflow'; end if;
  if not public.has_org_role(wf.organization_id, array['owner','admin']::public.studio_role[]) then
    raise exception 'core_v2: only an owner or an administrator stops an analysis';
  end if;

  update public.intelligence_workflows set cancel_requested_at = coalesce(cancel_requested_at, now())
   where id = p_workflow_id;

  -- Only what has not left. A task whose request is already with a provider
  -- keeps its state and is counted as outstanding below.
  with stopped as (
    update public.extraction_tasks t
       set state = 'cancelled',
           terminal_reason = coalesce(p_reason, 'stopped_by_person')
     where t.workflow_id = p_workflow_id
       and t.state in ('created','blocked','queued','leased')
       and not exists (select 1 from public.agent_attempts a
                        where a.task_id = t.id
                          and a.state in ('submitted','response_received','parsed','succeeded',
                                          'output_limited','outcome_unknown'))
    returning 1)
  select count(*) into unsent from stopped;

  select count(*) into submitted from public.extraction_tasks t
   where t.workflow_id = p_workflow_id
     and exists (select 1 from public.agent_attempts a
                  where a.task_id = t.id
                    and a.state in ('submitted','response_received','outcome_unknown'));

  select count(*) into preserved from public.extraction_tasks t
   where t.workflow_id = p_workflow_id and t.state = 'completed';

  if wf.state in ('created','queued','planning','running','needs_attention') then
    perform public.core_v2_workflow_transition(p_workflow_id, 'cancelled', 'cancelled_by_person', p_reason);
  end if;

  perform public.core_v2_audit(wf.organization_id, 'core_v2.workflow.cancelled', 'intelligence_workflow',
    p_workflow_id::text, jsonb_build_object('reason', p_reason, 'unsent_cancelled', unsent,
      'submitted_unresolved', submitted, 'completed_preserved', preserved));

  return jsonb_build_object('workflow_id', p_workflow_id, 'unsent_cancelled', unsent,
    'submitted_unresolved', submitted, 'completed_preserved', preserved);
end $$;

-- A task that ended without a known provider outcome is not re-run by anything
-- that is not a person. This is the only door, and it records who opened it.
create or replace function public.core_v2_authorize_task_retry(p_task_id uuid, p_note text default null)
returns public.extraction_tasks language plpgsql security definer set search_path = public as $$
declare
  task public.extraction_tasks;
  row public.extraction_tasks;
begin
  select * into task from public.extraction_tasks where id = p_task_id;
  if not found then raise exception 'core_v2: no such task'; end if;
  if not public.has_org_role(task.organization_id, array['owner','admin']::public.studio_role[]) then
    raise exception 'core_v2: only an owner or an administrator authorises running a task again';
  end if;
  if task.state not in ('outcome_unknown','failed_known') then
    raise exception 'core_v2: task % is % — there is nothing to authorise', p_task_id, task.state;
  end if;

  perform set_config('core_v2.authorized_retry', p_task_id::text, true);
  update public.extraction_tasks
     set state = 'queued',
         retry_authorized_by = auth.uid(),
         retry_authorized_at = now(),
         lease_owner = null,
         lease_expires_at = null
   where id = p_task_id
  returning * into row;
  perform set_config('core_v2.authorized_retry', '', true);

  perform public.core_v2_audit(task.organization_id, 'core_v2.task.retry_authorized', 'extraction_task',
    p_task_id::text, jsonb_build_object('was', task.state, 'note', p_note,
      'workflow_id', task.workflow_id));
  return row;
end $$;

comment on function public.core_v2_authorize_task_retry(uuid, text) is
  'The only way a task that ended as outcome_unknown or failed_known runs again. Requires an owner or administrator and writes an audit event.';

-- Settle a disagreement. Whatever the answer, every competing claim stays: the
-- one that won is accepted, the ones that lost are rejected and readable, and
-- the decision that says so names all of them.
--
-- Four outcomes, and only one of them is a resolution of nothing:
--   accept_claim         · one of the readings was right
--   correct              · none was, and a person read the source and says what is
--   reject_all           · none was, and the source does not support any of them
--   needs_more_evidence  · nobody can tell yet — this is NOT a resolution
create or replace function public.core_v2_resolve_disagreement(
  p_disagreement_id uuid,
  p_outcome text,
  p_note text default null,
  p_accepted_claim_id uuid default null,
  p_corrected_value jsonb default null,
  p_corrected_unit text default null,
  p_corrected_basis text default null,
  p_corrected_source text default null,
  p_evidence_anchor_ids uuid[] default null
) returns public.decisions language plpgsql security definer set search_path = public as $$
declare
  dis public.disagreements;
  winner public.evidence_claims;
  template public.evidence_claims;
  decision public.decisions;
  loser uuid;
  anchor uuid;
  anchor_property uuid;
  kept jsonb;
begin
  select * into dis from public.disagreements where id = p_disagreement_id;
  if not found then raise exception 'core_v2: no such disagreement'; end if;
  -- Owner, administrator and reviewer settle evidence disagreements. Starting,
  -- stopping, authorising a repeat and releasing for order stay with owner and
  -- administrator.
  if not public.has_org_role(dis.organization_id,
        array['owner','admin','reviewer']::public.studio_role[]) then
    raise exception 'core_v2: only an owner, an administrator or a reviewer settles a disagreement';
  end if;
  if dis.state not in ('open','verifying','needs_human') then
    raise exception 'core_v2: disagreement % is % — it is not open', p_disagreement_id, dis.state;
  end if;

  select jsonb_agg(dc.claim_id order by dc.position, dc.claim_id) into kept
    from public.disagreement_claims dc where dc.disagreement_id = dis.id;

  -- Asking for more evidence settles nothing, and says so. It moves the
  -- disagreement to where a person can see it and writes its own event; it never
  -- writes the word `resolved`.
  if p_outcome = 'needs_more_evidence' then
    perform public.core_v2_disagreement_transition(p_disagreement_id, 'needs_human');
    perform public.core_v2_audit(dis.organization_id, 'core_v2.disagreement.more_evidence_requested',
      'disagreement', p_disagreement_id::text,
      jsonb_build_object('note', p_note, 'claims_kept', kept));
    return null;
  end if;

  if p_outcome = 'accept_claim' then
    if p_accepted_claim_id is null
       or not exists (select 1 from public.disagreement_claims dc
                       where dc.disagreement_id = dis.id and dc.claim_id = p_accepted_claim_id) then
      raise exception 'core_v2: the accepted claim must be one of the claims that disagreed';
    end if;
    winner := public.core_v2_claim_transition(p_accepted_claim_id, 'accepted');
  elsif p_outcome = 'correct' then
    -- None of the readings was right. The person supplies the corrected value
    -- and what they read it off; that becomes a human claim with a human anchor,
    -- and it supersedes nothing quietly — the readings it replaces are rejected
    -- below and stay in the record.
    if p_corrected_value is null or p_corrected_source is null then
      raise exception 'core_v2: a correction needs both the corrected value and the source it was read from';
    end if;
    select c.* into template from public.disagreement_claims dc
      join public.evidence_claims c on c.id = dc.claim_id
     where dc.disagreement_id = dis.id order by dc.position, dc.claim_id limit 1;
    insert into public.evidence_claims(
      organization_id, property_id, workflow_id, subject_type, subject_key, predicate,
      value, unit, observation_basis, scope, status, supersedes_claim_id)
    values (dis.organization_id, dis.property_id, dis.workflow_id, template.subject_type,
            template.subject_key, template.predicate, p_corrected_value, p_corrected_unit,
            coalesce(p_corrected_basis, 'printed'), template.scope, 'accepted', template.id)
    returning * into winner;
    insert into public.evidence_anchors(organization_id, property_id, claim_id, source_kind,
      quoted_text, anchor_hash, locator)
    values (dis.organization_id, dis.property_id, winner.id, 'human_record', p_corrected_source,
            encode(sha256(convert_to(winner.id::text || p_corrected_source, 'UTF8')), 'hex'),
            jsonb_build_object('recorded_by', auth.uid(), 'note', p_note));
  elsif p_outcome = 'reject_all' then
    -- The source supports none of them. That is an adjudication with its own
    -- burden of proof, not a shrug: every competing claim is rejected and named,
    -- and the decision points at what the source does show.
    if p_evidence_anchor_ids is null or array_length(p_evidence_anchor_ids, 1) is null then
      raise exception 'core_v2: rejecting every reading needs at least one source anchor saying what the drawing shows';
    end if;
  else
    raise exception 'core_v2: % is not an outcome this function knows', p_outcome;
  end if;

  insert into public.decisions(organization_id, property_id, workflow_id, decision_type,
    subject_entity_id, title, decision, status, authority, rationale, decided_by_user_id, effective_at)
  values (dis.organization_id, dis.property_id, dis.workflow_id,
    case when p_outcome = 'reject_all' then 'reject_all' else 'accept_claim' end,
    case when winner.id is not null then winner.canonical_entity_id end,
    case when p_outcome = 'reject_all'
         then format('No reading of %s is supported by the source', dis.disagreement_key)
         else format('%s %s', winner.subject_key, winner.predicate) end,
    jsonb_build_object('outcome', p_outcome, 'accepted_claim_id', winner.id,
                       'disagreement_id', p_disagreement_id),
    -- Proposed first, then decided: a decided decision's evidence set is closed,
    -- so the links below have to be written while it is still open. The
    -- transition at the end is what makes it authoritative.
    'proposed', 'human', coalesce(p_note, ''), auth.uid(), null)
  returning * into decision;

  if winner.id is not null then
    insert into public.decision_evidence(organization_id, property_id, decision_id, claim_id, link, rule)
    values (dis.organization_id, dis.property_id, decision.id, winner.id, 'supports', 'human_resolution');
  end if;

  -- The claims that lost. Rejected, linked to the decision that rejected them,
  -- and still there to read.
  for loser in
    select dc.claim_id from public.disagreement_claims dc
     where dc.disagreement_id = dis.id and dc.claim_id is distinct from winner.id
     order by dc.position, dc.claim_id
  loop
    perform public.core_v2_claim_transition(loser, 'rejected');
    insert into public.decision_evidence(organization_id, property_id, decision_id, claim_id, link, rule)
    values (dis.organization_id, dis.property_id, decision.id, loser, 'contradicts', 'human_resolution');
  end loop;

  if p_outcome = 'reject_all' then
    foreach anchor in array p_evidence_anchor_ids loop
      select a.property_id into anchor_property from public.evidence_anchors a where a.id = anchor;
      if anchor_property is distinct from dis.property_id then
        raise exception 'core_v2: that source anchor does not belong to this project';
      end if;
      insert into public.decision_evidence(organization_id, property_id, decision_id, anchor_id, link, rule)
      values (dis.organization_id, dis.property_id, decision.id, anchor, 'context', 'human_resolution');
    end loop;
  end if;

  -- proposed -> needs_human -> human_decided, the path section 8.6 gives a
  -- decision a person makes. The evidence above was written while it was still
  -- open; from here it is closed.
  perform public.core_v2_decision_transition(decision.id, 'needs_human');
  decision := public.core_v2_decision_transition(decision.id, 'human_decided');
  perform public.core_v2_disagreement_transition(p_disagreement_id, 'resolved', decision.id);
  perform public.core_v2_audit(dis.organization_id, 'core_v2.disagreement.resolved', 'disagreement',
    p_disagreement_id::text, jsonb_build_object('outcome', p_outcome, 'note', p_note,
      'decision_id', decision.id, 'accepted_claim_id', winner.id,
      'claims_kept', kept));
  return decision;
end $$;

comment on function public.core_v2_resolve_disagreement(uuid, text, text, uuid, jsonb, text, text, text, uuid[]) is
  'A person settles a conflict: accept one reading, record a sourced correction, reject them all with source evidence, or ask for more evidence — which settles nothing and says so. Every competing claim is kept either way.';
-- ══════════════════════════════════════════════════════ 14 · who may see what
--
-- Every table here is readable by the organisation whose project it belongs to,
-- and writable through a browser by nobody. There is deliberately not one
-- insert, update or delete policy in this file: the worker writes as the
-- service role, and a person acts through the four functions above.
alter table public.intelligence_workflows enable row level security;
alter table public.workflow_outbox enable row level security;
alter table public.source_pages enable row level security;
alter table public.page_regions enable row level security;
alter table public.extraction_tasks enable row level security;
alter table public.task_dependencies enable row level security;
alter table public.agent_attempts enable row level security;
alter table public.evidence_claims enable row level security;
alter table public.evidence_anchors enable row level security;
alter table public.project_entities enable row level security;
alter table public.entity_aliases enable row level security;
alter table public.entity_relations enable row level security;
alter table public.claim_assessments enable row level security;
alter table public.claim_assessment_anchors enable row level security;
alter table public.disagreement_claims enable row level security;
alter table public.disagreements enable row level security;
alter table public.decisions enable row level security;
alter table public.decision_evidence enable row level security;
alter table public.decision_actions enable row level security;

do $$
declare t text;
begin
  foreach t in array array[
    'intelligence_workflows','workflow_outbox','source_pages','page_regions','extraction_tasks',
    'task_dependencies','agent_attempts','evidence_claims','evidence_anchors','project_entities',
    'entity_aliases','entity_relations','claim_assessments','claim_assessment_anchors',
    'disagreements','disagreement_claims','decisions','decision_evidence','decision_actions']
  loop
    execute format('drop policy if exists %I on public.%I', 'core_v2_' || t || '_read', t);
    execute format(
      'create policy %I on public.%I for select using (public.is_org_member(organization_id))',
      'core_v2_' || t || '_read', t);
  end loop;
end $$;

-- The machine's own moves belong to the machine. A signed-out visitor has no
-- path to any of them, and no path to starting work either.
revoke all on function public.core_v2_workflow_transition(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.core_v2_task_transition(uuid, text, text) from public, anon, authenticated;
revoke all on function public.core_v2_attempt_transition(uuid, text, text, text, jsonb, text) from public, anon, authenticated;
revoke all on function public.core_v2_claim_transition(uuid, text) from public, anon, authenticated;
revoke all on function public.core_v2_disagreement_transition(uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.core_v2_decision_transition(uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.core_v2_reclaim_expired_lease(uuid) from public, anon, authenticated;
revoke all on function public.core_v2_audit(uuid, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.core_v2_workflow_transition(uuid, text, text, text) to service_role;
grant execute on function public.core_v2_task_transition(uuid, text, text) to service_role;
grant execute on function public.core_v2_attempt_transition(uuid, text, text, text, jsonb, text) to service_role;
grant execute on function public.core_v2_claim_transition(uuid, text) to service_role;
grant execute on function public.core_v2_disagreement_transition(uuid, text, uuid) to service_role;
grant execute on function public.core_v2_decision_transition(uuid, text, uuid) to service_role;
grant execute on function public.core_v2_reclaim_expired_lease(uuid) to service_role;
grant execute on function public.core_v2_audit(uuid, text, text, text, jsonb) to service_role;

revoke all on function public.core_v2_start_workflow(uuid, text, uuid[], jsonb, text, text, boolean) from public, anon;
revoke all on function public.core_v2_cancel_workflow(uuid, text) from public, anon;
revoke all on function public.core_v2_authorize_task_retry(uuid, text) from public, anon;
revoke all on function public.core_v2_resolve_disagreement(uuid, text, text, uuid, jsonb, text, text, text, uuid[]) from public, anon;
revoke all on function public.core_v2_source_set_fingerprint(uuid, uuid[]) from public, anon;
grant execute on function public.core_v2_start_workflow(uuid, text, uuid[], jsonb, text, text, boolean) to authenticated, service_role;
grant execute on function public.core_v2_cancel_workflow(uuid, text) to authenticated, service_role;
grant execute on function public.core_v2_authorize_task_retry(uuid, text) to authenticated, service_role;
grant execute on function public.core_v2_resolve_disagreement(uuid, text, text, uuid, jsonb, text, text, text, uuid[]) to authenticated, service_role;
grant execute on function public.core_v2_source_set_fingerprint(uuid, uuid[]) to authenticated, service_role;

-- ═════════════════════════════════════ 15 · one project, all the way down
--
-- Section 16.8: source and evidence records cannot cross organisations through
-- ids, signed urls, search, comparison, or joins. The browser cannot write any
-- of these tables at all, so the risk is not a malicious form post — it is a
-- worker, a fixture or a future migration writing a row whose organisation and
-- property do not belong together, or joining a row of one project to a row of
-- another and producing a decision that opens somebody else's drawing.
--
-- Three things are checked on the way in, for every writer including the
-- service role:
--
--   · the property named on the row really belongs to the organisation named
--     on it. They are one identity written twice, not two independent labels;
--   · neither of them ever changes afterwards. A row does not move house;
--   · every reference the row carries resolves to that same property.
-- Both lookups are `security definer` on purpose. A tenancy guard that could
-- only see what the caller can see would answer "no such project" instead of
-- "another project", and would be weaker for the reader who has least access.
create or replace function public.core_v2_property_of(p_table text, p_id uuid)
returns uuid language plpgsql stable security definer set search_path = public as $$
declare found uuid;
begin
  if p_id is null then return null; end if;
  execute format('select property_id from public.%I where id = $1', p_table)
    into found using p_id;
  return found;
end $$;

create or replace function public.core_v2_organization_of_property(p_property_id uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select p.organization_id from public.properties p where p.id = p_property_id;
$$;

create or replace function public.core_v2_guard_tenancy() returns trigger
language plpgsql as $$
declare
  i integer := 0;
  column_name text;
  parent_table text;
  child uuid;
  parent_property uuid;
  owning_org uuid;
  row_json jsonb := to_jsonb(new);
begin
  -- The tenant root. An organisation and a property that do not belong together
  -- are not a mislabelled row: they are a row that two different tenants could
  -- each claim to own.
  owning_org := public.core_v2_organization_of_property(new.property_id);
  if owning_org is null then
    raise exception 'core_v2: %.property_id names a project that does not exist', TG_TABLE_NAME
      using errcode = 'check_violation';
  end if;
  if owning_org <> new.organization_id then
    raise exception 'core_v2: % says organisation % but its project belongs to %',
      TG_TABLE_NAME, new.organization_id, owning_org using errcode = 'check_violation';
  end if;

  if TG_OP = 'UPDATE' then
    if new.organization_id is distinct from old.organization_id
       or new.property_id is distinct from old.property_id then
      raise exception 'core_v2: a % row does not change project after it is written', TG_TABLE_NAME
        using errcode = 'check_violation';
    end if;
  end if;

  while i < TG_NARGS loop
    column_name := TG_ARGV[i];
    parent_table := TG_ARGV[i + 1];
    child := nullif(row_json ->> column_name, '')::uuid;
    if child is not null then
      parent_property := public.core_v2_property_of(parent_table, child);
      if parent_property is null then
        raise exception 'core_v2: %.% points at a % that does not exist',
          TG_TABLE_NAME, column_name, parent_table using errcode = 'check_violation';
      elsif parent_property <> new.property_id then
        raise exception 'core_v2: %.% points at a % in another project',
          TG_TABLE_NAME, column_name, parent_table using errcode = 'check_violation';
      end if;
    end if;
    i := i + 2;
  end loop;
  return new;
end $$;

comment on function public.core_v2_guard_tenancy() is
  'Proves that a Core V2 row''s property belongs to its organisation, that neither changes afterwards, and that every reference it carries resolves to the same property. Trigger arguments are pairs of column name and parent table.';

create trigger core_v2_tenancy before insert or update on public.intelligence_workflows
  for each row execute function public.core_v2_guard_tenancy();
create trigger core_v2_tenancy before insert or update on public.workflow_outbox
  for each row execute function public.core_v2_guard_tenancy('workflow_id','intelligence_workflows');
create trigger core_v2_tenancy before insert or update on public.source_pages
  for each row execute function public.core_v2_guard_tenancy('document_id','project_documents');
create trigger core_v2_tenancy before insert or update on public.page_regions
  for each row execute function public.core_v2_guard_tenancy(
    'page_id','source_pages','parent_region_id','page_regions');
create trigger core_v2_tenancy before insert or update on public.extraction_tasks
  for each row execute function public.core_v2_guard_tenancy(
    'workflow_id','intelligence_workflows','parent_task_id','extraction_tasks',
    'created_by_task_id','extraction_tasks');
create trigger core_v2_tenancy before insert or update on public.task_dependencies
  for each row execute function public.core_v2_guard_tenancy(
    'task_id','extraction_tasks','depends_on_task_id','extraction_tasks');
create trigger core_v2_tenancy before insert or update on public.agent_attempts
  for each row execute function public.core_v2_guard_tenancy('task_id','extraction_tasks');
create trigger core_v2_tenancy before insert or update on public.evidence_claims
  for each row execute function public.core_v2_guard_tenancy(
    'workflow_id','intelligence_workflows','attempt_id','agent_attempts',
    'supersedes_claim_id','evidence_claims','canonical_entity_id','project_entities');
create trigger core_v2_tenancy before insert or update on public.evidence_anchors
  for each row execute function public.core_v2_guard_tenancy(
    'claim_id','evidence_claims','document_id','project_documents','page_id','source_pages',
    'region_id','page_regions','evidence_item_id','evidence_items');
create trigger core_v2_tenancy before insert or update on public.project_entities
  for each row execute function public.core_v2_guard_tenancy(
    'first_seen_workflow_id','intelligence_workflows','last_seen_workflow_id','intelligence_workflows');
create trigger core_v2_tenancy before insert or update on public.entity_aliases
  for each row execute function public.core_v2_guard_tenancy(
    'entity_id','project_entities','attempt_id','agent_attempts');
create trigger core_v2_tenancy before insert or update on public.entity_relations
  for each row execute function public.core_v2_guard_tenancy(
    'from_entity_id','project_entities','to_entity_id','project_entities','decision_id','decisions');
create trigger core_v2_tenancy before insert or update on public.claim_assessments
  for each row execute function public.core_v2_guard_tenancy(
    'claim_id','evidence_claims','attempt_id','agent_attempts');
create trigger core_v2_tenancy before insert or update on public.claim_assessment_anchors
  for each row execute function public.core_v2_guard_tenancy(
    'assessment_id','claim_assessments','anchor_id','evidence_anchors');
create trigger core_v2_tenancy before insert or update on public.disagreements
  for each row execute function public.core_v2_guard_tenancy(
    'workflow_id','intelligence_workflows','resolution_decision_id','decisions');
create trigger core_v2_tenancy before insert or update on public.disagreement_claims
  for each row execute function public.core_v2_guard_tenancy(
    'disagreement_id','disagreements','claim_id','evidence_claims');
create trigger core_v2_tenancy before insert or update on public.decisions
  for each row execute function public.core_v2_guard_tenancy(
    'workflow_id','intelligence_workflows','subject_entity_id','project_entities',
    'decided_by_attempt_id','agent_attempts','supersedes_decision_id','decisions');
create trigger core_v2_tenancy before insert or update on public.decision_evidence
  for each row execute function public.core_v2_guard_tenancy(
    'decision_id','decisions','claim_id','evidence_claims','anchor_id','evidence_anchors');
create trigger core_v2_tenancy before insert or update on public.decision_actions
  for each row execute function public.core_v2_guard_tenancy(
    'decision_id','decisions','completion_evidence_id','evidence_items');

-- ═══════════════════════════════════════ 16 · the ledger can name Core V2
--
-- One process key for the whole engine, not one per task type: what the work
-- was is on the task, what it read is in the input fingerprint, and which
-- attempt bought it is `job_table`/`job_id`. A ledger whose vocabulary grows
-- with every new contract cannot be reconciled against an invoice.
--
-- This adds one value to an existing check. No V1 row is read, written or
-- reinterpreted by it.
alter table public.ai_runs drop constraint if exists ai_runs_process_key_check;
alter table public.ai_runs
  add constraint ai_runs_process_key_check
  check (process_key in (
    'plan-analyze', 'spatial-analyze', 'document-classify',
    'document-evidence', 'field-quality-check', 'project-search', 'compare-readings',
    'core-v2'));

-- One attempt, one ledger row. Two attempts sharing a claim on the same call
-- would make the same money look like two purchases, or hide a second one.
create unique index if not exists agent_attempts_one_ledger_row
  on public.agent_attempts(ai_run_id) where ai_run_id is not null;
