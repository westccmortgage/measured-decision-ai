/* Stamp every local script and stylesheet with the hash of what it contains.
 *
 * The tokens used to be written by hand — "20260818-recent-1" — and a file
 * edited without its token bumped is served from cache. That is how a button
 * came to be drawn on the page with no handler behind it: fresh markup,
 * four-day-old script. index.html is sent no-cache and everything beside it is
 * cached hard, so the two halves of a page drift apart silently.
 *
 * A hash cannot be forgotten. Run this after changing any asset:
 *     node studio/tests/stamp-assets.mjs
 * asset-versions.mjs then fails if anything is out of date.
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";

export const PAGES = [
  "studio/index.html",
  "studio/plans/index.html",
  "studio/owner-view/index.html",
  "studio/operations/index.html",
  "field/index.html",
  "capture/index.html",
  "index.html",
];

const REF = /(?:src|href)="([^"#]+\.(?:js|css))(\?v=[^"]*)?"/g;

export function stamp(html, { write = false } = {}) {
  const dir = path.dirname(html);
  let markup = fs.readFileSync(html, "utf8");
  const drift = [];

  markup = markup.replace(REF, (whole, file, token) => {
    if (/^https?:|^\/\//.test(file)) return whole;
    const onDisk = path.join(dir, file);
    if (!fs.existsSync(onDisk)) return whole;
    const hash = crypto.createHash("sha256")
      .update(fs.readFileSync(onDisk)).digest("hex").slice(0, 10);
    const want = `?v=${hash}`;
    if (token !== want) drift.push({ file, had: token || "(none)", want });
    return whole.replace(file + (token || ""), file + want);
  });

  if (write && drift.length) fs.writeFileSync(html, markup);
  return drift;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let total = 0;
  for (const page of PAGES) {
    if (!fs.existsSync(page)) continue;
    const drift = stamp(page, { write: true });
    if (drift.length) {
      console.log(`\n${page}`);
      drift.forEach((d) => console.log(`  ${d.file}\n    ${d.had}  →  ${d.want}`));
      total += drift.length;
    }
  }
  console.log(total ? `\n${total} asset reference(s) restamped.` : "\nEverything already current.");
}
