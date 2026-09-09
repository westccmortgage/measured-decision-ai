/* SYNTHETIC TRANSCRIPTS: A SECOND DOMAIN, SO THE KERNEL IS NOT SECRETLY THE FIRST.
 *
 * Recordings declare no segments; a discoverer finds scenes as time ranges;
 * two blind readers count the speaker turns of every scene; code adds them
 * per recording. Same kernel, same states, same evidence discipline; a
 * different notion of "segment", "place" and "subject".
 */
import type {
  AgentResultEnvelope, AgentRoleDefinition, ClaimRecord, ProposedClaim, SegmentRecord, SourceDescriptor, TaskRecord, WorkPacket,
} from "../../kernel/contracts.ts";
import { KERNEL_TASK_TYPES } from "../../kernel/contracts.ts";
import { DEFAULT_NORMALISERS } from "../../kernel/comparison.ts";
import { emptyEnvelope } from "../../kernel/deterministic.ts";
import type { DomainPack, ExpansionInput, TaskSpec } from "../../kernel/domain.ts";
import { INDEPENDENCE_GROUPS } from "../../kernel/domain.ts";

export const PACK_ID = "synthetic-transcripts";
export const PACK_VERSION = "1.0";

export const TASK = {
  discoverScenes: `${PACK_ID}:discover_scenes`,
  readScene: `${PACK_ID}:read_scene`,
  sumTurns: `${PACK_ID}:sum_turns`,
} as const;

export const ROLES: AgentRoleDefinition[] = [
  {
    roleKey: "scene_discoverer", version: "1.0", kind: "discoverer", phase: "discover", taskTypes: [TASK.discoverScenes],
    description: "Finds the scenes of one recording as time ranges. Transcribes nothing.",
    inputContract: "one recording", outputContract: "scene segments with time ranges",
    maximumSources: 1, maximumClaims: 0, maximumFollowUpDepth: 0, requiresVisualInput: false, requiresIndependentReading: false,
    allowedActions: [], routingProfile: "general_analysis", executorKind: "model",
    producesAssessments: false, producesAdjudication: false, producesDecisions: false, producesCalculations: false, producesSegments: true,
  },
  {
    roleKey: "scene_reader", version: "1.0", kind: "analyst", phase: "analyze", taskTypes: [TASK.readScene],
    description: "Reads one scene blind: its topic and how many speaker turns it holds, anchored to the time range.",
    inputContract: "one scene segment", outputContract: "one speaker_turns claim with a time-range anchor",
    maximumSources: 1, maximumClaims: 4, maximumFollowUpDepth: 1, requiresVisualInput: false, requiresIndependentReading: true,
    allowedActions: ["read_related_segment", "request_human_review"], routingProfile: "general_analysis", executorKind: "model",
    producesAssessments: false, producesAdjudication: false, producesDecisions: false, producesCalculations: false, producesSegments: false,
  },
  {
    roleKey: "turn_totaliser", version: "1.0", kind: "deriver", phase: "derive", taskTypes: [TASK.sumTurns],
    description: "Adds the accepted speaker turns of one recording. Code; names every input.",
    inputContract: "accepted scene claims", outputContract: "one derived total naming its inputs",
    maximumSources: 0, maximumClaims: 2, maximumFollowUpDepth: 0, requiresVisualInput: false, requiresIndependentReading: false,
    allowedActions: [], routingProfile: "deterministic", executorKind: "deterministic",
    producesAssessments: false, producesAdjudication: false, producesDecisions: false, producesCalculations: true, producesSegments: false,
  },
];

export const OBJECTIVES: Record<string, string> = {
  [TASK.discoverScenes]: "Find every scene of this recording. Return each as a segment with a time range. Transcribe nothing.",
  [TASK.readScene]: "Read this scene. Report its topic and the number of speaker turns, anchored to the time range you read.",
  [TASK.sumTurns]: "Add the accepted speaker turns of this recording. Name every input claim.",
};

export class SyntheticTranscriptsPack implements DomainPack {
  readonly id = PACK_ID;
  readonly version = PACK_VERSION;
  readonly roles = ROLES;
  readonly objectives = OBJECTIVES;

  discovererFor(source: SourceDescriptor): string | null { return source.sourceKind === "recording" ? "scene_discoverer" : null; }

  expand(input: ExpansionInput): TaskSpec[] {
    const specs: TaskSpec[] = [];
    const scenes = input.segments.filter((s) => s.segmentKind === "scene" && s.status === "accepted");
    const ordinalOf = (sourceId: string) => input.manifest.sources.find((x) => x.sourceId === sourceId)?.ordinal ?? 0;
    const bySource = new Map<string, SegmentRecord[]>();
    for (const scene of scenes) bySource.set(scene.sourceId, [...(bySource.get(scene.sourceId) ?? []), scene]);
    for (const [sourceId, list] of bySource) {
      const readerKeys: string[] = [];
      const compareKeys: string[] = [];
      for (const scene of list) {
        const subject = `recording/${ordinalOf(sourceId)}/scene/${scene.ordinal}`;
        const groups = INDEPENDENCE_GROUPS.slice(0, Math.min(2, input.policy.maximumIndependentReadersPerSubject));
        const keys = groups.map((g) => `read:${scene.segmentId}:${g}`);
        groups.forEach((g, i) => specs.push({ key: keys[i], phase: "analyze", taskType: TASK.readScene, roleKey: "scene_reader", subjectKey: subject, sources: [{ sourceId: null, segmentId: scene.segmentId }], independenceGroup: g, priority: 100, dependsOn: [], dependsOnTaskIds: [] }));
        const compareKey = `compare:${scene.segmentId}`;
        specs.push({ key: compareKey, phase: "compare", taskType: KERNEL_TASK_TYPES.compare, roleKey: "claim_comparator", subjectKey: subject, sources: [], independenceGroup: null, priority: 200, dependsOn: keys.map((k) => ({ key: k, kind: "requires_claims" as const })), dependsOnTaskIds: [] });
        readerKeys.push(...keys); compareKeys.push(compareKey);
      }
      const discovered = input.tasks.some((t) => t.taskType === TASK.discoverScenes && t.state === "completed" && t.sources.some((s) => s.sourceId === sourceId));
      if (discovered && readerKeys.length) {
        specs.push({ key: `sum:${sourceId}`, phase: "derive", taskType: TASK.sumTurns, roleKey: "turn_totaliser", subjectKey: `recording/${ordinalOf(sourceId)}`, sources: [], independenceGroup: null, priority: 500,
          dependsOn: [...readerKeys.map((k) => ({ key: k, kind: "requires_claims" as const })), ...compareKeys.map((k) => ({ key: k, kind: "requires_completion" as const }))], dependsOnTaskIds: [] });
      }
    }
    return specs;
  }

  decisionSubjects(claims: ClaimRecord[]): string[] {
    return [...new Set(claims.filter((c) => c.status === "accepted" && c.subjectType === "recording").map((c) => c.subjectKey))].sort();
  }

  validateClaim(packet: WorkPacket, claim: ProposedClaim, _envelope: AgentResultEnvelope): string[] {
    const p: string[] = [];
    if (packet.taskType === TASK.readScene) {
      if (claim.predicate !== "speaker_turns") p.push(`claim ${claim.claimKey}: a scene reader reports speaker_turns`);
      if (claim.subjectType !== "scene") p.push(`claim ${claim.claimKey}: the subject of a scene reading is the scene`);
      if (claim.value.known && (claim.value.quantity === null || !Number.isInteger(claim.value.quantity) || claim.value.quantity < 0)) p.push(`claim ${claim.claimKey}: speaker turns are a whole number`);
      if (claim.unit !== "turns") p.push(`claim ${claim.claimKey}: the unit of speaker turns is turns`);
    } else if (packet.taskType === TASK.sumTurns) {
      if (claim.predicate !== "total_speaker_turns" || claim.subjectType !== "recording") p.push(`claim ${claim.claimKey}: a total is total_speaker_turns of a recording`);
    } else if (packet.taskType.startsWith(`${PACK_ID}:`)) p.push(`claim ${claim.claimKey}: ${packet.taskType} produces no claims`);
    return p;
  }

  normaliseUnit(unit: string | null): string | null { return unit === null || unit === undefined ? null : unit.trim().toLowerCase(); }
  normaliseKey(key: string): string { return DEFAULT_NORMALISERS.key(key); }

  isRelated(target: SegmentRecord, task: TaskRecord, segments: SegmentRecord[]): boolean {
    const own = task.sources.map((s) => segments.find((x) => x.segmentId === s.segmentId)).filter(Boolean) as SegmentRecord[];
    return own.some((o) => o.sourceId === target.sourceId && Math.abs(o.ordinal - target.ordinal) === 1);
  }
  isReference(_segment: SegmentRecord): boolean { return false; }
  linkedSegments(_segment: SegmentRecord, _segments: SegmentRecord[]): SegmentRecord[] { return []; }

  async derive(packet: WorkPacket): Promise<AgentResultEnvelope> {
    const env = emptyEnvelope(packet);
    const inputs = packet.context.claims.filter((c) => c.status === "accepted" && c.predicate === "speaker_turns" && c.value.known);
    if (inputs.length === 0) { env.outcome = "insufficient_evidence"; env.limitations.push("no accepted scene reading"); return env; }
    const places = [...new Set(inputs.flatMap((c) => c.anchors.map((a) => a.segmentId)).filter(Boolean) as string[])];
    places.forEach((segmentId, i) => {
      const anchor = inputs.flatMap((c) => c.anchors).find((a) => a.segmentId === segmentId)!;
      env.anchors.push({ anchorKey: `in-${i}`, sourceKind: "segment", sourceId: anchor.sourceId, segmentId, locator: {}, quotedText: null });
    });
    const total = inputs.reduce((n, c) => n + (c.value.quantity ?? 0), 0);
    env.claims.push({
      claimKey: "total", subjectType: "recording", subjectKey: packet.subjectKey, predicate: "total_speaker_turns",
      value: { known: true, quantity: total, text: `${total} turns`, attributes: { scenes_counted: inputs.length } }, unit: "turns",
      observationBasis: "derived", scope: {}, anchorKeys: env.anchors.map((a) => a.anchorKey), machineConfidence: null, inputClaimIds: inputs.map((c) => c.ref),
    });
    env.calculations.push({ calculationKey: "sum-turns", formula: inputs.map((c) => c.value.quantity).join(" + "), inputClaimIds: inputs.map((c) => c.ref), unit: "turns", wasteAssumption: null, rounding: "none", result: total });
    return env;
  }
}
