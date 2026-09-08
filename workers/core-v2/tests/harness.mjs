import { closeTheNetwork } from "../kernel/network-guard.ts";
/* The few lines every engine test shares. Same voice as studio/tests: a
   labelled line per check, a count of failures, "ALL OK" or exit 1. */
export function harness(title) {
  let bad = 0;
  const check = (label, ok, detail = "") => {
    console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? `\n         ${detail}` : ""}`);
    if (!ok) bad++;
  };
  const refused = async (label, fn) => {
    try { await fn(); check(label, false, "the call was allowed"); }
    catch (error) { check(label, true, `refused: ${String(error.message ?? error).slice(0, 90)}`); }
  };
  const section = (name) => console.log(`\n── ${name} ──`);
  const finish = () => {
    console.log("");
    if (bad) { console.log(`  ${bad} FAILURE${bad === 1 ? "" : "S"}`); process.exit(1); }
    console.log("  ALL OK");
  };
  console.log(`━━ ${title}`);
  return { check, refused, section, finish };
}

/* A closed network for the whole test process — the engine's own guard, so
   every door is shut, and the count says whether anything tried one. */
export function closeNetwork() {
  const guard = closeTheNetwork();
  return () => guard.tripped();
}
