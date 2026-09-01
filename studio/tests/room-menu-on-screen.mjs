/* Walking to the next room without leaving the capture — on the screen.
 *
 * The headset has had this since the room menu was built: bring up the list,
 * choose a room, and you are standing in it, without taking the headset off.
 * The browser never had it. On a laptop, changing room meant closing the
 * capture, going back to the project and opening another one — which is the
 * exact dead end the headset menu was made to remove, still sitting on the
 * desk. Asked for again in those words: bring back the room change with the
 * menu, the way we wanted it.
 *
 * This drives the real viewer against the real project shape.
 */
import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";
import http from "http"; import fs from "fs"; import path from "path";
import { realProjectRows } from "./seed.mjs";

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

const world = realProjectRows();
const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox", "--no-proxy-server", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});
const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
await context.route("**://*/**", (r) => (r.request().url().startsWith(base) ? r.continue() : r.abort()));
await context.addInitScript(`window.__seed = ${JSON.stringify({ rows: world })};`);
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
await page.waitForTimeout(1600);

const opened = await page.evaluate(async () => {
  document.querySelector('[data-focus-step="results"]')?.click();
  await new Promise((r) => setTimeout(r, 500));
  const open = [...document.querySelectorAll("button")]
    .find((b) => /open 360 view/i.test(b.textContent || "") && b.offsetParent !== null);
  if (!open) return { opened: false };
  open.click();
  await new Promise((r) => setTimeout(r, 1400));
  const button = document.querySelector("[data-pano-rooms]");
  return {
    opened: document.querySelector(".pano-overlay")?.hidden === false,
    there: Boolean(button),
    hidden: button?.hidden,
    label: button?.textContent.trim() || "",
    title: document.querySelector("[data-pano-title]")?.textContent || "",
  };
});
check("a capture opens", opened.opened === true);
check("the viewer offers the rooms of this project", opened.there === true && opened.hidden === false,
  `hidden: ${opened.hidden}`);
/* A count is the one thing worth saying on the button: it tells somebody
   whether pressing it is worth the press. */
check("and says how many there are", /\d+ rooms/.test(opened.label), opened.label);

const listed = await page.evaluate(async () => {
  document.querySelector("[data-pano-rooms]").click();
  await new Promise((r) => setTimeout(r, 300));
  const panel = document.querySelector(".pano-list");
  const rows = [...(panel?.querySelectorAll("[data-room-go]") || [])];
  return {
    up: Boolean(panel),
    heading: panel?.querySelector("h3")?.textContent || "",
    rows: rows.length,
    here: rows.filter((row) => row.getAttribute("aria-current") === "true")
      .map((row) => row.querySelector("span")?.textContent.trim()),
    names: rows.map((row) => row.querySelector("span")?.textContent.trim()),
  };
});
check("pressing it opens the list", listed.up === true);
check("every room is in it", listed.rows > 1 && listed.rows === listed.names.length,
  `${listed.rows} rows`);
check("the heading counts them", /\d+ rooms in this project/.test(listed.heading), listed.heading);
/* Standing somewhere is a fact the list must carry, or the first thing
   somebody does is walk to the room they are already in. */
check("exactly one room is marked as the one you are in",
  listed.here.length === 1, JSON.stringify(listed.here));

const walked = await page.evaluate(async () => {
  const before = document.querySelector("[data-pano-title]")?.textContent || "";
  document.querySelector("[data-pano-rooms]").click();
  await new Promise((r) => setTimeout(r, 300));
  const other = [...document.querySelectorAll("[data-room-go]")]
    .find((row) => row.getAttribute("aria-current") !== "true");
  const goingTo = other?.querySelector("span")?.textContent.trim() || "";
  other?.click();
  await new Promise((r) => setTimeout(r, 1500));
  document.querySelector("[data-pano-rooms]")?.click();
  await new Promise((r) => setTimeout(r, 300));
  const here = [...document.querySelectorAll("[data-room-go]")]
    .filter((row) => row.getAttribute("aria-current") === "true")
    .map((row) => row.querySelector("span")?.textContent.trim());
  const panelUp = Boolean(document.querySelector(".pano-list"));
  document.querySelector("[data-room-close]")?.click();
  return { before, goingTo, after: document.querySelector("[data-pano-title]")?.textContent || "", here, panelUp };
});
check("choosing another room opens that room's capture",
  walked.after !== walked.before && walked.after.length > 0,
  `${walked.before} → ${walked.after}`);
/* The whole point: the viewer never closed. */
check("without ever leaving the viewer",
  walked.panelUp === true, "the overlay must still be up afterwards");
check("and the list now says you are in the room you walked to",
  walked.here.length === 1 && walked.here[0] === walked.goingTo,
  `went to ${walked.goingTo}, list says ${JSON.stringify(walked.here)}`);

const stayed = await page.evaluate(async () => {
  const before = document.querySelector("[data-pano-title]")?.textContent || "";
  document.querySelector("[data-pano-rooms]").click();
  await new Promise((r) => setTimeout(r, 300));
  [...document.querySelectorAll("[data-room-go]")]
    .find((row) => row.getAttribute("aria-current") === "true")?.click();
  await new Promise((r) => setTimeout(r, 900));
  return { before, after: document.querySelector("[data-pano-title]")?.textContent || "" };
});
/* Reloading the same capture under somebody who chose where they already are
   looks like a fault, not an answer. */
check("choosing the room you are in changes nothing",
  stayed.after === stayed.before, `${stayed.before} → ${stayed.after}`);

const closed = await page.evaluate(async () => {
  document.querySelector("[data-pano-close]")?.click();
  await new Promise((r) => setTimeout(r, 400));
  return { hidden: document.querySelector("[data-pano-rooms]")?.hidden };
});
/* A list of rooms belongs to the capture it was opened with. */
check("closing the viewer puts the list away", closed.hidden === true, `hidden: ${closed.hidden}`);

check("nothing threw", errors.length === 0, errors.join(" | "));

await browser.close(); server.close();
console.log(bad ? `\n${bad} FAILURES` : "\nALL OK");
process.exit(bad ? 1 : 0);
