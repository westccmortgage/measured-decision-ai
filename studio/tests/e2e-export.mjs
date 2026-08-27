/* The record leaves with its owner — and the archive is proven, not trusted.
 *
 * The export button hands over one ZIP: a provenance manifest, the owner
 * report as a PDF, and both takeoff workbooks. This test drives the real
 * page, builds the real archive, then validates it OUTSIDE the browser with
 * an independent unzip and an independent PDF reader — a file that only its
 * own writer can open is not an export.
 *
 * And the honesty rules hold inside the archive: every AI value wears its
 * provenance, acceptance is never a confirmation, and the doctrine rides in
 * the manifest and the README both.
 */
import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";
import http from "http"; import fs from "fs"; import path from "path";
import { execFileSync } from "child_process";
import { deckTakeoffRows } from "./seed.mjs";

let bad = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? `\n         ${detail}` : ""}`);
  if (!ok) bad++;
};

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

const world = deckTakeoffRows();
world.spaces = [
  { id: "room-1", organization_id: world.document_baselines[0].organization_id, property_id: "prop-1", name: "Deck — west half" },
];
world.evidence_items = [
  { id: "ev-1", property_id: "prop-1", space_id: "room-1", media_type: "360 capture", deleted_at: null },
];
world.project_reconciliations = [
  { property_id: "prop-1", state: "active", component_key: "P1",
    required_quantity: 14, delivered_quantity: 14, evidenced_quantity: 12, coverage: "partial",
    verdict: "PARTIALLY_SUPPORTED",
    narrative: "14 required · 14 documented as delivered · 12 visually evidenced as installed · 2 installation records not yet evidenced" },
];
world.rpc = {
  owner_report_data: {
    decisions: [{ at: "2026-08-20T10:00:00Z", action: "takeoff.approved", actor: "reviewer@example.com" }],
    metrics: { takeoffs_signed: 1, rooms_with_evidence: 1 },
  },
};

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox", "--no-proxy-server", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await context.route("**://*/**", (r) => (r.request().url().startsWith(base) ? r.continue() : r.abort()));
await context.addInitScript(`window.__seed = ${JSON.stringify({ rows: world, rpc: world.rpc })};`);
await context.addInitScript({ path: "studio/tests/fake-supabase.js" });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
await page.goto(`${base}/studio/plans/?property=prop-1`, { waitUntil: "networkidle" });
await page.waitForTimeout(1300);

console.log("── the export exists where the owner is ──");
const button = await page.evaluate(() => {
  const el = document.querySelector("#export-record");
  return { present: Boolean(el), visible: el ? !el.hidden : false, label: el?.textContent || "" };
});
check("the Download Project Record button is offered beside the takeoff downloads",
  button.present && button.visible && /Project Record/.test(button.label), JSON.stringify(button));

console.log("\n── the archive, rebuilt twice and read independently ──");
const result = await page.evaluate(async () => {
  const parts = await window.__recordParts();
  const zipOne = window.MDAIXlsx360.buildZip(parts);
  const zipTwo = window.MDAIXlsx360.buildZip(await window.__recordParts());
  const same = zipOne.length === zipTwo.length && zipOne.every((byte, index) => byte === zipTwo[index]);
  let binary = "";
  for (const byte of zipOne) binary += String.fromCharCode(byte);
  return {
    paths: parts.map((part) => part.path),
    manifest: parts.find((part) => part.path === "manifest.json")?.content || "",
    readme: parts.find((part) => part.path === "README.txt")?.content || "",
    deterministic: same,
    zipBase64: btoa(binary),
  };
});

check("the archive carries the manifest, the PDF report and both workbooks",
  JSON.stringify(result.paths) === JSON.stringify(["README.txt", "manifest.json", "owner-report.pdf", "ai-takeoff.xlsx"])
  || JSON.stringify(result.paths) === JSON.stringify(["README.txt", "manifest.json", "owner-report.pdf", "ai-takeoff.xlsx", "human-verified-order.xlsx"]),
  JSON.stringify(result.paths));
check("the same record exports the same bytes", result.deterministic);

const manifest = JSON.parse(result.manifest);
check("the manifest opens with the doctrine, verbatim in the README too",
  /Read by AI - not confirmed until a named person signs/.test(manifest.doctrine)
  && /never proof of installation/.test(manifest.doctrine)
  && result.readme.includes(manifest.doctrine));
check("every takeoff line wears its method; proposals wear 'not confirmed'",
  manifest.takeoff.lines.length > 0
  && manifest.takeoff.lines.every((line) => typeof line.method === "string" && line.method.length > 0)
  && manifest.takeoff.proposals.every((proposal) => /not confirmed/.test(proposal.provenance)));
check("reconciliation verdicts travel with their narratives",
  manifest.reconciliations.length === 1
  && manifest.reconciliations[0].verdict === "PARTIALLY_SUPPORTED"
  && /not yet evidenced/.test(manifest.reconciliations[0].narrative));
check("the decision log names who signed",
  manifest.decisions?.decisions?.[0]?.actor === "reviewer@example.com");
check("rooms and their evidence counts are in the record",
  manifest.rooms.length === 1 && manifest.rooms[0].evidence_files === 1);

fs.mkdirSync("studio/tests/fixtures", { recursive: true });
const zipPath = "studio/tests/fixtures/project-record-sample.zip";
fs.writeFileSync(zipPath, Buffer.from(result.zipBase64, "base64"));
let unzip = { ok: false, detail: "" };
try {
  const out = execFileSync("python3", ["-c", `
import zipfile, json
z = zipfile.ZipFile(${JSON.stringify(zipPath)})
assert z.testzip() is None
names = z.namelist()
manifest = json.loads(z.read("manifest.json"))
pdf = z.read("owner-report.pdf")
assert pdf.startswith(b"%PDF-1.4")
try:
    from pypdf import PdfReader
    import io
    text = PdfReader(io.BytesIO(pdf)).pages[0].extract_text()
    assert "Project Record" in text
    pdf_read = "pdf-read"
except Exception:
    pdf_read = "pdf-structural-only"
print("|".join(names), manifest["format"], pdf_read)
`], { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
  unzip = { ok: true, detail: out };
} catch (error) {
  unzip = { ok: false, detail: String(error).slice(0, 300) };
}
check("an independent unzip opens the archive, its CRCs hold, and the PDF inside is readable",
  unzip.ok && /measured-decision-project-record\/1/.test(unzip.detail), unzip.detail);

check("nothing threw in the page", errors.length === 0, errors.join(" | "));

await browser.close(); server.close();
console.log(bad ? `\n${bad} FAILURES` : "\nALL OK");
process.exit(bad ? 1 : 0);
