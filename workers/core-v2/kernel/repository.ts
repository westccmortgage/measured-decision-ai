/* WHERE THE KERNEL WRITES, AND WHAT EVERY IMPLEMENTATION MUST PROMISE.
 *
 * The scheduler talks to this interface and nothing else. The in-memory
 * repository is the fast test double; the Postgres adapter is the record.
 * Both pass the same contract tests, because the contract is built from
 * operations that are atomic on their own:
 *
 *   · a lease is granted once, with a fencing token, and heartbeated under it;
 *   · every transition is compare-and-set on the state the caller believes;
 *   · submission checks the workflow, the lease and cancellation together;
 *   · admission inserts-or-reuses by identity, compares the payload, and
 *     enforces the workflow's budgets in one operation;
 *   · a result and everything it makes necessary are committed together, and
 *     committing the same attempt twice returns what the first commit wrote;
 *   · a decision, its evidence and the transitions it entails are one write.
 *
 * The mapping to the tables of migration 058 is one-to-one; there is no
 * table of agents, messages or conversations here or anywhere.
 */
import type {
  AnchorRecord, AssessmentRecord, AttemptRecord, AttemptState, AuditRecord, ClaimRecord, ClaimStatus,
  DecisionRecord, DecisionStatus, DependencyKind, DependencyRecord, DisagreementRecord, DisagreementState, ProviderFacts, ReconciliationOutcome,
  SegmentRecord, SegmentStatus, SourceDescriptor, TaskRecord, TaskState, ValidationState, WorkflowRecord, WorkflowState,
} from "./contracts.ts";

export type NewTask = Omit<TaskRecord, "state" | "leaseOwner" | "leaseToken" | "leaseExpiresAt" | "terminalReason"> & {
  dependsOn: { taskId: string; kind: DependencyKind }[];
};

export type NewSegment = Omit<SegmentRecord, "status"> & { status: SegmentStatus };

export type NewAnchor = Omit<AnchorRecord, "workflowId" | "claimId" | "assessmentId">;

export type NewClaim = Omit<ClaimRecord, "anchorIds" | "status"> & { status: ClaimStatus; anchors: NewAnchor[] };

export type NewAssessment = Omit<AssessmentRecord, "anchorIds"> & { anchors: NewAnchor[] };

export type NewDisagreement = Pick<DisagreementRecord, "disagreementId" | "workflowId" | "disagreementKey" | "kind" | "severity" | "subjectSignature" | "claimIds">;

export type ClaimTransition = { claimId: string; from: ClaimStatus; to: ClaimStatus };

export type DisagreementTransition = {
  disagreementId: string;
  from: DisagreementState;
  to: DisagreementState;
  resolutionDecisionId?: string | null;
  needsHumanReason?: string | null;
};

export type TaskTransition = { taskId: string; from: TaskState; to: TaskState; reason: string | null };

/* A decision written proposed and, when `decideTo` says so, moved in the same
   write — validated against the claims as they stand after the commit's
   claim transitions. */
export type DecisionApplication = {
  decision: DecisionRecord;
  decideTo: Extract<DecisionStatus, "machine_decided" | "needs_human"> | null;
};

export type AdmissionLimits = {
  maximumTasks: number;
  maximumEdges: number;
  maximumChildrenPerParent: number;
  maximumDepth: number;
};

export type Admission = {
  created: TaskRecord[];
  reused: TaskRecord[];
  refused: { task: NewTask; reason: string }[];
};

export type ClaimFilter = {
  workflowId?: string;
  taskIds?: string[];
  attemptIds?: string[];
  subjectKey?: string;
  subjectKeyPrefix?: string;
  statuses?: ClaimStatus[];
  subjectTypes?: string[];
};

export type SubmitOutcome = { ok: true; attempt: AttemptRecord } | { ok: false; reason: string };

/* SOMETHING THAT MUST HAPPEN WITH THE SUBMISSION, OR NOT AT ALL.
 *
 * The kernel does not know that answering costs anything, and it must not
 * learn: an engine that priced its readers would be a client of whoever it
 * priced. But something outside the kernel does — and that something has to
 * write its row in the SAME unit of work as the move from prepared to
 * submitted, or there is a window in which one exists without the other. A
 * hold taken and then not spent is money a run cannot use; a request sent
 * with no hold is money nobody counted. A crash lands in that window, and so
 * does every refusal the submission itself makes.
 *
 * So the move takes a rider. It is handed the record's own unit of work —
 * whatever that is; null for a record that has none — and it is run after
 * every submission rule has passed and before the attempt moves. Its refusal
 * is the submission's refusal, and whatever it wrote goes with the rest of
 * the unit of work when the submission does not happen.
 *
 * What is in it is not the kernel's business. That it is atomic with the
 * submission is. */
export type RiderOutcome = { ok: true } | { ok: false; reason: string };
export type SubmissionRider = (unitOfWork: unknown) => Promise<RiderOutcome>;

/* A subject held for a person outside any attempt: the coverage dispute, the
   hold decision, the transition to needs_human and the audit, one write. */
export type SubjectHold = {
  workflowId: string;
  disagreement: NewDisagreement;
  decision: DecisionApplication;
  transition: DisagreementTransition;
  audits: AuditRecord[];
};

export type HoldOutcome = { alreadyHeld: boolean; disagreement: DisagreementRecord; decision: DecisionRecord | null };

/* Everything one attempt's answer makes true, written together or not at all. */
export type ResultCommit = {
  workflowId: string;
  taskId: string;
  attemptId: string;
  attempt: {
    to: Extract<AttemptState, "succeeded" | "failed_known" | "outcome_unknown" | "output_limited">;
    validationState: ValidationState;
    validationProblems: string[];
    rawResult: unknown;
    rawResultHash: string;
    errorCode: string | null;
    errorMessage: string | null;
    /* What the executor saw of the thing that answered it, if it could say.
       Written with the result, in the same commit, never afterwards. */
    providerFacts?: ProviderFacts;
  };
  task: { to: Extract<TaskState, "completed" | "failed_known" | "outcome_unknown">; reason: string | null };
  segments: NewSegment[];
  claims: NewClaim[];
  assessments: NewAssessment[];
  disagreements: NewDisagreement[];
  claimTransitions: ClaimTransition[];
  disagreementRounds: { disagreementId: string; criticRounds?: number; arbiterRounds?: number }[];
  disagreementTransitions: DisagreementTransition[];
  decisions: DecisionApplication[];
  children: NewTask[];
  dependencies: { taskId: string; dependsOnTaskId: string; kind: DependencyKind }[];
  followUps: { disagreementId: string; round: number; fingerprint: string; taskId: string | null }[];
  taskTransitions: TaskTransition[];
  audits: AuditRecord[];
  limits: AdmissionLimits;
};

export type CommitOutcome = {
  alreadyCommitted: boolean;
  claims: ClaimRecord[];
  assessments: AssessmentRecord[];
  disagreements: DisagreementRecord[];
  segments: { created: SegmentRecord[]; reused: SegmentRecord[] };
  children: Admission;
  decisions: DecisionRecord[];
  followUpsRefused: { disagreementId: string; round: number; reason: string }[];
};

export interface OrchestrationRepository {
  /* workflow */
  createWorkflow(record: WorkflowRecord, sources: SourceDescriptor[]): Promise<WorkflowRecord>;
  getWorkflow(workflowId: string): Promise<WorkflowRecord | null>;
  transitionWorkflow(workflowId: string, from: WorkflowState, to: WorkflowState, patch?: { errorCode?: string | null; errorMessage?: string | null }): Promise<WorkflowRecord>;
  updateWorkflowProgress(workflowId: string, progress: { totalUnits: number; completedUnits: number; attentionUnits: number }): Promise<void>;
  requestCancel(workflowId: string, at: number): Promise<WorkflowRecord>;
  claimOutbox(workflowId: string, dispatcher: string): Promise<boolean>;
  acknowledgeOutbox(workflowId: string): Promise<void>;

  /* sources and segments */
  listSources(workflowId: string): Promise<SourceDescriptor[]>;
  listSegments(workflowId: string, filter?: { sourceId?: string; statuses?: SegmentStatus[] }): Promise<SegmentRecord[]>;
  getSegment(segmentId: string): Promise<SegmentRecord | null>;
  persistSegments(workflowId: string, segments: NewSegment[]): Promise<{ created: SegmentRecord[]; reused: SegmentRecord[] }>;
  transitionSegment(segmentId: string, from: SegmentStatus, to: SegmentStatus): Promise<SegmentRecord>;

  /* tasks */
  admitTasks(workflowId: string, tasks: NewTask[], limits: AdmissionLimits): Promise<Admission>;
  getTask(taskId: string): Promise<TaskRecord | null>;
  listTasks(workflowId: string): Promise<TaskRecord[]>;
  getRunnableTasks(workflowId: string): Promise<TaskRecord[]>;
  getDependencies(taskId: string): Promise<DependencyRecord[]>;
  getDependents(taskId: string): Promise<DependencyRecord[]>;
  addDependency(taskId: string, dependsOnTaskId: string, kind: DependencyKind, limits: AdmissionLimits): Promise<void>;
  transitionTask(taskId: string, from: TaskState, to: TaskState, reason?: string | null): Promise<TaskRecord>;
  leaseTask(taskId: string, owner: string, ttlMs: number, now: number): Promise<TaskRecord | null>;
  heartbeatLease(taskId: string, leaseToken: string, ttlMs: number, now: number): Promise<boolean>;
  releaseDependents(workflowId: string): Promise<{ released: TaskRecord[]; stopped: TaskRecord[] }>;
  expireLeases(workflowId: string, now: number): Promise<TaskRecord[]>;

  /* attempts */
  listAttempts(taskId: string): Promise<AttemptRecord[]>;
  getAttempt(attemptId: string): Promise<AttemptRecord | null>;
  createAttempt(record: AttemptRecord): Promise<AttemptRecord>;
  /* `alongside` is run inside this move's own unit of work, after every rule
     has passed and before the attempt moves. If it refuses, the submission is
     refused and nothing it wrote survives. */
  submitAttempt(attemptId: string, leaseToken: string, now: number, alongside?: SubmissionRider): Promise<SubmitOutcome>;
  transitionAttempt(attemptId: string, from: AttemptState, to: AttemptState, patch?: { errorCode?: string | null; errorMessage?: string | null; usage?: Record<string, unknown> }): Promise<AttemptRecord>;
  independenceDomainsForSubject(workflowId: string, subjectKey: string): Promise<string[]>;
  commitValidatedResult(commit: ResultCommit): Promise<CommitOutcome>;
  /* What the executor said became of an attempt whose outcome was unknown.
     Only an outcome_unknown attempt takes one; it is written once; "unknown"
     is not written at all, so the question can be asked again. */
  recordReconciliation(attemptId: string, outcome: ReconciliationOutcome): Promise<AttemptRecord>;

  /* evidence */
  listClaims(filter: ClaimFilter): Promise<ClaimRecord[]>;
  getClaim(claimId: string): Promise<ClaimRecord | null>;
  transitionClaim(claimId: string, from: ClaimStatus, to: ClaimStatus): Promise<ClaimRecord>;
  listAnchors(claimIds: string[]): Promise<AnchorRecord[]>;
  listAssessmentAnchors(assessmentIds: string[]): Promise<AnchorRecord[]>;
  listAssessments(claimIds: string[]): Promise<AssessmentRecord[]>;

  /* disagreements */
  getDisagreement(disagreementId: string): Promise<DisagreementRecord | null>;
  listDisagreements(workflowId: string): Promise<DisagreementRecord[]>;
  transitionDisagreement(t: DisagreementTransition): Promise<DisagreementRecord>;
  holdSubject(hold: SubjectHold): Promise<HoldOutcome>;

  /* decisions */
  applyDecision(application: DecisionApplication): Promise<DecisionRecord>;
  listDecisions(workflowId: string): Promise<DecisionRecord[]>;
  getDecision(decisionId: string): Promise<DecisionRecord | null>;

  /* audit */
  audit(record: AuditRecord): Promise<void>;
  listAudit(): Promise<AuditRecord[]>;
}

/* The identity of a task, as admission compares it: the work, not its
   provenance. Two tasks with one id and two identities are a collision, and
   admission refuses the second; a follow-up that asks for work the plan
   already holds is the same work, whoever asked and however deep. */
export function taskPayload(task: NewTask | TaskRecord): Record<string, unknown> {
  return {
    workflowId: task.workflowId, phase: task.phase, taskType: task.taskType,
    roleKey: task.roleKey, roleVersion: task.roleVersion, subjectKey: task.subjectKey, sources: task.sources,
    inputFingerprint: task.inputFingerprint, contractVersion: task.contractVersion, independenceGroup: task.independenceGroup,
    disagreementId: task.disagreementId, targetClaimIds: [...task.targetClaimIds].sort(),
  };
}
