/* Every page keeps its tiles.
 *
 * The v3 reading of 4423 Noble wrote "right edge is cropped", "full plan
 * not available in one high-resolution tile", "requires full uncropped
 * framing-plan review" — and raised questions to the designer over it.
 * The drawings were whole. The first part carried 167 page tiles into a
 * request that then held eighty, and everything past the eightieth arrived
 * at the provider's own rasterisation. Our request was cropped, not the
 * plan — and the reading said the opposite.
 *
 * The budget is now twenty, one number for all three readers, so that three
 * readings of one set are readings of the same drawings. A smaller budget
 * would cost coverage if nothing else changed, so everything else did: the
 * splitter cuts parts to twenty, the chunker splits on tiles as well as
 * bytes, and a set is read in more parts each carrying all of its own tiles.
 * Coverage goes up, not down. What stays exactly the same is the honesty:
 * a reading names the pages it could not see at drawing-desk resolution,
 * calls that our limit rather than the drawing's, and never asks the
 * designer about it.
 *
 * Now: a part is cut so that every one of its pages keeps its tiles; the
 * site and the server agree on the budget; a reading names the pages it
 * could not see at drawing-desk resolution and is told never to call the
 * sheet cropped or ask the designer about it; the result keeps that as a
 * gap marked as ours; and parts cut before the budget was known get a
 * "Split again" door, the earlier parts kept in the record and stepped
 * aside.
 */
import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";
import http from "http"; import fs from "fs"; import path from "path";
import { createRequire } from "module";
import { deckTakeoffRows, planDocument } from "./seed.mjs";
import { MAX_RENDER_IMAGES, tileCoverage, tileCoverageGaps, tileCoverageLines, pageRanges } from "../../supabase/functions/plan-analyze/chunking.js";
const require = createRequire(import.meta.url);
const split = require("../pdf-split.js");
const renders = require("../page-renders.js");

let bad = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? `\n         ${detail}` : ""}`);
  if (!ok) bad++;
};
const tilesOf = (pages, per) => pages.flatMap((p) => [
  { name: `p${p}-full.jpg`, page: p },
  ...Array.from({ length: per - 1 }, (_, i) => ({ name: `p${p}-r${1 + Math.floor(i / 3)}c${1 + (i % 3)}.jpg`, page: p })),
]);

console.log("── the budget, spent the way the request is composed ──");
{
  const noble = [{ id: "p1", filename: "Set (pages 1-25).pdf", tiles: [...tilesOf([...Array(21)].map((_, i) => i + 1), 7), ...tilesOf([22, 23, 24, 25], 5)] }];
  const budget = tileCoverage(noble);
  check("the site and the server hold the same number, and it is the one every reader gets",
    split.PART_MAX_IMAGES === MAX_RENDER_IMAGES && MAX_RENDER_IMAGES === 20);
  check("a 25-sheet part carries twenty of its 167 tiles — which is why a part this size is no longer cut",
    budget.kept.length === 20 && budget.omitted === 147, `${budget.kept.length} kept, ${budget.omitted} omitted`);
  const cov = budget.coverage[0];
  check("and the reading knows exactly how far it got: two sheets whole, the third in part, the rest not at all",
    pageRanges(cov.pages_whole) === "1–2" && pageRanges(cov.pages_partial) === "3" && pageRanges(cov.pages_without) === "4–25",
    JSON.stringify([cov.pages_whole, cov.pages_partial, cov.pages_without]));
  check("a page's overview goes before its quadrants", budget.kept[0].name === "p1-full.jpg" && budget.kept[1].name === "p1-r1c1.jpg");
  /* The comparison kit: S-2, S-3 and S-4 at four quadrants and an overview
     each. Fifteen images, under the budget — so all three readers carry
     every tile of every sheet, and nothing is left behind to compare. */
  const kit = tileCoverage([{ id: "kit", filename: "S-2 S-3 S-4.pdf", tiles: tilesOf([24, 25, 26], 5) }]);
  check("three structural sheets are fifteen images, so the kit fits every reader whole",
    kit.kept.length === 15 && kit.omitted === 0 && pageRanges(kit.coverage[0].pages_whole) === "24–26",
    `${kit.kept.length} images`);
  const lines = tileCoverageLines(budget.coverage);
  check("the reading is told exactly which pages it cannot see",
    lines.length === 1 && lines[0] === "Set (pages 1-25).pdf: page 3 in part; pages 4–25 not at all", lines[0]);
  const gaps = tileCoverageGaps(budget.coverage);
  check("and the result keeps it as a gap that is ours, blocks nothing, and says the sheets are whole",
    gaps.length === 1 && gaps[0].origin === "reader" && gaps[0].blocks_activation === false
      && /not a gap in the drawings: the sheets are whole/.test(gaps[0].question) && /Split the set into finer parts/.test(gaps[0].question), gaps[0]?.question);
  check("a reading that carries everything keeps no such gap", tileCoverageGaps(kit.coverage).length === 0);
  check("page runs read as a person writes them", pageRanges([1, 2, 3, 5, 9, 10]) === "1–3, 5, 9–10");
}

console.log("\n── a part is cut so every page keeps its tiles ──");
{
  check("an E-size sheet is seven images, a D-size five, a letter page one",
    split.imagesForPage(36 * 72, 48 * 72) === 7 && split.imagesForPage(24 * 72, 36 * 72) === 5 && split.imagesForPage(612, 792) === 1);
  const layout = renders.tileLayout(36 * 72, 48 * 72);
  check("the count is the renderer's own geometry", split.imagesForPage(36 * 72, 48 * 72) === layout.tiles.length + 1);
  const pageImages = [...Array(21).fill(7), ...Array(9).fill(5)];
  const parts = split.planParts({ pageCount: 30, byteSize: 30 * 1024 * 1024, pageImages });
  const images = (p) => pageImages.slice(p.from - 1, p.to).reduce((a, b) => a + b, 0);
  check("Noble at 30 pages becomes thirteen parts, every one inside the budget, every page keeping its tiles",
    parts.length === 13 && parts.every((p) => images(p) <= split.PART_MAX_IMAGES) && parts[parts.length - 1].to === 30
      && parts.every((p, i) => i === 0 || p.from === parts[i - 1].to + 1)
      && parts.reduce((sum, p) => sum + images(p), 0) === pageImages.reduce((a, b) => a + b, 0),
    JSON.stringify(parts.map((p) => [p.from, p.to, images(p)])));
  const light = split.planParts({ pageCount: 200, byteSize: 10 * 1024 * 1024, pageImages: Array(200).fill(1) });
  check("a set of letter pages cuts by the image budget, which is now the tighter cap", light.every((p) => p.to - p.from + 1 <= split.PART_MAX_IMAGES) && light[0].to === split.PART_MAX_IMAGES, JSON.stringify(light[0]));
  const huge = split.planParts({ pageCount: 3, byteSize: 3 * 1024 * 1024, pageImages: [90, 7, 7] });
  check("a page over the budget on its own still travels, alone", JSON.stringify(huge) === '[{"from":1,"to":1},{"from":2,"to":3}]', JSON.stringify(huge));
  const without = split.planParts({ pageCount: 30, byteSize: 30 * 1024 * 1024 });
  check("without page measurements the planner is what it was", without.length === 1 && without[0].to === 30);
  const stamped = split.derivedFrom({ documentId: "d", from: 1, to: 2, pagesTotal: 30, part: 1, parts: 13, generation: 2, imagesBudget: split.PART_MAX_IMAGES });
  check("a part cut to the budget says so, and which generation it is",
    stamped.generation === 2 && stamped.images_budget === split.PART_MAX_IMAGES);
  check("a part cut without the budget carries no such promise", !("images_budget" in split.derivedFrom({ documentId: "d", from: 1, to: 25, pagesTotal: 30, part: 1, parts: 2 })));
}

console.log("\n── the plans page: the finer split, and the earlier parts stepping aside ──");
const ROOT = path.resolve(".");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css" };
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
function world({ finer }) {
  const w = deckTakeoffRows();
  const parent = "doc-set";
  const part = (id, from, to, extra) => planDocument({ id, original_filename: `Set (pages ${from}-${to}).pdf`, document_type: "architectural", status: "ready", byte_size: 20 * 1024 * 1024,
    source_metadata: { derived_from: { document_id: parent, page_from: from, page_to: to, pages_total: 30, ...extra } } });
  w.project_documents = [
    planDocument({ id: parent, original_filename: "Set.pdf", document_type: "architectural", status: "ready", byte_size: 200 * 1024 * 1024 }),
    part("doc-g1a", 1, 25, { part: 1, parts: 2 }),
    part("doc-g1b", 26, 30, { part: 2, parts: 2 }),
    ...(finer ? [
      part("doc-g2a", 1, 11, { part: 1, parts: 3, generation: 2, images_budget: 80 }),
      part("doc-g2b", 12, 22, { part: 2, parts: 3, generation: 2, images_budget: 80 }),
      part("doc-g2c", 23, 30, { part: 3, parts: 3, generation: 2, images_budget: 80 }),
    ] : []),
  ];
  w.document_baselines[0].source_document_ids = ["doc-g1a", "doc-g1b"];
  w.document_baselines[0].state = "review";
  w.document_baselines[0].approved_at = null;
  w.document_baselines[0].gaps = [
    { severity: "important", question: "Read without high-resolution tiles — Set (pages 1-25).pdf: page 12 in part; pages 13–25 not at all. This is the limit of one reading's image budget (80 images), not a gap in the drawings: the sheets are whole.", source_refs: [], blocks_activation: false, origin: "reader" },
    { severity: "critical", question: "Which issue status governs?", source_refs: [], blocks_activation: true },
  ];
  w.material_takeoffs = [];
  return w;
}
async function open(w) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route("**://*/**", (r) => (r.request().url().startsWith(base) ? r.continue() : r.abort()));
  await context.addInitScript(`window.__seed = ${JSON.stringify({ rows: w })};`);
  await context.addInitScript({ path: "studio/tests/fake-supabase.js" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  await page.goto(`${base}/studio/plans/?property=${w.properties[0].id}`, { waitUntil: "networkidle" });
  await page.evaluate(() => document.getElementById("summary-full")?.click());
  await page.waitForSelector(".document-row");
  await page.waitForTimeout(300);
  const rows = await page.evaluate(() => [...document.querySelectorAll(".document-row")].map((row) => ({
    id: row.querySelector("[data-document-select]")?.dataset.documentSelect,
    checked: row.querySelector("[data-document-select]")?.checked,
    disabled: row.querySelector("[data-document-select]")?.disabled,
    title: row.querySelector(".document-choice")?.title || "",
    part: row.querySelector(".document-part")?.textContent || "",
    split: row.querySelector("[data-document-split]")?.textContent.trim() || "",
  })));
  const gaps = await page.evaluate(() => [...document.querySelectorAll("#gap-list .gap-item")].map((g) => g.textContent.replace(/\s+/g, " ").trim().slice(0, 80)));
  return { context, rows, gaps, errors };
}
{
  const { context, rows, gaps, errors } = await open(world({ finer: false }));
  const original = rows.find((r) => r.id === "doc-set");
  check("parts cut before the budget was known: the original offers a finer split and says why",
    original?.split === "Split again for full resolution" && /cut before the image budget was known/.test(original?.part || ""), JSON.stringify(original));
  check("until then the earlier parts are still what gets read", rows.filter((r) => /doc-g1/.test(r.id)).every((r) => !r.disabled && r.checked));
  check("the gap that is ours is marked as ours, before the designer's questions are read as theirs",
    gaps.some((g) => /^Our reading, not the drawings · Read without high-resolution tiles/.test(g)), JSON.stringify(gaps));
  check("nothing threw", errors.length === 0, errors[0] || "");
  await context.close();
}
{
  const { context, rows, errors } = await open(world({ finer: true }));
  const original = rows.find((r) => r.id === "doc-set");
  check("after the finer split the original offers nothing more and counts the parts that are read",
    original?.split === "" && /Analysed as 3 parts/.test(original?.part || "") && !/cut before/.test(original?.part || ""), JSON.stringify(original));
  const old = rows.filter((r) => /doc-g1/.test(r.id));
  check("the earlier parts step aside — kept in the record, unselectable, and say so",
    old.every((r) => r.disabled && !r.checked && /superseded by a finer split · kept in the record/.test(r.part) && /Superseded by a finer split/.test(r.title)), JSON.stringify(old));
  const fresh = rows.filter((r) => /doc-g2/.test(r.id));
  check("the finer parts are what is selected to read", fresh.length === 3 && fresh.every((r) => !r.disabled && r.checked), JSON.stringify(fresh));
  check("nothing threw", errors.length === 0, errors[0] || "");
  await context.close();
}
await browser.close();
server.close();
console.log(bad ? `\n${bad} FAILURES` : "\nALL OK");
process.exit(bad ? 1 : 0);
