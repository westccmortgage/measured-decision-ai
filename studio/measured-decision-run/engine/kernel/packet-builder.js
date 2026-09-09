import "../../engine-shims/buffer.js";
import { PACKET_VERSION } from "./contracts.js";
import { fingerprint } from "./ids.js";
import { hashOfRef } from "./planning.js";
import { KERNEL_OBJECTIVES } from "./roles.js";
import { anonymize, assertPacketRespectsVisibility, scrubLocator, scrubScope, visibilityFor } from "./visibility.js";
export class PacketOverBudget extends Error {
}
export function sourceReference(ref, lookup) {
    if (ref.segmentId) {
        const segment = lookup.segments.get(ref.segmentId);
        if (!segment)
            throw new Error(`core-v2: segment ${ref.segmentId} is not in the record`);
        const source = lookup.sources.get(segment.sourceId);
        if (!source)
            throw new Error(`core-v2: source ${segment.sourceId} is not in the manifest`);
        return {
            sourceId: source.sourceId, segmentId: segment.segmentId, kind: "segment", sourceKind: source.sourceKind, segmentKind: segment.segmentKind,
            parentSegmentId: segment.parentSegmentId, label: segment.label, ordinal: segment.ordinal, locator: scrubLocator(segment.locator), contentHash: segment.contentHash,
        };
    }
    const source = ref.sourceId ? lookup.sources.get(ref.sourceId) : null;
    if (!source)
        throw new Error(`core-v2: source ${ref.sourceId} is not in the manifest`);
    return {
        sourceId: source.sourceId, segmentId: null, kind: "source", sourceKind: source.sourceKind, segmentKind: null, parentSegmentId: null,
        label: source.label, ordinal: source.ordinal, locator: {}, contentHash: hashOfRef(ref, lookup),
    };
}
export async function buildPacket(task, ctx) {
    const { repo, lookup, policy, pack } = ctx;
    const role = ctx.registry.role(task.roleKey);
    const rules = visibilityFor(role);
    const sources = task.sources.map((ref) => sourceReference(ref, lookup));
    const deps = await repo.getDependencies(task.taskId);
    const dependencies = [];
    const refToClaimId = {};
    let claims = [];
    let assessments = [];
    let disagreements = [];
    const validation = [];
    /* A claim as another role sees it: scope and locators cut to the keys the
       kernel defines, so whatever a reader wrote there travels to nobody. */
    const toPacketClaim = async (c, withGroup) => {
        const anchors = await repo.listAnchors([c.claimId]);
        return {
            ref: c.claimId, subjectType: c.subjectType, subjectKey: c.subjectKey, predicate: c.predicate,
            value: c.value, unit: c.unit, observationBasis: c.observationBasis, scope: scrubScope(c.scope), status: c.status,
            independenceGroup: withGroup ? c.independenceGroup : null, inputRefs: [...c.inputClaimIds],
            anchors: anchors.map((a) => ({ anchorId: a.anchorId, sourceKind: a.sourceKind, sourceId: a.sourceId, segmentId: a.segmentId, locator: scrubLocator(a.locator), quotedText: a.quotedText })),
        };
    };
    for (const d of deps) {
        const claimIds = rules.claims === "none" || rules.claims === "anonymized_competing" ? [] :
            (await repo.listClaims({ workflowId: task.workflowId, taskIds: [d.dependsOnTaskId] })).map((c) => c.claimId);
        const independenceGroup = role.kind === "comparator" ? ((await repo.getTask(d.dependsOnTaskId))?.independenceGroup ?? null) : null;
        dependencies.push({ taskId: d.dependsOnTaskId, kind: d.kind, claimIds, independenceGroup });
    }
    if (rules.claims === "own_dependencies") {
        for (const d of dependencies)
            for (const id of d.claimIds) {
                const c = await repo.getClaim(id);
                if (c) {
                    claims.push(await toPacketClaim(c, false));
                    refToClaimId[id] = id;
                }
            }
    }
    else if (rules.claims === "all_relevant") {
        for (const c of await relevantClaimsFor(task, role, repo, pack)) {
            claims.push(await toPacketClaim(c, role.kind === "comparator"));
            refToClaimId[c.claimId] = c.claimId;
        }
        if (role.kind === "composer") {
            const ids = new Set(claims.map((c) => c.ref));
            disagreements = (await repo.listDisagreements(task.workflowId))
                .filter((d) => d.claimIds.some((id) => ids.has(id)) || pack.normaliseKey(String(d.subjectSignature.subject_key ?? "")) === pack.normaliseKey(task.subjectKey))
                .map((d) => ({ disagreementId: d.disagreementId, kind: d.kind, severity: d.severity, subjectSignature: d.subjectSignature, claimRefs: d.claimIds.filter((id) => ids.has(id)).sort() }));
        }
    }
    else if (rules.claims === "anonymized_competing") {
        const dis = task.disagreementId ? await repo.getDisagreement(task.disagreementId) : null;
        const competing = dis ? dis.claimIds : task.targetClaimIds;
        const raw = [];
        for (const id of competing) {
            const c = await repo.getClaim(id);
            if (c)
                raw.push(await toPacketClaim(c, false));
        }
        const anon = anonymize(raw);
        claims = anon.claims;
        for (const [letter, id] of Object.entries(anon.map))
            refToClaimId[letter] = id;
        const idToLetter = Object.fromEntries(Object.entries(anon.map).map(([l, id]) => [id, l]));
        if (rules.assessments) {
            assessments = (await repo.listAssessments(competing)).map((a) => ({
                claimRef: idToLetter[a.claimId], assessment: a.assessment, reasonCode: a.reasonCode,
                explanation: a.explanation, anchorIds: a.anchorIds, proposedValue: a.proposedValue, proposedUnit: a.proposedUnit,
            })).sort((x, y) => x.claimRef.localeCompare(y.claimRef) || x.reasonCode.localeCompare(y.reasonCode));
        }
        if (rules.disagreements && dis) {
            disagreements = [{
                    disagreementId: dis.disagreementId, kind: dis.kind, severity: dis.severity, subjectSignature: dis.subjectSignature,
                    claimRefs: dis.claimIds.map((id) => idToLetter[id]).filter(Boolean).sort(),
                }];
        }
        if (rules.validation)
            validation.push(...deterministicValidationNotes(claims));
        /* The disputed sources, so the verifier or arbiter can reopen them. */
        const seen = new Set(sources.map((s) => s.segmentId ?? s.sourceId));
        for (const c of claims)
            for (const a of c.anchors) {
                const ref = a.segmentId ? { sourceId: null, segmentId: a.segmentId } : a.sourceId ? { sourceId: a.sourceId, segmentId: null } : null;
                const key = a.segmentId ?? a.sourceId;
                if (ref && key && !seen.has(key) && sources.length < role.maximumSources) {
                    sources.push(sourceReference(ref, lookup));
                    seen.add(key);
                }
            }
    }
    if (claims.length > policy.maximumPacketClaims)
        throw new PacketOverBudget(`core-v2: packet for ${task.taskId} would carry ${claims.length} claims; the policy allows ${policy.maximumPacketClaims}`);
    if (sources.length > policy.maximumPacketSources)
        throw new PacketOverBudget(`core-v2: packet for ${task.taskId} would carry ${sources.length} sources; the policy allows ${policy.maximumPacketSources}`);
    const inputFingerprint = fingerprint({
        task: task.inputFingerprint,
        role: `${role.roleKey}@${role.version}`,
        sources: sources.map((s) => s.contentHash),
        dependencyClaims: dependencies.flatMap((d) => d.claimIds).sort(),
        competing: rules.claims === "anonymized_competing" ? Object.values(refToClaimId).sort() : [],
        independenceGroup: task.independenceGroup,
    });
    /* A dependency names only claims the packet actually presents. Naming an id
       it does not show tells a role that a claim about something else exists,
       which is exactly what subject scope is for — and a composer's dependency
       list would otherwise enumerate every other subject's claims by id. */
    const shown = new Set(claims.map((c) => refToClaimId[c.ref] ?? c.ref));
    for (const d of dependencies)
        d.claimIds = d.claimIds.filter((id) => shown.has(id));
    const packet = {
        packetVersion: PACKET_VERSION,
        workflowId: task.workflowId,
        taskId: task.taskId,
        parentTaskId: task.parentTaskId,
        phase: task.phase,
        roleKey: role.roleKey,
        roleVersion: role.version,
        taskType: task.taskType,
        subjectKey: task.subjectKey,
        objective: pack.objectives[task.taskType] ?? KERNEL_OBJECTIVES[task.taskType] ?? role.description,
        sources,
        dependencies,
        independenceGroup: task.independenceGroup,
        blindContext: rules.blind,
        allowedActions: task.depth >= policy.maximumFollowUpDepth
            ? role.allowedActions.filter((a) => a === "request_human_review")
            : [...role.allowedActions],
        limits: {
            maximumSources: role.maximumSources,
            maximumClaims: task.maxClaims,
            maximumFollowUps: policy.maximumChildTasksPerParent,
            maximumDepth: Math.min(role.maximumFollowUpDepth, policy.maximumFollowUpDepth),
            maximumOutputBytes: policy.maximumEnvelopeBytes,
        },
        expectedOutputContract: role.outputContract,
        inputFingerprint,
        context: { claims, assessments, disagreements, depth: task.depth, validation },
    };
    const bytes = Buffer.byteLength(JSON.stringify(packet), "utf8");
    if (bytes > policy.maximumPacketBytes)
        throw new PacketOverBudget(`core-v2: packet for ${task.taskId} is ${bytes} bytes; the policy allows ${policy.maximumPacketBytes}`);
    const problems = assertPacketRespectsVisibility(packet, role);
    if (problems.length)
        throw new Error(`core-v2: packet for ${task.taskId} breaks visibility: ${problems.join("; ")}`);
    return { packet, refToClaimId };
}
/* What a code role or the composer works from. The comparator: the claims of
   the blind readers of its subject. A deriver: the accepted claims of what it
   depends on and of its subject. A composer: the accepted claims of its own
   subject and what those were computed from — nothing of another subject. */
export async function relevantClaimsFor(task, role, repo, pack) {
    const deps = await repo.getDependencies(task.taskId);
    const depTaskIds = deps.map((d) => d.dependsOnTaskId);
    const subject = pack.normaliseKey(task.subjectKey.split("#")[0]);
    const ofSubject = (c) => pack.normaliseKey(c.subjectKey) === subject || pack.normaliseKey(c.subjectKey).startsWith(`${subject}/`) || c.subjectKey.startsWith(`${task.subjectKey.split("#")[0]}/`);
    switch (role.kind) {
        case "comparator": {
            const readers = (await Promise.all(depTaskIds.map((id) => repo.getTask(id))))
                .filter((t) => t && t.independenceGroup !== null).map((t) => t.taskId);
            return repo.listClaims({ workflowId: task.workflowId, taskIds: readers });
        }
        case "deriver": {
            const fromDeps = await repo.listClaims({ workflowId: task.workflowId, taskIds: depTaskIds, statuses: ["accepted"] });
            const ofSubj = (await repo.listClaims({ workflowId: task.workflowId, statuses: ["accepted"] })).filter(ofSubject);
            return dedupe([...fromDeps, ...ofSubj]);
        }
        case "composer": {
            const accepted = (await repo.listClaims({ workflowId: task.workflowId, statuses: ["accepted"] }));
            const own = accepted.filter(ofSubject);
            const inputIds = new Set(own.flatMap((c) => c.inputClaimIds));
            const inputs = accepted.filter((c) => inputIds.has(c.claimId));
            return dedupe([...own, ...inputs]);
        }
        default:
            return repo.listClaims({ workflowId: task.workflowId, taskIds: depTaskIds });
    }
}
function dedupe(claims) {
    const seen = new Set();
    return claims.filter((c) => (seen.has(c.claimId) ? false : (seen.add(c.claimId), true))).sort((a, b) => a.claimId.localeCompare(b.claimId));
}
/* Things code can say about competing claims that an arbiter may weigh.
   Never a provider, never a count of who agreed. */
function deterministicValidationNotes(claims) {
    const notes = [];
    for (const c of claims) {
        if (c.anchors.length === 0)
            notes.push(`claim ${c.ref}: no anchor`);
        if (c.value.known && c.value.quantity !== null && c.value.quantity < 0)
            notes.push(`claim ${c.ref}: negative quantity`);
        if (!c.value.known)
            notes.push(`claim ${c.ref}: the reader could not read a value`);
    }
    return notes;
}
export function lookupSource(ctx, sourceId) { return ctx.lookup.sources.get(sourceId) ?? null; }
export function lookupSegment(ctx, segmentId) { return ctx.lookup.segments.get(segmentId) ?? null; }
