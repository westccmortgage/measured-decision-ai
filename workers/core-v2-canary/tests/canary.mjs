/* THE CANARY, WHICH HAS NOT RUN, AND EVERY LOCK ON THE DOOR IT WOULD USE.
 *
 * A paid run needs facts this repository is not entitled to invent — model
 * ids, addresses, capabilities and prices — and a key it is not entitled to
 * read. This suite checks the two halves of that: that the loader refuses
 * every shape of missing or invented declaration rather than filling a
 * default in, and that preflight can say all of it without touching a key,
 * opening a socket or building a transport.
 *
 * The declarations below are fixtures. Their model names are not any
 * provider's model names and their rates are not anybody's rates: what is
 * under test is the refusing, not the catalogue.
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harness, closeNetwork } from "../../core-v2/tests/harness.mjs";
import {
  CANARY_AUTHORIZED, CANARY_ID, CANARY_MAXIMUM_SUBMISSIONS, loadOperatorRegistry,
} from "../operator-registry.ts";
import { authorizedConfig, parseArgs, preflight, worstCase } from "../canary.ts";
import { createHttpsTransport } from "../../core-v2-runtime/transport/https.ts";
import { NetworkNotAuthorized } from "../../core-v2-runtime/transport/transport.ts";
import { networkAuthorizationProblems } from "../../core-v2-runtime/runtime-config.ts";
import { ceilingFor } from "../../core-v2-runtime/budget/ledger.ts";

const tripped = closeNetwork();
const t = harness("the canary that has not run, and every lock on its door");

const CAPABLE = { forcedToolChoice: true, strictSchema: true, images: false, thinking: "none" };

/* One declaration that passes every check, built here so each test can bend
   exactly one thing about it. */
function completeDeclaration() {
  const provider = (id, host, model, variable) => ({
    providerId: id,
    baseUrl: `https://${host}`,
    apiKeyEnvironmentVariable: variable,
    models: [model],
    defaultModel: model,
    maximumInputTokens: 60_000,
    maximumOutputTokens: 4_096,
    requestTimeoutMs: 30_000,
    maximumMaterialBytes: 512 * 1024,
    maximumMaterialBytesPerItem: 256 * 1024,
    supportedMediaTypes: ["text/plain; charset=utf-8"],
    capabilities: { [model]: { ...CAPABLE } },
  });
  const price = (id, model) => ({
    providerId: id, model, effectiveFrom: "2026-01-01", currency: "USD",
    inputPerMillionTokens: 1, outputPerMillionTokens: 5, cacheWritePerMillionTokens: 1.25,
  });
  return {
    declaredBy: "an operator under test",
    declaredAt: "2026-09-09",
    providers: [
      provider("anthropic", "alpha.operator-under-test.net", "operator-model-a", "OPERATOR_KEY_A"),
      provider("openai", "beta.operator-under-test.net", "operator-model-b", "OPERATOR_KEY_B"),
      provider("google", "gamma.operator-under-test.net", "operator-model-c", "OPERATOR_KEY_C"),
    ],
    pricing: [price("anthropic", "operator-model-a"), price("openai", "operator-model-b"), price("google", "operator-model-c")],
    roles: { readerA: "anthropic", readerB: "openai", critic: "google" },
    routing: {
      "reader-family-one": "anthropic",
      "reader-family-two": "openai",
      "critic-family-one": "google",
      "arbiter-family-one": "google",
    },
  };
}

const load = (declaration) => loadOperatorRegistry(JSON.stringify(declaration), "under-test.json");
const bend = (change) => { const d = completeDeclaration(); change(d); return load(d); };
const says = (problems, fragment) => problems.some((p) => p.includes(fragment));

/* ───────────────────────────────────── the declaration this file cannot write */
t.section("the registry is the operator's, and nothing fills it in");

{
  const complete = load(completeDeclaration());
  t.check("a complete declaration loads", complete.registry !== null, complete.problems.join(" · ").slice(0, 160));
  t.check("and the loader opens no authorization at all",
    complete.registry?.config.authorization.maximumAuthorizedCost === 0
    && complete.registry?.config.authorization.providerNetworkFlag === false
    && complete.registry?.config.authorization.environmentGate === false
    && complete.registry?.config.authorization.providerAllowlist.length === 0);
  t.check("it carries who declared these prices, and when",
    complete.registry?.declaredBy === "an operator under test" && complete.registry?.declaredAt === "2026-09-09");
}

{
  const shipped = readFileSync(new URL("../registry.example.json", import.meta.url), "utf8");
  const blank = loadOperatorRegistry(shipped, "registry.example.json");
  t.check("the template this repository ships is refused until a person fills it in", blank.registry === null);
  t.check("and it names the cache-write rate as one of the missing facts",
    says(blank.problems, "cacheWritePerMillionTokens missing"));
  t.check("and it names the addresses, the key variables and the token ceilings",
    says(blank.problems, "no baseUrl") && says(blank.problems, "does not say which environment variable holds its key")
    && says(blank.problems, "maximumInputTokens must be a number above zero"));
  t.check("and it names nobody: the template ships no provider id, no model and no rate",
    says(blank.problems, "no providerId")
    && !/anthropic|openai|google/i.test(shipped));
}

t.check("an address that resolves nowhere by standard is refused as the invented one",
  says(bend((d) => { d.providers[0].baseUrl = "https://alpha.invalid"; }).problems, "resolves nowhere"));
t.check("so is a plain-http address",
  says(bend((d) => { d.providers[0].baseUrl = "http://alpha.operator-under-test.net"; }).problems, "must be https"));
t.check("so is the demonstration's own key variable, which holds no key",
  says(bend((d) => { d.providers[0].apiKeyEnvironmentVariable = "CORE_V2_DEMONSTRATION_KEY_ALPHA"; }).problems, "holds no key"));
t.check("a provider no adapter in this repository speaks to is refused",
  says(bend((d) => { d.providers[0].providerId = "some-other-provider"; }).problems, "no adapter in this repository speaks to"));
t.check("two readers behind one provider is refused as one opinion",
  says(bend((d) => { d.roles.readerB = "anthropic"; }).problems, "different providers"));
t.check("a model with no price is refused",
  says(bend((d) => { d.pricing = d.pricing.slice(1); }).problems, "has no price"));
t.check("a model with no declared capabilities is refused rather than guessed at",
  says(bend((d) => { d.providers[0].capabilities = {}; }).problems, "no capabilities declared"));
t.check("a price with no date is refused",
  says(bend((d) => { d.pricing[0].effectiveFrom = ""; }).problems, "not evidence about this run"));
t.check("a price in another currency is refused",
  says(bend((d) => { d.pricing[0].currency = "EUR"; }).problems, "currency must be USD"));
t.check("nobody may declare these facts anonymously",
  says(bend((d) => { d.declaredBy = "  "; }).problems, "must be named"));

/* ─────────────────────────────────────────────── a cache write is not free */
t.section("an unknown cache-write rate is not a ceiling");

{
  const missing = bend((d) => { delete d.pricing[1].cacheWritePerMillionTokens; });
  t.check("a price with no cache-write rate is refused", missing.registry === null);
  t.check("and the reason names the reservation, not the settlement",
    says(missing.problems, "no ceiling, no reservation and nothing may be sent"));
}

/* ───────────────────────────────────────────────────────────── the money */
t.section("what a whole canary could cost, at the worst price declared");

{
  const { registry } = load(completeDeclaration());
  const worst = worstCase(registry.config);
  const perProvider = registry.config.providers.map((p) => ceilingFor(registry.config, p.providerId, p.defaultModel, new Date()).maximumCost);
  t.check("the worst attempt is the ledger's own ceiling, not a second arithmetic",
    Math.abs(worst.perAttempt - Math.max(...perProvider)) < 1e-9,
    `worst ${worst.perAttempt} · ledger ${Math.max(...perProvider)}`);
  t.check("the ceiling is priced at the cache-write rate where that is the dearest input rate",
    Math.abs(worst.perAttempt - ((60_000 / 1e6) * 1.25 + (4_096 / 1e6) * 5)) < 1e-9, String(worst.perAttempt));
  t.check(`the whole canary is that attempt taken ${CANARY_MAXIMUM_SUBMISSIONS} times`,
    Math.abs(worst.wholeCanary - worst.perAttempt * CANARY_MAXIMUM_SUBMISSIONS) < 1e-9);
  t.check("and it fits inside the authority", worst.fits && worst.wholeCanary <= CANARY_AUTHORIZED);
}

{
  const tooBig = completeDeclaration();
  for (const p of tooBig.providers) p.maximumInputTokens = 10_000_000;
  const { registry } = load(tooBig);
  const worst = worstCase(registry.config);
  t.check("a token ceiling that would not fit inside $5 does not fit", !worst.fits, `${worst.wholeCanary}`);

  /* And preflight says it, from the file, before anything is opened. */
  const path = join(tmpdir(), `core-v2-canary-too-big-${process.pid}.json`);
  writeFileSync(path, JSON.stringify(tooBig));
  try {
    const said = preflight(parseArgs(["--preflight", "--registry", path]), {});
    t.check("and preflight refuses on the arithmetic rather than finding out afterwards",
      says(said.refusals, "the arithmetic does not fit") && says(said.refusals, "above the $5.00000 authorised"),
      said.refusals.join(" · ").slice(0, 140));
  } finally { rmSync(path, { force: true }); }
}

/* ─────────────────────────────────────────────────────── preflight itself */
t.section("preflight reads no key, opens nothing and writes nothing");

{
  const bare = preflight(parseArgs(["--preflight"]), {});
  t.check("with nothing supplied it refuses, and names the missing registry first",
    bare.registry === null && bare.refusals[0].includes("no --registry"));
  t.check("it names the network flag, the environment gate and the organisation",
    says(bare.refusals, "--allow-provider-network") && says(bare.refusals, "CORE_V2_ALLOW_PAID_CALLS")
    && says(bare.refusals, "CORE_V2_CANARY_ORGANIZATION"));
}

{
  /* An environment that remembers every name anybody asked it for. */
  const asked = [];
  const watched = new Proxy({ CORE_V2_ALLOW_PAID_CALLS: "true", CORE_V2_CANARY_ORGANIZATION: "an-organisation" }, {
    get(target, name) { if (typeof name === "string") asked.push(name); return target[name]; },
  });
  const args = { ...parseArgs(["--preflight", "--allow-provider-network"]), registry: undefined };
  preflight(args, watched);
  const keyVariables = ["OPERATOR_KEY_A", "OPERATOR_KEY_B", "OPERATOR_KEY_C", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY"];
  t.check("preflight asks the environment for the gates and for nothing that could hold a key",
    keyVariables.every((name) => !asked.includes(name)), `asked for: ${asked.join(", ")}`);
}

{
  const args = parseArgs(["--execute", "--allow-provider-network", "--database", "d", "--user", "u"]);
  const said = preflight(args, { CORE_V2_ALLOW_PAID_CALLS: "true", CORE_V2_CANARY_ORGANIZATION: "an-organisation" });
  t.check("--execute with no record to write to refuses before it connects to anything",
    says(said.refusals, "There is no host flag"));
}

{
  const said = preflight(parseArgs(["--execute", "--socket", "relative/path", "--database", "d", "--user", "u"]), {});
  t.check("and a socket that is not a path on this machine is refused",
    says(said.refusals, "--socket must be a path on this machine"));
}

/* ────────────────────────────── the door, built here and nowhere in the package */
t.section("the door out is built outside the sealed package, and only when every gate is open");

{
  const { registry } = load(completeDeclaration());
  const open = { CORE_V2_ALLOW_PAID_CALLS: "true", CORE_V2_CANARY_ORGANIZATION: "an-organisation" };
  const withFlag = parseArgs(["--execute", "--allow-provider-network"]);

  const authorized = authorizedConfig(registry, withFlag, open);
  t.check("the authority the canary assembles is the constant, never the declaration's own number",
    authorized.authorization.maximumAuthorizedCost === CANARY_AUTHORIZED && authorized.authorization.currency === "USD");
  t.check("and its allowlists are exactly what was declared, never a wildcard",
    authorized.authorization.providerAllowlist.length === 3 && authorized.authorization.modelAllowlist.length === 3);
  t.check("with every gate open the runtime finds nothing to refuse",
    networkAuthorizationProblems(authorized).length === 0, networkAuthorizationProblems(authorized).join(" · "));

  /* Built with both seams replaced, so this suite opens nothing. */
  const transport = createHttpsTransport({
    config: authorized,
    openRequest: () => { throw new Error("this suite sends nothing"); },
    lookup: async () => { throw new Error("this suite resolves nothing"); },
  });
  t.check("the transport may reach the three declared origins and nowhere else",
    transport.allowedOrigins.join(", ") === [
      "https://alpha.operator-under-test.net:443",
      "https://beta.operator-under-test.net:443",
      "https://gamma.operator-under-test.net:443",
    ].join(", "), transport.allowedOrigins.join(", "));

  for (const [what, args_, env] of [
    ["without --allow-provider-network", parseArgs(["--execute"]), open],
    ["without the environment gate", withFlag, { CORE_V2_CANARY_ORGANIZATION: "an-organisation" }],
  ]) {
    let refused = null;
    try {
      createHttpsTransport({ config: authorizedConfig(registry, args_, env), openRequest: () => { throw new Error("no"); }, lookup: async () => { throw new Error("no"); } });
    } catch (error) { refused = error; }
    t.check(`a transport ${what} refuses to exist at all`, refused instanceof NetworkNotAuthorized,
      refused ? String(refused.message).slice(0, 70) : "it was built");
  }
}

t.check("the canary's identity and its authority are constants, not flags",
  CANARY_ID === "core-v2-canary-1" && CANARY_AUTHORIZED === 5 && CANARY_MAXIMUM_SUBMISSIONS === 4);

t.check("nothing in this suite tried to open a socket", tripped() === 0, `guard tripped ${tripped()} times`);

t.finish();
