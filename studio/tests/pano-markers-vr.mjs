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
    constructor() { super(); this.renderState = {}; this.queue = []; this.ended = false; this.inputSources = []; }
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
    const frame = {
      getViewerPose: () => pose,
      getPose: (space) => (pinchRay && space === pinchSource.targetRaySpace ? poseFor(wobbled(pinchRay)) : null),
    };
    wobbleTick += 1;
    const cb = live.queue.shift();
    cb(performance.now(), frame);
    return { frames: 1, queued: live.queue.length };
  };
  window.__xrSelect = () => { live?.dispatchEvent(new Event("select")); };

  /* A pinch, the way a headset that tracks eyes reports one.
   *
   * The source appears with the pinch, carries a ray, and is gone after it —
   * and the events carry the frame it happened in, which is the only place
   * that ray can be read. None of this path had a test: every check drove
   * the head, and the head is exactly what the device replaces. */
  const pinchSource = { targetRaySpace: { pinch: true }, targetRayMode: "transient-pointer" };
  let pinchRay = null;
  /* XRRigidTransform.matrix maps the space's own coordinates INTO the
     reference space — local to world. lookMatrix builds the other direction,
     which is what a view's `inverse` wants, so handing it over here pointed
     the ray somewhere else entirely. Built the right way round: the columns
     are the pointer's own axes in world terms, and -Z is where it points. */
  const poseFor = (dir) => {
    const norm = (v) => { const l = Math.hypot(...v) || 1; return v.map((x) => x / l); };
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const back = norm([-dir[0], -dir[1], -dir[2]]);
    let right = cross([0, 1, 0], back);
    if (Math.hypot(...right) < 1e-6) right = cross([1, 0, 0], back);
    right = norm(right);
    const up = cross(back, right);
    const matrix = new Float32Array(16);
    [right, up, back].forEach((axis, column) => {
      matrix[column * 4] = axis[0];
      matrix[column * 4 + 1] = axis[1];
      matrix[column * 4 + 2] = axis[2];
    });
    matrix[15] = 1;
    return { transform: { matrix, position: { x: 0, y: 0, z: 0 } } };
  };
  /* A held pinch is never perfectly still.
     A fixture that froze the ray between the press and the release proved
     nothing: it made every press look deliberate to code that tells a
     choice from a move by how far the pointer travels. A real hand shakes,
     and on a headset where the ray IS the gaze the eyes move the instant
     the fingers do — the reported symptom was total: not one file would
     open. So the ray wobbles here, about three degrees each way and back
     again so it never wanders off, and a choice has to survive it. */
  let wobbleTick = 0;
  const WOBBLE = 0.05;
  const wobbled = (dir) => {
    if (!dir) return dir;
    const swing = Math.sin(wobbleTick * 1.1) * WOBBLE;
    const lift = Math.cos(wobbleTick * 0.7) * WOBBLE;
    const flat = Math.hypot(dir[0], dir[2]) || 1;
    const side = [-dir[2] / flat, 0, dir[0] / flat];
    const up = [-dir[1] * side[2], flat, dir[1] * side[0]];
    const out = [
      dir[0] + side[0] * swing + up[0] * lift,
      dir[1] + up[1] * lift,
      dir[2] + side[2] * swing + up[2] * lift,
    ];
    const span = Math.hypot(...out) || 1;
    return [out[0] / span, out[1] / span, out[2] / span];
  };
  window.__xrPointAt = (dir) => { pinchRay = dir; };
  window.__xrPinchStart = (dir) => {
    pinchRay = dir;
    live.inputSources = [pinchSource];
    const event = new Event("selectstart");
    event.inputSource = pinchSource;
    event.frame = { getPose: (space) => (space === pinchSource.targetRaySpace ? poseFor(wobbled(pinchRay)) : null) };
    live.dispatchEvent(event);
  };
  window.__xrPinchEnd = (dir) => {
    if (dir) pinchRay = dir;
    const fire = (name) => {
      const event = new Event(name);
      event.inputSource = pinchSource;
      event.frame = { getPose: (space) => (space === pinchSource.targetRaySpace ? poseFor(wobbled(pinchRay)) : null) };
      live.dispatchEvent(event);
    };
    fire("select");
    fire("selectend");
    live.inputSources = [];
    pinchRay = null;
  };
  window.__xrPinchSources = () => (live?.inputSources || []).length;
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
/* Where a window goes, asked for in those words: a small frame up and to the
   right, out of the way of the room, not underfoot and not across the view. */
/* Where it was asked to be for the first headset pass: a small button in easy
   reach below the direction the room opened in, out of the way of the room. */
check("the Rooms button sits below the way the room opened, in easy reach",
  parked.aheadDot > 0.9 && parked.restY < -0.15 && parked.restY > -0.45,
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
  parked.behindDot > 0.82, `dot with the new facing ${parked.behindDot.toFixed(3)}`);

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
check("and a person looking straight ahead can actually see it",
  chipOnScreen.count > 8 && chipOnScreen.highest < 256,
  `${chipOnScreen.count} px, rows ${chipOnScreen.lowest}-${chipOnScreen.highest} (256 is the eye line; below it is down)`);
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
  /* The card is frosted glass now, not a block of paint, so counting dark
     pixels no longer says whether it is there — and darkness was never the
     point. What proves it is drawn is that the view CHANGED where it stands,
     and what proves the glass is glass is that the room still varies through
     it instead of going flat. */
  const view = () => {
    const px = new Uint8Array(512 * 512 * 4);
    gl.readPixels(0, 0, 512, 512, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return px;
  };
  const changedFrom = (before, after) => {
    let changed = 0;
    for (let i = 0; i < before.length; i += 4) {
      if (Math.abs(before[i] - after[i]) > 12
        || Math.abs(before[i + 1] - after[i + 1]) > 12
        || Math.abs(before[i + 2] - after[i + 2]) > 12) changed += 1;
    }
    return changed;
  };
  /* Across the middle band, where the card stands: a painted plate is one
     colour, a pane with a room behind it is not. */
  const variationAcross = (px) => {
    let low = 255; let high = 0;
    for (let row = 200; row < 312; row += 1) {
      for (let col = 140; col < 372; col += 1) {
        const value = px[(row * 512 + col) * 4 + 1];
        if (value < low) low = value;
        if (value > high) high = value;
      }
    }
    return high - low;
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
  const beforeView = view();
  out.beforePanel = window.__xrPanel();
  /* Looking alone settles nothing: a pin is aimed at, never chosen, until a
     pinch says so. */
  run([0, 0, -1], 12);
  out.stillClosed = window.__xrPanel();
  run([0, 0, -1], 120);
  out.stillClosedAfterStaring = window.__xrPanel();
  /* And the pinch, whose ray is where the eyes were. */
  await new Promise((r) => setTimeout(r, 220));
  window.__xrPinchStart([0, 0, -1]);
  run([0, 0, -1], 2);
  window.__xrPinchEnd([0, 0, -1]);
  run([0, 0, -1], 6);
  out.panel = window.__xrPanel();
  run([0, 0, -1], 4);
  const afterView = view();
  out.changed = changedFrom(beforeView, afterView);
  out.variation = variationAcross(afterView);

  /* The way out of it, by the same gesture as everything else. */
  const closeDir = out.panel ? out.panel.closeDir : [0, -1, 0];
  run(closeDir, 10);
  out.lookingClose = window.__xrPanel()?.lookingClose === true;
  await new Promise((r) => setTimeout(r, 220));
  window.__xrPinchStart(closeDir);
  run(closeDir, 2);
  window.__xrPinchEnd(closeDir);
  run(closeDir, 6);
  out.closed = window.__xrPanel();
  run([0, 0, -1], 4);
  out.closedChanged = changedFrom(beforeView, view());

  /* A verdict is a person putting their name on a value. A stare is not
     that, and a headset that let one confirm a reading would launder
     provenance by accident. */
  await new Promise((r) => setTimeout(r, 220));
  window.__xrPinchStart([0, 0, -1]);
  run([0, 0, -1], 2);
  window.__xrPinchEnd([0, 0, -1]);
  run([0, 0, -1], 6);
  out.reopened = window.__xrPanel();
  /* Now stare at it for as long as anybody could stand to. */
  run([0, 0, -1], 300);
  out.standingAfterStaring = window.__xrPanel()?.lines[0] || "";

  /* Put the room back the way the next section expects to find it: an open
     panel owns the gaze, and the way out of the headset lives in the menu it
     covers. A test that leaves its own state lying around fails the section
     after it and blames the product. */
  const closeAgain = window.__xrPanel()?.closeDir || [0, -1, 0];
  run(closeAgain, 6);
  await new Promise((r) => setTimeout(r, 220));
  window.__xrPinchStart(closeAgain);
  run(closeAgain, 2);
  window.__xrPinchEnd(closeAgain);
  run(closeAgain, 6);
  out.tidied = window.__xrPanel();

  window.__xrSetMarkers([]);
  return out;
});
check("a pin is not open until somebody pinches it",
  pinned.beforePanel === null && pinned.stillClosed === null
  && pinned.stillClosedAfterStaring === null,
  "staring at a pin, however long, must open nothing");
check("and a pinch on it opens it",
  pinned.panel?.markerId === "pin-ahead", JSON.stringify(pinned.panel?.markerId || null));
check("and what it opens is the evidence, not a dot",
  /not verified/i.test(pinned.panel?.lines[0] || "")
  && /Water stain on ceiling/.test(pinned.panel?.lines[1] || "")
  && pinned.panel?.lines.some((line) => /12 August/.test(line)),
  JSON.stringify(pinned.panel?.lines || []));
/* The fault that made the whole thing look dead: an answer rendered where
   the headset cannot show it. Pixels, not state. */
check("the answer is actually drawn where the person is standing",
  pinned.changed > 3000, `${pinned.changed} px of the view changed`);
/* The reason for the glass: a panel that hides the capture takes away the
   one thing somebody put the headset on for. */
check("and the room is still visible through it",
  pinned.variation > 30, `${pinned.variation} levels of variation across the pane`);
check("its way out can be aimed at",
  pinned.lookingClose === true);
check("and a pinch on that closes it",
  pinned.closed === null && pinned.closedChanged < 3000,
  `${pinned.closedChanged} px still changed after closing`);
check("and the room is handed back with nothing left open",
  pinned.tidied === null);
check("staring at a reading never confirms it",
  pinned.reopened?.markerId === "pin-ahead" && /not verified/i.test(pinned.standingAfterStaring),
  pinned.standingAfterStaring || "(no standing)");

/* These four sections drive the list that stays IN the headset — the one a
   device with a real pointer can pinch. The handover to a window is for a
   device that has given nothing at all, so each of these establishes first
   that this one has: one pinch, and the session knows. */
const warmUpPointer = async () => {
  await page.evaluate(async () => {
    const run = (dir, frames) => { for (let i = 0; i < frames; i += 1) window.__xrFrame(dir); };
    window.__xrPinchStart([0, 1, 0]);
    run([0, 0, -1], 2);
    window.__xrPinchEnd([0, 1, 0]);
    run([0, 0, -1], 4);
  });
};
await warmUpPointer();

console.log("\n── one way out of the room ──");
/* THE PANEL IS GONE.
 *
 * There was a list of the project's rooms standing in the room, chosen by
 * looking at a name and pinching. Four attempts, each with a different hit
 * test, each passing here and none of them working on the device: the rooms
 * could not be chosen. So the list went back to the screen, where it has
 * always worked, and the headset carries the one control that never failed —
 * a button below the eye line, pinched once, first try, in every round.
 *
 * What it must do is small and there is no second thing: leave the headset,
 * and put the room list up behind it. */
const wayOut = await page.evaluate(async () => {
  const run = (dir, frames) => { for (let i = 0; i < frames; i += 1) window.__xrFrame(dir); };
  const out = {};
  window.__xrStandAt(0, 0, 0);
  window.__xrSetMarkers([]);
  window.__xrSetRooms([
    { id: "room-a", title: "Family Room", current: true },
    { id: "room-b", title: "Dining Room" },
    { id: "room-c", title: "Hallway" },
  ]);
  run([0, 0, -1], 12);
  const resting = window.__xrMenu();
  out.rooms = resting.rooms;
  /* Below the eye line and in front, where it was put. */
  out.pitch = Math.asin(Math.max(-1, Math.min(1, -resting.chipDir[1]))) * 57.3;
  out.inFront = resting.chipDir[2] < -0.5;
  /* Nothing else is left in the room to be aimed at. */
  out.keys = Object.keys(resting).sort().join(",");
  out.stillThere = Boolean(window.__xrLive());

  /* The head pointed deliberately elsewhere, so only the device's own ray
     can be doing the choosing. */
  const away = [0, 0.62, -0.78];
  run(away, 6);
  const aim = window.__xrMenu().chipDir.slice();
  await new Promise((r) => setTimeout(r, 240));
  window.__xrPinchStart(aim);
  run(aim, 2);
  window.__xrPinchEnd(aim);
  await new Promise((r) => setTimeout(r, 400));
  out.leftTheHeadset = !window.__xrLive();
  const list = document.querySelector(".pano-list");
  out.listShown = Boolean(list);
  out.listRooms = list ? [...list.querySelectorAll("[data-room-go]")].map((b) => b.textContent.trim()) : [];
  out.flatViewerAlive = Boolean(document.querySelector(".pano-overlay canvas"));
  return out;
});
check("one button stands in the room, below the eye line and in front",
  wayOut.pitch > 10 && wayOut.pitch < 25 && wayOut.inFront === true,
  `${wayOut.pitch.toFixed(1)}° below the eye line`);
check("and it knows how many rooms are waiting on the screen",
  wayOut.rooms === 3, String(wayOut.rooms));
/* Nothing else may be aimable. A panel that is half removed is two systems
   again, and two systems is what cost this feature four rounds. */
check("nothing else in the room answers an aim",
  wayOut.keys === "anchor,chipAim,chipDir,chipOff,lookingChip,rooms", wayOut.keys);
check("one look and pinch leaves the headset — head pointed elsewhere throughout",
  wayOut.stillThere === true && wayOut.leftTheHeadset === true);
/* Leaving without the list is a person standing in front of the capture they
   were already in, wondering what the button did. */
/* The list the SCREEN holds, which is the one that has always worked — the
   headset's own count is only what the button's label is drawn from. */
check("and the room list is up on the screen behind it",
  wayOut.listShown === true && wayOut.listRooms.length > 1
  && wayOut.listRooms.some((row) => /You are here/.test(row)),
  JSON.stringify(wayOut.listRooms));
check("and the flat viewer is there rather than a black rectangle",
  wayOut.flatViewerAlive === true);

/* Choosing a room from a list opened this way walks the person back into it,
   so the headset comes off for one press rather than for good. */
const backIn = await page.evaluate(async () => {
  window.__roomChosen = null;
  const rows = [...document.querySelectorAll("[data-room-go]")];
  const other = rows.find((b) => !b.getAttribute("aria-current"));
  other.click();
  await new Promise((r) => setTimeout(r, 500));
  return { chosen: window.__roomChosen, listGone: !document.querySelector(".pano-list") };
});
check("choosing a room there asks for that room",
  backIn.chosen === "room-b" || backIn.chosen === "room-c", String(backIn.chosen));
check("and the list closes behind the choice", backIn.listGone === true);

console.log("\n── a press that chooses nothing says why ──");
/* In a headset there is no console and no status bar. Three rounds went by on
   the sentence "it does not work", because that is the only sentence the
   person wearing it can produce. A press that lands on nothing answers for
   itself, and names the two things nobody could otherwise guess: whether the
   device sent a ray of its own, and how far the aim was. */
const silent = await page.evaluate(async () => {
  const run = (dir, frames) => { for (let i = 0; i < frames; i += 1) window.__xrFrame(dir); };
  /* Back into the room: the last section left it for the list. */
  document.querySelector("[data-pano-vr]")?.click();
  await new Promise((r) => setTimeout(r, 500));
  run([0, 0, -1], 12);
  await new Promise((r) => setTimeout(r, 240));
  /* Straight up: the button is nowhere near. */
  window.__xrPinchStart([0, 1, 0]);
  run([0, 0, -1], 2);
  window.__xrPinchEnd([0, 1, 0]);
  run([0, 0, -1], 8);
  return { note: window.__xrNote(), live: window.__xrLive() };
});
check("a pinch on nothing leaves a sentence behind",
  typeof silent.note === "string" && silent.note.length > 0, String(silent.note));
check("and it says how far the aim was from the button",
  /from the button/.test(silent.note || ""), String(silent.note));
check("and whether the device gave a ray of its own",
  /device's own ray|sent no ray/.test(silent.note || ""), String(silent.note));
check("and a press that chose nothing never left the room",
  silent.live === true);

console.log("\n── taking the headset off ──");
/* The way out used to be a row in the painted list. That list is gone from
   the headset — the system cannot aim at paint, which is the whole reason the
   rooms were handed to a window — so leaving rides on the control that was
   always there and is an element like any other. */
const left = await page.evaluate(async () => {
  const run = (dir, frames) => { for (let i = 0; i < frames; i += 1) window.__xrFrame(dir); };
  run([0, 0, -1], 20);
  document.querySelector("[data-pano-vr]")?.click();
  await new Promise((r) => setTimeout(r, 600));
  const button = document.querySelector("[data-pano-vr]");
  const canvas = document.querySelector(".pano-overlay canvas");
  return {
    sessionDead: !window.__xrLive(),
    text: button?.textContent.trim(),
    flatAlive: Boolean(canvas),
    width: canvas?.width,
  };
});
check("the control ends the immersive session", left.sessionDead === true);
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
