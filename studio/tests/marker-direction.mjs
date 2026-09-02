/* A pin has to land on the thing it was placed on.
 *
 * Markers are stored where somebody put them on the flat sphere — a u across
 * and a v down. Standing inside the room, that has to become a direction, and
 * the only mapping that puts the pin back on the same brick is the shader's own
 * one, run backwards.
 *
 * A few degrees out does not look like a bug. It looks like somebody placed the
 * pin carelessly, which is the worst kind of wrong: believable, and blamed on a
 * person. So the pair are proven to be inverses rather than trusted to be.
 */
import fs from "fs";

const source = fs.readFileSync("studio/pano360.js", "utf8");

/* Lift the two functions out and run them, so what is tested is the code that
   ships rather than a copy of it written for the test. */
const grab = (name) => {
  const at = source.indexOf(`function ${name}(`);
  if (at < 0) throw new Error(`missing ${name}`);
  let depth = 0;
  for (let i = source.indexOf("{", at); i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") { depth -= 1; if (!depth) return source.slice(at, i + 1); }
  }
  throw new Error(`unterminated ${name}`);
};

const mod = await import("data:text/javascript," + encodeURIComponent(`
${grab("markerDirection")}
${grab("directionToUV")}
export { markerDirection, directionToUV };`));

let bad = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? `\n         ${detail}` : ""}`);
  if (!ok) bad++;
};

/* The shader's own two lines, transcribed once, so "the code agrees with
   itself" cannot pass by both halves being wrong the same way. */
const shaderUV = ([x, y, z]) => ({
  u: Math.atan2(x, -z) / (2 * Math.PI) + 0.5,
  v: Math.acos(Math.max(-1, Math.min(1, y))) / Math.PI,
});

console.log("\n── the directions everybody can name ──");
const named = [
  ["straight ahead", 0.5, 0.5, [0, 0, -1]],
  ["hard right", 0.75, 0.5, [1, 0, 0]],
  ["behind", 0.0, 0.5, [0, 0, 1]],
  ["hard left", 0.25, 0.5, [-1, 0, 0]],
  ["straight up", 0.5, 0.0, [0, 1, 0]],
  ["straight down", 0.5, 1.0, [0, -1, 0]],
];
for (const [label, u, v, want] of named) {
  const got = mod.markerDirection(u, v);
  const close = got.every((n, i) => Math.abs(n - want[i]) < 1e-9);
  check(label, close, `${got.map((n) => n.toFixed(3)).join(", ")} — expected ${want.join(", ")}`);
}

console.log("\n── and back again, everywhere on the sphere ──");
/* The poles and the seam are where a mapping quietly breaks, so they are in
   the sweep rather than left out of it. */
let worst = 0;
let worstAt = "";
for (let i = 0; i <= 40; i += 1) {
  for (let j = 0; j <= 40; j += 1) {
    const u = i / 40;
    const v = j / 40;
    const back = mod.directionToUV(mod.markerDirection(u, v));
    /* u is meaningless at the poles — every direction round is the same point —
       so it is not compared there. */
    const atPole = v < 0.01 || v > 0.99;
    const du = atPole ? 0 : Math.min(Math.abs(back.u - u), Math.abs(Math.abs(back.u - u) - 1));
    const dv = Math.abs(back.v - v);
    const error = Math.max(du, dv);
    if (error > worst) { worst = error; worstAt = `u=${u.toFixed(2)} v=${v.toFixed(2)}`; }
  }
}
check("a pin survives the round trip", worst < 1e-9, `worst error ${worst.toExponential(2)} at ${worstAt}`);

console.log("\n── and it agrees with the shader, not just with itself ──");
let shaderWorst = 0;
for (let i = 1; i < 40; i += 1) {
  for (let j = 1; j < 40; j += 1) {
    const u = i / 40;
    const v = j / 40;
    const through = shaderUV(mod.markerDirection(u, v));
    const du = Math.min(Math.abs(through.u - u), Math.abs(Math.abs(through.u - u) - 1));
    shaderWorst = Math.max(shaderWorst, du, Math.abs(through.v - v));
  }
}
check("the pin is where the shader would read that pixel",
  shaderWorst < 1e-9, `worst error ${shaderWorst.toExponential(2)}`);

/* One degree at six metres is about ten centimetres — a pin that far out is
   pointing at the next stud along. */
console.log("\n── how wrong is allowed to be ──");
const oneDegree = Math.PI / 180;
const a = mod.markerDirection(0.5, 0.5);
const b = mod.markerDirection(0.5 + oneDegree / (2 * Math.PI), 0.5);
const separation = Math.acos(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]);
check("a degree of u is a degree of arc", Math.abs(separation - oneDegree) < 1e-6,
  `${(separation * 180 / Math.PI).toFixed(4)}°`);

/* How wide the room is drawn, and the pin that has to agree with it.
 *
 * fov is the angle up and down; the shader multiplies it by the aspect to get
 * the angle across. This viewer fills the width of a laptop while standing
 * about a third as tall, so 80° up and down became roughly 127° across — and a
 * flat projection that wide stretches by construction: corners pulled, the
 * floor in front swollen, straight joists bowed. Reported from the studio as a
 * stretched room.
 *
 * Two things have to hold. The sideways angle is capped. And whatever angle is
 * actually drawn is the same angle the pins are projected from — if the shader
 * narrows and the pins do not, every marker slides off the thing it names.
 */
{
  const src = fs.readFileSync("studio/pano360.js", "utf8");
  const across = (fov, aspect) => 2 * Math.atan(Math.tan(fov / 2) * aspect);
  const capMatch = src.match(/WIDEST_ACROSS_TAN = Math\.tan\(([\d.]+) \/ 2\)/);
  const cap = capMatch ? Number(capMatch[1]) : null;
  check("the viewer states how wide it will ever draw", cap !== null, String(cap));
  check("and it is not a stretched angle", cap !== null && cap <= 1.8 && cap >= 1.2,
    `${cap} rad = ${cap ? Math.round(cap * 57.3) : "?"}°`);

  /* The shipped rule, run over the shapes a window actually takes. */
  const drawn = (fov, aspect) => Math.min(fov, 2 * Math.atan(Math.tan(cap / 2) / aspect));
  for (const [label, aspect] of [["a laptop viewer", 2.39], ["a wide desktop", 3.0], ["a squarish window", 1.3], ["a phone held upright", 0.55]]) {
    const wide = across(drawn(1.4, aspect), aspect);
    check(`${label} is never drawn wider than the cap`,
      wide <= cap + 0.001, `${Math.round(wide * 57.3)}° across`);
  }
  /* The old default, at the shape that was reported, was the bug. */
  check("the shape that was reported would have been stretched without this",
    across(1.4, 2.39) > 2.1, `${Math.round(across(1.4, 2.39) * 57.3)}° across before the cap`);
  /* A window that was never too wide is left exactly alone. */
  check("a tall window is not narrowed for no reason",
    Math.abs(drawn(1.4, 0.55) - 1.4) < 1e-9, `${drawn(1.4, 0.55)} rad`);

  /* The pins are handed the drawn angle, not the asked-for one. */
  check("the pins are projected from the angle that was drawn",
    /onFrame\?\.\(\{ yaw: view\.yaw, pitch: view\.pitch, fov: drawnFov, aspect \}\)/.test(src),
    "onFrame must carry drawnFov");
  check("and the shader is given that same angle",
    /uniforms\.tanHalfFov, Math\.tan\(drawnFov \/ 2\)/.test(src),
    "the shader must use drawnFov");
}

/* Nothing may leave the frame from inside the loop that draws the eyes.
 *
 * A guard written as `if (…) return;` sat at the end of that loop, so on the
 * FIRST eye it left the whole frame and the second eye was never drawn — one
 * eye simply stopped seeing the room. Reported from a Vision Pro within the
 * hour of shipping it. Skipping what should not be drawn must never skip the
 * eye it would have been drawn in, so the way to skip is a block. */
{
  const src = fs.readFileSync("studio/pano360.js", "utf8");
  /* There is more than one such loop in the file; the one that matters is the
     one that draws — it is the one carrying the reticle. */
  const marker = "for (const eyeView of pose.views) {";
  let start = -1;
  for (let at = src.indexOf(marker); at >= 0; at = src.indexOf(marker, at + 1)) {
    const after = src.slice(at, at + 14000);
    if (after.includes("markerUniforms.reticle")) { start = at; break; }
  }
  check("the loop that draws each eye is where it is expected", start > 0, `index ${start}`);
  let depth = 0;
  let end = -1;
  for (let i = src.indexOf("{", start); i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") { depth -= 1; if (!depth) { end = i; break; } }
  }
  const body = src.slice(start, end);
  /* A return inside a nested function of its own is fine — those return from
     themselves. Only a return at the loop's own statement level leaves the
     frame, and at this file's indentation that is twelve or fourteen spaces. */
  const escapes = body.split("\n").filter((line) => {
    const indent = line.length - line.trimStart().length;
    if (indent < 12 || indent > 16) return false;
    const text = line.trim();
    /* Both shapes that leave: a bare return, and the guard form that hides
       one at the end of a condition — which is exactly how it got in. */
    return /^return\b/.test(text) || /^if\s*\(.*\)\s*return\b/.test(text);
  }).map((line) => line.trim());
  check("and nothing inside it returns out of the frame",
    escapes.length === 0, `${escapes.length} early return(s) in the eye loop`);
  /* The eye's own matrices must be used, which is what proves the two eyes
     are one object seen twice rather than two objects. */
  check("each eye is drawn with its own projection and offset",
    /eyeView\.projectionMatrix/.test(body) && /eyeOffset/.test(body),
    "the loop must use eyeView.projectionMatrix and eyeOffset");
}

console.log(bad ? `\n${bad} FAILURES` : "\nALL OK");
process.exit(bad ? 1 : 0);
