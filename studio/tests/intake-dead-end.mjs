/* The quick drop box used to end nowhere.
   Somebody uploaded plans and two 360 captures, came back to the page, and saw
   "Add evidence", a project code, and nothing else — no statement of what had
   been stored, and no route to the record that reads it. */
import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";
import http from "http"; import fs from "fs"; import path from "path";

const ROOT = path.resolve(".");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const server = http.createServer((req, res) => {
  let f = path.join(ROOT, req.url.split("?")[0]);
  if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, "index.html");
  if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(f)] || "application/octet-stream" });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox", "--no-proxy-server"],
});
const context = await browser.newContext({ viewport: { width: 430, height: 900 } });
await context.route("**://*/**", (r) => r.request().url().startsWith(base) ? r.continue() : r.abort());
await context.addInitScript(`window.__seed={session:null,rows:{}};`);
await context.addInitScript({ path: "studio/tests/fake-supabase.js" });
const page = await context.newPage();
await page.goto(`${base}/studio/`, { waitUntil: "networkidle" });
await page.waitForTimeout(700);

let bad = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `\n       ${detail}` : ""}`);
  if (!ok) bad++;
};

/* Reopening a project that already holds files, exactly as returning to it does. */
const state = await page.evaluate(() => {
  const el = (id) => document.getElementById(id);
  el("simple-intake").hidden = false;
  el("simple-intake-landing").hidden = true;
  el("simple-project").hidden = false;
  el("simple-project-state").textContent = "3 evidence files already stored";
  // The page's own routine writes the sentence, for a project that already
  // holds three files — the state a person returns to.
  window.MDAIProjectIntake.describeNext(3);
  return {
    copy: (el("simple-next-copy")?.textContent || "").trim(),
    onward: Boolean(el("simple-next-signin")),
    onwardText: (el("simple-next-signin")?.textContent || "").trim(),
    addMoreHidden: el("simple-add-more")?.hidden,
    completeHidden: el("simple-upload-complete")?.hidden,
  };
});

check("the page says what this surface is", state.copy.length > 40, state.copy);
check("it says how many files are stored", /\b3 files\b/.test(state.copy), state.copy);
check("it says nothing has been done to them yet",
  /nothing has been done/i.test(state.copy), state.copy);
check("it names what lives elsewhere",
  /rooms/i.test(state.copy) && /AI review/i.test(state.copy) && /report/i.test(state.copy), state.copy);

/* An empty project must not claim files it does not have. */
const empty = await page.evaluate(() => window.MDAIProjectIntake.describeNext(0));
check("an empty project says so without inventing a number", !/\d/.test(empty), empty);
const one = await page.evaluate(() => window.MDAIProjectIntake.describeNext(1));
check("one file is one file, not one files", /1 file are|1 files/.test(one) === false, one);
check("there is a way onward", state.onward, state.onwardText);
check("the way onward is a real control", /full record/i.test(state.onwardText), state.onwardText);

/* And the route must actually go somewhere. */
const wentSomewhere = await page.evaluate(() => {
  const before = document.getElementById("prototype-gate")?.hidden;
  document.getElementById("simple-next-signin").click();
  return { before, after: document.getElementById("prototype-gate")?.hidden };
});
check("pressing it opens the way in", wentSomewhere.before === true && wentSomewhere.after === false,
  JSON.stringify(wentSomewhere));

await browser.close(); server.close();
console.log(bad ? `\n${bad} FAILURES` : "\nALL OK");
process.exit(bad ? 1 : 0);
