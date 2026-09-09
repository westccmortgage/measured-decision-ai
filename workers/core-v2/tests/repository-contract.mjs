/* THE REPOSITORY CONTRACT, RUN TWICE.
 *
 * One suite of checks written against OrchestrationRepository and nothing
 * else, run first against the in-memory double and then against the Postgres
 * adapter on a throwaway cluster. Same assertions, same order; both must say
 * ALL OK, or the two repositories disagree about what is legal.
 *
 * Every id is derived (kernel/ids.ts), every record is built by hand, and
 * nothing here names a client, a document of anybody's, or a provider. The
 * Postgres leg needs a unix socket to a local cluster, so this test does not
 * seal the network the way the engine's dry-run tests do.
 */
import { harness } from "./harness.mjs";
import { InMemoryOrchestrationRepository } from "../kernel/memory-repository.ts";
import { PostgresOrchestrationRepository } from "../postgres/repository.ts";
import { withThrowawayDatabase } from "./postgres-harness.mjs";
import { canonical, entityId, sha256 } from "../kernel/ids.ts";
import { ENGINE_VERSION } from "../kernel/contracts.ts";
import { IllegalTransition, StaleState } from "../kernel/transitions.ts";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const same = (a, b) => canonical(a) === canonical(b);
const sorted = (xs) => [...xs].sort();
const ids = (records, key) => sorted(records.map((r) => r[key]));
const LIMITS = { maximumTasks: 50, maximumEdges: 100, maximumChildrenPerParent: 4, maximumDepth: 3 };
const BUDGET = { maximum_tasks: 50, maximum_dependency_edges: 100, maximum_child_tasks_per_parent: 4, maximum_follow_up_depth: 3, maximum_critic_rounds: 2, maximum_arbiter_rounds: 2 };
const TINY_TTL = 1;      /* a lease that has run out by the time anybody looks */
const LONG_TTL = 60_000;
const SETTLE = 40;       /* longer than TINY_TTL by a wide margin */

/* ─────────────────────────────────────────────── records, built by hand */

function fixtures(organizationId) {
  const wfId = (n) => entityId("workflow", "contract", n);
  const srcId = (n, ordinal) => entityId("source", "contract", n, ordinal);
  const workflow = (n, over = {}) => ({
    workflowId: wfId(n), organizationId, domainPack: "synthetic", domainPackVersion: "1", workflowType: "register-reading", engineVersion: ENGINE_VERSION,
    state: "created", sourceSetFingerprint: sha256(`sources:${n}`), requestFingerprint: sha256(`request:${n}`), requestedScope: { scope: `scope-${n}` },
    budget: BUDGET, cancelRequestedAt: null, totalUnits: 0, completedUnits: 0, attentionUnits: 0, errorCode: null, errorMessage: null, ...over,
  });
  const sources = (n) => [
    { sourceId: srcId(n, 0), ordinal: 0, sourceKind: "document", label: "synthetic register", uri: `fixture://synthetic/${n}/register`, contentHash: `hash-register-${n}`,
      hashAlgorithm: "sha-256", objectVersionId: null, byteSize: 20480, media: { page_count: 2 },
      declaredSegments: [{ sourceId: srcId(n, 0), parentSegmentId: null, segmentKind: "page", label: "page 1", ordinal: 0, locator: { bbox: [0, 0, 1, 1] }, contentHash: `hash-page-${n}` }] },
    { sourceId: srcId(n, 1), ordinal: 1, sourceKind: "recording", label: "synthetic recording", uri: `fixture://synthetic/${n}/recording`, contentHash: `hash-recording-${n}`,
      hashAlgorithm: "sha-256", objectVersionId: null, byteSize: 655360, media: { duration_ms: 120000 }, declaredSegments: [] },
  ];
  const task = (n, key, over = {}) => ({
    taskId: entityId("task", wfId(n), key), workflowId: wfId(n), parentTaskId: null, createdByTaskId: null, phase: "analyze", taskType: "synthetic:read",
    roleKey: "reader", roleVersion: "1", subjectKey: `subject:${key}`, priority: 100, sources: [{ sourceId: srcId(n, 0), segmentId: null }],
    inputFingerprint: sha256(`input:${key}`), contractVersion: "c1", independenceGroup: null, depth: 0, criticRound: 0, arbiterRound: 0,
    disagreementId: null, targetClaimIds: [], maxClaims: 10, dependsOn: [], ...over,
  });
  const attempt = (t, no, over = {}) => ({
    attemptId: entityId("attempt", t.taskId, no), workflowId: t.workflowId, taskId: t.taskId, attemptNo: no, roleKey: "reader", roleVersion: "1",
    executorKind: "model", executorFamily: "family-a", independenceDomain: "domain-a", modelConfiguration: "", state: "prepared", leaseToken: null,
    packetFingerprint: sha256(`packet:${t.taskId}:${no}`), packetBytes: 100, providerRequestId: null, modelReported: null, usage: {},
    providerStopReason: null, providerDurationMs: null, providerResponse: null, rawResult: null,
    rawResultHash: null, validationState: "pending", validationProblems: [], errorCode: null, errorMessage: null, reconciliationOutcome: null, ...over,
  });
  const segment = (n, key, over = {}) => {
    const s = { workflowId: wfId(n), sourceId: srcId(n, 0), parentSegmentId: null, segmentKind: "page", label: key, ordinal: 0, locator: { bbox: [0, 0, 1, 1] },
      contentHash: `hash-${key}`, status: "accepted", discoveredBy: "deterministic", discoveredByAttemptId: null, ...over };
    return { segmentId: entityId("segment", s.workflowId, s.sourceId, s.parentSegmentId, s.segmentKind, s.contentHash), ...s };
  };
  const anchor = (ownerId, key, segmentId, over = {}) => ({
    anchorId: entityId("anchor", ownerId, key), sourceKind: "segment_locator", sourceId: null, segmentId, locator: { bbox: [0.1, 0.1, 0.5, 0.5] },
    quotedText: "twelve", anchorHash: sha256(canonical([ownerId, key])), ...over,
  });
  const claim = (t, a, key, over = {}) => ({
    claimId: entityId("claim", a.attemptId, key), workflowId: t.workflowId, taskId: t.taskId, attemptId: a.attemptId, independenceGroup: t.independenceGroup,
    independenceDomain: a.independenceDomain, subjectType: "register-line", subjectKey: `subject:${key}`, predicate: "count", value: { known: true, quantity: 12, text: "12" },
    unit: "each", observationBasis: "observed", scope: { part: "whole" }, status: "proposed", machineConfidence: 0.85, inputClaimIds: [], incompleteSourceAttempt: false,
    supersedesClaimId: null, anchors: [], ...over,
  });
  const decision = (n, key, over = {}) => ({
    decisionId: entityId("decision", wfId(n), key), workflowId: wfId(n), taskId: null, disagreementId: null, decisionType: "accept_claim", subjectKey: "subject:alpha",
    title: `${key}: accepted by rule`, status: "proposed", authority: "deterministic_rule", rationale: "two independent readings agree and the source is open",
    riskLevel: "normal", decidedByAttemptId: null, evidence: [], actions: [], summary: null, ...over,
  });
  const commit = (t, a, over = {}) => {
    const rawResult = { outcome: "completed", read: t.subjectKey };
    return {
      workflowId: t.workflowId, taskId: t.taskId, attemptId: a.attemptId,
      attempt: { to: "succeeded", validationState: "valid", validationProblems: [], rawResult, rawResultHash: sha256(canonical(rawResult)), errorCode: null, errorMessage: null },
      task: { to: "completed", reason: null }, segments: [], claims: [], assessments: [], disagreements: [], claimTransitions: [], disagreementRounds: [],
      disagreementTransitions: [], decisions: [], children: [], dependencies: [], followUps: [], taskTransitions: [], audits: [], limits: LIMITS, ...over,
    };
  };
  return { wfId, srcId, workflow, sources, task, attempt, segment, anchor, claim, decision, commit };
}

/* created → queued → leased → running, under a long lease; the token comes back.
   A task another step already queued is picked up where it stands. */
async function bringToRunning(repo, t) {
  const standing = await repo.getTask(t.taskId);
  if (standing.state !== "queued") await repo.transitionTask(t.taskId, standing.state, "queued");
  const leased = await repo.leaseTask(t.taskId, "worker-1", LONG_TTL, Date.now());
  await repo.transitionTask(t.taskId, "leased", "running");
  return leased.leaseToken;
}

/* A running task with one submitted attempt. */
async function submitted(repo, f, t, no = 1, over = {}) {
  const token = await bringToRunning(repo, t);
  const a = await repo.createAttempt(f.attempt(t, no, over));
  const s = await repo.submitAttempt(a.attemptId, token, Date.now());
  if (!s.ok) throw new Error(`fixture: submission refused: ${s.reason}`);
  return { attempt: s.attempt, token };
}

/* ─────────────────────────────────────────────────────────── the suite */

async function suite(h, repo, organizationId) {
  const { check, section } = h;
  const f = fixtures(organizationId);
  const throws = async (label, fn, expect) => {
    try { await fn(); check(label, false, "the call was allowed"); }
    catch (error) {
      const ok = expect ? expect(error) : true;
      check(label, ok, `refused: ${String(error.message ?? error).slice(0, 110)}`);
    }
  };
  const admitted = async (n, key, over = {}) => (await repo.admitTasks(f.wfId(n), [f.task(n, key, over)], LIMITS)).created[0];

  section("workflow: created once, read back, refused with another intent");
  {
    const wf = await repo.createWorkflow(f.workflow(1), f.sources(1));
    check("createWorkflow returns the record", wf.workflowId === f.wfId(1) && wf.state === "created");
    check("getWorkflow returns the same record", same(await repo.getWorkflow(f.wfId(1)), f.workflow(1)));
    const again = await repo.createWorkflow(f.workflow(1), f.sources(1));
    check("createWorkflow is idempotent under the same id and intent", same(again, wf));
    await throws("a different intent under the same id is refused", () => repo.createWorkflow(f.workflow(1, { requestedScope: { scope: "other" } }), f.sources(1)), (e) => /different intent/.test(e.message));
    await throws("a workflow with no sources is refused", () => repo.createWorkflow(f.workflow(90), []), (e) => /names the sources/.test(e.message));
    await throws("a source with neither hash nor version is refused", () => repo.createWorkflow(f.workflow(91), [{ ...f.sources(91)[0], contentHash: null, objectVersionId: null }]), (e) => /not read/.test(e.message));
    const listed = await repo.listSources(f.wfId(1));
    check("listSources returns the sources in order, media and declared segments intact", same(listed, f.sources(1)));
    check("an unknown workflow reads as null", (await repo.getWorkflow(f.wfId(404))) === null);
  }

  section("outbox: claimed once, and claiming moves created → queued");
  {
    check("claimOutbox claims the start command", (await repo.claimOutbox(f.wfId(1), "dispatcher-1")) === true);
    check("the workflow is queued after the claim", (await repo.getWorkflow(f.wfId(1))).state === "queued");
    check("a second claim is refused", (await repo.claimOutbox(f.wfId(1), "dispatcher-2")) === false);
    await repo.acknowledgeOutbox(f.wfId(1));
    check("acknowledgeOutbox on a dispatching command succeeds", true);
    await throws("acknowledging a command that does not exist is refused", () => repo.acknowledgeOutbox(f.wfId(404)), (e) => /no start command/.test(e.message));
    check("claiming an unknown workflow is false", (await repo.claimOutbox(f.wfId(404), "dispatcher-1")) === false);
  }

  section("transitionWorkflow: legal, illegal, stale; progress; cancel once");
  {
    const wf = await repo.transitionWorkflow(f.wfId(1), "queued", "planning");
    check("queued → planning is legal and returned", wf.state === "planning");
    await throws("planning → completed is illegal", () => repo.transitionWorkflow(f.wfId(1), "planning", "completed"), (e) => e instanceof IllegalTransition);
    await throws("a stale view is refused as StaleState", () => repo.transitionWorkflow(f.wfId(1), "queued", "planning"), (e) => e instanceof StaleState);
    await throws("a stale view outranks an illegal move", () => repo.transitionWorkflow(f.wfId(1), "queued", "completed"), (e) => e instanceof StaleState);
    await throws("an unknown workflow cannot move", () => repo.transitionWorkflow(f.wfId(404), "created", "queued"), (e) => /no workflow/.test(e.message));
    const failed = await repo.transitionWorkflow(f.wfId(1), "planning", "failed", { errorCode: "planner_failed", errorMessage: "nothing to read" });
    check("a transition carries its error patch", failed.state === "failed" && failed.errorCode === "planner_failed" && failed.errorMessage === "nothing to read");
    await repo.updateWorkflowProgress(f.wfId(1), { totalUnits: 3, completedUnits: 1, attentionUnits: 2 });
    const progressed = await repo.getWorkflow(f.wfId(1));
    check("updateWorkflowProgress writes the counters", progressed.totalUnits === 3 && progressed.completedUnits === 1 && progressed.attentionUnits === 2);
    await throws("progress of an unknown workflow is refused", () => repo.updateWorkflowProgress(f.wfId(404), { totalUnits: 0, completedUnits: 0, attentionUnits: 0 }));
    const cancelled = await repo.requestCancel(f.wfId(1), 1_700_000_000_000);
    const twice = await repo.requestCancel(f.wfId(1), 1_800_000_000_000);
    check("requestCancel records the first request only", cancelled.cancelRequestedAt === 1_700_000_000_000 && twice.cancelRequestedAt === 1_700_000_000_000);
  }

  section("segments: identity reuse, containment, foreign sources, transitions");
  {
    await repo.createWorkflow(f.workflow(2), f.sources(2));
    const page = f.segment(2, "page-1");
    const first = await repo.persistSegments(f.wfId(2), [page]);
    check("a new segment is created", first.created.length === 1 && first.reused.length === 0 && first.created[0].segmentId === page.segmentId);
    check("getSegment reads it back whole", same(await repo.getSegment(page.segmentId), page));
    const second = await repo.persistSegments(f.wfId(2), [page]);
    check("the same identity is reused, not duplicated", second.created.length === 0 && second.reused.length === 1 && second.reused[0].segmentId === page.segmentId);
    await throws("the same identity naming other work is refused", () => repo.persistSegments(f.wfId(2), [{ ...page, locator: { bbox: [0, 0, 0.5, 0.5] } }]), (e) => /different work/.test(e.message));
    const table = f.segment(2, "table-1", { parentSegmentId: page.segmentId, segmentKind: "table", locator: { bbox: [0.55, 0.05, 0.97, 0.4] } });
    const inside = await repo.persistSegments(f.wfId(2), [table]);
    check("a child inside its parent is created", inside.created.length === 1);
    const outside = f.segment(2, "note-1", { parentSegmentId: page.segmentId, segmentKind: "note", locator: { bbox: [0.5, 0.5, 1, 1] }, status: "proposed" });
    const beyond = f.segment(2, "note-2", { parentSegmentId: table.segmentId, segmentKind: "note", locator: { bbox: [0.5, 0.5, 1, 1] } });
    await throws("a child outside its parent is refused", () => repo.persistSegments(f.wfId(2), [beyond]), (e) => /outside its parent/.test(e.message));
    await throws("a segment of a source the workflow does not read is refused", () => repo.persistSegments(f.wfId(2), [{ ...f.segment(2, "foreign"), sourceId: f.srcId(1, 0) }]), (e) => /does not read/.test(e.message));
    await throws("a segment of another workflow is refused", () => repo.persistSegments(f.wfId(2), [f.segment(1, "elsewhere")]), (e) => /another workflow/.test(e.message));
    await throws("a segment naming a parent that does not exist is refused", () => repo.persistSegments(f.wfId(2), [f.segment(2, "orphan", { parentSegmentId: entityId("segment", "none") })]), (e) => /does not exist/.test(e.message));
    await throws("a malformed locator is refused", () => repo.persistSegments(f.wfId(2), [f.segment(2, "bad", { locator: { bbox: [0, 0, 2, 2] } })]), (e) => /normalised/.test(e.message));
    await repo.persistSegments(f.wfId(2), [outside]);
    const moved = await repo.transitionSegment(outside.segmentId, "proposed", "accepted");
    check("proposed → accepted is legal", moved.status === "accepted");
    await throws("accepted → proposed is illegal", () => repo.transitionSegment(outside.segmentId, "accepted", "proposed"), (e) => e instanceof IllegalTransition);
    await throws("a stale segment view is refused", () => repo.transitionSegment(outside.segmentId, "proposed", "superseded"), (e) => e instanceof StaleState);
    const all = await repo.listSegments(f.wfId(2));
    check("listSegments lists the workflow's segments by ordinal then id", ids(all, "segmentId").length === 3 && same(ids(all, "segmentId"), sorted([page.segmentId, table.segmentId, outside.segmentId])));
    check("listSegments filters by source and status", (await repo.listSegments(f.wfId(2), { sourceId: f.srcId(2, 1) })).length === 0 && (await repo.listSegments(f.wfId(2), { statuses: ["accepted"] })).length === 3);
  }

  section("admitTasks: insert-or-reuse, collisions, budgets, edges");
  {
    await repo.createWorkflow(f.workflow(3), f.sources(3));
    const a = f.task(3, "a");
    const b = f.task(3, "b", { dependsOn: [{ taskId: a.taskId, kind: "requires_completion" }] });
    const first = await repo.admitTasks(f.wfId(3), [a, b], LIMITS);
    check("two tasks are created, one depending on the other", first.created.length === 2 && first.reused.length === 0 && first.refused.length === 0);
    check("a created record reads back whole", same(await repo.getTask(a.taskId), first.created[0]) && first.created[0].state === "created");
    check("the edge is recorded", same(await repo.getDependencies(b.taskId), [{ taskId: b.taskId, dependsOnTaskId: a.taskId, kind: "requires_completion" }]));
    check("the reverse edge is recorded", (await repo.getDependents(a.taskId)).length === 1);
    const again = await repo.admitTasks(f.wfId(3), [a, b], LIMITS);
    check("the same work is reused, not created", again.created.length === 0 && again.reused.length === 2 && same(ids(again.reused, "taskId"), sorted([a.taskId, b.taskId])));
    const renamed = await repo.admitTasks(f.wfId(3), [f.task(3, "a", { taskId: entityId("task", "another-id") })], LIMITS);
    check("the same identity under another id is the same work", renamed.reused.length === 1 && renamed.reused[0].taskId === a.taskId);
    await throws("the same identity naming different work is refused", () => repo.admitTasks(f.wfId(3), [f.task(3, "a", { roleKey: "another-reader" })], LIMITS), (e) => /different work/.test(e.message));
    await throws("a task of another workflow is refused", () => repo.admitTasks(f.wfId(3), [f.task(2, "x")], LIMITS), (e) => /another workflow/.test(e.message));
    await throws("a task depending on itself is refused", () => repo.admitTasks(f.wfId(3), [f.task(3, "self", { dependsOn: [{ taskId: entityId("task", f.wfId(3), "self"), kind: "requires_completion" }] })], LIMITS), (e) => /depend on itself/.test(e.message));
    await throws("a task depending on nothing that exists is refused", () => repo.admitTasks(f.wfId(3), [f.task(3, "dangling", { dependsOn: [{ taskId: entityId("task", "nowhere"), kind: "requires_completion" }] })], LIMITS), (e) => /does not exist/.test(e.message));
    await throws("admitting into an unknown workflow is refused", () => repo.admitTasks(f.wfId(404), [f.task(404, "x")], LIMITS), (e) => /no workflow/.test(e.message));
    /* reuse gains prerequisites while it has not started */
    const c = await admitted(3, "c");
    await repo.transitionTask(c.taskId, "created", "queued");
    const gained = await repo.admitTasks(f.wfId(3), [f.task(3, "c", { dependsOn: [{ taskId: a.taskId, kind: "requires_claims" }] })], LIMITS);
    check("a reused task that has not started gains the dependency it lacked", gained.reused.length === 1 && (await repo.getDependencies(c.taskId)).length === 1);
    /* A task already offered to workers does not run with a dependency
       unmet: queued → blocked is in both transition tables, and both
       repositories make the move. */
    check("a queued task that gains a dependency goes back to waiting", gained.reused[0].state === "blocked", gained.reused[0].state);
    check("and it is no longer offered to a worker", !(await repo.getRunnableTasks(f.wfId(3))).some((x) => x.taskId === c.taskId));
    const runningA = await admitted(3, "d");
    await bringToRunning(repo, runningA);
    await repo.admitTasks(f.wfId(3), [f.task(3, "d", { dependsOn: [{ taskId: a.taskId, kind: "requires_claims" }] })], LIMITS);
    check("nothing is added to a task that has started", (await repo.getDependencies(runningA.taskId)).length === 0);
    const runnable = await repo.getRunnableTasks(f.wfId(3));
    const queued = (await repo.listTasks(f.wfId(3))).filter((x) => x.state === "queued");
    check("getRunnableTasks lists the queued tasks and nothing else", same(ids(runnable, "taskId"), ids(queued, "taskId")) && runnable.every((x) => x.state === "queued"));
    check("listTasks lists the workflow's tasks", (await repo.listTasks(f.wfId(3))).length === 4);
    /* Budgets, each refused rather than thrown. The workflow's stored budget
       is left generous on purpose: the double has no view of it, so what both
       repositories can be held to is the limits the caller passes in. */
    const tight = { maximumTasks: 2, maximumEdges: 1, maximumChildrenPerParent: 1, maximumDepth: 1 };
    await repo.createWorkflow(f.workflow(4), f.sources(4));
    const root = f.task(4, "root");
    const deep = f.task(4, "deep", { depth: 2 });
    const twoEdges = f.task(4, "two-edges", { dependsOn: [{ taskId: root.taskId, kind: "requires_completion" }, { taskId: root.taskId, kind: "requires_claims" }] });
    const r1 = await repo.admitTasks(f.wfId(4), [root, deep, twoEdges], tight);
    check("depth past the limit is refused, with its reason", r1.refused.some((r) => r.task.taskId === deep.taskId && /depth 2 exceeds/.test(r.reason)));
    check("more edges than the ceiling are refused", r1.refused.some((r) => r.task.taskId === twoEdges.taskId && /dependency edges/.test(r.reason)) && r1.created.length === 1);
    const child1 = f.task(4, "child-1", { parentTaskId: root.taskId, createdByTaskId: root.taskId, depth: 1 });
    const child2 = f.task(4, "child-2", { parentTaskId: root.taskId, createdByTaskId: root.taskId, depth: 1 });
    /* room for the tasks, so it is the parent's allowance that refuses the second */
    const r2 = await repo.admitTasks(f.wfId(4), [child1, child2], { ...tight, maximumTasks: 10 });
    check("a second child past the parent's allowance is refused", r2.created.length === 1 && r2.refused.some((r) => r.task.taskId === child2.taskId && /follow-ups/.test(r.reason)));
    const r3 = await repo.admitTasks(f.wfId(4), [f.task(4, "third")], tight);
    check("a task past the workflow's ceiling is refused", r3.created.length === 0 && r3.refused.some((r) => /ceiling of 2 tasks/.test(r.reason)));
    const oneEdge = f.task(4, "one-edge", { dependsOn: [{ taskId: root.taskId, kind: "requires_completion" }] });
    const r4 = await repo.admitTasks(f.wfId(4), [oneEdge], { ...tight, maximumTasks: 10 });
    check("one edge within the ceiling is admitted", r4.created.length === 1 && (await repo.getDependencies(oneEdge.taskId)).length === 1);
    await throws("addDependency past the edge ceiling is refused", () => repo.addDependency(child1.taskId, root.taskId, "requires_completion", tight), (e) => /dependency edges/.test(e.message));
    await repo.addDependency(child1.taskId, root.taskId, "requires_completion", LIMITS);
    check("addDependency is idempotent and records the edge", (await repo.getDependencies(child1.taskId)).length === 1);
    await repo.addDependency(child1.taskId, root.taskId, "requires_completion", LIMITS);
    await throws("addDependency to work under way is refused", async () => { await bringToRunning(repo, r4.created[0]); await repo.addDependency(oneEdge.taskId, child1.taskId, "requires_claims", LIMITS); }, (e) => /under way/.test(e.message));
  }

  section("leases: one grant per lease, a fresh token each, expiry reclaimable");
  {
    await repo.createWorkflow(f.workflow(5), f.sources(5));
    const t = await admitted(5, "leased");
    check("a created task cannot be leased", (await repo.leaseTask(t.taskId, "w1", LONG_TTL, Date.now())) === null);
    await repo.transitionTask(t.taskId, "created", "queued");
    const l1 = await repo.leaseTask(t.taskId, "w1", LONG_TTL, Date.now());
    check("a queued task is leased under a token", l1 !== null && l1.state === "leased" && typeof l1.leaseToken === "string" && l1.leaseOwner === "w1" && l1.leaseExpiresAt > Date.now() - 1000);
    check("a live lease is not granted again", (await repo.leaseTask(t.taskId, "w2", LONG_TTL, Date.now())) === null);
    check("heartbeat under the right token succeeds", (await repo.heartbeatLease(t.taskId, l1.leaseToken, LONG_TTL, Date.now())) === true);
    check("heartbeat under a wrong token fails", (await repo.heartbeatLease(t.taskId, entityId("token", "wrong"), LONG_TTL, Date.now())) === false);
    check("an unknown task cannot be leased", (await repo.leaseTask(entityId("task", "nowhere"), "w1", LONG_TTL, Date.now())) === null);
    const e = await admitted(5, "expiring");
    await repo.transitionTask(e.taskId, "created", "queued");
    const short = await repo.leaseTask(e.taskId, "w1", TINY_TTL, Date.now());
    const prepared = await repo.createAttempt(f.attempt(e, 1));
    await sleep(SETTLE);
    const taken = await repo.leaseTask(e.taskId, "w2", LONG_TTL, Date.now());
    check("an expired lease is reclaimable under a different token", taken !== null && taken.leaseToken !== short.leaseToken && taken.leaseOwner === "w2" && taken.state === "leased");
    const cancelled = await repo.getAttempt(prepared.attemptId);
    check("the prepared attempt under the lost lease is cancelled before submission", cancelled.state === "cancelled_before_submission" && cancelled.errorCode === "lease_expired_before_submission");
    check("heartbeat under the old token fails after the reclaim", (await repo.heartbeatLease(e.taskId, short.leaseToken, LONG_TTL, Date.now())) === false);
    check("the lease clears when the task leaves leased/running", (await repo.transitionTask(e.taskId, "leased", "queued")).leaseToken === null);
  }

  section("submitAttempt: token, expiry, cancellation, workflow state, independence");
  {
    await repo.createWorkflow(f.workflow(6), f.sources(6));
    const t = await admitted(6, "submit");
    const token = await bringToRunning(repo, t);
    const a = await repo.createAttempt(f.attempt(t, 1));
    check("createAttempt returns the record with the task's workflow", same(a, f.attempt(t, 1)) && same(await repo.getAttempt(a.attemptId), a));
    const wrong = await repo.submitAttempt(a.attemptId, entityId("token", "someone-else"), Date.now());
    check("a wrong lease token is refused", wrong.ok === false && /lease/.test(wrong.reason));
    check("an unknown attempt is refused", (await repo.submitAttempt(entityId("attempt", "nowhere"), token, Date.now())).ok === false);
    const ok = await repo.submitAttempt(a.attemptId, token, Date.now());
    check("the right token under an unexpired lease submits", ok.ok === true && ok.attempt.state === "submitted" && ok.attempt.leaseToken === token);
    const twice = await repo.submitAttempt(a.attemptId, token, Date.now());
    check("a submitted attempt is not submitted again", twice.ok === false && /attempt is submitted/.test(twice.reason));
    const notRunning = await admitted(6, "not-running");
    await repo.transitionTask(notRunning.taskId, "created", "queued");
    const nl = await repo.leaseTask(notRunning.taskId, "w1", LONG_TTL, Date.now());
    const na = await repo.createAttempt(f.attempt(notRunning, 1));
    const leasedOnly = await repo.submitAttempt(na.attemptId, nl.leaseToken, Date.now());
    check("a task that is leased but not running is refused", leasedOnly.ok === false && /task is leased/.test(leasedOnly.reason));
    const ex = await admitted(6, "expired");
    await repo.transitionTask(ex.taskId, "created", "queued");
    const el = await repo.leaseTask(ex.taskId, "w1", TINY_TTL, Date.now());
    await repo.transitionTask(ex.taskId, "leased", "running");
    const ea = await repo.createAttempt(f.attempt(ex, 1));
    await sleep(SETTLE);
    const expired = await repo.submitAttempt(ea.attemptId, el.leaseToken, Date.now());
    check("an expired lease is refused", expired.ok === false && /expired/.test(expired.reason));
    await repo.createWorkflow(f.workflow(7), f.sources(7));
    const c = await admitted(7, "cancelled");
    const ct = await bringToRunning(repo, c);
    const ca = await repo.createAttempt(f.attempt(c, 1));
    await repo.requestCancel(f.wfId(7), Date.now());
    const cancelled = await repo.submitAttempt(ca.attemptId, ct, Date.now());
    check("a requested cancellation refuses submission", cancelled.ok === false && /cancellation/.test(cancelled.reason));
    await repo.createWorkflow(f.workflow(8), f.sources(8));
    const inactive = await admitted(8, "inactive");
    const it = await bringToRunning(repo, inactive);
    const ia = await repo.createAttempt(f.attempt(inactive, 1));
    await repo.transitionWorkflow(f.wfId(8), "created", "cancelled");
    const notActive = await repo.submitAttempt(ia.attemptId, it, Date.now());
    check("a workflow that is not active refuses submission", notActive.ok === false && /workflow is cancelled/.test(notActive.reason));
    /* independence: one domain does not read one subject as two groups */
    const g1 = await admitted(6, "shared", { subjectKey: "subject:shared", independenceGroup: "g1" });
    const g2 = await admitted(6, "shared-2", { subjectKey: "subject:shared", independenceGroup: "g2" });
    await submitted(repo, f, g1, 1, { independenceDomain: "domain-x" });
    const g2token = await bringToRunning(repo, g2);
    const clash = await repo.createAttempt(f.attempt(g2, 1, { independenceDomain: "domain-x" }));
    const refusedClash = await repo.submitAttempt(clash.attemptId, g2token, Date.now());
    check("the same domain reading the subject as another group is refused", refusedClash.ok === false && /^independence:/.test(refusedClash.reason));
    await repo.transitionAttempt(clash.attemptId, "prepared", "rejected_before_submission", { errorCode: "independence" });
    const other = await repo.createAttempt(f.attempt(g2, 2, { independenceDomain: "domain-y" }));
    const okOther = await repo.submitAttempt(other.attemptId, g2token, Date.now());
    check("another domain submits", okOther.ok === true);
    check("independenceDomainsForSubject names the domains that read the subject", same(sorted(await repo.independenceDomainsForSubject(f.wfId(6), "subject:shared")), ["domain-x", "domain-y"]));
    check("independenceDomainsForSubject ignores ungrouped readers", (await repo.independenceDomainsForSubject(f.wfId(6), "subject:submit")).length === 0);
  }

  /* SOMETHING THAT MUST HAPPEN WITH THE SUBMISSION, OR NOT AT ALL.
     A submission may carry a rider — work outside the kernel that has to be
     in the same unit of work as the move, so that a crash or a refusal cannot
     leave one without the other. What the rider does is not the kernel's
     business; that it is atomic with the move is, and both records have to
     answer the same way about it. */
  section("submitAttempt: a rider is part of the move, not something beside it");
  {
    await repo.createWorkflow(f.workflow(9), f.sources(9));

    const ready = async (key) => {
      const task = await admitted(9, key);
      const token = await bringToRunning(repo, task);
      const attempt = await repo.createAttempt(f.attempt(task, 1));
      return { task, token, attempt };
    };

    /* A rider that agrees. */
    {
      const r = await ready("rider-ok");
      const seen = [];
      const outcome = await repo.submitAttempt(r.attempt.attemptId, r.token, Date.now(), async (unitOfWork) => {
        seen.push(unitOfWork);
        return { ok: true };
      });
      check("a rider that agrees lets the submission happen", outcome.ok === true && outcome.attempt.state === "submitted");
      check("and it was run exactly once", seen.length === 1);
      check("and it was handed the record's own unit of work, or nothing when the record has none",
        seen[0] === null || typeof seen[0]?.query === "function");
    }

    /* A rider that refuses. */
    {
      const r = await ready("rider-no");
      const outcome = await repo.submitAttempt(r.attempt.attemptId, r.token, Date.now(),
        async () => ({ ok: false, reason: "the rider said no" }));
      check("a rider that refuses refuses the submission, in its own words",
        outcome.ok === false && outcome.reason === "the rider said no");
      check("and the attempt did not move", (await repo.getAttempt(r.attempt.attemptId)).state === "prepared");
      const after = await repo.submitAttempt(r.attempt.attemptId, r.token, Date.now());
      check("so the same attempt can still be submitted afterwards", after.ok === true);
    }

    /* A rider that throws — the crash, as far as a record can see one. */
    {
      const r = await ready("rider-throws");
      let died = null;
      try {
        await repo.submitAttempt(r.attempt.attemptId, r.token, Date.now(), async () => { throw new Error("the rider died"); });
      } catch (error) { died = error; }
      check("a rider that dies takes the exception with it", died instanceof Error && /the rider died/.test(died.message));
      check("and the attempt did not move", (await repo.getAttempt(r.attempt.attemptId)).state === "prepared");
    }

    /* The rider runs only when the submission itself would go ahead: it is
       run after every rule has passed, so a refusal the record makes on its
       own never costs anything. */
    {
      const r = await ready("rider-not-reached");
      let ran = 0;
      const wrongToken = await repo.submitAttempt(r.attempt.attemptId, entityId("token", "not-mine"), Date.now(),
        async () => { ran += 1; return { ok: true }; });
      check("a submission refused for the record's own reasons never runs the rider",
        wrongToken.ok === false && ran === 0, `${ran} runs — ${wrongToken.ok ? "sent" : wrongToken.reason}`);
      const sent = await repo.submitAttempt(r.attempt.attemptId, r.token, Date.now(),
        async () => { ran += 1; return { ok: true }; });
      check("and the same attempt with the right token runs it once and sends", sent.ok === true && ran === 1, `${ran} runs`);
    }
  }

  section("attempts: made once, moved by the table, facts written once");
  {
    await repo.createWorkflow(f.workflow(9), f.sources(9));
    const t = await admitted(9, "attempts");
    const token = await bringToRunning(repo, t);
    const a = await repo.createAttempt(f.attempt(t, 1));
    await throws("a duplicate attempt id is refused", () => repo.createAttempt(f.attempt(t, 2, { attemptId: a.attemptId })), (e) => /not made twice/.test(e.message));
    await throws("a duplicate attempt number is refused", () => repo.createAttempt(f.attempt(t, 1, { attemptId: entityId("attempt", "other") })), (e) => /already exists/.test(e.message));
    await throws("an attempt without an executor family is refused", () => repo.createAttempt(f.attempt(t, 3, { executorFamily: "" })), (e) => /executor family/.test(e.message));
    await throws("an attempt of a task that does not exist is refused", () => repo.createAttempt(f.attempt({ ...t, taskId: entityId("task", "nowhere") }, 1)), (e) => /no task/.test(e.message));
    check("listAttempts lists by number", (await repo.listAttempts(t.taskId)).map((x) => x.attemptNo).join(",") === "1");
    await throws("prepared → succeeded is illegal", () => repo.transitionAttempt(a.attemptId, "prepared", "succeeded"), (e) => e instanceof IllegalTransition);
    await throws("a stale attempt view is refused", () => repo.transitionAttempt(a.attemptId, "submitted", "response_received"), (e) => e instanceof StaleState);
    await repo.submitAttempt(a.attemptId, token, Date.now());
    const received = await repo.transitionAttempt(a.attemptId, "submitted", "response_received", { errorCode: "partial", usage: { units: 3 } });
    check("a transition carries its patch", received.state === "response_received" && received.errorCode === "partial" && same(received.usage, { units: 3 }));
    await throws("an attempt's error is written once", () => repo.transitionAttempt(a.attemptId, "response_received", "parsed", { errorCode: "different" }), (e) => /written once/.test(e.message));
    await throws("recorded usage is not replaced", () => repo.transitionAttempt(a.attemptId, "response_received", "parsed", { usage: { units: 4 } }), (e) => /cannot be replaced/.test(e.message));
    const parsed = await repo.transitionAttempt(a.attemptId, "response_received", "parsed", { errorCode: "partial", usage: { units: 3 } });
    check("the same facts again are accepted", parsed.state === "parsed" && parsed.errorCode === "partial");
    check("getAttempt agrees with the transition's return", same(await repo.getAttempt(a.attemptId), parsed));
    await throws("an unknown attempt cannot move", () => repo.transitionAttempt(entityId("attempt", "nowhere"), "prepared", "submitted"), (e) => /no attempt/.test(e.message));
  }

  section("commitValidatedResult: all or nothing, then idempotent");
  {
    const t = await admitted(9, "commit");
    const { attempt: a } = await submitted(repo, f, t);
    const discovered = f.segment(9, "discovered", { discoveredBy: "model", discoveredByAttemptId: a.attemptId });
    const c1 = f.claim(t, a, "alpha"); c1.anchors = [f.anchor(c1.claimId, "k1", discovered.segmentId)];
    const c2 = f.claim(t, a, "alpha-2", { subjectKey: "subject:alpha", value: { known: true, quantity: 13, text: "13" } }); c2.anchors = [f.anchor(c2.claimId, "k1", discovered.segmentId)];
    const c3 = f.claim(t, a, "beta", { subjectKey: "subject:beta", inputClaimIds: [] });
    const d1 = { disagreementId: entityId("disagreement", f.wfId(9), "alpha-value"), workflowId: f.wfId(9), disagreementKey: "alpha-value", kind: "value", severity: "material", subjectSignature: { subject_key: "subject:alpha" }, claimIds: [c1.claimId, c2.claimId] };
    const child = f.task(9, "child", { parentTaskId: t.taskId, createdByTaskId: t.taskId, depth: 1, phase: "verify", taskType: "verify_claim", targetClaimIds: [c1.claimId] });
    const assessment = { assessmentId: entityId("assessment", a.attemptId, c1.claimId), workflowId: f.wfId(9), claimId: c1.claimId, attemptId: a.attemptId, taskId: t.taskId,
      assessment: "supports", reasonCode: "read_again", explanation: "the line reads twelve", proposedValue: null, proposedUnit: null, independenceDomain: a.independenceDomain,
      anchors: [f.anchor(entityId("assessment", a.attemptId, c1.claimId), "k1", discovered.segmentId)] };
    const rule = f.decision(9, "beta-rule", { taskId: t.taskId, subjectKey: "subject:beta", decidedByAttemptId: a.attemptId,
      evidence: [{ claimId: c3.claimId, anchorId: null, link: "supports", rule: "single-source-observed" }, { claimId: null, anchorId: entityId("anchor", c3.claimId, "k1"), link: "context", rule: "single-source-observed" }] });
    const body = (claims) => f.commit(t, a, {
      segments: [discovered], claims, assessments: [assessment], disagreements: [d1],
      claimTransitions: [{ claimId: c3.claimId, from: "proposed", to: "accepted" }],
      disagreementRounds: [{ disagreementId: d1.disagreementId, criticRounds: 1 }],
      decisions: [{ decision: rule, decideTo: "machine_decided" }],
      disagreementTransitions: [{ disagreementId: d1.disagreementId, from: "open", to: "verifying" }],
      children: [child], dependencies: [{ taskId: child.taskId, dependsOnTaskId: t.taskId, kind: "requires_claims" }],
      followUps: [{ disagreementId: d1.disagreementId, round: 1, fingerprint: "fp-1", taskId: child.taskId }],
      audits: [{ action: "core_v2.test.committed", entityType: "workflow_task", entityId: t.taskId, detail: { workflowId: f.wfId(9) } }],
    });
    await throws("a commit with one bad claim transition writes nothing", () => repo.commitValidatedResult(body([c1, c2, c3])), (e) => /nothing to open/.test(e.message));
    const untouchedAttempt = await repo.getAttempt(a.attemptId);
    const untouchedTask = await repo.getTask(t.taskId);
    check("the attempt is untouched after the failed commit", untouchedAttempt.state === "submitted" && untouchedAttempt.rawResult === null && untouchedAttempt.validationState === "pending");
    check("the task is untouched after the failed commit", untouchedTask.state === "running" && untouchedTask.leaseToken !== null);
    check("no claim, segment, disagreement, child or decision survived it",
      (await repo.getClaim(c1.claimId)) === null && (await repo.getSegment(discovered.segmentId)) === null && (await repo.getDisagreement(d1.disagreementId)) === null
      && (await repo.getTask(child.taskId)) === null && (await repo.getDecision(rule.decisionId)) === null && (await repo.listAssessments([c1.claimId])).length === 0);
    await throws("a commit naming a task that is not the attempt's is refused", () => repo.commitValidatedResult({ ...body([c1, c2, c3]), taskId: entityId("task", "elsewhere") }), (e) => /not the attempt's/.test(e.message));
    const anchored = { ...c3, anchors: [f.anchor(c3.claimId, "k1", discovered.segmentId)] };
    const out = await repo.commitValidatedResult(body([c1, c2, anchored]));
    check("the commit lands", out.alreadyCommitted === false && out.claims.length === 3 && out.assessments.length === 1 && out.disagreements.length === 1 && out.segments.created.length === 1 && out.children.created.length === 1 && out.decisions.length === 1 && out.followUpsRefused.length === 0);
    check("claims come back with their anchors", out.claims.every((c) => c.anchorIds.length === 1) && out.assessments[0].anchorIds.length === 1);
    const done = await repo.getAttempt(a.attemptId);
    check("the attempt holds its result and its terminal state", done.state === "succeeded" && done.rawResultHash === body([]).attempt.rawResultHash && done.validationState === "valid" && same(done.rawResult, body([]).attempt.rawResult));
    /* What the executor saw of the thing that answered it travels with the
       result and is written once. An executor that cannot say a thing leaves
       the row as it was rather than blanking it. */
    check("the attempt holds nothing about a provider when the executor reported nothing",
      done.providerRequestId === null && done.modelReported === null && same(done.usage, {})
      && done.providerStopReason === null && done.providerDurationMs === null && done.providerResponse === null);
    check("the task is completed and its lease is gone", (await repo.getTask(t.taskId)).state === "completed" && (await repo.getTask(t.taskId)).leaseToken === null);
    const readC1 = await repo.getClaim(c1.claimId);
    check("a disputed claim reads back whole, disputed", same(readC1, { ...out.claims[0], status: "disputed" }));
    check("the accepted claim is accepted", (await repo.getClaim(c3.claimId)).status === "accepted");
    const readD1 = await repo.getDisagreement(d1.disagreementId);
    check("the disagreement carries its claims, its round and its follow-up", readD1.state === "verifying" && same(readD1.claimIds, [c1.claimId, c2.claimId]) && readD1.criticRounds === 1 && same(readD1.followUps, [{ round: 1, fingerprint: "fp-1", taskId: child.taskId }]));
    check("the child is admitted with its dependency and target claim", (await repo.getTask(child.taskId)).state === "created" && (await repo.getDependencies(child.taskId)).length === 1 && same((await repo.getTask(child.taskId)).targetClaimIds, [c1.claimId]));
    const readRule = await repo.getDecision(rule.decisionId);
    check("the decision is machine decided and reads back whole", readRule.status === "machine_decided" && same(readRule, { ...rule, status: "machine_decided" }));
    check("the assessment reads back with its domain and anchors", (await repo.listAssessments([c1.claimId])).length === 1 && (await repo.listAssessments([c1.claimId]))[0].independenceDomain === "domain-a" && (await repo.listAssessmentAnchors([assessment.assessmentId])).length === 1);
    check("listAnchors returns the claim's anchors", (await repo.listAnchors([c1.claimId, c2.claimId])).length === 2 && (await repo.listAnchors([c1.claimId]))[0].sourceId === f.srcId(9, 0));
    check("the segment is discovered by the attempt", (await repo.getSegment(discovered.segmentId)).discoveredByAttemptId === a.attemptId);
    check("the commit's audit is on the trail", (await repo.listAudit()).some((x) => x.action === "core_v2.test.committed" && x.entityId === t.taskId));
    const again = await repo.commitValidatedResult(body([c1, c2, anchored]));
    check("a second commit of the same attempt is already committed", again.alreadyCommitted === true && same(ids(again.claims, "claimId"), ids(out.claims, "claimId")) && again.children.reused.length === 1 && again.children.created.length === 0 && again.segments.reused.length === 1 && again.decisions.length === 1 && again.disagreements.length === 1);
    /* rounds never decrease; one follow-up per round; the same follow-up once */
    const t2 = await admitted(9, "commit-2");
    const { attempt: a2 } = await submitted(repo, f, t2);
    await throws("a commit winding a round back writes nothing", () => repo.commitValidatedResult(f.commit(t2, a2, { disagreementRounds: [{ disagreementId: d1.disagreementId, criticRounds: 0 }] })), (e) => /never decrease/.test(e.message));
    check("the attempt survives the refused commit", (await repo.getAttempt(a2.attemptId)).state === "submitted" && (await repo.getTask(t2.taskId)).state === "running");
    const followed = await repo.commitValidatedResult(f.commit(t2, a2, { followUps: [
      { disagreementId: d1.disagreementId, round: 2, fingerprint: "fp-1", taskId: null },
      { disagreementId: d1.disagreementId, round: 1, fingerprint: "fp-2", taskId: null },
      { disagreementId: d1.disagreementId, round: 2, fingerprint: "fp-3", taskId: null },
    ] }));
    check("the same follow-up again is refused, a second in a round is refused, a new round is admitted",
      followed.followUpsRefused.length === 2 && /already admitted/.test(followed.followUpsRefused[0].reason) && /already has its one/.test(followed.followUpsRefused[1].reason)
      && (await repo.getDisagreement(d1.disagreementId)).followUps.length === 2);
    await throws("a commit of an attempt that does not exist is refused", () => repo.commitValidatedResult(f.commit(t2, { attemptId: entityId("attempt", "nowhere") })), (e) => /no attempt/.test(e.message));
    const t3 = await admitted(9, "commit-3");
    const { attempt: a3 } = await submitted(repo, f, t3);
    const failed = await repo.commitValidatedResult(f.commit(t3, a3, { attempt: { to: "failed_known", validationState: "invalid", validationProblems: ["no claims"], rawResult: { outcome: "failed_known" }, rawResultHash: sha256("failed"), errorCode: "invalid_envelope", errorMessage: "no claims" }, task: { to: "failed_known", reason: "invalid_envelope" } }));
    const a3done = await repo.getAttempt(a3.attemptId);
    check("a failed commit ends the attempt failed_known with its error and the task with its reason", failed.alreadyCommitted === false && a3done.state === "failed_known" && a3done.errorCode === "invalid_envelope" && (await repo.getTask(t3.taskId)).terminalReason === "invalid_envelope");
  }

  section("provider facts: written with the result, written once");
  {
    const t = await admitted(9, "facts");
    const { attempt: a } = await submitted(repo, f, t);
    const facts = { requestId: "req-1", modelReported: "reported-model-1", usage: { input_tokens: 11, output_tokens: 7 },
      durationMs: 1234, stopReason: "end_turn", response: { body: "as it arrived", nested: { kept: true } } };
    await repo.commitValidatedResult(f.commit(t, a, { attempt: { ...f.commit(t, a).attempt, providerFacts: facts } }));
    const written = await repo.getAttempt(a.attemptId);
    check("the request id, the model it said it was, the tokens, the reason it stopped and how long it took are all on the attempt",
      written.providerRequestId === "req-1" && written.modelReported === "reported-model-1"
      && same(written.usage, { input_tokens: 11, output_tokens: 7 })
      && written.providerStopReason === "end_turn" && written.providerDurationMs === 1234,
      `${written.providerRequestId}/${written.modelReported}/${written.providerStopReason}/${written.providerDurationMs}`);
    check("the answer is kept exactly as it arrived, beside what the executor made of it",
      same(written.providerResponse, facts.response) && written.rawResult !== null && !same(written.providerResponse, written.rawResult));
    const again = await repo.commitValidatedResult(f.commit(t, a, { attempt: { ...f.commit(t, a).attempt, providerFacts: { requestId: "req-2", modelReported: "another", usage: { input_tokens: 99 }, stopReason: "other", durationMs: 2, response: { body: "different" } } } }));
    const after = await repo.getAttempt(a.attemptId);
    check("a second commit does not rewrite one of them — an executor fact is written once",
      again.alreadyCommitted === true && after.providerRequestId === "req-1" && after.modelReported === "reported-model-1"
      && after.providerStopReason === "end_turn" && after.providerDurationMs === 1234
      && same(after.usage, { input_tokens: 11, output_tokens: 7 }) && same(after.providerResponse, facts.response));
  }

  section("transitionClaim: anchors, cut-short attempts, standing decisions");
  {
    const t = await admitted(9, "claims");
    const { attempt: a } = await submitted(repo, f, t);
    const seg = f.segment(9, "claims-page", { discoveredBy: "model", discoveredByAttemptId: a.attemptId });
    const bare = f.claim(t, a, "bare");
    const cut = f.claim(t, a, "cut", { incompleteSourceAttempt: true }); cut.anchors = [f.anchor(cut.claimId, "k1", seg.segmentId)];
    const sound = f.claim(t, a, "sound"); sound.anchors = [f.anchor(sound.claimId, "k1", seg.segmentId)];
    /* Anchored, complete, and nobody has verified it. */
    const lone = f.claim(t, a, "lone"); lone.anchors = [f.anchor(lone.claimId, "k1", seg.segmentId)];
    await repo.commitValidatedResult(f.commit(t, a, { segments: [seg], claims: [bare, cut, sound, lone] }));
    /* Agreement is not proof: a reading is accepted on a verdict from another
       executor domain, a deterministic rule, or a person. The critic that
       gives "sound" that verdict is written first, from a domain that is not
       the reader's, so the acceptances below stand on something. */
    const criticTask = await admitted(9, "claims-critic", { phase: "verify", taskType: "verify_claim", targetClaimIds: [sound.claimId] });
    const { attempt: criticAttempt } = await submitted(repo, f, criticTask, 1, { independenceDomain: "domain:critic" });
    await repo.commitValidatedResult(f.commit(criticTask, criticAttempt, { assessments: [{
      assessmentId: entityId("assessment", criticAttempt.attemptId, sound.claimId), workflowId: f.wfId(9), claimId: sound.claimId,
      attemptId: criticAttempt.attemptId, taskId: criticTask.taskId, assessment: "supports", reasonCode: "matches_source",
      explanation: "the source shows this", proposedValue: null, proposedUnit: null, independenceDomain: criticAttempt.independenceDomain,
      anchors: [f.anchor(entityId("assessment", criticAttempt.attemptId, sound.claimId), "k1", seg.segmentId)],
    }] }));
    await throws("a reading with no verdict behind it is not accepted — agreement is not proof",
      () => repo.transitionClaim(lone.claimId, "proposed", "accepted"), (e) => /no independent verification/.test(e.message));
    check("and the refused reading is still proposed — nothing of the move was kept",
      (await repo.getClaim(lone.claimId)).status === "proposed");
    await throws("a claim with nothing to open is not accepted", () => repo.transitionClaim(bare.claimId, "proposed", "accepted"), (e) => /nothing to open/.test(e.message));
    await throws("a claim from a cut-short attempt is not accepted", () => repo.transitionClaim(cut.claimId, "proposed", "accepted"), (e) => /cut-short/.test(e.message));
    const verified = await repo.transitionClaim(cut.claimId, "proposed", "verified");
    check("a cut-short claim may still be verified", verified.status === "verified");
    await throws("an illegal claim move is refused", () => repo.transitionClaim(bare.claimId, "proposed", "corroborated").then(() => repo.transitionClaim(bare.claimId, "corroborated", "proposed")), (e) => e instanceof IllegalTransition);
    await throws("a stale claim view is refused", () => repo.transitionClaim(bare.claimId, "proposed", "rejected"), (e) => e instanceof StaleState);
    await throws("an unknown claim cannot move", () => repo.transitionClaim(entityId("claim", "nowhere"), "proposed", "rejected"), (e) => /no claim/.test(e.message));
    const accepted = await repo.transitionClaim(sound.claimId, "proposed", "accepted");
    check("an anchored claim is accepted", accepted.status === "accepted");
    const standing = f.decision(9, "standing", { subjectKey: sound.subjectKey, decidedByAttemptId: a.attemptId, evidence: [{ claimId: sound.claimId, anchorId: null, link: "supports", rule: "r" }] });
    await repo.applyDecision({ decision: standing, decideTo: "machine_decided" });
    await throws("a claim under a standing decision is not superseded alone", () => repo.transitionClaim(sound.claimId, "accepted", "superseded"), (e) => /standing decision/.test(e.message));
    const filtered = await repo.listClaims({ workflowId: f.wfId(9), taskIds: [t.taskId] });
    check("listClaims filters by workflow and task", filtered.length === 4);
    check("listClaims filters by status, subject and prefix",
      (await repo.listClaims({ attemptIds: [a.attemptId], statuses: ["accepted"] })).length === 1
      && (await repo.listClaims({ workflowId: f.wfId(9), subjectKey: "subject:sound" })).length === 1
      && (await repo.listClaims({ workflowId: f.wfId(9), subjectKeyPrefix: "subject:c", subjectTypes: ["register-line"] })).length === 1
      && (await repo.listClaims({ workflowId: f.wfId(9), subjectTypes: ["nothing"] })).length === 0);
  }

  section("applyDecision: rests on accepted evidence, cites claims through their own anchors");
  {
    const t = await admitted(9, "decide");
    const { attempt: a } = await submitted(repo, f, t);
    const seg = f.segment(9, "decide-page", { discoveredBy: "model", discoveredByAttemptId: a.attemptId });
    const one = f.claim(t, a, "one"); one.anchors = [f.anchor(one.claimId, "k1", seg.segmentId)];
    const two = f.claim(t, a, "two"); two.anchors = [f.anchor(two.claimId, "k1", seg.segmentId)];
    await repo.commitValidatedResult(f.commit(t, a, { segments: [seg], claims: [one, two] }));
    await throws("a machine decision resting on no accepted claim is refused", () => repo.applyDecision({ decideTo: "machine_decided", decision: f.decision(9, "unrested", { decidedByAttemptId: a.attemptId, evidence: [{ claimId: one.claimId, anchorId: null, link: "supports", rule: "r" }] }) }), (e) => /no accepted claim/.test(e.message));
    const unrested = await repo.getDecision(entityId("decision", f.wfId(9), "unrested"));
    check("the refused decision leaves nothing behind — written and decided together or not at all", unrested === null, unrested ? unrested.status : "no row");
    await throws("a decision citing a claim through another claim's anchor is refused", () => repo.applyDecision({ decideTo: null, decision: f.decision(9, "crossed", { evidence: [{ claimId: one.claimId, anchorId: two.anchors[0].anchorId, link: "supports", rule: null }] }) }), (e) => /another claim/.test(e.message));
    await throws("a decision citing a claim that does not exist is refused", () => repo.applyDecision({ decideTo: null, decision: f.decision(9, "phantom", { evidence: [{ claimId: entityId("claim", "nowhere"), anchorId: null, link: "supports", rule: null }] }) }), (e) => /does not exist/.test(e.message));
    await throws("a decision settling a disagreement that does not exist is refused", () => repo.applyDecision({ decideTo: null, decision: f.decision(9, "unsettled", { disagreementId: entityId("disagreement", "nowhere") }) }), (e) => /does not exist/.test(e.message));
    await throws("a decision not written proposed is refused", () => repo.applyDecision({ decideTo: null, decision: f.decision(9, "eager", { status: "machine_decided" }) }), (e) => /written proposed/.test(e.message));
    await throws("a machine decision with no deciding attempt is refused", () => repo.applyDecision({ decideTo: "machine_decided", decision: f.decision(9, "nobody", { evidence: [{ claimId: one.claimId, anchorId: null, link: "supports", rule: "r" }] }) }), (e) => /by no attempt/.test(e.message));
    /* Accepted on a verdict from another domain, as every machine reading is. */
    const oneCritic = await admitted(9, "decide-critic", { phase: "verify", taskType: "verify_claim", targetClaimIds: [one.claimId] });
    const { attempt: oneCriticAttempt } = await submitted(repo, f, oneCritic, 1, { independenceDomain: "domain:critic" });
    await repo.commitValidatedResult(f.commit(oneCritic, oneCriticAttempt, { assessments: [{
      assessmentId: entityId("assessment", oneCriticAttempt.attemptId, one.claimId), workflowId: f.wfId(9), claimId: one.claimId,
      attemptId: oneCriticAttempt.attemptId, taskId: oneCritic.taskId, assessment: "supports", reasonCode: "matches_source",
      explanation: "the source shows this", proposedValue: null, proposedUnit: null, independenceDomain: oneCriticAttempt.independenceDomain,
      anchors: [f.anchor(entityId("assessment", oneCriticAttempt.attemptId, one.claimId), "k1", seg.segmentId)],
    }] }));
    await repo.transitionClaim(one.claimId, "proposed", "accepted");
    const rested = f.decision(9, "rested", { taskId: t.taskId, decidedByAttemptId: a.attemptId, evidence: [
      { claimId: one.claimId, anchorId: null, link: "supports", rule: "r" }, { claimId: one.claimId, anchorId: one.anchors[0].anchorId, link: "context", rule: "r" },
      { claimId: two.claimId, anchorId: null, link: "contradicts", rule: null } ], actions: [{ actionType: "review", ownerRole: "reviewer" }, { actionType: "proceed", ownerRole: "owner" }] });
    const decided = await repo.applyDecision({ decideTo: "machine_decided", decision: rested });
    check("a decision resting on an accepted claim is machine decided", decided.status === "machine_decided");
    check("getDecision reads it back whole, evidence and actions in order", same(await repo.getDecision(rested.decisionId), { ...rested, status: "machine_decided" }));
    const idem = await repo.applyDecision({ decideTo: "machine_decided", decision: rested });
    check("applying the same decision again returns what stands", same(idem, { ...rested, status: "machine_decided" }));
    await throws("the same id with other content is refused", () => repo.applyDecision({ decideTo: null, decision: { ...rested, rationale: "another reason" } }), (e) => /different content/.test(e.message));
    const held = await repo.applyDecision({ decideTo: "needs_human", decision: f.decision(9, "hold", { decisionType: "hold", evidence: [{ claimId: two.claimId, anchorId: null, link: "context", rule: null }], actions: [{ actionType: "review", ownerRole: "reviewer" }] }) });
    check("a hold decision goes to a person", held.status === "needs_human");
    check("listDecisions lists the workflow's decisions", ids(await repo.listDecisions(f.wfId(9)), "decisionId").includes(rested.decisionId));
  }

  section("the raw result is the executor's answer, whatever shape it is");
  {
    /* An executor's return value is stored verbatim and hashed as it stands.
       It is not necessarily an object, and a repository that only keeps
       objects loses what was actually said. */
    const shapes = [
      ["an object", { outcome: "completed", read: "twelve" }],
      ["a string", "the executor answered in prose"],
      ["a number", 12],
      ["a boolean", false],
      ["an array", [1, "two", null]],
      ["null", null],
    ];
    for (const [label, raw] of shapes) {
      const key = `raw:${label}`;
      const rawTask = await admitted(9, key);
      const { attempt: rawAttempt } = await submitted(repo, f, rawTask);
      const hash = sha256(canonical(raw));
      await repo.commitValidatedResult(f.commit(rawTask, rawAttempt, {
        attempt: { to: "succeeded", validationState: "valid", validationProblems: [], rawResult: raw, rawResultHash: hash, errorCode: null, errorMessage: null },
      }));
      const stored = await repo.getAttempt(rawAttempt.attemptId);
      /* The same value, not the same written form: a jsonb column keeps the
         value and sorts an object's keys. The hash is over what the kernel
         canonicalised, so it does not move. */
      check(`a raw result that is ${label} comes back as it went in`,
        same(stored.rawResult, raw) && (stored.rawResult === null) === (raw === null) && stored.rawResultHash === hash,
        `${JSON.stringify(stored.rawResult)} vs ${JSON.stringify(raw)}`);
    }
  }

  section("holdSubject: dispute, decision, transition and audit in one write");
  {
    await repo.createWorkflow(f.workflow(11), f.sources(11));
    const t = await admitted(11, "held", { subjectKey: "subject:held", independenceGroup: "g1" });
    const key = entityId("disagreement-key", f.wfId(11), "subject:held", "coverage");
    const disagreementId = entityId("disagreement", f.wfId(11), key);
    const decisionId = entityId("decision", disagreementId, "needs_human");
    const hold = (over = {}) => ({
      workflowId: f.wfId(11),
      disagreement: { disagreementId, workflowId: f.wfId(11), disagreementKey: key, kind: "coverage", severity: "material", subjectSignature: { subject_key: "subject:held", reason: "independence_unavailable" }, claimIds: [] },
      decision: { decideTo: "needs_human", decision: f.decision(11, "needs_human", { decisionId, taskId: t.taskId, disagreementId, decisionType: "hold", subjectKey: "subject:held", title: "subject:held: a second independent reading could not be had", authority: "adjudicator", rationale: "no second domain", evidence: [], actions: [{ actionType: "review", ownerRole: "reviewer" }] }) },
      transition: { disagreementId, from: "open", to: "needs_human", needsHumanReason: "no second domain" },
      audits: [{ action: "core_v2.subject.needs_attention", entityType: "workflow_task", entityId: t.taskId, detail: { subject: "subject:held", reason: "no second domain" } }],
      ...over,
    });
    const bad = hold({ transition: { disagreementId, from: "verifying", to: "needs_human", needsHumanReason: "no second domain" } });
    await throws("a hold whose transition is stale writes nothing", () => repo.holdSubject(bad), (e) => e instanceof StaleState);
    check("neither the dispute nor the decision survived it", (await repo.getDisagreement(disagreementId)) === null && (await repo.getDecision(decisionId)) === null && (await repo.listDisagreements(f.wfId(11))).length === 0);
    const held = await repo.holdSubject(hold());
    check("the hold writes the dispute, held for a person", held.alreadyHeld === false && held.disagreement.state === "needs_human" && held.disagreement.needsHumanReason === "no second domain" && held.decision.status === "needs_human");
    check("getDisagreement reads the held dispute whole", same(await repo.getDisagreement(disagreementId), held.disagreement));
    check("the hold's decision and audit are on the record", (await repo.getDecision(decisionId)).status === "needs_human" && (await repo.listAudit()).some((x) => x.action === "core_v2.subject.needs_attention" && x.entityId === t.taskId));
    const again = await repo.holdSubject(hold());
    check("holding the same subject again is already held", again.alreadyHeld === true && again.disagreement.disagreementId === disagreementId && again.decision.decisionId === decisionId);
    check("listDisagreements lists it once", (await repo.listDisagreements(f.wfId(11))).length === 1);
    await throws("needs_human → open is illegal", () => repo.transitionDisagreement({ disagreementId, from: "needs_human", to: "open" }), (e) => e instanceof IllegalTransition);
    await throws("a stale disagreement view is refused", () => repo.transitionDisagreement({ disagreementId, from: "open", to: "superseded" }), (e) => e instanceof StaleState);
    await throws("resolved needs the decision that resolved it", () => repo.transitionDisagreement({ disagreementId, from: "needs_human", to: "resolved" }), (e) => /names the decision/.test(e.message));
    await throws("resolved needs a decision that exists", () => repo.transitionDisagreement({ disagreementId, from: "needs_human", to: "resolved", resolutionDecisionId: entityId("decision", "nowhere") }), (e) => /that exists/.test(e.message));
    await throws("an unknown disagreement cannot move", () => repo.transitionDisagreement({ disagreementId: entityId("disagreement", "nowhere"), from: "open", to: "verifying" }), (e) => /no disagreement/.test(e.message));
    const superseded = await repo.transitionDisagreement({ disagreementId, from: "needs_human", to: "superseded" });
    check("needs_human → superseded is legal", superseded.state === "superseded");
  }

  section("releaseDependents: completed upstream releases, a failed upstream stops");
  {
    await repo.createWorkflow(f.workflow(12), f.sources(12));
    const u1 = f.task(12, "u1");
    const u2 = f.task(12, "u2", { dependsOn: [{ taskId: u1.taskId, kind: "requires_completion" }] });
    const u3 = f.task(12, "u3", { dependsOn: [{ taskId: u1.taskId, kind: "requires_claims" }] });
    const u4 = f.task(12, "u4", { dependsOn: [{ taskId: u2.taskId, kind: "requires_completion" }, { taskId: u3.taskId, kind: "requires_completion" }] });
    const u6 = f.task(12, "u6");
    const u5 = f.task(12, "u5", { dependsOn: [{ taskId: u6.taskId, kind: "requires_completion" }] });
    const u8 = f.task(12, "u8");
    const u7 = f.task(12, "u7", { dependsOn: [{ taskId: u8.taskId, kind: "requires_completion" }] });
    const free = f.task(12, "free");
    await repo.admitTasks(f.wfId(12), [u1, u2, u3, u4, u6, u5, u8, u7, free], LIMITS);
    const finish = async (t, to) => { await bringToRunning(repo, t); await repo.transitionTask(t.taskId, "running", to, `ended ${to}`); };
    await finish(u1, "completed");
    await finish(u6, "failed_known");
    await repo.transitionTask(u8.taskId, "created", "queued");
    await repo.transitionTask(u8.taskId, "queued", "superseded", "replaced");
    const pass1 = await repo.releaseDependents(f.wfId(12));
    check("tasks whose dependencies completed are released", same(ids(pass1.released, "taskId"), sorted([u2.taskId, u3.taskId, free.taskId])) && pass1.released.every((x) => x.state === "queued"));
    check("tasks whose dependency failed are stopped, naming the cause", pass1.stopped.length === 1 && pass1.stopped[0].taskId === u5.taskId && pass1.stopped[0].state === "cancelled" && pass1.stopped[0].terminalReason === `upstream_failed_known:${u6.taskId}`);
    check("a task waiting on more is blocked; one under a superseded upstream waits", (await repo.getTask(u4.taskId)).state === "blocked" && (await repo.getTask(u7.taskId)).state === "blocked");
    await finish(u2, "completed");
    await finish(u3, "completed");
    const pass2 = await repo.releaseDependents(f.wfId(12));
    check("the second pass releases what the first could not", same(ids(pass2.released, "taskId"), [u4.taskId]) && pass2.stopped.length === 0);
    check("getRunnableTasks orders by priority then id", (await repo.getRunnableTasks(f.wfId(12))).map((x) => x.taskId).join() === [u4.taskId, free.taskId].sort().join());
  }

  section("expireLeases: unsent leases requeue, sent work becomes outcome_unknown");
  {
    await repo.createWorkflow(f.workflow(13), f.sources(13));
    const unsent = await admitted(13, "unsent");
    await repo.transitionTask(unsent.taskId, "created", "queued");
    await repo.leaseTask(unsent.taskId, "w1", TINY_TTL, Date.now());
    const sent = await admitted(13, "sent");
    const { attempt: sentAttempt, token } = await submitted(repo, f, sent);
    await repo.heartbeatLease(sent.taskId, token, TINY_TTL, Date.now());
    const prepared = await admitted(13, "prepared");
    await repo.transitionTask(prepared.taskId, "created", "queued");
    await repo.leaseTask(prepared.taskId, "w1", TINY_TTL, Date.now());
    await repo.transitionTask(prepared.taskId, "leased", "running");
    const preparedAttempt = await repo.createAttempt(f.attempt(prepared, 1));
    const empty = await admitted(13, "empty");
    await repo.transitionTask(empty.taskId, "created", "queued");
    await repo.leaseTask(empty.taskId, "w1", TINY_TTL, Date.now());
    await repo.transitionTask(empty.taskId, "leased", "running");
    const live = await admitted(13, "live");
    await repo.transitionTask(live.taskId, "created", "queued");
    await repo.leaseTask(live.taskId, "w1", LONG_TTL, Date.now());
    await sleep(SETTLE);
    const touched = await repo.expireLeases(f.wfId(13), Date.now());
    const by = (t) => touched.find((x) => x.taskId === t.taskId);
    check("an expired unsent lease returns the task to the queue", by(unsent)?.state === "queued" && by(unsent)?.leaseToken === null);
    check("an expired lease over a submitted attempt ends outcome_unknown", by(sent)?.state === "outcome_unknown" && by(sent)?.terminalReason === "lease_expired_after_submission");
    const unknown = await repo.getAttempt(sentAttempt.attemptId);
    check("the submitted attempt is outcome_unknown with its reason", unknown.state === "outcome_unknown" && unknown.errorCode === "lease_expired_after_submission");
    check("a running task with a prepared attempt fails known and the attempt is cancelled", by(prepared)?.state === "failed_known" && by(prepared)?.terminalReason === "lease_expired_before_submission" && (await repo.getAttempt(preparedAttempt.attemptId)).state === "cancelled_before_submission");
    check("a running task with no attempt fails known", by(empty)?.state === "failed_known" && by(empty)?.terminalReason === "lease_expired_without_attempt");
    check("a live lease is left alone", by(live) === undefined && (await repo.getTask(live.taskId)).state === "leased");
    check("expireLeases touched exactly the expired", touched.length === 4);
    /* reconciliation of the unknown outcome */
    const asked = await repo.recordReconciliation(sentAttempt.attemptId, "unknown");
    check("an unknown reconciliation writes nothing", asked.reconciliationOutcome === null && (await repo.getAttempt(sentAttempt.attemptId)).reconciliationOutcome === null);
    const recorded = await repo.recordReconciliation(sentAttempt.attemptId, "completed");
    check("a reconciliation outcome is recorded", recorded.reconciliationOutcome === "completed" && (await repo.getAttempt(sentAttempt.attemptId)).reconciliationOutcome === "completed");
    await throws("a different reconciliation is refused: written once", () => repo.recordReconciliation(sentAttempt.attemptId, "failed"), (e) => /written once/.test(e.message));
    check("the same reconciliation again is accepted", (await repo.recordReconciliation(sentAttempt.attemptId, "completed")).reconciliationOutcome === "completed");
    await throws("only an unknown outcome is reconciled", () => repo.recordReconciliation(preparedAttempt.attemptId, "completed"), (e) => /only an unknown outcome/.test(e.message));
    await throws("an unknown attempt is not reconciled", () => repo.recordReconciliation(entityId("attempt", "nowhere"), "completed"), (e) => /no attempt/.test(e.message));
    await throws("a task whose attempt was submitted is not requeued", () => repo.transitionTask(sent.taskId, "outcome_unknown", "queued"), (e) => e instanceof IllegalTransition);
  }

  section("audit: what this repository wrote can be read back");
  {
    await repo.audit({ action: "core_v2.test.noted", entityType: "intelligence_workflow", entityId: f.wfId(13), detail: { note: "synthetic" } });
    const trail = await repo.listAudit();
    check("an audit record is on the trail with its detail", trail.some((x) => x.action === "core_v2.test.noted" && x.entityId === f.wfId(13) && x.detail.note === "synthetic"));
    check("every audit record has the contract's four fields", trail.every((x) => typeof x.action === "string" && typeof x.entityType === "string" && typeof x.entityId === "string" && typeof x.detail === "object"));
  }
}

/* ─────────────────────────────────────────────────────────── both legs */

const memory = harness("the repository contract, in memory");
await suite(memory, new InMemoryOrchestrationRepository(), entityId("organization", "contract-tests", "memory"));
memory.finish();

const postgres = harness("the repository contract, in Postgres");
await withThrowawayDatabase(async ({ client, organizationId }) => {
  await suite(postgres, new PostgresOrchestrationRepository(client, { organizationId }), organizationId);
});
postgres.finish();
