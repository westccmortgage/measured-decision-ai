/* THE LINES THE RUNNER MAY NOT CROSS, CHECKED WITHOUT CROSSING THEM.
 *
 * Four of them, and each is a thing that would be invisible until it cost
 * something real:
 *
 *   · the clock budget must REFUSE an arrangement that cannot hold, rather
 *     than producing one and orphaning attempts to prove it;
 *   · no key may be read before the last check before submission;
 *   · the transport may not reach an origin no operator authorised;
 *   · a runner may not resolve material it cannot prove belongs to the
 *     workflow it is advancing.
 *
 * Nothing here opens a socket: the network is sealed by the same guard the
 * kernel's dry-run suites use, and the guard itself is checked at the end.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { harness, closeNetwork } from "../../core-v2/tests/harness.mjs";
import { invocationClock, ClockBudgetImpossible, EDGE_FUNCTION_LIFETIME_MS } from "../clock.ts";
import { policyForClock } from "../runner.ts";
import { seedOfSourceUri, sourceSetOfRecord, syntheticSourceSet, SourceSetUnreadable, SYNTHETIC_SCHEME } from "../source-set.ts";
import { asToken, line, operational } from "../../../supabase/functions/core-v2-runner/log.ts";
import { DenoFetchTransport } from "../../../supabase/functions/_shared/core-v2/deno-transport.ts";
import { NetworkNotAuthorized, TransportFault } from "../../core-v2-runtime/transport/transport.ts";
import { entityId } from "../../core-v2/kernel/ids.ts";

const tripped = closeNetwork();
const t = harness("the lines the runner may not cross");
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
const read = (path) => readFileSync(join(ROOT, path), "utf8");

t.section("one clock, and the arrangements it refuses");
{
  const edge = invocationClock({ lifetimeMs: EDGE_FUNCTION_LIFETIME_MS });
  t.check("the Edge Runtime's own lifetime produces a budget that holds",
    edge.stopLeasingMs > 0 && edge.taskLeaseMs > 0, JSON.stringify(edge.describe()));

  /* THE RULE THE CANARY LEARNED BY LOSING READINGS TO IT. */
  t.check("a task lease never outlives the operator that owns it by more than the grace",
    edge.taskLeaseMs <= edge.deadlineMs + edge.graceMs,
    `${edge.taskLeaseMs}ms lease vs ${edge.deadlineMs}ms of life`);
  t.check("the moment to stop leasing leaves room for one whole answer AND writing it down",
    edge.stopLeasingMs + edge.answerWithinMs + edge.settlementRoomMs <= edge.deadlineMs);
  t.check("the runner's own hold outlives the invocation, so no second runner walks in mid-pass",
    edge.runnerHoldMs >= edge.deadlineMs);
  t.check("a heartbeat can keep a task lease alive with room to spare",
    edge.taskLeaseMs > edge.heartbeatIntervalMs * 2);

  const refuses = (label, request, expect) => {
    let thrown = null;
    try { invocationClock(request); } catch (error) { thrown = error; }
    t.check(label, thrown instanceof ClockBudgetImpossible && (!expect || new RegExp(expect).test(String(thrown.message))),
      thrown ? String(thrown.message).slice(0, 120) : "it was allowed");
  };
  refuses("a lifetime with no room to start anything is refused, not shipped",
    { lifetimeMs: 20_000, answerWithinMs: 60_000, settlementRoomMs: 20_000 }, "no moment at which work could be started");
  refuses("a lifetime entirely consumed by its own safety margin is refused",
    { lifetimeMs: 5_000, safetyMs: 5_000 }, "leaves no time at all");
  refuses("a negative wait is refused", { lifetimeMs: 150_000, answerWithinMs: -1 }, "above zero");
  refuses("a lifetime that is not a number is refused", { lifetimeMs: Number.NaN }, "above zero");

  /* A short-lived operator gets a SHORTER lease, never a longer one. */
  const brief = invocationClock({ lifetimeMs: 30_000, safetyMs: 1_000, answerWithinMs: 8_000, settlementRoomMs: 4_000, graceMs: 2_000 });
  t.check("a shorter-lived operator authorises a shorter lease, not the same one",
    brief.taskLeaseMs < edge.taskLeaseMs || brief.taskLeaseMs <= brief.deadlineMs + brief.graceMs,
    `${brief.taskLeaseMs} vs ${edge.taskLeaseMs}`);

  const policy = policyForClock(edge);
  t.check("the scheduler is handed the clock's waits and not another set",
    policy.attemptTimeoutMs === edge.answerWithinMs
    && policy.settlementAllowanceMs === edge.settlementRoomMs
    && policy.heartbeatIntervalMs === edge.heartbeatIntervalMs,
    JSON.stringify({ a: policy.attemptTimeoutMs, s: policy.settlementAllowanceMs, h: policy.heartbeatIntervalMs }));
}

t.section("(13) no key is read before the last check before submission");
{
  /* Read as text, because the claim is about what the code CAN do, not about
     what one execution happened to do. */
  const runner = read("workers/core-v2-runner/runner.ts");
  const clock = read("workers/core-v2-runner/clock.ts");
  const continuations = read("workers/core-v2-runner/continuations.ts");
  const sourceSet = read("workers/core-v2-runner/source-set.ts");
  const tick = read("supabase/functions/core-v2-runner-tick/index.ts");
  const door = read("supabase/functions/core-v2-runner/index.ts");

  const KEY_SHAPED = /API_KEY|apiKey|ANTHROPIC|OPENAI|GEMINI|GOOGLE_API|x-api-key|authorization:\s*`Bearer/i;
  for (const [name, text] of [
    ["the runner", runner], ["the clock", clock], ["the continuation store", continuations],
    ["the source set", sourceSet], ["the human door", door],
  ]) {
    t.check(`${name} never names a provider key`, !KEY_SHAPED.test(text),
      (text.match(KEY_SHAPED) ?? [""])[0]);
  }
  t.check("the machine door does not name one either", !KEY_SHAPED.test(tick),
    (tick.match(KEY_SHAPED) ?? [""])[0]);

  /* Where a key IS read: exactly one line in this repository, and it is the
     step after every check that can be made without one. */
  const sealed = read("workers/core-v2-runtime/providers/provider.ts");
  const reads = sealed.split("\n").filter((l) => /this\.environment\[this\.configuration\.apiKeyEnvironmentVariable\]/.test(l));
  t.check("a key is read in exactly one line of the whole engine", reads.length === 1, `${reads.length} lines`);
  const before = sealed.slice(0, sealed.indexOf(reads[0]));
  /* The file numbers its own steps. A key is step 7, and steps 1 to 6 —
     assembly, the four gates, the deadline, the material, the provider's
     capabilities, the words — are all above it. Checked by the numbering
     rather than by guessing at identifiers, so a rename cannot quietly turn
     this green. */
  const stepLine = (no) => sealed.split("\n").findIndex((l) => l.includes(`/* ${no}.`));
  const keyLine = sealed.split("\n").findIndex((l) => l.includes(reads[0]));
  for (const step of [1, 2, 3, 4, 5, 6]) {
    const at = stepLine(step);
    t.check(`step ${step} happens before a key is read`, at > 0 && at < keyLine, `step ${step} at ${at}, key at ${keyLine}`);
  }
  t.check("and the step the key belongs to says so in its own words",
    /THE LAST THING BEFORE THE REQUEST IS BUILT is the key/.test(sealed));

  const world = read("workers/core-v2-runner/world.ts");
  t.check("the world the runner is handed reads no key itself — it hands the environment on",
    !/apiKey\s*[:=]\s*["'`]/.test(world) && /environment/.test(world));
}

t.section("(14) the transport cannot reach an origin nobody authorised");
{
  const authorised = {
    providers: [{
      providerId: "alpha", baseUrl: "https://alpha.example",
      apiKeyEnvironmentVariable: "CORE_V2_DEMONSTRATION_KEY_ALPHA",
      models: ["alpha-1"], defaultModel: "alpha-1",
      maximumInputTokens: 8192, maximumOutputTokens: 4096, requestTimeoutMs: 30_000,
      maximumMaterialBytes: 1024, maximumMaterialBytesPerItem: 1024,
      supportedMediaTypes: ["text/plain; charset=utf-8"],
      capabilities: { "alpha-1": { forcedToolChoice: true, strictSchema: true, images: false, thinking: "optional" } },
    }],
    pricing: [{
      providerId: "alpha", model: "alpha-1", effectiveFrom: "2026-01-01", currency: "USD",
      inputPerMillionTokens: 1, cachedInputPerMillionTokens: 0.1,
      cacheWritePerMillionTokens: 1, outputPerMillionTokens: 5, reasoningPerMillionTokens: 5,
    }],
    authorization: {
      providerNetworkFlag: true, environmentGate: true, maximumAuthorizedCost: 1, currency: "USD",
      providerAllowlist: ["alpha"], modelAllowlist: ["alpha-1"],
    },
  };
  const never = () => { throw new Error("this suite sends nothing"); };
  const publicOnly = async () => ["203.0.113.9"];
  const transport = new DenoFetchTransport({ config: authorised, resolve: publicOnly, fetch: never });

  const refused = async (label, url) => {
    let error = null;
    try {
      await transport.send({ method: "POST", url, headers: {}, body: "{}", timeoutMs: 500 });
    } catch (caught) { error = caught; }
    t.check(label, error instanceof TransportFault && error.beforeSubmission === true,
      error ? `${error.constructor.name}: ${String(error.message).slice(0, 80)}` : "it was allowed");
  };
  await refused("an origin no operator declared is refused before a byte could leave", "https://elsewhere.example/v1/messages");
  await refused("and so is the same host on another port", "https://alpha.example:8443/v1/messages");
  await refused("and plain http, whoever asks", "http://alpha.example/v1/messages");

  let built = null;
  try {
    new DenoFetchTransport({
      config: { ...authorised, authorization: { ...authorised.authorization, providerNetworkFlag: false } },
      resolve: publicOnly, fetch: never,
    });
  } catch (error) { built = error; }
  t.check("and with the network flag off no transport exists to reach anything with",
    built instanceof NetworkNotAuthorized, built ? String(built.message).slice(0, 80) : "it was built");
}

t.section("(11) a workflow's material is rebuilt from its own record, or not at all");
{
  const organizationId = entityId("organization", "boundaries");
  const one = syntheticSourceSet({ seed: "isolation/one" }, organizationId);
  const two = syntheticSourceSet({ seed: "isolation/two" }, organizationId);

  t.check("a source names the set it belongs to, so a later runner can rebuild exactly it",
    one.manifest.sources.every((s) => s.uri.startsWith(SYNTHETIC_SCHEME)), one.manifest.sources[0]?.uri ?? "");
  t.check("and the seed survives the round trip",
    seedOfSourceUri(one.manifest.sources[0].uri) === "isolation/one", String(seedOfSourceUri(one.manifest.sources[0].uri)));
  t.check("two source sets share no content hash at all",
    one.manifest.sources.every((s) => !two.manifest.sources.some((o) => o.contentHash === s.contentHash)));

  const recordedFor = (set) => set.manifest.sources.map((s) => ({ ordinal: s.ordinal, uri: s.uri, contentHash: s.contentHash }));

  const rebuilt = sourceSetOfRecord("w-1", organizationId, recordedFor(one));
  t.check("a runner rebuilds the right material from the record alone",
    rebuilt.manifest.sources.every((s, i) => s.contentHash === one.manifest.sources[i].contentHash));
  t.check("and it holds the bytes those hashes name", rebuilt.material.size > 0, String(rebuilt.material.size));

  const refuses = (label, recorded, expect) => {
    let thrown = null;
    try { sourceSetOfRecord("w-2", organizationId, recorded); } catch (error) { thrown = error; }
    t.check(label, thrown instanceof SourceSetUnreadable && (!expect || thrown.reasons.some((r) => new RegExp(expect).test(r))),
      thrown ? thrown.reasons.join(" · ").slice(0, 120) : "it was allowed");
  };

  /* THE CANARY'S WORST HOUR, MADE IMPOSSIBLE. One seed's name over another
     seed's hashes: silently wrong before, a refusal now. */
  refuses("a record whose hashes do not match the seed it names is refused",
    one.manifest.sources.map((s, i) => ({ ordinal: s.ordinal, uri: s.uri, contentHash: two.manifest.sources[i].contentHash })),
    "different bytes than the record says");
  refuses("a record naming two source sets is refused",
    [
      { ordinal: 0, uri: one.manifest.sources[0].uri, contentHash: one.manifest.sources[0].contentHash },
      { ordinal: 1, uri: two.manifest.sources[0].uri, contentHash: two.manifest.sources[0].contentHash },
    ], "different source sets");
  refuses("a source this runner cannot rebuild is refused by name, not guessed at",
    [{ ordinal: 0, uri: "s3://a-bucket/somebodys-plans.pdf", contentHash: "0".repeat(64) }],
    "not a source set this runner can rebuild");
  refuses("and a workflow with no sources at all is refused", [], "no sources at all");

  /* The refusal says the scheme and nothing else: a uri may be somebody's. */
  let leaked = null;
  try { sourceSetOfRecord("w-3", organizationId, [{ ordinal: 0, uri: "s3://a-bucket/somebodys-plans.pdf", contentHash: "0".repeat(64) }]); }
  catch (error) { leaked = error; }
  t.check("and the refusal repeats no part of the name but its scheme",
    !/somebodys-plans|a-bucket/.test(String(leaked?.message ?? "")), String(leaked?.message ?? "").slice(0, 100));
}

t.section("a log line carries ids and never content");
{
  t.check("an id passes through", operational("7db0842a-8669-51bb-a373-a3f40e8dc5ac") === "7db0842a-8669-51bb-a373-a3f40e8dc5ac");
  t.check("a state passes through", operational("outcome_unknown") === "outcome_unknown");
  t.check("a number passes through", operational(1234) === 1234);
  t.check("a sentence from a source does not",
    operational("E-001     beta       5         kg") === "[not operational]");
  t.check("nor does anything shaped like a credential",
    operational("sk-ant-api03-abcdefghijklmnop") === "[not operational]");
  t.check("nor a prompt", operational("── the assignment ──\ntaskId: 1") === "[not operational]");
  t.check("nor an object", operational({ prompt: "read this" }) === "[not operational]");
  /* THE ONE THING A LOG MAY SAY ABOUT A FAILURE.
     `problem: "Error"` is not a diagnosis, so an error message is flattened
     to one machine word — and the flattening must not become a hole in the
     rule above. Prose stops being prose; a credential stays refused. */
  t.check("a failure message becomes one machine word, and keeps its meaning",
    asToken("core-v2: stored material could not be read (404)")
      === "core-v2:_stored_material_could_not_be_read_404", String(asToken("core-v2: stored material could not be read (404)")));
  t.check("with no spaces, quotes or punctuation left in it",
    /^[A-Za-z0-9_.:/@+-]+$/.test(String(asToken("relation \"public.thing\" does not exist"))),
    String(asToken('relation "public.thing" does not exist')));
  t.check("a message carrying something worth stealing is still refused whole",
    asToken("failed with sk-ant-api03-abcdefghijklmnop") === "[not operational]");
  t.check("and so is one that only mentions a key",
    asToken("no api_key_abcdefghij in the environment") === "[not operational]");
  t.check("a message longer than a log line is cut, not dropped",
    String(asToken("z".repeat(400))).length === 120);
  t.check("and nothing at all stays nothing", asToken("") === null && asToken(undefined) === null);

  const emitted = JSON.parse(line({ fn: "core-v2-runner-tick", workflow: "abc-123", quoted: "E-001 beta 5 kg", n: 3 }));
  t.check("a line always says when it was written", typeof emitted.at === "string" && emitted.at.length > 10);
  t.check("and refuses the content while keeping the ids",
    emitted.workflow === "abc-123" && emitted.n === 3 && emitted.quoted === "[not operational]",
    JSON.stringify(emitted));
}

t.check("nothing in this suite tried to open a socket", tripped() === 0, `guard tripped ${tripped()} times`);

/* ─────────────────────────────────────── A DOOR A BROWSER CAN ACTUALLY OPEN
 *
 * A door that answers 405 to OPTIONS has not refused anybody: it has made
 * itself unreachable from every page while still answering curl perfectly.
 * The analysis door shipped that way once, and this is why it cannot again.
 */
t.section("the two human doors answer the question a browser asks first");
{
const tick = read("supabase/functions/core-v2-runner-tick/index.ts");
const door = read("supabase/functions/core-v2-runner/index.ts");
const analysis = read("supabase/functions/core-v2-analysis/index.ts");
const cors = read("supabase/functions/_shared/core-v2/cors.ts");
for (const [name, text] of [["the human door", door], ["the analysis door", analysis]]) {
  t.check(`${name} answers the preflight before it refuses a method`,
    /request\.method === "OPTIONS"/.test(text)
    && text.indexOf('request.method === "OPTIONS"') < text.indexOf('request.method !== "POST"'),
    "OPTIONS must be answered above the POST-only refusal");
  t.check(`${name} stamps every answer, not only the preflight`,
    /corsHeaders\(asking\)/.test(text));
}
t.check("the machine door does NOT open itself to a browser — nothing on a page calls it",
  !/access-control-allow-origin/i.test(tick) && !/corsHeaders/.test(tick));
t.check("the allowed origins are this product's own, a developer's machine, and this site's deploys",
  cors.includes("https://measureddecision.ai") && cors.includes("measureddecisionai") && cors.includes("localhost"));
t.check("and the deploy pattern is anchored at both ends, so a lookalike host is not this site",
  cors.includes("^https:\\/\\/") && cors.includes("netlify\\.app$"));
}

t.finish();
