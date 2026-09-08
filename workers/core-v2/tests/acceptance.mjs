/* AGREEMENT IS NOT PROOF.
 *
 * docs/core-v2.md §4: two matching blind readings become corroborated — and
 * nothing more. A claim becomes accepted only through an independent
 * source-verification result supporting that exact claim, a deterministic
 * rule that directly validates the source, or a person. After every
 * comparison a critic in a domain that authored none of the readings reopens
 * the source at the claims' own anchors; a supports assessment accepts by
 * rule, a negative one opens a dispute between the readings and the source
 * (found_by: verification) which is verified again and adjudicated. An
 * arbiter cannot machine-accept a claim no assessment supports, or one
 * assessed wrong_scope, wrong_unit, duplicate, insufficient or unreadable;
 * cannot correct to a value no assessment proposed; cannot reject everything
 * without an assessment against each candidate. Two identical false readings
 * with valid-looking anchors are never accepted.
 *
 * Everything runs in memory on the synthetic records pack with scripted
 * executors. The network is sealed before the engine is used. No sleeps: the
 * clock is manual and the scheduler is ticked by hand, and the statuses of
 * every claim are photographed after every single tick, so "never accepted"
 * means never — not merely "not accepted at the end".
 */
import { harness, closeNetwork } from "./harness.mjs";
import { syntheticRecordSet } from "../domains/synthetic-records/fixture.ts";
import { SyntheticRecordsPack, TASK } from "../domains/synthetic-records/pack.ts";
import { mockExecutors } from "../domains/synthetic-records/mocks.ts";
import { assemble, manualClock } from "../domains/simulate.ts";
import { KERNEL_TASK_TYPES, PACKET_VERSION } from "../kernel/contracts.ts";
import { emptyEnvelope } from "../kernel/deterministic.ts";
import { canonical, entityId } from "../kernel/ids.ts";
import { locatorInside } from "../kernel/locators.ts";
import { sourceReference } from "../kernel/packet-builder.ts";
import { lookupOf, segmentIdFor, sourceIdentityOf } from "../kernel/planning.ts";
import { DEFAULT_POLICY } from "../kernel/policy.ts";
import { validateEnvelope } from "../kernel/result-validator.ts";
import { KERNEL_ROLES } from "../kernel/roles.ts";

const tripped = closeNetwork();
const t = harness("agreement is not proof");

/* ───────────────────────────────────────────────────────────── helpers */

const pack = new SyntheticRecordsPack();
const every = (xs, f) => xs.length > 0 && xs.every(f);
const quantityOf = (claims, entry, group) => claims.find((c) => c.subjectKey === `entry/${entry}` && c.predicate === "quantity" && c.independenceGroup === group);
const readings = (claims) => claims.filter((c) => c.independenceGroup !== null);

/* One assembled world over one record set: scripted executors, an in-memory
   repository, a clock a test moves by hand. */
function world(options = {}) {
  const truth = syntheticRecordSet({ seed: options.seed ?? "acceptance/records", sources: 1, sheetsPerSource: 1, entriesPerTable: options.entries ?? 3 });
  const { registry, executors } = mockExecutors(truth, { scripts: options.scripts, aliases: options.aliases });
  const parts = assemble({ manifest: truth.manifest, pack: new SyntheticRecordsPack(), executors: registry, clock: manualClock() });
  return { truth, wf: truth.manifest.workflowId, registry, executors, ...parts };
}

/* Tick by hand, photographing the whole record after every tick: what every
   claim's status was, which tasks existed and in what state, which attempts
   had been made, and which decisions stood. "Never accepted" is then a
   question about the photographs, not about the end. */
async function drive(w, maxTicks = 40) {
  const shots = [];
  for (let i = 0; i < maxTicks; i++) {
    const report = await w.scheduler.tick();
    const tasks = await w.repo.listTasks(w.wf);
    const attempts = [];
    for (const task of tasks) attempts.push(...await w.repo.listAttempts(task.taskId));
    shots.push({ report, tasks, attempts, claims: await w.repo.listClaims({ workflowId: w.wf }), decisions: await w.repo.listDecisions(w.wf) });
    if (report.dispatched.length === 0 && report.released === 0 && report.stopped === 0 && report.reconciled === 0 && w.scheduler.inFlight.size === 0) break;
  }
  const report = await w.scheduler.runUntilQuiescent();
  const claims = await w.repo.listClaims({ workflowId: w.wf });
  return {
    shots, report, claims,
    tasks: await w.repo.listTasks(w.wf),
    disagreements: await w.repo.listDisagreements(w.wf),
    decisions: await w.repo.listDecisions(w.wf),
    assessments: await w.repo.listAssessments(claims.map((c) => c.claimId)),
    /* Was this claim ever in this status, in any photograph? */
    everIn: (claimId, status) => shots.some((s) => s.claims.some((c) => c.claimId === claimId && c.status === status)),
  };
}

/* The one submitted attempt of a task, and the tasks of a type. */
const tasksOfType = (tasks, taskType) => tasks.filter((x) => x.taskType === taskType);
async function attemptOf(repo, task) {
  return (await repo.listAttempts(task.taskId)).find((a) => a.state === "succeeded") ?? null;
}

/* ═══════════════════════════ (1) corroborated, then verified, then accepted */
t.section("(1) two matching readings are corroborated; only an independent verification accepts one");
{
  const w = world();
  await w.scheduler.plan();
  const run = await drive(w);
  const entryReadings = readings(run.claims).filter((c) => c.predicate === "quantity");

  t.check("the run completes with both readers agreeing on every entry — no disagreement was opened",
    run.report.workflow.state === "completed" && Object.keys(run.report.disagreements).length === 0,
    `${run.report.workflow.state} ${JSON.stringify(run.report.disagreements)}`);

  /* The photograph taken the moment comparison finished and before any
     critic ran: that is where "corroborated and nothing more" lives. */
  const compared = run.shots.find((s) => tasksOfType(s.tasks, KERNEL_TASK_TYPES.compare).length > 0
    && every(tasksOfType(s.tasks, KERNEL_TASK_TYPES.compare), (x) => x.state === "completed"));
  const verifyTasks = compared ? tasksOfType(compared.tasks, KERNEL_TASK_TYPES.verifyClaim) : [];

  t.check("comparison finished in a tick of its own, with the verify_claim tasks it created not yet started",
    compared !== undefined && verifyTasks.length > 0 && every(verifyTasks, (x) => ["created", "blocked", "queued"].includes(x.state))
    && !compared.attempts.some((a) => verifyTasks.some((x) => x.taskId === a.taskId)),
    compared ? verifyTasks.map((x) => x.state).join(", ") : "no such tick");

  t.check("at that moment every blind reading of every subject stands corroborated",
    every(readings(compared.claims), (c) => c.status === "corroborated"),
    [...new Set(readings(compared.claims).map((c) => c.status))].join(", "));

  t.check("at that moment not one reading is accepted or verified — agreement changed nothing but the status name",
    readings(compared.claims).every((c) => c.status !== "accepted" && c.status !== "verified"));

  t.check("at that moment no decision accepts any reading — the only acceptance standing is the source's own identity",
    every(compared.decisions.filter((d) => d.decisionType === "accept_claim"), (d) => d.rationale === "source_identity_matches_manifest"),
    compared.decisions.map((d) => `${d.decisionType}:${d.rationale}`).join(", "));

  /* Then the critic reopens the source, and only then. */
  const critic = tasksOfType(run.tasks, KERNEL_TASK_TYPES.verifyClaim).find((x) => x.subjectKey.includes("region/0"));
  const criticAttempt = await attemptOf(w.repo, critic);
  const supports = run.assessments.filter((a) => a.assessment === "supports" && a.attemptId === criticAttempt?.attemptId);
  const accepted = supports.map((a) => run.claims.find((c) => c.claimId === a.claimId));

  t.check("the critic ran and gave one supports assessment per corroborated reading it was handed",
    criticAttempt !== null && supports.length === critic.targetClaimIds.length && supports.length > 0,
    `${supports.length} supports for ${critic.targetClaimIds.length} targets`);

  t.check("every claim the critic supported is now accepted", every(accepted, (c) => c && c.status === "accepted"),
    accepted.map((c) => c?.status).join(", "));

  t.check("each of those claims was corroborated in an earlier photograph and accepted only in a later one — acceptance came after verification, never with corroboration",
    every(accepted, (c) => run.everIn(c.claimId, "corroborated")
      && run.shots.findIndex((s) => s.claims.some((x) => x.claimId === c.claimId && x.status === "corroborated"))
       < run.shots.findIndex((s) => s.claims.some((x) => x.claimId === c.claimId && x.status === "accepted"))));

  t.check("the supporting assessment came from an independence domain that did not make the reading it judged",
    every(supports, (a) => a.independenceDomain !== run.claims.find((c) => c.claimId === a.claimId).independenceDomain),
    supports.map((a) => a.independenceDomain).join(", "));

  const allSupports = run.assessments.filter((a) => a.assessment === "supports");
  const acceptDecisions = run.decisions.filter((d) => d.rationale === "independent_verification_supports_anchor");
  t.check("every acceptance in the run is one decision per supporting assessment, of authority deterministic_rule under the rule independent_verification_supports_anchor",
    acceptDecisions.length === allSupports.length && every(acceptDecisions, (d) => d.authority === "deterministic_rule" && d.decisionType === "accept_claim" && d.status === "machine_decided"),
    `${acceptDecisions.length} decisions for ${allSupports.length} supporting assessments`);

  t.check("each acceptance names the critic's attempt as the attempt that decided it",
    every(acceptDecisions.filter((d) => supports.some((a) => d.evidence.some((e) => e.claimId === a.claimId))), (d) => d.decidedByAttemptId === criticAttempt.attemptId),
    criticAttempt ? criticAttempt.attemptId.slice(0, 8) : "no attempt");

  t.check("each acceptance's evidence links the claim as supports under that same rule",
    every(acceptDecisions, (d) => d.evidence.some((e) => e.link === "supports" && e.rule === "independent_verification_supports_anchor" && run.claims.some((c) => c.claimId === e.claimId))));

  const assessmentAnchorIds = new Set((await w.repo.listAssessmentAnchors(supports.map((a) => a.assessmentId))).map((a) => a.anchorId));
  t.check("each acceptance's evidence also carries, as context, the anchor the assessment read the source at",
    every(acceptDecisions.filter((d) => d.evidence.some((e) => supports.some((a) => a.claimId === e.claimId))), (d) => d.evidence.some((e) => e.link === "context" && e.anchorId && assessmentAnchorIds.has(e.anchorId))),
    `${assessmentAnchorIds.size} assessment anchors`);

  t.check("the reading that agreed with the verified one is not accepted with it — one reading was verified, and only that reading was accepted",
    entryReadings.some((c) => c.status === "accepted") && entryReadings.some((c) => c.status === "corroborated")
    && entryReadings.filter((c) => c.status === "accepted").every((c) => supports.some((a) => a.claimId === c.claimId)),
    entryReadings.map((c) => `${c.independenceGroup}:${c.status}`).join(" "));
}

/* ═══════════════════════════ (2) two identical false readings */
t.section("(2) two readers agree on a falsehood, with anchors that look right");
{
  const FALSE_QUANTITY = 999;
  const lie = (packet, base) => {
    if (packet.roleKey === "table_reader") {
      for (const c of base.claims) if (c.subjectKey === "entry/E-001") c.value = { ...c.value, quantity: FALSE_QUANTITY, text: `${FALSE_QUANTITY} each` };
    }
    return base;
  };
  const w = world({ scripts: { "reader-family-one": lie, "reader-family-two": lie } });
  await w.scheduler.plan();
  const run = await drive(w);
  const trueEntry = w.truth.entries.find((e) => e.id === "E-001");
  const falseClaims = run.claims.filter((c) => c.subjectKey === "entry/E-001" && c.predicate === "quantity" && c.value.quantity === FALSE_QUANTITY);
  const segments = await w.repo.listSegments(w.wf);
  const falseAnchors = await w.repo.listAnchors(falseClaims.map((c) => c.claimId));

  t.check("both blind readers reported the same false quantity for the same entry, in two independence domains",
    falseClaims.length === 2 && new Set(falseClaims.map((c) => c.independenceGroup)).size === 2 && new Set(falseClaims.map((c) => c.independenceDomain)).size === 2
    && trueEntry.quantity !== FALSE_QUANTITY,
    `${falseClaims.length} readings of ${FALSE_QUANTITY} where the source holds ${trueEntry.quantity}`);

  t.check("the false readings carry valid-looking anchors: each names a persisted segment and lies inside it",
    every(falseAnchors, (a) => { const seg = segments.find((s) => s.segmentId === a.segmentId); return seg !== undefined && locatorInside(a.locator, seg.locator); }),
    `${falseAnchors.length} anchors`);

  t.check("the comparator did corroborate them — the falsehood passed agreement, as it must",
    falseClaims.every((c) => run.everIn(c.claimId, "corroborated")));

  t.check("in no photograph of any tick is either false reading accepted",
    falseClaims.every((c) => !run.everIn(c.claimId, "accepted")),
    run.shots.map((s, i) => `t${i}:${falseClaims.map((c) => s.claims.find((x) => x.claimId === c.claimId)?.status ?? "-").join("/")}`).join(" "));

  t.check("in no photograph of any tick is either false reading verified",
    falseClaims.every((c) => !run.everIn(c.claimId, "verified")));

  t.check("acceptances were made in this run, and not one of them rests on a false reading as supporting evidence",
    every(run.decisions.filter((d) => d.decisionType === "accept_claim"), (d) => !d.evidence.some((e) => e.link === "supports" && falseClaims.some((c) => c.claimId === e.claimId))),
    `${run.decisions.filter((d) => d.decisionType === "accept_claim").length} acceptances`);

  const dispute = run.disagreements.find((d) => d.subjectSignature.found_by === "verification");
  t.check("the critic's contradiction opened a disagreement whose subjectSignature.found_by is verification",
    dispute !== undefined && dispute.kind === "value" && dispute.severity === "material",
    run.disagreements.map((d) => `${d.kind}:${d.subjectSignature.found_by ?? "comparison"}`).join(", "));

  t.check("that disagreement is between the source and BOTH false readings — the reading that agreed is in it too",
    dispute !== undefined && dispute.claimIds.length === 2 && falseClaims.every((c) => dispute.claimIds.includes(c.claimId)));

  const verifier = tasksOfType(run.tasks, KERNEL_TASK_TYPES.verifyDisagreement).find((x) => x.disagreementId === dispute?.disagreementId);
  const arbiter = tasksOfType(run.tasks, KERNEL_TASK_TYPES.adjudicate).find((x) => x.disagreementId === dispute?.disagreementId);
  const verifierAttempt = verifier ? await attemptOf(w.repo, verifier) : null;
  const arbiterAttempt = arbiter ? await attemptOf(w.repo, arbiter) : null;

  t.check("the dispute was verified once more and then adjudicated: both tasks ran and completed",
    verifier?.state === "completed" && arbiter?.state === "completed" && verifierAttempt !== null && arbiterAttempt !== null,
    `${verifier?.state} / ${arbiter?.state}`);

  t.check("the verifier read the source against both false readings and said what it read instead",
    every(run.assessments.filter((a) => a.attemptId === verifierAttempt?.attemptId), (a) => a.assessment === "contradicts" && a.proposedValue?.quantity === trueEntry.quantity),
    run.assessments.filter((a) => a.attemptId === verifierAttempt?.attemptId).map((a) => `${a.assessment}:${a.proposedValue?.quantity}`).join(", "));

  t.check("the arbiter's outcome is correct — it neither accepted a reading nor rejected everything",
    arbiterAttempt?.rawResult?.adjudication?.outcome === "correct",
    String(arbiterAttempt?.rawResult?.adjudication?.outcome));

  const corrected = run.claims.find((c) => c.attemptId === arbiterAttempt?.attemptId);
  t.check("the correction is a new claim about the same entry, made by the arbiter's own attempt and belonging to no blind group",
    corrected !== undefined && corrected.subjectKey === "entry/E-001" && corrected.predicate === "quantity" && corrected.independenceGroup === null);

  t.check("the corrected claim's value is what the source holds — the fixture's own truth for that entry",
    corrected?.value.quantity === trueEntry.quantity && corrected?.unit === trueEntry.unit && corrected?.value.attributes?.category === trueEntry.category,
    `${corrected?.value.quantity} ${corrected?.unit} vs ${trueEntry.quantity} ${trueEntry.unit}`);

  const citedAnchorIds = arbiterAttempt?.rawResult?.adjudication?.evidenceAnchorIds ?? [];
  const citedAssessmentAnchors = (await w.repo.listAssessmentAnchors(run.assessments.map((a) => a.assessmentId))).filter((a) => citedAnchorIds.includes(a.anchorId));
  const correctedAnchors = await w.repo.listAnchors([corrected?.claimId ?? ""]);

  t.check("the arbiter rested its correction on the assessments' anchors, not on the readers' word",
    citedAnchorIds.length > 0 && citedAssessmentAnchors.length === citedAnchorIds.length,
    `${citedAssessmentAnchors.length} of ${citedAnchorIds.length} cited anchors belong to assessments`);

  t.check("the corrected claim's anchors are those assessment anchors — the same anchorHash, one for one",
    correctedAnchors.length === citedAssessmentAnchors.length && correctedAnchors.length > 0
    && canonical([...correctedAnchors.map((a) => a.anchorHash)].sort()) === canonical([...citedAssessmentAnchors.map((a) => a.anchorHash)].sort()),
    correctedAnchors.map((a) => a.anchorHash.slice(0, 8)).join(","));

  t.check("each corrected anchor is derived from the assessment anchor it copies, by identity",
    every(correctedAnchors, (a) => citedAssessmentAnchors.some((x) => entityId("anchor", corrected.claimId, x.anchorId) === a.anchorId)));

  t.check("both false readings end rejected",
    every(falseClaims, (c) => c.status === "rejected"), falseClaims.map((c) => `${c.independenceGroup}:${c.status}`).join(" "));

  const resolution = run.decisions.find((d) => d.disagreementId === dispute?.disagreementId && d.status === "machine_decided");
  t.check("the resolution is the arbiter's decision: authority adjudicator, decided by the arbiter's attempt",
    resolution !== undefined && resolution.authority === "adjudicator" && resolution.decidedByAttemptId === arbiterAttempt?.attemptId);

  t.check("the resolution supports the correction and contradicts both false readings",
    resolution?.evidence.some((e) => e.link === "supports" && e.claimId === corrected?.claimId)
    && falseClaims.every((c) => resolution.evidence.some((e) => e.link === "contradicts" && e.claimId === c.claimId)));

  t.check("the disagreement is resolved and the workflow finishes without a person",
    dispute?.state === "resolved" && run.report.workflow.state === "completed", `${dispute?.state} / ${run.report.workflow.state}`);

  const total = run.claims.find((c) => c.subjectKey === `category/${trueEntry.category}` && c.status === "accepted");
  t.check("the total that names that entry's category counts the corrected value, not the falsehood",
    total !== undefined && total.value.quantity === w.truth.totals[trueEntry.category].quantity && total.inputClaimIds.includes(corrected.claimId)
    && !falseClaims.some((c) => total.inputClaimIds.includes(c.claimId)),
    `${total?.value.quantity} vs ${w.truth.totals[trueEntry.category].quantity}`);
}

/* ═══════════════════════════ (3) a critic that authored what it judges */
t.section("(3) a critic whose domain wrote the readings accepts nothing");
{
  const w = world({ aliases: { "critic-family-one": "reader-family-one", "critic-family-two": "reader-family-two" } });
  t.check("both critic families are the two readers' own executor instances — every critic domain authored a reading",
    w.registry.domainOf("critic-family-one") === w.registry.domainOf("reader-family-one")
    && w.registry.domainOf("critic-family-two") === w.registry.domainOf("reader-family-two"));

  await w.scheduler.plan();
  const run = await drive(w);
  const critics = tasksOfType(run.tasks, KERNEL_TASK_TYPES.verifyClaim);

  t.check("no verify_claim attempt was ever submitted — every critic was refused before submission",
    critics.length > 0 && every(critics, (x) => x.state === "failed_known" && x.terminalReason === "independence_unavailable"),
    critics.map((x) => `${x.state}/${x.terminalReason}`).join(", "));

  t.check("no assessment exists anywhere in the record — nothing was verified by anybody",
    run.assessments.length === 0);

  t.check("the readings stay corroborated or disputed; in no photograph of any tick is a reading accepted",
    readings(run.claims).length > 0 && readings(run.claims).every((c) => !run.everIn(c.claimId, "accepted") && !run.everIn(c.claimId, "verified"))
    && readings(run.claims).some((c) => c.status === "corroborated"),
    [...new Set(readings(run.claims).map((c) => c.status))].join(", "));

  t.check("the only acceptance in the whole run is the deterministic one over the source's own identity",
    every(run.decisions.filter((d) => d.decisionType === "accept_claim"), (d) => d.rationale === "source_identity_matches_manifest"),
    run.decisions.map((d) => `${d.decisionType}:${d.status}`).join(", "));

  t.check("each subject whose verification could not be had is held for a person by a coverage disagreement in needs_human",
    every(critics, (x) => run.disagreements.some((d) => d.kind === "coverage" && d.subjectSignature.subject_key === x.subjectKey && d.state === "needs_human")),
    run.disagreements.map((d) => `${d.kind}:${d.state}`).join(", "));

  t.check("each hold is a decision of type hold in status needs_human, addressed to a reviewer",
    every(critics, (x) => run.decisions.some((d) => d.subjectKey === x.subjectKey && d.decisionType === "hold" && d.status === "needs_human" && d.actions.some((a) => a.actionType === "review"))));

  t.check("the workflow ends partial — corroboration alone never finished it",
    run.report.workflow.state === "partial", run.report.workflow.state);
}

/* ═══════════════════════════ (4) what the validator refuses an arbiter */
t.section("(4) the arbiter's refusals, on hand-built envelopes");
{
  const ARBITER = KERNEL_ROLES.find((r) => r.roleKey === "evidence_arbiter");
  const truth = syntheticRecordSet({ seed: "acceptance/validator", sources: 1, sheetsPerSource: 1, entriesPerTable: 2 });
  const source = truth.manifest.sources[0];
  const declared = source.declaredSegments[0];
  const segmentId = segmentIdFor(truth.manifest.workflowId, declared.sourceId, declared.parentSegmentId, declared.segmentKind, declared.contentHash);
  const segment = { ...declared, segmentId, workflowId: truth.manifest.workflowId, status: "accepted", discoveredBy: "deterministic", discoveredByAttemptId: null };
  const lookup = lookupOf(truth.manifest, [segment]);
  const anchorId = (name) => entityId("fixture-anchor", name);
  const DISPUTE = entityId("fixture-disagreement", "E-001");

  const value = (quantity) => ({ known: true, quantity, text: `${quantity} each`, attributes: { category: "alpha" } });
  const claimAt = (ref, quantity, top) => ({
    ref, subjectType: "entry", subjectKey: "entry/E-001", predicate: "quantity", value: value(quantity), unit: "each",
    observationBasis: "observed", scope: { segment: "table 1" }, status: "disputed", independenceGroup: null, inputRefs: [],
    anchors: [{ anchorId: anchorId(ref), sourceKind: "segment_locator", sourceId: source.sourceId, segmentId, locator: { bbox: [0.05, top, 0.95, top + 0.1] }, quotedText: `E-001 alpha ${quantity} each` }],
  });
  const assessed = (claimRef, assessment, anchorRef, proposedValue = null) => ({
    claimRef, assessment, reasonCode: `${assessment}_at_the_anchor`, explanation: "what the reopened source shows at the place the claim names",
    anchorIds: [anchorId(anchorRef)], proposedValue, proposedUnit: proposedValue ? "each" : null,
  });

  const A = claimAt("A", 12, 0.1);
  const B = claimAt("B", 18, 0.3);
  const packetFor = (assessments) => ({
    packetVersion: PACKET_VERSION, workflowId: truth.manifest.workflowId, taskId: entityId("fixture-task", "adjudicate"), parentTaskId: null,
    phase: "adjudicate", roleKey: ARBITER.roleKey, roleVersion: ARBITER.version, taskType: KERNEL_TASK_TYPES.adjudicate,
    subjectKey: "entry/E-001", objective: "propose one outcome for this disagreement",
    sources: [sourceReference({ sourceId: null, segmentId }, lookup)], dependencies: [], independenceGroup: null, blindContext: true,
    allowedActions: [...ARBITER.allowedActions],
    limits: { maximumSources: ARBITER.maximumSources, maximumClaims: 0, maximumFollowUps: 1, maximumDepth: 2, maximumOutputBytes: DEFAULT_POLICY.maximumEnvelopeBytes },
    expectedOutputContract: ARBITER.outputContract, inputFingerprint: "fixture",
    context: {
      claims: [A, B], assessments,
      disagreements: [{ disagreementId: DISPUTE, kind: "value", severity: "material", subjectSignature: { subject_key: "entry/E-001" }, claimRefs: ["A", "B"] }],
      depth: 1, validation: [],
    },
  });

  /* One adjudication, validated as the kernel would validate it. */
  const judge = (assessments, adjudication) => {
    const packet = packetFor(assessments);
    const envelope = emptyEnvelope(packet);
    envelope.adjudication = {
      outcome: "accept_claim", disagreementId: DISPUTE, acceptedClaimRef: null, correctedValue: null, correctedUnit: null,
      rationale: "the reopened source settles this at the anchor the claim names", evidenceAnchorIds: [], followUp: null, ...adjudication,
    };
    return validateEnvelope(packet, envelope, { role: ARBITER, pack, lookup, policy: DEFAULT_POLICY });
  };
  const refuses = (label, verdict, rule) => t.check(label, !verdict.ok && verdict.problems.some((p) => rule.test(p)), verdict.problems.join(" | ") || "allowed");

  /* The control: the same shape, done properly, passes — so every refusal
     below is the rule refusing and not the fixture failing. */
  const good = judge([assessed("A", "supports", "A")], { acceptedClaimRef: "A", evidenceAnchorIds: [anchorId("A")] });
  t.check("control: accepting the one reading an independent assessment supports, on that reading's own anchor, is allowed",
    good.ok, good.problems.join(" | "));

  refuses("accepting a claim no assessment supports is refused — agreement is not proof",
    judge([], { acceptedClaimRef: "A", evidenceAnchorIds: [anchorId("A")] }), /no assessment supports/);

  for (const kind of ["wrong_scope", "wrong_unit", "duplicate", "insufficient", "unreadable"]) {
    refuses(`accepting a claim an assessment found ${kind} is refused — a person decides that`,
      judge([assessed("A", "supports", "A"), assessed("A", kind, "B")], { acceptedClaimRef: "A", evidenceAnchorIds: [anchorId("A")] }),
      new RegExp(`found ${kind}`));
  }

  refuses("correcting to a value no assessment read off the source is refused",
    judge([assessed("A", "contradicts", "A", value(18)), assessed("B", "contradicts", "B", value(18))],
      { outcome: "correct", correctedValue: value(41), correctedUnit: "each", evidenceAnchorIds: [anchorId("A")] }),
    /proposed by nobody/);

  refuses("correcting with no evidence anchors is refused — a correction shows what the source holds instead",
    judge([assessed("A", "contradicts", "A", value(18)), assessed("B", "contradicts", "B", value(18))],
      { outcome: "correct", correctedValue: value(18), correctedUnit: "each", evidenceAnchorIds: [] }),
    /a correction needs source anchors/);

  refuses("rejecting every reading with no assessment against one of them is refused",
    judge([assessed("A", "contradicts", "A")], { outcome: "reject_all", evidenceAnchorIds: [anchorId("A")] }),
    /needs an assessment against B/);

  refuses("rejecting every reading with no evidence anchors is refused",
    judge([assessed("A", "contradicts", "A"), assessed("B", "contradicts", "B")], { outcome: "reject_all", evidenceAnchorIds: [] }),
    /rejecting every reading needs source evidence/);

  refuses("an adjudication whose rationale rests on a majority is refused, however well-formed the rest of it is",
    judge([assessed("A", "supports", "A")], { acceptedClaimRef: "A", evidenceAnchorIds: [anchorId("A")], rationale: "two readers agree, so the majority carries it" }),
    /majority/);

  refuses("asking for more evidence without naming the follow-up is refused — it would loop for ever",
    judge([assessed("A", "supports", "A")], { outcome: "needs_more_evidence", acceptedClaimRef: null, evidenceAnchorIds: [] }),
    /names no follow-up/);

  refuses("accepting a claim on an anchor that is neither its own nor a supporting assessment's is refused",
    judge([assessed("A", "supports", "A")], { acceptedClaimRef: "A", evidenceAnchorIds: [anchorId("B")] }),
    /not A's own anchor nor an assessment supporting it/);

  t.check("each refusal is the one rule refusing: the well-formed shapes above carry exactly one problem each",
    [judge([], { acceptedClaimRef: "A", evidenceAnchorIds: [anchorId("A")] }),
     judge([assessed("A", "supports", "A"), assessed("A", "wrong_unit", "B")], { acceptedClaimRef: "A", evidenceAnchorIds: [anchorId("A")] }),
     judge([assessed("A", "contradicts", "A")], { outcome: "reject_all", evidenceAnchorIds: [anchorId("A")] }),
     judge([assessed("A", "supports", "A")], { acceptedClaimRef: "A", evidenceAnchorIds: [anchorId("B")] })].every((v) => v.problems.length === 1));
}

/* ═══════════════════════════ (5) the repository refuses a decision resting on nothing */
t.section("(5) a machine decision must rest on an accepted claim, through that claim's own anchor");
{
  const w = world();
  await w.scheduler.plan();
  const run = await drive(w);
  const acceptedClaim = run.claims.find((c) => c.status === "accepted" && c.independenceGroup !== null);
  const corroborated = run.claims.find((c) => c.status === "corroborated");
  const otherClaim = run.claims.find((c) => c.status === "accepted" && c.claimId !== acceptedClaim.claimId && c.anchorIds.length > 0);
  const someAttempt = run.shots.at(-1).attempts.find((a) => a.state === "succeeded");

  t.check("the run left an accepted reading, a corroborated one and a second accepted claim with anchors of its own",
    acceptedClaim !== undefined && corroborated !== undefined && otherClaim !== undefined && someAttempt !== undefined);

  const proposal = (over) => ({
    decideTo: "machine_decided",
    decision: {
      decisionId: entityId("fixture-decision", over.tag), workflowId: w.wf, taskId: null, disagreementId: null,
      decisionType: "accept_claim", subjectKey: "entry/E-001", title: "a decision built by hand", status: "proposed",
      authority: "deterministic_rule", rationale: "written by a test", riskLevel: "normal", decidedByAttemptId: someAttempt.attemptId,
      evidence: over.evidence, actions: [], summary: null,
    },
  });

  await t.refused("a machine decision whose only supporting claim is merely corroborated is refused — corroboration is not acceptance",
    () => w.repo.applyDecision(proposal({ tag: "on-corroborated", evidence: [{ claimId: corroborated.claimId, anchorId: null, link: "supports", rule: "test" }] })));

  await t.refused("a decision citing a claim through an anchor that belongs to another claim is refused",
    () => w.repo.applyDecision(proposal({ tag: "foreign-anchor", evidence: [{ claimId: acceptedClaim.claimId, anchorId: otherClaim.anchorIds[0], link: "supports", rule: "test" }] })));

  const honest = await w.repo.applyDecision(proposal({ tag: "on-accepted", evidence: [{ claimId: acceptedClaim.claimId, anchorId: acceptedClaim.anchorIds[0], link: "supports", rule: "test" }] }));
  t.check("the same decision resting on an accepted claim through that claim's own anchor is written and decided",
    honest.status === "machine_decided" && honest.decidedByAttemptId === someAttempt.attemptId, honest.status);

  const onCorroborated = await w.repo.getDecision(entityId("fixture-decision", "on-corroborated"));
  t.check("neither refused decision stands as a machine decision: the one resting on corroboration was never decided, and the one citing a foreign anchor was never written at all",
    onCorroborated?.status !== "machine_decided" && (await w.repo.getDecision(entityId("fixture-decision", "foreign-anchor"))) === null,
    `${onCorroborated ? onCorroborated.status : "absent"} / absent`);

  t.check("the corroborated claim it would have rested on is still merely corroborated — a refused decision changed no claim",
    (await w.repo.getClaim(corroborated.claimId)).status === "corroborated");
}

/* ═══════════════════════════ (6) the deterministic rule over the source */
t.section("(6) the ingestor's identity claim is accepted by code, against the manifest itself");
{
  const w = world();
  await w.scheduler.plan();
  const run = await drive(w);
  const source = w.truth.manifest.sources[0];
  const identity = run.claims.find((c) => c.predicate === "content_identity");
  const firstShot = run.shots[0];

  t.check("the ingest produced one identity claim about the source, anchored to it",
    identity !== undefined && identity.subjectType === "source" && identity.anchorIds.length === 1 && identity.observationBasis === "derived");

  t.check("its value is the source's identity as the manifest records it — sourceIdentityOf, character for character",
    identity.value.text === sourceIdentityOf(source), `${identity.value.text} vs ${sourceIdentityOf(source)}`);

  t.check("it is accepted by the rule source_identity_matches_manifest, with authority deterministic_rule",
    run.decisions.some((d) => d.rationale === "source_identity_matches_manifest" && d.authority === "deterministic_rule" && d.status === "machine_decided"
      && d.evidence.some((e) => e.claimId === identity.claimId && e.link === "supports")));

  t.check("it was already accepted in the first tick's photograph, before any model role had run and with no assessment in the record",
    firstShot.claims.some((c) => c.claimId === identity.claimId && c.status === "accepted")
    && (await w.repo.listAssessments([identity.claimId])).length === 0
    && firstShot.attempts.every((a) => a.executorKind === "deterministic"),
    firstShot.attempts.map((a) => a.executorKind).join(", "));
}

/* ═══════════════════════════ (7) a derived total over accepted inputs only */
t.section("(7) a derived total is accepted only when every input it names is accepted");
{
  const wrongOnOne = (packet, base) => {
    if (packet.roleKey === "table_reader" && packet.independenceGroup === "reader-b") {
      for (const c of base.claims) if (c.subjectKey === "entry/E-001") c.value = { ...c.value, quantity: c.value.quantity + 5, text: `${c.value.quantity + 5} ${c.unit}` };
    }
    return base;
  };
  const toAPerson = (_packet, base) => {
    base.adjudication = { ...base.adjudication, outcome: "needs_human", acceptedClaimRef: null, correctedValue: null, correctedUnit: null, evidenceAnchorIds: [], followUp: null, rationale: "the assessments settle nothing; a person decides" };
    return base;
  };
  const w = world({ seed: "acceptance/totals", entries: 4, scripts: { "reader-family-two": wrongOnOne, "arbiter-family-one": toAPerson } });
  await w.scheduler.plan();
  const run = await drive(w);
  const disputed = run.claims.filter((c) => c.subjectKey === "entry/E-001" && c.predicate === "quantity");
  const heldCategory = w.truth.entries.find((e) => e.id === "E-001").category;
  const totals = run.claims.filter((c) => c.subjectType === "category");

  t.check("the arbiter sent the dispute to a person, so neither competing reading was settled by machine",
    run.disagreements.some((d) => d.kind === "value" && d.state === "needs_human") && every(disputed, (c) => c.status === "unresolved"),
    disputed.map((c) => `${c.independenceGroup}:${c.status}`).join(" "));

  t.check("in no photograph of any tick was either competing reading accepted",
    disputed.every((c) => !run.everIn(c.claimId, "accepted")));

  t.check("no total was accepted for the category whose only entry is unresolved — an unaccepted input is not counted, it stops the total",
    !totals.some((c) => c.subjectKey === `category/${heldCategory}`)
    && w.truth.entries.filter((e) => e.category === heldCategory).length === 1,
    `${heldCategory}: ${totals.map((c) => c.subjectKey).join(", ")}`);

  t.check("the derivation for that category ended with insufficient evidence rather than a total over what happened to be accepted",
    tasksOfType(run.tasks, TASK.totalByCategory).some((x) => x.subjectKey === `category/${heldCategory}` && x.state === "completed" && x.terminalReason === "insufficient_evidence"),
    tasksOfType(run.tasks, TASK.totalByCategory).map((x) => `${x.subjectKey}:${x.state}/${x.terminalReason}`).join(" "));

  const acceptedEntriesOf = (category) => run.claims.filter((c) => c.status === "accepted" && c.subjectType === "entry" && c.predicate === "quantity" && c.value.attributes?.category === category);
  t.check("every accepted total counts exactly the accepted entry claims of its own category — entries_counted is that number",
    every(totals.filter((c) => c.status === "accepted"), (c) => c.value.attributes.entries_counted === acceptedEntriesOf(c.subjectKey.replace("category/", "")).length),
    totals.map((c) => `${c.subjectKey}:${c.value.attributes?.entries_counted}`).join(" "));

  t.check("every accepted total names exactly those accepted claims as its inputs",
    every(totals.filter((c) => c.status === "accepted"), (c) => canonical([...c.inputClaimIds].sort()) === canonical(acceptedEntriesOf(c.subjectKey.replace("category/", "")).map((x) => x.claimId).sort())));

  t.check("no total names an unresolved reading among its inputs",
    every(totals, (c) => !disputed.some((d) => c.inputClaimIds.includes(d.claimId))));

  t.check("each accepted total's acceptance is a deterministic rule naming the derivation, and every input it names is itself accepted",
    every(totals.filter((c) => c.status === "accepted"), (c) => run.decisions.some((d) => d.authority === "deterministic_rule" && d.rationale === `derived:${TASK.totalByCategory}` && d.evidence.some((e) => e.claimId === c.claimId && e.link === "supports"))
      && c.inputClaimIds.every((id) => run.claims.find((x) => x.claimId === id)?.status === "accepted")));

  t.check("the workflow ends partial, because a subject waits for a person",
    run.report.workflow.state === "partial", run.report.workflow.state);
}

/* ═══════════════════════════ (8) what one reader saw and the other did not */
t.section("(8) a reading one reader dropped is settled by reopening the source, not by trusting the reader that saw it");
{
  const dropsOne = (packet, base) => {
    if (packet.roleKey === "table_reader" && packet.independenceGroup === "reader-b") base.claims = base.claims.filter((c) => c.subjectKey !== "entry/E-001");
    return base;
  };
  const w = world({ scripts: { "reader-family-two": dropsOne } });
  await w.scheduler.plan();
  const run = await drive(w);
  const seen = quantityOf(run.claims, "E-001", "reader-a");
  const trueEntry = w.truth.entries.find((e) => e.id === "E-001");

  t.check("only one reader reported that entry; the other's reading of the same table came back without it",
    seen !== undefined && quantityOf(run.claims, "E-001", "reader-b") === undefined
    && quantityOf(run.claims, "E-002", "reader-b") !== undefined,
    "one reading of E-001, two of E-002");

  const missing = run.disagreements.find((d) => d.kind === "missing");
  t.check("the comparator opened a missing disagreement naming the one reading that exists",
    missing !== undefined && missing.claimIds.length === 1 && missing.claimIds[0] === seen.claimId);

  t.check("that reading was never corroborated — one reader saying a thing is not two",
    !run.everIn(seen.claimId, "corroborated"),
    run.shots.map((s, i) => `t${i}:${s.claims.find((c) => c.claimId === seen.claimId)?.status ?? "-"}`).join(" "));

  t.check("critics ran on this workflow's corroborated readings, but no verify_claim task ever targeted this one — there was no corroboration to check",
    every(tasksOfType(run.tasks, KERNEL_TASK_TYPES.verifyClaim), (x) => !x.targetClaimIds.includes(seen.claimId)),
    `${tasksOfType(run.tasks, KERNEL_TASK_TYPES.verifyClaim).length} verify_claim tasks`);

  const verifier = tasksOfType(run.tasks, KERNEL_TASK_TYPES.verifyDisagreement).find((x) => x.disagreementId === missing?.disagreementId);
  const arbiter = tasksOfType(run.tasks, KERNEL_TASK_TYPES.adjudicate).find((x) => x.disagreementId === missing?.disagreementId);
  const verifierAttempt = verifier ? await attemptOf(w.repo, verifier) : null;
  const arbiterAttempt = arbiter ? await attemptOf(w.repo, arbiter) : null;
  const support = run.assessments.find((a) => a.claimId === seen.claimId && a.attemptId === verifierAttempt?.attemptId);

  t.check("the source was reopened for it: a verifier ran and supported the reading against what the source shows",
    support !== undefined && support.assessment === "supports");

  t.check("the verifier judged from a domain that did not make the reading",
    support !== undefined && support.independenceDomain !== seen.independenceDomain,
    `${support?.independenceDomain} vs ${seen.independenceDomain}`);

  const acceptance = run.decisions.find((d) => d.disagreementId === missing?.disagreementId && d.decisionType === "accept_claim");
  const acceptedAt = run.shots.findIndex((s) => s.claims.some((c) => c.claimId === seen.claimId && c.status === "accepted"));
  const adjudicatedAt = run.shots.findIndex((s) => s.tasks.some((x) => x.taskId === arbiter?.taskId && x.state === "completed"));

  t.check("acceptance came no earlier than the adjudication that rests on the verification",
    acceptedAt >= 0 && acceptedAt === adjudicatedAt, `accepted at tick ${acceptedAt}, adjudicated at tick ${adjudicatedAt}`);

  t.check("the acceptance is the arbiter's, decided by the arbiter's own attempt, settling the missing disagreement",
    acceptance !== undefined && acceptance.authority === "adjudicator" && acceptance.decidedByAttemptId === arbiterAttempt?.attemptId && acceptance.status === "machine_decided");

  const supportAnchors = (await w.repo.listAssessmentAnchors([support?.assessmentId ?? ""])).map((a) => a.anchorId);
  t.check("the arbiter cited the verifier's own anchor among the evidence it rested on",
    supportAnchors.length > 0 && supportAnchors.every((id) => (arbiterAttempt?.rawResult?.adjudication?.evidenceAnchorIds ?? []).includes(id)));

  t.check("the reading ends accepted, and what it says is what the source holds",
    seen.status === "accepted" && seen.value.quantity === trueEntry.quantity && seen.unit === trueEntry.unit,
    `${seen.status} ${seen.value.quantity} ${seen.unit}`);
}

/* ═══════════════════════════ every door stayed closed */
t.section("every door stayed closed");
t.check("nothing in this file tried the network", tripped() === 0, `${tripped()} attempts`);

t.finish();
