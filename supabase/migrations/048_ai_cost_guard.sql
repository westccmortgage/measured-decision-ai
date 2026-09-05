-- AI COST GUARD v1
--
-- Two facts nobody could establish before this file existed:
--   1. how many times we actually paid OpenAI, and for what;
--   2. whether a result already on the screen was bought with exactly the
--      inputs the person is about to buy again.
--
-- Pressing Analyze twice bought the reading twice. The check that should have
-- stopped it lived in the browser, and a browser cannot stop a second tab, a
-- double click that fires before the first render, or two people on the same
-- project. So the guard lives here, where a unique index can refuse.
--
-- What this is NOT: a billing system, a budget, a monthly limit, or a price
-- list. Nothing in this file knows what a token costs. It counts runs and
-- records the usage the provider actually returned; where money cannot be
-- stated honestly it says so and stops.

-- ─────────────────────────────────────────────── the ledger
-- One row per ACTUAL provider call. A reused result writes no row: it did not
-- cost anything, and a ledger that counts things nobody paid for is a ledger
-- nobody can trust.
create table if not exists public.ai_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- Not every process has a project. document-classify runs against a
  -- document that may be filed before the project exists.
  property_id uuid references public.properties(id) on delete set null,
  process_key text not null check (process_key in (
    'plan-analyze', 'spatial-analyze', 'document-classify',
    'document-evidence', 'field-quality-check')),
  provider text not null default 'openai',
  -- Which wire the call went out on. The same model billed through the
  -- Cloudflare gateway and billed direct are two different invoices, and a
  -- ledger that cannot tell them apart cannot be reconciled against either.
  transport text,
  model text not null,
  contract_version text,
  input_fingerprint text not null,
  -- The job this call belongs to, in whichever table owns it. Deliberately
  -- untyped: three job tables already exist and this file replaces none of
  -- them.
  job_table text,
  job_id uuid,
  state text not null default 'running'
    check (state in ('running', 'succeeded', 'failed')),
  -- Whether a person had to say "yes, run it again" to buy this one.
  forced boolean not null default false,
  input_tokens integer,
  output_tokens integer,
  total_tokens integer,
  -- Everything else the provider returned about usage, verbatim. Providers
  -- add fields; a fixed set of columns silently drops them.
  usage_detail jsonb not null default '{}'::jsonb,
  -- False when the provider returned no usage at all, which happens and must
  -- never fail a workflow.
  usage_available boolean not null default false,
  -- Nullable on purpose and paired with its source. A number here without a
  -- named, dated price list is a guess wearing a dollar sign.
  estimated_cost_micros bigint,
  pricing_source text,
  pricing_source_dated_on date,
  error_code text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  duration_ms integer,
  created_at timestamptz not null default now()
);

comment on table public.ai_runs is
  'One row per actual paid provider call. A reused result writes no row. Money is nullable and always carries the price list it came from.';
comment on column public.ai_runs.estimated_cost_micros is
  'Null unless a verified pricing source is configured. An estimate is never presented as a bill.';

-- THE GUARD. One running call per fingerprint, enforced by the database.
-- Partial, so a finished run never blocks a deliberate re-analysis.
create unique index if not exists ai_runs_one_in_flight
  on public.ai_runs(organization_id, process_key, input_fingerprint)
  where state = 'running';

create index if not exists ai_runs_by_project
  on public.ai_runs(organization_id, property_id, created_at desc);
create index if not exists ai_runs_by_fingerprint
  on public.ai_runs(organization_id, process_key, input_fingerprint, created_at desc);

alter table public.ai_runs enable row level security;

-- Readable by the organization, written only by the workers through the
-- functions below.
drop policy if exists ai_runs_read on public.ai_runs;
create policy ai_runs_read on public.ai_runs for select
using (public.is_org_member(organization_id));

revoke all on public.ai_runs from anon, authenticated;
grant select on public.ai_runs to authenticated;

-- ─────────────────────────────────────────────── claiming a run
-- The whole point of this file. Returns one of three verdicts:
--
--   RUNNING  — an identical call is in flight right now. Do not call the
--              provider. Wait for the one that is already running.
--   REUSED   — an identical call already succeeded. Do not call the provider.
--              The result on the screen was bought with exactly these inputs.
--   CLAIMED  — nothing identical exists. This caller now owns the right to
--              make one provider call, and holds the in-flight row proving it.
--
-- The refusal is the unique index, not an if-statement: two callers racing
-- both attempt the insert and exactly one of them wins.
create or replace function public.claim_ai_run(
  p_organization_id uuid,
  p_property_id uuid,
  p_process_key text,
  p_model text,
  p_contract_version text,
  p_input_fingerprint text,
  p_job_table text default null,
  p_job_id uuid default null,
  p_transport text default null,
  p_force boolean default false
)
returns table (verdict text, run_id uuid, previous_run_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  existing_running uuid;
  existing_done uuid;
  claimed uuid;
begin
  if p_organization_id is null or p_process_key is null or p_input_fingerprint is null or p_model is null then
    raise exception 'claim_ai_run requires organization, process, model and fingerprint';
  end if;

  -- In flight wins over everything, forced included: forcing means "buy
  -- another reading", not "buy two of the same reading at once".
  select id into existing_running from public.ai_runs
   where organization_id = p_organization_id
     and process_key = p_process_key
     and input_fingerprint = p_input_fingerprint
     and state = 'running'
   limit 1;
  if existing_running is not null then
    return query select 'RUNNING'::text, null::uuid, existing_running;
    return;
  end if;

  if not p_force then
    select id into existing_done from public.ai_runs
     where organization_id = p_organization_id
       and process_key = p_process_key
       and input_fingerprint = p_input_fingerprint
       and state = 'succeeded'
     order by created_at desc
     limit 1;
    if existing_done is not null then
      return query select 'REUSED'::text, null::uuid, existing_done;
      return;
    end if;
  end if;

  begin
    insert into public.ai_runs (
      organization_id, property_id, process_key, model, contract_version,
      input_fingerprint, job_table, job_id, transport, forced, state
    ) values (
      p_organization_id, p_property_id, p_process_key, p_model, p_contract_version,
      p_input_fingerprint, p_job_table, p_job_id, p_transport, coalesce(p_force, false), 'running'
    ) returning id into claimed;
  exception when unique_violation then
    -- The other caller in the race won between the select above and this
    -- insert. That is the case this whole file exists for.
    select id into existing_running from public.ai_runs
     where organization_id = p_organization_id
       and process_key = p_process_key
       and input_fingerprint = p_input_fingerprint
       and state = 'running'
     limit 1;
    return query select 'RUNNING'::text, null::uuid, existing_running;
    return;
  end;

  return query select 'CLAIMED'::text, claimed, null::uuid;
end;
$$;

-- ─────────────────────────────────────────────── closing a run
-- Usage is written exactly as the provider returned it. A provider that
-- returns nothing leaves usage_available false and the workflow unharmed —
-- losing the reading because the token count was missing would be the worst
-- possible trade.
create or replace function public.finish_ai_run(
  p_run_id uuid,
  p_state text,
  p_usage jsonb default '{}'::jsonb,
  p_error_code text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  started timestamptz;
  input_count integer;
  output_count integer;
  total_count integer;
  has_usage boolean;
begin
  if p_state not in ('succeeded', 'failed') then
    raise exception 'finish_ai_run state must be succeeded or failed';
  end if;
  select started_at into started from public.ai_runs where id = p_run_id;
  if started is null then return; end if;

  input_count := nullif(p_usage ->> 'input_tokens', '')::integer;
  output_count := nullif(p_usage ->> 'output_tokens', '')::integer;
  total_count := nullif(p_usage ->> 'total_tokens', '')::integer;
  has_usage := input_count is not null or output_count is not null or total_count is not null;

  update public.ai_runs set
    state = p_state,
    usage_detail = coalesce(p_usage, '{}'::jsonb),
    input_tokens = input_count,
    output_tokens = output_count,
    total_tokens = coalesce(total_count, coalesce(input_count, 0) + coalesce(output_count, 0)),
    usage_available = has_usage,
    error_code = p_error_code,
    finished_at = now(),
    duration_ms = greatest(0, (extract(epoch from (now() - started)) * 1000)::integer)
  where id = p_run_id;
end;
$$;

-- ─────────────────────────────────────────────── what the screen shows
-- Runs and tokens, and money only when a price list says so. With no pricing
-- source configured this returns null cost and the screen says "Cost
-- unavailable" — which is the true statement.
create or replace function public.ai_usage_summary(p_property_id uuid)
returns table (
  runs bigint,
  succeeded bigint,
  failed bigint,
  total_tokens bigint,
  usage_missing bigint,
  estimated_cost_micros bigint,
  pricing_source text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    count(*)::bigint,
    count(*) filter (where r.state = 'succeeded')::bigint,
    count(*) filter (where r.state = 'failed')::bigint,
    coalesce(sum(r.total_tokens), 0)::bigint,
    count(*) filter (where not r.usage_available)::bigint,
    -- Null unless every counted run carries a cost. A partial sum presented
    -- as a total is the dishonest number this whole file refuses.
    case when count(*) filter (where r.estimated_cost_micros is null) = 0
         then sum(r.estimated_cost_micros)::bigint
         else null end,
    max(r.pricing_source)
  from public.ai_runs r
  join public.properties p on p.id = r.property_id
  where r.property_id = p_property_id
    and public.is_org_member(p.organization_id);
$$;

-- ─────────────────────────────────────────────── is the result still current
-- What the Analyze button asks before it offers to spend anything.
create or replace function public.ai_run_state_for(
  p_organization_id uuid,
  p_process_key text,
  p_input_fingerprint text
)
returns table (verdict text, run_id uuid, finished_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select verdict, id, finished_at from (
    select 'RUNNING'::text as verdict, r.id, r.finished_at, 0 as rank
      from public.ai_runs r
     where r.organization_id = p_organization_id
       and r.process_key = p_process_key
       and r.input_fingerprint = p_input_fingerprint
       and r.state = 'running'
       and public.is_org_member(r.organization_id)
    union all
    select 'REUSED'::text, r.id, r.finished_at, 1
      from public.ai_runs r
     where r.organization_id = p_organization_id
       and r.process_key = p_process_key
       and r.input_fingerprint = p_input_fingerprint
       and r.state = 'succeeded'
       and public.is_org_member(r.organization_id)
  ) ranked
  order by rank, finished_at desc nulls last
  limit 1;
$$;

-- FROM PUBLIC, not merely from anon and authenticated.
--
-- A function is granted to PUBLIC by default, and revoking from the two named
-- roles leaves that default standing — so a signed-in person could still call
-- a security-definer function that writes the ledger. Caught by the invariant
-- below, which is why it is written as a refusal rather than a comment.
revoke all on function public.claim_ai_run(uuid, uuid, text, text, text, text, text, uuid, text, boolean) from public, anon, authenticated;
revoke all on function public.finish_ai_run(uuid, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.ai_usage_summary(uuid) to authenticated;
grant execute on function public.ai_run_state_for(uuid, text, text) to authenticated;

-- ─────────────────────────────────────────────── the background reader
-- plan-analyze creates a background response and retrieves it minutes later,
-- so the run it claimed has to be findable again at retrieval. One nullable
-- column on the rows that already track the provider job — the job tables
-- themselves are unchanged in every other respect.
alter table public.plan_analysis_jobs
  add column if not exists ai_run_id uuid references public.ai_runs(id) on delete set null;
alter table public.plan_analysis_chunks
  add column if not exists ai_run_id uuid references public.ai_runs(id) on delete set null;

comment on column public.plan_analysis_jobs.ai_run_id is
  'The ledger row for the paid call this job made, so usage can be recorded when the background response is retrieved.';
