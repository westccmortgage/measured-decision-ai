import { harness, closeNetwork } from "./harness.mjs";
import { buildTaskGraph } from "../graph-builder.ts";
import { syntheticManifest } from "../fixtures/synthetic-project.ts";
import { DEFAULT_POLICY, policyWith } from "../orchestration-policy.ts";
import { roleForTaskType } from "../role-registry.ts";
import { InMemoryOrchestrationRepository } from "../repository.ts";
import { AgentRouter } from "../router.ts";
import { Scheduler } from "../scheduler.ts";
import { mockExecutors } from "../cli.ts";

const t = harness("a project becomes bounded assignments");
const tripped = closeNetwork();
const manifest = syntheticManifest();
const graph = buildTaskGraph(manifest, DEFAULT_POLICY);

t.section("many small assignments, never one large one");
t.check("the planner refused nothing", graph.refusals.length === 0, graph.refusals.join("; "));
t.check("the project became dozens of assignments", graph.tasks.length >= 40, `${graph.tasks.length} tasks`);
const allSources = new Set([...manifest.pages.map((p) => p.pageId), ...manifest.regions.map((r) => r.regionId)]);
t.check("no assignment carries the complete project", graph.tasks.every((task) => task.sourceIds.length < allSources.size));
t.check("no assignment carries more than a handful of sources", graph.tasks.every((task) => task.sourceIds.length <= 3), String(Math.max(...graph.tasks.map((x) => x.sourceIds.length))));
const docsOf = (task) => new Set(task.sourceIds.map((id) => manifest.pages.find((p) => p.pageId === id)?.documentId ?? manifest.pages.find((p) => p.pageId === manifest.regions.find((r) => r.regionId === id)?.pageId)?.documentId));
t.check("no extraction assignment spans both documents", graph.tasks.filter((x) => x.sourceIds.length).every((x) => docsOf(x).size === 1));
t.check("a planner that is handed a document without a content hash refuses it",
  buildTaskGraph(syntheticManifest({ documents: [{ documentId: "doc_str", filename: "x.pdf", contentHash: "" }] }), DEFAULT_POLICY).refusals.length > 0);
t.check("a manifest that would exceed the task ceiling is refused, not truncated",
  buildTaskGraph(manifest, policyWith({ maximumTasksPerWorkflow: 10 })).refusals.some((r) => /ceiling/.test(r)));

t.section("each assignment goes to its specialist");
t.check("every task's role is the one registered for its task type", graph.tasks.every((task) => roleForTaskType(task.taskType).roleKey === task.roleKey));
const byType = Object.fromEntries(graph.tasks.map((x) => [x.taskType, x.roleKey]));
t.check("schedules go to the schedule reader, legends to the legend reader, plans to the locator",
  byType.extract_schedule === "schedule_reader" && byType.extract_legend === "legend_reader" && byType.locate_symbol_family === "symbol_locator");
t.check("counting goes to code, not to a reader", byType.count_instances === "deterministic_counter" && byType.derive_materials === "assembly_calculator");
t.check("comparison goes to code", byType.detect_disagreements === "deterministic_comparator");
t.check("one locator per plan region per symbol family per reader", graph.tasks.filter((x) => x.taskType === "locate_symbol_family").length === 8);
t.check("no task is a conversation: every task has one subject and a declared type", graph.tasks.every((x) => x.subjectKey && x.taskType));

t.section("independent readings are separate assignments");
const pairs = graph.independentSubjects;
t.check("schedules, notes and symbol families each got two blind readers", pairs.length === 8 && pairs.every((p) => p.groups.length === 2), `${pairs.length} subjects`);
t.check("the two readers of one subject have different independence groups", pairs.every((p) => new Set(p.groups).size === p.groups.length));
t.check("the two readers of one subject are distinct tasks with distinct fingerprints", pairs.every((p) => {
  const tasks = graph.tasks.filter((x) => x.subjectKey === p.subjectKey && x.independenceGroup);
  return tasks.length === 2 && tasks[0].taskId !== tasks[1].taskId && tasks[0].inputFingerprint !== tasks[1].inputFingerprint;
}));
t.check("neither reader of a pair depends on the other", pairs.every((p) => {
  const tasks = graph.tasks.filter((x) => x.subjectKey === p.subjectKey && x.independenceGroup);
  return tasks.every((a) => !a.dependsOn.some((d) => tasks.some((b) => b.taskId === d.taskId)));
}));
t.check("the comparison of a subject depends on both of its readers", pairs.every((p) => {
  const compare = graph.tasks.find((x) => x.taskType === "detect_disagreements" && x.subjectKey === p.subjectKey);
  const readers = graph.tasks.filter((x) => x.subjectKey === p.subjectKey && x.independenceGroup).map((x) => x.taskId);
  return compare && readers.every((id) => compare.dependsOn.some((d) => d.taskId === id));
}));
t.check("planning is deterministic: the same manifest gives the same task ids", JSON.stringify(buildTaskGraph(manifest, DEFAULT_POLICY).tasks.map((x) => x.taskId)) === JSON.stringify(graph.tasks.map((x) => x.taskId)));

t.section("unrelated assignments run at the same time");
const repo = new InMemoryOrchestrationRepository();
const executors = mockExecutors();
const scheduler = new Scheduler(repo, manifest, policyWith({ maximumConcurrentTasksPerWorkflow: 5, maximumConcurrentTasksPerRole: 3 }), new AgentRouter(), executors, { owner: "w", leaseTtlMs: 1000, now: () => 0 });
await scheduler.plan();
const first = await scheduler.tick();
t.check("the first tick dispatches several ingestion tasks at once", first.dispatched.length > 1, `${first.dispatched.length}`);
t.check("and exactly as many as the policy allows one role — three, not the workflow's five", first.dispatched.length === 3
  && first.dispatched.every((id) => repo.tasks.get(id).roleKey === "deterministic_ingestor"), `${first.dispatched.length}`);
const second = await scheduler.tick();
t.check("the next tick takes the remaining ingestions and the mappings they released", second.dispatched.length > 0);
const run = await scheduler.runUntilQuiescent();
const byRole = run.byRole;
t.check("every role the graph named did its work", ["schedule_reader", "symbol_locator", "deterministic_comparator", "deterministic_counter", "decision_composer"].every((r) => byRole[r] > 0));
t.check("no network call was attempted", tripped() === 0);
t.finish();
