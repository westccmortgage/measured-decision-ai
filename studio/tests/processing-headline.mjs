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
let __jobs = [];
function stitchSummary(){
  const active = __jobs.filter(j => ["waiting_for_sdk","queued","processing"].includes(j.state));
  return { active, running: active.filter(j => j.state === "processing"),
           failed: [], done: [] };
}
${grab("stitchProgressPercent")}
${grab("focusProcessingHeadline")}
export function set(rows, jobs){ focusProcessingRows = rows; __jobs = jobs || []; }
export { focusProcessingHeadline, stitchProgressPercent, stitchSummary };`;
const mod = await import("data:text/javascript," + encodeURIComponent(code));

const queued = (n) => new Array(n).fill(0).map(() => ({ state: "queued", progress: 0 }));
const running = (p) => [{ state: "processing", progress: p }];

const cases = [
  ["nothing at all", [], [], "Nothing is processing right now"],
  ["only captures queued for the machine", [], queued(2), "Waiting for the 360 machine"],
  ["the machine is actually stitching", [], running(18), "The 360 machine is stitching"],
  ["stitching with more behind it", [], [...running(18), ...queued(2)], "The 360 machine is stitching"],
  ["the exact case that went wrong: AI reading one room while 2 captures wait",
    [{ name: "Family", state: "running" }], queued(2), "Reading Family"],
  ["AI queued, machine idle", [{ name: "Kitchen A102", state: "queued" }], [], "Reading Kitchen A102"],
  ["two rooms at once", [{ name: "Den A101", state: "running" }, { name: "Garage A100", state: "queued" }], [],
    "Reading Den A101 (+1 more)"],
  ["finished cleanly", [{ name: "Family", state: "done" }], [], "Done"],
  ["one failed", [{ name: "Family", state: "failed" }], queued(2), "Some spaces could not be read"],
];

let bad = 0;
for (const [label, rows, jobs, expect] of cases) {
  mod.set(rows, jobs);
  const { title, copy } = mod.focusProcessingHeadline();
  const ok = title === expect;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}\n       → "${title}"`);
  if (!ok) { console.log(`       expected "${expect}"`); bad++; }
  if (!copy) { console.log("       FAIL: no explanation under the headline"); bad++; }
}

// The specific regression: a running AI review must never be described as
// waiting for the machine, however many captures are queued.
mod.set([{ name: "Family", state: "running" }], queued(9));
if (/360 machine/.test(mod.focusProcessingHeadline().title)) {
  console.log("\nFAIL: a running AI review is still headlined as a machine wait");
  bad++;
}
// The meter must carry the number the line beside it is already showing.
mod.set([], running(18));
const pct = mod.stitchProgressPercent(mod.stitchSummary());
if (pct !== 18) { console.log(`\nFAIL: meter says ${pct}% while the machine reports 18%`); bad++; }
mod.set([], queued(3));
if (mod.stitchProgressPercent(mod.stitchSummary()) !== 0) {
  console.log("FAIL: a queue that has not started is not partly done"); bad++;
}
mod.set([], [{ state: "processing", progress: 40 }, { state: "processing", progress: 80 }]);
if (mod.stitchProgressPercent(mod.stitchSummary()) !== 60) { console.log("FAIL: two running captures should average"); bad++; }
mod.set([], [{ state: "processing", progress: null }]);
if (mod.stitchProgressPercent(mod.stitchSummary()) !== 0) { console.log("FAIL: a missing progress is not a number"); bad++; }

console.log(bad ? `\n${bad} FAILURES` : "\nALL OK");
process.exit(bad ? 1 : 0);
