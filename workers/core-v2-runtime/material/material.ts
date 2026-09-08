/* WHAT THE AGENT IS ACTUALLY GIVEN TO READ, AND WHAT IS CHECKED BEFORE IT GOES.
 *
 * An assignment names material: a source, a segment, a locator, a hash. Those
 * are identities, not evidence. A model handed nothing but identities cannot
 * read anything, and a runtime that sends only identities has not proved that
 * an agent can read a source — it has proved that a stand-in can look an
 * answer up.
 *
 * So between the packet and the request there is one boundary: a resolver
 * turns the SourceReferences the packet already authorises into the bytes
 * they name. Everything about that boundary is deliberately narrow:
 *
 *   · a resolver is given references, never a query. It cannot widen scope,
 *     add a source, or decide that another segment is relevant;
 *   · what it returns is checked against what was asked for before anything
 *     is sent: one item per reference, the same source and segment, the same
 *     locator, the hash recomputed over the bytes, the type allowed, the size
 *     within the packet's and the provider's limits, and nothing extra;
 *   · what comes back carries bytes and identities and NOTHING ELSE. There is
 *     no field for a URL, a path, a bucket, a token or an expiry, so a
 *     storage address cannot reach a model by accident: it is not that we
 *     strip them, it is that there is nowhere to put one.
 *
 * The kernel knows none of this. It decides what may be read; this decides
 * what that means in bytes, and only for the runtime that sends them.
 */
import type { Locator, SourceReference } from "../../core-v2/kernel/contracts.ts";
import { canonical, sha256Bytes } from "../../core-v2/kernel/ids.ts";

/* The four kinds V1 carries. Each is bounded: one segment's worth, never a
   whole document because a task happened to name one page of it. */
export type MediaKind = "text" | "image" | "pdf_page_image" | "transcript";

export type MaterialContent =
  | { text: string }
  | { bytes: Uint8Array };

export type ResolvedMaterial = {
  sourceId: string;
  /* Null only when the assignment authorises a whole source. */
  segmentId: string | null;
  mediaKind: MediaKind;
  mimeType: string;
  /* sha-256 of the exact bytes, hex. The packet's own hash is compared with
     a hash this runtime recomputes; neither is taken on trust. */
  contentHash: string;
  byteLength: number;
  /* Copied from the reference the resolver was given. A resolver that
     returns a different one is returning different material. */
  locator: Locator;
  content: MaterialContent;
  /* Transcript material only: the range it covers, in seconds from the start
     of the recording. A transcript without its range is a quotation without
     a place, and the reader cannot anchor it. */
  timeRange?: { startSeconds: number; endSeconds: number } | null;
};

export interface MaterialResolver {
  /* The references, and only the references. */
  resolve(sources: readonly SourceReference[]): Promise<ResolvedMaterial[]>;
}

export type MaterialLimits = {
  maximumItems: number;
  maximumBytesPerItem: number;
  maximumBytesTotal: number;
  /* What this provider and this configuration will carry. Empty is not
     "anything"; empty is "nothing". */
  allowedMimeTypes: string[];
};

/* Which types each kind may claim to be. A kind is not a free label: it
   decides how an adapter puts the material on the wire, so it has to agree
   with the bytes. */
const TYPES_FOR_KIND: Record<MediaKind, RegExp> = {
  text: /^text\/(plain|markdown|csv)(;.*)?$/i,
  transcript: /^text\/(plain|vtt|markdown)(;.*)?$/i,
  image: /^image\/(png|jpeg|webp|gif)$/i,
  pdf_page_image: /^image\/(png|jpeg)$/i,
};

export function bytesOf(item: ResolvedMaterial): Uint8Array {
  return "bytes" in item.content ? item.content.bytes : new Uint8Array(Buffer.from(item.content.text, "utf8"));
}

export function isTextual(item: ResolvedMaterial): boolean {
  return item.mediaKind === "text" || item.mediaKind === "transcript";
}

export type MaterialVerdict =
  | { ok: true; material: ResolvedMaterial[]; totalBytes: number }
  | { ok: false; problems: string[] };

const keyOf = (sourceId: string, segmentId: string | null) => `${sourceId}|${segmentId ?? ""}`;

/* Everything that must be true before a single byte is sent. Every failure is
   a refusal before submission, never a request with something missing from
   it: an agent given four of five segments would answer confidently about a
   source it was only shown part of, and nothing downstream could tell. */
export function verifyResolvedMaterial(
  requested: readonly SourceReference[],
  resolved: readonly ResolvedMaterial[],
  limits: MaterialLimits,
): MaterialVerdict {
  const problems: string[] = [];
  const wanted = new Map(requested.map((r) => [keyOf(r.sourceId, r.segmentId), r]));
  const seen = new Set<string>();
  const kept: ResolvedMaterial[] = [];
  let totalBytes = 0;

  for (const item of resolved) {
    const key = keyOf(item.sourceId, item.segmentId);
    const reference = wanted.get(key);
    if (!reference) {
      problems.push(`material was returned for ${item.segmentId ?? item.sourceId}, which this assignment does not authorise`);
      continue;
    }
    if (seen.has(key)) {
      problems.push(`material for ${item.segmentId ?? item.sourceId} was returned twice`);
      continue;
    }
    seen.add(key);

    const bytes = bytesOf(item);
    const digest = sha256Bytes(bytes);
    if (digest !== item.contentHash) {
      problems.push(`the material returned for ${item.segmentId ?? item.sourceId} does not hash to what the resolver says it holds`);
      continue;
    }
    if (digest !== reference.contentHash) {
      problems.push(`the material returned for ${item.segmentId ?? item.sourceId} is not what this assignment names: the source has changed, or the wrong thing was fetched`);
      continue;
    }
    if (bytes.length !== item.byteLength) {
      problems.push(`the material for ${item.segmentId ?? item.sourceId} says it is ${item.byteLength} bytes and is ${bytes.length}`);
      continue;
    }
    if (bytes.length === 0) {
      problems.push(`the material for ${item.segmentId ?? item.sourceId} is empty`);
      continue;
    }
    if (canonical(item.locator) !== canonical(reference.locator)) {
      problems.push(`the material for ${item.segmentId ?? item.sourceId} covers a different place than the assignment authorises`);
      continue;
    }
    const allowed = TYPES_FOR_KIND[item.mediaKind];
    if (!allowed) {
      problems.push(`${item.mediaKind} is not a kind of material this runtime carries`);
      continue;
    }
    if (!allowed.test(item.mimeType)) {
      problems.push(`${item.mimeType} is not a ${item.mediaKind}`);
      continue;
    }
    if (!limits.allowedMimeTypes.some((type) => type.toLowerCase() === item.mimeType.toLowerCase())) {
      problems.push(`this provider is not configured to be sent ${item.mimeType}`);
      continue;
    }
    if (item.mediaKind === "transcript" && !item.timeRange) {
      problems.push(`the transcript for ${item.segmentId ?? item.sourceId} does not say what time range it covers`);
      continue;
    }
    if (bytes.length > limits.maximumBytesPerItem) {
      problems.push(`the material for ${item.segmentId ?? item.sourceId} is ${bytes.length} bytes, and at most ${limits.maximumBytesPerItem} may be sent for one piece`);
      continue;
    }
    totalBytes += bytes.length;
    kept.push(item);
  }

  for (const [key, reference] of wanted) {
    if (!seen.has(key)) problems.push(`no material came back for ${reference.segmentId ?? reference.sourceId}, which this assignment says must be read`);
  }
  if (kept.length > limits.maximumItems) {
    problems.push(`${kept.length} pieces of material were resolved and at most ${limits.maximumItems} may be sent`);
  }
  if (totalBytes > limits.maximumBytesTotal) {
    problems.push(`${totalBytes} bytes of material were resolved and at most ${limits.maximumBytesTotal} may be sent in one request`);
  }

  if (problems.length) return { ok: false, problems };
  /* In the order the assignment listed them, not the order they arrived. */
  const byKey = new Map(kept.map((item) => [keyOf(item.sourceId, item.segmentId), item]));
  return { ok: true, totalBytes, material: requested.map((r) => byKey.get(keyOf(r.sourceId, r.segmentId))!) };
}

/* What a person may be shown about material without being shown the material:
   identities, kinds and sizes. Used in events and in prompts. */
export function describeMaterial(item: ResolvedMaterial): string {
  const where = item.segmentId ? `segment ${item.segmentId}` : `source ${item.sourceId}`;
  return `${where}: ${item.mediaKind}, ${item.mimeType}, ${item.byteLength} bytes, sha-256 ${item.contentHash}`;
}
