/* AGENTS ARE ROLES, NOT PROVIDERS.
 *
 * There is no "Claude agent" here and no "OpenAI agent". There is a schedule
 * reader, a legend reader, a symbol locator, a critic, an arbiter. Each is a
 * versioned contract about work: what it is handed, what it must return, how
 * much it may read, whether it is kept blind, and what it may ask for. Which
 * provider executes the role — if a provider does at all — is decided by the
 * router from a routing profile, and can change without touching a word of
 * this file.
 *
 * Two of these are code, not models, and are marked so: the counter and the
 * calculator. Two more are infrastructure the pipeline needs that the brief
 * did not name — the ingestor and the comparator — and they are code as well.
 * A model never does arithmetic here and never decides which model is better.
 */
import type { AgentActionType, AgentRoleDefinition, TaskType } from "./contracts.ts";

const EXTRACTOR_ACTIONS: AgentActionType[] = [
  "open_linked_detail", "expand_region", "read_related_region", "read_legend", "check_unit",
];

const role = (definition: AgentRoleDefinition): AgentRoleDefinition => definition;

export const ROLE_REGISTRY: Record<string, AgentRoleDefinition> = {
  workflow_planner: role({
    roleKey: "workflow_planner",
    version: "1.0",
    supportedTaskTypes: ["plan_workflow"],
    description:
      "Inspects a source manifest, identifies pages, regions and evidence types, and builds a bounded task graph " +
      "with dependencies and independence groups. Outputs tasks, never project conclusions.",
    inputContract: "source-manifest@1",
    outputContract: "task-graph@1",
    maximumSources: 10000,
    maximumClaims: 0,
    maximumFollowUpDepth: 0,
    requiresVisualInput: false,
    requiresIndependentReading: false,
    maySeeCompetingClaims: false,
    mayProposeDecision: false,
    allowedActions: [],
    routingProfile: "deterministic",
    executorKind: "deterministic",
    producesAssessments: false,
    producesAdjudication: false,
    producesDecisions: false,
    producesCalculations: false,
  }),

  deterministic_ingestor: role({
    roleKey: "deterministic_ingestor",
    version: "1.0",
    supportedTaskTypes: ["ingest_page"],
    description:
      "Records one page's immutable identity — document, index, hash, dimensions — as document_identity claims. " +
      "Code, not a model: it copies what the manifest already established.",
    inputContract: "page-identity@1",
    outputContract: "identity-claims@1",
    maximumSources: 1,
    maximumClaims: 8,
    maximumFollowUpDepth: 0,
    requiresVisualInput: false,
    requiresIndependentReading: false,
    maySeeCompetingClaims: false,
    mayProposeDecision: false,
    allowedActions: [],
    routingProfile: "deterministic",
    executorKind: "deterministic",
    producesAssessments: false,
    producesAdjudication: false,
    producesDecisions: false,
    producesCalculations: false,
  }),

  sheet_cartographer: role({
    roleKey: "sheet_cartographer",
    version: "1.0",
    supportedTaskTypes: ["map_page_regions", "read_sheet_register"],
    description:
      "Identifies sheet identity and discipline and locates title blocks, plans, schedules, legends, notes, details " +
      "and diagrams as bounded regions. Returns geometry and classification only — never schedule content, " +
      "never a count, never a decision.",
    inputContract: "page-render@1",
    outputContract: "region-map@1",
    maximumSources: 1,
    maximumClaims: 40,
    maximumFollowUpDepth: 1,
    requiresVisualInput: true,
    requiresIndependentReading: false,
    maySeeCompetingClaims: false,
    mayProposeDecision: false,
    allowedActions: ["expand_region"],
    routingProfile: "visual_extraction",
    executorKind: "agent",
    producesAssessments: false,
    producesAdjudication: false,
    producesDecisions: false,
    producesCalculations: false,
  }),

  schedule_reader: role({
    roleKey: "schedule_reader",
    version: "1.0",
    supportedTaskTypes: ["extract_schedule"],
    description:
      "Reads one schedule region and returns atomic claims — component types, marks, descriptions, dimensions, " +
      "materials, printed quantities — each with an exact anchor. One schedule region is one assignment.",
    inputContract: "schedule-region@1",
    outputContract: "atomic-claims@1",
    maximumSources: 3,
    maximumClaims: 200,
    maximumFollowUpDepth: 2,
    requiresVisualInput: true,
    requiresIndependentReading: true,
    maySeeCompetingClaims: false,
    mayProposeDecision: false,
    allowedActions: EXTRACTOR_ACTIONS,
    routingProfile: "visual_extraction",
    executorKind: "agent",
    producesAssessments: false,
    producesAdjudication: false,
    producesDecisions: false,
    producesCalculations: false,
  }),

  notes_reader: role({
    roleKey: "notes_reader",
    version: "1.0",
    supportedTaskTypes: ["extract_notes"],
    description:
      "Reads one bounded note group and returns requirements, exceptions, applicability, dependencies and " +
      "references, preserving note numbers and source wording. A note applies where its evidence says it does, " +
      "not everywhere.",
    inputContract: "note-group@1",
    outputContract: "atomic-claims@1",
    maximumSources: 3,
    maximumClaims: 120,
    maximumFollowUpDepth: 2,
    requiresVisualInput: true,
    requiresIndependentReading: true,
    maySeeCompetingClaims: false,
    mayProposeDecision: false,
    allowedActions: EXTRACTOR_ACTIONS,
    routingProfile: "general_extraction",
    executorKind: "agent",
    producesAssessments: false,
    producesAdjudication: false,
    producesDecisions: false,
    producesCalculations: false,
  }),

  legend_reader: role({
    roleKey: "legend_reader",
    version: "1.0",
    supportedTaskTypes: ["extract_legend"],
    description:
      "Reads one legend or symbol-definition region and maps symbols, line types, abbreviations and marks to " +
      "their meanings, with anchors. Defines what a symbol means; counts nothing.",
    inputContract: "legend-region@1",
    outputContract: "atomic-claims@1",
    maximumSources: 2,
    maximumClaims: 120,
    maximumFollowUpDepth: 1,
    requiresVisualInput: true,
    requiresIndependentReading: false,
    maySeeCompetingClaims: false,
    mayProposeDecision: false,
    allowedActions: ["expand_region", "read_related_region"],
    routingProfile: "visual_extraction",
    executorKind: "agent",
    producesAssessments: false,
    producesAdjudication: false,
    producesDecisions: false,
    producesCalculations: false,
  }),

  symbol_locator: role({
    roleKey: "symbol_locator",
    version: "1.0",
    supportedTaskTypes: ["locate_symbol_family"],
    description:
      "Searches one plan region for one symbol family and returns one component-instance claim per visible mark, " +
      "each with its own normalised bounding box. It never returns a total; the deterministic counter counts.",
    inputContract: "plan-region+symbol-family@1",
    outputContract: "instance-claims@1",
    maximumSources: 3,
    maximumClaims: 300,
    maximumFollowUpDepth: 2,
    requiresVisualInput: true,
    requiresIndependentReading: true,
    maySeeCompetingClaims: false,
    mayProposeDecision: false,
    allowedActions: ["expand_region", "read_legend", "open_linked_detail"],
    routingProfile: "visual_extraction",
    executorKind: "agent",
    producesAssessments: false,
    producesAdjudication: false,
    producesDecisions: false,
    producesCalculations: false,
  }),

  dimension_reader: role({
    roleKey: "dimension_reader",
    version: "1.0",
    supportedTaskTypes: ["extract_dimensions"],
    description:
      "Reads bounded dimensions and measurement callouts, preserves units, and separates printed measurements " +
      "from inferred geometry. Returns anchored dimension claims.",
    inputContract: "dimension-region@1",
    outputContract: "atomic-claims@1",
    maximumSources: 3,
    maximumClaims: 150,
    maximumFollowUpDepth: 2,
    requiresVisualInput: true,
    requiresIndependentReading: false,
    maySeeCompetingClaims: false,
    mayProposeDecision: false,
    allowedActions: ["expand_region", "open_linked_detail", "check_unit"],
    routingProfile: "visual_extraction",
    executorKind: "agent",
    producesAssessments: false,
    producesAdjudication: false,
    producesDecisions: false,
    producesCalculations: false,
  }),

  relationship_builder: role({
    roleKey: "relationship_builder",
    version: "1.0",
    supportedTaskTypes: ["resolve_relationships"],
    description:
      "Proposes relations among existing entities — instance to type, type to space, system, detail and " +
      "specification. Never merges two entities: an ambiguous identity becomes a disagreement.",
    inputContract: "accepted-claims@1",
    outputContract: "relation-claims@1",
    maximumSources: 50,
    maximumClaims: 400,
    maximumFollowUpDepth: 1,
    requiresVisualInput: false,
    requiresIndependentReading: false,
    maySeeCompetingClaims: false,
    mayProposeDecision: false,
    allowedActions: ["read_related_region", "request_evidence_critic"],
    routingProfile: "general_extraction",
    executorKind: "agent",
    producesAssessments: false,
    producesAdjudication: false,
    producesDecisions: false,
    producesCalculations: false,
  }),

  deterministic_comparator: role({
    roleKey: "deterministic_comparator",
    version: "1.0",
    supportedTaskTypes: ["detect_disagreements"],
    description:
      "Normalises the claims of independent readers and lines them up by subject and predicate. Records agreement " +
      "groups and disagreements — value, unit, scope, basis, missing. Code, not a model: it decides nothing about " +
      "which reader is better.",
    inputContract: "normalized-claims@1",
    outputContract: "disagreements@1",
    maximumSources: 0,
    maximumClaims: 0,
    maximumFollowUpDepth: 0,
    requiresVisualInput: false,
    requiresIndependentReading: false,
    maySeeCompetingClaims: true,
    mayProposeDecision: false,
    allowedActions: [],
    routingProfile: "deterministic",
    executorKind: "deterministic",
    producesAssessments: false,
    producesAdjudication: false,
    producesDecisions: false,
    /* Agreement groups: which claims agreed, computed from named inputs. */
    producesCalculations: true,
  }),

  evidence_critic: role({
    roleKey: "evidence_critic",
    version: "1.0",
    supportedTaskTypes: ["verify_claim"],
    description:
      "Evaluates one claim against its exact source anchors: does the anchor support the value, unit, subject and " +
      "scope? Returns a structured assessment. Never ranks providers; never accepts a claim because readers agree.",
    inputContract: "claim+anchors@1",
    outputContract: "assessments@1",
    maximumSources: 4,
    maximumClaims: 0,
    maximumFollowUpDepth: 1,
    requiresVisualInput: true,
    requiresIndependentReading: false,
    maySeeCompetingClaims: false,
    mayProposeDecision: false,
    allowedActions: ["expand_region", "read_legend", "open_linked_detail"],
    routingProfile: "evidence_criticism",
    executorKind: "agent",
    producesAssessments: true,
    producesAdjudication: false,
    producesDecisions: false,
    producesCalculations: false,
  }),

  disagreement_verifier: role({
    roleKey: "disagreement_verifier",
    version: "1.0",
    supportedTaskTypes: ["verify_disagreement"],
    description:
      "Receives an anonymised conflict packet — claims A, B, C — and reopens the exact disputed source regions, " +
      "with only the legend or detail context the conflict needs. Returns assessments and evidence, not a report. " +
      "May ask for one bounded follow-up when the supplied source is not enough.",
    inputContract: "conflict-packet@1",
    outputContract: "assessments@1",
    maximumSources: 6,
    maximumClaims: 0,
    maximumFollowUpDepth: 1,
    requiresVisualInput: true,
    requiresIndependentReading: false,
    maySeeCompetingClaims: true,
    mayProposeDecision: false,
    allowedActions: ["expand_region", "read_legend", "open_linked_detail", "read_related_region", "request_independent_reader"],
    routingProfile: "evidence_criticism",
    executorKind: "agent",
    producesAssessments: true,
    producesAdjudication: false,
    producesDecisions: false,
    producesCalculations: false,
  }),

  evidence_arbiter: role({
    roleKey: "evidence_arbiter",
    version: "1.0",
    supportedTaskTypes: ["adjudicate"],
    description:
      "Reviews competing claims, critic assessments and source evidence and proposes one outcome: accept a claim, " +
      "correct, reject all, needs more evidence, or needs a person. A majority is not proof; one well-supported " +
      "claim defeats two agreeing unsupported ones. It proposes — the database or a person decides.",
    inputContract: "adjudication-packet@1",
    outputContract: "adjudication@1",
    maximumSources: 8,
    maximumClaims: 0,
    maximumFollowUpDepth: 1,
    requiresVisualInput: true,
    requiresIndependentReading: false,
    maySeeCompetingClaims: true,
    mayProposeDecision: true,
    allowedActions: ["request_disagreement_verification", "request_human_review"],
    routingProfile: "high_reasoning_arbitration",
    executorKind: "agent",
    producesAssessments: false,
    producesAdjudication: true,
    producesDecisions: false,
    producesCalculations: false,
  }),

  deterministic_counter: role({
    roleKey: "deterministic_counter",
    version: "1.0",
    supportedTaskTypes: ["count_instances"],
    description:
      "Counts accepted unique component-instance claims, detects duplicate mark identities, and keeps scheduled, " +
      "drawn, calculated and field-observed quantities apart. Returns the formula and its inputs. Code, not a model.",
    inputContract: "accepted-instance-claims@1",
    outputContract: "count-claims@1",
    maximumSources: 0,
    maximumClaims: 50,
    maximumFollowUpDepth: 0,
    requiresVisualInput: false,
    requiresIndependentReading: false,
    maySeeCompetingClaims: false,
    mayProposeDecision: false,
    allowedActions: [],
    routingProfile: "deterministic",
    executorKind: "deterministic",
    producesAssessments: false,
    producesAdjudication: false,
    producesDecisions: false,
    producesCalculations: true,
  }),

  assembly_calculator: role({
    roleKey: "assembly_calculator",
    version: "1.0",
    supportedTaskTypes: ["derive_materials"],
    description:
      "Converts accepted measurements and assemblies into calculated material quantities, recording formula, input " +
      "claim ids, units, waste assumption and rounding. Never invents a missing dimension. Code, not a model.",
    inputContract: "accepted-measurements@1",
    outputContract: "calculated-claims@1",
    maximumSources: 0,
    maximumClaims: 50,
    maximumFollowUpDepth: 0,
    requiresVisualInput: false,
    requiresIndependentReading: false,
    maySeeCompetingClaims: false,
    mayProposeDecision: false,
    allowedActions: [],
    routingProfile: "deterministic",
    executorKind: "deterministic",
    producesAssessments: false,
    producesAdjudication: false,
    producesDecisions: false,
    producesCalculations: true,
  }),

  decision_composer: role({
    roleKey: "decision_composer",
    version: "1.0",
    supportedTaskTypes: ["compose_decision"],
    description:
      "Turns adjudicated evidence into a concise proposed owner decision and the next action, keeping links to " +
      "the accepted claims. Says what is known, what conflicts, what can proceed, what must wait, and what " +
      "supports the recommendation. Creates no technical fact.",
    inputContract: "adjudicated-evidence@1",
    outputContract: "proposed-decision@1",
    maximumSources: 0,
    maximumClaims: 0,
    maximumFollowUpDepth: 0,
    requiresVisualInput: false,
    requiresIndependentReading: false,
    maySeeCompetingClaims: true,
    mayProposeDecision: true,
    allowedActions: ["request_human_review"],
    routingProfile: "high_reasoning_arbitration",
    executorKind: "agent",
    producesAssessments: false,
    producesAdjudication: false,
    producesDecisions: true,
    producesCalculations: false,
  }),
};

export const ROLE_KEYS = Object.keys(ROLE_REGISTRY);

export function roleDefinition(roleKey: string): AgentRoleDefinition {
  const definition = ROLE_REGISTRY[roleKey];
  if (!definition) throw new Error(`core-v2: no role is registered as ${roleKey}`);
  return definition;
}

/* One task type, one role. If two roles claimed the same task type, routing
   would have to guess, and guessing is what this registry exists to remove. */
export function roleForTaskType(taskType: TaskType): AgentRoleDefinition {
  const matches = ROLE_KEYS.filter((key) => ROLE_REGISTRY[key].supportedTaskTypes.includes(taskType));
  if (matches.length !== 1) {
    throw new Error(`core-v2: ${matches.length} roles support ${taskType}; exactly one must`);
  }
  return ROLE_REGISTRY[matches[0]];
}

export function assertRegistryConsistent(): string[] {
  const problems: string[] = [];
  const seen = new Map<string, string>();
  for (const key of ROLE_KEYS) {
    const definition = ROLE_REGISTRY[key];
    if (definition.roleKey !== key) problems.push(`${key}: roleKey mismatch`);
    for (const type of definition.supportedTaskTypes) {
      const prior = seen.get(type);
      if (prior) problems.push(`${type} is claimed by both ${prior} and ${key}`);
      seen.set(type, key);
    }
    for (const forbidden of ["claude", "openai", "gemini", "gpt", "anthropic", "google"]) {
      if (key.toLowerCase().includes(forbidden)) problems.push(`${key} names a provider — roles describe work`);
    }
    if (definition.executorKind === "deterministic" && definition.routingProfile !== "deterministic") {
      problems.push(`${key} is code but would be routed to a model`);
    }
    if (definition.executorKind === "deterministic" && definition.allowedActions.length > 0) {
      problems.push(`${key} is code and may not ask for follow-ups`);
    }
    if (!definition.mayProposeDecision && (definition.producesAdjudication || definition.producesDecisions)) {
      problems.push(`${key} may not propose a decision yet is declared to produce one`);
    }
  }
  return problems;
}
