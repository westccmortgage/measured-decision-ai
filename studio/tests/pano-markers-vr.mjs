/* Markers inside the room.
 *
 * A pin drawn on a flat pane in front of a headset is not a marker in a room;
 * it is a sticker on a window. What was asked for is a point that stands where
 * the thing is, that lights up when somebody looks at it, and that opens the
 * evidence when they choose it.
 *
 * None of that can be taken on trust from reading the code, because the whole
 * of it lives inside a frame loop that only runs when a device is driving it.
 * So a device drives it here: a stand-in XR session that hands back real view
 * matrices, one frame at a time, pointed wherever the test says. The shaders,
 * the gaze test and the select handler are the shipping ones.
 *
 * What this cannot prove is what the pins look like — pixels inside a headset
 * are the one thing a Linux box has no opinion about. That is said plainly
 * rather than dressed up as covered.
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

let bad = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? `\n         ${detail}` : ""}`);
  if (!ok) bad++;
};

/* ── what a source read can settle, settle by reading ────────────────────── */
console.log("\n── the two things a pin must never lose ──");
{
  const source = fs.readFileSync("studio/pano360.js", "utf8");
  /* Confirmed by a person and seen only by the AI are different things. A pin
     that renders them the same colour is the product rule broken in the one
     place nobody can check afterwards. */
  check("a pin is only green when a person confirmed it",
    /confirmed: marker\.state === "confirmed"/.test(source),
    "the room's list no longer derives confirmed from the reviewed state");
  check("and the ring reads that flag rather than guessing",
    /marker\.confirmed\s*\n?\s*\?/.test(source) || /marker\.confirmed$/m.test(source));
  /* Set before anybody reaches for the headset, which is when it is always
     set. Held inside the session, a marker placed on a laptop is simply not in
     the room. */
  check("the list outlives the session it is drawn in",
    /let headsetMarkers = \[\];/.test(source) && /markers: headsetMarkers,/.test(source));
}

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox", "--no-proxy-server", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});
const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
await context.route("**://*/**", (r) => (r.request().url().startsWith(base) ? r.continue() : r.abort()));

/* A stand-in for the headset. It answers the same calls the shipping code
   makes, and nothing else — anything it invents would be a test passing for a
   reason the real device never had. */
await context.addInitScript(() => {
  const perspective = () => {
    const near = 0.1; const far = 1000; const f = 1; // 90° vertical, square viewport
    return new Float32Array([
      f, 0, 0, 0,
      0, f, 0, 0,
      0, 0, (far + near) / (near - far), -1,
      0, 0, (2 * far * near) / (near - far), 0,
    ]);
  };

  /* World → eye, for a head pointing along `dir`. The shipping code reads the
     head direction back out of this as -row 2, so getting it wrong here would
     show up as every gaze test failing, not as a silent pass. */
  const lookMatrix = (dir) => {
    const norm = (v) => { const l = Math.hypot(...v) || 1; return v.map((x) => x / l); };
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const back = norm([-dir[0], -dir[1], -dir[2]]);
    let right = cross([0, 1, 0], back);
    if (Math.hypot(...right) < 1e-6) right = cross([1, 0, 0], back);
    right = norm(right);
    const up = cross(back, right);
    const cols = [right, up, back];
    const m = new Float32Array(16);
    for (let c = 0; c < 3; c += 1) for (let r = 0; r < 3; r += 1) m[c * 4 + r] = cols[r][c];
    m[15] = 1;
    return m;
  };

  class FakeSession extends EventTarget {
    constructor() { super(); this.renderState = {}; this.queue = []; this.ended = false; }
    updateRenderState(next) { Object.assign(this.renderState, next); }
    async requestReferenceSpace(kind) {
      if (kind !== "local-floor") throw new Error(`${kind} unavailable`);
      return { kind };
    }
    requestAnimationFrame(cb) { this.queue.push(cb); return this.queue.length; }
    async end() { this.ended = true; this.dispatchEvent(new Event("end")); }
  }

  window.XRWebGLLayer = class {
    constructor() { this.framebuffer = null; }
    /* Square, and small enough to sit inside the canvas, because the test
       reads a row of it back afterwards. */
    getViewport() { return { x: 0, y: 0, width: 512, height: 512 }; }
  };

  let live = null;
  Object.defineProperty(navigator, "xr", {
    configurable: true,
    value: {
      isSessionSupported: async (mode) => mode === "immersive-vr",
      requestSession: async () => { live = new FakeSession(); return live; },
    },
  });

  /* The context asks to be XR-compatible; without a device the real one
     rejects, and every run would land in the catch for the wrong reason. */
  for (const proto of [window.WebGL2RenderingContext, window.WebGLRenderingContext]) {
    if (proto) proto.prototype.makeXRCompatible = async function makeXRCompatible() { return undefined; };
  }

  /* Drives exactly one frame, with the head pointed where the test says. */
  window.__xrFrame = (dir) => {
    if (!live || !live.queue.length) return { frames: 0 };
    const matrix = lookMatrix(dir);
    const view = {
      eye: "left",
      projectionMatrix: perspective(),
      transform: { inverse: { matrix } },
    };
    const pose = { views: [view, { ...view, eye: "right" }] };
    const frame = { getViewerPose: () => pose };
    const cb = live.queue.shift();
    cb(performance.now(), frame);
    return { frames: 1, queued: live.queue.length };
  };
  window.__xrSelect = () => { live?.dispatchEvent(new Event("select")); };
  window.__xrEnd = () => live?.end();
  window.__xrLive = () => Boolean(live && !live.ended);
});

const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
await page.goto(`${base}/studio/`, { waitUntil: "networkidle" });
await page.waitForTimeout(700);

/* An equirectangular still, made here so the sphere has something real to
   sample and the test needs no capture it does not own. */
const opened = await page.evaluate(async () => {
  const canvas = document.createElement("canvas");
  canvas.width = 1024; canvas.height = 512;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#808080"; ctx.fillRect(0, 0, 1024, 512);
  /* A band of known angular width, dead ahead: 114 of 1024 columns is 40.08°,
     so how wide it lands on screen is a number with a right answer rather than
     an impression. */
  ctx.fillStyle = "#d02010"; ctx.fillRect(455, 0, 114, 512);
  const src = canvas.toDataURL("image/png");

  window.MDAIPano360.open({
    src,
    mediaType: "image/png",
    spatial: true,
    title: "Family Room",
    subtitle: "test capture",
    markers: [
      { id: "mk-ahead", u: 0.5, v: 0.5, label: "Water stain on ceiling", detail: "Water stain on ceiling", state: "confirmed", origin: "ai", requests: [] },
      { id: "mk-left", u: 0.25, v: 0.5, label: "Cracked drywall", detail: "Cracked drywall", state: "observed", origin: "ai", requests: [] },
      /* A marker with no place on the sphere. It has to be dropped, not
         drawn at (0,0,0) where every gaze would land on it. */
      { id: "mk-nowhere", u: null, v: 0.5, label: "No anchor", detail: "No anchor", state: "observed", origin: "ai", requests: [] },
    ],
    evidenceId: "ev-test",
    canReviewMarkers: true,
    onMarkerReview: () => {},
    /* Two rooms, so the headset offers the walk between them. Choosing the
       other one swaps in a solid blue frame — a colour the test can read
       back to prove the sphere really changed rooms mid-session. */
    rooms: [
      { id: "room-a", title: "Family Room", current: true },
      { id: "room-b", title: "Dining Room" },
    ],
    onRoomChosen: (id) => {
      window.__roomChosen = id;
      const blue = document.createElement("canvas");
      blue.width = 64; blue.height = 32;
      const paint = blue.getContext("2d");
      paint.fillStyle = "#2040d0"; paint.fillRect(0, 0, 64, 32);
      window.MDAIPano360.swapRoom({
        src: blue.toDataURL("image/png"),
        mediaType: "image/png",
        title: "Dining Room",
        subtitle: "test capture",
        markers: [],
        rooms: [
          { id: "room-a", title: "Family Room" },
          { id: "room-b", title: "Dining Room", current: true },
        ],
      });
    },
  });
  await new Promise((r) => setTimeout(r, 1500));
  const overlay = document.querySelector(".pano-overlay");
  return {
    shown: overlay?.hidden === false,
    canvas: Boolean(overlay?.querySelector("canvas")),
    pins: overlay?.querySelectorAll(".pano-markers > *").length || 0,
  };
});
check("the 360 viewer opens on a capture it can sample", opened.shown === true);
check("the sphere started", opened.canvas === true);
check("and the pins are on the flat pane too", opened.pins >= 2, `${opened.pins} pins`);

console.log("\n── standing in the room ──");
const entered = await page.evaluate(async () => {
  const button = document.querySelector("[data-pano-vr]");
  const before = { hidden: button?.hidden, text: button?.textContent.trim() };
  button?.click();
  await new Promise((r) => setTimeout(r, 400));
  const stepped = window.__xrFrame([0, 0, -1]);
  await new Promise((r) => setTimeout(r, 700));
  return {
    before,
    live: window.__xrLive(),
    stepped,
    text: button?.textContent.trim(),
    say: document.querySelector("[data-pano-say]")?.textContent.trim() || "",
  };
});
check("the control is offered when the device says yes", entered.before.hidden === false);
check("pressing it opens a session", entered.live === true);
check("and the shipping frame loop runs on the device's own matrices",
  entered.stepped.frames === 1, JSON.stringify(entered.stepped));
check("the button now offers the way out", /leave the room/i.test(entered.text || ""), entered.text);
check("and it says what is running", /2 views \(stereo\)/i.test(entered.say), entered.say || "(nothing said)");
check("nothing threw on the way in", errors.length === 0, errors[0] || "");

console.log("\n── looking at a pin and choosing it ──");
/* Straight ahead is where mk-ahead was placed. The direction is not asserted
   from the viewer's own maths — it is the one anybody can name. */
const chosen = await page.evaluate(async () => {
  const cardText = () => document.querySelector(".pano-card")?.innerText.replace(/\s+/g, " ") || "";
  const out = {};
  document.querySelector("[data-marker-close]")?.click();

  window.__xrFrame([0, 0, -1]);
  window.__xrSelect();
  await new Promise((r) => setTimeout(r, 250));
  out.ahead = cardText();

  document.querySelector("[data-marker-close]")?.click();
  await new Promise((r) => setTimeout(r, 150));

  /* u = 0.25 is a quarter turn to the left of straight ahead: -x. */
  window.__xrFrame([-1, 0, 0]);
  window.__xrSelect();
  await new Promise((r) => setTimeout(r, 250));
  out.left = cardText();

  document.querySelector("[data-marker-close]")?.click();
  await new Promise((r) => setTimeout(r, 150));

  /* Straight up, where nothing was placed. */
  window.__xrFrame([0, 1, 0]);
  window.__xrSelect();
  await new Promise((r) => setTimeout(r, 250));
  out.sky = cardText();

  /* Five degrees off the ceiling pin. A person turning their head is never
     dead on, and a pin that only answers when they are is a pin nobody can
     press. */
  const off = (deg) => [Math.sin((deg * Math.PI) / 180), 0, -Math.cos((deg * Math.PI) / 180)];
  window.__xrFrame(off(5));
  window.__xrSelect();
  await new Promise((r) => setTimeout(r, 250));
  out.almost = cardText();

  document.querySelector("[data-marker-close]")?.click();
  await new Promise((r) => setTimeout(r, 150));

  /* Twelve degrees off is past what the gaze test allows, so nothing. */
  window.__xrFrame(off(12));
  window.__xrSelect();
  await new Promise((r) => setTimeout(r, 250));
  out.near = cardText();
  return out;
});
check("looking at the ceiling pin and choosing opens that pin",
  /water stain on ceiling/i.test(chosen.ahead), chosen.ahead.slice(0, 120) || "(no card)");
check("turning left and choosing opens the other one",
  /cracked drywall/i.test(chosen.left), chosen.left.slice(0, 120) || "(no card)");
check("choosing while looking at nothing opens nothing",
  chosen.sky === "", chosen.sky.slice(0, 120));
check("five degrees off still counts as looking at it",
  /water stain on ceiling/i.test(chosen.almost), chosen.almost.slice(0, 120) || "(no card)");
/* The failure this guards against is a pin that lights up wherever the head
   turns, because "nearest" with no threshold always has a winner. */
check("but twelve degrees off does not",
  chosen.near === "", chosen.near.slice(0, 120));

console.log("\n── how large the room reads ──");
/* The report was "the room is very big — maybe 50% of it". A control that
   answers that has to make the room SMALLER when the number goes down, which
   means fitting MORE of the sphere into the same view. It is exactly the kind
   of thing that reads correctly in code and turns out inverted on the head, so
   it is measured off the rendered pixels rather than reasoned about: the band
   is 40.08° wide, and at a 90° field of view in a 512-pixel square its width on
   screen has one right answer.
     100% →  2·tan(20.04°)·256 ≈ 187 px
      60% →  2·tan(12.02°)·256 ≈ 109 px   (a smaller room: less of it fills the view)
      30% →  2·tan(6.012°)·256 ≈ 54 px    (the new floor: an outlet stops reading head-sized)
     160% →  2·tan(32.06°)·256 ≈ 321 px   (a larger room) */
const scale = await page.evaluate(async () => {
  const control = document.querySelector("[data-pano-scale]");
  const input = document.querySelector("[data-pano-scale-input]");
  const value = document.querySelector("[data-pano-scale-value]");
  const surface = document.querySelector(".pano-overlay canvas");
  const gl = surface.getContext("webgl2") || surface.getContext("webgl");

  /* This section measures the sphere, and only the sphere. The pin that
     stands dead ahead is correct behaviour — but at 30% the whole room
     crowds toward the centre and its ring lands on the very band being
     measured, on a frame that depends on where the lazy anchor happens to
     be. Cleared here so the width read is the band's and nobody else's. */
  window.__xrSetMarkers([]);

  /* How wide the band lands, straight ahead, in the row through the middle of
     the eye's viewport. Read back from the drawing buffer in the same task the
     frame was drawn in, before anything is presented. */
  const bandWidth = () => {
    window.__xrFrame([0, 0, -1]);
    const row = new Uint8Array(512 * 4);
    gl.readPixels(0, 256, 512, 1, gl.RGBA, gl.UNSIGNED_BYTE, row);
    let lo = -1; let hi = -1;
    for (let i = 0; i < 512; i += 1) {
      const r = row[i * 4]; const g = row[i * 4 + 1]; const b = row[i * 4 + 2];
      if (r > 150 && g < 110 && b < 110) { if (lo < 0) lo = i; hi = i; }
    }
    return lo < 0 ? 0 : hi - lo + 1;
  };

  const set = (size) => {
    input.value = String(size);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return { shown: value?.textContent, width: bandWidth() };
  };

  const start = { hidden: control?.hidden, shown: value?.textContent, width: bandWidth() };
  const smaller = set(60);
  const smallest = set(30);
  const larger = set(160);
  const back = set(100);
  return {
    start, smaller, smallest, larger, back,
    min: input?.min,
    stored: window.localStorage.getItem("mdai.pano360.roomSize"),
  };
});
check("the control is on screen once a headset is offered", scale.start.hidden === false);
check("it starts at the capture's own scale", scale.start.shown === "100%", scale.start.shown);
check("at 100% the room is drawn at true angular scale",
  Math.abs(scale.start.width - 187) <= 14, `${scale.start.width} px — expected about 187`);
check("moving it says where it is now", scale.smaller.shown === "60%", scale.smaller.shown);
/* The whole point of the control, and the half of it that can be silently
   backwards. */
check("60% makes the room smaller, not larger",
  scale.smaller.width < scale.start.width,
  `60% drew ${scale.smaller.width} px against ${scale.start.width} px at 100%`);
check("and by the amount the number promises",
  Math.abs(scale.smaller.width - 109) <= 14, `${scale.smaller.width} px — expected about 109`);
/* The old floor. A person in a real room reported that even at 60% an outlet
   still read the size of a head — the control has to keep going. */
check("the slider reaches 30%", scale.min === "30", String(scale.min));
check("30% shrinks the room to half of what 60% offered",
  scale.smallest.shown === "30%" && Math.abs(scale.smallest.width - 54) <= 10,
  `${scale.smallest.width} px — expected about 54`);
check("160% makes it larger",
  scale.larger.width > scale.start.width,
  `160% drew ${scale.larger.width} px against ${scale.start.width} px at 100%`);
check("and by the amount that number promises",
  Math.abs(scale.larger.width - 321) <= 16, `${scale.larger.width} px — expected about 321`);
check("and coming back to 100% returns the capture untouched",
  Math.abs(scale.back.width - scale.start.width) <= 2,
  `${scale.back.width} px against ${scale.start.width} px`);
/* Somebody who has settled how a room should read should not settle it again
   every time they open one. */
check("and the setting is remembered for next time", Number(scale.stored) === 100, String(scale.stored));

console.log("\n── the room holds still while the head turns ──");
/* The report from the headset: the room did not stay, it flowed after the
   head. The size remap's centre was the gaze itself, so every turn dragged
   the warp field along. The centre now follows through a slow filter:
   one quick turn must leave it almost untouched, a settled gaze must
   re-centre it within a few seconds. */
const anchored = await page.evaluate(() => {
  const turned = [0.5, 0, -Math.sqrt(0.75)]; // 30 degrees to the right
  window.__xrFrame([0, 0, -1]);
  const start = window.__xrAnchor().slice();
  window.__xrFrame(turned);
  const afterOneFrame = window.__xrAnchor().slice();
  for (let i = 0; i < 400; i += 1) window.__xrFrame(turned);
  const settled = window.__xrAnchor().slice();
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return { stayed: dot(afterOneFrame, start), settled: dot(settled, turned) };
});
check("one quick turn leaves the room's centre where it was",
  anchored.stayed > 0.995, `dot with the pre-turn centre: ${anchored.stayed.toFixed(5)}`);
check("and a settled gaze re-centres it within moments",
  anchored.settled > 0.99, `dot with the new gaze: ${anchored.settled.toFixed(5)}`);

console.log("\n── walking to another room without leaving the headset ──");
/* The ask, verbatim: a menu inside the goggles, so moving to any other
   captured room never requires taking them off. A chip waits below the
   horizon; looking at it and pinching opens the list; choosing a room
   reloads the sphere in place — the XR session never ends. */
const walked = await page.evaluate(async () => {
  const surface = document.querySelector(".pano-overlay canvas");
  const gl = surface.getContext("webgl2") || surface.getContext("webgl");
  const centre = () => {
    const px = new Uint8Array(4);
    gl.readPixels(256, 256, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return [px[0], px[1], px[2]];
  };
  const out = {};
  window.__xrFrame([0, 0, -1]);
  out.closed = window.__xrMenu();
  /* Look at the chip and pinch. */
  window.__xrFrame(out.closed.chipDir);
  window.__xrSelect();
  window.__xrFrame(out.closed.chipDir);
  out.opened = window.__xrMenu();
  /* Look at the other room and pinch. */
  const target = out.opened.items.find((item) => item.id === "room-b");
  if (!target) return out;
  window.__xrFrame(target.dir);
  out.lit = window.__xrMenu().lookingItem;
  window.__xrSelect();
  out.chosen = window.__roomChosen || null;
  /* The swap loads a data-URL image; give it a beat, then look ahead. */
  await new Promise((resolve) => setTimeout(resolve, 700));
  window.__xrFrame([0, 0, -1]);
  out.centreAfter = centre();
  out.after = window.__xrMenu();
  out.sessionAlive = window.__xrLive();
  return out;
});
check("the Rooms chip waits below the horizon with the list closed",
  walked.closed?.items.length === 2 && walked.closed.open === false && walked.closed.chipDir[1] < -0.5);
check("looking at it and pinching opens the list",
  walked.opened?.open === true, JSON.stringify(walked.opened));
check("looking at a room lights that room and no other",
  walked.lit === "room-b", String(walked.lit));
check("pinching it asks for exactly that room",
  walked.chosen === "room-b", String(walked.chosen));
check("and the sphere is now the other room — blue, mid-session",
  Array.isArray(walked.centreAfter) && walked.centreAfter[2] > 140 && walked.centreAfter[0] < 100,
  `centre pixel ${String(walked.centreAfter)}`);
check("the list closed itself and the new room is marked current",
  walked.after?.open === false && walked.after.items.find((item) => item.id === "room-b")?.current === true);
check("and the XR session never ended", walked.sessionAlive === true);

console.log("\n── taking the headset off ──");
const left = await page.evaluate(async () => {
  await window.__xrEnd();
  await new Promise((r) => setTimeout(r, 400));
  const button = document.querySelector("[data-pano-vr]");
  const canvas = document.querySelector(".pano-overlay canvas");
  const before = canvas?.width;
  await new Promise((r) => setTimeout(r, 300));
  return { text: button?.textContent.trim(), flatAlive: Boolean(canvas), width: before };
});
check("the button offers the way back in", /stand in this room/i.test(left.text || ""), left.text);
check("and the flat viewer is there rather than a black rectangle",
  left.flatAlive === true && left.width > 0, `canvas ${left.width}px`);

console.log("\n── closing the evidence ──");
const closed = await page.evaluate(async () => {
  document.querySelector("[data-pano-close]")?.click();
  await new Promise((r) => setTimeout(r, 300));
  return {
    vr: document.querySelector("[data-pano-vr]")?.hidden,
    scale: document.querySelector("[data-pano-scale]")?.hidden,
  };
});
/* Two controls belonging to a sphere that no longer exists are two buttons
   that do nothing when pressed, which is the complaint this all began with. */
check("the immersive control goes with the sphere", closed.vr === true);
check("so does the room size", closed.scale === true);
check("and nothing threw across the whole cycle", errors.length === 0, errors.join(" | "));

await browser.close(); server.close();
console.log(bad ? `\n${bad} FAILURES` : "\nALL OK");
process.exit(bad ? 1 : 0);
