/* WHAT AN AGENT IS HANDED, AND NOTHING ELSE.
 *
 * A packet carries exactly the sources the assignment needs, by immutable id
 * and hash; the dependencies it may rely on; its limits; and whatever of other
 * agents' work the visibility policy lets this role see — already filtered,
 * already anonymised. It carries no URL, no key, no provider name, and, for a
 * reader that must be blind, no other reader's answer.
 *
 * The fingerprint at the bottom is computed over the same immutable things
 * and excludes everything that would differ between two identical requests.
 */
import type {
  DependencyReference, PacketAnchor, PacketAssessment, PacketClaim, PacketDisagreement,
  SourceManifest, SourceReference, TaskRecord, TaskType, WorkPacket,
} from "./contracts.ts";
import { PACKET_VERSION } from "./contracts.ts";
import { fingerprint } from "./hash.ts";
import type { OrchestrationPolicy } from "./orchestration-policy.ts";
import type { OrchestrationRepository } from "./repository.ts";
import { roleDefinition } from "./role-registry.ts";
import { anonymize, assertPacketRespectsVisibility, scrubLocator, scrubScope, visibilityFor } from "./visibility-policy.ts";

export type BuiltPacket = { packet: WorkPacket; refToClaimId: Record<string, string> };

const OBJECTIVES: Record<TaskType, string> = {
  plan_workflow: "Build the bounded task graph for this manifest. Extract nothing.",
  ingest_page: "Record this page's immutable identity: document, index, dimensions, hash.",
  map_page_regions: "Locate the title block, plans, schedules, legends, notes, details and diagrams on this page as bounded regions. Return geometry and classification only.",
  read_sheet_register: "Read the sheet register and return document and sheet identities.",
  extract_schedule: "Read this one schedule region. Return one atomic claim per cell that states a fact, each with an exact anchor. Do not read anything outside the region.",
  extract_notes: "Read this one note group. Return each requirement with its note number, exact wording, and what it applies to. Do not apply a note beyond its stated scope.",
  extract_legend: "Read this legend. Return what each symbol, line type, abbreviation and mark means, with anchors. Count nothing.",
  locate_symbol_family: "Search this plan region for this one symbol family. Return one component-instance claim per visible mark, each with its own bounding box. Never return a total.",
  extract_dimensions: "Read the dimensions and measurement callouts in this region. Preserve units. Separate printed measurements from inferred geometry.",
  resolve_relationships: "Propose relations among the accepted entities: instance to type, type to space, system, detail, specification. Never merge two entities; an ambiguous identity is a disagreement.",
  count_instances: "Count accepted unique component instances. Detect duplicate marks. Keep scheduled, drawn, calculated and field-observed quantities apart.",
  derive_materials: "Compute material quantities from accepted measurements and assembly rules. Record formula, inputs, units, waste and rounding. Invent nothing.",
  detect_disagreements: "Line up the independent readings of this subject. Record agreement and disagreement. Decide nothing.",
  verify_claim: "Check this one claim against its exact anchors: does the source support the value, unit, subject and scope?",
  verify_disagreement: "Reopen the disputed source for claims A/B/C. Assess each against what the source shows. Ask for one bounded follow-up if the source supplied is not enough.",
  adjudicate: "Propose one outcome for this disagreement from the assessments and evidence: accept one claim, correct, reject all, needs more evidence, or needs a person. A majority is not proof.",
  compose_decision: "Say what is known, what conflicts, what can proceed, what must wait, and what supports it — from the accepted evidence only. Create no technical fact.",
  cluster_photo_scenes: "Group likely same-place captures.",
  locate_photo_scene: "Propose the room and direction of this photo scene.",
  classify_work_stage: "Classify the visible work stage.",
  compare_revisions: "Compare the two revisions and name changed regions.",
};

export function sourceReference(manifest: SourceManifest, sourceId: string): SourceReference {
  const region = manifest.regions.find((r) => r.regionId === sourceId);
  if (region) {
    const page = manifest.pages.find((p) => p.pageId === region.pageId)!;
    return {
      sourceId, kind: "region", documentId: page.documentId, pageId: page.pageId, regionId: region.regionId,
      regionKind: region.kind, label: region.label, bbox: region.bbox, contentHash: region.contentHash,
      locator: { sheet: page.sheetNumber ?? "", page_index: page.pageIndex, region: region.label ?? region.kind },
    };
  }
  const page = manifest.pages.find((p) => p.pageId === sourceId);
  if (page) {
    return {
      sourceId, kind: "page", documentId: page.documentId, pageId: page.pageId, regionId: null, regionKind: null,
      label: page.sheetTitle, bbox: null, contentHash: page.contentHash,
      locator: { sheet: page.sheetNumber ?? "", page_index: page.pageIndex },
    };
  }
  const doc = manifest.documents.find((d) => d.documentId === sourceId);
  if (doc) {
    return { sourceId, kind: "document", documentId: doc.documentId, pageId: null, regionId: null, regionKind: null, label: doc.filename, bbox: null, contentHash: doc.contentHash, locator: {} };
  }
  throw new Error(`core-v2: source ${sourceId} is not in the manifest`);
}

export async function buildPacket(
  task: TaskRecord, manifest: SourceManifest, repo: OrchestrationRepository, policy: OrchestrationPolicy,
): Promise<BuiltPacket> {
  const role = roleDefinition(task.roleKey);
  const rules = visibilityFor(role);
  const sources = task.sourceIds.map((id) => sourceReference(manifest, id));
  const deps = await repo.getDependencies(task.taskId);

  const dependencies: DependencyReference[] = [];
  const refToClaimId: Record<string, string> = {};
  let claims: PacketClaim[] = [];
  let assessments: PacketAssessment[] = [];
  let disagreements: PacketDisagreement[] = [];
  const validation: string[] = [];

  /* A claim as another role sees it. Its scope and its anchors' locators are
     cut to the keys the manifest defines: whatever else a reader wrote there —
     its group, its family, a name — travels to nobody. The record keeps the
     original; the packet does not carry it. */
  const toPacketClaim = async (c: Awaited<ReturnType<OrchestrationRepository["getClaim"]>>): Promise<PacketClaim> => {
    const anchors = await repo.listAnchors([c!.claimId]);
    return {
      ref: c!.claimId, subjectType: c!.subjectType, subjectKey: c!.subjectKey, predicate: c!.predicate,
      value: c!.value, unit: c!.unit, observationBasis: c!.observationBasis, scope: scrubScope(c!.scope), status: c!.status,
      /* Only the comparator needs to know which blind reader made a claim. */
      independenceGroup: task.taskType === "detect_disagreements" ? c!.independenceGroup : null,
      anchors: anchors.map((a): PacketAnchor => ({
        anchorId: a.anchorId, sourceKind: a.sourceKind, documentId: a.documentId, pageId: a.pageId, regionId: a.regionId,
        bbox: a.bbox, quotedText: a.quotedText, locator: scrubLocator(a.locator),
      })),
    };
  };

  /* Dependencies: which tasks, and — where the role may see them by id —
     which claims. An anonymised packet names its dependencies as work only. */
  for (const d of deps) {
    const claimIds = rules.claims === "none" || rules.claims === "anonymized_competing" ? [] :
      (await repo.listClaims({ workflowId: task.workflowId, taskIds: [d.dependsOnTaskId] })).map((c) => c.claimId);
    /* The comparator is told which blind groups read the subject — a reader
       that returned nothing is still a reader that read. Nobody else is told. */
    const independenceGroup = task.taskType === "detect_disagreements" ? ((await repo.getTask(d.dependsOnTaskId))?.independenceGroup ?? null) : null;
    dependencies.push({ taskId: d.dependsOnTaskId, kind: d.kind, claimIds, independenceGroup });
  }

  if (rules.claims === "own_dependencies") {
    /* An extractor sees the claims of the tasks it was declared to depend on —
       a legend read before a locator — and never those of a parallel reader,
       which is not a dependency and so is not here. */
    for (const d of dependencies) {
      for (const id of d.claimIds) {
        const c = await repo.getClaim(id);
        if (c) { claims.push(await toPacketClaim(c)); refToClaimId[id] = id; }
      }
    }
  } else if (rules.claims === "all_relevant") {
    const relevant = await relevantClaimsFor(task, repo);
    for (const c of relevant) { claims.push(await toPacketClaim(c)); refToClaimId[c.claimId] = c.claimId; }
  } else if (rules.claims === "anonymized_competing") {
    const dis = task.disagreementId ? await repo.getDisagreement(task.disagreementId) : null;
    const competing = dis ? dis.claimIds : task.targetClaimIds;
    const raw: PacketClaim[] = [];
    for (const id of competing) {
      const c = await repo.getClaim(id);
      if (c) raw.push(await toPacketClaim(c));
    }
    const anon = anonymize(raw);
    claims = anon.claims;
    for (const [letter, id] of Object.entries(anon.map)) refToClaimId[letter] = id;
    const idToLetter = Object.fromEntries(Object.entries(anon.map).map(([l, id]) => [id, l]));
    if (rules.assessments) {
      /* A critic's words about a claim are its own; they are passed on with
         the same scrubbing a reader's words get, and a critic that wrote
         authorship into them is caught by the assertion below. */
      assessments = (await repo.listAssessments(competing)).map((a) => ({
        claimRef: idToLetter[a.claimId], assessment: a.assessment, reasonCode: a.reasonCode,
        explanation: a.explanation, anchorIds: a.anchorIds,
      })).sort((x, y) => x.claimRef.localeCompare(y.claimRef));
    }
    if (rules.disagreements && dis) {
      disagreements = [{
        disagreementId: dis.disagreementId, kind: dis.kind, severity: dis.severity,
        subjectSignature: dis.subjectSignature,
        /* In letter order — never in the order the readers finished. */
        claimRefs: dis.claimIds.map((id) => idToLetter[id]).filter(Boolean).sort(),
      }];
    }
    if (rules.validation) validation.push(...deterministicValidationNotes(claims, manifest));
  }

  /* The disputed sources, for a verifier or an arbiter: the anchors of the
     competing claims, added to the packet's sources so it can reopen them. */
  if (rules.claims === "anonymized_competing") {
    const seen = new Set(sources.map((s) => s.sourceId));
    for (const c of claims) for (const a of c.anchors) {
      const id = a.regionId ?? a.pageId;
      if (id && !seen.has(id) && sources.length < role.maximumSources) { sources.push(sourceReference(manifest, id)); seen.add(id); }
    }
  }

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
    roleKey: role.roleKey,
    roleVersion: role.version,
    taskType: task.taskType,
    subjectKey: task.subjectKey,
    objective: OBJECTIVES[task.taskType],
    sources,
    dependencies,
    independenceGroup: task.independenceGroup,
    blindContext: rules.blind,
    allowedActions: task.depth >= policy.maximumFollowUpDepth
      ? role.allowedActions.filter((a) => a === "request_human_review")
      : [...role.allowedActions],
    limits: {
      maximumSources: role.maximumSources,
      maximumClaims: role.maximumClaims,
      maximumFollowUps: policy.maximumChildTasksPerParent,
      maximumDepth: Math.min(role.maximumFollowUpDepth, policy.maximumFollowUpDepth),
    },
    expectedOutputContract: role.outputContract,
    inputFingerprint,
    context: { claims, assessments, disagreements, depth: task.depth, validation },
  };

  const problems = assertPacketRespectsVisibility(packet, role);
  if (problems.length) throw new Error(`core-v2: packet for ${task.taskId} breaks visibility: ${problems.join("; ")}`);
  return { packet, refToClaimId };
}

/* The claims a task's packet presents, by id — what it may later ask a
   critic about. Its own output counts too: a reader may doubt itself. */
export async function visibleClaimIdsFor(task: TaskRecord, repo: OrchestrationRepository): Promise<Set<string>> {
  const rules = visibilityFor(roleDefinition(task.roleKey));
  const own = (await repo.listClaims({ workflowId: task.workflowId, taskIds: [task.taskId] })).map((c) => c.claimId);
  if (rules.claims === "all_relevant") return new Set([...own, ...(await relevantClaimsFor(task, repo)).map((c) => c.claimId)]);
  if (rules.claims === "anonymized_competing") {
    const dis = task.disagreementId ? await repo.getDisagreement(task.disagreementId) : null;
    return new Set([...own, ...(dis ? dis.claimIds : task.targetClaimIds)]);
  }
  const depTaskIds = (await repo.getDependencies(task.taskId)).map((d) => d.dependsOnTaskId);
  return new Set([...own, ...(await repo.listClaims({ workflowId: task.workflowId, taskIds: depTaskIds })).map((c) => c.claimId)]);
}

/* What a code role or the composer works from: accepted claims of its subject,
   and for the comparator, every claim of the tasks it depends on. */
async function relevantClaimsFor(task: TaskRecord, repo: OrchestrationRepository) {
  const deps = await repo.getDependencies(task.taskId);
  const depTaskIds = deps.map((d) => d.dependsOnTaskId);
  switch (task.taskType) {
    case "detect_disagreements": {
      /* Only the blind readings of this subject are compared. A legend read
         once as context is not a third reader that failed to see the marks. */
      const readers = (await Promise.all(depTaskIds.map((id) => repo.getTask(id))))
        .filter((t) => t && t.subjectKey === task.subjectKey && t.independenceGroup !== null)
        .map((t) => t!.taskId);
      return repo.listClaims({ workflowId: task.workflowId, taskIds: readers });
    }
    case "count_instances":
      return repo.listClaims({ workflowId: task.workflowId, statuses: ["accepted"], subjectTypes: ["component_instance"], subjectKeyPrefix: `${task.subjectKey}/` });
    case "derive_materials":
    case "compose_decision":
    case "resolve_relationships":
      return repo.listClaims({ workflowId: task.workflowId, statuses: ["accepted"] });
    default:
      return repo.listClaims({ workflowId: task.workflowId, taskIds: depTaskIds });
  }
}

/* Things code can say about competing claims that an arbiter may weigh: an
   anchor whose box lies outside its region, a unit the predicate never uses.
   Never a provider, never a count of who agreed. */
function deterministicValidationNotes(claims: PacketClaim[], manifest: SourceManifest): string[] {
  const notes: string[] = [];
  for (const c of claims) {
    for (const a of c.anchors) {
      if (a.regionId && a.bbox) {
        const region = manifest.regions.find((r) => r.regionId === a.regionId);
        if (region && (a.bbox[0] < region.bbox[0] || a.bbox[1] < region.bbox[1] || a.bbox[2] > region.bbox[2] || a.bbox[3] > region.bbox[3])) {
          notes.push(`claim ${c.ref}: an anchor box lies outside the region it names`);
        }
      }
    }
    if (c.anchors.length === 0) notes.push(`claim ${c.ref}: no anchor`);
    if (c.value.known && c.value.quantity !== null && c.value.quantity < 0) notes.push(`claim ${c.ref}: negative quantity`);
  }
  return notes;
}
