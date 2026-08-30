/* The whole chain, one state at a time.
 *
 * upload → get something back → see what was and what is now → add what is
 * missing → it accumulates somewhere you can look at any time. That is the
 * product in one sentence, and the bugs have not been in the sentence, they
 * have been in the joints between its clauses: the moment plans are uploaded
 * but not read, the moment the machine is working, the moment the AI has
 * answered and nobody has confirmed it.
 *
 * Every state here asserts the same three things, because they are the three
 * the product promises: the screen says truthfully where the work stands, it
 * does not contradict itself, and something on it is pressable.
 */
import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";
import http from "http"; import fs from "fs"; import path from "path";
import { plansUploadedRows, plansReadingRows, roomsNoEvidenceRows, machineWorkingRows, machineFinishedRows, aiReviewedRows, baselineAwaitingApprovalRows } from "./seed.mjs";

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

async function open(world, where) {
  const context = await browser.newContext({ viewport: { width: 430, height: 900 } });
  await context.route("**://*/**", (r) => (r.request().url().startsWith(base) ? r.continue() : r.abort()));
  await context.addInitScript(`window.__seed = ${JSON.stringify({ rows: world })};`);
  await context.addInitScript({ path: "studio/tests/fake-supabase.js" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 160)));
  await page.goto(`${base}${where}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  if (where === "/studio/") {
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find((x) => (x.textContent || "").includes("3001 Hutton"));
      if (b) b.click();
    });
    await page.waitForTimeout(1300);
  }
  return { context, page, errors };
}

/* Everything a person can read on the stage they are standing on. */
const visibleText = (page) => page.evaluate(() => {
  const shown = [...document.querySelectorAll(".focus-stage, #plan-app, main, body")]
    .find((el) => el.offsetParent !== null || el === document.body);
  return (shown?.innerText || "").replace(/\s+/g, " ");
});

/* ────────────────────────────────────────────────────────────────── */
console.log("\n── plans uploaded, nothing read yet ──");
{
  const { context, page, errors } = await open(plansUploadedRows(), "/studio/plans/?property=prop-1");
  check("the plans screen opens", errors.length === 0, errors[0] || "");
  const text = await visibleText(page);
  check("it names the plan set that is in the project", /Blueprints-3001-Hutton\.pdf/.test(text));
  const start = await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")]
      .find((x) => /analy[sz]e/i.test(x.textContent || "") && x.offsetParent !== null && !x.disabled);
    return b ? b.textContent.trim() : null;
  });
  check("reading them is offered, not hidden", Boolean(start), start || "no enabled analyse control");
  check("it does not claim a baseline exists", !/baseline ready|roadmap ready/i.test(text));
  await context.close();
}

console.log("\n── the plan set is being read, and the job says 62% ──");
{
  const { context, page, errors } = await open(plansReadingRows(), "/studio/plans/?property=prop-1");
  check("the plans screen opens", errors.length === 0, errors[0] || "");
  const readMeter = () => page.evaluate(() => {
    const el = document.querySelector("#analysis-progress-value, [data-analysis-value]");
    return el ? Number(el.textContent.replace("%", "").trim()) : null;
  });
  await page.waitForTimeout(600);
  const first = await readMeter();
  /* Two things, and the second is the one that matters. The meter must open on
     the number the job reported — 62 — rather than restarting at zero. And with
     nothing new reported it must not move, because a meter that climbs on a
     timer is an animation, not progress, and this product does not show
     invented progress. */
  check("the meter opens on the number the job reported",
    first === 62, first === null ? "no meter on screen" : `showed ${first}%, job said 62%`);
  await page.waitForTimeout(2500);
  const second = await readMeter();
  check("and it does not climb on its own while the job says nothing new",
    second === first, `${first}% → ${second}% with no new report`);
  await context.close();
}

/* The same screen, three different reasons for having no rooms. Telling
   somebody to upload a plan set they have already uploaded is the deadlock
   again, one screen further along. */
console.log("\n── no rooms, and the plans are already in the project ──");
{
  const { context, page } = await open(plansUploadedRows(), "/studio/");
  const note = await page.locator("#upload-room-note").first().innerText().catch(() => "");
  check("it does not ask for a plan set that is already there",
    !/upload the plan set/i.test(note), note);
  check("it says the plans have not been read yet", /not been read yet/i.test(note), note);
  const onward = await page.evaluate(() => document.querySelector("#upload-open-plans")?.textContent.trim() || null);
  check("and reading them is one press away", /read the plans/i.test(onward || ""), onward || "no control");
  await context.close();
}

console.log("\n── no rooms, and the roadmap is waiting for approval ──");
{
  const { context, page } = await open(baselineAwaitingApprovalRows(), "/studio/");
  const note = await page.locator("#upload-room-note").first().innerText().catch(() => "");
  /* Approving the roadmap is what creates the rooms. Saying anything else here
     sends a person back to a screen they have already finished with. */
  check("it says approval is what creates the rooms", /approve the roadmap/i.test(note), note);
  check("it does not send them back to upload plans again", !/upload the plan set/i.test(note), note);
  const onward = await page.evaluate(() => document.querySelector("#upload-open-plans")?.textContent.trim() || null);
  check("and the approval screen is one press away", /approve/i.test(onward || ""), onward || "no control");
  await context.close();
}

console.log("\n── rooms exist, nothing has been captured ──");
{
  const { context, page, errors } = await open(roomsNoEvidenceRows(), "/studio/");
  check("the project opens", errors.length === 0, errors[0] || "");
  const note = await page.locator("#upload-room-note").first().innerText().catch(() => "");
  check("the room it will file evidence under is named", /Bath #1 A203|Master Bedroom|Kitchen|Stairs/.test(note), note);
  check("and it says the room is empty rather than implying content", /empty so far|no evidence|nothing/i.test(note), note);
  /* A step that cannot be opened yet must still answer. On a phone there is no
     hover and no cursor, so a silent tap is indistinguishable from a broken
     button — which is exactly the complaint that produced this test. */
  const answered = await page.evaluate(async () => {
    const before = document.querySelector(".focus-stage:not([hidden])")?.id || "";
    const step = document.querySelector('[data-focus-step="results"]');
    if (!step) return { pressed: false };
    step.click();
    await new Promise((r) => setTimeout(r, 400));
    const after = document.querySelector(".focus-stage:not([hidden])")?.id || "";
    const said = (document.querySelector("#toast, .toast, #notice")?.textContent || "").trim();
    return { pressed: true, before, after, said, role: step.getAttribute("role") };
  });
  check("a step that is not ready is announced as a control", answered.role === "button", `role="${answered.role}"`);
  check("and pressing it says something rather than nothing",
    Boolean(answered.said) || answered.before !== answered.after, answered.said || "(silent and went nowhere)");
  await context.close();
}

console.log("\n── the 360 machine is working right now ──");
{
  const { context, page, errors } = await open(machineWorkingRows(), "/studio/");
  check("the project opens", errors.length === 0, errors[0] || "");
  await page.evaluate(() => document.querySelector('[data-focus-step="results"]')?.click());
  await page.waitForTimeout(500);
  const text = await visibleText(page);
  check("the screen says the machine is working", /stitching now|machine is running/i.test(text),
    (text.match(/[^.]*stitch[^.]*\./i) || ["(nothing about stitching)"])[0].trim());
  check("it gives the progress the job actually reported", /41%/.test(text));
  /* It used to say "The camera originals are untouched" in the same breath as
     "Stitching now", which reads as a contradiction. The promise is that an
     original is never altered, and that is what it should say. */
  check("it does not claim the originals are untouched while they are being read",
    !/originals are untouched/i.test(text),
    (text.match(/[^.]*untouched[^.]*\./i) || [""])[0].trim());
  check("it still promises originals are never altered", /never altered/i.test(text));
  await context.close();
}

console.log("\n── the machine says how long it took ──");
/* Automation earns its keep in a number: a site gets captured every week
   only if the capture step is cheap. A record that says a capture was
   stitched but never how long that took cannot answer that, and the person
   holding the camera is the one who needs the answer. */
{
  const { context, page, errors } = await open(machineFinishedRows(), "/studio/");
  check("the project opens", errors.length === 0, errors[0] || "");
  await page.evaluate(() => document.querySelector('[data-focus-step="results"]')?.click());
  await page.waitForTimeout(500);
  const text = await visibleText(page);
  check("the screen says how long the last capture took to stitch",
    /stitched in 41s/i.test(text),
    (text.match(/[^.]*stitched in[^.]*/i) || ["(nothing about how long)"])[0].trim());
  /* Six minutes of waiting for a sleeping machine is not six minutes of
     stitching, and the screen must not let the two be read as one. */
  check("and does not pass the wait for the machine off as stitching time",
    !/stitched in 6m/i.test(text) && !/stitched in 7m/i.test(text));
  await context.close();
}

console.log("\n── the AI has answered and nobody has confirmed it ──");
{
  const { context, page, errors } = await open(aiReviewedRows(), "/studio/");
  check("the project opens", errors.length === 0, errors[0] || "");
  await page.evaluate(() => document.querySelector('[data-focus-step="results"]')?.click());
  await page.waitForTimeout(500);
  const text = await visibleText(page);
  check("what the AI said is shown", /Framing complete, drywall not started/.test(text));
  /* The rule the whole product rests on: an interpretation is a suggestion
     until a person confirms it, and the screen must say so where it is read. */
  check("it is marked as needing a person, not stated as fact",
    /needs verification|suggestion|not verified|becomes part of the record only after/i.test(text));
  const verify = await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")]
      .find((x) => /verify/i.test(x.textContent || "") && x.offsetParent !== null && !x.disabled);
    return b ? b.textContent.trim().slice(0, 40) : null;
  });
  check("confirming it is one press away", Boolean(verify), verify || "no way to verify from here");
  await context.close();
}

await browser.close(); server.close();
console.log(bad ? `\n${bad} FAILURES` : "\nALL OK");
process.exit(bad ? 1 : 0);
