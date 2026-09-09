/* THE CANARY'S DOOR, CHECKED WITHOUT OPENING IT.
 *
 * The hosted run cannot use the authorised node transport: Deno's fetch has
 * no seam for "connect to THIS address", so the pin that closes the
 * rebinding gap cannot be reproduced. What CAN be reproduced is everything
 * else, and this suite is the proof that it was — against the same
 * networkAuthorizationProblems, the same httpsOrigin and the same
 * isPublicAddress the authorised transport uses.
 *
 * Both seams are replaced, so nothing here opens a socket.
 */
import { harness, closeNetwork } from "../../core-v2/tests/harness.mjs";
import { DenoFetchTransport } from "../../../supabase/functions/core-v2-canary/deno-transport.ts";
import { NetworkNotAuthorized, TransportFault } from "../../core-v2-runtime/transport/transport.ts";
import { authorizedConfig, loadOperatorRegistry } from "../operator-registry.ts";
import { readFileSync } from "node:fs";

const tripped = closeNetwork();
const t = harness("the canary's door, checked without opening it");

const declared = readFileSync(new URL("../registry.canary.json", import.meta.url), "utf8");
const { registry, problems } = loadOperatorRegistry(declared, "registry.canary.json");
t.check("the operator's own registry loads", registry !== null, problems.join(" · ").slice(0, 200));

const open = authorizedConfig(registry, { networkFlag: true, environment: { CORE_V2_ALLOW_PAID_CALLS: "true" } });
const shut = authorizedConfig(registry, { networkFlag: false, environment: {} });

const never = () => { throw new Error("this suite sends nothing"); };
const publicOnly = async () => ["203.0.113.7"];
const make = (over = {}) => new DenoFetchTransport({ config: open, resolve: publicOnly, fetch: never, ...over });

/* A fetch that answers, so the reading half can be checked. */
const answering = (status, body, headers = {}) => async () => new Response(body, { status, headers });

t.section("it refuses to exist unless every authorization is in place");
{
  let refused = null;
  try { new DenoFetchTransport({ config: shut, resolve: publicOnly, fetch: never }); }
  catch (error) { refused = error; }
  t.check("a transport without the gates cannot be built", refused instanceof NetworkNotAuthorized,
    refused ? String(refused.message).slice(0, 70) : "it was built");
  t.check("and it says every reason, not the first", (refused?.refusals ?? []).length >= 2, String((refused?.refusals ?? []).length));
}

t.section("where it may go");
{
  const transport = make();
  t.check("one normalised origin per authorised provider, with the effective port",
    transport.allowedOrigins.join(", ") === [
      "https://api.anthropic.com:443",
      "https://api.openai.com:443",
      "https://generativelanguage.googleapis.com:443",
    ].join(", "), transport.allowedOrigins.join(", "));
}

const sending = (transport, over = {}) => transport.send({
  method: "POST", url: "https://api.openai.com/v1/responses", headers: { "x-api-key": "not-a-key" },
  body: "{}", timeoutMs: 1000, ...over,
});

const refusedBy = async (label, fn, { before }) => {
  let error = null;
  try { await fn(); } catch (caught) { error = caught; }
  t.check(label, error instanceof TransportFault && error.beforeSubmission === before,
    error ? `${error.constructor.name} beforeSubmission=${error.beforeSubmission}: ${String(error.message).slice(0, 80)}` : "it was allowed");
};

t.section("what it refuses before a byte could leave");
await refusedBy("a host that is not an authorised origin",
  () => sending(make(), { url: "https://api.example.net/v1/x" }), { before: true });
await refusedBy("the right host on the wrong port is a different origin",
  () => sending(make(), { url: "https://api.openai.com:8443/v1/x" }), { before: true });
await refusedBy("plain http", () => sending(make(), { url: "http://api.openai.com/v1/x" }), { before: true });
await refusedBy("a credential written into the address",
  () => sending(make(), { url: "https://user:pw@api.openai.com/v1/x" }), { before: true });
await refusedBy("a request over the size limit",
  () => sending(make({ maximumRequestBytes: 8 }), { body: "0123456789" }), { before: true });
await refusedBy("a request already cancelled",
  () => sending(make(), { signal: AbortSignal.abort() }), { before: true });
await refusedBy("a name that resolves to nothing",
  () => sending(make({ resolve: async () => [] })), { before: true });
await refusedBy("a name that resolves to an address inside this network",
  () => sending(make({ resolve: async () => ["10.0.0.5"] })), { before: true });
await refusedBy("one bad address among good ones refuses the whole set",
  () => sending(make({ resolve: async () => ["203.0.113.7", "127.0.0.1"] })), { before: true });
await refusedBy("an answer that is not an address at all",
  () => sending(make({ resolve: async () => ["not-an-address"] })), { before: true });

t.section("what it says when it cannot know");
{
  const transport = make({ fetch: async () => { throw new TypeError("error sending request"); } });
  await refusedBy("a fetch that failed is an outcome nobody knows, never \"nothing was sent\"",
    () => sending(transport), { before: false });
}
{
  const big = "x".repeat(64);
  const transport = make({ maximumResponseBytes: 8, fetch: answering(200, big) });
  await refusedBy("an answer past the cap is cut off, and the outcome is unknown",
    () => sending(transport), { before: false });
}

t.section("what it does with an answer");
{
  const transport = make({ fetch: answering(200, '{"ok":true}', { "content-type": "application/json", "X-Request-Id": "req-1" }) });
  const answer = await sending(transport);
  t.check("the status, the body and lower-cased headers come back",
    answer.status === 200 && answer.body === '{"ok":true}' && answer.headers["x-request-id"] === "req-1",
    JSON.stringify(answer).slice(0, 120));
}
{
  const transport = make({ fetch: answering(302, "", { location: "https://elsewhere.invalid/" }) });
  const answer = await sending(transport);
  t.check("a redirect is an answer, handed back unfollowed",
    answer.status === 302 && answer.headers.location === "https://elsewhere.invalid/");
}
{
  let sawRedirectMode = null;
  const transport = make({ fetch: async (_url, init) => { sawRedirectMode = init.redirect; return new Response("{}", { status: 200 }); } });
  await sending(transport);
  t.check("and it asked fetch not to follow one", sawRedirectMode === "manual", String(sawRedirectMode));
}
{
  const transport = make({ resolve: async () => null, fetch: answering(200, "{}") });
  await sending(transport);
  t.check("a runtime that will not resolve is recorded, not pretended about",
    transport.unresolvedHosts.join(",") === "api.openai.com", transport.unresolvedHosts.join(","));
}

t.section("what it never says out loud");
{
  let seen = null;
  const transport = make({ fetch: async (_url, init) => { seen = init.headers; return new Response("{}", { status: 200 }); } });
  await sending(transport);
  t.check("the credential header is passed to fetch and to nothing else",
    seen["x-api-key"] === "not-a-key" && seen["content-length"] === "2", JSON.stringify(seen));
}

t.check("nothing in this suite tried to open a socket", tripped() === 0, `guard tripped ${tripped()} times`);
t.finish();
