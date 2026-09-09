/* The claims a task's packet presents, by id — what it may later ask a critic
   about. Its own output counts too: a reader may doubt itself. Kept apart
   from the packet builder so the follow-up planner can ask without building
   a packet. */
import type { TaskRecord } from "./contracts.ts";
import type { DomainPack } from "./domain.ts";
import { relevantClaimsFor } from "./packet-builder.ts";
import type { OrchestrationRepository } from "./repository.ts";
import type { RoleRegistry } from "./roles.ts";
import { visibilityFor } from "./visibility.ts";

export async function visibleClaimIdsFor(task: TaskRecord, repo: OrchestrationRepository, registry: RoleRegistry, pack: DomainPack): Promise<Set<string>> {
  const role = registry.role(task.roleKey);
  const rules = visibilityFor(role);
  const own = (await repo.listClaims({ workflowId: task.workflowId, taskIds: [task.taskId] })).map((c) => c.claimId);
  if (rules.claims === "all_relevant") return new Set([...own, ...(await relevantClaimsFor(task, role, repo, pack)).map((c) => c.claimId)]);
  if (rules.claims === "anonymized_competing") {
    const dis = task.disagreementId ? await repo.getDisagreement(task.disagreementId) : null;
    return new Set([...own, ...(dis ? dis.claimIds : task.targetClaimIds)]);
  }
  const depTaskIds = (await repo.getDependencies(task.taskId)).map((d) => d.dependsOnTaskId);
  return new Set([...own, ...(await repo.listClaims({ workflowId: task.workflowId, taskIds: depTaskIds })).map((c) => c.claimId)]);
}
