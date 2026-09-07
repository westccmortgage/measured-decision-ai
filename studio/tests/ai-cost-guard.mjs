/* AI COST GUARD — the fingerprint, and the browser half of the guard.
 *
 * The database refuses the second payment; that is proved in the SQL
 * invariants. This file proves the two things that live outside it:
 *
 *   1. the fingerprint recipe — that the same purchase hashes the same
 *      however the inputs are ordered, and that every input which can change
 *      the answer changes the hash;
 *   2. the browser's courtesy layer — one press, one job, and Reanalyze
 *      never spends without the sentence that names the cost.
 *
 * No provider is called. Nothing here costs anything.
 */
import fs from "fs";
import path from "path";
import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";

let bad = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? `\n         ${detail}` : ""}`);
  if (!ok) bad++;
};

/* ── the fingerprint ──────────────────────────────────────────────────────
 * The shipping recipe, imported from the shipping file rather than copied.
 * A copy would go on passing while the product drifted, which is the one
 * thing a test of a hash must never do. Node strips the types; the logic is
 * byte-for-byte what the workers run. */
const fingerprint = (await import(
  `file://${path.resolve("supabase/functions/_shared/ai-run-ledger.ts")}`
)).buildFingerprint;

console.log("\n── the same purchase hashes the same ──");
const base = {
  organizationId: "org-1",
  propertyId: "project-1",
  processKey: "spatial-analyze",
  model: "test-model",
  contractVersion: "contract-1",
  inputs: ["ev-a", "ev-b", "ev-c"],
  requirements: ["req-1", "req-2"],
  settings: { profile: "conservative", spherical: true },
};
const of = (patch) => fingerprint({ ...base, ...patch });

const original = await of({});
check("a fingerprint is a stable hex digest",
  /^[0-9a-f]{64}$/.test(original), original.slice(0, 16) + "…");
check("the same inputs in a different order are the same purchase",
  (await of({ inputs: ["ev-c", "ev-a", "ev-b"] })) === original);
check("the same requirements in a different order are the same purchase",
  (await of({ requirements: ["req-2", "req-1"] })) === original);
check("the same settings declared in a different order are the same purchase",
  (await of({ settings: { spherical: true, profile: "conservative" } })) === original);
/* A duplicate in the list is the same set of files. */
check("a repeated input does not change the purchase",
  (await of({ inputs: ["ev-a", "ev-a", "ev-b", "ev-c"] })) === original);

console.log("\n── anything that changes the answer changes the purchase ──");
check("changed evidence is a different purchase",
  (await of({ inputs: ["ev-a", "ev-b", "ev-d"] })) !== original);
check("added evidence is a different purchase",
  (await of({ inputs: ["ev-a", "ev-b", "ev-c", "ev-d"] })) !== original);
check("changed requirements are a different purchase",
  (await of({ requirements: ["req-1", "req-3"] })) !== original);
check("a changed model is a different purchase",
  (await of({ model: "other-model" })) !== original);
check("a changed prompt contract version is a different purchase",
  (await of({ contractVersion: "contract-2" })) !== original);
check("a changed analysis setting is a different purchase",
  (await of({ settings: { profile: "thorough", spherical: true } })) !== original);
check("another project is a different purchase",
  (await of({ propertyId: "project-2" })) !== original);
check("another organization is a different purchase",
  (await of({ organizationId: "org-2" })) !== original);
check("another process reading the same files is a different purchase",
  (await of({ processKey: "document-evidence" })) !== original);

/* ── the five workers all go through the one door ──────────────────────── */
console.log("\n── every paid worker claims before it spends ──");
const WORKERS = [
  "plan-analyze", "spatial-analyze", "document-classify",
  "document-evidence", "field-quality-check",
];
for (const worker of WORKERS) {
  const source = fs.readFileSync(`supabase/functions/${worker}/index.ts`, "utf8");
  check(`${worker} claims a run before calling the provider`,
    /claimAiRun\(/.test(source));
  check(`${worker} records what the run used`,
    /finishAiRun\(/.test(source) && /usageFrom\(/.test(source));
}
/* The one worker that does not use the shared transport still has to be in
   the ledger — it was the easiest one to forget. */
check("the worker that calls OpenAI directly is in the ledger too",
  /claimAiRun\(/.test(fs.readFileSync("supabase/functions/field-quality-check/index.ts", "utf8")));
/* And the compute this stage deliberately leaves out stays out. */
check("360 stitching is not in the AI ledger",
  !/claimAiRun|ai_runs/.test(fs.readFileSync("supabase/functions/capture-machine/index.ts", "utf8")));

/* ── the browser half ─────────────────────────────────────────────────── */
console.log("\n── one press, one job ──");
const ROOT = path.resolve(".");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const http = await import("http");
const server = http.createServer((req, res) => {
  let f = path.join(ROOT, decodeURIComponent(req.url.split("?")[0]));
  if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, "index.html");
  if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(f)] || "application/octet-stream" });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox", "--no-proxy-server"],
});
const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
await context.route("**://*/**", (r) => (r.request().url().startsWith(baseUrl) ? r.continue() : r.abort()));
const page = await context.newPage();
await page.goto(`${baseUrl}/studio/ai-usage.js`);
await page.setContent("<!doctype html><title>guard</title>");
await page.addScriptTag({ url: `${baseUrl}/studio/ai-usage.js` });

const pressed = await page.evaluate(async () => {
  const guard = window.MDAIAiUsage;
  let calls = 0;
  const slowAnalyze = () => guard.once("analyze", async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 60));
    return { ok: true };
  });
  /* Two presses microseconds apart, which is what a double click is. */
  const [first, second] = await Promise.all([slowAnalyze(), slowAnalyze()]);
  /* And a third once the first has finished — a deliberate second run. */
  const third = await slowAnalyze();
  return { calls, first, second, third };
});
check("a double press starts exactly one job",
  pressed.calls === 2 && pressed.second.skipped === "in_flight",
  JSON.stringify(pressed));
check("and the press after it finishes is allowed through",
  pressed.third.ok === true);

console.log("\n── Reanalyze never spends without saying what it costs ──");
const confirmed = await page.evaluate(() => {
  const guard = window.MDAIAiUsage;
  const asked = [];
  const declined = guard.confirmReanalyze((message) => { asked.push(message); return false; });
  const accepted = guard.confirmReanalyze((message) => { asked.push(message); return true; });
  return { asked, declined, accepted, warning: guard.REANALYZE_WARNING };
});
check("Reanalyze asks before it spends",
  confirmed.asked.length === 2);
check("and the question names the cost in the words agreed",
  confirmed.asked.every((m) => m === "This will run AI again and may use additional credits."),
  confirmed.warning);
check("declining spends nothing", confirmed.declined === false);
check("accepting is what allows the run", confirmed.accepted === true);

console.log("\n── the worker's refusal is not an error ──");
const verdicts = await page.evaluate(() => {
  const guard = window.MDAIAiUsage;
  return {
    reused: guard.skippedVerdict({ skipped: "reused" }),
    running: guard.skippedVerdict({ skipped: "running" }),
    normal: guard.skippedVerdict({ analysis: {} }),
    reusedText: guard.skippedMessage("reused"),
    runningText: guard.skippedMessage("running"),
  };
});
check("a reused reading is recognised as reuse, not failure",
  verdicts.reused === "reused" && /up to date/i.test(verdicts.reusedText), verdicts.reusedText);
check("a reading already in flight is recognised as such",
  verdicts.running === "running" && /already running/i.test(verdicts.runningText), verdicts.runningText);
check("and a real result is not mistaken for a refusal",
  verdicts.normal === null);

console.log("\n── money is never invented ──");
const money = await page.evaluate(async () => {
  const guard = window.MDAIAiUsage;
  const fakeClient = (row) => ({ rpc: async () => ({ data: [row], error: null }) });
  const priced = await guard.usageLine(
    fakeClient({ runs: 3, total_tokens: 12000, usage_missing: 0, estimated_cost_micros: 1250000 }),
    "p1",
  );
  const unpriced = await guard.usageLine(
    fakeClient({ runs: 3, total_tokens: 12000, usage_missing: 0, estimated_cost_micros: null }),
    "p1",
  );
  const partial = await guard.usageLine(
    fakeClient({ runs: 4, total_tokens: 900, usage_missing: 1, estimated_cost_micros: null }),
    "p1",
  );
  const none = await guard.usageLine(fakeClient({ runs: 0 }), "p1");
  return { priced, unpriced, partial, none };
});
check("with no price list the line says the cost is unavailable",
  /Cost unavailable/.test(money.unpriced) && !/\$/.test(money.unpriced), money.unpriced);
check("and it still reports the runs and the tokens",
  /3 runs/.test(money.unpriced) && /12,000 tokens/.test(money.unpriced), money.unpriced);
check("a run whose usage the provider never returned is said out loud",
  /reported no usage/.test(money.partial), money.partial);
check("a cost is shown only when one actually exists",
  /Estimated \$1\.25/.test(money.priced), money.priced);
check("and a project that has never used AI shows no line at all",
  money.none === null);


/* ── the unknown outcome ───────────────────────────────────────────────────
 * The database proves that an unknown outcome cannot be re-bought and that a
 * confirmation is worth exactly one run. What it cannot prove is the part that
 * DECIDES which of the three outcomes a failure was — that lives in the
 * shipping TypeScript, and it is imported here rather than copied. */
console.log("\n── what happened to the money ──");
const ledger = await import(
  `file://${path.resolve("supabase/functions/_shared/ai-run-ledger.ts")}`
);
const { RunProgress, outcomeForStatus } = ledger;

check("a failure before anything is sent costs nothing",
  new RunProgress().outcome() === "failed");
/* The case this whole change exists for. */
check("a request that went out and lost its answer is an unknown outcome",
  new RunProgress().sent().outcome() === "outcome_unknown");
check("a request the provider rejected did not happen, so it is a plain failure",
  new RunProgress().sent().refused().outcome() === "failed");
check("a reading in our hands is succeeded",
  new RunProgress().sent().answered().outcome() === "succeeded");
/* Requirement three, stated as a test: once bought, always bought. A database
   error while saving must send us back to the SAVE, never to the provider. */
const held = new RunProgress().sent().answered();
held.sent();
check("and a failure to save what we already bought never un-buys it",
  held.outcome() === "succeeded" && held.held === true);

check("a rejected request is a failure — 400, 401, 403, 404, 422",
  [400, 401, 403, 404, 422].every((code) => outcomeForStatus(code) === "failed"));
/* A timeout and a rate limit can both arrive after the work was done, which is
   exactly the trap: treating them as failures is what bought the reading
   twice. */
check("a timeout, a rate limit and a server error are unknown, not failures",
  [408, 429, 500, 502, 503, 504].every((code) => outcomeForStatus(code) === "outcome_unknown"));
check("and a 200 is succeeded", outcomeForStatus(200) === "succeeded");

console.log("\n── every worker classifies before it closes the ledger ──");
const ALL_WORKERS = [
  "plan-analyze", "spatial-analyze", "document-classify",
  "document-evidence", "field-quality-check", "project-search",
];
for (const worker of ALL_WORKERS) {
  const source = fs.readFileSync(`supabase/functions/${worker}/index.ts`, "utf8");
  check(`${worker} marks the request as sent before it spends`,
    /progress\??\.sent\(\)|launchProgress/.test(source));
  /* The bug in one line: a hardcoded "failed" on a path that may have been
     billed is a free pass to buy the same reading again. A "failed" is only
     honest where the provider itself reported a terminal state — which is
     exactly the case that carries its usage. */
  const hardcodedFailures = (source.replace(/\n/g, " ")
    .match(/finishAiRun\([^)]*?,\s*"failed"[^)]*?\)/g) || []);
  check(`${worker} closes a call as failed only on the provider's own word`,
    hardcodedFailures.every((call) => /usageFrom\(providerPayload\)/.test(call)),
    hardcodedFailures.join(" | ") || "none");
}

/* The one worker that can actually go back for a lost answer. */
const planSource = fs.readFileSync("supabase/functions/plan-analyze/index.ts", "utf8");
check("plan-analyze retrieves a background reading by the id it stored",
  /responses\/\$\{encodeURIComponent\(job\.provider_job_id\)/.test(planSource));
check("and closes that run with the usage the retrieval reported",
  /finishAiRun\(admin, job\.ai_run_id \|\| null, "succeeded", usageFrom\(providerPayload\)/.test(planSource));
check("a background job the provider no longer recognises is unknown, not failed",
  /"outcome_unknown", \{\}, "provider_job_lost"/.test(planSource));
check("and one it never started is unknown too",
  /"outcome_unknown", \{\}, "provider_never_started"/.test(planSource));
/* The requeue is the dangerous part: a chunk put back to pending is relaunched
   by the next poll, with nobody asked and nothing said. */
check("a chunk whose launch was lost is not silently requeued for relaunch",
  /state: outcome === "outcome_unknown" \? "failed" : "pending"/.test(planSource));

console.log("\n── the sentence a person reads before paying again ──");
const asked = await page.evaluate(async () => {
  const guard = window.MDAIAiUsage;
  const seen = [];
  let rpcCalls = 0;
  const client = { rpc: async () => { rpcCalls += 1; return { data: true, error: null }; } };
  const declined = await guard.confirmUnknownOutcome(client, "run-1", (message) => {
    seen.push(message); return false;
  });
  const rpcAfterDecline = rpcCalls;
  const accepted = await guard.confirmUnknownOutcome(client, "run-1", (message) => {
    seen.push(message); return true;
  });
  return {
    seen, declined, accepted, rpcAfterDecline, rpcCalls,
    warning: guard.UNKNOWN_OUTCOME_WARNING,
    verdict: guard.skippedVerdict({ skipped: "outcome_unknown" }),
    message: guard.skippedMessage("outcome_unknown"),
  };
});
check("the question says the previous request may have run and been billed",
  asked.warning === "The previous request may have run and been billed. Run the analysis again, with possible additional charges?",
  asked.warning);
check("and it is the question actually asked",
  asked.seen.length === 2 && asked.seen.every((m) => m === asked.warning));
check("declining authorises nothing and reaches no server",
  asked.declined === false && asked.rpcAfterDecline === 0);
check("accepting is what records the authorisation",
  asked.accepted === true && asked.rpcCalls === 1);
check("a worker that refused to spend is understood, not treated as an error",
  asked.verdict === "outcome_unknown" && /may have run and been billed/.test(asked.message),
  asked.message);

/* Two presses of the confirm button must not become two runs. The database
   makes that true; this is the courtesy in front of it. */
const pressedTwice = await page.evaluate(async () => {
  const guard = window.MDAIAiUsage;
  let runs = 0;
  const start = () => guard.once("unknown-retry", async () => {
    runs += 1;
    await new Promise((r) => setTimeout(r, 40));
    return { ok: true };
  });
  const [first, second] = await Promise.all([start(), start()]);
  return { runs, first, second };
});
check("a double confirmation starts exactly one retry",
  pressedTwice.runs === 1 && pressedTwice.second.skipped === "in_flight",
  JSON.stringify(pressedTwice));

console.log("\n── nothing about data retention moved ──");
for (const worker of ["spatial-analyze", "document-classify", "document-evidence",
                      "field-quality-check", "project-search"]) {
  const source = fs.readFileSync(`supabase/functions/${worker}/index.ts`, "utf8");
  check(`${worker} still sends store:false`, /store: false/.test(source));
}
/* The OpenAI request body moved into the shared provider registry when the
   Studio gained three readers; the posture it carries did not. */
const providerSource = fs.readFileSync("supabase/functions/_shared/ai-providers.ts", "utf8");
check("plan-analyze still stores its background response, as it must to retrieve it",
  /background: true,\s*store: true/.test(providerSource + planSource));
/* Retention, said accurately rather than comfortably. Claude is given signed
   URLs it fetches itself and keeps no file object. Gemini will not fetch a
   URL and its inline limit is under one chunk, so a copy is uploaded to its
   file store — and the honest guarantee is not "inline", it is that every
   copy is deleted when the reading ends and the signed URLs expire. */
check("Claude is given signed URLs rather than a copy of the plan set",
  /\{ type: "url", url: document\.url \}/.test(providerSource)
  && /\{ type: "url", url: image\.url \}/.test(providerSource));
check("every copy uploaded to Gemini's file store is deleted when the reading ends",
  /export async function releaseGoogleFiles/.test(providerSource)
  && /method: "DELETE"/.test(providerSource)
  && /await releaseGoogleFiles\(transport, uploads\)/.test(planSource));
check("no plan bytes are base64-encoded into any request body",
  !/btoa\(/.test(providerSource) && !/"type":"base64"/.test(providerSource));
check("no provider key is ever written into a request body — only into headers",
  /headers\["x-api-key"\] = secret/.test(providerSource) && !/body[^\n]*secret/.test(providerSource));


/* ── the decision, taken through the real block ────────────────────────────
 * The shipping markup, the shipping stylesheet, the shipping ask-project.js,
 * and a worker answer stubbed at the client boundary. Nothing is called that
 * costs anything; what is exercised is what a person actually presses. */
console.log("\n── an unknown outcome, through the real interface ──");
const studioHtml = fs.readFileSync("studio/index.html", "utf8");
const blockStart = studioHtml.indexOf('<section class="ask-project"');
const askBlock = studioHtml
  .slice(blockStart, studioHtml.indexOf("</section>", blockStart) + "</section>".length)
  .replace(" hidden>", ">");

async function openAsk() {
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  await context.route("**://*/**", (r) => (r.request().url().startsWith(baseUrl) ? r.continue() : r.abort()));
  const askPage = await context.newPage();
  await askPage.goto(`${baseUrl}/studio/tests/fixtures/blank.html`);
  await askPage.setContent(`<!doctype html><html><head>
    <link rel="stylesheet" href="${baseUrl}/studio/studio.css"></head>
    <body class="studio"><main style="max-width:620px">${askBlock}</main>
    <script src="${baseUrl}/studio/ai-usage.js"></script>
    <script src="${baseUrl}/studio/ask-project.js"></script></body></html>`);
  await askPage.waitForFunction(() => !!window.MDAIAskProject);
  await askPage.evaluate(() => {
    window.__invokes = [];
    window.__rpc = [];
    window.__prompts = [];
    window.__answer = null;
    /* The worker's first answer is the refusal; after an authorisation is
       recorded it answers normally, exactly as the real one would. */
    window.__authorised = false;
    const client = {
      functions: {
        invoke: async (name, opts) => {
          window.__invokes.push({ name, body: opts?.body });
          await new Promise((r) => setTimeout(r, 30));
          if (!window.__authorised) {
            return { data: { skipped: "outcome_unknown", answer: null,
              unresolved_run_id: "run-lost-1", ai_calls: 0 }, error: null };
          }
          return { data: window.__answer, error: null };
        },
      },
      rpc: async (name, args) => {
        window.__rpc.push({ name, args });
        if (name === "confirm_ai_run_retry") { window.__authorised = true; return { data: true, error: null }; }
        return { data: null, error: null };
      },
    };
    /* The confirm dialog, captured rather than shown. */
    window.__decide = true;
    window.confirm = (message) => { window.__prompts.push(message); return window.__decide; };
    window.MDAIAskProject.mount({ client, propertyId: "prop-1", openSource: () => {} });
  });
  return { context, askPage };
}

const { context: askContext, askPage } = await openAsk();

/* 1 — the refusal explains itself and offers exactly one button. */
await askPage.fill("#ask-question", "How many beams are required?");
await askPage.click("#ask-submit");
await askPage.waitForSelector("#ask-retry");
const blocked = await askPage.evaluate(() => ({
  text: document.getElementById("ask-answer-text").textContent,
  buttons: document.querySelectorAll("#ask-retry").length,
  label: document.getElementById("ask-retry").textContent,
  sources: document.getElementById("ask-sources").children.length,
  invokes: window.__invokes.length,
  prompts: window.__prompts.length,
}));
check("an unknown outcome explains itself instead of failing",
  /may have run and been billed/.test(blocked.text), blocked.text);
check("and offers exactly one button to resolve it",
  blocked.buttons === 1 && blocked.label === "Ask again");
check("no answer and no sources are shown for a run nobody can vouch for",
  blocked.sources === 0);
check("and nothing was asked twice on the way there",
  blocked.invokes === 1 && blocked.prompts === 0);

/* 2 — declining keeps the block and spends nothing. */
await askPage.evaluate(() => { window.__decide = false; });
await askPage.click("#ask-retry");
await askPage.waitForFunction(() => window.__prompts.length === 1);
const declined = await askPage.evaluate(() => ({
  prompt: window.__prompts[0],
  rpc: window.__rpc.length,
  invokes: window.__invokes.length,
  stillThere: !!document.getElementById("ask-retry"),
  note: document.querySelector(".ask-retry-line")?.textContent || "",
}));
check("pressing it asks the agreed question, in the agreed words",
  declined.prompt === "The previous request may have run and been billed. Run the analysis again, with possible additional charges?",
  declined.prompt);
check("declining authorises nothing and calls no worker",
  declined.rpc === 0 && declined.invokes === 1);
check("and the block stays exactly where it was",
  declined.stillThere && /still unresolved/.test(declined.note), declined.note);

/* 3 — confirming authorises once and runs exactly once. */
await askPage.evaluate(() => {
  window.__decide = true;
  window.__answer = {
    answer: "Fourteen LVL beams are required on sheet S2.1.",
    citations: [{ source_id: "document:doc-1", kind: "document", opens: "document",
      document_id: "doc-1", label: "structural-set.pdf", sheet_ref: "S2.1", why: "beam schedule" }],
    limitations: "", confidence: "medium", records_considered: 5, ai_calls: 1,
  };
});
await askPage.click("#ask-retry");
await askPage.waitForFunction(() => document.querySelectorAll(".ask-source-link").length === 1);
const authorised = await askPage.evaluate(() => ({
  rpc: window.__rpc.map((call) => call.name),
  runId: window.__rpc[0]?.args?.p_run_id,
  invokes: window.__invokes.length,
  prompts: window.__prompts.length,
  answer: document.getElementById("ask-answer-text").textContent,
}));
check("confirming records the authorisation against the blocked run",
  authorised.rpc.length === 1 && authorised.rpc[0] === "confirm_ai_run_retry"
  && authorised.runId === "run-lost-1", JSON.stringify(authorised.rpc));
check("and starts exactly one new run",
  authorised.invokes === 2, `${authorised.invokes} worker calls in total`);
check("the person was asked twice and answered twice — no silent third",
  authorised.prompts === 2);
check("and the answer they paid for is on the screen",
  /Fourteen LVL beams/.test(authorised.answer));
await askContext.close();

/* 4 — the double click, on the real button. */
const { context: doubleContext, askPage: doublePage } = await openAsk();
await doublePage.fill("#ask-question", "How many beams are required?");
await doublePage.click("#ask-submit");
await doublePage.waitForSelector("#ask-retry");
await doublePage.evaluate(() => {
  window.__answer = { answer: "Fourteen.", citations: [], limitations: "",
    confidence: "low", records_considered: 5, ai_calls: 1 };
  /* Two presses microseconds apart, before any render can disable anything. */
  const button = document.getElementById("ask-retry");
  button.click();
  button.click();
});
await doublePage.waitForFunction(() => window.__invokes.length >= 2);
await doublePage.waitForTimeout(300);
const doubled = await doublePage.evaluate(() => ({
  prompts: window.__prompts.length,
  rpc: window.__rpc.length,
  invokes: window.__invokes.length,
}));
check("a double press asks the person once, not twice",
  doubled.prompts === 1, `${doubled.prompts} prompts`);
check("authorises once",
  doubled.rpc === 1, `${doubled.rpc} authorisations`);
check("and buys exactly one new run",
  doubled.invokes === 2, `${doubled.invokes} worker calls in total`);
await doubleContext.close();

console.log("\n── every screen that can be blocked can also resolve it ──");
for (const [file, screen] of [
  ["studio/plans/plans.js", "the plans door"],
  ["studio/studio.js", "the room analysis"],
  ["studio/ask-project.js", "Ask this project"],
]) {
  const source = fs.readFileSync(file, "utf8");
  check(`${screen} remembers a block instead of losing it`,
    /rememberUnknown\(/.test(source));
  check(`${screen} offers the decision before it spends`,
    /offerUnknownRetry\(/.test(source));
}
/* And every worker hands over the run there is a decision about. */
for (const worker of ALL_WORKERS) {
  const source = fs.readFileSync(`supabase/functions/${worker}/index.ts`, "utf8");
  check(`${worker} names the run a person has to decide about`,
    /unresolved_run_id/.test(source));
}

await browser.close();
server.close();
console.log(bad ? `\n${bad} FAILURES` : "\nALL OK");
process.exit(bad ? 1 : 0);
