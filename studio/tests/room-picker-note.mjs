/* "1 file in Master Bedroom 205A" after uploading two files reads as a file
   that went missing. The number was always a count of what the AI can read,
   never a count of what is in the room. */
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
/* The note body, lifted out of the DOM-bound renderer: everything from the
   originals count to the sentence it produces. Taken whole so the test cannot
   accidentally leave a variable behind and then test a different sentence than
   the product shows. */
const whole = grab("renderAnalyzePickerNote");
const body = whole
  .slice(whole.indexOf("  const originals ="), whole.indexOf("run.disabled = false;"))
  .replace("note.className = \"room-picker-note\";", "")
  .replace("note.textContent = ", "return ");

const code = `
${grab("isVideo")}
${grab("isImage")}
${grab("focusIsCameraOriginal")}
${grab("focusSourceCount")}
export function note(room){
  const visual = (room.evidence || []).filter((item) => isImage(item) || isVideo(item));
  ${body}
}`;
const { note } = await import("data:text/javascript," + encodeURIComponent(code));

// Master Bedroom 205A as it stands now: two lens files uploaded, collapsed into
// one tile, and the stitched master the machine produced from them.
const masterBedroom = {
  name: "Master Bedroom 205A",
  evidence: [
    { name: "360 capture 013", mimeType: "application/x-insta360-capture", sourceIds: ["a", "b"] },
    { name: "vid_20250222_042413_013-vr-master.mp4", mimeType: "video/mp4" },
  ],
};
const photosOnly = { name: "Family", evidence: [
  { name: "a.jpg", mimeType: "image/jpeg" }, { name: "b.jpg", mimeType: "image/jpeg" },
] };
const readOnce = { ...photosOnly, analysis: {} };

let bad = 0;
const check = (label, actual, must) => {
  const ok = must.every((needle) => actual.includes(needle));
  console.log(`${ok ? "ok  " : "FAIL"} ${label}\n       → ${actual}`);
  if (!ok) { console.log(`       missing: ${must.filter((n) => !actual.includes(n)).join(" | ")}`); bad++; }
};

check("the room that caused this", note(masterBedroom),
  ["1 capture the AI can read", "Master Bedroom 205A", "2 camera originals preserved behind them"]);
check("plain photos say nothing about originals", note(photosOnly),
  ["2 captures the AI can read", "Family"]);
if (/camera original/.test(note(photosOnly))) { console.log("FAIL: invented originals that do not exist"); bad++; }
check("already read once still says so", note(readOnce), ["already read once"]);

// The number must never contradict what a person just did.
if (/^1 file/.test(note(masterBedroom))) { console.log("FAIL: still says 1 file"); bad++; }
console.log(bad ? `\n${bad} FAILURES` : "\nALL OK");
process.exit(bad ? 1 : 0);
