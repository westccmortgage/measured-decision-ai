-- 055 · Three readers, side by side.
--
-- The same plan set can now be read by OpenAI, by Claude or by Gemini. A
-- reading is no longer just "the analysis" — it is the answer of a named
-- model, under a named task version, at a named cost. So every reading says
-- who made it, what it consumed, how long it took, and what the model
-- actually returned before this application made anything of it.
--
-- Nothing here replaces anything. A new reading is a new baseline version in
-- state 'review'; the project's active baseline is only ever changed by a
-- person approving one. Two readers on one plan set produce two rows a
-- person can switch between, and neither overwrites the other.

-- What the model returned, verbatim, beside what we parsed out of it. When a
-- takeoff line looks wrong, this is how a person tells a reading mistake from
-- a processing mistake.
alter table public.plan_analysis_chunks
  add column if not exists provider_raw jsonb,
  add column if not exists duration_ms integer,
  -- The model string the provider itself reported, which is not always the
  -- one we asked for.
  add column if not exists model_reported text;

alter table public.plan_analysis_jobs
  add column if not exists provider_raw jsonb;

comment on column public.plan_analysis_chunks.provider_raw is
  'The provider''s answer as it arrived, before parsing. Kept so a person can see what the model read and what the application then did with it.';
comment on column public.plan_analysis_chunks.model_reported is
  'The model string the provider reported for this call, which may differ from the one requested.';

-- A baseline is a reading by somebody. Provider beside model, and the run''s
-- own numbers — usage, duration, cost — with the price list they came from.
-- Cost is null when the model''s published price could not be confirmed or
-- the provider reported no usage. Null is not zero.
alter table public.document_baselines
  add column if not exists provider text,
  add column if not exists analysis_run jsonb not null default '{}'::jsonb;

comment on column public.document_baselines.provider is
  'Which reader produced this baseline: openai, anthropic, google. Null on baselines created before readers could be chosen.';
comment on column public.document_baselines.analysis_run is
  'Provider, model, usage, duration and cost for the reading that produced this baseline. cost_usd is null — never zero — where the tariff is unknown.';

-- Readings of one project, newest first, is the switcher's query.
create index if not exists document_baselines_by_property_version
  on public.document_baselines(property_id, version desc);

-- The ledger already records provider per call; make sure the three readers
-- are spellable there.
alter table public.ai_runs
  drop constraint if exists ai_runs_provider_known;
alter table public.ai_runs
  add constraint ai_runs_provider_known
  check (provider in ('openai', 'anthropic', 'google', 'cloudflare'));
