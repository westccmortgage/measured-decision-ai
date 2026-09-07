/* THE COMPARISON, WALKED THROUGH THE REAL SCREEN.
 *
 * Stubbed answers, no key, no call, no money. What this holds:
 *
 *   - the button appears only once there is more than one reader to compare,
 *     and only for someone who may spend;
 *   - pressing it is what buys the comparison — opening the project does not;
 *   - re-opening a comparison already made shows it again and buys nothing;
 *   - a winner is named only when the checked findings separate the readers,
 *     and "No clear winner" is shown plainly when they do not;
 *   - readings made under different conditions are not called a fair
 *     comparison, and the difference is on the screen;
 *   - a failed reading makes the comparison incomplete, and nothing reruns;
 *   - A, B and C are named on the screen, and the screen says the winner does
 *     not become the baseline.
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

const CATALOGUE = {
  providers: [
    { provider: "openai", label: "OpenAI", mode: "background", configured: true, image_budget: 80, source: "developers.openai.com", models: [{ id: "gpt-5.6-sol", label: "GPT-5.6 Sol", input_per_mtok: 4, output_per_mtok: 20, price_status: "promotional", price_note: "" }] },
    { provider: "anthropic", label: "Claude", mode: "sync", configured: true, image_budget: 20, source: "platform.claude.com", models: [{ id: "claude-opus-5", label: "Claude Opus 5", input_per_mtok: 5, output_per_mtok: 25, price_status: "confirmed", price_note: "" }] },
    { provider: "google", label: "Gemini", mode: "sync", configured: true, image_budget: 20, source: "ai.google.dev", models: [{ id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro (preview)", input_per_mtok: null, output_per_mtok: null, price_status: "not_confirmed", price_note: "" }] },
  ],
  default_provider: "openai",
};

const run = (provider, label, model, budget = 20) => ({
  provider, provider_label: label, model, model_label: model, image_budget: budget,
  agent_contract_version: "2026-09-07.1",
  usage: { input_tokens: 120000, output_tokens: 14000 }, duration_ms: 96000,
  cost_usd: 0.95, price_status: "confirmed", price_note: "",
});

/* One project, three readings of the same three sheets. */
function world({ role = "owner", budgets = [20, 20, 20], analyses = [true, true, true] } = {}) {
  const w = deckTakeoffRows();
  w.properties[0].name = "4423 Noble";
  w.organization_members[0].role = role;
  const property = w.properties[0].id;
  const org = w.properties[0].organization_id;
  w.project_documents = [planDocument({ id: "doc-a", original_filename: "S-2 S-3 S-4.pdf", document_type: "structural", status: "ready", byte_size: 4 * 1024 * 1024 })];
  const reading = (id, version, provider, label, model, budget, hasAnalysis) => ({
    id, organization_id: org, property_id: property, version, state: "review",
    source_document_ids: ["doc-a"], project_summary: `${label} read this set.`,
    analysis: hasAnalysis ? { framing_walls: [], framing_decks: [], levels: [], systems: [], component_schedules: [], structural_members: [] } : {},
    gaps: [], model, provider, analysis_run: run(provider, label, model, budget),
    agent_contract_version: "2026-09-07.1", created_at: "2026-09-07T05:00:00Z", approved_at: null,
  });
  w.document_baselines = [
    reading("bl-google", 4, "google", "Gemini", "gemini-3.1-pro-preview", budgets[2], analyses[2]),
    reading("bl-claude", 3, "anthropic", "Claude", "claude-opus-5", budgets[1], analyses[1]),
    reading("bl-openai", 2, "openai", "OpenAI", "gpt-5.6-sol", budgets[0], analyses[0]),
  ];
  w.material_takeoffs = [];
  return w;
}

const SECTIONS = [
  { section: "structural_members", positions: 41, all_three: 22, majority: 9, single_reader: 10, count_differences: 7, unit_differences: 1, scope_flags: 2, by_reading: {} },
  { section: "framing_defaults", positions: 8, all_three: 3, majority: 2, single_reader: 3, count_differences: 0, unit_differences: 0, scope_flags: 0, by_reading: {} },
];

function comparison(over = {}) {
  return {
    id: "cmp-1",
      baseline_ids: ["bl-google", "bl-claude", "bl-openai"],
    plan_document_ids: ["doc-a"],
    agent_contract_version: "2026-09-07.1",
    comparable: true,
    conditions: { comparable: true, differences: [], detail: [] },
    mechanical: { sections: SECTIONS, summary: { positions: 49, all_three: 25, majority: 11, single_reader: 13, count_differences: 7, unit_differences: 1, flagged: 5 }, caveat: "Agreement between readers is not evidence that a reading is right." },
    judge_provider: "openai", judge_model: "gpt-5.6-sol", judge_model_reported: "gpt-5.6-sol",
    blind_map: { A: "bl-claude", B: "bl-openai", C: "bl-google" },
    truth: { absent: true, note: "no control markup" },
    state: "complete", incomplete_reason: null,
    verdict: {
      recommended_reader: "A", recommendation_reason: "It resolved the header sizes from the schedule rather than the plan labels.", confidence: "medium",
      sections: [
        { section: "structural_members", best: "A", why: "the flush beam count matched the marks drawn", per_reader: [] },
        { section: "framing_defaults", best: "tie", why: "both read the same printed rules", per_reader: [] },
      ],
      findings: [
        { reader: "B", section: "structural_members", mark: "R.R.1", kind: "quantity", verdict: "wrong", claim: "12 rafters", why: "twelve framing zones, not twelve rafters", evidence: { sheet: "S-3", page: 25, tile: "p25-r2c1.jpg", what_is_drawn: "zone callouts", marks: [{ label: "R.R.1", where: "north bay" }] } },
        { reader: "A", section: "structural_members", mark: "FB1", kind: "quantity", verdict: "verified", claim: "4 flush beams", why: "four marks drawn", evidence: { sheet: "S-3", page: 25, tile: "p25-r1c1.jpg", what_is_drawn: "four flush beams", marks: [{ label: "FB1", where: "north" }] } },
        { reader: "A", section: "structural_members", mark: "HDR3", kind: "size_or_material", verdict: "verified", claim: "(2) 2x10", why: "header schedule row", evidence: { sheet: "S-4", page: 26, tile: "p26-r1c2.jpg", what_is_drawn: "header schedule", marks: [] } },
        { reader: "C", section: "structural_members", mark: "F2", kind: "quantity", verdict: "could_not_verify", claim: "3 footings", why: "the stair footing was not legible", evidence: { sheet: "S-2", page: 24, tile: "p24-r2c2.jpg", what_is_drawn: "footing plan", marks: [] } },
      ],
      missed_by_all: [{ mark: "F2", section: "structural_members", sheet: "S-2", page: 24, what_is_drawn: "a footing near the east stair" }],
      check_coverage: { positions_checked: 34, positions_not_checked: 15, what_stayed_unresolved: "The unnumbered headers need the printed header table." },
      evidence_downgrades: [],
      tally: { per_reader: { A: { verified: 2, wrong: 0, could_not_verify: 0 }, B: { verified: 0, wrong: 1, could_not_verify: 0 }, C: { verified: 0, wrong: 0, could_not_verify: 1 } }, leader: "A", reason: "counted from the findings that named a place on a sheet, and — for quantities — the marks counted" },
      run: { provider: "openai", provider_label: "OpenAI", model: "gpt-5.6-sol", duration_ms: 141000, usage: { input_tokens: 210000, output_tokens: 9000 }, cost_usd: 1.02, price_status: "promotional" },
    },
    ...over,
  };
}

async function open(w, compareFunctions) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
  await context.route("**://*/**", (r) => (r.request().url().startsWith(base) ? r.continue() : r.abort()));
  await context.addInitScript(`window.__seed = ${JSON.stringify({
    rows: w,
    functions: {
      "plan-analyze": { byAction: { providers: CATALOGUE } },
      "compare-readings": { byAction: compareFunctions },
    },
  })};`);
  await context.addInitScript(`window.confirm = () => true;`);
  await context.addInitScript({ path: "studio/tests/fake-supabase.js" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  await page.goto(`${base}/studio/plans/?property=${w.properties[0].id}`, { waitUntil: "networkidle" });
  await page.evaluate(() => document.getElementById("summary-full")?.click());
  await page.waitForTimeout(600);
  return { context, page, errors };
}

const view = (page) => page.evaluate(() => ({
  barHidden: document.getElementById("compare-bar")?.hidden,
  button: document.getElementById("compare-readings")?.textContent.trim(),
  note: document.getElementById("compare-note")?.textContent.replace(/\s+/g, " ").trim(),
  panelHidden: document.getElementById("comparison")?.hidden,
  verdict: document.getElementById("comparison-verdict")?.textContent.replace(/\s+/g, " ").trim(),
  reason: document.getElementById("comparison-reason")?.textContent.replace(/\s+/g, " ").trim(),
  conditionsHidden: document.getElementById("comparison-conditions")?.hidden,
  conditions: document.getElementById("comparison-conditions")?.textContent.replace(/\s+/g, " ").trim(),
  runLine: document.getElementById("comparison-run")?.textContent.replace(/\s+/g, " ").trim(),
  rows: [...document.querySelectorAll("#comparison-sections tbody tr")].map((tr) => tr.textContent.replace(/\s+/g, " ").trim()),
  top: [...document.querySelectorAll(".comparison-finding")].map((el) => el.textContent.replace(/\s+/g, " ").trim()),
  coverage: document.getElementById("comparison-coverage")?.textContent.replace(/\s+/g, " ").trim(),
  evidence: document.getElementById("comparison-evidence")?.textContent.replace(/\s+/g, " ").trim(),
  calls: window.__rpcCalls.filter((c) => c.name === "compare-readings").map((c) => c.args?.action),
  attachHidden: document.getElementById("attach-truth") === null || document.getElementById("attach-truth").offsetParent === null,
}));

console.log("── the button, and when it is there ──");
{
  const { context, page, errors } = await open(world(), { status: { comparison: null } });
  const shown = await view(page);
  check("three readings by three readers offer a comparison",
    shown.barHidden === false && shown.button === "Compare AI results", JSON.stringify([shown.barHidden, shown.button]));
  check("the note names the readers and says one checker call is what it costs",
    /Gemini/.test(shown.note) && /Claude/.test(shown.note) && /OpenAI/.test(shown.note) && /one checker call/.test(shown.note), shown.note);
  check("opening the project asks only whether a comparison was already made, and buys nothing",
    shown.calls.join(",") === "status", shown.calls.join(","));
  check("no comparison is on the screen until it is asked for", shown.panelHidden === true);
  check("nothing threw", errors.length === 0, errors[0] || "");
  await context.close();
}

console.log("\n── a control markup, attached to the project ──");
{
  const { context, page, errors } = await open(world(), {
    status: { comparison: null },
    attach_truth: { ground_truth: { id: "gt-1", label: "4423 Noble — S-2, S-3, S-4 printed labels" }, entries: 32 },
  });
  const markup = JSON.stringify({
    label: "4423 Noble — S-2, S-3, S-4 printed labels",
    entries: [
      { section: "structural_members", category: "beam", mark: "FB 1", sheet: "S-3", page: 25, count: 12, counted: "labels" },
      { section: "structural_members", category: "rafter", mark: "R.R.1", sheet: "S-4", page: 26, count: 12, counted: "zones" },
      { section: "structural_members", category: "beam", mark: "HIP BM 2", sheet: "S-4", page: 26, count: 4, counted: "labels", disputed: true },
    ],
  });
  await page.setInputFiles("#truth-file", { name: "control-markup.json", mimeType: "application/json", buffer: Buffer.from(markup) });
  await page.waitForTimeout(600);
  const sent = await page.evaluate(() => window.__rpcCalls.filter((c) => c.name === "compare-readings" && c.args?.action === "attach_truth").map((c) => c.args));
  check("the markup is attached to the documents these readings were made from",
    sent.length === 1 && sent[0].entries.length === 3 && sent[0].source_document_ids.join(",") === "doc-a", JSON.stringify(sent[0]?.source_document_ids));
  const said = await page.evaluate(() => document.querySelector(".toast, #toast")?.textContent?.replace(/\s+/g, " ").trim() || "");
  check("and the screen says how many positions it carries and how many are disputed",
    /32 marked positions/.test(said) && /disputed and never used to decide/.test(said), said);
  check("nothing was bought by attaching it",
    (await view(page)).calls.filter((call) => call === "run").length === 0);
  check("nothing threw", errors.length === 0, errors[0] || "");
  await context.close();
}

console.log("\n── a file that is not a control markup ──");
{
  const { context, page } = await open(world(), { status: { comparison: null } });
  await page.setInputFiles("#truth-file", { name: "notes.json", mimeType: "application/json", buffer: Buffer.from("{\"entries\":[]}") });
  await page.waitForTimeout(400);
  const sent = await page.evaluate(() => window.__rpcCalls.filter((c) => c.name === "compare-readings" && c.args?.action === "attach_truth").length);
  const said = await page.evaluate(() => document.querySelector(".toast, #toast")?.textContent?.replace(/\s+/g, " ").trim() || "");
  check("a markup with no marked positions is refused before it reaches the server",
    sent === 0 && /no marked positions/.test(said), `${sent} :: ${said}`);
  await context.close();
}

console.log("\n── one reading is not a comparison ──");
{
  const w = world();
  w.document_baselines = [w.document_baselines[0]];
  const { context, page } = await open(w, { status: { comparison: null } });
  const shown = await view(page);
  check("a single reading offers nothing to compare and asks nothing",
    shown.barHidden === true && shown.calls.length === 0, JSON.stringify([shown.barHidden, shown.calls]));
  await context.close();
}

console.log("\n── a contributor does not buy comparisons ──");
{
  const { context, page } = await open(world({ role: "contributor" }), { status: { comparison: null } });
  const shown = await view(page);
  check("the button is not offered and the function is never called",
    shown.barHidden === true && shown.calls.length === 0, JSON.stringify([shown.barHidden, shown.calls]));
  await context.close();
}

console.log("\n── pressing it, and what comes back ──");
{
  const { context, page, errors } = await open(world(), { status: { comparison: null }, run: { comparison: comparison() } });
  await page.evaluate(() => document.getElementById("compare-readings").click());
  await page.waitForTimeout(700);
  const shown = await view(page);
  check("the recommendation names the reader, not the letter it was hidden behind",
    /Recommended for this set: Claude \(v3\)/.test(shown.verdict), shown.verdict);
  check("and says why, and that the count is this application's own",
    /resolved the header sizes/.test(shown.reason) && /named a place on a sheet/.test(shown.reason), shown.reason);
  check("the section table shows positions, agreement and differences per section, and allows a different winner per section",
    shown.rows.length === 2 && /Structural members/i.test(shown.rows[0]) && /Claude \(v3\)/.test(shown.rows[0]) && /no difference found/.test(shown.rows[1]),
    JSON.stringify(shown.rows));
  check("the three that matter most are shown, wrong before unverified",
    shown.top.length === 3 && /wrong/i.test(shown.top[0]) && /R\.R\.1/.test(shown.top[0]), shown.top[0]?.slice(0, 90));
  check("a quantity finding shows how many individual marks were identified",
    /1 marks identified/.test(shown.top[0]), shown.top[0]?.slice(-90));
  const sheetButtons = await page.evaluate(() => [...document.querySelectorAll("#comparison-top [data-open-sheet]")]
    .map((b) => ({ text: b.textContent.trim(), doc: b.dataset.openSheet, page: b.dataset.openPage })));
  check("every finding that names a page opens that sheet at that page",
    sheetButtons.length === 3 && sheetButtons[0].doc === "doc-a" && sheetButtons[0].page === "25" && /Open S-3 at page 25/.test(sheetButtons[0].text),
    JSON.stringify(sheetButtons[0]));
  check("and one nobody could settle says so rather than inventing a verdict",
    shown.top.some((line) => /Could not verify/i.test(line) && /F2/.test(line)), shown.top.join(" | ").slice(0, 160));
  check("the run line separates time, usage and cost from quality",
    /gpt-5\.6-sol/.test(shown.runLine) && /141 s/.test(shown.runLine) && /\$1\.02/.test(shown.runLine), shown.runLine);
  check("without a control markup the screen says this is a recommendation, not measured accuracy",
    /not measured accuracy/.test(shown.runLine), shown.runLine);
  check("and it says plainly what blinding does and does not buy",
    /reduces bias and does not make the check independent/.test(shown.runLine), shown.runLine);
  check("coverage says what was checked, what was not, and what no reader reported",
    /34 positions checked/.test(shown.coverage) && /15 not checked/.test(shown.coverage) && /1 position the checker found that no reading reported/.test(shown.coverage), shown.coverage);
  check("the evidence discloses who A, B and C were",
    /A = Claude \(v3\)/.test(shown.evidence) && /B = OpenAI \(v2\)/.test(shown.evidence) && /C = Gemini \(v4\)/.test(shown.evidence), shown.evidence.slice(0, 120));
  check("and that the winner does not become the baseline and nothing was merged",
    /does not become this project's baseline/.test(shown.evidence) && /no rows of one reading were merged/.test(shown.evidence));
  check("exactly one comparison was bought", shown.calls.filter((call) => call === "run").length === 1, shown.calls.join(","));
  check("nothing threw", errors.length === 0, errors[0] || "");
  await context.close();
}

console.log("\n── reopening a comparison already made ──");
{
  const { context, page } = await open(world(), { status: { comparison: comparison(), saved: true } });
  const shown = await view(page);
  check("it is on the screen as soon as the project opens",
    shown.panelHidden === false && /Recommended for this set: Claude/.test(shown.verdict), shown.verdict);
  check("the button offers to show it again rather than to buy it again",
    shown.button === "Show the comparison again" && /costs nothing/.test(shown.note), JSON.stringify([shown.button, shown.note]));
  await page.evaluate(() => document.getElementById("compare-readings").click());
  await page.waitForTimeout(500);
  const after = await view(page);
  check("and pressing it buys nothing", after.calls.filter((call) => call === "run").length === 0, after.calls.join(","));
  await context.close();
}

console.log("\n── the checked findings do not separate the readers ──");
{
  const undecided = comparison();
  undecided.verdict.tally = { per_reader: { A: { verified: 1, wrong: 0, could_not_verify: 0 }, B: { verified: 1, wrong: 0, could_not_verify: 0 }, C: { verified: 0, wrong: 0, could_not_verify: 2 } }, leader: null, reason: "the checked findings do not separate the readers" };
  const { context, page } = await open(world(), { status: { comparison: undecided, saved: true } });
  const shown = await view(page);
  check("no winner is named, and the screen says so in as many words",
    shown.verdict === "No clear winner" && /^The checked findings do not separate these readers\./.test(shown.reason), JSON.stringify([shown.verdict, shown.reason]));
  check("the checker's own leaning is shown as a leaning, never as a verdict",
    /leaned towards Claude \(v3\)/.test(shown.reason) && /not enough checked evidence to recommend a reader/.test(shown.reason), shown.reason);
  check("no percentage of accuracy appears anywhere",
    !/\d+\s*%/.test([shown.verdict, shown.reason, shown.coverage, shown.runLine].join(" ")),
    [shown.coverage, shown.runLine].join(" ").slice(0, 120));
  await context.close();
}

console.log("\n── readings that were not made under the same conditions ──");
{
  const unequal = comparison({
    comparable: false,
    conditions: { comparable: false, differences: ["different enlargement budgets", "different task versions"], detail: [] },
  });
  const { context, page } = await open(world({ budgets: [80, 20, 20] }), { status: { comparison: unequal, saved: true } });
  const shown = await view(page);
  check("the difference is on the screen, named",
    shown.conditionsHidden === false && /different enlargement budgets/.test(shown.conditions) && /different task versions/.test(shown.conditions), shown.conditions);
  check("and the result is not called a fair comparison of the readers",
    /not a fair comparison of the readers/.test(shown.conditions), shown.conditions);
  await context.close();
}

console.log("\n── a reader that failed ──");
{
  const incomplete = comparison({
    state: "incomplete",
    incomplete_reason: "1 of 3 readings has no saved answer, so this comparison covers the rest. The missing reading was not run again — that is a decision for a person.",
  });
  const { context, page } = await open(world({ analyses: [true, true, false] }), { status: { comparison: incomplete, saved: true } });
  const shown = await view(page);
  check("the comparison says it is incomplete and why",
    shown.verdict === "Comparison incomplete" && /has no saved answer/.test(shown.reason), JSON.stringify([shown.verdict, shown.reason]));
  check("and says the failed reading was not run again on its own",
    /not run again/.test(shown.reason), shown.reason);
  await context.close();
}

await browser.close();
server.close();
console.log(bad ? `\n${bad} FAILURES` : "\nALL OK");
process.exit(bad ? 1 : 0);
