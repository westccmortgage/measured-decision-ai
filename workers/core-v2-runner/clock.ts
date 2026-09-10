/* ONE CLOCK, FOR EVERY WAIT THE RUNNER AUTHORISES.
 *
 * The first paid canary lost more readings to arithmetic than to any model.
 * Four numbers governed how long things could take — how long a provider was
 * allowed to answer, how long a task lease lasted, when the operator stopped
 * starting work, and how long the operator itself lived — and they were
 * written in four places by four different judgements. Every one of the
 * failures that followed was the same failure:
 *
 *   · a provider was allowed two minutes by an operator that lived two and a
 *     half and started its last request forty-five seconds in. A request
 *     still outstanding when the container went is not a slow call — it is an
 *     attempt whose outcome nobody will ever know, and this engine never
 *     retries one of those, so each one cost a subject its coverage;
 *   · a task lease lasted five minutes, held by a process that lived two and
 *     a half. The next pass found four readers marked leased and running by
 *     something that no longer existed, could not reclaim them because their
 *     leases were still in the future, and declared the workflow stalled —
 *     a whole pass, no work;
 *   · the moment to stop starting work was picked by hand next to a
 *     two-minute provider timeout. The arithmetic did not hold, and the pass
 *     spent a third of its life working and the rest not allowed to.
 *
 * None of those is a hard problem. They are one piece of arithmetic written
 * once, which is what this file is. Every wait the runner authorises is
 * derived from the lifetime it was actually given, and the derivation refuses
 * to produce a budget that cannot hold — a lease that outlives its operator,
 * a window with no room to start anything, a heartbeat that cannot keep a
 * lease alive.
 *
 * Nothing here knows what a provider is. It is arithmetic about time.
 */

export type ClockRequest = {
  /* What the platform gives this invocation, wall to wall. Supabase's Edge
     Runtime is about 150s; a local process may be given far more. */
  lifetimeMs: number;
  /* Returned-before-killed margin. The runner must finish writing what it
     learned, and a process killed mid-write is the one thing no amount of
     durability downstream can repair. */
  safetyMs?: number;
  /* The longest a provider may take. Measured, not chosen: across the paid
     canary every answer that actually arrived came back between six and
     twenty seconds, and the two readers ever cut off by this were cut off at
     thirty and at forty-five. */
  answerWithinMs?: number;
  /* What a finished answer still needs: parsed, validated, priced, settled,
     its claims and anchors written, its task closed. */
  settlementRoomMs?: number;
  /* How often a live attempt renews its task lease. */
  heartbeatIntervalMs?: number;
  /* How far past the operator's own death a lease may stand. Small on
     purpose: this is the window in which a dead runner's work is
     unreclaimable, and every millisecond of it is a millisecond the next
     runner can do nothing about. */
  graceMs?: number;
};

export type InvocationClock = {
  readonly lifetimeMs: number;
  readonly safetyMs: number;
  /* When this invocation must have returned. */
  readonly deadlineMs: number;
  readonly answerWithinMs: number;
  readonly settlementRoomMs: number;
  readonly heartbeatIntervalMs: number;
  readonly graceMs: number;
  /* When the runner stops LEASING new work, as opposed to when it stops.
     Derived, never chosen: the last request started must be able to answer
     inside its window and still be written down before the deadline. */
  readonly stopLeasingMs: number;
  /* How long a task lease lasts. Long enough to outlive one attempt, short
     enough that a runner which dies does not hold work hostage. */
  readonly taskLeaseMs: number;
  /* How long the runner holds its continuation. It must outlive the whole
     invocation — a hold that expires mid-pass invites a second runner into
     work already in flight — and it must not outlive it by much. */
  readonly runnerHoldMs: number;
  /* Every number, for a log line or a report. */
  describe(): Record<string, number>;
};

const DEFAULTS = {
  safetyMs: 10_000,
  answerWithinMs: 60_000,
  settlementRoomMs: 20_000,
  heartbeatIntervalMs: 20_000,
  graceMs: 30_000,
};

export class ClockBudgetImpossible extends Error {
  readonly reasons: string[];
  constructor(reasons: string[]) {
    super(`core-v2-runner: this lifetime cannot hold these waits — ${reasons.join("; ")}`);
    this.name = "ClockBudgetImpossible";
    this.reasons = reasons;
  }
}

/* Builds the budget, or refuses. Refusing is the point: a runner started with
   a lifetime too short for the waits it would authorise is a runner that will
   orphan attempts, and it is better to say so at construction than to
   discover it one paid request at a time. */
export function invocationClock(request: ClockRequest): InvocationClock {
  const lifetimeMs = Math.trunc(request.lifetimeMs);
  const safetyMs = Math.trunc(request.safetyMs ?? DEFAULTS.safetyMs);
  const answerWithinMs = Math.trunc(request.answerWithinMs ?? DEFAULTS.answerWithinMs);
  const settlementRoomMs = Math.trunc(request.settlementRoomMs ?? DEFAULTS.settlementRoomMs);
  const heartbeatIntervalMs = Math.trunc(request.heartbeatIntervalMs ?? DEFAULTS.heartbeatIntervalMs);
  const graceMs = Math.trunc(request.graceMs ?? DEFAULTS.graceMs);

  const reasons: string[] = [];
  const positive = (name: string, value: number) => {
    if (!Number.isFinite(value) || value <= 0) reasons.push(`${name} must be a number above zero and is ${value}`);
  };
  positive("lifetimeMs", lifetimeMs);
  positive("answerWithinMs", answerWithinMs);
  positive("settlementRoomMs", settlementRoomMs);
  positive("heartbeatIntervalMs", heartbeatIntervalMs);
  if (!Number.isFinite(safetyMs) || safetyMs < 0) reasons.push(`safetyMs must not be negative and is ${safetyMs}`);
  if (!Number.isFinite(graceMs) || graceMs < 0) reasons.push(`graceMs must not be negative and is ${graceMs}`);
  if (reasons.length > 0) throw new ClockBudgetImpossible(reasons);

  const deadlineMs = lifetimeMs - safetyMs;
  if (deadlineMs <= 0) {
    throw new ClockBudgetImpossible([`a lifetime of ${lifetimeMs}ms with a ${safetyMs}ms margin leaves no time at all`]);
  }

  const stopLeasingMs = deadlineMs - answerWithinMs - settlementRoomMs;
  if (stopLeasingMs <= 0) {
    throw new ClockBudgetImpossible([
      `there is no moment at which work could be started: ${deadlineMs}ms of usable life, minus ${answerWithinMs}ms for an answer and ${settlementRoomMs}ms to write it down, leaves ${stopLeasingMs}ms`,
    ]);
  }

  /* A lease outlives one attempt — its answer plus the room to settle it —
     and then a little, so the last heartbeat before a slow finish does not
     land after expiry. It is capped at the operator's own life plus the
     grace, because THAT is the rule the canary learned the hard way: a lease
     may not outlive the operator that owns it by minutes. */
  const wanted = answerWithinMs + settlementRoomMs + heartbeatIntervalMs * 2;
  const taskLeaseMs = Math.min(wanted, deadlineMs + graceMs);
  if (taskLeaseMs <= heartbeatIntervalMs * 2) {
    throw new ClockBudgetImpossible([
      `a lease of ${taskLeaseMs}ms cannot be kept alive by a heartbeat every ${heartbeatIntervalMs}ms`,
    ]);
  }

  const runnerHoldMs = deadlineMs + graceMs;

  const numbers = {
    lifetimeMs, safetyMs, deadlineMs, answerWithinMs, settlementRoomMs,
    heartbeatIntervalMs, graceMs, stopLeasingMs, taskLeaseMs, runnerHoldMs,
  };
  return { ...numbers, describe: () => ({ ...numbers }) };
}

/* The Supabase Edge Runtime's own life, and what this repository has measured
   about it: a request is cut off around 150 seconds. Everything else follows
   from that one number. */
export const EDGE_FUNCTION_LIFETIME_MS = 150_000;
