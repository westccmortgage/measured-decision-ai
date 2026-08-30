/* The register of what the reader could not read.
 *
 * Every reading admits its own failures; until the register they were
 * per-run and nobody could see a pattern. What this guards on screen:
 *   - the open list leads with what blocks activation, and says how many
 *     readings raised each thing;
 *   - a gap a later reading stopped raising is shown as exactly that and
 *     never as answered — silence is not an answer;
 *   - an answer that a later reading raised again shows BOTH halves;
 *   - every gap, open or not, has a door: a person can answer it or
 *     withdraw it, and both need a sentence.
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

const register = {
  property_id: "prop-1",
  open: [
    {
      id: "gap-2", kind: "no_count", question: "No count could be read for PF-1 (undermount lavatory)",
      component_key: "PF-1", severity: "important", blocks_activation: false,
      source_refs: ["P-1.0"], readings_seen: 2,
      first_seen_at: "2026-07-10T10:00:00Z", last_seen_at: "2026-08-20T10:00:00Z",
      answer: null, answered_at: null,
    },
    {
      id: "gap-1", kind: "unanswered_question", question: "Which schedule governs the door counts?",
      component_key: null, severity: "critical", blocks_activation: true,
      source_refs: ["A-2.1", "A-6.0"], readings_seen: 3,
      first_seen_at: "2026-06-02T10:00:00Z", last_seen_at: "2026-08-20T10:00:00Z",
      answer: "A-6.0 governs; the floor-plan tags repeat it.", answered_at: "2026-07-01T10:00:00Z",
    },
    {
      id: "gap-3", kind: "weak_count", question: "The count for MW-3 came back at low confidence",
      component_key: "MW-3", severity: "informational", blocks_activation: false,
      source_refs: ["A-8.2"], readings_seen: 1,
      first_seen_at: "2026-08-20T10:00:00Z", last_seen_at: "2026-08-20T10:00:00Z",
      answer: null, answered_at: null,
    },
  ],
  answered: [{
    id: "gap-4", kind: "unanswered_question", question: "Is the deck framing revised after RFI 12?",
    component_key: null, readings_seen: 2, answer: "RFI 12 closed with no drawing change.",
    answered_by: "user-1", answered_at: "2026-08-01T10:00:00Z",
  }],
  not_raised_again: [{
    id: "gap-5", kind: "no_count", question: "No count could be read for BM.1 (PSL 7x14)",
    component_key: "BM.1", readings_seen: 1,
    first_seen_at: "2026-06-02T10:00:00Z", last_seen_at: "2026-06-02T10:00:00Z",
  }],
  withdrawn: [],
  summary: {
    open: 3, blocking: 1, recurring: 2, answered_by_a_person: 1,
    not_raised_again: 1, withdrawn: 0, oldest_open_days: 89, readings: 4,
  },
  doctrine: "A gap the newest reading stopped raising is recorded as not_raised_again, never as answered: "
    + "a reader falling silent is not an answer. Only a person answers, and their name is on the row.",
};

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox", "--no-proxy-server", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});

console.log("── where the reader could not read ──");
{
  const world = deckTakeoffRows();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route("**://*/**", (r) => (r.request().url().startsWith(base) ? r.continue() : r.abort()));
  const weakSpots = {
    organization_id: "org-1",
    by_kind: [
      { kind: "no_count", gaps: 7, open_now: 4, answered_by_a_person: 2, projects: 2 },
      { kind: "unanswered_question", gaps: 3, open_now: 1, answered_by_a_person: 1, projects: 1 },
    ],
    recurring: [{ gap_key: "which schedule governs the door counts", kind: "unanswered_question", question: "Which schedule governs the door counts?", projects: 2, readings: 5, still_open: 1 }],
    by_sheet: [{ sheet: "A-6.0", gaps: 4, projects: 2 }, { sheet: "P-1.0", gaps: 1, projects: 1 }],
    doctrine: "Counts of where the plan reader could not read. It is a map of this system's own weak spots, not a judgement of any drawing set and not a measure of the work on site.",
  };
  await context.addInitScript(`window.__seed = ${JSON.stringify({ rows: world, rpc: { plan_reading_register: register, plan_reading_weak_spots: weakSpots } })};`);
  await context.addInitScript({ path: "studio/tests/fake-supabase.js" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  await page.goto(`${base}/studio/plans/?property=prop-1`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  /* The register lives in the technical view, one click below the summary. */
  await page.evaluate(() => document.querySelector("#summary-full")?.click());
  await page.waitForTimeout(400);

  const shown = await page.evaluate(() => ({
    opened: (document.querySelector(".register-history").open = true),
    visible: document.querySelector("#register-section")?.hidden === false
      && getComputedStyle(document.querySelector("#register-section")).display !== "none",
    state: document.querySelector("#register-state")?.textContent || "",
    metrics: [...document.querySelectorAll("#register-metrics article")].map((card) => card.innerText.replace(/\s+/g, " ").trim()),
    rows: [...document.querySelectorAll("#register-list .register-row")].map((row) => row.innerText.replace(/\s+/g, " ").trim()),
    history: [...document.querySelectorAll("#register-history .register-history-row")].map((row) => row.innerText.replace(/\s+/g, " ").trim()),
    historyDoors: document.querySelectorAll("#register-history [data-gap]").length,
    doctrine: document.querySelector("#register-doctrine")?.textContent || "",
    weakSpots: document.querySelector("#register-weak-spots")?.textContent || "",
  }));

  check("the register is on the screen with the readings behind it",
    shown.visible && /3 open/.test(shown.state) && /4 readings/.test(shown.state), JSON.stringify(shown.state));
  check("what blocks activation is read first",
    /Which schedule governs the door counts/.test(shown.rows[0] || "")
    && /blocks activation/i.test(shown.rows[0] || ""), JSON.stringify(shown.rows[0] || ""));
  check("a recurring gap says how many readings raised it, and on which sheets",
    /raised by 3 readings/i.test(shown.rows[0] || "") && /A-2.1 · A-6.0/.test(shown.rows[0] || ""),
    JSON.stringify(shown.rows[0] || ""));
  /* The half a marketing screen would drop: the answer is there AND the
     reader raised it again anyway. */
  check("an answer a later reading raised again shows both halves",
    /A person answered on Jul 1, 2026/.test(shown.rows[0] || "")
    && /raised it again/.test(shown.rows[0] || ""), JSON.stringify(shown.rows[0] || ""));
  check("a count nobody could make and a count nobody would stand behind stay different things",
    /no count/i.test(shown.rows[1] || "") && /PF-1/.test(shown.rows[1] || "")
    && /weak count/i.test(shown.rows[2] || "") && /MW-3/.test(shown.rows[2] || ""),
    JSON.stringify(shown.rows.slice(1)));
  check("the numbers say what is open, what recurs, and what a person answered",
    shown.metrics.some((card) => /^open 3/i.test(card) && /1 blocks activation/i.test(card))
    && shown.metrics.some((card) => /^recurring 2/i.test(card))
    && shown.metrics.some((card) => /answered by a person 1/i.test(card))
    && shown.metrics.some((card) => /no longer raised 1/i.test(card) && /silence, not an answer/i.test(card)),
    JSON.stringify(shown.metrics));
  check("a gap the newest reading dropped is shown as dropped, never as answered",
    shown.history.some((row) => /BM\.1/.test(row) && /newest reading did not raise it/i.test(row) && !/answered/i.test(row)),
    JSON.stringify(shown.history));
  check("and every gap in the history still has a door",
    shown.historyDoors === shown.history.length && shown.historyDoors === 2,
    JSON.stringify({ doors: shown.historyDoors, rows: shown.history.length }));
  /* The same failure on two projects is the reader's weakness, not the
     project's, and the line under the list says so. */
  check("the map across projects names the reader's own weak spot",
    /7 × No count on 2 projects/.test(shown.weakSpots) && /A-6\.0 \(4\)/.test(shown.weakSpots),
    shown.weakSpots);
  check("the doctrine is printed where the person reads the list",
    /falling silent is not an answer/.test(shown.doctrine), shown.doctrine);

  // A person answers. Nothing else can.
  const answering = await page.evaluate(async () => {
    document.querySelector('#register-list [data-gap="gap-2"]').click();
    const openBefore = document.querySelector("#gap-dialog").open;
    const disabledBefore = document.querySelector("#answer-gap").disabled;
    const field = document.querySelector("#gap-answer");
    field.value = "The plumbing schedule prints no quantity; the count comes from the fixture plan.";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    const disabledAfter = document.querySelector("#answer-gap").disabled;
    document.querySelector("#answer-gap").click();
    await new Promise((r) => setTimeout(r, 400));
    return {
      openBefore, disabledBefore, disabledAfter,
      question: document.querySelector("#gap-dialog-question")?.textContent || "",
      history: document.querySelector("#gap-dialog-history")?.textContent || "",
      calls: window.__rpcCalls.filter((call) => call.name === "answer_plan_reading_gap"),
    };
  });
  check("pressing a gap opens the door with its history attached",
    answering.openBefore && /PF-1/.test(answering.question)
    && /raised by 2 readings/.test(answering.history), JSON.stringify(answering.history));
  check("an empty answer cannot be recorded, a written one can",
    answering.disabledBefore === true && answering.disabledAfter === false);
  check("the answer goes to the record as a person's answer",
    answering.calls.length === 1
    && answering.calls[0].args.p_verdict === "answered"
    && answering.calls[0].args.p_gap_id === "gap-2"
    && /plumbing schedule prints no quantity/.test(answering.calls[0].args.p_answer),
    JSON.stringify(answering.calls));

  const withdrawing = await page.evaluate(async () => {
    document.querySelector('#register-list [data-gap="gap-3"]').click();
    const field = document.querySelector("#gap-answer");
    const blankWithdraw = document.querySelector("#withdraw-gap").disabled;
    field.value = "MW-3 was removed from the scope in the August revision.";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    document.querySelector("#withdraw-gap").click();
    await new Promise((r) => setTimeout(r, 400));
    return {
      blankWithdraw,
      calls: window.__rpcCalls.filter((call) => call.name === "answer_plan_reading_gap"),
    };
  });
  check("a withdrawal needs its sentence too",
    withdrawing.blankWithdraw === true);
  check("and is recorded as a person's withdrawal, not as an answer",
    withdrawing.calls.length === 2
    && withdrawing.calls[1].args.p_verdict === "withdrawn"
    && /removed from the scope/.test(withdrawing.calls[1].args.p_answer),
    JSON.stringify(withdrawing.calls[1] || {}));

  check("and the page threw nothing", errors.length === 0, errors.join(" | "));
  await context.close();
}

await browser.close();
server.close();
console.log(bad ? `\n${bad} FINDING${bad === 1 ? "" : "S"}` : "\nALL OK");
process.exit(bad ? 1 : 0);
