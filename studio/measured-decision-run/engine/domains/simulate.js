import { InMemoryOrchestrationRepository } from "../kernel/memory-repository.js";
import { DEFAULT_POLICY, policyWith } from "../kernel/policy.js";
import { AgentRouter } from "../kernel/router.js";
import { Scheduler } from "../kernel/scheduler.js";
/* A clock a test moves by hand. Real time never enters a test. */
export function manualClock(start = 1_700_000_000_000) {
    let t = start;
    return { now: () => t, advance: (ms) => { t += ms; } };
}
export function assemble(parts) {
    const repo = parts.repo ?? new InMemoryOrchestrationRepository();
    const clock = parts.clock ?? manualClock();
    const policy = parts.policy ? policyWith(parts.policy) : DEFAULT_POLICY;
    const router = new AgentRouter(parts.routing);
    const scheduler = new Scheduler(repo, parts.manifest, parts.pack, policy, router, parts.executors, {
        owner: parts.owner ?? "worker-1", leaseTtlMs: parts.leaseTtlMs ?? policy.attemptTimeoutMs + policy.settlementAllowanceMs + 1, now: clock.now,
    });
    return { repo, clock, policy, router, scheduler };
}
