-- ═══════════════════════════════════════════════════════════════════════════
-- A SETTLED CONTINUATION IS FINISHED WITH. A CANCELLATION IS NOT A REQUEST
-- TO CARRY ON.
--
-- Migration 060 made `settled` absorbing on purpose. core_v2_schedule_
-- continuation only ever brings a due time forward and refuses to revive a
-- settled row, because the alternative — anything at all being able to put a
-- finished workflow back in the queue — is how a fuse stops being a fuse.
--
-- That rule left one state nobody should ever be able to reach:
--
--     the workflow is not terminal;
--     its continuation is settled, so nothing will ever wake it again;
--     and a person then asks for it to be cancelled.
--
-- The cancellation is written down — 058 keeps it — and then nothing happens,
-- forever. The workflow is neither running nor cancelled, and the door that
-- was supposed to stop it has no effect. That is a worse outcome than the
-- runaway 060 was guarding against, and it needs its own door rather than a
-- loosening of the one that exists.
--
-- So: ONE narrow reopening, and the narrowness is the whole design.
--
--   · it reopens only a row that is settled. A due or held row is already
--     going to be looked at and is left exactly as it is;
--   · it reopens only when the workflow ITSELF says cancel_requested_at is
--     set. Not a flag passed in, not a caller's assertion — the record's own
--     column, read inside this function;
--   · it refuses a workflow whose state is already terminal. A completed
--     analysis is not un-completed by a late cancellation, and a cancelled
--     one has nothing left to cancel;
--   · it never clears a settled reason without writing why it was reopened,
--     so the row still says what happened to it.
--
-- AND ONE THING THE FIRST DRAFT OF THIS FILE GOT WRONG.
--
-- Reopening set the state back to `due` and cleared the idle streak, but left
-- `continuations` where it was. When the reason for settling was the
-- continuation ceiling, the very next core_v2_claim_continuation read that
-- same count, found it still at the ceiling, and settled the row again before
-- handing it to anybody. The cancellation was reopened and then immediately
-- re-blocked by the fuse it was reopened past — which is the bug this door
-- exists to prevent, wearing the fuse as a disguise.
--
-- So the reopening also gives the row a SMALL, BOUNDED budget of claims:
-- enough to carry out a cancellation, nowhere near enough to resume a
-- workflow. Three, because cancelling can need more than one pass — one to
-- ask, one to let something already in flight settle, one to reach a terminal
-- state — and because a person who cancels twice gets three more, which is
-- the correct amount of patience for a door somebody has to knock on.
--
-- ORDINARY WORK CANNOT RESUME THROUGH THIS, and that is structural rather
-- than hoped for: the kernel's own tick returns without dispatching anything
-- for a workflow whose cancel_requested_at is set, and this door only ever
-- opens for a workflow whose cancel_requested_at IS set. The three passes can
-- reconcile, cancel and settle. They cannot lease, and they cannot buy.
--
-- Everything else about 060 stands untouched. This adds a door; it does not
-- widen one. 058, 059 and 060 are unchanged by this file.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.core_v2_reopen_continuation(
  p_workflow_id uuid,
  p_reason text default 'cancellation_requested_after_settling'
) returns public.workflow_continuations
language plpgsql security definer set search_path = public as $$
declare
  workflow public.intelligence_workflows;
  row public.workflow_continuations;
  limits record;
  -- How many claims a reopened row is worth. A cancellation, not a run.
  passes_for_cancellation constant integer := 3;
begin
  select * into workflow from public.intelligence_workflows where id = p_workflow_id;
  if not found then
    raise exception 'core_v2: no workflow % to reopen', p_workflow_id;
  end if;

  -- The record's own word, not the caller's. A caller that could assert this
  -- could reopen anything.
  if workflow.cancel_requested_at is null then
    select * into row from public.workflow_continuations where workflow_id = p_workflow_id;
    return row;
  end if;

  -- A workflow that is over is over. Cancelling something that already
  -- completed, failed or was cancelled changes nothing and must not restart
  -- an engine that has finished with it.
  if workflow.state in ('completed', 'partial', 'failed', 'cancelled') then
    select * into row from public.workflow_continuations where workflow_id = p_workflow_id;
    return row;
  end if;

  select * into limits from public.core_v2_continuation_limits();

  update public.workflow_continuations c
     set state = 'due',
         due_at = now(),
         held_by = null,
         hold_token = null,
         held_until = null,
         -- The fuses are reset, and only for this: the pass that follows has
         -- one thing to do and it is not the work that tripped them.
         idle_streak = 0,
         backoff_ms = 0,
         -- Far enough below the ceiling that a claim can get through, and no
         -- further. `least` so a workflow nowhere near the ceiling keeps its
         -- own count and this door does not quietly hand it a fresh life.
         continuations = least(
           c.continuations,
           greatest(0, limits.maximum_continuations - passes_for_cancellation)
         ),
         settled_at = null,
         settled_reason = null,
         last_error = coalesce(nullif(p_reason, ''), 'cancellation_requested_after_settling'),
         updated_at = now()
   where c.workflow_id = p_workflow_id
     and c.state = 'settled'
  returning * into row;

  if row.workflow_id is null then
    select * into row from public.workflow_continuations where workflow_id = p_workflow_id;
  end if;
  return row;
end $$;

comment on function public.core_v2_reopen_continuation(uuid, text) is
  'Puts a SETTLED continuation back in the queue, and only ever for one reason: the workflow itself records a cancellation and is not yet terminal. Reads cancel_requested_at from the record rather than trusting a caller. A workflow that is over stays over; a row that is not settled is untouched. Lowers the continuation count just far enough that a claim can get through — three passes, enough to cancel and not enough to run, and the kernel dispatches nothing at all for a cancelling workflow.';

revoke all on function public.core_v2_reopen_continuation(uuid, text) from public, anon, authenticated;
grant execute on function public.core_v2_reopen_continuation(uuid, text) to service_role;
