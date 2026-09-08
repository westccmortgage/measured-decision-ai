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

const providerAt = (baseUrl) => ({
  providerId: "one", baseUrl, apiKeyEnvironmentVariable: "CORE_V2_TEST_KEY", models: ["reader"], defaultModel: "reader",
  maximumOutputTokens: 1024, maximumInputTokens: 1000, requestTimeoutMs: 30000,
  maximumMaterialBytes: 1024, maximumMaterialBytesPerItem: 1024, supportedMediaTypes: ["text/plain"],
  capabilities: { reader: { forcedToolChoice: true, strictSchema: true, images: false, thinking: "optional" } },
});

const configWith = (authorization, baseUrl = "https://alpha.provider.invalid") => ({
  providers: [providerAt(baseUrl)],
  pricing: [{ providerId: "one", model: "reader", effectiveFrom: "2026-01-01", currency: "USD", inputPerMillionTokens: 3, outputPerMillionTokens: 15 }],
  authorization,
  dispatcherName: "https-tests",
});

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
  t.check("and the only places it may go are the ones an operator configured",
    JSON.stringify(built.allowedHosts) === JSON.stringify(["alpha.provider.invalid"]), built.allowedHosts.join(","));
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
    ["a host no configured provider uses", { url: "https://somewhere.else.invalid/v1/answer" }, /not a host any configured provider uses/],
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
  t.check("the addresses nothing outside may be reached at are known for what they are",
    !isPublicAddress("127.0.0.1") && !isPublicAddress("10.1.2.3") && !isPublicAddress("192.168.0.9")
    && !isPublicAddress("169.254.169.254") && !isPublicAddress("172.16.4.4") && !isPublicAddress("100.100.0.1")
    && !isPublicAddress("::1") && !isPublicAddress("fd00::1") && !isPublicAddress("::ffff:127.0.0.1")
    && isPublicAddress("203.0.113.10") && isPublicAddress("2606:4700::1111"));

  const doubled = nodeDouble();
  const inside = build({ openRequest: doubled.open, lookup: async () => ["203.0.113.10", "169.254.169.254"] });
  let refused = null;
  try { await inside.send(request()); } catch (error) { refused = error; }
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
