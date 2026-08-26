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

console.log("\n── determinism, structure, and a real spreadsheet app ──");
{
  const again = buildXlsx(sheets);
  check("identical input produces byte-for-byte identical workbooks",
    Buffer.compare(Buffer.from(bytes), Buffer.from(again)) === 0, `${bytes.length} vs ${again.length}`);

  /* OOXML structure, not just zip integrity: every sheet the workbook names
     must have a relationship, a part, and a content-type override. */
  fs.writeFileSync(out, bytes);
  const structure = JSON.parse(execFileSync("python3", ["-c", `
import zipfile, json, re
z = zipfile.ZipFile("${out}")
wb = z.read("xl/workbook.xml").decode()
rels = z.read("xl/_rels/workbook.xml.rels").decode()
types = z.read("[Content_Types].xml").decode()
sheet_rids = re.findall(r'r:id="(rId\\d+)"', wb)
rel_map = dict(re.findall(r'Id="(rId\\d+)" [^>]*Target="([^"]+)"', rels))
result = {
  "every_sheet_has_rel": all(rid in rel_map for rid in sheet_rids),
  "every_target_exists": all(("xl/" + t) in z.namelist() for t in rel_map.values()),
  "every_part_typed": all(("<Override PartName=\\"/xl/worksheets/sheet%d.xml\\"" % (i+1)) in types for i in range(len(sheet_rids))),
  "styles_rel": any(t == "styles.xml" for t in rel_map.values()),
}
print(json.dumps(result))
`]).toString());
  check("every declared sheet has a relationship, a real part, and a content type",
    structure.every_sheet_has_rel && structure.every_target_exists && structure.every_part_typed && structure.styles_rel,
    JSON.stringify(structure));

  /* The independent referee: a real spreadsheet reader opens the file
     read-only, without our writer in the loop. LibreOffice Calc when this
     environment has it; the structural checks above are mandatory either way,
     and a skipped smoke test says so out loud instead of passing silently. */
  const smokeDir = path.join("studio", "tests", "fixtures", "soffice-smoke");
  fs.mkdirSync(smokeDir, { recursive: true });
  let smoke = "";
  let readerAvailable = true;
  try {
    execFileSync("soffice", ["--headless", "--convert-to", "csv", "--outdir", smokeDir, out], { timeout: 90000, stdio: "pipe" });
  } catch (error) {
    const said = `${error.stdout || ""}${error.stderr || ""}`;
    if (/could not be loaded|command not found|ENOENT/.test(said) && !fs.readdirSync(smokeDir).some((name) => name.endsWith(".csv"))) {
      readerAvailable = false;
    }
  }
  const produced = fs.readdirSync(smokeDir).find((name) => name.endsWith(".csv"));
  smoke = produced ? fs.readFileSync(path.join(smokeDir, produced), "utf8") : "";
  fs.rmSync(smokeDir, { recursive: true, force: true });
  if (readerAvailable || smoke) {
    check("LibreOffice opens the workbook and reads the cells back",
      /2x6 deck boards — F\.R\.T\./.test(smoke) && /3280/.test(smoke), smoke.slice(0, 160));
  } else {
    console.log("  ok   (skipped) no spreadsheet reader in this environment — structural OOXML checks above still hold");
  }
  fs.unlinkSync(out);
}

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
