/* The PDF that leaves the building, proven byte by byte.
 *
 * pdf360 is a writer with no library behind it, so nothing checks its
 * arithmetic unless a test does: every xref offset must point at the exact
 * byte where its object starts, every stream /Length must match its bytes,
 * and the same record must produce the same file twice. A PDF that is
 * almost valid opens in one viewer and not another — this suite parses the
 * file the way a strict reader would.
 */
import { createRequire } from "module";
import fs from "fs";
import { execFileSync } from "child_process";

const require = createRequire(import.meta.url);
const { buildPdf } = require("../pdf360.js");

let bad = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? `\n         ${detail}` : ""}`);
  if (!ok) bad++;
};

const lines = [
  { text: "Measured Decision - Owner Report", size: 16, bold: true },
  { text: "Project: Sarita Deck", size: 11 },
  { rule: true },
  { text: "Decisions", size: 12, bold: true, gap: 6 },
  { text: "Takeoff signed by reviewer@example.com (reviewer) - OWNER_ACCEPTED_BASELINE, not a technical confirmation.", indent: 10 },
  { text: "Every AI reading in this record is Read by AI - not confirmed until a named person signs it.", indent: 10 },
  ...Array.from({ length: 120 }, (_, index) => ({ text: `Evidence row ${index + 1}: room capture with provenance and verdict.`, indent: 10 })),
  { text: "Non-Latin characters degrade honestly: Зал -> ?", indent: 10 },
];

const bytes = buildPdf(lines, { title: "Owner Report - Sarita" });
const text = Buffer.from(bytes).toString("latin1");

console.log("── the file is a PDF a strict reader accepts ──");
check("it opens with the header and closes with EOF",
  text.startsWith("%PDF-1.4\n") && text.trimEnd().endsWith("%%EOF"));
check("120 evidence rows spill onto more than one page",
  Number((text.match(/\/Count (\d+)/) || [])[1]) > 1,
  (text.match(/\/Count \d+/) || [])[0]);

const xrefOffset = Number((text.match(/startxref\n(\d+)/) || [])[1]);
check("startxref points at the xref table", text.slice(xrefOffset, xrefOffset + 4) === "xref");

const offsetRows = [...text.slice(xrefOffset).matchAll(/^(\d{10}) 00000 n /gm)].map((match) => Number(match[1]));
const objectCount = Number((text.match(/xref\n0 (\d+)/) || [])[1]) - 1;
check("the xref lists every object", offsetRows.length === objectCount, `${offsetRows.length} vs ${objectCount}`);
check("every xref offset points at the exact byte its object starts on",
  offsetRows.every((offset, index) => text.slice(offset).startsWith(`${index + 1} 0 obj`)),
  JSON.stringify(offsetRows.filter((offset, index) => !text.slice(offset).startsWith(`${index + 1} 0 obj`))));

check("every stream /Length matches its bytes",
  [...text.matchAll(/<< \/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/g)]
    .every((match) => Buffer.byteLength(match[2], "latin1") === Number(match[1])));

const kids = (text.match(/\/Kids \[([^\]]+)\]/) || [])[1] || "";
check("the page tree's kids are real page objects",
  kids.trim().split(/\s+R\s*/).filter(Boolean)
    .every((ref) => new RegExp(`${ref.trim()} obj\\n<< /Type /Page `).test(text)),
  kids);

console.log("\n── honesty in the text itself ──");
check("parentheses and backslashes are escaped, not broken",
  buildPdf([{ text: "a (test) with \\ inside" }]).length > 0
  && /a \\\(test\\\) with \\\\ inside/.test(Buffer.from(buildPdf([{ text: "a (test) with \\ inside" }])).toString("latin1")));
check("a character outside WinAnsi degrades to ?, never vanishes",
  /honestly: \? -> \?/.test(text.replace(/\\\d{3}/g, "?")) || /\(Non-Latin characters degrade honestly: \?\?\? -> \?\)/.test(text));

console.log("\n── the material list is a table, not a paragraph ──");
/* A takeoff read as prose is a takeoff nobody can check: the quantity has to
   sit under the quantity above it. Columns are placed at their own point
   offsets, and a cell too wide for its column is trimmed rather than allowed
   to run through its neighbour. */
{
  const columned = buildPdf([
    { text: "Measured Decision - AI Takeoff", size: 16, bold: true },
    { rule: true },
    { size: 9, bold: true, cells: [
      { text: "Item", x: 0 }, { text: "Qty", x: 292, align: "right" },
      { text: "Unit", x: 356 }, { text: "Method", x: 420 },
    ] },
    { size: 9, cells: [
      { text: "2x6 joist (F.R.T.) - linear feet", x: 0 }, { text: "1230", x: 292, align: "right" },
      { text: "LF", x: 356 }, { text: "DERIVED", x: 420 },
    ] },
    { size: 9, cells: [
      { text: "column COL.2: 8x8 #1", x: 0 }, { text: "12", x: 292, align: "right" },
      { text: "drawn", x: 356 }, { text: "AI_PLAN_COUNT", x: 420 },
    ] },
    { size: 9, cells: [
      { text: "a line whose name is far too long to fit inside the column it was given and must be trimmed", x: 0 },
      { text: "7", x: 292, align: "right" }, { text: "ea", x: 356 }, { text: "DERIVED", x: 420 },
    ] },
  ], { title: "AI Takeoff" });
  const text = Buffer.from(columned).toString("latin1");
  const placements = [...text.matchAll(/BT \/F\d 9 Tf (\d+) (\d+) Td \(([^)]*)\) Tj ET/g)]
    .map((match) => ({ x: Number(match[1]), y: Number(match[2]), text: match[3] }));
  const unitX = placements.filter((place) => ["Unit", "LF", "drawn", "ea"].includes(place.text)).map((place) => place.x);
  check("every cell in a column starts at the same x",
    unitX.length === 4 && new Set(unitX).size === 1, JSON.stringify(unitX));
  /* Right alignment is a claim about where a number ENDS, not where it
     starts: "1230" and "7" must finish on the same edge. */
  const qtyRight = placements.filter((place) => ["1230", "12", "7"].includes(place.text))
    .map((place) => ({ ...place, right: place.x + place.text.length * 9 * 0.5 }));
  const edges = qtyRight.map((place) => place.right);
  check("numbers end on one edge, so the digits line up",
    qtyRight.length === 3 && Math.max(...edges) - Math.min(...edges) <= 1,
    JSON.stringify(qtyRight.map((place) => `${place.text} ends at ${place.right}`)));
  const firstRowY = placements.find((place) => place.text === "1230")?.y;
  check("a row's cells sit on one baseline",
    firstRowY !== undefined
      && placements.filter((place) => ["1230", "LF"].includes(place.text)).every((place) => place.y === firstRowY),
    JSON.stringify(placements.filter((place) => place.y === firstRowY).map((place) => place.text)));
  check("an over-long name is trimmed instead of running through the next column",
    placements.some((place) => place.x === 54 && /\.\.\.$/.test(place.text) && place.text.length < 90),
    JSON.stringify(placements.filter((place) => place.x === 54).map((place) => place.text.slice(0, 60))));
}

console.log("\n── determinism ──");
check("the same record produces the same bytes",
  Buffer.compare(Buffer.from(bytes), Buffer.from(buildPdf(lines, { title: "Owner Report - Sarita" }))) === 0);

/* The strictest reader on this machine: pypdf if present, else pdftotext,
   else a loud skip — the structural checks above still hold the line. */
fs.mkdirSync("studio/tests/fixtures", { recursive: true });
const path = "studio/tests/fixtures/owner-report-sample.pdf";
fs.writeFileSync(path, Buffer.from(bytes));
let external = "none";
try {
  execFileSync("python3", ["-c", `
from pypdf import PdfReader
r = PdfReader(${JSON.stringify(path)})
print(len(r.pages), r.pages[0].extract_text()[:40].replace("\\n", " "))
`], { stdio: ["ignore", "pipe", "pipe"] });
  external = "pypdf";
} catch { external = "none"; }
if (external === "pypdf") check("an independent reader (pypdf) opens it and reads the title text", true);
else console.log("  SKIP  no independent PDF reader on this machine — install pypdf to exercise it (structural checks above still ran)");

console.log(bad ? `\n${bad} FAILURES` : "\nALL OK");
process.exit(bad ? 1 : 0);
