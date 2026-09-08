/* THE IN-MEMORY REPOSITORY: THE FAST TEST DOUBLE.
 *
 * It enforces the same state machines, guards and atomic operations as the
 * database, in one process, so that a run in a test and a run against
 * Postgres cannot disagree about what was legal. Atomicity here is the
 * atomicity of a single-threaded function: a commit that throws restores the
 * snapshot it took first, and nothing yields in between.
 *
 * It is a double. It is not the record, and the same contract tests run
 * against the Postgres adapter say whether the record agrees with it.
 */
import { randomUUID } from "node:crypto";
import type {
  AnchorRecord, AssessmentRecord, AttemptRecord, AttemptState, AuditRecord, ClaimRecord, ClaimStatus,
  DecisionRecord, DependencyKind, DependencyRecord, DisagreementRecord, DisagreementState, ReconciliationOutcome, SegmentRecord,
  SegmentStatus, SourceDescriptor, TaskRecord, TaskState, WorkflowRecord, WorkflowState,
} from "./contracts.ts";
import { ACTIVE_WORKFLOW_STATES } from "./contracts.ts";
import { canonical, sha256 } from "./ids.ts";
import { locatorInside, locatorProblem } from "./locators.ts";
import type {
  Admission, AdmissionLimits, ClaimFilter, CommitOutcome, DecisionApplication, DisagreementTransition, NewAnchor,
  HoldOutcome, NewClaim, NewSegment, NewTask, OrchestrationRepository, ResultCommit, SubjectHold, SubmitOutcome,
} from "./repository.ts";
import { taskPayload } from "./repository.ts";
import {
  IllegalTransition, SUBMITTED_ATTEMPT_STATES, StaleState, TERMINAL_ATTEMPT_STATES, TERMINAL_TASK_STATES,
  attemptMoveAllowed, claimMoveAllowed, decisionMoveAllowed, disagreementMoveAllowed, segmentMoveAllowed,
  taskMoveAllowed, workflowMoveAllowed,
} from "./transitions.ts";

const ZERO = "00000000-0000-0000-0000-000000000000";

type Outbox = { state: "pending" | "dispatching" | "acknowledged" | "failed"; dispatcher: string | null; attemptCount: number };

export class InMemoryOrchestrationRepository implements OrchestrationRepository {
  workflows = new Map<string, WorkflowRecord>();
  sources = new Map<string, SourceDescriptor[]>();
  outbox = new Map<string, Outbox>();
  segments = new Map<string, SegmentRecord>();
  tasks = new Map<string, TaskRecord>();
  dependencies: DependencyRecord[] = [];
  attempts = new Map<string, AttemptRecord>();
  claims = new Map<string, ClaimRecord>();
  anchors = new Map<string, AnchorRecord>();
  assessments = new Map<string, AssessmentRecord>();
  disagreements = new Map<string, DisagreementRecord>();
  decisions = new Map<string, DecisionRecord>();
  auditTrail: AuditRecord[] = [];

  /* ─────────────────────────────────────────────────────────── workflow */

  async createWorkflow(record: WorkflowRecord, sources: SourceDescriptor[]) {
    const existing = this.workflows.get(record.workflowId);
    if (existing) {
      const identity = (w: WorkflowRecord) => canonical({ o: w.organizationId, p: w.domainPack, v: w.domainPackVersion, t: w.workflowType, e: w.engineVersion, s: w.sourceSetFingerprint, r: w.requestFingerprint, q: w.requestedScope });
      if (identity(existing) !== identity(record)) throw new Error(`core-v2: workflow ${record.workflowId} already exists with a different intent`);
      return existing;
    }
    if (sources.length === 0) throw new Error("core-v2: a workflow names the sources it reads");
    for (const s of sources) if (!s.contentHash && !s.objectVersionId) throw new Error(`core-v2: source ${s.sourceId} has neither a content hash nor a version — it is not read`);
    this.workflows.set(record.workflowId, { ...record });
    this.sources.set(record.workflowId, sources.map((s) => ({ ...s })));
    this.outbox.set(record.workflowId, { state: "pending", dispatcher: null, attemptCount: 0 });
    return this.workflows.get(record.workflowId)!;
  }
  async getWorkflow(workflowId: string) { return this.workflows.get(workflowId) ?? null; }
  async transitionWorkflow(workflowId: string, from: WorkflowState, to: WorkflowState, patch: { errorCode?: string | null; errorMessage?: string | null } = {}) {
    const wf = this.workflows.get(workflowId);
    if (!wf) throw new Error(`core-v2: no workflow ${workflowId}`);
    if (wf.state !== from) throw new StaleState("workflow", workflowId, from, wf.state);
    if (!workflowMoveAllowed(from, to)) throw new IllegalTransition("workflow", from, to);
    const next = { ...wf, state: to, errorCode: patch.errorCode ?? wf.errorCode, errorMessage: patch.errorMessage ?? wf.errorMessage };
    this.workflows.set(workflowId, next);
    return next;
  }
  async updateWorkflowProgress(workflowId: string, progress: { totalUnits: number; completedUnits: number; attentionUnits: number }) {
    const wf = this.workflows.get(workflowId);
    if (!wf) throw new Error(`core-v2: no workflow ${workflowId}`);
    this.workflows.set(workflowId, { ...wf, ...progress });
  }
  async requestCancel(workflowId: string, at: number) {
    const wf = this.workflows.get(workflowId);
    if (!wf) throw new Error(`core-v2: no workflow ${workflowId}`);
    const next = { ...wf, cancelRequestedAt: wf.cancelRequestedAt ?? at };
    this.workflows.set(workflowId, next);
    return next;
  }
  async claimOutbox(workflowId: string, dispatcher: string) {
    const row = this.outbox.get(workflowId);
    const wf = this.workflows.get(workflowId);
    if (!row || !wf || row.state !== "pending") return false;
    if (wf.state !== "created") return false;
    this.outbox.set(workflowId, { state: "dispatching", dispatcher, attemptCount: row.attemptCount + 1 });
    await this.transitionWorkflow(workflowId, "created", "queued");
    return true;
  }
  async acknowledgeOutbox(workflowId: string) {
    const row = this.outbox.get(workflowId);
    if (!row) throw new Error(`core-v2: no start command for ${workflowId}`);
    if (row.state === "dispatching") this.outbox.set(workflowId, { ...row, state: "acknowledged" });
  }

  /* ─────────────────────────────────────────────── sources and segments */

  async listSources(workflowId: string) { return [...(this.sources.get(workflowId) ?? [])]; }
  async listSegments(workflowId: string, filter: { sourceId?: string; statuses?: SegmentStatus[] } = {}) {
    return [...this.segments.values()].filter((s) => s.workflowId === workflowId
      && (!filter.sourceId || s.sourceId === filter.sourceId) && (!filter.statuses || filter.statuses.includes(s.status)))
      .sort((a, b) => a.ordinal - b.ordinal || a.segmentId.localeCompare(b.segmentId));
  }
  async getSegment(segmentId: string) { return this.segments.get(segmentId) ?? null; }
  private segmentIdentity(s: NewSegment | SegmentRecord) {
    return canonical([s.workflowId, s.sourceId, s.parentSegmentId ?? ZERO, s.segmentKind, s.contentHash]);
  }
  async persistSegments(workflowId: string, segments: NewSegment[]) {
    const created: SegmentRecord[] = [];
    const reused: SegmentRecord[] = [];
    const byIdentity = new Map([...this.segments.values()].filter((s) => s.workflowId === workflowId).map((s) => [this.segmentIdentity(s), s] as const));
    const sources = new Set((this.sources.get(workflowId) ?? []).map((s) => s.sourceId));
    for (const s of segments) {
      if (s.workflowId !== workflowId) throw new Error("core-v2: a segment of another workflow");
      if (!sources.has(s.sourceId)) throw new Error(`core-v2: segment names source ${s.sourceId}, which this workflow does not read`);
      const problem = locatorProblem(s.locator);
      if (problem) throw new Error(`core-v2: segment ${s.label ?? s.segmentKind}: ${problem}`);
      if (s.parentSegmentId) {
        const parent = this.segments.get(s.parentSegmentId);
        if (!parent) throw new Error(`core-v2: segment names parent ${s.parentSegmentId}, which does not exist`);
        if (parent.sourceId !== s.sourceId || parent.workflowId !== workflowId) throw new Error("core-v2: a segment's parent belongs to another source");
        if (!locatorInside(s.locator, parent.locator)) throw new Error(`core-v2: segment ${s.label ?? s.segmentKind} lies outside its parent`);
      }
      const existing = byIdentity.get(this.segmentIdentity(s)) ?? this.segments.get(s.segmentId);
      if (existing) {
        const payload = (x: NewSegment | SegmentRecord) => canonical({ l: x.locator, o: x.ordinal, k: x.segmentKind, p: x.parentSegmentId, h: x.contentHash, src: x.sourceId });
        if (payload(existing) !== payload(s)) throw new Error(`core-v2: segment ${s.segmentId} already names different work`);
        reused.push(existing); continue;
      }
      const record: SegmentRecord = { ...s };
      this.segments.set(record.segmentId, record);
      byIdentity.set(this.segmentIdentity(record), record);
      created.push(record);
    }
    return { created, reused };
  }
  async transitionSegment(segmentId: string, from: SegmentStatus, to: SegmentStatus) {
    const s = this.segments.get(segmentId);
    if (!s) throw new Error(`core-v2: no segment ${segmentId}`);
    if (s.status !== from) throw new StaleState("segment", segmentId, from, s.status);
    if (!segmentMoveAllowed(from, to)) throw new IllegalTransition("segment", from, to);
    const next = { ...s, status: to };
    this.segments.set(segmentId, next);
    return next;
  }

  /* ──────────────────────────────────────────────────────────── tasks */

  private identityKey(t: NewTask | TaskRecord) {
    return canonical([t.workflowId, t.phase, t.taskType, t.subjectKey, t.inputFingerprint, t.contractVersion, t.independenceGroup ?? ""]);
  }

  async admitTasks(workflowId: string, tasks: NewTask[], limits: AdmissionLimits): Promise<Admission> {
    const created: TaskRecord[] = [];
    const reused: TaskRecord[] = [];
    const refused: { task: NewTask; reason: string }[] = [];
    const wf = this.workflows.get(workflowId);
    if (!wf) throw new Error(`core-v2: no workflow ${workflowId}`);
    const byIdentity = new Map([...this.tasks.values()].filter((t) => t.workflowId === workflowId).map((t) => [this.identityKey(t), t] as const));
    let total = [...this.tasks.values()].filter((t) => t.workflowId === workflowId).length;
    let edges = this.dependencies.filter((d) => this.tasks.get(d.taskId)?.workflowId === workflowId).length;
    const childrenOf = new Map<string, number>();
    for (const t of this.tasks.values()) if (t.workflowId === workflowId && t.parentTaskId) childrenOf.set(t.parentTaskId, (childrenOf.get(t.parentTaskId) ?? 0) + 1);
    const admittedIds = new Set<string>();

    for (const t of tasks) {
      if (t.workflowId !== workflowId) throw new Error("core-v2: a task of another workflow");
      const byId = this.tasks.get(t.taskId);
      const existing = byIdentity.get(this.identityKey(t)) ?? byId;
      if (existing) {
        if (canonical(taskPayload(existing)) !== canonical(taskPayload(t))) {
          throw new Error(`core-v2: task ${t.taskId} already names different work (${existing.inputFingerprint} vs ${t.inputFingerprint})`);
        }
        /* The same work, now with prerequisites it did not have: they are
           added while it has not started, and never after. */
        if (["created", "blocked", "queued"].includes(existing.state)) {
          for (const d of t.dependsOn) {
            if (d.taskId === existing.taskId || this.dependencies.some((x) => x.taskId === existing.taskId && x.dependsOnTaskId === d.taskId)) continue;
            if (!this.tasks.has(d.taskId) && !tasks.some((x) => x.taskId === d.taskId)) continue;
            if (edges >= limits.maximumEdges) { refused.push({ task: t, reason: `the workflow is at its ceiling of ${limits.maximumEdges} dependency edges` }); break; }
            this.dependencies.push({ taskId: existing.taskId, dependsOnTaskId: d.taskId, kind: d.kind });
            edges++;
            if (existing.state === "queued") this.tasks.set(existing.taskId, { ...existing, state: "blocked" });
          }
        }
        reused.push(this.tasks.get(existing.taskId)!); admittedIds.add(existing.taskId); continue;
      }
      if (t.depth > limits.maximumDepth) { refused.push({ task: t, reason: `depth ${t.depth} exceeds the limit of ${limits.maximumDepth}` }); continue; }
      if (total >= limits.maximumTasks) { refused.push({ task: t, reason: `the workflow is at its ceiling of ${limits.maximumTasks} tasks` }); continue; }
      if (t.parentTaskId && (childrenOf.get(t.parentTaskId) ?? 0) >= limits.maximumChildrenPerParent) { refused.push({ task: t, reason: `task ${t.parentTaskId} has used its ${limits.maximumChildrenPerParent} follow-ups` }); continue; }
      if (edges + t.dependsOn.length > limits.maximumEdges) { refused.push({ task: t, reason: `the workflow is at its ceiling of ${limits.maximumEdges} dependency edges` }); continue; }
      for (const d of t.dependsOn) {
        if (d.taskId === t.taskId) throw new Error("core-v2: a task cannot depend on itself");
        if (!this.tasks.has(d.taskId) && !tasks.some((x) => x.taskId === d.taskId)) throw new Error(`core-v2: task ${t.taskId} depends on ${d.taskId}, which does not exist`);
      }
      const { dependsOn, ...rest } = t;
      const record: TaskRecord = { ...rest, state: "created", leaseOwner: null, leaseToken: null, leaseExpiresAt: null, terminalReason: null };
      this.tasks.set(record.taskId, record);
      byIdentity.set(this.identityKey(record), record);
      for (const d of dependsOn) {
        if (!this.dependencies.some((x) => x.taskId === record.taskId && x.dependsOnTaskId === d.taskId)) {
          this.dependencies.push({ taskId: record.taskId, dependsOnTaskId: d.taskId, kind: d.kind });
          edges++;
        }
      }
      total++;
      if (record.parentTaskId) childrenOf.set(record.parentTaskId, (childrenOf.get(record.parentTaskId) ?? 0) + 1);
      created.push(record); admittedIds.add(record.taskId);
    }
    return { created, reused, refused };
  }
  async getTask(taskId: string) { return this.tasks.get(taskId) ?? null; }
  async listTasks(workflowId: string) { return [...this.tasks.values()].filter((t) => t.workflowId === workflowId); }
  async getRunnableTasks(workflowId: string) {
    return (await this.listTasks(workflowId)).filter((t) => t.state === "queued").sort((a, b) => a.priority - b.priority || a.taskId.localeCompare(b.taskId));
  }
  async getDependencies(taskId: string) { return this.dependencies.filter((d) => d.taskId === taskId); }
  async getDependents(taskId: string) { return this.dependencies.filter((d) => d.dependsOnTaskId === taskId); }
  async addDependency(taskId: string, dependsOnTaskId: string, kind: DependencyKind, limits: AdmissionLimits) {
    if (taskId === dependsOnTaskId) throw new Error("core-v2: a task cannot depend on itself");
    if (this.dependencies.some((d) => d.taskId === taskId && d.dependsOnTaskId === dependsOnTaskId)) return;
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`core-v2: no task ${taskId}`);
    if (!this.tasks.has(dependsOnTaskId)) throw new Error(`core-v2: no task ${dependsOnTaskId}`);
    if (!["created", "blocked", "queued"].includes(task.state)) throw new Error(`core-v2: task ${taskId} is ${task.state} — a dependency cannot be added to work already under way`);
    const edges = this.dependencies.filter((d) => this.tasks.get(d.taskId)?.workflowId === task.workflowId).length;
    if (edges >= limits.maximumEdges) throw new Error(`core-v2: the workflow is at its ceiling of ${limits.maximumEdges} dependency edges`);
    this.dependencies.push({ taskId, dependsOnTaskId, kind });
    if (task.state === "queued") this.tasks.set(taskId, { ...task, state: "blocked" });
  }
  private hasSubmittedAttempt(taskId: string) {
    return [...this.attempts.values()].some((a) => a.taskId === taskId && SUBMITTED_ATTEMPT_STATES.includes(a.state));
  }
  async transitionTask(taskId: string, from: TaskState, to: TaskState, reason: string | null = null) {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`core-v2: no task ${taskId}`);
    if (task.state !== from) throw new StaleState("task", taskId, from, task.state);
    if (!taskMoveAllowed(from, to)) throw new IllegalTransition("task", from, to);
    if ((from === "leased" && to === "queued") || to === "cancelled") {
      if (this.hasSubmittedAttempt(taskId)) throw new Error(`core-v2: task ${taskId} has an attempt that was already submitted — it is reconciled, not ${to === "cancelled" ? "cancelled" : "requeued"}`);
    }
    const keepLease = to === "leased" || to === "running";
    const next: TaskRecord = {
      ...task, state: to,
      terminalReason: TERMINAL_TASK_STATES.includes(to) ? (reason ?? task.terminalReason) : task.terminalReason,
      leaseOwner: keepLease ? task.leaseOwner : null, leaseToken: keepLease ? task.leaseToken : null, leaseExpiresAt: keepLease ? task.leaseExpiresAt : null,
    };
    this.tasks.set(taskId, next);
    return next;
  }
  /* One grant per lease, with a fencing token. Against Postgres this is one
     conditional update; here it is the same test on the record. */
  async leaseTask(taskId: string, owner: string, ttlMs: number, now: number) {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    if (task.state === "leased" && task.leaseExpiresAt !== null && task.leaseExpiresAt < now) {
      if (!(await this.reclaimExpiredLease(task))) return null;
    }
    const fresh = this.tasks.get(taskId)!;
    if (fresh.state !== "queued") return null;
    const leased: TaskRecord = { ...fresh, state: "leased", leaseOwner: owner, leaseToken: randomUUID(), leaseExpiresAt: now + ttlMs };
    this.tasks.set(taskId, leased);
    return leased;
  }
  private async reclaimExpiredLease(task: TaskRecord): Promise<boolean> {
    const latest = (await this.listAttempts(task.taskId)).at(-1);
    if (latest && SUBMITTED_ATTEMPT_STATES.includes(latest.state)) return false;
    if (latest && latest.state === "prepared") await this.transitionAttempt(latest.attemptId, "prepared", "cancelled_before_submission", { errorCode: "lease_expired_before_submission" });
    try { await this.transitionTask(task.taskId, "leased", "queued"); } catch { return false; }
    return true;
  }
  async heartbeatLease(taskId: string, leaseToken: string, ttlMs: number, now: number) {
    const task = this.tasks.get(taskId);
    if (!task || (task.state !== "leased" && task.state !== "running") || task.leaseToken !== leaseToken) return false;
    this.tasks.set(taskId, { ...task, leaseExpiresAt: now + ttlMs });
    return true;
  }
  async releaseDependents(workflowId: string) {
    const released: TaskRecord[] = [];
    const stopped: TaskRecord[] = [];
    for (const task of await this.listTasks(workflowId)) {
      if (task.state !== "created" && task.state !== "blocked") continue;
      const deps = await this.getDependencies(task.taskId);
      const upstream = deps.map((d) => this.tasks.get(d.dependsOnTaskId)).filter(Boolean) as TaskRecord[];
      const dead = upstream.find((u) => ["failed_known", "outcome_unknown", "cancelled"].includes(u.state));
      if (dead) { stopped.push(await this.transitionTask(task.taskId, task.state, "cancelled", `upstream_${dead.state}:${dead.taskId}`)); continue; }
      if (upstream.some((u) => u.state === "superseded")) {
        if (task.state === "created") await this.transitionTask(task.taskId, "created", "blocked");
        continue;
      }
      if (upstream.every((u) => u.state === "completed")) released.push(await this.transitionTask(task.taskId, task.state, "queued"));
      else if (task.state === "created") await this.transitionTask(task.taskId, "created", "blocked");
    }
    return { released, stopped };
  }
  async expireLeases(workflowId: string, now: number) {
    const touched: TaskRecord[] = [];
    for (const task of await this.listTasks(workflowId)) {
      if (task.leaseExpiresAt === null || task.leaseExpiresAt >= now) continue;
      if (task.state === "leased") {
        if (await this.reclaimExpiredLease(task)) touched.push(this.tasks.get(task.taskId)!);
        else { await this.transitionTask(task.taskId, "leased", "running"); touched.push(await this.transitionTask(task.taskId, "running", "outcome_unknown", "lease_expired_after_submission")); }
        continue;
      }
      if (task.state !== "running") continue;
      const latest = (await this.listAttempts(task.taskId)).at(-1);
      if (latest && SUBMITTED_ATTEMPT_STATES.includes(latest.state) && !TERMINAL_ATTEMPT_STATES.includes(latest.state)) {
        await this.transitionAttempt(latest.attemptId, latest.state, "outcome_unknown", { errorCode: "lease_expired_after_submission", errorMessage: "the worker holding this attempt did not come back" });
        touched.push(await this.transitionTask(task.taskId, "running", "outcome_unknown", "lease_expired_after_submission"));
      } else if (latest && latest.state === "prepared") {
        await this.transitionAttempt(latest.attemptId, "prepared", "cancelled_before_submission", { errorCode: "lease_expired_before_submission" });
        touched.push(await this.transitionTask(task.taskId, "running", "failed_known", "lease_expired_before_submission"));
      } else if (latest && latest.state === "outcome_unknown") {
        touched.push(await this.transitionTask(task.taskId, "running", "outcome_unknown", "lease_expired_after_submission"));
      } else if (latest) {
        touched.push(await this.transitionTask(task.taskId, "running", "failed_known", `lease_expired_after_attempt_${latest.state}`));
      } else {
        touched.push(await this.transitionTask(task.taskId, "running", "failed_known", "lease_expired_without_attempt"));
      }
    }
    return touched;
  }

  /* ─────────────────────────────────────────────────────────── attempts */

  async listAttempts(taskId: string) {
    return [...this.attempts.values()].filter((a) => a.taskId === taskId).sort((a, b) => a.attemptNo - b.attemptNo);
  }
  async getAttempt(attemptId: string) { return this.attempts.get(attemptId) ?? null; }
  async createAttempt(record: AttemptRecord) {
    if (this.attempts.has(record.attemptId)) throw new Error(`core-v2: attempt ${record.attemptId} already exists — it is not made twice`);
    const task = this.tasks.get(record.taskId);
    if (!task) throw new Error(`core-v2: no task ${record.taskId}`);
    if ((await this.listAttempts(record.taskId)).some((a) => a.attemptNo === record.attemptNo)) throw new Error(`core-v2: attempt ${record.attemptNo} of ${record.taskId} already exists`);
    if (!record.executorFamily || !record.independenceDomain) throw new Error("core-v2: an attempt names its executor family and independence domain");
    this.attempts.set(record.attemptId, { ...record, workflowId: task.workflowId });
    return this.attempts.get(record.attemptId)!;
  }
  async submitAttempt(attemptId: string, leaseToken: string, now: number): Promise<SubmitOutcome> {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) return { ok: false, reason: "no such attempt" };
    const task = this.tasks.get(attempt.taskId);
    const wf = task ? this.workflows.get(task.workflowId) : null;
    if (!task || !wf) return { ok: false, reason: "no such task" };
    if (!ACTIVE_WORKFLOW_STATES.includes(wf.state)) return { ok: false, reason: `workflow is ${wf.state}` };
    if (wf.cancelRequestedAt !== null) return { ok: false, reason: "cancellation was requested" };
    if (task.state !== "running") return { ok: false, reason: `task is ${task.state}` };
    if (task.leaseToken !== leaseToken) return { ok: false, reason: "the lease is not the caller's" };
    if (task.leaseExpiresAt === null || task.leaseExpiresAt <= now) return { ok: false, reason: "the lease has expired" };
    if (attempt.state !== "prepared") return { ok: false, reason: `attempt is ${attempt.state}` };
    /* A blind reading is not sent to a domain that already read the subject
       under another group — whatever the router believed when it chose. */
    if (task.independenceGroup) {
      const peers = new Set([...this.tasks.values()].filter((t) => t.workflowId === task.workflowId && t.subjectKey === task.subjectKey && t.independenceGroup !== null && t.independenceGroup !== task.independenceGroup).map((t) => t.taskId));
      const clash = [...this.attempts.values()].find((a) => peers.has(a.taskId) && SUBMITTED_ATTEMPT_STATES.includes(a.state) && a.independenceDomain === attempt.independenceDomain);
      if (clash) return { ok: false, reason: `independence: domain ${attempt.independenceDomain} already read ${task.subjectKey} as another group` };
    }
    const next = { ...attempt, state: "submitted" as AttemptState, leaseToken };
    this.attempts.set(attemptId, next);
    return { ok: true, attempt: next };
  }
  async transitionAttempt(attemptId: string, from: AttemptState, to: AttemptState, patch: { errorCode?: string | null; errorMessage?: string | null; usage?: Record<string, unknown> } = {}) {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) throw new Error(`core-v2: no attempt ${attemptId}`);
    if (attempt.state !== from) throw new StaleState("attempt", attemptId, from, attempt.state);
    if (!attemptMoveAllowed(from, to)) throw new IllegalTransition("attempt", from, to);
    if (attempt.errorCode !== null && patch.errorCode !== undefined && patch.errorCode !== attempt.errorCode) throw new Error("core-v2: an attempt's error is written once");
    if (Object.keys(attempt.usage).length && patch.usage && canonical(patch.usage) !== canonical(attempt.usage)) throw new Error("core-v2: the recorded usage of an attempt cannot be replaced");
    const next: AttemptRecord = { ...attempt, state: to, errorCode: patch.errorCode ?? attempt.errorCode, errorMessage: patch.errorMessage ?? attempt.errorMessage, usage: patch.usage ?? attempt.usage };
    this.attempts.set(attemptId, next);
    return next;
  }
  async recordReconciliation(attemptId: string, outcome: ReconciliationOutcome) {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) throw new Error(`core-v2: no attempt ${attemptId}`);
    if (attempt.state !== "outcome_unknown") throw new Error(`core-v2: attempt ${attemptId} is ${attempt.state}; only an unknown outcome is reconciled`);
    if (outcome === "unknown") return attempt;
    if (attempt.reconciliationOutcome !== null && attempt.reconciliationOutcome !== outcome) throw new Error("core-v2: an attempt's reconciliation is written once");
    const next = { ...attempt, reconciliationOutcome: outcome };
    this.attempts.set(attemptId, next);
    return next;
  }
  async independenceDomainsForSubject(workflowId: string, subjectKey: string) {
    const taskIds = new Set((await this.listTasks(workflowId)).filter((t) => t.subjectKey === subjectKey && t.independenceGroup !== null).map((t) => t.taskId));
    return [...new Set([...this.attempts.values()].filter((a) => taskIds.has(a.taskId) && SUBMITTED_ATTEMPT_STATES.includes(a.state)).map((a) => a.independenceDomain))];
  }

  /* Everything one answer makes true, or nothing. A second commit of the
     same attempt returns what the first wrote. */
  async commitValidatedResult(commit: ResultCommit): Promise<CommitOutcome> {
    const attempt = this.attempts.get(commit.attemptId);
    if (!attempt) throw new Error(`core-v2: no attempt ${commit.attemptId}`);
    if (TERMINAL_ATTEMPT_STATES.includes(attempt.state)) {
      return {
        alreadyCommitted: true,
        claims: [...this.claims.values()].filter((c) => c.attemptId === commit.attemptId),
        assessments: [...this.assessments.values()].filter((a) => a.attemptId === commit.attemptId),
        disagreements: commit.disagreements.map((d) => this.disagreements.get(d.disagreementId)).filter(Boolean) as DisagreementRecord[],
        segments: { created: [], reused: [...this.segments.values()].filter((s) => s.discoveredByAttemptId === commit.attemptId) },
        children: { created: [], reused: commit.children.map((c) => this.tasks.get(c.taskId)).filter(Boolean) as TaskRecord[], refused: [] },
        decisions: commit.decisions.map((d) => this.decisions.get(d.decision.decisionId)).filter(Boolean) as DecisionRecord[],
        followUpsRefused: [],
      };
    }
    const snapshot = this.snapshot();
    try {
      return await this.applyCommit(commit, attempt);
    } catch (error) {
      this.restore(snapshot);
      throw error;
    }
  }

  private async applyCommit(commit: ResultCommit, attempt: AttemptRecord): Promise<CommitOutcome> {
    const task = this.tasks.get(commit.taskId);
    if (!task || task.taskId !== attempt.taskId) throw new Error("core-v2: the commit names a task that is not the attempt's");
    if (task.state !== "running") throw new StaleState("task", task.taskId, "running", task.state);
    if (!SUBMITTED_ATTEMPT_STATES.includes(attempt.state)) throw new Error(`core-v2: attempt ${attempt.attemptId} is ${attempt.state} — only a submitted attempt has a result`);
    if (attempt.rawResult !== null && attempt.rawResult !== undefined && attempt.rawResultHash !== commit.attempt.rawResultHash) throw new Error("core-v2: a stored result is not replaced");

    /* The attempt: raw result once, then its states in order. */
    let current: AttemptRecord = { ...attempt, rawResult: commit.attempt.rawResult, rawResultHash: commit.attempt.rawResultHash,
      validationState: commit.attempt.validationState, validationProblems: commit.attempt.validationProblems };
    this.attempts.set(current.attemptId, current);
    const path: AttemptState[] = commit.attempt.to === "succeeded" ? ["response_received", "parsed", "succeeded"]
      : commit.attempt.to === "failed_known" ? (current.state === "submitted" ? ["response_received", "failed_known"] : ["failed_known"])
      : [commit.attempt.to];
    for (const to of path) {
      if (current.state === to) continue;
      current = await this.transitionAttempt(current.attemptId, current.state, to, to === commit.attempt.to ? { errorCode: commit.attempt.errorCode, errorMessage: commit.attempt.errorMessage } : {});
    }

    const segments = await this.persistSegments(commit.workflowId, commit.segments);
    const claims = this.writeClaims(commit.claims, commit.workflowId);
    const assessments = this.writeAssessments(commit.assessments, commit.workflowId);
    const disagreements = this.writeDisagreements(commit.disagreements, commit.workflowId);
    for (const t of commit.claimTransitions) await this.transitionClaim(t.claimId, t.from, t.to);
    for (const r of commit.disagreementRounds) {
      const d = this.disagreements.get(r.disagreementId);
      if (!d) throw new Error(`core-v2: no disagreement ${r.disagreementId}`);
      if ((r.criticRounds ?? d.criticRounds) < d.criticRounds || (r.arbiterRounds ?? d.arbiterRounds) < d.arbiterRounds) throw new Error("core-v2: rounds never decrease");
      this.disagreements.set(d.disagreementId, { ...d, criticRounds: r.criticRounds ?? d.criticRounds, arbiterRounds: r.arbiterRounds ?? d.arbiterRounds });
    }
    const decisions: DecisionRecord[] = [];
    for (const a of commit.decisions) decisions.push(await this.applyDecision(a));
    for (const t of commit.disagreementTransitions) await this.transitionDisagreement(t);
    const children = await this.admitTasks(commit.workflowId, commit.children, commit.limits);
    for (const d of commit.dependencies) {
      const dependent = this.tasks.get(d.taskId);
      if (!dependent || !["created", "blocked", "queued"].includes(dependent.state)) continue;
      if (!this.tasks.has(d.dependsOnTaskId)) continue;
      await this.addDependency(d.taskId, d.dependsOnTaskId, d.kind, commit.limits);
    }
    const followUpsRefused: { disagreementId: string; round: number; reason: string }[] = [];
    for (const f of commit.followUps) {
      const d = this.disagreements.get(f.disagreementId);
      if (!d) throw new Error(`core-v2: no disagreement ${f.disagreementId}`);
      if (d.followUps.some((x) => x.fingerprint === f.fingerprint)) { followUpsRefused.push({ disagreementId: f.disagreementId, round: f.round, reason: "the same follow-up was already admitted" }); continue; }
      if (d.followUps.some((x) => x.round === f.round)) { followUpsRefused.push({ disagreementId: f.disagreementId, round: f.round, reason: `round ${f.round} already has its one follow-up` }); continue; }
      this.disagreements.set(d.disagreementId, { ...d, followUps: [...d.followUps, { round: f.round, fingerprint: f.fingerprint, taskId: f.taskId }] });
    }
    for (const t of commit.taskTransitions) await this.transitionTask(t.taskId, t.from, t.to, t.reason);
    await this.transitionTask(task.taskId, "running", commit.task.to, commit.task.reason);
    for (const a of commit.audits) this.auditTrail.push(a);
    return { alreadyCommitted: false, claims, assessments, disagreements, segments, children, decisions, followUpsRefused };
  }

  private writeAnchors(anchors: NewAnchor[], workflowId: string, owner: { claimId: string | null; assessmentId: string | null }): string[] {
    const ids: string[] = [];
    for (const a of anchors) {
      if (this.anchors.has(a.anchorId)) throw new Error(`core-v2: anchor ${a.anchorId} already exists`);
      const problem = locatorProblem(a.locator);
      if (problem) throw new Error(`core-v2: anchor ${a.anchorId}: ${problem}`);
      let sourceId = a.sourceId;
      if (a.segmentId) {
        const segment = this.segments.get(a.segmentId);
        if (!segment) throw new Error(`core-v2: anchor names segment ${a.segmentId}, which does not exist`);
        if (segment.workflowId !== workflowId) throw new Error("core-v2: anchor names a segment of another workflow");
        if (sourceId && sourceId !== segment.sourceId) throw new Error("core-v2: anchor combines a segment of one source with another source's id");
        sourceId = segment.sourceId;
        if (!locatorInside(a.locator, segment.locator)) throw new Error("core-v2: anchor locator lies outside the segment it names");
      } else if (sourceId && !(this.sources.get(workflowId) ?? []).some((s) => s.sourceId === sourceId)) {
        throw new Error("core-v2: anchor names a source this workflow does not read");
      }
      const record: AnchorRecord = { ...a, sourceId, workflowId, claimId: owner.claimId, assessmentId: owner.assessmentId };
      this.anchors.set(record.anchorId, record);
      ids.push(record.anchorId);
    }
    return ids;
  }
  private writeClaims(claims: NewClaim[], workflowId: string): ClaimRecord[] {
    const out: ClaimRecord[] = [];
    for (const c of claims) {
      if (this.claims.has(c.claimId)) throw new Error(`core-v2: claim ${c.claimId} already exists`);
      for (const id of c.inputClaimIds) if (!this.claims.has(id)) throw new Error(`core-v2: claim names input ${id}, which does not exist`);
      const { anchors, ...rest } = c;
      const record: ClaimRecord = { ...rest, workflowId, anchorIds: [] };
      this.claims.set(record.claimId, record);
      record.anchorIds = this.writeAnchors(anchors, workflowId, { claimId: record.claimId, assessmentId: null });
      this.claims.set(record.claimId, { ...record });
      out.push(this.claims.get(record.claimId)!);
    }
    return out;
  }
  private writeAssessments(assessments: ResultCommit["assessments"], workflowId: string): AssessmentRecord[] {
    const out: AssessmentRecord[] = [];
    for (const a of assessments) {
      if (this.assessments.has(a.assessmentId)) throw new Error(`core-v2: assessment ${a.assessmentId} already exists`);
      if (!this.claims.has(a.claimId)) throw new Error(`core-v2: assessment names claim ${a.claimId}, which does not exist`);
      if ([...this.assessments.values()].some((x) => x.attemptId === a.attemptId && x.claimId === a.claimId)) throw new Error("core-v2: one verdict per claim per attempt");
      const { anchors, ...rest } = a;
      const record: AssessmentRecord = { ...rest, workflowId, anchorIds: [] };
      this.assessments.set(record.assessmentId, record);
      record.anchorIds = this.writeAnchors(anchors, workflowId, { claimId: null, assessmentId: record.assessmentId });
      this.assessments.set(record.assessmentId, { ...record });
      out.push(this.assessments.get(record.assessmentId)!);
    }
    return out;
  }
  private writeDisagreements(disagreements: ResultCommit["disagreements"], workflowId: string): DisagreementRecord[] {
    const out: DisagreementRecord[] = [];
    for (const d of disagreements) {
      const existing = [...this.disagreements.values()].find((e) => e.workflowId === workflowId && e.disagreementKey === d.disagreementKey);
      if (existing) { out.push(existing); continue; }
      for (const claimId of d.claimIds) {
        const claim = this.claims.get(claimId);
        if (!claim) throw new Error(`core-v2: disagreement names claim ${claimId}, which does not exist`);
        if (claim.workflowId !== workflowId) throw new Error("core-v2: disagreement compares a claim of another workflow");
      }
      const record: DisagreementRecord = { ...d, workflowId, state: "open", resolutionDecisionId: null, criticRounds: 0, arbiterRounds: 0, followUps: [], needsHumanReason: null };
      this.disagreements.set(record.disagreementId, record);
      for (const claimId of d.claimIds) {
        const claim = this.claims.get(claimId)!;
        if (claimMoveAllowed(claim.status, "disputed")) this.claims.set(claimId, { ...claim, status: "disputed" });
      }
      out.push(record);
    }
    return out;
  }

  /* ─────────────────────────────────────────────────────────── evidence */

  async listClaims(filter: ClaimFilter) {
    return [...this.claims.values()].filter((c) =>
      (!filter.workflowId || c.workflowId === filter.workflowId) &&
      (!filter.taskIds || (c.taskId !== null && filter.taskIds.includes(c.taskId))) &&
      (!filter.attemptIds || (c.attemptId !== null && filter.attemptIds.includes(c.attemptId))) &&
      (!filter.subjectKey || c.subjectKey === filter.subjectKey) &&
      (!filter.subjectKeyPrefix || c.subjectKey.startsWith(filter.subjectKeyPrefix)) &&
      (!filter.statuses || filter.statuses.includes(c.status)) &&
      (!filter.subjectTypes || filter.subjectTypes.includes(c.subjectType)));
  }
  async getClaim(claimId: string) { return this.claims.get(claimId) ?? null; }
  async transitionClaim(claimId: string, from: ClaimStatus, to: ClaimStatus) {
    const claim = this.claims.get(claimId);
    if (!claim) throw new Error(`core-v2: no claim ${claimId}`);
    if (claim.status !== from) throw new StaleState("claim", claimId, from, claim.status);
    if (!claimMoveAllowed(from, to)) throw new IllegalTransition("claim", from, to);
    if ((to === "accepted" || to === "verified") && claim.anchorIds.length === 0) throw new Error(`core-v2: claim ${claimId} has nothing to open — it is not ${to}`);
    if (to === "accepted" && claim.incompleteSourceAttempt) throw new Error(`core-v2: claim ${claimId} came from a cut-short attempt`);
    if (to === "superseded") {
      const standing = [...this.decisions.values()].find((d) => ["machine_decided", "human_decided"].includes(d.status) && d.evidence.some((e) => e.link === "supports" && e.claimId === claimId));
      if (standing) throw new Error(`core-v2: claim ${claimId} is under standing decision ${standing.decisionId} — supersede the decision in the same breath`);
    }
    const next = { ...claim, status: to };
    this.claims.set(claimId, next);
    return next;
  }
  async listAnchors(claimIds: string[]) {
    return [...this.anchors.values()].filter((a) => a.claimId !== null && claimIds.includes(a.claimId));
  }
  async listAssessmentAnchors(assessmentIds: string[]) {
    return [...this.anchors.values()].filter((a) => a.assessmentId !== null && assessmentIds.includes(a.assessmentId));
  }
  async listAssessments(claimIds: string[]) {
    return [...this.assessments.values()].filter((a) => claimIds.includes(a.claimId));
  }

  /* ──────────────────────────────────────────────────────── disagreements */

  async getDisagreement(disagreementId: string) { return this.disagreements.get(disagreementId) ?? null; }
  async listDisagreements(workflowId: string) { return [...this.disagreements.values()].filter((d) => d.workflowId === workflowId); }
  async transitionDisagreement(t: DisagreementTransition) {
    const d = this.disagreements.get(t.disagreementId);
    if (!d) throw new Error(`core-v2: no disagreement ${t.disagreementId}`);
    if (d.state !== t.from) throw new StaleState("disagreement", t.disagreementId, t.from, d.state);
    if (!disagreementMoveAllowed(t.from, t.to)) throw new IllegalTransition("disagreement", t.from, t.to);
    const resolution = t.resolutionDecisionId ?? d.resolutionDecisionId;
    if (t.to === "resolved" && !resolution) throw new Error("core-v2: a resolved disagreement names the decision that resolved it");
    if (t.to === "resolved" && !this.decisions.has(resolution!)) throw new Error("core-v2: a resolved disagreement names a decision that exists");
    const next = { ...d, state: t.to, resolutionDecisionId: resolution, needsHumanReason: t.needsHumanReason ?? d.needsHumanReason };
    this.disagreements.set(d.disagreementId, next);
    return next;
  }

  async holdSubject(hold: SubjectHold): Promise<HoldOutcome> {
    const existing = [...this.disagreements.values()].find((d) => d.workflowId === hold.workflowId && d.disagreementKey === hold.disagreement.disagreementKey);
    if (existing) return { alreadyHeld: true, disagreement: existing, decision: this.decisions.get(hold.decision.decision.decisionId) ?? null };
    const snapshot = this.snapshot();
    try {
      this.writeDisagreements([hold.disagreement], hold.workflowId);
      const decision = await this.applyDecision(hold.decision);
      const disagreement = await this.transitionDisagreement(hold.transition);
      for (const a of hold.audits) this.auditTrail.push(a);
      return { alreadyHeld: false, disagreement, decision };
    } catch (error) {
      this.restore(snapshot);
      throw error;
    }
  }

  /* ──────────────────────────────────────────────────────────── decisions */

  async applyDecision(application: DecisionApplication) {
    const { decision, decideTo } = application;
    if (this.decisions.has(decision.decisionId)) {
      const existing = this.decisions.get(decision.decisionId)!;
      if (canonical({ ...existing, status: null }) !== canonical({ ...decision, status: null })) throw new Error(`core-v2: decision ${decision.decisionId} already exists with different content`);
      return existing;
    }
    if (decision.status !== "proposed") throw new Error("core-v2: a decision is written proposed and then decided");
    for (const e of decision.evidence) {
      if (e.claimId && !this.claims.has(e.claimId)) throw new Error(`core-v2: decision cites claim ${e.claimId}, which does not exist`);
      if (e.anchorId && !this.anchors.has(e.anchorId)) throw new Error(`core-v2: decision cites anchor ${e.anchorId}, which does not exist`);
      if (e.claimId && e.anchorId && this.anchors.get(e.anchorId)!.claimId !== e.claimId) throw new Error("core-v2: that anchor belongs to another claim — a decision cites a claim through its own source");
    }
    if (decision.disagreementId && !this.disagreements.has(decision.disagreementId)) throw new Error("core-v2: decision settles a disagreement that does not exist");
    let record: DecisionRecord = { ...decision };
    this.decisions.set(record.decisionId, record);
    if (decideTo) {
      if (!decisionMoveAllowed("proposed", decideTo)) throw new IllegalTransition("decision", "proposed", decideTo);
      if (decideTo === "machine_decided") {
        if (!record.decidedByAttemptId || !this.attempts.has(record.decidedByAttemptId)) throw new Error(`core-v2: decision ${record.decisionId} is machine decided by no attempt`);
        this.assertDecisionRests(record);
      }
      record = { ...record, status: decideTo };
      this.decisions.set(record.decisionId, record);
    }
    return record;
  }
  private assertDecisionRests(d: DecisionRecord) {
    if (d.decisionType === "supersede") return;
    if (d.decisionType === "reject_all") {
      const dis = d.disagreementId ? this.disagreements.get(d.disagreementId) : null;
      if (!dis) throw new Error(`core-v2: decision ${d.decisionId} rejects everything but settles no disagreement`);
      const contradicted = new Set(d.evidence.filter((e) => e.link === "contradicts" && e.claimId).map((e) => e.claimId));
      if (dis.claimIds.some((id) => !contradicted.has(id))) throw new Error(`core-v2: decision ${d.decisionId} rejects ${dis.claimIds.length} claims but names fewer of them`);
      if (!d.evidence.some((e) => e.link === "context" && e.anchorId && this.anchors.has(e.anchorId))) throw new Error("core-v2: rejecting every reading needs source evidence the record holds");
      return;
    }
    const accepted = d.evidence.some((e) => e.link === "supports" && e.claimId && this.claims.get(e.claimId)?.status === "accepted");
    if (!accepted) throw new Error(`core-v2: decision ${d.decisionId} rests on no accepted claim`);
  }
  async listDecisions(workflowId: string) { return [...this.decisions.values()].filter((d) => d.workflowId === workflowId); }
  async getDecision(decisionId: string) { return this.decisions.get(decisionId) ?? null; }

  async audit(record: AuditRecord) { this.auditTrail.push(record); }
  async listAudit() { return [...this.auditTrail]; }

  /* ───────────────────────────────────────────────────────── snapshots */

  snapshot() {
    return JSON.parse(JSON.stringify({
      workflows: [...this.workflows.values()], sources: [...this.sources.entries()], outbox: [...this.outbox.entries()],
      segments: [...this.segments.values()], tasks: [...this.tasks.values()], dependencies: this.dependencies,
      attempts: [...this.attempts.values()], claims: [...this.claims.values()], anchors: [...this.anchors.values()],
      assessments: [...this.assessments.values()], disagreements: [...this.disagreements.values()],
      decisions: [...this.decisions.values()], audit: this.auditTrail,
    })) as Snapshot;
  }
  restore(snapshot: Snapshot) {
    const s = JSON.parse(JSON.stringify(snapshot)) as Snapshot;
    this.workflows = new Map(s.workflows.map((w) => [w.workflowId, w]));
    this.sources = new Map(s.sources);
    this.outbox = new Map(s.outbox);
    this.segments = new Map(s.segments.map((x) => [x.segmentId, x]));
    this.tasks = new Map(s.tasks.map((t) => [t.taskId, t]));
    this.dependencies = s.dependencies;
    this.attempts = new Map(s.attempts.map((a) => [a.attemptId, a]));
    this.claims = new Map(s.claims.map((c) => [c.claimId, c]));
    this.anchors = new Map(s.anchors.map((a) => [a.anchorId, a]));
    this.assessments = new Map(s.assessments.map((a) => [a.assessmentId, a]));
    this.disagreements = new Map(s.disagreements.map((d) => [d.disagreementId, d]));
    this.decisions = new Map(s.decisions.map((d) => [d.decisionId, d]));
    this.auditTrail = s.audit;
  }
  static fromSnapshot(snapshot: Snapshot) {
    const repo = new InMemoryOrchestrationRepository();
    repo.restore(snapshot);
    return repo;
  }
}

export type Snapshot = {
  workflows: WorkflowRecord[]; sources: [string, SourceDescriptor[]][]; outbox: [string, Outbox][];
  segments: SegmentRecord[]; tasks: TaskRecord[]; dependencies: DependencyRecord[]; attempts: AttemptRecord[];
  claims: ClaimRecord[]; anchors: AnchorRecord[]; assessments: AssessmentRecord[]; disagreements: DisagreementRecord[];
  decisions: DecisionRecord[]; audit: AuditRecord[];
};

export function hashOf(value: unknown): string { return sha256(canonical(value)); }
