/* RESTART, CANCEL, TIMEOUT, AND THE UNKNOWN OUTCOME.
 *
 * docs/core-v2.md §6: a lease is granted once with a fencing token and
 * heartbeated under it; every transition is compare-and-set on the state the
 * caller believes; submission checks the workflow, the lease and cancellation
 * together, atomically, or refuses. The lease duration must exceed the attempt
 * timeout plus a settlement allowance, and the scheduler heartbeats the lease
 * while an attempt runs. What an attempt stores as its result is what the
 * executor returned, verbatim — a string, a null, a malformed object — with
 * its digest over that same value. `recordReconciliation` writes what an
 * executor later said became of an attempt whose outcome this engine never
 * saw: only an `outcome_unknown` attempt takes one, it is written once, and it
 * is never a reason for the machine to run the work again. Cancellation
 * reconciles already-submitted attempts before anything else; the
 * cancelled-workflow early return in `tick` comes after reconciliation.
 * §1 and §10: a scheduler that dies and a scheduler that starts afterwards
 * look at the same rows and continue without repeating either.
 *
 * Everything runs in memory on the synthetic records pack with scripted
 * executors. The network is closed before the engine is used. The clock is
 * manual except where a real deadline or a real heartbeat is the thing under
 * test, and those waits together stay under 200 ms.
 */
import { harness, closeNetwork } from "./harness.mjs";
import { syntheticRecordSet } from "../domains/synthetic-records/fixture.ts";
import { SyntheticRecordsPack } from "../domains/synthetic-records/pack.ts";
import { mockExecutors } from "../domains/synthetic-records/mocks.ts";
import { assemble, manualClock } from "../domains/simulate.ts";
import { INDEPENDENCE_GROUPS } from "../kernel/domain.ts";
import { canonical, entityId, sha256 } from "../kernel/ids.ts";
import { InMemoryOrchestrationRepository } from "../kernel/memory-repository.ts";
import { IllegalTransition, StaleState } from "../kernel/transitions.ts";

const tripped = closeNetwork();
const t = harness("restart, cancel, timeout, and the unknown outcome");

/* ───────────────────────────────────────────────────────────── helpers */

const SEED = "recovery/records";
const [READER_A, READER_B] = INDEPENDENCE_GROUPS;
const ANALYST_ROLES = new Set(["table_reader", "note_reader"]);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/* Let already-settled promises run their handlers, without waiting on time. */
const drain = () => new Promise((resolve) => setImmediate(resolve));

function fixture(options = {}) {
  return syntheticRecordSet({ seed: SEED, sources: 1, sheetsPerSource: 1, entriesPerTable: 2, ...options });
}

/* One assembled world: a fixture, scripted executors, a scheduler over an
   in-memory repository and a clock the test owns. */
function world({ truth = fixture(), mocks = {}, ...extra } = {}) {
  const { registry, executors } = mockExecutors(truth, mocks);
  const parts = assemble({ manifest: truth.manifest, pack: new SyntheticRecordsPack(), executors: registry, clock: manualClock(), ...extra });
  return { truth, wf: truth.manifest.workflowId, registry, executors, ...parts };
}

async function drive(scheduler, maxTicks = 60) {
  const ticks = [];
  for (let i = 0; i < maxTicks; i++) {
    const r = await scheduler.tick();
    ticks.push(r);
    if (r.dispatched.length === 0 && r.released === 0 && r.stopped === 0 && r.reconciled === 0 && scheduler.inFlight.size === 0) break;
  }
  return ticks;
}

/* A check that the call was refused by a named kind of error, not merely by
   something going wrong. */
async function refusedWith(label, kind, fn) {
  try {
    await fn();
    t.check(label, false, "the call was allowed");
  } catch (error) {
    t.check(label, error instanceof kind, `${error.constructor.name}: ${String(error.message ?? error).slice(0, 90)}`);
  }
}

/* An attempt row a worker that later died would have left behind. */
function handMadeAttempt(task, attemptNo, leaseToken) {
  return {
    attemptId: entityId("attempt", task.taskId, attemptNo), workflowId: task.workflowId, taskId: task.taskId, attemptNo,
    roleKey: task.roleKey, roleVersion: task.roleVersion, executorKind: "model", executorFamily: "reader-family-one",
    independenceDomain: "domain:a-worker-that-died", modelConfiguration: "hand-made", state: "prepared", leaseToken,
    packetFingerprint: "", packetBytes: 0, providerRequestId: null, modelReported: null, usage: {}, rawResult: null,
    rawResultHash: null, validationState: "pending", validationProblems: [], errorCode: null, errorMessage: null,
    reconciliationOutcome: null,
  };
}

const analystTasks = (tasks) => tasks.filter((x) => ANALYST_ROLES.has(x.roleKey));
const taskOf = (tasks, roleKey, group) => tasks.find((x) => x.roleKey === roleKey && x.independenceGroup === group);
const coverageHold = (disagreements, subject) => disagreements.find((d) => d.kind === "coverage" && d.subjectSignature.subject_key === subject);
const packetsFor = (registry, taskId) => registry.packetsSeen.filter((p) => p.taskId === taskId);

/* ═══════════════════════ 1. the lease the scheduler will accept */
t.section("the constructor refuses a lease that covers neither the attempt nor two heartbeats");
{
  const truth = fixture();
  const build = (leaseTtlMs, policy) => assemble({
    manifest: truth.manifest, pack: new SyntheticRecordsPack(), executors: mockExecutors(truth).registry,
    policy, leaseTtlMs, clock: manualClock(),
  });
  const shortHeartbeat = { attemptTimeoutMs: 100, settlementAllowanceMs: 50, heartbeatIntervalMs: 40 };
  const longHeartbeat = { attemptTimeoutMs: 100, settlementAllowanceMs: 50, heartbeatIntervalMs: 200 };

  await t.refused("a lease of 80 ms is refused: it outlives neither the 150 ms attempt-and-settlement nor two 40 ms heartbeats",
    async () => build(80, shortHeartbeat));
  await t.refused("a lease exactly as long as the attempt plus its settlement, with heartbeats too rare to help, is refused",
    async () => build(150, longHeartbeat));
  t.check("a lease of 90 ms is accepted because two 40 ms heartbeats fit inside it",
    build(90, shortHeartbeat).scheduler.options.leaseTtlMs === 90);
  t.check("a lease of 160 ms is accepted because it outlives the 150 ms attempt and its settlement, heartbeats or not",
    build(160, longHeartbeat).scheduler.options.leaseTtlMs === 160);
  const standard = world();
  t.check("the default assembly's lease outlives the attempt and its settlement by construction",
    standard.scheduler.options.leaseTtlMs > standard.policy.attemptTimeoutMs + standard.policy.settlementAllowanceMs,
    `${standard.scheduler.options.leaseTtlMs} ms over ${standard.policy.attemptTimeoutMs} + ${standard.policy.settlementAllowanceMs} ms`);
}

/* ═══════════════════════ 2. fencing tokens */
t.section("fencing: a lease is granted once, and the old token buys nothing afterwards");
{
  const w = world({ truth: fixture({ sources: 3 }) });
  await w.scheduler.plan();
  await w.repo.releaseDependents(w.wf);
  const queued = await w.repo.getRunnableTasks(w.wf);
  t.check("after planning three sources there are three queued tasks to lease by hand", queued.length === 3, `${queued.length} queued`);
  const [first, second, third] = queued;

  const leaseA = await w.repo.leaseTask(first.taskId, "worker-one", 1_000, w.clock.now());
  t.check("leaseTask grants the task with an owner, a fencing token and an expiry from the caller's clock",
    leaseA !== null && leaseA.state === "leased" && leaseA.leaseOwner === "worker-one" && typeof leaseA.leaseToken === "string" && leaseA.leaseExpiresAt === w.clock.now() + 1_000,
    `${leaseA?.leaseOwner}/${String(leaseA?.leaseToken).slice(0, 8)} until ${leaseA?.leaseExpiresAt}`);
  t.check("a live lease is never granted again, to anyone",
    (await w.repo.leaseTask(first.taskId, "worker-two", 1_000, w.clock.now())) === null);

  w.clock.advance(100);
  t.check("heartbeatLease under the holder's own token extends the lease",
    (await w.repo.heartbeatLease(first.taskId, leaseA.leaseToken, 1_000, w.clock.now())) === true
    && (await w.repo.getTask(first.taskId)).leaseExpiresAt === w.clock.now() + 1_000);

  w.clock.advance(5_000);
  const leaseB = await w.repo.leaseTask(first.taskId, "worker-two", 1_000, w.clock.now());
  t.check("once the lease has expired another worker may take the task, and it takes it under a different fencing token",
    leaseB !== null && leaseB.leaseOwner === "worker-two" && leaseB.leaseToken !== leaseA.leaseToken,
    `${String(leaseA.leaseToken).slice(0, 8)} → ${String(leaseB?.leaseToken).slice(0, 8)}`);
  t.check("heartbeatLease under the superseded token is false — the first worker cannot keep a lease it no longer holds",
    (await w.repo.heartbeatLease(first.taskId, leaseA.leaseToken, 1_000, w.clock.now())) === false);
  t.check("the superseded heartbeat did not move the expiry the new holder was given",
    (await w.repo.getTask(first.taskId)).leaseExpiresAt === leaseB.leaseExpiresAt);

  const oldTokenAttempt = handMadeAttempt(first, 1, leaseA.leaseToken);
  await w.repo.createAttempt(oldTokenAttempt);
  const leasedRefusal = await w.repo.submitAttempt(oldTokenAttempt.attemptId, leaseB.leaseToken, w.clock.now());
  t.check("submitAttempt refuses while the task is only leased — nothing is sent before the task is running",
    leasedRefusal.ok === false && /task is leased/.test(leasedRefusal.reason), leasedRefusal.reason);

  await w.repo.transitionTask(first.taskId, "leased", "running");
  const fencedOut = await w.repo.submitAttempt(oldTokenAttempt.attemptId, leaseA.leaseToken, w.clock.now());
  t.check("submitAttempt under the superseded token is refused with 'the lease is not the caller's'",
    fencedOut.ok === false && fencedOut.reason === "the lease is not the caller's", fencedOut.reason);
  t.check("the fenced-out attempt was not moved — it is still prepared, and nothing reached an executor",
    (await w.repo.getAttempt(oldTokenAttempt.attemptId)).state === "prepared");

  const expired = await w.repo.submitAttempt(oldTokenAttempt.attemptId, leaseB.leaseToken, leaseB.leaseExpiresAt + 1);
  t.check("submitAttempt under the right token but after the lease has run out is refused with 'the lease has expired'",
    expired.ok === false && expired.reason === "the lease has expired", expired.reason);

  const accepted = await w.repo.submitAttempt(oldTokenAttempt.attemptId, leaseB.leaseToken, w.clock.now());
  t.check("submitAttempt under the current token, inside the lease, on a running task, is allowed",
    accepted.ok === true && accepted.attempt.state === "submitted");
  const twice = await w.repo.submitAttempt(oldTokenAttempt.attemptId, leaseB.leaseToken, w.clock.now());
  t.check("the same attempt is not submitted twice", twice.ok === false && /attempt is submitted/.test(twice.reason), twice.reason);

  /* Cancellation and an inactive workflow, checked in the order submission
     checks them: the request first, the state above it. */
  const secondLease = await w.repo.leaseTask(second.taskId, "worker-one", 1_000, w.clock.now());
  const secondAttempt = handMadeAttempt(second, 1, secondLease.leaseToken);
  await w.repo.createAttempt(secondAttempt);
  await w.repo.transitionTask(second.taskId, "leased", "running");
  await w.repo.requestCancel(w.wf, w.clock.now());
  const cancelled = await w.repo.submitAttempt(secondAttempt.attemptId, secondLease.leaseToken, w.clock.now());
  t.check("submitAttempt refuses once cancellation has been requested, though the lease and the task are in order",
    cancelled.ok === false && cancelled.reason === "cancellation was requested", cancelled.reason);
  await w.repo.transitionWorkflow(w.wf, "running", "cancelled");
  const inactive = await w.repo.submitAttempt(secondAttempt.attemptId, secondLease.leaseToken, w.clock.now());
  t.check("submitAttempt refuses when the workflow is no longer active",
    inactive.ok === false && /workflow is cancelled/.test(inactive.reason), inactive.reason);

  /* ═══ 3. compare-and-set, and the machine's own table */
  t.section("transitions are compare-and-set on the state the caller believes");
  await refusedWith("transitionTask with a stale 'from' throws StaleState — the caller's view of a queued task as created is refused", StaleState,
    () => w.repo.transitionTask(third.taskId, "created", "queued"));
  await refusedWith("transitionTask with a move the machine does not hold throws IllegalTransition — queued does not go straight to running", IllegalTransition,
    () => w.repo.transitionTask(third.taskId, "queued", "running"));
  t.check("the legal move on the same task is allowed, so the refusals above were about the move and not the task",
    (await w.repo.transitionTask(third.taskId, "queued", "leased")).state === "leased");
  await refusedWith("a leased task cannot jump to completed", IllegalTransition,
    () => w.repo.transitionTask(third.taskId, "leased", "completed"));
  await refusedWith("a submitted attempt cannot jump straight to succeeded — the answer is received and parsed first", IllegalTransition,
    () => w.repo.transitionAttempt(oldTokenAttempt.attemptId, "submitted", "succeeded"));
  await refusedWith("transitionAttempt with a stale 'from' throws StaleState", StaleState,
    () => w.repo.transitionAttempt(oldTokenAttempt.attemptId, "prepared", "submitted"));
}

/* ═══════════════════════ 4. a deadline, and what it leaves behind */
t.section("an attempt past its deadline: outcome unknown, the subject held, the slot still occupied");

const timeoutWorld = (() => {
  const hang = { context: null, release: null };
  const script = (packet, base, context) => {
    if (packet.roleKey !== "table_reader" || packet.independenceGroup !== READER_A) return base;
    hang.context = context;
    /* A provider that does not answer and does not hear the abort either. */
    return new Promise((resolve, reject) => { hang.release = { resolve, reject }; });
  };
  const w = world({
    mocks: { scripts: { "reader-family-one": script, "reader-family-two": script } },
    policy: { attemptTimeoutMs: 30, settlementAllowanceMs: 10, heartbeatIntervalMs: 1_000, maximumTimedOutExecutions: 1 },
    leaseTtlMs: 60_000,
  });
  return { ...w, hang };
})();

{
  const w = timeoutWorld;
  await w.scheduler.plan();
  const reports = [];
  for (let i = 0; i < 3; i++) reports.push(await w.scheduler.tick());
  const tasks = await w.repo.listTasks(w.wf);
  const hung = taskOf(tasks, "table_reader", READER_A);
  const peer = taskOf(tasks, "table_reader", READER_B);
  const attempts = await w.repo.listAttempts(hung.taskId);

  t.check("the blind reading that never answered ends outcome_unknown, its reason the timeout",
    hung.state === "outcome_unknown" && hung.terminalReason === "attempt_timeout", `${hung.state}/${hung.terminalReason}`);
  t.check("it has exactly one attempt, outcome_unknown with errorCode attempt_timeout",
    attempts.length === 1 && attempts[0].state === "outcome_unknown" && attempts[0].errorCode === "attempt_timeout",
    attempts.map((a) => `${a.state}/${a.errorCode}`).join(", "));
  t.check("the attempt's message says how long the engine waited",
    /no answer within 30 ms/.test(attempts[0].errorMessage ?? ""), attempts[0].errorMessage);
  t.check("the execution context's abort signal was aborted — the executor was told to stop",
    w.hang.context !== null && w.hang.context.signal.aborted === true);
  t.check("the timed-out execution is still in flight: a slot is not free while a provider may still be working",
    w.scheduler.inFlight.size === 1 && w.scheduler.inFlight.has(attempts[0].attemptId)
    && w.scheduler.inFlight.get(attempts[0].attemptId).timedOut === true,
    `${w.scheduler.inFlight.size} in flight`);
  t.check("the tick that lost the answer reported the task as unknown, not failed",
    reports[2].unknown.includes(hung.taskId) && !reports[2].failed.includes(hung.taskId));
  t.check("the audit records the unknown outcome against the attempt",
    (await w.repo.listAudit()).some((a) => a.action === "core_v2.attempt.outcome_unknown" && a.entityId === attempts[0].attemptId));
  t.check("the other blind reading of that subject still ran and completed — one lost answer is not a lost subject",
    peer.state === "completed");

  const disagreements = await w.repo.listDisagreements(w.wf);
  const decisions = await w.repo.listDecisions(w.wf);
  const hold = coverageHold(disagreements, hung.subjectKey);
  t.check("the subject read once is held for a person: a coverage disagreement in needs_human",
    hold !== undefined && hold.state === "needs_human", disagreements.map((d) => `${d.kind}:${d.state}`).join(", "));
  t.check("the hold carries its decision, in status needs_human, naming the subject",
    decisions.some((d) => d.disagreementId === hold?.disagreementId && d.decisionType === "hold" && d.status === "needs_human" && d.subjectKey === hung.subjectKey));

  /* The ceiling on timed-out executions. */
  const blocked = await w.scheduler.tick();
  const runnable = await w.repo.getRunnableTasks(w.wf);
  t.check("with the ceiling of timed-out executions reached, the next tick dispatches nothing though work is runnable",
    blocked.dispatched.length === 0 && runnable.length > 0, `${runnable.length} runnable, ${blocked.dispatched.length} dispatched`);
  t.check("nothing was sent to any executor during that tick",
    w.registry.packetsSeen.filter((p) => runnable.some((x) => x.taskId === p.taskId)).length === 0);

  /* And when the provider finally settles, the slot comes back. */
  w.hang.release.reject(new Error("the executor gave up long after the engine did"));
  await drain();
  t.check("once the abandoned execution settles the scheduler stops counting it against concurrency",
    w.scheduler.inFlight.size === 0);
  const after = await w.scheduler.tick();
  t.check("with the slot free again the scheduler dispatches the waiting work", after.dispatched.length > 0, `${after.dispatched.length} dispatched`);

  /* ═══ 5. the unknown is never retried */
  t.section("nothing retries an attempt whose outcome is unknown");
  await drive(w.scheduler);
  t.check("after driving the run to the end the lost reading still has exactly one attempt",
    (await w.repo.listAttempts(hung.taskId)).length === 1);
  t.check("the lost reading's task is still outcome_unknown and was never requeued",
    (await w.repo.getTask(hung.taskId)).state === "outcome_unknown");
  t.check("its executor was handed exactly one packet for that task, ever",
    packetsFor(w.registry, hung.taskId).length === 1);

  const fresh = mockExecutors(w.truth);
  const restarted = assemble({
    manifest: w.truth.manifest, pack: new SyntheticRecordsPack(), executors: fresh.registry, repo: w.repo, clock: w.clock,
    policy: { attemptTimeoutMs: 30, settlementAllowanceMs: 10, heartbeatIntervalMs: 1_000 }, leaseTtlMs: 60_000,
  });
  await drive(restarted.scheduler);
  t.check("a fresh scheduler on the same repository does not run the unknown attempt again — no packet for that task",
    packetsFor(fresh.registry, hung.taskId).length === 0);
  t.check("and it creates no second attempt for it: a person's authorisation is the only way back to the queue",
    (await w.repo.listAttempts(hung.taskId)).length === 1);

  /* ═══ 6. what the executor says afterwards */
  t.section("reconciliation: the answer to 'what became of this?' is recorded, and is not a retry");
  const attemptId = attempts[0].attemptId;
  const executor = w.executors[attempts[0].executorFamily];
  let asked = 0;
  const answer = executor.reconcile.bind(executor);
  executor.reconcile = async (id) => { asked++; return answer(id); };

  const askedBefore = asked;
  await w.scheduler.tick();
  t.check("an executor that cannot say leaves the attempt unreconciled, and the question is asked again next tick",
    asked === askedBefore + 1 && (await w.repo.getAttempt(attemptId)).reconciliationOutcome === null, `asked ${asked} times`);
  await w.scheduler.tick();
  t.check("the question is asked once per tick while the answer is still unknown", asked === askedBefore + 2, `asked ${asked} times`);
  t.check("nothing was written for an unknown answer — no reconciliation audit yet",
    (await w.repo.listAudit()).every((a) => a.action !== "core_v2.attempt.reconciled"));

  executor.reconciliations.set(attemptId, "completed");
  const reconciling = await w.scheduler.tick();
  const reconciled = await w.repo.getAttempt(attemptId);
  t.check("when the executor says the work completed after all, the attempt records that outcome",
    reconciled.reconciliationOutcome === "completed", String(reconciled.reconciliationOutcome));
  t.check("the tick counts it as a reconciliation and writes core_v2.attempt.reconciled against the attempt",
    reconciling.reconciled >= 1 && (await w.repo.listAudit()).some((a) => a.action === "core_v2.attempt.reconciled" && a.entityId === attemptId));
  t.check("the reconciled attempt stays outcome_unknown and its task with it — the record is not rewritten by hindsight",
    reconciled.state === "outcome_unknown" && (await w.repo.getTask(hung.taskId)).state === "outcome_unknown");
  t.check("nothing was retried on the strength of that answer: still one attempt, still one packet",
    (await w.repo.listAttempts(hung.taskId)).length === 1 && packetsFor(w.registry, hung.taskId).length === 1);

  const askedAfter = asked;
  await w.scheduler.tick();
  t.check("an attempt that has its answer is not asked about again", asked === askedAfter);
  t.check("and the reconciliation audit was written once, not once per tick",
    (await w.repo.listAudit()).filter((a) => a.action === "core_v2.attempt.reconciled" && a.entityId === attemptId).length === 1);

  const succeeded = (await w.repo.listAttempts(peer.taskId)).find((a) => a.state === "succeeded");
  await t.refused("recordReconciliation on an attempt whose outcome was seen is refused — only an unknown outcome takes one",
    () => w.repo.recordReconciliation(succeeded.attemptId, "completed"));
  await t.refused("a second, different reconciliation outcome is refused — it is written once",
    () => w.repo.recordReconciliation(attemptId, "failed"));
  t.check("writing the same outcome again changes nothing and is not an error",
    (await w.repo.recordReconciliation(attemptId, "completed")).reconciliationOutcome === "completed");
}

/* ═══════════════════════ 7. restart mid-run */
t.section("a scheduler that dies mid-run and one that starts afterwards do not repeat each other");
{
  const truth = fixture({ sheetsPerSource: 2, entriesPerTable: 3 });
  const w = world({ truth });
  await w.scheduler.plan();
  let stopped = null;
  for (let i = 0; i < 20; i++) {
    await w.scheduler.tick();
    const tasks = await w.repo.listTasks(w.wf);
    const done = analystTasks(tasks).filter((x) => x.state === "completed");
    const open = tasks.filter((x) => !["completed", "failed_known", "outcome_unknown", "cancelled", "superseded"].includes(x.state));
    const state = (await w.repo.getWorkflow(w.wf)).state;
    if (done.length > 0 && open.length > 0 && state === "running") { stopped = { done, open }; break; }
  }
  t.check("the run was stopped mid-flight: some analysts had finished and other work was still open",
    stopped !== null && stopped.done.length > 0 && stopped.open.length > 0,
    stopped ? `${stopped.done.length} analysts done, ${stopped.open.length} tasks open` : "never reached that state");

  const before = await w.repo.listTasks(w.wf);
  const completedBefore = before.filter((x) => x.state === "completed").map((x) => x.taskId);
  const snapshot = w.repo.snapshot();
  const repo2 = InMemoryOrchestrationRepository.fromSnapshot(snapshot);
  const fresh = mockExecutors(truth);
  const second = assemble({ manifest: truth.manifest, pack: new SyntheticRecordsPack(), executors: fresh.registry, repo: repo2, clock: manualClock() });
  const report = await second.scheduler.runUntilQuiescent();

  t.check("the second scheduler carries the same workflow to completion from the record alone",
    report.workflow.state === "completed", `${report.workflow.state} after ${report.ticks} ticks`);
  t.check("no task that had completed before the restart was executed again — the new executors saw no packet for any of them",
    completedBefore.length > 0 && completedBefore.every((id) => packetsFor(second.scheduler.executors, id).length === 0),
    `${completedBefore.length} tasks completed before the restart`);
  const after = await repo2.listTasks(w.wf);
  const successes = await Promise.all(after.map(async (x) => (await repo2.listAttempts(x.taskId)).filter((a) => a.state === "succeeded").length));
  t.check("every task in the finished record has at most one succeeded attempt — nothing was done twice",
    successes.every((n) => n <= 1), `${successes.filter((n) => n === 1).length} tasks with one success of ${after.length}`);
  t.check("the restart did not lose the work already done: every task completed before it is completed after it",
    completedBefore.every((id) => after.find((x) => x.taskId === id)?.state === "completed"));

  const straight = world({ truth });
  await straight.scheduler.plan();
  await straight.scheduler.runUntilQuiescent();
  const ids = async (repo) => (await repo.listClaims({ workflowId: w.wf })).map((c) => c.claimId).sort();
  const withRestart = await ids(repo2);
  const withoutRestart = await ids(straight.repo);
  t.check("the run that was interrupted names exactly the claims the uninterrupted run names",
    withRestart.length > 0 && withRestart.length === withoutRestart.length && withRestart.every((id, i) => id === withoutRestart[i]),
    `${withRestart.length} claims with a restart, ${withoutRestart.length} without`);
  t.check("the uninterrupted run reached the same end state",
    (await straight.repo.getWorkflow(straight.wf)).state === report.workflow.state);
}

/* ═══════════════════════ 8. a worker that died holding a lease */
t.section("a worker that died holding a lease: what was sent becomes unknown, what was not goes back to the queue");
{
  const w = world({ truth: fixture({ sources: 3 }) });
  await w.scheduler.plan();
  await w.repo.releaseDependents(w.wf);
  const [sent, unsent] = await w.repo.getRunnableTasks(w.wf);

  const sentLease = await w.repo.leaseTask(sent.taskId, "a-worker-that-died", 500, w.clock.now());
  const sentAttempt = handMadeAttempt(sent, 1, sentLease.leaseToken);
  await w.repo.createAttempt(sentAttempt);
  await w.repo.transitionTask(sent.taskId, "leased", "running");
  const submitted = await w.repo.submitAttempt(sentAttempt.attemptId, sentLease.leaseToken, w.clock.now());
  const unsentLease = await w.repo.leaseTask(unsent.taskId, "a-worker-that-died", 500, w.clock.now());
  await w.repo.createAttempt(handMadeAttempt(unsent, 1, unsentLease.leaseToken));
  t.check("the world is set up: one task running under a submitted attempt, one merely leased with an attempt prepared",
    submitted.ok === true && (await w.repo.getTask(unsent.taskId)).state === "leased");

  const snapshot = w.repo.snapshot();
  const repo2 = InMemoryOrchestrationRepository.fromSnapshot(snapshot);
  const clock2 = manualClock();
  clock2.advance(5_000);
  const fresh = mockExecutors(w.truth);
  const second = assemble({ manifest: w.truth.manifest, pack: new SyntheticRecordsPack(), executors: fresh.registry, repo: repo2, clock: clock2 });

  const touched = await repo2.expireLeases(w.wf, clock2.now());
  t.check("expireLeases picks up both abandoned tasks", touched.length === 2, `${touched.length} tasks touched`);
  const sentAfter = await repo2.getTask(sent.taskId);
  const sentAttemptAfter = await repo2.getAttempt(sentAttempt.attemptId);
  t.check("the task whose attempt was already sent becomes outcome_unknown — it is reconciled, never requeued",
    sentAfter.state === "outcome_unknown" && sentAfter.terminalReason === "lease_expired_after_submission",
    `${sentAfter.state}/${sentAfter.terminalReason}`);
  t.check("its attempt becomes outcome_unknown too, saying the worker holding it did not come back",
    sentAttemptAfter.state === "outcome_unknown" && sentAttemptAfter.errorCode === "lease_expired_after_submission");
  const unsentAfter = await repo2.getTask(unsent.taskId);
  const unsentAttemptAfter = await repo2.listAttempts(unsent.taskId);
  t.check("the merely leased task goes back to the queue — nothing was sent, so nothing was spent",
    unsentAfter.state === "queued" && unsentAfter.leaseToken === null && unsentAfter.leaseOwner === null,
    `${unsentAfter.state}, token ${String(unsentAfter.leaseToken)}`);
  t.check("its prepared attempt is cancelled_before_submission, with the reason recorded",
    unsentAttemptAfter.length === 1 && unsentAttemptAfter[0].state === "cancelled_before_submission" && unsentAttemptAfter[0].errorCode === "lease_expired_before_submission",
    unsentAttemptAfter.map((a) => `${a.state}/${a.errorCode}`).join(", "));

  await second.scheduler.tick();
  t.check("the new scheduler never re-executes the task whose attempt may have reached a provider",
    packetsFor(fresh.registry, sent.taskId).length === 0 && (await repo2.listAttempts(sent.taskId)).length === 1);
  t.check("it does run the requeued task, under a second attempt — nothing was sent the first time",
    packetsFor(fresh.registry, unsent.taskId).length === 1 && (await repo2.listAttempts(unsent.taskId)).length === 2,
    `${(await repo2.listAttempts(unsent.taskId)).map((a) => `${a.attemptNo}:${a.state}`).join(", ")}`);
}

/* ═══════════════════════ 9. cancellation with an execution in flight */
t.section("cancellation: the signal goes out, what was sent is reconciled, nothing new is dispatched");
{
  const hang = { context: null, release: null };
  let entered;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  const script = (packet, base, context) => {
    if (!ANALYST_ROLES.has(packet.roleKey)) return base;
    hang.context = context;
    entered();
    return new Promise((resolve, reject) => { hang.release = { resolve, reject }; });
  };
  const w = world({
    mocks: { scripts: { "reader-family-one": script, "reader-family-two": script } },
    policy: { attemptTimeoutMs: 5_000, settlementAllowanceMs: 1_000, heartbeatIntervalMs: 1_000, maximumConcurrentTasksPerWorkflow: 2 },
    leaseTtlMs: 60_000,
  });
  await w.scheduler.plan();
  await w.scheduler.tick();
  await w.scheduler.tick();

  /* One reader is taken by a worker that will die holding a short lease; one
     more is left for this tick to dispatch and hang on. */
  await w.repo.releaseDependents(w.wf);
  const runnable = await w.repo.getRunnableTasks(w.wf);
  t.check("the readings are queued and there are two of them to divide between a dead worker and this scheduler",
    runnable.length >= 2, `${runnable.length} queued`);
  const stale = runnable[1];
  const staleLease = await w.repo.leaseTask(stale.taskId, "a-worker-that-died", 10, w.clock.now());
  const staleAttempt = handMadeAttempt(stale, 1, staleLease.leaseToken);
  await w.repo.createAttempt(staleAttempt);
  await w.repo.transitionTask(stale.taskId, "leased", "running");
  await w.repo.submitAttempt(staleAttempt.attemptId, staleLease.leaseToken, w.clock.now());

  const ticking = w.scheduler.tick();
  await enteredPromise;
  const running = w.scheduler.inFlight.keys().next().value;
  const runningTask = w.scheduler.inFlight.get(running).taskId;
  const completedBefore = (await w.repo.listTasks(w.wf)).filter((x) => x.state === "completed").map((x) => x.taskId);
  const blockedBefore = (await w.repo.listTasks(w.wf)).filter((x) => ["created", "blocked", "queued"].includes(x.state)).map((x) => x.taskId);
  const packetsBefore = w.registry.packetsSeen.length;

  const outcome = await w.scheduler.cancel("stop");
  t.check("cancellation aborts the execution in flight", hang.context !== null && hang.context.signal.aborted === true);
  t.check("the aborted attempt is not cancelled: it was submitted, and what was submitted is reconciled, not undone",
    (await w.repo.getAttempt(running)).state === "submitted" && (await w.repo.getTask(runningTask)).state === "running",
    `${(await w.repo.getAttempt(running)).state}, task ${(await w.repo.getTask(runningTask)).state}`);
  t.check("the task the dead worker left submitted is not cancelled either",
    (await w.repo.getTask(stale.taskId)).state === "running" && (await w.repo.getAttempt(staleAttempt.attemptId)).state === "submitted");
  t.check("cancellation counts both submitted-and-unresolved tasks", outcome.submittedUnresolved >= 2, JSON.stringify(outcome));
  t.check("every task that had not been sent anywhere is cancelled",
    blockedBefore.length > 0 && (await Promise.all(blockedBefore.map(async (id) => (await w.repo.getTask(id)).state))).every((s) => s === "cancelled"),
    `${blockedBefore.length} unsent tasks`);
  t.check("what had already completed is preserved, not rolled back",
    completedBefore.length > 0 && outcome.completedPreserved === completedBefore.length
    && (await Promise.all(completedBefore.map(async (id) => (await w.repo.getTask(id)).state))).every((s) => s === "completed"),
    `${completedBefore.length} completed before the cancellation`);
  const workflow = await w.repo.getWorkflow(w.wf);
  t.check("the workflow is cancelled, with the reason on the record and in the audit",
    workflow.state === "cancelled" && workflow.errorCode === "cancelled_by_person" && workflow.cancelRequestedAt !== null
    && (await w.repo.listAudit()).some((a) => a.action === "core_v2.workflow.cancelled" && a.detail.reason === "stop"));

  /* The tick after cancellation still reconciles before it returns. */
  w.clock.advance(1_000);
  const afterCancel = await w.scheduler.tick();
  t.check("the tick after cancellation reconciles the expired running task to outcome_unknown before it returns",
    afterCancel.reconciled >= 1 && (await w.repo.getTask(stale.taskId)).state === "outcome_unknown"
    && (await w.repo.getAttempt(staleAttempt.attemptId)).state === "outcome_unknown",
    `${afterCancel.reconciled} reconciled`);
  t.check("that same tick dispatches nothing and reports the cancelled workflow",
    afterCancel.dispatched.length === 0 && afterCancel.workflowState === "cancelled" && w.registry.packetsSeen.length === packetsBefore,
    `${afterCancel.dispatched.length} dispatched, ${w.registry.packetsSeen.length - packetsBefore} new packets`);

  hang.release.reject(new Error("the executor stopped when it was told to"));
  await ticking;
  t.check("when the abandoned execution finally settles, its attempt and task end outcome_unknown — never completed after a cancellation",
    (await w.repo.getAttempt(running)).state === "outcome_unknown" && (await w.repo.getTask(runningTask)).state === "outcome_unknown",
    `${(await w.repo.getAttempt(running)).state}/${(await w.repo.getTask(runningTask)).state}`);
}

/* ═══════════════════════ 10. the heartbeat */
t.section("the lease is heartbeated while an attempt runs");
{
  const truth = fixture();
  const started = Date.now();
  const base = 1_700_000_000_000;
  /* A clock that moves with real time, because the heartbeat is a real timer. */
  const clock = { now: () => base + (Date.now() - started), advance: () => undefined };
  const seen = [];
  let repoRef = null;
  const script = async (packet, envelope, context) => {
    if (packet.roleKey !== "table_reader" || packet.independenceGroup !== READER_A) return envelope;
    const before = await repoRef.getTask(context.taskId);
    await delay(60);
    const during = await repoRef.getTask(context.taskId);
    seen.push({ before, during });
    return envelope;
  };
  const w = world({
    truth, clock,
    mocks: { scripts: { "reader-family-one": script, "reader-family-two": script } },
    policy: { attemptTimeoutMs: 5_000, settlementAllowanceMs: 100, heartbeatIntervalMs: 10 },
    leaseTtlMs: 1_000,
  });
  repoRef = w.repo;
  await w.scheduler.plan();
  await drive(w.scheduler, 12);

  t.check("the slow reading ran once and was observed while it held the lease", seen.length === 1, `${seen.length} observations`);
  const [{ before, during }] = seen;
  t.check("the lease's expiry was pushed out while the attempt was still running",
    during.leaseExpiresAt > before.leaseExpiresAt, `${before.leaseExpiresAt} → ${during.leaseExpiresAt}`);
  t.check("it was pushed out by roughly the time the attempt spent, not by a re-lease: same token, same owner, task running",
    during.leaseToken === before.leaseToken && during.leaseOwner === before.leaseOwner && during.state === "running"
    && during.leaseExpiresAt - before.leaseExpiresAt >= 40,
    `+${during.leaseExpiresAt - before.leaseExpiresAt} ms`);
  const task = (await w.repo.listTasks(w.wf)).find((x) => x.taskId === during.taskId);
  t.check("the slow attempt succeeded: a heartbeated lease outlives the work it covers",
    (await w.repo.listAttempts(task.taskId)).some((a) => a.state === "succeeded"), task.state);
}

/* ═══════════════════════ 11. an executor that throws */
t.section("an executor that throws: the outcome is unknown, and unknown is not retried");
{
  const script = (packet, base) => (packet.roleKey === "table_reader" && packet.independenceGroup === READER_A ? "throw" : base);
  const w = world({ mocks: { scripts: { "reader-family-one": script, "reader-family-two": script } } });
  await w.scheduler.plan();
  await drive(w.scheduler);
  const tasks = await w.repo.listTasks(w.wf);
  const thrown = taskOf(tasks, "table_reader", READER_A);
  const attempts = await w.repo.listAttempts(thrown.taskId);
  t.check("the attempt of an executor that threw is outcome_unknown with errorCode executor_threw",
    attempts.length === 1 && attempts[0].state === "outcome_unknown" && attempts[0].errorCode === "executor_threw",
    attempts.map((a) => `${a.state}/${a.errorCode}`).join(", "));
  t.check("its task is outcome_unknown for the same reason, and holds no result",
    thrown.state === "outcome_unknown" && thrown.terminalReason === "executor_threw" && attempts[0].rawResult === null,
    `${thrown.state}/${thrown.terminalReason}`);
  t.check("an exception is not a licence to try again: one attempt, one packet",
    packetsFor(w.registry, thrown.taskId).length === 1);
  t.check("the subject read once is held for a person by a coverage disagreement",
    coverageHold(await w.repo.listDisagreements(w.wf), thrown.subjectKey)?.state === "needs_human",
    (await w.repo.listDisagreements(w.wf)).map((d) => `${d.kind}:${d.state}`).join(", "));
  const settled = await w.scheduler.runUntilQuiescent();
  t.check("the workflow ends partial: a lost outcome is not a completed run", settled.workflow.state === "partial", settled.workflow.state);
  t.check("recordReconciliation with 'unknown' writes nothing and leaves the question open",
    (await w.repo.recordReconciliation(attempts[0].attemptId, "unknown")).reconciliationOutcome === null);
}

/* ═══════════════════════ 12. what the record keeps of a bad answer */
t.section("the attempt stores what the executor returned, verbatim, with its digest over that value");

async function junkRun(label, value, expectation) {
  const script = (packet, base) => (packet.roleKey === "table_reader" ? value : base);
  const w = world({ mocks: { scripts: { "reader-family-one": script, "reader-family-two": script } } });
  await w.scheduler.plan();
  await drive(w.scheduler);
  const readers = (await w.repo.listTasks(w.wf)).filter((x) => x.roleKey === "table_reader");
  const attempts = (await Promise.all(readers.map((x) => w.repo.listAttempts(x.taskId)))).flat();
  t.check(`${label}: the reading fails known — a malformed answer is not evidence`,
    readers.length > 0 && readers.every((x) => x.state === "failed_known") && attempts.every((a) => a.state === "failed_known"),
    `${readers.map((x) => x.state).join(", ")} / ${attempts.map((a) => a.state).join(", ")}`);
  t.check(`${label}: the attempt's rawResult is exactly what came back, not a shape the kernel gave it`,
    attempts.length > 0 && attempts.every((a) => canonical(a.rawResult) === canonical(value) && typeof a.rawResult === typeof value),
    attempts.map((a) => `${typeof a.rawResult}:${JSON.stringify(a.rawResult)?.slice(0, 40)}`).join(" | "));
  t.check(`${label}: rawResultHash is the digest of that same raw value`,
    attempts.every((a) => a.rawResultHash === sha256(canonical(value))), attempts.map((a) => String(a.rawResultHash).slice(0, 12)).join(", "));
  await expectation(attempts, w);
  return { attempts, w };
}

await junkRun("a string", "a sentence where an envelope was asked for", async (attempts) => {
  t.check("a string: the record shows a string, and the message says the answer was not an envelope",
    attempts.every((a) => typeof a.rawResult === "string" && /not an envelope/.test(a.errorMessage ?? "")),
    attempts[0]?.errorMessage?.slice(0, 80));
});

await junkRun("a null", null, async (attempts) => {
  t.check("a null: the digest is the digest of null, so 'nothing came back' is itself on the record",
    attempts.every((a) => a.rawResult === null && a.rawResultHash === sha256(canonical(null))));
});

await junkRun("an object with no outcome", { claims: [], note: "an answer that forgot to say how it ended" }, async (attempts) => {
  t.check("an object with no outcome: the record keeps its fields as they were returned",
    attempts.every((a) => a.rawResult && a.rawResult.note === "an answer that forgot to say how it ended" && Array.isArray(a.rawResult.claims)));
});

{
  /* An answer that is envelope-shaped but answers the wrong assignment: it
     reaches the validator, and the validator's problems are kept. */
  const script = (packet, base) => (packet.roleKey === "table_reader" ? { ...base, taskId: "00000000-0000-5000-8000-000000000000" } : base);
  const w = world({ mocks: { scripts: { "reader-family-one": script, "reader-family-two": script } } });
  await w.scheduler.plan();
  await drive(w.scheduler);
  const readers = (await w.repo.listTasks(w.wf)).filter((x) => x.roleKey === "table_reader");
  const attempts = (await Promise.all(readers.map((x) => w.repo.listAttempts(x.taskId)))).flat();
  t.check("an envelope answering another assignment fails known with its validation state invalid and the problem named",
    attempts.length > 0 && attempts.every((a) => a.state === "failed_known" && a.validationState === "invalid"
      && a.validationProblems.some((p) => /different task/.test(p))),
    attempts.map((a) => `${a.validationState}:${a.validationProblems[0] ?? "none"}`).join(" | "));
  t.check("its raw answer is kept whole all the same, with the digest over what was said",
    attempts.every((a) => a.rawResult !== null && a.rawResult.taskId === "00000000-0000-5000-8000-000000000000"
      && a.rawResultHash === sha256(canonical(a.rawResult))));
  t.check("nothing of that answer entered the record: the reading produced no claim",
    (await w.repo.listClaims({ workflowId: w.wf, taskIds: readers.map((x) => x.taskId) })).length === 0);
}

/* ═══════════════════════ 13. committing the same answer twice */
t.section("a second commit of the same attempt returns what the first wrote");
{
  const w = world();
  const recorded = [];
  const commit = w.repo.commitValidatedResult.bind(w.repo);
  w.repo.commitValidatedResult = async (c) => {
    const out = await commit(c);
    recorded.push({ commit: c, out });
    return out;
  };
  await w.scheduler.plan();
  await drive(w.scheduler);
  const withClaims = recorded.find((r) => r.out.alreadyCommitted === false && r.out.claims.length > 0);
  t.check("the run committed at least one answer that carried claims", withClaims !== undefined, `${recorded.length} commits`);

  const claimsBefore = (await w.repo.listClaims({ workflowId: w.wf })).length;
  const again = await commit(withClaims.commit);
  t.check("committing it a second time says so rather than writing again", again.alreadyCommitted === true);
  const first = withClaims.out.claims.map((c) => c.claimId).sort();
  const second = again.claims.map((c) => c.claimId).sort();
  t.check("the second commit returns the same claim ids the first wrote",
    first.length > 0 && first.length === second.length && first.every((id, i) => id === second[i]),
    `${first.length} claims`);
  t.check("no claim was duplicated by the second commit",
    (await w.repo.listClaims({ workflowId: w.wf })).length === claimsBefore, `${claimsBefore} claims before and after`);
  const attempt = await w.repo.getAttempt(withClaims.commit.attemptId);
  t.check("the attempt still holds the one raw result it was given, in its terminal state",
    attempt.state === "succeeded" && attempt.rawResultHash === withClaims.commit.attempt.rawResultHash);
}

/* ═══════════════════════ every door stayed closed */
t.section("every door stayed closed");
t.check("nothing in this file tried the network", tripped() === 0, `${tripped()} attempts`);

t.finish();
