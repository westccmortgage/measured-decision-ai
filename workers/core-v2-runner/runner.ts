/* ONE INVOCATION OF THE THING THAT KEEPS WORKFLOWS MOVING.
 *
 * WHAT THIS REPLACES.
 *
 * The first paid canary ran twenty generations and every one of them advanced
 * because a person dispatched another run. The engine was durable; the
 * OPERATION of it was a human in a loop, and a workflow that needed five
 * passes needed five decisions by somebody who was awake. This file is the
 * thing that decides instead.
 *
 * WHAT ONE INVOCATION DOES.
 *
 *   1. takes ONE due continuation — either the hold its caller already has, or
 *      one it claims itself under SKIP LOCKED, so a second runner that
 *      overlaps this one takes a different workflow or none at all. A caller
 *      that already chose a workflow, read its sources and built its world
 *      hands that hold IN. The first version of this file made its caller give
 *      the hold back and then claimed again, which meant the world belonged to
 *      one workflow and the pass could run a different one;
 *   2. if that workflow has never been begun, finishes the start handshake
 *      058 defines: claim the command, plan, acknowledge;
 *   3. authorises spending ONLY if the workflow has no budget yet. A
 *      continuation inherits the authority its workflow was started under.
 *      Re-authorising is not a smaller mistake than over-spending; it is the
 *      same mistake with a better story;
 *   4. advances that one workflow, and only that one, until the ONE absolute
 *      deadline it was given says there is no longer room to start a reading,
 *      wait for it and write it down — then waits for what is already in
 *      flight rather than abandoning it;
 *   5. says when to come back, in the record, before it returns, and — when it
 *      is stopping for good — writes the workflow's own state to match.
 *
 * ONE DEADLINE, TAKEN AT THE DOOR.
 *
 * The deadline is absolute and it starts when the INVOCATION started, not when
 * this function did. Connecting to the record, reading a workflow's sources,
 * rebuilding its material and validating an operator declaration all happen
 * before the first line here runs, and they all take time that the container
 * is counting. A pass that started its own full budget after that work was
 * quietly promising itself a lifetime it did not have — which is how a request
 * gets started forty-five seconds before a process is killed, and how an
 * attempt becomes an outcome nobody will ever know.
 *
 * The same deadline is then asked about before EVERY submission, including the
 * second reader of a subject inside one scheduler tick, because a lane runs
 * its readings one after another and a timer around the pass cannot see the
 * moment between them. A reading with no room left is not sent: it goes back
 * to the queue, unrun, for the next pass of THIS workflow.
 *
 * WHAT MAKES IT SAFE TO OVERLAP.
 *
 * Nothing in this file. The claim is one SQL statement; the hold carries a
 * fencing token; the tasks inside the workflow are leased by the kernel; the
 * money is held by the ledger before anything is sent. A second runner is not
 * a race this code has to win — it is a case the database already decided.
 *
 * WHAT IT WILL NOT DO.
 *
 *   · start a new workflow because an old one is unfinished. A continuation
 *     resumes the same workflow_id or it is not a continuation;
 *   · retry an attempt whose outcome nobody knows. That is a person's
 *     decision and the kernel refuses it without one;
 *   · keep waking a workflow that cannot be advanced. The fuse for that is in
 *     the SQL, shared by every caller, and it settles the row rather than
 *     asking forever;
 *   · name a provider, or know what the work is about.
 */
import type { WorkflowState } from "../core-v2/kernel/contracts.ts";
import type { DomainPack } from "../core-v2/kernel/domain.ts";
import type { ExecutorRegistry } from "../core-v2/kernel/executors.ts";
import type { OrchestrationPolicy } from "../core-v2/kernel/policy.ts";
import { DEFAULT_POLICY } from "../core-v2/kernel/policy.ts";
import type { OrchestrationRepository } from "../core-v2/kernel/repository.ts";
import type { RoutingTable } from "../core-v2/kernel/router.ts";
import type { SourceManifest } from "../core-v2/kernel/contracts.ts";
import type { Queryable } from "../core-v2/postgres/wire.ts";
import { Dispatcher, problemToken } from "../core-v2-runtime/dispatcher.ts";
import type { EventSink, WorkflowPass } from "../core-v2-runtime/dispatcher.ts";
import type { InvocationClock } from "./clock.ts";
import type { ContinuationHold, ContinuationStore } from "./continuations.ts";

/* The states after which nothing this engine can do will move the workflow.
   The same list migration 060 settles a continuation on, kept here so a
   reader of either can check the other. */
export const RUNNER_FINISHED_STATES: readonly WorkflowState[] = ["completed", "partial", "failed", "cancelled"];

/* Why this invocation stopped scheduling the workflow it held. */
export type StopReason =
  | "workflow_reached_a_terminal_state"
  | "handed_to_a_person"
  /* Something is leased, running or in flight and this pass is not it. Not
     idle, not stuck, and specifically not the kind of nothing-happened that
     should count towards the fuse. */
  | "waiting_for_a_live_lease"
  /* There was work to do and no room left in this process's life to do it.
     The work is queued and the next pass starts it. */
  | "no_time_left_in_this_pass"
  | "more_work_remains"
  | "hold_was_not_ours";

export type PassOutcome = {
  /* Null when nothing was due: an idle runner, which is the ordinary case. */
  workflowId: string | null;
  claimed: boolean;
  continuations: number;
  /* The workflow's state when this invocation let go of it. */
  state: WorkflowState | null;
  /* Did anything at all happen — a task dispatched, released, stopped or
     reconciled. The honest answer to this is what stops a poisoned workflow
     waking forever, so it is computed from the engine's own report and never
     from optimism. */
  moved: boolean;
  stopReason: StopReason | null;
  /* Whether the record still says this workflow should be continued. */
  scheduledAgain: boolean;
  /* Tasks leased and handed straight back because there was no room to start
     them. They are queued, unrun, uncharged, and waiting for the next pass. */
  deferred: number;
  /* Set when this pass stopped the workflow for good and wrote its state to
     say so: the reason, and what the workflow now says. */
  finalStop: { reason: string; workflowState: WorkflowState | null } | null;
  ticks: number;
  passes: number;
  elapsedMs: number;
  problems: string[];
};

export type RunnerWorld = {
  pack: DomainPack;
  executors: (manifest: SourceManifest) => ExecutorRegistry;
  /* The repository this runner writes through — metered, in production, so
     nothing reaches a provider without money held first. */
  repository: (client: Queryable) => OrchestrationRepository;
  routing?: RoutingTable;
  /* Called ONLY when the ledger has no budget for this workflow. A
     continuation never reaches this. */
  authorize?: (workflowId: string, client: Queryable) => Promise<void>;
  /* Answers "does this workflow already have an authority", so the runner can
     tell a first pass from a continuation without guessing. */
  hasBudget: (workflowId: string, client: Queryable) => Promise<boolean>;
};

export type RunnerOptions = {
  /* This runner's own name, in the record and in every event. */
  name: string;
  clock: InvocationClock;
  store: ContinuationStore;
  /* THE WORKFLOW THIS PASS IS FOR, ALREADY CHOSEN.
     A caller that had to choose a workflow in order to build its world — read
     its sources, rebuild its material, find its organisation — passes the hold
     it is holding. Omitted, this function claims one itself, which is what a
     portable runner with a world that serves any workflow wants. What it never
     does is take one hold, give it back, and claim another. */
  hold?: ContinuationHold;
  /* WHEN THIS INVOCATION MUST HAVE RETURNED, as an absolute time on the same
     scale as `now()`. Given by whoever started counting first — the request
     handler, before it connected to anything. Omitted, the pass takes the
     clock's own deadline from the moment it starts, which is right only when
     nothing happened before it. */
  deadlineAt?: number;
  /* When the invocation began, for elapsed time in the record. Defaults to
     the moment this function starts. */
  startedAt?: number;
  connect: () => Promise<Queryable & { end?: () => Promise<void> }>;
  /* Closing belongs to whoever opened it. A runner handed a long-lived
     connection that closed it on the way out would take the caller's next
     query with it — which is exactly what the first version of this file did
     to its own test. If the caller wants the connection closed when the pass
     ends, it says so here. */
  release?: (client: Queryable & { end?: () => Promise<void> }) => Promise<void>;
  world: RunnerWorld;
  events?: EventSink;
  now?: () => number;
  policy?: OrchestrationPolicy;
  /* How many attempts of one workflow may be open at once. */
  concurrentAttempts?: number;
  /* Replaced by a test so a pass can be driven without real timers. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

const isFinished = (state: WorkflowState | null): boolean =>
  state !== null && RUNNER_FINISHED_STATES.includes(state);

/* Whether the engine still has something it could do by itself. `blocked`
   deliberately does not count: a blocked task is waiting for an upstream task
   this engine is going to finish, not for a person. */
const machineCanStillAct = (pass: WorkflowPass): boolean =>
  pass.remaining.runnable > 0 || pass.remaining.busy > 0 ||
  pass.remaining.reconcilable > 0 || pass.remaining.inFlight > 0;

/* A policy whose waits are the clock's waits. Handing the scheduler one set of
   numbers and the transport another is how the canary produced attempts
   nobody could account for. */
export function policyForClock(clock: InvocationClock, base: OrchestrationPolicy = DEFAULT_POLICY, concurrentAttempts?: number): OrchestrationPolicy {
  return {
    ...base,
    attemptTimeoutMs: clock.answerWithinMs,
    settlementAllowanceMs: clock.settlementRoomMs,
    heartbeatIntervalMs: clock.heartbeatIntervalMs,
    maximumConcurrentTasksPerWorkflow: Math.max(
      1, concurrentAttempts ?? base.maximumConcurrentTasksPerWorkflow,
    ),
  };
}

export async function runOnePass(options: RunnerOptions): Promise<PassOutcome> {
  const now = options.now ?? (() => Date.now());
  const setTimer = options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const clock = options.clock;
  const enteredAt = now();
  const startedAt = options.startedAt ?? enteredAt;
  /* ONE ABSOLUTE DEADLINE, AND EVERYTHING ELSE DERIVED FROM IT.
     Given by the caller when the caller started counting first. What matters
     is that preparation SHRINKS the working window rather than resetting it:
     if connecting and building the world took forty seconds, forty seconds
     are gone, and the last moment at which a reading may be started moves
     back by forty seconds with them. */
  const deadlineAt = options.deadlineAt ?? (enteredAt + clock.deadlineMs);
  const stopLeasingAt = deadlineAt - clock.answerWithinMs - clock.settlementRoomMs;
  const problems: string[] = [];
  /* The dispatcher calls its sink unconditionally, so a runner started
     without one hands it a no-op rather than an undefined. */
  const emit: EventSink = options.events ?? (() => {});
  const say = (event: string, detail: Record<string, unknown> = {}) => {
    emit({ at: now(), dispatcher: options.name, event, ...detail } as never);
  };

  const idle = (): PassOutcome => ({
    workflowId: null, claimed: false, continuations: 0, state: null, moved: false,
    stopReason: null, scheduledAgain: false, deferred: 0, finalStop: null, ticks: 0, passes: 0,
    elapsedMs: now() - startedAt, problems,
  });

  /* ── the hold: the caller's, or one of our own ──────────────────────── */
  const hold = options.hold ?? await options.store.claim(options.name, clock.runnerHoldMs);
  if (!hold) { say("runner.nothing_due"); return idle(); }
  say("runner.holding", {
    workflow: hold.workflowId, continuation: hold.continuations,
    hold: options.hold ? "given" : "claimed",
    /* What is actually left, after everything that happened before this. */
    usable_ms: Math.max(0, deadlineAt - enteredAt),
    lease_until_ms: Math.max(0, stopLeasingAt - enteredAt),
  });

  /* A pass with no room to start anything is not a failure and must not be
     recorded as one. It gives the hold straight back, unchanged, and says so. */
  if (stopLeasingAt <= now()) {
    say("runner.no_room", { workflow: hold.workflowId });
    let scheduled = false;
    try {
      const back = await options.store.release({
        workflowId: hold.workflowId, holdToken: hold.holdToken,
        /* NOT `moved`, and not due immediately.
           A pass with no room to start anything moved nothing, and saying
           otherwise would reset the record's backoff and let a chain knock
           straight back into the same wall — a hot loop bounded only by the
           continuation ceiling. Letting the backoff apply means the next
           attempt is seconds later, not microseconds, and if a deployment
           can NEVER start anything the idle fuse settles it after five and
           says why. An operator whose runner has no usable life should be
           told that, and `last_error` is where it is written. */
        moved: false, error: "no_time_left_in_this_pass",
      });
      scheduled = back !== null && back.state !== "settled";
    } catch (error) { problems.push(problemToken(error)); }
    /* Nothing was connected, so there is nothing to give back. */
    return {
      workflowId: hold.workflowId, claimed: true, continuations: hold.continuations,
      state: null, moved: false, stopReason: "no_time_left_in_this_pass",
      scheduledAgain: scheduled, deferred: 0, finalStop: null, ticks: 0, passes: 0,
      elapsedMs: now() - startedAt, problems,
    };
  }

  const client = await options.connect();
  let moved = false;
  let ticks = 0;
  let passes = 0;
  let state: WorkflowState | null = null;
  let stopReason: StopReason = "more_work_remains";
  let deferred = 0;
  let last: WorkflowPass | null = null;
  let finalStop: PassOutcome["finalStop"] = null;
  let dispatcher: Dispatcher | null = null;
  const winding = new AbortController();
  let stopLeasing: unknown = null;
  /* Held outside the try because the final state of the workflow is written
     after it, and a pass that failed still has to say what it left behind. */
  let repo: OrchestrationRepository | null = null;

  try {
    repo = options.world.repository(client);
    /* A const the closures below can hold. `repo` itself stays nullable for the
       shutdown path, and a callback cannot narrow a binding that may change. */
    const repository = repo;

    /* ── the start handshake, once and only once ──────────────────────── */
    const before = await repo.getWorkflow(hold.workflowId);
    if (!before) throw new Error(`core-v2-runner: no workflow ${hold.workflowId}`);
    state = before.state;

    /* THE AUTHORITY IS THE WORKFLOW'S, NOT THE PASS'S.
       A continuation that offered its own authorisation is what wedged the
       canary: the ledger compares the authority on record against the one
       offered and refuses when they differ, which is exactly right. So the
       question asked here is never "what should this cost" but "does this
       workflow already have an authority" — and if it does, nothing is
       offered at all. */
    const authorised = await options.world.hasBudget(hold.workflowId, client);
    if (!authorised) {
      if (options.world.authorize) {
        await options.world.authorize(hold.workflowId, client);
        say("runner.authorized", { workflow: hold.workflowId });
      }
    } else {
      say("runner.authority_reused", { workflow: hold.workflowId });
    }

    /* A CONNECTION THE DISPATCHER CANNOT CLOSE.
       Dispatcher.stop() ends the connection it was handed, which is right for
       a dispatcher that opened its own and wrong for one inside a pass that
       still has a continuation to release. So it is given a view with the one
       method it needs and no `end` — the runner opened this socket, or was
       lent it, and either way the runner decides when it closes. */
    const lent: Queryable = { query: (sql, params) => client.query(sql, params) };
    dispatcher = new Dispatcher({
      name: options.name,
      signal: winding.signal,
      connect: async () => lent as never,
      repository: () => repository,
      pack: options.world.pack,
      executors: options.world.executors,
      routing: options.world.routing,
      policy: policyForClock(clock, options.policy, options.concurrentAttempts),
      leaseTtlMs: clock.taskLeaseMs,
      /* ASKED BEFORE EVERY LEASE AND BEFORE EVERY SUBMISSION, including the
         second reading of a subject inside one tick. This is the whole of the
         "do not start what you cannot finish" rule, and it is one expression
         because it is one rule. */
      mayStartWork: () => now() < stopLeasingAt && !winding.signal.aborted,
      /* AND THE SAME DEADLINE, IN MILLISECONDS, FOR THE TWO QUESTIONS ONLY
         THE KERNEL CAN ASK: is there still room now that the packet is built,
         and how long may this answer actually be waited for. Building a packet
         is not free, so a gate that was open when the task was picked up can
         be shut by the time there is anything to send. */
      msUntilDeadline: () => deadlineAt - now(),
      /* One workflow gets this invocation. The runner already chose which. */
      workflowsPerPass: 1,
      events: emit,
      now,
      backoff: { baseMs: 50, ceilingMs: 250, jitter: 0, random: () => 0 },
    });

    if (before.state === "created") {
      const claimed = await repo.claimOutbox(hold.workflowId, options.name);
      if (!claimed) {
        /* Somebody else finished the handshake between the continuation claim
           and here. That is not a problem; the workflow is past the door. */
        say("runner.start_already_claimed", { workflow: hold.workflowId });
      }
      const owned = await dispatcher.establishOwnership(hold.workflowId);
      if (owned) { await repo.acknowledgeOutbox(hold.workflowId); moved = true; }
      else problems.push("ownership_refused");
    }

    /* ── a cancellation asked for anywhere is honoured here ───────────── */
    /* The scheduler's tick deliberately does nothing for a workflow being
       cancelled, so a runner that only advanced would spin until it decided
       the workflow was stuck. Cancelling is the move, and it is made before
       any new work is leased. */
    if (before.cancelRequestedAt !== null && !isFinished(before.state)) {
      if (await dispatcher.honourCancellation(hold.workflowId, repo)) moved = true;
      const cancelled = await repo.getWorkflow(hold.workflowId);
      if (cancelled) state = cancelled.state;
    }

    /* ── advancing, under the one deadline ────────────────────────────── */
    stopLeasing = setTimer(() => winding.abort(), Math.max(0, stopLeasingAt - now()));

    while (now() < stopLeasingAt && !winding.signal.aborted && !isFinished(state)) {
      const pass: WorkflowPass | null = await dispatcher.advance(hold.workflowId);
      passes += 1;
      if (!pass) { problems.push("workflow_not_advanceable"); break; }
      ticks += pass.ticks;
      state = pass.state;
      last = pass;
      deferred += pass.deferred;
      if (pass.worked) moved = true;

      if (isFinished(pass.state)) { stopReason = "workflow_reached_a_terminal_state"; break; }

      /* Work this pass leased and handed back for want of time. There is more
         to do and the clock is why it is not being done, which is a different
         answer from every other one this loop can give. */
      if (pass.deferred > 0 && !pass.worked) { stopReason = "no_time_left_in_this_pass"; break; }

      /* Nothing runnable, nothing running, nothing to reconcile and nothing
         this process is still waiting on. The engine has done what it can and
         the workflow is somebody's to look at. */
      if (pass.quiet && !machineCanStillAct(pass)) { stopReason = "handed_to_a_person"; break; }
    }
    if (stopReason === "more_work_remains" && now() >= stopLeasingAt && deferred > 0) {
      stopReason = "no_time_left_in_this_pass";
    }

    /* Waits for what is already in flight rather than dropping it: an attempt
       abandoned halfway is an outcome nobody will ever know, and this engine
       never buys one of those twice. */
    await dispatcher.stop();
    dispatcher = null;

    const after = await repo.getWorkflow(hold.workflowId);
    if (after) state = after.state;
    if (isFinished(state)) stopReason = "workflow_reached_a_terminal_state";
  } catch (error) {
    problems.push(problemToken(error));
    say("runner.pass_failed", { workflow: hold.workflowId, problem: problemToken(error) });
  } finally {
    if (stopLeasing !== null) clearTimer(stopLeasing);
    if (dispatcher) { try { await dispatcher.stop(); } catch { /* already going */ } }
  }

  /* ── WAITING IS NOT BEING STUCK ─────────────────────────────────────
     A pass that moved nothing because something else holds a live lease —
     another runner, or an attempt this process is still waiting on — has not
     failed to advance the workflow. It has correctly declined to interfere
     with work in progress. Counting that towards the "five passes moved
     nothing" fuse would settle a perfectly healthy workflow because a sibling
     was busy, so it does not count: the pass reports movement and comes back
     when the lease it is waiting on could no longer be alive.

     This cannot wait forever. A lease either finishes or expires, and an
     expired lease is reclaimed by the very next tick — which IS movement. The
     hard ceiling on continuations in migration 060 remains the backstop
     underneath all of it. */
  const waiting = stopReason === "more_work_remains" && !moved && last !== null &&
    (last.remaining.busy > 0 || last.remaining.inFlight > 0);
  if (waiting) stopReason = "waiting_for_a_live_lease";

  /* ── saying when to come back, before returning ───────────────────── */
  let scheduledAgain = false;
  try {
    if (stopReason === "handed_to_a_person" && !isFinished(state)) {
      /* THE WORKFLOW IS TOLD, NOT ONLY THE CONTINUATION.
         Settling the continuation alone left a workflow that still said
         `running` with nothing that would ever run it — the exact state
         nobody should be able to reach. The workflow's own state is written
         first, through the transitions 058 already defines, so that a person
         reading the workflow sees the same fact as a person reading the
         continuation. */
      const stopped = await options.store.stopForGood(hold.workflowId, "handed_to_a_person");
      finalStop = { reason: "handed_to_a_person", workflowState: (stopped.workflowState ?? state) as WorkflowState | null };
      /* The hold is released by settling; nothing schedules this again. */
      say("runner.handed_to_a_person", { workflow: hold.workflowId, state: finalStop.workflowState });
      state = finalStop.workflowState;
    } else {
      const released = await options.store.release({
        workflowId: hold.workflowId,
        holdToken: hold.holdToken,
        /* Movement, deferral and waiting all mean the same thing to the fuse:
           this pass is not evidence that the workflow cannot be advanced. */
        moved: moved || deferred > 0 || waiting,
        /* A pass that moved something, or left queued work behind, comes
           straight back: the clock, not the work, is why it stopped. A pass
           waiting on somebody else's lease comes back when that lease can no
           longer be alive. A pass that moved nothing lets the record's own
           backoff decide. */
        nextDueAt: waiting ? new Date(now() + clock.taskLeaseMs)
          : (moved || deferred > 0) ? new Date(now()) : null,
        error: problems.length > 0 ? problems[0] : null,
      });
      if (released === null) {
        stopReason = "hold_was_not_ours";
        say("runner.hold_expired", { workflow: hold.workflowId });
      } else {
        scheduledAgain = released.state !== "settled";
        /* THE SQL'S OWN FUSES ALSO END A WORKFLOW, AND THE WORKFLOW IS TOLD.
           core_v2_release_continuation settles the row itself when the idle
           streak or the continuation ceiling is reached. Before this, that
           left the same orphan: a settled continuation and a workflow still
           claiming to be running. The reason the SQL gave is carried straight
           through to the workflow's own error code. */
        if (released.state === "settled" && released.settledReason && !isFinished(state)) {
          /* The SQL settled the row itself, so the workflow is told through
             the same door — bounded, idempotent, and it writes only to a
             workflow that is behind. */
          await options.store.finishStoppedWorkflows(5);
          const after = repo ? await repo.getWorkflow(hold.workflowId) : null;
          finalStop = { reason: released.settledReason, workflowState: after ? after.state : state };
          state = finalStop.workflowState;
        }
        say("runner.released", {
          workflow: hold.workflowId, state, moved, deferred,
          continuation_state: released.state,
          idle_streak: released.idleStreak,
          settled: released.settledReason,
          final_stop: finalStop ? finalStop.reason : null,
        });
      }
    }
  } catch (error) {
    problems.push(problemToken(error));
  } finally {
    if (options.release) await options.release(client).catch(() => undefined);
  }

  return {
    workflowId: hold.workflowId,
    claimed: true,
    continuations: hold.continuations,
    state,
    moved,
    stopReason,
    scheduledAgain,
    deferred,
    finalStop,
    ticks,
    passes,
    elapsedMs: now() - startedAt,
    problems,
  };
}

/* ─────────────────────────────────────────── the workflow is told, too
 *
 * KEPT FOR ONE CALLER AND ONE REASON. Migration 062 does this in SQL, in the
 * same statement that settles the continuation, and that is what the runner
 * uses. This walker remains for a repository that is not Postgres — the
 * in-memory one a test may hand in — and for the material refusal, which has
 * no continuation to settle alongside.
 */
/*
 *
 * When a pass stops a workflow for good — a person is needed, five passes
 * moved nothing, the continuation ceiling was reached — the continuation is
 * settled, and settling is absorbing. If the workflow itself still said
 * `running`, the two records would disagree forever: `status` would report a
 * running analysis, and nothing anywhere would ever run it.
 *
 * So the workflow is moved too, using only the transitions migration 058
 * already allows:
 *
 *     planning · running · ready_for_decision · deciding  →  needs_attention
 *     queued                                              →  failed
 *     created                                             →  queued → failed
 *
 * `needs_attention` is not terminal, and that is deliberate: a person can act
 * on it, and a cancellation can still reach it. `failed` is used only where
 * `needs_attention` is not a legal destination — a workflow that never got
 * past its own start handshake did not need attention, it did not begin.
 *
 * Anything already terminal is left exactly as it is, and a workflow already
 * at `needs_attention` is not moved to itself; both simply record the reason.
 */
export async function recordFinalStop(
  repo: OrchestrationRepository | null,
  workflowId: string,
  reason: string,
  fallbackState: WorkflowState | null,
): Promise<{ reason: string; workflowState: WorkflowState | null }> {
  if (!repo) return { reason, workflowState: fallbackState };
  try {
    const workflow = await repo.getWorkflow(workflowId);
    if (!workflow) return { reason, workflowState: fallbackState };
    if (isFinished(workflow.state)) return { reason, workflowState: workflow.state };

    const patch = { errorCode: "runner_stopped", errorMessage: reason };
    const note = async (state: WorkflowState) => {
      await repo.audit({
        action: "core_v2.workflow.runner_stopped", entityType: "intelligence_workflow", entityId: workflowId,
        detail: { reason, from: workflow.state, to: state },
      });
    };

    /* ALREADY WHERE IT WOULD BE MOVED TO — AND STILL TOLD.
       The transition table has no self-loop for `needs_attention` and should
       not gain one, so the reason is written directly onto the two columns
       migration 058 allows a workflow to change. The state does not move; the
       record stops disagreeing with itself. */
    if (workflow.state === "needs_attention") {
      const noted = await repo.noteWorkflowStopped(workflowId, patch.errorCode, patch.errorMessage);
      await note(noted.state);
      return { reason, workflowState: noted.state };
    }
    if (["planning", "running", "ready_for_decision", "deciding"].includes(workflow.state)) {
      const moved = await repo.transitionWorkflow(workflowId, workflow.state, "needs_attention", patch);
      await note(moved.state);
      return { reason, workflowState: moved.state };
    }
    if (workflow.state === "queued") {
      const moved = await repo.transitionWorkflow(workflowId, "queued", "failed", patch);
      await note(moved.state);
      return { reason, workflowState: moved.state };
    }
    if (workflow.state === "created") {
      /* It never got through its own start handshake. Both moves are legal
         and the end state is the honest one: it did not begin. */
      await repo.transitionWorkflow(workflowId, "created", "queued");
      const moved = await repo.transitionWorkflow(workflowId, "queued", "failed", patch);
      await note(moved.state);
      return { reason, workflowState: moved.state };
    }
    return { reason, workflowState: workflow.state };
  } catch {
    /* Somebody else moved it first. The record is the authority and it has
       already been written by whoever won. */
    return { reason, workflowState: fallbackState };
  }
}
