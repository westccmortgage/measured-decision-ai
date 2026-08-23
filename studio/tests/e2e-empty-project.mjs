/* A project that has just been created, walked the way its owner walks it.
 *
 * Nothing in it: no plan read, no rooms, no files. This is the first screen a
 * new customer sees, and it deadlocked — "choose the room before uploading",
 * with no rooms and no way on this screen to get any. The rule the product is
 * built on is that no screen may be a dead end, so that is what this asserts:
 * wherever you stand, something enabled must take you forward, and it must say
 * where it goes.
 */
import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";
import http from "http"; import fs from "fs"; import path from "path";
import { emptySeed } from "./seed.mjs";

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
const context = await browser.newContext({ viewport: { width: 430, height: 900 } });
await context.route("**://*/**", (r) => r.request().url().startsWith(base) ? r.continue() : r.abort());
await context.addInitScript(`window.__seed = ${JSON.stringify(emptySeed)};`);
await context.addInitScript({ path: "studio/tests/fake-supabase.js" });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 160)));

let bad = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? `\n         ${detail}` : ""}`);
  if (!ok) bad++;
};

await page.goto(`${base}/studio/`, { waitUntil: "networkidle" });
await page.waitForTimeout(1000);

console.log("\n── a project created one minute ago ──");
await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => (x.textContent || "").includes("3001 Hutton"));
  if (b) b.click();
});
await page.waitForTimeout(1200);

check("it opens without throwing", errors.length === 0, errors[0] || "");
const name = await page.locator("#focus-project-name").first().textContent().catch(() => "");
check("the empty project opens", (name || "").includes("3001 Hutton"), name || "(no name)");

console.log("\n── the upload screen, with nothing to upload into ──");
const note = await page.locator("#upload-room-note").first().innerText().catch(() => "");
check("it says why no room can be chosen", /no rooms yet/i.test(note), note);
check("it says where rooms come from", /plan set/i.test(note), note);

/* The whole point: the sentence naming the next step must be the next step. */
const doorway = await page.evaluate(() => {
  const b = document.querySelector("#upload-open-plans");
  return b ? { text: b.textContent.trim(), visible: b.offsetParent !== null } : null;
});
check("the next step is a control, not a sentence", Boolean(doorway), doorway ? doorway.text : "no button in the note");
check("and it is on screen", doorway?.visible === true);

/* No screen may be a dead end. Every stage must offer something enabled. */
console.log("\n── no stage is a dead end ──");
for (const stage of ["upload", "process", "results"]) {
  const live = await page.evaluate((which) => {
    const step = document.querySelector(`[data-focus-step="${which}"]`);
    if (step) step.click();
    const shown = document.querySelector(`#focus-${which === "process" ? "processing" : which}-stage`);
    if (!shown || shown.hidden) return { reached: false };
    const actions = [...shown.querySelectorAll("button, label[for], a")]
      .filter((el) => el.offsetParent !== null && !el.disabled)
      .map((el) => (el.textContent || "").trim().slice(0, 34))
      .filter(Boolean);
    return { reached: true, actions };
  }, stage);
  if (!live.reached) { console.log(`  --   ${stage} is not reachable yet, which is correct here`); continue; }
  check(`${stage}: something on it can be pressed`, live.actions.length > 0, live.actions.join(" | "));
}

console.log("\n── and the destination exists ──");
await page.evaluate(() => {
  const step = document.querySelector('[data-focus-step="upload"]');
  if (step) step.click();
});
await page.waitForTimeout(300);
/* Press it for real and let the navigation commit. Reading location in the
   same tick as the click reads the page you are leaving, not the one you are
   going to — that is a harness mistake, and it once reported this working
   button as broken. */
const before = page.url();
await page.evaluate(() => document.querySelector("#upload-open-plans")?.click());
await page.waitForURL((url) => String(url) !== before, { timeout: 5000 }).catch(() => {});
const target = new URL(page.url()).pathname + new URL(page.url()).search;
check("pressing it goes to the plans screen for this project",
  /\/plans\/?\?property=/.test(target), target || "(did not navigate)");

/* And the plans screen it lands on is not itself a dead end. */
await page.waitForTimeout(1200);
const plansHasAWayIn = await page.evaluate(() => {
  const live = [...document.querySelectorAll("button, label[for], input[type=file] + label, a")]
    .filter((el) => el.offsetParent !== null && !el.disabled)
    .map((el) => (el.textContent || "").trim())
    .filter(Boolean);
  return live.some((t) => /upload|add|choose|select|plan|file|drop/i.test(t)) ? live.slice(0, 6) : null;
});
check("the plans screen offers a way to add the plan set",
  Boolean(plansHasAWayIn), plansHasAWayIn ? plansHasAWayIn.join(" | ") : "nothing to press once you arrive");

await browser.close(); server.close();
console.log(bad ? `\n${bad} FAILURES` : "\nALL OK");
process.exit(bad ? 1 : 0);
