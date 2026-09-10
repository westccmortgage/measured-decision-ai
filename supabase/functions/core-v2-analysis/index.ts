/* THE DOOR AN OWNER'S ANALYSIS GOES THROUGH.
 *
 * Six operations, all authenticated, none of which reads a provider key or
 * sends anything to a provider itself:
 *
 *   preflight   what this deployment can and cannot do, by name
 *   estimate    what this analysis would cost, before anybody presses anything
 *   run         the press: the authority is written down and the workflow starts
 *   status      everything a screen needs, rebuilt from the record
 *   cancel      stop giving out new work; say honestly what is already out
 *   evidence    a short-lived link to the exact page or frame a finding names
 *
 * WHAT UPLOADS DO NOT GO THROUGH HERE. Files go straight from the browser to
 * storage, resumably, and the rows that describe them are written by the
 * browser under row-level security. Bytes never pass through a function: a
 * function in the byte path is a size limit, a timeout and a bill, and the
 * storage service already does it better.
 *
 * WHAT THE PAID GATE IS. `run` writes `run_requested_at` and `authorized_usd`
 * on the analysis. The runner reads those from the record — not from a
 * request, not from an ambient variable — so nothing reaches a provider for an
 * analysis nobody pressed, and nothing spends past what they authorised.
 */
import "../_shared/core-v2/install-node-globals.ts";

import { EdgeDatabase, DatabaseUnreachable } from "../_shared/core-v2/deno-postgres.ts";
import { isRouteProblem, routeToRecord } from "../_shared/core-v2/route.ts";
import { signedUrlFor } from "../_shared/core-v2/storage.ts";
import { PostgresContinuationStore } from "../../../workers/core-v2-runner/continuations.ts";
import { startFromManifest } from "../../../workers/core-v2-runner/start.ts";
import { manifestOfAnalysis, readAnalysis, clock } from "../../../workers/core-v2-runner/analysis.ts";
import { questionFor } from "../../../workers/core-v2-runner/world.ts";
import { SourceDocumentsPack } from "../../../workers/core-v2/domains/source-documents/pack.ts";
import { loadOperatorRegistry } from "../../../workers/core-v2-canary/operator-registry.ts";
import bundledDeclaration from "../../../workers/core-v2-canary/registry.canary.json" with { type: "json" };
import { line } from "../core-v2-runner/log.ts";

const FUNCTION = "core-v2-analysis";
const ROUTE_PREFIX = "CORE_V2_RUNNER";

/* WHAT ONE ANALYSIS MAY EVER BE AUTHORISED TO SPEND, whatever a request says.
   A person choosing an amount is choosing inside this, not past it: a typed
   zero too many should cost a refusal, not a bill. */
const CEILING_USD = 25;
/* And the most subjects one analysis may hold, so a four-hundred-page set is
   refused with a number rather than discovered as a runaway. */
const MAXIMUM_SUBJECTS = 120;

type Body = Record<string, unknown>;

const json = (status: number, body: Body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const isUuid = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

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
      where user_id = $1::uuid and organization_id = $2::uuid limit 1`, [userId, organizationId]);
  return r.rows.length > 0;
}

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method !== "POST") return json(405, { refused: "this door takes POST" });

  const caller = callerFrom(request);
  if (!caller) return json(401, { refused: "no caller could be read from the request" });

  let body: Body = {};
  try { body = await request.json() as Body; } catch { body = {}; }
  const op = typeof body.op === "string" ? body.op : "";

  if (op === "preflight") return preflight();

  const route = routeToRecord(ROUTE_PREFIX, (name) => Deno.env.get(name));
  if (isRouteProblem(route)) return json(503, { refused: route.problem });

  let db: EdgeDatabase | null = null;
  try {
    db = await EdgeDatabase.connect(route.url, FUNCTION);
    if (op === "estimate") return await estimate(db, caller, body);
    if (op === "run") return await run(db, caller, body);
    if (op === "status") return await status(db, caller, body);
    if (op === "cancel") return await cancel(db, caller, body);
    if (op === "results") return await results(db, caller, body);
    if (op === "evidence") return await evidence(db, caller, body);
    return json(400, { refused: `unknown operation ${op || "(none)"}; this door knows preflight, estimate, run, status, results, cancel and evidence` });
  } catch (error) {
    if (error instanceof DatabaseUnreachable) return json(503, { refused: "the record is not reachable" });
    console.error(line({ fn: FUNCTION, event: "unhandled", op, problem: (error as Error).name }));
    return json(500, { refused: "the operation did not complete", problem: (error as Error).name });
  } finally {
    if (db) await db.end().catch(() => undefined);
  }
});

/* ───────────────────────────────────────────────────────────── preflight
 *
 * Names, never values. It answers "can this deployment run an analysis, and if
 * not, which thing is missing" — which is the question an operator actually
 * has, and the one a 500 never answers.
 */
function preflight(): Response {
  const set = (name: string) => (Deno.env.get(name) ?? "") !== "";
  const route = routeToRecord(ROUTE_PREFIX, (name) => Deno.env.get(name));
  const declaration = loadOperatorRegistry(
    Deno.env.get("CORE_V2_RUNNER_REGISTRY") || JSON.stringify(bundledDeclaration),
    "the declaration in use");
  const providers = declaration.registry?.config.providers ?? [];
  return json(200, {
    recordReachable: !isRouteProblem(route),
    recordVia: isRouteProblem(route) ? route.problem : route.describe,
    declaration: declaration.registry
      ? { from: Deno.env.get("CORE_V2_RUNNER_REGISTRY") ? "CORE_V2_RUNNER_REGISTRY" : "bundled with this deployment", providers: providers.map((p) => p.providerId) }
      : { refused: declaration.problems },
    keysPresent: Object.fromEntries(providers.map((p) => [p.apiKeyEnvironmentVariable, set(p.apiKeyEnvironmentVariable)])),
    tickReachable: set("SUPABASE_SERVICE_ROLE_KEY") || set("CORE_V2_RUNNER_SECRET"),
    storageReadable: set("SUPABASE_URL") && set("SUPABASE_SERVICE_ROLE_KEY"),
    ceilingUsd: CEILING_USD,
    maximumSubjects: MAXIMUM_SUBJECTS,
  });
}

/* ────────────────────────────────────────────────────────────── estimate */

type Shape = {
  subjects: number;
  readerAttempts: number;
  criticAttempts: number;
  worstUsd: number;
  pages: number;
  frames: number;
  files: number;
};

async function shapeOf(db: EdgeDatabase, analysisId: string): Promise<Shape> {
  const counts = (await db.query(
    `select
        count(*) filter (where p.part_kind = 'pdf_page_image')::text as pages,
        count(*) filter (where p.part_kind = 'video_frame')::text as frames,
        count(distinct p.file_id)::text as files
       from public.analysis_parts p where p.analysis_id = $1::uuid`, [analysisId])).rows[0] ?? {};
  const pages = Number(counts.pages ?? 0);
  const frames = Number(counts.frames ?? 0);
  const subjects = pages + frames;
  const readerAttempts = subjects * 2;
  /* One critic pass per subject is what the engine will ask for at most; it
     asks for fewer when readers agree and the rule accepts without one. */
  const criticAttempts = subjects;

  const declaration = loadOperatorRegistry(
    Deno.env.get("CORE_V2_RUNNER_REGISTRY") || JSON.stringify(bundledDeclaration), "the declaration in use");
  let worstPerAttempt = 0;
  for (const provider of declaration.registry?.config.providers ?? []) {
    const price = declaration.registry?.config.pricing.find(
      (p) => p.providerId === provider.providerId && provider.models.includes(p.model));
    if (!price) continue;
    const input = Math.max(price.inputPerMillionTokens, price.cacheWritePerMillionTokens ?? 0);
    const output = Math.max(price.outputPerMillionTokens, price.reasoningPerMillionTokens ?? 0);
    const ceiling = (provider.maximumInputTokens * input + provider.maximumOutputTokens * output) / 1_000_000;
    if (ceiling > worstPerAttempt) worstPerAttempt = ceiling;
  }
  return {
    subjects, readerAttempts, criticAttempts, pages, frames,
    files: Number(counts.files ?? 0),
    worstUsd: Number(((readerAttempts + criticAttempts) * worstPerAttempt).toFixed(2)),
  };
}

async function estimate(db: EdgeDatabase, caller: string, body: Body): Promise<Response> {
  const analysisId = body.analysisId;
  if (!isUuid(analysisId)) return json(400, { refused: "estimate needs an analysisId" });
  const owner = await organizationOf(db, analysisId);
  if (!owner) return json(404, { refused: "no such analysis" });
  if (!await memberOf(db, caller, owner)) return json(403, { refused: "that analysis belongs to another organisation" });

  const shape = await shapeOf(db, analysisId);
  return json(200, {
    ...shape,
    ceilingUsd: CEILING_USD,
    maximumSubjects: MAXIMUM_SUBJECTS,
    tooLarge: shape.subjects > MAXIMUM_SUBJECTS,
    /* Said plainly: this is the most it could cost, not a guess at what it
       will. Every attempt holds this much and gives back what it did not
       use. */
    note: "the most this could cost, priced from the declared ceilings; unused reservations are given back",
  });
}

async function organizationOf(db: EdgeDatabase, analysisId: string): Promise<string | null> {
  const r = await db.query(`select organization_id::text as id from public.analysis_runs where id = $1::uuid`, [analysisId]);
  return r.rows.length ? String(r.rows[0].id) : null;
}

/* ─────────────────────────────────────────────────────────────────── run */

async function run(db: EdgeDatabase, caller: string, body: Body): Promise<Response> {
  const analysisId = body.analysisId;
  if (!isUuid(analysisId)) return json(400, { refused: "run needs an analysisId" });
  const asked = Number(body.authorizedUsd);
  if (!Number.isFinite(asked) || asked <= 0) {
    return json(400, { refused: "run needs the amount you authorise this analysis to spend" });
  }
  if (asked > CEILING_USD) {
    return json(400, { refused: `one analysis may be authorised at most $${CEILING_USD}`, ceilingUsd: CEILING_USD });
  }

  const analysis = await readAnalysis(db as never, analysisId);
  if (!analysis) return json(404, { refused: "no such analysis" });
  if (!await memberOf(db, caller, analysis.organizationId)) {
    return json(403, { refused: "that analysis belongs to another organisation" });
  }
  if (analysis.state === "running" || analysis.state === "finished") {
    return json(409, { refused: `this analysis is already ${analysis.state}`, state: analysis.state });
  }

  const shape = await shapeOf(db, analysisId);
  if (shape.subjects === 0) {
    return json(409, { refused: "nothing has been prepared to read yet", ...shape });
  }
  if (shape.subjects > MAXIMUM_SUBJECTS) {
    return json(409, { refused: `this analysis holds ${shape.subjects} places to read and one analysis may hold ${MAXIMUM_SUBJECTS}`, ...shape });
  }

  const pack = new SourceDocumentsPack({ question: questionFor(analysis) });
  let manifest;
  try {
    manifest = manifestOfAnalysis(analysis, "00000000-0000-0000-0000-000000000000");
  } catch (error) {
    return json(409, { refused: "this analysis cannot be read as a source set", detail: (error as { reasons?: string[] }).reasons });
  }

  /* One commit: the workflow, its sources, its start command, its audit, its
     first continuation — and the analysis row saying which workflow it became
     and what a person authorised it to spend. */
  const created = await startFromManifest({
    client: db as never,
    organizationId: analysis.organizationId,
    manifest,
    pack,
    alongside: async (tx, workflowId) => {
      await tx.query(
        `update public.analysis_runs
            set workflow_id = $2::uuid, authorized_usd = $3::numeric, run_requested_at = now(),
                run_requested_by = $4::uuid, state = 'running', estimate = $5::jsonb, last_error = null
          where id = $1::uuid`,
        [analysisId, workflowId, asked, caller, JSON.stringify(shape)]);
      await tx.query(
        `insert into public.analysis_events(analysis_id, organization_id, kind, detail)
         values ($1::uuid, $2::uuid, 'run_requested', $3::jsonb)`,
        [analysisId, analysis.organizationId, JSON.stringify({ authorizedUsd: asked, ...shape })]);
    },
  });

  console.log(line({
    fn: FUNCTION, event: "analysis.run", analysis: analysisId, workflow: created.workflowId,
    subjects: shape.subjects, authorized_usd: asked,
  }));

  /* The knock. Best effort and deliberately unable to fail the press: the
     record already says the workflow is due, and the watchdog reads that. */
  const woke = await knock();

  return json(202, {
    analysisId, workflowId: created.workflowId, state: "running",
    authorizedUsd: asked, subjects: shape.subjects, wokeRunner: woke,
    note: "the analysis continues on the server; closing this page does not stop it",
  });
}

async function knock(): Promise<boolean> {
  const base = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("CORE_V2_RUNNER_SECRET") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!base || !key) return false;
  try {
    const answer = await fetch(`${base}/functions/v1/core-v2-runner-tick`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
        "x-core-v2-runner": key,
      },
      body: JSON.stringify({ op: "tick", wokenBy: "analysis" }),
      signal: AbortSignal.timeout(3_000),
    });
    await answer.body?.cancel();
    return answer.ok;
  } catch { return false; }
}

/* ──────────────────────────────────────────────────────────────── status
 *
 * Everything the screen shows, from the record. No percentage is invented:
 * what is reported is how many bounded assignments are finished out of how
 * many exist, which is a count somebody can check.
 */
async function status(db: EdgeDatabase, caller: string, body: Body): Promise<Response> {
  const analysisId = body.analysisId;
  if (!isUuid(analysisId)) return json(400, { refused: "status needs an analysisId" });
  const owner = await organizationOf(db, analysisId);
  if (!owner) return json(404, { refused: "no such analysis" });
  if (!await memberOf(db, caller, owner)) return json(403, { refused: "that analysis belongs to another organisation" });

  const run = (await db.query(
    `select a.id::text as id, a.title, a.question, a.question_kind, a.state, a.workflow_id::text as workflow_id,
            a.authorized_usd, a.run_requested_at, a.estimate, a.last_error, a.created_at,
            w.state as workflow_state, w.error_code, w.error_message, w.cancel_requested_at
       from public.analysis_runs a
       left join public.intelligence_workflows w on w.id = a.workflow_id
      where a.id = $1::uuid`, [analysisId])).rows[0] ?? {};

  const files = (await db.query(
    `select f.id::text as id, f.ordinal, f.kind, f.file_name, f.media_type, f.byte_size,
            f.upload_state, f.preparation_state, f.prepared_units, f.total_units, f.probe, f.last_error
       from public.analysis_files f where f.analysis_id = $1::uuid order by f.ordinal`, [analysisId])).rows;

  const prepared = (await db.query(
    `select p.part_kind, count(*)::text as n from public.analysis_parts p
      where p.analysis_id = $1::uuid group by p.part_kind`, [analysisId])).rows;

  const workflowId = run.workflow_id ? String(run.workflow_id) : null;
  let tasks: Record<string, number> = {};
  let attempts: Record<string, number> = {};
  let money: Record<string, unknown> | null = null;
  let continuation: Record<string, unknown> | null = null;
  let stage = "collecting";

  if (workflowId) {
    tasks = Object.fromEntries((await db.query(
      `select state, count(*)::text as n from public.workflow_tasks where workflow_id = $1::uuid group by state`,
      [workflowId])).rows.map((r) => [String(r.state), Number(r.n)]));
    attempts = Object.fromEntries((await db.query(
      `select state, count(*)::text as n from public.agent_attempts where workflow_id = $1::uuid group by state`,
      [workflowId])).rows.map((r) => [String(r.state), Number(r.n)]));
    money = (await db.query(
      `select authorized_maximum, reserved, settled, stopped_reason
         from public.workflow_cost_budgets where workflow_id = $1::uuid`, [workflowId])).rows[0] ?? null;
    continuation = (await db.query(
      `select state, due_at, held_by, continuations, idle_streak, settled_reason, last_error
         from public.workflow_continuations where workflow_id = $1::uuid`, [workflowId])).rows[0] ?? null;
    stage = stageOf(String(run.workflow_state ?? ""), tasks);
  } else {
    const anyPrepared = prepared.reduce((n, r) => n + Number(r.n), 0);
    stage = files.length === 0 ? "collecting" : anyPrepared > 0 ? "ready" : "preparing";
  }

  const done = (tasks.completed ?? 0);
  const total = Object.values(tasks).reduce((n, v) => n + v, 0);

  return json(200, {
    analysisId,
    title: run.title ?? null,
    question: run.question ?? "",
    questionKind: run.question_kind ?? null,
    state: run.state ?? null,
    workflowId,
    workflowState: run.workflow_state ?? null,
    stage,
    cancelRequested: run.cancel_requested_at !== null && run.cancel_requested_at !== undefined,
    /* Counted, never guessed. */
    assignments: { finished: done, total, running: (tasks.running ?? 0) + (tasks.leased ?? 0), waiting: (tasks.queued ?? 0) + (tasks.blocked ?? 0) },
    materialPrepared: Object.fromEntries(prepared.map((r) => [String(r.part_kind), Number(r.n)])),
    files: files.map((f) => ({
      id: String(f.id), ordinal: Number(f.ordinal), kind: String(f.kind), name: String(f.file_name),
      mediaType: String(f.media_type), byteSize: Number(f.byte_size),
      uploadState: String(f.upload_state), preparationState: String(f.preparation_state),
      preparedUnits: Number(f.prepared_units), totalUnits: Number(f.total_units),
      probe: f.probe ?? {}, lastError: f.last_error ?? null,
    })),
    attempts,
    budget: money,
    continuation,
    authorizedUsd: run.authorized_usd === null || run.authorized_usd === undefined ? null : Number(run.authorized_usd),
    estimate: run.estimate ?? {},
    problem: run.error_message ?? run.last_error ?? null,
  });
}

function stageOf(workflowState: string, tasks: Record<string, number>): string {
  if (["completed", "partial"].includes(workflowState)) return "finished";
  if (workflowState === "cancelled") return "cancelled";
  if (workflowState === "failed") return "failed";
  if (workflowState === "needs_attention") return "needs_a_person";
  if (["ready_for_decision", "deciding"].includes(workflowState)) return "deciding";
  if ((tasks.running ?? 0) + (tasks.leased ?? 0) > 0) return "reading";
  if (workflowState === "planning" || workflowState === "queued") return "planning";
  return "reading";
}

/* ──────────────────────────────────────────────────────────────── cancel */

async function cancel(db: EdgeDatabase, caller: string, body: Body): Promise<Response> {
  const analysisId = body.analysisId;
  if (!isUuid(analysisId)) return json(400, { refused: "cancel needs an analysisId" });
  const run = (await db.query(
    `select organization_id::text as organization_id, workflow_id::text as workflow_id, state
       from public.analysis_runs where id = $1::uuid`, [analysisId])).rows[0];
  if (!run) return json(404, { refused: "no such analysis" });
  if (!await memberOf(db, caller, String(run.organization_id))) {
    return json(403, { refused: "that analysis belongs to another organisation" });
  }

  const workflowId = run.workflow_id ? String(run.workflow_id) : null;
  if (!workflowId) {
    await db.query(`update public.analysis_runs set state = 'cancelled' where id = $1::uuid`, [analysisId]);
    return json(202, { analysisId, cancelRequested: true, note: "nothing had been started" });
  }

  await db.query(
    `update public.intelligence_workflows set cancel_requested_at = coalesce(cancel_requested_at, now())
      where id = $1::uuid`, [workflowId]);
  const store = new PostgresContinuationStore(db as never);
  const scheduled = await store.schedule(workflowId, null);
  let reopened = false;
  if (!scheduled || scheduled.state === "settled") {
    const back = await store.reopenForCancellation(workflowId);
    reopened = back !== null && back.state === "due";
  }
  await db.query(
    `insert into public.analysis_events(analysis_id, organization_id, kind, detail)
     values ($1::uuid, $2::uuid, 'cancel_requested', $3::jsonb)`,
    [analysisId, String(run.organization_id), JSON.stringify({ reopened })]);
  await knock();

  return json(202, {
    analysisId, workflowId, cancelRequested: true, wakingReopened: reopened,
    note: "no new work will be given out; what was already sent stays as it is, and an answer nobody saw stays unknown",
  });
}


/* ─────────────────────────────────────────────────────────────── results
 *
 * THREE SECTIONS, AND ONE FACT IN ONE OF THEM.
 *
 * Confirmed          two independent readings said the same thing about the
 *                    same place, and nothing contradicted it.
 * Discrepancy        two readings differ, or a reviewer read the source and
 *                    said the claim is not what is there.
 * Needs a check      everything else, and it is not a failure state: a page
 *                    nobody could read, a reading nobody corroborated, an
 *                    answer of "unclear". A thing here has NOT been decided.
 *
 * The rule that puts a subject in a section is written out below in one
 * function so it can be read and argued with. What it will not do is call an
 * ambiguous automatic agreement "confirmed": corroboration needs two readings
 * from different independence domains, and a lone reading is never enough.
 */
async function results(db: EdgeDatabase, caller: string, body: Body): Promise<Response> {
  const analysisId = body.analysisId;
  if (!isUuid(analysisId)) return json(400, { refused: "results needs an analysisId" });
  const run = (await db.query(
    `select organization_id::text as organization_id, workflow_id::text as workflow_id, question, question_kind, title, state
       from public.analysis_runs where id = $1::uuid`, [analysisId])).rows[0];
  if (!run) return json(404, { refused: "no such analysis" });
  if (!await memberOf(db, caller, String(run.organization_id))) {
    return json(403, { refused: "that analysis belongs to another organisation" });
  }
  const workflowId = run.workflow_id ? String(run.workflow_id) : null;
  if (!workflowId) return json(200, { analysisId, started: false, subjects: [], sections: emptySections() });

  /* Every reading, with who made it, what it said, and the piece of the
     owner's own file it came out of. */
  const claims = (await db.query(
    `select c.id::text as id, c.subject_type, c.subject_key, c.predicate, c.value, c.unit,
            c.status, c.independence_domain, c.observation_basis,
            a.role_key, a.role_version, a.executor_family, a.model_reported, a.state as attempt_state,
            t.id::text as task_id
       from public.evidence_claims c
       left join public.agent_attempts a on a.id = c.attempt_id
       left join public.workflow_tasks t on t.id = c.task_id
      where c.workflow_id = $1::uuid
      order by c.subject_key, c.created_at`, [workflowId])).rows;

  const anchors = (await db.query(
    `select an.claim_id::text as claim_id, an.assessment_id::text as assessment_id,
            an.quoted_text, an.locator, s.content_hash, s.segment_kind, s.label
       from public.evidence_anchors an
       left join public.source_segments s on s.id = an.segment_id
      where an.workflow_id = $1::uuid`, [workflowId])).rows;

  const assessments = (await db.query(
    `select cs.id::text as id, cs.claim_id::text as claim_id, cs.assessment, cs.reason_code,
            cs.explanation, cs.proposed_value, a.role_key, a.executor_family, a.model_reported
       from public.claim_assessments cs
       left join public.agent_attempts a on a.id = cs.attempt_id
      where cs.workflow_id = $1::uuid`, [workflowId])).rows;

  const decisions = (await db.query(
    `select d.id::text as id, d.subject_key, d.decision_type, d.status, d.authority,
            d.title, d.rationale, d.summary
       from public.decisions d where d.workflow_id = $1::uuid
      order by d.created_at`, [workflowId])).rows;

  /* A task that never produced a claim is still a place somebody asked about,
     and leaving it off the screen is how a missing reading becomes invisible. */
  const openTasks = (await db.query(
    `select t.subject_key, t.state, t.task_type, t.role_key, t.terminal_reason
       from public.workflow_tasks t
      where t.workflow_id = $1::uuid and t.subject_key <> ''
      order by t.subject_key`, [workflowId])).rows;

  const anchorsFor = (claimId: string) => anchors
    .filter((a) => String(a.claim_id ?? "") === claimId)
    .map((a) => ({
      quotedText: a.quoted_text ?? null,
      locator: asObject(a.locator),
      contentHash: a.content_hash ?? null,
      segmentKind: a.segment_kind ?? null,
      label: a.label ?? null,
    }));

  const bySubject = new Map<string, {
    subjectType: string; subjectKey: string;
    readings: unknown[]; reviews: unknown[]; decisions: unknown[];
    taskStates: string[]; problems: string[];
  }>();
  const slot = (type: string, key: string) => {
    const id = `${type}:${key}`;
    let found = bySubject.get(id);
    if (!found) {
      found = { subjectType: type, subjectKey: key, readings: [], reviews: [], decisions: [], taskStates: [], problems: [] };
      bySubject.set(id, found);
    }
    return found;
  };

  /* A subject key is `page/<file>/<page>` or `moment/<file>/<moment>`; the
     part before the first slash is the kind, which is how a task row and a
     claim row find each other without the tasks table carrying a second copy
     of it. */
  for (const row of openTasks) {
    const key = String(row.subject_key);
    const s = slot(key.split("/")[0] || "subject", key);
    s.taskStates.push(String(row.state));
    if (row.terminal_reason) s.problems.push(String(row.terminal_reason));
  }

  for (const c of claims) {
    const s = slot(String(c.subject_type), String(c.subject_key));
    s.readings.push({
      claimId: String(c.id),
      predicate: String(c.predicate),
      value: asObject(c.value),
      unit: c.unit ?? null,
      status: String(c.status),
      basis: String(c.observation_basis),
      /* Which independent family read it. Two readings only corroborate when
         these differ — that is what independence means here. */
      independenceDomain: c.independence_domain ?? null,
      role: c.role_key ?? null,
      roleVersion: c.role_version ?? null,
      executor: c.executor_family ?? null,
      model: c.model_reported ?? null,
      anchors: anchorsFor(String(c.id)),
    });
    for (const review of assessments.filter((a) => String(a.claim_id) === String(c.id))) {
      s.reviews.push({
        claimId: String(c.id),
        verdict: String(review.assessment),
        reasonCode: String(review.reason_code),
        explanation: review.explanation ?? null,
        proposedValue: review.proposed_value ?? null,
        role: review.role_key ?? null,
        executor: review.executor_family ?? null,
        model: review.model_reported ?? null,
      });
    }
  }
  for (const d of decisions) {
    const key = String(d.subject_key ?? "");
    /* A decision whose subject is not one of the reading subjects still
       belongs to the analysis; it goes under its own key. */
    const s = [...bySubject.values()].find((x) => x.subjectKey === key)
      ?? slot("decision", key || "the analysis");
    s.decisions.push({
      decisionId: String(d.id), type: String(d.decision_type), status: String(d.status),
      authority: String(d.authority), title: String(d.title), rationale: String(d.rationale ?? ""),
      summary: asObject(d.summary),
    });
  }

  const subjects = [...bySubject.values()]
    .map((s) => ({ ...s, section: sectionFor(s) }))
    .sort((a, b) => a.subjectKey.localeCompare(b.subjectKey, undefined, { numeric: true }));

  const sections = emptySections();
  for (const s of subjects) (sections as Record<string, unknown[]>)[s.section].push(s);

  return json(200, {
    analysisId, started: true, workflowId,
    title: run.title ?? null, question: run.question ?? "", questionKind: run.question_kind ?? null,
    subjects, sections,
    counts: {
      confirmed: sections.confirmed.length,
      discrepancy: sections.discrepancy.length,
      needsCheck: sections.needsCheck.length,
    },
  });
}

function emptySections() {
  return { confirmed: [] as unknown[], discrepancy: [] as unknown[], needsCheck: [] as unknown[] };
}

const asObject = (value: unknown): Record<string, unknown> => {
  if (value === null || value === undefined) return {};
  if (typeof value === "string") { try { return JSON.parse(value) as Record<string, unknown>; } catch { return {}; } }
  return value as Record<string, unknown>;
};

/* THE RULE, IN ONE PLACE.
 *
 * Read it as a ladder: the first rung that matches wins, so a subject appears
 * once. Contradiction outranks agreement on purpose — a reviewer who went back
 * to the source and found otherwise is the strongest thing on the page. */
function sectionFor(s: {
  readings: unknown[]; reviews: unknown[]; decisions: unknown[]; taskStates: string[]; problems: string[];
}): "confirmed" | "discrepancy" | "needsCheck" {
  type Reading = { value?: Record<string, unknown>; independenceDomain?: string | null; status?: string };
  type Review = { verdict?: string };
  const readings = s.readings as Reading[];
  const reviews = s.reviews as Review[];
  const decisions = s.decisions as { type?: string; status?: string }[];

  if (reviews.some((r) => r.verdict === "contradicts")) return "discrepancy";
  if (decisions.some((d) => d.type === "reject_claim" || d.type === "reject_all")) return "discrepancy";

  /* What each independent family actually said, as the compared answer. */
  const answered = new Map<string, Set<string>>();
  for (const r of readings) {
    const answer = String((r.value ?? {}).text ?? (r.value ?? {}).known ?? "").trim().toLowerCase();
    if (!answer) continue;
    const domain = String(r.independenceDomain ?? "unknown");
    const set = answered.get(domain) ?? new Set<string>();
    set.add(answer);
    answered.set(domain, set);
  }
  const domains = [...answered.keys()];
  const distinct = new Set([...answered.values()].flatMap((set) => [...set]));

  /* Two independent families, different answers: that is the discrepancy the
     whole arrangement exists to find. */
  if (domains.length >= 2 && distinct.size > 1) return "discrepancy";

  const decided = decisions.some((d) =>
    d.type === "accept_claim" && (d.status === "machine_decided" || d.status === "human_decided"));
  const corroborated = domains.length >= 2 && distinct.size === 1 && !distinct.has("unclear");
  const accepted = readings.some((r) => r.status === "accepted" || r.status === "verified");

  if ((decided || corroborated || accepted)
      && !s.taskStates.some((state) => ["queued", "leased", "running", "blocked"].includes(state))) {
    return "confirmed";
  }
  return "needsCheck";
}

/* ─────────────────────────────────────────────────────────────── evidence
 *
 * One part, one short-lived link. This is what turns a result back into a
 * place in the owner's own file — the page image a finding points at, or the
 * frame at the second it names.
 */
async function evidence(db: EdgeDatabase, caller: string, body: Body): Promise<Response> {
  const analysisId = body.analysisId;
  if (!isUuid(analysisId)) return json(400, { refused: "evidence needs an analysisId" });
  const owner = await organizationOf(db, analysisId);
  if (!owner) return json(404, { refused: "no such analysis" });
  if (!await memberOf(db, caller, owner)) return json(403, { refused: "that analysis belongs to another organisation" });

  const wanted = body.contentHash;
  const partId = body.partId;
  const found = (await db.query(
    `select p.id::text as id, p.part_kind, p.ordinal, p.storage_path, p.inline_text, p.media_type,
            p.locator, p.content_sha256, f.file_name, f.kind as file_kind, f.ordinal as file_ordinal
       from public.analysis_parts p join public.analysis_files f on f.id = p.file_id
      where p.analysis_id = $1::uuid
        and ($2::text is null or p.content_sha256 = $2::text)
        and ($3::uuid is null or p.id = $3::uuid)
      limit 1`,
    [analysisId, typeof wanted === "string" ? wanted : null, isUuid(partId) ? partId : null])).rows[0];
  if (!found) return json(404, { refused: "no such piece of material in this analysis" });

  const url = found.storage_path ? await signedUrlFor(String(found.storage_path)) : null;
  const locator = typeof found.locator === "string" ? JSON.parse(found.locator) : (found.locator ?? {});
  return json(200, {
    partKind: String(found.part_kind),
    fileName: String(found.file_name),
    fileKind: String(found.file_kind),
    fileOrdinal: Number(found.file_ordinal),
    ordinal: Number(found.ordinal),
    mediaType: String(found.media_type),
    locator,
    where: String(found.part_kind) === "video_frame"
      ? `${String(found.file_name)} at ${clock(Number(locator.seconds ?? 0))}`
      : `${String(found.file_name)}, page ${Number(found.ordinal)}`,
    text: found.inline_text ?? null,
    url,
    urlExpiresInSeconds: url ? 900 : null,
  });
}
