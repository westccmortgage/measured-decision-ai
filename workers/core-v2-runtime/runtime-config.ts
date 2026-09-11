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
  /* What WRITING a token into a cache costs. REQUIRED, and the one optional
     rate that was ever anything else. A cache write can cost more than
     ordinary input, and a price that does not name this rate leaves a charge
     the provider can make and this runtime cannot bound — refusing to settle
     it protects the arithmetic and not the money. Without it there is no
     ceiling, so there is no reservation, so nothing is sent. */
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

/* ─────────────────── WHAT THE AUTHORIZATION ACTUALLY COVERS, EXACTLY

   The four gates say a paid call is permitted at all. They do NOT say where
   one may go, and reading them as if they did is how a run that authorised
   one provider reaches a different one that merely happens to be configured.
   Being on an allowlist is not enough either: a name on a list that matches
   nothing, or matches something with no price, authorises nothing and must be
   refused rather than quietly skipped, because a list that silently drops its
   unusable entries is a list nobody can read.

   An endpoint is authorised only when every one of these is true at once:

     · the provider is configured;
     · the provider is named in providerAllowlist;
     · at least one of its configured models is named in modelAllowlist;
     · that provider/model pair is priced;
     · the price is in the currency the authorisation is written in;
     · the price establishes an upper bound, so a reservation can be taken;
     · the authorised amount is above zero.

   Everything else is unauthorised, however thoroughly it is configured. */

/* WHETHER THIS DEPLOYMENT HOLDS A KEY FOR EVERY PROVIDER IT DECLARES.
 *
 * Answers yes or no, and that is deliberately all. It never returns a
 * variable name and never returns a value — which is what lets a door report
 * that it is ready without naming, or even being ABLE to name, anything
 * worth stealing. The rule this serves is enforced by reading the doors as
 * text: a door that writes such a name down fails the suite whether or not
 * it ever reads one, so the question has to be asked from here, where the
 * configuration already says which variable holds which provider's key.
 *
 * A declaration with no providers is not ready. Saying "yes, all nought of
 * them" would be true and useless. */
export function everyDeclaredKeyIsPresent(
  config: RuntimeConfig,
  environment: (name: string) => string | undefined,
): boolean {
  if (config.providers.length === 0) return false;
  return config.providers.every((provider) =>
    Boolean(environment(provider.apiKeyEnvironmentVariable)));
}

export type AuthorizedProvider = { providerId: string; models: string[] };

/* The providers this authorisation actually covers, and the models of each
   that it covers. Empty when nothing is authorised — which is the ordinary
   case and the one every command in this package runs in. */
export function authorizedProviders(config: RuntimeConfig): AuthorizedProvider[] {
  const a = config.authorization;
  if (!a.providerNetworkFlag || !a.environmentGate || !(a.maximumAuthorizedCost > 0)) return [];
  const covered: AuthorizedProvider[] = [];
  for (const provider of config.providers) {
    if (!a.providerAllowlist.includes(provider.providerId)) continue;
    const models = provider.models.filter((model) => a.modelAllowlist.includes(model))
      .filter((model) => {
        const price = priceFor(config, provider.providerId, model);
        if (!price) return false;
        if (price.currency.toUpperCase() !== a.currency.toUpperCase()) return false;
        return costCeiling(config, provider.providerId, model, provider.maximumInputTokens, provider.maximumOutputTokens) !== null;
      });
    if (models.length > 0) covered.push({ providerId: provider.providerId, models });
  }
  return covered;
}

/* Every reason this run may not open a door to anybody, at once. The four
   gates first, then every way an allowlist can name something it cannot
   authorise. An empty list means at least one endpoint is genuinely
   authorised AND no entry on either list is unusable. */
export function networkAuthorizationProblems(config: RuntimeConfig): string[] {
  const a = config.authorization;
  const problems = paidCallRefusals(config);
  /* A name on a list that matches nothing is a refusal, not a no-op. */
  for (const providerId of a.providerAllowlist) {
    const provider = config.providers.find((p) => p.providerId === providerId);
    if (!provider) {
      problems.push(`${providerId} is on the authorised list of providers and is not configured at all`);
      continue;
    }
    const named = provider.models.filter((model) => a.modelAllowlist.includes(model));
    if (named.length === 0) {
      problems.push(`${providerId} is authorised and not one of the models it is configured for is on the authorised list`);
      continue;
    }
    for (const model of named) {
      const price = priceFor(config, providerId, model);
      if (!price) {
        problems.push(`${providerId}/${model} is authorised and has no price, so nothing could be reserved for it`);
        continue;
      }
      if (price.currency.toUpperCase() !== a.currency.toUpperCase()) {
        problems.push(`${providerId}/${model} is priced in ${price.currency} and this run is authorised in ${a.currency}`);
        continue;
      }
      const rates = ceilingRates(price);
      if (rates.problems.length > 0) problems.push(...rates.problems);
      else if (costCeiling(config, providerId, model, provider.maximumInputTokens, provider.maximumOutputTokens) === null) {
        problems.push(`${providerId}/${model} is authorised and the most it could cost cannot be worked out, so nothing could be reserved for it`);
      }
    }
  }
  /* And a model nobody authorised a provider for. */
  for (const model of a.modelAllowlist) {
    const served = config.providers.some((p) => a.providerAllowlist.includes(p.providerId) && p.models.includes(model));
    if (!served) problems.push(`${model} is on the authorised list of models and no authorised provider is configured to be asked for it`);
  }
  if (problems.length === 0 && authorizedProviders(config).length === 0) {
    problems.push("this authorisation covers no configured provider at all");
  }
  return problems;
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

/* WHAT "THE MOST IT COULD COST" ACTUALLY MEANS.
 *
 * A token ceiling is a ceiling on a CATEGORY, not on one rate. The configured
 * input ceiling bounds every billable input component added together —
 * uncached input, tokens read from a cache, tokens written to one — and the
 * output ceiling bounds visible output and reasoning output added together.
 * Which is why pricing the input ceiling at the ordinary input rate is not a
 * maximum: a cache write can cost more than ordinary input, and reasoning can
 * cost more than visible output, so the same number of tokens can cost more
 * than the reservation held for them.
 *
 * The upper bound is therefore the ceiling of each category priced at the
 * HIGHEST rate any component of that category could be charged at:
 *
 *   input  → max(input, cache read, cache write)
 *   output → max(visible output, reasoning)
 *
 * THE RULE FOR A RATE THE OPERATOR DID NOT RECORD is not "what would be
 * convenient". It is: EVERY COMPONENT THE PROVIDER REQUEST CAN PRODUCE MUST
 * HAVE A RATE THAT SETTLEMENT WILL ACTUALLY APPLY. Two of the optional rates
 * pass that test and one does not:
 *
 *   · a missing cache-read rate is charged at the full input rate — a rate
 *     settlement really applies, and one already inside the input ceiling;
 *   · a missing reasoning rate is charged as output — likewise;
 *   · a missing CACHE-WRITE rate is charged at nothing at all, because
 *     priceUsage refuses the settlement outright. That is not a bound.
 *
 * The last one was wrong here until this revision, and the reasoning behind it
 * was invalid in a way worth writing down: OUR REFUSAL TO PRICE A CHARGE DOES
 * NOT PREVENT THE CHARGE. A provider that creates a cache entry has already
 * billed the account by the time our database declines to work out what the
 * returned usage cost. A settlement that refuses protects the ledger's
 * arithmetic; it protects nothing about the money. So a component we cannot
 * price is not a component that cannot cost anything — it is precisely the
 * component we must refuse to submit for.
 *
 * A cache-write rate is therefore MANDATORY. Nothing in this runtime can
 * mechanically prove that a given provider request cannot produce cache-write
 * usage: no adapter asks for caching, but implicit and automatic caching is a
 * provider-side behaviour, and what a provider does when nobody asks is
 * exactly the class of fact this package refuses to assert without a canary.
 * Without the rate: no ceiling, no reservation, no submission, no key read.
 *
 * (The narrower alternative — permitting the rate to be absent when the built
 * request mechanically cannot create a cache entry — is deliberately NOT
 * taken. It would have to rest on a claim about provider behaviour that only
 * an authorised paid canary can establish, and an unproved claim is how the
 * first version of this comment came to be wrong.)
 *
 * Every component mixture that fits inside the two token ceilings therefore
 * has a rate, is priced, and costs at most this number. tests/billing.mjs
 * proves that by exhausting the mixtures — and by asserting that it skipped
 * none of them.
 */
export const CEILING_RULE = "core-v2.ceiling.1";

export type CostCeiling = {
  providerId: string;
  model: string;
  currency: string;
  maximumInputTokens: number;
  maximumOutputTokens: number;
  /* The rates the ceiling was worked out at: the highest any billable
     component of that category could be charged at under this price. Stored,
     so the reservation can be reproduced without re-deriving it. */
  ceilingInputPerMillionTokens: number;
  ceilingOutputPerMillionTokens: number;
  rule: string;
  /* The most this attempt could possibly cost, priced from the ceilings it
     will be sent with. Never an expectation: the difference between the two
     is the money an optimistic engine spends without meaning to. */
  maximumCost: number;
  basis: ModelPrice;
};

/* The highest rate each category could be charged at, or the reasons this
   price establishes no upper bound at all. A price with no upper bound is not
   a cheap price: it is a price nothing can be reserved under, and nothing
   that cannot be reserved for is sent. */
export function ceilingRates(price: ModelPrice): { input: number; output: number; problems: string[] } {
  const problems: string[] = [];
  const rate = (value: number | null | undefined, what: string, required: boolean): number | null => {
    if (value === undefined || value === null) {
      if (required) problems.push(`${price.providerId}/${price.model} records no ${what}`);
      return null;
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      problems.push(`the ${what} recorded for ${price.providerId}/${price.model} is not a rate a ceiling can be worked out from`);
      return null;
    }
    return value;
  };
  const input = rate(price.inputPerMillionTokens, "input rate", true);
  const output = rate(price.outputPerMillionTokens, "output rate", true);
  const cachedRead = rate(price.cachedInputPerMillionTokens, "cached-input rate", false);
  /* REQUIRED. Absent, a cache write is charged by the provider and priced by
     nobody: priceUsage refuses the settlement, which bounds our arithmetic and
     not the account. There is no upper bound to fall back on, so there is no
     reservation to take and nothing may be sent. */
  const cacheWrite = rate(price.cacheWritePerMillionTokens, "cache-write rate", true);
  const reasoning = rate(price.reasoningPerMillionTokens, "reasoning rate", false);
  if (input === null || output === null) return { input: 0, output: 0, problems };
  if (cacheWrite === null) return { input: 0, output: 0, problems };
  return {
    /* A missing cache-read rate is charged at the input rate, so it folds in
       as the input rate rather than as an unknown. A cache-write rate is never
       missing by the line above. */
    input: Math.max(input, cachedRead ?? input, cacheWrite),
    output: Math.max(output, reasoning ?? output),
    problems,
  };
}

/* The number the durable reservation is taken for: each token ceiling at the
   highest rate any component of its category could be charged at. Null when
   the operator prices nothing for this model, or prices it in a way that
   establishes no upper bound — no ceiling, no reservation; no reservation,
   nothing sent. */
export function costCeiling(config: RuntimeConfig, providerId: string, model: string, inputTokens: number, outputTokens: number, at?: Date): CostCeiling | null {
  const price = priceFor(config, providerId, model, at);
  if (!price) return null;
  if (!countable(inputTokens) || !countable(outputTokens)) return null;
  const rates = ceilingRates(price);
  if (rates.problems.length > 0) return null;
  const perMillion = (tokens: number, rate: number) => (tokens / 1_000_000) * rate;
  const maximumCost = round6(perMillion(inputTokens, rates.input) + perMillion(outputTokens, rates.output));
  return {
    providerId, model, currency: price.currency,
    maximumInputTokens: inputTokens, maximumOutputTokens: outputTokens,
    ceilingInputPerMillionTokens: rates.input, ceilingOutputPerMillionTokens: rates.output,
    rule: CEILING_RULE, maximumCost, basis: price,
  };
}

const countable = (n: number): boolean => Number.isFinite(n) && n >= 0 && Math.trunc(n) === n;

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
      const price = priceFor(config, p.providerId, model);
      if (!price) { problems.push(`${p.providerId}/${model} has no price, so nothing can be reserved for it`); continue; }
      /* A price that establishes no upper bound is refused here, where a
         person is still reading, rather than at the moment of a reservation
         that would otherwise be taken below the worst case. */
      problems.push(...ceilingRates(price).problems);
      if (costCeiling(config, p.providerId, model, p.maximumInputTokens, p.maximumOutputTokens) === null) {
        problems.push(`the most ${p.providerId}/${model} could cost cannot be worked out from its price and its ceilings, so nothing can be reserved for it`);
      }
    }
  }
  if (!config.dispatcherName) problems.push("the dispatcher has no name to claim work under");
  for (const price of config.pricing) {
    if (Number.isNaN(new Date(price.effectiveFrom).getTime())) problems.push(`a price for ${price.providerId}/${price.model} has no usable effective date`);
    if (price.inputPerMillionTokens < 0 || price.outputPerMillionTokens < 0) problems.push(`a price for ${price.providerId}/${price.model} is negative`);
  }
  return problems;
}
