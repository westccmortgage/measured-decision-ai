/* The front door offers two products that behave nothing alike, and used to
   present them identically: a workspace project with rooms, an AI review and a
   report, beside a code project that only receives files. Both appeared in one
   list as a name and an arrow.

   Somebody signed out, saw both projects, opened the wrong one, signed in, and
   watched it disappear — with nothing anywhere having said they were different. */
import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";
import http from "http"; import fs from "fs"; import path from "path";

const ROOT = path.resolve(".");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const server = http.createServer((req, res) => {
  let f = path.join(ROOT, req.url.split("?")[0]);
  if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, "index.html");
  if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(f)] || "application/octet-stream" });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox", "--no-proxy-server"],
});
const context = await browser.newContext({ viewport: { width: 430, height: 900 } });
await context.route("**://*/**", (r) => r.request().url().startsWith(base) ? r.continue() : r.abort());
await context.addInitScript(`window.__seed={session:null,rows:{}};`);
await context.addInitScript({ path: "studio/tests/fake-supabase.js" });
/* Exactly the device state that produced the confusion: one of each kind. */
await context.addInitScript(`
  localStorage.setItem("mdai-recent-projects-v1", JSON.stringify([{id:"prop-1",name:"Hutton Pl",openedAt:Date.now()}]));
  localStorage.setItem("mdai-simple-projects-v1", JSON.stringify([{id:"prop-2",name:"3001",code:"UQF3-JWPP-SKG9",openedAt:Date.now()}]));
`);
const page = await context.newPage();
await page.goto(`${base}/studio/`, { waitUntil: "networkidle" });
await page.waitForTimeout(800);

let bad = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `\n       ${detail}` : ""}`);
  if (!ok) bad++;
};

const list = await page.evaluate(() => {
  const el = document.getElementById("simple-recent-projects");
  return {
    text: (el?.innerText || "").replace(/\n+/g, " · "),
    groups: [...(el?.querySelectorAll(".simple-recent-kind") || [])].map((g) => g.innerText.replace(/\n/g, " — ")),
    workspaceButtons: el?.querySelectorAll("[data-simple-property]").length || 0,
    codeButtons: el?.querySelectorAll("[data-simple-code]").length || 0,
  };
});

check("both projects are listed", list.workspaceButtons === 1 && list.codeButtons === 1,
  `${list.workspaceButtons} workspace, ${list.codeButtons} code`);
check("they are in separate, named groups", list.groups.length === 2, list.groups.join("  |  "));
check("the workspace group says what it gives you",
  /rooms/i.test(list.groups[0] || "") && /report/i.test(list.groups[0] || ""), list.groups[0]);
check("the code group says nothing is analysed",
  /nothing is analysed/i.test(list.groups[1] || ""), list.groups[1]);
check("a workspace project says it needs signing in first",
  /sign in to open/i.test(list.text), list.text.slice(0, 160));

/* The choice of door must state the difference before it is taken. */
const difference = await page.evaluate(() =>
  (document.querySelector(".simple-intake-difference")?.textContent || "").trim());
check("the two create buttons explain what each makes",
  /workspace/i.test(difference) && /code/i.test(difference), difference);

const dialogNote = await page.evaluate(() => {
  document.getElementById("simple-create-project").click();
  return (document.querySelector("#simple-create-dialog .simple-dialog-note")?.textContent || "").trim();
});
check("the no-account dialog says what it will not give you",
  /not part of it|only receives files/i.test(dialogNote) && /workspace/i.test(dialogNote), dialogNote);
check("its eyebrow no longer reads the same as the workspace dialog",
  await page.evaluate(() => (document.querySelector("#simple-create-dialog .eyebrow")?.textContent || "").includes("no account")));

await browser.close(); server.close();
console.log(bad ? `\n${bad} FAILURES` : "\nALL OK");
process.exit(bad ? 1 : 0);
