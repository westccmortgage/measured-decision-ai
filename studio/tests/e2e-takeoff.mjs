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
import { takeoffRows } from "./seed.mjs";

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

console.log("\n── a plan set with printed dimensions ──");
{
  const { context, page, errors } = await openPlans(takeoffRows());
  check("the plans screen opens", errors.length === 0, errors[0] || "");

  const view = await page.evaluate(() => {
    const section = document.querySelector("#takeoff-section");
    return {
      shown: section && !section.hidden,
      pill: document.querySelector("#takeoff-state")?.textContent.trim(),
      intro: document.querySelector("#takeoff-intro")?.textContent || "",
      rows: [...document.querySelectorAll("#takeoff-table tbody tr")].map((row) => row.innerText.replace(/\s+/g, " ").trim()),
      gaps: document.querySelector("#takeoff-gaps")?.innerText.replace(/\s+/g, " ") || "",
      note: document.querySelector("#takeoff-section .governance-note")?.textContent || "",
      approveShown: document.querySelector("#approve-takeoff")?.hidden === false,
    };
  });
  check("the section is on the page", view.shown === true);
  check("and wears the product's own state", /read by ai · not approved/i.test(view.pill || ""), view.pill);
  /* The numbers are the calculator's, worked by hand:
     Wall A1 (12', 2 corners): ceil(144/16)+1 = 10, +4 = 14 studs.
     Wall A2 (20', 2 corners, one 3' door): ceil(240/16)+1 = 16, +4 corners,
     +4 for the door (2 kings + 2 trimmers) = 24. Total 38.
     Plates: A1 432"→3×12'; A2 720"→4×16'. Header: 2 × 2x6 @ 8'.
     My first pass wrote 42 here, reusing the two-opening wall from
     takeoff.mjs — the screen was right and the expectation was not. */
  check("the stud line is the hand-worked total",
    view.rows.some((row) => /2x4 stud · 92 5\/8" precut 38 pieces/.test(row)), JSON.stringify(view.rows));
  check("the door's header is on the order",
    view.rows.some((row) => /2x6 header · 8' 2 pieces/.test(row)), JSON.stringify(view.rows));
  /* The wall the drawings did not dimension. */
  check("the undimensioned wall is a named gap",
    /Wall B1 has no printed length \(A-202\)/.test(view.gaps), view.gaps.slice(0, 200));
  check("the intro says where the numbers may and may not come from",
    /printed on the sheets/i.test(view.intro) && /nothing is measured by scale/i.test(view.intro), view.intro.slice(0, 200));
  check("and the note refuses to be an estimate",
    /not a contractor's estimate/i.test(view.note), view.note.slice(0, 160));
  check("an owner is offered the approval", view.approveShown === true);

  console.log("\n── the arithmetic is inspectable ──");
  const trace = await page.evaluate(() => {
    document.querySelector(".takeoff-trace summary")?.click();
    return document.querySelector("#takeoff-trace")?.innerText.replace(/\s+/g, " ") || "";
  });
  check("each wall shows its steps and its sheet",
    /Wall A1 · A-201/.test(trace) && /ceil\(144" \/ 16"\) \+ 1 = 10/.test(trace), trace.slice(0, 200));

  console.log("\n── signing it ──");
  const signed = await page.evaluate(async () => {
    let asked = "";
    window.confirm = (message) => { asked = message; return true; };
    document.querySelector("#approve-takeoff")?.click();
    await new Promise((r) => setTimeout(r, 700));
    const call = window.__rpcCalls.find((c) => c.name === "approve_material_takeoff");
    return { asked, args: call?.args || null };
  });
  check("approving asks first, and names the open gaps",
    /1 open gap/.test(signed.asked) && /not an estimate/i.test(signed.asked), signed.asked.slice(0, 240));
  check("the draft goes to the record verbatim",
    signed.args?.p_kind === "wood_framing"
    && signed.args?.p_measured_walls === 2
    && (signed.args?.p_lines || []).some((line) => line.quantity === 38),
    JSON.stringify(signed.args?.p_lines?.slice(0, 2)));
  check("with the gap that stays open",
    (signed.args?.p_gaps || []).some((gap) => /Wall B1/.test(gap)), JSON.stringify(signed.args?.p_gaps));
  check("and the calculator names its version",
    signed.args?.p_calculator_version === "takeoff360-1", signed.args?.p_calculator_version);
  check("nothing threw", errors.length === 0, errors.join(" | "));
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

await browser.close(); server.close();
console.log(bad ? `\n${bad} FAILURES` : "\nALL OK");
process.exit(bad ? 1 : 0);
