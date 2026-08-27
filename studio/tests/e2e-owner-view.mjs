/* The Owner View: only what a person approved, and nothing to type.
 *
 * The release is the publication boundary. What this test guards:
 *   - an approved release renders — rooms, confirmed interpretations with
 *     their reviewer chip, evidence media through signed URLs, and the
 *     governance promises printed from the manifest itself;
 *   - a 360 capture opens in the Studio's own viewer, not a new one;
 *   - the page holds zero inputs — the owner watches, nobody types;
 *   - no approved release is a state, not a dead end: a draft with open
 *     governance checks says it is being prepared and why, and an empty
 *     project says what has to happen, with the way onward.
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
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".jpg": "image/jpeg" };
const server = http.createServer((req, res) => {
  let f = path.join(ROOT, decodeURIComponent(req.url.split("?")[0]));
  if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, "index.html");
  if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(f)] || "application/octet-stream" });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

const world = deckTakeoffRows();
const manifest = {
  schema: "com.measureddecision.vision-release/1.0",
  property: { id: "prop-1", name: "3001 Hutton Drive" },
  governance: { originalsPreserved: true, ephemeralMediaDelivery: true, humanApprovalRequired: true },
  blockers: [],
  spaces: [
    {
      id: "room-1", name: "Deck — west half", building: "Main House", level: "Deck level", reviewState: "confirmed",
      evidence: [
        { id: "ev-1", filename: "west-360.jpg", mediaType: "360 capture", mimeType: "image/jpeg" },
        { id: "ev-2", filename: "pile-closeup.jpg", mediaType: "photo", mimeType: "image/jpeg" },
      ],
      interpretation: { suggestionId: "sug-1", body: "Fourteen concrete piles visible, deck framing in progress on the west half.", review: { state: "confirmed" } },
    },
    {
      id: "room-2", name: "Deck — east half", building: "Main House", level: "Deck level", reviewState: "confirmed",
      evidence: [{ id: "ev-3", filename: "east-progress.jpg", mediaType: "photo", mimeType: "image/jpeg" }],
      interpretation: { suggestionId: "sug-2", body: "Joist bays open, no decking laid on the east half.", review: { state: "confirmed" } },
    },
  ],
};
const approvedAnswers = {
  "vision-release": {
    byAction: {
      get: {
        release: { id: "rel-2", version: 2, state: "approved", approvedAt: "2026-08-25T14:00:00Z" },
        manifest,
        media: [
          { evidenceId: "ev-1", url: "/studio/tests/fixtures/visual-evidence.png" },
          { evidenceId: "ev-2", url: "/studio/tests/fixtures/visual-evidence.png" },
          { evidenceId: "ev-3", url: "/studio/tests/fixtures/visual-evidence.png" },
        ],
      },
      status: { releases: [{ id: "rel-2", version: 2, state: "approved", manifest }] },
    },
  },
};

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox", "--no-proxy-server", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});

console.log("── an approved release, rendered ──");
{
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route("**://*/**", (r) => (r.request().url().startsWith(base) ? r.continue() : r.abort()));
  await context.addInitScript(`window.__seed = ${JSON.stringify({ rows: world, functions: approvedAnswers })};`);
  await context.addInitScript({ path: "studio/tests/fake-supabase.js" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  await page.goto(`${base}/studio/owner-view/?property=prop-1`, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);

  const view = await page.evaluate(() => ({
    title: document.querySelector("#release-title")?.textContent || "",
    meta: document.querySelector("#release-meta")?.textContent || "",
    governance: document.querySelector("#release-governance")?.innerText.replace(/\s+/g, " ") || "",
    rooms: [...document.querySelectorAll(".room")].map((room) => room.querySelector("h2")?.textContent),
    chips: document.querySelectorAll(".interpretation-chip").length,
    interpretation: document.querySelector(".interpretation")?.textContent || "",
    images: [...document.querySelectorAll(".evidence-tile img")].map((img) => img.getAttribute("src")),
    enter360: [...document.querySelectorAll(".tile-open")].map((btn) => btn.textContent.trim()),
    inputs: document.querySelectorAll("main input, main textarea, main [contenteditable]").length,
  }));
  check("the release header names the project, version and approval date",
    view.title === "3001 Hutton Drive" && /v2/.test(view.meta) && /approved 2026-08-25/.test(view.meta) && /2 rooms released/.test(view.meta),
    view.meta);
  check("the governance promises are printed from the manifest itself",
    /Approved by a person/.test(view.governance) && /Originals never altered/.test(view.governance) && /Media links expire/.test(view.governance),
    view.governance);
  check("both released rooms render with their confirmed interpretations",
    JSON.stringify(view.rooms) === '["Deck — west half","Deck — east half"]'
    && view.chips === 2 && /Fourteen concrete piles/.test(view.interpretation),
    JSON.stringify(view.rooms));
  check("evidence renders through the release's signed URLs",
    view.images.length === 2 && view.images.every((src) => /visual-evidence\.png/.test(src)),
    JSON.stringify(view.images));
  check("a 360 capture offers Enter 360; flat media offers Open",
    view.enter360.includes("Enter 360") && view.enter360.includes("Open"),
    JSON.stringify(view.enter360));
  check("the page asks the owner for nothing — zero inputs", view.inputs === 0, String(view.inputs));

  const viewer = await page.evaluate(async () => {
    [...document.querySelectorAll(".tile-open")].find((btn) => btn.textContent.trim() === "Enter 360")?.click();
    await new Promise((resolve) => setTimeout(resolve, 700));
    const overlay = [...document.querySelectorAll("body > *")].find((el) => el.querySelector?.("canvas"));
    return { opened: Boolean(overlay), subtitle: overlay?.innerText.match(/Release v2[^\n]*/)?.[0] || "" };
  });
  check("Enter 360 opens the Studio's own viewer, wearing the release provenance",
    viewer.opened && /human-approved/.test(viewer.subtitle), JSON.stringify(viewer));

  const shot = await page.$("main");
  if (shot) await shot.screenshot({ path: "studio/tests/fixtures/owner-view.png" }).catch(() => {});
  check("nothing threw", errors.length === 0, errors.join(" | "));
  await context.close();
}

console.log("\n── no approved release is a state, not a dead end ──");
{
  const draftAnswers = {
    "vision-release": {
      byAction: {
        get: { error: "No approved Vision release is available" },
        status: { releases: [{ id: "rel-1", version: 1, state: "draft", manifest: { blockers: ["space_review_required:room-1", "interpretation_review_required:room-1"] } }] },
      },
    },
  };
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route("**://*/**", (r) => (r.request().url().startsWith(base) ? r.continue() : r.abort()));
  await context.addInitScript(`window.__seed = ${JSON.stringify({ rows: world, functions: draftAnswers })};`);
  await context.addInitScript({ path: "studio/tests/fake-supabase.js" });
  const page = await context.newPage();
  await page.goto(`${base}/studio/owner-view/?property=prop-1`, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  const empty = await page.evaluate(() => ({
    title: document.querySelector("#empty-title")?.textContent || "",
    copy: document.querySelector("#empty-copy")?.textContent || "",
    onward: Boolean(document.querySelector("#empty-action")),
    rooms: document.querySelectorAll(".room").length,
  }));
  check("a draft with open checks says the release is being prepared, honestly",
    /being prepared/.test(empty.title) && /2 governance checks/.test(empty.copy) && /reviewer approves/.test(empty.copy),
    empty.copy.slice(0, 120));
  check("nothing unapproved leaks onto the page, and the way onward is offered",
    empty.rooms === 0 && empty.onward);
  await context.close();
}

await browser.close(); server.close();
console.log(bad ? `\n${bad} FAILURES` : "\nALL OK");
process.exit(bad ? 1 : 0);
