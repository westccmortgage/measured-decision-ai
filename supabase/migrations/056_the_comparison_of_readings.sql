-- 056 · Which reader read this set better, and on what evidence.
--
-- Three readers have read one plan set. A person now wants an answer to a
-- question the three answers cannot give on their own: who read it better,
-- in which sections, and why. That answer is itself a reading — made by a
-- named model, under a named task version, at a named cost — so it is
-- stored the way every other reading is: separately, beside what it judged,
-- with its own run recorded and nothing overwritten.
--
-- Two things this table refuses to be. It is not an accuracy score: without
-- a control markup checked against the real sheets there is no denominator,
-- and a percentage without one is a number that sounds like evidence. And it
-- is not a decision: the winner does not become the project's baseline, and
-- no row of any answer is merged into a new schedule here.

create table if not exists public.reading_comparisons (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,

  -- The readings compared, in the order they were laid out. Two comparisons
  -- of the same three readings under the same task and the same checker are
  -- one comparison; the fingerprint is what makes reopening free.
  baseline_ids uuid[] not null,
  plan_document_ids uuid[] not null default '{}',
  agent_contract_version text not null default '',
  fingerprint text not null,

  -- Whether the three were asked the same question at all, and what differed
  -- when they were not. A comparison of unequal conditions is still shown —
  -- it is simply never called a comparison of readers.
  comparable boolean not null default false,
  conditions jsonb not null default '{}'::jsonb,

  -- What code found without looking at a drawing: agreements, differences,
  -- positions only one reader has, units that do not match, numbers that do
  -- not follow from their own row.
  mechanical jsonb not null default '{}'::jsonb,

  -- The checker: which reader was asked, which model answered, and what it
  -- said. The three answers reached it as A, B and C in a shuffled order;
  -- blind_map is the only place that order is written down.
  judge_provider text,
  judge_model text,
  judge_model_reported text,
  blind_map jsonb not null default '{}'::jsonb,
  verdict jsonb not null default '{}'::jsonb,

  -- A control markup, when this project has one that matches the plan set.
  -- Where it does not, the result says out loud that it is a reader's
  -- recommendation and not measured accuracy.
  truth jsonb not null default '{}'::jsonb,

  ai_run_id uuid references public.ai_runs(id) on delete set null,
  -- complete · incomplete (a reader failed and was not run again on its own)
  state text not null default 'complete' check (state in ('complete', 'incomplete')),
  incomplete_reason text,

  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

comment on table public.reading_comparisons is
  'One comparison of several readings of one plan set: the mechanical differences, the blinded checker''s verdict, and the conditions under which the readings were made. Never a baseline, never an accuracy score without a control markup.';
comment on column public.reading_comparisons.blind_map is
  'A/B/C to baseline id. The checker was never told which provider wrote which answer; this is where that is kept.';
comment on column public.reading_comparisons.comparable is
  'True only when every reading covered the same documents, at the same enlargement budget, under the same task version.';

create unique index if not exists reading_comparisons_fingerprint
  on public.reading_comparisons(fingerprint);
create index if not exists reading_comparisons_by_property
  on public.reading_comparisons(property_id, created_at desc);

-- A CONTROL MARKUP.
--
-- Positions read off the real sheets by a person, each with the page it is
-- on. This is the only thing that can say what every reader missed. An entry
-- whose count is itself disputed is carried and shown and never scored:
-- settling a disputed reference with a reader's answer would be circular.
create table if not exists public.reading_ground_truth (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  label text not null default '',
  -- Which plan documents this markup was read from. A markup that does not
  -- match the documents a reading covered is not used against that reading.
  source_document_ids uuid[] not null default '{}',
  -- How it was checked against the real file, so a markup can never quietly
  -- belong to a different revision of the drawings.
  verified_against jsonb not null default '{}'::jsonb,
  entries jsonb not null default '[]'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.reading_ground_truth is
  'Positions marked on the real sheets by a person, with the page each was found on. Entries flagged disputed are shown and never scored.';
comment on column public.reading_ground_truth.verified_against is
  'What this markup was checked against — the document id, its byte size and page count — so it cannot be applied to a different revision of the drawings.';

create index if not exists reading_ground_truth_by_property
  on public.reading_ground_truth(property_id, created_at desc);

-- The checker's call is bought like any other, so the ledger must be able to
-- spell it. Without this the Cost Guard could not claim it, and an unclaimed
-- call is a call nobody can stop from being bought twice.
alter table public.ai_runs drop constraint if exists ai_runs_process_key_check;
alter table public.ai_runs
  add constraint ai_runs_process_key_check
  check (process_key in (
    'plan-analyze', 'spatial-analyze', 'document-classify',
    'document-evidence', 'field-quality-check', 'project-search', 'compare-readings'));

alter table public.reading_comparisons enable row level security;
alter table public.reading_ground_truth enable row level security;

drop policy if exists reading_comparisons_read on public.reading_comparisons;
create policy reading_comparisons_read on public.reading_comparisons
  for select using (public.is_org_member(organization_id));

drop policy if exists reading_ground_truth_read on public.reading_ground_truth;
create policy reading_ground_truth_read on public.reading_ground_truth
  for select using (public.is_org_member(organization_id));

-- Writing either of these is the comparison worker's job, under the service
-- role. No browser writes a verdict or a control markup directly.
