/* THE WORLD BUILDER, WITH THE EDGE RUNTIME'S TRANSPORT IN IT.
 *
 * Everything that decides anything lives in workers/core-v2-runner/world.ts,
 * where an offline suite can call the same function this function calls. The
 * only thing that cannot move there is the transport: a `fetch` that resolves
 * hosts against an allowlist belongs to the runtime it runs in.
 *
 * So this file is a factory and nothing else. If it ever grows a decision, the
 * decision is in the wrong file.
 */
import type { RuntimeConfig } from "../../../workers/core-v2-runtime/runtime-config.ts";
import { buildWorldFor as buildWorldWithTransport } from "../../../workers/core-v2-runner/world.ts";
import { DenoFetchTransport } from "../_shared/core-v2/deno-transport.ts";

export {
  AUTHORITY_VARIABLE, CONCURRENCY_VARIABLE, DEFAULT_CONCURRENT_ATTEMPTS, DEFAULT_MAXIMUM_ATTEMPTS,
  PAID_CALLS_VARIABLE, REGISTRY_VARIABLE, authorityFor, concurrencyFor, configuredFor,
  isProblem, operatorRegistry,
} from "../../../workers/core-v2-runner/world.ts";
export type { BuiltWorld, Gates, WorldProblem } from "../../../workers/core-v2-runner/world.ts";

export const denoTransport = (config: RuntimeConfig) => new DenoFetchTransport({ config });

export const buildWorldFor: typeof buildWorldWithTransport = (options) => buildWorldWithTransport(options);
