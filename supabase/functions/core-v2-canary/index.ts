/* THE ONE PAID RUN, HOSTED, ONCE.
 *
 * This function exists to make exactly one Measured Decision workflow happen
 * with real providers answering, inside an authority of $5.00 USD, and then
 * to be taken away. It is temporary by intent and by design: the trigger it
 * needs is a secret nobody holds but the operator who deployed it, and the
 * record itself refuses a second run under the same canary id.
 *
 * WHAT RUNS HERE IS NOT A SECOND ENGINE. The scheduler, the router, the
 * repository, the state machines, the independence rules, the durable budget
 * and the three provider adapters are the ones in workers/, imported
 * unchanged. This file supplies four things and nothing else:
 *
 *   1. the gates — a trigger, a network flag and a paid-calls gate;
 *   2. a database client Deno can use (deno-postgres.ts), because the wire
 *      client speaks to a unix socket with no TLS and no password;
 *   3. a transport Deno can use (deno-transport.ts), because fetch is the
 *      only way out of this runtime;
 *   4. the report.
 *
 * KEYS. This file never reads one. The environment handed to the adapters is
 * a proxy that resolves a single named variable at the moment the executor
 * asks for it — which the executor does once, at submission, after
 * configuration, authorization, material, capability, prompt, deadline,
 * reservation and submission-eligibility have all passed. No key is copied,
 * printed, returned, logged or compared. Presence is checked with
 * Deno.env.has, which does not retrieve a value.
 */
/* FIRST, AND ON PURPOSE. Everything below reaches the kernel's import graph,
   which calls Buffer at module scope. See install-node-globals.ts. */
import { installedGlobals } from "../_shared/core-v2/install-node-globals.ts";

import declaration from "../../../workers/core-v2-canary/registry.canary.json" with { type: "json" };
import {
  authorizedConfig, CANARY_AUTHORIZED, CANARY_CURRENCY, CANARY_ID, CANARY_MAXIMUM_SUBMISSIONS,
  loadOperatorRegistry, PAID_CALLS_VARIABLE, worstCase,
} from "../../../workers/core-v2-canary/operator-registry.ts";
import { entityId } from "../../../workers/core-v2/kernel/ids.ts";
import { RoleRegistry } from "../../../workers/core-v2/kernel/roles.ts";
import { syntheticRecordSet } from "../../../workers/core-v2/domains/synthetic-records/fixture.ts";
import { SyntheticRecordsPack } from "../../../workers/core-v2/domains/synthetic-records/pack.ts";
import { PostgresOrchestrationRepository } from "../../../workers/core-v2/postgres/repository.ts";
import type { WorkPacket } from "../../../workers/core-v2/kernel/contracts.ts";
import { BudgetLedger } from "../../../workers/core-v2-runtime/budget/ledger.ts";
import { meteredRepository } from "../../../workers/core-v2-runtime/budget/metered.ts";
import { Dispatcher, enqueueWorkflow } from "../../../workers/core-v2-runtime/dispatcher.ts";
import { compilePrompt } from "../../../workers/core-v2-runtime/prompt-compiler.ts";
import { buildProviderRegistry } from "../../../workers/core-v2-runtime/providers/registry.ts";
import { InMemoryMaterialResolver } from "../../../workers/core-v2-runtime/material/memory-resolver.ts";
import type { StoredMaterial } from "../../../workers/core-v2-runtime/material/memory-resolver.ts";
import { EdgeDatabase, CONNECT_TIMEOUT_MS, DatabaseUnreachable } from "../_shared/core-v2/deno-postgres.ts";
import { DenoFetchTransport } from "../_shared/core-v2/deno-transport.ts";

/* The digest of the one-time trigger. The token itself was generated on the
   operator's machine, never written to the repository and never stored here:
   what is deployed is a hash, which is not a credential and cannot be turned
   back into one. */
const TRIGGER_DIGEST = "4742b3d5ac4960acdc4c41d293569ebd3b225bd4bafca3758a2b995183936e94";
const TRIGGER_HEADER = "x-canary-trigger";
const TRIGGER_VARIABLE = "CORE_V2_CANARY_TRIGGER";

/* Attempt states that mean a provider may already have been asked, and so
   may already have charged. A canary runs once; these are how it knows. */
const MAY_HAVE_BEEN_BILLED = [
  "submitted", "response_received", "parsed", "succeeded",
  "failed_known", "output_limited", "outcome_unknown",
];

/* The whole function must finish inside the platform's own wall clock. The
   drain is stopped before that, so an attempt in flight is recorded as an
   outcome nobody knows rather than lost with the container. */
const DRAIN_DEADLINE_MS = 140_000;

/* A pass killed mid-flight orphans whatever it had submitted, and the next
   pass finds those leases expired. The engine then does the right thing and
   the wrong thing at once: it refuses to settle a subject whose blind reader
   was lost, raises a coverage disagreement and escalates it to a person —
   correct, and entirely caused by the wall clock rather than by anything
   either reader said. The three numbers below are how that is avoided, and
   they are one piece of arithmetic, not three preferences. */

/* HOW LONG A PROVIDER MAY TAKE, AS OPPOSED TO HOW LONG IT SAYS IT MAY TAKE.
 *
 * The declaration allows each provider two minutes. This operator does not
 * live two minutes past the last request it starts, so authorising two
 * minutes would authorise a wait it cannot sit through — and a request still
 * outstanding when the container goes is not a slow answer, it is an attempt
 * whose outcome nobody will ever know. The engine never retries one of
 * those, so every one of them costs a subject its coverage.
 *
 * Sixty seconds, and the number has been measured three times. Most answers
 * come back between six and twenty. At thirty, one table reader was cut off
 * at 30004 ms; at forty-five, two readers of the same wave were cut off
 * together at 45002 and 45004 ms — the same provider that had answered in
 * eleven seconds one generation earlier, slower because four requests went
 * out at once. Every one of those is a reading lost to the clock rather
 * than to anything the reader said, which is the exact failure this canary
 * keeps having to stop causing. A provider that does not answer inside
 * sixty still becomes a KNOWN failure, on this pass, with a reason the
 * engine can act on. */
const ANSWER_WITHIN_MS = 60_000;

/* The room a finished answer needs after it arrives: parsed, validated,
   priced, settled, its claims and anchors written, its task closed. */
const SETTLEMENT_ROOM_MS = 20_000;

/* WHEN TO STOP STARTING, AS OPPOSED TO WHEN TO STOP — and it is derived, not
   chosen. The last request this pass starts must be able to answer inside
   its window and still be written down before the container goes. Everything
   before that moment is time the pass can spend on work. The first version
   of this file picked forty-five seconds by hand while a provider was
   allowed two minutes; the arithmetic did not hold, and the pass spent a
   third of its life starting work and the rest not allowed to. */
const STOP_STARTING_MS = DRAIN_DEADLINE_MS - ANSWER_WITHIN_MS - SETTLEMENT_ROOM_MS;

/* HOW LONG A LEASE LASTS, AND WHY IT IS THE OPERATOR'S NUMBER TOO.
 *
 * The default is five minutes, which is right for a worker that outlives
 * its work. This one does not: the container is gone after two and a half,
 * and every lease it was holding stays held for another two and a half
 * after that. The next pass then finds four readers "leased" and "running"
 * by a process that no longer exists, cannot reclaim them because their
 * leases are still in the future, finds nothing runnable behind them, and
 * declares the workflow stalled — a whole pass spent, nothing dispatched.
 * That is exactly what generation nine's second pass did.
 *
 * A lease has to outlive the work it covers and nothing more: one answer
 * inside its window, plus the room to write it down. While the work really
 * is running the heartbeat renews it every twenty seconds, so a short lease
 * is never taken from a live attempt — only from a dead one, which is the
 * whole point. */
const LEASE_TTL_MS = ANSWER_WITHIN_MS + SETTLEMENT_ROOM_MS + 40_000;

/* HOW MANY ATTEMPTS MAY BE IN FLIGHT AT ONCE. Wide enough that every blind
   reader of a sheet starts in the same wave: readers that start one at a
   time cost a tick each, and a tick against this record is twenty to thirty
   seconds of round trips. The money is bounded by the authority and the
   attempt cap, which are the fuses that matter — this is only how many of
   them may be open together. */
const CONCURRENT_ATTEMPTS = 6;

/* WHICH RUN THIS IS. The canary id is immutable per run; a run whose
   workflow already reached a terminal state cannot be continued, so a
   corrected attempt gets the next generation and its own workflow. The
   synthetic tenancy is deliberately NOT per generation: one organisation
   holds every canary, which is what makes the lifetime ceiling below a
   single question with a single answer. */
const PINNED_GENERATION = Deno.env.get("CORE_V2_CANARY_GENERATION");
const MAXIMUM_GENERATIONS = 50;
const runIdFor = (generation: number) => `${CANARY_ID}-g${generation}`;
const workflowIdFor = (generation: number) => entityId("core-v2-canary-workflow", runIdFor(generation));

/* A WORKFLOW IS FINISHED WHEN ITS WORK IS, NOT WHEN ONE PASS RAN OUT OF TIME.
 *
 * An Edge Function has a wall clock of about two and a half minutes and a
 * real reader takes twenty seconds, so an eleven-task workflow does not fit
 * in one invocation — and it was never meant to. The outbox, the leases and
 * the durable record exist precisely so a dispatcher can stop and another
 * can pick the work up.
 *
 * So the question a fresh dispatch asks is not "what state is the workflow
 * in" but "are there tasks still to do". A generation-6 run stopped with
 * two completed, four readers leased or running and five comparisons and
 * totals blocked behind them; that is a workflow to continue, not one to
 * abandon and start again beside. */
const TASK_IS_DONE = ["completed", "failed_known", "outcome_unknown", "cancelled", "superseded"];

/* THE RECORD IS REACHED THROUGH THE POOLER, AND THE PASSWORD STAYS PUT.
 *
 * Two ways to be told where, and the second exists because of a measured
 * failure. Run 34380529340 built the url in the Action from
 * secrets.SUPABASE_DB_PASSWORD, which came through EMPTY, and the driver
 * said so in 56ms: "Attempting SASL auth with unset password". Nothing was
 * wrong with Supavisor; there was simply no password in it.
 *
 *   1. CORE_V2_CANARY_DB_URL — a complete url the operator built and handed
 *      in. Used when it is set.
 *   2. the pooler's HOST, PORT, USER and NAME as separate non-secret facts,
 *      read from the Management API by the Action, combined here with the
 *      password out of the platform's own SUPABASE_DB_URL.
 *
 * The second is the better of the two on its own merits: the password never
 * leaves the platform, never enters a runner, never enters a log and never
 * enters a GitHub secret listing. Only the route is assembled; the
 * credential is where it already was. */
const DATABASE_VARIABLE = "CORE_V2_CANARY_DB_URL";
const POOLER_HOST_VARIABLE = "CORE_V2_CANARY_DB_HOST";
const POOLER_PORT_VARIABLE = "CORE_V2_CANARY_DB_PORT";
const POOLER_USER_VARIABLE = "CORE_V2_CANARY_DB_USER";
const POOLER_NAME_VARIABLE = "CORE_V2_CANARY_DB_NAME";

type Route = { url: string; describe: string; passwordFrom: string };

/* Never returns the url in anything that gets printed: `describe` is host,
   port and database only. */
function routeToRecord(): Route | { problem: string } {
  const complete = Deno.env.get(DATABASE_VARIABLE);
  if (complete) {
    let describe = "unparseable";
    try {
      const parsed = new URL(complete);
      if (!parsed.password) return { problem: `${DATABASE_VARIABLE} carries no password` };
      describe = `${parsed.hostname}:${parsed.port || "5432"}${parsed.pathname}`;
    } catch {
      return { problem: `${DATABASE_VARIABLE} is not a url` };
    }
    return { url: complete, describe, passwordFrom: DATABASE_VARIABLE };
  }

  const host = Deno.env.get(POOLER_HOST_VARIABLE);
  const user = Deno.env.get(POOLER_USER_VARIABLE);
  if (!host || !user) {
    return { problem: `neither ${DATABASE_VARIABLE} nor ${POOLER_HOST_VARIABLE}/${POOLER_USER_VARIABLE} is set; there is no record to write to` };
  }
  const port = Deno.env.get(POOLER_PORT_VARIABLE) || "5432";
  const name = Deno.env.get(POOLER_NAME_VARIABLE) || "postgres";

  const platform = Deno.env.get("SUPABASE_DB_URL");
  if (!platform) return { problem: "SUPABASE_DB_URL is not set, so there is no password to reach the pooler with" };
  let password = "";
  try {
    password = new URL(platform).password;
  } catch {
    return { problem: "SUPABASE_DB_URL is not a url" };
  }
  if (!password) return { problem: "SUPABASE_DB_URL carries no password" };

  return {
    url: `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(decodeURIComponent(password))}@${host}:${port}/${name}`,
    describe: `${host}:${port}/${name}`,
    passwordFrom: "SUPABASE_DB_URL (the platform's own, never copied out)",
  };
}

const ORGANIZATION_ID = entityId("core-v2-canary-organization", "core-v2-canary");

/* WHICH GENERATION THIS DISPATCH IS.
 *
 * A finished workflow is never re-run, so a corrected canary needs the next
 * generation — and having a person remember to bump a number is how a
 * dispatch turns into a 409 instead of a run. So it is worked out from the
 * record: the generations' workflow ids are derived, asked about in one
 * query, and the first that either does not exist or has not finished is
 * this run's. An operator can still pin one with
 * CORE_V2_CANARY_GENERATION when they want a specific workflow. */
async function chooseGeneration(db: EdgeDatabase, startFresh = false): Promise<{ generation: number; runId: string; workflowId: string; resuming: boolean; generationsInTheRecord: number[] }> {
  if (PINNED_GENERATION) {
    const pinned = Number(PINNED_GENERATION);
    return { generation: pinned, runId: runIdFor(pinned), workflowId: workflowIdFor(pinned), resuming: false, generationsInTheRecord: [] };
  }
  const candidates: string[] = [];
  for (let g = 1; g <= MAXIMUM_GENERATIONS; g++) candidates.push(workflowIdFor(g));
  /* Unfinished tasks are not the same as work a machine can still do. An
     attempt whose outcome nobody knows is never retried automatically — a
     person authorises that — so a workflow the engine has escalated is one
     the engine has finished with, however many tasks are still open on it.
     Counting those as resumable would wedge the canary on a workflow
     waiting for a human forever.

     `startFresh` is the operator saying this pass is a beginning and not a
     continuation. It exists for one situation and says so plainly: a
     generation left half-run by a DEFECT IN THIS OPERATOR — a lease that
     outlived the process, a request the container was killed underneath —
     is not a workflow that has learned anything, and resuming it only
     carries the damage forward. It never deletes or rewrites what that
     generation recorded: those rows stay exactly as they are, holds
     included, and the next generation starts beside them with the money
     they committed already subtracted from the lifetime authority. */
  const seen = await db.query(
    `select w.id::text as id,
            (select count(*) from public.workflow_tasks k
              where k.workflow_id = w.id and k.state <> all($2::text[]))::text as unfinished,
            (select count(*) from public.disagreements d
              where d.workflow_id = w.id and d.state = 'needs_human')::text as awaiting_person
       from public.intelligence_workflows w where w.id = any($1::uuid[])`,
    [`{${candidates.join(",")}}`, `{${TASK_IS_DONE.join(",")}}`],
  );
  const standingOf = new Map(seen.rows.map((row) => [String(row.id), {
    unfinished: Number(row.unfinished ?? "0"),
    awaitingPerson: Number(row.awaiting_person ?? "0"),
  }]));
  /* THE NEWEST RESUMABLE ONE, NOT THE OLDEST.
     Scanning upwards finds the earliest generation with anything open, which
     is the oldest zombie — a run some earlier defect left half-done — and a
     pass spent there is a pass not spent on the work that is actually
     advancing. The generation that has got furthest is the last one. */
  let firstUnused = 0;
  let newestResumable = 0;
  const generationsInTheRecord: number[] = [];
  for (let g = 1; g <= MAXIMUM_GENERATIONS; g++) {
    const found = standingOf.get(workflowIdFor(g));
    if (found === undefined) { if (firstUnused === 0) firstUnused = g; continue; }
    generationsInTheRecord.push(g);
    if (found.unfinished > 0 && found.awaitingPerson === 0) newestResumable = g;
  }
  if (!startFresh && newestResumable > 0) {
    return { generation: newestResumable, runId: runIdFor(newestResumable), workflowId: workflowIdFor(newestResumable), resuming: true, generationsInTheRecord };
  }
  if (firstUnused > 0) return { generation: firstUnused, runId: runIdFor(firstUnused), workflowId: workflowIdFor(firstUnused), resuming: false, generationsInTheRecord };
  throw new Error(`core-v2-canary: ${MAXIMUM_GENERATIONS} generations have all finished; nothing further runs without a decision`);
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* Equal-length, constant-time-ish: both sides are hex digests of the same
   width, so there is nothing to leak but the digest itself. */
function sameDigest(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let differing = 0;
  for (let i = 0; i < a.length; i++) differing |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return differing === 0;
}

/* AN ENVIRONMENT THAT ANSWERS ONE QUESTION AT A TIME. The adapters are given
   this, not a copy of the process environment: the only variable read is the
   one an executor asks for, at the moment it asks. */
function lazyEnvironment(): Record<string, string | undefined> {
  return new Proxy({}, {
    get: (_target, name) => (typeof name === "string" ? Deno.env.get(name) : undefined),
    has: (_target, name) => typeof name === "string" && Deno.env.has(name),
  }) as Record<string, string | undefined>;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { "content-type": "application/json" } });

Deno.serve(async (request: Request): Promise<Response> => {
  const started = Date.now();
  if (request.method !== "POST") return json(405, { refused: "this function is invoked once, with POST" });

  /* ── 1 · the trigger ───────────────────────────────────────────────── */
  const offered = request.headers.get(TRIGGER_HEADER) ?? "";
  if (!offered) return json(401, { refused: `no ${TRIGGER_HEADER}` });
  /* Two ways to hold the lock, and exactly one is in force. When the
     operator set the secret, that is the trigger and the digest below is
     irrelevant — no source is edited to deploy. When they did not, the
     digest compiled in at deploy time is the trigger, and its token was
     generated on the operator's machine, never written to the repository
     and never stored here: a hash is not a credential. */
  const storedTrigger = Deno.env.get(TRIGGER_VARIABLE);
  if (storedTrigger !== undefined && storedTrigger !== "") {
    if (!sameDigest(await sha256Hex(offered), await sha256Hex(storedTrigger))) {
      return json(401, { refused: `the trigger does not match ${TRIGGER_VARIABLE}` });
    }
  } else if (!sameDigest(await sha256Hex(offered), TRIGGER_DIGEST)) {
    return json(401, { refused: "the trigger does not match" });
  }

  let body: Record<string, unknown> = {};
  try { body = await request.json() as Record<string, unknown>; } catch { body = {}; }

  /* ── 1a · the probe, which cannot spend ────────────────────────────────
     Before the registry, before any provider secret is even asked about,
     before a gate can be opened. It reaches the record and nothing else. */
  if (body.probeDatabaseOnly === true) return await probeDatabase();

  /* ── 2 · the operator's registry ───────────────────────────────────── */
  const loaded = loadOperatorRegistry(JSON.stringify(declaration), "registry.canary.json");
  if (!loaded.registry) return json(412, { refused: "the operator registry does not pass every check", problems: loaded.problems });
  const registry = loaded.registry;

  /* ── 3 · the secrets exist, by NAME, without retrieving one ────────── */
  const missingSecrets = registry.config.providers
    .filter((provider) => !Deno.env.has(provider.apiKeyEnvironmentVariable))
    .map((provider) => provider.apiKeyEnvironmentVariable);
  if (missingSecrets.length > 0) {
    return json(412, { refused: "a provider secret is not configured; nobody was called", missingSecrets });
  }

  /* ── 4 · the gates ─────────────────────────────────────────────────── */
  const environment = lazyEnvironment();
  const gateFromEnvironment = Deno.env.get(PAID_CALLS_VARIABLE) === "true";
  const gateFromInvocation = body.allowPaidCalls === true;
  const networkFlag = body.allowProviderNetwork === true;
  if (!networkFlag) return json(412, { refused: "the invocation did not ask for the provider network" });
  if (!gateFromEnvironment && !gateFromInvocation) {
    return json(412, { refused: `neither ${PAID_CALLS_VARIABLE} nor the invocation opened the paid-calls gate` });
  }
  const assembled = authorizedConfig(registry, {
    networkFlag,
    environment: gateFromEnvironment ? environment : { [PAID_CALLS_VARIABLE]: "true" },
    answerWithinMs: ANSWER_WITHIN_MS,
  });
  const config = assembled;

  /* ── 5 · the arithmetic, before anything is opened ─────────────────── */
  const worst = worstCase(config);
  if (worst.problems.length > 0 || !worst.fits) {
    return json(412, {
      refused: "the worst case does not fit inside the authority",
      perAttempt: worst.perAttempt, wholeCanary: worst.wholeCanary, authorized: CANARY_AUTHORIZED, problems: worst.problems,
    });
  }

  const route = routeToRecord();
  if ("problem" in route) return json(412, { refused: route.problem });
  const databaseUrl = route.url;

  const events: unknown[] = [];
  let db: EdgeDatabase | null = null;
  let dispatcherDb: EdgeDatabase | null = null;
  /* Named before the generation is known, so a failure on the way to
     knowing it still has something to report. */
  let RUN_ID = CANARY_ID;
  let WORKFLOW_ID = "";
  try {
    db = await EdgeDatabase.connect(databaseUrl, CANARY_ID);
    dispatcherDb = await EdgeDatabase.connect(databaseUrl, `${CANARY_ID}-dispatcher`);

    /* ── 5a · which generation, decided from the record ──────────────── */
    const chosen = await chooseGeneration(db, body.startNewGeneration === true);
    RUN_ID = chosen.runId;
    WORKFLOW_ID = chosen.workflowId;

    /* ── 6 · a synthetic tenancy of its own ──────────────────────────── */
    await db.query(
      `insert into public.organizations(id, name) values ($1, $2) on conflict (id) do nothing`,
      [ORGANIZATION_ID, `synthetic — ${CANARY_ID}`],
    );

    /* ── 7 · this generation runs once, and the $5 is a LIFETIME ceiling ─
       Every canary generation shares one synthetic organisation, so what
       previous generations committed is one query. The authority for this
       run is what is left of the five dollars, not five dollars again. */
    const standing = await db.query(
      `select w.state,
              (select count(*) from public.workflow_tasks k
                where k.workflow_id = w.id and k.state <> all($2::text[]))::text as unfinished,
              (select count(*) from public.disagreements d
                where d.workflow_id = w.id and d.state = 'needs_human')::text as awaiting_person
         from public.intelligence_workflows w where w.id = $1`,
      [WORKFLOW_ID, `{${TASK_IS_DONE.join(",")}}`],
    );
    const state = standing.rows[0]?.state ?? null;
    const unfinishedTasks = Number(standing.rows[0]?.unfinished ?? "0");
    const awaitingPerson = Number(standing.rows[0]?.awaiting_person ?? "0");
    if (state !== null && (unfinishedTasks === 0 || awaitingPerson > 0)) {
      return json(409, {
        refused: awaitingPerson > 0
          ? `${RUN_ID} is waiting for a person on ${awaitingPerson} disagreement(s); the engine is finished with it`
          : `${RUN_ID} has no work left (state "${state}"); a finished workflow is not re-run`,
        hint: "set CORE_V2_CANARY_GENERATION to the next number for a fresh workflow",
        workflowId: WORKFLOW_ID,
      });
    }
    const priorSubmissions = Number((await db.query(
      `select count(*)::text as n from public.agent_attempts where workflow_id = $1 and state = any($2::text[])`,
      [WORKFLOW_ID, `{${MAY_HAVE_BEEN_BILLED.join(",")}}`],
    )).rows[0]?.n ?? "0");

    const spentBefore = await db.query(
      `select coalesce(sum(coalesce(b.reserved, 0) + coalesce(b.settled, 0)), 0)::text as committed
         from public.workflow_cost_budgets b
        where b.organization_id = $1 and b.workflow_id <> $2`,
      [ORGANIZATION_ID, WORKFLOW_ID],
    );
    const committedBefore = Number(spentBefore.rows[0]?.committed ?? "0");
    const lifetimeRemaining = Math.max(0, Math.round((CANARY_AUTHORIZED - committedBefore) * 1e6) / 1e6);
    if (lifetimeRemaining < worst.perAttempt) {
      return json(409, {
        refused: "the lifetime authority is spent",
        authorized: CANARY_AUTHORIZED, committedBefore, lifetimeRemaining, perAttempt: worst.perAttempt,
      });
    }
    /* The fuse, in attempts: as many as fit inside what is left, and never
       more than a bounded number however much is left. */
    const maximumAttempts = Math.max(1, Math.min(CANARY_MAXIMUM_SUBMISSIONS, Math.floor(lifetimeRemaining / worst.perAttempt)));

    /* ── 8 · the invented material, and nobody's document ────────────── */
    /* Seeded by the RUN, not by the canary. The fixture derives its source
       identities from the seed, and workflow_sources is keyed on them — so a
       second generation seeded with the first one's name collides on
       workflow_sources_pkey before a single task is planned. Generation 2
       found that; the seed is the generation's. */
    const resuming = chosen.resuming;
    const truth = syntheticRecordSet({
      seed: RUN_ID, sources: 1, sheetsPerSource: 1, entriesPerTable: 3,
      organizationId: ORGANIZATION_ID, workflowId: WORKFLOW_ID,
    });
    if (!truth.manifest.sources.every((s) => s.uri.startsWith("fixture://"))) {
      return json(500, { refused: "the canary runs on invented sources only" });
    }
    const pack = new SyntheticRecordsPack();
    const roles = new RoleRegistry(pack);
    /* EVERY GENERATION'S MATERIAL, NOT JUST THIS ONE'S.
     *
     * A pass chooses one generation and builds that generation's fixture —
     * and then hands the dispatcher a resolver, which serves whatever
     * workflow the dispatcher goes on to touch. It touches more than one:
     * the order it works through is what it claimed, plus what the record
     * offers as resumable, plus what is left unreconciled. Each of those is
     * a different generation with a different seed, and material is looked
     * up by content hash — so every workflow but the chosen one was being
     * asked for hashes this map had never heard of, and every task in it
     * failed with "no material came back". A critic in generation twelve
     * died of being handed generation nine's fixture.
     *
     * The hashes of two generations never collide — different seed, different
     * bytes — so the union is unambiguous, and it is what a resolver serving
     * more than one workflow has to hold. It costs a few kilobytes per
     * generation, computed once, in memory. */
    const stored = new Map<string, StoredMaterial>();
    const fixtureInto = (seed: string, workflowId: string) => {
      const set = syntheticRecordSet({
        seed, sources: 1, sheetsPerSource: 1, entriesPerTable: 3,
        organizationId: ORGANIZATION_ID, workflowId,
      });
      for (const [hash, item] of set.material) {
        if (!stored.has(hash)) stored.set(hash, { mediaKind: item.mediaKind, mimeType: item.mimeType, bytes: item.bytes });
      }
    };
    for (const g of chosen.generationsInTheRecord) fixtureInto(runIdFor(g), workflowIdFor(g));
    fixtureInto(RUN_ID, WORKFLOW_ID);

    /* ── 9 · the record and the durable budget ───────────────────────── */
    const ledger = new BudgetLedger(db as never, config);
    /* A RESUMED WORKFLOW IS ALREADY IN THE RECORD, AND SO IS ITS BUDGET.
     *
     * Enqueuing it again would be a second start command for work already
     * underway, and re-authorizing it is worse: the ledger compares an
     * existing authorization against the one offered and refuses when they
     * differ, which is exactly right and is what a resumed pass ran into
     * when it offered a different concurrency. The authority a workflow was
     * started under is the authority it finishes under. */
    if (!resuming) {
      await enqueueWorkflow(new PostgresOrchestrationRepository(db as never, { organizationId: ORGANIZATION_ID }), truth.manifest, pack);
      await ledger.authorizeWorkflow({
        workflowId: WORKFLOW_ID, organizationId: ORGANIZATION_ID, currency: CANARY_CURRENCY,
        authorizedMaximum: lifetimeRemaining,
        maximumPerAttempt: worst.perAttempt,
        maximumAttempts,
        maximumConcurrentAttempts: CONCURRENT_ATTEMPTS,
        /* THESE TWO ARE HELD TOTALS, NOT PER-REQUEST CEILINGS.
         *
         * The ledger checks them as `reserved_input_tokens + this attempt >
         * maximum_input_tokens`, so they bound what may be HELD AT ONCE
         * across the workflow. Handing it one provider's per-request ceiling
         * therefore authorised exactly one model attempt in flight, whatever
         * maximumConcurrentAttempts said — and that is what every generation
         * of this canary has actually been doing: one reader at a time, each
         * costing a tick, the container gone before the fourth.
         *
         * The number that belongs here is what six attempts at that ceiling
         * would hold. Nothing about a single request is loosened by it: each
         * attempt is still capped at its own provider's ceiling where that
         * ceiling belongs, in the packet and in the request. */
        maximumInputTokens: CONCURRENT_ATTEMPTS * Math.max(...config.providers.map((p) => p.maximumInputTokens)),
        maximumOutputTokens: CONCURRENT_ATTEMPTS * Math.max(...config.providers.map((p) => p.maximumOutputTokens)),
      });
    }

    /* ── 10 · the door, built last ───────────────────────────────────── */
    const transport = new DenoFetchTransport({ config });
    const executors = buildProviderRegistry({
      config, transport, routing: registry.routing,
      compilePrompt: (packet: WorkPacket) => compilePrompt(packet, roles.role(packet.roleKey)),
      materialResolver: new InMemoryMaterialResolver(stored),
      environment,
    });

    const winding = new AbortController();
    const dispatcher = new Dispatcher({
      /* Names this generation, so the outbox and every event say which run
         they belong to. */
      name: RUN_ID,
      signal: winding.signal,
      connect: async () => dispatcherDb as never,
      repository: () => meteredRepository(
        new PostgresOrchestrationRepository(dispatcherDb as never, { organizationId: ORGANIZATION_ID }),
        {
          ledger: new BudgetLedger(dispatcherDb as never, config), config,
          providerOfFamily: (family: string) => registry.routing[family] ?? null,
        },
      ),
      pack,
      leaseTtlMs: LEASE_TTL_MS,
      /* One workflow gets this pass. The container lives long enough for one
         workflow's phases and not for four's, and spreading a short clock
         over several leaves all of them half-done. */
      workflowsPerPass: 1,
      executors: () => executors.registry,
      events: (event: unknown) => { events.push(event); },
      now: () => Date.now(),
      backoff: { baseMs: 50, ceilingMs: 250, jitter: 0, random: () => 0 },
    });

    let deadlineReached = false;
    const deadline = new Promise<void>((resolve) => setTimeout(() => { deadlineReached = true; resolve(); }, DRAIN_DEADLINE_MS));
    const stopStarting = setTimeout(() => { deadlineReached = true; winding.abort(); }, STOP_STARTING_MS);
    await Promise.race([dispatcher.drain(), deadline]);
    /* Waits for what is already in flight rather than dropping it. */
    await dispatcher.stop();
    clearTimeout(stopStarting);

    /* ── 11 · close the authority, whatever happened ─────────────────── */
    /* Only when there is nothing left to do. Closing the authority on a
       pass that merely ran out of clock would strand the rest of the work. */
    const left = Number((await db.query(
      `select count(*)::text as n from public.workflow_tasks
        where workflow_id = $1 and state <> all($2::text[])`,
      [WORKFLOW_ID, `{${TASK_IS_DONE.join(",")}}`],
    )).rows[0]?.n ?? "0");
    if (left === 0) await ledger.stop(WORKFLOW_ID, deadlineReached
      ? `${RUN_ID} stopped at its deadline — unused authority closed`
      : `${RUN_ID} complete — unused authority closed`).catch(() => undefined);

    return json(200, await report(db, ledger, RUN_ID, WORKFLOW_ID, {
      transport: transport.name,
      allowedOrigins: transport.allowedOrigins,
      unresolvedHosts: transport.unresolvedHosts,
      gate: gateFromEnvironment ? PAID_CALLS_VARIABLE : "invocation",
      installedGlobals,
      generation: chosen.generation,
      runId: RUN_ID,
      resumingAnUnfinishedWorkflow: chosen.resuming,
      lifetimeAuthorized: CANARY_AUTHORIZED,
      committedByEarlierGenerations: committedBefore,
      lifetimeRemaining,
      maximumAttempts,
      priorSubmissionsThisWorkflow: priorSubmissions,
      worstAttempt: worst.perAttempt,
      worstCanary: worst.wholeCanary,
      deadlineReached,
      tasksLeft: left,
      events,
      elapsedMs: Date.now() - started,
    }));
  } catch (error) {
    return json(500, {
      refused: "the canary stopped",
      why: String((error as Error).message ?? error).slice(0, 400),
      workflowId: WORKFLOW_ID,
      organizationId: ORGANIZATION_ID,
      events,
    });
  } finally {
    await dispatcherDb?.end().catch(() => undefined);
    await db?.end().catch(() => undefined);
  }
});


/* ══════════════════════════════════════════════════════════════════════════
   THE PROBE. IT CANNOT SPEND.
 
   It reads no provider key, opens no gate, builds no transport, plans no
   workflow and writes no row. What it proves is the one thing the paid path
   depends on and the first run never got to test: that this connection can
   hold a multi-statement transaction with a savepoint inside it, on ONE
   backend, and that the objects migrations 058 and 059 create are visible
   from here.
 
   The savepoint proof is deliberately side-effect free. set_config(..., true)
   is transaction-local, so writing a marker, taking a savepoint, overwriting
   the marker and rolling back to the savepoint proves the rollback discarded
   the later write on the same session — without creating a table, a row or a
   sequence. pg_backend_pid() is read at every stage: a pooler that moved the
   session between statements would show a different number, and transaction
   mode would fail here rather than in the middle of a paid submission.
   ══════════════════════════════════════════════════════════════════════════ */
async function probeDatabase(): Promise<Response> {
  const phases: { phase: string; ms: number; detail?: unknown }[] = [];
  const timed = async <T>(phase: string, fn: () => Promise<T>): Promise<T> => {
    const at = Date.now();
    try {
      const out = await fn();
      phases.push({ phase, ms: Date.now() - at, detail: out });
      return out;
    } catch (error) {
      phases.push({ phase, ms: Date.now() - at, detail: `FAILED: ${String((error as Error).message ?? error).slice(0, 300)}` });
      throw error;
    }
  };

  const chosen = routeToRecord();
  if ("problem" in chosen) {
    return json(412, { probe: true, ok: false, refused: chosen.problem, installedGlobals, phases });
  }
  const databaseUrl = chosen.url;
  const route = chosen.describe;
  const passwordFrom = chosen.passwordFrom;

  let db: EdgeDatabase | null = null;
  try {
    /* One connection, opened once, with the deadline the first run lacked. */
    const at = Date.now();
    try {
      db = await EdgeDatabase.connect(databaseUrl, `${CANARY_ID}-probe`, CONNECT_TIMEOUT_MS);
      phases.push({ phase: "connect", ms: Date.now() - at, detail: { route, passwordFrom, tls: "required", connectTimeoutMs: CONNECT_TIMEOUT_MS } });
    } catch (error) {
      phases.push({ phase: "connect", ms: Date.now() - at, detail: `FAILED: ${String((error as Error).message ?? error).slice(0, 300)}` });
      throw error;
    }

    const one = await timed("select 1", async () => (await db!.query("select 1 as one")).rows[0]?.one);
    const pidBefore = await timed("backend pid, before", async () => (await db!.query("select pg_backend_pid()::text as pid")).rows[0]?.pid);

    const inTransaction = await timed("begin, savepoint, rollback to savepoint, commit", async () => {
      return await db!.transaction(async (tx) => {
        const pidInside = (await tx.query("select pg_backend_pid()::text as pid")).rows[0]?.pid;
        await tx.query("select set_config('core_v2.probe', 'before-savepoint', true)");
        await tx.query("savepoint core_v2_probe");
        await tx.query("select set_config('core_v2.probe', 'after-savepoint', true)");
        const afterWrite = (await tx.query("select current_setting('core_v2.probe', true) as marker")).rows[0]?.marker;
        await tx.query("rollback to savepoint core_v2_probe");
        const afterRollback = (await tx.query("select current_setting('core_v2.probe', true) as marker")).rows[0]?.marker;
        const pidAfterRollback = (await tx.query("select pg_backend_pid()::text as pid")).rows[0]?.pid;
        return { pidInside, afterWrite, afterRollback, pidAfterRollback };
      });
    });
    const pidAfter = await timed("backend pid, after commit", async () => (await db!.query("select pg_backend_pid()::text as pid")).rows[0]?.pid);

    const objects = await timed("migrations 058 and 059 are visible", async () => (await db!.query(`
      select
        to_regclass('public.intelligence_workflows')::text     as workflows,
        to_regclass('public.agent_attempts')::text             as attempts,
        to_regclass('public.workflow_cost_budgets')::text      as budgets,
        to_regclass('public.attempt_cost_reservations')::text  as reservations,
        to_regprocedure('public.core_v2_submit_attempt(uuid,uuid)')::text as submit_door,
        (select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'core_v2_reserve_attempt_cost') as reserve_door
    `)).rows[0]);

    /* Every one of these must hold, or the paid path does not run. */
    const oneBackend = pidBefore === inTransaction.pidInside
      && inTransaction.pidInside === inTransaction.pidAfterRollback
      && inTransaction.pidAfterRollback === pidAfter;
    const savepointHeld = inTransaction.afterWrite === "after-savepoint"
      && inTransaction.afterRollback === "before-savepoint";
    const schemaVisible = Boolean(objects?.workflows && objects?.attempts && objects?.budgets
      && objects?.reservations && objects?.submit_door && objects?.reserve_door !== "0");
    const ok = one === "1" && oneBackend && savepointHeld && schemaVisible;

    return json(ok ? 200 : 409, {
      probe: true,
      ok,
      route,
      passwordFrom,
      installedGlobals,
      checks: {
        selectOne: one === "1",
        oneBackend,
        savepointHeld,
        schemaVisible,
      },
      backendPids: {
        before: pidBefore,
        insideTransaction: inTransaction.pidInside,
        afterRollbackToSavepoint: inTransaction.pidAfterRollback,
        afterCommit: pidAfter,
      },
      savepointMarker: { afterWrite: inTransaction.afterWrite, afterRollback: inTransaction.afterRollback },
      objects,
      phases,
    });
  } catch (error) {
    return json(500, {
      probe: true,
      ok: false,
      route,
      passwordFrom,
      installedGlobals,
      why: String((error as Error).message ?? error).slice(0, 400),
      unreachablePhase: error instanceof DatabaseUnreachable ? error.phase : null,
      phases,
    });
  } finally {
    await db?.end().catch(() => undefined);
  }
}

/* WHAT HAPPENED, READ BACK OUT OF THE RECORD rather than remembered. */
async function report(db: EdgeDatabase, ledger: BudgetLedger, RUN_ID: string, WORKFLOW_ID: string, extra: Record<string, unknown>): Promise<Record<string, unknown>> {
  const rows = async (sql: string, params: (string | number)[] = []) => (await db.query(sql, params)).rows;
  const standing = await ledger.standing(WORKFLOW_ID).catch(() => null);
  return {
    canaryId: RUN_ID,
    workflowId: WORKFLOW_ID,
    organizationId: ORGANIZATION_ID,
    authorized: CANARY_AUTHORIZED,
    currency: CANARY_CURRENCY,
    maximumSubmissionsCeiling: CANARY_MAXIMUM_SUBMISSIONS,
    ...extra,
    workflow: (await rows(`select state, cancel_requested_at, started_at, finished_at from public.intelligence_workflows where id = $1`, [WORKFLOW_ID]))[0] ?? null,
    attempts: await rows(
      `select a.id, a.role_key, a.executor_family, a.independence_domain, a.model_configuration, a.model_reported,
              a.state, a.provider_request_id, a.usage::text as usage, a.error_code, a.error_message,
              a.validation_state, a.validation_problems::text as validation_problems,
              a.submitted_at, a.finished_at
         from public.agent_attempts a where a.workflow_id = $1 order by a.created_at`, [WORKFLOW_ID]),
    reservations: await rows(
      `select r.attempt_id, r.state, r.reserved_cost::text as reserved_cost, r.settled_cost::text as settled_cost,
              r.reserved_input_tokens, r.reserved_output_tokens,
              r.usage::text as raw_usage, r.normalized_usage::text as normalized_usage, r.normalization_version,
              r.price_basis::text as price_basis, r.release_reason, r.attention_reason,
              r.reserved_at, r.settled_at, r.released_at
         from public.attempt_cost_reservations r where r.workflow_id = $1 order by r.reserved_at`, [WORKFLOW_ID]),
    budget: standing,
    claims: await rows(
      `select c.id, c.subject_key, c.predicate, c.status, c.value::text as value, c.unit,
              c.independence_domain, c.observation_basis, c.scope, c.machine_confidence
         from public.evidence_claims c where c.workflow_id = $1 order by c.created_at`, [WORKFLOW_ID]),
    anchors: await rows(
      `select n.claim_id, n.assessment_id, n.source_kind, n.locator::text as locator, n.quoted_text
         from public.evidence_anchors n where n.workflow_id = $1`, [WORKFLOW_ID]),
    assessments: await rows(
      `select s.claim_id, s.attempt_id, s.assessment, s.reason_code, s.explanation,
              s.proposed_value::text as proposed_value, s.proposed_unit
         from public.claim_assessments s where s.workflow_id = $1`, [WORKFLOW_ID]),
    disagreements: await rows(
      `select d.id, d.disagreement_key, d.state, d.kind, d.severity, d.needs_human_reason,
              d.critic_rounds, d.arbiter_rounds, d.subject_signature::text as subject_signature
         from public.disagreements d where d.workflow_id = $1`, [WORKFLOW_ID]),
    decisions: await rows(
      `select d.id, d.decision_type, d.status, d.authority, d.subject_key, d.title, d.summary, d.rationale, d.risk_level
         from public.decisions d where d.workflow_id = $1`, [WORKFLOW_ID]),
    audit: await rows(
      `select action, entity_type, created_at from public.audit_events where action like 'core_v2.%' and entity_id = $1 order by created_at`, [WORKFLOW_ID]),
  };
}
