/* THE LOOP THAT FANS WORK OUT AND GATHERS IT BACK.
 *
 * One tick: reconcile what expired, release what is no longer waiting, pick
 * what may run within the concurrency limits, lease it under a fencing token,
 * build each role's packet, route to an executor domain that keeps
 * independence, submit under the lease, execute with a deadline and an abort
 * signal, validate, and commit the result together with everything it makes
 * necessary — a comparison's disagreements, a verifier's assessments, an
 * arbiter's decision, the children an answer asked for — in one write.
 *
 * It holds no state the record does not hold, except the executions in
 * flight in this process, which it counts against concurrency until they
 * settle. A scheduler that dies and a scheduler that starts afterwards look
 * at the same rows and continue without repeating either.
 *
 * What it will not do, whatever an envelope asks:
 *   · run an agent that calls another agent — children come only through the
 *     follow-up planner, one level deeper each time, deduplicated by identity;
 *   · retry an attempt whose outcome is unknown;
 *   · execute a blind reading in a domain that already read the subject;
 *   · accept a claim because two readers agreed;
 *   · dispatch anything after cancellation was requested, or send anything
 *     under a lease it does not hold;
 *   · let a failed branch touch a completed one.
 */
import type {
  AgentResultEnvelope, AssessmentRecord, AttemptRecord, AttemptState, AuditRecord, ClaimRecord, DecisionRecord, DisagreementRecord,
  ProposedAdjudication, ProviderFacts, SegmentRecord, SourceManifest, TaskRecord, TaskState, WorkPacket, WorkflowRecord, WorkflowState,
} from "./contracts.ts";
import { ENGINE_VERSION, KERNEL_TASK_TYPES } from "./contracts.ts";
import { KernelDeterministicExecutor } from "./deterministic.ts";
import type { DomainPack } from "./domain.ts";
import { INDEPENDENCE_GROUPS } from "./domain.ts";
import type { ExecutorRegistry, ExecutorSelection } from "./executors.ts";
import { childTask, planFollowUps } from "./follow-up-planner.ts";
import type { FollowUpContext } from "./follow-up-planner.ts";
import { canonical, entityId, sha256 } from "./ids.ts";
import { PacketOverBudget, buildPacket } from "./packet-builder.ts";
import type { Lookup } from "./planning.ts";
import { lookupOf, planCompositions, planDiscovery, segmentIdFor, sourceIdentityOf, specsToTasks, workflowRecordFor } from "./planning.ts";
import type { OrchestrationPolicy } from "./policy.ts";
import { budgetOf } from "./policy.ts";
import type {
  AdmissionLimits, ClaimTransition, DecisionApplication, DisagreementTransition, NewAnchor, NewAssessment, NewClaim,
  NewDisagreement, NewSegment, NewTask, OrchestrationRepository, ResultCommit, TaskTransition,
} from "./repository.ts";
import { validateEnvelope } from "./result-validator.ts";
import { RoleRegistry } from "./roles.ts";
import type { AgentRouter } from "./router.ts";
import { StaleState, TERMINAL_TASK_STATES } from "./transitions.ts";

export type SchedulerOptions = {
  owner: string;
  leaseTtlMs: number;
  now: () => number;
  dispatcher?: string;
  /* MAY THIS PROCESS START SOMETHING NEW RIGHT NOW.
   *
   * Asked before a task is leased, and again immediately before each task in
   * a lane is run — because a lane runs its tasks one after another, and the
   * second reader of a subject starts after the first one has finished. A
   * single timer around the pass cannot see that moment; only a question
   * asked at that moment can.
   *
   * Answering false does not fail anything. A task that was leased and then
   * not started is handed back to the queue, unrun and uncharged, for the
   * next pass of THIS workflow to pick up. Running out of a process's time is
   * not a reading that failed and is never recorded as one.
   *
   * Omitted means yes, always — which is what an in-memory run and every
   * existing test want. */
  mayStartWork?: () => boolean;
  /* HOW MUCH OF THE ABSOLUTE WINDOW IS LEFT, ASKED AT THE MOMENT OF ASKING.
   *
   * `mayStartWork` is asked before a task is leased and before a lane runs
   * one, and both of those are before the packet exists. Building a packet is
   * not free — it reads the workflow's segments, its accepted claims and its
   * material references — and a slow record can spend the rest of the window
   * inside it. A gate that was true when the task was picked up can be false
   * by the time there is anything to send.
   *
   * So the question is asked twice more: once after the packet is built and
   * before an attempt exists at all, and once at the moment the answer is
   * waited for, to bound that wait by what is actually left. It returns
   * milliseconds until this process must have returned.
   *
   * Omitted means "no deadline", which is what an in-memory run wants. */
  msUntilDeadline?: () => number;
};

export type TickReport = {
  reconciled: number;
  released: number;
  stopped: number;
  dispatched: string[];
  /* Leased, then handed back unrun because there was no time left to answer
     and settle inside this process's life. Not a failure, not a charge. */
  deferred: string[];
  completed: string[];
  failed: string[];
  unknown: string[];
  cancelled: string[];
  childrenCreated: number;
  childrenReused: number;
  escalations: string[];
  workflowState: WorkflowState;
};

export type RunReport = {
  ticks: number;
  workflow: WorkflowRecord;
  tasks: Record<string, number>;
  byRole: Record<string, number>;
  byPhase: Record<string, number>;
  disagreements: Record<string, number>;
  decisions: Record<string, number>;
  escalations: string[];
};

type FollowUpTally = { created: number; reused: number; escalations: string[] };

/* One answer's consequences, computed before the commit and written by it. */
type Settlement = {
  segments: NewSegment[];
  claims: NewClaim[];
  assessments: NewAssessment[];
  disagreements: NewDisagreement[];
  claimTransitions: ClaimTransition[];
  disagreementRounds: ResultCommit["disagreementRounds"];
  disagreementTransitions: DisagreementTransition[];
  decisions: DecisionApplication[];
  children: NewTask[];
  dependencies: ResultCommit["dependencies"];
  followUps: ResultCommit["followUps"];
  taskTransitions: TaskTransition[];
  audits: AuditRecord[];
  escalations: string[];
  /* Tasks whose dependents wait for a child, by child id. */
  rewire: { child: string; kind: "requires_claims" | "requires_resolution" }[];
};

export class Scheduler {
  repo: OrchestrationRepository;
  manifest: SourceManifest;
  pack: DomainPack;
  policy: OrchestrationPolicy;
  router: AgentRouter;
  executors: ExecutorRegistry;
  registry: RoleRegistry;
  options: SchedulerOptions;
  escalations: string[] = [];
  /* Executions this process started and has not seen settle — including
     those that timed out. A slot is not free while a provider may be working. */
  inFlight = new Map<string, { taskId: string; roleKey: string; family: string; timedOut: boolean; promise: Promise<unknown>; controller: AbortController }>();

  constructor(
    repo: OrchestrationRepository, manifest: SourceManifest, pack: DomainPack, policy: OrchestrationPolicy,
    router: AgentRouter, executors: ExecutorRegistry, options: SchedulerOptions,
  ) {
    this.repo = repo; this.manifest = manifest; this.pack = pack; this.policy = policy;
    this.router = router; this.executors = executors; this.options = options;
    this.registry = new RoleRegistry(pack);
    const problems = this.registry.assertConsistent();
    if (problems.length) throw new Error(`core-v2: the role registry is inconsistent: ${problems.join("; ")}`);
    if (!executors.has("deterministic")) executors.register(new KernelDeterministicExecutor(pack), ["deterministic"]);
    /* A lease that can expire under a running attempt is a lease that lets a
       second worker buy the same work. Either it outlives the attempt and its
       settlement, or it is heartbeated well inside its own life. */
    if (options.leaseTtlMs <= policy.heartbeatIntervalMs * 2 && options.leaseTtlMs <= policy.attemptTimeoutMs + policy.settlementAllowanceMs) {
      throw new Error(`core-v2: a lease of ${options.leaseTtlMs} ms neither outlives an attempt (${policy.attemptTimeoutMs} + ${policy.settlementAllowanceMs} ms) nor leaves room for a heartbeat every ${policy.heartbeatIntervalMs} ms`);
    }
  }

  /* A workflow is marked for attention by whoever gets there first; a
     second caller finds it already so and is content. */
  private async markNeedsAttention(workflowId: string) {
    const wf = await this.repo.getWorkflow(workflowId);
    if (!wf || wf.state !== "running") return;
    try { await this.repo.transitionWorkflow(workflowId, "running", "needs_attention"); }
    catch (error) { if (!(error instanceof StaleState)) throw error; }
  }

  /* Omitted means yes: an in-memory run, a test and every caller that does
     not live inside a container with a clock all start whatever is ready. */
  private mayStartWork(): boolean {
    return this.options.mayStartWork ? this.options.mayStartWork() === true : true;
  }

  /* HOW LONG AN ANSWER MAY BE WAITED FOR, RIGHT NOW.
   *
   * The smaller of what the policy allows and what is actually left after
   * keeping back the room to write the answer down. A number at or below zero
   * means there is no honest way to send this request: the wait would run past
   * the moment this process must have returned, and a request still
   * outstanding when a container goes is not a slow call — it is an outcome
   * nobody will ever know, and this engine never buys one of those twice.
   *
   * With no deadline given, the policy's own timeout is the answer, which is
   * what every existing caller has always had. */
  private roomForOneAttempt(): number {
    if (!this.options.msUntilDeadline) return this.policy.attemptTimeoutMs;
    const left = this.options.msUntilDeadline();
    if (!Number.isFinite(left)) return this.policy.attemptTimeoutMs;
    return Math.min(this.policy.attemptTimeoutMs, left - this.policy.settlementAllowanceMs);
  }

  /* A task put back exactly as it was found: queued, no lease, no attempt,
     nothing bought. The reason lives in the audit trail because a task waiting
     in the queue has no terminal reason — nothing about it is terminal. */
  private async deferTask(taskId: string, reason: string): Promise<boolean> {
    try {
      await this.repo.transitionTask(taskId, "leased", "queued", reason);
      await this.repo.audit({ action: "core_v2.task.deferred", entityType: "workflow_task", entityId: taskId, detail: { reason } });
      return true;
    } catch { return false; }
  }

  private get limits(): AdmissionLimits {
    return { maximumTasks: this.policy.maximumTasksPerWorkflow, maximumEdges: this.policy.maximumDependencyEdgesPerWorkflow, maximumChildrenPerParent: this.policy.maximumChildTasksPerParent, maximumDepth: this.policy.maximumFollowUpDepth };
  }

  /* ─────────────────────────────────────────────────────────── planning */

  /* Create the workflow, claim its start command, and plan phase A. The
     workflow walks created → queued → planning → running; planning twice
     creates nothing the second time. */
  async plan(): Promise<{ created: string[]; existing: string[]; refusals: string[] }> {
    const wf = this.manifest.workflowId;
    const sources = this.manifest.sources;
    await this.repo.createWorkflow(workflowRecordFor(this.manifest, this.pack, budgetOf(this.policy)), sources);
    let workflow = (await this.repo.getWorkflow(wf))!;
    if (workflow.state === "created") {
      if (await this.repo.claimOutbox(wf, this.options.dispatcher ?? this.options.owner)) workflow = (await this.repo.getWorkflow(wf))!;
    }
    if (workflow.state === "queued") workflow = await this.repo.transitionWorkflow(wf, "queued", "planning");

    const lookup = lookupOf(this.manifest, await this.repo.listSegments(wf));
    const specs = planDiscovery(this.manifest, this.pack);
    const { tasks, refusals } = specsToTasks(specs, wf, lookup, this.registry, this.policy);
    if (refusals.length) {
      if (workflow.state === "planning") await this.repo.transitionWorkflow(wf, "planning", "failed", { errorCode: "planning_refused", errorMessage: refusals.join("; ") });
      throw new Error(`core-v2: the planner refused this manifest: ${refusals.join("; ")}`);
    }
    const admission = await this.repo.admitTasks(wf, tasks, this.limits);
    if (admission.refused.length) {
      if (workflow.state === "planning") await this.repo.transitionWorkflow(wf, "planning", "failed", { errorCode: "budget", errorMessage: admission.refused[0].reason });
      throw new Error(`core-v2: planning exceeds the workflow's budget: ${admission.refused[0].reason}`);
    }
    if (workflow.state === "planning") {
      await this.repo.transitionWorkflow(wf, "planning", "running");
      await this.repo.acknowledgeOutbox(wf);
    }
    await this.refreshProgress();
    if (admission.created.length) {
      await this.repo.audit({ action: "core_v2.workflow.planned", entityType: "intelligence_workflow", entityId: wf,
        detail: { phase: "discovery", tasks: admission.created.length, sources: sources.length, engine: ENGINE_VERSION, pack: `${this.pack.id}@${this.pack.version}` } });
    }
    return { created: admission.created.map((t) => t.taskId), existing: admission.reused.map((t) => t.taskId), refusals };
  }

  /* Phase B, from the persisted segments. Idempotent: the pack's specs are
     deterministic and admission reuses by identity. */
  async expand(): Promise<{ created: string[]; reused: string[]; refused: string[] }> {
    const wf = this.manifest.workflowId;
    const segments = await this.repo.listSegments(wf, { statuses: ["accepted"] });
    const tasks = await this.repo.listTasks(wf);
    const lookup = lookupOf(this.manifest, await this.repo.listSegments(wf));
    const specs = this.pack.expand({ manifest: this.manifest, policy: this.policy, segments, tasks });
    const { tasks: newTasks, refusals } = specsToTasks(specs, wf, lookup, this.registry, this.policy);
    for (const r of refusals) await this.repo.audit({ action: "core_v2.expansion.refused", entityType: "intelligence_workflow", entityId: wf, detail: { reason: r } });
    const admission = await this.repo.admitTasks(wf, newTasks, this.limits);
    for (const r of admission.refused) {
      this.escalations.push(`${r.task.taskType} ${r.task.subjectKey}: ${r.reason}`);
      await this.repo.audit({ action: "core_v2.expansion.refused", entityType: "intelligence_workflow", entityId: wf, detail: { taskType: r.task.taskType, subject: r.task.subjectKey, reason: r.reason } });
    }
    if (admission.created.length) {
      await this.repo.audit({ action: "core_v2.workflow.expanded", entityType: "intelligence_workflow", entityId: wf, detail: { tasks: admission.created.length, segments: segments.length } });
    }
    await this.refreshProgress();
    return { created: admission.created.map((t) => t.taskId), reused: admission.reused.map((t) => t.taskId), refused: admission.refused.map((r) => r.reason) };
  }

  async cancel(reason: string): Promise<{ unsentCancelled: number; submittedUnresolved: number; completedPreserved: number }> {
    const wf = this.manifest.workflowId;
    await this.repo.requestCancel(wf, this.options.now());
    for (const [attemptId, flight] of this.inFlight) this.abort(attemptId, flight.taskId);
    let unsent = 0, submitted = 0, preserved = 0;
    for (const task of await this.repo.listTasks(wf)) {
      if (task.state === "completed") { preserved++; continue; }
      if (["created", "blocked", "queued", "leased", "running"].includes(task.state)) {
        try { await this.repo.transitionTask(task.taskId, task.state, "cancelled", `cancelled:${reason}`); unsent++; }
        catch { submitted++; }
      } else if (task.state === "outcome_unknown") submitted++;
    }
    const workflow = (await this.repo.getWorkflow(wf))!;
    if (["created", "queued", "planning", "running", "needs_attention"].includes(workflow.state)) {
      await this.repo.transitionWorkflow(wf, workflow.state, "cancelled", { errorCode: "cancelled_by_person", errorMessage: reason });
    }
    await this.repo.audit({ action: "core_v2.workflow.cancelled", entityType: "intelligence_workflow", entityId: wf,
      detail: { reason, unsent_cancelled: unsent, submitted_unresolved: submitted, completed_preserved: preserved } });
    return { unsentCancelled: unsent, submittedUnresolved: submitted, completedPreserved: preserved };
  }

  /* ──────────────────────────────────────────────────────────── the tick */

  async tick(): Promise<TickReport> {
    const wf = this.manifest.workflowId;
    let workflow = await this.repo.getWorkflow(wf);
    if (!workflow) throw new Error("core-v2: plan() before tick()");
    const report: TickReport = { reconciled: 0, released: 0, stopped: 0, dispatched: [], deferred: [], completed: [], failed: [], unknown: [], cancelled: [], childrenCreated: 0, childrenReused: 0, escalations: [], workflowState: workflow.state };

    /* Reconciliation first, cancelled or not: what a dead worker left
       submitted becomes unknown, what it left leased goes back to the queue. */
    report.reconciled += await this.reconcileUnknown(wf);
    for (const t of await this.repo.expireLeases(wf, this.options.now())) {
      report.reconciled++;
      const action = t.state === "queued" ? "core_v2.task.lease_reclaimed" : t.state === "outcome_unknown" ? "core_v2.attempt.outcome_unknown" : "core_v2.task.lease_expired";
      await this.repo.audit({ action, entityType: "workflow_task", entityId: t.taskId, detail: { state: t.state, reason: t.terminalReason } });
      if (t.state === "failed_known" || t.state === "outcome_unknown") report.escalations.push(...await this.escalateDisputeOf(t.taskId, t.state));
    }
    if (workflow.cancelRequestedAt !== null || !["running", "needs_attention", "ready_for_decision", "deciding", "planning", "queued"].includes(workflow.state)) {
      report.workflowState = (await this.repo.getWorkflow(wf))!.state;
      return report;
    }
    if (workflow.state === "queued") { await this.plan(); workflow = (await this.repo.getWorkflow(wf))!; }

    const { released, stopped } = await this.repo.releaseDependents(wf);
    report.released = released.length;
    report.stopped = stopped.length;
    for (const t of stopped) report.escalations.push(...await this.escalateDisputeOf(t.taskId, t.state));

    /* Concurrency: what is leased or running in the record, plus what this
       process still has in flight after a timeout. */
    const all = await this.repo.listTasks(wf);
    const active = all.filter((t) => t.state === "leased" || t.state === "running");
    const activeByRole = new Map<string, number>();
    for (const t of active) activeByRole.set(t.roleKey, (activeByRole.get(t.roleKey) ?? 0) + 1);
    const timedOut = [...this.inFlight.values()].filter((f) => f.timedOut);
    for (const f of timedOut) if (!active.some((t) => t.taskId === f.taskId)) activeByRole.set(f.roleKey, (activeByRole.get(f.roleKey) ?? 0) + 1);
    let room = this.policy.maximumConcurrentTasksPerWorkflow - active.length - timedOut.filter((f) => !active.some((t) => t.taskId === f.taskId)).length;
    if (timedOut.length >= this.policy.maximumTimedOutExecutions) room = 0;

    const runnable = await this.repo.getRunnableTasks(wf);
    const chosen: TaskRecord[] = [];
    if (workflow.state === "needs_attention" && runnable.length) workflow = await this.repo.transitionWorkflow(wf, "needs_attention", "running");
    for (const task of runnable) {
      if (room <= 0) break;
      /* Nothing is leased that this process could not also finish. A lease
         taken and abandoned is the thing that cost the canary a whole pass. */
      if (!this.mayStartWork()) break;
      const roleActive = activeByRole.get(task.roleKey) ?? 0;
      if (roleActive >= this.policy.maximumConcurrentTasksPerRole) continue;
      const leased = await this.repo.leaseTask(task.taskId, this.options.owner, this.options.leaseTtlMs, this.options.now());
      if (!leased) continue;
      chosen.push(leased);
      activeByRole.set(task.roleKey, roleActive + 1);
      room--;
    }
    report.dispatched = chosen.map((t) => t.taskId);

    /* Blind readings of one subject run one after another, so the second is
       routed knowing the first's domain; everything else runs together. */
    const lanes = new Map<string, TaskRecord[]>();
    for (const task of chosen) {
      const lane = task.independenceGroup ? `blind:${task.subjectKey}` : `task:${task.taskId}`;
      lanes.set(lane, [...(lanes.get(lane) ?? []), task]);
    }
    /* Within a lane the declared order of the groups decides who reads
       first, so which reading survives a shortage of domains is a rule and
       not a hash: reader-a reads, and the refusal lands on the later group. */
    for (const lane of lanes.values()) {
      lane.sort((a, b) => INDEPENDENCE_GROUPS.indexOf(a.independenceGroup ?? "") - INDEPENDENCE_GROUPS.indexOf(b.independenceGroup ?? "") || a.taskId.localeCompare(b.taskId));
    }
    /* THE QUESTION ASKED AGAIN, BETWEEN ONE READING AND THE NEXT.
       A lane runs its tasks in order: the second blind reader of a subject
       starts only once the first has answered. If the first spent the window,
       the second is not sent — it goes back to the queue, unrun, and the next
       pass of this same workflow starts it. */
    const deferred: string[] = [];
    const outcomes = (await Promise.all([...lanes.values()].map(async (lane) => {
      const results: Awaited<ReturnType<Scheduler["runTask"]>>[] = [];
      for (const task of lane) {
        if (!this.mayStartWork()) { deferred.push(task.taskId); continue; }
        results.push(await this.runTask(task));
      }
      return results;
    }))).flat();
    for (const taskId of deferred) {
      if (await this.deferTask(taskId, "no_time_left_in_this_pass")) report.deferred.push(taskId);
    }
    for (const o of outcomes) {
      if (o.state === "completed") report.completed.push(o.taskId);
      else if (o.state === "outcome_unknown") report.unknown.push(o.taskId);
      else if (o.state === "cancelled") report.cancelled.push(o.taskId);
      /* Put back after its packet was built, because there was no room left
         to answer it. Queued, unrun, uncharged — not a failure. */
      else if (o.state === "deferred") report.deferred.push(o.taskId);
      else report.failed.push(o.taskId);
      report.childrenCreated += o.childrenCreated;
      report.childrenReused += o.childrenReused;
      report.escalations.push(...o.escalations);
      if (o.state === "failed_known" || o.state === "outcome_unknown") report.escalations.push(...await this.escalateDisputeOf(o.taskId, o.state));
    }
    this.escalations.push(...report.escalations);

    /* A task that was never started was never dispatched — whether it was put
       back before its packet was built or after. Saying otherwise would tell
       the pass above that work happened, and the fuse that stops a workflow
       waking forever is built out of that answer. */
    report.dispatched = report.dispatched.filter((id) => !report.deferred.includes(id));

    /* Phase B when a discovery finished; the close of the graph when
       everything but the compositions is done. */
    if (outcomes.some((o) => o.discovered)) await this.expand();
    await this.advanceWorkflow();
    await this.refreshProgress();
    report.workflowState = (await this.repo.getWorkflow(wf))!.state;
    return report;
  }

  /* Quiescence — nothing dispatched, released, stopped or reconciled — is
     what ends a run. The tick ceiling is a backstop derived from the policy. */
  async runUntilQuiescent(maxTicks = this.policy.maximumTasksPerWorkflow + 100): Promise<RunReport> {
    let ticks = 0;
    for (; ticks < maxTicks; ticks++) {
      const r = await this.tick();
      if (r.dispatched.length === 0 && r.released === 0 && r.stopped === 0 && r.reconciled === 0 && this.inFlight.size === 0) break;
    }
    if (ticks >= maxTicks) throw new Error(`core-v2: still working after ${maxTicks} ticks — that is a loop, not a workflow`);
    await this.settleWorkflow();
    return this.report(ticks);
  }

  async report(ticks: number): Promise<RunReport> {
    const wf = this.manifest.workflowId;
    const count = <T,>(items: T[], key: (t: T) => string) => {
      const out: Record<string, number> = {};
      for (const i of items) out[key(i)] = (out[key(i)] ?? 0) + 1;
      return out;
    };
    const tasks = await this.repo.listTasks(wf);
    return {
      ticks, workflow: (await this.repo.getWorkflow(wf))!,
      tasks: count(tasks, (t) => t.state), byRole: count(tasks, (t) => t.roleKey), byPhase: count(tasks, (t) => t.phase),
      disagreements: count(await this.repo.listDisagreements(wf), (d) => d.state),
      decisions: count(await this.repo.listDecisions(wf), (d) => `${d.decisionType}:${d.status}`),
      escalations: [...this.escalations],
    };
  }

  /* ───────────────────────────────────────────────── the workflow's states */

  private async advanceWorkflow() {
    const wf = this.manifest.workflowId;
    const workflow = (await this.repo.getWorkflow(wf))!;
    const tasks = await this.repo.listTasks(wf);
    const open = (t: TaskRecord) => !TERMINAL_TASK_STATES.includes(t.state);
    const compositions = tasks.filter((t) => t.phase === "compose");
    const rest = tasks.filter((t) => t.phase !== "compose");
    const blockedByPerson = async (t: TaskRecord) => {
      if (t.state !== "blocked") return false;
      const deps = await this.repo.getDependencies(t.taskId);
      return deps.some((d) => tasks.find((x) => x.taskId === d.dependsOnTaskId)?.state === "superseded");
    };
    const restDone = await (async () => { for (const t of rest) if (open(t) && !(await blockedByPerson(t))) return false; return true; })();
    if ((workflow.state === "running" || workflow.state === "needs_attention") && restDone && this.inFlight.size === 0) {
      const next = await this.repo.transitionWorkflow(wf, workflow.state, "ready_for_decision");
      const accepted = await this.repo.listClaims({ workflowId: wf, statuses: ["accepted"] });
      const subjects = this.pack.decisionSubjects(accepted);
      const lookup = lookupOf(this.manifest, await this.repo.listSegments(wf));
      const specs = planCompositions(subjects, rest.filter((t) => t.state === "completed").map((t) => t.taskId));
      const { tasks: composeTasks } = specsToTasks(specs, wf, lookup, this.registry, this.policy);
      const admitted = await this.repo.admitTasks(wf, composeTasks, this.limits);
      for (const r of admitted.refused) this.escalations.push(`compose ${r.task.subjectKey}: ${r.reason}`);
      await this.repo.transitionWorkflow(wf, next.state, "deciding");
      return;
    }
    if (workflow.state === "deciding" && compositions.length && compositions.every((t) => !open(t)) && this.inFlight.size === 0) {
      const attention = (await this.repo.listDisagreements(wf)).some((d) => d.state === "needs_human")
        || tasks.some((t) => t.state === "failed_known" || t.state === "outcome_unknown" || (t.state === "blocked"));
      await this.repo.transitionWorkflow(wf, "deciding", attention ? "partial" : "completed");
    }
  }

  private async settleWorkflow() {
    const wf = this.manifest.workflowId;
    const workflow = (await this.repo.getWorkflow(wf))!;
    if (workflow.cancelRequestedAt !== null || ["completed", "partial", "failed", "cancelled"].includes(workflow.state)) return;
    const tasks = await this.repo.listTasks(wf);
    if (workflow.state === "deciding") {
      const attention = (await this.repo.listDisagreements(wf)).some((d) => d.state === "needs_human") || tasks.some((t) => !["completed", "superseded"].includes(t.state));
      await this.repo.transitionWorkflow(wf, "deciding", attention ? "partial" : "completed");
      return;
    }
    if (workflow.state === "running" && tasks.some((t) => t.state === "blocked")) await this.repo.transitionWorkflow(wf, "running", "needs_attention");
  }

  /* ───────────────────────────────────────────────── one assignment */

  private async runTask(task: TaskRecord): Promise<{ taskId: string; state: string; childrenCreated: number; childrenReused: number; escalations: string[]; discovered: boolean }> {
    const done = (state: string, extra: Partial<{ childrenCreated: number; childrenReused: number; escalations: string[]; discovered: boolean }> = {}) =>
      ({ taskId: task.taskId, state, childrenCreated: 0, childrenReused: 0, escalations: [], discovered: false, ...extra });
    const role = this.registry.role(task.roleKey);
    const leaseToken = task.leaseToken!;
    const priorAttempts = await this.repo.listAttempts(task.taskId);
    const attemptNo = priorAttempts.reduce((n, a) => Math.max(n, a.attemptNo), 0) + 1;
    const attemptId = entityId("attempt", task.taskId, attemptNo);

    const failBeforeAttempt = async (reason: string, code: string, message: string, family = "none", domain = "none") => {
      await this.repo.createAttempt(this.newAttempt(task, attemptId, attemptNo, role.executorKind, family, domain, "", "", 0, leaseToken));
      await this.repo.transitionAttempt(attemptId, "prepared", "rejected_before_submission", { errorCode: code, errorMessage: message });
      await this.repo.transitionTask(task.taskId, "leased", "running");
      await this.repo.transitionTask(task.taskId, "running", "failed_known", reason);
      await this.repo.audit({ action: `core_v2.task.${code}`, entityType: "workflow_task", entityId: task.taskId, detail: { message } });
      return done("failed_known");
    };

    if (priorAttempts.length >= this.policy.maximumAttemptsPerTask) {
      await this.repo.transitionTask(task.taskId, "leased", "running");
      await this.repo.transitionTask(task.taskId, "running", "failed_known", "attempt_limit");
      await this.repo.audit({ action: "core_v2.task.attempt_limit", entityType: "workflow_task", entityId: task.taskId, detail: { attempts: priorAttempts.length } });
      return done("failed_known");
    }

    const lookup = lookupOf(this.manifest, await this.repo.listSegments(task.workflowId));
    let built;
    try {
      built = await buildPacket(task, { manifest: this.manifest, lookup, repo: this.repo, registry: this.registry, pack: this.pack, policy: this.policy });
    } catch (error) {
      const code = error instanceof PacketOverBudget ? "packet_over_budget" : "packet_invalid";
      return failBeforeAttempt(code, code, String((error as Error).message));
    }
    const { packet, refToClaimId } = built;
    const packetBytes = Buffer.byteLength(JSON.stringify(packet), "utf8");

    /* Routing, on domains. A blind reading must run in a domain no other
       reading of the subject ran in; a critic or arbiter must not run in a
       domain that made what it judges. When that cannot be had, nothing runs. */
    const used = await this.usedDomainsFor(task);
    const routed = this.router.select({ roleKey: task.roleKey, requiresVisualInput: role.requiresVisualInput, independenceGroup: task.independenceGroup, usedDomains: used }, this.registry, this.executors);
    if (!routed.ok) {
      const result = await failBeforeAttempt("independence_unavailable", "independence_unavailable", routed.reason);
      result.escalations.push(...await this.holdSubjectForCoverage(task, routed.reason));
      return result;
    }
    const selection = routed.selection;

    /* ── THE LAST QUESTION BEFORE ANYTHING IS BOUGHT ────────────────────
     *
     * The packet is built and the reader is chosen. Both of those cost time —
     * segments, claims and material references are read from the record, and
     * a slow record spends the window inside them. So the clock is asked
     * again, HERE, before an attempt row exists and before a penny is held.
     *
     * If what is left cannot hold one answer and the room to write it down,
     * nothing is sent. The task goes back to the queue exactly as it was
     * found — still queued, no lease, no attempt, no reservation — and the
     * next pass of THIS workflow starts it with a whole window in front of
     * it. Running out of a process's life is not a reading that failed, is
     * never recorded as one, and never starts a new generation. */
    if (this.roomForOneAttempt() <= 0) {
      await this.deferTask(task.taskId, "no_time_left_before_submission");
      return done("deferred");
    }

    const attempt = await this.repo.createAttempt(this.newAttempt(task, attemptId, attemptNo, role.executorKind, selection.executorFamily, selection.independenceDomain, selection.modelConfiguration, packet.inputFingerprint, packetBytes, leaseToken));
    const unsent = async (reason: string) => {
      await this.repo.transitionAttempt(attempt.attemptId, "prepared", "cancelled_before_submission", { errorCode: reason });
      const now = await this.repo.getTask(task.taskId);
      if (now && (now.state === "leased" || now.state === "running")) { try { await this.repo.transitionTask(task.taskId, now.state, "cancelled", reason); } catch { /* reconciled elsewhere */ } }
      await this.repo.audit({ action: "core_v2.attempt.cancelled_before_submission", entityType: "agent_attempt", entityId: attempt.attemptId, detail: { task: task.taskId, reason } });
      return done("cancelled");
    };
    try { await this.repo.transitionTask(task.taskId, "leased", "running"); }
    catch { return unsent("task_no_longer_leased"); }

    /* The last look before anything is sent: one atomic check of the
       workflow, the lease and cancellation. */
    const submitted = await this.repo.submitAttempt(attempt.attemptId, leaseToken, this.options.now());
    if (!submitted.ok && submitted.reason.startsWith("independence")) {
      await this.repo.transitionAttempt(attempt.attemptId, "prepared", "rejected_before_submission", { errorCode: "independence_unavailable", errorMessage: submitted.reason });
      await this.repo.transitionTask(task.taskId, "running", "failed_known", "independence_unavailable");
      await this.repo.audit({ action: "core_v2.task.independence_unavailable", entityType: "workflow_task", entityId: task.taskId, detail: { message: submitted.reason, at: "submission" } });
      const result = done("failed_known");
      result.escalations.push(...await this.holdSubjectForCoverage(task, submitted.reason));
      return result;
    }
    if (!submitted.ok) return unsent(`submission refused: ${submitted.reason}`);

    /* Execution, under a deadline and an abort signal, with the lease kept
       alive while it runs. From here the outcome may have cost something, and
       nothing retries it — not after an exception, not after a timeout, not
       after a restart. */
    const controller = new AbortController();
    /* What the executor says it saw. It reports while it works, so a timed-out
       or thrown execution still leaves behind whatever was learned before it
       went wrong — a request id and a token count are exactly what a cost
       dispute needs, and they are lost if only a clean finish records them. */
    let facts: ProviderFacts = {};
    const report = (more: ProviderFacts) => {
      facts = { ...facts, ...more, usage: { ...(facts.usage ?? {}), ...(more.usage ?? {}) } };
    };
    const heartbeat = this.startHeartbeat(task.taskId, leaseToken);
    let envelope: AgentResultEnvelope;
    /* What came back, before the kernel gave it a shape. The record keeps
       this; the engine works from the normalised copy. */
    let raw: unknown = null;
    const execution = this.executors.run(selection, packet, { attemptId: attempt.attemptId, taskId: task.taskId, signal: controller.signal, report });
    const flight = { taskId: task.taskId, roleKey: task.roleKey, family: selection.executorFamily, timedOut: false, promise: execution.then(() => undefined, () => undefined), controller };
    this.inFlight.set(attempt.attemptId, flight);
    flight.promise.then(() => { if (this.inFlight.get(attempt.attemptId) === flight && flight.timedOut) this.inFlight.delete(attempt.attemptId); });
    try {
      /* AND THE WAIT ITSELF IS BOUNDED BY WHAT IS LEFT, NOT BY WHAT THE
         POLICY HOPED FOR. Asked once more at the moment of waiting, because
         the submission itself took time. The floor of one millisecond is
         deliberate: the request has now gone, so the only choices are to wait
         a little or to wait past the moment this process must have returned —
         and an engine that does the second is the engine that produced the
         canary's unknown outcomes. */
      raw = await withDeadline(execution, Math.max(1, this.roomForOneAttempt()));
      envelope = normaliseEnvelope(raw);
    } catch (error) {
      const timedOut = error instanceof AttemptTimeout;
      if (timedOut) { flight.timedOut = true; controller.abort(); } else this.inFlight.delete(attempt.attemptId);
      heartbeat.stop();
      const code = timedOut ? "attempt_timeout" : "executor_threw";
      /* One write, so whatever the executor managed to report about the thing
         that answered it — a request id, a token count — is on the attempt
         even though the outcome never came back. Those are exactly the facts
         a cost dispute needs, and an engine that records them only on a clean
         finish loses them precisely when they matter. If the commit itself
         cannot land, the attempt and its task are still moved by hand. */
      try {
        await this.repo.commitValidatedResult(this.emptyCommit(task, attempt.attemptId, null, "outcome_unknown", "outcome_unknown", `${code}: ${(error as Error).message}`, [String((error as Error).message)], facts, code));
      } catch {
        try { await this.repo.transitionAttempt(attempt.attemptId, "submitted", "outcome_unknown", { errorCode: code, errorMessage: String((error as Error).message) }); } catch { /* already moved */ }
        const now = await this.repo.getTask(task.taskId);
        if (now && now.state === "running") await this.repo.transitionTask(task.taskId, "running", "outcome_unknown", code);
      }
      await this.repo.audit({ action: "core_v2.attempt.outcome_unknown", entityType: "agent_attempt", entityId: attempt.attemptId, detail: { task: task.taskId, code } });
      return done("outcome_unknown");
    }
    this.inFlight.delete(attempt.attemptId);
    heartbeat.stop();

    try {
      return await this.settle(task, attempt, packet, refToClaimId, envelope, raw, facts, lookup, done);
    } catch (error) {
      /* A fault in this engine after the answer came back. The answer is kept
         on the attempt if the commit landed; if not, the task fails known and
         nothing of the answer enters the record. */
      const current = await this.repo.getTask(task.taskId);
      if (current && current.state === "running") {
        const a = await this.repo.getAttempt(attempt.attemptId);
        if (a && !["succeeded", "failed_known", "outcome_unknown", "output_limited"].includes(a.state)) {
          try {
            await this.repo.commitValidatedResult(this.emptyCommit(task, attempt.attemptId, raw, "failed_known", "failed_known", `engine_error: ${(error as Error).message}`, [`engine: ${(error as Error).message}`], facts));
          } catch { try { await this.repo.transitionTask(task.taskId, "running", "failed_known", `engine_error: ${(error as Error).message}`); } catch { /* already terminal */ } }
        } else {
          try { await this.repo.transitionTask(task.taskId, "running", "failed_known", `engine_error: ${(error as Error).message}`); } catch { /* already terminal */ }
        }
        await this.repo.audit({ action: "core_v2.task.engine_error", entityType: "workflow_task", entityId: task.taskId, detail: { message: String((error as Error).message) } });
      }
      return done("failed_known");
    }
  }

  /* `reason` is what the attempt says happened, in a sentence. `taskReason`
     is what the task is filed under, which is the short code a person scans a
     queue by; when they are the same thing the sentence serves for both. */
  private emptyCommit(task: TaskRecord, attemptId: string, raw: unknown, attemptTo: ResultCommit["attempt"]["to"], taskTo: ResultCommit["task"]["to"], reason: string | null, problems: string[], providerFacts: ProviderFacts = {}, taskReason: string | null = reason): ResultCommit {
    return {
      workflowId: task.workflowId, taskId: task.taskId, attemptId,
      attempt: { to: attemptTo, validationState: problems.length ? "invalid" : "not_applicable", validationProblems: problems, rawResult: raw, rawResultHash: sha256(canonical(raw)), errorCode: attemptTo === "succeeded" ? null : reason?.split(":")[0] ?? null, errorMessage: reason, providerFacts },
      task: { to: taskTo, reason: taskReason }, segments: [], claims: [], assessments: [], disagreements: [], claimTransitions: [], disagreementRounds: [],
      disagreementTransitions: [], decisions: [], children: [], dependencies: [], followUps: [], taskTransitions: [], audits: [], limits: this.limits,
    };
  }

  private startHeartbeat(taskId: string, leaseToken: string): { stop: () => void } {
    const timer = setInterval(() => {
      this.repo.heartbeatLease(taskId, leaseToken, this.options.leaseTtlMs, this.options.now()).catch(() => undefined);
    }, this.policy.heartbeatIntervalMs);
    (timer as { unref?: () => void }).unref?.();
    return { stop: () => clearInterval(timer) };
  }

  /* Cancellation tells every execution in flight to stop, and keeps counting
     it until it does: the signal is advice to the executor, not a fact about
     the provider. */
  private abort(attemptId: string, _taskId: string) {
    const flight = this.inFlight.get(attemptId);
    if (!flight) return;
    flight.timedOut = true;
    flight.controller.abort(new Error("cancelled"));
  }

  /* An attempt whose outcome this kernel never saw is asked about, once per
     tick, until the executor can say. The answer is recorded on the attempt
     and never turns into a retry: a person authorises that. */
  private async reconcileUnknown(workflowId: string): Promise<number> {
    let reconciled = 0;
    for (const task of (await this.repo.listTasks(workflowId)).filter((t) => t.state === "outcome_unknown")) {
      for (const attempt of (await this.repo.listAttempts(task.taskId)).filter((a) => a.state === "outcome_unknown" && a.reconciliationOutcome === null)) {
        if (this.inFlight.has(attempt.attemptId)) continue;
        const outcome = await this.executors.reconcile(attempt.executorFamily, attempt.attemptId);
        if (outcome === "unknown") continue;
        await this.repo.recordReconciliation(attempt.attemptId, outcome);
        await this.repo.audit({ action: "core_v2.attempt.reconciled", entityType: "agent_attempt", entityId: attempt.attemptId, detail: { task: task.taskId, outcome } });
        reconciled++;
      }
    }
    return reconciled;
  }

  /* Independence domains that already read this subject — for a blind
     reading; and the domains whose claims a critic, verifier or arbiter
     would judge — for those roles. */
  private async usedDomainsFor(task: TaskRecord): Promise<string[]> {
    const role = this.registry.role(task.roleKey);
    if (task.independenceGroup) return this.repo.independenceDomainsForSubject(task.workflowId, task.subjectKey);
    if (role.kind === "critic" || role.kind === "verifier" || role.kind === "arbiter") {
      const dis = task.disagreementId ? await this.repo.getDisagreement(task.disagreementId) : null;
      return this.domainsBehind(dis ? dis.claimIds : task.targetClaimIds);
    }
    return [];
  }

  /* The readings a claim shown to a judge stands for: itself, and every
     blind reading that said the same thing. A critic handed one of two
     agreeing readings is judging both, so a domain that made either is not
     independent of what it judges — and the packet still shows only one, so
     no count of who agreed reaches the judge. */
  private async agreeingReadings(claim: ClaimRecord): Promise<ClaimRecord[]> {
    if (!claim.independenceGroup) return [];
    return (await this.repo.listClaims({ workflowId: claim.workflowId, subjectKey: claim.subjectKey }))
      .filter((c) => c.claimId !== claim.claimId && c.independenceGroup !== null && c.predicate === claim.predicate
        && canonical(c.scope) === canonical(claim.scope) && canonical(c.value) === canonical(claim.value) && c.unit === claim.unit);
  }

  private async domainsBehind(claimIds: string[]): Promise<string[]> {
    const domains = new Set<string>();
    for (const id of claimIds) {
      const claim = await this.repo.getClaim(id);
      if (!claim) continue;
      if (claim.independenceDomain) domains.add(claim.independenceDomain);
      for (const peer of await this.agreeingReadings(claim)) if (peer.independenceDomain) domains.add(peer.independenceDomain);
    }
    return [...domains];
  }

  private newAttempt(task: TaskRecord, attemptId: string, attemptNo: number, kind: AttemptRecord["executorKind"], family: string, domain: string, configuration: string, packetFingerprint: string, packetBytes: number, leaseToken: string): AttemptRecord {
    return {
      attemptId, workflowId: task.workflowId, taskId: task.taskId, attemptNo, roleKey: task.roleKey, roleVersion: task.roleVersion,
      executorKind: kind, executorFamily: family, independenceDomain: domain, modelConfiguration: configuration, state: "prepared",
      leaseToken, packetFingerprint, packetBytes, providerRequestId: null, modelReported: null, usage: {},
      providerStopReason: null, providerDurationMs: null, providerResponse: null, rawResult: null, rawResultHash: null,
      validationState: "pending", validationProblems: [], errorCode: null, errorMessage: null, reconciliationOutcome: null,
    };
  }

  /* ─────────────────────────────────────────────── settling an answer */

  private async settle(
    task: TaskRecord, attempt: AttemptRecord, packet: WorkPacket, refToClaimId: Record<string, string>, envelope: AgentResultEnvelope, raw: unknown, facts: ProviderFacts, lookup: Lookup,
    done: (state: string, extra?: Partial<{ childrenCreated: number; childrenReused: number; escalations: string[]; discovered: boolean }>) => { taskId: string; state: string; childrenCreated: number; childrenReused: number; escalations: string[]; discovered: boolean },
  ) {
    const role = this.registry.role(task.roleKey);
    if (envelope.outcome === "outcome_unknown") {
      await this.repo.commitValidatedResult(this.emptyCommit(task, attempt.attemptId, raw, "outcome_unknown", "outcome_unknown", "provider_outcome_unknown", [], facts));
      await this.repo.audit({ action: "core_v2.attempt.outcome_unknown", entityType: "agent_attempt", entityId: attempt.attemptId, detail: { task: task.taskId } });
      return done("outcome_unknown");
    }
    if (envelope.outcome === "failed_known") {
      await this.repo.commitValidatedResult(this.emptyCommit(task, attempt.attemptId, raw, "failed_known", "failed_known", envelope.limitations[0] ?? "failed_known", [], facts));
      return done("failed_known");
    }

    let validation;
    try { validation = validateEnvelope(packet, envelope, { role, pack: this.pack, lookup, policy: this.policy }); }
    catch (error) { validation = { ok: false, problems: [`the envelope could not be validated: ${(error as Error).message}`] }; }
    if (!validation.ok) {
      await this.repo.commitValidatedResult(this.emptyCommit(task, attempt.attemptId, raw, "failed_known", "failed_known", `invalid_envelope: ${validation.problems[0]}`, validation.problems, facts));
      await this.repo.audit({ action: "core_v2.attempt.invalid_envelope", entityType: "agent_attempt", entityId: attempt.attemptId, detail: { task: task.taskId, problems: validation.problems } });
      return done("failed_known");
    }

    /* Everything the answer makes true, computed against the record as it
       stands, then written together. */
    const s = await this.settlementOf(task, attempt, packet, refToClaimId, envelope, lookup);
    const commit: ResultCommit = {
      workflowId: task.workflowId, taskId: task.taskId, attemptId: attempt.attemptId,
      attempt: { to: "succeeded", validationState: "valid", validationProblems: [], rawResult: raw, rawResultHash: sha256(canonical(raw)), errorCode: null, errorMessage: null, providerFacts: facts },
      task: { to: "completed", reason: envelope.outcome === "insufficient_evidence" ? "insufficient_evidence" : null },
      segments: s.segments, claims: s.claims, assessments: s.assessments, disagreements: s.disagreements,
      claimTransitions: s.claimTransitions, disagreementRounds: s.disagreementRounds, disagreementTransitions: s.disagreementTransitions,
      decisions: s.decisions, children: s.children, dependencies: s.dependencies, followUps: s.followUps, taskTransitions: s.taskTransitions,
      audits: s.audits, limits: this.limits,
    };
    const outcome = await this.repo.commitValidatedResult(commit);

    /* What the commit could not admit — a child past a ceiling — goes to a
       person now, in a second, small write. */
    const escalations = [...s.escalations];
    for (const r of outcome.children.refused) {
      escalations.push(`${task.taskId}: ${r.task.taskType} refused — ${r.reason}`);
      await this.repo.audit({ action: "core_v2.follow_up.escalated", entityType: "workflow_task", entityId: task.taskId, detail: { reason: r.reason, taskType: r.task.taskType } });
      if (r.task.disagreementId) escalations.push(...await this.escalateDisagreement(r.task.disagreementId, task, r.reason));
    }
    for (const f of outcome.followUpsRefused) escalations.push(...await this.escalateDisagreement(f.disagreementId, task, f.reason));
    for (const child of [...outcome.children.created, ...outcome.children.reused]) {
      const kind = s.rewire.find((r) => r.child === child.taskId)?.kind;
      if (kind) await this.rewireDependents(task, child.taskId, kind);
    }
    return done("completed", { childrenCreated: outcome.children.created.length, childrenReused: outcome.children.reused.length, escalations, discovered: task.phase === "discover" || task.phase === "ingest" });
  }

  private async settlementOf(task: TaskRecord, attempt: AttemptRecord, packet: WorkPacket, refToClaimId: Record<string, string>, envelope: AgentResultEnvelope, lookup: Lookup): Promise<Settlement> {
    const s: Settlement = { segments: [], claims: [], assessments: [], disagreements: [], claimTransitions: [], disagreementRounds: [], disagreementTransitions: [], decisions: [], children: [], dependencies: [], followUps: [], taskTransitions: [], audits: [], escalations: [], rewire: [] };
    const wf = task.workflowId;
    const incomplete = envelope.outcome === "insufficient_evidence";

    /* Segments: what the source declares, at ingest; what a discoverer found. */
    if (task.phase === "ingest") {
      const source = this.manifest.sources.find((x) => task.sources.some((r) => r.sourceId === x.sourceId));
      if (source) for (const d of source.declaredSegments) s.segments.push(this.newSegment(wf, d, "deterministic", attempt.attemptId, lookup));
    }
    for (const p of envelope.segments) s.segments.push(this.newSegment(wf, p, this.registry.role(task.roleKey).executorKind === "model" ? "model" : "deterministic", attempt.attemptId, lookup));
    for (const seg of s.segments) lookup.segments.set(seg.segmentId, { ...seg });

    /* Claims and their anchors. */
    const anchorByKey = new Map(envelope.anchors.map((a) => [a.anchorKey, a]));
    const claimIdOf = new Map<string, string>();
    for (const c of envelope.claims) {
      const claimId = entityId("claim", attempt.attemptId, c.claimKey);
      claimIdOf.set(c.claimKey, claimId);
      const anchors: NewAnchor[] = [...new Set(c.anchorKeys)].map((key) => {
        const a = anchorByKey.get(key)!;
        const segment = a.segmentId ? lookup.segments.get(a.segmentId) : null;
        return { anchorId: entityId("anchor", claimId, key), sourceKind: a.sourceKind, sourceId: a.sourceId ?? segment?.sourceId ?? null, segmentId: a.segmentId, locator: a.locator ?? {}, quotedText: a.quotedText, anchorHash: sha256(canonical({ k: a.sourceKind, s: a.sourceId, g: a.segmentId, l: a.locator, q: a.quotedText })) };
      });
      s.claims.push({
        claimId, workflowId: wf, taskId: task.taskId, attemptId: attempt.attemptId, independenceGroup: task.independenceGroup, independenceDomain: attempt.independenceDomain,
        subjectType: c.subjectType, subjectKey: c.subjectKey, predicate: c.predicate, value: c.value, unit: c.unit, observationBasis: c.observationBasis,
        scope: c.scope ?? {}, status: "proposed", machineConfidence: c.machineConfidence, inputClaimIds: (c.inputClaimIds ?? []).map((id) => refToClaimId[id] ?? id),
        incompleteSourceAttempt: incomplete, supersedesClaimId: null, anchors,
      });
    }
    for (const a of envelope.assessments) {
      const claimId = refToClaimId[a.claimRef];
      const assessmentId = entityId("assessment", attempt.attemptId, claimId);
      s.assessments.push({
        assessmentId, workflowId: wf, claimId, attemptId: attempt.attemptId, taskId: task.taskId, assessment: a.assessment, reasonCode: a.reasonCode, explanation: a.explanation,
        proposedValue: a.proposedValue ?? null, proposedUnit: a.proposedUnit ?? null, independenceDomain: attempt.independenceDomain,
        anchors: [...new Set(a.anchorKeys)].map((key) => {
          const x = anchorByKey.get(key)!;
          const segment = x.segmentId ? lookup.segments.get(x.segmentId) : null;
          return { anchorId: entityId("anchor", assessmentId, key), sourceKind: x.sourceKind, sourceId: x.sourceId ?? segment?.sourceId ?? null, segmentId: x.segmentId, locator: x.locator ?? {}, quotedText: x.quotedText, anchorHash: sha256(canonical({ k: x.sourceKind, s: x.sourceId, g: x.segmentId, l: x.locator, q: x.quotedText })) };
        }),
      });
    }
    for (const d of envelope.disagreements) {
      s.disagreements.push({ disagreementId: entityId("disagreement", wf, d.disagreementKey), workflowId: wf, disagreementKey: d.disagreementKey, kind: d.kind, severity: d.severity, subjectSignature: d.subjectSignature, claimIds: d.claimIds.map((id) => refToClaimId[id] ?? id) });
    }

    /* What this result makes necessary. */
    await this.afterCompletion(task, attempt, envelope, s, refToClaimId, lookup);

    /* What the agent asked for. */
    const requests = envelope.requestedActions;
    const dispute = task.disagreementId ? await this.repo.getDisagreement(task.disagreementId) : null;
    const disputeHeld = dispute && (dispute.state === "needs_human" || dispute.state === "resolved" || s.disagreementTransitions.some((t) => t.disagreementId === dispute.disagreementId && (t.to === "needs_human" || t.to === "resolved")));
    if (requests.length && disputeHeld) {
      s.audits.push({ action: "core_v2.follow_up.refused", entityType: "workflow_task", entityId: task.taskId, detail: { reason: "the disagreement is held by a person or settled; nothing more is asked by machine" } });
    } else if (requests.length) {
      const plan = await planFollowUps(task, requests, this.followUpContext(lookup));
      for (const child of plan.children) { s.children.push(child); s.rewire.push({ child: child.taskId, kind: "requires_claims" }); }
      for (const e of plan.escalations) s.escalations.push(`${task.taskId}: ${e.reason}`);
      for (const r of plan.refused) s.audits.push({ action: "core_v2.follow_up.refused", entityType: "workflow_task", entityId: task.taskId, detail: { action: r.request.actionType, reason: r.reason } });
      for (const e of plan.escalations) s.audits.push({ action: "core_v2.follow_up.escalated", entityType: "workflow_task", entityId: task.taskId, detail: { action: e.request.actionType, reason: e.reason } });
    }
    return s;
  }

  private newSegment(wf: string, d: { sourceId: string; parentSegmentId: string | null; segmentKind: string; label: string | null; ordinal: number; locator: SegmentRecord["locator"]; contentHash: string }, by: NewSegment["discoveredBy"], attemptId: string, lookup: Lookup): NewSegment {
    const segmentId = segmentIdFor(wf, d.sourceId, d.parentSegmentId, d.segmentKind, d.contentHash);
    const parent = d.parentSegmentId ? lookup.segments.get(d.parentSegmentId) : null;
    /* Accepted by rule when structurally consistent: a source's own declared
       segments always are; a discoverer's are when they lie inside their
       parent, which the validator already required. */
    const status: NewSegment["status"] = parent || d.parentSegmentId === null ? "accepted" : "proposed";
    return { segmentId, workflowId: wf, sourceId: d.sourceId, parentSegmentId: d.parentSegmentId, segmentKind: d.segmentKind, label: d.label, ordinal: d.ordinal, locator: d.locator, contentHash: d.contentHash, status, discoveredBy: by, discoveredByAttemptId: attemptId };
  }

  private followUpContext(lookup: Lookup): FollowUpContext {
    return { repo: this.repo, lookup, registry: this.registry, pack: this.pack, policy: this.policy };
  }

  /* A dependent that has not started yet also waits for the new child. */
  private async rewireDependents(parent: TaskRecord, childTaskId: string, kind: "requires_claims" | "requires_resolution") {
    for (const d of await this.repo.getDependents(parent.taskId)) {
      const dependent = await this.repo.getTask(d.taskId);
      if (!dependent || !["created", "blocked", "queued"].includes(dependent.state)) continue;
      if (dependent.taskId === childTaskId) continue;
      try { await this.repo.addDependency(dependent.taskId, childTaskId, kind, this.limits); }
      catch (error) { this.escalations.push(`${dependent.taskId}: ${(error as Error).message}`); }
    }
  }

  /* ───────────────────────────────────────── what a result makes necessary */

  private async afterCompletion(task: TaskRecord, attempt: AttemptRecord, envelope: AgentResultEnvelope, s: Settlement, refToClaimId: Record<string, string>, lookup: Lookup) {
    const role = this.registry.role(task.roleKey);
    switch (task.phase) {
      case "ingest":
        /* Identity claims are validated by code against the manifest itself:
           the one deterministic rule that directly validates the source. */
        for (const c of s.claims) {
          const source = this.manifest.sources.find((x) => task.sources.some((r) => r.sourceId === x.sourceId));
          const identity = source ? sourceIdentityOf(source) : null;
          if (c.predicate === "content_identity" && identity && c.value.text === identity && c.anchors.length) this.acceptByRule(task, attempt, c.claimId, "source_identity_matches_manifest", [], s);
        }
        return;
      case "analyze":
      case "discover":
        return;
      case "compare":
        return this.afterComparison(task, envelope, s, refToClaimId, lookup);
      case "verify":
        return task.taskType === KERNEL_TASK_TYPES.verifyDisagreement ? this.afterVerification(task, attempt, envelope, s, lookup) : this.afterCriticism(task, attempt, s, refToClaimId, lookup);
      case "adjudicate":
        return this.afterAdjudication(task, attempt, envelope, s, refToClaimId, lookup);
      case "derive":
        /* A derived claim is accepted when every input it names is accepted. */
        for (const c of s.claims) {
          const inputs = await Promise.all(c.inputClaimIds.map((id) => this.repo.getClaim(id)));
          if (inputs.length && inputs.every((i) => i && i.status === "accepted") && c.anchors.length) this.acceptByRule(task, attempt, c.claimId, `derived:${task.taskType}`, c.inputClaimIds, s);
        }
        return;
      case "compose":
        for (const d of envelope.decisions) {
          s.decisions.push({ decideTo: null, decision: {
            decisionId: entityId("decision", task.taskId, d.title), workflowId: task.workflowId, taskId: task.taskId, disagreementId: null,
            decisionType: d.decisionType, subjectKey: task.subjectKey, title: d.title, status: "proposed", authority: "adjudicator", rationale: d.summary.supportingEvidence,
            riskLevel: d.riskLevel, decidedByAttemptId: attempt.attemptId,
            evidence: [
              ...d.supportingClaimIds.map((id) => ({ claimId: refToClaimId[id] ?? id, anchorId: null, link: "supports" as const, rule: null })),
              ...d.contradictingClaimIds.map((id) => ({ claimId: refToClaimId[id] ?? id, anchorId: null, link: "contradicts" as const, rule: null })),
            ],
            actions: d.actions, summary: d.summary,
          } });
        }
        return;
      default:
        void role;
        return;
    }
  }

  /* Agreement between blind readers makes claims corroborated — and nothing
     more. What it makes necessary is a critic: an independent verification
     of the corroborated reading against its own anchors. Disagreement makes
     a verifier and an arbiter. */
  private async afterComparison(task: TaskRecord, envelope: AgentResultEnvelope, s: Settlement, refToClaimId: Record<string, string>, lookup: Lookup) {
    const toVerify: string[] = [];
    for (const group of envelope.calculations) {
      const members = (await Promise.all(group.inputClaimIds.map((id) => this.repo.getClaim(refToClaimId[id] ?? id)))).filter(Boolean) as ClaimRecord[];
      if (new Set(members.map((m) => m.independenceGroup)).size < 2) continue;
      for (const m of members) if (m.status === "proposed") s.claimTransitions.push({ claimId: m.claimId, from: "proposed", to: "corroborated" });
      const representative = [...members].sort((a, b) => Number(a.incompleteSourceAttempt) - Number(b.incompleteSourceAttempt) || (a.independenceGroup ?? "").localeCompare(b.independenceGroup ?? "") || a.claimId.localeCompare(b.claimId))[0];
      if (representative.anchorIds.length && !representative.incompleteSourceAttempt && representative.value.known) toVerify.push(representative.claimId);
    }
    if (toVerify.length) {
      const anchors = await this.repo.listAnchors(toVerify);
      const places = [...new Set(anchors.map((a) => a.segmentId ?? a.sourceId).filter(Boolean) as string[])];
      const role = this.registry.role("evidence_critic");
      const sources = places.slice(0, role.maximumSources).map((id) => (lookup.segments.has(id) ? { sourceId: null, segmentId: id } : { sourceId: id, segmentId: null }));
      const child = childTask(task, "verify", KERNEL_TASK_TYPES.verifyClaim, `${task.subjectKey}/corroborated`, sources, null, null, [...toVerify].sort(), this.followUpContext(lookup), task.depth + 1);
      s.children.push(child);
      s.rewire.push({ child: child.taskId, kind: "requires_claims" });
    }

    const verifiable = s.disagreements.filter((d) => this.policy.verifySeverities.includes(d.severity))
      .sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || a.disagreementKey.localeCompare(b.disagreementKey));
    const toDispute = verifiable.slice(0, this.policy.maximumVerifiedDisagreementsPerSubject);
    for (const dis of verifiable.slice(toDispute.length)) {
      this.escalateNew(dis, task, `${verifiable.length} disagreements on one subject exceed the ${this.policy.maximumVerifiedDisagreementsPerSubject} the policy verifies`, s);
    }
    for (const dis of toDispute) {
      if (this.policy.escalateImmediatelyAtSeverity && dis.severity === this.policy.escalateImmediatelyAtSeverity) { this.escalateNew(dis, task, "severity policy sends this straight to a person", s); continue; }
      await this.disputeChildren(task, dis, s, lookup, refToClaimId);
    }
  }

  /* A critic's support, from an independent domain, on an anchor at the
     claim's own place, is what accepts a reading. Never the critic's word
     alone on a reading its own domain made. */
  private async afterCriticism(task: TaskRecord, attempt: AttemptRecord, s: Settlement, refToClaimId: Record<string, string>, lookup: Lookup) {
    const disputeKindOf: Partial<Record<AssessmentRecord["assessment"], DisagreementRecord["kind"]>> = { contradicts: "value", wrong_unit: "unit", wrong_scope: "scope", duplicate: "duplicate" };
    for (const a of s.assessments) {
      const claim = await this.repo.getClaim(a.claimId);
      if (!claim || !["proposed", "corroborated"].includes(claim.status)) continue;
      /* Belt and braces on the router: a verdict from a domain that made
         this reading, or any reading that agreed with it, is not an
         independent verification and nothing is done with it. */
      if ((await this.domainsBehind([claim.claimId])).includes(attempt.independenceDomain)) continue;
      if (a.assessment === "supports") {
        if (claim.anchorIds.length === 0 || claim.incompleteSourceAttempt) continue;
        s.claimTransitions.push({ claimId: claim.claimId, from: claim.status, to: "verified" });
        this.acceptByRule(task, attempt, claim.claimId, "independent_verification_supports_anchor", [], s, a.anchors.map((x) => x.anchorId), "verified");
        continue;
      }
      /* The source, reopened, does not show what the readers agreed on. That
         is a dispute between the readings and the source — verified again,
         adjudicated, never quietly left corroborated. Every reading that
         agreed with this one is in it. */
      const peers = (await this.repo.listClaims({ workflowId: task.workflowId, subjectKey: claim.subjectKey }))
        .filter((c) => c.predicate === claim.predicate && canonical(c.scope) === canonical(claim.scope) && ["proposed", "corroborated"].includes(c.status) && c.independenceGroup !== null);
      const members = [claim, ...peers.filter((c) => c.claimId !== claim.claimId && canonical(c.value) === canonical(claim.value) && c.unit === claim.unit)];
      const signature = { subject_type: claim.subjectType, subject_key: this.pack.normaliseKey(claim.subjectKey), predicate: claim.predicate.toLowerCase(), scope: JSON.stringify(claim.scope) };
      const key = entityId("disagreement-key", task.workflowId, claim.subjectKey, JSON.stringify(signature), "verification", a.assessment);
      if (s.disagreements.some((d) => d.disagreementKey === key) || (await this.repo.listDisagreements(task.workflowId)).some((d) => d.disagreementKey === key)) continue;
      const kind = disputeKindOf[a.assessment];
      const dis: NewDisagreement = { disagreementId: entityId("disagreement", task.workflowId, key), workflowId: task.workflowId, disagreementKey: key, kind: kind ?? "coverage", severity: "material", subjectSignature: { ...signature, subject_key: claim.subjectKey, found_by: "verification" }, claimIds: members.map((m) => m.claimId).sort() };
      s.disagreements.push(dis);
      if (!kind) { this.escalateNew(dis, task, `the reopened source could not be read for this claim (${a.assessment}); a person decides`, s); continue; }
      await this.disputeChildren(task, dis, s, lookup, refToClaimId);
    }
  }

  /* One verifier and one arbiter for a dispute, the arbiter after the
     verifier, both one level deeper than the task that raised it. */
  private async disputeChildren(task: TaskRecord, dis: NewDisagreement, s: Settlement, lookup: Lookup, _refs: Record<string, string>) {
    const anchors = await this.repo.listAnchors(dis.claimIds);
    const places = [...new Set(anchors.map((a) => a.segmentId ?? a.sourceId).filter(Boolean) as string[])];
    const ctx = this.followUpContext(lookup);
    const toRefs = (n: number) => places.slice(0, n).map((id) => (lookup.segments.has(id) ? { sourceId: null, segmentId: id } : { sourceId: id, segmentId: null }));
    const subject = task.subjectKey.split("/corroborated")[0];
    const verify = childTask(task, "verify", KERNEL_TASK_TYPES.verifyDisagreement, `${subject}/${dis.disagreementKey.slice(-8)}/verify-1`, toRefs(this.registry.role("disagreement_verifier").maximumSources), null, dis.disagreementId, [], ctx, task.depth + 1);
    const adjudicate = childTask(task, "adjudicate", KERNEL_TASK_TYPES.adjudicate, `${subject}/${dis.disagreementKey.slice(-8)}/adjudicate-1`, toRefs(this.registry.role("evidence_arbiter").maximumSources), null, dis.disagreementId, [], ctx, task.depth + 1);
    adjudicate.dependsOn = [{ taskId: verify.taskId, kind: "requires_completion" }];
    s.children.push(verify, adjudicate);
    s.rewire.push({ child: adjudicate.taskId, kind: "requires_resolution" });
    s.disagreementTransitions.push({ disagreementId: dis.disagreementId, from: "open", to: "verifying" });
  }

  private async afterVerification(task: TaskRecord, attempt: AttemptRecord, envelope: AgentResultEnvelope, s: Settlement, lookup: Lookup) {
    if (!task.disagreementId) return;
    const dis = await this.repo.getDisagreement(task.disagreementId);
    if (!dis || dis.state === "needs_human" || dis.state === "resolved") return;
    const rounds = dis.criticRounds + 1;
    s.disagreementRounds.push({ disagreementId: dis.disagreementId, criticRounds: rounds });
    void attempt;
    if (envelope.outcome === "insufficient_evidence") {
      if (rounds >= this.policy.maximumCriticRounds || envelope.requestedActions.length === 0) {
        envelope.requestedActions = [];
        this.escalateExisting(dis, task, rounds >= this.policy.maximumCriticRounds ? `${rounds} rounds of criticism could not read the source` : "the verifier could not read the source and asked for nothing", s);
        return;
      }
      /* Exactly one more verification round, one level deeper. */
      const requests = envelope.requestedActions.slice(0, 1);
      envelope.requestedActions = [];
      const plan = await planFollowUps(task, requests, this.followUpContext(lookup));
      if (plan.escalations.length || plan.children.length === 0) { this.escalateExisting(dis, task, plan.escalations[0]?.reason ?? plan.refused[0]?.reason ?? "no follow-up could be made", s); return; }
      const child = { ...plan.children[0], disagreementId: dis.disagreementId, criticRound: rounds };
      s.children.push(child);
      s.followUps.push({ disagreementId: dis.disagreementId, round: rounds, fingerprint: requests[0].idempotencyFingerprint, taskId: child.taskId });
      const pendingArbiters = (await this.repo.listTasks(task.workflowId)).filter((t) => t.taskType === KERNEL_TASK_TYPES.adjudicate && t.disagreementId === dis.disagreementId && !TERMINAL_TASK_STATES.includes(t.state));
      for (const arb of pendingArbiters) s.dependencies.push({ taskId: arb.taskId, dependsOnTaskId: child.taskId, kind: "requires_completion" });
    }
  }

  private async afterAdjudication(task: TaskRecord, attempt: AttemptRecord, envelope: AgentResultEnvelope, s: Settlement, refToClaimId: Record<string, string>, lookup: Lookup) {
    const proposal = envelope.adjudication;
    if (!proposal || !task.disagreementId) return;
    const dis = await this.repo.getDisagreement(task.disagreementId);
    if (!dis || dis.state === "resolved" || dis.state === "needs_human") return;
    const rounds = dis.arbiterRounds + 1;
    s.disagreementRounds.push({ disagreementId: dis.disagreementId, arbiterRounds: rounds });
    const anchorsOf = proposal.evidenceAnchorIds;

    switch (proposal.outcome) {
      case "accept_claim": {
        const acceptedId = refToClaimId[proposal.acceptedClaimRef!];
        if (!acceptedId) return this.escalateExisting(dis, task, "the arbiter accepted a claim the packet did not present", s);
        return this.resolveWith(task, attempt, dis, "accept_claim", proposal, acceptedId, anchorsOf, s);
      }
      case "correct": {
        const template = await this.repo.getClaim([...dis.claimIds].sort()[0]);
        if (!template || anchorsOf.length === 0) return this.escalateExisting(dis, task, "a correction needs source anchors", s);
        const reviewers = await this.repo.listAssessments(dis.claimIds);
        const anchors = [...await this.repo.listAnchors(dis.claimIds), ...await this.repo.listAssessmentAnchors(reviewers.map((a) => a.assessmentId))].filter((a) => anchorsOf.includes(a.anchorId));
        if (anchors.length === 0) return this.escalateExisting(dis, task, "the correction rests on anchors the record does not hold", s);
        /* Whether the correction rests on somebody else's reading of the
           source. An arbiter that corrects on nothing but its own domain's
           reviewing has proposed a value, not established one. */
        const reviewedElsewhere = anchors.some((a) => a.assessmentId !== null
          && reviewers.some((r) => r.assessmentId === a.assessmentId && r.independenceDomain !== attempt.independenceDomain));
        const claimId = entityId("claim", attempt.attemptId, "corrected");
        s.claims.push({
          claimId, workflowId: task.workflowId, taskId: task.taskId, attemptId: attempt.attemptId, independenceGroup: null, independenceDomain: attempt.independenceDomain,
          subjectType: template.subjectType, subjectKey: template.subjectKey, predicate: template.predicate, value: proposal.correctedValue!, unit: proposal.correctedUnit ?? template.unit,
          observationBasis: template.observationBasis, scope: template.scope, status: "proposed", machineConfidence: null, inputClaimIds: [], incompleteSourceAttempt: false, supersedesClaimId: null,
          anchors: anchors.map((a) => ({ anchorId: entityId("anchor", claimId, a.anchorId), sourceKind: a.sourceKind, sourceId: a.sourceId, segmentId: a.segmentId, locator: a.locator, quotedText: a.quotedText, anchorHash: a.anchorHash })),
        });
        return this.resolveWith(task, attempt, dis, "accept_claim", proposal, claimId, anchorsOf, s, "corrected", reviewedElsewhere);
      }
      case "reject_all":
        return this.resolveWith(task, attempt, dis, "reject_all", proposal, null, anchorsOf, s);
      case "needs_human":
        return this.escalateExisting(dis, task, proposal.rationale, s);
      case "needs_more_evidence": {
        const request = proposal.followUp!;
        if (dis.followUps.some((f) => f.fingerprint === request.idempotencyFingerprint)) return this.escalateExisting(dis, task, "the arbiter asked for the same evidence again — a person decides", s);
        if (rounds >= this.policy.maximumArbiterRounds) return this.escalateExisting(dis, task, `${rounds} rounds of arbitration asked for more evidence`, s);
        if (dis.followUps.some((f) => f.round === dis.criticRounds + 1)) return this.escalateExisting(dis, task, "this round already has its one follow-up — a person decides", s);
        const plan = await planFollowUps(task, [request], this.followUpContext(lookup));
        if (plan.children.length === 0) return this.escalateExisting(dis, task, plan.escalations[0]?.reason ?? plan.refused[0]?.reason ?? "no follow-up could be made", s);
        const verify = { ...plan.children[0], disagreementId: dis.disagreementId, criticRound: dis.criticRounds };
        const again = childTask(task, "adjudicate", KERNEL_TASK_TYPES.adjudicate, `${dis.disagreementKey.slice(-8)}/adjudicate-${rounds + 1}`, task.sources, null, dis.disagreementId, [], this.followUpContext(lookup), task.depth + 1);
        again.dependsOn = [{ taskId: verify.taskId, kind: "requires_completion" }];
        s.children.push(verify, again);
        s.followUps.push({ disagreementId: dis.disagreementId, round: dis.criticRounds + 1, fingerprint: request.idempotencyFingerprint, taskId: verify.taskId });
        s.rewire.push({ child: again.taskId, kind: "requires_resolution" });
        envelope.requestedActions = [];
        return;
      }
    }
  }

  private async resolveWith(task: TaskRecord, attempt: AttemptRecord, dis: DisagreementRecord, type: "accept_claim" | "reject_all", proposal: ProposedAdjudication, acceptedClaimId: string | null, anchorIds: string[], s: Settlement, label: string = type, reviewedElsewhere: boolean = false) {
    const decisionId = entityId("decision", task.taskId, label);
    const evidence: DecisionRecord["evidence"] = [];
    if (acceptedClaimId) {
      const pending = s.claims.find((c) => c.claimId === acceptedClaimId);
      const accepted = pending ?? await this.repo.getClaim(acceptedClaimId);
      const anchorsCount = pending ? pending.anchors.length : (accepted as ClaimRecord | null)?.anchorIds.length ?? 0;
      if (!accepted || anchorsCount === 0 || accepted.incompleteSourceAttempt) return this.escalateExisting(dis, task, "the arbiter accepted a reading that is unanchored or was cut short — a person decides", s);
      if (!await this.acceptanceCanStand(task.workflowId, acceptedClaimId, accepted.independenceDomain ?? null, reviewedElsewhere)) {
        return this.escalateExisting(dis, task,
          "nothing from outside the domain that produced this value has confirmed it: an acceptance needs a reading of the source from another domain, a deterministic rule or a person, so a person decides", s);
      }
      s.claimTransitions.push({ claimId: acceptedClaimId, from: accepted.status, to: "accepted" });
      evidence.push({ claimId: acceptedClaimId, anchorId: null, link: "supports", rule: null });
    }
    for (const id of dis.claimIds) {
      if (id === acceptedClaimId) continue;
      const claim = await this.repo.getClaim(id);
      if (claim && claim.status === "accepted") s.claimTransitions.push({ claimId: id, from: "accepted", to: "superseded" });
      else if (claim && claim.status !== "rejected") s.claimTransitions.push({ claimId: id, from: claim.status, to: "rejected" });
      evidence.push({ claimId: id, anchorId: null, link: "contradicts", rule: null });
    }
    for (const a of anchorIds) evidence.push({ claimId: null, anchorId: a, link: "context", rule: null });
    s.decisions.push({ decideTo: "machine_decided", decision: {
      decisionId, workflowId: task.workflowId, taskId: task.taskId, disagreementId: dis.disagreementId, decisionType: type, subjectKey: String(dis.subjectSignature.subject_key ?? dis.disagreementKey),
      title: `${dis.subjectSignature.subject_key ?? dis.disagreementKey}: ${label.replace("_", " ")}`, status: "proposed", authority: "adjudicator",
      rationale: proposal.rationale, riskLevel: dis.severity === "critical" ? "high" : "normal", decidedByAttemptId: attempt.attemptId, evidence, actions: [], summary: null,
    } });
    s.disagreementTransitions.push({ disagreementId: dis.disagreementId, from: dis.state, to: "resolved", resolutionDecisionId: decisionId });
    s.audits.push({ action: "core_v2.disagreement.adjudicated", entityType: "disagreement", entityId: dis.disagreementId, detail: { outcome: label, decision: decisionId, accepted: acceptedClaimId, kept: dis.claimIds } });
  }

  /* WHAT THE RECORD WILL LET STAND, ASKED BEFORE IT IS WRITTEN.
     docs/core-v2.md §4, and the guard migration 058 enforces at the end of
     every write: a machine reading becomes accepted on a verdict from
     another executor domain, on a deterministic rule, on a person — or, for
     an adjudicator's correction, on a reviewer's anchor from a domain other
     than the one that made the correction. This is not a second rule beside
     that one; it is the same rule asked in time. Without it an engine that
     composes an acceptance the record refuses ends its attempt with an
     engine error, where the honest outcome was a subject held for a person.

     Three domains are not always enough for this to be satisfiable. Two
     blind readings, a reviewer that is neither of them, and an arbiter that
     is none of the three is four domains; with three providers configured,
     an arbiter's correction is a proposal a person settles, and that is the
     correct answer rather than a failure. */
  private async acceptanceCanStand(workflowId: string, claimId: string, domain: string | null, reviewedElsewhere: boolean): Promise<boolean> {
    if (!domain) return true;
    if (reviewedElsewhere) return true;
    const supported = (await this.repo.listAssessments([claimId])).some((a) => a.assessment === "supports" && a.independenceDomain !== domain);
    if (supported) return true;
    return (await this.repo.listDecisions(workflowId)).some((d) => (d.authority === "deterministic_rule" || d.authority === "human")
      && d.evidence.some((e) => e.claimId === claimId && e.link === "supports"));
  }

  /* A dispute that goes to a person: the claims become unresolved, a hold
     decision is written, pending machine work on it is superseded, and what
     depended on that work waits. */
  private escalateNew(dis: NewDisagreement, task: TaskRecord, reason: string, s: Settlement) {
    const decisionId = entityId("decision", dis.disagreementId, "needs_human");
    s.decisions.push({ decideTo: "needs_human", decision: {
      decisionId, workflowId: task.workflowId, taskId: task.taskId, disagreementId: dis.disagreementId, decisionType: "hold", subjectKey: String(dis.subjectSignature.subject_key ?? dis.disagreementKey),
      title: `${dis.subjectSignature.subject_key ?? dis.disagreementKey}: a person decides`, status: "proposed", authority: "adjudicator", rationale: reason,
      riskLevel: dis.severity === "critical" ? "high" : "normal", decidedByAttemptId: null,
      evidence: dis.claimIds.map((id) => ({ claimId: id, anchorId: null, link: "context" as const, rule: null })), actions: [{ actionType: "review", ownerRole: "reviewer" }], summary: null,
    } });
    s.disagreementTransitions.push({ disagreementId: dis.disagreementId, from: "open", to: "needs_human", needsHumanReason: reason });
    s.escalations.push(`${dis.subjectSignature.subject_key ?? dis.disagreementKey}: ${reason}`);
    s.audits.push({ action: "core_v2.disagreement.needs_human", entityType: "disagreement", entityId: dis.disagreementId, detail: { reason } });
  }

  private async escalateExisting(dis: DisagreementRecord, task: TaskRecord, reason: string, s: Settlement) {
    if (s.disagreementTransitions.some((t) => t.disagreementId === dis.disagreementId)) return;
    for (const id of dis.claimIds) {
      const c = await this.repo.getClaim(id);
      if (c && c.status === "disputed" && !s.claimTransitions.some((t) => t.claimId === id)) s.claimTransitions.push({ claimId: id, from: "disputed", to: "unresolved" });
    }
    const decisionId = entityId("decision", dis.disagreementId, "needs_human");
    if (!(await this.repo.getDecision(decisionId))) {
      s.decisions.push({ decideTo: "needs_human", decision: {
        decisionId, workflowId: task.workflowId, taskId: task.taskId, disagreementId: dis.disagreementId, decisionType: "hold", subjectKey: String(dis.subjectSignature.subject_key ?? dis.disagreementKey),
        title: `${dis.subjectSignature.subject_key ?? dis.disagreementKey}: a person decides`, status: "proposed", authority: "adjudicator", rationale: reason,
        riskLevel: dis.severity === "critical" ? "high" : "normal", decidedByAttemptId: null,
        evidence: dis.claimIds.map((id) => ({ claimId: id, anchorId: null, link: "context" as const, rule: null })), actions: [{ actionType: "review", ownerRole: "reviewer" }], summary: null,
      } });
    }
    s.disagreementTransitions.push({ disagreementId: dis.disagreementId, from: dis.state, to: "needs_human", needsHumanReason: reason });
    for (const t of await this.repo.listTasks(task.workflowId)) {
      if (t.disagreementId === dis.disagreementId && t.taskId !== task.taskId && ["created", "blocked", "queued"].includes(t.state)) {
        if (t.state === "created") s.taskTransitions.push({ taskId: t.taskId, from: "created", to: "blocked", reason: null });
        s.taskTransitions.push({ taskId: t.taskId, from: t.state === "created" ? "blocked" : t.state as TaskState, to: "superseded", reason: "needs_human" });
      }
    }
    s.escalations.push(`${dis.subjectSignature.subject_key ?? dis.disagreementKey}: ${reason}`);
    s.audits.push({ action: "core_v2.disagreement.needs_human", entityType: "disagreement", entityId: dis.disagreementId, detail: { reason } });
  }

  /* Escalation outside a commit: a dispute whose verifier or arbiter did not
     finish, or whose follow-up could not be admitted. */
  private async escalateDisagreement(disagreementId: string, task: TaskRecord, reason: string): Promise<string[]> {
    const dis = await this.repo.getDisagreement(disagreementId);
    if (!dis || (dis.state !== "open" && dis.state !== "verifying")) return [];
    const decisionId = entityId("decision", dis.disagreementId, "needs_human");
    for (const id of dis.claimIds) {
      const c = await this.repo.getClaim(id);
      if (c && c.status === "disputed") await this.repo.transitionClaim(id, "disputed", "unresolved");
    }
    if (!(await this.repo.getDecision(decisionId))) {
      await this.repo.applyDecision({ decideTo: "needs_human", decision: {
        decisionId, workflowId: task.workflowId, taskId: task.taskId, disagreementId: dis.disagreementId, decisionType: "hold", subjectKey: String(dis.subjectSignature.subject_key ?? dis.disagreementKey),
        title: `${dis.subjectSignature.subject_key ?? dis.disagreementKey}: a person decides`, status: "proposed", authority: "adjudicator", rationale: reason,
        riskLevel: dis.severity === "critical" ? "high" : "normal", decidedByAttemptId: null,
        evidence: dis.claimIds.map((id) => ({ claimId: id, anchorId: null, link: "context" as const, rule: null })), actions: [{ actionType: "review", ownerRole: "reviewer" }], summary: null,
      } });
    }
    await this.repo.transitionDisagreement({ disagreementId: dis.disagreementId, from: dis.state, to: "needs_human", needsHumanReason: reason });
    for (const t of await this.repo.listTasks(task.workflowId)) {
      if (t.disagreementId === dis.disagreementId && t.taskId !== task.taskId && ["created", "blocked", "queued"].includes(t.state)) {
        if (t.state === "created") await this.repo.transitionTask(t.taskId, "created", "blocked");
        await this.repo.transitionTask(t.taskId, t.state === "created" ? "blocked" : t.state, "superseded", "needs_human");
      }
    }
    await this.repo.audit({ action: "core_v2.disagreement.needs_human", entityType: "disagreement", entityId: dis.disagreementId, detail: { reason } });
    await this.markNeedsAttention(task.workflowId);
    return [`${dis.subjectSignature.subject_key ?? dis.disagreementKey}: ${reason}`];
  }

  private async escalateDisputeOf(taskId: string, state: string): Promise<string[]> {
    const task = await this.repo.getTask(taskId);
    if (!task) return [];
    const reason = `${task.taskType} ended ${state}: ${task.terminalReason ?? "no reason recorded"}`;
    if (task.disagreementId) return this.escalateDisagreement(task.disagreementId, task, reason);
    /* A blind reading that did not come back leaves its subject read once
       at most: the subject is held for a person, not called read. */
    if (task.independenceGroup) return this.holdSubjectForCoverage(task, reason);
    return [];
  }

  /* A subject whose second independent reading cannot be had is not read
     once and called read: it is held for a person as a coverage dispute. */
  private async holdSubjectForCoverage(task: TaskRecord, reason: string): Promise<string[]> {
    const key = entityId("disagreement-key", task.workflowId, task.subjectKey, "coverage");
    const existing = (await this.repo.listDisagreements(task.workflowId)).find((d) => d.disagreementKey === key);
    if (existing) return [];
    const others = (await this.repo.listClaims({ workflowId: task.workflowId })).filter((c) => c.taskId && c.taskId !== task.taskId);
    const readers = (await this.repo.listTasks(task.workflowId)).filter((t) => t.subjectKey === task.subjectKey && t.independenceGroup !== null && t.taskId !== task.taskId).map((t) => t.taskId);
    /* What the hold is about: the readings of this subject, or — for a
       verification that could not be given an independent judge — the very
       claims it was to have judged. */
    const claimIds = others.filter((c) => readers.includes(c.taskId!)).map((c) => c.claimId);
    if (claimIds.length === 0) claimIds.push(...task.targetClaimIds.filter((id) => others.some((c) => c.claimId === id) || true));
    const disagreementId = entityId("disagreement", task.workflowId, key);
    const decisionId = entityId("decision", disagreementId, "needs_human");
    const held = await this.repo.holdSubject({
      workflowId: task.workflowId,
      disagreement: { disagreementId, workflowId: task.workflowId, disagreementKey: key, kind: "coverage", severity: "material", subjectSignature: { subject_key: task.subjectKey, reason: "independence_unavailable" }, claimIds },
      decision: { decideTo: "needs_human", decision: { decisionId, workflowId: task.workflowId, taskId: task.taskId, disagreementId, decisionType: "hold", subjectKey: task.subjectKey, title: `${task.subjectKey}: a second independent reading could not be had`, status: "proposed", authority: "adjudicator", rationale: reason, riskLevel: "normal", decidedByAttemptId: null, evidence: claimIds.map((id) => ({ claimId: id, anchorId: null, link: "context" as const, rule: null })), actions: [{ actionType: "review", ownerRole: "reviewer" }], summary: null } },
      transition: { disagreementId, from: "open", to: "needs_human", needsHumanReason: reason },
      audits: [{ action: "core_v2.subject.needs_attention", entityType: "workflow_task", entityId: task.taskId, detail: { subject: task.subjectKey, reason } }],
    });
    if (held.alreadyHeld) return [];
    await this.markNeedsAttention(task.workflowId);
    return [`${task.subjectKey}: ${reason}`];
  }

  /* Deterministic acceptance: a claim with an anchor, admitted by a written
     rule, recorded as a decision whose evidence is the claim. Never a majority. */
  private acceptByRule(task: TaskRecord, attempt: AttemptRecord, claimId: string, rule: string, corroboratingClaimIds: string[], s: Settlement, anchorIds: string[] = [], from: ClaimRecord["status"] = "proposed") {
    if (!s.claimTransitions.some((t) => t.claimId === claimId && t.to === "accepted")) s.claimTransitions.push({ claimId, from, to: "accepted" });
    s.decisions.push({ decideTo: "machine_decided", decision: {
      decisionId: entityId("decision", claimId, rule), workflowId: task.workflowId, taskId: task.taskId, disagreementId: null, decisionType: "accept_claim", subjectKey: task.subjectKey,
      title: `${claimId.slice(0, 8)}: accepted by rule`, status: "proposed", authority: "deterministic_rule", rationale: rule, riskLevel: "normal", decidedByAttemptId: attempt.attemptId,
      evidence: [
        { claimId, anchorId: null, link: "supports", rule },
        ...corroboratingClaimIds.map((id) => ({ claimId: id, anchorId: null, link: "context" as const, rule })),
        ...anchorIds.map((id) => ({ claimId: null, anchorId: id, link: "context" as const, rule })),
      ],
      actions: [], summary: null,
    } });
  }

  private async refreshProgress() {
    const wf = this.manifest.workflowId;
    const tasks = await this.repo.listTasks(wf);
    const terminal = tasks.filter((t) => TERMINAL_TASK_STATES.includes(t.state)).length;
    const attention = tasks.filter((t) => t.state === "failed_known" || t.state === "outcome_unknown").length
      + (await this.repo.listDisagreements(wf)).filter((d) => d.state === "needs_human").length;
    await this.repo.updateWorkflowProgress(wf, { totalUnits: tasks.length, completedUnits: terminal, attentionUnits: attention });
  }
}

/* ───────────────────────────────────────────────────────── helpers */

function severityRank(severity: DisagreementRecord["severity"]): number {
  return severity === "critical" ? 0 : severity === "material" ? 1 : 2;
}

export class AttemptTimeout extends Error {}

export function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new AttemptTimeout(`no answer within ${ms} ms`)), ms);
    work.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

/* Whatever came back is given the envelope's shape before anything reads it. */
export function normaliseEnvelope(raw: unknown): AgentResultEnvelope {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<AgentResultEnvelope>;
  const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  const outcomes = ["completed", "needs_follow_up", "insufficient_evidence", "failed_known", "outcome_unknown"];
  const isEnvelope = raw && typeof raw === "object" && outcomes.includes(String(r.outcome));
  return {
    packetVersion: String(r.packetVersion ?? ""), taskId: String(r.taskId ?? ""), roleKey: String(r.roleKey ?? ""), roleVersion: String(r.roleVersion ?? ""),
    outcome: isEnvelope ? (r.outcome as AgentResultEnvelope["outcome"]) : "failed_known",
    claims: arr(r.claims), anchors: arr(r.anchors), segments: arr(r.segments), assessments: arr(r.assessments), disagreements: arr(r.disagreements),
    requestedActions: arr(r.requestedActions),
    limitations: isEnvelope ? arr<string>(r.limitations) : [`the executor returned something that is not an envelope: ${JSON.stringify(raw)?.slice(0, 200) ?? String(raw)}`],
    rawResponseReference: typeof r.rawResponseReference === "string" ? r.rawResponseReference : null,
    adjudication: r.adjudication && typeof r.adjudication === "object" ? r.adjudication : null,
    decisions: arr(r.decisions), calculations: arr(r.calculations),
  };
}

export type { AttemptState };
