/* A RESOLVER THAT ANSWERS FROM THIS PROCESS.
 *
 * Material is filed under the hash of its own bytes, which is how
 * content-addressed storage works and why a hash written into an assignment
 * can be checked against what comes back at all.
 *
 * This one holds everything in memory. It exists so that the runtime can be
 * exercised end to end without any storage service, any credential and any
 * network — and so that "the resolver returned the wrong thing" is a case a
 * test can actually create.
 *
 * It answers only what it is asked. Given three references it returns at most
 * three items, each tagged with the identity and the locator of the reference
 * it answers — never with an address it was stored under.
 */
import type { SourceReference } from "../../core-v2/kernel/contracts.ts";
import type { MaterialResolver, MediaKind, ResolvedMaterial } from "./material.ts";

export type StoredMaterial = {
  mediaKind: MediaKind;
  mimeType: string;
  bytes: Uint8Array;
  timeRange?: { startSeconds: number; endSeconds: number } | null;
};

export class InMemoryMaterialResolver implements MaterialResolver {
  readonly name = "in-memory";
  /* Every reference it was asked about, so a test can prove it was asked for
     what the packet authorised and nothing else. */
  readonly asked: SourceReference[] = [];
  private byHash: Map<string, StoredMaterial>;

  constructor(byHash: Map<string, StoredMaterial>) {
    this.byHash = byHash;
  }

  async resolve(sources: readonly SourceReference[]): Promise<ResolvedMaterial[]> {
    const out: ResolvedMaterial[] = [];
    for (const reference of sources) {
      this.asked.push(reference);
      const stored = this.byHash.get(reference.contentHash);
      /* Nothing under that hash is nothing to return. Saying so is the
         resolver's whole answer; what happens next is the caller's rule, and
         the caller refuses. */
      if (!stored) continue;
      out.push({
        sourceId: reference.sourceId,
        segmentId: reference.segmentId,
        mediaKind: stored.mediaKind,
        mimeType: stored.mimeType,
        contentHash: reference.contentHash,
        byteLength: stored.bytes.length,
        locator: reference.locator,
        content: stored.mediaKind === "text" || stored.mediaKind === "transcript"
          ? { text: Buffer.from(stored.bytes).toString("utf8") }
          : { bytes: stored.bytes },
        timeRange: stored.timeRange ?? null,
      });
    }
    return out;
  }
}
