/* WHICH BACKEND THIS PAGE IS TALKING TO, AND WHY IT IS DECIDED BY THE HOST.
 *
 * The Studio's own `config.js` names the production project, and that is right
 * for the Studio. It is wrong for a test platform: an analysis run for the
 * first time by somebody trying the product should not put its files, its
 * spending and its half-finished workflows in the same database as the work
 * that is real.
 *
 * So this page picks by the address it was opened at. A Netlify deploy of this
 * repository — a pull request preview or a branch deploy — is a test, and gets
 * the TEST BRANCH of the Supabase project. Anything else, including the prime
 * domain, gets production. The rule is that way round on purpose: the default
 * is production, and only an address that is definitely a test deploy departs
 * from it. Merging this page to the prime domain therefore cannot quietly
 * point the product at a branch database, which is the accident this file
 * exists to make impossible.
 *
 * The key below is a PUBLISHABLE key. It is meant to be in a page — it is the
 * same kind of key `config.js` already carries — and row-level security is
 * what protects the data behind it, not the secrecy of this string.
 *
 * The screen says which one it is using. A person testing a product should
 * never have to guess which database they just put a file in.
 */

/* The Supabase preview branch that tracks this pull request. Its database, its
   storage, its functions and its watchdog are its own; production has none of
   this analysis's rows and none of its spending. */
export const TEST_BRANCH = Object.freeze({
  name: "test branch",
  supabaseUrl: "https://viuqggxrahckzbrnecoo.supabase.co",
  publishableKey: "sb_publishable_fNHYeNdjsKH-LYAyEO7_Vw__X2scPqH",
  storageBucket: "property-evidence",
  database: "viuqggxrahckzbrnecoo",
  note: "A test branch of the Measured Decision database. Its files, its analyses and its spending are separate from the live product's.",
});

/* Netlify gives every deploy of this repository a host of the form
   <something>--measureddecisionai.netlify.app: a pull request preview, a
   branch deploy, or the site's own deploy name. Anchored at both ends, so a
   host that merely ends in something similar is not this site. */
const NETLIFY_DEPLOY = /^[a-z0-9][a-z0-9-]*--measureddecisionai\.netlify\.app$/;
const LOCAL = /^(localhost|127\.0\.0\.1)$/;

export function isTestHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return NETLIFY_DEPLOY.test(host) || LOCAL.test(host);
}

/* `production` is whatever config.js says, because that is the one place the
   product's own address is written down. */
export function backendFor(hostname, production) {
  if (isTestHost(hostname)) return TEST_BRANCH;
  return Object.freeze({
    name: "production",
    supabaseUrl: production?.supabaseUrl ?? "",
    publishableKey: production?.supabasePublishableKey ?? "",
    storageBucket: production?.storageBucket ?? "property-evidence",
    database: String(production?.supabaseUrl ?? "").replace(/^https:\/\//, "").split(".")[0],
    note: "The live Measured Decision database.",
  });
}
