/* The owner summary — thirty seconds to the answer.
 *
 * The rule under test: once an analysis exists, the landing view is one
 * compact summary — a decision, at most five numbers, at most eight preview
 * rows, at most three issues, three actions — and every heavy section sits
 * one click away. Project size grows the drill-down, never this screen.
 * Nothing on it asks the owner for anything technical, and a reload lands
 * back on the summary.
 */
import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";
import http from "http"; import fs from "fs"; import path from "path";
import { takeoffRows, deckTakeoffRows } from "./seed.mjs";

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

let bad = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? `\n         ${detail}` : ""}`);
  if (!ok) bad++;
};

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox", "--no-proxy-server", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});

async function openPlans(world, viewport = { width: 1280, height: 900 }) {
  const context = await browser.newContext({ viewport });
  await context.route("**://*/**", (r) => (r.request().url().startsWith(base) ? r.continue() : r.abort()));
  await context.addInitScript(`window.__seed = ${JSON.stringify({ rows: world })};`);
  await context.addInitScript({ path: "studio/tests/fake-supabase.js" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  await page.goto(`${base}/studio/plans/?property=prop-1`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1300);
  return { context, page, errors };
}

function saritaWorld() {
  const world = deckTakeoffRows();
  const deck = world.document_baselines[0].analysis.framing_decks[0];
  deck.sheathing = 'DECK DIAPHRAGM TO BE 19/32" PLYWOOD';
  deck.decking = "WD-1: 2\" x 6\" x 6' DECKING";
  deck.joist_spacing = '@6" O.C.';
  deck.beams = [{ mark: "DECK BM", description: '6x12 #1 @36" O.C.', count_drawn: 0, count_proposed: 27, count_confidence: "medium", count_note: "counted on S-2.0" }];
  deck.columns = [];
  deck.piles = { description: '18" CONC. PILE w/ RE-BARS', count_drawn: 0, count_proposed: 14, count_confidence: "high", count_note: "counted on S-2.0" };
  return world;
}

console.log("── a small project: the whole answer on one screen ──");
{
  const { context, page, errors } = await openPlans(saritaWorld());
  const view = await page.evaluate(() => ({
    summaryShown: document.querySelector("#owner-summary")?.hidden === false,
    summaryMode: document.body.classList.contains("summary-mode"),
    title: document.querySelector("#summary-title")?.textContent || "",
    decision: document.querySelector("#summary-decision")?.textContent || "",
    why: document.querySelector("#summary-why")?.textContent || "",
    numberCount: document.querySelectorAll("#summary-numbers article").length,
    previewRows: document.querySelectorAll("#summary-table tbody tr").length,
    issueCount: document.querySelectorAll("#summary-issues .summary-issue").length,
    chips: [...document.querySelectorAll("#summary-table .summary-chip")].map((chip) => chip.textContent),
    heavyVisible: ["#takeoff-section", ".workflow-grid", ".roadmap-section"]
      .filter((selector) => { const el = document.querySelector(selector); return el && getComputedStyle(el).display !== "none"; }),
    inputs: document.querySelectorAll("#owner-summary input, #owner-summary textarea, #owner-summary [required]").length,
    summaryHeightScreens: document.querySelector("#owner-summary").getBoundingClientRect().height / 900,
  }));
  check("the summary is the landing view", view.summaryShown && view.summaryMode, JSON.stringify(view.heavyVisible));
  check("with a named decision and one short why",
    /Proceed with conditions/.test(view.decision) && view.why.length > 0 && view.why.length < 240,
    `${view.decision} · ${view.why}`);
  check("at most five numbers", view.numberCount > 0 && view.numberCount <= 5, String(view.numberCount));
  check("at most eight preview rows with compact statuses",
    view.previewRows > 0 && view.previewRows <= 8
    && view.chips.every((chip) => ["Ready", "Verify", "Hold", "RFI", "Confirmed"].includes(chip)),
    `${view.previewRows} rows · ${JSON.stringify([...new Set(view.chips)])}`);
  check("at most three issues, and the HOLD leads", view.issueCount > 0 && view.issueCount <= 3, String(view.issueCount));
  check("the heavy sections are hidden until asked for", view.heavyVisible.length === 0, JSON.stringify(view.heavyVisible));
  check("nothing on the summary asks the owner for anything", view.inputs === 0, String(view.inputs));
  check("the primary result fits about one viewport", view.summaryHeightScreens <= 1.4, view.summaryHeightScreens.toFixed(2));

  const drill = await page.evaluate(() => {
    document.querySelector("#summary-full")?.click();
    return {
      summaryMode: document.body.classList.contains("summary-mode"),
      takeoffVisible: getComputedStyle(document.querySelector("#takeoff-section")).display !== "none",
    };
  });
  check("View full analysis opens level 2 with everything intact",
    drill.summaryMode === false && drill.takeoffVisible === true, JSON.stringify(drill));

  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  const afterReload = await page.evaluate(() => document.body.classList.contains("summary-mode"));
  check("a reload lands back on the summary", afterReload === true);

  const shot = await page.$("#owner-summary");
  await page.evaluate(() => { document.querySelector("#summary-full")?.scrollIntoView(); window.scrollTo(0, 0); });
  if (shot) await shot.screenshot({ path: "studio/tests/fixtures/owner-summary.png" }).catch(() => {});
  check("nothing threw", errors.length === 0, errors.join(" | "));
  await context.close();
}

console.log("\n── a large project: same concise screen, deeper drill-down ──");
{
  const world = takeoffRows();
  /* Thirty dimensioned walls and ten undimensioned ones: a set that would
     have produced screens of cards. The summary must not grow with it. */
  world.document_baselines[0].analysis.framing_walls = [
    ...Array.from({ length: 30 }, (_, index) => ({
      label: `Wall W${index + 1}`, building: "Main", level: "L1", length: `${10 + (index % 6)}'`, height: "8'",
      stud_size: "2x4", stud_spacing_inches: 16, corners: 2, intersections: 0, openings: [], source_refs: ["A-201"],
    })),
    ...Array.from({ length: 10 }, (_, index) => ({
      label: `Wall U${index + 1}`, building: "Main", level: "L2", length: "", height: "8'",
      stud_size: "2x4", stud_spacing_inches: 16, corners: 0, intersections: 0, openings: [], source_refs: ["A-202"],
    })),
  ];
  const { context, page, errors } = await openPlans(world);
  const view = await page.evaluate(() => ({
    previewRows: document.querySelectorAll("#summary-table tbody tr").length,
    issueCount: document.querySelectorAll("#summary-issues .summary-issue").length,
    numberCount: document.querySelectorAll("#summary-numbers article").length,
    rfiNumber: [...document.querySelectorAll("#summary-numbers article")]
      .find((article) => /open RFIs/i.test(article.textContent))?.textContent || "",
  }));
  check("forty walls still produce at most eight preview rows", view.previewRows <= 8, String(view.previewRows));
  check("and at most three visible issues while the RFI count says the truth",
    view.issueCount <= 3 && /10/.test(view.rfiNumber), `${view.issueCount} issues · ${view.rfiNumber.trim()}`);
  check("and never more than five numbers", view.numberCount <= 5, String(view.numberCount));
  check("nothing threw on the large set", errors.length === 0, errors[0] || "");
  await context.close();
}

console.log("\n── no analysis yet: the summary stays out of the way ──");
{
  const world = takeoffRows();
  world.document_baselines[0].analysis = {};
  const { context, page, errors } = await openPlans(world);
  const view = await page.evaluate(() => ({
    summaryHidden: document.querySelector("#owner-summary")?.hidden === true,
    summaryMode: document.body.classList.contains("summary-mode"),
    uploadVisible: getComputedStyle(document.querySelector(".workflow-grid")).display !== "none",
  }));
  check("without a takeoff the full workspace is the view, upload reachable",
    view.summaryHidden && !view.summaryMode && view.uploadVisible, JSON.stringify(view));
  check("nothing threw on the empty set", errors.length === 0, errors[0] || "");
  await context.close();
}

await browser.close(); server.close();
console.log(bad ? `\n${bad} FAILURES` : "\nALL OK");
process.exit(bad ? 1 : 0);
