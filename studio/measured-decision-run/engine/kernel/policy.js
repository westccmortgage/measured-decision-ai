export const DEFAULT_POLICY = {
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
export function policyWith(overrides) {
    return { ...DEFAULT_POLICY, ...overrides, stopOnCancel: true };
}
/* The part of the policy the database holds the workflow to as well. */
export function budgetOf(policy) {
    return {
        maximum_tasks: policy.maximumTasksPerWorkflow,
        maximum_dependency_edges: policy.maximumDependencyEdgesPerWorkflow,
        maximum_child_tasks_per_parent: policy.maximumChildTasksPerParent,
        maximum_follow_up_depth: policy.maximumFollowUpDepth,
        maximum_critic_rounds: policy.maximumCriticRounds,
        maximum_arbiter_rounds: policy.maximumArbiterRounds,
    };
}
