/* THE DURABLE DISPATCHER: WHAT TURNS A COMMITTED COMMAND INTO A RUNNING WORKFLOW.
 *
 * The engine schedules; this decides which workflow it schedules and when it
 * stops. Everything durable about that decision lives in the database, not
 * in this process:
 *
 *   · work is claimed through a door that takes one waiting command under a
 *     lock and skips the rows another dispatcher is holding, so several
 *     dispatchers on one queue start a workflow exactly once;
 *   · the command is acknowledged only after ownership is durable — the
 *     workflow has left `created` and its phase-A tasks are admitted. A
 *     dispatcher that dies in between leaves a `dispatching` command and a
 *     `queued` workflow, and whoever picks that workflow up finishes the
 *     handshake, because a queued workflow plans itself on its next tick;
 *   · a restart takes up every workflow that is past the door and unfinished;
 *     leases decide who runs which task, so several dispatchers may look at
 *     one workflow and only one of them gets each piece of it;
 *   · cancellation is honoured wherever it was asked for, including on a
 *     workflow no dispatcher currently holds.
 *
 * Every pass is bounded. A pass runs at most `ticksPerPass` scheduler ticks
 * per workflow and touches at most `workflowsPerPass` workflows; it never
 * loops until the work is gone. With nothing to do it backs off — doubling,
 * to a ceiling, with a little jitter — rather than asking the database the
 * same question forever. Shutdown stops the next pass from taking new work,
 * lets the pass in flight settle, and returns.
 *
 * What it will not do:
 *   · plan, route, validate or retry anything itself — that is the kernel's
 *     work and this file only drives it;
 *   · consider a retry before an attempt whose outcome is unknown has been
 *     put to its executor: the tick reconciles first, and an unknown outcome
 *     is terminal until a person says otherwise;
 *   · leave a workflow saying `running` when nothing is runnable, leased or
 *     reconcilable — such a workflow is moved to a state a person can act on;
 *   · put anything in its event stream but ids, counts and its own
 *     vocabulary. A source's words, a person's words and anything shaped like
 *     a credential are refused by the sink itself, not by good manners.
 *
 * It names no provider and knows nothing about what the work is about. Every
 * moving part — the connection, the repository, the pack, the executors, the
 * clock, the sink and the shutdown signal — is handed in.
 */
import type { SourceManifest, WorkflowRecord, WorkflowState } from "../core-v2/kernel/contracts.ts";
import { ACTIVE_WORKFLOW_STATES } from "../core-v2/kernel/contracts.ts";
import type { DomainPack } from "../core-v2/kernel/domain.ts";
import type { ExecutorRegistry } from "../core-v2/kernel/executors.ts";
import { workflowRecordFor } from "../core-v2/kernel/planning.ts";
import type { OrchestrationPolicy } from "../core-v2/kernel/policy.ts";
import { DEFAULT_POLICY, budgetOf } from "../core-v2/kernel/policy.ts";
import type { OrchestrationRepository } from "../core-v2/kernel/repository.ts";
import { AgentRouter } from "../core-v2/kernel/router.ts";
import type { RoutingTable } from "../core-v2/kernel/router.ts";
import { Scheduler } from "../core-v2/kernel/scheduler.ts";
import { TERMINAL_WORKFLOW_STATES } from "../core-v2/kernel/transitions.ts";
import type { Queryable } from "../core-v2/postgres/wire.ts";

/* ───────────────────────────────────────────────── the operational stream */

export type EventValue = string | number | boolean | null;

/* One JSON object per line. `at`, `dispatcher` and `event` are always there;
   everything else is what that event has to say, and every value of it has
   passed the rule below. */
export type OperationalEvent = { at: number; dispatcher: string; event: string } & Record<string, EventValue>;

export type EventSink = (event: OperationalEvent) => void;

/* What an operational value may look like: a number, a flag, or a short
   token of the dispatcher's own vocabulary — an id, a state, a task type, a
   name. Anything with a space, a slash, a newline, anything long, and
   anything that reads like a credential is not operational and does not
   travel. This is why a subject a source named, a sentence a person wrote and
   a key of any kind cannot appear in the stream even by accident. */
const OPERATIONAL = /^[A-Za-z0-9][A-Za-z0-9_.:+@-]{0,63}$/;
const CREDENTIAL_SHAPED = /key|secret|token|bearer|password|credential|authoriz|authoris|passwd|sk-|api[_.-]?k/i;
export const NOT_OPERATIONAL = "[withheld]";

export function operationalValue(value: unknown): EventValue {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return NOT_OPERATIONAL;
  if (!OPERATIONAL.test(value) || CREDENTIAL_SHAPED.test(value)) return NOT_OPERATIONAL;
  return value;
}

/* The default sink: one line of JSON per event. */
export function jsonLines(write: (line: string) => void): EventSink {
  return (event: OperationalEvent) => write(JSON.stringify(event));
}

/* A short token for what went wrong, never the sentence. A sentence may carry
   a locator, a subject or a fragment of somebody's source; a class of failure
   carries none of that and is what an operator scans for. */
export function problemToken(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && OPERATIONAL.test(code)) return code;
  const message = String((error as { message?: unknown } | null)?.message ?? error ?? "");
  if (/is stale|not .* the caller/.test(message)) return "stale_state";
  if (/cannot go from/.test(message)) return "illegal_transition";
  if (/budget|exceeds/.test(message)) return "over_budget";
  if (/refused/.test(message)) return "refused";
  if (/still working after/.test(message)) return "not_quiet_yet";
  return "engine_error";
}

/* ────────────────────────────────────────────────────────── what it is given */

export type BackoffSettings = {
  /* The first wait after a pass that found nothing. */
  baseMs: number;
  /* The longest it will ever wait, however long the queue stays empty. */
  ceilingMs: number;
  /* A fraction of the delay, added at random, so a fleet of dispatchers that
     started together does not ask the same question in the same millisecond. */
  jitter: number;
  random: () => number;
};

export const DEFAULT_BACKOFF: BackoffSettings = { baseMs: 250, ceilingMs: 30_000, jitter: 0.2, random: Math.random };

export type DispatcherOptions = {
  /* What this dispatcher claims work under. It goes in the outbox row, on
     every lease it takes, and in its events. */
  name: string;
  /* A connection of its own. Two dispatchers must not share one. */
  connect: () => Promise<Queryable & { end?: () => Promise<void> }>;
  /* The record, over that connection. */
  repository: (client: Queryable) => OrchestrationRepository;
  pack: DomainPack;
  /* The executors a workflow's scheduler is given. A function, because one
     instance is one independence domain and a caller may want a different
     set per workflow. */
  executors: (manifest: SourceManifest) => ExecutorRegistry;
  events: EventSink;
  now: () => number;
  /* How a pass waits. Injected, so a test never sleeps. */
  sleep?: (ms: number) => Promise<void>;
  /* A person's shutdown, or the process's. */
  signal?: AbortSignal;
  policy?: OrchestrationPolicy;
  routing?: RoutingTable;
  leaseTtlMs?: number;
  /* The bounds of one pass. */
  ticksPerPass?: number;
  workflowsPerPass?: number;
  resumeLimit?: number;
  backoff?: Partial<BackoffSettings>;
};

export type WorkRemaining = { runnable: number; busy: number; reconcilable: number; inFlight: number };

export type WorkflowPass = {
  workflowId: string;
  state: WorkflowState;
  ticks: number;
  worked: boolean;
  quiet: boolean;
  remaining: WorkRemaining;
  needsPerson: boolean;
};

export type PassReport = {
  accepting: boolean;
  claimed: string[];
  resumed: string[];
  cancelled: string[];
  workflows: WorkflowPass[];
  idle: boolean;
  idleStreak: number;
  backoffMs: number;
};

type Held = {
  workflowId: string;
  manifest: SourceManifest;
  scheduler: Scheduler;
};

const TERMINAL: string[] = TERMINAL_WORKFLOW_STATES;

/* ─────────────────────────────────────────────────────────── the dispatcher */

export class Dispatcher {
  readonly name: string;
  private options: DispatcherOptions;
  private policy: OrchestrationPolicy;
  private backoff: BackoffSettings;
  private router: AgentRouter;
  private client: (Queryable & { end?: () => Promise<void> }) | null = null;
  private repo: OrchestrationRepository | null = null;
  private held = new Map<string, Held>();
  private queue: Promise<unknown> = Promise.resolve();
  private loop: Promise<void> | null = null;
  private stopping = false;
  private started = false;
  /* Set once, if the queue door of migration 059 cannot be used; the claim
     then goes through 058's own door under the same lock. */
  private queueDoorUsable = true;
  /* Workflows of another pack, announced once rather than every pass. */
  private foreign = new Set<string>();
  private idleStreak = 0;

  constructor(options: DispatcherOptions) {
    this.options = options;
    this.name = options.name;
    if (!this.name || !OPERATIONAL.test(this.name)) throw new Error("core-v2 runtime: a dispatcher claims work under a short plain name of its own");
    this.policy = options.policy ?? DEFAULT_POLICY;
    this.backoff = { ...DEFAULT_BACKOFF, ...(options.backoff ?? {}) };
    this.router = new AgentRouter(options.routing);
  }

  /* ───────────────────────────────────────────────── running and stopping */

  /* Accepts new work while nobody has asked it to stop. */
  accepting(): boolean {
    return !this.stopping && !(this.options.signal?.aborted ?? false);
  }

  /* One pass, serialised behind whatever pass is already running. */
  runOnce(): Promise<PassReport> {
    const next = this.queue.then(() => this.pass(), () => this.pass());
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }

  /* Passes until there is nothing left to do, or the bound is reached.
     Deterministic: it never waits, so a test drives it with no timers. */
  async drain(maxPasses = 200): Promise<PassReport[]> {
    const reports: PassReport[] = [];
    for (let i = 0; i < maxPasses; i++) {
      const report = await this.runOnce();
      reports.push(report);
      if (!report.accepting || report.idle) break;
    }
    return reports;
  }

  /* The long-running form: pass, wait the back-off, pass again. Returns as
     soon as the loop is under way; `stop()` ends it. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.emit("dispatcher.started", { ticks_per_pass: this.ticksPerPass, workflows_per_pass: this.workflowsPerPass });
    const sleep = this.options.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
    this.loop = (async () => {
      while (this.accepting()) {
        let wait = this.backoff.baseMs;
        try {
          const report = await this.runOnce();
          wait = report.backoffMs;
        } catch (error) {
          this.emit("pass.error", { problem: problemToken(error) });
        }
        if (!this.accepting() || wait <= 0) continue;
        await sleep(wait);
      }
    })();
  }

  /* Stops taking new work, lets the pass in flight settle, and returns. */
  async stop(): Promise<void> {
    if (!this.stopping) {
      this.stopping = true;
      this.emit("dispatcher.stopping", { held: this.held.size });
    }
    if (this.loop) { await this.loop.catch(() => undefined); this.loop = null; }
    await this.queue.catch(() => undefined);
    const client = this.client;
    this.client = null;
    this.repo = null;
    this.held.clear();
    this.started = false;
    if (client && client.end) await client.end().catch(() => undefined);
    this.emit("dispatcher.stopped", {});
  }

  /* ─────────────────────────────────────────────────────── one whole pass */

  private async pass(): Promise<PassReport> {
    const report: PassReport = { accepting: this.accepting(), claimed: [], resumed: [], cancelled: [], workflows: [], idle: true, idleStreak: this.idleStreak, backoffMs: 0 };
    if (!report.accepting) {
      this.emit("pass.refused", { reason: "shutting_down" });
      return report;
    }
    const repo = await this.record();

    /* A cancellation is honoured before anything else is dispatched, and
       wherever it was asked for — including on a workflow this process has
       never held. */
    report.cancelled = await this.honourCancellations(repo);

    const resumable = await this.resumableWorkflows();
    const unreconciled = await this.unreconciledWorkflows();
    if (this.held.size < this.workflowsPerPass) {
      const claimed = await this.claim();
      if (claimed) {
        report.claimed.push(claimed);
        await this.establishOwnership(claimed);
      } else if (resumable.length === 0) {
        this.emit("outbox.empty", {});
      }
    }

    const order: string[] = [];
    for (const id of [...report.claimed, ...resumable, ...unreconciled]) if (!order.includes(id)) order.push(id);
    report.resumed = resumable.filter((id) => !report.claimed.includes(id));

    for (const workflowId of order.slice(0, this.workflowsPerPass + unreconciled.length)) {
      if (!this.accepting()) break;
      try {
        const pass = await this.advance(workflowId);
        if (pass) report.workflows.push(pass);
      } catch (error) {
        this.held.delete(workflowId);
        this.emit("workflow.error", { workflow: workflowId, problem: problemToken(error) });
      }
    }

    report.idle = report.claimed.length === 0 && report.cancelled.length === 0 && report.workflows.every((w) => !w.worked);
    report.backoffMs = this.nextBackoff(report.idle);
    report.idleStreak = this.idleStreak;
    if (report.idle) this.emit("pass.idle", { streak: this.idleStreak, backoff_ms: report.backoffMs });
    return report;
  }

  /* ─────────────────────────────────────────────────────── claiming work */

  /* One waiting start command, claimed under a lock that another dispatcher
     skips rather than waits for. The workflow leaves `created` in the same
     statement; the command is NOT acknowledged here, because nothing durable
     is owned yet. */
  async claim(): Promise<string | null> {
    const client = await this.connection();
    if (this.queueDoorUsable) {
      try {
        const r = await client.query(`select public.core_v2_claim_next_workflow($1) as workflow_id`, [this.name]);
        const id = r.rows.length ? r.rows[0].workflow_id : null;
        if (id) this.emit("outbox.claimed", { workflow: id, door: "core_v2_claim_next_workflow" });
        return id;
      } catch (error) {
        /* The queue door of 059 is unusable in this database. The claim still
           happens under a lock, through 058's own door, in one transaction —
           and an operator is told, once, that it happened this way. */
        this.queueDoorUsable = false;
        this.emit("door.unavailable", { door: "core_v2_claim_next_workflow", instead: "core_v2_claim_outbox", problem: problemToken(error) });
      }
    }
    const id = await this.claimUnderLock(client);
    if (id) this.emit("outbox.claimed", { workflow: id, door: "core_v2_claim_outbox" });
    return id;
  }

  /* The same two moves the queue door makes: find one waiting command whose
     workflow has not started, holding its row and skipping rows others hold,
     and claim it through 058 in the same transaction. */
  private async claimUnderLock(client: Queryable & { transaction?: <T>(fn: (tx: Queryable) => Promise<T>) => Promise<T> }): Promise<string | null> {
    const body = async (tx: Queryable): Promise<string | null> => {
      const found = await tx.query(
        `select o.workflow_id from public.workflow_outbox o
           join public.intelligence_workflows w on w.id = o.workflow_id
          where o.state = 'pending' and o.available_at <= now() and w.state = 'created'
          order by o.available_at, o.id
          for update of o skip locked
          limit 1`);
      if (!found.rows.length) return null;
      const workflowId = found.rows[0].workflow_id!;
      const claimed = await tx.query(`select (public.core_v2_claim_outbox($1, $2)).state as state`, [workflowId, this.name]);
      return claimed.rows.length && claimed.rows[0].state !== null ? workflowId : null;
    };
    return client.transaction ? client.transaction(body) : body(client);
  }

  /* Ownership becomes durable here: the workflow plans its phase A and only
     then is the command acknowledged. Both are the kernel's own moves; this
     just says when they happen and what it saw. */
  async establishOwnership(workflowId: string): Promise<boolean> {
    let held: Held;
    try { held = await this.hold(workflowId); }
    catch (error) { this.emit("workflow.refused", { workflow: workflowId, problem: problemToken(error) }); return false; }
    try {
      const planned = await held.scheduler.plan();
      const workflow = await (await this.record()).getWorkflow(workflowId);
      this.emit("workflow.owned", {
        workflow: workflowId, tasks_admitted: planned.created.length, tasks_existing: planned.existing.length,
        state: workflow ? workflow.state : null,
      });
      return true;
    } catch (error) {
      this.held.delete(workflowId);
      this.emit("workflow.refused", { workflow: workflowId, problem: problemToken(error) });
      return false;
    }
  }

  /* What a restart takes up: everything past the door and unfinished. Several
     dispatchers may see one workflow; leases decide who runs what. */
  async resumableWorkflows(): Promise<string[]> {
    const client = await this.connection();
    const r = await client.query(`select w as workflow_id from public.core_v2_resumable_workflows($1::integer) w`, [this.resumeLimit]);
    return r.rows.map((row) => row.workflow_id!).filter((id): id is string => Boolean(id));
  }

  /* Workflows holding an attempt whose outcome nobody ever saw and whose
     executor has not yet been able to say what became of it. They are asked
     about however the workflow ended: a run that finished with an answer
     still possibly in flight somewhere is exactly the case where the question
     matters, and a workflow past its end is no longer resumable, so nothing
     else would ever ask again. */
  private async unreconciledWorkflows(): Promise<string[]> {
    const client = await this.connection();
    const r = await client.query(
      `select distinct a.workflow_id from public.agent_attempts a
        where a.state = 'outcome_unknown' and a.reconciliation_outcome is null
        limit $1::integer`, [this.resumeLimit]);
    return r.rows.map((row) => row.workflow_id!).filter((id): id is string => Boolean(id));
  }

  /* Workflows somebody asked to stop, wherever they were asked. The record is
     the only place this is known, so a dispatcher that never held one still
     finishes the job. */
  private async cancellingWorkflows(): Promise<string[]> {
    const client = await this.connection();
    const states = ACTIVE_WORKFLOW_STATES.map((s) => `'${s}'`).join(",");
    const r = await client.query(
      `select w.id from public.intelligence_workflows w
        where w.cancel_requested_at is not null and w.state in (${states})
        order by w.cancel_requested_at limit $1::integer`, [this.resumeLimit]);
    return r.rows.map((row) => row.id!).filter((id): id is string => Boolean(id));
  }

  /* ONE WORKFLOW'S CANCELLATION, HONOURED WHEREVER IT WAS ASKED FOR.
   *
   * Public because a caller that holds exactly one workflow — the production
   * runner does — must be able to honour a cancellation on that one without
   * scanning the queue for every other. It was private, and the first version
   * of the runner therefore drove `advance()` straight past a cancelled
   * workflow: the scheduler's tick correctly refuses to do anything for a
   * workflow being cancelled, so nothing happened, forever, and the runner
   * eventually handed a cancelled workflow to a person as though it were
   * merely stuck.
   *
   * Answers true when it did the cancelling, so the caller can tell that from
   * "there was nothing to cancel". */
  async honourCancellation(workflowId: string, repo?: OrchestrationRepository): Promise<boolean> {
    const record = repo ?? await this.record();
    const workflow = await record.getWorkflow(workflowId);
    if (!workflow || workflow.cancelRequestedAt === null) return false;
    if (workflow.domainPack !== this.options.pack.id) return false;
    if (TERMINAL.includes(workflow.state)) return false;
    try {
      const held = await this.hold(workflowId);
      const outcome = await held.scheduler.cancel("cancel_requested");
      this.held.delete(workflowId);
      this.emit("workflow.cancelled", {
        workflow: workflowId, unsent_cancelled: outcome.unsentCancelled,
        submitted_unresolved: outcome.submittedUnresolved, completed_preserved: outcome.completedPreserved,
      });
      return true;
    } catch (error) {
      this.emit("workflow.error", { workflow: workflowId, problem: problemToken(error), during: "cancellation" });
      return false;
    }
  }

  private async honourCancellations(repo: OrchestrationRepository): Promise<string[]> {
    const cancelled: string[] = [];
    for (const workflowId of await this.cancellingWorkflows()) {
      if (await this.honourCancellation(workflowId, repo)) cancelled.push(workflowId);
    }
    return cancelled;
  }

  /* ───────────────────────────────────────────── one workflow, bounded */

  async advance(workflowId: string): Promise<WorkflowPass | null> {
    const repo = await this.record();
    const before = await repo.getWorkflow(workflowId);
    if (!before) { this.held.delete(workflowId); return null; }
    if (before.domainPack !== this.options.pack.id) {
      if (!this.foreign.has(workflowId)) {
        this.foreign.add(workflowId);
        this.emit("workflow.not_mine", { workflow: workflowId, pack: before.domainPack });
      }
      return null;
    }
    /* A workflow that is over is left alone — unless it still holds an
       outcome nobody saw. That question is worth one tick, because the tick
       is where it is put to the executor, and nothing else will ever ask. */
    const over = TERMINAL.includes(before.state);
    if (over) {
      const settled = await this.workRemaining(repo, this.held.get(workflowId) ?? null, workflowId);
      if (settled.reconcilable === 0) {
        this.held.delete(workflowId);
        this.emit("workflow.settled", { workflow: workflowId, state: before.state });
        return null;
      }
    }
    const fresh = !this.held.has(workflowId);
    const held = await this.hold(workflowId);
    if (fresh) this.emit("workflow.resumed", { workflow: workflowId, state: before.state });

    const budget = over ? 1 : this.ticksPerPass;
    let ticks = 0;
    let worked = false;
    let quiet = false;
    while (ticks < budget && this.accepting()) {
      const tick = await held.scheduler.tick();
      ticks++;
      const moved = tick.dispatched.length + tick.released + tick.stopped + tick.reconciled;
      if (moved > 0) worked = true;
      this.emit("workflow.tick", {
        workflow: workflowId, tick: ticks, state: tick.workflowState,
        dispatched: tick.dispatched.length, completed: tick.completed.length, failed: tick.failed.length,
        unknown: tick.unknown.length, cancelled: tick.cancelled.length, reconciled: tick.reconciled,
        released: tick.released, stopped: tick.stopped, children: tick.childrenCreated,
        /* How many subjects were handed to a person, never what they say. */
        escalations: tick.escalations.length, in_flight: held.scheduler.inFlight.size,
      });
      if (moved === 0 && held.scheduler.inFlight.size === 0) { quiet = true; break; }
    }

    /* Quiet within the budget: let the kernel close the workflow the way it
       closes it at the end of a run. One more tick, no more. */
    if (quiet && !over) {
      try { await held.scheduler.runUntilQuiescent(1); }
      catch (error) { this.emit("workflow.busy", { workflow: workflowId, problem: problemToken(error) }); }
    }

    const remaining = await this.workRemaining(repo, held, workflowId);
    let workflow = (await repo.getWorkflow(workflowId))!;

    /* The rule this dispatcher exists to keep: a workflow that says it is
       running has something to run. The question is only asked of a workflow
       that went quiet — a tick that dispatched or released something has not
       yet had the chance to make the next thing runnable, and a pass whose
       budget ran out in the middle of the work is not evidence of anything. */
    if (quiet && workflow.state === "running" && idleWork(remaining)) {
      this.emit("workflow.stalled", { workflow: workflowId, state: workflow.state });
      try { workflow = await repo.transitionWorkflow(workflowId, "running", "needs_attention", { errorCode: "nothing_runnable", errorMessage: "nothing is runnable, leased or reconcilable" }); }
      catch (error) { this.emit("workflow.error", { workflow: workflowId, problem: problemToken(error), during: "settlement" }); workflow = (await repo.getWorkflow(workflowId))!; }
    }

    /* A workflow is let go of when it is over and there is nothing left to
       ask about; while a question is still open, the executors that could
       answer it are kept. */
    const finished = TERMINAL.includes(workflow.state) && remaining.reconcilable === 0;
    let needsPerson = false;
    if (quiet || finished) needsPerson = await this.reportWhatAPersonMustDo(repo, workflow);
    if (finished) {
      this.held.delete(workflowId);
      this.emit("workflow.settled", { workflow: workflowId, state: workflow.state, needs_person: needsPerson });
    }
    return { workflowId, state: workflow.state, ticks, worked, quiet, remaining, needsPerson };
  }

  /* What is left that this engine could do by itself. Nothing runnable,
     nothing leased or running, nothing whose outcome can still be asked
     about, and nothing this process is still waiting on. */
  async workRemaining(repo: OrchestrationRepository, held: Held | null, workflowId: string): Promise<WorkRemaining> {
    const tasks = await repo.listTasks(workflowId);
    const runnable = (await repo.getRunnableTasks(workflowId)).length;
    const busy = tasks.filter((t) => t.state === "leased" || t.state === "running").length;
    let reconcilable = 0;
    for (const task of tasks.filter((t) => t.state === "outcome_unknown")) {
      for (const attempt of await repo.listAttempts(task.taskId)) {
        if (attempt.state === "outcome_unknown" && attempt.reconciliationOutcome === null) reconcilable++;
      }
    }
    return { runnable, busy, reconcilable, inFlight: held ? held.scheduler.inFlight.size : 0 };
  }

  /* What is waiting for somebody, counted. Never what it is about. */
  private async reportWhatAPersonMustDo(repo: OrchestrationRepository, workflow: WorkflowRecord): Promise<boolean> {
    const disagreements = (await repo.listDisagreements(workflow.workflowId)).filter((d) => d.state === "needs_human").length;
    const decisions = (await repo.listDecisions(workflow.workflowId)).filter((d) => d.status === "needs_human").length;
    const tasks = await repo.listTasks(workflow.workflowId);
    const unfinished = tasks.filter((t) => t.state === "failed_known" || t.state === "outcome_unknown" || t.state === "blocked").length;
    const needsPerson = disagreements + decisions + unfinished > 0
      || workflow.state === "needs_attention" || workflow.state === "partial";
    if (needsPerson) {
      this.emit("workflow.needs_person", {
        workflow: workflow.workflowId, state: workflow.state,
        disagreements_held: disagreements, decisions_held: decisions, tasks_unfinished: unfinished,
      });
    }
    return needsPerson;
  }

  /* ────────────────────────────────────────────────────────── back-off */

  /* Doubling from the base to the ceiling, plus a little jitter; a pass that
     found work starts again from nothing. */
  private nextBackoff(idle: boolean): number {
    if (!idle) { this.idleStreak = 0; return 0; }
    this.idleStreak++;
    const doubled = this.backoff.baseMs * 2 ** (this.idleStreak - 1);
    const capped = Math.min(this.backoff.ceilingMs, Number.isFinite(doubled) ? doubled : this.backoff.ceilingMs);
    const jitter = Math.floor(capped * this.backoff.jitter * this.backoff.random());
    return Math.min(this.backoff.ceilingMs, capped + jitter);
  }

  /* ──────────────────────────────────────────────────────────── plumbing */

  private get ticksPerPass(): number { return Math.max(1, this.options.ticksPerPass ?? 8); }
  private get workflowsPerPass(): number { return Math.max(1, this.options.workflowsPerPass ?? 4); }
  private get resumeLimit(): number { return Math.max(1, this.options.resumeLimit ?? 20); }

  private async connection(): Promise<Queryable & { end?: () => Promise<void> }> {
    if (!this.client) this.client = await this.options.connect();
    return this.client;
  }

  /* The record, over this dispatcher's own connection. */
  async record(): Promise<OrchestrationRepository> {
    if (!this.repo) this.repo = this.options.repository(await this.connection());
    return this.repo;
  }

  /* The manifest, read back out of the record: a workflow says which pack it
     belongs to, what was asked of it and which sources it reads, and the
     sources carry the segments they declared. Nothing about a workflow is
     kept in this process that the record does not hold. */
  async manifestOf(workflowId: string): Promise<SourceManifest> {
    const repo = await this.record();
    const workflow = await repo.getWorkflow(workflowId);
    if (!workflow) throw new Error(`core-v2 runtime: there is no workflow ${workflowId} to dispatch`);
    if (workflow.domainPack !== this.options.pack.id) {
      throw new Error(`core-v2 runtime: workflow ${workflowId} belongs to another pack`);
    }
    return {
      workflowId, organizationId: workflow.organizationId, domainPack: workflow.domainPack,
      domainPackVersion: workflow.domainPackVersion, workflowType: workflow.workflowType,
      requestedScope: workflow.requestedScope, sources: await repo.listSources(workflowId),
    };
  }

  /* One scheduler per workflow, kept while the workflow is unfinished: it
     holds the executions this process has in flight, and dropping it would
     lose the count of what may still be running. */
  private async hold(workflowId: string): Promise<Held> {
    const existing = this.held.get(workflowId);
    if (existing) return existing;
    const manifest = await this.manifestOf(workflowId);
    const repo = await this.record();
    const leaseTtlMs = this.options.leaseTtlMs ?? this.policy.attemptTimeoutMs + this.policy.settlementAllowanceMs + 1;
    const scheduler = new Scheduler(repo, manifest, this.options.pack, this.policy, this.router, this.options.executors(manifest), {
      owner: this.name, leaseTtlMs, now: this.options.now, dispatcher: this.name,
    });
    const held: Held = { workflowId, manifest, scheduler };
    this.held.set(workflowId, held);
    return held;
  }

  private emit(event: string, detail: Record<string, unknown>): void {
    const out = { at: this.options.now(), dispatcher: this.name, event } as OperationalEvent;
    for (const [key, value] of Object.entries(detail)) {
      if (key === "at" || key === "dispatcher" || key === "event") continue;
      out[key] = operationalValue(value);
    }
    this.options.events(out);
  }
}

export function idleWork(work: WorkRemaining): boolean {
  return work.runnable === 0 && work.busy === 0 && work.reconcilable === 0 && work.inFlight === 0;
}

/* ───────────────────────────────────── the producer's side of the outbox */

/* The rows a start command is: the workflow, its sources, one pending
   command, one audit — written together, so a command exists only if the
   workflow it names does. This is the same shape core_v2_start_workflow
   writes; it is here because that door draws its own id and a caller that
   derives ids needs the same handshake. Nothing runs as a result: a
   dispatcher claims it afterwards.

   The identity it computes must be the identity the kernel's planner
   computes for the same manifest, or the planner will refuse the workflow as
   one already created with a different intent. */
export async function enqueueWorkflow(
  repo: OrchestrationRepository, manifest: SourceManifest, pack: DomainPack, policy: OrchestrationPolicy = DEFAULT_POLICY,
): Promise<WorkflowRecord> {
  /* The kernel's own definition of what makes a run that run, so the row put
     on the queue and the row the scheduler expects cannot drift apart. */
  return repo.createWorkflow(workflowRecordFor(manifest, pack, budgetOf(policy)), manifest.sources);
}
