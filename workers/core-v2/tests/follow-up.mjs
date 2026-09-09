/* AN AGENT ASKS; THE ORCHESTRATOR DECIDES.
 *
 * kernel/follow-up-planner.ts: a requested action arrives in an envelope and
 * becomes at most one bounded child task — or a refusal, or a person. The
 * rules do not bend for a persuasive request: the role must be allowed to ask
 * for that action; the request must name its own parent; every child is one
 * deeper than its parent and past the depth limit the answer is a person; a
 * parent may have only so many children; the same work twice is the same
 * task; the target must be a segment of the record, related to what the
 * parent was reading, of the kind the action requires, and accepted; an
 * independent reader is a new group; a request for human review creates no
 * task at all.
 *
 * And through the scheduler (docs/core-v2.md §4, §6): a verifier that cannot
 * read the source gets exactly one more round or a person; an arbiter that
 * asks twice for the same evidence gets a person; children of a dispute carry
 * it; and once the dispute is settled or held, nothing more is asked by
 * machine — the request is refused with an audit.
 *
 * Everything runs in memory on the synthetic records pack with scripted
 * executors, against real repository state: a records workflow is run to a
 * real disagreement first, so the tasks, segments, claims and disputes the
 * requests name are the ones the engine itself made. The network is closed
 * before the engine is used. No sleeps: the clock is manual and the scheduler
 * is ticked by hand.
 */
import { harness, closeNetwork } from "./harness.mjs";
import { syntheticRecordSet } from "../domains/synthetic-records/fixture.ts";
import { ROLES, SyntheticRecordsPack, TASK } from "../domains/synthetic-records/pack.ts";
import { mockExecutors } from "../domains/synthetic-records/mocks.ts";
import { assemble, manualClock } from "../domains/simulate.ts";
import { KERNEL_TASK_TYPES } from "../kernel/contracts.ts";
import { INDEPENDENCE_GROUPS } from "../kernel/domain.ts";
import { planFollowUps } from "../kernel/follow-up-planner.ts";
import { entityId } from "../kernel/ids.ts";
import { lookupOf, segmentIdFor } from "../kernel/planning.ts";
import { DEFAULT_POLICY, policyWith } from "../kernel/policy.ts";
import { RoleRegistry } from "../kernel/roles.ts";

const tripped = closeNetwork();
const t = harness("an agent asks; the orchestrator decides");

/* ───────────────────────────────────────────────────────────── helpers */

const [READER_A, READER_B, READER_C] = INDEPENDENCE_GROUPS;
const DISPUTED_ENTRY = "entry/E-001";
const every = (xs, f) => xs.length > 0 && xs.every(f);
const reasons = (xs) => xs.map((x) => x.reason).join(" | ");

/* One record set, scripted executors, an in-memory repository, a clock the
   test moves by hand. The second blind reader misreads one entry, so every
   world here reaches a real disagreement with a real verifier and arbiter. */
function world(options = {}) {
  const truth = syntheticRecordSet({ seed: options.seed ?? "follow-up/records", sources: 1, sheetsPerSource: 2, entriesPerTable: 3 });
  const scripts = { "reader-family-two": misreadsOneEntry, ...(options.scripts ?? {}) };
  const { registry, executors } = mockExecutors(truth, { scripts });
  const parts = assemble({ manifest: truth.manifest, pack: new SyntheticRecordsPack(), executors: registry, policy: options.policy, clock: manualClock() });
  return { truth, wf: truth.manifest.workflowId, registry, executors, ...parts };
}

/* The second reader of the tables reads one quantity wrong; everything else
   it reads, it reads correctly. */
function misreadsOneEntry(packet, base) {
  if (packet.roleKey !== "table_reader") return base;
  for (const c of base.claims) {
    if (c.subjectKey === DISPUTED_ENTRY) c.value = { ...c.value, quantity: c.value.quantity + 7, text: `${c.value.quantity + 7} ${c.unit}` };
  }
  return base;
}

/* Tick by hand until nothing moves. */
async function drive(w, maxTicks = 80) {
  for (let i = 0; i < maxTicks; i++) {
    const r = await w.scheduler.tick();
    if (r.dispatched.length === 0 && r.released === 0 && r.stopped === 0 && r.reconciled === 0 && w.scheduler.inFlight.size === 0) break;
  }
  const report = await w.scheduler.runUntilQuiescent();
  const claims = await w.repo.listClaims({ workflowId: w.wf });
  return {
    report, claims,
    tasks: await w.repo.listTasks(w.wf),
    segments: await w.repo.listSegments(w.wf),
    disagreements: await w.repo.listDisagreements(w.wf),
    decisions: await w.repo.listDecisions(w.wf),
    audit: await w.repo.listAudit(),
  };
}

/* A requested action, as an envelope carries one. */
function ask(parent, actionType, extra = {}) {
  return {
    actionType,
    reasonCode: extra.reasonCode ?? "the packet did not settle it",
    targetSegmentIds: extra.targetSegmentIds ?? [],
    expectedInformation: "what the named place shows",
    parentTaskId: extra.parentTaskId ?? parent.taskId,
    currentDepth: parent.depth,
    idempotencyFingerprint: extra.idempotencyFingerprint ?? `ask-${actionType}-${(extra.targetSegmentIds ?? []).join(",")}-${extra.claimRef ?? ""}`,
    claimRef: extra.claimRef,
  };
}

/* The same shape, from inside a scripted executor, which knows its packet
   and nothing else. */
function askFromPacket(packet, actionType, segmentId, fingerprint) {
  return {
    actionType, reasonCode: "the disputed row runs past the edge of what was supplied",
    targetSegmentIds: segmentId ? [segmentId] : [], expectedInformation: "the whole row, and what sits beside it",
    parentTaskId: packet.taskId, currentDepth: packet.context.depth, idempotencyFingerprint: fingerprint,
  };
}

const limitsOf = (policy) => ({
  maximumTasks: policy.maximumTasksPerWorkflow, maximumEdges: policy.maximumDependencyEdgesPerWorkflow,
  maximumChildrenPerParent: policy.maximumChildTasksPerParent, maximumDepth: policy.maximumFollowUpDepth,
});

const childrenOf = (tasks, parent) => tasks.filter((x) => x.parentTaskId === parent.taskId);
const auditsFor = (audit, action, taskId) => audit.filter((a) => a.action === action && (!taskId || a.entityId === taskId));
const holdOf = (decisions, disagreementId) => decisions.find((d) => d.disagreementId === disagreementId && d.decisionType === "hold");

/* ═════════════════════════════════ the world every planning check asks about */
t.section("(0) a real records workflow, run to a real disagreement");

const base = world();
await base.scheduler.plan();
const ran = await drive(base);

const sheets = ran.segments.filter((s) => s.segmentKind === "sheet").sort((a, b) => a.ordinal - b.ordinal);
const regionsOf = (sheet) => ran.segments.filter((s) => s.parentSegmentId === sheet.segmentId);
const table1 = regionsOf(sheets[0]).find((s) => s.segmentKind === "table");
const note1 = regionsOf(sheets[0]).find((s) => s.segmentKind === "note");
const table2 = regionsOf(sheets[1]).find((s) => s.segmentKind === "table");

const readerA = ran.tasks.find((x) => x.taskType === TASK.readTable && x.independenceGroup === READER_A && x.sources.some((s) => s.segmentId === table1.segmentId));
const readerB = ran.tasks.find((x) => x.taskType === TASK.readTable && x.independenceGroup === READER_B && x.sources.some((s) => s.segmentId === table1.segmentId));
const noteReader = ran.tasks.find((x) => x.taskType === TASK.readNote && x.independenceGroup === READER_A && x.sources.some((s) => s.segmentId === note1.segmentId));
const critic = ran.tasks.find((x) => x.taskType === KERNEL_TASK_TYPES.verifyClaim && x.sources.some((s) => s.segmentId === table1.segmentId));
const noteCritic = ran.tasks.find((x) => x.taskType === KERNEL_TASK_TYPES.verifyClaim && x.sources.some((s) => s.segmentId === note1.segmentId));
const verifier = ran.tasks.find((x) => x.taskType === KERNEL_TASK_TYPES.verifyDisagreement);
const arbiter = ran.tasks.find((x) => x.taskType === KERNEL_TASK_TYPES.adjudicate);
const dispute = ran.disagreements.find((d) => d.kind === "value");

t.check("the record holds two sheets, each with a table and a note the engine's own discoverer found",
  sheets.length === 2 && table1 && note1 && table2 && table1.status === "accepted" && note1.status === "accepted",
  `${sheets.length} sheets; ${ran.segments.length} segments`);

t.check("the two blind readers of the first table disagree about one entry, and the kernel opened a disagreement over it",
  dispute !== undefined && dispute.claimIds.length === 2
  && ran.claims.filter((c) => c.subjectKey === DISPUTED_ENTRY && c.predicate === "quantity" && c.independenceGroup !== null).length === 2,
  dispute ? `${dispute.kind}/${dispute.state}` : "no disagreement");

t.check("the disagreement made a verifier and an arbiter, and the corroborated readings of that table made a critic",
  verifier !== undefined && arbiter !== undefined && critic !== undefined && noteCritic !== undefined
  && verifier.disagreementId === dispute.disagreementId && arbiter.disagreementId === dispute.disagreementId);

t.check("the parents these checks ask on behalf of are the tasks the engine itself planned: two blind readers at depth 0, a critic and a verifier at depth 1",
  readerA.depth === 0 && readerB.depth === 0 && critic.depth === 1 && verifier.depth === 1 && arbiter.depth === 1,
  `reader ${readerA.depth}, critic ${critic.depth}, verifier ${verifier.depth}, arbiter ${arbiter.depth}`);

/* A note nobody accepted, persisted the way any proposed segment is, so
   "the target must be accepted" is asked of a real record and not of a
   fabricated one. */
const unacceptedNoteId = segmentIdFor(base.wf, sheets[0].sourceId, sheets[0].segmentId, "note", "fx-note-not-accepted");
await base.repo.persistSegments(base.wf, [{
  segmentId: unacceptedNoteId, workflowId: base.wf, sourceId: sheets[0].sourceId, parentSegmentId: sheets[0].segmentId,
  segmentKind: "note", label: "a note the record has not accepted", ordinal: 7, locator: { bbox: [0.1, 0.1, 0.2, 0.2] },
  contentHash: "fx-note-not-accepted", status: "proposed", discoveredBy: "model", discoveredByAttemptId: null,
}]);
const segmentsNow = await base.repo.listSegments(base.wf);
const unacceptedNote = segmentsNow.find((s) => s.segmentId === unacceptedNoteId);

t.check("the record also holds one note that is only proposed — a segment the engine has not accepted",
  unacceptedNote !== undefined && unacceptedNote.status === "proposed" && unacceptedNote.parentSegmentId === sheets[0].segmentId);

/* A pack whose table reader is permitted to ask for a unit check and for a
   critic. The kernel's own roles are not the test's to rewrite; what a pack
   lets its analysts ask for is the pack's own business, and the planner's
   rule — only what the role allows — is what is under test either way. */
const askingPack = new SyntheticRecordsPack();
askingPack.roles = ROLES.map((r) => (r.roleKey === "table_reader" ? { ...r, allowedActions: [...r.allowedActions, "check_unit", "request_evidence_critic"] } : r));
const registry = new RoleRegistry(askingPack);
const lookup = lookupOf(base.truth.manifest, segmentsNow);
const ctx = (policy = DEFAULT_POLICY) => ({ repo: base.repo, lookup, registry, pack: askingPack, policy });

/* ═════════════════════════════════════ (1) only what the role may ask for */
t.section("(1) a role may ask only for the actions its role allows");
{
  const refusedExpand = await planFollowUps(readerA, [ask(readerA, "expand_segment", { targetSegmentIds: [table1.segmentId] })], ctx());
  t.check("a table reader asking to expand a segment is refused — expanding is not among its allowed actions",
    refusedExpand.children.length === 0 && refusedExpand.refused.length === 1 && refusedExpand.refused[0].reason.includes("table_reader may not ask for expand_segment"),
    reasons(refusedExpand.refused));

  const allowedReference = await planFollowUps(readerA, [ask(readerA, "read_reference_segment", { targetSegmentIds: [note1.segmentId] })], ctx());
  t.check("the same reader asking for the reference note on its own sheet — an action it does allow — is given one child",
    allowedReference.children.length === 1 && allowedReference.refused.length === 0 && allowedReference.escalations.length === 0,
    reasons([...allowedReference.refused, ...allowedReference.escalations]));

  const noteAsks = await planFollowUps(noteReader, [ask(noteReader, "read_reference_segment", { targetSegmentIds: [note1.segmentId] })], ctx());
  t.check("a note reader asking for the very same reference segment is refused — its role may ask for a person and nothing else",
    noteAsks.children.length === 0 && noteAsks.refused.length === 1 && noteAsks.refused[0].reason.includes("note_reader may not ask for read_reference_segment"),
    reasons(noteAsks.refused));

  const criticChecksUnit = await planFollowUps(critic, [ask(critic, "check_unit", { claimRef: ran.claims[0].claimId })], ctx());
  t.check("a critic asking for a unit check is refused — a critic reopens sources, it does not commission checks",
    criticChecksUnit.children.length === 0 && criticChecksUnit.refused[0].reason.includes("evidence_critic may not ask for check_unit"),
    reasons(criticChecksUnit.refused));

  const arbiterReads = await planFollowUps(arbiter, [ask(arbiter, "read_related_segment", { targetSegmentIds: [table1.segmentId] })], ctx());
  t.check("an arbiter asking to read a related segment itself is refused — it may ask for a verification or for a person",
    arbiterReads.children.length === 0 && arbiterReads.refused[0].reason.includes("evidence_arbiter may not ask for read_related_segment"),
    reasons(arbiterReads.refused));

  const verifierReads = await planFollowUps(verifier, [ask(verifier, "read_related_segment", { targetSegmentIds: [table1.segmentId] })], ctx());
  t.check("a verifier asking for the same related segment is given a child — read_related_segment is in the verifier's list and not in the arbiter's",
    verifierReads.children.length === 1 && verifierReads.refused.length === 0,
    reasons(verifierReads.refused));
}

/* ══════════════════════════════════ (2) a request names its own parent */
t.section("(2) a request may only be made on behalf of the task that is answering");
{
  const wrongParent = await planFollowUps(critic, [ask(critic, "read_reference_segment", { targetSegmentIds: [note1.segmentId], parentTaskId: noteCritic.taskId })], ctx());
  t.check("a request naming a different task as its parent is refused, whatever else is right about it",
    wrongParent.children.length === 0 && wrongParent.refused.length === 1 && wrongParent.refused[0].reason === "request names a different parent",
    reasons(wrongParent.refused));

  const ownParent = await planFollowUps(critic, [ask(critic, "read_reference_segment", { targetSegmentIds: [note1.segmentId] })], ctx());
  t.check("the identical request naming its own task is given a child — the parent id is what the refusal turned on",
    ownParent.children.length === 1 && ownParent.children[0].parentTaskId === critic.taskId);
}

/* ═══════════════════════════════════════ (3) a person is not a child task */
t.section("(3) a request for human review makes no task at all");
{
  const plan = await planFollowUps(readerA, [ask(readerA, "request_human_review", { reasonCode: "the printed quantity is struck through and rewritten by hand" })], ctx());
  t.check("a request for human review creates no child and no refusal — it escalates",
    plan.children.length === 0 && plan.refused.length === 0 && plan.escalations.length === 1);

  t.check("the escalation carries the reason the agent gave, so the person who picks it up is told why",
    plan.escalations[0].reason === "the printed quantity is struck through and rewritten by hand",
    plan.escalations[0].reason);

  const anonymous = await planFollowUps(readerA, [ask(readerA, "request_human_review", { reasonCode: "" })], ctx());
  t.check("a request for a person with no reason still escalates, under the kernel's own wording",
    anonymous.escalations.length === 1 && anonymous.escalations[0].reason === "agent asked for a person" && anonymous.children.length === 0,
    anonymous.escalations[0]?.reason);
}

/* ════════════════════════════ (4) the target: a segment, related, of the
                                    right kind, and accepted */
t.section("(4) the target must be a segment of this record, related to what the parent read, of the kind the action names, and accepted");
{
  const notASegment = await planFollowUps(critic, [ask(critic, "read_reference_segment", { targetSegmentIds: [entityId("segment", "nowhere")] })], ctx());
  t.check("a target the record does not hold is refused — the planner resolves every id against the persisted segments",
    notASegment.children.length === 0 && notASegment.refused[0].reason === "target is not a segment of the record",
    reasons(notASegment.refused));

  const noTarget = await planFollowUps(critic, [ask(critic, "read_reference_segment", { targetSegmentIds: [] })], ctx());
  t.check("a read request naming no target at all is refused the same way — an unbounded read is not a bounded assignment",
    noTarget.children.length === 0 && noTarget.refused[0].reason === "target is not a segment of the record",
    reasons(noTarget.refused));

  const otherSheet = await planFollowUps(critic, [ask(critic, "expand_segment", { targetSegmentIds: [table2.segmentId] })], ctx());
  t.check("the table on the other sheet is refused, though the identical request for its own table is admitted in (5) — the pack says related means the parent's own segment, its parent, or a sibling under it",
    otherSheet.children.length === 0 && otherSheet.refused[0].reason === "target segment is not related to what this task was reading",
    reasons(otherSheet.refused));

  const verifierOtherSheet = await planFollowUps(verifier, [ask(verifier, "read_related_segment", { targetSegmentIds: [table2.segmentId] })], ctx());
  t.check("a verifier asking to read that other sheet's table as a related one is refused too, though reading its own table as related was admitted — relatedness is the pack's rule, not the role's",
    verifierOtherSheet.children.length === 0 && verifierOtherSheet.refused[0].reason === "target segment is not related to what this task was reading",
    reasons(verifierOtherSheet.refused));

  const referenceIsANote = await planFollowUps(critic, [ask(critic, "read_reference_segment", { targetSegmentIds: [note1.segmentId] })], ctx());
  t.check("read_reference_segment naming the note beside the table is admitted — in this pack a note is reference material",
    referenceIsANote.children.length === 1 && referenceIsANote.refused.length === 0);

  const referenceIsNotATable = await planFollowUps(critic, [ask(critic, "read_reference_segment", { targetSegmentIds: [table1.segmentId] })], ctx());
  t.check("read_reference_segment naming a table is refused, though the table is related — a table is not reference material in this pack",
    referenceIsNotATable.children.length === 0 && referenceIsNotATable.refused[0].reason === "read_reference_segment must name reference material",
    reasons(referenceIsNotATable.refused));

  const linked = await planFollowUps(critic, [ask(critic, "open_linked_segment", { targetSegmentIds: [note1.segmentId] })], ctx());
  t.check("open_linked_segment naming the note the table links to is admitted",
    linked.children.length === 1 && linked.refused.length === 0);

  const notLinked = await planFollowUps(critic, [ask(critic, "open_linked_segment", { targetSegmentIds: [sheets[0].segmentId] })], ctx());
  t.check("open_linked_segment naming the sheet the table sits on is refused — the sheet is related, and the table does not link to it",
    notLinked.children.length === 0 && notLinked.refused[0].reason === "open_linked_segment must name a segment the parent's segments link to",
    reasons(notLinked.refused));

  const fromANote = await planFollowUps(noteCritic, [ask(noteCritic, "open_linked_segment", { targetSegmentIds: [table1.segmentId] })], ctx());
  t.check("a task reading the note may not open the table by the same route — in this pack a note links to nothing",
    fromANote.children.length === 0 && fromANote.refused[0].reason === "open_linked_segment must name a segment the parent's segments link to",
    reasons(fromANote.refused));

  const notAccepted = await planFollowUps(critic, [ask(critic, "read_reference_segment", { targetSegmentIds: [unacceptedNoteId] })], ctx());
  t.check("a note that is reference material, related and merely proposed is still refused — unaccepted segments are not read",
    notAccepted.children.length === 0 && notAccepted.refused[0].reason === "target segment is not accepted",
    reasons(notAccepted.refused));
}

/* ═══════════════════════════════════════════════ (5) the child that results */
t.section("(5) the child is one deeper than its parent, and a read keeps the parent's phase and work");
{
  const plan = await planFollowUps(critic, [ask(critic, "read_reference_segment", { targetSegmentIds: [note1.segmentId] })], ctx());
  const child = plan.children[0];

  t.check("the child is exactly one deeper than its parent",
    child.depth === critic.depth + 1, `${critic.depth} → ${child.depth}`);

  t.check("a read keeps the parent's phase and task type: the critic's follow-up is another verification, not a new kind of work",
    child.phase === critic.phase && child.taskType === critic.taskType && child.roleKey === critic.roleKey,
    `${child.phase}/${child.taskType}/${child.roleKey}`);

  t.check("the child names its parent both as parent and as the task that created it",
    child.parentTaskId === critic.taskId && child.createdByTaskId === critic.taskId);

  t.check("the child reads exactly the segment that was asked for, and nothing else",
    child.sources.length === 1 && child.sources[0].segmentId === note1.segmentId && child.sources[0].sourceId === null);

  t.check("the child's subject names the place it reads, so two agents asking for that place ask for one task",
    child.subjectKey === `${note1.sourceId}/${note1.segmentId}`, child.subjectKey);

  t.check("the child is ranked behind its parent and carries the parent's dispute and rounds",
    child.priority === critic.priority + 1 && child.disagreementId === critic.disagreementId
    && child.criticRound === critic.criticRound && child.arbiterRound === critic.arbiterRound);

  t.check("the child carries no independence group — a follow-up read is not a blind reading of the subject",
    child.independenceGroup === null);

  const expanded = await planFollowUps(critic, [ask(critic, "expand_segment", { targetSegmentIds: [table1.segmentId] })], ctx());
  t.check("expanding a segment asks for the same place read wider, and says so in the subject — it is not the same task as reading it",
    expanded.children.length === 1 && expanded.children[0].subjectKey === `${table1.sourceId}/${table1.segmentId}/expanded`
    && expanded.children[0].taskId !== child.taskId,
    expanded.children[0]?.subjectKey);
}

/* ═════════════════════════════════════ (6) the same work asked twice */
t.section("(6) two agents asking for the same work ask for one task, and asking twice is one task");
{
  const twice = await planFollowUps(critic, [
    ask(critic, "read_reference_segment", { targetSegmentIds: [note1.segmentId], idempotencyFingerprint: "one" }),
    ask(critic, "read_reference_segment", { targetSegmentIds: [note1.segmentId], idempotencyFingerprint: "two" }),
  ], ctx());

  t.check("two identical requests in one envelope make one child, whatever fingerprints the agent put on them",
    twice.children.length === 1 && twice.refused.length === 1,
    `${twice.children.length} children, ${twice.refused.length} refused`);

  t.check("the second is refused in those words — the same follow-up was asked for twice in one envelope",
    twice.refused[0].reason === "the same follow-up was asked for twice in one envelope", reasons(twice.refused));

  const later = await planFollowUps(critic, [ask(critic, "read_reference_segment", { targetSegmentIds: [note1.segmentId], idempotencyFingerprint: "a fingerprint from another envelope" })], ctx());
  t.check("the same request in a later envelope names the same task id — identity is the work, not who asked or when",
    later.children.length === 1 && later.children[0].taskId === twice.children[0].taskId
    && later.children[0].inputFingerprint === twice.children[0].inputFingerprint);

  const first = await base.repo.admitTasks(base.wf, [twice.children[0]], limitsOf(DEFAULT_POLICY));
  const again = await base.repo.admitTasks(base.wf, [later.children[0]], limitsOf(DEFAULT_POLICY));
  t.check("the record admits it once and reuses it the second time — asking again creates nothing",
    first.created.length === 1 && first.reused.length === 0 && again.created.length === 0 && again.reused.length === 1
    && again.reused[0].taskId === first.created[0].taskId,
    `${first.created.length}/${first.reused.length} then ${again.created.length}/${again.reused.length}`);
}

/* ══════════════════════════════════════════════════════ (7) the ceilings */
t.section("(7) past the depth limit, and past the follow-ups one parent may have, the answer is a person");
{
  const atLimit = policyWith({ maximumFollowUpDepth: 1 });
  const escalated = await planFollowUps(critic, [ask(critic, "read_reference_segment", { targetSegmentIds: [note1.segmentId] })], ctx(atLimit));
  t.check("a task at the depth limit is given no child for a read it would otherwise be given",
    escalated.children.length === 0 && escalated.escalations.length === 1 && escalated.refused.length === 0);

  t.check("the escalation says the depth is the reason and that it goes to a person",
    escalated.escalations[0].reason.includes("at depth 1 nothing more is asked by machine")
    && escalated.escalations[0].reason.includes("goes to a person"),
    escalated.escalations[0].reason);

  const belowLimit = await planFollowUps(critic, [ask(critic, "read_reference_segment", { targetSegmentIds: [note1.segmentId] })], ctx(policyWith({ maximumFollowUpDepth: 2 })));
  t.check("one deeper limit and the identical request is a child again — the depth is what refused it, not the request",
    belowLimit.children.length === 1 && belowLimit.escalations.length === 0);

  const noMachineFollowUps = policyWith({ maximumFollowUpDepth: 0 });
  const stillAPerson = await planFollowUps(readerA, [
    ask(readerA, "read_reference_segment", { targetSegmentIds: [note1.segmentId] }),
    ask(readerA, "request_human_review", { reasonCode: "the sheet is torn across the row" }),
  ], ctx(noMachineFollowUps));
  t.check("at the limit every request goes to a person, and a request for a person is still a person and never a child",
    stillAPerson.children.length === 0 && stillAPerson.escalations.length === 2
    && stillAPerson.escalations[0].reason.includes("goes to a person")
    && stillAPerson.escalations[1].reason === "the sheet is torn across the row",
    stillAPerson.escalations.map((e) => e.reason).join(" | "));

  const oneChildOnly = policyWith({ maximumChildTasksPerParent: 1 });
  const budget = await planFollowUps(readerA, [
    ask(readerA, "read_reference_segment", { targetSegmentIds: [note1.segmentId] }),
    ask(readerA, "check_unit", { claimRef: ran.claims.find((c) => c.taskId === readerA.taskId).claimId }),
  ], ctx(oneChildOnly));
  t.check("a parent allowed one follow-up gets one child; the second request escalates rather than quietly disappearing",
    budget.children.length === 1 && budget.escalations.length === 1 && budget.refused.length === 0);

  t.check("the escalation names the parent and the number of follow-ups it has used",
    budget.escalations[0].reason.includes(readerA.taskId) && budget.escalations[0].reason.includes("has used its 1 follow-ups"),
    budget.escalations[0].reason);

  /* The critic already has one child in the record, admitted in (6). */
  const spent = await planFollowUps(critic, [ask(critic, "expand_segment", { targetSegmentIds: [table1.segmentId] })], ctx(oneChildOnly));
  t.check("the children a parent already has in the record count against its budget — a restart does not refill it",
    childrenOf(await base.repo.listTasks(base.wf), critic).length === 1
    && spent.children.length === 0 && spent.escalations.length === 1 && spent.escalations[0].reason.includes("has used its 1 follow-ups"),
    spent.escalations[0]?.reason);
}

/* ═══════════════════════════════════ (8) asking about a claim */
t.section("(8) a check on a claim may only name a claim this task produced or was handed");
{
  const mine = ran.claims.find((c) => c.taskId === readerA.taskId && c.subjectKey !== DISPUTED_ENTRY);
  const theirs = ran.claims.find((c) => c.taskId === readerB.taskId && c.subjectKey === mine.subjectKey);

  const strange = await planFollowUps(readerA, [ask(readerA, "check_unit", { claimRef: entityId("claim", "nobody") })], ctx());
  t.check("check_unit naming a claim this workflow does not hold is refused",
    strange.children.length === 0 && strange.refused[0].reason === "the claim to check is not a claim of this workflow",
    reasons(strange.refused));

  const otherReaders = await planFollowUps(readerA, [ask(readerA, "check_unit", { claimRef: theirs.claimId })], ctx());
  t.check("check_unit naming the other blind reader's claim is refused — a reader cannot ask about a reading it was never shown",
    otherReaders.children.length === 0 && otherReaders.refused[0].reason === "the claim to check is not one this task produced or was handed",
    reasons(otherReaders.refused));

  const own = await planFollowUps(readerA, [ask(readerA, "check_unit", { claimRef: mine.claimId })], ctx());
  const child = own.children[0];
  t.check("check_unit naming a claim the task itself made is given one child, and that child is a claim verification",
    own.children.length === 1 && child.taskType === KERNEL_TASK_TYPES.verifyClaim && child.phase === "verify" && child.roleKey === "evidence_critic",
    child ? `${child.phase}/${child.taskType}` : reasons(own.refused));

  t.check("the child targets exactly that claim and is subject to it — the check is about one reading, not about the table",
    child.targetClaimIds.length === 1 && child.targetClaimIds[0] === mine.claimId && child.subjectKey === entityId("subject", mine.claimId));

  t.check("the child is sent to the place the claim is anchored, so the critic reopens the source where the reading was made",
    child.sources.length === 1 && child.sources[0].segmentId === table1.segmentId
    && (await base.repo.listAnchors([mine.claimId])).every((a) => a.segmentId === table1.segmentId));

  const criticRefused = await planFollowUps(readerA, [ask(readerA, "request_evidence_critic", { claimRef: theirs.claimId })], ctx());
  t.check("request_evidence_critic naming a claim the task cannot see is refused on the same rule",
    criticRefused.children.length === 0 && criticRefused.refused[0].reason === "the claim to check is not one this task produced or was handed",
    reasons(criticRefused.refused));

  const criticAsked = await planFollowUps(readerA, [ask(readerA, "request_evidence_critic", { claimRef: mine.claimId })], ctx());
  t.check("request_evidence_critic naming a visible claim makes a claim verification targeting it",
    criticAsked.children.length === 1 && criticAsked.children[0].taskType === KERNEL_TASK_TYPES.verifyClaim
    && criticAsked.children[0].targetClaimIds[0] === mine.claimId);
}

/* ═════════════════════════════════ (9) an independent reader is a new group */
t.section("(9) an independent reader is a group nobody has read this subject in");
{
  const roomForAThird = policyWith({ maximumIndependentReadersPerSubject: 3 });
  const plan = await planFollowUps(verifier, [ask(verifier, "request_independent_reader")], ctx(roomForAThird));
  const child = plan.children[0];

  t.check("with room for a third reader the verifier's request makes one, in the group neither existing reader read under",
    plan.children.length === 1 && child.independenceGroup === READER_C
    && ![READER_A, READER_B].includes(child.independenceGroup),
    child ? child.independenceGroup : reasons([...plan.refused, ...plan.escalations]));

  t.check("the new reader reads the same subject, the same way, from the same place as the readings it joins",
    child.subjectKey === readerA.subjectKey && child.taskType === readerA.taskType && child.phase === readerA.phase
    && child.sources.length === readerA.sources.length && child.sources[0].segmentId === readerA.sources[0].segmentId);

  t.check("the new reader is one deeper than the task that asked for it, and is not counted as its own dispute's work",
    child.depth === verifier.depth + 1 && child.parentTaskId === verifier.taskId);

  const full = await planFollowUps(verifier, [ask(verifier, "request_independent_reader")], ctx());
  t.check("at the policy's ceiling of independent readers the same request escalates instead — a third reader is a person's call",
    full.children.length === 0 && full.escalations.length === 1
    && full.escalations[0].reason.includes(`already has ${2} independent readers`),
    full.escalations[0]?.reason);

  const fromANonReader = await planFollowUps(critic, [ask(critic, "request_independent_reader")], ctx(roomForAThird));
  t.check("a critic may not ask for an independent reader at all — its role does not allow it",
    fromANonReader.children.length === 0 && fromANonReader.refused[0].reason.includes("evidence_critic may not ask for request_independent_reader"),
    reasons(fromANonReader.refused));
}

/* ═════════════════════ (10) a verifier that cannot read the source */
t.section("(10) a verifier answering insufficient_evidence gets exactly one more round, or a person");

/* The first verifier of a dispute says it could not read what it was given
   and asks for two things; the deeper round answers normally. */
function verifierCannotRead(requests) {
  return (packet, envelope) => {
    if (packet.roleKey !== "disagreement_verifier" || packet.context.depth > 1) return envelope;
    const place = packet.sources.find((s) => s.segmentId);
    envelope.outcome = "insufficient_evidence";
    envelope.assessments = [];
    envelope.anchors = [];
    envelope.limitations.push("the disputed row runs past the edge of the region supplied");
    envelope.requestedActions = requests(packet, place);
    return envelope;
  };
}

const ASKS_TWICE = verifierCannotRead((packet, place) => [
  askFromPacket(packet, "expand_segment", place.segmentId, "expand-the-disputed-region"),
  askFromPacket(packet, "read_related_segment", place.segmentId, "read-the-region-again"),
]);

{
  const w = world({ seed: "follow-up/one-more-round", scripts: { "critic-family-one": ASKS_TWICE, "critic-family-two": ASKS_TWICE } });
  await w.scheduler.plan();
  const r = await drive(w);
  const dis = r.disagreements.find((d) => d.kind === "value");
  const firstVerify = r.tasks.find((x) => x.taskType === KERNEL_TASK_TYPES.verifyDisagreement && x.depth === 1);
  const kids = childrenOf(r.tasks, firstVerify);
  const arb = r.tasks.find((x) => x.taskType === KERNEL_TASK_TYPES.adjudicate);
  const deps = arb ? (await w.repo.getDependencies(arb.taskId)).map((d) => d.dependsOnTaskId) : [];

  t.check("the verifier's task completes, recorded as having answered with insufficient evidence",
    firstVerify.state === "completed" && firstVerify.terminalReason === "insufficient_evidence",
    `${firstVerify.state}/${firstVerify.terminalReason}`);

  t.check("it asked for two things and was given exactly one child — one round is one follow-up",
    kids.length === 1, kids.map((k) => k.subjectKey).join(", "));

  t.check("the child is a verification one level deeper, carrying the same dispute, at the next critic round",
    kids[0].taskType === KERNEL_TASK_TYPES.verifyDisagreement && kids[0].depth === firstVerify.depth + 1
    && kids[0].disagreementId === dis.disagreementId && kids[0].criticRound === 1,
    `${kids[0].taskType} depth ${kids[0].depth} round ${kids[0].criticRound}`);

  t.check("the child is the first thing the verifier asked for, not the second — the kernel takes one request, in the order given",
    kids[0].subjectKey.endsWith("/expanded"), kids[0].subjectKey);

  t.check("the dispute records exactly one admitted follow-up for that round: the fingerprint the verifier gave, and the task it became",
    dis.followUps.length === 1 && dis.followUps[0].round === 1
    && dis.followUps[0].fingerprint === "expand-the-disputed-region" && dis.followUps[0].taskId === kids[0].taskId,
    JSON.stringify(dis.followUps));

  t.check("the arbiter that was already waiting now waits for the new round too — it does not judge before the evidence arrives",
    arb !== undefined && deps.includes(kids[0].taskId) && deps.includes(firstVerify.taskId),
    `${deps.length} dependencies`);

  t.check("the arbiter ran only after both verifications were terminal",
    arb.state === "completed" && kids[0].state === "completed" && firstVerify.state === "completed");
}

{
  const asksForNothing = verifierCannotRead(() => []);
  const w = world({ seed: "follow-up/asks-for-nothing", scripts: { "critic-family-one": asksForNothing, "critic-family-two": asksForNothing } });
  await w.scheduler.plan();
  const r = await drive(w);
  const dis = r.disagreements.find((d) => d.kind === "value");
  const firstVerify = r.tasks.find((x) => x.taskType === KERNEL_TASK_TYPES.verifyDisagreement && x.depth === 1);
  const arb = r.tasks.find((x) => x.taskType === KERNEL_TASK_TYPES.adjudicate);

  t.check("a verifier that could not read the source and asked for nothing sends the dispute to a person",
    dis.state === "needs_human" && childrenOf(r.tasks, firstVerify).length === 0,
    `${dis.state}, ${childrenOf(r.tasks, firstVerify).length} children`);

  t.check("the hold says exactly that, so the person reading it knows what was tried",
    holdOf(r.decisions, dis.disagreementId)?.rationale === "the verifier could not read the source and asked for nothing",
    holdOf(r.decisions, dis.disagreementId)?.rationale);

  t.check("the arbitration that was waiting on it is superseded rather than run on evidence nobody could read",
    arb.state === "superseded" && arb.terminalReason === "needs_human", `${arb.state}/${arb.terminalReason}`);

  t.check("the workflow ends partial, because a subject is waiting for a person",
    r.report.workflow.state === "partial", r.report.workflow.state);
}

{
  const w = world({ seed: "follow-up/one-round-only", policy: { maximumCriticRounds: 1 }, scripts: { "critic-family-one": ASKS_TWICE, "critic-family-two": ASKS_TWICE } });
  await w.scheduler.plan();
  const r = await drive(w);
  const dis = r.disagreements.find((d) => d.kind === "value");
  const firstVerify = r.tasks.find((x) => x.taskType === KERNEL_TASK_TYPES.verifyDisagreement && x.depth === 1);

  t.check("with one round of criticism allowed, the round that would have been the second is a person instead of a child",
    dis.state === "needs_human" && childrenOf(r.tasks, firstVerify).length === 0
    && r.tasks.filter((x) => x.taskType === KERNEL_TASK_TYPES.verifyDisagreement).length === 1,
    `${dis.state}, ${r.tasks.filter((x) => x.taskType === KERNEL_TASK_TYPES.verifyDisagreement).length} verifications`);

  t.check("the hold counts the rounds that could not read the source",
    holdOf(r.decisions, dis.disagreementId)?.rationale === "1 rounds of criticism could not read the source",
    holdOf(r.decisions, dis.disagreementId)?.rationale);

  t.check("no follow-up was admitted against the dispute, since none was made",
    dis.followUps.length === 0 && dis.criticRounds === 1, `${dis.followUps.length} follow-ups, ${dis.criticRounds} rounds`);
}

/* ═══════════════════════════ (11) an arbiter that asks for the same thing */
t.section("(11) an arbiter that asks again for evidence already asked for goes to a person");
{
  const repeatsTheFingerprint = (packet, envelope) => {
    envelope.adjudication = {
      outcome: "needs_more_evidence", disagreementId: packet.context.disagreements[0]?.disagreementId ?? "",
      acceptedClaimRef: null, correctedValue: null, correctedUnit: null, evidenceAnchorIds: [],
      rationale: "the region read wider still does not settle it; reopen it once more",
      followUp: askFromPacket(packet, "expand_segment", packet.sources.find((s) => s.segmentId)?.segmentId ?? null, "expand-the-disputed-region"),
    };
    return envelope;
  };
  const w = world({
    seed: "follow-up/asked-again",
    scripts: { "critic-family-one": ASKS_TWICE, "critic-family-two": ASKS_TWICE, "arbiter-family-one": repeatsTheFingerprint },
  });
  await w.scheduler.plan();
  const r = await drive(w);
  const dis = r.disagreements.find((d) => d.kind === "value");
  const arb = r.tasks.find((x) => x.taskType === KERNEL_TASK_TYPES.adjudicate);

  t.check("the arbiter repeats the fingerprint the verifier's round already admitted, and the dispute goes to a person",
    dis.state === "needs_human" && dis.followUps.length === 1 && dis.followUps[0].fingerprint === "expand-the-disputed-region",
    `${dis.state}, ${dis.followUps.length} admitted follow-up(s)`);

  t.check("the hold says the same evidence was asked for again",
    holdOf(r.decisions, dis.disagreementId)?.rationale === "the arbiter asked for the same evidence again — a person decides",
    holdOf(r.decisions, dis.disagreementId)?.rationale);

  t.check("no second arbitration and no third verification were created from the repeated request",
    r.tasks.filter((x) => x.taskType === KERNEL_TASK_TYPES.adjudicate).length === 1
    && childrenOf(r.tasks, arb).length === 0,
    `${r.tasks.filter((x) => x.taskType === KERNEL_TASK_TYPES.adjudicate).length} arbitrations`);

  t.check("the competing readings end unresolved rather than settled by an arbiter that would not stop asking",
    every(r.claims.filter((c) => dis.claimIds.includes(c.claimId)), (c) => c.status === "unresolved"),
    r.claims.filter((c) => dis.claimIds.includes(c.claimId)).map((c) => c.status).join(", "));
}

/* ══════════════════ (12) nothing more is asked once a dispute is settled or held */
t.section("(12) a request that arrives after its dispute is settled or held is refused, and the refusal is on the record");

function alsoAsks(decide) {
  return (packet, envelope) => {
    const e = decide ? decide(packet, envelope) : envelope;
    e.requestedActions = [askFromPacket(packet, "request_disagreement_verification", null, "one-more-look-please")];
    return e;
  };
}

{
  const w = world({ seed: "follow-up/settled", scripts: { "arbiter-family-one": alsoAsks(null) } });
  await w.scheduler.plan();
  const r = await drive(w);
  const dis = r.disagreements.find((d) => d.kind === "value");
  const arb = r.tasks.find((x) => x.taskType === KERNEL_TASK_TYPES.adjudicate);
  const refusals = auditsFor(r.audit, "core_v2.follow_up.refused", arb.taskId);

  t.check("the arbiter settled the dispute in the same answer that asked for one more verification",
    dis.state === "resolved" && arb.state === "completed", `${dis.state}/${arb.state}`);

  t.check("the request is refused, and the record says why: the dispute is settled, so nothing more is asked by machine",
    refusals.length === 1 && String(refusals[0].detail.reason).includes("held by a person or settled"),
    refusals.map((a) => String(a.detail.reason)).join(" | "));

  t.check("no task was created from that request",
    childrenOf(r.tasks, arb).length === 0 && r.tasks.filter((x) => x.taskType === KERNEL_TASK_TYPES.verifyDisagreement).length === 1);
}

{
  const toAPerson = (packet, envelope) => {
    envelope.adjudication = {
      outcome: "needs_human", disagreementId: packet.context.disagreements[0]?.disagreementId ?? "",
      acceptedClaimRef: null, correctedValue: null, correctedUnit: null, evidenceAnchorIds: [],
      rationale: "the readings and the source cannot be reconciled from what is here", followUp: null,
    };
    return envelope;
  };
  const w = world({ seed: "follow-up/held", scripts: { "arbiter-family-one": alsoAsks(toAPerson) } });
  await w.scheduler.plan();
  const r = await drive(w);
  const dis = r.disagreements.find((d) => d.kind === "value");
  const arb = r.tasks.find((x) => x.taskType === KERNEL_TASK_TYPES.adjudicate);
  const refusals = auditsFor(r.audit, "core_v2.follow_up.refused", arb.taskId);

  t.check("an arbiter that sends the dispute to a person in the same answer that asks for more is refused the same way",
    dis.state === "needs_human" && refusals.length === 1 && String(refusals[0].detail.reason).includes("held by a person or settled"),
    `${dis.state}; ${refusals.map((a) => String(a.detail.reason)).join(" | ")}`);

  t.check("the held dispute gained no further machine work from the request",
    childrenOf(r.tasks, arb).length === 0 && r.tasks.filter((x) => x.taskType === KERNEL_TASK_TYPES.adjudicate).length === 1);
}

/* ═══════════════════════════════ (13) children of a dispute carry the dispute */
t.section("(13) every child of a dispute carries the dispute, its parent and its author");
{
  const w = world({ seed: "follow-up/lineage", scripts: { "critic-family-one": ASKS_TWICE, "critic-family-two": ASKS_TWICE } });
  await w.scheduler.plan();
  const r = await drive(w);
  const dis = r.disagreements.find((d) => d.kind === "value");
  const compare = r.tasks.find((x) => x.taskType === KERNEL_TASK_TYPES.compare && childrenOf(r.tasks, x).some((c) => c.disagreementId === dis.disagreementId));
  const disputeChildren = childrenOf(r.tasks, compare).filter((c) => c.disagreementId === dis.disagreementId);
  const firstVerify = disputeChildren.find((c) => c.taskType === KERNEL_TASK_TYPES.verifyDisagreement);
  const deeper = childrenOf(r.tasks, firstVerify);

  t.check("the comparison that found the disagreement is the parent and the author of both the verification and the arbitration it made",
    disputeChildren.length === 2 && every(disputeChildren, (c) => c.parentTaskId === compare.taskId && c.createdByTaskId === compare.taskId)
    && disputeChildren.some((c) => c.taskType === KERNEL_TASK_TYPES.verifyDisagreement)
    && disputeChildren.some((c) => c.taskType === KERNEL_TASK_TYPES.adjudicate),
    disputeChildren.map((c) => c.taskType).join(", "));

  t.check("both carry the disagreement they exist for, one deeper than the comparison",
    every(disputeChildren, (c) => c.disagreementId === dis.disagreementId && c.depth === compare.depth + 1));

  t.check("the verifier's own follow-up carries the same dispute, and names the verifier as parent and author",
    deeper.length === 1 && deeper[0].disagreementId === dis.disagreementId
    && deeper[0].parentTaskId === firstVerify.taskId && deeper[0].createdByTaskId === firstVerify.taskId);

  t.check("every task of that dispute names it, and no task outside it does",
    r.tasks.filter((x) => x.disagreementId === dis.disagreementId).length === 3
    && r.tasks.filter((x) => x.disagreementId !== null && x.disagreementId !== dis.disagreementId).length === 0,
    `${r.tasks.filter((x) => x.disagreementId === dis.disagreementId).length} tasks carry it`);
}

/* ═══════════════════════════════════════════════════════════ the network */
t.section("the network");
t.check("nothing in any of these runs attempted a network call", tripped() === 0, `${tripped()} attempts`);

t.finish();
