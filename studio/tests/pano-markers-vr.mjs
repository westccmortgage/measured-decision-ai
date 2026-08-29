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

  /* Drives exactly one frame, with the head pointed where the test says.
     The eyes carry real positions — half an interpupillary distance either
     side of the head, along the head's own right axis — because that offset
     is the whole mechanism by which a finite sphere reads as a near wall.
     `only` renders a single eye: the stand-in gives both the same viewport,
     so measuring what one eye sees means drawing one eye. */
  const IPD = 0.064;
  window.__xrFrame = (dir, only) => {
    if (!live || !live.queue.length) return { frames: 0 };
    const matrix = lookMatrix(dir);
    /* Column 0 of world→eye is the head's right axis in world terms. */
    const right = [matrix[0], matrix[4], matrix[8]];
    const at = (sign) => ({
      x: right[0] * sign * IPD / 2,
      y: right[1] * sign * IPD / 2,
      z: right[2] * sign * IPD / 2,
    });
    const eyes = [
      { eye: "left", projectionMatrix: perspective(), transform: { inverse: { matrix }, position: at(-1) } },
      { eye: "right", projectionMatrix: perspective(), transform: { inverse: { matrix }, position: at(1) } },
    ].filter((view) => !only || view.eye === only);
    const pose = { views: eyes, transform: { position: { x: 0, y: 0, z: 0 } } };
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

console.log("\n── how far the walls feel ──");
/* The verdict from the headset killed the first mechanism: warping angles
   around a centre made everything "round", and no centre was ever right.
   Distance is now delivered the way the eye actually reads it — the sphere
   sits at a finite radius and each eye sees it from its own position, so
   the two eyes disagree exactly as they would about a real near wall.
   Two things must therefore be true, and both are read off rendered pixels
   rather than reasoned about:
     · angles are untouched — the 40.08° band keeps its width at every
       setting (2·tan(20.04°)·256 ≈ 187 px in a 512-px square at 90° fov);
     · the eyes disagree — at 100% the capture is at infinity and both eyes
       see the band identically; at 30% the walls are 1.2 m away and the
       band sits about 14 px apart between the eyes. */
const scale = await page.evaluate(async () => {
  const control = document.querySelector("[data-pano-scale]");
  const input = document.querySelector("[data-pano-scale-input]");
  const value = document.querySelector("[data-pano-scale-value]");
  const surface = document.querySelector(".pano-overlay canvas");
  const gl = surface.getContext("webgl2") || surface.getContext("webgl");

  /* The sphere alone: at 30% the menu and pins crowd toward the centre and
     would land on the very band being measured. */
  window.__xrSetMarkers([]);

  /* Where the red band lands for one eye, in the row through the middle. */
  const band = (eye) => {
    window.__xrFrame([0, 0, -1], eye);
    const row = new Uint8Array(512 * 4);
    gl.readPixels(0, 256, 512, 1, gl.RGBA, gl.UNSIGNED_BYTE, row);
    let lo = -1; let hi = -1;
    for (let i = 0; i < 512; i += 1) {
      const r = row[i * 4]; const g = row[i * 4 + 1]; const b = row[i * 4 + 2];
      if (r > 150 && g < 110 && b < 110) { if (lo < 0) lo = i; hi = i; }
    }
    return lo < 0 ? null : { lo, hi, width: hi - lo + 1, centre: (lo + hi) / 2 };
  };
  const read = (size) => {
    if (size !== null) {
      input.value = String(size);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    const left = band("left");
    const rightEye = band("right");
    return {
      shown: value?.textContent,
      width: left?.width ?? 0,
      disparity: left && rightEye ? left.centre - rightEye.centre : null,
    };
  };

  const start = read(null);
  const close = read(30);
  const middle = read(50);
  const back = read(100);
  return {
    start, close, middle, back,
    hidden: control?.hidden,
    max: input?.max,
    min: input?.min,
    stored: window.localStorage.getItem("mdai.pano360.roomSize"),
  };
});
check("the control is on screen once a headset is offered", scale.hidden === false);
check("it starts at the capture as shot", scale.start.shown === "100%", scale.start.shown);
check("at 100% the room is drawn at true angular scale",
  Math.abs(scale.start.width - 187) <= 14, `${scale.start.width} px — expected about 187`);
/* The whole complaint about the first mechanism, made into a check: the
   capture's geometry must survive every setting untouched. */
check("and every setting keeps that geometry — nothing is warped",
  Math.abs(scale.close.width - scale.start.width) <= 3 && Math.abs(scale.middle.width - scale.start.width) <= 3,
  `30%: ${scale.close.width} px · 50%: ${scale.middle.width} px · 100%: ${scale.start.width} px`);
/* A monoscopic capture at infinity: both eyes see exactly the same thing,
   which is precisely why an untouched room reads too large. */
check("at 100% the two eyes agree — the capture sits at infinity",
  Math.abs(scale.start.disparity) <= 1, `disparity ${scale.start.disparity} px`);
check("the slider now stops at the capture as shot",
  scale.max === "100" && scale.min === "30", `${scale.min}–${scale.max}`);
/* The mechanism itself: closer walls mean the eyes disagree more. */
check("30% puts the walls close enough that the eyes disagree",
  scale.close.disparity >= 10 && scale.close.disparity <= 20,
  `disparity ${scale.close.disparity} px — expected about 14`);
check("and 50% disagrees less than 30%, as a farther wall must",
  scale.middle.disparity > 4 && scale.middle.disparity < scale.close.disparity,
  `50%: ${scale.middle.disparity} px against 30%: ${scale.close.disparity} px`);
check("coming back to 100% returns the capture untouched",
  Math.abs(scale.back.disparity) <= 1 && Math.abs(scale.back.width - scale.start.width) <= 2,
  `disparity ${scale.back.disparity} px, width ${scale.back.width} px`);
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

console.log("\n── the menu stays where it can be reached ──");
/* Reported from the headset: "the word Rooms is on the ceiling, and pinching
   does nothing". The chip was carried on the lazily-followed gaze, so looking
   towards it pushed it further away, and chasing it down collapsed the
   heading it was built from — it flipped overhead and could never be aimed
   at. It must sit in front, a glance below the eye line, and hold still the
   moment somebody turns towards it. */
const parked = await page.evaluate(() => {
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const ahead = [0, 0, -1];
  for (let i = 0; i < 40; i += 1) window.__xrFrame(ahead);
  const rest = window.__xrMenu();
  /* Look at the chip and keep looking: it must not drift away. */
  const aim = rest.chipDir.slice();
  for (let i = 0; i < 90; i += 1) window.__xrFrame(aim);
  const held = window.__xrMenu();
  /* Chase downwards, where the old code's heading collapsed. */
  for (let i = 0; i < 90; i += 1) window.__xrFrame([0, -0.97, -0.24]);
  const chased = window.__xrMenu();
  /* Turn right round: the menu should come back to where the person faces. */
  const behind = [0, 0, 1];
  for (let i = 0; i < 90; i += 1) window.__xrFrame(behind);
  const followed = window.__xrMenu();
  return {
    aheadDot: dot(rest.chipDir, ahead),
    restY: rest.chipDir[1],
    drift: dot(rest.chipDir, held.chipDir),
    lookingChip: held.lookingChip,
    chasedDot: dot(chased.chipDir, held.chipDir),
    behindDot: dot(followed.chipDir, behind),
  };
});
check("the chip sits in front of the person, a glance below the eye line",
  parked.aheadDot > 0.9 && parked.restY < -0.2 && parked.restY > -0.6,
  `dot with gaze ${parked.aheadDot.toFixed(3)}, height ${parked.restY.toFixed(3)}`);
check("looking straight at it lights it up",
  parked.lookingChip === true);
check("and it holds still instead of running from the eye",
  parked.drift > 0.999, `moved by ${(Math.acos(Math.min(1, parked.drift)) * 57.3).toFixed(2)}°`);
check("chasing it downwards never flips it overhead",
  parked.chasedDot > 0.999, `moved by ${(Math.acos(Math.min(1, parked.chasedDot)) * 57.3).toFixed(2)}°`);
check("but turning right round brings it back to where the person now faces",
  parked.behindDot > 0.9, `dot with the new facing ${parked.behindDot.toFixed(3)}`);

/* Direction maths agreeing with itself is not the same as a chip a person can
   see. This looks at the drawn frame: the chip's dark panel must be on screen,
   below the eye line and above the floor of the view. Before the fix this
   found nothing at all — the chip was outside the field entirely. */
const chipOnScreen = await page.evaluate(() => {
  const surface = document.querySelector(".pano-overlay canvas");
  const gl = surface.getContext("webgl2") || surface.getContext("webgl");
  for (let i = 0; i < 40; i += 1) window.__xrFrame([0, 0, -1]);
  const px = new Uint8Array(512 * 512 * 4);
  gl.readPixels(0, 0, 512, 512, gl.RGBA, gl.UNSIGNED_BYTE, px);
  let lowest = 1e9; let highest = -1; let count = 0;
  for (let row = 0; row < 512; row += 1) {
    for (let col = 0; col < 512; col += 1) {
      const i = (row * 512 + col) * 4;
      /* the chip's panel: dark navy, unlike the grey sphere or its red band */
      if (px[i] < 60 && px[i + 1] < 70 && px[i + 2] < 90) {
        count += 1;
        if (row < lowest) lowest = row;
        if (row > highest) highest = row;
      }
    }
  }
  return { count, lowest, highest };
});
check("and a person looking straight ahead can actually see it",
  chipOnScreen.count > 300 && chipOnScreen.highest < 256 && chipOnScreen.lowest > 40,
  `${chipOnScreen.count} px, rows ${chipOnScreen.lowest}-${chipOnScreen.highest} (256 is the eye line, 0 the floor of the view)`);

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
check("the Rooms chip waits just below the eye line, not on the floor or the ceiling",
  walked.closed?.items.length === 3 && walked.closed.open === false
    && walked.closed.chipDir[1] < -0.2 && walked.closed.chipDir[1] > -0.6,
  `${walked.closed?.items.length} items, chip y ${walked.closed?.chipDir[1].toFixed(3)} (want between -0.2 and -0.6)`);
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
/* The way back rides in the same menu as the rooms — asked for in exactly
   those words. Choosing it fires the same session-end path a system gesture
   does, so this covers both. */
const left = await page.evaluate(async () => {
  window.__xrFrame([0, 0, -1]);
  let menu = window.__xrMenu();
  window.__xrFrame(menu.chipDir);
  window.__xrSelect();
  window.__xrFrame(menu.chipDir);
  menu = window.__xrMenu();
  const exit = menu.items.find((item) => item.exit);
  if (exit) {
    window.__xrFrame(exit.dir);
    window.__xrSelect();
  }
  await new Promise((r) => setTimeout(r, 400));
  const button = document.querySelector("[data-pano-vr]");
  const canvas = document.querySelector(".pano-overlay canvas");
  const before = canvas?.width;
  await new Promise((r) => setTimeout(r, 300));
  return {
    hadExit: Boolean(exit),
    sessionDead: !window.__xrLive(),
    text: button?.textContent.trim(),
    flatAlive: Boolean(canvas),
    width: before,
  };
});
check("the menu carries the way back to the screen", left.hadExit === true);
check("choosing it ends the immersive session", left.sessionDead === true);
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
