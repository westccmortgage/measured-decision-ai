/* The whole path, driven in a browser: open the project, look at every stage,
 * press what a person would press, and check the screen tells the truth about
 * the world it was given.
 *
 * The world is studio/tests/seed.mjs — four rooms in the four states that have
 * produced every bug so far: one you can stand in, one holding a camera pair the
 * machine has not reached, one holding only a document, one empty.
 */
import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";
import http from "http";
import fs from "fs";
import path from "path";
import { seed } from "./seed.mjs";

const ROOT = path.resolve(".");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

const server = http.createServer((req, res) => {
  let file = path.join(ROOT, decodeURIComponent(req.url.split("?")[0]));
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end("not found"); }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox", "--no-proxy-server", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});
const context = await browser.newContext({ viewport: { width: 430, height: 900 } });
/* Mobile-first is a product rule, so the walk happens at phone size. */

// Nothing may reach the network: a test that quietly talks to production is worse
// than no test.
await context.route("**://*/**", (route) =>
  route.request().url().startsWith(base) ? route.continue() : route.abort());

const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 200)));

await page.addInitScript(`window.__seed = ${JSON.stringify(seed)};`);
await page.addInitScript({ path: "studio/tests/fake-supabase.js" });

const findings = [];
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? `\n         ${detail}` : ""}`);
  if (!ok) findings.push(`${label}${detail ? ` — ${detail}` : ""}`);
};
const text = async (sel) => (await page.locator(sel).first().textContent().catch(() => ""))?.trim() || "";
const visible = async (sel) => page.locator(sel).first().isVisible().catch(() => false);

console.log("\n── 1. arriving at the Studio ──");
await page.goto(`${base}/studio/`, { waitUntil: "networkidle" });
await page.waitForTimeout(900);

check("the page did not throw on load", pageErrors.length === 0, pageErrors[0] || "");
const bodyText = await page.evaluate(() => document.body.innerText);
check("the project is on screen", bodyText.includes("3001 Hutton"),
  `first 120 chars: ${bodyText.slice(0, 120).replace(/\n/g, " · ")}`);

console.log("\n── 2. opening the project ──");
/* Pressed by its name, the way a person picks their project out of a list —
   not by whichever button happens to match a generic word first. */
const opened = await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => (x.textContent || "").includes("3001 Hutton"));
  if (b) { b.click(); return b.textContent.trim().slice(0, 40); }
  return null;
});
check("the project can be opened by name", Boolean(opened), opened || "no button carried the project name");
await page.waitForTimeout(1200);

const projectName = await text("#focus-project-name");
const projectState = await text("#focus-project-summary");
check("the project is named on screen", projectName.includes("3001 Hutton"), projectName);
check("the screen states the project's condition", projectState.length > 2, projectState);

console.log("\n── 2b. the upload stage names the room things will go to ──");
const uploadNote = await text("#upload-room-note");
check("the upload note says where evidence will land", /goes into/i.test(uploadNote), uploadNote);
check("the upload note counts what is already there", /holds|nothing/i.test(uploadNote), uploadNote);

console.log("\n── 3. the four room states, on the AI stage ──");
/* Through the button on the upload screen, because the AI step is deliberately
   not reachable until something has been asked of it — pressing the numbered
   step does nothing, which is correct and is why the walk must not use it. */
const reachedAi = await page.evaluate(() => {
  const b = document.querySelector("#focus-process");
  if (!b || b.disabled) return false;
  b.click();
  return true;
});
check("the AI stage is reached from the button a person can see", reachedAi);
await page.waitForTimeout(700);
const hasPicker = await visible("#analyze-room");
check("the AI stage offers a room to choose", hasPicker);

if (hasPicker) {
  const states = [
    ["space-viewable", "Bath #1 A203", { readable: true }],
    ["space-waiting", "Master Bedroom 205A", { readable: false, mustMention: "360 machine" }],
    ["space-docs", "Kitchen A102", { readable: false, mustMention: "document" }],
    ["space-empty", "Stairs 108", { readable: false }],
  ];
  for (const [id, name, want] of states) {
    const picked = await page.evaluate((roomId) => {
      const sel = document.querySelector("#analyze-room");
      if (!sel || ![...sel.options].some((o) => o.value === roomId)) return null;
      sel.value = roomId;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }, id);
    if (!picked) { check(`${name} is offered in the picker`, false, "not in the list"); continue; }
    await page.waitForTimeout(150);
    const note = await text("#analyze-room-note");
    const disabled = await page.locator("#analyze-room-run").isDisabled().catch(() => true);
    check(`${name} — the note says what is true`, note.length > 0, note);
    check(`${name} — the button matches the note`, disabled === !want.readable,
      `button ${disabled ? "disabled" : "enabled"}, room ${want.readable ? "readable" : "not readable"}`);
    if (want.mustMention) {
      check(`${name} — the note names the real obstacle`,
        note.toLowerCase().includes(want.mustMention), `expected to mention "${want.mustMention}"`);
    }
    check(`${name} — the note never tells you to do what you did`,
      !/add a visual capture first/i.test(note), note);
  }
}

console.log("\n── 4. the 360 button ──");
await page.evaluate(() => {
  const b = document.querySelector("#focus-view-results");
  if (b && !b.disabled) { b.click(); return; }
  const step = document.querySelector('[data-focus-step="results"]');
  if (step) step.click();
});
await page.waitForTimeout(900);
const vrButton = await text('[data-vr-action="open"]');
check("the 360 button exists", vrButton.length > 0, vrButton);
check("the 360 button names the room it will open", /Bath #1 A203/.test(vrButton),
  `says "${vrButton}" — the only capture that can be opened is in Bath #1 A203`);

console.log("\n── 5. nothing on screen is a dead control ──");
const dead = await page.evaluate(() => {
  const out = [];
  document.querySelectorAll("button").forEach((b) => {
    if (b.offsetParent === null || b.disabled) return;
    const wired = b.type === "submit" || b.closest("form") || b.id ||
      [...b.attributes].some((a) => a.name.startsWith("data-"));
    if (!wired) out.push((b.textContent || "").trim().slice(0, 40));
  });
  return out;
});
check("every visible button is wired to something", dead.length === 0, dead.join(" | "));

console.log("\n── 6. no horizontal scroll on a phone ──");
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
check("the page fits a 430px screen", overflow <= 1, `overflows by ${overflow}px`);

check("still no script errors after the walk", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));

console.log("\n── 7. a finished reading points at the comparison ──");
const loop = await page.evaluate(() => {
  const before = document.querySelector("#focus-open-comparison")?.hidden === true;
  window.__finishFocusProcessing(2);
  const button = document.querySelector("#focus-open-comparison");
  return { before, after: button?.hidden === false, label: button?.textContent.trim() || "" };
});
check("the comparison door stays hidden until a reading finishes", loop.before);
check("and appears the moment readings are done", loop.after && /comparison/i.test(loop.label), JSON.stringify(loop));
await page.evaluate(() => document.querySelector("#focus-open-comparison")?.click());
await page.waitForTimeout(800);
check("pressing it lands on Plan Intelligence for this same project",
  /\/studio\/plans\/\?property=/.test(page.url()), page.url());

await browser.close();
server.close();

console.log(`\n${"─".repeat(60)}`);
console.log(findings.length ? `${findings.length} FINDING(S)\n` + findings.map((f) => "  · " + f).join("\n") : "ALL OK");
console.log("");
process.exit(findings.length ? 1 : 0);
