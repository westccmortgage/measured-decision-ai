/* Measured Decision · plan-set chunking, shared verbatim between runtimes.
 *
 * A 200-sheet project must never depend on one LLM context window. This
 * module is the deterministic half of chunked analysis: how a document set
 * partitions into chunks that each fit the provider's input limit, and how
 * the per-chunk readings merge back into one baseline proposal.
 *
 * Plain ESM JavaScript on purpose: the Deno edge function imports it to run
 * production, and the Node test suite imports the same file to prove it on a
 * 200-sheet fixture. One file, one behavior, no drift.
 *
 * The merge is honest about what chunking costs. A schedule in one chunk
 * cannot resolve a mark drawn in another; the merge never papers over that —
 * it records the chunking itself as an assumption, keeps every chunk's gaps,
 * and dedupes only by exact identity (a document id, a phase code, a
 * building|level|name key), never by similarity. Silently connecting
 * almost-matching rooms is the believable wrong this product refuses.
 */

export const CHUNK_BYTE_LIMIT = 49 * 1024 * 1024;

/* Greedy, order-preserving partition. Documents arrive in the owner's
   selection order — usually discipline order — and staying in order keeps a
   discipline's schedules in the same chunk as its plans whenever they fit.
   A single document over the limit is the caller's error to refuse; this
   function assumes each fits alone. */
export function planChunks(documents, byteLimit = CHUNK_BYTE_LIMIT) {
  const chunks = [];
  let current = { document_ids: [], bytes: 0 };
  for (const doc of documents) {
    const size = Number(doc.byte_size || 0);
    if (current.document_ids.length && current.bytes + size > byteLimit) {
      chunks.push(current);
      current = { document_ids: [], bytes: 0 };
    }
    current.document_ids.push(doc.id);
    current.bytes += size;
  }
  if (current.document_ids.length) chunks.push(current);
  return chunks;
}

const text = (value) => (typeof value === "string" ? value : "");
const list = (value) => (Array.isArray(value) ? value : []);

function dedupeBy(items, keyOf) {
  const seen = new Set();
  const kept = [];
  for (const item of items) {
    const key = keyOf(item);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(item);
  }
  return kept;
}

/* One baseline from many chunk readings. First occurrence wins every exact-
   identity collision — chunk order is document order, and the sheet that
   introduces a room outranks a later sheet that mentions it. */
export function mergeChunkAnalyses(analyses) {
  const readings = list(analyses).filter((entry) => entry && typeof entry === "object");
  if (readings.length === 1) return readings[0];
  if (!readings.length) throw new Error("No chunk produced a reading to merge");

  const lower = (value) => text(value).trim().toLowerCase();
  const spaceKey = (space) => `${lower(space.building)}|${lower(space.level)}|${lower(space.name)}`;

  const summaries = dedupeBy(
    readings.map((reading) => text(reading.project_summary).trim()).filter(Boolean),
    (summary) => summary,
  );

  const phases = dedupeBy(
    readings.flatMap((reading) => list(reading.phases)),
    (phase) => lower(phase.code),
  ).sort((a, b) => Number(a.sequence || 0) - Number(b.sequence || 0))
    .map((phase, index) => ({ ...phase, sequence: index + 1 }));

  return {
    project_summary: summaries.join("\n"),
    source_register: dedupeBy(
      readings.flatMap((reading) => list(reading.source_register)),
      (entry) => text(entry.document_id),
    ),
    levels: dedupeBy(
      readings.flatMap((reading) => list(reading.levels)),
      (level) => `${lower(level.building)}|${lower(level.name)}`,
    ),
    spaces: dedupeBy(readings.flatMap((reading) => list(reading.spaces)), spaceKey),
    /* Links and framing concatenate: downstream finalization already dedupes
       links by their normalised space pair and drops the unresolvable. */
    space_links: readings.flatMap((reading) => list(reading.space_links)),
    framing_walls: readings.flatMap((reading) => list(reading.framing_walls)),
    framing_decks: readings.flatMap((reading) => list(reading.framing_decks)),
    systems: dedupeBy(
      readings.flatMap((reading) => list(reading.systems)),
      (system) => lower(system.name),
    ),
    phases,
    capture_requirements: readings.flatMap((reading) => list(reading.capture_requirements)),
    gaps: [
      ...readings.flatMap((reading) => list(reading.gaps)),
      {
        severity: "informational",
        question: `This set was analyzed in ${readings.length} chunks because it exceeds one AI reading. A schedule in one chunk cannot resolve a mark drawn in another — review cross-discipline references before activation.`,
        source_refs: [],
        blocks_activation: false,
      },
    ],
    assumptions: [
      ...dedupeBy(
        readings.flatMap((reading) => list(reading.assumptions)).map((entry) => text(entry)).filter(Boolean),
        (entry) => entry,
      ),
      `Analyzed in ${readings.length} chunks; per-chunk readings merged deterministically by exact identity, never by similarity.`,
    ],
  };
}
