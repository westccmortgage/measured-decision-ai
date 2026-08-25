/* "I uploaded two files into Hallway 200A and it says the room is empty."
 *
 * The files were in the database with Hallway 200A's id on them. The screen
 * still showed the room as empty, because a dual-lens 360 capture is drawn as
 * one tile and the tiles were grouped by capture key across the whole project,
 * with no regard for the room. The same capture uploaded to a second room
 * collapsed into the first room's tile — and the tile took the room of
 * sources[0], the oldest row, because the query orders by created_at.
 *
 * So the second room lost every file it had just been given, and said so
 * honestly: nothing here.
 *
 * Two earlier attempts at this bug went after the upload path — the resumable
 * key and the edge function's room precedence. Both were real faults and
 * neither was this one, because the rows were never misfiled. Only the drawing
 * was. That is why this test asserts what the room SHOWS, not what was sent.
 */
import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";
import http from "http"; import fs from "fs"; import path from "path";
import { sameCaptureTwoRoomsRows } from "./seed.mjs";

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
const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
await context.route("**://*/**", (r) => (r.request().url().startsWith(base) ? r.continue() : r.abort()));
await context.addInitScript(`window.__seed = ${JSON.stringify({ rows: sameCaptureTwoRoomsRows() })};`);
await context.addInitScript({ path: "studio/tests/fake-supabase.js" });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
await page.goto(`${base}/studio/`, { waitUntil: "networkidle" });
await page.waitForTimeout(900);
await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => (x.textContent || "").includes("3001 Hutton"));
  if (b) b.click();
});
await page.waitForTimeout(1400);
check("the project opens", errors.length === 0, errors[0] || "");

console.log("\n── the same capture, in two rooms ──");
/* Driven exactly as a person drives it: the AI-processing step, the room
   picker, and the sentence the picker prints underneath. That sentence is the
   one in the screenshot. */
async function roomSays(page, roomName) {
  return page.evaluate(async (name) => {
    /* Reached the way a person reaches it: the upload screen's own button.
       The step chip is not clickable until a run exists, which is exactly the
       state this test is in. */
    const go = document.querySelector("#focus-process");
    if (go && !go.disabled) go.click();
    else document.querySelector('[data-focus-step="process"]')?.click();
    await new Promise((r) => setTimeout(r, 700));
    const picker = document.querySelector("#analyze-room");
    if (!picker) return { found: false, note: "", why: "no picker" };
    /* The room list is filtered by the building above it, so the building has
       to be chosen before the rooms exist. */
    const buildings = document.querySelector("#analyze-building");
    if (buildings && buildings.options.length && !picker.options.length) {
      buildings.value = buildings.options[0].value;
      buildings.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 400));
    }
    const option = [...picker.options].find((entry) => entry.textContent.includes(name));
    if (!option) {
      return {
        found: false, note: "",
        options: [...picker.options].map((o) => o.textContent),
        buildings: [...(document.querySelector("#analyze-building")?.options || [])].map((o) => o.textContent),
      };
    }
    picker.value = option.value;
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 400));
    return {
      found: true,
      note: (document.querySelector("#analyze-room-note")?.textContent || "").replace(/\s+/g, " ").trim(),
      canRun: !document.querySelector("#analyze-room-run")?.disabled,
    };
  }, roomName);
}

/* The room the capture was first uploaded to. It always worked. */
const older = await roomSays(page, "Bath #1 A203");
check("the first room is offered", older.found === true, JSON.stringify(older));
check("and it holds its capture",
  /complete 360 capture/i.test(older.note), older.note.slice(0, 180) || "(nothing)");

/* The room from the screenshot: two files uploaded into it, nothing shown. */
const newer = await roomSays(page, "Stairs 108");
check("the second room is offered", newer.found === true, JSON.stringify(newer));
check("it is NOT reported as empty",
  !/this room is empty/i.test(newer.note), newer.note.slice(0, 180) || "(nothing)");
check("and it says the capture is there, waiting on the 360 machine",
  /complete 360 capture/i.test(newer.note), newer.note.slice(0, 200) || "(nothing)");
/* Both rooms hold one capture each — four lens files, not one pooled tile. */
check("neither room swallowed the other's files",
  /a complete 360 capture/i.test(older.note) && /a complete 360 capture/i.test(newer.note),
  JSON.stringify([older.note.slice(0, 80), newer.note.slice(0, 80)]));
check("nothing threw", errors.length === 0, errors.join(" | "));

await browser.close(); server.close();
console.log(bad ? `\n${bad} FAILURES` : "\nALL OK");
process.exit(bad ? 1 : 0);
