/* Signing in from a phone.
 *
 * Reported from a phone with a screenshot: the sign-in card filled the
 * screen, the password field sat on the bottom edge, and nothing below it
 * could be reached. It was never a login fault — the gate is a fixed pane
 * with the card centred in it, and a card taller than the screen has its
 * lower half outside a container that cannot scroll. The button was there,
 * drawn, and physically unreachable.
 *
 * A viewport the size of a phone is the only place this shows up, so the
 * check runs at one: every control on the card has to be reachable and
 * pressable, and the card has to admit it is taller than the screen by
 * scrolling rather than by hiding half of itself.
 */
import { chromium, devices } from "/opt/node22/lib/node_modules/playwright/index.mjs";
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

let bad = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? `\n         ${detail}` : ""}`);
  if (!ok) bad++;
};

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox", "--no-proxy-server"],
});

/* The phone the report came from is an iPhone; the pane is the same on any
   screen shorter than the card. */
const phone = devices["iPhone 13"];
const context = await browser.newContext({ ...phone });
await context.route("**://*/**", (r) => (r.request().url().startsWith(base) ? r.continue() : r.abort()));
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
await page.goto(`${base}/studio/`, { waitUntil: "networkidle" });
await page.waitForTimeout(600);

console.log("── the way in, on a phone ──");
await page.evaluate(() => document.getElementById("simple-team-sign-in")?.click());
await page.waitForTimeout(300);

const gate = await page.evaluate(() => {
  const pane = document.getElementById("prototype-gate");
  const card = pane?.querySelector(".gate-card");
  return {
    shown: pane?.hidden === false,
    paneHeight: pane?.clientHeight || 0,
    cardHeight: card?.scrollHeight || 0,
    /* The pane's own overflow, not the document's: a fixed pane whose
       content spills is not a pane anybody can scroll, and measuring
       scrollHeight alone passes in exactly the broken case. */
    scrolls: pane ? ["auto", "scroll"].includes(getComputedStyle(pane).overflowY) : false,
  };
});
check("the sign-in card is open", gate.shown === true);
/* If the card ever fits, this test proves nothing — say so rather than
   passing quietly. */
check("and on this screen it really is taller than the view",
  gate.cardHeight > gate.paneHeight,
  `card ${gate.cardHeight}px in a ${gate.paneHeight}px pane`);
check("so the pane itself scrolls rather than spilling out of view",
  gate.scrolls === true,
  gate.scrolls ? "" : "a fixed pane with no overflow: whatever does not fit is unreachable");

/* Every control on the card, one at a time: scrolled to, on screen, and
   pressable where it lands. */
const controls = [
  ["Continue with Google", "#continue-google"],
  ["the email field", "#auth-email"],
  ["the password field", "#auth-password"],
  ["Sign in securely", "#enter-studio"],
  ["Email me a magic link", "#send-magic-link"],
  ["Forgot password?", "#forgot-password"],
];
for (const [name, selector] of controls) {
  const reach = await page.evaluate((target) => {
    const node = document.querySelector(target);
    if (!node) return { found: false };
    node.scrollIntoView({ block: "center" });
    const box = node.getBoundingClientRect();
    const middle = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    const onScreen = box.top >= 0 && box.bottom <= window.innerHeight
      && box.left >= 0 && box.right <= window.innerWidth;
    /* What the finger would actually land on at that point. */
    const hit = document.elementFromPoint(middle.x, middle.y);
    return {
      found: true,
      onScreen,
      itself: Boolean(hit && (hit === node || node.contains(hit) || hit.contains(node))),
      top: Math.round(box.top),
      bottom: Math.round(box.bottom),
    };
  }, selector);
  check(`${name} can be reached and pressed`,
    reach.found && reach.onScreen && reach.itself,
    JSON.stringify(reach));
}

/* And the press actually reaches the code behind it. */
const pressed = await page.evaluate(async () => {
  const button = document.getElementById("send-magic-link");
  button.scrollIntoView({ block: "center" });
  const box = button.getBoundingClientRect();
  const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
  hit.click();
  await new Promise((r) => setTimeout(r, 250));
  return document.getElementById("auth-message")?.textContent || "";
});
check("and pressing one answers, rather than doing nothing",
  pressed.trim().length > 0 && !/connection ready/i.test(pressed), pressed);

check("nothing threw", errors.length === 0, errors[0] || "");

await browser.close(); server.close();
console.log(bad ? `\n${bad} FAILURES` : "\nALL OK");
process.exit(bad ? 1 : 0);
