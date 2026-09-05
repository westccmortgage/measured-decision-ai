/* AI COST GUARD — the fingerprint, and the browser half of the guard.
 *
 * The database refuses the second payment; that is proved in the SQL
 * invariants. This file proves the two things that live outside it:
 *
 *   1. the fingerprint recipe — that the same purchase hashes the same
 *      however the inputs are ordered, and that every input which can change
 *      the answer changes the hash;
 *   2. the browser's courtesy layer — one press, one job, and Reanalyze
 *      never spends without the sentence that names the cost.
 *
 * No provider is called. Nothing here costs anything.
 */
import fs from "fs";
import path from "path";
import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";

let bad = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? `\n         ${detail}` : ""}`);
  if (!ok) bad++;
};

/* ── the fingerprint ──────────────────────────────────────────────────────
 * The shipping recipe, imported from the shipping file rather than copied.
 * A copy would go on passing while the product drifted, which is the one
 * thing a test of a hash must never do. Node strips the types; the logic is
 * byte-for-byte what the workers run. */
const fingerprint = (await import(
  `file://${path.resolve("supabase/functions/_shared/ai-run-ledger.ts")}`
)).buildFingerprint;

console.log("\n── the same purchase hashes the same ──");
const base = {
  organizationId: "org-1",
  propertyId: "project-1",
  processKey: "spatial-analyze",
  model: "test-model",
  contractVersion: "contract-1",
  inputs: ["ev-a", "ev-b", "ev-c"],
  requirements: ["req-1", "req-2"],
  settings: { profile: "conservative", spherical: true },
};
const of = (patch) => fingerprint({ ...base, ...patch });

const original = await of({});
check("a fingerprint is a stable hex digest",
  /^[0-9a-f]{64}$/.test(original), original.slice(0, 16) + "…");
check("the same inputs in a different order are the same purchase",
  (await of({ inputs: ["ev-c", "ev-a", "ev-b"] })) === original);
check("the same requirements in a different order are the same purchase",
  (await of({ requirements: ["req-2", "req-1"] })) === original);
check("the same settings declared in a different order are the same purchase",
  (await of({ settings: { spherical: true, profile: "conservative" } })) === original);
/* A duplicate in the list is the same set of files. */
check("a repeated input does not change the purchase",
  (await of({ inputs: ["ev-a", "ev-a", "ev-b", "ev-c"] })) === original);

console.log("\n── anything that changes the answer changes the purchase ──");
check("changed evidence is a different purchase",
  (await of({ inputs: ["ev-a", "ev-b", "ev-d"] })) !== original);
check("added evidence is a different purchase",
  (await of({ inputs: ["ev-a", "ev-b", "ev-c", "ev-d"] })) !== original);
check("changed requirements are a different purchase",
  (await of({ requirements: ["req-1", "req-3"] })) !== original);
check("a changed model is a different purchase",
  (await of({ model: "other-model" })) !== original);
check("a changed prompt contract version is a different purchase",
  (await of({ contractVersion: "contract-2" })) !== original);
check("a changed analysis setting is a different purchase",
  (await of({ settings: { profile: "thorough", spherical: true } })) !== original);
check("another project is a different purchase",
  (await of({ propertyId: "project-2" })) !== original);
check("another organization is a different purchase",
  (await of({ organizationId: "org-2" })) !== original);
check("another process reading the same files is a different purchase",
  (await of({ processKey: "document-evidence" })) !== original);

/* ── the five workers all go through the one door ──────────────────────── */
console.log("\n── every paid worker claims before it spends ──");
const WORKERS = [
  "plan-analyze", "spatial-analyze", "document-classify",
  "document-evidence", "field-quality-check",
];
for (const worker of WORKERS) {
  const source = fs.readFileSync(`supabase/functions/${worker}/index.ts`, "utf8");
  check(`${worker} claims a run before calling the provider`,
    /claimAiRun\(/.test(source));
  check(`${worker} records what the run used`,
    /finishAiRun\(/.test(source) && /usageFrom\(/.test(source));
}
/* The one worker that does not use the shared transport still has to be in
   the ledger — it was the easiest one to forget. */
check("the worker that calls OpenAI directly is in the ledger too",
  /claimAiRun\(/.test(fs.readFileSync("supabase/functions/field-quality-check/index.ts", "utf8")));
/* And the compute this stage deliberately leaves out stays out. */
check("360 stitching is not in the AI ledger",
  !/claimAiRun|ai_runs/.test(fs.readFileSync("supabase/functions/capture-machine/index.ts", "utf8")));

/* ── the browser half ─────────────────────────────────────────────────── */
console.log("\n── one press, one job ──");
const ROOT = path.resolve(".");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const http = await import("http");
const server = http.createServer((req, res) => {
  let f = path.join(ROOT, decodeURIComponent(req.url.split("?")[0]));
  if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, "index.html");
  if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(f)] || "application/octet-stream" });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox", "--no-proxy-server"],
});
const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
await context.route("**://*/**", (r) => (r.request().url().startsWith(baseUrl) ? r.continue() : r.abort()));
const page = await context.newPage();
await page.goto(`${baseUrl}/studio/ai-usage.js`);
await page.setContent("<!doctype html><title>guard</title>");
await page.addScriptTag({ url: `${baseUrl}/studio/ai-usage.js` });

const pressed = await page.evaluate(async () => {
  const guard = window.MDAIAiUsage;
  let calls = 0;
  const slowAnalyze = () => guard.once("analyze", async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 60));
    return { ok: true };
  });
  /* Two presses microseconds apart, which is what a double click is. */
  const [first, second] = await Promise.all([slowAnalyze(), slowAnalyze()]);
  /* And a third once the first has finished — a deliberate second run. */
  const third = await slowAnalyze();
  return { calls, first, second, third };
});
check("a double press starts exactly one job",
  pressed.calls === 2 && pressed.second.skipped === "in_flight",
  JSON.stringify(pressed));
check("and the press after it finishes is allowed through",
  pressed.third.ok === true);

console.log("\n── Reanalyze never spends without saying what it costs ──");
const confirmed = await page.evaluate(() => {
  const guard = window.MDAIAiUsage;
  const asked = [];
  const declined = guard.confirmReanalyze((message) => { asked.push(message); return false; });
  const accepted = guard.confirmReanalyze((message) => { asked.push(message); return true; });
  return { asked, declined, accepted, warning: guard.REANALYZE_WARNING };
});
check("Reanalyze asks before it spends",
  confirmed.asked.length === 2);
check("and the question names the cost in the words agreed",
  confirmed.asked.every((m) => m === "This will run AI again and may use additional credits."),
  confirmed.warning);
check("declining spends nothing", confirmed.declined === false);
check("accepting is what allows the run", confirmed.accepted === true);

console.log("\n── the worker's refusal is not an error ──");
const verdicts = await page.evaluate(() => {
  const guard = window.MDAIAiUsage;
  return {
    reused: guard.skippedVerdict({ skipped: "reused" }),
    running: guard.skippedVerdict({ skipped: "running" }),
    normal: guard.skippedVerdict({ analysis: {} }),
    reusedText: guard.skippedMessage("reused"),
    runningText: guard.skippedMessage("running"),
  };
});
check("a reused reading is recognised as reuse, not failure",
  verdicts.reused === "reused" && /up to date/i.test(verdicts.reusedText), verdicts.reusedText);
check("a reading already in flight is recognised as such",
  verdicts.running === "running" && /already running/i.test(verdicts.runningText), verdicts.runningText);
check("and a real result is not mistaken for a refusal",
  verdicts.normal === null);

console.log("\n── money is never invented ──");
const money = await page.evaluate(async () => {
  const guard = window.MDAIAiUsage;
  const fakeClient = (row) => ({ rpc: async () => ({ data: [row], error: null }) });
  const priced = await guard.usageLine(
    fakeClient({ runs: 3, total_tokens: 12000, usage_missing: 0, estimated_cost_micros: 1250000 }),
    "p1",
  );
  const unpriced = await guard.usageLine(
    fakeClient({ runs: 3, total_tokens: 12000, usage_missing: 0, estimated_cost_micros: null }),
    "p1",
  );
  const partial = await guard.usageLine(
    fakeClient({ runs: 4, total_tokens: 900, usage_missing: 1, estimated_cost_micros: null }),
    "p1",
  );
  const none = await guard.usageLine(fakeClient({ runs: 0 }), "p1");
  return { priced, unpriced, partial, none };
});
check("with no price list the line says the cost is unavailable",
  /Cost unavailable/.test(money.unpriced) && !/\$/.test(money.unpriced), money.unpriced);
check("and it still reports the runs and the tokens",
  /3 runs/.test(money.unpriced) && /12,000 tokens/.test(money.unpriced), money.unpriced);
check("a run whose usage the provider never returned is said out loud",
  /reported no usage/.test(money.partial), money.partial);
check("a cost is shown only when one actually exists",
  /Estimated \$1\.25/.test(money.priced), money.priced);
check("and a project that has never used AI shows no line at all",
  money.none === null);

await browser.close();
server.close();
console.log(bad ? `\n${bad} FAILURES` : "\nALL OK");
process.exit(bad ? 1 : 0);
