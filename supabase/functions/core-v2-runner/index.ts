/* THE DOOR A PERSON KNOCKS ON: START, CANCEL, STATUS.
 *
 * Three operations, all authenticated, none of which runs a workflow. That
 * separation is the whole shape of Production Runner V1:
 *
 *     a person starts a workflow ONCE and is handed its id;
 *     from that moment the RECORD says when it runs;
 *     something with no user in front of it does the running.
 *
 * So this file writes rows and returns quickly. It never leases a task, never
 * builds a transport, never reads a provider key. The machine door is
 * core-v2-runner-tick, and it is a different function on purpose: this one is
 * deployed with verify_jwt = true and the platform checks every caller's
 * token before the code runs; that one is deployed with verify_jwt = false
 * because a watchdog has no user token, and it carries its own shared secret
 * instead. One door, one kind of caller, one kind of check.
 *
 * WHO IS ASKING. The platform verifies the signature and the expiry; this
 * file reads the subject out of the token the platform already accepted and
 * asks the record whether that person is a member of the organisation whose
 * workflow they are naming. Neither check substitutes for the other: the
 * platform proves the token is real, the record proves the person is allowed.
 *
 * WHAT IT NEVER SAYS. No source bytes, no prompt, no provider payload, no
 * key, no connection string. Ids, states, counts and times.
 */
import "../_shared/core-v2/install-node-globals.ts";

import { EdgeDatabase, DatabaseUnreachable } from "../_shared/core-v2/deno-postgres.ts";
import { isRouteProblem, routeToRecord } from "../_shared/core-v2/route.ts";
import { PostgresOrchestrationRepository } from "../../../workers/core-v2/postgres/repository.ts";
import { SyntheticRecordsPack } from "../../../workers/core-v2/domains/synthetic-records/pack.ts";
import { enqueueWorkflow } from "../../../workers/core-v2-runtime/dispatcher.ts";
import { PostgresContinuationStore } from "../../../workers/core-v2-runner/continuations.ts";
import { syntheticSourceSet } from "../../../workers/core-v2-runner/source-set.ts";
import { line } from "./log.ts";

const ROUTE_PREFIX = "CORE_V2_RUNNER";
const FUNCTION = "core-v2-runner";

type Body = Record<string, unknown>;

const json = (status: number, body: Body) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/* The subject of the token the platform already verified. Decoding is all
   this does — the signature was checked before this code ran, and doing it
   again here with a secret this function would otherwise never need is more
   risk than assurance. */
function callerFrom(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(padded + "=".repeat((4 - padded.length % 4) % 4))) as { sub?: unknown };
    return typeof payload.sub === "string" && payload.sub.length > 0 ? payload.sub : null;
  } catch { return null; }
}

async function memberOf(db: EdgeDatabase, userId: string, organizationId: string): Promise<boolean> {
  const r = await db.query(
    `select 1 as ok from public.organization_members
      where user_id = $1::uuid and organization_id = $2::uuid limit 1`,
    [userId, organizationId]);
  return r.rows.length > 0;
}

async function organizationOfWorkflow(db: EdgeDatabase, workflowId: string): Promise<string | null> {
  const r = await db.query(
    `select organization_id::text as id from public.intelligence_workflows where id = $1::uuid`, [workflowId]);
  return r.rows.length ? String(r.rows[0].id) : null;
}

const isUuid = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method !== "POST") return json(405, { refused: "this door takes POST" });

  const caller = callerFrom(request);
  if (!caller) return json(401, { refused: "no caller could be read from the request" });

  let body: Body = {};
  try { body = await request.json() as Body; } catch { body = {}; }
  const op = typeof body.op === "string" ? body.op : "";

  const route = routeToRecord(ROUTE_PREFIX, (name) => Deno.env.get(name));
  if (isRouteProblem(route)) return json(503, { refused: route.problem });

  let db: EdgeDatabase | null = null;
  try {
    db = await EdgeDatabase.connect(route.url, FUNCTION);

    if (op === "start") return await start(db, caller, body);
    if (op === "cancel") return await cancel(db, caller, body);
    if (op === "status") return await status(db, caller, body);
    return json(400, { refused: `unknown operation ${op || "(none)"}; this door knows start, cancel and status` });
  } catch (error) {
    if (error instanceof DatabaseUnreachable) return json(503, { refused: "the record is not reachable" });
    console.error(line({ fn: FUNCTION, event: "unhandled", op, problem: (error as Error).name }));
    return json(500, { refused: "the operation did not complete" });
  } finally {
    if (db) await db.close().catch(() => undefined);
  }
});

/* ─────────────────────────────────────────────────────────────── start
 *
 * Writes the rows a start command is — the workflow, its sources, one pending
 * command, one audit — and one continuation saying it is due now. Then it
 * returns. Nothing has run; nothing needs to have run for the caller to hold
 * a real id.
 */
async function start(db: EdgeDatabase, caller: string, body: Body): Promise<Response> {
  const organizationId = body.organizationId;
  const seed = body.sourceSetSeed;
  if (!isUuid(organizationId)) return json(400, { refused: "start needs the organizationId whose workflow this is" });
  if (typeof seed !== "string" || seed.trim() === "") {
    return json(400, { refused: "start needs sourceSetSeed: the source set this workflow reads, named so that any later runner can rebuild exactly it" });
  }
  if (!await memberOf(db, caller, organizationId)) {
    return json(403, { refused: "the caller is not a member of that organisation" });
  }

  const pack = new SyntheticRecordsPack();
  const shape = {
    seed: seed.trim(),
    sources: positive(body.sources, 1),
    sheetsPerSource: positive(body.sheetsPerSource, 1),
    entriesPerTable: positive(body.entriesPerTable, 3),
  };
  const set = syntheticSourceSet(shape, organizationId);
  const repo = new PostgresOrchestrationRepository(db as never, { organizationId });
  const store = new PostgresContinuationStore(db as never);

  const workflow = await enqueueWorkflow(repo, set.manifest, pack);
  await store.schedule(workflow.workflowId, null);

  console.log(line({
    fn: FUNCTION, event: "workflow.started", workflow: workflow.workflowId,
    organization: organizationId, sources: set.manifest.sources.length,
  }));

  return json(202, {
    workflowId: workflow.workflowId,
    state: workflow.state,
    /* Said plainly, because it is the promise this whole change makes. */
    continuation: "due now; the runner will continue this workflow until it reaches a terminal state, with no further call",
  });
}

/* ─────────────────────────────────────────────────────────────── cancel
 *
 * Asks. It does not stop anything itself: the request is durable, and
 * whichever runner next holds the workflow honours it — including a runner
 * that is holding it right now. What was finished stays finished; what was
 * never sent is stopped; what may have been sent stays an unknown outcome,
 * because pretending otherwise would be the one thing this engine refuses.
 */
async function cancel(db: EdgeDatabase, caller: string, body: Body): Promise<Response> {
  const workflowId = body.workflowId;
  if (!isUuid(workflowId)) return json(400, { refused: "cancel needs a workflowId" });
  const organizationId = await organizationOfWorkflow(db, workflowId);
  if (!organizationId) return json(404, { refused: "no such workflow" });
  if (!await memberOf(db, caller, organizationId)) {
    return json(403, { refused: "the caller is not a member of that organisation" });
  }

  const repo = new PostgresOrchestrationRepository(db as never, { organizationId });
  await repo.requestCancel(workflowId, Date.now());
  /* Due immediately, so the cancellation is acted on at the next tick rather
     than after whatever backoff the workflow happened to be sitting in. */
  const store = new PostgresContinuationStore(db as never);
  await store.schedule(workflowId, null);

  console.log(line({ fn: FUNCTION, event: "workflow.cancel_requested", workflow: workflowId, organization: organizationId }));
  return json(202, {
    workflowId,
    cancelRequested: true,
    note: "finished work is kept; unsent work is stopped; an outcome nobody knows stays unknown",
  });
}

/* ─────────────────────────────────────────────────────────────── status
 *
 * Read-only, and enough to answer "is this moving, and if not, why not"
 * without opening a database console. Counts and states; never content.
 */
async function status(db: EdgeDatabase, caller: string, body: Body): Promise<Response> {
  const workflowId = body.workflowId;
  if (!isUuid(workflowId)) return json(400, { refused: "status needs a workflowId" });
  const organizationId = await organizationOfWorkflow(db, workflowId);
  if (!organizationId) return json(404, { refused: "no such workflow" });
  if (!await memberOf(db, caller, organizationId)) {
    return json(403, { refused: "the caller is not a member of that organisation" });
  }

  const workflow = (await db.query(
    `select state, created_at, started_at, finished_at, cancel_requested_at
       from public.intelligence_workflows where id = $1::uuid`, [workflowId])).rows[0] ?? {};

  const tasks = (await db.query(
    `select state, count(*)::text as n from public.workflow_tasks where workflow_id = $1::uuid group by state`,
    [workflowId])).rows;

  const attempts = (await db.query(
    `select state, count(*)::text as n from public.agent_attempts where workflow_id = $1::uuid group by state`,
    [workflowId])).rows;

  const continuation = (await db.query(
    `select state, due_at, held_by, continuations, idle_streak, backoff_ms, settled_reason, last_error
       from public.workflow_continuations where workflow_id = $1::uuid`, [workflowId])).rows[0] ?? null;

  const money = (await db.query(
    `select authorized_maximum, reserved, settled, stopped_reason
       from public.workflow_cost_budgets where workflow_id = $1::uuid`, [workflowId])).rows[0] ?? null;

  const attention = (await db.query(
    `select
        (select count(*)::text from public.disagreements d where d.workflow_id = $1::uuid and d.state = 'needs_human') as disagreements,
        (select count(*)::text from public.decisions d where d.workflow_id = $1::uuid and d.status = 'needs_human') as decisions,
        (select count(*)::text from public.workflow_tasks t where t.workflow_id = $1::uuid and t.state = 'outcome_unknown') as unknown_outcomes`,
    [workflowId])).rows[0] ?? {};

  return json(200, {
    workflowId,
    state: workflow.state ?? null,
    createdAt: workflow.created_at ?? null,
    startedAt: workflow.started_at ?? null,
    finishedAt: workflow.finished_at ?? null,
    cancelRequestedAt: workflow.cancel_requested_at ?? null,
    tasks: Object.fromEntries(tasks.map((row) => [String(row.state), Number(row.n)])),
    attempts: Object.fromEntries(attempts.map((row) => [String(row.state), Number(row.n)])),
    continuation,
    budget: money,
    waitingForAPerson: {
      disagreements: Number(attention.disagreements ?? 0),
      decisions: Number(attention.decisions ?? 0),
      unknownOutcomes: Number(attention.unknown_outcomes ?? 0),
    },
  });
}

function positive(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.trunc(n) : fallback;
}
