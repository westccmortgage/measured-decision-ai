/* A WORKFLOW ASSEMBLED FROM PARTS, FOR A TEST OR A DRY RUN.
 *
 * Repository, pack, policy, router, executors, clock: named here once so a
 * test says only what differs. Nothing in this file reaches a network, a
 * provider or a database unless the caller hands in a repository that does.
 */
import type { SourceManifest } from "../kernel/contracts.ts";
import type { DomainPack } from "../kernel/domain.ts";
import type { ExecutorRegistry } from "../kernel/executors.ts";
import { InMemoryOrchestrationRepository } from "../kernel/memory-repository.ts";
import type { OrchestrationPolicy } from "../kernel/policy.ts";
import { DEFAULT_POLICY, policyWith } from "../kernel/policy.ts";
import type { OrchestrationRepository } from "../kernel/repository.ts";
import { AgentRouter } from "../kernel/router.ts";
import type { RoutingTable } from "../kernel/router.ts";
import { Scheduler } from "../kernel/scheduler.ts";

export type Clock = { now: () => number; advance: (ms: number) => void };

/* A clock a test moves by hand. Real time never enters a test. */
export function manualClock(start = 1_700_000_000_000): Clock {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

export type SimulationParts = {
  manifest: SourceManifest;
  pack: DomainPack;
  executors: ExecutorRegistry;
  repo?: OrchestrationRepository;
  policy?: Partial<OrchestrationPolicy>;
  routing?: RoutingTable;
  clock?: Clock;
  owner?: string;
  leaseTtlMs?: number;
};

export function assemble(parts: SimulationParts) {
  const repo = parts.repo ?? new InMemoryOrchestrationRepository();
  const clock = parts.clock ?? manualClock();
  const policy = parts.policy ? policyWith(parts.policy) : DEFAULT_POLICY;
  const router = new AgentRouter(parts.routing);
  const scheduler = new Scheduler(repo, parts.manifest, parts.pack, policy, router, parts.executors, {
    owner: parts.owner ?? "worker-1", leaseTtlMs: parts.leaseTtlMs ?? policy.attemptTimeoutMs + policy.settlementAllowanceMs + 1, now: clock.now,
  });
  return { repo, clock, policy, router, scheduler };
}
