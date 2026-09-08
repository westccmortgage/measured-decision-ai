/* A READER THAT READS NOTHING, FOR AN ENGINE THAT MUST BE TESTED BEFORE ONE DOES.
 *
 * Every answer here is a table lookup on the synthetic project. Two blind
 * readers of the same region return the same claims — except where the
 * fixture plants a difference, so the comparator, the verifier and the
 * arbiter have something to do:
 *
 *   HEADER SCHEDULE   reader-b prints H2 as 3, reader-a as 4     → value dispute, settled by evidence
 *   FLOOR FRAMING     reader-b does not see header mark H-3       → missing, settled after one follow-up
 *   GENERAL NOTES     reader-b does not see note N2               → arbiter keeps asking; escalated
 *   PIER SCHEDULE     P2 read as 30x30 and 30x36                  → verifier cannot read it twice; a person
 *   WINDOW SCHEDULE   "ea" against "each"                         → normalisation, no dispute
 *
 * It calls nothing, fetches nothing, and does not know what a provider is.
 */
import type {
  AgentResultEnvelope, PacketClaim, ProposedAnchor, ProposedClaim, RequestedAgentAction, WorkPacket,
} from "../contracts.ts";
import { fingerprint } from "../hash.ts";
import { emptyEnvelope } from "./deterministic-executor.ts";
import type { AgentExecutor } from "./executor.ts";

type Row = { key: string; predicate: string; text: string; quantity?: number | null; unit?: string | null; attrs?: Record<string, string | number> };

const SCHEDULES: Record<string, Row[]> = {
  rg_x1_sched: [
    { key: "P1", predicate: "pier_size", text: "24x24" },
    { key: "P1", predicate: "concrete_volume_each", text: "0.5 cy", quantity: 0.5, unit: "cy" },
    { key: "P2", predicate: "pier_size", text: "30x30" },
    { key: "P2", predicate: "concrete_volume_each", text: "0.8 cy", quantity: 0.8, unit: "cy" },
  ],
  rg_x2_sched: [
    { key: "H1", predicate: "member_size", text: "(2) 2x10" },
    { key: "H1", predicate: "scheduled_quantity", text: "2", quantity: 2, unit: "each" },
    { key: "H2", predicate: "member_size", text: "(2) 2x12" },
    { key: "H2", predicate: "scheduled_quantity", text: "4", quantity: 4, unit: "each" },
  ],
  rg_y2_sched: [
    { key: "W1", predicate: "window_size", text: "3050" },
    { key: "W1", predicate: "scheduled_quantity", text: "6", quantity: 6, unit: "each" },
    { key: "W2", predicate: "window_size", text: "2030" },
    { key: "W2", predicate: "scheduled_quantity", text: "2", quantity: 2, unit: "each" },
  ],
};

const NOTES: Record<string, Row[]> = {
  rg_y3_notes: [
    { key: "N1", predicate: "requirement", text: "All headers to be No.2 or better unless noted." },
    { key: "N2", predicate: "requirement", text: "Piers to bear on undisturbed soil; see geotechnical report." },
  ],
};

const LEGENDS: Record<string, Row[]> = {
  rg_x2_legend: [{ key: "HDR-H", predicate: "symbol_meaning", text: "Header; see HEADER SCHEDULE" }],
  rg_y1_legend: [{ key: "WIN-W", predicate: "symbol_meaning", text: "Window; see WINDOW SCHEDULE" }],
};

type Instance = { mark: string; type: string; box: [number, number, number, number] };
const INSTANCES: Record<string, Instance[]> = {
  "rg_x1_plan/PIER-P": [
    { mark: "P-1", type: "P1", box: [0.10, 0.10, 0.13, 0.13] }, { mark: "P-2", type: "P1", box: [0.30, 0.10, 0.33, 0.13] },
    { mark: "P-3", type: "P2", box: [0.10, 0.60, 0.13, 0.63] }, { mark: "P-4", type: "P2", box: [0.30, 0.60, 0.33, 0.63] },
  ],
  "rg_x2_plan/HDR-H": [
    { mark: "H-1", type: "H1", box: [0.12, 0.20, 0.18, 0.22] }, { mark: "H-2", type: "H1", box: [0.40, 0.20, 0.46, 0.22] },
    { mark: "H-3", type: "H2", box: [0.55, 0.80, 0.61, 0.82] },
  ],
  "rg_x2_plan/PIER-P": [
    { mark: "P-5", type: "P1", box: [0.10, 0.85, 0.13, 0.88] }, { mark: "P-6", type: "P1", box: [0.30, 0.85, 0.33, 0.88] },
  ],
  "rg_y1_plan/WIN-W": [
    { mark: "W-1", type: "W1", box: [0.05, 0.10, 0.08, 0.12] }, { mark: "W-2", type: "W1", box: [0.20, 0.10, 0.23, 0.12] },
    { mark: "W-3", type: "W1", box: [0.35, 0.10, 0.38, 0.12] }, { mark: "W-4", type: "W1", box: [0.50, 0.10, 0.53, 0.12] },
    { mark: "W-5", type: "W1", box: [0.05, 0.90, 0.08, 0.92] }, { mark: "W-6", type: "W1", box: [0.20, 0.90, 0.23, 0.92] },
    { mark: "W-7", type: "W2", box: [0.60, 0.50, 0.63, 0.52] }, { mark: "W-8", type: "W2", box: [0.66, 0.50, 0.69, 0.52] },
  ],
};

/* What reader-b does differently. */
const READER_B_QUIRKS = {
  omitInstanceMarks: ["H-3"],
  omitNoteKeys: ["N2"],
  scheduleOverrides: { "rg_x2_sched|H2|scheduled_quantity": { text: "3", quantity: 3 }, "rg_x1_sched|P2|pier_size": { text: "30x36" } } as Record<string, Partial<Row>>,
  unitSpelling: { each: "ea" } as Record<string, string>,
};

export type MockBehaviour = {
  /* Task ids the mock answers with outcome_unknown, to test that a branch stops. */
  unknownOutcomeTaskIds: string[];
  /* Task ids the mock answers with an envelope that fails validation. */
  invalidEnvelopeTaskIds: string[];
  /* Task ids the mock answers with a bare total instead of marks. */
  totalOnlyTaskIds: string[];
};

export class MockAgentExecutor implements AgentExecutor {
  readonly family: string;
  behaviour: MockBehaviour;
  executed: string[] = [];

  constructor(family: string, behaviour: Partial<MockBehaviour> = {}) {
    this.family = family;
    this.behaviour = { unknownOutcomeTaskIds: [], invalidEnvelopeTaskIds: [], totalOnlyTaskIds: [], ...behaviour };
  }

  async execute(packet: WorkPacket): Promise<AgentResultEnvelope> {
    this.executed.push(packet.taskId);
    if (this.behaviour.unknownOutcomeTaskIds.includes(packet.taskId)) {
      const env = emptyEnvelope(packet, "outcome_unknown");
      env.limitations.push("the connection dropped after the request was sent");
      return env;
    }
    if (this.behaviour.invalidEnvelopeTaskIds.includes(packet.taskId)) {
      const env = emptyEnvelope(packet);
      env.claims.push({ claimKey: "unanchored", subjectType: "component_type", subjectKey: "X", predicate: "scheduled_quantity",
        value: { known: true, quantity: 7, text: "7" }, unit: "each", observationBasis: "printed", scope: {}, anchorKeys: [], machineConfidence: 0.9 });
      return env;
    }
    switch (packet.taskType) {
      case "map_page_regions": return this.cartographer(packet);
      case "extract_schedule": return this.rows(packet, SCHEDULES, "component_type");
      case "extract_notes": return this.rows(packet, NOTES, "requirement");
      case "extract_legend": return this.rows(packet, LEGENDS, "component_type");
      case "extract_dimensions": return this.dimensions(packet);
      case "locate_symbol_family": return this.locator(packet);
      case "resolve_relationships": return this.relationships(packet);
      case "verify_claim": return this.critic(packet);
      case "verify_disagreement": return this.verifier(packet);
      case "adjudicate": return this.arbiter(packet);
      case "compose_decision": return this.composer(packet);
      default: {
        const env = emptyEnvelope(packet, "failed_known");
        env.limitations.push(`the mock has no behaviour for ${packet.taskType}`);
        return env;
      }
    }
  }

  private isReaderB(packet: WorkPacket) { return packet.independenceGroup === "reader-b"; }

  private anchorFor(packet: WorkPacket, key: string, box: [number, number, number, number], quoted: string | null, mark?: string): ProposedAnchor {
    const region = packet.sources.find((s) => s.kind === "region")!;
    return {
      anchorKey: key, sourceKind: "page_bbox", documentId: region.documentId, pageId: region.pageId, regionId: region.regionId,
      bbox: box, quotedText: quoted, locator: { ...region.locator, ...(mark ? { mark } : {}) },
    };
  }

  cartographer(packet: WorkPacket): AgentResultEnvelope {
    const env = emptyEnvelope(packet);
    const page = packet.sources[0];
    env.anchors.push({ anchorKey: "page", sourceKind: "page_bbox", documentId: page.documentId, pageId: page.pageId, regionId: null, bbox: [0, 0, 1, 1], quotedText: null, locator: page.locator });
    env.claims.push({ claimKey: "discipline", subjectType: "document_identity", subjectKey: page.pageId!, predicate: "discipline",
      value: { known: true, quantity: null, text: String(page.locator.sheet).startsWith("X") ? "structural" : "architectural" },
      unit: null, observationBasis: "inferred", scope: {}, anchorKeys: ["page"], machineConfidence: 0.8 });
    return env;
  }

  rows(packet: WorkPacket, table: Record<string, Row[]>, subjectType: ProposedClaim["subjectType"]): AgentResultEnvelope {
    const env = emptyEnvelope(packet);
    const region = packet.sources.find((s) => s.kind === "region");
    if (!region) { env.outcome = "failed_known"; env.limitations.push("no region"); return env; }
    const rows = table[region.regionId!] ?? [];
    const b = this.isReaderB(packet);
    let i = 0;
    for (const row of rows) {
      if (b && READER_B_QUIRKS.omitNoteKeys.includes(row.key) && table === NOTES) continue;
      const override = b ? READER_B_QUIRKS.scheduleOverrides[`${region.regionId}|${row.key}|${row.predicate}`] : undefined;
      const text = override?.text ?? row.text;
      const quantity = override?.quantity !== undefined ? override.quantity : (row.quantity ?? null);
      const unit = row.unit ? (b ? (READER_B_QUIRKS.unitSpelling[row.unit] ?? row.unit) : row.unit) : null;
      const y0 = (region.bbox?.[1] ?? 0) + 0.02 + i * 0.03;
      const box: [number, number, number, number] = [(region.bbox?.[0] ?? 0) + 0.01, y0, (region.bbox?.[2] ?? 1) - 0.01, y0 + 0.025];
      const anchorKey = `row-${i}`;
      env.anchors.push(this.anchorFor(packet, anchorKey, box, `${row.key} ${text}`));
      env.claims.push({
        claimKey: `${row.key}-${row.predicate}`, subjectType, subjectKey: row.key, predicate: row.predicate,
        value: { known: true, quantity, text }, unit, observationBasis: "printed", scope: { sheet: String(region.locator.sheet) },
        anchorKeys: [anchorKey], machineConfidence: 0.9,
      });
      i++;
    }
    return env;
  }

  dimensions(packet: WorkPacket): AgentResultEnvelope {
    const env = emptyEnvelope(packet);
    const region = packet.sources.find((s) => s.kind === "region");
    if (!region) { env.outcome = "failed_known"; return env; }
    /* Boxes sit inside whichever region was handed over. */
    const [x0, y0, x1, y1] = region.bbox ?? [0, 0, 1, 1];
    const at = (fx0: number, fy0: number, fx1: number, fy1: number): [number, number, number, number] =>
      [x0 + (x1 - x0) * fx0, y0 + (y1 - y0) * fy0, x0 + (x1 - x0) * fx1, y0 + (y1 - y0) * fy1];
    env.anchors.push(this.anchorFor(packet, "dim-1", at(0.10, 0.10, 0.30, 0.15), `3 1/2" BEARING`));
    env.claims.push({ claimKey: "bearing", subjectType: "assembly", subjectKey: "HDR-H/bearing", predicate: "printed_dimension",
      value: { known: true, quantity: 3.5, text: `3 1/2"` }, unit: "in", observationBasis: "printed", scope: { detail: String(region.label ?? "") },
      anchorKeys: ["dim-1"], machineConfidence: 0.85 });
    /* An inferred geometry, kept apart from the printed one by its basis. */
    env.anchors.push(this.anchorFor(packet, "dim-2", at(0.10, 0.30, 0.70, 0.35), null));
    env.claims.push({ claimKey: "span", subjectType: "assembly", subjectKey: "HDR-H/span", predicate: "inferred_dimension",
      value: { known: false, quantity: null, text: null }, unit: null, observationBasis: "inferred", scope: {},
      anchorKeys: ["dim-2"], machineConfidence: 0.3 });
    return env;
  }

  locator(packet: WorkPacket): AgentResultEnvelope {
    const env = emptyEnvelope(packet);
    const region = packet.sources.find((s) => s.kind === "region" && s.regionKind === "plan_view");
    if (!region) { env.outcome = "failed_known"; env.limitations.push("no plan region"); return env; }
    const family = packet.subjectKey.split("/").pop()!;
    const instances = INSTANCES[`${region.regionId}/${family}`] ?? [];
    if (this.behaviour.totalOnlyTaskIds.includes(packet.taskId)) {
      env.anchors.push(this.anchorFor(packet, "sheet", region.bbox!, null));
      env.claims.push({ claimKey: "total", subjectType: "component_type", subjectKey: family, predicate: "drawn_quantity",
        value: { known: true, quantity: instances.length, text: String(instances.length) }, unit: "each", observationBasis: "counted_marks",
        scope: {}, anchorKeys: ["sheet"], machineConfidence: 0.7 });
      return env;
    }
    const b = this.isReaderB(packet);
    for (const inst of instances) {
      if (b && READER_B_QUIRKS.omitInstanceMarks.includes(inst.mark)) continue;
      const key = `inst-${inst.mark}`;
      env.anchors.push(this.anchorFor(packet, key, inst.box, inst.mark, inst.mark));
      env.claims.push({
        claimKey: key, subjectType: "component_instance", subjectKey: `${family}/${inst.mark}`, predicate: "located_at",
        value: { known: true, quantity: null, text: inst.mark, attributes: { mark_type: inst.type } }, unit: null,
        observationBasis: "printed", scope: { sheet: String(region.locator.sheet) }, anchorKeys: [key], machineConfidence: 0.9,
      });
    }
    /* On the framing plan the locator asks to read the legend it was handed
       nothing for — a permitted, bounded follow-up the tests watch. */
    if (region.regionId === "rg_x2_plan" && packet.context.depth === 0 && packet.allowedActions.includes("read_legend")) {
      env.requestedActions.push(this.request(packet, "read_legend", ["rg_x2_legend"], "what HDR marks denote"));
    }
    return env;
  }

  relationships(packet: WorkPacket): AgentResultEnvelope {
    const env = emptyEnvelope(packet);
    const instances = packet.context.claims.filter((c) => c.subjectType === "component_instance");
    let i = 0;
    for (const inst of instances) {
      const type = String(inst.value.attributes?.mark_type ?? "");
      if (!type) continue;
      const a = inst.anchors[0];
      const key = `rel-${i++}`;
      env.anchors.push({ anchorKey: key, sourceKind: a.sourceKind, documentId: a.documentId, pageId: a.pageId, regionId: a.regionId, bbox: a.bbox, quotedText: a.quotedText, locator: a.locator });
      env.claims.push({ claimKey: key, subjectType: "component_instance", subjectKey: inst.subjectKey, predicate: "instance_of",
        value: { known: true, quantity: null, text: type }, unit: null, observationBasis: "inferred", scope: inst.scope,
        anchorKeys: [key], machineConfidence: 0.8 });
    }
    return env;
  }

  critic(packet: WorkPacket): AgentResultEnvelope {
    const env = emptyEnvelope(packet);
    let i = 0;
    for (const claim of packet.context.claims) {
      const a = claim.anchors[0];
      const key = `ev-${i++}`;
      env.anchors.push({ anchorKey: key, sourceKind: a.sourceKind, documentId: a.documentId, pageId: a.pageId, regionId: a.regionId, bbox: a.bbox, quotedText: a.quotedText, locator: a.locator });
      const supported = claim.value.known && claim.anchors.length > 0;
      env.assessments.push({ claimRef: claim.ref, assessment: supported ? "supports" : "insufficient", reasonCode: supported ? "anchor_matches_value" : "value_unread",
        explanation: supported ? "the anchored text reads as the claim states" : "the claim carries no readable value", anchorKeys: [key] });
    }
    return env;
  }

  /* The verifier reopens the disputed anchors. Its behaviour follows the
     subject of the dispute, not who wrote which claim — it cannot see that. */
  verifier(packet: WorkPacket): AgentResultEnvelope {
    const env = emptyEnvelope(packet);
    const dis = packet.context.disagreements[0];
    const subject = String(dis?.subjectSignature?.subject_key ?? "");
    const claims = packet.context.claims;

    /* An unreadable crop, twice: this is the case that goes to a person. */
    if (subject === "P2") {
      env.outcome = "insufficient_evidence";
      env.limitations.push("the P2 row is unreadable at the supplied resolution");
      if (packet.allowedActions.includes("expand_region")) {
        env.requestedActions.push(this.request(packet, "expand_region", ["rg_x1_sched"], "a larger crop of the P2 row"));
      }
      return env;
    }
    /* H-3: not enough the first time, plainly there once the region is expanded. */
    if (subject === "HDRHH3" && packet.context.depth < 2) {
      env.outcome = "insufficient_evidence";
      env.limitations.push("the mark near the lower edge is cut by the crop boundary");
      if (packet.allowedActions.includes("expand_region")) {
        env.requestedActions.push(this.request(packet, "expand_region", ["rg_x2_plan"], "the lower edge of the framing plan"));
      }
      return env;
    }
    let i = 0;
    for (const claim of claims) {
      const a = claim.anchors[0];
      const key = `ev-${i++}`;
      env.anchors.push({ anchorKey: key, sourceKind: a.sourceKind, documentId: a.documentId, pageId: a.pageId, regionId: a.regionId, bbox: a.bbox, quotedText: a.quotedText, locator: a.locator });
      /* The source, as the fixture defines it: H2 prints 3; H-3 exists; N2 exists. */
      let supports: boolean;
      if (subject === "H2") supports = claim.value.quantity === 3;
      else supports = true;
      env.assessments.push({
        claimRef: claim.ref, assessment: supports ? "supports" : "contradicts",
        reasonCode: supports ? "source_matches" : "source_reads_otherwise",
        explanation: supports ? "the reopened source reads as this claim states" : "the reopened source reads otherwise",
        anchorKeys: [key],
      });
    }
    if (dis?.kind === "missing") {
      /* The claim that is present is supported; absence is assessed against the
         source too, and the source shows the thing. */
      env.limitations.push("the source shows the item one reading omitted");
    }
    return env;
  }

  arbiter(packet: WorkPacket): AgentResultEnvelope {
    const env = emptyEnvelope(packet);
    const dis = packet.context.disagreements[0];
    const subject = String(dis?.subjectSignature?.subject_key ?? "");
    const supported = packet.context.assessments.filter((a) => a.assessment === "supports").map((a) => a.claimRef);
    const contradicted = packet.context.assessments.filter((a) => a.assessment === "contradicts").map((a) => a.claimRef);
    const evidence = packet.context.assessments.flatMap((a) => a.anchorIds);

    /* The notes dispute: the arbiter keeps asking for the same thing. The
       engine, not the arbiter, is what stops that. */
    if (subject === "N2") {
      env.adjudication = {
        outcome: "needs_more_evidence", disagreementId: dis.disagreementId, acceptedClaimRef: null, correctedValue: null, correctedUnit: null,
        rationale: "the note's applicability is not established by the crop supplied",
        evidenceAnchorIds: evidence,
        followUp: this.request(packet, "request_disagreement_verification", [], "the full notes column, including the geotechnical reference", dis.disagreementId),
      };
      return env;
    }
    if (supported.length === 1) {
      env.adjudication = {
        outcome: "accept_claim", disagreementId: dis.disagreementId, acceptedClaimRef: supported[0], correctedValue: null, correctedUnit: null,
        rationale: `the reopened source supports ${supported[0]} and reads against ${contradicted.join(", ") || "the others"}; one anchored reading outweighs any number that agree without one`,
        evidenceAnchorIds: evidence, followUp: null,
      };
      return env;
    }
    env.adjudication = {
      outcome: "needs_human", disagreementId: dis.disagreementId, acceptedClaimRef: null, correctedValue: null, correctedUnit: null,
      rationale: "the assessments do not single out one supported reading", evidenceAnchorIds: evidence, followUp: null,
    };
    return env;
  }

  composer(packet: WorkPacket): AgentResultEnvelope {
    const env = emptyEnvelope(packet);
    const subject = packet.subjectKey;
    const accepted = packet.context.claims.filter((c) => c.status === "accepted");
    const mine = accepted.filter((c) => c.subjectKey === subject || c.subjectKey.startsWith(`${subject}/`));
    const drawn = mine.find((c) => c.predicate === "drawn_quantity");
    const material = mine.find((c) => c.predicate === "calculated_quantity");
    const open = packet.context.disagreements.filter((d) => String(d.subjectSignature.subject_key ?? "").length > 0);
    if (mine.length === 0) {
      env.decisions.push({
        decisionType: "request_information", title: `${subject}: nothing accepted yet`,
        summary: { known: "no accepted claim concerns this subject", conflicts: open.length ? `${open.length} open` : "none recorded", canProceed: "nothing", mustWait: "everything about this subject", supportingEvidence: "none — which is why nothing proceeds" },
        supportingClaimIds: [], contradictingClaimIds: [], riskLevel: "normal", actions: [{ actionType: "review", ownerRole: "reviewer" }],
      });
      return env;
    }
    env.decisions.push({
      decisionType: material ? "release_for_pricing" : "hold",
      title: material ? `${subject}: ${drawn?.value.text ?? "?"} located, ${material.value.text} calculated` : `${subject}: ${drawn?.value.text ?? mine.length} accepted, quantity not yet calculable`,
      summary: {
        known: `${mine.length} accepted claims about ${subject}${drawn ? `; ${drawn.value.text} marks located and counted individually` : ""}`,
        conflicts: open.length ? `${open.length} disagreement(s) still open` : "none open on this subject",
        canProceed: material ? "pricing, on the calculated quantity" : "identification and scope review",
        mustWait: material ? "ordering, until the schedule is confirmed against the located marks" : "any quantity-based action",
        supportingEvidence: `${mine.flatMap((c) => c.anchors).length} anchors on the sheets named in the claims`,
      },
      supportingClaimIds: mine.map((c) => c.ref), contradictingClaimIds: [], riskLevel: "normal",
      actions: [{ actionType: material ? "price" : "review", ownerRole: material ? "estimator" : "reviewer" }],
    });
    return env;
  }

  /* The idempotency fingerprint is over WHAT is asked, never over which task
     asked it — so the same question from a later round is the same question. */
  private request(packet: WorkPacket, actionType: RequestedAgentAction["actionType"], targets: string[], expected: string, about: string = packet.subjectKey): RequestedAgentAction {
    return {
      actionType, reasonCode: `mock_${actionType}`, targetSourceIds: targets, expectedInformation: expected,
      parentTaskId: packet.taskId, currentDepth: packet.context.depth,
      idempotencyFingerprint: fingerprint({ actionType, targets, expected, about }),
    };
  }
}
