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
  'Puts a SETTLED continuation back in the queue, and only ever for one reason: the workflow itself records a cancellation and is not yet terminal. Reads cancel_requested_at from the record rather than trusting a caller. A workflow that is over stays over; a row that is not settled is untouched.';

revoke all on function public.core_v2_reopen_continuation(uuid, text) from public, anon, authenticated;
grant execute on function public.core_v2_reopen_continuation(uuid, text) to service_role;
