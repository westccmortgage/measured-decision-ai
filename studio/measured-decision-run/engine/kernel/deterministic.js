/* THE KERNEL'S OWN CODE ROLES.
 *
 * The ingestor copies identity the manifest already established and declares
 * the segments the source declares about itself; the comparator lines
 * readings up. Neither reads into a source, neither decides anything, and
 * every claim they produce names what it was computed from.
 */
import { compareClaims } from "./comparison.js";
import { PACKET_VERSION } from "./contracts.js";
import { sha256 } from "./ids.js";
export function emptyEnvelope(packet, outcome = "completed") {
    return {
        packetVersion: PACKET_VERSION, taskId: packet.taskId, roleKey: packet.roleKey, roleVersion: packet.roleVersion,
        outcome, claims: [], anchors: [], segments: [], assessments: [], disagreements: [], requestedActions: [], limitations: [],
        rawResponseReference: null, adjudication: null, decisions: [], calculations: [],
    };
}
export class KernelDeterministicExecutor {
    family = "deterministic";
    pack;
    constructor(pack) {
        this.pack = pack;
    }
    async execute(packet, _context) {
        switch (packet.phase) {
            case "ingest": return this.ingest(packet);
            case "compare": return this.compare(packet);
            case "derive": return this.pack.derive(packet);
            default: {
                const env = emptyEnvelope(packet, "failed_known");
                env.limitations.push(`${packet.taskType} is not code's work`);
                return env;
            }
        }
    }
    /* One identity claim a rule can validate against the manifest itself. The
       segments a source declares about itself are persisted by the kernel from
       the manifest when this task commits — they are input, not this code's
       output. */
    ingest(packet) {
        const env = emptyEnvelope(packet);
        const source = packet.sources.find((s) => s.kind === "source");
        if (!source) {
            env.outcome = "failed_known";
            env.limitations.push("no source in the packet");
            return env;
        }
        env.anchors.push({ anchorKey: "source", sourceKind: "source", sourceId: source.sourceId, segmentId: null, locator: {}, quotedText: null });
        env.claims.push({
            claimKey: "identity", subjectType: "source", subjectKey: packet.subjectKey, predicate: "content_identity",
            value: { known: true, quantity: null, text: source.contentHash, attributes: { source_kind: source.sourceKind } },
            unit: null, observationBasis: "derived", scope: {}, anchorKeys: ["source"], machineConfidence: null, inputClaimIds: [],
        });
        return env;
    }
    compare(packet) {
        const env = emptyEnvelope(packet);
        const claims = packet.context.claims.map((c) => ({
            claimId: c.ref, independenceGroup: c.independenceGroup, subjectType: c.subjectType, subjectKey: c.subjectKey,
            predicate: c.predicate, value: c.value, unit: c.unit, observationBasis: c.observationBasis, scope: c.scope,
        }));
        const readers = packet.dependencies.map((d) => d.independenceGroup).filter(Boolean);
        const result = compareClaims(packet.workflowId, packet.subjectKey, claims, readers, { unit: (u) => this.pack.normaliseUnit(u), key: (k) => this.pack.normaliseKey(k) });
        env.disagreements = result.disagreements;
        env.limitations.push(`agreements=${result.agreements.length} disagreements=${result.disagreements.length}`);
        env.calculations = result.agreements.map((g, i) => ({
            calculationKey: `agreement-${i}-${sha256(g.claimIds.join(",")).slice(0, 8)}`, formula: "identical normalised subject, predicate, scope, value, attributes, unit and basis",
            inputClaimIds: g.claimIds, unit: null, wasteAssumption: null, rounding: null, result: g.claimIds.length,
        }));
        return env;
    }
}
