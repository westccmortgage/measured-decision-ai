/* The state machines, mirrored from migration 058.
 *
 * The database refuses any move not in its table, whoever asks. This engine
 * refuses the same moves before it ever reaches the database, so an in-memory
 * run and a persisted run cannot disagree about what is legal. If the table in
 * core_v2_transition_allowed changes, this changes with it.
 */
import type { AttemptState, ClaimStatus, DecisionStatus, DisagreementState, TaskState } from "./contracts.ts";

const TASK: Record<TaskState, TaskState[]> = {
  created: ["blocked", "queued", "cancelled"],
  blocked: ["queued", "cancelled", "superseded"],
  queued: ["leased", "cancelled", "superseded"],
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

const DECISION: Record<DecisionStatus, DecisionStatus[]> = {
  proposed: ["machine_decided", "needs_human", "superseded"],
  needs_human: ["human_decided", "superseded"],
  machine_decided: ["superseded"],
  human_decided: ["superseded"],
  superseded: [],
};

export const TERMINAL_TASK_STATES: TaskState[] = ["completed", "failed_known", "outcome_unknown", "cancelled", "superseded"];
export const TERMINAL_ATTEMPT_STATES: AttemptState[] = [
  "succeeded", "rejected_before_submission", "failed_known", "output_limited",
  "cancelled_before_submission", "outcome_unknown",
];
/* An attempt at or beyond this point may have reached a provider. */
export const SUBMITTED_ATTEMPT_STATES: AttemptState[] = [
  "submitted", "response_received", "parsed", "succeeded", "output_limited", "outcome_unknown",
];

export function taskMoveAllowed(from: TaskState, to: TaskState): boolean {
  return TASK[from].includes(to);
}
export function attemptMoveAllowed(from: AttemptState, to: AttemptState): boolean {
  return ATTEMPT[from].includes(to);
}
export function claimMoveAllowed(from: ClaimStatus, to: ClaimStatus): boolean {
  return CLAIM[from].includes(to);
}
export function disagreementMoveAllowed(from: DisagreementState, to: DisagreementState): boolean {
  return DISAGREEMENT[from].includes(to);
}
export function decisionMoveAllowed(from: DecisionStatus, to: DecisionStatus): boolean {
  return DECISION[from].includes(to);
}

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
