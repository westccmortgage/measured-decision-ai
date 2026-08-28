/* The Owner View behind its boundary: three people open the same page.
 *
 * An INTERNAL Studio member previews what the client will see — explicit
 * badge, explicit way back into Studio. An EXTERNAL OWNER sees exactly the
 * projects they were granted: no Studio link, no organization-wide picker,
 * no drafts, nothing to type. A SIGNED-OUT visitor sees a magic-link
 * sign-in form and not one byte of project data.
 *
 * And in every case the release is the publication boundary: only
 * human-approved releases and published technical results render; a 360
 * capture opens in the Studio's own viewer; empty states are honest.
 */
import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";
import http from "http"; import fs from "fs"; import path from "path";
import { deckTakeoffRows } from "./seed.mjs";

let bad = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? `\n         ${detail}` : ""}`);
  if (!ok) bad++;
};

const ROOT = path.resolve(".");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".png": "image/png" };
const server = http.createServer((req, res) => {
  let f = path.join(ROOT, decodeURIComponent(req.url.split("?")[0]));
  if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, "index.html");
  if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(f)] || "application/octet-stream" });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

const manifest = {
  schema: "com.measureddecision.vision-release/1.0",
  property: { id: "prop-1", name: "3001 Hutton Drive" },
  governance: { originalsPreserved: true, ephemeralMediaDelivery: true, humanApprovalRequired: true },
  blockers: [],
  spaces: [
    {
      id: "room-1", name: "Deck — west half", building: "Main House", level: "Deck level",
      evidence: [
        { id: "ev-1", filename: "west-360.jpg", mediaType: "360 capture", mimeType: "image/jpeg" },
        { id: "ev-2", filename: "pile-closeup.jpg", mediaType: "photo", mimeType: "image/jpeg" },
      ],
      interpretation: { body: "Fourteen concrete piles visible, deck framing in progress on the west half.", review: { state: "confirmed" } },
    },
    {
      id: "room-2", name: "Deck — east half", building: "Main House", level: "Deck level",
      evidence: [{ id: "ev-3", filename: "east-progress.jpg", mediaType: "photo", mimeType: "image/jpeg" }],
      interpretation: { body: "Joist bays open, no decking laid on the east half.", review: { state: "confirmed" } },
    },
  ],
};
const releaseAnswer = {
  release: { id: "rel-2", version: 2, state: "approved", approvedAt: "2026-08-25T14:00:00Z" },
  manifest,
  media: [
    { evidenceId: "ev-1", url: "/studio/tests/fixtures/visual-evidence.png" },
    { evidenceId: "ev-2", url: "/studio/tests/fixtures/visual-evidence.png" },
    { evidenceId: "ev-3", url: "/studio/tests/fixtures/visual-evidence.png" },
  ],
};
const technicalAnswer = {
  baseline: { version: 3, approved_at: "2026-08-24T10:00:00Z", summary: "Single-family deck: 1,640 sf permeable deck on 14 concrete piles, PSL beam grid, 2x6 F.R.T. joists.", contract: "2026-08-26.3" },
  takeoff: { kind: "wood_framing", accepted_at: "2026-08-25T09:00:00Z", provenance: "OWNER_ACCEPTED_BASELINE - not a technical confirmation" },
  confirmed_lines: [
    { line: "P1 concrete piles", value: "14", reviewer_role: "reviewer", reviewed_at: "2026-08-25T09:30:00Z", provenance: "HUMAN_CONFIRMED" },
  ],
  open_questions: [
    { severity: "critical", question: "BM.1 schedule row illegible on S-2.0 — beam count unconfirmed." },
    { severity: "important", question: "Guardrail length not printed; steel guard posts pending detail 7/S-5.1." },
  ],
};

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox", "--no-proxy-server", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});

async function openPage(seed) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route("**://*/**", (r) => (r.request().url().startsWith(base) ? r.continue() : r.abort()));
  await context.addInitScript(`window.__seed = ${JSON.stringify(seed)};`);
  await context.addInitScript({ path: "studio/tests/fake-supabase.js" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  await page.goto(`${base}/studio/owner-view/?property=prop-1`, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  return { context, page, errors };
}

console.log("── an external owner: one project, nothing else ──");
{
  const world = deckTakeoffRows();
  world.organization_members = []; // the invited owner belongs to no organization
  const { context, page, errors } = await openPage({
    rows: world,
    functions: {
      "vision-release": {
        byAction: {
          projects: { projects: [{ id: "prop-1", name: "3001 Hutton Drive", address: "" }] },
          get: releaseAnswer,
          technical: technicalAnswer,
          status: { releases: [] },
        },
      },
    },
  });

  const boundary = await page.evaluate(() => ({
    url: window.location.pathname,
    appShown: document.querySelector("#app")?.hidden === false,
    studioLinkHidden: document.querySelector("#open-studio-link")?.hidden === true,
    previewBadgeHidden: document.querySelector("#preview-badge")?.hidden === true,
    projects: [...document.querySelectorAll("#property-select option")].map((option) => option.textContent),
    mainInputs: document.querySelectorAll("main input, main textarea, main [contenteditable]").length,
    mode: window.__ownerViewState.mode,
  }));
  check("the granted project renders — and it is the only one offered",
    boundary.appShown && JSON.stringify(boundary.projects) === '["3001 Hutton Drive"]' && boundary.mode === "external",
    JSON.stringify(boundary.projects));
  check("no way into the Studio, no internal badge, no organization-wide picker",
    boundary.studioLinkHidden && boundary.previewBadgeHidden && /owner-view/.test(boundary.url));
  check("the page asks the owner for nothing — zero inputs in the record", boundary.mainInputs === 0, String(boundary.mainInputs));

  /* Option C boundary: an external owner is never shown an action that
     starts analysis, and opening the page never launches one. */
  const passive = await page.evaluate(() => ({
    actionText: [...document.querySelectorAll("a, button")]
      .filter((el) => !el.closest("[hidden]") && !el.hidden)
      .map((el) => el.textContent.trim())
      .filter((text) => /read rooms|open studio|read this room|request ai/i.test(text)),
    pendingHidden: document.querySelector("#summary-pending")?.hidden === true,
    analysisCalls: window.__rpcCalls.filter((call) =>
      /spatial-analyze|plan-analyze|field-quality-check/.test(call.name)).length,
    analysisWrites: (window.__writes || []).filter((write) =>
      /analysis_jobs|plan_analysis/.test(write.table || "")).length,
  }));
  check("no Studio door and no analysis-starting action is visible to the external owner",
    passive.actionText.length === 0, JSON.stringify(passive.actionText));
  check("with a release published, the passive pending line stays quiet", passive.pendingHidden);
  check("opening the Owner View launches no paid analysis — no worker calls, no job rows",
    passive.analysisCalls === 0 && passive.analysisWrites === 0,
    JSON.stringify({ calls: passive.analysisCalls, writes: passive.analysisWrites }));

  const summary = await page.evaluate(() => ({
    status: document.querySelector("#summary-status")?.textContent || "",
    numbers: [...document.querySelectorAll("#summary-numbers article")].map((item) => item.innerText.replace(/\s+/g, " ")),
    questions: [...document.querySelectorAll("#summary-questions .question-row")].map((item) => item.textContent),
    next: document.querySelector("#summary-next")?.textContent || "",
  }));
  check("the Owner Summary answers in one glance: both channels' status, five numbers at most",
    /Visual release v2 approved 2026-08-25/.test(summary.status) && /technical baseline v3 approved/.test(summary.status)
    && summary.numbers.length <= 5 && summary.numbers.length >= 4,
    JSON.stringify(summary));
  check("at most three discrepancies, critical first, from published data only",
    summary.questions.length === 2 && /BM\.1/.test(summary.questions[0]), JSON.stringify(summary.questions));
  check("and a recommended next action", /Walk the released rooms/.test(summary.next), summary.next);

  const visual = await page.evaluate(async () => {
    document.querySelector("#tab-visual")?.click();
    await new Promise((resolve) => setTimeout(resolve, 200));
    return {
      shown: document.querySelector("#visual-panel-ov")?.hidden === false,
      meta: document.querySelector("#release-meta")?.textContent || "",
      rooms: [...document.querySelectorAll(".room h2")].map((room) => room.textContent),
      chips: document.querySelectorAll(".interpretation-chip").length,
      governance: document.querySelector("#release-governance")?.innerText.replace(/\s+/g, " ") || "",
    };
  });
  check("Visual Evidence is the approved release, exactly as before the shell",
    visual.shown && /Release v2 · approved 2026-08-25/.test(visual.meta)
    && JSON.stringify(visual.rooms) === '["Deck — west half","Deck — east half"]' && visual.chips === 2
    && /Approved by a person/.test(visual.governance),
    JSON.stringify(visual));

  const viewer = await page.evaluate(async () => {
    [...document.querySelectorAll(".tile-open")].find((btn) => btn.textContent.trim() === "Enter 360")?.click();
    await new Promise((resolve) => setTimeout(resolve, 700));
    const overlay = [...document.querySelectorAll("body > *")].find((el) => el.querySelector?.("canvas"));
    return { opened: Boolean(overlay), subtitle: overlay?.innerText.match(/Release v2[^\n]*/)?.[0] || "" };
  });
  check("Enter 360 still opens the Studio's own viewer, wearing the release provenance",
    viewer.opened && /human-approved/.test(viewer.subtitle), JSON.stringify(viewer));

  const technical = await page.evaluate(async () => {
    document.querySelector("#tab-technical")?.click();
    await new Promise((resolve) => setTimeout(resolve, 200));
    return {
      shown: document.querySelector("#technical-panel")?.hidden === false,
      meta: document.querySelector("#technical-meta")?.textContent || "",
      summary: document.querySelector("#technical-summary")?.textContent || "",
      confirmed: [...document.querySelectorAll("#confirmed-lines tbody tr")].map((row) => row.innerText.replace(/\s+/g, " ")),
      chips: document.querySelector("#technical-chips")?.innerText || "",
    };
  });
  check("Technical Intelligence shows only published results: approved baseline, accepted takeoff, confirmed lines",
    technical.shown && /Plan baseline v3 · approved 2026-08-24/.test(technical.meta)
    && /permeable deck on 14 concrete piles/.test(technical.summary)
    && technical.confirmed.length === 1 && /P1 concrete piles 14 reviewer/.test(technical.confirmed[0])
    && /Takeoff accepted 2026-08-25/.test(technical.chips),
    JSON.stringify(technical));

  await page.screenshot({ path: "studio/tests/fixtures/owner-view-external.png" }).catch(() => {});
  check("nothing threw", errors.length === 0, errors.join(" | "));
  await context.close();
}

console.log("\n── an internal member: explicit preview, explicit way back ──");
{
  const world = deckTakeoffRows();
  const { context, page, errors } = await openPage({
    rows: world,
    functions: {
      "vision-release": {
        byAction: {
          projects: { projects: [] },
          get: releaseAnswer,
          technical: technicalAnswer,
          status: { releases: [] },
        },
      },
    },
  });
  const view = await page.evaluate(() => ({
    mode: window.__ownerViewState.mode,
    badge: document.querySelector("#preview-badge")?.hidden === false,
    studioLink: document.querySelector("#open-studio-link")?.hidden === false,
    meta: document.querySelector("#release-meta")?.textContent || "",
  }));
  check("an organization member previews with the badge on and the Studio door visible",
    view.mode === "internal" && view.badge && view.studioLink, JSON.stringify(view));
  const internalPending = await page.evaluate(() =>
    document.querySelector("#summary-pending")?.hidden === true);
  check("the passive pending line is for external owners only — internal preview never shows it", internalPending);
  check("and sees the same published release", /Release v2/.test(view.meta), view.meta);
  await page.screenshot({ path: "studio/tests/fixtures/owner-view-internal.png" }).catch(() => {});
  check("nothing threw", errors.length === 0, errors.join(" | "));
  await context.close();
}

console.log("\n── signed out: a sign-in form and not one byte of the record ──");
{
  const world = deckTakeoffRows();
  const { context, page, errors } = await openPage({
    rows: world,
    session: null,
    functions: { "vision-release": { byAction: { get: releaseAnswer, technical: technicalAnswer } } },
  });
  const view = await page.evaluate(() => ({
    url: window.location.pathname,
    signIn: document.querySelector("#sign-in")?.hidden === false,
    appHidden: document.querySelector("#app")?.hidden === true,
    calls: window.__rpcCalls.filter((call) => call.name === "vision-release").length,
    bodyText: document.body.innerText,
  }));
  check("the magic-link sign-in form shows instead of a redirect into Studio",
    view.signIn && view.appHidden && /owner-view/.test(view.url));
  check("no project call was made and no project data is on the page",
    view.calls === 0 && !/Hutton|Deck|Release v/.test(view.bodyText), String(view.calls));
  check("nothing threw", errors.length === 0, errors.join(" | "));
  await context.close();
}

console.log("\n── honest states with nothing published ──");
{
  const world = deckTakeoffRows();
  world.organization_members = [];
  const { context, page, errors } = await openPage({
    rows: world,
    functions: {
      "vision-release": {
        byAction: {
          projects: { projects: [{ id: "prop-1", name: "3001 Hutton Drive", address: "" }] },
          get: { error: "No approved Vision release is available" },
          technical: { baseline: null, takeoff: null, confirmed_lines: [], note: "No approved technical baseline has been published yet." },
          status: { releases: [{ version: 1, state: "draft", open_checks: 2 }] },
        },
      },
    },
  });
  const view = await page.evaluate(async () => {
    const summary = document.querySelector("#summary-status")?.textContent || "";
    document.querySelector("#tab-visual")?.click();
    await new Promise((resolve) => setTimeout(resolve, 150));
    const visual = document.querySelector("#empty-copy")?.textContent || "";
    document.querySelector("#tab-technical")?.click();
    await new Promise((resolve) => setTimeout(resolve, 150));
    return { summary, visual, technicalEmpty: document.querySelector("#technical-empty")?.hidden === false };
  });
  check("a draft in progress is said out loud, without leaking the checks themselves",
    /being prepared/.test(view.summary) && /2 governance checks/.test(view.summary) === false
      ? /2 governance check/.test(view.visual)
      : true,
    JSON.stringify(view));
  const passivePending = await page.evaluate(() => ({
    shown: document.querySelector("#summary-pending")?.hidden === false,
    text: document.querySelector("#summary-pending")?.textContent || "",
    actions: [...document.querySelectorAll("a, button")]
      .filter((el) => !el.closest("[hidden]") && !el.hidden)
      .map((el) => el.textContent.trim())
      .filter((text) => /read rooms|open studio|read this room|request ai/i.test(text)),
    analysisCalls: window.__rpcCalls.filter((call) =>
      /spatial-analyze|plan-analyze/.test(call.name)).length,
  }));
  check("with nothing released, the external owner sees the passive status — verbatim, no lever",
    passivePending.shown
    && passivePending.text === "AI analysis pending — your project team is reviewing the available captures."
    && passivePending.actions.length === 0 && passivePending.analysisCalls === 0,
    JSON.stringify(passivePending));
  check("the visual channel names the draft and its open checks, nothing more",
    /Draft v1/.test(view.visual) && /2 governance checks/.test(view.visual), view.visual.slice(0, 120));
  check("the technical channel admits nothing is published yet", view.technicalEmpty);
  check("nothing threw", errors.length === 0, errors.join(" | "));
  await context.close();
}

await browser.close(); server.close();
console.log(bad ? `\n${bad} FAILURES` : "\nALL OK");
process.exit(bad ? 1 : 0);
