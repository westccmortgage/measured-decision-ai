/* EVIDENCE POINTS AT ONE PLACE, AND A DECISION CITES ONLY ITS OWN SUBJECT.
 *
 * docs/core-v2.md §5: an anchor is one consistent tuple — source → segment →
 * locator. The segment must belong to the source, the source to the workflow,
 * and the locator to the segment's own locator space: a box inside the
 * segment's box, a time range inside the segment's range. A segment of one
 * source cannot be combined with another source's id. The kernel validates
 * every anchor against the persisted segments, not against the envelope's own
 * say-so, and the repository refuses again what it cannot place. Decision
 * composers receive only the accepted claims of their own subject and what
 * those claims were computed from; a decision about one subject cannot cite
 * evidence about another. Every material attribute of a value is compared:
 * two readings that agree on a quantity and differ on an attribute differ.
 *
 * Four parts: the validator on hand-built envelopes over a real record; the
 * repository's own guards inside a commit; the comparator's arithmetic; and
 * one end-to-end run where a composer tries to reach into another subject.
 *
 * Nothing here reaches a network or a database; the network is sealed first,
 * the clock is manual, and no test sleeps.
 */
import { harness, closeNetwork } from "./harness.mjs";
import { syntheticRecordSet } from "../domains/synthetic-records/fixture.ts";
import { SyntheticRecordsPack, TASK } from "../domains/synthetic-records/pack.ts";
import { mockExecutors, readTable } from "../domains/synthetic-records/mocks.ts";
import { assemble, manualClock } from "../domains/simulate.ts";
import { compareClaims, DEFAULT_NORMALISERS } from "../kernel/comparison.ts";
import { KernelDeterministicExecutor, emptyEnvelope } from "../kernel/deterministic.ts";
import { canonical, entityId, sha256 } from "../kernel/ids.ts";
import { sourceReference } from "../kernel/packet-builder.ts";
import { lookupOf } from "../kernel/planning.ts";
import { DEFAULT_POLICY } from "../kernel/policy.ts";
import { validateEnvelope } from "../kernel/result-validator.ts";
import { RoleRegistry } from "../kernel/roles.ts";

const tripped = closeNetwork();
const t = harness("evidence points at one place, and a decision cites only its own subject");

/* ───────────────────────────────────────────────────────────── helpers */

const clone = (x) => JSON.parse(JSON.stringify(x));
const LIMITS = {
  maximumTasks: DEFAULT_POLICY.maximumTasksPerWorkflow, maximumEdges: DEFAULT_POLICY.maximumDependencyEdgesPerWorkflow,
  maximumChildrenPerParent: DEFAULT_POLICY.maximumChildTasksPerParent, maximumDepth: DEFAULT_POLICY.maximumFollowUpDepth,
};

/* One assembled world over the synthetic records: two sources, one sheet
   each, three entries per table. Everything runs in memory. */
function world(seed, mockOptions = {}, extra = {}) {
  const truth = syntheticRecordSet({ seed, sources: 2, sheetsPerSource: 1, entriesPerTable: 3 });
  const pack = new SyntheticRecordsPack();
  const { registry, executors } = mockExecutors(truth, mockOptions);
  const parts = assemble({ manifest: truth.manifest, pack, executors: registry, clock: manualClock(), ...extra });
  return { truth, pack, wf: truth.manifest.workflowId, registry, executors, ...parts };
}

/* ══════════════════════════════════════════════════════════════════════
   The record every part-A check is validated against: a finished run, its
   persisted segments, and the packets its roles were actually handed.
   ══════════════════════════════════════════════════════════════════════ */

const A = world("evidence-scope/records");
await A.scheduler.plan();
const aReport = await A.scheduler.runUntilQuiescent();
const segments = await A.repo.listSegments(A.wf);
const lookup = lookupOf(A.truth.manifest, segments);
const roles = new RoleRegistry(A.pack);
const seen = A.registry.packetsSeen;

const tablePacket = seen.find((p) => p.roleKey === "table_reader");
const ingestPacket = seen.find((p) => p.roleKey === "source_ingestor");
const discoverPacket = seen.find((p) => p.roleKey === "region_discoverer");
const tableEnvelope = tablePacket ? readTable(tablePacket, A.truth) : null;
const ingestEnvelope = ingestPacket ? new KernelDeterministicExecutor(A.pack).ingest(ingestPacket) : null;

const tableSegment = segments.find((s) => s.segmentId === tablePacket?.sources[0]?.segmentId);
const noteSegment = segments.find((s) => s.segmentKind === "note" && s.sourceId === tableSegment?.sourceId);
const otherSourceId = A.truth.manifest.sources.find((s) => s.sourceId !== tableSegment?.sourceId)?.sourceId;

/* Validate an envelope exactly as the scheduler would, against the record. */
const validate = (packet, envelope) => validateEnvelope(packet, envelope, { role: roles.role(packet.roleKey), pack: A.pack, lookup, policy: DEFAULT_POLICY });

/* One check per rule: the envelope is refused, and the refusal says which
   rule it broke. A refusal for another reason is a failure, not a pass. */
const refuses = (label, packet, envelope, pattern) => {
  const result = validate(packet, envelope);
  t.check(label, !result.ok && result.problems.some((p) => pattern.test(p)),
    result.ok ? "the envelope was accepted" : result.problems.join(" | "));
};

/* An envelope like the reader's, with its first anchor or first claim changed. */
const withAnchor = (patch) => { const e = clone(tableEnvelope); Object.assign(e.anchors[0], patch); return e; };
const withClaim = (patch) => { const e = clone(tableEnvelope); Object.assign(e.claims[0], patch); return e; };
const withValue = (patch) => withClaim({ value: { ...clone(tableEnvelope).claims[0].value, ...patch } });

/* ══════════════════════════════════════════════════════════ part A */
t.section("A. the world these envelopes are validated against");

t.check("the run finished and produced the packets this file validates against",
  aReport.workflow.state === "completed" && !!tablePacket && !!ingestPacket && !!discoverPacket,
  `${aReport.workflow.state}; roles seen: ${[...new Set(seen.map((p) => p.roleKey))].join(", ")}`);

t.check("the record holds the table and note segments the reader's anchors point at, each with a box of its own",
  !!tableSegment && !!noteSegment && tableSegment.segmentId !== noteSegment.segmentId
  && Array.isArray(tableSegment.locator.bbox) && Array.isArray(noteSegment.locator.bbox),
  `${tableSegment?.segmentKind} ${JSON.stringify(tableSegment?.locator)} / ${noteSegment?.segmentKind}`);

t.check("the workflow reads a second source, so a segment of one source can be offered under the other's id",
  !!otherSourceId && otherSourceId !== tableSegment.sourceId);

t.check("control: the reader's own envelope, unaltered, passes the validator",
  validate(tablePacket, tableEnvelope).ok, validate(tablePacket, tableEnvelope).problems.join(" | "));

t.check("control: the ingestor's own envelope, unaltered, passes the validator",
  validate(ingestPacket, ingestEnvelope).ok, validate(ingestPacket, ingestEnvelope).problems.join(" | "));

t.section("A. an anchor is one consistent tuple: source, segment, locator");

refuses("an anchor whose segment belongs to one source but whose sourceId names another is refused",
  tablePacket, withAnchor({ sourceId: otherSourceId }), /combines a segment of one source with another source's id/);

refuses("a segment_locator anchor whose box lies outside the segment it names is refused",
  tablePacket, withAnchor({ locator: { bbox: [0, 0, 1, 1] } }), /lies outside the segment it names/);

refuses("an anchor whose box is not normalised 0..1 is refused",
  tablePacket, withAnchor({ locator: { bbox: [0.1, 0.1, 1.4, 0.5] } }), /box is not normalised 0\.\.1/);

refuses("an anchor whose time range runs backwards is refused",
  tablePacket, withAnchor({ locator: { start_ms: 9000, end_ms: 120 } }), /a time range runs forward from zero/);

refuses("an anchor naming a segment of the record that the packet did not hand over is refused",
  tablePacket, withAnchor({ sourceKind: "segment", segmentId: noteSegment.segmentId, sourceId: noteSegment.sourceId, locator: {} }),
  /which the packet did not hand over/);

refuses("an anchor naming a segment that is not in the record at all is refused",
  tablePacket, withAnchor({ sourceKind: "segment", segmentId: entityId("not-a-segment", "evidence-scope"), locator: {} }),
  /points at a segment that is not in the record/);

refuses("an anchor whose locator carries a URL is refused — an anchor names a place, never a way to fetch it",
  tablePacket, withAnchor({ locator: { ...clone(tableEnvelope).anchors[0].locator, retrieve: "https://example.invalid/row" } }),
  /locator carries a URL/);

refuses("a human_record anchor from a machine role is refused — a machine cites the source, never a person",
  tablePacket, withAnchor({ sourceKind: "human_record", segmentId: null, sourceId: null, locator: {} }),
  /a machine role cites the source, never a person/);

t.section("A. a claim with no anchor is not a claim, and a value says what it knows");

refuses("a claim that names no anchor is refused",
  tablePacket, withClaim({ anchorKeys: [] }), /has no anchor/);

refuses("a value that says it is unknown yet carries a quantity is refused — unknown is null, never a number",
  tablePacket, withValue({ known: false, quantity: 7, text: null }), /unknown is null, never a number/);

refuses("a value that says it is known yet carries neither quantity nor text is refused",
  tablePacket, withValue({ known: true, quantity: null, text: null }), /says it is known but carries no reading/);

refuses("a value reporting zero with no source text is refused — a zero is a measurement, and a measurement has a reading",
  tablePacket, withValue({ known: true, quantity: 0, text: null }), /a zero is a measurement/);

t.section("A. who may say a thing was observed, derived or reported");

refuses("a model role claiming its reading was derived is refused — a model observes or infers",
  tablePacket, withClaim({ observationBasis: "derived" }), /a model observes or infers/);

refuses("deterministic code claiming it observed the source is refused — only code derives",
  ingestPacket, (() => { const e = clone(ingestEnvelope); e.claims[0].observationBasis = "observed"; return e; })(),
  /from code must be derived/);

t.section("A. a discovered segment lies inside its parent, in a source the packet handed over");

/* A discoverer handed one region, so a segment it returns beneath that region
   must lie inside the region's own box — which is not the whole sheet. */
const regionRef = sourceReference({ sourceId: null, segmentId: tableSegment.segmentId }, lookup);
const subDiscoverPacket = { ...clone(discoverPacket), sources: [regionRef] };
const discovered = (over) => {
  const e = emptyEnvelope(subDiscoverPacket);
  e.segments.push({
    segmentKey: "child", sourceId: tableSegment.sourceId, parentSegmentId: tableSegment.segmentId, segmentKind: "row",
    label: "row 1", ordinal: 0, locator: { bbox: [0.1, 0.2, 0.5, 0.4] }, contentHash: "fx-child-of-a-table", ...over,
  });
  return e;
};

t.check("control: a discovered segment inside the parent the packet handed over passes the validator",
  validate(subDiscoverPacket, discovered({})).ok, validate(subDiscoverPacket, discovered({})).problems.join(" | "));

refuses("a discovered segment whose box lies outside its parent is refused",
  subDiscoverPacket, discovered({ locator: { bbox: [0, 0, 1, 1] } }), /lies outside its parent/);

refuses("a discovered segment of a source the packet did not hand over is refused",
  subDiscoverPacket, discovered({ sourceId: otherSourceId, parentSegmentId: null }), /belongs to a source the packet did not hand over/);

/* ══════════════════════════════════════════════════════════ part B */
t.section("B. the record refuses evidence it cannot place");

const B = world("evidence-scope/repository");
await B.scheduler.plan();
await B.scheduler.tick();
await B.scheduler.tick();
await B.repo.releaseDependents(B.wf);

const bSegments = await B.repo.listSegments(B.wf);
const bTable = bSegments.find((s) => s.segmentKind === "table");
const bOtherSource = B.truth.manifest.sources.find((s) => s.sourceId !== bTable.sourceId).sourceId;

const newSegment = (over) => ({
  segmentId: entityId("evidence-scope-segment", canonical(over)), workflowId: B.wf, sourceId: bTable.sourceId,
  parentSegmentId: bTable.segmentId, segmentKind: "row", label: "row 1", ordinal: 0,
  locator: { bbox: [0.1, 0.2, 0.5, 0.4] }, contentHash: "fx-b-child", status: "proposed",
  discoveredBy: "model", discoveredByAttemptId: null, ...over,
});

const insideParent = await B.repo.persistSegments(B.wf, [newSegment({})]);
t.check("control: the repository persists a segment that lies inside the parent it names",
  insideParent.created.length === 1 && insideParent.created[0].parentSegmentId === bTable.segmentId);

await t.refused("the repository refuses a segment whose box lies outside the parent it names",
  () => B.repo.persistSegments(B.wf, [newSegment({ locator: { bbox: [0, 0, 1, 1] }, contentHash: "fx-b-outside" })]));

await t.refused("the repository refuses a segment of a source this workflow does not read",
  () => B.repo.persistSegments(B.wf, [newSegment({ sourceId: entityId("not-a-source", "evidence-scope"), parentSegmentId: null, contentHash: "fx-b-foreign" })]));

/* A second workflow in the same record, so a segment of somewhere else exists. */
const elsewhere = syntheticRecordSet({ seed: "evidence-scope/elsewhere", sources: 1, sheetsPerSource: 1, entriesPerTable: 2 });
const { registry: elsewhereRegistry } = mockExecutors(elsewhere);
const E = assemble({ manifest: elsewhere.manifest, pack: new SyntheticRecordsPack(), executors: elsewhereRegistry, clock: manualClock(), repo: B.repo });
await E.scheduler.plan();
await E.scheduler.tick();
const foreignSegment = (await B.repo.listSegments(elsewhere.manifest.workflowId))[0];
t.check("a second workflow in the same record holds a segment of its own",
  !!foreignSegment && foreignSegment.workflowId === elsewhere.manifest.workflowId && foreignSegment.workflowId !== B.wf);

/* One reader of the first workflow, taken by hand up to the point where a
   result would be committed, so the repository's own anchor guards answer. */
const bReader = (await B.repo.listTasks(B.wf)).find((x) => x.taskType === TASK.readTable && x.state === "queued");
const leased = await B.repo.leaseTask(bReader.taskId, "evidence-scope-worker", 120_000, B.clock.now());
await B.repo.transitionTask(bReader.taskId, "leased", "running");
const bAttemptId = entityId("attempt", bReader.taskId, 1);
await B.repo.createAttempt({
  attemptId: bAttemptId, workflowId: B.wf, taskId: bReader.taskId, attemptNo: 1, roleKey: bReader.roleKey, roleVersion: bReader.roleVersion,
  executorKind: "model", executorFamily: "reader-family-one", independenceDomain: B.registry.domainOf("reader-family-one"),
  modelConfiguration: "reader-family-one/visual@2", state: "prepared", leaseToken: leased.leaseToken, packetFingerprint: "", packetBytes: 0,
  providerRequestId: null, modelReported: null, usage: {}, rawResult: null, rawResultHash: null, validationState: "pending",
  validationProblems: [], errorCode: null, errorMessage: null, reconciliationOutcome: null,
});
const bSubmitted = await B.repo.submitAttempt(bAttemptId, leased.leaseToken, B.clock.now());
t.check("the hand-driven reader reached a submitted attempt, so the commit below is the real path",
  bSubmitted.ok === true && bReader.independenceGroup !== null, bSubmitted.ok ? "submitted" : bSubmitted.reason);

const commitWithAnchor = (anchor) => ({
  workflowId: B.wf, taskId: bReader.taskId, attemptId: bAttemptId,
  attempt: { to: "succeeded", validationState: "valid", validationProblems: [], rawResult: { outcome: "completed" }, rawResultHash: sha256(canonical({ outcome: "completed" })), errorCode: null, errorMessage: null },
  task: { to: "completed", reason: null },
  segments: [], assessments: [], disagreements: [], claimTransitions: [], disagreementRounds: [], disagreementTransitions: [],
  decisions: [], children: [], dependencies: [], followUps: [], taskTransitions: [], audits: [], limits: LIMITS,
  claims: [{
    claimId: entityId("evidence-scope-claim", anchor.anchorId), workflowId: B.wf, taskId: bReader.taskId, attemptId: bAttemptId,
    independenceGroup: bReader.independenceGroup, independenceDomain: B.registry.domainOf("reader-family-one"),
    subjectType: "entry", subjectKey: "entry/E-001", predicate: "quantity", value: { known: true, quantity: 4, text: "4 kg" },
    unit: "kg", observationBasis: "observed", scope: {}, status: "proposed", machineConfidence: null, inputClaimIds: [],
    incompleteSourceAttempt: false, supersedesClaimId: null, anchors: [anchor],
  }],
});
const anchorAt = (over) => ({
  anchorId: entityId("evidence-scope-anchor", canonical(over)), sourceKind: "segment_locator", sourceId: null,
  segmentId: bTable.segmentId, locator: { bbox: [0.1, 0.2, 0.5, 0.4] }, quotedText: "E-001",
  anchorHash: sha256(canonical(over)), ...over,
});

await t.refused("a commit whose anchor names a segment of one source under another source's id is refused",
  () => B.repo.commitValidatedResult(commitWithAnchor(anchorAt({ sourceId: bOtherSource }))));

await t.refused("a commit whose anchor points at a segment of another workflow is refused",
  () => B.repo.commitValidatedResult(commitWithAnchor(anchorAt({ segmentId: foreignSegment.segmentId }))));

t.check("neither refused commit left a claim, an anchor or a finished task behind — a commit is all or nothing",
  (await B.repo.listClaims({ workflowId: B.wf, attemptIds: [bAttemptId] })).length === 0
  && (await B.repo.getTask(bReader.taskId)).state === "running"
  && (await B.repo.getAttempt(bAttemptId)).state === "submitted");

const goodCommit = await B.repo.commitValidatedResult(commitWithAnchor(anchorAt({})));
t.check("control: the same commit with an anchor inside the segment it names is written, anchor and all",
  goodCommit.claims.length === 1 && goodCommit.claims[0].anchorIds.length === 1
  && (await B.repo.listAnchors([goodCommit.claims[0].claimId]))[0].sourceId === bTable.sourceId,
  `${goodCommit.claims.length} claim(s)`);

/* ══════════════════════════════════════════════════════════ part C */
t.section("C. comparison compares everything material about a value");

const packNormalisers = { unit: (u) => A.pack.normaliseUnit(u), key: (k) => A.pack.normaliseKey(k) };
const READERS = ["reader-a", "reader-b"];
const WF = A.wf;
const SUBJECT = "sheet/0/0/region/0";

const reading = (id, group, over = {}) => ({
  claimId: entityId("evidence-scope-comparable", id), independenceGroup: group,
  subjectType: "entry", subjectKey: "entry/E-001", predicate: "quantity",
  value: { known: true, quantity: 12, text: "12 kg", attributes: { category: "beta" } },
  unit: "kg", observationBasis: "observed", scope: { segment: "table 1" }, ...over,
});
const compare = (claims, groups = READERS, n = packNormalisers) => compareClaims(WF, SUBJECT, claims, groups, n);
const kindsOf = (result) => result.disagreements.map((d) => d.kind).sort();

const identical = compare([reading("c-same-a", "reader-a"), reading("c-same-b", "reader-b")]);
t.check("control: two readings identical in every material respect agree, and nothing is disputed",
  identical.agreements.length === 1 && identical.disagreements.length === 0 && identical.agreements[0].groups.length === 2,
  `${identical.agreements.length} agreement(s), ${identical.disagreements.length} disagreement(s)`);

const attributesDiffer = compare([
  reading("c-attr-a", "reader-a"),
  reading("c-attr-b", "reader-b", { value: { known: true, quantity: 12, text: "12 kg", attributes: { category: "gamma" } } }),
]);
t.check("two readings equal in quantity but differing in a value attribute are a value disagreement, not an agreement",
  attributesDiffer.agreements.length === 0 && kindsOf(attributesDiffer).join(",") === "value"
  && attributesDiffer.disagreements[0].severity === "material",
  `${attributesDiffer.agreements.length} agreement(s), kinds ${kindsOf(attributesDiffer).join(",")}`);

const unitDiffers = compare([
  reading("c-unit-a", "reader-a"),
  reading("c-unit-b", "reader-b", { unit: "each" }),
]);
t.check("two readings equal in quantity but differing in unit are a unit disagreement",
  unitDiffers.agreements.length === 0 && kindsOf(unitDiffers).join(",") === "unit",
  `kinds ${kindsOf(unitDiffers).join(",")}`);

const basisDiffers = compare([
  reading("c-basis-a", "reader-a"),
  reading("c-basis-b", "reader-b", { observationBasis: "inferred" }),
]);
t.check("two readings identical in value but differing in observation basis are a basis disagreement",
  basisDiffers.agreements.length === 0 && kindsOf(basisDiffers).join(",") === "basis",
  `kinds ${kindsOf(basisDiffers).join(",")}`);
t.check("a basis disagreement is critical — one reader read the source, the other worked it out",
  basisDiffers.disagreements.length === 1 && basisDiffers.disagreements[0].severity === "critical",
  basisDiffers.disagreements[0]?.severity);

const scopeDiffers = compare([
  reading("c-scope-a", "reader-a"),
  reading("c-scope-b", "reader-b", { scope: { segment: "table 2" } }),
]);
t.check("two readings of different scope are not lined up at all — they take different signatures",
  scopeDiffers.agreements.length === 0 && scopeDiffers.singletons.length === 2,
  `${scopeDiffers.singletons.length} signature(s) seen once`);
t.check("each differently scoped reading is missing from the other's signature — two missing disagreements, one claim each",
  kindsOf(scopeDiffers).join(",") === "missing,missing" && scopeDiffers.disagreements.every((d) => d.claimIds.length === 1),
  `kinds ${kindsOf(scopeDiffers).join(",")}`);

const saidTwice = compare([reading("c-twice-1", "reader-a"), reading("c-twice-2", "reader-a")], ["reader-a"]);
t.check("one reader saying the same thing twice is one reader — it is not agreement",
  saidTwice.agreements.length === 0 && saidTwice.disagreements.length === 0,
  `${saidTwice.agreements.length} agreement(s)`);

const casing = compare([reading("c-case-a", "reader-a", { unit: "KG " }), reading("c-case-b", "reader-b", { unit: "kg" })]);
t.check("normalisation is casing and whitespace: a unit written \"KG \" and one written \"kg\" agree",
  casing.agreements.length === 1 && casing.disagreements.length === 0, `${casing.agreements.length} agreement(s)`);

const aliasPack = compare([reading("c-alias-a", "reader-a", { unit: "kilograms" }), reading("c-alias-b", "reader-b", { unit: "kg" })]);
t.check("a unit alias the pack declares — \"kilograms\" for \"kg\" — agrees through the pack's normaliser",
  aliasPack.agreements.length === 1 && aliasPack.disagreements.length === 0, `${aliasPack.agreements.length} agreement(s)`);

const aliasKernel = compare([reading("c-alias-a", "reader-a", { unit: "kilograms" }), reading("c-alias-b", "reader-b", { unit: "kg" })], READERS, DEFAULT_NORMALISERS);
t.check("that alias is the pack's knowledge, not the kernel's: the kernel's own normaliser calls it a unit disagreement",
  aliasKernel.agreements.length === 0 && kindsOf(aliasKernel).join(",") === "unit",
  `kinds ${kindsOf(aliasKernel).join(",")}`);

const differentUnits = compare([reading("c-each-a", "reader-a", { unit: "each" }), reading("c-each-b", "reader-b", { unit: "kg" })]);
t.check("normalisation is never semantic: \"each\" and \"kg\" do not agree, however they are written",
  differentUnits.agreements.length === 0 && kindsOf(differentUnits).join(",") === "unit",
  `kinds ${kindsOf(differentUnits).join(",")}`);

/* ══════════════════════════════════════════════════════════ part D */
t.section("D. a composer is handed one subject's evidence and nothing else");

const composerPackets = seen.filter((p) => p.roleKey === "decision_composer");
const acceptedClaims = (await A.repo.listClaims({ workflowId: A.wf, statuses: ["accepted"] }));
const categoryOf = (packet) => packet.subjectKey.replace(/^category\//, "").toLowerCase();
const attributeCategory = (claim) => (typeof claim.value?.attributes?.category === "string" ? claim.value.attributes.category.toLowerCase() : null);
const acceptedEntries = acceptedClaims.filter((c) => attributeCategory(c) !== null);
const categoriesAccepted = [...new Set(acceptedEntries.map(attributeCategory))].sort();

t.check("the finished run composed a decision for more than one category, from accepted entries of more than one category",
  composerPackets.length >= 2 && categoriesAccepted.length >= 2,
  `${composerPackets.length} composer packet(s); categories ${categoriesAccepted.join(", ")}`);

t.check("every claim in a composer's packet that names a category names the composer's own category",
  composerPackets.every((p) => {
    const carried = p.context.claims.filter((c) => attributeCategory(c) !== null);
    return carried.length > 0 && carried.every((c) => attributeCategory(c) === categoryOf(p));
  }),
  composerPackets.map((p) => `${categoryOf(p)}:[${[...new Set(p.context.claims.map(attributeCategory).filter(Boolean))].join("/")}]`).join(" "));

t.check("the inputs a composer's total names are in its packet, and each of them names that same category",
  composerPackets.every((p) => {
    const total = p.context.claims.find((c) => c.subjectKey === p.subjectKey);
    if (!total || total.inputRefs.length === 0) return false;
    return total.inputRefs.every((ref) => {
      const input = p.context.claims.find((c) => c.ref === ref);
      return input && attributeCategory(input) === categoryOf(p);
    });
  }),
  composerPackets.map((p) => `${categoryOf(p)}:${p.context.claims.find((c) => c.subjectKey === p.subjectKey)?.inputRefs.length ?? 0} inputs`).join(" "));

const foreignFor = (p) => acceptedEntries.filter((c) => attributeCategory(c) !== categoryOf(p));
t.check("no accepted claim of another category is in a composer's packet",
  composerPackets.every((p) => {
    const foreign = foreignFor(p);
    return foreign.length > 0 && foreign.every((c) => !p.context.claims.some((x) => x.ref === c.claimId));
  }),
  composerPackets.map((p) => `${categoryOf(p)}: ${foreignFor(p).length} foreign accepted claim(s) withheld`).join("; "));

/* The dependency list of a composer names the tasks it waited for and the
   claim ids those tasks produced. What another subject's evidence *says* —
   its subject, its reading, the words quoted from the source — travels with
   none of them, and the validator's citable set is the packet's own claims,
   which the refusal below proves. */
const foreignAnchors = await A.repo.listAnchors(acceptedEntries.map((c) => c.claimId));
t.check("nothing another category's evidence says travels with the packet: not the entry it is about, not the words quoted from its source",
  composerPackets.every((p) => {
    const text = JSON.stringify(p);
    const foreign = foreignFor(p);
    const words = [
      ...foreign.map((c) => c.subjectKey),
      ...foreignAnchors.filter((a) => foreign.some((c) => c.claimId === a.claimId)).map((a) => a.quotedText).filter(Boolean),
    ];
    return words.length >= foreign.length * 2 && words.every((w) => !text.includes(w));
  }),
  composerPackets.map((p) => `${categoryOf(p)}: ${foreignFor(p).map((c) => c.subjectKey).join("/")} withheld`).join("; "));

t.section("D. a composer that reaches into another subject is refused, and what it said is kept");

const FABRICATED = entityId("a-claim-of-another-subject", "evidence-scope");
const citeForeign = (packet, base) => {
  if (packet.roleKey !== "decision_composer" || base.decisions.length === 0) return base;
  const out = clone(base);
  out.decisions[0].supportingClaimIds = [...out.decisions[0].supportingClaimIds, FABRICATED];
  return out;
};

const D = world("evidence-scope/records", { scripts: { "arbiter-family-one": citeForeign } });
await D.scheduler.plan();
const dReport = await D.scheduler.runUntilQuiescent();
const composeTasks = (await D.repo.listTasks(D.wf)).filter((x) => x.phase === "compose");
const composeAttempts = (await Promise.all(composeTasks.map((x) => D.repo.listAttempts(x.taskId)))).flat();

t.check("the fabricated id is a well-formed version-5 uuid the record does not hold — it fails on scope, not on shape",
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(FABRICATED)
  && (await D.repo.getClaim(FABRICATED)) === null, FABRICATED);

t.check("every compose task ran and every one of them ends failed_known",
  composeTasks.length >= 2 && composeTasks.every((x) => x.state === "failed_known"),
  composeTasks.map((x) => `${x.subjectKey}:${x.state}`).join(", "));

t.check("each compose task's terminal reason is the invalid envelope, naming the citation it could not place",
  composeTasks.every((x) => /^invalid_envelope/.test(x.terminalReason ?? "") && x.terminalReason.includes(FABRICATED)),
  composeTasks.map((x) => x.terminalReason).join(" | ").slice(0, 160));

t.check("the validator's problem says the composer creates no fact and reaches into no other subject",
  composeAttempts.length >= 2 && composeAttempts.every((a) => a.validationProblems.some((p) => /reaches into no other subject/.test(p))),
  composeAttempts.map((a) => a.validationProblems.join("; ")).join(" | ").slice(0, 200));

t.check("every compose attempt is marked validationState invalid",
  composeAttempts.every((a) => a.validationState === "invalid"),
  [...new Set(composeAttempts.map((a) => a.validationState))].join(", "));

t.check("the attempt keeps the envelope exactly as the composer returned it, fabricated citation and all",
  composeAttempts.every((a) => a.rawResult && a.rawResult.decisions?.[0]?.supportingClaimIds?.includes(FABRICATED)),
  composeAttempts.map((a) => JSON.stringify(a.rawResult?.decisions?.[0]?.supportingClaimIds ?? null)).join(" ").slice(0, 160));

t.check("the stored hash is over that raw value, not over a copy the kernel tidied",
  composeAttempts.every((a) => a.rawResultHash === sha256(canonical(a.rawResult))));

t.check("nothing of the refused answer entered the record — no decision was written by any compose task",
  (await D.repo.listDecisions(D.wf)).every((d) => !composeTasks.some((x) => x.taskId === d.taskId)),
  `${(await D.repo.listDecisions(D.wf)).length} decision(s) on record, none from a composer`);

t.check("the workflow ends partial: its evidence stands, its decisions do not",
  dReport.workflow.state === "partial", dReport.workflow.state);

t.section("D. the same refusal when the claim is real and the composer's own dependencies name it");

/* A claim of another category that this composer's dependency list does name,
   and that the record really holds — so the refusal is about scope, not about
   an id nobody has heard of. */
const realForeign = new Map(composerPackets.map((p) => {
  const foreign = foreignFor(p).find((c) => p.dependencies.some((d) => d.claimIds.includes(c.claimId)));
  return [p.subjectKey, foreign ?? null];
}));
t.check("every composer's dependency list names at least one accepted claim of another category — a bare id, never its evidence",
  composerPackets.length > 0 && composerPackets.every((p) => realForeign.get(p.subjectKey) !== null),
  [...realForeign].map(([k, v]) => `${k}→${v ? v.subjectKey : "none"}`).join(", "));

const citeReal = (packet, base) => {
  const foreign = realForeign.get(packet.subjectKey);
  if (packet.roleKey !== "decision_composer" || base.decisions.length === 0 || !foreign) return base;
  const out = clone(base);
  out.decisions[0].supportingClaimIds = [...out.decisions[0].supportingClaimIds, foreign.claimId];
  return out;
};

const R = world("evidence-scope/records", { scripts: { "arbiter-family-one": citeReal } });
await R.scheduler.plan();
await R.scheduler.runUntilQuiescent();
const rComposeTasks = (await R.repo.listTasks(R.wf)).filter((x) => x.phase === "compose");
const rComposeAttempts = (await Promise.all(rComposeTasks.map((x) => R.repo.listAttempts(x.taskId)))).flat();

t.check("the run names the same claims as the first, so the claim each composer cited is one this record holds",
  rComposeTasks.length === composeTasks.length
  && (await Promise.all([...realForeign.values()].map((c) => R.repo.getClaim(c.claimId)))).every((c) => c && c.status === "accepted"),
  `${rComposeTasks.length} compose task(s)`);

t.check("a composer citing a real accepted claim of another subject is refused just the same, and every compose task ends failed_known",
  rComposeTasks.length >= 2 && rComposeTasks.every((x) => x.state === "failed_known")
  && rComposeAttempts.every((a) => a.validationState === "invalid" && a.validationProblems.some((p) => /reaches into no other subject/.test(p))),
  rComposeTasks.map((x) => `${x.subjectKey}:${x.state}`).join(", "));

t.check("the refusal names the very claim it reached for, and no decision of any composer entered the record",
  rComposeTasks.every((x) => x.terminalReason?.includes(realForeign.get(x.subjectKey).claimId))
  && (await R.repo.listDecisions(R.wf)).every((d) => !rComposeTasks.some((x) => x.taskId === d.taskId)),
  rComposeTasks.map((x) => x.terminalReason).join(" | ").slice(0, 160));

/* ═════════════════════════════════════════════════════ the closed door */
t.section("every door stayed closed");
t.check("nothing in this file tried the network", tripped() === 0, `${tripped()} attempts`);

t.finish();
