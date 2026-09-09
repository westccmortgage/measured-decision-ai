/* SYNTHETIC RECORDS: ONE DOMAIN PACK, EQUAL TO ANY OTHER.
 *
 * A record set declares sheets; a discoverer finds the tables and notes on
 * each sheet; two blind readers read every table and every note; code
 * totals the accepted quantities by category; the kernel does the rest. The
 * pack says what a segment is, who reads it, what a claim may say and how a
 * total is computed. It does not touch the repository, the scheduler or an
 * executor, and the kernel does not know what a "sheet" is.
 */
import type {
  AgentResultEnvelope, AgentRoleDefinition, ClaimRecord, ProposedClaim, SegmentRecord, SourceDescriptor, TaskRecord, WorkPacket,
} from "../../kernel/contracts.ts";
import { KERNEL_TASK_TYPES } from "../../kernel/contracts.ts";
import { DEFAULT_NORMALISERS } from "../../kernel/comparison.ts";
import { emptyEnvelope } from "../../kernel/deterministic.ts";
import type { DomainPack, ExpansionInput, TaskSpec } from "../../kernel/domain.ts";
import { INDEPENDENCE_GROUPS } from "../../kernel/domain.ts";
import { DEFAULT_CATEGORIES } from "./fixture.ts";

export const PACK_ID = "synthetic-records";
export const PACK_VERSION = "1.0";

export const TASK = {
  discoverRegions: `${PACK_ID}:discover_regions`,
  readTable: `${PACK_ID}:read_table`,
  readNote: `${PACK_ID}:read_note`,
  totalByCategory: `${PACK_ID}:total_by_category`,
} as const;

const UNIT_ALIASES: Record<string, string> = { pcs: "each", piece: "each", pieces: "each", ea: "each", each: "each", kilogram: "kg", kilograms: "kg", kgs: "kg", kg: "kg" };
export const KNOWN_UNITS = new Set(["each", "kg"]);

export const ROLES: AgentRoleDefinition[] = [
  {
    roleKey: "region_discoverer", version: "1.0", kind: "discoverer", phase: "discover", taskTypes: [TASK.discoverRegions],
    description: "Finds the tables and notes on one sheet: geometry and kind only, nothing of what they say.",
    /* WHAT A ROLE TELLS A READER IS WHAT A READER CAN OBEY.
     *
     * These contracts used to be a phrase. A real model then answered a real
     * canary, read the sheet correctly, and was refused by this pack's own
     * validateClaim for conventions nobody had told it — "subject E-001 is
     * not an entry", "an entry names its category". The rules were right;
     * the briefing was not. A rule a reader is judged by belongs in the
     * contract the reader is handed. */
    inputContract: "one sheet segment",
    outputContract: "segments[] — one per region found inside this sheet. Each: segmentKind "
      + "\"table\" or \"note\"; parentSegmentId = the sheet you were handed; ordinal from 0 in "
      + "reading order; a label; a contentHash; and a locator whose bbox is four numbers "
      + "normalised 0..1 written as JSON, e.g. \"[0.05,0.1,0.95,0.6]\". No claims: this role "
      + "reports where things are, never what they say.",
    maximumSources: 1, maximumClaims: 0, maximumFollowUpDepth: 0, requiresVisualInput: true, requiresIndependentReading: false,
    allowedActions: [], routingProfile: "visual_analysis", executorKind: "model",
    producesAssessments: false, producesAdjudication: false, producesDecisions: false, producesCalculations: false, producesSegments: true,
  },
  {
    roleKey: "table_reader", version: "1.0", kind: "analyst", phase: "analyze", taskTypes: [TASK.readTable],
    description: "Reads one table blind: one quantity claim per entry, anchored to its row.",
    inputContract: "one table segment",
    outputContract: "claims[] — exactly one per entry row you can read. Each claim: "
      + "predicate \"quantity\"; subjectType \"entry\"; subjectKey in the form \"entry/E-001\" "
      + "(the literal prefix \"entry/\" followed by the row's own code, three digits); unit "
      + "either \"each\" or \"kg\"; value.known true with value.quantity as the number, and "
      + "value.attributes.category naming the row's category. A row you cannot read is "
      + "value.known false with the reason in limitations[], not a guess. Every claim names an "
      + "anchor in anchors[] pointing at that row.",
    maximumSources: 1, maximumClaims: 64, maximumFollowUpDepth: 1, requiresVisualInput: true, requiresIndependentReading: true,
    allowedActions: ["read_reference_segment", "request_human_review"], routingProfile: "visual_analysis", executorKind: "model",
    producesAssessments: false, producesAdjudication: false, producesDecisions: false, producesCalculations: false, producesSegments: false,
  },
  {
    roleKey: "note_reader", version: "1.0", kind: "analyst", phase: "analyze", taskTypes: [TASK.readNote],
    description: "Reads one note blind: what it says about which entry.",
    inputContract: "one note segment",
    outputContract: "claims[] — one per entry the note speaks about. Each claim: predicate "
      + "\"revision_status\"; subjectType \"entry\"; subjectKey in the form \"entry/E-001\"; "
      + "value.text the status the note gives that entry. A note that names no entry produces "
      + "no claims and says so in limitations[]. Every claim names an anchor in anchors[] "
      + "pointing at the note.",
    maximumSources: 1, maximumClaims: 8, maximumFollowUpDepth: 1, requiresVisualInput: false, requiresIndependentReading: true,
    allowedActions: ["request_human_review"], routingProfile: "general_analysis", executorKind: "model",
    producesAssessments: false, producesAdjudication: false, producesDecisions: false, producesCalculations: false, producesSegments: false,
  },
  {
    roleKey: "category_totaliser", version: "1.0", kind: "deriver", phase: "derive", taskTypes: [TASK.totalByCategory],
    description: "Adds the accepted quantities of one category. Code; names every input.",
    inputContract: "accepted entry claims", outputContract: "one derived total naming its inputs",
    maximumSources: 0, maximumClaims: 2, maximumFollowUpDepth: 0, requiresVisualInput: false, requiresIndependentReading: false,
    allowedActions: [], routingProfile: "deterministic", executorKind: "deterministic",
    producesAssessments: false, producesAdjudication: false, producesDecisions: false, producesCalculations: true, producesSegments: false,
  },
];

export const OBJECTIVES: Record<string, string> = {
  [TASK.discoverRegions]: "Find every table and note on this sheet. Return each as a segment with a normalised box inside the sheet. Extract nothing.",
  [TASK.readTable]: "Read this table. Report one quantity claim per entry with its id, category, quantity and unit, anchored to the row. Report an unreadable cell as unknown, never as zero.",
  [TASK.readNote]: "Read this note. Report what it says about which entry, anchored to the note.",
  [TASK.totalByCategory]: "Add the accepted quantities of this category. Name every input claim.",
};

export type SyntheticRecordsOptions = { categories?: string[] };

export class SyntheticRecordsPack implements DomainPack {
  readonly id = PACK_ID;
  readonly version = PACK_VERSION;
  readonly roles = ROLES;
  readonly objectives = OBJECTIVES;
  readonly categories: string[];

  constructor(options: SyntheticRecordsOptions = {}) {
    this.categories = options.categories ?? DEFAULT_CATEGORIES;
  }

  /* Sheets are declared; nothing is discovered at the source level. */
  discovererFor(_source: SourceDescriptor): string | null { return null; }

  expand(input: ExpansionInput): TaskSpec[] {
    const specs: TaskSpec[] = [];
    const sheets = input.segments.filter((s) => s.segmentKind === "sheet" && s.parentSegmentId === null && s.status === "accepted");
    const regions = input.segments.filter((s) => s.parentSegmentId !== null && s.status === "accepted" && (s.segmentKind === "table" || s.segmentKind === "note"));
    const sourceOrdinal = (sourceId: string) => input.manifest.sources.find((x) => x.sourceId === sourceId)?.ordinal ?? 0;
    const sheetKey = (sheet: SegmentRecord) => `sheet/${sourceOrdinal(sheet.sourceId)}/${sheet.ordinal}`;

    for (const sheet of sheets) {
      specs.push({ key: `discover:${sheet.segmentId}`, phase: "discover", taskType: TASK.discoverRegions, roleKey: "region_discoverer", subjectKey: sheetKey(sheet), sources: [{ sourceId: null, segmentId: sheet.segmentId }], independenceGroup: null, priority: 30, dependsOn: [], dependsOnTaskIds: [] });
    }

    const readerKeys: string[] = [];
    const compareKeys: string[] = [];
    for (const region of regions) {
      const sheet = input.segments.find((s) => s.segmentId === region.parentSegmentId);
      if (!sheet) continue;
      const subject = `${sheetKey(sheet)}/region/${region.ordinal}`;
      const taskType = region.segmentKind === "table" ? TASK.readTable : TASK.readNote;
      const roleKey = region.segmentKind === "table" ? "table_reader" : "note_reader";
      const groups = INDEPENDENCE_GROUPS.slice(0, Math.min(2, input.policy.maximumIndependentReadersPerSubject));
      const keys = groups.map((g) => `read:${region.segmentId}:${g}`);
      for (const [i, g] of groups.entries()) {
        specs.push({ key: keys[i], phase: "analyze", taskType, roleKey, subjectKey: subject, sources: [{ sourceId: null, segmentId: region.segmentId }], independenceGroup: g, priority: 100, dependsOn: [], dependsOnTaskIds: [] });
      }
      const compareKey = `compare:${region.segmentId}`;
      specs.push({ key: compareKey, phase: "compare", taskType: KERNEL_TASK_TYPES.compare, roleKey: "claim_comparator", subjectKey: subject, sources: [], independenceGroup: null, priority: 200, dependsOn: keys.map((k) => ({ key: k, kind: "requires_claims" as const })), dependsOnTaskIds: [] });
      if (region.segmentKind === "table") { readerKeys.push(...keys); compareKeys.push(compareKey); }
    }

    /* Totals wait until every sheet has been discovered: a total over the
       tables found so far is not a total. */
    const discoveryDone = sheets.length > 0 && sheets.every((sheet) => input.tasks.some((t) => t.taskType === TASK.discoverRegions && t.state === "completed" && t.sources.some((s) => s.segmentId === sheet.segmentId)));
    if (discoveryDone && readerKeys.length) {
      for (const category of this.categories) {
        specs.push({
          key: `total:${category}`, phase: "derive", taskType: TASK.totalByCategory, roleKey: "category_totaliser", subjectKey: `category/${category}`, sources: [],
          independenceGroup: null, priority: 500,
          dependsOn: [...readerKeys.map((k) => ({ key: k, kind: "requires_claims" as const })), ...compareKeys.map((k) => ({ key: k, kind: "requires_completion" as const }))],
          dependsOnTaskIds: [],
        });
      }
    }
    return specs;
  }

  decisionSubjects(claims: ClaimRecord[]): string[] {
    return [...new Set(claims.filter((c) => c.status === "accepted" && c.subjectType === "category").map((c) => c.subjectKey))].sort();
  }

  validateClaim(packet: WorkPacket, claim: ProposedClaim, _envelope: AgentResultEnvelope): string[] {
    const p: string[] = [];
    switch (packet.taskType) {
      case TASK.readTable:
        if (claim.predicate !== "quantity") p.push(`claim ${claim.claimKey}: a table reader reports quantity, not ${claim.predicate}`);
        if (claim.subjectType !== "entry" || !/^entry\/E-\d{3}$/.test(claim.subjectKey)) p.push(`claim ${claim.claimKey}: subject ${claim.subjectKey} is not an entry`);
        if (claim.value.known && !KNOWN_UNITS.has(this.normaliseUnit(claim.unit) ?? "")) p.push(`claim ${claim.claimKey}: unit ${claim.unit} is not one this pack knows`);
        if (claim.value.known && typeof claim.value.attributes?.category !== "string") p.push(`claim ${claim.claimKey}: an entry names its category`);
        break;
      case TASK.readNote:
        if (claim.predicate !== "revision_status") p.push(`claim ${claim.claimKey}: a note reader reports revision_status, not ${claim.predicate}`);
        if (claim.subjectType !== "entry") p.push(`claim ${claim.claimKey}: a note is about an entry`);
        break;
      case TASK.totalByCategory:
        if (claim.predicate !== "total_quantity" || claim.subjectType !== "category") p.push(`claim ${claim.claimKey}: a total is total_quantity of a category`);
        break;
      default:
        if (packet.taskType.startsWith(`${PACK_ID}:`)) p.push(`claim ${claim.claimKey}: ${packet.taskType} produces no claims`);
    }
    return p;
  }

  normaliseUnit(unit: string | null): string | null {
    if (unit === null || unit === undefined) return null;
    const u = unit.trim().toLowerCase();
    return UNIT_ALIASES[u] ?? u;
  }
  normaliseKey(key: string): string { return DEFAULT_NORMALISERS.key(key); }

  isRelated(target: SegmentRecord, task: TaskRecord, segments: SegmentRecord[]): boolean {
    const own = task.sources.map((s) => segments.find((x) => x.segmentId === s.segmentId)).filter(Boolean) as SegmentRecord[];
    return own.some((o) => o.segmentId === target.parentSegmentId || o.parentSegmentId === target.segmentId || (o.parentSegmentId !== null && o.parentSegmentId === target.parentSegmentId));
  }
  isReference(segment: SegmentRecord): boolean { return segment.segmentKind === "note"; }
  linkedSegments(segment: SegmentRecord, segments: SegmentRecord[]): SegmentRecord[] {
    if (segment.segmentKind !== "table") return [];
    return segments.filter((s) => s.segmentKind === "note" && s.parentSegmentId === segment.parentSegmentId);
  }

  /* The total: code, over accepted inputs, naming each. A category whose
     accepted entries carry two units is not totalled — it is reported
     unknown, with the reason. */
  async derive(packet: WorkPacket): Promise<AgentResultEnvelope> {
    const env = emptyEnvelope(packet);
    const category = packet.subjectKey.replace(/^category\//, "");
    const inputs = packet.context.claims.filter((c) => c.status === "accepted" && c.predicate === "quantity" && c.value.known && String(c.value.attributes?.category ?? "").toLowerCase() === category);
    if (inputs.length === 0) { env.outcome = "insufficient_evidence"; env.limitations.push(`no accepted quantity of category ${category}`); return env; }
    const places = [...new Set(inputs.flatMap((c) => c.anchors.map((a) => a.segmentId)).filter(Boolean) as string[])];
    for (const [i, segmentId] of places.entries()) {
      const anchor = inputs.flatMap((c) => c.anchors).find((a) => a.segmentId === segmentId)!;
      env.anchors.push({ anchorKey: `in-${i}`, sourceKind: "segment", sourceId: anchor.sourceId, segmentId, locator: {}, quotedText: null });
    }
    const units = [...new Set(inputs.map((c) => this.normaliseUnit(c.unit)))];
    const anchorKeys = env.anchors.map((a) => a.anchorKey);
    if (units.length !== 1) {
      env.claims.push({ claimKey: "total", subjectType: "category", subjectKey: packet.subjectKey, predicate: "total_quantity", value: { known: false, quantity: null, text: null, attributes: { entries_counted: inputs.length } }, unit: null, observationBasis: "derived", scope: {}, anchorKeys, machineConfidence: null, inputClaimIds: inputs.map((c) => c.ref) });
      env.limitations.push(`category ${category} mixes units ${units.join(", ")}; no total is given`);
      return env;
    }
    const total = inputs.reduce((n, c) => n + (c.value.quantity ?? 0), 0);
    env.claims.push({
      claimKey: "total", subjectType: "category", subjectKey: packet.subjectKey, predicate: "total_quantity",
      value: { known: true, quantity: total, text: `${total} ${units[0]}`, attributes: { entries_counted: inputs.length } }, unit: units[0],
      observationBasis: "derived", scope: {}, anchorKeys, machineConfidence: null, inputClaimIds: inputs.map((c) => c.ref),
    });
    env.calculations.push({ calculationKey: `sum-${category}`, formula: inputs.map((c) => c.value.quantity).join(" + "), inputClaimIds: inputs.map((c) => c.ref), unit: units[0], wasteAssumption: null, rounding: "none", result: total });
    return env;
  }
}
