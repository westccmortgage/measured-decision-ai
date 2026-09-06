-- 051 · The unknown outcome.
--
-- 048 stopped the second payment for a reading somebody asked for twice. It
-- did not stop the second payment for a reading the provider may already have
-- performed and billed, whose answer never reached us.
--
-- The hole, exactly: claim_ai_run reuses only a run in state 'succeeded'. A
-- request that went out and then lost its response — a timeout, a dropped
-- connection, an edge function killed mid-flight — was recorded 'failed', and
-- 'failed' is a free pass to buy the same reading again. The provider did the
-- work. The provider billed for it. We paid twice and called it a retry.
--
-- Three states, and the difference between them is the whole file:
--
--   succeeded        the result is in our hands. Nothing to buy.
--   failed           the work demonstrably did not happen — the request was
--                    refused before any reading was made. Safe to retry.
--   outcome_unknown  the request left the building and we cannot establish
--                    what happened to it. It may have run. It may have been
--                    billed. NOBODY MAY BUY IT AGAIN WITHOUT A PERSON SAYING
--                    SO — not the caller, not a poll, not a stale-lock sweep.
--
-- The confirmation is single-use and consumed inside the same statement that
-- claims the run, so two tabs, a double click and two colleagues pressing at
-- once produce exactly one authorised retry between them.
--
-- What this file deliberately does NOT do: change any provider request, any
-- `store` setting, or any data-retention posture. Five of the six workers send
-- store:false and stay that way, which is precisely why their lost responses
-- are unrecoverable and have to be declared unknown rather than re-bought.

-- ─────────────────────────────────────────────── the third state
alter table public.ai_runs drop constraint if exists ai_runs_state_check;
alter table public.ai_runs add constraint ai_runs_state_check
  check (state in ('running', 'succeeded', 'failed', 'outcome_unknown'));

comment on column public.ai_runs.state is
  'running · succeeded · failed (work demonstrably did not happen) · outcome_unknown (may have run and been billed; a person must authorise any retry).';

-- The authorisation. One row, one retry, and the consumption is what makes it
-- single-use: two racing claims both try to take it and exactly one succeeds.
alter table public.ai_runs
  add column if not exists retry_authorized_at timestamptz,
  add column if not exists retry_authorized_by uuid references auth.users(id) on delete set null,
  add column if not exists retry_consumed_at timestamptz,
  add column if not exists retry_consumed_by uuid references public.ai_runs(id) on delete set null;

comment on column public.ai_runs.retry_consumed_at is
  'Set by claim_ai_run in the same statement that takes the authorisation. An authorisation that is consumed can never be spent a second time.';

-- Finding the one unresolved unknown for a fingerprint is on the hot path of
-- every claim.
create index if not exists ai_runs_unresolved_unknown
  on public.ai_runs(organization_id, process_key, input_fingerprint, created_at desc)
  where state = 'outcome_unknown' and retry_consumed_at is null;

-- ─────────────────────────────────────────────── claiming a run
-- Same signature as 048 — deliberately, so no overload appears beside it and
-- no grant has to be restated. Three changes inside:
--
--   1. A lock that has been held far too long stops being a lock, and becomes
--      an UNKNOWN rather than a free retry. This is the "after timeout or
--      lock expiry" case: releasing the lock must never release the money.
--   2. A new verdict, UNKNOWN, that force cannot override. Forcing means
--      "buy another reading of inputs I already have"; it has never meant
--      "buy a reading that may already be sitting on the provider's invoice".
--   3. An authorised retry is consumed atomically as it is claimed.
--
-- Order of the verdicts matters and is not arbitrary:
--   RUNNING first  — an identical call in flight outranks everything.
--   REUSED next    — if the answer is already in our hands, nothing needs
--                    buying, and an old unknown is beside the point.
--   UNKNOWN next   — nothing to reuse, and something out there may be billed.
--   CLAIMED last   — nothing identical exists, or a person authorised this one.
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
  -- Generous on purpose. A plan-analyze background response is claimed at
  -- launch and closed at retrieval, which can be a long time later; a window
  -- that expired while the provider was still working would turn a live run
  -- into an unknown and stop the product for no reason. This only catches rows
  -- that were genuinely abandoned.
  stale_after constant interval := interval '12 hours';
  existing_running uuid;
  existing_done uuid;
  unresolved uuid;
  authorised uuid;
  claimed uuid;
begin
  if p_organization_id is null or p_process_key is null or p_input_fingerprint is null or p_model is null then
    raise exception 'claim_ai_run requires organization, process, model and fingerprint';
  end if;

  -- A lock nobody released is not evidence that nothing was bought. It moves
  -- to unknown, where a person decides — never straight back to available.
  update public.ai_runs set
    state = 'outcome_unknown',
    error_code = coalesce(error_code, 'lock_expired'),
    finished_at = coalesce(finished_at, now())
   where organization_id = p_organization_id
     and process_key = p_process_key
     and input_fingerprint = p_input_fingerprint
     and state = 'running'
     and started_at < now() - stale_after;

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

  -- The new gate. Note where it sits: AFTER force has had its chance to skip
  -- reuse, so forcing cannot walk past it.
  select id into unresolved from public.ai_runs
   where organization_id = p_organization_id
     and process_key = p_process_key
     and input_fingerprint = p_input_fingerprint
     and state = 'outcome_unknown'
     and retry_consumed_at is null
   order by created_at desc
   limit 1;

  if unresolved is not null then
    -- Take the authorisation, if there is one, in a single statement. The
    -- predicate is re-checked under the row lock, so of two callers racing
    -- exactly one comes away with it.
    update public.ai_runs set retry_consumed_at = now()
     where id = unresolved
       and retry_authorized_at is not null
       and retry_consumed_at is null
    returning id into authorised;

    if authorised is null then
      return query select 'UNKNOWN'::text, null::uuid, unresolved;
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
    select id into existing_running from public.ai_runs
     where organization_id = p_organization_id
       and process_key = p_process_key
       and input_fingerprint = p_input_fingerprint
       and state = 'running'
     limit 1;
    -- The authorisation was taken by this transaction and the race was lost;
    -- hand it back so the winner's failure does not silently burn a person's
    -- one permitted retry.
    if authorised is not null then
      update public.ai_runs set retry_consumed_at = null where id = authorised;
    end if;
    return query select 'RUNNING'::text, null::uuid, existing_running;
    return;
  end;

  if authorised is not null then
    update public.ai_runs set retry_consumed_by = claimed where id = authorised;
  end if;

  return query select 'CLAIMED'::text, claimed, null::uuid;
end;
$$;

-- ─────────────────────────────────────────────── closing a run
-- The only change is that a worker may now close a run by admitting it does
-- not know. Same signature as 048.
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
  if p_state not in ('succeeded', 'failed', 'outcome_unknown') then
    raise exception 'finish_ai_run state must be succeeded, failed or outcome_unknown';
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

-- ─────────────────────────────────────────────── the person's decision
-- The only door through which a possibly-billed reading may be bought again.
--
-- It authorises ONE run and nothing else. It does not start anything, so a
-- double click here cannot spend twice: the second press sets a flag that is
-- already set. What spends is the claim, and the claim consumes this once.
create or replace function public.confirm_ai_run_retry(p_run_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  row_org uuid;
  row_state text;
  row_consumed timestamptz;
begin
  select organization_id, state, retry_consumed_at
    into row_org, row_state, row_consumed
    from public.ai_runs where id = p_run_id;

  if row_org is null then return false; end if;
  if not public.is_org_member(row_org) then return false; end if;
  -- Only an unknown outcome can be authorised. A failed run needs no
  -- permission, and a succeeded one needs no repeat.
  if row_state <> 'outcome_unknown' or row_consumed is not null then return false; end if;

  update public.ai_runs set
    retry_authorized_at = coalesce(retry_authorized_at, now()),
    retry_authorized_by = coalesce(retry_authorized_by, auth.uid())
   where id = p_run_id;
  return true;
end;
$$;

-- ─────────────────────────────────────────────── what the button asks first
-- Same signature as 048, one more verdict. UNKNOWN ranks below REUSED on
-- purpose: if the answer is already in hand there is nothing to decide.
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
    union all
    select 'UNKNOWN'::text, r.id, r.finished_at, 2
      from public.ai_runs r
     where r.organization_id = p_organization_id
       and r.process_key = p_process_key
       and r.input_fingerprint = p_input_fingerprint
       and r.state = 'outcome_unknown'
       and r.retry_consumed_at is null
       and public.is_org_member(r.organization_id)
  ) ranked
  order by rank, finished_at desc nulls last
  limit 1;
$$;

-- ─────────────────────────────────────────────── what the screen shows
-- A run that may have been billed is not a failure and must not be counted as
-- one. Hiding it inside "failed" would understate the bill, which is the same
-- dishonesty as inventing a price. Dropped and recreated because the returned
-- columns change.
drop function if exists public.ai_usage_summary(uuid);
create or replace function public.ai_usage_summary(p_property_id uuid)
returns table (
  runs bigint,
  succeeded bigint,
  failed bigint,
  outcome_unknown bigint,
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
    count(*) filter (where r.state = 'outcome_unknown')::bigint,
    coalesce(sum(r.total_tokens), 0)::bigint,
    count(*) filter (where not r.usage_available)::bigint,
    case when count(*) filter (where r.estimated_cost_micros is null) = 0
         then sum(r.estimated_cost_micros)::bigint
         else null end,
    max(r.pricing_source)
  from public.ai_runs r
  join public.properties p on p.id = r.property_id
  where r.property_id = p_property_id
    and public.is_org_member(p.organization_id);
$$;

-- FROM PUBLIC, not merely from anon and authenticated — a function's default
-- grant to PUBLIC survives revoking the two named roles, which is how a
-- security-definer writer stays reachable from a browser by accident.
revoke all on function public.claim_ai_run(uuid, uuid, text, text, text, text, text, uuid, text, boolean) from public, anon, authenticated;
revoke all on function public.finish_ai_run(uuid, text, jsonb, text) from public, anon, authenticated;
-- The confirmation is the one thing here a person performs, so it is the one
-- thing a signed-in browser may call. Its own body checks org membership.
revoke all on function public.confirm_ai_run_retry(uuid) from public, anon;
grant execute on function public.confirm_ai_run_retry(uuid) to authenticated;
grant execute on function public.ai_usage_summary(uuid) to authenticated;
grant execute on function public.ai_run_state_for(uuid, text, text) to authenticated;
