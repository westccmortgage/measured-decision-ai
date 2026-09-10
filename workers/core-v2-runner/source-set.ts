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
 *     own `workflow_sources` rows, and the name carries the seed AND every
 *     other number the bytes came from;
 *   · a runner rebuilds the material from the shape IT READ THERE, never from
 *     anything ambient and never from a default;
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

/* The scheme a synthetic source set is named under. The WHOLE SHAPE is in the
   name on purpose, not only the seed.
   
   The first version of this file carried the seed alone, and a start that
   asked for two sheets and four rows produced a workflow whose material could
   only ever be rebuilt with one sheet and three rows. The rebuild then failed
   its own hash check — which is the guard working, but it made a perfectly
   legitimate request permanently unrunnable, and the reason lived nowhere in
   the record. A workflow that cannot say what it read is a workflow no runner
   can continue, and "what it read" is every parameter that decided the bytes,
   not just the one that was easiest to write down. */
export const SYNTHETIC_SCHEME = "fixture://synthetic-records/seed=";

export type SyntheticShape = {
  seed: string;
  sources?: number;
  sheetsPerSource?: number;
  entriesPerTable?: number;
};

export const DEFAULT_SHAPE = { sources: 1, sheetsPerSource: 1, entriesPerTable: 3 };

/* WHAT V1 WILL ACTUALLY RUN.
   Stated as numbers rather than discovered as a failure. A request outside
   these is refused at the door, before a workflow exists — an unrunnable row
   in the record is worse than a 400, because somebody has to go and find it. */
export const V1_LIMITS = {
  sources: { least: 1, most: 8 },
  sheetsPerSource: { least: 1, most: 8 },
  entriesPerTable: { least: 1, most: 16 },
  /* Comfortably inside DEFAULT_POLICY.maximumTasksPerWorkflow (2000). The
     estimate below is deliberately generous: refusing a shape that would have
     just fitted costs a caller one message; admitting one that does not fit
     costs them a workflow that dies half-planned. */
  estimatedTasks: 1200,
};

/* Roughly what a shape will admit: one ingest per source, one discovery per
   sheet, two blind readings per region, a note reading per sheet, and the
   comparisons, criticism and composition that follow. Over-counted on
   purpose. */
export function estimatedTasksOf(shape: Required<Omit<SyntheticShape, "seed">>): number {
  const sheets = shape.sources * shape.sheetsPerSource;
  const regions = sheets * 2;
  const subjects = sheets * shape.entriesPerTable;
  return shape.sources + sheets + regions * 2 + subjects * 3 + 8;
}

export type ShapeRefusal = { refused: string; field?: string };

export function isShapeRefusal(value: unknown): value is ShapeRefusal {
  return typeof value === "object" && value !== null && "refused" in (value as Record<string, unknown>);
}

/* The one place a shape is checked, used by the door before anything is
   written and by the rebuild before anything is advanced. */
export function checkShape(shape: SyntheticShape): Required<SyntheticShape> | ShapeRefusal {
  if (typeof shape.seed !== "string" || shape.seed.trim() === "") {
    return { refused: "a source set is named by a seed, and this one has none", field: "sourceSetSeed" };
  }
  const whole = (name: keyof typeof V1_LIMITS, value: number | undefined, fallback: number): number | ShapeRefusal => {
    const bound = V1_LIMITS[name] as { least: number; most: number };
    if (value === undefined) return fallback;
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      return { refused: `${name} must be a whole number and is ${String(value)}`, field: String(name) };
    }
    if (value < bound.least || value > bound.most) {
      return { refused: `${name} must be between ${bound.least} and ${bound.most} in V1, and is ${value}`, field: String(name) };
    }
    return value;
  };
  const sources = whole("sources", shape.sources, DEFAULT_SHAPE.sources);
  if (isShapeRefusal(sources)) return sources;
  const sheetsPerSource = whole("sheetsPerSource", shape.sheetsPerSource, DEFAULT_SHAPE.sheetsPerSource);
  if (isShapeRefusal(sheetsPerSource)) return sheetsPerSource;
  const entriesPerTable = whole("entriesPerTable", shape.entriesPerTable, DEFAULT_SHAPE.entriesPerTable);
  if (isShapeRefusal(entriesPerTable)) return entriesPerTable;

  const whole3 = { sources, sheetsPerSource, entriesPerTable };
  const tasks = estimatedTasksOf(whole3);
  if (tasks > V1_LIMITS.estimatedTasks) {
    return { refused: `that set would admit about ${tasks} tasks and V1 runs at most ${V1_LIMITS.estimatedTasks}`, field: "shape" };
  }
  return { seed: shape.seed.trim(), ...whole3 };
}

/* The name a source is filed under. Every number that decided the bytes is in
   it, so a later runner rebuilds the same bytes without being told anything. */
export function syntheticSourceUri(shape: Required<SyntheticShape>, ordinal: number): string {
  return `${SYNTHETIC_SCHEME}${encodeURIComponent(shape.seed)}`
    + `;sheets=${shape.sheetsPerSource};entries=${shape.entriesPerTable}/${ordinal}`;
}

/* The whole shape a source uri carries, or null when this is not a source set
   this runner knows how to rebuild. Null is an answer, not a failure.
   `sources` is not in the name because the record already says it: it is the
   number of rows. */
export function shapeOfSourceUri(uri: string): { seed: string; sheetsPerSource: number; entriesPerTable: number } | null {
  if (!uri.startsWith(SYNTHETIC_SCHEME)) return null;
  const rest = uri.slice(SYNTHETIC_SCHEME.length);
  const slash = rest.indexOf("/");
  const head = slash === -1 ? rest : rest.slice(0, slash);
  if (!head) return null;
  const parts = head.split(";");
  let seed: string;
  try { seed = decodeURIComponent(parts[0]); } catch { return null; }
  if (!seed) return null;
  const read = (key: string, fallback: number): number | null => {
    const found = parts.slice(1).find((part) => part.startsWith(`${key}=`));
    if (!found) return fallback;
    const n = Number(found.slice(key.length + 1));
    return Number.isInteger(n) && n >= 1 ? n : null;
  };
  const sheetsPerSource = read("sheets", DEFAULT_SHAPE.sheetsPerSource);
  const entriesPerTable = read("entries", DEFAULT_SHAPE.entriesPerTable);
  if (sheetsPerSource === null || entriesPerTable === null) return null;
  return { seed, sheetsPerSource, entriesPerTable };
}

/* Kept because a seed alone is what several callers want to say out loud. */
export function seedOfSourceUri(uri: string): string | null {
  return shapeOfSourceUri(uri)?.seed ?? null;
}

export type MaterialByHash = Map<string, { mediaKind: string; mimeType: string; bytes: Uint8Array }>;

export type SourceSet = {
  seed: string;
  /* Every number the bytes came from, as it will be written into the names. */
  shape: Required<SyntheticShape>;
  manifest: SourceManifest;
  material: MaterialByHash;
};

/* One workflow's world, built from one seed. The uris are rewritten to carry
   the seed; nothing else about the fixture is touched, and in particular no
   content hash changes, because a hash is of the bytes and the bytes are the
   same bytes. */
export function syntheticSourceSet(shape: SyntheticShape, organizationId: string, workflowId?: string): SourceSet {
  const whole: Required<SyntheticShape> = {
    seed: shape.seed,
    sources: shape.sources ?? DEFAULT_SHAPE.sources,
    sheetsPerSource: shape.sheetsPerSource ?? DEFAULT_SHAPE.sheetsPerSource,
    entriesPerTable: shape.entriesPerTable ?? DEFAULT_SHAPE.entriesPerTable,
  };
  const truth = syntheticRecordSet({ ...whole, organizationId, workflowId });
  const sources: SourceDescriptor[] = truth.manifest.sources.map((source) => ({
    ...source, uri: syntheticSourceUri(whole, source.ordinal),
  }));
  return {
    seed: whole.seed,
    shape: whole,
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

  /* THE WHOLE SHAPE, READ BACK OUT OF THE NAMES THE RECORD KEEPS.
     Not the defaults. A start that asked for two sheets and four rows is
     rebuilt with two sheets and four rows, or it is refused — and a refusal
     names what it could not read rather than quietly reading something else. */
  const shapes = new Set<string>();
  let shape: { seed: string; sheetsPerSource: number; entriesPerTable: number } | null = null;
  for (const source of recorded) {
    const read = shapeOfSourceUri(source.uri);
    if (read === null) reasons.push(`source ${source.ordinal} is named ${describeUri(source.uri)}, which is not a source set this runner can rebuild`);
    else { shapes.add(`${read.seed}\u0000${read.sheetsPerSource}\u0000${read.entriesPerTable}`); shape = read; }
  }
  if (shapes.size > 1) reasons.push(`its sources name ${shapes.size} different source sets, and a workflow reads one`);
  if (reasons.length > 0 || shape === null) throw new SourceSetUnreadable(workflowId, reasons.length ? reasons : ["its sources name no source set at all"]);

  const seed = shape.seed;
  const built = syntheticSourceSet({
    seed, sources: recorded.length,
    sheetsPerSource: shape.sheetsPerSource, entriesPerTable: shape.entriesPerTable,
  }, organizationId, workflowId);

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
