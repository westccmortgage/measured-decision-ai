/* "I open any file and nothing happens."
 *
 * Reported from the studio, about a project with twenty-seven files in it.
 * Every press of Open ended in one of two silences, and both of them were
 * the product's fault rather than the record's:
 *
 *   A file the record has not placed in a room lives in no room's evidence
 *   list. The file list reads the PROJECT, so it showed the file and offered
 *   Open; the opener looked only through the rooms, found nothing, and said
 *   the file was "not something the viewer can open". It is a file. It opens.
 *
 *   And when the private cloud would not sign a link — an expired signature,
 *   a storage door that answered badly — every path swallowed the failure and
 *   returned an empty string, so the viewer opened on nothing at all: a black
 *   rectangle, no words, no way forward. That is precisely what "nothing
 *   happens" looks like from the other side of the screen.
 *
 * Neither may ever be silent again. The rule this breaks is the product's
 * oldest one: no dead ends.
 */
import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";
import http from "http"; import fs from "fs"; import path from "path";
import { realProjectRows } from "./seed.mjs";

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

let bad = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? `\n         ${detail}` : ""}`);
  if (!ok) bad++;
};

const world = realProjectRows();
/* The file nobody filed. Real: it is what an upload that arrives before a
   room is chosen leaves behind, and the record is right to keep it. */
const LOOSE = "ev-loose";
world.evidence_items.push({
  id: LOOSE, organization_id: "org-1", property_id: "prop-1", space_id: null,
  storage_path: "p/loose-vid_20250222_050000_099-vr-master.mp4",
  storage_provider: "aws-s3", storage_bucket: "b", object_version_id: null,
  original_filename: "vid_20250222_050000_099-vr-master.mp4",
  media_type: "360 capture", mime_type: "video/mp4", byte_size: 1024,
  captured_at: "2026-08-24T01:00:00.000Z", created_at: "2026-08-24T01:00:00.000Z",
  source_metadata: { projection: "equirectangular", vr: { playback_ready: true } },
  deleted_at: null,
});

const files = world.evidence_items.map((item) => {
  const room = world.spaces.find((space) => space.id === item.space_id);
  return {
    id: item.id, filename: item.original_filename, media_type: item.media_type,
    mime_type: item.mime_type, byte_size: item.byte_size,
    room_id: item.space_id, room_name: room?.name || null,
    room_building: room?.building || null, room_level: room?.level || null,
    happened_at: item.captured_at, uploaded_at: item.created_at, duplicate_name: false,
  };
});

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox", "--no-proxy-server", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});
const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
await context.route("**://*/**", (r) => (r.request().url().startsWith(base) ? r.continue() : r.abort()));
await context.addInitScript(`window.__seed = ${JSON.stringify({ rows: world, rpc: { project_files: files } })};`);
await context.addInitScript({ path: "studio/tests/fake-supabase.js" });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
await page.goto(`${base}/studio/`, { waitUntil: "networkidle" });
await page.waitForTimeout(900);
await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => (x.textContent || "").includes("3001 Hutton"));
  if (b) b.click();
});
await page.waitForTimeout(1600);
check("the project opens", errors.length === 0, errors[0] || "");

const openFile = async (term) => page.evaluate(async (needle) => {
  document.querySelector("#focus-files-list") || document.querySelector('[data-focus-step="upload"]')?.click();
  await new Promise((r) => setTimeout(r, 400));
  if (document.querySelector("#focus-files")?.hidden !== false) {
    document.querySelector("#focus-open-files")?.click();
    await new Promise((r) => setTimeout(r, 800));
  }
  const search = document.querySelector("#focus-files-search");
  search.value = needle;
  search.dispatchEvent(new Event("input", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 400));
  const rows = [...document.querySelectorAll(".focus-file-row")];
  const notices = [];
  const seen = new MutationObserver(() => {
    document.querySelectorAll(".toast, [data-notify], .studio-toast").forEach((n) => {
      const text = n.textContent.trim();
      if (text && !notices.includes(text)) notices.push(text);
    });
  });
  seen.observe(document.body, { childList: true, subtree: true });
  rows[0]?.querySelector("[data-file-open]")?.click();
  await new Promise((r) => setTimeout(r, 1200));
  seen.disconnect();
  return {
    rows: rows.length,
    rowName: rows[0]?.querySelector("strong")?.textContent || "",
    viewerUp: Boolean(document.querySelector(".pano-overlay")),
    title: document.querySelector("[data-pano-title]")?.textContent || "",
    subtitle: document.querySelector("[data-pano-subtitle]")?.textContent || "",
    actions: [...document.querySelectorAll(".pano-foot button")].map((b) => b.textContent.trim()),
    notices,
  };
}, term);

console.log("\n── a file the record never filed in a room ──");
const loose = await openFile("050000_099");
check("the file list shows it", loose.rows === 1 && /050000_099/.test(loose.rowName),
  `${loose.rows} row(s): ${loose.rowName}`);
/* The whole of the report, in one assertion: the press does something. */
check("pressing Open opens the viewer rather than doing nothing",
  loose.viewerUp === true, JSON.stringify(loose.notices));
check("and the viewer is showing that file, by name",
  /050000_099/.test(loose.title), loose.title || "(nothing)");
check("it is never called a file the viewer cannot open",
  !loose.notices.some((text) => /not something the viewer can open/i.test(text)),
  JSON.stringify(loose.notices));
check("and it does not claim a room nobody put it in",
  !/Hutton|Room|Hallway/i.test(loose.subtitle.split("·")[0] || ""), loose.subtitle.slice(0, 160));

console.log("\n── and a filed file behaves the same way ──");
const filed = await openFile("042059_009-vr-master");
check("it opens too", filed.viewerUp === true && /042059_009/.test(filed.title), filed.title || "(nothing)");
check("naming the room it is filed in", /\S/.test(filed.subtitle.split("·")[0] || ""), filed.subtitle.slice(0, 160));
check("nothing threw", errors.length === 0, errors.join(" | "));

console.log("\n── the private cloud will not sign a link ──");
/* A storage door that has stopped answering. The signing call comes back
   without a URL — which is what an expired credential, a refused session or a
   function that is down all look like from the page — and every path to a
   signature swallows that and answers with an empty string. The viewer used
   to open on that empty string: a black rectangle and no words. */
const refused = await browser.newContext({ viewport: { width: 1200, height: 900 } });
await refused.route("**://*/**", (r) => (r.request().url().startsWith(base) ? r.continue() : r.abort()));
await refused.addInitScript(`window.__seed = ${JSON.stringify({
  rows: world, rpc: { project_files: files }, functions: { "object-storage": {} },
})};`);
await refused.addInitScript({ path: "studio/tests/fake-supabase.js" });
const dark = await refused.newPage();
const darkErrors = [];
dark.on("pageerror", (e) => darkErrors.push(String(e).slice(0, 200)));
await dark.goto(`${base}/studio/`, { waitUntil: "networkidle" });
await dark.waitForTimeout(900);
await dark.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => (x.textContent || "").includes("3001 Hutton"));
  if (b) b.click();
});
await dark.waitForTimeout(1600);
const blind = await dark.evaluate(async () => {
  document.querySelector('[data-focus-step="upload"]')?.click();
  await new Promise((r) => setTimeout(r, 400));
  document.querySelector("#focus-open-files")?.click();
  await new Promise((r) => setTimeout(r, 800));
  const search = document.querySelector("#focus-files-search");
  search.value = "042059_009-vr-master";
  search.dispatchEvent(new Event("input", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 400));
  [...document.querySelectorAll(".focus-file-row")][0]?.querySelector("[data-file-open]")?.click();
  await new Promise((r) => setTimeout(r, 1200));
  return {
    viewerUp: Boolean(document.querySelector(".pano-overlay")),
    title: document.querySelector("[data-pano-title]")?.textContent || "",
    subtitle: document.querySelector("[data-pano-subtitle]")?.textContent || "",
    actions: [...document.querySelectorAll(".pano-foot button")].map((b) => b.textContent.trim()),
  };
});
check("the press still opens something", blind.viewerUp === true, blind.title || "(nothing)");
check("and it says so in words rather than showing a blank",
  /would not sign a link/i.test(blind.subtitle), blind.subtitle.slice(0, 220));
check("and says the original is untouched, because it is",
  /original is untouched/i.test(blind.subtitle), blind.subtitle.slice(0, 220));
check("and offers the next thing to try",
  blind.actions.some((label) => /try again/i.test(label)), JSON.stringify(blind.actions));
check("nothing threw on that page either", darkErrors.length === 0, darkErrors.join(" | "));

await browser.close(); server.close();
console.log(bad ? `\n${bad} FAILURES` : "\nALL OK");
process.exit(bad ? 1 : 0);
