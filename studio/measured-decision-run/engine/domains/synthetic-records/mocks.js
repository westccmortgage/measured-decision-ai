import { emptyEnvelope } from "../../kernel/deterministic.js";
import { ExecutorRegistry } from "../../kernel/executors.js";
import { ScriptedExecutor, kernelRoleResponders, rowBox } from "../mock-executor.js";
import { SyntheticRecordsPack } from "./pack.js";
const pack = new SyntheticRecordsPack();
function regionOf(packet, truth, segmentId) {
    const source = packet.sources.find((s) => s.segmentId === segmentId) ?? packet.sources[0];
    if (!source || !source.segmentId)
        return null;
    return truth.byRegionHash.get(source.contentHash) ?? null;
}
export function discoverRegions(packet, truth) {
    const env = emptyEnvelope(packet);
    const sheetRef = packet.sources.find((s) => s.kind === "segment" && s.segmentKind === "sheet");
    const sheet = sheetRef ? truth.bySheetHash.get(sheetRef.contentHash) : null;
    if (!sheetRef || !sheet) {
        env.outcome = "failed_known";
        env.limitations.push("no sheet in the packet");
        return env;
    }
    for (const r of sheet.regions) {
        env.segments.push({ segmentKey: `${r.kind}-${r.ordinal}`, sourceId: sheetRef.sourceId, parentSegmentId: sheetRef.segmentId, segmentKind: r.kind, label: r.label, ordinal: r.ordinal, locator: { bbox: r.bbox }, contentHash: r.contentHash });
    }
    return env;
}
export function readTable(packet, truth) {
    const env = emptyEnvelope(packet);
    const ref = packet.sources[0];
    const region = regionOf(packet, truth, ref?.segmentId ?? null);
    if (!ref || !region || region.kind !== "table") {
        env.outcome = "failed_known";
        env.limitations.push("no table in the packet");
        return env;
    }
    const bbox = (ref.locator.bbox ?? region.bbox);
    region.entries.forEach((e, i) => {
        const key = `row-${i}`;
        const anchor = { anchorKey: key, sourceKind: "segment_locator", sourceId: ref.sourceId, segmentId: ref.segmentId, locator: { bbox: rowBox(bbox, i, region.entries.length) }, quotedText: `${e.id} ${e.category} ${e.quantity} ${e.unit}` };
        env.anchors.push(anchor);
        const claim = {
            claimKey: key, subjectType: "entry", subjectKey: `entry/${e.id}`, predicate: "quantity",
            value: { known: true, quantity: e.quantity, text: `${e.quantity} ${e.unit}`, attributes: { category: e.category } }, unit: e.unit,
            observationBasis: "observed", scope: { segment: region.label }, anchorKeys: [key], machineConfidence: 0.9,
        };
        env.claims.push(claim);
    });
    return env;
}
export function readNote(packet, truth) {
    const env = emptyEnvelope(packet);
    const ref = packet.sources[0];
    const region = regionOf(packet, truth, ref?.segmentId ?? null);
    if (!ref || !region || region.kind !== "note" || !region.note) {
        env.outcome = "failed_known";
        env.limitations.push("no note in the packet");
        return env;
    }
    const bbox = (ref.locator.bbox ?? region.bbox);
    env.anchors.push({ anchorKey: "note", sourceKind: "segment_locator", sourceId: ref.sourceId, segmentId: ref.segmentId, locator: { bbox: rowBox(bbox, 0, 1) }, quotedText: `${region.note.entryId}: ${region.note.status}` });
    env.claims.push({
        claimKey: "note", subjectType: "entry", subjectKey: `entry/${region.note.entryId}`, predicate: "revision_status",
        value: { known: true, quantity: null, text: region.note.status }, unit: null, observationBasis: "observed", scope: { segment: region.label }, anchorKeys: ["note"], machineConfidence: 0.85,
    });
    return env;
}
/* What the invented source really says about a claim, at the place the
   claim's anchor names. */
export function oracleFor(truth) {
    return {
        readingFor(packet, claim) {
            const at = claim.anchors[0];
            if (!at)
                return "unreadable";
            const region = regionOf(packet, truth, at.segmentId);
            if (!region)
                return "unreadable";
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
export function packResponders(truth) {
    return {
        region_discoverer: (p) => discoverRegions(p, truth),
        table_reader: (p) => readTable(p, truth),
        note_reader: (p) => readNote(p, truth),
        ...kernelRoleResponders(oracleFor(truth), (u) => pack.normaliseUnit(u)),
    };
}
export const MOCK_FAMILIES = ["reader-family-one", "reader-family-two", "reader-family-three", "critic-family-one", "critic-family-two", "arbiter-family-one"];
/* An executor registry with one scripted executor per family. */
export function mockExecutors(truth, options = {}) {
    const registry = new ExecutorRegistry();
    const executors = {};
    const responders = packResponders(truth);
    for (const family of options.families ?? MOCK_FAMILIES) {
        const alias = options.aliases?.[family];
        if (alias && executors[alias]) {
            registry.register(executors[alias], [family]);
            executors[family] = executors[alias];
            continue;
        }
        const executor = new ScriptedExecutor(family, responders, options.scripts?.[family] ?? null);
        registry.register(executor, [family]);
        executors[family] = executor;
    }
    return { registry, executors };
}
