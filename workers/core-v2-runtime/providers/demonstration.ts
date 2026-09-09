/* AN OPERATOR'S CONFIGURATION, INVENTED, FOR THE COMMANDS THAT RUN OFFLINE.
 *
 * A runtime is configured by an operator: which providers exist, where their
 * requests go, which environment variable holds each key, which models may
 * be asked, what each costs. This is such a configuration with every one of
 * those answers made up — addresses under .invalid, which resolves nowhere
 * by definition; the names of environment variables nobody has set; models
 * that exist in this file and in no catalogue anywhere.
 *
 * It lives in this directory because it is the only place in the package
 * where a provider may be named at all, and because naming providers is
 * exactly what a configuration does. The command line imports it, prints it,
 * and runs the adapters against a stand-in that answers from the same
 * process. Nothing here is anybody's real setup, and nothing built from it
 * can reach anybody: reaching somebody is the transport's business, and the
 * transport is chosen elsewhere.
 *
 * The routing is deliberate. Two blind lanes land on two different providers
 * and the third is left free, so a critic, a verifier and an arbiter can be
 * somewhere that produced nothing they are asked to judge. Three domains is
 * the fewest that allows a blind pair to be judged at all — and, as the
 * command line's own output shows, not always enough for an arbiter's
 * correction to be accepted by machine.
 */
import type { RuntimeConfig } from "../runtime-config.ts";
import { ANTHROPIC_PROVIDER_ID } from "./anthropic.ts";
import { GOOGLE_PROVIDER_ID } from "./google.ts";
import { OPENAI_PROVIDER_ID } from "./openai.ts";

const ALPHA = "alpha-reader-1";
const BETA = "beta-reader-1";
const GAMMA = "gamma-reader-1";

const CEILINGS = {
  maximumOutputTokens: 4096,
  maximumInputTokens: 60_000,
  requestTimeoutMs: 30_000,
  /* Bounded on purpose and small: a demonstration reads a segment, never a
     book. Anything larger refuses before submission. */
  maximumMaterialBytes: 512 * 1024,
  maximumMaterialBytesPerItem: 256 * 1024,
  supportedMediaTypes: ["text/plain; charset=utf-8", "text/plain", "image/png"],
};

/* What each invented model can be asked to do. An operator writes this; this
   package infers nothing from a model's name. */
const CAN_DO_EVERYTHING = { forcedToolChoice: true, strictSchema: true, images: true, thinking: "optional" as const };
/* A cache-write rate is not optional: a provider that creates a cache entry
   has billed for it whether or not this runtime can price it. Without one
   there is no ceiling, so nothing may be reserved for and nothing sent. */
const RATES = { effectiveFrom: "2026-01-01", currency: "USD", inputPerMillionTokens: 3, outputPerMillionTokens: 15, cacheWritePerMillionTokens: 3.75 };

export const DEMONSTRATION_CONFIG: RuntimeConfig = {
  providers: [
    { providerId: ANTHROPIC_PROVIDER_ID, baseUrl: "https://alpha.invalid", apiKeyEnvironmentVariable: "CORE_V2_DEMONSTRATION_KEY_ALPHA", models: [ALPHA], defaultModel: ALPHA, ...CEILINGS, capabilities: { [ALPHA]: CAN_DO_EVERYTHING } },
    { providerId: OPENAI_PROVIDER_ID, baseUrl: "https://beta.invalid", apiKeyEnvironmentVariable: "CORE_V2_DEMONSTRATION_KEY_BETA", models: [BETA], defaultModel: BETA, ...CEILINGS, capabilities: { [BETA]: CAN_DO_EVERYTHING } },
    { providerId: GOOGLE_PROVIDER_ID, baseUrl: "https://gamma.invalid", apiKeyEnvironmentVariable: "CORE_V2_DEMONSTRATION_KEY_GAMMA", models: [GAMMA], defaultModel: GAMMA, ...CEILINGS, capabilities: { [GAMMA]: CAN_DO_EVERYTHING } },
  ],
  pricing: [
    { providerId: ANTHROPIC_PROVIDER_ID, model: ALPHA, ...RATES },
    { providerId: OPENAI_PROVIDER_ID, model: BETA, ...RATES },
    { providerId: GOOGLE_PROVIDER_ID, model: GAMMA, ...RATES },
  ],
  /* Opened for the local stand-in, and only here: an adapter checks these
     gates before it builds a request, so a run whose answers come from a
     fixture still has to pass them. None of this opens a socket. A run that
     would really spend money is a different command, and it refuses. */
  authorization: {
    providerNetworkFlag: true,
    environmentGate: true,
    maximumAuthorizedCost: 10,
    currency: "USD",
    providerAllowlist: [ANTHROPIC_PROVIDER_ID, OPENAI_PROVIDER_ID, GOOGLE_PROVIDER_ID],
    modelAllowlist: [ALPHA, BETA, GAMMA],
  },
  dispatcherName: "core-v2-runtime-cli",
};

/* Six abstract families onto three providers. */
export const DEMONSTRATION_ROUTING: Record<string, string> = {
  "reader-family-one": ANTHROPIC_PROVIDER_ID,
  "reader-family-two": OPENAI_PROVIDER_ID,
  "reader-family-three": GOOGLE_PROVIDER_ID,
  "critic-family-one": GOOGLE_PROVIDER_ID,
  "critic-family-two": ANTHROPIC_PROVIDER_ID,
  "arbiter-family-one": GOOGLE_PROVIDER_ID,
};

/* Not a credential. A string invented here, handed to the adapters in place
   of an environment, so that no key of anybody's is read to run a
   demonstration — not even to check whether one exists. */
export const NOT_A_CREDENTIAL = "local-stand-in-not-a-credential";

export const DEMONSTRATION_ENVIRONMENT: Record<string, string> = Object.fromEntries(
  DEMONSTRATION_CONFIG.providers.map((p) => [p.apiKeyEnvironmentVariable, NOT_A_CREDENTIAL]),
);
