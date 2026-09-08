/* THE FAILURE TABLE, RUN AGAINST ALL THREE ADAPTERS.
 *
 * Everything a provider can do to an attempt other than answer it, and what
 * each of those is called. The distinctions this file defends are the ones
 * that decide whether money is spent twice and whether a silence becomes a
 * fact:
 *
 *   known failure      nothing happened, or something happened and it is
 *                      settled. Safe to give up on; never safe to pretend
 *                      it succeeded.
 *   outcome unknown    the request may have reached the provider and may
 *                      have been served. Never repeated by machine, never
 *                      called a failure, never called a success.
 *
 * A rate limit is the one answer that says, in the provider's own words,
 * that the request was NOT taken — so it is the one thing this layer will
 * send again, and it will send again a bounded number of times, which is
 * proved here by counting what the transport saw.
 *
 * Nothing here reaches a network. The fixtures are invented.
 */
import { readFileSync } from "node:fs";
import { harness, closeNetwork } from "../../core-v2/tests/harness.mjs";
import { FixtureTransport, jsonResponse } from "../transport/fixture.ts";
import { NetworkNotAuthorized, SealedTransport } from "../transport/transport.ts";
import { failureCode, ProviderExecutor } from "../providers/provider.ts";
import { AnthropicProtocol } from "../providers/anthropic.ts";
import { OpenAiProtocol } from "../providers/openai.ts";
import { GoogleProtocol } from "../providers/google.ts";
import { NO_PAID_CALLS } from "../runtime-config.ts";

const tripped = closeNetwork();
const t = harness("the failure table: what each way of not answering is called");

/* ────────────────────────────────────────────────────────── the setup */

const load = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const KEY = "synthetic-not-a-credential-0123456789";

const PROVIDERS = [
  { providerId: "anthropic", fixtures: load("anthropic"), environmentVariable: "CORE_V2_TEST_KEY_ALPHA", baseUrl: "https://alpha.provider.invalid", urlContains: "/v1/messages", protocol: () => new AnthropicProtocol() },
  { providerId: "openai", fixtures: load("openai"), environmentVariable: "CORE_V2_TEST_KEY_BETA", baseUrl: "https://beta.provider.invalid", urlContains: "/v1/responses", protocol: () => new OpenAiProtocol() },
  { providerId: "google", fixtures: load("google"), environmentVariable: "CORE_V2_TEST_KEY_GAMMA", baseUrl: "https://gamma.provider.invalid", urlContains: ":generateContent", protocol: () => new GoogleProtocol() },
];

const OUTPUT_CEILING = 4096;
const environment = Object.fromEntries(PROVIDERS.map((p) => [p.environmentVariable, KEY]));

const configurationOf = (p, overrides = {}) => ({
  providerId: p.providerId,
  baseUrl: p.baseUrl,
  apiKeyEnvironmentVariable: p.environmentVariable,
  models: [p.fixtures.askedModel],
  defaultModel: p.fixtures.askedModel,
  maximumOutputTokens: OUTPUT_CEILING,
  maximumInputTokens: 60000,
  requestTimeoutMs: 30000,
  ...overrides,
});

const pricingOf = (p) => ({
  providerId: p.providerId, model: p.fixtures.askedModel, effectiveFrom: "2026-01-01", currency: "USD",
  inputPerMillionTokens: 3, outputPerMillionTokens: 15, cachedInputPerMillionTokens: 0.3, reasoningPerMillionTokens: 15,
});

const runtimeConfig = (overrides = {}) => ({
  providers: PROVIDERS.map((p) => configurationOf(p)),
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
  ...overrides,
});

const tickingClock = () => ({ t: 0, now() { const v = this.t; this.t += 7; return v; }, async sleep() {} });

let packetCount = 0;
const packet = () => {
  packetCount++;
  return {
    packetVersion: "core-v2.packet.2",
    workflowId: "wf-failures",
    taskId: `task-${packetCount}`,
    parentTaskId: null,
    phase: "analyze",
    roleKey: "table_reader",
    roleVersion: "1",
    taskType: "synthetic:read_table",
    subjectKey: "subject/one",
    objective: "read one table",
    sources: [{ sourceId: "src-1", segmentId: "seg-1", kind: "segment", sourceKind: "record_set", segmentKind: "table", parentSegmentId: null, label: null, ordinal: 0, locator: { bbox: [0, 0, 1, 1] }, contentHash: "h1" }],
    dependencies: [],
    independenceGroup: "reader-a",
    blindContext: true,
    allowedActions: [],
    limits: { maximumSources: 1, maximumClaims: 8, maximumFollowUps: 0, maximumDepth: 0, maximumOutputBytes: 40000 },
    expectedOutputContract: "claims with anchors, one per reading",
    inputFingerprint: "fp-1",
    context: { claims: [], assessments: [], disagreements: [], depth: 0, validation: [] },
  };
};

const compile = () => ({ system: "Answer only in the shape you were given.", user: "Read the table." });

const held = (signal) => {
  const facts = [];
  return { facts, merged: () => Object.assign({}, ...facts), context: { attemptId: "att-1", taskId: "task-1", signal: signal ?? new AbortController().signal, report: (f) => facts.push(f) } };
};

/* One adapter, one canned answer (or a sequence, or a fault), run once. */
async function run(p, options = {}) {
  const transport = options.transport ?? new FixtureTransport([{
    urlContains: p.urlContains,
    responses: (options.responses ?? [options.response ?? p.fixtures.good]).map((r) => jsonResponse(r.status, r.body, r.headers)),
    fails: options.fails,
  }]);
  const executor = new ProviderExecutor({
    configuration: options.configuration ?? configurationOf(p),
    runtime: options.runtime ?? runtimeConfig(),
    transport,
    protocol: p.protocol(),
    compilePrompt: options.compilePrompt ?? compile,
    families: ["reader-family-one"],
    model: options.model,
    clock: tickingClock(),
    retry: options.retry,
    environment: options.environment ?? environment,
  });
  const record = held(options.signal);
  const envelope = await executor.execute(packet(), record.context);
  return { envelope, transport, facts: record.facts, merged: record.merged(), code: failureCode(envelope) };
}

/* Every failure, whatever caused it, must satisfy these. Called on each row
   of the table so the rule is checked everywhere rather than remembered. */
function neverASuccess(label, result) {
  t.check(`${label}: the outcome is a failure, never "completed"`,
    result.envelope.outcome === "failed_known" || result.envelope.outcome === "outcome_unknown", result.envelope.outcome);
  t.check(`${label}: and no claim, anchor, assessment or decision was invented on the way`,
    result.envelope.claims.length === 0 && result.envelope.anchors.length === 0
    && result.envelope.assessments.length === 0 && result.envelope.decisions.length === 0
    && result.envelope.adjudication === null);
  /* The code is the first word of the first limitation and the sentence
     follows it: `<code>: what happened`. That is the whole convention, and
     it is what puts a machine-readable cause on the attempt row — the kernel
     files a failed attempt under the first word of its reason. */
  t.check(`${label}: it says in one word why, and in a sentence what happened`,
    typeof result.code === "string" && result.code.length > 0
    && result.envelope.limitations.length >= 1
    && new RegExp(`^${result.code}: \\S.*`).test(result.envelope.limitations[0]),
    `${result.code} — ${result.envelope.limitations[0]}`);
  t.check(`${label}: and the facts about the attempt were reported rather than lost`,
    result.facts.length >= 1 && typeof result.merged.durationMs === "number");
}

/* ─────────────────────────────────────── refused before anything was sent */

for (const p of PROVIDERS) {
  t.section(`${p.providerId}: refused before submission`);

  {
    /* A provider whose configured default is not on its own list of models:
       a run that would refuse at submission refuses before it. */
    const broken = { ...runtimeConfig() };
    broken.providers = broken.providers.map((c) => (c.providerId === p.providerId ? { ...c, defaultModel: "a-model-nobody-configured" } : c));
    const result = await run(p, { runtime: broken, configuration: configurationOf(p, { defaultModel: "a-model-nobody-configured" }) });
    t.check("an invalid configuration refuses", result.code === "provider_misconfigured", result.code);
    t.check("and nothing was sent", result.transport.sent.length === 0, `${result.transport.sent.length} requests`);
    neverASuccess("invalid configuration", result);
  }

  {
    const result = await run(p, { model: "a-model-not-on-this-provider" });
    t.check("a model the provider is not configured to be asked for refuses", result.code === "provider_misconfigured", result.code);
    t.check("and nothing was sent", result.transport.sent.length === 0);
  }

  {
    const result = await run(p, { runtime: runtimeConfig({ authorization: NO_PAID_CALLS }) });
    t.check("with no paid call authorised, the adapter refuses", result.code === "paid_call_not_authorized", result.code);
    t.check("and nothing was sent — the gates are checked before a request exists",
      result.transport.sent.length === 0, `${result.transport.sent.length} requests`);
    t.check("and it gives every reason at once rather than the first",
      result.envelope.limitations.length >= 5, `${result.envelope.limitations.length - 1} reasons`);
    neverASuccess("no authorization", result);
  }

  for (const [gate, over] of [
    ["the command-line flag is missing", { providerNetworkFlag: false }],
    ["the environment gate is unset", { environmentGate: false }],
    ["the authorised amount is zero", { maximumAuthorizedCost: 0 }],
    ["the provider is not on the allowlist", { providerAllowlist: [] }],
    ["the model is not on the allowlist", { modelAllowlist: [] }],
  ]) {
    const runtime = runtimeConfig();
    const result = await run(p, { runtime: { ...runtime, authorization: { ...runtime.authorization, ...over } } });
    t.check(`one gate is enough on its own: ${gate}, and nothing is sent`,
      result.code === "paid_call_not_authorized" && result.transport.sent.length === 0, result.code);
  }

  {
    /* A key exists in the environment, under a name configuration did not
       give. An adapter that went looking rather than reading the one name it
       was told would find it, and this is what would catch that. */
    const result = await run(p, { environment: { SOME_OTHER_VARIABLE: KEY } });
    t.check("with nothing in the environment variable configuration named, the adapter refuses", result.code === "provider_key_absent", result.code);
    t.check("and nothing was sent", result.transport.sent.length === 0);
    t.check("a key under another name is not found, and nothing of it reaches the envelope",
      !JSON.stringify(result.envelope).includes(KEY));
  }

  {
    /* A deadline that ran out before the adapter got to the wire. Nothing
       left this process, so this is known, not unknown. */
    const controller = new AbortController();
    controller.abort();
    const result = await run(p, { response: p.fixtures.good, signal: controller.signal });
    t.check("a timeout BEFORE submission is a known failure", result.envelope.outcome === "failed_known", result.envelope.outcome);
    t.check("and it says so in one word", result.code === "cancelled_before_submission", result.code);
    t.check("and nothing was sent, so nothing may have happened", result.transport.sent.length === 0);
    neverASuccess("cancelled before submission", result);
  }

  {
    const result = await run(p, { compilePrompt: () => { throw new Error("the compiler could not read this packet"); } });
    t.check("a packet that cannot be turned into a question refuses before the wire", result.code === "prompt_not_compiled", result.code);
    t.check("and nothing was sent", result.transport.sent.length === 0);
  }

  {
    const sealed = new SealedTransport();
    const result = await run(p, { transport: sealed });
    t.check("the door that is shut by default refuses, and is not mistaken for the provider refusing",
      result.code === "network_not_authorized", result.code);
    t.check("it is a known failure — the door was never opened", result.envelope.outcome === "failed_known");
    t.check("and the sealed transport is the only thing that saw the address",
      sealed.attempts.length === 1 && !JSON.stringify(sealed.attempts).includes(KEY));
    neverASuccess("sealed transport", result);
  }
}

/* ──────────────────────────────────────────── what the provider answered */

for (const p of PROVIDERS) {
  const f = p.fixtures;
  t.section(`${p.providerId}: the provider answered, and the answer was not an answer`);

  {
    const result = await run(p, { response: f.unauthorized });
    t.check("a refused credential is a known failure", result.envelope.outcome === "failed_known", result.envelope.outcome);
    t.check("and it says so in one word", result.code === "provider_unauthorized", result.code);
    t.check("and it is NOT retried — a credential does not become acceptable by asking again",
      result.transport.sent.length === 1, `${result.transport.sent.length} requests`);
    t.check("and the answer is kept exactly as it arrived, status and all",
      result.merged.response.status === f.unauthorized.status && JSON.parse(result.merged.response.body).error !== undefined);
    neverASuccess("401", result);
  }

  {
    /* Rate limited every time. The policy allows two sends for one attempt,
       so the transport must see two — not one, not three, not until it
       works. */
    const result = await run(p, { responses: [f.rateLimited], retry: { maximumAttempts: 2, backoffMs: 0 } });
    t.check("a rate limit before acceptance may be sent again", result.transport.sent.length > 1);
    t.check("but only under a bounded policy — exactly the number of sends the policy allows, and no more",
      result.transport.sent.length === 2, `${result.transport.sent.length} requests`);
    t.check("and when the allowance is used, it is a known failure rather than an endless wait",
      result.envelope.outcome === "failed_known" && result.code === "provider_rate_limited", result.code);
    t.check("the second request is the same fresh request as the first — nothing accumulated between them",
      JSON.stringify(result.transport.bodies()[0]) === JSON.stringify(result.transport.bodies()[1]));
    neverASuccess("429 throughout", result);

    const once = await run(p, { responses: [f.rateLimited, f.good], retry: { maximumAttempts: 2, backoffMs: 0 } });
    t.check("a rate limit followed by an answer is an answer, on the second send",
      once.envelope.outcome === "completed" && once.transport.sent.length === 2, `${once.transport.sent.length} requests`);

    const notAllowed = await run(p, { responses: [f.rateLimited, f.good], retry: { maximumAttempts: 1, backoffMs: 0 } });
    t.check("a policy of one send sends once, even when a second would have worked",
      notAllowed.transport.sent.length === 1 && notAllowed.code === "provider_rate_limited", notAllowed.code);
  }

  {
    const result = await run(p, { response: f.serverError });
    t.check("a 5xx does not say whether the provider did the work, so the outcome is unknown",
      result.envelope.outcome === "outcome_unknown", result.envelope.outcome);
    t.check("and it says so in one word", result.code === "provider_server_error", result.code);
    t.check("and an attempt that may have reached the provider is never silently sent again",
      result.transport.sent.length === 1, `${result.transport.sent.length} requests`);
    t.check("the answer is kept as it arrived, so a dispute has something to read",
      result.merged.response.status === f.serverError.status);
    neverASuccess("5xx", result);
  }

  {
    /* The request left and nothing came back. Whether it was served is not
       knowable from here, and guessing is how work gets paid for twice. */
    const timeout = new Error("the request timed out after 30000ms");
    const result = await run(p, { responses: [f.good], fails: [timeout] });
    t.check("a timeout AFTER submission is outcome_unknown, not a failure",
      result.envelope.outcome === "outcome_unknown", result.envelope.outcome);
    t.check("and it says so in one word", result.code === "transport_fault", result.code);
    t.check("the request had left, and it is not sent again", result.transport.sent.length === 1);
    t.check("the facts of the attempt are still reported", typeof result.merged.durationMs === "number" && result.merged.stopReason === "transport_fault");
    neverASuccess("timeout after submission", result);
  }

  {
    const result = await run(p, { response: f.outputCeiling });
    t.check("an output ceiling is a known failure, and an incomplete one", result.envelope.outcome === "failed_known", result.envelope.outcome);
    t.check("and it says so in one word", result.code === "output_ceiling_reached", result.code);
    t.check("the part that was written is preserved rather than thrown away",
      result.envelope.limitations.some((l) => l.includes("\"claimKey\":\"c1\"")), result.envelope.limitations[2]);
    t.check("the usage is preserved — a truncated answer still cost what it cost",
      result.merged.usage.input_tokens === 1200 && result.merged.usage.output_tokens === OUTPUT_CEILING, JSON.stringify(result.merged.usage));
    t.check("the reason it stopped is the provider's own word", typeof result.merged.stopReason === "string" && result.merged.stopReason.length > 0, result.merged.stopReason);
    /* Two of these three fixtures write an identifier on a truncated answer
       and one does not. Neither case is allowed to be made up. */
    const declared = f.outputCeiling.headers["request-id"] ?? f.outputCeiling.body.id ?? f.outputCeiling.body.responseId ?? null;
    t.check("the identifier is reported when the answer carries one, and null when it does not — never invented",
      (result.merged.requestId ?? null) === declared, `reported ${result.merged.requestId}, the answer carries ${declared}`);
    t.check("and the truncated text is NOT read as a shorter list of claims", result.envelope.claims.length === 0);
    neverASuccess("output ceiling", result);
  }

  {
    const result = await run(p, { response: f.refusal });
    t.check("a provider refusing is a known failure", result.envelope.outcome === "failed_known", result.envelope.outcome);
    t.check("and it says so in one word", result.code === "provider_refused", result.code);
    t.check("what it refused with is preserved in its own words, after the sentence that says it refused",
      result.envelope.limitations.length >= 2 && result.envelope.limitations[1].length > 0, result.envelope.limitations[1]);
    t.check("and nothing was invented in its place", result.envelope.claims.length === 0 && result.envelope.anchors.length === 0);
    t.check("the whole answer is kept as it arrived", JSON.stringify(JSON.parse(result.merged.response.body)) === JSON.stringify(f.refusal.body));
    neverASuccess("provider refusal", result);
  }

  {
    const result = await run(p, { response: f.malformedAnswer });
    t.check("an answer that is not the strict shape asked for is a validation failure", result.envelope.outcome === "failed_known", result.envelope.outcome);
    t.check("and it says so in one word", result.code === "answer_not_json", result.code);
    t.check("the raw answer is preserved so the parse can be argued with later",
      result.merged.response.body === jsonResponse(f.malformedAnswer.status, f.malformedAnswer.body, f.malformedAnswer.headers).body);
    t.check("and it did not become an empty success", result.envelope.claims.length === 0 && result.envelope.outcome !== "completed");
    neverASuccess("malformed answer", result);
  }

  {
    const result = await run(p, { response: f.malformedBody });
    t.check("a body that is not this provider's shape at all is a known failure", result.envelope.outcome === "failed_known", result.envelope.outcome);
    t.check("and it says so in one word", result.code === "response_not_understood", result.code);
    t.check("the raw body is preserved exactly", result.merged.response.body === f.malformedBody.body, result.merged.response.body);
    neverASuccess("malformed body", result);
  }
}

/* ───────────────────────────────────── the rules that hold across the table */

t.section("the rules that hold whatever went wrong");
{
  const codes = new Set();
  const unknowns = new Set();
  for (const p of PROVIDERS) {
    const f = p.fixtures;
    for (const [name, options] of [
      ["401", { response: f.unauthorized }],
      ["429", { responses: [f.rateLimited], retry: { maximumAttempts: 2, backoffMs: 0 } }],
      ["5xx", { response: f.serverError }],
      ["ceiling", { response: f.outputCeiling }],
      ["refusal", { response: f.refusal }],
      ["malformed", { response: f.malformedAnswer }],
      ["fault", { responses: [f.good], fails: [new Error("socket closed while waiting")] }],
    ]) {
      const result = await run(p, options);
      codes.add(result.code);
      if (result.envelope.outcome === "outcome_unknown") unknowns.add(`${p.providerId}/${name}`);
      if (result.envelope.outcome === "outcome_unknown") {
        t.check(`${p.providerId}/${name}: an unknown outcome was sent exactly once and never repeated`, result.transport.sent.length === 1);
      }
    }
  }
  t.check("each way of failing has its own word, so a dispatcher can tell them apart", codes.size >= 6, [...codes].join(", "));
  t.check("only the two that may have reached the provider are unknown; everything else is settled",
    unknowns.size === 6, [...unknowns].join(", "));
}

t.section("a refusal at the door is not a provider's refusal");
{
  const p = PROVIDERS[0];
  const sealed = new SealedTransport();
  let refused = null;
  try { await sealed.send({ method: "POST", url: `${p.baseUrl}${p.urlContains}`, headers: {}, body: "{}", timeoutMs: 1 }); }
  catch (error) { refused = error; }
  t.check("the sealed transport throws the one error that means the door was never opened", refused instanceof NetworkNotAuthorized);
  const result = await run(p, { transport: sealed });
  t.check("and the adapter reports it as its own kind of failure, not as the provider declining",
    result.code === "network_not_authorized" && result.code !== "provider_refused");
}

t.section("every door stayed closed");
t.check("nothing in this file tried the network", tripped() === 0, `${tripped()} attempts`);

t.finish();
