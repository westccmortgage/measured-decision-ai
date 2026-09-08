/* THE STATES THE ENGINE WALKS, AND THE ONES THE DATABASE ALLOWS.
 *
 * docs/core-v2.md §7: "The engine uses exactly the database's machine and
 * nothing else" — created → queued → planning → running →
 * ready_for_decision → deciding → completed | partial, running ↔
 * needs_attention, any active state → cancelled | failed. §8: every
 * persisted entity has an RFC 4122 version-5 UUID derived from its identity.
 *
 * Part A reads migration 058 itself and puts its transition table beside
 * MACHINES from kernel/transitions.ts, both ways, machine by machine: a move
 * the engine would make and the database would refuse is a run that dies at
 * the first write, and a move the database allows and the engine never makes
 * is a door nobody guards.
 *
 * Part B holds the workflow machine to the shape of the doc: no jumping the
 * queue, no jumping to the end, and no way out of an ending.
 *
 * Part C runs the synthetic records pack end to end over a repository that
 * writes down every workflow move it is asked to make, and reads the walk
 * back: a clean run, a run with a subject held, planning twice, a manifest
 * that cannot be read, and a cancellation.
 *
 * Everything runs in memory. The network is closed before the engine is
 * used, the clock is manual, and no test sleeps.
 */
import { readFileSync } from "node:fs";
import { harness, closeNetwork } from "./harness.mjs";
import { syntheticRecordSet } from "../domains/synthetic-records/fixture.ts";
import { SyntheticRecordsPack } from "../domains/synthetic-records/pack.ts";
import { mockExecutors } from "../domains/synthetic-records/mocks.ts";
import { assemble, manualClock } from "../domains/simulate.ts";
import { ACTIVE_WORKFLOW_STATES } from "../kernel/contracts.ts";
import { entityId } from "../kernel/ids.ts";
import { InMemoryOrchestrationRepository } from "../kernel/memory-repository.ts";
import {
  MACHINES, SUBMITTED_ATTEMPT_STATES, TERMINAL_ATTEMPT_STATES, TERMINAL_TASK_STATES, TERMINAL_WORKFLOW_STATES,
  attemptMoveAllowed, taskMoveAllowed, workflowMoveAllowed,
} from "../kernel/transitions.ts";

const tripped = closeNetwork();
const t = harness("the states the engine walks, and the ones the database allows");

/* ───────────────────────────────────────────────────────────── helpers */

const V5 = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const isV5 = (id) => typeof id === "string" && V5.test(id);
const sorted = (xs) => [...xs].sort();
const same = (a, b) => a.length === b.length && sorted(a).every((x, i) => x === sorted(b)[i]);
const MACHINE_NAMES = ["workflow", "task", "attempt", "claim", "disagreement", "segment", "decision"];
const HAPPY = ["created", "queued", "planning", "running", "ready_for_decision", "deciding", "completed"];

/* ══════════════════════════════════════════════════ A · the two tables */

const MIGRATION = new URL("../../../supabase/migrations/058_core_v2_schema.sql", import.meta.url);
const sql = readFileSync(MIGRATION, "utf8");

/* The database's own list, read out of the migration: every (machine, from,
   to) triple inside core_v2_transition_allowed's VALUES table. */
const fnAt = sql.indexOf("function public.core_v2_transition_allowed(");
const tableEnd = sql.indexOf("as t(machine, from_state, to_state)", fnAt);
const tableText = fnAt >= 0 && tableEnd > fnAt ? sql.slice(fnAt, tableEnd) : "";
const dbRows = [...tableText.matchAll(/\(\s*'([a-z_]+)'\s*,\s*'([a-z_]+)'\s*,\s*'([a-z_]+)'\s*\)/g)]
  .map((m) => ({ machine: m[1], from: m[2], to: m[3] }));
const dbPairs = new Set(dbRows.map((r) => `${r.machine}|${r.from}|${r.to}`));
const dbMachines = [...new Set(dbRows.map((r) => r.machine))];
const enginePairs = (machine) => Object.entries(MACHINES[machine]).flatMap(([from, tos]) => tos.map((to) => `${machine}|${from}|${to}`));
const dbPairsOf = (machine) => dbRows.filter((r) => r.machine === machine).map((r) => `${machine}|${r.from}|${r.to}`);
const readable = (pairs) => pairs.map((p) => p.split("|").slice(1).join(" > ")).join(", ") || "none";

/* One table's block of the migration, so a column's check list is read from
   the table it belongs to and not from the next one down the file. */
function tableBlock(table) {
  const i = sql.indexOf(`create table if not exists public.${table} (`);
  if (i < 0) return "";
  const j = sql.indexOf("create table if not exists public.", i + 40);
  return sql.slice(i, j < 0 ? sql.length : j);
}
function stateUniverse(table) {
  const m = /(?:state|status) text not null default '[a-z_]+' check \((?:state|status) in \(([^)]*)\)\)/.exec(tableBlock(table));
  return m ? [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]) : [];
}
const MACHINE_TABLE = {
  workflow: "intelligence_workflows", task: "workflow_tasks", attempt: "agent_attempts", claim: "evidence_claims",
  disagreement: "disagreements", segment: "source_segments", decision: "decisions",
};
function sqlStateList(marker) {
  const i = sql.indexOf(marker);
  if (i < 0) return [];
  const m = /in \(([^)]*)\)/.exec(sql.slice(i, i + 600));
  return m ? [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]) : [];
}

t.section("A · migration 058's transition table, read from the file");

t.check("the migration declares core_v2_transition_allowed and its table of legal moves parses",
  fnAt >= 0 && tableEnd > fnAt && dbRows.length > 50, `${dbRows.length} rows read from the migration`);

t.check("the database's table names exactly the seven machines the engine declares",
  same(dbMachines, MACHINE_NAMES) && same(Object.keys(MACHINES), MACHINE_NAMES),
  `database: ${sorted(dbMachines).join(", ")} | engine: ${sorted(Object.keys(MACHINES)).join(", ")}`);

t.check("no move is written twice in the database's table — one list, one meaning per move",
  dbPairs.size === dbRows.length, `${dbRows.length} rows, ${dbPairs.size} distinct`);

for (const machine of MACHINE_NAMES) {
  const engine = enginePairs(machine);
  const database = dbPairsOf(machine);
  const engineOnly = engine.filter((p) => !dbPairs.has(p));
  const databaseOnly = database.filter((p) => !engine.includes(p));
  t.check(`every ${machine} move the engine allows, the database allows`,
    engine.length > 0 && engineOnly.length === 0, `${engine.length} engine moves; the database would refuse: ${readable(engineOnly)}`);
  t.check(`every ${machine} move the database allows, the engine allows`,
    database.length > 0 && databaseOnly.length === 0, `${database.length} database moves; the engine never makes: ${readable(databaseOnly)}`);
  const universe = stateUniverse(MACHINE_TABLE[machine]);
  t.check(`the ${machine} column's allowed states are exactly the states the engine's machine names`,
    universe.length > 0 && same(universe, Object.keys(MACHINES[machine])),
    `column: ${sorted(universe).join(",")} | engine: ${sorted(Object.keys(MACHINES[machine])).join(",")}`);
}

t.check("every state named in the database's table is a state its own column allows — the table cannot move a row somewhere the column refuses",
  dbRows.every((r) => stateUniverse(MACHINE_TABLE[r.machine]).includes(r.from) && stateUniverse(MACHINE_TABLE[r.machine]).includes(r.to)),
  dbRows.filter((r) => !stateUniverse(MACHINE_TABLE[r.machine]).includes(r.to)).map((r) => `${r.machine} ${r.to}`).join(", ") || "all inside");

t.check("core_v2_workflow_active names exactly the workflow states the engine calls active",
  same(sqlStateList("function public.core_v2_workflow_active"), ACTIVE_WORKFLOW_STATES),
  `database: ${sorted(sqlStateList("function public.core_v2_workflow_active")).join(",")}`);

t.check("core_v2_attempt_submitted names exactly the attempt states after which a request may have reached an executor",
  same(sqlStateList("function public.core_v2_attempt_submitted"), SUBMITTED_ATTEMPT_STATES),
  `database: ${sorted(sqlStateList("function public.core_v2_attempt_submitted")).join(",")}`);

t.check("no workflow state the database calls active is one the engine treats as an ending",
  ACTIVE_WORKFLOW_STATES.every((s) => !TERMINAL_WORKFLOW_STATES.includes(s))
  && ACTIVE_WORKFLOW_STATES.length + TERMINAL_WORKFLOW_STATES.length === Object.keys(MACHINES.workflow).length);

/* ═══════════════════════════════════ B · the workflow machine's shape */

t.section("B · the workflow machine: the queue is not skipped and an ending has no way out");

t.check("a created workflow cannot start running — a dispatcher claims it first",
  workflowMoveAllowed("created", "running") === false);
t.check("a running workflow cannot be called completed — the decision phase is not optional",
  workflowMoveAllowed("running", "completed") === false);
t.check("the happy path is allowed one step at a time: created > queued > planning > running > ready_for_decision > deciding > completed",
  HAPPY.slice(0, -1).every((from, i) => workflowMoveAllowed(from, HAPPY[i + 1])),
  HAPPY.slice(0, -1).map((from, i) => `${from}>${HAPPY[i + 1]}:${workflowMoveAllowed(from, HAPPY[i + 1])}`).join(" "));

const shortcuts = [];
for (let i = 0; i < HAPPY.length; i++) for (let j = i + 2; j < HAPPY.length; j++) if (workflowMoveAllowed(HAPPY[i], HAPPY[j])) shortcuts.push(`${HAPPY[i]}>${HAPPY[j]}`);
t.check("no step of the happy path may be skipped — every longer jump along it is refused", shortcuts.length === 0, shortcuts.join(", ") || "no shortcut exists");

t.check("attention is a detour and not an exit: running goes to needs_attention and needs_attention comes back to running",
  workflowMoveAllowed("running", "needs_attention") && workflowMoveAllowed("needs_attention", "running"));
t.check("a workflow already at the decision gate may still be sent back for attention",
  workflowMoveAllowed("ready_for_decision", "needs_attention"));
t.check("only the deciding state may end a workflow completed or partial",
  Object.entries(MACHINES.workflow).every(([from, tos]) => from === "deciding" || (!tos.includes("completed") && !tos.includes("partial"))));

t.check("every terminal workflow state has no outgoing move at all",
  TERMINAL_WORKFLOW_STATES.every((s) => MACHINES.workflow[s].length === 0
    && Object.keys(MACHINES.workflow).every((to) => workflowMoveAllowed(s, to) === false)),
  TERMINAL_WORKFLOW_STATES.map((s) => `${s}:${MACHINES.workflow[s].length}`).join(" "));
t.check("and the states with no outgoing move are exactly the four the engine calls terminal",
  same(Object.keys(MACHINES.workflow).filter((s) => MACHINES.workflow[s].length === 0), TERMINAL_WORKFLOW_STATES));

t.check("a task's terminal states are exactly the task states with no outgoing move",
  same(Object.keys(MACHINES.task).filter((s) => MACHINES.task[s].length === 0), TERMINAL_TASK_STATES)
  && TERMINAL_TASK_STATES.every((s) => Object.keys(MACHINES.task).every((to) => taskMoveAllowed(s, to) === false)));
t.check("an attempt's terminal states are exactly the attempt states with no outgoing move",
  same(Object.keys(MACHINES.attempt).filter((s) => MACHINES.attempt[s].length === 0), TERMINAL_ATTEMPT_STATES)
  && TERMINAL_ATTEMPT_STATES.every((s) => Object.keys(MACHINES.attempt).every((to) => attemptMoveAllowed(s, to) === false)));
t.check("an attempt that was never sent cannot become one that was — prepared is the only way to submitted",
  Object.entries(MACHINES.attempt).every(([from, tos]) => from === "prepared" || !tos.includes("submitted")));

/* ═════════════════════════════════════════ C · the walk, end to end */

/* A repository that writes down every workflow move, outbox claim and
   acknowledgement it is asked for, in the order it was asked. It changes
   nothing: every call goes through to the in-memory record. */
class RecordingRepository extends InMemoryOrchestrationRepository {
  moves = [];
  events = [];
  outboxClaims = [];
  async transitionWorkflow(workflowId, from, to, patch) {
    const next = await super.transitionWorkflow(workflowId, from, to, patch);
    this.moves.push({ from, to });
    this.events.push(`move:${from}>${to}`);
    return next;
  }
  async claimOutbox(workflowId, dispatcher) {
    const claimed = await super.claimOutbox(workflowId, dispatcher);
    this.outboxClaims.push(claimed);
    this.events.push(`claim:${claimed}`);
    return claimed;
  }
  async acknowledgeOutbox(workflowId) {
    await super.acknowledgeOutbox(workflowId);
    this.events.push("acknowledge");
  }
}

const SEED = "workflow-states/records";
function world(mockOptions = {}, extra = {}) {
  const truth = syntheticRecordSet({ seed: SEED, sources: 1, sheetsPerSource: 2, entriesPerTable: 3 });
  const { registry, executors } = mockExecutors(truth, mockOptions);
  const repo = new RecordingRepository();
  const parts = assemble({ manifest: truth.manifest, pack: new SyntheticRecordsPack(), executors: registry, clock: manualClock(), repo, ...extra });
  return { truth, wf: truth.manifest.workflowId, registry, executors, ...parts };
}

const walkOf = (repo) => (repo.moves.length ? [repo.moves[0].from, ...repo.moves.map((m) => m.to)] : []);
const chained = (repo) => repo.moves.every((m, i) => i === 0 || repo.moves[i - 1].to === m.from);
const dbWouldAllow = (repo) => repo.moves.every((m) => dbPairs.has(`workflow|${m.from}|${m.to}`));
const engineAllows = (repo) => repo.moves.every((m) => workflowMoveAllowed(m.from, m.to));

/* Every id the record holds for one workflow, by the kind of thing it names. */
async function persisted(repo, wf) {
  const tasks = await repo.listTasks(wf);
  const attempts = (await Promise.all(tasks.map((x) => repo.listAttempts(x.taskId)))).flat();
  const claims = await repo.listClaims({ workflowId: wf });
  const assessments = await repo.listAssessments(claims.map((c) => c.claimId));
  const anchors = [
    ...await repo.listAnchors(claims.map((c) => c.claimId)),
    ...await repo.listAssessmentAnchors(assessments.map((a) => a.assessmentId)),
  ];
  return {
    tasks, attempts, claims, assessments, anchors,
    segments: await repo.listSegments(wf),
    disagreements: await repo.listDisagreements(wf),
    decisions: await repo.listDecisions(wf),
    workflow: await repo.getWorkflow(wf),
  };
}

/* ─────────────────────────────────────────────── C1 · a clean run */

t.section("C1 · a clean run walks the seven states of the design, once each");

const clean = world();
await clean.scheduler.plan();
const cleanReport = await clean.scheduler.runUntilQuiescent();
const cleanWalk = walkOf(clean.repo);
const cleanRecords = await persisted(clean.repo, clean.wf);

t.check("the observed sequence is exactly created > queued > planning > running > ready_for_decision > deciding > completed",
  cleanWalk.join(" > ") === HAPPY.join(" > "), cleanWalk.join(" > ") || "no move recorded");
t.check("each move begins where the last one ended — the record never jumps",
  clean.repo.moves.length === 6 && chained(clean.repo), `${clean.repo.moves.length} moves`);
t.check("every move the clean run made is one migration 058's table allows", dbWouldAllow(clean.repo));
t.check("and one the engine's own machine allows", engineAllows(clean.repo));
t.check("a clean run never asks for attention", !cleanWalk.includes("needs_attention"));
t.check("no workflow state is entered twice in a clean run", new Set(cleanWalk).size === cleanWalk.length);
t.check("the run report and the record agree that the workflow is completed",
  cleanReport.workflow.state === "completed" && cleanRecords.workflow.state === "completed", cleanReport.workflow.state);
t.check("a completed run leaves nothing held for a person — it wrote decisions, and none of them waits for one",
  cleanRecords.decisions.length > 0 && cleanRecords.decisions.every((d) => d.status !== "needs_human")
  && !cleanRecords.disagreements.some((d) => d.state === "needs_human"),
  `${cleanRecords.decisions.length} decisions, ${cleanRecords.disagreements.length} disagreements`);

await t.refused("the record refuses a move the table forbids: a completed workflow cannot be set running again",
  async () => { await clean.repo.transitionWorkflow(clean.wf, "completed", "running"); });
await t.refused("and refuses a legal move made from a state the workflow is no longer in",
  async () => { await clean.repo.transitionWorkflow(clean.wf, "running", "ready_for_decision"); });

/* ────────────────────────────────────────── C2 · the start command */

t.section("C2 · the start command is claimed once and acknowledged after the work is admitted");

t.check("planning claimed the start command exactly once, and the claim succeeded",
  clean.repo.outboxClaims.length === 1 && clean.repo.outboxClaims[0] === true, JSON.stringify(clean.repo.outboxClaims));
t.check("claiming the start command is what moved the workflow out of created",
  clean.repo.moves[0].from === "created" && clean.repo.moves[0].to === "queued");
t.check("a second dispatcher asking for the same start command is refused",
  (await clean.repo.claimOutbox(clean.wf, "another-worker")) === false);
t.check("the start command is acknowledged, and only after planning admitted the work and the workflow was running",
  clean.repo.events.indexOf("acknowledge") > clean.repo.events.indexOf("move:planning>running")
  && clean.repo.events.indexOf("acknowledge") > -1, clean.repo.events.slice(0, 5).join(" | "));
t.check("the start command's record ends acknowledged, not still dispatching",
  clean.repo.outbox.get(clean.wf).state === "acknowledged", clean.repo.outbox.get(clean.wf).state);

/* ───────────────────────────────────────────── C3 · planning twice */

t.section("C3 · planning twice moves the workflow once");

{
  const w = world();
  await w.scheduler.plan();
  const firstWalk = walkOf(w.repo);
  const firstTasks = (await w.repo.listTasks(w.wf)).length;
  const claimsAfterFirst = w.repo.outboxClaims.length;
  const second = await w.scheduler.plan();
  t.check("the first planning walks created > queued > planning > running",
    firstWalk.join(" > ") === "created > queued > planning > running", firstWalk.join(" > "));
  t.check("the second planning records no further workflow move",
    walkOf(w.repo).join(" > ") === firstWalk.join(" > "), walkOf(w.repo).join(" > "));
  t.check("the second planning admits no second copy of the work",
    second.created.length === 0 && second.existing.length === firstTasks && (await w.repo.listTasks(w.wf)).length === firstTasks,
    `created ${second.created.length}, existing ${second.existing.length}, in record ${(await w.repo.listTasks(w.wf)).length}`);
  t.check("the second planning does not ask for the start command again",
    w.repo.outboxClaims.length === claimsAfterFirst && claimsAfterFirst === 1);
  t.check("the workflow is running after both plannings", (await w.repo.getWorkflow(w.wf)).state === "running");
}

/* ─────────────────────────────────────── C4 · a subject held for a person */

t.section("C4 · a run with a subject held passes through needs_attention and ends partial");

const held = world({ families: ["reader-family-one", "critic-family-one", "arbiter-family-one"] });
await held.scheduler.plan();
const heldReport = await held.scheduler.runUntilQuiescent();
const heldWalk = walkOf(held.repo);
const heldRecords = await persisted(held.repo, held.wf);

t.check("the held run begins the same way: created > queued > planning > running",
  heldWalk.slice(0, 4).join(" > ") === "created > queued > planning > running", heldWalk.join(" > "));
t.check("the held run passes through needs_attention", heldWalk.includes("needs_attention"), heldWalk.join(" > "));
t.check("the held run ends partial, not completed",
  heldWalk.at(-1) === "partial" && heldReport.workflow.state === "partial", heldReport.workflow.state);
t.check("only the deciding state ended it: the last move is deciding > partial",
  held.repo.moves.at(-1).from === "deciding" && held.repo.moves.at(-1).to === "partial");
t.check("every move the held run made is one migration 058's table allows", dbWouldAllow(held.repo));
t.check("each of the held run's moves begins where the last one ended", chained(held.repo));
t.check("needs_attention was asked for because a subject is held — a coverage disagreement stands needs_human",
  heldRecords.disagreements.some((d) => d.kind === "coverage" && d.state === "needs_human"),
  heldRecords.disagreements.map((d) => `${d.kind}:${d.state}`).join(", ") || "none");
t.check("the workflow that ends partial has tasks that ended failed_known — partial is not a synonym for completed",
  heldRecords.tasks.some((x) => x.state === "failed_known"),
  `${heldRecords.tasks.filter((x) => x.state === "failed_known").length} failed_known of ${heldRecords.tasks.length}`);

/* ────────────────────────────── C5 · a manifest that cannot be read */

t.section("C5 · a source with neither a content hash nor a version is refused, and no workflow waits for it");

{
  const truth = syntheticRecordSet({ seed: "workflow-states/unreadable", sources: 1, sheetsPerSource: 1, entriesPerTable: 2 });
  const manifest = { ...truth.manifest, sources: truth.manifest.sources.map((s) => ({ ...s, contentHash: null, objectVersionId: null })) };
  const { registry } = mockExecutors(truth);
  const repo = new RecordingRepository();
  const { scheduler } = assemble({ manifest, pack: new SyntheticRecordsPack(), executors: registry, clock: manualClock(), repo });
  let refusal = null;
  try { await scheduler.plan(); } catch (error) { refusal = error; }
  const row = await repo.getWorkflow(manifest.workflowId);

  t.check("plan() refuses the manifest and says why — the source has neither a content hash nor a version",
    refusal !== null && /content hash/.test(String(refusal.message)), String(refusal?.message ?? "the call was allowed").slice(0, 110));
  t.check("the refused workflow is not left sitting in created or queued",
    row === null || !["created", "queued"].includes(row.state), row ? row.state : "no row was written at all");
  t.check("nothing of that workflow reached the record — no row, no move, no task",
    row === null && repo.moves.length === 0 && (await repo.listTasks(manifest.workflowId)).length === 0,
    `${repo.moves.length} moves, ${(await repo.listTasks(manifest.workflowId)).length} tasks`);
  t.check("no start command was claimed for work that was never admitted", repo.outboxClaims.length === 0);
}

/* ──────────────────────────────────────────────── C6 · cancellation */

t.section("C6 · cancelling a running workflow ends it cancelled");

{
  const w = world();
  await w.scheduler.plan();
  await w.scheduler.tick();
  const before = (await w.repo.getWorkflow(w.wf)).state;
  await w.scheduler.cancel("a person stopped it");
  const after = await w.repo.getWorkflow(w.wf);
  const tasks = await w.repo.listTasks(w.wf);
  const last = w.repo.moves.at(-1);

  t.check("the workflow was running when the person asked for it to stop", before === "running", before);
  t.check("the workflow ends cancelled", after.state === "cancelled", after.state);
  t.check("the last move is from the state it was in to cancelled, and the database allows it",
    last.to === "cancelled" && last.from === before && dbPairs.has(`workflow|${last.from}|cancelled`), `${last.from} > ${last.to}`);
  t.check("cancellation says who asked and why", after.errorCode === "cancelled_by_person" && /stopped it/.test(after.errorMessage ?? ""), `${after.errorCode}: ${after.errorMessage}`);
  t.check("every move of a cancelled run is still one the table allows, and each begins where the last ended",
    dbWouldAllow(w.repo) && chained(w.repo), walkOf(w.repo).join(" > "));
  t.check("no task of a cancelled workflow is still waiting to run",
    tasks.length > 0 && tasks.every((x) => TERMINAL_TASK_STATES.includes(x.state)),
    [...new Set(tasks.map((x) => x.state))].join(", "));
  await t.refused("a cancelled workflow has no way back — it cannot be set running again",
    async () => { await w.repo.transitionWorkflow(w.wf, "cancelled", "running"); });
}

/* ──────────────────────────── C7 · what a finished run holds */

t.section("C7 · every id derived, every machine decision resting on an attempt that succeeded");

const both = [{ label: "clean", records: cleanRecords, wf: clean.wf }, { label: "held", records: heldRecords, wf: held.wf }];
const allOf = (pick) => both.flatMap((x) => pick(x.records));

const kinds = [
  ["workflow", both.map((x) => x.wf)],
  ["task", allOf((r) => r.tasks.map((x) => x.taskId))],
  ["attempt", allOf((r) => r.attempts.map((x) => x.attemptId))],
  ["claim", allOf((r) => r.claims.map((x) => x.claimId))],
  ["anchor", allOf((r) => r.anchors.map((x) => x.anchorId))],
  ["assessment", allOf((r) => r.assessments.map((x) => x.assessmentId))],
  ["disagreement", allOf((r) => r.disagreements.map((x) => x.disagreementId))],
  ["decision", allOf((r) => r.decisions.map((x) => x.decisionId))],
  ["segment", allOf((r) => r.segments.map((x) => x.segmentId))],
];
for (const [kind, ids] of kinds) {
  t.check(`every persisted ${kind} id is an RFC 4122 version-5 UUID`,
    ids.length > 0 && ids.every(isV5), `${ids.length} ids, ${ids.filter((id) => !isV5(id)).length} not version 5: ${ids.filter((id) => !isV5(id)).slice(0, 2).join(", ")}`);
}

const allAttempts = allOf((r) => r.attempts);
t.check("every attempt's id is entityId(\"attempt\", its task, its attempt number) — derived, never minted",
  allAttempts.length > 0 && allAttempts.every((a) => a.attemptId === entityId("attempt", a.taskId, a.attemptNo)),
  `${allAttempts.length} attempts, ${allAttempts.filter((a) => a.attemptId !== entityId("attempt", a.taskId, a.attemptNo)).length} not derived`);
const attempted = both.flatMap((x) => x.records.tasks
  .map((task) => sorted(x.records.attempts.filter((a) => a.taskId === task.taskId).map((a) => a.attemptNo)))
  .filter((nos) => nos.length > 0));
t.check("a task's attempts are numbered from one, without gaps or repeats",
  attempted.length > 0 && attempted.reduce((n, nos) => n + nos.length, 0) === allAttempts.length
  && attempted.every((nos) => nos.every((n, i) => n === i + 1)),
  `${attempted.length} tasks with attempts, ${allAttempts.length} attempts in all`);

const allDecisions = allOf((r) => r.decisions);
const attemptById = new Map(allAttempts.map((a) => [a.attemptId, a]));
const machineDecided = allDecisions.filter((d) => d.status === "machine_decided");
const needsHuman = allDecisions.filter((d) => d.status === "needs_human");

t.check("every machine_decided decision names the attempt that decided it, and that attempt exists and succeeded",
  machineDecided.length > 0 && machineDecided.every((d) => d.decidedByAttemptId !== null && attemptById.get(d.decidedByAttemptId)?.state === "succeeded"),
  `${machineDecided.length} machine decisions; ${machineDecided.filter((d) => attemptById.get(d.decidedByAttemptId ?? "")?.state !== "succeeded").length} rest on no succeeded attempt`);
t.check("every decision held for a person names no attempt — a machine did not make it",
  needsHuman.length > 0 && needsHuman.every((d) => d.decidedByAttemptId === null),
  `${needsHuman.length} held decisions`);
t.check("no decision was decided by a person in a run no person touched",
  allDecisions.every((d) => d.status !== "human_decided") && allDecisions.every((d) => d.authority !== "human"),
  [...new Set(allDecisions.map((d) => `${d.status}/${d.authority}`))].join(", "));
t.check("every decision's status is one the decision machine can reach from proposed",
  allDecisions.every((d) => d.status === "proposed" || MACHINES.decision.proposed.includes(d.status)),
  [...new Set(allDecisions.map((d) => d.status))].join(", "));

t.check("every task of the completed workflow is terminal",
  cleanRecords.tasks.length > 0 && cleanRecords.tasks.every((x) => TERMINAL_TASK_STATES.includes(x.state)),
  [...new Set(cleanRecords.tasks.map((x) => x.state))].join(", "));
t.check("every task of the partial workflow is terminal too — partial means finished, not abandoned mid-flight",
  heldRecords.tasks.length > 0 && heldRecords.tasks.every((x) => TERMINAL_TASK_STATES.includes(x.state)),
  [...new Set(heldRecords.tasks.map((x) => x.state))].join(", "));
t.check("every attempt of a finished run is terminal",
  allAttempts.length > 0 && allAttempts.every((a) => MACHINES.attempt[a.state].length === 0),
  [...new Set(allAttempts.map((a) => a.state))].join(", "));

for (const { label, records } of both) {
  const terminal = records.tasks.filter((x) => TERMINAL_TASK_STATES.includes(x.state)).length;
  const attention = records.tasks.filter((x) => x.state === "failed_known" || x.state === "outcome_unknown").length
    + records.disagreements.filter((d) => d.state === "needs_human").length;
  t.check(`${label}: the workflow's progress counters agree with the tasks and the holds the record actually has`,
    records.workflow.totalUnits === records.tasks.length && records.workflow.completedUnits === terminal && records.workflow.attentionUnits === attention,
    `total ${records.workflow.totalUnits}/${records.tasks.length}, done ${records.workflow.completedUnits}/${terminal}, attention ${records.workflow.attentionUnits}/${attention}`);
}
t.check("the completed workflow counts every unit done and none needing attention",
  cleanRecords.workflow.completedUnits === cleanRecords.workflow.totalUnits && cleanRecords.workflow.attentionUnits === 0,
  `${cleanRecords.workflow.completedUnits}/${cleanRecords.workflow.totalUnits}, attention ${cleanRecords.workflow.attentionUnits}`);
t.check("the partial workflow counts what needs attention",
  heldRecords.workflow.attentionUnits > 0, `${heldRecords.workflow.attentionUnits}`);

/* ═══════════════════════════ every door stayed closed */

t.section("every door stayed closed");
t.check("nothing in this file tried the network", tripped() === 0, `${tripped()} attempts`);

t.finish();
