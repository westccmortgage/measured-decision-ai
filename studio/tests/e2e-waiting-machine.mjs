/* A capture that is waiting for the 360 machine.
 *
 * Two INSV lens files are a complete 360 capture and a browser cannot read
 * either of them, so the machine has to stitch a playable master before the AI
 * has anything to look at. Pressing "Process with AI" here used to produce a
 * sentence that vanished in nine seconds — which is exactly what "I press the
 * button and nothing happens" looks like from the other side of the screen.
 *
 * Worse, the sentence ended with what the machine did yesterday. "The 360
 * machine finished 1 day ago — 2 captures stitched", appended to a capture
 * uploaded a minute ago, reads as reassurance that it is being handled. It is
 * not: the machine is off and nothing is touching that file.
 */
import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";
import http from "http"; import fs from "fs"; import path from "path";
import { rows, machineWorkingRows, ORG } from "./seed.mjs";

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

/* The machine ran yesterday and stitched two captures, then stopped. This is
   the state the stale sentence came from. */
const machineFinishedYesterdayRows = () => {
  const r = JSON.parse(JSON.stringify(rows));
  const yesterday = new Date(Date.now() - 26 * 3600 * 1000).toISOString();
  r.worker_machine_runs = [{
    id: "run-0", instance_id: "i-old", region: "us-east-2", worker_version: "2026-08-21.3",
    state: "finished", step: "Queue empty", exit_code: 0, message: null, log_url: null,
    jobs_claimed: 2, jobs_completed: 2, jobs_failed: 0,
    started_at: yesterday, last_seen_at: yesterday, finished_at: yesterday,
  }];
  return r;
};

async function pressProcess(world) {
  const context = await browser.newContext({ viewport: { width: 430, height: 900 } });
  await context.route("**://*/**", (r) => (r.request().url().startsWith(base) ? r.continue() : r.abort()));
  await context.addInitScript(`window.__seed = ${JSON.stringify({ rows: world })};`);
  await context.addInitScript({ path: "studio/tests/fake-supabase.js" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 160)));
  await page.goto(`${base}/studio/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => (x.textContent || "").includes("3001 Hutton"));
    if (b) b.click();
  });
  await page.waitForTimeout(1300);
  /* Driven the way a person drives it: choose the room on the upload screen,
     then press the button that is in front of them. An earlier draft of this
     test reached into the processing stage directly and proved nothing about
     the path anybody actually walks. */
  const state = await page.evaluate(async () => {
    const picker = document.querySelector("#upload-room");
    if (picker) {
      const waiting = [...picker.options].find((o) => /Master Bedroom/.test(o.textContent));
      if (waiting) { picker.value = waiting.value; picker.dispatchEvent(new Event("change", { bubbles: true })); }
    }
    await new Promise((r) => setTimeout(r, 250));
    document.querySelector("#focus-process")?.click();
    await new Promise((r) => setTimeout(r, 700));
    const stage = document.querySelector("#focus-processing-stage");
    return {
      onScreen: Boolean(stage) && !stage.hidden,
      title: (document.querySelector("#focus-processing-title")?.innerText || "").trim(),
      copy: (document.querySelector("#focus-processing-copy")?.innerText || "").replace(/\s+/g, " ").trim(),
      alt: (document.querySelector("#focus-processing-list")?.innerText || "").replace(/\s+/g, " ").trim(),
      action: (() => {
        const b = document.querySelector("#focus-blocked-action");
        return b && !b.hidden ? b.textContent.trim() : null;
      })(),
      meterShown: document.querySelector(".focus-processing-meter")?.hidden === false,
    };
  });
  return { context, page, errors, state };
}

console.log("\n── the machine stitched two captures yesterday, and is off now ──");
{
  const { context, errors, state } = await pressProcess(machineFinishedYesterdayRows());
  check("pressing it opens without throwing", errors.length === 0, errors[0] || "");
  /* A sentence that disappears is not an answer. */
  check("the answer stays on the screen", state.onScreen === true);
  check("and the headline says what is being waited on", /waiting for the 360 machine/i.test(state.title), state.title);
  check("it says the originals are safe", /safe and linked/i.test(state.copy), state.copy);
  /* The whole point. Yesterday's run must not read as today's handling. */
  check("it says plainly that nothing is stitching this right now",
    /nothing is stitching this right now/i.test(state.copy), state.copy);
  check("and that the machine has to be started again",
    /started again|has to be started/i.test(state.copy), state.copy);
  /* One clause, not a sentence broken open to paste another one inside it. */
  check("and it reads as a sentence rather than two spliced together",
    !/right now\. .*, and it has/.test(state.copy), state.copy);
  /* A meter at 0% beside "waiting" suggests something is counting. Nothing is. */
  check("no meter pretends to be counting", state.meterShown === false);
  /* No dead ends: the same capture exported as a 360 MP4 is readable today. */
  check("there is something to press", Boolean(state.action), state.action || "(nothing)");
  check("and it is the way forward, not a way back",
    /360 export/i.test(state.action || ""), state.action || "");
  check("the alternative is explained, not just offered",
    /Insta360 Studio/i.test(state.alt) && /reads it straight away/i.test(state.alt), state.alt);
  await context.close();
}

console.log("\n── the machine is working right now ──");
{
  const { context, state } = await pressProcess(machineWorkingRows());
  check("it says the machine is running", /running now/i.test(state.copy), state.copy);
  /* Quoting one whole sentence inside another produced "The machine is running
     now — The 360 machine is running — …". Say it once. */
  check("and says so once, not twice",
    (state.copy.match(/360 machine is running/gi) || []).length === 1, state.copy);
  check("and does not tell them to start it", !/has to be started/i.test(state.copy), state.copy);
  await context.close();
}

console.log("\n── the machine has never reported at all ──");
{
  const { context, state } = await pressProcess(rows);
  check("it still says nothing is stitching this", /nothing is stitching this right now/i.test(state.copy), state.copy);
  check("and there is still a way forward", Boolean(state.action), state.action || "(nothing)");
  await context.close();
}

await browser.close(); server.close();
console.log(bad ? `\n${bad} FAILURES` : "\nALL OK");
process.exit(bad ? 1 : 0);
