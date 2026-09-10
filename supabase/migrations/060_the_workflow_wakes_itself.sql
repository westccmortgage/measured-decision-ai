-- ═══════════════════════════════════════════════════════════════════════════
-- 060 · THE WORKFLOW WAKES ITSELF
--
-- WHY THIS EXISTS, AND WHY 058'S OUTBOX COULD NOT BE MADE TO DO IT.
--
-- The first paid canary proved the engine works and proved something else by
-- accident: a workflow only moved when a person pressed a button. Twenty
-- generations, and every one of them advanced because somebody dispatched
-- another run by hand. The engine was durable; the OPERATION of it was not.
--
-- What is missing is a single durable fact per workflow — "this one is due to
-- be continued at time T, is currently held by runner R until L, and has
-- failed to make progress N times running" — and 058's `workflow_outbox`
-- cannot hold it. Not because it is nearly right and needs a column, but
-- because it is a different thing:
--
--   · it is ONE ROW PER WORKFLOW, FOREVER — `workflow_id` is UNIQUE — and its
--     `command` is CHECKed to the single value 'start'. It is a start handoff,
--     committed with the workflow, claimed once, acknowledged once. Its whole
--     documented meaning is "this workflow has never been begun";
--   · its `state` machine ends at `acknowledged`. There is no way back. A
--     workflow whose start was acknowledged three passes ago has an outbox row
--     that is finished with, and re-opening it would make "acknowledged" mean
--     "acknowledged, unless somebody needs it again";
--   · `available_at` and `attempt_count` are the START command's backoff and
--     the START command's failure count, guarded by core_v2_guard_outbox and
--     indexed for the claim path. Re-purposing them for continuation would
--     make one number mean two things, which is exactly the class of mistake
--     the rest of this schema exists to prevent;
--   · and `core_v2_claim_next_workflow` only ever looks at outbox rows whose
--     workflow is still `created`. Continuation is the opposite case by
--     definition: the workflow has left `created` and is unfinished.
--
-- Widening the command check, reopening the state machine and overloading two
-- counters IS redesigning 058. So this migration adds a second, smaller table
-- beside it that says the one thing 058 has no word for, and leaves the start
-- handoff exactly as it was.
--
-- `core_v2_resumable_workflows` is not enough either, and it does not claim to
-- be: it answers "what is unfinished", oldest first, with no due time and no
-- lease. Several runners asking it all get the same answer and all spend a
-- whole invocation on the same workflow — which is what the canary did, and
-- why a continuation pass meant for generation twelve spent itself on
-- generation nine. Task leases keep that CORRECT; they do not make it useful.
--
-- Nothing here names a provider, holds a secret, or carries a source's bytes.
-- 058 and 059 are not rewritten. This migration only adds.
-- ═══════════════════════════════════════════════════════════════════════════

-- ──────────────────────────────────── 1 · when a workflow is next to be run

create table if not exists public.workflow_continuations (
  workflow_id uuid primary key references public.intelligence_workflows(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,

  -- `due`     — nobody holds it; it may be claimed once due_at has passed.
  -- `held`    — a runner has it until held_until, under hold_token.
  -- `settled` — the engine is finished with it. Nothing schedules it again.
  state text not null default 'due' check (state in ('due', 'held', 'settled')),

  due_at timestamptz not null default now(),
  held_by text,
  hold_token uuid,
  held_until timestamptz,

  -- How many continuations have run, and how many of those in a row moved
  -- nothing at all. The second is the poison fuse: a workflow that cannot be
  -- advanced stops asking to be woken rather than asking forever.
  continuations integer not null default 0 check (continuations >= 0),
  idle_streak integer not null default 0 check (idle_streak >= 0),
  backoff_ms integer not null default 0 check (backoff_ms >= 0),

  last_error text,
  settled_reason text,
  settled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A hold is three facts or none of them. A half-written lease is a lease
  -- nobody can prove they own.
  constraint workflow_continuations_hold_is_whole check (
    (state = 'held') = (held_by is not null and hold_token is not null and held_until is not null)
  ),
  constraint workflow_continuations_settled_says_why check (
    (state = 'settled') = (settled_at is not null and settled_reason is not null)
  )
);

comment on table public.workflow_continuations is
  'One row per workflow: when it is next due to be continued, who is holding it and until when, and how many continuations in a row have moved nothing. This is the only durable state that makes a workflow advance without a person. It holds no secret and no source bytes — ids, times and counts.';

-- The claim path. Partial, because a settled workflow is never asked about.
create index if not exists workflow_continuations_due
  on public.workflow_continuations(due_at)
  where state in ('due', 'held');

create index if not exists workflow_continuations_by_organization
  on public.workflow_continuations(organization_id, state);

drop trigger if exists workflow_continuations_touch on public.workflow_continuations;
create trigger workflow_continuations_touch before update on public.workflow_continuations
  for each row execute function public.core_v2_touch();

drop trigger if exists workflow_continuations_tenancy on public.workflow_continuations;
create trigger workflow_continuations_tenancy
  before insert or update on public.workflow_continuations
  for each row execute function public.core_v2_guard_tenancy('workflow_id', 'intelligence_workflows');

-- ────────────────────────────────────────────── 2 · the numbers, in one place
--
-- Every one of these is a fuse rather than a plan. The engine's own limits —
-- the authority, the attempt cap, the task leases — are what bound the money
-- and the work; these bound only how often a workflow may ask to be woken and
-- how long it may go on asking without getting anywhere.

create or replace function public.core_v2_continuation_limits()
returns table (
  maximum_idle_streak integer,
  maximum_continuations integer,
  first_backoff_ms integer,
  maximum_backoff_ms integer
) language sql immutable as $$
  -- Five passes in a row that moved nothing means nothing is going to move.
  -- Two hundred continuations is far past any workflow this engine plans and
  -- is there to make "forever" impossible rather than to shape behaviour.
  select 5, 200, 2000, 300000;
$$;

comment on function public.core_v2_continuation_limits() is
  'The fuses on waking: how many passes in a row may move nothing before a workflow stops scheduling itself, how many continuations it may ever have, and the backoff between idle passes. Not a plan — the engine''s authority and attempt caps bound the work and the money.';

-- ─────────────────────────────────────── 3 · asking to be continued, at all
--
-- Called once when a workflow is started, and again by a runner that is
-- leaving with work still to do. It never moves a due time EARLIER than one
-- already set by a live hold, and it never resurrects a settled workflow: a
-- workflow the engine has finished with is finished with.

create or replace function public.core_v2_schedule_continuation(
  p_workflow_id uuid,
  p_due_at timestamptz default now()
) returns public.workflow_continuations
language plpgsql security definer set search_path = public as $$
declare
  workflow public.intelligence_workflows;
  row public.workflow_continuations;
begin
  select * into workflow from public.intelligence_workflows where id = p_workflow_id;
  if not found then
    raise exception 'core_v2: no workflow % to continue', p_workflow_id;
  end if;

  insert into public.workflow_continuations (workflow_id, organization_id, due_at)
  values (p_workflow_id, workflow.organization_id, coalesce(p_due_at, now()))
  on conflict (workflow_id) do update
     set due_at = least(public.workflow_continuations.due_at, coalesce(p_due_at, now()))
   where public.workflow_continuations.state <> 'settled'
  returning * into row;

  if row.workflow_id is null then
    select * into row from public.workflow_continuations where workflow_id = p_workflow_id;
  end if;
  return row;
end $$;

comment on function public.core_v2_schedule_continuation(uuid, timestamptz) is
  'Asks that a workflow be continued at or before a time. Idempotent, and it only ever brings a due time forward. A settled workflow is left settled — the engine is finished with it, and asking again does not change that.';

-- ────────────────────────────────────────────── 4 · one runner takes one
--
-- The same shape as core_v2_claim_next_workflow and for the same reason:
-- finding and claiming in one statement under SKIP LOCKED is what lets
-- several runners overlap without two of them spending an invocation on the
-- same workflow. The hold has a token, so a runner that comes back after its
-- lease expired cannot write over whoever holds it now.
--
-- A workflow whose state is already terminal is not handed out. It is settled
-- on the spot, which is how a terminal workflow stops scheduling itself even
-- if something asked for it after the fact.

create or replace function public.core_v2_claim_continuation(
  p_runner text,
  p_lease_ms integer default 180000
) returns public.workflow_continuations
language plpgsql security definer set search_path = public as $$
declare
  candidate uuid;
  row public.workflow_continuations;
  limits record;
begin
  if p_runner is null or btrim(p_runner) = '' then
    raise exception 'core_v2: a runner claims work under its own name';
  end if;
  if p_lease_ms is null or p_lease_ms <= 0 then
    raise exception 'core_v2: a hold with no length is not a hold';
  end if;
  select * into limits from public.core_v2_continuation_limits();

  loop
    select c.workflow_id into candidate
      from public.workflow_continuations c
     where c.state <> 'settled'
       and c.due_at <= now()
       and (c.state = 'due' or c.held_until < now())
     order by c.due_at, c.workflow_id
       for update of c skip locked
     limit 1;

    if candidate is null then
      return null;
    end if;

    -- A workflow the engine has finished with, or one that has asked too
    -- many times, is settled here rather than handed to a runner. The loop
    -- then looks again, so one poisoned row does not hide the queue behind it.
    if exists (
      select 1 from public.intelligence_workflows w
       where w.id = candidate
         and w.state in ('completed', 'partial', 'failed', 'cancelled')
    ) then
      update public.workflow_continuations
         set state = 'settled', settled_at = now(), settled_reason = 'workflow_reached_a_terminal_state',
             held_by = null, hold_token = null, held_until = null
       where workflow_id = candidate;
      continue;
    end if;

    if (select c.continuations from public.workflow_continuations c where c.workflow_id = candidate)
       >= limits.maximum_continuations then
      update public.workflow_continuations
         set state = 'settled', settled_at = now(), settled_reason = 'continuation_limit',
             held_by = null, hold_token = null, held_until = null
       where workflow_id = candidate;
      continue;
    end if;

    update public.workflow_continuations
       set state = 'held',
           held_by = p_runner,
           hold_token = gen_random_uuid(),
           held_until = now() + make_interval(secs => p_lease_ms / 1000.0),
           continuations = continuations + 1
     where workflow_id = candidate
    returning * into row;
    return row;
  end loop;
end $$;

comment on function public.core_v2_claim_continuation(text, integer) is
  'What a runner asks when it wants a workflow to advance. Finds one due continuation and holds it in the same statement, skipping rows another runner is holding, so two runners never spend an invocation on the same workflow. A workflow already terminal, or one that has asked too many times, is settled here instead of handed out.';

-- ────────────────────────────────── 5 · giving it back, and saying what next
--
-- The fencing token is the whole point: a runner whose lease expired while it
-- was working comes back to find somebody else holding the row, and its
-- release is refused rather than silently overwriting a live hold.
--
-- `p_moved` is the runner's honest answer to "did anything happen": a task
-- dispatched, released, stopped or reconciled. A pass that moved something
-- resets the idle streak and asks to come back promptly. A pass that moved
-- nothing lengthens the backoff, and enough of those in a row settle the row
-- — which is the thing that makes a poisoned workflow stop waking.

create or replace function public.core_v2_release_continuation(
  p_workflow_id uuid,
  p_hold_token uuid,
  p_moved boolean,
  p_next_due_at timestamptz default null,
  p_error text default null
) returns public.workflow_continuations
language plpgsql security definer set search_path = public as $$
declare
  row public.workflow_continuations;
  workflow public.intelligence_workflows;
  limits record;
  next_backoff integer;
  streak integer;
begin
  select * into limits from public.core_v2_continuation_limits();

  select * into row from public.workflow_continuations
   where workflow_id = p_workflow_id for update;
  if not found then
    raise exception 'core_v2: no continuation for workflow %', p_workflow_id;
  end if;
  if row.state <> 'held' or row.hold_token is distinct from p_hold_token then
    -- Not an error the caller can fix, and not a lie either: it says the hold
    -- is not theirs, and whoever does hold it will finish the pass.
    return null;
  end if;

  select * into workflow from public.intelligence_workflows where id = p_workflow_id;

  if workflow.state in ('completed', 'partial', 'failed', 'cancelled') then
    update public.workflow_continuations
       set state = 'settled', settled_at = now(),
           settled_reason = 'workflow_reached_a_terminal_state',
           held_by = null, hold_token = null, held_until = null,
           idle_streak = 0, last_error = p_error
     where workflow_id = p_workflow_id
    returning * into row;
    return row;
  end if;

  streak := case when coalesce(p_moved, false) then 0 else row.idle_streak + 1 end;

  if streak >= limits.maximum_idle_streak then
    update public.workflow_continuations
       set state = 'settled', settled_at = now(),
           settled_reason = 'no_progress_in_' || streak || '_continuations',
           held_by = null, hold_token = null, held_until = null,
           idle_streak = streak, last_error = p_error
     where workflow_id = p_workflow_id
    returning * into row;
    return row;
  end if;

  next_backoff := case
    when coalesce(p_moved, false) then 0
    when row.backoff_ms <= 0 then limits.first_backoff_ms
    else least(row.backoff_ms * 2, limits.maximum_backoff_ms)
  end;

  update public.workflow_continuations
     set state = 'due',
         held_by = null, hold_token = null, held_until = null,
         idle_streak = streak,
         backoff_ms = next_backoff,
         last_error = p_error,
         due_at = coalesce(p_next_due_at, now() + make_interval(secs => next_backoff / 1000.0))
   where workflow_id = p_workflow_id
  returning * into row;
  return row;
end $$;

comment on function public.core_v2_release_continuation(uuid, uuid, boolean, timestamptz, text) is
  'Gives a held continuation back and says when to come again. Refused, with a null, when the hold token is not the current one — a runner whose lease expired mid-pass cannot write over whoever holds it now. A workflow that has reached a terminal state is settled here; so is one whose passes have moved nothing too many times running.';

-- ─────────────────────────────────────────── 6 · stopping on purpose

create or replace function public.core_v2_settle_continuation(
  p_workflow_id uuid,
  p_reason text
) returns public.workflow_continuations
language plpgsql security definer set search_path = public as $$
declare row public.workflow_continuations;
begin
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'core_v2: a continuation is settled for a reason';
  end if;
  update public.workflow_continuations
     set state = 'settled', settled_at = now(), settled_reason = p_reason,
         held_by = null, hold_token = null, held_until = null
   where workflow_id = p_workflow_id and state <> 'settled'
  returning * into row;
  if row.workflow_id is null then
    select * into row from public.workflow_continuations where workflow_id = p_workflow_id;
  end if;
  return row;
end $$;

comment on function public.core_v2_settle_continuation(uuid, text) is
  'Stops a workflow scheduling itself, for a named reason. Used when a person cancels, and by the runner when the engine hands a workflow to a person.';

-- ───────────────────────────────────────────────── 7 · what is due, read-only

create or replace function public.core_v2_due_continuations(p_limit integer default 10)
returns setof uuid language sql stable security definer set search_path = public as $$
  select c.workflow_id
    from public.workflow_continuations c
   where c.state <> 'settled'
     and c.due_at <= now()
     and (c.state = 'due' or c.held_until < now())
   order by c.due_at, c.workflow_id
   limit greatest(1, coalesce(p_limit, 10));
$$;

comment on function public.core_v2_due_continuations(integer) is
  'The workflows a watchdog would wake right now. Read-only and claims nothing: what makes waking safe is core_v2_claim_continuation, not this.';

-- ══════════════════════════════════ 8 · the watchdog, dormant until armed
--
-- The runner wakes itself: before it leaves with work still to do it sets the
-- next due time and asks the platform to come back. That is the fast path and
-- it is not the authority, because a self-invocation that is lost takes the
-- workflow with it. This is the authority: something outside the chain that
-- looks at the durable due times on a fixed schedule and knocks.
--
-- It ships DORMANT. The table below is empty, `armed` defaults to false, no
-- cron job is created here, and with nothing armed the tick function posts
-- nowhere and says so. Arming it is a deliberate act, written down in the
-- runbook, not a side effect of running a migration.

create table if not exists public.core_v2_runner_settings (
  id boolean primary key default true check (id),
  armed boolean not null default false,
  endpoint text,
  -- The NAME of a Vault secret, never a secret. The tick reads the value from
  -- vault.decrypted_secrets at the moment it posts; nothing in this table is
  -- worth stealing.
  secret_name text,
  updated_at timestamptz not null default now()
);

comment on table public.core_v2_runner_settings is
  'One row. Whether the watchdog is armed, where it knocks, and the NAME of the Vault secret it authenticates with. No secret value is stored here.';

drop trigger if exists core_v2_runner_settings_touch on public.core_v2_runner_settings;
create trigger core_v2_runner_settings_touch before update on public.core_v2_runner_settings
  for each row execute function public.core_v2_touch();

create or replace function public.core_v2_tick_due_continuations(p_limit integer default 10)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  settings public.core_v2_runner_settings;
  secret text;
  due uuid[];
  posted integer := 0;
  target uuid;
begin
  select * into settings from public.core_v2_runner_settings where id;
  if not found or not settings.armed then
    return jsonb_build_object('armed', false, 'due', 0, 'posted', 0,
      'note', 'the watchdog is not armed; nothing was posted');
  end if;
  if settings.endpoint is null or btrim(settings.endpoint) = '' then
    return jsonb_build_object('armed', true, 'due', 0, 'posted', 0,
      'note', 'armed with nowhere to knock');
  end if;

  select coalesce(array_agg(w), '{}') into due
    from public.core_v2_due_continuations(p_limit) w;
  if array_length(due, 1) is null then
    return jsonb_build_object('armed', true, 'due', 0, 'posted', 0);
  end if;

  -- No pg_net, no knocking. Said plainly, so a silent watchdog is never
  -- mistaken for a quiet queue.
  if to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then
    return jsonb_build_object('armed', true, 'due', array_length(due, 1), 'posted', 0,
      'note', 'pg_net is not installed; the watchdog cannot knock');
  end if;

  if settings.secret_name is not null and to_regclass('vault.decrypted_secrets') is not null then
    execute format(
      'select decrypted_secret from vault.decrypted_secrets where name = %L limit 1', settings.secret_name
    ) into secret;
  end if;
  if secret is null then
    return jsonb_build_object('armed', true, 'due', array_length(due, 1), 'posted', 0,
      'note', 'no runner secret is readable; the watchdog will not knock unauthenticated');
  end if;

  foreach target in array due loop
    execute
      'select net.http_post($1, $2, ''{}''::jsonb, $3, $4)'
      using settings.endpoint,
            jsonb_build_object('op', 'tick', 'workflowId', target, 'wokenBy', 'watchdog'),
            jsonb_build_object('content-type', 'application/json', 'x-core-v2-runner', secret),
            5000;
    posted := posted + 1;
  end loop;

  return jsonb_build_object('armed', true, 'due', array_length(due, 1), 'posted', posted);
end $$;

comment on function public.core_v2_tick_due_continuations(integer) is
  'The watchdog''s one move: look at the durable due times and knock once per due workflow. Dormant until armed, silent about nothing — an unarmed watchdog, a missing pg_net and an unreadable secret each say so rather than returning zero as though the queue were empty.';

-- ─────────────────────────────────────────────────────── 9 · who may read it
--
-- Same shape as everything else here: a person reads their own organisation's
-- rows and writes none of them. Every write goes through a door.

alter table public.workflow_continuations enable row level security;
alter table public.core_v2_runner_settings enable row level security;

drop policy if exists workflow_continuations_read on public.workflow_continuations;
create policy workflow_continuations_read on public.workflow_continuations
  for select using (public.is_org_member(organization_id));

-- No policy on the settings table at all: it is the operator's, not a
-- member's, and RLS with no policy denies everyone but the service role.

revoke all on table public.workflow_continuations from public, anon, authenticated;
revoke all on table public.core_v2_runner_settings from public, anon, authenticated;
grant select on table public.workflow_continuations to authenticated, service_role;
grant select, insert, update on table public.core_v2_runner_settings to service_role;

revoke all on function public.core_v2_continuation_limits() from public, anon, authenticated;
revoke all on function public.core_v2_schedule_continuation(uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.core_v2_claim_continuation(text, integer) from public, anon, authenticated;
revoke all on function public.core_v2_release_continuation(uuid, uuid, boolean, timestamptz, text) from public, anon, authenticated;
revoke all on function public.core_v2_settle_continuation(uuid, text) from public, anon, authenticated;
revoke all on function public.core_v2_due_continuations(integer) from public, anon, authenticated;
revoke all on function public.core_v2_tick_due_continuations(integer) from public, anon, authenticated;

grant execute on function public.core_v2_continuation_limits() to service_role;
grant execute on function public.core_v2_schedule_continuation(uuid, timestamptz) to service_role;
grant execute on function public.core_v2_claim_continuation(text, integer) to service_role;
grant execute on function public.core_v2_release_continuation(uuid, uuid, boolean, timestamptz, text) to service_role;
grant execute on function public.core_v2_settle_continuation(uuid, text) to service_role;
grant execute on function public.core_v2_due_continuations(integer) to service_role;
grant execute on function public.core_v2_tick_due_continuations(integer) to service_role;
