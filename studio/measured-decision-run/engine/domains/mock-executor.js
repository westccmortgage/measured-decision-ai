import { emptyEnvelope } from "../kernel/deterministic.js";
import { canonical } from "../kernel/ids.js";
export class AbortedExecution extends Error {
}
export function hangUntilAborted(signal) {
    return new Promise((_resolve, reject) => {
        if (signal.aborted) {
            reject(new AbortedExecution("aborted before it began"));
            return;
        }
        signal.addEventListener("abort", () => reject(new AbortedExecution("the kernel gave up on this attempt and said so")), { once: true });
    });
}
export class ScriptedExecutor {
    family;
    responders;
    script;
    /* Every packet this executor was handed, in order — what a test inspects
       to prove blindness and scope. */
    received = [];
    reconciliations = new Map();
    constructor(family, responders, script = null) {
        this.family = family;
        this.responders = responders;
        this.script = script;
    }
    async execute(packet, context) {
        this.received.push(packet);
        const responder = this.responders[packet.roleKey];
        const base = responder ? responder(packet) : (() => { const e = emptyEnvelope(packet, "failed_known"); e.limitations.push(`no scripted behaviour for ${packet.roleKey}`); return e; })();
        if (!this.script)
            return base;
        const out = await this.script(packet, base, context);
        if (out === "hang")
            return hangUntilAborted(context.signal);
        if (out === "throw")
            throw new Error("the scripted executor was told to throw");
        return out;
    }
    async reconcile(attemptId) {
        return this.reconciliations.get(attemptId) ?? "unknown";
    }
}
export function normalisedText(v) {
    return (v ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}
function attributesEqual(a, b) {
    const norm = (v) => canonical(Object.fromEntries(Object.entries(v.attributes ?? {}).map(([k, x]) => [k.toLowerCase(), typeof x === "string" ? normalisedText(x) : x])));
    return norm(a) === norm(b);
}
export function valuesAgree(claim, truth, normaliseUnit) {
    const c = claim.value, t = truth.value;
    if (c.known !== t.known)
        return "different";
    if (!attributesEqual(c, t))
        return "different";
    const quantitySame = c.quantity !== null || t.quantity !== null ? c.quantity === t.quantity : normalisedText(c.text) === normalisedText(t.text);
    if (!quantitySame)
        return "different";
    return normaliseUnit(claim.unit) === normaliseUnit(truth.unit) ? "same" : "unit";
}
/* The critic and the verifier: one verdict per claim, anchored where the
   claim is anchored, from what the source holds. */
export function assessAgainstTruth(packet, oracle, normaliseUnit) {
    const env = emptyEnvelope(packet);
    for (const claim of packet.context.claims) {
        const at = claim.anchors[0];
        const key = `at-${claim.ref}`;
        const truth = oracle.readingFor(packet, claim);
        let assessment;
        if (!at) {
            assessment = { claimRef: claim.ref, assessment: "unreadable", reasonCode: "no_anchor", explanation: "the claim points nowhere; there is nothing to reopen", anchorKeys: [] };
        }
        else if (truth === "unreadable") {
            assessment = { claimRef: claim.ref, assessment: "unreadable", reasonCode: "place_unreadable", explanation: "the place the claim names cannot be read", anchorKeys: [] };
        }
        else {
            const anchor = { anchorKey: key, sourceKind: at.sourceKind, sourceId: at.sourceId, segmentId: at.segmentId, locator: at.locator, quotedText: at.quotedText };
            env.anchors.push(anchor);
            if (truth === null) {
                assessment = { claimRef: claim.ref, assessment: "contradicts", reasonCode: "not_in_source", explanation: "the source holds nothing for this subject at this place", anchorKeys: [key], proposedValue: null, proposedUnit: null };
            }
            else {
                const verdict = valuesAgree({ value: claim.value, unit: claim.unit }, truth, normaliseUnit);
                if (verdict === "same")
                    assessment = { claimRef: claim.ref, assessment: "supports", reasonCode: "matches_source", explanation: "the source shows this value at this place", anchorKeys: [key] };
                else if (verdict === "unit")
                    assessment = { claimRef: claim.ref, assessment: "wrong_unit", reasonCode: "unit_differs", explanation: `the source gives ${truth.unit ?? "no unit"}`, anchorKeys: [key], proposedValue: truth.value, proposedUnit: truth.unit };
                else
                    assessment = { claimRef: claim.ref, assessment: "contradicts", reasonCode: "value_differs", explanation: `the source shows ${truth.value.text ?? truth.value.quantity}`, anchorKeys: [key], proposedValue: truth.value, proposedUnit: truth.unit };
            }
        }
        env.assessments.push(assessment);
    }
    if (packet.context.claims.length === 0)
        env.limitations.push("nothing to assess");
    return env;
}
const NEGATIVE = new Set(["contradicts", "wrong_scope", "wrong_unit", "duplicate", "insufficient", "unreadable"]);
const REJECTING = new Set(["contradicts", "wrong_scope", "wrong_unit", "duplicate"]);
/* The arbiter: one outcome from the assessments and nothing else. It never
   counts readers. */
export function arbitrateFromAssessments(packet) {
    const env = emptyEnvelope(packet);
    const dis = packet.context.disagreements[0];
    const refs = dis?.claimRefs ?? packet.context.claims.map((c) => c.ref);
    const of = (ref) => packet.context.assessments.filter((a) => a.claimRef === ref);
    const anchorsOf = (ref) => packet.context.claims.find((c) => c.ref === ref)?.anchors.map((a) => a.anchorId) ?? [];
    const supported = refs.filter((r) => of(r).some((a) => a.assessment === "supports") && !of(r).some((a) => NEGATIVE.has(a.assessment)));
    const base = { disagreementId: dis?.disagreementId ?? "", acceptedClaimRef: null, correctedValue: null, correctedUnit: null, evidenceAnchorIds: [], followUp: null };
    if (supported.length === 1) {
        const ref = supported[0];
        const supporting = of(ref).filter((a) => a.assessment === "supports").flatMap((a) => a.anchorIds);
        env.adjudication = { ...base, outcome: "accept_claim", acceptedClaimRef: ref, evidenceAnchorIds: [...new Set([...anchorsOf(ref), ...supporting])], rationale: `the reopened source supports reading ${ref} at its own anchor; the other readings were read against` };
        return env;
    }
    if (supported.length > 1) {
        env.adjudication = { ...base, outcome: "needs_human", rationale: "the source was read as supporting more than one competing reading; a person decides" };
        return env;
    }
    const proposals = packet.context.assessments.filter((a) => refs.includes(a.claimRef) && a.proposedValue && a.proposedValue.known);
    const distinct = [...new Set(proposals.map((a) => canonical({ v: a.proposedValue, u: a.proposedUnit ?? null })))];
    if (proposals.length && distinct.length === 1) {
        const p = proposals[0];
        env.adjudication = { ...base, outcome: "correct", correctedValue: p.proposedValue, correctedUnit: p.proposedUnit ?? null, evidenceAnchorIds: [...new Set(proposals.flatMap((a) => a.anchorIds))], rationale: "the reopened source shows a value none of the readers reported; the correction is what the verifier read there" };
        return env;
    }
    const allRejected = refs.length > 0 && refs.every((r) => of(r).some((a) => REJECTING.has(a.assessment)));
    if (allRejected) {
        env.adjudication = { ...base, outcome: "reject_all", evidenceAnchorIds: [...new Set(refs.flatMap((r) => of(r).filter((a) => REJECTING.has(a.assessment)).flatMap((a) => a.anchorIds)))], rationale: "the reopened source was read against every reading and shows no value to correct to" };
        return env;
    }
    env.adjudication = { ...base, outcome: "needs_human", rationale: "the assessments settle nothing; a person decides" };
    return env;
}
/* The composer: what is known, from the accepted claims it was handed and
   nothing else. With nothing accepted it holds — "not yet evidenced" is a
   decision, "unknown, so probably fine" is not. */
export function composeFromAccepted(packet) {
    const env = emptyEnvelope(packet);
    const accepted = packet.context.claims.filter((c) => c.status === "accepted");
    const disputes = packet.context.disagreements;
    if (accepted.length === 0) {
        env.decisions.push({
            decisionType: "hold", title: `${packet.subjectKey}: not yet evidenced`,
            summary: { known: "nothing about this subject is accepted evidence", conflicts: disputes.length ? `${disputes.length} disagreement(s) await a person` : "none recorded", canProceed: "nothing", mustWait: "everything about this subject", supportingEvidence: "none accepted" },
            supportingClaimIds: [], contradictingClaimIds: [], riskLevel: "high", actions: [{ actionType: "review", ownerRole: "reviewer" }],
        });
        return env;
    }
    const lines = accepted.map((c) => `${c.subjectKey} ${c.predicate} = ${c.value.text ?? c.value.quantity}${c.unit ? ` ${c.unit}` : ""}`);
    env.decisions.push({
        decisionType: "proceed", title: `${packet.subjectKey}: evidenced`,
        summary: { known: lines.join("; "), conflicts: disputes.length ? `${disputes.length} disagreement(s) on record` : "none", canProceed: `${packet.subjectKey}`, mustWait: disputes.length ? "what the disagreements cover" : "nothing", supportingEvidence: `${accepted.length} accepted claim(s), each anchored in its source` },
        supportingClaimIds: accepted.map((c) => c.ref), contradictingClaimIds: [], riskLevel: "normal", actions: [{ actionType: "proceed", ownerRole: "reviewer" }],
    });
    return env;
}
export function kernelRoleResponders(oracle, normaliseUnit) {
    return {
        evidence_critic: (p) => assessAgainstTruth(p, oracle, normaliseUnit),
        disagreement_verifier: (p) => assessAgainstTruth(p, oracle, normaliseUnit),
        evidence_arbiter: (p) => arbitrateFromAssessments(p),
        decision_composer: (p) => composeFromAccepted(p),
    };
}
/* A box for row `i` of `n` inside `outer`, for fixtures that lay entries out
   as rows of a region. Always inside its region. */
export function rowBox(outer, i, n) {
    const [x0, y0, x1, y1] = outer;
    const h = (y1 - y0) / Math.max(1, n);
    const top = y0 + i * h;
    const bottom = Math.min(y1, top + h);
    return [round(x0), round(top), round(x1), round(bottom)];
}
function round(n) { return Math.round(n * 1e6) / 1e6; }
