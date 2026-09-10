/* Send the same kit and the same request to each provider, once.
 *
 *   node experiments/noble-takeoff/run/run-comparison.mjs --approve-budget=10 --providers=openai,anthropic,google [--dry-run]
 *
 * Refuses to start without --approve-budget, refuses when the estimate is
 * above it, records usage and cost per call, and never retries a paid call:
 * a lost answer is written down as outcome_unknown for a person to decide.
 * Keys come from the environment only: OPENAI_API_KEY, ANTHROPIC_API_KEY,
 * GEMINI_API_KEY. Nothing is uploaded to a provider file store — every page
 * and image travels inline in the one request.
 */
import fs from "node:fs"; import path from "node:path";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "true"]; }));
const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.join(HERE, "..");
const KIT = path.join(ROOT, "kit", "out");
const RESULTS = path.join(ROOT, "results");
const PDF = args.pdf || path.join(ROOT, "source", "noble.pdf");

/* Price table — from models-and-budget.md; per 1M tokens. Update before a run. */
const MODELS = {
  openai: { id: "gpt-5.6-sol", input: 4, output: 20, key: "OPENAI_API_KEY", confirmed: "excerpt" },
  anthropic: { id: "claude-opus-5", input: 5, output: 25, key: "ANTHROPIC_API_KEY", confirmed: "confirmed" },
  /* Price not confirmed on the official page, third-party listing ($2 / $12 per 1M tokens); entered so the run is not refused. */
  google: { id: "gemini-3.1-pro-preview", input: 2, output: 12, key: "GEMINI_API_KEY", confirmed: "not confirmed on the official page, third-party listing" },
};
/* Worst-case tokens per image for the pre-flight check (see models-and-budget.md). */
const IMAGE_TOKENS = { openai: 5000, anthropic: 4784, google: 5200 };
const PDF_PAGE_TOKENS = 3000;
const OUTPUT_CAP = 32000;

const budget = Number(args["approve-budget"]);
if (!Number.isFinite(budget) || budget <= 0) { console.error("Refusing: pass --approve-budget=<usd> after the models and the budget are approved."); process.exit(2); }
const providers = (args.providers || "openai,anthropic,google").split(",").filter((p) => MODELS[p]);
if (!fs.existsSync(path.join(KIT, "manifest.json"))) { console.error("Kit not built. Run kit/build-kit.mjs first."); process.exit(2); }
const manifest = JSON.parse(fs.readFileSync(path.join(KIT, "manifest.json"), "utf8"));
const images = manifest.pages.flatMap((p) => [{ name: p.full, page: p.page, coords: "full page" }, ...p.tiles.map((t) => ({ name: t.name, page: p.page, coords: `x ${t.x}, y ${t.y}, ${t.width}×${t.height} px at ${manifest.dpi} dpi` }))]);
const prompt = fs.readFileSync(path.join(ROOT, "prompt.md"), "utf8");
const schema = fs.readFileSync(path.join(ROOT, "result-schema.json"), "utf8");
const tasks = fs.readFileSync(path.join(ROOT, "tasks.md"), "utf8");
const pdfPages = manifest.pages.map((p) => p.page);

/* Pre-flight estimate. */
const estimate = {};
let total = 0;
for (const p of providers) {
  if (MODELS[p].input === null || MODELS[p].output === null) { console.error(`Refusing: ${p} (${MODELS[p].id}) has no confirmed price in the table; enter it in MODELS before running.`); process.exit(3); }
  const inTok = images.length * IMAGE_TOKENS[p] + pdfPages.length * PDF_PAGE_TOKENS + 6000;
  const usd = (inTok * MODELS[p].input + OUTPUT_CAP * MODELS[p].output) / 1e6;
  estimate[p] = { input_tokens_worst: inTok, output_cap: OUTPUT_CAP, usd_worst: +usd.toFixed(2) };
  total += usd;
}
console.log("Worst case:", JSON.stringify(estimate), `total ≤ $${total.toFixed(2)} (cap $${budget})`);
if (total > budget) { console.error("Refusing: worst case exceeds the approved budget."); process.exit(3); }
if (args["dry-run"]) { console.log("Dry run — nothing sent."); process.exit(0); }

const b64 = (file) => fs.readFileSync(file).toString("base64");
const textParts = [
  `${prompt}\n\n---\nresult-schema.json:\n${schema}\n\n---\ntasks.md:\n${tasks}`,
  `Enlargements and their coordinates on the page (from manifest.json):\n${images.map((i) => `${i.name}: page ${i.page}, ${i.coords}`).join("\n")}`,
];
const closing = "Return only the JSON.";

/* Same content, three envelopes. The PDF goes inline (base64) so nothing is left in a file store. */
function pdfSubset() {
  /* The kit's pages only: extract with qpdf when present, else send the whole file. */
  const out = path.join(KIT, "kit-pages.pdf");
  try {
    if (!fs.existsSync(out)) {
      const { execFileSync } = require("node:child_process");
      execFileSync("qpdf", [PDF, "--pages", PDF, pdfPages.join(","), "--", out]);
    }
    return out;
  } catch { return PDF; }
}
const { createRequire } = await import("node:module");
const require = createRequire(import.meta.url);
const pdfFile = pdfSubset();

const requests = {
  openai: () => ({
    url: "https://api.openai.com/v1/responses",
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: {
      model: MODELS.openai.id, store: false, max_output_tokens: OUTPUT_CAP,
      input: [{ role: "user", content: [
        { type: "input_text", text: textParts[0] },
        { type: "input_file", filename: path.basename(pdfFile), file_data: `data:application/pdf;base64,${b64(pdfFile)}` },
        ...images.map((i) => ({ type: "input_image", detail: "high", image_url: `data:image/png;base64,${b64(path.join(KIT, i.name))}` })),
        { type: "input_text", text: textParts[1] },
        { type: "input_text", text: closing },
      ] }],
    },
    usage: (r) => ({ input: r.usage?.input_tokens || 0, output: r.usage?.output_tokens || 0 }),
    text: (r) => (r.output || []).flatMap((o) => o.content || []).filter((c) => c.type === "output_text").map((c) => c.text).join(""),
  }),
  anthropic: () => ({
    url: "https://api.anthropic.com/v1/messages",
    headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: {
      model: MODELS.anthropic.id, max_tokens: OUTPUT_CAP, thinking: { type: "adaptive" }, output_config: { effort: "high" },
      messages: [{ role: "user", content: [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64(pdfFile) } },
        ...images.flatMap((i) => [{ type: "text", text: `Image ${i.name}: page ${i.page}, ${i.coords}` }, { type: "image", source: { type: "base64", media_type: "image/png", data: b64(path.join(KIT, i.name)) } }]),
        { type: "text", text: textParts[0] }, { type: "text", text: textParts[1] }, { type: "text", text: closing },
      ] }],
    },
    usage: (r) => ({ input: r.usage?.input_tokens || 0, output: r.usage?.output_tokens || 0 }),
    text: (r) => (r.content || []).filter((c) => c.type === "text").map((c) => c.text).join(""),
  }),
  google: () => ({
    url: `https://generativelanguage.googleapis.com/v1beta/models/${MODELS.google.id}:generateContent`,
    headers: { "content-type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
    body: {
      contents: [{ role: "user", parts: [
        { text: textParts[0] },
        { inlineData: { mimeType: "application/pdf", data: b64(pdfFile) } },
        ...images.flatMap((i) => [{ text: `Image ${i.name}: page ${i.page}, ${i.coords}` }, { inlineData: { mimeType: "image/png", data: b64(path.join(KIT, i.name)) }, mediaResolution: { level: "MEDIA_RESOLUTION_HIGH" } }]),
        { text: textParts[1] }, { text: closing },
      ] }],
      generationConfig: { responseMimeType: "application/json", maxOutputTokens: OUTPUT_CAP },
    },
    usage: (r) => ({ input: r.usageMetadata?.promptTokenCount || 0, output: r.usageMetadata?.candidatesTokenCount || 0 }),
    text: (r) => (r.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join(""),
  }),
};

fs.mkdirSync(RESULTS, { recursive: true });
const ledger = [];
let spent = 0;
for (const p of providers) {
  if (!process.env[MODELS[p].key]) { console.error(`${p}: ${MODELS[p].key} is not set — skipped.`); ledger.push({ provider: p, outcome: "not_run", reason: "no key" }); continue; }
  if (spent + estimate[p].usd_worst > budget) { console.error(`${p}: spent $${spent.toFixed(2)} so far, next worst case $${estimate[p].usd_worst} would pass the cap $${budget} — stopping.`); ledger.push({ provider: p, outcome: "not_run", reason: "cap" }); break; }
  if (p === "google") {
    /* Free call: the model must exist under the configured ID before anything is sent. */
    const list = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", { headers: { "x-goog-api-key": process.env.GEMINI_API_KEY } }).then((r) => r.json()).catch(() => ({}));
    const names = (list.models || []).map((m) => String(m.name || "").replace(/^models\//, ""));
    if (!names.includes(MODELS.google.id)) { console.error(`google: ${MODELS.google.id} is not in the models list for this key — not sent. Available: ${names.filter((n) => /gemini-3/.test(n)).join(", ") || "(none listed)"}`); ledger.push({ provider: p, outcome: "not_run", reason: "model id not found" }); continue; }
  }
  const req = requests[p]();
  const started = Date.now();
  const record = { provider: p, model: MODELS[p].id, started_at: new Date(started).toISOString(), request_bytes: Buffer.byteLength(JSON.stringify(req.body)) };
  console.log(`${p}: sending ${record.request_bytes} bytes to ${MODELS[p].id} …`);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20 * 60 * 1000);
    const response = await fetch(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(req.body), signal: controller.signal });
    clearTimeout(timer);
    const payload = await response.json().catch(() => ({}));
    record.wall_seconds = Math.round((Date.now() - started) / 1000);
    record.http_status = response.status;
    if (!response.ok) {
      record.outcome = "failed"; record.error = JSON.stringify(payload).slice(0, 600);
    } else {
      const usage = req.usage(payload);
      record.usage = usage;
      record.cost_usd = +((usage.input * MODELS[p].input + usage.output * MODELS[p].output) / 1e6).toFixed(4);
      record.outcome = "succeeded";
      spent += record.cost_usd;
      fs.writeFileSync(path.join(RESULTS, `${p}.raw.json`), JSON.stringify(payload, null, 2));
      fs.writeFileSync(path.join(RESULTS, `${p}.json`), req.text(payload));
    }
  } catch (error) {
    /* The request may have been accepted and billed; nobody retries this. */
    record.wall_seconds = Math.round((Date.now() - started) / 1000);
    record.outcome = "outcome_unknown"; record.error = String(error).slice(0, 300);
  }
  ledger.push(record);
  console.log(JSON.stringify(record));
  fs.writeFileSync(path.join(RESULTS, "ledger.json"), JSON.stringify(ledger, null, 2));
  if (record.outcome === "outcome_unknown") { console.error(`${p}: answer lost after the request was sent — stopping here, no retry. Decide by hand.`); break; }
}
console.log(`Spent (from provider usage × price table): $${spent.toFixed(2)} of the approved $${budget}.`);
