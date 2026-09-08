/* WHERE THE ENGINE WRITES, AND THE IN-MEMORY VERSION THE TESTS RUN ON.
 *
 * The scheduler talks to a repository interface and nothing else. A Temporal
 * activity layer, or a Supabase adapter, implements this interface later; the
 * orchestration logic does not change when it does. The mapping to the Core V2
 * tables of migration 058 is one-to-one:
 *
 *   workflow      → intelligence_workflows       attempt   → agent_attempts
 *   task          → extraction_tasks             claim     → evidence_claims
 *   dependency    → task_dependencies            anchor    → evidence_anchors
 *   assessment    → claim_assessments (+ claim_assessment_anchors)
 *   disagreement  → disagreements (+ disagreement_claims)
 *   decision      → decisions (+ decision_evidence, decision_actions)
 *
 * No table of agents, messages or conversations exists here or anywhere: the
 * orchestration state IS the task, attempt and claim records. The in-memory
 * repository enforces the same state machines the database does, so a run in a
 * test and a run against Postgres cannot disagree about what was legal.
 */
import type {
  AgentResultEnvelope, AnchorRecord, AssessmentRecord, AttemptRecord, AttemptState, AuditRecord,
  ClaimRecord, ClaimStatus, DecisionRecord, DecisionStatus, DependencyKind, DependencyRecord,
  DisagreementRecord, DisagreementState, ProposedAnchor, ProposedAssessment, ProposedClaim,
  ProposedDisagreement, TaskRecord, TaskState, WorkflowRecord,
} from "./contracts.ts";
import { fingerprint, shortId } from "./hash.ts";
import {
  IllegalTransition, SUBMITTED_ATTEMPT_STATES, TERMINAL_ATTEMPT_STATES, TERMINAL_TASK_STATES, attemptMoveAllowed,
  claimMoveAllowed, decisionMoveAllowed, disagreementMoveAllowed, taskMoveAllowed,
} from "./transitions.ts";

export type NewTask = Omit<TaskRecord, "state" | "leaseOwner" | "leaseExpiresAt" | "terminalReason"> & {
  dependsOn: { taskId: string; kind: DependencyKind }[];
};

export type ClaimFilter = {
  workflowId?: string;
  taskIds?: string[];
  subjectKey?: string;
  subjectKeyPrefix?: string;
  statuses?: ClaimStatus[];
  subjectTypes?: string[];
};

export interface OrchestrationRepository {
  /* workflow */
  getWorkflow(workflowId: string): Promise<WorkflowRecord | null>;
  createWorkflow(record: WorkflowRecord): Promise<void>;
  updateWorkflow(workflowId: string, patch: Partial<WorkflowRecord>): Promise<void>;

  /* tasks */
  planTasks(tasks: NewTask[]): Promise<{ created: string[]; existing: string[] }>;
  getTask(taskId: string): Promise<TaskRecord | null>;
  listTasks(workflowId: string): Promise<TaskRecord[]>;
  getRunnableTasks(workflowId: string): Promise<TaskRecord[]>;
  getDependencies(taskId: string): Promise<DependencyRecord[]>;
  getDependents(taskId: string): Promise<DependencyRecord[]>;
  addDependency(taskId: string, dependsOnTaskId: string, kind: DependencyKind): Promise<void>;
  transitionTask(taskId: string, to: TaskState, reason?: string | null): Promise<TaskRecord>;
  /* Grants a lease on a queued task, or on a leased task whose lease expired
     before anything was submitted. A live lease is never granted again — not
     to another owner, and not to the same owner name asked twice: two workers
     that share a name are two workers. Returns null when nothing was granted. */
  leaseTask(taskId: string, owner: string, ttlMs: number, now: number): Promise<TaskRecord | null>;
  createChildTasks(tasks: NewTask[]): Promise<{ created: TaskRecord[]; reused: TaskRecord[] }>;
  releaseDependents(workflowId: string): Promise<{ released: TaskRecord[]; stopped: TaskRecord[] }>;
  /* Reconciles every lease that expired: a leased task goes back to the queue,
     a running one ends — outcome_unknown if its attempt was submitted, failed
     known otherwise. Returns every task it touched, in its new state. */
  expireLeases(workflowId: string, now: number): Promise<TaskRecord[]>;
  updateTask(taskId: string, patch: Partial<Pick<TaskRecord, "criticRound" | "arbiterRound" | "disagreementId">>): Promise<void>;

  /* attempts */
  listAttempts(taskId: string): Promise<AttemptRecord[]>;
  createAttempt(record: AttemptRecord): Promise<AttemptRecord>;
  transitionAttempt(attemptId: string, to: AttemptState, patch?: Partial<AttemptRecord>): Promise<AttemptRecord>;
  completeAttempt(attemptId: string, envelope: AgentResultEnvelope, validationErrors: string[], to: AttemptState): Promise<AttemptRecord>;
  executorFamiliesForSubject(workflowId: string, subjectKey: string): Promise<string[]>;

  /* evidence */
  /* `incomplete` marks every claim as the product of a reading that said it
     could not finish; such a claim is kept, compared, and never accepted. */
  persistClaims(task: TaskRecord, attemptId: string, claims: ProposedClaim[], anchors: ProposedAnchor[], incomplete?: boolean): Promise<ClaimRecord[]>;
  listClaims(filter: ClaimFilter): Promise<ClaimRecord[]>;
  getClaim(claimId: string): Promise<ClaimRecord | null>;
  transitionClaim(claimId: string, to: ClaimStatus): Promise<ClaimRecord>;
  listAnchors(claimIds: string[]): Promise<AnchorRecord[]>;
  listAssessmentAnchors(assessmentIds: string[]): Promise<AnchorRecord[]>;
  persistAssessments(task: TaskRecord, attemptId: string, assessments: ProposedAssessment[], anchors: ProposedAnchor[], refToClaimId: Record<string, string>): Promise<AssessmentRecord[]>;
  listAssessments(claimIds: string[]): Promise<AssessmentRecord[]>;

  /* disagreements */
  persistDisagreements(workflowId: string, disagreements: ProposedDisagreement[]): Promise<DisagreementRecord[]>;
  getDisagreement(disagreementId: string): Promise<DisagreementRecord | null>;
  listDisagreements(workflowId: string): Promise<DisagreementRecord[]>;
  updateDisagreement(disagreementId: string, patch: Partial<DisagreementRecord>): Promise<void>;
  transitionDisagreement(disagreementId: string, to: DisagreementState, resolutionDecisionId?: string | null): Promise<DisagreementRecord>;

  /* decisions */
  persistDecision(record: DecisionRecord): Promise<DecisionRecord>;
  listDecisions(workflowId: string): Promise<DecisionRecord[]>;
  transitionDecision(decisionId: string, to: DecisionStatus): Promise<DecisionRecord>;

  /* audit */
  audit(record: AuditRecord): Promise<void>;
  listAudit(): Promise<AuditRecord[]>;
}

/* ───────────────────────────────────────────────────────── in memory */

export class InMemoryOrchestrationRepository implements OrchestrationRepository {
  workflows = new Map<string, WorkflowRecord>();
  tasks = new Map<string, TaskRecord>();
  dependencies: DependencyRecord[] = [];
  attempts = new Map<string, AttemptRecord>();
  claims = new Map<string, ClaimRecord>();
  anchors = new Map<string, AnchorRecord>();
  assessments = new Map<string, AssessmentRecord>();
  disagreements = new Map<string, DisagreementRecord>();
  decisions = new Map<string, DecisionRecord>();
  auditTrail: AuditRecord[] = [];

  async getWorkflow(workflowId: string) { return this.workflows.get(workflowId) ?? null; }
  async createWorkflow(record: WorkflowRecord) {
    if (this.workflows.has(record.workflowId)) return;
    this.workflows.set(record.workflowId, { ...record });
  }
  async updateWorkflow(workflowId: string, patch: Partial<WorkflowRecord>) {
    const wf = this.workflows.get(workflowId);
    if (!wf) throw new Error(`core-v2: no workflow ${workflowId}`);
    this.workflows.set(workflowId, { ...wf, ...patch });
  }

  async planTasks(tasks: NewTask[]) {
    const created: string[] = [];
    const existing: string[] = [];
    for (const t of tasks) {
      if (this.tasks.has(t.taskId)) { existing.push(t.taskId); continue; }
      const { dependsOn, ...rest } = t;
      this.tasks.set(t.taskId, { ...rest, state: "created", leaseOwner: null, leaseExpiresAt: null, terminalReason: null });
      for (const d of dependsOn) this.dependencies.push({ taskId: t.taskId, dependsOnTaskId: d.taskId, kind: d.kind });
      created.push(t.taskId);
    }
    return { created, existing };
  }
  async getTask(taskId: string) { return this.tasks.get(taskId) ?? null; }
  async listTasks(workflowId: string) {
    return [...this.tasks.values()].filter((t) => t.workflowId === workflowId);
  }
  async getRunnableTasks(workflowId: string) {
    return (await this.listTasks(workflowId)).filter((t) => t.state === "queued").sort((a, b) => a.priority - b.priority || a.taskId.localeCompare(b.taskId));
  }
  async getDependencies(taskId: string) { return this.dependencies.filter((d) => d.taskId === taskId); }
  async getDependents(taskId: string) { return this.dependencies.filter((d) => d.dependsOnTaskId === taskId); }
  async addDependency(taskId: string, dependsOnTaskId: string, kind: DependencyKind) {
    if (taskId === dependsOnTaskId) throw new Error("core-v2: a task cannot depend on itself");
    if (this.dependencies.some((d) => d.taskId === taskId && d.dependsOnTaskId === dependsOnTaskId)) return;
    const task = this.tasks.get(taskId);
    if (task && !["created", "blocked", "queued"].includes(task.state)) {
      throw new Error(`core-v2: task ${taskId} is ${task.state} — a dependency cannot be added to work already under way`);
    }
    this.dependencies.push({ taskId, dependsOnTaskId, kind });
    if (task && task.state === "queued") this.tasks.set(taskId, { ...task, state: "blocked" });
  }

  async transitionTask(taskId: string, to: TaskState, reason: string | null = null) {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`core-v2: no task ${taskId}`);
    if (task.state === to) return task;
    if (!taskMoveAllowed(task.state, to)) throw new IllegalTransition("task", task.state, to);
    /* The two refusals the database makes that the table alone cannot express. */
    if ((task.state === "leased" && to === "queued") || to === "cancelled") {
      const sent = (await this.listAttempts(taskId)).some((a) => SUBMITTED_ATTEMPT_STATES.includes(a.state));
      if (sent) throw new Error(`core-v2: task ${taskId} has an attempt that was already submitted — it is reconciled, not ${to === "cancelled" ? "cancelled" : "requeued"}`);
    }
    const next: TaskRecord = {
      ...task, state: to,
      terminalReason: TERMINAL_TASK_STATES.includes(to) ? (reason ?? task.terminalReason) : task.terminalReason,
      leaseOwner: to === "leased" || to === "running" ? task.leaseOwner : null,
      leaseExpiresAt: to === "leased" || to === "running" ? task.leaseExpiresAt : null,
    };
    this.tasks.set(taskId, next);
    return next;
  }

  /* One grant per lease. Against Postgres this is one conditional update —
     `where state = 'queued' or (state = 'leased' and lease_expires_at < now())`
     — and the row that comes back is the grant; here it is the same test on
     the in-memory record. */
  async leaseTask(taskId: string, owner: string, ttlMs: number, now: number) {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    if (task.state === "leased" && task.leaseExpiresAt !== null && task.leaseExpiresAt < now) {
      /* Expired before anything ran. The prepared attempt a dead worker left is
         closed, and the task goes back to the queue — unless something was
         submitted after all, in which case the guard refuses and so do we. */
      const reclaimed = await this.reclaimExpiredLease(task);
      if (!reclaimed) return null;
    }
    const fresh = this.tasks.get(taskId)!;
    if (fresh.state !== "queued") return null;
    const leased: TaskRecord = { ...fresh, state: "leased", leaseOwner: owner, leaseExpiresAt: now + ttlMs };
    this.tasks.set(taskId, leased);
    return leased;
  }

  private async reclaimExpiredLease(task: TaskRecord): Promise<boolean> {
    const latest = (await this.listAttempts(task.taskId)).at(-1);
    if (latest && SUBMITTED_ATTEMPT_STATES.includes(latest.state)) return false;
    if (latest && latest.state === "prepared") {
      await this.transitionAttempt(latest.attemptId, "cancelled_before_submission", { errorCode: "lease_expired_before_submission" });
    }
    try { await this.transitionTask(task.taskId, "queued"); } catch { return false; }
    return true;
  }

  async createChildTasks(tasks: NewTask[]) {
    const created: TaskRecord[] = [];
    const reused: TaskRecord[] = [];
    for (const t of tasks) {
      const existing = [...this.tasks.values()].find((e) => e.inputFingerprint === t.inputFingerprint && e.workflowId === t.workflowId);
      if (existing) { reused.push(existing); continue; }
      const collision = this.tasks.get(t.taskId);
      if (collision) throw new Error(`core-v2: task id ${t.taskId} already names different work (${collision.inputFingerprint} vs ${t.inputFingerprint})`);
      await this.planTasks([t]);
      created.push(this.tasks.get(t.taskId)!);
    }
    return { created, reused };
  }

  /* Tasks a dead worker left behind. A lease that expired while still `leased`
     goes back to the queue, its prepared attempt closed. One that expired
     while `running` had an attempt in flight: if that attempt was never
     submitted it is cancelled and the task fails known; if it was, nobody
     knows what the provider did, and the task ends outcome_unknown — never
     requeued; if it had already ended — an answer came back and the worker
     died before the record was complete — the task fails known, and what the
     attempt stored is there to be looked at. */
  async expireLeases(workflowId: string, now: number): Promise<TaskRecord[]> {
    const touched: TaskRecord[] = [];
    for (const task of await this.listTasks(workflowId)) {
      if (task.leaseExpiresAt === null || task.leaseExpiresAt >= now) continue;
      if (task.state === "leased") {
        if (await this.reclaimExpiredLease(task)) touched.push(this.tasks.get(task.taskId)!);
        else touched.push(await this.transitionTask(task.taskId, "running").then(() => this.transitionTask(task.taskId, "outcome_unknown", "lease_expired_after_submission")));
        continue;
      }
      if (task.state !== "running") continue;
      const latest = (await this.listAttempts(task.taskId)).at(-1);
      if (latest && SUBMITTED_ATTEMPT_STATES.includes(latest.state) && !TERMINAL_ATTEMPT_STATES.includes(latest.state)) {
        await this.transitionAttempt(latest.attemptId, "outcome_unknown", { errorCode: "lease_expired_after_submission", errorMessage: "the worker holding this attempt did not come back" });
        touched.push(await this.transitionTask(task.taskId, "outcome_unknown", "lease_expired_after_submission"));
      } else if (latest && latest.state === "prepared") {
        await this.transitionAttempt(latest.attemptId, "cancelled_before_submission", { errorCode: "lease_expired_before_submission" });
        touched.push(await this.transitionTask(task.taskId, "failed_known", "lease_expired_before_submission"));
      } else if (latest && latest.state === "outcome_unknown") {
        touched.push(await this.transitionTask(task.taskId, "outcome_unknown", "lease_expired_after_submission"));
      } else if (latest) {
        touched.push(await this.transitionTask(task.taskId, "failed_known", `lease_expired_after_attempt_${latest.state}`));
      } else {
        touched.push(await this.transitionTask(task.taskId, "failed_known", "lease_expired_without_attempt"));
      }
    }
    return touched;
  }

  /* A created or blocked task whose every dependency completed becomes queued.
     One whose dependency failed, ended unknown, or was cancelled is stopped:
     the branch does not continue on evidence that never arrived. One whose
     dependency was superseded — a machine adjudication set aside for a person
     — stays blocked: the branch waits, and the workflow ends partial. */
  async releaseDependents(workflowId: string) {
    const released: TaskRecord[] = [];
    const stopped: TaskRecord[] = [];
    for (const task of await this.listTasks(workflowId)) {
      if (task.state !== "created" && task.state !== "blocked") continue;
      const deps = await this.getDependencies(task.taskId);
      const upstream = deps.map((d) => this.tasks.get(d.dependsOnTaskId)).filter(Boolean) as TaskRecord[];
      const dead = upstream.find((u) => ["failed_known", "outcome_unknown", "cancelled"].includes(u.state));
      if (dead) {
        stopped.push(await this.transitionTask(task.taskId, "cancelled", `upstream_${dead.state}:${dead.taskId}`));
        continue;
      }
      if (upstream.some((u) => u.state === "superseded")) {
        if (task.state === "created") await this.transitionTask(task.taskId, "blocked");
        continue;
      }
      if (upstream.every((u) => u.state === "completed")) {
        released.push(await this.transitionTask(task.taskId, "queued"));
      } else if (task.state === "created") {
        await this.transitionTask(task.taskId, "blocked");
      }
    }
    return { released, stopped };
  }
  async updateTask(taskId: string, patch: Partial<Pick<TaskRecord, "criticRound" | "arbiterRound" | "disagreementId">>) {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`core-v2: no task ${taskId}`);
    this.tasks.set(taskId, { ...task, ...patch });
  }

  async listAttempts(taskId: string) {
    return [...this.attempts.values()].filter((a) => a.taskId === taskId).sort((a, b) => a.attemptNo - b.attemptNo);
  }
  /* An attempt is made once. A second creation under the same id or number is
     a second worker about to pay for the same work, and it is refused. */
  async createAttempt(record: AttemptRecord) {
    if (this.attempts.has(record.attemptId)) throw new Error(`core-v2: attempt ${record.attemptId} already exists — it is not made twice`);
    const existing = await this.listAttempts(record.taskId);
    if (existing.some((a) => a.attemptNo === record.attemptNo)) throw new Error(`core-v2: attempt ${record.attemptNo} of ${record.taskId} already exists`);
    this.attempts.set(record.attemptId, { ...record });
    return record;
  }
  async transitionAttempt(attemptId: string, to: AttemptState, patch: Partial<AttemptRecord> = {}) {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) throw new Error(`core-v2: no attempt ${attemptId}`);
    if (attempt.state !== to && !attemptMoveAllowed(attempt.state, to)) throw new IllegalTransition("attempt", attempt.state, to);
    if (attempt.rawEnvelope !== null && patch.rawEnvelope === null) throw new Error("core-v2: a stored response is not dropped");
    const next = { ...attempt, ...patch, state: to };
    this.attempts.set(attemptId, next);
    return next;
  }
  async completeAttempt(attemptId: string, envelope: AgentResultEnvelope, validationErrors: string[], to: AttemptState) {
    return this.transitionAttempt(attemptId, to, { rawEnvelope: envelope, validationErrors });
  }
  async executorFamiliesForSubject(workflowId: string, subjectKey: string) {
    const taskIds = new Set((await this.listTasks(workflowId)).filter((t) => t.subjectKey === subjectKey).map((t) => t.taskId));
    return [...new Set([...this.attempts.values()].filter((a) => taskIds.has(a.taskId)).map((a) => a.executorFamily))];
  }

  async persistClaims(task: TaskRecord, attemptId: string, claims: ProposedClaim[], anchors: ProposedAnchor[], incomplete = false) {
    const out: ClaimRecord[] = [];
    for (const c of claims) {
      const claimId = shortId("claim", task.workflowId, task.taskId, attemptId, c.claimKey);
      const anchorIds: string[] = [];
      for (const key of [...new Set(c.anchorKeys)]) {
        const a = anchors.find((x) => x.anchorKey === key);
        if (!a) throw new Error(`core-v2: claim ${c.claimKey} names anchor ${key}, which was not supplied`);
        const anchorId = shortId("anchor", claimId, key);
        const anchorHash = fingerprint({ sourceKind: a.sourceKind, documentId: a.documentId, pageId: a.pageId, regionId: a.regionId, bbox: a.bbox, quotedText: a.quotedText, locator: a.locator });
        this.anchors.set(anchorId, { ...a, anchorId, claimId, anchorHash, assessmentId: null });
        anchorIds.push(anchorId);
      }
      const record: ClaimRecord = {
        claimId, workflowId: task.workflowId, taskId: task.taskId, attemptId,
        independenceGroup: task.independenceGroup, subjectType: c.subjectType, subjectKey: c.subjectKey,
        predicate: c.predicate, value: c.value, unit: c.unit, observationBasis: c.observationBasis,
        scope: c.scope ?? {}, status: "proposed", machineConfidence: c.machineConfidence,
        anchorIds, inputClaimIds: c.inputClaimIds ?? [], incompleteSourceAttempt: incomplete,
      };
      this.claims.set(claimId, record);
      out.push(record);
    }
    return out;
  }
  async listClaims(filter: ClaimFilter) {
    return [...this.claims.values()].filter((c) =>
      (!filter.workflowId || c.workflowId === filter.workflowId) &&
      (!filter.taskIds || filter.taskIds.includes(c.taskId)) &&
      (!filter.subjectKey || c.subjectKey === filter.subjectKey) &&
      (!filter.subjectKeyPrefix || c.subjectKey.startsWith(filter.subjectKeyPrefix)) &&
      (!filter.statuses || filter.statuses.includes(c.status)) &&
      (!filter.subjectTypes || filter.subjectTypes.includes(c.subjectType)));
  }
  async getClaim(claimId: string) { return this.claims.get(claimId) ?? null; }
  async transitionClaim(claimId: string, to: ClaimStatus) {
    const claim = this.claims.get(claimId);
    if (!claim) throw new Error(`core-v2: no claim ${claimId}`);
    if (claim.status === to) return claim;
    if (!claimMoveAllowed(claim.status, to)) throw new IllegalTransition("claim", claim.status, to);
    if ((to === "accepted" || to === "verified") && claim.anchorIds.length === 0) {
      throw new Error(`core-v2: claim ${claimId} has nothing to open — it is not ${to}`);
    }
    if (to === "accepted" && claim.incompleteSourceAttempt) throw new Error(`core-v2: claim ${claimId} came from a cut-short attempt`);
    const next = { ...claim, status: to };
    this.claims.set(claimId, next);
    return next;
  }
  /* A claim's own anchors — what its reader pointed at. A critic's evidence
     about the claim is kept apart, under the assessment. */
  async listAnchors(claimIds: string[]) {
    return [...this.anchors.values()].filter((a) => claimIds.includes(a.claimId) && a.assessmentId === null);
  }
  async listAssessmentAnchors(assessmentIds: string[]) {
    return [...this.anchors.values()].filter((a) => a.assessmentId !== null && assessmentIds.includes(a.assessmentId));
  }
  async persistAssessments(task: TaskRecord, attemptId: string, assessments: ProposedAssessment[], anchors: ProposedAnchor[], refToClaimId: Record<string, string>) {
    const out: AssessmentRecord[] = [];
    for (const a of assessments) {
      const claimId = refToClaimId[a.claimRef];
      if (!claimId) throw new Error(`core-v2: assessment names ${a.claimRef}, which is not a claim of this packet`);
      const assessmentId = shortId("assess", attemptId, a.claimRef);
      const anchorIds: string[] = [];
      for (const key of a.anchorKeys) {
        const anchor = anchors.find((x) => x.anchorKey === key);
        if (!anchor) throw new Error(`core-v2: assessment cites anchor ${key}, which was not supplied`);
        const anchorId = shortId("anchor", assessmentId, key);
        const anchorHash = fingerprint({ sourceKind: anchor.sourceKind, documentId: anchor.documentId, pageId: anchor.pageId, regionId: anchor.regionId, bbox: anchor.bbox, quotedText: anchor.quotedText });
        this.anchors.set(anchorId, { ...anchor, anchorId, claimId, anchorHash, assessmentId });
        anchorIds.push(anchorId);
      }
      const record: AssessmentRecord = { assessmentId, claimId, attemptId, taskId: task.taskId, assessment: a.assessment, reasonCode: a.reasonCode, explanation: a.explanation, anchorIds };
      this.assessments.set(assessmentId, record);
      out.push(record);
    }
    return out;
  }
  async listAssessments(claimIds: string[]) {
    return [...this.assessments.values()].filter((a) => claimIds.includes(a.claimId));
  }

  async persistDisagreements(workflowId: string, disagreements: ProposedDisagreement[]) {
    const out: DisagreementRecord[] = [];
    for (const d of disagreements) {
      const existing = [...this.disagreements.values()].find((e) => e.workflowId === workflowId && e.disagreementKey === d.disagreementKey);
      if (existing) { out.push(existing); continue; }
      for (const claimId of d.claimIds) {
        const claim = this.claims.get(claimId);
        if (!claim) throw new Error(`core-v2: disagreement names claim ${claimId}, which does not exist`);
        if (claim.workflowId !== workflowId) throw new Error(`core-v2: disagreement compares a claim of another reading`);
      }
      const record: DisagreementRecord = {
        disagreementId: shortId("dis", workflowId, d.disagreementKey), workflowId, disagreementKey: d.disagreementKey,
        kind: d.kind, severity: d.severity, subjectSignature: d.subjectSignature, claimIds: [...d.claimIds],
        state: "open", resolutionDecisionId: null, criticRounds: 0, arbiterRounds: 0, followUpFingerprints: [], needsHumanReason: null,
      };
      this.disagreements.set(record.disagreementId, record);
      for (const claimId of d.claimIds) {
        const claim = this.claims.get(claimId)!;
        if (claimMoveAllowed(claim.status, "disputed")) this.claims.set(claimId, { ...claim, status: "disputed" });
      }
      out.push(record);
    }
    return out;
  }
  async getDisagreement(disagreementId: string) { return this.disagreements.get(disagreementId) ?? null; }
  async listDisagreements(workflowId: string) {
    return [...this.disagreements.values()].filter((d) => d.workflowId === workflowId);
  }
  async updateDisagreement(disagreementId: string, patch: Partial<DisagreementRecord>) {
    const d = this.disagreements.get(disagreementId);
    if (!d) throw new Error(`core-v2: no disagreement ${disagreementId}`);
    if (patch.claimIds && d.state === "resolved") throw new Error("core-v2: the claims of a resolved disagreement cannot be changed");
    this.disagreements.set(disagreementId, { ...d, ...patch });
  }
  async transitionDisagreement(disagreementId: string, to: DisagreementState, resolutionDecisionId: string | null = null) {
    const d = this.disagreements.get(disagreementId);
    if (!d) throw new Error(`core-v2: no disagreement ${disagreementId}`);
    if (d.state === to) return d;
    if (!disagreementMoveAllowed(d.state, to)) throw new IllegalTransition("disagreement", d.state, to);
    if (to === "resolved" && !(resolutionDecisionId ?? d.resolutionDecisionId)) throw new Error("core-v2: a resolved disagreement names the decision that resolved it");
    const next = { ...d, state: to, resolutionDecisionId: resolutionDecisionId ?? d.resolutionDecisionId };
    this.disagreements.set(disagreementId, next);
    return next;
  }

  async persistDecision(record: DecisionRecord) {
    if (this.decisions.has(record.decisionId)) return this.decisions.get(record.decisionId)!;
    this.decisions.set(record.decisionId, { ...record });
    return record;
  }
  async listDecisions(workflowId: string) {
    return [...this.decisions.values()].filter((d) => d.workflowId === workflowId);
  }
  async transitionDecision(decisionId: string, to: DecisionStatus) {
    const d = this.decisions.get(decisionId);
    if (!d) throw new Error(`core-v2: no decision ${decisionId}`);
    if (d.status === to) return d;
    if (!decisionMoveAllowed(d.status, to)) throw new IllegalTransition("decision", d.status, to);
    if (to === "machine_decided" || to === "human_decided") {
      const supports = d.evidence.filter((e) => e.link === "supports" && e.claimId);
      const accepted = supports.some((e) => this.claims.get(e.claimId!)?.status === "accepted");
      if (d.decisionType === "reject_all") {
        if (!d.evidence.some((e) => e.link === "context" && e.anchorId && this.anchors.has(e.anchorId))) throw new Error("core-v2: rejecting every reading needs source evidence the record holds");
      } else if (d.decisionType !== "supersede" && !accepted) {
        throw new Error(`core-v2: decision ${decisionId} rests on no accepted claim`);
      }
    }
    const next = { ...d, status: to };
    this.decisions.set(decisionId, next);
    return next;
  }

  async audit(record: AuditRecord) { this.auditTrail.push(record); }
  async listAudit() { return [...this.auditTrail]; }

  /* A snapshot for restart tests: everything, by value. */
  snapshot() {
    return JSON.parse(JSON.stringify({
      workflows: [...this.workflows.values()], tasks: [...this.tasks.values()], dependencies: this.dependencies,
      attempts: [...this.attempts.values()], claims: [...this.claims.values()], anchors: [...this.anchors.values()],
      assessments: [...this.assessments.values()], disagreements: [...this.disagreements.values()],
      decisions: [...this.decisions.values()], audit: this.auditTrail,
    }));
  }
  /* By value again: two repositories restored from one snapshot share nothing. */
  static fromSnapshot(snapshot: ReturnType<InMemoryOrchestrationRepository["snapshot"]>) {
    const s = JSON.parse(JSON.stringify(snapshot)) as typeof snapshot;
    const repo = new InMemoryOrchestrationRepository();
    for (const w of s.workflows) repo.workflows.set(w.workflowId, w);
    for (const t of s.tasks) repo.tasks.set(t.taskId, t);
    repo.dependencies = s.dependencies;
    for (const a of s.attempts) repo.attempts.set(a.attemptId, a);
    for (const c of s.claims) repo.claims.set(c.claimId, c);
    for (const a of s.anchors) repo.anchors.set(a.anchorId, a);
    for (const a of s.assessments) repo.assessments.set(a.assessmentId, a);
    for (const d of s.disagreements) repo.disagreements.set(d.disagreementId, d);
    for (const d of s.decisions) repo.decisions.set(d.decisionId, d);
    repo.auditTrail = s.audit;
    return repo;
  }
}
