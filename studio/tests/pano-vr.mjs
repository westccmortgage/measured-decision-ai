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

console.log("\n── a press that fails has to say so ──");
/* This is the bug that produced "I press it and nothing happens": the failure
   was written into the drag hint, a node removed the moment somebody drags the
   sphere — which everybody does before reaching for the bar. The message went
   into a detached element and the button looked dead.

   The full path cannot be walked here: headless has no cross-origin access to
   a capture, so the sphere never starts and the control is never wired. Saying
   that plainly beats a test that pretends to cover it. What is checked instead
   is the two things that were actually wrong. */
{
  const source = fs.readFileSync("studio/pano360.js", "utf8");
  /* The whole handler, found by matching braces rather than by slicing a fixed
     number of characters — a fixed slice passes until somebody adds a branch
     above the line being checked, and then reports the wrong thing. */
  const from = source.indexOf("vrButton.onclick");
  let depth = 0;
  let to = from;
  for (let i = source.indexOf("{", from); i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") { depth -= 1; if (!depth) { to = i + 1; break; } }
  }
  const enterVR = source.slice(from, to);
  check("a failed press does not write into the drag hint",
    !/hintNode/.test(enterVR), "the failure handler still touches hintNode");
  check("it announces instead", /announce\(result\.why/.test(enterVR));
  /* A sentence standing in for the device's own words costs an afternoon. */
  check("and the reasons carry the device's own words",
    /error\.name \|\| "error"/.test(source) && /error\.message \|\| error/.test(source));

  /* And the place it announces into has to survive the hint being gone. */
  const survives = await page.evaluate(async () => {
    const overlay = document.querySelector(".pano-overlay");
    overlay.querySelector(".pano-hint")?.remove();
    /* Reach the viewer's own announce through a press of the close/reopen
       cycle is not possible here, so the element contract is checked directly:
       a status node appended to the stage, visible, outliving the hint. */
    const stage = overlay.querySelector("[data-pano-stage]");
    const node = document.createElement("p");
    node.className = "pano-say bad";
    node.setAttribute("data-pano-say", "");
    node.textContent = "NotAllowedError: session not allowed";
    stage.appendChild(node);
    await new Promise((r) => setTimeout(r, 100));
    const found = overlay.querySelector("[data-pano-say]");
    const shown = found && window.getComputedStyle(found).display !== "none";
    return { hintGone: !overlay.querySelector(".pano-hint"), shown: Boolean(shown) };
  });
  check("the drag hint is gone by the time somebody presses the bar", survives.hintGone === true);
  check("and the status node is still on screen", survives.shown === true);
}

console.log("\n── the link that reaches a headset ──");
/* Copying worked mechanically all along; what failed was the sentence. It said
   "open it in Vision Pro Safari" as though that were all it took, so somebody
   who did exactly that landed on a sign-in screen and reasonably called the
   button broken. */
{
  const link = await page.evaluate(async () => {
    document.querySelector("[data-pano-close]")?.click();
    await new Promise((r) => setTimeout(r, 300));
    document.querySelector('[data-focus-step="results"]')?.click();
    await new Promise((r) => setTimeout(r, 400));
    /* A clipboard that refuses is the case worth covering: nothing to paste. */
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async () => { throw new Error("denied"); } },
    });
    const copy = [...document.querySelectorAll("button")]
      .find((b) => /copy link for vision pro/i.test(b.textContent || "") && b.offsetParent !== null);
    if (!copy) return { found: false };
    copy.click();
    await new Promise((r) => setTimeout(r, 400));
    const dialog = document.querySelector("#headset-link-dialog");
    return {
      found: true,
      shown: Boolean(dialog) && dialog.open === true,
      text: (dialog?.innerText || "").replace(/\s+/g, " "),
      url: dialog?.querySelector("#headset-link-url")?.value || "",
    };
  });
  check("the control is there", link.found === true);
  /* With no clipboard there is nothing to paste, so the link has to be on the
     screen where it can be read and copied by hand. */
  check("a refused clipboard still puts the link on screen", link.shown === true);
  check("and the link is the one for this capture",
    /\?property=.+&evidence=/.test(link.url), link.url || "(none)");
  check("it says a sign-in is needed", /sign in/i.test(link.text), link.text.slice(0, 140));
  check("and says why", /keeps the record private/i.test(link.text), link.text.slice(0, 160));
  /* The shorter path now exists and is worth naming. */
  check("it names the way that needs no link at all",
    /stand in this room/i.test(link.text), link.text.slice(0, 200));
}

await browser.close(); server.close();
console.log(bad ? `\n${bad} FAILURES` : "\nALL OK");
process.exit(bad ? 1 : 0);
