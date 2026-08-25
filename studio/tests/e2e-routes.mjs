/* How the rooms connect, on the screen where a person confirms it.
 *
 * A plan set says which rooms open into which. That is what turns a list of
 * rooms into a building somebody can walk through — in the browser now, in a
 * headset next. It is also, until somebody confirms it, a reading of a drawing,
 * and there is one way this feature goes wrong that nobody would notice until
 * they were wearing the headset: a route shown as a route rather than as a
 * suggestion.
 *
 * The other failure worth guarding is the tidy one. Every real plan set names a
 * space the record has no room for — an attic, a crawl space, a mechanical
 * closet. Dropping that route would leave a clean list saying, in effect, that
 * there is no door there. There is a door there. The record just has nowhere to
 * put what is behind it, and it has to say so.
 */
import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";
import http from "http"; import fs from "fs"; import path from "path";
import { routeRows, routeLinks } from "./seed.mjs";

const ROOT = path.resolve(".");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
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

let bad = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? `\n         ${detail}` : ""}`);
  if (!ok) bad++;
};

async function openPlans(world, rpc) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  await context.route("**://*/**", (r) => (r.request().url().startsWith(base) ? r.continue() : r.abort()));
  await context.addInitScript(`window.__seed = ${JSON.stringify({ rows: world, rpc })};`);
  await context.addInitScript({ path: "studio/tests/fake-supabase.js" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  await page.goto(`${base}/studio/plans/?property=prop-1`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1300);
  return { context, page, errors };
}

console.log("\n── the ways through the building ──");
{
  const { context, page, errors } = await openPlans(routeRows(), { project_space_links: routeLinks() });
  check("the plans screen opens", errors.length === 0, errors[0] || "");

  const asked = await page.evaluate(() =>
    window.__rpcCalls.filter((c) => c.name === "project_space_links").map((c) => c.args));
  check("it asks the record how the rooms connect", asked.length === 1, JSON.stringify(asked));
  check("for this project", asked[0]?.p_property_id === "prop-1", JSON.stringify(asked[0]));

  const view = await page.evaluate(() => {
    const section = document.querySelector("#routes-section");
    return {
      shown: section && section.hidden === false,
      heading: section?.querySelector("h2")?.textContent.trim(),
      pill: document.querySelector("#routes-state")?.textContent.trim(),
      rows: [...document.querySelectorAll(".route-row")].map((row) => ({
        text: row.innerText.replace(/\s+/g, " ").trim(),
        unmapped: row.classList.contains("unmapped"),
        buttons: [...row.querySelectorAll("button")].map((b) => b.textContent.trim()),
      })),
    };
  });
  check("the section is on the page", view.shown === true);
  check("and says what it is for", /confirm the way through/i.test(view.heading || ""), view.heading || "");
  check("the count says how much of it a person has confirmed",
    /1 of 2 confirmed/i.test(view.pill || ""), view.pill || "");
  check("both routes are listed", view.rows.length === 2, `${view.rows.length} row(s)`);

  /* The rule the product rests on, in the one place a route could escape as a
     fact: a door the AI read is a reading until somebody recognises it. */
  const suggested = view.rows.find((row) => /Hall ↔ Kitchen/.test(row.text));
  check("a route the AI read says it is not confirmed",
    /read by ai · not confirmed/i.test(suggested?.text || ""), suggested?.text.slice(0, 120) || "(missing)");
  const confirmed = view.rows.find((row) => /Attic/.test(row.text));
  check("and a route a person confirmed says that instead",
    /confirmed by a person/i.test(confirmed?.text || ""), confirmed?.text.slice(0, 120) || "(missing)");

  /* The tidy version of this screen would drop this row and show a clean list.
     That would be the plans saying one thing and the screen another. */
  check("a route to a room the record does not have is still shown",
    confirmed?.unmapped === true, JSON.stringify(confirmed));
  check("and says exactly what is wrong with it",
    /on the plans, not in the record/i.test(confirmed?.text || ""), confirmed?.text.slice(0, 160) || "");

  /* A room somebody can walk into and find nothing in is not an error, but
     walking there expecting evidence is a wasted trip. */
  /* Two unlabelled lines under "Hall ↔ Kitchen" leave the reader guessing which
     room holds the three files. Each end names itself. */
  check("a room with captures says which room and how many",
    /Kitchen — 3 files/.test(suggested?.text || ""), suggested?.text || "");
  check("and one with none says so plainly",
    /Hall — nothing captured here yet/i.test(suggested?.text || ""), suggested?.text || "");

  check("an unconfirmed route offers both answers",
    suggested?.buttons.length === 2, JSON.stringify(suggested?.buttons));
  /* Nothing here is phrased as a system state. The question is one a person can
     answer by standing in the hall. */
  check("in words somebody standing in the building can answer",
    /this door is there/i.test((suggested?.buttons || []).join(" ")), JSON.stringify(suggested?.buttons));
  check("and a confirmed one is not asked to be confirmed again",
    confirmed?.buttons.length === 1, JSON.stringify(confirmed?.buttons));

  console.log("\n── confirming one ──");
  const sent = await page.evaluate(async () => {
    document.querySelector("[data-route-confirm]").click();
    await new Promise((r) => setTimeout(r, 700));
    return window.__rpcCalls.find((c) => c.name === "review_space_link")?.args || null;
  });
  check("confirming records it against that route", sent?.p_link_id === "lk-1", JSON.stringify(sent));
  check("as a confirmation", sent?.p_state === "confirmed", JSON.stringify(sent));

  console.log("\n── saying one is not there ──");
  /* Rejecting takes a route out of the walk. A wrong turn inside a headset
     cannot be undone by looking at the screen, so this one asks first. */
  const rejected = await page.evaluate(async () => {
    let asked = "";
    window.confirm = (message) => { asked = message; return false; };
    document.querySelector("[data-route-reject]").click();
    await new Promise((r) => setTimeout(r, 400));
    const refused = window.__rpcCalls.filter((c) => c.name === "review_space_link").length;
    window.confirm = () => true;
    document.querySelector("[data-route-reject]").click();
    await new Promise((r) => setTimeout(r, 700));
    return {
      asked,
      afterRefusing: refused,
      calls: window.__rpcCalls.filter((c) => c.name === "review_space_link").map((c) => c.args),
    };
  });
  check("it asks before removing a route", /remove the route/i.test(rejected.asked), rejected.asked.slice(0, 120));
  check("and says what is lost", /walk between these two rooms/i.test(rejected.asked), rejected.asked.slice(0, 200));
  check("saying no records nothing", rejected.afterRefusing === 1, `${rejected.afterRefusing} call(s)`);
  check("saying yes records the rejection",
    rejected.calls.at(-1)?.p_state === "rejected", JSON.stringify(rejected.calls.at(-1)));

  check("nothing threw", errors.length === 0, errors.join(" | "));
  await context.close();
}

console.log("\n── a plan set that named no openings ──");
{
  /* The screen has to say what happened and what would change it. A section
     that renders as an empty box is a dead end. */
  const { context, page, errors } = await openPlans(routeRows(), { project_space_links: [] });
  const empty = await page.evaluate(() => ({
    shown: document.querySelector("#routes-section")?.hidden === false,
    listHidden: document.querySelector("#route-list")?.hidden,
    text: document.querySelector("#routes-empty")?.innerText.replace(/\s+/g, " ").trim() || "",
    pill: document.querySelector("#routes-state")?.textContent.trim(),
  }));
  check("the section still says where you are", empty.shown === true);
  check("the empty list is not drawn as a row", empty.listHidden === true);
  check("it says what happened", /did not name any openings/i.test(empty.text), empty.text.slice(0, 120));
  check("and what would change it", /re-analysing/i.test(empty.text), empty.text.slice(0, 200));
  check("nothing threw on an empty answer", errors.length === 0, errors[0] || "");
  await context.close();
}

console.log("\n── a project with no plan set at all ──");
{
  const world = routeRows();
  world.plan_spaces = [];
  const { context, page, errors } = await openPlans(world, { project_space_links: [] });
  const hidden = await page.evaluate(() => document.querySelector("#routes-section")?.hidden);
  /* Before there are rooms there is nothing to connect, and a section asking
     about openings would be a question with no possible answer. */
  check("the section is not offered before there are rooms", hidden === true);
  check("and nothing threw", errors.length === 0, errors[0] || "");
  await context.close();
}

await browser.close(); server.close();
console.log(bad ? `\n${bad} FAILURES` : "\nALL OK");
process.exit(bad ? 1 : 0);
