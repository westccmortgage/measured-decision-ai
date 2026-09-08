/* WHAT AN ENVELOPE MUST BE BEFORE ANY OF IT BECOMES EVIDENCE.
 *
 * An agent's answer is kept whatever it looks like — the attempt stores the
 * raw envelope, valid or not. But nothing in it enters accepted evidence until
 * it passes here, and the rules are the product's, not the model's:
 *
 *   · a claim with no anchor is not a claim;
 *   · an anchor points at a source the packet handed over, and a box lies
 *     inside the region it names — a reader cannot cite a sheet it never saw;
 *   · a count handed back as one total, with no individual marks, is refused —
 *     the locator's job is to locate, the counter's is to count; no model role
 *     returns a counted or calculated quantity at all;
 *   · one mark is one box: two instances on one box are one instance;
 *   · an unknown is null. A zero standing in for "could not read" is refused,
 *     and so is a "known" value that carries no reading;
 *   · an extractor cannot return a decision or an adjudication;
 *   · a critic cannot create a project fact, and its evidence points at the
 *     sheet the claim it assesses points at;
 *   · an arbiter proposes; it cannot overwrite a claim, its evidence is drawn
 *     from what the packet showed it, and a correction obeys every rule a
 *     claim obeys;
 *   · the composer may not introduce a technical claim of its own;
 *   · a deterministic executor must name the inputs every result came from,
 *     and each input is a claim the packet presented.
 *
 * Validation is all or nothing. A partly valid envelope persists nothing;
 * there is no such thing as the good half of an answer.
 */
import type { AgentResultEnvelope, ClaimValue, PacketClaim, ProposedAnchor, ProposedClaim, WorkPacket } from "./contracts.ts";
import { PACKET_VERSION } from "./contracts.ts";
import { roleDefinition } from "./role-registry.ts";

export type Validation = { ok: boolean; problems: string[] };

const QUANTITY_PREDICATES = /(_quantity|_count)$/;
/* Only code counts and only code calculates. */
const CODE_ONLY_PREDICATES = new Set(["drawn_quantity", "calculated_quantity"]);
const CODE_ONLY_BASES = new Set(["counted_marks", "calculated"]);

export function validateEnvelope(packet: WorkPacket, envelope: AgentResultEnvelope): Validation {
  const role = roleDefinition(packet.roleKey);
  const problems: string[] = [];

  if (envelope.packetVersion !== PACKET_VERSION) problems.push(`envelope version ${envelope.packetVersion} is not ${PACKET_VERSION}`);
  if (envelope.taskId !== packet.taskId) problems.push("envelope answers a different task");
  if (envelope.roleKey !== packet.roleKey) problems.push(`envelope is from ${envelope.roleKey}, packet was for ${packet.roleKey}`);

  /* ── shape first: a malformed envelope is refused, never dereferenced ── */
  for (const field of ["claims", "anchors", "assessments", "disagreements", "requestedActions", "decisions", "calculations"] as const) {
    if (!Array.isArray(envelope[field])) problems.push(`envelope lacks a ${field} array`);
  }
  if (envelope.adjudication !== null && envelope.adjudication !== undefined) {
    const adj = envelope.adjudication;
    if (typeof adj !== "object" || !Array.isArray(adj.evidenceAnchorIds)) problems.push("adjudication is not the shape of an adjudication");
  }
  if (problems.length) return { ok: false, problems };
  if (envelope.outcome === "outcome_unknown" || envelope.outcome === "failed_known") return { ok: true, problems };
  for (const c of envelope.claims) {
    if (!c || typeof c !== "object" || typeof c.claimKey !== "string") problems.push("a claim is not the shape of a claim");
    else if (c.anchorKeys !== undefined && !Array.isArray(c.anchorKeys)) problems.push(`claim ${c.claimKey} anchorKeys is not a list`);
  }
  for (const a of envelope.anchors) if (!a || typeof a !== "object" || typeof a.anchorKey !== "string") problems.push("an anchor is not the shape of an anchor");
  for (const a of envelope.assessments) if (!a || typeof a !== "object" || !Array.isArray(a.anchorKeys)) problems.push("an assessment is not the shape of an assessment");
  for (const c of envelope.calculations) if (!c || typeof c !== "object" || !Array.isArray(c.inputClaimIds)) problems.push("a calculation is not the shape of a calculation");
  for (const d of envelope.decisions) if (!d || typeof d !== "object" || !Array.isArray(d.supportingClaimIds) || !Array.isArray(d.contradictingClaimIds)) problems.push("a decision is not the shape of a decision");
  if (problems.length) return { ok: false, problems };

  /* ── what this role may produce at all ── */
  if (!role.producesAssessments && envelope.assessments.length) problems.push(`${role.roleKey} may not return assessments`);
  if (!role.producesAdjudication && envelope.adjudication) problems.push(`${role.roleKey} may not return an adjudication — extractors do not decide`);
  if (!role.producesDecisions && envelope.decisions.length) problems.push(`${role.roleKey} may not return decisions — extractors do not decide`);
  if (!role.producesCalculations && envelope.calculations.length) problems.push(`${role.roleKey} may not return calculations`);
  if (role.maximumClaims === 0 && envelope.claims.length) {
    problems.push(`${role.roleKey} may not create claims — ${role.producesAssessments ? "a critic assesses, it does not assert" : "it creates no technical fact"}`);
  }
  if (envelope.claims.length > role.maximumClaims) problems.push(`${envelope.claims.length} claims exceeds the role's ${role.maximumClaims}`);
  /* A request the packet did not permit is refused by the follow-up planner,
     with an audit line; it does not cost the reading its valid claims. */

  /* ── what a code role must say about its inputs ── */
  const presented = new Set(packet.context.claims.map((c) => c.ref));
  if (role.executorKind === "deterministic" && role.roleKey !== "deterministic_ingestor") {
    for (const c of envelope.claims) {
      if (!c.inputClaimIds || c.inputClaimIds.length === 0) problems.push(`deterministic claim ${c.claimKey} names no inputs — code does not invent`);
      for (const id of c.inputClaimIds ?? []) if (!presented.has(id)) problems.push(`deterministic claim ${c.claimKey} was computed from ${id}, which the packet did not present`);
    }
    for (const calc of envelope.calculations) {
      if (calc.inputClaimIds.length === 0) problems.push(`calculation ${calc.calculationKey} names no inputs`);
      for (const id of calc.inputClaimIds) if (!presented.has(id)) problems.push(`calculation ${calc.calculationKey} was computed from ${id}, which the packet did not present`);
    }
  }

  /* ── every claim, one at a time ── */
  const anchorKeys = new Set(envelope.anchors.map((a) => a.anchorKey));
  const seenKeys = new Set<string>();
  for (const claim of envelope.claims) {
    const keys = claim.anchorKeys ?? [];
    if (seenKeys.has(claim.claimKey)) problems.push(`duplicate claim key ${claim.claimKey}`);
    seenKeys.add(claim.claimKey);
    if (keys.length === 0) problems.push(`claim ${claim.claimKey} has no anchor`);
    if (new Set(keys).size !== keys.length) problems.push(`claim ${claim.claimKey} names the same anchor more than once`);
    for (const k of keys) if (!anchorKeys.has(k)) problems.push(`claim ${claim.claimKey} points at anchor ${k}, which the envelope does not carry`);
    if (!claim.observationBasis) problems.push(`claim ${claim.claimKey} declares no basis`);
    problems.push(...valueProblems(claim.claimKey, claim.predicate, claim.value));
    if (packet.taskType === "locate_symbol_family") problems.push(...locatorProblems(claim, envelope));
    else if (role.executorKind === "agent") {
      if (CODE_ONLY_PREDICATES.has(claim.predicate)) problems.push(`claim ${claim.claimKey} is a ${claim.predicate} — only code counts or calculates; a reader reads`);
      if (CODE_ONLY_BASES.has(claim.observationBasis)) problems.push(`claim ${claim.claimKey} rests on ${claim.observationBasis} — a basis only code may declare`);
    }
  }

  /* ── anchors must point at what the packet handed over, and carry no URL ── */
  const reach = anchorReach(packet);
  for (const anchor of envelope.anchors) {
    const target = anchor.regionId ?? anchor.pageId ?? anchor.documentId;
    if (anchor.sourceKind === "human_record") {
      if (role.executorKind === "agent") problems.push(`anchor ${anchor.anchorKey} is a human record — a model role cites the drawing, never a person`);
      continue;
    }
    if (!target) { problems.push(`anchor ${anchor.anchorKey} points nowhere`); continue; }
    if (anchor.sourceKind === "page_bbox" && (!anchor.bbox || !anchor.pageId)) problems.push(`anchor ${anchor.anchorKey} is a page box without a page or a box`);
    if (anchor.bbox && !normalised(anchor.bbox)) problems.push(`anchor ${anchor.anchorKey} box is not normalised 0..1`);
    if (JSON.stringify(anchor.locator ?? {}).match(/https?:\/\//)) problems.push(`anchor ${anchor.anchorKey} locator carries a URL`);
    if (!reach.targets.has(target) || (anchor.pageId && !reach.targets.has(anchor.pageId)) || (anchor.regionId && !reach.targets.has(anchor.regionId))) {
      problems.push(`anchor ${anchor.anchorKey} points at ${target}, which the packet did not hand over`);
    } else if (anchor.regionId && anchor.bbox && normalised(anchor.bbox)) {
      const region = reach.regionBoxes.get(anchor.regionId);
      if (region && !inside(anchor.bbox, region)) problems.push(`anchor ${anchor.anchorKey} box lies outside the region it names`);
    }
  }

  /* ── role-specific shapes ── */
  const claimByRef = new Map(packet.context.claims.map((c) => [c.ref, c] as const));
  const anchorsById = new Set<string>();
  for (const c of packet.context.claims) for (const a of c.anchors) anchorsById.add(a.anchorId);
  for (const a of packet.context.assessments) for (const id of a.anchorIds) anchorsById.add(id);

  if (role.producesAssessments) {
    const assessed = new Set<string>();
    for (const a of envelope.assessments) {
      const claim = claimByRef.get(a.claimRef);
      if (!claim) { problems.push(`assessment names ${a.claimRef}, which the packet did not present`); continue; }
      if (assessed.has(a.claimRef)) problems.push(`claim ${a.claimRef} is assessed twice in one answer — one critic, one verdict`);
      assessed.add(a.claimRef);
      if (a.anchorKeys.length === 0 && a.assessment !== "unreadable") problems.push(`assessment of ${a.claimRef} names no evidence — that is an opinion`);
      const pages = new Set(claim.anchors.flatMap((x) => [x.pageId, x.regionId].filter(Boolean) as string[]));
      for (const k of a.anchorKeys) {
        const ev = envelope.anchors.find((x) => x.anchorKey === k);
        if (!ev) { problems.push(`assessment of ${a.claimRef} cites anchor ${k}, which the envelope does not carry`); continue; }
        const at = ev.regionId ?? ev.pageId;
        if (pages.size && at && !pages.has(at) && !(ev.pageId && pages.has(ev.pageId))) {
          problems.push(`assessment of ${a.claimRef} is anchored at ${at}, not where the claim it assesses points`);
        }
      }
    }
  }
  if (envelope.adjudication) {
    const adj = envelope.adjudication;
    for (const id of adj.evidenceAnchorIds) if (!anchorsById.has(id)) problems.push(`adjudication rests on anchor ${id}, which the packet did not present`);
    if (adj.outcome === "accept_claim" && !adj.acceptedClaimRef) problems.push("adjudication accepts a claim without naming it");
    if (adj.outcome === "accept_claim" && adj.acceptedClaimRef && !claimByRef.has(adj.acceptedClaimRef)) {
      problems.push(`adjudication accepts ${adj.acceptedClaimRef}, which the packet did not present`);
    }
    if (adj.outcome === "correct") {
      if (!adj.correctedValue || !adj.correctedValue.known) problems.push("a correction needs a known corrected value");
      else {
        /* The corrected value obeys every rule the disputed claims obey. */
        const disputed = (packet.context.disagreements[0]?.claimRefs ?? []).map((r) => claimByRef.get(r)).filter(Boolean) as PacketClaim[];
        const predicate = disputed[0]?.predicate ?? packet.context.claims[0]?.predicate ?? "";
        problems.push(...valueProblems("the correction", predicate, adj.correctedValue));
        if (QUANTITY_PREDICATES.test(predicate) && !adj.correctedUnit && !disputed.some((c) => c.unit)) problems.push("a corrected quantity needs a unit");
      }
      if (adj.evidenceAnchorIds.length === 0) problems.push("a correction needs source anchors — what the drawing shows instead");
    }
    if (adj.outcome === "needs_more_evidence" && !adj.followUp) problems.push("needs_more_evidence names no follow-up — it would loop for ever");
    if (adj.outcome === "reject_all" && adj.evidenceAnchorIds.length === 0) problems.push("rejecting every reading needs source evidence of what the drawing shows");
    if (!adj.rationale) problems.push("adjudication gives no rationale");
    if (/majority|most readers|two of three|2 of 3|agree(d|ment) (is|as) proof/i.test(adj.rationale)) {
      problems.push("adjudication rests on a majority — that is not evidence");
    }
    /* The rule that does not depend on wording: an accepted reading is one no
       assessment contradicts, and the evidence cited for it is the reading's
       own anchor or an assessment that supports it — never only the anchors
       of the readings it beat. */
    if (adj.outcome === "accept_claim" && adj.acceptedClaimRef && claimByRef.has(adj.acceptedClaimRef)) {
      const ref = adj.acceptedClaimRef;
      const own = new Set(claimByRef.get(ref)!.anchors.map((a) => a.anchorId));
      const assessmentsOf = packet.context.assessments.filter((a) => a.claimRef === ref);
      if (assessmentsOf.some((a) => a.assessment === "contradicts")) problems.push(`adjudication accepts ${ref}, which an assessment contradicts — a person decides that`);
      const supporting = new Set(assessmentsOf.filter((a) => a.assessment === "supports").flatMap((a) => a.anchorIds));
      if (!adj.evidenceAnchorIds.some((id) => own.has(id) || supporting.has(id))) {
        problems.push(`adjudication accepts ${ref} on evidence that is not ${ref}'s own anchor nor an assessment supporting it`);
      }
    }
  }
  if (role.producesDecisions) {
    for (const d of envelope.decisions) {
      for (const id of [...d.supportingClaimIds, ...d.contradictingClaimIds]) {
        if (!presented.has(id)) problems.push(`decision "${d.title}" cites claim ${id}, which the packet did not present — the composer creates no technical fact`);
      }
      if (d.decisionType !== "request_information" && d.decisionType !== "hold" && d.supportingClaimIds.length === 0) {
        problems.push(`decision "${d.title}" rests on no accepted claim`);
      }
      for (const key of ["known", "conflicts", "canProceed", "mustWait", "supportingEvidence"] as const) {
        if (!d.summary?.[key]) problems.push(`decision "${d.title}" does not say ${key}`);
      }
    }
  }

  return { ok: problems.length === 0, problems };
}

/* What an envelope may point at: every source in the packet, by document,
   page and region. A blind reader cites nothing else — it was handed sheets,
   and it read them. A role that works from the record (code, the critics, the
   relationship builder) may also point where the claims it was handed point,
   since it copies an anchor and never invents one. */
function anchorReach(packet: WorkPacket) {
  const targets = new Set<string>();
  const regionBoxes = new Map<string, [number, number, number, number]>();
  for (const s of packet.sources) {
    targets.add(s.sourceId); targets.add(s.documentId);
    if (s.pageId) targets.add(s.pageId);
    if (s.regionId) { targets.add(s.regionId); if (s.bbox) regionBoxes.set(s.regionId, s.bbox); }
  }
  if (!packet.blindContext) {
    for (const c of packet.context.claims) for (const a of c.anchors) {
      for (const id of [a.documentId, a.pageId, a.regionId]) if (id) targets.add(id);
    }
  }
  return { targets, regionBoxes };
}

function valueProblems(label: string, predicate: string, v: ClaimValue | null | undefined): string[] {
  const p: string[] = [];
  if (!v || typeof v !== "object") return [`claim ${label} has no value`];
  const text = typeof v.text === "string" ? v.text.trim() : "";
  const quantity = typeof v.quantity === "number" ? v.quantity : null;
  if (v.known === false) {
    if (v.quantity !== null && v.quantity !== undefined) p.push(`claim ${label} is unknown yet carries a quantity — unknown is null, never a number`);
    if (text) p.push(`claim ${label} is unknown yet carries a reading "${text}" — unknown is null, never a text`);
  } else {
    if (quantity === null && !text) {
      p.push(QUANTITY_PREDICATES.test(predicate)
        ? `claim ${label} says it knows ${predicate} but carries neither a quantity nor its text`
        : `claim ${label} says it is known but carries no reading — a known value has a quantity or a text`);
    }
    if (quantity === 0 && !text) {
      p.push(`claim ${label} reports zero with no source text — a zero is a measurement, and a measurement has a reading`);
    }
  }
  return p;
}

/* A locator returns marks, not a number. One claim per instance, each with its
   own box — its own, not one shared with another mark; a claim whose predicate
   is a quantity from a locator is a total. */
function locatorProblems(claim: ProposedClaim, envelope: AgentResultEnvelope): string[] {
  const p: string[] = [];
  if (QUANTITY_PREDICATES.test(claim.predicate) || claim.observationBasis === "counted_marks") {
    p.push(`claim ${claim.claimKey} is a total — a locator returns one claim per visible mark, and the counter counts`);
    return p;
  }
  if (claim.subjectType !== "component_instance") p.push(`claim ${claim.claimKey} from a locator is not a component instance`);
  const keys = claim.anchorKeys ?? [];
  const anchors = envelope.anchors.filter((a) => keys.includes(a.anchorKey));
  const box = anchors.find((a) => a.sourceKind === "page_bbox" && a.bbox);
  if (!box) { p.push(`instance ${claim.claimKey} has no bounding box of its own`); return p; }
  const sharers = envelope.claims.filter((other) => other !== claim && (other.anchorKeys ?? []).includes(box.anchorKey));
  if (sharers.length) p.push(`instance ${claim.claimKey} shares its box with ${sharers.map((s) => s.claimKey).join(", ")} — one mark is one box`);
  const same = envelope.claims.filter((other) => other !== claim && (other.anchorKeys ?? []).some((k) => {
    const a = envelope.anchors.find((x) => x.anchorKey === k);
    return a && a.sourceKind === "page_bbox" && a.pageId === box.pageId && sameBox(a, box);
  }));
  if (same.length) p.push(`instance ${claim.claimKey} sits on the same box as ${same.map((s) => s.claimKey).join(", ")} — one mark reported twice is one mark`);
  return p;
}

function sameBox(a: ProposedAnchor, b: ProposedAnchor): boolean {
  return !!a.bbox && !!b.bbox && a.bbox.every((n, i) => n === b.bbox![i]);
}

function normalised(bbox: [number, number, number, number]): boolean {
  return Array.isArray(bbox) && bbox.length === 4 && bbox.every((n) => typeof n === "number" && n >= 0 && n <= 1) && bbox[0] <= bbox[2] && bbox[1] <= bbox[3];
}

function inside(box: [number, number, number, number], region: [number, number, number, number]): boolean {
  const eps = 1e-9;
  return box[0] >= region[0] - eps && box[1] >= region[1] - eps && box[2] <= region[2] + eps && box[3] <= region[3] + eps;
}
