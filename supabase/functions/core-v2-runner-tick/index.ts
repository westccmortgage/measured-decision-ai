/* THE DOOR NOTHING HUMAN KNOCKS ON.
 *
 * One operation: take whatever the record says is due and advance it. It is a
 * separate function from core-v2-runner because it is a separate KIND of
 * caller — a watchdog on a schedule, or the previous invocation of this same
 * function handing on. Neither has a user token, so this one is deployed with
 * verify_jwt = false and proves itself with a shared secret instead. Mixing
 * the two behind one door would mean one of them checking the other's
 * credential, which is how a door ends up open.
 *
 * WHAT WAKES IT, AND WHY THERE ARE TWO THINGS.
 *
 *   · the CHAIN. Before this function returns with work still to do, it asks
 *     the platform to call it again. That is the fast path: a workflow moves
 *     on immediately rather than at the next minute boundary.
 *   · the WATCHDOG. A cron job in the database looks at the durable due times
 *     and knocks. That is the authority, and it exists because a chain is
 *     exactly as durable as its weakest link: an invocation that is lost,
 *     killed, throttled or refused takes the whole workflow with it, and
 *     nothing would ever notice.
 *
 * The chain is an optimisation over the watchdog and never a replacement for
 * it. Losing every chained call costs latency; losing the watchdog costs the
 * promise. So the chain is best-effort and its failure is logged and ignored,
 * while the record's due time — which the watchdog reads — is written before
 * this function returns, always, on every path.
 *
 * DORMANT BY DEFAULT. With no registry declared, no authority set and the
 * paid-calls gate shut, this function still runs, still claims, still
 * advances everything that costs nothing, and records a refusal for anything
 * that would. It cannot spend until an operator turns three separate things
 * on, and it says which ones are off.
 */
import "../_shared/core-v2/install-node-globals.ts";

import { EdgeDatabase, DatabaseUnreachable } from "../_shared/core-v2/deno-postgres.ts";
import { isRouteProblem, routeToRecord } from "../_shared/core-v2/route.ts";
import { invocationClock, EDGE_FUNCTION_LIFETIME_MS } from "../../../workers/core-v2-runner/clock.ts";
import { PostgresContinuationStore } from "../../../workers/core-v2-runner/continuations.ts";
import { runOnePass } from "../../../workers/core-v2-runner/runner.ts";
import { authorityFor, buildWorldFor, concurrencyFor, isProblem, operatorRegistry, PAID_CALLS_VARIABLE, AUTHORITY_VARIABLE, REGISTRY_VARIABLE } from "../core-v2-runner/world.ts";
import { line } from "../core-v2-runner/log.ts";

const ROUTE_PREFIX = "CORE_V2_RUNNER";
const FUNCTION = "core-v2-runner-tick";
const SECRET_HEADER = "x-core-v2-runner";
const SECRET_VARIABLE = "CORE_V2_RUNNER_SECRET";
const CHAIN_VARIABLE = "CORE_V2_RUNNER_TICK_URL";
const NETWORK_VARIABLE = "CORE_V2_RUNNER_ALLOW_PROVIDER_NETWORK";

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/* Compared without a short circuit, so the answer takes the same time
   whatever is wrong with it. */
function sameSecret(given: string, expected: string): boolean {
  if (given.length !== expected.length) return false;
  let difference = 0;
  for (let i = 0; i < given.length; i++) difference |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return difference === 0;
}

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method !== "POST") return json(405, { refused: "this door takes POST" });

  const expected = Deno.env.get(SECRET_VARIABLE) ?? "";
  if (!expected) return json(503, { refused: `${SECRET_VARIABLE} is not set; this door stays shut` });
  if (!sameSecret(request.headers.get(SECRET_HEADER) ?? "", expected)) {
    return json(401, { refused: "not for you" });
  }

  const route = routeToRecord(ROUTE_PREFIX, (name) => Deno.env.get(name));
  if (isRouteProblem(route)) return json(503, { refused: route.problem });

  const started = Date.now();
  const clock = invocationClock({
    lifetimeMs: Number(Deno.env.get("CORE_V2_RUNNER_LIFETIME_MS") ?? EDGE_FUNCTION_LIFETIME_MS),
  });

  let db: EdgeDatabase | null = null;
  try {
    db = await EdgeDatabase.connect(route.url, FUNCTION);
    const store = new PostgresContinuationStore(db as never);

    /* WHAT IS DUE, AND WHO IT BELONGS TO — before anything is built. The
       world is per workflow, so the workflow has to be chosen first. */
    const hold = await store.claim(FUNCTION, clock.runnerHoldMs);
    if (!hold) {
      console.log(line({ fn: FUNCTION, event: "nothing_due", elapsed_ms: Date.now() - started }));
      return json(200, { claimed: false, note: "nothing was due" });
    }

    const owner = (await db.query(
      `select organization_id::text as id from public.intelligence_workflows where id = $1::uuid`,
      [hold.workflowId])).rows[0];
    if (!owner) {
      await store.settle(hold.workflowId, "no_such_workflow");
      return json(200, { claimed: true, workflowId: hold.workflowId, refused: "no such workflow" });
    }
    const organizationId = String(owner.id);

    /* The gates, each named so a refusal says which one to turn on. */
    const gates = {
      networkFlag: Deno.env.get(NETWORK_VARIABLE) === "true",
      environment: (name: string) => Deno.env.get(name),
    };
    const registry = operatorRegistry(gates.environment);
    const authorized = authorityFor(gates.environment);

    if (isProblem(registry) || authorized === null) {
      /* Nothing is built and nothing is claimed further. The hold is given
         back with the honest answer that this pass moved nothing, so the
         record's own backoff applies and a misconfigured deployment does not
         hammer the database. */
      const missing = [
        isProblem(registry) ? REGISTRY_VARIABLE : null,
        authorized === null ? AUTHORITY_VARIABLE : null,
        Deno.env.get(PAID_CALLS_VARIABLE) === "true" ? null : PAID_CALLS_VARIABLE,
      ].filter((x): x is string => x !== null);
      await store.release({ workflowId: hold.workflowId, holdToken: hold.holdToken, moved: false, error: "not_configured" });
      console.log(line({ fn: FUNCTION, event: "not_configured", workflow: hold.workflowId, missing: missing.join(",") }));
      return json(200, {
        claimed: true, workflowId: hold.workflowId, moved: false,
        refused: "this runner is not configured to run anything yet", missing,
      });
    }

    const built = await buildWorldFor({
      client: db as never, workflowId: hold.workflowId, organizationId,
      registry, gates, answerWithinMs: clock.answerWithinMs, authorized,
    });
    if (isProblem(built)) {
      /* A runner that cannot prove it holds this workflow's material stops
         scheduling it rather than advancing it with somebody else's. */
      await store.settle(hold.workflowId, "material_not_provable");
      console.error(line({ fn: FUNCTION, event: "material_not_provable", workflow: hold.workflowId }));
      return json(200, { claimed: true, workflowId: hold.workflowId, refused: built.refused, detail: built.detail });
    }

    /* The hold is already ours; the pass below claims its own, which is the
       one the runner releases. Give this one back first so the two do not
       fight over the same row. */
    await store.release({ workflowId: hold.workflowId, holdToken: hold.holdToken, moved: false, nextDueAt: new Date(Date.now() - 1000) });

    const outcome = await runOnePass({
      name: FUNCTION,
      clock, store,
      connect: async () => db as never,
      world: built.world,
      concurrentAttempts: concurrencyFor(gates.environment),
      events: (event) => console.log(line(event as unknown as Record<string, unknown>)),
    });

    console.log(line({
      fn: FUNCTION, event: "pass", workflow: outcome.workflowId, state: outcome.state,
      moved: outcome.moved, stop: outcome.stopReason, ticks: outcome.ticks,
      scheduled_again: outcome.scheduledAgain, elapsed_ms: outcome.elapsedMs,
      unresolved_hosts: built.unresolvedHosts.length,
    }));

    /* THE CHAIN, LAST AND BEST-EFFORT. The record already says when to come
       back; this only makes it sooner. */
    if (outcome.scheduledAgain) await knockAgain(expected);

    return json(200, {
      claimed: outcome.claimed,
      workflowId: outcome.workflowId,
      state: outcome.state,
      moved: outcome.moved,
      stopReason: outcome.stopReason,
      scheduledAgain: outcome.scheduledAgain,
      elapsedMs: outcome.elapsedMs,
      problems: outcome.problems,
    });
  } catch (error) {
    if (error instanceof DatabaseUnreachable) return json(503, { refused: "the record is not reachable" });
    console.error(line({ fn: FUNCTION, event: "unhandled", problem: (error as Error).name }));
    return json(500, { refused: "the tick did not complete" });
  } finally {
    if (db) await db.close().catch(() => undefined);
  }
});

/* Asks the platform to run this function again, now. Deliberately not
   awaited for its result beyond the send, deliberately short, and
   deliberately unable to fail the pass that is already written down. */
async function knockAgain(secret: string): Promise<void> {
  const url = Deno.env.get(CHAIN_VARIABLE);
  if (!url) return;
  try {
    const answer = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", [SECRET_HEADER]: secret },
      body: JSON.stringify({ op: "tick", wokenBy: "chain" }),
      signal: AbortSignal.timeout(2_000),
    });
    /* The body is not read and not kept: this is a knock, not a conversation.
       Draining it keeps the connection from being held open. */
    await answer.body?.cancel();
    console.log(line({ fn: FUNCTION, event: "chain.knocked", status: answer.status }));
  } catch (error) {
    /* The watchdog will find it. Said out loud so a chain that is failing
       every time is visible rather than merely slow. */
    console.log(line({ fn: FUNCTION, event: "chain.failed", problem: (error as Error).name }));
  }
}
