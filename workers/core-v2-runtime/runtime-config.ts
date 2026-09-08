/* WHAT THE OPERATOR DECIDED, AND WHAT THE RUNTIME IS THEREFORE ALLOWED TO DO.
 *
 * Nothing in this file names a provider. A provider is an id the operator
 * supplies, an address, the NAME of an environment variable that holds its
 * key, and a list of models that may be asked. The runtime never reads a key
 * here, never prints one, and never decides for itself which model is the
 * right one: a model comes from configuration or the request is refused.
 *
 * The authorization gates are deliberately four separate things that must all
 * be true at once. Any one of them missing refuses before anything is sent,
 * so a key sitting in the environment cannot on its own turn an ordinary
 * command into a paid one.
 */

export type ProviderConfiguration = {
  /* An opaque id. The adapters in providers/ know what to do with theirs. */
  providerId: string;
  /* Where its requests go. Configuration, so a test points at nothing real. */
  baseUrl: string;
  /* The NAME of the variable that holds the key. Never the key. The runtime
     reads it only when a paid call has already been authorised, and never
     prints, tests, rotates or validates what it finds. */
  apiKeyEnvironmentVariable: string;
  /* Which models this provider may be asked for. Empty means none. */
  models: string[];
  /* What this provider is asked when a task does not name a model. There is
     no universal default: each provider carries its own, from configuration. */
  defaultModel: string;
  /* The ceiling written into every request, and the number the reservation is
     priced from. An answer cannot cost more than the ceiling it was sent with. */
  maximumOutputTokens: number;
  /* The most a packet may be worth sending, so a reservation can be priced
     before a request exists. */
  maximumInputTokens: number;
  requestTimeoutMs: number;
  /* What may be attached to one request, and what one piece of it may weigh.
     A ceiling that is reached refuses before submission: a request that is
     too big is not made smaller by sending it and finding out. */
  maximumMaterialBytes: number;
  maximumMaterialBytesPerItem: number;
  /* The media types this provider will be sent. Empty is not "anything";
     empty is "text only", and even that has to be listed. */
  supportedMediaTypes: string[];
  /* What each model can actually be asked to do, per model, from the
     operator. Nothing in this package infers a capability from a model's
     name: a request that would combine things a model cannot combine is
     refused before submission, with the combination named. */
  capabilities: Record<string, ModelCapabilities>;
};

/* Deliberately about the request, not about the provider: every one of these
   is something an adapter would otherwise put in a request and find out
   about from a 400. */
export type ModelCapabilities = {
  /* May the request insist on one specific tool or function being called? */
  forcedToolChoice: boolean;
  /* May a tool schema or an output schema be declared strict — the provider
     validating the answer against it rather than being asked nicely? */
  strictSchema: boolean;
  /* May images be attached at all? */
  images: boolean;
  /* What this model does about its own reasoning. "always_on" cannot be
     turned off and may not be combinable with everything else. */
  thinking: "none" | "optional" | "always_on";
};

/* Operator-supplied, with a date, because prices change and a run priced last
   year is not evidence about this one. Rates are per million tokens in the
   currency named. Nothing here is a default: an unpriced model cannot be
   reserved for, and therefore cannot be sent. */
export type ModelPrice = {
  providerId: string;
  model: string;
  /* ISO date. The price in force is the newest one not after the moment asked
     about. */
  effectiveFrom: string;
  currency: string;
  inputPerMillionTokens: number;
  outputPerMillionTokens: number;
  /* What a token served from a cache costs. Optional: without one, a cache
     read is priced at the full input rate, which is an upper bound. */
  cachedInputPerMillionTokens?: number;
  /* What WRITING a token into a cache costs. Optional, and its absence is
     not an upper bound — a cache write can cost more than ordinary input —
     so an attempt that wrote to a cache under a price that does not name
     this rate cannot be settled at all. */
  cacheWritePerMillionTokens?: number;
  /* What a reasoning token costs when a provider reports it separately from
     its visible output. Without one, reasoning is priced as output. */
  reasoningPerMillionTokens?: number;
};

/* All four, or nothing is sent. */
export type PaidCallAuthorization = {
  /* 1. The operator typed it on the command line. */
  providerNetworkFlag: boolean;
  /* 2. The environment says so too. */
  environmentGate: boolean;
  /* 3. A ceiling above zero. Zero authorises nothing, which is what every
        test and every ordinary command runs at. */
  maximumAuthorizedCost: number;
  currency: string;
  /* 4. Which providers and models this authorization covers. Empty is not
        "all"; empty is "none". */
  providerAllowlist: string[];
  modelAllowlist: string[];
};

export type RuntimeConfig = {
  providers: ProviderConfiguration[];
  pricing: ModelPrice[];
  authorization: PaidCallAuthorization;
  /* What this dispatcher calls itself in the outbox and in its events. */
  dispatcherName: string;
};

/* An authorization that permits nothing, which is what every command in this
   package starts from. */
export const NO_PAID_CALLS: PaidCallAuthorization = {
  providerNetworkFlag: false,
  environmentGate: false,
  maximumAuthorizedCost: 0,
  currency: "USD",
  providerAllowlist: [],
  modelAllowlist: [],
};

/* Why a paid call may not be made, in plain words, all of them at once rather
   than the first. An empty list means every gate is open — and even then, a
   transport that can reach a provider still has to have been injected. */
export function paidCallRefusals(config: RuntimeConfig, providerId?: string, model?: string): string[] {
  const a = config.authorization;
  const refusals: string[] = [];
  if (!a.providerNetworkFlag) refusals.push("the run was not started with --allow-provider-network");
  if (!a.environmentGate) refusals.push("CORE_V2_ALLOW_PAID_CALLS is not set to true");
  if (!(a.maximumAuthorizedCost > 0)) refusals.push("no maximum authorised cost above zero was given");
  if (a.providerAllowlist.length === 0) refusals.push("no provider is on the authorised list");
  if (a.modelAllowlist.length === 0) refusals.push("no model is on the authorised list");
  if (providerId && a.providerAllowlist.length > 0 && !a.providerAllowlist.includes(providerId)) {
    refusals.push(`${providerId} is not on the authorised list of providers`);
  }
  if (model && a.modelAllowlist.length > 0 && !a.modelAllowlist.includes(model)) {
    refusals.push(`${model} is not on the authorised list of models`);
  }
  if (providerId) {
    const provider = config.providers.find((p) => p.providerId === providerId);
    if (!provider) refusals.push(`${providerId} is not configured`);
    else if (model && !provider.models.includes(model)) refusals.push(`${providerId} is not configured to be asked for ${model}`);
  }
  return refusals;
}

export function isPaidCallAuthorized(config: RuntimeConfig, providerId?: string, model?: string): boolean {
  return paidCallRefusals(config, providerId, model).length === 0;
}

/* What the operator says this model costs, at a moment. No price, no
   reservation; no reservation, nothing sent. */
export function priceFor(config: RuntimeConfig, providerId: string, model: string, at: Date = new Date(0)): ModelPrice | null {
  const when = at.getTime() === 0 ? null : at;
  const candidates = config.pricing
    .filter((p) => p.providerId === providerId && p.model === model)
    .filter((p) => (when === null ? true : new Date(p.effectiveFrom).getTime() <= when.getTime()))
    .sort((a, b) => new Date(a.effectiveFrom).getTime() - new Date(b.effectiveFrom).getTime());
  return candidates[candidates.length - 1] ?? null;
}

export type CostCeiling = {
  providerId: string;
  model: string;
  currency: string;
  maximumInputTokens: number;
  maximumOutputTokens: number;
  /* The most this attempt could possibly cost, priced from the ceilings it
     will be sent with. Never an expectation: the difference between the two
     is the money an optimistic engine spends without meaning to. */
  maximumCost: number;
  basis: ModelPrice;
};

/* The number the durable reservation is taken for. Both ceilings are priced
   at full rate; a cached or reasoning rate can only make the real cost lower,
   and a reservation that assumes the cheaper case is not a ceiling. */
export function costCeiling(config: RuntimeConfig, providerId: string, model: string, inputTokens: number, outputTokens: number, at?: Date): CostCeiling | null {
  const price = priceFor(config, providerId, model, at);
  if (!price) return null;
  const perMillion = (tokens: number, rate: number) => (tokens / 1_000_000) * rate;
  const maximumCost = round6(perMillion(inputTokens, price.inputPerMillionTokens) + perMillion(outputTokens, price.outputPerMillionTokens));
  return { providerId, model, currency: price.currency, maximumInputTokens: inputTokens, maximumOutputTokens: outputTokens, maximumCost, basis: price };
}

/* WHAT AN ATTEMPT REALLY COST IS NOT COMPUTED HERE ANY MORE.
   It used to be, by adding input, cached input, output and reasoning
   together — which double-counts every provider whose cached tokens are
   already inside its input count and whose reasoning tokens are already
   inside its output count, which is two of the three this package speaks to.
   What replaced it is budget/usage.ts, which normalises per provider first
   and prices the components afterwards, and budget/ledger.ts, which prices
   from the rates stored on the reservation rather than from this
   configuration as it stands now. */

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/* What a configuration must be before anything is built from it, whether or
   not money is involved: a run that would refuse at submission should refuse
   at assembly, where a person is still reading. */
export function configurationProblems(config: RuntimeConfig): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const p of config.providers) {
    if (!p.providerId) problems.push("a provider configuration has no id");
    if (seen.has(p.providerId)) problems.push(`${p.providerId} is configured twice`);
    seen.add(p.providerId);
    if (!p.baseUrl) problems.push(`${p.providerId} has no address`);
    if (!p.apiKeyEnvironmentVariable) problems.push(`${p.providerId} does not say which environment variable holds its key`);
    if (p.models.length === 0) problems.push(`${p.providerId} is configured with no model it may be asked for`);
    if (!p.defaultModel) problems.push(`${p.providerId} has no model to use when a task names none`);
    else if (!p.models.includes(p.defaultModel)) problems.push(`${p.providerId} would default to ${p.defaultModel}, which is not on its own list`);
    if (!(p.maximumOutputTokens > 0)) problems.push(`${p.providerId} has no output ceiling`);
    if (!(p.maximumInputTokens > 0)) problems.push(`${p.providerId} has no input ceiling`);
    if (!(p.requestTimeoutMs > 0)) problems.push(`${p.providerId} has no request timeout`);
    if (!(p.maximumMaterialBytes > 0)) problems.push(`${p.providerId} has no ceiling on how much material one request may carry`);
    if (!(p.maximumMaterialBytesPerItem > 0)) problems.push(`${p.providerId} has no ceiling on how much one piece of material may weigh`);
    if (p.maximumMaterialBytesPerItem > p.maximumMaterialBytes) problems.push(`${p.providerId} allows one piece of material to be larger than a whole request`);
    if (p.supportedMediaTypes.length === 0) problems.push(`${p.providerId} is configured to be sent no kind of material at all`);
    for (const model of p.models) {
      if (!p.capabilities[model]) problems.push(`${p.providerId} does not say what ${model} can be asked to do`);
    }
    for (const model of p.models) {
      if (!priceFor(config, p.providerId, model)) problems.push(`${p.providerId}/${model} has no price, so nothing can be reserved for it`);
    }
  }
  if (!config.dispatcherName) problems.push("the dispatcher has no name to claim work under");
  for (const price of config.pricing) {
    if (Number.isNaN(new Date(price.effectiveFrom).getTime())) problems.push(`a price for ${price.providerId}/${price.model} has no usable effective date`);
    if (price.inputPerMillionTokens < 0 || price.outputPerMillionTokens < 0) problems.push(`a price for ${price.providerId}/${price.model} is negative`);
  }
  return problems;
}
