/* THE UNIT OF WORK IS NOT "ONE MODEL READING ONE PROJECT."
 *
 * It is:
 *
 *   one bounded assignment → one agent attempt → atomic claims
 *     → evidence anchors → comparison → verification → decision
 *
 * Everything in the kernel is typed against the contracts in this file, and
 * nothing in this file names a domain. A source is anything with a content
 * identity; a segment is a bounded part of it with a locator; a subject is a
 * string a domain pack chose; a predicate is a string a domain pack chose. A
 * packet is what an agent is handed; an envelope is what it hands back; a role
 * is the work an agent does, never the provider that does it.
 *
 * The vocabularies marked "mirrors migration 058" are the ones the database
 * enumerates. Everything else is text the domain pack validates.
 */

export const PACKET_VERSION = "core-v2.packet.2";
export const ENGINE_VERSION = "core-v2.1";

/* ───────────────────────────────────────── vocabularies (mirror migration 058) */

export type TaskPhase = "ingest" | "discover" | "analyze" | "compare" | "verify" | "adjudicate" | "derive" | "compose";
export const TASK_PHASES: TaskPhase[] = ["ingest", "discover", "analyze", "compare", "verify", "adjudicate", "derive", "compose"];

/* The kernel's own task types. A domain pack's are namespaced `<pack>:<name>`
   and belong to the analyze, discover or derive phase. */
export const KERNEL_TASK_TYPES = {
  ingest: "ingest_source",
  discover: "discover_segments",
  compare: "compare_claims",
  verifyClaim: "verify_claim",
  verifyDisagreement: "verify_disagreement",
  adjudicate: "adjudicate",
  compose: "compose_decision",
} as const;

export type WorkflowState =
  | "created" | "queued" | "planning" | "running" | "needs_attention"
  | "ready_for_decision" | "deciding" | "completed" | "partial" | "failed" | "cancelled";
export const ACTIVE_WORKFLOW_STATES: WorkflowState[] = ["created", "queued", "planning", "running", "needs_attention", "ready_for_decision", "deciding"];

export type TaskState =
  | "created" | "blocked" | "queued" | "leased" | "running"
  | "completed" | "failed_known" | "outcome_unknown" | "cancelled" | "superseded";

export type AttemptState =
  | "prepared" | "submitted" | "response_received" | "parsed" | "succeeded"
  | "rejected_before_submission" | "failed_known" | "output_limited"
  | "cancelled_before_submission" | "outcome_unknown";

export type ExecutorKind = "deterministic" | "model" | "human";
export type DependencyKind = "requires_completion" | "requires_claims" | "requires_resolution";
export type ClaimStatus =
  | "proposed" | "corroborated" | "disputed" | "verified" | "accepted" | "rejected" | "unresolved" | "superseded";
/* observed: read directly in the source. derived: computed by code from other
   claims. inferred: a model's inference beyond what the source states.
   reported: a person's record. */
export type ObservationBasis = "observed" | "derived" | "inferred" | "reported";
export type AnchorSourceKind = "segment_locator" | "segment" | "source" | "human_record";
export type AssessmentKind =
  | "supports" | "contradicts" | "insufficient" | "wrong_scope" | "wrong_unit" | "duplicate" | "unreadable";
export type DisagreementKind = "missing" | "value" | "unit" | "scope" | "basis" | "identity" | "duplicate" | "coverage";
export type DisagreementSeverity = "critical" | "material" | "informational";
export type DisagreementState = "open" | "verifying" | "resolved" | "needs_human" | "superseded";
export type DecisionType = "accept_claim" | "reject_claim" | "reject_all" | "hold" | "proceed" | "request_information" | "supersede";
export type DecisionStatus = "proposed" | "machine_decided" | "needs_human" | "human_decided" | "superseded";
export type DecisionAuthority = "deterministic_rule" | "adjudicator" | "human";
export type DecisionActionType = "review" | "verify_source" | "request_information" | "proceed" | "hold";
export type SegmentStatus = "proposed" | "accepted" | "rejected" | "superseded";
export type DiscoveredBy = "deterministic" | "model" | "human";
export type ValidationState = "pending" | "valid" | "invalid" | "not_applicable";

/* ────────────────────────────────────────────── what an agent may ask for */

/* The closed vocabulary of things an agent may ask the orchestrator to do
   next. An agent never calls another agent; it asks, the orchestrator checks
   the role, the depth and the policy, and either creates one bounded child
   task or refuses. The domain pack says which segments are related, linked or
   reference material; the kernel says whether the ask is permitted. */
export type AgentActionType =
  | "open_linked_segment"
  | "expand_segment"
  | "read_related_segment"
  | "read_reference_segment"
  | "check_unit"
  | "request_independent_reader"
  | "request_evidence_critic"
  | "request_disagreement_verification"
  | "request_human_review";

export const AGENT_ACTION_TYPES: AgentActionType[] = [
  "open_linked_segment", "expand_segment", "read_related_segment", "read_reference_segment", "check_unit",
  "request_independent_reader", "request_evidence_critic", "request_disagreement_verification",
  "request_human_review",
];

/* ────────────────────────────────────────────────────────── the role */

export type RoleKind = "ingestor" | "discoverer" | "analyst" | "comparator" | "critic" | "verifier" | "arbiter" | "deriver" | "composer";

export type RoutingProfile =
  | "general_analysis"
  | "visual_analysis"
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
  kind: RoleKind;
  phase: TaskPhase;
  taskTypes: string[];
  description: string;
  inputContract: string;
  outputContract: string;
  maximumSources: number;
  maximumClaims: number;
  maximumFollowUpDepth: number;
  requiresVisualInput: boolean;
  requiresIndependentReading: boolean;
  allowedActions: AgentActionType[];
  routingProfile: RoutingProfile;
  /* Code roles are never routed to a provider, whatever the routing table says. */
  executorKind: "deterministic" | "model";
  /* What the envelope may carry beyond claims and anchors. */
  producesAssessments: boolean;
  producesAdjudication: boolean;
  producesDecisions: boolean;
  producesCalculations: boolean;
  producesSegments: boolean;
};

/* ──────────────────────────────────────────────── sources and segments */

/* A locator is the domain's geometry inside a segment: a normalised box for
   an image, a time range for a recording, a row range for a table. The
   kernel understands the two shapes it can check containment for; anything
   else travels opaquely. */
export type Locator = {
  bbox?: [number, number, number, number];
  start_ms?: number;
  end_ms?: number;
  [key: string]: unknown;
};

export type SourceDescriptor = {
  sourceId: string;
  ordinal: number;
  sourceKind: string;
  label: string | null;
  /* Opaque. Never a signed URL, never a temporary path. */
  uri: string;
  contentHash: string | null;
  hashAlgorithm: string | null;
  objectVersionId: string | null;
  byteSize: number | null;
  media: Record<string, unknown>;
  /* Segments the source declares about itself at ingest time, whatever its
     own divisions are called. Discovered segments come later, from a
     discoverer, under those. */
  declaredSegments: SegmentDescriptor[];
};

export type SegmentDescriptor = {
  sourceId: string;
  parentSegmentId: string | null;
  segmentKind: string;
  label: string | null;
  ordinal: number;
  locator: Locator;
  contentHash: string;
};

export type SegmentRecord = SegmentDescriptor & {
  segmentId: string;
  workflowId: string;
  status: SegmentStatus;
  discoveredBy: DiscoveredBy;
  discoveredByAttemptId: string | null;
};

export type SourceManifest = {
  workflowId: string;
  organizationId: string;
  domainPack: string;
  domainPackVersion: string;
  workflowType: string;
  requestedScope: Record<string, unknown>;
  sources: SourceDescriptor[];
};

/* ────────────────────────────────────────────────────── the work packet */

export type SourceReference = {
  sourceId: string;
  segmentId: string | null;
  kind: "source" | "segment";
  sourceKind: string;
  segmentKind: string | null;
  parentSegmentId: string | null;
  label: string | null;
  ordinal: number;
  locator: Locator;
  /* Immutable. Never a signed URL, never a temporary path. */
  contentHash: string;
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

export type PacketClaim = {
  /* "A", "B", "C" for anonymised packets; the claim id otherwise. */
  ref: string;
  subjectType: string;
  subjectKey: string;
  predicate: string;
  value: ClaimValue;
  unit: string | null;
  observationBasis: ObservationBasis;
  scope: Record<string, string>;
  anchors: PacketAnchor[];
  status: ClaimStatus;
  independenceGroup: string | null;
  /* For a derived claim: the refs of the claims it was computed from, when
     the packet presents them. */
  inputRefs: string[];
};

export type PacketAnchor = {
  anchorId: string;
  sourceKind: AnchorSourceKind;
  sourceId: string | null;
  segmentId: string | null;
  locator: Locator;
  quotedText: string | null;
};

export type PacketAssessment = {
  claimRef: string;
  assessment: AssessmentKind;
  reasonCode: string;
  explanation: string;
  anchorIds: string[];
  /* What the assessor read off the source instead, when it read otherwise.
     An arbiter may correct only to one of these. */
  proposedValue: ClaimValue | null;
  proposedUnit: string | null;
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
  phase: TaskPhase;
  roleKey: string;
  roleVersion: string;
  taskType: string;
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
    maximumOutputBytes: number;
  };
  expectedOutputContract: string;
  inputFingerprint: string;
  context: {
    claims: PacketClaim[];
    assessments: PacketAssessment[];
    disagreements: PacketDisagreement[];
    depth: number;
    validation: string[];
  };
};

/* ───────────────────────────────────────────────────── the result envelope */

/* A value is typed and carries its original text. `known: false` means the
   agent could not read it; then quantity and text are null — never zero,
   never an empty string standing in for zero. Attributes are material: two
   readings that agree on quantity and differ on an attribute differ. */
export type ClaimValue = {
  known: boolean;
  quantity: number | null;
  text: string | null;
  attributes?: Record<string, string | number | null>;
};

export type ProposedClaim = {
  claimKey: string;
  subjectType: string;
  subjectKey: string;
  predicate: string;
  value: ClaimValue;
  unit: string | null;
  observationBasis: ObservationBasis;
  scope: Record<string, string>;
  anchorKeys: string[];
  machineConfidence: number | null;
  /* For derived claims: the refs of the claims this one was computed from. */
  inputClaimIds?: string[];
};

export type ProposedAnchor = {
  anchorKey: string;
  sourceKind: AnchorSourceKind;
  sourceId: string | null;
  segmentId: string | null;
  locator: Locator;
  quotedText: string | null;
};

export type ProposedSegment = SegmentDescriptor & {
  segmentKey: string;
};

export type ProposedAssessment = {
  claimRef: string;
  assessment: AssessmentKind;
  reasonCode: string;
  explanation: string;
  anchorKeys: string[];
  /* A verifier that finds the source reads otherwise may say what it reads.
     A correction the arbiter proposes must match one of these. */
  proposedValue?: ClaimValue | null;
  proposedUnit?: string | null;
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
  targetSegmentIds: string[];
  expectedInformation: string;
  parentTaskId: string;
  currentDepth: number;
  idempotencyFingerprint: string;
  subjectKey?: string;
  claimRef?: string;
};

export type AdjudicationOutcome = "accept_claim" | "correct" | "reject_all" | "needs_more_evidence" | "needs_human";

export type ProposedAdjudication = {
  outcome: AdjudicationOutcome;
  disagreementId: string;
  acceptedClaimRef: string | null;
  correctedValue: ClaimValue | null;
  correctedUnit: string | null;
  rationale: string;
  evidenceAnchorIds: string[];
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
  segments: ProposedSegment[];
  assessments: ProposedAssessment[];
  disagreements: ProposedDisagreement[];
  requestedActions: RequestedAgentAction[];
  limitations: string[];
  rawResponseReference: string | null;
  adjudication: ProposedAdjudication | null;
  decisions: ProposedDecision[];
  calculations: ProposedCalculation[];
};

/* ─────────────────────────────────────────────────────── persisted records */

export type TaskSourceRef = { sourceId: string | null; segmentId: string | null };

export type TaskRecord = {
  taskId: string;
  workflowId: string;
  parentTaskId: string | null;
  createdByTaskId: string | null;
  phase: TaskPhase;
  taskType: string;
  roleKey: string;
  roleVersion: string;
  subjectKey: string;
  priority: number;
  sources: TaskSourceRef[];
  inputFingerprint: string;
  contractVersion: string;
  independenceGroup: string | null;
  depth: number;
  criticRound: number;
  arbiterRound: number;
  disagreementId: string | null;
  targetClaimIds: string[];
  maxClaims: number;
  state: TaskState;
  leaseOwner: string | null;
  leaseToken: string | null;
  leaseExpiresAt: number | null;
  terminalReason: string | null;
};

export type DependencyRecord = {
  taskId: string;
  dependsOnTaskId: string;
  kind: DependencyKind;
};

export type AttemptRecord = {
  attemptId: string;
  workflowId: string;
  taskId: string;
  attemptNo: number;
  roleKey: string;
  roleVersion: string;
  executorKind: ExecutorKind;
  executorFamily: string;
  /* The executor's identity, as the registry assigned it. Not a label. */
  independenceDomain: string;
  modelConfiguration: string;
  state: AttemptState;
  leaseToken: string | null;
  packetFingerprint: string;
  packetBytes: number;
  providerRequestId: string | null;
  modelReported: string | null;
  usage: Record<string, unknown>;
  /* The envelope as returned, valid or not. Written once, never deleted. */
  rawResult: unknown;
  rawResultHash: string | null;
  validationState: ValidationState;
  validationProblems: string[];
  errorCode: string | null;
  errorMessage: string | null;
  /* For an attempt whose outcome this kernel never saw: what the executor
     later said became of it. Null until asked; written once. Never a reason
     to retry by machine. */
  reconciliationOutcome: ReconciliationOutcome | null;
};

export type ReconciliationOutcome = "unknown" | "never_started" | "completed" | "failed";

export type ClaimRecord = {
  claimId: string;
  workflowId: string;
  taskId: string | null;
  attemptId: string | null;
  independenceGroup: string | null;
  independenceDomain: string | null;
  subjectType: string;
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
  supersedesClaimId: string | null;
};

export type AnchorRecord = {
  anchorId: string;
  workflowId: string;
  claimId: string | null;
  assessmentId: string | null;
  sourceKind: AnchorSourceKind;
  sourceId: string | null;
  segmentId: string | null;
  locator: Locator;
  quotedText: string | null;
  anchorHash: string;
};

export type AssessmentRecord = {
  assessmentId: string;
  workflowId: string;
  claimId: string;
  attemptId: string;
  taskId: string;
  assessment: AssessmentKind;
  reasonCode: string;
  explanation: string;
  anchorIds: string[];
  proposedValue: ClaimValue | null;
  proposedUnit: string | null;
  /* Copied from the attempt, so acceptance can check independence without a join. */
  independenceDomain: string;
};

export type DisagreementFollowUp = { round: number; fingerprint: string; taskId: string | null };

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
  followUps: DisagreementFollowUp[];
  needsHumanReason: string | null;
};

export type DecisionEvidenceLink = { claimId: string | null; anchorId: string | null; link: "supports" | "contradicts" | "context"; rule: string | null };

export type DecisionRecord = {
  decisionId: string;
  workflowId: string;
  taskId: string | null;
  disagreementId: string | null;
  decisionType: DecisionType;
  subjectKey: string;
  title: string;
  status: DecisionStatus;
  authority: DecisionAuthority;
  rationale: string;
  riskLevel: "critical" | "high" | "normal" | "low";
  decidedByAttemptId: string | null;
  evidence: DecisionEvidenceLink[];
  actions: { actionType: DecisionActionType; ownerRole: string }[];
  summary: ProposedDecision["summary"] | null;
};

export type WorkflowBudget = {
  maximum_tasks: number;
  maximum_dependency_edges: number;
  maximum_child_tasks_per_parent: number;
  maximum_follow_up_depth: number;
  maximum_critic_rounds: number;
  maximum_arbiter_rounds: number;
};

export type WorkflowRecord = {
  workflowId: string;
  organizationId: string;
  domainPack: string;
  domainPackVersion: string;
  workflowType: string;
  engineVersion: string;
  state: WorkflowState;
  sourceSetFingerprint: string;
  requestFingerprint: string;
  requestedScope: Record<string, unknown>;
  budget: WorkflowBudget;
  cancelRequestedAt: number | null;
  totalUnits: number;
  completedUnits: number;
  attentionUnits: number;
  errorCode: string | null;
  errorMessage: string | null;
};

export type AuditRecord = {
  action: string;
  entityType: string;
  entityId: string;
  detail: Record<string, unknown>;
};
