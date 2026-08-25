/* A page that has been open for hours.
 *
 * This is the dimension the whole suite was missing, and it cost a working day.
 *
 * Every other test opens a clean browser, acts within a few seconds, and closes
 * it. The longest-lived page in the suite is about six seconds. A real session
 * is three hours: files uploaded at midnight, more at two, "Process with AI"
 * pressed at half past four — all on the one page that was opened at the start.
 *
 * Signed URLs live one hour. They were minted once, when the project loaded,
 * and never renewed. So after an hour every link on the screen was dead at the
 * same moment: thumbnails stopped loading, captures would not open, and
 * analysis died in a tenth of a second because the browser could not read a
 * frame out of a video it was no longer allowed to fetch. What a person saw was
 * "all my files are broken". None of them were.
 *
 * Nothing here is about signed URLs specifically. It is about time passing,
 * which is the thing the other tests hold still.
 */
import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";
import http from "http"; import fs from "fs"; import path from "path";
import { rows } from "./seed.mjs";

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
await context.addInitScript(`window.__seed = ${JSON.stringify({ rows })};`);
await context.addInitScript({ path: "studio/tests/fake-supabase.js" });

/* The clock the page reads, which the test can move. Installed before any page
   script runs, so everything the Studio stamps goes through it. */
await context.addInitScript(() => {
  window.__skewMs = 0;
  const realNow = Date.now.bind(Date);
  Date.now = () => realNow() + window.__skewMs;
  /* Only Date.now is moved. Timers and animation frames keep real time, so the
     page behaves as it does in life rather than fast-forwarding. */
  window.__ageBy = (hours) => { window.__skewMs += hours * 3600 * 1000; return window.__skewMs; };
});

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

const signCalls = () => page.evaluate(() =>
  window.__rpcCalls.filter((c) => c?.args?.operation === "get_url").length);

console.log("\n── while the page is fresh ──");
{
  const before = await signCalls();
  const opened = await page.evaluate(async () => {
    document.querySelector('[data-focus-step="results"]')?.click();
    await new Promise((r) => setTimeout(r, 500));
    const open = [...document.querySelectorAll("button")]
      .find((b) => /open 360 view/i.test(b.textContent || "") && b.offsetParent !== null);
    if (!open) return { found: false };
    open.click();
    await new Promise((r) => setTimeout(r, 1200));
    return { found: true, shown: document.querySelector(".pano-overlay")?.hidden === false };
  });
  const after = await signCalls();
  check("a capture opens", opened.found && opened.shown === true, JSON.stringify(opened));
  /* A signature minted a minute ago is good for another fifty-nine. Renewing it
     anyway would be a network round trip on every press, for nothing. */
  check("and a signature minted a minute ago is not renewed for no reason",
    after === before, `${after - before} extra signing call(s)`);
  await page.evaluate(() => document.querySelector("[data-pano-close]")?.click());
  await page.waitForTimeout(300);
}

console.log("\n── three hours later, on the same page ──");
{
  await page.evaluate(() => window.__ageBy(3));
  const before = await signCalls();
  const opened = await page.evaluate(async () => {
    const open = [...document.querySelectorAll("button")]
      .find((b) => /open 360 view/i.test(b.textContent || "") && b.offsetParent !== null);
    if (!open) return { found: false };
    open.click();
    await new Promise((r) => setTimeout(r, 1400));
    const overlay = document.querySelector(".pano-overlay");
    return { found: true, shown: overlay?.hidden === false };
  });
  const after = await signCalls();
  /* This is the whole test. Before the fix this press reused an hour-dead URL
     and the capture would not load. */
  check("the link is renewed before the capture opens",
    after > before, `${after - before} signing call(s) — expected at least one`);
  check("and the capture still opens", opened.found && opened.shown === true, JSON.stringify(opened));
  check("nothing threw", errors.length === 0, errors.join(" | "));
  await page.evaluate(() => document.querySelector("[data-pano-close]")?.click());
  await page.waitForTimeout(300);
}

console.log("\n── an analysis with nothing to analyse ──");
{
  /* In this harness a capture's URL is not a real video, so no frame can ever be
     read out of it. That is exactly the production failure: every video in the
     room fails to open. What must not happen is the request going out anyway. */
  const result = await page.evaluate(async () => {
    window.__rpcCalls.length = 0;
    document.querySelector('[data-focus-step="process"]')?.click();
    await new Promise((r) => setTimeout(r, 500));
    const go = document.querySelector("#focus-process");
    if (!go || go.disabled) return { pressed: false, disabled: go?.disabled };
    go.click();
    /* Long enough for the media element to give up on every file. */
    await new Promise((r) => setTimeout(r, 6000));
    return {
      pressed: true,
      sent: window.__rpcCalls.filter((c) => c.name === "spatial-analyze").length,
      jobsWritten: window.__writes.filter((w) => w.table === "analysis_jobs" && w.op === "insert").length,
      /* The reason lands on the processing row for that room, which is where
         somebody watching the run is actually looking. */
      said: (document.querySelector("#focus-processing-list")?.innerText || "").replace(/\s+/g, " "),
    };
  });
  if (!result.pressed) {
    check("Process with AI is reachable", false, `disabled: ${result.disabled}`);
  } else {
    /* The request that produced "Failed" with nothing behind it. */
    check("nothing is sent when there is nothing to send",
      result.sent === 0, `${result.sent} analysis request(s) went out`);
    /* And no job row is left behind saying somebody asked for work that will
       never finish. */
    check("and no job is recorded that will never finish",
      result.jobsWritten === 0, `${result.jobsWritten} job row(s) written`);
    check("the screen names the room it gave up on",
      /None of the 1 video in Bath #1 A203/i.test(result.said), result.said.slice(0, 200));
    check("and says there was nothing to analyse rather than just failing",
      /nothing to analyse/i.test(result.said), result.said.slice(0, 200));
    /* "Some videos could not be sampled" is not a reason. The reason is the
       thing somebody can act on. */
    check("and carries the reason the file gave",
      /could not be decoded/i.test(result.said), result.said.slice(0, 260));
    check("and says what to do next",
      /press process with ai again/i.test(result.said), result.said.slice(0, 300));
  }
  check("nothing threw across the whole aged session", errors.length === 0, errors.join(" | "));
}

await browser.close(); server.close();
console.log(bad ? `\n${bad} FAILURES` : "\nALL OK");
process.exit(bad ? 1 : 0);
