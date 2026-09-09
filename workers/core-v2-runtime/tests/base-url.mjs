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
import { envelopeText, RESULT_ENVELOPE_SCHEMA, schemaIsClosed } from "../providers/provider.ts";

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

  /* And the envelope this repository ships IS closed — because the two open
     maps are spelled to a provider as key/value pairs, which can be closed,
     and turned back into maps by the adapter. That is what lets strict come
     back on, and strict is what makes `required` binding rather than
     advisory. A canary generation paid to learn the difference: with the
     schema unstrict the model returned an envelope with no `outcome`. */
  t.check("this repository's result envelope is closed, so strict is available",
    schemaIsClosed(RESULT_ENVELOPE_SCHEMA) === true);
  t.check("and every field the engine needs is required, not merely offered",
    ["outcome", "claims", "segments", "anchors", "assessments", "limitations"]
      .every((field) => RESULT_ENVELOPE_SCHEMA.required.includes(field)),
    JSON.stringify(RESULT_ENVELOPE_SCHEMA.required));

  /* The round trip: pairs on the wire, a map in the engine. */
  const roundTripped = JSON.parse(envelopeText({
    outcome: "completed",
    claims: [{ scope: [{ key: "sheet", value: "1" }, { key: "row", value: "7" }] }],
    anchors: [{ locator: [{ key: "bbox", value: "0,0,1,1" }] }],
    segments: [{ locator: [] }],
  }));
  t.check("pairs on the wire come back as the map the kernel reads",
    roundTripped.claims[0].scope.sheet === "1" && roundTripped.claims[0].scope.row === "7"
    && roundTripped.anchors[0].locator.bbox === "0,0,1,1",
    JSON.stringify(roundTripped));
  t.check("an empty list is an empty map, not a missing one",
    JSON.stringify(roundTripped.segments[0].locator) === "{}");

  /* A locator's box is four numbers, not the text of four numbers. A canary
     generation returned "0.05,0.1,0.95,0.6" and the kernel refused it as a
     box that is not normalised 0..1 — correctly. A value written as JSON is
     read as JSON; anything else stays the text it is. */
  const asJson = JSON.parse(envelopeText({
    segments: [{ locator: "{\"bbox\":[0.05,0.1,0.95,0.6],\"label\":\"table 1\",\"page\":\"1\"}" }],
  })).segments[0].locator;
  t.check("a locator written as one JSON object comes back as the map the kernel reads",
    Array.isArray(asJson.bbox) && asJson.bbox[0] === 0.05 && asJson.label === "table 1" && asJson.page === "1",
    JSON.stringify(asJson));
  t.check("and a map that is not a map is an empty map, not a crash",
    JSON.stringify(JSON.parse(envelopeText({ segments: [{ locator: "I did not fill this in" }] })).segments[0].locator) === "{}");

  /* THE PAIR FORM IS STILL UNDERSTOOD. An earlier schema asked for it, and a
     provider that answers in it is not wrong enough to throw a reading away
     over — the map it means is unambiguous either way. */
  const typed = JSON.parse(envelopeText({
    segments: [{ locator: [
      { key: "bbox", value: "[0.05,0.1,0.95,0.6]" },
      { key: "cell", value: "{\"row\":7}" },
      { key: "label", value: "table 1" },
      { key: "page", value: "1" },
      { key: "flag", value: "true" },
    ] }],
  })).segments[0].locator;
  t.check("a list written as JSON inside a pair comes back as a list of numbers",
    Array.isArray(typed.bbox) && typed.bbox.length === 4 && typed.bbox[0] === 0.05, JSON.stringify(typed.bbox));
  t.check("an object written as JSON comes back as an object",
    typed.cell && typed.cell.row === 7, JSON.stringify(typed.cell));
  t.check("but a label stays a label, and \"1\" and \"true\" stay text",
    typed.label === "table 1" && typed.page === "1" && typed.flag === "true",
    JSON.stringify({ label: typed.label, page: typed.page, flag: typed.flag }));
  t.check("and text that only looks like the start of JSON is not lost",
    JSON.parse(envelopeText({ claims: [{ scope: [{ key: "note", value: "[unclosed" }] }] })).claims[0].scope.note === "[unclosed");
  t.check("a provider that sent a map anyway is not an error",
    JSON.parse(envelopeText({ claims: [{ scope: { a: "b" } }] })).claims[0].scope.a === "b");
  t.check("and text that is not an envelope is passed through untouched",
    envelopeText("I will not answer that") === "I will not answer that");
}

t.section("a field a domain requires is a field a provider can write");
{
  /* The kernel's ClaimValue has always carried `attributes`, and a pack may
     refuse a claim that has none. The wire schema closed `value` around
     three fields, so no provider could produce one — invisible offline,
     where the stand-in returns an object and never meets this schema. A
     paid reader read a whole table correctly and was failed three times for
     not naming a category it had no field to name. */
  const claimValue = RESULT_ENVELOPE_SCHEMA.properties.claims.items.properties.value;
  t.check("value declares attributes", claimValue.properties.attributes !== undefined);
  t.check("and requires it, because strict admits no optional field",
    claimValue.required.includes("attributes"), claimValue.required.join(","));
  t.check("and it is a string, the cheapest node a compiled grammar has",
    claimValue.properties.attributes.type === "string", String(claimValue.properties.attributes.type));
  t.check("the whole envelope is still closed enough for strict",
    schemaIsClosed(RESULT_ENVELOPE_SCHEMA) === true);

  /* AND EVERY OPEN MAP STAYS A STRING. Strict is constrained decoding: the
     schema becomes a grammar, and an array of objects is an expensive node
     in one. Four of them inside this envelope is over Anthropic's line —
     "The compiled grammar is too large", 400 in 481 ms, on
     req_011CetcvK1sHAcZCEv8T2WkP. This is the check that stops the next
     open map being added back as a list of pairs. */
  const openMapSites = [
    ["claim scope", RESULT_ENVELOPE_SCHEMA.properties.claims.items.properties.scope],
    ["claim value attributes", claimValue.properties.attributes],
    ["anchor locator", RESULT_ENVELOPE_SCHEMA.properties.anchors.items.properties.locator],
    ["segment locator", RESULT_ENVELOPE_SCHEMA.properties.segments.items.properties.locator],
  ];
  for (const [where, node] of openMapSites) {
    t.check(`${where} is one string, not a list of pairs`, node !== undefined && node.type === "string",
      node === undefined ? "missing" : String(node.type));
  }

  const read = JSON.parse(envelopeText({
    claims: [{
      claimKey: "E-001", subjectKey: "entry/E-001", predicate: "quantity",
      value: { known: true, quantity: 25, text: null, attributes: "{\"category\":\"alpha\"}" },
      scope: "{\"sheet\":\"0\"}",
    }],
  })).claims[0];
  t.check("and the claim's scope comes back the same way",
    read.scope.sheet === "0", JSON.stringify(read.scope));
  t.check("attributes come back as the map the kernel reads",
    read.value.attributes.category === "alpha", JSON.stringify(read.value.attributes));
  t.check("and the value's own fields are untouched beside it",
    read.value.known === true && read.value.quantity === 25 && read.value.text === null);
  t.check("a claim whose value carries no attributes is still a claim",
    JSON.parse(envelopeText({ claims: [{ value: { known: false, quantity: null, text: null } }] }))
      .claims[0].value.attributes.category === undefined);
}

t.section("the shared schema, spoken in each provider's dialect");
{
  /* Google's responseSchema is a protobuf message, not JSON Schema: `type` is
     a single enum there, so a union is rejected — "Proto field is not
     repeating, cannot start list", 400 in 83 ms, which is what both of this
     canary's Google calls got. */
  const built = new GoogleProtocol().buildRequest({
    model: "gemini-3.1-pro-preview", maximumOutputTokens: 4096, timeoutMs: 1000,
    apiKey: "not-a-key", configuration: { baseUrl: "https://generativelanguage.googleapis.com" },
    prompt: { system: "s", user: "u" }, material: [], expectedOutputContract: "c",
  });
  const sent = JSON.parse(built.body);
  const schema = sent.generationConfig.responseSchema;
  const unions = [];
  const nullables = [];
  const additional = [];
  const walk = (node, path) => {
    if (Array.isArray(node)) { node.forEach((n, i) => walk(n, `${path}[${i}]`)); return; }
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node.type)) unions.push(path);
    if (node.nullable === true) nullables.push(path);
    if ("additionalProperties" in node) additional.push(path);
    for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`);
  };
  walk(schema, "$");
  t.check("no type is written as a list, because the field does not repeat",
    unions.length === 0, unions.join(" "));
  t.check("the nullable fields are nullable with a flag instead",
    nullables.length >= 3, `${nullables.length}: ${nullables.slice(0, 3).join(" ")}`);
  t.check("and additionalProperties, which that message has no field for, is gone",
    additional.length === 0, additional.join(" "));
  t.check("a claim's quantity is still a number that may be absent",
    schema.properties.claims.items.properties.value.properties.quantity.type === "number"
    && schema.properties.claims.items.properties.value.properties.quantity.nullable === true,
    JSON.stringify(schema.properties.claims.items.properties.value.properties.quantity));
}

t.check("nothing in this suite tried to open a socket", tripped() === 0, `guard tripped ${tripped()} times`);
t.finish();
