/* The CLI runs where it is checked out — under a directory with a space in
   its name, or reached through a symlink — and says so when run wrong. This
   test spawns processes, so it is the one file that does not close the
   network; the children close their own. */
import { harness } from "./harness.mjs";
import { cpSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const t = harness("the CLI runs from wherever it is");
const engine = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const scratch = mkdtempSync(join(process.env.CORE_V2_SCRATCH ?? tmpdir(), "core-v2 entry "));
const copy = join(scratch, "with space", "core-v2");
cpSync(engine, copy, { recursive: true, filter: (p) => !/node_modules/.test(p) });
const link = join(scratch, "link");
symlinkSync(engine, link);
const run = (cwd, script, args) => spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", script, ...args], { cwd, encoding: "utf8" });

t.section("F · a path with a space, a symlink, and no arguments");
{
  const r = run(copy, "cli.ts", ["--dry-run"]);
  t.check("from a directory with a space, --dry-run prints the graph", r.status === 0 && /bounded assignments/.test(r.stdout), `exit ${r.status}: ${(r.stderr || r.stdout).slice(0, 120)}`);
  const s = run(copy, "cli.ts", ["--simulate"]);
  t.check("and --simulate prints its summary with zero network calls", s.status === 0 && /"networkCallsAttempted": 0/.test(s.stdout), `exit ${s.status}`);
  const l = run(scratch, join(link, "cli.ts"), ["--dry-run"]);
  t.check("through a symlink, --dry-run prints the graph", l.status === 0 && /bounded assignments/.test(l.stdout), `exit ${l.status}`);
  const u = run(copy, "cli.ts", []);
  t.check("with no arguments it prints usage and exits 2", u.status === 2 && /usage/.test(u.stdout), `exit ${u.status}`);
  const n = run(copy, "cli.ts", ["--dry-run"]);
  t.check("the dry run names sixteen roles and no provider", /roles registered: 16/.test(n.stdout) && !/openai|anthropic|google|claude|gemini/i.test(n.stdout));
}
rmSync(scratch, { recursive: true, force: true });
t.finish();
