import { canonical, entityId } from "./ids.js";
export const DEFAULT_NORMALISERS = {
    unit: (u) => (u === null || u === undefined ? null : u.toLowerCase().trim()),
    key: (k) => k.toUpperCase().replace(/[\s\-_./]+/g, "").trim(),
};
export function normaliseScope(scope, n) {
    const out = {};
    for (const k of Object.keys(scope ?? {}).sort())
        out[k.toLowerCase()] = n.key(String(scope[k]));
    return out;
}
export function signatureOf(claim, n) {
    return {
        subject_type: claim.subjectType,
        subject_key: n.key(claim.subjectKey),
        predicate: claim.predicate.toLowerCase(),
        scope: JSON.stringify(normaliseScope(claim.scope ?? {}, n)),
    };
}
function attributesOf(v, n) {
    const attrs = v.attributes ?? {};
    const out = {};
    for (const k of Object.keys(attrs).sort()) {
        const a = attrs[k];
        out[k.toLowerCase()] = typeof a === "string" ? n.key(a) : a;
    }
    return canonical(out);
}
function valueEqual(a, b, n) {
    if (a.value.known !== b.value.known)
        return false;
    if (!a.value.known)
        return true;
    if (attributesOf(a.value, n) !== attributesOf(b.value, n))
        return false;
    if (a.value.quantity !== null || b.value.quantity !== null)
        return a.value.quantity === b.value.quantity;
    return n.key(a.value.text ?? "") === n.key(b.value.text ?? "");
}
/* Compare the claims of two or more independence groups for one subject.
   `readerGroups` names every group that read — including one that came back
   with nothing, which the claims alone could never show. */
export function compareClaims(workflowId, subjectKey, claims, readerGroups = [], n = DEFAULT_NORMALISERS) {
    const groups = [...new Set([...readerGroups, ...claims.map((c) => c.independenceGroup ?? "single")])].sort();
    const bySignature = new Map();
    for (const c of claims) {
        const sig = JSON.stringify(signatureOf(c, n));
        bySignature.set(sig, [...(bySignature.get(sig) ?? []), c]);
    }
    const agreements = [];
    const disagreements = [];
    const singletons = [];
    for (const [sigText, members] of bySignature) {
        const signature = JSON.parse(sigText);
        const present = new Set(members.map((m) => m.independenceGroup ?? "single"));
        const key = (kind) => entityId("disagreement-key", workflowId, subjectKey, sigText, kind);
        if (groups.length > 1 && present.size < groups.length) {
            singletons.push(sigText);
            disagreements.push({
                disagreementKey: key("missing"), kind: "missing", severity: "material",
                subjectSignature: signature, claimIds: members.map((m) => m.claimId),
            });
            continue;
        }
        /* One reader saying a thing twice is one reader. Agreement takes two. */
        if (members.length < 2 || present.size < 2)
            continue;
        const first = members[0];
        let kind = null;
        for (const other of members.slice(1)) {
            if (other.observationBasis !== first.observationBasis) {
                kind = "basis";
                break;
            }
            if (n.unit(other.unit) !== n.unit(first.unit)) {
                kind = "unit";
                break;
            }
            if (!valueEqual(first, other, n)) {
                kind = "value";
                break;
            }
        }
        if (kind === null) {
            agreements.push({ signature, claimIds: members.map((m) => m.claimId), groups: [...present].sort() });
            continue;
        }
        const severity = kind === "basis" ? "critical" : "material";
        disagreements.push({
            disagreementKey: key(kind), kind, severity, subjectSignature: signature,
            claimIds: members.map((m) => m.claimId),
        });
    }
    return { agreements, disagreements, singletons };
}
