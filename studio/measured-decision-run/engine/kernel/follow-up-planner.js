import { KERNEL_TASK_TYPES } from "./contracts.js";
import { INDEPENDENCE_GROUPS } from "./domain.js";
import { entityId } from "./ids.js";
import { visibleClaimIdsFor } from "./packet-visibility.js";
import { CONTRACT_VERSION, hashOfRef, taskIdFor, taskIdentity } from "./planning.js";
const ACTION_TASK = {
    open_linked_segment: (p) => ({ phase: p.phase, taskType: p.taskType }),
    expand_segment: (p) => ({ phase: p.phase, taskType: p.taskType }),
    read_related_segment: (p) => ({ phase: p.phase, taskType: p.taskType }),
    read_reference_segment: (p) => ({ phase: p.phase, taskType: p.taskType }),
    check_unit: () => ({ phase: "verify", taskType: KERNEL_TASK_TYPES.verifyClaim }),
    request_independent_reader: (p) => ({ phase: p.phase, taskType: p.taskType }),
    request_evidence_critic: () => ({ phase: "verify", taskType: KERNEL_TASK_TYPES.verifyClaim }),
    request_disagreement_verification: () => ({ phase: "verify", taskType: KERNEL_TASK_TYPES.verifyDisagreement }),
};
export async function planFollowUps(parent, requests, ctx) {
    const { repo, lookup, registry, pack, policy } = ctx;
    const role = registry.role(parent.roleKey);
    const plan = { children: [], refused: [], escalations: [] };
    const existingChildren = (await repo.listTasks(parent.workflowId)).filter((t) => t.parentTaskId === parent.taskId);
    let budget = policy.maximumChildTasksPerParent - existingChildren.length;
    const seen = new Set();
    const segments = [...lookup.segments.values()];
    for (const request of requests) {
        const refuse = (reason) => plan.refused.push({ request, reason });
        const escalate = (reason) => plan.escalations.push({ request, reason });
        if (!request || typeof request !== "object" || !role.allowedActions.includes(request.actionType)) {
            refuse(`${role.roleKey} may not ask for ${request?.actionType}`);
            continue;
        }
        if (parent.depth >= policy.maximumFollowUpDepth && request.actionType !== "request_human_review") {
            escalate(`at depth ${parent.depth} nothing more is asked by machine; ${request.actionType} goes to a person`);
            continue;
        }
        if (request.parentTaskId !== parent.taskId) {
            refuse("request names a different parent");
            continue;
        }
        if (request.actionType === "request_human_review") {
            escalate(request.reasonCode || "agent asked for a person");
            continue;
        }
        const depth = parent.depth + 1;
        if (role.maximumFollowUpDepth === 0) {
            refuse(`${role.roleKey} may not ask for follow-ups`);
            continue;
        }
        if (depth > policy.maximumFollowUpDepth) {
            escalate(`follow-up depth ${depth} exceeds the limit of ${policy.maximumFollowUpDepth}; ${request.actionType} goes to a person`);
            continue;
        }
        if (budget <= 0) {
            escalate(`task ${parent.taskId} has used its ${policy.maximumChildTasksPerParent} follow-ups`);
            continue;
        }
        const { phase, taskType } = ACTION_TASK[request.actionType](parent);
        const childRole = registry.forTaskType(taskType);
        let sources = [];
        let subjectKey = parent.subjectKey;
        let independenceGroup = null;
        let disagreementId = parent.disagreementId;
        let targetClaimIds = [];
        if (["open_linked_segment", "expand_segment", "read_related_segment", "read_reference_segment"].includes(request.actionType)) {
            const targets = (request.targetSegmentIds ?? []).map((id) => lookup.segments.get(id) ?? null);
            if (targets.length === 0 || targets.some((t) => t === null)) {
                refuse("target is not a segment of the record");
                continue;
            }
            const parentSegments = parent.sources.map((s) => (s.segmentId ? lookup.segments.get(s.segmentId) : null)).filter(Boolean);
            if (!targets.every((t) => pack.isRelated(t, parent, segments))) {
                refuse("target segment is not related to what this task was reading");
                continue;
            }
            if (request.actionType === "read_reference_segment" && !targets.every((t) => pack.isReference(t))) {
                refuse("read_reference_segment must name reference material");
                continue;
            }
            if (request.actionType === "open_linked_segment" && !targets.every((t) => parentSegments.some((p) => pack.linkedSegments(p, segments).some((l) => l.segmentId === t.segmentId)))) {
                refuse("open_linked_segment must name a segment the parent's segments link to");
                continue;
            }
            if (targets.some((t) => t.status !== "accepted")) {
                refuse("target segment is not accepted");
                continue;
            }
            sources = targets.map((t) => ({ sourceId: null, segmentId: t.segmentId }));
            subjectKey = `${targets[0].sourceId}/${targets[0].segmentId}` + (request.actionType === "expand_segment" ? "/expanded" : "");
            if (sources.length > childRole.maximumSources) {
                refuse(`${sources.length} sources exceeds ${childRole.roleKey}'s ${childRole.maximumSources}`);
                continue;
            }
        }
        else if (request.actionType === "request_independent_reader") {
            const dis = parent.disagreementId ? await repo.getDisagreement(parent.disagreementId) : null;
            const firstClaim = dis ? await repo.getClaim(dis.claimIds[0]) : null;
            const readerTask = firstClaim?.taskId ? await repo.getTask(firstClaim.taskId) : null;
            if (!readerTask || readerTask.independenceGroup === null) {
                refuse("no blind reading to add a reader to");
                continue;
            }
            const readers = (await repo.listTasks(parent.workflowId)).filter((t) => t.subjectKey === readerTask.subjectKey && t.taskType === readerTask.taskType && t.independenceGroup !== null);
            const used = new Set(readers.map((t) => t.independenceGroup));
            if (used.size >= policy.maximumIndependentReadersPerSubject) {
                escalate(`${readerTask.subjectKey} already has ${used.size} independent readers — a person decides`);
                continue;
            }
            independenceGroup = INDEPENDENCE_GROUPS.find((g) => !used.has(g)) ?? null;
            if (!independenceGroup) {
                escalate("no independence group is free for this subject");
                continue;
            }
            const child = childTask(parent, readerTask.phase, readerTask.taskType, readerTask.subjectKey, [...readerTask.sources], independenceGroup, null, [], ctx, depth);
            if (seen.has(child.inputFingerprint)) {
                refuse("the same follow-up was asked for twice in one envelope");
                continue;
            }
            seen.add(child.inputFingerprint);
            plan.children.push(child);
            budget -= 1;
            continue;
        }
        else if (request.actionType === "check_unit" || request.actionType === "request_evidence_critic") {
            const claimId = request.claimRef ?? "";
            const claim = await repo.getClaim(claimId);
            if (!claim || claim.workflowId !== parent.workflowId) {
                refuse("the claim to check is not a claim of this workflow");
                continue;
            }
            if (!(await visibleClaimIdsFor(parent, repo, registry, pack)).has(claim.claimId)) {
                refuse("the claim to check is not one this task produced or was handed");
                continue;
            }
            subjectKey = entityId("subject", claim.claimId);
            targetClaimIds = [claim.claimId];
            sources = [...new Set((await repo.listAnchors([claim.claimId])).map((a) => a.segmentId ?? a.sourceId).filter(Boolean))]
                .slice(0, childRole.maximumSources).map((id) => (lookup.segments.has(id) ? { sourceId: null, segmentId: id } : { sourceId: id, segmentId: null }));
        }
        else if (request.actionType === "request_disagreement_verification") {
            if (!parent.disagreementId) {
                refuse("no disagreement to verify");
                continue;
            }
            const dis = await repo.getDisagreement(parent.disagreementId);
            if (!dis) {
                refuse("no such disagreement");
                continue;
            }
            if (dis.criticRounds >= policy.maximumCriticRounds) {
                escalate(`disagreement ${dis.disagreementId} has had ${dis.criticRounds} rounds of criticism`);
                continue;
            }
            if (dis.followUps.some((f) => f.fingerprint === request.idempotencyFingerprint)) {
                escalate("the arbiter asked for the same verification again — it goes to a person");
                continue;
            }
            sources = [...parent.sources].slice(0, childRole.maximumSources);
            disagreementId = dis.disagreementId;
            subjectKey = `${parent.subjectKey.split("/verify-")[0].split("/adjudicate-")[0]}/verify-${dis.criticRounds + 1}`;
        }
        const child = childTask(parent, phase, taskType, subjectKey, sources, independenceGroup, disagreementId, targetClaimIds, ctx, depth);
        if (seen.has(child.inputFingerprint)) {
            refuse("the same follow-up was asked for twice in one envelope");
            continue;
        }
        seen.add(child.inputFingerprint);
        plan.children.push(child);
        budget -= 1;
    }
    return plan;
}
/* The child's identity is the work, not who asked: two agents asking for the
   same segment to be read are one task, and asking twice is one task. */
export function childTask(parent, phase, taskType, subjectKey, sources, independenceGroup, disagreementId, targetClaimIds, ctx, depth) {
    const role = ctx.registry.forTaskType(taskType);
    const hashes = sources.map((s) => hashOfRef(s, ctx.lookup));
    const identity = taskIdentity(parent.workflowId, phase, taskType, subjectKey, hashes, independenceGroup);
    return {
        taskId: taskIdFor(parent.workflowId, identity),
        workflowId: parent.workflowId, parentTaskId: parent.taskId, createdByTaskId: parent.taskId, phase, taskType, roleKey: role.roleKey,
        roleVersion: role.version, subjectKey, priority: parent.priority + 1, sources, inputFingerprint: identity, contractVersion: CONTRACT_VERSION,
        independenceGroup, depth, criticRound: parent.criticRound, arbiterRound: parent.arbiterRound, disagreementId, targetClaimIds,
        maxClaims: role.maximumClaims, dependsOn: [],
    };
}
