/* The headset probe, checked before anybody puts a headset on.
 *
 * Two things are worth proving here and they are different. One is that the
 * page reports honestly — it must never claim immersive VR on a browser that
 * has no WebXR at all. The other is the orientation of the sphere: a mirrored
 * or upside-down mapping looks perfectly fine on a laptop and is obviously
 * wrong the moment somebody stands inside it, so it is checked by reading
 * actual pixels rather than by looking at the code.
 */
import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";
import http from "http"; import fs from "fs"; import path from "path";

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
const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
await context.route("**://*/**", (r) => (r.request().url().startsWith(base) ? r.continue() : r.abort()));
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
await page.goto(`${base}/studio/vr-check/`, { waitUntil: "networkidle" });
await page.waitForTimeout(800);

let bad = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? `\n         ${detail}` : ""}`);
  if (!ok) bad++;
};

console.log("\n── the page itself ──");
check("it opens without throwing", errors.length === 0, errors[0] || "");
const shown = await page.evaluate(() => (document.querySelector("#capabilities")?.innerText || "").replace(/\s+/g, " "));
check("it reports what the browser has", /WebGL/.test(shown), shown);

/* This desktop Chromium has no WebXR device. Saying "immersive VR: yes" here
   would be the page telling somebody what they want to hear. */
const verdict = await page.evaluate(() => {
  const rows = [...document.querySelectorAll("#capabilities dt")];
  const vr = rows.find((dt) => /immersive vr/i.test(dt.textContent));
  return {
    vr: vr ? vr.nextElementSibling.textContent.trim() : null,
    button: document.querySelector("#enter")?.textContent.trim(),
    disabled: document.querySelector("#enter")?.disabled,
  };
});
check("with no headset it does not claim immersive VR",
  verdict.vr !== "yes", `reported: ${verdict.vr}`);
check("and the button says so rather than failing on press",
  verdict.disabled === true && /not offered|no WebXR/i.test(verdict.button || ""), verdict.button || "");

console.log("\n── which way round the sphere is ──");
/* Read the pattern back through the same shader the headset will use. Looking
   forward must land on FRONT, turning right on RIGHT, up on the ceiling. A
   mapping that is mirrored puts LEFT where RIGHT belongs and nothing on a
   laptop screen would give that away. */
await page.evaluate(() => document.querySelector("#flat").click());
await page.waitForTimeout(400);

const sample = async (yaw, pitch) => page.evaluate(async ([y, p]) => {
  const canvas = document.querySelector("#stage");
  window.__vrCheckLook(y, p);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const read = document.createElement("canvas");
  read.width = 1; read.height = 1;
  read.getContext("2d").drawImage(canvas, canvas.width / 2, canvas.height / 2, 1, 1, 0, 0, 1, 1);
  const [r, g, b] = read.getContext("2d").getImageData(0, 0, 1, 1).data;
  return { r, g, b };
}, [yaw, pitch]);

const near = (got, want, slack = 46) =>
  Math.abs(got.r - want[0]) < slack && Math.abs(got.g - want[1]) < slack && Math.abs(got.b - want[2]) < slack;

const FRONT = [0x1d, 0x6a, 0x8a];
const RIGHT = [0x7a, 0x53, 0x20];
const BEHIND = [0x6a, 0x24, 0x40];
const LEFT = [0x2c, 0x6a, 0x44];
const CEILING = [0xdf, 0xe9, 0xee];
const FLOOR = [0x08, 0x13, 0x1c];

/* A little below the horizon: clear of the horizon line and of the labels, and
   still squarely on the wall being named. */
const EYE = -0.25;
const ahead = await sample(0, EYE);
check("looking ahead is the front wall", near(ahead, FRONT), JSON.stringify(ahead));

/* Yaw increasing turns to the right. Getting the left wall here would mean the
   sphere is mirrored — which looks entirely normal on a flat screen and is
   unmistakable the moment somebody turns their head inside it. */
const right = await sample(Math.PI / 2, EYE);
check("turning right is the right wall, not the left one",
  near(right, RIGHT), `${JSON.stringify(right)} — left would be ${LEFT}`);

const behind = await sample(Math.PI, EYE);
check("turning all the way round is the wall behind", near(behind, BEHIND), JSON.stringify(behind));

const left = await sample(-Math.PI / 2, EYE);
check("and the other way is the left wall", near(left, LEFT), JSON.stringify(left));

const up = await sample(0, 1.4);
check("looking up is the ceiling, not the floor",
  near(up, CEILING), `${JSON.stringify(up)} — floor would be ${FLOOR}`);

const down = await sample(0, -1.4);
check("looking down is the floor", near(down, FLOOR), JSON.stringify(down));

await browser.close(); server.close();
console.log(bad ? `\n${bad} FAILURES` : "\nALL OK");
process.exit(bad ? 1 : 0);
