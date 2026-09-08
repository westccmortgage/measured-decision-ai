/* What bounds the engine, in numbers.
 *
 * No provider is called in this repository, and the policy is enforced
 * anyway: an engine that only learns restraint once money is attached learns
 * it at somebody's expense. Every limit here is a place a run stops of its
 * own accord, and what it does when it stops is written next to the number.
 * The subset the database enforces too is snapshotted onto the workflow as
 * its budget.
 */
import type { WorkflowBudget } from "./contracts.ts";

export type OrchestrationPolicy = {
  /* Concurrency. Leased and running tasks count, and so does an execution
     that timed out but has not settled — a slot is not free while a provider
     may still be working on it. */
  maximumConcurrentTasksPerWorkflow: number;
  maximumConcurrentTasksPerRole: number;
  maximumTimedOutExecutions: number;

  /* Recursion. Every child task is one deeper than its parent; a request that
     would exceed the depth is refused and the subject escalates to a person. */
  maximumFollowUpDepth: number;
  maximumChildTasksPerParent: number;

  /* Spending. A task that fails this many times is failed_known, not retried. */
  maximumAttemptsPerTask: number;

  /* Independence. How many blind readers one subject gets, at most. */
  maximumIndependentReadersPerSubject: number;

  /* Adjudication. Rounds of criticism on one disagreement before it goes to a
     person; rounds of arbitration before the same. Exactly one follow-up is
     admitted per round. */
  maximumCriticRounds: number;
  maximumArbiterRounds: number;

  /* Fan-out. A workflow that would exceed this is refused at planning time,
     and a child that would cross it at run time is refused and escalated. */
  maximumTasksPerWorkflow: number;
  maximumDependencyEdgesPerWorkflow: number;

  /* Packets and envelopes. A packet past these is not sent; an envelope past
     them is refused and kept. */
  maximumPacketClaims: number;
  maximumPacketSources: number;
  maximumPacketBytes: number;
  maximumEnvelopeBytes: number;

  /* How many of one subject's disagreements are sent to a verifier at once.
     Past this, the rest go to a person. */
  maximumVerifiedDisagreementsPerSubject: number;

  /* How long one attempt may run before its outcome is treated as unknown,
     and how the lease that covers it is kept alive meanwhile. The lease must
     outlive the attempt and its settlement, or be heartbeated; the scheduler
     refuses a configuration that does neither. */
  attemptTimeoutMs: number;
  settlementAllowanceMs: number;
  heartbeatIntervalMs: number;

  stopOnCancel: true;

  verifySeverities: ("critical" | "material" | "informational")[];
  escalateImmediatelyAtSeverity: "critical" | "material" | "informational" | null;
};

export const DEFAULT_POLICY: OrchestrationPolicy = {
  maximumConcurrentTasksPerWorkflow: 12,
  maximumConcurrentTasksPerRole: 4,
  maximumTimedOutExecutions: 4,
  maximumFollowUpDepth: 3,
  maximumChildTasksPerParent: 4,
  maximumAttemptsPerTask: 2,
  maximumIndependentReadersPerSubject: 2,
  maximumCriticRounds: 2,
  maximumArbiterRounds: 2,
  maximumTasksPerWorkflow: 2000,
  maximumDependencyEdgesPerWorkflow: 8000,
  maximumPacketClaims: 400,
  maximumPacketSources: 16,
  maximumPacketBytes: 512_000,
  maximumEnvelopeBytes: 1_024_000,
  maximumVerifiedDisagreementsPerSubject: 6,
  attemptTimeoutMs: 300_000,
  settlementAllowanceMs: 30_000,
  heartbeatIntervalMs: 20_000,
  stopOnCancel: true,
  verifySeverities: ["critical", "material"],
  escalateImmediatelyAtSeverity: null,
};

export function policyWith(overrides: Partial<OrchestrationPolicy>): OrchestrationPolicy {
  return { ...DEFAULT_POLICY, ...overrides, stopOnCancel: true };
}

/* The part of the policy the database holds the workflow to as well. */
export function budgetOf(policy: OrchestrationPolicy): WorkflowBudget {
  return {
    maximum_tasks: policy.maximumTasksPerWorkflow,
    maximum_dependency_edges: policy.maximumDependencyEdgesPerWorkflow,
    maximum_child_tasks_per_parent: policy.maximumChildTasksPerParent,
    maximum_follow_up_depth: policy.maximumFollowUpDepth,
    maximum_critic_rounds: policy.maximumCriticRounds,
    maximum_arbiter_rounds: policy.maximumArbiterRounds,
  };
}
