/* The Project Intelligence Core, seen from the browser.
 *
 * Two channels, one project database. What the test guards:
 *   - sources route themselves — nobody picks an AI agent;
 *   - the Owner Summary leads with reality-vs-documents discrepancies,
 *     conflicts first, and stays compact;
 *   - the Visual Evidence view is the same project seen from the reality
 *     side: rooms, coverage, and requirement-vs-evidence verdicts, with the
 *     invoice-is-not-installation doctrine printed where the owner reads it;
 *   - switching channels never creates a second project or asks for input.
 */
import { createRequire } from "module";
import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";
import http from "http"; import fs from "fs"; import path from "path";
import { deckTakeoffRows } from "./seed.mjs";

const require = createRequire(import.meta.url);

let bad = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? `\n         ${detail}` : ""}`);
  if (!ok) bad++;
};

console.log("── sources route themselves ──");
{
  const { routeSource } = require("../intelligence-routing.js");
  check("a structural plan goes to technical intelligence",
    routeSource({ filename: "S-2.0.pdf", mime: "application/pdf", document_type: "structural" }).channel === "technical");
  check("a 360 capture goes to the visual channel and its GPU worker",
    JSON.stringify([routeSource({ filename: "room.insv" }).channel, routeSource({ filename: "room.insv" }).worker]) === '["visual","gpu-360"]');
  check("a photo goes to the evidence pipeline",
    routeSource({ filename: "IMG_1.jpg", mime: "image/jpeg" }).channel === "visual");
  check("an invoice goes to the document-evidence worker, not to plan analysis",
    routeSource({ filename: "supplier-invoice-4471.pdf", mime: "application/pdf" }).worker === "document-evidence");
  check("an undeclared PDF is classified page by page",
    routeSource({ filename: "mixed-set.pdf", mime: "application/pdf" }).worker === "per-page-classification");
}

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

console.log("\n── one project, two channels ──");
{
  const world = deckTakeoffRows();
  world.spaces = [
    { id: "room-1", organization_id: world.document_baselines[0].organization_id, property_id: "prop-1", name: "Deck — west half" },
    { id: "room-2", organization_id: world.document_baselines[0].organization_id, property_id: "prop-1", name: "Deck — east half" },
  ];
  world.evidence_items = [
    { id: "ev-1", property_id: "prop-1", space_id: "room-1", media_type: "360 capture", deleted_at: null },
    { id: "ev-2", property_id: "prop-1", space_id: "room-1", media_type: "photo", deleted_at: null },
  ];
  world.project_reconciliations = [
    { property_id: "prop-1", state: "active", component_key: "P1",
      required_quantity: 14, delivered_quantity: 14, evidenced_quantity: 12, coverage: "partial",
      verdict: "PARTIALLY_SUPPORTED",
      narrative: "14 required · 14 documented as delivered · 12 visually evidenced as installed · 2 installation records not yet evidenced" },
    { property_id: "prop-1", state: "active", component_key: "COL.1",
      required_quantity: 6, delivered_quantity: null, evidenced_quantity: 4, coverage: "full",
      verdict: "CONFLICTING", narrative: "6 required · 4 visually evidenced as installed · 2 missing under full capture coverage — conflict" },
    { property_id: "prop-1", state: "active", component_key: "2x6 deck boards",
      required_quantity: 3280, delivered_quantity: null, evidenced_quantity: 3280, coverage: "partial",
      verdict: "SUPPORTED", narrative: "3280 required · 3280 visually evidenced as installed." },
  ];

  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route("**://*/**", (r) => (r.request().url().startsWith(base) ? r.continue() : r.abort()));
  await context.addInitScript(`window.__seed = ${JSON.stringify({ rows: world })};`);
  await context.addInitScript({ path: "studio/tests/fake-supabase.js" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  await page.goto(`${base}/studio/plans/?property=prop-1`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1300);

  const summary = await page.evaluate(() => ({
    issues: [...document.querySelectorAll("#summary-issues .summary-issue")].map((issue) => issue.innerText.replace(/\s+/g, " ")),
    issueCount: document.querySelectorAll("#summary-issues .summary-issue").length,
  }));
  check("the summary leads with the reconciliation conflict",
    summary.issues.length > 0 && /COL\.1/.test(summary.issues[0]) && /conflict/i.test(summary.issues[0]),
    JSON.stringify(summary.issues[0] || ""));
  check("the pile shortfall reads as not-yet-evidenced, never missing",
    summary.issues.some((issue) => /P1/.test(issue) && /not yet evidenced/.test(issue) && !/missing/.test(issue)),
    JSON.stringify(summary.issues));
  check("and the summary stays compact", summary.issueCount <= 3, String(summary.issueCount));

  const visual = await page.evaluate(() => {
    document.querySelector("#summary-visual")?.click();
    return {
      visualShown: document.querySelector("#visual-panel")?.hidden === false,
      technicalHidden: getComputedStyle(document.querySelector("#takeoff-section")).display === "none",
      rooms: [...document.querySelectorAll("#visual-rooms tbody tr")].map((row) => row.innerText.replace(/\s+/g, " ")),
      verdicts: [...document.querySelectorAll("#visual-recon .summary-chip")].map((chip) => chip.textContent),
      doctrine: document.querySelector("#visual-recon-note")?.textContent || "",
      inputs: document.querySelectorAll("#visual-panel input, #visual-panel textarea").length,
    };
  });
  check("Visual Evidence is a view of the same project, not a second one",
    visual.visualShown && visual.technicalHidden, JSON.stringify(visual));
  check("rooms show their evidence and their missing 360 out loud",
    visual.rooms.some((row) => /west half/.test(row) && /2 files/.test(row) && /✓/.test(row))
    && visual.rooms.some((row) => /east half/.test(row) && /0 files/.test(row) && /none/i.test(row)),
    JSON.stringify(visual.rooms));
  check("verdicts render as chips, supported through conflicting",
    visual.verdicts.includes("SUPPORTED") && visual.verdicts.includes("CONFLICTING") && visual.verdicts.includes("PARTIALLY_SUPPORTED"),
    JSON.stringify(visual.verdicts));
  check("the doctrine is printed where the owner reads it",
    /Absence of evidence is not evidence of absence/.test(visual.doctrine) && /invoice is never proof of installation/.test(visual.doctrine),
    visual.doctrine.slice(0, 120));
  check("and the visual view asks for nothing", visual.inputs === 0, String(visual.inputs));

  const back = await page.evaluate(() => {
    document.querySelector("#nav-technical")?.click();
    const technicalVisible = getComputedStyle(document.querySelector("#takeoff-section")).display !== "none";
    const visualHidden = document.querySelector("#visual-panel")?.hidden === true;
    document.querySelector("#nav-summary")?.click();
    return { technicalVisible, visualHidden, summaryBack: document.body.classList.contains("summary-mode") };
  });
  check("Technical Intelligence switches back and the nav returns to the summary",
    back.technicalVisible && back.visualHidden && back.summaryBack, JSON.stringify(back));

  const section = await page.$("#visual-panel");
  await page.evaluate(() => document.querySelector("#summary-visual")?.click());
  if (section) await section.screenshot({ path: "studio/tests/fixtures/visual-evidence.png" }).catch(() => {});
  check("nothing threw", errors.length === 0, errors.join(" | "));
  await context.close();
}

await browser.close(); server.close();
console.log(bad ? `\n${bad} FAILURES` : "\nALL OK");
process.exit(bad ? 1 : 0);
