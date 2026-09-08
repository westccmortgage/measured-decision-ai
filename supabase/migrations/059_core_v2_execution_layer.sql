-- ═══════════════════════════════════════════════════════════════════════════
-- 059 · WHAT AN EXECUTION COSTS, AND WHAT IT SAID IT WAS
--
-- Migration 058 holds the chain a decision hangs from. It says nothing about
-- money, because the kernel that reasons over evidence has no business
-- knowing what an answer cost. The runtime does, and this is where the
-- runtime's two durable needs live:
--
--   1. what the thing that answered reported about itself — a request id, the
--      model it says it is, the tokens it counted, why it stopped, how long it
--      took, and the answer exactly as it arrived. A cost dispute, a parsing
--      bug and a truncated reading are all settled from these and from
--      nothing else;
--
--   2. a reservation taken BEFORE anything is sent, for the most that attempt
--      could possibly cost, released only when it is known that nothing is
--      still running. An engine that reserves the expected cost and discovers
--      the real one afterwards has already spent the difference.
--
-- Nothing here names a provider. A provider is a runtime concern; what the
-- record keeps is what was reported, whoever reported it.
--
-- 058 is not rewritten. This migration only adds.
-- ═══════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────── 1 · what the answer said about itself

alter table public.agent_attempts
  add column if not exists provider_stop_reason text,
  add column if not exists provider_duration_ms integer,
  add column if not exists provider_response jsonb;

alter table public.agent_attempts
  drop constraint if exists agent_attempts_duration_not_negative;
alter table public.agent_attempts
  add constraint agent_attempts_duration_not_negative
  check (provider_duration_ms is null or provider_duration_ms >= 0);

comment on column public.agent_attempts.provider_stop_reason is
  'Why the answering system stopped, in its own word. An output ceiling reported here is what tells a reader that a short answer was cut off rather than complete.';
comment on column public.agent_attempts.provider_duration_ms is
  'How long the answering system took, as the executor measured it.';
comment on column public.agent_attempts.provider_response is
  'The answer exactly as it arrived, before anything read it. Kept beside raw_result, which is what the executor made of it: a run that disagrees with its own parse needs both.';

-- These three are write-once like every other executor fact. 058's attempt
-- guard keeps that rule from a list inside itself; rather than restate that
-- whole function here — and risk losing one of its other rules to a copy —
-- this is a second guard that speaks only for the three new columns. 058 is
-- left exactly as it was, including the rule that an attempt is submitted
-- only through the door that proves the lease.
create or replace function public.core_v2_guard_attempt_provider_facts() returns trigger
language plpgsql as $$
declare written text;
begin
  select f into written from unnest(array[
    'provider_stop_reason','provider_duration_ms','provider_response']) as t(f)
   where (to_jsonb(old) -> t.f) is not null
     and (to_jsonb(old) -> t.f) <> 'null'::jsonb
     and (to_jsonb(new) -> t.f) is distinct from (to_jsonb(old) -> t.f)
   limit 1;
  if written is not null then
    raise exception 'core_v2: attempt % already recorded % — an executor fact is written once', old.id, written
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists agent_attempts_provider_facts_written_once on public.agent_attempts;
create trigger agent_attempts_provider_facts_written_once
  before update on public.agent_attempts
  for each row execute function public.core_v2_guard_attempt_provider_facts();

-- ──────────────────────────────────────── 2 · what a workflow is allowed to spend
--
-- One row per workflow, written when the run is authorised and never widened
-- by the engine. The structural budget — how many tasks, how deep, how many
-- rounds — stays where 058 put it, on intelligence_workflows.budget. This is
-- the money and the clock, which only the runtime spends.
create table if not exists public.workflow_cost_budgets (
  workflow_id uuid primary key references public.intelligence_workflows(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  currency text not null default 'USD' check (currency = upper(currency) and length(currency) = 3),
  -- The most this whole workflow may cost. Zero is a real answer: it means
  -- nothing that costs anything may be sent, which is what every test runs at.
  authorized_maximum numeric(14,6) not null check (authorized_maximum >= 0),
  -- The most any single attempt may cost. An attempt asking for more than
  -- this is refused before it is sent, however much the workflow has left.
  maximum_per_attempt numeric(14,6) not null check (maximum_per_attempt >= 0),
  -- Held against attempts that may still be running, and spent by attempts
  -- that finished. Both only ever move through the doors below.
  reserved numeric(14,6) not null default 0 check (reserved >= 0),
  settled numeric(14,6) not null default 0 check (settled >= 0),
  -- Ceilings the runtime must not cross whatever the money says.
  maximum_input_tokens bigint check (maximum_input_tokens is null or maximum_input_tokens >= 0),
  maximum_output_tokens bigint check (maximum_output_tokens is null or maximum_output_tokens >= 0),
  maximum_attempts integer check (maximum_attempts is null or maximum_attempts >= 0),
  maximum_concurrent_attempts integer check (maximum_concurrent_attempts is null or maximum_concurrent_attempts > 0),
  reserved_input_tokens bigint not null default 0 check (reserved_input_tokens >= 0),
  reserved_output_tokens bigint not null default 0 check (reserved_output_tokens >= 0),
  -- After this moment nothing further is sent. A run that needs longer is a
  -- run somebody authorises again.
  wall_clock_deadline timestamptz,
  -- Why the runtime stopped spending, once it has.
  stopped_reason text,
  stopped_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- What is HELD never exceeds what was authorised: nothing may be sent that
  -- the authorisation does not cover, and the reservation door proves the
  -- stronger thing — held plus spent plus the new hold stays inside it.
  --
  -- What is SPENT is deliberately not constrained. A provider can bill more
  -- than it was asked to, and a record that cannot state an overspend that
  -- actually happened is worse than useless: it would refuse the settlement
  -- and leave no trace of the money at all. The ceiling is a gate on what
  -- goes out, not a claim about what came back.
  constraint workflow_cost_budgets_holds_within_authorization
    check (reserved <= authorized_maximum)
);

comment on table public.workflow_cost_budgets is
  'What one workflow is authorised to spend, what is held against work that may still be running, and what has been spent. Nothing is sent without a reservation taken from here first.';
comment on column public.workflow_cost_budgets.authorized_maximum is
  'Operator-supplied. The engine never raises it, and a workflow with no row here may send nothing that costs anything.';

create index if not exists workflow_cost_budgets_by_org on public.workflow_cost_budgets(organization_id);

-- ─────────────────────────── 3 · what one attempt is holding, and what it spent
create table if not exists public.attempt_cost_reservations (
  attempt_id uuid primary key references public.agent_attempts(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  workflow_id uuid not null references public.intelligence_workflows(id) on delete cascade,
  state text not null default 'reserved' check (state in ('reserved','settled','released')),
  -- The most this attempt could cost, priced from the ceilings it was sent
  -- with — never an expectation. The difference between the two is exactly
  -- the money an optimistic engine spends without meaning to.
  reserved_cost numeric(14,6) not null check (reserved_cost >= 0),
  reserved_input_tokens bigint not null default 0 check (reserved_input_tokens >= 0),
  reserved_output_tokens bigint not null default 0 check (reserved_output_tokens >= 0),
  -- What it actually cost, priced from what the answering system reported.
  settled_cost numeric(14,6) check (settled_cost is null or settled_cost >= 0),
  usage jsonb,
  price_basis jsonb not null default '{}'::jsonb,
  release_reason text,
  reserved_at timestamptz not null default now(),
  settled_at timestamptz,
  released_at timestamptz,
  constraint attempt_cost_reservations_settled_has_cost
    check (state <> 'settled' or settled_cost is not null),
  constraint attempt_cost_reservations_released_says_why
    check (state <> 'released' or release_reason is not null)
);

comment on table public.attempt_cost_reservations is
  'One reservation per attempt, taken before anything is sent and cleared only when it is known that nothing is still running. An attempt whose outcome nobody knows keeps holding its reservation, because the money may already be gone.';

create index if not exists attempt_cost_reservations_open
  on public.attempt_cost_reservations(workflow_id) where state = 'reserved';

-- ───────────────────────────────────────────────────────── 4 · the doors
--
-- Reserve before sending. Under the budget row's own lock, so two dispatchers
-- reserving at once cannot both find room that only one of them has.
create or replace function public.core_v2_reserve_attempt_cost(
  p_attempt_id uuid,
  p_maximum_cost numeric,
  p_input_tokens bigint default 0,
  p_output_tokens bigint default 0,
  p_price_basis jsonb default '{}'::jsonb
) returns public.attempt_cost_reservations
language plpgsql security definer set search_path = public as $$
declare
  attempt public.agent_attempts;
  budget public.workflow_cost_budgets;
  existing public.attempt_cost_reservations;
  open_count integer;
  attempt_count integer;
  row public.attempt_cost_reservations;
begin
  if p_maximum_cost is null or p_maximum_cost < 0 then
    raise exception 'core_v2: reservation refused: a maximum cost is a number that is not negative';
  end if;
  select * into attempt from public.agent_attempts where id = p_attempt_id;
  if not found then
    raise exception 'core_v2: reservation refused: no attempt %', p_attempt_id;
  end if;
  if attempt.state <> 'prepared' then
    raise exception 'core_v2: reservation refused: attempt % is %, and a reservation is taken before anything is sent', attempt.id, attempt.state;
  end if;

  -- Asking twice for one attempt is the same reservation, not a second one.
  select * into existing from public.attempt_cost_reservations where attempt_id = p_attempt_id;
  if found then
    if existing.state <> 'reserved' then
      raise exception 'core_v2: reservation refused: attempt % was already %', attempt.id, existing.state;
    end if;
    return existing;
  end if;

  select * into budget from public.workflow_cost_budgets
   where workflow_id = attempt.workflow_id for update;
  if not found then
    raise exception 'core_v2: reservation refused: workflow % has no authorised budget', attempt.workflow_id;
  end if;
  if budget.stopped_at is not null then
    raise exception 'core_v2: reservation refused: spending on workflow % stopped — %', attempt.workflow_id, coalesce(budget.stopped_reason, 'no reason recorded');
  end if;
  -- The deadline is the durable fact; a refusal recorded here would be rolled
  -- back by the very raise that follows it, which is a record that lies. The
  -- caller that sees this refusal calls core_v2_stop_workflow_spending, whose
  -- write survives because nothing aborts it.
  if budget.wall_clock_deadline is not null and now() > budget.wall_clock_deadline then
    raise exception 'core_v2: reservation refused: the authorised time for workflow % ran out', attempt.workflow_id;
  end if;
  if p_maximum_cost > budget.maximum_per_attempt then
    raise exception 'core_v2: reservation refused: % is more than the % this workflow allows one attempt', p_maximum_cost, budget.maximum_per_attempt;
  end if;
  if budget.reserved + budget.settled + p_maximum_cost > budget.authorized_maximum then
    raise exception 'core_v2: reservation refused: % would take workflow % past the % it was authorised (% held, % spent)',
      p_maximum_cost, attempt.workflow_id, budget.authorized_maximum, budget.reserved, budget.settled;
  end if;
  if budget.maximum_input_tokens is not null
     and budget.reserved_input_tokens + coalesce(p_input_tokens, 0) > budget.maximum_input_tokens then
    raise exception 'core_v2: reservation refused: workflow % is at its ceiling of % input tokens', attempt.workflow_id, budget.maximum_input_tokens;
  end if;
  if budget.maximum_output_tokens is not null
     and budget.reserved_output_tokens + coalesce(p_output_tokens, 0) > budget.maximum_output_tokens then
    raise exception 'core_v2: reservation refused: workflow % is at its ceiling of % output tokens', attempt.workflow_id, budget.maximum_output_tokens;
  end if;
  if budget.maximum_concurrent_attempts is not null then
    select count(*) into open_count from public.attempt_cost_reservations
     where workflow_id = attempt.workflow_id and state = 'reserved';
    if open_count >= budget.maximum_concurrent_attempts then
      raise exception 'core_v2: reservation refused: workflow % already has % attempts in flight', attempt.workflow_id, open_count;
    end if;
  end if;
  if budget.maximum_attempts is not null then
    select count(*) into attempt_count from public.attempt_cost_reservations
     where workflow_id = attempt.workflow_id;
    if attempt_count >= budget.maximum_attempts then
      raise exception 'core_v2: reservation refused: workflow % has used its % authorised attempts', attempt.workflow_id, budget.maximum_attempts;
    end if;
  end if;

  insert into public.attempt_cost_reservations(
    attempt_id, organization_id, workflow_id, reserved_cost,
    reserved_input_tokens, reserved_output_tokens, price_basis)
  values (p_attempt_id, attempt.organization_id, attempt.workflow_id, p_maximum_cost,
          coalesce(p_input_tokens, 0), coalesce(p_output_tokens, 0), coalesce(p_price_basis, '{}'::jsonb))
  returning * into row;

  update public.workflow_cost_budgets
     set reserved = reserved + p_maximum_cost,
         reserved_input_tokens = reserved_input_tokens + coalesce(p_input_tokens, 0),
         reserved_output_tokens = reserved_output_tokens + coalesce(p_output_tokens, 0),
         updated_at = now()
   where workflow_id = attempt.workflow_id;
  return row;
end $$;

comment on function public.core_v2_reserve_attempt_cost(uuid, numeric, bigint, bigint, jsonb) is
  'The only way an attempt is allowed to be sent. Takes the budget row''s lock, so two dispatchers cannot both find the same room, and holds the most the attempt could cost rather than the least.';

-- What it really cost, once the answering system has said. The hold comes off
-- and the spend goes on, in one move.
create or replace function public.core_v2_settle_attempt_cost(
  p_attempt_id uuid, p_actual_cost numeric, p_usage jsonb default '{}'::jsonb
) returns public.attempt_cost_reservations
language plpgsql security definer set search_path = public as $$
declare
  reservation public.attempt_cost_reservations;
  budget public.workflow_cost_budgets;
  row public.attempt_cost_reservations;
begin
  if p_actual_cost is null or p_actual_cost < 0 then
    raise exception 'core_v2: settlement refused: an actual cost is a number that is not negative';
  end if;
  select * into reservation from public.attempt_cost_reservations where attempt_id = p_attempt_id for update;
  if not found then
    raise exception 'core_v2: settlement refused: attempt % reserved nothing', p_attempt_id;
  end if;
  if reservation.state = 'settled' then
    return reservation;
  end if;
  if reservation.state <> 'reserved' then
    raise exception 'core_v2: settlement refused: attempt % was %', p_attempt_id, reservation.state;
  end if;
  -- An answer that cost more than was held is still recorded at what it cost;
  -- the record is what was spent, not what was permitted. The budget's own
  -- ceiling then refuses the next reservation, which is where a run stops.
  select * into budget from public.workflow_cost_budgets where workflow_id = reservation.workflow_id for update;
  update public.workflow_cost_budgets
     set reserved = greatest(0, reserved - reservation.reserved_cost),
         settled = settled + p_actual_cost,
         reserved_input_tokens = greatest(0, reserved_input_tokens - reservation.reserved_input_tokens),
         reserved_output_tokens = greatest(0, reserved_output_tokens - reservation.reserved_output_tokens),
         stopped_reason = case when settled + p_actual_cost >= authorized_maximum and stopped_at is null
                               then 'the authorised amount for this workflow is spent' else stopped_reason end,
         stopped_at = case when settled + p_actual_cost >= authorized_maximum and stopped_at is null
                           then now() else stopped_at end,
         updated_at = now()
   where workflow_id = reservation.workflow_id;

  update public.attempt_cost_reservations
     set state = 'settled', settled_cost = p_actual_cost, usage = coalesce(p_usage, '{}'::jsonb), settled_at = now()
   where attempt_id = p_attempt_id
  returning * into row;
  return row;
end $$;

comment on function public.core_v2_settle_attempt_cost(uuid, numeric, jsonb) is
  'What the attempt actually cost, from what the answering system reported. Recorded even when it exceeds what was held: the record is what was spent.';

-- Give the hold back — only when it is known that nothing is still running.
-- An attempt that reached a provider, or whose outcome nobody knows, keeps
-- holding, because the money may already be gone.
create or replace function public.core_v2_release_attempt_cost(
  p_attempt_id uuid, p_reason text
) returns public.attempt_cost_reservations
language plpgsql security definer set search_path = public as $$
declare
  reservation public.attempt_cost_reservations;
  attempt public.agent_attempts;
  row public.attempt_cost_reservations;
begin
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'core_v2: release refused: a release says why';
  end if;
  select * into reservation from public.attempt_cost_reservations where attempt_id = p_attempt_id for update;
  if not found then
    raise exception 'core_v2: release refused: attempt % reserved nothing', p_attempt_id;
  end if;
  if reservation.state = 'released' then
    return reservation;
  end if;
  if reservation.state <> 'reserved' then
    raise exception 'core_v2: release refused: attempt % was %', p_attempt_id, reservation.state;
  end if;
  select * into attempt from public.agent_attempts where id = p_attempt_id;
  if attempt.state = 'outcome_unknown' and attempt.reconciliation_outcome is null then
    raise exception 'core_v2: release refused: nobody knows what became of attempt % — the hold stands until somebody does', p_attempt_id;
  end if;
  if public.core_v2_attempt_submitted(attempt.state) and attempt.reconciliation_outcome is distinct from 'never_started' then
    raise exception 'core_v2: release refused: attempt % was sent — it is settled at what it cost, not released', p_attempt_id;
  end if;

  update public.workflow_cost_budgets
     set reserved = greatest(0, reserved - reservation.reserved_cost),
         reserved_input_tokens = greatest(0, reserved_input_tokens - reservation.reserved_input_tokens),
         reserved_output_tokens = greatest(0, reserved_output_tokens - reservation.reserved_output_tokens),
         updated_at = now()
   where workflow_id = reservation.workflow_id;
  update public.attempt_cost_reservations
     set state = 'released', release_reason = p_reason, released_at = now()
   where attempt_id = p_attempt_id
  returning * into row;
  return row;
end $$;

comment on function public.core_v2_release_attempt_cost(uuid, text) is
  'The hold comes off only when nothing can still be running: an attempt that was never sent, or one a person or an executor has reconciled as never started.';

-- Authorise a workflow to spend, before anything is dispatched for it. Every
-- write to these tables goes through a door, including the first one: the
-- table is revoked from everybody, so without this a deployed service role
-- could read a budget and never create one.
create or replace function public.core_v2_authorize_workflow_spending(
  p_workflow_id uuid,
  p_authorized_maximum numeric,
  p_maximum_per_attempt numeric,
  p_currency text default 'USD',
  p_maximum_input_tokens bigint default null,
  p_maximum_output_tokens bigint default null,
  p_maximum_attempts integer default null,
  p_maximum_concurrent_attempts integer default null,
  p_wall_clock_deadline timestamptz default null
) returns public.workflow_cost_budgets
language plpgsql security definer set search_path = public as $$
declare
  wf public.intelligence_workflows;
  row public.workflow_cost_budgets;
begin
  select * into wf from public.intelligence_workflows where id = p_workflow_id;
  if not found then
    raise exception 'core_v2: no workflow % to authorise', p_workflow_id;
  end if;
  if p_authorized_maximum is null or p_authorized_maximum < 0
     or p_maximum_per_attempt is null or p_maximum_per_attempt < 0 then
    raise exception 'core_v2: an authorisation is an amount that is not negative';
  end if;
  -- Authorising twice is the same authorisation. Raising a ceiling is a
  -- person's decision made again, not a retry, so it is not done here.
  select * into row from public.workflow_cost_budgets where workflow_id = p_workflow_id;
  if found then
    if row.authorized_maximum <> p_authorized_maximum or row.maximum_per_attempt <> p_maximum_per_attempt then
      raise exception 'core_v2: workflow % is already authorised for % — a different amount is a new authorisation by a person', p_workflow_id, row.authorized_maximum;
    end if;
    return row;
  end if;
  insert into public.workflow_cost_budgets(
    workflow_id, organization_id, currency, authorized_maximum, maximum_per_attempt,
    maximum_input_tokens, maximum_output_tokens, maximum_attempts, maximum_concurrent_attempts, wall_clock_deadline)
  values (p_workflow_id, wf.organization_id, upper(coalesce(p_currency, 'USD')), p_authorized_maximum, p_maximum_per_attempt,
          p_maximum_input_tokens, p_maximum_output_tokens, p_maximum_attempts, p_maximum_concurrent_attempts, p_wall_clock_deadline)
  returning * into row;
  perform public.core_v2_audit(wf.organization_id, 'core_v2.workflow.spending_authorized', 'intelligence_workflow',
    p_workflow_id::text, jsonb_build_object('authorized_maximum', p_authorized_maximum, 'currency', row.currency,
      'maximum_per_attempt', p_maximum_per_attempt));
  return row;
end $$;

comment on function public.core_v2_authorize_workflow_spending(uuid, numeric, numeric, text, bigint, bigint, integer, integer, timestamptz) is
  'The only way a workflow comes to have a budget at all. A workflow with no row here may send nothing that costs anything.';

-- The workflows a restarted dispatcher must look at even though the ordinary
-- resumable list passes over them: one whose cancellation was asked for while
-- nobody held it, and one that finished holding an attempt whose outcome
-- nobody ever established. Both need a dispatcher to come back to them.
create or replace function public.core_v2_cancelling_workflows(p_limit integer default 20)
returns setof uuid language sql stable security definer set search_path = public as $$
  select w.id
    from public.intelligence_workflows w
   where w.cancel_requested_at is not null
     and w.state in ('created','queued','planning','running','needs_attention','ready_for_decision','deciding')
   order by w.cancel_requested_at
   limit greatest(1, coalesce(p_limit, 20));
$$;

create or replace function public.core_v2_unreconciled_workflows(p_limit integer default 20)
returns setof uuid language sql stable security definer set search_path = public as $$
  select distinct a.workflow_id
    from public.agent_attempts a
   where a.state = 'outcome_unknown'
     and a.reconciliation_outcome is null
   limit greatest(1, coalesce(p_limit, 20));
$$;

comment on function public.core_v2_unreconciled_workflows(integer) is
  'Workflows holding an attempt whose outcome nobody established. Their money is still held, so a dispatcher comes back to them however finished they look.';

-- Stop spending on a workflow, and say why. Idempotent: the first reason stands.
create or replace function public.core_v2_stop_workflow_spending(
  p_workflow_id uuid, p_reason text
) returns public.workflow_cost_budgets
language plpgsql security definer set search_path = public as $$
declare row public.workflow_cost_budgets;
begin
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'core_v2: a spending stop says why';
  end if;
  update public.workflow_cost_budgets
     set stopped_reason = coalesce(stopped_reason, p_reason),
         stopped_at = coalesce(stopped_at, now()),
         updated_at = now()
   where workflow_id = p_workflow_id
  returning * into row;
  if not found then
    raise exception 'core_v2: workflow % has no authorised budget to stop', p_workflow_id;
  end if;
  return row;
end $$;

-- ───────────────────────────────── 5 · the dispatcher's door onto the outbox
--
-- 058's core_v2_claim_outbox claims a command a caller already knows about.
-- A dispatcher does not know: it asks what is waiting. Doing the finding and
-- the claiming in one statement, under SKIP LOCKED, is what lets several
-- dispatchers run without two of them ever starting one workflow.
create or replace function public.core_v2_claim_next_workflow(p_dispatcher text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  candidate uuid;
  claimed public.workflow_outbox;
begin
  if p_dispatcher is null or btrim(p_dispatcher) = '' then
    raise exception 'core_v2: a dispatcher claims work under its own name';
  end if;
  select o.workflow_id into candidate
    from public.workflow_outbox o
    join public.intelligence_workflows w on w.id = o.workflow_id
   where o.state = 'pending'
     and o.available_at <= now()
     and w.state = 'created'
   order by o.available_at, o.id
   for update of o skip locked
   limit 1;
  if candidate is null then
    return null;
  end if;
  -- The claim itself is 058's, unchanged: it moves the command to dispatching
  -- and the workflow from created to queued, under the workflow's own lock.
  -- It answers with the command row it claimed, or nothing at all when
  -- somebody else got there first — a row, never a yes or a no.
  claimed := public.core_v2_claim_outbox(candidate, p_dispatcher);
  if claimed.workflow_id is null then
    return null;
  end if;
  return candidate;
end $$;

comment on function public.core_v2_claim_next_workflow(text) is
  'What a dispatcher asks when it wants work. Finds one waiting command and claims it in the same statement, skipping any row another dispatcher is already holding, so two dispatchers never start one workflow.';

-- What a dispatcher picks up again after a restart: workflows that are past
-- the door and not finished. Ordering by the oldest first means a run
-- interrupted long ago is not starved by fresh ones.
create or replace function public.core_v2_resumable_workflows(p_limit integer default 20)
returns setof uuid language sql stable security definer set search_path = public as $$
  select w.id
    from public.intelligence_workflows w
   where w.state in ('queued','planning','running','needs_attention','ready_for_decision','deciding')
     and w.cancel_requested_at is null
   order by w.created_at
   limit greatest(1, coalesce(p_limit, 20));
$$;

comment on function public.core_v2_resumable_workflows(integer) is
  'The workflows a dispatcher takes up again after a restart. Leasing is what makes this safe to ask from several dispatchers at once: they may all see a workflow, and only one of them gets each task.';

-- ─────────────────────────────────────────────────────── 6 · who may read it
alter table public.workflow_cost_budgets enable row level security;
alter table public.attempt_cost_reservations enable row level security;

drop policy if exists workflow_cost_budgets_read on public.workflow_cost_budgets;
create policy workflow_cost_budgets_read on public.workflow_cost_budgets
  for select using (public.is_org_member(organization_id));

drop policy if exists attempt_cost_reservations_read on public.attempt_cost_reservations;
create policy attempt_cost_reservations_read on public.attempt_cost_reservations
  for select using (public.is_org_member(organization_id));

-- Every write goes through a door. Nothing writes these tables directly, not
-- even the service role, because the invariant they keep is arithmetic across
-- two tables and a lock.
revoke all on table public.workflow_cost_budgets from public, anon, authenticated;
revoke all on table public.attempt_cost_reservations from public, anon, authenticated;
grant select on table public.workflow_cost_budgets to authenticated, service_role;
grant select on table public.attempt_cost_reservations to authenticated, service_role;

revoke all on function public.core_v2_authorize_workflow_spending(uuid, numeric, numeric, text, bigint, bigint, integer, integer, timestamptz) from public, anon, authenticated;
revoke all on function public.core_v2_cancelling_workflows(integer) from public, anon, authenticated;
revoke all on function public.core_v2_unreconciled_workflows(integer) from public, anon, authenticated;
revoke all on function public.core_v2_reserve_attempt_cost(uuid, numeric, bigint, bigint, jsonb) from public, anon, authenticated;
revoke all on function public.core_v2_settle_attempt_cost(uuid, numeric, jsonb) from public, anon, authenticated;
revoke all on function public.core_v2_release_attempt_cost(uuid, text) from public, anon, authenticated;
revoke all on function public.core_v2_stop_workflow_spending(uuid, text) from public, anon, authenticated;
revoke all on function public.core_v2_claim_next_workflow(text) from public, anon, authenticated;
revoke all on function public.core_v2_resumable_workflows(integer) from public, anon, authenticated;

grant execute on function public.core_v2_authorize_workflow_spending(uuid, numeric, numeric, text, bigint, bigint, integer, integer, timestamptz) to service_role;
grant execute on function public.core_v2_cancelling_workflows(integer) to service_role;
grant execute on function public.core_v2_unreconciled_workflows(integer) to service_role;
grant execute on function public.core_v2_reserve_attempt_cost(uuid, numeric, bigint, bigint, jsonb) to service_role;
grant execute on function public.core_v2_settle_attempt_cost(uuid, numeric, jsonb) to service_role;
grant execute on function public.core_v2_release_attempt_cost(uuid, text) to service_role;
grant execute on function public.core_v2_stop_workflow_spending(uuid, text) to service_role;
grant execute on function public.core_v2_claim_next_workflow(text) to service_role;
grant execute on function public.core_v2_resumable_workflows(integer) to service_role;

-- Tenancy, on the same guard 058 uses everywhere else: a reservation belongs
-- to the organisation and the workflow of the attempt it holds against.
drop trigger if exists workflow_cost_budgets_tenancy on public.workflow_cost_budgets;
create trigger workflow_cost_budgets_tenancy
  before insert or update on public.workflow_cost_budgets
  for each row execute function public.core_v2_guard_tenancy('workflow_id', 'intelligence_workflows');

drop trigger if exists attempt_cost_reservations_tenancy on public.attempt_cost_reservations;
create trigger attempt_cost_reservations_tenancy
  before insert or update on public.attempt_cost_reservations
  for each row execute function public.core_v2_guard_tenancy('workflow_id', 'intelligence_workflows', 'attempt_id', 'agent_attempts');
