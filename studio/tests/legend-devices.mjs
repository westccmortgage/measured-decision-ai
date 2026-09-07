/* The legend is scope.
 *
 * 4423 Noble prints an ELECTRICAL SYMBOL LEGEND — Wall Switch, Wall 3Way
 * Switch, Wall 3Way Switch w/ Dimmer, Wall Switch w/ Dimmer, Wall Switch
 * w/ Occupancy Sensor — and the v3 reading recorded none of it: the
 * contract asked for schedules, a legend prints no QTY column, and the
 * switches survived only as a word in the "Electrical and lighting" scope
 * sentence. A person opening the result did not see this info.
 *
 * Now the contract says a legend of countable devices is scope: one row
 * per legend entry, category electrical_device, count_drawn from the
 * symbols counted on the plans, and a row even when none was found. The
 * schema admits the category, and the result page gives it a section with
 * the same words for how.
 */
import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";
import http from "http"; import fs from "fs"; import path from "path";
import { deckTakeoffRows } from "./seed.mjs";

let bad = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? `\n         ${detail}` : ""}`);
  if (!ok) bad++;
};

console.log("── the contract and the schema ──");
const CONTRACT = fs.readFileSync("supabase/functions/_shared/agent-contracts.ts", "utf8");
const SCHEMA = fs.readFileSync("supabase/functions/plan-analyze/index.ts", "utf8");
const version = CONTRACT.match(/AGENT_CONTRACT_VERSION = "([^"]+)"/)?.[1] || "";
check("the contract names the legend as scope, with the switch tags a set prints",
  /ELECTRICAL SYMBOL LEGEND/.test(CONTRACT) && /S3D/.test(CONTRACT) && /SOS occupancy sensor/.test(CONTRACT) && /category electrical_device/.test(CONTRACT));
check("a legend prints no quantity, so the count comes from symbols counted on the plans, sheet by sheet",
  /count_scheduled is 0 — a legend prints no quantity/.test(CONTRACT) && /count_drawn is the number of that symbol you counted on every floor plan/.test(CONTRACT));
check("a symbol defined but not found is still a row, so a person sees what the set defines",
  /the row still exists with all counts 0/.test(CONTRACT));
check("naming switches in a scope sentence and recording no rows is the named failure",
  /Naming switches in a system's scope sentence and recording no rows is the failure this rule refuses/.test(CONTRACT));
check("the contract version moved, so the next reading is a new reading and not a reuse", version > "2026-09-06.1", version);
check("the schema admits the category", /"electrical_fixture", "electrical_device", "mechanical_equipment"/.test(SCHEMA));

console.log("\n── the result page ──");
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
const device = (mark, description, counts, extra = {}) => ({
  mark, category: "electrical_device", description, unit: "each",
  count_scheduled: 0, count_drawn: 0, count_proposed: 0, count_confidence: "none", count_note: "", source_refs: ["A-310 (original p16)"], ...counts, ...extra,
});
const w = deckTakeoffRows();
w.properties[0].name = "4423 Noble";
w.document_baselines[0].state = "review";
w.document_baselines[0].approved_at = null;
w.document_baselines[0].analysis = {
  framing_walls: [], framing_decks: [], levels: [], systems: [],
  component_schedules: [
    { mark: "F1", category: "electrical_fixture", description: "(N) 6\" Recessed CFL downlight", unit: "each", count_scheduled: 36, count_drawn: 0, count_proposed: 36, count_confidence: "high", count_note: "", source_refs: ["A-310 (original p16)"] },
    device("S", "Wall Switch", { count_drawn: 14, count_confidence: "high", count_note: "First floor 8, second floor 6 — p16/A-310" }),
    device("S3", "Wall 3Way Switch", { count_drawn: 6, count_confidence: "high" }),
    device("S3D", "Wall 3Way Switch w/ Dimmer", { count_proposed: 2, count_confidence: "low", count_note: "labels cropped at the stair" }),
    device("SOS", "Wall Switch w/ Occupancy Sensor", { count_note: "legend defines it; no instance found drawn" }),
  ],
};
w.document_baselines[0].gaps = [];
w.material_takeoffs = [];
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await context.route("**://*/**", (r) => (r.request().url().startsWith(base) ? r.continue() : r.abort()));
await context.addInitScript(`window.__seed = ${JSON.stringify({ rows: w })};`);
await context.addInitScript({ path: "studio/tests/fake-supabase.js" });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
await page.goto(`${base}/studio/plans/?property=${w.properties[0].id}`, { waitUntil: "networkidle" });
await page.waitForTimeout(800);
const summary = await page.evaluate(() => ({
  read: document.getElementById("summary-read")?.textContent.replace(/\s+/g, " ").trim() || "",
  numbers: [...document.querySelectorAll("#summary-numbers article")].map((a) => a.textContent.replace(/\s+/g, " ").trim()),
}));
check("the summary counts the devices beside the fixtures", /Lighting and electrical 1/.test(summary.read) && /Electrical devices 4/.test(summary.read), summary.read);
check("and the total counts every row", summary.numbers.some((n) => /^5\s*scheduled items read$/.test(n)), JSON.stringify(summary.numbers));
await page.evaluate(() => document.getElementById("summary-full")?.click());
await page.waitForTimeout(300);
const section = await page.evaluate(() => {
  const details = document.querySelector('[data-result-section="electrical_device"]');
  return {
    exists: !!details, open: details?.open,
    title: details?.querySelector("summary")?.textContent.replace(/\s+/g, " ").trim() || "",
    rows: [...(details?.querySelectorAll("tbody tr") || [])].map((tr) => tr.innerText.replace(/\s+/g, " ").trim()),
  };
});
check("the result has an Electrical devices section, open, with every legend row", section.exists && section.open === true && /^Electrical devices 4 scheduled items$/.test(section.title) && section.rows.length === 4, JSON.stringify([section.title, section.rows.length]));
check("a symbol counted on the plans says so, with its count", /^S Wall Switch .*14 each Counted on plan/i.test(section.rows[0]), section.rows[0]);
check("a proposal says its confidence", /S3D .* 2 each Proposed · low confidence/i.test(section.rows[2]), section.rows[2]);
check("a symbol defined and not found is a row that says not determinable, not a silence", /SOS .* Not determinable/i.test(section.rows[3]) && /no instance found drawn/.test(section.rows[3]), section.rows[3]);
check("nothing threw", errors.length === 0, errors[0] || "");
await context.close();
await browser.close();
server.close();
console.log(bad ? `\n${bad} FAILURES` : "\nALL OK");
process.exit(bad ? 1 : 0);
