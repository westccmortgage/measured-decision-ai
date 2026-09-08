/* TWO WAYS TO RUN THE ENGINE WITHOUT SPENDING A CENT.
 *
 *   --dry-run    build the task graph for the synthetic project and print it:
 *                every assignment, its role, its dependencies, its blind group.
 *                No executor is called.
 *   --simulate   run the whole control loop on mocked executors: blind readers,
 *                comparison, criticism, arbitration, counting, decisions.
 *                No network, no provider, no production data.
 *
 * Before either runs, the network is closed (`network-guard.ts`): fetch,
 * http, https, net, tls, dns, WebSocket and child processes all throw and are
 * counted. Anything in this engine that tried to reach out would fail loudly
 * rather than quietly, and the simulation's summary reports the count.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describeGraph, buildTaskGraph } from "./graph-builder.ts";
import { DeterministicExecutor } from "./executors/deterministic-executor.ts";
import { ExecutorRegistry } from "./executors/executor.ts";
import { MockAgentExecutor } from "./executors/mock-agent-executor.ts";
import { syntheticManifest } from "./fixtures/synthetic-project.ts";
import { closeTheNetwork } from "./network-guard.ts";
import { DEFAULT_POLICY } from "./orchestration-policy.ts";
import { InMemoryOrchestrationRepository } from "./repository.ts";
import { assertRegistryConsistent, ROLE_KEYS } from "./role-registry.ts";
import { AgentRouter, DEFAULT_ROUTING_TABLE } from "./router.ts";
import { Scheduler } from "./scheduler.ts";

export { closeTheNetwork };

/* Every executor family the router can name, served by a mock or by code. */
export function mockExecutors(behaviour: ConstructorParameters<typeof MockAgentExecutor>[1] = {}) {
  const registry = new ExecutorRegistry();
  registry.register(new DeterministicExecutor(), ["deterministic"]);
  const families = new Set<string>();
  for (const profile of Object.values(DEFAULT_ROUTING_TABLE)) for (const c of profile) if (c.family !== "deterministic") families.add(c.family);
  for (const family of families) registry.register(new MockAgentExecutor(family, behaviour), [family]);
  return registry;
}

export async function simulate(options: { quiet?: boolean; behaviour?: ConstructorParameters<typeof MockAgentExecutor>[1] } = {}) {
  const guard = closeTheNetwork();
  const manifest = syntheticManifest();
  const repo = new InMemoryOrchestrationRepository();
  const executors = mockExecutors(options.behaviour ?? {});
  const scheduler = new Scheduler(repo, manifest, DEFAULT_POLICY, new AgentRouter(), executors, {
    owner: "simulation", leaseTtlMs: 60_000, now: () => 0,
  });
  const planned = await scheduler.plan();
  const run = await scheduler.runUntilQuiescent();
  const summary = {
    planned: planned.created.length,
    ticks: run.ticks,
    workflow: run.workflow.state,
    tasks: run.tasks,
    byRole: run.byRole,
    disagreements: run.disagreements,
    decisions: run.decisions,
    escalations: run.escalations,
    executions: executors.invocations.length,
    families: [...new Set(executors.invocations.map((i) => i.family))].sort(),
    networkCallsAttempted: guard.tripped(),
  };
  if (!options.quiet) console.log(JSON.stringify(summary, null, 2));
  return { summary, repo, scheduler, executors, manifest };
}

async function main() {
  const args = process.argv.slice(2);
  const problems = assertRegistryConsistent();
  if (problems.length) { console.error("role registry is inconsistent:\n  " + problems.join("\n  ")); process.exit(1); }

  if (args.includes("--dry-run")) {
    closeTheNetwork();
    const manifest = syntheticManifest();
    const graph = buildTaskGraph(manifest, DEFAULT_POLICY);
    console.log(`roles registered: ${ROLE_KEYS.length} — ${ROLE_KEYS.join(", ")}`);
    console.log("");
    console.log(describeGraph(graph));
    console.log("");
    console.log("executor calls: 0   network calls: 0   rows written to production: 0");
    return;
  }
  if (args.includes("--simulate")) {
    await simulate();
    return;
  }
  console.log("usage: node --experimental-strip-types cli.ts --dry-run | --simulate");
  process.exit(2);
}

/* Run as a script, not when imported by a test. Paths are compared as real
   paths, so a checkout under a directory with a space, or reached through a
   symlink, still runs. */
function invokedDirectly(): boolean {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}
if (invokedDirectly()) {
  main().catch((error) => { console.error(error); process.exit(1); });
}
