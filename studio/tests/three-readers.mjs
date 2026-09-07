/* Three readers, chosen in the Studio.
 *
 * The same plan set can be read by OpenAI, by Claude or by Gemini. What this
 * walks is the door itself, with stubbed provider answers — no key, no call,
 * no money:
 *
 *   - the picker exists for an owner and not for a contributor, and OpenAI
 *     stays the default;
 *   - a provider with no key in this project says "Provider not configured"
 *     and cannot be run;
 *   - the chosen reader travels with the job and with the reading request;
 *   - two readings of one project live side by side, and switching moves the
 *     whole result — schedules, questions, sources — from one to the other;
 *   - each reading shows who read it, how long it took, what it used, and
 *     what it cost — with an unknown tariff said in words, never as $0.00;
 *   - a source in the switched reading opens that reading's own sheet.
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

/* The catalogue the server answers with: what each provider is, and whether
   this project has a key for it. Never the key. */
const CATALOGUE = {
  providers: [
    { provider: "openai", label: "OpenAI", mode: "background", configured: true, source: "developers.openai.com", models: [{ id: "gpt-5.6-sol", label: "GPT-5.6 Sol", input_per_mtok: 4, output_per_mtok: 20, price_status: "promotional", price_note: "" }] },
    { provider: "anthropic", label: "Claude", mode: "sync", configured: true, source: "platform.claude.com", models: [{ id: "claude-opus-5", label: "Claude Opus 5", input_per_mtok: 5, output_per_mtok: 25, price_status: "confirmed", price_note: "" }] },
    { provider: "google", label: "Gemini", mode: "sync", configured: false, source: "ai.google.dev", models: [{ id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro (preview)", input_per_mtok: null, output_per_mtok: null, price_status: "not_confirmed", price_note: "" }] },
  ],
  default_provider: "openai",
};

const scheduleRow = (mark, description, sheet) => ({
  mark, category: "door", description, unit: "each",
  count_scheduled: 1, count_drawn: 1, count_proposed: 1, count_confidence: "high", count_note: "",
  source_refs: [`${sheet} (original p20)`],
});

/* One project, two readings: OpenAI v2 and Claude v3, each with its own
   schedule row, its own question and its own source sheet. */
function world({ role = "owner" } = {}) {
  const w = deckTakeoffRows();
  w.properties[0].name = "4423 Noble";
  w.organization_members[0].role = role;
  const property = w.properties[0].id;
  const org = w.properties[0].organization_id;
  w.project_documents = [
    planDocument({ id: "doc-a", original_filename: "Set A-710.pdf", document_type: "architectural", status: "ready", byte_size: 4 * 1024 * 1024 }),
  ];
  const baseline = (id, version, provider, providerLabel, model, run, row, question) => ({
    id, organization_id: org, property_id: property, version, state: "review",
    source_document_ids: ["doc-a"], project_summary: `${providerLabel} read this set.`,
    analysis: { framing_walls: [], framing_decks: [], levels: [], systems: [], component_schedules: [row] },
    gaps: [{ severity: "critical", question, source_refs: [], blocks_activation: true }],
    model, provider, analysis_run: run, agent_contract_version: "2026-09-07.1",
    created_at: "2026-09-07T05:00:00Z", approved_at: null,
  });
  w.document_baselines = [
    baseline("bl-claude", 3, "anthropic", "Claude", "claude-opus-5",
      { provider: "anthropic", provider_label: "Claude", model: "claude-opus-5", model_label: "Claude Opus 5", usage: { input_tokens: 120000, output_tokens: 14000 }, duration_ms: 96000, cost_usd: 0.95, price_status: "confirmed", price_note: "" },
      scheduleRow("201", "Claude door", "A-711"), "Claude asks which issue status governs."),
    baseline("bl-openai", 2, "openai", "OpenAI", "gpt-5.6-sol",
      { provider: "openai", provider_label: "OpenAI", model: "gpt-5.6-sol", model_label: "GPT-5.6 Sol", usage: { input_tokens: 100000, output_tokens: 12000 }, duration_ms: 240000, cost_usd: 0.64, price_status: "promotional", price_note: "" },
      scheduleRow("101", "OpenAI door", "A-710"), "OpenAI asks about the sprinkler conflict."),
  ];
  w.material_takeoffs = [];
  return w;
}

async function open(w, { functions } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.route("**://*/**", (r) => (r.request().url().startsWith(base) ? r.continue() : r.abort()));
  await context.addInitScript(`window.__seed = ${JSON.stringify({
    rows: w,
    functions: {
      "plan-analyze": { byAction: { providers: CATALOGUE, start: { job_id: "job-1", state: "processing", progress_stage: "reading_documents", progress_percent: 32 }, ...(functions || {}) } },
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
const picker = (page) => page.evaluate(() => ({
  hidden: document.getElementById("reader-picker")?.hidden,
  providers: [...document.querySelectorAll("#reader-provider option")].map((o) => o.textContent.trim()),
  provider: document.getElementById("reader-provider")?.value,
  models: [...document.querySelectorAll("#reader-model option")].map((o) => o.value),
  note: document.getElementById("reader-note")?.textContent.replace(/\s+/g, " ").trim(),
  warn: document.getElementById("reader-note")?.classList.contains("warn"),
  button: document.getElementById("analyze-plans")?.textContent.replace(/\s+/g, " ").trim(),
  disabled: document.getElementById("analyze-plans")?.disabled,
}));

console.log("── the picker, and who may use it ──");
{
  const { context, page, errors } = await open(world());
  const view = await picker(page);
  check("an owner sees the reader picker with all three readers",
    view.hidden === false && view.providers.length === 3 && /OpenAI/.test(view.providers[0]) && /Claude/.test(view.providers[1]) && /Gemini/.test(view.providers[2]), JSON.stringify(view.providers));
  check("OpenAI is the default and its model is the one the app already runs",
    view.provider === "openai" && view.models[0] === "gpt-5.6-sol", JSON.stringify([view.provider, view.models]));
  check("the note says the model, its published price and how it reads",
    /gpt-5\.6-sol/.test(view.note) && /\$4\/M in/.test(view.note) && /background/i.test(view.note), view.note);
  check("nothing threw", errors.length === 0, errors[0] || "");

  /* A provider with no key in this project. */
  await page.selectOption("#reader-provider", "google");
  await page.waitForTimeout(300);
  const google = await picker(page);
  check("a reader with no key says Provider not configured, in the picker and on the button",
    google.warn === true && /Provider not configured/.test(google.note) && google.button === "Provider not configured ↗" && google.disabled === true,
    JSON.stringify([google.note, google.button, google.disabled]));
  const sentWhileBlocked = await page.evaluate(async () => {
    document.getElementById("analyze-plans").click();
    await new Promise((r) => setTimeout(r, 300));
    return window.__rpcCalls.filter((c) => c.name === "plan-analyze" && c.args?.action === "start").length;
  });
  check("and pressing it sends no reading", sentWhileBlocked === 0, String(sentWhileBlocked));

  /* A configured provider that is not the default. */
  await page.selectOption("#reader-provider", "anthropic");
  await page.waitForTimeout(300);
  const claude = await picker(page);
  check("choosing Claude names its model and its price, and the button is live",
    claude.models[0] === "claude-opus-5" && /\$5\/M in/.test(claude.note) && claude.disabled === false, JSON.stringify([claude.models, claude.note]));
  await context.close();
}

console.log("\n── a contributor runs the project's reader, and chooses nothing ──");
{
  const { context, page } = await open(world({ role: "contributor" }));
  const view = await picker(page);
  const asked = await page.evaluate(() => window.__rpcCalls.filter((c) => c.name === "plan-analyze" && c.args?.action === "providers").length);
  check("the picker is not shown and the catalogue is not even asked for", view.hidden === true && asked === 0, JSON.stringify([view.hidden, asked]));
  await context.close();
}

console.log("\n── the chosen reader travels with the reading ──");
{
  const { context, page } = await open(world());
  await page.selectOption("#reader-provider", "anthropic");
  await page.waitForTimeout(200);
  /* Select the document so the button offers a reading. */
  await page.evaluate(() => {
    for (const box of document.querySelectorAll("[data-document-select]")) if (!box.checked) box.click();
  });
  await page.waitForTimeout(200);
  await page.evaluate(() => document.getElementById("analyze-plans").click());
  await page.waitForTimeout(700);
  const sent = await page.evaluate(() => ({
    start: window.__rpcCalls.filter((c) => c.name === "plan-analyze" && c.args?.action === "start").map((c) => c.args),
    jobs: (window.__inserted || []).filter((row) => row.table === "plan_analysis_jobs").map((row) => row.values),
  }));
  check("the start request names the provider and the model",
    sent.start.length === 1 && sent.start[0].provider === "anthropic" && sent.start[0].model === "claude-opus-5", JSON.stringify(sent.start));
  await context.close();
}

console.log("\n── two readings side by side ──");
{
  const { context, page, errors } = await open(world());
  const shown = await page.evaluate(() => ({
    tabs: [...document.querySelectorAll("#reading-list [data-reading]")].map((b) => b.textContent.replace(/\s+/g, " ").trim()),
    selected: document.querySelector('#reading-list [aria-selected="true"]')?.dataset.reading,
    run: document.getElementById("reading-run")?.textContent.replace(/\s+/g, " ").trim(),
    rows: [...document.querySelectorAll("#result-sections tbody tr")].map((tr) => tr.innerText.replace(/\s+/g, " ").trim()),
    questions: [...document.querySelectorAll("#result-conflicts li")].map((li) => li.textContent.replace(/\s+/g, " ").trim()),
  }));
  check("both readings are offered, newest first, each named by its reader",
    shown.tabs.length === 2 && /v3 · Claude/.test(shown.tabs[0]) && /v2 · OpenAI/.test(shown.tabs[1]), JSON.stringify(shown.tabs));
  check("the newest is the one shown, with its own schedule row and its own question",
    shown.selected === "bl-claude" && shown.rows.some((row) => /Claude door/.test(row)) && shown.questions.some((q) => /Claude asks/.test(q)),
    JSON.stringify([shown.selected, shown.rows[0], shown.questions[0]]));
  check("and it says who read it, how long it took, what it used and what it cost",
    /Claude · claude-opus-5/.test(shown.run) && /task 2026-09-07\.1/.test(shown.run) && /96 s/.test(shown.run) && /120,000 in/.test(shown.run) && /\$0\.95/.test(shown.run), shown.run);

  await page.evaluate(() => [...document.querySelectorAll("#reading-list [data-reading]")].find((b) => b.dataset.reading === "bl-openai")?.click());
  await page.waitForTimeout(900);
  const switched = await page.evaluate(() => ({
    selected: document.querySelector('#reading-list [aria-selected="true"]')?.dataset.reading,
    run: document.getElementById("reading-run")?.textContent.replace(/\s+/g, " ").trim(),
    rows: [...document.querySelectorAll("#result-sections tbody tr")].map((tr) => tr.innerText.replace(/\s+/g, " ").trim()),
    questions: [...document.querySelectorAll("#result-conflicts li")].map((li) => li.textContent.replace(/\s+/g, " ").trim()),
    sources: [...document.querySelectorAll("#result-sections tbody tr td:last-child")].map((td) => td.textContent.replace(/\s+/g, " ").trim()),
    summary: document.getElementById("project-summary")?.textContent || "",
  }));
  check("switching moves the whole result: the other reading's rows, questions and summary",
    switched.selected === "bl-openai" && switched.rows.some((row) => /OpenAI door/.test(row)) && !switched.rows.some((row) => /Claude door/.test(row))
      && switched.questions.some((q) => /OpenAI asks/.test(q)) && /OpenAI read this set/.test(switched.summary),
    JSON.stringify([switched.selected, switched.rows[0], switched.questions[0]]));
  check("its sources are its own sheets", switched.sources.some((source) => /A-710/.test(source)) && !switched.sources.some((source) => /A-711/.test(source)), JSON.stringify(switched.sources));
  check("and the run line follows the reading it belongs to",
    /OpenAI · gpt-5\.6-sol/.test(switched.run) && /\$0\.64/.test(switched.run) && /promotional/.test(switched.run), switched.run);
  check("nothing threw", errors.length === 0, errors[0] || "");
  await context.close();
}

console.log("\n── an unknown tariff is said in words, never as zero ──");
{
  const w = world();
  w.document_baselines[0].analysis_run = {
    provider: "google", provider_label: "Gemini", model: "gemini-3.1-pro-preview",
    usage: { input_tokens: 90000, output_tokens: 9000 }, duration_ms: 61000,
    cost_usd: null, price_status: "not_confirmed", price_note: "Tariff not confirmed.",
  };
  const { context, page } = await open(w);
  const run = await page.evaluate(() => document.getElementById("reading-run")?.textContent.replace(/\s+/g, " ").trim());
  check("the reading says the tariff is not confirmed and shows no dollar figure",
    /cost unknown — tariff not confirmed/.test(run) && !/\$/.test(run), run);
  await context.close();
}

console.log("\n── the guard still refuses a second identical reading ──");
{
  const { context, page } = await open(world(), {
    functions: { start: { skipped: "reused", code: "identical_reading_exists", previous_run_id: "run-1" } },
  });
  await page.evaluate(() => {
    for (const box of document.querySelectorAll("[data-document-select]")) if (!box.checked) box.click();
  });
  await page.waitForTimeout(200);
  await page.evaluate(() => document.getElementById("analyze-plans").click());
  await page.waitForTimeout(800);
  const refused = await page.evaluate(() => ({
    message: document.getElementById("action-message")?.textContent.replace(/\s+/g, " ").trim() || "",
    starts: window.__rpcCalls.filter((c) => c.name === "plan-analyze" && c.args?.action === "start").length,
  }));
  check("a reading of the same inputs by the same reader is refused, and said so on the screen",
    refused.starts === 1 && /already/i.test(refused.message), JSON.stringify(refused));
  await context.close();
}

await browser.close();
server.close();
console.log(bad ? `\n${bad} FAILURES` : "\nALL OK");
process.exit(bad ? 1 : 0);
