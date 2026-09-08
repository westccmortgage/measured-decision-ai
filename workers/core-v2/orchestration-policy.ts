/* What bounds the engine, in numbers.
 *
 * No provider is called in this PR, and the policy is enforced anyway: an
 * engine that only learns restraint once money is attached learns it on a
 * customer's invoice. Every limit here is a place a run stops of its own
 * accord, and what it does when it stops is written next to the number.
 */

export type OrchestrationPolicy = {
  /* Concurrency. Leased and running tasks count against both. */
  maximumConcurrentTasksPerWorkflow: number;
  maximumConcurrentTasksPerRole: number;

  /* Recursion. Every child task is one deeper than its parent; a request that
     would exceed the depth is refused and the subject escalates to a person. */
  maximumFollowUpDepth: number;
  maximumChildTasksPerParent: number;

  /* Spending. A task that fails this many times is failed_known, not retried. */
  maximumAttemptsPerTask: number;

  /* Independence. How many blind readers one subject gets, at most. */
  maximumIndependentReadersPerSubject: number;

  /* Adjudication. Rounds of criticism on one disagreement before it goes to a
     person; rounds of arbitration before the same. */
  maximumCriticRounds: number;
  maximumArbiterRounds: number;

  /* Fan-out. A workflow that would exceed this is refused at planning time,
     and a child that would cross it at run time is refused and escalated. */
  maximumTasksPerWorkflow: number;

  /* How many of one subject's disagreements are sent to a verifier at once.
     Past this, the rest go to a person: a comparison that finds forty
     differences is not forty verifier calls, it is a subject a person reads. */
  maximumVerifiedDisagreementsPerSubject: number;

  /* How long one attempt may run before its outcome is treated as unknown —
     it may have reached a provider, so it is never retried by the machine. */
  attemptTimeoutMs: number;

  /* Cancellation stops everything unsent. Sent work reconciles on its own. */
  stopOnCancel: true;

  /* Which disagreement severities earn a verifier at all. Informational ones
     are recorded and left. */
  verifySeverities: ("critical" | "material" | "informational")[];

  /* Escalation. A disagreement of this severity that the arbiter cannot settle
     goes straight to a person rather than another round. */
  escalateImmediatelyAtSeverity: "critical" | "material" | "informational" | null;
};

export const DEFAULT_POLICY: OrchestrationPolicy = {
  maximumConcurrentTasksPerWorkflow: 12,
  maximumConcurrentTasksPerRole: 4,
  /* Depth is absolute: a comparison's verifier is one deep, that verifier's
     expanded re-read two, an arbiter's second round two. Three is the floor a
     dispute can reach before a person; nothing goes deeper. */
  maximumFollowUpDepth: 3,
  maximumChildTasksPerParent: 4,
  maximumAttemptsPerTask: 2,
  maximumIndependentReadersPerSubject: 2,
  maximumCriticRounds: 2,
  maximumArbiterRounds: 2,
  maximumTasksPerWorkflow: 2000,
  maximumVerifiedDisagreementsPerSubject: 6,
  attemptTimeoutMs: 300_000,
  stopOnCancel: true,
  verifySeverities: ["critical", "material"],
  escalateImmediatelyAtSeverity: null,
};

export function policyWith(overrides: Partial<OrchestrationPolicy>): OrchestrationPolicy {
  return { ...DEFAULT_POLICY, ...overrides, stopOnCancel: true };
}
