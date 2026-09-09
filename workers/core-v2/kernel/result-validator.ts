/* WHAT AN ENVELOPE MUST BE BEFORE ANY OF IT BECOMES EVIDENCE.
 *
 * An agent's answer is kept whatever it looks like — the attempt stores the
 * raw envelope, valid or not. But nothing in it enters the record until it
 * passes here, and the rules are the product's, not the model's:
 *
 *   · a claim with no anchor is not a claim;
 *   · an anchor is one consistent tuple — source, segment, locator — and
 *     points at a segment the packet handed over, inside that segment;
 *   · a model role observes or infers; only code derives, only a person reports;
 *   · an unknown is null; a known value has a reading;
 *   · a critic's verdict is anchored where the claim it judges is anchored,
 *     and it gives one verdict per claim;
 *   · an arbiter accepts only a reading an assessment supports and none
 *     contradicts, corrects only to a value an assessment proposed, rejects
 *     everything only when an assessment contradicts each reading, and its
 *     evidence is what the packet showed it;
 *   · a composer cites only claims of its own subject, which are the only
 *     claims it was shown;
 *   · code names inputs the packet presented;
 *   · the domain pack's rules on top, never instead.
 *
 * Validation is all or nothing. A partly valid envelope persists nothing.
 */
import type {
  AgentResultEnvelope, AgentRoleDefinition, ClaimValue, PacketClaim, ProposedAnchor, ProposedClaim, WorkPacket,
} from "./contracts.ts";
import { PACKET_VERSION } from "./contracts.ts";
import type { DomainPack } from "./domain.ts";
import { canonical } from "./ids.ts";
import { hasGeometry, locatorInside, locatorProblem, sameLocator } from "./locators.ts";
import type { Lookup } from "./planning.ts";
import type { OrchestrationPolicy } from "./policy.ts";

export type Validation = { ok: boolean; problems: string[] };

export type ValidationContext = {
  role: AgentRoleDefinition;
  pack: DomainPack;
  lookup: Lookup;
  policy: OrchestrationPolicy;
};

const NEGATIVE_ASSESSMENTS = new Set(["contradicts", "wrong_scope", "wrong_unit", "duplicate", "insufficient", "unreadable"]);
const REJECTING_ASSESSMENTS = new Set(["contradicts", "wrong_scope", "wrong_unit", "duplicate"]);

export function validateEnvelope(packet: WorkPacket, envelope: AgentResultEnvelope, ctx: ValidationContext): Validation {
  const { role, pack, lookup, policy } = ctx;
  const problems: string[] = [];

  if (envelope.packetVersion !== PACKET_VERSION) problems.push(`envelope version ${envelope.packetVersion} is not ${PACKET_VERSION}`);
  if (envelope.taskId !== packet.taskId) problems.push("envelope answers a different task");
  if (envelope.roleKey !== packet.roleKey) problems.push(`envelope is from ${envelope.roleKey}, packet was for ${packet.roleKey}`);

  for (const field of ["claims", "anchors", "segments", "assessments", "disagreements", "requestedActions", "decisions", "calculations", "limitations"] as const) {
    if (!Array.isArray(envelope[field])) problems.push(`envelope lacks a ${field} array`);
  }
  if (envelope.adjudication !== null && envelope.adjudication !== undefined) {
    const adj = envelope.adjudication;
    if (typeof adj !== "object" || !Array.isArray(adj.evidenceAnchorIds)) problems.push("adjudication is not the shape of an adjudication");
  }
  if (problems.length) return { ok: false, problems };
  if (envelope.outcome === "outcome_unknown" || envelope.outcome === "failed_known") return { ok: true, problems };

  const bytes = Buffer.byteLength(JSON.stringify(envelope), "utf8");
  if (bytes > policy.maximumEnvelopeBytes) problems.push(`envelope is ${bytes} bytes; the policy allows ${policy.maximumEnvelopeBytes}`);

  for (const c of envelope.claims) {
    if (!c || typeof c !== "object" || typeof c.claimKey !== "string") problems.push("a claim is not the shape of a claim");
    else if (c.anchorKeys !== undefined && !Array.isArray(c.anchorKeys)) problems.push(`claim ${c.claimKey} anchorKeys is not a list`);
  }
  for (const a of envelope.anchors) if (!a || typeof a !== "object" || typeof a.anchorKey !== "string" || (a.locator !== undefined && (typeof a.locator !== "object" || a.locator === null))) problems.push("an anchor is not the shape of an anchor");
  for (const s of envelope.segments) if (!s || typeof s !== "object" || typeof s.segmentKey !== "string") problems.push("a segment is not the shape of a segment");
  for (const a of envelope.assessments) if (!a || typeof a !== "object" || !Array.isArray(a.anchorKeys)) problems.push("an assessment is not the shape of an assessment");
  for (const c of envelope.calculations) if (!c || typeof c !== "object" || !Array.isArray(c.inputClaimIds)) problems.push("a calculation is not the shape of a calculation");
  for (const d of envelope.decisions) if (!d || typeof d !== "object" || !Array.isArray(d.supportingClaimIds) || !Array.isArray(d.contradictingClaimIds)) problems.push("a decision is not the shape of a decision");
  if (problems.length) return { ok: false, problems };

  /* ── what this role may produce at all ── */
  if (!role.producesAssessments && envelope.assessments.length) problems.push(`${role.roleKey} may not return assessments`);
  if (!role.producesAdjudication && envelope.adjudication) problems.push(`${role.roleKey} may not return an adjudication — analysts do not decide`);
  if (!role.producesDecisions && envelope.decisions.length) problems.push(`${role.roleKey} may not return decisions — analysts do not decide`);
  if (!role.producesCalculations && envelope.calculations.length) problems.push(`${role.roleKey} may not return calculations`);
  if (!role.producesSegments && envelope.segments.length) problems.push(`${role.roleKey} may not discover segments`);
  if (role.maximumClaims === 0 && envelope.claims.length) {
    problems.push(`${role.roleKey} may not create claims — ${role.producesAssessments ? "a critic assesses, it does not assert" : "it creates no fact"}`);
  }
  if (envelope.claims.length > packet.limits.maximumClaims) problems.push(`${envelope.claims.length} claims exceeds the task's ${packet.limits.maximumClaims}`);

  /* ── what code must say about its inputs ── */
  const presented = new Set(packet.context.claims.map((c) => c.ref));
  if (role.executorKind === "deterministic" && role.kind !== "ingestor") {
    for (const c of envelope.claims) {
      if (!c.inputClaimIds || c.inputClaimIds.length === 0) problems.push(`derived claim ${c.claimKey} names no inputs — code does not invent`);
      for (const id of c.inputClaimIds ?? []) if (!presented.has(id)) problems.push(`derived claim ${c.claimKey} was computed from ${id}, which the packet did not present`);
    }
    for (const calc of envelope.calculations) {
      if (calc.inputClaimIds.length === 0) problems.push(`calculation ${calc.calculationKey} names no inputs`);
      for (const id of calc.inputClaimIds) if (!presented.has(id)) problems.push(`calculation ${calc.calculationKey} was computed from ${id}, which the packet did not present`);
    }
  }

  /* ── every claim, one at a time ── */
  const anchorKeys = new Set(envelope.anchors.map((a) => a.anchorKey));
  if (anchorKeys.size !== envelope.anchors.length) problems.push("two anchors share one key");
  const seenKeys = new Set<string>();
  for (const claim of envelope.claims) {
    const keys = claim.anchorKeys ?? [];
    if (seenKeys.has(claim.claimKey)) problems.push(`duplicate claim key ${claim.claimKey}`);
    seenKeys.add(claim.claimKey);
    if (typeof claim.subjectType !== "string" || !claim.subjectType || typeof claim.subjectKey !== "string" || !claim.subjectKey || typeof claim.predicate !== "string" || !claim.predicate) problems.push(`claim ${claim.claimKey} lacks a subject or a predicate`);
    if (keys.length === 0) problems.push(`claim ${claim.claimKey} has no anchor`);
    if (new Set(keys).size !== keys.length) problems.push(`claim ${claim.claimKey} names the same anchor more than once`);
    for (const k of keys) if (!anchorKeys.has(k)) problems.push(`claim ${claim.claimKey} points at anchor ${k}, which the envelope does not carry`);
    if (!claim.observationBasis) problems.push(`claim ${claim.claimKey} declares no basis`);
    else if (role.executorKind === "model" && !["observed", "inferred"].includes(claim.observationBasis)) problems.push(`claim ${claim.claimKey} rests on ${claim.observationBasis} — a model observes or infers; only code derives and only a person reports`);
    else if (role.executorKind === "deterministic" && claim.observationBasis !== "derived") problems.push(`claim ${claim.claimKey} from code must be derived`);
    problems.push(...valueProblems(claim.claimKey, claim.value));
    if (claim.machineConfidence !== null && claim.machineConfidence !== undefined && (typeof claim.machineConfidence !== "number" || claim.machineConfidence < 0 || claim.machineConfidence > 1)) problems.push(`claim ${claim.claimKey} confidence is not between 0 and 1`);
    problems.push(...pack.validateClaim(packet, claim, envelope));
  }

  /* ── anchors: one consistent tuple, pointing at what the packet handed over ── */
  const reach = anchorReach(packet, lookup);
  for (const anchor of envelope.anchors) problems.push(...anchorProblems(anchor, reach, role, lookup));

  /* ── segments a discoverer found: inside a source it was handed, inside their parent ── */
  const segmentKeys = new Set<string>();
  const packetSources = new Set(packet.sources.map((s) => s.sourceId));
  for (const s of envelope.segments) {
    if (segmentKeys.has(s.segmentKey)) problems.push(`two segments share the key ${s.segmentKey}`);
    segmentKeys.add(s.segmentKey);
    if (!packetSources.has(s.sourceId)) problems.push(`segment ${s.segmentKey} belongs to a source the packet did not hand over`);
    if (typeof s.segmentKind !== "string" || !s.segmentKind) problems.push(`segment ${s.segmentKey} has no kind`);
    if (typeof s.contentHash !== "string" || !s.contentHash) problems.push(`segment ${s.segmentKey} has no content hash`);
    const problem = locatorProblem(s.locator);
    if (problem) problems.push(`segment ${s.segmentKey}: ${problem}`);
    if (s.parentSegmentId) {
      const parent = lookup.segments.get(s.parentSegmentId);
      if (!parent) problems.push(`segment ${s.segmentKey} names a parent that is not in the record`);
      else {
        if (parent.sourceId !== s.sourceId) problems.push(`segment ${s.segmentKey} names a parent of another source`);
        if (!reach.segments.has(parent.segmentId)) problems.push(`segment ${s.segmentKey} names a parent the packet did not hand over`);
        if (!locatorInside(s.locator, parent.locator)) problems.push(`segment ${s.segmentKey} lies outside its parent`);
      }
    }
  }

  /* ── role-specific shapes ── */
  const claimByRef = new Map(packet.context.claims.map((c) => [c.ref, c] as const));
  const anchorsById = new Set<string>();
  const anchorOwner = new Map<string, string>();
  for (const c of packet.context.claims) for (const a of c.anchors) { anchorsById.add(a.anchorId); anchorOwner.set(a.anchorId, `claim:${c.ref}`); }
  for (const a of packet.context.assessments) for (const id of a.anchorIds) { anchorsById.add(id); anchorOwner.set(id, `assessment:${a.claimRef}:${a.assessment}`); }

  if (role.producesAssessments) {
    const assessed = new Set<string>();
    for (const a of envelope.assessments) {
      const claim = claimByRef.get(a.claimRef);
      if (!claim) { problems.push(`assessment names ${a.claimRef}, which the packet did not present`); continue; }
      if (assessed.has(a.claimRef)) problems.push(`claim ${a.claimRef} is assessed twice in one answer — one critic, one verdict`);
      assessed.add(a.claimRef);
      if (!a.assessment || !["supports", "contradicts", "insufficient", "wrong_scope", "wrong_unit", "duplicate", "unreadable"].includes(a.assessment)) problems.push(`assessment of ${a.claimRef} is ${String(a.assessment)}, which is not a verdict`);
      if (a.anchorKeys.length === 0 && a.assessment !== "unreadable") problems.push(`assessment of ${a.claimRef} names no evidence — that is an opinion`);
      const places = new Set(claim.anchors.flatMap((x) => [x.segmentId, x.sourceId].filter(Boolean) as string[]));
      for (const k of a.anchorKeys) {
        const ev = envelope.anchors.find((x) => x.anchorKey === k);
        if (!ev) { problems.push(`assessment of ${a.claimRef} cites anchor ${k}, which the envelope does not carry`); continue; }
        const at = ev.segmentId ?? ev.sourceId;
        if (places.size && at && !places.has(at) && !(ev.sourceId && places.has(ev.sourceId))) problems.push(`assessment of ${a.claimRef} is anchored at a place the claim it assesses does not point at`);
      }
      if (a.proposedValue !== undefined && a.proposedValue !== null) problems.push(...valueProblems(`the value proposed for ${a.claimRef}`, a.proposedValue));
    }
  }

  if (envelope.adjudication) {
    const adj = envelope.adjudication;
    const assessmentsOf = (ref: string) => packet.context.assessments.filter((a) => a.claimRef === ref);
    for (const id of adj.evidenceAnchorIds) if (!anchorsById.has(id)) problems.push(`adjudication rests on anchor ${id}, which the packet did not present`);
    if (!adj.rationale) problems.push("adjudication gives no rationale");
    if (/majority|most readers|two of three|2 of 3|agree(d|ment) (is|as) proof|outvote/i.test(adj.rationale ?? "")) problems.push("adjudication rests on a majority — that is not evidence");
    const disputedRefs = packet.context.disagreements[0]?.claimRefs ?? [...claimByRef.keys()];
    switch (adj.outcome) {
      case "accept_claim": {
        const ref = adj.acceptedClaimRef;
        if (!ref) { problems.push("adjudication accepts a claim without naming it"); break; }
        if (!claimByRef.has(ref)) { problems.push(`adjudication accepts ${ref}, which the packet did not present`); break; }
        const about = assessmentsOf(ref);
        if (!about.some((a) => a.assessment === "supports")) problems.push(`adjudication accepts ${ref}, which no assessment supports — agreement is not proof`);
        for (const a of about) if (NEGATIVE_ASSESSMENTS.has(a.assessment)) problems.push(`adjudication accepts ${ref}, which an assessment found ${a.assessment} — a person decides that`);
        const own = new Set(claimByRef.get(ref)!.anchors.map((a) => a.anchorId));
        const supporting = new Set(about.filter((a) => a.assessment === "supports").flatMap((a) => a.anchorIds));
        if (!adj.evidenceAnchorIds.some((id) => own.has(id) || supporting.has(id))) problems.push(`adjudication accepts ${ref} on evidence that is not ${ref}'s own anchor nor an assessment supporting it`);
        break;
      }
      case "correct": {
        if (!adj.correctedValue || !adj.correctedValue.known) { problems.push("a correction needs a known corrected value"); break; }
        problems.push(...valueProblems("the correction", adj.correctedValue));
        /* Not an arbitrary value: one a verifier read off the reopened source. */
        const proposals = packet.context.assessments.filter((a) => a.assessment !== "supports" && a.assessment !== "unreadable" && a.assessment !== "insufficient");
        const proposed = proposals.flatMap((a) => (a.proposedValue ? [a.proposedValue] : []));
        if (!proposed.some((v) => sameValue(v, adj.correctedValue!))) problems.push("a correction must be a value an assessment read off the source — this one was proposed by nobody");
        if (adj.evidenceAnchorIds.length === 0) problems.push("a correction needs source anchors — what the source shows instead");
        const negativeAnchors = new Set(proposals.flatMap((a) => a.anchorIds));
        if (!adj.evidenceAnchorIds.some((id) => negativeAnchors.has(id))) problems.push("a correction rests on the assessment that read the corrected value");
        break;
      }
      case "reject_all": {
        if (adj.evidenceAnchorIds.length === 0) problems.push("rejecting every reading needs source evidence of what the source does show");
        const rejectingAnchors = new Set<string>();
        for (const ref of disputedRefs) {
          const negative = assessmentsOf(ref).filter((a) => REJECTING_ASSESSMENTS.has(a.assessment));
          if (negative.length === 0) problems.push(`rejecting every reading needs an assessment against ${ref}, and there is none`);
          for (const a of negative) for (const id of a.anchorIds) rejectingAnchors.add(id);
        }
        if (!adj.evidenceAnchorIds.some((id) => rejectingAnchors.has(id))) problems.push("rejecting every reading rests on the assessments that read against them");
        break;
      }
      case "needs_more_evidence":
        if (!adj.followUp) problems.push("needs_more_evidence names no follow-up — it would loop for ever");
        break;
      case "needs_human":
        break;
      default:
        problems.push(`adjudication outcome ${String(adj.outcome)} is not one the kernel knows`);
    }
  }

  if (role.producesDecisions) {
    for (const d of envelope.decisions) {
      for (const id of [...d.supportingClaimIds, ...d.contradictingClaimIds]) {
        if (!presented.has(id)) problems.push(`decision "${d.title}" cites claim ${id}, which the packet did not present — the composer creates no fact and reaches into no other subject`);
      }
      if (!["accept_claim", "reject_claim", "reject_all", "hold", "proceed", "request_information", "supersede"].includes(d.decisionType)) problems.push(`decision "${d.title}" is of a type the kernel does not know`);
      if (d.decisionType !== "request_information" && d.decisionType !== "hold" && d.supportingClaimIds.length === 0) problems.push(`decision "${d.title}" rests on no accepted claim`);
      for (const key of ["known", "conflicts", "canProceed", "mustWait", "supportingEvidence"] as const) {
        if (!d.summary?.[key]) problems.push(`decision "${d.title}" does not say ${key}`);
      }
    }
  }

  return { ok: problems.length === 0, problems };
}

type Reach = { sources: Set<string>; segments: Set<string> };

/* What an envelope may point at: the sources and segments in the packet —
   and, for a role that works from the record rather than from the source
   itself, the places the claims it was handed point at. A blind reader cites
   nothing but what it was handed. */
function anchorReach(packet: WorkPacket, lookup: Lookup): Reach {
  const sources = new Set<string>();
  const segments = new Set<string>();
  for (const s of packet.sources) { sources.add(s.sourceId); if (s.segmentId) segments.add(s.segmentId); }
  if (!packet.blindContext) {
    for (const c of packet.context.claims) for (const a of c.anchors) {
      if (a.sourceId) sources.add(a.sourceId);
      if (a.segmentId) { segments.add(a.segmentId); const seg = lookup.segments.get(a.segmentId); if (seg) sources.add(seg.sourceId); }
    }
  }
  return { sources, segments };
}

function anchorProblems(anchor: ProposedAnchor, reach: Reach, role: AgentRoleDefinition, lookup: Lookup): string[] {
  const p: string[] = [];
  const locator = anchor.locator ?? {};
  if (JSON.stringify(locator).match(/https?:\/\//)) p.push(`anchor ${anchor.anchorKey} locator carries a URL`);
  const problem = locatorProblem(locator);
  if (problem) p.push(`anchor ${anchor.anchorKey}: ${problem}`);
  switch (anchor.sourceKind) {
    case "human_record":
      if (role.executorKind === "model" || role.executorKind === "deterministic") p.push(`anchor ${anchor.anchorKey} is a human record — a machine role cites the source, never a person`);
      break;
    case "source":
      if (!anchor.sourceId) p.push(`anchor ${anchor.anchorKey} names no source`);
      else if (!reach.sources.has(anchor.sourceId)) p.push(`anchor ${anchor.anchorKey} points at a source the packet did not hand over`);
      break;
    case "segment":
    case "segment_locator": {
      if (!anchor.segmentId) { p.push(`anchor ${anchor.anchorKey} names no segment`); break; }
      const segment = lookup.segments.get(anchor.segmentId);
      if (!segment) { p.push(`anchor ${anchor.anchorKey} points at a segment that is not in the record`); break; }
      if (!reach.segments.has(segment.segmentId)) p.push(`anchor ${anchor.anchorKey} points at ${segment.label ?? segment.segmentId}, which the packet did not hand over`);
      if (anchor.sourceId && anchor.sourceId !== segment.sourceId) p.push(`anchor ${anchor.anchorKey} combines a segment of one source with another source's id`);
      if (anchor.sourceKind === "segment_locator") {
        if (!hasGeometry(locator)) p.push(`anchor ${anchor.anchorKey} names a place in the segment without a box or a range`);
        else if (!locatorInside(locator, segment.locator)) p.push(`anchor ${anchor.anchorKey} lies outside the segment it names`);
      }
      break;
    }
    default:
      p.push(`anchor ${anchor.anchorKey} is of a kind the kernel does not know: ${String(anchor.sourceKind)}`);
  }
  return p;
}

export function valueProblems(label: string, v: ClaimValue | null | undefined): string[] {
  const p: string[] = [];
  if (!v || typeof v !== "object") return [`claim ${label} has no value`];
  const text = typeof v.text === "string" ? v.text.trim() : "";
  const quantity = typeof v.quantity === "number" && Number.isFinite(v.quantity) ? v.quantity : null;
  if (v.quantity !== null && v.quantity !== undefined && quantity === null) p.push(`claim ${label} carries a quantity that is not a finite number`);
  if (v.known === false) {
    if (v.quantity !== null && v.quantity !== undefined) p.push(`claim ${label} is unknown yet carries a quantity — unknown is null, never a number`);
    if (text) p.push(`claim ${label} is unknown yet carries a reading "${text}" — unknown is null, never a text`);
  } else if (v.known === true) {
    if (quantity === null && !text) p.push(`claim ${label} says it is known but carries no reading — a known value has a quantity or a text`);
    if (quantity === 0 && !text) p.push(`claim ${label} reports zero with no source text — a zero is a measurement, and a measurement has a reading`);
  } else {
    p.push(`claim ${label} does not say whether its value is known`);
  }
  if (v.attributes !== undefined && (typeof v.attributes !== "object" || v.attributes === null || Array.isArray(v.attributes))) p.push(`claim ${label} attributes are not a record`);
  return p;
}

export function sameValue(a: ClaimValue, b: ClaimValue): boolean {
  const norm = (v: ClaimValue) => canonical({ k: v.known, q: v.quantity ?? null, t: (v.text ?? "").trim().toLowerCase(), a: v.attributes ?? {} });
  return norm(a) === norm(b);
}

/* Two anchors of one envelope at one place, for packs that need the rule. */
export function anchorsCoincide(a: ProposedAnchor, b: ProposedAnchor): boolean {
  return a.segmentId === b.segmentId && a.sourceId === b.sourceId && sameLocator(a.locator ?? {}, b.locator ?? {});
}

export function presentedClaim(packet: WorkPacket, ref: string): PacketClaim | undefined {
  return packet.context.claims.find((c) => c.ref === ref);
}
