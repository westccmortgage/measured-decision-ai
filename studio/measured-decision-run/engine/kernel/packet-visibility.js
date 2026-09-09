import { relevantClaimsFor } from "./packet-builder.js";
import { visibilityFor } from "./visibility.js";
export async function visibleClaimIdsFor(task, repo, registry, pack) {
    const role = registry.role(task.roleKey);
    const rules = visibilityFor(role);
    const own = (await repo.listClaims({ workflowId: task.workflowId, taskIds: [task.taskId] })).map((c) => c.claimId);
    if (rules.claims === "all_relevant")
        return new Set([...own, ...(await relevantClaimsFor(task, role, repo, pack)).map((c) => c.claimId)]);
    if (rules.claims === "anonymized_competing") {
        const dis = task.disagreementId ? await repo.getDisagreement(task.disagreementId) : null;
        return new Set([...own, ...(dis ? dis.claimIds : task.targetClaimIds)]);
    }
    const depTaskIds = (await repo.getDependencies(task.taskId)).map((d) => d.dependsOnTaskId);
    return new Set([...own, ...(await repo.listClaims({ workflowId: task.workflowId, taskIds: depTaskIds })).map((c) => c.claimId)]);
}
