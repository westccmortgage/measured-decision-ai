-- 058 · Core V2: the record a decision can be traced through.
--
-- Core V2 is a universal decision kernel. A workflow reads a set of immutable
-- sources, hands bounded pieces of them to independent analysts, keeps every
-- assertion they make as a claim anchored to the place it was read, notices
-- where readings disagree, verifies and adjudicates, and ends in a decision
-- that can be followed back down:
--
--     decision -> accepted claim(s) -> source anchor(s) -> immutable source
--
-- Everything below exists to make that chain a property of the database rather
-- than a habit of the code that writes to it. A claim cannot be accepted with
-- nothing to point at. A decision cannot be decided with nothing accepted
-- behind it. A request whose outcome nobody knows is never retried by a
-- machine. An accepted record is never edited — it is superseded, and both
-- versions stay.
--
-- What the kernel does not know: what a source is, what a segment of one is,
-- which roles read it, what subjects and predicates they report, what a unit
-- means. Those belong to a domain pack and reach this schema as text. The
-- vocabularies enumerated here are the kernel's own: phases, executor kinds,
-- observation bases, anchor kinds, assessments, disagreement kinds and
-- decision types.
--
-- What this migration deliberately is NOT:
--   · it starts nothing. No worker, no provider call, no queue runs from here.
--   · it references no table an existing project owns. Tenancy is the
--     organisation and only the organisation; every reference a row carries
--     stays inside one organisation and one workflow.
--   · it gives the browser no way to write machine state. There is not one
--     insert, update or delete policy on any table in this file. Machine rows
--     are written by the service role; people act through the named doors at
--     the end, each of which checks who is asking.

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
      -- A task already offered to workers can gain a prerequisite it did not
      -- have when it was planned — a follow-up it must now wait for. It goes
      -- back to waiting; it does not run with a dependency unmet.
      ('task','queued','blocked'),
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
      -- segment
      ('segment','proposed','accepted'),
      ('segment','proposed','rejected'),
      ('segment','proposed','superseded'),
      ('segment','accepted','superseded'),
      ('segment','rejected','superseded'),
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

-- The states in which a workflow may still do work, and the attempt states
-- after which a request may have reached an executor. Both lists are consulted
-- from several guards and doors; one spelling keeps them from drifting apart.
create or replace function public.core_v2_workflow_active(p_state text)
returns boolean language sql immutable as $$
  select p_state in ('created','queued','planning','running','needs_attention','ready_for_decision','deciding');
$$;

create or replace function public.core_v2_attempt_submitted(p_state text)
returns boolean language sql immutable as $$
  select p_state in ('submitted','response_received','parsed','succeeded','output_limited','outcome_unknown');
$$;

create or replace function public.core_v2_touch() returns trigger
language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

-- A box, expressed the way every reader must express it: four numbers between
-- 0 and 1, in order. A pixel box from one rendering cannot be compared with a
-- pixel box from another; this one can.
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

-- A range, whatever it measures: both ends present, both numbers, start no
-- later than end. A locator with one end and not the other is not a range at
-- all. Every `start_x`/`end_x` pair is held to this, so a register's rows and
-- a stream's bytes get the guarantee a recording's seconds always had — and
-- time runs forward from zero, so nothing is cited before a recording began.
create or replace function public.core_v2_ranges_well_formed(p_locator jsonb)
returns boolean language sql immutable as $$
  select p_locator is null
     or (not exists (
           select 1 from jsonb_object_keys(p_locator) as k(key)
            where key like 'start!_%' escape '!'
              and (jsonb_typeof(p_locator -> key) is distinct from 'number'
                   or jsonb_typeof(p_locator -> ('end_' || substr(key, 7))) is distinct from 'number'
                   or (p_locator ->> key)::numeric
                      > (p_locator ->> ('end_' || substr(key, 7)))::numeric))
         and not exists (
           select 1 from jsonb_object_keys(p_locator) as k(key)
            where key like 'end!_%' escape '!'
              and jsonb_typeof(p_locator -> ('start_' || substr(key, 5))) is distinct from 'number')
         and coalesce((p_locator ->> 'start_ms')::numeric >= 0, true));
$$;

-- The kernel does not know what a locator means. It does know the shapes that
-- must compare across readings — a normalised box and a range of any measure —
-- and refuses either when malformed.
create or replace function public.core_v2_locator_well_formed(p_locator jsonb)
returns boolean language sql immutable as $$
  select public.core_v2_is_normalised_bbox(p_locator -> 'bbox')
     and public.core_v2_ranges_well_formed(p_locator);
$$;

-- The older, narrower spelling. Nothing calls it now that every range is
-- checked the same way.
drop function if exists public.core_v2_is_time_range(jsonb);

create or replace function public.core_v2_bbox_within(p_inner jsonb, p_outer jsonb)
returns boolean language sql immutable as $$
  select (p_inner ->> 0)::numeric >= (p_outer ->> 0)::numeric
     and (p_inner ->> 1)::numeric >= (p_outer ->> 1)::numeric
     and (p_inner ->> 2)::numeric <= (p_outer ->> 2)::numeric
     and (p_inner ->> 3)::numeric <= (p_outer ->> 3)::numeric;
$$;

-- Whether every range the inner locator shares with the outer one lies inside
-- it. The kernel does not know what a row or a millisecond means; it does know
-- that a piece of a thing is not allowed to sit outside the thing.
create or replace function public.core_v2_range_within(p_inner jsonb, p_outer jsonb)
returns boolean language sql immutable as $$
  select not exists (
    select 1 from jsonb_object_keys(p_outer) as k(key)
     where key like 'start!_%' escape '!'
       and p_inner ? key
       and ((p_inner ->> key)::numeric < (p_outer ->> key)::numeric
            or (p_inner ->> ('end_' || substr(key, 7)))::numeric
               > (p_outer ->> ('end_' || substr(key, 7)))::numeric));
$$;

-- A budget is read by triggers as integers. A budget that cannot be read that
-- way is refused when written, not discovered when the first task arrives.
create or replace function public.core_v2_budget_well_formed(p_budget jsonb)
returns boolean language sql immutable as $$
  select jsonb_typeof(p_budget) = 'object'
     and not exists (
       select 1 from jsonb_each(p_budget) as b(key, value)
        where b.key in ('maximum_tasks','maximum_dependency_edges','maximum_child_tasks_per_parent',
                        'maximum_follow_up_depth','maximum_critic_rounds','maximum_arbiter_rounds')
          and (jsonb_typeof(b.value) <> 'number'
               or (b.value)::numeric < 0
               or (b.value)::numeric <> trunc((b.value)::numeric)));
$$;

-- ═══════════════════════════════════════════════════════════ 2 · the workflow
--
-- One requested analysis. Its id is also the durable orchestrator's workflow
-- id, which is what makes starting the same work twice harmless.
create table if not exists public.intelligence_workflows (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- Which domain pack interprets the sources, at which version. The kernel
  -- records the pair and never looks inside it.
  domain_pack text not null,
  domain_pack_version text not null,
  workflow_type text not null,
  engine_version text not null check (engine_version like 'core-v2%'),
  state text not null default 'created' check (state in (
    'created', 'queued', 'planning', 'running', 'needs_attention',
    'ready_for_decision', 'deciding', 'completed', 'partial', 'failed', 'cancelled')),

  -- Two hashes, because they answer two different questions. The source-set
  -- fingerprint says WHICH immutable sources were read: content identity,
  -- locator, size. The request fingerprint says WHAT WAS ASKED of them: the
  -- pack, the type of work, that source set, the canonical scope and the
  -- engine version. Two scopes over one source set are two requests.
  --
  -- Both are computed on the server. A caller may state what it believes and be
  -- told it is stale; it never supplies the value.
  source_set_fingerprint text not null,
  request_fingerprint text not null,
  requested_by uuid references auth.users(id),
  requested_scope jsonb not null default '{}'::jsonb,

  -- The policy the planner ran under, snapshotted here so that the limits a
  -- workflow was admitted with are the limits it is held to, whatever the
  -- policy says later. Enforced by the task and edge triggers below.
  budget jsonb not null default '{}'::jsonb,

  -- Set by the dispatcher after the orchestrator acknowledges the start.
  orchestrator_run_id text,
  cancel_requested_at timestamptz,

  -- Counted, never estimated. Elapsed time is not progress.
  completed_units integer not null default 0 check (completed_units >= 0),
  total_units integer not null default 0 check (total_units >= 0),
  attention_units integer not null default 0 check (attention_units >= 0),

  error_code text,
  error_message text,

  -- A second workflow over the same request exists only because a person said
  -- so. This column is who said it; without it the refusal below has no
  -- exception.
  duplicate_authorized_by uuid references auth.users(id),

  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint intelligence_workflows_budget_readable check (public.core_v2_budget_well_formed(budget))
);

comment on table public.intelligence_workflows is
  'One requested analysis under one domain pack. The row id is the durable workflow id, so a duplicate start is harmless.';
comment on column public.intelligence_workflows.budget is
  'The planning limits this workflow was admitted under: maximum_tasks, maximum_dependency_edges, maximum_child_tasks_per_parent, maximum_follow_up_depth, maximum_critic_rounds, maximum_arbiter_rounds. Absent keys mean no limit.';
comment on column public.intelligence_workflows.completed_units is
  'Terminal required tasks. Counted from persisted tasks — never derived from elapsed time.';
comment on column public.intelligence_workflows.duplicate_authorized_by is
  'The person who authorised a second live workflow over the same request. Null for ordinary starts, which are refused as duplicates.';

create index if not exists intelligence_workflows_by_organization
  on public.intelligence_workflows(organization_id, created_at desc);
create index if not exists intelligence_workflows_by_state
  on public.intelligence_workflows(state, updated_at desc);

-- One live answer to one question. The request fingerprint, not the source
-- fingerprint: two different scopes over the same sources are two requests and
-- neither blocks the other. A start a person explicitly authorised may repeat
-- a request; nothing else may.
create unique index if not exists intelligence_workflows_one_live_request
  on public.intelligence_workflows(organization_id, request_fingerprint)
  where state in ('created','queued','planning','running','needs_attention','ready_for_decision','deciding')
    and duplicate_authorized_by is null;
create index if not exists intelligence_workflows_by_source_set
  on public.intelligence_workflows(organization_id, source_set_fingerprint);

-- Durable command handoff. IDs only: no secrets, no source bytes.
create table if not exists public.workflow_outbox (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  workflow_id uuid not null unique references public.intelligence_workflows(id) on delete cascade,
  command text not null default 'start' check (command in ('start')),
  payload jsonb not null default '{}'::jsonb,
  state text not null default 'pending' check (state in ('pending','dispatching','acknowledged','failed')),
  dispatcher text,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  available_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.workflow_outbox is
  'One start command per workflow, committed in the same transaction as the workflow. A dispatcher claims it and acknowledges it; nothing here holds secrets or source bytes.';

create index if not exists workflow_outbox_ready
  on public.workflow_outbox(state, available_at) where state in ('pending','dispatching');

-- ═════════════════════════════════════════════════════════════ 3 · the sources
--
-- What a workflow read, identified by content rather than by name. A locator
-- and a size say where a thing is kept and how big it was, not which bytes it
-- holds; so a source carries a content digest or the storage system's own
-- immutable version id, and anchors under accepted decisions point here.
create table if not exists public.workflow_sources (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  workflow_id uuid not null references public.intelligence_workflows(id) on delete cascade,
  ordinal integer not null check (ordinal >= 0),
  source_kind text not null,
  label text,
  -- An opaque locator. The rule it must satisfy is named below the table.
  uri text not null,
  content_hash text,
  hash_algorithm text,
  object_version_id text,
  byte_size bigint check (byte_size >= 0),
  media jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (workflow_id, ordinal),
  constraint workflow_sources_identified check (content_hash is not null or object_version_id is not null)
);

comment on table public.workflow_sources is
  'The immutable sources a workflow read: kind, opaque locator, content identity, size and domain metadata. Append-only; a changed source is a new workflow.';
comment on column public.workflow_sources.media is
  'Domain metadata about the source — how many parts it has, how long it runs, how large it is. The kernel stores it and does not read it.';

-- A signed url expires and carries a credential; neither belongs in a
-- permanent record. The refusal reads the query string, which is where a
-- credential lives, so a locator whose path happens to contain the word
-- `signature` is still a locator and a records domain can name its own files.
alter table public.workflow_sources drop constraint if exists workflow_sources_uri_check;
alter table public.workflow_sources drop constraint if exists workflow_sources_uri_carries_no_credential;
alter table public.workflow_sources add constraint workflow_sources_uri_carries_no_credential
  check (uri !~* '[?&](x-amz-signature|x-goog-signature|sig|signature|token|access_token)=');

create unique index if not exists workflow_sources_identity
  on public.workflow_sources(workflow_id, uri, coalesce(content_hash, ''), coalesce(object_version_id, ''));

-- A bounded part of a source, found in discovery and kept so that every later
-- reader is handed the same piece. Segments may nest and may be refined; an
-- anchor pointing at an accepted one keeps its meaning.
create table if not exists public.source_segments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  workflow_id uuid not null references public.intelligence_workflows(id) on delete cascade,
  source_id uuid not null references public.workflow_sources(id) on delete restrict,
  parent_segment_id uuid references public.source_segments(id) on delete restrict,
  segment_kind text not null,
  label text,
  ordinal integer not null default 0 check (ordinal >= 0),
  -- Domain geometry: a normalised box, a time range, a row range, a byte
  -- range. The kernel checks the shapes it compares — a box, and any
  -- `start_x`/`end_x` pair — and stores the rest untouched.
  locator jsonb not null default '{}'::jsonb,
  content_hash text not null,
  status text not null default 'proposed' check (status in ('proposed','accepted','rejected','superseded')),
  discovered_by text not null check (discovered_by in ('deterministic','model','human')),
  discovered_by_attempt_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint source_segments_locator_shape check (public.core_v2_locator_well_formed(locator))
);

comment on table public.source_segments is
  'A bounded part of one source, discovered once and handed to every reader alike. What a segment is belongs to the domain pack; that it stays put belongs here.';

-- A segment is identified by what it holds AND where it is. Re-discovering the
-- same part reports the same locator and the same hash and collides, which is
-- the deduplication discovery relies on; the same words said twice in one
-- recording, or the same row printed twice in a register, are two places and
-- stay two rows.
drop index if exists source_segments_identity;
create unique index if not exists source_segments_identity
  on public.source_segments(workflow_id, source_id,
    coalesce(parent_segment_id, '00000000-0000-0000-0000-000000000000'::uuid), segment_kind,
    content_hash, md5(locator::text));
create index if not exists source_segments_by_source on public.source_segments(source_id, segment_kind, ordinal);
create index if not exists source_segments_by_workflow on public.source_segments(workflow_id, status);

-- ══════════════════════════════════════════════════════ 4 · the bounded work
--
-- One task reads one bounded thing under one role. No row here may ask an
-- executor for everything at once; that is the shape of request Core V2 exists
-- to replace.
create table if not exists public.workflow_tasks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  workflow_id uuid not null references public.intelligence_workflows(id) on delete cascade,
  parent_task_id uuid references public.workflow_tasks(id) on delete set null,
  created_by_task_id uuid references public.workflow_tasks(id) on delete set null,
  phase text not null check (phase in (
    'ingest','discover','analyze','compare','verify','adjudicate','derive','compose')),
  task_type text not null,
  role_key text not null,
  role_version text not null,
  subject_key text not null,
  priority integer not null default 100,
  input_fingerprint text not null,
  contract_version text not null,
  -- Two readers reading the same thing blind belong to different groups, so
  -- their tasks are two rows rather than one reused result.
  independence_group text,
  depth integer not null default 0 check (depth >= 0),
  critic_round integer not null default 0 check (critic_round >= 0),
  arbiter_round integer not null default 0 check (arbiter_round >= 0),
  disagreement_id uuid,
  state text not null default 'created' check (state in (
    'created','blocked','queued','leased','running','completed','failed_known',
    'outcome_unknown','cancelled','superseded')),
  -- A lease is a fencing token, not a name. A worker that lost its lease still
  -- knows its owner string; it no longer knows the token that replaced it.
  lease_owner text,
  lease_token uuid,
  lease_expires_at timestamptz,
  -- Zero is a real limit: a critic, an arbiter, a comparator and a composer
  -- assert nothing, and their assignments say so.
  max_claims integer not null default 200 check (max_claims >= 0),
  terminal_reason text,
  -- Who authorised running this work again after it ended without a known
  -- outcome. A machine can never fill these in.
  retry_authorized_by uuid references auth.users(id),
  retry_authorized_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.workflow_tasks is
  'One bounded unit of work with a reproducible input fingerprint. Its phase is the kernel''s; its task type and role are the domain pack''s.';
comment on column public.workflow_tasks.retry_authorized_by is
  'The person who authorised re-running a task whose outcome was unknown or a known failure. Never set by a worker.';

create unique index if not exists workflow_tasks_identity
  on public.workflow_tasks(workflow_id, phase, task_type, subject_key, input_fingerprint,
                           contract_version, coalesce(independence_group, ''));
create index if not exists workflow_tasks_runnable
  on public.workflow_tasks(workflow_id, state, priority, created_at);
create index if not exists workflow_tasks_leases
  on public.workflow_tasks(lease_expires_at) where state in ('leased','running');
create index if not exists workflow_tasks_by_parent
  on public.workflow_tasks(parent_task_id) where parent_task_id is not null;

-- What a task reads, in order: a whole source or one segment of it, never
-- both in one row.
create table if not exists public.task_sources (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  task_id uuid not null references public.workflow_tasks(id) on delete cascade,
  ordinal integer not null check (ordinal >= 0),
  source_id uuid references public.workflow_sources(id) on delete restrict,
  segment_id uuid references public.source_segments(id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (task_id, ordinal),
  constraint task_sources_exactly_one check ((source_id is not null) <> (segment_id is not null))
);

comment on table public.task_sources is
  'The sources and segments one task was handed, in order. Real foreign keys, so a task cannot be handed a piece of another workflow.';

create table if not exists public.task_dependencies (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  task_id uuid not null references public.workflow_tasks(id) on delete cascade,
  depends_on_task_id uuid not null references public.workflow_tasks(id) on delete cascade,
  dependency_kind text not null check (dependency_kind in (
    'requires_completion','requires_claims','requires_resolution')),
  created_at timestamptz not null default now(),
  primary key (task_id, depends_on_task_id),
  constraint task_dependencies_not_self check (task_id <> depends_on_task_id)
);

comment on table public.task_dependencies is
  'What a task waits for. Cycles are rejected by planner validation before anything is queued.';

create index if not exists task_dependencies_reverse on public.task_dependencies(depends_on_task_id);

-- The claims a verification task is about. A packet built from this table
-- cannot quietly widen to claims nobody asked it to verify.
create table if not exists public.task_target_claims (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  task_id uuid not null references public.workflow_tasks(id) on delete cascade,
  claim_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (task_id, claim_id)
);

-- One actual attempt by one executor — deterministic code, a model, or a
-- person. Whatever it returned is kept, including a partial answer that cost
-- money and a response that failed to validate.
create table if not exists public.agent_attempts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  workflow_id uuid not null references public.intelligence_workflows(id) on delete cascade,
  task_id uuid not null references public.workflow_tasks(id) on delete cascade,
  attempt_no integer not null check (attempt_no >= 1),
  role_key text not null,
  role_version text not null,
  executor_kind text not null check (executor_kind in ('deterministic','model','human')),
  -- The family is what the executor calls itself. The independence domain is
  -- what the registry knows it to be — assigned from the executor instance,
  -- never from a label an envelope could carry. Two readings are independent
  -- when their domains differ, and only then.
  executor_family text not null check (executor_family <> ''),
  independence_domain text not null check (independence_domain <> ''),
  model_configuration text not null default '',
  state text not null default 'prepared' check (state in (
    'prepared','submitted','response_received','parsed','succeeded',
    'rejected_before_submission','failed_known','output_limited',
    'cancelled_before_submission','outcome_unknown')),
  lease_token uuid,
  packet_fingerprint text not null,
  packet_bytes integer check (packet_bytes >= 0),
  provider_request_id text,
  model_reported text,
  usage jsonb not null default '{}'::jsonb,
  raw_result jsonb,
  raw_result_hash text,
  validation_state text not null default 'pending' check (validation_state in (
    'pending','valid','invalid','not_applicable')),
  validation_problems jsonb not null default '[]'::jsonb,
  -- What the executor later said became of an attempt whose outcome this
  -- engine never saw. It is the only fact that may join a terminal attempt,
  -- it may join only an unknown one, and it never becomes a retry: a person
  -- authorises that.
  reconciliation_outcome text check (reconciliation_outcome in ('never_started','completed','failed')),
  error_code text,
  error_message text,
  started_at timestamptz,
  submitted_at timestamptz,
  received_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (task_id, attempt_no),
  -- A stored result without its digest could be replaced with nobody the
  -- wiser; the digest is what makes write-once checkable from outside.
  constraint agent_attempts_result_hashed check (raw_result is null or raw_result_hash is not null),
  -- Only an unknown outcome is reconciled; a succeeded attempt has its answer.
  constraint agent_attempts_reconciled_when_unknown
    check (reconciliation_outcome is null or state = 'outcome_unknown')
);

comment on table public.agent_attempts is
  'One executor attempt. A raw or partial result is never deleted because validation failed, and an attempt that may have been billed keeps its usage.';
comment on column public.agent_attempts.state is
  'output_limited is a known outcome that keeps its partial result and usage; outcome_unknown means the executor may have run and is never retried automatically.';
comment on column public.agent_attempts.independence_domain is
  'The executor identity the registry assigned at registration. Two blind readings of one subject must carry two different values here.';
comment on column public.agent_attempts.reconciliation_outcome is
  'What the executor answered when asked what became of an unknown outcome. Recorded once, never a reason for the engine to retry.';

create index if not exists agent_attempts_by_task on public.agent_attempts(task_id, attempt_no);
create index if not exists agent_attempts_by_workflow on public.agent_attempts(workflow_id, state);
create index if not exists agent_attempts_open
  on public.agent_attempts(state, submitted_at) where state in ('submitted','response_received','outcome_unknown');

-- ═══════════════════════════════════════════════════════════ 5 · the evidence
--
-- One claim says one thing about one subject, in one scope, on one basis. Long
-- prose is not a claim.
create table if not exists public.evidence_claims (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  workflow_id uuid not null references public.intelligence_workflows(id) on delete cascade,
  task_id uuid references public.workflow_tasks(id) on delete set null,
  attempt_id uuid references public.agent_attempts(id) on delete set null,
  independence_group text,
  independence_domain text,
  subject_type text not null,
  subject_key text not null,
  predicate text not null,
  value jsonb not null default '{}'::jsonb,
  unit text,
  -- What kind of observation this is. Read directly off the source, computed
  -- from other claims, inferred, or reported by a person. These are four
  -- different facts about the same subject and are never merged without a
  -- decision.
  observation_basis text not null check (observation_basis in ('observed','derived','inferred','reported')),
  scope jsonb not null default '{}'::jsonb,
  status text not null default 'proposed' check (status in (
    'proposed','corroborated','disputed','verified','accepted','rejected','unresolved','superseded')),
  machine_confidence numeric check (machine_confidence is null or (machine_confidence >= 0 and machine_confidence <= 1)),
  supersedes_claim_id uuid references public.evidence_claims(id) on delete set null,
  -- A claim parsed out of an attempt that ran out of output. It may be shown
  -- and it may be useful; it can never be accepted on its own.
  incomplete_source_attempt boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.evidence_claims is
  'One atomic assertion: subject, predicate, value, unit, basis and scope. Explanatory prose may accompany a claim; it can never replace this structure.';
comment on column public.evidence_claims.status is
  'corroborated means two independent readings agree, and nothing more. accepted is reached only through independent verification, a deterministic rule, or a person.';

create index if not exists evidence_claims_by_workflow on public.evidence_claims(workflow_id, status);
create index if not exists evidence_claims_by_subject
  on public.evidence_claims(workflow_id, subject_type, subject_key, predicate);
create index if not exists evidence_claims_by_attempt on public.evidence_claims(attempt_id) where attempt_id is not null;

-- The claims a derived claim was computed from, as real foreign keys. A
-- derivation whose inputs cannot be found is arithmetic nobody can check.
create table if not exists public.claim_inputs (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  claim_id uuid not null references public.evidence_claims(id) on delete cascade,
  input_claim_id uuid not null references public.evidence_claims(id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (claim_id, input_claim_id),
  constraint claim_inputs_not_self check (claim_id <> input_claim_id)
);

create index if not exists claim_inputs_by_input on public.claim_inputs(input_claim_id);

-- Where a claim, or an assessment of one, was read. One consistent tuple:
-- source, segment, locator. An anchor that points nowhere is not an anchor,
-- which is why the check below insists on the reference its own kind requires.
create table if not exists public.evidence_anchors (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  workflow_id uuid not null references public.intelligence_workflows(id) on delete cascade,
  claim_id uuid references public.evidence_claims(id) on delete restrict,
  assessment_id uuid,
  source_kind text not null check (source_kind in ('segment_locator','segment','source','human_record')),
  -- `restrict`, not `cascade`: the source under an accepted decision does not
  -- quietly disappear because a row upstream was deleted. That refusal is the
  -- point.
  source_id uuid references public.workflow_sources(id) on delete restrict,
  segment_id uuid references public.source_segments(id) on delete restrict,
  locator jsonb not null default '{}'::jsonb,
  quoted_text text,
  anchor_hash text not null,
  created_at timestamptz not null default now(),
  constraint evidence_anchors_owned_by_one check ((claim_id is not null) <> (assessment_id is not null)),
  constraint evidence_anchors_locator_shape check (public.core_v2_locator_well_formed(locator)),
  constraint evidence_anchors_points_somewhere check (
    case source_kind
      when 'segment_locator' then segment_id is not null and locator <> '{}'::jsonb
      when 'segment'         then segment_id is not null
      when 'source'          then source_id is not null
      when 'human_record'    then quoted_text is not null or locator <> '{}'::jsonb
      else false
    end)
);

comment on table public.evidence_anchors is
  'The place an accepted claim can be opened at: a source, a segment of it, a locator inside that segment, or a person''s own record. Every anchor belongs to exactly one claim or one assessment.';

create index if not exists evidence_anchors_by_claim on public.evidence_anchors(claim_id) where claim_id is not null;
create index if not exists evidence_anchors_by_assessment on public.evidence_anchors(assessment_id) where assessment_id is not null;
create index if not exists evidence_anchors_by_segment on public.evidence_anchors(segment_id) where segment_id is not null;
create index if not exists evidence_anchors_by_source on public.evidence_anchors(source_id) where source_id is not null;

-- What a critic or verifier found, about which claim, in which attempt. One
-- verdict per claim per attempt: a reviewer does not get to say two things.
create table if not exists public.claim_assessments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  workflow_id uuid not null references public.intelligence_workflows(id) on delete cascade,
  claim_id uuid not null references public.evidence_claims(id) on delete cascade,
  attempt_id uuid not null references public.agent_attempts(id) on delete cascade,
  task_id uuid references public.workflow_tasks(id) on delete set null,
  assessment text not null check (assessment in (
    'supports','contradicts','insufficient','wrong_scope','wrong_unit','duplicate','unreadable')),
  reason_code text not null,
  explanation text,
  -- What this reviewer read off the source instead, when it read otherwise.
  -- An arbiter may correct a disputed claim only to a value that stands here:
  -- without these columns a correction would be the arbiter's own invention.
  proposed_value jsonb,
  proposed_unit text,
  created_at timestamptz not null default now(),
  unique (attempt_id, claim_id),
  -- A verdict that the source agrees proposes nothing; there is nothing to
  -- correct to.
  constraint claim_assessments_proposal_disagrees
    check (proposed_value is null or assessment <> 'supports')
);

comment on table public.claim_assessments is
  'One reviewer''s verdict on one claim. Its anchors live in evidence_anchors under assessment_id; a review that names no evidence is an opinion.';

create index if not exists claim_assessments_by_claim on public.claim_assessments(claim_id, assessment);

-- ═══════════════════════════════════════════════════ 6 · review and dispute
--
-- Two readers disagreed, or one reader disagreed with the source. Both claims
-- are kept, and the losing one is kept too.
create table if not exists public.disagreements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  workflow_id uuid not null references public.intelligence_workflows(id) on delete cascade,
  disagreement_key text not null,
  kind text not null check (kind in (
    'missing','value','unit','scope','basis','identity','duplicate','coverage')),
  subject_signature jsonb not null default '{}'::jsonb,
  severity text not null default 'material' check (severity in ('critical','material','informational')),
  state text not null default 'open' check (state in ('open','verifying','resolved','needs_human','superseded')),
  resolution_decision_id uuid,
  -- How many times a critic and an arbiter have been asked. Counted here so
  -- the budget is checked against the record, not against a worker's memory.
  critic_rounds integer not null default 0 check (critic_rounds >= 0),
  arbiter_rounds integer not null default 0 check (arbiter_rounds >= 0),
  needs_human_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workflow_id, disagreement_key)
);

comment on table public.disagreements is
  'A conflict between claims, kept as data. Resolution records which claim won and why; the claims that lost are never deleted.';

create index if not exists disagreements_open
  on public.disagreements(workflow_id, state, severity) where state <> 'resolved';

-- The claims that disagree. Each one must belong to the same organisation AND
-- the same workflow as the disagreement, which a uuid[] column could never
-- promise. An absent counterpart — one reader saw something the other did not
-- — is a row with role `missing_counterpart`, not a borrowed or invented id.
create table if not exists public.disagreement_claims (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  disagreement_id uuid not null references public.disagreements(id) on delete cascade,
  claim_id uuid not null references public.evidence_claims(id) on delete restrict,
  position integer not null default 0,
  role text not null default 'candidate'
    check (role in ('candidate','missing_counterpart','context')),
  created_at timestamptz not null default now(),
  primary key (disagreement_id, claim_id)
);

comment on table public.disagreement_claims is
  'The competing claims of one disagreement, as real foreign keys with a stable position. Every claim belongs to the disagreement''s organisation and workflow.';

-- `restrict`, like every other link in the chain: removing a disagreement must
-- not take the claim set it was settled between with it, past a guard that
-- never sees a parent already gone.
alter table public.disagreement_claims drop constraint if exists disagreement_claims_disagreement_id_fkey;
alter table public.disagreement_claims add constraint disagreement_claims_disagreement_id_fkey
  foreign key (disagreement_id) references public.disagreements(id) on delete restrict;

create index if not exists disagreement_claims_by_claim on public.disagreement_claims(claim_id);
create index if not exists disagreement_claims_ordered on public.disagreement_claims(disagreement_id, position);

-- The one follow-up admitted per round. A second verification of the same
-- disagreement in the same round is the loop the round limit exists to stop,
-- so the table refuses it rather than trusting a planner to remember.
create table if not exists public.disagreement_follow_ups (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  disagreement_id uuid not null references public.disagreements(id) on delete cascade,
  round integer not null check (round >= 1),
  fingerprint text not null,
  task_id uuid references public.workflow_tasks(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (disagreement_id, fingerprint),
  unique (disagreement_id, round)
);

comment on table public.disagreement_follow_ups is
  'Exactly one follow-up task per disagreement per round. Append-only: a round that happened is not unhappened.';

-- ═══════════════════════════════════════════════════════════ 7 · the decision
--
-- The record a person actually reads. Everything above exists so that this row
-- can be opened and traced back to a source.
create table if not exists public.decisions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  workflow_id uuid not null references public.intelligence_workflows(id) on delete cascade,
  task_id uuid references public.workflow_tasks(id) on delete set null,
  disagreement_id uuid references public.disagreements(id) on delete set null,
  decision_type text not null check (decision_type in (
    'accept_claim','reject_claim','reject_all','hold','proceed','request_information','supersede')),
  subject_key text not null default '',
  title text not null,
  summary jsonb not null default '{}'::jsonb,
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
  -- attempt or a person — and the word matches the who.
  constraint decisions_decided_by_exactly_one check (
    status not in ('machine_decided','human_decided')
    or ((decided_by_attempt_id is not null) <> (decided_by_user_id is not null))),
  constraint decisions_machine_decided_by_attempt check (
    status <> 'machine_decided' or decided_by_attempt_id is not null),
  constraint decisions_human_decided_by_person check (
    status <> 'human_decided' or decided_by_user_id is not null),
  -- A supersession borrows the evidence of the decision it replaces, so it has
  -- to say which one that is. Without a predecessor it is a decided decision
  -- resting on nothing.
  constraint decisions_supersede_names_predecessor check (
    decision_type <> 'supersede'
    or status not in ('machine_decided','human_decided')
    or supersedes_decision_id is not null)
);

comment on table public.decisions is
  'The user-facing record. A decided decision cannot exist without accepted evidence behind it, and is never edited afterwards — only superseded.';
comment on column public.decisions.summary is
  'What was decided, in the domain pack''s own terms. proceed carries its subtype here; the kernel does not enumerate it.';

create index if not exists decisions_by_workflow on public.decisions(workflow_id, status, created_at desc);
create index if not exists decisions_by_subject on public.decisions(workflow_id, subject_key);

-- Which claims and anchors a decision rests on, and how. `supports` is what
-- the decision was made on; `contradicts` is what it was made against and is
-- kept in full.
create table if not exists public.decision_evidence (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  decision_id uuid not null references public.decisions(id) on delete cascade,
  claim_id uuid references public.evidence_claims(id) on delete restrict,
  anchor_id uuid references public.evidence_anchors(id) on delete restrict,
  link text not null check (link in ('supports','contradicts','context')),
  rule text,
  created_at timestamptz not null default now(),
  constraint decision_evidence_points_somewhere check (claim_id is not null or anchor_id is not null)
);

create index if not exists decision_evidence_by_decision on public.decision_evidence(decision_id, link);
create index if not exists decision_evidence_by_claim on public.decision_evidence(claim_id) where claim_id is not null;
create index if not exists decision_evidence_by_anchor on public.decision_evidence(anchor_id) where anchor_id is not null;

create table if not exists public.decision_actions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  decision_id uuid not null references public.decisions(id) on delete cascade,
  -- What must be done next. The kernel's own five, or a value the domain pack
  -- namespaces with its own prefix — `owner_role` beside it is free text for
  -- the same reason.
  action_type text not null,
  owner_role text not null,
  status text not null default 'open' check (status in ('open','assigned','completed','waived','superseded')),
  due_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.decision_actions drop constraint if exists decision_actions_action_type_check;
alter table public.decision_actions drop constraint if exists decision_actions_action_type_named;
alter table public.decision_actions add constraint decision_actions_action_type_named
  check (action_type in ('review','verify_source','request_information','proceed','hold')
         or action_type like '%:%');

create index if not exists decision_actions_open on public.decision_actions(decision_id, status, due_at);

-- ═════════════════════════════════════ 8 · the references that point forward
--
-- Declared here because the table on the far end did not exist yet when the
-- column was written. Each one is `restrict` or `set null` on purpose: nothing
-- in the chain disappears because something later in it went.
alter table public.source_segments drop constraint if exists source_segments_discovered_by_attempt_fk;
alter table public.source_segments add constraint source_segments_discovered_by_attempt_fk
  foreign key (discovered_by_attempt_id) references public.agent_attempts(id) on delete set null;

alter table public.workflow_tasks drop constraint if exists workflow_tasks_disagreement_fk;
alter table public.workflow_tasks add constraint workflow_tasks_disagreement_fk
  foreign key (disagreement_id) references public.disagreements(id) on delete set null;

alter table public.task_target_claims drop constraint if exists task_target_claims_claim_fk;
alter table public.task_target_claims add constraint task_target_claims_claim_fk
  foreign key (claim_id) references public.evidence_claims(id) on delete restrict;

alter table public.evidence_anchors drop constraint if exists evidence_anchors_assessment_fk;
alter table public.evidence_anchors add constraint evidence_anchors_assessment_fk
  foreign key (assessment_id) references public.claim_assessments(id) on delete restrict;

alter table public.disagreements drop constraint if exists disagreements_resolution_decision_fk;
alter table public.disagreements add constraint disagreements_resolution_decision_fk
  foreign key (resolution_decision_id) references public.decisions(id) on delete set null;
alter table public.disagreements drop constraint if exists disagreements_resolved_has_decision;
alter table public.disagreements add constraint disagreements_resolved_has_decision
  check (state <> 'resolved' or resolution_decision_id is not null);

create index if not exists task_target_claims_by_claim on public.task_target_claims(claim_id);
create index if not exists source_segments_by_attempt
  on public.source_segments(discovered_by_attempt_id) where discovered_by_attempt_id is not null;

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

  -- What was asked, of which sources, by whom, under which pack and engine,
  -- within which budget — write-once. Progress, lifecycle timestamps and the
  -- orchestrator's handle may move.
  moved := public.core_v2_frozen_except(to_jsonb(old), to_jsonb(new), array[
    'state','orchestrator_run_id','cancel_requested_at','completed_units','total_units',
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
    'state','dispatcher','attempt_count','available_at','last_error','updated_at']);
  if moved is not null then
    raise exception 'core_v2: outbox row % cannot change % — a command is not rewritten in flight', old.id, moved
      using errcode = 'check_violation';
  end if;
  new.updated_at := now();
  return new;
end $$;

-- A source is append-only. A corrected hash, a corrected label, a re-upload:
-- each is a new workflow over a new source set, because anchors under
-- accepted decisions point here.
create or replace function public.core_v2_guard_source() returns trigger
language plpgsql as $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'core_v2: source % is part of the record — a changed source set is a new workflow, not a removal', old.id
      using errcode = 'check_violation';
  end if;
  raise exception 'core_v2: source % is append-only — a different source is a different workflow', old.id
    using errcode = 'check_violation';
end $$;

-- A proposed segment may still be refined. An accepted one is what anchors
-- point at, so refinement from here on is a child or a superseding segment.
-- A child belongs to its parent's source: a segment of one source nested
-- under a segment of another would let an anchor cross sources by inheritance.
create or replace function public.core_v2_guard_segment() returns trigger
language plpgsql as $$
declare
  moved text;
  parent public.source_segments;
begin
  if TG_OP = 'DELETE' then
    if old.status <> 'proposed' then
      raise exception 'core_v2: segment % is % — it stays in the record', old.id, old.status
        using errcode = 'check_violation';
    end if;
    return old;
  end if;
  if new.parent_segment_id is not null then
    select * into parent from public.source_segments where id = new.parent_segment_id;
    if not found then
      raise exception 'core_v2: segment % names a parent that does not exist', new.id
        using errcode = 'check_violation';
    end if;
    if parent.source_id <> new.source_id or parent.workflow_id <> new.workflow_id then
      raise exception 'core_v2: segment % is nested under a segment of another source', new.id
        using errcode = 'check_violation';
    end if;
    -- And inside it. A child that sits somewhere else would let an anchor
    -- "inside its segment" point far outside the region a reader was handed,
    -- because an anchor is only ever compared with the segment it names.
    if (parent.locator ? 'bbox' and new.locator ? 'bbox'
        and not public.core_v2_bbox_within(new.locator -> 'bbox', parent.locator -> 'bbox'))
       or not public.core_v2_range_within(new.locator, parent.locator) then
      raise exception 'core_v2: segment % lies outside its parent %', new.id, parent.id
        using errcode = 'check_violation';
    end if;
  end if;
  if TG_OP = 'INSERT' then return new; end if;
  if new.status is distinct from old.status
     and not public.core_v2_transition_allowed('segment', old.status, new.status) then
    raise exception 'core_v2: a segment cannot go from % to %', old.status, new.status
      using errcode = 'check_violation';
  end if;
  if old.status <> 'proposed' then
    moved := public.core_v2_frozen_except(to_jsonb(old), to_jsonb(new), array['status','updated_at']);
    if moved is not null then
      raise exception 'core_v2: segment % is % — % cannot be rewritten under an anchor', old.id, old.status, moved
        using errcode = 'check_violation';
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;

-- The shape a lease must have, checked wherever a task row is written: a
-- leased task carries a token and an expiry, and a task in any other state
-- carries no lease at all. A stale token left on a completed task is a token
-- somebody could still submit under.
create or replace function public.core_v2_shape_task_lease(t inout public.workflow_tasks)
returns public.workflow_tasks language plpgsql immutable as $$
begin
  if t.state not in ('leased','running') then
    t.lease_owner := null;
    t.lease_token := null;
    t.lease_expires_at := null;
  elsif t.state = 'leased' and (t.lease_token is null or t.lease_expires_at is null) then
    raise exception 'core_v2: task % is leased without a token and an expiry', t.id
      using errcode = 'check_violation';
  end if;
end $$;

-- An attempt that is out with an executor, or that ended with the executor
-- possibly having run, is a request that may still be billed. A person who
-- authorises running the task again has reconciled every such attempt up to
-- that moment; the attempts that still count are the ones submitted since.
create or replace function public.core_v2_task_has_open_attempt(p_task public.workflow_tasks)
returns boolean language sql stable as $$
  select exists (
    select 1 from public.agent_attempts a
     where a.task_id = p_task.id
       and public.core_v2_attempt_submitted(a.state)
       and (p_task.retry_authorized_at is null
            or a.submitted_at is null
            or a.submitted_at > p_task.retry_authorized_at));
$$;

comment on function public.core_v2_task_has_open_attempt(public.workflow_tasks) is
  'Whether any attempt of the task was submitted and not yet reconciled by a person authorising a retry. While true the task is neither leased, requeued nor cancelled.';

create or replace function public.core_v2_guard_task() returns trigger
language plpgsql as $$
begin
  if new.state is distinct from old.state then
    -- A task that ended without a known outcome, or with a known failure, does
    -- not go back into the queue on its own. A person authorises it, and
    -- core_v2_authorize_task_retry is the only thing that can say so.
    if old.state in ('outcome_unknown','failed_known') and new.state = 'queued' then
      -- The marker says which door was used; the row says who walked through
      -- it. A worker runs as the service role, for which auth.uid() is null, so
      -- it cannot produce the second half however it sets the first.
      if coalesce(current_setting('core_v2.authorized_retry', true), '') <> old.id::text
         or new.retry_authorized_by is null
         or new.retry_authorized_by is distinct from auth.uid()
         or new.retry_authorized_at is not distinct from old.retry_authorized_at then
        raise exception 'core_v2: task % ended as % — a person must authorise running it again', old.id, old.state
          using errcode = 'check_violation';
      end if;
    elsif not public.core_v2_transition_allowed('task', old.state, new.state) then
      raise exception 'core_v2: a task cannot go from % to %', old.state, new.state
        using errcode = 'check_violation';
    end if;

    -- A lease that expires before anything was sent may return the task to the
    -- queue. A lease that expires after a request went out may not: the
    -- executor may have run, and requeueing would buy it again. Cancelling is
    -- the same problem wearing a friendlier word — unsent work stops, sent work
    -- is reconciled.
    if (old.state = 'leased' and new.state = 'queued') or new.state = 'cancelled' then
      if public.core_v2_task_has_open_attempt(old) then
        raise exception 'core_v2: task % has an attempt that was already submitted — it is reconciled, not %',
          old.id, case when new.state = 'cancelled' then 'cancelled' else 'requeued' end
          using errcode = 'check_violation';
      end if;
    end if;
  end if;
  new := public.core_v2_shape_task_lease(new);
  new.updated_at := now();
  return new;
end $$;

-- The budget a workflow was admitted under, applied where a task is born.
-- Counting persisted rows rather than a planner's own tally means a planner
-- that restarts, or two planners at once, cannot exceed it between them.
create or replace function public.core_v2_guard_task_insert() returns trigger
language plpgsql as $$
declare
  budget jsonb;
  existing integer;
  siblings integer;
begin
  -- One admission into one workflow at a time. Without this the count below is
  -- a reading of the past: two planners each see room for one more task and
  -- both take it. An advisory transaction lock rather than a row lock, because
  -- core_v2_submit_attempt already holds the workflow row and locking it the
  -- other way round here would put admission and submission in each other's way.
  perform pg_advisory_xact_lock(hashtextextended(new.workflow_id::text, 0));
  select w.budget into budget from public.intelligence_workflows w where w.id = new.workflow_id;
  if budget is null then
    raise exception 'core_v2: task % names a workflow that does not exist', new.id
      using errcode = 'check_violation';
  end if;

  select count(*) into existing from public.workflow_tasks t where t.workflow_id = new.workflow_id;
  if existing >= coalesce((budget ->> 'maximum_tasks')::int, 2147483647) then
    raise exception 'core_v2: workflow % already holds % tasks — its budget allows no more',
      new.workflow_id, existing using errcode = 'check_violation';
  end if;
  if new.depth > coalesce((budget ->> 'maximum_follow_up_depth')::int, 2147483647) then
    raise exception 'core_v2: task % is % deep — the workflow allows follow-ups to depth %',
      new.id, new.depth, budget ->> 'maximum_follow_up_depth' using errcode = 'check_violation';
  end if;
  if new.parent_task_id is not null then
    select count(*) into siblings from public.workflow_tasks t where t.parent_task_id = new.parent_task_id;
    if siblings >= coalesce((budget ->> 'maximum_child_tasks_per_parent')::int, 2147483647) then
      raise exception 'core_v2: task % already has % children — the workflow allows no more',
        new.parent_task_id, siblings using errcode = 'check_violation';
    end if;
  end if;
  new := public.core_v2_shape_task_lease(new);
  return new;
end $$;

create or replace function public.core_v2_guard_edge_insert() returns trigger
language plpgsql as $$
declare
  workflow uuid;
  budget jsonb;
  existing integer;
begin
  select t.workflow_id into workflow from public.workflow_tasks t where t.id = new.task_id;
  perform pg_advisory_xact_lock(hashtextextended(workflow::text, 0));
  select w.budget into budget from public.intelligence_workflows w where w.id = workflow;
  select count(*) into existing
    from public.task_dependencies d join public.workflow_tasks t on t.id = d.task_id
   where t.workflow_id = workflow;
  if existing >= coalesce((budget ->> 'maximum_dependency_edges')::int, 2147483647) then
    raise exception 'core_v2: workflow % already holds % dependency edges — its budget allows no more',
      workflow, existing using errcode = 'check_violation';
  end if;
  return new;
end $$;

-- What an executor was asked, what it answered, what it cost and when: each
-- fact is write-once from the moment it is recorded, and a terminal attempt
-- does not move at all. This is the row a cost dispute is settled from.
create or replace function public.core_v2_guard_attempt() returns trigger
language plpgsql as $$
declare
  moved text;
  written text;
begin
  -- The one move that spends money. core_v2_submit_attempt proves the workflow
  -- is active and uncancelled, the task running under an unexpired lease, and
  -- the independence of a blind reading — under the task's row lock. A plain
  -- UPDATE proves none of that, so it is not a way to send a request.
  if old.state = 'prepared' and new.state = 'submitted'
     and coalesce(current_setting('core_v2.submitting_attempt', true), '') <> old.id::text then
    raise exception 'core_v2: attempt % is submitted through core_v2_submit_attempt, which proves the lease and the cancellation', old.id
      using errcode = 'check_violation';
  end if;

  if new.state is distinct from old.state
     and not public.core_v2_transition_allowed('attempt', old.state, new.state) then
    raise exception 'core_v2: an attempt cannot go from % to %', old.state, new.state
      using errcode = 'check_violation';
  end if;

  if old.state in ('succeeded','failed_known','output_limited','outcome_unknown',
                   'rejected_before_submission','cancelled_before_submission') then
    -- A terminal attempt does not move. The single exception is the answer to
    -- "what became of this?", which can only arrive after the attempt ended
    -- and only for one that ended unknown; the write-once rule below then
    -- keeps that answer from being rewritten.
    moved := public.core_v2_frozen_except(to_jsonb(old), to_jsonb(new),
      case when old.state = 'outcome_unknown'
           then array['updated_at','reconciliation_outcome']
           else array['updated_at'] end);
    if moved is not null then
      raise exception 'core_v2: attempt % ended as % — % is not rewritten afterwards', old.id, old.state, moved
        using errcode = 'check_violation';
    end if;
  end if;

  -- Write-once, one field at a time: null may become a value; a value never
  -- becomes something else, and never becomes nothing.
  select f into written from unnest(array[
    'provider_request_id','model_reported','raw_result','raw_result_hash','lease_token',
    'reconciliation_outcome',
    'error_code','error_message','started_at','submitted_at','received_at','finished_at']) as t(f)
   where (to_jsonb(old) -> t.f) is not null
     and (to_jsonb(old) -> t.f) <> 'null'::jsonb
     and (to_jsonb(new) -> t.f) is distinct from (to_jsonb(old) -> t.f)
   limit 1;
  if written is not null then
    raise exception 'core_v2: attempt % already recorded % — an executor fact is written once', old.id, written
      using errcode = 'check_violation';
  end if;
  if old.usage <> '{}'::jsonb and new.usage is distinct from old.usage then
    raise exception 'core_v2: the recorded usage of attempt % cannot be replaced', old.id
      using errcode = 'check_violation';
  end if;
  new.updated_at := now();
  return new;
end $$;

create or replace function public.core_v2_guard_attempt_delete() returns trigger
language plpgsql as $$
begin
  if old.raw_result is not null or public.core_v2_attempt_submitted(old.state) then
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
  -- Where the reading came from is a fact about the past. Clearing the flag on
  -- a claim still in motion would launder it into acceptance.
  if old.incomplete_source_attempt and not new.incomplete_source_attempt then
    raise exception 'core_v2: claim % came from a cut-short attempt — that does not stop being true', old.id
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
     or exists (select 1 from public.decision_evidence e where e.claim_id = old.id)
     or exists (select 1 from public.task_target_claims t where t.claim_id = old.id)
     or exists (select 1 from public.claim_inputs i where i.input_claim_id = old.id) then
    raise exception 'core_v2: claim % is part of the record — a claim that lost is kept, not deleted', old.id
      using errcode = 'check_violation';
  end if;
  return old;
end $$;

-- An anchor is one consistent tuple. When it names a segment, its source is
-- that segment's source, and a locator inside it lies inside the segment's own
-- locator. The persisted segment is the authority, not the envelope that
-- claimed to have read it.
create or replace function public.core_v2_shape_anchor() returns trigger
language plpgsql as $$
declare seg public.source_segments;
begin
  if new.segment_id is null then return new; end if;
  select * into seg from public.source_segments where id = new.segment_id;
  if not found then
    raise exception 'core_v2: anchor % names a segment that does not exist', new.id
      using errcode = 'check_violation';
  end if;
  if seg.workflow_id <> new.workflow_id then
    raise exception 'core_v2: anchor % points at a segment of another workflow', new.id
      using errcode = 'check_violation';
  end if;
  if new.source_id is null then
    new.source_id := seg.source_id;
  elsif new.source_id <> seg.source_id then
    raise exception 'core_v2: anchor % names segment % of one source and the id of another', new.id, seg.id
      using errcode = 'check_violation';
  end if;
  if seg.locator ? 'bbox' and new.locator ? 'bbox'
     and not public.core_v2_bbox_within(new.locator -> 'bbox', seg.locator -> 'bbox') then
    raise exception 'core_v2: anchor % locates a box outside segment %', new.id, seg.id
      using errcode = 'check_violation';
  end if;
  -- Every range the segment names, not only a time range: a register's rows and
  -- a stream's bytes are places in a source too, and an anchor that leaves them
  -- leaves the region a reader was actually handed.
  if not public.core_v2_range_within(new.locator, seg.locator) then
    raise exception 'core_v2: anchor % locates a range outside segment %', new.id, seg.id
      using errcode = 'check_violation';
  end if;
  -- An anchor that names a place inside a segment has to name it in terms the
  -- segment uses, or nothing above could have checked it. The engine refuses
  -- such an anchor on the way in; the database refuses to hold one.
  if new.source_kind = 'segment_locator'
     and not (seg.locator ? 'bbox' and new.locator ? 'bbox')
     and not exists (select 1 from jsonb_object_keys(seg.locator) as k(key)
                      where key like 'start!_%' escape '!' and new.locator ? key) then
    raise exception 'core_v2: anchor % names a place in segment % with no box or range to compare', new.id, seg.id
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

-- An anchor under an authoritative claim, or cited by a decided decision, is
-- the bottom of the traceable chain. It does not move and it does not go.
create or replace function public.core_v2_guard_anchor() returns trigger
language plpgsql as $$
declare
  owning_claim uuid;
  claim_status text;
  moved text;
begin
  owning_claim := coalesce(old.claim_id,
    (select a.claim_id from public.claim_assessments a where a.id = old.assessment_id));
  -- `for share`, so that a transaction accepting this claim and a transaction
  -- pulling its anchor out cannot both look, both see nothing wrong, and both
  -- commit. The lock makes them queue; the loser then reads what the winner did.
  select c.status into claim_status from public.evidence_claims c where c.id = owning_claim for share;
  if claim_status in ('verified','accepted','rejected','superseded') then
    -- One wording for every status: "a accepted claim" is what comes of
    -- inflecting a word the schema does not choose.
    raise exception 'core_v2: anchor % supports a claim that is % — it is not %', old.id, claim_status,
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
  -- `for share`, so a transaction deciding the decision and a transaction
  -- adding evidence to it cannot pass each other in the dark.
  select d.status into decision_status from public.decisions d
   where d.id = row_link.decision_id for share;
  if decision_status in ('machine_decided','human_decided') then
    raise exception 'core_v2: decision % is decided — its evidence set is closed; more evidence makes a superseding decision',
      row_link.decision_id using errcode = 'check_violation';
  end if;
  if TG_OP = 'UPDATE' and old.decision_id is distinct from new.decision_id then
    select d.status into decision_status from public.decisions d
     where d.id = old.decision_id for share;
    if decision_status in ('machine_decided','human_decided') then
      raise exception 'core_v2: evidence cannot be moved off decided decision %', old.decision_id
        using errcode = 'check_violation';
    end if;
  end if;
  if TG_OP = 'DELETE' then return old; end if;
  -- Whenever an anchor is named, not only when one row names both. Splitting
  -- the claim and the anchor across two rows is the same citation written
  -- twice, and it has to be the same refusal.
  if new.anchor_id is not null then
    select a.claim_id into anchor_claim from public.evidence_anchors a where a.id = new.anchor_id;
    if new.claim_id is not null and anchor_claim is distinct from new.claim_id then
      raise exception 'core_v2: that anchor belongs to another claim — a decision cites a claim through its own source'
        using errcode = 'check_violation';
    end if;
    if new.claim_id is null and new.link = 'supports' and anchor_claim is not null
       and not exists (select 1 from public.decision_evidence e
                        where e.decision_id = new.decision_id and e.claim_id = anchor_claim
                          and e.link = 'supports') then
      raise exception 'core_v2: that anchor belongs to another claim — a decision cites a claim through its own source'
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;

-- A critic round and an arbiter round are paid for. The counters exist so the
-- budget is checked against the record rather than against a worker's memory,
-- which only works if something actually checks them.
create or replace function public.core_v2_assert_rounds_within_budget(dis public.disagreements)
returns void language plpgsql stable as $$
declare budget jsonb;
begin
  select w.budget into budget from public.intelligence_workflows w where w.id = dis.workflow_id;
  if dis.critic_rounds > coalesce((budget ->> 'maximum_critic_rounds')::int, 2147483647)
     or dis.arbiter_rounds > coalesce((budget ->> 'maximum_arbiter_rounds')::int, 2147483647) then
    raise exception 'core_v2: disagreement % has spent its rounds — the workflow allows % critic and % arbiter',
      dis.id, coalesce(budget ->> 'maximum_critic_rounds', 'any'),
      coalesce(budget ->> 'maximum_arbiter_rounds', 'any')
      using errcode = 'check_violation';
  end if;
end $$;

create or replace function public.core_v2_guard_disagreement_insert() returns trigger
language plpgsql as $$
begin
  perform public.core_v2_assert_rounds_within_budget(new);
  return new;
end $$;

-- A resolved disagreement is the record of what was settled and between which
-- readings. It is superseded, not removed.
create or replace function public.core_v2_guard_disagreement_delete() returns trigger
language plpgsql as $$
begin
  if old.state in ('resolved','superseded') then
    raise exception 'core_v2: disagreement % is % — it stays in the record', old.id, old.state
      using errcode = 'check_violation';
  end if;
  return old;
end $$;

create or replace function public.core_v2_guard_disagreement() returns trigger
language plpgsql as $$
declare moved text;
begin
  if new.state is distinct from old.state
     and not public.core_v2_transition_allowed('disagreement', old.state, new.state) then
    raise exception 'core_v2: a disagreement cannot go from % to %', old.state, new.state
      using errcode = 'check_violation';
  end if;
  -- A round that was spent stays spent. Winding the counter back is how a
  -- budget gets exceeded without anyone exceeding it.
  if new.critic_rounds < old.critic_rounds or new.arbiter_rounds < old.arbiter_rounds then
    raise exception 'core_v2: the rounds of disagreement % do not decrease', old.id
      using errcode = 'check_violation';
  end if;
  perform public.core_v2_assert_rounds_within_budget(new);
  if old.state in ('resolved','superseded') then
    moved := public.core_v2_frozen_except(to_jsonb(old), to_jsonb(new), array['state','updated_at']);
    if moved is not null then
      raise exception 'core_v2: disagreement % is % — % is part of the record', old.id, old.state, moved
        using errcode = 'check_violation';
    end if;
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
  -- `for share`: settling the disagreement and adding a claim to it are two
  -- writers of two different rows, and only a lock makes them one story.
  select * into dis from public.disagreements where id = row_link.disagreement_id for share;
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

create or replace function public.core_v2_guard_follow_up() returns trigger
language plpgsql as $$
begin
  raise exception 'core_v2: a follow-up of disagreement % is append-only — a round that happened stays', old.disagreement_id
    using errcode = 'check_violation';
end $$;

-- And a round that has not been paid for does not happen at all.
create or replace function public.core_v2_guard_follow_up_insert() returns trigger
language plpgsql as $$
declare budget jsonb;
begin
  select w.budget into budget
    from public.disagreements d join public.intelligence_workflows w on w.id = d.workflow_id
   where d.id = new.disagreement_id;
  if new.round > coalesce((budget ->> 'maximum_critic_rounds')::int, 2147483647) then
    raise exception 'core_v2: disagreement % has spent its rounds — the workflow allows % critic and % arbiter',
      new.disagreement_id, coalesce(budget ->> 'maximum_critic_rounds', 'any'),
      coalesce(budget ->> 'maximum_arbiter_rounds', 'any')
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

-- The answer a person read. Editing it is refused above; removing it would be
-- the same erasure with a shorter statement.
create or replace function public.core_v2_guard_decision_delete() returns trigger
language plpgsql as $$
begin
  if old.status in ('machine_decided','human_decided','superseded')
     or exists (select 1 from public.disagreements d where d.resolution_decision_id = old.id) then
    raise exception 'core_v2: decision % is part of the record — it is superseded, not deleted', old.id
      using errcode = 'check_violation';
  end if;
  return old;
end $$;

-- A verdict answers the claims its task was handed. A packet cannot quietly
-- widen on the way out; an answer cannot quietly widen on the way back.
create or replace function public.core_v2_guard_assessment() returns trigger
language plpgsql as $$
begin
  if new.task_id is not null
     and exists (select 1 from public.task_target_claims t where t.task_id = new.task_id)
     and not exists (select 1 from public.task_target_claims t
                      where t.task_id = new.task_id and t.claim_id = new.claim_id) then
    raise exception 'core_v2: task % was not asked about claim % — a verdict does not widen the packet',
      new.task_id, new.claim_id using errcode = 'check_violation';
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

drop trigger if exists core_v2_workflow_guard on public.intelligence_workflows;
create trigger core_v2_workflow_guard before update on public.intelligence_workflows
  for each row execute function public.core_v2_guard_workflow();
drop trigger if exists core_v2_outbox_guard on public.workflow_outbox;
create trigger core_v2_outbox_guard before update on public.workflow_outbox
  for each row execute function public.core_v2_guard_outbox();
drop trigger if exists core_v2_source_guard on public.workflow_sources;
create trigger core_v2_source_guard before update or delete on public.workflow_sources
  for each row execute function public.core_v2_guard_source();
drop trigger if exists core_v2_segment_guard on public.source_segments;
create trigger core_v2_segment_guard before insert or update or delete on public.source_segments
  for each row execute function public.core_v2_guard_segment();
drop trigger if exists core_v2_task_guard on public.workflow_tasks;
create trigger core_v2_task_guard before update on public.workflow_tasks
  for each row execute function public.core_v2_guard_task();
drop trigger if exists core_v2_task_insert_guard on public.workflow_tasks;
create trigger core_v2_task_insert_guard before insert on public.workflow_tasks
  for each row execute function public.core_v2_guard_task_insert();
drop trigger if exists core_v2_edge_insert_guard on public.task_dependencies;
create trigger core_v2_edge_insert_guard before insert on public.task_dependencies
  for each row execute function public.core_v2_guard_edge_insert();
drop trigger if exists core_v2_attempt_guard on public.agent_attempts;
create trigger core_v2_attempt_guard before update on public.agent_attempts
  for each row execute function public.core_v2_guard_attempt();
drop trigger if exists core_v2_attempt_delete_guard on public.agent_attempts;
create trigger core_v2_attempt_delete_guard before delete on public.agent_attempts
  for each row execute function public.core_v2_guard_attempt_delete();
drop trigger if exists core_v2_claim_guard on public.evidence_claims;
create trigger core_v2_claim_guard before update on public.evidence_claims
  for each row execute function public.core_v2_guard_claim();
drop trigger if exists core_v2_claim_delete_guard on public.evidence_claims;
create trigger core_v2_claim_delete_guard before delete on public.evidence_claims
  for each row execute function public.core_v2_guard_claim_delete();
drop trigger if exists core_v2_anchor_guard on public.evidence_anchors;
create trigger core_v2_anchor_guard before update or delete on public.evidence_anchors
  for each row execute function public.core_v2_guard_anchor();
drop trigger if exists core_v2_anchor_shape on public.evidence_anchors;
create trigger core_v2_anchor_shape before insert or update on public.evidence_anchors
  for each row execute function public.core_v2_shape_anchor();
drop trigger if exists core_v2_decision_evidence_guard on public.decision_evidence;
create trigger core_v2_decision_evidence_guard before insert or update or delete on public.decision_evidence
  for each row execute function public.core_v2_guard_decision_evidence();
drop trigger if exists core_v2_disagreement_guard on public.disagreements;
create trigger core_v2_disagreement_guard before update on public.disagreements
  for each row execute function public.core_v2_guard_disagreement();
drop trigger if exists core_v2_disagreement_insert_guard on public.disagreements;
create trigger core_v2_disagreement_insert_guard before insert on public.disagreements
  for each row execute function public.core_v2_guard_disagreement_insert();
drop trigger if exists core_v2_disagreement_delete_guard on public.disagreements;
create trigger core_v2_disagreement_delete_guard before delete on public.disagreements
  for each row execute function public.core_v2_guard_disagreement_delete();
drop trigger if exists core_v2_disagreement_claims_guard on public.disagreement_claims;
create trigger core_v2_disagreement_claims_guard before insert or update or delete on public.disagreement_claims
  for each row execute function public.core_v2_guard_disagreement_claims();
drop trigger if exists core_v2_follow_up_guard on public.disagreement_follow_ups;
create trigger core_v2_follow_up_guard before update or delete on public.disagreement_follow_ups
  for each row execute function public.core_v2_guard_follow_up();
drop trigger if exists core_v2_follow_up_insert_guard on public.disagreement_follow_ups;
create trigger core_v2_follow_up_insert_guard before insert on public.disagreement_follow_ups
  for each row execute function public.core_v2_guard_follow_up_insert();
drop trigger if exists core_v2_decision_guard on public.decisions;
create trigger core_v2_decision_guard before update on public.decisions
  for each row execute function public.core_v2_guard_decision();
drop trigger if exists core_v2_decision_delete_guard on public.decisions;
create trigger core_v2_decision_delete_guard before delete on public.decisions
  for each row execute function public.core_v2_guard_decision_delete();
drop trigger if exists core_v2_assessment_guard on public.claim_assessments;
create trigger core_v2_assessment_guard before insert or update on public.claim_assessments
  for each row execute function public.core_v2_guard_assessment();
drop trigger if exists core_v2_action_touch on public.decision_actions;
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

create or replace function public.core_v2_assert_claim_anchored(claim public.evidence_claims)
returns void language plpgsql stable as $$
begin
  if claim.status not in ('verified','accepted') then return; end if;
  if not exists (select 1 from public.evidence_anchors a where a.claim_id = claim.id) then
    raise exception 'core_v2: claim % is % with nothing to open — every accepted claim has a source anchor', claim.id, claim.status
      using errcode = 'check_violation';
  end if;
  -- A claim parsed out of a result that ran out of room may be shown. It
  -- cannot be accepted until something complete verifies it. The flag the
  -- writer set is one way to know that; the attempt the claim itself names is
  -- the other, and it is the one nobody has to remember to set.
  if claim.status = 'accepted'
     and (claim.incomplete_source_attempt
          or exists (select 1 from public.agent_attempts a
                      where a.id = claim.attempt_id and a.state = 'output_limited')) then
    raise exception 'core_v2: claim % came from an attempt that was cut short — it needs a complete verification before acceptance', claim.id
      using errcode = 'check_violation';
  end if;

  -- A person's own record is a real anchor — for what a person reported. Under
  -- a machine's reading it is a sentence the machine wrote about itself, and
  -- the chain stops there instead of reaching a source.
  if claim.status = 'accepted'
     and claim.observation_basis <> 'reported'
     and not exists (select 1 from public.evidence_anchors a
                      where a.claim_id = claim.id and a.source_kind <> 'human_record') then
    raise exception 'core_v2: claim % is accepted on a person''s record but was not reported by a person', claim.id
      using errcode = 'check_violation';
  end if;

  -- Agreement is not proof. A machine reading becomes accepted on a verdict
  -- from a different executor domain, on a deterministic rule, or on a person
  -- — never on a verdict from its own domain, and never on its own.
  if claim.status = 'accepted' and claim.independence_domain is not null
     and not exists (
       select 1 from public.claim_assessments s
         join public.agent_attempts a on a.id = s.attempt_id
        where s.claim_id = claim.id and s.assessment = 'supports'
          and a.independence_domain is distinct from claim.independence_domain)
     and not exists (
       select 1 from public.decision_evidence e
         join public.decisions d on d.id = e.decision_id
        where e.claim_id = claim.id and e.link = 'supports'
          and d.authority in ('deterministic_rule','human'))
     -- The third way, and the only one an adjudicator has: a correction. When
     -- the readers all read wrong, what stands is not the arbiter's opinion
     -- but the value a reviewer read off the reopened source, and the decision
     -- that accepts it must cite that reviewer's own anchor. An adjudication
     -- resting on nothing but the readings it is settling accepts nothing.
     and not exists (
       select 1 from public.decision_evidence supports
         join public.decisions d on d.id = supports.decision_id
         join public.decision_evidence cited on cited.decision_id = d.id
         join public.evidence_anchors anchor on anchor.id = cited.anchor_id
         join public.claim_assessments s on s.id = anchor.assessment_id
         join public.agent_attempts a on a.id = s.attempt_id
        where supports.claim_id = claim.id and supports.link = 'supports'
          and d.authority = 'adjudicator'
          and a.independence_domain is distinct from claim.independence_domain) then
    raise exception 'core_v2: claim % is accepted with no independent verification, deterministic rule or person behind it', claim.id
      using errcode = 'check_violation';
  end if;
end $$;

create or replace function public.core_v2_check_claim_evidence() returns trigger
language plpgsql as $$
declare claim public.evidence_claims;
begin
  select * into claim from public.evidence_claims where id = new.id;
  if found then perform public.core_v2_assert_claim_anchored(claim); end if;
  return null;
end $$;

create or replace function public.core_v2_recheck_claim_of_anchor() returns trigger
language plpgsql as $$
declare claim public.evidence_claims;
begin
  select * into claim from public.evidence_claims
   where id = case when TG_OP = 'DELETE' then old.claim_id else new.claim_id end
   for share;
  if found then perform public.core_v2_assert_claim_anchored(claim); end if;
  return null;
end $$;

-- The verdict an acceptance rests on is part of the record too: pulling it out
-- afterwards would leave the claim standing on nothing.
create or replace function public.core_v2_recheck_claim_of_assessment() returns trigger
language plpgsql as $$
declare claim public.evidence_claims;
begin
  select * into claim from public.evidence_claims
   where id = case when TG_OP = 'DELETE' then old.claim_id else new.claim_id end
   for share;
  if found then perform public.core_v2_assert_claim_anchored(claim); end if;
  return null;
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
  -- an earlier one, and the evidence lives on the decision it replaces — which
  -- only holds if it says which decision that is.
  if decided.decision_type = 'supersede' then
    if decided.supersedes_decision_id is null then
      raise exception 'core_v2: decision % supersedes nothing — a supersession names the decision it replaces', decided.id
        using errcode = 'check_violation';
    end if;
    return null;
  end if;

  -- Rejecting everything is a real adjudication and carries a real burden: every
  -- competing claim linked as contradicted, and at least one anchor of its own
  -- saying what the source actually shows.
  if decided.decision_type = 'reject_all' then
    select * into disagreement from public.disagreements
     where resolution_decision_id = decided.id limit 1;
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

  -- `for share` on the claims counted: superseding one of them and deciding
  -- this decision are two transactions writing two different rows, and without
  -- the lock each reads a world in which the other never happened.
  select count(*) into supporting from (
    select 1 from public.decision_evidence e
      join public.evidence_claims c on c.id = e.claim_id
     where e.decision_id = decided.id and e.link = 'supports' and c.status = 'accepted'
     for share of c) s;
  if supporting = 0 then
    raise exception 'core_v2: decision % is decided with no accepted claim supporting it', decided.id
      using errcode = 'check_violation';
  end if;
  return null;
end $$;

create or replace function public.core_v2_check_decision_evidence_for(decided public.decisions)
returns void language plpgsql stable as $$
declare supporting integer;
begin
  if decided.status not in ('machine_decided','human_decided') then
    return;
  end if;
  if decided.decision_type = 'supersede' then
    if decided.supersedes_decision_id is null then
      raise exception 'core_v2: decision % supersedes nothing — a supersession names the decision it replaces', decided.id
        using errcode = 'check_violation';
    end if;
    return;
  end if;
  if decided.decision_type = 'reject_all' then
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

create or replace function public.core_v2_recheck_decision_of_evidence() returns trigger
language plpgsql as $$
declare
  target uuid := case when TG_OP = 'DELETE' then old.decision_id else new.decision_id end;
  probe public.decisions;
begin
  select * into probe from public.decisions where id = target for share;
  if found then perform public.core_v2_check_decision_evidence_for(probe); end if;
  return null;
end $$;

-- Superseding the claim a decision rests on, and leaving the decision standing,
-- would leave a reader holding a decision that its own evidence no longer
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
   limit 1 for share of d;
  if standing is not null then
    raise exception 'core_v2: claim % was superseded while decision % still rests on it — supersede the decision in the same breath',
      claim.id, standing using errcode = 'check_violation';
  end if;
  -- And supersession is a replacement, not a disappearance: something has to
  -- be the later reading, or the word is a deletion the delete guard refuses.
  if not exists (select 1 from public.evidence_claims r where r.supersedes_claim_id = claim.id) then
    raise exception 'core_v2: claim % is superseded by nothing — supersession names the reading that replaces it', claim.id
      using errcode = 'check_violation';
  end if;
  return null;
end $$;

drop trigger if exists core_v2_claim_evidence_check on public.evidence_claims;
create constraint trigger core_v2_claim_evidence_check
  after insert or update on public.evidence_claims
  deferrable initially deferred
  for each row execute function public.core_v2_check_claim_evidence();

drop trigger if exists core_v2_claim_supersession_check on public.evidence_claims;
create constraint trigger core_v2_claim_supersession_check
  after update on public.evidence_claims
  deferrable initially deferred
  for each row execute function public.core_v2_check_superseded_claim_decisions();

drop trigger if exists core_v2_assessment_removal_check on public.claim_assessments;
create constraint trigger core_v2_assessment_removal_check
  after insert or update or delete on public.claim_assessments
  deferrable initially deferred
  for each row execute function public.core_v2_recheck_claim_of_assessment();

drop trigger if exists core_v2_anchor_removal_check on public.evidence_anchors;
create constraint trigger core_v2_anchor_removal_check
  after insert or update or delete on public.evidence_anchors
  deferrable initially deferred
  for each row execute function public.core_v2_recheck_claim_of_anchor();

drop trigger if exists core_v2_decision_evidence_check on public.decisions;
create constraint trigger core_v2_decision_evidence_check
  after insert or update on public.decisions
  deferrable initially deferred
  for each row execute function public.core_v2_check_decision_evidence();

drop trigger if exists core_v2_decision_evidence_link_check on public.decision_evidence;
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

drop trigger if exists core_v2_decision_supersession_audit on public.decisions;
create trigger core_v2_decision_supersession_audit after update on public.decisions
  for each row execute function public.core_v2_audit_decision_superseded();
drop trigger if exists core_v2_claim_supersession_audit on public.evidence_claims;
create trigger core_v2_claim_supersession_audit after update on public.evidence_claims
  for each row execute function public.core_v2_audit_claim_superseded();

-- ═══════════════════════════════ 12 · how the machine moves its own records
--
-- The worker runs as the service role, which is not subject to row-level
-- security — so these functions are not a permission boundary. They are the
-- named moves, one per machine, so that a transition is written in exactly one
-- place and the guards above are never routed around. The lease, heartbeat and
-- submission moves are each one statement, because two workers racing for one
-- task must be settled by the row lock, not by whichever read its state first.
--
-- Each takes the state the caller believes the record is in. Say it and the
-- move is compare-and-set: a worker that read the row a moment ago, and acts on
-- a reading somebody else has since replaced, is told so instead of marching
-- the record on from a state it never saw.
drop function if exists public.core_v2_workflow_transition(uuid, text, text, text);
create or replace function public.core_v2_workflow_transition(
  p_workflow_id uuid, p_to_state text, p_error_code text default null, p_error_message text default null,
  p_from text default null
) returns public.intelligence_workflows language plpgsql security definer set search_path = public as $$
declare
  row public.intelligence_workflows;
  actual text;
begin
  update public.intelligence_workflows
     set state = p_to_state,
         error_code = coalesce(p_error_code, error_code),
         error_message = coalesce(p_error_message, error_message),
         started_at = case when p_to_state = 'planning' and started_at is null then now() else started_at end,
         finished_at = case when p_to_state in ('completed','partial','failed','cancelled') then now() else finished_at end
   where id = p_workflow_id and (p_from is null or state = p_from)
  returning * into row;
  if not found then
    select w.state into actual from public.intelligence_workflows w where w.id = p_workflow_id;
    if actual is null then raise exception 'core_v2: no workflow %', p_workflow_id; end if;
    raise exception 'core_v2: workflow % is %, not % — the move was made from a stale reading',
      p_workflow_id, actual, p_from using errcode = 'check_violation';
  end if;
  return row;
end $$;

drop function if exists public.core_v2_task_transition(uuid, text, text);
create or replace function public.core_v2_task_transition(
  p_task_id uuid, p_to_state text, p_terminal_reason text default null, p_from text default null
) returns public.workflow_tasks language plpgsql security definer set search_path = public as $$
declare
  row public.workflow_tasks;
  actual text;
begin
  update public.workflow_tasks
     set state = p_to_state,
         terminal_reason = coalesce(p_terminal_reason, terminal_reason)
   where id = p_task_id and (p_from is null or state = p_from)
  returning * into row;
  if not found then
    select t.state into actual from public.workflow_tasks t where t.id = p_task_id;
    if actual is null then raise exception 'core_v2: no task %', p_task_id; end if;
    raise exception 'core_v2: task % is %, not % — the move was made from a stale reading',
      p_task_id, actual, p_from using errcode = 'check_violation';
  end if;
  return row;
end $$;

drop function if exists public.core_v2_attempt_transition(uuid, text, text, text, jsonb);
create or replace function public.core_v2_attempt_transition(
  p_attempt_id uuid, p_to_state text, p_error_code text default null, p_error_message text default null,
  p_usage jsonb default null, p_from text default null
) returns public.agent_attempts language plpgsql security definer set search_path = public as $$
declare
  row public.agent_attempts;
  actual text;
begin
  update public.agent_attempts
     set state = p_to_state,
         error_code = coalesce(p_error_code, error_code),
         error_message = coalesce(p_error_message, error_message),
         usage = case when p_usage is null then usage else p_usage end,
         submitted_at = case when p_to_state = 'submitted' and submitted_at is null then now() else submitted_at end,
         received_at = case when p_to_state in ('response_received','output_limited') and received_at is null then now() else received_at end,
         finished_at = case when p_to_state in ('succeeded','failed_known','output_limited','outcome_unknown',
                                                'rejected_before_submission','cancelled_before_submission')
                            then now() else finished_at end
   where id = p_attempt_id and (p_from is null or state = p_from)
  returning * into row;
  if not found then
    select a.state into actual from public.agent_attempts a where a.id = p_attempt_id;
    if actual is null then raise exception 'core_v2: no attempt %', p_attempt_id; end if;
    raise exception 'core_v2: attempt % is %, not % — the move was made from a stale reading',
      p_attempt_id, actual, p_from using errcode = 'check_violation';
  end if;
  return row;
end $$;

drop function if exists public.core_v2_claim_transition(uuid, text);
create or replace function public.core_v2_claim_transition(
  p_claim_id uuid, p_to_status text, p_from text default null
) returns public.evidence_claims language plpgsql security definer set search_path = public as $$
declare
  row public.evidence_claims;
  actual text;
begin
  update public.evidence_claims set status = p_to_status
   where id = p_claim_id and (p_from is null or status = p_from)
  returning * into row;
  if not found then
    select c.status into actual from public.evidence_claims c where c.id = p_claim_id;
    if actual is null then raise exception 'core_v2: no claim %', p_claim_id; end if;
    raise exception 'core_v2: claim % is %, not % — the move was made from a stale reading',
      p_claim_id, actual, p_from using errcode = 'check_violation';
  end if;
  return row;
end $$;

drop function if exists public.core_v2_disagreement_transition(uuid, text, uuid);
create or replace function public.core_v2_disagreement_transition(
  p_disagreement_id uuid, p_to_state text, p_resolution_decision_id uuid default null,
  p_from text default null
) returns public.disagreements language plpgsql security definer set search_path = public as $$
declare
  row public.disagreements;
  actual text;
begin
  update public.disagreements
     set state = p_to_state,
         resolution_decision_id = coalesce(p_resolution_decision_id, resolution_decision_id)
   where id = p_disagreement_id and (p_from is null or state = p_from)
  returning * into row;
  if not found then
    select d.state into actual from public.disagreements d where d.id = p_disagreement_id;
    if actual is null then raise exception 'core_v2: no disagreement %', p_disagreement_id; end if;
    raise exception 'core_v2: disagreement % is %, not % — the move was made from a stale reading',
      p_disagreement_id, actual, p_from using errcode = 'check_violation';
  end if;
  return row;
end $$;

drop function if exists public.core_v2_decision_transition(uuid, text, uuid);
create or replace function public.core_v2_decision_transition(
  p_decision_id uuid, p_to_status text, p_decided_by_attempt_id uuid default null,
  p_from text default null
) returns public.decisions language plpgsql security definer set search_path = public as $$
declare
  row public.decisions;
  actual text;
begin
  update public.decisions
     set status = p_to_status,
         decided_by_attempt_id = coalesce(p_decided_by_attempt_id, decided_by_attempt_id),
         effective_at = case when p_to_status in ('machine_decided','human_decided') and effective_at is null
                             then now() else effective_at end
   where id = p_decision_id and (p_from is null or status = p_from)
  returning * into row;
  if not found then
    select d.status into actual from public.decisions d where d.id = p_decision_id;
    if actual is null then raise exception 'core_v2: no decision %', p_decision_id; end if;
    raise exception 'core_v2: decision % is %, not % — the move was made from a stale reading',
      p_decision_id, actual, p_from using errcode = 'check_violation';
  end if;
  return row;
end $$;

-- A lease is granted to a queued task, or taken over from a lease that ran out
-- before anything was sent. It is never granted while any attempt of the task
-- is out with an executor: that request may have run, and a second lease would
-- buy it again. The exception is the one a person made: an attempt reconciled
-- by an authorised retry no longer stands in the way, or the retry could never
-- run. Null, not an exception — losing a race is not an error.
create or replace function public.core_v2_lease_task(p_task_id uuid, p_owner text, p_ttl_ms integer)
returns public.workflow_tasks language plpgsql security definer set search_path = public as $$
declare row public.workflow_tasks;
begin
  update public.workflow_tasks t
     set state = 'leased',
         lease_owner = p_owner,
         lease_token = gen_random_uuid(),
         lease_expires_at = now() + make_interval(secs => p_ttl_ms / 1000.0)
   where t.id = p_task_id
     and (t.state = 'queued' or (t.state = 'leased' and t.lease_expires_at < now()))
     and not public.core_v2_task_has_open_attempt(t)
  returning t.* into row;
  return row;
end $$;

comment on function public.core_v2_lease_task(uuid, text, integer) is
  'Leases a queued task, or one whose lease expired unsent, under a fresh fencing token. Returns null when the task is not available — including when an attempt of it was submitted and no person has since authorised a retry.';

create or replace function public.core_v2_heartbeat_lease(p_task_id uuid, p_lease_token uuid, p_ttl_ms integer)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  update public.workflow_tasks
     set lease_expires_at = now() + make_interval(secs => p_ttl_ms / 1000.0)
   where id = p_task_id
     and lease_token = p_lease_token
     and state in ('leased','running');
  return found;
end $$;

-- The one moment money may leave: an attempt goes from prepared to submitted.
-- Everything that would make that submission a mistake is checked under the
-- task's row lock, in this order, and the refusal names the reason.
create or replace function public.core_v2_submit_attempt(p_attempt_id uuid, p_lease_token uuid)
returns public.agent_attempts language plpgsql security definer set search_path = public as $$
declare
  attempt public.agent_attempts;
  task public.workflow_tasks;
  wf public.intelligence_workflows;
  row public.agent_attempts;
begin
  select * into attempt from public.agent_attempts where id = p_attempt_id for update;
  if not found then
    raise exception 'core_v2: submission refused: no attempt %', p_attempt_id;
  end if;
  select * into task from public.workflow_tasks where id = attempt.task_id for update;
  select * into wf from public.intelligence_workflows where id = attempt.workflow_id for share;

  if not public.core_v2_workflow_active(wf.state) then
    raise exception 'core_v2: submission refused: workflow % is %', wf.id, wf.state;
  end if;
  if wf.cancel_requested_at is not null then
    raise exception 'core_v2: submission refused: cancellation of workflow % was requested', wf.id;
  end if;
  if task.state <> 'running' then
    raise exception 'core_v2: submission refused: task % is %, not running', task.id, task.state;
  end if;
  if p_lease_token is null or task.lease_token is distinct from p_lease_token then
    raise exception 'core_v2: submission refused: the lease token does not match task %', task.id;
  end if;
  if task.lease_expires_at is null or task.lease_expires_at <= now() then
    raise exception 'core_v2: submission refused: the lease on task % has expired', task.id;
  end if;
  if attempt.state <> 'prepared' then
    raise exception 'core_v2: submission refused: attempt % is %, not prepared', attempt.id, attempt.state;
  end if;

  -- Independence is decided here, not only by whoever routed the work. Two
  -- blind readings of one subject must run in two executor domains, and a
  -- router that has forgotten what already read this subject must not be able
  -- to buy the same domain twice. The advisory lock serialises the blind
  -- submissions of one subject so two of them cannot both pass this check.
  if task.independence_group is not null then
    perform pg_advisory_xact_lock(hashtextextended(task.workflow_id::text || '/' || task.subject_key, 0));
    if exists (
      select 1
        from public.agent_attempts a
        join public.workflow_tasks t on t.id = a.task_id
       where t.workflow_id = task.workflow_id
         and t.subject_key = task.subject_key
         and t.independence_group is not null
         and t.independence_group <> task.independence_group
         and a.independence_domain = attempt.independence_domain
         and public.core_v2_attempt_submitted(a.state)
    ) then
      raise exception 'core_v2: submission refused: independence: domain % already read % under another group',
        attempt.independence_domain, task.subject_key;
    end if;
  end if;

  -- Everything above has been proved; the marker says so to the row guard,
  -- which refuses this move to anybody who has not proved it.
  perform set_config('core_v2.submitting_attempt', p_attempt_id::text, true);
  update public.agent_attempts
     set state = 'submitted',
         submitted_at = now(),
         lease_token = p_lease_token
   where id = p_attempt_id
  returning * into row;
  perform set_config('core_v2.submitting_attempt', '', true);
  return row;
end $$;

comment on function public.core_v2_submit_attempt(uuid, uuid) is
  'The only move from prepared to submitted. Under the task''s row lock it proves the workflow is active and not being cancelled, the task is running under the caller''s unexpired lease, and the attempt is still prepared — and, for a blind reading, that no other group has already read this subject in the same executor domain.';

-- The dispatcher's two moves. Claiming a command is what takes the workflow
-- from created to queued; a dispatcher that dies between the two leaves a
-- dispatching row whose attempt count says so.
create or replace function public.core_v2_claim_outbox(p_workflow_id uuid, p_dispatcher text)
returns public.workflow_outbox language plpgsql security definer set search_path = public as $$
declare row public.workflow_outbox;
begin
  update public.workflow_outbox
     set state = 'dispatching',
         dispatcher = p_dispatcher,
         attempt_count = attempt_count + 1
   where workflow_id = p_workflow_id and state = 'pending'
  returning * into row;
  if not found then return null; end if;
  if exists (select 1 from public.intelligence_workflows w where w.id = p_workflow_id and w.state = 'created') then
    perform public.core_v2_workflow_transition(p_workflow_id, 'queued');
  end if;
  return row;
end $$;

create or replace function public.core_v2_acknowledge_outbox(p_workflow_id uuid)
returns public.workflow_outbox language plpgsql security definer set search_path = public as $$
declare row public.workflow_outbox;
begin
  update public.workflow_outbox
     set state = 'acknowledged'
   where workflow_id = p_workflow_id and state = 'dispatching'
  returning * into row;
  if not found then return null; end if;
  return row;
end $$;

comment on function public.core_v2_acknowledge_outbox(uuid) is
  'Marks a dispatching command acknowledged. Returns null when the command is not dispatching, so a dispatcher can tell a late acknowledgement from a lost one.';

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

-- A source Core V2 may read from. A locator and a byte size say where a thing
-- is kept and how big it was, not which bytes it holds — a re-upload to the
-- same key at the same size is a different source wearing the same label. So
-- a source must carry a content digest with its algorithm, or the storage
-- system's own immutable version id.
create or replace function public.core_v2_source_identity(p_source jsonb)
returns text language sql immutable as $$
  select case
    when nullif(p_source ->> 'content_hash', '') is not null
     and nullif(p_source ->> 'hash_algorithm', '') is not null
      then format('digest=%s:%s', p_source ->> 'hash_algorithm', p_source ->> 'content_hash')
    when nullif(p_source ->> 'object_version_id', '') is not null
      then format('version=%s', p_source ->> 'object_version_id')
  end;
$$;

comment on function public.core_v2_source_identity(jsonb) is
  'The immutable content identity of a source: a digest with its algorithm, or the storage version id. Null means the source has no trustworthy identity and Core V2 will not read it.';

-- The fingerprint of a set of sources, computed here so that no caller can
-- claim two different sets are the same one. Position in the array is the
-- source's ordinal; the same sources in another order are another set.
create or replace function public.core_v2_source_set_fingerprint(p_sources jsonb)
returns text language plpgsql immutable as $$
declare
  parts text;
  unidentified text;
begin
  if p_sources is null or jsonb_typeof(p_sources) <> 'array' or jsonb_array_length(p_sources) = 0 then
    raise exception 'core_v2: a workflow must name the sources it reads';
  end if;
  select string_agg(
           format('%s|%s|%s|%s|%s',
                  s.ordinality - 1,
                  coalesce(s.source ->> 'source_kind', ''),
                  coalesce(s.source ->> 'uri', ''),
                  public.core_v2_source_identity(s.source),
                  coalesce(s.source ->> 'byte_size', '')),
           E'\n' order by s.ordinality),
         string_agg(coalesce(s.source ->> 'label', s.source ->> 'uri', s.ordinality::text), ', ' order by s.ordinality)
           filter (where public.core_v2_source_identity(s.source) is null)
    into parts, unidentified
    from jsonb_array_elements(p_sources) with ordinality as s(source, ordinality);
  if unidentified is not null then
    raise exception 'core_v2: % has no content digest and no storage version — Core V2 does not read a source it cannot identify', unidentified;
  end if;
  return encode(sha256(convert_to(parts, 'UTF8')), 'hex');
end $$;

comment on function public.core_v2_source_set_fingerprint(jsonb) is
  'Server-side hash of exactly which sources a workflow was asked to read: ordinal, kind, locator, content identity and size. Refuses an empty set and a source with no trustworthy identity.';

create or replace function public.core_v2_request_fingerprint(
  p_domain_pack text, p_domain_pack_version text, p_workflow_type text,
  p_source_set_fingerprint text, p_requested_scope jsonb, p_engine_version text
) returns text language sql immutable as $$
  select encode(sha256(convert_to(
    format('%s|%s|%s|%s|%s|%s', p_domain_pack, p_domain_pack_version, p_workflow_type,
           p_source_set_fingerprint,
           public.core_v2_canonical_json(coalesce(p_requested_scope, '{}'::jsonb))::text,
           p_engine_version), 'UTF8')), 'hex');
$$;

comment on function public.core_v2_request_fingerprint(text, text, text, text, jsonb, text) is
  'What was asked, not only of which sources: pack and version, type, source set, canonical scope and engine version. Reading part of a set and reading the whole set are different requests over the same sources.';

-- Create a workflow, its sources and its start command in one transaction.
-- Nothing runs from here: the rows and the outbox command are the whole
-- effect, and a dispatcher that never comes leaves a workflow saying
-- `created`, which is the truth.
create or replace function public.core_v2_start_workflow(
  p_organization_id uuid,
  p_domain_pack text,
  p_domain_pack_version text,
  p_workflow_type text,
  p_sources jsonb,
  p_requested_scope jsonb default '{}'::jsonb,
  p_engine_version text default 'core-v2.1',
  p_budget jsonb default '{}'::jsonb,
  p_expected_fingerprint text default null,
  p_authorize_duplicate boolean default false
) returns public.intelligence_workflows language plpgsql security definer set search_path = public as $$
declare
  fingerprint text;
  request text;
  live public.intelligence_workflows;
  duplicate boolean := false;
  row public.intelligence_workflows;
  source jsonb;
  position integer := 0;
begin
  if not exists (select 1 from public.organizations o where o.id = p_organization_id) then
    raise exception 'core_v2: no such organisation';
  end if;
  if coalesce(p_domain_pack, '') = '' or coalesce(p_domain_pack_version, '') = ''
     or coalesce(p_workflow_type, '') = '' then
    raise exception 'core_v2: a workflow names its domain pack, the pack version and the kind of work';
  end if;

  fingerprint := public.core_v2_source_set_fingerprint(p_sources);
  if p_expected_fingerprint is not null and p_expected_fingerprint <> fingerprint then
    raise exception 'core_v2: the sources have changed since this was prepared — nothing was started';
  end if;
  request := public.core_v2_request_fingerprint(
    p_domain_pack, p_domain_pack_version, p_workflow_type, fingerprint, p_requested_scope, p_engine_version);

  select * into live from public.intelligence_workflows w
   where w.organization_id = p_organization_id
     and w.request_fingerprint = request
     and public.core_v2_workflow_active(w.state)
   limit 1;
  duplicate := found;
  if duplicate and not p_authorize_duplicate then
    raise exception 'core_v2: this is already being read by workflow % — open it, or authorise a second reading', live.id;
  end if;
  -- The authorisation is a person's. A caller with no signed-in person cannot
  -- leave a second live request that nobody answers for.
  if duplicate and auth.uid() is null then
    raise exception 'core_v2: a second live reading of the same request is authorised by a person, and nobody is signed in';
  end if;

  insert into public.intelligence_workflows(
    organization_id, domain_pack, domain_pack_version, workflow_type, engine_version,
    source_set_fingerprint, request_fingerprint,
    requested_by, requested_scope, budget,
    duplicate_authorized_by)
  values (p_organization_id, p_domain_pack, p_domain_pack_version, p_workflow_type, p_engine_version,
          fingerprint, request,
          auth.uid(), public.core_v2_canonical_json(coalesce(p_requested_scope, '{}'::jsonb)),
          public.core_v2_canonical_json(coalesce(p_budget, '{}'::jsonb)),
          case when duplicate then auth.uid() end)
  returning * into row;

  for source in select s.source from jsonb_array_elements(p_sources) with ordinality as s(source, ordinality)
                 order by s.ordinality loop
    insert into public.workflow_sources(
      organization_id, workflow_id, ordinal, source_kind, label, uri,
      content_hash, hash_algorithm, object_version_id, byte_size, media)
    values (p_organization_id, row.id, position,
            coalesce(source ->> 'source_kind', ''),
            source ->> 'label',
            coalesce(source ->> 'uri', ''),
            nullif(source ->> 'content_hash', ''),
            nullif(source ->> 'hash_algorithm', ''),
            nullif(source ->> 'object_version_id', ''),
            (source ->> 'byte_size')::bigint,
            coalesce(source -> 'media', '{}'::jsonb));
    position := position + 1;
  end loop;

  -- Same transaction, always. A workflow without its start command would be a
  -- reading nobody ever runs; a command without its workflow would start work
  -- with nowhere to write it.
  insert into public.workflow_outbox(organization_id, workflow_id, command, payload)
  values (p_organization_id, row.id, 'start',
          jsonb_build_object(
            'workflow_id', row.id,
            'organization_id', p_organization_id,
            'domain_pack', p_domain_pack,
            'domain_pack_version', p_domain_pack_version,
            'workflow_type', p_workflow_type,
            'engine_version', p_engine_version,
            'source_count', position,
            'source_set_fingerprint', fingerprint,
            'request_fingerprint', request));

  perform public.core_v2_audit(p_organization_id, 'core_v2.workflow.started', 'intelligence_workflow', row.id::text,
    jsonb_build_object('domain_pack', p_domain_pack, 'domain_pack_version', p_domain_pack_version,
                       'workflow_type', p_workflow_type, 'source_count', position,
                       'source_set_fingerprint', fingerprint, 'request_fingerprint', request,
                       'duplicate_authorized', row.duplicate_authorized_by is not null));
  return row;
end $$;

comment on function public.core_v2_start_workflow(uuid, text, text, text, jsonb, jsonb, text, jsonb, text, boolean) is
  'Creates a workflow, its sources and its one start command atomically. Calls no executor, spends nothing, and refuses a second live request over the same sources and scope unless a person authorises it. Service role only until a dispatcher exists: an authenticated caller must not be able to leave a permanent unconsumed outbox row.';

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
  if auth.role() is distinct from 'service_role'
     and not public.has_org_role(wf.organization_id, array['owner','admin']::public.studio_role[]) then
    raise exception 'core_v2: only an owner or an administrator stops an analysis';
  end if;

  update public.intelligence_workflows set cancel_requested_at = coalesce(cancel_requested_at, now())
   where id = p_workflow_id;

  -- Only what has not left. A task whose request is already with an executor
  -- keeps its state and is counted as outstanding below.
  with stopped as (
    update public.workflow_tasks t
       set state = 'cancelled',
           terminal_reason = coalesce(p_reason, 'stopped_by_person')
     where t.workflow_id = p_workflow_id
       and t.state in ('created','blocked','queued','leased')
       and not public.core_v2_task_has_open_attempt(t)
    returning 1)
  select count(*) into unsent from stopped;

  select count(*) into submitted from public.workflow_tasks t
   where t.workflow_id = p_workflow_id
     and exists (select 1 from public.agent_attempts a
                  where a.task_id = t.id
                    and a.state in ('submitted','response_received','outcome_unknown'));

  select count(*) into preserved from public.workflow_tasks t
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

-- A task that ended without a known outcome is not re-run by anything that is
-- not a person. This is the only door, and it records who opened it.
create or replace function public.core_v2_authorize_task_retry(p_task_id uuid, p_note text default null)
returns public.workflow_tasks language plpgsql security definer set search_path = public as $$
declare
  task public.workflow_tasks;
  row public.workflow_tasks;
begin
  select * into task from public.workflow_tasks where id = p_task_id;
  if not found then raise exception 'core_v2: no such task'; end if;
  if not public.has_org_role(task.organization_id, array['owner','admin']::public.studio_role[]) then
    raise exception 'core_v2: only an owner or an administrator authorises running a task again';
  end if;
  if task.state not in ('outcome_unknown','failed_known') then
    raise exception 'core_v2: task % is % — there is nothing to authorise', p_task_id, task.state;
  end if;

  perform set_config('core_v2.authorized_retry', p_task_id::text, true);
  update public.workflow_tasks
     set state = 'queued',
         retry_authorized_by = auth.uid(),
         retry_authorized_at = now()
   where id = p_task_id
  returning * into row;
  perform set_config('core_v2.authorized_retry', '', true);

  perform public.core_v2_audit(task.organization_id, 'core_v2.task.retry_authorized', 'workflow_task',
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
  anchor_workflow uuid;
  kept jsonb;
begin
  select * into dis from public.disagreements where id = p_disagreement_id;
  if not found then raise exception 'core_v2: no such disagreement'; end if;
  -- Owner, administrator and reviewer settle evidence disagreements. Starting,
  -- stopping and authorising a repeat stay with owner and administrator.
  if not public.has_org_role(dis.organization_id,
        array['owner','admin','reviewer']::public.studio_role[]) then
    raise exception 'core_v2: only an owner, an administrator or a reviewer settles a disagreement';
  end if;
  if dis.state not in ('open','verifying','needs_human') then
    raise exception 'core_v2: disagreement % is % — it is not open', p_disagreement_id, dis.state;
  end if;

  select jsonb_agg(dc.claim_id order by dc.position, dc.claim_id) into kept
    from public.disagreement_claims dc where dc.disagreement_id = dis.id;
  -- The template a correction is written from, and the set a rejection covers,
  -- are the claims that actually competed. A reading carried for context, or a
  -- counterpart that was never there, did not disagree with anything.
  select c.* into template from public.disagreement_claims dc
    join public.evidence_claims c on c.id = dc.claim_id
   where dc.disagreement_id = dis.id and dc.role = 'candidate'
   order by dc.position, dc.claim_id limit 1;

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
                       where dc.disagreement_id = dis.id and dc.claim_id = p_accepted_claim_id
                         and dc.role = 'candidate') then
      raise exception 'core_v2: the accepted claim must be one of the claims that disagreed';
    end if;
    winner := public.core_v2_claim_transition(p_accepted_claim_id, 'accepted');
  elsif p_outcome = 'correct' then
    -- None of the readings was right. The person supplies the corrected value
    -- and what they read it off; that becomes a reported claim with a human
    -- anchor, and it supersedes nothing quietly — the readings it replaces are
    -- rejected below and stay in the record.
    if p_corrected_value is null or p_corrected_source is null then
      raise exception 'core_v2: a correction needs both the corrected value and the source it was read from';
    end if;
    if template.id is null then
      raise exception 'core_v2: disagreement % names no claim to correct', p_disagreement_id;
    end if;
    insert into public.evidence_claims(
      organization_id, workflow_id, subject_type, subject_key, predicate,
      value, unit, observation_basis, scope, status, supersedes_claim_id)
    values (dis.organization_id, dis.workflow_id, template.subject_type,
            template.subject_key, template.predicate, p_corrected_value, p_corrected_unit,
            'reported', template.scope, 'accepted', template.id)
    returning * into winner;
    insert into public.evidence_anchors(organization_id, workflow_id, claim_id, source_kind,
      quoted_text, anchor_hash, locator)
    values (dis.organization_id, dis.workflow_id, winner.id, 'human_record', p_corrected_source,
            encode(sha256(convert_to(winner.id::text || p_corrected_source, 'UTF8')), 'hex'),
            jsonb_build_object('recorded_by', auth.uid(), 'note', p_note));
  elsif p_outcome = 'reject_all' then
    -- The source supports none of them. That is an adjudication with its own
    -- burden of proof, not a shrug: every competing claim is rejected and named,
    -- and the decision points at what the source does show.
    if p_evidence_anchor_ids is null or array_length(p_evidence_anchor_ids, 1) is null then
      raise exception 'core_v2: rejecting every reading needs at least one source anchor saying what the source shows';
    end if;
  else
    raise exception 'core_v2: % is not an outcome this function knows', p_outcome;
  end if;

  insert into public.decisions(organization_id, workflow_id, disagreement_id, decision_type,
    subject_key, title, summary, status, authority, rationale, decided_by_user_id, effective_at)
  values (dis.organization_id, dis.workflow_id, dis.id,
    case when p_outcome = 'reject_all' then 'reject_all' else 'accept_claim' end,
    coalesce(winner.subject_key, template.subject_key, ''),
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
    insert into public.decision_evidence(organization_id, decision_id, claim_id, link, rule)
    values (dis.organization_id, decision.id, winner.id, 'supports', 'human_resolution');
  end if;

  -- The claims that lost. Rejected, linked to the decision that rejected them,
  -- and still there to read.
  for loser in
    select dc.claim_id from public.disagreement_claims dc
     where dc.disagreement_id = dis.id and dc.role = 'candidate'
       and dc.claim_id is distinct from winner.id
     order by dc.position, dc.claim_id
  loop
    perform public.core_v2_claim_transition(loser, 'rejected');
    insert into public.decision_evidence(organization_id, decision_id, claim_id, link, rule)
    values (dis.organization_id, decision.id, loser, 'contradicts', 'human_resolution');
  end loop;

  if p_outcome = 'reject_all' then
    foreach anchor in array p_evidence_anchor_ids loop
      select a.workflow_id into anchor_workflow from public.evidence_anchors a where a.id = anchor;
      if anchor_workflow is distinct from dis.workflow_id then
        raise exception 'core_v2: that source anchor does not belong to this workflow';
      end if;
      insert into public.decision_evidence(organization_id, decision_id, anchor_id, link, rule)
      values (dis.organization_id, decision.id, anchor, 'context', 'human_resolution');
    end loop;
  end if;

  -- proposed -> needs_human -> human_decided, the path a decision a person
  -- makes takes. The evidence above was written while it was still open; from
  -- here it is closed.
  perform public.core_v2_decision_transition(decision.id, 'needs_human');
  decision := public.core_v2_decision_transition(decision.id, 'human_decided');
  perform public.core_v2_disagreement_transition(p_disagreement_id, 'resolved', decision.id);
  perform public.core_v2_audit(dis.organization_id, 'core_v2.disagreement.resolved', 'disagreement',
    p_disagreement_id::text, jsonb_build_object('outcome', p_outcome, 'note', p_note,
      'decision_id', decision.id, 'accepted_claim_id', winner.id,
      'claims_kept', kept));
  return decision;
end $$;

comment on function public.core_v2_resolve_disagreement(uuid, text, text, uuid, jsonb, text, text, uuid[]) is
  'A person settles a conflict: accept one reading, record a sourced correction, reject them all with source evidence, or ask for more evidence — which settles nothing and says so. Every competing claim is kept either way.';

-- ══════════════════════════════════════════════════════ 14 · who may see what
--
-- Every table here is readable by the organisation it belongs to, and writable
-- through a browser by nobody. There is deliberately not one insert, update or
-- delete policy in this file: the worker writes as the service role, and a
-- person acts through the doors above.
do $$
declare t text;
begin
  foreach t in array array[
    'intelligence_workflows','workflow_outbox','workflow_sources','source_segments',
    'workflow_tasks','task_sources','task_dependencies','task_target_claims','agent_attempts',
    'evidence_claims','claim_inputs','evidence_anchors','claim_assessments',
    'disagreements','disagreement_claims','disagreement_follow_ups',
    'decisions','decision_evidence','decision_actions']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', 'core_v2_' || t || '_read', t);
    execute format(
      'create policy %I on public.%I for select using (public.is_org_member(organization_id))',
      'core_v2_' || t || '_read', t);
  end loop;
end $$;

-- The machine's own moves belong to the machine. A signed-out visitor has no
-- path to any of them, and no path to starting work either.
revoke all on function public.core_v2_workflow_transition(uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.core_v2_task_transition(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.core_v2_attempt_transition(uuid, text, text, text, jsonb, text) from public, anon, authenticated;
revoke all on function public.core_v2_claim_transition(uuid, text, text) from public, anon, authenticated;
revoke all on function public.core_v2_disagreement_transition(uuid, text, uuid, text) from public, anon, authenticated;
revoke all on function public.core_v2_decision_transition(uuid, text, uuid, text) from public, anon, authenticated;
revoke all on function public.core_v2_lease_task(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.core_v2_heartbeat_lease(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.core_v2_submit_attempt(uuid, uuid) from public, anon, authenticated;
revoke all on function public.core_v2_claim_outbox(uuid, text) from public, anon, authenticated;
revoke all on function public.core_v2_acknowledge_outbox(uuid) from public, anon, authenticated;
revoke all on function public.core_v2_audit(uuid, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.core_v2_workflow_transition(uuid, text, text, text, text) to service_role;
grant execute on function public.core_v2_task_transition(uuid, text, text, text) to service_role;
grant execute on function public.core_v2_attempt_transition(uuid, text, text, text, jsonb, text) to service_role;
grant execute on function public.core_v2_claim_transition(uuid, text, text) to service_role;
grant execute on function public.core_v2_disagreement_transition(uuid, text, uuid, text) to service_role;
grant execute on function public.core_v2_decision_transition(uuid, text, uuid, text) to service_role;
grant execute on function public.core_v2_lease_task(uuid, text, integer) to service_role;
grant execute on function public.core_v2_heartbeat_lease(uuid, uuid, integer) to service_role;
grant execute on function public.core_v2_submit_attempt(uuid, uuid) to service_role;
grant execute on function public.core_v2_claim_outbox(uuid, text) to service_role;
grant execute on function public.core_v2_acknowledge_outbox(uuid) to service_role;
grant execute on function public.core_v2_audit(uuid, text, text, text, jsonb) to service_role;

-- Starting is the service role's until a dispatcher exists. An authenticated
-- caller who could start would leave an outbox command nothing consumes.
revoke all on function public.core_v2_start_workflow(uuid, text, text, text, jsonb, jsonb, text, jsonb, text, boolean) from public, anon, authenticated;
grant execute on function public.core_v2_start_workflow(uuid, text, text, text, jsonb, jsonb, text, jsonb, text, boolean) to service_role;

revoke all on function public.core_v2_cancel_workflow(uuid, text) from public, anon;
revoke all on function public.core_v2_authorize_task_retry(uuid, text) from public, anon;
revoke all on function public.core_v2_resolve_disagreement(uuid, text, text, uuid, jsonb, text, text, uuid[]) from public, anon;
revoke all on function public.core_v2_canonical_json(jsonb) from public, anon;
revoke all on function public.core_v2_source_identity(jsonb) from public, anon;
revoke all on function public.core_v2_source_set_fingerprint(jsonb) from public, anon;
revoke all on function public.core_v2_request_fingerprint(text, text, text, text, jsonb, text) from public, anon;
grant execute on function public.core_v2_cancel_workflow(uuid, text) to authenticated, service_role;
grant execute on function public.core_v2_authorize_task_retry(uuid, text) to authenticated, service_role;
grant execute on function public.core_v2_resolve_disagreement(uuid, text, text, uuid, jsonb, text, text, uuid[]) to authenticated, service_role;
grant execute on function public.core_v2_canonical_json(jsonb) to authenticated, service_role;
grant execute on function public.core_v2_source_identity(jsonb) to authenticated, service_role;
grant execute on function public.core_v2_source_set_fingerprint(jsonb) to authenticated, service_role;
grant execute on function public.core_v2_request_fingerprint(text, text, text, text, jsonb, text) to authenticated, service_role;

-- ═════════════════════════ 15 · one organisation, one workflow, all the way down
--
-- Source and evidence records cannot cross organisations through ids, search,
-- comparison or joins. The browser cannot write any of these tables at all, so
-- the risk is not a malicious form post — it is a worker, a fixture or a future
-- migration writing a row whose references belong to somebody else, or joining
-- a row of one workflow to a row of another and producing a decision that
-- opens somebody else's source.
--
-- Two things are checked on the way in, for every writer including the
-- service role:
--
--   · every reference the row carries resolves to a row of the same
--     organisation, and of the same workflow. A row that names no workflow
--     of its own belongs to the workflow of the first reference it names;
--   · neither the organisation nor the workflow ever changes afterwards. A row
--     does not move house.
--
-- The lookup is `security definer` on purpose. A tenancy guard that could only
-- see what the caller can see would answer "does not exist" instead of "another
-- organisation", and would be weaker for the reader who has least access.
create or replace function public.core_v2_tenant_of(
  p_table text, p_id uuid, out organization_id uuid, out workflow_id uuid
) returns record language plpgsql stable security definer set search_path = public as $$
declare workflow_column text;
begin
  if p_id is null then return; end if;
  workflow_column := case
    when p_table = 'intelligence_workflows' then 'id'
    when exists (select 1 from pg_attribute
                  where attrelid = ('public.' || quote_ident(p_table))::regclass
                    and attname = 'workflow_id' and not attisdropped) then 'workflow_id'
    else 'null::uuid' end;
  execute format('select organization_id, %s from public.%I where id = $1', workflow_column, p_table)
    into organization_id, workflow_id using p_id;
end $$;

create or replace function public.core_v2_guard_tenancy() returns trigger
language plpgsql as $$
declare
  i integer := 0;
  column_name text;
  parent_table text;
  child uuid;
  parent_organization uuid;
  parent_workflow uuid;
  row_json jsonb := to_jsonb(new);
  own_workflow uuid := nullif(row_json ->> 'workflow_id', '')::uuid;
  named_by text := 'workflow_id';
begin
  if TG_OP = 'UPDATE' then
    if new.organization_id is distinct from old.organization_id then
      raise exception 'core_v2: a % row does not change organisation after it is written', TG_TABLE_NAME
        using errcode = 'check_violation';
    end if;
    if (row_json ? 'workflow_id')
       and (row_json -> 'workflow_id') is distinct from (to_jsonb(old) -> 'workflow_id') then
      raise exception 'core_v2: a % row does not change workflow after it is written', TG_TABLE_NAME
        using errcode = 'check_violation';
    end if;
  end if;

  while i < TG_NARGS loop
    column_name := TG_ARGV[i];
    parent_table := TG_ARGV[i + 1];
    child := nullif(row_json ->> column_name, '')::uuid;
    if child is not null then
      select * into parent_organization, parent_workflow
        from public.core_v2_tenant_of(parent_table, child);
      if parent_organization is null then
        -- "a row of <table>", never "a <table>": the schema does not get to
        -- decide whether a table's name takes a or an.
        raise exception 'core_v2: %.% points at a row of % that does not exist',
          TG_TABLE_NAME, column_name, parent_table using errcode = 'check_violation';
      elsif parent_organization <> new.organization_id then
        raise exception 'core_v2: %.% points at a row of % that belongs to another organisation',
          TG_TABLE_NAME, column_name, parent_table using errcode = 'check_violation';
      end if;
      if parent_workflow is not null then
        if own_workflow is null then
          own_workflow := parent_workflow;
          named_by := column_name;
        elsif parent_workflow <> own_workflow then
          raise exception 'core_v2: %.% points at a row of % that belongs to another workflow than the one % names',
            TG_TABLE_NAME, column_name, parent_table, named_by using errcode = 'check_violation';
        end if;
      end if;
    end if;
    i := i + 2;
  end loop;
  return new;
end $$;

comment on function public.core_v2_guard_tenancy() is
  'Proves that every reference a Core V2 row carries resolves to the same organisation and the same workflow, and that neither changes afterwards. Trigger arguments are pairs of column name and parent table.';

do $$
declare t text;
begin
  foreach t in array array[
    'intelligence_workflows','workflow_outbox','workflow_sources','source_segments',
    'workflow_tasks','task_sources','task_dependencies','task_target_claims','agent_attempts',
    'evidence_claims','claim_inputs','evidence_anchors','claim_assessments',
    'disagreements','disagreement_claims','disagreement_follow_ups',
    'decisions','decision_evidence','decision_actions']
  loop
    execute format('drop trigger if exists core_v2_tenancy on public.%I', t);
  end loop;
end $$;

create trigger core_v2_tenancy before insert or update on public.intelligence_workflows
  for each row execute function public.core_v2_guard_tenancy();
create trigger core_v2_tenancy before insert or update on public.workflow_outbox
  for each row execute function public.core_v2_guard_tenancy('workflow_id','intelligence_workflows');
create trigger core_v2_tenancy before insert or update on public.workflow_sources
  for each row execute function public.core_v2_guard_tenancy('workflow_id','intelligence_workflows');
create trigger core_v2_tenancy before insert or update on public.source_segments
  for each row execute function public.core_v2_guard_tenancy(
    'workflow_id','intelligence_workflows','source_id','workflow_sources',
    'parent_segment_id','source_segments','discovered_by_attempt_id','agent_attempts');
create trigger core_v2_tenancy before insert or update on public.workflow_tasks
  for each row execute function public.core_v2_guard_tenancy(
    'workflow_id','intelligence_workflows','parent_task_id','workflow_tasks',
    'created_by_task_id','workflow_tasks','disagreement_id','disagreements');
create trigger core_v2_tenancy before insert or update on public.task_sources
  for each row execute function public.core_v2_guard_tenancy(
    'task_id','workflow_tasks','source_id','workflow_sources','segment_id','source_segments');
create trigger core_v2_tenancy before insert or update on public.task_dependencies
  for each row execute function public.core_v2_guard_tenancy(
    'task_id','workflow_tasks','depends_on_task_id','workflow_tasks');
create trigger core_v2_tenancy before insert or update on public.task_target_claims
  for each row execute function public.core_v2_guard_tenancy(
    'task_id','workflow_tasks','claim_id','evidence_claims');
create trigger core_v2_tenancy before insert or update on public.agent_attempts
  for each row execute function public.core_v2_guard_tenancy(
    'workflow_id','intelligence_workflows','task_id','workflow_tasks');
create trigger core_v2_tenancy before insert or update on public.evidence_claims
  for each row execute function public.core_v2_guard_tenancy(
    'workflow_id','intelligence_workflows','task_id','workflow_tasks',
    'attempt_id','agent_attempts','supersedes_claim_id','evidence_claims');
create trigger core_v2_tenancy before insert or update on public.claim_inputs
  for each row execute function public.core_v2_guard_tenancy(
    'claim_id','evidence_claims','input_claim_id','evidence_claims');
create trigger core_v2_tenancy before insert or update on public.evidence_anchors
  for each row execute function public.core_v2_guard_tenancy(
    'workflow_id','intelligence_workflows','claim_id','evidence_claims',
    'assessment_id','claim_assessments','source_id','workflow_sources','segment_id','source_segments');
create trigger core_v2_tenancy before insert or update on public.claim_assessments
  for each row execute function public.core_v2_guard_tenancy(
    'workflow_id','intelligence_workflows','claim_id','evidence_claims',
    'attempt_id','agent_attempts','task_id','workflow_tasks');
create trigger core_v2_tenancy before insert or update on public.disagreements
  for each row execute function public.core_v2_guard_tenancy(
    'workflow_id','intelligence_workflows','resolution_decision_id','decisions');
create trigger core_v2_tenancy before insert or update on public.disagreement_claims
  for each row execute function public.core_v2_guard_tenancy(
    'disagreement_id','disagreements','claim_id','evidence_claims');
create trigger core_v2_tenancy before insert or update on public.disagreement_follow_ups
  for each row execute function public.core_v2_guard_tenancy(
    'disagreement_id','disagreements','task_id','workflow_tasks');
create trigger core_v2_tenancy before insert or update on public.decisions
  for each row execute function public.core_v2_guard_tenancy(
    'workflow_id','intelligence_workflows','task_id','workflow_tasks',
    'disagreement_id','disagreements','decided_by_attempt_id','agent_attempts',
    'supersedes_decision_id','decisions');
create trigger core_v2_tenancy before insert or update on public.decision_evidence
  for each row execute function public.core_v2_guard_tenancy(
    'decision_id','decisions','claim_id','evidence_claims','anchor_id','evidence_anchors');
create trigger core_v2_tenancy before insert or update on public.decision_actions
  for each row execute function public.core_v2_guard_tenancy('decision_id','decisions');
