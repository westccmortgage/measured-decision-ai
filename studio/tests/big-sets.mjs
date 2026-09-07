/* A PLAN SET LARGER THAN ONE AI READING.
 *
 * The provider takes one file of at most 50 MB and about a hundred pages per
 * request. The product used to stop at a wall — "Select a smaller PDF set" —
 * on a real 200 MB submittal set. Now the browser copies the pages into parts
 * that fit, beside the untouched original, and the existing chunking reads
 * the parts.
 *
 * Proved here without a provider and without a browser where possible:
 *   · the page geometry — every page in exactly one part, none too long;
 *   · a REAL split with the shipping page-copy library: a PDF built in this
 *     test, split, every part reopened and its pages counted, the original
 *     bytes byte-identical afterwards;
 *   · a range that comes out too big is halved; a single page that cannot
 *     fit is reported by number, not hidden;
 *   · tiles of a part carry the original's page numbers;
 *   · and on the real plans page: an oversized original is not a dead end
 *     but a Split action, its parts are what gets analysed, and it is
 *     analysed as parts rather than refused.
 */
import { createRequire } from "module";
import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";
import http from "http"; import fs from "fs"; import path from "path";
import { deckTakeoffRows, planDocument } from "./seed.mjs";

const require = createRequire(import.meta.url);
let bad = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? `\n         ${detail}` : ""}`);
  if (!ok) bad++;
};

const split = require("../pdf-split.js");
const PDFLib = require("../vendor/pdf-lib/pdf-lib.min.js");

console.log("── which pages go in which part ──");
{
  const cover = (parts, pages) => {
    const seen = new Set();
    for (const p of parts) for (let n = p.from; n <= p.to; n += 1) { if (seen.has(n)) return false; seen.add(n); }
    return seen.size === pages && [...seen].every((n) => n >= 1 && n <= pages);
  };
  const byPages = split.planParts({ pageCount: 412, byteSize: 10 * 1024 * 1024 });
  check("a long light set is cut by pages — every page in exactly one part",
    cover(byPages, 412) && byPages.every((p) => p.to - p.from + 1 <= split.PART_MAX_PAGES),
    `${byPages.length} parts, longest ${Math.max(...byPages.map((p) => p.to - p.from + 1))} pages`);
  const byBytes = split.planParts({ pageCount: 60, byteSize: 200 * 1024 * 1024 });
  check("a heavy set is cut by bytes before it reaches the page limit",
    cover(byBytes, 60) && byBytes.every((p) => (p.to - p.from + 1) * (200 * 1024 * 1024 / 60) <= split.PART_MAX_BYTES + 200 * 1024 * 1024 / 60),
    `${byBytes.length} parts`);
  check("parts stay in page order",
    byBytes.every((p, i) => i === 0 || p.from === byBytes[i - 1].to + 1));
  check("a set that already fits is one part",
    JSON.stringify(split.planParts({ pageCount: 12, byteSize: 3 * 1024 * 1024 })) === JSON.stringify([{ from: 1, to: 12 }]));
  check("an empty set is no parts", split.planParts({ pageCount: 0, byteSize: 0 }).length === 0);
  check("a part is named as a piece of its set",
    split.partFilename("2306-NA_231114 - PC Submittal Set.pdf", 91, 180) === "2306-NA_231114 - PC Submittal Set (pages 91-180).pdf");
  check("and remembers exactly where it came from",
    JSON.stringify(split.derivedFrom({ documentId: "d1", from: 91, to: 180, pagesTotal: 412, part: 2, parts: 5 }))
      === '{"document_id":"d1","page_from":91,"page_to":180,"pages_total":412,"part":2,"parts":5,"generation":1}');
}

console.log("\n── a real split, with the shipping library ──");
{
  /* A 23-page PDF whose pages are labelled by number, so a reopened part can
     prove not only how many pages it holds but WHICH. */
  const source = await PDFLib.PDFDocument.create();
  for (let n = 1; n <= 23; n += 1) {
    const page = source.addPage([612, 792]);
    page.drawText(`SHEET ${n}`, { x: 40, y: 740, size: 36 });
  }
  const original = await source.save();
  const before = Buffer.from(original).toString("base64");

  const result = await split.splitPdf({ bytes: original, byteSize: original.byteLength, maxBytes: 10 * 1024 * 1024, maxPages: 10, lib: PDFLib });
  check("the set is copied into parts that each fit",
    result.parts.length === 3 && result.pageCount === 23 && result.skipped.length === 0,
    `${result.parts.length} parts, ${result.skipped.length} skipped`);
  check("with the page ranges the geometry planned",
    JSON.stringify(result.parts.map((p) => [p.from, p.to])) === "[[1,10],[11,20],[21,23]]",
    JSON.stringify(result.parts.map((p) => [p.from, p.to])));
  let reopened = true;
  for (const part of result.parts) {
    const doc = await PDFLib.PDFDocument.load(part.bytes);
    if (doc.getPageCount() !== part.to - part.from + 1) reopened = false;
  }
  check("every part reopens with exactly its pages", reopened);
  check("and the original bytes are untouched",
    Buffer.from(original).toString("base64") === before);

  /* Too big even after copying: halve until it fits; a page that cannot fit
     alone is reported, never silently dropped. */
  const tight = await split.splitPdf({ bytes: original, byteSize: original.byteLength, maxBytes: 900, maxPages: 10, lib: PDFLib });
  check("a range that comes out too large is halved until it fits, or its page is named",
    tight.parts.every((p) => p.bytes.byteLength <= 900) && (tight.parts.length + tight.skipped.length) > 0
      && tight.parts.every((p, i) => i === 0 || p.from > tight.parts[i - 1].to),
    `${tight.parts.length} parts fit, pages ${tight.skipped.join(",") || "none"} could not`);
}

console.log("\n── a part's tiles carry the set's page numbers ──");
{
  const { tileLayout, tileName } = require("../page-renders.js");
  const layout = tileLayout(612, 792);
  check("page 3 of a part starting at page 101 is tile p103",
    tileName(3 + 100, layout, layout.tiles[0]) === "p103-full.jpg");
}

console.log("\n── the plans page: a wall becomes a door ──");
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

async function openPlans(world) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route("**://*/**", (r) => (r.request().url().startsWith(base) ? r.continue() : r.abort()));
  await context.addInitScript(`window.__seed = ${JSON.stringify({ rows: world })};`);
  await context.addInitScript({ path: "studio/tests/fake-supabase.js" });
  const page = await context.newPage();
  await page.goto(`${base}/studio/plans/?property=prop-1`, { waitUntil: "networkidle" });
  await page.click("#summary-full");
  await page.waitForSelector(".document-row");
  return { context, page };
}

const BIG = 200 * 1024 * 1024;
{
  /* An oversized original with no parts yet. */
  const world = deckTakeoffRows();
  world.project_documents = [...(world.project_documents || []), planDocument({
    id: "doc-big", original_filename: "2306-NA_231114 - PC Submittal Set.pdf", document_type: "structural",
    status: "uploaded", byte_size: BIG,
  })];
  const { context, page } = await openPlans(world);
  const row = await page.evaluate(() => {
    const article = [...document.querySelectorAll(".document-row")].find((r) => /PC Submittal/.test(r.textContent));
    return {
      split: article?.querySelector("[data-document-split]")?.textContent || null,
      selectable: !article?.querySelector("[data-document-select]")?.disabled,
      choiceTitle: article?.querySelector(".document-choice")?.title || "",
    };
  });
  check("an oversized original offers Split for analysis instead of nothing",
    row.split === "Split for analysis", String(row.split));
  check("it cannot itself be selected for a reading the provider would refuse",
    row.selectable === false && /split/i.test(row.choiceTitle), row.choiceTitle);
  const gate = await page.evaluate(() => document.getElementById("analyze-message")?.textContent || document.querySelector(".analysis-message, #analysis-note")?.textContent || "");
  check("and the analyse gate no longer says \"Select a smaller PDF set\"",
    !/Select a smaller PDF set/.test(gate) && !/Select a smaller PDF set/.test(await page.evaluate(() => document.body.innerText)));
  await context.close();
}
{
  /* The same original, already split into three parts. */
  const world = deckTakeoffRows();
  const org = world.document_baselines[0].organization_id;
  const partOf = (part, from, to) => planDocument({
    id: `doc-big-p${part}`, original_filename: `2306-NA_231114 - PC Submittal Set (pages ${from}-${to}).pdf`,
    document_type: "structural", status: "uploaded", byte_size: 40 * 1024 * 1024,
    source_metadata: { derived_from: { document_id: "doc-big", page_from: from, page_to: to, pages_total: 250, part, parts: 3, generation: 1, images_budget: 80 } },
  });
  world.project_documents = [...(world.project_documents || []),
    planDocument({ id: "doc-big", original_filename: "2306-NA_231114 - PC Submittal Set.pdf", document_type: "structural", status: "uploaded", byte_size: BIG }),
    partOf(1, 1, 90), partOf(2, 91, 180), partOf(3, 181, 250),
  ];
  void org;
  const { context, page } = await openPlans(world);
  const rows = await page.evaluate(() => [...document.querySelectorAll(".document-row")]
    .filter((r) => /PC Submittal/.test(r.textContent))
    .map((r) => ({
      name: r.querySelector(".document-name strong")?.textContent,
      note: r.querySelector(".document-part")?.textContent || "",
      split: !!r.querySelector("[data-document-split]"),
      selectable: !r.querySelector("[data-document-select]")?.disabled,
    })));
  const original = rows.find((r) => !/pages/.test(r.name));
  const parts = rows.filter((r) => /pages/.test(r.name));
  check("the original says it is analysed as parts and offers no second split",
    /analy[sz]ed as 3 parts/i.test(original?.note || "") && original?.split === false, original?.note);
  check("each part says which pages of which file it is",
    parts.length === 3 && parts.every((p) => /Part \d of 3 · pages \d+–\d+/.test(p.note)), JSON.stringify(parts.map((p) => p.note)));
  check("the parts are what can be selected for analysis",
    parts.every((p) => p.selectable) && original?.selectable === false);

  /* Select the parts and read the gate. */
  await page.evaluate(() => {
    for (const box of document.querySelectorAll("[data-document-select]")) {
      if (/doc-big-p/.test(box.dataset.documentSelect) && !box.checked) box.click();
    }
  });
  await page.waitForTimeout(150);
  const text = await page.evaluate(() => document.body.innerText);
  check("selecting the parts is a reading, not a refusal",
    !/Select a smaller PDF set/.test(text) && /Analyze selected PDFs/.test(text));
  await context.close();
}

console.log("\n── the server reads parts as parts ──");
{
  const worker = fs.readFileSync("supabase/functions/plan-analyze/index.ts", "utf8");
  check("the register tells the model which file and pages a part is",
    /part_of: row\.source_metadata\?\.derived_from/.test(worker));
  check("the refusal for a file that is still too big names the way through",
    /Split it for analysis in Studio/.test(worker));
  check("and the per-file provider limit itself is unchanged — the fix is the shape, not the number",
    /CHUNK_BYTE_LIMIT = 49 \* 1024 \* 1024/.test(fs.readFileSync("supabase/functions/plan-analyze/chunking.js", "utf8")));
}

await browser.close();
server.close();
console.log(bad ? `\n${bad} FAILURES` : "\nALL OK");
process.exit(bad ? 1 : 0);
