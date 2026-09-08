/* THE SCRIPTED AGENTS OF THE SYNTHETIC RECORDS PACK.
 *
 * Each reads a packet, looks the segment up in the invented truth by its
 * content hash, and answers in the envelope shape. A test that wants a reader
 * to be wrong, silent, slow or absent passes a script; the default readers
 * are right, which is the least interesting case and the one the kernel
 * must not trust.
 */
import type { PacketClaim, ProposedAnchor, ProposedClaim, WorkPacket } from "../../kernel/contracts.ts";
import { emptyEnvelope } from "../../kernel/deterministic.ts";
import { ExecutorRegistry } from "../../kernel/executors.ts";
import type { Responder, Script, TruthOracle, TruthReading } from "../mock-executor.ts";
import { ScriptedExecutor, kernelRoleResponders, rowBox } from "../mock-executor.ts";
import type { RecordSet, Region } from "./fixture.ts";
import { SyntheticRecordsPack } from "./pack.ts";

const pack = new SyntheticRecordsPack();

function regionOf(packet: WorkPacket, truth: RecordSet, segmentId: string | null): Region | null {
  const source = packet.sources.find((s) => s.segmentId === segmentId) ?? packet.sources[0];
  if (!source || !source.segmentId) return null;
  return truth.byRegionHash.get(source.contentHash) ?? null;
}

export function discoverRegions(packet: WorkPacket, truth: RecordSet) {
  const env = emptyEnvelope(packet);
  const sheetRef = packet.sources.find((s) => s.kind === "segment" && s.segmentKind === "sheet");
  const sheet = sheetRef ? truth.bySheetHash.get(sheetRef.contentHash) : null;
  if (!sheetRef || !sheet) { env.outcome = "failed_known"; env.limitations.push("no sheet in the packet"); return env; }
  for (const r of sheet.regions) {
    env.segments.push({ segmentKey: `${r.kind}-${r.ordinal}`, sourceId: sheetRef.sourceId, parentSegmentId: sheetRef.segmentId, segmentKind: r.kind, label: r.label, ordinal: r.ordinal, locator: { bbox: r.bbox }, contentHash: r.contentHash });
  }
  return env;
}

export function readTable(packet: WorkPacket, truth: RecordSet) {
  const env = emptyEnvelope(packet);
  const ref = packet.sources[0];
  const region = regionOf(packet, truth, ref?.segmentId ?? null);
  if (!ref || !region || region.kind !== "table") { env.outcome = "failed_known"; env.limitations.push("no table in the packet"); return env; }
  const bbox = (ref.locator.bbox ?? region.bbox) as [number, number, number, number];
  region.entries.forEach((e, i) => {
    const key = `row-${i}`;
    const anchor: ProposedAnchor = { anchorKey: key, sourceKind: "segment_locator", sourceId: ref.sourceId, segmentId: ref.segmentId, locator: { bbox: rowBox(bbox, i, region.entries.length) }, quotedText: `${e.id} ${e.category} ${e.quantity} ${e.unit}` };
    env.anchors.push(anchor);
    const claim: ProposedClaim = {
      claimKey: key, subjectType: "entry", subjectKey: `entry/${e.id}`, predicate: "quantity",
      value: { known: true, quantity: e.quantity, text: `${e.quantity} ${e.unit}`, attributes: { category: e.category } }, unit: e.unit,
      observationBasis: "observed", scope: { segment: region.label }, anchorKeys: [key], machineConfidence: 0.9,
    };
    env.claims.push(claim);
  });
  return env;
}

export function readNote(packet: WorkPacket, truth: RecordSet) {
  const env = emptyEnvelope(packet);
  const ref = packet.sources[0];
  const region = regionOf(packet, truth, ref?.segmentId ?? null);
  if (!ref || !region || region.kind !== "note" || !region.note) { env.outcome = "failed_known"; env.limitations.push("no note in the packet"); return env; }
  const bbox = (ref.locator.bbox ?? region.bbox) as [number, number, number, number];
  env.anchors.push({ anchorKey: "note", sourceKind: "segment_locator", sourceId: ref.sourceId, segmentId: ref.segmentId, locator: { bbox: rowBox(bbox, 0, 1) }, quotedText: `${region.note.entryId}: ${region.note.status}` });
  env.claims.push({
    claimKey: "note", subjectType: "entry", subjectKey: `entry/${region.note.entryId}`, predicate: "revision_status",
    value: { known: true, quantity: null, text: region.note.status }, unit: null, observationBasis: "observed", scope: { segment: region.label }, anchorKeys: ["note"], machineConfidence: 0.85,
  });
  return env;
}

/* What the invented source really says about a claim, at the place the
   claim's anchor names. */
export function oracleFor(truth: RecordSet): TruthOracle {
  return {
    readingFor(packet: WorkPacket, claim: PacketClaim): TruthReading {
      const at = claim.anchors[0];
      if (!at) return "unreadable";
      const region = regionOf(packet, truth, at.segmentId);
      if (!region) return "unreadable";
      const id = claim.subjectKey.replace(/^entry\//, "");
      if (claim.predicate === "quantity") {
        const e = region.entries.find((x) => x.id === id);
        return e ? { value: { known: true, quantity: e.quantity, text: `${e.quantity} ${e.unit}`, attributes: { category: e.category } }, unit: e.unit } : null;
      }
      if (claim.predicate === "revision_status") {
        return region.note && region.note.entryId === id ? { value: { known: true, quantity: null, text: region.note.status }, unit: null } : null;
      }
      return null;
    },
  };
}

export function packResponders(truth: RecordSet): Record<string, Responder> {
  return {
    region_discoverer: (p) => discoverRegions(p, truth),
    table_reader: (p) => readTable(p, truth),
    note_reader: (p) => readNote(p, truth),
    ...kernelRoleResponders(oracleFor(truth), (u) => pack.normaliseUnit(u)),
  };
}

export const MOCK_FAMILIES = ["reader-family-one", "reader-family-two", "reader-family-three", "critic-family-one", "critic-family-two", "arbiter-family-one"];

export type MockOptions = {
  /* Which families to register; each gets its own executor instance and so
     its own independence domain. */
  families?: string[];
  /* Families that must share one executor instance — two names, one domain. */
  aliases?: Record<string, string>;
  scripts?: Record<string, Script>;
};

/* An executor registry with one scripted executor per family. */
export function mockExecutors(truth: RecordSet, options: MockOptions = {}): { registry: ExecutorRegistry; executors: Record<string, ScriptedExecutor> } {
  const registry = new ExecutorRegistry();
  const executors: Record<string, ScriptedExecutor> = {};
  const responders = packResponders(truth);
  for (const family of options.families ?? MOCK_FAMILIES) {
    const alias = options.aliases?.[family];
    if (alias && executors[alias]) { registry.register(executors[alias], [family]); executors[family] = executors[alias]; continue; }
    const executor = new ScriptedExecutor(family, responders, options.scripts?.[family] ?? null);
    registry.register(executor, [family]);
    executors[family] = executor;
  }
  return { registry, executors };
}
