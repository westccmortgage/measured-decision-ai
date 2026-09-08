import { harness, closeNetwork } from "./harness.mjs";
import { buildTaskGraph } from "../graph-builder.ts";
import { syntheticManifest } from "../fixtures/synthetic-project.ts";
import { DEFAULT_POLICY } from "../orchestration-policy.ts";
import { InMemoryOrchestrationRepository } from "../repository.ts";
import { AgentRouter } from "../router.ts";
import { Scheduler } from "../scheduler.ts";
import { mockExecutors } from "../cli.ts";

const t = harness("fan out, and gather back");
const tripped = closeNetwork();
const manifest = syntheticManifest();
const graph = buildTaskGraph(manifest, DEFAULT_POLICY);
const compare = graph.tasks.find((x) => x.taskType === "detect_disagreements" && x.subjectKey === "pg_x2/rg_x2_sched");
const readers = graph.tasks.filter((x) => x.subjectKey === "pg_x2/rg_x2_sched" && x.independenceGroup);

t.section("comparison waits for its declared dependencies");
{
  const repo = new InMemoryOrchestrationRepository();
  const scheduler = new Scheduler(repo, manifest, DEFAULT_POLICY, new AgentRouter(), mockExecutors(), { owner: "w", leaseTtlMs: 1000, now: () => 0 });
  await scheduler.plan();
  let ranBeforeReaders = false;
  for (let i = 0; i < 6; i++) {
    const r = await scheduler.tick();
    const readersDone = readers.every((x) => repo.tasks.get(x.taskId).state === "completed");
    if (r.dispatched.includes(compare.taskId) && !readersDone) ranBeforeReaders = true;
    if (readersDone) break;
  }
  t.check("the comparison did not run before both readers finished", !ranBeforeReaders);
  t.check("while the readers were unfinished the comparison stayed blocked", ["blocked", "queued", "completed"].includes(repo.tasks.get(compare.taskId).state));
  await scheduler.runUntilQuiescent();
  t.check("and it ran once both had", repo.tasks.get(compare.taskId).state === "completed");
}

t.section("branches are independent");
{
  const repo = new InMemoryOrchestrationRepository();
  const scheduler = new Scheduler(repo, manifest, DEFAULT_POLICY, new AgentRouter(), mockExecutors(), { owner: "w", leaseTtlMs: 1000, now: () => 0 });
  await scheduler.plan();
  const first = await scheduler.tick();
  const second = await scheduler.tick();
  const third = await scheduler.tick();
  t.check("several extraction branches ran in one tick", third.dispatched.length > 1 || second.dispatched.length > 1, `${first.dispatched.length}/${second.dispatched.length}/${third.dispatched.length}`);
}

t.section("one failed branch does not erase completed branches");
{
  const unknown = readers[1].taskId;
  const repo = new InMemoryOrchestrationRepository();
  const executors = mockExecutors({ unknownOutcomeTaskIds: [unknown] });
  const scheduler = new Scheduler(repo, manifest, DEFAULT_POLICY, new AgentRouter(), executors, { owner: "w", leaseTtlMs: 1000, now: () => 0 });
  await scheduler.plan();
  const run = await scheduler.runUntilQuiescent();
  t.check("the reader whose outcome was unknown ended outcome_unknown", repo.tasks.get(unknown).state === "outcome_unknown");
  t.check("its comparison was stopped, not run on half the evidence", repo.tasks.get(compare.taskId).state === "cancelled" && /upstream_outcome_unknown/.test(repo.tasks.get(compare.taskId).terminalReason));
  t.check("the other reader of the same subject completed and its claims are kept", repo.tasks.get(readers[0].taskId).state === "completed" && [...repo.claims.values()].some((c) => c.taskId === readers[0].taskId));
  const otherSubjects = graph.tasks.filter((x) => x.taskType === "detect_disagreements" && x.taskId !== compare.taskId);
  t.check("every unrelated comparison still ran", otherSubjects.every((x) => repo.tasks.get(x.taskId).state === "completed"), otherSubjects.map((x) => repo.tasks.get(x.taskId).state).join(","));
  t.check("unrelated counts and decisions were still made", run.byRole.deterministic_counter > 0 && Object.keys(run.decisions).some((k) => k.startsWith("accept_claim")));
  t.check("the workflow ended partial, with the attention counted", run.workflow.state === "partial" && run.workflow.attentionUnits > 0);
  t.check("completed units were counted from terminal tasks, not from elapsed time", run.workflow.completedUnits === [...repo.tasks.values()].filter((x) => ["completed", "failed_known", "outcome_unknown", "cancelled", "superseded"].includes(x.state)).length);
}

t.section("downstream starts only when what it needs has finished");
{
  const repo = new InMemoryOrchestrationRepository();
  const scheduler = new Scheduler(repo, manifest, DEFAULT_POLICY, new AgentRouter(), mockExecutors(), { owner: "w", leaseTtlMs: 1000, now: () => 0 });
  await scheduler.plan();
  const count = graph.tasks.find((x) => x.taskType === "count_instances" && x.subjectKey === "HDR-H");
  let violated = false;
  for (let i = 0; i < 40; i++) {
    const r = await scheduler.tick();
    if (r.dispatched.includes(count.taskId)) {
      const deps = await repo.getDependencies(count.taskId);
      if (!deps.every((d) => repo.tasks.get(d.dependsOnTaskId).state === "completed")) violated = true;
    }
    if (r.dispatched.length === 0 && r.released === 0 && r.stopped === 0) break;
  }
  t.check("the count of HDR-H ran only after every one of its dependencies — including the adjudication added later — completed", !violated);
  const deps = await repo.getDependencies(count.taskId);
  t.check("its dependencies grew to include the adjudication the disagreement made necessary", deps.some((d) => repo.tasks.get(d.dependsOnTaskId)?.taskType === "adjudicate"));
}
t.check("no network call was attempted", tripped() === 0);
t.finish();
