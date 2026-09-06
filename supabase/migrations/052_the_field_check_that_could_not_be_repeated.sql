-- 052 · The field check that could not be repeated.
--
-- A field quality check is dispatched server-to-server the moment a worker
-- submits an assignment. Nobody presses anything, and nobody reads the
-- answer: the dispatch is a fetch whose body is thrown away. So when the
-- ledger refuses the check — an identical one already in flight, an identical
-- one already answered, or an earlier attempt whose outcome is unknown — the
-- row was already marked 'processing' and stayed there forever, and the
-- assignment sat in "AI checking" until the end of time.
--
-- Two additions, both small:
--
--   1. A state for the case the row never had a word for. 'outcome_unknown'
--      means: an attempt at this exact check went out and we cannot say what
--      happened to it. It is not 'failed', because failed is free to retry
--      and this is not.
--   2. The ledger row it is unknown ABOUT, so the field screen can offer the
--      same single-use confirmation every other screen offers, against the
--      same run.
--
-- What this file does not do: return anything to a queue. An unknown check
-- is repeated only when a reviewer says so, through the existing
-- confirmation, and never by the dispatch that created it.

alter table public.field_quality_checks drop constraint if exists field_quality_checks_state_check;
alter table public.field_quality_checks add constraint field_quality_checks_state_check
  check (state in ('queued', 'processing', 'passed', 'retake', 'needs_review', 'failed', 'outcome_unknown'));

alter table public.field_quality_checks
  add column if not exists ai_run_id uuid references public.ai_runs(id) on delete set null;

comment on column public.field_quality_checks.state is
  'queued · processing · passed · retake · needs_review · failed (free to repeat) · outcome_unknown (may have run and been billed; a reviewer must confirm any repeat).';
comment on column public.field_quality_checks.ai_run_id is
  'The ledger row for the paid call this check made or may have made — what a reviewer authorises a repeat against.';
