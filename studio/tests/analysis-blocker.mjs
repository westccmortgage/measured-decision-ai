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
let machineText = "";
const code = `
${grab("isVideo")}
${grab("isImage")}
${grab("focusIsCameraOriginal")}
let __machine = "";
function machineLine(){ return __machine; }
${grab("analysisBlocker")}
export function setMachine(v){ __machine = v; }
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
const cases = [
  ["the real Family Room 105 (machine idle)", { evidence: pair }, ""],
  ["the same room while the machine works", { evidence: pair },
   "The 360 machine is running — Stitching vid_20250222_042011_008"],
  ["one lens missing", { evidence: [{ name: "VID_x_00_1.insv", mimeType: "application/octet-stream", sourceIds: ["a"] }] }, ""],
  ["documents only", { evidence: [{ name: "invoice.pdf", mimeType: "application/pdf" }] }, ""],
  ["empty room", { evidence: [] }, ""],
  ["a photo — not blocked", { evidence: [{ name: "wall.jpg", mimeType: "image/jpeg" }] }, ""],
  ["a stitched master — not blocked", { evidence: [{ name: "cap-vr-master.mp4", mimeType: "video/mp4" }] }, ""],
  ["the same capture, uncollapsed", { evidence: uncollapsed }, ""],
];
let bad = 0;
for (const [label, room, machine] of cases) {
  mod.setMachine(machine);
  const out = mod.analysisBlocker(room);
  console.log(`\n${label}\n  → ${out === null ? "(ready — the AI runs)" : out}`);
  if (/Add a visual capture first/.test(out || "")) { console.log("  FAIL: still tells them to do what they did"); bad++; }
}
mod.setMachine("");
const real = mod.analysisBlocker({ evidence: pair });
if (!/360 machine/.test(real)) { console.log("\nFAIL: the real case must name the machine"); bad++; }
if (!/a complete 360 capture\b/.test(real)) { console.log("FAIL: one capture must read as one"); bad++; }
if (!/a complete 360 capture\b/.test(mod.analysisBlocker({ evidence: uncollapsed }))) {
  console.log("FAIL: two lens files are still one capture"); bad++;
}
if (mod.analysisBlocker({ evidence: [{ name: "a.jpg", mimeType: "image/jpeg" }] }) !== null) { console.log("FAIL: a photo must not be blocked"); bad++; }
console.log(bad ? `\n${bad} FAILURES` : "\nALL OK");
process.exit(bad ? 1 : 0);
