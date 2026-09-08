/* AN INVENTED SET OF RECORDS, AND THE TRUTH ABOUT IT.
 *
 * Nothing here is anybody's. A record set is a source that declares sheets;
 * each sheet holds a table of entries and a note about one of them; every
 * entry has an id, a category, a quantity and a unit. The generator is
 * deterministic in its seed, so a test that names a seed names a world.
 *
 * The truth is what the scripted executors read from. The kernel never
 * sees it; it sees only what the executors say, and is judged on what it
 * does with that.
 */
import type { SegmentDescriptor, SourceDescriptor, SourceManifest } from "../../kernel/contracts.ts";
import { entityId, sha256, sha256Bytes } from "../../kernel/ids.ts";
import type { Bbox } from "../../kernel/locators.ts";
import { IMAGE_MIME, TEXT_MIME, renderNoteText, renderSheet, renderSource, renderTable, renderTextAsImage } from "./material.ts";

export type Entry = { id: string; category: string; quantity: number; unit: string };
export type Note = { entryId: string; status: string };

export type Region = {
  kind: "table" | "note";
  label: string;
  ordinal: number;
  bbox: Bbox;
  contentHash: string;
  entries: Entry[];
  note: Note | null;
};

export type Sheet = {
  sourceId: string;
  sourceOrdinal: number;
  label: string;
  ordinal: number;
  contentHash: string;
  regions: Region[];
};

export type RecordSetOptions = {
  seed?: string;
  sources?: number;
  sheetsPerSource?: number;
  entriesPerTable?: number;
  organizationId?: string;
  workflowId?: string;
  categories?: string[];
};

/* The bytes a reader is actually handed, filed under the hash of those
   bytes — which is exactly how content-addressed storage works, and why the
   hash a packet carries can be checked against what came back. */
export type FixtureMaterial = {
  mediaKind: "text" | "image";
  mimeType: string;
  bytes: Uint8Array;
};

export type RecordSet = {
  manifest: SourceManifest;
  /* By content hash. Nothing in here is anybody's document. */
  material: Map<string, FixtureMaterial>;
  sheets: Sheet[];
  bySheetHash: Map<string, Sheet>;
  byRegionHash: Map<string, Region>;
  entries: Entry[];
  totals: Record<string, { quantity: number; unit: string; entries: number }>;
  categories: string[];
};

export const DEFAULT_CATEGORIES = ["alpha", "beta", "gamma"];
const UNIT_OF: Record<string, string> = { alpha: "each", beta: "kg", gamma: "each" };

/* A small deterministic generator: numbers from a hash chain on the seed. */
function rng(seed: string): () => number {
  let state = sha256(seed);
  return () => {
    state = sha256(state);
    return parseInt(state.slice(0, 8), 16) / 0xffffffff;
  };
}

export function syntheticRecordSet(options: RecordSetOptions = {}): RecordSet {
  const seed = options.seed ?? "synthetic-records/1";
  const sources = options.sources ?? 2;
  const sheetsPerSource = options.sheetsPerSource ?? 2;
  const entriesPerTable = options.entriesPerTable ?? 3;
  const categories = options.categories ?? DEFAULT_CATEGORIES;
  const next = rng(seed);
  const organizationId = options.organizationId ?? entityId("fixture-organisation", seed);
  const workflowId = options.workflowId ?? entityId("fixture-workflow", seed);

  const sheets: Sheet[] = [];
  const material = new Map<string, FixtureMaterial>();
  const entries: Entry[] = [];
  const descriptors: SourceDescriptor[] = [];
  let entryNo = 0;

  for (let s = 0; s < sources; s++) {
    const sourceId = entityId("fixture-source", seed, s);
    const declared: SegmentDescriptor[] = [];
    const sourceSheets: Sheet[] = [];
    for (let p = 0; p < sheetsPerSource; p++) {
      const tableEntries: Entry[] = [];
      for (let e = 0; e < entriesPerTable; e++) {
        entryNo++;
        const category = categories[Math.floor(next() * categories.length)] ?? categories[0];
        const entry: Entry = { id: `E-${String(entryNo).padStart(3, "0")}`, category, quantity: 1 + Math.floor(next() * 40), unit: UNIT_OF[category] ?? "each" };
        tableEntries.push(entry);
        entries.push(entry);
      }
      const noted = tableEntries[Math.floor(next() * tableEntries.length)];
      const note: Note = { entryId: noted.id, status: next() < 0.7 ? "current" : "superseded" };
      /* Material first, then the hash of it: a segment is named by what it
         holds, so a reader handed the bytes can prove it was handed the
         right ones. The table is text; the note is an image whose pixels
         carry its characters. */
      const table: Region = { kind: "table", label: `table ${p + 1}`, ordinal: 0, bbox: [0.05, 0.1, 0.95, 0.6], contentHash: "", entries: tableEntries, note: null };
      const tableBytes = new Uint8Array(Buffer.from(renderTable(table), "utf8"));
      table.contentHash = sha256Bytes(tableBytes);
      material.set(table.contentHash, { mediaKind: "text", mimeType: TEXT_MIME, bytes: tableBytes });

      const noteRegion: Region = { kind: "note", label: `note ${p + 1}`, ordinal: 1, bbox: [0.05, 0.65, 0.95, 0.9], contentHash: "", entries: [], note };
      const noteBytes = renderTextAsImage(renderNoteText(note, table.contentHash));
      noteRegion.contentHash = sha256Bytes(noteBytes);
      material.set(noteRegion.contentHash, { mediaKind: "image", mimeType: IMAGE_MIME, bytes: noteBytes });

      const sheet: Sheet = { sourceId, sourceOrdinal: s, label: `sheet ${p + 1}`, ordinal: p, contentHash: "", regions: [table, noteRegion] };
      const sheetBytes = new Uint8Array(Buffer.from(renderSheet(sheet), "utf8"));
      sheet.contentHash = sha256Bytes(sheetBytes);
      material.set(sheet.contentHash, { mediaKind: "text", mimeType: TEXT_MIME, bytes: sheetBytes });
      sourceSheets.push(sheet);
      declared.push({ sourceId, parentSegmentId: null, segmentKind: "sheet", label: sheet.label, ordinal: p, locator: { bbox: [0, 0, 1, 1] }, contentHash: sheet.contentHash });
    }
    sheets.push(...sourceSheets);
    const label = `record set ${String.fromCharCode(65 + s)}`;
    const sourceBytes = new Uint8Array(Buffer.from(renderSource(label, sourceSheets), "utf8"));
    const sourceHash = sha256Bytes(sourceBytes);
    material.set(sourceHash, { mediaKind: "text", mimeType: TEXT_MIME, bytes: sourceBytes });
    descriptors.push({
      sourceId, ordinal: s, sourceKind: "record_set", label,
      uri: `fixture://synthetic-records/${sha256(seed).slice(0, 8)}/${s}`,
      contentHash: sourceHash, hashAlgorithm: "sha-256",
      objectVersionId: null, byteSize: 4096 * sheetsPerSource, media: { fixture: true, sheet_count: sheetsPerSource }, declaredSegments: declared,
    });
  }

  const totals: RecordSet["totals"] = {};
  for (const e of entries) {
    const t = totals[e.category] ?? { quantity: 0, unit: e.unit, entries: 0 };
    t.quantity += e.quantity; t.entries += 1; totals[e.category] = t;
  }

  const manifest: SourceManifest = {
    workflowId, organizationId, domainPack: "synthetic-records", domainPackVersion: "1.0", workflowType: "synthetic_record_review",
    requestedScope: { fixture: seed, categories }, sources: descriptors,
  };
  return {
    manifest, sheets, entries, totals, categories, material,
    bySheetHash: new Map(sheets.map((s) => [s.contentHash, s])),
    byRegionHash: new Map(sheets.flatMap((s) => s.regions.map((r) => [r.contentHash, r] as const))),
  };
}
