/* ONE SUITE, THREE PROVIDERS, THE SAME PROMISES.
 *
 * Every rule in this file is run against all three adapters, through a
 * transport that answers from a file. Nothing here mocks an adapter: the
 * adapter is the thing under test, and what it is held to is what it puts on
 * the wire and what it makes of what comes back.
 *
 * The promises:
 *   · one question, freshly asked, with no history and nothing of the last
 *     call or of any other reader in it;
 *   · the strict shape is the only shape asked for;
 *   · the model asked for came from configuration and is on the allowlist;
 *   · the key is in the request and in nothing else that anyone can read;
 *   · the envelope that comes back is well formed;
 *   · the facts are reported — the identifier, the model that ANSWERED
 *     rather than the one asked for, the counts, the duration, the reason it
 *     stopped, and the answer exactly as it arrived.
 *
 * The fixtures are invented. Nothing in this repository has ever asked
 * anybody anything, and the network is sealed before the first line runs.
 */
import { readFileSync } from "node:fs";
import { harness, closeNetwork } from "../../core-v2/tests/harness.mjs";
import { sha256Bytes } from "../../core-v2/kernel/ids.ts";
import { InMemoryMaterialResolver } from "../material/memory-resolver.ts";
import { normalizeUsage } from "../providers/usage-dialects.ts";
import { FixtureTransport, jsonResponse } from "../transport/fixture.ts";
import { SealedTransport } from "../transport/transport.ts";
import { failureCode, ProviderExecutor } from "../providers/provider.ts";
import { AnthropicProtocol } from "../providers/anthropic.ts";
import { OpenAiProtocol } from "../providers/openai.ts";
import { GoogleProtocol } from "../providers/google.ts";
import { buildProviderRegistry, READER_FAMILIES, routeFamiliesToProviders } from "../providers/registry.ts";

const tripped = closeNetwork();
const t = harness("three adapters, one contract: what goes on the wire and what comes back");

/* ────────────────────────────────────────────────────────── the setup */

const load = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));

/* Not a credential. A string of the right sort of shape, invented here, so
   that "is the key in the request" and "is the key anywhere else" are both
   questions a test can answer without a key existing. */
const KEY = "synthetic-not-a-credential-0123456789";

const PROVIDERS = [
  {
    providerId: "anthropic",
    fixtures: load("anthropic"),
    environmentVariable: "CORE_V2_TEST_KEY_ALPHA",
    baseUrl: "https://alpha.provider.invalid",
    urlContains: "/v1/messages",
    keyHeader: "x-api-key",
    keyValue: (headers) => headers["x-api-key"],
    /* Every part of the one turn, in this provider's own shape. */
    partsOf: (body) => body.messages[0].content.map((block) => (block.type === "image"
      ? { kind: "image", mimeType: block.source.media_type, base64: block.source.data }
      : { kind: "text", text: block.text })),
    strictDeclared: (body) => body.tools?.[0]?.strict === true,
    /* input_tokens excludes both cache figures here, so the three add. */
    inputTotalOf: (u) => u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
    /* thinking is billed inside output_tokens, so there is nothing to add. */
    outputTotalOf: (u) => u.output_tokens,
    protocol: () => new AnthropicProtocol(),
    turns: (body) => body.messages,
    systemText: (body) => body.system,
    modelAsked: (body) => body.model,
    strictShape: (body) => body.tool_choice?.type === "tool"
      && body.tool_choice?.name === "result_envelope"
      && body.tools?.length === 1
      && body.tools[0].name === "result_envelope"
      && Array.isArray(body.tools[0].input_schema?.required)
      && body.tools[0].input_schema.required.includes("outcome"),
    notStreamed: (body) => body.stream === false,
    ceiling: (body) => body.max_tokens,
  },
  {
    providerId: "openai",
    fixtures: load("openai"),
    environmentVariable: "CORE_V2_TEST_KEY_BETA",
    baseUrl: "https://beta.provider.invalid",
    urlContains: "/v1/responses",
    keyHeader: "authorization",
    keyValue: (headers) => headers.authorization,
    partsOf: (body) => body.input[0].content.map((part) => {
      if (part.type !== "input_image") return { kind: "text", text: part.text };
      const [, mimeType, base64] = part.image_url.match(/^data:([^;]+);base64,(.*)$/);
      return { kind: "image", mimeType, base64 };
    }),
    strictDeclared: (body) => body.text?.format?.strict === true,
    /* cached is inside input_tokens and reasoning is inside output_tokens. */
    inputTotalOf: (u) => u.input_tokens,
    outputTotalOf: (u) => u.output_tokens,
    protocol: () => new OpenAiProtocol(),
    turns: (body) => body.input,
    systemText: (body) => body.instructions,
    modelAsked: (body) => body.model,
    strictShape: (body) => body.text?.format?.type === "json_schema"
      && body.text.format.strict === true
      && body.text.format.name === "result_envelope"
      && Array.isArray(body.text.format.schema?.required)
      && body.text.format.schema.required.includes("outcome"),
    notStreamed: (body) => body.stream === false && body.store === false,
    ceiling: (body) => body.max_output_tokens,
  },
  {
    providerId: "google",
    fixtures: load("google"),
    environmentVariable: "CORE_V2_TEST_KEY_GAMMA",
    baseUrl: "https://gamma.provider.invalid",
    urlContains: ":generateContent",
    /* This provider's OWN documented header for an API key. Not an
       Authorization bearer: an API key is not an OAuth token. */
    keyHeader: "x-goog-api-key",
    keyValue: (headers) => headers["x-goog-api-key"],
    partsOf: (body) => body.contents[0].parts.map((part) => (part.inlineData
      ? { kind: "image", mimeType: part.inlineData.mimeType, base64: part.inlineData.data }
      : { kind: "text", text: part.text })),
    strictDeclared: (body) => Array.isArray(body.generationConfig?.responseSchema?.required)
      && body.generationConfig.responseSchema.required.includes("outcome")
      && body.generationConfig.responseMimeType === "application/json",
    /* cached content is inside promptTokenCount; thoughts sit beside the
       candidates rather than inside them. */
    inputTotalOf: (u) => u.promptTokenCount,
    outputTotalOf: (u) => u.candidatesTokenCount + (u.thoughtsTokenCount ?? 0),
    protocol: () => new GoogleProtocol(),
    turns: (body) => body.contents,
    systemText: (body) => body.systemInstruction?.parts?.[0]?.text,
    /* This one puts the model in the address rather than the body. */
    modelAsked: (_body, url) => decodeURIComponent(String(url).split("/models/")[1]?.split(":")[0] ?? ""),
    strictShape: (body) => body.generationConfig?.responseMimeType === "application/json"
      && Array.isArray(body.generationConfig?.responseSchema?.required)
      && body.generationConfig.responseSchema.required.includes("outcome"),
    notStreamed: (body) => !("stream" in body) && body.generationConfig?.candidateCount === 1,
    ceiling: (body) => body.generationConfig?.maxOutputTokens,
  },
];

const OUTPUT_CEILING = 4096;

const environment = Object.fromEntries(PROVIDERS.map((p) => [p.environmentVariable, KEY]));

const MATERIAL_CEILING = 64 * 1024;
const CAN_DO_EVERYTHING = { forcedToolChoice: true, strictSchema: true, images: true, thinking: "optional" };

const configurationOf = (p, over = {}) => ({
  providerId: p.providerId,
  baseUrl: p.baseUrl,
  apiKeyEnvironmentVariable: p.environmentVariable,
  models: [p.fixtures.askedModel],
  defaultModel: p.fixtures.askedModel,
  maximumOutputTokens: OUTPUT_CEILING,
  maximumInputTokens: 60000,
  requestTimeoutMs: 30000,
  maximumMaterialBytes: MATERIAL_CEILING,
  maximumMaterialBytesPerItem: MATERIAL_CEILING,
  supportedMediaTypes: ["text/plain; charset=utf-8", "image/png"],
  capabilities: { [p.fixtures.askedModel]: { ...CAN_DO_EVERYTHING } },
  ...over,
});

const pricingOf = (p) => ({
  providerId: p.providerId, model: p.fixtures.askedModel, effectiveFrom: "2026-01-01", currency: "USD",
  inputPerMillionTokens: 3, outputPerMillionTokens: 15, cachedInputPerMillionTokens: 0.3, reasoningPerMillionTokens: 15,
});

/* All four gates open, which is the only state in which anything is sent —
   and even then nothing leaves the process, because the transport answers
   from a file. */
const runtimeConfig = () => ({
  providers: PROVIDERS.map(configurationOf),
  pricing: PROVIDERS.map(pricingOf),
  authorization: {
    providerNetworkFlag: true,
    environmentGate: true,
    maximumAuthorizedCost: 5,
    currency: "USD",
    providerAllowlist: PROVIDERS.map((p) => p.providerId),
    modelAllowlist: PROVIDERS.map((p) => p.fixtures.askedModel),
  },
  dispatcherName: "core-v2-runtime-tests",
});

/* A clock that moves seven milliseconds every time it is asked, so a
   duration is a number a test can name. */
const tickingClock = () => ({ t: 0, now() { const v = this.t; this.t += 7; return v; }, async sleep() {} });
const STEP = 7;

/* The material these packets authorise: one piece of text and one image,
   each filed under the hash of its own bytes, which is what a resolver's
   answer is checked against. */
const TABLE_TEXT = "entry     category   quantity  unit\nE-001     alpha      12        units\n";
const TABLE_BYTES = new Uint8Array(Buffer.from(TABLE_TEXT, "utf8"));
const TABLE_HASH = sha256Bytes(TABLE_BYTES);
/* Eight bytes that are not text and never will be: a PNG signature. */
const IMAGE_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x11]);
const IMAGE_HASH = sha256Bytes(IMAGE_BYTES);

const store = new Map([
  [TABLE_HASH, { mediaKind: "text", mimeType: "text/plain; charset=utf-8", bytes: TABLE_BYTES }],
  [IMAGE_HASH, { mediaKind: "image", mimeType: "image/png", bytes: IMAGE_BYTES }],
]);
const resolverFor = () => new InMemoryMaterialResolver(store);

const sourceRef = (segmentId, contentHash, over = {}) => ({
  sourceId: "src-1", segmentId, kind: "segment", sourceKind: "record_set", segmentKind: "table",
  parentSegmentId: null, label: null, ordinal: 0, locator: { bbox: [0, 0, 1, 1] }, contentHash, ...over,
});

let packetCount = 0;
const packetFor = (marker) => {
  packetCount++;
  return {
    packetVersion: "core-v2.packet.2",
    workflowId: "wf-adapters",
    taskId: `task-${packetCount}`,
    parentTaskId: null,
    phase: "analyze",
    roleKey: "table_reader",
    roleVersion: "1",
    taskType: "synthetic:read_table",
    subjectKey: `subject/${marker}`,
    objective: `read ${marker}`,
    sources: [sourceRef("seg-1", TABLE_HASH), sourceRef("seg-2", IMAGE_HASH, { segmentKind: "note" })],
    dependencies: [],
    independenceGroup: "reader-a",
    blindContext: true,
    allowedActions: [],
    limits: { maximumSources: 2, maximumClaims: 8, maximumFollowUps: 0, maximumDepth: 0, maximumOutputBytes: 40000 },
    expectedOutputContract: "claims with anchors, one per reading",
    inputFingerprint: `fp-${marker}`,
    context: { claims: [], assessments: [], disagreements: [], depth: 0, validation: [] },
  };
};

/* The compiler another agent writes. Here it is the smallest thing that
   satisfies the signature and carries one marker per packet, so "is anything
   of the last call in this one" is a question with an answer. */
const compiler = (packet) => ({
  system: "Answer only in the shape you were given. Anchor every reading.",
  user: `${packet.subjectKey} :: ${packet.inputFingerprint} :: ${packet.expectedOutputContract}`,
});

const contextFor = (signal) => {
  const reported = [];
  return {
    facts: reported,
    merged: () => Object.assign({}, ...reported),
    context: { attemptId: "att-1", taskId: "task-1", signal: signal ?? new AbortController().signal, report: (f) => reported.push(f) },
  };
};

const executorFor = (p, response, options = {}) => {
  const transport = options.transport ?? new FixtureTransport([
    { urlContains: p.urlContains, responses: [jsonResponse(response.status, response.body, response.headers)] },
  ]);
  const executor = new ProviderExecutor({
    configuration: options.configuration ?? configurationOf(p),
    runtime: runtimeConfig(),
    transport,
    protocol: p.protocol(),
    compilePrompt: options.compilePrompt ?? compiler,
    materialResolver: options.materialResolver ?? resolverFor(),
    families: ["reader-family-one"],
    clock: tickingClock(),
    environment,
  });
  return { executor, transport };
};

/* Anything that is printed while an adapter runs, so "no log line carries
   the key" is checked against lines rather than against hope. */
async function printedWhile(fn) {
  const lines = [];
  const original = { log: console.log, error: console.error, warn: console.warn };
  console.log = (...a) => lines.push(a.map(String).join(" "));
  console.error = (...a) => lines.push(a.map(String).join(" "));
  console.warn = (...a) => lines.push(a.map(String).join(" "));
  try { return { value: await fn(), lines }; }
  finally { console.log = original.log; console.error = original.error; console.warn = original.warn; }
}

/* ────────────────────────────────────────────── the suite, three times */

for (const p of PROVIDERS) {
  const asked = p.fixtures.askedModel;
  const reported = p.fixtures.reportedModel;
  t.section(`${p.providerId}: what goes on the wire`);

  const { executor, transport } = executorFor(p, p.fixtures.good);
  const first = contextFor();
  const packet = packetFor("MARK-ONE");
  const printed = await printedWhile(() => executor.execute(packet, first.context));
  const envelope = printed.value;
  const request = transport.sent[0];
  const body = transport.bodies()[0];

  t.check("exactly one request was made for one attempt", transport.sent.length === 1, `${transport.sent.length} requests`);
  t.check("it went to the address configuration gave, on this provider's own path",
    request.url.startsWith(p.baseUrl) && request.url.includes(p.urlContains), request.url);
  t.check("the model asked for is the one configuration names, not one written into code",
    p.modelAsked(body, request.url) === asked, `asked for ${p.modelAsked(body, request.url)}, configured ${asked}`);
  t.check("and that model is on the operator's allowlist — a model off the list is never asked for",
    runtimeConfig().authorization.modelAllowlist.includes(p.modelAsked(body, request.url)));
  t.check("the output ceiling in the request is the one configuration set",
    p.ceiling(body) === OUTPUT_CEILING, `${p.ceiling(body)}`);
  t.check("a strict structured envelope is the only shape the answer may take", p.strictShape(body) === true);
  t.check("the answer is not streamed — an answer read while it is written cannot be kept verbatim", p.notStreamed(body) === true);

  t.section(`${p.providerId}: the material is in the request, not a description of it`);
  {
    const parts = p.partsOf(body);
    const texts = parts.filter((x) => x.kind === "text").map((x) => x.text);
    const images = parts.filter((x) => x.kind === "image");
    t.check("the assignment is there, and so is every piece of material it authorises",
      parts.length === 5 && texts[0] === compiler(packet).user, `${parts.length} parts, first ${JSON.stringify(texts[0]?.slice(0, 30))}`);
    t.check("the text the resolver returned is in the request byte for byte — not summarised, not described",
      texts.includes(TABLE_TEXT), texts.map((x) => x.slice(0, 24)).join(" | "));
    t.check("the image is in the request as bytes in this provider's own multimodal shape",
      images.length === 1 && images[0].mimeType === "image/png", JSON.stringify(images.map((x) => x.mimeType)));
    t.check("and those bytes are exactly the bytes the resolver returned, hash for hash",
      images.length === 1 && sha256Bytes(new Uint8Array(Buffer.from(images[0].base64, "base64"))) === IMAGE_HASH);
    t.check("each piece is announced by what it is: its source, its segment, its type, its size and its hash",
      texts.filter((x) => x.startsWith("--- material for ")).length === 2
      && texts.some((x) => x.includes(TABLE_HASH)) && texts.some((x) => x.includes(IMAGE_HASH)),
      texts.filter((x) => x.startsWith("--- material for ")).length + " headings");
    const raw = JSON.stringify(body);
    t.check("and nothing in the request is an address: no bucket, no signed url, no path, no expiry",
      !/https?:\/\/(?!alpha|beta|gamma)|X-Amz-|signature=|expires=|\/storage\/|s3:\/\/|gs:\/\//i.test(raw));
    t.check("the strict shape is declared to the provider, not merely asked for in prose", p.strictDeclared(body) === true);
  }

  t.section(`${p.providerId}: the request is fresh and stateless`);
  t.check("there is exactly one turn in the request", Array.isArray(p.turns(body)) && p.turns(body).length === 1, `${p.turns(body)?.length} turns`);
  t.check("and it is the question, not a continuation of anything", p.turns(body)[0].role === "user", p.turns(body)[0].role);
  t.check("the instruction travels beside the question rather than as a prior turn", typeof p.systemText(body) === "string" && p.systemText(body).length > 0);
  {
    const raw = JSON.stringify(body);
    t.check("no turn in the request was ever spoken by the thing being asked — there is no assistant history",
      !raw.includes("assistant"));
    t.check("and no field that would let the provider continue an earlier call",
      !/previous_response_id|conversation|"history"|thread_id|"store":true/.test(raw));
  }
  {
    /* A second attempt on the same adapter instance, with a different
       question. If anything of the first call survived — the question, the
       answer, the identifier — it would be here. */
    const second = contextFor();
    await executor.execute(packetFor("MARK-TWO"), { ...second.context, taskId: "task-2" });
    const secondBody = JSON.stringify(transport.bodies()[1]);
    t.check("a second attempt through the same adapter carries its own question", secondBody.includes("MARK-TWO"));
    t.check("and nothing of the first question is in it", !secondBody.includes("MARK-ONE"));
    t.check("and nothing of the first ANSWER is in it — a reader is not shown what it said last time",
      !secondBody.includes("12 units") && !secondBody.includes(p.fixtures.requestId));
    t.check("and nothing about who is reading is in it — not the blind group, not the domain, not the family",
      !secondBody.includes("reader-a") && !secondBody.includes("independence") && !secondBody.includes("domain:"));
  }

  t.section(`${p.providerId}: the key is in the request and nowhere else`);
  {
    const header = p.keyValue(request.headers);
    t.check("the key configuration named is in the request the adapter built", typeof header === "string" && header.includes(KEY));
    t.check("it travels in this provider's OWN header, by name",
      Object.keys(request.headers).includes(p.keyHeader), Object.keys(request.headers).join(", "));
    t.check("and never in the address — a key in a url is a key in every log that writes a url",
      !request.url.includes(KEY) && !request.url.includes("key=") && !request.url.includes("token="), request.url);
    const seen = JSON.stringify(transport.seen);
    t.check("the redacted view of that request does not reveal it", !seen.includes(KEY));
    t.check("and says a credential was there rather than pretending none was", seen.includes("redacted"));
    t.check("nothing was printed while the adapter ran", printed.lines.length === 0, printed.lines.slice(0, 2).join(" | "));
    t.check("and neither the envelope nor the reported facts carry it",
      !JSON.stringify({ envelope, facts: first.facts }).includes(KEY));
    t.check("the key is not a field of the adapter — it is looked up at the moment of the request and put in one header",
      executor.apiKey === undefined && !Object.values(executor).some((v) => typeof v === "string" && v.includes(KEY)));
  }

  t.section(`${p.providerId}: what comes back is a well-formed envelope`);
  t.check("the outcome is the one the answer gave", envelope.outcome === "completed", envelope.outcome);
  t.check("it answers the task it was handed", envelope.taskId === packet.taskId, envelope.taskId);
  t.check("and carries the role it was handed", envelope.roleKey === "table_reader" && envelope.roleVersion === "1");
  for (const field of ["claims", "anchors", "segments", "assessments", "disagreements", "requestedActions", "decisions", "calculations", "limitations"]) {
    t.check(`the envelope carries a ${field} array, whether or not the answer bothered to`, Array.isArray(envelope[field]));
  }
  t.check("the adjudication field is present and empty rather than missing", envelope.adjudication === null);
  t.check("the one claim the answer made came through", envelope.claims.length === 1 && envelope.claims[0].claimKey === "c1");
  t.check("with the reading the answer gave", envelope.claims[0].value.quantity === 12 && envelope.claims[0].value.known === true);
  t.check("and it points at an anchor this same envelope carries",
    envelope.anchors.some((a) => a.anchorKey === envelope.claims[0].anchorKeys[0]));
  t.check("no failure code is written on a good answer", failureCode(envelope) === null);

  t.section(`${p.providerId}: the facts about the call are reported`);
  {
    const facts = first.merged();
    t.check("the facts were reported exactly once for one call", first.facts.length === 1, `${first.facts.length} reports`);
    t.check("the identifier the provider wrote on the call is reported",
      facts.requestId === p.fixtures.requestId, `${facts.requestId}`);
    t.check("the model REPORTED is what answered, not what was asked for",
      facts.modelReported === reported && reported !== asked, `reported ${facts.modelReported}, asked ${asked}`);
    const reportedUsage = p.fixtures.good.body.usage ?? p.fixtures.good.body.usageMetadata;
    t.check("the counts are kept EXACTLY as the provider reported them — not renamed, not summed, not filled in",
      JSON.stringify(facts.usage) === JSON.stringify(reportedUsage), JSON.stringify(facts.usage));
    t.check("which means the record holds this provider's own field names, whatever they are",
      Object.keys(facts.usage).every((key) => key in reportedUsage) && Object.keys(facts.usage).length === Object.keys(reportedUsage).length,
      Object.keys(facts.usage).join(","));
    {
      /* And what those names MEAN is decided per provider, once, where it
         can be argued with — never by adding up whatever numbers arrived. */
      const billable = normalizeUsage(p.providerId, facts.usage);
      const expected = p.fixtures.expectedNormalized;
      t.check("the billable components are what this provider's own semantics make of those counts",
        billable.complete
        && billable.uncachedInputTokens === expected.uncached_input_tokens
        && billable.cachedInputReadTokens === expected.cached_input_read_tokens
        && billable.cachedInputWriteTokens === expected.cached_input_write_tokens
        && billable.visibleOutputTokens === expected.visible_output_tokens
        && billable.reasoningOutputTokens === expected.reasoning_output_tokens,
        `${billable.uncachedInputTokens}/${billable.cachedInputReadTokens}/${billable.cachedInputWriteTokens}/${billable.visibleOutputTokens}/${billable.reasoningOutputTokens}`);
      /* No token counted twice, and none dropped: the components add back up
         to exactly what this provider said, by this provider's own rules
         about which of its numbers contain which. */
      const inputTotal = billable.uncachedInputTokens + billable.cachedInputReadTokens + billable.cachedInputWriteTokens;
      const outputTotal = billable.visibleOutputTokens + billable.reasoningOutputTokens;
      t.check("and the components add back up to exactly what this provider reported — nothing counted twice, nothing dropped",
        inputTotal === p.inputTotalOf(reportedUsage) && outputTotal === p.outputTotalOf(reportedUsage),
        `${inputTotal} input against ${p.inputTotalOf(reportedUsage)}, ${outputTotal} output against ${p.outputTotalOf(reportedUsage)}`);
    }
    t.check("how long it took is reported", facts.durationMs === STEP, `${facts.durationMs}ms`);
    t.check("why it stopped is reported in the provider's own word", typeof facts.stopReason === "string" && facts.stopReason.length > 0, facts.stopReason);
    t.check("the answer is preserved with the status it came with", facts.response.status === 200);
    t.check("and the body is kept verbatim, byte for byte, as it arrived",
      facts.response.body === jsonResponse(p.fixtures.good.status, p.fixtures.good.body, p.fixtures.good.headers).body);
    t.check("so the answer can be read again without the adapter's reading of it",
      JSON.stringify(JSON.parse(facts.response.body)) === JSON.stringify(p.fixtures.good.body));
  }

  t.section(`${p.providerId}: what the adapter will not say`);
  t.check("an adapter cannot say what became of an attempt it never saw the end of", await executor.reconcile("att-1") === "unknown");
}

/* ───────────────────────────────── one adapter per provider, three domains */

t.section("one adapter per provider, and that is what makes three readers three opinions");
{
  const config = runtimeConfig();
  const transport = new FixtureTransport(PROVIDERS.map((p) => ({
    urlContains: p.urlContains, responses: [jsonResponse(p.fixtures.good.status, p.fixtures.good.body, p.fixtures.good.headers)],
  })));
  const built = buildProviderRegistry({ config, transport, compilePrompt: compiler, materialResolver: resolverFor(), clock: tickingClock(), environment });

  t.check("three configured providers become three adapters, no more", built.byProvider.size === 3, `${built.byProvider.size}`);
  t.check("family one, two and three are wired to three different providers",
    new Set(Object.values(built.routing)).size === 3, JSON.stringify(built.routing));
  const domains = READER_FAMILIES.map((f) => built.domainOfFamily(f));
  t.check("and each family resolves to a domain of its own", new Set(domains).size === 3, domains.join(" "));
  t.check("every family the kernel knows about is served", READER_FAMILIES.every((f) => built.registry.has(f)));
  t.check("a family's domain is its provider's domain — the name does not decide it",
    READER_FAMILIES.every((f) => built.domainOfFamily(f) === built.domainOf(built.routing[f])));

  /* The rule this whole file exists for: two families on one provider are
     one opinion, and the kernel says so by giving them one domain. */
  const oneProvider = { ...config, providers: [config.providers[0]] };
  const doubled = buildProviderRegistry({
    config: oneProvider, transport, compilePrompt: compiler, materialResolver: resolverFor(), clock: tickingClock(), environment,
    routing: { "reader-family-one": PROVIDERS[0].providerId, "reader-family-two": PROVIDERS[0].providerId },
  });
  t.check("two families routed to one provider are served by ONE adapter", doubled.byProvider.size === 1);
  t.check("and the kernel gives them ONE domain — two models from one provider are not two opinions",
    doubled.domainOfFamily("reader-family-one") === doubled.domainOfFamily("reader-family-two"),
    `${doubled.domainOfFamily("reader-family-one")} vs ${doubled.domainOfFamily("reader-family-two")}`);
  await t.refused("and asking for three independent readers from one provider is refused outright",
    async () => routeFamiliesToProviders(oneProvider, READER_FAMILIES));
}

/* ─────────────────────────────────────────── the door that is shut by default */

t.section("the transport a runtime gets by default is the one that refuses");
{
  const p = PROVIDERS[0];
  const sealed = new SealedTransport();
  const { executor } = executorFor(p, p.fixtures.good, { transport: sealed });
  const held = contextFor();
  const envelope = await executor.execute(packetFor("MARK-SEALED"), held.context);
  t.check("an adapter handed the sealed transport sends nothing", failureCode(envelope) === "network_not_authorized", failureCode(envelope));
  t.check("and calls it a known failure rather than an unknown one — the door was never opened",
    envelope.outcome === "failed_known", envelope.outcome);
  t.check("no claim was invented on the way", envelope.claims.length === 0 && envelope.anchors.length === 0);
  t.check("the refusal is reported as a fact of the attempt", held.facts.length === 1 && held.facts[0].stopReason === "network_not_authorized");
  t.check("and the sealed transport recorded the attempt with the address redacted",
    sealed.attempts.length === 1 && !JSON.stringify(sealed.attempts).includes(KEY));
}

t.section("every door stayed closed");
t.check("nothing in this file tried the network", tripped() === 0, `${tripped()} attempts`);

t.finish();
