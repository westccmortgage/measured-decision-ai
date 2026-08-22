/* An audit for the family of bugs this product keeps producing.
 *
 * Every one of them was the same shape: a control that answers nothing, or a
 * screen that knows the truth and shows something else. Create project did
 * nothing because a required field was hidden. The AI refusal told somebody to
 * add the file they had just added. The headline named the 360 machine while an
 * AI review ran. The 360 button opened an arbitrary room.
 *
 * Reading the markup would not have caught the first one — the browser's own
 * validation was the thing misbehaving — so this loads every page in a real
 * browser and asks the questions a person would ask by pressing things.
 *
 * Findings are reported, not thrown: the point is a complete list in one pass.
 */
import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";
import http from "http";
import fs from "fs";
import path from "path";
import { seed } from "./seed.mjs";

const PAGES = [
  ["Studio", "studio/index.html"],
  ["Plans", "studio/plans/index.html"],
  ["Operations", "studio/operations/index.html"],
  ["Field", "field/index.html"],
  ["Capture", "capture/index.html"],
];

/* Every script the page actually loads, concatenated. A page is wired by all of
   them — the Studio alone is served by nine — and judging its buttons against
   one file reports six working controls as dead. */
function scriptsFor(html) {
  const dir = path.dirname(html);
  const markup = fs.readFileSync(html, "utf8");
  return [...markup.matchAll(/<script[^>]+src="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((src) => !/^https?:/.test(src))
    // Cache-busting query strings are not part of the filename.
    .map((src) => path.join(dir, src.split("?")[0]))
    .filter((f) => fs.existsSync(f))
    .map((f) => fs.readFileSync(f, "utf8"))
    .join("\n");
}

const findings = [];
const note = (page, kind, detail) => findings.push({ page, kind, detail });

/* Served over HTTP with a signed-in session, because Plans and Operations send a
   signed-out visitor back to the Studio. Audited from a file:// URL they redirect
   before rendering, and the audit then reports on the page it landed on — which
   is how an earlier run produced a hundred confident findings about elements
   that were never missing. */
const ROOT = path.resolve(".");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
const server = http.createServer((req, res) => {
  let file = path.join(ROOT, decodeURIComponent(req.url.split("?")[0]));
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end("not found"); }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox", "--no-proxy-server", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});
const context = await browser.newContext({ viewport: { width: 430, height: 900 } });
await context.route("**://*/**", (route) =>
  route.request().url().startsWith(base) ? route.continue() : route.abort());
await context.addInitScript(`window.__seed = ${JSON.stringify(seed)};`);
await context.addInitScript({ path: "studio/tests/fake-supabase.js" });

for (const [label, html] of PAGES) {
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(String(e).slice(0, 160)));
  const url = `${base}/${html.replace(/index\.html$/, "")}`;
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  const landed = await page.evaluate(() => location.pathname);
  if (!landed.includes(html.split("/").slice(0, -1).join("/"))) {
    note(label, "page sent the visitor away", `asked for ${html}, ended on ${landed}`);
    await page.close();
    continue;
  }

  const source = scriptsFor(html);

  /* 1. A required control nobody can see is a submit button that does nothing.
        Asked of the browser, not of the markup: only the browser knows what is
        actually laid out. Fields inside a closed <dialog> are excluded — they
        become visible when the dialog opens, which is a different situation. */
  /* Which hidden blocks the scripts can open, so the audit can tell a section
     waiting its turn from one nobody can ever see. */
  const togglable = [...source.matchAll(/#([A-Za-z0-9_-]+)"\)(?:\.hidden|\.classList|\.showModal|\.open)|getElementById\("([A-Za-z0-9_-]+)"\)\.hidden/g)]
    .map((m) => m[1] || m[2]);
  await page.evaluate((ids) => { window.__togglable = ids; }, [...new Set(togglable)]);

  const hiddenRequired = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll("[required]").forEach((el) => {
      const dialog = el.closest("dialog");
      const hiddenByAncestor = el.closest("[hidden]");
      if (!hiddenByAncestor) return;
      // A [hidden] ancestor that is the dialog itself is fine — dialogs open.
      if (dialog && hiddenByAncestor === dialog) return;
      /* A block the page toggles is shown when its turn comes; only a block
         nothing can ever reveal makes its fields permanently unfillable. */
      if (hiddenByAncestor.id && window.__togglable.includes(hiddenByAncestor.id)) return;
      out.push({
        id: el.id || el.name || el.tagName.toLowerCase(),
        form: el.closest("form")?.id || "(no form)",
        blocker: hiddenByAncestor.id || hiddenByAncestor.tagName.toLowerCase(),
      });
    });
    return out;
  });
  hiddenRequired.forEach((f) =>
    note(label, "required field is hidden",
      `#${f.id} in form #${f.form} — hidden by <${f.blocker}>. The form cannot be submitted and the browser cannot say why.`));

  /* 2. Every form must be submittable with only its visible fields filled. */
  const stuckForms = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll("form").forEach((form) => {
      /* A form inside a panel the page can open is not stuck — it is waiting.
         The sign-in form lives behind "Open my projects", and judging it while
         that panel is closed reports the front door as nailed shut. */
      const panel = form.closest("[hidden]");
      if (panel && (!panel.id || window.__togglable.includes(panel.id))) return;

      form.querySelectorAll("input, textarea, select").forEach((el) => {
        if (el.type === "checkbox" || el.type === "radio" || el.disabled) return;
        if (el.offsetParent === null && !el.closest("dialog")) return;
        if (el.tagName === "SELECT") return;
        if (el.value) return;
        if (el.type === "email") el.value = "a@b.co";
        else if (el.type === "number") el.value = String(el.min || 1);
        else if (el.type === "date") el.value = "2026-01-01";
        else el.value = "x";
      });
      if (!form.checkValidity()) {
        const blocked = [...form.querySelectorAll(":invalid")]
          .map((el) => `#${el.id || el.tagName.toLowerCase()}${el.offsetParent === null ? " (invisible)" : ""}`);
        // Only report a form a person could be stuck in: one blocked by
        // something they cannot see.
        if (!blocked.some((b) => b.includes("(invisible)"))) return;
        out.push({ form: form.id || "(unnamed)", blocked: blocked.slice(0, 4) });
      }
    });
    return out;
  });
  stuckForms.forEach((f) =>
    note(label, "form cannot be submitted", `#${f.form} blocked by ${f.blocked.join(", ")}`));

  /* 3. A button that does nothing when pressed.
        Guessing from the source which controls are wired reported thirty
        working buttons as dead, so this presses them instead. After each press
        the page is reloaded, because a control that navigates, signs out or
        opens a dialog would otherwise decide what the next one is tested
        against. */
  const buttonList = await page.evaluate(() =>
    [...document.querySelectorAll("button")]
      .map((b, i) => ({ i, text: (b.textContent || "").trim().slice(0, 40), id: b.id }))
      .filter((b, i) => {
        const el = document.querySelectorAll("button")[i];
        return el.offsetParent !== null && !el.disabled;
      }));

  for (const b of buttonList) {
    const before = await page.evaluate(() => ({
      dom: document.body.innerHTML.length,
      url: location.href,
      open: document.querySelectorAll("dialog[open]").length,
      calls: (window.__rpcCalls || []).length + (window.__writes || []).length,
    }));
    await page.evaluate((index) => {
      const el = document.querySelectorAll("button")[index];
      if (el) el.click();
    }, b.i);
    await page.waitForTimeout(260);
    const after = await page.evaluate(() => ({
      dom: document.body.innerHTML.length,
      url: location.href,
      open: document.querySelectorAll("dialog[open]").length,
      calls: (window.__rpcCalls || []).length + (window.__writes || []).length,
      toast: (document.querySelector("#toast, .toast, [role='status']")?.textContent || "").trim().length,
    }));
    const didSomething = after.dom !== before.dom || after.url !== before.url ||
      after.open !== before.open || after.calls !== before.calls || after.toast > 0;
    if (!didSomething) {
      note(label, "button does nothing when pressed", `"${b.text}"${b.id ? ` (#${b.id})` : ""}`);
    }
    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForTimeout(500);
  }

  /* 4. An id the script reaches for that the page does not have. Reads as a
        feature that silently never runs. */
  const referenced = [...source.matchAll(/\$\("#([A-Za-z0-9_-]+)"\)|getElementById\("([A-Za-z0-9_-]+)"\)/g)]
    .map((m) => m[1] || m[2]);
  const present = await page.evaluate(() => [...document.querySelectorAll("[id]")].map((el) => el.id));
  [...new Set(referenced)].forEach((id) => {
    if (present.includes(id)) return;
    /* An element the script creates is not one the page is missing. */
    if (source.includes(`id = "${id}"`) || source.includes(`id="${id}"`)) return;
    note(label, "script reaches for a missing element", `#${id}`);
  });

  /* 5. A dialog a person cannot leave. */
  const trapped = await page.evaluate(() =>
    [...document.querySelectorAll("dialog")].filter((d) => {
      const closers = d.querySelectorAll('button[value="cancel"], [data-close], .dialog-close, button[type="submit"]');
      return closers.length === 0;
    }).map((d) => d.id || "(unnamed dialog)"));
  trapped.forEach((d) => note(label, "dialog has no way out", d));

  /* Mobile-first is a product rule, so a page that scrolls sideways on a phone
     is a defect, not a preference. */
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (overflow > 1) note(label, "page scrolls sideways on a phone", `${overflow}px past a 430px screen`);

  consoleErrors.forEach((e) => note(label, "script error on load", e));
  await page.close();
}

await browser.close();
server.close();

const byKind = {};
findings.forEach((f) => { (byKind[f.kind] ||= []).push(f); });

console.log(`\n${"=".repeat(72)}\nSCREEN AUDIT — ${findings.length} finding${findings.length === 1 ? "" : "s"}\n${"=".repeat(72)}`);
for (const [kind, list] of Object.entries(byKind)) {
  console.log(`\n▸ ${kind.toUpperCase()}  (${list.length})`);
  list.forEach((f) => console.log(`   [${f.page}] ${f.detail}`));
}
if (!findings.length) console.log("\nNothing found.");
console.log("");
