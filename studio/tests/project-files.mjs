/* "31 files in this project" — and no way to see them.
 *
 * The count was a number with nothing under it. There was no way to ask what
 * the files were, which room each was in, or that the same capture had been
 * uploaded three times because each attempt looked as though it had failed.
 *
 * And the results screen offers exactly one 360 view — openFirstSpatial(), the
 * newest capture — so a project with nine playable rooms let somebody stand in
 * one of them. "Whatever room I look at, it only lets me see one room."
 *
 * Both complaints are the same missing thing: a way to see everything and
 * choose. This drives it against the real project's shape — 24 rooms, 35 files,
 * one room holding the same pair three times — taken from the record rather
 * than imagined.
 */
import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";
import http from "http"; import fs from "fs"; import path from "path";
import { realProjectRows } from "./seed.mjs";

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

const world = realProjectRows();
/* What the RPC would answer for that world, so the screen is driven by the
   shape the record actually returns rather than by a guess at it. */
const files = world.evidence_items.map((item) => {
  const room = world.spaces.find((space) => space.id === item.space_id);
  const twin = world.evidence_items.filter(
    (other) => other.original_filename.toLowerCase() === item.original_filename.toLowerCase(),
  ).length > 1;
  return {
    id: item.id, filename: item.original_filename, media_type: item.media_type,
    mime_type: item.mime_type, byte_size: item.byte_size,
    room_id: item.space_id, room_name: room?.name || null,
    room_building: room?.building || null, room_level: room?.level || null,
    happened_at: item.captured_at, uploaded_at: item.created_at, duplicate_name: twin,
  };
});

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox", "--no-proxy-server", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});
const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
await context.route("**://*/**", (r) => (r.request().url().startsWith(base) ? r.continue() : r.abort()));
await context.addInitScript(`window.__seed = ${JSON.stringify({ rows: world, rpc: { project_files: files } })};`);
await context.addInitScript({ path: "studio/tests/fake-supabase.js" });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
await page.goto(`${base}/studio/`, { waitUntil: "networkidle" });
await page.waitForTimeout(900);
await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => (x.textContent || "").includes("3001 Hutton"));
  if (b) b.click();
});
await page.waitForTimeout(1600);
check("the real project opens", errors.length === 0, errors[0] || "");

console.log("\n── the count opens ──");
const opened = await page.evaluate(async () => {
  document.querySelector('[data-focus-step="upload"]')?.click();
  await new Promise((r) => setTimeout(r, 500));
  const count = document.querySelector("#focus-upload-done-copy")?.textContent || "";
  const control = document.querySelector("#focus-open-files");
  if (!control) return { control: false, count };
  control.click();
  await new Promise((r) => setTimeout(r, 800));
  const rows = [...document.querySelectorAll(".focus-file-row")];
  return {
    control: true, count,
    label: control.textContent.trim(),
    shown: document.querySelector("#focus-files")?.hidden === false,
    heading: document.querySelector("#focus-files-count")?.textContent,
    rows: rows.length,
    firstRoom: rows[0]?.querySelector(".focus-file-room")?.selectedOptions?.[0]?.textContent,
    note: document.querySelector("#focus-files-note")?.textContent || "",
  };
});
check("the project count is on screen", /file[s]? in this project/i.test(opened.count), opened.count);
check("and it can be opened", opened.control === true && opened.shown === true, JSON.stringify(opened.shown));
check("in words that say what it does", /see every file/i.test(opened.label || ""), opened.label || "");
check("every file is listed", opened.rows === 35, `${opened.rows} rows — expected 35`);
check("the heading says how many", /35 files/.test(opened.heading || ""), opened.heading || "");
/* The column that was invisible from inside a room, and the one that goes wrong. */
check("each file names the room it is filed in",
  Boolean(opened.firstRoom && opened.firstRoom.trim()), opened.firstRoom || "(none)");

console.log("\n── the mistake the count was hiding ──");
const dupes = await page.evaluate(async () => {
  document.querySelector("#focus-files-dupes").click();
  await new Promise((r) => setTimeout(r, 400));
  const rows = [...document.querySelectorAll(".focus-file-row")];
  return {
    rows: rows.length,
    names: [...new Set(rows.map((row) => row.querySelector("strong")?.textContent))],
    flagged: rows.filter((row) => row.querySelector(".focus-file-dupe")).length,
  };
});
/* Six copies of one capture in Hallway 200A plus the original pair in Double
   Height 209, and 042228_011 in both Dining Room 102 and Family Room 105. */
check("the repeated uploads are findable in one press",
  dupes.rows > 0 && dupes.rows < 35, `${dupes.rows} of 35`);
check("and every one of them is marked as repeated",
  dupes.flagged === dupes.rows, `${dupes.flagged} marked of ${dupes.rows}`);
check("including the capture that was uploaded three times",
  dupes.names.some((name) => /042646_00_016/.test(name || "")), JSON.stringify(dupes.names.slice(0, 4)));
check("the note explains what a repeat means rather than calling it an error",
  /legitimate/i.test(opened.note) && /looked like it failed/i.test(opened.note),
  opened.note.slice(0, 220));

console.log("\n── filtering to one room ──");
const filtered = await page.evaluate(async () => {
  document.querySelector("#focus-files-dupes").click();
  const search = document.querySelector("#focus-files-search");
  search.value = "Hallway 200A";
  search.dispatchEvent(new Event("input", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 400));
  const rows = [...document.querySelectorAll(".focus-file-row")];
  return { rows: rows.length, names: rows.map((row) => row.querySelector("strong")?.textContent) };
});
/* The room from the reports. Six files, all the same pair three times over. */
check("a room can be filtered to", filtered.rows === 6, `${filtered.rows} rows`);
check("and they are the files that were uploaded to it",
  filtered.names.every((name) => /042646/.test(name || "")), JSON.stringify(filtered.names));

console.log("\n── moving a file to the room it belongs to ──");
const moved = await page.evaluate(async () => {
  const row = [...document.querySelectorAll(".focus-file-row")][0];
  const select = row.querySelector(".focus-file-room");
  const other = [...select.options].find((option) => /Living Room 103/.test(option.textContent));
  select.value = other.value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 900));
  const call = window.__rpcCalls.find((c) => c.name === "move_evidence_to_room");
  return {
    call: call?.args || null,
    said: document.body.innerText.replace(/\s+/g, " "),
  };
});
check("choosing another room asks the record to move it", Boolean(moved.call), JSON.stringify(moved.call));
check("naming the file and the room", Boolean(moved.call?.p_evidence_id && moved.call?.p_space_id),
  JSON.stringify(moved.call));
/* A move is a correction, not a replacement, and the difference matters to
   anybody reading this record later. */
check("and the screen says the file itself did not change",
  /file itself is unchanged/i.test(moved.said), moved.said.slice(0, 200));
console.log("\n── standing in a room other than the newest ──");
/* The complaint: nine playable rooms, one button, one room. */
const chooser = await page.evaluate(async () => {
  document.querySelector("#focus-files-close")?.click();
  document.querySelector('[data-focus-step="results"]')?.click();
  await new Promise((r) => setTimeout(r, 900));
  const buttons = [...document.querySelectorAll("[data-vr-action]")];
  const choose = buttons.find((b) => b.dataset.vrAction === "choose");
  if (!choose) return { offered: false, labels: buttons.map((b) => b.textContent.trim()) };
  choose.click();
  await new Promise((r) => setTimeout(r, 900));
  const rows = [...document.querySelectorAll(".focus-file-row")];
  return {
    offered: true,
    label: choose.textContent.trim(),
    shown: document.querySelector("#focus-files")?.hidden === false,
    rooms: [...new Set(rows.map((row) => row.querySelector(".focus-file-room")?.selectedOptions?.[0]?.textContent))],
    openable: rows.filter((row) => !row.querySelector("[data-file-open]")?.disabled).length,
  };
});
check("more than one playable room is offered", chooser.offered === true, JSON.stringify(chooser.labels || []));
check("and the control says how many", /\(9\)/.test(chooser.label || ""), chooser.label || "");
/* Nine playable captures across eight rooms — Family Room 105 holds two of
   them. Asserting nine rooms was wrong arithmetic on my part, not a fault in
   the screen. */
check("choosing opens the list narrowed to the playable captures",
  chooser.shown === true && chooser.rooms.length === 8, JSON.stringify(chooser.rooms));
check("and every one of them can be opened",
  chooser.openable === 9, `${chooser.openable} openable`);

console.log("\n── what a repeated name actually means ──");
/* "This name appears more than once" said the same thing about two situations
   that mean opposite things, and somebody had to ask what it meant. */
const meanings = await page.evaluate(async () => {
  document.querySelector("#focus-open-files")?.click();
  await new Promise((r) => setTimeout(r, 700));
  /* The section before this one left a room filter in the box. Reading rows
     through somebody else's filter is how a test asserts about the wrong set
     and reports the wrong thing. */
  const search = document.querySelector("#focus-files-search");
  search.value = "";
  search.dispatchEvent(new Event("input", { bubbles: true }));
  document.querySelector("#focus-files-dupes").click();
  await new Promise((r) => setTimeout(r, 400));
  const rows = [...document.querySelectorAll(".focus-file-row")];
  const read = (needle, room) => rows
    .filter((row) => row.querySelector("strong")?.textContent.includes(needle))
    .map((row) => ({
      room: row.querySelector(".focus-file-room")?.selectedOptions?.[0]?.textContent || "",
      note: row.querySelector(".focus-file-dupe")?.textContent || "",
    }))
    .find((entry) => entry.room.includes(room));
  return {
    /* Same capture in two different rooms: it was taken in one of them. */
    acrossRooms: read("042228_00_011", "Dining Room 102"),
    /* Same capture three times in one room: re-uploads. */
    sameRoom: read("042646_00_016", "Hallway 200A"),
  };
});
check("a capture in two rooms says it can only have been taken in one",
  /a capture was taken in one room, not two/.test(meanings.acrossRooms?.note || ""),
  JSON.stringify(meanings.acrossRooms));
check("and names the other room it is in",
  /also in Family Room 105/.test(meanings.acrossRooms?.note || ""),
  JSON.stringify(meanings.acrossRooms));
/* Hallway 200A is both at once: three copies of the capture, and the same
   capture in another room. The note has to carry both, and still explain the
   repeats — saying only one half leaves the other to be found later. */
check("a capture repeated inside one room says how many",
  /3 copies here/.test(meanings.sameRoom?.note || ""), JSON.stringify(meanings.sameRoom));
check("and why there are three of it",
  /the extras are re-uploads/.test(meanings.sameRoom?.note || ""), JSON.stringify(meanings.sameRoom));
check("and still names the other room it is in",
  /also in Double Height 209/.test(meanings.sameRoom?.note || ""), JSON.stringify(meanings.sameRoom));

console.log("\n── opening a camera original ──");
/* A browser cannot play INSV. The first version answered that with a greyed
   button and no explanation — a dead end dressed as a control. */
const opening = await page.evaluate(async () => {
  document.querySelector("#focus-files-dupes").click();
  const search = document.querySelector("#focus-files-search");
  search.value = "042228";
  search.dispatchEvent(new Event("input", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 400));
  const rows = [...document.querySelectorAll(".focus-file-row")];
  const insv = rows.find((row) => /042228_00_011\.insv/.test(row.querySelector("strong")?.textContent || "")
    && /Family Room 105/.test(row.querySelector(".focus-file-room")?.selectedOptions?.[0]?.textContent || ""));
  const disabled = rows.map((row) => row.querySelector("[data-file-open]")?.disabled);
  insv?.querySelector("[data-file-open]")?.click();
  await new Promise((r) => setTimeout(r, 1400));
  return {
    anyDisabled: disabled.some(Boolean),
    title: document.querySelector("[data-pano-title]")?.textContent || "",
    shown: document.querySelector(".pano-overlay")?.hidden === false,
  };
});
check("no file is offered a button that cannot be pressed", opening.anyDisabled === false);
/* Family Room 105 holds both the originals and the stitched master of this
   capture. Pressing Open on an original is a request to see the space. */
check("opening a camera original reaches the playable master of its capture",
  /042228_011-vr-master/.test(opening.title), opening.title || "(nothing opened)");
check("and the viewer actually opens", opening.shown === true);
await page.evaluate(() => document.querySelector("[data-pano-close]")?.click());
await page.waitForTimeout(300);

console.log("\n── the result of the room you are actually in ──");
/* The report, verbatim: "I look at Master Bedroom on the second floor, then I
   say show me the result, and it shows me I can open the 360 of Hallway."
   The newest master in this project is Hallway 107 at 04:47, and the card
   offered it regardless of where the person was. */
const followsRoom = await page.evaluate(async () => {
  document.querySelector("#focus-files-close")?.click();
  await new Promise((r) => setTimeout(r, 200));
  /* Choose the room the way a person does, on the AI-processing screen. */
  document.querySelector("#focus-process")?.click();
  await new Promise((r) => setTimeout(r, 700));
  const picker = document.querySelector("#analyze-room");
  const option = [...picker.options].find((o) => /Master Bedroom 205A/.test(o.textContent));
  picker.value = option.value;
  picker.dispatchEvent(new Event("change", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 400));
  document.querySelector('[data-focus-step="results"]')?.click();
  await new Promise((r) => setTimeout(r, 900));
  const open = document.querySelector('[data-vr-action="open"]');
  return {
    label: open?.textContent.replace(/\s+/g, " ").trim() || "",
    elsewhere: document.querySelector(".focus-vr-elsewhere")?.textContent || "",
  };
});
check("the result names the room you were looking at",
  /Master Bedroom 205A/.test(followsRoom.label), followsRoom.label || "(no button)");
check("and not the newest capture in some other room",
  !/Hallway/.test(followsRoom.label), followsRoom.label || "");
/* That room has a playable capture, so there is nothing to apologise for. */
check("with no note about standing somewhere else",
  followsRoom.elsewhere === "", followsRoom.elsewhere.slice(0, 160));

console.log("\n── a room that has no playable capture yet ──");
const borrowed = await page.evaluate(async () => {
  document.querySelector("#focus-process")?.click();
  await new Promise((r) => setTimeout(r, 700));
  const picker = document.querySelector("#analyze-room");
  /* Hallway 200A holds six camera originals and no stitched master. */
  const option = [...picker.options].find((o) => /Hallway 200A/.test(o.textContent));
  picker.value = option.value;
  picker.dispatchEvent(new Event("change", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 400));
  document.querySelector('[data-focus-step="results"]')?.click();
  await new Promise((r) => setTimeout(r, 900));
  return {
    label: document.querySelector('[data-vr-action="open"]')?.textContent.replace(/\s+/g, " ").trim() || "",
    elsewhere: (document.querySelector(".focus-vr-elsewhere")?.textContent || "").replace(/\s+/g, " "),
  };
});
/* Offering another room is fine. Offering it silently, as though it were the
   answer to the question asked, is not. */
check("it says the room you are in has nothing playable yet",
  /Hallway 200A has no playable 360 yet/.test(borrowed.elsewhere), borrowed.elsewhere.slice(0, 200));
check("and names the room the capture it offers is actually in",
  /The capture below is in /.test(borrowed.elsewhere), borrowed.elsewhere.slice(0, 220));
check("while still offering a way to stand somewhere",
  /Open 360 view — /.test(borrowed.label), borrowed.label || "(no button)");

console.log("\n── the gate: the machine says it before the bytes move ──");
/* Every filing mistake so far was knowable at the moment of upload, and the
   Studio knew it and said nothing. This is where it says it. */
const gate = await page.evaluate(async () => {
  document.querySelector('[data-focus-step="upload"]')?.click();
  await new Promise((r) => setTimeout(r, 500));
  /* Choose Hallway 200A — the room already holding three copies of this pair. */
  const building = document.querySelector("#upload-building");
  building.value = building.options[0].value;
  building.dispatchEvent(new Event("change", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 300));
  const picker = document.querySelector("#upload-room");
  const option = [...picker.options].find((o) => /Hallway 200A/.test(o.textContent));
  picker.value = option.value;
  picker.dispatchEvent(new Event("change", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 300));

  const asked = [];
  window.confirm = (message) => { asked.push(message); return false; };
  const fakeFile = new File(["x"], "VID_20250222_042646_00_016.insv", { type: "application/octet-stream" });
  const before = window.__writes.length;
  await window.__uploadFocusEvidence?.([fakeFile]);
  return {
    hooked: Boolean(window.__uploadFocusEvidence),
    asked: asked.join(" || "),
    wrote: window.__writes.length - before,
    said: [...document.querySelectorAll("[role=status], .toast, #toast")].map((n) => n.textContent).join(" ")
      || document.body.innerText.replace(/\s+/g, " ").slice(0, 400),
  };
});
if (!gate.hooked) {
  check("the upload entry is reachable from a test", false, "no __uploadFocusEvidence hook");
} else {
  check("uploading a file the room already holds asks first",
    /already in Hallway 200A/.test(gate.asked), gate.asked.slice(0, 200) || "(no question)");
  check("and says a second copy does not replace the first",
    /does not replace the first/.test(gate.asked), gate.asked.slice(0, 240));
  check("and points at the room it also lives in, with the remedy",
    /already in Double Height 209/.test(gate.asked) && /move it from/i.test(gate.asked),
    gate.asked.slice(0, 400));
  check("answering no uploads nothing", gate.wrote === 0, `${gate.wrote} write(s)`);
}

console.log("\n── the engine: what the record itself has wrong ──");
/* The gate stops new mistakes at the door. This reads the ones already inside
   — computed from the same rows the list shows, each finding carrying its
   remedy, and nothing changed until a person chooses. */
const engine = await page.evaluate(async () => {
  document.querySelector("#focus-open-files")?.click();
  await new Promise((r) => setTimeout(r, 800));
  const box = document.querySelector("#focus-files-findings");
  const items = [...(box?.querySelectorAll(".focus-finding") || [])].map((node) => ({
    title: node.querySelector("strong")?.textContent || "",
    detail: node.querySelector("small")?.textContent || "",
    remedy: node.querySelector("button")?.textContent || "",
  }));
  return { shown: box && !box.hidden, head: box?.querySelector(".focus-findings-head")?.textContent || "", items };
});
check("the findings are on top of the list", engine.shown === true);
check("and say that nothing changes until a person chooses",
  /nothing is changed until you choose/i.test(engine.head), engine.head);
/* Hallway 200A: the same pair three times. The remedy names the extras and
   keeps the oldest. */
/* Earlier in this same session the move test sent one 10_016 lens to Living
   Room 103. The engine reports the record as it now stands — 00_016 three
   times in Hallway, 10_016 twice — and it also caught what that move created:
   a lens sitting in Living Room 103 with no pair. The engine seeing through
   the consequences of this test's own actions is the engine working. */
const repeats = engine.items.filter((item) => /is in Hallway 200A [23] times/.test(item.title));
check("the repeated uploads are found, per lens file",
  repeats.length === 2, `${repeats.length} finding(s): ${JSON.stringify(engine.items.map((i) => i.title))}`);
check("and the lens split off by the earlier move is caught as a lone half",
  engine.items.some((item) => /in Living Room 103 is one lens of a pair/.test(item.title)),
  JSON.stringify(engine.items.map((i) => i.title)));
check("its remedy is removing the extras, not the original",
  repeats.every((item) => /Remove the extra copies/.test(item.remedy) && /re-uploads of the copy from/.test(item.detail)),
  JSON.stringify(repeats[0] || {}));
/* The capture filed in two rooms: a question for a person, so the remedy is
   the list narrowed to it, never an automatic move. */
const twoRooms = engine.items.filter((item) => /is filed in 2 rooms/.test(item.title));
check("captures filed in two rooms are each found",
  twoRooms.length >= 2, `${twoRooms.length} finding(s)`);
check("and their remedy is a decision, not an action",
  twoRooms.every((item) => /only somebody who was there can say/.test(item.detail)),
  JSON.stringify(twoRooms[0] || {}));

console.log("\n── acting on a finding removes the extras and only the extras ──");
const acted = await page.evaluate(async () => {
  window.confirm = () => true;
  const box = document.querySelector("#focus-files-findings");
  const target = [...box.querySelectorAll(".focus-finding")]
    .find((node) => /is in Hallway 200A 3 times/.test(node.querySelector("strong")?.textContent || ""));
  target?.querySelector("button")?.click();
  await new Promise((r) => setTimeout(r, 900));
  return {
    calls: window.__rpcCalls.filter((c) => c.name === "soft_delete_evidence").map((c) => c.args),
  };
});
check("two removals are asked of the record, not three",
  acted.calls.length === 2, `${acted.calls.length} call(s)`);
check("each carries the reason a reader needs",
  acted.calls.every((args) => /Duplicate upload/.test(args?.p_reason || "")),
  JSON.stringify(acted.calls[0] || {}));

check("nothing threw", errors.length === 0, errors.join(" | "));

await browser.close(); server.close();
console.log(bad ? `\n${bad} FAILURES` : "\nALL OK");
process.exit(bad ? 1 : 0);
