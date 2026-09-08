/* AN AGENT DOES NOT CALL ANOTHER AGENT. IT ASKS, AND THE ORCHESTRATOR DECIDES.
 *
 * A requested action arrives in an envelope. This turns it into at most one
 * bounded child task — or refuses it, or escalates it to a person — under
 * rules that do not bend for a persuasive request:
 *
 *   · the role must be allowed to ask for that action, and the packet must
 *     have permitted it;
 *   · every child is one deeper than its parent, and past the depth limit the
 *     answer is a person, not another child;
 *   · a parent may have only so many children;
 *   · the same request twice is the same child — the fingerprint reuses it;
 *   · the target must be a real source, related to the parent's;
 *   · an independent reader is a new group, never the parent's own;
 *   · a request for human review creates no task at all.
 */
import type {
  AgentActionType, DependencyKind, ManifestRegion, RequestedAgentAction, SourceManifest, TaskRecord, TaskType,
} from "./contracts.ts";
import { INDEPENDENCE_GROUPS, workIdentity } from "./graph-builder.ts";
import { visibleClaimIdsFor } from "./packet-builder.ts";
import { shortId } from "./hash.ts";
import type { OrchestrationPolicy } from "./orchestration-policy.ts";
import type { NewTask, OrchestrationRepository } from "./repository.ts";
import { roleDefinition, roleForTaskType } from "./role-registry.ts";

export type FollowUpPlan = {
  children: NewTask[];
  refused: { request: RequestedAgentAction; reason: string }[];
  escalations: { request: RequestedAgentAction; reason: string }[];
};

const ACTION_TASK: Partial<Record<AgentActionType, (parent: TaskRecord) => TaskType>> = {
  open_linked_detail: () => "extract_dimensions",
  expand_region: (p) => p.taskType,
  read_related_region: (p) => p.taskType,
  read_legend: () => "extract_legend",
  check_unit: () => "verify_claim",
  request_independent_reader: (p) => p.taskType,
  request_evidence_critic: () => "verify_claim",
  request_disagreement_verification: () => "verify_disagreement",
};

export async function planFollowUps(
  parent: TaskRecord, requests: RequestedAgentAction[], manifest: SourceManifest,
  repo: OrchestrationRepository, policy: OrchestrationPolicy,
): Promise<FollowUpPlan> {
  const role = roleDefinition(parent.roleKey);
  const plan: FollowUpPlan = { children: [], refused: [], escalations: [] };
  const existingChildren = (await repo.listTasks(parent.workflowId)).filter((t) => t.parentTaskId === parent.taskId);
  let budget = policy.maximumChildTasksPerParent - existingChildren.length;
  const seenFingerprints = new Set<string>();

  for (const request of requests) {
    const refuse = (reason: string) => plan.refused.push({ request, reason });
    const escalate = (reason: string) => plan.escalations.push({ request, reason });

    if (!role.allowedActions.includes(request.actionType)) { refuse(`${role.roleKey} may not ask for ${request.actionType}`); continue; }
    if (parent.depth >= policy.maximumFollowUpDepth && request.actionType !== "request_human_review") {
      escalate(`at depth ${parent.depth} nothing more is asked by machine; ${request.actionType} goes to a person`); continue;
    }
    if (request.parentTaskId !== parent.taskId) { refuse("request names a different parent"); continue; }
    if (request.actionType === "request_human_review") { escalate(request.reasonCode || "agent asked for a person"); continue; }

    /* The policy's depth is absolute; the role's says whether this role may
       ask for anything beneath itself at all. */
    const depth = parent.depth + 1;
    if (role.maximumFollowUpDepth === 0) { refuse(`${role.roleKey} may not ask for follow-ups`); continue; }
    if (depth > policy.maximumFollowUpDepth) {
      escalate(`follow-up depth ${depth} exceeds the limit of ${policy.maximumFollowUpDepth}; ${request.actionType} goes to a person`); continue;
    }
    if (budget <= 0) { escalate(`task ${parent.taskId} has used its ${policy.maximumChildTasksPerParent} follow-ups`); continue; }

    const taskType = ACTION_TASK[request.actionType]!(parent);
    const childRole = roleForTaskType(taskType);

    /* The target must exist and be related to what the parent was reading. */
    let sourceIds: string[] = [];
    let subjectKey = parent.subjectKey;
    let independenceGroup: string | null = null;
    let disagreementId: string | null = parent.disagreementId;
    let targetClaimIds: string[] = [];

    if (["open_linked_detail", "expand_region", "read_related_region", "read_legend"].includes(request.actionType)) {
      const targets = request.targetSourceIds.map((id) => manifest.regions.find((r) => r.regionId === id) ?? null);
      if (targets.length === 0 || targets.some((t) => t === null)) { refuse("target is not a region in the manifest"); continue; }
      const related = targets.every((t) => relatedToParent(t!, parent, manifest));
      if (!related) { refuse("target region is not related to what this task was reading"); continue; }
      if (request.actionType === "read_legend" && !targets.every((t) => t!.kind === "legend")) { refuse("read_legend must name a legend"); continue; }
      if (request.actionType === "open_linked_detail" && !targets.every((t) => ["detail", "section", "elevation"].includes(t!.kind))) { refuse("open_linked_detail must name a detail, section or elevation"); continue; }
      sourceIds = targets.map((t) => t!.regionId);
      subjectKey = `${targets[0]!.pageId}/${targets[0]!.regionId}` + (request.actionType === "expand_region" ? "/expanded" : "");
      if (sourceIds.length > childRole.maximumSources) { refuse(`${sourceIds.length} sources exceeds ${childRole.roleKey}'s ${childRole.maximumSources}`); continue; }
    } else if (request.actionType === "request_independent_reader") {
      /* Another blind reading of the disputed subject: the same sources, a
         group nobody has used, the reader's own task type. A verifier asks for
         it; the verifier does not become the reader. */
      const dis = parent.disagreementId ? await repo.getDisagreement(parent.disagreementId) : null;
      const firstClaim = dis ? await repo.getClaim(dis.claimIds[0]) : null;
      const readerTask = firstClaim ? await repo.getTask(firstClaim.taskId) : null;
      const readSubject = readerTask?.subjectKey ?? parent.subjectKey;
      const readers = (await repo.listTasks(parent.workflowId)).filter((t) => t.subjectKey === readSubject && t.independenceGroup !== null);
      const used = new Set(readers.map((t) => t.independenceGroup));
      if (used.size >= policy.maximumIndependentReadersPerSubject) { escalate(`${readSubject} already has ${used.size} independent readers — a person decides`); continue; }
      independenceGroup = INDEPENDENCE_GROUPS.find((g) => !used.has(g)) ?? null;
      if (!independenceGroup) { escalate("no independence group is free for this subject"); continue; }
      const readerType = readerTask?.taskType ?? parent.taskType;
      sourceIds = [...(readerTask?.sourceIds ?? parent.sourceIds)];
      subjectKey = readSubject;
      plan.children.push(childOf(parent, readerType, subjectKey, sourceIds, independenceGroup, null, [], manifest, depth));
      budget -= 1;
      continue;
    } else if (request.actionType === "check_unit" || request.actionType === "request_evidence_critic") {
      const claimId = request.claimRef ?? "";
      const claim = await repo.getClaim(claimId);
      if (!claim || claim.workflowId !== parent.workflowId) { refuse("the claim to check is not a claim of this workflow"); continue; }
      /* A task may ask about what it produced or what it was handed — never
         about a claim it could not see. */
      if (!(await visibleClaimIdsFor(parent, repo)).has(claim.claimId)) { refuse("the claim to check is not one this task produced or was handed"); continue; }
      /* The subject is opaque: the claim id stays on the task record, never in
         a packet's subject key. */
      subjectKey = shortId("subject", claim.claimId);
      targetClaimIds = [claim.claimId];
      sourceIds = [...new Set((await repo.listAnchors([claim.claimId])).map((a) => a.regionId ?? a.pageId).filter(Boolean) as string[])].slice(0, childRole.maximumSources);
    } else if (request.actionType === "request_disagreement_verification") {
      if (!parent.disagreementId) { refuse("no disagreement to verify"); continue; }
      const dis = await repo.getDisagreement(parent.disagreementId);
      if (!dis) { refuse("no such disagreement"); continue; }
      if (dis.criticRounds >= policy.maximumCriticRounds) { escalate(`disagreement ${dis.disagreementId} has had ${dis.criticRounds} rounds of criticism`); continue; }
      const fp = request.idempotencyFingerprint;
      if (dis.followUpFingerprints.includes(fp)) { escalate("the arbiter asked for the same verification again — it goes to a person"); continue; }
      sourceIds = [...parent.sourceIds].slice(0, childRole.maximumSources);
      disagreementId = dis.disagreementId;
      subjectKey = `${parent.subjectKey}/verify-${dis.criticRounds + 1}`;
    }

    const child = childOf(parent, taskType, subjectKey, sourceIds, independenceGroup, disagreementId, targetClaimIds, manifest, depth);
    if (seenFingerprints.has(child.inputFingerprint)) { refuse("the same follow-up was asked for twice in one envelope"); continue; }
    seenFingerprints.add(child.inputFingerprint);
    plan.children.push(child);
    budget -= 1;
  }
  return plan;
}

/* The child's identity is the work, not who asked: two agents asking for the
   same region to be read are one task, and asking twice is one task. Its id is
   derived from that identity, so two different works never share an id. */
export function childOf(
  parent: TaskRecord, taskType: TaskType, subjectKey: string, sourceIds: string[], independenceGroup: string | null,
  disagreementId: string | null, targetClaimIds: string[], manifest: SourceManifest, depth: number,
): NewTask {
  const childRole = roleForTaskType(taskType);
  const identity = workIdentity(parent.workflowId, taskType, subjectKey, sourceIds.map((id) => hashOf(manifest, id)), independenceGroup);
  return {
    taskId: shortId("task", parent.workflowId, "child", identity),
    workflowId: parent.workflowId, parentTaskId: parent.taskId, taskType, roleKey: childRole.roleKey,
    roleVersion: childRole.version, subjectKey, priority: parent.priority + 1, sourceIds,
    inputFingerprint: identity, contractVersion: parent.contractVersion, independenceGroup,
    depth, createdByTaskId: parent.taskId, criticRound: parent.criticRound, arbiterRound: parent.arbiterRound,
    disagreementId, targetClaimIds, dependsOn: [] as { taskId: string; kind: DependencyKind }[],
  };
}

function relatedToParent(target: ManifestRegion, parent: TaskRecord, manifest: SourceManifest): boolean {
  const parentRegions = parent.sourceIds.map((id) => manifest.regions.find((r) => r.regionId === id)).filter(Boolean) as ManifestRegion[];
  if (parentRegions.length === 0) return true;
  return parentRegions.some((p) =>
    p.regionId === target.regionId || p.pageId === target.pageId || (p.linkedDetailRegionIds ?? []).includes(target.regionId) ||
    manifest.symbolFamilies.some((f) => f.definedByRegionId === target.regionId && (p.symbolFamilies ?? []).includes(f.familyKey)));
}

function hashOf(manifest: SourceManifest, sourceId: string): string {
  return manifest.regions.find((r) => r.regionId === sourceId)?.contentHash
    ?? manifest.pages.find((p) => p.pageId === sourceId)?.contentHash ?? sourceId;
}
