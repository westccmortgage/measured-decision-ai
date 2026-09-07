/* The door to reading the same set again.
 *
 * When the selected documents were exactly the ones the current baseline
 * was read from, the analyze button used to go grey — "Baseline v2 is
 * ready" — until the baseline was approved. That is a dead end: the reader
 * improves, the contract changes, a person may want a second reading, and
 * the only way to buy one was to approve a baseline first. On 4423 Noble,
 * with a new contract deployed, there was no button to press.
 *
 * Now the button says "Reanalyze this set", stays pressable, and the press
 * is a deliberate second purchase: the sentence that names the cost comes
 * first, declining sends nothing, accepting starts one job as a forced
 * reading. An approved baseline still offers Field Operations.
 */
import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";
import http from "http"; import fs from "fs"; import path from "path";
import { deckTakeoffRows, planDocument } from "./seed.mjs";

let bad = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? `\n         ${detail}` : ""}`);
  if (!ok) bad++;
};
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
const CONFIRM_STUB = `
  window.__prompts = [];
  window.__decisions = [];
  window.confirm = (message) => { window.__prompts.push(message); return window.__decisions.length ? window.__decisions.shift() : false; };`;

/* The Noble shape: one split file, two parts, a baseline read from exactly those parts. */
function world(state = "review") {
  const w = deckTakeoffRows();
  const parent = "doc-set";
  w.project_documents = [
    planDocument({ id: parent, original_filename: "Set.pdf", document_type: "architectural", status: "ready", byte_size: 200 * 1024 * 1024 }),
    planDocument({ id: "doc-p1", original_filename: "Set (pages 1-25).pdf", document_type: "architectural", status: "ready", byte_size: 40 * 1024 * 1024,
      source_metadata: { derived_from: { document_id: parent, page_from: 1, page_to: 25, pages_total: 30, part: 1, parts: 2 } } }),
    planDocument({ id: "doc-p2", original_filename: "Set (pages 26-30).pdf", document_type: "structural", status: "ready", byte_size: 10 * 1024 * 1024,
      source_metadata: { derived_from: { document_id: parent, page_from: 26, page_to: 30, pages_total: 30, part: 2, parts: 2 } } }),
  ];
  w.document_baselines[0].source_document_ids = ["doc-p2", "doc-p1"];
  w.document_baselines[0].state = state;
  w.document_baselines[0].approved_at = state === "approved" ? "2026-09-06T20:00:00Z" : null;
  w.document_baselines[0].version = 2;
  w.document_baselines[0].analysis = { framing_walls: [], framing_decks: [], component_schedules: [
    { mark: "101", category: "door", description: "Type A", unit: "each", count_scheduled: 1, count_drawn: 1, count_proposed: 1, count_confidence: "high", count_note: "", source_refs: ["A-710"] },
  ] };
  w.material_takeoffs = [];
  return w;
}
async function openPlans(w) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route("**://*/**", (r) => (r.request().url().startsWith(base) ? r.continue() : r.abort()));
  await context.addInitScript(CONFIRM_STUB);
  await context.addInitScript(`window.__seed = ${JSON.stringify({ rows: w, functions: { "plan-analyze": { byAction: { start: { job_id: "job-new", state: "queued", progress_stage: "queued", progress_percent: 4 }, status: { job_id: "job-new", state: "processing", progress_stage: "reading_documents", progress_percent: 30 } } } } })};`);
  await context.addInitScript({ path: "studio/tests/fake-supabase.js" });
  const page = await context.newPage();
  await page.goto(`${base}/studio/plans/?property=${w.properties[0].id}`, { waitUntil: "networkidle" });
  await page.evaluate(() => document.getElementById("summary-full")?.click());
  await page.waitForSelector(".document-row");
  /* Select exactly the parts the baseline was read from. */
  await page.evaluate(() => {
    for (const box of document.querySelectorAll("[data-document-select]")) {
      if (/doc-p/.test(box.dataset.documentSelect) && !box.checked) box.click();
    }
  });
  await page.waitForTimeout(200);
  return { context, page };
}
const button = (page) => page.evaluate(() => ({
  label: document.getElementById("analyze-plans")?.textContent.replace(/\s+/g, " ").trim(),
  disabled: document.getElementById("analyze-plans")?.disabled,
  action: document.getElementById("analyze-plans")?.dataset.action,
  message: document.getElementById("action-message")?.textContent || "",
}));
const starts = (page) => page.evaluate(() => window.__rpcCalls.filter((c) => c.name === "plan-analyze" && c.args?.action === "start").map((c) => c.args));

console.log("── the same set, under review ──");
{
  const { context, page } = await openPlans(world("review"));
  const before = await button(page);
  check("the button stays pressable and says what it does",
    before.disabled === false && before.label === "Reanalyze this set ↗" && before.action === "reanalyze", JSON.stringify(before));
  check("and the message says the set is read, and that reading again costs",
    /already analyzed as baseline v2/.test(before.message) && /may use additional credits/.test(before.message), before.message);

  await page.click("#analyze-plans");
  await page.waitForTimeout(400);
  const declined = await page.evaluate(() => ({ prompts: window.__prompts, jobs: window.__rpcCalls.filter((c) => c.name === "plan-analyze").length }));
  check("pressing asks the sentence that names the cost, and a No sends nothing",
    declined.prompts.length === 1 && declined.prompts[0] === "This will run AI again and may use additional credits." && declined.jobs === 0, JSON.stringify(declined));

  await page.evaluate(() => { window.__decisions.push(true); });
  await page.click("#analyze-plans");
  await page.waitForTimeout(900);
  const sent = await starts(page);
  check("a Yes starts exactly one reading, as a deliberate second purchase", sent.length === 1 && sent[0].force === true && sent[0].job_id, JSON.stringify(sent));
  await context.close();
}

console.log("\n── the same set, approved ──");
{
  const { context, page } = await openPlans(world("approved"));
  const approved = await button(page);
  check("an approved baseline still offers Field Operations, not a second reading",
    approved.label === "Open Field Operations ↗" && approved.action === "operations" && approved.disabled === false, JSON.stringify(approved));
  await context.close();
}

await browser.close();
server.close();
console.log(bad ? `\n${bad} FAILURES` : "\nALL OK");
process.exit(bad ? 1 : 0);
