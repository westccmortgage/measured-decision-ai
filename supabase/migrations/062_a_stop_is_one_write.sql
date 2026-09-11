-- ═══════════════════════════════════════════════════════════════════════════
-- STOPPING A WORKFLOW FOR GOOD IS ONE WRITE, AND THE WATCHDOG FINISHES WHAT A
-- DEAD PROCESS STARTED.
--
-- Stopping is two facts that must agree: the continuation stops being woken,
-- and the workflow says why. Until now they were two statements from a
-- process that could die between them, and the repair ran on the next tick of
-- ANY workflow. That is fine on a busy deployment and useless on the one that
-- matters — a single workflow, alone, whose stop was half-written. Nothing
-- else is due, so nothing ticks, so nothing repairs it, and the owner is left
-- with a workflow that says `running` and a queue that will never call it.
--
-- Two doors close that, and neither needs a second workflow or a hand-made
-- call:
--
--   1. core_v2_stop_workflow_and_settle — the stop, as ONE statement. The
--      workflow's state and reason and the settling of its continuation
--      commit together or not at all. There is no window to die in.
--
--   2. core_v2_finish_stopped_workflows — for the windows that already
--      existed, and for the rows migration 060 settles inside a claim without
--      ever handing them to a runner (a workflow already terminal, or one at
--      the continuation ceiling). It finds settled continuations whose
--      workflow has not been told and tells them. It is bounded, it writes
--      only to workflows that are behind, and it is idempotent.
--
-- The watchdog runs BOTH: core_v2_watchdog_tick calls the repair and then the
-- knock. So the minute cron alone — no runner, no second workflow, no tick
-- anybody typed — is enough to bring a half-written stop back into agreement.
--
-- 058, 059, 060 and 061 are untouched by this file. Nothing here replaces a
-- function any of them defines; core_v2_watchdog_tick is a new door that calls
-- 060's knock rather than reimplementing it.
-- ═══════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────── 1 · where a stopped workflow goes
--
-- Only through moves 058 already allows:
--
--     planning · running · ready_for_decision · deciding  →  needs_attention
--     queued                                              →  failed
--     created                                             →  queued → failed
--
-- `needs_attention` is not terminal on purpose: a person can act on it, and a
-- cancellation can still reach it. `failed` is used only where
-- `needs_attention` is not a legal destination — a workflow that never got
-- past its own start handshake did not need attention, it did not begin.
--
-- A workflow already at `needs_attention` keeps that state and still gets the
-- reason: the table has no self-loop and should not gain one, and 058 lists
-- error_code and error_message among the columns a workflow may change.

create or replace function public.core_v2_note_workflow_stopped(
  p_workflow_id uuid,
  p_reason text
) returns text
language plpgsql security definer set search_path = public as $$
declare
  wf public.intelligence_workflows;
  reason text := coalesce(nullif(btrim(p_reason), ''), 'runner_stopped');
begin
  select * into wf from public.intelligence_workflows where id = p_workflow_id for update;
  if not found then return null; end if;

  -- Over is over. Nothing here re-opens or re-labels a finished analysis.
  if wf.state in ('completed', 'partial', 'failed', 'cancelled') then
    return wf.state;
  end if;

  if wf.state = 'created' then
    update public.intelligence_workflows set state = 'queued' where id = p_workflow_id;
    wf.state := 'queued';
  end if;

  if wf.state = 'queued' then
    update public.intelligence_workflows
       set state = 'failed', error_code = 'runner_stopped', error_message = reason
     where id = p_workflow_id;
  elsif wf.state in ('planning', 'running', 'ready_for_decision', 'deciding') then
    update public.intelligence_workflows
       set state = 'needs_attention', error_code = 'runner_stopped', error_message = reason
     where id = p_workflow_id;
  else
    -- needs_attention: it is already where it would be moved to, and still
    -- needs to carry the reason the thing that runs it gave up.
    update public.intelligence_workflows
       set error_code = 'runner_stopped', error_message = reason
     where id = p_workflow_id;
  end if;

  insert into public.audit_events(organization_id, actor_id, action, entity_type, entity_id, detail)
  values (wf.organization_id, null, 'core_v2.workflow.runner_stopped', 'intelligence_workflow', p_workflow_id,
          jsonb_build_object('reason', reason, 'from', wf.state));

  return (select state from public.intelligence_workflows where id = p_workflow_id);
end $$;

comment on function public.core_v2_note_workflow_stopped(uuid, text) is
  'Writes on the workflow that the thing which runs it has stopped, using only moves 058 allows. A workflow that is over is left alone; one already at needs_attention keeps that state and still gets the reason.';

-- ────────────────────────────────────── 2 · the stop, as a single statement

create or replace function public.core_v2_stop_workflow_and_settle(
  p_workflow_id uuid,
  p_reason text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  ended text;
  row public.workflow_continuations;
begin
  -- One transaction: the function body. Either the workflow says why it
  -- stopped AND its continuation is settled, or neither happened.
  ended := public.core_v2_note_workflow_stopped(p_workflow_id, p_reason);
  select * into row from public.core_v2_settle_continuation(p_workflow_id, p_reason);
  return jsonb_build_object(
    'workflow_state', ended,
    'continuation_state', row.state,
    'settled_reason', row.settled_reason
  );
end $$;

comment on function public.core_v2_stop_workflow_and_settle(uuid, text) is
  'Stops a workflow for good as ONE write: the workflow is told why and its continuation is settled together, or neither is. There is no window for a process to die in.';

-- ─────────────────────────── 3 · what a process that died before this left

create or replace function public.core_v2_finish_stopped_workflows(
  p_limit integer default 20
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  candidate record;
  told uuid[] := '{}';
begin
  for candidate in
    select c.workflow_id, c.settled_reason
      from public.workflow_continuations c
      join public.intelligence_workflows w on w.id = c.workflow_id
     where c.state = 'settled'
       and w.state not in ('completed', 'partial', 'failed', 'cancelled')
       and coalesce(w.error_code, '') <> 'runner_stopped'
     order by c.settled_at nulls last
     limit greatest(1, coalesce(p_limit, 20))
  loop
    perform public.core_v2_note_workflow_stopped(
      candidate.workflow_id, coalesce(candidate.settled_reason, 'waking_stopped'));
    told := told || candidate.workflow_id;
  end loop;
  return jsonb_build_object('told', to_jsonb(told), 'count', coalesce(array_length(told, 1), 0));
end $$;

comment on function public.core_v2_finish_stopped_workflows(integer) is
  'Finds workflows whose waking is settled and which have not been told why, and tells them. Bounded, idempotent, and it never touches a workflow that is over or one already told. This is the repair for a process that died between the two writes, and for the rows core_v2_claim_continuation settles without ever handing them to a runner.';

-- ─────────────────────────────────────── 4 · what the minute cron actually runs
--
-- One door, so a deployment schedules one thing and gets both halves: the
-- repair first — because a workflow that is behind should be brought back
-- into agreement before anybody is asked to run anything — and then 060's
-- knock, unchanged.

create or replace function public.core_v2_watchdog_tick(
  p_limit integer default 10
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  repaired jsonb;
  knocked jsonb;
begin
  repaired := public.core_v2_finish_stopped_workflows(greatest(1, coalesce(p_limit, 10)) * 2);
  knocked := public.core_v2_tick_due_continuations(p_limit);
  return jsonb_build_object('repaired', repaired, 'knocked', knocked);
end $$;

comment on function public.core_v2_watchdog_tick(integer) is
  'What the minute cron runs: bring any half-written stop back into agreement, then knock for whatever is due. One workflow alone, with nothing else happening, is repaired by this and needs no tick anybody typed.';

revoke all on function public.core_v2_note_workflow_stopped(uuid, text) from public, anon, authenticated;
revoke all on function public.core_v2_stop_workflow_and_settle(uuid, text) from public, anon, authenticated;
revoke all on function public.core_v2_finish_stopped_workflows(integer) from public, anon, authenticated;
revoke all on function public.core_v2_watchdog_tick(integer) from public, anon, authenticated;

grant execute on function public.core_v2_note_workflow_stopped(uuid, text) to service_role;
grant execute on function public.core_v2_stop_workflow_and_settle(uuid, text) to service_role;
grant execute on function public.core_v2_finish_stopped_workflows(integer) to service_role;
grant execute on function public.core_v2_watchdog_tick(integer) to service_role;
