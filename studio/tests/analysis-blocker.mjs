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
/* The sentence is composed from the machine's own report now, not from a
   ready-made line, so the stub answers the same questions the real
   machineStatus() answers. setMachine takes that report. */
const code = `
${grab("isVideo")}
${grab("isImage")}
${grab("focusIsCameraOriginal")}
${grab("machineAgo")}
let __machine = { known: false };
function machineStatus(){ return __machine; }
function machineLine(){ return __machine.line || ""; }
${grab("analysisBlocker")}
export function setMachine(v){ __machine = v || { known: false }; }
export { analysisBlocker };`;
const mod = await import("data:text/javascript," + encodeURIComponent(code));

// Family Room 105 as the Studio actually models it: one capture, one tile, two
// lens files behind it.
const pair = [
  { name: "360 capture 008", mimeType: "application/x-insta360-capture", sourceIds: ["a", "b"] },
];
// The same capture if it ever reached the screen uncollapsed. It is still one
// capture and must not be reported as two.
const uncollapsed = [
  { name: "VID_20250222_042011_00_008.insv", mimeType: "application/octet-stream", sourceIds: ["a", "b"] },
  { name: "VID_20250222_042011_10_008.insv", mimeType: "application/octet-stream", sourceIds: ["a", "b"] },
];
const NEVER_RAN = { known: true, everRan: false };
const WORKING = { known: true, everRan: true, awake: true, minutes: 0, step: "Stitching capture 3 of 9", completed: 2 };
const FINISHED_YESTERDAY = { known: true, everRan: true, awake: false, finished: true, minutes: 1560, step: "Queue empty", completed: 2 };
const cases = [
  ["the real Family Room 105 (machine never ran)", { evidence: pair }, NEVER_RAN],
  ["the same room while the machine works", { evidence: pair }, WORKING],
  ["and after it finished yesterday and went away", { evidence: pair }, FINISHED_YESTERDAY],
  ["one lens missing", { evidence: [{ name: "VID_x_00_1.insv", mimeType: "application/octet-stream", sourceIds: ["a"] }] }, NEVER_RAN],
  ["documents only", { evidence: [{ name: "invoice.pdf", mimeType: "application/pdf" }] }, NEVER_RAN],
  ["empty room", { evidence: [] }, NEVER_RAN],
  ["a photo — not blocked", { evidence: [{ name: "wall.jpg", mimeType: "image/jpeg" }] }, NEVER_RAN],
  ["a stitched master — not blocked", { evidence: [{ name: "cap-vr-master.mp4", mimeType: "video/mp4" }] }, NEVER_RAN],
  ["the same capture, uncollapsed", { evidence: uncollapsed }, NEVER_RAN],
];
let bad = 0;
for (const [label, room, machine] of cases) {
  mod.setMachine(machine);
  const out = mod.analysisBlocker(room);
  console.log(`\n${label}\n  → ${out === null ? "(ready — the AI runs)" : out}`);
  if (/Add a visual capture first/.test(out || "")) { console.log("  FAIL: still tells them to do what they did"); bad++; }
}
/* A machine that finished yesterday is not a machine handling this capture.
   Appending "finished 1 day ago — 2 captures stitched" to a file uploaded a
   minute ago reads as reassurance, and it was wrong every time. */
mod.setMachine(FINISHED_YESTERDAY);
const stale = mod.analysisBlocker({ evidence: pair });
if (!/nothing is stitching this right now/i.test(stale)) {
  console.log("\nFAIL: a machine that stopped must not read as one that is working"); bad++;
}
if (!/started again/i.test(stale)) { console.log("FAIL: it must say the machine has to be started"); bad++; }

mod.setMachine(WORKING);
const live = mod.analysisBlocker({ evidence: pair });
if (!/running now/i.test(live)) { console.log("FAIL: a working machine must read as working"); bad++; }
if ((live.match(/360 machine is running/gi) || []).length !== 1) {
  console.log("FAIL: it must say the machine is running once, not twice"); bad++;
}

mod.setMachine(NEVER_RAN);
const real = mod.analysisBlocker({ evidence: pair });
if (!/360 machine/.test(real)) { console.log("\nFAIL: the real case must name the machine"); bad++; }
if (!/a complete 360 capture\b/.test(real)) { console.log("FAIL: one capture must read as one"); bad++; }
if (!/a complete 360 capture\b/.test(mod.analysisBlocker({ evidence: uncollapsed }))) {
  console.log("FAIL: two lens files are still one capture"); bad++;
}
if (mod.analysisBlocker({ evidence: [{ name: "a.jpg", mimeType: "image/jpeg" }] }) !== null) { console.log("FAIL: a photo must not be blocked"); bad++; }
console.log(bad ? `\n${bad} FAILURES` : "\nALL OK");
process.exit(bad ? 1 : 0);
