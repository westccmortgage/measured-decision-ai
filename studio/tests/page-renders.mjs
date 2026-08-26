/* High-resolution plan page renders — the AI's glasses.
 *
 * Three field runs reported printed facts as "not printed" because the
 * provider rasterises an E-size sheet too small to read a legend. The fix is
 * the browser rendering every page into ~200 dpi tiles before analysis. What
 * this test guards:
 *
 *   - the tiling geometry, worked by hand for a letter page and an E-sheet;
 *   - a real render: pdf.js (vendored) draws a real fixture PDF in the same
 *     Chromium the suite uses, and the tiles land in storage with a record;
 *   - the second run does not render again — the record is the marker;
 *   - a failure returns ok:false and reads as "PDF-only", never a throw.
 */
import { createRequire } from "module";
import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";
import http from "http"; import fs from "fs"; import path from "path";

const require = createRequire(import.meta.url);

let bad = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? `\n         ${detail}` : ""}`);
  if (!ok) bad++;
};

console.log("── the tiling geometry, worked by hand ──");
{
  const { tileLayout, tileName } = require("../page-renders.js");
  /* Letter, 612×792 pt at 200 dpi → 1700×2200 px: one tile, no overview. */
  const letter = tileLayout(612, 792);
  check("a letter page is one tile", letter.rows === 1 && letter.cols === 1 && letter.tiles.length === 1,
    JSON.stringify({ rows: letter.rows, cols: letter.cols, width: letter.width, height: letter.height }));
  check("and it is named as the full page", tileName(1, letter, letter.tiles[0]) === "p1-full.jpg");
  check("its pixels are under every browser's canvas ceiling",
    letter.width <= 4000 && letter.height <= 4000, `${letter.width}×${letter.height}`);

  /* The Sarita sheets: 2160×3024 pt. At 200 dpi that is 6000×8400 px —
     2 columns × 3 rows of ≤4000 px tiles, plus an overview. */
  const sheet = tileLayout(2160, 3024);
  check("an E-sheet becomes 2×3 tiles", sheet.cols === 2 && sheet.rows === 3 && sheet.tiles.length === 6,
    JSON.stringify({ cols: sheet.cols, rows: sheet.rows }));
  check("every tile fits the canvas ceiling",
    sheet.tiles.every((tile) => tile.width <= 4000 && tile.height <= 4000),
    JSON.stringify(sheet.tiles.map((tile) => `${tile.width}×${tile.height}`)));
  check("the tiles cover the page exactly, no gaps and no double cover",
    sheet.tiles.reduce((sum, tile) => sum + tile.width * tile.height, 0) === sheet.width * sheet.height,
    `${sheet.width}×${sheet.height}`);
  check("quadrant names carry row and column", tileName(3, sheet, sheet.tiles[1]) === "p3-r1c2.jpg");
}

console.log("\n── a real page renders into stored tiles ──");
const ROOT = path.resolve(".");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".pdf": "application/pdf" };
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
{
  const context = await browser.newContext();
  await context.addInitScript("window.__seed = { rows: {} };");
  await context.addInitScript({ path: "studio/tests/fake-supabase.js" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  await page.goto(`${base}/studio/tests/fixtures/blank.html`, { waitUntil: "domcontentloaded" });
  await page.addScriptTag({ url: `${base}/studio/page-renders.js` });

  const first = await page.evaluate(async () => {
    const client = window.supabase.createClient("test", "test");
    return await window.MDAIPageRenders.ensure({
      client,
      document: {
        id: "doc-1", original_filename: "tiny-plan.pdf",
        storage_provider: "supabase", storage_bucket: "project-documents",
        storage_path: "studio/tests/fixtures/tiny-plan.pdf",
      },
      organizationId: "org-1", propertyId: "prop-1",
    });
  });
  check("the render pass reports what it did", first.ok === true && first.rendered === true && first.pages === 1,
    JSON.stringify(first));

  const world = await page.evaluate(() => ({
    uploads: window.__storageUploads || [],
    records: window.__writes.filter((write) => write.table === "plan_page_renders"),
  }));
  check("one letter page lands as one full-page tile",
    world.uploads.length === 1 && world.uploads[0].path === "org-1/page-renders/doc-1/p1-full.jpg",
    JSON.stringify(world.uploads));
  check("the tile is a real JPEG with real pixels in it",
    world.uploads[0]?.type === "image/jpeg" && world.uploads[0]?.size > 5000,
    JSON.stringify(world.uploads[0]));
  check("and the record says who rendered what at which resolution",
    world.records.length === 1 && world.records[0].row.document_id === "doc-1" && world.records[0].row.target_dpi === 200,
    JSON.stringify(world.records[0] || null));

  const second = await page.evaluate(async () => {
    const client = window.supabase.createClient("test", "test");
    return await window.MDAIPageRenders.ensure({
      client,
      document: { id: "doc-1", original_filename: "tiny-plan.pdf", storage_provider: "supabase", storage_path: "studio/tests/fixtures/tiny-plan.pdf" },
      organizationId: "org-1", propertyId: "prop-1",
    });
  });
  const uploadsAfter = await page.evaluate(() => (window.__storageUploads || []).length);
  check("a second run finds the record and does not render again",
    second.ok === true && second.rendered === false && uploadsAfter === 1, JSON.stringify(second));

  console.log("\n── and a failure is a fallback, not a wall ──");
  const failed = await page.evaluate(async () => {
    const client = window.supabase.createClient("test", "test");
    return await window.MDAIPageRenders.ensure({
      client,
      document: { id: "doc-broken", original_filename: "missing.pdf", storage_provider: "supabase", storage_path: "studio/tests/fixtures/does-not-exist.pdf" },
      organizationId: "org-1", propertyId: "prop-1",
    });
  });
  check("a missing PDF returns ok:false with the reason said",
    failed.ok === false && typeof failed.reason === "string" && failed.reason.length > 0, JSON.stringify(failed));
  check("nothing threw on the page", errors.length === 0, errors.join(" | "));
  await context.close();
}

await browser.close(); server.close();
console.log(bad ? `\n${bad} FAILURES` : "\nALL OK");
process.exit(bad ? 1 : 0);
