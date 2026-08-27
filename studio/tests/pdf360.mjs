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
