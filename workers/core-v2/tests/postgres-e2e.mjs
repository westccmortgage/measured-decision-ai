/* THE WHOLE CHAIN AGAINST MIGRATION 058, WITH A RESTART.
 *
 * One workflow of the synthetic records pack, driven by the real kernel
 * scheduler against the Postgres adapter on a throwaway cluster: a workflow
 * started, its start command claimed once and acknowledged, the declared
 * sheets persisted at ingest, the regions discovered under the attempt that
 * found them, the pack's readers, comparator, critic, verifier, arbiter and
 * composer run by scripted executors, and every claim, anchor, assessment,
 * disagreement and decision written into the table migration 058 gives it,
 * pointing at the rows it says it points at.
 *
 * Then the scheduler is thrown away in the middle of the run and a new one,
 * with executors that have never seen a packet, is built on the same
 * database. It finishes the workflow without repeating a single piece of
 * work, and the record it leaves — every id, and the number of rows in each
 * of the nineteen tables — is the record an uninterrupted in-memory run of
 * the same fixture seed leaves.
 *
 * No provider, no network call of the engine's, no project and nobody's
 * records: the truth is invented from a seed and the agents are code. The
 * only socket is the unix socket to the throwaway cluster, so this test does
 * not seal the network the way the engine's dry-run tests do.
 */
import { harness } from "./harness.mjs";
import { withThrowawayDatabase } from "./postgres-harness.mjs";
import { PostgresOrchestrationRepository } from "../postgres/repository.ts";
import { InMemoryOrchestrationRepository } from "../kernel/memory-repository.ts";
import { syntheticRecordSet } from "../domains/synthetic-records/fixture.ts";
import { SyntheticRecordsPack, TASK } from "../domains/synthetic-records/pack.ts";
import { MOCK_FAMILIES, mockExecutors } from "../domains/synthetic-records/mocks.ts";
import { assemble, manualClock } from "../domains/simulate.ts";
import { ENGINE_VERSION, KERNEL_TASK_TYPES } from "../kernel/contracts.ts";
import { INDEPENDENCE_GROUPS } from "../kernel/domain.ts";
import { entityId } from "../kernel/ids.ts";
import { DEFAULT_POLICY, budgetOf } from "../kernel/policy.ts";
import { TERMINAL_TASK_STATES } from "../kernel/transitions.ts";

const t = harness("the whole chain against migration 058, with a restart");

const SEED = "postgres-e2e/records";
const HOLD_SEED = "postgres-e2e/held";
const [, READER_B] = INDEPENDENCE_GROUPS;
const READER_FAMILIES = ["reader-family-one", "reader-family-two", "reader-family-three"];
const ARBITER_FAMILY = "arbiter-family-one";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sorted = (xs) => [...xs].sort();
const n = (rows) => Number(rows[0].n);

/* One reader misreads one entry by five. Two blind readings of one table
   then differ, which is the disagreement the rest of the chain settles. */
const wrongOnOne = (packet, base) => {
  if (packet.roleKey === "table_reader" && packet.independenceGroup === READER_B) {
    for (const c of base.claims) {
      if (c.subjectKey === "entry/E-001") c.value = { ...c.value, quantity: c.value.quantity + 5, text: `${c.value.quantity + 5} ${c.unit}` };
    }
  }
  return base;
};

/* The same misreading, and an arbiter that will not settle it. */
const refuseToSettle = (packet, base) => {
  if (packet.roleKey !== "evidence_arbiter" || !base.adjudication) return wrongOnOne(packet, base);
  base.adjudication = {
    ...base.adjudication, outcome: "needs_human", acceptedClaimRef: null, correctedValue: null, correctedUnit: null,
    evidenceAnchorIds: [], followUp: null, rationale: "the reopened source does not settle which reading is right; a person decides",
  };
  return base;
};

const scriptsFor = (script) => Object.fromEntries([...READER_FAMILIES, ARBITER_FAMILY, "critic-family-one", "critic-family-two"].map((f) => [f, script]));

/* ────────────────────────────── the nineteen tables, scoped to one workflow */

const TABLES = [
  ["intelligence_workflows", "select count(*) n from public.intelligence_workflows where id = $1"],
  ["workflow_outbox", "select count(*) n from public.workflow_outbox where workflow_id = $1"],
  ["workflow_sources", "select count(*) n from public.workflow_sources where workflow_id = $1"],
  ["source_segments", "select count(*) n from public.source_segments where workflow_id = $1"],
  ["workflow_tasks", "select count(*) n from public.workflow_tasks where workflow_id = $1"],
  ["task_sources", "select count(*) n from public.task_sources s join public.workflow_tasks t on t.id = s.task_id where t.workflow_id = $1"],
  ["task_dependencies", "select count(*) n from public.task_dependencies d join public.workflow_tasks t on t.id = d.task_id where t.workflow_id = $1"],
  ["task_target_claims", "select count(*) n from public.task_target_claims c join public.workflow_tasks t on t.id = c.task_id where t.workflow_id = $1"],
  ["agent_attempts", "select count(*) n from public.agent_attempts where workflow_id = $1"],
  ["evidence_claims", "select count(*) n from public.evidence_claims where workflow_id = $1"],
  ["claim_inputs", "select count(*) n from public.claim_inputs i join public.evidence_claims c on c.id = i.claim_id where c.workflow_id = $1"],
  ["evidence_anchors", "select count(*) n from public.evidence_anchors where workflow_id = $1"],
  ["claim_assessments", "select count(*) n from public.claim_assessments where workflow_id = $1"],
  ["disagreements", "select count(*) n from public.disagreements where workflow_id = $1"],
  ["disagreement_claims", "select count(*) n from public.disagreement_claims x join public.disagreements d on d.id = x.disagreement_id where d.workflow_id = $1"],
  ["disagreement_follow_ups", "select count(*) n from public.disagreement_follow_ups f join public.disagreements d on d.id = f.disagreement_id where d.workflow_id = $1"],
  ["decisions", "select count(*) n from public.decisions where workflow_id = $1"],
  ["decision_evidence", "select count(*) n from public.decision_evidence e join public.decisions d on d.id = e.decision_id where d.workflow_id = $1"],
  ["decision_actions", "select count(*) n from public.decision_actions a join public.decisions d on d.id = a.decision_id where d.workflow_id = $1"],
];

/* The same nineteen counts, read off the double's own maps. */
function memoryCounts(repo) {
  const s = repo.snapshot();
  const sum = (xs, f) => xs.reduce((total, x) => total + f(x), 0);
  return {
    intelligence_workflows: s.workflows.length,
    workflow_outbox: s.outbox.length,
    workflow_sources: sum(s.sources, ([, list]) => list.length),
    source_segments: s.segments.length,
    workflow_tasks: s.tasks.length,
    task_sources: sum(s.tasks, (x) => x.sources.length),
    task_dependencies: s.dependencies.length,
    task_target_claims: sum(s.tasks, (x) => x.targetClaimIds.length),
    agent_attempts: s.attempts.length,
    evidence_claims: s.claims.length,
    claim_inputs: sum(s.claims, (c) => c.inputClaimIds.length),
    evidence_anchors: s.anchors.length,
    claim_assessments: s.assessments.length,
    disagreements: s.disagreements.length,
    disagreement_claims: sum(s.disagreements, (d) => d.claimIds.length),
    disagreement_follow_ups: sum(s.disagreements, (d) => d.followUps.length),
    decisions: s.decisions.length,
    decision_evidence: sum(s.decisions, (d) => d.evidence.length),
    decision_actions: sum(s.decisions, (d) => d.actions.length),
  };
}

async function databaseCounts(client, workflowId) {
  const out = {};
  for (const [table, sql] of TABLES) out[table] = n((await client.query(sql, [workflowId])).rows);
  return out;
}

/* Every id this workflow owns, so its audit trail can be told from another's
   — audit_events names an entity, not a workflow. */
async function entityIdsOf(repo, workflowId) {
  const ids = new Set([workflowId]);
  for (const task of await repo.listTasks(workflowId)) {
    ids.add(task.taskId);
    for (const a of await repo.listAttempts(task.taskId)) ids.add(a.attemptId);
  }
  for (const s of await repo.listSegments(workflowId)) ids.add(s.segmentId);
  for (const c of await repo.listClaims({ workflowId })) ids.add(c.claimId);
  for (const d of await repo.listDisagreements(workflowId)) ids.add(d.disagreementId);
  for (const d of await repo.listDecisions(workflowId)) ids.add(d.decisionId);
  return [...ids];
}

function tally(items) {
  const out = new Map();
  for (const key of items) out.set(key, (out.get(key) ?? 0) + 1);
  return out;
}

/* The truth, the pack and the scripted executors of one run. */
function world(seed, organizationId, script, workflowId = undefined) {
  const truth = syntheticRecordSet({ seed, sources: 1, sheetsPerSource: 1, entriesPerTable: 3, organizationId, workflowId });
  return { truth, workflowId: truth.manifest.workflowId, mocks: () => mockExecutors(truth, { scripts: scriptsFor(script) }) };
}

function schedulerOn(repo, truth, mocks, owner) {
  return assemble({ manifest: truth.manifest, pack: new SyntheticRecordsPack(), executors: mocks.registry, clock: manualClock(), repo, owner });
}

await withThrowawayDatabase(async ({ client, organizationId }) => {
  const { truth, workflowId: wf, mocks } = world(SEED, organizationId, wrongOnOne);

  /* ═════════════════ the reference: the same seed, uninterrupted, in memory */

  const memory = new InMemoryOrchestrationRepository();
  const memoryMocks = mocks();
  const memoryRun = schedulerOn(memory, truth, memoryMocks, "worker-memory");
  await memoryRun.scheduler.plan();
  const memoryReport = await memoryRun.scheduler.runUntilQuiescent();
  const memoryClaimIds = sorted((await memory.listClaims({ workflowId: wf })).map((c) => c.claimId));
  const memoryDecisionIds = sorted((await memory.listDecisions(wf)).map((d) => d.decisionId));

  t.section("the reference run: the same fixture seed, in memory, uninterrupted");
  t.check("the in-memory run of the seed completes with its one value disagreement resolved by machine",
    memoryReport.workflow.state === "completed" && memoryReport.disagreements.resolved === 1 && !memoryReport.disagreements.needs_human,
    `${memoryReport.workflow.state}; disagreements ${JSON.stringify(memoryReport.disagreements)}`);
  t.check("it leaves claims and decisions to compare the record against", memoryClaimIds.length > 0 && memoryDecisionIds.length > 0);

  /* ════════════════════════════════════════════════════ the door of the record */

  t.section("the door: what core_v2_start_workflow writes, and what the adapter writes");

  const repo = new PostgresOrchestrationRepository(client, { organizationId });

  /* The kernel names its workflows by a derived id and core_v2_start_workflow
     draws its own, so the workflow this test drives is created through the
     adapter's createWorkflow — which writes exactly the rows the door writes,
     in one transaction. The door is called here over the same sources under
     another scope so the two can be compared row for row. */
  const doorSources = truth.manifest.sources.map((s) => ({
    source_kind: s.sourceKind, label: s.label, uri: s.uri, content_hash: s.contentHash,
    hash_algorithm: s.hashAlgorithm, object_version_id: s.objectVersionId, byte_size: s.byteSize, media: s.media,
  }));
  const doorRow = await client.query(
    `select (public.core_v2_start_workflow($1::uuid, $2::text, $3::text, $4::text, $5::jsonb, $6::jsonb, $7::text, $8::jsonb)).id as id`,
    [organizationId, "synthetic-records", "1.0", "synthetic_record_review", JSON.stringify(doorSources),
      JSON.stringify({ door: "the same sources, another scope" }), ENGINE_VERSION, JSON.stringify(budgetOf(DEFAULT_POLICY))]);
  const doorId = doorRow.rows[0].id;
  const doorShape = async (id) => ({
    workflow: n((await client.query(`select count(*) n from public.intelligence_workflows where id = $1 and state = 'created'`, [id])).rows),
    sources: n((await client.query(`select count(*) n from public.workflow_sources where workflow_id = $1`, [id])).rows),
    outbox: n((await client.query(`select count(*) n from public.workflow_outbox where workflow_id = $1 and command = 'start' and state = 'pending'`, [id])).rows),
    audit: n((await client.query(`select count(*) n from public.audit_events where action = 'core_v2.workflow.started' and entity_id = $1`, [id])).rows),
  });
  const byDoor = await doorShape(doorId);
  t.check("core_v2_start_workflow, called on the local cluster, writes the workflow, its source and one pending start command, and audits the start",
    byDoor.workflow === 1 && byDoor.sources === truth.manifest.sources.length && byDoor.outbox === 1 && byDoor.audit === 1, JSON.stringify(byDoor));

  const one = mocks();
  const first = schedulerOn(repo, truth, one, "worker-before-the-restart");
  const beforePlan = await doorShape(wf);
  t.check("nothing of the driven workflow exists before it is planned", beforePlan.workflow === 0 && beforePlan.sources === 0 && beforePlan.outbox === 0);
  await first.scheduler.plan();
  const written = {
    workflow: n((await client.query(`select count(*) n from public.intelligence_workflows where id = $1`, [wf])).rows),
    sources: n((await client.query(`select count(*) n from public.workflow_sources where workflow_id = $1`, [wf])).rows),
    outbox: n((await client.query(`select count(*) n from public.workflow_outbox where workflow_id = $1 and command = 'start'`, [wf])).rows),
    audit: n((await client.query(`select count(*) n from public.audit_events where action = 'core_v2.workflow.started' and entity_id = $1`, [wf])).rows),
  };
  t.check("the adapter's createWorkflow writes the same three rows and the same start audit as the door",
    written.workflow === byDoor.workflow && written.sources === byDoor.sources && written.outbox === byDoor.outbox && written.audit === byDoor.audit, JSON.stringify(written));

  const outbox = (await client.query(`select state, attempt_count, dispatcher from public.workflow_outbox where workflow_id = $1`, [wf])).rows[0];
  t.check("the start command was claimed exactly once, by the planner, and acknowledged",
    outbox.state === "acknowledged" && Number(outbox.attempt_count) === 1 && outbox.dispatcher === "worker-before-the-restart", JSON.stringify(outbox));
  t.check("a second dispatcher cannot claim a command that is no longer pending", (await repo.claimOutbox(wf, "another-dispatcher")) === false);
  const doorClaimed = await repo.claimOutbox(doorId, "worker-door");
  await repo.acknowledgeOutbox(doorId);
  t.check("the adapter claims and acknowledges a start command the door itself wrote",
    doorClaimed === true && n((await client.query(`select count(*) n from public.workflow_outbox where workflow_id = $1 and state = 'acknowledged'`, [doorId])).rows) === 1);

  /* ════════════════════════════════ the run, interrupted in the middle of it */

  t.section("the run: ingest, discovery, the pack's graph, and a scheduler thrown away mid-run");

  let stranded = null;
  let ticks = 0;
  for (; ticks < 8 && stranded === null; ticks++) {
    await first.scheduler.tick();
    await repo.releaseDependents(wf);
    const tasks = await repo.listTasks(wf);
    const done = tasks.filter((x) => TERMINAL_TASK_STATES.includes(x.state));
    const queue = await repo.getRunnableTasks(wf);
    if (ticks >= 2 && done.length > 0 && queue.length > 0 && done.length < tasks.length) stranded = queue[0];
  }
  const beforeRestart = await repo.listTasks(wf);
  const terminalBefore = new Set(beforeRestart.filter((x) => TERMINAL_TASK_STATES.includes(x.state)).map((x) => x.taskId));
  t.check("the run was stopped with work done and work left",
    terminalBefore.size > 0 && terminalBefore.size < beforeRestart.length, `${terminalBefore.size} of ${beforeRestart.length} tasks terminal after ${ticks} ticks`);
  t.check("a queued task was found to strand under a dead worker's lease", stranded !== null);

  /* A worker that died holding a lease it never used: the lease outlives it
     by a millisecond, and the scheduler that comes after must take it back. */
  const leased = await repo.leaseTask(stranded.taskId, "worker-that-died", 1, Date.now());
  t.check("the dead worker held a lease on a task nothing was ever submitted for",
    leased !== null && leased.state === "leased" && leased.leaseOwner === "worker-that-died" && (await repo.listAttempts(stranded.taskId)).length === 0);
  await sleep(40);

  /* Everything the first scheduler knew is dropped here: the object, its
     executors, and the packets they were handed. Only the database remains. */
  const two = mocks();
  const second = schedulerOn(repo, truth, two, "worker-after-the-restart");
  const firstTick = await second.scheduler.tick();
  t.check("the fresh scheduler's first tick reconciles the dead worker's lease and puts the task back in the queue",
    firstTick.reconciled >= 1 && ["queued", "leased", "running", "completed"].includes((await repo.getTask(stranded.taskId)).state),
    `reconciled ${firstTick.reconciled}`);
  const report = await second.scheduler.runUntilQuiescent();

  t.check("the workflow the fresh scheduler inherited runs to completion",
    report.workflow.state === "completed" && Object.keys(report.tasks).join() === "completed",
    `${report.workflow.state}; tasks ${JSON.stringify(report.tasks)}`);

  const duplicates = await client.query(`select task_id from public.agent_attempts where workflow_id = $1 and state = 'succeeded' group by task_id having count(*) > 1`, [wf]);
  t.check("no task has two succeeded attempts — nothing was executed twice", duplicates.rows.length === 0, `${duplicates.rows.length} tasks with more than one`);
  const attempts = n((await client.query(`select count(*) n from public.agent_attempts where workflow_id = $1`, [wf])).rows);
  t.check("there is exactly one attempt per task in the record — not one for the run before the restart and one for the run after",
    attempts === report.tasks.completed, `${attempts} attempts, ${report.tasks.completed} tasks`);

  const freshPackets = [...two.registry.packetsSeen, ...Object.values(two.executors).flatMap((e) => e.received)];
  const repeated = freshPackets.filter((p) => terminalBefore.has(p.taskId));
  t.check("the fresh executors were handed work, and none of it belonged to a task that was already terminal",
    freshPackets.length > 0 && repeated.length === 0, `${freshPackets.length} packets, ${repeated.length} of them for finished tasks`);
  const beforeTasks = new Set(one.registry.packetsSeen.map((p) => p.taskId));
  const afterTasks = new Set(freshPackets.map((p) => p.taskId));
  t.check("no task was handed to both sets of executors: the two halves of the run share not one piece of work",
    beforeTasks.size > 0 && afterTasks.size > 0 && [...beforeTasks].every((id) => !afterTasks.has(id)),
    `${beforeTasks.size} tasks before the restart, ${afterTasks.size} after`);

  /* ═══════════════════════════════════ what the run left in which table */

  t.section("sources, segments and the graph the pack expanded");

  const segments = (await client.query(
    `select s.id, s.segment_kind, s.parent_segment_id, s.status, s.discovered_by, s.discovered_by_attempt_id, a.task_id, t.task_type
       from public.source_segments s
       join public.agent_attempts a on a.id = s.discovered_by_attempt_id
       join public.workflow_tasks t on t.id = a.task_id
      where s.workflow_id = $1 order by s.segment_kind`, [wf])).rows;
  const sheets = segments.filter((s) => s.segment_kind === "sheet");
  const regions = segments.filter((s) => s.segment_kind === "table" || s.segment_kind === "note");
  t.check("every persisted segment names the attempt that found it", segments.length === (await repo.listSegments(wf)).length && segments.length === 3, `${segments.length} segments`);
  t.check("the sheet the source declares is persisted at ingest, deterministically, at the top of its source",
    sheets.length === 1 && sheets[0].parent_segment_id === null && sheets[0].discovered_by === "deterministic"
    && sheets[0].task_type === KERNEL_TASK_TYPES.ingest && sheets[0].status === "accepted",
    JSON.stringify(sheets[0]));
  t.check("the ingest attempt that persisted it is the one the kernel's derived id names",
    sheets[0].discovered_by_attempt_id === entityId("attempt", sheets[0].task_id, 1));
  t.check("the regions are discovered under the sheet, by the discovery attempt, not by code",
    regions.length === 2 && regions.every((r) => r.parent_segment_id === sheets[0].id && r.discovered_by === "model" && r.task_type === TASK.discoverRegions),
    regions.map((r) => `${r.segment_kind}:${r.discovered_by}:${r.task_type}`).join(" "));

  const taskTypes = tally((await client.query(`select task_type from public.workflow_tasks where workflow_id = $1`, [wf])).rows.map((r) => r.task_type));
  t.check("the pack expanded the graph: two blind readings of each region, a comparison of each, and a total per category",
    taskTypes.get(TASK.readTable) === 2 && taskTypes.get(TASK.readNote) === 2
    && taskTypes.get(KERNEL_TASK_TYPES.compare) === 2 && taskTypes.get(TASK.totalByCategory) === truth.categories.length,
    [...taskTypes].map(([k, v]) => `${k}×${v}`).join(" "));
  t.check("the kernel's own phases ran too: an ingest, a discovery, a verification, an adjudication and a composition",
    taskTypes.get(KERNEL_TASK_TYPES.ingest) === 1 && taskTypes.get(TASK.discoverRegions) === 1
    && taskTypes.get(KERNEL_TASK_TYPES.verifyDisagreement) >= 1 && taskTypes.get(KERNEL_TASK_TYPES.adjudicate) >= 1
    && taskTypes.get(KERNEL_TASK_TYPES.compose) >= 1);

  const families = (await client.query(`select distinct executor_family, executor_kind from public.agent_attempts where workflow_id = $1`, [wf])).rows;
  t.check("every attempt names a scripted executor family or the kernel's own code, and nothing else",
    families.length > 1 && families.every((f) => MOCK_FAMILIES.includes(f.executor_family) || (f.executor_family === "deterministic" && f.executor_kind === "deterministic")),
    families.map((f) => `${f.executor_family}/${f.executor_kind}`).join(" "));
  t.check("every attempt of a blind reading names an independence domain, and the two readings of one table ran in two",
    n((await client.query(
      `select count(distinct a.independence_domain) n from public.agent_attempts a join public.workflow_tasks t on t.id = a.task_id
        where t.workflow_id = $1 and t.task_type = $2`, [wf, TASK.readTable])).rows) === 2);

  t.section("claims, anchors, assessments, disagreements and decisions, and what they point at");

  const wrong = async (sql) => n((await client.query(sql, [wf])).rows);
  t.check("every claim's attempt is an attempt of the claim's own task, in the claim's own workflow",
    (await wrong(`select count(*) n from public.evidence_claims c
        join public.agent_attempts a on a.id = c.attempt_id join public.workflow_tasks t on t.id = c.task_id
       where c.workflow_id = $1 and (a.task_id <> c.task_id or a.workflow_id <> c.workflow_id or t.workflow_id <> c.workflow_id)`)) === 0);
  t.check("every anchor belongs to a claim or an assessment of the same workflow, and names a segment of its own source",
    (await wrong(`select count(*) n from public.evidence_anchors an
        left join public.evidence_claims c on c.id = an.claim_id
        left join public.claim_assessments s on s.id = an.assessment_id
        left join public.source_segments g on g.id = an.segment_id
       where an.workflow_id = $1
         and ((an.claim_id is null and an.assessment_id is null)
           or (an.claim_id is not null and c.workflow_id is distinct from an.workflow_id)
           or (an.assessment_id is not null and s.workflow_id is distinct from an.workflow_id)
           or (an.segment_id is not null and (g.workflow_id is distinct from an.workflow_id or g.source_id is distinct from an.source_id)))`)) === 0);
  t.check("every assessment names a claim, an attempt and a task of this workflow, and the attempt is the assessing task's own",
    (await wrong(`select count(*) n from public.claim_assessments s
        join public.evidence_claims c on c.id = s.claim_id join public.agent_attempts a on a.id = s.attempt_id
        join public.workflow_tasks t on t.id = s.task_id
       where s.workflow_id = $1 and (c.workflow_id <> s.workflow_id or a.workflow_id <> s.workflow_id or t.workflow_id <> s.workflow_id or a.task_id <> s.task_id)`)) === 0);
  t.check("every disagreement compares claims of its own workflow",
    (await wrong(`select count(*) n from public.disagreement_claims x
        join public.disagreements d on d.id = x.disagreement_id join public.evidence_claims c on c.id = x.claim_id
       where d.workflow_id = $1 and c.workflow_id <> d.workflow_id`)) === 0);
  t.check("every decision cites claims and anchors of its own workflow, and cites a claim through that claim's own anchor",
    (await wrong(`select count(*) n from public.decision_evidence e join public.decisions d on d.id = e.decision_id
        left join public.evidence_claims c on c.id = e.claim_id left join public.evidence_anchors an on an.id = e.anchor_id
       where d.workflow_id = $1
         and ((e.claim_id is not null and c.workflow_id is distinct from d.workflow_id)
           or (e.anchor_id is not null and an.workflow_id is distinct from d.workflow_id)
           or (e.claim_id is not null and e.anchor_id is not null and an.claim_id is distinct from e.claim_id))`)) === 0);
  t.check("an accepted claim has something to open: every accepted claim carries at least one anchor",
    (await wrong(`select count(*) n from public.evidence_claims c
       where c.workflow_id = $1 and c.status = 'accepted' and not exists (select 1 from public.evidence_anchors a where a.claim_id = c.id)`)) === 0);

  t.section("a value disagreement, verified, adjudicated and resolved");

  const dispute = (await client.query(
    `select d.id, d.kind, d.severity, d.state, d.critic_rounds, d.arbiter_rounds, d.resolution_decision_id,
            dec.status, dec.decision_type, dec.authority, dec.disagreement_id, dec.decided_by_attempt_id
       from public.disagreements d left join public.decisions dec on dec.id = d.resolution_decision_id
      where d.workflow_id = $1`, [wf])).rows;
  t.check("the run left exactly one disagreement, and it is a disagreement about a value",
    dispute.length === 1 && dispute[0].kind === "value", dispute.map((d) => `${d.kind}:${d.state}`).join(" "));
  t.check("it is resolved, and it names the machine decision that resolved it",
    dispute[0].state === "resolved" && dispute[0].resolution_decision_id !== null && dispute[0].status === "machine_decided"
    && dispute[0].decision_type === "accept_claim" && dispute[0].authority === "adjudicator" && dispute[0].disagreement_id === dispute[0].id,
    JSON.stringify(dispute[0]));
  t.check("the deciding attempt is on the record", dispute[0].decided_by_attempt_id !== null
    && n((await client.query(`select count(*) n from public.agent_attempts where id = $1 and workflow_id = $2`, [dispute[0].decided_by_attempt_id, wf])).rows) === 1);

  const disputed = (await client.query(
    `select c.id, c.independence_group, c.status from public.evidence_claims c
       join public.disagreement_claims x on x.claim_id = c.id where x.disagreement_id = $1 order by c.independence_group`, [dispute[0].id])).rows;
  t.check("the two readings that disagree came from the two blind readers, and one of them was accepted while the other was not",
    disputed.length === 2 && new Set(disputed.map((c) => c.independence_group)).size === 2 && disputed.every((c) => c.independence_group !== null)
    && disputed.filter((c) => c.status === "accepted").length === 1 && disputed.filter((c) => c.status === "rejected").length === 1,
    disputed.map((c) => `${c.independence_group}:${c.status}`).join(" "));
  t.check("a verifier reopened the source before the arbiter decided: its verdicts are in claim_assessments under a verification task",
    n((await client.query(
      `select count(*) n from public.claim_assessments s join public.workflow_tasks t on t.id = s.task_id
        where s.workflow_id = $1 and t.task_type = $2`, [wf, KERNEL_TASK_TYPES.verifyDisagreement])).rows) >= 2
    && Number(dispute[0].critic_rounds) + Number(dispute[0].arbiter_rounds) >= 1,
    `critic ${dispute[0].critic_rounds}, arbiter ${dispute[0].arbiter_rounds}`);

  /* ═════════════════════════ the record against the uninterrupted reference */

  t.section("the record the restart left is the record an uninterrupted run leaves");

  const recordClaimIds = sorted((await repo.listClaims({ workflowId: wf })).map((c) => c.claimId));
  const recordDecisionIds = sorted((await repo.listDecisions(wf)).map((d) => d.decisionId));
  t.check("every claim of the interrupted run has the id the uninterrupted in-memory run gave it",
    recordClaimIds.length === memoryClaimIds.length && recordClaimIds.every((id, i) => id === memoryClaimIds[i]),
    `${recordClaimIds.length} claims in the record, ${memoryClaimIds.length} in memory`);
  t.check("every decision of the interrupted run has the id the uninterrupted in-memory run gave it",
    recordDecisionIds.length === memoryDecisionIds.length && recordDecisionIds.every((id, i) => id === memoryDecisionIds[i]),
    `${recordDecisionIds.length} decisions in the record, ${memoryDecisionIds.length} in memory`);

  const expected = memoryCounts(memory);
  const actual = await databaseCounts(client, wf);
  const differing = Object.keys(expected).filter((table) => expected[table] !== actual[table]);
  t.check("each of the nineteen tables holds exactly what the in-memory run produced",
    differing.length === 0, differing.length ? differing.map((k) => `${k}: ${actual[k]} on the record, ${expected[k]} in memory`).join("; ") : Object.entries(actual).map(([k, v]) => `${k}=${v}`).join(" "));

  const unconsumed = await client.query(`select workflow_id, state from public.workflow_outbox where state <> 'acknowledged'`);
  t.check("no start command anywhere in the database is left unconsumed", unconsumed.rows.length === 0, JSON.stringify(unconsumed.rows));

  const ids = await entityIdsOf(repo, wf);
  const dbAudit = (await client.query(
    `select action, entity_id from public.audit_events where action like 'core_v2.%' and entity_id = any($1::text[])`,
    [`{${ids.map((id) => `"${id}"`).join(",")}}`])).rows.map((r) => `${r.action}|${r.entity_id}`);
  const memoryAudit = (await memory.listAudit()).map((a) => `${a.action}|${a.entityId}`);
  const onRecord = tally(dbAudit);
  const inMemory = tally(memoryAudit);
  const missing = [...inMemory].filter(([key, count]) => (onRecord.get(key) ?? 0) < count);
  t.check("every audit the in-memory run wrote is on the record too", missing.length === 0, missing.map(([k]) => k).join("; "));
  const extra = sorted([...onRecord].filter(([key, count]) => count > (inMemory.get(key) ?? 0)).map(([key]) => key.split("|")[0]));
  t.check("the record adds exactly the two the double cannot write: the start the door audits, and the lease the fresh scheduler reclaimed",
    extra.length === 2 && extra[0] === "core_v2.task.lease_reclaimed" && extra[1] === "core_v2.workflow.started", extra.join(", "));

  /* ═════════════════════════════════ the same chain, held for a person */

  t.section("a second run, scripted so nothing settles it, ends held for a person");

  const held = world(HOLD_SEED, organizationId, refuseToSettle);
  const heldMocks = held.mocks();
  const heldRun = schedulerOn(repo, held.truth, heldMocks, "worker-held");
  await heldRun.scheduler.plan();
  const heldReport = await heldRun.scheduler.runUntilQuiescent();

  const heldDispute = (await client.query(
    `select d.id, d.kind, d.state, d.needs_human_reason from public.disagreements d where d.workflow_id = $1`, [held.workflowId])).rows;
  t.check("the second run's value disagreement is held for a person, with the reason on the row",
    heldDispute.length === 1 && heldDispute[0].kind === "value" && heldDispute[0].state === "needs_human" && (heldDispute[0].needs_human_reason ?? "").length > 0,
    JSON.stringify(heldDispute));
  const holdDecision = (await client.query(
    `select id, decision_type, status, authority, disagreement_id from public.decisions
      where workflow_id = $1 and decision_type = 'hold' and disagreement_id is not null`, [held.workflowId])).rows;
  t.check("a hold decision stands against it, waiting for a person, and nobody's machine decided it",
    holdDecision.length === 1 && holdDecision[0].status === "needs_human" && holdDecision[0].disagreement_id === heldDispute[0].id,
    JSON.stringify(holdDecision));
  t.check("the claims under the held dispute are unresolved, neither accepted nor rejected",
    n((await client.query(`select count(*) n from public.evidence_claims c join public.disagreement_claims x on x.claim_id = c.id
       where x.disagreement_id = $1 and c.status <> 'unresolved'`, [heldDispute[0].id])).rows) === 0);
  t.check("a workflow with a subject a person must settle does not end as if it were finished",
    heldReport.workflow.state !== "completed" && ["partial", "needs_attention", "ready_for_decision", "deciding", "failed"].includes(heldReport.workflow.state),
    heldReport.workflow.state);
  t.check("the two runs live side by side in one database, each holding only its own rows",
    n((await client.query(`select count(*) n from public.evidence_claims where workflow_id = $1`, [wf])).rows) === expected.evidence_claims
    && n((await client.query(`select count(*) n from public.disagreements where workflow_id = $1`, [held.workflowId])).rows) === 1);
  const stillUnconsumed = await client.query(`select workflow_id from public.workflow_outbox where state <> 'acknowledged'`);
  t.check("neither run left a start command unconsumed", stillUnconsumed.rows.length === 0, JSON.stringify(stillUnconsumed.rows));
});

t.finish();
