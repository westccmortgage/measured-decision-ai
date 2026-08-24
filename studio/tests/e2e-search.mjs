/* Finding things in the record.
 *
 * The record already holds everything; reaching any of it meant remembering
 * which screen it lived on. This is the one field that answers "where is the
 * 360 of the master bedroom" without a hunt.
 *
 * The assertion that matters most is not that it finds things. It is that a
 * search result cannot present an AI reading as settled — a results list is
 * exactly the place a suggestion escapes as a fact, because it arrives stripped
 * of the screen that framed it.
 */
import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";
import http from "http"; import fs from "fs"; import path from "path";
import { rows } from "./seed.mjs";

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

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox", "--no-proxy-server", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});

let bad = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? `\n         ${detail}` : ""}`);
  if (!ok) bad++;
};

/* What the database would answer. The function itself is proven against a real
   Postgres in supabase/tests; this covers what the screen does with the answer. */
const HITS = [
  { kind: "evidence", id: "ev-master", title: "vid_20250222_043147_022-vr-master.mp4",
    detail: "360 capture", room_id: "space-viewable", room_name: "Bath #1 A203",
    happened_at: "2026-08-13T10:00:00Z", confirmed: null, rank: 0.6 },
  { kind: "room", id: "space-viewable", title: "Bath #1 A203", detail: "Main House · Level 1",
    room_id: "space-viewable", room_name: "Bath #1 A203",
    happened_at: "2026-08-01T00:00:00Z", confirmed: false, rank: 0.4 },
  { kind: "finding", id: "sg-1", title: "Framing is complete and drywall has not started",
    detail: "Bath #1 A203", room_id: "space-viewable", room_name: "Bath #1 A203",
    happened_at: "2026-08-22T10:05:00Z", confirmed: false, rank: 0.3 },
  { kind: "document", id: "doc-1", title: "Blueprints-3001-Hutton.pdf", detail: "plan_set · Rev A",
    room_id: null, room_name: null, happened_at: "2026-08-23T07:10:00Z", confirmed: null, rank: 0.2 },
];

async function open(rpc) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  await context.route("**://*/**", (r) => (r.request().url().startsWith(base) ? r.continue() : r.abort()));
  await context.addInitScript(`window.__seed = ${JSON.stringify({ rows, rpc })};`);
  await context.addInitScript({ path: "studio/tests/fake-supabase.js" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 160)));
  await page.goto(`${base}/studio/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => (x.textContent || "").includes("3001 Hutton"));
    if (b) b.click();
  });
  await page.waitForTimeout(1300);
  return { context, page, errors };
}

const type = async (page, term) => {
  await page.fill("#focus-search-input", term);
  await page.waitForTimeout(700);
};

console.log("\n── one field, inside the project ──");
{
  const { context, page, errors } = await open({ search_project_record: HITS });
  check("the project opens without throwing", errors.length === 0, errors[0] || "");
  const field = await page.evaluate(() => {
    const el = document.querySelector("#focus-search-input");
    return el && el.offsetParent !== null ? el.placeholder : null;
  });
  check("the field is on screen", Boolean(field), field || "(not visible)");
  check("and says what it is for", /find anything/i.test(field || ""), field || "");

  /* A single letter would match most of the record and answer nothing. */
  await type(page, "b");
  const early = await page.evaluate(() => ({
    open: document.querySelector("#focus-search-results")?.hidden === false,
    asked: window.__rpcCalls.filter((c) => c.name === "search_project_record").length,
  }));
  check("one letter asks nothing", early.asked === 0, `${early.asked} search(es)`);
  check("and shows nothing", early.open === false);

  await type(page, "framing");
  const asked = await page.evaluate(() =>
    window.__rpcCalls.filter((c) => c.name === "search_project_record").map((c) => c.args));
  check("a real question is asked once", asked.length === 1, JSON.stringify(asked));
  check("and it is scoped to this project",
    asked[0]?.p_property_id === "prop-1" && asked[0]?.p_query === "framing", JSON.stringify(asked[0]));
  await context.close();
}

console.log("\n── what a result says ──");
{
  const { context, page } = await open({ search_project_record: HITS });
  await type(page, "framing");
  const shown = await page.evaluate(() =>
    [...document.querySelectorAll(".focus-search-hit")].map((el) => (el.innerText || "").replace(/\s+/g, " ")));
  check("every hit is listed", shown.length === 4, `${shown.length} result(s)`);
  check("a file says which room and when",
    /EVIDENCE · BATH #1 A203 · AUGUST 13, 2026/i.test(shown[0] || ""), shown[0] || "");
  check("a room is a result in its own right", /^ROOM/.test(shown[1] || ""), shown[1] || "");
  check("a document is named as one", /^DOCUMENT/.test(shown[3] || ""), shown[3] || "");

  /* The rule the product rests on. A result arrives stripped of the screen that
     framed it, so it has to carry its own standing. */
  const finding = shown.find((text) => /AI READING/.test(text)) || "";
  check("an AI reading is labelled as one", Boolean(finding), finding || "no finding row");
  check("and says nobody has confirmed it",
    /nobody has confirmed this/i.test(finding), finding);
  check("it does not read as a settled fact",
    !/\bconfirmed by a person\b/i.test(finding), finding);
  await context.close();
}

console.log("\n── a confirmed reading says the other thing ──");
{
  const confirmed = HITS.map((h) => (h.kind === "finding" ? { ...h, confirmed: true } : h));
  const { context, page } = await open({ search_project_record: confirmed });
  await type(page, "framing");
  const finding = await page.evaluate(() =>
    [...document.querySelectorAll(".focus-search-hit")]
      .map((el) => (el.innerText || "").replace(/\s+/g, " "))
      .find((t) => /AI READING/.test(t)) || "");
  check("a confirmed reading says a person confirmed it",
    /confirmed by a person/i.test(finding), finding);
  check("and never that nobody has", !/nobody has confirmed/i.test(finding), finding);
  await context.close();
}

console.log("\n── pressing a result ──");
{
  const { context, page } = await open({ search_project_record: HITS });
  await type(page, "framing");
  const landed = await page.evaluate(async () => {
    document.querySelector(".focus-search-hit").click();
    await new Promise((r) => setTimeout(r, 400));
    return {
      sheetOpen: document.querySelector("#focus-sheet")?.hidden === false,
      room: (document.querySelector("#focus-sheet")?.innerText || "").slice(0, 60),
      panelClosed: document.querySelector("#focus-search-results")?.hidden === true,
      fieldCleared: document.querySelector("#focus-search-input")?.value === "",
    };
  });
  check("it opens the room the thing belongs to", landed.sheetOpen === true);
  check("the right one", /Bath #1 A203/.test(landed.room), landed.room);
  check("and puts the results away", landed.panelClosed === true);
  check("leaving the field empty for the next question", landed.fieldCleared === true);
  await context.close();
}

console.log("\n── nothing matches ──");
{
  const { context, page } = await open({ search_project_record: [] });
  await type(page, "zzzznotathing");
  const note = await page.evaluate(() =>
    (document.querySelector("#focus-search-results")?.innerText || "").trim());
  /* "Nothing here" and "something is broken" look identical unless the screen
     repeats what was actually searched for. */
  check("it says nothing matched", /nothing in this project matches/i.test(note), note);
  check("and repeats the question", /zzzznotathing/.test(note), note);
  await context.close();
}

console.log("\n── the record cannot answer ──");
{
  const { context, page } = await open({ search_project_record: null });
  await page.evaluate(() => {
    const real = window.supabase.createClient;
    void real;
  });
  await type(page, "framing");
  const note = await page.evaluate(() =>
    (document.querySelector("#focus-search-results")?.innerText || "").trim());
  /* An answer of "no rows" and no answer at all are different facts, and only
     one of them is a statement about the project. */
  check("an unanswerable search does not read as an empty project",
    !/nothing in this project/i.test(note), note);
  check("it says the record could not be searched", /could not be searched/i.test(note), note);
  await context.close();
}

await browser.close(); server.close();
console.log(bad ? `\n${bad} FAILURES` : "\nALL OK");
process.exit(bad ? 1 : 0);
