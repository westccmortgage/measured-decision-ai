/* THE LAST THREE DEAD ENDS — walked through the real pages.
 *
 * After #197 and #198 an unknown outcome could be resolved from the plans
 * door, a room's analysis and Ask this project. Three places could not:
 *
 *   · the document reader (invoices, delivery tickets) — no button anywhere
 *   · page classification — worse: it said "Pages read by AI" about a
 *     reading that never happened
 *   · the field quality check — dispatched server-to-server, nobody reading
 *     the answer, the row stuck in 'processing' until the end of time
 *
 * Each is driven here through the shipping page and the shipping script,
 * with the worker's answer stubbed at the client boundary: cancel keeps the
 * block and spends nothing; confirm authorises once and runs once; a double
 * press asks once. No provider is called. Nothing here costs anything.
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

const AGREED = "The previous request may have run and been billed. Run the analysis again, with possible additional charges?";
const ABOUT_TO_SPEND = "This will run AI again and may use additional credits.";

/* The confirm dialog, captured rather than shown, answering from a queue the
   test fills before each press. */
const CONFIRM_STUB = `
  window.__prompts = [];
  window.__decisions = [];
  window.__toasts = [];
  window.confirm = (message) => {
    window.__prompts.push(message);
    return window.__decisions.length ? window.__decisions.shift() : false;
  };
  /* Every sentence the toast ever showed, because the last one standing is
     not the only one a person read. */
  document.addEventListener("DOMContentLoaded", () => {
    const toast = document.getElementById("toast");
    if (!toast) return;
    new MutationObserver(() => { if (toast.textContent) window.__toasts.push(toast.textContent); })
      .observe(toast, { childList: true, characterData: true, subtree: true });
  });`;

const calls = (page, name) => page.evaluate((n) => window.__rpcCalls.filter((c) => c.name === n), name);

/* ═══════════════════════════════════════════ the document reader ═══ */
console.log("── an invoice whose reading was lost, from the plans page ──");
{
  const world = deckTakeoffRows();
  world.project_documents = [...(world.project_documents || []),
    planDocument({ id: "doc-invoice", original_filename: "abc-lumber-4471.pdf", document_type: "invoice", status: "uploaded" }),
    planDocument({ id: "doc-invoice-2", original_filename: "abc-lumber-4472.pdf", document_type: "invoice", status: "uploaded" }),
    planDocument({ id: "doc-mixed", original_filename: "closeout-set.pdf", document_type: "other", status: "uploaded" }),
  ];
  const refusal = { skipped: "outcome_unknown", unresolved_run_id: "run-lost-inv", ai_calls: 0 };
  const functions = {
    /* First press: the ledger refuses because an earlier attempt is
       unresolved. After the person confirms: the reading. */
    "document-evidence": { sequence: [refusal, { job_id: "job-read-2", lines_recorded: 3, unreadable: 0, reconciled: true }] },
    "document-classify": refusal,
  };
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route("**://*/**", (r) => (r.request().url().startsWith(base) ? r.continue() : r.abort()));
  await context.addInitScript(`window.__seed = ${JSON.stringify({ rows: world, functions })};`);
  await context.addInitScript({ path: "studio/tests/fake-supabase.js" });
  await context.addInitScript(CONFIRM_STUB);
  const page = await context.newPage();
  await page.goto(`${base}/studio/plans/?property=prop-1`, { waitUntil: "networkidle" });
  /* The page lands on the Owner Summary; the document list lives one press
     further in, under Technical Intelligence — the same press a person makes. */
  await page.click("#summary-full");
  await page.waitForSelector(".document-row");

  const rows = await page.evaluate(() => [...document.querySelectorAll(".document-row")].map((row) => ({
    name: row.querySelector(".document-name strong")?.textContent,
    reread: !!row.querySelector("[data-document-reread]"),
    label: row.querySelector("[data-document-reread]")?.textContent,
  })));
  check("every invoice has a Read again action beside it",
    rows.filter((r) => /abc-lumber/.test(r.name)).every((r) => r.reread && r.label === "Read again"),
    JSON.stringify(rows.filter((r) => /abc-lumber/.test(r.name))));
  check("and so does an undeclared PDF, which goes back through classification",
    rows.find((r) => r.name === "closeout-set.pdf")?.reread === true);
  check("a plan sheet does not — plans have their own door",
    rows.filter((r) => !/abc-lumber|closeout/.test(r.name)).every((r) => !r.reread));

  /* 1 — press, agree to spend, ledger refuses as unknown, decline. */
  await page.evaluate(() => { window.__decisions.push(true, false); });
  await page.click('[data-document-reread="doc-invoice"]');
  await page.waitForFunction(() => window.__prompts.length === 2);
  await page.waitForFunction(() => document.querySelector(".document-unknown"));
  const declined = {
    prompts: await page.evaluate(() => window.__prompts),
    reads: (await calls(page, "document-evidence")).map((c) => c.args?.force),
    confirms: (await calls(page, "confirm_ai_run_retry")).length,
    note: await page.textContent(".document-unknown"),
    button: await page.$eval('[data-document-reread="doc-invoice"]', (b) => b.textContent),
  };
  check("Read again first asks about the money about to be spent",
    declined.prompts[0] === ABOUT_TO_SPEND, declined.prompts[0]);
  check("one forced reading is attempted",
    declined.reads.length === 1 && declined.reads[0] === true, JSON.stringify(declined.reads));
  check("the ledger's refusal is answered right then with the agreed question",
    declined.prompts[1] === AGREED, declined.prompts[1]);
  check("declining authorises nothing and reads nothing more",
    declined.confirms === 0 && declined.reads.length === 1);
  check("the row says why, and keeps its button",
    /may have run and been billed/.test(declined.note) && declined.button === "Read again", declined.note);

  /* 2 — press again: the unresolved question comes first, and a yes reads once. */
  await page.evaluate(() => { window.__decisions.push(true); });
  await page.click('[data-document-reread="doc-invoice"]');
  await page.waitForFunction(() => window.__rpcCalls.filter((c) => c.name === "document-evidence").length === 2);
  const confirmed = {
    prompts: await page.evaluate(() => window.__prompts.slice(2)),
    confirms: await calls(page, "confirm_ai_run_retry"),
    reads: (await calls(page, "document-evidence")).map((c) => c.args?.force),
    toast: await page.evaluate(() => document.getElementById("toast")?.textContent || ""),
    note: await page.$(".document-unknown"),
  };
  check("with a block remembered the agreed question comes first, and alone",
    confirmed.prompts.length === 1 && confirmed.prompts[0] === AGREED, JSON.stringify(confirmed.prompts));
  check("confirming authorises the blocked run by id",
    confirmed.confirms.length === 1 && confirmed.confirms[0].args?.p_run_id === "run-lost-inv");
  check("and reads exactly once more, without force",
    confirmed.reads.length === 2 && confirmed.reads[1] === false, JSON.stringify(confirmed.reads));
  check("the delivery is recorded and the block is gone",
    /Delivery recorded: 3 lines/.test(confirmed.toast) && confirmed.note === null, confirmed.toast);

  /* 3 — the double press, on the second invoice. */
  await page.evaluate(() => { window.__sequenceIndex["document-evidence"] = 0; window.__decisions.push(true, false); });
  await page.click('[data-document-reread="doc-invoice-2"]');
  await page.waitForFunction(() => document.querySelector(".document-unknown"));
  const before = (await calls(page, "document-evidence")).length;
  await page.evaluate(() => {
    window.__decisions.push(true);
    const button = document.querySelector('[data-document-reread="doc-invoice-2"]');
    button.click(); button.click();
  });
  await page.waitForFunction((n) => window.__rpcCalls.filter((c) => c.name === "document-evidence").length === n + 1, before);
  await page.waitForTimeout(300);
  const doubled = {
    prompts: await page.evaluate(() => window.__prompts.slice(-1)),
    promptCount: await page.evaluate(() => window.__prompts.length),
    confirms: (await calls(page, "confirm_ai_run_retry")).length,
    reads: (await calls(page, "document-evidence")).length,
  };
  check("a double press asks the agreed question once",
    doubled.prompts[0] === AGREED && doubled.promptCount === 6, `${doubled.promptCount} prompts in total`);
  check("authorises once", doubled.confirms === 2, `${doubled.confirms} authorisations across both invoices`);
  check("and reads once", doubled.reads === before + 1, `${doubled.reads} reads in total`);

  /* 4 — classification never says "read" about a reading that did not happen. */
  await page.evaluate(() => { window.__decisions.push(true, false); });
  await page.click('[data-document-reread="doc-mixed"]');
  await page.waitForFunction(() => window.__rpcCalls.some((c) => c.name === "document-classify"));
  await page.waitForTimeout(200);
  const classified = await page.evaluate(() => window.__toasts.slice(-3));
  check("a refused classification is never announced as pages read",
    classified.every((t) => !/Pages read by AI/.test(t)), JSON.stringify(classified));
  check("it is announced as the decision it is",
    classified.some((t) => /may have run and been billed/.test(t)), JSON.stringify(classified));
  await context.close();
}

/* ═══════════════════════════════════════════ the field check ═══ */
console.log("\n── a field check nobody could vouch for, from the operations page ──");
{
  const org = "org-1";
  const assignment = (id, title) => ({
    id, organization_id: org, property_id: "prop-1", capture_task_id: `task-${id}`, requirement_id: `req-${id}`,
    status: "ready_for_review", worker_name: "Sam Field", worker_email: "sam@example.com", due_at: "2026-09-10T17:00:00Z",
    instructions_snapshot: { title, location: { name: "Deck — west half" } }, created_at: "2026-09-06T10:00:00Z",
  });
  const unknownCheck = (id) => ({
    id: `qc-${id}`, organization_id: org, property_id: "prop-1", assignment_id: id, capture_task_id: `task-${id}`,
    state: "outcome_unknown", ai_run_id: `run-lost-${id}`, evidence_ids: [`ev-${id}`],
    result: { verdict: null, summary: "An earlier automated check of these files may have run and been billed, and its answer was not received.", checks: [] },
    created_at: "2026-09-06T10:05:00Z",
  });
  const rows = {
    organization_members: [{ organization_id: org, user_id: "user-1", role: "reviewer", created_at: "2026-01-01" }],
    properties: [{ id: "prop-1", organization_id: org, name: "Hutton Deck", active_baseline_id: "bl-1", workflow_state: "active" }],
    field_assignments: [assignment("asg-1", "Ledger flashing photo"), assignment("asg-2", "Joist hanger photo")],
    field_quality_checks: [unknownCheck("asg-1"), unknownCheck("asg-2")],
    capture_tasks: [
      { id: "task-asg-1", baseline_id: "bl-1", requirement_id: "req-asg-1", status: "submitted" },
      { id: "task-asg-2", baseline_id: "bl-1", requirement_id: "req-asg-2", status: "submitted" },
    ],
    capture_requirements: [
      { id: "req-asg-1", baseline_id: "bl-1", title: "Ledger flashing photo" },
      { id: "req-asg-2", baseline_id: "bl-1", title: "Joist hanger photo" },
    ],
    evidence_items: [], project_documents: [],
  };
  const functions = {
    "field-workflow": { byAction: { retry_quality_check: { status: "ai_check", quality_check_id: "qc-asg-1" } }, default: {} },
  };
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route("**://*/**", (r) => (r.request().url().startsWith(base) ? r.continue() : r.abort()));
  await context.addInitScript(`window.__seed = ${JSON.stringify({ rows, functions })};`);
  await context.addInitScript({ path: "studio/tests/fake-supabase.js" });
  await context.addInitScript(CONFIRM_STUB);
  const page = await context.newPage();
  await page.goto(`${base}/studio/operations/?property=prop-1`, { waitUntil: "networkidle" });
  await page.waitForSelector("[data-qc-retry]");

  const card = await page.evaluate(() => {
    const qc = document.querySelector(".qc.unknown");
    return {
      status: qc?.querySelector("strong")?.textContent,
      summary: qc?.textContent,
      buttons: document.querySelectorAll("[data-qc-retry]").length,
      label: document.querySelector("[data-qc-retry]")?.textContent,
      reviewable: !!document.querySelector('[data-review="asg-1"]'),
    };
  });
  check("the card names the state instead of showing a spinner that never stops",
    card.status === "Unknown outcome", card.status);
  check("and says what it means",
    /may have run and been billed/.test(card.summary || ""));
  check("with one button per unresolved check",
    card.buttons === 2 && card.label === "Run check again");
  check("while the assignment stays reviewable by eye",
    card.reviewable === true);

  /* cancel */
  await page.evaluate(() => { window.__decisions.push(false); });
  await page.click('[data-qc-retry="asg-1"]');
  await page.waitForFunction(() => window.__prompts.length === 1);
  await page.waitForTimeout(150);
  const cancelled = {
    prompt: await page.evaluate(() => window.__prompts[0]),
    confirms: (await calls(page, "confirm_ai_run_retry")).length,
    dispatches: (await calls(page, "field-workflow")).filter((c) => c.args?.action === "retry_quality_check").length,
    button: !!(await page.$('[data-qc-retry="asg-1"]')),
    toast: await page.evaluate(() => document.getElementById("toast")?.textContent || ""),
  };
  check("Run check again asks the agreed question", cancelled.prompt === AGREED, cancelled.prompt);
  check("cancelling authorises nothing and dispatches nothing",
    cancelled.confirms === 0 && cancelled.dispatches === 0);
  check("the button stays and the screen says nothing was run",
    cancelled.button && /Nothing was run/.test(cancelled.toast), cancelled.toast);

  /* confirm */
  await page.evaluate(() => { window.__decisions.push(true); });
  await page.click('[data-qc-retry="asg-1"]');
  await page.waitForFunction(() => window.__rpcCalls.some((c) => c.name === "field-workflow" && c.args?.action === "retry_quality_check"));
  const confirmed = {
    confirms: await calls(page, "confirm_ai_run_retry"),
    dispatches: (await calls(page, "field-workflow")).filter((c) => c.args?.action === "retry_quality_check"),
  };
  check("confirming authorises the check's own run by id",
    confirmed.confirms.length === 1 && confirmed.confirms[0].args?.p_run_id === "run-lost-asg-1");
  check("and asks the field service to dispatch it exactly once",
    confirmed.dispatches.length === 1 && confirmed.dispatches[0].args?.assignment_id === "asg-1");

  /* double press, on the second assignment */
  await page.waitForSelector('[data-qc-retry="asg-2"]');
  await page.evaluate(() => {
    window.__decisions.push(true, true);
    const button = document.querySelector('[data-qc-retry="asg-2"]');
    button.click(); button.click();
  });
  await page.waitForFunction(() => window.__rpcCalls.filter((c) => c.name === "field-workflow" && c.args?.action === "retry_quality_check").length === 2);
  await page.waitForTimeout(300);
  const doubled = {
    prompts: await page.evaluate(() => window.__prompts.length),
    confirms: (await calls(page, "confirm_ai_run_retry")).length,
    dispatches: (await calls(page, "field-workflow")).filter((c) => c.args?.action === "retry_quality_check").length,
  };
  check("a double press asks once", doubled.prompts === 3, `${doubled.prompts} prompts in total`);
  check("authorises once", doubled.confirms === 2, `${doubled.confirms} across both assignments`);
  check("and dispatches once", doubled.dispatches === 2, `${doubled.dispatches} across both assignments`);
  await context.close();
}

/* ═══════════════════════════════════════════ the server's own refusals ═══ */
console.log("\n── what the servers refuse on their own ──");
{
  const workflow = fs.readFileSync("supabase/functions/field-workflow/index.ts", "utf8");
  const qc = fs.readFileSync("supabase/functions/field-quality-check/index.ts", "utf8");
  check("only a reviewer may repeat a field check",
    /retry_quality_check[\s\S]{0,1600}Reviewer access is required/.test(workflow));
  check("and only one whose outcome is unknown",
    /only a check with an unknown outcome can be repeated this way/.test(workflow));
  check("and only after the confirmation is on record",
    /retry_authorized_at[\s\S]{0,200}needs confirmation first/.test(workflow));
  check("submit never dispatches a repeat — only a new check",
    (workflow.match(/functions\/v1\/field-quality-check/g) || []).length === 2);
  check("the worker no longer leaves a refused check in processing",
    /settleWithoutReading\("outcome_unknown"/.test(qc) && /settleWithoutReading\("needs_review"/.test(qc));
  check("a result already bought for these files is used, not re-bought",
    /applyResult\(sameFiles\.result/.test(qc));
  check("a lost answer closes the row as unknown, not failed",
    /state: lost \? "outcome_unknown" : "failed"/.test(qc));
  for (const worker of ["document-classify", "document-evidence"]) {
    const source = fs.readFileSync(`supabase/functions/${worker}/index.ts`, "utf8");
    check(`${worker} accepts force, and force does not reach past the ledger`,
      /force: Boolean\(body\?\.force\)/.test(source) && !/UNKNOWN[^\n]*force/.test(source));
  }
}

await browser.close();
server.close();
console.log(bad ? `\n${bad} FAILURES` : "\nALL OK");
process.exit(bad ? 1 : 0);
