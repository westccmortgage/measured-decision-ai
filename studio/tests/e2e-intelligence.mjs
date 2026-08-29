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
import { deckTakeoffRows, planDocument } from "./seed.mjs";

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
    { id: "ev-3", property_id: "prop-1", space_id: "room-2", media_type: "photo", deleted_at: null },
  ];
  /* The west half has been read by the AI; the east half's capture has not. */
  world.project_observations = [
    { property_id: "prop-1", space_id: "room-1", kind: "installed_seen", method: "AI_VISION", state: "active" },
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

  /* A mixed close-out set: two plan pages and an invoice page in one PDF,
     already read by the classifier. Its provenance line must say so — and
     the chain from classify to the page-scoped document reader must run
     exactly as production runs it. */
  world.project_documents = [...(world.project_documents || []), planDocument({
    id: "doc-mixed", original_filename: "closeout-set.pdf", document_type: "other",
    page_classification: {
      contract: "test", classified_at: "2026-08-26T12:00:00Z", summary: "mixed close-out set",
      pages: [
        { page_number: 1, kind: "technical_drawing", note: "S-2.0" },
        { page_number: 2, kind: "technical_drawing", note: "S-2.1" },
        { page_number: 3, kind: "invoice", note: "ABC Lumber" },
      ],
    },
  })];
  const workerAnswers = {
    "document-classify": {
      job_id: "job-classify-1", document_type: "other",
      pages: [
        { page_number: 1, kind: "technical_drawing", note: "S-2.0" },
        { page_number: 2, kind: "technical_drawing", note: "S-2.1" },
        { page_number: 3, kind: "invoice", note: "ABC Lumber" },
      ],
      routes: [
        { channel: "technical", worker: "plan-analyze", pages: [1, 2] },
        { channel: "documents", worker: "document-evidence", pages: [3] },
      ],
      unrouted: [],
      note: "Pages read by AI · not confirmed.",
    },
    "document-evidence": { job_id: "job-read-1", lines_recorded: 2, unreadable: 0, reconciled: true, note: "" },
  };

  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route("**://*/**", (r) => (r.request().url().startsWith(base) ? r.continue() : r.abort()));
  await context.addInitScript(`window.__seed = ${JSON.stringify({ rows: world, functions: workerAnswers })};`);
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
      reconHead: document.querySelector("#visual-recon thead")?.innerText.replace(/\s+/g, " ").trim() || "",
      reconRows: [...document.querySelectorAll("#visual-recon tbody tr")].map((row) =>
        [...row.querySelectorAll("td")].map((cell) => cell.innerText.replace(/\s+/g, " ").trim())),
      doctrine: document.querySelector("#visual-recon-note")?.textContent || "",
      inputs: document.querySelectorAll("#visual-panel input, #visual-panel textarea").length,
      unread: document.querySelector("#visual-unread")?.innerText || "",
      unreadLink: document.querySelector("#visual-unread a")?.getAttribute("href") || "",
      summaryUnread: document.querySelector("#summary-unread")?.innerText || "",
    };
  });
  check("Visual Evidence is a view of the same project, not a second one",
    visual.visualShown && visual.technicalHidden, JSON.stringify(visual));
  check("rooms show their evidence and their missing 360 out loud",
    visual.rooms.some((row) => /west half/.test(row) && /2 files/.test(row) && /✓/.test(row))
    && visual.rooms.some((row) => /east half/.test(row) && /1 file\b/.test(row) && /none/i.test(row)),
    JSON.stringify(visual.rooms));
  check("each room says whether the AI has read it",
    visual.rooms.some((row) => /west half/.test(row) && !/not read/i.test(row))
    && visual.rooms.some((row) => /east half/.test(row) && /not read/i.test(row)),
    JSON.stringify(visual.rooms));
  check("unread captures point at their door, carrying the project and the reading stage",
    /1 room holds captures nobody has read yet/.test(visual.unread)
    && visual.unreadLink === "../?property=prop-1&stage=read",
    JSON.stringify({ unread: visual.unread, link: visual.unreadLink }));
  check("and the Owner Summary names it as the next action",
    /1 room holds captures the AI has not read yet/.test(visual.summaryUnread)
    && /read them in Studio/.test(visual.summaryUnread),
    visual.summaryUnread);
  check("verdicts render as chips, supported through conflicting",
    visual.verdicts.includes("SUPPORTED") && visual.verdicts.includes("CONFLICTING") && visual.verdicts.includes("PARTIALLY_SUPPORTED"),
    JSON.stringify(visual.verdicts));
  /* The comparison is the product's central promise, and it is numbers:
     what the plans require, what paperwork documents as delivered, what
     capture shows installed — three columns, not a caption. */
  check("the comparison table names its three quantities",
    /required/i.test(visual.reconHead) && /delivered/i.test(visual.reconHead) && /installed/i.test(visual.reconHead),
    visual.reconHead);
  const pileRow = visual.reconRows.find((row) => /^P1\b/.test(row[0]));
  check("the pile row carries 14 required · 14 delivered · 12 installed as numbers",
    pileRow?.[1] === "14" && pileRow?.[2] === "14" && pileRow?.[3] === "12",
    JSON.stringify(pileRow));
  const columnRow = visual.reconRows.find((row) => /^COL\.1\b/.test(row[0]));
  check("no delivery record shows as an honest dash, never a zero",
    columnRow?.[1] === "6" && columnRow?.[2] === "—" && columnRow?.[3] === "4",
    JSON.stringify(columnRow));
  check("the doctrine is printed where the owner reads it",
    /Absence of evidence is not evidence of absence/.test(visual.doctrine) && /invoice is never proof of installation/.test(visual.doctrine),
    visual.doctrine.slice(0, 120));
  check("and the visual view asks for nothing", visual.inputs === 0, String(visual.inputs));

  const filled = await page.evaluate(async () => {
    const options = [...document.querySelectorAll("#document-type option")].map((option) => option.value);
    document.querySelector("#visual-refresh")?.click();
    await new Promise((r) => setTimeout(r, 500));
    return {
      options,
      reconcileCall: window.__rpcCalls.find((c) => c.name === "reconcile_project") || null,
    };
  });
  check("delivery paperwork is a declared upload discipline",
    filled.options.includes("invoice") && filled.options.includes("delivery_ticket") && filled.options.includes("receipt"),
    JSON.stringify(filled.options));
  check("Refresh reconciliation runs the reconcile RPC — a view action, not an input",
    filled.reconcileCall?.args?.p_property_id === "prop-1", JSON.stringify(filled.reconcileCall));

  const back = await page.evaluate(() => {
    document.querySelector("#nav-technical")?.click();
    const technicalVisible = getComputedStyle(document.querySelector("#takeoff-section")).display !== "none";
    const visualHidden = document.querySelector("#visual-panel")?.hidden === true;
    document.querySelector("#nav-summary")?.click();
    return { technicalVisible, visualHidden, summaryBack: document.body.classList.contains("summary-mode") };
  });
  check("Technical Intelligence switches back and the nav returns to the summary",
    back.technicalVisible && back.visualHidden && back.summaryBack, JSON.stringify(back));

  const classified = await page.evaluate(async () => {
    document.querySelector("#nav-technical")?.click();
    const row = [...document.querySelectorAll(".document-row")].find((item) => /closeout-set/.test(item.innerText));
    const provenance = row?.querySelector(".document-classified")?.textContent || "";
    await window.__classifyUploadedDocument("doc-mixed");
    await new Promise((resolve) => setTimeout(resolve, 400));
    return {
      provenance,
      calls: window.__rpcCalls.filter((call) => ["document-classify", "document-evidence"].includes(call.name)),
    };
  });
  check("a classified PDF wears its AI reading as provenance, never as fact",
    /Pages read by AI · not confirmed/.test(classified.provenance)
    && /2 plan pages/.test(classified.provenance) && /1 invoice page/.test(classified.provenance),
    classified.provenance);
  check("the mixed file chains itself: classify, then the reader receives ONLY the paperwork pages",
    classified.calls.some((call) => call.name === "document-classify" && call.args?.document_id === "doc-mixed")
    && classified.calls.some((call) => call.name === "document-evidence"
      && call.args?.document_id === "doc-mixed" && JSON.stringify(call.args?.pages) === "[3]"),
    JSON.stringify(classified.calls));

  /* A site photo at the plans door: the right file at the wrong door gets
     the other door, never an instruction to become a PDF. */
  const wrongDoor = await page.evaluate(async () => {
    const input = document.querySelector("#plan-files");
    const transfer = new DataTransfer();
    transfer.items.add(new File(["fake bytes"], "IMG_4712.jpeg", { type: "image/jpeg" }));
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    document.querySelector("#confirm-upload")?.click();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const message = document.querySelector("#action-message");
    return {
      text: message?.textContent || "",
      link: message?.querySelector("a")?.getAttribute("href") || "",
    };
  });
  check("a site photo at the plans door is pointed at Studio, not told to become a PDF",
    /photo or video/.test(wrongDoor.text) && !/Convert drawings/.test(wrongDoor.text)
    && /Add it in Studio/.test(wrongDoor.text) && wrongDoor.link === "../?property=prop-1",
    JSON.stringify(wrongDoor));

  /* The comparison door promises the comparison: arriving with ?view=visual
     opens the visual channel itself, no further navigation. */
  const doorPage = await context.newPage();
  await doorPage.goto(`${base}/studio/plans/?property=prop-1&view=visual`, { waitUntil: "networkidle" });
  await doorPage.waitForTimeout(1300);
  const door = await doorPage.evaluate(() => ({
    visualShown: document.querySelector("#visual-panel")?.hidden === false,
    reconRows: document.querySelectorAll("#visual-recon tbody tr").length,
  }));
  check("?view=visual lands on the visual channel directly",
    door.visualShown && door.reconRows > 0, JSON.stringify(door));
  await doorPage.close();

  /* On a phone, the five-column comparison scrolls inside its own container —
     the page itself never scrolls sideways. */
  const phone = await context.newPage();
  await phone.setViewportSize({ width: 430, height: 930 });
  await phone.goto(`${base}/studio/plans/?property=prop-1`, { waitUntil: "networkidle" });
  await phone.waitForTimeout(1300);
  const mobile = await phone.evaluate(() => {
    document.querySelector("#summary-visual")?.click();
    const scroller = document.querySelector(".table-scroll");
    return {
      bodyOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      tableScrolls: scroller ? scroller.scrollWidth - scroller.clientWidth >= 0 : false,
    };
  });
  check("the visual view fits a 430px screen — the comparison scrolls in its own container",
    mobile.bodyOverflow <= 1 && mobile.tableScrolls, JSON.stringify(mobile));
  await phone.close();

  /* The chain runs itself: a baseline whose requirements were never
     distilled (this world seeds no project_requirements) triggers the
     distillation and a reconciliation on open — the owner does nothing. */
  const chain = await page.evaluate(() => ({
    extract: window.__rpcCalls.find((call) => call.name === "extract_project_requirements") || null,
    reconcile: window.__rpcCalls.some((call) => call.name === "reconcile_project"),
  }));
  check("an undistilled baseline distils itself on open, then reconciles",
    Boolean(chain.extract?.args?.p_baseline_id) && chain.reconcile,
    JSON.stringify(chain.extract));

  const section = await page.$("#visual-panel");
  await page.evaluate(() => document.querySelector("#summary-visual")?.click());
  if (section) await section.screenshot({ path: "studio/tests/fixtures/visual-evidence.png" }).catch(() => {});
  check("nothing threw", errors.length === 0, errors.join(" | "));
  await context.close();
}

console.log("\n── a distilled baseline is not distilled twice ──");
{
  const world = deckTakeoffRows();
  world.project_requirements = [{
    id: "req-1", baseline_id: world.document_baselines[0].id, property_id: "prop-1",
    component_key: "P1", quantity: 14, method: "AI_PLAN_COUNT", state: "active",
  }];
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route("**://*/**", (r) => (r.request().url().startsWith(base) ? r.continue() : r.abort()));
  await context.addInitScript(`window.__seed = ${JSON.stringify({ rows: world })};`);
  await context.addInitScript({ path: "studio/tests/fake-supabase.js" });
  const page = await context.newPage();
  await page.goto(`${base}/studio/plans/?property=prop-1`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1300);
  const calls = await page.evaluate(() =>
    window.__rpcCalls.filter((call) => call.name === "extract_project_requirements").length);
  check("active requirements already in the record — the chain stays quiet", calls === 0, String(calls));
  await context.close();
}

console.log("\n── an architectural set: the reality channel opens without a takeoff ──");
/* The exact arrangement found on the real Hutton project: an approved
   baseline whose analysis names no framing members, so no takeoff can be
   computed — and the whole Visual Evidence channel used to hide with it. */
{
  const world = deckTakeoffRows();
  world.document_baselines[0].analysis = {
    project_summary: "Single family remodel — architectural set, no framing schedules.",
  };
  world.spaces = [
    { id: "room-1", organization_id: world.document_baselines[0].organization_id, property_id: "prop-1", name: "Living Room 103" },
  ];
  world.evidence_items = [
    { id: "ev-1", property_id: "prop-1", space_id: "room-1", media_type: "360 capture", deleted_at: null },
  ];
  world.project_observations = [];
  world.project_reconciliations = [];

  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route("**://*/**", (r) => (r.request().url().startsWith(base) ? r.continue() : r.abort()));
  await context.addInitScript(`window.__seed = ${JSON.stringify({ rows: world })};`);
  await context.addInitScript({ path: "studio/tests/fake-supabase.js" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  await page.goto(`${base}/studio/plans/?property=prop-1&view=visual`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1300);

  const channel = await page.evaluate(() => ({
    summaryHidden: document.querySelector("#owner-summary")?.hidden === true,
    navShown: document.querySelector("#channel-nav")?.hidden === false,
    visualShown: document.querySelector("#visual-panel")?.hidden === false,
    rooms: [...document.querySelectorAll("#visual-rooms tbody tr")].map((row) => row.innerText.replace(/\s+/g, " ")),
    reconEmpty: document.querySelector("#visual-recon tbody")?.innerText.replace(/\s+/g, " ") || "",
    extractCalls: window.__rpcCalls.filter((call) => call.name === "extract_project_requirements").length,
  }));
  check("with nothing distillable the chain never starts — no job spam on every open",
    channel.extractCalls === 0, String(channel.extractCalls));
  check("the takeoff-shaped summary stays away — there is nothing to summarize",
    channel.summaryHidden, JSON.stringify(channel));
  check("but the channels are reachable and ?view=visual lands on the reality side",
    channel.navShown && channel.visualShown, JSON.stringify(channel));
  check("the rooms and their captures render",
    channel.rooms.some((row) => /Living Room 103/.test(row) && /1 file/.test(row)),
    JSON.stringify(channel.rooms));
  check("the empty comparison says why it is empty, honestly",
    /nothing countable has been distilled from this plan set/.test(channel.reconEmpty),
    channel.reconEmpty);
  check("nothing threw", errors.length === 0, errors.join(" | "));
  await context.close();
}

console.log("\n── a fresh project accepts its plan set ──");
/* The regression that reached a person: an inner const shadowed the
   declared document type across the try block, and every plan save threw
   'Cannot access documentType before initialization' before the upload
   began. This drives the exact flow — pick a PDF, press Save — with the
   uploader stubbed, and demands the upload actually starts. */
{
  const world = deckTakeoffRows();
  world.project_documents = [];
  world.document_baselines = [];
  world.material_takeoffs = [];
  world.properties[0].workflow_state = "intake";
  world.properties[0].active_baseline_id = null;

  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route("**://*/**", (r) => (r.request().url().startsWith(base) ? r.continue() : r.abort()));
  await context.addInitScript(`window.__seed = ${JSON.stringify({ rows: world })};`);
  await context.addInitScript({ path: "studio/tests/fake-supabase.js" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  await page.goto(`${base}/studio/plans/?property=prop-1`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1300);

  const saved = await page.evaluate(async () => {
    const calls = [];
    window.MDAIObjectStorage = {
      upload: async (options) => {
        calls.push({ entityType: options.entityType, org: options.organizationId, property: options.propertyId });
        return { record: { id: "doc-new-1" } };
      },
    };
    const input = document.querySelector("#plan-files");
    const transfer = new DataTransfer();
    transfer.items.add(new File(["%PDF-1.4 fake"], "Main House RTI Set.pdf", { type: "application/pdf" }));
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    document.querySelector("#confirm-upload")?.click();
    await new Promise((resolve) => setTimeout(resolve, 800));
    return { calls, toast: document.querySelector(".toast")?.textContent || "" };
  });
  check("pressing Save actually starts the upload, with the project it was aimed at",
    saved.calls.length === 1 && saved.calls[0].entityType === "project_document"
    && saved.calls[0].org === "org-1" && saved.calls[0].property === "prop-1",
    JSON.stringify(saved.calls));
  check("and the save reports success, not an initialization error",
    /1 plan document saved/.test(saved.toast), saved.toast);
  check("nothing threw", errors.length === 0, errors.join(" | "));
  await context.close();
}

console.log("\n── the vocabulary grows: printed schedules distil into requirements ──");
/* An architectural set whose reader recorded component_schedules — doors,
   windows, fixtures from PRINTED schedules. The chain must treat that as
   distillable and run extract + reconcile on open, exactly as it does for
   framing members. */
{
  const world = deckTakeoffRows();
  world.document_baselines[0].analysis = {
    project_summary: "Single family remodel — architectural set with printed schedules.",
    component_schedules: [
      { mark: "D1", category: "door", description: "3'-0\" x 8'-0\" solid core, paint grade", unit: "count",
        count_scheduled: 8, count_drawn: 8, count_proposed: 8, count_confidence: "high",
        count_note: "counted on A-6.0 door schedule and floor plans", source_refs: ["A-6.0"] },
      { mark: "W2", category: "window", description: "4'-0\" x 5'-0\" casement, dual glazed", unit: "count",
        count_scheduled: 6, count_drawn: 0, count_proposed: 6, count_confidence: "medium",
        count_note: "schedule QTY column; plan tags partially covered", source_refs: ["A-6.1"] },
    ],
  };
  world.project_requirements = [];
  world.project_reconciliations = [
    { property_id: "prop-1", state: "active", component_key: "D1",
      required_quantity: 8, delivered_quantity: null, evidenced_quantity: 3, coverage: "partial",
      verdict: "PARTIALLY_SUPPORTED",
      narrative: "8 required · 3 visually evidenced as installed · 5 installation records not yet evidenced" },
  ];

  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route("**://*/**", (r) => (r.request().url().startsWith(base) ? r.continue() : r.abort()));
  await context.addInitScript(`window.__seed = ${JSON.stringify({ rows: world })};`);
  await context.addInitScript({ path: "studio/tests/fake-supabase.js" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  await page.goto(`${base}/studio/plans/?property=prop-1&view=visual`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1300);

  const grown = await page.evaluate(() => ({
    extract: window.__rpcCalls.find((call) => call.name === "extract_project_requirements") || null,
    reconcile: window.__rpcCalls.some((call) => call.name === "reconcile_project"),
    doorRow: [...document.querySelectorAll("#visual-recon tbody tr")]
      .map((row) => row.innerText.replace(/\s+/g, " ")).find((row) => /^D1/.test(row)) || "",
  }));
  check("printed schedules count as distillable — the chain runs on open",
    Boolean(grown.extract?.args?.p_baseline_id) && grown.reconcile, JSON.stringify(grown.extract));
  check("and the door requirement stands in the comparison",
    /D1/.test(grown.doorRow) && /8/.test(grown.doorRow), grown.doorRow);
  check("nothing threw", errors.length === 0, errors.join(" | "));
  await context.close();
}

await browser.close(); server.close();
console.log(bad ? `\n${bad} FAILURES` : "\nALL OK");
process.exit(bad ? 1 : 0);
