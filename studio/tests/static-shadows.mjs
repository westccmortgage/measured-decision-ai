/* The class of bug that reached a person on 2026-08-28: a shadowed const in
 * savePendingFiles made every plan save throw before the upload began, and
 * no browser test drove that path. Shadowing and use-before-define are
 * invisible in review and fatal at runtime — so they are refused statically,
 * before any browser opens.
 *
 * Requires network on first run (npx fetches eslint into the npm cache);
 * after that it runs from cache. If eslint truly cannot be obtained the
 * check FAILS — a gate that silently skips is not a gate. */
import { execFileSync } from "child_process";

const FILES = [
  "studio/studio.js",
  "studio/plans/plans.js",
  "studio/owner-view/owner-view.js",
  "studio/s3-upload.js",
  "studio/pano360.js",
];

try {
  execFileSync("npx", ["--yes", "eslint@9", "--config", "studio/tests/eslint.config.mjs", ...FILES], {
    stdio: "inherit",
  });
  console.log("  ok   no shadowed bindings, no use before definition");
  console.log("ALL OK");
} catch {
  console.log("  FAIL a binding is shadowed or used before it is defined — see eslint output above");
  process.exit(1);
}
