/* Build the identical kit from the source PDF.
 *
 *   node experiments/noble-takeoff/kit/build-kit.mjs [--pdf path] [--pages 24,25,26] [--extra 14,20,22] [--dpi 200] [--grid 2x2] [--overlap 120]
 *
 * Writes kit/out/: p<N>-full.png, p<N>-r<r>c<c>.png, manifest.json (page,
 * dpi, pixel and inch coordinates of every enlargement), coverage.txt (proof
 * that the tiles cover every page edge). Uses poppler's pdftoppm and Python
 * PIL, both present in this environment. Never writes to the source PDF.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs"; import path from "node:path";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "true"]; }));
const HERE = path.dirname(new URL(import.meta.url).pathname);
const PDF = args.pdf || path.join(HERE, "..", "source", "noble.pdf");
const OUT = path.join(HERE, "out");
const DPI = Number(args.dpi || 200);
const PAGES = (args.pages || "24,25,26").split(",").map(Number);
const EXTRA = (args.extra || "").split(",").filter(Boolean).map(Number);
const [ROWS, COLS] = (args.grid || "2x2").split("x").map(Number);
const OVERLAP = Number(args.overlap || 120);

if (!fs.existsSync(PDF)) { console.error(`Source PDF not found at ${PDF}. Put the original there; it is git-ignored.`); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });
const manifest = { source: path.basename(PDF), dpi: DPI, grid: `${ROWS}x${COLS}`, overlap_px: OVERLAP, pages: [] };
const coverage = [];

for (const page of [...PAGES, ...EXTRA]) {
  const stem = path.join(OUT, `p${page}`);
  execFileSync("pdftoppm", ["-r", String(DPI), "-f", String(page), "-l", String(page), "-png", "-singlefile", PDF, `${stem}-full`]);
  const full = `${stem}-full.png`;
  const [w, h] = execFileSync("python3", ["-c", `from PIL import Image; im=Image.open('${full}'); print(im.width, im.height)`]).toString().trim().split(" ").map(Number);
  const entry = { page, full: path.basename(full), width_px: w, height_px: h, width_in: +(w / DPI).toFixed(2), height_in: +(h / DPI).toFixed(2), tiles: [] };
  const structural = PAGES.includes(page);
  if (structural) {
    const tw = Math.ceil(w / COLS), th = Math.ceil(h / ROWS);
    let union = [];
    for (let r = 0; r < ROWS; r += 1) for (let c = 0; c < COLS; c += 1) {
      const x0 = Math.max(0, c * tw - OVERLAP), y0 = Math.max(0, r * th - OVERLAP);
      const x1 = Math.min(w, (c + 1) * tw + OVERLAP), y1 = Math.min(h, (r + 1) * th + OVERLAP);
      const name = `p${page}-r${r + 1}c${c + 1}.png`;
      execFileSync("python3", ["-c", `from PIL import Image; Image.open('${full}').crop((${x0},${y0},${x1},${y1})).save('${path.join(OUT, name)}')`]);
      entry.tiles.push({ name, x: x0, y: y0, width: x1 - x0, height: y1 - y0, x_in: +(x0 / DPI).toFixed(2), y_in: +(y0 / DPI).toFixed(2) });
      union.push([x0, y0, x1, y1]);
    }
    /* Edge check: the union of tiles must touch every page edge and leave no gap between neighbours. */
    const left = Math.min(...union.map((u) => u[0])), top = Math.min(...union.map((u) => u[1]));
    const right = Math.max(...union.map((u) => u[2])), bottom = Math.max(...union.map((u) => u[3]));
    const gaps = [];
    for (let r = 0; r < ROWS; r += 1) for (let c = 0; c + 1 < COLS; c += 1) { const a = union[r * COLS + c], b = union[r * COLS + c + 1]; if (a[2] < b[0]) gaps.push(`row ${r + 1}: gap between c${c + 1} and c${c + 2}`); }
    for (let c = 0; c < COLS; c += 1) for (let r = 0; r + 1 < ROWS; r += 1) { const a = union[r * COLS + c], b = union[(r + 1) * COLS + c]; if (a[3] < b[1]) gaps.push(`col ${c + 1}: gap between r${r + 1} and r${r + 2}`); }
    const complete = left === 0 && top === 0 && right === w && bottom === h && gaps.length === 0;
    coverage.push(`p${page}: ${w}x${h}px at ${DPI} dpi, ${entry.tiles.length} tiles, edges: ${complete ? "complete" : "INCOMPLETE — " + [left !== 0 && "left", top !== 0 && "top", right !== w && "right", bottom !== h && "bottom", ...gaps].filter(Boolean).join(", ")}`);
  } else {
    coverage.push(`p${page}: ${w}x${h}px at ${DPI} dpi, full page only (architectural reference)`);
  }
  manifest.pages.push(entry);
}
fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));
fs.writeFileSync(path.join(OUT, "coverage.txt"), coverage.join("\n") + "\n");
fs.mkdirSync(path.join(OUT, "marked"), { recursive: true });
console.log(coverage.join("\n"));
console.log(`Kit written to ${OUT}. Mark counts on copies under ${path.join(OUT, "marked")} — one member, one mark.`);
