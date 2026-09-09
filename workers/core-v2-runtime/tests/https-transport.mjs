/* THE ONE DOOR THAT CAN BE OPENED, AND EVERY LOCK ON IT.
 *
 * Until now this package could not reach anybody at all, which made its four
 * authorization gates a statement about nothing: a run with every gate open
 * still had no transport that could send. This file is about the transport
 * that can — and about the fact that it cannot be built by a process that is
 * not authorised, cannot be pointed anywhere an operator did not configure,
 * and cannot be talked into following a redirect, reaching inside the
 * network, or pretending it knows that nothing was sent when it does not.
 *
 * NO SOCKET IS OPENED HERE. The transport takes its node-level request
 * function as an injected seam, and every test hands it a double that
 * records what would have gone out and answers however the case needs. The
 * network is sealed in this process before the first line, and the count at
 * the end says nothing tried it.
 */
import { harness, closeNetwork } from "../../core-v2/tests/harness.mjs";
import { NO_PAID_CALLS } from "../runtime-config.ts";
import { NetworkNotAuthorized, TransportFault } from "../transport/transport.ts";
import { createHttpsTransport, isPublicAddress } from "../transport/https.ts";

const tripped = closeNetwork();
const t = harness("the one door that can be opened, and every lock on it");

const OPEN = {
  providerNetworkFlag: true, environmentGate: true, maximumAuthorizedCost: 5, currency: "USD",
  providerAllowlist: ["one"], modelAllowlist: ["reader"],
};

const providerAt = (baseUrl, providerId = "one", model = "reader") => ({
  providerId, baseUrl, apiKeyEnvironmentVariable: "CORE_V2_TEST_KEY", models: [model], defaultModel: model,
  maximumOutputTokens: 1024, maximumInputTokens: 1000, requestTimeoutMs: 30000,
  maximumMaterialBytes: 1024, maximumMaterialBytesPerItem: 1024, supportedMediaTypes: ["text/plain"],
  capabilities: { [model]: { forcedToolChoice: true, strictSchema: true, images: false, thinking: "optional" } },
});

const priced = (providerId, model, over = {}) =>
  ({ providerId, model, effectiveFrom: "2026-01-01", currency: "USD", inputPerMillionTokens: 3, outputPerMillionTokens: 15, cacheWritePerMillionTokens: 3.75, ...over });

const configWith = (authorization, baseUrl = "https://alpha.provider.invalid") => ({
  providers: [providerAt(baseUrl)],
  pricing: [priced("one", "reader")],
  authorization,
  dispatcherName: "https-tests",
});

/* TWO providers, both configured, both priced, both perfectly usable — and
   only ONE of them authorised. This is the shape the whole of section 1b is
   about: "configured" and "authorised" are different sets, and a transport
   built for the second must not be able to reach the first. */
const TWO_PROVIDERS = {
  providers: [providerAt("https://alpha.provider.invalid"), providerAt("https://beta.provider.invalid", "two", "other-reader")],
  pricing: [priced("one", "reader"), priced("two", "other-reader")],
  authorization: { ...OPEN, providerAllowlist: ["one"], modelAllowlist: ["reader"] },
  dispatcherName: "https-tests",
};

const request = (over = {}) => ({
  method: "POST", url: "https://alpha.provider.invalid/v1/answer",
  headers: { "content-type": "application/json", authorization: "Bearer not-a-real-credential" },
  body: JSON.stringify({ ask: "something" }), timeoutMs: 5000, ...over,
});

/* ─────────────────────────── a stand-in for node's own request function */

/* Scripted: what the double does, step by step, without a socket.
   `plan.answer` — a status, headers and chunks to hand back.
   `plan.failBeforeWrite` / `plan.failAfterWrite` — an error to emit.
   `plan.timeout` — fire the timeout instead of answering. */
function nodeDouble(plan = {}) {
  const seen = [];
  const open = (options, onResponse) => {
    const handlers = new Map();
    let timeoutFn = null;
    const record = { options, wrote: null, ended: false };
    seen.push(record);
    const emit = (event, value) => { const fn = handlers.get(event); if (fn) fn(value); };
    const outgoing = {
      on(event, fn) { handlers.set(event, fn); return outgoing; },
      setTimeout(ms, fn) { timeoutFn = fn; record.timeoutMs = ms; return outgoing; },
      write(chunk, _encoding, callback) {
        if (plan.failBeforeWrite) { emit("error", plan.failBeforeWrite); return false; }
        record.wrote = chunk;
        if (callback) callback(null);
        return true;
      },
      end() {
        record.ended = true;
        queueMicrotask(() => {
          if (plan.failBeforeWrite) return;
          if (plan.timeout) { if (timeoutFn) timeoutFn(); return; }
          if (plan.failAfterWrite) { emit("error", plan.failAfterWrite); return; }
          const answer = plan.answer ?? { status: 200, headers: { "Content-Type": "application/json" }, chunks: ['{"ok":true}'] };
          const listeners = new Map();
          const response = {
            statusCode: answer.status,
            headers: answer.headers,
            setEncoding() {},
            on(event, fn) { listeners.set(event, fn); return response; },
            destroy() { record.destroyed = true; },
          };
          onResponse(response);
          queueMicrotask(() => {
            for (const chunk of answer.chunks) { const fn = listeners.get("data"); if (fn) fn(chunk); }
            if (!record.destroyed) { const fn = listeners.get("end"); if (fn) fn(); }
          });
        });
      },
      destroy() { record.destroyed = true; },
    };
    return outgoing;
  };
  return { open, seen };
}

const nowhere = async () => { throw new Error("this test never resolves a name"); };
const publicly = async () => ["203.0.113.10"];

const build = (over = {}) => createHttpsTransport({
  config: over.config ?? configWith(OPEN),
  openRequest: over.openRequest ?? nodeDouble().open,
  lookup: over.lookup ?? publicly,
  maximumRequestBytes: over.maximumRequestBytes,
  maximumResponseBytes: over.maximumResponseBytes,
});

/* ══════════════════════════════════ 1 · it cannot be built without the gates */

t.section("a transport that can reach a provider cannot be built by a process that is not authorised");
{
  let refused = null;
  try { build({ config: configWith(NO_PAID_CALLS) }); } catch (error) { refused = error; }
  t.check("with no authorization at all, the factory refuses — there is no object to hold",
    refused instanceof NetworkNotAuthorized, refused ? refused.message.slice(0, 60) : "it was built");
  t.check("and it gives every reason at once rather than the first",
    refused instanceof NetworkNotAuthorized && refused.refusals.length >= 5, `${refused?.refusals?.length} reasons`);

  for (const [name, over] of [
    ["the command-line flag", { providerNetworkFlag: true }],
    ["the environment gate", { environmentGate: true }],
    ["an authorised amount", { maximumAuthorizedCost: 5 }],
    ["the allowlists", { providerAllowlist: ["one"], modelAllowlist: ["reader"] }],
  ]) {
    let partial = null;
    try { build({ config: configWith({ ...NO_PAID_CALLS, ...over }) }); } catch (error) { partial = error; }
    t.check(`${name} alone still does not get one built`, partial instanceof NetworkNotAuthorized);
  }
  const built = build();
  t.check("all four together, and only then, is one built", built.name === "https");
  t.check("and the only place it may go is the endpoint this run is authorised for — scheme, host and effective port",
    JSON.stringify(built.allowedOrigins) === JSON.stringify(["https://alpha.provider.invalid:443"]), built.allowedOrigins.join(","));
}

/* ══════════════ 1b · authorised is a smaller set than configured, and it is
   the set that decides. This is the defect: the allowlist used to be built
   from every configured provider, so a run that authorised one provider held
   a transport that could reach a second one it had never paid for. */

t.section("a provider that is merely configured is not a provider this run may reach");
{
  const transport = build({ config: TWO_PROVIDERS });
  t.check("the authorised provider's endpoint is the only one on the list",
    JSON.stringify(transport.allowedOrigins) === JSON.stringify(["https://alpha.provider.invalid:443"]),
    transport.allowedOrigins.join(","));

  const doubled = nodeDouble();
  const reaching = build({ config: TWO_PROVIDERS, openRequest: doubled.open });
  let refused = null;
  try { await reaching.send(request({ url: "https://beta.provider.invalid/v1/answer" })); } catch (error) { refused = error; }
  t.check("and a request to the other one is refused before anything is opened",
    refused instanceof TransportFault && refused.beforeSubmission === true && doubled.seen.length === 0,
    refused?.message?.slice(0, 100));
  t.check("the refusal is about authorization, not about configuration",
    refused instanceof TransportFault && /not an endpoint this run is authorised to reach/.test(refused.message),
    refused?.message?.slice(0, 100));

  /* The same host on a different port is a different socket, so it is a
     different endpoint. An allowlist of hosts cannot tell them apart. */
  const ported = nodeDouble();
  const onPort = build({ config: TWO_PROVIDERS, openRequest: ported.open });
  let elsewhere = null;
  try { await onPort.send(request({ url: "https://alpha.provider.invalid:8443/v1/answer" })); } catch (error) { elsewhere = error; }
  t.check("and neither is the authorised host on a port nobody authorised",
    elsewhere instanceof TransportFault && elsewhere.beforeSubmission === true && ported.seen.length === 0,
    elsewhere?.message?.slice(0, 100));
}

t.section("an allowlist that names something unusable refuses to build anything at all");
{
  const cases = [
    ["a provider that is not configured", { ...TWO_PROVIDERS, authorization: { ...OPEN, providerAllowlist: ["one", "three"], modelAllowlist: ["reader"] } },
      /three is on the authorised list of providers and is not configured/],
    ["a model no authorised provider serves", { ...TWO_PROVIDERS, authorization: { ...OPEN, providerAllowlist: ["one"], modelAllowlist: ["reader", "other-reader"] } },
      /other-reader is on the authorised list of models and no authorised provider/],
    ["an authorised pair with no price", { ...TWO_PROVIDERS, pricing: [priced("two", "other-reader")], authorization: { ...OPEN, providerAllowlist: ["one"], modelAllowlist: ["reader"] } },
      /one\/reader is authorised and has no price/],
    ["an authorised pair priced in another currency", { ...TWO_PROVIDERS, pricing: [priced("one", "reader", { currency: "EUR" })], authorization: { ...OPEN, providerAllowlist: ["one"], modelAllowlist: ["reader"] } },
      /priced in EUR and this run is authorised in USD/],
    ["a provider none of whose models are authorised", { ...TWO_PROVIDERS, authorization: { ...OPEN, providerAllowlist: ["one", "two"], modelAllowlist: ["reader"] } },
      /two is authorised and not one of the models/],
    ["a price that establishes no upper bound", { ...TWO_PROVIDERS, pricing: [priced("one", "reader", { cacheWritePerMillionTokens: Number.NaN })], authorization: { ...OPEN, providerAllowlist: ["one"], modelAllowlist: ["reader"] } },
      /cache-write rate recorded for one\/reader is not a rate a ceiling can be worked out from/],
  ];
  for (const [what, config, reason] of cases) {
    let refused = null;
    try { build({ config }); } catch (error) { refused = error; }
    t.check(`${what}: nothing is built`, refused instanceof NetworkNotAuthorized, refused ? "refused" : "IT WAS BUILT");
    t.check(`${what}: and the reason names it`,
      refused instanceof NetworkNotAuthorized && refused.refusals.some((r) => reason.test(r)),
      JSON.stringify(refused?.refusals ?? []).slice(0, 140));
  }
}

t.section("what an operator may not configure it to be");
for (const [what, baseUrl] of [
  ["plain http", "http://alpha.provider.invalid"],
  ["a credential written into the address", "https://someone:secret@alpha.provider.invalid"],
  ["something that is not a url at all", "alpha.provider.invalid"],
]) {
  let refused = null;
  try { build({ config: configWith(OPEN, baseUrl) }); } catch (error) { refused = error; }
  t.check(`${what} is refused at construction`, refused instanceof NetworkNotAuthorized, refused ? refused.message.slice(0, 80) : "it was built");
}

/* ═════════════════════════════════════ 2 · what it refuses to send, and why */

t.section("what never leaves, and says so");
{
  const cases = [
    ["a url that is not https", { url: "http://alpha.provider.invalid/v1/answer" }, /not https/],
    ["a url carrying a credential", { url: "https://someone:secret@alpha.provider.invalid/v1/answer" }, /carries a credential/],
    ["a host nobody authorised", { url: "https://somewhere.else.invalid/v1/answer" }, /not an endpoint this run is authorised to reach/],
    ["a url that is not a url", { url: "not a url" }, /not a url/],
  ];
  for (const [what, over, reason] of cases) {
    const doubled = nodeDouble();
    const transport = build({ openRequest: doubled.open });
    let thrown = null;
    try { await transport.send(request(over)); } catch (error) { thrown = error; }
    t.check(`${what}: refused, and nothing was opened`,
      thrown instanceof TransportFault && doubled.seen.length === 0, `${thrown?.message?.slice(0, 60)}`);
    t.check(`${what}: and it says, provably, that nothing was sent`,
      thrown instanceof TransportFault && thrown.beforeSubmission === true && reason.test(thrown.message), thrown?.message?.slice(0, 90));
  }

  const doubled = nodeDouble();
  const small = build({ openRequest: doubled.open, maximumRequestBytes: 16 });
  let big = null;
  try { await small.send(request()); } catch (error) { big = error; }
  t.check("a request bigger than the ceiling never leaves",
    big instanceof TransportFault && big.beforeSubmission && /at most 16 may be sent/.test(big.message) && doubled.seen.length === 0,
    big?.message?.slice(0, 80));

  const controller = new AbortController();
  controller.abort();
  const cancelledDouble = nodeDouble();
  const cancelled = build({ openRequest: cancelledDouble.open });
  let stopped = null;
  try { await cancelled.send(request({ signal: controller.signal })); } catch (error) { stopped = error; }
  t.check("a request cancelled before it is sent never opens anything",
    stopped instanceof TransportFault && stopped.beforeSubmission && cancelledDouble.seen.length === 0);
}

t.section("it does not go inside this network, whatever a name says");
{
  /* Parsed as addresses, not matched as strings. A prefix test says "fd00::1"
     is inside because it starts with "fd" — and says nothing at all about
     "[fd00::1]", which is the form a url hostname actually arrives in. */
  const inside = [
    "127.0.0.1", "10.1.2.3", "192.168.0.9", "169.254.169.254", "172.16.4.4", "100.100.0.1",
    "0.0.0.0", "192.0.0.1", "198.18.0.1", "224.0.0.1", "255.255.255.255",
    "::1", "::", "fd00::1", "fe80::1", "fc00::abcd", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1",
    "fe80::1%eth0", "::ffff:7f00:1",
    /* And the same addresses as a url hands them over: bracketed. */
    "[::1]", "[fe80::1]", "[fd00::1]", "[::ffff:127.0.0.1]",
  ];
  const outside = ["203.0.113.10", "2606:4700::1111", "8.8.8.8", "[2606:4700::1111]", "198.51.100.7"];
  const wronglyPublic = inside.filter((address) => isPublicAddress(address));
  const wronglyPrivate = outside.filter((address) => !isPublicAddress(address));
  t.check("every address nothing outside may be reached at is known for what it is, bracketed or bare",
    wronglyPublic.length === 0, wronglyPublic.join(", ") || "none slipped through");
  t.check("and an address that really is outside is not refused for looking like one",
    wronglyPrivate.length === 0, wronglyPrivate.join(", ") || "none refused");
  t.check("something that is not an address at all is not called public",
    !isPublicAddress("alpha.provider.invalid") && !isPublicAddress("") && !isPublicAddress("999.1.1.1"));

  /* THE DEFECT, EACH FORM OF IT: a url whose host is a bracketed IPv6
     literal inside this network. Every one of these used to be sent. */
  for (const literal of ["[::1]", "[fe80::1]", "[fd00::1]", "[::ffff:127.0.0.1]", "[::]"]) {
    const doubled = nodeDouble();
    const pointed = build({
      config: configWith({ ...OPEN }, `https://${literal}`),
      openRequest: doubled.open, lookup: nowhere,
    });
    let refused = null;
    try { await pointed.send(request({ url: `https://${literal}/v1/answer` })); } catch (error) { refused = error; }
    t.check(`${literal} is refused, and nothing was opened`,
      refused instanceof TransportFault && refused.beforeSubmission === true
      && /inside this network/.test(refused.message) && doubled.seen.length === 0,
      refused ? refused.message.slice(0, 80) : "IT WAS SENT");
  }

  const doubled = nodeDouble();
  const mixed = build({ openRequest: doubled.open, lookup: async () => ["203.0.113.10", "169.254.169.254"] });
  let refused = null;
  try { await mixed.send(request()); } catch (error) { refused = error; }
  t.check("a configured host that resolves anywhere inside is refused, even if it also resolves outside",
    refused instanceof TransportFault && refused.beforeSubmission && /inside this network/.test(refused.message) && doubled.seen.length === 0,
    refused?.message?.slice(0, 90));

  const literalDouble = nodeDouble();
  const literal = build({ config: configWith(OPEN, "https://10.0.0.5"), openRequest: literalDouble.open, lookup: nowhere });
  let literalRefused = null;
  try { await literal.send(request({ url: "https://10.0.0.5/v1/answer" })); } catch (error) { literalRefused = error; }
  t.check("an address written down as an address is checked without asking anybody",
    literalRefused instanceof TransportFault && /inside this network/.test(literalRefused.message) && literalDouble.seen.length === 0);

  const unresolvedDouble = nodeDouble();
  const unresolved = build({ openRequest: unresolvedDouble.open, lookup: nowhere });
  let nameless = null;
  try { await unresolved.send(request()); } catch (error) { nameless = error; }
  t.check("a name that does not resolve is a failure that provably sent nothing",
    nameless instanceof TransportFault && nameless.beforeSubmission && /did not resolve/.test(nameless.message));

  const nonsenseDouble = nodeDouble();
  const nonsense = build({ openRequest: nonsenseDouble.open, lookup: async () => ["not-an-address"] });
  let notAnAddress = null;
  try { await nonsense.send(request()); } catch (error) { notAnAddress = error; }
  t.check("an answer that is not an address is not an answer",
    notAnAddress instanceof TransportFault && notAnAddress.beforeSubmission
    && /not an address/.test(notAnAddress.message) && nonsenseDouble.seen.length === 0);
}

t.section("the addresses that were checked are the addresses it connects to");
{
  /* THE DEFECT: validate with one lookup, then hand the hostname to the
     socket and let it resolve again. Between those two moments a name can
     start answering with an address inside this network, and the check has
     already passed. So there is no second lookup: the one node is given
     answers only from the set that was checked, and cannot be talked round. */
  let asked = 0;
  const rebinding = async () => { asked += 1; return asked === 1 ? ["203.0.113.10"] : ["169.254.169.254"]; };
  const doubled = nodeDouble();
  const transport = build({ openRequest: doubled.open, lookup: rebinding });
  await transport.send(request());

  t.check("the name was resolved once, and once only", asked === 1, `${asked} lookups`);
  const pinned = doubled.seen[0].options.lookup;
  t.check("and the socket was handed a lookup of its own rather than the hostname alone", typeof pinned === "function");

  const answeredAll = await new Promise((resolve) => pinned("alpha.provider.invalid", { all: true }, (error, value) => resolve(error ?? value)));
  t.check("which answers only from the addresses that passed the check",
    Array.isArray(answeredAll) && answeredAll.length === 1 && answeredAll[0].address === "203.0.113.10" && answeredAll[0].family === 4,
    JSON.stringify(answeredAll));

  const answeredOne = await new Promise((resolve) => pinned("alpha.provider.invalid", {}, (error, value, family) => resolve(error ?? { value, family })));
  t.check("in the single-address form as well as the whole-set form",
    answeredOne.value === "203.0.113.10" && answeredOne.family === 4, JSON.stringify(answeredOne));
  t.check("and asking it again does not ask the resolver again — the answer cannot change",
    asked === 1, `${asked} lookups`);

  const wrongFamily = await new Promise((resolve) => pinned("alpha.provider.invalid", { family: 6 }, (error) => resolve(error)));
  t.check("a family nothing in the checked set has is refused rather than resolved elsewhere",
    wrongFamily instanceof Error && /no address this run checked/.test(wrongFamily.message), String(wrongFamily).slice(0, 70));

  t.check("the certificate is still checked against the name, not against the address",
    doubled.seen[0].options.servername === "alpha.provider.invalid" && doubled.seen[0].options.hostname === "alpha.provider.invalid",
    JSON.stringify({ servername: doubled.seen[0].options.servername, hostname: doubled.seen[0].options.hostname }));
  /* A pooled socket is handed back with no lookup at all, so a second request
     would travel over a connection the FIRST request validated. There is no
     pool: every request opens its own, through its own pinned lookup. */
  t.check("and no request is carried by a socket some earlier request opened — there is no connection pool",
    doubled.seen[0].options.agent === false, String(doubled.seen[0].options.agent));

  /* An address literal has no name to ask for, so it gets no server name. */
  const literalDouble = nodeDouble();
  const literal = build({ config: configWith(OPEN, "https://203.0.113.10"), openRequest: literalDouble.open, lookup: nowhere });
  await literal.send(request({ url: "https://203.0.113.10/v1/answer" }));
  t.check("an address written down as an address asks for no server name and resolves nothing",
    literalDouble.seen[0].options.servername === undefined, String(literalDouble.seen[0].options.servername));
}

/* ══════════════════════════════════════════ 3 · what it does send, and reads */

t.section("what goes out, and what comes back");
{
  const doubled = nodeDouble();
  const transport = build({ openRequest: doubled.open });
  const answer = await transport.send(request());
  t.check("exactly one request was opened", doubled.seen.length === 1);
  const options = doubled.seen[0].options;
  t.check("to the host, port and path of the url, over https",
    options.hostname === "alpha.provider.invalid" && options.port === 443 && options.path === "/v1/answer" && options.protocol === "https:",
    JSON.stringify({ h: options.hostname, p: options.port, path: options.path }));
  t.check("carrying the headers the adapter built, and a length for the body it wrote",
    options.headers["content-type"] === "application/json" && options.headers["content-length"] === String(Buffer.byteLength(request().body)));
  t.check("and the body exactly as the adapter serialised it", doubled.seen[0].wrote === request().body);
  t.check("the deadline it was given is the deadline it uses", options.timeout === 5000 && doubled.seen[0].timeoutMs === 5000);
  t.check("what comes back is the status, the headers in one case, and the body",
    answer.status === 200 && answer.headers["content-type"] === "application/json" && answer.body === '{"ok":true}',
    JSON.stringify(answer));
}

t.section("a redirect is an answer, not an instruction");
{
  const doubled = nodeDouble({ answer: { status: 302, headers: { Location: "https://somewhere.else.invalid/v1/answer" }, chunks: [""] } });
  const transport = build({ openRequest: doubled.open });
  const answer = await transport.send(request());
  t.check("it is handed back unfollowed", answer.status === 302);
  t.check("and nothing was opened a second time — following one is how a request ends up somewhere nobody allowlisted",
    doubled.seen.length === 1, `${doubled.seen.length} requests`);
}

t.section("an answer too large stops being read");
{
  const doubled = nodeDouble({ answer: { status: 200, headers: {}, chunks: ["x".repeat(50), "y".repeat(50)] } });
  const transport = build({ openRequest: doubled.open, maximumResponseBytes: 60 });
  let cut = null;
  try { await transport.send(request()); } catch (error) { cut = error; }
  t.check("it is cut off rather than read to the end",
    cut instanceof TransportFault && /went past 60 bytes/.test(cut.message), cut?.message?.slice(0, 80));
  t.check("and it is NOT called a failure that sent nothing — the request had already gone",
    cut instanceof TransportFault && cut.beforeSubmission === false);
}

t.section("whether anything was sent is answered honestly, or conservatively");
{
  const refusedConnection = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  const before = nodeDouble({ failBeforeWrite: refusedConnection });
  let beforeError = null;
  try { await build({ openRequest: before.open }).send(request()); } catch (error) { beforeError = error; }
  t.check("a connection refused before a byte was written provably sent nothing",
    beforeError instanceof TransportFault && beforeError.beforeSubmission === true && /nothing was sent/.test(beforeError.message),
    beforeError?.message?.slice(0, 80));

  const reset = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
  const after = nodeDouble({ failAfterWrite: reset });
  let afterError = null;
  try { await build({ openRequest: after.open }).send(request()); } catch (error) { afterError = error; }
  t.check("a connection that died after the request went out is NOT called a failure that sent nothing",
    afterError instanceof TransportFault && afterError.beforeSubmission === false
    && /whether the work was done is not known/.test(afterError.message), afterError?.message?.slice(0, 90));

  const late = nodeDouble({ timeout: true });
  let lateError = null;
  try { await build({ openRequest: late.open }).send(request()); } catch (error) { lateError = error; }
  t.check("a deadline that passes after the request went out is an unknown outcome, not a free retry",
    lateError instanceof TransportFault && lateError.beforeSubmission === false
    && /no answer within 5000ms/.test(lateError.message), lateError?.message?.slice(0, 90));

  const broken = { open: () => { throw Object.assign(new Error("bad options"), { code: "ERR_INVALID_ARG_TYPE" }); } };
  let openError = null;
  try { await build({ openRequest: broken.open }).send(request()); } catch (error) { openError = error; }
  t.check("a request that could not even be opened sent nothing, and says so",
    openError instanceof TransportFault && openError.beforeSubmission === true);
}

t.section("nothing it says carries anything it was given");
{
  const doubled = nodeDouble({ failAfterWrite: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) });
  let thrown = null;
  try { await build({ openRequest: doubled.open }).send(request()); } catch (error) { thrown = error; }
  t.check("not the credential, not the body, not a header",
    !thrown.message.includes("not-a-real-credential") && !thrown.message.includes("something")
    && !JSON.stringify(thrown.cause ?? {}).includes("not-a-real-credential"), thrown.message.slice(0, 90));
}

t.section("every door stayed closed");
t.check("nothing in this file tried the network", tripped() === 0, `${tripped()} attempts`);

t.finish();
