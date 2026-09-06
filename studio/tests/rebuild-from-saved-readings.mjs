/* A finished reading, put back together from its saved parts — on the plans
 * page, with the worker stubbed at the client boundary and no provider
 * anywhere.
 *
 * What is proved:
 *   - the offer stands only for a completed reading made in parts, every
 *     part with a saved reading, for a role that may analyze;
 *   - pressing it sends exactly one rebuild for exactly that job, and says
 *     in words that no AI was called;
 *   - a double press is one press;
 *   - a refusal is said out loud and nothing else happens;
 *   - the guard the server runs is the same module's guard, tested as code.
 */
import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";
import http from "http"; import fs from "fs"; import path from "path";
import { deckTakeoffRows } from "./seed.mjs";
import { rebuildableFrom } from "../../supabase/functions/plan-analyze/chunking.js";

let bad = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? `\n         ${detail}` : ""}`);
  if (!ok) bad++;
};

console.log("── what may be rebuilt ──");
{
  const done = { state: "completed" };
  const part = (state = "complete", analysis = { gaps: [] }) => ({ state, analysis });
  check("a completed reading with two saved parts", JSON.stringify(rebuildableFrom(done, [part(), part()])) === '{"ok":true,"parts":2}');
  check("a reading still running is not", rebuildableFrom({ state: "processing" }, [part()]).ok === false);
  check("a reading made in one request has no parts to rebuild from", /one request/.test(rebuildableFrom(done, []).reason));
  check("a part without a saved reading stops the rebuild, and says which", /1 of 2 parts has no saved reading/.test(rebuildableFrom(done, [part(), part("failed", null)]).reason));
  check("a part whose reading is not an object counts as unread", rebuildableFrom(done, [part("complete", "oops")]).ok === false);
}

console.log("\n── the plans page ──");
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
const TOAST_STUB = `
  window.__toasts = [];
  document.addEventListener("DOMContentLoaded", () => {
    const toast = document.getElementById("toast");
    if (!toast) return;
    new MutationObserver(() => { if (toast.textContent) window.__toasts.push(toast.textContent); })
      .observe(toast, { childList: true, characterData: true, subtree: true });
  });`;

const readInParts = (world) => {
  const org = world.properties[0].organization_id;
  const property = world.properties[0].id;
  world.plan_analysis_jobs = [{
    id: "job-parts", organization_id: org, property_id: property, state: "completed",
    baseline_id: world.document_baselines[0].id, progress_stage: "completed", progress_percent: 100,
    error_code: null, error_message: null, started_at: "2026-09-06T18:18:00Z", created_at: "2026-09-06T18:18:00Z", completed_at: "2026-09-06T18:25:00Z",
  }];
  world.plan_analysis_chunks = [
    { id: "chunk-0", job_id: "job-parts", organization_id: org, chunk_index: 0, state: "complete", document_ids: ["doc-p2"] },
    { id: "chunk-1", job_id: "job-parts", organization_id: org, chunk_index: 1, state: "complete", document_ids: ["doc-p1"] },
  ];
  return world;
};

async function openPlans(world, functions = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route("**://*/**", (r) => (r.request().url().startsWith(base) ? r.continue() : r.abort()));
  await context.addInitScript(TOAST_STUB);
  await context.addInitScript(`window.__seed = ${JSON.stringify({ rows: world, functions })};`);
  await context.addInitScript({ path: "studio/tests/fake-supabase.js" });
  const page = await context.newPage();
  await page.goto(`${base}/studio/plans/?property=${world.properties[0].id}`, { waitUntil: "networkidle" });
  await page.click("#summary-full");
  await page.waitForSelector(".document-row");
  return { context, page };
}
const offerState = (page) => page.evaluate(() => ({
  hidden: document.getElementById("rebuild-offer")?.hidden,
  note: document.getElementById("rebuild-note")?.textContent || "",
  label: document.getElementById("rebuild-baseline")?.textContent || "",
}));
const rebuildCalls = (page) => page.evaluate(() => window.__rpcCalls.filter((c) => c.name === "plan-analyze" && c.args?.action === "rebuild"));

{
  /* A reading made in one request: nothing to rebuild from, no offer. */
  const world = deckTakeoffRows();
  world.plan_analysis_jobs = [{
    id: "job-whole", organization_id: world.properties[0].organization_id, property_id: world.properties[0].id, state: "completed",
    baseline_id: world.document_baselines[0].id, progress_stage: "completed", progress_percent: 100,
    error_code: null, error_message: null, started_at: "2026-09-06T18:18:00Z", created_at: "2026-09-06T18:18:00Z",
  }];
  world.plan_analysis_chunks = [];
  const { context, page } = await openPlans(world);
  const offer = await offerState(page);
  check("a reading made in one request offers no rebuild", offer.hidden === true);
  await context.close();
}
{
  /* A reading made in two parts, both saved. */
  const { context, page } = await openPlans(readInParts(deckTakeoffRows()), {
    "plan-analyze": { byAction: { rebuild: { job_id: "job-rebuild", baseline_id: "baseline-2", version: 2, state: "completed", rebuilt_from_job_id: "job-parts", parts: 2, provider_calls: 0 } } },
  });
  const offer = await offerState(page);
  check("a reading made in parts offers the rebuild, and says it costs nothing",
    offer.hidden === false && /made in 2 parts/.test(offer.note) && /no AI is called and nothing is spent/.test(offer.note)
    && offer.label === "Rebuild from saved readings", JSON.stringify(offer));
  /* A double press. */
  await page.evaluate(() => { const b = document.getElementById("rebuild-baseline"); b.click(); b.click(); });
  await page.waitForTimeout(600);
  const sent = await rebuildCalls(page);
  check("one press sends one rebuild, for exactly the reading that was made in parts",
    sent.length === 1 && sent[0].args.job_id === "job-parts", JSON.stringify(sent.map((c) => c.args)));
  const toasts = await page.evaluate(() => window.__toasts);
  check("and the person is told, in words, that no AI was called",
    toasts.some((t) => /Baseline v2 rebuilt from the saved readings of 2 parts\. No AI was called\./.test(t)), JSON.stringify(toasts));
  check("nothing went to the paid path", (await page.evaluate(() => window.__rpcCalls.filter((c) => c.name === "plan-analyze" && c.args?.action === "start"))).length === 0);
  await context.close();
}
{
  /* The server refuses: a part without a saved reading. */
  const { context, page } = await openPlans(readInParts(deckTakeoffRows()), {
    "plan-analyze": { byAction: { rebuild: { error: "1 of 2 parts has no saved reading; nothing can be rebuilt from a part that was not read.", job_id: "job-parts" } } },
  });
  await page.click("#rebuild-baseline");
  await page.waitForTimeout(500);
  const toasts = await page.evaluate(() => window.__toasts);
  check("a refusal is said out loud, with the server's reason",
    toasts.some((t) => /Nothing was rebuilt: 1 of 2 parts has no saved reading/.test(t)), JSON.stringify(toasts));
  await context.close();
}
{
  /* A part that did not finish: the offer does not stand. */
  const world = readInParts(deckTakeoffRows());
  world.plan_analysis_chunks[1].state = "failed";
  const { context, page } = await openPlans(world);
  check("a reading with an unfinished part offers no rebuild", (await offerState(page)).hidden === true);
  await context.close();
}
{
  /* A role that may not analyze sees no offer. */
  const world = readInParts(deckTakeoffRows());
  for (const member of world.organization_members || []) member.role = "viewer";
  const { context, page } = await openPlans(world);
  check("a viewer sees no offer", (await offerState(page)).hidden === true);
  await context.close();
}

await browser.close();
server.close();
console.log(bad ? `\n${bad} FAILURES` : "\nALL OK");
process.exit(bad ? 1 : 0);
