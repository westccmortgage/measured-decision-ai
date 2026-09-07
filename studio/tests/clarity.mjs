/* Interface and clarity.
 *
 * The advisor's verdict on the Noble screen was one out of ten: a marketing
 * hero on a project that already has a reading, a four-line contract beside
 * a card that said 100%, a summary that did not exist for a set with no
 * framing dimensions, and a narrow column in the middle of a wide screen.
 * This walks the real plans page with a schedule-only reading — the Noble
 * shape — and proves:
 *
 *   - the summary is the landing view for a reading with scheduled rows
 *     and no framing, with a one-line statement of what the plans state;
 *   - the hero is the project, not the pitch, once a reading exists;
 *   - the AI panel's contract steps aside and the card says no percentage;
 *   - the approval guidance is gone once the roadmap is active;
 *   - the workspace uses a wide screen;
 *   - and a reading with nothing to show still has no summary.
 */
import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";
import http from "http"; import fs from "fs"; import path from "path";
import { deckTakeoffRows } from "./seed.mjs";

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

const row = (mark, category, extra = {}) => ({
  mark, category, description: `${category} ${mark}; Type A`, unit: "each",
  count_scheduled: 1, count_drawn: 1, count_proposed: 1, count_confidence: "high", count_note: "", source_refs: ["A-710 (original p20)"], ...extra,
});
function scheduleOnly() {
  const w = deckTakeoffRows();
  w.properties[0].name = "4423 Noble";
  w.document_baselines[0].state = "review";
  w.document_baselines[0].approved_at = null;
  w.document_baselines[0].version = 2;
  w.document_baselines[0].analysis = {
    framing_walls: [], framing_decks: [], levels: [], systems: [],
    component_schedules: [row("101", "door"), row("102", "door"), row("01", "window"), row("F1", "electrical_fixture", { count_scheduled: 36, count_drawn: 0, count_proposed: 36 })],
  };
  w.document_baselines[0].gaps = [
    { severity: "critical", question: "Which issue status governs? NOT FOR CONSTRUCTION on every sheet.", source_refs: [], blocks_activation: true },
    { severity: "critical", question: "Resolve the fire-sprinkler conflict between A-002 and A-210.", source_refs: [], blocks_activation: true },
    { severity: "informational", question: "Analyzed in 2 chunks.", source_refs: [], blocks_activation: false },
  ];
  w.material_takeoffs = [];
  return w;
}
async function open(w, width = 1800) {
  const context = await browser.newContext({ viewport: { width, height: 1000 } });
  await context.route("**://*/**", (r) => (r.request().url().startsWith(base) ? r.continue() : r.abort()));
  await context.addInitScript(`window.__seed = ${JSON.stringify({ rows: w })};`);
  await context.addInitScript({ path: "studio/tests/fake-supabase.js" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  await page.goto(`${base}/studio/plans/?property=${w.properties[0].id}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  return { context, page, errors };
}

console.log("── a schedule-only reading has a summary ──");
{
  const { context, page, errors } = await open(scheduleOnly());
  const view = await page.evaluate(() => ({
    summaryMode: document.body.classList.contains("summary-mode"),
    summaryHidden: document.getElementById("owner-summary")?.hidden,
    title: document.getElementById("summary-title")?.textContent || "",
    decision: document.getElementById("summary-decision")?.textContent || "",
    read: document.getElementById("summary-read")?.textContent.replace(/\s+/g, " ").trim() || "",
    readHidden: document.getElementById("summary-read")?.hidden,
    downloadHidden: document.getElementById("summary-download")?.hidden,
    numbers: [...document.querySelectorAll("#summary-numbers article")].map((a) => a.textContent.replace(/\s+/g, " ").trim()),
    preview: [...document.querySelectorAll("#summary-table tbody tr")].map((tr) => tr.innerText.replace(/\s+/g, " ").trim()),
    issues: [...document.querySelectorAll("#summary-issues .summary-issue")].map((d) => d.textContent.replace(/\s+/g, " ").trim().slice(0, 60)),
  }));
  check("the summary is the landing view, for the reading that has no framing at all", view.summaryMode && view.summaryHidden === false, JSON.stringify({ mode: view.summaryMode, hidden: view.summaryHidden }));
  check("it names the project and the decision", /4423 Noble — analysis complete/.test(view.title) && /Blocked — clarification required/.test(view.decision), view.title + " | " + view.decision);
  check("and says in one line what the plans state, with framing said honestly",
    !view.readHidden && /Doors 2/.test(view.read) && /Windows 1/.test(view.read) && /Lighting and electrical 1/.test(view.read) && /Structural framing and foundation: not yet read as a schedule/.test(view.read), view.read);
  check("the numbers count the scheduled items", view.numbers.some((n) => /^4\s*scheduled items read$/.test(n)), JSON.stringify(view.numbers));
  check("the preview is the schedule, with the same words for how", view.preview.length === 4 && /Door 101 — door 101 1 each Printed quantity ready/i.test(view.preview[0]), JSON.stringify(view.preview));
  check("the top issues are the questions chosen by the rule", view.issues.length === 2 && /issue status/.test(view.issues[0]) && /fire-sprinkler/.test(view.issues[1]), JSON.stringify(view.issues));
  check("a takeoff download is not offered for a reading with no takeoff", view.downloadHidden === true);
  await page.evaluate(() => [...document.querySelectorAll("[data-summary-open]")].find((b) => /^Doors/.test(b.textContent))?.click());
  await page.waitForTimeout(400);
  const opened = await page.evaluate(() => ({
    summaryMode: document.body.classList.contains("summary-mode"),
    doorsOpen: document.querySelector('[data-result-section="door"]')?.open,
    baselineHidden: document.getElementById("baseline-section")?.hidden,
  }));
  check("Doors in the summary opens the Doors section of the result", !opened.summaryMode && opened.doorsOpen === true && opened.baselineHidden === false, JSON.stringify(opened));

  const hero = await page.evaluate(() => ({
    hasBaseline: document.body.classList.contains("has-baseline"),
    eyebrow: document.getElementById("hero-eyebrow")?.textContent || "",
    title: document.getElementById("hero-title")?.textContent || "",
    copy: document.getElementById("hero-copy")?.textContent || "",
    contractShown: getComputedStyle(document.querySelector(".contract")).display !== "none",
    valueShown: getComputedStyle(document.getElementById("analysis-progress-value")).display !== "none",
    stage: document.getElementById("analysis-stage-title")?.textContent || document.querySelector("#analysis-progress strong, .analysis-stage-title")?.textContent || "",
    eyebrows: [...document.querySelectorAll("p")].map((p) => p.textContent.trim()).filter((t) => /^0\d ·/.test(t)),
    workspace: document.querySelector(".workspace")?.getBoundingClientRect().width || 0,
  }));
  check("the hero is the project, not the pitch", hero.hasBaseline && hero.title === "4423 Noble" && /plan set v2/.test(hero.eyebrow), JSON.stringify([hero.eyebrow, hero.title]));
  check("and says the state and what was read in one line", /^Analysis complete · Review required · 4 scheduled items read · 2 questions block activation$/.test(hero.copy), hero.copy);
  check("the four-line contract steps aside; the card shows no percentage", !hero.contractShown && !hero.valueShown, JSON.stringify({ contract: hero.contractShown, value: hero.valueShown }));
  check("the section eyebrows say what a person calls them", hero.eyebrows.includes("01 · Plan set") && hero.eyebrows.includes("02 · AI reading") && hero.eyebrows.includes("03 · Result for review"), JSON.stringify(hero.eyebrows));
  check("a wide screen gets a wide workspace", hero.workspace >= 1500, String(hero.workspace));
  check("nothing threw", errors.length === 0, errors[0] || "");
  await context.close();
}

console.log("\n── approved, and empty ──");
{
  const w = scheduleOnly();
  w.document_baselines[0].state = "approved";
  w.document_baselines[0].approved_at = "2026-09-06T20:00:00Z";
  const { context, page } = await open(w);
  await page.evaluate(() => document.getElementById("summary-full")?.click());
  await page.waitForTimeout(300);
  const approved = await page.evaluate(() => ({
    guidanceHidden: document.getElementById("approval-guidance")?.hidden,
    status: document.getElementById("result-status")?.textContent || "",
    copy: document.getElementById("hero-copy")?.textContent || "",
  }));
  check("once the roadmap is active the approval guidance is gone and the status says so", approved.guidanceHidden === true && /Roadmap active/.test(approved.status) && /^Roadmap active · 4 scheduled items read$/.test(approved.copy), JSON.stringify(approved));
  await context.close();

  const empty = deckTakeoffRows();
  empty.document_baselines[0].analysis = { project_summary: "An architectural set with no schedules and no framing." };
  const shell = await open(empty);
  const none = await shell.page.evaluate(() => ({
    summaryHidden: document.getElementById("owner-summary")?.hidden,
    hasBaseline: document.body.classList.contains("has-baseline"),
    title: document.getElementById("hero-title")?.textContent || "",
  }));
  check("a reading with nothing to show still has no summary, and the hero is still the project", none.summaryHidden === true && none.hasBaseline && none.title !== "Plans first. Evidence with a purpose.", JSON.stringify(none));
  await shell.context.close();

  const fresh = deckTakeoffRows();
  fresh.document_baselines = [];
  const first = await open(fresh);
  const pitch = await first.page.evaluate(() => ({ title: document.getElementById("hero-title")?.textContent || "", contractShown: getComputedStyle(document.querySelector(".contract")).display !== "none" }));
  check("a project with no reading keeps the pitch and the contract", pitch.title === "Plans first. Evidence with a purpose." && pitch.contractShown, JSON.stringify(pitch));
  await first.context.close();
}

await browser.close();
server.close();
console.log(bad ? `\n${bad} FAILURES` : "\nALL OK");
process.exit(bad ? 1 : 0);
