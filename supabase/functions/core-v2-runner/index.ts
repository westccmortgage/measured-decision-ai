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
import { PostgresContinuationStore } from "../../../workers/core-v2-runner/continuations.ts";
import { parseStartRequest, startWorkflowAtomically } from "../../../workers/core-v2-runner/start.ts";
import { isShapeRefusal } from "../../../workers/core-v2-runner/source-set.ts";
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
    if (db) await db.end().catch(() => undefined);
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
  /* REFUSED BEFORE ANYTHING EXISTS.
     A shape V1 cannot run is a 400 with the numbers in it. It is never a
     workflow row that will fail its own material check on every pass until a
     fuse settles it, because that costs somebody an investigation to learn
     what a sentence could have told them. */
  const request = parseStartRequest(body);
  if (isShapeRefusal(request)) return json(400, { refused: request.refused, field: request.field ?? null });

  if (!await memberOf(db, caller, request.organizationId)) {
    return json(403, { refused: "the caller is not a member of that organisation" });
  }

  /* ONE COMMIT: the workflow, its sources, its start command, its audit and
     the continuation the watchdog reads. A process that dies anywhere inside
     this leaves nothing behind — which is the only honest alternative to
     leaving a real workflow that nothing will ever run. */
  const started = await startWorkflowAtomically({
    client: db as never,
    request,
    pack: new SyntheticRecordsPack(),
  });

  console.log(line({
    fn: FUNCTION, event: "workflow.started", workflow: started.workflowId,
    organization: request.organizationId, sources: started.sourceSet.manifest.sources.length,
    sheets_per_source: request.shape.sheetsPerSource, entries_per_table: request.shape.entriesPerTable,
  }));

  return json(202, {
    workflowId: started.workflowId,
    state: started.state,
    /* Every number the material came from, echoed back, because these are now
       what the record itself keeps and what a later runner rebuilds from. */
    sourceSet: {
      seed: request.shape.seed,
      sources: request.shape.sources,
      sheetsPerSource: request.shape.sheetsPerSource,
      entriesPerTable: request.shape.entriesPerTable,
    },
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
  const scheduled = await store.schedule(workflowId, null);

  /* AND IF THE WAKING HAD ALREADY BEEN TURNED OFF.
     A settled continuation is absorbing on purpose, so `schedule` leaves it
     settled — which used to mean a cancellation of a still-running workflow
     was written down and then never acted on by anything, ever. Migration 061
     opens exactly this case and no other: the workflow's own
     cancel_requested_at is set and its state is not yet terminal. */
  let reopened = false;
  if (!scheduled || scheduled.state === "settled") {
    const back = await store.reopenForCancellation(workflowId);
    reopened = back !== null && back.state === "due";
  }

  console.log(line({
    fn: FUNCTION, event: "workflow.cancel_requested", workflow: workflowId,
    organization: organizationId, reopened,
  }));
  return json(202, {
    workflowId,
    cancelRequested: true,
    /* Said out loud: a cancellation that had to restart the waking is a
       different fact from one that merely joined a queue. */
    wakingReopened: reopened,
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

