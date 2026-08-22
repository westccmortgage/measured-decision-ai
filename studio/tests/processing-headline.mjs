/* The headline on the processing screen must describe what is running now.
   Written after a screen showed "Waiting for the 360 machine" in large type
   while an AI review of a different room was at 55%. */
import fs from "fs";
const src = fs.readFileSync("studio/studio.js", "utf8");
const grab = (name) => {
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) throw new Error("missing " + name);
  let d = 0;
  for (let k = src.indexOf("{", i); k < src.length; k++) {
    if (src[k] === "{") d++;
    else if (src[k] === "}") { d--; if (!d) return src.slice(i, k + 1); }
  }
};
const code = `
let focusProcessingRows = [];
let __stitchActive = 0;
function stitchSummary(){ return { active: new Array(__stitchActive).fill(0) }; }
${grab("focusProcessingHeadline")}
export function set(rows, stitchActive){ focusProcessingRows = rows; __stitchActive = stitchActive; }
export { focusProcessingHeadline };`;
const mod = await import("data:text/javascript," + encodeURIComponent(code));

const cases = [
  ["nothing at all", [], 0, "Nothing is processing right now"],
  ["only captures queued for the machine", [], 2, "Waiting for the 360 machine"],
  ["the exact case that went wrong: AI reading one room while 2 captures wait",
    [{ name: "Family", state: "running" }], 2, "Reading Family"],
  ["AI queued, machine idle", [{ name: "Kitchen A102", state: "queued" }], 0, "Reading Kitchen A102"],
  ["two rooms at once", [{ name: "Den A101", state: "running" }, { name: "Garage A100", state: "queued" }], 0,
    "Reading Den A101 (+1 more)"],
  ["finished cleanly", [{ name: "Family", state: "done" }], 0, "Done"],
  ["one failed", [{ name: "Family", state: "failed" }], 2, "Some spaces could not be read"],
];

let bad = 0;
for (const [label, rows, stitch, expect] of cases) {
  mod.set(rows, stitch);
  const { title, copy } = mod.focusProcessingHeadline();
  const ok = title === expect;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}\n       → "${title}"`);
  if (!ok) { console.log(`       expected "${expect}"`); bad++; }
  if (!copy) { console.log("       FAIL: no explanation under the headline"); bad++; }
}

// The specific regression: a running AI review must never be described as
// waiting for the machine, however many captures are queued.
mod.set([{ name: "Family", state: "running" }], 9);
if (/360 machine/.test(mod.focusProcessingHeadline().title)) {
  console.log("\nFAIL: a running AI review is still headlined as a machine wait");
  bad++;
}
console.log(bad ? `\n${bad} FAILURES` : "\nALL OK");
process.exit(bad ? 1 : 0);
