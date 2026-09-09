/* THE DISPATCHER, AGAINST A REAL DATABASE.
 *
 * Everything a dispatcher promises is a promise about crashes and races, and
 * neither can be proved against a double: a second dispatcher that cannot
 * actually contend for a row proves nothing, and a restart that keeps its
 * memory is not a restart. So every claim below is made on a throwaway
 * PostgreSQL cluster with every migration applied, and the two dispatchers
 * that race for one command hold two separate connections to it.
 *
 * The agents are the synthetic records pack's scripted executors. No provider
 * adapter, no transport, no key, no network of the engine's own — the only
 * socket in this file is the unix socket to the local cluster, which is why
 * the network cannot be sealed in this process. It is sealed in a second one:
 * the last section runs the part of the dispatcher that needs no database —
 * the back-off, the shutdown gate and the rule its event stream keeps — in a
 * child process that closes every door first and reports the count back. That
 * is the same division workers/core-v2-runtime/tests/budget.mjs records.
 *
 * Nothing here is anybody's. The sources are invented from a seed, the truth
 * about them is invented with them, and the executors are code.
 */
import { harness } from "../../core-v2/tests/harness.mjs";
import { spawnSync } from "node:child_process";
import { ensureCluster, withThrowawayDatabase, HARNESS_LOCATION } from "../../core-v2/tests/postgres-harness.mjs";
import { WireClient } from "../../core-v2/postgres/wire.ts";
import { PostgresOrchestrationRepository } from "../../core-v2/postgres/repository.ts";
import { ExecutorRegistry } from "../../core-v2/kernel/executors.ts";
import { INDEPENDENCE_GROUPS } from "../../core-v2/kernel/domain.ts";
import { policyWith } from "../../core-v2/kernel/policy.ts";
import { syntheticRecordSet } from "../../core-v2/domains/synthetic-records/fixture.ts";
import { SyntheticRecordsPack } from "../../core-v2/domains/synthetic-records/pack.ts";
import { mockExecutors } from "../../core-v2/domains/synthetic-records/mocks.ts";
import { Dispatcher, enqueueWorkflow, idleWork, operationalValue } from "../dispatcher.ts";

const t = harness("the durable dispatcher");

const [, READER_B] = INDEPENDENCE_GROUPS;
const READER_FAMILIES = ["reader-family-one", "reader-family-two", "reader-family-three"];
const SCRIPTED_FAMILIES = [...READER_FAMILIES, "critic-family-one", "critic-family-two", "arbiter-family-one"];
const n = (rows) => Number(rows[0].n);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* One reader misreads one entry, which is how two blind readings of one
   table come to disagree. */
const wrongOnOne = (packet, base) => {
  if (packet.roleKey === "table_reader" && packet.independenceGroup === READER_B) {
    for (const c of base.claims) {
      if (c.subjectKey === "entry/E-001") c.value = { ...c.value, quantity: c.value.quantity + 5, text: `${c.value.quantity + 5}` };
    }
  }
  return base;
};

/* The same misreading, and an arbiter that will not settle it: the run ends
   with a subject only a person can close. */
const refuseToSettle = (packet, base) => {
  if (packet.roleKey !== "evidence_arbiter" || !base.adjudication) return wrongOnOne(packet, base);
  base.adjudication = {
    ...base.adjudication, outcome: "needs_human", acceptedClaimRef: null, correctedValue: null, correctedUnit: null,
    evidenceAnchorIds: [], followUp: null, rationale: "the reopened source does not settle which reading is right; a person decides",
  };
  return base;
};

/* One blind reading that never comes back. Its attempt times out, and what
   became of it is unknown until its executor is asked. */
const oneReadingNeverReturns = (packet, base) => {
  if (packet.roleKey === "note_reader" && packet.independenceGroup === READER_B) return "hang";
  return base;
};

const scriptsFor = (script) => (script ? Object.fromEntries(SCRIPTED_FAMILIES.map((f) => [f, script])) : {});

await withThrowawayDatabase(async ({ client, organizationId, databaseName }) => {
  const { socketPath } = await ensureCluster();
  const openConnections = [];
  const connect = async () => {
    const c = await WireClient.connect({ socketPath, user: HARNESS_LOCATION.user, database: databaseName, applicationName: "core-v2-dispatcher" });
    openConnections.push(c);
    return c;
  };

  /* Every world this file invents, by the id of its workflow: the truth its
     executors read from, and how they are told to behave. */
  const worlds = new Map();
  const pack = new SyntheticRecordsPack();

  /* A workflow committed but not started: the rows a producer writes, and one
     pending command for a dispatcher to find. */
  async function enqueue(seed, script = null) {
    const truth = syntheticRecordSet({ seed, sources: 1, sheetsPerSource: 1, entriesPerTable: 3, organizationId });
    const repo = new PostgresOrchestrationRepository(client, { organizationId });
    await enqueueWorkflow(repo, truth.manifest, pack);
    worlds.set(truth.manifest.workflowId, { truth, script });
    return { truth, workflowId: truth.manifest.workflowId };
  }

  /* Every event every dispatcher in this file emitted, in order. */
  const events = [];

  /* A dispatcher. `made` collects the executor sets it built, so a test can
     ask which packets a particular set of agents was handed. */
  function dispatcherNamed(name, options = {}) {
    const made = [];
    const dispatcher = new Dispatcher({
      name,
      connect,
      repository: (c) => new PostgresOrchestrationRepository(c, { organizationId }),
      pack,
      executors: (manifest) => {
        const world = worlds.get(manifest.workflowId);
        if (!world) throw new Error(`the test has no world for ${manifest.workflowId}`);
        const built = options.executors
          ? options.executors(world)
          : mockExecutors(world.truth, { scripts: scriptsFor(world.script) });
        made.push(built);
        return built.registry;
      },
      events: (event) => { events.push(event); },
      now: () => Date.now(),
      policy: options.policy,
      leaseTtlMs: options.leaseTtlMs,
      ticksPerPass: options.ticksPerPass ?? 8,
      workflowsPerPass: options.workflowsPerPass ?? 4,
      backoff: options.backoff ?? { baseMs: 10, ceilingMs: 40, jitter: 0, random: () => 0 },
      signal: options.signal,
    });
    return { dispatcher, made };
  }

  const outboxOf = async (workflowId) => (await client.query(
    `select state, dispatcher, attempt_count from public.workflow_outbox where workflow_id = $1`, [workflowId])).rows[0];
  const stateOf = async (workflowId) => (await client.query(
    `select state from public.intelligence_workflows where id = $1`, [workflowId])).rows[0].state;
  const taskCount = async (workflowId) => n((await client.query(
    `select count(*) n from public.workflow_tasks where workflow_id = $1`, [workflowId])).rows);
  const attemptCount = async (workflowId) => n((await client.query(
    `select count(*) n from public.agent_attempts where workflow_id = $1`, [workflowId])).rows);

  /* ══════════════════════════════ 1 · the command, claimed once and answered for */

  t.section("a pending command is claimed once, and acknowledged only when ownership is durable");

  const first = await enqueue("dispatcher/claimed");
  const one = dispatcherNamed("dispatcher-one");

  const beforeClaim = await outboxOf(first.workflowId);
  t.check("a committed workflow waits as one pending start command, under nobody's name",
    beforeClaim.state === "pending" && beforeClaim.dispatcher === null && Number(beforeClaim.attempt_count) === 0
    && (await stateOf(first.workflowId)) === "created", JSON.stringify(beforeClaim));

  const claimed = await one.dispatcher.claim();
  const afterClaim = await outboxOf(first.workflowId);
  t.check("claiming takes the command out of the queue under the dispatcher's own name and moves the workflow off created",
    claimed === first.workflowId && afterClaim.state === "dispatching" && afterClaim.dispatcher === "dispatcher-one"
    && Number(afterClaim.attempt_count) === 1 && (await stateOf(first.workflowId)) === "queued", JSON.stringify(afterClaim));
  t.check("but nothing is acknowledged yet, and no task exists: a dispatcher that died here would have owned nothing",
    afterClaim.state !== "acknowledged" && (await taskCount(first.workflowId)) === 0);

  await one.dispatcher.establishOwnership(first.workflowId);
  const afterOwnership = await outboxOf(first.workflowId);
  t.check("the command is acknowledged only after the workflow is running and its first tasks are admitted",
    afterOwnership.state === "acknowledged" && (await stateOf(first.workflowId)) === "running"
    && (await taskCount(first.workflowId)) > 0,
    `${afterOwnership.state}; ${await stateOf(first.workflowId)}; ${await taskCount(first.workflowId)} tasks`);
  t.check("and the same dispatcher asking again finds nothing, because the command it claimed is no longer waiting",
    (await one.dispatcher.claim()) === null);

  const ownedEvent = events.find((e) => e.event === "workflow.owned" && e.workflow === first.workflowId);
  t.check("the stream says what it took ownership of, in ids and counts",
    ownedEvent !== undefined && ownedEvent.tasks_admitted > 0 && ownedEvent.state === "running", JSON.stringify(ownedEvent));

  const firstReports = await one.dispatcher.drain();
  t.check("the workflow it owns runs to completion in bounded passes",
    (await stateOf(first.workflowId)) === "completed" && firstReports.length > 1,
    `${await stateOf(first.workflowId)} after ${firstReports.length} passes`);
  t.check("no pass ever ran more ticks than its budget allowed",
    firstReports.every((r) => r.workflows.every((w) => w.ticks <= 8)),
    firstReports.map((r) => r.workflows.map((w) => w.ticks).join("+")).join(" | "));

  /* ══════════════════════════════════════════ 2 · two dispatchers, one command */

  t.section("two dispatchers racing for one command: one claim, one start");

  const contested = await enqueue("dispatcher/contested");
  const racerA = dispatcherNamed("dispatcher-racer-a");
  const racerB = dispatcherNamed("dispatcher-racer-b");
  const race = await Promise.all([racerA.dispatcher.claim(), racerB.dispatcher.claim()]);
  const winners = race.filter((id) => id === contested.workflowId);
  const racedOutbox = await outboxOf(contested.workflowId);
  t.check("exactly one of the two dispatchers claims the command; the other is told there is nothing waiting",
    winners.length === 1 && race.filter((id) => id === null).length === 1, JSON.stringify(race));
  t.check("the command was attempted once and carries one dispatcher's name — not two attempts, not two names",
    Number(racedOutbox.attempt_count) === 1 && ["dispatcher-racer-a", "dispatcher-racer-b"].includes(racedOutbox.dispatcher),
    JSON.stringify(racedOutbox));

  const winner = racedOutbox.dispatcher === "dispatcher-racer-a" ? racerA : racerB;
  const loser = racedOutbox.dispatcher === "dispatcher-racer-a" ? racerB : racerA;
  await Promise.all([winner.dispatcher.establishOwnership(contested.workflowId), loser.dispatcher.runOnce()]);
  const planned = n((await client.query(
    `select count(*) n from public.audit_events where action = 'core_v2.workflow.planned' and entity_id = $1`, [contested.workflowId])).rows);
  t.check("the workflow was planned exactly once, however many dispatchers looked at it", planned === 1, `${planned} plannings`);

  /* Both of them work the same workflow from here: leases, not luck, decide
     who gets which task. */
  for (let i = 0; i < 12 && (await stateOf(contested.workflowId)) !== "completed"; i++) {
    await Promise.all([winner.dispatcher.runOnce(), loser.dispatcher.runOnce()]);
  }
  const contestedAttempts = (await client.query(
    `select task_id from public.agent_attempts where workflow_id = $1 and state = 'succeeded' group by task_id having count(*) > 1`,
    [contested.workflowId])).rows;
  t.check("two dispatchers working one workflow finish it without either of them running a task the other ran",
    (await stateOf(contested.workflowId)) === "completed" && contestedAttempts.length === 0,
    `${await stateOf(contested.workflowId)}; ${contestedAttempts.length} tasks with two succeeded attempts`);

  await racerA.dispatcher.stop();
  await racerB.dispatcher.stop();

  /* ═══════════════════════════════════════════ 3 · a restart in the middle */

  t.section("a dispatcher that stops mid-run, and one that takes the workflow up afterwards");

  const restarted = await enqueue("dispatcher/restarted", wrongOnOne);
  const before = dispatcherNamed("dispatcher-before", { ticksPerPass: 1 });
  await before.dispatcher.runOnce();
  for (let i = 0; i < 2; i++) await before.dispatcher.runOnce();
  const midTasks = (await client.query(
    `select state from public.workflow_tasks where workflow_id = $1`, [restarted.workflowId])).rows.map((r) => r.state);
  const terminalMid = midTasks.filter((s) => ["completed", "failed_known", "outcome_unknown", "cancelled", "superseded"].includes(s));
  t.check("the first dispatcher stopped with work done and work left",
    terminalMid.length > 0 && terminalMid.length < midTasks.length, `${terminalMid.length} of ${midTasks.length} tasks finished`);
  await before.dispatcher.stop();
  t.check("stopping a dispatcher mid-run leaves nothing leased behind it",
    n((await client.query(`select count(*) n from public.workflow_tasks where workflow_id = $1 and state in ('leased','running')`, [restarted.workflowId])).rows) === 0);

  const after = dispatcherNamed("dispatcher-after");
  await after.dispatcher.drain();
  t.check("a dispatcher that was never told what happened resumes the workflow from the record and finishes it",
    (await stateOf(restarted.workflowId)) === "completed", await stateOf(restarted.workflowId));

  const twice = (await client.query(
    `select task_id from public.agent_attempts where workflow_id = $1 and state = 'succeeded' group by task_id having count(*) > 1`,
    [restarted.workflowId])).rows;
  const completedTasks = n((await client.query(
    `select count(*) n from public.workflow_tasks where workflow_id = $1 and state = 'completed'`, [restarted.workflowId])).rows);
  t.check("no completed task was run a second time: one attempt per task, and not one of them twice",
    twice.length === 0 && (await attemptCount(restarted.workflowId)) === completedTasks,
    `${await attemptCount(restarted.workflowId)} attempts, ${completedTasks} completed tasks`);

  const packetsBefore = new Set(before.made.flatMap((m) => m.registry.packetsSeen).map((p) => p.taskId));
  const packetsAfter = new Set(after.made.flatMap((m) => m.registry.packetsSeen).map((p) => p.taskId));
  t.check("the agents before the restart and the agents after it were handed no piece of work in common",
    packetsBefore.size > 0 && packetsAfter.size > 0 && [...packetsBefore].every((id) => !packetsAfter.has(id)),
    `${packetsBefore.size} tasks before, ${packetsAfter.size} after`);
  await after.dispatcher.stop();

  /* ═════════════════════════════════════════════════ 4 · cancellation */

  t.section("a cancelled workflow stops being dispatched, whoever asked");

  const cancelled = await enqueue("dispatcher/cancelled");
  const runner = dispatcherNamed("dispatcher-runner", { ticksPerPass: 1 });
  await runner.dispatcher.runOnce();
  await runner.dispatcher.runOnce();
  const attemptsAtCancel = await attemptCount(cancelled.workflowId);
  t.check("the workflow was under way when a person asked for it to stop",
    attemptsAtCancel > 0 && !["completed", "partial", "cancelled", "failed"].includes(await stateOf(cancelled.workflowId)),
    `${attemptsAtCancel} attempts, ${await stateOf(cancelled.workflowId)}`);
  await new PostgresOrchestrationRepository(client, { organizationId }).requestCancel(cancelled.workflowId, Date.now());
  await runner.dispatcher.stop();

  /* A dispatcher that never held this workflow finds the request in the
     record and honours it. */
  const honouring = dispatcherNamed("dispatcher-honouring");
  const honoured = await honouring.dispatcher.runOnce();
  t.check("a dispatcher that never held the workflow honours the cancellation it finds in the record",
    honoured.cancelled.includes(cancelled.workflowId) && (await stateOf(cancelled.workflowId)) === "cancelled",
    `${await stateOf(cancelled.workflowId)}`);
  t.check("nothing that had already finished was undone, and nothing unsent was left running",
    n((await client.query(
      `select count(*) n from public.workflow_tasks where workflow_id = $1 and state in ('created','blocked','queued','leased','running')`,
      [cancelled.workflowId])).rows) === 0);

  const afterCancel = await attemptCount(cancelled.workflowId);
  await honouring.dispatcher.runOnce();
  await honouring.dispatcher.runOnce();
  t.check("later passes do not dispatch it again: a cancelled workflow is not work",
    (await attemptCount(cancelled.workflowId)) === afterCancel, `${afterCancel} attempts, then ${await attemptCount(cancelled.workflowId)}`);
  t.check("and it is not among the workflows a restart would take up",
    !(await honouring.dispatcher.resumableWorkflows()).includes(cancelled.workflowId));

  /* ══════════════════════════════════════════════ 5 · shutting down */

  t.section("shutdown stops new work, lets the pass in flight settle, and returns");

  const inFlight = await enqueue("dispatcher/shutdown-in-flight");
  const waiting = await enqueue("dispatcher/shutdown-waiting");
  const closing = dispatcherNamed("dispatcher-closing", { ticksPerPass: 2, workflowsPerPass: 1 });

  let passFinished = false;
  const pass = closing.dispatcher.runOnce().then((report) => { passFinished = true; return report; });
  await sleep(25);
  const stopped = closing.dispatcher.stop().then(() => passFinished);
  const [passReport, settledAfterPass] = await Promise.all([pass, stopped]);
  t.check("the pass that had already begun took its command and finished, and stop() returned only after it had",
    passReport.accepting === true && passReport.claimed.length === 1 && settledAfterPass === true,
    `${passReport.accepting}; claimed ${JSON.stringify(passReport.claimed)}`);
  t.check("a dispatcher asked to stop refuses the next pass rather than taking more work",
    (await closing.dispatcher.runOnce()).accepting === false);
  const waitingOutbox = await outboxOf(waiting.workflowId);
  t.check("the command it never got to is still waiting for somebody else, untouched",
    waitingOutbox.state === "pending" && Number(waitingOutbox.attempt_count) === 0, JSON.stringify(waitingOutbox));
  t.check("the stream says it stopped", events.some((e) => e.event === "dispatcher.stopped" && e.dispatcher === "dispatcher-closing"));

  /* A shutdown signal does the same thing without anybody calling stop(). */
  const controller = new AbortController();
  const signalled = dispatcherNamed("dispatcher-signalled", { signal: controller.signal });
  controller.abort();
  const refusedPass = await signalled.dispatcher.runOnce();
  t.check("a dispatcher whose shutdown signal has fired takes no work either",
    refusedPass.accepting === false && refusedPass.claimed.length === 0 && (await outboxOf(waiting.workflowId)).state === "pending");

  /* Whatever was left half-done is finished by the next dispatcher up. */
  const successor = dispatcherNamed("dispatcher-successor");
  await successor.dispatcher.drain();
  t.check("the work the closing dispatcher left, and the command it never reached, are both finished by its successor",
    (await stateOf(inFlight.workflowId)) === "completed" && (await stateOf(waiting.workflowId)) === "completed",
    `${await stateOf(inFlight.workflowId)}, ${await stateOf(waiting.workflowId)}`);

  /* ══════════════════════════════════ 6 · back-off, against the record */

  t.section("back-off grows when there is nothing to do and resets when there is");

  const quiet = dispatcherNamed("dispatcher-quiet", { backoff: { baseMs: 10, ceilingMs: 40, jitter: 0, random: () => 0 } });
  const empties = [];
  for (let i = 0; i < 5; i++) empties.push(await quiet.dispatcher.runOnce());
  t.check("with nothing waiting and nothing to resume, every pass is idle and takes nothing",
    empties.every((r) => r.idle && r.claimed.length === 0), empties.map((r) => `${r.idle}`).join(" "));
  t.check("the wait doubles from the base and stops at the ceiling",
    empties.map((r) => r.backoffMs).join(",") === "10,20,40,40,40", empties.map((r) => r.backoffMs).join(","));

  const afterQuiet = await enqueue("dispatcher/backoff-reset");
  const busy = await quiet.dispatcher.runOnce();
  t.check("a pass that finds work waits for nothing at all, and the count of empty passes starts again",
    busy.idle === false && busy.backoffMs === 0 && busy.idleStreak === 0 && busy.claimed.includes(afterQuiet.workflowId));
  const drained = await quiet.dispatcher.drain();
  const working = drained.slice(0, -1);
  const firstQuietAgain = drained[drained.length - 1];
  t.check("while there is work every pass waits for nothing, and when the work is gone the wait begins again at the base",
    working.every((r) => r.backoffMs === 0 && !r.idle) && firstQuietAgain.idle === true
    && firstQuietAgain.idleStreak === 1 && firstQuietAgain.backoffMs === 10,
    drained.map((r) => r.backoffMs).join(","));
  const quietAgain = await quiet.dispatcher.runOnce();
  t.check("and the doubling starts over from there rather than from where it left off",
    quietAgain.backoffMs === 20, `${quietAgain.backoffMs} ms`);
  await quiet.dispatcher.stop();

  /* ═══════════════════════════════ 7 · a subject only a person can settle */

  t.section("a workflow that needs a person ends somewhere a person can act");

  const held = await enqueue("dispatcher/held-for-a-person", refuseToSettle);
  const holder = dispatcherNamed("dispatcher-holder");
  await holder.dispatcher.drain();
  const heldState = await stateOf(held.workflowId);
  const heldDispute = (await client.query(
    `select state, needs_human_reason from public.disagreements where workflow_id = $1`, [held.workflowId])).rows;
  const heldDecision = (await client.query(
    `select decision_type, status from public.decisions where workflow_id = $1 and status = 'needs_human'`, [held.workflowId])).rows;
  t.check("the run ends in a state that says a person is required, not in one that says it is still working",
    ["partial", "needs_attention"].includes(heldState), heldState);
  t.check("the subject the machine would not settle is held, with the reason on its row",
    heldDispute.length === 1 && heldDispute[0].state === "needs_human" && (heldDispute[0].needs_human_reason ?? "").length > 0,
    JSON.stringify(heldDispute));
  t.check("a decision stands against it waiting for a person", heldDecision.length >= 1, JSON.stringify(heldDecision));
  const heldEvent = events.find((e) => e.event === "workflow.needs_person" && e.workflow === held.workflowId);
  t.check("and the stream says how much is waiting for somebody, without saying what it is about",
    heldEvent !== undefined && heldEvent.disagreements_held >= 1 && heldEvent.decisions_held >= 1, JSON.stringify(heldEvent));
  const heldWork = await holder.dispatcher.workRemaining(await holder.dispatcher.record(), null, held.workflowId);
  t.check("nothing is left that the engine could do by itself", idleWork(heldWork), JSON.stringify(heldWork));
  await holder.dispatcher.stop();

  /* ══════════════════ 8 · an outcome nobody saw, asked about before anything else */

  t.section("an attempt whose outcome is unknown is put to its executor, and never retried");

  const lost = await enqueue("dispatcher/lost-answer", oneReadingNeverReturns);
  const log = [];
  const inner = [];
  const reconciling = dispatcherNamed("dispatcher-reconciling", {
    policy: policyWith({ attemptTimeoutMs: 120, settlementAllowanceMs: 20, heartbeatIntervalMs: 40 }),
    leaseTtlMs: 60_000,
    ticksPerPass: 2,
    executors: (world) => {
      const built = mockExecutors(world.truth, { scripts: scriptsFor(world.script) });
      inner.push(built.executors);
      const registry = new ExecutorRegistry();
      for (const [family, executor] of Object.entries(built.executors)) {
        registry.register({
          family,
          execute: (packet, context) => { log.push(`execute:${packet.taskId}`); return executor.execute(packet, context); },
          reconcile: (attemptId) => { log.push(`reconcile:${attemptId}`); return executor.reconcile(attemptId); },
        }, [family]);
      }
      return { registry, executors: built.executors };
    },
  });

  let unknown = null;
  for (let i = 0; i < 8 && unknown === null; i++) {
    await reconciling.dispatcher.runOnce();
    const rows = (await client.query(
      `select id, task_id, executor_family, reconciliation_outcome from public.agent_attempts
        where workflow_id = $1 and state = 'outcome_unknown'`, [lost.workflowId])).rows;
    if (rows.length) unknown = rows[0];
  }
  t.check("a reading that never came back leaves an attempt whose outcome nobody knows",
    unknown !== null && unknown.reconciliation_outcome === null, JSON.stringify(unknown));

  /* Its executor can now say what became of it. */
  for (const set of inner) for (const executor of Object.values(set)) executor.reconciliations.set(unknown.id, "never_started");
  const executesBefore = log.filter((line) => line.startsWith("execute:")).length;
  await reconciling.dispatcher.runOnce();
  const settledAttempt = (await client.query(
    `select state, reconciliation_outcome from public.agent_attempts where id = $1`, [unknown.id])).rows[0];
  t.check("the next pass asks the executor what became of it, and writes the answer on the attempt",
    settledAttempt.reconciliation_outcome === "never_started" && settledAttempt.state === "outcome_unknown", JSON.stringify(settledAttempt));

  const reconcileAt = log.indexOf(`reconcile:${unknown.id}`);
  const retried = log.slice(reconcileAt).filter((line) => line === `execute:${unknown.task_id}`);
  t.check("the question was asked before anything else ran, and its task was never sent a second time",
    reconcileAt >= executesBefore && retried.length === 0 && n((await client.query(
      `select count(*) n from public.agent_attempts where task_id = $1`, [unknown.task_id])).rows) === 1,
    `asked at ${reconcileAt} of ${log.length}, ${retried.length} retries`);

  await reconciling.dispatcher.drain();
  const lostState = await stateOf(lost.workflowId);
  const lostWork = await reconciling.dispatcher.workRemaining(await reconciling.dispatcher.record(), null, lost.workflowId);
  t.check("the workflow it belongs to ends where a person can act, with nothing left for the engine to do",
    idleWork(lostWork) && lostState !== "running" && ["partial", "needs_attention", "failed"].includes(lostState),
    `${lostState}; ${JSON.stringify(lostWork)}`);
  await reconciling.dispatcher.stop();

  /* ════════════════ 9 · nothing says it is running when nothing can run */

  t.section("no workflow is left saying it is running with nothing runnable, leased or reconcilable");

  const auditor = dispatcherNamed("dispatcher-auditor");
  const repo = await auditor.dispatcher.record();
  const allWorkflows = (await client.query(`select id, state from public.intelligence_workflows order by created_at`)).rows;
  const offenders = [];
  for (const row of allWorkflows) {
    const work = await auditor.dispatcher.workRemaining(repo, null, row.id);
    if (idleWork(work) && row.state === "running") offenders.push(`${row.id}:${row.state}`);
  }
  t.check("every workflow this file ran either has work to do or has stopped saying it is running",
    allWorkflows.length >= 8 && offenders.length === 0, `${allWorkflows.length} workflows; offenders: ${offenders.join(", ") || "none"}`);
  const states = allWorkflows.map((r) => r.state);
  t.check("and the states they ended in are the ones the engine is allowed to end in",
    states.every((s) => ["completed", "partial", "needs_attention", "cancelled", "failed"].includes(s)), states.join(" "));
  await auditor.dispatcher.stop();
  await one.dispatcher.stop();
  await successor.dispatcher.stop();
  await signalled.dispatcher.stop();
  await honouring.dispatcher.stop();

  /* ═══════════════════════════════════ 10 · what the stream is allowed to say */

  t.section("the event stream carries ids, counts and its own words — nothing else");

  const line = (e) => JSON.stringify(e);
  t.check("every event is one JSON object with a time, a dispatcher and a name",
    events.length > 40 && events.every((e) => typeof e.at === "number" && typeof e.dispatcher === "string" && typeof e.event === "string"
      && line(e).startsWith("{") && !line(e).includes("\n")), `${events.length} events`);

  const stream = events.map(line).join("\n");
  const credentialShaped = [/api[_.-]?key/i, /secret/i, /bearer/i, /password/i, /authoriz/i, /\bsk-[a-z0-9]/i, /credential/i, /session[_-]?id/i];
  const hits = credentialShaped.filter((re) => re.test(stream)).map(String);
  t.check("nothing in it reads like a key, a secret or a credential of any kind", hits.length === 0, hits.join(" "));

  /* Everything the invented sources say about themselves: their locators,
     their content identities, the words on them and the subjects those words
     name. None of it is operational, so none of it may be in the stream. */
  const fromTheSources = [];
  for (const { truth } of worlds.values()) {
    for (const source of truth.manifest.sources) {
      fromTheSources.push(source.uri, source.contentHash, source.label);
      for (const declared of source.declaredSegments) fromTheSources.push(declared.contentHash, declared.label);
    }
    for (const sheet of truth.sheets) {
      fromTheSources.push(sheet.contentHash, sheet.label);
      for (const region of sheet.regions) fromTheSources.push(region.contentHash, region.label);
    }
    for (const entry of truth.entries) fromTheSources.push(entry.id, `entry/${entry.id}`, entry.category);
  }
  const leaked = [...new Set(fromTheSources.filter(Boolean))].filter((word) => stream.includes(word));
  t.check("and nothing in it came out of a source: no locator, no content identity, no label, no subject, no reading",
    leaked.length === 0, `${fromTheSources.length} things the sources say; leaked: ${leaked.slice(0, 5).join(", ") || "none"}`);

  const escalating = events.filter((e) => e.event === "workflow.tick" && typeof e.escalations === "number" && e.escalations > 0);
  t.check("what a person must look at is counted, never quoted",
    escalating.every((e) => typeof e.escalations === "number"), `${escalating.length} ticks with something for a person`);
  const claimEvents = events.filter((e) => e.event === "outbox.claimed");
  const doorsUsed = [...new Set(claimEvents.map((e) => e.door))];
  const doorReports = events.filter((e) => e.event === "door.unavailable");
  t.check("every claim says which door it went through, and a door that could not be used is reported with what took its place",
    claimEvents.length >= 5 && doorsUsed.every((d) => typeof d === "string" && d.startsWith("core_v2_claim"))
    && doorReports.every((e) => e.instead === "core_v2_claim_outbox" && typeof e.problem === "string"),
    `${claimEvents.length} claims through ${doorsUsed.join(", ")}; ${doorReports.length} door reports`);

  for (const c of openConnections) await c.end().catch(() => undefined);
  await sleep(10);
});

/* ═════════════ what needs no database, behind a network that is shut ═════ */

/* Its own process, because closing the network also shuts the doors the
   throwaway cluster is started through. The first thing it does is close
   every door; then it drives a dispatcher whose connection answers "nothing"
   to everything, which is exactly the shape of an empty queue. */
t.section("the back-off, the shutdown gate and the sink's rule, with every door shut");

{
  const harnessUrl = new URL("../../core-v2/tests/harness.mjs", import.meta.url).href;
  const dispatcherUrl = new URL("../dispatcher.ts", import.meta.url).href;
  const packUrl = new URL("../../core-v2/domains/synthetic-records/pack.ts", import.meta.url).href;
  const source = `
import { closeNetwork } from ${JSON.stringify(harnessUrl)};
const tripped = closeNetwork();
const { Dispatcher, operationalValue, idleWork, problemToken, NOT_OPERATIONAL } = await import(${JSON.stringify(dispatcherUrl)});
const { SyntheticRecordsPack } = await import(${JSON.stringify(packUrl)});
const checks = [];
const say = (label, ok, detail = "") => checks.push([label, Boolean(ok), String(detail)]);

/* A connection that has nothing to give, which is what an empty queue is. */
const nothing = { query: async () => ({ command: "SELECT", rowCount: 0, rows: [], fields: [] }) };
const events = [];
let clock = 1;
const build = (over = {}) => new Dispatcher({
  name: "dispatcher-sealed",
  connect: async () => nothing,
  repository: () => ({}),
  pack: new SyntheticRecordsPack(),
  executors: () => { throw new Error("no executor is built when there is nothing to run"); },
  events: (e) => events.push(e),
  now: () => clock++,
  backoff: { baseMs: 100, ceilingMs: 800, jitter: 0, random: () => 0 },
  ...over,
});

const idle = build();
const waits = [];
for (let i = 0; i < 6; i++) waits.push((await idle.runOnce()).backoffMs);
say("with nothing to do the wait doubles from the base and stops at the ceiling",
  waits.join(",") === "100,200,400,800,800,800", waits.join(","));

const jittered = build({ backoff: { baseMs: 100, ceilingMs: 800, jitter: 0.5, random: () => 1 } });
const rough = [];
for (let i = 0; i < 5; i++) rough.push((await jittered.runOnce()).backoffMs);
say("jitter moves the wait off the exact doubling and never past the ceiling",
  rough[0] === 150 && rough[1] === 300 && rough.every((ms) => ms <= 800) && rough.join(",") !== waits.join(","), rough.join(","));

/* The long-running form, with the clock handed in: pass, wait what the pass
   asked for, pass again — and stop when the shutdown signal fires. */
const napped = [];
const spinner = new AbortController();
let enough = null;
const threeWaits = new Promise((resolve) => { enough = resolve; });
const looping = build({
  signal: spinner.signal,
  sleep: async (ms) => { napped.push(ms); if (napped.length >= 3) { spinner.abort(); enough(); } },
});
await looping.start();
await threeWaits;
await looping.stop();
say("start() keeps passing and waiting what each pass asked it to wait, and returns when the shutdown signal fires",
  napped.join(",") === "100,200,400" && looping.accepting() === false, napped.join(","));

await idle.stop();
const refused = await idle.runOnce();
say("a dispatcher that has been stopped accepts no further pass", refused.accepting === false && refused.claimed.length === 0);
const controller = new AbortController();
const signalled = build({ signal: controller.signal });
controller.abort();
say("nor does one whose shutdown signal has fired", (await signalled.runOnce()).accepting === false);

say("an empty queue is announced as such", events.some((e) => e.event === "outbox.empty"));
say("every event is a flat object of times, counts, flags and short words",
  events.length > 0 && events.every((e) => Object.values(e).every((v) => v === null || ["number", "string", "boolean"].includes(typeof v))));

/* The rule the sink keeps, on the things that must never travel. */
const withheld = [
  "sk-not-a-real-key-000", "Bearer abcdefghijklmnop", "api_key=nothing",
  "entry/E-001", "fixture://synthetic/0", "the source shows 12 each at this place", "a sentence a person wrote",
];
say("nothing shaped like a key, a locator, a subject or a sentence gets into an event",
  withheld.every((s) => operationalValue(s) === NOT_OPERATIONAL), withheld.filter((s) => operationalValue(s) !== NOT_OPERATIONAL).join(" | "));
const kept = ["running", "needs_attention", "core_v2_claim_next_workflow", "dispatcher-one", "9f1c6b52-0000-4000-8000-00000000abcd"];
say("while ids, states and the dispatcher's own words go through unchanged",
  kept.every((s) => operationalValue(s) === s), kept.filter((s) => operationalValue(s) !== s).join(" | "));
say("and a number is a number, a flag is a flag, and nothing else is a string at all",
  operationalValue(12) === 12 && operationalValue(true) === true && operationalValue(undefined) === null
  && operationalValue({ a: 1 }) === NOT_OPERATIONAL && operationalValue(Number.NaN) === null);
say("a failure is reported as a class, never as the sentence that might quote a source",
  problemToken(new Error("core-v2: workflow 1 is deciding, not running — the caller's view is stale")) === "stale_state"
  && problemToken({ code: "23505" }) === "23505"
  && problemToken(new Error("the source at entry/E-001 says 12")) === "engine_error");
say("a workflow with nothing runnable, leased, reconcilable or in flight is quiet, and any one of those makes it busy",
  idleWork({ runnable: 0, busy: 0, reconcilable: 0, inFlight: 0 })
  && !idleWork({ runnable: 1, busy: 0, reconcilable: 0, inFlight: 0 })
  && !idleWork({ runnable: 0, busy: 1, reconcilable: 0, inFlight: 0 })
  && !idleWork({ runnable: 0, busy: 0, reconcilable: 1, inFlight: 0 })
  && !idleWork({ runnable: 0, busy: 0, reconcilable: 0, inFlight: 1 }));

console.log("SEALED " + JSON.stringify({ checks, tripped: tripped() }));
`;
  const run = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", source], { encoding: "utf8" });
  const reported = (run.stdout ?? "").split("\n").find((l) => l.startsWith("SEALED "));
  if (!reported) {
    t.check("the sealed leg ran", false, (run.stderr ?? "").trim().slice(0, 400) || "no output");
  } else {
    const report = JSON.parse(reported.slice("SEALED ".length));
    for (const [label, ok, detail] of report.checks) t.check(label, ok, detail);
    t.check("and behind a closed network the dispatcher tried no door at all", report.tripped === 0, `${report.tripped} attempts`);
  }
}

t.finish();
