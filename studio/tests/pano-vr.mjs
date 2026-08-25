/* The immersive control on the real viewer.
 *
 * The headset probe proved that visionOS Safari opens an immersive session and
 * that the sphere is mapped the right way round. This is the same thing on the
 * viewer that shows actual captures, and there are only two ways it can be
 * wrong in a way nobody notices until somebody is wearing the headset:
 *
 *   - the button appears on a browser that cannot do it, and does nothing when
 *     pressed;
 *   - the immersive path samples the sphere differently from the flat one, so
 *     the laptop looks perfect and the headset has the ceiling underfoot.
 *
 * The second is checked by comparing the two shaders rather than by trusting
 * that they were written to agree.
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

console.log("\n── the two shaders have to agree ──");
const source = fs.readFileSync("studio/pano360.js", "utf8");
/* The last two lines of each shader are the convention that decides which way
   round the sphere is. Two copies that drift apart is the exact failure that
   looks fine everywhere except inside a headset. */
const sampling = [...source.matchAll(
  /float u = atan\(dir\.x, -dir\.z\) \/ \(2\.0 \* PI\) \+ 0\.5;\s*\n\s*float v = acos\(clamp\(dir\.y, -1\.0, 1\.0\)\) \/ PI;/g,
)];
check("both shaders sample the sphere the same way", sampling.length === 2,
  `${sampling.length} copies of the mapping — expected one flat, one immersive`);
check("neither flips the texture upload", !/UNPACK_FLIP_Y_WEBGL, true/.test(source));

console.log("\n── on a browser with no headset ──");
const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox", "--no-proxy-server", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});
const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
await context.route("**://*/**", (r) => (r.request().url().startsWith(base) ? r.continue() : r.abort()));
await context.addInitScript(`window.__seed = ${JSON.stringify({ rows })};`);
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

const opened = await page.evaluate(async () => {
  const step = document.querySelector('[data-focus-step="results"]');
  if (step) step.click();
  await new Promise((r) => setTimeout(r, 400));
  const open = [...document.querySelectorAll("button")]
    .find((b) => /open 360 view/i.test(b.textContent || "") && b.offsetParent !== null);
  if (!open) return false;
  open.click();
  await new Promise((r) => setTimeout(r, 1200));
  return document.querySelector(".pano-overlay")?.hidden === false;
});
check("the 360 viewer opens", opened === true);
check("without throwing", errors.length === 0, errors[0] || "");

const control = await page.evaluate(() => {
  const b = document.querySelector("[data-pano-vr]");
  return b ? { there: true, hidden: b.hidden, text: b.textContent.trim() } : { there: false };
});
check("the immersive control exists in the viewer", control.there === true);
/* Chromium here has no XR device. A button offering something the device
   cannot do is a button that does nothing when pressed. */
check("but stays hidden where the device cannot do it", control.hidden === true,
  `hidden: ${control.hidden}`);
check("and its label says what it does, not what it is",
  /stand in this room/i.test(control.text || ""), control.text || "");

await browser.close(); server.close();
console.log(bad ? `\n${bad} FAILURES` : "\nALL OK");
process.exit(bad ? 1 : 0);
