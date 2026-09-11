/* THE RUNNER'S WORLD, WITH NOTHING REAL IN IT.
 *
 * Every proof in this directory runs against a throwaway PostgreSQL cluster
 * with every migration applied — because what makes the runner safe is SQL,
 * and a fake store would prove only that the fake agrees with itself. The
 * agents are code, the sources are invented from a seed, and the network is
 * sealed by the same guard the kernel's own dry-run suites use.
 *
 * The one socket any of this opens is the unix socket to the throwaway
 * cluster. No provider is named, reached, or configured.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PostgresOrchestrationRepository } from "../../core-v2/postgres/repository.ts";
import { syntheticRecordSet } from "../../core-v2/domains/synthetic-records/fixture.ts";
import { SyntheticRecordsPack } from "../../core-v2/domains/synthetic-records/pack.ts";
import { mockExecutors } from "../../core-v2/domains/synthetic-records/mocks.ts";
import { enqueueWorkflow } from "../../core-v2-runtime/dispatcher.ts";
import { BudgetLedger } from "../../core-v2-runtime/budget/ledger.ts";
import { meteredRepository } from "../../core-v2-runtime/budget/metered.ts";
import { PostgresContinuationStore } from "../continuations.ts";
import { invocationClock } from "../clock.ts";
import { runOnePass } from "../runner.ts";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/* A configuration with three named families and prices, so the ledger has
   something to hold money against. It reaches nowhere: the addresses are the
   reserved-by-standard `.invalid` names, and no transport is ever built from
   this — the executors are code. */
export function pricedConfiguration() {
  const provider = (providerId, model) => ({
    providerId, baseUrl: `https://${providerId}.invalid`,
    apiKeyEnvironmentVariable: `CORE_V2_DEMONSTRATION_KEY_${providerId.toUpperCase()}`,
    models: [model], defaultModel: model,
    maximumInputTokens: 8192, maximumOutputTokens: 4096, requestTimeoutMs: 60_000,
    maximumMaterialBytes: 524_288, maximumMaterialBytesPerItem: 262_144,
    supportedMediaTypes: ["text/plain; charset=utf-8", "image/png"],
    capabilities: { [model]: { forcedToolChoice: true, strictSchema: true, images: true, thinking: "optional" } },
  });
  const price = (providerId, model) => ({
    providerId, model, effectiveFrom: "2026-01-01", currency: "USD",
    inputPerMillionTokens: 1, cachedInputPerMillionTokens: 0.1,
    cacheWritePerMillionTokens: 1, outputPerMillionTokens: 5, reasoningPerMillionTokens: 5,
  });
  return {
    providers: [provider("alpha", "alpha-1"), provider("beta", "beta-1"), provider("gamma", "gamma-1")],
    pricing: [price("alpha", "alpha-1"), price("beta", "beta-1"), price("gamma", "gamma-1")],
    authorization: {
      providerNetworkFlag: false, environmentGate: false,
      maximumAuthorizedCost: 0, currency: "USD", providerAllowlist: [], modelAllowlist: [],
    },
  };
}

/* AGENTS THAT TAKE TIME.
 *
 * The scripted executors are code and answer in microseconds, which would
 * make "this workflow is longer than one Edge Function lifetime" impossible
 * to state honestly — the whole thing would fit in any lifetime at all. So
 * the proofs give them a delay. It is not simulation for its own sake: the
 * case Production Runner V1 exists for is precisely the case where the work
 * outlives the process, and a suite that never produces it proves nothing.
 */
/* Every family the synthetic pack routes a model role to. */
export const MODEL_FAMILIES = [
  "reader-family-one", "reader-family-two", "reader-family-three",
  "critic-family-one", "critic-family-two", "arbiter-family-one",
];

export const slowBy = (ms) => async (_packet, base) => {
  await new Promise((resolve) => setTimeout(resolve, ms));
  return base;
};

export function slowScripts(ms, families = MODEL_FAMILIES) {
  return Object.fromEntries(families.map((family) => [family, slowBy(ms)]));
}

/* WHICH PRICED PROVIDER EACH FAMILY'S MONEY IS HELD AGAINST.
 *
 * Not to be confused with the kernel's RoutingTable, which is a different
 * thing under a similar name: that one says which FAMILIES may serve a
 * routing profile and whether they take visual input, and the engine's own
 * default is the right one here. This map only tells the ledger whose prices
 * to reserve at. Handing one where the other belongs is how the first draft
 * of this file produced "no registered executor family serves
 * visual_analysis with visual input" — the router had been given a table
 * with no profiles in it at all. */
export const PROVIDER_OF_FAMILY = {
  "reader-family-one": "alpha",
  "reader-family-two": "beta",
  "reader-family-three": "gamma",
  "critic-family-one": "gamma",
  "critic-family-two": "beta",
  "arbiter-family-one": "gamma",
};

/* What one workflow of the synthetic pack looks like, and everything the
   runner needs to advance it. `seed` decides the material, so two worlds
   built with different seeds have different content hashes — which is what
   the material-isolation proof turns on. */
export function buildWorld({ client, organizationId, seed, scripts = {}, authorizedMaximum = 5 }) {
  const truth = syntheticRecordSet({
    seed, sources: 1, sheetsPerSource: 1, entriesPerTable: 3,
    organizationId, workflowId: undefined,
  });
  const pack = new SyntheticRecordsPack();
  const config = pricedConfiguration();
  const ledger = new BudgetLedger(client, config);
  const plain = new PostgresOrchestrationRepository(client, { organizationId });
  const { registry, executors } = mockExecutors(truth, { scripts });

  const repository = () => meteredRepository(
    new PostgresOrchestrationRepository(client, { organizationId }),
    { ledger, config, providerOfFamily: (family) => PROVIDER_OF_FAMILY[family] ?? null },
  );

  const world = {
    pack,
    executors: () => registry,
    repository,
    /* No routing table: the kernel's own default is what the pack expects. */
    hasBudget: async (workflowId) => (await ledger.budget(workflowId)) !== null,
    authorize: async (workflowId) => {
      await ledger.authorizeWorkflow({
        workflowId, organizationId, currency: "USD",
        authorizedMaximum, maximumPerAttempt: 1, maximumAttempts: 40,
        maximumConcurrentAttempts: 6,
        maximumInputTokens: 6 * 8192, maximumOutputTokens: 6 * 4096,
      });
    },
  };
  return { truth, pack, config, ledger, plain, world, executors, registry };
}

/* Starts one workflow the way the production start operation does: the rows
   that a start command is, then one continuation asking to be run. */
export async function startWorkflow({ client, organizationId, truth, pack }) {
  const store = new PostgresContinuationStore(client);
  const repo = new PostgresOrchestrationRepository(client, { organizationId });
  const workflow = await enqueueWorkflow(repo, truth.manifest, pack);
  await store.schedule(workflow.workflowId, null);
  return { workflowId: workflow.workflowId, store };
}

/* A short-lived runner invocation. `lifetimeMs` is the whole point: the
   proofs turn one long workflow into several short lives on purpose. */
/* A LIFETIME SHORTER THAN THE WORK, ON PURPOSE.
 *
 * 3.2 seconds of life, of which one second may be spent leasing new work —
 * against agents that each take a third of a second and a workflow with five
 * or six sequential rounds of them. Nothing here can finish in one
 * invocation, which is the only condition under which "it continues itself"
 * means anything. */
export const SHORT_LIFE = {
  lifetimeMs: 3_200, safetyMs: 200, answerWithinMs: 1_500,
  settlementRoomMs: 500, heartbeatIntervalMs: 400, graceMs: 1_000,
};

/* Long enough that the clock is not what stops a pass — used where the proof
   is about something other than the wall. */
export const LONG_LIFE = {
  lifetimeMs: 30_000, safetyMs: 500, answerWithinMs: 5_000,
  settlementRoomMs: 1_000, heartbeatIntervalMs: 500, graceMs: 1_000,
};

export function runnerPass({ client, name, world, store, life = SHORT_LIFE, events, concurrentAttempts = 6, release }) {
  return runOnePass({
    name, clock: invocationClock(life), store,
    connect: async () => client,
    world, events, concurrentAttempts, release,
  });
}

/* Drives passes until the workflow stops asking to be continued, or until the
   bound is reached. The bound is the proof that this terminates: a runner
   that needed unbounded passes would not be a runner. */
export async function runUntilSettled({ client, world, store, life = SHORT_LIFE, maximumPasses = 60, name = "runner", events }) {
  const outcomes = [];
  for (let i = 0; i < maximumPasses; i++) {
    const outcome = await runnerPass({ client, name: `${name}-${i + 1}`, world, store, life, events });
    outcomes.push(outcome);
    if (!outcome.claimed) break;
    /* The record says when it is next due, and the SHORTEST that can be is
       now. Waiting the backoff out is the caller's job in a test, and the
       watchdog's in production. */
    if (outcome.scheduledAgain && !outcome.moved) await new Promise((r) => setTimeout(r, 250));
  }
  return outcomes;
}

export function migrationText(file) {
  return readFileSync(join(ROOT, "supabase", "migrations", file), "utf8");
}
