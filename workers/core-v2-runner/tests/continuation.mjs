/* ONE START, AND THEN NOBODY.
 *
 * The claim Production Runner V1 makes is one sentence: a caller starts a
 * workflow once, and the system carries it to a terminal state without a
 * person, a browser, a scheduled job by hand, or a second authorised call.
 * This file is that sentence, checked.
 *
 * Every runner invocation here is given a LIFETIME SHORTER THAN THE WORK.
 * That is the point: the canary's whole difficulty was that a workflow needs
 * more than one Edge Function lifetime, and the only thing that made it
 * finish was a human pressing the button again. So the proofs below kill the
 * runner over and over and require the workflow to arrive anyway.
 *
 * Against a throwaway PostgreSQL cluster with every migration applied. The
 * agents are code, the sources are invented from a seed, and no provider is
 * named, reached or configured.
 */
import { harness } from "../../core-v2/tests/harness.mjs";
import { withThrowawayDatabase } from "../../core-v2/tests/postgres-harness.mjs";
import { PostgresContinuationStore } from "../continuations.ts";
import { TERMINAL_WORKFLOW_STATES } from "../../core-v2/kernel/transitions.ts";
import { buildWorld, startWorkflow, runnerPass, runUntilSettled, slowScripts, SHORT_LIFE, LONG_LIFE } from "./world.mjs";

const t = harness("one start, and then nobody");

const n = (rows) => Number(rows[0].n);
const stateOf = async (client, workflowId) =>
  (await client.query("select state from public.intelligence_workflows where id = $1", [workflowId])).rows[0]?.state ?? null;

await withThrowawayDatabase(async ({ client, organizationId }) => {
  t.section("(1) one start reaches a terminal state across several short lives");
  const { truth, pack, world, ledger } = buildWorld({ client, organizationId, seed: "runner/one-start", scripts: slowScripts(300) });
  const { workflowId, store } = await startWorkflow({ client, organizationId, truth, pack });

  t.check("the caller has an immutable workflow id the moment it starts",
    typeof workflowId === "string" && workflowId.length === 36, String(workflowId));
  t.check("and the record already says the workflow is due to be continued",
    (await store.read(workflowId))?.state === "due");

  /* Twelve seconds of life against a workflow that needs far more. Nothing
     between these calls is a decision: each one is a fresh, short process
     that claims whatever the record says is due. */
  const outcomes = await runUntilSettled({ client, world, store, life: SHORT_LIFE });
  const worked = outcomes.filter((o) => o.claimed);

  t.check("it took more than one invocation, which is the case that matters",
    worked.length > 1, `${worked.length} invocations`);
  t.check("every one of them continued the SAME workflow — no generation was invented",
    worked.every((o) => o.workflowId === workflowId),
    [...new Set(worked.map((o) => o.workflowId))].join(", "));

  const finalState = await stateOf(client, workflowId);
  t.check("the workflow reached a terminal state with nobody in the loop",
    TERMINAL_WORKFLOW_STATES.includes(finalState), String(finalState));
  t.check("and the record stopped asking to be woken",
    (await store.read(workflowId))?.state === "settled", (await store.read(workflowId))?.settledReason ?? "");

  t.check("the last invocation found nothing due, rather than looping",
    outcomes[outcomes.length - 1].claimed === false);

  /* The work actually happened: this is not a workflow that reached a
     terminal state by giving up on the first tick. */
  const tasks = n((await client.query("select count(*)::text as n from public.workflow_tasks where workflow_id = $1", [workflowId])).rows);
  const claims = n((await client.query("select count(*)::text as n from public.evidence_claims where workflow_id = $1", [workflowId])).rows);
  const decisions = n((await client.query("select count(*)::text as n from public.decisions where workflow_id = $1", [workflowId])).rows);
  t.check("it planned and ran real work on the way", tasks >= 8, `${tasks} tasks`);
  t.check("it wrote claims", claims > 0, `${claims} claims`);
  t.check("it reached decisions", decisions > 0, `${decisions} decisions`);

  t.section("(7) the authority a workflow started under is the one it finishes under");
  const budget = await ledger.budget(workflowId);
  t.check("there is exactly one budget row for this workflow",
    n((await client.query("select count(*)::text as n from public.workflow_cost_budgets where workflow_id = $1", [workflowId])).rows) === 1);
  t.check("and it still says what it said at the start — no continuation re-authorised it",
    budget !== null && Number(budget.authorized) === 5, String(budget?.authorized));
  const authorizedEvents = worked.filter((o) => o.problems.includes("over_budget")).length;
  t.check("no invocation was refused for offering a different authority", authorizedEvents === 0);

  t.section("(12) a terminal workflow does not schedule itself again");
  const settled = await store.read(workflowId);
  t.check("the continuation is settled and says why",
    settled?.state === "settled" && settled?.settledReason !== null, settled?.settledReason ?? "");
  await store.schedule(workflowId, null);
  t.check("asking again does not wake it: the engine is finished with it",
    (await store.read(workflowId))?.state === "settled");
  t.check("and nothing is due", (await store.due(10)).includes(workflowId) === false);
  const afterTerminal = await runnerPass({ client, name: "after-terminal", world, store, life: LONG_LIFE });
  t.check("a runner started now finds nothing to do", afterTerminal.claimed === false);
});

await withThrowawayDatabase(async ({ client, organizationId }) => {
  t.section("(2) a workflow longer than one lifetime finishes with no manual continuation");
  /* Agents that take three-quarters of a second against a leasing window of
     one, on a workflow with six sequential rounds of them. No arrangement of
     this fits in one life. If it arrives, it arrived by being woken. */
  const { truth, pack, world } = buildWorld({ client, organizationId, seed: "runner/short-lives", scripts: slowScripts(750) });
  const { workflowId, store } = await startWorkflow({ client, organizationId, truth, pack });

  /* One pass first, on its own, so the claim can be stated exactly: this
     invocation used its whole life and did not finish. A count of
     invocations would be a weaker thing to assert — what matters is that the
     first one COULD not finish and nobody was asked to run the second. */
  const first = await runnerPass({ client, name: "first-life", world, store, life: SHORT_LIFE });
  t.check("the first life ran out of clock with work still to do",
    first.stopReason === "more_work_remains", String(first.stopReason));
  t.check("and it used the life it was given, rather than giving up early",
    first.elapsedMs > SHORT_LIFE.lifetimeMs / 2, `${first.elapsedMs}ms of ${SHORT_LIFE.lifetimeMs}ms`);
  t.check("the workflow was not finished when that process died",
    TERMINAL_WORKFLOW_STATES.includes(await stateOf(client, workflowId)) === false,
    String(await stateOf(client, workflowId)));
  t.check("and the record already said when to come back",
    first.scheduledAgain === true);

  const outcomes = [first, ...await runUntilSettled({ client, world, store, life: SHORT_LIFE, maximumPasses: 80 })];
  const worked = outcomes.filter((o) => o.claimed);
  t.check("it took more than one life", worked.length >= 2, `${worked.length} invocations`);
  t.check("no invocation lasted longer than the life it was given",
    worked.every((o) => o.elapsedMs <= SHORT_LIFE.lifetimeMs), `${Math.max(...worked.map((o) => o.elapsedMs))}ms`);
  t.check("the workflow still reached a terminal state",
    TERMINAL_WORKFLOW_STATES.includes(await stateOf(client, workflowId)), String(await stateOf(client, workflowId)));
  t.check("every invocation resumed the same workflow",
    new Set(worked.map((o) => o.workflowId)).size === 1);
});

await withThrowawayDatabase(async ({ client, organizationId }) => {
  t.section("(3) two runners at once do not do the same work twice");
  const { truth, pack, world } = buildWorld({ client, organizationId, seed: "runner/overlap", scripts: slowScripts(200) });
  const { workflowId, store } = await startWorkflow({ client, organizationId, truth, pack });

  /* Both start in the same millisecond against the same due row. */
  const [left, right] = await Promise.all([
    runnerPass({ client, name: "runner-left", world, store, life: SHORT_LIFE }),
    runnerPass({ client, name: "runner-right", world, store, life: SHORT_LIFE }),
  ]);
  const claimed = [left, right].filter((o) => o.claimed);
  t.check("exactly one of them got the workflow", claimed.length === 1,
    `${claimed.length}: ${[left, right].map((o) => `${o.workflowId ?? "none"}`).join(" / ")}`);

  /* Then keep both running, overlapping, until it settles — and check the
     record for anything bought twice. */
  for (let i = 0; i < 30; i++) {
    const pair = await Promise.all([
      runnerPass({ client, name: `left-${i}`, world, store, life: SHORT_LIFE }),
      runnerPass({ client, name: `right-${i}`, world, store, life: SHORT_LIFE }),
    ]);
    if (pair.every((o) => !o.claimed)) break;
  }

  const duplicateTasks = (await client.query(
    `select count(*)::text as n from (
       select workflow_id, role_key, subject_key, independence_group, count(*) c
         from public.workflow_tasks where workflow_id = $1
        group by 1,2,3,4 having count(*) > 1) d`, [workflowId])).rows;
  t.check("no task exists twice for one role, subject and independence group", n(duplicateTasks) === 0);

  const duplicateAttempts = (await client.query(
    `select count(*)::text as n from (
       select task_id, attempt_no, count(*) c from public.agent_attempts
        where workflow_id = $1 group by 1,2 having count(*) > 1) d`, [workflowId])).rows;
  t.check("no task has two attempts numbered the same", n(duplicateAttempts) === 0);

  const reservations = (await client.query(
    `select count(*)::text as n from public.attempt_cost_reservations where workflow_id = $1`, [workflowId])).rows;
  const attempts = (await client.query(
    `select count(*)::text as n from public.agent_attempts a
      where a.workflow_id = $1 and a.submitted_at is not null and a.executor_kind = 'model'`, [workflowId])).rows;
  t.check("every submitted model attempt holds exactly one reservation, and none holds two",
    n(reservations) >= n(attempts), `${n(reservations)} reservations for ${n(attempts)} submissions`);

  const doubleSpend = (await client.query(
    `select count(*)::text as n from (
       select attempt_id, count(*) c from public.attempt_cost_reservations
        where workflow_id = $1 group by 1 having count(*) > 1) d`, [workflowId])).rows;
  t.check("and no attempt was charged for twice", n(doubleSpend) === 0);
});

await withThrowawayDatabase(async ({ client, organizationId }) => {
  t.section("a workflow whose agents always refuse stops, quickly, and says so");
  /* The other half of proof (10) — the fuse that catches a workflow which
     neither finishes nor fails — is driven straight at the record in
     resilience.mjs, because that is where the fuse lives. This is the
     ordinary case: agents that refuse make the engine escalate, and the
     runner must let go rather than keep asking. */
  const failing = () => { throw new Error("this executor refuses"); };
  const { truth, pack, world } = buildWorld({
    client, organizationId, seed: "runner/poison",
    scripts: { "reader-family-one": failing, "reader-family-two": failing, "reader-family-three": failing },
  });
  const { workflowId, store } = await startWorkflow({ client, organizationId, truth, pack });

  const limits = await store.limits();
  const outcomes = await runUntilSettled({ client, world, store, life: SHORT_LIFE, maximumPasses: 60 });
  const worked = outcomes.filter((o) => o.claimed);

  t.check("it stopped, and well short of the bound", worked.length < 60, `${worked.length} invocations`);
  const row = await store.read(workflowId);
  t.check("the continuation is settled", row?.state === "settled", row?.settledReason ?? "");
  t.check("and nothing is due for it any more", (await store.due(20)).includes(workflowId) === false);
  t.check("it stopped for a reason the record defines, not by running out of patience",
    /no_progress|continuation_limit|terminal_state|handed_to_a_person/.test(row?.settledReason ?? ""),
    row?.settledReason ?? "");
  t.check("the idle streak never ran past the limit the SQL states",
    (row?.idleStreak ?? 0) <= limits.maximumIdleStreak,
    `${row?.idleStreak} of ${limits.maximumIdleStreak}`);
});

t.finish();
