/* The wood takeoff draft, on the screen where a person signs it.
 *
 * Three parties, one screen: the AI read the printed dimensions, the fixed
 * calculator counted the lumber and shows its arithmetic, and the person
 * approves. What the test guards is the honesty of the seams:
 *
 *   - the numbers on screen are the calculator's, worked by hand in
 *     takeoff.mjs — not something the render re-derived its own way;
 *   - a wall the drawings did not dimension is a named gap, not a smaller
 *     house;
 *   - the approval sends the draft verbatim, and asks first when gaps are
 *     open;
 *   - a set with no dimensions says why and what would change it.
 */
import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";
import http from "http"; import fs from "fs"; import path from "path";
import { takeoffRows, deckTakeoffRows } from "./seed.mjs";

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

let bad = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? `\n         ${detail}` : ""}`);
  if (!ok) bad++;
};

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox", "--no-proxy-server", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});

async function openPlans(world) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
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

console.log("\n── the owner opens a finished takeoff — zero technical input ──");
/* The product rule under test: the owner uploads plans and LOOKS at a result.
   No count fields, no "write in what you can read", no approval gate before
   viewing or downloading. RFIs are raised by the product itself. */
{
  const { context, page, errors } = await openPlans(takeoffRows());
  check("the plans screen opens", errors.length === 0, errors[0] || "");

  const view = await page.evaluate(() => ({
    shown: document.querySelector("#takeoff-section")?.hidden === false,
    heading: document.querySelector("#takeoff-section .section-heading p")?.textContent || "",
    pill: document.querySelector("#takeoff-state")?.textContent.trim(),
    intro: document.querySelector("#takeoff-intro")?.textContent || "",
    rows: [...document.querySelectorAll("#takeoff-table tbody tr")].map((row) => row.innerText.replace(/\s+/g, " ").trim()),
    gaps: document.querySelector("#takeoff-gaps")?.innerText.replace(/\s+/g, " ") || "",
    inputsInOwnerView: document.querySelectorAll("#takeoff-gaps input, #takeoff-gaps textarea").length,
    requiredFields: document.querySelectorAll("#takeoff-section [required]").length,
    aiDownloadShown: document.querySelector("#download-ai-takeoff")?.hidden === false,
    verifiedDownloadShown: document.querySelector("#download-takeoff")?.hidden === false,
    note: document.querySelector("#takeoff-section .governance-note")?.textContent || "",
  }));
  check("the section is the AI Takeoff Review", view.shown && /AI Takeoff Review/.test(view.heading), view.heading);
  check("and wears the honest state", /read by ai · not confirmed/i.test(view.pill || ""), view.pill);
  check("the intro promises no manual measurement",
    /No manual plan measurement is required/.test(view.intro), view.intro.slice(0, 160));
  check("the owner view holds NO technical input fields",
    view.inputsInOwnerView === 0 && view.requiredFields === 0,
    `inputs=${view.inputsInOwnerView} required=${view.requiredFields}`);
  check("quantities render themselves, provenance on the line",
    view.rows.some((row) => /2x4 stud · 92 5\/8" precut/.test(row) && /Derived from printed dimensions/.test(row)),
    JSON.stringify(view.rows.slice(0, 2)));
  check("the undimensioned wall is an automatic RFI, not homework",
    /Wall B1 has no printed length/.test(view.gaps) && /OPEN_RFI/.test(view.gaps)
    && /Nothing above needs your measurement/.test(view.gaps), view.gaps.slice(0, 260));
  check("no 'write in what you can read' language survives anywhere",
    !/write in what you can read/i.test(await page.content()), "");
  check("the AI workbook is offered with no signature",
    view.aiDownloadShown === true && view.verifiedDownloadShown === false, JSON.stringify(view));
  check("the governance note says what accepting is and is not",
    /working baseline/i.test(view.note) && /line-by-line expert review/i.test(view.note), view.note.slice(0, 200));

  console.log("\n── the AI workbook downloads without any approval ──");
  const download = await page.evaluate(async () => {
    let blob = null; let filename = ""; let clicked = false;
    URL.createObjectURL = (b) => { blob = b; return "blob:captured"; };
    HTMLAnchorElement.prototype.click = function () { clicked = true; filename = this.download; };
    document.querySelector("#download-ai-takeoff")?.click();
    await new Promise((r) => setTimeout(r, 150));
    const head = blob ? [...new Uint8Array((await blob.arrayBuffer()).slice(0, 2))] : [];
    const sheets = window.__aiTakeoffSheets();
    return { clicked, filename, head, sheets: sheets.map((sheet) => sheet.name), summary: sheets[0].rows, detail: sheets[1].rows };
  });
  check("it downloads as a real workbook, no signature asked",
    download.clicked === true && /^ai-takeoff-.+\.xlsx$/.test(download.filename) && download.head.join(",") === "80,75",
    download.filename);
  check("with the four AI sheets",
    JSON.stringify(download.sheets) === JSON.stringify(["AI Takeoff Summary", "Detailed Quantities & Basis", "Sources & Arithmetic", "RFIs & Holds"]),
    JSON.stringify(download.sheets));
  check("the summary counts RFIs and confirms nothing",
    download.summary.some((row) => row[0] === "Open RFIs raised automatically" && row[1] >= 1)
    && download.summary.some((row) => row[0] === "Human-confirmed lines" && row[1] === 0),
    JSON.stringify(download.summary.slice(5)));
  check("every detail row carries method and status columns",
    download.detail[0].join("|") === "Item|Qty|Unit|Method|Confidence|Category|Status|Sources|Unresolved issue"
    && download.detail.slice(1).every((row) => row[3] && row[6]),
    JSON.stringify(download.detail[0]));

  console.log("\n── accepting is a baseline, never a confirmation ──");
  const accepted = await page.evaluate(async () => {
    let asked = "";
    window.confirm = (message) => { asked = message; return true; };
    document.querySelector("#approve-takeoff")?.click();
    await new Promise((r) => setTimeout(r, 500));
    return {
      asked,
      acceptCall: window.__rpcCalls.find((c) => c.name === "approve_material_takeoff") || null,
      reviewCalls: window.__rpcCalls.filter((c) => c.name === "review_takeoff_line").length,
    };
  });
  check("the dialog names OWNER_ACCEPTED_BASELINE and disclaims technical confirmation",
    /OWNER_ACCEPTED_BASELINE/.test(accepted.asked) && /does not confirm any technical value/.test(accepted.asked),
    accepted.asked.slice(0, 220));
  check("acceptance sends no answers and triggers no line review",
    Array.isArray(accepted.acceptCall?.args?.p_answers) && accepted.acceptCall.args.p_answers.length === 0
    && accepted.reviewCalls === 0,
    JSON.stringify({ answers: accepted.acceptCall?.args?.p_answers, reviews: accepted.reviewCalls }));

  console.log("\n── only the expert line action creates HUMAN_CONFIRMED ──");
  const reviewed = await page.evaluate(async () => {
    const line = document.querySelector("#takeoff-expert-lines .expert-line");
    line?.querySelector('button[data-verdict="confirmed"]')?.click();
    await new Promise((r) => setTimeout(r, 500));
    const call = window.__rpcCalls.find((c) => c.name === "review_takeoff_line");
    return { key: line?.dataset.lineKey || "", args: call?.args || null };
  });
  check("the expert Confirm goes line-by-line through its own RPC",
    reviewed.args?.p_verdict === "confirmed" && reviewed.args?.p_line_key === reviewed.key
    && Boolean(reviewed.args?.p_value),
    JSON.stringify(reviewed.args));
  check("nothing threw", errors.length === 0, errors.join(" | "));
  await context.close();
}

console.log("\n── the deck reads itself: proposals, HOLD and the verified gate ──");
/* Sarita as regression: the pipeline output renders with zero input — counts
   as AI_PLAN_COUNT proposals, the plywood conflict on automatic HOLD, and
   the Human-Verified workbook gated on a real line review. */
{
  const world = deckTakeoffRows();
  const deckRecord = world.document_baselines[0].analysis.framing_decks[0];
  deckRecord.sheathing = 'DECK DIAPHRAGM TO BE 19/32" PLYWOOD';
  deckRecord.decking = "WD-1: 2\" x 6\" x 6' DECKING";
  deckRecord.joist_spacing = '@6" O.C.';
  deckRecord.beams = [
    { mark: "DECK BM", description: "6x12 #1 @36\" O.C.", count_drawn: 0, count_proposed: 27, count_confidence: "medium", count_note: "counted on S-2.0 framing plan" },
  ];
  deckRecord.columns = [];
  deckRecord.piles = { description: '18" CONC. PILE w/ RE-BARS', count_drawn: 0, count_proposed: 14, count_confidence: "high", count_note: "counted on S-2.0 foundation plan" };
  world.takeoff_line_reviews = [{
    id: "rev-1", baseline_id: "bl-1", kind: "wood_framing", state: "active",
    line_key: "2x6x6' deck boards — net pieces (no purchase allowance)",
    verdict: "confirmed", value: "547 pieces", reviewer_role: "reviewer", reviewed_at: "2026-08-26T05:00:00Z",
  }];
  const { context, page, errors } = await openPlans(world);
  const deck = await page.evaluate(() => ({
    pill: document.querySelector("#takeoff-state")?.textContent.trim(),
    rows: [...document.querySelectorAll("#takeoff-table tbody tr")].map((row) => row.innerText.replace(/\s+/g, " ").trim()),
    inputs: document.querySelectorAll("#takeoff-gaps input, #takeoff-gaps textarea").length,
    verifiedShown: document.querySelector("#download-takeoff")?.hidden === false,
    verified: window.__verifiedSheets(),
  }));
  check("proposals render themselves with confidence — no owner counting",
    deck.rows.some((row) => /27 × beam DECK BM/.test(row) && /medium confidence/.test(row))
    && deck.rows.some((row) => /14 × pile/.test(row) && /high confidence/.test(row))
    && deck.inputs === 0,
    JSON.stringify(deck.rows.filter((row) => /×/.test(row))));
  check("the plywood conflict is an automatic HOLD on the row",
    deck.rows.some((row) => /sheathing/.test(row) && /HOLD/.test(row) && /engineer to confirm/.test(row)),
    JSON.stringify(deck.rows.filter((row) => /sheathing/.test(row))));
  check("a real line review shows as human-confirmed and opens the verified download",
    /1 line human-confirmed/i.test(deck.pill || "") && deck.verifiedShown === true, deck.pill);
  const orderSheet = deck.verified[0];
  const orderBody = orderSheet.rows.slice(5);
  check("the Human-Verified Order carries ONLY the reviewed line",
    orderBody.length === 1 && orderBody[0][0] === "2x6x6' deck boards — net pieces (no purchase allowance)"
    && orderBody[0][2] === "HUMAN_CONFIRMED" && orderBody[0][3] === "reviewer",
    JSON.stringify(orderBody));
  check("AI-only rows sit on the not-confirmed sheet, holds never on the order",
    deck.verified[1].rows.some((row) => /deck boards.*structure and walking surface/.test(String(row[0])))
    && !orderSheet.rows.some((row) => /sheathing/.test(String(row[0]))),
    JSON.stringify(deck.verified[1].rows.slice(1, 3)));
  check("nothing threw on the deck set", errors.length === 0, errors[0] || "");

  await page.screenshot({ path: "studio/tests/fixtures/ai-takeoff-review.png", clip: undefined, fullPage: false }).catch(() => {});
  const section = await page.$("#takeoff-section");
  if (section) await section.screenshot({ path: "studio/tests/fixtures/ai-takeoff-review.png" }).catch(() => {});
  await context.close();
}

console.log("\n── a plan set that printed no dimensions ──");
{
  const world = takeoffRows();
  world.document_baselines[0].analysis = {};
  const { context, page, errors } = await openPlans(world);
  const empty = await page.evaluate(() => ({
    shown: document.querySelector("#takeoff-section")?.hidden === false,
    emptyShown: document.querySelector("#takeoff-empty")?.hidden === false,
    text: document.querySelector("#takeoff-empty")?.innerText.replace(/\s+/g, " ") || "",
    approveHidden: document.querySelector("#approve-takeoff")?.hidden,
  }));
  check("the section still says where you are", empty.shown === true);
  check("the empty state says what happened and what would change it",
    empty.emptyShown === true && /re-analysing/i.test(empty.text), empty.text.slice(0, 180));
  check("and nothing is offered for signature", empty.approveHidden === true);
  check("nothing threw on the empty set", errors.length === 0, errors[0] || "");
  await context.close();
}

/* ── a corrected line keeps what it corrected ──────────────────────────────
   The product's rule is that an AI reading is never presented as fact. Its
   mirror is easy to lose: once a person overrules a reading, the screen must
   not quietly bury the fact that the machine had been wrong. An auditor
   reading the row has to be able to see both numbers. */
{
  const world = deckTakeoffRows();
  world.takeoff_line_reviews = [{
    id: "rev-c", baseline_id: "bl-1", kind: "wood_framing", state: "active",
    line_key: "column COL.2: 8x8 #1",
    verdict: "corrected", value: "9 drawn on plan", reviewer_role: "engineer",
    reviewed_at: "2026-08-26T05:00:00Z",
  }];
  const { context, page, errors } = await openPlans(world);
  const shown = await page.evaluate(() => ({
    rows: [...document.querySelectorAll("#takeoff-table tbody tr")].map((row) => row.innerText.replace(/\s+/g, " ").trim()),
  }));
  const corrected = shown.rows.filter((row) => /COL\.2/.test(row));
  check("a corrected line shows the confirmed number and the reading it replaced",
    corrected.some((row) => /9 drawn on plan/.test(row) && /AI read 12 drawn on plan/.test(row) && /corrected by engineer/.test(row)),
    JSON.stringify(corrected));
  check("and every untouched line stays undecorated",
    !shown.rows.some((row) => !/COL\.2/.test(row) && /AI read/.test(row)),
    JSON.stringify(shown.rows.filter((row) => /AI read/.test(row))));
  check("nothing threw while showing the correction", errors.length === 0, errors[0] || "");
  await context.close();
}

await browser.close(); server.close();
console.log(bad ? `\n${bad} FAILURES` : "\nALL OK");
process.exit(bad ? 1 : 0);
