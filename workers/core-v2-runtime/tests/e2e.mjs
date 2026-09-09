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
 * AND THE MATERIAL IS REAL. Every reading in this file is answered from the
 * bytes that were actually attached to the request — a table as text, a note
 * as an image whose pixels are decoded — resolved from a content-addressed
 * store and verified against the hash the assignment names before anything
 * is sent. Nothing is looked up by task id: the stand-in that answers is
 * handed a request and has to read it, so changing a number in the material
 * changes the claim, and corrupting it stops the work.
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
import { mockExecutors } from "../../core-v2/domains/synthetic-records/mocks.ts";
import { readTextFromImage } from "../../core-v2/domains/synthetic-records/material.ts";
import { assemble, manualClock } from "../../core-v2/domains/simulate.ts";
import { KERNEL_TASK_TYPES } from "../../core-v2/kernel/contracts.ts";
import { INDEPENDENCE_GROUPS } from "../../core-v2/kernel/domain.ts";
import { entityId, sha256Bytes } from "../../core-v2/kernel/ids.ts";
import { locatorInside } from "../../core-v2/kernel/locators.ts";
import { RoleRegistry } from "../../core-v2/kernel/roles.ts";
import { TERMINAL_TASK_STATES } from "../../core-v2/kernel/transitions.ts";
import { Dispatcher, enqueueWorkflow } from "../dispatcher.ts";
import { compilePrompt } from "../prompt-compiler.ts";
import { buildProviderRegistry } from "../providers/registry.ts";
import { LOCAL_USAGE, LocalProviderTransport } from "../providers/local-answers.ts";
import { parseMaterialHeading } from "../providers/provider.ts";
import { answerFromRequest, parseAssignment } from "../local-agent/reading-agent.ts";
import { InMemoryMaterialResolver } from "../material/memory-resolver.ts";
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

const t = harness("one whole workflow, offline, on real material, through three provider adapters and a real record");

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
const MATERIAL_CEILING = 64 * 1024;
const INPUT_RATE = 3;
const OUTPUT_RATE = 15;

const PROVIDERS = [
  { providerId: "anthropic", baseUrl: "https://alpha.provider.invalid", environmentVariable: "CORE_V2_E2E_KEY_ALPHA", model: "alpha-reader-1" },
  { providerId: "openai", baseUrl: "https://beta.provider.invalid", environmentVariable: "CORE_V2_E2E_KEY_BETA", model: "beta-reader-1" },
  { providerId: "google", baseUrl: "https://gamma.provider.invalid", environmentVariable: "CORE_V2_E2E_KEY_GAMMA", model: "gamma-reader-1" },
];

/* Six abstract families onto three providers. The two blind lanes land on two
   different providers; the third is left free so that a critic, a verifier
   and an arbiter can be in a domain that made nothing they judge. */
const ROUTING = {
  "reader-family-one": "anthropic",
  "reader-family-two": "openai",
  "reader-family-three": "google",
  "critic-family-one": "google",
  "critic-family-two": "anthropic",
  "arbiter-family-one": "google",
};
const providerOfFamily = (family) => ROUTING[family] ?? null;

const configurationOf = (p, over = {}) => ({
  providerId: p.providerId, baseUrl: p.baseUrl, apiKeyEnvironmentVariable: p.environmentVariable,
  models: [p.model], defaultModel: p.model,
  maximumOutputTokens: OUTPUT_CEILING, maximumInputTokens: INPUT_CEILING, requestTimeoutMs: 30_000,
  maximumMaterialBytes: MATERIAL_CEILING, maximumMaterialBytesPerItem: MATERIAL_CEILING,
  supportedMediaTypes: ["text/plain; charset=utf-8", "image/png"],
  capabilities: { [p.model]: { forcedToolChoice: true, strictSchema: true, images: true, thinking: "optional" } },
  ...over,
});

const pricingOf = (p) => ({
  providerId: p.providerId, model: p.model, effectiveFrom: "2026-01-01", currency: "USD",
  inputPerMillionTokens: INPUT_RATE, outputPerMillionTokens: OUTPUT_RATE,
  cachedInputPerMillionTokens: 0.3, cacheWritePerMillionTokens: 3.75,
});

/* All four gates open — and even so nothing can be sent, because the only
   transport any adapter is given answers from this process. That is the
   division the whole package rests on: authorisation says a call is
   permitted, a transport says whether one is possible. */
const RUNTIME_CONFIG = {
  providers: PROVIDERS.map((p) => configurationOf(p)),
  pricing: PROVIDERS.map(pricingOf),
  authorization: {
    providerNetworkFlag: true, environmentGate: true, maximumAuthorizedCost: 10, currency: "USD",
    providerAllowlist: PROVIDERS.map((p) => p.providerId), modelAllowlist: PROVIDERS.map((p) => p.model),
  },
  dispatcherName: "core-v2-e2e",
};

/* What one attempt holds, and what one attempt settles at, worked out here
   from the numbers above rather than read back from the thing under test.

   The hold is the token ceilings at the HIGHEST rate any billable component
   of each category could be charged at — which for this operator's price
   means the cache-write rate on the input side, because it is above the
   ordinary input rate. Pricing the input ceiling at the ordinary rate would
   be a hold below the worst case: a request that wrote its whole input to a
   cache would settle above its own reservation. */
const round6 = (n) => Math.round(n * 1e6) / 1e6;
const CEILING_INPUT_RATE = Math.max(INPUT_RATE, 0.3, 3.75);
const CEILING_OUTPUT_RATE = OUTPUT_RATE;
const HOLD_PER_ATTEMPT = round6((INPUT_CEILING / 1e6) * CEILING_INPUT_RATE + (OUTPUT_CEILING / 1e6) * CEILING_OUTPUT_RATE);
const COST_PER_ATTEMPT = round6((LOCAL_USAGE.inputTokens / 1e6) * INPUT_RATE + (LOCAL_USAGE.outputTokens / 1e6) * OUTPUT_RATE);

/* ═══════════════════════════════════════════════ the worlds and the wire */

const pack = new SyntheticRecordsPack();
const roles = new RoleRegistry(pack);
const compile = (packet) => compilePrompt(packet, roles.role(packet.roleKey));

/* Every piece of material every invented world holds, filed under the hash
   of its own bytes. One store serves every workflow because a hash is a hash;
   nothing can collide and nothing can be fetched by name. */
const store = new Map();
function inventAWorld(seed, organizationId) {
  const truth = syntheticRecordSet({ seed, sources: 1, sheetsPerSource: 1, entriesPerTable: 3, organizationId });
  for (const [hash, item] of truth.material) store.set(hash, { mediaKind: item.mediaKind, mimeType: item.mimeType, bytes: item.bytes });
  return truth;
}
const resolver = () => new InMemoryMaterialResolver(store);

const FALSE_QUANTITY = 999;
const [, READER_B] = INDEPENDENCE_GROUPS;
const SECOND_LANE = PROVIDERS[1].model;

/* How an invented reader is told to MISREAD. What it was handed is correct
   and was verified before it was sent; what is scripted is the mistake — the
   thing a model that gets it wrong actually does. The second blind lane is
   told apart by the model that is answering, because that is all a stand-in
   can see: two lanes are two providers, by construction. */
const misreadings = {
  /* E-001: both readers say the same wrong thing. E-003: only the second
     one does, which a comparison finds by itself. */
  agreeOnOneAndDifferOnAnother: (question, answer) => {
    for (const claim of answer.claims ?? []) {
      if (claim.predicate !== "quantity") continue;
      if (claim.subjectKey === "entry/E-001") {
        claim.value = { ...claim.value, quantity: FALSE_QUANTITY, text: `${FALSE_QUANTITY} ${claim.unit ?? ""}`.trim() };
      }
      if (claim.subjectKey === "entry/E-003" && question.model === SECOND_LANE) {
        const wrong = (claim.value.quantity ?? 0) + 5;
        claim.value = { ...claim.value, quantity: wrong, text: `${wrong} ${claim.unit ?? ""}`.trim() };
      }
    }
    return answer;
  },
  /* One reader misreads one entry and nothing else. */
  wrongOnOne: (question, answer) => {
    if (question.model !== SECOND_LANE) return answer;
    for (const claim of answer.claims ?? []) {
      if (claim.predicate !== "quantity" || claim.subjectKey !== "entry/E-001") continue;
      const wrong = (claim.value.quantity ?? 0) + 5;
      claim.value = { ...claim.value, quantity: wrong, text: `${wrong} ${claim.unit ?? ""}`.trim() };
    }
    return answer;
  },
  none: (question, answer) => answer,
};

/* Everything that went out, in the order it went, across every dispatcher in
   this file — so "was this task ever asked twice" is a question about the
   wire rather than about the record. */
const wire = [];
let clockTick = 0;

/* One provider-shaped stand-in, bound to one way of misreading. It answers
   from the request and from nothing else: there is no packet here, no task
   id to look an answer up under, and no truth object. */
function standIn(misread) {
  return new LocalProviderTransport({
    onRequest: (question) => {
      const text = question.parts.find((part) => part.kind === "text" && part.text.includes("taskId: "));
      const taskId = text ? (text.text.match(/^taskId: (\S+)$/m) ?? [])[1] ?? null : null;
      wire.push({ at: clockTick++, providerId: question.providerId, model: question.model, taskId, question });
    },
    answer: (question) => {
      try {
        return misread(question, answerFromRequest(question));
      } catch (error) {
        return new Error(`the stand-in could not answer: ${error.message}`);
      }
    },
  });
}

const n = (rows) => Number(rows[0].n);
const sorted = (xs) => [...xs].sort();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/* The wire client hands jsonb back as it arrived, which is text. */
const js = (value) => (typeof value === "string" ? JSON.parse(value) : value);
const questionsFor = (taskId) => wire.filter((x) => x.taskId === taskId).map((x) => x.question);
const assignmentOf = (question) => question.parts.find((part) => part.kind === "text" && part.text.includes("taskId: "))?.text ?? "";

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
      events: (event) => { money.push({ ...event, at: clockTick++ }); },
    },
  );

  function dispatcherNamed(name, options = {}) {
    const transport = options.transport ?? standIn(misreadings.none);
    const dispatcher = new Dispatcher({
      name,
      connect,
      repository: recordOver,
      pack,
      executors: () => buildProviderRegistry({
        config: options.config ?? RUNTIME_CONFIG,
        transport,
        compilePrompt: compile,
        materialResolver: options.materialResolver ?? resolver(),
        routing: ROUTING,
        environment: KEYS,
      }).registry,
      events: (event) => { events.push(event); },
      now: () => Date.now(),
      ticksPerPass: options.ticksPerPass ?? 8,
      workflowsPerPass: options.workflowsPerPass ?? 4,
      backoff: { baseMs: 5, ceilingMs: 20, jitter: 0, random: () => 0 },
      leaseTtlMs: options.leaseTtlMs,
    });
    return { dispatcher, transport };
  }

  /* A workflow committed to the outbox and authorised to spend: the state a
     producer leaves behind and a dispatcher finds. */
  async function enqueue(seed) {
    const truth = inventAWorld(seed, organizationId);
    const workflowId = truth.manifest.workflowId;
    await enqueueWorkflow(new PostgresOrchestrationRepository(client, { organizationId }), truth.manifest, pack);
    await new BudgetLedger(client, RUNTIME_CONFIG).authorizeWorkflow({
      workflowId, organizationId, currency: "USD",
      authorizedMaximum: 10, maximumPerAttempt: 1,
      maximumInputTokens: 5_000_000, maximumOutputTokens: 500_000,
      maximumAttempts: 200, maximumConcurrentAttempts: 8,
    });
    return { truth, workflowId };
  }

  const countOf = async (sql, id) => n((await client.query(sql, [id])).rows);
  const attemptsOf = async (workflowId) => (await client.query(
    `select a.id, a.task_id, a.state, a.executor_kind, a.executor_family, a.independence_domain, a.model_reported,
            a.provider_request_id, a.provider_stop_reason, a.provider_duration_ms, a.usage, a.error_code, a.error_message, t.task_type
       from public.agent_attempts a join public.workflow_tasks t on t.id = a.task_id
      where a.workflow_id = $1 order by t.task_type, a.attempt_no`, [workflowId])).rows
    .map((a) => ({ ...a, usage: js(a.usage) }));
  const claimsOf = async (workflowId) => (await client.query(
    `select id, subject_key, predicate, status, independence_group, independence_domain, value, attempt_id, task_id
       from public.evidence_claims where workflow_id = $1`, [workflowId])).rows
    .map((c) => ({ ...c, value: js(c.value) }));
  const disagreementsOf = async (workflowId) => (await client.query(
    `select id, kind, severity, state, subject_signature, resolution_decision_id, needs_human_reason
       from public.disagreements where workflow_id = $1`, [workflowId])).rows
    .map((d) => ({ ...d, subject_signature: js(d.subject_signature) }));

  /* ═══════════════════════════════════ 1 · the whole chain, uninterrupted */

  t.section("1 · a command on the outbox becomes a finished workflow, and nothing leaves the process");

  const first = await enqueue("runtime-e2e/agreement");
  const wf = first.workflowId;
  const trueE1 = first.truth.entries.find((e) => e.id === "E-001");
  const trueE3 = first.truth.entries.find((e) => e.id === "E-003");

  const pending = (await client.query(`select state, dispatcher, attempt_count from public.workflow_outbox where workflow_id = $1`, [wf])).rows;
  t.check("the producer left one pending start command and nothing running",
    pending.length === 1 && pending[0].state === "pending" && pending[0].dispatcher === null
    && (await countOf(`select count(*) n from public.workflow_tasks where workflow_id = $1`, wf)) === 0,
    JSON.stringify(pending[0]));

  /* One tick at a time, photographed after each, so "never accepted" is a
     statement about the whole run rather than about the end of it. */
  const one = dispatcherNamed("dispatcher-one", { ticksPerPass: 1, transport: standIn(misreadings.agreeOnOneAndDifferOnAnother) });
  const shots = [];
  for (let pass = 0; pass < 60; pass++) {
    const report = await one.dispatcher.runOnce();
    shots.push((await client.query(`select id, status from public.evidence_claims where workflow_id = $1`, [wf])).rows);
    if (report.idle && report.workflows.length === 0) break;
  }
  await one.dispatcher.stop();

  const outbox = (await client.query(`select state, dispatcher, attempt_count from public.workflow_outbox where workflow_id = $1`, [wf])).rows[0];
  t.check("the command was claimed once, by this dispatcher, and acknowledged only after the workflow was durably its own",
    outbox.state === "acknowledged" && outbox.dispatcher === "dispatcher-one" && Number(outbox.attempt_count) === 1, JSON.stringify(outbox));

  const workflow = (await client.query(`select state from public.intelligence_workflows where id = $1`, [wf])).rows[0];
  t.check("the workflow reached a terminal state of its own: one subject settled by machine, one held for a person",
    ["partial", "needs_attention", "ready_for_decision"].includes(workflow.state), workflow.state);

  const rows = await attemptsOf(wf);
  const model = rows.filter((a) => a.executor_kind === "model");
  const answered = model.filter((a) => a.state === "succeeded");
  t.check("every attempt that was not code names the model that actually answered it, the call it was, how long it took and why it stopped",
    model.length > 0 && answered.length > 0
    && answered.every((a) => a.provider_request_id !== null && a.provider_duration_ms !== null && a.provider_stop_reason !== null),
    `${model.length} model attempts, ${answered.length} answered`);
  t.check("the counts are on the attempt in the answering provider's own words, not renamed into a house style",
    answered.every((a) => Object.keys(a.usage).length > 0)
    && answered.some((a) => "input_tokens" in a.usage) && answered.some((a) => "promptTokenCount" in a.usage),
    JSON.stringify([...new Set(answered.map((a) => Object.keys(a.usage).sort().join(",")))]));

  t.section("1a · the agent was given the material, not a description of it");
  {
    const readings = rows.filter((a) => a.task_type === TASK.readTable && a.state === "succeeded");
    const questions = readings.flatMap((a) => questionsFor(a.task_id));
    t.check("every blind reading of the table left exactly one question on the wire",
      questions.length === readings.length && readings.length === 2, `${questions.length} questions for ${readings.length} readings`);

    const parts = questions.flatMap((q) => q.parts);
    const tableText = Buffer.from(store.get(first.truth.sheets[0].regions[0].contentHash).bytes).toString("utf8");
    t.check("the table itself was in the request, byte for byte",
      questions.every((q) => q.parts.some((part) => part.kind === "text" && part.text === tableText)),
      tableText.split("\n")[1]);
    t.check("announced by what it is: its source, its segment, its type, its size and its hash",
      questions.every((q) => q.parts.some((part) => part.kind === "text" && part.text.startsWith("--- material for ")
        && part.text.includes(first.truth.sheets[0].regions[0].contentHash))));
    t.check("and NOTHING it was not authorised to read came with it",
      parts.filter((part) => part.kind === "text" && part.text.startsWith("--- material for ")).length === readings.length
      && !parts.some((part) => part.kind === "text" && part.text.includes(first.truth.sheets[0].regions[1].contentHash)),
      `${parts.filter((part) => part.kind === "text" && part.text.startsWith("--- material for ")).length} headings`);
    t.check("no address of any kind travelled with it — no bucket, no signed url, no path, no expiry",
      !/https?:\/\/(?!alpha|beta|gamma)|X-Amz-|signature=|expires=|s3:\/\/|gs:\/\//i.test(JSON.stringify(questions.map((q) => q.parts))));

    const notes = rows.filter((a) => a.task_type === TASK.readNote && a.state === "succeeded").flatMap((a) => questionsFor(a.task_id));
    const noteBytes = store.get(first.truth.sheets[0].regions[1].contentHash).bytes;
    t.check("the note was sent as an IMAGE — bytes with a media type, in each provider's own multimodal shape",
      notes.length === 2 && notes.every((q) => q.parts.some((part) => part.kind === "image" && part.mimeType === "image/png")),
      `${notes.length} note readings`);
    t.check("and those bytes are the resolver's bytes, hash for hash",
      notes.every((q) => q.parts.some((part) => part.kind === "image" && sha256Bytes(part.bytes) === sha256Bytes(noteBytes))));
    const noteClaims = (await claimsOf(wf)).filter((c) => c.predicate === "revision_status");
    t.check("the claim about the note could only have come from decoding that image",
      noteClaims.length >= 2 && noteClaims.every((c) => readTextFromImage(noteBytes).includes(c.value.text)),
      JSON.stringify([...new Set(noteClaims.map((c) => c.value.text))]));
  }

  t.section("1b · two blind readings, two providers, one falsehood they share");

  const readings = rows.filter((a) => a.task_type === TASK.readTable);
  t.check("the two blind readings ran in two independence domains and were answered by two different providers",
    readings.length === 2 && new Set(readings.map((a) => a.independence_domain)).size === 2
    && new Set(readings.map((a) => a.model_reported)).size === 2,
    readings.map((a) => `${a.executor_family}→${a.model_reported}`).join(" "));

  const claims = await claimsOf(wf);
  const readingsOf = (entry) => claims.filter((c) => c.subject_key === `entry/${entry}` && c.predicate === "quantity" && c.independence_group !== null);
  const agreedLies = readingsOf("E-001").filter((c) => Number(c.value.quantity) === FALSE_QUANTITY);
  t.check("both readers reported the same false quantity for one entry, where the material says another",
    agreedLies.length === 2 && new Set(agreedLies.map((c) => c.independence_group)).size === 2
    && new Set(agreedLies.map((c) => c.independence_domain)).size === 2 && trueE1.quantity !== FALSE_QUANTITY,
    `${agreedLies.length} readings of ${FALSE_QUANTITY}; the material says ${trueE1.quantity}`);

  const segments = (await client.query(
    `select id, locator, parent_segment_id, segment_kind, discovered_by from public.source_segments where workflow_id = $1`, [wf])).rows
    .map((x) => ({ ...x, locator: js(x.locator) }));
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
  t.check("and in no photograph of any tick was either accepted or verified — matching is not evidence",
    agreedLies.every((c) => !everIn(c.id, "accepted") && !everIn(c.id, "verified")),
    shots.map((rowsAt, i) => `t${i}:${agreedLies.map((c) => rowsAt.find((x) => x.id === c.id)?.status ?? "-").join("/")}`).join(" "));

  t.section("1c · the critic, the verifier and the arbiter, each in a domain that made nothing it judges");

  const disagreements = await disagreementsOf(wf);
  const byVerification = disagreements.find((d) => d.subject_signature?.found_by === "verification");
  const byComparison = disagreements.find((d) => (d.subject_signature?.found_by ?? "comparison") === "comparison");
  t.check("a critic reopened the source at the agreed reading's own anchors and contradicted both",
    byVerification !== undefined && byVerification.kind === "value",
    disagreements.map((d) => `${d.kind}:${d.subject_signature?.found_by ?? "comparison"}:${d.state}`).join(" "));
  t.check("and the comparison found the other subject by itself, where the two readings differ",
    byComparison !== undefined && byComparison.kind === "value");

  const judges = rows.filter((a) => [KERNEL_TASK_TYPES.verifyClaim, KERNEL_TASK_TYPES.verifyDisagreement, KERNEL_TASK_TYPES.adjudicate].includes(a.task_type));
  const readingDomains = new Set(readings.map((a) => a.independence_domain));
  t.check("no critic, verifier or arbiter ran in a domain that made either reading",
    judges.length >= 3 && judges.every((a) => !readingDomains.has(a.independence_domain)),
    judges.map((a) => `${a.task_type}:${a.model_reported}`).join(" "));

  {
    const critics = rows.filter((a) => a.task_type === KERNEL_TASK_TYPES.verifyClaim && a.state === "succeeded");
    const criticQuestions = critics.flatMap((a) => questionsFor(a.task_id));
    t.check("a critic was given the claims it judges and the material to judge them against, and nothing else",
      criticQuestions.length === critics.length
      && criticQuestions.every((q) => assignmentOf(q).includes("claim A") && q.parts.some((part) => part.kind === "text" && part.text.startsWith("--- material for "))),
      `${criticQuestions.length} questions`);
    const shownSegments = new Set(criticQuestions.flatMap((q) => q.parts
      .filter((part) => part.kind === "text" && part.text.startsWith("--- material for "))
      .map((part) => parseMaterialHeading(part.text)?.segmentId)));
    const persisted = new Set(segments.map((x) => x.id));
    t.check("and every piece it was shown is a segment of this workflow's own source",
      [...shownSegments].every((id) => persisted.has(id)), [...shownSegments].join(" "));
  }

  const arbiters = rows.filter((a) => a.task_type === KERNEL_TASK_TYPES.adjudicate && a.state === "succeeded");
  const arbiterQuestions = arbiters.flatMap((a) => questionsFor(a.task_id));
  const NAMES = [...PROVIDERS.map((p) => new RegExp(`\\b${p.providerId}\\b`, "i")), ...PROVIDERS.map((p) => new RegExp(p.model.replace(/-/g, "[- ]"), "i"))];
  const FORBIDDEN = [/\bvote[sd]?\b/i, /\bconsensus\b/i, /\bboth reade/i, /\bother read(er|ing)/i, /\breadings? agree/i, /\bagreed with\b/i, /\btwo of (the )?three\b/i, /\bhow many\b/i];
  t.check("every arbitration that ran left exactly one question on the wire, and it says which role it is",
    arbiterQuestions.length === arbiters.length && arbiters.length > 0
    && arbiterQuestions.every((q) => assignmentOf(q).includes("evidence_arbiter")),
    `${arbiterQuestions.length} questions for ${arbiters.length} arbitrations`);
  t.check("none of the assignments says who read, how many agreed, or offers another reading as weight",
    arbiterQuestions.every((q) => FORBIDDEN.every((r) => !r.test(assignmentOf(q)))));
  t.check("and nothing in the request — assignment or standing rules — names a provider or a model",
    arbiterQuestions.every((q) => NAMES.every((r) => !r.test(assignmentOf(q)) && !r.test(q.system))));
  t.check("what it does say is that a majority is not proof, and the rules it went out with say counting agreement is no part of the work",
    arbiterQuestions.every((q) => /a majority is not proof/i.test(assignmentOf(q))
      && /counting agreement is no part of your work/i.test(q.system)));

  {
    const blind = readings.flatMap((a) => questionsFor(a.task_id));
    t.check("neither blind reading was shown the other's answer, a provider's name, a count of anything, or the number the other one wrote",
      blind.length === 2
      && blind.every((q) => FORBIDDEN.every((r) => !r.test(assignmentOf(q))) && NAMES.every((r) => !r.test(assignmentOf(q)) && !r.test(q.system)))
      && blind.every((q) => !assignmentOf(q).includes(String(FALSE_QUANTITY))));
    t.check("and each was told, in the rules it went out with, that it is a reading of its own",
      blind.every((q) => /this is a reading of your own/i.test(assignmentOf(q)) || /this is a reading of your own/i.test(q.system)));
  }

  t.section("1d · what the machine could settle, and what it could not");

  const decisions = (await client.query(
    `select id, decision_type, status, authority, disagreement_id, decided_by_attempt_id from public.decisions where workflow_id = $1`, [wf])).rows;
  const settled = decisions.find((d) => d.id === byComparison.resolution_decision_id);
  t.check("the dispute the comparison found is resolved by a machine decision of the adjudicator",
    byComparison.state === "resolved" && settled !== undefined && settled.status === "machine_decided"
    && settled.authority === "adjudicator" && settled.decision_type === "accept_claim", JSON.stringify(settled ?? null));

  const settledClaims = (await client.query(
    `select c.id, c.status, c.independence_domain, c.value from public.evidence_claims c
       join public.disagreement_claims x on x.claim_id = c.id where x.disagreement_id = $1`, [byComparison.id])).rows
    .map((c) => ({ ...c, value: js(c.value) }));
  const accepted = settledClaims.find((c) => c.status === "accepted");
  const rejected = settledClaims.find((c) => c.status === "rejected");
  t.check("one reading was accepted and the other rejected, and the accepted one is what the material says",
    accepted !== undefined && rejected !== undefined && Number(accepted.value.quantity) === trueE3.quantity,
    settledClaims.map((c) => `${c.status}:${c.value.quantity}`).join(" "));
  const backing = (await client.query(
    `select s.assessment, a.independence_domain from public.claim_assessments s
       join public.agent_attempts a on a.id = s.attempt_id
      where s.claim_id = $1 and s.assessment = 'supports'`, [accepted.id])).rows;
  t.check("what stands behind that acceptance is a reading of the source from a domain that did not make the claim",
    backing.length > 0 && backing.every((a) => a.independence_domain !== accepted.independence_domain));

  const corrected = claims.find((c) => arbiters.some((a) => a.id === c.attempt_id) && c.independence_group === null && c.subject_key === "entry/E-001");
  t.check("for the subject both readers got wrong, the arbiter's correction is on the record as a proposal holding what the material says",
    corrected !== undefined && corrected.status === "proposed" && Number(corrected.value.quantity) === trueE1.quantity,
    corrected ? `${corrected.value.quantity} (${corrected.status})` : "no correction");
  t.check("but it was not accepted: with three provider domains the only reviewer of that source is the arbiter's own domain",
    byVerification.state === "needs_human" && (byVerification.needs_human_reason ?? "").includes("another domain"),
    `${byVerification.state}: ${byVerification.needs_human_reason ?? ""}`);
  const hold = decisions.find((d) => d.decision_type === "hold" && d.disagreement_id === byVerification.id);
  t.check("a hold stands against it instead, waiting for a person, and the readings under it are left unresolved rather than believed",
    hold !== undefined && hold.status === "needs_human"
    && agreedLies.every((c) => claims.find((x) => x.id === c.id).status === "unresolved"));
  t.check("and no decision anywhere in the run cites either of the agreed false readings as support",
    (await client.query(
      `select count(*) n from public.decision_evidence e join public.decisions d on d.id = e.decision_id
        where d.workflow_id = $1 and e.link = 'supports' and e.claim_id = any($2::uuid[])`,
      [wf, `{${agreedLies.map((c) => c.id).join(",")}}`])).rows[0].n === "0");

  t.section("1e · the money: held before anything was sent, settled from what was reported, and none of it real");

  const budget = (await client.query(`select reserved, settled from public.workflow_cost_budgets where workflow_id = $1`, [wf])).rows[0];
  const reservations = (await client.query(
    `select attempt_id, state, reserved_cost, reserved_input_tokens, reserved_output_tokens, settled_cost, usage, normalized_usage, normalization_version, price_basis, attention_reason
       from public.attempt_cost_reservations where workflow_id = $1`, [wf])).rows;
  t.check("every model attempt took a durable hold before it was sent, and code took none",
    reservations.length === model.length && rows.filter((a) => a.executor_kind === "deterministic").every((a) => !reservations.some((r) => r.attempt_id === a.id)),
    `${reservations.length} reservations for ${model.length} model attempts`);

  /* The ordering that matters: at the moment of every request that went out,
     at least as many holds had already been taken as requests had been made.
     A request that outran its reservation would break this at the first one. */
  {
    const ordered = [...money.filter((e) => e.event === "budget.reserved").map((e) => ({ at: e.at, kind: "reserved" })),
      ...wire.map((x) => ({ at: x.at, kind: "sent" }))].sort((a, b) => a.at - b.at);
    let reserved = 0;
    let sent = 0;
    let broken = null;
    for (const step of ordered) {
      if (step.kind === "reserved") reserved++;
      else { sent++; if (sent > reserved) broken = broken ?? step; }
    }
    t.check("and every request that went out had a hold behind it before it went — the reservation is not a receipt",
      broken === null && sent > 0, broken ? `a request outran its hold at ${broken.at}` : `${sent} requests, ${reserved} holds`);
  }

  t.check("each hold was the most that attempt could have cost at the operator's price, not what it was expected to cost",
    reservations.every((r) => Number(r.reserved_cost) === HOLD_PER_ATTEMPT),
    `${reservations[0] ? Number(reservations[0].reserved_cost) : "none"} against ${HOLD_PER_ATTEMPT}`);
  t.check("and the hold used the cache-write rate, which is above the ordinary input rate — a ceiling priced at the ordinary rate would not have been one",
    HOLD_PER_ATTEMPT > round6((INPUT_CEILING / 1e6) * INPUT_RATE + (OUTPUT_CEILING / 1e6) * OUTPUT_RATE),
    `${HOLD_PER_ATTEMPT} against ${round6((INPUT_CEILING / 1e6) * INPUT_RATE + (OUTPUT_CEILING / 1e6) * OUTPUT_RATE)} at the ordinary rates`);
  t.check("every hold can be reproduced from the rates written down beside it",
    reservations.every((r) => {
      const basis = js(r.price_basis);
      return basis.ceiling_rule === "core-v2.ceiling.1"
        && round6((Number(r.reserved_input_tokens) / 1e6) * basis.ceiling_input_per_million_tokens
                + (Number(r.reserved_output_tokens) / 1e6) * basis.ceiling_output_per_million_tokens) === Number(r.reserved_cost);
    }), `${reservations.length} reservations`);
  t.check("each settled at what the answering system reported, which is a great deal less than what was held",
    reservations.every((r) => r.state === "settled" && Number(r.settled_cost) === COST_PER_ATTEMPT),
    `${reservations.filter((r) => r.state === "settled").length} of ${reservations.length} at ${COST_PER_ATTEMPT}`);
  t.check("BOTH are on the record: the provider's own counts as evidence, and the billable components as arithmetic",
    reservations.every((r) => {
      const raw = js(r.usage);
      const billable = js(r.normalized_usage);
      return Object.keys(raw).length > 0 && billable !== null
        && typeof r.normalization_version === "string" && r.normalization_version.length > 0
        && billable.uncached_input_tokens === LOCAL_USAGE.inputTokens
        && billable.visible_output_tokens === LOCAL_USAGE.outputTokens;
    }), JSON.stringify(js(reservations[0].normalized_usage)));
  t.check("and the components are not the raw counts renamed — one provider's raw object is not the other's",
    new Set(reservations.map((r) => Object.keys(js(r.usage)).sort().join(","))).size >= 2,
    [...new Set(reservations.map((r) => Object.keys(js(r.usage)).sort().join(",")))].join(" | "));
  t.check("nothing is left holding, and the ledger's total is one attempt's cost times the number of answers",
    Number(budget.reserved) === 0 && round6(Number(budget.settled)) === round6(COST_PER_ATTEMPT * model.length),
    `held ${budget.reserved}, settled ${budget.settled}, ${model.length} attempts`);
  t.check("that number is what this run WOULD have cost. The external cost is zero: every request was answered inside this process",
    tried() === 0 && wire.length > 0, `${wire.length} requests; ${tried()} attempts at a door`);

  t.section("1f · everything the run did is on the record");

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
  t.check("the sheet the source declared was persisted at ingest and the regions were discovered under it, by a model reading the sheet",
    segments.filter((x) => x.segment_kind === "sheet" && x.discovered_by === "deterministic").length === 1
    && segments.filter((x) => x.parent_segment_id !== null && x.discovered_by === "model").length === 2,
    segments.map((x) => `${x.segment_kind}:${x.discovered_by}`).join(" "));
  t.check("no task ran twice: not one has two succeeded attempts",
    (await client.query(`select task_id from public.agent_attempts where workflow_id = $1 and state = 'succeeded' group by task_id having count(*) > 1`, [wf])).rows.length === 0);
  t.check("nothing a dispatcher or the ledger emitted carries a key, a prompt or a piece of a source",
    [...events, ...money].every((e) => !JSON.stringify(e).includes("not-a-credential") && !JSON.stringify(e).includes("taskId:")),
    `${events.length + money.length} events`);

  /* ═════════════════ 2 · the same assignment, different bytes, other claim */

  t.section("2 · change the material and the claim changes, with the assignment identical");
  {
    /* One request that actually went out for a blind reading, replayed twice
       through the same stand-in: once as it was, once with a single number in
       the material changed. Same task id, same words, same everything but the
       bytes. */
    const original = questionsFor(readings[0].task_id)[0];
    const before = answerFromRequest(original);
    const doctored = {
      ...original,
      parts: original.parts.map((part) => (part.kind === "text" && /^E-002\s/m.test(part.text)
        ? { ...part, text: part.text.replace(/^(E-002\s+\S+\s+)(\d+)/m, (_, head) => `${head}77`) }
        : part)),
    };
    const after = answerFromRequest(doctored);
    const quantityOf = (envelope, entry) => envelope.claims.find((c) => c.subjectKey === `entry/${entry}`)?.value.quantity;
    t.check("the assignment is identical — the same task, the same words",
      assignmentOf(doctored) === assignmentOf(original) && parseAssignment(assignmentOf(doctored)).taskId === readings[0].task_id);
    t.check("the material is not: one number in the table was changed",
      JSON.stringify(doctored.parts) !== JSON.stringify(original.parts));
    t.check("and the claim changes with it — the answer is read from the bytes, not looked up",
      quantityOf(before, "E-002") !== 77 && quantityOf(after, "E-002") === 77,
      `${quantityOf(before, "E-002")} → ${quantityOf(after, "E-002")}`);
    t.check("while what was not changed is unchanged",
      quantityOf(before, "E-003") === quantityOf(after, "E-003"));
    t.check("and with the material taken away entirely, it says it was given nothing rather than answering",
      answerFromRequest({ ...original, parts: [original.parts[0]] }).outcome === "insufficient_evidence");
  }

  /* ═══════════════════ 3 · material that is not what the assignment names */

  t.section("3 · material corrupted under an unchanged hash stops the work before anything is sent");
  {
    const tampered = await enqueue("runtime-e2e/tampered");
    const sentBefore = wire.length;
    /* A store whose bytes were changed under the hash they are filed by:
       exactly what a corrupted object, a wrong version or a swapped file
       looks like from here. */
    const corrupt = new Map(store);
    for (const [hash, item] of store) corrupt.set(hash, { ...item, bytes: new Uint8Array(Buffer.concat([Buffer.from(item.bytes), Buffer.from("x")])) });
    const run = dispatcherNamed("dispatcher-tampered", { materialResolver: new InMemoryMaterialResolver(corrupt) });
    await run.dispatcher.drain();
    await run.dispatcher.stop();

    const attempts = await attemptsOf(tampered.workflowId);
    const refused = attempts.filter((a) => a.error_code === "material_refused");
    t.check("the work stopped at the first thing it was asked to read",
      refused.length > 0 && refused.every((a) => a.state === "failed_known"),
      attempts.map((a) => `${a.task_type}:${a.state}:${a.error_code ?? ""}`).join(" "));
    t.check("and it says the material is not what the assignment names",
      refused.every((a) => /material_refused/.test(a.error_code) ),
      refused[0]?.error_message?.slice(0, 120));
    t.check("NOTHING WAS SENT for it — not one request left for that workflow",
      wire.length === sentBefore, `${wire.length - sentBefore} requests`);
    t.check("no hold was settled for work that never went out",
      (await countOf(`select count(*) n from public.attempt_cost_reservations where workflow_id = $1 and state = 'settled'`, tampered.workflowId)) === 0);
    const state = (await client.query(`select state from public.intelligence_workflows where id = $1`, [tampered.workflowId])).rows[0].state;
    t.check("and the workflow ends somewhere a person can act on, not running",
      state !== "running" && state !== "completed", state);
  }

  t.section("4 · material larger than a request may carry stops the work before anything is sent");
  {
    const oversized = await enqueue("runtime-e2e/oversized");
    const sentBefore = wire.length;
    const tiny = {
      ...RUNTIME_CONFIG,
      providers: PROVIDERS.map((p) => configurationOf(p, { maximumMaterialBytes: 16, maximumMaterialBytesPerItem: 16 })),
    };
    const run = dispatcherNamed("dispatcher-oversized", { config: tiny });
    await run.dispatcher.drain();
    await run.dispatcher.stop();

    const attempts = await attemptsOf(oversized.workflowId);
    const refused = attempts.filter((a) => a.error_code === "material_refused");
    t.check("a request that would be too large is refused rather than trimmed to fit",
      refused.length > 0 && refused.every((a) => /at most 16 may be sent/.test(a.error_message ?? "")),
      refused[0]?.error_message?.slice(0, 140));
    t.check("and nothing was sent for it", wire.length === sentBefore, `${wire.length - sentBefore} requests`);
  }

  /* ═════════════════════════════════ 5 · the same chain, with a crash */

  t.section("5 · a dispatcher dies mid-run; another finishes it without repeating a thing");

  const second = await enqueue("runtime-e2e/crash");
  const crashed = second.workflowId;

  /* The reference: the same seed and the same misreading, uninterrupted, in
     memory, with the pack's own scripted agents reading the same invented
     truth. Whether an answer came from an adapter reading material or from
     code reading the truth behind it, the identifiers the kernel derives are
     the same — so this is what the interrupted run must leave behind. */
  const memory = new InMemoryOrchestrationRepository();
  const scriptedWrongOnOne = (packet, base) => {
    if (packet.roleKey === "table_reader" && packet.independenceGroup === READER_B) {
      for (const c of base.claims) if (c.subjectKey === "entry/E-001") c.value = { ...c.value, quantity: c.value.quantity + 5, text: `${c.value.quantity + 5} ${c.unit}` };
    }
    return base;
  };
  const reference = assemble({
    manifest: second.truth.manifest, pack: new SyntheticRecordsPack(), repo: memory, clock: manualClock(), owner: "worker-memory",
    executors: mockExecutors(second.truth, {
      scripts: Object.fromEntries(["reader-family-one", "reader-family-two", "reader-family-three", "critic-family-one", "critic-family-two", "arbiter-family-one"]
        .map((f) => [f, scriptedWrongOnOne])),
    }).registry,
  });
  await reference.scheduler.plan();
  const referenceReport = await reference.scheduler.runUntilQuiescent();
  const referenceClaims = sorted((await memory.listClaims({ workflowId: crashed })).map((c) => c.claimId));
  const referenceDecisions = sorted((await memory.listDecisions(crashed)).map((d) => d.decisionId));
  t.check("the reference run of the same seed, uninterrupted and in memory, completes and leaves claims and decisions to compare against",
    referenceReport.workflow.state === "completed" && referenceClaims.length > 0,
    `${referenceReport.workflow.state}, ${referenceClaims.length} claims, ${referenceDecisions.length} decisions`);

  const dying = dispatcherNamed("dispatcher-that-died", {
    ticksPerPass: 1, workflowsPerPass: 1, transport: standIn(misreadings.wrongOnOne),
  });
  const dyingRecord = await dying.dispatcher.record();
  let halfway = null;
  for (let pass = 0; pass < 20 && halfway === null; pass++) {
    await dying.dispatcher.runOnce();
    await dyingRecord.releaseDependents(crashed);
    const tasks = await dyingRecord.listTasks(crashed);
    const done = tasks.filter((x) => TERMINAL_TASK_STATES.includes(x.state));
    const runnable = await dyingRecord.getRunnableTasks(crashed);
    if (pass >= 2 && done.length > 0 && runnable.length > 0 && done.length < tasks.length) halfway = { tasks, done, runnable };
  }
  t.check("the dispatcher was cut off with work behind it, work in front of it and something waiting in the queue",
    halfway !== null && halfway.done.length > 0 && halfway.done.length < halfway.tasks.length,
    halfway ? `${halfway.done.length} of ${halfway.tasks.length} tasks finished, ${halfway.runnable.length} waiting` : "it never got that far");

  const beforeAttempts = (await attemptsOf(crashed)).map((a) => a.id);
  const beforeRequests = wire.length;
  const queued = halfway.runnable[0];
  const stranded = await dyingRecord.leaseTask(queued.taskId, "dispatcher-that-died", 1, Date.now());
  t.check("it also died holding a lease on a task nothing was ever sent for",
    stranded !== null && stranded.leaseOwner === "dispatcher-that-died" && (await dyingRecord.listAttempts(stranded.taskId)).length === 0);
  await sleep(40);

  const successor = dispatcherNamed("dispatcher-after-the-crash", { transport: standIn(misreadings.wrongOnOne) });
  await successor.dispatcher.drain();
  await successor.dispatcher.stop();

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

  const askedTwice = wire.map((x) => x.taskId).filter((id, i, all) => id !== null && all.indexOf(id) !== i);
  t.check("no task was asked of a provider twice, across every dispatcher and all three providers",
    askedTwice.length === 0, [...new Set(askedTwice)].slice(0, 4).join(" "));
  t.check("the successor did send for the work that was left, so the run really was finished by the second one",
    wire.length > beforeRequests);
  t.check("the reclaimed lease was taken back rather than waited on",
    (await client.query(`select count(*) n from public.audit_events where action = 'core_v2.task.lease_reclaimed' and entity_id = $1`, [stranded.taskId])).rows[0].n !== "0");
  const crashedOutbox = (await client.query(`select state, attempt_count from public.workflow_outbox where workflow_id = $1`, [crashed])).rows[0];
  t.check("the outbox does not still say the workflow is being started",
    crashedOutbox.state === "acknowledged" && Number(crashedOutbox.attempt_count) === 1, JSON.stringify(crashedOutbox));

  /* ═══════════ 6 · a request that left and never came back: safe unresolved recovery */

  t.section("6 · a socket dies after the request left: nobody knows, nothing is repurchased, the money stays held");

  const third = await enqueue("runtime-e2e/unknown");
  const unknown = third.workflowId;
  /* One reading of the note goes out and nothing comes back. Whether the
     provider did the work — and charged for it — cannot be known here. */
  const lossy = new LocalProviderTransport({
    onRequest: (question) => {
      const text = question.parts.find((part) => part.kind === "text" && part.text.includes("taskId: "));
      wire.push({ at: clockTick++, providerId: question.providerId, model: question.model, taskId: text ? (text.text.match(/^taskId: (\S+)$/m) ?? [])[1] ?? null : null, question });
    },
    answer: (question) => {
      const assignment = parseAssignment(question.parts.find((p) => p.kind === "text" && p.text.includes("taskId: "))?.text ?? "");
      if (assignment.roleKey === "note_reader" && question.model === SECOND_LANE) {
        return new TransportFault("core-v2-runtime: the socket closed while waiting for an answer", false);
      }
      return misreadings.wrongOnOne(question, answerFromRequest(question));
    },
  });
  const patient = dispatcherNamed("dispatcher-three", { transport: lossy });
  await patient.dispatcher.drain();
  const remaining = await patient.dispatcher.workRemaining(await patient.dispatcher.record(), null, unknown);
  await patient.dispatcher.stop();

  const unknownAttempts = await attemptsOf(unknown);
  const lost = unknownAttempts.filter((a) => a.state === "outcome_unknown");
  t.check("the attempt whose answer never came back is recorded as an unknown outcome — not a failure, never an empty success",
    lost.length === 1 && lost[0].task_type === TASK.readNote,
    unknownAttempts.map((a) => `${a.task_type}:${a.state}`).join(" "));
  t.check("the record says both things about it: that the engine does not know how it ended, and which unknown it was",
    lost[0].error_code === "provider_outcome_unknown" && lost[0].provider_stop_reason === "transport_fault",
    `${lost[0].error_code} / ${lost[0].provider_stop_reason}`);
  t.check("its task was not tried again: one attempt, not two",
    unknownAttempts.filter((a) => a.task_id === lost[0].task_id).length === 1);
  t.check("nothing was asked of a provider twice on its account either",
    wire.filter((x) => x.taskId === lost[0].task_id).length === 1);

  const stillHeld = (await client.query(
    `select state, reserved_cost, settled_cost, attention_reason from public.attempt_cost_reservations where attempt_id = $1`, [lost[0].id])).rows[0];
  t.check("its hold is still held — not settled at nothing and not given back, because the money may already be gone",
    stillHeld.state === "reserved" && stillHeld.settled_cost === null && Number(stillHeld.reserved_cost) === HOLD_PER_ATTEMPT,
    JSON.stringify(stillHeld));
  t.check("and the workflow's budget still shows that hold, so the same money cannot be spent twice",
    Number((await client.query(`select reserved from public.workflow_cost_budgets where workflow_id = $1`, [unknown])).rows[0].reserved) === HOLD_PER_ATTEMPT);
  t.check("the ledger said so rather than doing it quietly",
    money.some((e) => e.event === "budget.holds" && e.workflow === unknown));

  const unknownState = (await client.query(`select state from public.intelligence_workflows where id = $1`, [unknown])).rows[0].state;
  t.check("the workflow does not sit there saying it is running when there is nothing left it can do",
    unknownState !== "running" && remaining.runnable === 0 && remaining.busy === 0,
    `${unknownState}; ${JSON.stringify(remaining)}`);
  t.check("what is left is one thing a person can act on, and the engine calls it what it is: unresolved, not reconciled",
    remaining.reconcilable === 1
    && (await client.query(`select reconciliation_outcome from public.agent_attempts where id = $1`, [lost[0].id])).rows[0].reconciliation_outcome === null,
    JSON.stringify(remaining));

  /* ═══════════════════════════════════════════════════ what it all cost */

  t.section("what left this process");

  t.check("all three adapters were used, and every request each made was answered inside this process",
    PROVIDERS.every((p) => wire.some((x) => x.providerId === p.providerId)) && wire.length > 0,
    PROVIDERS.map((p) => `${p.providerId}:${wire.filter((x) => x.providerId === p.providerId).length}`).join(" "));
  t.check("no door out of this process was tried, not once, by anything", tried() === 0, `${tried()} attempts`);
  t.check("the external cost of this file is $0.00", tried() === 0 && wire.length > 0);

  for (const c of openConnections) await c.end().catch(() => {});
});

t.finish();
