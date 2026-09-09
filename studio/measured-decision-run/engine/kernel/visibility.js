export function visibilityFor(role) {
    switch (role.kind) {
        case "comparator":
            return { claims: "all_relevant", assessments: false, disagreements: false, validation: false, blind: false };
        case "critic":
        case "verifier":
            return { claims: "anonymized_competing", assessments: false, disagreements: role.kind === "verifier", validation: false, blind: false };
        case "arbiter":
            return { claims: "anonymized_competing", assessments: true, disagreements: true, validation: true, blind: false };
        case "deriver":
        case "composer":
            return { claims: "all_relevant", assessments: true, disagreements: true, validation: true, blind: false };
        default:
            return { claims: "own_dependencies", assessments: false, disagreements: false, validation: false, blind: true };
    }
}
/* Provider identifiers, as whole words, anywhere in the packet. Not "model"
   or "provider": a source may carry a MODEL column and a reader may read it. */
const PROVIDER_WORDS = ["openai", "anthropic", "gemini", "claude", "gpt-?\\d", "chatgpt", "vertex", "bedrock", "mistral", "deepseek"];
/* The engine's own labels for who did the work. */
export const AUTHORSHIP_WORDS = ["reader-a", "reader-b", "reader-c", "-family-", "executor family", "independence group", "independence domain", "domain:"];
export function forbiddenContent(packet) {
    const problems = [];
    const text = JSON.stringify(packet).toLowerCase();
    for (const word of PROVIDER_WORDS) {
        if (new RegExp(`(^|[^a-z])${word}([^a-z]|$)`).test(text))
            problems.push(`packet names a provider: ${word.replace("-?\\d", "")}`);
    }
    if (/https?:\/\//.test(text))
        problems.push("packet carries a URL");
    if (/x-amz-signature|[?&]signature=|[?&]token=|api[_-]?key|access[_-]?token|"secret[_a-z]*"\s*:|bearer [a-z0-9]/.test(text))
        problems.push("packet carries a credential or signed link");
    if (/"(cost_usd|price_usd|usd|majority|votes|winner)"\s*:/.test(text))
        problems.push("packet carries cost or a majority as proof");
    return problems;
}
/* An anonymised packet carries no authorship at all: no reader group, no
   family, no domain, no claim or attempt id — not in a ref, not in a scope,
   not in a quoted text. Task ids may appear: they name work, not who did it. */
export function authorshipContent(packet) {
    const problems = [];
    const text = JSON.stringify({ ...packet, taskId: "", parentTaskId: "", dependencies: packet.dependencies.map((d) => ({ ...d, taskId: "" })) }).toLowerCase();
    for (const word of AUTHORSHIP_WORDS)
        if (text.includes(word))
            problems.push(`anonymised packet carries authorship: ${word}`);
    /* Anchor ids and the ids of places — sources, segments, their parents —
       are the packet's own currency; any other uuid is suspect. A place names
       where, never who. */
    const ids = new Set();
    for (const c of packet.context.claims)
        for (const a of c.anchors) {
            ids.add(a.anchorId);
            if (a.sourceId)
                ids.add(a.sourceId);
            if (a.segmentId)
                ids.add(a.segmentId);
        }
    for (const a of packet.context.assessments)
        for (const id of a.anchorIds)
            ids.add(id);
    for (const s of packet.sources) {
        ids.add(s.sourceId);
        if (s.segmentId)
            ids.add(s.segmentId);
        if (s.parentSegmentId)
            ids.add(s.parentSegmentId);
    }
    for (const d of packet.context.disagreements)
        ids.add(d.disagreementId);
    ids.add(packet.workflowId.toLowerCase());
    for (const m of text.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g)) {
        if (!ids.has(m[0]))
            problems.push(`anonymised packet carries an id that is not an anchor, a place or a disagreement: ${m[0]}`);
    }
    return problems;
}
export function assertPacketRespectsVisibility(packet, role) {
    const rules = visibilityFor(role);
    const problems = [...forbiddenContent(packet)];
    const claims = packet.context.claims;
    if (rules.blind && !packet.blindContext)
        problems.push(`${role.roleKey} packets must be blind`);
    if (role.kind !== "comparator" && packet.dependencies.some((d) => d.independenceGroup !== null)) {
        problems.push(`${role.roleKey} packet says which blind group a dependency read under`);
    }
    if (rules.claims === "none" && claims.length)
        problems.push(`${role.roleKey} may see no claims`);
    if (rules.claims === "own_dependencies") {
        const allowed = new Set(packet.dependencies.flatMap((d) => d.claimIds));
        for (const c of claims) {
            if (!allowed.has(c.ref))
                problems.push(`${role.roleKey} packet carries a claim that is not one of its dependencies: ${c.ref}`);
            if (c.independenceGroup !== null)
                problems.push(`${role.roleKey} packet says which reader made ${c.ref}`);
        }
    }
    if (rules.claims === "anonymized_competing") {
        for (const c of claims) {
            if (!/^[A-Z]{1,3}$/.test(c.ref))
                problems.push(`${role.roleKey} packet shows a claim under its id rather than a letter: ${c.ref}`);
            if (c.independenceGroup !== null)
                problems.push(`${role.roleKey} packet says which reader made ${c.ref}`);
        }
        for (const d of packet.dependencies)
            if (d.claimIds.length)
                problems.push(`${role.roleKey} packet lists dependency claim ids`);
        problems.push(...authorshipContent(packet));
    }
    if (rules.claims === "all_relevant" && role.kind !== "comparator") {
        for (const c of claims)
            if (c.independenceGroup !== null)
                problems.push(`${role.roleKey} packet says which reader made ${c.ref}`);
    }
    if (!rules.assessments && packet.context.assessments.length)
        problems.push(`${role.roleKey} may not see assessments`);
    if (!rules.disagreements && packet.context.disagreements.length)
        problems.push(`${role.roleKey} may not see disagreements`);
    if (!rules.validation && packet.context.validation.length)
        problems.push(`${role.roleKey} may not see validation notes`);
    if (packet.sources.length > packet.limits.maximumSources)
        problems.push(`packet carries ${packet.sources.length} sources, limit ${packet.limits.maximumSources}`);
    for (const action of packet.allowedActions) {
        if (!role.allowedActions.includes(action))
            problems.push(`packet permits ${action}, which the role does not`);
    }
    return problems;
}
/* A, B … Z, AA, AB … — as many as there are claims. */
export function letterFor(index) {
    let n = index;
    let out = "";
    do {
        out = String.fromCharCode(65 + (n % 26)) + out;
        n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    return out;
}
/* Letters, in a stable order that does not reveal reading order or group:
   claims are sorted by the id that names them, which says nothing about who
   made them or when. */
export function anonymize(claims) {
    const sorted = [...claims].sort((a, b) => a.ref.localeCompare(b.ref));
    const map = {};
    const out = sorted.map((c, i) => {
        const letter = letterFor(i);
        map[letter] = c.ref;
        return { ...c, ref: letter, independenceGroup: null, inputRefs: [], scope: scrubScope(c.scope), anchors: c.anchors.map((a) => ({ ...a, locator: scrubLocator(a.locator) })) };
    });
    return { claims: out, map };
}
/* A reader may write anything into a scope or a locator, including who it is.
   The kernel's geometry keys and a short allow-list of scope keys are kept;
   anything else a reader added travels to nobody. The record keeps the
   original; the packet does not carry it. */
const LOCATOR_KEYS = new Set(["bbox", "start_ms", "end_ms", "rows", "offset", "length", "ordinal", "mark", "label"]);
const SCOPE_KEYS = new Set(["segment", "section", "part", "revision", "range", "unit_system"]);
export function scrubLocator(locator) {
    return Object.fromEntries(Object.entries(locator).filter(([k]) => LOCATOR_KEYS.has(k)));
}
export function scrubScope(scope) {
    return Object.fromEntries(Object.entries(scope).filter(([k]) => SCOPE_KEYS.has(k)));
}
