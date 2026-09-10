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
 *   1. claims ONE due continuation — one statement, under SKIP LOCKED, so a
 *      second runner that overlaps this one takes a different workflow or
 *      none at all;
 *   2. if that workflow has never been begun, finishes the start handshake
 *      058 defines: claim the command, plan, acknowledge;
 *   3. authorises spending ONLY if the workflow has no budget yet. A
 *      continuation inherits the authority its workflow was started under.
 *      Re-authorising is not a smaller mistake than over-spending; it is the
 *      same mistake with a better story;
 *   4. advances that one workflow, and only that one, until the clock says
 *      stop leasing — then waits for what is already in flight rather than
 *      abandoning it;
 *   5. says when to come back, in the record, before it returns.
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
import type { ContinuationStore } from "./continuations.ts";

/* The states after which nothing this engine can do will move the workflow.
   The same list migration 060 settles a continuation on, kept here so a
   reader of either can check the other. */
export const RUNNER_FINISHED_STATES: readonly WorkflowState[] = ["completed", "partial", "failed", "cancelled"];

/* Why this invocation stopped scheduling the workflow it held. */
export type StopReason =
  | "workflow_reached_a_terminal_state"
  | "handed_to_a_person"
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
  const startedAt = now();
  const problems: string[] = [];
  /* The dispatcher calls its sink unconditionally, so a runner started
     without one hands it a no-op rather than an undefined. */
  const emit: EventSink = options.events ?? (() => {});
  const say = (event: string, detail: Record<string, unknown> = {}) => {
    emit({ at: now(), dispatcher: options.name, event, ...detail } as never);
  };

  const idle = (): PassOutcome => ({
    workflowId: null, claimed: false, continuations: 0, state: null, moved: false,
    stopReason: null, scheduledAgain: false, ticks: 0, passes: 0,
    elapsedMs: now() - startedAt, problems,
  });

  /* ── the hold ───────────────────────────────────────────────────────── */
  const hold = await options.store.claim(options.name, clock.runnerHoldMs);
  if (!hold) { say("runner.nothing_due"); return idle(); }
  say("runner.holding", { workflow: hold.workflowId, continuation: hold.continuations });

  const client = await options.connect();
  let moved = false;
  let ticks = 0;
  let passes = 0;
  let state: WorkflowState | null = null;
  let stopReason: StopReason = "more_work_remains";
  let dispatcher: Dispatcher | null = null;
  const winding = new AbortController();
  let stopLeasing: unknown = null;

  try {
    const repo = options.world.repository(client);

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
      repository: () => repo,
      pack: options.world.pack,
      executors: options.world.executors,
      routing: options.world.routing,
      policy: policyForClock(clock, options.policy, options.concurrentAttempts),
      leaseTtlMs: clock.taskLeaseMs,
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

    /* ── advancing, under the clock ───────────────────────────────────── */
    stopLeasing = setTimer(() => winding.abort(), clock.stopLeasingMs);
    const leaseUntil = startedAt + clock.stopLeasingMs;

    while (now() < leaseUntil && !winding.signal.aborted && !isFinished(state)) {
      const pass: WorkflowPass | null = await dispatcher.advance(hold.workflowId);
      passes += 1;
      if (!pass) { problems.push("workflow_not_advanceable"); break; }
      ticks += pass.ticks;
      state = pass.state;
      if (pass.worked) moved = true;

      if (isFinished(pass.state)) { stopReason = "workflow_reached_a_terminal_state"; break; }

      /* Nothing runnable, nothing running, nothing to reconcile and nothing
         this process is still waiting on. The engine has done what it can and
         the workflow is somebody's to look at. */
      if (pass.quiet && !machineCanStillAct(pass)) { stopReason = "handed_to_a_person"; break; }
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

  /* ── saying when to come back, before returning ───────────────────── */
  let scheduledAgain = false;
  try {
    if (stopReason === "handed_to_a_person" && !isFinished(state)) {
      await options.store.settle(hold.workflowId, "handed_to_a_person");
      /* The hold is released by settling; nothing schedules this again. */
      say("runner.handed_to_a_person", { workflow: hold.workflowId, state });
    } else {
      const released = await options.store.release({
        workflowId: hold.workflowId,
        holdToken: hold.holdToken,
        moved,
        /* A pass that moved something comes straight back: there is more to
           do and the clock, not the work, is why it stopped. A pass that
           moved nothing lets the record's own backoff decide. */
        nextDueAt: moved ? new Date(now()) : null,
        error: problems.length > 0 ? problems[0] : null,
      });
      if (released === null) {
        stopReason = "hold_was_not_ours";
        say("runner.hold_expired", { workflow: hold.workflowId });
      } else {
        scheduledAgain = released.state !== "settled";
        say("runner.released", {
          workflow: hold.workflowId, state, moved,
          continuation_state: released.state,
          idle_streak: released.idleStreak,
          settled: released.settledReason,
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
    ticks,
    passes,
    elapsedMs: now() - startedAt,
    problems,
  };
}
