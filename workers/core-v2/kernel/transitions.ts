/* The state machines, mirrored from migration 058.
 *
 * The database refuses any move not in its table, whoever asks. This engine
 * refuses the same moves before it ever reaches the database, so an in-memory
 * run and a persisted run cannot disagree about what is legal. If the table in
 * core_v2_transition_allowed changes, this changes with it, and
 * tests/workflow-states.mjs walks both.
 */
import type {
  AttemptState, ClaimStatus, DecisionStatus, DisagreementState, SegmentStatus, TaskState, WorkflowState,
} from "./contracts.ts";

const WORKFLOW: Record<WorkflowState, WorkflowState[]> = {
  created: ["queued", "cancelled"],
  queued: ["planning", "cancelled", "failed"],
  planning: ["running", "needs_attention", "failed", "cancelled"],
  running: ["needs_attention", "ready_for_decision", "cancelled", "failed"],
  needs_attention: ["running", "ready_for_decision", "cancelled", "failed"],
  ready_for_decision: ["deciding", "needs_attention"],
  deciding: ["completed", "partial", "needs_attention", "failed"],
  completed: [],
  partial: [],
  failed: [],
  cancelled: [],
};

const TASK: Record<TaskState, TaskState[]> = {
  created: ["blocked", "queued", "cancelled"],
  blocked: ["queued", "cancelled", "superseded"],
  /* A queued task that gains a prerequisite waits again; it does not run
     with a dependency unmet. */
  queued: ["blocked", "leased", "cancelled", "superseded"],
  leased: ["running", "queued", "cancelled"],
  running: ["completed", "failed_known", "outcome_unknown", "cancelled"],
  completed: [],
  failed_known: [],
  outcome_unknown: [],
  cancelled: [],
  superseded: [],
};

const ATTEMPT: Record<AttemptState, AttemptState[]> = {
  prepared: ["submitted", "rejected_before_submission", "cancelled_before_submission"],
  submitted: ["response_received", "failed_known", "output_limited", "outcome_unknown"],
  response_received: ["parsed", "output_limited", "failed_known"],
  parsed: ["succeeded", "failed_known"],
  succeeded: [],
  rejected_before_submission: [],
  failed_known: [],
  output_limited: [],
  cancelled_before_submission: [],
  outcome_unknown: [],
};

const CLAIM: Record<ClaimStatus, ClaimStatus[]> = {
  proposed: ["corroborated", "disputed", "verified", "accepted", "rejected", "unresolved", "superseded"],
  corroborated: ["disputed", "verified", "accepted", "rejected", "unresolved", "superseded"],
  disputed: ["verified", "accepted", "rejected", "unresolved", "superseded"],
  verified: ["accepted", "rejected", "disputed", "superseded"],
  unresolved: ["disputed", "verified", "accepted", "rejected", "superseded"],
  accepted: ["superseded"],
  rejected: ["superseded"],
  superseded: [],
};

const DISAGREEMENT: Record<DisagreementState, DisagreementState[]> = {
  open: ["verifying", "needs_human", "resolved", "superseded"],
  verifying: ["resolved", "needs_human", "superseded"],
  needs_human: ["resolved", "superseded"],
  resolved: ["superseded"],
  superseded: [],
};

const SEGMENT: Record<SegmentStatus, SegmentStatus[]> = {
  proposed: ["accepted", "rejected", "superseded"],
  accepted: ["superseded"],
  rejected: ["superseded"],
  superseded: [],
};

const DECISION: Record<DecisionStatus, DecisionStatus[]> = {
  proposed: ["machine_decided", "needs_human", "superseded"],
  needs_human: ["human_decided", "superseded"],
  machine_decided: ["superseded"],
  human_decided: ["superseded"],
  superseded: [],
};

export const TERMINAL_WORKFLOW_STATES: WorkflowState[] = ["completed", "partial", "failed", "cancelled"];
export const TERMINAL_TASK_STATES: TaskState[] = ["completed", "failed_known", "outcome_unknown", "cancelled", "superseded"];
export const TERMINAL_ATTEMPT_STATES: AttemptState[] = [
  "succeeded", "rejected_before_submission", "failed_known", "output_limited",
  "cancelled_before_submission", "outcome_unknown",
];
/* An attempt at or beyond this point may have reached a provider. The list
   is the database trigger's list, exactly. */
export const SUBMITTED_ATTEMPT_STATES: AttemptState[] = [
  "submitted", "response_received", "parsed", "succeeded", "output_limited", "outcome_unknown",
];

export const MACHINES = { workflow: WORKFLOW, task: TASK, attempt: ATTEMPT, claim: CLAIM, disagreement: DISAGREEMENT, segment: SEGMENT, decision: DECISION } as const;

export function workflowMoveAllowed(from: WorkflowState, to: WorkflowState): boolean { return WORKFLOW[from].includes(to); }
export function taskMoveAllowed(from: TaskState, to: TaskState): boolean { return TASK[from].includes(to); }
export function attemptMoveAllowed(from: AttemptState, to: AttemptState): boolean { return ATTEMPT[from].includes(to); }
export function claimMoveAllowed(from: ClaimStatus, to: ClaimStatus): boolean { return CLAIM[from].includes(to); }
export function disagreementMoveAllowed(from: DisagreementState, to: DisagreementState): boolean { return DISAGREEMENT[from].includes(to); }
export function segmentMoveAllowed(from: SegmentStatus, to: SegmentStatus): boolean { return SEGMENT[from].includes(to); }
export function decisionMoveAllowed(from: DecisionStatus, to: DecisionStatus): boolean { return DECISION[from].includes(to); }

export class IllegalTransition extends Error {
  machine: string;
  from: string;
  to: string;
  constructor(machine: string, from: string, to: string) {
    super(`core-v2: a ${machine} cannot go from ${from} to ${to}`);
    this.machine = machine;
    this.from = from;
    this.to = to;
  }
}

/* A compare-and-set that failed: the row was not in the state the caller
   believed. Not an illegal move — a stale view. */
export class StaleState extends Error {
  constructor(machine: string, id: string, expected: string, actual: string) {
    super(`core-v2: ${machine} ${id} is ${actual}, not ${expected} — the caller's view is stale`);
  }
}
