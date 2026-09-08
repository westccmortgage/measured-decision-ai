/* THE UNIT OF WORK IS NOT "ONE MODEL READING ONE PROJECT."
 *
 * It is:
 *
 *   one bounded assignment → one agent attempt → atomic claims
 *     → evidence anchors → comparison → verification → decision
 *
 * Everything in this directory is typed against the contracts in this file.
 * A packet is what an agent is handed; an envelope is what it hands back; a
 * role is the work an agent does, never the provider that does it. Nothing
 * here knows what a provider is, and nothing here carries a URL, a key, or
 * another agent's answer where the rules say it must not.
 */

export const PACKET_VERSION = "core-v2.packet.1";
export const ENGINE_VERSION = "core-v2.0";

/* ─────────────────────────────────────────────────── vocabulary the DB shares */

/* Task types. The first eighteen are the vocabulary migration 058 admits on
   extraction_tasks.task_type. The last three — plan_workflow, verify_claim and
   compose_decision — are the roles this engine needs that the database does
   not yet name; the persistence adapter of PR 2 adds them to that check in one
   line, and until then they exist only in memory. */
export type TaskType =
  | "ingest_page"
  | "map_page_regions"
  | "read_sheet_register"
  | "extract_schedule"
  | "extract_notes"
  | "extract_legend"
  | "locate_symbol_family"
  | "extract_dimensions"
  | "resolve_relationships"
  | "count_instances"
  | "derive_materials"
  | "detect_disagreements"
  | "verify_disagreement"
  | "adjudicate"
  | "cluster_photo_scenes"
  | "locate_photo_scene"
  | "classify_work_stage"
  | "compare_revisions"
  | "plan_workflow"
  | "verify_claim"
  | "compose_decision";

export const TASK_TYPES_NOT_YET_IN_DATABASE: TaskType[] = ["plan_workflow", "verify_claim", "compose_decision"];

export type TaskState =
  | "created" | "blocked" | "queued" | "leased" | "running"
  | "completed" | "failed_known" | "outcome_unknown" | "cancelled" | "superseded";

export type AttemptState =
  | "prepared" | "submitted" | "response_received" | "parsed" | "succeeded"
  | "rejected_before_submission" | "failed_known" | "output_limited"
  | "cancelled_before_submission" | "outcome_unknown";

export type DependencyKind = "requires_completion" | "requires_claims" | "requires_resolution";

export type ClaimStatus =
  | "proposed" | "corroborated" | "disputed" | "verified" | "accepted" | "rejected" | "unresolved" | "superseded";

export type SubjectType =
  | "building" | "level" | "space" | "component_type" | "component_instance" | "assembly"
  | "material" | "requirement" | "system" | "photo_scene" | "work_state" | "document_identity";

export type ObservationBasis = "printed" | "counted_marks" | "calculated" | "field_observed" | "inferred";

export type AnchorSourceKind = "page_region" | "page_bbox" | "document_text" | "photo" | "video_frame" | "human_record";

export type RegionKind =
  | "title_block" | "sheet_index" | "plan_view" | "schedule" | "legend" | "general_notes" | "keynotes"
  | "detail" | "section" | "elevation" | "diagram" | "spec_text" | "photo" | "other";

export type DisagreementKind =
  | "missing" | "value" | "unit" | "scope" | "identity" | "count_basis" | "source" | "revision" | "geometry" | "duplicate";
export type DisagreementSeverity = "critical" | "material" | "informational";
export type DisagreementState = "open" | "verifying" | "resolved" | "needs_human" | "superseded";

export type AssessmentKind =
  | "supports" | "contradicts" | "insufficient" | "wrong_scope" | "wrong_unit" | "duplicate" | "unreadable";

export type DecisionType =
  | "accept_claim" | "reject_claim" | "reject_all" | "hold" | "release_for_pricing"
  | "release_for_ordering" | "request_information" | "create_field_check" | "supersede";
export type DecisionStatus = "proposed" | "machine_decided" | "needs_human" | "human_decided" | "superseded";
export type DecisionAuthority = "deterministic_rule" | "adjudicator" | "human";

export type DecisionActionType =
  | "verify_plan" | "verify_field" | "request_document" | "request_rfi" | "price" | "order" | "hold" | "review";

/* ────────────────────────────────────────────── what an agent may ask for */

/* The closed vocabulary of things an agent may ask the orchestrator to do
   next. An agent never calls another agent; it asks, the orchestrator checks
   the role, the depth and the policy, and either creates one bounded child
   task or refuses. */
export type AgentActionType =
  | "open_linked_detail"
  | "expand_region"
  | "read_related_region"
  | "read_legend"
  | "check_unit"
  | "request_independent_reader"
  | "request_evidence_critic"
  | "request_disagreement_verification"
  | "request_human_review";

export const AGENT_ACTION_TYPES: AgentActionType[] = [
  "open_linked_detail", "expand_region", "read_related_region", "read_legend", "check_unit",
  "request_independent_reader", "request_evidence_critic", "request_disagreement_verification",
  "request_human_review",
];

/* ────────────────────────────────────────────────────────── the role */

export type ExecutorKind = "deterministic" | "agent";

export type RoutingProfile =
  | "general_extraction"
  | "visual_extraction"
  | "evidence_criticism"
  | "high_reasoning_arbitration"
  | "deterministic";

/* A role is the work, versioned. It says what the agent is handed, what it
   must return, how much it may read and produce, whether it must be kept blind,
   and what it may ask for. It does not say which provider does it — that is a
   routing decision, made elsewhere and changeable without touching this. */
export type AgentRoleDefinition = {
  roleKey: string;
  version: string;
  supportedTaskTypes: TaskType[];
  description: string;
  inputContract: string;
  outputContract: string;
  maximumSources: number;
  maximumClaims: number;
  maximumFollowUpDepth: number;
  requiresVisualInput: boolean;
  requiresIndependentReading: boolean;
  maySeeCompetingClaims: boolean;
  mayProposeDecision: boolean;
  allowedActions: AgentActionType[];
  routingProfile: RoutingProfile;
  /* Whether this role is code or a language model. Code roles are never routed
     to a provider, whatever the routing table says. */
  executorKind: ExecutorKind;
  /* What the envelope may carry beyond claims and anchors. Extractors return
     claims; critics return assessments; the arbiter an adjudication; the
     composer decisions. Anything else in an envelope from that role is invalid. */
  producesAssessments: boolean;
  producesAdjudication: boolean;
  producesDecisions: boolean;
  producesCalculations: boolean;
};

/* ──────────────────────────────────────────────────── the source manifest */

export type ManifestDocument = {
  documentId: string;
  filename: string;
  /* Whole-file digest. A source with no digest is not read by Core V2. */
  contentHash: string;
};

export type ManifestPage = {
  pageId: string;
  documentId: string;
  pageIndex: number;
  sheetNumber: string | null;
  sheetTitle: string | null;
  discipline: string | null;
  contentHash: string;
  width: number;
  height: number;
};

export type ManifestRegion = {
  regionId: string;
  pageId: string;
  kind: RegionKind;
  label: string | null;
  bbox: [number, number, number, number];
  contentHash: string;
  /* For a plan view: which symbol families a locator should search it for.
     For a note region: the note group it belongs to. */
  symbolFamilies?: string[];
  noteGroup?: string | null;
  /* A detail this region calls out — the thing `open_linked_detail` opens. */
  linkedDetailRegionIds?: string[];
};

export type ManifestSymbolFamily = {
  familyKey: string;
  /* The legend region that defines it, if any. */
  definedByRegionId: string | null;
  /* The schedule region that prints its types, if any — what a calculation of
     this family's materials has to wait for. */
  scheduledByRegionId: string | null;
};

export type SourceManifest = {
  workflowId: string;
  organizationId: string;
  propertyId: string;
  documents: ManifestDocument[];
  pages: ManifestPage[];
  regions: ManifestRegion[];
  symbolFamilies: ManifestSymbolFamily[];
  /* Which task types are read blind by more than one reader. */
  independentReadingTaskTypes: TaskType[];
};

/* ────────────────────────────────────────────────────── the work packet */

export type SourceReference = {
  sourceId: string;
  kind: "document" | "page" | "region";
  documentId: string;
  pageId: string | null;
  regionId: string | null;
  regionKind: RegionKind | null;
  label: string | null;
  bbox: [number, number, number, number] | null;
  /* Immutable. Never a signed URL, never a temporary path. */
  contentHash: string;
  locator: Record<string, string | number>;
};

export type DependencyReference = {
  taskId: string;
  kind: DependencyKind;
  /* The claims a dependency contributes, by id. Empty when the dependency is
     a completion only. Blind packets carry no claims from other readers. */
  claimIds: string[];
  /* The blind group a dependency read under — for the comparator only, so it
     knows which readers existed, including one that returned nothing. Null in
     every other packet. */
  independenceGroup: string | null;
};

/* A claim as it appears inside a packet — for the comparator, the critic and
   the arbiter. The critic and the arbiter see it under a letter, never under
   the name of whoever produced it. */
export type PacketClaim = {
  /* "A", "B", "C" for anonymised packets; the claim id otherwise. */
  ref: string;
  subjectType: SubjectType;
  subjectKey: string;
  predicate: string;
  value: ClaimValue;
  unit: string | null;
  observationBasis: ObservationBasis;
  scope: Record<string, string>;
  anchors: PacketAnchor[];
  status: ClaimStatus;
  /* Which blind reader produced it — "reader-a", never a provider — for the
     comparator only. Anonymised packets carry null here. */
  independenceGroup: string | null;
};

export type PacketAnchor = {
  anchorId: string;
  sourceKind: AnchorSourceKind;
  documentId: string | null;
  pageId: string | null;
  regionId: string | null;
  bbox: [number, number, number, number] | null;
  quotedText: string | null;
  locator: Record<string, string | number>;
};

export type PacketAssessment = {
  claimRef: string;
  assessment: AssessmentKind;
  reasonCode: string;
  explanation: string;
  anchorIds: string[];
};

export type PacketDisagreement = {
  disagreementId: string;
  kind: DisagreementKind;
  severity: DisagreementSeverity;
  subjectSignature: Record<string, string>;
  claimRefs: string[];
};

export type WorkPacket = {
  packetVersion: string;
  workflowId: string;
  taskId: string;
  parentTaskId: string | null;
  roleKey: string;
  roleVersion: string;
  taskType: TaskType;
  subjectKey: string;
  objective: string;
  sources: SourceReference[];
  dependencies: DependencyReference[];
  independenceGroup: string | null;
  blindContext: boolean;
  allowedActions: AgentActionType[];
  limits: {
    maximumSources: number;
    maximumClaims: number;
    maximumFollowUps: number;
    maximumDepth: number;
  };
  expectedOutputContract: string;
  inputFingerprint: string;
  /* What this role is allowed to see of other agents' work, already filtered
     by the visibility policy. Extractors get none of it. */
  context: {
    claims: PacketClaim[];
    assessments: PacketAssessment[];
    disagreements: PacketDisagreement[];
    /* The current follow-up depth of this task. */
    depth: number;
    /* Deterministic validation notes an arbiter may weigh. Never a provider name. */
    validation: string[];
  };
};

/* ───────────────────────────────────────────────────── the result envelope */

/* A value is typed and carries its original text. `known: false` means the
   agent could not read it; then quantity and text are null — never zero,
   never an empty string standing in for zero. */
export type ClaimValue = {
  known: boolean;
  quantity: number | null;
  text: string | null;
  attributes?: Record<string, string | number | null>;
};

export type ProposedClaim = {
  claimKey: string;
  subjectType: SubjectType;
  subjectKey: string;
  predicate: string;
  value: ClaimValue;
  unit: string | null;
  observationBasis: ObservationBasis;
  scope: Record<string, string>;
  anchorKeys: string[];
  machineConfidence: number | null;
  /* For deterministic results: the claims this one was computed from. */
  inputClaimIds?: string[];
};

export type ProposedAnchor = {
  anchorKey: string;
  sourceKind: AnchorSourceKind;
  documentId: string | null;
  pageId: string | null;
  regionId: string | null;
  bbox: [number, number, number, number] | null;
  quotedText: string | null;
  locator: Record<string, string | number>;
};

export type ProposedAssessment = {
  /* The letter or id the claim was presented under in the packet. */
  claimRef: string;
  assessment: AssessmentKind;
  reasonCode: string;
  explanation: string;
  anchorKeys: string[];
};

export type ProposedDisagreement = {
  disagreementKey: string;
  kind: DisagreementKind;
  severity: DisagreementSeverity;
  subjectSignature: Record<string, string>;
  claimIds: string[];
};

export type RequestedAgentAction = {
  actionType: AgentActionType;
  reasonCode: string;
  targetSourceIds: string[];
  expectedInformation: string;
  parentTaskId: string;
  currentDepth: number;
  idempotencyFingerprint: string;
  /* For request_independent_reader: which subject; for request_evidence_critic:
     which claim ref. */
  subjectKey?: string;
  claimRef?: string;
};

export type AdjudicationOutcome = "accept_claim" | "correct" | "reject_all" | "needs_more_evidence" | "needs_human";

export type ProposedAdjudication = {
  outcome: AdjudicationOutcome;
  disagreementId: string;
  /* The letter of the accepted claim, when one is accepted. */
  acceptedClaimRef: string | null;
  correctedValue: ClaimValue | null;
  correctedUnit: string | null;
  rationale: string;
  /* Anchors the adjudication rests on, by id from the packet. */
  evidenceAnchorIds: string[];
  /* When the outcome is needs_more_evidence: the one bounded thing to fetch. */
  followUp: RequestedAgentAction | null;
};

export type ProposedDecision = {
  decisionType: DecisionType;
  title: string;
  summary: {
    known: string;
    conflicts: string;
    canProceed: string;
    mustWait: string;
    supportingEvidence: string;
  };
  supportingClaimIds: string[];
  contradictingClaimIds: string[];
  riskLevel: "critical" | "high" | "normal" | "low";
  actions: { actionType: DecisionActionType; ownerRole: string }[];
};

export type ProposedCalculation = {
  calculationKey: string;
  formula: string;
  inputClaimIds: string[];
  unit: string | null;
  wasteAssumption: string | null;
  rounding: string | null;
  result: number | null;
};

export type EnvelopeOutcome = "completed" | "needs_follow_up" | "insufficient_evidence" | "failed_known" | "outcome_unknown";

export type AgentResultEnvelope = {
  packetVersion: string;
  taskId: string;
  roleKey: string;
  roleVersion: string;
  outcome: EnvelopeOutcome;
  claims: ProposedClaim[];
  anchors: ProposedAnchor[];
  assessments: ProposedAssessment[];
  disagreements: ProposedDisagreement[];
  requestedActions: RequestedAgentAction[];
  limitations: string[];
  rawResponseReference: string | null;
  /* Role-specific extensions. Every role that may not produce one must leave
     it empty, and the validator holds it to that. */
  adjudication: ProposedAdjudication | null;
  decisions: ProposedDecision[];
  calculations: ProposedCalculation[];
};

/* ─────────────────────────────────────────────────────── persisted records */

export type TaskRecord = {
  taskId: string;
  workflowId: string;
  parentTaskId: string | null;
  taskType: TaskType;
  roleKey: string;
  roleVersion: string;
  subjectKey: string;
  state: TaskState;
  priority: number;
  sourceIds: string[];
  inputFingerprint: string;
  contractVersion: string;
  independenceGroup: string | null;
  depth: number;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  terminalReason: string | null;
  createdByTaskId: string | null;
  /* Follow-up bookkeeping. */
  criticRound: number;
  arbiterRound: number;
  /* The disagreement this verification or adjudication task is about. */
  disagreementId: string | null;
  /* The claims a critic task checks. Kept here, not in the subject key, so a
     packet's subject never carries a claim id. */
  targetClaimIds: string[];
};

export type DependencyRecord = {
  taskId: string;
  dependsOnTaskId: string;
  kind: DependencyKind;
};

export type AttemptRecord = {
  attemptId: string;
  taskId: string;
  attemptNo: number;
  executorFamily: string;
  modelConfiguration: string;
  roleKey: string;
  state: AttemptState;
  inputFingerprint: string;
  independenceGroup: string | null;
  /* The envelope as returned, valid or not. Never deleted. */
  rawEnvelope: unknown;
  validationErrors: string[];
  errorCode: string | null;
  errorMessage: string | null;
};

export type ClaimRecord = {
  claimId: string;
  workflowId: string;
  taskId: string;
  attemptId: string;
  independenceGroup: string | null;
  subjectType: SubjectType;
  subjectKey: string;
  predicate: string;
  value: ClaimValue;
  unit: string | null;
  observationBasis: ObservationBasis;
  scope: Record<string, string>;
  status: ClaimStatus;
  machineConfidence: number | null;
  anchorIds: string[];
  inputClaimIds: string[];
  incompleteSourceAttempt: boolean;
};

export type AnchorRecord = ProposedAnchor & {
  anchorId: string;
  claimId: string;
  anchorHash: string;
  /* Set when the anchor is a critic's evidence about the claim rather than the
     claim's own source. A claim's anchors are only the ones its reader gave. */
  assessmentId: string | null;
};

export type AssessmentRecord = {
  assessmentId: string;
  claimId: string;
  attemptId: string;
  taskId: string;
  assessment: AssessmentKind;
  reasonCode: string;
  explanation: string;
  anchorIds: string[];
};

export type DisagreementRecord = {
  disagreementId: string;
  workflowId: string;
  disagreementKey: string;
  kind: DisagreementKind;
  severity: DisagreementSeverity;
  subjectSignature: Record<string, string>;
  claimIds: string[];
  state: DisagreementState;
  resolutionDecisionId: string | null;
  criticRounds: number;
  arbiterRounds: number;
  /* Fingerprints of follow-ups the arbiter has asked for on this dispute. */
  followUpFingerprints: string[];
  needsHumanReason: string | null;
};

export type DecisionRecord = {
  decisionId: string;
  workflowId: string;
  taskId: string;
  decisionType: DecisionType;
  title: string;
  status: DecisionStatus;
  authority: DecisionAuthority;
  rationale: string;
  riskLevel: "critical" | "high" | "normal" | "low";
  evidence: { claimId: string | null; anchorId: string | null; link: "supports" | "contradicts" | "context" }[];
  actions: { actionType: DecisionActionType; ownerRole: string }[];
  disagreementId: string | null;
  summary: ProposedDecision["summary"] | null;
};

export type WorkflowRecord = {
  workflowId: string;
  organizationId: string;
  propertyId: string;
  state: "created" | "queued" | "planning" | "running" | "needs_attention" | "ready_for_decision" | "deciding"
       | "completed" | "partial" | "failed" | "cancelled";
  cancelRequested: boolean;
  totalUnits: number;
  completedUnits: number;
  attentionUnits: number;
};

export type AuditRecord = {
  action: string;
  entityType: string;
  entityId: string;
  detail: Record<string, unknown>;
};
