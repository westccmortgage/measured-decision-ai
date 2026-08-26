/* The signed takeoff as a workbook — and only what a person confirmed on the
 * order sheet.
 *
 * Two things under test. The writer: an .xlsx is a stored ZIP of XML parts,
 * and python's zipfile is the independent referee that the bytes really are
 * one (CRCs checked, parts listed, cells present). The mapping: the four
 * sheets carry exactly the statuses the record supports — Human Confirmed
 * rows on the order sheet, no scaled estimates anywhere, traces with their
 * citations, open questions as RFI/Hold.
 */
import { createRequire } from "module";
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";

const require = createRequire(import.meta.url);
const { buildXlsx, columnRef } = require("../xlsx360.js");

let bad = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? `\n         ${detail}` : ""}`);
  if (!ok) bad++;
};

console.log("── the writer produces a real spreadsheet ──");
const sheets = [
  { name: "Human-Verified Order", bold: [0], widths: [40, 12], rows: [["Item", "Qty"], ["2x6 deck boards — F.R.T.", 3280], ['18" pile · "quoted" & <escaped>', 14]] },
  { name: "RFIs & Holds", rows: [["Question"], ["BM.1 drawn count was not read"]] },
];
const bytes = buildXlsx(sheets);
check("the file opens with the ZIP signature", bytes[0] === 0x50 && bytes[1] === 0x4B, `${bytes[0]},${bytes[1]}`);
check("column references count like a spreadsheet", columnRef(0) === "A" && columnRef(25) === "Z" && columnRef(26) === "AA", `${columnRef(26)}`);

const out = path.join("studio", "tests", "fixtures", "workbook-under-test.xlsx");
fs.writeFileSync(out, bytes);
const verdict = execFileSync("python3", ["-c", `
import zipfile, json, sys
z = zipfile.ZipFile("${out}")
result = {"bad_crc": z.testzip(), "names": sorted(z.namelist())}
sheet1 = z.read("xl/worksheets/sheet1.xml").decode()
result["has_number"] = "<v>3280</v>" in sheet1
result["has_escaped"] = "&quot;quoted&quot; &amp; &lt;escaped&gt;" in sheet1
result["workbook"] = z.read("xl/workbook.xml").decode()
print(json.dumps(result))
`]).toString();
const parsed = JSON.parse(verdict);
fs.unlinkSync(out);
check("python's zipfile verifies every CRC", parsed.bad_crc === null, String(parsed.bad_crc));
check("all the parts a spreadsheet needs are inside",
  ["[Content_Types].xml", "_rels/.rels", "xl/styles.xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml"]
    .every((name) => parsed.names.includes(name)), JSON.stringify(parsed.names));
check("a quantity is a number cell, not text", parsed.has_number === true);
check("markup in an item name is escaped, not injected", parsed.has_escaped === true);
check("both sheets are declared by name",
  /Human-Verified Order/.test(parsed.workbook) && /RFIs &amp; Holds/.test(parsed.workbook), parsed.workbook.slice(0, 300));

console.log("\n── the four sheets carry only what the record supports ──");
/* The mapping lives in plans.js next to the button; loading the whole plans
   screen in node is not possible, so the mapping is asserted through the
   browser test hook in e2e-takeoff.mjs. Here: the writer's own contract. */
const single = buildXlsx([{ name: "X".repeat(40), rows: [["a"]] }]);
fs.writeFileSync(`${out}2`, single);
const longName = execFileSync("python3", ["-c", `
import zipfile
z = zipfile.ZipFile("${out}2")
print(z.read("xl/workbook.xml").decode())
`]).toString();
fs.unlinkSync(`${out}2`);
check("a sheet name longer than Excel's 31-character limit is trimmed",
  /name="X{31}"/.test(longName) && !/X{32}/.test(longName), longName.slice(0, 200));

console.log(bad ? `\n${bad} FAILURES` : "\nALL OK");
process.exit(bad ? 1 : 0);
