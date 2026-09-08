/* THE LOOP THAT FANS WORK OUT AND GATHERS IT BACK.
 *
 * One tick: release whatever is no longer waiting, pick what may run within
 * the concurrency limits, lease it, build each role's packet, route, execute,
 * validate, persist, and decide what the result makes necessary next — a
 * comparison when both blind readers are done, a verifier when they differ, an
 * arbiter when the verifier has spoken, a person when nothing else may decide.
 *
 * It holds no state of its own. Everything it knows is in the repository, so a
 * scheduler that dies and a scheduler that starts afterwards look at the same
 * tasks and attempts and continue without repeating either. A Temporal
 * activity layer can call `tick` later; nothing in here knows Temporal exists.
 *
 * What it will not do, whatever an envelope asks:
 *   · run an agent that calls another agent — children come only through the
 *     follow-up planner, one level deeper each time, deduplicated by identity;
 *   · retry an attempt whose outcome is unknown;
 *   · dispatch anything after cancellation;
 *   · let a failed branch touch a completed one.
 */
import type {
  AgentResultEnvelope, AttemptRecord, ClaimRecord, DecisionRecord, DisagreementRecord, ProposedAdjudication,
  SourceManifest, TaskRecord, WorkPacket, WorkflowRecord,
} from "./contracts.ts";
import { ENGINE_VERSION } from "./contracts.ts";
import type { ExecutorRegistry } from "./executors/executor.ts";
import { childOf, planFollowUps } from "./follow-up-planner.ts";
import { buildTaskGraph, specToRecord } from "./graph-builder.ts";
import type { TaskGraph } from "./graph-builder.ts";
import { shortId } from "./hash.ts";
import type { OrchestrationPolicy } from "./orchestration-policy.ts";
import { buildPacket } from "./packet-builder.ts";
import type { NewTask, OrchestrationRepository } from "./repository.ts";
import { validateEnvelope } from "./result-validator.ts";
import { roleDefinition } from "./role-registry.ts";
import type { AgentRouter } from "./router.ts";
import { TERMINAL_TASK_STATES } from "./transitions.ts";

export type SchedulerOptions = {
  owner: string;
  leaseTtlMs: number;
  now: () => number;
};

export type TickReport = {
  released: number;
  stopped: number;
  dispatched: string[];
  completed: string[];
  failed: string[];
  unknown: string[];
  cancelled: string[];
  childrenCreated: number;
  childrenReused: number;
  escalations: string[];
};

export type RunReport = {
  ticks: number;
  workflow: WorkflowRecord;
  tasks: Record<string, number>;
  byRole: Record<string, number>;
  disagreements: Record<string, number>;
  decisions: Record<string, number>;
  escalations: string[];
};

export class Scheduler {
  repo: OrchestrationRepository;
  manifest: SourceManifest;
  policy: OrchestrationPolicy;
  router: AgentRouter;
  executors: ExecutorRegistry;
  options: SchedulerOptions;
  escalations: string[] = [];

  constructor(
    repo: OrchestrationRepository, manifest: SourceManifest, policy: OrchestrationPolicy,
    router: AgentRouter, executors: ExecutorRegistry, options: SchedulerOptions,
  ) {
    this.repo = repo; this.manifest = manifest; this.policy = policy;
    this.router = router; this.executors = executors; this.options = options;
  }

  /* Plan the graph and record it. Idempotent: planning twice creates nothing
     the second time. */
  async plan(): Promise<{ graph: TaskGraph; created: string[]; existing: string[] }> {
    const wf = this.manifest.workflowId;
    await this.repo.createWorkflow({
      workflowId: wf, organizationId: this.manifest.organizationId, propertyId: this.manifest.propertyId,
      state: "created", cancelRequested: false, totalUnits: 0, completedUnits: 0, attentionUnits: 0,
    });
    const graph = buildTaskGraph(this.manifest, this.policy);
    if (graph.refusals.length) {
      await this.repo.updateWorkflow(wf, { state: "failed" });
      throw new Error(`core-v2: the planner refused this manifest: ${graph.refusals.join("; ")}`);
    }
    const tasks: NewTask[] = graph.tasks.map((spec) => ({ ...specToRecord(spec, wf), dependsOn: spec.dependsOn }));
    const result = await this.repo.planTasks(tasks);
    /* A workflow that was created starts running. One that was cancelled, or
       already ended, keeps saying so: re-planning changes nothing about it. */
    const current = (await this.repo.getWorkflow(wf))!;
    await this.repo.updateWorkflow(wf, { ...(current.state === "created" ? { state: "running" } : {}), totalUnits: (await this.repo.listTasks(wf)).length });
    if (result.created.length) {
      await this.repo.audit({ action: "core_v2.workflow.planned", entityType: "intelligence_workflow", entityId: wf,
        detail: { tasks: result.created.length, independent_subjects: graph.independentSubjects.length, engine: ENGINE_VERSION } });
    }
    return { graph, ...result };
  }

  async cancel(reason: string): Promise<{ unsentCancelled: number; submittedUnresolved: number; completedPreserved: number }> {
    const wf = this.manifest.workflowId;
    await this.repo.updateWorkflow(wf, { cancelRequested: true, state: "cancelled" });
    let unsent = 0, submitted = 0, preserved = 0;
    for (const task of await this.repo.listTasks(wf)) {
      if (task.state === "completed") { preserved++; continue; }
      if (["created", "blocked", "queued", "leased", "running"].includes(task.state)) {
        /* A running task whose attempt was never submitted has cost nothing
           and is cancelled like any other; the repository's guard refuses the
           move once an attempt was sent, and that refusal is the count. */
        try { await this.repo.transitionTask(task.taskId, "cancelled", `cancelled:${reason}`); unsent++; }
        catch { submitted++; }
      } else if (task.state === "outcome_unknown") submitted++;
    }
    await this.repo.audit({ action: "core_v2.workflow.cancelled", entityType: "intelligence_workflow", entityId: wf,
      detail: { reason, unsent_cancelled: unsent, submitted_unresolved: submitted, completed_preserved: preserved } });
    return { unsentCancelled: unsent, submittedUnresolved: submitted, completedPreserved: preserved };
  }

  async tick(): Promise<TickReport> {
    const wf = this.manifest.workflowId;
    const report: TickReport = { released: 0, stopped: 0, dispatched: [], completed: [], failed: [], unknown: [], cancelled: [], childrenCreated: 0, childrenReused: 0, escalations: [] };
    const workflow = await this.repo.getWorkflow(wf);
    if (!workflow) throw new Error("core-v2: plan() before tick()");
    if (workflow.cancelRequested) return report;

    /* What a dead worker left behind. Leased and never run → back to the
       queue. Submitted → unknown, never requeued. */
    for (const t of await this.repo.expireLeases(wf, this.options.now())) {
      const action = t.state === "queued" ? "core_v2.task.lease_reclaimed" : t.state === "outcome_unknown" ? "core_v2.attempt.outcome_unknown" : "core_v2.task.lease_expired";
      await this.repo.audit({ action, entityType: "extraction_task", entityId: t.taskId, detail: { state: t.state, reason: t.terminalReason } });
    }

    const { released, stopped } = await this.repo.releaseDependents(wf);
    report.released = released.length;
    report.stopped = stopped.length;

    /* Concurrency: what is already leased or running counts. */
    const all = await this.repo.listTasks(wf);
    const active = all.filter((t) => t.state === "leased" || t.state === "running");
    const activeByRole = new Map<string, number>();
    for (const t of active) activeByRole.set(t.roleKey, (activeByRole.get(t.roleKey) ?? 0) + 1);
    let room = this.policy.maximumConcurrentTasksPerWorkflow - active.length;

    const chosen: TaskRecord[] = [];
    for (const task of await this.repo.getRunnableTasks(wf)) {
      if (room <= 0) break;
      const roleActive = activeByRole.get(task.roleKey) ?? 0;
      if (roleActive >= this.policy.maximumConcurrentTasksPerRole) continue;
      const leased = await this.repo.leaseTask(task.taskId, this.options.owner, this.options.leaseTtlMs, this.options.now());
      if (!leased) continue;
      chosen.push(leased);
      activeByRole.set(task.roleKey, roleActive + 1);
      room--;
    }
    report.dispatched = chosen.map((t) => t.taskId);

    /* Unrelated assignments run at the same time. */
    const outcomes = await Promise.all(chosen.map((task) => this.runTask(task)));
    for (const o of outcomes) {
      if (o.state === "completed") report.completed.push(o.taskId);
      else if (o.state === "outcome_unknown") report.unknown.push(o.taskId);
      else if (o.state === "cancelled") report.cancelled.push(o.taskId);
      else report.failed.push(o.taskId);
      report.childrenCreated += o.childrenCreated;
      report.childrenReused += o.childrenReused;
      report.escalations.push(...o.escalations);
      /* A dispute whose verifier or arbiter did not finish — an invalid
         answer, an unknown outcome, a fault in this engine — is not left in
         `verifying`. It goes to a person, with the reason. */
      if (o.state === "failed_known" || o.state === "outcome_unknown") report.escalations.push(...await this.escalateDisputeOf(o.taskId, o.state));
    }
    this.escalations.push(...report.escalations);
    await this.refreshProgress();
    return report;
  }

  /* Quiescence — nothing dispatched, released or stopped — is what ends a
     run. The tick ceiling is only a backstop, and it is derived from the
     policy: every productive tick dispatches at least one task, so more ticks
     than tasks can exist means something is spinning. */
  async runUntilQuiescent(maxTicks = this.policy.maximumTasksPerWorkflow + 100): Promise<RunReport> {
    let ticks = 0;
    for (; ticks < maxTicks; ticks++) {
      const r = await this.tick();
      if (r.dispatched.length === 0 && r.released === 0 && r.stopped === 0) break;
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
      tasks: count(tasks, (t) => t.state), byRole: count(tasks, (t) => t.roleKey),
      disagreements: count(await this.repo.listDisagreements(wf), (d) => d.state),
      decisions: count(await this.repo.listDecisions(wf), (d) => `${d.decisionType}:${d.status}`),
      escalations: [...this.escalations],
    };
  }

  /* ───────────────────────────────────────────────── one assignment */

  private async runTask(task: TaskRecord): Promise<{ taskId: string; state: string; childrenCreated: number; childrenReused: number; escalations: string[] }> {
    const done = (state: string, extra: Partial<{ childrenCreated: number; childrenReused: number; escalations: string[] }> = {}) =>
      ({ taskId: task.taskId, state, childrenCreated: 0, childrenReused: 0, escalations: [], ...extra });
    const role = roleDefinition(task.roleKey);

    /* Still leased, not yet running: everything up to submission can be
       abandoned by a dying worker and picked up again without cost. */
    const priorAttempts = await this.repo.listAttempts(task.taskId);
    const attemptNo = priorAttempts.reduce((n, a) => Math.max(n, a.attemptNo), 0) + 1;
    if (priorAttempts.length >= this.policy.maximumAttemptsPerTask) {
      await this.repo.transitionTask(task.taskId, "running");
      await this.repo.transitionTask(task.taskId, "failed_known", "attempt_limit");
      await this.repo.audit({ action: "core_v2.task.attempt_limit", entityType: "extraction_task", entityId: task.taskId, detail: { attempts: priorAttempts.length } });
      return done("failed_known");
    }

    /* The packet — built under the visibility policy, or not built at all. */
    let built;
    try {
      built = await buildPacket(task, this.manifest, this.repo, this.policy);
    } catch (error) {
      const attempt = await this.repo.createAttempt(this.newAttempt(task, attemptNo, "none", "none"));
      await this.repo.transitionAttempt(attempt.attemptId, "rejected_before_submission", { errorCode: "packet_invalid", errorMessage: String((error as Error).message) });
      await this.repo.transitionTask(task.taskId, "running");
      await this.repo.transitionTask(task.taskId, "failed_known", "packet_invalid");
      return done("failed_known");
    }
    const { packet, refToClaimId } = built;

    /* A stop that arrived while the packet was being built. Nothing has been
       sent, so nothing is owed: the lease ends and the task is cancelled. */
    if (await this.stopRequested()) {
      await this.repo.transitionTask(task.taskId, "cancelled", "cancel_requested_before_attempt");
      return done("cancelled");
    }

    /* Routing. An independent reading never goes to a family that already read
       the subject, and never reuses a cached attempt. */
    const previous = task.independenceGroup ? await this.repo.executorFamiliesForSubject(task.workflowId, task.subjectKey) : [];
    const selection = this.router.select({
      roleKey: task.roleKey, taskType: task.taskType, requiresVisualInput: role.requiresVisualInput,
      independenceGroup: task.independenceGroup, previousExecutorFamilies: previous,
      estimatedInputSize: packet.sources.length,
    });
    if (task.independenceGroup && !selection.preservesIndependence) {
      await this.repo.audit({ action: "core_v2.routing.independence_not_preserved", entityType: "extraction_task", entityId: task.taskId,
        detail: { reason: selection.reason, previous } });
    }

    const attempt = await this.repo.createAttempt(this.newAttempt(task, attemptNo, selection.executorFamily, selection.modelConfiguration, packet.inputFingerprint));

    /* The last look before anything is sent: a stop requested since, or a
       task that is no longer ours — cancelled under us while the packet was
       built — closes the attempt unsent. Once marked submitted it is too late
       to ask: the repository refuses cancellation from there, and so this
       check is the one that matters. */
    const unsent = async (reason: string) => {
      await this.repo.transitionAttempt(attempt.attemptId, "cancelled_before_submission", { errorCode: reason });
      const now = await this.repo.getTask(task.taskId);
      if (now && (now.state === "leased" || now.state === "running")) await this.repo.transitionTask(task.taskId, "cancelled", reason);
      await this.repo.audit({ action: "core_v2.attempt.cancelled_before_submission", entityType: "agent_attempt", entityId: attempt.attemptId, detail: { task: task.taskId, reason } });
      return done("cancelled");
    };
    if (await this.stopRequested()) return unsent("cancel_requested_before_submission");
    try { await this.repo.transitionTask(task.taskId, "running"); }
    catch { return unsent("task_no_longer_leased"); }
    if (await this.stopRequested()) return unsent("cancel_requested_before_submission");

    /* Execution. From `submitted` onwards the outcome may have cost something,
       and nothing here retries it — not after an exception, not after a
       timeout, not after a restart. */
    let envelope: AgentResultEnvelope;
    await this.repo.transitionAttempt(attempt.attemptId, "submitted");
    try {
      envelope = normaliseEnvelope(await withDeadline(this.executors.run(selection, packet), this.policy.attemptTimeoutMs));
    } catch (error) {
      const code = error instanceof AttemptTimeout ? "attempt_timeout" : "executor_threw";
      await this.repo.transitionAttempt(attempt.attemptId, "outcome_unknown", { errorCode: code, errorMessage: String((error as Error).message) });
      await this.repo.transitionTask(task.taskId, "outcome_unknown", code);
      await this.repo.audit({ action: "core_v2.attempt.outcome_unknown", entityType: "agent_attempt", entityId: attempt.attemptId, detail: { task: task.taskId, code } });
      return done("outcome_unknown");
    }

    try {
      return await this.settle(task, attempt, packet, refToClaimId, envelope, done);
    } catch (error) {
      /* A fault in this engine after the answer came back. The answer is kept
         on the attempt; the task fails known; the tick goes on. */
      const current = await this.repo.getTask(task.taskId);
      if (current && current.state === "running") {
        try { await this.repo.completeAttempt(attempt.attemptId, envelope, [`engine: ${(error as Error).message}`], "failed_known"); } catch { /* already terminal */ }
        await this.repo.transitionTask(task.taskId, "failed_known", `engine_error: ${(error as Error).message}`);
        await this.repo.audit({ action: "core_v2.task.engine_error", entityType: "extraction_task", entityId: task.taskId, detail: { message: String((error as Error).message) } });
      }
      return done("failed_known");
    }
  }

  private async settle(
    task: TaskRecord, attempt: AttemptRecord, packet: WorkPacket, refToClaimId: Record<string, string>,
    envelope: AgentResultEnvelope,
    done: (state: string, extra?: Partial<{ childrenCreated: number; childrenReused: number; escalations: string[] }>) => { taskId: string; state: string; childrenCreated: number; childrenReused: number; escalations: string[] },
  ) {
    if (envelope.outcome === "outcome_unknown") {
      await this.repo.completeAttempt(attempt.attemptId, envelope, [], "outcome_unknown");
      await this.repo.transitionTask(task.taskId, "outcome_unknown", "provider_outcome_unknown");
      await this.repo.audit({ action: "core_v2.attempt.outcome_unknown", entityType: "agent_attempt", entityId: attempt.attemptId, detail: { task: task.taskId } });
      return done("outcome_unknown");
    }
    await this.repo.transitionAttempt(attempt.attemptId, "response_received");
    if (envelope.outcome === "failed_known") {
      await this.repo.completeAttempt(attempt.attemptId, envelope, [], "failed_known");
      await this.repo.transitionTask(task.taskId, "failed_known", envelope.limitations[0] ?? "failed_known");
      return done("failed_known");
    }

    /* The validator refuses; it does not throw. If an envelope is shaped so
       badly that it did, that is a refusal too, with the reason kept. */
    let validation;
    try { validation = validateEnvelope(packet, envelope); }
    catch (error) { validation = { ok: false, problems: [`the envelope could not be validated: ${(error as Error).message}`] }; }
    if (!validation.ok) {
      /* Kept, in full, as the attempt's raw result. Not evidence. */
      await this.repo.completeAttempt(attempt.attemptId, envelope, validation.problems, "failed_known");
      await this.repo.transitionTask(task.taskId, "failed_known", `invalid_envelope: ${validation.problems[0]}`);
      await this.repo.audit({ action: "core_v2.attempt.invalid_envelope", entityType: "agent_attempt", entityId: attempt.attemptId, detail: { task: task.taskId, problems: validation.problems } });
      return done("failed_known");
    }
    await this.repo.transitionAttempt(attempt.attemptId, "parsed");
    await this.repo.completeAttempt(attempt.attemptId, envelope, [], "succeeded");

    /* Persist what is valid. A reading that says it could not finish keeps
       its claims — compared, never accepted: the source was not fully read. */
    const claims = await this.repo.persistClaims(task, attempt.attemptId, envelope.claims, envelope.anchors, envelope.outcome === "insufficient_evidence");
    if (envelope.assessments.length) await this.repo.persistAssessments(task, attempt.attemptId, envelope.assessments, envelope.anchors, refToClaimId);
    const disagreements = envelope.disagreements.length
      ? await this.repo.persistDisagreements(task.workflowId, envelope.disagreements) : [];

    /* What this result makes necessary. */
    const followUp = { created: 0, reused: 0, escalations: [] as string[] };
    await this.afterCompletion(task, attempt, envelope, claims, disagreements, refToClaimId, followUp);

    const requests = envelope.requestedActions;
    const dispute = task.disagreementId ? await this.repo.getDisagreement(task.disagreementId) : null;
    if (requests.length && dispute && (dispute.state === "needs_human" || dispute.state === "resolved")) {
      await this.repo.audit({ action: "core_v2.follow_up.refused", entityType: "extraction_task", entityId: task.taskId, detail: { reason: `disagreement is ${dispute.state}; nothing more is asked by machine` } });
    } else if (requests.length) {
      const plan = await planFollowUps(task, requests, this.manifest, this.repo, this.policy);
      const { created, reused } = await this.createChildren(plan.children, task, followUp);
      for (const child of [...created, ...reused]) await this.rewireDependents(task, child.taskId, "requires_claims");
      for (const e of plan.escalations) followUp.escalations.push(`${task.taskId}: ${e.reason}`);
      for (const r of plan.refused) await this.repo.audit({ action: "core_v2.follow_up.refused", entityType: "extraction_task", entityId: task.taskId, detail: { action: r.request.actionType, reason: r.reason } });
      for (const e of plan.escalations) await this.repo.audit({ action: "core_v2.follow_up.escalated", entityType: "extraction_task", entityId: task.taskId, detail: { action: e.request.actionType, reason: e.reason } });
    }

    await this.repo.transitionTask(task.taskId, "completed", envelope.outcome === "insufficient_evidence" ? "insufficient_evidence" : null);
    return done("completed", { childrenCreated: followUp.created, childrenReused: followUp.reused, escalations: followUp.escalations });
  }

  /* Every child the engine makes — asked for by an agent or made necessary
     by a result — comes through here, where the workflow's ceiling holds. */
  private async createChildren(children: NewTask[], parent: TaskRecord, followUp: { created: number; reused: number; escalations: string[] }) {
    const existing = (await this.repo.listTasks(parent.workflowId)).length;
    const room = this.policy.maximumTasksPerWorkflow - existing;
    const admitted = children.slice(0, Math.max(0, room));
    const refused = children.slice(admitted.length);
    const result = await this.repo.createChildTasks(admitted);
    followUp.created += result.created.length; followUp.reused += result.reused.length;
    for (const r of refused) {
      followUp.escalations.push(`${parent.taskId}: ${r.taskType} refused — the workflow is at its ceiling of ${this.policy.maximumTasksPerWorkflow} tasks`);
      await this.repo.audit({ action: "core_v2.follow_up.escalated", entityType: "extraction_task", entityId: parent.taskId, detail: { reason: "workflow task ceiling", taskType: r.taskType } });
    }
    return { ...result, refused };
  }

  private async escalateDisputeOf(taskId: string, state: string): Promise<string[]> {
    const task = await this.repo.getTask(taskId);
    if (!task || !task.disagreementId) return [];
    const dis = await this.repo.getDisagreement(task.disagreementId);
    if (!dis || (dis.state !== "open" && dis.state !== "verifying")) return [];
    const followUp = { created: 0, reused: 0, escalations: [] as string[] };
    await this.escalate(dis, task, `${task.taskType} ended ${state}: ${task.terminalReason ?? "no reason recorded"}`, followUp);
    return followUp.escalations;
  }

  private async stopRequested(): Promise<boolean> {
    const workflow = await this.repo.getWorkflow(this.manifest.workflowId);
    return !workflow || workflow.cancelRequested;
  }

  private newAttempt(task: TaskRecord, attemptNo: number, family: string, configuration: string, inputFingerprint = task.inputFingerprint): AttemptRecord {
    return {
      attemptId: shortId("attempt", task.taskId, attemptNo), taskId: task.taskId, attemptNo,
      executorFamily: family, modelConfiguration: configuration, roleKey: task.roleKey, state: "prepared",
      inputFingerprint, independenceGroup: task.independenceGroup, rawEnvelope: null, validationErrors: [],
      errorCode: null, errorMessage: null,
    };
  }

  /* A dependent that has not started yet also waits for the new child. */
  private async rewireDependents(parent: TaskRecord, childTaskId: string, kind: "requires_claims" | "requires_resolution") {
    for (const d of await this.repo.getDependents(parent.taskId)) {
      const dependent = await this.repo.getTask(d.taskId);
      if (!dependent || !["created", "blocked", "queued"].includes(dependent.state)) continue;
      if (dependent.taskId === childTaskId) continue;
      await this.repo.addDependency(dependent.taskId, childTaskId, kind);
    }
  }

  /* ───────────────────────────────────────── what a result makes necessary */

  private async afterCompletion(
    task: TaskRecord, attempt: AttemptRecord, envelope: AgentResultEnvelope, claims: ClaimRecord[],
    disagreements: DisagreementRecord[], refToClaimId: Record<string, string>,
    followUp: { created: number; reused: number; escalations: string[] },
  ) {
    switch (task.taskType) {
      case "extract_dimensions": {
        /* Targeted verification: a single-read measurement that feeds a
           calculation gets one critic pass before anything is computed from
           it — unless it is already as deep as the policy allows. */
        if (task.independenceGroup === null && claims.length && task.depth < this.policy.maximumFollowUpDepth) {
          const child = this.childSpec(task, "verify_claim", shortId("subject", task.taskId), task.sourceIds.slice(0, 4), null, null, claims.map((c) => c.claimId));
          const { created, reused } = await this.createChildren([child], task, followUp);
          for (const c of [...created, ...reused]) await this.rewireDependents(task, c.taskId, "requires_claims");
        }
        return;
      }
      case "detect_disagreements":
        return this.afterComparison(task, envelope, disagreements, followUp);
      case "verify_claim":
        return this.afterCriticism(task, attempt, refToClaimId);
      case "verify_disagreement":
        return this.afterVerification(task, envelope, followUp);
      case "adjudicate":
        return this.afterAdjudication(task, attempt, envelope, refToClaimId, followUp);
      case "count_instances":
      case "derive_materials":
        for (const c of claims) await this.acceptByRule(task, c, `deterministic:${task.taskType}`, c.inputClaimIds);
        return;
      case "compose_decision":
        for (const d of envelope.decisions) {
          await this.repo.persistDecision({
            decisionId: shortId("decision", task.taskId, d.title), workflowId: task.workflowId, taskId: task.taskId,
            decisionType: d.decisionType, title: d.title, status: "proposed", authority: "adjudicator", rationale: d.summary.supportingEvidence,
            riskLevel: d.riskLevel,
            evidence: [
              ...d.supportingClaimIds.map((id) => ({ claimId: refToClaimId[id] ?? id, anchorId: null, link: "supports" as const })),
              ...d.contradictingClaimIds.map((id) => ({ claimId: refToClaimId[id] ?? id, anchorId: null, link: "contradicts" as const })),
            ],
            actions: d.actions, disagreementId: null, summary: d.summary,
          });
        }
        return;
      default:
        return;
    }
  }

  private childSpec(parent: TaskRecord, taskType: TaskRecord["taskType"], subjectKey: string, sourceIds: string[], independenceGroup: string | null, disagreementId: string | null, targetClaimIds: string[] = []): NewTask {
    return childOf(parent, taskType, subjectKey, sourceIds, independenceGroup, disagreementId, targetClaimIds, this.manifest, parent.depth + 1);
  }

  /* Agreement between blind readers makes a claim corroborated, and a
     deterministic rule then accepts one anchored representative — the anchor,
     not the agreement, is what admits it. Disagreement makes work. */
  private async afterComparison(task: TaskRecord, envelope: AgentResultEnvelope, disagreements: DisagreementRecord[], followUp: { created: number; reused: number; escalations: string[] }) {
    for (const group of envelope.calculations) {
      const members = (await Promise.all(group.inputClaimIds.map((id) => this.repo.getClaim(id)))).filter(Boolean) as ClaimRecord[];
      /* The representative is a complete reading with an anchor, in group
         order; a reading cut short corroborates, it is never what is accepted. */
      const sorted = members.sort((a, b) => Number(a.incompleteSourceAttempt) - Number(b.incompleteSourceAttempt)
        || (a.independenceGroup ?? "").localeCompare(b.independenceGroup ?? "") || a.claimId.localeCompare(b.claimId));
      const representative = sorted[0];
      if (!representative) continue;
      /* Agreement is between readers. One reader agreeing with itself is one
         reading, and it is neither corroborated nor accepted here. */
      if (new Set(members.map((m) => m.independenceGroup)).size < 2) continue;
      for (const member of sorted) if (member.status === "proposed") await this.repo.transitionClaim(member.claimId, "corroborated");
      if (representative.anchorIds.length === 0 || representative.incompleteSourceAttempt) continue;
      /* Two readers agreeing that a value could not be read is corroborated
         unreadability. It is not an accepted fact. */
      if (!representative.value.known) continue;
      await this.acceptByRule(task, representative, "corroborated_by_independent_anchored_readings", sorted.slice(1).map((c) => c.claimId));
    }

    const verifiable = disagreements.filter((d) => this.policy.verifySeverities.includes(d.severity) && d.state === "open")
      .sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || a.disagreementKey.localeCompare(b.disagreementKey));
    /* A subject whose readers differ everywhere is not forty verifier calls;
       it is a subject a person reads. The worst few are verified, the rest go
       to a person now. */
    const toVerify = verifiable.slice(0, this.policy.maximumVerifiedDisagreementsPerSubject);
    for (const dis of verifiable.slice(toVerify.length)) {
      await this.escalate(dis, task, `${verifiable.length} disagreements on one subject exceed the ${this.policy.maximumVerifiedDisagreementsPerSubject} the policy verifies`, followUp);
    }
    for (const dis of toVerify) {
      if (this.policy.escalateImmediatelyAtSeverity && dis.severity === this.policy.escalateImmediatelyAtSeverity) {
        await this.escalate(dis, task, "severity policy sends this straight to a person", followUp);
        continue;
      }
      const regions = [...new Set((await this.repo.listAnchors(dis.claimIds)).map((a) => a.regionId ?? a.pageId).filter(Boolean) as string[])];
      const verify = this.childSpec(task, "verify_disagreement", `${task.subjectKey}/${dis.disagreementKey.slice(-8)}/verify-1`, regions.slice(0, 6), null, dis.disagreementId);
      const adjudicate = this.childSpec(task, "adjudicate", `${task.subjectKey}/${dis.disagreementKey.slice(-8)}/adjudicate-1`, regions.slice(0, 8), null, dis.disagreementId);
      adjudicate.dependsOn = [{ taskId: verify.taskId, kind: "requires_completion" }];
      const { created, reused, refused } = await this.createChildren([verify, adjudicate], task, followUp);
      if (refused.length) { await this.escalate(dis, task, "the workflow is at its task ceiling", followUp); continue; }
      const adj = [...created, ...reused].find((t) => t.taskType === "adjudicate");
      if (adj) await this.rewireDependents(task, adj.taskId, "requires_resolution");
      await this.repo.transitionDisagreement(dis.disagreementId, "verifying");
    }
  }

  private async afterCriticism(task: TaskRecord, attempt: AttemptRecord, refToClaimId: Record<string, string>) {
    const assessments = (await this.repo.listAssessments(Object.values(refToClaimId))).filter((a) => a.attemptId === attempt.attemptId);
    for (const a of assessments) {
      const claim = await this.repo.getClaim(a.claimId);
      if (!claim || claim.status !== "proposed") continue;
      if (a.assessment === "supports" && claim.anchorIds.length) {
        await this.repo.transitionClaim(claim.claimId, "verified");
        /* A blind reading is never accepted on a critic's word alone: its
           comparison with the other blind reading decides. A single reading —
           a dimension nobody else read — is accepted on the critic's anchor. */
        if (claim.independenceGroup !== null) continue;
        await this.acceptByRule(task, { ...claim, status: "verified" }, "critic_supports_anchor", [], a.anchorIds);
      }
    }
  }

  private async afterVerification(task: TaskRecord, envelope: AgentResultEnvelope, followUp: { created: number; reused: number; escalations: string[] }) {
    if (!task.disagreementId) return;
    const dis = await this.repo.getDisagreement(task.disagreementId);
    if (!dis || dis.state === "needs_human" || dis.state === "resolved") return;
    const rounds = dis.criticRounds + 1;
    await this.repo.updateDisagreement(dis.disagreementId, { criticRounds: rounds });

    if (envelope.outcome === "insufficient_evidence") {
      if (rounds >= this.policy.maximumCriticRounds || envelope.requestedActions.length === 0) {
        envelope.requestedActions = [];
        await this.escalate({ ...dis, criticRounds: rounds }, task, rounds >= this.policy.maximumCriticRounds
          ? `${rounds} rounds of criticism could not read the source` : "the verifier could not read the source and asked for nothing", followUp);
        return;
      }
      /* The bounded follow-up: one more verification round, one level deeper.
         The pending arbiter waits for it. Consumed here, so the generic pass
         never plans them a second time — and never after an escalation. */
      const requests = envelope.requestedActions;
      envelope.requestedActions = [];
      const plan = await planFollowUps(task, requests, this.manifest, this.repo, this.policy);
      if (plan.escalations.length) {
        await this.escalate({ ...dis, criticRounds: rounds }, task, plan.escalations[0].reason, followUp);
        return;
      }
      const { created, reused } = await this.createChildren(plan.children.map((c) => ({ ...c, disagreementId: dis.disagreementId, criticRound: rounds })), task, followUp);
      const pendingArbiters = (await this.repo.listTasks(task.workflowId)).filter((t) => t.taskType === "adjudicate" && t.disagreementId === dis.disagreementId && !TERMINAL_TASK_STATES.includes(t.state));
      for (const child of [...created, ...reused]) for (const arb of pendingArbiters) await this.repo.addDependency(arb.taskId, child.taskId, "requires_completion");
    }
  }

  private async afterAdjudication(task: TaskRecord, attempt: AttemptRecord, envelope: AgentResultEnvelope, refToClaimId: Record<string, string>, followUp: { created: number; reused: number; escalations: string[] }) {
    const proposal = envelope.adjudication;
    if (!proposal || !task.disagreementId) return;
    const dis = await this.repo.getDisagreement(task.disagreementId);
    if (!dis || dis.state === "resolved" || dis.state === "needs_human") return;
    const rounds = dis.arbiterRounds + 1;
    await this.repo.updateDisagreement(dis.disagreementId, { arbiterRounds: rounds });
    const anchorsOf = proposal.evidenceAnchorIds;

    switch (proposal.outcome) {
      case "accept_claim": {
        const acceptedId = refToClaimId[proposal.acceptedClaimRef!];
        if (!acceptedId) return this.escalate(dis, task, "the arbiter accepted a claim the packet did not present", followUp);
        return this.resolveWith(task, dis, "accept_claim", proposal, acceptedId, anchorsOf, followUp);
      }
      case "correct": {
        const template = await this.repo.getClaim([...dis.claimIds].sort()[0]);
        if (!template || anchorsOf.length === 0) return this.escalate(dis, task, "a correction needs source anchors", followUp);
        /* The correction stands on anchors the packet showed: the disputed
           claims' own, or the verifier's evidence about them. None → a person.
           Each is re-keyed by its own id, so two readers' `row-3` stay two. */
        const assessmentIds = (await this.repo.listAssessments(dis.claimIds)).map((a) => a.assessmentId);
        const anchors = [...await this.repo.listAnchors(dis.claimIds), ...await this.repo.listAssessmentAnchors(assessmentIds)]
          .filter((a) => anchorsOf.includes(a.anchorId)).map((a) => ({ ...a, anchorKey: a.anchorId }));
        if (anchors.length === 0) return this.escalate(dis, task, "the correction rests on anchors the record does not hold", followUp);
        const [corrected] = await this.repo.persistClaims(task, attempt.attemptId, [{
          claimKey: "corrected", subjectType: template.subjectType, subjectKey: template.subjectKey, predicate: template.predicate,
          value: proposal.correctedValue!, unit: proposal.correctedUnit ?? template.unit, observationBasis: template.observationBasis,
          scope: template.scope, anchorKeys: anchors.map((a) => a.anchorKey), machineConfidence: null,
        }], anchors);
        return this.resolveWith(task, dis, "correct", proposal, corrected.claimId, anchorsOf, followUp);
      }
      case "reject_all":
        return this.resolveWith(task, dis, "reject_all", proposal, null, anchorsOf, followUp);
      case "needs_human":
        return this.escalate(dis, task, proposal.rationale, followUp);
      case "needs_more_evidence": {
        const request = proposal.followUp!;
        if (dis.followUpFingerprints.includes(request.idempotencyFingerprint)) {
          return this.escalate(dis, task, "the arbiter asked for the same evidence again — a person decides", followUp);
        }
        if (rounds >= this.policy.maximumArbiterRounds) return this.escalate(dis, task, `${rounds} rounds of arbitration asked for more evidence`, followUp);
        const plan = await planFollowUps(task, [request], this.manifest, this.repo, this.policy);
        if (plan.children.length === 0) {
          return this.escalate(dis, task, plan.escalations[0]?.reason ?? plan.refused[0]?.reason ?? "no follow-up could be made", followUp);
        }
        await this.repo.updateDisagreement(dis.disagreementId, { followUpFingerprints: [...dis.followUpFingerprints, request.idempotencyFingerprint] });
        const verify = { ...plan.children[0], disagreementId: dis.disagreementId, criticRound: dis.criticRounds };
        const again = this.childSpec(task, "adjudicate", `${dis.disagreementKey.slice(-8)}/adjudicate-${rounds + 1}`, task.sourceIds, null, dis.disagreementId);
        again.dependsOn = [{ taskId: verify.taskId, kind: "requires_completion" }];
        const { created, reused, refused } = await this.createChildren([verify, again], task, followUp);
        if (refused.length) return this.escalate(dis, task, "the workflow is at its task ceiling", followUp);
        const next = [...created, ...reused].find((t) => t.taskType === "adjudicate");
        if (next) await this.rewireDependents(task, next.taskId, "requires_resolution");
        envelope.requestedActions = [];
        return;
      }
    }
  }

  private async resolveWith(task: TaskRecord, dis: DisagreementRecord, type: "accept_claim" | "correct" | "reject_all", proposal: ProposedAdjudication, acceptedClaimId: string | null, anchorIds: string[], followUp: { created: number; reused: number; escalations: string[] }) {
    const decisionId = shortId("decision", task.taskId, type);
    const evidence: DecisionRecord["evidence"] = [];
    if (acceptedClaimId) {
      const accepted = await this.repo.getClaim(acceptedClaimId);
      if (!accepted || accepted.anchorIds.length === 0 || accepted.incompleteSourceAttempt) {
        return this.escalate(dis, task, "the arbiter accepted a reading that is unanchored or was cut short — a person decides", followUp);
      }
      await this.repo.transitionClaim(acceptedClaimId, "accepted");
      evidence.push({ claimId: acceptedClaimId, anchorId: null, link: "supports" });
    }
    for (const id of dis.claimIds) {
      if (id === acceptedClaimId) continue;
      const claim = await this.repo.getClaim(id);
      /* A reading that lost is rejected; one that had somehow been accepted
         before the dispute was settled is superseded by this decision. */
      if (claim && claim.status === "accepted") await this.repo.transitionClaim(id, "superseded");
      else if (claim && claim.status !== "rejected") await this.repo.transitionClaim(id, "rejected");
      evidence.push({ claimId: id, anchorId: null, link: "contradicts" });
    }
    for (const a of anchorIds) evidence.push({ claimId: null, anchorId: a, link: "context" });
    const decision = await this.repo.persistDecision({
      decisionId, workflowId: task.workflowId, taskId: task.taskId, decisionType: type === "correct" ? "accept_claim" : type,
      title: `${dis.subjectSignature.subject_key ?? dis.disagreementKey}: ${type.replace("_", " ")}`, status: "proposed", authority: "adjudicator",
      rationale: proposal.rationale, riskLevel: dis.severity === "critical" ? "high" : "normal", evidence, actions: [], disagreementId: dis.disagreementId, summary: null,
    });
    try {
      await this.repo.transitionDecision(decision.decisionId, "machine_decided");
    } catch (error) {
      return this.escalate(dis, task, `the proposed adjudication does not hold: ${(error as Error).message}`, followUp);
    }
    await this.repo.transitionDisagreement(dis.disagreementId, "resolved", decision.decisionId);
    await this.repo.audit({ action: "core_v2.disagreement.adjudicated", entityType: "disagreement", entityId: dis.disagreementId,
      detail: { outcome: type, decision: decision.decisionId, accepted: acceptedClaimId, kept: dis.claimIds } });
  }

  private async escalate(dis: DisagreementRecord, task: TaskRecord, reason: string, followUp: { created: number; reused: number; escalations: string[] }) {
    const current = await this.repo.getDisagreement(dis.disagreementId);
    if (!current || current.state === "needs_human" || current.state === "resolved") return;
    await this.repo.updateDisagreement(dis.disagreementId, { needsHumanReason: reason });
    await this.repo.transitionDisagreement(dis.disagreementId, "needs_human");
    for (const id of current.claimIds) {
      const c = await this.repo.getClaim(id);
      if (c && c.status === "disputed") await this.repo.transitionClaim(id, "unresolved");
    }
    const decision = await this.repo.persistDecision({
      decisionId: shortId("decision", dis.disagreementId, "needs_human"), workflowId: task.workflowId, taskId: task.taskId,
      decisionType: "hold", title: `${dis.subjectSignature.subject_key ?? dis.disagreementKey}: a person decides`, status: "proposed",
      authority: "adjudicator", rationale: reason, riskLevel: dis.severity === "critical" ? "high" : "normal",
      evidence: current.claimIds.map((id) => ({ claimId: id, anchorId: null, link: "context" as const })),
      actions: [{ actionType: "review", ownerRole: "reviewer" }], disagreementId: dis.disagreementId, summary: null,
    });
    if (decision.status === "proposed") await this.repo.transitionDecision(decision.decisionId, "needs_human");
    /* Nothing else on this dispute runs by machine: pending verifiers and
       arbiters are superseded by the person, and what depended on them waits. */
    for (const t of await this.repo.listTasks(task.workflowId)) {
      if (t.disagreementId === dis.disagreementId && t.taskId !== task.taskId && ["created", "blocked", "queued"].includes(t.state)) {
        if (t.state === "created") await this.repo.transitionTask(t.taskId, "blocked");
        await this.repo.transitionTask(t.taskId, "superseded", "needs_human");
      }
    }
    followUp.escalations.push(`${dis.subjectSignature.subject_key ?? dis.disagreementKey}: ${reason}`);
    await this.repo.audit({ action: "core_v2.disagreement.needs_human", entityType: "disagreement", entityId: dis.disagreementId, detail: { reason } });
  }

  /* Deterministic acceptance: a claim with an anchor, admitted by a written
     rule, recorded as a decision whose evidence is the claim. Never a majority. */
  private async acceptByRule(task: TaskRecord, claim: ClaimRecord, rule: string, corroboratingClaimIds: string[], anchorIds: string[] = []) {
    if (claim.anchorIds.length === 0) return;
    const current = await this.repo.getClaim(claim.claimId);
    if (!current || current.status === "accepted") return;
    if (current.status === "disputed" || current.status === "rejected" || current.status === "unresolved") return;
    if (current.incompleteSourceAttempt) return;
    /* A rule's evidence is claims the record holds. A named input that does
       not exist is not a rule firing; it is a result nobody can open. */
    for (const id of corroboratingClaimIds) {
      if (!(await this.repo.getClaim(id))) {
        await this.repo.audit({ action: "core_v2.claim.not_accepted", entityType: "evidence_claim", entityId: claim.claimId, detail: { rule, reason: `input ${id} is not in the record` } });
        return;
      }
    }
    await this.repo.transitionClaim(claim.claimId, "accepted");
    const decision = await this.repo.persistDecision({
      decisionId: shortId("decision", claim.claimId, rule), workflowId: task.workflowId, taskId: task.taskId, decisionType: "accept_claim",
      title: `${claim.subjectKey} ${claim.predicate}: accepted by rule`, status: "proposed", authority: "deterministic_rule", rationale: rule,
      riskLevel: "normal",
      evidence: [
        { claimId: claim.claimId, anchorId: null, link: "supports" },
        ...corroboratingClaimIds.map((id) => ({ claimId: id, anchorId: null, link: "context" as const })),
        ...anchorIds.map((id) => ({ claimId: null, anchorId: id, link: "context" as const })),
      ],
      actions: [], disagreementId: null, summary: null,
    });
    if (decision.status === "proposed") await this.repo.transitionDecision(decision.decisionId, "machine_decided");
  }

  private async refreshProgress() {
    const wf = this.manifest.workflowId;
    const tasks = await this.repo.listTasks(wf);
    const terminal = tasks.filter((t) => TERMINAL_TASK_STATES.includes(t.state)).length;
    const attention = tasks.filter((t) => t.state === "failed_known" || t.state === "outcome_unknown").length
      + (await this.repo.listDisagreements(wf)).filter((d) => d.state === "needs_human").length;
    await this.repo.updateWorkflow(wf, { totalUnits: tasks.length, completedUnits: terminal, attentionUnits: attention });
  }

  private async settleWorkflow() {
    const wf = this.manifest.workflowId;
    const workflow = (await this.repo.getWorkflow(wf))!;
    if (workflow.cancelRequested) return;
    const tasks = await this.repo.listTasks(wf);
    const anyCompleted = tasks.some((t) => t.state === "completed");
    const anyAttention = workflow.attentionUnits > 0;
    /* A workflow with a task still open — waiting on a person, or held by a
       worker somewhere else — is not completed, whatever else it did. */
    const anyOpen = tasks.some((t) => !TERMINAL_TASK_STATES.includes(t.state));
    await this.repo.updateWorkflow(wf, { state: !anyCompleted ? "failed" : anyAttention || anyOpen ? "partial" : "completed" });
  }
}

/* ───────────────────────────────────────────────────────── helpers */

function severityRank(severity: DisagreementRecord["severity"]): number {
  return severity === "critical" ? 0 : severity === "material" ? 1 : 2;
}

export class AttemptTimeout extends Error {}

/* An executor that never answers is an outcome nobody knows — the request may
   have reached a provider — and it is treated exactly like one that threw. */
export function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new AttemptTimeout(`no answer within ${ms} ms`)), ms);
    work.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

/* Whatever came back is given the envelope's shape before anything reads it.
   A non-envelope is a known failure with the raw value kept; a partial one is
   filled with empty arrays so a missing field is a validation problem rather
   than an exception that takes the whole tick down. */
export function normaliseEnvelope(raw: unknown): AgentResultEnvelope {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<AgentResultEnvelope> & { rawValue?: unknown };
  const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  const outcomes = ["completed", "needs_follow_up", "insufficient_evidence", "failed_known", "outcome_unknown"];
  const isEnvelope = raw && typeof raw === "object" && outcomes.includes(String(r.outcome));
  return {
    packetVersion: String(r.packetVersion ?? ""),
    taskId: String(r.taskId ?? ""),
    roleKey: String(r.roleKey ?? ""),
    roleVersion: String(r.roleVersion ?? ""),
    outcome: isEnvelope ? (r.outcome as AgentResultEnvelope["outcome"]) : "failed_known",
    claims: arr(r.claims), anchors: arr(r.anchors), assessments: arr(r.assessments), disagreements: arr(r.disagreements),
    requestedActions: arr(r.requestedActions),
    limitations: isEnvelope ? arr<string>(r.limitations) : [`the executor returned something that is not an envelope: ${JSON.stringify(raw)?.slice(0, 200) ?? String(raw)}`],
    rawResponseReference: typeof r.rawResponseReference === "string" ? r.rawResponseReference : null,
    adjudication: r.adjudication && typeof r.adjudication === "object" ? r.adjudication : null,
    decisions: arr(r.decisions), calculations: arr(r.calculations),
  };
}
