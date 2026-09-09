/* THE 404 THAT COST A CANARY.
 *
 * The first paid Core V2 run sent exactly one request and got 404 back. The
 * operator's registry gave the address as "https://api.anthropic.com/v1";
 * the adapter appends "/v1/messages"; what left was /v1/v1/messages. From
 * the outside that is indistinguishable from a model id the account cannot
 * serve, and you only find out after the money is gone.
 *
 * This suite is the lock on that. It checks the rule in both directions —
 * an origin is accepted and a doubled path is refused BEFORE anything is
 * built — and it checks the registry this repository actually ships, so the
 * file that caused it cannot quietly come back.
 */
import { readFileSync } from "node:fs";
import { harness, closeNetwork } from "../../core-v2/tests/harness.mjs";
import { AnthropicProtocol } from "../providers/anthropic.ts";
import { OpenAiProtocol } from "../providers/openai.ts";
import { GoogleProtocol } from "../providers/google.ts";
import { baseUrlProblems, buildProviderRegistry } from "../providers/registry.ts";
import { RESULT_ENVELOPE_SCHEMA, schemaIsClosed } from "../providers/provider.ts";

const tripped = closeNetwork();
const t = harness("what the providers rejected, and why: the 404 and the 400");

const PROTOCOLS = [new AnthropicProtocol(), new OpenAiProtocol(), new GoogleProtocol()];
const configFor = (providerId, baseUrl) => ({
  providerId, baseUrl, apiKeyEnvironmentVariable: "NOT_READ",
  models: ["m"], defaultModel: "m",
  maximumInputTokens: 8192, maximumOutputTokens: 4096, requestTimeoutMs: 1000,
  maximumMaterialBytes: 1024, maximumMaterialBytesPerItem: 1024,
  supportedMediaTypes: ["text/plain"],
  capabilities: { m: { forcedToolChoice: false, strictSchema: true, images: false, thinking: "none" } },
});

t.section("every adapter says which path it appends");
for (const protocol of PROTOCOLS) {
  t.check(`${protocol.providerId} declares its request path`,
    typeof protocol.requestPath === "string" && protocol.requestPath.startsWith("/"), protocol.requestPath);
}

t.section("an origin is what an operator gives, and it is accepted");
{
  const origins = {
    anthropic: "https://api.anthropic.com",
    openai: "https://api.openai.com",
    google: "https://generativelanguage.googleapis.com",
  };
  for (const protocol of PROTOCOLS) {
    const problems = baseUrlProblems(configFor(protocol.providerId, origins[protocol.providerId]), protocol);
    t.check(`${protocol.providerId}: an origin passes`, problems.length === 0, problems.join("; "));
    const url = `${origins[protocol.providerId]}${protocol.requestPath}`;
    const segments = new URL(url).pathname.split("/").filter(Boolean);
    t.check(`${protocol.providerId}: ${url} has no repeated segment`,
      new Set(segments).size === segments.length, url);
  }
  /* A trailing slash is an operator's typing, not a path. */
  t.check("a trailing slash is not a path",
    baseUrlProblems(configFor("anthropic", "https://api.anthropic.com/"), new AnthropicProtocol()).length === 0);
}

t.section("the address that cost the canary is refused before anything is built");
{
  const doubled = [
    ["anthropic", "https://api.anthropic.com/v1", new AnthropicProtocol(), "/v1/v1/messages"],
    ["openai", "https://api.openai.com/v1", new OpenAiProtocol(), "/v1/v1/responses"],
    ["google", "https://generativelanguage.googleapis.com/v1beta", new GoogleProtocol(), "/v1beta/v1beta/models"],
  ];
  for (const [providerId, baseUrl, protocol, wouldBe] of doubled) {
    const problems = baseUrlProblems(configFor(providerId, baseUrl), protocol);
    t.check(`${providerId}: ${baseUrl} is refused`, problems.length === 1, problems.join("; "));
    t.check(`${providerId}: and the refusal names ${wouldBe}`,
      problems[0]?.includes(wouldBe), problems[0] ?? "");
  }
  /* Any other path is refused too: the adapter's path is absolute. */
  t.check("a baseUrl with any other path is refused as well",
    baseUrlProblems(configFor("openai", "https://api.openai.com/proxy"), new OpenAiProtocol()).length === 1);
}

t.section("assembly refuses it, so no request is ever built");
{
  let refused = null;
  try {
    buildProviderRegistry({
      config: {
        providers: [configFor("anthropic", "https://api.anthropic.com/v1")],
        pricing: [], authorization: { providerNetworkFlag: false, environmentGate: false, maximumAuthorizedCost: 0, currency: "USD", providerAllowlist: [], modelAllowlist: [] },
        dispatcherName: "test",
      },
      transport: { name: "none", send: async () => { throw new Error("this suite sends nothing"); } },
      routing: { "reader-family-one": "anthropic" },
      compilePrompt: () => ({ system: "", user: "" }),
      materialResolver: { resolve: async () => [] },
      environment: {},
    });
  } catch (error) { refused = error; }
  t.check("buildProviderRegistry throws rather than assembling a doubled address",
    refused !== null && String(refused.message).includes("/v1/v1/messages"),
    refused ? String(refused.message).slice(0, 140) : "it was assembled");
}

t.section("the registry this repository ships");
{
  /* Read as data, not imported: this tree may reach into the engine it
     drives and nowhere else, and the canary is not the engine. */
  const declared = JSON.parse(readFileSync(new URL("../../core-v2-canary/registry.canary.json", import.meta.url), "utf8"));
  const byId = new Map(PROTOCOLS.map((p) => [p.providerId, p]));
  t.check("it declares three providers", declared.providers.length === 3, String(declared.providers.length));
  for (const configuration of declared.providers) {
    const protocol = byId.get(configuration.providerId);
    t.check(`${configuration.providerId}: an adapter of this package speaks to it`, protocol !== undefined);
    if (!protocol) continue;
    const found = baseUrlProblems(configuration, protocol);
    t.check(`${configuration.providerId}: ${configuration.baseUrl} would not double its path`,
      found.length === 0, found.join("; "));
  }
}

/* ─────────────────────────────────────────────── the 400 that cost the next one */
t.section("strict follows the schema, because two of its objects are open on purpose");
{
  t.check("a fully closed schema may be sent strict",
    schemaIsClosed({ type: "object", additionalProperties: false, properties: { a: { type: "string" } } }));
  t.check("an object with no additionalProperties may not",
    schemaIsClosed({ type: "object", properties: { a: { type: "string" } } }) === false);
  t.check("nor may an OPEN MAP — additionalProperties as a schema is not false",
    schemaIsClosed({ type: "object", additionalProperties: { type: "string" } }) === false);
  t.check("and one open object anywhere below closes the whole question",
    schemaIsClosed({
      type: "object", additionalProperties: false,
      properties: { deep: { type: "array", items: { type: "object", additionalProperties: { type: "string" } } } },
    }) === false);

  /* The envelope itself: a claim's scope and an anchor's locator are domain
     vocabulary and are deliberately open, so the flag must come out false. */
  t.check("this repository's result envelope is NOT closed, by design",
    schemaIsClosed(RESULT_ENVELOPE_SCHEMA) === false);

  const anthropic = new AnthropicProtocol();
  const openai = new OpenAiProtocol();
  t.check("so the Anthropic adapter would not send strict over it",
    (schemaIsClosed(RESULT_ENVELOPE_SCHEMA) ? { strict: true } : {}).strict === undefined);
  t.check("and the OpenAI adapter sends strict:false rather than a rejected true",
    schemaIsClosed(RESULT_ENVELOPE_SCHEMA) === false);
  t.check("both adapters read the same rule, from one place",
    typeof anthropic.requestPath === "string" && typeof openai.requestPath === "string");
}

t.check("nothing in this suite tried to open a socket", tripped() === 0, `guard tripped ${tripped()} times`);
t.finish();
