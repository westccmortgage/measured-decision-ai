/* ONE ADAPTER PER PROVIDER, AND THAT IS WHY INDEPENDENCE IS TRUE.
 *
 * The kernel assigns an independence domain per executor INSTANCE, not per
 * family and not per name: register the same object under three families and
 * all three are one domain, whatever the routing table calls them. That is
 * the whole mechanism, and this file is where it is used on purpose.
 *
 * So: exactly one adapter is built per configured provider, however many
 * models, aliases or families that provider serves. Two models from one
 * provider are then not two opinions by construction — not by a rule
 * somebody has to remember, and not by a check that could be deleted. If an
 * operator configures one provider and asks for three independent readers,
 * assembly refuses; three readers behind one provider is one reader who
 * answered three times, and no amount of naming makes it otherwise.
 *
 * This is also the one file that maps an opaque provider id to a protocol,
 * which is the only place in the repository where "who this is" and "how it
 * is spoken to" meet.
 */
import type { AgentExecutor } from "../../core-v2/kernel/executors.ts";
import { ExecutorRegistry } from "../../core-v2/kernel/executors.ts";
import type { ProviderConfiguration, RuntimeConfig } from "../runtime-config.ts";
import type { HttpTransport } from "../transport/transport.ts";
import { AnthropicProtocol, ANTHROPIC_PROVIDER_ID } from "./anthropic.ts";
import { GoogleProtocol, GOOGLE_PROVIDER_ID } from "./google.ts";
import { OpenAiProtocol, OPENAI_PROVIDER_ID } from "./openai.ts";
import type { Clock, PromptCompiler, ProviderProtocol, RetryPolicy } from "./provider.ts";
import { ProviderExecutor } from "./provider.ts";

/* The abstract families a routing table speaks in. They are the kernel's
   words for "a reader", numbered so that a workflow can ask for readers that
   must not be the same opinion. Nothing here says which provider is which. */
export const READER_FAMILIES = ["reader-family-one", "reader-family-two", "reader-family-three"];

/* Which protocol knows how to speak to which id. An id is operator-supplied
   and opaque everywhere else; here, and only here, it is looked up. */
const PROTOCOLS: Record<string, (configuration: ProviderConfiguration) => ProviderProtocol> = {
  [ANTHROPIC_PROVIDER_ID]: () => new AnthropicProtocol(),
  [OPENAI_PROVIDER_ID]: () => new OpenAiProtocol(),
  [GOOGLE_PROVIDER_ID]: () => new GoogleProtocol(),
};

export function knownProviderIds(): string[] {
  return Object.keys(PROTOCOLS);
}

export function protocolFor(configuration: ProviderConfiguration): ProviderProtocol | null {
  const make = PROTOCOLS[configuration.providerId];
  return make ? make(configuration) : null;
}

/* ────────────────────────────────────────────── families to providers */

/* The mapping a caller wires: family one, two and three to three different
   providers, in the order the operator configured them. Refuses rather than
   doubling up, because doubling up is the failure this whole layer exists to
   prevent and a silent one would be worse than none. */
export function routeFamiliesToProviders(config: RuntimeConfig, families: string[] = READER_FAMILIES): Record<string, string> {
  const providers = config.providers.map((p) => p.providerId);
  if (providers.length < families.length) {
    throw new Error(
      `core-v2-runtime: ${families.length} independent readers need ${families.length} providers; ${providers.length} ${providers.length === 1 ? "is" : "are"} configured — two families behind one provider is one opinion twice`,
    );
  }
  const routing: Record<string, string> = {};
  families.forEach((family, index) => { routing[family] = providers[index]; });
  return routing;
}

/* The reverse: which families each provider ends up serving. */
export function familiesByProvider(routing: Record<string, string>): Record<string, string[]> {
  const byProvider: Record<string, string[]> = {};
  for (const [family, providerId] of Object.entries(routing)) {
    (byProvider[providerId] ??= []).push(family);
  }
  return byProvider;
}

/* ─────────────────────────────────────────────────────── assembly */

export type ProviderRegistryOptions = {
  config: RuntimeConfig;
  transport: HttpTransport;
  compilePrompt: PromptCompiler;
  /* Defaults to one family per configured provider, in configuration order. */
  routing?: Record<string, string>;
  /* Which model to ask each provider for, when not its configured default. */
  models?: Record<string, string>;
  clock?: Clock;
  retry?: RetryPolicy;
  environment?: Record<string, string | undefined>;
  /* An existing registry to add to, so a run can hold code executors and
     provider executors in one place and one set of domains. */
  registry?: ExecutorRegistry;
};

export type ProviderRegistry = {
  registry: ExecutorRegistry;
  /* One entry per configured provider. The map is the proof: its size is the
     number of adapters that exist, and it cannot exceed the number of
     providers because it is built by iterating them. */
  byProvider: Map<string, ProviderExecutor>;
  routing: Record<string, string>;
  domainOf(providerId: string): string | null;
  /* The domain a family resolves to, which is the domain of the one adapter
     that serves it. */
  domainOfFamily(family: string): string | null;
};

export function buildProviderRegistry(options: ProviderRegistryOptions): ProviderRegistry {
  const { config, transport, compilePrompt } = options;
  const routing = options.routing ?? routeFamiliesToProviders(config, READER_FAMILIES.slice(0, config.providers.length));
  const byFamily = familiesByProvider(routing);
  const registry = options.registry ?? new ExecutorRegistry();
  const byProvider = new Map<string, ProviderExecutor>();
  const domains = new Map<string, string>();

  for (const [family, providerId] of Object.entries(routing)) {
    if (!config.providers.some((p) => p.providerId === providerId)) {
      throw new Error(`core-v2-runtime: ${family} is routed to ${providerId}, which is not configured`);
    }
  }

  for (const configuration of config.providers) {
    const families = byFamily[configuration.providerId];
    /* A configured provider nothing routes to is built for nobody. Skipping
       it keeps "one adapter per provider" a statement about the providers
       that are actually used. */
    if (!families || families.length === 0) continue;
    const protocol = protocolFor(configuration);
    if (!protocol) {
      throw new Error(`core-v2-runtime: nothing in this package knows how to speak to ${configuration.providerId}`);
    }
    if (byProvider.has(configuration.providerId)) {
      /* configurationProblems() says the same thing at assembly time; this is
         the guarantee restated where it would actually be broken. */
      throw new Error(`core-v2-runtime: ${configuration.providerId} is configured twice, and one provider is one opinion`);
    }
    const executor = new ProviderExecutor({
      configuration,
      runtime: config,
      transport,
      protocol,
      compilePrompt,
      families,
      model: options.models?.[configuration.providerId],
      clock: options.clock,
      retry: options.retry,
      environment: options.environment,
    });
    byProvider.set(configuration.providerId, executor);
    /* One register call, every family this provider serves, one domain back
       — and the domain is derived from the provider's own id, so the domain
       a reading was made in is the same domain after a restart. A domain that
       changed with the process would make every restart look like a fresh
       opinion, and a second reading of one subject could then come from the
       provider that already read it. */
    domains.set(configuration.providerId, registry.register(executor as AgentExecutor, families, configuration.providerId));
  }

  return {
    registry,
    byProvider,
    routing,
    domainOf: (providerId: string) => domains.get(providerId) ?? null,
    domainOfFamily: (family: string) => {
      const providerId = routing[family];
      return providerId ? domains.get(providerId) ?? null : null;
    },
  };
}
