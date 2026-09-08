/* What the recovery skeptic found: two workers with one name, a stop that
   lands mid-dispatch, a lease nobody reclaimed, a repository that throws after
   the answer came back, a restart of a cancelled run. Each is a test now. */
import { harness, closeNetwork } from "./harness.mjs";
import { buildTaskGraph } from "../graph-builder.ts";
import { syntheticManifest } from "../fixtures/synthetic-project.ts";
import { DEFAULT_POLICY } from "../orchestration-policy.ts";
import { InMemoryOrchestrationRepository } from "../repository.ts";
import { AgentRouter } from "../router.ts";
import { Scheduler } from "../scheduler.ts";
import { mockExecutors } from "../cli.ts";
import { SUBMITTED_ATTEMPT_STATES } from "../transitions.ts";

const t = harness("what the recovery skeptic found");
const tripped = closeNetwork();
const manifest = syntheticManifest();
const graph = buildTaskGraph(manifest, DEFAULT_POLICY);
const opts = { owner: "worker-1", leaseTtlMs: 60_000, now: () => 0 };
const attemptOf = (task, no = 1) => ({ attemptId: `attempt_${task.taskId}_${no}`, taskId: task.taskId, attemptNo: no, executorFamily: "deterministic", modelConfiguration: "code", roleKey: task.roleKey, state: "prepared", inputFingerprint: task.inputFingerprint, independenceGroup: null, rawEnvelope: null, validationErrors: [], errorCode: null, errorMessage: null });

t.section("C · two workers with the same name are two workers");
{
  const repo = new InMemoryOrchestrationRepository();
  const r1 = mockExecutors(), r2 = mockExecutors();
  const s1 = new Scheduler(repo, manifest, DEFAULT_POLICY, new AgentRouter(), r1, opts);
  const s2 = new Scheduler(repo, manifest, DEFAULT_POLICY, new AgentRouter(), r2, opts);
  await s1.plan();
  for (let i = 0; i < 200; i++) {
    const [a, b] = await Promise.all([s1.tick(), s2.tick()]);
    if (!a.dispatched.length && !b.dispatched.length && !a.released && !b.released && !a.stopped && !b.stopped) break;
  }
  const executions = r1.invocations.length + r2.invocations.length;
  const submitted = [...repo.attempts.values()].filter((a) => SUBMITTED_ATTEMPT_STATES.includes(a.state)).length;
  const byTask = new Map();
  for (const i of [...r1.invocations, ...r2.invocations]) byTask.set(i.taskId, (byTask.get(i.taskId) ?? 0) + 1);
  t.check("ticking concurrently under one owner name, every execution is one submitted attempt — nothing paid for twice", executions === submitted, `${executions} executions, ${submitted} submitted attempts`);
  t.check("no task ran in both workers", [...byTask.values()].every((n) => n === 1));
  const reference = new InMemoryOrchestrationRepository();
  const one = new Scheduler(reference, manifest, DEFAULT_POLICY, new AgentRouter(), mockExecutors(), opts);
  await one.plan(); await one.runUntilQuiescent();
  const count = (repository) => [...repository.tasks.values()].filter((x) => x.state === "completed").length;
  t.check("and the run reached the same end as one worker alone", count(repo) === count(reference) && ![...repo.tasks.values()].some((x) => ["running", "leased", "queued"].includes(x.state)), `${count(repo)} vs ${count(reference)} completed`);
}

t.section("C · a stop that lands while a packet is being built sends nothing");
{
  const repo = new InMemoryOrchestrationRepository();
  const executors = mockExecutors();
  const s = new Scheduler(repo, manifest, DEFAULT_POLICY, new AgentRouter(), executors, opts);
  await s.plan();
  const original = repo.createAttempt.bind(repo);
  let fired = false;
  let counts = null;
  repo.createAttempt = async (record) => { if (!fired) { fired = true; counts = await s.cancel("the owner stopped it"); } return original(record); };
  const report = await s.tick();
  t.check("nothing was executed after the stop", executors.invocations.length === 0, `${executors.invocations.length} executions`);
  t.check("every task dispatched in that tick ended cancelled, not completed", report.dispatched.length > 0 && report.cancelled.length === report.dispatched.length && report.completed.length === 0);
  t.check("no attempt was ever submitted", [...repo.attempts.values()].every((a) => a.state === "cancelled_before_submission"));
  t.check("the stop counted them as unsent, not as submitted work awaiting reconciliation", counts.submittedUnresolved === 0 && counts.unsentCancelled > 0);
  t.check("nothing is left running or leased", [...repo.tasks.values()].every((x) => x.state !== "running" && x.state !== "leased"));
}

t.section("C · a worker that dies with an attempt in flight leaves an unknown outcome, and the restart says so");
{
  const repo = new InMemoryOrchestrationRepository();
  const executors = mockExecutors();
  const target = graph.tasks.find((x) => x.taskType === "extract_schedule" && x.independenceGroup === "reader-a").taskId;
  let snapshot = null;
  const original = executors.run.bind(executors);
  executors.run = async (selection, packet) => {
    if (packet.taskId === target && !snapshot) { snapshot = repo.snapshot(); throw new Error("the process died here"); }
    return original(selection, packet);
  };
  const s = new Scheduler(repo, manifest, DEFAULT_POLICY, new AgentRouter(), executors, { owner: "worker-1", leaseTtlMs: 1000, now: () => 0 });
  await s.plan();
  await s.runUntilQuiescent();
  const atCrash = snapshot.tasks.find((x) => x.taskId === target);
  t.check("the snapshot was taken with the task running and its attempt submitted", atCrash.state === "running" && snapshot.attempts.find((a) => a.taskId === target).state === "submitted");
  const restored = InMemoryOrchestrationRepository.fromSnapshot(snapshot);
  const later = mockExecutors();
  const s2 = new Scheduler(restored, manifest, DEFAULT_POLICY, new AgentRouter(), later, { owner: "worker-2", leaseTtlMs: 1000, now: () => 10_000_000 });
  await s2.plan();
  const run = await s2.runUntilQuiescent();
  t.check("after the lease expired the task is outcome_unknown — the provider may have run", restored.tasks.get(target).state === "outcome_unknown" && (await restored.listAttempts(target))[0].state === "outcome_unknown");
  t.check("it was not executed again", later.invocations.filter((i) => i.taskId === target).length === 0 && (await restored.listAttempts(target)).length === 1);
  t.check("nothing is left running, and the workflow is partial — never completed with work open", ![...restored.tasks.values()].some((x) => x.state === "running" || x.state === "leased") && run.workflow.state === "partial");
  t.check("the rest of the project went on", run.tasks.completed > 20, JSON.stringify(run.tasks));
}

t.section("C · a lease left behind is reclaimed by the scheduler, and the work runs once");
{
  const repo = new InMemoryOrchestrationRepository();
  const s = new Scheduler(repo, manifest, DEFAULT_POLICY, new AgentRouter(), mockExecutors(), opts);
  await s.plan();
  await repo.releaseDependents(manifest.workflowId);
  const [task] = await repo.getRunnableTasks(manifest.workflowId);
  await repo.leaseTask(task.taskId, "worker-1", 1000, 0);
  await repo.createAttempt(attemptOf(task));
  const snapshot = repo.snapshot();
  const restored = InMemoryOrchestrationRepository.fromSnapshot(snapshot);
  const executors = mockExecutors();
  const s2 = new Scheduler(restored, manifest, DEFAULT_POLICY, new AgentRouter(), executors, { owner: "worker-2", leaseTtlMs: 1000, now: () => 5000 });
  await s2.plan();
  await s2.runUntilQuiescent();
  const attempts = await restored.listAttempts(task.taskId);
  t.check("the expired lease was reclaimed from tick() and the task completed", restored.tasks.get(task.taskId).state === "completed" && (await restored.listAudit()).some((a) => a.action === "core_v2.task.lease_reclaimed" && a.entityId === task.taskId));
  t.check("the dead worker's prepared attempt was closed and one real attempt was made", attempts.length === 2 && attempts[0].state === "cancelled_before_submission" && attempts[1].state === "succeeded" && executors.invocations.filter((i) => i.taskId === task.taskId).length === 1);
}

t.section("C · a repository that fails after the answer came back fails the task, not the tick");
{
  const repo = new InMemoryOrchestrationRepository();
  const target = graph.tasks.find((x) => x.taskType === "extract_legend").taskId;
  const original = repo.persistClaims.bind(repo);
  let thrown = false;
  repo.persistClaims = async (task, ...rest) => { if (task.taskId === target && !thrown) { thrown = true; throw new Error("the database went away"); } return original(task, ...rest); };
  const s = new Scheduler(repo, manifest, DEFAULT_POLICY, new AgentRouter(), mockExecutors(), opts);
  await s.plan();
  let run = null, error = null;
  try { run = await s.runUntilQuiescent(); } catch (e) { error = e; }
  t.check("the run did not throw", error === null, String(error?.message ?? ""));
  t.check("the task is failed_known with the engine error as its reason, its answer kept on the attempt", repo.tasks.get(target).state === "failed_known" && /engine_error/.test(repo.tasks.get(target).terminalReason) && (await repo.listAttempts(target))[0].rawEnvelope !== null);
  t.check("it was not retried, and the workflow ended partial", (await repo.listAttempts(target)).length === 1 && run.workflow.state === "partial");
}
{
  /* The same fault inside a dispute: the dispute goes to a person, not to limbo. */
  const repo = new InMemoryOrchestrationRepository();
  const original = repo.persistAssessments.bind(repo);
  let thrown = false;
  repo.persistAssessments = async (task, ...rest) => { if (task.taskType === "verify_disagreement" && !thrown) { thrown = true; throw new Error("the database went away"); } return original(task, ...rest); };
  const s = new Scheduler(repo, manifest, DEFAULT_POLICY, new AgentRouter(), mockExecutors(), opts);
  await s.plan();
  await s.runUntilQuiescent();
  const failed = [...repo.tasks.values()].find((x) => x.taskType === "verify_disagreement" && x.state === "failed_known");
  const dis = failed ? repo.disagreements.get(failed.disagreementId) : null;
  t.check("a verifier that died in the engine leaves its dispute with a person, with the reason, not in `verifying`", dis && dis.state === "needs_human" && /engine_error/.test(dis.needsHumanReason), `${dis?.state}: ${dis?.needsHumanReason}`);
  t.check("and a hold decision exists for it", dis && [...repo.decisions.values()].some((d) => d.disagreementId === dis.disagreementId && d.decisionType === "hold" && d.status === "needs_human"));
}

t.section("C · a cancelled run restarted stays cancelled");
{
  const repo = new InMemoryOrchestrationRepository();
  const s = new Scheduler(repo, manifest, DEFAULT_POLICY, new AgentRouter(), mockExecutors(), opts);
  await s.plan(); await s.tick(); await s.tick();
  await s.cancel("stopped");
  const restored = InMemoryOrchestrationRepository.fromSnapshot(repo.snapshot());
  const executors = mockExecutors();
  const s2 = new Scheduler(restored, manifest, DEFAULT_POLICY, new AgentRouter(), executors, { ...opts, owner: "worker-2" });
  await s2.plan();
  const run = await s2.runUntilQuiescent();
  t.check("re-planning a cancelled workflow does not make it running again", run.workflow.state === "cancelled" && run.workflow.cancelRequested === true);
  t.check("and nothing was dispatched", executors.invocations.length === 0);
}

t.section("C · the repository's small refusals");
{
  const repo = new InMemoryOrchestrationRepository();
  const s = new Scheduler(repo, manifest, DEFAULT_POLICY, new AgentRouter(), mockExecutors(), opts);
  await s.plan();
  await repo.releaseDependents(manifest.workflowId);
  const [task, other] = await repo.getRunnableTasks(manifest.workflowId);
  await repo.leaseTask(task.taskId, "worker-1", 1000, 0);
  const attempt = await repo.createAttempt(attemptOf(task));
  await repo.transitionTask(task.taskId, "running");
  await repo.transitionAttempt(attempt.attemptId, "submitted");
  await repo.transitionTask(task.taskId, "leased").catch(() => {});
  t.check("an expired lease whose attempt was submitted is not handed to another worker — null, not an exception", (await repo.leaseTask(task.taskId, "worker-2", 1000, 5000)) === null);
  await t.refused("an attempt id is made once", () => repo.createAttempt(attemptOf(task)));
  await repo.leaseTask(other.taskId, "worker-1", 1000, 0);
  await repo.createAttempt(attemptOf(other, 1));
  await repo.createAttempt(attemptOf(other, 3));
  await t.refused("an attempt number is made once", () => repo.createAttempt(attemptOf(other, 3)));
  const snapshot = repo.snapshot();
  const a = InMemoryOrchestrationRepository.fromSnapshot(snapshot);
  const b = InMemoryOrchestrationRepository.fromSnapshot(snapshot);
  await a.audit({ action: "x", entityType: "y", entityId: "z", detail: {} });
  await a.addDependency(other.taskId, task.taskId, "requires_completion").catch(() => {});
  t.check("two repositories restored from one snapshot share nothing", b.auditTrail.length === snapshot.audit.length && b.dependencies.length === snapshot.dependencies.length && a.dependencies !== b.dependencies);
}
t.check("no network call was attempted", tripped() === 0);
t.finish();
