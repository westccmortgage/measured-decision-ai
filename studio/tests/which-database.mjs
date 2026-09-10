/* WHICH DATABASE A PAGE TALKS TO IS DECIDED BY THE ADDRESS IT WAS OPENED AT.
 *
 * The accident this guards against is a quiet one. The test platform and the
 * live product are the same files; only the host differs. If the rule were
 * "a test host gets production and everything else gets the branch", or if a
 * host merely ENDING in the deploy suffix counted, then merging this page to
 * the prime domain would point the live product at a branch database — and
 * nothing on the screen would say so until somebody's real files were gone.
 *
 * So the rule is asserted in both directions: production is the default, and
 * only an address that is definitely a deploy of this repository departs from
 * it.
 */
import { backendFor, isTestHost, TEST_BRANCH } from "../analysis/backend.js";

const PRODUCTION = Object.freeze({
  supabaseUrl: "https://hbqlhplgqwuesrovbiye.supabase.co",
  supabasePublishableKey: "sb_publishable_production_key_stand_in",
});

let bad = 0;
const ok = (claim, held, said = "") => {
  if (!held) bad++;
  console.log(`  ${held ? "ok  " : "FAIL"} ${claim}${said ? `\n         ${said}` : ""}`);
};

console.log("\n── the prime domain is the live product, and nothing changes that ──");
for (const host of ["measureddecision.ai", "www.measureddecision.ai", "measureddecisionai.netlify.app"]) {
  const backend = backendFor(host, PRODUCTION);
  ok(`${host} → production`, backend.name === "production" && backend.database === "hbqlhplgqwuesrovbiye", backend.database);
}

console.log("\n── a deploy of this repository is a test, and says so ──");
for (const host of ["deploy-preview-223--measureddecisionai.netlify.app",
                    "claude-core-v2--measureddecisionai.netlify.app",
                    "localhost", "127.0.0.1"]) {
  const backend = backendFor(host, PRODUCTION);
  ok(`${host} → the test branch`, backend === TEST_BRANCH, backend.database);
}

console.log("\n── a host that merely looks like one is not one ──");
for (const host of ["evil--measureddecisionai.netlify.app.attacker.example",
                    "measureddecisionai.netlify.app.attacker.example",
                    "notlocalhost", "127.0.0.1.attacker.example", ""]) {
  ok(`${host || "(no host at all)"} → production`, !isTestHost(host), String(isTestHost(host)));
}

console.log("\n── the screen can always name where a file just went ──");
const test = backendFor("deploy-preview-223--measureddecisionai.netlify.app", PRODUCTION);
const live = backendFor("measureddecision.ai", PRODUCTION);
ok("each backend has a name a person can read", Boolean(test.name && live.name), `${test.name} · ${live.name}`);
ok("each names its database", Boolean(test.database && live.database), `${test.database} · ${live.database}`);
ok("and they are not the same database", test.database !== live.database);
ok("the test branch carries a publishable key, never a secret one",
   /^sb_publishable_/.test(TEST_BRANCH.publishableKey), TEST_BRANCH.publishableKey.slice(0, 18) + "…");

console.log(bad ? `\n  ${bad} FAILURES` : "\n  ALL OK");
process.exit(bad ? 1 : 0);
