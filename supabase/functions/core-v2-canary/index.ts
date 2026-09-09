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
import { installedGlobals } from "./install-node-globals.ts";

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
import { CanaryDatabase, CONNECT_TIMEOUT_MS, DatabaseUnreachable } from "./deno-postgres.ts";
import { DenoFetchTransport } from "./deno-transport.ts";

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
const DRAIN_DEADLINE_MS = 110_000;

/* The record is reached through the pooler, at a url the operator builds and
   hands in. Not SUPABASE_DB_URL: a direct connection is a different route
   with different reachability, and this canary states which one it used. */
const DATABASE_VARIABLE = "CORE_V2_CANARY_DB_URL";

const ORGANIZATION_ID = entityId("core-v2-canary-organization", CANARY_ID);
const WORKFLOW_ID = entityId("core-v2-canary-workflow", CANARY_ID);

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
  const config = authorizedConfig(registry, {
    networkFlag,
    environment: gateFromEnvironment ? environment : { [PAID_CALLS_VARIABLE]: "true" },
  });

  /* ── 5 · the arithmetic, before anything is opened ─────────────────── */
  const worst = worstCase(config);
  if (worst.problems.length > 0 || !worst.fits) {
    return json(412, {
      refused: "the worst case does not fit inside the authority",
      perAttempt: worst.perAttempt, wholeCanary: worst.wholeCanary, authorized: CANARY_AUTHORIZED, problems: worst.problems,
    });
  }

  const databaseUrl = Deno.env.get(DATABASE_VARIABLE);
  if (!databaseUrl) return json(412, { refused: `${DATABASE_VARIABLE} is not set; there is no record to write to` });

  const events: unknown[] = [];
  let db: CanaryDatabase | null = null;
  let dispatcherDb: CanaryDatabase | null = null;
  try {
    db = await CanaryDatabase.connect(databaseUrl, CANARY_ID);
    dispatcherDb = await CanaryDatabase.connect(databaseUrl, `${CANARY_ID}-dispatcher`);

    /* ── 6 · a synthetic tenancy of its own ──────────────────────────── */
    await db.query(
      `insert into public.organizations(id, name) values ($1, $2) on conflict (id) do nothing`,
      [ORGANIZATION_ID, `synthetic — ${CANARY_ID}`],
    );

    /* ── 7 · a canary runs once ──────────────────────────────────────── */
    const already = await db.query(
      `select count(*)::text as n from public.agent_attempts where workflow_id = $1 and state = any($2::text[])`,
      [WORKFLOW_ID, `{${MAY_HAVE_BEEN_BILLED.join(",")}}`],
    );
    const priorSubmissions = Number(already.rows[0]?.n ?? "0");
    if (priorSubmissions > 0) {
      return json(409, { refused: `${CANARY_ID} has already submitted ${priorSubmissions} attempt(s); a canary runs once`, workflowId: WORKFLOW_ID });
    }

    /* ── 8 · the invented material, and nobody's document ────────────── */
    const truth = syntheticRecordSet({
      seed: CANARY_ID, sources: 1, sheetsPerSource: 1, entriesPerTable: 3,
      organizationId: ORGANIZATION_ID, workflowId: WORKFLOW_ID,
    });
    if (!truth.manifest.sources.every((s) => s.uri.startsWith("fixture://"))) {
      return json(500, { refused: "the canary runs on invented sources only" });
    }
    const pack = new SyntheticRecordsPack();
    const roles = new RoleRegistry(pack);
    const stored = new Map<string, StoredMaterial>();
    for (const [hash, item] of truth.material) stored.set(hash, { mediaKind: item.mediaKind, mimeType: item.mimeType, bytes: item.bytes });

    /* ── 9 · the record and the durable budget ───────────────────────── */
    const ledger = new BudgetLedger(db as never, config);
    await enqueueWorkflow(new PostgresOrchestrationRepository(db as never, { organizationId: ORGANIZATION_ID }), truth.manifest, pack);
    await ledger.authorizeWorkflow({
      workflowId: WORKFLOW_ID, organizationId: ORGANIZATION_ID, currency: CANARY_CURRENCY,
      authorizedMaximum: CANARY_AUTHORIZED,
      maximumPerAttempt: worst.perAttempt,
      maximumAttempts: CANARY_MAXIMUM_SUBMISSIONS,
      maximumConcurrentAttempts: 1,
      maximumInputTokens: Math.max(...config.providers.map((p) => p.maximumInputTokens)),
      maximumOutputTokens: Math.max(...config.providers.map((p) => p.maximumOutputTokens)),
    });

    /* ── 10 · the door, built last ───────────────────────────────────── */
    const transport = new DenoFetchTransport({ config });
    const executors = buildProviderRegistry({
      config, transport, routing: registry.routing,
      compilePrompt: (packet: WorkPacket) => compilePrompt(packet, roles.role(packet.roleKey)),
      materialResolver: new InMemoryMaterialResolver(stored),
      environment,
    });

    const dispatcher = new Dispatcher({
      name: config.dispatcherName,
      connect: async () => dispatcherDb as never,
      repository: () => meteredRepository(
        new PostgresOrchestrationRepository(dispatcherDb as never, { organizationId: ORGANIZATION_ID }),
        {
          ledger: new BudgetLedger(dispatcherDb as never, config), config,
          providerOfFamily: (family: string) => registry.routing[family] ?? null,
        },
      ),
      pack,
      executors: () => executors.registry,
      events: (event: unknown) => { events.push(event); },
      now: () => Date.now(),
      backoff: { baseMs: 50, ceilingMs: 250, jitter: 0, random: () => 0 },
    });

    let deadlineReached = false;
    const deadline = new Promise<void>((resolve) => setTimeout(() => { deadlineReached = true; resolve(); }, DRAIN_DEADLINE_MS));
    await Promise.race([dispatcher.drain(), deadline]);
    await dispatcher.stop();

    /* ── 11 · close the authority, whatever happened ─────────────────── */
    await ledger.stop(WORKFLOW_ID, deadlineReached
      ? "canary stopped at its deadline — unused authority closed"
      : "canary complete — unused authority closed").catch(() => undefined);

    return json(200, await report(db, ledger, {
      transport: transport.name,
      allowedOrigins: transport.allowedOrigins,
      unresolvedHosts: transport.unresolvedHosts,
      gate: gateFromEnvironment ? PAID_CALLS_VARIABLE : "invocation",
      installedGlobals,
      worstAttempt: worst.perAttempt,
      worstCanary: worst.wholeCanary,
      deadlineReached,
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

  const databaseUrl = Deno.env.get(DATABASE_VARIABLE);
  if (!databaseUrl) {
    return json(412, { probe: true, ok: false, refused: `${DATABASE_VARIABLE} is not set`, phases });
  }
  /* The host is worth stating; the credential in the url is not, and is not
     read out of it. */
  let route = "unparseable";
  try {
    const parsed = new URL(databaseUrl);
    route = `${parsed.hostname}:${parsed.port || "5432"}${parsed.pathname}`;
  } catch { /* connect() will refuse it and say so */ }

  let db: CanaryDatabase | null = null;
  try {
    /* One connection, opened once, with the deadline the first run lacked. */
    const at = Date.now();
    try {
      db = await CanaryDatabase.connect(databaseUrl, `${CANARY_ID}-probe`, CONNECT_TIMEOUT_MS);
      phases.push({ phase: "connect", ms: Date.now() - at, detail: { route, tls: "required", connectTimeoutMs: CONNECT_TIMEOUT_MS } });
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
async function report(db: CanaryDatabase, ledger: BudgetLedger, extra: Record<string, unknown>): Promise<Record<string, unknown>> {
  const rows = async (sql: string, params: (string | number)[] = []) => (await db.query(sql, params)).rows;
  const standing = await ledger.standing(WORKFLOW_ID).catch(() => null);
  return {
    canaryId: CANARY_ID,
    workflowId: WORKFLOW_ID,
    organizationId: ORGANIZATION_ID,
    authorized: CANARY_AUTHORIZED,
    currency: CANARY_CURRENCY,
    maximumSubmissions: CANARY_MAXIMUM_SUBMISSIONS,
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
              r.currency, r.reserved_input_tokens, r.reserved_output_tokens,
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
