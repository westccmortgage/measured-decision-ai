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
import { canonical, entityId, sha256 } from "../../kernel/ids.ts";
import type { Bbox } from "../../kernel/locators.ts";

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

export type RecordSet = {
  manifest: SourceManifest;
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
      const table: Region = { kind: "table", label: `table ${p + 1}`, ordinal: 0, bbox: [0.05, 0.1, 0.95, 0.6], contentHash: "", entries: tableEntries, note: null };
      table.contentHash = `fx-${sha256(canonical({ seed, s, p, table: tableEntries })).slice(0, 24)}`;
      const noteRegion: Region = { kind: "note", label: `note ${p + 1}`, ordinal: 1, bbox: [0.05, 0.65, 0.95, 0.9], contentHash: "", entries: [], note };
      noteRegion.contentHash = `fx-${sha256(canonical({ seed, s, p, note })).slice(0, 24)}`;
      const sheet: Sheet = { sourceId, sourceOrdinal: s, label: `sheet ${p + 1}`, ordinal: p, contentHash: "", regions: [table, noteRegion] };
      sheet.contentHash = `fx-${sha256(canonical({ seed, s, p, regions: [table.contentHash, noteRegion.contentHash] })).slice(0, 24)}`;
      sourceSheets.push(sheet);
      declared.push({ sourceId, parentSegmentId: null, segmentKind: "sheet", label: sheet.label, ordinal: p, locator: { bbox: [0, 0, 1, 1] }, contentHash: sheet.contentHash });
    }
    sheets.push(...sourceSheets);
    descriptors.push({
      sourceId, ordinal: s, sourceKind: "record_set", label: `record set ${String.fromCharCode(65 + s)}`,
      uri: `fixture://synthetic-records/${sha256(seed).slice(0, 8)}/${s}`,
      contentHash: `fx-${sha256(canonical({ seed, s, sheets: sourceSheets.map((x) => x.contentHash) })).slice(0, 24)}`, hashAlgorithm: "sha-256",
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
    manifest, sheets, entries, totals, categories,
    bySheetHash: new Map(sheets.map((s) => [s.contentHash, s])),
    byRegionHash: new Map(sheets.flatMap((s) => s.regions.map((r) => [r.contentHash, r] as const))),
  };
}
