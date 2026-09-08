/* TWO PHASES: WHAT THE SOURCE DECLARES, WHAT THE PACK EXPANDS.
 *
 * docs/core-v2.md §2: phase A is the kernel's — one ingest per source and,
 * where the pack names a discoverer, one discovery per source; discovered
 * segments are persisted under the attempt that found them. Phase B is the
 * pack's — from the persisted, accepted segments, every bounded assignment.
 * Expansion is idempotent, ids are derived from identity, and a manifest
 * with sources but no segments does not stop after discovery.
 *
 * Everything runs in memory against scripted executors; the network is
 * closed before the first import of the engine is used.
 */
import { harness, closeNetwork } from "./harness.mjs";
import { syntheticRecordSet } from "../domains/synthetic-records/fixture.ts";
import { SyntheticRecordsPack, TASK as RECORD_TASK } from "../domains/synthetic-records/pack.ts";
import { DEFAULT_CATEGORIES } from "../domains/synthetic-records/fixture.ts";
import { mockExecutors as recordExecutors } from "../domains/synthetic-records/mocks.ts";
import { syntheticTranscriptSet } from "../domains/synthetic-transcripts/fixture.ts";
import { SyntheticTranscriptsPack, TASK as TRANSCRIPT_TASK } from "../domains/synthetic-transcripts/pack.ts";
import { mockExecutors as transcriptExecutors } from "../domains/synthetic-transcripts/mocks.ts";
import { assemble, manualClock } from "../domains/simulate.ts";
import { KERNEL_TASK_TYPES } from "../kernel/contracts.ts";
import { entityId } from "../kernel/ids.ts";
import { segmentIdFor, sourceIdentityOf, taskIdFor, taskIdentity } from "../kernel/planning.ts";
import { TERMINAL_TASK_STATES } from "../kernel/transitions.ts";

const tripped = closeNetwork();
const t = harness("two phases: what the source declares, what the pack expands");

/* ───────────────────────────────────────────────────────────── helpers */

const V5 = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const isV5 = (id) => V5.test(id);
const sorted = (xs) => [...xs].sort();
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const byPhase = (tasks, phase) => tasks.filter((x) => x.phase === phase);
const open = (task) => !TERMINAL_TASK_STATES.includes(task.state);
const PHASE_RANK = { ingest: 0, discover: 1, analyze: 2, compare: 3, verify: 4, adjudicate: 5, derive: 6, compose: 7 };

/* What the next tick would see: dependencies released, then the queue in
   the order the repository hands it to the scheduler. */
async function runnableNow(repo, wf) {
  await repo.releaseDependents(wf);
  return repo.getRunnableTasks(wf);
}

/* One task at a time, so the record can be inspected between steps. */
const ONE_AT_A_TIME = { maximumConcurrentTasksPerWorkflow: 1 };

/* ════════════════════════════════════ records: phase A is the kernel's */

t.section("records: plan() creates phase A and nothing else");
{
  const truth = syntheticRecordSet({ seed: "expansion/records", sources: 2, sheetsPerSource: 2, entriesPerTable: 3 });
  const wf = truth.manifest.workflowId;
  const { registry } = recordExecutors(truth);
  const { scheduler, repo } = assemble({ manifest: truth.manifest, pack: new SyntheticRecordsPack(), executors: registry, clock: manualClock() });
  const planned = await scheduler.plan();
  const tasks = await repo.listTasks(wf);

  t.check("planning a manifest of two sources creates exactly two tasks", planned.created.length === 2 && tasks.length === 2, `created ${planned.created.length}, in record ${tasks.length}`);
  t.check("every planned task is an ingest of one source by the source ingestor", tasks.every((x) => x.phase === "ingest" && x.taskType === KERNEL_TASK_TYPES.ingest && x.roleKey === "source_ingestor"));
  t.check("each ingest names exactly its one source and no segment", tasks.every((x) => x.sources.length === 1 && x.sources[0].segmentId === null && truth.manifest.sources.some((s) => s.sourceId === x.sources[0].sourceId)));
  const expectedIngestIds = truth.manifest.sources.map((s) => taskIdFor(wf, taskIdentity(wf, "ingest", KERNEL_TASK_TYPES.ingest, `source:${s.ordinal}`, [sourceIdentityOf(s)], null)));
  t.check("an ingest task's id is derived from the identity of its work, not minted", same(sorted(tasks.map((x) => x.taskId)), sorted(expectedIngestIds)));
  t.check("a pack whose sources declare their own segments gets no source-level discovery task", !tasks.some((x) => x.phase === "discover"));
  t.check("no analysis, comparison or derivation exists before any segment is persisted", !tasks.some((x) => ["analyze", "compare", "derive", "compose"].includes(x.phase)));
  t.check("no segment is persisted by planning alone; declared segments arrive with the ingest attempt", (await repo.listSegments(wf)).length === 0);
  t.check("planned work has depth 0", tasks.every((x) => x.depth === 0 && x.parentTaskId === null));
  t.check("the workflow is running once phase A is admitted", (await repo.getWorkflow(wf)).state === "running");
  const again = await scheduler.plan();
  t.check("planning the same manifest twice creates nothing the second time", again.created.length === 0 && same(sorted(again.existing), sorted(expectedIngestIds)), `created ${again.created.length}, existing ${again.existing.length}`);
  t.check("phase A's second planning leaves the task count unchanged", (await repo.listTasks(wf)).length === 2);
}

/* ═══════════════════════ records: ingest persists what the source declares */

t.section("records: ingest persists the declared sheets; discovery hangs the regions beneath them");
{
  const truth = syntheticRecordSet({ seed: "expansion/records", sources: 2, sheetsPerSource: 2, entriesPerTable: 3 });
  const wf = truth.manifest.workflowId;
  const { registry } = recordExecutors(truth);
  const { scheduler, repo } = assemble({ manifest: truth.manifest, pack: new SyntheticRecordsPack(), executors: registry, clock: manualClock(), policy: ONE_AT_A_TIME });
  await scheduler.plan();

  /* Tick 1: one ingest completes. */
  const first = await scheduler.tick();
  t.check("with room for one task, the first tick runs exactly one ingest", first.dispatched.length === 1 && first.completed.length === 1);
  const ingested = await repo.getTask(first.completed[0]);
  const source = truth.manifest.sources.find((s) => s.sourceId === ingested.sources[0].sourceId);
  const other = truth.manifest.sources.find((s) => s.sourceId !== source.sourceId);
  const segmentsAfterIngest = await repo.listSegments(wf);
  t.check("after one ingest, exactly that source's declared sheets are persisted", segmentsAfterIngest.length === source.declaredSegments.length && segmentsAfterIngest.every((s) => s.sourceId === source.sourceId && s.segmentKind === "sheet"), `${segmentsAfterIngest.length} segments`);
  t.check("a declared sheet is accepted by rule, not proposed", segmentsAfterIngest.every((s) => s.status === "accepted"));
  t.check("a declared sheet is recorded as found deterministically, by the ingest attempt", segmentsAfterIngest.every((s) => s.discoveredBy === "deterministic" && s.discoveredByAttemptId === entityId("attempt", ingested.taskId, 1)));
  t.check("a declared sheet's id equals segmentIdFor(workflow, source, no parent, kind, content hash)", same(sorted(segmentsAfterIngest.map((s) => s.segmentId)), sorted(source.declaredSegments.map((d) => segmentIdFor(wf, d.sourceId, null, d.segmentKind, d.contentHash)))));
  t.check("a declared sheet sits at the top level of its source", segmentsAfterIngest.every((s) => s.parentSegmentId === null));

  const afterIngest = await repo.listTasks(wf);
  const discoveries = afterIngest.filter((x) => x.taskType === RECORD_TASK.discoverRegions);
  t.check("the ingest's sheets expand into one region discovery per sheet, and only for the ingested source", discoveries.length === source.declaredSegments.length && discoveries.every((x) => segmentsAfterIngest.some((s) => s.segmentId === x.sources[0].segmentId)));
  t.check("a region discovery is the pack's discoverer role in the discover phase, at depth 0", discoveries.every((x) => x.phase === "discover" && x.roleKey === "region_discoverer" && x.depth === 0 && x.parentTaskId === null));
  t.check("no reader exists before any region is discovered", !afterIngest.some((x) => x.phase === "analyze" || x.phase === "compare"));
  t.check("no derivation exists while any sheet is still to be discovered", !afterIngest.some((x) => x.phase === "derive"));

  const queue = await runnableNow(repo, wf);
  const phases = queue.map((x) => x.phase);
  t.check("the queue offers the other source's ingest before any discovery", phases[0] === "ingest" && phases.includes("discover") && queue[0].sources[0].sourceId === other.sourceId, phases.join(", "));
  t.check("the queue is ordered by priority: no discovery is offered ahead of an ingest", phases.every((p, i) => i === 0 || PHASE_RANK[p] >= PHASE_RANK[phases[i - 1]]));

  /* Tick 2: the other ingest completes. */
  await scheduler.tick();
  const allSheets = await repo.listSegments(wf);
  t.check("after both ingests every declared sheet of every source is persisted and accepted", allSheets.length === 4 && allSheets.every((s) => s.status === "accepted" && s.segmentKind === "sheet"));

  /* Tick 3: one discovery completes. */
  const third = await scheduler.tick();
  const discovered = await repo.getTask(third.completed[0]);
  t.check("the third tick runs a region discovery, not a reader — discovery outranks analysis", third.completed.length === 1 && discovered.taskType === RECORD_TASK.discoverRegions);
  const sheet = allSheets.find((s) => s.segmentId === discovered.sources[0].segmentId);
  const truthSheet = truth.bySheetHash.get(sheet.contentHash);
  const regions = (await repo.listSegments(wf)).filter((s) => s.parentSegmentId !== null);
  t.check("the discoverer's regions are persisted beneath the sheet it read", regions.length === truthSheet.regions.length && regions.every((r) => r.parentSegmentId === sheet.segmentId && r.sourceId === sheet.sourceId), `${regions.length} regions`);
  t.check("a discovered region inside its parent is accepted", regions.every((r) => r.status === "accepted"));
  t.check("a discovered region is recorded as found by a model, under the discovery attempt", regions.every((r) => r.discoveredBy === "model" && r.discoveredByAttemptId === entityId("attempt", discovered.taskId, 1)));
  t.check("a discovered region's id equals segmentIdFor(workflow, source, sheet, kind, content hash)", same(sorted(regions.map((r) => r.segmentId)), sorted(truthSheet.regions.map((r) => segmentIdFor(wf, sheet.sourceId, sheet.segmentId, r.kind, r.contentHash)))));

  const afterDiscovery = await repo.listTasks(wf);
  const readers = byPhase(afterDiscovery, "analyze");
  const comparisons = byPhase(afterDiscovery, "compare");
  t.check("each discovered region gets two blind readers", readers.length === regions.length * 2 && regions.every((r) => same(sorted(readers.filter((x) => x.sources[0].segmentId === r.segmentId).map((x) => x.independenceGroup)), ["reader-a", "reader-b"])));
  t.check("a table gets table readers and a note gets note readers", readers.every((x) => { const r = regions.find((s) => s.segmentId === x.sources[0].segmentId); return r && x.taskType === (r.segmentKind === "table" ? RECORD_TASK.readTable : RECORD_TASK.readNote); }));
  t.check("each discovered region gets one comparison that waits for both of its readers' claims", comparisons.length === regions.length && (await Promise.all(comparisons.map(async (c) => {
    const deps = await repo.getDependencies(c.taskId);
    const mine = readers.filter((x) => x.subjectKey === c.subjectKey).map((x) => x.taskId);
    return deps.length === 2 && deps.every((d) => d.kind === "requires_claims" && mine.includes(d.dependsOnTaskId));
  }))).every(Boolean));
  t.check("expanded readers and comparisons are depth 0 with no parent", [...readers, ...comparisons].every((x) => x.depth === 0 && x.parentTaskId === null));
  t.check("KEY RULE: no derivation exists while three sheets are still undiscovered", !afterDiscovery.some((x) => x.phase === "derive") && afterDiscovery.filter((x) => x.taskType === RECORD_TASK.discoverRegions && open(x)).length === 3);

  const queue2 = await runnableNow(repo, wf);
  const phases2 = queue2.map((x) => x.phase);
  t.check("the queue offers the remaining discoveries before any reader", phases2.includes("discover") && phases2.includes("analyze") && phases2.indexOf("analyze") > phases2.lastIndexOf("discover"), phases2.join(", "));

  /* Tick on, one at a time, watching for a derivation that arrives early. */
  let earlyDerive = false;
  const allDiscovered = (tasks) => tasks.filter((x) => x.taskType === RECORD_TASK.discoverRegions).every((x) => x.state === "completed") && tasks.filter((x) => x.taskType === RECORD_TASK.discoverRegions).length === 4;
  for (let i = 0; i < 20; i++) {
    const now = await repo.listTasks(wf);
    if (allDiscovered(now)) break;
    if (now.some((x) => x.phase === "derive")) earlyDerive = true;
    await scheduler.tick();
  }
  t.check("no tick admitted a derivation while a discovery was still open", !earlyDerive);
  const afterAll = await repo.listTasks(wf);
  const derives = byPhase(afterAll, "derive");
  t.check("once every sheet's discovery completed, one derivation per category appears", allDiscovered(afterAll) && derives.length === DEFAULT_CATEGORIES.length && same(sorted(derives.map((x) => x.subjectKey)), sorted(DEFAULT_CATEGORIES.map((c) => `category/${c}`))), `${derives.length} derivations`);
  t.check("a derivation is the pack's deriver role at depth 0, waiting on its inputs", derives.every((x) => x.roleKey === "category_totaliser" && x.depth === 0 && ["created", "blocked"].includes(x.state)));
  const allRegions = (await repo.listSegments(wf)).filter((s) => s.parentSegmentId !== null);
  t.check("every sheet of every source now has its regions persisted and accepted", allRegions.length === truth.sheets.reduce((n, s) => n + s.regions.length, 0) && allRegions.every((r) => r.status === "accepted"));

  /* Idempotence. */
  const countBefore = afterAll.length;
  const again = await scheduler.expand();
  const packWork = afterAll.filter((x) => ["discover", "analyze", "compare", "derive"].includes(x.phase) && x.parentTaskId === null);
  t.check("running expansion again creates nothing", again.created.length === 0 && again.refused.length === 0, `created ${again.created.length}`);
  t.check("running expansion again reuses every task the pack expands", again.reused.length === packWork.length && same(sorted(again.reused), sorted(packWork.map((x) => x.taskId))), `reused ${again.reused.length} of ${packWork.length}`);
  t.check("the task count is unchanged after a repeated expansion", (await repo.listTasks(wf)).length === countBefore);

  /* Priorities, as the record holds them. */
  const priorityOf = (phase) => Math.min(...byPhase(afterAll, phase).map((x) => x.priority));
  t.check("ingest outranks discovery, discovery outranks analysis, analysis outranks comparison, comparison outranks derivation", priorityOf("ingest") < priorityOf("discover") && priorityOf("discover") < priorityOf("analyze") && priorityOf("analyze") < priorityOf("compare") && priorityOf("compare") < priorityOf("derive"));

  /* To the end, then the depth rule over everything the kernel added. */
  const report = await scheduler.runUntilQuiescent();
  t.check("the workflow runs to completion after the two-phase expansion", report.workflow.state === "completed", report.workflow.state);
  const finalTasks = await repo.listTasks(wf);
  const children = finalTasks.filter((x) => x.parentTaskId !== null);
  t.check("the kernel added children of its own (independent verification of corroborated readings)", children.length > 0 && children.some((x) => x.taskType === KERNEL_TASK_TYPES.verifyClaim));
  t.check("every task without a parent — planned or expanded — has depth 0", finalTasks.filter((x) => x.parentTaskId === null).every((x) => x.depth === 0));
  t.check("every child the kernel created is exactly one deeper than its parent", children.every((x) => { const p = finalTasks.find((y) => y.taskId === x.parentTaskId); return p && x.depth === p.depth + 1 && x.createdByTaskId === p.taskId; }));
  t.check("compositions close the graph at the lowest priority", byPhase(finalTasks, "compose").length > 0 && priorityOf("derive") < Math.min(...byPhase(finalTasks, "compose").map((x) => x.priority)));
  t.check("expansion admitted every task once: no two tasks share an identity", new Set(finalTasks.map((x) => x.inputFingerprint + "|" + x.phase + "|" + x.subjectKey + "|" + (x.independenceGroup ?? ""))).size === finalTasks.length);
}

/* ═══════════════ transcripts: the source declares nothing, the discoverer does */

t.section("transcripts: a manifest with sources and no segments does not stop after discovery");
{
  const truth = syntheticTranscriptSet({ seed: "expansion/transcripts", recordings: 2, scenesPerRecording: 3 });
  const wf = truth.manifest.workflowId;
  const { registry } = transcriptExecutors(truth);
  const { scheduler, repo } = assemble({ manifest: truth.manifest, pack: new SyntheticTranscriptsPack(), executors: registry, clock: manualClock(), policy: ONE_AT_A_TIME });
  t.check("the transcript sources declare no segments at all", truth.manifest.sources.every((s) => s.declaredSegments.length === 0));
  const planned = await scheduler.plan();
  const tasks = await repo.listTasks(wf);
  const ingests = byPhase(tasks, "ingest");
  const discoveries = byPhase(tasks, "discover");

  t.check("planning creates one ingest and one source-level discovery per source", planned.created.length === 4 && ingests.length === 2 && discoveries.length === 2, `created ${planned.created.length}`);
  t.check("the source-level discovery is the pack's discoverer role, on its declared task type", discoveries.every((x) => x.roleKey === "scene_discoverer" && x.taskType === TRANSCRIPT_TASK.discoverScenes));
  t.check("a source-level discovery names its source and no segment, at depth 0", discoveries.every((x) => x.sources.length === 1 && x.sources[0].segmentId === null && x.depth === 0));
  t.check("a source-level discovery waits for its own source's ingest to complete", (await Promise.all(discoveries.map(async (d) => {
    const deps = await repo.getDependencies(d.taskId);
    const ingest = ingests.find((i) => i.sources[0].sourceId === d.sources[0].sourceId);
    return deps.length === 1 && deps[0].kind === "requires_completion" && deps[0].dependsOnTaskId === ingest.taskId;
  }))).every(Boolean));
  t.check("nothing beyond phase A exists at planning time", tasks.length === 4 && (await repo.listSegments(wf)).length === 0);

  /* Tick 1: one ingest. Nothing is declared, so nothing is persisted. */
  const first = await scheduler.tick();
  const ingested = await repo.getTask(first.completed[0]);
  t.check("an ingest of a source that declares nothing persists no segment", first.completed.length === 1 && ingested.phase === "ingest" && (await repo.listSegments(wf)).length === 0);
  t.check("expansion after such an ingest creates nothing — there is nothing yet to expand", (await repo.listTasks(wf)).length === 4);
  const queue = await runnableNow(repo, wf);
  t.check("the queue offers the other ingest before the released discovery", queue.length === 2 && queue[0].phase === "ingest" && queue[1].phase === "discover", queue.map((x) => x.phase).join(", "));

  /* Tick 2: the other ingest. Tick 3: one discovery. */
  await scheduler.tick();
  const third = await scheduler.tick();
  const discovered = await repo.getTask(third.completed[0]);
  const source = truth.manifest.sources.find((s) => s.sourceId === discovered.sources[0].sourceId);
  const other = truth.manifest.sources.find((s) => s.sourceId !== source.sourceId);
  const recording = truth.recordings.find((r) => r.sourceId === source.sourceId);
  t.check("the third tick runs a source-level discovery", discovered.phase === "discover" && discovered.taskType === TRANSCRIPT_TASK.discoverScenes);
  const scenes = await repo.listSegments(wf);
  t.check("the discoverer's scenes are persisted for exactly the recording it read", scenes.length === recording.scenes.length && scenes.every((s) => s.sourceId === source.sourceId && s.segmentKind === "scene"), `${scenes.length} scenes`);
  t.check("a scene discovered at source level has no parent segment", scenes.every((s) => s.parentSegmentId === null));
  t.check("a top-level discovered scene is accepted", scenes.every((s) => s.status === "accepted"));
  t.check("a scene is recorded as found by a model, under the discovery attempt", scenes.every((s) => s.discoveredBy === "model" && s.discoveredByAttemptId === entityId("attempt", discovered.taskId, 1)));
  t.check("a scene's id equals segmentIdFor(workflow, source, no parent, kind, content hash)", same(sorted(scenes.map((s) => s.segmentId)), sorted(recording.scenes.map((s) => segmentIdFor(wf, source.sourceId, null, "scene", s.contentHash)))));

  const afterDiscovery = await repo.listTasks(wf);
  const readers = byPhase(afterDiscovery, "analyze");
  const comparisons = byPhase(afterDiscovery, "compare");
  const derives = byPhase(afterDiscovery, "derive");
  t.check("discoverer output creates two blind readers per scene", readers.length === scenes.length * 2 && scenes.every((s) => same(sorted(readers.filter((x) => x.sources[0].segmentId === s.segmentId).map((x) => x.independenceGroup)), ["reader-a", "reader-b"])));
  t.check("discoverer output creates one comparison per scene", comparisons.length === scenes.length && scenes.every((s) => comparisons.some((c) => c.subjectKey === `recording/${source.ordinal}/scene/${s.ordinal}`)));
  t.check("the discovered recording's derivation exists once its own discovery completed", derives.length === 1 && derives[0].subjectKey === `recording/${source.ordinal}` && derives[0].roleKey === "turn_totaliser");
  t.check("the undiscovered recording has no derivation while its discovery is open", !derives.some((x) => x.subjectKey === `recording/${other.ordinal}`) && afterDiscovery.some((x) => x.taskType === TRANSCRIPT_TASK.discoverScenes && open(x)));
  t.check("everything expanded from discoverer output is depth 0 with no parent", [...readers, ...comparisons, ...derives].every((x) => x.depth === 0 && x.parentTaskId === null));
  const queue2 = await runnableNow(repo, wf);
  const phases2 = queue2.map((x) => x.phase);
  t.check("the queue offers the other recording's discovery before any scene reader", phases2[0] === "discover" && phases2.includes("analyze"), phases2.join(", "));

  /* Tick 4: the other discovery. */
  await scheduler.tick();
  const afterBoth = await repo.listTasks(wf);
  t.check("after both discoveries every recording has its derivation and every scene its readers", byPhase(afterBoth, "derive").length === 2 && byPhase(afterBoth, "analyze").length === 12 && byPhase(afterBoth, "compare").length === 6);
  const countBefore = afterBoth.length;
  const again = await scheduler.expand();
  const packWork = afterBoth.filter((x) => ["analyze", "compare", "derive"].includes(x.phase));
  t.check("a second expansion over the discovered scenes creates nothing", again.created.length === 0 && again.refused.length === 0);
  t.check("a second expansion reuses every analysis, comparison and derivation", again.reused.length === packWork.length && same(sorted(again.reused), sorted(packWork.map((x) => x.taskId))));
  t.check("the task count is unchanged after the repeated expansion", (await repo.listTasks(wf)).length === countBefore);

  const report = await scheduler.runUntilQuiescent();
  t.check("the workflow does not stop after discovery: it runs to completion", report.workflow.state === "completed", report.workflow.state);
  t.check("the downstream graph ran: readers, comparisons, derivations and compositions all completed", report.byPhase.analyze === 12 && report.byPhase.compare === 6 && report.byPhase.derive === 2 && report.byPhase.compose === 2 && report.tasks.completed === (await repo.listTasks(wf)).length, JSON.stringify(report.byPhase));
  const derived = (await repo.listClaims({ workflowId: wf, subjectTypes: ["recording"] }));
  t.check("each recording ends with an accepted derived total naming its inputs", derived.length === 2 && derived.every((c) => c.status === "accepted" && c.inputClaimIds.length === 3));
  const finalTasks = await repo.listTasks(wf);
  t.check("every kernel child in the transcript run is one deeper than its parent", finalTasks.filter((x) => x.parentTaskId !== null).every((x) => { const p = finalTasks.find((y) => y.taskId === x.parentTaskId); return p && x.depth === p.depth + 1; }) && finalTasks.some((x) => x.parentTaskId !== null));
}

/* ══════════════════════════════════ determinism: the same seed, the same ids */

t.section("determinism: the same fixture names the same tasks, attempts and claims");
{
  const run = async (seed) => {
    const truth = syntheticRecordSet({ seed, sources: 2, sheetsPerSource: 1, entriesPerTable: 3 });
    const { registry } = recordExecutors(truth);
    const { scheduler, repo } = assemble({ manifest: truth.manifest, pack: new SyntheticRecordsPack(), executors: registry, clock: manualClock() });
    await scheduler.plan();
    const report = await scheduler.runUntilQuiescent();
    const wf = truth.manifest.workflowId;
    const tasks = await repo.listTasks(wf);
    const attempts = (await Promise.all(tasks.map((x) => repo.listAttempts(x.taskId)))).flat();
    return {
      state: report.workflow.state,
      tasks: sorted(tasks.map((x) => x.taskId)),
      attempts: sorted(attempts.map((a) => a.attemptId)),
      claims: sorted((await repo.listClaims({ workflowId: wf })).map((c) => c.claimId)),
      segments: sorted((await repo.listSegments(wf)).map((s) => s.segmentId)),
      decisions: sorted((await repo.listDecisions(wf)).map((d) => d.decisionId)),
    };
  };
  const a = await run("expansion/determinism");
  const b = await run("expansion/determinism");
  const c = await run("expansion/determinism-other");
  t.check("both runs from one seed complete", a.state === "completed" && b.state === "completed");
  t.check("two runs from one seed produce identical task ids", a.tasks.length > 0 && same(a.tasks, b.tasks), `${a.tasks.length} vs ${b.tasks.length}`);
  t.check("two runs from one seed produce identical attempt ids", a.attempts.length > 0 && same(a.attempts, b.attempts));
  t.check("two runs from one seed produce identical claim ids", a.claims.length > 0 && same(a.claims, b.claims), `${a.claims.length} vs ${b.claims.length}`);
  t.check("two runs from one seed produce identical segment ids", a.segments.length > 0 && same(a.segments, b.segments));
  t.check("two runs from one seed produce identical decision ids", a.decisions.length > 0 && same(a.decisions, b.decisions));
  t.check("a different seed names different tasks", !same(a.tasks, c.tasks) && !a.tasks.some((id) => c.tasks.includes(id)));
  const all = [...a.tasks, ...a.attempts, ...a.claims, ...a.segments, ...a.decisions];
  t.check("every task id is an RFC 4122 version-5 UUID (version nibble 5, variant bits 10)", a.tasks.every(isV5));
  t.check("every attempt id is an RFC 4122 version-5 UUID", a.attempts.every(isV5));
  t.check("every claim id is an RFC 4122 version-5 UUID", a.claims.every(isV5));
  t.check("every segment and decision id is an RFC 4122 version-5 UUID", a.segments.every(isV5) && a.decisions.every(isV5));
  t.check("no id is shared between two entities of one run", new Set(all).size === all.length);
}

/* ═════════════════════════════ restart: a second scheduler over the same rows */

t.section("restart: a second scheduler on the finished record plans nothing new");
{
  const truth = syntheticRecordSet({ seed: "expansion/restart", sources: 2, sheetsPerSource: 1, entriesPerTable: 3 });
  const wf = truth.manifest.workflowId;
  const { registry } = recordExecutors(truth);
  const first = assemble({ manifest: truth.manifest, pack: new SyntheticRecordsPack(), executors: registry, clock: manualClock() });
  await first.scheduler.plan();
  const report = await first.scheduler.runUntilQuiescent();
  t.check("the first scheduler ran the workflow to completion", report.workflow.state === "completed");
  const tasksBefore = sorted((await first.repo.listTasks(wf)).map((x) => `${x.taskId}:${x.state}`));
  const claimsBefore = (await first.repo.listClaims({ workflowId: wf })).length;

  const { registry: registry2 } = recordExecutors(truth);
  const second = assemble({ manifest: truth.manifest, pack: new SyntheticRecordsPack(), executors: registry2, clock: manualClock(), repo: first.repo, owner: "worker-2" });
  const planned = await second.scheduler.plan();
  t.check("the restarted scheduler's plan() creates nothing", planned.created.length === 0 && planned.refusals.length === 0, `created ${planned.created.length}`);
  t.check("the restarted scheduler's plan() finds phase A already in the record", planned.existing.length === truth.manifest.sources.length);
  const expanded = await second.scheduler.expand();
  t.check("the restarted scheduler's expand() creates nothing", expanded.created.length === 0 && expanded.reused.length > 0);
  const tick = await second.scheduler.tick();
  t.check("the restarted scheduler's tick dispatches nothing on a completed workflow", tick.dispatched.length === 0 && tick.released === 0 && tick.workflowState === "completed");
  t.check("the record is untouched by the restart: same tasks in the same states, same claims", same(sorted((await first.repo.listTasks(wf)).map((x) => `${x.taskId}:${x.state}`)), tasksBefore) && (await first.repo.listClaims({ workflowId: wf })).length === claimsBefore);
  t.check("the workflow stays completed", (await first.repo.getWorkflow(wf)).state === "completed");
}

/* ═══════════════════════════ refusal: a source with no identity is not read */

t.section("refusal: a source without a content hash or a version is not planned");
{
  const truth = syntheticRecordSet({ seed: "expansion/unidentified", sources: 1, sheetsPerSource: 1, entriesPerTable: 3 });
  const manifest = { ...truth.manifest, sources: truth.manifest.sources.map((s) => ({ ...s, contentHash: null, hashAlgorithm: null, objectVersionId: null })) };
  const { registry } = recordExecutors(truth);
  const { scheduler, repo } = assemble({ manifest, pack: new SyntheticRecordsPack(), executors: registry, clock: manualClock() });
  await t.refused("planning a manifest whose source has neither a content hash nor an object version is refused", () => scheduler.plan());
  t.check("nothing was planned for the unidentified source", (await repo.listTasks(manifest.workflowId)).length === 0);
  t.check("sourceIdentityOf refuses the same source on its own", (() => { try { sourceIdentityOf(manifest.sources[0]); return false; } catch { return true; } })());

  const versioned = { ...truth.manifest, sources: truth.manifest.sources.map((s) => ({ ...s, contentHash: null, hashAlgorithm: null, objectVersionId: "v-1" })) };
  const { registry: registry2 } = recordExecutors(truth);
  const alt = assemble({ manifest: versioned, pack: new SyntheticRecordsPack(), executors: registry2, clock: manualClock() });
  const planned = await alt.scheduler.plan();
  t.check("a source identified by an immutable version alone is planned", planned.created.length === 1);
}

/* ═════════════════════════════════════════════════════════ the closed door */

t.section("no network");
t.check("nothing in this file reached for the network", tripped() === 0, `${tripped()} attempts`);

t.finish();
