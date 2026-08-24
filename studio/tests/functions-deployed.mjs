/* Every Edge Function in the repository is one the deploy actually ships.
 *
 * The workflow used to name each function in its own step, by hand. Adding
 * capture-machine and not adding a ninth step meant the Studio called a
 * function that had never been deployed: the button said "The 360 machine
 * could not be reached", which was true and pointed at nothing.
 *
 * The workflow now deploys the directory rather than a list. This checks that
 * it stayed that way — a list is easy to reintroduce and impossible to notice.
 */
import fs from "fs";

const workflow = fs.readFileSync(".github/workflows/deploy-supabase-function.yml", "utf8");
const onDisk = fs.readdirSync("supabase/functions", { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
  .map((entry) => entry.name)
  .sort();

let bad = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? `\n         ${detail}` : ""}`);
  if (!ok) bad++;
};

console.log("\n── what the deploy ships ──");
console.log(`  ${onDisk.length} function(s) in supabase/functions: ${onDisk.join(", ")}`);

/* A bare `supabase functions deploy` takes the whole directory. Anything
   following it on the command is a function name, and a name means a list. */
const named = [...workflow.matchAll(/supabase functions deploy\s+([a-z][a-z0-9-]*)/g)]
  .map((match) => match[1]);
check("the deploy is not a hand-kept list of names", named.length === 0,
  named.length ? `names it deploys one by one: ${named.join(", ")}` : "");

check("it deploys the whole directory",
  /supabase functions deploy\s*\n?\s*--project-ref/.test(workflow));

/* Belt and braces: if somebody does go back to a list, at least say which
   function would be silently missing from it. */
if (named.length) {
  const missing = onDisk.filter((name) => !named.includes(name));
  check("and every function on disk is in it", missing.length === 0,
    missing.length ? `never deployed: ${missing.join(", ")}` : "");
}

/* A function the Studio calls but that does not exist on disk fails the same
   way, from the other direction. */
console.log("\n── what the Studio calls ──");
const studio = fs.readFileSync("studio/studio.js", "utf8");
const invoked = [...new Set(
  [...studio.matchAll(/functions\.invoke\(\s*"([a-z][a-z0-9-]*)"/g)].map((m) => m[1]),
)].sort();
console.log(`  invoked from the Studio: ${invoked.join(", ") || "(none)"}`);
const absent = invoked.filter((name) => !onDisk.includes(name));
check("every function it calls exists", absent.length === 0,
  absent.length ? `called but not in supabase/functions: ${absent.join(", ")}` : "");

console.log(bad ? `\n${bad} FAILURES` : "\nALL OK");
process.exit(bad ? 1 : 0);
