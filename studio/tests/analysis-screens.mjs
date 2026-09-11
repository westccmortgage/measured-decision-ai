/* THE FIVE STEPS, IN A REAL BROWSER, PRESSED.
 *
 * The shipping page, the shipping app.js, the shipping stylesheet — served
 * from the repository and driven with a keyboard and a mouse. What is stood
 * in for is the RECORD and the DOOR, and only those: a Supabase client whose
 * queries answer from an object in the page, and a fetch that answers the
 * analysis door. Everything the person sees is drawn by the real code from
 * those answers.
 *
 * The four claims:
 *   1  signed out, the page asks you to sign in and nothing else;
 *   2  the five steps read in order, and the formats and limits are on the
 *      screen BEFORE any picker opens;
 *   3  a running analysis shows COUNTED assignments and no percentage;
 *   4  a finished one reads as three sections, one place in one of them, and
 *      a card opens on the page it came from.
 *
 * And one that is easy to lose: the whole thing works at 390px.
 */
import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";
import { serveRepository, CHROME } from "./analysis-browser.mjs";

let bad = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? `\n         ${detail}` : ""}`);
  if (!ok) bad += 1;
};
const section = (name) => console.log(`\n── ${name} ──`);
console.log("━━ the analysis path, walked");

/* A real uuid, because the page routes on one — `#/a/<36 characters>` — and a
   test id that is not one would walk past the very check that keeps somebody
   else's analysis out of this screen. */
const ANALYSIS = "11111111-1111-4111-8111-111111111111";
const ANALYSIS_PATH = `org-1/analysis/${ANALYSIS}`;
/* One transparent pixel, so the evidence panel has a real image to draw a real
   box on without this test reaching anywhere. */
const BLANK_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const site = await serveRepository();
const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox", "--no-proxy-server"] });

/* The world the page is given. Everything in it is what the record would
   hold; nothing in it is what the screen should say. */
const WORLD = {
  signedIn: false,
  organization: { organization_id: "org-1", role: "owner" },
  runs: [],
  files: [],
  parts: [],
  events: [],
  status: null,
  results: null,
  estimate: { subjects: 8, readerAttempts: 16, criticAttempts: 8, worstUsd: 1.84, pages: 3, frames: 5, files: 2,
    ceilingUsd: 25, maximumSubjects: 120, tooLarge: false,
    note: "the most this could cost, priced from the declared ceilings; unused reservations are given back" },
  evidence: null,
};

async function openPage(world) {
  const page = await browser.newPage();
  const noise = [];
  const ours = (line) => !/ERR_CERT_AUTHORITY_INVALID|fonts\.(googleapis|gstatic)|favicon/.test(line);
  page.on("pageerror", (e) => { const line = String(e?.message || e); if (ours(line)) noise.push(line); });
  page.on("console", (m) => { if (m.type() === "error" && ours(m.text())) noise.push(m.text()); });

  /* The vendor client, replaced before it loads. */
  await page.route("**/vendor/supabase-js-*.min.js", (route) => route.fulfil
    ? route.fulfil({ body: STUB, contentType: "text/javascript" })
    : route.fulfill({ body: STUB, contentType: "text/javascript" }));
  /* The door. Answered from the world held HERE, in node: asking the page for
     it inside a route handler deadlocks, because the page is waiting on the
     route. */
  await page.route("**/functions/v1/core-v2-analysis", (route) => {
    const body = JSON.parse(route.request().postData() || "{}");
    const answer = { estimate: world.estimate, status: world.status, results: world.results, evidence: world.evidence }[body.op] ?? {};
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(answer) });
  });
  /* The web font, which this machine reaches through a proxy it does not
     trust. It is decoration; the page is what is under test. */
  await page.route("https://fonts.googleapis.com/**", (route) => route.fulfill({ status: 200, contentType: "text/css", body: "" }));
  await page.addInitScript((w) => { window.MDAI_WORLD = w; }, world);
  await page.goto(`${site.base}/studio/analysis/index.html`, { waitUntil: "networkidle" });
  return { page, noise };
}

/* A Supabase client that answers from window.MDAI_WORLD. Small on purpose:
   the point is to exercise the page, not to reimplement PostgREST. */
const STUB = `
window.supabase = {
  createClient() {
    const W = () => window.MDAI_WORLD;
    const rowsFor = (table) => ({
      organization_members: W().signedIn ? [W().organization] : [],
      analysis_runs: W().runs, analysis_files: W().files,
      analysis_parts: W().parts, analysis_events: W().events,
    }[table] || []);
    const query = (table) => {
      const q = {
        rows: rowsFor(table),
        select() { return q; }, eq() { return q; }, order() { return q; }, limit() { return q; },
        insert(row) { q.inserted = row; return q; }, update() { return q; }, delete() { return q; },
        maybeSingle() { return Promise.resolve({ data: q.rows[0] ?? null, error: null }); },
        single() { return Promise.resolve({ data: q.inserted ? { id: "new-analysis", ...q.inserted } : q.rows[0], error: null }); },
        then(resolve) { return Promise.resolve({ data: q.rows, error: null }).then(resolve); },
      };
      return q;
    };
    return {
      auth: {
        getSession: () => Promise.resolve({ data: { session: W().signedIn
          ? { access_token: "a-token", user: { id: "user-1", email: "owner@example.com" } } : null } }),
        onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
        signInWithPassword: () => Promise.resolve({ error: null }),
        signInWithOtp: () => Promise.resolve({ error: null }),
        signInWithOAuth: () => Promise.resolve({ error: null }),
        signOut: () => Promise.resolve({}),
      },
      from: query,
      storage: { from: () => ({ createSignedUrl: () => Promise.resolve({ data: { signedUrl: "about:blank" }, error: null }) }) },
    };
  },
};
`;

try {
  /* ─────────────────────────────────────────────── signed out */
  section("signed out");
  {
    const { page, noise } = await openPage({ ...WORLD, signedIn: false });
    const text = await page.textContent("#screen");
    check("the page asks you to sign in", /Sign in to run an analysis/.test(text), text.slice(0, 80));
    check("and offers the same three ways in as the Studio",
      await page.isVisible("#google") && await page.isVisible("#password-in") && await page.isVisible("#link-in"));
    check("nothing about somebody else's analysis is on the screen", !/Create an analysis/.test(text));
    check("no errors", noise.length === 0, noise.slice(0, 2).join(" | "));
    await page.close();
  }

  /* ─────────────────────────────────────────────── step one */
  section("step one: create an analysis");
  {
    const { page, noise } = await openPage({ ...WORLD, signedIn: true });
    const text = await page.textContent("#screen");
    check("the first step is creating one", /Create an analysis/.test(text));
    const choices = await page.$$eval(".choice strong", (n) => n.map((x) => x.textContent));
    check("and the three questions are the three the product answers", choices.length === 3,
      choices.join(" · "));
    check("the owner's own words are asked for, and said to go to every reader",
      /given to every reader word for word/.test(text));
    check("no errors", noise.length === 0, noise.slice(0, 2).join(" | "));
    await page.close();
  }

  /* ────────────────────────────────── steps two and three */
  section("steps two and three: files, and the material made from them");
  {
    const run = { id: ANALYSIS, organization_id: "org-1", title: "Riverside level 2", question_kind: "video_against_plans",
      question: "Is a smoke detector shown in every bedroom?", state: "ready", workflow_id: null,
      estimate: {}, authorized_usd: null, run_requested_at: null, last_error: null, created_at: new Date(0).toISOString() };
    const files = [
      { id: "f-1", ordinal: 1, kind: "pdf", file_name: "plan-set.pdf", media_type: "application/pdf",
        byte_size: 3040, storage_path: "${ANALYSIS_PATH}/1-source.pdf", content_fingerprint: "abc-3040",
        upload_state: "stored", probe: { pages: 3 }, preparation_state: "prepared",
        prepared_units: 3, total_units: 3, last_error: null },
      { id: "f-2", ordinal: 2, kind: "video", file_name: "walkthrough.webm", media_type: "video/webm",
        byte_size: 84611, storage_path: "${ANALYSIS_PATH}/2-source.webm", content_fingerprint: "def-84611",
        upload_state: "stored", probe: { durationSeconds: 8, width: 640, height: 360,
          momentsRead: [{ ordinal: 1, seconds: 0 }, { ordinal: 2, seconds: 2 }, { ordinal: 3, seconds: 4 },
                        { ordinal: 4, seconds: 6 }, { ordinal: 5, seconds: 7.95 }] },
        preparation_state: "prepared", prepared_units: 5, total_units: 5, last_error: null },
    ];
    const status = { analysisId: ANALYSIS, stage: "ready", state: "ready", assignments: { finished: 0, total: 0, running: 0, waiting: 0 },
      materialPrepared: { pdf_page_image: 3, video_frame: 5 }, files: [], attempts: {}, budget: null, continuation: null };
    const { page, noise } = await openPage({ ...WORLD, signedIn: true, runs: [run], files, status });
    await page.goto(`${site.base}/studio/analysis/index.html#/a/${ANALYSIS}`, { waitUntil: "networkidle" });
    await page.waitForSelector("#prepare-step");
    const text = await page.textContent("#screen");

    check("what is accepted is on the screen before any picker opens",
      /PDF plan set/.test(text) && /Ordinary video/.test(text) && /equirectangular/.test(text));
    check("and so are the real limits", /200 MB/.test(text) && /2.0 GB/.test(text) && /120 pages/.test(text),
      (text.match(/up to [^·]{0,20}/g) || []).slice(0, 3).join(" | "));
    check("an upload is said to survive the tab closing", /closing this tab does not lose an upload/.test(text));
    check("the video says how many moments were read and what that does not prove",
      /5 moments of this 0:08 clip were read/.test(text) && /cannot say that something is absent/.test(text));
    check("the PDF says every page was read", /3 pages, every one of them read/.test(text));
    check("preparation says plainly that it needs this tab, and the analysis does not",
      /needs no tab open/.test(text));
    check("no errors", noise.length === 0, noise.slice(0, 2).join(" | "));
    await page.close();
  }

  /* ─────────────────────────────────────────────── step four */
  section("step four: the press, and what it says about money");
  {
    const run = { id: ANALYSIS, organization_id: "org-1", title: "Riverside level 2", question_kind: "plan_consistency",
      question: "", state: "ready", workflow_id: null, estimate: {}, authorized_usd: null,
      run_requested_at: null, last_error: null, created_at: new Date(0).toISOString() };
    const files = [{ id: "f-1", ordinal: 1, kind: "pdf", file_name: "plan-set.pdf", media_type: "application/pdf",
      byte_size: 3040, storage_path: "p", content_fingerprint: "abc", upload_state: "stored", probe: { pages: 3 },
      preparation_state: "prepared", prepared_units: 3, total_units: 3, last_error: null }];
    const status = { stage: "ready", state: "ready", assignments: { finished: 0, total: 0, running: 0, waiting: 0 },
      materialPrepared: { pdf_page_image: 3 }, files: [], attempts: {}, budget: null, continuation: null };
    const { page, noise } = await openPage({ ...WORLD, signedIn: true, runs: [run], files, status });
    await page.goto(`${site.base}/studio/analysis/index.html#/a/${ANALYSIS}`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => !/Working out what this could cost/.test(document.body.textContent));
    const text = (await page.textContent("#screen")).replace(/\s+/g, " ");
    check("the most it could cost is shown before anything is authorised", /At most \$1\.84/.test(text));
    check("and it is called the most, not a guess at the bill",
      /the most this could cost/.test(text) && /unused reservations are given back/.test(text));
    check("the ceiling on one analysis is on the screen", /at most \$25/.test(text));
    check("the press is the only thing that starts a real call",
      /Real AI calls start on the server after this press, never before it, and never from this browser/.test(text));
    check("the amount is a field the person fills in", await page.isVisible("#authorized"));
    check("no errors", noise.length === 0, noise.slice(0, 2).join(" | "));
    await page.close();
  }

  /* ─────────────────────────────────────────────── running */
  section("while it runs: counted, never a percentage");
  {
    const run = { id: ANALYSIS, organization_id: "org-1", title: "Riverside level 2", question_kind: "plan_consistency",
      question: "", state: "running", workflow_id: "w-1", estimate: {}, authorized_usd: 5,
      run_requested_at: new Date(0).toISOString(), last_error: null, created_at: new Date(0).toISOString() };
    const status = { stage: "reading", state: "running", workflowState: "running", cancelRequested: false,
      assignments: { finished: 11, total: 24, running: 4, waiting: 9 },
      materialPrepared: { pdf_page_image: 3, video_frame: 5 }, files: [], attempts: { succeeded: 11 },
      budget: { authorized_maximum: 5, reserved: 0.42, settled: 0.31, stopped_reason: null },
      continuation: { state: "held" }, problem: null };
    const { page, noise } = await openPage({ ...WORLD, signedIn: true, runs: [run], status,
      results: { started: true, sections: { confirmed: [], discrepancy: [], needsCheck: [] }, counts: {} } });
    await page.goto(`${site.base}/studio/analysis/index.html#/a/${ANALYSIS}`, { waitUntil: "networkidle" });
    await page.waitForSelector("#stop");
    const text = (await page.textContent("#screen")).replace(/\s+/g, " ");
    check("the count of finished assignments is shown as a count", /11 \/ 24/.test(text), text.slice(0, 0));
    check("and no percentage of anything is anywhere on the screen", !/%/.test(text),
      (text.match(/\S*%\S*/g) || []).slice(0, 3).join(" "));
    check("it says the work is on the server and this page is not holding it up",
      /Closing this page does not stop anything/.test(text));
    check("there is a stop", await page.isVisible("#stop"));
    check("what has been reserved and settled against the authority is shown",
      /\$0\.4200/.test(text) && /\$0\.3100/.test(text) && /\$5\.00 authorised/.test(text));
    check("no errors", noise.length === 0, noise.slice(0, 2).join(" | "));
    await page.close();
  }

  /* ─────────────────────────────────────────────── the result */
  section("the result: three sections, and a card that opens on its page");
  {
    const run = { id: ANALYSIS, organization_id: "org-1", title: "Riverside level 2", question_kind: "plan_consistency",
      question: "", state: "finished", workflow_id: "w-1", estimate: {}, authorized_usd: 5,
      run_requested_at: new Date(0).toISOString(), last_error: null, created_at: new Date(0).toISOString() };
    const files = [
      { id: "f-1", ordinal: 1, kind: "pdf", file_name: "plan-set.pdf", media_type: "application/pdf",
        byte_size: 3040, storage_path: "p", content_fingerprint: "abc", upload_state: "stored", probe: { pages: 3 },
        preparation_state: "prepared", prepared_units: 3, total_units: 3, last_error: null, parts: [] },
      { id: "f-2", ordinal: 2, kind: "video", file_name: "walkthrough.webm", media_type: "video/webm",
        byte_size: 84611, storage_path: "v", content_fingerprint: "def", upload_state: "stored",
        probe: { durationSeconds: 8 }, preparation_state: "prepared", prepared_units: 5, total_units: 5,
        last_error: null, parts: [] },
    ];
    const parts = [
      { id: "p-3", file_id: "f-2", part_kind: "video_frame", ordinal: 3, storage_path: "f3",
        media_type: "image/png", byte_size: 22768, content_sha256: "hash-frame-3",
        locator: { bbox: [0, 0, 1, 1], start_ms: 4000, end_ms: 4000, seconds: 4 } },
    ];
    const reading = (domain, answer, quote) => ({
      claimId: `c-${domain}-${answer}`, predicate: "finding", value: { known: true, text: answer },
      status: "corroborated", independenceDomain: domain, role: "page_reader", roleVersion: "1.0",
      executor: domain === "family-one" ? "reader-family-one" : "reader-family-two",
      model: domain === "family-one" ? "a-model" : "another-model",
      anchors: [{ quotedText: quote, locator: { bbox: [0.1, 0.2, 0.6, 0.4] }, contentHash: "hash-page-1", segmentKind: "page", label: "plan-set.pdf · page 1" }],
    });
    const confirmed = { subjectType: "page", subjectKey: "page/1/1", section: "confirmed",
      readings: [reading("family-one", "yes", "SMOKE DETECTOR: BEDROOM 1"), reading("family-two", "yes", "SMOKE DETECTOR: BEDROOM 2")],
      reviews: [{ verdict: "supports", reasonCode: "matches_source", explanation: "the material shows this at this place", role: "evidence_critic", executor: "critic-family-one" }],
      decisions: [], taskStates: ["completed", "completed"], problems: [] };
    const discrepancy = { subjectType: "page", subjectKey: "page/1/3", section: "discrepancy",
      readings: [reading("family-one", "yes", "CEILING HEIGHT 2700"), reading("family-two", "no", "CEILING HEIGHT 2400")],
      reviews: [], decisions: [], taskStates: ["completed", "completed"], problems: [] };
    const needs = { subjectType: "moment", subjectKey: "moment/2/3", section: "needsCheck",
      readings: [reading("family-one", "unclear", "640×360 picture, 98.5% of it darker than paper")],
      reviews: [], decisions: [], taskStates: ["completed"], problems: [] };
    const results = { started: true, workflowId: "w-1",
      subjects: [confirmed, discrepancy, needs],
      sections: { confirmed: [confirmed], discrepancy: [discrepancy], needsCheck: [needs] },
      counts: { confirmed: 1, discrepancy: 1, needsCheck: 1 } };
    const status = { stage: "finished", state: "finished", workflowState: "completed",
      assignments: { finished: 24, total: 24, running: 0, waiting: 0 },
      materialPrepared: { pdf_page_image: 3 }, files: [], attempts: {}, budget: null, continuation: null };
    const evidence = { partKind: "pdf_page_image", fileName: "plan-set.pdf", fileKind: "pdf", fileOrdinal: 1,
      ordinal: 1, mediaType: "image/png", locator: { bbox: [0, 0, 1, 1], page: 1, pointWidth: 792, pointHeight: 612 },
      where: "plan-set.pdf, page 1", text: null, url: BLANK_PNG, urlExpiresInSeconds: 900 };

    const { page, noise } = await openPage({ ...WORLD, signedIn: true, runs: [run], files, parts, status, results, evidence });
    await page.goto(`${site.base}/studio/analysis/index.html#/a/${ANALYSIS}`, { waitUntil: "networkidle" });
    await page.waitForSelector(".section[data-kind=confirmed] .finding");
    const text = (await page.textContent("#screen")).replace(/\s+/g, " ");

    check("the three sections are there, named in the owner's words",
      /Confirmed/.test(text) && /Discrepancy found/.test(text) && /Needs a check/.test(text));
    check("each says what putting something in it means",
      /Two independent readers said the same thing/.test(text)
      && /Two readers differ, or a reviewer went back to the source/.test(text)
      && /Not decided/.test(text), text.slice(0, 0));
    check("a place appears once, in one section", (text.match(/page 1/g) || []).length >= 1
      && await page.$$eval(".section .finding", (n) => n.length) === 3);

    const headings = await page.$$eval(".finding .where", (n) => n.map((x) => x.textContent));
    check("a card is titled by the place in the owner's own file, not by an id",
      headings.some((h) => /plan-set\.pdf, page 1/.test(h))
      && headings.some((h) => /page 3/.test(h))
      && headings.some((h) => /walkthrough\.webm at 0:04/.test(h)),
      headings.join(" · "));
    check("technical ids are not in the heading", headings.every((h) => !/[0-9a-f]{8}-/.test(h)));

    /* Open the confirmed card and read what is inside it. */
    await page.click(".section[data-kind=confirmed] .finding summary");
    const inside = await page.textContent(".section[data-kind=confirmed] .finding .inside");
    check("each reader's own answer is inside the card, separately",
      /reader-family-one/.test(inside) && /reader-family-two/.test(inside));
    check("and each quotes what it read, verbatim",
      /SMOKE DETECTOR: BEDROOM 1/.test(inside) && /SMOKE DETECTOR: BEDROOM 2/.test(inside));
    check("the check against the source is shown too", /supports/.test(inside) && /matches_source/.test(inside));
    check("ids and hashes are in the details, not on the face of it",
      /claim c-family-one-yes/.test(await page.textContent(".section[data-kind=confirmed] .finding details.details")));

    /* And the discrepancy shows both sides. */
    await page.click(".section[data-kind=discrepancy] .finding summary");
    const both = await page.textContent(".section[data-kind=discrepancy] .finding .inside");
    check("a discrepancy shows both sides, with both quotes",
      /CEILING HEIGHT 2700/.test(both) && /CEILING HEIGHT 2400/.test(both));

    /* The evidence. */
    await page.click(".section[data-kind=confirmed] .finding [data-evidence]");
    await page.waitForSelector(".evidence-panel");
    const panel = await page.textContent(".evidence-panel");
    check("the evidence opens on the page it came from", /plan-set\.pdf, page 1/.test(panel), panel.slice(0, 60));
    check("and says it is the material the reader was given, not a re-render",
      /the exact material the reader was given/.test(panel));
    check("the region the reading named is drawn on it",
      await page.isVisible(".evidence-box"));
    await page.keyboard.press("Escape");
    check("Escape closes it", (await page.$(".evidence-panel")) === null);

    check("no errors", noise.length === 0, noise.slice(0, 2).join(" | "));

    /* And a phone. */
    await page.setViewportSize({ width: 390, height: 780 });
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check("at 390px the page does not scroll sideways", overflow <= 1, `${overflow}px over`);
    await page.close();
  }
} finally {
  await browser.close();
  await site.close();
}

console.log("");
if (bad) { console.log(`  ${bad} FAILURE${bad === 1 ? "" : "S"}`); process.exit(1); }
console.log("  ALL OK");
