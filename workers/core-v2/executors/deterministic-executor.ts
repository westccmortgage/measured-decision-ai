/* THE ROLES THAT ARE CODE.
 *
 * A model never does arithmetic here and never decides which reader was
 * better. The ingestor copies identity the manifest already established; the
 * comparator lines readings up; the counter counts accepted instances and
 * names each one it counted; the calculator applies a written formula to
 * accepted inputs and refuses when an input is missing. Every claim these
 * produce names the claims it was computed from.
 */
import { compareClaims } from "../comparison.ts";
import type {
  AgentResultEnvelope, PacketClaim, ProposedAnchor, ProposedCalculation, ProposedClaim, WorkPacket,
} from "../contracts.ts";
import { PACKET_VERSION } from "../contracts.ts";
import type { AgentExecutor } from "./executor.ts";

export function emptyEnvelope(packet: WorkPacket, outcome: AgentResultEnvelope["outcome"] = "completed"): AgentResultEnvelope {
  return {
    packetVersion: PACKET_VERSION, taskId: packet.taskId, roleKey: packet.roleKey, roleVersion: packet.roleVersion,
    outcome, claims: [], anchors: [], assessments: [], disagreements: [], requestedActions: [], limitations: [],
    rawResponseReference: null, adjudication: null, decisions: [], calculations: [],
  };
}

/* Assembly rules, versioned code — never a prompt. A family that has no rule
   here has no calculated quantity, and the calculator says so. */
export const ASSEMBLY_RULES: Record<string, { formula: string; perTypeInput: string; unit: string; rounding: string; waste: string }> = {
  "PIER-P": { formula: "sum over pier types of (accepted instances of type × printed concrete volume per pier)", perTypeInput: "concrete_volume_each", unit: "cy", rounding: "up to 0.1 cy", waste: "none" },
};

export class DeterministicExecutor implements AgentExecutor {
  readonly family = "deterministic";

  async execute(packet: WorkPacket): Promise<AgentResultEnvelope> {
    switch (packet.taskType) {
      case "plan_workflow": return emptyEnvelope(packet);
      case "ingest_page": return this.ingest(packet);
      case "detect_disagreements": return this.compare(packet);
      case "count_instances": return this.count(packet);
      case "derive_materials": return this.calculate(packet);
      default: {
        const env = emptyEnvelope(packet, "failed_known");
        env.limitations.push(`${packet.taskType} is not a deterministic task`);
        return env;
      }
    }
  }

  ingest(packet: WorkPacket): AgentResultEnvelope {
    const env = emptyEnvelope(packet);
    const page = packet.sources.find((s) => s.kind === "page");
    if (!page) { env.outcome = "failed_known"; env.limitations.push("no page in the packet"); return env; }
    const anchor: ProposedAnchor = {
      anchorKey: "page", sourceKind: "page_bbox", documentId: page.documentId, pageId: page.pageId, regionId: null,
      bbox: [0, 0, 1, 1], quotedText: null, locator: { ...page.locator },
    };
    env.anchors.push(anchor);
    env.claims.push({
      claimKey: "sheet", subjectType: "document_identity", subjectKey: page.pageId!, predicate: "printed_sheet_number",
      value: { known: page.locator.sheet !== "", quantity: null, text: page.locator.sheet === "" ? null : String(page.locator.sheet) },
      unit: null, observationBasis: "printed", scope: {}, anchorKeys: ["page"], machineConfidence: null,
    });
    env.claims.push({
      claimKey: "hash", subjectType: "document_identity", subjectKey: page.pageId!, predicate: "content_hash",
      value: { known: true, quantity: null, text: page.contentHash }, unit: null, observationBasis: "calculated",
      scope: {}, anchorKeys: ["page"], machineConfidence: null,
    });
    return env;
  }

  compare(packet: WorkPacket): AgentResultEnvelope {
    const env = emptyEnvelope(packet);
    const claims = packet.context.claims.map((c: PacketClaim) => ({
      claimId: c.ref, independenceGroup: c.independenceGroup, subjectType: c.subjectType, subjectKey: c.subjectKey,
      predicate: c.predicate, value: c.value, unit: c.unit, observationBasis: c.observationBasis, scope: c.scope,
    }));
    const readers = packet.dependencies.map((d) => d.independenceGroup).filter(Boolean) as string[];
    const result = compareClaims(packet.workflowId, packet.subjectKey, claims, readers);
    env.disagreements = result.disagreements;
    env.limitations.push(`agreements=${result.agreements.length} disagreements=${result.disagreements.length}`);
    /* Agreement groups travel as calculations of a sort: which claims agreed.
       The scheduler reads them from here rather than from a side channel. */
    env.calculations = result.agreements.map((g, i): ProposedCalculation => ({
      calculationKey: `agreement-${i}`, formula: "identical normalised subject, predicate, scope, value, unit and basis",
      inputClaimIds: g.claimIds, unit: null, wasteAssumption: null, rounding: null, result: g.claimIds.length,
    }));
    return env;
  }

  count(packet: WorkPacket): AgentResultEnvelope {
    const env = emptyEnvelope(packet);
    const family = packet.subjectKey;
    const instances = packet.context.claims.filter((c) => c.subjectType === "component_instance" && c.status === "accepted" && c.subjectKey.startsWith(`${family}/`));
    if (instances.length === 0) {
      env.outcome = "insufficient_evidence";
      env.limitations.push(`no accepted component instances of ${family} — the count is unknown, not zero`);
      return env;
    }
    const byMark = new Map<string, PacketClaim[]>();
    for (const c of instances) {
      const mark = c.subjectKey.slice(family.length + 1).toUpperCase().replace(/[\s\-_.]+/g, "");
      byMark.set(mark, [...(byMark.get(mark) ?? []), c]);
    }
    const duplicates = [...byMark.entries()].filter(([, cs]) => cs.length > 1).map(([m]) => m);
    if (duplicates.length) env.limitations.push(`marks seen more than once, counted once: ${duplicates.join(", ")}`);
    const anchorKeys: string[] = [];
    const inputClaimIds: string[] = [];
    for (const [mark, cs] of byMark) {
      const first = cs[0];
      const box = first.anchors.find((a) => a.sourceKind === "page_bbox" && a.bbox) ?? first.anchors[0];
      const key = `mark-${mark}`;
      env.anchors.push({
        anchorKey: key, sourceKind: "page_bbox", documentId: box.documentId, pageId: box.pageId, regionId: box.regionId,
        bbox: box.bbox, quotedText: null, locator: { ...box.locator, mark },
      });
      anchorKeys.push(key);
      inputClaimIds.push(...cs.map((c) => c.ref));
    }
    const perType = new Map<string, number>();
    for (const [, cs] of byMark) {
      const type = String(cs[0].value.attributes?.mark_type ?? "");
      if (type) perType.set(type, (perType.get(type) ?? 0) + 1);
    }
    env.claims.push({
      claimKey: "drawn", subjectType: "component_type", subjectKey: family, predicate: "drawn_quantity",
      value: { known: true, quantity: byMark.size, text: String(byMark.size), attributes: Object.fromEntries([...perType].map(([t, n]) => [`count_${t}`, n])) },
      unit: "each", observationBasis: "counted_marks", scope: {}, anchorKeys, machineConfidence: null, inputClaimIds,
    });
    env.calculations.push({
      calculationKey: "count", formula: "number of distinct normalised marks among accepted component-instance claims",
      inputClaimIds, unit: "each", wasteAssumption: null, rounding: null, result: byMark.size,
    });
    return env;
  }

  calculate(packet: WorkPacket): AgentResultEnvelope {
    const env = emptyEnvelope(packet);
    const family = packet.subjectKey;
    const rule = ASSEMBLY_RULES[family];
    if (!rule) {
      env.outcome = "insufficient_evidence";
      env.limitations.push(`no assembly rule is written for ${family}; nothing is calculated`);
      return env;
    }
    /* Only a counted quantity — code's own, named mark by mark — is an input.
       A reader's number for the family is not a count, whatever it is called. */
    const drawn = packet.context.claims.find((c) => c.subjectKey === family && c.predicate === "drawn_quantity" && c.observationBasis === "counted_marks" && c.status === "accepted");
    if (!drawn || !drawn.value.known || drawn.value.quantity === null) {
      env.outcome = "insufficient_evidence";
      env.limitations.push(`no accepted drawn quantity for ${family}`);
      return env;
    }
    const counts = Object.entries(drawn.value.attributes ?? {}).filter(([k]) => k.startsWith("count_")).map(([k, v]) => [k.slice(6), Number(v)] as const);
    if (counts.length === 0) {
      env.outcome = "insufficient_evidence";
      env.limitations.push(`the drawn quantity of ${family} is not broken down by type; the rule needs a volume per type`);
      return env;
    }
    let total = 0;
    const inputs = [drawn.ref];
    const anchorKeys: string[] = [];
    for (const [type, n] of counts) {
      const per = packet.context.claims.find((c) => c.subjectKey === type && c.predicate === rule.perTypeInput && c.status === "accepted" && c.value.known && c.value.quantity !== null);
      if (!per) {
        env.outcome = "insufficient_evidence";
        env.limitations.push(`no accepted ${rule.perTypeInput} for ${type} — a missing input is not invented`);
        return env;
      }
      total += n * per.value.quantity!;
      inputs.push(per.ref);
      const a = per.anchors[0];
      const key = `input-${type}`;
      env.anchors.push({ anchorKey: key, sourceKind: a.sourceKind, documentId: a.documentId, pageId: a.pageId, regionId: a.regionId, bbox: a.bbox, quotedText: a.quotedText, locator: a.locator });
      anchorKeys.push(key);
    }
    const rounded = Math.ceil(total * 10) / 10;
    const d = drawn.anchors[0];
    env.anchors.push({ anchorKey: "count", sourceKind: d.sourceKind, documentId: d.documentId, pageId: d.pageId, regionId: d.regionId, bbox: d.bbox, quotedText: null, locator: d.locator });
    env.claims.push({
      claimKey: "material", subjectType: "material", subjectKey: `${family}/concrete`, predicate: "calculated_quantity",
      value: { known: true, quantity: rounded, text: `${rounded} ${rule.unit}` }, unit: rule.unit, observationBasis: "calculated",
      scope: {}, anchorKeys: [...anchorKeys, "count"], machineConfidence: null, inputClaimIds: inputs,
    });
    env.calculations.push({ calculationKey: "material", formula: rule.formula, inputClaimIds: inputs, unit: rule.unit, wasteAssumption: rule.waste, rounding: rule.rounding, result: rounded });
    return env;
  }
}
