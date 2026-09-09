/* EVERY DOOR IS CLOSED.
 *
 * kernel/network-guard.ts: "The dry run and the simulation must not be able
 * to reach a provider, a database or anything else outside the process — not
 * by accident, not by a mocked executor that turns out not to be a mock.
 * This closes every door Node offers: `fetch` (frozen, so it cannot be put
 * back), `http` and `https` requests, raw `net` and `tls` connections, DNS,
 * `WebSocket`, and child processes that could do any of it on the engine's
 * behalf. Each attempt throws and is counted; the simulation's summary
 * reports the count."
 *
 * A guard is only worth what it refuses, so nothing here reads the guard's
 * source or trusts its list of doors: every check below actually makes the
 * call, in a try/catch, and fails if it was allowed. The addresses used are
 * a loopback port nothing listens on and a hostname in the reserved
 * `.invalid` domain, so a check that somehow got through would still reach
 * nobody — but a check that got through fails, which is the point.
 *
 * The last section runs the whole engine over an invented record set and
 * shows the counter did not move: the engine itself touches no door.
 */
import { request as namedHttpRequest } from "node:http";
import { harness, closeNetwork } from "./harness.mjs";
import { closeTheNetwork } from "../kernel/network-guard.ts";
import { syntheticRecordSet } from "../domains/synthetic-records/fixture.ts";
import { SyntheticRecordsPack } from "../domains/synthetic-records/pack.ts";
import { mockExecutors } from "../domains/synthetic-records/mocks.ts";
import { assemble, manualClock } from "../domains/simulate.ts";
import { TERMINAL_WORKFLOW_STATES } from "../kernel/transitions.ts";

/* This is the call that installs the guard — everything below runs behind
   it, including this file's own imports of the transport modules. */
const tripped = closeNetwork();
const t = harness("every door is closed");

/* Where a check would go if the guard let it: nobody, twice over. */
const DEAD_PORT = 1;
const LOOPBACK = "127.0.0.1";
const NOWHERE = "nowhere.invalid";
const DEAD_URL = `http://${NOWHERE}:${DEAD_PORT}/`;

const guard = closeTheNetwork();
const REFUSAL = /^core-v2: the network is closed in this mode \((.+)\)$/;

/* One door, one check. The call is made for real; the check passes only if
   it threw (or rejected) with the guard's own refusal and the guard's
   counter moved by exactly one. An allowed call, a thrown ENOTFOUND, or a
   refusal nobody counted all fail. */
const attempted = [];
async function door(label, expectedDoor, fn) {
  const before = tripped();
  let error = null;
  let allowed = false;
  try { await fn(); allowed = true; }
  catch (caught) { error = caught; }
  const after = tripped();
  const match = error ? REFUSAL.exec(String(error.message ?? error)) : null;
  const named = match ? match[1] : null;
  if (named) attempted.push(named);
  t.check(label,
    !allowed && named === expectedDoor && after === before + 1,
    allowed ? "THE CALL WAS ALLOWED" : `${named ? `refused at ${named}` : `threw something else: ${String(error?.message ?? error).slice(0, 80)}`}, counter ${before}→${after}`);
}

/* ───────────────────────────────────────────────────── the guard itself */
t.section("the guard itself");

t.check("closing the network twice returns the one guard, not a second one that would start counting from zero",
  closeTheNetwork() === guard && closeTheNetwork() === closeTheNetwork(),
  `${guard.doors.length} doors`);

t.check("the guard reports every door it shut, and names none of them twice",
  guard.doors.length > 0 && new Set(guard.doors).size === guard.doors.length,
  guard.doors.join(", "));

const fetchSeal = Object.getOwnPropertyDescriptor(globalThis, "fetch");
t.check("the seal over fetch is neither writable nor configurable, so the door cannot be quietly put back",
  !!fetchSeal && fetchSeal.writable === false && fetchSeal.configurable === false,
  fetchSeal ? `writable=${fetchSeal.writable} configurable=${fetchSeal.configurable}` : "no fetch at all");

await t.refused("assigning a working fetch back over the sealed one is refused by the runtime",
  async () => { globalThis.fetch = async () => new Response(""); });

await t.refused("deleting the sealed fetch to get the original back is refused by the runtime",
  async () => { delete globalThis.fetch; });

/* ────────────────────────────────────────────── the outbound request doors */
t.section("the outbound request doors");

await door("fetch to a host outside the process is refused and counted", "fetch",
  () => globalThis.fetch(DEAD_URL));

await door("constructing a WebSocket to a host outside the process is refused and counted", "WebSocket",
  () => new globalThis.WebSocket(`ws://${LOOPBACK}:${DEAD_PORT}`));

const http = (await import("node:http")).default;
const https = (await import("node:https")).default;

await door("http.request is refused and counted", "http.request",
  () => http.request(DEAD_URL));
await door("http.get is refused and counted", "http.get",
  () => http.get(DEAD_URL));
await door("https.request is refused and counted", "https.request",
  () => https.request(`https://${NOWHERE}/`));
await door("https.get is refused and counted", "https.get",
  () => https.get(`https://${NOWHERE}/`));

/* ─────────────────────────────────────────── raw sockets, plain and wrapped */
t.section("raw sockets, plain and wrapped");

const net = (await import("node:net")).default;
const tls = (await import("node:tls")).default;

await door("net.connect is refused and counted", "net.connect",
  () => net.connect(DEAD_PORT, LOOPBACK));
await door("net.createConnection is refused and counted", "net.createConnection",
  () => net.createConnection({ port: DEAD_PORT, host: LOOPBACK }));
await door("a socket built by hand cannot connect either: net.Socket.prototype.connect is refused and counted", "net.Socket.connect",
  () => new net.Socket().connect(DEAD_PORT, LOOPBACK));
await door("tls.connect is refused and counted, so an encrypted door is no more open than a plain one", "tls.connect",
  () => tls.connect({ port: DEAD_PORT, host: LOOPBACK, servername: NOWHERE }));

/* ─────────────────────────────────────────────────── even asking who is who */
t.section("even asking who is who");

const dns = (await import("node:dns")).default;

await door("dns.lookup is refused and counted — a name cannot even be resolved", "dns.lookup",
  () => dns.lookup(NOWHERE, () => {}));
await door("dns.resolve is refused and counted", "dns.resolve",
  () => dns.resolve(NOWHERE, () => {}));
await door("dns.resolve4 is refused and counted", "dns.resolve4",
  () => dns.resolve4(NOWHERE, () => {}));
await door("dns.resolve6 is refused and counted", "dns.resolve6",
  () => dns.resolve6(NOWHERE, () => {}));
await door("the promise form is shut too: dns.promises.lookup is refused and counted", "dns.promises.lookup",
  () => dns.promises.lookup(NOWHERE));
await door("dns.promises.resolve is refused and counted", "dns.promises.resolve",
  () => dns.promises.resolve(NOWHERE));

/* ───────────────────────────────────── anything that could do it for us */
t.section("anything that could do it for us");

const child_process = (await import("node:child_process")).default;

await door("child_process.spawn is refused and counted, so no subprocess can reach out on the engine's behalf", "child_process.spawn",
  () => child_process.spawn("printf", ["nothing"]));
await door("child_process.exec is refused and counted", "child_process.exec",
  () => child_process.exec("printf nothing", () => {}));
await door("child_process.execFile is refused and counted", "child_process.execFile",
  () => child_process.execFile("printf", ["nothing"], () => {}));
await door("child_process.fork is refused and counted", "child_process.fork",
  () => child_process.fork(new URL(import.meta.url).pathname));
await door("child_process.spawnSync is refused and counted", "child_process.spawnSync",
  () => child_process.spawnSync("printf", ["nothing"]));
await door("child_process.execSync is refused and counted", "child_process.execSync",
  () => child_process.execSync("printf nothing"));
await door("child_process.execFileSync is refused and counted", "child_process.execFileSync",
  () => child_process.execFileSync("printf", ["nothing"]));

t.check("every door the guard says it shut was actually tried above, and every door tried is one it claims",
  guard.doors.every((d) => attempted.includes(d)) && attempted.every((d) => guard.doors.includes(d)),
  `tried ${new Set(attempted).size} of ${guard.doors.length}; untried: ${guard.doors.filter((d) => !attempted.includes(d)).join(", ") || "none"}`);

/* ────────────────────────────────── the seals reach the modules' importers */
t.section("the seals reach the modules' importers");

/* syncBuiltinESMExports is what makes this true: the named binding below was
   linked before the guard ran, and it still refuses. */
await door("a named export imported from node:http before the guard ran refuses, because the guard resynchronised the builtin exports", "http.request",
  () => namedHttpRequest(DEAD_URL));

const freshHttp = await import("node:http");
await door("a module imported after the guard ran sees the sealed default export", "http.request",
  () => freshHttp.default.request(DEAD_URL));
await door("a module imported after the guard ran sees the sealed named export too", "http.get",
  () => freshHttp.get(DEAD_URL));

/* ─────────────────────────────────── the engine itself touches no door */
t.section("a whole run of the engine touches nothing");

const beforeRun = tripped();
const truth = syntheticRecordSet({ seed: "network-guard/records", sources: 2, sheetsPerSource: 2, entriesPerTable: 3 });
const { registry } = mockExecutors(truth);
const { scheduler, repo } = assemble({ manifest: truth.manifest, pack: new SyntheticRecordsPack(), executors: registry, clock: manualClock() });
const planned = await scheduler.plan();
const report = await scheduler.runUntilQuiescent();
const afterRun = tripped();

const tasks = await repo.listTasks(truth.manifest.workflowId);
let attemptCount = 0;
for (const task of tasks) attemptCount += (await repo.listAttempts(task.taskId)).length;
const decisions = await repo.listDecisions(truth.manifest.workflowId);

t.check("the run really ran: the workflow reached one of the states the design calls terminal",
  TERMINAL_WORKFLOW_STATES.includes(report.workflow.state), `${report.workflow.state} after ${report.ticks} ticks`);

t.check("the run really ran: tasks were planned, executors were handed packets, and attempts were recorded",
  planned.created.length > 0 && tasks.length > 0 && registry.packetsSeen.length > 0 && attemptCount > 0,
  `${planned.created.length} planned, ${tasks.length} tasks, ${registry.packetsSeen.length} packets, ${attemptCount} attempts`);

t.check("the run really ran: it reached the end of the chain and wrote decisions",
  decisions.length > 0, `${decisions.length} decisions, roles: ${Object.keys(report.byRole).sort().join(", ")}`);

t.check("and through all of it the engine opened no door: the guard's count is exactly what it was before the run",
  afterRun === beforeRun, `${beforeRun} before, ${afterRun} after`);

/* ───────────────────────────────────────────── the count is the guard's own */
t.section("the count is the guard's own");

t.check("a later closeTheNetwork() reports the same running total, so the guard is one counter and not a fresh one per call",
  closeTheNetwork().tripped() === tripped() && tripped() > 0, `${tripped()} attempts counted`);

t.check("the counter equals the number of doors this file actually pushed on — nothing counted that was not tried, nothing tried that was not counted",
  tripped() === attempted.length, `${tripped()} counted, ${attempted.length} attempted`);

t.finish();
