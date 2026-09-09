const WORKFLOW = {
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
const TASK = {
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
const ATTEMPT = {
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
const CLAIM = {
    proposed: ["corroborated", "disputed", "verified", "accepted", "rejected", "unresolved", "superseded"],
    corroborated: ["disputed", "verified", "accepted", "rejected", "unresolved", "superseded"],
    disputed: ["verified", "accepted", "rejected", "unresolved", "superseded"],
    verified: ["accepted", "rejected", "disputed", "superseded"],
    unresolved: ["disputed", "verified", "accepted", "rejected", "superseded"],
    accepted: ["superseded"],
    rejected: ["superseded"],
    superseded: [],
};
const DISAGREEMENT = {
    open: ["verifying", "needs_human", "resolved", "superseded"],
    verifying: ["resolved", "needs_human", "superseded"],
    needs_human: ["resolved", "superseded"],
    resolved: ["superseded"],
    superseded: [],
};
const SEGMENT = {
    proposed: ["accepted", "rejected", "superseded"],
    accepted: ["superseded"],
    rejected: ["superseded"],
    superseded: [],
};
const DECISION = {
    proposed: ["machine_decided", "needs_human", "superseded"],
    needs_human: ["human_decided", "superseded"],
    machine_decided: ["superseded"],
    human_decided: ["superseded"],
    superseded: [],
};
export const TERMINAL_WORKFLOW_STATES = ["completed", "partial", "failed", "cancelled"];
export const TERMINAL_TASK_STATES = ["completed", "failed_known", "outcome_unknown", "cancelled", "superseded"];
export const TERMINAL_ATTEMPT_STATES = [
    "succeeded", "rejected_before_submission", "failed_known", "output_limited",
    "cancelled_before_submission", "outcome_unknown",
];
/* An attempt at or beyond this point may have reached a provider. The list
   is the database trigger's list, exactly. */
export const SUBMITTED_ATTEMPT_STATES = [
    "submitted", "response_received", "parsed", "succeeded", "output_limited", "outcome_unknown",
];
export const MACHINES = { workflow: WORKFLOW, task: TASK, attempt: ATTEMPT, claim: CLAIM, disagreement: DISAGREEMENT, segment: SEGMENT, decision: DECISION };
export function workflowMoveAllowed(from, to) { return WORKFLOW[from].includes(to); }
export function taskMoveAllowed(from, to) { return TASK[from].includes(to); }
export function attemptMoveAllowed(from, to) { return ATTEMPT[from].includes(to); }
export function claimMoveAllowed(from, to) { return CLAIM[from].includes(to); }
export function disagreementMoveAllowed(from, to) { return DISAGREEMENT[from].includes(to); }
export function segmentMoveAllowed(from, to) { return SEGMENT[from].includes(to); }
export function decisionMoveAllowed(from, to) { return DECISION[from].includes(to); }
export class IllegalTransition extends Error {
    machine;
    from;
    to;
    constructor(machine, from, to) {
        super(`core-v2: a ${machine} cannot go from ${from} to ${to}`);
        this.machine = machine;
        this.from = from;
        this.to = to;
    }
}
/* A compare-and-set that failed: the row was not in the state the caller
   believed. Not an illegal move — a stale view. */
export class StaleState extends Error {
    constructor(machine, id, expected, actual) {
        super(`core-v2: ${machine} ${id} is ${actual}, not ${expected} — the caller's view is stale`);
    }
}
