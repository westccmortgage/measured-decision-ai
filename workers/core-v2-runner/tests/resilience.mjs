/* WHAT A DEAD PROCESS LEAVES, AND WHAT THE NEXT ONE MAY DO ABOUT IT.
 *
 * Production Runner V1 exists because processes die in the middle of things.
 * The whole question is what the record says afterwards and what the next
 * runner is allowed to conclude from it, and there are exactly two cases:
 *
 *   · the request PROVABLY never left. Nothing was bought, nobody read
 *     anything, and the work may safely go back on the queue;
 *   · the request MAY have left. Whether the work was done is not known, the
 *     money stays held, and no machine buys it again. A person decides.
 *
 * Getting those two the same way round is the difference between a runner and
 * a way to spend money twice. Everything below is that distinction, plus the
 * ceilings and the cancellation rules that hold while it is happening.
 *
 * Offline: a throwaway cluster, code agents, no provider named or reached.
 */
import { harness } from "../../core-v2/tests/harness.mjs";
import { withThrowawayDatabase } from "../../core-v2/tests/postgres-harness.mjs";
import { PostgresOrchestrationRepository } from "../../core-v2/postgres/repository.ts";
import { PostgresContinuationStore } from "../continuations.ts";
import { entityId } from "../../core-v2/kernel/ids.ts";
import { TERMINAL_WORKFLOW_STATES } from "../../core-v2/kernel/transitions.ts";
import { buildWorld, startWorkflow, runnerPass, runUntilSettled, slowScripts, slowBy, SHORT_LIFE, LONG_LIFE } from "./world.mjs";

const t = harness("what a dead process leaves, and what the next one may do about it");

const n = (rows) => Number(rows[0].n);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stateOf = async (client, workflowId) =>
  (await client.query("select state from public.intelligence_workflows where id = $1", [workflowId])).rows[0]?.state ?? null;

/* The row a process leaves when it is killed after leasing a task and before
   sending anything: a lease, and an attempt that never left `prepared`. */
function preparedAttempt(task, organizationId, no = 1) {
  return {
    attemptId: entityId("attempt", task.taskId, `staged-${no}`),
    workflowId: task.workflowId, taskId: task.taskId, attemptNo: no,
    roleKey: task.roleKey, roleVersion: task.roleVersion,
    executorKind: "model", executorFamily: "reader-family-one",
    independenceDomain: "domain:staged", modelConfiguration: "staged/probe@1",
    state: "prepared", leaseToken: null,
    packetFingerprint: "staged", packetBytes: 1,
    providerRequestId: null, modelReported: null, usage: {},
    providerStopReason: null, providerDurationMs: null, providerResponse: null,
    rawResult: null, rawResultHash: null,
    validationState: "pending", validationProblems: [],
    errorCode: null, errorMessage: null, reconciliationOutcome: null,
    organizationId,
  };
}

await withThrowawayDatabase(async ({ client, organizationId }) => {
  t.section("(4) a request that provably never left costs nothing and may be run again");
  const { truth, pack, world } = buildWorld({ client, organizationId, seed: "runner/unsent", scripts: slowScripts(120) });
  const { workflowId, store } = await startWorkflow({ client, organizationId, truth, pack });
  const repo = new PostgresOrchestrationRepository(client, { organizationId });

  /* A pass with barely any leasing window: long enough to finish the start
     handshake and plan, too short to work. That is precisely the moment a
     container is most likely to be killed — the record has tasks and the
     process has not sent anything. */
  const barely = { ...SHORT_LIFE, lifetimeMs: 2_300, safetyMs: 100, answerWithinMs: 1_500, settlementRoomMs: 500 };
  await runnerPass({ client, name: "before-death", world, store, life: barely });

  const open = (await repo.listTasks(workflowId)).filter((task) => ["created", "queued"].includes(task.state));
  t.check("the record holds planned work nobody has sent yet", open.length > 0, `${open.length} open`);

  const victim = open[0];
  if (victim.state === "created") await repo.transitionTask(victim.taskId, "created", "queued");
  /* Exactly what a container that died between leasing and sending leaves. */
  const lease = await repo.leaseTask(victim.taskId, "the-process-that-died", 250, Date.now());
  const staged = await repo.createAttempt(preparedAttempt(victim, organizationId));
  t.check("the record holds a lease and an attempt that never left prepared",
    lease !== null && staged.state === "prepared");

  const charged = n((await client.query(
    "select count(*)::text as n from public.attempt_cost_reservations where attempt_id = $1", [staged.attemptId])).rows);
  t.check("nothing was bought for it — no reservation exists at all", charged === 0);

  await sleep(400); /* the lease expires; the process is not coming back */

  const outcomes = await runUntilSettled({ client, world, store, life: SHORT_LIFE });
  const after = await repo.getAttempt(staged.attemptId);
  t.check("the next runner cancels the unsent attempt rather than wondering about it",
    after.state === "cancelled_before_submission", `${after.state} / ${after.errorCode}`);
  t.check("and it is still not charged for", n((await client.query(
    "select count(*)::text as n from public.attempt_cost_reservations where attempt_id = $1", [staged.attemptId])).rows) === 0);

  const victimAfter = await repo.getTask(victim.taskId);
  t.check("the task itself was safely run again and finished",
    ["completed", "superseded"].includes(victimAfter.state), victimAfter.state);
  t.check("the workflow still reached a terminal state",
    TERMINAL_WORKFLOW_STATES.includes(await stateOf(client, workflowId)), String(await stateOf(client, workflowId)));
  t.check("and it did so without a person", outcomes.every((o) => o.problems.length === 0),
    outcomes.flatMap((o) => o.problems).join(", "));
});

await withThrowawayDatabase(async ({ client, organizationId }) => {
  t.section("(5) a request that may have left is never bought again by machine");
  /* An agent that takes far longer than the attempt is allowed. The kernel
     times it out, and a timed-out attempt is the definition of an outcome
     nobody knows: it may have been served, it may have been billed. */
  const { truth, pack, world } = buildWorld({
    client, organizationId, seed: "runner/unknown",
    scripts: { "reader-family-one": slowBy(4_000), "reader-family-two": slowBy(4_000) },
  });
  const { workflowId, store } = await startWorkflow({ client, organizationId, truth, pack });

  const tight = { ...SHORT_LIFE, lifetimeMs: 6_000, answerWithinMs: 700, settlementRoomMs: 400 };
  await runUntilSettled({ client, world, store, life: tight, maximumPasses: 12 });

  const unknown = (await client.query(
    `select id::text as id, role_key, state, error_code from public.agent_attempts
      where workflow_id = $1 and state = 'outcome_unknown'`, [workflowId])).rows;
  t.check("at least one attempt ended with an outcome nobody knows", unknown.length > 0, `${unknown.length}`);

  const retried = (await client.query(
    `select count(*)::text as n from (
       select task_id from public.agent_attempts where workflow_id = $1
        group by task_id having count(*) > 1) d`, [workflowId])).rows;
  t.check("no task was attempted a second time by machine", n(retried) === 0, `${n(retried)} tasks with two attempts`);

  const held = (await client.query(
    `select count(*)::text as n from public.attempt_cost_reservations r
      join public.agent_attempts a on a.id = r.attempt_id
     where a.workflow_id = $1 and a.state = 'outcome_unknown' and r.state = 'reserved'`, [workflowId])).rows;
  t.check("the money for an unknown outcome stays HELD — not settled, not given back",
    n(held) === unknown.length, `${n(held)} held of ${unknown.length} unknown`);

  const tasks = (await client.query(
    `select count(*)::text as n from public.workflow_tasks
      where workflow_id = $1 and state = 'outcome_unknown'`, [workflowId])).rows;
  t.check("and the task says so too, in the record, for a person to act on", n(tasks) > 0);
  t.check("the runner stopped scheduling it rather than asking forever",
    ["settled"].includes((await store.read(workflowId))?.state),
    (await store.read(workflowId))?.settledReason ?? String((await store.read(workflowId))?.state));
});

await withThrowawayDatabase(async ({ client, organizationId }) => {
  t.section("(6) a completed attempt is never bought again after a restart");
  const { truth, pack, world } = buildWorld({ client, organizationId, seed: "runner/no-repurchase", scripts: slowScripts(250) });
  const { workflowId, store } = await startWorkflow({ client, organizationId, truth, pack });

  await runnerPass({ client, name: "first-life", world, store, life: SHORT_LIFE });
  const afterFirst = (await client.query(
    `select id::text as id, task_id::text as task_id, raw_result_hash from public.agent_attempts
      where workflow_id = $1 and state = 'succeeded' order by id`, [workflowId])).rows;
  t.check("the first life succeeded at something", afterFirst.length > 0, `${afterFirst.length} attempts`);

  await runUntilSettled({ client, world, store, life: SHORT_LIFE });

  const afterAll = (await client.query(
    `select id::text as id, task_id::text as task_id, raw_result_hash from public.agent_attempts
      where workflow_id = $1 and state = 'succeeded' order by id`, [workflowId])).rows;
  const byId = new Map(afterAll.map((row) => [row.id, row]));
  t.check("every attempt the first life completed is still there, byte for byte",
    afterFirst.every((row) => byId.get(row.id)?.raw_result_hash === row.raw_result_hash));
  t.check("and none of their tasks was attempted again",
    afterFirst.every((row) => afterAll.filter((x) => x.task_id === row.task_id).length === 1));

  /* Only what a model answered costs money; the deterministic roles are code
     and hold nothing, which is why this counts model attempts rather than
     attempts. */
  const paid = (await client.query(
    `select a.task_id::text as task_id, count(r.attempt_id)::text as n
       from public.agent_attempts a
       left join public.attempt_cost_reservations r on r.attempt_id = a.id
      where a.workflow_id = $1 and a.executor_kind = 'model' and a.state = 'succeeded'
      group by a.task_id`, [workflowId])).rows;
  t.check("every model attempt the first life completed holds exactly one reservation",
    paid.length > 0 && paid.every((row) => Number(row.n) === 1),
    paid.map((row) => row.n).join(","));
  const codeAttempts = (await client.query(
    `select count(*)::text as n from public.agent_attempts a
      left join public.attempt_cost_reservations r on r.attempt_id = a.id
     where a.workflow_id = $1 and a.executor_kind = 'deterministic' and r.attempt_id is not null`, [workflowId])).rows;
  t.check("and code was never charged for at all", n(codeAttempts) === 0);
});

await withThrowawayDatabase(async ({ client, organizationId }) => {
  t.section("(8) holds in flight cannot exceed what the workflow was authorised to hold");
  const { truth, pack, world, ledger } = buildWorld({
    client, organizationId, seed: "runner/ceiling", scripts: slowScripts(200), authorizedMaximum: 5,
  });
  const { workflowId, store } = await startWorkflow({ client, organizationId, truth, pack });
  await runUntilSettled({ client, world, store, life: SHORT_LIFE });

  const budget = await ledger.budget(workflowId);
  t.check("the budget row exists and knows its ceiling", budget !== null && Number(budget.authorized) === 5);
  t.check("held plus spent never passed the authority",
    Number(budget.held) + Number(budget.spent) <= Number(budget.authorized) + 1e-9,
    `${budget.held} held + ${budget.spent} spent vs ${budget.authorized}`);

  const overCeiling = (await client.query(
    `select count(*)::text as n from public.workflow_cost_budgets
      where workflow_id = $1 and reserved + settled > authorized_maximum`, [workflowId])).rows;
  t.check("and the record itself never held a moment where it had", n(overCeiling) === 0);

  const tokens = (await client.query(
    `select reserved_input_tokens, maximum_input_tokens, reserved_output_tokens, maximum_output_tokens
       from public.workflow_cost_budgets where workflow_id = $1`, [workflowId])).rows[0];
  t.check("the token ceilings are held totals and were respected",
    Number(tokens.reserved_input_tokens) <= Number(tokens.maximum_input_tokens)
    && Number(tokens.reserved_output_tokens) <= Number(tokens.maximum_output_tokens),
    JSON.stringify(tokens));
});

await withThrowawayDatabase(async ({ client, organizationId }) => {
  t.section("(9) cancellation keeps what was finished and stops what was not sent");
  const { truth, pack, world } = buildWorld({ client, organizationId, seed: "runner/cancel", scripts: slowScripts(250) });
  const { workflowId, store } = await startWorkflow({ client, organizationId, truth, pack });
  const repo = new PostgresOrchestrationRepository(client, { organizationId });

  await runnerPass({ client, name: "before-cancel", world, store, life: SHORT_LIFE });
  const completedBefore = (await repo.listTasks(workflowId)).filter((task) => task.state === "completed").map((task) => task.taskId).sort();
  const claimsBefore = n((await client.query(
    "select count(*)::text as n from public.evidence_claims where workflow_id = $1", [workflowId])).rows);
  t.check("there is finished work to preserve", completedBefore.length > 0, `${completedBefore.length} completed`);

  await repo.requestCancel(workflowId, Date.now());
  await runUntilSettled({ client, world, store, life: SHORT_LIFE, maximumPasses: 12 });

  const after = await repo.listTasks(workflowId);
  const completedAfter = after.filter((task) => task.state === "completed").map((task) => task.taskId).sort();
  t.check("every task that was finished is still finished",
    completedBefore.every((id) => completedAfter.includes(id)),
    `${completedBefore.length} before, ${completedAfter.length} after`);
  t.check("its claims were not deleted",
    n((await client.query("select count(*)::text as n from public.evidence_claims where workflow_id = $1", [workflowId])).rows) >= claimsBefore);
  t.check("nothing is left queued, leased or running",
    after.every((task) => !["queued", "leased", "running"].includes(task.state)),
    after.filter((task) => ["queued", "leased", "running"].includes(task.state)).map((task) => task.state).join(", "));
  t.check("the workflow says it was cancelled", (await stateOf(client, workflowId)) === "cancelled");

  /* An attempt that may have been served is not rewritten into a tidy
     "cancelled": the uncertainty is the fact. */
  const dishonest = (await client.query(
    `select count(*)::text as n from public.agent_attempts
      where workflow_id = $1 and submitted_at is not null and state = 'cancelled_before_submission'`, [workflowId])).rows;
  t.check("no submitted attempt was relabelled as never sent", n(dishonest) === 0);
  t.check("and the continuation stopped scheduling itself",
    (await store.read(workflowId))?.state === "settled", (await store.read(workflowId))?.settledReason ?? "");
});

await withThrowawayDatabase(async ({ client, organizationId }) => {
  t.section("(11) a runner resolves material only for the workflow it is advancing");
  /* Two workflows, two seeds, two different sets of content hashes, in one
     organisation. The canary's worst hour was a pass that held one
     generation's fixture and advanced another workflow with it, and every
     task in that one failed with "no material came back". */
  const older = buildWorld({ client, organizationId, seed: "runner/material-older", scripts: slowScripts(150) });
  const newer = buildWorld({ client, organizationId, seed: "runner/material-newer", scripts: slowScripts(150) });

  const olderHashes = new Set([...older.truth.material.keys()]);
  const newerHashes = new Set([...newer.truth.material.keys()]);
  t.check("the two worlds genuinely hold different material",
    [...olderHashes].every((h) => !newerHashes.has(h)) && olderHashes.size > 0,
    `${olderHashes.size} vs ${newerHashes.size}`);

  const a = await startWorkflow({ client, organizationId, truth: older.truth, pack: older.pack });
  const b = await startWorkflow({ client, organizationId, truth: newer.truth, pack: newer.pack });
  t.check("they are two different workflows", a.workflowId !== b.workflowId);

  /* Each runner is built with ITS OWN world and nothing else. A runner that
     claimed the other's workflow would be resolving material by a hash it has
     never heard of, and every task would fail. */
  for (let i = 0; i < 30; i++) {
    const left = await runnerPass({ client, name: `older-${i}`, world: older.world, store: a.store, life: SHORT_LIFE });
    const right = await runnerPass({ client, name: `newer-${i}`, world: newer.world, store: b.store, life: SHORT_LIFE });
    if (!left.claimed && !right.claimed) break;
    await sleep(120);
  }

  const refusedMaterial = (await client.query(
    `select count(*)::text as n from public.agent_attempts
      where workflow_id = any($1::uuid[]) and coalesce(error_code, '') = 'material_refused'`,
    [`{${a.workflowId},${b.workflowId}}`])).rows;
  t.check("no attempt in either workflow was handed the other's material",
    n(refusedMaterial) === 0, `${n(refusedMaterial)} material refusals`);

  for (const [label, id] of [["the older", a.workflowId], ["the newer", b.workflowId]]) {
    const segments = (await client.query(
      `select count(*)::text as n from public.source_segments where workflow_id = $1`, [id])).rows;
    t.check(`${label} workflow read its own sources`, n(segments) > 0, `${n(segments)} segments`);
  }
  const crossed = (await client.query(
    `select count(*)::text as n from public.workflow_sources s1
       join public.workflow_sources s2 on s1.content_hash = s2.content_hash and s1.workflow_id <> s2.workflow_id
      where s1.workflow_id = any($1::uuid[]) and s2.workflow_id = any($1::uuid[])`,
    [`{${a.workflowId},${b.workflowId}}`])).rows;
  t.check("and the two workflows share no source at all", n(crossed) === 0);
});

await withThrowawayDatabase(async ({ client, organizationId }) => {
  t.section("(10) the fuse itself: passes that move nothing stop being scheduled");
  /* The end-to-end poison case settles quickly because the engine escalates a
     failing workflow. This is the other half — the case where the engine
     neither finishes nor fails, and the runner would otherwise ask forever.
     Driven straight at the record, because the record is where the fuse is. */
  const { truth, pack } = buildWorld({ client, organizationId, seed: "runner/fuse" });
  const { workflowId, store } = await startWorkflow({ client, organizationId, truth, pack });
  const limits = await store.limits();
  t.check("the record states its own fuse", limits.maximumIdleStreak > 0 && limits.maximumContinuations > 0,
    JSON.stringify(limits));

  let settledAfter = null;
  let backoffs = [];
  for (let i = 1; i <= limits.maximumIdleStreak + 2; i++) {
    const hold = await store.claim(`fuse-${i}`, 60_000);
    if (!hold) { settledAfter = i - 1; break; }
    const released = await store.release({ workflowId, holdToken: hold.holdToken, moved: false });
    backoffs.push(released?.backoffMs ?? null);
    if (released?.state === "settled") { settledAfter = i; break; }
    /* The record asks to be left alone for a while; a test does not wait it
       out, it reschedules to now, which is what a watchdog would find. */
    await store.schedule(workflowId, new Date(Date.now() - 1000));
  }
  t.check("it settled itself at the limit the SQL states, not later",
    settledAfter === limits.maximumIdleStreak, `settled after ${settledAfter}, limit ${limits.maximumIdleStreak}`);
  const row = await store.read(workflowId);
  t.check("and it says the reason in words a person can act on",
    /no_progress/.test(row?.settledReason ?? ""), row?.settledReason ?? "");
  t.check("the backoff grew rather than hammering the record",
    backoffs.filter((b) => b !== null).every((b, i, xs) => i === 0 || b >= xs[i - 1]), backoffs.join(","));
  t.check("nothing is due for it any more", (await store.due(20)).includes(workflowId) === false);

  t.section("a hold is not writable by a runner that lost it");
  const { truth: t2, pack: p2 } = buildWorld({ client, organizationId, seed: "runner/fencing" });
  const second = await startWorkflow({ client, organizationId, truth: t2, pack: p2 });
  const mine = await second.store.claim("holder", 60_000);
  t.check("one runner holds it", mine !== null);
  const stolen = await second.store.release({
    workflowId: second.workflowId, holdToken: entityId("token", "not-the-one"), moved: true,
  });
  t.check("a release under the wrong token is refused, not silently applied", stolen === null);
  const still = await second.store.read(second.workflowId);
  t.check("and the real hold still stands", still?.state === "held" && still?.heldBy === "holder", String(still?.heldBy));
});

t.finish();
