/* WHAT AN AGENT IS HANDED, AND NOTHING ELSE.
 *
 * A packet carries exactly the sources the assignment needs, by immutable id
 * and hash; the dependencies it may rely on; its limits; and whatever of other
 * agents' work the visibility policy lets this role see — already filtered,
 * already anonymised, already cut to the subject. It carries no URL, no key,
 * no provider name, and, for a reader that must be blind, no other reader's
 * answer.
 *
 * A packet past the policy's size is not built. A composer sees only the
 * accepted claims of its own subject and what those claims were computed
 * from; a decision about A cannot cite evidence about B because B is not in
 * the packet.
 */
import type {
  AgentRoleDefinition, ClaimRecord, DependencyReference, PacketAnchor, PacketAssessment, PacketClaim,
  PacketDisagreement, SegmentRecord, SourceDescriptor, SourceManifest, SourceReference, TaskRecord, TaskSourceRef, WorkPacket,
} from "./contracts.ts";
import { PACKET_VERSION } from "./contracts.ts";
import type { DomainPack } from "./domain.ts";
import { fingerprint } from "./ids.ts";
import type { Lookup } from "./planning.ts";
import { hashOfRef } from "./planning.ts";
import type { OrchestrationPolicy } from "./policy.ts";
import type { OrchestrationRepository } from "./repository.ts";
import { KERNEL_OBJECTIVES, type RoleRegistry } from "./roles.ts";
import { anonymize, assertPacketRespectsVisibility, scrubLocator, scrubScope, visibilityFor } from "./visibility.ts";

export type BuiltPacket = { packet: WorkPacket; refToClaimId: Record<string, string> };

export type PacketContext = {
  manifest: SourceManifest;
  lookup: Lookup;
  repo: OrchestrationRepository;
  registry: RoleRegistry;
  pack: DomainPack;
  policy: OrchestrationPolicy;
};

export class PacketOverBudget extends Error {}

export function sourceReference(ref: TaskSourceRef, lookup: Lookup): SourceReference {
  if (ref.segmentId) {
    const segment = lookup.segments.get(ref.segmentId);
    if (!segment) throw new Error(`core-v2: segment ${ref.segmentId} is not in the record`);
    const source = lookup.sources.get(segment.sourceId);
    if (!source) throw new Error(`core-v2: source ${segment.sourceId} is not in the manifest`);
    return {
      sourceId: source.sourceId, segmentId: segment.segmentId, kind: "segment", sourceKind: source.sourceKind, segmentKind: segment.segmentKind,
      parentSegmentId: segment.parentSegmentId, label: segment.label, ordinal: segment.ordinal, locator: scrubLocator(segment.locator), contentHash: segment.contentHash,
    };
  }
  const source = ref.sourceId ? lookup.sources.get(ref.sourceId) : null;
  if (!source) throw new Error(`core-v2: source ${ref.sourceId} is not in the manifest`);
  return {
    sourceId: source.sourceId, segmentId: null, kind: "source", sourceKind: source.sourceKind, segmentKind: null, parentSegmentId: null,
    label: source.label, ordinal: source.ordinal, locator: {}, contentHash: hashOfRef(ref, lookup),
  };
}

export async function buildPacket(task: TaskRecord, ctx: PacketContext): Promise<BuiltPacket> {
  const { repo, lookup, policy, pack } = ctx;
  const role = ctx.registry.role(task.roleKey);
  const rules = visibilityFor(role);
  const sources = task.sources.map((ref) => sourceReference(ref, lookup));
  const deps = await repo.getDependencies(task.taskId);

  const dependencies: DependencyReference[] = [];
  const refToClaimId: Record<string, string> = {};
  let claims: PacketClaim[] = [];
  let assessments: PacketAssessment[] = [];
  let disagreements: PacketDisagreement[] = [];
  const validation: string[] = [];

  /* A claim as another role sees it: scope and locators cut to the keys the
     kernel defines, so whatever a reader wrote there travels to nobody. */
  const toPacketClaim = async (c: ClaimRecord, withGroup: boolean): Promise<PacketClaim> => {
    const anchors = await repo.listAnchors([c.claimId]);
    return {
      ref: c.claimId, subjectType: c.subjectType, subjectKey: c.subjectKey, predicate: c.predicate,
      value: c.value, unit: c.unit, observationBasis: c.observationBasis, scope: scrubScope(c.scope), status: c.status,
      independenceGroup: withGroup ? c.independenceGroup : null, inputRefs: [...c.inputClaimIds],
      anchors: anchors.map((a): PacketAnchor => ({ anchorId: a.anchorId, sourceKind: a.sourceKind, sourceId: a.sourceId, segmentId: a.segmentId, locator: scrubLocator(a.locator), quotedText: a.quotedText })),
    };
  };

  for (const d of deps) {
    const claimIds = rules.claims === "none" || rules.claims === "anonymized_competing" ? [] :
      (await repo.listClaims({ workflowId: task.workflowId, taskIds: [d.dependsOnTaskId] })).map((c) => c.claimId);
    const independenceGroup = role.kind === "comparator" ? ((await repo.getTask(d.dependsOnTaskId))?.independenceGroup ?? null) : null;
    dependencies.push({ taskId: d.dependsOnTaskId, kind: d.kind, claimIds, independenceGroup });
  }

  if (rules.claims === "own_dependencies") {
    for (const d of dependencies) for (const id of d.claimIds) {
      const c = await repo.getClaim(id);
      if (c) { claims.push(await toPacketClaim(c, false)); refToClaimId[id] = id; }
    }
  } else if (rules.claims === "all_relevant") {
    for (const c of await relevantClaimsFor(task, role, repo, pack)) {
      claims.push(await toPacketClaim(c, role.kind === "comparator"));
      refToClaimId[c.claimId] = c.claimId;
    }
    if (role.kind === "composer") {
      const ids = new Set(claims.map((c) => c.ref));
      disagreements = (await repo.listDisagreements(task.workflowId))
        .filter((d) => d.claimIds.some((id) => ids.has(id)) || pack.normaliseKey(String(d.subjectSignature.subject_key ?? "")) === pack.normaliseKey(task.subjectKey))
        .map((d) => ({ disagreementId: d.disagreementId, kind: d.kind, severity: d.severity, subjectSignature: d.subjectSignature, claimRefs: d.claimIds.filter((id) => ids.has(id)).sort() }));
    }
  } else if (rules.claims === "anonymized_competing") {
    const dis = task.disagreementId ? await repo.getDisagreement(task.disagreementId) : null;
    const competing = dis ? dis.claimIds : task.targetClaimIds;
    const raw: PacketClaim[] = [];
    for (const id of competing) {
      const c = await repo.getClaim(id);
      if (c) raw.push(await toPacketClaim(c, false));
    }
    const anon = anonymize(raw);
    claims = anon.claims;
    for (const [letter, id] of Object.entries(anon.map)) refToClaimId[letter] = id;
    const idToLetter = Object.fromEntries(Object.entries(anon.map).map(([l, id]) => [id, l]));
    if (rules.assessments) {
      assessments = (await repo.listAssessments(competing)).map((a) => ({
        claimRef: idToLetter[a.claimId], assessment: a.assessment, reasonCode: a.reasonCode,
        explanation: a.explanation, anchorIds: a.anchorIds, proposedValue: a.proposedValue, proposedUnit: a.proposedUnit,
      })).sort((x, y) => x.claimRef.localeCompare(y.claimRef) || x.reasonCode.localeCompare(y.reasonCode));
    }
    if (rules.disagreements && dis) {
      disagreements = [{
        disagreementId: dis.disagreementId, kind: dis.kind, severity: dis.severity, subjectSignature: dis.subjectSignature,
        claimRefs: dis.claimIds.map((id) => idToLetter[id]).filter(Boolean).sort(),
      }];
    }
    if (rules.validation) validation.push(...deterministicValidationNotes(claims));
    /* The disputed sources, so the verifier or arbiter can reopen them. */
    const seen = new Set(sources.map((s) => s.segmentId ?? s.sourceId));
    for (const c of claims) for (const a of c.anchors) {
      const ref: TaskSourceRef | null = a.segmentId ? { sourceId: null, segmentId: a.segmentId } : a.sourceId ? { sourceId: a.sourceId, segmentId: null } : null;
      const key = a.segmentId ?? a.sourceId;
      if (ref && key && !seen.has(key) && sources.length < role.maximumSources) { sources.push(sourceReference(ref, lookup)); seen.add(key); }
    }
  }

  if (claims.length > policy.maximumPacketClaims) throw new PacketOverBudget(`core-v2: packet for ${task.taskId} would carry ${claims.length} claims; the policy allows ${policy.maximumPacketClaims}`);
  if (sources.length > policy.maximumPacketSources) throw new PacketOverBudget(`core-v2: packet for ${task.taskId} would carry ${sources.length} sources; the policy allows ${policy.maximumPacketSources}`);

  const inputFingerprint = fingerprint({
    task: task.inputFingerprint,
    role: `${role.roleKey}@${role.version}`,
    sources: sources.map((s) => s.contentHash),
    dependencyClaims: dependencies.flatMap((d) => d.claimIds).sort(),
    competing: rules.claims === "anonymized_competing" ? Object.values(refToClaimId).sort() : [],
    independenceGroup: task.independenceGroup,
  });

  const packet: WorkPacket = {
    packetVersion: PACKET_VERSION,
    workflowId: task.workflowId,
    taskId: task.taskId,
    parentTaskId: task.parentTaskId,
    phase: task.phase,
    roleKey: role.roleKey,
    roleVersion: role.version,
    taskType: task.taskType,
    subjectKey: task.subjectKey,
    objective: pack.objectives[task.taskType] ?? KERNEL_OBJECTIVES[task.taskType] ?? role.description,
    sources,
    dependencies,
    independenceGroup: task.independenceGroup,
    blindContext: rules.blind,
    allowedActions: task.depth >= policy.maximumFollowUpDepth
      ? role.allowedActions.filter((a) => a === "request_human_review")
      : [...role.allowedActions],
    limits: {
      maximumSources: role.maximumSources,
      maximumClaims: task.maxClaims,
      maximumFollowUps: policy.maximumChildTasksPerParent,
      maximumDepth: Math.min(role.maximumFollowUpDepth, policy.maximumFollowUpDepth),
      maximumOutputBytes: policy.maximumEnvelopeBytes,
    },
    expectedOutputContract: role.outputContract,
    inputFingerprint,
    context: { claims, assessments, disagreements, depth: task.depth, validation },
  };

  const bytes = Buffer.byteLength(JSON.stringify(packet), "utf8");
  if (bytes > policy.maximumPacketBytes) throw new PacketOverBudget(`core-v2: packet for ${task.taskId} is ${bytes} bytes; the policy allows ${policy.maximumPacketBytes}`);

  const problems = assertPacketRespectsVisibility(packet, role);
  if (problems.length) throw new Error(`core-v2: packet for ${task.taskId} breaks visibility: ${problems.join("; ")}`);
  return { packet, refToClaimId };
}

/* What a code role or the composer works from. The comparator: the claims of
   the blind readers of its subject. A deriver: the accepted claims of what it
   depends on and of its subject. A composer: the accepted claims of its own
   subject and what those were computed from — nothing of another subject. */
export async function relevantClaimsFor(task: TaskRecord, role: AgentRoleDefinition, repo: OrchestrationRepository, pack: DomainPack): Promise<ClaimRecord[]> {
  const deps = await repo.getDependencies(task.taskId);
  const depTaskIds = deps.map((d) => d.dependsOnTaskId);
  const subject = pack.normaliseKey(task.subjectKey.split("#")[0]);
  const ofSubject = (c: ClaimRecord) => pack.normaliseKey(c.subjectKey) === subject || pack.normaliseKey(c.subjectKey).startsWith(`${subject}/`) || c.subjectKey.startsWith(`${task.subjectKey.split("#")[0]}/`);
  switch (role.kind) {
    case "comparator": {
      const readers = (await Promise.all(depTaskIds.map((id) => repo.getTask(id))))
        .filter((t) => t && t.independenceGroup !== null).map((t) => t!.taskId);
      return repo.listClaims({ workflowId: task.workflowId, taskIds: readers });
    }
    case "deriver": {
      const fromDeps = await repo.listClaims({ workflowId: task.workflowId, taskIds: depTaskIds, statuses: ["accepted"] });
      const ofSubj = (await repo.listClaims({ workflowId: task.workflowId, statuses: ["accepted"] })).filter(ofSubject);
      return dedupe([...fromDeps, ...ofSubj]);
    }
    case "composer": {
      const accepted = (await repo.listClaims({ workflowId: task.workflowId, statuses: ["accepted"] }));
      const own = accepted.filter(ofSubject);
      const inputIds = new Set(own.flatMap((c) => c.inputClaimIds));
      const inputs = accepted.filter((c) => inputIds.has(c.claimId));
      return dedupe([...own, ...inputs]);
    }
    default:
      return repo.listClaims({ workflowId: task.workflowId, taskIds: depTaskIds });
  }
}

function dedupe(claims: ClaimRecord[]): ClaimRecord[] {
  const seen = new Set<string>();
  return claims.filter((c) => (seen.has(c.claimId) ? false : (seen.add(c.claimId), true))).sort((a, b) => a.claimId.localeCompare(b.claimId));
}

/* Things code can say about competing claims that an arbiter may weigh.
   Never a provider, never a count of who agreed. */
function deterministicValidationNotes(claims: PacketClaim[]): string[] {
  const notes: string[] = [];
  for (const c of claims) {
    if (c.anchors.length === 0) notes.push(`claim ${c.ref}: no anchor`);
    if (c.value.known && c.value.quantity !== null && c.value.quantity < 0) notes.push(`claim ${c.ref}: negative quantity`);
    if (!c.value.known) notes.push(`claim ${c.ref}: the reader could not read a value`);
  }
  return notes;
}

export function lookupSource(ctx: PacketContext, sourceId: string): SourceDescriptor | null { return ctx.lookup.sources.get(sourceId) ?? null; }
export function lookupSegment(ctx: PacketContext, segmentId: string): SegmentRecord | null { return ctx.lookup.segments.get(segmentId) ?? null; }
