/* Every cached asset must be referenced by the hash of what it now contains.
   A file changed without its reference changed is served from a browser's cache
   while index.html arrives fresh — the page and its behaviour come from
   different days, and a button drawn by new markup has no handler behind it. */
import fs from "fs";
import { PAGES, stamp } from "./stamp-assets.mjs";

let bad = 0;
for (const page of PAGES) {
  if (!fs.existsSync(page)) continue;
  const drift = stamp(page);
  if (!drift.length) { console.log(`ok   ${page}`); continue; }
  bad += drift.length;
  console.log(`FAIL ${page} — ${drift.length} reference(s) point at content that has changed:`);
  drift.forEach((d) => console.log(`       ${d.file}  ${d.had} → ${d.want}`));
}
console.log(bad
  ? `\n${bad} stale reference(s). Run: node studio/tests/stamp-assets.mjs`
  : "\nALL OK");
process.exit(bad ? 1 : 0);
