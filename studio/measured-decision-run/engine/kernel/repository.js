/* The identity of a task, as admission compares it: the work, not its
   provenance. Two tasks with one id and two identities are a collision, and
   admission refuses the second; a follow-up that asks for work the plan
   already holds is the same work, whoever asked and however deep. */
export function taskPayload(task) {
    return {
        workflowId: task.workflowId, phase: task.phase, taskType: task.taskType,
        roleKey: task.roleKey, roleVersion: task.roleVersion, subjectKey: task.subjectKey, sources: task.sources,
        inputFingerprint: task.inputFingerprint, contractVersion: task.contractVersion, independenceGroup: task.independenceGroup,
        disagreementId: task.disagreementId, targetClaimIds: [...task.targetClaimIds].sort(),
    };
}
