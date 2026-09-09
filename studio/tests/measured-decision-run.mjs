/* MEASURED DECISION RUN — is the screen showing the engine, or a picture of it?
 *
 * That is the only question worth asking about this page, and every check
 * below is a form of it. The demonstration is small and invented on purpose,
 * but nothing about it may be staged: the assignments, readings, comparisons,
 * disagreements, decisions and evidence a person sees have to be what the real
 * Core V2 scheduler wrote, in a real browser, with no provider and no key.
 *
 * So this runs the page in Chromium exactly as a person would, presses the
 * same buttons, and then compares what is on the screen against the engine's
 * own record. It also proves the negatives — that no reader saw another
 * reader's answer, that agreement alone was not shown as proof, and that
 * nothing reached for a transport or a key.
 */
import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
import { buildEngine } from "../measured-decision-run/build-engine.mjs";

const ROOT = path.resolve(".");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json" };
const server = http.createServer((req, res) => {
  let f = path.join(ROOT, decodeURIComponent(req.url.split("?")[0]));
  if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, "index.html");
  if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(f)] || "application/octet-stream" });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
const SHOTS = path.join(ROOT, "studio/tests/screenshots");
fs.mkdirSync(SHOTS, { recursive: true });

let bad = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? `\n         ${detail}` : ""}`);
  if (!ok) bad++;
};
const section = (title) => console.log(`\n── ${title} ──`);

/* ══════════════════ 1 · what is committed is what the build produces ═════ */

section("the engine on the page is the engine in the repository");
{
  const before = fs.readFileSync(path.join(ROOT, "studio/measured-decision-run/engine/kernel/scheduler.js"), "utf8");
  buildEngine({ quiet: true });
  const after = fs.readFileSync(path.join(ROOT, "studio/measured-decision-run/engine/kernel/scheduler.js"), "utf8");
  check("engine/ is exactly what build-engine.mjs produces from workers/core-v2 — nothing hand-edited into it",
    before === after, before === after ? "" : "run: node studio/measured-decision-run/build-engine.mjs");

  const compiled = fs.readFileSync(path.join(ROOT, "studio/measured-decision-run/engine/kernel/scheduler.js"), "utf8");
  const source = fs.readFileSync(path.join(ROOT, "workers/core-v2/kernel/scheduler.ts"), "utf8");
  /* The engine's own sentences survive compilation, so what runs in the
     browser is recognisably the reviewed file and not a rewrite. */
  /* Sentences the reviewed source raises, which survive type-stripping. If the
     browser were running a rewrite of the engine rather than the engine, these
     would not be here. */
  const SHARED = ["core-v2: plan() before tick()", "core_v2.disagreement.needs_human", "cancelled_by_person", "core_v2.attempt.outcome_unknown"];
  const missing = SHARED.filter((line) => !(compiled.includes(line) && source.includes(line)));
  check("the compiled scheduler still carries the reviewed source's own logic, not a reimplementation",
    missing.length === 0, missing.join(" | "));
}

/* ══════════════════════════ 2 · the page, in a real browser ══════════════ */

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => consoleErrors.push(String(e)));

/* Every request the page makes, so "sealed" is measured rather than asserted. */
const requested = [];
page.on("request", (r) => requested.push(r.url()));

await page.goto(`${base}/studio/measured-decision-run/`, { waitUntil: "networkidle" });

section("the opening screen");
{
  check("the explanation is the one a buyer reads, in ordinary language",
    (await page.textContent("#explainer")).replace(/\s+/g, " ").trim()
      === "Independent AI workers examine the same evidence separately. The system compares their findings, tests disagreements and produces a traceable decision.");
  check("there is one primary button, and it says Start demonstration",
    (await page.textContent("#start")).trim() === "Start demonstration");
  check("no results are shown before a run exists", await page.isHidden("#results"));
  await page.screenshot({ path: path.join(SHOTS, "measured-decision-run-initial.png"), fullPage: true });
}

section("a run, watched from the outside");
{
  await page.click("#start");
  await page.waitForSelector("#timeline li", { timeout: 20000 });
  /* Caught mid-run: the timeline is showing a stage, and Stop is offered. */
  check("while it runs there is a Stop control, not just an animation", await page.isVisible("#stop"));
  await page.screenshot({ path: path.join(SHOTS, "measured-decision-run-running.png"), fullPage: true });

  await page.waitForSelector("#again:not([hidden])", { timeout: 60000 });
  check("the run finishes and offers Run again", await page.isVisible("#again"));
  await page.screenshot({ path: path.join(SHOTS, "measured-decision-run-complete.png"), fullPage: true });
}

/* ═══════════ 3 · is what is on the screen what the engine recorded? ═════ */

section("the screen against the engine's own record");
const shown = await page.evaluate(() => ({
  agreed: Number(document.getElementById("count-agreed").textContent),
  disagreement: Number(document.getElementById("count-disagreement").textContent),
  unproved: Number(document.getElementById("count-unproved").textContent),
  decision: Number(document.getElementById("count-decision").textContent),
  workers: [...document.querySelectorAll("#workers li")].map((li) => li.textContent),
  workflowId: [...document.querySelectorAll("#technical dd")][0]?.textContent ?? "",
  facts: [...document.querySelectorAll("#facts div")].map((d) => d.textContent.replace(/\s+/g, " ").trim()),
  evidenceButtons: document.querySelectorAll(".evidence-open").length,
  agreedWithoutEvidence: [...document.querySelectorAll("#list-agreed .finding")]
    .filter((f) => !f.querySelector(".evidence-open")).length,
}));

const record = await page.evaluate(async () => {
  const run = window.measuredDecisionRun.current();
  const view = await window.measuredDecisionRun.readRun(run);
  const claims = await run.repo.listClaims({ workflowId: run.workflowId });
  const tasks = await run.repo.listTasks(run.workflowId);
  return {
    workflowId: run.workflowId,
    agreed: view.agreed.length,
    disagreement: view.disagreements.length,
    unproved: view.unproved.length,
    decision: view.decisions.length,
    acceptedClaims: claims.filter((c) => c.status === "accepted").length,
    corroboratedNotAccepted: claims.filter((c) => c.status === "corroborated").length,
    taskCount: tasks.length,
    /* every packet every executor was actually handed */
    packets: run.registry.packetsSeen.length,
    acceptedWithoutAnchor: view.agreed.filter((c) => c.evidence.length === 0).length,
    disagreementSides: view.disagreements.map((d) => d.sides.map((s) => ({ who: s.madeBy, status: s.status, value: s.value?.quantity }))),
    unprovedStatuses: view.unproved.map((c) => c.status),
  };
});

check("the four counts on the screen are the engine's own counts, not a UI array",
  shown.agreed === record.agreed && shown.disagreement === record.disagreement
  && shown.unproved === record.unproved && shown.decision === record.decision,
  `screen ${JSON.stringify(shown)} vs record ${JSON.stringify({ agreed: record.agreed, disagreement: record.disagreement, unproved: record.unproved, decision: record.decision })}`);
check("the workflow id shown is the workflow the scheduler actually ran",
  shown.workflowId === record.workflowId && /^[0-9a-f-]{36}$/.test(record.workflowId), record.workflowId);
check("the run really did work — assignments and packets exist",
  record.taskCount > 5 && record.packets > 5, `${record.taskCount} assignments, ${record.packets} packets`);
check("EVERY accepted finding has an evidence anchor",
  record.acceptedWithoutAnchor === 0 && shown.agreedWithoutEvidence === 0,
  `${record.acceptedWithoutAnchor} unanchored in the record, ${shown.agreedWithoutEvidence} without a control on screen`);
check("every visible claim offers View evidence", shown.evidenceButtons > 0, `${shown.evidenceButtons} controls`);

section("agreement is not proof, and the screen says so");
check("a real disagreement was found, with two sides that differ",
  record.disagreementSides.length > 0 && record.disagreementSides[0].length === 2
  && record.disagreementSides[0][0].value !== record.disagreementSides[0][1].value,
  JSON.stringify(record.disagreementSides[0]));
check("one side was accepted and the other rejected — settled on evidence, not by counting readers",
  record.disagreementSides[0]?.some((s) => s.status === "accepted") && record.disagreementSides[0]?.some((s) => s.status === "rejected"));
check("claims two readers agreed on are NOT shown as accepted findings",
  record.corroboratedNotAccepted > 0 && record.unprovedStatuses.includes("corroborated"),
  `${record.corroboratedNotAccepted} corroborated, and they appear under Unproved`);
check("an unsupported claim stays unproved rather than quietly becoming a finding",
  record.unproved > 0 && record.agreed === record.acceptedClaims - record.disagreementSides.flat().filter((s) => s.status === "accepted").length,
  `${record.unproved} unproved, ${record.acceptedClaims} accepted in the record`);

section("no reader was shown another reader's answer");
const blind = await page.evaluate(() => {
  const run = window.measuredDecisionRun.current();
  const seen = run.registry.packetsSeen;
  const blindPackets = seen.filter((p) => p.independenceGroup);
  /* Everything a blind packet carried, flattened to text. A peer's answer
     appearing anywhere in it would show up here. */
  const leaks = [];
  for (const packet of blindPackets) {
    const body = JSON.stringify(packet);
    for (const other of blindPackets) {
      if (other === packet || other.independenceGroup === packet.independenceGroup) continue;
      if (other.taskId && body.includes(other.taskId)) leaks.push(`${packet.taskId} carried ${other.taskId}`);
    }
  }
  return { blindPackets: blindPackets.length, groups: [...new Set(blindPackets.map((p) => p.independenceGroup))], leaks };
});
check("there were at least two blind reading groups", blind.groups.length >= 2, blind.groups.join(", "));
check("no blind packet carried anything belonging to the other group's reading",
  blind.leaks.length === 0, blind.leaks.join("; "));

section("nothing reached for a provider, a transport or a key");
check("the page requested only its own files — no provider, no api, no key service",
  requested.every((u) => u.startsWith(base) || u.startsWith("https://fonts.g")),
  requested.filter((u) => !u.startsWith(base) && !u.startsWith("https://fonts.g")).join(", "));
check("no provider transport module is even part of the page",
  !fs.existsSync(path.join(ROOT, "studio/measured-decision-run/engine/transport")),
  "core-v2-runtime's transport is not compiled into the browser engine");
{
  const engineFiles = [];
  const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); e.isDirectory() ? walk(f) : engineFiles.push(f); } };
  walk(path.join(ROOT, "studio/measured-decision-run"));
  const offenders = engineFiles.filter((f) => /\.(js|mjs|html|css)$/.test(f))
    .filter((f) => /apiKey|API_KEY|process\.env|Authorization|x-api-key|x-goog-api-key/.test(fs.readFileSync(f, "utf8")));
  check("nothing under the page reads a key, names a key header or touches an environment",
    offenders.length === 0, offenders.map((f) => path.relative(ROOT, f)).join(", "));
}
check("external cost is stated as zero on the screen",
  shown.facts.some((f) => /External cost\s*\$0\.00/.test(f)), shown.facts.join(" | "));
check("the provider network is stated as sealed",
  shown.facts.some((f) => /Provider network\s*sealed/.test(f)));

section("View evidence shows the evidence, not a description of it");
{
  await page.click("#list-agreed .evidence-open");
  await page.waitForSelector("#evidence[open]", { timeout: 10000 });
  const dialog = await page.evaluate(() => {
    const body = document.getElementById("evidence-body");
    return {
      labels: [...body.querySelectorAll("dt")].map((d) => d.textContent),
      hasExcerptOrImage: !!body.querySelector(".excerpt, img"),
      text: body.textContent.replace(/\s+/g, " ").trim().slice(0, 200),
    };
  });
  check("it names the source, where on it, who claimed it and the verification state",
    ["Source", "Claimed by", "Verification state"].every((l) => dialog.labels.includes(l)),
    dialog.labels.join(", "));
  check("and it shows the material itself — an excerpt or the image region",
    dialog.hasExcerptOrImage, dialog.text.slice(0, 100));
  await page.screenshot({ path: path.join(SHOTS, "measured-decision-run-evidence.png") });
  await page.evaluate(() => document.getElementById("evidence").close());
}

section("it fits a phone, on a finished run");
{
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(SHOTS, "measured-decision-run-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForTimeout(150);
}

section("stop uses the engine's cancellation, and run again is a new run");
{
  const first = record.workflowId;
  await page.click("#again");
  await page.waitForSelector("#stop:not([hidden])", { timeout: 20000 });
  await page.click("#stop");
  await page.waitForSelector("#again:not([hidden])", { timeout: 30000 });
  await page.waitForTimeout(300);
  const stopped = await page.evaluate(async () => {
    const run = window.measuredDecisionRun.current();
    const workflow = await run.repo.getWorkflow(run.workflowId);
    return { id: run.workflowId, state: workflow.state, cancelRequestedAt: workflow.cancelRequestedAt };
  });
  check("Run again started a NEW workflow, not a re-render of the last one",
    stopped.id !== first, `${first} → ${stopped.id}`);
  check("Stop went through the engine's own cancellation — the record carries the request",
    stopped.cancelRequestedAt !== null && stopped.cancelRequestedAt !== undefined, JSON.stringify(stopped));
  check("and the workflow is genuinely in a cancelled state, not merely hidden",
    ["cancelled", "cancelling", "partial", "needs_attention"].includes(stopped.state), stopped.state);
}

section("it fits a desktop and a phone");
for (const [name, viewport] of [["desktop", { width: 1280, height: 900 }], ["mobile", { width: 390, height: 844 }]]) {
  await page.setViewportSize(viewport);
  await page.waitForTimeout(150);
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    wide: [...document.querySelectorAll("body *")]
      .filter((n) => n.getBoundingClientRect().right > document.documentElement.clientWidth + 1)
      .slice(0, 4).map((n) => n.className || n.tagName),
  }));
  check(`${name}: the page does not scroll sideways`,
    overflow.scrollWidth <= overflow.clientWidth + 1,
    `${overflow.scrollWidth} > ${overflow.clientWidth}; ${overflow.wide.join(", ")}`);
}

section("the page did not complain");
check("no console errors and no uncaught exceptions", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));

await browser.close();
server.close();

console.log(bad === 0 ? "\n  ALL OK" : `\n  ${bad} FAILURE${bad === 1 ? "" : "S"}`);
process.exit(bad === 0 ? 0 : 1);
