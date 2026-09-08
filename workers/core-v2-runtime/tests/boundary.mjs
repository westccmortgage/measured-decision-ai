/* THE WALL BETWEEN THE KERNEL AND THE THINGS THAT COST MONEY.
 *
 * The universal kernel reasons about evidence. It does not know that
 * providers exist, and it must not learn: the moment a provider's name, a
 * provider's request shape or a provider's quirk reaches workers/core-v2, the
 * engine has stopped being universal and has become a client of whoever it
 * names. This file is the check that keeps that from happening quietly.
 *
 * The provider words are held here only as digests. A directory whose whole
 * property is that it names nobody should not name anybody in its own
 * denylist either — and the words are perfectly findable in providers/, which
 * is exactly where they are allowed to be.
 */
import { harness, closeNetwork } from "../../core-v2/tests/harness.mjs";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname, relative } from "node:path";

const tripped = closeNetwork();
const t = harness("the wall between the kernel and the things that cost money");

const ROOT = new URL("../../..", import.meta.url).pathname;
const KERNEL = join(ROOT, "workers/core-v2");
const RUNTIME = join(ROOT, "workers/core-v2-runtime");

const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
};
const rel = (p) => relative(ROOT, p);
const digest = (s) => createHash("sha256").update(s).digest("hex");
const tokensOf = (text) => new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? []);
const list = (xs, n = 6) => (xs.length ? xs.slice(0, n).join(", ") + (xs.length > n ? ` (+${xs.length - n})` : "") : "none");

/* The names of the things that answer, as digests. */
const PROVIDER_WORDS = new Set([
  "c70eca6b0f88f44d81a41311647e50fda1ac454ec04ffd442b0eb4743a993131",
  "7d3194f79e645c42e4396dda38be04766810ec6a00d00aced3ffc2a0a1f1a9ef",
  "5d72436256ada53828b51895a94bb8489e9f1ac4fe937a8024ef1594e7045ff6",
  "c857d09db23e6822e3600bc06ad8d58f92ed62bc8efd81c753f77048662cb97d",
  "60965168ce762e949600281ba6d01fee136e5b6e8257b1f216f9025ed324474c",
  "e1b683e26a3aad218df6aa63afe9cf57fdb5dfaf5eb20cddac14305d67f48a02",
  "2d7f45d7b98b427f824e0c643295583e9cf013faffdb5e7095d070ff85276bf4",
  "920510199770f4d65cb8aaa2cd12bdb2b8c37f5b3907c50a734a0e3409da2823",
  "6f7ac1823da81d2e52d1a1549ee69c85bbf8bb56d06682849e7c09da2785ce3b",
  "bbdefa2950f49882f295b1285d4fa9dec45fc4144bfb07ee6acc68762d12c2e3",
]);

/* Words that name somebody's business rather than a universal idea. Only
   nouns that could not be anything else: "property", "construction" and
   "material" are ordinary English — an object has properties, a guarantee
   holds by construction, an attribute is material — and a list that cannot
   tell those from a domain's vocabulary makes the check unreadable rather
   than strict. */
const DOMAIN_WORDS = new Set(["drawing", "drawings", "blueprint", "takeoff", "contractor",
  "project_documents", "ai_runs", "evidence_items"].map(digest));

/* Client and property names, from the suite that has always held them as
   digests. Nothing in either tree may name one. */
const CLIENT_WORDS = new Set([
  "d3a61c684446b22fbc324502c1ad80e4387f0ed707feec1f1ab81a8b3fc65539",
  "b4c8ac20a87e493a3dd30a6f16094149771660c1ae17fbab1e4adfef86c76091",
  "ad05969625c093458a9e1df667770ccf71a19b58159126854bd4bda44f0fdaba",
  "38ff0b7c7cc0761a20be0eae460c39c3496f7924177abc89b3d37e8e274763aa",
  "204133432486031b0224cfc591ac17d8d6b49d4edef5eb3e9649352340fc79b0",
  "a9d1e780687ac78d0eff2fc993037b1dd95440913ae402eb2acb488ee9eb6c03",
]);

const SELF = rel(new URL(import.meta.url).pathname);
const kernelFiles = walk(KERNEL).filter((p) => [".ts", ".mjs", ".json", ".md", ".sh"].includes(extname(p)));
const runtimeFiles = walk(RUNTIME).filter((p) => [".ts", ".mjs", ".json", ".md", ".sh"].includes(extname(p)));
const text = new Map([...kernelFiles, ...runtimeFiles].map((p) => [rel(p), readFileSync(p, "utf8")]));

t.section("the runtime exists and is a package of its own");
t.check("there is a runtime tree, separate from the engine it drives", runtimeFiles.length > 0, `${runtimeFiles.length} files`);
t.check("nothing but code, tests, fixtures, configuration and prose lives in either tree",
  [...kernelFiles, ...runtimeFiles].every((p) => [".ts", ".mjs", ".json", ".md", ".sh"].includes(extname(p))));

t.section("the kernel does not know that providers exist");
{
  /* Two kernel files hold these words on purpose: they are the guards that
     refuse a role or a packet naming one. A denylist is the opposite of
     coupling, and it is the only reason the engine may spell such a name. */
  const GUARDS = new Set(["workers/core-v2/kernel/roles.ts", "workers/core-v2/kernel/visibility.ts"]);
  const named = [...text].filter(([p]) => p.startsWith("workers/core-v2/"))
    .filter(([, body]) => [...tokensOf(body)].some((tok) => PROVIDER_WORDS.has(digest(tok))))
    .map(([p]) => p);
  t.check("no file of the universal engine names one of the things that answer, beyond the two guards that exist to refuse them",
    named.every((p) => GUARDS.has(p)), list(named.filter((p) => !GUARDS.has(p))));
  t.check("and those two guards still hold such a list — the engine refuses these names rather than having forgotten them",
    [...GUARDS].every((p) => named.includes(p)), list([...GUARDS].filter((p) => !named.includes(p))));
}
{
  const importers = [...text].filter(([p]) => p.startsWith("workers/core-v2/"))
    .filter(([, body]) => /core-v2-runtime/.test(body)).map(([p]) => p);
  t.check("and no file of the universal engine reaches into the runtime — the dependency runs one way only",
    importers.length === 0, list(importers));
}

t.section("the names of the things that answer live in one directory");
{
  const named = [...text].filter(([p]) => p.startsWith("workers/core-v2-runtime/") && p !== SELF)
    .filter(([, body]) => [...tokensOf(body)].some((tok) => PROVIDER_WORDS.has(digest(tok))))
    .map(([p]) => p);
  const allowed = (p) => p.startsWith("workers/core-v2-runtime/providers/")
    || p.startsWith("workers/core-v2-runtime/tests/fixtures/")
    || p.startsWith("workers/core-v2-runtime/tests/");
  const stray = named.filter((p) => !allowed(p));
  t.check("a provider is named only where its protocol is written, in the fixtures that stand in for it, and in the tests that check both",
    stray.length === 0, list(stray));
  t.check("and it is named somewhere — this check is looking at something",
    named.some((p) => p.startsWith("workers/core-v2-runtime/providers/")), list(named));
}

t.section("nothing in either tree names a client, a property or a domain");
{
  const hits = [];
  for (const [p, body] of text) {
    if (p === SELF) continue;
    for (const tok of tokensOf(body)) if (CLIENT_WORDS.has(digest(tok))) hits.push(p);
  }
  t.check("no file of the engine or the runtime names a client or a property", hits.length === 0, list([...new Set(hits)]));
}
{
  const hits = [];
  for (const [p, body] of text) {
    if (p === SELF || !p.startsWith("workers/core-v2-runtime/")) continue;
    for (const tok of tokensOf(body)) if (DOMAIN_WORDS.has(digest(tok))) hits.push(`${p}:${tok.length}`);
  }
  t.check("and the runtime carries no domain's vocabulary — it dispatches work, it does not know what the work is about",
    hits.length === 0, list([...new Set(hits)]));
}

t.section("what the runtime is allowed to import");
{
  const uncommented = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const specifiers = (s) => [...uncommented(s).matchAll(/(?:from\s+|import\s+|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g)].map((m) => m[1]);
  const strays = [];
  const outward = [];
  for (const [p, body] of text) {
    if (!p.startsWith("workers/core-v2-runtime/")) continue;
    for (const spec of specifiers(body)) {
      if (spec.startsWith("node:")) continue;
      if (spec.startsWith(".")) {
        /* Relative, and it must stay inside the runtime or reach the engine
           it drives — never anything else in this repository. */
        const resolved = join(p, "..", spec).replace(/\\/g, "/");
        if (!resolved.startsWith("workers/core-v2-runtime/") && !resolved.startsWith("workers/core-v2/")) outward.push(`${p} → ${spec}`);
        continue;
      }
      strays.push(`${p} → ${spec}`);
    }
  }
  t.check("the runtime imports nothing from outside this repository — no provider library, no transport, no database client",
    strays.length === 0, list(strays));
  t.check("and reaches nowhere in this repository but the engine it drives", outward.length === 0, list(outward));
}

t.section("the door out is shut unless somebody opens it");
{
  const { SealedTransport, NetworkNotAuthorized } = await import("../transport/transport.ts");
  const sealed = new SealedTransport();
  let refused = null;
  try {
    await sealed.send({ method: "POST", url: "https://example.invalid/v1/anything", headers: {}, body: "{}", timeoutMs: 1 });
  } catch (error) { refused = error; }
  t.check("the transport a runtime gets by default refuses to send anything",
    refused instanceof NetworkNotAuthorized, refused ? String(refused.message).slice(0, 80) : "it was allowed");
  t.check("and it says what it refused, without a body or a header in the message",
    refused !== null && !/authorization|api[_-]?key/i.test(String(refused.message)));
}

t.section("no paid call is authorised by default");
{
  const { NO_PAID_CALLS, paidCallRefusals } = await import("../runtime-config.ts");
  const config = { providers: [], pricing: [], authorization: NO_PAID_CALLS, dispatcherName: "test" };
  const refusals = paidCallRefusals(config);
  t.check("a runtime built from the default authorization refuses a paid call", refusals.length > 0, `${refusals.length} reasons`);
  t.check("and it gives every reason at once rather than the first — four gates, four sentences",
    refusals.length >= 4, list(refusals, 4));
  for (const [name, over] of [
    ["the command-line flag", { providerNetworkFlag: true }],
    ["the environment gate", { environmentGate: true }],
    ["an authorised amount above zero", { maximumAuthorizedCost: 1 }],
    ["an allowlist of providers and models", { providerAllowlist: ["p"], modelAllowlist: ["m"] }],
  ]) {
    const partial = { ...config, authorization: { ...NO_PAID_CALLS, ...over } };
    t.check(`${name} alone does not authorise anything`, paidCallRefusals(partial).length > 0);
  }
  const all = { ...config, authorization: { ...NO_PAID_CALLS, providerNetworkFlag: true, environmentGate: true, maximumAuthorizedCost: 1, providerAllowlist: ["p"], modelAllowlist: ["m"] } };
  t.check("all four together, and only then, leave nothing refusing", paidCallRefusals(all).length === 0, list(paidCallRefusals(all)));
}

t.section("every door stayed closed");
t.check("nothing in this file tried the network", tripped() === 0, `${tripped()} attempts`);

t.finish();
