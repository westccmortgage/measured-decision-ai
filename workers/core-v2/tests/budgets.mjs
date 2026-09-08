/* EVERY LIMIT IS A PLACE THE RUN STOPS OF ITS OWN ACCORD.
 *
 * docs/core-v2.md §6 and the policy's own preamble: no provider is called in
 * this repository and the budgets are enforced anyway, because an engine that
 * only learns restraint once money is attached learns it on a customer's
 * invoice. Every number in kernel/policy.ts is checked here at the place it
 * bites: tasks and dependency edges per workflow, children per parent,
 * follow-up depth, packet claims, packet sources, packet bytes, envelope
 * bytes, attempts per task, concurrent work in the workflow and per role,
 * timed-out executions, verified disagreements per subject, independent
 * readers per subject, and the rounds of criticism and arbitration — with
 * exactly one additional verification request admitted per disagreement
 * round. A refusal is never silent: it fails the work known, holds the
 * subject for a person, or escalates, and it is in the audit.
 *
 * Everything runs in memory on the synthetic records pack with scripted
 * executors, or directly against the in-memory repository with records built
 * by hand. The network is closed before the engine is used. The clock is
 * manual; the one place that needs real time is a 10 ms attempt deadline.
 */
import { harness, closeNetwork } from "./harness.mjs";
import { syntheticRecordSet } from "../domains/synthetic-records/fixture.ts";
import { SyntheticRecordsPack, TASK } from "../domains/synthetic-records/pack.ts";
import { mockExecutors } from "../domains/synthetic-records/mocks.ts";
import { assemble, manualClock } from "../domains/simulate.ts";
import { ENGINE_VERSION, KERNEL_TASK_TYPES } from "../kernel/contracts.ts";
import { INDEPENDENCE_GROUPS } from "../kernel/domain.ts";
import { childTask, planFollowUps } from "../kernel/follow-up-planner.ts";
import { canonical, entityId, sha256 } from "../kernel/ids.ts";
import { InMemoryOrchestrationRepository } from "../kernel/memory-repository.ts";
import { PacketOverBudget, buildPacket } from "../kernel/packet-builder.ts";
import { lookupOf, specsToTasks } from "../kernel/planning.ts";
import { DEFAULT_POLICY, budgetOf, policyWith } from "../kernel/policy.ts";
import { RoleRegistry } from "../kernel/roles.ts";
import { SUBMITTED_ATTEMPT_STATES } from "../kernel/transitions.ts";

const tripped = closeNetwork();
const t = harness("every limit is a place the run stops of its own accord");

/* ───────────────────────────────────────────────────────────── helpers */

const pack = new SyntheticRecordsPack();
const registryOfRoles = new RoleRegistry(pack);
const every = (xs, f) => xs.length > 0 && xs.every(f);
const same = (a, b) => canonical(a) === canonical(b);

/* One assembled world: a fixture, scripted executors, an in-memory
   repository and a clock this test moves by hand. */
function world(options = {}) {
  const truth = syntheticRecordSet({
    seed: options.seed ?? "budgets/records", sources: options.sources ?? 1,
    sheetsPerSource: options.sheets ?? 1, entriesPerTable: options.entries ?? 3,
  });
  const { registry, executors } = mockExecutors(truth, { scripts: options.scripts, families: options.families, aliases: options.aliases });
  const parts = assemble({ manifest: truth.manifest, pack: new SyntheticRecordsPack(), executors: registry, clock: manualClock(), policy: options.policy });
  return { truth, wf: truth.manifest.workflowId, registry, executors, ...parts };
}

/* Tick by hand until nothing moves, keeping every tick's report, then let
   the scheduler settle the workflow's final state. */
async function drive(w, maxTicks = 60) {
  const ticks = [];
  for (let i = 0; i < maxTicks; i++) {
    const report = await w.scheduler.tick();
    ticks.push(report);
    if (report.dispatched.length === 0 && report.released === 0 && report.stopped === 0 && report.reconciled === 0 && w.scheduler.inFlight.size === 0) break;
  }
  const report = await w.scheduler.runUntilQuiescent();
  const tasks = await w.repo.listTasks(w.wf);
  return {
    ticks, report, tasks,
    claims: await w.repo.listClaims({ workflowId: w.wf }),
    disagreements: await w.repo.listDisagreements(w.wf),
    decisions: await w.repo.listDecisions(w.wf),
    audit: await w.repo.listAudit(),
  };
}

const ofType = (tasks, taskType) => tasks.filter((x) => x.taskType === taskType);
async function attemptsOf(repo, task) { return task ? repo.listAttempts(task.taskId) : []; }

/* ── records built by hand, for the repository's own budget arithmetic ── */

const ORGANISATION = entityId("budgets-organisation", "budgets");
const LIMITS = { maximumTasks: 50, maximumEdges: 100, maximumChildrenPerParent: 4, maximumDepth: 3 };

function bareWorld(key, budget = budgetOf(DEFAULT_POLICY)) {
  const workflowId = entityId("budgets-workflow", key);
  const sourceId = entityId("budgets-source", workflowId, 0);
  const workflow = {
    workflowId, organizationId: ORGANISATION, domainPack: "synthetic-records", domainPackVersion: "1.0",
    workflowType: "synthetic_record_review", engineVersion: ENGINE_VERSION, state: "created",
    sourceSetFingerprint: sha256(`sources:${key}`), requestFingerprint: sha256(`request:${key}`), requestedScope: {},
    budget, cancelRequestedAt: null, totalUnits: 0, completedUnits: 0, attentionUnits: 0, errorCode: null, errorMessage: null,
  };
  const sources = [{
    sourceId, ordinal: 0, sourceKind: "record_set", label: "record set A", uri: `fixture://budgets/${key}`,
    contentHash: `fx-${sha256(key).slice(0, 24)}`, hashAlgorithm: "sha-256", objectVersionId: null, byteSize: 4096,
    media: {}, declaredSegments: [],
  }];
  const task = (name, over = {}) => ({
    taskId: entityId("task", workflowId, name), workflowId, parentTaskId: null, createdByTaskId: null, phase: "analyze",
    taskType: TASK.readTable, roleKey: "table_reader", roleVersion: "1.0", subjectKey: `subject/${name}`, priority: 100,
    sources: [{ sourceId, segmentId: null }], inputFingerprint: sha256(`input:${name}`), contractVersion: "core-v2.1/contract.2",
    independenceGroup: null, depth: 0, criticRound: 0, arbiterRound: 0, disagreementId: null, targetClaimIds: [],
    maxClaims: 8, dependsOn: [], ...over,
  });
  return { workflowId, sourceId, workflow, sources, task };
}

async function bareRepo(key, budget) {
  const b = bareWorld(key, budget);
  const repo = new InMemoryOrchestrationRepository();
  await repo.createWorkflow(b.workflow, b.sources);
  return { repo, ...b };
}

/* ══════════════════════════════ the numbers themselves ══════════════════ */

t.section("the policy: what may be changed, what may not, and what the database is told");
{
  const tightened = policyWith({ maximumTasksPerWorkflow: 7, maximumCriticRounds: 1 });
  t.check("policyWith changes the numbers it is given", tightened.maximumTasksPerWorkflow === 7 && tightened.maximumCriticRounds === 1);
  t.check("policyWith leaves every other number at its default",
    tightened.maximumDependencyEdgesPerWorkflow === DEFAULT_POLICY.maximumDependencyEdgesPerWorkflow
    && tightened.maximumPacketBytes === DEFAULT_POLICY.maximumPacketBytes
    && tightened.maximumAttemptsPerTask === DEFAULT_POLICY.maximumAttemptsPerTask);
  t.check("stopOnCancel cannot be switched off, however the caller asks",
    policyWith({ stopOnCancel: false }).stopOnCancel === true && policyWith({}).stopOnCancel === true && DEFAULT_POLICY.stopOnCancel === true);

  const budget = budgetOf(tightened);
  t.check("budgetOf snapshots exactly the six numbers the database holds the workflow to",
    same(Object.keys(budget).sort(), ["maximum_arbiter_rounds", "maximum_child_tasks_per_parent", "maximum_critic_rounds", "maximum_dependency_edges", "maximum_follow_up_depth", "maximum_tasks"]),
    Object.keys(budget).join(", "));
  t.check("budgetOf carries the policy's own values, not defaults",
    budget.maximum_tasks === 7 && budget.maximum_critic_rounds === 1 && budget.maximum_dependency_edges === tightened.maximumDependencyEdgesPerWorkflow);

  const w = world({ policy: { maximumTasksPerWorkflow: 500, maximumCriticRounds: 1 } });
  await w.scheduler.plan();
  const workflow = await w.repo.getWorkflow(w.wf);
  t.check("after plan() the workflow row's budget equals budgetOf(the scheduler's policy)", same(workflow.budget, budgetOf(w.policy)), canonical(workflow.budget));
}

/* ══════════════════════════════ tasks per workflow ══════════════════════ */

t.section("maximumTasksPerWorkflow: planning stops, and expansion refuses what would cross it");
{
  /* Phase A alone is over the ceiling: the workflow fails at planning. */
  const w = world({ seed: "budgets/plan-ceiling", sources: 2, policy: { maximumTasksPerWorkflow: 1 } });
  await t.refused("plan() refuses a manifest whose phase A alone exceeds the workflow's task ceiling", () => w.scheduler.plan());
  const workflow = await w.repo.getWorkflow(w.wf);
  t.check("the workflow is failed with errorCode budget, not left planning", workflow.state === "failed" && workflow.errorCode === "budget", `${workflow.state}/${workflow.errorCode}`);
  t.check("the failure says which ceiling was crossed", /ceiling of 1 tasks/.test(workflow.errorMessage ?? ""), workflow.errorMessage);
  t.check("no work beyond the ceiling was admitted", (await w.repo.listTasks(w.wf)).length === 1);
}
{
  /* Phase A fits; phase B does not. Expansion refuses, audits and escalates. */
  const w = world({ seed: "budgets/expand-ceiling", sources: 1, sheets: 2, policy: { maximumTasksPerWorkflow: 2 } });
  await w.scheduler.plan();
  await w.scheduler.tick();
  const tasks = await w.repo.listTasks(w.wf);
  const audit = await w.repo.listAudit();
  const refusals = audit.filter((a) => a.action === "core_v2.expansion.refused");
  t.check("the ingest ran and expansion admitted what fitted, and no more", tasks.length === 2 && ofType(tasks, TASK.discoverRegions).length === 1, `${tasks.length} tasks`);
  t.check("the task expansion could not admit is audited as core_v2.expansion.refused", refusals.length === 1, `${refusals.length} refusals`);
  t.check("the audited refusal names the work and the ceiling that stopped it",
    refusals.length === 1 && refusals[0].detail.taskType === TASK.discoverRegions && /ceiling of 2 tasks/.test(String(refusals[0].detail.reason)),
    canonical(refusals[0]?.detail ?? {}));
  t.check("the refusal is escalated, not swallowed: the scheduler carries it as an escalation",
    w.scheduler.escalations.some((e) => /ceiling of 2 tasks/.test(e)), w.scheduler.escalations.join(" | "));
  const after = await drive(w);
  t.check("at the ceiling the graph stops growing: the workflow ends holding exactly the two tasks it was allowed",
    after.tasks.length === 2, `${after.tasks.length} tasks`);
  t.check("not one reading was admitted past the ceiling, and none was quietly dropped: every refusal is in the run's report",
    ofType(after.tasks, TASK.readTable).length === 0 && ofType(after.tasks, TASK.readNote).length === 0
    && after.report.escalations.some((e) => e.includes(TASK.readTable) && /ceiling of 2 tasks/.test(e))
    && after.report.escalations.some((e) => e.includes(KERNEL_TASK_TYPES.compare) && /ceiling of 2 tasks/.test(e)),
    after.report.escalations.slice(0, 3).join(" | "));
}

/* ══════════════════════════════ dependency edges ════════════════════════ */

t.section("maximumDependencyEdgesPerWorkflow: admission refuses, and addDependency throws at the ceiling");
{
  const b = await bareRepo("edges");
  const limits = { ...LIMITS, maximumEdges: 2 };
  const a = b.task("a");
  const second = b.task("b", { dependsOn: [{ taskId: a.taskId, kind: "requires_completion" }] });
  const third = b.task("c", { dependsOn: [{ taskId: a.taskId, kind: "requires_completion" }] });
  const admitted = await b.repo.admitTasks(b.workflowId, [a, second, third], limits);
  t.check("three tasks and two edges are admitted while the workflow is under its edge ceiling",
    admitted.created.length === 3 && admitted.refused.length === 0 && (await b.repo.getDependencies(third.taskId)).length === 1);

  const fourth = b.task("d", { dependsOn: [{ taskId: a.taskId, kind: "requires_completion" }] });
  const over = await b.repo.admitTasks(b.workflowId, [fourth], limits);
  t.check("the task whose edge would cross the ceiling is refused, and refusal is returned rather than thrown",
    over.created.length === 0 && over.refused.length === 1 && /ceiling of 2 dependency edges/.test(over.refused[0].reason), over.refused[0]?.reason);
  t.check("the refused task was not written: admission is all of one task or none of it", (await b.repo.getTask(fourth.taskId)) === null);
  t.check("the workflow still holds exactly its two edges", (await b.repo.getDependencies(second.taskId)).length + (await b.repo.getDependencies(third.taskId)).length === 2);

  await t.refused("addDependency throws at the ceiling — a later edge is no cheaper than an admitted one",
    () => b.repo.addDependency(third.taskId, second.taskId, "requires_completion", limits));
  t.check("the edge addDependency refused was not written",
    !(await b.repo.getDependencies(third.taskId)).some((d) => d.dependsOnTaskId === second.taskId));
  await b.repo.addDependency(third.taskId, second.taskId, "requires_completion", { ...limits, maximumEdges: 3 });
  t.check("the same edge is written once the ceiling allows it — the ceiling is the only thing that refused it",
    (await b.repo.getDependencies(third.taskId)).some((d) => d.dependsOnTaskId === second.taskId));
}

/* ══════════════════════════════ children per parent ═════════════════════ */

t.section("maximumChildTasksPerParent: the child past the limit is refused");
{
  const b = await bareRepo("children");
  const limits = { ...LIMITS, maximumChildrenPerParent: 2 };
  const parent = b.task("parent");
  await b.repo.admitTasks(b.workflowId, [parent], limits);
  const child = (n) => b.task(`child-${n}`, { parentTaskId: parent.taskId, createdByTaskId: parent.taskId, depth: 1, subjectKey: `subject/child-${n}` });
  const first = await b.repo.admitTasks(b.workflowId, [child(1), child(2)], limits);
  t.check("a parent may have as many children as the limit allows", first.created.length === 2 && first.refused.length === 0);
  const third = await b.repo.admitTasks(b.workflowId, [child(3)], limits);
  t.check("the child past the limit is refused, and the reason names the parent's spent follow-ups",
    third.created.length === 0 && third.refused.length === 1 && /has used its 2 follow-ups/.test(third.refused[0].reason), third.refused[0]?.reason);
  t.check("the refused child was not written", (await b.repo.getTask(child(3).taskId)) === null);
  const sibling = b.task("other-parent");
  await b.repo.admitTasks(b.workflowId, [sibling], limits);
  const elsewhere = await b.repo.admitTasks(b.workflowId, [b.task("other-child", { parentTaskId: sibling.taskId, createdByTaskId: sibling.taskId, depth: 1, subjectKey: "subject/other-child" })], limits);
  t.check("another parent may still have its own children — the limit is per parent, not per workflow",
    elsewhere.created.length === 1 && elsewhere.refused.length === 0
    && (await b.repo.listTasks(b.workflowId)).filter((x) => x.parentTaskId === parent.taskId).length === 2,
    `${elsewhere.created.length} created elsewhere`);
}

/* ══════════════════════════════ follow-up depth ═════════════════════════ */

t.section("maximumFollowUpDepth: admission refuses a task deeper than the limit");
{
  const b = await bareRepo("depth");
  const limits = { ...LIMITS, maximumDepth: 2 };
  const deep = b.task("too-deep", { depth: 3 });
  const refused = await b.repo.admitTasks(b.workflowId, [deep], limits);
  t.check("a task one level deeper than the limit is refused with the depth in the reason",
    refused.created.length === 0 && refused.refused.length === 1 && /depth 3 exceeds the limit of 2/.test(refused.refused[0].reason), refused.refused[0]?.reason);
  t.check("the too-deep task was not written", (await b.repo.getTask(deep.taskId)) === null);
  const atLimit = await b.repo.admitTasks(b.workflowId, [b.task("at-limit", { depth: 2 })], limits);
  t.check("a task at the limit is admitted — the limit is a ceiling, not a fence one short of it", atLimit.created.length === 1);
}

t.section("maximumFollowUpDepth: at the limit the answer is a person, not another child");
{
  const w = world({ seed: "budgets/depth-followups" });
  await w.scheduler.plan();
  const run = await drive(w);
  const segments = await w.repo.listSegments(w.wf);
  const note = segments.find((s) => s.segmentKind === "note" && s.status === "accepted");
  const reader = ofType(run.tasks, TASK.readTable).find((x) => x.independenceGroup === INDEPENDENCE_GROUPS[0]);
  const ctx = { repo: w.repo, lookup: lookupOf(w.truth.manifest, segments), registry: registryOfRoles, pack, policy: w.policy };
  const ask = (parent) => ([{
    actionType: "read_reference_segment", reasonCode: "the note may say what the row means", targetSegmentIds: [note.segmentId],
    expectedInformation: "what the note says about this entry", parentTaskId: parent.taskId, currentDepth: parent.depth,
    idempotencyFingerprint: "look-at-the-note",
  }]);

  t.check("the fixture gives a blind reader of a table and an accepted note beside it", reader !== undefined && note !== undefined);
  const shallow = { ...reader, depth: w.policy.maximumFollowUpDepth - 1 };
  const allowed = await planFollowUps(shallow, ask(shallow), ctx);
  t.check("below the limit the same request becomes exactly one bounded child, one level deeper",
    allowed.children.length === 1 && allowed.escalations.length === 0 && allowed.children[0].depth === shallow.depth + 1,
    `${allowed.children.length} children, ${allowed.escalations.length} escalations`);

  const atLimit = { ...reader, depth: w.policy.maximumFollowUpDepth };
  const stopped = await planFollowUps(atLimit, ask(atLimit), ctx);
  t.check("at the limit the request makes no child at all", stopped.children.length === 0, `${stopped.children.length} children`);
  t.check("at the limit the request goes to a person, and the escalation says the depth is why",
    stopped.escalations.length === 1 && /at depth 3 nothing more is asked by machine/.test(stopped.escalations[0].reason), stopped.escalations[0]?.reason);
}

t.section("maximumChildTasksPerParent: a parent that has spent its follow-ups escalates instead of asking again");
{
  const w = world({ seed: "budgets/child-budget" });
  await w.scheduler.plan();
  const run = await drive(w);
  const segments = await w.repo.listSegments(w.wf);
  const note = segments.find((s) => s.segmentKind === "note" && s.status === "accepted");
  const reader = ofType(run.tasks, TASK.readTable).find((x) => x.independenceGroup === INDEPENDENCE_GROUPS[0]);
  const spent = policyWith({ maximumChildTasksPerParent: 1 });
  const ctx = { repo: w.repo, lookup: lookupOf(w.truth.manifest, segments), registry: registryOfRoles, pack, policy: spent };
  const filler = childTask(reader, "verify", KERNEL_TASK_TYPES.verifyClaim, "budgets/filler", [], null, null, [], ctx, reader.depth + 1);
  const admitted = await w.repo.admitTasks(w.wf, [filler], { maximumTasks: 500, maximumEdges: 800, maximumChildrenPerParent: 4, maximumDepth: 3 });
  t.check("the reader already has one child, which is all a parent budget of one allows", admitted.created.length === 1 && admitted.created[0].parentTaskId === reader.taskId);

  const request = [{
    actionType: "read_reference_segment", reasonCode: "one more place", targetSegmentIds: [note.segmentId],
    expectedInformation: "what the note says", parentTaskId: reader.taskId, currentDepth: reader.depth, idempotencyFingerprint: "one-more",
  }];
  const plan = await planFollowUps(reader, request, ctx);
  t.check("the next follow-up of that parent makes no child", plan.children.length === 0);
  t.check("it escalates to a person, naming the follow-ups the parent has used",
    plan.escalations.length === 1 && /has used its 1 follow-ups/.test(plan.escalations[0].reason), plan.escalations[0]?.reason);
  const roomier = await planFollowUps(reader, request, { ...ctx, policy: policyWith({ maximumChildTasksPerParent: 3 }) });
  t.check("with room for more children the same request is granted — the number is what refused it",
    roomier.children.length === 1 && roomier.escalations.length === 0);
}

/* ══════════════════════════════ packets ═════════════════════════════════ */

t.section("maximumPacketBytes: a packet past the size is not built, and nothing is sent");
{
  const w = world({ seed: "budgets/packet-bytes", policy: { maximumPacketBytes: 500 } });
  await w.scheduler.plan();
  const run = await drive(w);
  const ingest = ofType(run.tasks, KERNEL_TASK_TYPES.ingest)[0];
  const attempts = await attemptsOf(w.repo, ingest);
  t.check("the ingest whose packet is over the byte ceiling fails known with reason packet_over_budget",
    ingest.state === "failed_known" && ingest.terminalReason === "packet_over_budget", `${ingest.state}/${ingest.terminalReason}`);
  t.check("its one attempt is rejected_before_submission with errorCode packet_over_budget",
    attempts.length === 1 && attempts[0].state === "rejected_before_submission" && attempts[0].errorCode === "packet_over_budget",
    attempts.map((a) => `${a.state}/${a.errorCode}`).join(", "));
  t.check("the refused attempt names no executor family and no independence domain — nothing was chosen to run it",
    attempts[0].executorFamily === "none" && attempts[0].independenceDomain === "none");
  t.check("the attempt never reached a submitted state", attempts.every((a) => !SUBMITTED_ATTEMPT_STATES.includes(a.state)));
  t.check("no executor of any kind was handed a packet in the whole run — not even the kernel's own code executor",
    w.registry.packetsSeen.length === 0, `${w.registry.packetsSeen.length} packets`);
  t.check("the size refusal is audited against the task", run.audit.some((a) => a.action === "core_v2.task.packet_over_budget" && a.entityId === ingest.taskId));
  t.check("the message says how many bytes and what the policy allows",
    /bytes; the policy allows 500/.test(attempts[0].errorMessage ?? ""), attempts[0].errorMessage);
  t.check("the run ends partial, with a subject that was never read", run.report.workflow.state === "partial", run.report.workflow.state);
}

t.section("maximumPacketClaims: the comparison whose packet would carry too many claims is not built");
{
  /* Three entries read by two blind readers is six claims for the table's
     comparison; the note's comparison carries two. */
  const w = world({ seed: "budgets/packet-claims", entries: 3, policy: { maximumPacketClaims: 5 } });
  await w.scheduler.plan();
  const run = await drive(w);
  const readerSubject = ofType(run.tasks, TASK.readTable)[0]?.subjectKey;
  const noteSubject = ofType(run.tasks, TASK.readNote)[0]?.subjectKey;
  const tableCompare = ofType(run.tasks, KERNEL_TASK_TYPES.compare).find((x) => x.subjectKey === readerSubject);
  const noteCompare = ofType(run.tasks, KERNEL_TASK_TYPES.compare).find((x) => x.subjectKey === noteSubject);
  const attempts = await attemptsOf(w.repo, tableCompare);

  t.check("both blind readings of the table were made — the claims exist to overflow the packet",
    run.claims.filter((c) => c.predicate === "quantity" && c.independenceGroup !== null).length === 6,
    `${run.claims.filter((c) => c.predicate === "quantity").length} quantity claims`);
  t.check("the comparison whose packet would carry six claims fails known with reason packet_over_budget",
    tableCompare.state === "failed_known" && tableCompare.terminalReason === "packet_over_budget", `${tableCompare.state}/${tableCompare.terminalReason}`);
  t.check("its attempt is rejected_before_submission with errorCode packet_over_budget",
    attempts.length === 1 && attempts[0].state === "rejected_before_submission" && attempts[0].errorCode === "packet_over_budget");
  t.check("the message says how many claims and what the policy allows",
    /would carry 6 claims; the policy allows 5/.test(attempts[0].errorMessage ?? ""), attempts[0].errorMessage);
  t.check("no packet for that comparison reached any executor",
    !w.registry.packetsSeen.some((p) => p.taskId === tableCompare.taskId));
  t.check("the note's comparison, whose packet carries two claims, ran and completed — only the packet over the ceiling was refused",
    noteCompare.state === "completed" && w.registry.packetsSeen.some((p) => p.taskId === noteCompare.taskId), `${noteCompare.state}`);
}

t.section("maximumPacketSources: a packet naming more places than the policy allows is not built");
{
  const w = world({ seed: "budgets/packet-sources" });
  await w.scheduler.plan();
  const run = await drive(w);
  const segments = (await w.repo.listSegments(w.wf)).filter((s) => s.status === "accepted" && s.parentSegmentId !== null);
  const critic = ofType(run.tasks, KERNEL_TASK_TYPES.verifyClaim)[0];
  const twoPlaces = {
    ...critic, taskId: entityId("task", w.wf, "budgets/two-places"), targetClaimIds: [], disagreementId: null,
    sources: segments.slice(0, 2).map((s) => ({ sourceId: null, segmentId: s.segmentId })),
  };
  const ctx = {
    manifest: w.truth.manifest, lookup: lookupOf(w.truth.manifest, await w.repo.listSegments(w.wf)),
    repo: w.repo, registry: registryOfRoles, pack, policy: policyWith({ maximumPacketSources: 1 }),
  };
  t.check("the fixture holds a critic's assignment and two accepted places to name in one packet",
    segments.length >= 2 && critic !== undefined && critic.roleKey === "evidence_critic");
  let thrown = null;
  try { await buildPacket(twoPlaces, ctx); } catch (error) { thrown = error; }
  t.check("building a packet with two sources under a policy of one is refused as PacketOverBudget",
    thrown instanceof PacketOverBudget, thrown ? String(thrown.message).slice(0, 100) : "no refusal");
  t.check("the refusal says how many sources and what the policy allows",
    /would carry 2 sources; the policy allows 1/.test(thrown?.message ?? ""), thrown?.message);
  const roomier = await buildPacket(twoPlaces, { ...ctx, policy: policyWith({ maximumPacketSources: 2 }) });
  t.check("the same packet is built once the policy allows two — the number is what refused it",
    roomier.packet.sources.length === 2);
}

/* ══════════════════════════════ envelopes ═══════════════════════════════ */

t.section("maximumEnvelopeBytes: an answer past the size is kept, and none of it becomes evidence");
{
  const PADDING = 20_000;
  const bloat = (packet, base) => {
    if (packet.roleKey !== "table_reader") return base;
    base.limitations.push("x".repeat(PADDING));
    return base;
  };
  const w = world({ seed: "budgets/envelope-bytes", scripts: { "reader-family-one": bloat }, policy: { maximumEnvelopeBytes: 4_000 } });
  await w.scheduler.plan();
  const run = await drive(w);
  const bloated = ofType(run.tasks, TASK.readTable).find((x) => x.independenceGroup === INDEPENDENCE_GROUPS[0]);
  const other = ofType(run.tasks, TASK.readTable).find((x) => x.independenceGroup === INDEPENDENCE_GROUPS[1]);
  const attempt = (await attemptsOf(w.repo, bloated))[0];

  t.check("the over-sized answer's task ends failed_known, its reason naming an invalid envelope",
    bloated.state === "failed_known" && /^invalid_envelope/.test(bloated.terminalReason ?? ""), `${bloated.state}/${bloated.terminalReason}`);
  t.check("the attempt ends failed_known with validationState invalid",
    attempt.state === "failed_known" && attempt.validationState === "invalid", `${attempt.state}/${attempt.validationState}`);
  t.check("a validation problem names the bytes and the ceiling",
    attempt.validationProblems.some((p) => /^envelope is \d+ bytes; the policy allows 4000$/.test(p)), attempt.validationProblems.map((p) => p.slice(0, 60)).join(" | "));
  t.check("the answer is kept verbatim on the attempt, padding and all — the record shows what was said",
    Array.isArray(attempt.rawResult?.limitations) && attempt.rawResult.limitations.some((l) => l.length === PADDING));
  t.check("the digest is over that same raw answer", attempt.rawResultHash === sha256(canonical(attempt.rawResult)));
  t.check("not one claim of the over-sized answer entered the record",
    run.claims.filter((c) => c.attemptId === attempt.attemptId).length === 0);
  t.check("the reader whose answer fitted was unaffected, and its claims stand",
    other.state === "completed" && run.claims.some((c) => c.taskId === other.taskId), `${other.state}`);
  t.check("a subject read once is not called read: it is held for a person and the run ends partial",
    run.disagreements.some((d) => d.kind === "coverage" && d.state === "needs_human") && run.report.workflow.state === "partial",
    run.report.workflow.state);
}

/* ══════════════════════════════ attempts per task ═══════════════════════ */

t.section("maximumAttemptsPerTask: a task that has spent its attempts is failed known, not tried again");
{
  const w = world({ seed: "budgets/attempts", sources: 2, policy: { maximumAttemptsPerTask: 1 } });
  await w.scheduler.plan();
  const [ingest, other] = (await w.repo.listTasks(w.wf)).sort((a, b) => a.taskId.localeCompare(b.taskId));
  await w.repo.createAttempt({
    attemptId: entityId("attempt", ingest.taskId, 1), workflowId: w.wf, taskId: ingest.taskId, attemptNo: 1,
    roleKey: ingest.roleKey, roleVersion: ingest.roleVersion, executorKind: "deterministic", executorFamily: "deterministic",
    independenceDomain: "domain:earlier", modelConfiguration: "code", state: "failed_known", leaseToken: null,
    packetFingerprint: "", packetBytes: 0, providerRequestId: null, modelReported: null, usage: {}, rawResult: null,
    rawResultHash: null, validationState: "not_applicable", validationProblems: [], errorCode: "earlier_failure",
    errorMessage: "an earlier worker tried this once", reconciliationOutcome: null,
  });
  const run = await drive(w);
  const after = await w.repo.getTask(ingest.taskId);
  const attempts = await attemptsOf(w.repo, after);

  t.check("the task with as many prior attempts as the policy allows fails known with reason attempt_limit",
    after.state === "failed_known" && after.terminalReason === "attempt_limit", `${after.state}/${after.terminalReason}`);
  t.check("no second attempt was made", attempts.length === 1 && attempts[0].attemptNo === 1, `${attempts.length} attempts`);
  t.check("nothing was sent for it, though the run went on sending for everything else",
    !w.registry.packetsSeen.some((p) => p.taskId === ingest.taskId) && w.registry.packetsSeen.some((p) => p.taskId === other.taskId),
    `${w.registry.packetsSeen.length} packets sent in the run`);
  t.check("the other source, with attempts to spend, was read normally",
    (await w.repo.getTask(other.taskId)).state === "completed", (await w.repo.getTask(other.taskId)).state);
  t.check("the limit is audited with the count of attempts already spent",
    run.audit.some((a) => a.action === "core_v2.task.attempt_limit" && a.entityId === ingest.taskId && a.detail.attempts === 1));
}

/* ══════════════════════════════ concurrency ═════════════════════════════ */

t.section("maximumConcurrentTasksPerWorkflow and maximumConcurrentTasksPerRole: one at a time when the limit says one");
{
  const one = world({ seed: "budgets/concurrency", sheets: 2, policy: { maximumConcurrentTasksPerWorkflow: 1 } });
  await one.scheduler.plan();
  const runOne = await drive(one);
  t.check("with room for one task in the workflow, no tick ever dispatches two",
    runOne.ticks.every((r) => r.dispatched.length <= 1), runOne.ticks.map((r) => r.dispatched.length).join(""));
  t.check("work still went out, one assignment at a time", runOne.ticks.filter((r) => r.dispatched.length === 1).length >= 4);
  t.check("the whole workflow still finishes, one assignment at a time", runOne.report.workflow.state === "completed", runOne.report.workflow.state);

  const perRole = world({ seed: "budgets/concurrency", sheets: 2, policy: { maximumConcurrentTasksPerWorkflow: 8, maximumConcurrentTasksPerRole: 1 } });
  await perRole.scheduler.plan();
  const runRole = await drive(perRole);
  const roleOf = new Map(runRole.tasks.map((x) => [x.taskId, x.roleKey]));
  const rolesIn = (report) => report.dispatched.map((id) => roleOf.get(id));
  t.check("with one slot per role, no tick dispatches two tasks of one role",
    runRole.ticks.every((r) => new Set(rolesIn(r)).size === r.dispatched.length),
    runRole.ticks.map((r) => rolesIn(r).join("+")).filter(Boolean).join(" | ").slice(0, 120));
  t.check("the workflow's own limit was not the binding one: some tick dispatched two tasks, of two different roles",
    runRole.ticks.some((r) => r.dispatched.length > 1));
  t.check("the whole workflow still finishes with one slot per role", runRole.report.workflow.state === "completed", runRole.report.workflow.state);

  const free = world({ seed: "budgets/concurrency", sheets: 2 });
  await free.scheduler.plan();
  const runFree = await drive(free);
  const roleOfFree = new Map(runFree.tasks.map((x) => [x.taskId, x.roleKey]));
  t.check("under the default policy two tasks of one role do run together — the per-role limit is what held them apart",
    runFree.ticks.some((r) => new Set(r.dispatched.map((id) => roleOfFree.get(id))).size < r.dispatched.length));
}

/* ══════════════════════════════ timed-out executions ════════════════════ */

t.section("maximumTimedOutExecutions: a slot is not free while a provider may still be working");
{
  /* One reader that never answers and never honours the abort: its attempt
     times out and the execution is still counted. Real time, 10 ms each. */
  const hangs = (packet, base) => (packet.roleKey === "note_reader" ? new Promise(() => {}) : base);
  const hungWorld = (maximumTimedOutExecutions) => world({
    seed: "budgets/timeouts", sheets: 2, scripts: { "reader-family-one": hangs },
    policy: { attemptTimeoutMs: 10, maximumTimedOutExecutions, maximumConcurrentTasksPerWorkflow: 2 },
  });
  const untilHung = async (w) => {
    for (let i = 0; i < 12; i++) {
      await w.scheduler.tick();
      if (w.scheduler.inFlight.size > 0) return true;
    }
    return false;
  };

  const w = hungWorld(1);
  await w.scheduler.plan();
  const hung = await untilHung(w);
  t.check("a reading that never came back left one execution in flight, timed out", hung && w.scheduler.inFlight.size === 1
    && [...w.scheduler.inFlight.values()].every((f) => f.timedOut), `${w.scheduler.inFlight.size} in flight`);
  const timedOutTask = await w.repo.getTask([...w.scheduler.inFlight.values()][0].taskId);
  t.check("its task is outcome_unknown for the deadline, never retried",
    timedOutTask.state === "outcome_unknown" && timedOutTask.terminalReason === "attempt_timeout", `${timedOutTask.state}/${timedOutTask.terminalReason}`);
  const queued = await w.repo.getRunnableTasks(w.wf);
  const blocked = await w.scheduler.tick();
  t.check("there is other work waiting to be dispatched", queued.length >= 1, `${queued.length} runnable`);
  t.check("with the timed-out execution at the limit, the next tick dispatches nothing at all",
    blocked.dispatched.length === 0, blocked.dispatched.join(", "));

  const roomier = hungWorld(2);
  await roomier.scheduler.plan();
  const hungAgain = await untilHung(roomier);
  const dispatches = await roomier.scheduler.tick();
  t.check("with room for two timed-out executions the next tick does dispatch — the number is what stopped the other run",
    hungAgain && roomier.scheduler.inFlight.size === 1 && dispatches.dispatched.length >= 1,
    `${roomier.scheduler.inFlight.size} in flight, dispatched ${dispatches.dispatched.length}`);
}

/* ══════════════════════════════ disagreements per subject ═══════════════ */

t.section("maximumVerifiedDisagreementsPerSubject: past the limit the rest go to a person");
{
  const misreadsTwo = (packet, base) => {
    if (packet.roleKey !== "table_reader" || packet.independenceGroup !== INDEPENDENCE_GROUPS[1]) return base;
    for (const c of base.claims) {
      if (c.subjectKey === "entry/E-001" || c.subjectKey === "entry/E-002") {
        c.value = { ...c.value, quantity: c.value.quantity + 5, text: `${c.value.quantity + 5} ${c.unit}` };
      }
    }
    return base;
  };
  const w = world({ seed: "budgets/many-disagreements", entries: 3, scripts: { "reader-family-two": misreadsTwo },
    policy: { maximumVerifiedDisagreementsPerSubject: 1 } });
  await w.scheduler.plan();
  const run = await drive(w);
  const values = run.disagreements.filter((d) => d.kind === "value");
  const verified = values.filter((d) => run.tasks.some((x) => x.disagreementId === d.disagreementId));
  const held = values.filter((d) => !run.tasks.some((x) => x.disagreementId === d.disagreementId));

  t.check("the two readers disagreed about two entries of one subject", values.length === 2, `${values.length} value disagreements`);
  t.check("exactly one of them was sent to a verifier and an arbiter", verified.length === 1, `${verified.length} verified`);
  t.check("the one past the limit was given no verifier and no arbiter at all", held.length === 1
    && !run.tasks.some((x) => x.disagreementId === held[0]?.disagreementId));
  t.check("the one past the limit is held for a person, and the reason names the limit",
    held[0]?.state === "needs_human" && /exceed the 1 the policy verifies/.test(held[0]?.needsHumanReason ?? ""), held[0]?.needsHumanReason);
  t.check("a hold decision stands beside it, needing a person",
    run.decisions.some((d) => d.disagreementId === held[0]?.disagreementId && d.decisionType === "hold" && d.status === "needs_human"));
  t.check("neither reading of the held entry was ever accepted by machine",
    every(run.claims.filter((c) => held[0]?.claimIds.includes(c.claimId)), (c) => c.status !== "accepted"),
    run.claims.filter((c) => held[0]?.claimIds.includes(c.claimId)).map((c) => c.status).join(", "));
  t.check("the run ends partial, with a subject waiting for a person", run.report.workflow.state === "partial", run.report.workflow.state);
}

/* ══════════════════════════════ independent readers ═════════════════════ */

t.section("maximumIndependentReadersPerSubject: a subject already read that many times gets a person, not a third reader");
{
  const misreads = (packet, base) => {
    if (packet.roleKey !== "table_reader" || packet.independenceGroup !== INDEPENDENCE_GROUPS[1]) return base;
    for (const c of base.claims) if (c.subjectKey === "entry/E-001") c.value = { ...c.value, quantity: c.value.quantity + 7, text: `${c.value.quantity + 7} ${c.unit}` };
    return base;
  };
  const w = world({ seed: "budgets/readers", entries: 3, scripts: { "reader-family-two": misreads } });
  await w.scheduler.plan();
  const run = await drive(w);
  const verifier = ofType(run.tasks, KERNEL_TASK_TYPES.verifyDisagreement).find((x) => x.disagreementId !== null);
  const segments = await w.repo.listSegments(w.wf);
  const ctx = { repo: w.repo, lookup: lookupOf(w.truth.manifest, segments), registry: registryOfRoles, pack, policy: w.policy };
  const request = [{
    actionType: "request_independent_reader", reasonCode: "one more reading of the disputed place", targetSegmentIds: [],
    expectedInformation: "a third independent reading", parentTaskId: verifier?.taskId, currentDepth: verifier?.depth ?? 0,
    idempotencyFingerprint: "third-reader",
  }];

  t.check("a disagreement was opened and a verifier was given it — the role that may ask for another reader",
    verifier !== undefined && verifier.roleKey === "disagreement_verifier");
  const subject = run.tasks.filter((x) => x.taskType === TASK.readTable && x.independenceGroup !== null);
  t.check("the disputed subject already has the two independent readers the policy allows",
    new Set(subject.map((x) => x.independenceGroup)).size === w.policy.maximumIndependentReadersPerSubject);

  const refusedPlan = await planFollowUps(verifier, request, ctx);
  t.check("asking for another reader makes no task", refusedPlan.children.length === 0);
  t.check("it goes to a person, and the escalation names the readers already had",
    refusedPlan.escalations.length === 1 && /already has 2 independent readers/.test(refusedPlan.escalations[0].reason), refusedPlan.escalations[0]?.reason);

  const roomier = await planFollowUps(verifier, request, { ...ctx, policy: policyWith({ maximumIndependentReadersPerSubject: 3 }) });
  t.check("with room for a third reader the same request becomes one blind reading in a group nobody used",
    roomier.children.length === 1 && roomier.children[0].independenceGroup === INDEPENDENCE_GROUPS[2] && roomier.escalations.length === 0,
    `${roomier.children.length} children in ${roomier.children[0]?.independenceGroup}`);
}

/* ══════════════════════════════ rounds of criticism ═════════════════════ */

/* A verifier that cannot read the source and asks for one more place. */
function cannotRead(repoRef) {
  let asked = 0;
  return async (packet, base) => {
    if (packet.roleKey !== "disagreement_verifier") return base;
    const segments = await repoRef.value.listSegments(packet.workflowId);
    const elsewhere = segments.find((s) => s.segmentKind === "note" && s.status === "accepted" && s.parentSegmentId === packet.sources[0]?.parentSegmentId);
    asked += 1;
    base.outcome = "insufficient_evidence";
    base.assessments = [];
    base.anchors = [];
    base.requestedActions = elsewhere ? [{
      actionType: "read_related_segment", reasonCode: "the disputed place is not legible", targetSegmentIds: [elsewhere.segmentId],
      expectedInformation: "what the neighbouring place shows", parentTaskId: packet.taskId, currentDepth: packet.context.depth,
      idempotencyFingerprint: `another-look-${asked}`,
    }] : [];
    return base;
  };
}

const misreadsOne = (packet, base) => {
  if (packet.roleKey !== "table_reader" || packet.independenceGroup !== INDEPENDENCE_GROUPS[1]) return base;
  for (const c of base.claims) if (c.subjectKey === "entry/E-001") c.value = { ...c.value, quantity: c.value.quantity + 3, text: `${c.value.quantity + 3} ${c.unit}` };
  return base;
};

async function disputeWorld(seed, policy, extraScripts = {}) {
  const repoRef = { value: null };
  const w = world({
    seed, entries: 3, policy,
    scripts: { "reader-family-two": misreadsOne, "critic-family-one": cannotRead(repoRef), "critic-family-two": cannotRead(repoRef), ...extraScripts },
  });
  repoRef.value = w.repo;
  await w.scheduler.plan();
  return { w, run: await drive(w) };
}

t.section("maximumCriticRounds: one more round of criticism, and then a person");
{
  const one = await disputeWorld("budgets/critic-rounds", { maximumCriticRounds: 1 });
  const dispute = one.run.disagreements.find((d) => d.kind === "value");
  const verifiers = ofType(one.run.tasks, KERNEL_TASK_TYPES.verifyDisagreement).filter((x) => x.disagreementId === dispute?.disagreementId);
  t.check("the verifier could not read the source and asked for one more place", dispute !== undefined && verifiers.length >= 1);
  t.check("with one round allowed, the disagreement's criticRounds stands at exactly one", dispute?.criticRounds === 1, String(dispute?.criticRounds));
  t.check("no follow-up verification was admitted at the limit", (dispute?.followUps ?? []).length === 0, `${(dispute?.followUps ?? []).length} follow-ups`);
  t.check("the disagreement goes to a person, and the reason counts the rounds",
    dispute?.state === "needs_human" && /1 rounds of criticism could not read the source/.test(dispute?.needsHumanReason ?? ""), dispute?.needsHumanReason);
  t.check("exactly one verification task was ever made for it", verifiers.length === 1, `${verifiers.length} verification tasks`);

  const two = await disputeWorld("budgets/critic-rounds", { maximumCriticRounds: 2 });
  const dispute2 = two.run.disagreements.find((d) => d.kind === "value");
  const verifiers2 = ofType(two.run.tasks, KERNEL_TASK_TYPES.verifyDisagreement).filter((x) => x.disagreementId === dispute2?.disagreementId);
  t.check("with two rounds allowed the first insufficient answer buys exactly one more verification",
    (dispute2?.followUps ?? []).length === 1 && verifiers2.length === 2,
    `${(dispute2?.followUps ?? []).length} follow-ups, ${verifiers2.length} verification tasks`);
  t.check("that one follow-up is recorded under round one, with the task it created",
    dispute2?.followUps[0]?.round === 1 && verifiers2.some((x) => x.taskId === dispute2?.followUps[0]?.taskId),
    canonical(dispute2?.followUps ?? []));
  t.check("the second round of criticism ends it: criticRounds is two and the dispute is a person's",
    dispute2?.criticRounds === 2 && dispute2?.state === "needs_human" && /2 rounds of criticism/.test(dispute2?.needsHumanReason ?? ""),
    `${dispute2?.criticRounds} / ${dispute2?.needsHumanReason}`);
  t.check("neither reading of the disputed entry was settled by machine",
    every(two.run.claims.filter((c) => dispute2?.claimIds.includes(c.claimId)), (c) => c.status === "unresolved" || c.status === "disputed"),
    two.run.claims.filter((c) => dispute2?.claimIds.includes(c.claimId)).map((c) => c.status).join(", "));
}

/* ══════════════════════════════ rounds of arbitration ═══════════════════ */

/* An arbiter that always wants more evidence. */
function asksAgain(fingerprint) {
  let round = 0;
  return (packet, base) => {
    if (packet.roleKey !== "evidence_arbiter") return base;
    round += 1;
    base.adjudication = {
      outcome: "needs_more_evidence", disagreementId: packet.context.disagreements[0]?.disagreementId ?? "",
      acceptedClaimRef: null, correctedValue: null, correctedUnit: null, evidenceAnchorIds: [],
      rationale: "the source as reopened does not settle this; one more reading of the disputed place is asked for",
      followUp: {
        actionType: "request_disagreement_verification", reasonCode: "one more reading of the disputed place", targetSegmentIds: [],
        expectedInformation: "what the source shows at the disputed place", parentTaskId: packet.taskId,
        currentDepth: packet.context.depth, idempotencyFingerprint: fingerprint(round),
      },
    };
    return base;
  };
}

async function arbitrationWorld(seed, policy, fingerprint) {
  const w = world({ seed, entries: 3, policy, scripts: { "reader-family-two": misreadsOne, "arbiter-family-one": asksAgain(fingerprint) } });
  await w.scheduler.plan();
  return { w, run: await drive(w) };
}

t.section("maximumArbiterRounds: the rounds are counted, and the last one goes to a person");
{
  const two = await arbitrationWorld("budgets/arbiter-rounds", { maximumArbiterRounds: 2 }, (n) => `more-evidence-${n}`);
  const dispute = two.run.disagreements.find((d) => d.kind === "value");
  const arbiters = ofType(two.run.tasks, KERNEL_TASK_TYPES.adjudicate).filter((x) => x.disagreementId === dispute?.disagreementId);
  t.check("the arbiter asked for more evidence and was given one more round", dispute !== undefined && arbiters.length === 2, `${arbiters.length} adjudications`);
  t.check("arbiterRounds equals the limit exactly — no round beyond it was counted", dispute?.arbiterRounds === 2, String(dispute?.arbiterRounds));
  t.check("the disagreement ends needing a person, and the reason counts the rounds of arbitration",
    dispute?.state === "needs_human" && /2 rounds of arbitration asked for more evidence/.test(dispute?.needsHumanReason ?? ""), dispute?.needsHumanReason);
  t.check("exactly one follow-up was admitted, and its round number is its own",
    (dispute?.followUps ?? []).length === 1 && new Set((dispute?.followUps ?? []).map((f) => f.round)).size === (dispute?.followUps ?? []).length,
    canonical(dispute?.followUps ?? []));
  t.check("no claim of the disputed entry was accepted by machine",
    every(two.run.claims.filter((c) => dispute?.claimIds.includes(c.claimId)), (c) => c.status !== "accepted"),
    two.run.claims.filter((c) => dispute?.claimIds.includes(c.claimId)).map((c) => c.status).join(", "));
  t.check("the run ends partial", two.run.report.workflow.state === "partial", two.run.report.workflow.state);
}

t.section("the rounds of criticism bound the arbiter too: it cannot buy verification it has spent");
{
  const three = await arbitrationWorld("budgets/critic-bounds-arbiter", { maximumArbiterRounds: 3 }, (n) => `more-evidence-${n}`);
  const dispute = three.run.disagreements.find((d) => d.kind === "value");
  t.check("with three rounds of arbitration allowed but two of criticism, the criticism ceiling is what stops it",
    dispute?.state === "needs_human" && /has had 2 rounds of criticism/.test(dispute?.needsHumanReason ?? ""), dispute?.needsHumanReason);
  t.check("it stopped inside the arbitration ceiling, so that ceiling is not what refused it",
    (dispute?.arbiterRounds ?? 0) < 3 && dispute?.criticRounds === 2, `${dispute?.arbiterRounds} arbitration, ${dispute?.criticRounds} criticism`);
  t.check("the one round that did buy a verification bought exactly one, and no round bought two",
    (dispute?.followUps ?? []).length === 1 && new Set((dispute?.followUps ?? []).map((f) => f.round)).size === 1, canonical(dispute?.followUps ?? []));
}

t.section("exactly one additional verification request per disagreement round");
{
  const many = await arbitrationWorld("budgets/one-per-round", { maximumArbiterRounds: 3, maximumCriticRounds: 6 }, (n) => `more-evidence-${n}`);
  const dispute = many.run.disagreements.find((d) => d.kind === "value");
  const followUps = dispute?.followUps ?? [];
  t.check("with room for three rounds of arbitration, three arbitrations were made and counted",
    dispute?.arbiterRounds === 3 && ofType(many.run.tasks, KERNEL_TASK_TYPES.adjudicate).filter((x) => x.disagreementId === dispute?.disagreementId).length === 3,
    `${dispute?.arbiterRounds} rounds`);
  t.check("each round that asked bought exactly one verification: as many follow-ups as rounds that asked, no round twice",
    followUps.length === 2 && new Set(followUps.map((f) => f.round)).size === followUps.length, canonical(followUps));
  t.check("every admitted follow-up names the verification task it created, and each is a task of the record",
    every(followUps, (f) => f.taskId !== null && many.run.tasks.some((x) => x.taskId === f.taskId && x.taskType === KERNEL_TASK_TYPES.verifyDisagreement)),
    canonical(followUps.map((f) => f.taskId)));
  t.check("the third round ends it: the disagreement is a person's, and the reason counts the rounds of arbitration",
    dispute?.state === "needs_human" && /3 rounds of arbitration asked for more evidence/.test(dispute?.needsHumanReason ?? ""), dispute?.needsHumanReason);
}

t.section("the repository itself refuses a second follow-up in one round");
{
  const b = await bareRepo("follow-ups");
  const disagreementId = entityId("disagreement", b.workflowId, "one-per-round");

  /* One task, one submitted attempt, one commit — the shape the scheduler
     uses when a verifier or an arbiter asks for one more reading. */
  const asks = async (name, followUps, disagreements = []) => {
    const task = (await b.repo.admitTasks(b.workflowId, [b.task(name)], LIMITS)).created[0];
    await b.repo.transitionTask(task.taskId, "created", "queued");
    const leased = await b.repo.leaseTask(task.taskId, "worker-1", 60_000, 1_000);
    await b.repo.transitionTask(task.taskId, "leased", "running");
    const attemptId = entityId("attempt", task.taskId, 1);
    await b.repo.createAttempt({
      attemptId, workflowId: b.workflowId, taskId: task.taskId, attemptNo: 1, roleKey: task.roleKey, roleVersion: task.roleVersion,
      executorKind: "model", executorFamily: "reader-family-one", independenceDomain: "domain:one", modelConfiguration: "x",
      state: "prepared", leaseToken: leased.leaseToken, packetFingerprint: "f", packetBytes: 10, providerRequestId: null,
      modelReported: null, usage: {}, rawResult: null, rawResultHash: null, validationState: "pending", validationProblems: [],
      errorCode: null, errorMessage: null, reconciliationOutcome: null,
    });
    const submitted = await b.repo.submitAttempt(attemptId, leased.leaseToken, 2_000);
    if (!submitted.ok) throw new Error(`fixture: submission refused: ${submitted.reason}`);
    return b.repo.commitValidatedResult({
      workflowId: b.workflowId, taskId: task.taskId, attemptId,
      attempt: { to: "succeeded", validationState: "valid", validationProblems: [], rawResult: { outcome: "completed" }, rawResultHash: sha256(`raw:${name}`), errorCode: null, errorMessage: null },
      task: { to: "completed", reason: null }, segments: [], claims: [], assessments: [], disagreements,
      claimTransitions: [], disagreementRounds: [], disagreementTransitions: [], decisions: [], children: [], dependencies: [],
      followUps, taskTransitions: [], audits: [], limits: LIMITS,
    });
  };

  const first = await asks("asks-twice-in-one-round", [
    { disagreementId, round: 1, fingerprint: "first-ask", taskId: null },
    { disagreementId, round: 1, fingerprint: "second-ask", taskId: null },
  ], [{ disagreementId, workflowId: b.workflowId, disagreementKey: "one-per-round", kind: "value", severity: "material", subjectSignature: { subject_key: "subject/asks" }, claimIds: [] }]);
  const stored = await b.repo.getDisagreement(disagreementId);
  t.check("the first follow-up of the round is admitted", stored.followUps.length === 1 && stored.followUps[0].fingerprint === "first-ask", canonical(stored.followUps));
  t.check("the second follow-up of the same round is refused, and the refusal names the round",
    first.followUpsRefused.length === 1 && first.followUpsRefused[0].round === 1 && /round 1 already has its one follow-up/.test(first.followUpsRefused[0].reason),
    first.followUpsRefused[0]?.reason);

  const again = await asks("asks-the-same-again", [{ disagreementId, round: 2, fingerprint: "first-ask", taskId: null }]);
  t.check("the same request under a later round number is refused too — a fingerprint asked once is not asked again",
    again.followUpsRefused.length === 1 && /the same follow-up was already admitted/.test(again.followUpsRefused[0].reason), again.followUpsRefused[0]?.reason);
  t.check("after both refusals the disagreement still holds exactly its one follow-up",
    (await b.repo.getDisagreement(disagreementId)).followUps.length === 1, canonical((await b.repo.getDisagreement(disagreementId)).followUps));

  const next = await asks("asks-in-the-next-round", [{ disagreementId, round: 2, fingerprint: "a-different-ask", taskId: null }]);
  t.check("a different request in the next round is admitted — one per round, and the round is what counts",
    next.followUpsRefused.length === 0 && (await b.repo.getDisagreement(disagreementId)).followUps.length === 2,
    canonical((await b.repo.getDisagreement(disagreementId)).followUps));
}

t.section("the same request twice is a person's business, whatever rounds remain");
{
  const repeat = await arbitrationWorld("budgets/same-fingerprint", { maximumArbiterRounds: 3 }, () => "the-same-evidence");
  const dispute = repeat.run.disagreements.find((d) => d.kind === "value");
  t.check("asking for the same evidence again escalates immediately, whatever rounds are left",
    dispute?.state === "needs_human" && /asked for the same evidence again/.test(dispute?.needsHumanReason ?? ""), dispute?.needsHumanReason);
  t.check("the repeated request bought no second follow-up", (dispute?.followUps ?? []).length === 1, `${(dispute?.followUps ?? []).length} follow-ups`);
  t.check("it stopped inside the round ceiling, so the ceiling is not what refused it",
    (dispute?.arbiterRounds ?? 0) <= 2 && (dispute?.arbiterRounds ?? 0) < 3, String(dispute?.arbiterRounds));
  t.check("the audit records the dispute going to a person",
    repeat.run.audit.some((a) => a.action === "core_v2.disagreement.needs_human" && a.entityId === dispute?.disagreementId));
}

/* ══════════════════════════════ what a spec may not name ════════════════ */

t.section("role.maximumSources and the policy's own: a spec too big is refused before any id is minted");
{
  const truth = syntheticRecordSet({ seed: "budgets/specs", sources: 3, sheetsPerSource: 1, entriesPerTable: 2 });
  const wf = truth.manifest.workflowId;
  const lookup = lookupOf(truth.manifest, []);
  const ids = truth.manifest.sources.map((s) => s.sourceId);
  const spec = (over) => ({
    key: "spec", phase: "verify", taskType: KERNEL_TASK_TYPES.verifyClaim, roleKey: "evidence_critic", subjectKey: "subject/one",
    sources: [], independenceGroup: null, priority: 100, dependsOn: [], dependsOnTaskIds: [], ...over,
  });

  const tooManyForTheRole = specsToTasks([spec({
    phase: "analyze", taskType: TASK.readTable, roleKey: "table_reader", independenceGroup: INDEPENDENCE_GROUPS[0],
    sources: ids.slice(0, 2).map((sourceId) => ({ sourceId, segmentId: null })),
  })], wf, lookup, registryOfRoles, DEFAULT_POLICY);
  t.check("a spec naming more sources than its role may read is refused, and no task is made",
    tooManyForTheRole.tasks.length === 0 && tooManyForTheRole.refusals.length === 1 && /2 sources exceeds table_reader's 1/.test(tooManyForTheRole.refusals[0]),
    tooManyForTheRole.refusals[0]);

  const tooManyForThePolicy = specsToTasks([spec({ sources: ids.slice(0, 2).map((sourceId) => ({ sourceId, segmentId: null })) })],
    wf, lookup, registryOfRoles, policyWith({ maximumPacketSources: 1 }));
  t.check("a spec within its role's limit but past the policy's is refused too",
    tooManyForThePolicy.tasks.length === 0 && /2 sources exceeds the policy's 1/.test(tooManyForThePolicy.refusals[0] ?? ""), tooManyForThePolicy.refusals[0]);

  const everySource = specsToTasks([spec({ sources: ids.map((sourceId) => ({ sourceId, segmentId: null })) })], wf, lookup, registryOfRoles, DEFAULT_POLICY);
  t.check("a spec naming every source of the workflow is refused — one assignment over the whole set is the shape the kernel replaces",
    everySource.tasks.length === 0 && /one assignment over every source of the workflow/.test(everySource.refusals[0] ?? ""), everySource.refusals[0]);

  const bounded = specsToTasks([spec({ sources: [{ sourceId: ids[0], segmentId: null }] })], wf, lookup, registryOfRoles, DEFAULT_POLICY);
  t.check("a bounded spec over one source of three is admitted — the size is what refused the others",
    bounded.tasks.length === 1 && bounded.refusals.length === 0);
}

/* ══════════════════════════════ every door stayed closed ════════════════ */

t.section("every door stayed closed");
t.check("nothing in this file tried the network", tripped() === 0, `${tripped()} attempts`);

t.finish();
