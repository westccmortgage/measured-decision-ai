/* THE PRODUCTION WORLD ONE RUNNER INVOCATION ADVANCES ONE WORKFLOW IN.
 *
 * Everything provider-shaped is here, behind gates, and nothing above it in
 * the runner knows any of it exists. The runner's own file names no provider
 * and this one names none either — it reads an operator's declaration and
 * builds whatever that declares.
 *
 * THE ORDER MATTERS AND IS THE POINT.
 *
 *   1. the workflow's OWN sources are read from the record, and the material
 *      is rebuilt from the seed they carry and checked hash by hash. A runner
 *      that cannot prove it holds this workflow's material builds nothing;
 *   2. the operator's declaration is loaded and validated;
 *   3. the gates are asked: is the network flag on THIS invocation, is the
 *      paid-calls variable set, is there an authority for this workflow;
 *   4. only then is a transport built, and only then can a key be read — by
 *      the sealed executor, at the submission boundary, which is the one
 *      place in this repository that touches one.
 *
 * With the gates shut the world is still built and still runs: the executors
 * refuse before submission, the ledger holds nothing, and the workflow ends
 * up saying, in the record, that it could not be run. That is deliberate. A
 * runner that crashes when it cannot spend tells an operator nothing; a
 * runner that records a refusal tells them exactly what to turn on.
 */
import type { OrchestrationRepository } from "../core-v2/kernel/repository.ts";
import type { Queryable } from "../core-v2/postgres/wire.ts";
import { PostgresOrchestrationRepository } from "../core-v2/postgres/repository.ts";
import { SyntheticRecordsPack } from "../core-v2/domains/synthetic-records/pack.ts";
import { RoleRegistry } from "../core-v2/kernel/roles.ts";
import type { WorkPacket } from "../core-v2/kernel/contracts.ts";
import { BudgetLedger } from "../core-v2-runtime/budget/ledger.ts";
import { meteredRepository } from "../core-v2-runtime/budget/metered.ts";
import { buildProviderRegistry } from "../core-v2-runtime/providers/registry.ts";
import { compilePrompt } from "../core-v2-runtime/prompt-compiler.ts";
import { InMemoryMaterialResolver } from "../core-v2-runtime/material/memory-resolver.ts";
import type { RuntimeConfig } from "../core-v2-runtime/runtime-config.ts";
import { loadOperatorRegistry } from "../core-v2-canary/operator-registry.ts";
import type { OperatorRegistry } from "../core-v2-canary/operator-registry.ts";
import { sourceSetOfRecord } from "./source-set.ts";
import type { HttpTransport } from "../core-v2-runtime/transport/transport.ts";
import type { RunnerWorld } from "./runner.ts";

export const REGISTRY_VARIABLE = "CORE_V2_RUNNER_REGISTRY";
export const PAID_CALLS_VARIABLE = "CORE_V2_ALLOW_PAID_CALLS";
export const AUTHORITY_VARIABLE = "CORE_V2_RUNNER_AUTHORIZED_USD";
export const CONCURRENCY_VARIABLE = "CORE_V2_RUNNER_CONCURRENT_ATTEMPTS";

/* Dormant by default, and every one of these is a deliberate act by an
   operator. None has a value that turns anything on by accident. */
export const DEFAULT_CONCURRENT_ATTEMPTS = 6;
export const DEFAULT_MAXIMUM_ATTEMPTS = 60;

export type Gates = {
  /* This invocation asked for the provider network. Never a default: an
     operator turns it on per call, and the tick that a watchdog sends does
     not carry it unless the deployment says so. */
  networkFlag: boolean;
  environment: (name: string) => string | undefined;
};

export type WorldProblem = { refused: string; detail?: unknown };

export function isProblem(value: unknown): value is WorldProblem {
  return typeof value === "object" && value !== null && "refused" in (value as Record<string, unknown>);
}

/* The one authority number this deployment gives a workflow, in the currency
   the declaration prices in. It is per workflow and it is set once, at start;
   a continuation never offers one. */
export function authorityFor(environment: (name: string) => string | undefined): number | null {
  const raw = environment(AUTHORITY_VARIABLE);
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

export function concurrencyFor(environment: (name: string) => string | undefined): number {
  const raw = Number(environment(CONCURRENCY_VARIABLE) ?? "");
  return Number.isFinite(raw) && raw >= 1 ? Math.trunc(raw) : DEFAULT_CONCURRENT_ATTEMPTS;
}

export function operatorRegistry(environment: (name: string) => string | undefined): OperatorRegistry | WorldProblem {
  const declaration = environment(REGISTRY_VARIABLE);
  if (!declaration) {
    return { refused: `${REGISTRY_VARIABLE} is not set: this runner has no operator declaration of models, addresses, capabilities and prices, and it invents none` };
  }
  const { registry, problems } = loadOperatorRegistry(declaration, REGISTRY_VARIABLE);
  if (!registry) return { refused: "the operator declaration was refused", detail: problems };
  return registry;
}

/* The configuration the runtime is handed: the operator's declaration, plus
   the authorization this deployment grants, plus the clock's own answer
   window in place of whatever the declaration hoped for. */
export function configuredFor(
  registry: OperatorRegistry, gates: Gates, answerWithinMs: number, authorized: number,
): RuntimeConfig {
  const providers = registry.config.providers.map((provider) => (
    provider.requestTimeoutMs <= answerWithinMs ? provider : { ...provider, requestTimeoutMs: answerWithinMs }
  ));
  return {
    ...registry.config,
    providers,
    authorization: {
      providerNetworkFlag: gates.networkFlag === true,
      environmentGate: gates.environment(PAID_CALLS_VARIABLE) === "true",
      maximumAuthorizedCost: authorized,
      currency: "USD",
      providerAllowlist: registry.config.providers.map((p) => p.providerId),
      modelAllowlist: registry.config.providers.flatMap((p) => p.models),
    },
  };
}

export type BuiltWorld = {
  world: RunnerWorld;
  config: RuntimeConfig;
  ledger: BudgetLedger;
  unresolvedHosts: string[];
  seed: string;
};

/* Builds the world for ONE workflow. The workflow id is not decoration: the
   sources it reads, the material it may resolve and the budget it may hold
   are all that workflow's, and a runner holding this world can advance no
   other. */
export async function buildWorldFor(options: {
  client: Queryable;
  workflowId: string;
  organizationId: string;
  registry: OperatorRegistry;
  gates: Gates;
  answerWithinMs: number;
  authorized: number;
  /* THE ONE THING THIS FILE DOES NOT BUILD.
     Injected, because the Edge Runtime's transport and a test's sealed
     transport are the same shape and everything above this line must not be
     able to tell them apart. It is also the only way an offline suite can
     drive the REAL world builder rather than a simplified copy of it. */
  transport: (config: RuntimeConfig) => HttpTransport & { unresolvedHosts: string[] };
}): Promise<BuiltWorld | WorldProblem> {
  const { client, workflowId, organizationId, registry, gates, answerWithinMs, authorized } = options;

  const recorded = await client.query(
    `select ordinal, uri, content_hash from public.workflow_sources
      where workflow_id = $1 order by ordinal`, [workflowId]);
  let sourceSet;
  try {
    sourceSet = sourceSetOfRecord(workflowId, organizationId, recorded.rows.map((row) => ({
      ordinal: Number(row.ordinal), uri: String(row.uri), contentHash: String(row.content_hash),
    })));
  } catch (error) {
    return { refused: "this runner cannot prove it holds this workflow's material", detail: (error as { reasons?: string[] }).reasons ?? String((error as Error).message) };
  }

  const config = configuredFor(registry, gates, answerWithinMs, authorized);
  const pack = new SyntheticRecordsPack();
  const roles = new RoleRegistry(pack);
  const ledger = new BudgetLedger(client as never, config);

  const stored = new Map<string, { mediaKind: string; mimeType: string; bytes: Uint8Array }>();
  for (const [hash, item] of sourceSet.material) stored.set(hash, item);

  const transport = options.transport(config);
  const executors = buildProviderRegistry({
    config, transport, routing: registry.routing,
    compilePrompt: (packet: WorkPacket) => compilePrompt(packet, roles.role(packet.roleKey)),
    materialResolver: new InMemoryMaterialResolver(stored as never),
    environment: gatesToEnvironment(gates),
  });

  const world: RunnerWorld = {
    pack,
    executors: () => executors.registry,
    repository: (c: Queryable): OrchestrationRepository => meteredRepository(
      new PostgresOrchestrationRepository(c as never, { organizationId }),
      { ledger, config, providerOfFamily: (family: string) => registry.routing[family] ?? null },
    ),
    hasBudget: async (id: string) => (await ledger.budget(id)) !== null,
    authorize: async (id: string) => {
      const concurrent = concurrencyFor(gates.environment);
      await ledger.authorizeWorkflow({
        workflowId: id, organizationId, currency: "USD",
        authorizedMaximum: authorized,
        maximumPerAttempt: worstPerAttempt(config),
        maximumAttempts: DEFAULT_MAXIMUM_ATTEMPTS,
        maximumConcurrentAttempts: concurrent,
        /* Held totals, not per-request ceilings. The canary spent four
           generations discovering that difference one reader at a time. */
        maximumInputTokens: concurrent * Math.max(...config.providers.map((p) => p.maximumInputTokens)),
        maximumOutputTokens: concurrent * Math.max(...config.providers.map((p) => p.maximumOutputTokens)),
      });
    },
  };

  return { world, config, ledger, unresolvedHosts: transport.unresolvedHosts, seed: sourceSet.seed };
}

/* The most any one attempt of any configured model could hold. Priced from
   the ceilings, never from an expectation. */
function worstPerAttempt(config: RuntimeConfig): number {
  let worst = 0;
  for (const provider of config.providers) {
    const price = config.pricing.find((p) => p.providerId === provider.providerId && provider.models.includes(p.model));
    if (!price) continue;
    const input = Math.max(price.inputPerMillionTokens, price.cachedInputPerMillionTokens ?? 0, price.cacheWritePerMillionTokens ?? 0);
    const output = Math.max(price.outputPerMillionTokens, price.reasoningPerMillionTokens ?? 0);
    const ceiling = (provider.maximumInputTokens * input + provider.maximumOutputTokens * output) / 1_000_000;
    if (ceiling > worst) worst = ceiling;
  }
  return Number(worst.toFixed(6));
}

function gatesToEnvironment(gates: Gates): Record<string, string | undefined> {
  return new Proxy({}, {
    get: (_target, name: string) => gates.environment(name),
    has: (_target, name: string) => gates.environment(name) !== undefined,
  }) as Record<string, string | undefined>;
}
