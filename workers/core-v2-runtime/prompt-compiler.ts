/* THE PACKET, SAID IN WORDS — AND NOTHING ELSE SAID AT ALL.
 *
 * A packet is already the whole of what an agent may know: the kernel decided
 * that when it built the packet, and no sentence written here can widen it.
 * So this file is deliberately dull. It turns the fields of one WorkPacket
 * into instructions, states the role it was assigned, states exactly the
 * actions the packet permits, and asks for the envelope the kernel already
 * defines. It adds no fact of its own.
 *
 * What it therefore never writes: a provider, an address, a model, a price,
 * another agent's reading, who read anything before, how many readings agree,
 * a count of anything dressed as proof, or any identifier the packet did not
 * carry. Those are not omitted by taste; a compiler that could write them
 * would be a hole in the blindness the kernel spent the packet enforcing.
 *
 * This file is outside the kernel and names no provider. The adapters in
 * providers/ take what comes back from here and shape it into their own
 * request; the shape of the ANSWER is fixed here, from the kernel's own
 * AgentResultEnvelope, so every provider is asked for exactly one thing.
 */
import type {
  AgentActionType, AgentRoleDefinition, PacketAssessment, PacketClaim, PacketDisagreement, SourceReference, WorkPacket,
} from "../core-v2/kernel/contracts.ts";
import { canonical } from "../core-v2/kernel/ids.ts";

export const PROMPT_COMPILER_VERSION = "core-v2.prompt.1";

export type CompiledPrompt = {
  /* Who the agent is and the rules it works under. Role and rules only. */
  system: string;
  /* The one assignment: what to do, what may be read, what may be asked for. */
  user: string;
  /* The strict envelope the adapters ask for, mirroring AgentResultEnvelope. */
  schema: unknown;
};

/* ─────────────────────────────────────────────────── the sentences, once
 *
 * Exported so a test can prove a rule is present without matching prose by
 * eye, and so the same words are used for every role.
 */

export const WORK_ONLY_FROM_THE_PACKET =
  "Work only from what this assignment gives you. Add nothing from memory, from training, or from any other source.";

export const CITE_ONLY_GIVEN_IDENTIFIERS =
  "Every claim you make must carry at least one anchor, and every anchor must name the sourceId — and, where one is given, the segmentId — of material listed under \"what you may read\". Every identifier you cite anywhere in your answer must be one written out for you under \"what you may read\" or \"what you are shown\", copied exactly as it appears there. Never invent, abbreviate, complete or guess an identifier, and never anchor to anything that was not given to you.";

export const ABSTENTION_RULE =
  "If what you were given is not enough to answer, abstain: return the outcome insufficient_evidence, return no claim you cannot anchor, and write what was missing under limitations. Guessing is a failure. Abstaining is not.";

export const UNKNOWN_IS_NULL =
  "Anything you cannot read is unknown: set known to false and leave quantity and text null. Never write zero, an empty string, or a plausible number in place of something you could not read.";

export const NO_OTHER_AGENTS =
  "Do not name, address, imitate or reason about any other agent. Do not refer to any other reading of this material, and do not count or weigh how many others agree with anything. Counting agreement is no part of your work.";

export const AGREEMENT_IS_NOT_PROOF =
  "Agreement is not proof. Only the evidence you cite is.";

export const NOTHING_ABOUT_WHO_ELSE_READ =
  "You are given no information about what else has read this material, or about what produced any other reading. Do not ask for it and do not speculate about it.";

export const ANSWER_IS_THE_ENVELOPE =
  "Return exactly one JSON object satisfying the schema supplied with this request, and nothing else: no preamble, no commentary outside the fields, no code fence. Every field the schema requires must be present; an array with nothing to report is empty; rawResponseReference is null.";

/* Said only when the packet hands over nothing at all to work from. */
export const NOTHING_TO_READ =
  "You were given nothing to read and nothing to work from. Do not answer from anything else: return the outcome insufficient_evidence, no claims and no anchors, and say under limitations that no material was supplied.";

/* Said only when the packet permits no follow-up at all. */
export const NO_FOLLOW_UP =
  "You may ask for nothing further. Answer from the material above, or say that it is not enough.";

export const BLIND_READING =
  "This is a reading of your own. Work from the material above and from nothing else; nothing further about this subject is available to you.";

const RULES: string[] = [
  WORK_ONLY_FROM_THE_PACKET,
  CITE_ONLY_GIVEN_IDENTIFIERS,
  ABSTENTION_RULE,
  UNKNOWN_IS_NULL,
  NO_OTHER_AGENTS,
  AGREEMENT_IS_NOT_PROOF,
  NOTHING_ABOUT_WHO_ELSE_READ,
  ANSWER_IS_THE_ENVELOPE,
];

/* What each permitted ask means, in words that name nothing outside the
   kernel's own vocabulary of asks. */
const ACTION_MEANING: Record<AgentActionType, string> = {
  open_linked_segment: "open a segment that the material you were given links to",
  expand_segment: "widen the bounds of a segment you were given",
  read_related_segment: "read a segment related to the one you were given",
  read_reference_segment: "read a segment held as reference material",
  check_unit: "check which unit a value is written in",
  request_independent_reader: "ask for a further separate reading of the material",
  request_evidence_critic: "ask for the evidence behind a claim to be checked",
  request_disagreement_verification: "ask for the contested material to be read again",
  request_human_review: "ask for a person to look at this",
};

/* ─────────────────────────────────────────────────────────── the compiler */

export function compilePrompt(packet: WorkPacket, role: AgentRoleDefinition): CompiledPrompt {
  if (packet.roleKey !== role.roleKey) throw new Error(`core-v2-runtime: packet is for ${packet.roleKey}, role is ${role.roleKey}`);
  return { system: systemText(packet, role), user: userText(packet, role), schema: envelopeSchema(packet, role) };
}

function systemText(packet: WorkPacket, role: AgentRoleDefinition): string {
  const lines: string[] = [];
  lines.push("You are one agent inside an evidence engine. You do one bounded piece of work and return one structured result. Nothing else you write is read.");
  lines.push("");
  lines.push("── your role ──");
  lines.push(`role: ${packet.roleKey} (version ${packet.roleVersion})`);
  lines.push(`kind: ${role.kind}`);
  lines.push(`phase: ${packet.phase}`);
  lines.push(`you are handed: ${role.inputContract}`);
  lines.push(`you must return: ${packet.expectedOutputContract}`);
  lines.push("You are this role and no other. Do not do another role's work, and do not answer as though you had been given another role's material.");
  lines.push("");
  lines.push("── what your result may carry ──");
  for (const line of mayReturn(packet, role)) lines.push(`  · ${line}`);
  lines.push("Every other part of the result must be empty.");
  lines.push("");
  lines.push("── the rules ──");
  for (const rule of RULES) lines.push(`  · ${rule}`);
  return lines.join("\n");
}

function mayReturn(packet: WorkPacket, role: AgentRoleDefinition): string[] {
  const out: string[] = [];
  if (packet.limits.maximumClaims > 0) out.push("claims — each one anchored to the material you were given");
  if (role.producesSegments) out.push("segments — the bounded parts you found, with their geometry inside what you were given");
  /* A CLAIM IS NAMED BY THE REF IT WAS SHOWN UNDER, AND BY NOTHING ELSE.
     Every claim in the packet is rendered as "claim <ref>", and the kernel
     matches an assessment or an adjudication to a claim by that ref alone. A
     critic that returns "claim A" has done its work and lost it: the first
     critic a paid canary ever got an answer out of read all three entries
     correctly, assessed each with the anchor it read them at, and was
     refused three times for naming them A, B and C — a convention it had
     from somewhere other than the packet. Say which name to use, once, here,
     for every role that refers to a claim it was given. */
  if (role.producesAssessments) {
    out.push("one assessment for each claim you were shown, anchored where you read it — its claimRef is that claim's ref exactly as it appears after the word \"claim\", copied character for character, never a label of your own like \"claim A\"");
  }
  if (role.kind === "comparator") out.push("the differences you found between the readings you were shown");
  if (role.producesAdjudication) {
    out.push("one adjudication for the contested subject you were given, naming any claim by the ref it was shown under, copied character for character");
  }
  if (role.producesDecisions) out.push("what the accepted evidence supports, in the fields the schema names");
  if (role.producesCalculations) out.push("the calculations you performed, naming every input");
  if (packet.allowedActions.length > 0) out.push("requests for further bounded work, from the list of permitted asks");
  out.push("limitations — anything you could not do, in plain words");
  return out;
}

function userText(packet: WorkPacket, role: AgentRoleDefinition): string {
  const lines: string[] = [];
  lines.push("── the assignment ──");
  lines.push(`taskId: ${packet.taskId}`);
  lines.push(`subject: ${packet.subjectKey}`);
  lines.push(`packetVersion: ${packet.packetVersion}`);
  lines.push(`roleKey: ${packet.roleKey}`);
  lines.push(`roleVersion: ${packet.roleVersion}`);
  lines.push("Copy taskId, packetVersion, roleKey and roleVersion into your result exactly as written here.");
  lines.push("");
  lines.push("objective:");
  lines.push(`  ${packet.objective}`);
  if (packet.blindContext) { lines.push(""); lines.push(BLIND_READING); }

  lines.push("");
  lines.push("── what you may read ──");
  if (packet.sources.length === 0) lines.push("  nothing was supplied to read.");
  for (const [i, source] of packet.sources.entries()) for (const line of renderSource(source, i)) lines.push(line);

  const shown = packet.context.claims.length + packet.context.assessments.length + packet.context.disagreements.length + packet.context.validation.length;
  if (shown > 0) {
    lines.push("");
    lines.push("── what you are shown ──");
    for (const claim of packet.context.claims) for (const line of renderClaim(claim)) lines.push(line);
    for (const assessment of packet.context.assessments) for (const line of renderAssessment(assessment)) lines.push(line);
    for (const disagreement of packet.context.disagreements) for (const line of renderDisagreement(disagreement)) lines.push(line);
    for (const note of packet.context.validation) lines.push(`  note from code: ${note}`);
  }

  if (packet.sources.length === 0 && packet.context.claims.length === 0) { lines.push(""); lines.push(NOTHING_TO_READ); }

  lines.push("");
  lines.push("── what you may ask for ──");
  if (packet.allowedActions.length === 0) lines.push(NO_FOLLOW_UP);
  else {
    lines.push("You may ask the orchestrator for exactly these, and for nothing else:");
    for (const action of packet.allowedActions) lines.push(`  · ${action} — ${ACTION_MEANING[action]}`);
    lines.push("Each request must give a reasonCode, what you expect to learn in expectedInformation, and the segment identifiers it concerns — identifiers from \"what you may read\" only.");
    lines.push(`parentTaskId for any request: ${packet.taskId}`);
    lines.push(`currentDepth for any request: ${packet.context.depth}`);
  }

  lines.push("");
  lines.push("── your limits ──");
  lines.push(packet.limits.maximumClaims === 0 ? "  no claims — this role reports no claim of its own" : `  at most ${packet.limits.maximumClaims} claims`);
  lines.push(`  at most ${packet.limits.maximumFollowUps} requests for further work`);
  lines.push(`  at most ${packet.limits.maximumSources} piece${packet.limits.maximumSources === 1 ? "" : "s"} of material`);
  lines.push(`  no request may go deeper than ${packet.limits.maximumDepth}; you are at depth ${packet.context.depth}`);
  lines.push(`  at most ${packet.limits.maximumOutputBytes} bytes of result`);
  lines.push(`  a result over that size is truncated and lost, so keep quoted text to what the anchor needs`);
  if (role.requiresVisualInput) lines.push("  read the material as it is shown; do not answer from a description of it");
  return lines.join("\n");
}

function renderSource(source: SourceReference, index: number): string[] {
  const lines: string[] = [];
  lines.push(`  material ${index + 1} — ${source.kind}`);
  lines.push(`    sourceId: ${source.sourceId}`);
  lines.push(`    segmentId: ${source.segmentId ?? "none — this is a whole source"}`);
  if (source.parentSegmentId !== null) lines.push(`    parentSegmentId: ${source.parentSegmentId}`);
  lines.push(`    sourceKind: ${source.sourceKind}`);
  if (source.segmentKind !== null) lines.push(`    segmentKind: ${source.segmentKind}`);
  lines.push(`    label: ${source.label ?? "none"}`);
  lines.push(`    ordinal: ${source.ordinal}`);
  lines.push(`    locator: ${canonical(source.locator)}`);
  lines.push(`    contentHash: ${source.contentHash}`);
  return lines;
}

function renderClaim(claim: PacketClaim): string[] {
  const lines: string[] = [];
  lines.push(`  claim ${claim.ref}`);
  lines.push(`    subject: ${claim.subjectType} ${claim.subjectKey}`);
  lines.push(`    predicate: ${claim.predicate}`);
  lines.push(`    value: ${canonical(claim.value)}`);
  lines.push(`    unit: ${claim.unit ?? "none given"}`);
  lines.push(`    basis: ${claim.observationBasis}`);
  lines.push(`    status: ${claim.status}`);
  if (Object.keys(claim.scope).length > 0) lines.push(`    scope: ${canonical(claim.scope)}`);
  if (claim.inputRefs.length > 0) lines.push(`    computed from: ${claim.inputRefs.join(", ")}`);
  for (const anchor of claim.anchors) {
    lines.push(`    anchor ${anchor.anchorId}: ${anchor.sourceKind} sourceId=${anchor.sourceId ?? "none"} segmentId=${anchor.segmentId ?? "none"} locator=${canonical(anchor.locator)}${anchor.quotedText === null ? "" : ` quoted=${JSON.stringify(anchor.quotedText)}`}`);
  }
  return lines;
}

function renderAssessment(assessment: PacketAssessment): string[] {
  const lines: string[] = [];
  lines.push(`  assessment of claim ${assessment.claimRef}: ${assessment.assessment} (${assessment.reasonCode})`);
  lines.push(`    ${assessment.explanation}`);
  if (assessment.anchorIds.length > 0) lines.push(`    anchors: ${assessment.anchorIds.join(", ")}`);
  if (assessment.proposedValue !== null) lines.push(`    read instead: ${canonical(assessment.proposedValue)}${assessment.proposedUnit === null ? "" : ` unit ${assessment.proposedUnit}`}`);
  return lines;
}

function renderDisagreement(disagreement: PacketDisagreement): string[] {
  const lines: string[] = [];
  lines.push(`  contested subject ${disagreement.disagreementId}: ${disagreement.kind}, ${disagreement.severity}`);
  lines.push(`    over claims: ${disagreement.claimRefs.join(", ")}`);
  lines.push(`    signature: ${canonical(disagreement.subjectSignature)}`);
  return lines;
}

/* ───────────────────────────────────────── the envelope, as a strict schema
 *
 * Mirrors kernel/contracts.ts AgentResultEnvelope field for field. The
 * vocabularies below are the contract's own unions written out, because a
 * type is not a value at run time; a test in this package holds them against
 * the contract's source so drift is caught rather than shipped.
 */

export const ENVELOPE_VOCABULARY: Record<string, string[]> = {
  EnvelopeOutcome: ["completed", "needs_follow_up", "insufficient_evidence", "failed_known", "outcome_unknown"],
  ObservationBasis: ["observed", "derived", "inferred", "reported"],
  AnchorSourceKind: ["segment_locator", "segment", "source", "human_record"],
  AssessmentKind: ["supports", "contradicts", "insufficient", "wrong_scope", "wrong_unit", "duplicate", "unreadable"],
  DisagreementKind: ["missing", "value", "unit", "scope", "basis", "identity", "duplicate", "coverage"],
  DisagreementSeverity: ["critical", "material", "informational"],
  AdjudicationOutcome: ["accept_claim", "correct", "reject_all", "needs_more_evidence", "needs_human"],
  DecisionType: ["accept_claim", "reject_claim", "reject_all", "hold", "proceed", "request_information", "supersede"],
  DecisionActionType: ["review", "verify_source", "request_information", "proceed", "hold"],
};

const RISK_LEVELS = ["critical", "high", "normal", "low"];

type Node = Record<string, unknown>;

const ref = (name: string): Node => ({ $ref: `#/$defs/${name}` });
const str = (): Node => ({ type: "string" });
const nullableStr = (): Node => ({ type: ["string", "null"] });
const strings = (): Node => ({ type: "array", items: { type: "string" } });

function object(properties: Record<string, Node>, required: string[]): Node {
  return { type: "object", additionalProperties: false, properties, required };
}

function arrayOf(item: Node, maximum: number | null): Node {
  const node: Node = { type: "array", items: item };
  if (maximum !== null) node.maxItems = maximum;
  return node;
}

function definitions(packet: WorkPacket): Record<string, Node> {
  const actionType: Node = packet.allowedActions.length > 0 ? { enum: [...packet.allowedActions] } : str();
  return {
    Locator: { type: "object", description: "geometry inside the material: bbox for an image, start_ms/end_ms for a recording", properties: { bbox: { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4 }, start_ms: { type: "number" }, end_ms: { type: "number" } }, additionalProperties: true },
    ClaimValue: object({
      known: { type: "boolean" },
      quantity: { type: ["number", "null"] },
      text: nullableStr(),
      attributes: { type: "object", additionalProperties: { type: ["string", "number", "null"] } },
    }, ["known", "quantity", "text"]),
    ProposedClaim: object({
      claimKey: str(), subjectType: str(), subjectKey: str(), predicate: str(),
      value: ref("ClaimValue"), unit: nullableStr(),
      observationBasis: { enum: [...ENVELOPE_VOCABULARY.ObservationBasis] },
      scope: { type: "object", additionalProperties: { type: "string" } },
      anchorKeys: strings(),
      machineConfidence: { type: ["number", "null"] },
      inputClaimIds: strings(),
    }, ["claimKey", "subjectType", "subjectKey", "predicate", "value", "unit", "observationBasis", "scope", "anchorKeys", "machineConfidence"]),
    ProposedAnchor: object({
      anchorKey: str(),
      sourceKind: { enum: [...ENVELOPE_VOCABULARY.AnchorSourceKind] },
      sourceId: nullableStr(), segmentId: nullableStr(), locator: ref("Locator"), quotedText: nullableStr(),
    }, ["anchorKey", "sourceKind", "sourceId", "segmentId", "locator", "quotedText"]),
    ProposedSegment: object({
      segmentKey: str(), sourceId: str(), parentSegmentId: nullableStr(), segmentKind: str(),
      label: nullableStr(), ordinal: { type: "integer" }, locator: ref("Locator"), contentHash: str(),
    }, ["segmentKey", "sourceId", "parentSegmentId", "segmentKind", "label", "ordinal", "locator", "contentHash"]),
    ProposedAssessment: object({
      claimRef: str(),
      assessment: { enum: [...ENVELOPE_VOCABULARY.AssessmentKind] },
      reasonCode: str(), explanation: str(), anchorKeys: strings(),
      proposedValue: { oneOf: [ref("ClaimValue"), { type: "null" }] },
      proposedUnit: nullableStr(),
    }, ["claimRef", "assessment", "reasonCode", "explanation", "anchorKeys"]),
    ProposedDisagreement: object({
      disagreementKey: str(),
      kind: { enum: [...ENVELOPE_VOCABULARY.DisagreementKind] },
      severity: { enum: [...ENVELOPE_VOCABULARY.DisagreementSeverity] },
      subjectSignature: { type: "object", additionalProperties: { type: "string" } },
      claimIds: strings(),
    }, ["disagreementKey", "kind", "severity", "subjectSignature", "claimIds"]),
    RequestedAgentAction: object({
      actionType, reasonCode: str(), targetSegmentIds: strings(), expectedInformation: str(),
      parentTaskId: { const: packet.taskId }, currentDepth: { type: "integer", maximum: packet.limits.maximumDepth },
      idempotencyFingerprint: str(), subjectKey: str(), claimRef: str(),
    }, ["actionType", "reasonCode", "targetSegmentIds", "expectedInformation", "parentTaskId", "currentDepth", "idempotencyFingerprint"]),
    ProposedAdjudication: object({
      outcome: { enum: [...ENVELOPE_VOCABULARY.AdjudicationOutcome] },
      disagreementId: str(), acceptedClaimRef: nullableStr(),
      correctedValue: { oneOf: [ref("ClaimValue"), { type: "null" }] },
      correctedUnit: nullableStr(), rationale: str(), evidenceAnchorIds: strings(),
      followUp: { oneOf: [ref("RequestedAgentAction"), { type: "null" }] },
    }, ["outcome", "disagreementId", "acceptedClaimRef", "correctedValue", "correctedUnit", "rationale", "evidenceAnchorIds", "followUp"]),
    DecisionSummary: object({ known: str(), conflicts: str(), canProceed: str(), mustWait: str(), supportingEvidence: str() },
      ["known", "conflicts", "canProceed", "mustWait", "supportingEvidence"]),
    DecisionAction: object({ actionType: { enum: [...ENVELOPE_VOCABULARY.DecisionActionType] }, ownerRole: str() }, ["actionType", "ownerRole"]),
    ProposedDecision: object({
      decisionType: { enum: [...ENVELOPE_VOCABULARY.DecisionType] },
      title: str(), summary: ref("DecisionSummary"),
      supportingClaimIds: strings(), contradictingClaimIds: strings(),
      riskLevel: { enum: [...RISK_LEVELS] },
      actions: { type: "array", items: ref("DecisionAction") },
    }, ["decisionType", "title", "summary", "supportingClaimIds", "contradictingClaimIds", "riskLevel", "actions"]),
    ProposedCalculation: object({
      calculationKey: str(), formula: str(), inputClaimIds: strings(), unit: nullableStr(),
      wasteAssumption: nullableStr(), rounding: nullableStr(), result: { type: ["number", "null"] },
    }, ["calculationKey", "formula", "inputClaimIds", "unit", "wasteAssumption", "rounding", "result"]),
  };
}

/* The envelope the packet's role is allowed to return: every field of
   AgentResultEnvelope, with the parts this role may not produce capped at
   nothing, and the parts the kernel already knows fixed to what it knows. */
export function envelopeSchema(packet: WorkPacket, role: AgentRoleDefinition): Node {
  const cap = (allowed: boolean): number | null => (allowed ? null : 0);
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "AgentResultEnvelope",
    description: `the only shape an answer to ${packet.roleKey} may take`,
    type: "object",
    additionalProperties: false,
    required: [
      "packetVersion", "taskId", "roleKey", "roleVersion", "outcome", "claims", "anchors", "segments",
      "assessments", "disagreements", "requestedActions", "limitations", "rawResponseReference",
      "adjudication", "decisions", "calculations",
    ],
    properties: {
      packetVersion: { const: packet.packetVersion },
      taskId: { const: packet.taskId },
      roleKey: { const: packet.roleKey },
      roleVersion: { const: packet.roleVersion },
      outcome: { enum: [...ENVELOPE_VOCABULARY.EnvelopeOutcome] },
      claims: arrayOf(ref("ProposedClaim"), packet.limits.maximumClaims),
      anchors: arrayOf(ref("ProposedAnchor"), null),
      segments: arrayOf(ref("ProposedSegment"), cap(role.producesSegments)),
      assessments: arrayOf(ref("ProposedAssessment"), cap(role.producesAssessments)),
      disagreements: arrayOf(ref("ProposedDisagreement"), cap(role.kind === "comparator")),
      requestedActions: arrayOf(ref("RequestedAgentAction"), packet.allowedActions.length > 0 ? packet.limits.maximumFollowUps : 0),
      limitations: strings(),
      rawResponseReference: { type: "null" },
      adjudication: role.producesAdjudication ? { oneOf: [ref("ProposedAdjudication"), { type: "null" }] } : { type: "null" },
      decisions: arrayOf(ref("ProposedDecision"), cap(role.producesDecisions)),
      calculations: arrayOf(ref("ProposedCalculation"), cap(role.producesCalculations)),
    },
    $defs: definitions(packet),
  };
}
