/* Every way the 360 machine refuses to start.
 *
 * A thing that can spend money on its own is only as safe as its refusals, so
 * those are what this drives: nothing queued, already running, started a minute
 * ago, not configured, AWS said no. The one success path is the least
 * interesting of the six.
 *
 * The decision is read out of the shared module and run against stand-ins, the
 * same way analysis-blocker.mjs does, so it can be checked without an AWS
 * account and without deploying anything.
 */
import fs from "fs";

const src = fs.readFileSync("supabase/functions/_shared/wake-360-machine.ts", "utf8");

/* Strip TypeScript that Node cannot parse, and the npm: import that only exists
   inside Deno. What is left is the decision itself, unchanged. */
const body = src
  .replace(/^import[\s\S]*?from "npm:@aws-sdk\/client-ec2@3";$/m, "")
  .replace(/^export type WakeReason[\s\S]*?$/m, "")
  .replace(/^export interface WakeResult \{[\s\S]*?^\}$/m, "")
  .replace(/: Promise<WakeResult>/g, "")
  .replace(/: WakeReason/g, "")
  .replace(/: WakeResult/g, "")
  .replace(/: string \| null = null/g, " = null")
  .replace(/: string \| null/g, "")
  .replace(/: \{ instanceId: string; client: any \} \| null/g, "")
  .replace(/: any/g, "")
  .replace(/Deno\.env\.get/g, "__env")
  .replace(/export /g, "");

const code = `
const __store = {};
function __env(key) { return __store[key]; }
${body}
export function setEnv(values) { Object.assign(__store, values); }
export { wakeWithMachine, COOLDOWN_MINUTES };`;

const mod = await import("data:text/javascript," + encodeURIComponent(code));

/* The failure path logs on purpose. Keep the test output readable without
   hiding a log that appears anywhere it should not. */
const realError = console.error;
let logged = 0;
console.error = (...args) => { logged++; if (!/could not be started/.test(String(args[0]))) realError(...args); };

let bad = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? `\n         ${detail}` : ""}`);
  if (!ok) bad++;
};

/* A Supabase stand-in that answers only what this decision asks: how many jobs
   are claimable, and whether a machine was started recently. Every insert is
   kept, because the record of the attempt is half of what is being tested. */
function fakeAdmin({ queued = 0, startedRecently = false, queueBroken = false } = {}) {
  const written = [];
  return {
    written,
    from(table) {
      if (table === "capture_360_jobs") {
        return {
          select: () => ({
            in: () => Promise.resolve(
              queueBroken
                ? { count: null, error: { message: "queue unavailable" } }
                : { count: queued, error: null },
            ),
          }),
        };
      }
      if (table === "machine_wake_events") {
        return {
          select: () => ({
            eq: () => ({
              gte: () => ({
                limit: () => Promise.resolve({
                  data: startedRecently ? [{ created_at: "now" }] : [],
                }),
              }),
            }),
          }),
          insert: (row) => { written.push(row); return Promise.resolve({ error: null }); },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

const machine = (state, { failStart = false } = {}) => {
  const sent = [];
  return {
    sent,
    instanceId: "i-test",
    client: {
      send(command) {
        sent.push(command.__kind);
        if (command.__kind === "describe") {
          return Promise.resolve({ Reservations: [{ Instances: [{ State: { Name: state } }] }] });
        }
        if (failStart) return Promise.reject(new Error("AWS said no"));
        return Promise.resolve({});
      },
    },
  };
};

/* The module builds real command objects; the stand-in only needs to tell them
   apart, so the constructors are replaced with tags. */
globalThis.DescribeInstancesCommand = class { constructor() { this.__kind = "describe"; } };
globalThis.StartInstancesCommand = class { constructor() { this.__kind = "start"; } };

const run = async (adminOptions, machineOrNull, reason = "upload") => {
  const admin = fakeAdmin(adminOptions);
  const result = await mod.wakeWithMachine(admin, reason, null, machineOrNull);
  return { result, admin, machine: machineOrNull };
};

console.log("\n── it refuses when there is nothing to buy ──");
{
  const { result, admin, machine: m } = await run({ queued: 0 }, machine("stopped"));
  check("an empty queue does not start a machine", result.outcome === "nothing_queued", result.detail);
  check("and AWS is never even asked", m.sent.length === 0, m.sent.join(", "));
  check("the refusal is still recorded", admin.written[0]?.outcome === "nothing_queued");
}

console.log("\n── it refuses when the machine is already working ──");
for (const state of ["running", "pending", "stopping"]) {
  const { result, machine: m } = await run({ queued: 3 }, machine(state));
  check(`"${state}" is left alone`, result.outcome === "already_awake", result.detail);
  check("  and no start was sent", !m.sent.includes("start"), m.sent.join(", "));
}

console.log("\n── it refuses a second start inside the cooldown ──");
{
  const { result, machine: m } = await run({ queued: 9, startedRecently: true }, machine("stopped"));
  /* Ten files dropped together are one machine, not ten. */
  check("a burst of uploads starts one machine", result.outcome === "too_soon", result.detail);
  check("and AWS is never asked", m.sent.length === 0, m.sent.join(", "));
  check("the cooldown is named in the answer", /\d+ minutes/.test(result.detail), result.detail);
}

console.log("\n── it refuses when nothing is configured ──");
{
  const { result, admin } = await run({ queued: 4 }, null);
  check("no machine means no start", result.outcome === "not_configured", result.detail);
  check("and it says so rather than failing silently", Boolean(result.detail), result.detail);
  check("the attempt is recorded anyway", admin.written[0]?.outcome === "not_configured");
}

console.log("\n── it refuses when the record cannot answer ──");
{
  const { result, machine: m } = await run({ queueBroken: true }, machine("stopped"));
  /* Not knowing whether there is work is not a reason to spend an hour of GPU. */
  check("an unreadable queue starts nothing", result.outcome === "failed", result.detail);
  check("and AWS is never asked", m.sent.length === 0, m.sent.join(", "));
}

console.log("\n── it refuses to claim success when AWS said no ──");
{
  const { result, admin } = await run({ queued: 2 }, machine("stopped", { failStart: true }));
  check("a refused start is reported as failed", result.outcome === "failed", result.detail);
  check("and never as started", admin.written[0]?.outcome !== "started");
}

console.log("\n── and it starts when there is work and nothing in the way ──");
{
  const { result, admin, machine: m } = await run({ queued: 3 }, machine("stopped"));
  check("a stopped machine with work is started", result.outcome === "started", result.detail);
  check("it looked before it acted", m.sent[0] === "describe", m.sent.join(", "));
  check("then started it", m.sent.includes("start"), m.sent.join(", "));
  check("the answer says how much work is waiting", /3 captures/.test(result.detail), result.detail);
  check("the start is on the record with the count",
    admin.written[0]?.outcome === "started" && admin.written[0]?.queued_jobs === 3,
    JSON.stringify(admin.written[0]));
  check("and which machine it was", admin.written[0]?.instance_id === "i-test");
}

console.log("\n── who asked is kept ──");
{
  const admin = fakeAdmin({ queued: 1 });
  await mod.wakeWithMachine(admin, "person", "user-7", machine("stopped"));
  check("a person's request names the person",
    admin.written[0]?.requested_by_kind === "person" && admin.written[0]?.requested_by === "user-7",
    JSON.stringify(admin.written[0]));
}

console.log("\n── and a failure is not swallowed ──");
check("the refused start was written to the log", logged > 0, `${logged} log line(s)`);

console.log(bad ? `\n${bad} FAILURES` : "\nALL OK");
process.exit(bad ? 1 : 0);
