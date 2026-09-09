/* THE DURABLE BUDGET LEDGER, AGAINST A REAL DATABASE.
 *
 * Money is the one thing in this engine that cannot be made right afterwards.
 * A reservation that was optimistic has already been spent by the time the
 * truth arrives; a limit that only lived in a worker's memory was never a
 * limit at all. So every rule here is proved against a throwaway PostgreSQL
 * with migration 059 applied — the doors, the row invariant, the lock — and
 * never against a double.
 *
 * On sealing the network: the engine's guard closes `net` and the child
 * process doors along with everything else, and this test reaches a local
 * cluster over a unix socket started by a child process — so a process that
 * has sealed itself cannot run the database part at all, which is the same
 * difficulty workers/core-v2/tests/repository-contract.mjs records. Rather
 * than skip the seal, the last section runs in its own process that calls
 * closeNetwork() as its first statement and reports back: the part of the
 * ledger that must never reach anything — pricing, ceilings, and the refusal
 * of an unpriced model — is proved behind a closed network, and the guard's
 * count is asserted here.
 *
 * Nothing here names anything real. The answering systems are configuration
 * ids, the rates are invented, and the workflows read nothing.
 */
import { harness } from "../../core-v2/tests/harness.mjs";
import { spawnSync } from "node:child_process";
import { withThrowawayDatabase, ensureCluster, HARNESS_LOCATION } from "../../core-v2/tests/postgres-harness.mjs";
import { WireClient } from "../../core-v2/postgres/wire.ts";
import { entityId, sha256 } from "../../core-v2/kernel/ids.ts";
import { BudgetLedger, BudgetRefused, ceilingFor, isBudgetRefused } from "../budget/ledger.ts";
import { meteredRepository } from "../budget/metered.ts";
import { PostgresOrchestrationRepository } from "../../core-v2/postgres/repository.ts";
import { NO_PAID_CALLS, costCeiling, priceFor } from "../runtime-config.ts";
import { priceUsage } from "../budget/usage.ts";
import { normalizeUsage } from "../providers/usage-dialects.ts";

const t = harness("the durable budget ledger");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ────────────────────────────────────── the operator's configuration */

/* An answering system whose models do not exist, priced by an operator who
   does. The provider id is one of the three this runtime has billing rules
   for — a settlement has to know how that provider counts what it charges
   for, and a provider nobody has written rules for cannot be settled at all,
   which is checked in tests/billing.mjs. The MODELS are invented. */
const READER_IN = 200_000;   /* the input ceiling every request will carry */
const READER_OUT = 8_000;    /* the output ceiling every request will carry */

const CONFIG = {
  providers: [
    {
      providerId: "anthropic",
      baseUrl: "fixture://nothing/answers",
      apiKeyEnvironmentVariable: "CORE_V2_BUDGET_TESTS_KEY",
      models: ["reader-major", "reader-minor"],
      defaultModel: "reader-major",
      maximumInputTokens: READER_IN,
      maximumOutputTokens: READER_OUT,
      requestTimeoutMs: 30_000,
      maximumMaterialBytes: 65_536,
      maximumMaterialBytesPerItem: 65_536,
      supportedMediaTypes: ["text/plain; charset=utf-8"],
      capabilities: {
        "reader-major": { forcedToolChoice: true, strictSchema: true, images: false, thinking: "optional" },
        "reader-minor": { forcedToolChoice: true, strictSchema: true, images: false, thinking: "optional" },
      },
    },
  ],
  pricing: [
    { providerId: "anthropic", model: "reader-major", effectiveFrom: "2026-01-01", currency: "USD", inputPerMillionTokens: 3, outputPerMillionTokens: 15 },
    { providerId: "anthropic", model: "reader-minor", effectiveFrom: "2026-01-01", currency: "USD", inputPerMillionTokens: 5, outputPerMillionTokens: 25 },
  ],
  authorization: NO_PAID_CALLS,
  dispatcherName: "budget-ledger-contract",
};

const PER_MILLION = (tokens, rate) => (tokens / 1_000_000) * rate;
/* Six decimal places, which is the whole of the precision numeric(14,6) has
   and the whole of the precision the ledger claims. */
const round6 = (n) => Math.round(n * 1e6) / 1e6;
/* The number the reservation must equal, worked out here by hand from the
   configuration rather than read back from the thing under test. */
const CEILING_COST = round6(PER_MILLION(READER_IN, 3) + PER_MILLION(READER_OUT, 15));

/* ────────────────────────────────────── a labelled refusal, with its reason */

async function refusedBecause(label, fn, needle) {
  try {
    await fn();
    t.check(label, false, "the call was allowed");
  } catch (error) {
    const typed = isBudgetRefused(error);
    const said = String((typed ? error.reason : error?.message) ?? error);
    const right = typed && said.toLowerCase().includes(needle.toLowerCase());
    t.check(label, right, `${typed ? "BudgetRefused" : (error?.name ?? "Error")}: ${said.slice(0, 130)}`);
  }
}

/* ────────────────────────────────────── the records the ledger holds against */

const WORKFLOW_BUDGET = JSON.stringify({
  maximum_tasks: 50, maximum_dependency_edges: 100, maximum_child_tasks_per_parent: 4,
  maximum_follow_up_depth: 3, maximum_critic_rounds: 2, maximum_arbiter_rounds: 2,
});

function scaffolding(client, organizationId) {
  const workflowId = (key) => entityId("workflow", "budget", key);

  async function workflow(key) {
    const id = workflowId(key);
    await client.query(
      `insert into public.intelligence_workflows(id, organization_id, domain_pack, domain_pack_version, workflow_type,
         engine_version, state, source_set_fingerprint, request_fingerprint, requested_scope, budget)
       values ($1, $2, 'synthetic', '1', 'ledger-exercise', 'core-v2', 'created', $3, $4, '{}'::jsonb, $5::jsonb)`,
      [id, organizationId, sha256(`sources:${key}`), sha256(`request:${key}`), WORKFLOW_BUDGET]);
    return id;
  }

  /* One task, one prepared attempt of it. A prepared attempt is what a
     reservation is taken for; nothing has been sent. */
  async function attempt(workflowIdValue, key) {
    const taskId = entityId("task", workflowIdValue, key);
    const attemptId = entityId("attempt", workflowIdValue, key);
    await client.query(
      `insert into public.workflow_tasks(id, organization_id, workflow_id, phase, task_type, role_key, role_version,
         subject_key, input_fingerprint, contract_version, state, max_claims)
       values ($1, $2, $3, 'analyze', 'synthetic:read', 'reader', '1', $4, $5, 'c1', 'created', 10)`,
      [taskId, organizationId, workflowIdValue, `subject:${key}`, sha256(`input:${key}`)]);
    await client.query(
      `insert into public.agent_attempts(id, organization_id, workflow_id, task_id, attempt_no, role_key, role_version,
         executor_kind, executor_family, independence_domain, packet_fingerprint, packet_bytes, state)
       values ($1, $2, $3, $4, 1, 'reader', '1', 'model', 'family-one', 'domain-one', $5, 100, 'prepared')`,
      [attemptId, organizationId, workflowIdValue, taskId, sha256(`packet:${key}`)]);
    return { taskId, attemptId };
  }

  /* The real door: queue the task, lease it, run it, submit through
     core_v2_submit_attempt, which is the only move from prepared to sent. */
  async function submit(handle) {
    await client.query(`select * from public.core_v2_task_transition($1, 'queued', null, 'created')`, [handle.taskId]);
    const leased = await client.query(`select lease_token from public.core_v2_lease_task($1, $2, $3::int)`, [handle.taskId, "budget-contract", 60_000]);
    const token = leased.rows[0]?.lease_token;
    if (!token) throw new Error(`the harness could not lease task ${handle.taskId}`);
    await client.query(`select * from public.core_v2_task_transition($1, 'running', null, 'leased')`, [handle.taskId]);
    await client.query(`select * from public.core_v2_submit_attempt($1, $2)`, [handle.attemptId, token]);
    return token;
  }

  const goUnknown = (handle) =>
    client.query(`select * from public.core_v2_attempt_transition($1, 'outcome_unknown', null, null, null::jsonb, 'submitted')`, [handle.attemptId]);

  const reconcileNeverStarted = (handle) =>
    client.query(`update public.agent_attempts set reconciliation_outcome = 'never_started' where id = $1`, [handle.attemptId]);

  return { workflow, attempt, submit, goUnknown, reconcileNeverStarted };
}

/* ═════════════════════════════════════════════════════════ the run */

await withThrowawayDatabase(async ({ client, organizationId, databaseName }) => {
  const led = new BudgetLedger(client, CONFIG);
  const build = scaffolding(client, organizationId);
  const generous = (workflowId, over = {}) => led.authorizeWorkflow({
    workflowId, organizationId, currency: "USD", authorizedMaximum: 5, maximumPerAttempt: 5, ...over,
  });
  const fullCeiling = ceilingFor(CONFIG, "anthropic", "reader-major");

  /* ─────────────────────────────────────────────────────────────────── */
  t.section("a price is the operator's, and without one there is no ceiling");

  {
    const unpriced = priceFor(CONFIG, "anthropic", "reader-unlisted");
    t.check("a model the operator never priced has no price at all", unpriced === null);
    t.check("a model with no price has no ceiling, so there is no number to reserve",
      ceilingFor(CONFIG, "anthropic", "reader-unlisted") === null);

    const wf = await build.workflow("unpriced");
    await generous(wf);
    const a = await build.attempt(wf, "unpriced-1");
    await refusedBecause("an attempt whose model the operator never priced cannot be reserved for, and therefore cannot be sent",
      () => led.reserve(a.attemptId, ceilingFor(CONFIG, "anthropic", "reader-unlisted")), "no ceiling");
    t.check("the refusal left no hold behind: an unpriced attempt reserved nothing",
      (await led.reservationOf(a.attemptId)) === null);
    t.check("and the workflow is holding nothing", (await led.held(wf)) === 0);
  }

  /* ─────────────────────────────────────────────────────────────────── */
  t.section("the hold is the most it could cost, not what it is expected to cost");

  {
    const wf = await build.workflow("ceiling");
    await generous(wf);
    const a = await build.attempt(wf, "ceiling-1");

    t.check("the ceiling is the ceilings the request will carry, priced at the operator's own rates",
      fullCeiling !== null && fullCeiling.maximumCost === CEILING_COST,
      `${fullCeiling?.maximumCost} = ${READER_IN}×3/1e6 + ${READER_OUT}×15/1e6 = ${CEILING_COST}`);

    const held = await led.reserve(a.attemptId, fullCeiling);
    t.check("the reservation holds exactly that number", held.reservedCost === CEILING_COST, `held ${held.reservedCost}`);
    t.check("and it holds the token ceilings it was priced from",
      held.reservedInputTokens === READER_IN && held.reservedOutputTokens === READER_OUT);

    /* What this attempt would in fact use, if it behaved like the others. */
    const expectation = priceUsage(
      { currency: "USD", inputPerMillionTokens: 3, outputPerMillionTokens: 15, cachedInputPerMillionTokens: null, cacheWritePerMillionTokens: null, reasoningPerMillionTokens: null },
      normalizeUsage("anthropic", { input_tokens: 1200, output_tokens: 300 }),
    ).cost;
    t.check("what the attempt is expected to cost is a small fraction of what is held — an expectation is not a reservation",
      held.reservedCost > expectation * 50, `held ${held.reservedCost}, expected ${expectation}`);

    const standing = await led.standing(wf);
    t.check("the money moved from unauthorised-to-spend into held, and nothing is spent yet",
      standing.authorized === 5 && standing.held === CEILING_COST && standing.spent === 0);
    t.check("what remains is what was authorised minus what is held", standing.remaining === round6(5 - CEILING_COST));

    const again = await led.reserve(a.attemptId, fullCeiling);
    t.check("asking twice for one attempt is the same hold, not a second one",
      again.reservedCost === CEILING_COST && (await led.held(wf)) === CEILING_COST);

    t.check("the reservation records the price it was taken under, so a price that changes mid-run cannot change what this cost",
      held.priceBasis?.input_per_million_tokens === 3 && held.priceBasis?.output_per_million_tokens === 15 && held.priceBasis?.effective_from.startsWith("2026-01-01"));
  }

  /* ─────────────────────────────────────────────────────────────────── */
  t.section("a reservation is taken before anything is sent");

  {
    const wf = await build.workflow("ordering");
    await generous(wf);

    const before = await build.attempt(wf, "ordering-1");
    const reserved = await led.reserve(before.attemptId, fullCeiling);
    t.check("an attempt still prepared — nothing sent — is what a reservation is taken for", reserved.state === "reserved");

    const sent = await build.attempt(wf, "ordering-2");
    await build.submit(sent);
    await refusedBecause("an attempt that has already been sent cannot be reserved for afterwards: the money was committed before the hold",
      () => led.reserve(sent.attemptId, fullCeiling), "a reservation is taken before anything is sent");

    await refusedBecause("an attempt that does not exist reserves nothing",
      () => led.reserve(entityId("attempt", "budget", "no-such"), fullCeiling), "no attempt");

    const orphan = await build.workflow("unauthorised");
    const o = await build.attempt(orphan, "unauthorised-1");
    await refusedBecause("a workflow nobody authorised a budget for may send nothing that costs anything",
      () => led.reserve(o.attemptId, fullCeiling), "no authorised budget");
    t.check("and there is no budget row to read for it", (await led.standing(orphan)) === null);
  }

  /* ─────────────────────────────────────────────────────────────────── */
  t.section("every ceiling refuses on its own");

  {
    const wf = await build.workflow("limit-global");
    await led.authorizeWorkflow({ workflowId: wf, organizationId, authorizedMaximum: 0.5, maximumPerAttempt: 5 });
    const a = await build.attempt(wf, "limit-global-1");
    await refusedBecause("the global workflow limit refuses a hold that would take the run past what was authorised",
      () => led.reserve(a.attemptId, fullCeiling), "was authorised");
  }
  {
    const wf = await build.workflow("limit-attempt");
    await led.authorizeWorkflow({ workflowId: wf, organizationId, authorizedMaximum: 5, maximumPerAttempt: 0.5 });
    const a = await build.attempt(wf, "limit-attempt-1");
    await refusedBecause("the per-attempt limit refuses one expensive attempt however much the workflow has left",
      () => led.reserve(a.attemptId, fullCeiling), "allows one attempt");
  }
  {
    const wf = await build.workflow("limit-input");
    await led.authorizeWorkflow({ workflowId: wf, organizationId, authorizedMaximum: 5, maximumPerAttempt: 5, maximumInputTokens: 1000 });
    const a = await build.attempt(wf, "limit-input-1");
    await refusedBecause("the input-token ceiling refuses on tokens alone, with money still to spare",
      () => led.reserve(a.attemptId, fullCeiling), "input tokens");
  }
  {
    const wf = await build.workflow("limit-output");
    await led.authorizeWorkflow({ workflowId: wf, organizationId, authorizedMaximum: 5, maximumPerAttempt: 5, maximumOutputTokens: 100 });
    const a = await build.attempt(wf, "limit-output-1");
    await refusedBecause("the output-token ceiling refuses on tokens alone, and independently of the input one",
      () => led.reserve(a.attemptId, fullCeiling), "output tokens");
  }
  {
    const wf = await build.workflow("limit-count");
    await led.authorizeWorkflow({ workflowId: wf, organizationId, authorizedMaximum: 5, maximumPerAttempt: 5, maximumAttempts: 1 });
    const first = await build.attempt(wf, "limit-count-1");
    const second = await build.attempt(wf, "limit-count-2");
    await led.reserve(first.attemptId, fullCeiling);
    await led.release(first.attemptId, "the first attempt was never sent");
    await refusedBecause("the task-count limit counts every attempt the run ever reserved for, including one already given back",
      () => led.reserve(second.attemptId, fullCeiling), "authorised attempts");
  }
  {
    const wf = await build.workflow("limit-flight");
    await led.authorizeWorkflow({ workflowId: wf, organizationId, authorizedMaximum: 5, maximumPerAttempt: 5, maximumConcurrentAttempts: 1 });
    const first = await build.attempt(wf, "limit-flight-1");
    const second = await build.attempt(wf, "limit-flight-2");
    await led.reserve(first.attemptId, fullCeiling);
    await refusedBecause("the concurrency limit refuses a second attempt while the first may still be running",
      () => led.reserve(second.attemptId, fullCeiling), "in flight");
    await led.release(first.attemptId, "the first attempt was never sent");
    const third = await led.reserve(second.attemptId, fullCeiling);
    t.check("and lets the next one through once the first is known not to be running", third.state === "reserved");
  }
  {
    const wf = await build.workflow("limit-clock");
    await led.authorizeWorkflow({
      workflowId: wf, organizationId, authorizedMaximum: 5, maximumPerAttempt: 5,
      wallClockDeadline: new Date(Date.now() - 60_000),
    });
    const a = await build.attempt(wf, "limit-clock-1");
    const b = await build.attempt(wf, "limit-clock-2");
    await refusedBecause("the wall-clock limit refuses once the authorised time has run out, with money still authorised",
      () => led.reserve(a.attemptId, fullCeiling), "ran out");
    const stopped = await led.budget(wf);
    /* The door writes a stop and then raises, and the raise takes its own
       write with it. So the deadline is re-read every time rather than
       recorded — worth knowing, because a reader of the budget row cannot
       tell from it that the clock is what is refusing. */
    t.check("the stop that refusal tries to record is rolled back by the refusal itself, so the row still says nothing about why",
      stopped.stoppedAt === null && stopped.stoppedReason === null);
    await refusedBecause("and the deadline refuses the attempt after it just the same, from the clock rather than from the row",
      () => led.reserve(b.attemptId, fullCeiling), "ran out");
  }

  /* ─────────────────────────────────────────────────────────────────── */
  t.section("two dispatchers, one budget, at the same moment");

  {
    const wf = await build.workflow("race");
    /* Room for one hold of the full ceiling, and not for two. */
    await led.authorizeWorkflow({ workflowId: wf, organizationId, authorizedMaximum: 1, maximumPerAttempt: 1 });
    const one = await build.attempt(wf, "race-1");
    const two = await build.attempt(wf, "race-2");

    const { socketPath } = await ensureCluster();
    const other = await WireClient.connect({ socketPath, user: HARNESS_LOCATION.user, database: databaseName, applicationName: "budget-contract-b" });
    try {
      let opened;
      const openedGate = new Promise((resolve) => { opened = resolve; });
      let letGo;
      const firstHolds = new Promise((resolve) => { letGo = resolve; });

      /* Dispatcher A reserves inside a transaction and keeps it open, which
         is exactly the window in which a careless engine reads a stale
         budget and hands out room that is already gone. */
      const firstDone = client.transaction(async (tx) => {
        const mine = new BudgetLedger(tx, CONFIG);
        const got = await mine.reserve(one.attemptId, fullCeiling);
        opened(got);
        await firstHolds;
        return got;
      });
      const firstGrant = await openedGate;

      /* Dispatcher B, on its own connection to the same database. */
      const secondCall = new BudgetLedger(other, CONFIG).reserve(two.attemptId, fullCeiling);
      const secondOutcome = secondCall.then((granted) => ({ granted }), (error) => ({ error }));
      const whileHeld = await Promise.race([secondOutcome.then(() => "answered"), sleep(300).then(() => "waiting")]);
      t.check("the second dispatcher waits on the budget row rather than reading a total the first has already changed",
        whileHeld === "waiting", `after 300ms the second call was ${whileHeld}`);

      letGo();
      await firstDone;
      const second = await secondOutcome;

      t.check("exactly one of the two concurrent reservations was granted",
        Boolean(firstGrant) && second.error !== undefined);
      t.check("and the loser was refused with a reason a dispatcher can act on, not a silent false",
        second.error instanceof BudgetRefused && /authorised/.test(second.error.reason),
        second.error?.reason?.slice(0, 130) ?? "no refusal");

      const after = await led.standing(wf);
      t.check("the sum of what was granted never exceeded what was authorised",
        after.held + after.spent <= after.authorized, `held ${after.held} + spent ${after.spent} ≤ authorised ${after.authorized}`);
      t.check("and the whole of what was granted is the one hold that won",
        after.held === CEILING_COST && (await led.openReservations(wf)).length === 1,
        `held ${after.held} across ${(await led.openReservations(wf)).length} open reservation(s)`);
    } finally {
      await other.end().catch(() => {});
    }
  }

  /* ─────────────────────────────────────────────────────────────────── */
  t.section("settlement moves held money to spent, at what was reported");

  {
    const wf = await build.workflow("settle");
    await generous(wf);
    const a = await build.attempt(wf, "settle-1");
    await led.reserve(a.attemptId, fullCeiling);
    await build.submit(a);

    const usage = { input_tokens: 1200, output_tokens: 300 };
    const byHand = PER_MILLION(1200, 3) + PER_MILLION(300, 15);
    const settledRow = await led.settle(a.attemptId, usage);
    t.check("what it cost is the counts the answering system reported, at the operator's rates",
      settledRow.settledCost === Math.round(byHand * 1e6) / 1e6, `${settledRow.settledCost} = ${byHand}`);
    t.check("the hold came off and the money moved to spent in one move",
      (await led.held(wf)) === 0 && (await led.spent(wf)) === settledRow.settledCost);
    t.check("the reported counts are kept beside the number, so a dispute is settled from what arrived",
      settledRow.usage?.input_tokens === 1200 && settledRow.usage?.output_tokens === 300);

    const twice = await led.settle(a.attemptId, { input_tokens: 999_999 });
    t.check("settling twice is the same settlement, not a second charge",
      twice.settledCost === settledRow.settledCost && (await led.spent(wf)) === settledRow.settledCost);

    await refusedBecause("a settled attempt is not released afterwards: its money is gone, not held",
      () => led.release(a.attemptId, "changed my mind"), "was settled");

    t.check("the components it was priced from are kept beside the raw counts, under the version of the rules that produced them",
      settledRow.normalizedUsage?.uncached_input_tokens === 1200
      && settledRow.normalizedUsage?.visible_output_tokens === 300
      && typeof settledRow.normalizationVersion === "string" && settledRow.normalizationVersion.length > 0,
      JSON.stringify(settledRow.normalizedUsage));

    /* THE CASE THAT USED TO SETTLE AT ZERO. A provider that reports no counts
       has not told anybody that the call was free; it has told nobody
       anything. */
    const quiet = await build.attempt(wf, "settle-2");
    await led.reserve(quiet.attemptId, fullCeiling);
    await build.submit(quiet);
    await refusedBecause("a provider that reported no counts is NOT settled at zero — what it cost is not known",
      () => led.settle(quiet.attemptId, {}), "cannot be worked out");
    t.check("its hold stands rather than coming off on a guess",
      (await led.reservationOf(quiet.attemptId)).state === "reserved" && (await led.held(wf)) === CEILING_COST,
      `held ${await led.held(wf)}`);
    const flagged = await led.flagForAttention(quiet.attemptId, "the provider reported no usage at all");
    t.check("and it can be marked for somebody, still holding, with the reason on the row",
      flagged.state === "reserved" && flagged.attentionReason === "the provider reported no usage at all"
      && (await led.held(wf)) === CEILING_COST, JSON.stringify({ state: flagged.state, reason: flagged.attentionReason }));
    t.check("a genuine zero — a provider that says it used nothing — does settle, and settles at nothing",
      (await led.settle(quiet.attemptId, { input_tokens: 0, output_tokens: 0 })).settledCost === 0);
    t.check("and settling clears what it was waiting for",
      (await led.reservationOf(quiet.attemptId)).attentionReason === null);

    await refusedBecause("an attempt that reserved nothing cannot be settled",
      () => led.settle(entityId("attempt", "budget", "never-reserved"), { input_tokens: 1 }), "reserved nothing");
  }

  /* ─────────────────────────────────────────────────────────────────── */
  t.section("an answer that cost more than was held");

  {
    const wf = await build.workflow("overrun");
    await led.authorizeWorkflow({ workflowId: wf, organizationId, authorizedMaximum: 1, maximumPerAttempt: 1 });
    const a = await build.attempt(wf, "overrun-1");
    /* A deliberately small hold: 2000 in and 400 out at the minor rates. */
    const small = costCeiling(CONFIG, "anthropic", "reader-minor", 2000, 400);
    const heldRow = await led.reserve(a.attemptId, small);
    t.check("the small hold is what its own ceilings cost", heldRow.reservedCost === PER_MILLION(2000, 5) + PER_MILLION(400, 25));

    const real = await led.settle(a.attemptId, { input_tokens: 200_000, output_tokens: 0 });
    t.check("an answer that cost more than was held is recorded at what it cost, not at what was permitted",
      real.settledCost === PER_MILLION(200_000, 5) && real.settledCost > heldRow.reservedCost,
      `held ${heldRow.reservedCost}, spent ${real.settledCost}`);

    const after = await led.standing(wf);
    t.check("the hold came off in full and the whole real cost is on the run", after.held === 0 && after.spent === real.settledCost);
    t.check("and the run stopped itself, saying that the authorised amount is spent",
      after.stoppedReason !== null && /spent/.test(after.stoppedReason), after.stoppedReason ?? "no reason");

    const next = await build.attempt(wf, "overrun-2");
    await refusedBecause("an exhausted budget refuses the next reservation with the stop, not with an arithmetic near-miss",
      () => led.reserve(next.attemptId, small), "stopped");
  }

  /* ─────────────────────────────────────────────────────────────────── */
  t.section("a settlement beyond the whole authorisation");

  {
    const wf = await build.workflow("beyond");
    await led.authorizeWorkflow({ workflowId: wf, organizationId, authorizedMaximum: 1, maximumPerAttempt: 1 });
    const a = await build.attempt(wf, "beyond-1");
    const small = costCeiling(CONFIG, "anthropic", "reader-minor", 2000, 400);
    await led.reserve(a.attemptId, small);
    /* 400,000 input tokens at 5 per million is 2.00, against an authorisation
       of 1.00. A provider can bill more than it was asked to, and the record
       has to be able to say so: the ceiling is a gate on what goes out, not a
       claim about what came back. A settlement that could not be recorded
       would leave no trace of the money at all. */
    await led.settle(a.attemptId, { input_tokens: 400_000, output_tokens: 0 });
    const after = await led.standing(wf);
    t.check("a bill larger than the whole authorisation is recorded at what it cost, not refused into silence",
      after.spent === PER_MILLION(400_000, 5) && after.spent > after.authorized,
      `spent ${after.spent} against an authorisation of ${after.authorized}`);
    t.check("and the hold it was taken against comes off, because that attempt is finished",
      after.held === 0, `held ${after.held}`);
    t.check("spending on the workflow then stops, so nothing further is sent",
      after.stoppedReason !== null && after.stoppedAt !== null, after.stoppedReason ?? "not stopped");
    const b = await build.attempt(wf, "beyond-2");
    await refusedBecause("and the next reservation is refused for that reason",
      () => led.reserve(b.attemptId, costCeiling(CONFIG, "anthropic", "reader-minor", 10, 10)), "stopped");
  }

  /* ─────────────────────────────────────────────────────────────────── */
  t.section("a settlement is priced from the reservation, not from the configuration as it stands now");

  {
    const wf = await build.workflow("frozen-price");
    await generous(wf);
    const a = await build.attempt(wf, "frozen-1");
    const held = await led.reserve(a.attemptId, fullCeiling);
    await build.submit(a);
    t.check("the rates were copied onto the reservation when the hold was taken",
      held.priceBasis.input_per_million_tokens === 3 && held.priceBasis.output_per_million_tokens === 15
      && held.priceBasis.currency === "USD", JSON.stringify(held.priceBasis));

    /* The operator changes everything: a hundred times the price, and then
       the model removed from the configuration altogether. */
    const dearer = {
      ...CONFIG,
      pricing: [{ providerId: "anthropic", model: "reader-major", effectiveFrom: "2026-01-01", currency: "USD", inputPerMillionTokens: 300, outputPerMillionTokens: 1500 }],
    };
    const settledDearer = await new BudgetLedger(client, dearer).settle(a.attemptId, { input_tokens: 1200, output_tokens: 300 });
    t.check("a price that changed after the hold was taken does not change what that attempt cost",
      settledDearer.settledCost === round6(PER_MILLION(1200, 3) + PER_MILLION(300, 15)), `${settledDearer.settledCost}`);

    const gone = await build.attempt(wf, "frozen-2");
    await led.reserve(gone.attemptId, fullCeiling);
    await build.submit(gone);
    const emptied = { ...CONFIG, providers: [], pricing: [] };
    const settledAnyway = await new BudgetLedger(client, emptied).settle(gone.attemptId, { input_tokens: 1200, output_tokens: 300 });
    t.check("and a model REMOVED from the configuration entirely can still be settled — the price it was reserved under is on the row",
      settledAnyway.settledCost === round6(PER_MILLION(1200, 3) + PER_MILLION(300, 15)), `${settledAnyway.settledCost}`);
    t.check("which means an attempt cannot be left unsettleable by an edit somebody made afterwards",
      settledAnyway.state === "settled" && settledAnyway.normalizedUsage !== null);
  }

  /* ─────────────────────────────────────────────────────────────────── */
  t.section("a price in one currency and a budget in another is not a comparison");

  {
    const wf = await build.workflow("currency");
    await led.authorizeWorkflow({ workflowId: wf, organizationId, currency: "USD", authorizedMaximum: 5, maximumPerAttempt: 5 });
    const a = await build.attempt(wf, "currency-1");
    const elsewhere = {
      ...CONFIG,
      pricing: [{ providerId: "anthropic", model: "reader-major", effectiveFrom: "2026-01-01", currency: "EUR", inputPerMillionTokens: 3, outputPerMillionTokens: 15 }],
    };
    const ceiling = ceilingFor(elsewhere, "anthropic", "reader-major");
    t.check("the ceiling carries the currency the operator priced it in", ceiling.currency === "EUR");
    await refusedBecause("an attempt priced in one currency cannot be reserved against a budget authorised in another",
      () => new BudgetLedger(client, elsewhere).reserve(a.attemptId, ceiling), "authorised in");
    t.check("and nothing was held for it", (await led.reservationOf(a.attemptId)) === null && (await led.held(wf)) === 0);
  }

  /* ─────────────────────────────────────────────────────────────────── */
  t.section("the hold comes off only when nothing can still be running");

  {
    const wf = await build.workflow("release");
    await generous(wf);

    const never = await build.attempt(wf, "release-1");
    await led.reserve(never.attemptId, fullCeiling);
    const back = await led.release(never.attemptId, "the packet was rejected before it was sent");
    t.check("an attempt that was never sent gets its hold back, with the reason recorded",
      back.state === "released" && back.releaseReason === "the packet was rejected before it was sent" && (await led.held(wf)) === 0);
    const twice = await led.release(never.attemptId, "asking again");
    t.check("releasing twice is the same release, and the first reason stands",
      twice.state === "released" && twice.releaseReason === "the packet was rejected before it was sent");

    const noReason = await build.attempt(wf, "release-2");
    await led.reserve(noReason.attemptId, fullCeiling);
    await refusedBecause("a release says why, or it is not a release", () => led.release(noReason.attemptId, "   "), "says why");

    const sent = await build.attempt(wf, "release-3");
    await led.reserve(sent.attemptId, fullCeiling);
    await build.submit(sent);
    await refusedBecause("an attempt that was sent is settled at what it cost, never released — the money may already be gone",
      () => led.release(sent.attemptId, "it looked like it failed"), "was sent");

    const unknown = await build.attempt(wf, "release-4");
    await led.reserve(unknown.attemptId, fullCeiling);
    await build.submit(unknown);
    await build.goUnknown(unknown);
    await refusedBecause("an attempt whose outcome nobody knows keeps holding until somebody knows",
      () => led.release(unknown.attemptId, "it has been quiet for a while"), "nobody knows");
    t.check("its hold is still on the workflow while nobody knows",
      (await led.held(wf)) === round6(CEILING_COST * 3), `held ${await led.held(wf)}`);

    await build.reconcileNeverStarted(unknown);
    const reconciled = await led.release(unknown.attemptId, "the executor says it never started");
    t.check("once an executor says it never started, the hold comes back",
      reconciled.state === "released" && (await led.held(wf)) === round6(CEILING_COST * 2),
      `held ${await led.held(wf)}`);

    await refusedBecause("an attempt that reserved nothing has nothing to release",
      () => led.release(entityId("attempt", "budget", "no-hold"), "tidying up"), "reserved nothing");
  }

  /* ═══════════════════════════════════════════════════════════════════
     THE HOLD AND THE SUBMISSION ARE ONE THING, OR NEITHER HAPPENED.

     The reservation used to be taken first and the submission attempted
     afterwards: two units of work with a window between them. Every refusal
     the submission itself makes lands in that window — an expired lease, a
     cancellation, an attempt somebody else already sent — and so does a
     process dying. What came out of the window was a durable hold against an
     attempt that was never sent: money the run cannot use and nobody can
     account for.

     Now the reservation rides inside the submission's own transaction. What
     follows walks every way a submission can be refused and, after each one,
     asks the two questions that matter: is there a new reservation, and has
     the workflow's held total moved. The answer to both must be no. */

  t.section("a hold and a submission are one thing, or neither of them happened");

  {
    const events = [];
    const recordOn = (connection) => meteredRepository(
      new PostgresOrchestrationRepository(connection, { organizationId }),
      {
        ledger: new BudgetLedger(connection, CONFIG),
        config: CONFIG,
        providerOfFamily: (family) => (family === "family-one" ? "anthropic" : null),
        events: (event) => events.push(event),
      },
    );
    const record = recordOn(client);

    /* Queue, lease and run a task without submitting its attempt, which is
       exactly the state the engine is in at the moment money would move. */
    async function readyToSend(workflowIdValue, key, ttlMs = 60_000) {
      const handle = await build.attempt(workflowIdValue, key);
      await client.query(`select * from public.core_v2_task_transition($1, 'queued', null, 'created')`, [handle.taskId]);
      const leased = await client.query(`select lease_token from public.core_v2_lease_task($1, $2, $3::int)`,
        [handle.taskId, "atomic-boundary", ttlMs]);
      await client.query(`select * from public.core_v2_task_transition($1, 'running', null, 'leased')`, [handle.taskId]);
      return { ...handle, token: leased.rows[0].lease_token };
    }

    const reservationsFor = async (workflowIdValue) =>
      Number((await client.query(`select count(*) as n from public.attempt_cost_reservations where workflow_id = $1`, [workflowIdValue])).rows[0].n);
    const stateOf = async (attemptId) =>
      (await client.query(`select state from public.agent_attempts where id = $1`, [attemptId])).rows[0].state;

    /* ── the one case where money does move ── */
    {
      const wf = await build.workflow("atomic-ok");
      await generous(wf);
      const ready = await readyToSend(wf, "atomic-ok-1");
      const outcome = await record.submitAttempt(ready.attemptId, ready.token, Date.now());
      t.check("a submission that is allowed is allowed, and the attempt is sent",
        outcome.ok === true && (await stateOf(ready.attemptId)) === "submitted", JSON.stringify(outcome).slice(0, 90));
      t.check("and it left EXACTLY ONE reservation behind — not none, and not two",
        (await reservationsFor(wf)) === 1, `${await reservationsFor(wf)} reservations`);
      t.check("holding the ceiling the request will carry",
        (await led.held(wf)) === CEILING_COST, `held ${await led.held(wf)}`);
      t.check("and the run said so, once", events.filter((e) => e.event === "budget.reserved").length === 1);
    }

    /* ── every way it is refused, and the same two questions after each ── */
    const refusals = [
      ["the lease token is somebody else's", async (wf) => {
        const ready = await readyToSend(wf, "atomic-wrong-token");
        return { ready, call: () => record.submitAttempt(ready.attemptId, entityId("lease", wf, "not-mine"), Date.now()) };
      }, /lease/],
      ["the lease has run out", async (wf) => {
        const ready = await readyToSend(wf, "atomic-expired", 1);
        await sleep(30);
        return { ready, call: () => record.submitAttempt(ready.attemptId, ready.token, Date.now()) };
      }, /lease/],
      ["somebody asked for the run to be cancelled", async (wf) => {
        const ready = await readyToSend(wf, "atomic-cancelled");
        await client.query(`update public.intelligence_workflows set cancel_requested_at = now() where id = $1`, [wf]);
        return { ready, call: () => record.submitAttempt(ready.attemptId, ready.token, Date.now()) };
      }, /cancel/i],
      ["the attempt is not prepared any more", async (wf) => {
        const ready = await readyToSend(wf, "atomic-stale");
        /* Sent already, through the door, by somebody else. */
        await client.query(`select * from public.core_v2_submit_attempt($1, $2)`, [ready.attemptId, ready.token]);
        return { ready, call: () => record.submitAttempt(ready.attemptId, ready.token, Date.now()), expectReservations: 0 };
      }, /attempt is/],
      ["the task is no longer running", async (wf) => {
        const ready = await readyToSend(wf, "atomic-not-running");
        await client.query(`select * from public.core_v2_task_transition($1, 'cancelled', 'a person stopped it', 'running')`, [ready.taskId]);
        return { ready, call: () => record.submitAttempt(ready.attemptId, ready.token, Date.now()) };
      }, /task is/],
    ];

    for (const [what, arrange, reason] of refusals) {
      const wf = await build.workflow(`atomic-${what.replace(/[^a-z]+/gi, "-")}`);
      await generous(wf);
      const before = await led.held(wf);
      const { ready, call, expectReservations = 0 } = await arrange(wf);
      const outcome = await call();
      t.check(`${what}: the submission is refused, and says why`,
        outcome.ok === false && reason.test(outcome.reason), outcome.ok ? "IT WAS SENT" : outcome.reason.slice(0, 70));
      t.check(`${what}: NO reservation was left behind`,
        (await reservationsFor(wf)) === expectReservations, `${await reservationsFor(wf)} reservations`);
      t.check(`${what}: and the workflow is holding exactly what it held before`,
        (await led.held(wf)) === before, `held ${await led.held(wf)}, was ${before}`);
      t.check(`${what}: the attempt itself did not move`,
        (await stateOf(ready.attemptId)) === (expectReservations === 0 && what.includes("not prepared") ? "submitted" : "prepared"),
        await stateOf(ready.attemptId));
    }

    /* ── the budget itself refusing ── */
    {
      const wf = await build.workflow("atomic-broke");
      /* Authorised for less than one attempt could cost. */
      await led.authorizeWorkflow({ workflowId: wf, organizationId, currency: "USD", authorizedMaximum: 0.000001, maximumPerAttempt: 0.000001 });
      const ready = await readyToSend(wf, "atomic-broke-1");
      const outcome = await record.submitAttempt(ready.attemptId, ready.token, Date.now());
      t.check("a budget that refuses refuses the submission, not just the hold",
        outcome.ok === false && /budget refused/.test(outcome.reason), outcome.ok ? "IT WAS SENT" : outcome.reason.slice(0, 90));
      t.check("nothing was sent — the attempt is still prepared",
        (await stateOf(ready.attemptId)) === "prepared", await stateOf(ready.attemptId));
      t.check("and no hold was left behind by the refusal",
        (await reservationsFor(wf)) === 0 && (await led.held(wf)) === 0);
      t.check("the refusal was reported with the reason the database gave",
        events.some((e) => e.event === "budget.refused" && /more than the/.test(e.reason ?? "")),
        JSON.stringify(events.filter((e) => e.event === "budget.refused").slice(-1)).slice(0, 120));
    }

    /* ── the crash, which is the whole reason this is one transaction ── */
    {
      const wf = await build.workflow("atomic-crash");
      await generous(wf);
      const ready = await readyToSend(wf, "atomic-crash-1");
      const plain = new PostgresOrchestrationRepository(client, { organizationId });
      let died = null;
      try {
        await plain.submitAttempt(ready.attemptId, ready.token, Date.now(), async (unitOfWork) => {
          /* A real, durable hold — written on the submission's own unit of
             work, exactly as the metered record writes it. */
          await new BudgetLedger(unitOfWork, CONFIG).reserve(ready.attemptId, fullCeiling);
          throw new Error("the dispatcher died between the hold and the move");
        });
      } catch (error) { died = error; }
      t.check("a process that dies between the hold and the move takes the exception with it",
        died instanceof Error && /died between/.test(died.message), died?.message?.slice(0, 60));
      t.check("and the hold it had already written is gone, because it was never a hold on its own",
        (await reservationsFor(wf)) === 0 && (await led.held(wf)) === 0, `${await reservationsFor(wf)} reservations`);
      t.check("the attempt is still prepared, so the work can be tried again from a clean state",
        (await stateOf(ready.attemptId)) === "prepared", await stateOf(ready.attemptId));
    }

    /* ── two dispatchers, one attempt, at the same moment ── */
    {
      const wf = await build.workflow("atomic-race");
      await generous(wf);
      const ready = await readyToSend(wf, "atomic-race-1");
      const { socketPath } = await ensureCluster();
      const second = await WireClient.connect({ socketPath, user: HARNESS_LOCATION.user, database: databaseName, applicationName: "atomic-boundary-b" });
      try {
        const both = await Promise.all([
          record.submitAttempt(ready.attemptId, ready.token, Date.now()),
          recordOn(second).submitAttempt(ready.attemptId, ready.token, Date.now()),
        ]);
        const sent = both.filter((outcome) => outcome.ok).length;
        t.check("two dispatchers submitting one attempt at the same moment: exactly one of them sends it",
          sent === 1, `${sent} of 2 sent — ${JSON.stringify(both.map((o) => (o.ok ? "sent" : o.reason.slice(0, 40))))}`);
        t.check("and there is exactly one reservation, not two",
          (await reservationsFor(wf)) === 1, `${await reservationsFor(wf)} reservations`);
        t.check("so the workflow holds one ceiling, not two",
          (await led.held(wf)) === CEILING_COST, `held ${await led.held(wf)}`);
      } finally {
        await second.end();
      }
    }
  }

  /* ─────────────────────────────────────────────────────────────────── */
  t.section("stopping a run, and authorising one");

  {
    const wf = await build.workflow("stop");
    await generous(wf);
    const stopped = await led.stop(wf, "a person stopped this run");
    t.check("a spending stop records the reason and the moment",
      stopped.stoppedReason === "a person stopped this run" && stopped.stoppedAt !== null);
    const again = await led.stop(wf, "a second reason");
    t.check("stopping again keeps the first reason: why it stopped is decided once", again.stoppedReason === "a person stopped this run");
    const a = await build.attempt(wf, "stop-1");
    await refusedBecause("a stopped run reserves nothing further, and the refusal carries the reason it stopped",
      () => led.reserve(a.attemptId, fullCeiling), "a person stopped this run");
    await refusedBecause("a workflow with no authorised budget cannot be stopped either — there is nothing to stop",
      () => led.stop(entityId("workflow", "budget", "no-budget"), "tidying up"), "no authorised budget");
  }
  {
    const wf = await build.workflow("authorize");
    const first = await led.authorizeWorkflow({ workflowId: wf, organizationId, authorizedMaximum: 2, maximumPerAttempt: 1, maximumAttempts: 4 });
    t.check("an authorisation is the operator's numbers, written as given",
      first.authorized === 2 && first.maximumPerAttempt === 1 && first.maximumAttempts === 4 && first.currency === "USD");
    const same = await led.authorizeWorkflow({ workflowId: wf, organizationId, authorizedMaximum: 2, maximumPerAttempt: 1, maximumAttempts: 4 });
    t.check("authorising the same run with the same numbers is the same authorisation", same.authorized === 2);
    await refusedBecause("the engine never widens a budget it was given",
      () => led.authorizeWorkflow({ workflowId: wf, organizationId, authorizedMaximum: 500, maximumPerAttempt: 100 }), "already authorised");
    t.check("and the authorisation is still the one the operator gave", (await led.authorized(wf)) === 2);
    t.check("zero is a real authorisation: nothing that costs anything may be sent under it",
      (await led.authorizeWorkflow({ workflowId: await build.workflow("zero"), organizationId, authorizedMaximum: 0, maximumPerAttempt: 0 })).authorized === 0);
  }
});

/* ═════════════════════ what must never reach anything at all ═════════════ */

/* Its own process, because closeNetwork() also shuts the doors the throwaway
   cluster is started and stopped through. The first thing it does is close
   the network; then it exercises the part of the ledger that prices and
   refuses without a database at all, and prints what happened. */
t.section("the priced part of the ledger reaches nothing");

{
  const harnessUrl = new URL("../../core-v2/tests/harness.mjs", import.meta.url).href;
  const ledgerUrl = new URL("../budget/ledger.ts", import.meta.url).href;
  const source = `
import { closeNetwork } from ${JSON.stringify(harnessUrl)};
const tripped = closeNetwork();
const { BudgetLedger, ceilingFor, isBudgetRefused } = await import(${JSON.stringify(ledgerUrl)});
const config = ${JSON.stringify(CONFIG)};
const checks = [];
checks.push(["a provider id the operator never configured has no ceiling",
  ceilingFor(config, "synthetic-absent", "reader-major") === null, ""]);
const sealed = new BudgetLedger({ query: async () => { throw new Error("the ledger opened a door it had no ceiling for"); } }, config);
let said = null, typed = false;
try { await sealed.reserve("00000000-0000-0000-0000-000000000000", null); }
catch (error) { typed = isBudgetRefused(error); said = String(error.reason ?? error.message); }
checks.push(["an attempt with no ceiling is refused before any door is opened, and never reaches the ledger's database at all",
  typed && said.includes("no ceiling"), (said ?? "the call was allowed").slice(0, 120)]);
console.log("SEALED " + JSON.stringify({ checks, tripped: tripped() }));
`;
  const run = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", source], { encoding: "utf8" });
  const line = (run.stdout ?? "").split("\n").find((l) => l.startsWith("SEALED "));
  if (!line) {
    t.check("the sealed leg ran", false, (run.stderr ?? "").trim().slice(0, 300) || "no output");
  } else {
    const report = JSON.parse(line.slice("SEALED ".length));
    for (const [label, ok, detail] of report.checks) t.check(label, ok, detail);
    t.check("and behind a closed network nothing in that path tried to reach out",
      report.tripped === 0, `${report.tripped} attempts on a closed door`);
  }
}

t.finish();
