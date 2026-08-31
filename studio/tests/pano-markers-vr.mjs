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
  /* `cant` turns each eye outward by that many radians, the way real headset
     lenses are angled. Aim taken from one eye alone is then wrong by that
     much — which is why the shipping code averages the two. */
  const turnFlat = (dir, radians) => {
    const c = Math.cos(radians); const sn = Math.sin(radians);
    return [dir[0] * c + dir[2] * sn, dir[1], dir[2] * c - dir[0] * sn];
  };
  /* Where the head is standing, so a panel that claims to stand in the room
     can be walked around. Without this the stand-in reported one position
     for ever, and "it stays where you left it" was untestable. */
  window.__xrStandAt = (x, y, z) => { window.__xrWhere = { x, y, z }; };
  window.__xrFrame = (dir, only, cant = 0) => {
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
      { eye: "left", projectionMatrix: perspective(), transform: { inverse: { matrix: cant ? lookMatrix(turnFlat(dir, -cant)) : matrix }, position: at(-1) } },
      { eye: "right", projectionMatrix: perspective(), transform: { inverse: { matrix: cant ? lookMatrix(turnFlat(dir, cant)) : matrix }, position: at(1) } },
    ].filter((view) => !only || view.eye === only);
    const pose = { views: eyes, transform: { position: window.__xrWhere || { x: 0, y: 0, z: 0 } } };
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
      /* Each room swaps in a flat colour of its own, so which room the
         sphere is actually showing is a pixel the test can read back — in
         both directions, not just away from home. */
      const board = document.createElement("canvas");
      board.width = 64; board.height = 32;
      const paint = board.getContext("2d");
      paint.fillStyle = id === "room-b" ? "#2040d0" : "#20a050";
      paint.fillRect(0, 0, 64, 32);
      window.MDAIPano360.swapRoom({
        src: board.toDataURL("image/png"),
        mediaType: "image/png",
        title: id === "room-b" ? "Dining Room" : "Family Room",
        subtitle: "test capture",
        markers: [],
        rooms: [
          { id: "room-a", title: "Family Room", current: id === "room-a" },
          { id: "room-b", title: "Dining Room", current: id === "room-b" },
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
  const run = (dir, frames) => { for (let i = 0; i < frames; i += 1) window.__xrFrame(dir); };
  run(ahead, 30);
  const rest = window.__xrMenu();
  /* Look at the chip briefly: it must not drift away. Kept well short of
     the dwell time, which this section is not about. */
  const aim = rest.chipDir.slice();
  run(aim, 30);
  const held = window.__xrMenu();
  /* Chase downwards, where the old code's heading collapsed. */
  run([0, -0.97, -0.24], 30);
  const chased = window.__xrMenu();
  /* An ordinary look around the room — a quarter turn — must leave the menu
     exactly where it was left. It used to jump in front of the eyes every
     fifty degrees, which in the headset read as "however you move your head
     it runs with you". */
  run([1, 0, 0], 30);
  const glanced = window.__xrMenu();
  /* Turn right round: only then does it come back to where the person faces. */
  const behind = [0, 0, 1];
  run(behind, 30);
  const followed = window.__xrMenu();
  return {
    aheadDot: dot(rest.chipDir, ahead),
    restY: rest.chipDir[1],
    drift: dot(rest.chipDir, held.chipDir),
    lookingChip: held.lookingChip,
    chasedDot: dot(chased.chipDir, held.chipDir),
    glancedDot: dot(glanced.chipDir, held.chipDir),
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
check("a quarter turn to look around leaves it exactly where it was left",
  parked.glancedDot > 0.999, `moved by ${(Math.acos(Math.min(1, parked.glancedDot)) * 57.3).toFixed(2)}°`);
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
      /* The dot by its cyan ring. Not by its dark centre: the reticle now
         carries a dark halo of its own, and a detector that cannot tell the
         aim from the thing being aimed at measures the wrong object. */
      if (px[i] < 180 && px[i + 1] > 180 && px[i + 2] > 200) {
        count += 1;
        if (row < lowest) lowest = row;
        if (row > highest) highest = row;
      }
    }
  }
  return { count, lowest, highest };
});
/* The aim has to be visible or aiming is not a gesture anybody can learn.
   The first reticle was under two degrees across and the headset reported
   the dot as unpressable — not because the test was wrong, but because
   nobody could see where they were pointing. */
const reticle = await page.evaluate(() => {
  const surface = document.querySelector(".pano-overlay canvas");
  const gl = surface.getContext("webgl2") || surface.getContext("webgl");
  for (let i = 0; i < 10; i += 1) window.__xrFrame([0, 0, -1]);
  const px = new Uint8Array(512 * 512 * 4);
  gl.readPixels(0, 0, 512, 512, gl.RGBA, gl.UNSIGNED_BYTE, px);
  /* The bright ring sits at the centre of the eye, over the grey sphere. */
  let bright = 0; let left = 512; let right = -1;
  for (let col = 0; col < 512; col += 1) {
    const i = (256 * 512 + col) * 4;
    if (px[i] > 200 && px[i + 1] > 200 && px[i + 2] > 200) { bright += 1; if (col < left) left = col; if (col > right) right = col; }
  }
  /* The very middle must be the room, not the mark: a sight with a filled
     centre is a target. */
  const middle = (256 * 512 + 256) * 4;
  const centrePixel = [px[middle], px[middle + 1], px[middle + 2]];
  const centreGap = !(px[middle] > 200 && px[middle + 1] > 200 && px[middle + 2] > 200);
  return { bright, span: right - left + 1, centrePixel, centreGap };
});
/* A sight, not a target. Drawn as the same ring the pins are, the one
   object that can never be pressed was the most button-like thing in the
   room — and it was pressed for four rounds by somebody following the
   instructions exactly. An open centre is what tells them apart. */
check("the aim is a sight, with nothing pressable at its centre",
  reticle.centreGap === true,
  `centre pixel ${String(reticle.centrePixel)} against the sphere`);
check("the reticle is big enough to steer by",
  reticle.bright >= 4 && reticle.span >= 10 && reticle.span <= 90,
  `${reticle.bright} bright px across ${reticle.span} of 512 in the centre row`);

check("and a person looking straight ahead can actually see it",
  chipOnScreen.count > 20 && chipOnScreen.highest < 256 && chipOnScreen.lowest > 40,
  `${chipOnScreen.count} px, rows ${chipOnScreen.lowest}-${chipOnScreen.highest} (256 is the eye line, 0 the floor of the view)`);
/* A dot, not a signboard: the closed menu must be a small thing in the
   room. The banner it replaced covered seventeen degrees of the view and
   was reported from the headset as annoying. */
check("and it is a dot rather than a banner across the room",
  chipOnScreen.count < 4000 && (chipOnScreen.highest - chipOnScreen.lowest) < 60,
  `${chipOnScreen.count} px spanning ${chipOnScreen.highest - chipOnScreen.lowest} rows`);

console.log("\n── aim survives the way headset lenses are angled ──");
/* Headset lenses are canted outward, so the left eye's forward is not the
   head's. Aim taken from that one view sits degrees off to the side of
   where the person is actually looking — a target stared straight at that
   never lights up. Averaging the eyes puts the aim back on the nose. */
const canted = await page.evaluate(() => {
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  /* Aimed at where the dot actually is, rather than at a vector copied from
     an earlier layout: a test that hard-codes geometry fails the day the
     geometry is corrected, and says nothing about the aim. */
  const aim = window.__xrMenu().chipDir.slice();
  const cant = 0.28; // sixteen degrees each way
  for (let i = 0; i < 10; i += 1) window.__xrFrame(aim, undefined, cant);
  const averaged = window.__xrForward();
  /* What one eye alone would have claimed, for the contrast. */
  const oneEye = [Math.sin(-cant) * -0.93, -0.37, Math.cos(-cant) * -0.93];
  const oneEyeLength = Math.hypot(...oneEye);
  return {
    trueAim: dot(averaged, aim) / (Math.hypot(...aim) || 1),
    oneEyeOff: Math.acos(Math.min(1, dot(oneEye, aim) / (oneEyeLength * Math.hypot(...aim)))) * 57.3,
    lookingChip: window.__xrMenu().lookingChip,
  };
});
check("aim lands on the nose, not on one lens",
  canted.trueAim > 0.999, `off by ${(Math.acos(Math.min(1, canted.trueAim)) * 57.3).toFixed(2)}° — one eye alone would be off by ${canted.oneEyeOff.toFixed(1)}°`);
check("so a dot stared straight at still lights up on a canted headset",
  canted.lookingChip === true);

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
  /* Two separate gestures, spaced the way a hand actually moves — the
     viewer collapses the burst one gesture makes, not two real presses. */
  await new Promise((resolve) => setTimeout(resolve, 250));
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

console.log("\n── a held look is the way in, with no gesture at all ──");
/* Twice from the headset: pinches never reach this page on that device —
   not for pins, not for the menu. A gaze needs no controller, no hand
   tracking and no permission, so holding a look must open and choose on
   its own. Not one select event is fired anywhere in this section. */
const gazed = await page.evaluate(async () => {
  const run = (dir, frames) => { for (let i = 0; i < frames; i += 1) window.__xrFrame(dir); };
  const out = {};
  /* Settle, then hold the look on the chip. */
  run([0, 0, -1], 30);
  const chip = window.__xrMenu().chipDir.slice();
  run(chip, 20);
  out.partway = window.__xrMenu().dwell;
  run(chip, 120);
  out.openedByGaze = window.__xrMenu().open;
  /* Holding on does not flicker it back closed. */
  run(chip, 120);
  out.stillOpen = window.__xrMenu().open;
  /* Now hold a look on the room we are not in, and walk back to it. */
  window.__roomChosen = null;
  const target = window.__xrMenu().items.find((item) => item.id === "room-a");
  run(target.dir, 220);
  out.chosen = window.__roomChosen || null;
  out.closedAfterChoosing = window.__xrMenu().open;
  await new Promise((resolve) => setTimeout(resolve, 700));
  window.__xrFrame([0, 0, -1]);
  const surface = document.querySelector(".pano-overlay canvas");
  const gl = surface.getContext("webgl2") || surface.getContext("webgl");
  const px = new Uint8Array(4);
  gl.readPixels(256, 256, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  out.centre = [px[0], px[1], px[2]];
  return out;
});
check("the bar fills while the look is held", gazed.partway > 0.1 && gazed.partway < 0.9,
  `filled to ${(gazed.partway * 100).toFixed(0)}% after a fifth of a second`);
check("holding a look on the chip opens the list — no pinch anywhere",
  gazed.openedByGaze === true);
check("and keeping the eyes there does not flicker it shut",
  gazed.stillOpen === true);
check("holding a look on a room walks into it",
  gazed.chosen === "room-a", String(gazed.chosen));
check("and the sphere really is that room now — green, the way back",
  gazed.centre[1] > 120 && gazed.centre[2] < 110, `centre pixel ${String(gazed.centre)}`);
check("and the list closes behind you", gazed.closedAfterChoosing === false);

console.log("\n── a pin answers inside the room ──");
/* Reported from the headset, twice: "click on the marker doesn't have any
   effect whatsoever". Two faults sat behind it, and the second is the one
   that made the first invisible:
     · the held look was computed over the room menu ONLY, so a pin could be
       opened by a select event and nothing else — and this device never
       sends one;
     · the answer was an HTML card. An immersive session draws its own layer
       and nothing else, so even a pin that DID open answered somewhere the
       person wearing the headset could not see.
   Not one select event is fired anywhere in this section. */
const pinned = await page.evaluate(async () => {
  const surface = document.querySelector(".pano-overlay canvas");
  const gl = surface.getContext("webgl2") || surface.getContext("webgl");
  const run = (dir, frames) => { for (let i = 0; i < frames; i += 1) window.__xrFrame(dir); };
  /* How much of the view is the near-black of a card face. The sphere
     fixture is bright, so this separates "a panel is drawn" from "a panel
     exists in a variable". */
  const cardPixels = () => {
    const px = new Uint8Array(512 * 512 * 4);
    gl.readPixels(0, 0, 512, 512, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let dark = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i] < 45 && px[i + 1] < 55 && px[i + 2] < 70) dark += 1;
    }
    return dark;
  };
  const out = {};
  window.__xrSetMarkers([
    { id: "pin-ahead", label: "Water stain on ceiling", u: 0.5, v: 0.5,
      confirmed: false, standing: "Seen by AI · not verified", detail: "Dark ring, roughly 300mm",
      source: "Capture of 12 August" },
    { id: "pin-left", label: "Cracked drywall", u: 0.25, v: 0.5, confirmed: false,
      standing: "Seen by AI · not verified", source: "Capture of 12 August" },
  ]);

  run([0, 0, -1], 4);
  out.beforeDark = cardPixels();
  out.beforePanel = window.__xrPanel();
  /* A fifth of a second of looking: aimed, not yet chosen. */
  run([0, 0, -1], 12);
  out.partway = window.__xrMenu().dwell;
  out.stillClosed = window.__xrPanel();
  /* Keep looking. Nothing else — no pinch, no trigger, no controller. */
  run([0, 0, -1], 40);
  run([0, 0, -1], 90);
  out.panel = window.__xrPanel();
  run([0, 0, -1], 4);
  out.afterDark = cardPixels();

  /* The way out of it, by the same held look. */
  const closeDir = out.panel ? out.panel.closeDir : [0, -1, 0];
  run(closeDir, 10);
  out.lookingClose = window.__xrPanel()?.lookingClose === true;
  run(closeDir, 130);
  out.closed = window.__xrPanel();
  run([0, 0, -1], 4);
  out.closedDark = cardPixels();

  /* A verdict is a person putting their name on a value. A stare is not
     that, and a headset that let one confirm a reading would launder
     provenance by accident. */
  run([0, 0, -1], 140);
  out.reopened = window.__xrPanel();
  run([0, 0, -1], 200);
  out.standingAfterStaring = window.__xrPanel()?.lines[0] || "";

  /* Put the room back the way the next section expects to find it: an open
     panel owns the gaze, and the way out of the headset lives in the menu it
     covers. A test that leaves its own state lying around fails the section
     after it and blames the product. */
  const closeAgain = window.__xrPanel()?.closeDir || [0, -1, 0];
  run(closeAgain, 140);
  out.tidied = window.__xrPanel();

  window.__xrSetMarkers([]);
  return out;
});
check("a pin is not open until somebody holds a look on it",
  pinned.beforePanel === null && pinned.stillClosed === null && pinned.partway > 0.05,
  `dwell filled to ${Math.round((pinned.partway || 0) * 100)}% part-way`);
check("holding a look on a pin opens it — no pinch, no trigger, nothing",
  pinned.panel?.markerId === "pin-ahead", JSON.stringify(pinned.panel?.markerId || null));
check("and what it opens is the evidence, not a dot",
  /not verified/i.test(pinned.panel?.lines[0] || "")
  && /Water stain on ceiling/.test(pinned.panel?.lines[1] || "")
  && pinned.panel?.lines.some((line) => /12 August/.test(line)),
  JSON.stringify(pinned.panel?.lines || []));
/* The fault that made the whole thing look dead: an answer rendered where
   the headset cannot show it. Pixels, not state. */
check("the answer is actually drawn where the person is standing",
  pinned.afterDark > pinned.beforeDark + 3000,
  `${pinned.beforeDark} dark px before, ${pinned.afterDark} after`);
check("its way out can be aimed at",
  pinned.lookingClose === true);
check("and a held look on that closes it",
  pinned.closed === null && pinned.closedDark < pinned.beforeDark + 3000,
  `${pinned.closedDark} dark px after closing`);
check("and the room is handed back with nothing left open",
  pinned.tidied === null);
check("staring at a reading never confirms it",
  pinned.reopened?.markerId === "pin-ahead" && /not verified/i.test(pinned.standingAfterStaring),
  pinned.standingAfterStaring || "(no standing)");

console.log("\n── the list opens where the dot was, and chooses nothing by itself ──");
/* Reported from the headset: the line of files only appears if you look
   almost at your own feet, sits in a very short stretch where it works at
   all, and then a file switches itself on while you are only looking at it.
   Three faults in the same geometry. */
const listed = await page.evaluate(async () => {
  const run = (dir, frames) => { for (let i = 0; i < frames; i += 1) window.__xrFrame(dir); };
  const out = {};
  window.__xrSetMarkers([]);
  run([0, 0, -1], 6);
  /* Start from a closed list, whatever an earlier section left behind. */
  if (window.__xrMenu().open) {
    const shut = window.__xrMenu().chipDir;
    run([0, 1, 0], 10);
    run(shut, 130);
  }
  run([0, 0, -1], 6);
  const rest = window.__xrMenu();
  out.startedClosed = window.__xrMenu().open === false;
  /* How far below the eye line a person must look to reach the dot. */
  out.chipPitch = Math.asin(-rest.chipDir[1]) * 57.3;

  run(rest.chipDir, 130);
  const open = window.__xrMenu();
  out.opened = open.open;
  /* A column: every row at one bearing off to the side, stepping down. */
  const yaw = (dir) => Math.atan2(dir[0], -dir[2]) * 57.3;
  out.itemPitches = open.items.map((item) => Math.round(Math.asin(-item.dir[1]) * 57.3));
  out.itemYaws = open.items.map((item) => Math.round(yaw(item.dir)));
  const pitches = out.itemPitches.slice().sort((a, b) => a - b);
  out.rowGap = pitches.length > 1 ? Math.round(pitches[1] - pitches[0]) : 0;
  out.columnYaw = Math.round(yaw(open.items[0].dir));
  /* And the dot that opened it is nowhere near any row. */
  out.dotClearOfRows = open.items.every((item) => {
    const dot = item.dir[0] * rest.chipDir[0] + item.dir[1] * rest.chipDir[1] + item.dir[2] * rest.chipDir[2];
    return Math.acos(Math.max(-1, Math.min(1, dot))) * 57.3 > 14;
  });

  /* No item may sit on the dot, or the two cannot be told apart and the
     list can only be left by choosing something out of it. */
  out.itemOnTheDot = open.items.some((item) => {
    const dot = item.dir[0] * rest.chipDir[0] + item.dir[1] * rest.chipDir[1] + item.dir[2] * rest.chipDir[2];
    return dot > Math.cos(0.20);
  });
  /* The trigger must not be live the instant the list appears. */
  const currentBefore = open.items.find((item) => item.current)?.id || null;
  out.roomBefore = currentBefore;
  run(rest.chipDir, 200);
  out.afterStaring = window.__xrMenu().open;
  out.roomUnchanged = (window.__xrMenu().items.find((item) => item.current)?.id || null) === currentBefore;

  /* A gaze SWEEPING across an entry is passing over it, not resting on it.
     Two degrees a frame is a slow, ordinary look around the room — and it
     used to be enough to choose a file on the way past. */
  run([0, 0, -1], 12);
  out.armedAfterLookingAway = window.__xrMenu().armed;
  const room = open.items.find((item) => item.current) || open.items.find((item) => !item.exit);
  const turnTowards = (target, fraction) => {
    const from = [0, 0, -1];
    const mixed = [
      from[0] + (target[0] - from[0]) * fraction,
      from[1] + (target[1] - from[1]) * fraction,
      from[2] + (target[2] - from[2]) * fraction,
    ];
    const length = Math.hypot(mixed[0], mixed[1], mixed[2]) || 1;
    return [mixed[0] / length, mixed[1] / length, mixed[2] / length];
  };
  /* Sweep on to it, over it, and off the other side, twice — far longer in
     total than a dwell takes, and never still. */
  for (let pass = 0; pass < 2; pass += 1) {
    for (let step = 0; step <= 60; step += 1) window.__xrFrame(turnTowards(room.dir, step / 40));
    for (let step = 60; step >= 0; step -= 1) window.__xrFrame(turnTowards(room.dir, step / 40));
  }
  out.sweptOpen = window.__xrMenu().open;
  out.sweptRoom = window.__xrMenu().items.find((item) => item.current)?.id || null;

  /* Now stop on it. That is choosing. */
  run(room.dir, 200);
  out.closedAfterChoosing = window.__xrMenu().open;
  return out;
});
check("the list starts down, so the dot is what opens it",
  listed.startedClosed === true);
check("the dot sits under the eye line, not down by the feet",
  listed.chipPitch > 6 && listed.chipPitch < 16, `${Math.round(listed.chipPitch)}° below the eye line`);
/* Asked for from the headset: a column off to the right, not a line the head
   has to sweep along. */
check("the list stands as a column to one side, not a line across the view",
  listed.opened === true
  && listed.itemYaws.every((bearing) => bearing === listed.columnYaw)
  && listed.columnYaw >= 20,
  `all rows at ${listed.columnYaw}° round, pitches ${listed.itemPitches.join(", ")}°`);
check("its rows are spaced far enough to tell one from the next",
  listed.rowGap >= 11, `${listed.rowGap}° between rows, each caught within 5.7°`);
check("and the dot that opened it is clear of every row",
  listed.dotClearOfRows === true);
/* The one that made the headset unusable: arriving somewhere is not
   choosing it. */
/* The two halves of "a file switched itself on while I was only looking":
   nothing sits where the gaze already is, and the trigger is not live at the
   moment the list appears. */
check("no item sits on the dot, so the list can always be left again",
  listed.itemOnTheDot === false);
/* Held for more than twice a dwell at the spot the list appeared at:
   nothing is caught, so nothing is chosen and no room changes underfoot.
   The arming flag guards the same thing from the other side, for any layout
   where an item could land under the gaze. */
check("and staring where the list opened chooses nothing at all",
  listed.afterStaring === true && listed.roomUnchanged === true,
  JSON.stringify({ stillOpen: listed.afterStaring, sameRoom: listed.roomUnchanged }));
/* "My eye fell on a room and it opened." A hold has to mean the head is
   still; a gaze crossing a target is passing over it. */
check("a gaze sweeping across a room chooses nothing on the way past",
  listed.sweptOpen === true && listed.sweptRoom === listed.roomBefore,
  JSON.stringify({ stillOpen: listed.sweptOpen, room: listed.sweptRoom }));
check("while a look off the list and a held look on a room does choose it",
  listed.armedAfterLookingAway === true && listed.closedAfterChoosing === false);

console.log("\n── a long list scrolls rather than hides ──");
/* Asked for from the headset: a column, and one you can scroll. A window
   that silently drops rooms is a list that lies about what is in the
   project. */
const scrolled = await page.evaluate(async () => {
  const run = (dir, frames) => { for (let i = 0; i < frames; i += 1) window.__xrFrame(dir); };
  const out = {};
  window.__xrSetRooms(Array.from({ length: 9 }, (nothing, index) => ({
    id: `room-${index}`,
    title: `Room ${index + 1}`,
    current: index === 0,
  })));
  run([0, 0, -1], 6);
  if (window.__xrMenu().open) { run([0, 1, 0], 10); run(window.__xrMenu().chipDir, 140); }
  run([0, 0, -1], 6);
  const shut = window.__xrMenu().chipDir.slice();
  run(shut, 140);
  const open = window.__xrMenu();
  out.opened = open.open;
  out.rowsShown = open.items.length;
  out.moreBelow = open.moreBelow;
  out.moreAbove = open.moreAbove;

  /* Just under the bottom row, where the column is asked to move. */
  const pitchOf = (dir) => Math.asin(Math.max(-1, Math.min(1, -dir[1])));
  const rowDirs = open.items.map((item) => item.dir);
  const lowest = rowDirs.reduce((a, b) => (pitchOf(a) > pitchOf(b) ? a : b));
  const belowIt = (extra) => {
    const pitch = pitchOf(lowest) + extra;
    const flat = Math.hypot(lowest[0], lowest[2]) || 1;
    const scale = Math.cos(pitch) / flat;
    return [lowest[0] * scale, -Math.sin(pitch), lowest[2] * scale];
  };
  const under = belowIt(0.18);
  run(under, 6);
  out.scrollingDown = window.__xrMenu().scrolling;
  run(under, 60);
  const moved = window.__xrMenu();
  out.offsetAfterHold = moved.offset;
  out.titlesAfter = moved.items.map((item) => item.id);

  /* Held there, it keeps going — and stops at the end rather than running off. */
  run(under, 600);
  const end = window.__xrMenu();
  out.offsetAtEnd = end.offset;
  out.moreBelowAtEnd = end.moreBelow;
  out.moreAboveAtEnd = end.moreAbove;

  /* Away from the edge it stops moving at once. */
  run([0, 0, -1], 10);
  out.scrollingAway = window.__xrMenu().scrolling;
  /* Put the list away and the rooms back: a section that leaves its own
     state lying around fails the one after it and blames the product. */
  if (window.__xrMenu().open) { run([0, 1, 0], 10); run(shut, 200); }
  out.tidied = window.__xrMenu().open;
  window.__xrSetRooms([
    { id: "room-a", title: "Family Room", current: true },
    { id: "room-b", title: "Dining Room" },
  ]);
  return out;
});
/* Four rooms and the way out: five rows, and five rooms still to come. */
check("a list longer than the window shows a window on it",
  scrolled.opened === true && scrolled.rowsShown === 5 && scrolled.moreBelow === 5,
  JSON.stringify({ rows: scrolled.rowsShown, below: scrolled.moreBelow, above: scrolled.moreAbove }));
check("looking past the bottom row scrolls the column",
  scrolled.scrollingDown === 1 && scrolled.offsetAfterHold >= 1,
  JSON.stringify({ scrolling: scrolled.scrollingDown, offset: scrolled.offsetAfterHold, rows: scrolled.titlesAfter }));
check("holding there walks it to the end and stops",
  scrolled.offsetAtEnd === 5 && scrolled.moreBelowAtEnd === 0 && scrolled.moreAboveAtEnd === 5,
  JSON.stringify({ offset: scrolled.offsetAtEnd, below: scrolled.moreBelowAtEnd, above: scrolled.moreAboveAtEnd }));
check("and looking away from the edge stops it at once",
  scrolled.scrollingAway === 0);
check("and the list is put away behind it", scrolled.tidied === false);

console.log("\n── the list stands in the room, and you walk around it ──");
/* Asked for from the headset: the same feeling as a browser window in VR —
   the window stays, the keyboard stays, and you walk and look around them.
   Hung on a direction from the head, a panel travels with the person: step
   sideways and the list steps too. Hung at a place, it stays. */
const stood = await page.evaluate(async () => {
  const run = (dir, frames) => { for (let i = 0; i < frames; i += 1) window.__xrFrame(dir); };
  const out = {};
  window.__xrStandAt(0, 0, 0);
  run([0, 0, -1], 6);
  if (window.__xrMenu().open) { run([0, 1, 0], 10); run(window.__xrMenu().chipDir, 200); }
  run([0, 0, -1], 6);
  const shut = window.__xrMenu().chipDir.slice();
  run(shut, 200);
  const open = window.__xrMenu();
  out.opened = open.open;
  out.rowBefore = open.items[0].dir.slice();
  out.chipBefore = open.chipDir.slice();

  /* One long step to the right, without turning the head at all. */
  window.__xrStandAt(1.2, 0, 0);
  run([0, 0, -1], 4);
  const after = window.__xrMenu();
  out.rowAfter = after.items[0].dir.slice();
  out.chipAfter = after.chipDir.slice();
  const angleBetween = (a, b) => Math.acos(Math.max(-1, Math.min(1,
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 57.3;
  out.rowMoved = angleBetween(out.rowBefore, out.rowAfter);
  out.chipMoved = angleBetween(out.chipBefore, out.chipAfter);

  /* Step back, and it is exactly where it was. */
  window.__xrStandAt(0, 0, 0);
  run([0, 0, -1], 4);
  out.rowBack = angleBetween(out.rowBefore, window.__xrMenu().items[0].dir);
  out.stillOpen = window.__xrMenu().open;
  window.__xrStandAt(0, 0, 0);
  if (window.__xrMenu().open) { run([0, 1, 0], 10); run(shut, 200); }
  out.tidied = window.__xrMenu().open;
  return out;
});
/* A panel carried on the head would sit at the same bearing after the step;
   one standing in the room cannot. */
check("stepping sideways moves the room list in view, because it stayed put",
  stood.opened === true && stood.rowMoved > 8 && stood.chipMoved > 8,
  `row shifted ${Math.round(stood.rowMoved)}°, dot ${Math.round(stood.chipMoved)}° after a 1.2 m step`);
check("and stepping back finds it exactly where it was left",
  stood.rowBack < 0.5, `${stood.rowBack.toFixed(2)}° from where it stood`);
check("walking around it never closed it", stood.stillOpen === true);
check("and the list is put away behind this too", stood.tidied === false);

console.log("\n── taking the headset off ──");
/* The way back rides in the same menu as the rooms — asked for in exactly
   those words. Choosing it fires the same session-end path a system gesture
   does, so this covers both. */
const left = await page.evaluate(async () => {
  const run = (dir, frames) => { for (let i = 0; i < frames; i += 1) window.__xrFrame(dir); };
  run([0, 0, -1], 20);
  let menu = window.__xrMenu();
  /* Left by gaze alone, the way somebody whose device sends no gesture at
     all has to leave — the way out must not depend on a pinch either. */
  run(menu.chipDir, 130);
  menu = window.__xrMenu();
  const exit = menu.items.find((item) => item.exit);
  /* An entry asks 1.4 seconds of stillness of a person, and 130 frames is
     1.44 — closer to the line than a fixture should ever sit. */
  if (exit) run(exit.dir, 220);
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
