/* ONE WHOLE WORKFLOW, OFFLINE, THROUGH EVERYTHING THAT WOULD COST MONEY.
 *
 * Every other suite in this package holds one piece still and pushes on it.
 * This one runs the whole thing: a command committed to the outbox, a real
 * dispatcher that claims it, the real kernel scheduler, the real Postgres
 * record on a throwaway cluster with every migration applied, the durable
 * budget of migration 059 on the path the work actually takes, and all three
 * real provider adapters — the same files that would talk to the three things
 * that answer for money.
 *
 * What is not real is the wire. Each adapter is handed a transport that
 * answers in that provider's own response shape, from a truth this file
 * invented from a seed. Nothing leaves the process: every door out is shut
 * before the first workflow is enqueued, and the only socket anything may
 * open is the unix socket of the local cluster. The three addresses are under
 * .invalid, which resolves nowhere by definition, so even a leak would reach
 * nobody. No key exists, no provider is contacted, and the external cost of
 * this file is zero.
 *
 * The scenario is the one the engine exists for. Two blind readings of one
 * table, from two different providers, agree on a falsehood. Agreement makes
 * them corroborated and nothing more; a critic in the third provider's domain
 * reopens the source and contradicts both; the dispute is verified once more
 * at the claims' own anchors, adjudicated by an arbiter that is shown the
 * dispute and nothing else, and the correction — not either reading — is what
 * a decision ends up citing. Both false readings end rejected.
 *
 * Then it is done again with the dispatcher thrown away mid-run, and a third
 * time with a socket that dies after the request left, which is the case
 * where the honest answer is "nobody knows" and the money stays held.
 */
import child_process from "node:child_process";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import tls from "node:tls";

import { harness } from "../../core-v2/tests/harness.mjs";
import { ensureCluster, withThrowawayDatabase, HARNESS_LOCATION } from "../../core-v2/tests/postgres-harness.mjs";
import { WireClient } from "../../core-v2/postgres/wire.ts";
import { PostgresOrchestrationRepository } from "../../core-v2/postgres/repository.ts";
import { InMemoryOrchestrationRepository } from "../../core-v2/kernel/memory-repository.ts";
import { syntheticRecordSet } from "../../core-v2/domains/synthetic-records/fixture.ts";
import { SyntheticRecordsPack, TASK } from "../../core-v2/domains/synthetic-records/pack.ts";
import { mockExecutors, packResponders } from "../../core-v2/domains/synthetic-records/mocks.ts";
import { assemble, manualClock } from "../../core-v2/domains/simulate.ts";
import { KERNEL_TASK_TYPES } from "../../core-v2/kernel/contracts.ts";
import { INDEPENDENCE_GROUPS } from "../../core-v2/kernel/domain.ts";
import { entityId } from "../../core-v2/kernel/ids.ts";
import { locatorInside } from "../../core-v2/kernel/locators.ts";
import { RoleRegistry } from "../../core-v2/kernel/roles.ts";
import { TERMINAL_TASK_STATES } from "../../core-v2/kernel/transitions.ts";
import { Dispatcher, enqueueWorkflow } from "../dispatcher.ts";
import { compilePrompt } from "../prompt-compiler.ts";
import { buildProviderRegistry } from "../providers/registry.ts";
import { BudgetLedger } from "../budget/ledger.ts";
import { meteredRepository } from "../budget/metered.ts";
import { TransportFault } from "../transport/transport.ts";

/* ═════════════════════════════════════════════ every door but one, shut */

/* The engine's own guard cannot be used here: it shuts `net` completely, and
   the record this test is about lives on the other end of a unix socket. So
   the same doors are shut by hand, and the one that has to stay open is
   narrowed to a path on this machine and counted. child_process stays open
   because the harness starts and inspects the local cluster with it — the
   database suites of the engine seal nothing at all, so this is strictly the
   stricter of the two. */
function closeEveryDoorButTheLocalSocket() {
  let tried = 0;
  const refuse = (door) => function refused() {
    tried++;
    throw new Error(`core-v2-runtime: the network is closed in this test (${door})`);
  };
  const seal = (target, name, door) => {
    if (!(name in target)) return;
    Object.defineProperty(target, name, { value: refuse(door), writable: false, configurable: false, enumerable: true });
  };
  seal(globalThis, "fetch", "fetch");
  seal(globalThis, "WebSocket", "WebSocket");
  seal(http, "request", "http.request"); seal(http, "get", "http.get");
  seal(https, "request", "https.request"); seal(https, "get", "https.get");
  seal(tls, "connect", "tls.connect");
  seal(dns, "lookup", "dns.lookup"); seal(dns, "resolve", "dns.resolve");
  seal(dns.promises, "lookup", "dns.promises.lookup"); seal(dns.promises, "resolve", "dns.promises.resolve");

  /* A socket may be opened only onto a path. net.connect and
     net.createConnection both end here, so one guard covers all three. */
  const realConnect = net.Socket.prototype.connect;
  const onlyLocal = function connect(...args) {
    /* node normalises its own arguments before it gets here, so the first one
       is the options object, a path, or the [options, callback] pair the
       internal helper builds. All three are unwrapped the same way. */
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    const path = typeof first === "string" ? first : (first && typeof first === "object" ? first.path : null);
    if (typeof path !== "string" || !path.startsWith("/")) {
      tried++;
      throw new Error("core-v2-runtime: the only socket this test may open is the unix socket of the throwaway cluster");
    }
    return realConnect.apply(this, args);
  };
  Object.defineProperty(net.Socket.prototype, "connect", { value: onlyLocal, writable: false, configurable: false });
  syncBuiltinESMExports();
  return () => tried;
}

const t = harness("one whole workflow, offline, through three provider adapters and a real record");

/* ═════════════════════════════════════════════════ who answers, and how */

/* Not credentials. Strings of about the right shape, invented here, put in a
   map that is handed to the adapters — so "was a key read from the process
   environment" is a question this file can answer with "there was none". */
const KEYS = {
  CORE_V2_E2E_KEY_ALPHA: "synthetic-not-a-credential-alpha",
  CORE_V2_E2E_KEY_BETA: "synthetic-not-a-credential-beta",
  CORE_V2_E2E_KEY_GAMMA: "synthetic-not-a-credential-gamma",
};

const OUTPUT_CEILING = 4096;
const INPUT_CEILING = 60_000;
/* What each answer reports it used. Fixed, so what the ledger settles is a
   number this file can name rather than one it has to read back and trust. */
const REPORTED_INPUT = 1000;
const REPORTED_OUTPUT = 200;

const PROVIDERS = [
  {
    providerId: "anthropic", baseUrl: "https://alpha.provider.invalid", environmentVariable: "CORE_V2_E2E_KEY_ALPHA",
    model: "alpha-reader-1", reported: "alpha-reader-1-2026-04-01",
    promptOf: (body) => body.messages[0].content[0].text,
    systemOf: (body) => body.system,
    answer: (envelope, mark) => json({
      id: `msg_alpha_${mark}`, type: "message", role: "assistant", model: "alpha-reader-1-2026-04-01",
      stop_reason: "tool_use", stop_sequence: null,
      content: [{ type: "tool_use", id: `toolu_${mark}`, name: "result_envelope", input: envelope }],
      usage: { input_tokens: REPORTED_INPUT, output_tokens: REPORTED_OUTPUT, cache_read_input_tokens: 0 },
    }, { "request-id": `req_alpha_${mark}` }),
  },
  {
    providerId: "openai", baseUrl: "https://beta.provider.invalid", environmentVariable: "CORE_V2_E2E_KEY_BETA",
    model: "beta-reader-1", reported: "beta-reader-1-2026-05-12",
    promptOf: (body) => body.input[0].content[0].text,
    systemOf: (body) => body.instructions,
    answer: (envelope, mark) => json({
      id: `resp_beta_${mark}`, object: "response", model: "beta-reader-1-2026-05-12", status: "completed", incomplete_details: null,
      output: [{ id: `msg_${mark}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify(envelope) }] }],
      usage: {
        input_tokens: REPORTED_INPUT, output_tokens: REPORTED_OUTPUT, total_tokens: REPORTED_INPUT + REPORTED_OUTPUT,
        input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 },
      },
    }, { "x-request-id": `req_beta_${mark}` }),
  },
  {
    providerId: "google", baseUrl: "https://gamma.provider.invalid", environmentVariable: "CORE_V2_E2E_KEY_GAMMA",
    model: "gamma-reader-1", reported: "gamma-reader-1-002",
    promptOf: (body) => body.contents[0].parts[0].text,
    systemOf: (body) => body.systemInstruction.parts[0].text,
    answer: (envelope, mark) => json({
      responseId: `rsp_gamma_${mark}`, modelVersion: "gamma-reader-1-002",
      candidates: [{ index: 0, finishReason: "STOP", content: { role: "model", parts: [{ text: JSON.stringify(envelope) }] } }],
      usageMetadata: {
        promptTokenCount: REPORTED_INPUT, candidatesTokenCount: REPORTED_OUTPUT, cachedContentTokenCount: 0,
        thoughtsTokenCount: 0, totalTokenCount: REPORTED_INPUT + REPORTED_OUTPUT,
      },
    }),
  },
];

function json(body, headers = {}) {
  return { status: 200, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) };
}

/* Six abstract families onto three providers. The two blind lanes land on two
   different providers; the third is left free so that a critic, a verifier
   and an arbiter can be in a domain that did not make what they judge. */
const ROUTING = {
  "reader-family-one": "anthropic",
  "reader-family-two": "openai",
  "reader-family-three": "google",
  "critic-family-one": "google",
  "critic-family-two": "anthropic",
  "arbiter-family-one": "google",
};
const providerOfFamily = (family) => ROUTING[family] ?? null;

const configurationOf = (p) => ({
  providerId: p.providerId, baseUrl: p.baseUrl, apiKeyEnvironmentVariable: p.environmentVariable,
  models: [p.model], defaultModel: p.model,
  maximumOutputTokens: OUTPUT_CEILING, maximumInputTokens: INPUT_CEILING, requestTimeoutMs: 30_000,
});

const INPUT_RATE = 3;
const OUTPUT_RATE = 15;
const pricingOf = (p) => ({
  providerId: p.providerId, model: p.model, effectiveFrom: "2026-01-01", currency: "USD",
  inputPerMillionTokens: INPUT_RATE, outputPerMillionTokens: OUTPUT_RATE,
  cachedInputPerMillionTokens: 0.3, reasoningPerMillionTokens: OUTPUT_RATE,
});

/* All four gates open — and even so nothing can be sent, because the only
   transport any adapter is given answers from this file. That is the division
   the whole package rests on: authorisation says a call is permitted, a
   transport says whether one is possible, and a test opens the first and
   never the second. */
const RUNTIME_CONFIG = {
  providers: PROVIDERS.map(configurationOf),
  pricing: PROVIDERS.map(pricingOf),
  authorization: {
    providerNetworkFlag: true, environmentGate: true, maximumAuthorizedCost: 10, currency: "USD",
    providerAllowlist: PROVIDERS.map((p) => p.providerId), modelAllowlist: PROVIDERS.map((p) => p.model),
  },
  dispatcherName: "core-v2-e2e",
};

/* What one attempt holds, and what one attempt settles at, from the numbers
   above rather than from what the code happens to do. */
const HOLD_PER_ATTEMPT = round6((INPUT_CEILING / 1e6) * INPUT_RATE + (OUTPUT_CEILING / 1e6) * OUTPUT_RATE);
const COST_PER_ATTEMPT = round6((REPORTED_INPUT / 1e6) * INPUT_RATE + (REPORTED_OUTPUT / 1e6) * OUTPUT_RATE);
function round6(n) { return Math.round(n * 1e6) / 1e6; }

/* ═══════════════════════════════════════════════ the worlds and the wire */

const pack = new SyntheticRecordsPack();
const roles = new RoleRegistry(pack);

/* Every workflow this file invents, by id: the truth its readers read from,
   how they are told to misbehave, and which requests never come back. */
const worlds = new Map();
/* Every packet the compiler was asked to turn into words, by task. The fake
   providers answer from these: the prompt is prose, so a transport finds the
   task id written in it and looks the packet up rather than parsing English. */
const packets = new Map();

const responders = new Map();
function respondersFor(world) {
  if (!responders.has(world.workflowId)) responders.set(world.workflowId, packResponders(world.truth));
  return responders.get(world.workflowId);
}

/* The compiler the adapters are given: the real one, with the packet kept. */
const compile = (packet) => {
  packets.set(packet.taskId, packet);
  return compilePrompt(packet, roles.role(packet.roleKey));
};

function answerFor(packet) {
  const world = worlds.get(packet.workflowId);
  if (!world) throw new Error(`the test has no world for ${packet.workflowId}`);
  const responder = respondersFor(world)[packet.roleKey];
  if (!responder) throw new Error(`the pack has no behaviour for ${packet.roleKey}`);
  const base = responder(packet);
  return world.script ? world.script(packet, base) : base;
}

/* A transport shaped like one provider's wire, answering from this process.
   It keeps every request, which is what lets a test ask what a judge was
   actually shown rather than what it was meant to be shown. */
class ProviderShapedTransport {
  constructor(provider) {
    this.provider = provider;
    this.name = `${provider.providerId}-shaped`;
    this.sent = [];
    this.calls = 0;
  }

  async send(request) {
    this.sent.push(request);
    if (request.signal?.aborted) throw new TransportFault("core-v2-runtime: the request was aborted before it was sent", true);
    if (!request.url.startsWith(this.provider.baseUrl)) {
      throw new Error(`core-v2-runtime: ${this.provider.providerId} was given an address it does not own: ${request.url}`);
    }
    const body = JSON.parse(request.body);
    const prompt = this.provider.promptOf(body);
    const taskId = (prompt.match(/^taskId: (\S+)$/m) ?? [])[1];
    const packet = packets.get(taskId);
    if (!packet) throw new Error(`core-v2-runtime: nothing in this test knows the task ${taskId}`);
    const world = worlds.get(packet.workflowId);
    const fault = world.fault ? world.fault(packet, this.provider.providerId) : null;
    if (fault) throw fault;
    this.calls++;
    return this.provider.answer(answerFor(packet), `${this.provider.providerId}-${this.calls}`);
  }

  /* Every question this provider was asked, as text: the assignment on its
     own, and the standing rules that went with it. They are kept apart
     because they are different kinds of thing — the rules are prose written
     in this repository, the assignment is what the engine chose to show. */
  prompts() {
    return this.sent.map((r) => this.provider.promptOf(JSON.parse(r.body)));
  }

  questions() {
    return this.sent.map((r) => {
      const body = JSON.parse(r.body);
      return { user: this.provider.promptOf(body), system: this.provider.systemOf(body) };
    });
  }
}

const transports = new Map(PROVIDERS.map((p) => [p.providerId, new ProviderShapedTransport(p)]));

/* One transport per provider, so each adapter can only ever reach its own —
   which is also how "which provider answered this attempt" is a fact and not
   a label: the answer carries that provider's reported model. */
function executorsFor() {
  const built = buildProviderRegistry({
    config: RUNTIME_CONFIG,
    transport: { send: (request) => routeToItsOwn(request) },
    compilePrompt: compile,
    routing: ROUTING,
    environment: KEYS,
  });
  return built;
}

function routeToItsOwn(request) {
  for (const provider of PROVIDERS) {
    if (request.url.startsWith(provider.baseUrl)) return transports.get(provider.providerId).send(request);
  }
  throw new Error(`core-v2-runtime: no provider in this test owns ${request.url}`);
}

/* ═══════════════════════════════════════════════════════════ the scripts */

const FALSE_QUANTITY = 999;
const [, READER_B] = INDEPENDENCE_GROUPS;

/* One run, two subjects, and they fail differently on purpose.
   · E-001: both blind readers report the same wrong number, each with an
     anchor that lies inside the segment it names. Nothing about the two
     readings, taken together, shows that either is wrong — which is the case
     this whole engine exists for.
   · E-003: only the second reader is wrong. The two readings differ, which
     is the ordinary case a comparison finds by itself. */
const agreeOnOneLieAndDifferOnAnother = (packet, base) => {
  if (packet.roleKey !== "table_reader") return base;
  for (const c of base.claims) {
    if (c.subjectKey === "entry/E-001") c.value = { ...c.value, quantity: FALSE_QUANTITY, text: `${FALSE_QUANTITY} ${c.unit}` };
    if (c.subjectKey === "entry/E-003" && packet.independenceGroup === READER_B) {
      c.value = { ...c.value, quantity: c.value.quantity + 5, text: `${c.value.quantity + 5} ${c.unit}` };
    }
  }
  return base;
};

/* The second reader misreads one entry and nothing else: two readings that
   differ, which the chain settles by itself. */
const wrongOnOne = (packet, base) => {
  if (packet.roleKey === "table_reader" && packet.independenceGroup === READER_B) {
    for (const c of base.claims) {
      if (c.subjectKey === "entry/E-001") c.value = { ...c.value, quantity: c.value.quantity + 5, text: `${c.value.quantity + 5} ${c.unit}` };
    }
  }
  return base;
};

const SCRIPTED_FAMILIES = ["reader-family-one", "reader-family-two", "reader-family-three", "critic-family-one", "critic-family-two", "arbiter-family-one"];

const n = (rows) => Number(rows[0].n);
const sorted = (xs) => [...xs].sort();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/* The wire client hands jsonb back as it arrived, which is text. */
const js = (value) => (typeof value === "string" ? JSON.parse(value) : value);

await withThrowawayDatabase(async ({ client, organizationId, databaseName }) => {
  const { socketPath } = await ensureCluster();

  /* From here nothing may reach anything but that socket. */
  const tried = closeEveryDoorButTheLocalSocket();

  const openConnections = [];
  const connect = async () => {
    const c = await WireClient.connect({ socketPath, user: HARNESS_LOCATION.user, database: databaseName, applicationName: "core-v2-e2e" });
    openConnections.push(c);
    return c;
  };

  const events = [];
  const money = [];

  /* The record a dispatcher is given: the Postgres adapter with the durable
     budget of migration 059 on the path the work takes — a hold taken before
     anything is sent, a settlement written where the answer is written. */
  const recordOver = (c) => meteredRepository(
    new PostgresOrchestrationRepository(c, { organizationId }),
    {
      ledger: new BudgetLedger(c, RUNTIME_CONFIG),
      config: RUNTIME_CONFIG,
      providerOfFamily,
      events: (event) => { money.push(event); },
    },
  );

  function dispatcherNamed(name, options = {}) {
    const dispatcher = new Dispatcher({
      name,
      connect,
      repository: recordOver,
      pack,
      executors: () => executorsFor().registry,
      events: (event) => { events.push(event); },
      now: () => Date.now(),
      ticksPerPass: options.ticksPerPass ?? 8,
      workflowsPerPass: options.workflowsPerPass ?? 4,
      backoff: { baseMs: 5, ceilingMs: 20, jitter: 0, random: () => 0 },
      leaseTtlMs: options.leaseTtlMs,
    });
    return dispatcher;
  }

  /* A workflow committed to the outbox and authorised to spend: the state a
     producer leaves behind and a dispatcher finds. */
  async function enqueue(seed, world = {}) {
    const truth = syntheticRecordSet({ seed, sources: 1, sheetsPerSource: 1, entriesPerTable: 3, organizationId });
    const workflowId = truth.manifest.workflowId;
    const repo = new PostgresOrchestrationRepository(client, { organizationId });
    await enqueueWorkflow(repo, truth.manifest, pack);
    await new BudgetLedger(client, RUNTIME_CONFIG).authorizeWorkflow({
      workflowId, organizationId, currency: "USD",
      authorizedMaximum: 10, maximumPerAttempt: 1,
      maximumInputTokens: 5_000_000, maximumOutputTokens: 500_000,
      maximumAttempts: 200, maximumConcurrentAttempts: 8,
    });
    worlds.set(workflowId, { workflowId, truth, ...world });
    return { truth, workflowId };
  }

  const countOf = async (sql, id) => n((await client.query(sql, [id])).rows);
  const attemptsOf = async (workflowId) => (await client.query(
    `select a.id, a.task_id, a.state, a.executor_kind, a.executor_family, a.independence_domain, a.model_reported,
            a.provider_request_id, a.provider_stop_reason, a.provider_duration_ms, a.usage, a.error_code, t.task_type
       from public.agent_attempts a join public.workflow_tasks t on t.id = a.task_id
      where a.workflow_id = $1 order by t.task_type, a.attempt_no`, [workflowId])).rows
    .map((a) => ({ ...a, usage: js(a.usage) }));
  const claimsOf = async (workflowId) => (await client.query(
    `select id, subject_key, predicate, status, independence_group, independence_domain, value, attempt_id, task_id
       from public.evidence_claims where workflow_id = $1`, [workflowId])).rows
    .map((c) => ({ ...c, value: js(c.value) }));
  const disagreementsOf = async (workflowId) => (await client.query(
    `select id, kind, severity, state, subject_signature, critic_rounds, arbiter_rounds, resolution_decision_id, needs_human_reason
       from public.disagreements where workflow_id = $1`, [workflowId])).rows
    .map((d) => ({ ...d, subject_signature: js(d.subject_signature) }));

  /* ═══════════════════════════════════ 1 · the whole chain, uninterrupted */

  t.section("1 · a command on the outbox becomes a finished workflow, and nothing leaves the process");

  const first = await enqueue("runtime-e2e/agreement", { script: agreeOnOneLieAndDifferOnAnother });
  const wf = first.workflowId;
  const trueE1 = first.truth.entries.find((e) => e.id === "E-001");
  const trueE3 = first.truth.entries.find((e) => e.id === "E-003");

  const pending = (await client.query(`select state, dispatcher, attempt_count from public.workflow_outbox where workflow_id = $1`, [wf])).rows;
  t.check("the producer left one pending start command and nothing running",
    pending.length === 1 && pending[0].state === "pending" && pending[0].dispatcher === null
    && (await countOf(`select count(*) n from public.workflow_tasks where workflow_id = $1`, wf)) === 0,
    JSON.stringify(pending[0]));

  /* One pass at a time, photographed after each, so "never accepted" is a
     statement about the whole run rather than about the end of it. */
  const one = dispatcherNamed("dispatcher-one", { ticksPerPass: 1 });
  const shots = [];
  for (let pass = 0; pass < 60; pass++) {
    const report = await one.runOnce();
    shots.push((await client.query(`select id, status from public.evidence_claims where workflow_id = $1`, [wf])).rows);
    if (report.idle && report.workflows.length === 0) break;
  }
  await one.stop();

  const outbox = (await client.query(`select state, dispatcher, attempt_count from public.workflow_outbox where workflow_id = $1`, [wf])).rows[0];
  t.check("the command was claimed once, by this dispatcher, and acknowledged only after the workflow was durably its own",
    outbox.state === "acknowledged" && outbox.dispatcher === "dispatcher-one" && Number(outbox.attempt_count) === 1, JSON.stringify(outbox));

  const workflow = (await client.query(`select state from public.intelligence_workflows where id = $1`, [wf])).rows[0];
  t.check("the workflow reached a terminal state of its own: one subject was settled by machine and one is held for a person, so it is not 'completed' and it is not 'running'",
    ["partial", "needs_attention", "ready_for_decision"].includes(workflow.state), workflow.state);

  const rows = await attemptsOf(wf);
  const model = rows.filter((a) => a.executor_kind === "model");
  const answered = model.filter((a) => a.state === "succeeded");
  t.check("every attempt that was not code names the model that actually answered it, the call it was, how long it took and why it stopped",
    model.length > 0 && model.every((a) => PROVIDERS.some((p) => p.reported === a.model_reported))
    && answered.every((a) => a.provider_request_id !== null && a.provider_duration_ms !== null && a.provider_stop_reason !== null),
    `${model.length} model attempts; ${[...new Set(model.map((a) => a.model_reported))].join(", ")}`);
  t.check("and the counts each provider reported are on the attempt, under the names a price is settled against",
    answered.every((a) => Number(a.usage.input_tokens) === REPORTED_INPUT && Number(a.usage.output_tokens) === REPORTED_OUTPUT),
    JSON.stringify(answered[0]?.usage ?? null));
  t.check("the reported model is not the model that was asked for — the record keeps what answered, not what was requested",
    answered.every((a) => !PROVIDERS.some((p) => p.model === a.model_reported)),
    [...new Set(answered.map((a) => a.model_reported))].join(", "));

  t.section("1a · two blind readings, two providers, one falsehood they share");

  const readings = rows.filter((a) => a.task_type === TASK.readTable);
  t.check("the two blind readings of the table ran in two independence domains and were answered by two different providers",
    readings.length === 2 && new Set(readings.map((a) => a.independence_domain)).size === 2
    && new Set(readings.map((a) => a.model_reported)).size === 2,
    readings.map((a) => `${a.executor_family}→${a.model_reported}`).join(" "));

  const claims = await claimsOf(wf);
  const readingsOf = (entry) => claims.filter((c) => c.subject_key === `entry/${entry}` && c.predicate === "quantity" && c.independence_group !== null);
  const agreedLies = readingsOf("E-001").filter((c) => Number(c.value.quantity) === FALSE_QUANTITY);

  t.check("both readers reported the same false quantity for one entry, where the source holds another",
    agreedLies.length === 2 && new Set(agreedLies.map((c) => c.independence_group)).size === 2
    && new Set(agreedLies.map((c) => c.independence_domain)).size === 2 && trueE1.quantity !== FALSE_QUANTITY,
    `${agreedLies.length} readings of ${FALSE_QUANTITY}; the source holds ${trueE1.quantity}`);

  const segments = (await client.query(
    `select id, locator, parent_segment_id, segment_kind, discovered_by from public.source_segments where workflow_id = $1`, [wf])).rows
    .map((s) => ({ ...s, locator: js(s.locator) }));
  const lieAnchors = (await client.query(
    `select id, claim_id, segment_id, locator from public.evidence_anchors where claim_id = any($1::uuid[])`,
    [`{${agreedLies.map((c) => c.id).join(",")}}`])).rows.map((a) => ({ ...a, locator: js(a.locator) }));
  t.check("the false readings carry anchors that look right: each names a persisted segment and lies inside it",
    lieAnchors.length >= 2 && lieAnchors.every((a) => {
      const segment = segments.find((x) => x.id === a.segment_id);
      return segment !== undefined && locatorInside(a.locator, segment.locator);
    }), `${lieAnchors.length} anchors`);

  const everIn = (id, status) => shots.some((rowsAt) => rowsAt.some((c) => c.id === id && c.status === status));
  t.check("agreement did what agreement does: both stood corroborated at some point in the run",
    agreedLies.every((c) => everIn(c.id, "corroborated")));
  t.check("and in no photograph of any pass was either of them accepted or verified — matching is not evidence",
    agreedLies.every((c) => !everIn(c.id, "accepted") && !everIn(c.id, "verified")),
    shots.map((rowsAt, i) => `p${i}:${agreedLies.map((c) => rowsAt.find((x) => x.id === c.id)?.status ?? "-").join("/")}`).join(" "));

  t.section("1b · the critic, the verifier and the arbiter, each in a domain that made nothing it judges");

  const disagreements = await disagreementsOf(wf);
  const byVerification = disagreements.find((d) => d.subject_signature?.found_by === "verification");
  const byComparison = disagreements.find((d) => (d.subject_signature?.found_by ?? "comparison") === "comparison");
  t.check("a critic reopened the source at the agreed reading's own anchors and contradicted both, which opened a dispute found by verification",
    byVerification !== undefined && byVerification.kind === "value" && byVerification.severity === "material",
    disagreements.map((d) => `${d.kind}:${d.subject_signature?.found_by ?? "comparison"}:${d.state}`).join(" "));
  t.check("and the comparison found the other subject by itself, where the two readings differ",
    byComparison !== undefined && byComparison.kind === "value");

  const inVerificationDispute = (await client.query(
    `select claim_id from public.disagreement_claims where disagreement_id = $1`, [byVerification.id])).rows.map((r) => r.claim_id);
  t.check("both agreeing readings are in the dispute the critic opened — the one that agreed is not spared by having agreed",
    inVerificationDispute.length === 2 && agreedLies.every((c) => inVerificationDispute.includes(c.id)));

  const judges = rows.filter((a) => [KERNEL_TASK_TYPES.verifyClaim, KERNEL_TASK_TYPES.verifyDisagreement, KERNEL_TASK_TYPES.adjudicate].includes(a.task_type));
  const readingDomains = new Set(readings.map((a) => a.independence_domain));
  t.check("no critic, verifier or arbiter ran in a domain that made either reading",
    judges.length >= 3 && judges.every((a) => !readingDomains.has(a.independence_domain)),
    judges.map((a) => `${a.task_type}:${a.model_reported}`).join(" "));

  const verifiers = rows.filter((a) => a.task_type === KERNEL_TASK_TYPES.verifyDisagreement && a.state === "succeeded");
  const verdicts = (await client.query(
    `select s.attempt_id, s.claim_id, s.assessment, s.proposed_value, a.independence_domain
       from public.claim_assessments s join public.agent_attempts a on a.id = s.attempt_id
      where s.workflow_id = $1 and s.attempt_id = any($2::uuid[])`,
    [wf, `{${verifiers.map((a) => a.id).join(",")}}`])).rows.map((a) => ({ ...a, proposed_value: js(a.proposed_value) }));
  t.check("the verifier reopened the source at the claims' own anchors and said what it read instead",
    verdicts.length >= 2 && verdicts.filter((v) => v.assessment === "contradicts").every((v) => v.proposed_value !== null),
    verdicts.map((v) => `${v.assessment}:${v.proposed_value?.quantity ?? "-"}`).join(" "));
  t.check("its verdicts are recorded in a domain other than the readings they are about",
    verdicts.every((v) => !readingDomains.has(v.independence_domain)));

  /* What the arbiter was actually shown, read off the wire rather than off
     the packet: the request that left for it, in the provider's own body. */
  const arbiters = rows.filter((a) => a.task_type === KERNEL_TASK_TYPES.adjudicate && a.state === "succeeded");
  const arbiterQuestions = PROVIDERS.flatMap((p) => transports.get(p.providerId).questions())
    .filter((q) => arbiters.some((a) => q.user.includes(`taskId: ${a.task_id}`)));
  const arbiterPrompts = arbiterQuestions.map((q) => q.user);
  t.check("every arbitration that ran left exactly one question on the wire, and it says which role it is",
    arbiterPrompts.length === arbiters.length && arbiters.length > 0 && arbiterPrompts.every((text) => text.includes("evidence_arbiter")),
    `${arbiterPrompts.length} questions for ${arbiters.length} arbitrations`);
  /* What a judge may not be told. Not "the word majority": the packet's own
     standing instruction says a majority is not proof, which is the opposite
     of leaking one. What must not be there is a count of who agreed, another
     reader's answer offered as weight, or the name of anything that answers
     for money. */
  const FORBIDDEN = [/\bvote[sd]?\b/i, /\bconsensus\b/i, /\bboth reade/i, /\bother read(er|ing)/i,
    /\breadings? agree/i, /\bagreed with\b/i, /\btwo of (the )?three\b/i, /\bhow many\b/i,
    ...PROVIDERS.map((p) => new RegExp(`\\b${p.providerId}\\b`, "i")),
    ...PROVIDERS.map((p) => new RegExp(p.model.replace(/-/g, "[- ]"), "i")),
    ...PROVIDERS.map((p) => new RegExp(p.reported.replace(/-/g, "[- ]"), "i"))];
  const NAMES = [...PROVIDERS.map((p) => new RegExp(`\\b${p.providerId}\\b`, "i")),
    ...PROVIDERS.map((p) => new RegExp(p.model.replace(/-/g, "[- ]"), "i")),
    ...PROVIDERS.map((p) => new RegExp(p.reported.replace(/-/g, "[- ]"), "i"))];
  const leaked = arbiterPrompts.flatMap((text) => FORBIDDEN.filter((r) => r.test(text)).map(String));
  const named = arbiterQuestions.flatMap((q) => NAMES.filter((r) => r.test(q.user) || r.test(q.system)).map(String));
  t.check("and none of the assignments says who read, how many agreed, or offers another reading as weight",
    leaked.length === 0, [...new Set(leaked)].join(" "));
  t.check("and nothing in the request — assignment or standing rules — names a provider or a model",
    named.length === 0, [...new Set(named)].join(" "));
  t.check("what each of them does say is that a majority is not proof, and the rules it went out with say that counting agreement is no part of the work",
    arbiterQuestions.every((q) => /a majority is not proof/i.test(q.user)
      && /counting agreement is no part of your work/i.test(q.system)
      && /agreement is not proof/i.test(q.system)),
    arbiterQuestions.length ? "" : "no arbitration went out");
  const blindQuestions = PROVIDERS.flatMap((p) => transports.get(p.providerId).questions())
    .filter((q) => readings.some((a) => q.user.includes(`taskId: ${a.task_id}`)));
  t.check("neither blind reading was shown the other's answer, a provider's name, a count of anything, or the number the other one wrote",
    blindQuestions.length === 2
    && blindQuestions.every((q) => FORBIDDEN.every((r) => !r.test(q.user)) && NAMES.every((r) => !r.test(q.user) && !r.test(q.system)))
    && blindQuestions.every((q) => !q.user.includes(String(FALSE_QUANTITY))),
    `${blindQuestions.length} blind questions`);
  t.check("and each was told, in the rules it went out with, that it is a reading of its own and that nothing further is available to it",
    blindQuestions.every((q) => /this is a reading of your own/i.test(q.user) || /this is a reading of your own/i.test(q.system)));

  t.section("1c · what the machine could settle, and what it could not");

  const decisions = (await client.query(
    `select id, decision_type, status, authority, disagreement_id, decided_by_attempt_id, rationale from public.decisions where workflow_id = $1`, [wf])).rows;
  const settled = decisions.find((d) => d.id === byComparison.resolution_decision_id);
  t.check("the dispute the comparison found is resolved by a machine decision of the adjudicator",
    byComparison.state === "resolved" && settled !== undefined && settled.status === "machine_decided"
    && settled.authority === "adjudicator" && settled.decision_type === "accept_claim",
    JSON.stringify(settled ?? null));

  const settledClaims = (await client.query(
    `select c.id, c.status, c.independence_domain, c.value from public.evidence_claims c
       join public.disagreement_claims x on x.claim_id = c.id where x.disagreement_id = $1`, [byComparison.id])).rows
    .map((c) => ({ ...c, value: js(c.value) }));
  const accepted = settledClaims.find((c) => c.status === "accepted");
  const rejected = settledClaims.find((c) => c.status === "rejected");
  t.check("one reading was accepted and the other rejected, and the accepted one is what the source holds",
    accepted !== undefined && rejected !== undefined && Number(accepted.value.quantity) === trueE3.quantity,
    settledClaims.map((c) => `${c.status}:${c.value.quantity}`).join(" "));
  const backing = (await client.query(
    `select s.assessment, a.independence_domain from public.claim_assessments s
       join public.agent_attempts a on a.id = s.attempt_id
      where s.claim_id = $1 and s.assessment = 'supports'`, [accepted.id])).rows;
  t.check("what stands behind that acceptance is a reading of the source from a domain that did not make the claim — not the fact that a reader said it",
    backing.length > 0 && backing.every((a) => a.independence_domain !== accepted.independence_domain),
    backing.map((a) => a.independence_domain).join(" "));
  t.check("the false reading of that entry ends rejected",
    Number(rejected.value.quantity) !== trueE3.quantity && rejected.status === "rejected");

  const corrected = claims.find((c) => arbiters.some((a) => a.id === c.attempt_id) && c.independence_group === null && c.subject_key === "entry/E-001");
  t.check("for the subject both readers got wrong, the arbiter's correction is on the record as a proposal holding what the source holds",
    corrected !== undefined && corrected.status === "proposed" && Number(corrected.value.quantity) === trueE1.quantity,
    corrected ? `${corrected.value.quantity} (${corrected.status})` : "no correction");
  t.check("but it was not accepted: with three provider domains the only reviewer of that source is the arbiter's own domain, and a value confirmed by nobody else is not evidence",
    byVerification.state === "needs_human" && (byVerification.needs_human_reason ?? "").includes("another domain"),
    `${byVerification.state}: ${byVerification.needs_human_reason ?? ""}`);
  const hold = decisions.find((d) => d.decision_type === "hold" && d.disagreement_id === byVerification.id);
  t.check("a hold stands against it instead, waiting for a person, and the readings under it are left unresolved rather than believed",
    hold !== undefined && hold.status === "needs_human"
    && agreedLies.every((c) => claims.find((x) => x.id === c.id).status === "unresolved"),
    `${hold?.status}; ${agreedLies.map((c) => claims.find((x) => x.id === c.id).status).join("/")}`);
  t.check("and no decision anywhere in the run cites either of the agreed false readings as support",
    (await client.query(
      `select count(*) n from public.decision_evidence e join public.decisions d on d.id = e.decision_id
        where d.workflow_id = $1 and e.link = 'supports' and e.claim_id = any($2::uuid[])`,
      [wf, `{${agreedLies.map((c) => c.id).join(",")}}`])).rows[0].n === "0");

  t.section("1d · the money: held before anything was sent, settled at what was reported, and none of it real");

  const budget = (await client.query(`select reserved, settled, authorized_maximum from public.workflow_cost_budgets where workflow_id = $1`, [wf])).rows[0];
  const reservations = (await client.query(
    `select attempt_id, state, reserved_cost, settled_cost, usage, price_basis from public.attempt_cost_reservations where workflow_id = $1`, [wf])).rows;
  t.check("every model attempt took a durable hold before it was sent, and code took none",
    reservations.length === model.length && rows.filter((a) => a.executor_kind === "deterministic").every((a) => !reservations.some((r) => r.attempt_id === a.id)),
    `${reservations.length} reservations for ${model.length} model attempts and ${rows.length - model.length} code attempts`);
  t.check("each hold was the most that attempt could have cost at the operator's price, not what it was expected to cost",
    reservations.every((r) => Number(r.reserved_cost) === HOLD_PER_ATTEMPT),
    `${reservations[0] ? Number(reservations[0].reserved_cost) : "none"} against ${HOLD_PER_ATTEMPT}`);
  t.check("each settled at what the answering system reported, which is a great deal less than what was held",
    reservations.every((r) => r.state === "settled" && Number(r.settled_cost) === COST_PER_ATTEMPT),
    `${reservations.filter((r) => r.state === "settled").length} of ${reservations.length} settled at ${COST_PER_ATTEMPT}`);
  t.check("the settlement was priced from the price the hold was taken under, and the counts it was priced from are kept beside it",
    reservations.every((r) => js(r.price_basis).input_per_million_tokens === INPUT_RATE && Number(js(r.usage).input_tokens) === REPORTED_INPUT));
  t.check("nothing is left holding, and the ledger's total is one attempt's cost times the number of answers",
    Number(budget.reserved) === 0 && round6(Number(budget.settled)) === round6(COST_PER_ATTEMPT * model.length),
    `held ${budget.reserved}, settled ${budget.settled}, ${model.length} attempts`);
  t.check("that number is what this run WOULD have cost. The external cost is zero: every request was answered inside this process, at an address that resolves nowhere",
    PROVIDERS.every((p) => transports.get(p.providerId).sent.every((r) => r.url.startsWith(p.baseUrl) && new URL(r.url).hostname.endsWith(".invalid"))) && tried() === 0,
    `${[...transports.values()].reduce((sum, x) => sum + x.sent.length, 0)} requests; ${tried()} attempts at a door`);

  t.section("1e · everything the run did is on the record");

  const persisted = {
    tasks: await countOf(`select count(*) n from public.workflow_tasks where workflow_id = $1`, wf),
    attempts: await countOf(`select count(*) n from public.agent_attempts where workflow_id = $1`, wf),
    claims: await countOf(`select count(*) n from public.evidence_claims where workflow_id = $1`, wf),
    anchors: await countOf(`select count(*) n from public.evidence_anchors where workflow_id = $1`, wf),
    assessments: await countOf(`select count(*) n from public.claim_assessments where workflow_id = $1`, wf),
    disagreements: await countOf(`select count(*) n from public.disagreements where workflow_id = $1`, wf),
    decisions: await countOf(`select count(*) n from public.decisions where workflow_id = $1`, wf),
    segments: await countOf(`select count(*) n from public.source_segments where workflow_id = $1`, wf),
    reservations: reservations.length,
  };
  t.check("a task, an attempt, a claim, an anchor, an assessment, a disagreement, a decision and a reservation are all there",
    Object.values(persisted).every((x) => x > 0), Object.entries(persisted).map(([k, v]) => `${k}=${v}`).join(" "));
  t.check("the sheet the source declared was persisted at ingest and the regions were discovered under it, by a model",
    segments.filter((x) => x.segment_kind === "sheet" && x.discovered_by === "deterministic").length === 1
    && segments.filter((x) => x.parent_segment_id !== null && x.discovered_by === "model").length === 2,
    segments.map((x) => `${x.segment_kind}:${x.discovered_by}`).join(" "));
  t.check("no task ran twice: not one has two succeeded attempts",
    (await client.query(`select task_id from public.agent_attempts where workflow_id = $1 and state = 'succeeded' group by task_id having count(*) > 1`, [wf])).rows.length === 0);
  t.check("the dispatcher never had to declare the workflow stuck, and it said so when it let it go",
    !events.some((e) => e.event === "workflow.stalled" && e.workflow === wf)
    && events.some((e) => e.event === "workflow.settled" && e.workflow === wf),
    events.filter((e) => e.workflow === wf).map((e) => e.event).filter((x, i, all) => all.indexOf(x) === i).join(" "));
  t.check("and it said, in a number, that somebody has to look at this run",
    events.some((e) => e.workflow === wf && e.needs_person === true),
    JSON.stringify(events.filter((e) => e.event === "workflow.settled" && e.workflow === wf).slice(-1)[0] ?? null));
  t.check("nothing a dispatcher emitted carries a key, a prompt or a piece of a source",
    events.every((e) => !JSON.stringify(e).includes("not-a-credential") && !JSON.stringify(e).includes("taskId:")),
    `${events.length} events`);
  t.check("and the ledger's own events name amounts and attempts, never a key or an answer",
    money.length > 0 && money.every((e) => !JSON.stringify(e).includes("not-a-credential")),
    `${money.length} budget events: ${[...new Set(money.map((e) => e.event))].join(" ")}`);

  /* ═════════════════════════════════ 2 · the same chain, with a crash */

  t.section("2 · a dispatcher dies mid-run; another finishes it without repeating a thing");

  const second = await enqueue("runtime-e2e/crash", { script: wrongOnOne });
  const crashed = second.workflowId;

  /* The reference: the same seed and the same script, uninterrupted, in
     memory, with the pack's own scripted agents. Whether an answer came from
     an adapter or from code, the identifiers the kernel derives are the same
     — so this is what the interrupted run must leave behind, exactly. */
  const memory = new InMemoryOrchestrationRepository();
  const reference = assemble({
    manifest: second.truth.manifest, pack: new SyntheticRecordsPack(), repo: memory, clock: manualClock(), owner: "worker-memory",
    executors: mockExecutors(second.truth, { scripts: Object.fromEntries(SCRIPTED_FAMILIES.map((f) => [f, wrongOnOne])) }).registry,
  });
  await reference.scheduler.plan();
  const referenceReport = await reference.scheduler.runUntilQuiescent();
  const referenceClaims = sorted((await memory.listClaims({ workflowId: crashed })).map((c) => c.claimId));
  const referenceDecisions = sorted((await memory.listDecisions(crashed)).map((d) => d.decisionId));
  t.check("the reference run of the same seed, uninterrupted and in memory, completes and leaves claims and decisions to compare against",
    referenceReport.workflow.state === "completed" && referenceClaims.length > 0 && referenceDecisions.length > 0,
    `${referenceReport.workflow.state}, ${referenceClaims.length} claims, ${referenceDecisions.length} decisions`);

  /* One pass at a time until there is work done and work left. Then the
     dispatcher is dropped on the floor: not stopped, not drained, not asked
     to hand anything over. Only the record survives. */
  const dying = dispatcherNamed("dispatcher-that-died", { ticksPerPass: 1, workflowsPerPass: 1 });
  const dyingRecord = await dying.record();
  let halfway = null;
  for (let pass = 0; pass < 20 && halfway === null; pass++) {
    await dying.runOnce();
    /* A tick dispatches whatever is runnable, so between passes the queue is
       empty unless what the last tick finished has released the next work.
       Releasing it here is what the next tick would have done anyway, and it
       is what makes a task the dying dispatcher can strand. */
    await dyingRecord.releaseDependents(crashed);
    const tasks = await dyingRecord.listTasks(crashed);
    const done = tasks.filter((x) => TERMINAL_TASK_STATES.includes(x.state));
    const runnable = await dyingRecord.getRunnableTasks(crashed);
    if (pass >= 2 && done.length > 0 && runnable.length > 0 && done.length < tasks.length) halfway = { tasks, done, runnable };
  }
  t.check("the dispatcher was cut off with work behind it, work in front of it and something waiting in the queue",
    halfway !== null && halfway.done.length > 0 && halfway.done.length < halfway.tasks.length && halfway.runnable.length > 0,
    halfway ? `${halfway.done.length} of ${halfway.tasks.length} tasks finished, ${halfway.runnable.length} waiting` : "it never got that far");

  const beforeAttempts = (await attemptsOf(crashed)).map((a) => a.id);
  const beforeRequests = [...transports.values()].reduce((sum, x) => sum + x.sent.length, 0);

  /* And it died holding a lease on something it never sent for. */
  const queued = halfway.runnable[0];
  const stranded = await dyingRecord.leaseTask(queued.taskId, "dispatcher-that-died", 1, Date.now());
  t.check("it also died holding a lease on a task nothing was ever sent for",
    stranded !== null && stranded.leaseOwner === "dispatcher-that-died" && (await dyingRecord.listAttempts(stranded.taskId)).length === 0);
  await sleep(40);

  const successor = dispatcherNamed("dispatcher-after-the-crash");
  await successor.drain();
  await successor.stop();

  const afterState = (await client.query(`select state from public.intelligence_workflows where id = $1`, [crashed])).rows[0].state;
  t.check("the workflow the successor inherited runs to completion", afterState === "completed", afterState);

  const afterAttempts = await attemptsOf(crashed);
  t.check("no task has two succeeded attempts: nothing the first dispatcher finished was bought again",
    (await client.query(`select task_id from public.agent_attempts where workflow_id = $1 and state = 'succeeded' group by task_id having count(*) > 1`, [crashed])).rows.length === 0);
  t.check("every attempt the first dispatcher made is still the attempt it was, and the successor only added new ones",
    beforeAttempts.every((id) => afterAttempts.some((a) => a.id === id)) && afterAttempts.length > beforeAttempts.length,
    `${beforeAttempts.length} attempts before the crash, ${afterAttempts.length} after`);
  t.check("the identifiers are the kernel's derived ones, unchanged by the restart",
    afterAttempts.every((a) => a.id === entityId("attempt", a.task_id, 1)));

  const afterClaims = sorted((await client.query(`select id from public.evidence_claims where workflow_id = $1`, [crashed])).rows.map((r) => r.id));
  const afterDecisions = sorted((await client.query(`select id from public.decisions where workflow_id = $1`, [crashed])).rows.map((r) => r.id));
  t.check("every claim of the interrupted run has the id the uninterrupted reference gave it, and there is not one more",
    afterClaims.length === referenceClaims.length && afterClaims.every((id, i) => id === referenceClaims[i]),
    `${afterClaims.length} on the record, ${referenceClaims.length} in the reference`);
  t.check("and every decision likewise — a restart produced no second copy of anything",
    afterDecisions.length === referenceDecisions.length && afterDecisions.every((id, i) => id === referenceDecisions[i]),
    `${afterDecisions.length} on the record, ${referenceDecisions.length} in the reference`);

  const askedTwice = PROVIDERS.flatMap((p) => transports.get(p.providerId).prompts())
    .map((text) => (text.match(/^taskId: (\S+)$/m) ?? [])[1])
    .filter((id, i, all) => all.indexOf(id) !== i);
  t.check("no task was asked of a provider twice, across both dispatchers and all three providers",
    askedTwice.length === 0, [...new Set(askedTwice)].slice(0, 4).join(" "));
  t.check("the successor did send for the work that was left, so the run really was finished by the second one",
    [...transports.values()].reduce((sum, x) => sum + x.sent.length, 0) > beforeRequests);
  t.check("the reclaimed lease was taken back rather than waited on",
    (await client.query(`select count(*) n from public.audit_events where action = 'core_v2.task.lease_reclaimed' and entity_id = $1`, [stranded.taskId])).rows[0].n !== "0");

  const crashedOutbox = (await client.query(`select state, attempt_count from public.workflow_outbox where workflow_id = $1`, [crashed])).rows[0];
  t.check("the outbox does not still say the workflow is being started",
    crashedOutbox.state === "acknowledged" && Number(crashedOutbox.attempt_count) === 1, JSON.stringify(crashedOutbox));

  /* ═════════════════════ 3 · a request that left and never came back */

  t.section("3 · a socket dies after the request left: nobody knows, so nothing is repurchased and the money stays held");

  const third = await enqueue("runtime-e2e/unknown", {
    script: wrongOnOne,
    /* One reading of the note goes out and nothing comes back. Whether the
       provider did the work — and charged for it — cannot be known here. */
    fault: (packet) => (packet.roleKey === "note_reader" && packet.independenceGroup === READER_B
      ? new TransportFault("core-v2-runtime: the socket closed while waiting for an answer", false)
      : null),
  });
  const unknown = third.workflowId;

  const patient = dispatcherNamed("dispatcher-three");
  await patient.drain();
  const remaining = await patient.workRemaining(await patient.record(), null, unknown);
  await patient.stop();

  const unknownAttempts = await attemptsOf(unknown);
  const lost = unknownAttempts.filter((a) => a.state === "outcome_unknown");
  t.check("the attempt whose answer never came back is recorded as an unknown outcome — not as a failure, and never as an empty success",
    lost.length === 1 && lost[0].task_type === TASK.readNote,
    unknownAttempts.map((a) => `${a.task_type}:${a.state}`).join(" "));
  t.check("the record says both things about it: that the engine does not know how it ended, and which unknown it was",
    lost[0].error_code === "provider_outcome_unknown" && lost[0].provider_stop_reason === "transport_fault",
    `${lost[0].error_code} / ${lost[0].provider_stop_reason}`);
  t.check("its task was not tried again: one attempt, not two",
    unknownAttempts.filter((a) => a.task_id === lost[0].task_id).length === 1);

  const stillHeld = (await client.query(
    `select state, reserved_cost, settled_cost from public.attempt_cost_reservations where attempt_id = $1`, [lost[0].id])).rows[0];
  t.check("its hold is still held — not settled at nothing and not given back, because the money may already be gone",
    stillHeld.state === "reserved" && stillHeld.settled_cost === null && Number(stillHeld.reserved_cost) === HOLD_PER_ATTEMPT,
    JSON.stringify(stillHeld));
  const unknownBudget = (await client.query(`select reserved, settled from public.workflow_cost_budgets where workflow_id = $1`, [unknown])).rows[0];
  t.check("and the workflow's budget still shows that hold, so the same money cannot be spent twice",
    Number(unknownBudget.reserved) === HOLD_PER_ATTEMPT, JSON.stringify(unknownBudget));
  t.check("the ledger said so rather than doing it quietly",
    money.some((e) => e.event === "budget.holds" && e.workflow === unknown),
    money.filter((e) => e.workflow === unknown).map((e) => e.event).join(" "));

  const unknownState = (await client.query(`select state from public.intelligence_workflows where id = $1`, [unknown])).rows[0].state;
  t.check("the workflow does not sit there saying it is running when there is nothing left it can do",
    unknownState !== "running" && remaining.runnable === 0 && remaining.busy === 0,
    `${unknownState}; ${JSON.stringify(remaining)}`);
  t.check("and what is left is exactly one thing a person can act on: an attempt nobody knows the outcome of",
    remaining.reconcilable === 1 || (await client.query(
      `select count(*) n from public.workflow_tasks where workflow_id = $1 and state = 'outcome_unknown'`, [unknown])).rows[0].n === "1",
    JSON.stringify(remaining));

  /* ═════════════════════════════════════════════════════ what it all cost */

  t.section("what left this process");

  const requests = [...transports.values()].reduce((sum, x) => sum + x.sent.length, 0);
  t.check("all three adapters were used, and every request each made was answered inside this process",
    PROVIDERS.every((p) => transports.get(p.providerId).calls > 0) && requests > 0,
    [...transports.values()].map((x) => `${x.name}:${x.sent.length}`).join(" "));
  t.check("no door out of this process was tried, not once, by anything",
    tried() === 0, `${tried()} attempts`);
  t.check("no request carried anything but an invented key, and every address resolves nowhere",
    [...transports.values()].every((x) => x.sent.every((r) => new URL(r.url).hostname.endsWith(".invalid")))
    && [...transports.values()].every((x) => x.sent.every((r) => Object.values(r.headers).every((v) => !/^sk-|^Bearer sk-/.test(String(v))))));
  t.check("the external cost of this file is $0.00", tried() === 0 && requests > 0);

  for (const c of openConnections) await c.end().catch(() => {});
});

t.finish();
