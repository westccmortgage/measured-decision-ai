/* THE ONE GLOBAL THE EDGE RUNTIME DOES NOT HAND OUT.
 *
 * This module exists because of a measured failure, not a precaution. Run
 * 34340500490 deployed cleanly and then died 3ms after boot:
 *
 *     event loop error: ReferenceError: Buffer is not defined
 *       at uuidV5 (workers/core-v2/kernel/ids.ts:37)
 *       at ids.ts:48
 *
 * ids.ts computes CORE_V2_NAMESPACE at module scope, so the kernel's own
 * import graph calls Buffer.from before any handler exists. Deno provides
 * Buffer from node:buffer but does not put it on globalThis the way node
 * does, and fourteen files across the kernel and the runtime use the global
 * form. Rewriting all fourteen would be a change to the engine to suit its
 * host; installing the global is a change to the host to suit the engine,
 * which is the smaller and more honest of the two.
 *
 * WHY THIS IS ITS OWN FILE, AND WHY IT IS IMPORTED FIRST. A statement in
 * the entrypoint's body would be far too late: ES modules evaluate their
 * dependencies before their own body, so ids.ts would already have thrown.
 * Static imports are evaluated depth-first in source order, so an import of
 * this module written above the others runs first. The order of those two
 * lines is load-bearing — do not sort the imports.
 */
import { Buffer } from "node:buffer";

const host = globalThis as { Buffer?: unknown };
if (host.Buffer === undefined) host.Buffer = Buffer;

/* What was installed, for the report to state rather than assume. */
export const installedGlobals = {
  buffer: typeof (globalThis as { Buffer?: unknown }).Buffer === "function",
};
