import { harness, closeNetwork } from "./harness.mjs";
import { buildTaskGraph } from "../graph-builder.ts";
import { syntheticManifest } from "../fixtures/synthetic-project.ts";
import { DEFAULT_POLICY } from "../orchestration-policy.ts";
import { InMemoryOrchestrationRepository } from "../repository.ts";
import { AgentRouter } from "../router.ts";
import { Scheduler } from "../scheduler.ts";
import { mockExecutors, simulate, closeTheNetwork } from "../cli.ts";

const t = harness("restart, cancel, and the unknown outcome");
const tripped = closeNetwork();
const manifest = syntheticManifest();
const graph = buildTaskGraph(manifest, DEFAULT_POLICY);
const opts = { owner: "worker-1", leaseTtlMs: 60_000, now: () => 0 };

/* A complete, uninterrupted run — what every interrupted run is compared with. */
const reference = new InMemoryOrchestrationRepository();
const referenceRun = await new Scheduler(reference, manifest, DEFAULT_POLICY, new AgentRouter(), mockExecutors(), opts).runUntilQuiescent
  ? await (async () => { const s = new Scheduler(reference, manifest, DEFAULT_POLICY, new AgentRouter(), mockExecutors(), opts); await s.plan(); return s.runUntilQuiescent(); })()
  : null;
const referenceTasks = [...reference.tasks.keys()].sort();
const referenceAttempts = reference.attempts.size;

t.section("a scheduler that dies is replaced by one that continues");
{
  const repo = new InMemoryOrchestrationRepository();
  const s1 = new Scheduler(repo, manifest, DEFAULT_POLICY, new AgentRouter(), mockExecutors(), opts);
  await s1.plan();
  for (let i = 0; i < 4; i++) await s1.tick();
  const midway = repo.snapshot();
  const doneAtCrash = midway.tasks.filter((x) => x.state === "completed").length;
  t.check("the run was genuinely mid-way when it died", doneAtCrash > 0 && doneAtCrash < referenceTasks.length, `${doneAtCrash} of ${referenceTasks.length}`);
  /* A new process, a new scheduler, the same persisted state. */
  const restored = InMemoryOrchestrationRepository.fromSnapshot(midway);
  const s2 = new Scheduler(restored, manifest, DEFAULT_POLICY, new AgentRouter(), mockExecutors(), { ...opts, owner: "worker-2" });
  const replanned = await s2.plan();
  t.check("planning again creates no task — every task already exists", replanned.created.length === 0 && replanned.existing.length === graph.tasks.length);
  const run = await s2.runUntilQuiescent();
  t.check("the restarted run reaches the same end", run.workflow.state === referenceRun.workflow.state && JSON.stringify(run.tasks) === JSON.stringify(referenceRun.tasks), `${JSON.stringify(run.tasks)} vs ${JSON.stringify(referenceRun.tasks)}`);
  t.check("with exactly the same tasks — nothing duplicated", JSON.stringify([...restored.tasks.keys()].sort()) === JSON.stringify(referenceTasks));
  t.check("and exactly the same number of attempts — nothing paid for twice", restored.attempts.size === referenceAttempts, `${restored.attempts.size} vs ${referenceAttempts}`);
  t.check("every task completed before the crash kept its one attempt", midway.tasks.filter((x) => x.state === "completed").every((x) => [...restored.attempts.values()].filter((a) => a.taskId === x.taskId).length === 1));
  t.check("every claim persisted before the crash is still there", midway.claims.every((c) => restored.claims.has(c.claimId)));
}

t.section("a lease is granted once");
{
  const repo = new InMemoryOrchestrationRepository();
  const s = new Scheduler(repo, manifest, DEFAULT_POLICY, new AgentRouter(), mockExecutors(), opts);
  await s.plan();
  await repo.releaseDependents(manifest.workflowId);
  const [task] = await repo.getRunnableTasks(manifest.workflowId);
  const a = await repo.leaseTask(task.taskId, "worker-1", 1000, 0);
  const again = await repo.leaseTask(task.taskId, "worker-1", 1000, 0);
  const other = await repo.leaseTask(task.taskId, "worker-2", 1000, 0);
  t.check("a live lease is granted to nobody else — not to another worker, not to a second worker with the same name", a !== null && again === null && other === null);
  const expired = await repo.leaseTask(task.taskId, "worker-2", 1000, 5000);
  t.check("an expired lease that never submitted goes to the next worker", expired !== null && expired.leaseOwner === "worker-2");
}

t.section("completed results survive a later failure");
{
  /* The dimension reading feeds every material calculation. When it ends
     unknown, the calculations stop — and nothing that did not need it does. */
  const late = graph.tasks.find((x) => x.taskType === "extract_dimensions").taskId;
  const repo = new InMemoryOrchestrationRepository();
  const s = new Scheduler(repo, manifest, DEFAULT_POLICY, new AgentRouter(), mockExecutors({ unknownOutcomeTaskIds: [late] }), opts);
  await s.plan();
  const run = await s.runUntilQuiescent();
  t.check("the late task ended unknown", repo.tasks.get(late).state === "outcome_unknown");
  const readers = graph.tasks.filter((x) => x.subjectKey === "pg_y1/rg_y1_plan/WIN-W" && x.independenceGroup).map((x) => x.taskId);
  t.check("readings that did not depend on it are still completed, with their claims", readers.every((id) => repo.tasks.get(id).state === "completed" && [...repo.claims.values()].some((c) => c.taskId === id)));
  t.check("accepted claims elsewhere remain accepted", [...repo.claims.values()].some((c) => c.subjectKey.startsWith("WIN-W/") && c.status === "accepted"));
  t.check("the WIN-W count, which needed no dimension, still ran and was accepted",
    repo.tasks.get(graph.tasks.find((x) => x.taskType === "count_instances" && x.subjectKey === "WIN-W").taskId).state === "completed"
    && [...repo.claims.values()].some((c) => c.subjectKey === "WIN-W" && c.predicate === "drawn_quantity" && c.status === "accepted"));
  const materials = graph.tasks.filter((x) => x.taskType === "derive_materials").map((x) => repo.tasks.get(x.taskId));
  t.check("only what depended on it was stopped: every material calculation, and nothing else", run.tasks.cancelled >= 3 && materials.every((x) => x.state === "cancelled" && /upstream_outcome_unknown/.test(x.terminalReason)));
}

t.section("cancelled work is not dispatched");
{
  const repo = new InMemoryOrchestrationRepository();
  const executors = mockExecutors();
  const s = new Scheduler(repo, manifest, DEFAULT_POLICY, new AgentRouter(), executors, opts);
  await s.plan();
  await s.tick(); await s.tick();
  const before = executors.invocations.length;
  const counts = await s.cancel("the owner stopped it");
  const after = await s.tick();
  t.check("after cancellation nothing is dispatched", after.dispatched.length === 0 && executors.invocations.length === before);
  t.check("unsent work was cancelled and completed work preserved, and the answer says how much of each", counts.unsentCancelled > 0 && counts.completedPreserved > 0);
  t.check("every task that had not started is cancelled; every finished one is still completed", [...repo.tasks.values()].every((x) => ["cancelled", "completed"].includes(x.state)));
  t.check("the stop is in the audit trail with its counts", (await repo.listAudit()).some((a) => a.action === "core_v2.workflow.cancelled" && a.detail.unsent_cancelled === counts.unsentCancelled));
}

t.section("an unknown outcome is never retried automatically");
{
  const target = graph.tasks.find((x) => x.taskType === "extract_schedule" && x.independenceGroup === "reader-a").taskId;
  const repo = new InMemoryOrchestrationRepository();
  const executors = mockExecutors({ unknownOutcomeTaskIds: [target] });
  const s = new Scheduler(repo, manifest, DEFAULT_POLICY, new AgentRouter(), executors, opts);
  await s.plan();
  await s.runUntilQuiescent();
  for (let i = 0; i < 5; i++) await s.tick();
  const attempts = await repo.listAttempts(target);
  t.check("the task ended outcome_unknown after one attempt", repo.tasks.get(target).state === "outcome_unknown" && attempts.length === 1 && attempts[0].state === "outcome_unknown");
  t.check("further ticks never ran it again", executors.invocations.filter((i) => i.taskId === target).length === 1);
  await t.refused("and the repository refuses to requeue it", () => repo.transitionTask(target, "queued"));
  await t.refused("or to run it again", () => repo.transitionTask(target, "running"));
  t.check("the unknown outcome is in the audit trail", (await repo.listAudit()).some((a) => a.action === "core_v2.attempt.outcome_unknown"));
}

t.section("an executor that throws after submission is an unknown outcome, not a retry");
{
  const target = graph.tasks.find((x) => x.taskType === "extract_legend").taskId;
  const repo = new InMemoryOrchestrationRepository();
  const executors = mockExecutors();
  const original = executors.run.bind(executors);
  executors.run = async (selection, packet) => { if (packet.taskId === target) { executors.invocations.push({ family: selection.executorFamily, taskId: packet.taskId, roleKey: packet.roleKey }); throw new Error("connection reset"); } return original(selection, packet); };
  const s = new Scheduler(repo, manifest, DEFAULT_POLICY, new AgentRouter(), executors, opts);
  await s.plan();
  await s.runUntilQuiescent();
  const attempts = await repo.listAttempts(target);
  t.check("the attempt is recorded as outcome_unknown with the error", attempts.length === 1 && attempts[0].state === "outcome_unknown" && /connection reset/.test(attempts[0].errorMessage));
  t.check("and it was invoked exactly once", executors.invocations.filter((i) => i.taskId === target).length === 1);
}

t.section("no network, no provider");
{
  const guard = closeTheNetwork();
  const { summary, executors } = await simulate({ quiet: true });
  t.check("the simulation reports zero network calls", summary.networkCallsAttempted === 0 && guard.tripped() === 0);
  t.check("every executor family invoked was a mock or code", executors.invocations.every((i) => /^(deterministic|reader-family-|critic-family-|arbiter-family-)/.test(i.family)));
  t.check("the whole test process attempted no network call", tripped() === 0);
}
t.finish();
