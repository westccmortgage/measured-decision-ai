import { KERNEL_TASK_TYPES, TASK_PHASES } from "./contracts.js";
const CRITIC_ACTIONS = ["expand_segment", "read_reference_segment", "open_linked_segment"];
export const KERNEL_ROLES = [
    {
        roleKey: "source_ingestor", version: "2.0", kind: "ingestor", phase: "ingest", taskTypes: [KERNEL_TASK_TYPES.ingest],
        description: "Records a source's immutable identity and the segments it declares about itself. Reads nothing into the source.",
        inputContract: "one source", outputContract: "identity claims + declared segments",
        maximumSources: 1, maximumClaims: 8, maximumFollowUpDepth: 0, requiresVisualInput: false, requiresIndependentReading: false,
        allowedActions: [], routingProfile: "deterministic", executorKind: "deterministic",
        producesAssessments: false, producesAdjudication: false, producesDecisions: false, producesCalculations: false, producesSegments: true,
    },
    {
        roleKey: "claim_comparator", version: "2.0", kind: "comparator", phase: "compare", taskTypes: [KERNEL_TASK_TYPES.compare],
        description: "Lines up the independent readings of one subject and records agreement and disagreement. Decides nothing.",
        inputContract: "the claims of every blind reader of one subject", outputContract: "agreement groups + disagreements",
        maximumSources: 0, maximumClaims: 0, maximumFollowUpDepth: 0, requiresVisualInput: false, requiresIndependentReading: false,
        allowedActions: [], routingProfile: "deterministic", executorKind: "deterministic",
        producesAssessments: false, producesAdjudication: false, producesDecisions: false, producesCalculations: true, producesSegments: false,
    },
    {
        roleKey: "evidence_critic", version: "2.0", kind: "critic", phase: "verify", taskTypes: [KERNEL_TASK_TYPES.verifyClaim],
        description: "Checks claims against their own anchors: does the source support the value, unit, subject and scope?",
        inputContract: "anonymised claims with their anchors and the segments they point at", outputContract: "one assessment per claim",
        maximumSources: 6, maximumClaims: 0, maximumFollowUpDepth: 1, requiresVisualInput: true, requiresIndependentReading: false,
        allowedActions: [...CRITIC_ACTIONS], routingProfile: "evidence_criticism", executorKind: "model",
        producesAssessments: true, producesAdjudication: false, producesDecisions: false, producesCalculations: false, producesSegments: false,
    },
    {
        roleKey: "disagreement_verifier", version: "2.0", kind: "verifier", phase: "verify", taskTypes: [KERNEL_TASK_TYPES.verifyDisagreement],
        description: "Reopens the disputed source for the competing claims A, B, C and assesses each against what it shows.",
        inputContract: "anonymised competing claims, the disagreement, the disputed segments", outputContract: "one assessment per competing claim",
        maximumSources: 8, maximumClaims: 0, maximumFollowUpDepth: 2, requiresVisualInput: true, requiresIndependentReading: false,
        allowedActions: [...CRITIC_ACTIONS, "read_related_segment", "request_independent_reader"], routingProfile: "evidence_criticism", executorKind: "model",
        producesAssessments: true, producesAdjudication: false, producesDecisions: false, producesCalculations: false, producesSegments: false,
    },
    {
        roleKey: "evidence_arbiter", version: "2.0", kind: "arbiter", phase: "adjudicate", taskTypes: [KERNEL_TASK_TYPES.adjudicate],
        description: "Proposes one outcome for a disagreement from the assessments and evidence. A majority is not proof.",
        inputContract: "anonymised competing claims, assessments, code's validation notes", outputContract: "one adjudication",
        maximumSources: 8, maximumClaims: 0, maximumFollowUpDepth: 2, requiresVisualInput: true, requiresIndependentReading: false,
        allowedActions: ["request_disagreement_verification", "request_human_review"], routingProfile: "high_reasoning_arbitration", executorKind: "model",
        producesAssessments: false, producesAdjudication: true, producesDecisions: false, producesCalculations: false, producesSegments: false,
    },
    {
        roleKey: "decision_composer", version: "2.0", kind: "composer", phase: "compose", taskTypes: [KERNEL_TASK_TYPES.compose],
        description: "Says what is known, what conflicts, what can proceed, what must wait and what supports it — from accepted evidence only.",
        inputContract: "the accepted claims of one subject", outputContract: "decisions",
        maximumSources: 0, maximumClaims: 0, maximumFollowUpDepth: 0, requiresVisualInput: false, requiresIndependentReading: false,
        allowedActions: ["request_human_review"], routingProfile: "high_reasoning_arbitration", executorKind: "model",
        producesAssessments: false, producesAdjudication: false, producesDecisions: true, producesCalculations: false, producesSegments: false,
    },
];
export const KERNEL_OBJECTIVES = {
    [KERNEL_TASK_TYPES.ingest]: "Record this source's immutable identity and the segments it declares. Read nothing into it.",
    [KERNEL_TASK_TYPES.discover]: "Find the bounded segments of this source. Return geometry and classification only; extract nothing.",
    [KERNEL_TASK_TYPES.compare]: "Line up the independent readings of this subject. Record agreement and disagreement. Decide nothing.",
    [KERNEL_TASK_TYPES.verifyClaim]: "Check each claim against its exact anchors: does the source support the value, unit, subject and scope?",
    [KERNEL_TASK_TYPES.verifyDisagreement]: "Reopen the disputed source for claims A/B/C. Assess each against what the source shows. Ask for one bounded follow-up if the source supplied is not enough.",
    [KERNEL_TASK_TYPES.adjudicate]: "Propose one outcome for this disagreement from the assessments and evidence: accept one claim, correct, reject all, needs more evidence, or needs a person. A majority is not proof.",
    [KERNEL_TASK_TYPES.compose]: "Say what is known, what conflicts, what can proceed, what must wait, and what supports it — from the accepted evidence only. Create no fact.",
};
const PROVIDER_WORDS = /openai|anthropic|gemini|claude|gpt|chatgpt|vertex|bedrock|mistral|llama|deepseek/i;
const PACK_PHASES = ["analyst", "discoverer", "deriver"];
export class RoleRegistry {
    roles = new Map();
    byTaskType = new Map();
    packId;
    constructor(pack) {
        this.packId = pack.id;
        for (const role of [...KERNEL_ROLES, ...pack.roles]) {
            if (this.roles.has(role.roleKey))
                throw new Error(`core-v2: role ${role.roleKey} is defined twice`);
            this.roles.set(role.roleKey, role);
            for (const t of role.taskTypes) {
                if (this.byTaskType.has(t))
                    throw new Error(`core-v2: task type ${t} is served by two roles`);
                this.byTaskType.set(t, role);
            }
        }
    }
    get keys() { return [...this.roles.keys()]; }
    all() { return [...this.roles.values()]; }
    role(roleKey) {
        const role = this.roles.get(roleKey);
        if (!role)
            throw new Error(`core-v2: no role ${roleKey}`);
        return role;
    }
    forTaskType(taskType) {
        const role = this.byTaskType.get(taskType);
        if (!role)
            throw new Error(`core-v2: no role serves ${taskType}`);
        return role;
    }
    /* What the registry refuses to be: a list of providers, a pack that
       redefines the kernel's roles, a pack role in a kernel phase, a task type
       that is not namespaced to its pack, a role whose limits are not limits. */
    assertConsistent() {
        const problems = [];
        const kernelKeys = new Set(KERNEL_ROLES.map((r) => r.roleKey));
        for (const role of this.roles.values()) {
            if (PROVIDER_WORDS.test(role.roleKey) || PROVIDER_WORDS.test(role.description))
                problems.push(`${role.roleKey} names a provider`);
            if (!TASK_PHASES.includes(role.phase))
                problems.push(`${role.roleKey} has no phase`);
            if (role.taskTypes.length === 0)
                problems.push(`${role.roleKey} serves no task type`);
            if (role.maximumClaims < 0 || role.maximumSources < 0 || role.maximumFollowUpDepth < 0)
                problems.push(`${role.roleKey} has a negative limit`);
            if (role.executorKind === "deterministic" && role.routingProfile !== "deterministic")
                problems.push(`${role.roleKey} is code but routes to a model`);
            if (role.executorKind === "model" && role.routingProfile === "deterministic")
                problems.push(`${role.roleKey} is a model but routes to code`);
            if (!kernelKeys.has(role.roleKey)) {
                if (!PACK_PHASES.includes(role.kind))
                    problems.push(`${role.roleKey} is a pack role of kind ${role.kind} — a pack adds analysts, discoverers and derivers only`);
                for (const t of role.taskTypes)
                    if (!t.startsWith(`${this.packId}:`))
                        problems.push(`${role.roleKey} serves ${t}, which is not namespaced to ${this.packId}`);
                if (role.kind === "analyst" && role.phase !== "analyze")
                    problems.push(`${role.roleKey} is an analyst outside the analyze phase`);
                if (role.kind === "discoverer" && role.phase !== "discover")
                    problems.push(`${role.roleKey} is a discoverer outside the discover phase`);
                if (role.kind === "deriver" && (role.phase !== "derive" || role.executorKind !== "deterministic"))
                    problems.push(`${role.roleKey} is a deriver that is not deterministic code in the derive phase`);
                if (role.kind === "discoverer" && !role.producesSegments)
                    problems.push(`${role.roleKey} discovers but may not produce segments`);
                if (role.producesAssessments || role.producesAdjudication || role.producesDecisions)
                    problems.push(`${role.roleKey} claims a kernel role's output`);
            }
        }
        for (const key of kernelKeys)
            if (!this.roles.has(key))
                problems.push(`kernel role ${key} is missing`);
        return problems;
    }
}
