/* THE REGISTRY THIS FILE REFUSES TO WRITE.
 *
 * A paid run needs facts nobody in this repository is entitled to invent:
 * which models exist, where their requests go, what each one is capable of,
 * and what each one costs per million tokens — including what it costs to
 * WRITE a cache entry, which is the rate the ceiling is built on and the one
 * a provider can charge whether or not this runtime can price it.
 *
 * Those are an operator's facts. This file reads them from a declaration the
 * operator writes and signs their name to, validates every one of them, and
 * refuses — with all the reasons at once, not the first — if anything is
 * missing, shaped wrong, or looks like the invented demonstration. It
 * contains no model id, no address, no capability and no price, and it never
 * supplies a default for any of them: a field that is absent is a refusal,
 * not a zero.
 *
 * The declaration also names the key VARIABLES, never the keys. Nothing here
 * reads an environment.
 */
import type { ModelCapabilities, ModelPrice, ProviderConfiguration, RuntimeConfig } from "../core-v2-runtime/runtime-config.ts";
import { ceilingRates, configurationProblems, costCeiling, NO_PAID_CALLS } from "../core-v2-runtime/runtime-config.ts";
import { knownProviderIds } from "../core-v2-runtime/providers/registry.ts";

/* The canary's immutable identity. Every row it writes hangs off this, and a
   second run under the same name is refused rather than repeated. */
export const CANARY_ID = "core-v2-canary-1";
/* The whole of the authority, in the currency it is stated in. Not a
   default, not a ceiling to be raised: the number a person authorised. */
export const CANARY_AUTHORIZED = 5;
export const CANARY_CURRENCY = "USD";
/* Submissions for the entire canary, ever. */
export const CANARY_MAXIMUM_SUBMISSIONS = 4;

/* Addresses that resolve nowhere by standard, and the demonstration's own
   variable names. A declaration carrying either is the invented one wearing
   a different hat, and is refused. */
const RESERVED_SUFFIXES = [".invalid", ".test", ".example", ".localhost"];
const DEMONSTRATION_VARIABLES = /^CORE_V2_DEMONSTRATION_KEY_/;

export type RoleAssignment = { readerA: string; readerB: string; critic: string };

export type OperatorRegistry = {
  config: RuntimeConfig;
  routing: Record<string, string>;
  roles: RoleAssignment;
  declaredBy: string;
  declaredAt: string;
};

export type LoadResult = { registry: OperatorRegistry | null; problems: string[] };

const THINKING = ["none", "optional", "always_on"];

function positive(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isIsoDate(value: unknown): boolean {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

function capabilityProblems(where: string, value: unknown): string[] {
  const problems: string[] = [];
  const c = value as Partial<ModelCapabilities> | undefined;
  if (!c || typeof c !== "object") return [`${where}: no capabilities declared — this runtime infers none from a model's name`];
  for (const flag of ["forcedToolChoice", "strictSchema", "images"]) {
    if (typeof (c as Record<string, unknown>)[flag] !== "boolean") problems.push(`${where}: ${flag} must be declared true or false`);
  }
  if (typeof c.thinking !== "string" || !THINKING.includes(c.thinking)) {
    problems.push(`${where}: thinking must be one of ${THINKING.join(", ")}`);
  }
  return problems;
}

function providerProblems(index: number, value: unknown, known: string[]): string[] {
  const problems: string[] = [];
  const p = value as Partial<ProviderConfiguration> | undefined;
  const where = `provider ${index + 1}`;
  if (!p || typeof p !== "object") return [`${where}: not an object`];
  const id = typeof p.providerId === "string" ? p.providerId : "";
  if (!id) problems.push(`${where}: no providerId`);
  else if (!known.includes(id)) problems.push(`${where}: no adapter in this repository speaks to "${id}" — known ids are ${known.join(", ")}`);

  if (typeof p.baseUrl !== "string" || p.baseUrl === "") problems.push(`${where}: no baseUrl`);
  else {
    let url: URL | null = null;
    try { url = new URL(p.baseUrl); } catch { problems.push(`${where}: baseUrl "${p.baseUrl}" is not a url`); }
    if (url) {
      if (url.protocol !== "https:") problems.push(`${where}: baseUrl must be https, not ${url.protocol.replace(":", "")}`);
      const host = url.hostname.toLowerCase();
      if (RESERVED_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
        problems.push(`${where}: baseUrl host "${host}" is a reserved name that resolves nowhere — this is the invented configuration, not a provider`);
      }
    }
  }

  const variable = typeof p.apiKeyEnvironmentVariable === "string" ? p.apiKeyEnvironmentVariable : "";
  if (!variable) problems.push(`${where}: does not say which environment variable holds its key`);
  else if (DEMONSTRATION_VARIABLES.test(variable)) problems.push(`${where}: ${variable} is the demonstration's variable, which holds no key`);

  const models = Array.isArray(p.models) ? p.models.filter((m): m is string => typeof m === "string" && m !== "") : [];
  if (models.length === 0) problems.push(`${where}: no models declared`);
  if (typeof p.defaultModel !== "string" || !models.includes(p.defaultModel)) {
    problems.push(`${where}: defaultModel must be one of the declared models`);
  }
  for (const [field, value_] of Object.entries({
    maximumOutputTokens: p.maximumOutputTokens,
    maximumInputTokens: p.maximumInputTokens,
    requestTimeoutMs: p.requestTimeoutMs,
    maximumMaterialBytes: p.maximumMaterialBytes,
    maximumMaterialBytesPerItem: p.maximumMaterialBytesPerItem,
  })) {
    if (!positive(value_)) problems.push(`${where}: ${field} must be a number above zero — this canary states its limits, it does not inherit them`);
  }
  if (!Array.isArray(p.supportedMediaTypes) || p.supportedMediaTypes.length === 0) {
    problems.push(`${where}: supportedMediaTypes is empty — empty is not "anything"`);
  }
  for (const model of models) problems.push(...capabilityProblems(`${where} model ${model}`, p.capabilities?.[model]));
  return problems;
}

function priceProblems(index: number, value: unknown): string[] {
  const problems: string[] = [];
  const price = value as Partial<ModelPrice> | undefined;
  const where = `price ${index + 1}`;
  if (!price || typeof price !== "object") return [`${where}: not an object`];
  if (typeof price.providerId !== "string" || !price.providerId) problems.push(`${where}: no providerId`);
  if (typeof price.model !== "string" || !price.model) problems.push(`${where}: no model`);
  if (!isIsoDate(price.effectiveFrom)) problems.push(`${where}: effectiveFrom must be an ISO date — a price without a date is not evidence about this run`);
  if (price.currency !== CANARY_CURRENCY) problems.push(`${where}: currency must be ${CANARY_CURRENCY}, the currency the authority is stated in`);
  if (!positive(price.inputPerMillionTokens)) problems.push(`${where}: inputPerMillionTokens missing`);
  if (!positive(price.outputPerMillionTokens)) problems.push(`${where}: outputPerMillionTokens missing`);
  if (!positive(price.cacheWritePerMillionTokens)) {
    problems.push(`${where}: cacheWritePerMillionTokens missing — a provider that writes a cache entry has billed for it, so without this rate there is no ceiling, no reservation and nothing may be sent`);
  }
  return problems;
}

/* Reads a declaration and either returns a registry every gate in this
   package accepts, or every reason it does not. Never both. */
export function loadOperatorRegistry(text: string, source: string): LoadResult {
  let declaration: Record<string, unknown>;
  try {
    declaration = JSON.parse(text) as Record<string, unknown>;
  } catch (error) {
    return { registry: null, problems: [`${source}: not valid json — ${(error as Error).message}`] };
  }

  const problems: string[] = [];
  const declaredBy = typeof declaration.declaredBy === "string" ? declaration.declaredBy.trim() : "";
  const declaredAt = typeof declaration.declaredAt === "string" ? declaration.declaredAt : "";
  if (!declaredBy) problems.push("declaredBy: the person stating these models, capabilities and prices must be named — they are that person's facts, not this program's");
  if (!isIsoDate(declaredAt)) problems.push("declaredAt: an ISO date saying when these prices were read from the operator's own account");

  const known = knownProviderIds();
  const declaredProviders = Array.isArray(declaration.providers) ? declaration.providers : [];
  if (declaredProviders.length !== 3) {
    problems.push(`providers: this canary needs exactly three, one per independence domain; ${declaredProviders.length} declared`);
  }
  declaredProviders.forEach((p, i) => problems.push(...providerProblems(i, p, known)));
  const ids = declaredProviders.map((p) => (p as ProviderConfiguration)?.providerId).filter((id) => typeof id === "string");
  if (new Set(ids).size !== ids.length) problems.push("providers: two entries share a providerId — two models behind one provider is one opinion, not two");

  const declaredPrices = Array.isArray(declaration.pricing) ? declaration.pricing : [];
  declaredPrices.forEach((p, i) => problems.push(...priceProblems(i, p)));

  const roles = declaration.roles as Partial<RoleAssignment> | undefined;
  for (const role of ["readerA", "readerB", "critic"] as const) {
    const named = roles?.[role];
    if (typeof named !== "string" || !ids.includes(named)) problems.push(`roles.${role}: must name one of the declared providers`);
  }
  if (roles?.readerA && roles.readerA === roles.readerB) {
    problems.push("roles: the two readers must be different providers, or the second reading is the first one repeated");
  }

  const routing = declaration.routing as Record<string, unknown> | undefined;
  const routed: Record<string, string> = {};
  if (!routing || typeof routing !== "object" || Object.keys(routing).length === 0) {
    problems.push("routing: which abstract family goes to which provider must be stated — this program does not choose");
  } else {
    for (const [family, providerId] of Object.entries(routing)) {
      if (typeof providerId !== "string" || !ids.includes(providerId)) problems.push(`routing.${family}: does not name a declared provider`);
      else routed[family] = providerId;
    }
  }

  /* Every model named in a price must be a model some provider declared, and
     every declared model must be priced. An unpriced model cannot be
     reserved for and so cannot be sent. */
  const declaredPairs = new Set<string>();
  for (const p of declaredProviders as ProviderConfiguration[]) {
    for (const model of Array.isArray(p?.models) ? p.models : []) declaredPairs.add(`${p.providerId}/${model}`);
  }
  const pricedPairs = new Set((declaredPrices as ModelPrice[]).map((p) => `${p?.providerId}/${p?.model}`));
  for (const pair of declaredPairs) if (!pricedPairs.has(pair)) problems.push(`pricing: ${pair} is declared but has no price`);
  for (const pair of pricedPairs) if (!declaredPairs.has(pair)) problems.push(`pricing: ${pair} is priced but no provider declares it`);

  if (problems.length > 0) return { registry: null, problems };

  const config: RuntimeConfig = {
    providers: declaredProviders as ProviderConfiguration[],
    pricing: declaredPrices as ModelPrice[],
    /* Shut. The runner opens these one at a time, from things a person did,
       and never from this file. */
    authorization: NO_PAID_CALLS,
    dispatcherName: CANARY_ID,
  };

  /* The package's own checks, last, so an operator sees their own mistakes
     first and the runtime's afterwards. */
  problems.push(...configurationProblems(config));
  for (const price of config.pricing) {
    const rates = ceilingRates(price);
    for (const problem of rates.problems) problems.push(`pricing ${price.providerId}/${price.model}: ${problem}`);
  }
  if (problems.length > 0) return { registry: null, problems };

  return {
    registry: {
      config,
      routing: routed,
      roles: roles as RoleAssignment,
      declaredBy,
      declaredAt,
    },
    problems: [],
  };
}

/* The names of the two gates. Their NAMES live here; nothing in this module
   ever reads a provider key. */
export const PAID_CALLS_VARIABLE = "CORE_V2_ALLOW_PAID_CALLS";
export const ORGANIZATION_VARIABLE = "CORE_V2_CANARY_ORGANIZATION";

/* What a person did, whatever program is asking: a flag they typed, and an
   environment somebody set. */
export type CanaryGates = { networkFlag: boolean; environment: Record<string, string | undefined> };

/* ───────────────────────────────────────────────── what a canary could cost */

export type WorstCase = {
  perAttempt: number;
  wholeCanary: number;
  fits: boolean;
  detail: { providerId: string; model: string; maximumCost: number }[];
  problems: string[];
};

/* The most a whole canary could cost: the dearest attempt any authorised
   provider and model could produce, taken as often as submissions are
   permitted. Not an expectation — the expectation is what an optimistic
   engine spends by accident. */
export function worstCase(config: RuntimeConfig, at: Date = new Date()): WorstCase {
  const detail: { providerId: string; model: string; maximumCost: number }[] = [];
  const problems: string[] = [];
  for (const provider of config.providers) {
    for (const model of provider.models) {
      const ceiling = costCeiling(config, provider.providerId, model, provider.maximumInputTokens, provider.maximumOutputTokens, at);
      if (!ceiling) {
        problems.push(`${provider.providerId}/${model}: no ceiling can be established, so no reservation can be taken and nothing may be sent`);
        continue;
      }
      if (ceiling.currency !== CANARY_CURRENCY) {
        problems.push(`${provider.providerId}/${model}: priced in ${ceiling.currency}, and the authority is stated in ${CANARY_CURRENCY}`);
      }
      detail.push({ providerId: provider.providerId, model, maximumCost: ceiling.maximumCost });
    }
  }
  const perAttempt = detail.reduce((most, one) => Math.max(most, one.maximumCost), 0);
  const wholeCanary = perAttempt * CANARY_MAXIMUM_SUBMISSIONS;
  return { perAttempt, wholeCanary, fits: problems.length === 0 && detail.length > 0 && wholeCanary <= CANARY_AUTHORIZED, detail, problems };
}

/* THE AUTHORIZATION, ASSEMBLED FROM THE FOUR THINGS A PERSON DID.
 *
 * The operator's declaration carries none of these: it says which models
 * exist and what they cost, and nothing about whether anybody may be paid.
 * The flag is on the command line, the gate is in the environment, the
 * amount is a constant nobody here can raise, and the two allowlists are
 * exactly what was declared — not a wildcard, and never wider than the
 * declaration. Exported because it is the thing worth checking. */
export function authorizedConfig(registry: OperatorRegistry, gates: CanaryGates): RuntimeConfig {
  return {
    ...registry.config,
    authorization: {
      providerNetworkFlag: gates.networkFlag === true,
      environmentGate: gates.environment[PAID_CALLS_VARIABLE] === "true",
      maximumAuthorizedCost: CANARY_AUTHORIZED,
      currency: CANARY_CURRENCY,
      providerAllowlist: registry.config.providers.map((p) => p.providerId),
      modelAllowlist: registry.config.providers.flatMap((p) => p.models),
    },
  };
}

