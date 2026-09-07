/* A READING CAN ALWAYS BE LEFT.
 *
 * A person watched "Analysis is running" for twenty minutes for a reading
 * that had been over for sixteen of them. Two faults, and this holds both
 * shut.
 *
 * The screen had no way out. There was no stop, so the only exits were
 * closing the tab and hoping, or asking someone with database access. Now
 * there is a button, and it tells the truth before it is pressed: stopping
 * ends the waiting, it does not recall a request already sent, and a reading
 * already with the provider may still run and be billed.
 *
 * And the job never learned that its chunk had failed. A synchronous chunk
 * records its own failure and throws into a background task whose only
 * listener writes a log line — so every later poll saw nothing processing,
 * nothing pending, not all complete, and answered "still reading" forever.
 * The failure was sitting on the chunk the whole time; nothing carried it up.
 */
import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";
import http from "http"; import fs from "fs"; import path from "path";
import { deckTakeoffRows, planDocument } from "./seed.mjs";

let bad = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? `\n         ${detail}` : ""}`);
  if (!ok) bad++;
};

console.log("── the job hears about a chunk that failed ──");
{
  const plan = fs.readFileSync("supabase/functions/plan-analyze/index.ts", "utf8");
  check("a failed chunk with nothing left to run fails the job instead of polling forever",
    /const failed = chunks\.filter\(\(chunk\) => chunk\.state === "failed"\);/.test(plan)
    && /const pending = chunks\.filter\(\(chunk\) => chunk\.state === "pending"\);/.test(plan)
    && /if \(failed\.length && !pending\.length\) \{/.test(plan)
    && /await markJobFailed\(admin, job, resumeMessage\);/.test(plan));
  check("and the reason a person reads is the chunk's own, not a generic one",
    /String\(worst\.error_message \|\| "the reading did not finish\."\)/.test(plan)
    /* which means the poll has to actually select that column */
    && /\.select\("id, chunk_index, document_ids, provider_job_id, state, updated_at, ai_run_id, error_message"\)/.test(plan));
  check("finished parts are still counted as saved in that message",
    /finished chunk\$\{completeCount === 1 \? "" : "s"\} stay/.test(plan));

  console.log("\n── stopping is honest about what it cannot undo ──");
  check("a chunk already with the provider becomes an unknown outcome, because that is what it is",
    /finishAiRun\(admin, chunk\.ai_run_id \|\| null, "outcome_unknown", \{\}, "stopped_by_person"\)/.test(plan)
    && /may already have run and been billed — confirm before running it again\./.test(plan));
  check("a chunk not yet sent is dropped and says nothing was bought for it",
    /Stopped before this chunk was sent\. Nothing was bought for it\./.test(plan));
  check("the job is cancelled, never quietly deleted, and finished parts stay saved",
    /state: "cancelled",/.test(plan) && /Finished parts stay saved\./.test(plan));
  check("stopping is recorded in the audit trail with who and what it cost",
    /action: "plan_analysis\.stopped"/.test(plan)
    && /unknown_outcome_chunks: unknown, dropped_chunks: dropped/.test(plan));
  check("nothing is re-run by stopping",
    !/launchNextPendingChunk/.test(plan.slice(plan.indexOf('if (action === "cancel")'), plan.indexOf('if (action === "rebuild")'))));
  check("and a job that already finished is not 'stopped' after the fact",
    /already_finished: true/.test(plan));
}

console.log("\n── the button, on the screen ──");
const ROOT = path.resolve(".");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css" };
const server = http.createServer((req, res) => {
  let f = path.join(ROOT, decodeURIComponent(req.url.split("?")[0]));
  if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, "index.html");
  if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(f)] || "application/octet-stream" });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox", "--no-proxy-server", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});

/* A project whose reading has been running for twenty minutes — the screen
   the person was stuck on. */
function world({ stage = "reading_documents", percent = 20 } = {}) {
  const w = deckTakeoffRows();
  w.properties[0].name = "4423 Noble";
  w.organization_members[0].role = "owner";
  w.project_documents = [planDocument({ id: "doc-a", original_filename: "nobleS2S3S4.pdf", document_type: "structural", status: "ready", byte_size: 1_200_000 })];
  w.document_baselines = [];
  w.material_takeoffs = [];
  w.plan_analysis_jobs = [{
    id: "job-stuck", organization_id: w.properties[0].organization_id, property_id: w.properties[0].id,
    state: "processing", baseline_id: null, progress_stage: stage, progress_percent: percent,
    error_code: null, error_message: null,
    started_at: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
    created_at: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
  }];
  return w;
}

const STOPPED = {
  job_id: "job-stuck", state: "cancelled", progress_stage: "failed", code: "stopped_by_person",
  error: "Stopped by a person. 1 reading was already with the provider and may still run and be billed — confirm before running it again. Finished parts stay saved.",
  unknown_outcome_chunks: 1, dropped_chunks: 0,
};

async function open(functions, seedOptions = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  await context.route("**://*/**", (r) => (r.request().url().startsWith(base) ? r.continue() : r.abort()));
  await context.addInitScript(`window.__seed = ${JSON.stringify({
    rows: world(seedOptions),
    functions: { "plan-analyze": { byAction: functions } },
  })};`);
  await context.addInitScript(`window.__confirmed = []; window.confirm = (text) => { window.__confirmed.push(text); return true; };`);
  await context.addInitScript({ path: "studio/tests/fake-supabase.js" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  await page.goto(`${base}/studio/plans/?property=${world().properties[0].id}`, { waitUntil: "networkidle" });
  await page.evaluate(() => document.getElementById("summary-full")?.click());
  await page.waitForTimeout(700);
  return { context, page, errors };
}

{
  const { context, page, errors } = await open({
    status: { job_id: "job-stuck", state: "processing", progress_stage: "reading_documents", progress_percent: 20 },
    cancel: STOPPED,
  });
  const before = await page.evaluate(() => ({
    progressHidden: document.getElementById("analysis-progress")?.hidden,
    stopHidden: document.getElementById("stop-analysis")?.hidden,
    stopText: document.getElementById("stop-analysis")?.textContent.trim(),
    analyze: document.getElementById("analyze-plans")?.textContent.replace(/\s+/g, " ").trim(),
  }));
  check("a reading that is running shows a way to stop it",
    before.progressHidden === false && before.stopHidden === false
    && before.stopText === "Stop waiting for this reading",
    JSON.stringify(before));
  check("which is the only exit the old screen lacked — Analyze itself stays disabled",
    /Analysis is running/.test(before.analyze || ""), before.analyze);

  await page.evaluate(() => document.getElementById("stop-analysis").click());
  await page.waitForTimeout(700);
  const after = await page.evaluate(() => ({
    asked: window.__confirmed[0] || "",
    calls: window.__rpcCalls.filter((c) => c.name === "plan-analyze").map((c) => c.args?.action),
    stopHidden: document.getElementById("stop-analysis")?.hidden,
    toast: document.querySelector(".toast, #toast")?.textContent?.replace(/\s+/g, " ").trim() || "",
  }));
  check("it warns, before anything happens, that a sent request cannot be recalled",
    /cannot recall the request/.test(after.asked) && /may still run and be billed/.test(after.asked), after.asked.slice(0, 120));
  check("and that finished parts stay saved",
    /Parts already finished stay saved/.test(after.asked));
  check("pressing it stops exactly once and starts nothing",
    after.calls.filter((call) => call === "cancel").length === 1
    && !after.calls.includes("start"), after.calls.join(","));
  check("the waiting ends on the screen",
    after.stopHidden === true);
  check("and the person is told how many readings may still be billed",
    /may still run and be billed/.test(after.toast), after.toast.slice(0, 140));
  check("nothing threw", errors.length === 0, errors[0] || "");
  await context.close();
}

{
  /* Nothing sent yet: the warning must not claim a cost that was never
     incurred. */
  const { context, page } = await open({
    status: { job_id: "job-stuck", state: "queued", progress_stage: "queued", progress_percent: 4 },
    cancel: { ...STOPPED, unknown_outcome_chunks: 0, error: "Stopped by a person. Nothing had been sent, so nothing was bought. Finished parts stay saved." },
  }, { stage: "queued", percent: 4 });
  await page.evaluate(() => document.getElementById("stop-analysis")?.click());
  await page.waitForTimeout(600);
  const asked = await page.evaluate(() => window.__confirmed[0] || "");
  check("before the plans have gone, stopping says plainly that nothing will be bought",
    /Nothing has been sent to the provider yet, so nothing will be bought/.test(asked), asked.slice(0, 120));
  await context.close();
}

await browser.close();
server.close();
console.log(bad ? `\n${bad} FAILURES` : "\nALL OK");
process.exit(bad ? 1 : 0);
