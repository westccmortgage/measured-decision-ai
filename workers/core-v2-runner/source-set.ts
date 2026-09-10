/* WHICH MATERIAL BELONGS TO WHICH WORKFLOW, AND HOW A RUNNER KNOWS.
 *
 * The worst hour of the first paid canary was spent on a pass that held one
 * generation's fixture and advanced a different workflow with it. Material is
 * looked up by content hash; every generation has its own seed and therefore
 * its own hashes; so every task in the other workflow failed with "no
 * material came back", and a critic died of being handed the wrong sheets.
 * Nothing in the code was wrong about ITS OWN workflow. What was missing was
 * any way for a process to notice it was holding the wrong one.
 *
 * So this file makes the question answerable from the record alone:
 *
 *   · the source set a workflow was started over is named in that workflow's
 *     own `workflow_sources` rows, and the name carries the seed;
 *   · a runner rebuilds the material from the seed IT READ THERE, never from
 *     anything ambient;
 *   · and it then checks, hash by hash, that what it rebuilt is what the
 *     record says this workflow read. A mismatch is a refusal, not a warning:
 *     a runner holding the wrong material would produce exactly the canary's
 *     silent failure, and it is better to stop.
 *
 * V1 runs the one domain pack this repository has, whose sources are invented
 * from a seed. Material that lives in object storage is the next step and is
 * not pretended at here — a source whose uri this file does not recognise is
 * refused by name.
 */
import type { SourceDescriptor, SourceManifest } from "../core-v2/kernel/contracts.ts";
import { syntheticRecordSet } from "../core-v2/domains/synthetic-records/fixture.ts";

/* The scheme a synthetic source set is named under. The seed is IN the name
   on purpose: a workflow that cannot say what it read is a workflow no runner
   can safely continue. */
export const SYNTHETIC_SCHEME = "fixture://synthetic-records/seed=";

export type SyntheticShape = {
  seed: string;
  sources?: number;
  sheetsPerSource?: number;
  entriesPerTable?: number;
};

export const DEFAULT_SHAPE = { sources: 1, sheetsPerSource: 1, entriesPerTable: 3 };

export function syntheticSourceUri(seed: string, ordinal: number): string {
  return `${SYNTHETIC_SCHEME}${encodeURIComponent(seed)}/${ordinal}`;
}

/* The seed a source uri carries, or null when this is not a source set this
   runner knows how to rebuild. Null is an answer, not a failure. */
export function seedOfSourceUri(uri: string): string | null {
  if (!uri.startsWith(SYNTHETIC_SCHEME)) return null;
  const rest = uri.slice(SYNTHETIC_SCHEME.length);
  const slash = rest.indexOf("/");
  const encoded = slash === -1 ? rest : rest.slice(0, slash);
  if (!encoded) return null;
  try { return decodeURIComponent(encoded); } catch { return null; }
}

export type MaterialByHash = Map<string, { mediaKind: string; mimeType: string; bytes: Uint8Array }>;

export type SourceSet = {
  seed: string;
  manifest: SourceManifest;
  material: MaterialByHash;
};

/* One workflow's world, built from one seed. The uris are rewritten to carry
   the seed; nothing else about the fixture is touched, and in particular no
   content hash changes, because a hash is of the bytes and the bytes are the
   same bytes. */
export function syntheticSourceSet(shape: SyntheticShape, organizationId: string, workflowId?: string): SourceSet {
  const truth = syntheticRecordSet({
    seed: shape.seed,
    sources: shape.sources ?? DEFAULT_SHAPE.sources,
    sheetsPerSource: shape.sheetsPerSource ?? DEFAULT_SHAPE.sheetsPerSource,
    entriesPerTable: shape.entriesPerTable ?? DEFAULT_SHAPE.entriesPerTable,
    organizationId, workflowId,
  });
  const sources: SourceDescriptor[] = truth.manifest.sources.map((source) => ({
    ...source, uri: syntheticSourceUri(shape.seed, source.ordinal),
  }));
  return {
    seed: shape.seed,
    manifest: { ...truth.manifest, sources },
    material: truth.material as MaterialByHash,
  };
}

export class SourceSetUnreadable extends Error {
  readonly reasons: string[];
  constructor(workflowId: string, reasons: string[]) {
    super(`core-v2-runner: the material for workflow ${workflowId} cannot be rebuilt from its own record — ${reasons.join("; ")}`);
    this.name = "SourceSetUnreadable";
    this.reasons = reasons;
  }
}

/* What a runner does after claiming a workflow: rebuild that workflow's
   material from the workflow's own recorded sources, and prove it.
   `recorded` is what the record says: one row per source, in order.
   Throws rather than returning a half-right world — a runner that advanced a
   workflow with somebody else's sheets is the failure this exists to make
   impossible. */
export function sourceSetOfRecord(
  workflowId: string,
  organizationId: string,
  recorded: { ordinal: number; uri: string; contentHash: string }[],
): SourceSet {
  const reasons: string[] = [];
  if (recorded.length === 0) reasons.push("the record lists no sources at all");

  const seeds = new Set<string>();
  for (const source of recorded) {
    const seed = seedOfSourceUri(source.uri);
    if (seed === null) reasons.push(`source ${source.ordinal} is named ${describeUri(source.uri)}, which is not a source set this runner can rebuild`);
    else seeds.add(seed);
  }
  if (seeds.size > 1) reasons.push(`its sources name ${seeds.size} different source sets, and a workflow reads one`);
  if (reasons.length > 0) throw new SourceSetUnreadable(workflowId, reasons);

  const seed = [...seeds][0]!;
  const built = syntheticSourceSet({ seed, sources: recorded.length }, organizationId, workflowId);

  /* THE CHECK THAT WOULD HAVE CAUGHT THE CANARY'S WORST HOUR.
     Rebuilding from a seed is only as good as the seed being this workflow's,
     so the bytes are compared against what the record says this workflow
     actually read. */
  const byOrdinal = new Map(built.manifest.sources.map((source) => [source.ordinal, source]));
  for (const source of recorded) {
    const rebuilt = byOrdinal.get(source.ordinal);
    if (!rebuilt) { reasons.push(`the record has a source ${source.ordinal} that this seed does not produce`); continue; }
    if (rebuilt.contentHash !== source.contentHash) {
      reasons.push(`source ${source.ordinal} rebuilds to different bytes than the record says this workflow read`);
    }
  }
  if (built.manifest.sources.length !== recorded.length) {
    reasons.push(`the record lists ${recorded.length} sources and this seed produces ${built.manifest.sources.length}`);
  }
  if (reasons.length > 0) throw new SourceSetUnreadable(workflowId, reasons);
  return built;
}

/* A uri in an error message is a name, and a name may be somebody's. Only the
   scheme and its shape are said out loud. */
function describeUri(uri: string): string {
  const scheme = uri.indexOf("://");
  return scheme === -1 ? "a name with no scheme" : `${uri.slice(0, scheme)}://…`;
}
