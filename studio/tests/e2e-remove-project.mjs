/* Taking a project off the list, and putting it back.
 *
 * Four test projects accumulated on the front page with no way to clear them,
 * and a list that only ever grows stops being a list of what matters.
 *
 * The rule this has to satisfy is the one that makes removal safe to offer at
 * all: nothing is destroyed. The evidence, the rooms and the audit trail stay
 * exactly where they were, the removal is itself an audited event, and the
 * project can be put back. A remove button with no way back is a trapdoor, so
 * the way back is asserted here beside the way out.
 */
import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";
import http from "http"; import fs from "fs"; import path from "path";
import { rows } from "./seed.mjs";

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

/* Two projects, so removing one leaves something behind and the list is not
   confused with the empty state. */
const twoProjects = () => {
  const r = JSON.parse(JSON.stringify(rows));
  r.properties.push({
    id: "prop-2", organization_id: r.properties[0].organization_id, name: "11",
    address: {}, access_classification: "private",
    created_at: "2026-08-22T00:00:00Z", deleted_at: null,
  });
  return r;
};

async function openDirectory(seedRows, rpc = {}) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  await context.route("**://*/**", (r) => (r.request().url().startsWith(base) ? r.continue() : r.abort()));
  await context.addInitScript(`window.__seed = ${JSON.stringify({ rows: seedRows, rpc })};`);
  await context.addInitScript({ path: "studio/tests/fake-supabase.js" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 160)));
  page.on("dialog", (d) => d.accept());
  await page.goto(`${base}/studio/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1100);
  return { context, page, errors };
}

console.log("\n── the list of projects ──");
{
  const { context, page, errors } = await openDirectory(twoProjects());
  check("it opens without throwing", errors.length === 0, errors[0] || "");
  const seen = await page.evaluate(() => ({
    opens: [...document.querySelectorAll("[data-property-id]")].map((b) => b.textContent.trim()),
    removes: [...document.querySelectorAll("[data-remove-property]")].length,
    /* A button inside a button is invalid, and the inner one stops being
       clickable. The row had to stop being one big button for this to work. */
    nested: [...document.querySelectorAll("button button")].length,
  }));
  check("every project can be opened", seen.opens.length === 2, seen.opens.join(" | "));
  check("and every project can be removed", seen.removes === 2, `${seen.removes} remove control(s)`);
  check("no control is buried inside another", seen.nested === 0, `${seen.nested} nested button(s)`);
  await context.close();
}

console.log("\n── removing one ──");
{
  const { context, page } = await openDirectory(twoProjects());
  /* What the person is asked before it happens matters more than the button:
     "delete" and "nothing is destroyed" lead to completely different decisions. */
  const asked = await page.evaluate(async () => {
    let text = "";
    const original = window.confirm;
    window.confirm = (message) => { text = message; return true; };
    document.querySelector("[data-remove-property]").click();
    await new Promise((r) => setTimeout(r, 600));
    window.confirm = original;
    return { text, calls: window.__rpcCalls.filter((c) => c.name === "soft_delete_project") };
  });
  check("it asks before removing", Boolean(asked.text), asked.text || "(asked nothing)");
  check("and says nothing is destroyed", /nothing is destroyed/i.test(asked.text), asked.text);
  check("and says it can be put back", /put back/i.test(asked.text), asked.text);
  check("it names the project by name", /3001 Hutton/.test(asked.text), asked.text);
  /* Soft delete, never a row deletion. The evidence and the audit trail hang
     off this project and outlive it on purpose. */
  check("it removes softly, through the function that keeps everything",
    asked.calls.length === 1, JSON.stringify(asked.calls));
  check("and passes the project it was pressed on",
    asked.calls[0]?.args?.p_property_id === "prop-1", JSON.stringify(asked.calls[0]?.args));
  await context.close();
}

console.log("\n── saying no ──");
{
  const { context, page } = await openDirectory(twoProjects());
  const refused = await page.evaluate(async () => {
    window.confirm = () => false;
    document.querySelector("[data-remove-property]").click();
    await new Promise((r) => setTimeout(r, 500));
    return window.__rpcCalls.filter((c) => c.name === "soft_delete_project").length;
  });
  check("changing your mind removes nothing", refused === 0, `${refused} call(s)`);
  await context.close();
}

console.log("\n── what was removed, and the way back ──");
{
  const removed = [{
    id: "prop-9", name: "Old test project",
    deleted_at: "2026-08-23T10:00:00Z", deleted_by: "user-1", deletion_reason: null,
  }];
  const { context, page, errors } = await openDirectory(twoProjects(), { removed_projects: removed });
  check("the page still opens", errors.length === 0, errors[0] || "");
  const panel = await page.evaluate(async () => {
    const details = document.querySelector("#removed-projects");
    if (!details || details.hidden) return null;
    details.open = true;
    await new Promise((r) => setTimeout(r, 200));
    return {
      text: (details.innerText || "").replace(/\s+/g, " "),
      restore: document.querySelector("[data-restore-property]")?.textContent.trim() || null,
    };
  });
  check("a removed project is still visible", Boolean(panel), "the panel never appeared");
  check("it is named", /Old test project/.test(panel?.text || ""), panel?.text || "");
  check("it repeats that nothing was destroyed",
    /nothing was destroyed/i.test(panel?.text || ""), panel?.text || "");
  /* The whole reason removal is safe to offer. */
  check("and it can be put back", Boolean(panel?.restore), panel?.restore || "(no way back)");

  const restored = await page.evaluate(async () => {
    document.querySelector("[data-restore-property]").click();
    await new Promise((r) => setTimeout(r, 500));
    return window.__rpcCalls.filter((c) => c.name === "restore_project");
  });
  check("pressing it restores that project", restored.length === 1, JSON.stringify(restored));
  check("and names the right one", restored[0]?.args?.p_property_id === "prop-9",
    JSON.stringify(restored[0]?.args));
  await context.close();
}

console.log("\n── with nothing removed ──");
{
  const { context, page } = await openDirectory(twoProjects());
  const hidden = await page.evaluate(() => document.querySelector("#removed-projects")?.hidden);
  /* An empty panel is clutter on the screen a person sees most often. */
  check("the panel stays out of the way", hidden === true);
  await context.close();
}

await browser.close(); server.close();
console.log(bad ? `\n${bad} FAILURES` : "\nALL OK");
process.exit(bad ? 1 : 0);
