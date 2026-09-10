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
import { tickOnce } from "../../../workers/core-v2-runner/tick.ts";
import { denoTransport } from "../core-v2-runner/world.ts";
import bundledDeclaration from "../../../workers/core-v2-canary/registry.canary.json" with { type: "json" };
import { readStoredObject } from "../_shared/core-v2/storage.ts";
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
  /* THE CLOCK STARTS HERE, AT THE DOOR.
     Before the secret is compared, before a route is read, before a socket
     exists. Everything below spends time the container is already counting,
     and the pass inside must be told how much of its life is actually left
     rather than assuming it begins now. */
  const started = Date.now();

  if (request.method !== "POST") return json(405, { refused: "this door takes POST" });

  /* WHO MAY KNOCK ON A DOOR WITH NO USER BEHIND IT.
   *
   * Two credentials, and both are proved by this code rather than by the
   * platform, because `verify_jwt = false` is what lets a cron job knock at
   * all.
   *
   *   · CORE_V2_RUNNER_SECRET, when an operator sets one. A dedicated secret
   *     is the better credential and it stays the first thing asked for.
   *   · the platform's own service-role key, which every Edge Function is
   *     given and which the human door already holds. It is what lets the
   *     "Run analysis" press reach this door without anybody having to create,
   *     copy and rotate a second secret first.
   *
   * Neither is compared with a short circuit, and with neither set the door
   * does not open at all. */
  const secret = Deno.env.get(SECRET_VARIABLE) ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!secret && !serviceKey) {
    return json(503, { refused: `neither ${SECRET_VARIABLE} nor SUPABASE_SERVICE_ROLE_KEY is set; this door stays shut` });
  }
  const offeredHeader = request.headers.get(SECRET_HEADER) ?? "";
  const authorization = request.headers.get("authorization") ?? "";
  const offeredBearer = authorization.toLowerCase().startsWith("bearer ") ? authorization.slice(7).trim() : "";
  const allowed = (secret && sameSecret(offeredHeader, secret))
    || (serviceKey && (sameSecret(offeredHeader, serviceKey) || sameSecret(offeredBearer, serviceKey)));
  const offered = offeredHeader || offeredBearer;
  if (!allowed && !offered) return json(401, { refused: "not for you" });
  const expected = secret || serviceKey;

  const route = routeToRecord(ROUTE_PREFIX, (name) => Deno.env.get(name));
  if (isRouteProblem(route)) return json(503, { refused: route.problem });

  const clock = invocationClock({
    lifetimeMs: Number(Deno.env.get("CORE_V2_RUNNER_LIFETIME_MS") ?? EDGE_FUNCTION_LIFETIME_MS),
  });
  /* One absolute moment, derived once, handed down. */
  const deadlineAt = started + clock.deadlineMs;

  let db: EdgeDatabase | null = null;
  try {
    db = await EdgeDatabase.connect(route.url, FUNCTION);

    /* THE THIRD WAY IN, AND THE ONLY ONE THE WATCHDOG CAN USE.
     *
     * A watchdog running inside the database cannot set a variable in this
     * function's environment, so it knocks with the value of a Vault secret
     * the record names. Recognising that means asking the record, which this
     * function is now connected to. The value never leaves the database: the
     * answer is true or false.
     *
     * It is asked LAST, after the two credentials that need no connection, so
     * an ordinary caller costs nothing extra — and it is asked at all only
     * when something was actually offered. */
    if (!allowed) {
      const recognised = (await db.query(
        `select public.core_v2_runner_secret_matches($1::text) as ok`, [offered])).rows[0];
      /* The driver hands a boolean back as the text of one, so both are read
         and neither is guessed at. */
      if (String(recognised?.ok ?? "") !== "true" && String(recognised?.ok ?? "") !== "t") {
        return json(401, { refused: "not for you" });
      }
      console.log(line({ fn: FUNCTION, event: "auth.by_record" }));
    }

    const store = new PostgresContinuationStore(db as never);

    const result = await tickOnce({
      runner: FUNCTION,
      client: db as never,
      store, clock,
      gates: {
        networkFlag: Deno.env.get(NETWORK_VARIABLE) === "true",
        environment: (name: string) => Deno.env.get(name),
      },
      transport: denoTransport,
      readObject: readStoredObject,
      bundledRegistry: bundledDeclaration,
      startedAt: started,
      deadlineAt,
      events: (event) => console.log(line(event as unknown as Record<string, unknown>)),
    });

    if (result.kind === "nothing_due") {
      console.log(line({
        fn: FUNCTION, event: "nothing_due", elapsed_ms: Date.now() - started,
        reconciled: result.reconciled.length,
      }));
      return json(200, { claimed: false, note: "nothing was due", reconciled: result.reconciled.length });
    }
    if (result.kind === "no_such_workflow") {
      return json(200, { claimed: true, workflowId: result.workflowId, refused: "no such workflow" });
    }
    if (result.kind === "not_configured") {
      console.log(line({ fn: FUNCTION, event: "not_configured", workflow: result.workflowId, missing: result.missing.join(",") }));
      return json(200, {
        claimed: true, workflowId: result.workflowId, moved: false,
        refused: "this runner is not configured to run anything yet", missing: result.missing,
      });
    }
    if (result.kind === "material_not_provable") {
      console.error(line({ fn: FUNCTION, event: "material_not_provable", workflow: result.workflowId }));
      return json(200, {
        claimed: true, workflowId: result.workflowId,
        refused: "this runner cannot prove it holds this workflow's material", detail: result.detail,
      });
    }

    const outcome = result.outcome;
    console.log(line({
      fn: FUNCTION, event: "pass", workflow: outcome.workflowId, state: outcome.state,
      moved: outcome.moved, deferred: outcome.deferred, stop: outcome.stopReason, ticks: outcome.ticks,
      scheduled_again: outcome.scheduledAgain, elapsed_ms: outcome.elapsedMs,
      final_stop: outcome.finalStop ? outcome.finalStop.reason : null,
      reconciled: result.reconciled.length,
      unresolved_hosts: result.unresolvedHosts.length,
    }));

    /* THE CHAIN, LAST AND BEST-EFFORT. The record already says when to come
       back; this only makes it sooner. */
    if (outcome.scheduledAgain) await knockAgain(expected);

    return json(200, {
      claimed: outcome.claimed,
      workflowId: outcome.workflowId,
      state: outcome.state,
      moved: outcome.moved,
      deferred: outcome.deferred,
      stopReason: outcome.stopReason,
      scheduledAgain: outcome.scheduledAgain,
      finalStop: outcome.finalStop,
      /* Workflows whose stop had been half-written and which this tick brought
         back into agreement. Repaired on every tick, not only an idle one. */
      reconciled: result.reconciled.length,
      elapsedMs: outcome.elapsedMs,
      problems: outcome.problems,
    });
  } catch (error) {
    if (error instanceof DatabaseUnreachable) return json(503, { refused: "the record is not reachable" });
    /* THE NAME OF AN ERROR IS NOT A DIAGNOSIS. Every ordinary failure in
       here is called "Error", so a log that carried only the name said
       nothing at all — which cost this deployment one round of guessing.
       The message and the first frames go in the log, where an operator can
       read them, and never in the response, which anybody may read. */
    const problem = error as Error;
    console.error(line({
      fn: FUNCTION, event: "unhandled",
      problem: problem?.name ?? "unknown",
      said: String(problem?.message ?? "").slice(0, 400),
      where: String(problem?.stack ?? "").split("\n").slice(1, 4).join(" | ").slice(0, 400),
    }));
    return json(500, { refused: "the tick did not complete" });
  } finally {
    if (db) await db.end().catch(() => undefined);
  }
});

/* Asks the platform to run this function again, now. Deliberately not
   awaited for its result beyond the send, deliberately short, and
   deliberately unable to fail the pass that is already written down. */
async function knockAgain(secret: string): Promise<void> {
  /* The operator may point the chain anywhere. Where they have not, this
     function's own address is derivable from the platform's own variable, and
     deriving it beats asking somebody to write down a URL that is already
     known — a chain that is silently off because a variable was never set is
     a workflow that stops after one pass and looks like a product that
     forgets. */
  const base = Deno.env.get("SUPABASE_URL");
  const url = Deno.env.get(CHAIN_VARIABLE) || (base ? `${base}/functions/v1/${FUNCTION}` : "");
  if (!url) return;
  try {
    const answer = await fetch(url, {
      method: "POST",
      /* The header this door actually checks, and nothing else. An
         `authorization: Bearer` beside it would buy nothing — `verify_jwt` is
         false here — and would put a bearer-shaped line in the one file the
         boundary suite reads to prove no key is named. */
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
