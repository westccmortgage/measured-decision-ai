/* Accepting that a planned capture will never be made.
 *
 * A roadmap built from a plan set asks for evidence of every phase, including
 * phases that finished before anybody started keeping a record — demolition and
 * foundation on a house bought mid-project are the ordinary case. Those items
 * used to stay blocked for ever, so the record was permanently red about
 * something nobody would ever photograph, and a record that is permanently
 * wrong stops being read.
 *
 * What this must not become is a delete button. The three things asserted here
 * are the three that keep it honest: a reason is required, the acceptance is
 * shown as an absence rather than as a completion, and it can be withdrawn.
 */
import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";
import http from "http"; import fs from "fs"; import path from "path";
import { roadmapRows } from "./seed.mjs";

const ROOT = path.resolve(".");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
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

let bad = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? `\n         ${detail}` : ""}`);
  if (!ok) bad++;
};

async function openRoadmap(world) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  await context.route("**://*/**", (r) => (r.request().url().startsWith(base) ? r.continue() : r.abort()));
  await context.addInitScript(`window.__seed = ${JSON.stringify({ rows: world })};`);
  await context.addInitScript({ path: "studio/tests/fake-supabase.js" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 160)));
  await page.goto(`${base}/studio/plans/?property=prop-1`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  return { context, page, errors };
}

console.log("\n── a capture nobody will ever make ──");
{
  const { context, page, errors } = await openRoadmap(roadmapRows());
  check("the roadmap opens", errors.length === 0, errors[0] || "");
  const opened = await page.evaluate(async () => {
    const card = document.querySelector("[data-requirement]");
    if (!card) return false;
    card.click();
    await new Promise((r) => setTimeout(r, 400));
    return !document.querySelector("#task-dialog")?.hidden;
  });
  check("the capture opens", opened);

  const offered = await page.evaluate(() => {
    const b = document.querySelector("#waive-task");
    return b && b.offsetParent !== null ? b.textContent.trim() : null;
  });
  check("accepting it as missing is offered", Boolean(offered), offered || "no control");

  /* A reason is the whole point. Without it the record says a gap was closed
     and cannot say why, which is worse than leaving it open. */
  const refusedEmpty = await page.evaluate(async () => {
    document.querySelector("#waiver-reason").value = "";
    document.querySelector("#waive-task").click();
    await new Promise((r) => setTimeout(r, 400));
    return window.__rpcCalls.filter((c) => c.name === "waive_capture_task").length;
  });
  check("and it refuses to record one without a reason", refusedEmpty === 0, `${refusedEmpty} call(s) made`);

  const sent = await page.evaluate(async () => {
    document.querySelector("#waiver-reason").value = "Demolition finished before we were engaged.";
    document.querySelector("#waive-task").click();
    await new Promise((r) => setTimeout(r, 600));
    return window.__rpcCalls.find((c) => c.name === "waive_capture_task")?.args || null;
  });
  check("with a reason it is recorded", Boolean(sent), sent ? JSON.stringify(sent) : "no call made");
  check("and the reason travels with it", /before we were engaged/.test(sent?.p_reason || ""));
  check("along with which kind of acceptance it is",
    ["accepted_no_evidence", "not_applicable"].includes(sent?.p_kind), sent?.p_kind || "(none)");
  await context.close();
}

console.log("\n── a whole phase at once ──");
{
  const { context, page } = await openRoadmap(roadmapRows());
  page.on("dialog", (d) => d.accept());
  const sent = await page.evaluate(async () => {
    document.querySelector("[data-requirement]").click();
    await new Promise((r) => setTimeout(r, 400));
    document.querySelector("#waiver-reason").value = "We were not engaged until after demolition finished.";
    document.querySelector("#waive-phase").click();
    await new Promise((r) => setTimeout(r, 700));
    return window.__rpcCalls.find((c) => c.name === "waive_capture_phase")?.args || null;
  });
  check("one decision closes the phase", Boolean(sent), sent ? JSON.stringify(sent) : "no call made");
  check("and it names the phase, not just the capture", Boolean(sent?.p_phase_id), sent?.p_phase_id || "");
  await context.close();
}

console.log("\n── what the record says afterwards ──");
{
  const { context, page, errors } = await openRoadmap(roadmapRows({ waived: true }));
  check("the roadmap opens", errors.length === 0, errors[0] || "");
  const card = await page.evaluate(() => (document.querySelector(".task-card")?.innerText || "").replace(/\s+/g, " "));
  /* An accepted gap is an absence, not an achievement. It must never read as
     captured, verified, or done. */
  check("the card says the capture was accepted as missing", /accepted as missing/i.test(card), card);
  /* "Waived" is our word, not a builder's. A status pill has to carry meaning
     to somebody reading the record for the first time. */
  check("and it does not use our internal word for it", !/\bwaived\b/i.test(card), card);
  check("and it does not read as done", !/\bverified\b|\bcaptured\b|\bcomplete\b/i.test(card), card);
  check("the reason is on the card, not hidden a click away",
    /before we were engaged/i.test(card), card);

  const panel = await page.evaluate(async () => {
    document.querySelector("[data-requirement]").click();
    await new Promise((r) => setTimeout(r, 400));
    return {
      text: (document.querySelector("#waiver-current")?.innerText || "").replace(/\s+/g, " "),
      canLift: document.querySelector("#lift-waiver")?.offsetParent !== null,
      formHidden: document.querySelector("#waiver-form")?.hidden === true,
    };
  });
  check("opening it repeats that no evidence exists", /no evidence exists/i.test(panel.text), panel.text);
  check("it says who accepted that and when", /accepted by .* on /i.test(panel.text), panel.text);
  /* A decision made on bad information has to be reversible, or nobody will
     make it. */
  check("and it can be put back on the roadmap", panel.canLift === true);
  check("while it stays accepted, it is not offered again", panel.formHidden === true);
  await context.close();
}

await browser.close(); server.close();
console.log(bad ? `\n${bad} FAILURES` : "\nALL OK");
process.exit(bad ? 1 : 0);
