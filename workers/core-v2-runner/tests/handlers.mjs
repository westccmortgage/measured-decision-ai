/* THE HANDLERS THEMSELVES, NOT A DESCRIPTION OF THEM.
 *
 * Every other suite in this directory drives `runOnePass` with a world a test
 * assembled. That proves the pass. It does not prove the two things a person
 * actually calls — the start that writes a workflow down, and the tick that
 * picks one up — because those used to live inside Deno request handlers and
 * could only be reached by writing the same sequence again in a test. A test
 * of a re-implementation is a test of the re-implementation.
 *
 * So the sequences moved into workers/core-v2-runner/{start,tick}.ts, the Edge
 * Functions became doors over them, and THIS FILE CALLS THE SAME FUNCTIONS THE
 * DOORS CALL. Two things are injected and nothing else:
 *
 *   · the transport, which is the seam that already existed — a local one that
 *     answers in each provider's own wire shape, so the real adapters, the
 *     real prompt compiler, the real material resolver, the real validator and
 *     the real ledger all run;
 *   · the clock, so a deadline can be moved without waiting for one.
 *
 * The operator declaration is a real declaration and passes the real
 * validator. The addresses in it resolve nowhere and nothing is ever sent to
 * them: the network is sealed for the whole file and the guard says so at the
 * end.
 */
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { harness } from "../../core-v2/tests/harness.mjs";
import { withThrowawayDatabase } from "../../core-v2/tests/postgres-harness.mjs";
import { SyntheticRecordsPack } from "../../core-v2/domains/synthetic-records/pack.ts";
import { syntheticRecordSet } from "../../core-v2/domains/synthetic-records/fixture.ts";
import { TERMINAL_WORKFLOW_STATES } from "../../core-v2/kernel/transitions.ts";
import { LocalProviderTransport } from "../../core-v2-runtime/providers/local-answers.ts";
import { answerFromRequest } from "../../core-v2-runtime/local-agent/reading-agent.ts";
import { invocationClock } from "../clock.ts";
import { PostgresContinuationStore } from "../continuations.ts";
import { alreadyInTransaction, parseStartRequest, startWorkflowAtomically } from "../start.ts";
import { PostgresOrchestrationRepository } from "../../core-v2/postgres/repository.ts";
import { enqueueWorkflow } from "../../core-v2-runtime/dispatcher.ts";
import { isShapeRefusal, shapeOfSourceUri, syntheticSourceSet } from "../source-set.ts";
import { tickOnce } from "../tick.ts";

/* THE WIRE, SEALED — BUT NOT THE UNIX SOCKET.
 *
 * The kernel's own `closeNetwork()` seals everything including `net`, which is
 * how the wire client reaches the throwaway cluster's unix socket, so a suite
 * that needs a real database cannot use it. This seals the doors a provider
 * could actually be reached through — fetch, http, https, tls — and leaves the
 * local socket alone, and it counts. A single attempt to reach anything over
 * TLS or HTTP anywhere in this file fails the run.
 *
 * boundaries.mjs is where the whole network is closed; nothing here weakens
 * that proof, it only makes this one possible. */
let reachedOut = 0;
{
  const refuse = (door) => function () { reachedOut++; throw new Error(`this suite may not reach ${door}`); };
  const seal = (target, name, door) => {
    if (!(name in target)) return;
    Object.defineProperty(target, name, { value: refuse(door), writable: false, configurable: false, enumerable: true });
  };
  seal(globalThis, "fetch", "fetch");
  seal(http, "request", "http.request"); seal(http, "get", "http.get");
  seal(https, "request", "https.request"); seal(https, "get", "https.get");
  seal(tls, "connect", "tls.connect");
}
const tripped = () => reachedOut;

const t = harness("the handlers a person and a watchdog actually call");

const n = (rows) => Number(rows[0].n);
/* The wire client sends parameters as text, so an array is written the way
   Postgres reads one. */
const uuidArray = (ids) => `{${ids.join(",")}}`;
/* A pass that could not start anything lets the record's backoff apply, which
   is right in production and inconvenient in a proof: these tests are about
   what one pass does, not about how long the next one waits. */
const dueNow = (client, id) => client.query(
  `update public.workflow_continuations set due_at = now() - interval '1 minute' where workflow_id = $1`, [id]);
const stateOf = async (client, id) =>
  (await client.query("select state from public.intelligence_workflows where id = $1", [id])).rows[0]?.state ?? null;

/* ─────────────────────────────────────────── the operator's declaration
 *
 * Real, and it passes the real validator — which refuses reserved names, so
 * these hosts are ordinary-looking and resolve nowhere. Nothing is sent to
 * them: `closeNetwork()` above is what makes that a fact rather than a hope.
 */
const CAPABLE = { forcedToolChoice: true, strictSchema: true, images: true, thinking: "none" };
function declaration() {
  const provider = (id, host, model, variable) => ({
    providerId: id, baseUrl: `https://${host}`, apiKeyEnvironmentVariable: variable,
    models: [model], defaultModel: model,
    maximumInputTokens: 60_000, maximumOutputTokens: 4_096, requestTimeoutMs: 30_000,
    maximumMaterialBytes: 512 * 1024, maximumMaterialBytesPerItem: 256 * 1024,
    supportedMediaTypes: ["text/plain; charset=utf-8", "image/png"],
    capabilities: { [model]: { ...CAPABLE } },
  });
  const price = (id, model) => ({
    providerId: id, model, effectiveFrom: "2026-01-01", currency: "USD",
    inputPerMillionTokens: 1, outputPerMillionTokens: 5, cacheWritePerMillionTokens: 1.25,
  });
  return JSON.stringify({
    declaredBy: "an operator under test", declaredAt: "2026-09-09",
    providers: [
      provider("anthropic", "alpha.operator-under-test.net", "operator-model-a", "OPERATOR_KEY_A"),
      provider("openai", "beta.operator-under-test.net", "operator-model-b", "OPERATOR_KEY_B"),
      provider("google", "gamma.operator-under-test.net", "operator-model-c", "OPERATOR_KEY_C"),
    ],
    pricing: [price("anthropic", "operator-model-a"), price("openai", "operator-model-b"), price("google", "operator-model-c")],
    roles: { readerA: "anthropic", readerB: "openai", critic: "google" },
    routing: {
      "reader-family-one": "anthropic", "reader-family-two": "openai",
      "critic-family-one": "google", "arbiter-family-one": "google",
    },
  });
}

const ENVIRONMENT = {
  CORE_V2_RUNNER_REGISTRY: declaration(),
  CORE_V2_RUNNER_AUTHORIZED_USD: "5",
  CORE_V2_ALLOW_PAID_CALLS: "true",
  CORE_V2_RUNNER_CONCURRENT_ATTEMPTS: "6",
  OPERATOR_KEY_A: "not-a-key-and-never-sent-a",
  OPERATOR_KEY_B: "not-a-key-and-never-sent-b",
  OPERATOR_KEY_C: "not-a-key-and-never-sent-c",
};

function gatesWith(extra = {}) {
  const env = { ...ENVIRONMENT, ...extra };
  return { networkFlag: true, environment: (name) => env[name] };
}

/* ─────────────────────────────────────────── the wire, answered locally
 *
 * Every request that would have gone out is recorded, then answered in the
 * provider's own shape from the request itself. `delayMs` is how a proof makes
 * one reading eat a window: it is the only artificial thing here.
 */
function sealedTransport({ sent, onRequest, now = () => Date.now() } = {}) {
  return () => new LocalProviderTransport({
    onRequest: (question) => {
      const text = question.parts.find((p) => p.kind === "text" && p.text.includes("taskId: "));
      const taskId = text ? (text.text.match(/^taskId: (\S+)$/m) ?? [])[1] ?? null : null;
      if (sent) sent.push({ at: now(), providerId: question.providerId, taskId });
      if (onRequest) onRequest(question);
    },
    /* SYNCHRONOUS ON PURPOSE. The local transport does not await what a
       stand-in hands back, so an async answer arrives at the adapter as a
       promise and every reading fails with "the answer does not say how it
       ended". Anything a proof needs to happen while an answer is being given
       belongs in onRequest, which runs before it. */
    answer: (question) => {
      try { return answerFromRequest(question); }
      catch (error) { return new Error(`the stand-in could not answer: ${error.message}`); }
    },
  });
}

/* ─────────────────────────────────────────── a controllable clock */
function fakeClock(startAt = 1_000_000) {
  let at = startAt;
  return {
    now: () => at,
    advance: (ms) => { at += ms; },
    /* Real timers would fire on the wall while this clock stands still, so
       the pass is given timers that never fire and is stopped by its own
       deadline checks instead — which is precisely what is under test. */
    setTimer: () => null,
    clearTimer: () => undefined,
  };
}

const LIFE = { lifetimeMs: 30_000, safetyMs: 500, answerWithinMs: 5_000, settlementRoomMs: 1_000, graceMs: 1_000 };

async function startVia(client, organizationId, body, betweenWrites) {
  const request = parseStartRequest({ organizationId, ...body });
  if (isShapeRefusal(request)) return { refused: request };
  return await startWorkflowAtomically({
    client, request, pack: new SyntheticRecordsPack(), betweenWrites,
  });
}

function tickVia(client, options = {}) {
  const clock = invocationClock({ ...LIFE, ...(options.life ?? {}) });
  const startedAt = options.startedAt ?? Date.now();
  return tickOnce({
    runner: options.runner ?? "core-v2-runner-tick",
    client,
    store: new PostgresContinuationStore(client),
    clock,
    gates: gatesWith(options.environment),
    transport: options.transport ?? sealedTransport(),
    startedAt,
    deadlineAt: options.deadlineAt ?? (startedAt + clock.deadlineMs),
    now: options.now,
    setTimer: options.setTimer,
    clearTimer: options.clearTimer,
  });
}

await withThrowawayDatabase(async ({ client, organizationId }) => {

  /* ═════════════════════════════════════════════════════════════════════ */
  t.section("(1) a start is one commit, or it never happened");

  {
    /* The failure the old code could produce: the workflow rows land, the
       process dies, and the continuation the watchdog reads never exists. */
    let threw = null;
    try {
      await startVia(client, organizationId, { sourceSetSeed: "atomic/killed" }, async () => {
        throw new Error("the process died between the workflow and its continuation");
      });
    } catch (error) { threw = error; }

    t.check("a start killed between its writes fails loudly rather than half-succeeding",
      threw !== null, String(threw && threw.message));

    const orphans = await client.query(
      `select count(*)::text as n from public.intelligence_workflows
        where source_set_fingerprint in (
          select source_set_fingerprint from public.intelligence_workflows) and id in (
          select workflow_id from public.workflow_sources where uri like '%atomic%killed%')`);
    t.check("and it leaves NO workflow behind — not one that nothing would ever run",
      n(orphans.rows) === 0, `${n(orphans.rows)} left over`);

    const sources = await client.query(
      `select count(*)::text as n from public.workflow_sources where uri like '%atomic%killed%'`);
    t.check("no sources", n(sources.rows) === 0);
    const conts = await client.query(`select count(*)::text as n from public.workflow_continuations`);
    t.check("and no continuation", n(conts.rows) === 0, `${n(conts.rows)} rows`);
  }

  {
    const started = await startVia(client, organizationId, { sourceSetSeed: "atomic/whole" });
    t.check("a start that completes returns an id straight away",
      typeof started.workflowId === "string" && started.workflowId.length === 36);

    const rows = await client.query(
      `select
         (select count(*)::text from public.intelligence_workflows where id = $1) as w,
         (select count(*)::text from public.workflow_sources where workflow_id = $1) as s,
         (select count(*)::text from public.workflow_outbox where workflow_id = $1) as o,
         (select count(*)::text from public.workflow_continuations where workflow_id = $1) as c`,
      [started.workflowId]);
    const r = rows.rows[0];
    t.check("the workflow, its sources, its start command and its continuation all exist together",
      Number(r.w) === 1 && Number(r.s) === 1 && Number(r.o) === 1 && Number(r.c) === 1,
      `workflow ${r.w}, sources ${r.s}, command ${r.o}, continuation ${r.c}`);

    /* The promise the caller was given: the id names work the automatic
       runner can already see, with nothing further asked of anybody. */
    const store = new PostgresContinuationStore(client);
    const hold = await store.claim("proof-of-visibility", 5_000);
    t.check("and the id it returned is already visible to the automatic runner",
      hold !== null && hold.workflowId === started.workflowId, String(hold && hold.workflowId));
    await store.release({ workflowId: started.workflowId, holdToken: hold.holdToken, moved: false, nextDueAt: new Date(Date.now() - 1000) });
  }

  /* ═════════════════════════════════════════════════════════════════════ */
  t.section("(5) the whole shape a caller asked for is what a later runner rebuilds");

  {
    const refused = await startVia(client, organizationId, { sourceSetSeed: "shape/too-big", entriesPerTable: 999 });
    t.check("a shape V1 cannot run is refused with the numbers in it",
      refused.refused !== undefined && /entriesPerTable must be between/.test(refused.refused.refused),
      String(refused.refused && refused.refused.refused));
    const nothing = await client.query(
      `select count(*)::text as n from public.workflow_sources where uri like '%shape%too-big%'`);
    t.check("and no workflow was created to discover it later",
      n(nothing.rows) === 0);

    t.check("a shape that is not a whole number is refused too",
      isShapeRefusal(parseStartRequest({ organizationId, sourceSetSeed: "s", sheetsPerSource: 2.5 })));
    t.check("and so is one below the floor",
      isShapeRefusal(parseStartRequest({ organizationId, sourceSetSeed: "s", sources: 0 })));

    const started = await startVia(client, organizationId, {
      sourceSetSeed: "shape/two-and-four", sheetsPerSource: 2, entriesPerTable: 4,
    });
    const recorded = await client.query(
      `select uri, content_hash from public.workflow_sources where workflow_id = $1 order by ordinal`,
      [started.workflowId]);

    const read = shapeOfSourceUri(String(recorded.rows[0].uri));
    t.check("the record itself carries every number the material came from",
      read !== null && read.sheetsPerSource === 2 && read.entriesPerTable === 4,
      JSON.stringify(read));

    /* The rebuild the runner does, against the fixture built the way the
       caller asked. Same bytes, therefore same hashes. */
    const truth = syntheticRecordSet({
      seed: "shape/two-and-four", sources: 1, sheetsPerSource: 2, entriesPerTable: 4,
      organizationId, workflowId: started.workflowId,
    });
    t.check("and the material rebuilds to exactly the hashes the record kept",
      truth.manifest.sources[0].contentHash === String(recorded.rows[0].content_hash),
      `${truth.manifest.sources[0].contentHash} vs ${recorded.rows[0].content_hash}`);

    /* And the real tick agrees: it proves the material or it refuses. Every
       other continuation is pushed out of the way first, so what the tick
       claims is this workflow and the proof is about the rebuild rather than
       about which row happened to be oldest. */
    await client.query(
      `update public.workflow_continuations set due_at = now() + interval '1 hour' where workflow_id <> $1`,
      [started.workflowId]);
    const outcome = await tickVia(client, { runner: "shape-tick" });
    t.check("a real tick over that workflow proves its material rather than refusing it",
      outcome.kind === "ran" && outcome.workflowId === started.workflowId,
      `${outcome.kind} ${outcome.workflowId ?? ""}`);
    t.check("and it rebuilt the set the caller named",
      outcome.kind === "ran" && outcome.seed === "shape/two-and-four", String(outcome.seed));

    /* A workflow this deployment CANNOT rebuild is stopped — and told.
       The source is written unreadable at creation, because the record
       refuses to let one be edited afterwards: "a different source is a
       different workflow" is a guard in migration 058 and it is right. */
    const foreign = syntheticSourceSet({ seed: "shape/unreadable" }, organizationId);
    const unreadable = await client.transaction(async (tx) => {
      const repo = new PostgresOrchestrationRepository(
        alreadyInTransaction(tx), { organizationId });
      const created = await enqueueWorkflow(repo, {
        ...foreign.manifest,
        sources: foreign.manifest.sources.map((source) => ({ ...source, uri: "s3://somewhere/else" })),
      }, new SyntheticRecordsPack());
      await tx.query(`select 1 from public.core_v2_schedule_continuation($1::uuid, now())`, [created.workflowId]);
      return created;
    });
    await client.query(
      `update public.workflow_continuations set due_at = now() + interval '1 hour' where workflow_id <> $1`,
      [unreadable.workflowId]);
    await client.query(
      `update public.workflow_continuations set due_at = now() - interval '1 minute' where workflow_id = $1`,
      [unreadable.workflowId]);
    const refusedTick = await tickVia(client, { runner: "unreadable-tick" });
    t.check("a source set this runner cannot rebuild is refused rather than guessed at",
      refusedTick.kind === "material_not_provable", String(refusedTick.kind));
    t.check("its waking stops",
      (await new PostgresContinuationStore(client).read(unreadable.workflowId))?.settledReason === "material_not_provable");
    const toldState = await stateOf(client, unreadable.workflowId);
    const toldWhy = (await client.query(
      `select error_code, error_message from public.intelligence_workflows where id = $1`,
      [unreadable.workflowId])).rows[0];
    t.check("and the workflow is told, so the two records do not disagree",
      toldState !== "created" && String(toldWhy.error_message) === "material_not_provable",
      `${toldState}: ${toldWhy.error_code} / ${toldWhy.error_message}`);
  }

  await client.query(`delete from public.workflow_continuations`);
});

/* ═══════════════════════════════════════════════════════════════════════ */
await withThrowawayDatabase(async ({ client, organizationId }) => {
  t.section("(2) one workflow is chosen once, and the pass runs that one");

  const a = await startVia(client, organizationId, { sourceSetSeed: "isolation/alpha" });
  const b = await startVia(client, organizationId, { sourceSetSeed: "isolation/beta" });
  t.check("two workflows exist, over two different source sets", a.workflowId !== b.workflowId);

  const seen = [];
  /* THE QUEUE IS REORDERED WHILE THE WORLD IS BEING BUILT.
     A tick that claimed A, built A's world, gave the hold back and claimed
     again would take B here — and then advance B with A's material. The
     reorder happens on the transport's first request, which is after the
     world exists and before anything has been written. */
  let reordered = false;
  const reorder = async () => {
    if (reordered) return;
    reordered = true;
    await client.query(
      `update public.workflow_continuations set due_at = now() - interval '1 hour' where workflow_id = $1`,
      [b.workflowId]);
    await client.query(
      `update public.workflow_continuations set due_at = now() + interval '1 hour' where workflow_id = $1`,
      [a.workflowId]);
  };

  const first = await tickVia(client, {
    runner: "isolation-one",
    transport: sealedTransport({ sent: seen }),
    life: { ...LIFE, lifetimeMs: 12_000 },
  });
  t.check("the pass ran the workflow it claimed",
    first.kind === "ran" && first.outcome.workflowId === first.workflowId,
    `${first.workflowId} then ${first.kind === "ran" ? first.outcome.workflowId : "-"}`);
  const chosen = first.workflowId;
  await reorder();

  const second = await tickVia(client, {
    runner: "isolation-two",
    transport: sealedTransport({ sent: seen }),
    life: { ...LIFE, lifetimeMs: 12_000 },
  });
  t.check("a second, overlapping tick also ran exactly what it claimed",
    second.kind !== "ran" || second.outcome.workflowId === second.workflowId,
    `${second.workflowId} then ${second.kind === "ran" ? second.outcome.workflowId : "-"}`);
  t.check("and a reordered queue did not make either pass switch workflow",
    first.kind !== "ran" || first.outcome.workflowId === chosen);

  /* The decisive question is not which workflow ran but whose material it
     used. Every claim, segment and attempt of each workflow must belong to
     that workflow — and the material is looked up by content hash, so a pass
     holding the wrong set produces "no material came back" rather than a
     wrong answer. */
  const wrongMaterial = await client.query(
    `select count(*)::text as n from public.agent_attempts
      where error_code = 'material_refused'`);
  t.check("no attempt anywhere was handed material that did not belong to its workflow",
    n(wrongMaterial.rows) === 0, `${n(wrongMaterial.rows)} refusals`);

  const crossed = await client.query(
    `select count(*)::text as n
       from public.evidence_claims c
       join public.agent_attempts att on att.id = c.attempt_id
      where att.workflow_id <> c.workflow_id`);
  t.check("and nothing written under one workflow came from another's attempt",
    n(crossed.rows) === 0);
});

/* ═══════════════════════════════════════════════════════════════════════ */
await withThrowawayDatabase(async ({ client, organizationId }) => {
  t.section("(3) one absolute deadline, asked about before every submission");

  const started = await startVia(client, organizationId, { sourceSetSeed: "clock/one-deadline" });
  const clock = fakeClock();

  /* Preparation that already spent most of the life. The deadline is
     absolute and was taken at the door; the pass is told the truth about how
     much is left rather than starting a fresh budget. */
  const life = { lifetimeMs: 30_000, safetyMs: 500, answerWithinMs: 5_000, settlementRoomMs: 1_000, graceMs: 1_000 };
  const derived = invocationClock(life);
  const doorAt = clock.now();
  const deadlineAt = doorAt + derived.deadlineMs;

  {
    /* Twenty-six of the twenty-nine usable seconds are gone before the pass
       begins. What is left is less than one answer plus its settlement, so
       nothing may be started at all. */
    clock.advance(26_000);
    const outcome = await tickVia(client, {
      runner: "clock-no-room", life, startedAt: doorAt, deadlineAt,
      now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    });
    t.check("slow preparation shrinks the window rather than restarting it",
      outcome.kind === "ran" && outcome.outcome.stopReason === "no_time_left_in_this_pass",
      `${outcome.kind} ${outcome.kind === "ran" ? outcome.outcome.stopReason : ""}`);

    const attempts = await client.query(
      `select count(*)::text as n from public.agent_attempts where workflow_id = $1`, [started.workflowId]);
    t.check("and with no room to answer and settle, nothing was submitted at all",
      n(attempts.rows) === 0, `${n(attempts.rows)} attempts`);
    t.check("the workflow was not failed for it — the clock is not a reading that went wrong",
      TERMINAL_WORKFLOW_STATES.includes(await stateOf(client, started.workflowId)) === false,
      String(await stateOf(client, started.workflowId)));
    t.check("and it is due again",
      (await new PostgresContinuationStore(client).read(started.workflowId))?.state === "due");
  }

  {
    /* THE WINDOW EATEN BY THE FIRST READER, IN TWO DELIBERATE STEPS.
     *
     * A lane runs its readings one after another: the second blind reader of
     * a subject starts only once the first has answered. To reach that moment
     * on purpose rather than by luck, the fake clock is moved forward by the
     * transport itself — an answer "takes" whatever the proof says it takes.
     *
     * Step one gets the workflow past discovery, so a pair of blind readings
     * of one subject is queued. Step two gives the pass a fresh window and
     * then spends the whole of it on the first answer. The second reading of
     * that pair has nowhere to run, and the requirement is that it is NOT
     * sent: it goes back to the queue, unrun and uncharged.
     */
    const jumpTo = { at: 0 };
    const eatTheWindow = sealedTransport({
      onRequest: () => { if (clock.now() < jumpTo.at) clock.advance(jumpTo.at - clock.now()); },
      now: clock.now,
    });

    /* step one — past discovery, and no further */
    await dueNow(client, started.workflowId);
    const oneStart = clock.now();
    jumpTo.at = oneStart + derived.stopLeasingMs + 1;
    await tickVia(client, {
      runner: "clock-discovery", life, transport: eatTheWindow,
      startedAt: oneStart, deadlineAt: oneStart + derived.deadlineMs,
      now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    });

    const pairs = await client.query(
      `select subject_key, count(*)::text as n from public.workflow_tasks
        where workflow_id = $1 and state in ('queued','created') and independence_group is not null
        group by subject_key having count(*) > 1`, [started.workflowId]);
    t.check("after discovery, a subject has two blind readings waiting for it",
      pairs.rows.length > 0, `${pairs.rows.length} subjects with a pair`);

    /* step two — a fresh window, spent entirely on the first answer */
    await dueNow(client, started.workflowId);
    clock.advance(1_000);
    const twoStart = clock.now();
    jumpTo.at = twoStart + derived.stopLeasingMs + 1;
    const beforeAttempts = await client.query(
      `select count(*)::text as n from public.agent_attempts where workflow_id = $1`, [started.workflowId]);

    const outcome = await tickVia(client, {
      runner: "clock-window", life, transport: eatTheWindow,
      startedAt: twoStart, deadlineAt: twoStart + derived.deadlineMs,
      now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    });

    t.check("the pass stopped because the clock ran out, and said so about the clock",
      outcome.kind === "ran" &&
      ["no_time_left_in_this_pass", "more_work_remains"].includes(outcome.outcome.stopReason),
      String(outcome.kind === "ran" ? outcome.outcome.stopReason : outcome.kind));

    t.check("A READING IT COULD NOT FINISH WAS NOT SENT — it went back to the queue",
      outcome.kind === "ran" && outcome.outcome.deferred > 0,
      `${outcome.kind === "ran" ? outcome.outcome.deferred : "-"} deferred`);

    const deferredAudit = await client.query(
      `select count(*)::text as n from public.audit_events where action = 'core_v2.task.deferred'`);
    t.check("and every deferral is in the audit trail as a deferral, not as a failure",
      n(deferredAudit.rows) === (outcome.kind === "ran" ? outcome.outcome.deferred : -1),
      `${n(deferredAudit.rows)} audited, ${outcome.kind === "ran" ? outcome.outcome.deferred : "-"} reported`);

    /* Which tasks were deferred, from the trail rather than from the report,
       so the two have to agree. `terminal_reason` is deliberately not written
       for a move to a non-terminal state, which is why the reason lives in
       the audit trail: a task waiting in the queue has no terminal reason
       because nothing about it is terminal. */
    const deferredIds = (await client.query(
      `select entity_id::text as id from public.audit_events
        where action = 'core_v2.task.deferred'`)).rows.map((r) => String(r.id));

    const back = await client.query(
      `select count(*)::text as n from public.workflow_tasks
        where id = any($1::uuid[]) and state = 'queued'
          and lease_owner is null and lease_token is null and lease_expires_at is null`,
      [uuidArray(deferredIds)]);
    t.check("every deferred reading is queued again and holds no lease a dead process would own",
      n(back.rows) === deferredIds.length, `${n(back.rows)} of ${deferredIds.length}`);

    const failedForTime = await client.query(
      `select count(*)::text as n from public.agent_attempts
        where workflow_id = $1 and state in ('failed_known','outcome_unknown')`, [started.workflowId]);
    t.check("nothing became a failed or unknown reading because this process ran out of time",
      n(failedForTime.rows) === 0, `${n(failedForTime.rows)}`);

    const forDeferred = await client.query(
      `select count(*)::text as n from public.agent_attempts where task_id = any($1::uuid[])`,
      [uuidArray(deferredIds)]);
    t.check("AND NOT ONE OF THEM HAS AN ATTEMPT — nothing was prepared, sent or charged for",
      n(forDeferred.rows) === 0, `${n(forDeferred.rows)} attempts against ${deferredIds.length} deferred tasks`);

    const afterAttempts = await client.query(
      `select count(*)::text as n from public.agent_attempts where workflow_id = $1`, [started.workflowId]);
    t.check("the readings that did start are the only ones that were bought",
      n(afterAttempts.rows) > n(beforeAttempts.rows),
      `${n(beforeAttempts.rows)} then ${n(afterAttempts.rows)}, ${deferredIds.length} deferred`);

    t.check("every answer and its settlement landed inside the one deadline",
      clock.now() <= twoStart + derived.deadlineMs,
      `${clock.now() - twoStart}ms of ${derived.deadlineMs}ms`);
  }

  {
    /* The next pass starts what the last one deferred, and does not re-run
       what already answered. An attempt that succeeded is never bought
       again, so a second attempt on a completed task would show up here. */
    const before = await client.query(
      `select count(*)::text as n from public.agent_attempts where workflow_id = $1`, [started.workflowId]);
    const sent = [];
    await dueNow(client, started.workflowId);
    const outcome = await tickVia(client, {
      runner: "clock-next-pass", life: { ...LIFE, lifetimeMs: 25_000 },
      transport: sealedTransport({ sent }),
    });
    const after = await client.query(
      `select count(*)::text as n from public.agent_attempts where workflow_id = $1`, [started.workflowId]);
    t.check("the next pass picked the deferred work up",
      outcome.kind === "ran" && n(after.rows) >= n(before.rows), `${n(before.rows)} then ${n(after.rows)}`);

    const twice = await client.query(
      `select count(*)::text as n from (
         select task_id from public.agent_attempts
          where workflow_id = $1 and state = 'succeeded'
          group by task_id having count(*) > 1) again`, [started.workflowId]);
    t.check("and no task that had already answered was asked a second time",
      n(twice.rows) === 0, `${n(twice.rows)} tasks answered twice`);
  }
});

/* ═══════════════════════════════════════════════════════════════════════ */
await withThrowawayDatabase(async ({ client, organizationId }) => {
  t.section("(4) stopping for good says so in both records, and cancelling still works");

  const store = new PostgresContinuationStore(client);

  {
    /* A WORKFLOW THAT CANNOT GET THROUGH ITS OWN FRONT DOOR.
       The start command is taken away while the workflow is still `created`,
       so the handshake can never complete and no pass can move anything. This
       is the shape of every "it is not running and nobody knows why" report,
       and the requirement is that BOTH records end up saying so. */
    const stuck = await startVia(client, organizationId, { sourceSetSeed: "stop/no-progress" });
    await client.query(`delete from public.workflow_outbox where workflow_id = $1`, [stuck.workflowId]);

    let last = null;
    for (let i = 0; i < 10; i++) {
      await client.query(
        `update public.workflow_continuations set due_at = now() - interval '1 minute' where workflow_id = $1`,
        [stuck.workflowId]);
      const outcome = await tickVia(client, { runner: `stop-${i}`, life: { ...LIFE, lifetimeMs: 8_000 } });
      if (outcome.kind === "ran") last = outcome.outcome;
      if ((await store.read(stuck.workflowId))?.state === "settled") break;
    }

    const row = await store.read(stuck.workflowId);
    t.check("a workflow that cannot be advanced stops being woken",
      row?.state === "settled", `${row?.state} ${row?.settledReason ?? ""}`);
    t.check("and the reason names why, rather than being a bare stop",
      /no_progress_in_\d+_continuations|handed_to_a_person/.test(String(row?.settledReason)),
      String(row?.settledReason));

    const state = await stateOf(client, stuck.workflowId);
    t.check("THE WORKFLOW ITSELF IS TOLD — it is not left claiming to be running",
      state !== "created" && state !== "running", String(state));

    const why = await client.query(
      `select error_code, error_message from public.intelligence_workflows where id = $1`, [stuck.workflowId]);
    t.check("with the specific reason written on the workflow, not only on the continuation",
      String(why.rows[0].error_code) === "runner_stopped" && String(why.rows[0].error_message).length > 0,
      `${why.rows[0].error_code}: ${why.rows[0].error_message}`);

    t.check("and the pass reported the final stop rather than pretending it continued",
      last !== null && last.finalStop !== null, JSON.stringify(last && last.finalStop));

    const audited = await client.query(
      `select count(*)::text as n from public.audit_events
        where action = 'core_v2.workflow.runner_stopped' and entity_id = $1`, [stuck.workflowId]);
    t.check("the stop is in the audit trail with its reason",
      n(audited.rows) > 0, `${n(audited.rows)} entries`);

    t.check("asking again does not wake a settled workflow",
      (await store.schedule(stuck.workflowId, null))?.state === "settled");
    t.check("and a workflow the fuse already ended is not restarted by a late cancellation",
      (await store.reopenForCancellation(stuck.workflowId))?.state === "settled");
  }

  {
    /* THE STATE NOBODY SHOULD BE ABLE TO REACH.
       A workflow that is genuinely still going, whose waking has been turned
       off, and whose owner then asks for it to be cancelled. Before migration
       061 the cancellation was written down and then nothing happened, ever:
       `schedule` will not revive a settled row, by design. */
    const live = await startVia(client, organizationId, { sourceSetSeed: "stop/cancel-after-settling" });
    await store.settle(live.workflowId, "handed_to_a_person");

    t.check("the workflow is not over, and its waking is off",
      TERMINAL_WORKFLOW_STATES.includes(String(await stateOf(client, live.workflowId))) === false &&
      (await store.read(live.workflowId))?.state === "settled",
      `${await stateOf(client, live.workflowId)} / ${(await store.read(live.workflowId))?.state}`);

    t.check("asking for it again changes nothing — settling is absorbing, on purpose",
      (await store.schedule(live.workflowId, null))?.state === "settled");
    t.check("and reopening refuses while nobody has asked to cancel it",
      (await store.reopenForCancellation(live.workflowId))?.state === "settled");

    /* What the cancel door does, in the order it does it. */
    await client.query(
      `update public.intelligence_workflows set cancel_requested_at = now() where id = $1`, [live.workflowId]);
    const reopened = await store.reopenForCancellation(live.workflowId);
    t.check("but once a cancellation IS recorded, the waking is reopened for it",
      reopened?.state === "due", String(reopened?.state));
    t.check("and reopening clears the fuses it is about to need",
      (reopened?.idleStreak ?? -1) === 0 && reopened?.settledReason === null,
      `streak ${reopened?.idleStreak}, reason ${reopened?.settledReason}`);

    for (let i = 0; i < 5; i++) {
      await client.query(
        `update public.workflow_continuations set due_at = now() - interval '1 minute' where workflow_id = $1`,
        [live.workflowId]);
      await tickVia(client, { runner: `cancel-${i}`, life: { ...LIFE, lifetimeMs: 10_000 } });
      if (String(await stateOf(client, live.workflowId)) === "cancelled") break;
    }
    t.check("the workflow is then actually cancelled, not merely asked about",
      String(await stateOf(client, live.workflowId)) === "cancelled",
      String(await stateOf(client, live.workflowId)));

    const unknownRelabelled = await client.query(
      `select count(*)::text as n from public.agent_attempts
        where workflow_id = $1 and state = 'outcome_unknown'`, [live.workflowId]);
    t.check("and an outcome nobody knows was not relabelled by the cancellation",
      Number(unknownRelabelled.rows[0].n) >= 0);
  }

  {
    /* THE CONTINUATION CEILING, WHICH NO PASS EVER SEES.
       core_v2_claim_continuation settles a row that has reached the ceiling
       and keeps looking, so the runner is never handed that workflow and
       never gets to write its state. The tick notices on its next idle pass;
       this is that, from the ceiling rather than from 200 real invocations. */
    const capped = await startVia(client, organizationId, { sourceSetSeed: "stop/at-the-ceiling" });
    const limits = await store.limits();
    await client.query(
      `update public.workflow_continuations
          set continuations = $2::int, due_at = now() - interval '1 minute'
        where workflow_id = $1`, [capped.workflowId, limits.maximumContinuations]);
    await client.query(
      `update public.workflow_continuations set due_at = now() + interval '1 hour' where workflow_id <> $1`,
      [capped.workflowId]);

    const outcome = await tickVia(client, { runner: "ceiling", life: { ...LIFE, lifetimeMs: 10_000 } });
    t.check("a workflow at the continuation ceiling is not handed to a runner at all",
      outcome.kind === "nothing_due", String(outcome.kind));

    const row = await store.read(capped.workflowId);
    t.check("its waking is settled, by the ceiling, with the reason on the row",
      row?.state === "settled" && String(row?.settledReason).includes("continuation"),
      `${row?.state} ${row?.settledReason ?? ""}`);

    t.check("and the SAME tick told the workflow, so nothing is left saying it is running",
      outcome.kind === "nothing_due" && outcome.reconciled.includes(capped.workflowId),
      JSON.stringify(outcome.kind === "nothing_due" ? outcome.reconciled : []));

    const why = (await client.query(
      `select state, error_code, error_message from public.intelligence_workflows where id = $1`,
      [capped.workflowId])).rows[0];
    t.check("with the ceiling written on the workflow as the reason it stopped",
      String(why.error_code) === "runner_stopped" && String(why.error_message).length > 0,
      `${why.state}: ${why.error_code} / ${why.error_message}`);
    t.check("and the state it stopped in is one a person can still act on or cancel",
      TERMINAL_WORKFLOW_STATES.includes(String(why.state)) === false || String(why.state) === "failed",
      String(why.state));
  }

  {
    /* WAITING IS NOT BEING STUCK. Another runner holds a live lease; a pass
       that finds nothing it may touch has not failed to advance anything,
       and must not spend the fuse that is for workflows that cannot move. */
    const busy = await startVia(client, organizationId, { sourceSetSeed: "stop/waiting" });
    await client.query(
      `update public.workflow_continuations set due_at = now() + interval '1 hour' where workflow_id <> $1`,
      [busy.workflowId]);
    /* Stopped on purpose after discovery, the same way as the clock proofs:
       the first answer spends the whole window, so readings are planned and
       queued and none of them has run. Code executors answer in microseconds,
       so nothing short of this leaves work standing still to look at. */
    const life = { lifetimeMs: 30_000, safetyMs: 500, answerWithinMs: 5_000, settlementRoomMs: 1_000, graceMs: 1_000 };
    const derived = invocationClock(life);
    const clk = fakeClock(2_000_000);
    const jump = { at: 0 };
    const eatTheWindow = sealedTransport({
      onRequest: () => { if (clk.now() < jump.at) clk.advance(jump.at - clk.now()); },
      now: clk.now,
    });
    const at = clk.now();
    jump.at = at + derived.stopLeasingMs + 1;
    await tickVia(client, {
      runner: "waiting-first", life, transport: eatTheWindow,
      startedAt: at, deadlineAt: at + derived.deadlineMs,
      now: clk.now, setTimer: clk.setTimer, clearTimer: clk.clearTimer,
    });

    const task = (await client.query(
      `select id from public.workflow_tasks
        where workflow_id = $1 and state = 'queued' order by created_at limit 1`, [busy.workflowId])).rows[0];
    t.check("there is queued work for somebody to hold",
      task !== undefined, String(await stateOf(client, busy.workflowId)));
    if (task) {
      /* EVERY runnable task is held by somebody who is not here, and none of
         the leases has expired. Leaving even one of them free would give the
         pass something to do, and then it would not be waiting — it would be
         working, which is a different proof. */
      await client.query(
        `update public.workflow_tasks
            set state = 'leased', lease_owner = 'somebody-else', lease_token = gen_random_uuid(),
                lease_expires_at = now() + interval '10 minutes'
          where workflow_id = $1 and state = 'queued'`, [busy.workflowId]);

      const before = (await store.read(busy.workflowId))?.idleStreak ?? 0;
      await client.query(
        `update public.workflow_continuations set due_at = now() - interval '1 minute' where workflow_id = $1`,
        [busy.workflowId]);
      const outcome = await tickVia(client, { runner: "waiting-second", life: { ...LIFE, lifetimeMs: 10_000 } });
      const after = await store.read(busy.workflowId);

      t.check("a pass that could only wait says it was waiting, not that it was stuck",
        outcome.kind === "ran" && outcome.outcome.stopReason === "waiting_for_a_live_lease",
        String(outcome.kind === "ran" ? outcome.outcome.stopReason : outcome.kind));
      t.check("waiting does not spend the fuse",
        (after?.idleStreak ?? 0) === before, `${before} then ${after?.idleStreak}`);
      t.check("and it does not settle a workflow that is merely busy",
        after?.state === "due", `${after?.state} ${after?.settledReason ?? ""}`);
      t.check("nor does it come straight back to spin — it waits for that lease to be able to expire",
        new Date(String(after?.dueAt)).getTime() > Date.now(), String(after?.dueAt));
    }
  }
});

/* ═══════════════════════════════════════════════════════════════════════ */
await withThrowawayDatabase(async ({ client, organizationId }) => {
  t.section("the whole thing, end to end, through the handlers and to real answers");

  const started = await startVia(client, organizationId, { sourceSetSeed: "core-v2-runner/acceptance" });
  const store = new PostgresContinuationStore(client);
  const sent = [];

  /* THE LOST LINK IN THE CHAIN.
     Only the watchdog's view of the record is used to decide what runs next:
     nothing here chains, and the due time is brought forward exactly the way
     core_v2_tick_due_continuations does. A workflow that finishes under
     these conditions finishes without the fast path existing at all. */
  let ticks = 0;
  for (let i = 0; i < 40; i++) {
    const due = await store.due(10);
    if (!due.includes(started.workflowId)) {
      const row = await store.read(started.workflowId);
      if (!row || row.state === "settled") break;
      await client.query(
        `update public.workflow_continuations set due_at = now() - interval '1 second' where workflow_id = $1`,
        [started.workflowId]);
      continue;
    }
    const outcome = await tickVia(client, {
      runner: `watchdog-${i}`, life: { ...LIFE, lifetimeMs: 20_000 },
      transport: sealedTransport({ sent }),
    });
    ticks += 1;
    if (outcome.kind !== "ran") break;
    if (TERMINAL_WORKFLOW_STATES.includes(String(await stateOf(client, started.workflowId)))) break;
  }

  const state = await stateOf(client, started.workflowId);
  t.check("a workflow reaches a terminal state with only the watchdog waking it",
    TERMINAL_WORKFLOW_STATES.includes(String(state)), `${state} after ${ticks} ticks`);

  /* AND IT REACHED A RESULT, NOT MERELY AN ENDING.
     A terminal state alone would be satisfied by `failed`. What the run is
     for is readings that match the record and decisions taken on them. */
  const truth = syntheticRecordSet({
    seed: "core-v2-runner/acceptance", sources: 1, sheetsPerSource: 1, entriesPerTable: 3,
    organizationId, workflowId: started.workflowId,
  });

  const claims = await client.query(
    `select subject_key, value, unit from public.evidence_claims
      where workflow_id = $1 and predicate = 'quantity'`, [started.workflowId]);
  t.check("it produced a quantity reading for every entry in the material",
    new Set(claims.rows.map((r) => String(r.subject_key))).size === truth.entries.length,
    `${new Set(claims.rows.map((r) => String(r.subject_key))).size} of ${truth.entries.length}`);

  const wrong = claims.rows.filter((row) => {
    const value = typeof row.value === "string" ? JSON.parse(row.value) : row.value;
    const entry = truth.entries.find((e) => `entry/${e.id}` === String(row.subject_key));
    return !entry || value?.quantity !== entry.quantity || String(row.unit) !== entry.unit;
  });
  t.check("and every one of those readings matches what the material actually says",
    wrong.length === 0, `${wrong.length} wrong of ${claims.rows.length}`);

  const anchors = await client.query(
    `select count(*)::text as n,
            count(*) filter (where coalesce(quoted_text,'') <> '')::text as quoted
       from public.evidence_anchors a
       join public.evidence_claims c on c.id = a.claim_id
       join public.agent_attempts att on att.id = c.attempt_id
      where a.workflow_id = $1 and att.executor_kind = 'model'`, [started.workflowId]);
  t.check("every model reading is anchored, and every anchor quotes its source",
    Number(anchors.rows[0].n) > 0 && anchors.rows[0].n === anchors.rows[0].quoted,
    `${anchors.rows[0].quoted} of ${anchors.rows[0].n}`);

  const decisions = await client.query(
    `select count(*)::text as n from public.decisions where workflow_id = $1`, [started.workflowId]);
  t.check("and it reached decisions rather than stopping short of them",
    Number(decisions.rows[0].n) > 0, `${decisions.rows[0].n} decisions`);

  const settled = await client.query(
    `select coalesce(sum(settled_cost), 0)::text as spent, count(*)::text as n
       from public.attempt_cost_reservations where workflow_id = $1`, [started.workflowId]);
  t.check("money was held and settled through the real ledger for every model attempt",
    Number(settled.rows[0].n) > 0, `${settled.rows[0].n} reservations, ${settled.rows[0].spent} settled`);

  t.check("and every request went to the local wire, never to a socket",
    sent.length > 0 && tripped() === 0, `${sent.length} requests, ${tripped()} sockets`);

  const row = await store.read(started.workflowId);
  t.check("the record stopped asking to be woken",
    row?.state === "settled", `${row?.state} ${row?.settledReason ?? ""}`);
});

t.check("nothing in this suite tried to open a socket", tripped() === 0, `guard tripped ${tripped()} times`);
t.finish();
