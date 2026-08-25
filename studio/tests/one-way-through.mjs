/* The two faults behind a day of bugs, made impossible to reintroduce quietly.
 *
 * Eight separate bugs were reported in one day. They were not eight faults.
 * They were two, each wearing several disguises.
 *
 *   A. The room was not a thing that travelled. It was worked out again at
 *      every layer — the resume key, the edge function, the client grouping,
 *      the capture-group key, the results offer — and every layer that worked
 *      it out could get it wrong. Five of the eight were this.
 *
 *   B. The screen rendered from a snapshot instead of from state. A signed URL
 *      captured once at load; a results card rendered once at load. Anything
 *      that changed afterwards was invisible.
 *
 * Every one of those was fixed by hand. Nothing stopped the next person — or
 * the next agent, including me — writing the same shape again and watching the
 * whole suite pass. These are the rules that make the shape fail loudly.
 *
 * This asserts against the shipping source, so it costs nothing at runtime and
 * cannot be satisfied by a comment.
 */
import fs from "fs";

const studio = fs.readFileSync("studio/studio.js", "utf8");
const upload = fs.readFileSync("studio/s3-upload.js", "utf8");

/* Rules about shape are rules about code. Without this the checks below match
   the comments that describe the very patterns they forbid — which is a test
   failing because somebody explained the bug well. */
const codeOnly = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");

const studioCode = codeOnly(studio);
const uploadCode = codeOnly(upload);

let bad = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? `\n         ${detail}` : ""}`);
  if (!ok) bad++;
};

/* The body of one named function, by brace matching. A fixed slice passes until
   somebody adds a branch above the line being checked. */
function bodyOf(source, signature) {
  const from = source.indexOf(signature);
  if (from < 0) return "";
  let depth = 0;
  for (let i = source.indexOf("{", from); i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") { depth -= 1; if (!depth) return source.slice(from, i + 1); }
  }
  return "";
}

console.log("\n── A · the room travels, it is not worked out again ──");
{
  /* The exact shape that put one room's files into another room's capture:
     asking which room a file is in by scanning rooms for one that contains the
     object. It is not a question about the record, it is a question about
     JavaScript object identity — and a collapsed tile is not the row it stands
     for, so the answer was wrong whenever it mattered most. */
  /* Matched by balancing the call's own parentheses, not by a character class.
     The first version of this rule used [^)]* and so could not survive an arrow
     parameter in brackets — rooms.find((room) => …) — which is how everybody
     actually writes it. It matched the comment describing the bug and missed
     every real occurrence, and passed. A rule that cannot fail is not a rule. */
  const balancedArg = (source, from) => {
    let depth = 0;
    for (let i = source.indexOf("(", from); i < source.length; i += 1) {
      if (source[i] === "(") depth += 1;
      else if (source[i] === ")") { depth -= 1; if (!depth) return source.slice(from, i + 1); }
    }
    return "";
  };
  const scans = [];
  for (const m of studioCode.matchAll(/rooms\s*\.\s*find\s*\(/g)) {
    const call = balancedArg(studioCode, m.index);
    /* find picks one and calls it the answer. filter collects them all and
       leaves the choosing to somebody who knows — which is why filter is not
       forbidden here. */
    if (/\.evidence\b/.test(call) && /\.(?:includes|some)\s*\(/.test(call)) scans.push(call);
  }
  check("no code finds a file's room by scanning the rooms for it",
    scans.length === 0, scans.map((call) => call.replace(/\s+/g, " ").slice(0, 90)).join(" · "));

  check("there is one function that answers it", /function roomOf\(item\)/.test(studio));
  const roomOf = bodyOf(studioCode, "function roomOf(item)");
  /* Guessing is worse than not knowing: a file the record has not placed is
     placed nowhere, not in whichever room looks closest. */
  check("and it reads the room off the item rather than guessing",
    /item\.spaceId/.test(roomOf) && /return null/.test(roomOf), roomOf.slice(0, 0));

  check("there is one function that finds the tile for an evidence id",
    /function tileFor\(evidenceId\)/.test(studio));
  const tileScans = [...studioCode.matchAll(/\(entry\.sourceIds \|\| \[\]\)\.includes|\(candidate\.sourceIds \|\| \[\]\)\.includes|\(item\.sourceIds \|\| \[\]\)\.includes/g)];
  check("and only that one walks source ids",
    tileScans.length === 1, `${tileScans.length} place(s) walk sourceIds`);

  /* The room reaches storage as part of what identifies an upload, not as a
     detail hanging off it. Without it, the same file offered to a second room
     resumed the first room's session and reported success. */
  check("the upload key carries the room",
    /function fingerprint\([^)]*spaceId/.test(uploadCode));
  check("and the uploader passes it",
    /storageKey\s*=\s*fingerprint\(entityType,organizationId,propertyId,spaceId,file/.test(uploadCode));
}

console.log("\n── B · the screen is a function of state, never a snapshot ──");
{
  const focusRender = bodyOf(studioCode, "function renderFocusStudio()");
  check("there is one whole-Studio render", focusRender.length > 0);

  /* Each part of the screen is rendered by the whole render and by nothing
     else. Calling a sub-render by hand is how a screen gets rebuilt only when
     the path somebody happened to take passed through the right function. */
  for (const part of ["renderFocusToday", "renderFocusResults", "renderUploadPicker", "renderAnalyzePicker"]) {
    const calls = [...studioCode.matchAll(new RegExp(`(?<!function )\\b${part}\\(\\)`, "g"))].length;
    const inside = [...focusRender.matchAll(new RegExp(`\\b${part}\\(\\)`, "g"))].length;
    check(`${part} is called only by the whole render`,
      calls === 1 && inside === 1, `${calls} call(s) in the file, ${inside} inside it`);
  }

  /* showFocusStage sets state and renders; applyFocusStage only paints from
     state. The two used to be each other's tail, which is a cycle with no
     single place a change goes through. */
  const show = bodyOf(studioCode, "function showFocusStage(name)");
  const apply = bodyOf(studioCode, "function applyFocusStage()");
  check("changing stage renders", /renderFocusStudio\(\)/.test(show));
  check("painting the stage does not render", !/renderFocusStudio\(\)/.test(apply));
  check("and the render paints rather than re-entering the stage change",
    /applyFocusStage\(\)/.test(focusRender) && !/showFocusStage\(/.test(focusRender));

  /* A signed URL is a fact with an expiry date. Read straight off the item, it
     is an hour-old fact presented as current — which is what made every file in
     the project stop working at the same moment. */
  check("there is one place that renews a signed URL",
    /async function freshEvidenceSrc\(item/.test(studio));
  const viewer = bodyOf(studioCode, "async function openEvidenceViewer(item, room, focusMarkerId = null)");
  check("the viewer opens on a renewed URL, not on whatever was signed at load",
    /freshEvidenceSrc\(item\)/.test(viewer) && !/src: item\.src/.test(viewer),
    viewer ? "" : "(viewer not found)");
  const frames = bodyOf(studioCode, "async function extractVideoFrames(item, frameLimit = 4)");
  check("and so does frame extraction",
    /freshEvidenceSrc\(item\)/.test(frames) && /force: true/.test(frames));
}

console.log("\n── the rules that were broken silently before ──");
{
  /* Every one of these was a real report today. They are listed by their
     symptom, because that is how the next one will arrive. */
  check("a room's files are filtered by the room on the item",
    /evidenceWithUrls\.filter\(\(item\) => item\.spaceId === space\.id\)/.test(studio));
  check("a 360 capture is grouped within its room, not across the project",
    /\$\{item\.spaceId \|\| "unfiled"\}\|\$\{key\}/.test(studio));
  check("the 360 offer follows the room somebody is in",
    /function spatialToOffer\(\)/.test(studio) && /spatialForRoom\(currentFocusRoom\(\)\)/.test(studio));
  check("and analysis is never sent with nothing in it",
    /function nothingToAnalyse\(/.test(studio));
}

console.log(bad ? `\n${bad} FAILURES` : "\nALL OK");
process.exit(bad ? 1 : 0);
