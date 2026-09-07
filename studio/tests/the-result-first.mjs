/* The result first.
 *
 * A reading of a plan set produces what the sheets state and what the
 * reader could not settle. The screen used to lead with the second and
 * never showed the first: the doors, windows and fixtures the reader had
 * copied from the schedules were not on it anywhere. This walks the real
 * plans page with a baseline that carries schedule rows of every
 * provenance and questions of every severity, and proves:
 *
 *   - the status says complete and review required, never a percentage;
 *   - three questions come first, chosen by a written rule;
 *   - sections by kind, each row with mark, description, quantity, unit,
 *     how the quantity was arrived at, and a source that opens the sheet
 *     at its page in the file that holds it;
 *   - framing and foundation say honestly that they were not read as a
 *     schedule when this reading had no field for them;
 *   - every question the reading raised is still there, under one
 *     disclosure, closed by default;
 *   - the rebuild offer looks past a rebuild to the reading made in parts.
 */
import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";
import http from "http"; import fs from "fs"; import path from "path";
import { deckTakeoffRows, planDocument } from "./seed.mjs";

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
const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox", "--no-proxy-server", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});

const row = (mark, category, extra = {}) => ({
  mark, category, description: `${category} ${mark}`, unit: "each",
  count_scheduled: 0, count_drawn: 0, count_proposed: 0, count_confidence: "none", count_note: "", source_refs: [], ...extra,
});
const gap = (severity, question, blocks, extra = {}) => ({ severity, question, source_refs: [], blocks_activation: blocks, ...extra });

/* A split set: part 1 pages 1-25, part 2 pages 26-30, plus a whole set that
   was never split — the scheduled rows cite pages of the split set. */
function world() {
  const w = deckTakeoffRows();
  const parent = "doc-set";
  w.project_documents = [
    planDocument({ id: parent, original_filename: "Set.pdf", document_type: "architectural", status: "ready", byte_size: 200 * 1024 * 1024 }),
    planDocument({ id: "doc-p1", original_filename: "Set (pages 1-25).pdf", document_type: "architectural", status: "ready", byte_size: 40 * 1024 * 1024,
      source_metadata: { derived_from: { document_id: parent, page_from: 1, page_to: 25, pages_total: 30, part: 1, parts: 2 } } }),
    planDocument({ id: "doc-p2", original_filename: "Set (pages 26-30).pdf", document_type: "structural", status: "ready", byte_size: 10 * 1024 * 1024,
      source_metadata: { derived_from: { document_id: parent, page_from: 26, page_to: 30, pages_total: 30, part: 2, parts: 2 } } }),
  ];
  w.document_baselines[0].analysis = {
    framing_walls: [], framing_decks: [],
    levels: [{ building: "B", name: "First Floor", source_refs: [] }],
    systems: [],
    component_schedules: [
      row("101", "door", { description: "Type A; 3'-0\" x 6'-8\"", count_scheduled: 1, count_drawn: 1, count_proposed: 1, count_confidence: "high", source_refs: ["A-710 (original p20), Door Schedule", "A-210 (original p14)"] }),
      row("102", "door", { count_drawn: 2, count_proposed: 2, count_confidence: "high", source_refs: ["A-210 (original p14)"] }),
      row("01", "window", { count_proposed: 3, count_confidence: "medium", count_note: "two tags partly covered by a leader", source_refs: ["A-210 (original p14)"] }),
      row("02", "window", { source_refs: ["A-710 (original p20)"] }),
      row("F1", "electrical_fixture", { description: "6\" recessed downlight", count_scheduled: 36, count_proposed: 36, count_confidence: "high", source_refs: ["A-310 (original p16)"] }),
      row("F9", "electrical_fixture", { description: "LED strip", unit: "ft", count_scheduled: 9, count_proposed: 9, count_confidence: "high", count_note: "linear material, not nine fixtures", source_refs: ["A-310 (original p16)"] }),
      row("WH-1", "plumbing_fixture", { count_scheduled: 1, count_proposed: 1, count_confidence: "high", source_refs: ["S-4 (original p27)"] }),
    ],
  };
  w.document_baselines[0].gaps = [
    gap("informational", "Read in chunk 2 of 2 of this same reading — part 1 of 2. This question stood only because…", false, { read_in_chunk: 2 }),
    gap("important", "Confirm whether S-8 (2020) is the current detail sheet.", true),
    gap("critical", "Which issue status governs? NOT FOR CONSTRUCTION on every sheet.", true),
    gap("critical", "Resolve the fire-sprinkler conflict between A-002 and A-210.", true),
    gap("critical", "The grading report describes a four-story building.", true),
    gap("critical", "Project numbers differ: 1507-GS and 2306-NA.", true),
    gap("important", "Repeated CALI. ROOF labels: confirm distinct areas.", false),
    gap("informational", "This set was analyzed in 2 chunks…", false),
  ];
  w.material_takeoffs = [];
  /* Under review, not yet approved: the state the result screen is for. */
  w.document_baselines[0].state = "review";
  w.document_baselines[0].approved_at = null;
  return w;
}

async function openPlans(w, extra = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route("**://*/**", (r) => (r.request().url().startsWith(base) ? r.continue() : r.abort()));
  await context.addInitScript(`window.__seed = ${JSON.stringify({ rows: w, ...extra })};`);
  await context.addInitScript({ path: "studio/tests/fake-supabase.js" });
  const page = await context.newPage();
  await page.goto(`${base}/studio/plans/?property=${w.properties[0].id}`, { waitUntil: "networkidle" });
  await page.evaluate(() => document.getElementById("summary-full")?.click());
  await page.waitForSelector("#baseline-section:not([hidden])");
  return { context, page };
}

console.log("── the result first ──");
{
  const { context, page } = await openPlans(world());
  const status = await page.evaluate(() => document.getElementById("result-status")?.textContent || "");
  check("the status says complete and review required, with what blocks — and no percentage",
    /^Analysis complete · Review required · 5 questions block activation$/.test(status.trim()) && !/%/.test(status), status);
  const progress = await page.evaluate(() => ({
    title: document.getElementById("analysis-stage-title")?.textContent || document.querySelector(".analysis-stage-title, #analysis-progress h3, #analysis-progress strong")?.textContent || "",
    value: document.getElementById("analysis-progress-value")?.textContent || "",
  }));
  check("the progress card no longer says 100% beside a review that is required", !/100%/.test(progress.value), JSON.stringify(progress));

  const first = await page.evaluate(() => [...document.querySelectorAll("#result-conflicts li")].map((li) => li.textContent));
  check("three questions come first: the first critical blockers, in the order the reading gave them",
    first.length === 3 && /issue status/.test(first[0]) && /fire-sprinkler/.test(first[1]) && /grading report/.test(first[2]), JSON.stringify(first));
  check("never a question the reading marked as read elsewhere, never a non-blocker", !first.some((q) => /Read in chunk|CALI\. ROOF/.test(q)));
  check("and the rule is written on the screen", /Chosen by rule: the first critical questions that block activation/.test(await page.evaluate(() => document.getElementById("result-rule")?.textContent || "")));

  const sections = await page.evaluate(() => [...document.querySelectorAll("[data-result-section]")].map((d) => ({
    key: d.dataset.resultSection, open: d.open, summary: d.querySelector("summary")?.textContent.replace(/\s+/g, " ").trim(), rows: d.querySelectorAll("tbody tr").length,
  })));
  const byKey = Object.fromEntries(sections.map((s) => [s.key, s]));
  check("sections by kind, in a fixed order, only the kinds that were read or are always expected",
    sections.map((s) => s.key).join(",") === "door,window,electrical_fixture,plumbing_fixture,framing,foundation", sections.map((s) => s.key).join(","));
  check("Doors: 2 rows; Windows: 2; Lighting: 2; Plumbing: 1 — counts on the summary line",
    byKey.door.rows === 2 && /2 scheduled items/.test(byKey.door.summary) && byKey.window.rows === 2 && byKey.electrical_fixture.rows === 2 && byKey.plumbing_fixture.rows === 1 && /1 scheduled item\b/.test(byKey.plumbing_fixture.summary));
  check("sections with rows are open; framing and foundation say honestly that they were not read as a schedule",
    byKey.door.open && !byKey.framing.open && /not yet read as a schedule/.test(byKey.framing.summary) && /not yet read as a schedule/.test(byKey.foundation.summary));
  const framingText = await page.evaluate(() => document.querySelector('[data-result-section="framing"] .result-empty')?.textContent || "");
  check("and say why, without measuring anything by scale", /had no field for them|until the structural reading is added/.test(framingText) && /nothing here is measured by scale/.test(framingText));

  const rows = await page.evaluate(() => [...document.querySelectorAll("#result-sections tbody tr")].map((tr) => {
    const cells = [...tr.children].map((td) => td.textContent.replace(/\s+/g, " ").trim());
    return { mark: cells[0], qty: cells[2], unit: cells[3], how: tr.querySelector(".prov")?.className.replace("prov ", ""), howText: cells[4], source: cells[5] };
  }));
  const find = (mark) => rows.find((r) => r.mark === mark);
  check("a printed quantity is called printed, and shows the schedule's number",
    find("101").how === "printed" && find("101").qty === "1" && find("F1").qty === "36" && find("F1").how === "printed");
  check("a count made on the plan is called counted", find("102").how === "counted" && find("102").qty === "2");
  check("a proposal carries its confidence", find("01").how === "proposed" && /Proposed · medium confidence/.test(find("01").howText) && find("01").qty === "3");
  check("what could not be determined says so and shows no number", find("02").how === "unknown" && find("02").qty === "—");
  check("units are the schedule's units: F9 is 9 ft, not nine fixtures", find("F9").qty === "9" && find("F9").unit === "ft");
  check("every row names its sheet and page", find("101").source === "A-710 · p20, A-210 · p14" && find("WH-1").source === "S-4 · p27", JSON.stringify([find("101").source, find("WH-1").source]));

  /* A source opens the sheet at its page, in the part that holds it. */
  await page.evaluate(() => [...document.querySelectorAll('[data-open-sheet]')].find((b) => b.textContent === "S-4 · p27")?.click());
  await page.waitForSelector("#search-source-dialog iframe");
  const opened = await page.evaluate(() => ({
    src: document.querySelector("#search-source-dialog iframe")?.getAttribute("src") || "",
    note: document.querySelector("#search-source-dialog p")?.textContent || "",
    title: document.querySelector("#search-source-dialog h2")?.textContent || "",
  }));
  check("original page 27 opens part 2 at its page 2, and says both numbers",
    /#page=2$/.test(opened.src) && /Set \(pages 26-30\)\.pdf/.test(opened.title) && /Page 2 of this file — original page 27 of the set/.test(opened.note), JSON.stringify(opened));
  await page.evaluate(() => document.getElementById("search-source-dialog")?.close());
  await page.evaluate(() => [...document.querySelectorAll('[data-open-sheet]')].find((b) => b.textContent === "A-710 · p20")?.click());
  await page.waitForSelector("#search-source-dialog iframe");
  const openedOne = await page.evaluate(() => document.querySelector("#search-source-dialog iframe")?.getAttribute("src") || "");
  check("original page 20 opens part 1 at its page 20", /#page=20$/.test(openedOne), openedOne);

  const audit = await page.evaluate(() => {
    const details = document.getElementById("result-audit");
    return { open: details?.open, summary: details?.querySelector("summary")?.textContent || "", rows: details?.querySelectorAll(".gap-item").length };
  });
  check("every question the reading raised is under one disclosure, closed by default, counted",
    audit.open === false && /Audit · every question this reading raised \(8\)/.test(audit.summary) && audit.rows === 8, JSON.stringify(audit));
  check("the words the reader uses for itself are not in the result sections",
    !/\b(chunk|component_schedules|database)\b/i.test(await page.evaluate(() => document.getElementById("result-sections")?.textContent || "")));
  await context.close();
}

console.log("\n── the structural reading, once it exists ──");
{
  const w = world();
  w.document_baselines[0].analysis.structural_members = [
    { mark: "FB1", member_type: "beam", description: "3-1/2 x 11-7/8 LVL", size: "", spacing: "", material: "LVL", level: "Second Floor", location: "", unit: "each", count_scheduled: 2, count_drawn: 2, count_proposed: 2, count_confidence: "high", count_note: "", length_printed: "", detail_refs: ["S-6/4"], source_refs: ["S-3 (original p25)"] },
    { mark: "HDR4", member_type: "header", description: "Parallam PSL 2.0E 3.50 x 18.0", size: "", spacing: "", material: "PSL", level: "", location: "", unit: "each", count_scheduled: 0, count_drawn: 3, count_proposed: 3, count_confidence: "high", count_note: "", length_printed: "", detail_refs: [], source_refs: ["S-3 (original p25)"] },
    { mark: "F1", member_type: "footing", description: "24 x 24 x 12 concrete", size: "", spacing: "", material: "concrete", level: "", location: "", unit: "each", count_scheduled: 0, count_drawn: 4, count_proposed: 4, count_confidence: "high", count_note: "", length_printed: "", detail_refs: ["S-5/1"], source_refs: ["S-2 (original p24)"] },
    { mark: "HDU4", member_type: "holdown", description: "Simpson HDU4", size: "", spacing: "", material: "", level: "", location: "", unit: "each", count_scheduled: 0, count_drawn: 0, count_proposed: 0, count_confidence: "none", count_note: "locations not read", length_printed: "", detail_refs: [], source_refs: ["S-5 (original p27)"] },
  ];
  w.document_baselines[0].analysis.framing_defaults = [
    { rule: "ALL STUDS 2x4 #2 @ 16\" O.C. U.N.O.", applies_to: "bearing and non-bearing wood stud walls", exception: "unless noted otherwise", source_refs: ["S-3 (original p25), notes 5 and 7"] },
  ];
  const { context, page } = await openPlans(w);
  const framing = await page.evaluate(() => {
    const d = document.querySelector('[data-result-section="framing"]');
    return { open: d.open, summary: d.querySelector("summary").textContent.replace(/\s+/g, " ").trim(), rows: [...d.querySelectorAll("tbody tr")].map((tr) => [...tr.children].map((td) => td.textContent.replace(/\s+/g, " ").trim())), rule: d.querySelector(".result-rules li")?.textContent.replace(/\s+/g, " ").trim() || "", provs: [...d.querySelectorAll("tbody .prov")].map((p) => p.className) };
  });
  check("Structural framing opens with every member it recorded and its printed rule", framing.open && /2 members · 2 with a quantity · 1 printed rule/.test(framing.summary), framing.summary);
  check("a scheduled beam is a printed quantity; a header counted on the plan is a count",
    framing.rows.some((r) => r[0] === "FB1" && /^beam · 3-1\/2 x 11-7\/8 LVL/.test(r[1]) && r[2] === "2" && r[3] === "each") && framing.provs.includes("prov printed")
    && framing.rows.some((r) => r[0] === "HDR4" && /^header · /.test(r[1]) && r[2] === "3") && framing.provs.includes("prov counted"), JSON.stringify(framing.rows));
  check("the printed stud rule is a project requirement with its exception, never our assumption",
    /Printed rule/.test(framing.rule) && /ALL STUDS 2x4 #2 @ 16" O\.C\. U\.N\.O\./.test(framing.rule) && /\(unless noted otherwise\)/.test(framing.rule) && /S-3 · p25/.test(framing.rule), framing.rule);
  check("the beam's detail is one of its sources", framing.rows.some((r) => r[0] === "FB1" && /S-3 · p25, S-6\/4/.test(r[5])), JSON.stringify(framing.rows.map((r) => r[5])));
  const foundation = await page.evaluate(() => {
    const d = document.querySelector('[data-result-section="foundation"]');
    return { open: d.open, summary: d.querySelector("summary").textContent.replace(/\s+/g, " ").trim(), rows: [...d.querySelectorAll("tbody tr")].map((tr) => [...tr.children].map((td) => td.textContent.replace(/\s+/g, " ").trim())), provs: [...d.querySelectorAll("tbody .prov")].map((p) => p.className) };
  });
  check("Foundation holds the footing, counted on the plan, and the hold-down nobody could count — as a row that says so",
    foundation.open && /2 members · 1 with a quantity/.test(foundation.summary) && foundation.rows.length === 2
    && foundation.rows.some((r) => r[0] === "F1" && /^footing · 24 x 24 x 12 concrete/.test(r[1]) && r[2] === "4")
    && foundation.rows.some((r) => r[0] === "HDU4" && /^hold-down · Simpson HDU4/.test(r[1]) && r[2] === "—" && /locations not read/.test(r[1]))
    && foundation.provs.includes("prov counted") && foundation.provs.includes("prov unknown"), JSON.stringify(foundation));
  const takeoffGaps = await page.evaluate(() => document.getElementById("takeoff-section")?.textContent || "");
  check("and the takeoff still carries it as a question, not a line", /hold-down HDU4/.test(takeoffGaps));
  await context.close();
}

console.log("\n── nothing blocks ──");
{
  const w = world();
  w.document_baselines[0].gaps = [gap("informational", "Finish legend abbreviations", false)];
  const { context, page } = await openPlans(w);
  const status = await page.evaluate(() => document.getElementById("result-status")?.textContent || "");
  const first = await page.evaluate(() => [...document.querySelectorAll("#result-conflicts li")].map((li) => li.textContent));
  check("when nothing blocks, the status says so and the first-three list says so — review is still required",
    /^Analysis complete · Review required$/.test(status.trim()) && first.length === 1 && /Nothing blocks activation\. Human review is still required\./.test(first[0]), JSON.stringify({ status, first }));
  await context.close();
}

console.log("\n── the rebuild offer looks past a rebuild ──");
{
  const w = world();
  const org = w.properties[0].organization_id, property = w.properties[0].id;
  w.plan_analysis_jobs = [
    { id: "job-rebuild", organization_id: org, property_id: property, state: "completed", baseline_id: w.document_baselines[0].id, progress_stage: "completed", progress_percent: 100, error_code: null, error_message: null, started_at: "2026-09-06T22:33:00Z", created_at: "2026-09-06T22:33:00Z" },
    { id: "job-parts", organization_id: org, property_id: property, state: "completed", baseline_id: w.document_baselines[0].id, progress_stage: "completed", progress_percent: 100, error_code: null, error_message: null, started_at: "2026-09-06T18:18:00Z", created_at: "2026-09-06T18:18:00Z" },
  ];
  w.plan_analysis_chunks = [
    { id: "c0", job_id: "job-parts", organization_id: org, chunk_index: 0, state: "complete", document_ids: ["doc-p2"] },
    { id: "c1", job_id: "job-parts", organization_id: org, chunk_index: 1, state: "complete", document_ids: ["doc-p1"] },
  ];
  const { context, page } = await openPlans(w, { functions: { "plan-analyze": { byAction: { rebuild: { job_id: "job-rebuild-2", baseline_id: "b3", version: 3, state: "completed", parts: 2, provider_calls: 0 } } } } });
  const offer = await page.evaluate(() => ({ hidden: document.getElementById("rebuild-offer")?.hidden, note: document.getElementById("rebuild-note")?.textContent || "" }));
  check("after a rebuild the offer still stands, for the reading that was made in parts", offer.hidden === false && /made in 2 parts/.test(offer.note), JSON.stringify(offer));
  await page.click("#rebuild-baseline");
  await page.waitForTimeout(500);
  const sent = await page.evaluate(() => window.__rpcCalls.filter((c) => c.name === "plan-analyze" && c.args?.action === "rebuild").map((c) => c.args.job_id));
  check("and it rebuilds from those parts, not from the rebuild", JSON.stringify(sent) === '["job-parts"]', JSON.stringify(sent));
  await context.close();
}

await browser.close();
server.close();
console.log(bad ? `\n${bad} FAILURES` : "\nALL OK");
process.exit(bad ? 1 : 0);
